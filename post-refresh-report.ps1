# post-refresh-report.ps1 -- report what the monthly automation ACTUALLY did,
# on success as well as failure.
#
# Why this exists: as of 2026-08-12 the three heavyweight scheduled tasks
# (mb-parcelsearch-monthly-refresh, -publish-indexes, -semiannual-archive) have
# never once fired. Every successful refresh and publish in this project's
# history was a manual run. The existing alerting is failure-only and
# exit-code-driven, which is the right default for steady state but tells you
# nothing on a first run: a silent morning could mean "worked perfectly" or
# "task never started", and those are the two outcomes you most need to
# distinguish. This sends one plain-language summary either way.
#
# It is READ-ONLY: reads task state, logs, git metadata. It never rebuilds,
# commits, pushes or repins.
#
# Intended use: a RECURRING monthly scheduled task on the 15th at 08:00 -- see
# schedule_post_refresh_report.ps1 -- landing after the 04:00 refresh and 04:30
# publish have finished.
#
# 2026-08-12: that task was a ONE-SHOT for 2026-08-15 08:00, registered as a
# first-run confidence check. It was made monthly because section 3 below is the
# only automated check anywhere that the CDN pin advanced to match
# mb-parcel-data HEAD; as a one-shot, that check would have run once and every
# later refresh would have gone back to unwatched. Nothing in this script
# changed -- it was already idempotent and already reported either way.
#
# Also useful on demand:
#   powershell -ExecutionPolicy Bypass -File post-refresh-report.ps1 -Console
#
# Switches:
#   -Console          print the report instead of sending it (no alert fired)
#   -Date yyyyMMdd    which day's logs to look for (default: today)
#   -TestAlert        send a test through the alert path and exit
#
# ASCII-only on purpose so Windows PowerShell 5.1 parses it without a BOM.

param(
  [string]$Date = (Get-Date -Format 'yyyyMMdd'),
  [switch]$Console,
  [switch]$TestAlert
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')
$NtfyTopic = 'mbps-monthly-refresh-jks'   # same topic as the refresh wrapper

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - MB parcel post-refresh report' `
    ("Test from post-refresh-report.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).")
  if ($ok) { exit 0 } else { exit 1 }
}

$L = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$s) { $L.Add($s) }

Add-Line "Monthly automation report for $Date on $env:COMPUTERNAME"
Add-Line ("Generated {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Add-Line ''

# ---- 1. Did the tasks fire, and with what result? ----------------------------
Add-Line '== SCHEDULED TASKS =='
$NEVER_RUN = 267011   # 0x41303 "task has not yet run"
$anyProblem = $false
foreach ($t in @('mb-parcelsearch-monthly-refresh', 'mb-parcelsearch-publish-indexes')) {
  $info = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue |
          Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
  if (-not $info) { Add-Line ("  {0}: NOT REGISTERED" -f $t); $anyProblem = $true; continue }
  $res = $info.LastTaskResult
  $verdict = switch ($res) {
    0            { 'OK' }
    3            { 'COMPLETED WITH PROBLEMS (a non-fatal shard build failed)' }
    $NEVER_RUN   { 'NEVER RAN' }
    default      { "FAILED (code $res)" }
  }
  if ($res -ne 0) { $anyProblem = $true }
  Add-Line ("  {0}" -f $t)
  Add-Line ("     last run : {0}" -f $info.LastRunTime)
  Add-Line ("     result   : {0}" -f $verdict)
  Add-Line ("     next run : {0}" -f $info.NextRunTime)
}
Add-Line ''

# ---- 2. What do the logs say? ------------------------------------------------
Add-Line '== LOGS =='
foreach ($spec in @(
    @{ Name = 'monthly-refresh'; Glob = "logs\monthly-$Date-*.log" },
    @{ Name = 'auto-publish';    Glob = "logs\auto-publish-$Date-*.log" })) {
  $log = Get-ChildItem (Join-Path $root $spec.Glob) -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $log) {
    Add-Line ("  {0}: NO LOG FOR {1} -- the run did not start, or died before opening its log" -f $spec.Name, $Date)
    $anyProblem = $true
    continue
  }
  Add-Line ("  {0}: {1}" -f $spec.Name, $log.Name)
  $txt = Get-Content $log.FullName -ErrorAction SilentlyContinue
  # Step headers and any failure/summary lines -- enough to see how far it got.
  $keep = $txt | Where-Object { $_ -match '(?i)---\s*step |\*\*\*|===\s*(monthly-refresh|auto-publish|complete)|aborted|FAILED|WITH PROBLEMS' }
  if ($keep) { foreach ($k in ($keep | Select-Object -Last 25)) { Add-Line ("     {0}" -f $k.TrimEnd()) } }
  else       { Add-Line '     (no recognizable step lines)' }
  if ($txt -match '(?i)FAILED|aborted') { $anyProblem = $true }
}
Add-Line ''

