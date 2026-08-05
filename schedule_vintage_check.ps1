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

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        upstream-vintage-check.ps1 weekly, Mondays 09:30 local"
Write-Host "  Reminds:     once per month, only when a live provincial service is"
Write-Host "               superseded by a later vintage, unreachable, or has had no"
Write-Host "               upstream edit in over 730 days"
Write-Host "  Channels:    email (alert-email.local.txt) + ntfy push (mbps-upstream-vintage-jks)"
Write-Host "  StartWhenAvailable enabled (catches up if the machine was off)"
Write-Host ""
Write-Host "Subscribe to the ntfy topic 'mbps-upstream-vintage-jks' in the ntfy app to get pushes."
Write-Host ""
Write-Host "See the current table:  powershell -ExecutionPolicy Bypass -File upstream-vintage-check.ps1 -Report"
Write-Host "Dry-run the decision:   powershell -ExecutionPolicy Bypass -File upstream-vintage-check.ps1 -DryRun"
Write-Host "Test the alert path:    powershell -ExecutionPolicy Bypass -File upstream-vintage-check.ps1 -TestAlert"
Write-Host "Cancel:                 Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
