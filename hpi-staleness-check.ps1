# hpi-staleness-check.ps1 -- remind (email + ntfy push) when the Winnipeg MLS
# HPI data behind the residential appraisal dashboard goes stale.
#
# Context: the residential dashboard (ResCharts.qmd / ResChartsStatic.qmd) reads
# CREA MLS HPI from MLS_HPI_<Month>_<Year> folders (the loader auto-picks the
# newest one). Since 2026-08-12 the monthly download is automated by
# hpi-download.ps1 (daily 08:45 task mb-parcelsearch-hpi-download); this check
# remains the independent BACKSTOP.
#
# THE FOLDER LABEL IS CREA'S RELEASE MONTH, NOT THE DATA MONTH.
#   MLS_HPI_July_2026  ==  CREA's MLS_HPI-July-2026_EN.zip  ==  data through JUNE 2026.
# (CREA's zip file name drifts month to month -- MLS_HPI_May_2026.zip,
# MLS_HPI-July-2026_EN.zip, MLS_HPI_Aug_2026.zip -- so since 2026-09-04 the
# page parser below accepts any of those forms; the LOCAL folder is always
# MLS_HPI_<FullMonth>_<Year>.)
# Verified 2026-08-25: that zip's WINNIPEG sheet ends at serial 46174 (2026-06-01),
# the workbook was built 2026-07-02, and the live file's Last-Modified is
# Tue 14 Jul 2026 -- i.e. CREA posts release month M around the 14th of M,
# carrying M-1 data. Every month this script names, it now names BOTH ways,
# because "expected through August 2026" read as a DATA month is impossible
# (August data cannot exist in August) and the reminder gets dismissed as a bug.
# It is not a bug: the August RELEASE carries JULY data and is due ~Aug 14.
#
# WHAT THIS SCRIPT COULD NOT SEE BEFORE 2026-08-25: whether CREA had actually
# published the release it was asking for. "Stale" was judged against the
# CALENDAR alone, so a late CREA release and a broken download produced the
# identical actionable-sounding email -- and on 2026-08-25 it asked for a file
# that returned 404. It now establishes UPSTREAM state first (from
# hpi-download.log, else by reading CREA's page itself) and says which of these
# is true:
#
#   download-missing   CREA has it, we do not      -> action needed, here is how
#   parser-broken      CREA has a zip we cannot read -> action needed, fix the parser
#   upstream-late      we have all CREA has        -> FYI only, nothing to do
#   upstream-regressed CREA's newest is OLDER      -> odd, worth a human look
#   upstream-unknown   could not reach either      -> say so, do not guess
#
# WHY parser-broken EXISTS (2026-09-15). This check used to run "the same page
# and the same regex hpi-download.ps1 uses -- deliberately, so the two scripts
# can never disagree about what 'newest on the page' means." That sentence was
# the bug. When CREA renamed the zip to MLS_HPI_Sept_2026.zip, the shared parser
# could not read 'Sept', so the downloader hard-failed AND this backstop -- using
# the identical parser -- concluded the page held nothing, reported
# 'upstream-unknown', and could not reach the actionable download-missing branch
# at all. Two layers of defence, one shared blind spot, zero useful alarms.
#
# A backstop that shares the primary's parser is not a backstop. So the upstream
# probe now looks for MLS_HPI*.zip links of ANY shape (hpi-lib.ps1,
# Get-HpiZipLinks) and treats "links present, none readable" as its own
# actionable state -- a judgement that needs no agreement about month spellings,
# which is exactly why it survives the parser being wrong. It fires immediately,
# not on GraceDay: a stopped pipeline should not wait ten days to be mentioned.
#
# Robustness:
#   * Staleness is judged from the FOLDER NAME (month+year), NOT the timestamp.
#     Dropbox re-syncs reset mtimes, so a timestamp check would be unreliable.
#     (The dashboard's own resolvers sorted by file.mtime until 2026-09-15 --
#     the exposure this note used to describe -- and now rank by folder name
#     through one shared res_hpi_newest_dir() in appraisal-templates'
#     ResCharts_engine.R, called by both it and ResChartsStatic.qmd. Pinned by
#     residential/tests/test_res_hpi_resolver.R. So more than one MLS_HPI_*
#     folder on disk is no longer a hazard here or there.)
#   * A stamp file (logs\hpi-alert-stamp.txt) dedupes so it sends at most ONE
#     reminder per expected month PER REASON. The reason is part of the stamp on
#     purpose: "CREA is late" turning into "the download failed" is a new and
#     actionable condition, and a month-only stamp would have swallowed it.
#     A legacy month-only stamp counts as reason 'unknown', so the first run
#     after this change re-sends once with the clearer wording.
#   * Reuses the shared alert stack (alert-lib.ps1 + alert-email.local.txt).
#
# Rule:
#   expected release = current month  if today.Day >= GraceDay
#                      previous month  otherwise
#   stale            = newest MLS_HPI_<Mon>_<Year> is older than 'expected'
#   ALSO alerts, whatever the calendar says, when CREA's newest published
#   release is newer than the newest folder on disk -- that is a failed download
#   and there is no reason to sit on it until day 25.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File hpi-staleness-check.ps1              # real check
#   powershell -ExecutionPolicy Bypass -File hpi-staleness-check.ps1 -Preview     # classify + print, send nothing
#   powershell -ExecutionPolicy Bypass -File hpi-staleness-check.ps1 -TestAlert   # send a test alert and exit
#   ... -HpiDir "<path>" -GraceDay 25                                             # overrides
#
# Scheduled via schedule_hpi_check.ps1 (daily; the grace-day + stamp keep it to
# one reminder per month). ASCII-only on purpose so Windows PowerShell 5.1
# parses it without a BOM.