# ---- 3. Did the published state actually move? -------------------------------
# The refresh writes shards; only a repin makes them reachable. A green refresh
# with an unchanged pin is the exact silent failure that hid 187 rebuilt
# assessment shards behind a stale SHA until 2026-08-05.
Add-Line '== PUBLISHED STATE =='
$dataRepo = 'D:\Dropbox\ClaudeCode\MBOpenData\mb-parcel-data'
$headSha = ''
if (Test-Path (Join-Path $dataRepo '.git')) {
  Push-Location $dataRepo
  try {
    $headSha = (& git rev-parse HEAD 2>$null)
    if ($headSha) { $headSha = $headSha.Trim() }
    $dirty = @(& git status --porcelain 2>$null)
    $lastCommit = (& git log -1 --format='%h %ad %s' --date=short 2>$null)
    Add-Line ("  mb-parcel-data HEAD : {0}" -f $lastCommit)
    if ($dirty.Count -gt 0) {
      Add-Line ("  UNCOMMITTED shards  : {0} path(s) -- rebuilt but NOT published" -f $dirty.Count)
      $anyProblem = $true
    } else {
      Add-Line '  working tree        : clean'
    }
  } finally { Pop-Location }
} else {
  Add-Line '  mb-parcel-data: clone not found'
  $anyProblem = $true
}

$arcgis = Join-Path $root 'web\src\arcgis.js'
if ((Test-Path $arcgis) -and $headSha) {
  $m = [regex]::Match((Get-Content $arcgis -Raw),
       "(?m)export const MB_PARCEL_DATA_REVISION\s*=\s*\r?\n?\s*'([0-9a-f]{7,40})'")
  if ($m.Success) {
    $pin = $m.Groups[1].Value
    if ($pin -eq $headSha) {
      Add-Line ("  app CDN pin         : matches HEAD ({0})" -f $pin.Substring(0, 8))
    } else {
      Add-Line ("  app CDN pin         : {0} but data HEAD is {1} -- APP IS SERVING OLDER SHARDS" -f $pin.Substring(0, 8), $headSha.Substring(0, 8))
      $anyProblem = $true
    }
  } else { Add-Line '  app CDN pin         : could not parse MB_PARCEL_DATA_REVISION'; $anyProblem = $true }
}
Add-Line ''

$title = if ($anyProblem) { "CHECK - MB parcel monthly automation $Date" }
         else             { "OK - MB parcel monthly automation $Date" }
# Assigned first, not inlined into the call: Windows PowerShell 5.1 (the
# scheduled-task runtime) does not accept 'if' as an expression argument.
$verdictLine = if ($anyProblem) { 'VERDICT: something needs a look -- see the flagged lines above.' }
               else             { 'VERDICT: all clear. Tasks ran, logs completed, published state consistent.' }
Add-Line $verdictLine

$body = ($L -join "`r`n")

if ($Console) { Write-Output $body; exit 0 }

if (Send-FailureAlert $root $NtfyTopic $title $body) {
  Write-Host "Report sent: $title"
  exit 0
} else {
  Write-Warning 'Report NOT sent -- no channel succeeded.'
  Write-Output $body
  exit 1
}
