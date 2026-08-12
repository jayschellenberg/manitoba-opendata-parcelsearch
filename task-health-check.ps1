# task-health-check.ps1 -- one watchdog that reads the RESULT of every
# MBOpenData scheduled task, across all four projects.
#
# WHY THIS EXISTS
#   Windows Task Scheduler records how a task ended in LastTaskResult, and until
#   2026-08-12 almost nothing in this repo read it. There were exactly two
#   readers, each hard-coded to two task names:
#     mao-assembly\input-staleness-check.ps1 -> mao-assembly-monthly-refresh,
#                                               mao-assembly-annual-refresh
#     mb-parcelsearch\post-refresh-report.ps1 -> mb-parcelsearch-monthly-refresh,
#                                                mb-parcelsearch-publish-indexes
#   Four of fifteen registered tasks. The other eleven could fail every day
#   forever and the only evidence would be a column in taskschd.msc that nobody
#   opens.
#
#   That was not hypothetical. On the morning of 2026-08-12, with no alert of
#   any kind sent:
#     MAOSalesStaleness  LastTaskResult 267014 -- killed at its 10-minute
#                        ExecutionTimeLimit. The sales watchdog itself was down,
#                        so the thing meant to notice a stalled sales sweep was
#                        stalled, silently.
#     MAOChunkedDelta    LastTaskResult 2 -- its OWN "done with problems" code,
#                        2026-08-11 run -- the action could not find what it was
#                        told to execute.
#   Both are exactly the failure this project keeps re-learning: the automation
#   is fine, the watchdog over the automation is fine, and nobody watches the
#   watchdogs.
#
# WHAT IT CHECKS, per task
#   1. Registered at all.                  A name that a schedule_*.ps1 claims to
#                                          register but that is absent from Task
#                                          Scheduler has never been run on this
#                                          machine (that is how
#                                          mb-parcelsearch-monthly-refresh was
#                                          "live" in MAINTENANCE.md and missing
#                                          in reality until 2026-08-05).
#   2. Not Disabled.
#   3. LastTaskResult in the healthy set:
#        0      finished cleanly
#        267011 0x41303 SCHED_S_TASK_HAS_NOT_RUN -- registered, never fired.
#               Healthy on purpose: several tasks here legitimately have not had
#               their first occurrence yet (semiannual-archive waits for Jan 1).
#        267009 0x41301 SCHED_S_TASK_RUNNING -- in flight right now, no verdict
#               yet. Treating this as a failure would flag any long job that
#               happens to overlap this check.
#      Anything else is a finding, translated to words -- see Get-TaskResultText.
#   4. NextRunTime present. A null NextRunTime on an enabled task means it will
#      never run again: a spent one-shot, an expired EndBoundary, or a trigger
#      that no longer produces occurrences. The task still sits there looking
#      registered, which is the whole problem.
#   5. LastRunTime not far past what its own trigger implies -- see below.
#
# THE OVERDUE CHECK IS DELIBERATELY BLUNT, AND SKIPS WHAT IT CANNOT READ
#   The expected interval is derived ONLY from trigger types that state one
#   outright: daily (DaysInterval) and weekly (WeeksInterval * 7). Monthly
#   triggers, one-time triggers, and the bare MSFT_TaskTrigger that
#   schtasks.exe /SC MONTHLY produces carry no interval this script can read
#   without guessing, so those tasks get NO overdue check at all. A skipped
#   check is listed in the report by name, so the gap is visible rather than
#   silent -- an unreliable check that cries wolf would get the whole watchdog
#   ignored, which costs more than the sub-check is worth.
#
#   Tolerance is 2x the interval, floor 2 days. That is loose on purpose. On
#   2026-08-12 mao-assembly-input-staleness (daily) last ran 08-11 07:15 with
#   NumberOfMissedRuns=1 -- the machine was simply asleep at 07:15 and
#   StartWhenAvailable had not caught it up yet. That is an ordinary morning,
#   not a broken task, and it must not page anyone. A daily task that has not
#   run in over two days is a different animal.
#
#   Repetition intervals (MAOSalesSearch repeats hourly) are ignored rather than
#   used: repetition only makes a task run MORE often, so judging it by its base
#   trigger is always the forgiving direction.
#
# HOW THE TASK LIST IS BUILT
#   By reading the schedule_*.ps1 registrars in each project and pulling the
#   literal task names out of them, NOT from a list maintained here. A hardcoded
#   roster rots the moment someone adds a task, and a watchdog that quietly
#   stops covering new work is the same silent hole in a new place.
#
#   Two patterns are matched, which between them cover every registrar in the
#   repo: `$TaskName = 'literal'` (12 registrars) and `Register-... -Name
#   'literal'` (mao-assembly\schedule_refresh.ps1, which registers three tasks
#   through a helper function). $LegacyTaskNames entries are NOT matched --
#   those are pre-rename names the registrars delete, so looking for them would
#   manufacture a permanent "not registered" finding.
#
#   Discovery failing is itself a finding: if it turns up fewer than
#   -MinDiscovered names the run reports that AND falls back to $KnownTasks
#   below, so a broken regex degrades to a stale list instead of to an empty
#   one. $KnownTasks is a snapshot, not the source of truth -- see its comment.
#
#   $OnDemandTasks is the one deliberate exception to "absent = finding".
#
# Reuses the shared alert stack (alert-lib.ps1 + alert-email.local.txt) with its
# own ntfy topic, and TWO guards on the quiet period, because a stamp that
# silences the next run is itself a way to make a hole:
#   * content-aware -- the stamp records WHICH findings were sent, so a NEW
#     failure alerts immediately instead of being suppressed by a quiet period
#     an unrelated older failure opened.
#   * delivery-gated -- the stamp is written only when Test-AlertDelivered says
#     the alert actually got somewhere, never on Send-FailureAlert's boolean
#     (ntfy answers 200 for a topic nobody subscribes to). Same rule the sibling
#     checkers adopted on 2026-08-12.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File task-health-check.ps1
#   ... -NoAlert    # report to the console only; sends nothing and does NOT
#                   #   touch the quiet-period stamp (an ad-hoc run would
#                   #   otherwise silence the next SCHEDULED run)
#   ... -Force      # ignore the quiet period
#   ... -TestAlert  # send a test through the alert path and exit
#
# Scheduled daily 09:40 via schedule_task_health_check.ps1 -- after the 09:00 /
# 09:10 / 09:20 / 09:30 watchdogs, so their own results are already recorded and
# this run judges the morning that just happened.
#
# ASCII-only on purpose: Task Scheduler runs this under Windows PowerShell 5.1,
# where a non-ASCII char in a double-quoted string in a BOM-less UTF-8 file
# mojibakes and fails the whole file before anything runs.

