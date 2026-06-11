# semiannual-archive-wrapper.ps1 — capture the permanent provincial snapshots
# (roll / zoning / dev-plan) every six months, and ALERT when there's nothing
# fresh to capture.
#
# Why a wrapper: r/archive_snapshot.R copies whatever currently sits in
# mao-assembly/inputs/ into the dated Dropbox archive. The ONE step no
# automation can do is the manual MB Open Data portal download that refreshes
# those inputs — so a scheduled archive run is only as fresh as your last
# download. archive_snapshot.R prints "!! STALE" (source > 12 months old) and
# "SKIP ... not found" but still exits 0, so this wrapper scans the run output
# and turns either condition into a push/email REMINDER to go pull fresh data.
# It also alerts on a hard failure (nonzero exit).
#
# Alerts go through the shared helpers in alert-lib.ps1 (email + ntfy push) —
# see that file for the alert-email.local.txt config. ntfy topic:
#   mbps-semiannual-archive-jks
#
# Test the alert path without running the archive:
#   powershell -ExecutionPolicy Bypass -File semiannual-archive-wrapper.ps1 -TestAlert
#
# Scheduled via schedule_semiannual.ps1 (Task Scheduler, June 15 / Dec 15).

param([switch]$TestAlert)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
$NtfyTopic = 'mbps-semiannual-archive-jks'   # public namespace; carries no secrets

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - MB parcel semiannual snapshot alerts' `
    ("Test alert from semiannual-archive-wrapper.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
     'If this reached you, snapshot-archive alerts are wired up.')
  if ($ok) { exit 0 } else { exit 1 }
}

# Locate Rscript: prefer PATH, else the newest R under Program Files
# (mirrors monthly-refresh.bat — never pin a version, it breaks on upgrade).
function Resolve-Rscript {
  $cmd = Get-Command Rscript.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cand = Get-ChildItem 'C:\Program Files\R\R-*\bin\Rscript.exe' -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.FullName -replace '.*\\R-([\d.]+)\\.*', '$1') } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  return $cand
}

$rscript = Resolve-Rscript
if (-not $rscript) {
  $msg = "Rscript.exe not found on PATH or under C:\Program Files\R on $env:COMPUTERNAME — install R or add it to PATH."
  Write-Warning $msg
  Send-FailureAlert $root $NtfyTopic 'FAILED - MB parcel snapshot archive (no Rscript)' $msg | Out-Null
  exit 1
}

if (-not (Test-Path (Join-Path $root 'logs'))) { New-Item -ItemType Directory -Path (Join-Path $root 'logs') | Out-Null }
$ts  = Get-Date -Format 'yyyyMMdd-HHmm'
$log = Join-Path $root "logs\archive-$ts.log"

Write-Host "Running r/archive_snapshot.R (roll + zoning + dev-plan) ..."
# Capture combined stdout+stderr so we can both log it and scan for the
# script's STALE / SKIP markers (it exits 0 in those cases).
$out  = & $rscript (Join-Path $root 'r\archive_snapshot.R') 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
$text = $out -join "`n"
"=== archive run $ts (exit $code) ===`n$text" | Set-Content -Path $log -Encoding UTF8
$out | ForEach-Object { Write-Host $_ }

# Hard failure → alert and pass the code through.
if ($code -ne 0) {
  $tail = ($out | Select-Object -Last 40) -join "`n"
  $body = "archive_snapshot.R exited with code $code on $env:COMPUTERNAME at $(Get-Date -Format s).`n`n" +
          "Last 40 lines of archive-$ts.log:`n$tail"
  Send-FailureAlert $root $NtfyTopic "FAILED - MB parcel snapshot archive (exit $code)" $body | Out-Null
  exit $code
}

# Soft conditions the script reports but doesn't fail on: a stale source
# (> 12 months) or a missing input. Either means the manual MB Open Data
# download is overdue — nudge so the next snapshot isn't a stale re-capture.
$stale   = $out | Where-Object { $_ -match 'STALE' }
$missing = $out | Where-Object { $_ -match 'SKIP\s+.*\(not found' }
if ($stale -or $missing) {
  $detail = (@($stale) + @($missing) | Where-Object { $_ }) -join "`n"
  $body = "Semiannual snapshot archive ran on $env:COMPUTERNAME at $(Get-Date -Format s), but the provincial source is stale or missing.`n" +
          "Download fresh MBRollGeoPackage / Zoning / Development-Plan from MB Open Data into mao-assembly/inputs/, then re-run.`n`n" +
          "$detail`n`nFull log: $log"
  Send-FailureAlert $root $NtfyTopic 'REMINDER - MB parcel snapshot source stale/missing' $body | Out-Null
  Write-Host 'Archive completed but source is stale/missing — reminder alert sent.'
  exit 0
}

Write-Host "Snapshot archive completed OK. Log: $log"
exit 0
