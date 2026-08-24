# schedule_parcel_tiles.ps1 - register the Assessment Parcels vector-tile
# rebuild as a recurring Windows Task Scheduler entry that fires on the
# 16th of every month at 03:00 local. Idempotent: re-run to update the
# schedule or after changing the script - the existing task is replaced.
#
# Why the 16th: the tile archive is built from the same RollEntry_*.gpkg as
# the fallback snapshot, and that gpkg is dropped by r/download_parcels.R
# (which the mao-assembly monthly wrapper runs). mb-parcelsearch-monthly-refresh
# fires on the 15th at 04:00; this sits a clear day behind it so a slow
# refresh cannot overlap an hour-long tippecanoe run.
#
# Why monthly when the gpkg only really changes a few times a year: the task
# runs with -IfStale, which compares the newest gpkg against the source
# recorded in the published archive's meta sidecar and exits in about a
# second when they match. Checking monthly costs nothing and means a fresh
# gpkg is never more than a month from reaching production.
#
# It also runs with -Publish. An archive rebuilt and left sitting on disk
# would leave production serving the previous one, which is exactly the
# staleness this schedule exists to prevent. Credentials come from rclone's
# own config, never from this repo; the sanity band and reconcile guard in
# web/scripts/build-parcel-tiles.js are what stand in for a human look, and
# the upload is size-verified against the local build afterwards.
#
# Usage (run once from a PowerShell prompt - see the S4U note at the end):
#   powershell -ExecutionPolicy Bypass -File schedule_parcel_tiles.ps1
#
# To verify / manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-parcel-tiles | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-parcel-tiles              # run immediately
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-parcel-tiles -Confirm:$false
#
# Why schtasks.exe inside PowerShell: New-ScheduledTaskTrigger has no
# "monthly on day N" trigger. Same reasoning as schedule_monthly.ps1.

$ErrorActionPreference = "Stop"
$TaskName  = "mb-parcelsearch-parcel-tiles"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Rebuild   = Join-Path $ScriptDir "rebuild-parcel-tiles.ps1"

if (-not (Test-Path $Rebuild)) {
    Write-Error "Rebuild script not found: $Rebuild"
    exit 1
}

# Fail early rather than at 03:00 on the 16th: without WSL tippecanoe the
# build cannot run at all, and without rclone it cannot publish.
foreach ($dep in @(
    @{ Name = "rclone";     Test = { Get-Command rclone -ErrorAction SilentlyContinue } },
    @{ Name = "WSL";        Test = { Get-Command wsl    -ErrorAction SilentlyContinue } }
)) {
    if (-not (& $dep.Test)) {
        Write-Warning "$($dep.Name) is not on PATH. The scheduled run will fail - see MAINTENANCE.md 1e."
    }
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
    /D 16 `
    /ST 03:00 `
    /TN $TaskName `
    /TR $taskCmd `
    /RL LIMITED `
    /F

if ($LASTEXITCODE -ne 0) {
    Write-Error "schtasks /Create failed (exit code $LASTEXITCODE)"
    exit $LASTEXITCODE
}

# 4 hours, not the monthly refresh's 6: a full run is ~1 hour (12s export,
# a few minutes of streaming, the rest tippecanoe) plus a 363 MB upload.
# Four hours is generous enough for a slow machine and still short enough
# that a hung tippecanoe gets killed rather than blocking next month's run.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4)

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
Write-Host "  Recurrence:  16th of every month at 03:00 local"
Write-Host "               (a clear day behind mb-parcelsearch-monthly-refresh on the 15th)"
Write-Host "  Skips fast:  -IfStale exits in ~1s when the newest RollEntry_*.gpkg"
Write-Host "               already matches the published archive's meta sidecar"
Write-Host "  Publishes:   uploads to R2 and size-verifies, so a rebuild actually"
Write-Host "               reaches production instead of sitting on disk"
Write-Host "  LogonType:   $ActualLogonType  (S4U = runs while logged off; Interactive = does NOT)"
Write-Host "  Time limit:  4 hours"
Write-Host ""
Write-Host "Useful commands (PowerShell):"
Write-Host "  Show details:    Get-ScheduledTask -TaskName $TaskName | Format-List *"
Write-Host "  Run now:         Start-ScheduledTask  -TaskName $TaskName"
Write-Host "  Dry run by hand: powershell -ExecutionPolicy Bypass -File `"$Rebuild`" -IfStale"
Write-Host "  Cancel schedule: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host "  Tail latest log: Get-ChildItem logs\parcel-tiles-*.log |"
Write-Host "                     Sort-Object LastWriteTime -Desc |"
Write-Host "                     Select-Object -First 1 | Get-Content -Wait -Tail 80"

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
