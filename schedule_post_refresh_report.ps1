# schedule_post_refresh_report.ps1 -- register post-refresh-report.ps1 to run
# on the 15th of every month at 08:00, the morning of each monthly refresh.
#
# 08:00 on the 15th is chosen to trail the two tasks it reports on:
# mb-parcelsearch-monthly-refresh (15th, 04:00) and
# mb-parcelsearch-publish-indexes (15th, 04:30). That leaves ~4h, which
# comfortably covers the refresh's long pole (step 1 is the mao-scrape delta,
# ~10-30 min) plus the index publish.
#
# 2026-08-12: CHANGED FROM ONE-SHOT TO MONTHLY.
#   This was originally registered -Once for 2026-08-15 08:00 as a first-run
#   confidence check -- the first date on which the refresh and publish tasks
#   would ever have fired (both still read LastTaskResult 267011 "has not yet
#   run"; every refresh in this project's history was manual).
#
#   The reason it must NOT stay a one-shot: post-refresh-report.ps1's PUBLISHED
#   STATE block is the ONLY automated check anywhere that the app's CDN pin
#   (MB_PARCEL_DATA_REVISION in web\src\arcgis.js) actually advanced to match
#   mb-parcel-data HEAD. That is precisely the 2026-08-05 failure: a green
#   refresh had rebuilt 187 assessment shards and, with the pin left behind, the
#   app kept serving the old ones -- no error anywhere, because every other
#   monitor watches whether a STEP failed, not whether the result became
#   reachable. A one-shot would have run that check exactly once, on 08-15, and
#   never again; every monthly refresh after that would have been back to
#   unwatched. Monthly on the 15th puts the check on the same cadence as the
#   thing it verifies.
#
#   The script itself needed no change: it is read-only, idempotent, and already
#   reports either way (OK... / CHECK...), so a steady-state monthly run is a
#   supported mode, not a repurposing.
#
# Now built with schtasks /SC MONTHLY /D <day> /ST <HH:mm>, the same way
# schedule_monthly.ps1 builds the 04:00 refresh it reports on. The earlier
# -Once form used Register-ScheduledTask specifically to dodge schtasks /SD,
# which parses a whole DATE in the machine's locale format -- a real foot-gun
# for a one-off. That reason evaporates with the recurrence: /D takes a bare day
# NUMBER and /ST a 24-hour clock time, neither of which is locale-sensitive, and
# New-ScheduledTaskTrigger still has no "monthly on day N" form (see the note in
# schedule_monthly.ps1). So the two 15th-of-the-month registrars now agree.
#
# -At keeps its override role and gets more useful, not less: the DAY-OF-MONTH
# and the TIME are both read off it, so -At '2026-09-20 07:30' means "the 20th
# of every month at 07:30". The rest of the date is ignored -- there is no start
# boundary to set -- so a -At in the past is no longer an error.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File schedule_post_refresh_report.ps1
#   powershell -ExecutionPolicy Bypass -File schedule_post_refresh_report.ps1 -At '2026-09-20 07:30'
#
# Manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-post-refresh-report | Format-List *
#   Start-ScheduledTask -TaskName mb-parcelsearch-post-refresh-report              # run now
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-post-refresh-report -Confirm:$false

param(
  # Day-of-month + time-of-day for the recurrence. The date part beyond the day
  # number is not a start boundary; it only supplies the day and the clock time.
  [datetime]$At = [datetime]'2026-08-15 08:00'
)

$ErrorActionPreference = 'Stop'
$TaskName  = 'mb-parcelsearch-post-refresh-report'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Reporter  = Join-Path $ScriptDir 'post-refresh-report.ps1'

if (-not (Test-Path $Reporter)) { Write-Error "Reporter not found: $Reporter"; exit 1 }

$Day  = $At.Day
$Time = $At.ToString('HH:mm')
# Days 29-31 do not exist in every month, so a monthly trigger on one of them
# silently skips those months. Refuse rather than register a schedule with
# holes in it -- a report that quietly does not run in February is the exact
# shape of problem this whole task is here to catch.
if ($Day -gt 28) {
  Write-Error "-At day $Day is not present in every month; pick day 1-28 (default 15)."
  exit 1
}

# Capture the logon type BEFORE the teardown below, so the verdict at the end
# can tell "never was S4U" from "this run just DOWNGRADED a working S4U task".
# The second is the drift trap this whole block exists for and is far more
# urgent; without this, both look identical. Missing task -> empty string.
$PriorLogonType = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).Principal.LogonType

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Existing task '$TaskName' found - replacing it."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# /SC MONTHLY /D <day> - recur on that day number every month
# /ST HH:mm            - 24-hour local time
# /RL LIMITED          - current user, normal privileges (nothing here needs more)
# /F                   - overwrite if it somehow still exists
$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Reporter`""

schtasks /Create `
  /SC MONTHLY `
  /D $Day `
  /ST $Time `
  /TN $TaskName `
  /TR $taskCmd `
  /RL LIMITED `
  /F | Out-Null

if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /Create failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }

# Battery + catch-up flags (schtasks doesn't expose these). StartWhenAvailable
# still matters: a monthly occurrence the machine sleeps through would otherwise
# wait a full month for the next one, by which time the refresh it was meant to
# report on is long past and the pin-vs-HEAD check has missed its cycle.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

# ---- 2026-08-12: own the task PRINCIPAL, don't leave it Interactive ---------
# schtasks.exe (above) can only ever create an INTERACTIVE task, which does not
# run unless Jason is logged on. A Windows Update reboot at 01:31 on 2026-08-12
# left the machine at the logon screen and cost 9.3 h: every task was
# Interactive, so even the watchdogs were down and nothing could report the
# outage. All 14 tasks were converted to S4U ("run whether the user is logged on
# or not", no stored password) that day.
#
# Note what an Interactive version of THIS task would do to the note above about
# it being the only automated pin-vs-HEAD check: a monthly report that silently
# does not run is indistinguishable from one that ran and found nothing wrong.
# It would go on being the only check, while checking nothing.
#
# That conversion was manual, so without this block re-running this registrar
# for any unrelated reason - notably an -At change - silently reverts the task
# to Interactive and quietly re-opens the gap. The principal is the registrar's
# business now.
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
Write-Host ''
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host ("  Recurrence : day {0} of every month at {1} local" -f $Day, $Time)
Write-Host ("  Next run   : {0}" -f $info.NextRunTime)
Write-Host ("  LogonType  : {0}  (S4U = runs while logged off; Interactive = does NOT)" -f $ActualLogonType)
Write-Host '  Runs       : post-refresh-report.ps1 (read-only; never rebuilds or publishes)'
Write-Host '  Sends      : one summary either way - task results, log progress, pin-vs-HEAD consistency'
Write-Host '  Verifies   : the app CDN pin advanced to match mb-parcel-data HEAD (the 2026-08-05 failure)'
Write-Host '  Channels   : email (alert-email.local.txt) + ntfy push (mbps-monthly-refresh-jks)'
Write-Host '  StartWhenAvailable enabled (catches up if the machine was off)'
Write-Host ''
Write-Host 'Preview the report now:  powershell -ExecutionPolicy Bypass -File post-refresh-report.ps1 -Console'
Write-Host "Cancel:                  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"

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
  Write-Host "!!  This is the only automated pin-vs-HEAD check anywhere."
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
