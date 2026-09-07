# schedule_du_snapshot.ps1 -- register du-snapshot-wrapper.ps1 as a MONTHLY
# Windows Task Scheduler entry (14th, 03:40 local).
#
# WHY MONTHLY. MAO publishes dwelling_units as a CURRENT scalar: there is no DU
# column in the tax history and no archived DU anywhere, so nothing before the
# baseline taken on 2026-09-07 can ever be reconstructed. That is what makes
# the series worth keeping at all.
#
# What a MISSED run costs is resolution, not the observation. The next run
# diffs the current state against the REPLAYED state, so a skipped month still
# records the change -- dated to the month it was finally seen, with any
# intermediate states collapsed (a roll that went 4 -> 12 -> 6 between two
# snapshots records as 4 -> 6). Worth avoiding, not worth paging anyone over.
#
# Monthly rather than semi-annual because municipalities re-scrape on a rolling
# 6-month cadence (annual in the North), so a monthly stamp dates each change to
# the month its municipality came round instead of smearing a whole half-year
# into one delta. It is cheap either way: the R script writes nothing at all
# when nothing changed, so quiet months add no files.
#
# The 14th at 03:40 sits deliberately ahead of mb-parcelsearch-monthly-refresh
# (15th, 04:00) and clear of the 03:00 basemap/parcel-tiles pair, so the
# snapshot reads a settled parcels.parquet rather than one being rewritten
# beneath it. parcels.parquet is written temp-then-rename by
# assemble_parquet.R, so a read can never tear -- the spacing is about reading
# a COMPLETE cycle, not about safety.
#
# Idempotent -- re-run to update; the existing task is replaced.
#
# Usage (normal user privileges to register; ELEVATED to get S4U -- see below):
#   powershell -ExecutionPolicy Bypass -File schedule_du_snapshot.ps1
#
# Manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-du-snapshot | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-du-snapshot                      # run now
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-du-snapshot -Confirm:$false  # cancel

$ErrorActionPreference = "Continue"   # schtasks writes 'task not found' to stderr; don't let it throw
$TaskName  = "mb-parcelsearch-du-snapshot"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Wrapper   = Join-Path $ScriptDir "du-snapshot-wrapper.ps1"

if (-not (Test-Path $Wrapper)) { Write-Error "Wrapper not found: $Wrapper"; exit 1 }

# Capture the logon type BEFORE the teardown below, so the verdict at the end
# can tell "never was S4U" from "this run just DOWNGRADED a working S4U task".
# The second is the drift trap this block exists for and is far more urgent;
# without this, both look identical. Missing task -> empty string.
$PriorLogonType = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).Principal.LogonType

$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task '$TaskName' found - replacing it."
    schtasks /Delete /TN $TaskName /F | Out-Null
}

$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Wrapper`""

#   /SC MONTHLY  - recur every month
#   /D 14        - on the 14th
#   /ST 03:40    - at 03:40 local
schtasks /Create `
    /SC MONTHLY `
    /D 14 `
    /ST 03:40 `
    /TN $TaskName `
    /TR $taskCmd `
    /RL LIMITED `
    /F | Out-Null

if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /Create failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }

# Battery + catch-up flags (schtasks doesn't expose these). StartWhenAvailable
# matters here because a machine that was off on the 14th should still take a
# snapshot when it next wakes rather than coarsening that month's dating.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

# ---- own the task PRINCIPAL, don't leave it Interactive ---------------------
# schtasks.exe (above) can only ever create an INTERACTIVE task, which does not
# run unless Jason is logged on. A Windows Update reboot at 01:31 on 2026-08-12
# left the machine at the logon screen and cost 9.3 h: every task was
# Interactive, so even the watchdogs were down and nothing could report the
# outage. All tasks were converted to S4U ("run whether the user is logged on
# or not", no stored password) that day.
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
# Interactive to read a DPAPI blob an S4U token cannot unlock - see their
# headers. This task reads only a parquet on disk, so S4U is correct for it.
#
# Set-ScheduledTask -Principal requires ELEVATION; unelevated it throws
# "Access is denied." That is caught rather than fatal - the task is already
# registered above and stays usable - but it is reported loudly, because an
# Interactive task nobody noticed is the entire failure mode described above.
$S4UError = $null
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U -RunLevel Limited
try {
    Set-ScheduledTask -TaskName $TaskName -Principal $principal -ErrorAction Stop | Out-Null
} catch {
    # Swallowed on purpose. Access-denied from an unelevated prompt is the
    # EXPECTED path and must not fail the registration. The read-back below is
    # the real verdict, and the block at the end is where it is reported.
    $S4UError = ([string]$_.Exception.Message).Trim()
}

# Ask Windows what it actually stored - do not assert it. This read-back is the
# line that would have caught the original drift, so it is what gets printed
# and what the verdict below is based on.
$ActualLogonType = "unknown"
try {
    $ActualLogonType = [string](Get-ScheduledTask -TaskName $TaskName).Principal.LogonType
} catch {
    $ActualLogonType = "unreadable"
}

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        du-snapshot-wrapper.ps1 monthly on the 14th at 03:40 local"
Write-Host "  Does:        stamps every roll's CURRENT dwelling-unit count into"
Write-Host "               mb-parcel-history/du-snapshots as a delta against the replayed state"
Write-Host "  Writes:      nothing at all in a month where no unit count moved"
Write-Host "  Refuses:     exit 2 if >5% of known rolls lose their units at once"
Write-Host "               (a truncated parcels.parquet, not demolition) - needs a human"
Write-Host "  Logs:        logs\du-snapshot-<stamp>.log, pruned after 400 days"
Write-Host "  LogonType:   $ActualLogonType  (S4U = runs while logged off; Interactive = does NOT)"
Write-Host "  StartWhenAvailable enabled (catches up if the machine was off)"
Write-Host ""
Write-Host "Dry-run the decision:  powershell -ExecutionPolicy Bypass -File du-snapshot-wrapper.ps1 -DryRun"
Write-Host "Inspect the state:     Rscript r\snapshot_dwelling_units.R --replay"
Write-Host "Cancel:                Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host ""
Write-Host "NOTE: MAO publishes no DU history, so nothing before the 2026-09-07 baseline"
Write-Host "      can ever be reconstructed. A missed run costs resolution, not the"
Write-Host "      observation - the next run still records the change, dated later."
Write-Host "      Overdue coverage comes from mb-parcelsearch-task-health, which reads"
Write-Host "      this task's monthly trigger and flags it after 62 days."

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
    Write-Host "!!  that is the 2026-08-12 incident (9.3 h lost, no alert possible)."
    Write-Host "!!"
    Write-Host "!!  For THIS task the cost is a coarser record: the next run still catches"
    Write-Host "!!  the change, but dates it to whenever the task finally fired and loses"
    Write-Host "!!  any intermediate unit counts along the way."
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
