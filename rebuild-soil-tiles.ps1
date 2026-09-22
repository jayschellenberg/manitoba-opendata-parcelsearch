# rebuild-soil-tiles.ps1 -- rebuild the Manitoba Soil Survey vector-tile
# archive straight from the province's FeatureServer.
#
# WHY TILES
# ---------
# The soil overlay paints across whole municipalities, so it has always had to
# FETCH whole municipalities: Macdonald and its five neighbours is 4,693
# polygons / ~1.58M vertices / ~52 MB, which is what ran a 1,141-sale session
# out of memory (Jason, 2026-09-22). Scoping the fetch to the visible rows and
# simplifying its geometry cut that a long way. Tiles remove it: one
# province-wide archive, range-requested, no per-municipality fetch and no
# scope logic at all.
#
# DISPLAY ONLY, and this is the line that matters. Nothing measured comes from
# these tiles. Parcel soil composition is joined against
# fetchSoilSurveyForParcels (full survey resolution, scoped to the parcels) or
# read from the pre-baked soilfacts shards. These tiles are simplified twice
# over -- once at export, once per zoom by tippecanoe -- and a percentage
# quoted in an appraisal must never come from them.
#
# Behaviour, following rebuild-parcel-tiles.ps1:
#   * Two steps: web/scripts/export-soil-geojson.js (pages the FeatureServer
#     with retry -- see its header for why ogr2ogr, which is faster and
#     already installed, could not be used), then tippecanoe via WSL.
#   * Refuses to promote an archive outside the sanity band, or one built from
#     a short read. A truncated download must not become the province's soil.
#   * Does NOT upload. Publishing needs credentials this script should not
#     hold, and an archive that fails review should not auto-publish -- same
#     reasoning as the parcel tiles. Pass -Publish once you have looked at it.
#
# Prerequisites: Node, and WSL with tippecanoe.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File rebuild-soil-tiles.ps1
#   powershell -ExecutionPolicy Bypass -File rebuild-soil-tiles.ps1 -SkipExport
#   powershell ... -File rebuild-soil-tiles.ps1 -SkipExport -SkipTile -Publish
#       ^ publish an archive already built and reviewed, without re-tiling
#
# Exit codes: 0 clean, 1 a step failed.