param(
  [string]$Root       = 'D:\Dropbox\ClaudeCode\MBOpenData',
  [string[]]$Projects = @('mb-parcelsearch', 'mao-assembly', 'mao-scrape', 'MBFloodMapping'),
  [int]$QuietDays     = 3,
  [int]$MinDiscovered = 10,
  [switch]$TestAlert,
  [switch]$Force,
  [switch]$NoAlert
)

$ErrorActionPreference = 'Continue'

$ParcelSearch = Join-Path $Root 'mb-parcelsearch'
$alertLib     = Join-Path $ParcelSearch 'alert-lib.ps1'
if (-not (Test-Path $alertLib)) {
  Write-Error ("alert-lib.ps1 not found at {0} -- cannot send alerts." -f $alertLib)
  exit 2
}
. $alertLib

$NtfyTopic = 'mbps-task-health-jks'   # public namespace; carries no secrets
$LogDir    = Join-Path $ParcelSearch 'logs'
$StampFile = Join-Path $LogDir 'task-health-stamp.txt'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

if ($TestAlert) {
  $ok = Send-FailureAlert $ParcelSearch $NtfyTopic 'TEST - MB scheduled task health' `
        ("Test from task-health-check.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).")
  if ($ok) { Write-Host 'Test alert sent.'; exit 0 } else { Write-Error 'Test alert failed.'; exit 1 }
}

# Fallback roster ONLY -- used when discovery under-delivers. Snapshot of what
# Get-ScheduledTask returned on 2026-08-12, which matched discovery exactly.
# Do not maintain this by hand as the primary list; fix discovery instead.
$KnownTasks = @(
  'mao-assembly-annual-refresh', 'mao-assembly-input-staleness', 'mao-assembly-monthly-refresh',
  'MAOChunkedDelta', 'MAOSalesSearch', 'MAOSalesStaleness',
  'mb-parcelsearch-history-staleness', 'mb-parcelsearch-hpi-download',
  'mb-parcelsearch-hpi-staleness', 'mb-parcelsearch-monthly-refresh',
  'mb-parcelsearch-post-refresh-report', 'mb-parcelsearch-publish-indexes',
  'mb-parcelsearch-semiannual-archive', 'mb-parcelsearch-upstream-vintage',
  'mbfloodmapping-staleness'
)

# Registered on demand and self-deleting, so ABSENT is its normal resting state
# and "not registered" would be a permanent false alarm. MAOScrapeRun is created
# by mao-scrape\schedule_run.ps1 as a one-time trigger with
# -DeleteExpiredTaskAfter 1 minute. If it IS present it still gets fully checked.
$OnDemandTasks = @('MAOScrapeRun')

# LastTaskResult comes back as Int32 on some hosts and UInt32 on others, so an
# HRESULT-shaped code (0x8007....) can arrive negative. Fold to unsigned first
# or the switch below silently misses every one of them.
function ConvertTo-TaskResultCode([object]$raw) {
  if ($null -eq $raw) { return $null }
  return ([int64]$raw -band 0xFFFFFFFF)
}

# Exit codes a task's OWN action defines, which must not be read as Win32
# errors. Task Scheduler stores whatever the process returned, so for actions
# that are project scripts a small integer is that script's convention, not a
# system error. Getting this wrong is not cosmetic: the first version of this
# file reported MAOChunkedDelta's nightly exit 2 as "ERROR_FILE_NOT_FOUND: the
# action executable does not exist", which is both false and a daily alert --
# and a watchdog that cries wolf every morning is one that stops being read.
#
# Codes listed here are ALSO not raised as findings, because the run's own
# wrapper already alerts on them. This check exists to catch what nothing else
# watches, not to duplicate an alert that fired hours earlier.
$KnownScriptCodes = @{
  'MAOChunkedDelta' = @{
    2 = 'DONE WITH PROBLEMS - the delta completed and wrote its parquets; some rolls could not be re-fetched and are queued in checkpoints\pending_refetch.csv. $2run_delta.R exits 2 deliberately so run_chunked_wrapper.ps1 alerts. This is its normal nightly outcome.'
  }
  'mb-parcelsearch-monthly-refresh' = @{
    3 = 'COMPLETED WITH PROBLEMS - all 7 steps ran; a non-fatal shard build (step 4-6) failed and that dataset still serves its previous shards. monthly-refresh.bat exits 3 so monthly-refresh-wrapper.ps1 alerts.'
  }
}

function Get-TaskResultText([int64]$code, [string]$taskName) {
  $hex = ('0x{0:X}' -f $code)
  if ($taskName -and $KnownScriptCodes.ContainsKey($taskName) -and
      $KnownScriptCodes[$taskName].ContainsKey([int]$code)) {
    return $KnownScriptCodes[$taskName][[int]$code]
  }
  switch ($code) {
    0          { return 'OK' }
    1          { return 'FAILED - exited 1 (script exit code, not a Win32 error; read its log)' }
    2          { return ('FAILED - exited 2 (script exit code; read its log. {0} as a Win32 code would be ERROR_FILE_NOT_FOUND, but these actions are project scripts that define their own codes)' -f $hex) }
    3          { return ('FAILED - exited 3 (script exit code; read its log)' -f $hex) }
    5          { return ('FAILED - {0} exited 5 (ERROR_ACCESS_DENIED if it came from Windows rather than the script)' -f $hex) }
    10         { return ('FAILED - {0} exited 10' -f $hex) }
    267008     { return ('{0} SCHED_S_TASK_READY - ready, no run recorded' -f $hex) }
    267009     { return ('{0} SCHED_S_TASK_RUNNING - in flight right now' -f $hex) }
    267010     { return ('{0} SCHED_S_TASK_DISABLED - the task is disabled' -f $hex) }
    267011     { return ('{0} SCHED_S_TASK_HAS_NOT_RUN - registered but never fired' -f $hex) }
    267012     { return ('{0} SCHED_S_TASK_NO_MORE_RUNS - trigger exhausted; it will never run again' -f $hex) }
    267014     { return ('{0} SCHED_S_TASK_TERMINATED - killed at its ExecutionTimeLimit, or ended by hand' -f $hex) }
    267015     { return ('{0} SCHED_S_TASK_NO_VALID_TRIGGERS - registered with no usable trigger' -f $hex) }
    2147750687 { return ('{0} SCHED_E_ALREADY_RUNNING - a previous instance was still going' -f $hex) }
    2147943645 { return ('{0} ERROR_SERVICE_REQUEST_TIMEOUT - the action did not respond to the start request' -f $hex) }
    3221225786 { return ('{0} STATUS_CONTROL_C_EXIT - killed by Ctrl-C or a closed console' -f $hex) }
    3221225794 { return ('{0} STATUS_DLL_INIT_FAILED - could not start (typically no interactive session)' -f $hex) }
    default    { return ('FAILED - undocumented code {0} ({1})' -f $code, $hex) }
  }
}

# Expected days between runs, or $null when it cannot be read off the trigger.
# Returning $null is a supported answer, not an error -- see the header.
function Get-TriggerIntervalDays($task) {
  if ($null -eq $task -or $null -eq $task.Triggers) { return $null }
  $max = $null
  foreach ($tr in $task.Triggers) {
    if ($null -ne $tr.Enabled -and -not $tr.Enabled) { continue }
    $d = $null
    # Read the interval off the PROPERTY rather than the CIM class name: the
    # property is present or it is not, which behaves the same on 5.1 and 7 and
    # degrades to "cannot tell" for any trigger type not handled here.
    if ($null -ne $tr.DaysInterval -and [int]$tr.DaysInterval -gt 0) {
      $d = [int]$tr.DaysInterval
    } elseif ($null -ne $tr.WeeksInterval -and [int]$tr.WeeksInterval -gt 0) {
      $d = 7 * [int]$tr.WeeksInterval
    }
    if ($null -eq $d) { return $null }   # one unreadable trigger disqualifies the task
    if ($null -eq $max -or $d -gt $max) { $max = $d }
  }
  return $max
}

function Get-TriggerLabel($task) {
  if ($null -eq $task -or $null -eq $task.Triggers -or $task.Triggers.Count -eq 0) { return '(no trigger)' }
  $names = @()
  foreach ($tr in $task.Triggers) {
    $n = '(unknown)'
    if ($tr.CimClass -and $tr.CimClass.CimClassName) { $n = $tr.CimClass.CimClassName -replace '^MSFT_Task', '' }
    $names += $n
  }
  return ($names -join '+')
}

# ---- 1. Discover the task names from the registrars --------------------------
$sources  = [ordered]@{}     # task name -> "project\registrar.ps1"
$problems = New-Object System.Collections.ArrayList
$roster   = New-Object System.Collections.ArrayList
$skipped  = New-Object System.Collections.ArrayList
$sigParts = New-Object System.Collections.ArrayList
$scanned  = 0

function Add-Problem([string]$kind, [string]$name, [string]$detail) {
  [void]$problems.Add(('{0,-9} {1,-37} {2}' -f $kind, $name, $detail))
  [void]$sigParts.Add(('{0}:{1}' -f $kind, $name))
}

foreach ($p in $Projects) {
  $dir = Join-Path $Root $p
  if (-not (Test-Path $dir)) {
    Add-Problem 'NOPROJECT' $p ('project directory not found: {0}' -f $dir)
    continue
  }
  foreach ($f in @(Get-ChildItem -Path $dir -Filter 'schedule_*.ps1' -File -ErrorAction SilentlyContinue)) {
    $scanned++
    $rel = Join-Path $p $f.Name
    foreach ($line in @(Get-Content -LiteralPath $f.FullName -ErrorAction SilentlyContinue)) {
      if ($line.TrimStart().StartsWith('#')) { continue }
      # $TaskName = 'literal'  /  [string]$TaskName = "literal"
      $m = [regex]::Match($line, '\$TaskName\s*=\s*[''"]([^''"$]+)[''"]')
      if ($m.Success) {
        $n = $m.Groups[1].Value.Trim()
        if ($n -and -not $sources.Contains($n)) { $sources[$n] = $rel }
      }
      # Register-<something>Task -Name 'literal'   (mao-assembly's helper)
      if ($line -match 'Register-') {
        $m2 = [regex]::Match($line, '-Name\s+[''"]([A-Za-z][^''"$]*)[''"]')
        if ($m2.Success) {
          $n2 = $m2.Groups[1].Value.Trim()
          if ($n2 -and -not $sources.Contains($n2)) { $sources[$n2] = $rel }
        }
      }
    }
  }
}

$discoveredCount = $sources.Count
if ($discoveredCount -lt $MinDiscovered) {
  Add-Problem 'DISCOVERY' 'schedule_*.ps1 scan' `
    ('found only {0} task name(s) in {1} registrar(s) -- expected at least {2}; falling back to the $KnownTasks snapshot. FIX THE SCAN.' -f `
      $discoveredCount, $scanned, $MinDiscovered)
  foreach ($k in $KnownTasks) { if (-not $sources.Contains($k)) { $sources[$k] = '($KnownTasks fallback)' } }
}

# ---- 2. Judge every task -----------------------------------------------------
$now         = Get-Date
$HEALTHY     = @(0, 267009, 267011)   # clean / running / never fired
$NEVER_RUN   = 267011

foreach ($name in @($sources.Keys)) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue |
          Where-Object { $_.TaskName -eq $name } | Select-Object -First 1
  if ($null -eq $task) {
    if ($OnDemandTasks -contains $name) {
      [void]$roster.Add(('  {0,-37} {1}' -f $name, 'not registered - on-demand task, absent is normal'))
    } else {
      Add-Problem 'MISSING' $name ('registered by {0} but absent from Task Scheduler -- that registrar has never been run here' -f $sources[$name])
    }
    continue
  }

  $info = $task | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
  if ($null -eq $info) {
    Add-Problem 'NOINFO' $name 'Get-ScheduledTaskInfo returned nothing -- the task registration is damaged'
    continue
  }

  $state = [string]$task.State
  $code  = ConvertTo-TaskResultCode $info.LastTaskResult
  if ($null -eq $code) {
    # Never seen on a healthy registration; if it happens, say so rather than
    # letting [int64]$null coerce to 0 and report a phantom "OK".
    Add-Problem 'NORESULT' $name 'LastTaskResult is empty -- cannot tell how the last run ended'
    [void]$roster.Add(('  {0,-37} {1,-9} last {2,-16} next {3,-16} result {4}' -f `
      $name, $state, '?', '?', '(none)'))
    continue
  }
  $codeText = Get-TaskResultText $code $name
  $lastRun  = $info.LastRunTime
  $ranEver  = ($null -ne $lastRun -and $lastRun.Year -ge 2000 -and $code -ne $NEVER_RUN)
  $lastStr  = if ($ranEver) { $lastRun.ToString('yyyy-MM-dd HH:mm') } else { 'never' }
  $nextStr  = if ($null -eq $info.NextRunTime) { 'NONE' } else { $info.NextRunTime.ToString('yyyy-MM-dd HH:mm') }

  [void]$roster.Add(('  {0,-37} {1,-9} last {2,-16} next {3,-16} result {4}' -f `
    $name, $state, $lastStr, $nextStr, $code))

  # 2a. Disabled.
  $isDisabled = ($state -eq 'Disabled')
  if ($isDisabled) {
    Add-Problem 'DISABLED' $name 'the task is Disabled -- it will not fire until re-enabled'
  }

  # 2b. Last result. A code the task's own action defines and whose wrapper
  # already alerts is annotated in the roster but never raised here -- see
  # $KnownScriptCodes for why duplicating those would be actively harmful.
  $isKnownScriptCode = ($KnownScriptCodes.ContainsKey($name) -and
                        $KnownScriptCodes[$name].ContainsKey([int]$code))
  if ($HEALTHY -notcontains $code -and -not $isKnownScriptCode) {
    $when = if ($ranEver) { $lastRun.ToString('yyyy-MM-dd HH:mm') } else { 'unknown time' }
    Add-Problem 'RESULT' $name ('last run {0}: {1}' -f $when, $codeText)
  }
  if ($isKnownScriptCode) {
    [void]$roster.Add(('  {0,-37} {1}' -f '', ('^ expected: ' + $codeText.Split('.')[0])))
  }

  # 2c. No next occurrence. Suppressed when Disabled, which always nulls
  # NextRunTime and would otherwise double-report the same one fault.
  if ($null -eq $info.NextRunTime -and -not $isDisabled) {
    Add-Problem 'NO-NEXT' $name ('NextRunTime is empty -- nothing will ever start this again (spent one-shot, expired EndBoundary, or dead trigger). Triggers: {0}' -f (Get-TriggerLabel $task))
  }

  # 2d. Overdue against its own trigger, where that can be read at all.
  $interval = Get-TriggerIntervalDays $task
  if ($null -eq $interval) {
    [void]$skipped.Add(('  {0,-37} no interval readable from trigger type(s): {1}' -f $name, (Get-TriggerLabel $task)))
  } elseif (-not $ranEver) {
    [void]$skipped.Add(('  {0,-37} has never run, so there is no LastRunTime to age' -f $name))
  } else {
    $allowed = [Math]::Max(2, $interval * 2)
    $ageDays = (New-TimeSpan -Start $lastRun -End $now).TotalDays
    if ($ageDays -gt $allowed) {
      Add-Problem 'OVERDUE' $name ('last ran {0} ({1:N1} days ago); its trigger implies every {2} day(s), tolerance {3} days' -f `
        $lastRun.ToString('yyyy-MM-dd HH:mm'), $ageDays, $interval, $allowed)
    }
  }
}

