# schedule_hpi_download.ps1 -- register hpi-download.ps1 as a DAILY Windows
# Task Scheduler entry (08:45 local, i.e. 15 minutes BEFORE the 09:00
# hpi-staleness watchdog, so on the day CREA publishes a new month the download
# lands first and the watchdog sees it). Daily is intentional: the script
# no-ops in ~2s when the newest month on CREA's page is already extracted, and
# CREA's publication day drifts (~the 10th), so a fixed monthly trigger would
# either miss late publications or need its own retry logic. Idempotent --
# re-run to update; the existing task is replaced.
#
# Usage (normal user privileges, no admin needed):
#   powershell -ExecutionPolicy Bypass -File schedule_hpi_download.ps1
#
# Manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-hpi-download | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-hpi-download                      # run now
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-hpi-download -Confirm:$false  # cancel

$ErrorActionPreference = "Continue"   # schtasks writes 'task not found' to stderr; don't let it throw
$TaskName  = "mb-parcelsearch-hpi-download"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Downloader = Join-Path $ScriptDir "hpi-download.ps1"

if (-not (Test-Path $Downloader)) { Write-Error "Downloader not found: $Downloader"; exit 1 }

$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task '$TaskName' found - replacing it."
    schtasks /Delete /TN $TaskName /F | Out-Null
}

$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Downloader`""

schtasks /Create `
    /SC DAILY `
    /ST 08:45 `
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
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        hpi-download.ps1 daily at 08:45 local"
Write-Host "  Does:        mirrors CREA's newest MLS_HPI-<Month>-<Year>_EN.zip into"
Write-Host "               MLS_HPI_<Month>_<Year> under the residential data dir; no-op when current"
Write-Host "  Alerts:      hard failures only (email + ntfy mbps-hpi-staleness-jks), max one/month;"
Write-Host "               the 09:00 staleness watchdog remains the day-25 backstop nag"
Write-Host "  StartWhenAvailable enabled (catches up if the machine was off)"
Write-Host ""
Write-Host "Dry-run now:  powershell -ExecutionPolicy Bypass -File hpi-download.ps1 -DryRun"
Write-Host "Cancel:       Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
