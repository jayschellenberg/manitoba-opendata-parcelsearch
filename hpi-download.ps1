# hpi-download.ps1 -- fetch the newest CREA MLS HPI zip and drop it into the
# residential dashboard's data directory as MLS_HPI_<Month>_<Year>.
#
# Context: ResChartsV2.5.qmd reads CREA MLS HPI from MLS_HPI_<Month>_<Year>
# folders (loader picks the newest); hpi-staleness-check.ps1 nags when that set
# falls behind. This script closes the loop by automating the download that was
# previously manual: it scrapes the HPI tool page for the current MLS HPI zip
# link (CREA publishes ~the 10th of each month), downloads it, validates it,
# and extracts it under the folder-name convention
#
# CREA's zip file name DRIFTS month to month -- MLS_HPI_May_2026.zip,
# MLS_HPI-July-2026_EN.zip, MLS_HPI_Aug_2026.zip and MLS_HPI_Sept_2026.zip have
# all been seen. Since 2026-09-15 the page parsing lives in hpi-lib.ps1, shared
# with the watchdog: separators may be hyphen or underscore, _EN is optional,
# and the month token resolves by unambiguous PREFIX so Sep / Sept / September
# are all month 9. The local folder is ALWAYS named with the full month
# (MLS_HPI_September_2026) whatever token the link used. Zip contents unchanged.
#
# 2026-09-15: the 2026-09-04 fix loosened the separators but kept a fixed month
# vocabulary (full + 3-letter only), so MLS_HPI_Sept_2026.zip matched the regex,
# failed the month lookup, was silently skipped, and this script hard-failed
# with "found NO link" while the link was right there. Two consequences, both
# fixed: the parser no longer enumerates spellings (see hpi-lib.ps1), and a link
# that is FOUND but UNREADABLE is now its own failure mode, reported with the
# file name in the alert instead of being flattened into "no link on the page".
#
# The folder-name convention is the one
# BOTH the dashboard glob (MLS_HPI_*) and the watchdog regex
# (^MLS_HPI_<Month>_<Year>$) understand. The raw CREA zip name
# (MLS_HPI-July-2026_EN) matches neither -- which is exactly how the July 2026
# drop went missing despite being downloaded.
#
# Behaviour:
#   * "Mirror the newest zip on the page": no date math. If the newest linked
#     month is already extracted locally, exits 0 without downloading. When
#     CREA publishes a new month, the next daily run picks it up.
#   * Stages download + extraction in %TEMP% and only moves the finished folder
#     into the Dropbox-synced target at the end (Dropbox file locks have killed
#     sibling wrappers mid-write before; see mao-assembly 2026-08-09).
#   * Keeps the original zip inside the new folder for provenance.
#   * Alerts (email + ntfy via alert-lib.ps1, same channel as the HPI watchdog)
#     only on HARD failures: page parse finds no zip link, invalid zip, or
#     extract/move errors. A transient network failure just logs and exits 1 --
#     the daily retry plus the day-25 staleness watchdog are the backstop.
#   * Alert dedupe: at most one alert per calendar month PER REASON
#     (logs\hpi-download-alert-stamp.txt, "<yyyyMM> <reason>").
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File hpi-download.ps1            # real run
#   powershell -ExecutionPolicy Bypass -File hpi-download.ps1 -DryRun    # report only
#   ... -Force                                # re-download even if folder exists
#   ... -HpiDir "<path>"                      # override target directory
#
# Scheduled via schedule_hpi_download.ps1 (daily 08:45, before the 09:00
# staleness check so a fresh drop is visible to the same morning's watchdog).
# ASCII-only on purpose so Windows PowerShell 5.1 parses it without a BOM.

