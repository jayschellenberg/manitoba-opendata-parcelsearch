# schedule_semiannual.ps1 - register the permanent snapshot PUBLISH pipeline as
# a recurring Windows Task Scheduler entry that fires twice a year, on the 1st
# of January and July at 04:30 local. The task runs
# semiannual-publish-wrapper.ps1, which does the whole flow end to end:
# download the provincial roll / zoning / dev-plan layers fresh from the ArcGIS
# FeatureServer, archive them (r/archive_snapshot.R), build historical shards +
# lineage, push the mb-parcel-history data repo, repoint the app's HISTORICAL_CDN
# pin, and push the app so Vercel redeploys. It alerts on any failure.
# Idempotent: re-run to update the schedule - the existing task is replaced.
#
# (The older semiannual-archive-wrapper.ps1 - archive-only, no download/publish -
# is kept for manual archive-only use; this schedule now targets the full
# publish wrapper.)
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
# "monthly on day N of months X,Y" trigger; schtasks /SC MONTHLY /M JAN,JUL
# /D 1 is the simplest cross-version way to get a twice-a-year schedule.

$ErrorActionPreference = "Stop"
$TaskName  = "MAOSemiannualArchive"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Wrapper   = Join-Path $ScriptDir "semiannual-publish-wrapper.ps1"

if (-not (Test-Path $Wrapper)) {
    Write-Error "Archive wrapper not found: $Wrapper"
    exit 1
}

# Replace any existing task with the same name.
$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task '$TaskName' found - replacing it."
    schtasks /Delete /TN $TaskName /F | Out-Null
}

# Create the recurring twice-a-year trigger.
#   /SC MONTHLY      - month-based schedule
#   /M JAN,JUL       - only in January and July (i.e. every 6 months)
#   /D 1             - on the 1st
#   /ST 04:30        - at 04:30 local (after the monthly refresh's 04:00 slot)
#   /TR "<cmd>"      - task command: the PowerShell wrapper
#   /RL LIMITED      - run as the current user with normal privileges
#   /F               - force overwrite if a task exists
$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Wrapper`""

$result = schtasks /Create `
    /SC MONTHLY `
    /M JAN,JUL `
    /D 1 `
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
# Tasks module - schtasks doesn't expose these directly.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4)

Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Wrapper:     $Wrapper  (download -> archive -> shards+lineage -> push data -> repoint app -> redeploy)"
Write-Host "  Working dir: $ScriptDir"
Write-Host "  Recurrence:  1st of January and July at 04:30 local (every 6 months)"
Write-Host "  StartWhenAvailable enabled (catches up if machine was off)"
Write-Host ""
Write-Host "Useful commands (PowerShell):"
Write-Host "  Show details:    Get-ScheduledTask -TaskName $TaskName | Format-List *"
Write-Host "  Run now:         Start-ScheduledTask  -TaskName $TaskName"
Write-Host "  Cancel schedule: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host "  Test alerts:     powershell -ExecutionPolicy Bypass -File semiannual-publish-wrapper.ps1 -TestAlert"
Write-Host "  Dead-man check:  schedule_history_check.ps1 registers the daily staleness watchdog"