param(
  [string]$HpiDir     = 'D:\Dropbox\Appraisal\RProjects\appraisal-templates\residential',
  [int]$GraceDay      = 25,
  [string]$PageUrl    = 'https://www.crea.ca/housing-market-stats/mls-home-price-index/hpi-tool/',
  # CREA's observed posting day within its release month (July 2026 zip:
  # Last-Modified Tue 14 Jul 2026 19:39 GMT). Used only to say how overdue a
  # missing release is, never to decide staleness.
  [int]$ReleaseDay    = 14,
  # How fresh hpi-download.log's "Newest on page" line must be to be trusted
  # instead of re-reading CREA's page. The downloader runs 08:45, this at 09:00.
  [int]$LogMaxAgeDays = 3,
  [switch]$TestAlert,
  [switch]$Preview
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
. (Join-Path $root 'hpi-lib.ps1')   # Get-HpiMonthNumber / Get-HpiZipLinks
$NtfyTopic = 'mbps-hpi-staleness-jks'   # public namespace; carries no secrets
$StampFile = Join-Path $root 'logs\hpi-alert-stamp.txt'
$DlLogFile = Join-Path $root 'logs\hpi-download.log'

# ---- Month arithmetic on the year*12+month key -------------------------------
# Inverse of ($year * 12 + $month). Written out because ($ym % 12) maps December
# to 0 and would label it as month zero of the following year.
function Get-YmDate([int]$ym) {
  $y = [math]::Floor(($ym - 1) / 12)
  $m = $ym - ($y * 12)
  return (Get-Date -Year $y -Month $m -Day 1 -Hour 0 -Minute 0 -Second 0)
}
function Get-YmLabel([int]$ym) { (Get-YmDate $ym).ToString('MMMM yyyy') }

# The one formatting rule this script exists to enforce: never name a release
# month without naming the data month inside it.
function Get-ReleaseLabel([int]$ym) {
  "{0} release (data through {1})" -f (Get-YmLabel $ym), (Get-YmLabel ($ym - 1))
}

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - HPI staleness reminder' `
    ("Test reminder from hpi-staleness-check.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
     'If this reached you, Winnipeg MLS HPI staleness reminders are wired up.')
  if ($ok) { exit 0 } else { exit 1 }
}