# ---- 3. Report ---------------------------------------------------------------
$L = New-Object System.Collections.ArrayList
[void]$L.Add(('Scheduled-task health on {0} at {1}' -f $env:COMPUTERNAME, $now.ToString('yyyy-MM-dd HH:mm')))
[void]$L.Add(('Task names discovered: {0} from {1} schedule_*.ps1 registrar(s) in: {2}' -f `
  $discoveredCount, $scanned, ($Projects -join ', ')))
[void]$L.Add('')

if ($problems.Count -gt 0) {
  [void]$L.Add(('== FINDINGS ({0}) ==' -f $problems.Count))
  foreach ($p in $problems) { [void]$L.Add($p) }
  [void]$L.Add('')
}

[void]$L.Add(('== ALL TASKS ({0}) ==' -f $roster.Count))
foreach ($r in $roster) { [void]$L.Add($r) }
[void]$L.Add('')

if ($skipped.Count -gt 0) {
  [void]$L.Add(('== NO OVERDUE CHECK POSSIBLE ({0}) -- by design, not an error ==' -f $skipped.Count))
  foreach ($s in $skipped) { [void]$L.Add($s) }
  [void]$L.Add('')
}

$bodyText = ($L -join [Environment]::NewLine)

if ($problems.Count -eq 0) {
  Write-Host $bodyText
  Write-Host ('All {0} scheduled task(s) healthy.' -f $roster.Count)
  exit 0
}

$title = ('MB scheduled tasks: {0} finding(s)' -f $problems.Count)
Write-Host $title
Write-Host $bodyText

if ($NoAlert) {
  Write-Host '(-NoAlert: nothing sent, quiet-period stamp untouched)'
  exit 1
}

# Content-aware quiet period. Line 1 of the stamp is when we last sent, line 2
# is WHICH findings that alert carried. A changed signature always sends, so a
# brand-new failure is never masked by a quiet period an older one opened.
$signature = (($sigParts | Sort-Object) -join ';')
if (-not $Force -and (Test-Path $StampFile)) {
  $stamp    = @(Get-Content -LiteralPath $StampFile -ErrorAction SilentlyContinue)
  $prevSig  = ''
  if ($stamp.Count -ge 2) { $prevSig = $stamp[1] }
  $prevWhen = (Get-Item $StampFile).LastWriteTime
  $elapsed  = (New-TimeSpan -Start $prevWhen -End $now).TotalDays
  if ($prevSig -eq $signature -and $elapsed -lt $QuietDays) {
    Write-Host ('Alert suppressed - same findings already sent {0} (quiet period {1}d).' -f `
      $prevWhen.ToString('yyyy-MM-dd HH:mm'), $QuietDays)
    exit 0
  }
  if ($prevSig -ne $signature) { Write-Host 'Findings changed since the last alert - sending regardless of the quiet period.' }
}