param(
  [string]$HpiDir  = 'D:\Dropbox\Appraisal\RProjects\appraisal-templates\residential',
  [string]$PageUrl = 'https://www.crea.ca/housing-market-stats/mls-home-price-index/hpi-tool/',
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
. (Join-Path $root 'hpi-lib.ps1')   # Get-HpiZipLinks / Get-HpiNewestReadable
$NtfyTopic = 'mbps-hpi-staleness-jks'   # same channel as the HPI watchdog
$LogFile   = Join-Path $root 'logs\hpi-download.log'
$StampFile = Join-Path $root 'logs\hpi-download-alert-stamp.txt'

# Append to the rolling log with retries -- Dropbox can hold a transient lock.
function Write-Log([string]$msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
  Write-Host $line
  if ($DryRun) { return }
  New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
  for ($i = 0; $i -lt 3; $i++) {
    try { Add-Content -Path $LogFile -Value $line -ErrorAction Stop; return }
    catch { Start-Sleep -Seconds 2 }
  }
  Write-Warning "Could not append to $LogFile after 3 tries."
}

# Hard-failure alert, deduped to one per calendar month PER REASON.
#
# 2026-09-15 -- WHY THE REASON IS PART OF THE STAMP. This used to dedupe on the
# bare month, so the FIRST hard failure in a month silenced every later one,
# however different. That is exactly what happened on 2026-09-15: the 09-04
# page-parse failure had already written '202609', so when CREA renamed the zip
# to MLS_HPI_Sept_2026.zip and broke the parser a second time -- a new break,
# with a new cause, needing a new fix -- the alert was suppressed and nobody was
# told for the rest of the month. 'the page moved' turning into 'the download
# arrived but would not extract' is likewise a new and actionable condition, not
# a repeat. hpi-staleness-check.ps1 has stamped per-reason since 2026-08-25 and
# documents the same reasoning; this is the half that never got the fix.
#
# A legacy bare-month stamp reads back as reason 'unknown' and therefore matches
# nothing, so the first run after this change re-sends once -- deliberate: the
# outage it was swallowing is still live.
#
# 2026-08-12: the month stamp is written only on VERIFIED delivery. It used to
# be gated on Send-FailureAlert's boolean, which is true when EITHER channel
# worked -- and Send-AlertPush returns true on any HTTP 200 from ntfy, which an
# anonymous publish gets for any topic even with no subscriber. So a dead SMTP
# path (revoked app password) would still stamp, and this script would then stay
# silent about a broken CREA download for the REST OF THE MONTH. Now: email
# succeeded, or email is not configured at all and push worked -> stamp;
# email configured but failed -> no stamp, so the next daily run alerts again.
# Either way the outcome goes into hpi-download.log, which previously recorded
# nothing about whether the email half worked.
function Send-HardFailure([string]$reason, [string]$title, [string]$body) {
  $ym    = (Get-Date).ToString('yyyyMM')
  $stamp = "$ym $reason"
  $prior = ''
  if (Test-Path $StampFile) {
    $raw   = (Get-Content $StampFile -Raw).Trim()
    $prior = if ($raw -match '^\s*(\d+)\s*$') { "$($Matches[1]) unknown" } else { $raw }
  }
  if ($prior -eq $stamp) {
    Write-Log "ALERT SUPPRESSED (already alerted $ym / $reason): $title"
    return
  }
  $sent = Send-FailureAlert $root $NtfyTopic $title $body
  $s  = $global:MbpsLastAlert
  $ch = "email=$($s.Emailed) push=$($s.Pushed) emailConfigured=$($s.EmailConfigured)"
  if (Test-AlertDelivered) {
    New-Item -ItemType Directory -Force -Path (Split-Path $StampFile) | Out-Null
    Set-Content -Path $StampFile -Value $stamp
    Write-Log "ALERT DELIVERED ($ch): $title -- stamp '$stamp' written."
  } elseif ($sent) {
    Write-Log "ALERT PUSH-ONLY ($ch): $title -- email configured but FAILED, stamp NOT written so the next run retries."
  } else {
    Write-Log "ALERT FAILED on every channel ($ch): $title -- stamp NOT written."
  }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---- 1. Find the newest MLS HPI zip link on the page -------------------------
# Loose on purpose (see header): MLS_HPI[-_]<Month>[-_]<Year>[_EN].zip.
try {
  $page = Invoke-WebRequest -Uri $PageUrl -UseBasicParsing -TimeoutSec 60
} catch {
  Write-Log "TRANSIENT: could not fetch $PageUrl ($($_.Exception.Message)). Will retry next run."
  exit 1
}

# Month normalization to the FULL invariant name happens in the lib, so the
# folder is MLS_HPI_September_2026 whether the link said 'Sep', 'Sept' or
# 'September'.
$links = @(Get-HpiZipLinks $page.Content $PageUrl)
$best  = Get-HpiNewestReadable $links

# Two different failures, two different alerts. Collapsing them into one
# "no link found" is what made 2026-09-15 read as "CREA redesigned the page"
# when in truth the link was sitting there and only its month token was new.
if (-not $best) {
  if ($links.Count -gt 0) {
    $names  = ($links | ForEach-Object { $_.Name }) -join ', '
    $reason = 'links-unreadable'
    $msg    = "hpi-download.ps1 FOUND $($links.Count) MLS_HPI zip link(s) on $PageUrl but could not read a month and year from any of them: $names. CREA has renamed the file into a shape hpi-lib.ps1 does not parse. The data is published and downloadable BY HAND right now; the parser needs the fix."
  } else {
    $reason = 'no-links'
    $msg    = "hpi-download.ps1 found NO MLS_HPI*.zip link of any shape on $PageUrl -- CREA has redesigned the page or moved the download. Manual download + a script fix needed."
  }
  Write-Log "HARD FAIL: $msg"
  if (-not $DryRun) { Send-HardFailure $reason 'HPI download: page parse failed' $msg }
  exit 2
}

$folderName = "MLS_HPI_$($best.Month)_$($best.Year)"
$target     = Join-Path $HpiDir $folderName
# Format is load-bearing: hpi-staleness-check.ps1 reads the month and year back
# out of this exact line as its cheap upstream probe.
Write-Log "Newest on page: $($best.Month) $($best.Year) ($($best.Name)) -> $($best.Url)"

# ---- 2. No-op if that month is already extracted ------------------------------
$need = @('Not Seasonally Adjusted (M).xlsx', 'Seasonally Adjusted (M).xlsx')
$have = (Test-Path $target) -and -not ($need | Where-Object { -not (Test-Path (Join-Path $target $_)) })
if ($have -and -not $Force) {
  Write-Log "Current: $folderName already present with both monthly files. Nothing to do."
  exit 0
}

if ($DryRun) {
  Write-Log "DRYRUN: would download $($best.Url) and extract to $target"
  exit 0
}

# ---- 3. Download + validate + extract in %TEMP% staging -----------------------
$staging = Join-Path $env:TEMP ("hpi-download-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$zipPath = Join-Path $staging (Split-Path $best.Url -Leaf)
try {
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  Invoke-WebRequest -Uri $best.Url -OutFile $zipPath -UseBasicParsing -TimeoutSec 300
} catch {
  Write-Log "TRANSIENT: download failed ($($_.Exception.Message)). Will retry next run."
  Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
  exit 1
}

try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $extractDir = Join-Path $staging $folderName
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
  $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    # Extract ONLY the two monthly files ResChartsV2.5.qmd actually reads. The
    # zip also ships quarterly (Q) and annual (A) variants nothing consumes --
    # they stay inside the provenance zip kept below, not loose in the folder.
    foreach ($f in $need) {
      $entry = $zip.Entries | Where-Object { $_.FullName -eq $f }
      if (-not $entry) { throw "zip is missing expected entry '$f'" }
      if ($entry.Length -lt 500kb) { throw "zip entry '$f' is suspiciously small ($($entry.Length) bytes)" }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $extractDir $f))
    }
  } finally { $zip.Dispose() }
  Move-Item -Path $zipPath -Destination $extractDir    # keep the zip as provenance (incl. Q/A files)

  # ---- 4. Swap into place ----------------------------------------------------
  $old = $null
  if (Test-Path $target) {
    $old = "$target.replaced-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item -Path $target -Destination $old
  }
  Move-Item -Path $extractDir -Destination $target
  if ($old) { Remove-Item -Recurse -Force $old }
  Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue

  Write-Log "OK: downloaded and extracted $folderName ($((Get-ChildItem $target).Count) files) into $HpiDir"
  exit 0
} catch {
  $msg = "hpi-download.ps1 downloaded $($best.Url) but failed to validate/extract/install it: $($_.Exception.Message). Staging left at $staging for inspection."
  Write-Log "HARD FAIL: $msg"
  Send-HardFailure 'extract-install' 'HPI download: extract/install failed' $msg
  exit 2
}
