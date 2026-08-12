# history-staleness-check.ps1 -- dead-man's switch for the semiannual parcel
# history publish (email + ntfy push when the newest mb-parcel-history
# snapshot is overdue).
#
# Context: mb-parcelsearch-semiannual-archive fires semiannual-publish-wrapper.ps1 on Jan 1 /
# Jul 1 and alerts if a STEP fails -- but if the task itself never starts
# (schedule rot, machine reimaged, wrapper moved), nothing runs and nothing
# alerts. This daily check closes that hole from the outside: it only reads
# what the publish leaves behind, so every failure mode -- including "nothing
# ran at all" -- eventually becomes an email.
#
# Two ages are checked (both from SNAPSHOT DATES in names/index, never mtimes
# -- Dropbox re-syncs reset mtimes):
#   * BUILT     : newest YYYY-MM-DD dir (with manifest.json) in the local
#                 mb-parcel-history clone.
#   * PUBLISHED : newest snapshot in index.json AS OF THE COMMIT the app pins
#                 (web/src/arcgis.js mb-parcel-history@<sha>, read via
#                 `git show <sha>:index.json` -- offline, exact). Catches
#                 "built but never repointed/redeployed".
# Stale = either age > MaxAgeDays. Cadence is ~182-184 days (Jan 1 / Jul 1),
# so the 215-day default alerts about a month after a missed run.
#
# Robustness:
#   * A stamp file (logs\history-alert-stamp.txt) dedupes to at most ONE
#     reminder per calendar month, even though the task runs daily.
#   * The PUBLISHED check is best-effort: if the pin or git read fails, that
#     is reported inside a staleness alert but never invents one by itself
#     unless the BUILT side is also missing/stale? -- no: an unreadable pin
#     with a FRESH build is a config nit, not an emergency; it is surfaced
#     only when an alert is already being sent.
#   * Reuses the shared alert stack (alert-lib.ps1 + alert-email.local.txt)
#     and the semiannual job's existing ntfy topic, so no new subscription.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File history-staleness-check.ps1             # real check
#   powershell -ExecutionPolicy Bypass -File history-staleness-check.ps1 -DryRun     # decide + print, never send
#   powershell -ExecutionPolicy Bypass -File history-staleness-check.ps1 -TestAlert  # send a test alert and exit
#   ... -MaxAgeDays 215 -HistRepo "<path>"                                           # overrides
#
# Scheduled via schedule_history_check.ps1 (daily; stamp keeps it to one
# reminder per month). ASCII-only on purpose so Windows PowerShell 5.1 parses
# it without a BOM.

param(
  [string]$HistRepo = $(if ($env:MB_PARCEL_HISTORY_ROOT) { $env:MB_PARCEL_HISTORY_ROOT }
                        else { 'D:\Dropbox\ClaudeCode\MBOpenData\mb-parcel-history' }),
  [int]$MaxAgeDays  = 215,
  [switch]$TestAlert,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
$NtfyTopic = 'mbps-semiannual-archive-jks'   # same topic as the publish wrapper -- existing subscription keeps working
$StampFile = Join-Path $root 'logs\history-alert-stamp.txt'
$ArcgisJs  = Join-Path $root 'web\src\arcgis.js'

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - parcel-history staleness watchdog' `
    ("Test alert from history-staleness-check.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
     'If this reached you, the semiannual-snapshot dead-man watchdog is wired up.')
  if ($ok) { exit 0 } else { exit 1 }
}

$now = Get-Date

# --- BUILT: newest dated snapshot dir in the local data repo ---------------
$builtLabel = '(none found)'
$builtAge   = $null
if (Test-Path $HistRepo) {
  $snapDirs = Get-ChildItem -Path $HistRepo -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' -and
                   (Test-Path (Join-Path $_.FullName 'manifest.json')) } |
    Sort-Object Name -Descending
  if ($snapDirs) {
    $builtLabel = $snapDirs[0].Name
    $builtAge   = [int]($now.Date - [datetime]::ParseExact($builtLabel, 'yyyy-MM-dd', $null)).TotalDays
  }
} else {
  $builtLabel = "(repo missing: $HistRepo)"
}

