# traffic-refresh-check.ps1 -- monthly check for new Manitoba traffic volume
# data, rebuilding and publishing when a new annual report lands.
#
# WHAT "NEW TRAFFIC VOLUME INFO" MEANS. Two independent upstreams, and only
# one of them a rebuild can act on:
#
#   1. A new ANNUAL REPORT PDF at gov.mb.ca/mti/traffic/mhtis_traffic_reports.html
#      (traffic_report_YYYY.pdf). This is the real archive -- per-station AADT
#      series and the ~291 town count stations. A new edition means rebuild,
#      which this script does unattended.
#
#   2. A new AADT_<year> COLUMN on the MHTIS ArcGIS Traffic Flow service.
#      This one a rebuild CANNOT fix: the column list lives in AADT_FIELDS in
#      web/src/arcgis.js, so picking it up is a code change. It is checked
#      here anyway because it is exactly the failure that started this whole
#      thread -- the app sat on AADT_2023 for months while AADT_2024 existed,
#      showing a stale count on 36% of the network with no error anywhere.
#      Silent staleness is the thing to catch, so this alerts and stops.
#
# WHY editions_seen, NOT editions. traffic-history.json records both: the
# editions that CONTRIBUTED rows, and the editions the build LOOKED AT. Two
# reports parse badly and contribute nothing (2017's PDF has two broken font
# encodings; 2013 parses partially), so comparing MHTIS's published list
# against `editions` would see 2017 missing every single month and rebuild
# forever. `editions_seen` is the honest comparison.
#
# WHAT A REBUILD PUBLISHES. r/build_traffic_history.R refuses to write when
# its own gates trip -- 13 spot values read by eye off the PDFs must still
# match, and cross-edition disagreement must stay under 2% (genuine MHTIS
# restatements run ~0.29%). So a layout change in a future report fails the
# build instead of quietly publishing wrong counts into an appraisal tool.
# Only after that does this commit and push, which is what deploys.
#
# Unattended git push to main is deliberate and matches auto-publish-indexes.ps1,
# the existing precedent in this repo. Only the two traffic files are staged
# by path, so unrelated work in the tree is never swept into the commit.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File traffic-refresh-check.ps1              # real check
#   powershell -ExecutionPolicy Bypass -File traffic-refresh-check.ps1 -DryRun      # decide + print, never build/commit/send
#   powershell -ExecutionPolicy Bypass -File traffic-refresh-check.ps1 -TestAlert   # send a test alert and exit
#   powershell -ExecutionPolicy Bypass -File traffic-refresh-check.ps1 -Force       # rebuild even with no new edition
#   powershell -ExecutionPolicy Bypass -File traffic-refresh-check.ps1 -NoPush      # build + commit, leave the push to a human
#
# Scheduled via schedule_traffic_check.ps1 (monthly). ASCII-only on purpose so
# Windows PowerShell 5.1 parses it without a BOM.

