# schedule_hpi_check.ps1 -- register hpi-staleness-check.ps1 as a DAILY Windows
# Task Scheduler entry (09:00 local). Daily is intentional: the check's grace-day
# rule + dedupe stamp mean you still get at most ONE reminder per month, but a
# daily cadence catches the stale window even if the machine was off on any
# given day. Idempotent -- re-run to update; the existing task is replaced.
#
# Usage (normal user privileges, no admin needed):
#   powershell -ExecutionPolicy Bypass -File schedule_hpi_check.ps1
#
# Manage:
#   Get-ScheduledTask -TaskName HPIStalenessReminder | Format-List *
#   Start-ScheduledTask  -TaskName HPIStalenessReminder                      # run now
#   Unregister-ScheduledTask -TaskName HPIStalenessReminder -Confirm:$false  # cancel

$ErrorActionPreference = "Continue"   # schtasks writes 'task not found' to stderr; don't let it throw
$TaskName  = "HPIStalenessReminder"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Checker   = Join-Path $ScriptDir "hpi-staleness-check.ps1"

if (-not (Test-Path $Checker)) { Write-Error "Checker not found: $Checker"; exit 1 }

# Replace any existing task with the same name.
$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task '$TaskName' found - replacing it."
    schtasks /Delete /TN $TaskName /F | Out-Null
}

$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Checker`""

schtasks /Create `
    /SC DAILY `
    /ST 09:00 `
    /TN $TaskName `
    /TR $taskCmd `
    /RL LIMITED `
    /F | Out-Null

if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /Create failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }

# Battery + catch-up flags (schtasks doesn't expose these).
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        hpi-staleness-check.ps1 daily at 09:00 local"
Write-Host "  Reminds:     once per month, only if the newest MLS_HPI_* folder is behind"
Write-Host "  Channels:    email (alert-email.local.txt) + ntfy push (mbps-hpi-staleness-jks)"
Write-Host "  StartWhenAvailable enabled (catches up if the machine was off)"
Write-Host ""
Write-Host "Test the alert path now:  powershell -ExecutionPolicy Bypass -File hpi-staleness-check.ps1 -TestAlert"
Write-Host "Cancel:                   Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