# ---- 1. Newest MLS_HPI_<Month>_<Year> folder, by parsed name -----------------
$best = $null
Get-ChildItem -Path $HpiDir -Directory -Filter 'MLS_HPI_*' -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Name -match '^MLS_HPI_([A-Za-z]+)_(\d{4})$') {
    $mn = Get-HpiMonthNumber $Matches[1]
    if ($mn -gt 0) {
      $ym = [int]$Matches[2] * 12 + $mn
      if (-not $best -or $ym -gt $best.YM) { $best = @{ YM = $ym } }
    }
  }
}

# ---- 2. What has CREA actually published? ------------------------------------
# Cheap path first: hpi-download.ps1 logs "Newest on page: <Month> <Year>" every
# morning at 08:45, fifteen minutes before this runs, so its answer is normally
# both current and free. Fall back to reading the page only when that line is
# missing or has gone stale (downloader task disabled, machine asleep, ...).
function Get-UpstreamRelease {
  if (Test-Path $DlLogFile) {
    # Both the last good answer AND the last hard failure, with their times. A
    # "Newest on page" line older than the newest HARD FAIL is a cached answer
    # from before the downloader broke -- trusting it on 2026-09-15 would have
    # reported August as CREA's newest (matching what is on disk) and produced a
    # cheerful "nothing to do" while the pipeline was down. The freshness window
    # alone does not catch this: that stale line was only a day old.
    $hit    = $null
    $failAt = [datetime]::MinValue
    foreach ($line in (Get-Content $DlLogFile -ErrorAction SilentlyContinue)) {
      if ($line -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+Newest on page:\s+([A-Za-z]+)\s+(\d{4})') {
        $hit = @{ When = $Matches[1]; Mon = $Matches[2]; Yr = [int]$Matches[3] }
      }
      elseif ($line -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+HARD FAIL:') {
        $t = [datetime]::MinValue
        if ([datetime]::TryParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss',
              [System.Globalization.CultureInfo]::InvariantCulture,
              [System.Globalization.DateTimeStyles]::None, [ref]$t)) { $failAt = $t }
      }
    }
    if ($hit) {
      $mn = Get-HpiMonthNumber $hit.Mon
      if ($mn -gt 0) {
        $when = [datetime]::MinValue
        if ([datetime]::TryParseExact($hit.When, 'yyyy-MM-dd HH:mm:ss',
              [System.Globalization.CultureInfo]::InvariantCulture,
              [System.Globalization.DateTimeStyles]::None, [ref]$when)) {
          if ((((Get-Date) - $when).TotalDays -le $LogMaxAgeDays) -and ($when -gt $failAt)) {
            return @{ YM     = $hit.Yr * 12 + $mn
                      Source = "hpi-download.log, checked $($hit.When)" }
          }
        }
      }
    }
  }

  # Read the page INDEPENDENTLY of the downloader's month parsing. Every
  # MLS_HPI*.zip href counts as a link here, readable or not: "CREA published
  # something we cannot parse" is a conclusion this script must be able to reach
  # on its own, and it cannot reach it through the same filter that just failed.
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $page = Invoke-WebRequest -Uri $PageUrl -UseBasicParsing -TimeoutSec 60
  } catch {
    return @{ YM = 0; Source = $null; Error = $_.Exception.Message }
  }
  $links = @(Get-HpiZipLinks $page.Content $PageUrl)
  $up    = Get-HpiNewestReadable $links
  if ($up) { return @{ YM = $up.YM; Source = "crea.ca, checked just now" } }
  if ($links.Count -gt 0) {
    return @{ YM           = 0
              Source       = $null
              ParserBroken = $true
              Unreadable   = (($links | ForEach-Object { $_.Name }) -join ', ')
              Error        = "$($links.Count) MLS_HPI zip link(s) on the page, none with a readable month and year" }
  }
  return @{ YM = 0; Source = $null; Error = "no MLS_HPI*.zip link of any shape found on $PageUrl" }
}

