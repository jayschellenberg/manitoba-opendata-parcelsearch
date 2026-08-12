# hpi-download.ps1 -- fetch the newest CREA MLS HPI zip and drop it into the
# residential dashboard's data directory as MLS_HPI_<Month>_<Year>.
#
# Context: ResChartsV2.5.qmd reads CREA MLS HPI from MLS_HPI_<Month>_<Year>
# folders (loader picks the newest); hpi-staleness-check.ps1 nags when that set
# falls behind. This script closes the loop by automating the download that was
# previously manual: it scrapes the HPI tool page for the current
# MLS_HPI-<Month>-<Year>_EN.zip link (CREA publishes ~the 10th of each month),
# downloads it, validates it, and extracts it under the folder-name convention
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
#   * Alert dedupe: at most one alert per calendar month
#     (logs\hpi-download-alert-stamp.txt).
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
$NtfyTopic = 'mbps-hpi-staleness-jks'   # same channel as the HPI watchdog
$LogFile   = Join-Path $root 'logs\hpi-download.log'
$StampFile = Join-Path $root 'logs\hpi-download-alert-stamp.txt'

# Month-name -> number (full + 3-letter, invariant culture, case-insensitive).
$months = @{}
1..12 | ForEach-Object {
  $ci = [System.Globalization.CultureInfo]::InvariantCulture
  $months[$ci.DateTimeFormat.GetMonthName($_).ToLower()]            = $_
  $months[$ci.DateTimeFormat.GetAbbreviatedMonthName($_).ToLower()] = $_
}

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

# Hard-failure alert, deduped to one per calendar month.
function Send-HardFailure([string]$title, [string]$body) {
  $ym = (Get-Date).ToString('yyyyMM')
  if ((Test-Path $StampFile) -and ((Get-Content $StampFile -Raw).Trim() -eq $ym)) {
    Write-Log "ALERT SUPPRESSED (already alerted $ym): $title"
    return
  }
  if (Send-FailureAlert $root $NtfyTopic $title $body) {
    New-Item -ItemType Directory -Force -Path (Split-Path $StampFile) | Out-Null
    Set-Content -Path $StampFile -Value $ym
  }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---- 1. Find the newest MLS_HPI-<Month>-<Year>_EN.zip link on the page -------
try {
  $page = Invoke-WebRequest -Uri $PageUrl -UseBasicParsing -TimeoutSec 60
} catch {
  Write-Log "TRANSIENT: could not fetch $PageUrl ($($_.Exception.Message)). Will retry next run."
  exit 1
}

$best = $null
$rx = [regex]'href="([^"]*MLS_HPI-([A-Za-z]+)-(\d{4})_EN\.zip)"'
foreach ($m in $rx.Matches($page.Content)) {
  $mkey = $m.Groups[2].Value.ToLower()
  if (-not $months.ContainsKey($mkey)) { continue }
  $ym = [int]$m.Groups[3].Value * 12 + $months[$mkey]
  if (-not $best -or $ym -gt $best.YM) {
    $url = $m.Groups[1].Value
    if ($url -notmatch '^https?://') { $url = (New-Object System.Uri((New-Object System.Uri($PageUrl)), $url)).AbsoluteUri }
    $best = @{ YM = $ym; Url = $url; Month = $m.Groups[2].Value; Year = $m.Groups[3].Value }
  }
}

if (-not $best) {
  $msg = "hpi-download.ps1 found NO MLS_HPI-<Month>-<Year>_EN.zip link on $PageUrl -- CREA may have redesigned the page. Manual download + a script fix needed."
  Write-Log "HARD FAIL: $msg"
  if (-not $DryRun) { Send-HardFailure 'HPI download: page parse failed' $msg }
  exit 2
}

$folderName = "MLS_HPI_$($best.Month)_$($best.Year)"
$target     = Join-Path $HpiDir $folderName
Write-Log "Newest on page: $($best.Month) $($best.Year) -> $($best.Url)"

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
  Send-HardFailure 'HPI download: extract/install failed' $msg
  exit 2
}
