# schedule_semiannual.ps1 — register the permanent snapshot archive as a
# recurring Windows Task Scheduler entry that fires twice a year, on the 15th
# of June and December at 04:30 local. The task runs
# semiannual-archive-wrapper.ps1, which archives the provincial roll / zoning /
# dev-plan layers (r/archive_snapshot.R) and alerts when the source is missing
# or > 12 months stale (the only step automation can't do is the manual MB Open
# Data download). Idempotent: re-run to update the schedule — the existing task
# is replaced.
#
# Usage (run once from a PowerShell prompt with normal user privileges):
#   powershell -ExecutionPolicy Bypass -File schedule_semiannual.ps1
#
# To verify / manage:
#   Get-ScheduledTask -TaskName MAOSemiannualArchive | Format-List *
#   Start-ScheduledTask  -TaskName MAOSemiannualArchive               # run immediately
#   Unregister-ScheduledTask -TaskName MAOSemiannualArchive -Confirm:$false   # cancel
#
# Why schtasks.exe inside PowerShell: New-ScheduledTaskTrigger has no
# "monthly on day N of months X,Y" trigger; schtasks /SC MONTHLY /M JUN,DEC
# /D 15 is the simplest cross-version way to get a twice-a-year schedule.

$ErrorActionPreference = "Stop"
$TaskName  = "MAOSemiannualArchive"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Wrapper   = Join-Path $ScriptDir "semiannual-archive-wrapper.ps1"

if (-not (Test-Path $Wrapper)) {
    Write-Error "Archive wrapper not found: $Wrapper"
    exit 1
}

# Replace any existing task with the same name.
$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task '$TaskName' found — replacing it."
    schtasks /Delete /TN $TaskName /F | Out-Null
}

# Create the recurring twice-a-year trigger.
#   /SC MONTHLY      — month-based schedule
#   /M JUN,DEC       — only in June and December (i.e. every 6 months)
#   /D 15            — on the 15th
#   /ST 04:30        — at 04:30 local (after the monthly refresh's 04:00 slot)
#   /TR "<cmd>"      — task command: the PowerShell wrapper
#   /RL LIMITED      — run as the current user with normal privileges
#   /F               — force overwrite if a task exists
$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Wrapper`""

$result = schtasks /Create `
    /SC MONTHLY `
    /M JUN,DEC `
    /D 15 `
    /ST 04:30 `
    /TN $TaskName `
    /TR $taskCmd `
    /RL LIMITED `
    /F

if ($LASTEXITCODE -ne 0) {
    Write-Error "schtasks /Create failed (exit code $LASTEXITCODE)"
    exit $LASTEXITCODE
}

# Apply battery + start-when-available flags via the PowerShell Scheduled
# Tasks module — schtasks doesn't expose these directly.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Wrapper:     $Wrapper  (archives roll/zoning/dev-plan, alerts on stale/missing source)"
Write-Host "  Working dir: $ScriptDir"
Write-Host "  Recurrence:  15th of June and December at 04:30 local (every 6 months)"
Write-Host "  StartWhenAvailable enabled (catches up if machine was off)"
Write-Host ""
Write-Host "Useful commands (PowerShell):"
Write-Host "  Show details:    Get-ScheduledTask -TaskName $TaskName | Format-List *"
Write-Host "  Run now:         Start-ScheduledTask  -TaskName $TaskName"
Write-Host "  Cancel schedule: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host "  Test alerts:     powershell -ExecutionPolicy Bypass -File semiannual-archive-wrapper.ps1 -TestAlert"