$upstream = Get-UpstreamRelease
$upYM     = [int]$upstream.YM          # 0 == unknown

$now      = Get-Date
$expDate  = if ($now.Day -ge $GraceDay) { $now } else { $now.AddMonths(-1) }
$expYM    = $expDate.Year * 12 + $expDate.Month

$localYM  = if ($best) { [int]$best.YM } else { 0 }
$localTxt = if ($localYM) { Get-ReleaseLabel $localYM } else { '(no MLS_HPI_* folder found)' }
$upTxt    = if ($upYM)    { Get-ReleaseLabel $upYM }    else { '(could not determine)' }

# ---- 3. Classify -------------------------------------------------------------
# Three independent triggers. The calendar one is the original backstop. The
# behind-upstream one fires the moment CREA is ahead of us, because waiting
# until day 25 to mention a download that silently stopped working is the
# weakness this whole change is about. The ahead-of-upstream one is separate
# because a folder naming a release CREA has never published is wrong even
# when the calendar is perfectly happy -- and a calendar-only guard let exactly
# that case exit "No reminder" while the upstream-regressed branch below sat
# unreachable.
$staleByCalendar = ($localYM -lt $expYM)
$behindUpstream  = ($upYM -gt 0 -and $upYM -gt $localYM)
$aheadOfUpstream = ($upYM -gt 0 -and $upYM -lt $localYM)
# Independent of all three, and of the calendar: CREA is publishing a zip whose
# name we cannot parse. The download is stopped NOW, whatever day of the month
# it is, so this trigger does not wait for GraceDay.
$parserBroken    = [bool]$upstream.ParserBroken

if (-not $staleByCalendar -and -not $behindUpstream -and -not $aheadOfUpstream -and -not $parserBroken) {
  Write-Host "HPI current: newest folder = $localTxt; expected through $(Get-ReleaseLabel $expYM); CREA's newest = $upTxt. No reminder."
  exit 0
}

# The release we are actually short of: whatever CREA has, else what the
# calendar says we ought to have by now.
$wantYM  = if ($upYM -gt $localYM) { $upYM } else { $expYM }
$wantTxt = Get-ReleaseLabel $wantYM
$needName = "MLS_HPI_$((Get-YmDate $wantYM).ToString('MMMM'))_$((Get-YmDate $wantYM).Year)"

$manual = @"
To do it by hand:
  1. Download the Winnipeg MLS HPI zip for the $(Get-YmLabel $wantYM) release from
     $PageUrl
     (the zip for the $((Get-YmDate $wantYM).ToString('MMMM')) $((Get-YmDate $wantYM).Year) release -- CREA's file name
     drifts month to month, e.g. MLS_HPI_Aug_2026.zip), and take BOTH
     'Not Seasonally Adjusted (M).xlsx' and 'Seasonally Adjusted (M).xlsx' out of it.
  2. Create a folder named  $needName  in
     $HpiDir
     and put the two .xlsx files in it. That folder name is CREA's RELEASE month;
     the numbers inside it run through $(Get-YmLabel ($wantYM - 1)).
  3. Re-render the residential dashboard (ResCharts.qmd, or ResChartsStatic.qmd
     for the exhibit) -- the loader auto-selects the newest folder.
"@

$facts = @"
  Newest folder present : $localTxt
  Expected through      : $(Get-ReleaseLabel $expYM)
  CREA's newest release : $upTxt
  Upstream checked via  : $(if ($upstream.Source) { $upstream.Source } else { "FAILED -- $($upstream.Error)" })
  Location              : $HpiDir
"@