# --- PUBLISHED: newest snapshot in index.json at the app's pinned commit ----
# Best-effort; $pubAge stays $null when unreadable and is only reported, never
# alerted on alone (a fresh build with a broken pin-read is a nit, and the
# wrapper already alerts loudly when the repin step itself fails).
$pubLabel = '(unreadable)'
$pubAge   = $null
try {
  $pin = $null
  if (Test-Path $ArcgisJs) {
    $m = [regex]::Match((Get-Content -Raw $ArcgisJs), 'mb-parcel-history@([0-9a-f]{40})')
    if ($m.Success) { $pin = $m.Groups[1].Value }
  }
  if ($pin) {
    $idxRaw = & git -C $HistRepo show "${pin}:index.json" 2>$null
    if ($LASTEXITCODE -eq 0 -and $idxRaw) {
      $idx = ($idxRaw -join "`n") | ConvertFrom-Json
      $names = @($idx.snapshots.PSObject.Properties.Name |
                 Where-Object { $_ -match '^\d{4}-\d{2}-\d{2}$' } | Sort-Object -Descending)
      if ($names.Count -gt 0) {
        $pubLabel = "$($names[0]) @ $($pin.Substring(0,7))"
        $pubAge   = [int]($now.Date - [datetime]::ParseExact($names[0], 'yyyy-MM-dd', $null)).TotalDays
      }
    }
  } else {
    $pubLabel = '(no mb-parcel-history@<sha> pin found in arcgis.js)'
  }
} catch { $pubLabel = "(pin check failed: $($_.Exception.Message))" }

# --- decide -----------------------------------------------------------------
$builtStale = ($null -eq $builtAge) -or ($builtAge -gt $MaxAgeDays)
$pubStale   = ($null -ne $pubAge)   -and ($pubAge   -gt $MaxAgeDays)
$stale      = $builtStale -or $pubStale

$builtDesc = if ($null -ne $builtAge) { "$builtLabel ($builtAge days old)" } else { $builtLabel }
$pubDesc   = if ($null -ne $pubAge)   { "$pubLabel ($pubAge days old)" }     else { $pubLabel }

if (-not $stale) {
  Write-Host "Parcel history current: built $builtDesc; published $pubDesc; threshold $MaxAgeDays days. No reminder."
  exit 0
}

if ($DryRun) {
  Write-Host "DRYRUN - STALE detected (threshold $MaxAgeDays days). Built: $builtDesc. Published: $pubDesc. No alert sent."
  exit 0
}

# Dedupe -- one reminder per calendar month.
$stampVal = $now.ToString('yyyy-MM')
if ((Test-Path $StampFile) -and ((Get-Content $StampFile -Raw).Trim() -eq $stampVal)) {
  Write-Host "Already reminded this month ($stampVal) -- skipping."
  exit 0
}

$why = @()
if ($builtStale) { $why += "the newest BUILT snapshot is $builtDesc" }
if ($pubStale)   { $why += "the newest PUBLISHED (app-pinned) snapshot is $pubDesc" }

$title = 'STALE - MB parcel history snapshot overdue'
$body  = @"
The semiannual parcel-history snapshot looks overdue: $($why -join '; ').

  Newest built     : $builtDesc
  Newest published : $pubDesc
  Threshold        : $MaxAgeDays days (cadence is ~182-184: Jan 1 / Jul 1)
  Data repo        : $HistRepo

The mb-parcelsearch-semiannual-archive task (Jan 1 / Jul 1, 04:30) probably did not run,
or the publish failed before committing. To investigate:

  1. Get-ScheduledTask -TaskName mb-parcelsearch-semiannual-archive | Get-ScheduledTaskInfo
     (check LastRunTime / LastTaskResult / NextRunTime)
  2. Check the newest $root\logs\publish-*.log for a failed step.
  3. Run the publish by hand:
     powershell -ExecutionPolicy Bypass -File "$root\semiannual-publish-wrapper.ps1"

Checked $($now.ToString('s')) on $env:COMPUTERNAME by history-staleness-check.ps1.
Stop these reminders:  Unregister-ScheduledTask -TaskName mb-parcelsearch-history-staleness -Confirm:`$false
"@

# 2026-08-12: stamp on VERIFIED delivery, not on "something returned true".
# Send-FailureAlert is true when EITHER channel worked, and an anonymous ntfy
# publish returns HTTP 200 for any topic even with zero subscribers -- so the
# old `if (Send-FailureAlert ...)` recorded this month as reminded even when the
# email failed, and then suppressed the reminder for the rest of the month. This
# is the watchdog for a snapshot that only runs twice a year, so a month of
# silence here is expensive. Test-AlertDelivered (alert-lib.ps1) accepts a real
# email, or push alone when email is not configured at all; email configured and
# failing deliberately leaves the stamp alone so tomorrow's run retries.
$sent = Send-FailureAlert $root $NtfyTopic $title $body
if (Test-AlertDelivered) {
  New-Item -ItemType Directory -Force -Path (Split-Path $StampFile) | Out-Null
  Set-Content -Path $StampFile -Value $stampVal
  Write-Host "Reminder sent (built: $builtDesc; published: $pubDesc)."
  exit 0
} elseif ($sent) {
  Write-Warning ('Reminder went out on PUSH ONLY -- email is configured but FAILED. ' +
                 'Stamp NOT written; the next run will try again. Check the app password.')
  exit 1
} else {
  Write-Warning 'Reminder NOT sent -- no channel succeeded.'
  exit 1
}
