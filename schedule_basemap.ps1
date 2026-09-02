# schedule_basemap.ps1 - register the Protomaps streets-basemap refresh as a
# recurring Windows Task Scheduler entry that fires twice a year, on the 2nd
# of January and July at 03:00 local. Idempotent: re-run to update the
# schedule or after changing the script - the existing task is replaced.
#
# Why Jan 2 / Jul 2: the semiannual snapshot publish owns Jan 1 / Jul 1 at
# 04:30 and is the heavyweight; this is a 5-30 minute job (a 1 GB range-request
# extract plus two uploads) and sits a clear day behind it so the two never
# overlap and a failure in one is never mistaken for the other.
#
# Why twice a year: OpenStreetMap road data for Manitoba changes slowly and
# the map is supporting context under the parcel fabric, not the subject of
# it. -IfStale makes the run a no-op when the published sidecar already
# records the newest daily build, so a manual mid-cycle refresh is never
# undone or repeated.
#
# It runs with -Publish. An archive re-cut and left on disk would leave both
# apps serving the previous one, which is the staleness this schedule exists
# to prevent. The schema gate, size band, pmtiles verify and the staged
# upload-then-swap in rebuild-basemap.ps1 stand in for a human look;
# credentials come from rclone's own config, never from this repo.
#
# Usage (run once from a PowerShell prompt - see the S4U note at the end):
#   powershell -ExecutionPolicy Bypass -File schedule_basemap.ps1
#
# To verify / manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-basemap-refresh | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-basemap-refresh              # run immediately
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-basemap-refresh -Confirm:$false
#
# Why schtasks.exe inside PowerShell: New-ScheduledTaskTrigger has no
# "monthly on day N of months X,Y" trigger. Same reasoning as
# schedule_semiannual.ps1.

$ErrorActionPreference = "Stop"
$TaskName  = "mb-parcelsearch-basemap-refresh"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Rebuild   = Join-Path $ScriptDir "rebuild-basemap.ps1"

if (-not (Test-Path $Rebuild)) {
    Write-Error "Rebuild script not found: $Rebuild"
    exit 1
}

# Fail early rather than at 03:00 on Jan 2: without rclone it cannot publish.
# (The pmtiles CLI self-installs, pinned by hash, so it is not checked here.)
if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    Write-Warning "rclone is not on PATH. The scheduled run will fail at the publish step - see MAINTENANCE.md 7b."
}

# Capture the logon type BEFORE the teardown, so the verdict at the end can
# tell "never was S4U" from "this run just DOWNGRADED a working S4U task".
$PriorLogonType = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).Principal.LogonType

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Existing task '$TaskName' found - replacing it."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Rebuild`" -IfStale -Publish"

$result = schtasks /Create `
    /SC MONTHLY `
    /M JAN,JUL `
    /D 2 `
    /ST 03:00 `
    /TN $TaskName `
    /TR $taskCmd `
    /RL LIMITED `
    /F

if ($LASTEXITCODE -ne 0) {
    Write-Error "schtasks /Create failed (exit code $LASTEXITCODE)"
    exit $LASTEXITCODE
}

# 2 hours: the first run took 31 min (4 min extract, 3 min per upload, and a
# 20 min server-side swap on wpg-ortho). Generous for a slow link on the 1 GB
# extract + two 1 GB uploads, short enough that a hung transfer is killed
# rather than lingering into the day's watchdog runs.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

# ---- own the task PRINCIPAL, don't leave it Interactive --------------------
# schtasks.exe can only create an INTERACTIVE task, which does not run unless
# Jason is logged on. A Windows Update reboot at 01:31 on 2026-08-12 left the
# machine at the logon screen and cost 9.3 h because every task was
# Interactive - even the watchdogs. See schedule_monthly.ps1 for the full
# account; this block is deliberately the same, pasted rather than factored
# out, because these registrars are the bootstrap layer and are standalone on
# purpose.
#
# This one fires at 03:00 twice a YEAR; a missed occurrence waits six months.
#
# Set-ScheduledTask -Principal requires ELEVATION; unelevated it throws
# "Access is denied." That is caught rather than fatal - the task is already
# registered above and stays usable - but it is reported loudly.
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
Write-Host "  Runs:        $Rebuild -IfStale -Publish"
Write-Host "  Working dir: $ScriptDir"
Write-Host "  Recurrence:  2nd of January and July at 03:00 local (every 6 months)"
Write-Host "               (a clear day behind mb-parcelsearch-semiannual-archive on the 1st)"
Write-Host "  Skips fast:  -IfStale exits when the published sidecar already records"
Write-Host "               the newest Protomaps daily build"
Write-Host "  Publishes:   staged upload + swap on BOTH buckets (mb-ortho, wpg-ortho),"
Write-Host "               size-verified and range-probed on the public URL"
Write-Host "  Refuses:     any build whose tileset major != the deployed style's"
Write-Host "  LogonType:   $ActualLogonType  (S4U = runs while logged off; Interactive = does NOT)"
Write-Host "  Time limit:  2 hours"
Write-Host ""
Write-Host "Useful commands (PowerShell):"
Write-Host "  Show details:    Get-ScheduledTask -TaskName $TaskName | Format-List *"
Write-Host "  Run now:         Start-ScheduledTask  -TaskName $TaskName"
Write-Host "  Dry run by hand: powershell -ExecutionPolicy Bypass -File `"$Rebuild`"   (no -Publish)"
Write-Host "  Test alerts:     powershell -ExecutionPolicy Bypass -File `"$Rebuild`" -TestAlert"
Write-Host "  Cancel schedule: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host "  Dead-man check:  schedule_basemap_check.ps1 registers the daily staleness watchdog"

Write-Host ""
if ($ActualLogonType -eq "S4U") {
    Write-Host "Runs whether you are logged on or not - a logon screen no longer stalls it."
} else {
    Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    Write-Host "!!  WARNING: '$TaskName' is LogonType=$ActualLogonType, NOT S4U."
    Write-Host "!!"
    Write-Host "!!  IT WILL NOT RUN WHILE YOU ARE LOGGED OFF - and this task fires at 03:00,"
    Write-Host "!!  so that is the normal case, not the exception. See the 2026-08-12"
    Write-Host "!!  incident in schedule_monthly.ps1 (9.3 h lost, no alert possible)."
    Write-Host "!!  This task only gets two chances a year (Jan 2 / Jul 2)."
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
    Write-Host "!!  Re-running is idempotent and safe."
    Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
}
