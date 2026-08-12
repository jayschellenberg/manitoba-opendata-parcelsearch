# upstream-vintage-check.ps1 -- watchdog for live provincial services that have
# quietly been superseded, retired, or left to go stale upstream.
#
# WHY THIS EXISTS
# ---------------
# Every other freshness check in this project watches data WE generate. Nothing
# watched the live ArcGIS layers, because "live" reads as self-maintaining. It
# isn't: several provincial services carry the vintage in the SERVICE NAME, so
# they never roll forward. When the province publishes the next one, the app
# keeps querying the old URL indefinitely and every number it returns is still
# perfectly well-formed.
#
# Found exactly that on 2026-08-05: the app had been reading
# MHTIS_Traffic_Flow_2019 while MHTIS_Traffic_Flow_2023_(new) had been
# published alongside it. Same 2,067 segments, no error, no gap in the UI --
# just four-year-old traffic counts feeding appraisal work. Nothing in the
# repo could have told anyone. This closes that hole.
#
# WHAT IT CHECKS, per service the app actually references:
#   1. REACHABLE  -- the endpoint still answers and isn't returning an ArcGIS
#                    error (catches a retired or renamed service).
#   2. SUPERSEDED -- for year-stamped names (..._2019, ..._2023), whether the host
#                    org publishes a sibling with the same base name and a
#                    LATER year.
#   3. AGE        -- how long since the layer's own dataLastEditDate. Reported
#                    for context, and alerted on only past a generous
#                    threshold, since a stable reference layer legitimately
#                    sits still for years (section geometry, historic floods).
#
# The service list is READ OUT OF THE APP (web/src/*.js), not duplicated here,
# so adding or repointing a layer cannot leave this watchdog checking the wrong
# thing. That is the whole point -- a hardcoded copy would have gone stale the
# same way the traffic URL did.
#
# Sibling detection uses the org's own service directory. That listing has been
# observed to omit some services that nonetheless resolve (Manitoba_Road_Network_2023
# is absent from its org listing but answers fine), so a missed newer sibling is
# possible. It fails toward silence rather than false alarms, which is the right
# way round for a monthly nag.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File upstream-vintage-check.ps1
#   powershell -ExecutionPolicy Bypass -File upstream-vintage-check.ps1 -DryRun     # decide + print, never send
#   powershell -ExecutionPolicy Bypass -File upstream-vintage-check.ps1 -Report     # print the full table and exit 0
#   powershell -ExecutionPolicy Bypass -File upstream-vintage-check.ps1 -TestAlert
#   ... -MaxAgeDays 730                                                             # override the age threshold
#
# Scheduled via schedule_vintage_check.ps1 (weekly; a stamp keeps it to one
# reminder per month). ASCII-only so Windows PowerShell 5.1 parses it without a BOM.

param(
  [int]$MaxAgeDays = 730,      # ~2 years; only flags layers that have truly gone quiet
  [switch]$TestAlert,
  [switch]$DryRun,
  [switch]$Report
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
$NtfyTopic = 'mbps-upstream-vintage-jks'
$StampFile = Join-Path $root 'logs\vintage-alert-stamp.txt'
$SrcDir    = Join-Path $root 'web\src'

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - upstream service vintage watchdog' `
    ("Test alert from upstream-vintage-check.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
     'If this reached you, superseded-service alerts are wired up.')
  if ($ok) { exit 0 } else { exit 1 }
}

if (-not (Test-Path $SrcDir)) { Write-Error "Cannot find $SrcDir"; exit 1 }

