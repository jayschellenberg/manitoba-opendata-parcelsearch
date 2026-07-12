# schedule_monthly.ps1 - register the monthly refresh as a recurring
# Windows Task Scheduler entry that fires on the 15th of every month
# at 04:00 local. The task runs monthly-refresh-wrapper.ps1 (NOT the
# .bat directly) so a failed refresh sends an email alert - see the
# wrapper's header for how the destination address is configured.
# Idempotent: re-run to update the schedule or after changing the
# wrapper/.bat - the existing task is replaced.
#
# Usage (run once from a PowerShell prompt with normal user privileges):
#   powershell -ExecutionPolicy Bypass -File schedule_monthly.ps1
#
# To verify / manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-monthly-refresh | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-monthly-refresh                  # run immediately
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-monthly-refresh -Confirm:$false   # cancel
#
# Why schtasks.exe inside PowerShell: the PowerShell ScheduledTasks
# module's New-ScheduledTaskTrigger doesn't support
# "monthly on day N" triggers directly. schtasks /SC MONTHLY /D 15
# is the simplest cross-version way to get a recurring monthly
# schedule with a specific day-of-month.

$ErrorActionPreference = "Stop"
$TaskName  = "mb-parcelsearch-monthly-refresh"
$LegacyTaskNames = @("MAOMonthlyRefresh")
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BatFile   = Join-Path $ScriptDir "monthly-refresh.bat"
$Wrapper   = Join-Path $ScriptDir "monthly-refresh-wrapper.ps1"

if (-not (Test-Path $BatFile)) {
    Write-Error "Refresh script not found: $BatFile"
    exit 1
}
if (-not (Test-Path $Wrapper)) {
    Write-Error "Alert wrapper not found: $Wrapper"
    exit 1
}

# Replace any existing task with the same name, plus the legacy pre-rename task.
foreach ($name in @($TaskName) + $LegacyTaskNames) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $existing) { continue }
    Write-Host "Existing task '$name' found - replacing it."
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
}

# Create the recurring monthly trigger.
#   /SC MONTHLY  - recur every month
#   /D 15        - on the 15th
#   /ST 04:00    - at 04:00 local
#   /TR "<cmd>"  - task command: the PowerShell wrapper, which runs the
#                  .bat and emails on a nonzero exit
#   /RL LIMITED  - run as the current user with normal privileges
#   /F           - force overwrite if a task exists
$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Wrapper`""

$result = schtasks /Create `
    /SC MONTHLY `
    /D 15 `
    /ST 04:00 `
    /TN $TaskName `
    /TR $taskCmd `
    /RL LIMITED `
    /F

if ($LASTEXITCODE -ne 0) {
    Write-Error "schtasks /Create failed (exit code $LASTEXITCODE)"
    exit $LASTEXITCODE
}

# Apply battery + start-when-available flags via the PowerShell
# Scheduled Tasks module - schtasks doesn't expose these directly.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 6)

Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Wrapper:     $Wrapper  (emails on failure, then runs:)"
Write-Host "  Refresh:     $BatFile"
Write-Host "  Working dir: $ScriptDir"
Write-Host "  Recurrence:  15th of every month at 04:00 local"
Write-Host "  StartWhenAvailable enabled (catches up if machine was off)"
Write-Host ""
Write-Host "Useful commands (PowerShell):"
Write-Host "  Show details:    Get-ScheduledTask -TaskName $TaskName | Format-List *"
Write-Host "  Run now:         Start-ScheduledTask  -TaskName $TaskName"
Write-Host "  Cancel schedule: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host "  Tail latest log: Get-ChildItem logs\monthly-*.log |"
Write-Host "                     Sort-Object LastWriteTime -Desc |"
Write-Host "                     Select-Object -First 1 | Get-Content -Wait -Tail 80"
