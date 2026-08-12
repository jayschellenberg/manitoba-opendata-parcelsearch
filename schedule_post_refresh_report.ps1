# schedule_post_refresh_report.ps1 -- register post-refresh-report.ps1 as a
# ONE-SHOT task for the morning after the first unattended monthly run.
#
# Default target: 2026-08-15 08:00. That is the first date on which
# mb-parcelsearch-monthly-refresh (04:00) and mb-parcelsearch-publish-indexes
# (04:30) will ever have fired -- both have LastTaskResult 267011 "has not yet
# run" as of 2026-08-12, and every refresh in this project's history was manual.
# 08:00 leaves ~4h, which comfortably covers the refresh's long pole (step 1 is
# the mao-scrape delta, ~10-30 min) plus the index publish.
#
# ONE-SHOT on purpose: this is a first-run confidence check, not a standing
# report. The steady-state monitors (monthly-refresh-wrapper.ps1's failure
# alert, the daily staleness watchdogs) remain the ongoing coverage. After it
# fires, the task is spent and can be removed with the command below.
#
# Uses Register-ScheduledTask rather than schtasks.exe like the sibling
# registrars: schtasks /SD parses the date in the machine's locale format,
# which is a silent foot-gun for a one-off date. -At takes a real DateTime.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File schedule_post_refresh_report.ps1
#   powershell -ExecutionPolicy Bypass -File schedule_post_refresh_report.ps1 -At '2026-09-15 08:00'
#
# Manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-post-refresh-report | Format-List *
#   Start-ScheduledTask -TaskName mb-parcelsearch-post-refresh-report              # run now
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-post-refresh-report -Confirm:$false

param(
  [datetime]$At = [datetime]'2026-08-15 08:00'
)

$ErrorActionPreference = 'Stop'
$TaskName  = 'mb-parcelsearch-post-refresh-report'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Reporter  = Join-Path $ScriptDir 'post-refresh-report.ps1'

if (-not (Test-Path $Reporter)) { Write-Error "Reporter not found: $Reporter"; exit 1 }
if ($At -lt (Get-Date)) { Write-Error "Target time $At is in the past - pass -At with a future time."; exit 1 }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Existing task '$TaskName' found - replacing it."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $Reporter)
$trigger = New-ScheduledTaskTrigger -Once -At $At
# StartWhenAvailable matters more here than for a recurring task: a one-shot
# that the machine sleeps through is simply lost, with no next occurrence.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'One-shot: report what the first unattended monthly refresh + index publish actually did.' | Out-Null

$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
Write-Host ''
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host ("  Fires once : {0}" -f $info.NextRunTime)
Write-Host '  Runs       : post-refresh-report.ps1 (read-only; never rebuilds or publishes)'
Write-Host '  Sends      : one summary either way - task results, log progress, pin-vs-HEAD consistency'
Write-Host '  Channels   : email (alert-email.local.txt) + ntfy push (mbps-monthly-refresh-jks)'
Write-Host ''
Write-Host 'Preview the report now:  powershell -ExecutionPolicy Bypass -File post-refresh-report.ps1 -Console'
Write-Host "Remove after it fires:   Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
