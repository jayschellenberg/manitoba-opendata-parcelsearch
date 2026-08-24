# rebuild-parcel-tiles.ps1 -- rebuild the Assessment Parcels vector-tile
# archive from the newest RollEntry_YYYYMMDD.gpkg.
#
# Context: the Assessment Parcels overlay renders from a province-wide PMTiles
# archive rather than fetching a municipality's parcels as GeoJSON. The archive
# is built from the same gpkg as the RollEntry fallback snapshot
# (r/build_rollentry_snapshot.R, monthly-refresh.bat step 6), so the two go
# stale together and should be rebuilt together. See MAINTENANCE.md 1e.
#
# Why this is NOT a step in monthly-refresh.bat: tippecanoe takes roughly an
# hour on 438k parcels. Folding that into the monthly refresh would turn a
# minutes-long job into an hour-long one and make a tiling failure look like a
# shard failure. Winnipeg's sister tool split it for the same reason.
#
# Behaviour:
#   * Two steps: r/export_rollentry_geojson.R (GDAL vectortranslate, ~12s) then
#     web/scripts/build-parcel-tiles.js --run (stream + derive + tippecanoe).
#   * The Node step will not promote an archive outside its 40-400 MB sanity
#     band and aborts on a short read, so a truncated run cannot become the
#     province's parcel fabric. This wrapper just surfaces that.
#   * Alerts (email + ntfy via alert-lib.ps1) on hard failure only.
#   * Leaves the finished archive in web/public/parcels.pmtiles. Uploading it
#     to object storage is deliberately NOT automated here -- that needs
#     credentials this script should not hold, and an archive that fails
#     review should not auto-publish. See MAINTENANCE.md 1e.
#
# Prerequisites: R with sf, Node, and WSL with tippecanoe
# (wsl --install; sudo apt install tippecanoe).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File rebuild-parcel-tiles.ps1
#   powershell -ExecutionPolicy Bypass -File rebuild-parcel-tiles.ps1 -SkipExport
#   powershell -ExecutionPolicy Bypass -File rebuild-parcel-tiles.ps1 -IfStale -Publish
#
# Exit codes: 0 clean (including "skipped, already current"), 1 a step failed
# (alert sent).

[CmdletBinding()]
param(
    # Reuse an existing tiles-build/rollentry.geojsons instead of re-exporting.
    # Useful when iterating on tile flags against an unchanged gpkg.
    [switch]$SkipExport,

    # Do nothing when the archive was already built from the newest
    # RollEntry_*.gpkg. This is what makes a monthly schedule cheap: the gpkg
    # only actually changes when r/download_parcels.R drops a new one, and
    # re-tiling identical data costs an hour of CPU for no change at all.
    [switch]$IfStale,

    # Upload the finished archive to R2 (see MAINTENANCE.md 1e). Credentials
    # come from rclone's own config, never from this repo.
    #
    # Publishing is opt-in rather than the default because it is the step that
    # makes a build visible to everyone. Unattended runs DO pass it -- an
    # archive rebuilt and left on disk keeps production serving the previous
    # one, which is the staleness this schedule exists to prevent. The
    # sanity band and the reconcile guard in build-parcel-tiles.js are what
    # stand in for a human look.
    [switch]$Publish
)

# Where the published archive lives. The object name is stable, so a rebuild
# overwrites in place and VITE_PARCEL_TILES_URL never changes.
$R2Remote = 'r2-mb:mb-ortho/mb-assessment-parcels.pmtiles'

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir ("parcel-tiles-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Output $line
    Add-Content -Path $log -Value $line
}

function Fail([string]$what, [string]$detail) {
    Write-Log "FAILED: $what"
    Write-Log $detail
    try {
        Send-FailureAlert $root 'mbps-parcel-tiles' `
            "Assessment Parcels tile rebuild failed" `
            "$what`n`n$detail`n`nLog: $log"
    } catch {
        Write-Log "(alert delivery also failed: $($_.Exception.Message))"
    }
    exit 1
}

$started = Get-Date
Write-Log "Assessment Parcels tile rebuild starting"
Write-Log "Log: $log"