[CmdletBinding()]
param(
    # Reuse the existing build-cache/soil-tiles/soil.geojsonl instead of
    # re-downloading. Useful when iterating on tile flags against unchanged
    # source data.
    [switch]$SkipExport,

    # Skip tippecanoe and use the archive already in build-cache. This is the
    # publish-after-review path: the whole point of not auto-publishing is
    # that someone looks at the archive first, and without this that review
    # cost a second 20-minute tiling run to act on.
    [switch]$SkipTile,

    # Upload the finished archive to R2. Deliberately opt-in.
    [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$cacheDir  = Join-Path $root 'build-cache\soil-tiles'
$seqPath   = Join-Path $cacheDir 'soil.geojsonl'
$outPath   = Join-Path $cacheDir 'soil.pmtiles'

# The out-fields and the generalisation tolerance live in
# web/scripts/export-soil-geojson.js, not here. They were duplicated in both
# for a while, which is how the two quietly stop agreeing about what a tile
# contains.

$EXPECTED_FEATURES = 116767   # province-wide polygon count as of 2026-09-22
$SHORT_READ_FLOOR  = 0.95     # anything under this is a truncated download
$PMTILES_MIN_MB    = 8
$PMTILES_MAX_MB    = 400

New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

if (-not $SkipExport) {
    Write-Host "Exporting the soil survey..."
    if (Test-Path $seqPath) { Remove-Item $seqPath -Force }
    Push-Location (Join-Path $root 'web')
    try {
        & node scripts/export-soil-geojson.js $seqPath
        if ($LASTEXITCODE -ne 0) { Write-Error "export exited $LASTEXITCODE"; exit 1 }
    } finally { Pop-Location }
}

if (-not (Test-Path $seqPath)) { Write-Error "No $seqPath -- run without -SkipExport."; exit 1 }

$count = (Get-Content $seqPath -ReadCount 1000 | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
$sizeMb = (Get-Item $seqPath).Length / 1MB
Write-Host ("  {0:N0} features, {1:N1} MB" -f $count, $sizeMb)

# A short read must not become the province's soil layer. Silent partial
# coverage is the worst outcome here: the overlay would simply look like the
# survey stops somewhere, with nothing on screen to say otherwise.
if ($count -lt ($EXPECTED_FEATURES * $SHORT_READ_FLOOR)) {
    Write-Error ("Only {0:N0} of about {1:N0} features exported. Refusing to tile a short layer." -f $count, $EXPECTED_FEATURES)
    exit 1
}

# Flags mirror build-parcel-tiles.js, which settled them against a live
# overlay. The floor is the important one and the reasoning carries over
# unchanged: it has to reach the zoom the CAMERA lands on, not the zoom at
# which a polygon stops being sub-pixel. 93 of 154 municipalities fit below
# z11, down to z8.5 -- a higher floor leaves the layer blank at exactly the
# extent most municipalities open at, which is how the parcel layer shipped
# broken twice.
#
# Soil differs from parcels in one way: z14 rather than z16 at the top. A soil
# map unit is hundreds of metres across and the export already generalised to
# ~5 m, so there is nothing past z14 to keep; MapLibre overzooms from there.
# It also matches the maxzoom the GeoJSON source uses, so the tiled and
# untiled paths draw the same detail.
if (-not $SkipTile) {
$wslSeq = (& wsl wslpath -a ($seqPath -replace '\\','/')).Trim()
$wslOut = (& wsl wslpath -a ($outPath -replace '\\','/')).Trim()

Write-Host "Running tippecanoe via WSL..."
& wsl tippecanoe `
    -o $wslOut `
    --layer=soil `
    --minimum-zoom=8 --maximum-zoom=14 `
    --simplification=2 --full-detail=14 `
    --no-feature-limit --drop-densest-as-needed `
    --force `
    $wslSeq
if ($LASTEXITCODE -ne 0) { Write-Error "tippecanoe exited $LASTEXITCODE"; exit 1 }
}

if (-not (Test-Path $outPath)) { Write-Error 'tippecanoe produced no archive.'; exit 1 }

# Check the FORMAT, not just that a file appeared.
#
# tippecanoe builds an SQLite/MBTiles file first and converts it to PMTiles as
# a final pass, via a sibling .tmp. So for most of a long run there IS a file
# at this path with a plausible size and the wrong contents — mid-build it
# reads "SQLite format 3", and a run interrupted there would leave one behind
# permanently. MapLibre's pmtiles protocol would simply fail to read it, and
# the overlay would be silently blank; nothing about the file size says so.
# Caught building this: a 192 MB SQLite intermediate sitting at soil.pmtiles
# while the real archive was still being written beside it.
# Read the 7 magic bytes through .NET rather than Get-Content: -AsByteStream
# is PowerShell 6+, and these scripts are launched with `powershell` (5.1),
# where the switch does not exist and the whole check would die with a
# parameter-binding error instead of validating anything. A FileStream also
# avoids pulling 150 MB through the pipeline to look at seven bytes.
$magic = & {
    $fs = [System.IO.File]::OpenRead($outPath)
    try {
        $buf = New-Object byte[] 7
        $null = $fs.Read($buf, 0, 7)
        [System.Text.Encoding]::ASCII.GetString($buf)
    } finally { $fs.Dispose() }
}
if ($magic -ne 'PMTiles') {
    Write-Error ("Archive is not PMTiles (starts with '{0}'). tippecanoe was probably still converting, or was interrupted mid-run. Re-run; do not publish this." -f $magic)
    exit 1
}
if (Test-Path "$outPath.tmp") {
    Write-Error 'A .tmp sibling is still present, so tippecanoe has not finished converting. Re-run.'
    exit 1
}

$outMb = (Get-Item $outPath).Length / 1MB
Write-Host ("`nArchive: {0:N1} MB  {1}" -f $outMb, $outPath)

# A truncated tippecanoe run also leaves a file behind, so size is checked
# before anything is published rather than after.
if ($outMb -lt $PMTILES_MIN_MB -or $outMb -gt $PMTILES_MAX_MB) {
    Write-Error ("Archive is {0:N1} MB, outside the {1}-{2} MB sanity band. Not publishing. Inspect it, then widen the band deliberately if the growth is real." -f $outMb, $PMTILES_MIN_MB, $PMTILES_MAX_MB)
    exit 1
}

if ($Publish) {
    # Staged publish, same shape as rebuild-basemap.ps1 Step 7. The live
    # object is what the app reads on every load, so it is never the thing
    # being written to: upload to a staging key, verify the byte count
    # server-side, then do a server-side rename. A failed or truncated upload
    # leaves production serving the previous archive rather than half of this
    # one.
    #
    # --s3-no-check-bucket is required, not an optimisation. The R2 token is
    # scoped to this bucket, so rclone's default "does the bucket exist?"
    # probe is a CreateBucket call that comes back 403 AccessDenied and fails
    # the upload before it starts. The chunk size and concurrency are the
    # basemap script's, settled against a much larger archive than this one.
    $live    = 'r2-mb:mb-ortho/soil.pmtiles'
    $staging = 'r2-mb:mb-ortho/soil.pmtiles.staging'
    $bytes   = (Get-Item $outPath).Length

    # $ErrorActionPreference is 'Stop' for this script, and under Stop
    # PowerShell 5.1 turns ANY stderr line from a native command into a
    # terminating error. rclone writes notices and progress to stderr, so a
    # bare `& rclone ... 2>&1` here would throw on a perfectly ordinary run
    # instead of returning null for the caller to handle. Drop the preference
    # around the capture and put it back — the idiom wrapperLogging.test.js
    # enforces across every wrapper in this repo.
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
    & rclone copyto $outPath $staging --s3-no-check-bucket --s3-chunk-size 64M `
        --s3-upload-concurrency 8 --stats-one-line --stats 30s
    if ($LASTEXITCODE -ne 0) { Write-Error "rclone upload exited $LASTEXITCODE; live object untouched."; exit 1 }

    $stSize = Get-RemoteSize $staging
    if ($stSize -ne $bytes) {
        Write-Error "Staging size mismatch: local $bytes, staging $stSize. Live object untouched."
        exit 1
    }
    Write-Host "Staging verified ($stSize bytes); swapping into $live"
    & rclone moveto $staging $live --s3-no-check-bucket
    if ($LASTEXITCODE -ne 0) { Write-Error "Server-side rename exited $LASTEXITCODE."; exit 1 }

    $liveSize = Get-RemoteSize $live
    if ($liveSize -ne $bytes) {
        Write-Error "Live size $liveSize does not match the build ($bytes). Re-run -Publish."
        exit 1
    }
    Write-Host ("Published: {0} bytes live at {1}" -f $liveSize, $live)
    Write-Host 'Public: https://pub-091058079bf6458da1681945177e1682.r2.dev/soil.pmtiles'
} else {
    Write-Host "`nNot published. Review it, then re-run with -Publish (or:"
    Write-Host "  rclone copyto `"$outPath`" r2-mb:mb-ortho/soil.pmtiles --progress )"
}