# 2026-08-12: the quiet-period stamp is written only on VERIFIED delivery.
# Send-FailureAlert returns true when EITHER channel worked, and Send-AlertPush
# returns true on any HTTP 200 from ntfy -- which an anonymous publish gets for
# any topic even when nobody is subscribed. Gating the stamp on that boolean
# means a revoked SMTP app password still opens a fresh quiet period, and this
# watchdog then stays silent about the same findings for QuietDays while nothing
# has actually reached anyone. Test-AlertDelivered (alert-lib.ps1) accepts a real
# email, or push alone when email is not configured at all; email configured but
# failing leaves the stamp untouched so the next run alerts again.
$sent = Send-FailureAlert $ParcelSearch $NtfyTopic $title $bodyText
if (Test-AlertDelivered) {
  Set-Content -LiteralPath $StampFile -Value @($now.ToString('s'), $signature) -Encoding ASCII
  Write-Host 'Alert sent.'
  # Exit 0 on a delivered alert. Having findings is this task doing its JOB, not
  # failing; exiting non-zero here would set its own LastTaskResult non-zero and
  # it would then report ITSELF as broken every morning it correctly found
  # something. -NoAlert above still exits 1 for interactive/pipeline use.
  exit 0
} elseif ($sent) {
  Write-Warning ('Alert went out on PUSH ONLY -- email is configured but FAILED. ' +
                 'Quiet-period stamp NOT written; the next run will try again. Check the app password.')
  # Exit 1 here IS wanted, self-reference and all, and matches the sibling
  # checkers. Tomorrow's run reads THIS task's LastTaskResult like every other
  # one, so a dead email channel surfaces through the exact mechanism this
  # script exists to read, rather than only in an ALERT CHANNELS log line that
  # nobody opens -- which is how the email half went unrecorded for months.
  exit 1
} else {
  Write-Warning 'Alert delivery failed (email and push both).'
  exit 1
}
