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

# Capture the logon type BEFORE the teardown below, so the verdict at the end
# can tell "never was S4U" from "this run just DOWNGRADED a working S4U task".
# The second is the drift trap this whole block exists for and is far more
# urgent; without this, both look identical. Missing task -> empty string.
$PriorLogonType = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).Principal.LogonType

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

# ---- 2026-08-12: own the task PRINCIPAL, don't leave it Interactive ---------
# schtasks.exe (above) can only ever create an INTERACTIVE task, which does not
# run unless Jason is logged on. A Windows Update reboot at 01:31 on 2026-08-12
# left the machine at the logon screen and cost 9.3 h: every task was
# Interactive, so even the watchdogs were down and nothing could report the
# outage. All 14 tasks were converted to S4U ("run whether the user is logged on
# or not", no stored password) that day.
#
# That conversion was manual, so without this block re-running this registrar
# for any unrelated reason - a changed cadence, a new pwsh path - silently
# reverts the task to Interactive and quietly re-opens the gap. The principal is
# the registrar's business now, not a one-off repair.
#
# Pasted rather than factored into a shared helper: these registrars are the
# bootstrap layer and are standalone on purpose (one that dot-sources a helper
# breaks when the helper moves), and the siblings needing the identical block
# live in other repos (mao-assembly, mao-scrape, MBFloodMapping) that a helper
# here could not reach anyway.
#
# NOT for mao-scrape's MAOSalesSearch / MAOSalesStaleness: those must STAY
# Interactive to read a DPAPI blob an S4U token cannot unlock - see their headers.
#
# Set-ScheduledTask -Principal requires ELEVATION; unelevated it throws
# "Access is denied." (verified 2026-08-12 under both 5.1 and pwsh 7). That is
# caught rather than fatal - the task is already registered above and stays
# usable - but it is reported loudly, because an Interactive task nobody
# noticed is the entire failure mode described above.
$S4UError = $null
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType S4U -RunLevel Limited
try {
  Set-ScheduledTask -TaskName $TaskName -Principal $principal -ErrorAction Stop | Out-Null
} catch {
  # Swallowed on purpose. Access-denied from an unelevated prompt is the
  # EXPECTED path and must not fail the registration; the task is already
  # registered above and stays usable. The read-back below is the real
  # verdict, and the block at the end of this script is where it is
  # reported - loudly. Trimmed because the CIM exception message carries a
  # trailing newline that would otherwise break up the warning box.
  $S4UError = ([string]$_.Exception.Message).Trim()
}

# Ask Windows what it actually stored - do not assert it. This read-back is
# the line that would have caught the original drift, so it is what gets
# printed and what the verdict below is based on.
$ActualLogonType = "unknown"
try {
  $ActualLogonType = [string](Get-ScheduledTask -TaskName $TaskName).Principal.LogonType
} catch {
  $ActualLogonType = "unreadable"
}

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        $Publisher  (rebuild -> validate -> release -> commit -> push; self-alerts on failure)"
Write-Host "  Working dir: $ScriptDir"
Write-Host "  Recurrence:  $recur"
Write-Host "  LogonType:   $ActualLogonType  (S4U = runs while logged off; Interactive = does NOT)"
Write-Host "  StartWhenAvailable enabled (catches up if the machine was off)"
Write-Host ""
Write-Host "Run now:         Start-ScheduledTask -TaskName $TaskName"
Write-Host "Cancel schedule: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"

# The verdict, printed last so it is the thing left on screen. Based on what
# Task Scheduler actually reports, not on what was requested.
Write-Host ""
if ($ActualLogonType -eq "S4U") {
  Write-Host "Runs whether you are logged on or not - a logon screen no longer stalls it."
} else {
  Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  Write-Host "!!  WARNING: '$TaskName' is LogonType=$ActualLogonType, NOT S4U."
  Write-Host "!!"
  Write-Host "!!  IT WILL NOT RUN WHILE YOU ARE LOGGED OFF. A Windows Update reboot that"
  Write-Host "!!  lands on a logon screen silently costs every run until the next login -"
  Write-Host "!!  that is the 2026-08-12 incident (9.3 h lost, no alert possible), and it"
  Write-Host "!!  will simply happen again."
  if ($PriorLogonType -eq "S4U") {
  Write-Host "!!"
  Write-Host "!!  THIS RUN JUST DOWNGRADED IT. The task was S4U a moment ago; re-registering"
  Write-Host "!!  it unelevated put it back to $ActualLogonType. Re-run elevated NOW."
  }
  if ($S4UError) {
  Write-Host "!!"
  Write-Host "!!  Reason: $S4UError"
  Write-Host "!!  ('Access is denied' just means this prompt is not elevated - expected.)"
  }
  Write-Host "!!"
  Write-Host "!!  FIX: re-run this registrar from an ELEVATED prompt (Run as administrator):"
  Write-Host "!!    powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  Write-Host "!!  Setting an S4U principal is an administrative operation; there is no"
  Write-Host "!!  unelevated route. Re-running is idempotent and safe."
  Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
}
