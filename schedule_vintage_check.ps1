# schedule_vintage_check.ps1 -- register upstream-vintage-check.ps1 as a WEEKLY
# Windows Task Scheduler entry (Mondays 09:30, after the daily watchdogs).
#
# Weekly rather than daily because this one makes ~12 outbound requests plus an
# org service listing per run, and the thing it watches -- the province
# publishing a new vintage of a layer -- moves on a scale of months or years.
# A dedupe stamp still holds it to at most ONE reminder per calendar month.
#
# What it catches that nothing else did: a live provincial service being
# superseded by a later year-stamped sibling, or retired outright. Every other
# freshness check in this project watches data we generate; "live" ArcGIS layers
# looked self-maintaining and weren't. The app read MHTIS_Traffic_Flow_2019 for
# years while a 2023 layer sat published beside it -- no error, no gap, just
# stale traffic counts feeding appraisal work.
#
# Idempotent -- re-run to update; the existing task is replaced.
#
# Usage (normal user privileges, no admin needed):
#   powershell -ExecutionPolicy Bypass -File schedule_vintage_check.ps1
#
# Manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-upstream-vintage | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-upstream-vintage                      # run now
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-upstream-vintage -Confirm:$false  # cancel

$ErrorActionPreference = "Continue"   # schtasks writes 'task not found' to stderr; don't let it throw
$TaskName  = "mb-parcelsearch-upstream-vintage"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Checker   = Join-Path $ScriptDir "upstream-vintage-check.ps1"

if (-not (Test-Path $Checker)) { Write-Error "Checker not found: $Checker"; exit 1 }

# Capture the logon type BEFORE the teardown below, so the verdict at the end
# can tell "never was S4U" from "this run just DOWNGRADED a working S4U task".
# The second is the drift trap this whole block exists for and is far more
# urgent; without this, both look identical. Missing task -> empty string.
$PriorLogonType = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).Principal.LogonType

$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task '$TaskName' found - replacing it."
    schtasks /Delete /TN $TaskName /F | Out-Null
}

$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Checker`""

schtasks /Create `
    /SC WEEKLY `
    /D MON `
    /ST 09:30 `
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
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

# ---- 2026-08-12: own the task PRINCIPAL, don't leave it Interactive ---------
# schtasks.exe (above) can only ever create an INTERACTIVE task, which does not
# run unless Jason is logged on. A Windows Update reboot at 01:31 on 2026-08-12
# left the machine at the logon screen and cost 9.3 h: every task was
# Interactive, so even the watchdogs were down and nothing could report the
# outage. All 14 tasks were converted to S4U ("run whether the user is logged on
# or not", no stored password) that day.
#
# Weekly cadence makes this one easy to lose quietly: a single missed Monday is
# invisible, and the dedupe stamp already holds it to one reminder a month, so
# an Interactive-and-never-running version of this task looks exactly like a
# healthy one with nothing to report.
#
# That conversion was manual, so without this block re-running this registrar
# for any unrelated reason silently reverts the task to Interactive and quietly
# re-opens the gap. The principal is the registrar's business now.
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
Write-Host "  Runs:        upstream-vintage-check.ps1 weekly, Mondays 09:30 local"
Write-Host "  Reminds:     once per month, only when a live provincial service is"
Write-Host "               superseded by a later vintage, unreachable, or has had no"
Write-Host "               upstream edit in over 730 days"
Write-Host "  Channels:    email (alert-email.local.txt) + ntfy push (mbps-upstream-vintage-jks)"
Write-Host "  LogonType:   $ActualLogonType  (S4U = runs while logged off; Interactive = does NOT)"
Write-Host "  StartWhenAvailable enabled (catches up if the machine was off)"
Write-Host ""
Write-Host "Subscribe to the ntfy topic 'mbps-upstream-vintage-jks' in the ntfy app to get pushes."
Write-Host ""
Write-Host "See the current table:  powershell -ExecutionPolicy Bypass -File upstream-vintage-check.ps1 -Report"
Write-Host "Dry-run the decision:   powershell -ExecutionPolicy Bypass -File upstream-vintage-check.ps1 -DryRun"
Write-Host "Test the alert path:    powershell -ExecutionPolicy Bypass -File upstream-vintage-check.ps1 -TestAlert"
Write-Host "Cancel:                 Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"

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
    Write-Host "!!"
    Write-Host "!!  A watchdog that cannot run cannot tell you it did not run."
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
