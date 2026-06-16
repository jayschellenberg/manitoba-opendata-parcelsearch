# schedule_publish.ps1 - register auto-publish-indexes.ps1 as a recurring Windows Task
# Scheduler entry, so the live site's "Data refreshed" date tracks the mao-scrape data
# without a manual release. The task runs auto-publish-indexes.ps1, which rebuilds the
# legal + assessment indexes from the current parquets, validates, publishes a GitHub
# Release, bumps the edge-fn URLs, and commits + pushes (Vercel auto-deploys). The script
# self-alerts (email + ntfy) on failure, so no separate wrapper is needed.
#
# Cadence:
#   default        -> MONTHLY on the 15th at 04:30 (the project's documented index cadence)
#   -Semiannual    -> JAN + JUL on the 15th at 04:30 (matches the ~2x/year data refresh;
#                     fewer 130 MB Releases, date stays inside the green staleness window)
# Idempotent: re-run to change cadence / replace the task.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File schedule_publish.ps1                # monthly
#   powershell -ExecutionPolicy Bypass -File schedule_publish.ps1 -Semiannual    # Jan/Jul
#
# Manage:
#   Get-ScheduledTask -TaskName MAOPublishIndexes | Format-List *
#   Start-ScheduledTask  -TaskName MAOPublishIndexes                 # run immediately
#   Unregister-ScheduledTask -TaskName MAOPublishIndexes -Confirm:$false   # cancel

param([switch]$Semiannual)

$ErrorActionPreference = 'Stop'
# PowerShell 7 turns native-command stderr/nonzero-exit into a throw under -Stop; we rely
# on $LASTEXITCODE checks for native tools (schtasks/git), so opt out. No-op on 5.1.
$PSNativeCommandUseErrorActionPreference = $false
$TaskName  = 'MAOPublishIndexes'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Publisher = Join-Path $ScriptDir 'auto-publish-indexes.ps1'

if (-not (Test-Path $Publisher)) { Write-Error "Publisher not found: $Publisher"; exit 1 }

# Replace any existing task with the same name.
schtasks /Query /TN $TaskName 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Existing task '$TaskName' found - replacing it."
  schtasks /Delete /TN $TaskName /F | Out-Null
}

$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Publisher`""

if ($Semiannual) {
  schtasks /Create /SC MONTHLY /M JAN,JUL /D 15 /ST 04:30 /TN $TaskName /TR $taskCmd /RL LIMITED /F
  $recur = 'Jan + Jul on the 15th at 04:30 (every 6 months)'
} else {
  schtasks /Create /SC MONTHLY /D 15 /ST 04:30 /TN $TaskName /TR $taskCmd /RL LIMITED /F
  $recur = '15th of every month at 04:30'
}
if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /Create failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }

# Battery + start-when-available flags (schtasks doesn't expose these).
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        $Publisher  (rebuild -> validate -> release -> commit -> push; self-alerts on failure)"
Write-Host "  Working dir: $ScriptDir"
Write-Host "  Recurrence:  $recur"
Write-Host "  StartWhenAvailable enabled (catches up if the machine was off)"
Write-Host ""
Write-Host "Run now:         Start-ScheduledTask -TaskName $TaskName"
Write-Host "Cancel schedule: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
