# schedule_basemap_check.ps1 -- register basemap-staleness-check.ps1 as a DAILY
# Windows Task Scheduler entry (09:15 local). Daily is intentional: the check
# is two anonymous HTTPS GETs, its dedupe stamp means at most ONE reminder a
# month, and a daily cadence catches a stale basemap even if the machine was
# off on any given day. This is the dead-man's switch for
# mb-parcelsearch-basemap-refresh (Jan 2 / Jul 2): that task alerts when a
# STEP fails, but only this external check can notice that the refresh never
# started at all -- and it notices by reading what production serves.
# Idempotent -- re-run to update; the existing task is replaced.
#
# Usage (run once from a PowerShell prompt - see the S4U note at the end):
#   powershell -ExecutionPolicy Bypass -File schedule_basemap_check.ps1
#
# Manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-basemap-staleness | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-basemap-staleness                      # run now
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-basemap-staleness -Confirm:$false  # cancel

$ErrorActionPreference = "Continue"   # schtasks writes 'task not found' to stderr; don't let it throw
$TaskName  = "mb-parcelsearch-basemap-staleness"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Checker   = Join-Path $ScriptDir "basemap-staleness-check.ps1"

if (-not (Test-Path $Checker)) { Write-Error "Checker not found: $Checker"; exit 1 }

# Capture the logon type BEFORE the teardown below, so the verdict at the end
# can tell "never was S4U" from "this run just DOWNGRADED a working S4U task".
$PriorLogonType = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).Principal.LogonType

$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task '$TaskName' found - replacing it."
    schtasks /Delete /TN $TaskName /F | Out-Null
}

$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Checker`""

schtasks /Create `
    /SC DAILY `
    /ST 09:15 `
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
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

# ---- own the task PRINCIPAL, don't leave it Interactive --------------------
# schtasks.exe (above) can only ever create an INTERACTIVE task, which does not
# run unless Jason is logged on. A Windows Update reboot at 01:31 on 2026-08-12
# left the machine at the logon screen and cost 9.3 h: every task was
# Interactive, so even the watchdogs were down and nothing could report the
# outage. A dead-man's switch that is itself Interactive is worse than
# useless: the scenario it exists to catch (nothing ran) is the same scenario
# in which it does not run either. See schedule_monthly.ps1 for the full
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

$ActualLogonType = "unknown"
try {
    $ActualLogonType = [string](Get-ScheduledTask -TaskName $TaskName).Principal.LogonType
} catch {
    $ActualLogonType = "unreadable"
}

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        $Checker"
Write-Host "  Recurrence:  daily at 09:15 local (one reminder per month at most)"
Write-Host "  Reads:       basemap-manitoba.meta.json on BOTH public R2 hosts (what production serves)"
Write-Host "  Alerts when: OSM data older than 400 days, sidecar unreadable, or the buckets disagree"
Write-Host "  LogonType:   $ActualLogonType  (S4U = runs while logged off; Interactive = does NOT)"
Write-Host ""
Write-Host "Useful commands (PowerShell):"
Write-Host "  Show details:    Get-ScheduledTask -TaskName $TaskName | Format-List *"
Write-Host "  Run now:         Start-ScheduledTask  -TaskName $TaskName"
Write-Host "  Dry run by hand: powershell -ExecutionPolicy Bypass -File `"$Checker`" -DryRun"
Write-Host "  Test alerts:     powershell -ExecutionPolicy Bypass -File `"$Checker`" -TestAlert"
Write-Host "  Cancel schedule: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"

Write-Host ""
if ($ActualLogonType -eq "S4U") {
    Write-Host "Runs whether you are logged on or not - a logon screen no longer stalls it."
} else {
    Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    Write-Host "!!  WARNING: '$TaskName' is LogonType=$ActualLogonType, NOT S4U."
    Write-Host "!!"
    Write-Host "!!  IT WILL NOT RUN WHILE YOU ARE LOGGED OFF. A watchdog that only runs when"
    Write-Host "!!  you are logged on cannot report the outage it exists to catch."
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
