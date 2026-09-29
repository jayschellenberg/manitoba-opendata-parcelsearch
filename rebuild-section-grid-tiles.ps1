# rebuild-section-grid-tiles.ps1 -- build the province-wide Section/township
# grid vector-tile archive from web/public/data/section-grid.json.
#
# WHY TILES
# ---------
# With no municipality selected, the Section/township grid toggle used to pull
# the whole 40 MB / 215k-section GeoJSON through the api/section-grid edge
# function and parse it on the main thread to draw one overview. The grid is
# display only -- nothing searches or joins against it -- so it now renders
# from this archive on R2, range-requested like the parcel and soil tiles.
# The per-municipality grid (and quarter mode) is unchanged: it still comes
# from the live MB_LegalDesc service, scoped to the muni boundary.
#
# Section geometry is fixed by federal survey, so this is a rare, manual
# rebuild -- not scheduled. Run it only after r/build_section_grid.R changes.
#
# Behaviour, following rebuild-soil-tiles.ps1:
#   * Two steps: web/scripts/build-section-grid-tiles.js (split into the
#     `sections` polygon and `section-labels` point layers), then tippecanoe
#     via WSL (~2 min).
#   * Refuses to promote a short read, a non-PMTiles file, or an archive
#     outside the sanity band.
#   * Does NOT upload unless -Publish is passed. Look at it first.
#
# Prerequisites: Node, WSL with tippecanoe, and web/public/data/section-grid.json
# (Rscript r/build_section_grid.R writes it).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File rebuild-section-grid-tiles.ps1
#   powershell ... -File rebuild-section-grid-tiles.ps1 -SkipTile -Publish
#       ^ publish an archive already built and reviewed, without re-tiling
#
# Exit codes: 0 clean, 1 a step failed.

