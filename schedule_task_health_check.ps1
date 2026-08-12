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

# ---- 2026-08-12: own the task PRINCIPAL, don't leave it Interactive ---------
# schtasks.exe (above) can only ever create an INTERACTIVE task, which does not
# run unless Jason is logged on. A Windows Update reboot at 01:31 on 2026-08-12
# left the machine at the logon screen and cost 9.3 h: every task was
# Interactive, so even the watchdogs were down and nothing could report the
# outage. All 14 tasks were converted to S4U ("run whether the user is logged on
# or not", no stored password) that day.
#
# This is the task that reads everyone else's LastTaskResult, which makes an
# Interactive one a special kind of bad: the reader for all fifteen tasks would
# be off during exactly the logged-off window in which they all silently did not
# run, and its silence would be read as "nothing to report". Note the header's
# admission that this task cannot report on itself - the principal is therefore
# the one property of it that has to be right by construction.
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

$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        task-health-check.ps1 daily at 09:40 local"
Write-Host ("  Next run:    {0}" -f $info.NextRunTime)
Write-Host ("  LogonType:   {0}  (S4U = runs while logged off; Interactive = does NOT)" -f $ActualLogonType)
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
    Write-Host "!!  This is the task that reads every OTHER task's result."
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
