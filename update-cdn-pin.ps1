# update-cdn-pin.ps1 — publish the local mb-parcel-data clone and
# repoint the app's pinned CDN SHA in one shot.
#
# After an R build script rewrites shards into the local
# mb-parcel-data clone (mb_parcel_data_root in r/config.R), the
# remaining friction is:
#   1. cd ../mb-parcel-data && git commit -m "..." && git push
#   2. grab the new HEAD SHA
#   3. paste it into MB_PARCEL_DATA_CDN in web/src/arcgis.js
#   4. cd back, commit + push the app
#
# This script does steps 1-3 (4 is left to the user so they can review
# `git diff` first). Mirrors what release-indexes.ps1 does for the
# legal/assessment indexes, but for the parallel mb-parcel-data flow.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File update-cdn-pin.ps1
#   powershell ... -File update-cdn-pin.ps1 -DryRun       # show, change nothing
#   powershell ... -File update-cdn-pin.ps1 -Message "..." # custom commit message

param(
  [string]$Message = ("Refresh generated data shards {0}" -f (Get-Date -Format 'yyyy-MM-dd')),
  [string]$DataRepo,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$arcgisPath = Join-Path $root 'web\src\arcgis.js'
if (-not (Test-Path $arcgisPath)) { throw "Cannot find $arcgisPath" }

# Resolve the mb-parcel-data clone. Default mirrors r/config.R's
# mb_parcel_data_root default; -DataRepo overrides for a non-standard
# layout. Env var MB_PARCEL_DATA_ROOT (used by the R scripts) wins so
# the two stay in lockstep.
if (-not $DataRepo) {
  $DataRepo = if ($env:MB_PARCEL_DATA_ROOT) { $env:MB_PARCEL_DATA_ROOT } `
              else { 'D:\Dropbox\ClaudeCode\MBOpenData\mb-parcel-data' }
}
if (-not (Test-Path $DataRepo)) { throw "mb-parcel-data clone not found at $DataRepo (override with -DataRepo)" }
if (-not (Test-Path (Join-Path $DataRepo '.git'))) { throw "$DataRepo is not a git repo" }

Push-Location $DataRepo
try {
  Write-Host "Checking $DataRepo for changes ..."
  $dirty = & git status --porcelain
  if (-not $dirty) {
    $headSha = (& git rev-parse HEAD).Trim()
    Write-Host "Nothing to commit. Using current HEAD $headSha for the pin update."
  } elseif ($DryRun) {
    Write-Host "[dry-run] would commit + push these changes:"
    Write-Host (($dirty | Select-Object -First 10) -join "`n")
    if (($dirty | Measure-Object).Count -gt 10) { Write-Host "  ... and more" }
    $headSha = '<new-sha-after-push>'
  } else {
    & git add -A
    if ($LASTEXITCODE -ne 0) { throw 'git add failed' }
    & git commit -m $Message
    if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
    Write-Host 'Pushing to origin ...'
    & git push origin HEAD
    if ($LASTEXITCODE -ne 0) { throw 'git push failed' }
    $headSha = (& git rev-parse HEAD).Trim()
    Write-Host "New HEAD: $headSha"
  }
}
finally {
  Pop-Location
}

# Rewrite the pinned SHA in arcgis.js. The constant is one of:
#   export const MB_PARCEL_DATA_CDN =
#     'https://cdn.jsdelivr.net/gh/<owner>/<repo>@<40-hex-sha>';
# Match the @<sha>' tail so a wholesale rename of owner/repo doesn't
# break the pattern; only the SHA changes.
$content = Get-Content $arcgisPath -Raw
$pattern = "(?<=mb-parcel-data@)[0-9a-f]{7,40}(?=')"
$existing = [regex]::Match($content, $pattern).Value
if (-not $existing) { throw "Could not find MB_PARCEL_DATA_CDN SHA in $arcgisPath" }
if ($DryRun) {
  Write-Host "[dry-run] arcgis.js: SHA $existing -> $headSha"
} elseif ($existing -eq $headSha) {
  Write-Host 'arcgis.js already points at HEAD — nothing to rewrite.'
} else {
  Set-Content -Path $arcgisPath -Value ($content -replace $pattern, $headSha) -NoNewline
  Write-Host "arcgis.js: SHA $existing -> $headSha"
}

if ($DryRun) {
  Write-Host "`n[dry-run] no changes made."
} else {
  Write-Host "`nDone. Review ``git diff web/src/arcgis.js``, then commit + push —"
  Write-Host 'Vercel redeploys and the app picks up the new shards.'
}
# Don't let a benign nonzero from the last native call (e.g. an empty
# git status) leak out as failure.
exit 0