if ($parserBroken) {
  $reason = 'parser-broken'
  $title  = 'Action needed: CREA renamed the MLS HPI zip and the download parser cannot read it'
  $body   = @"
CREA IS publishing an MLS HPI zip -- this check can see the link -- but neither
this script nor hpi-download.ps1 can read a release month out of its file name,
so the daily download is stopped until the parser is taught the new shape.

Link(s) found, none readable:
  $($upstream.Unreadable)

$facts

This is a code fix, not a CREA outage and not a missed run. The name shape
hpi-lib.ps1 accepts is MLS_HPI<-or_><Month><-or_><Year>[_EN].zip, where <Month>
is any unambiguous prefix of a month name (Sep, Sept and September all work).
Something outside that shape is on the page now.

  1. Look at the name(s) above and widen Get-HpiZipLinks / Get-HpiMonthNumber in
     $root\hpi-lib.ps1 to cover it.
  2. hpi-lib.tests.ps1 is where the new shape gets pinned so it cannot regress.
  3. Then:  powershell -ExecutionPolicy Bypass -File "$root\hpi-download.ps1"

Meanwhile the data itself is published and fine to take by hand. Do NOT use the
release month this script guesses from the calendar -- it cannot read the real
one. Use the month in the file name above:

  1. Download that zip from
     $PageUrl
     and take BOTH 'Not Seasonally Adjusted (M).xlsx' and
     'Seasonally Adjusted (M).xlsx' out of it.
  2. Create a folder named  MLS_HPI_<FullMonth>_<Year>  -- full month name, e.g.
     MLS_HPI_September_2026 for a zip named MLS_HPI_Sept_2026.zip -- in
     $HpiDir
     and put the two .xlsx files in it. That folder name is CREA's RELEASE
     month; the numbers inside it run through the month before.
  3. Re-render the residential dashboard (ResCharts.qmd, or ResChartsStatic.qmd
     for the exhibit) -- the loader auto-selects the newest folder.
"@
}
elseif ($upYM -eq 0) {
  $reason = 'upstream-unknown'
  $title  = "Reminder: Winnipeg MLS HPI is stale (need the $(Get-YmLabel $wantYM) release)"
  $body   = @"
The residential dashboard's CREA MLS HPI data is behind, and this check could NOT
determine whether CREA has published the release it is missing -- so this may be a
failed download or simply a late release. Check the page by hand before assuming.

$facts

$manual
"@
}
elseif ($upYM -gt $localYM) {
  $reason = 'download-missing'
  $late   = [int]((Get-Date) - (Get-YmDate $wantYM).AddDays($ReleaseDay - 1)).TotalDays
  $title  = "Action needed: Winnipeg MLS HPI download did not land ($(Get-YmLabel $wantYM) release)"
  $body   = @"
CREA HAS published the $wantTxt,
but the residential dashboard does not have it.
This is a failed or missed download, not a late release -- hpi-download.ps1 should
have installed it$(if ($late -gt 0) { " about $late day(s) ago" } else { "" }).

$facts

First place to look: $DlLogFile
(and logs\hpi-download-alert-stamp.txt, which suppresses that script's own alerts
to one per calendar month PER REASON). Common causes: the mb-parcelsearch-hpi-download task
is disabled or the machine was asleep at 08:45, a run of transient network
failures, or Dropbox holding a lock on the target folder during the move.

Re-run it now:
  powershell -ExecutionPolicy Bypass -File "$root\hpi-download.ps1"

$manual
"@
}
elseif ($upYM -lt $localYM) {
  $reason = 'upstream-regressed'
  $title  = "Odd: CREA's newest MLS HPI release is OLDER than the folder on disk"
  $body   = @"
This should not happen and is worth a human look. The dashboard holds a newer
release than CREA is currently publishing -- either CREA pulled or renamed a
release, or a MLS_HPI_* folder on disk was created by hand with the wrong name.

$facts

Nothing has been changed. Compare the folder against
$PageUrl
before the next download runs.
"@
}
else {
  # upYM -eq $localYM: we hold everything CREA has published. Nothing to do, and
  # saying "download the latest" here is exactly the false instruction that sent
  # this check's 2026-08-25 email chasing a 404.
  $reason = 'upstream-late'
  $late   = [int]((Get-Date) - (Get-YmDate $expYM).AddDays($ReleaseDay - 1)).TotalDays
  $title  = "FYI: CREA has not published the $(Get-YmLabel $expYM) MLS HPI release yet"
  $body   = @"
NOTHING TO DO -- this is CREA's delay, not a missed download. The residential
dashboard already holds every release CREA has published.

$facts

$(if ($late -gt 0) {
"CREA posts a release around the ${ReleaseDay}th of its own month, so the
$(Get-YmLabel $expYM) release (which would carry $(Get-YmLabel ($expYM - 1)) data) is roughly
$late day(s) overdue."
} else {
"CREA posts a release around the ${ReleaseDay}th of its own month."
})

Practical effect: the dashboard's HPI series ends $(Get-YmLabel ($localYM - 1)). Worth knowing
before it goes into a report; there is no way to make it newer today.

hpi-download.ps1 checks daily at 08:45 and will install the release the morning it
appears. No further reminder for the $(Get-YmLabel $expYM) release unless something changes.
"@
}

