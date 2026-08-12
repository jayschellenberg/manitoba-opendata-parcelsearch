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

$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
Write-Host ''
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host ("  Recurrence : day {0} of every month at {1} local" -f $Day, $Time)
Write-Host ("  Next run   : {0}" -f $info.NextRunTime)
Write-Host '  Runs       : post-refresh-report.ps1 (read-only; never rebuilds or publishes)'
Write-Host '  Sends      : one summary either way - task results, log progress, pin-vs-HEAD consistency'
Write-Host '  Verifies   : the app CDN pin advanced to match mb-parcel-data HEAD (the 2026-08-05 failure)'
Write-Host '  Channels   : email (alert-email.local.txt) + ntfy push (mbps-monthly-refresh-jks)'
Write-Host '  StartWhenAvailable enabled (catches up if the machine was off)'
Write-Host ''
Write-Host 'Preview the report now:  powershell -ExecutionPolicy Bypass -File post-refresh-report.ps1 -Console'
Write-Host "Cancel:                  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