[CmdletBinding()]
param(
    # Skip the split + tippecanoe and use the archive already in build-cache.
    [switch]$SkipTile,

    # Upload the finished archive to R2. Deliberately opt-in.
    [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcPath  = Join-Path $root 'web\public\data\section-grid.json'
$cacheDir = Join-Path $root 'build-cache\section-grid-tiles'
$outPath  = Join-Path $cacheDir 'section-grid.pmtiles'

$EXPECTED_FEATURES = 215445   # sections in the 2026-05-06 build
$SHORT_READ_FLOOR  = 0.98     # the grid doesn't shrink; anything under is a bad build
$PMTILES_MIN_MB    = 20       # 35.8 MB at z8-z12 on 2026-09-29
$PMTILES_MAX_MB    = 80

New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

if (-not $SkipTile) {
    if (-not (Test-Path $srcPath)) {
        Write-Error "No $srcPath -- run 'Rscript r/build_section_grid.R' first."
        exit 1
    }
    Push-Location (Join-Path $root 'web')
    try {
        & node scripts/build-section-grid-tiles.js $srcPath $cacheDir
        if ($LASTEXITCODE -ne 0) { Write-Error "split exited $LASTEXITCODE"; exit 1 }
    } finally { Pop-Location }

    $count = (Get-Content (Join-Path $cacheDir 'meta.json') -Raw | ConvertFrom-Json).features
    if ($count -lt ($EXPECTED_FEATURES * $SHORT_READ_FLOOR)) {
        Write-Error ("Only {0:N0} of about {1:N0} sections. Refusing to tile a short grid." -f $count, $EXPECTED_FEATURES)
        exit 1
    }

    # Floor z8, same as the parcel and soil archives and the line layer's own
    # width ramp; below that a 1.6 km section is under 2 px and the grid is a
    # grey smear. Top z12: the source is rounded to ~10 m and a z12 tile
    # already resolves ~1.3 m, so z13 added 37 MB and 6 minutes of tiling for
    # nothing -- MapLibre overzooms from z12. No feature or size limit, and no
    # tiny-polygon reduction: dropping sections would punch holes in a grid,
    # and the largest tile (z8) is ~60 KB anyway.
    $wslDir = (& wsl wslpath -a ($cacheDir -replace '\\','/')).Trim()
    Write-Host "Running tippecanoe via WSL..."
    & wsl tippecanoe `
        -o "$wslDir/section-grid.pmtiles" `
        -L "sections:$wslDir/sections.geojsonl" `
        -L "section-labels:$wslDir/section-labels.geojsonl" `
        --minimum-zoom=8 --maximum-zoom=12 `
        --no-feature-limit --no-tile-size-limit --no-tiny-polygon-reduction `
        --force --quiet
    if ($LASTEXITCODE -ne 0) { Write-Error "tippecanoe exited $LASTEXITCODE"; exit 1 }
}

if (-not (Test-Path $outPath)) { Write-Error 'No archive -- run without -SkipTile.'; exit 1 }

# Check the format, not just that a file appeared: tippecanoe writes an
# SQLite intermediate at this path before converting (rebuild-soil-tiles.ps1
# has the full story). .NET read because `powershell` 5.1 has no -AsByteStream.
$magic = & {
    $fs = [System.IO.File]::OpenRead($outPath)
    try {
        $buf = New-Object byte[] 7
        $null = $fs.Read($buf, 0, 7)
        [System.Text.Encoding]::ASCII.GetString($buf)
    } finally { $fs.Dispose() }
}
if ($magic -ne 'PMTiles') {
    Write-Error ("Archive is not PMTiles (starts with '{0}'). Re-run; do not publish this." -f $magic)
    exit 1
}
if (Test-Path "$outPath.tmp") {
    Write-Error 'A .tmp sibling is still present, so tippecanoe has not finished converting. Re-run.'
    exit 1
}

$outMb = (Get-Item $outPath).Length / 1MB
Write-Host ("`nArchive: {0:N1} MB  {1}" -f $outMb, $outPath)
if ($outMb -lt $PMTILES_MIN_MB -or $outMb -gt $PMTILES_MAX_MB) {
    Write-Error ("Archive is {0:N1} MB, outside the {1}-{2} MB sanity band. Not publishing." -f $outMb, $PMTILES_MIN_MB, $PMTILES_MAX_MB)
    exit 1
}

if ($Publish) {
    # Staged publish, same shape as rebuild-soil-tiles.ps1: upload to a
    # staging key, verify the size server-side, then rename over the live
    # object, so a failed upload leaves the previous archive serving.
    # --s3-no-check-bucket: the token is bucket-scoped, so rclone's bucket
    # probe would 403 before the upload starts.
    $live    = 'r2-mb:mb-ortho/section-grid.pmtiles'
    $staging = 'r2-mb:mb-ortho/section-grid.pmtiles.staging'
    $bytes   = (Get-Item $outPath).Length

    # Under $ErrorActionPreference='Stop', PowerShell 5.1 turns rclone's
    # ordinary stderr notices into terminating errors; relax it around the
    # capture (the idiom wrapperLogging.test.js enforces).
    function Get-RemoteSize([string]$obj) {
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $j = & rclone lsjson $obj 2>&1
        } finally { $ErrorActionPreference = $prevEAP }
        if ($LASTEXITCODE -ne 0) { return $null }
        try { return ([string]::Join('', $j) | ConvertFrom-Json)[0].Size } catch { return $null }
    }

    Write-Host "Uploading to $staging ..."
    & rclone copyto $outPath $staging --s3-no-check-bucket --stats-one-line --stats 30s
    if ($LASTEXITCODE -ne 0) { Write-Error "rclone upload exited $LASTEXITCODE; live object untouched."; exit 1 }

    $stSize = Get-RemoteSize $staging
    if ($stSize -ne $bytes) {
        Write-Error "Staging size mismatch: local $bytes, staging $stSize. Live object untouched."
        exit 1
    }
    & rclone moveto $staging $live --s3-no-check-bucket
    if ($LASTEXITCODE -ne 0) { Write-Error "Server-side rename exited $LASTEXITCODE."; exit 1 }

    $liveSize = Get-RemoteSize $live
    if ($liveSize -ne $bytes) {
        Write-Error "Live size $liveSize does not match the build ($bytes). Re-run -Publish."
        exit 1
    }
    Write-Host ("Published: {0} bytes live at {1}" -f $liveSize, $live)
    Write-Host 'Public: https://pub-091058079bf6458da1681945177e1682.r2.dev/section-grid.pmtiles'
} else {
    Write-Host "`nNot published. Review it, then re-run with -SkipTile -Publish."
}