$body = $body + @"


Checked $($now.ToString('s')) on $env:COMPUTERNAME by hpi-staleness-check.ps1 (reason: $reason).
Stop these reminders:  Unregister-ScheduledTask -TaskName mb-parcelsearch-hpi-staleness -Confirm:`$false
"@

# ---- 4. Dedupe -- one reminder per expected month PER REASON ------------------
# Stamp format: "<expYM> <reason>". A legacy stamp is the bare number, which
# reads back as reason 'unknown' and therefore matches nothing -- deliberate, so
# the first run after this change re-sends once with the corrected wording.
$stampValue = "$expYM $reason"
$stampPrior = ''
if (Test-Path $StampFile) {
  $raw = (Get-Content $StampFile -Raw).Trim()
  $stampPrior = if ($raw -match '^\s*(\d+)\s*$') { "$($Matches[1]) unknown" } else { $raw }
}
$suppressed = ($stampPrior -eq $stampValue)

if ($Preview) {
  Write-Host "---- PREVIEW (nothing sent, no stamp written) ----"
  Write-Host "reason      : $reason"
  Write-Host "stale (cal) : $staleByCalendar    behind upstream: $behindUpstream    parser broken: $parserBroken"
  Write-Host "stamp now   : '$stampPrior'   would write: '$stampValue'   -> $(if ($suppressed) { 'SUPPRESSED' } else { 'WOULD SEND' })"
  Write-Host "title       : $title"
  Write-Host "---- body ----"
  Write-Host $body
  exit 0
}

if ($suppressed) {
  Write-Host "Already reminded for $(Get-YmLabel $expYM) / $reason -- skipping."
  exit 0
}

# 2026-08-12: stamp on VERIFIED delivery, not on "something returned true".
# Send-FailureAlert is true when EITHER channel worked, and ntfy answers HTTP 200
# for any topic whether or not anyone subscribes -- so the old
# `if (Send-FailureAlert ...)` wrote this month's stamp even when the email
# never left the building, then suppressed the reminder for the rest of the
# month. Test-AlertDelivered (alert-lib.ps1) accepts a real email, or push alone
# when email is not configured at all; when email IS configured and failed it
# leaves the stamp untouched on purpose so the next daily run tries again.
$sent = Send-FailureAlert $root $NtfyTopic $title $body
if (Test-AlertDelivered) {
  New-Item -ItemType Directory -Force -Path (Split-Path $StampFile) | Out-Null
  Set-Content -Path $StampFile -Value $stampValue
  Write-Host "Reminder sent for $(Get-YmLabel $expYM) / $reason (latest present: $localTxt)."
  exit 0
} elseif ($sent) {
  Write-Warning ('Reminder went out on PUSH ONLY -- email is configured but FAILED. ' +
                 'Stamp NOT written; the next run will try again. Check the app password.')
  exit 1
} else {
  Write-Warning 'Reminder NOT sent -- no channel succeeded.'
  exit 1
}