# --- 1. Harvest the service URLs the app actually uses ----------------------
# Three things this has to get right, each of which it got wrong first time:
#
#  * The LAYER INDEX must be included. Querying `.../FeatureServer` returns
#    service-level JSON with no editingInfo at all, so every age silently read
#    'n/a' while looking like a successful check.
#  * The busiest layers (ROLL_ENTRY, zoning, dev plan, MASC risk) are built as
#    template literals off a shared `const BASE`, so a plain URL regex misses
#    exactly the services that matter most. BASE-style constants are resolved
#    and substituted below.
#  * Tile endpoints are not data layers. The Wayback imagery URL contains
#    `/MapServer/tile/...` under an Esri scheme directory, which matches a naive
#    pattern and yields a nonsense "service" called default028mm.
$urls = @{}
$jsFiles = Get-ChildItem $SrcDir -Filter *.js -Recurse
foreach ($file in $jsFiles) {
  $text = Get-Content -Raw $file.FullName

  # Literal URLs, layer index required.
  $literal = 'https://[a-z0-9.]*arcgis\.com/[^''"`\s]*?/rest/services/[^''"`\s]+?/(?:Feature|Map)Server/\d+'
  foreach ($m in [regex]::Matches($text, $literal)) { $urls[$m.Value] = $true }

  # `${CONST}/Service/FeatureServer/0` where CONST holds a services root.
  $roots = @{}
  foreach ($c in [regex]::Matches($text, '(?m)^\s*const\s+(?<n>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*[''"](?<v>https://[a-z0-9.]*arcgis\.com/[^''"]*?/rest/services)[''"]')) {
    $roots[$c.Groups['n'].Value] = $c.Groups['v'].Value
  }
  foreach ($t in [regex]::Matches($text, '\$\{(?<n>[A-Za-z_][A-Za-z0-9_]*)\}(?<path>/[A-Za-z0-9_.()-]+/(?:Feature|Map)Server/\d+)')) {
    $n = $t.Groups['n'].Value
    if ($roots.ContainsKey($n)) { $urls[($roots[$n] + $t.Groups['path'].Value)] = $true }
  }
}
# Tile pyramids are not data layers -- drop anything under a /tile/ path or the
# Esri WMTS scheme directory.
$serviceUrls = @($urls.Keys | Where-Object { $_ -notmatch '/tile/|/WMTS/|default0\d+mm' } | Sort-Object -Unique)
if ($serviceUrls.Count -eq 0) { Write-Error 'No ArcGIS service URLs found in web/src -- has the code moved?'; exit 1 }

$now = Get-Date
$rows = @()

# Cache each org's service directory so N services on one host cost one listing.
$orgCache = @{}
function Get-OrgServices([string]$orgRoot) {
  if ($orgCache.ContainsKey($orgRoot)) { return $orgCache[$orgRoot] }
  $names = @()
  try {
    $r = Invoke-RestMethod -Uri "$orgRoot`?f=json" -TimeoutSec 60
    if ($r.services) { $names = @($r.services | ForEach-Object { $_.name -replace '^.*/', '' }) }
  } catch { }
  $orgCache[$orgRoot] = $names
  return $names
}

foreach ($url in $serviceUrls) {
  $svcName = if ($url -match '/rest/services/(.+?)/(?:Feature|Map)Server') { $Matches[1] } else { $url }
  $orgRoot = if ($url -match '^(.*?/rest/services)/') { $Matches[1] } else { $null }

  $reachable = $false; $err = $null; $ageDays = $null; $editDate = $null
  try {
    $meta = Invoke-RestMethod -Uri "$url`?f=json" -TimeoutSec 60
    if ($meta.error) { $err = $meta.error.message } else {
      $reachable = $true
      $ms = $meta.editingInfo.dataLastEditDate
      if ($ms) {
        # ArcGIS reports epoch milliseconds.
        $editDate = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$ms).LocalDateTime
        $ageDays  = [int]($now.Date - $editDate.Date).TotalDays
      }
    }
  } catch { $err = $_.Exception.Message }

  # Year-stamped name? Look for a later sibling sharing the base name.
  $newer = @()
  $leaf = ($svcName -replace '^.*/', '')
  if ($leaf -match '^(?<base>.*?)(?<year>(19|20)\d{2})(?<tail>.*)$') {
    $base = $Matches['base']; $year = [int]$Matches['year']
    foreach ($cand in (Get-OrgServices $orgRoot)) {
      if ($cand -match ('^' + [regex]::Escape($base) + '(?<y>(19|20)\d{2})')) {
        if ([int]$Matches['y'] -gt $year) { $newer += $cand }
      }
    }
  }

  $rows += [pscustomobject]@{
    Service    = $leaf
    Reachable  = $reachable
    Error      = $err
    LastEdit   = if ($editDate) { $editDate.ToString('yyyy-MM-dd') } else { 'n/a' }
    AgeDays    = $ageDays
    NewerFound = ($newer | Sort-Object -Unique)
  }
}

# --- 2. Decide -------------------------------------------------------------
$unreachable = @($rows | Where-Object { -not $_.Reachable })
$superseded  = @($rows | Where-Object { $_.NewerFound.Count -gt 0 })
$ancient     = @($rows | Where-Object { $_.Reachable -and $_.AgeDays -ne $null -and $_.AgeDays -gt $MaxAgeDays })

