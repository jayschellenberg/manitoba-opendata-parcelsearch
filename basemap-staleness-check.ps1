# basemap-staleness-check.ps1 -- dead-man's switch for the Protomaps streets
# basemap (email + ntfy push when the archive production serves is old).
#
# Context: mb-parcelsearch-basemap-refresh re-cuts basemap-manitoba.pmtiles
# from the Protomaps daily build on Jan 2 / Jul 2 and alerts if a STEP fails
# -- but if the task never starts (schedule rot, machine reimaged, registrar
# never run) nothing runs and nothing alerts. This daily check closes that
# hole from the outside, and it does so by reading what PRODUCTION serves:
# the basemap-manitoba.meta.json sidecar rebuild-basemap.ps1 publishes next
# to the archive on each R2 bucket. No credentials, no local state -- the
# same request a browser could make.
#
# Age is the OSM data time recorded in the sidecar (planetiler's
# osmosisreplicationtime), never the upload date or an mtime. Cadence is
# ~182 days; the 400-day default alerts once a whole cycle has been missed
# and the data is more than a year old -- roads do not change fast enough
# for anything tighter to be worth a nag.
#
# Both buckets are checked. A missing or unreadable sidecar on either counts
# as stale (it means the archive was published by hand without the sidecar,
# or never published), and a build mismatch between the two buckets is
# reported inside the alert.
#
# Robustness: a stamp file (logs\basemap-alert-stamp.txt) dedupes to at most
# ONE reminder per calendar month; the stamp is written only on VERIFIED
# delivery (Test-AlertDelivered in alert-lib.ps1).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File basemap-staleness-check.ps1             # real check
#   powershell -ExecutionPolicy Bypass -File basemap-staleness-check.ps1 -DryRun     # decide + print, never send
#   powershell -ExecutionPolicy Bypass -File basemap-staleness-check.ps1 -TestAlert  # send a test alert and exit
#   ... -MaxAgeDays 400                                                              # override
#
# Scheduled via schedule_basemap_check.ps1 (daily 09:15). ASCII-only on
# purpose so Windows PowerShell 5.1 parses it without a BOM.

param(
  [int]$MaxAgeDays = 400,
  [switch]$TestAlert,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
$NtfyTopic = 'mbps-basemap-jks'   # same topic as rebuild-basemap.ps1 -- one subscription
$StampFile = Join-Path $root 'logs\basemap-alert-stamp.txt'
$MetaName  = 'basemap-manitoba.meta.json'

# Must match rebuild-basemap.ps1.
$Targets = @(
    @{ Name = 'Manitoba'; Public = 'https://pub-091058079bf6458da1681945177e1682.r2.dev' },
    @{ Name = 'Winnipeg'; Public = 'https://pub-f351b204f73e4b2287acad946d79681c.r2.dev' }
)

try { [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - Protomaps basemap staleness watchdog' `
    ("Test alert from basemap-staleness-check.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
     'If this reached you, the basemap dead-man watchdog is wired up.')
  if ($ok) { exit 0 } else { exit 1 }
}

$now = Get-Date
$rows = @()
foreach ($t in $Targets) {
  $row = @{ Name = $t.Name; Url = "$($t.Public)/$MetaName"; Build = $null; OsmTime = $null; Age = $null; Desc = '(unreadable)' }
  try {
    $m = Invoke-RestMethod -Uri $row.Url -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    $row.Build = [string]$m.source_build
    $row.OsmTime = [string]$m.osm_data_time
    $dt = [datetime]::Parse($row.OsmTime).ToUniversalTime()
    $row.Age = [int]($now.ToUniversalTime().Date - $dt.Date).TotalDays
    $row.Desc = "build $($row.Build), OSM data $($dt.ToString('yyyy-MM-dd')) ($($row.Age) days old)"
  } catch {
    $row.Desc = "(sidecar unreadable: $($_.Exception.Message))"
  }
  $rows += $row
}

$staleRows = @($rows | Where-Object { ($null -eq $_.Age) -or ($_.Age -gt $MaxAgeDays) })
$builds = @($rows | ForEach-Object { $_.Build } | Where-Object { $_ } | Sort-Object -Unique)
$mismatch = ($builds.Count -gt 1)

foreach ($r in $rows) { Write-Host "$($r.Name): $($r.Desc)" }

if ($staleRows.Count -eq 0 -and -not $mismatch) {
  Write-Host "Basemap current on both buckets; threshold $MaxAgeDays days. No reminder."
  exit 0
}

if ($DryRun) {
  Write-Host "DRYRUN - would alert (stale: $($staleRows.Count) bucket(s); build mismatch: $mismatch). No alert sent."
  exit 0
}

# Dedupe -- one reminder per calendar month.
$stampVal = $now.ToString('yyyy-MM')
if ((Test-Path $StampFile) -and ((Get-Content $StampFile -Raw).Trim() -eq $stampVal)) {
  Write-Host "Already reminded this month ($stampVal) -- skipping."
  exit 0
}

$why = @()
foreach ($r in $staleRows) { $why += "$($r.Name): $($r.Desc)" }
if ($mismatch) { $why += "the two buckets serve different builds ($($builds -join ' vs '))" }

$title = 'STALE - Protomaps streets basemap overdue'
$body  = @"
The self-hosted streets basemap looks overdue or inconsistent:
  $($why -join "`n  ")

  Manitoba : $($rows[0].Desc)
             $($rows[0].Url)
  Winnipeg : $($rows[1].Desc)
             $($rows[1].Url)
  Threshold: $MaxAgeDays days (cadence is ~182: Jan 2 / Jul 2)

The mb-parcelsearch-basemap-refresh task (Jan 2 / Jul 2, 03:00) probably did not run,
or refused the build (tileset schema gate) -- check its log. To investigate:

  1. Get-ScheduledTask -TaskName mb-parcelsearch-basemap-refresh | Get-ScheduledTaskInfo
  2. Newest $root\logs\basemap-*.log
  3. Run it by hand (5-30 min):
     powershell -ExecutionPolicy Bypass -File "$root\rebuild-basemap.ps1" -Publish

Checked $($now.ToString('s')) on $env:COMPUTERNAME by basemap-staleness-check.ps1.
Stop these reminders:  Unregister-ScheduledTask -TaskName mb-parcelsearch-basemap-staleness -Confirm:`$false
"@

$sent = Send-FailureAlert $root $NtfyTopic $title $body
if (Test-AlertDelivered) {
  New-Item -ItemType Directory -Force -Path (Split-Path $StampFile) | Out-Null
  Set-Content -Path $StampFile -Value $stampVal
  Write-Host "Reminder sent."
  exit 0
} elseif ($sent) {
  Write-Warning ('Reminder went out on PUSH ONLY -- email is configured but FAILED. ' +
                 'Stamp NOT written; the next run will try again. Check the app password.')
  exit 1
} else {
  Write-Warning 'Reminder NOT sent -- no channel succeeded.'
  exit 1
}
