# semiannual-publish-wrapper.ps1 - the full twice-a-year publish pipeline.
#
# Runs unattended on Jan 1 / Jul 1 (see schedule_semiannual.ps1) and does the
# ENTIRE flow that used to be manual, end to end:
#
#   1. Download the three provincial layers fresh from the ArcGIS FeatureServer
#      into a throwaway staging dir  (r/download_provincial_snapshot.R)
#   2. Archive them as a new dated MAOSnapshots capture + provenance sidecars
#      (r/archive_snapshot.R, pointed at staging so mao-assembly is untouched)
#   3. Build per-muni historical display shards for the current year
#      (r/build_historical_shards.R --year <yyyy>)
#   4. Rebuild parcel lineage across all snapshots  (r/build_lineage.R)
#   5. Commit + push the mb-parcel-history data repo -> capture new commit SHA
#   6. Repoint HISTORICAL_CDN in the app (web/src/arcgis.js) to that SHA,
#      commit + push the app repo -> Vercel redeploys production
#
# ANY failed step fires a push + email alert (alert-lib.ps1) and stops. The
# manual MB geoPortal download is no longer required — this pulls the same
# authoritative layers directly from the FeatureServer.
#
# ntfy topic: mbps-semiannual-archive-jks  (shared with the old archive job so
# an existing subscription keeps working).
#
# Test the alert path only (no pipeline):
#   powershell -ExecutionPolicy Bypass -File semiannual-publish-wrapper.ps1 -TestAlert

param([switch]$TestAlert)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
$NtfyTopic = 'mbps-semiannual-archive-jks'

# --- repo + path config (env-overridable, matches r/config.R defaults) ---
$AppRepo  = $root
$ArcgisJs = Join-Path $root 'web\src\arcgis.js'
$HistRepo = if ($env:MB_PARCEL_HISTORY_ROOT) { $env:MB_PARCEL_HISTORY_ROOT } `
            else { 'D:\Dropbox\ClaudeCode\MBOpenData\mb-parcel-history' }
$StagingRoot   = Join-Path $env:LOCALAPPDATA 'mao-publish-staging'
$StagingInputs = Join-Path $StagingRoot 'inputs'

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - MB parcel semiannual PUBLISH alerts' `
    ("Test alert from semiannual-publish-wrapper.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
     'If this reached you, publish-pipeline alerts are wired up.')
  if ($ok) { exit 0 } else { exit 1 }
}

function Resolve-Rscript {
  $cmd = Get-Command Rscript.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  Get-ChildItem 'C:\Program Files\R\R-*\bin\Rscript.exe' -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.FullName -replace '.*\\R-([\d.]+)\\.*', '$1') } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
$rscript = Resolve-Rscript

if (-not (Test-Path (Join-Path $root 'logs'))) { New-Item -ItemType Directory -Path (Join-Path $root 'logs') | Out-Null }
$ts  = Get-Date -Format 'yyyyMMdd-HHmm'
$log = Join-Path $root "logs\publish-$ts.log"
$stamp = Get-Date -Format 'yyyy-MM-dd'
$year  = (Get-Date).Year

function Log([string]$m) { $line = "$(Get-Date -Format s)  $m"; Write-Host $line; Add-Content -Path $log -Value $line }
function Die([string]$title, [string]$detail) {
  Log "FAILED: $title`n$detail"
  Send-FailureAlert $root $NtfyTopic "FAILED - MB parcel semiannual publish: $title" `
    ("$detail`n`nHost: $env:COMPUTERNAME  Time: $(Get-Date -Format s)`nLog: $log") | Out-Null
  exit 1
}

# Run an Rscript step; die on nonzero exit. Extra env vars via $envMap.
function Invoke-R([string]$scriptRel, [string[]]$argv, [hashtable]$envMap, [string]$label) {
  Log "== $label =="
  $saved = @{}
  if ($envMap) { foreach ($k in $envMap.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); Set-Item "env:$k" $envMap[$k] } }
  try {
    $out = & $rscript (Join-Path $root $scriptRel) @argv 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $out | ForEach-Object { Add-Content -Path $log -Value $_ }
    if ($code -ne 0) { Die $label (($out | Select-Object -Last 30) -join "`n") }
    return $out
  } finally {
    if ($envMap) { foreach ($k in $envMap.Keys) { if ($null -eq $saved[$k]) { Remove-Item "env:$k" -ErrorAction SilentlyContinue } else { Set-Item "env:$k" $saved[$k] } } }
  }
}

