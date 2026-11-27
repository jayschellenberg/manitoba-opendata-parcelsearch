# geoportal-new-datasets-check.ps1 -- quarterly look at the Manitoba GeoPortal
# (https://geoportal.gov.mb.ca/) for datasets published since the last look,
# with the ones that could matter to real estate appraisal work listed first.
#
# WHY THIS EXISTS
# ---------------
# upstream-vintage-check.ps1 watches the provincial layers the app ALREADY
# uses. Nothing watched for layers it does not use yet: the province adds a
# dataset (peatlands, dikes, drainage basins, a new soil layer) and the only way
# to find out was to browse the portal by hand. This reads the portal's own
# catalogue and reports what is new.
#
# HOW
# ---
# The portal is an ArcGIS Hub site; its catalogue is public JSON at
#   /api/search/v1/collections/dataset/items   (about 120 records, paged)
# Each run pulls the whole catalogue and compares item ids with the set seen
# last time (logs\geoportal-known-datasets.json). Ids, not the 'created' date,
# so an old item that is only now made public still counts as new.
#
# Every new dataset is reported; none is dropped. A keyword pass over title,
# tags and categories only decides the ORDER: "likely relevant" first,
# with the words that matched, then the rest. The keyword list is a sort key,
# not a filter, so a miss costs a lower place in the email and nothing more.
#
# The first run (no known-set file) records the catalogue as the baseline and
# sends nothing; -Report shows what a given look-back window contains.
#
# The known set is advanced only when the email is verifiably delivered
# (Test-AlertDelivered in alert-lib.ps1). At a three-month cadence a lost email
# would otherwise hide a dataset for good. Undelivered -> exit 1, which the
# daily task-health check reports the next morning; the findings are also
# written to logs\geoportal-new-datasets-<date>.txt either way.
#
# Not covered: a new LAYER added inside a feature service that is already
# listed (the catalogue lists services, so that shows only as a 'modified'
# date), and the Apps & Maps collection.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File geoportal-new-datasets-check.ps1
#   ... -DryRun            # decide + print, never send, never touch the known set
#   ... -Report            # print datasets created in the last -ReportDays days (default 365), exit 0
#   ... -TestAlert         # prove the email + push path
#
# Scheduled via schedule_geoportal_check.ps1 (1 Jan, Apr, Jul, Oct 09:50).
# ASCII-only so Windows PowerShell 5.1 parses it without a BOM.

param(
  [switch]$TestAlert,
  [switch]$DryRun,
  [switch]$Report,
  [int]$ReportDays = 365
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
$NtfyTopic = 'mbps-geoportal-datasets-jks'
$Portal    = 'https://geoportal.gov.mb.ca'
$ItemsUrl  = "$Portal/api/search/v1/collections/dataset/items"
$LogDir    = Join-Path $root 'logs'
$KnownFile = Join-Path $LogDir 'geoportal-known-datasets.json'
$PageSize  = 50     # ~6 KB per record; keeps each page well under PS 5.1's 2 MB ConvertFrom-Json cap

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - GeoPortal new-dataset check' `
    ("Test alert from geoportal-new-datasets-check.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
     'If this reached you, new-dataset reports are wired up.')
  if ($ok) { exit 0 } else { exit 1 }
}

# Sort key only (see header). Each entry is a regex anchored at a word start,
# tested case-insensitively against title + tags + categories. The summary is
# left out on purpose: measured 2026-11-27, matching it put every precipitation
# forecast layer under "relevant" (their blurbs mention flood, planning,
# watershed). Add words freely; nothing is filtered, only ordered.
$RelevantWords = @(
  'parcel','assessment','property','cadastr','survey','township','section grid','legal description',
  'land use','zoning','planning','development plan','subdivision','municipal','boundar','annex',
  'flood','dike','drain','wetland','peat','watershed','shoreline','erosion','elevation','lidar','contour',
  'soil','agricultur','crop','irrigat','livestock','crown land','lease','pasture',
  'road','highway','traffic','rail','airport','bridge',
  'hydro\b','transmission','pipeline','utilit','sewer','water system','wells?\b','lagoon','landfill','waste',
  'contaminat','impacted site','remediat','petroleum','storage tank',
  'mine\b','mines\b','mining','quarr','aggregate','mineral','oil and gas',
  'conservation','protected','parks?\b','wildlife management','ecological reserve','heritage','historic',
  'first nation','treaty','reserve',
  'census','population','housing','dwelling','building','address','permit','school','hospital',
  'forest','timber','cottage','resort','recreation','imagery','ortho','aerial'
)
# Titles that are operational feeds, not land facts. A match here sends the
# dataset to the second list whatever else it matched; it is still reported.
$DemoteTitle = 'forecast|precipitation|alert|vaccin|rabies|disease|covid|compensation disclosure|wildfire|fire danger|road condition'

