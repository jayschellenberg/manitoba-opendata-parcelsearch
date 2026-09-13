# schedule_traffic_check.ps1 -- register traffic-refresh-check.ps1 as a MONTHLY
# Windows Task Scheduler entry (16th, 05:30 local).
#
# Timing: the day AFTER the 15th, so it never contends with
# mb-parcelsearch-monthly-refresh (15th 04:00) or mb-parcelsearch-publish-indexes
# (15th 04:30) for the repo's git index or the working tree. This job commits
# and pushes on its own, and two unattended jobs staging in the same clone at
# once is a merge conflict nobody is awake to resolve.
#
# Monthly is the right cadence even though MHTIS publishes roughly yearly: the
# check is cheap (two HTTP requests when there is nothing new) and the cost of
# missing a new report is months of an appraisal tool quietly serving last
# year's traffic counts.
#
# Idempotent -- re-run to update; the existing task is replaced.
#
# Usage (normal user privileges, no admin needed):
#   powershell -ExecutionPolicy Bypass -File schedule_traffic_check.ps1
#
# Manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-traffic-refresh | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-traffic-refresh                      # run now
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-traffic-refresh -Confirm:$false  # cancel
#
# Verify without waiting a month:
#   powershell -ExecutionPolicy Bypass -File traffic-refresh-check.ps1 -DryRun

$ErrorActionPreference = "Continue"   # schtasks writes 'task not found' to stderr; don't let it throw
$TaskName  = "mb-parcelsearch-traffic-refresh"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Checker   = Join-Path $ScriptDir "traffic-refresh-check.ps1"

if (-not (Test-Path $Checker)) { Write-Error "Checker not found: $Checker"; exit 1 }

$PriorLogonType = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).Principal.LogonType

$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task '$TaskName' found - replacing it."
    schtasks /Delete /TN $TaskName /F | Out-Null
}

$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Checker`""

schtasks /Create `
    /SC MONTHLY `
    /D 16 `
    /ST 05:30 `
    /TN $TaskName `
    /TR $taskCmd `
    /RL LIMITED `
    /F | Out-Null

if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /Create failed (exit $LASTEXITCODE)"; exit 1 }

Write-Host ""
Write-Host "Registered '$TaskName' - monthly, 16th at 05:30."
Write-Host "  checks:  new MHTIS annual report -> rebuild + commit + push"
Write-Host "           new AADT_<year> column  -> alert (needs a code change)"
Write-Host ""

# The S4U trap, same as the other schedulers here: a task created this way runs
# only when the user is LOGGED ON. If the machine is at the lock screen on the
# 16th, it never fires and nothing says so. Report the logon type plainly
# rather than letting it look registered-and-working.
$now = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$logon = [string]$now.Principal.LogonType
Write-Host "Logon type: $logon"
if ($logon -ne 'S4U' -and $logon -ne 'Password') {
    Write-Host ""
    Write-Host "NOTE: this task runs only while you are logged on (LogonType=$logon)."
    if ($PriorLogonType -eq 'S4U' -or $PriorLogonType -eq 'Password') {
        Write-Host "WARNING: it was previously '$PriorLogonType' and this run DOWNGRADED it."
    }
    Write-Host "To make it run regardless, convert it to 'Run whether user is logged on or not'"
    Write-Host "in Task Scheduler, or re-register it the way the sales tasks are converted."
}
