# schedule_semiannual.ps1 - register the permanent snapshot PUBLISH pipeline as
# a recurring Windows Task Scheduler entry that fires twice a year, on the 1st
# of January and July at 04:30 local. The task runs
# semiannual-publish-wrapper.ps1, which does the whole flow end to end:
# download the provincial roll / zoning / dev-plan layers fresh from the ArcGIS
# FeatureServer, archive them (r/archive_snapshot.R), build historical shards +
# lineage, push the mb-parcel-history data repo, repoint the app's HISTORICAL_CDN
# pin, and push the app so Vercel redeploys. It alerts on any failure.
# Idempotent: re-run to update the schedule - the existing task is replaced.
#
# (The older semiannual-archive-wrapper.ps1 - archive-only, no download/publish -
# is kept for manual archive-only use; this schedule now targets the full
# publish wrapper.)
#
# Usage (run once from a PowerShell prompt with normal user privileges):
#   powershell -ExecutionPolicy Bypass -File schedule_semiannual.ps1
#
# To verify / manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-semiannual-archive | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-semiannual-archive               # run immediately
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-semiannual-archive -Confirm:$false   # cancel
#
# Why schtasks.exe inside PowerShell: New-ScheduledTaskTrigger has no
# "monthly on day N of months X,Y" trigger; schtasks /SC MONTHLY /M JAN,JUL
# /D 1 is the simplest cross-version way to get a twice-a-year schedule.

$ErrorActionPreference = "Stop"
$TaskName  = "mb-parcelsearch-semiannual-archive"
$LegacyTaskNames = @("MAOSemiannualArchive")
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Wrapper   = Join-Path $ScriptDir "semiannual-publish-wrapper.ps1"

if (-not (Test-Path $Wrapper)) {
    Write-Error "Archive wrapper not found: $Wrapper"
    exit 1
}

# Capture the logon type BEFORE the teardown below, so the verdict at the end
# can tell "never was S4U" from "this run just DOWNGRADED a working S4U task".
# The second is the drift trap this whole block exists for and is far more
# urgent; without this, both look identical. Missing task -> empty string.
$PriorLogonType = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).Principal.LogonType

# Replace any existing task with the same name, plus the legacy pre-rename task.
foreach ($name in @($TaskName) + $LegacyTaskNames) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $existing) { continue }
    Write-Host "Existing task '$name' found - replacing it."
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
}

# Create the recurring twice-a-year trigger.
#   /SC MONTHLY      - month-based schedule
#   /M JAN,JUL       - only in January and July (i.e. every 6 months)
#   /D 1             - on the 1st
#   /ST 04:30        - at 04:30 local (after the monthly refresh's 04:00 slot)
#   /TR "<cmd>"      - task command: the PowerShell wrapper
#   /RL LIMITED      - run as the current user with normal privileges
#   /F               - force overwrite if a task exists
$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Wrapper`""

$result = schtasks /Create `
    /SC MONTHLY `
    /M JAN,JUL `
    /D 1 `
    /ST 04:30 `
    /TN $TaskName `
    /TR $taskCmd `
    /RL LIMITED `
    /F

if ($LASTEXITCODE -ne 0) {
    Write-Error "schtasks /Create failed (exit code $LASTEXITCODE)"
    exit $LASTEXITCODE
}

# Apply battery + start-when-available flags via the PowerShell Scheduled
# Tasks module - schtasks doesn't expose these directly.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4)

Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

# ---- 2026-08-12: own the task PRINCIPAL, don't leave it Interactive ---------
# schtasks.exe (above) can only ever create an INTERACTIVE task, which does not
# run unless Jason is logged on. A Windows Update reboot at 01:31 on 2026-08-12
# left the machine at the logon screen and cost 9.3 h: every task was
# Interactive, so even the watchdogs were down and nothing could report the
# outage. All 14 tasks were converted to S4U ("run whether the user is logged on
# or not", no stored password) that day.
#
# This one matters more than most: it fires twice a YEAR, at 04:30 on Jan 1 and
# Jul 1 - hours when the machine is most likely sitting logged off. A missed
# occurrence is not retried until the next half-year.
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
Write-Host "  Wrapper:     $Wrapper  (download -> archive -> shards+lineage -> push data -> repoint app -> redeploy)"
Write-Host "  Working dir: $ScriptDir"
Write-Host "  Recurrence:  1st of January and July at 04:30 local (every 6 months)"
Write-Host "  LogonType:   $ActualLogonType  (S4U = runs while logged off; Interactive = does NOT)"
Write-Host "  StartWhenAvailable enabled (catches up if machine was off)"
Write-Host ""
Write-Host "Useful commands (PowerShell):"
Write-Host "  Show details:    Get-ScheduledTask -TaskName $TaskName | Format-List *"
Write-Host "  Run now:         Start-ScheduledTask  -TaskName $TaskName"
Write-Host "  Cancel schedule: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host "  Test alerts:     powershell -ExecutionPolicy Bypass -File semiannual-publish-wrapper.ps1 -TestAlert"
Write-Host "  Dead-man check:  schedule_history_check.ps1 registers the daily staleness watchdog"

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
    Write-Host "!!  This task only gets two chances a year (Jan 1 / Jul 1); a missed one waits"
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
