# hpi-staleness-check.ps1 -- remind (email + ntfy push) when the Winnipeg MLS
# HPI data behind the residential appraisal dashboard goes stale.
#
# Context: ResChartsV2.5.qmd reads CREA MLS HPI from MLS_HPI_<Month>_<Year>
# folders (the dashboard's loader auto-picks the newest one). Since 2026-08-12
# the monthly download is automated by hpi-download.ps1 (daily 08:45 task
# mb-parcelsearch-hpi-download); this check remains the independent BACKSTOP:
# if no new folder has appeared by the grace day, it nudges with an email.
#
# Robustness:
#   * Staleness is judged from the FOLDER NAME (month+year), NOT the timestamp.
#     Dropbox re-syncs reset mtimes, so a timestamp check would be unreliable.
#   * A stamp file (logs\hpi-alert-stamp.txt) dedupes so it sends at most ONE
#     reminder per expected month, even if scheduled daily.
#   * Reuses the shared alert stack (alert-lib.ps1 + alert-email.local.txt).
#
# Rule:
#   expected month = current month  if today.Day >= GraceDay
#                    previous month  otherwise
#   stale          = newest MLS_HPI_<Mon>_<Year> is older than 'expected'
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File hpi-staleness-check.ps1              # real check
#   powershell -ExecutionPolicy Bypass -File hpi-staleness-check.ps1 -TestAlert   # send a test alert and exit
#   ... -HpiDir "<path>" -GraceDay 25                                             # overrides
#
# Scheduled via schedule_hpi_check.ps1 (daily; the grace-day + stamp keep it to
# one reminder per month). ASCII-only on purpose so Windows PowerShell 5.1
# parses it without a BOM.

param(
  [string]$HpiDir  = 'D:\Dropbox\Appraisal\RProjects\appraisal-templates\residential',
  [int]$GraceDay   = 25,
  [switch]$TestAlert
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
$NtfyTopic = 'mbps-hpi-staleness-jks'   # public namespace; carries no secrets
$StampFile = Join-Path $root 'logs\hpi-alert-stamp.txt'

# Month-name -> number, accepting full ("May","June") and 3-letter ("Jun")
# forms, case-insensitive.
$months = @{}
1..12 | ForEach-Object {
  $ci = [System.Globalization.CultureInfo]::InvariantCulture
  $months[$ci.DateTimeFormat.GetMonthName($_).ToLower()]            = $_
  $months[$ci.DateTimeFormat.GetAbbreviatedMonthName($_).ToLower()] = $_
}

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - HPI staleness reminder' `
    ("Test reminder from hpi-staleness-check.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
     'If this reached you, Winnipeg MLS HPI staleness reminders are wired up.')
  if ($ok) { exit 0 } else { exit 1 }
}

# Newest MLS_HPI_<Month>_<Year> folder, by parsed name.
$best = $null
Get-ChildItem -Path $HpiDir -Directory -Filter 'MLS_HPI_*' -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Name -match '^MLS_HPI_([A-Za-z]+)_(\d{4})$') {
    $mkey = $Matches[1].ToLower(); $yr = [int]$Matches[2]
    if ($months.ContainsKey($mkey)) {
      $ym = $yr * 12 + $months[$mkey]
      if (-not $best -or $ym -gt $best.YM) { $best = @{ YM = $ym; Label = "$($Matches[1]) $yr" } }
    }
  }
}

$now      = Get-Date
$expDate  = if ($now.Day -ge $GraceDay) { $now } else { $now.AddMonths(-1) }
$expYM    = $expDate.Year * 12 + $expDate.Month
$expLabel = $expDate.ToString('MMMM yyyy')

if (-not $best) {
  $stale = $true; $latestLabel = '(no MLS_HPI_* folder found)'
} else {
  $latestLabel = $best.Label
  $stale = $best.YM -lt $expYM
}

if (-not $stale) {
  Write-Host "HPI current: newest folder = $latestLabel; expected through $expLabel. No reminder."
  exit 0
}

# Dedupe -- one reminder per expected month.
if ((Test-Path $StampFile) -and ((Get-Content $StampFile -Raw).Trim() -eq "$expYM")) {
  Write-Host "Already reminded for $expLabel -- skipping."
  exit 0
}

$needName = "MLS_HPI_$($expDate.ToString('MMMM'))_$($expDate.Year)"
$title = "Reminder: Winnipeg MLS HPI data is stale (need $expLabel)"
$body  = @"
The residential dashboard's manually-updated CREA MLS HPI data looks stale.

  Newest folder present : $latestLabel
  Expected through      : $expLabel
  Location              : $HpiDir

To update:
  1. Download the latest Winnipeg MLS HPI (BOTH 'Not Seasonally Adjusted (M).xlsx'
     and 'Seasonally Adjusted (M).xlsx') from CREA / your board.
  2. Create a new folder named  $needName  next to the existing one at the
     location above and put the two .xlsx files in it.
  3. Re-render ResChartsV2.5 -- the loader auto-selects the newest folder.

Checked $($now.ToString('s')) on $env:COMPUTERNAME by hpi-staleness-check.ps1.
Stop these reminders:  Unregister-ScheduledTask -TaskName mb-parcelsearch-hpi-staleness -Confirm:`$false
"@

if (Send-FailureAlert $root $NtfyTopic $title $body) {
  New-Item -ItemType Directory -Force -Path (Split-Path $StampFile) | Out-Null
  Set-Content -Path $StampFile -Value "$expYM"
  Write-Host "Reminder sent for $expLabel (latest present: $latestLabel)."
  exit 0
} else {
  Write-Warning 'Reminder NOT sent -- no channel succeeded.'
  exit 1
}
