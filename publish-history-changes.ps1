# publish-history-changes.ps1 -- Unattended weekly publish of the parcel change
# history to the live site.
#
# Chain (aborts on the first failure; nothing partial reaches the site):
#   1. guard: both repos on main (never publish from a feature branch)
#   2. Rscript r/build_change_shards.R   history/ -> mb-parcel-history/changes/
#   3. commit + push mb-parcel-history   ONLY the changes/ path; other work in
#                                         that clone (du-snapshots, a snapshot in
#                                         progress) is left alone
#   4. re-pin HISTORICAL_CDN in web/src/arcgis.js to the new commit
#      (history-pin-lib.ps1), commit + push the app -> Vercel redeploys
#
# Run by mao-assembly/refresh-monthly-wrapper.ps1 (Sundays) right after
# build_parcel_history.R and build_lineage.R --tables. Safe to run by hand.
# Per-muni shards carry no timestamps, so a week with no parcel change in a
# muni leaves its file byte-identical and git stores nothing new for it; a
# week with no change anywhere commits only changes/_index.json.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File publish-history-changes.ps1
#   powershell -ExecutionPolicy Bypass -File publish-history-changes.ps1 -DryRun     # build only; no commit/push
#   powershell -ExecutionPolicy Bypass -File publish-history-changes.ps1 -TestAlert

param([switch]$DryRun, [switch]$TestAlert)

# 'Continue', not 'Stop': under Windows PowerShell 5.1 (the scheduled-task
# runtime) 'Stop' turns any native-command stderr line into a terminating
# error, and Rscript writes ordinary progress there ("Spherical geometry (s2)
# switched off") -- the first publish died on exactly that line. Every native
# call below is gated on $LASTEXITCODE explicitly instead.
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false   # PS 7 equivalent; no-op on 5.1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
. (Join-Path $root 'history-pin-lib.ps1')
# Same topic as the semiannual publish: both put parcel history on the site.
$NtfyTopic = 'mbps-semiannual-archive-jks'

$AppRepo  = $root
$ArcgisJs = Join-Path $root 'web\src\arcgis.js'
$HistRepo = if ($env:MB_PARCEL_HISTORY_ROOT) { $env:MB_PARCEL_HISTORY_ROOT } `
            else { 'D:\Dropbox\ClaudeCode\MBOpenData\mb-parcel-history' }

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - MB parcel change-history publish alerts' `
    ("Test alert from publish-history-changes.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).")
  if ($ok) { exit 0 } else { exit 1 }
}

if (-not (Test-Path (Join-Path $root 'logs'))) { New-Item -ItemType Directory -Path (Join-Path $root 'logs') | Out-Null }
$ts  = Get-Date -Format 'yyyyMMdd-HHmm'
$log = Join-Path $root "logs\publish-history-$ts.log"
function Log([string]$m) {
  $line = "$(Get-Date -Format s)  $m"; Write-Host $line
  # Dropbox can hold a just-created file open (see auto-publish-indexes.ps1).
  for ($i = 1; $i -le 10; $i++) { try { Add-Content -Path $log -Value $line -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds (100 * $i) } }
}
function Die([string]$title, [string]$detail) {
  Log "FAILED: $title`n$detail"
  if ($DryRun) { exit 1 }   # a dry run is someone watching the console; no alert
  Send-FailureAlert $root $NtfyTopic "FAILED - MB parcel change-history publish: $title" `
    ("$detail`n`nHost: $env:COMPUTERNAME  Time: $(Get-Date -Format s)`nLog: $log") | Out-Null
  exit 1
}
function Invoke-Git([string]$repo, [string[]]$gitArgs) {
  $out = & git -C $repo @gitArgs 2>&1 | ForEach-Object { "$_" }
  $script:GitCode = $LASTEXITCODE
  $out | ForEach-Object { Add-Content -Path $log -Value $_ }
  return $out
}

try {
  Log "=== publish-history-changes (DryRun=$DryRun) ==="

  # 1. Branch guard. The app working copy doubles as the deploy source: a push
  #    from a feature branch would publish that branch and deploy nothing.
  foreach ($r in @($AppRepo, $HistRepo)) {
    $b = (& git -C $r branch --show-current).Trim()
    if ($b -ne 'main' -and -not $DryRun) { Die 'wrong branch' "$r is on '$b', not main -- refusing to publish. Merge or switch back, then re-run." }
  }

  # 2. Build the shards.
  $rs = Get-Command Rscript.exe -ErrorAction SilentlyContinue
  $rscript = if ($rs) { $rs.Source } else {
    Get-ChildItem 'C:\Program Files\R\R-*\bin\Rscript.exe' -ErrorAction SilentlyContinue |
      Sort-Object { [version]($_.FullName -replace '.*\\R-([\d.]+)\\.*', '$1') } -Descending |
      Select-Object -First 1 -ExpandProperty FullName }
  Log '== build_change_shards.R =='
  $out = & $rscript (Join-Path $root 'r\build_change_shards.R') 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $out | ForEach-Object { Add-Content -Path $log -Value $_ }
  if ($code -ne 0) { Die 'build_change_shards.R' (($out | Select-Object -Last 30) -join "`n") }
  if ($DryRun) { Log '[dry-run] shards built; no commit / push / re-pin.'; exit 0 }

  # 3. Commit + push ONLY changes/ in mb-parcel-history.
  Invoke-Git $HistRepo @('add', '--', 'changes') | Out-Null
  $staged = Invoke-Git $HistRepo @('diff', '--cached', '--name-only', '--', 'changes')
  if (-not $staged) {
    Log 'mb-parcel-history: changes/ unchanged -- nothing to publish'
    exit 0
  }
  Log "mb-parcel-history: committing $(@($staged).Count) file(s) under changes/"
  Invoke-Git $HistRepo @('commit', '-m', "Weekly parcel change history ($ts)", '--', 'changes') | Out-Null
  if ($script:GitCode -ne 0) { Die 'history commit' 'git commit failed in mb-parcel-history -- see log.' }
  Invoke-Git $HistRepo @('push', 'origin', 'HEAD') | Out-Null
  if ($script:GitCode -ne 0) { Die 'history push' 'git push failed in mb-parcel-history -- see log.' }
  $sha = (& git -C $HistRepo rev-parse HEAD).Trim()
  Log "mb-parcel-history pushed at $sha"

  # 4. Re-pin the app and deploy.
  $changed = Set-HistoryPin $ArcgisJs $sha
  if (-not $changed) { Log "app pin already at $sha"; exit 0 }
  Invoke-Git $AppRepo @('add', '--', 'web/src/arcgis.js') | Out-Null
  Invoke-Git $AppRepo @('commit', '-m', "Weekly: repoint historical CDN to mb-parcel-history@$($sha.Substring(0,7)) (parcel change history)", '--', 'web/src/arcgis.js') | Out-Null
  if ($script:GitCode -ne 0) { Die 'app commit' 'git commit of the re-pin failed -- see log.' }
  Invoke-Git $AppRepo @('push', 'origin', 'HEAD') | Out-Null
  if ($script:GitCode -ne 0) { Die 'app push' 'git push of the re-pin failed -- see log.' }
  Log 'app re-pinned and pushed -- Vercel will redeploy'
  Log '=== complete ==='
  exit 0
}
catch { Die 'unexpected error' $_.Exception.Message }