function Get-Json([string]$url) {
  # WebClient with explicit UTF-8: Invoke-RestMethod under 5.1 mis-decodes
  # UTF-8 bodies that arrive without a charset in the Content-Type header.
  try { [Net.ServicePointManager]::SecurityProtocol =
          [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
  $wc = New-Object System.Net.WebClient
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Headers.Add('User-Agent', 'geoportal-new-datasets-check')
  try { return ($wc.DownloadString($url) | ConvertFrom-Json) } finally { $wc.Dispose() }
}

function ConvertFrom-EpochMs($ms) {
  if (-not $ms) { return $null }
  return ([DateTime]'1970-01-01').AddMilliseconds([double]$ms).ToLocalTime()
}

function Fail([string]$why) {
  Write-Warning $why
  if (-not $DryRun -and -not $Report) {
    Send-FailureAlert $root $NtfyTopic 'GEOPORTAL - new-dataset check could not read the catalogue' `
      ("$why`n`nThe known set was left untouched; nothing is lost. Re-run:`n" +
       "  powershell -ExecutionPolicy Bypass -File `"$root\geoportal-new-datasets-check.ps1`"`n" +
       "Checked $(Get-Date -Format s) on $env:COMPUTERNAME.") | Out-Null
  }
  exit 1
}

# ---- 1. pull the whole catalogue -------------------------------------------
$items = @{}
$matched = $null
$start = 1
while ($true) {
  # sortBy is required, not cosmetic: unsorted pages overlap (measured
  # 2026-11-27: 122 rows returned, only 109 distinct ids).
  $url = "${ItemsUrl}?limit=$PageSize&sortBy=properties.created&startindex=$start"
  try { $page = Get-Json $url } catch { Fail "Catalogue request failed ($url): $($_.Exception.Message)" }
  if ($null -eq $page -or $null -eq $page.features) { Fail "Catalogue answered without a 'features' list ($url)." }
  if ($null -eq $matched) { $matched = [int]$page.numberMatched }
  $feats = @($page.features)
  foreach ($f in $feats) {
    $p = $f.properties
    if (-not $f.id) { continue }
    $items[[string]$f.id] = [pscustomobject]@{
      id       = [string]$f.id
      title    = [string]$p.title
      type     = [string]$p.type
      created  = ConvertFrom-EpochMs $p.created
      modified = ConvertFrom-EpochMs $p.modified
      source   = [string]$p.source
      snippet  = ([string]$p.snippet -replace '\s+', ' ').Trim()
      tags     = (@($p.tags) -join ', ')
      cats     = ((@($p.categories) | ForEach-Object { ([string]$_) -replace '^/Categories/', '' }) -join ', ')
    }
  }
  if ($feats.Count -lt $PageSize) { break }
  $start += $PageSize
  if ($start -gt 5000) { Fail 'Catalogue paging did not end after 5000 records.' }
}
Write-Host "Catalogue: $($items.Count) datasets read, portal reports $matched."
# A short read must never be mistaken for "everything else is new/removed".
if ($items.Count -eq 0) { Fail 'Catalogue returned no datasets.' }
if ($matched -and $items.Count -lt $matched) { Fail "Read $($items.Count) datasets but the portal reports $matched; refusing to compare a partial catalogue." }

function Get-Relevance($it) {
  if ($it.title -match $DemoteTitle) { return ,@() }
  $hay = "$($it.title) | $($it.tags) | $($it.cats)"
  $hits = @($RelevantWords | Where-Object { $hay -match ('\b' + $_) })
  return ,$hits
}

function Format-Item($it) {
  $hits = Get-Relevance $it
  $lines = @()
  $lines += "* $($it.title)"
  $lines += "    $Portal/datasets/$($it.id)"
  $c = if ($it.created) { $it.created.ToString('yyyy-MM-dd') } else { 'unknown' }
  $lines += "    created $c | $($it.type) | $($it.source) | categories: $($it.cats)"
  if ($it.snippet) {
    $s = $it.snippet; if ($s.Length -gt 300) { $s = $s.Substring(0, 300) + '...' }
    $lines += "    $s"
  }
  if ($hits.Count) { $lines += "    matched: $($hits -join ', ')" }
  return $lines
}

function Format-Report($list, [string]$heading) {
  $rel   = @($list | Where-Object { (Get-Relevance $_).Count -gt 0 } | Sort-Object created -Descending)
  $other = @($list | Where-Object { (Get-Relevance $_).Count -eq 0 } | Sort-Object created -Descending)
  $out = @($heading, '')
  $out += "LIKELY RELEVANT TO APPRAISAL WORK ($($rel.Count))"
  if ($rel.Count) { foreach ($it in $rel) { $out += Format-Item $it; $out += '' } } else { $out += '  none'; $out += '' }
  $out += "OTHER NEW DATASETS ($($other.Count))"
  if ($other.Count) { foreach ($it in $other) { $out += Format-Item $it; $out += '' } } else { $out += '  none'; $out += '' }
  return [pscustomobject]@{ Lines = $out; Relevant = $rel.Count; Other = $other.Count }
}

# ---- 2. -Report: look-back by created date, no state involved ---------------
if ($Report) {
  $cut = (Get-Date).AddDays(-$ReportDays)
  $recent = @($items.Values | Where-Object { $_.created -and $_.created -ge $cut })
  (Format-Report $recent "Datasets created on the Manitoba GeoPortal since $($cut.ToString('yyyy-MM-dd')) ($($recent.Count) of $($items.Count)):").Lines | ForEach-Object { Write-Host $_ }
  exit 0
}

# ---- 3. compare with the known set ------------------------------------------
$known = @{}
$lastRun = $null
if (Test-Path $KnownFile) {
  try {
    $state = Get-Content $KnownFile -Raw | ConvertFrom-Json
    $lastRun = [string]$state.lastRun
    foreach ($k in @($state.datasets)) { $known[[string]$k.id] = $k }
  } catch { Fail "Known-set file is unreadable ($KnownFile): $($_.Exception.Message)" }
}

function Save-Known {
  $now = (Get-Date).ToString('yyyy-MM-dd')
  $rows = @($items.Values | Sort-Object title | ForEach-Object {
    $fs = if ($known.ContainsKey($_.id) -and $known[$_.id].firstSeen) { [string]$known[$_.id].firstSeen } else { $now }
    [pscustomobject]@{ id = $_.id; title = $_.title; firstSeen = $fs }
  })
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $obj = [pscustomobject]@{ lastRun = $now; count = $rows.Count; datasets = $rows }
  Set-Content -Path $KnownFile -Value ($obj | ConvertTo-Json -Depth 4) -Encoding UTF8
}

if ($known.Count -eq 0) {
  if ($DryRun) { Write-Host "DRY RUN: no known set yet; would record $($items.Count) datasets as the baseline."; exit 0 }
  Save-Known
  Write-Host "Baseline recorded: $($items.Count) datasets in $KnownFile. Nothing sent on a first run."
  exit 0
}

# A catalogue that suddenly halves is an upstream fault, not 60 retirements.
if ($items.Count -lt ($known.Count / 2)) { Fail "Catalogue has $($items.Count) datasets against $($known.Count) known; too large a drop to trust." }

$new     = @($items.Values | Where-Object { -not $known.ContainsKey($_.id) })
$removed = @($known.Values | Where-Object { -not $items.ContainsKey([string]$_.id) })
Write-Host "Since $lastRun : $($new.Count) new, $($removed.Count) no longer listed."

if ($new.Count -eq 0) {
  if ($removed.Count) { $removed | ForEach-Object { Write-Host "  no longer listed: $($_.title)" } }
  if ($DryRun) { Write-Host 'DRY RUN: nothing new; nothing would be sent.'; exit 0 }
  Save-Known
  Write-Host 'Nothing new. No email.'
  exit 0
}

$rep = Format-Report $new "New on the Manitoba GeoPortal since the last check ($lastRun): $($new.Count) dataset(s)."
$body = @($rep.Lines)
if ($removed.Count) {
  $body += "NO LONGER LISTED ($($removed.Count))"
  foreach ($r in $removed) { $body += "  $($r.title)" }
  $body += ''
}
$body += "Order is by keyword match only; every new dataset is listed above."
$body += "Checked $(Get-Date -Format s) on $env:COMPUTERNAME by geoportal-new-datasets-check.ps1 ($($items.Count) datasets in the catalogue)."
$body += "Stop these:  Unregister-ScheduledTask -TaskName mb-parcelsearch-geoportal-datasets -Confirm:`$false"

$body | ForEach-Object { Write-Host $_ }
if ($DryRun) { Write-Host 'DRY RUN: not sent, known set untouched.'; exit 0 }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$outFile = Join-Path $LogDir ("geoportal-new-datasets-{0}.txt" -f (Get-Date).ToString('yyyy-MM-dd'))
Set-Content -Path $outFile -Value $body -Encoding UTF8

$subject = "GEOPORTAL - $($new.Count) new Manitoba dataset(s), $($rep.Relevant) likely relevant to appraisal"
$sent = Send-FailureAlert $root $NtfyTopic $subject ($body -join "`n")
if (Test-AlertDelivered) {
  Save-Known
  Write-Host "Report sent (new=$($new.Count), relevant=$($rep.Relevant)). Known set advanced."
  exit 0
} elseif ($sent) {
  Write-Warning "Report went out on PUSH ONLY -- email is configured but FAILED. Known set NOT advanced; findings are in $outFile."
  exit 1
} else {
  Write-Warning "Report NOT sent -- no channel succeeded. Known set NOT advanced; findings are in $outFile."
  exit 1
}
