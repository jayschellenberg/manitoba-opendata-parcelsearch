# monthly-refresh-wrapper.ps1 — run monthly-refresh.bat and ALERT on failure.
#
# Why a wrapper: the .bat logs to logs\monthly-*.log and exits, but a
# 04:00 scheduled run that dies has nobody watching. On any nonzero
# exit this wrapper sends the last 40 log lines through two channels
# (email + ntfy push) — the shared helpers live in alert-lib.ps1; see
# that file for the alert-email.local.txt config and ntfy notes.
#   ntfy topic: mbps-monthly-refresh-jks
#
# Test the alert path without running the refresh:
#   powershell -ExecutionPolicy Bypass -File monthly-refresh-wrapper.ps1 -TestAlert
#
# Scheduled via schedule_monthly.ps1, which points the Task Scheduler
# entry here instead of at the .bat directly. Exit code passes through
# so Task Scheduler still records the underlying failure.

param([switch]$TestAlert)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
$NtfyTopic = 'mbps-monthly-refresh-jks'   # public namespace; carries no secrets

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - MB parcel monthly refresh alerts' `
    ("Test alert from monthly-refresh-wrapper.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
     'If this reached you, refresh-failure alerts are wired up.')
  if ($ok) { exit 0 } else { exit 1 }
}

Write-Host 'Running monthly-refresh.bat ...'
& cmd.exe /c (Join-Path $root 'monthly-refresh.bat')
$code = $LASTEXITCODE

if ($code -eq 0) {
  Write-Host 'monthly-refresh.bat completed OK.'
  exit 0
}

# Failure — grab the tail of the newest log for the alert body.
$log = Get-ChildItem (Join-Path $root 'logs\monthly-*.log') -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$tail = if ($log) { (Get-Content $log.FullName -Tail 40) -join "`n" } else { '(no log file found)' }
$logName = if ($log) { $log.Name } else { 'n/a' }
$body = "monthly-refresh.bat exited with code $code on $env:COMPUTERNAME at $(Get-Date -Format s).`n`n" +
        "Last 40 lines of ${logName}:`n$tail"
Send-FailureAlert $root $NtfyTopic "FAILED - MB parcel monthly refresh (exit $code)" $body | Out-Null
exit $code
