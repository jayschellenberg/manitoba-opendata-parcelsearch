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
#   Get-ScheduledTask -TaskName mb-parcelsearch-publish-indexes | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-publish-indexes                 # run immediately
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-publish-indexes -Confirm:$false   # cancel

param([switch]$Semiannual)

$ErrorActionPreference = 'Stop'
# PowerShell 7 turns native-command stderr/nonzero-exit into a throw under -Stop; we rely
# on $LASTEXITCODE checks for native tools (schtasks/git), so opt out. No-op on 5.1.
$PSNativeCommandUseErrorActionPreference = $false
$TaskName  = 'mb-parcelsearch-publish-indexes'
$LegacyTaskNames = @('MAOPublishIndexes')
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Publisher = Join-Path $ScriptDir 'auto-publish-indexes.ps1'

if (-not (Test-Path $Publisher)) { Write-Error "Publisher not found: $Publisher"; exit 1 }

# Remove any existing task with the same name, plus the legacy pre-rename task.
# /Create /F below would overwrite the new name anyway, but this also prevents
# the old name from continuing to fire after the project folder rename.
foreach ($name in @($TaskName) + $LegacyTaskNames) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}

# auto-publish-indexes.ps1 MUST run under PowerShell 7 (pwsh.exe), NOT Windows PowerShell
# 5.1. It sets $ErrorActionPreference='Stop' and merges R's stderr into the log; only pwsh
# 7's $PSNativeCommandUseErrorActionPreference=$false keeps R's benign stderr progress
# ("[legal-index] reading ...", "done") from being promoted to a fatal error. Under 5.1
# that guard is a no-op, so every run dies on R's first message. Resolve pwsh 7 explicitly.
$pwshExe = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwshExe) { $pwshExe = 'C:\Program Files\PowerShell\7\pwsh.exe' }
if (-not (Test-Path $pwshExe)) {
  Write-Error "PowerShell 7 (pwsh.exe) not found. auto-publish-indexes.ps1 requires pwsh 7 (5.1 mishandles R's stderr). Install PowerShell 7 or edit `$pwshExe in this script."
  exit 1
}

# schtasks builds the day-of-month MONTHLY trigger cleanly (the *ScheduledTask cmdlets have
# no simple day-of-month trigger). It registers a placeholder action here; we overwrite the
# action just below with a cmdlet-built pwsh invocation so the space in the pwsh.exe path is
# quoted correctly (a raw schtasks /TR string mangles it).
if ($Semiannual) {
  schtasks /Create /SC MONTHLY /M JAN,JUL /D 15 /ST 04:30 /TN $TaskName /TR $pwshExe /RL LIMITED /F
  $recur = 'Jan + Jul on the 15th at 04:30 (every 6 months)'
} else {
  schtasks /Create /SC MONTHLY /D 15 /ST 04:30 /TN $TaskName /TR $pwshExe /RL LIMITED /F
  $recur = '15th of every month at 04:30'
}
if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /Create failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }

# Overwrite the action with the properly-quoted pwsh 7 invocation, and add the battery +
# start-when-available flags schtasks doesn't expose -- in one Set-ScheduledTask call.
$action = New-ScheduledTaskAction -Execute $pwshExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Publisher`""
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Set-ScheduledTask -TaskName $TaskName -Action $action -Settings $settings | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        $Publisher  (rebuild -> validate -> release -> commit -> push; self-alerts on failure)"
Write-Host "  Working dir: $ScriptDir"
Write-Host "  Recurrence:  $recur"
Write-Host "  StartWhenAvailable enabled (catches up if the machine was off)"
Write-Host ""
Write-Host "Run now:         Start-ScheduledTask -TaskName $TaskName"
Write-Host "Cancel schedule: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