if ($Report -or $DryRun) {
  Write-Host ''
  Write-Host ('{0,-42} {1,-10} {2,-12} {3,-8} {4}' -f 'SERVICE','REACHABLE','LAST EDIT','AGE(d)','NEWER VERSION')
  Write-Host ('-' * 110)
  foreach ($r in $rows) {
    Write-Host ('{0,-42} {1,-10} {2,-12} {3,-8} {4}' -f `
      $r.Service, $(if ($r.Reachable) { 'yes' } else { 'NO' }), $r.LastEdit,
      $(if ($null -ne $r.AgeDays) { $r.AgeDays } else { '-' }),
      $(if ($r.NewerFound.Count) { ($r.NewerFound -join ', ') } else { '' }))
  }
  Write-Host ''
  Write-Host "unreachable=$($unreachable.Count)  superseded=$($superseded.Count)  older-than-$MaxAgeDays-days=$($ancient.Count)"
}

$problem = ($unreachable.Count + $superseded.Count + $ancient.Count) -gt 0
if (-not $problem) {
  if (-not $Report) { Write-Host "All $($rows.Count) upstream services current: none unreachable, none superseded, none past $MaxAgeDays days." }
  exit 0
}
if ($Report) { exit 0 }
if ($DryRun) { Write-Host 'DRYRUN - findings above would raise an alert. Nothing sent.'; exit 0 }

# Dedupe -- one reminder per calendar month.
$stampVal = $now.ToString('yyyy-MM')
if ((Test-Path $StampFile) -and ((Get-Content $StampFile -Raw).Trim() -eq $stampVal)) {
  Write-Host "Already reminded this month ($stampVal) -- skipping."
  exit 0
}

$body = @()
$body += "The app's live provincial services need a look.`n"
if ($superseded.Count) {
  $body += 'SUPERSEDED -- a later vintage of this layer is published:'
  foreach ($r in $superseded) { $body += "  $($r.Service)  ->  $($r.NewerFound -join ', ')" }
  $body += ''
  $body += '  Repointing is NOT just a URL change. The 2023 traffic layer kept a stale'
  $body += '  carried-forward `AADT` column and put the current count in `AADT_2023`, so'
  $body += '  swapping the URL alone changed nothing. Diff the field list first, and bump'
  $body += '  the fetch cache key so browsers do not serve the old data from cache.'
  $body += ''
}
if ($unreachable.Count) {
  $body += 'UNREACHABLE -- endpoint erroring or retired:'
  foreach ($r in $unreachable) { $body += "  $($r.Service): $($r.Error)" }
  $body += ''
}
if ($ancient.Count) {
  $body += "QUIET -- no upstream edit in over $MaxAgeDays days (may be fine for a stable reference layer):"
  foreach ($r in $ancient) { $body += "  $($r.Service): last edited $($r.LastEdit) ($($r.AgeDays) days)" }
  $body += ''
}
$body += "Full table:  powershell -ExecutionPolicy Bypass -File `"$root\upstream-vintage-check.ps1`" -Report"
$body += "Checked $($now.ToString('s')) on $env:COMPUTERNAME by upstream-vintage-check.ps1."
$body += "Stop these reminders:  Unregister-ScheduledTask -TaskName mb-parcelsearch-upstream-vintage -Confirm:`$false"

# 2026-08-12: stamp on VERIFIED delivery, not on "something returned true".
# Send-FailureAlert is true when EITHER channel worked, and an anonymous ntfy
# publish returns HTTP 200 for any topic even when nobody is subscribed -- so
# the old `if (Send-FailureAlert ...)` stamped the month even when the email
# failed, and this weekly check then went quiet until the 1st. Test-AlertDelivered
# (alert-lib.ps1) accepts a real email, or push alone when email is not
# configured at all; email configured and failing leaves the stamp alone so next
# week's run alerts again.
$sent = Send-FailureAlert $root $NtfyTopic 'UPSTREAM - provincial service superseded or unreachable' ($body -join "`n")
if (Test-AlertDelivered) {
  New-Item -ItemType Directory -Force -Path (Split-Path $StampFile) | Out-Null
  Set-Content -Path $StampFile -Value $stampVal
  Write-Host "Reminder sent (superseded=$($superseded.Count), unreachable=$($unreachable.Count), quiet=$($ancient.Count))."
  exit 0
} elseif ($sent) {
  Write-Warning ('Reminder went out on PUSH ONLY -- email is configured but FAILED. ' +
                 'Stamp NOT written; the next run will try again. Check the app password.')
  exit 1
} else {
  Write-Warning 'Reminder NOT sent -- no channel succeeded.'
  exit 1
}