param(
  [switch]$TestAlert,
  [switch]$DryRun,
  [switch]$Force,
  [switch]$NoPush
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')

$NtfyTopic   = 'mbps-traffic-refresh-jks'
$HistoryJson = Join-Path $root 'web\public\data\traffic-history.json'
$ArcgisJs    = Join-Path $root 'web\src\arcgis.js'
$IndexUrl    = 'https://www.gov.mb.ca/mti/traffic/mhtis_traffic_reports.html'
$FlowMetaUrl = 'https://services6.arcgis.com/HQUud09zgy3Asw9X/arcgis/rest/services/MHTIS_Traffic_Flow_2023_(new)/FeatureServer/0?f=json'

$LogDir = Join-Path $root 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir ("traffic-refresh-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmm'))

# The repo lives under Dropbox, which intermittently holds a handle on a file
# it is syncing -- Add-Content then throws "being used by another process".
# Logging must never be the thing that fails the job, so retry briefly and
# give up silently; the console line has already been written either way.
function Log([string]$msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Write-Host $line
  for ($i = 0; $i -lt 3; $i++) {
    try {
      Add-Content -Path $LogFile -Value $line -ErrorAction Stop
      return
    } catch {
      Start-Sleep -Milliseconds 150
    }
  }
}

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - traffic refresh watchdog' `
        'Test alert from traffic-refresh-check.ps1. If you see this, the alert stack works.'
  Write-Host ("test alert sent: {0}" -f $ok)
  exit 0
}

Log "=== traffic-refresh-check started"
Log ("dry run: {0}   force: {1}   no push: {2}" -f $DryRun, $Force, $NoPush)

# ---------------------------------------------------------------- local ----

if (-not (Test-Path $HistoryJson)) {
  $body = "traffic-history.json is missing at $HistoryJson. The Traffic Counts overlay has no data to show. Rebuild with: npm run traffic:history"
  Log '!! traffic-history.json MISSING'
  if (-not $DryRun) { Send-FailureAlert $root $NtfyTopic 'Traffic history data missing' $body | Out-Null }
  exit 1
}

try {
  $doc = Get-Content $HistoryJson -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  $body = "traffic-history.json could not be parsed: $($_.Exception.Message)"
  Log "!! traffic-history.json UNPARSEABLE: $($_.Exception.Message)"
  if (-not $DryRun) { Send-FailureAlert $root $NtfyTopic 'Traffic history data unreadable' $body | Out-Null }
  exit 1
}

# editions_seen was added 2026-09-11. An older file predates it; fall back to
# `editions` and say so, rather than treating every un-parsed year as new.
$seen = @()
if ($doc.metadata.PSObject.Properties.Name -contains 'editions_seen') {
  $seen = @($doc.metadata.editions_seen)
} else {
  $seen = @($doc.metadata.editions)
  Log '   (old file: no editions_seen; comparing against editions instead)'
}
Log ("local editions seen: {0}" -f ($seen -join ', '))

# ------------------------------------------------------------- upstream ----

$available = @()
try {
  $html = (Invoke-WebRequest -Uri $IndexUrl -UseBasicParsing -TimeoutSec 60).Content
  $available = @([regex]::Matches($html, 'traffic_report_(\d{4})\.pdf') |
                 ForEach-Object { [int]$_.Groups[1].Value } | Sort-Object -Unique)
} catch {
  Log "!! could not read the MHTIS reports index: $($_.Exception.Message)"
}

if ($available.Count -eq 0) {
  # Do NOT treat an unreachable index as "nothing new" -- that is the silent
  # failure this whole script exists to prevent. Say so, once.
  $body = "Could not read the MHTIS annual-reports index at $IndexUrl, so this month's check could not tell whether a new traffic report has been published. The site may have moved or been restructured. Check by hand: $IndexUrl"
  Log '!! upstream index unreadable -- alerting'
  if (-not $DryRun) { Send-FailureAlert $root $NtfyTopic 'Traffic report index unreachable' $body | Out-Null }
  exit 1
}
Log ("upstream editions:   {0}" -f ($available -join ', '))

$newEditions = @($available | Where-Object { $seen -notcontains $_ })

# --------------------------------------- flow service column drift check ---
# A new AADT_<year> column needs AADT_FIELDS in arcgis.js updated. A rebuild
# does not touch that, so this only ever reports.

$columnWarning = $null
try {
  $meta = Invoke-RestMethod -Uri $FlowMetaUrl -TimeoutSec 60
  $svcYears = @($meta.fields | ForEach-Object { $_.name } |
                Where-Object { $_ -match '^AADT_(\d{4})$' } |
                ForEach-Object { [int]($_ -replace '^AADT_', '') } | Sort-Object -Unique)
  $js = Get-Content $ArcgisJs -Raw -Encoding UTF8
  $m = [regex]::Match($js, 'AADT_FIELDS\s*=\s*\[(?<body>[^\]]*)\]')
  $knownYears = @()
  if ($m.Success) {
    $knownYears = @([regex]::Matches($m.Groups['body'].Value, "AADT_(\d{4})") |
                    ForEach-Object { [int]$_.Groups[1].Value } | Sort-Object -Unique)
  }
  Log ("flow service AADT columns: {0}" -f ($svcYears -join ', '))
  Log ("AADT_FIELDS knows:         {0}" -f ($knownYears -join ', '))
  $unknown = @($svcYears | Where-Object { $knownYears -notcontains $_ })
  if ($unknown.Count -gt 0) {
    $columnWarning = "The MHTIS Traffic Flow service now publishes AADT_$($unknown -join ', AADT_') but AADT_FIELDS in web/src/arcgis.js reads only AADT_$($knownYears -join ', AADT_'). A rebuild does NOT pick this up -- it is a code change. Until it is made, segments whose station is absent from the annual reports fall back to a stale column."
    Log "!! NEW FLOW COLUMN(S): $($unknown -join ', ') -- code change needed"
  }
} catch {
  Log "   (flow service metadata check skipped: $($_.Exception.Message))"
}

# ------------------------------------------------------------- decision ----

if ($newEditions.Count -eq 0 -and -not $Force) {
  Log 'no new annual report -- nothing to rebuild'
  if ($columnWarning) {
    if ($DryRun) { Log "DRY RUN: would alert about the new flow column" }
    else { Send-FailureAlert $root $NtfyTopic 'New MHTIS AADT column needs a code change' $columnWarning | Out-Null }
  }
  Log '=== done'
  exit 0
}

if ($newEditions.Count -gt 0) {
  Log ("NEW EDITION(S): {0}" -f ($newEditions -join ', '))
} else {
  Log 'no new edition, but -Force was given'
}

if ($DryRun) {
  Log 'DRY RUN: would rebuild, rebuild the manifest, commit and push'
  Log '=== done'
  exit 0
}

# -------------------------------------------------------------- rebuild ----

Push-Location $root
try {
  $branch = (& git rev-parse --abbrev-ref HEAD 2>$null).Trim()
  if ($branch -ne 'main') {
    # Publishing from a feature branch would push someone's work-in-progress.
    $body = "A new MHTIS traffic report ($($newEditions -join ', ')) is available, but this repo is on branch '$branch' rather than main, so the rebuild was NOT published. Switch to main and run: npm run traffic:history"
    Log "!! on branch '$branch', not main -- refusing to publish"
    Send-FailureAlert $root $NtfyTopic 'Traffic rebuild skipped (not on main)' $body | Out-Null
    exit 1
  }

  Log 'running r/build_traffic_history.R ...'
  & Rscript r\build_traffic_history.R *>> $LogFile
  if ($LASTEXITCODE -ne 0) {
    # The build's own gates (spot values, cross-edition agreement) failing is
    # the GOOD outcome here: it means a report changed shape and the parser
    # would have published wrong numbers. Nothing was written.
    $body = "r/build_traffic_history.R failed (exit $LASTEXITCODE) while picking up the $($newEditions -join ', ') report. Its self-checks refuse to write on a bad parse, so the previous data is still live and correct. A new edition has probably changed the PDF's layout. Log: $LogFile"
    Log "!! build FAILED (exit $LASTEXITCODE) -- previous data left in place"
    Send-FailureAlert $root $NtfyTopic 'Traffic history rebuild FAILED' $body | Out-Null
    exit 1
  }

  Log 'running build-manifest.js ...'
  & node web\scripts\build-manifest.js *>> $LogFile
  if ($LASTEXITCODE -ne 0) {
    $body = "traffic-history.json rebuilt for $($newEditions -join ', '), but build-manifest.js failed (exit $LASTEXITCODE), so nothing was committed. Log: $LogFile"
    Log "!! manifest FAILED (exit $LASTEXITCODE) -- not committing"
    Send-FailureAlert $root $NtfyTopic 'Traffic rebuild: manifest step failed' $body | Out-Null
    exit 1
  }

  # Stage BY PATH so unrelated work in the tree is never swept in.
  & git add web/public/data/traffic-history.json web/public/data/manifest.json *>> $LogFile
  $staged = & git diff --cached --name-only
  if (-not $staged) {
    Log 'rebuild produced no change -- nothing to commit'
    Log '=== done'
    exit 0
  }
  Log ("staged: {0}" -f ($staged -join ', '))

  $fresh = Get-Content $HistoryJson -Raw -Encoding UTF8 | ConvertFrom-Json
  $summary = "{0} stations, {1} station-years, {2}-{3}" -f `
             $fresh.metadata.stations, $fresh.metadata.station_years, `
             $fresh.metadata.years[0], $fresh.metadata.years[1]

  $title = "Traffic history: picked up the $($newEditions -join ', ') MHTIS report"
  & git commit -m $title `
               -m "Rebuilt from the annual reports by traffic-refresh-check.ps1 (monthly, unattended). Now $summary. The build's spot-value and cross-edition gates passed before this was written." `
               *>> $LogFile
  if ($LASTEXITCODE -ne 0) {
    Log "!! git commit failed (exit $LASTEXITCODE)"
    Send-FailureAlert $root $NtfyTopic 'Traffic rebuild: commit failed' "git commit failed (exit $LASTEXITCODE). Log: $LogFile" | Out-Null
    exit 1
  }

  if ($NoPush) {
    Log 'committed; -NoPush given, leaving the push to a human'
  } else {
    & git push origin HEAD *>> $LogFile
    if ($LASTEXITCODE -ne 0) {
      Log "!! git push failed (exit $LASTEXITCODE)"
      Send-FailureAlert $root $NtfyTopic 'Traffic rebuild: push failed' "The rebuild is committed locally but `git push` failed (exit $LASTEXITCODE), so it is not deployed. Log: $LogFile" | Out-Null
      exit 1
    }
    Log 'pushed -- Vercel will deploy'
  }

  # Success is worth an alert too: this runs unattended and a silent success
  # is indistinguishable from a task that never fired.
  $body = "Picked up the $($newEditions -join ', ') MHTIS annual report. traffic-history.json is now $summary, committed and pushed; Vercel deploys automatically."
  if ($columnWarning) { $body = $body + "`n`nAlso: " + $columnWarning }
  Send-FailureAlert $root $NtfyTopic $title $body | Out-Null
  Log '=== done'
} finally {
  Pop-Location
}