if (-not $rscript) { Die 'no Rscript' 'Rscript.exe not found on PATH or under C:\Program Files\R.' }
Log "Publish pipeline start — snapshot $stamp, year $year"

# 1. fresh download into a clean staging dir
if (Test-Path $StagingInputs) { Remove-Item $StagingInputs -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $StagingInputs -Force | Out-Null
Invoke-R 'r\download_provincial_snapshot.R' @() @{ PROVINCIAL_STAGING_DIR = $StagingInputs } 'download provincial layers' | Out-Null

# 2. archive (dated capture + provenance) — point the archiver at staging
$arch = Invoke-R 'r\archive_snapshot.R' @() @{ MAO_ASSEMBLY_ROOT = $StagingRoot } 'archive snapshot'
if ($arch | Where-Object { $_ -match 'STALE|SKIP\s+.*\(not found' }) {
  Die 'archive source stale/missing' (($arch | Where-Object { $_ -match 'STALE|SKIP' }) -join "`n")
}

# 3. shards + 4. lineage
Invoke-R 'r\build_historical_shards.R' @('--year', "$year") $null 'build historical shards' | Out-Null
Invoke-R 'r\build_lineage.R' @() $null 'build lineage' | Out-Null

# 5. commit + push the data repo
Log '== commit + push mb-parcel-history =='
& git -C $HistRepo add -A 2>&1 | ForEach-Object { Add-Content -Path $log -Value "$_" }
$dirty = & git -C $HistRepo status --porcelain
if ($dirty) {
  & git -C $HistRepo commit -m "Add $stamp snapshot + rebuilt lineage" 2>&1 | ForEach-Object { Add-Content -Path $log -Value "$_" }
  & git -C $HistRepo push 2>&1 | ForEach-Object { Add-Content -Path $log -Value "$_" }
  if ($LASTEXITCODE -ne 0) { Die 'mb-parcel-history push' 'git push failed for the data repo (see log).' }
} else {
  Log 'mb-parcel-history: nothing to commit (data unchanged) — skipping push'
}
$sha = (& git -C $HistRepo rev-parse HEAD).Trim()
if (-not $sha) { Die 'no data SHA' 'could not read mb-parcel-history HEAD sha' }
Log "mb-parcel-history HEAD = $sha"

# 6. repoint the app CDN pin -> commit + push -> Vercel deploy
Log '== repoint app HISTORICAL_CDN =='
$content = Get-Content -Raw $ArcgisJs
$new = [regex]::Replace($content, 'mb-parcel-history@[0-9a-f]{40}', "mb-parcel-history@$sha")
if ($new -eq $content) {
  Log "app pin already at $sha — no app change needed"
} else {
  # BOM-less UTF-8: Set-Content -Encoding UTF8 adds a BOM under Windows
  # PowerShell 5.1 (the scheduled-task runtime), which would corrupt the JS
  # file's first bytes. Write via .NET with an explicit no-BOM encoder.
  [System.IO.File]::WriteAllText($ArcgisJs, $new, (New-Object System.Text.UTF8Encoding($false)))
  & git -C $AppRepo add 'web/src/arcgis.js' 2>&1 | ForEach-Object { Add-Content -Path $log -Value "$_" }
  & git -C $AppRepo commit -m "Repoint historical CDN to mb-parcel-history@$($sha.Substring(0,7)) ($stamp snapshot)" 2>&1 | ForEach-Object { Add-Content -Path $log -Value "$_" }
  & git -C $AppRepo push 2>&1 | ForEach-Object { Add-Content -Path $log -Value "$_" }
  if ($LASTEXITCODE -ne 0) { Die 'app push' 'git push failed for the app repo (arcgis.js pin) — see log.' }
  Log "app repin pushed — Vercel will redeploy"
}

Log "Publish pipeline complete — $stamp live at mb-parcel-history@$sha"
Send-AlertPush $NtfyTopic 'OK - MB parcel semiannual publish' `
  "Published $stamp snapshot. mb-parcel-history@$($sha.Substring(0,7)); app repinned + redeploying. Host $env:COMPUTERNAME." | Out-Null
exit 0
