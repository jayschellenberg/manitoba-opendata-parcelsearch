# schedule_traffic_check.ps1 -- register traffic-refresh-check.ps1 as a MONTHLY
# Windows Task Scheduler entry (16th, 05:30 local).
#
# Timing: the day AFTER the 15th, so it never contends with
# mb-parcelsearch-monthly-refresh (15th 04:00) or mb-parcelsearch-publish-indexes
# (15th 04:30) for the repo's git index or the working tree. This job commits
# and pushes on its own, and two unattended jobs staging in the same clone at
# once is a merge conflict nobody is awake to resolve.
#
# Monthly is the right cadence even though MHTIS publishes roughly yearly: the
# check is cheap (two HTTP requests when there is nothing new) and the cost of
# missing a new report is months of an appraisal tool quietly serving last
# year's traffic counts.
#
# Idempotent -- re-run to update; the existing task is replaced.
#
# Usage (normal user privileges, no admin needed):
#   powershell -ExecutionPolicy Bypass -File schedule_traffic_check.ps1
#
# Manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-traffic-refresh | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-traffic-refresh                      # run now
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-traffic-refresh -Confirm:$false  # cancel
#
# Verify without waiting a month:
#   powershell -ExecutionPolicy Bypass -File traffic-refresh-check.ps1 -DryRun

$ErrorActionPreference = "Continue"   # schtasks writes 'task not found' to stderr; don't let it throw
$TaskName  = "mb-parcelsearch-traffic-refresh"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Checker   = Join-Path $ScriptDir "traffic-refresh-check.ps1"

if (-not (Test-Path $Checker)) { Write-Error "Checker not found: $Checker"; exit 1 }

$PriorLogonType = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).Principal.LogonType

$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task '$TaskName' found - replacing it."
    schtasks /Delete /TN $TaskName /F | Out-Null
}

$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Checker`""

schtasks /Create `
    /SC MONTHLY `
    /D 16 `
    /ST 05:30 `
    /TN $TaskName `
    /TR $taskCmd `
    /RL LIMITED `
    /F | Out-Null

if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /Create failed (exit $LASTEXITCODE)"; exit 1 }

# Battery + catch-up flags (schtasks doesn't expose these). StartWhenAvailable
# matters more here than on the daily watchdogs: a MONTHLY task that misses its
# trigger because the machine was off waits a full month for the next one.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)   # a cold rebuild downloads ~35 MB per new report and parses 15 PDFs
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

# ---- own the task PRINCIPAL, don't leave it Interactive ---------------------
# schtasks.exe (above) can only ever create an INTERACTIVE task, which does not
# run unless Jason is logged on. That cost 9.3 h on 2026-08-12 when a Windows
# Update reboot left the machine at the logon screen: every task was
# Interactive, so even the watchdogs were down and nothing could report it.
# All 14 tasks were converted to S4U, and every registrar here now re-asserts
# that itself -- otherwise re-running one for an unrelated reason silently
# reverts its task to Interactive and quietly re-opens the gap.
#
# Set-ScheduledTask -Principal requires ELEVATION; unelevated it throws
# "Access is denied." That is caught rather than fatal -- the task is already
# registered above and stays usable -- but it is reported loudly below,
# because an Interactive task nobody noticed is the whole failure mode.
$S4UError = $null
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U -RunLevel Limited
try {
    Set-ScheduledTask -TaskName $TaskName -Principal $principal -ErrorAction Stop | Out-Null
} catch {
    $S4UError = ([string]$_.Exception.Message).Trim()
}

# Ask Windows what it actually stored - do not assert it.
$ActualLogonType = "unknown"
try {
    $ActualLogonType = [string](Get-ScheduledTask -TaskName $TaskName).Principal.LogonType
} catch {
    $ActualLogonType = "unreadable"
}

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        traffic-refresh-check.ps1 monthly on the 16th at 05:30 local"
Write-Host "  Does:        new MHTIS annual report -> rebuild + manifest + commit + push"
Write-Host "               new AADT_<year> column  -> alert only (needs a code change)"
Write-Host "               nothing new             -> quiet exit"
Write-Host "  Channels:    email (alert-email.local.txt) + ntfy push (mbps-traffic-refresh-jks)"
Write-Host "  LogonType:   $ActualLogonType  (S4U = runs while logged off; Interactive = does NOT)"
Write-Host "  StartWhenAvailable enabled (catches up if the machine was off on the 16th)"
Write-Host ""
Write-Host "Test the alert path now:  powershell -ExecutionPolicy Bypass -File traffic-refresh-check.ps1 -TestAlert"
Write-Host "Dry-run the decision:     powershell -ExecutionPolicy Bypass -File traffic-refresh-check.ps1 -DryRun"
Write-Host "Cancel:                   Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"

Write-Host ""
if ($ActualLogonType -eq "S4U") {
    Write-Host "Runs whether you are logged on or not - a logon screen no longer stalls it."
} else {
    Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    Write-Host "!!  WARNING: '$TaskName' is LogonType=$ActualLogonType, NOT S4U."
    Write-Host "!!"
    Write-Host "!!  IT WILL NOT RUN WHILE YOU ARE LOGGED OFF. On a monthly trigger that"
    Write-Host "!!  costs a whole month per miss, and the traffic data quietly keeps"
    Write-Host "!!  looking authoritative the entire time."
    if ($PriorLogonType -eq "S4U") {
    Write-Host "!!"
    Write-Host "!!  THIS RUN JUST DOWNGRADED IT. The task was S4U a moment ago; re-registering"
    Write-Host "!!  it unelevated put it back to $ActualLogonType. Re-run elevated NOW."
    }
    if ($S4UError) {
    Write-Host "!!"
    Write-Host "!!  Set-ScheduledTask -Principal said: $S4UError"
    }
    Write-Host "!!"
    Write-Host "!!  FIX: re-run this script from an ELEVATED PowerShell (Run as administrator)."
    Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
}