# --- Step 0: is there anything to do? ------------------------------------
# Compares the newest RollEntry_*.gpkg against the source recorded in the
# published archive's meta sidecar. Same file -> the tiles already describe
# it and an hour of tippecanoe would produce the same bytes.
$newestGpkg = Get-ChildItem -Path $root -Filter 'RollEntry_*.gpkg' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $newestGpkg) {
    Fail "no RollEntry_*.gpkg in $root" `
         "r/download_parcels.R drops it (the mao-assembly monthly wrapper runs that). Nothing to tile."
}
$metaPath = Join-Path $root 'web\public\parcels-pmtiles-meta.json'
$builtFrom = $null
if (Test-Path $metaPath) {
    try { $builtFrom = (Get-Content $metaPath -Raw | ConvertFrom-Json).source_file } catch { $builtFrom = $null }
}
Write-Log "Newest gpkg : $($newestGpkg.Name)"
Write-Log "Archive from: $(if ($builtFrom) { $builtFrom } else { '(no meta sidecar -- never built here)' })"
if ($IfStale -and $builtFrom -and $builtFrom -eq $newestGpkg.Name) {
    Write-Log "Already current -- nothing to rebuild. Exiting 0."
    exit 0
}

# --- Step 1: gpkg -> newline-delimited GeoJSON ---------------------------
if ($SkipExport) {
    Write-Log "Step 1 SKIPPED (-SkipExport); reusing tiles-build/rollentry.geojsons"
} else {
    Write-Log "Step 1: export RollEntry to newline-delimited GeoJSON"
    $out = & Rscript (Join-Path $root 'r\export_rollentry_geojson.R') 2>&1
    $out | ForEach-Object { Write-Log "  $_" }
    if ($LASTEXITCODE -ne 0) { Fail "r/export_rollentry_geojson.R exited $LASTEXITCODE" ($out -join "`n") }
}

# --- Step 2: derive, tile, promote ---------------------------------------
# ~1 hour, nearly all of it tippecanoe.
Write-Log "Step 2: derive fields, run tippecanoe, promote"
Push-Location (Join-Path $root 'web')
try {
    $out = & node 'scripts/build-parcel-tiles.js' '--run' 2>&1
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
# Tippecanoe's progress is a carriage-return redraw; keep the log readable by
# dropping the percentage spam and keeping the summary lines the script prints.
$out | Where-Object { $_ -notmatch '^\s*(Reordering|Reading|Merging|\d+%)' } |
    ForEach-Object { Write-Log "  $_" }
if ($code -ne 0) { Fail "build-parcel-tiles.js exited $code" ($out | Select-Object -Last 20 | Out-String) }

$archive = Join-Path $root 'web\public\parcels.pmtiles'
if (-not (Test-Path $archive)) {
    Fail "tippecanoe reported success but no archive was promoted" `
         "Expected: $archive`nThe sanity band or the reconcile guard most likely rejected it -- see the log above."
}

$sizeMb = [math]::Round((Get-Item $archive).Length / 1MB, 1)
$mins = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
Write-Log "Archive: $archive ($sizeMb MB) in $mins min"

if (-not $Publish) {
    Write-Log ""
    Write-Log "NEXT: publish it, then confirm VITE_PARCEL_TILES_URL points at it:"
    Write-Log "      rclone copyto `"$archive`" `"$R2Remote`" --s3-no-check-bucket --progress"
    Write-Log "      (or re-run this with -Publish). See MAINTENANCE.md 1e."
    Write-Log "DONE"
    exit 0
}

# --- Step 3: publish -----------------------------------------------------
Write-Log "Publishing to $R2Remote ..."
$rcloneOut = & rclone copyto $archive $R2Remote --s3-no-check-bucket --stats-one-line --stats 60s 2>&1
$rcloneCode = $LASTEXITCODE
$rcloneOut | ForEach-Object { Write-Log "  $_" }
if ($rcloneCode -ne 0) {
    Fail "rclone upload exited $rcloneCode" `
         "The archive is built and promoted at $archive; only the upload failed, so production is still serving the PREVIOUS archive. Re-run with -Publish once the cause is cleared.`n`n$($rcloneOut | Out-String)"
}

# Verify the object rather than trusting the exit code: a partial upload that
# reported success would leave a corrupt archive serving every user.
$localBytes = (Get-Item $archive).Length
$remoteJson = & rclone lsjson $R2Remote 2>&1
$remoteBytes = $null
try { $remoteBytes = ([string]::Join('', $remoteJson) | ConvertFrom-Json)[0].Size } catch { $remoteBytes = $null }
if ($remoteBytes -ne $localBytes) {
    Fail "published archive size does not match the local build" `
         "local $localBytes bytes, remote $remoteBytes bytes. Production may be serving a truncated archive -- re-upload before trusting it."
}
Write-Log "Published: $remoteBytes bytes, matches the local build."
Write-Log "DONE"
exit 0
