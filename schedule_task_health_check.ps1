# schedule_task_health_check.ps1 -- register task-health-check.ps1 as a DAILY
# Windows Task Scheduler entry (09:40 local).
#
# 09:40 is chosen to land AFTER the other morning watchdogs -- hpi-download
# 08:45, hpi-staleness 09:00, history-staleness 09:10, mbfloodmapping-staleness
# 09:20, upstream-vintage (Mon) 09:30 -- so that by the time this runs their
# LastTaskResult values are already written and it is judging the morning that
# just happened, not the one before.
#
# WHY THIS TASK EXISTS
#   Until 2026-08-12 only four of the fifteen registered MBOpenData tasks had
#   anything reading their LastTaskResult. That morning MAOSalesStaleness had
#   been killed at its execution time limit (267014) and MAOChunkedDelta had
#   exited 2 (file not found) the night before, and neither produced a single
#   alert -- the failures were sitting in taskschd.msc where nobody looks. This
#   is the reader for all of them, including the ones added after today.
#
# Daily is intentional and cheap: the check is read-only (Get-ScheduledTask,
# Get-ScheduledTaskInfo, plus a text scan of the schedule_*.ps1 registrars),
# it makes no network calls, and its content-aware quiet-period stamp holds
# repeat alerts to one per -QuietDays while still sending immediately when the
# set of findings CHANGES.
#
# Note the deliberate asymmetry with the thing it watches: this task cannot
# report on itself. If it stops running, nothing here notices -- the same class
# of gap it was written to close. The backstop for that is the fact that every
# other watchdog still alerts independently; this one adds coverage, it does not
# replace any of them.
#
# Idempotent -- re-run to update; the existing task is replaced.
#
# Usage (normal user privileges, no admin needed):
#   powershell -ExecutionPolicy Bypass -File schedule_task_health_check.ps1
#
# Manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-task-health | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-task-health                      # run now (read-only, safe)
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-task-health -Confirm:$false  # cancel

$ErrorActionPreference = "Continue"   # schtasks writes 'task not found' to stderr; don't let it throw
$TaskName  = "mb-parcelsearch-task-health"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Checker   = Join-Path $ScriptDir "task-health-check.ps1"

if (-not (Test-Path $Checker)) { Write-Error "Checker not found: $Checker"; exit 1 }

$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task '$TaskName' found - replacing it."
    schtasks /Delete /TN $TaskName /F | Out-Null
}

$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Checker`""

schtasks /Create `
    /SC DAILY `
    /ST 09:40 `
    /TN $TaskName `
    /TR $taskCmd `
    /RL LIMITED `
    /F | Out-Null

if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /Create failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }

# Battery + catch-up flags (schtasks doesn't expose these). 10 minutes is
# generous for a read-only check; if it ever hits that limit the run is wedged,
# and being terminated at the limit is itself a finding the NEXT run reports
# (result 267014) -- which is precisely how MAOSalesStaleness went unnoticed.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        task-health-check.ps1 daily at 09:40 local"
Write-Host ("  Next run:    {0}" -f $info.NextRunTime)
Write-Host "  Covers:      every task name found in the schedule_*.ps1 registrars of"
Write-Host "               mb-parcelsearch, mao-assembly, mao-scrape, MBFloodMapping"
Write-Host "  Flags:       a non-healthy LastTaskResult (healthy = 0, 267011 never-run,"
Write-Host "               267009 running), a Disabled task, an empty NextRunTime, a"
Write-Host "               missing registration, and a LastRunTime past 2x its own"
Write-Host "               trigger interval where that interval can be read"
Write-Host "  Channels:    email (alert-email.local.txt) + ntfy push (mbps-task-health-jks)"
Write-Host "  StartWhenAvailable enabled (catches up if the machine was off)"
Write-Host ""
Write-Host "Subscribe to the ntfy topic 'mbps-task-health-jks' in the ntfy app to get pushes."
Write-Host ""
Write-Host "See the current table:  powershell -ExecutionPolicy Bypass -File task-health-check.ps1 -NoAlert"
Write-Host "Test the alert path:    powershell -ExecutionPolicy Bypass -File task-health-check.ps1 -TestAlert"
Write-Host "Cancel:                 Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
