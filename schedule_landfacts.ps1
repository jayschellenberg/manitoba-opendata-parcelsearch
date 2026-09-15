# schedule_landfacts.ps1 -- register landfacts-refresh-wrapper.ps1 as a MONTHLY
# Windows Task Scheduler entry (14th, 22:00 local).
#
# WHY THIS EXISTS. Since 2026-09-15 the Land Cover / Cult % columns lead with
# the crop inventory read per pixel over the last five years (the `mix` on the
# landfacts shards) and keep the 2020 Land Cover Register only as the
# cross-check. The register shards rebuild inside mb-parcelsearch-monthly-
# refresh; the land mix did not rebuild anywhere. Without this task the
# headline aged silently: parcels new since the last hand-run fell back to the
# register, and a new inventory year never entered the window until someone
# remembered fetch_aci.sh. That is exactly the kind of manual step that lags
# for weeks (the water shards did, until 2026-08).
#
# WHY THE 14TH AT 22:00. The wrapper runs ~2 h (fetch is a no-op most months).
# mb-parcelsearch-publish-indexes fires on the 15th at 04:30 and commits + pins
# everything in mb-parcel-data, so a build that starts the night before is
# what gets published; one that started on the 15th would wait a month. 22:00
# also sits after the mao-assembly weekly (Sunday 03:00, ~2 h) that writes the
# Parquet this reads, and clear of the 14th 03:40 DU snapshot.
#
# WHAT A MISSED RUN COSTS. Staleness, not loss: the CDN keeps serving the last
# build and the next run rebuilds from the current Parquet. Worth
# StartWhenAvailable; not worth paging anyone.
#
# Idempotent -- re-run to update; the existing task is replaced.
#
# Usage (normal user privileges to register; ELEVATED to get S4U -- see below):
#   powershell -ExecutionPolicy Bypass -File schedule_landfacts.ps1
#
# Manage:
#   Get-ScheduledTask -TaskName mb-parcelsearch-landfacts-refresh | Format-List *
#   Start-ScheduledTask  -TaskName mb-parcelsearch-landfacts-refresh                      # run now
#   Unregister-ScheduledTask -TaskName mb-parcelsearch-landfacts-refresh -Confirm:$false  # cancel

$ErrorActionPreference = "Continue"   # schtasks writes 'task not found' to stderr; don't let it throw
$TaskName  = "mb-parcelsearch-landfacts-refresh"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Wrapper   = Join-Path $ScriptDir "landfacts-refresh-wrapper.ps1"

if (-not (Test-Path $Wrapper)) { Write-Error "Wrapper not found: $Wrapper"; exit 1 }

# Capture the logon type BEFORE the teardown below, so the verdict at the end
# can tell "never was S4U" from "this run just DOWNGRADED a working S4U task".
$PriorLogonType = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).Principal.LogonType

$existing = schtasks /Query /TN $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Existing task '$TaskName' found - replacing it."
    schtasks /Delete /TN $TaskName /F | Out-Null
}

$taskCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Wrapper`""

#   /SC MONTHLY  - recur every month
#   /D 14        - on the 14th
#   /ST 22:00    - at 22:00 local
schtasks /Create `
    /SC MONTHLY `
    /D 14 `
    /ST 22:00 `
    /TN $TaskName `
    /TR $taskCmd `
    /RL LIMITED `
    /F | Out-Null

if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /Create failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }

# Battery + catch-up flags (schtasks doesn't expose these). The 5 h limit is
# 2.5x the measured province run (2 h 06 on 2026-09-15) so a slow month still
# finishes before the 04:30 publish rather than being killed halfway -- a kill
# is safe (shards replace whole) but wastes the month.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 5)
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

# ---- own the task PRINCIPAL, don't leave it Interactive ---------------------
# schtasks.exe (above) can only ever create an INTERACTIVE task, which does not
# run unless Jason is logged on. A Windows Update reboot at 01:31 on 2026-08-12
# left the machine at the logon screen and cost 9.3 h: every task was
# Interactive, so even the watchdogs were down and nothing could report the
# outage. All tasks were converted to S4U ("run whether the user is logged on
# or not", no stored password) that day.
#
# That conversion was manual, so without this block re-running this registrar
# for any unrelated reason silently reverts the task to Interactive and quietly
# re-opens the gap. The principal is the registrar's business now.
#
# Pasted rather than factored into a shared helper: these registrars are the
# bootstrap layer and are standalone on purpose (one that dot-sources a helper
# breaks when the helper moves), and the siblings needing the identical block
# live in other repos (mao-assembly, mao-scrape, MBFloodMapping) that a helper
# here could not reach anyway.
#
# NOT for mao-scrape's MAOSalesSearch / MAOSalesStaleness: those must STAY
# Interactive to read a DPAPI blob an S4U token cannot unlock - see their
# headers. This task reads local rasters and a Parquet and writes JSON, so S4U
# is correct for it.
#
# Set-ScheduledTask -Principal requires ELEVATION; unelevated it throws
# "Access is denied." That is caught rather than fatal - the task is already
# registered above and stays usable - but it is reported loudly, because an
# Interactive task nobody noticed is the entire failure mode described above.
$S4UError = $null
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U -RunLevel Limited
try {
    Set-ScheduledTask -TaskName $TaskName -Principal $principal -ErrorAction Stop | Out-Null
} catch {
    # Swallowed on purpose. Access-denied from an unelevated prompt is the
    # EXPECTED path and must not fail the registration. The read-back below is
    # the real verdict, and the block at the end is where it is reported.
    $S4UError = ([string]$_.Exception.Message).Trim()
}

# Ask Windows what it actually stored - do not assert it.
$ActualLogonType = "unknown"
try {
    $ActualLogonType = [string](Get-ScheduledTask -TaskName $TaskName).Principal.LogonType
} catch {
    $ActualLogonType = "unreadable"
}

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered:"
Write-Host "  Runs:        landfacts-refresh-wrapper.ps1 monthly on the 14th at 22:00 local (~2 h)"
Write-Host "  Does:        1. rural-report/fetch_aci.sh -- caches a new crop-inventory year if AAFC"
Write-Host "                  has published one (no-op otherwise)"
Write-Host "               2. r/build_landfacts.R --crop-only -- rebuilds the land mix (the Land"
Write-Host "                  Cover headline) for every municipality from the newest Parquet,"
Write-Host "                  carrying relief/wetland/water from the existing shards"
Write-Host "  Published:   by mb-parcelsearch-publish-indexes on the 15th at 04:30"
Write-Host "  Logs:        logs\landfacts-refresh-<stamp>.log, pruned after 400 days"
Write-Host "  LogonType:   $ActualLogonType  (S4U = runs while logged off; Interactive = does NOT)"
Write-Host "  StartWhenAvailable enabled (catches up if the machine was off)"
Write-Host ""
Write-Host "Trial run:   powershell -ExecutionPolicy Bypass -File landfacts-refresh-wrapper.ps1 -Muni BEAUSEJOUR"
Write-Host "Cancel:      Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host ""
Write-Host "NOTE: overdue coverage comes from mb-parcelsearch-task-health, which discovers"
Write-Host "      this registrar and flags the task after 62 days without a run."

# The verdict, printed last so it is the thing left on screen.
Write-Host ""
if ($ActualLogonType -eq "S4U") {
    Write-Host "Runs whether you are logged on or not - a logon screen no longer stalls it."
} else {
    Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    Write-Host "!!  WARNING: '$TaskName' is LogonType=$ActualLogonType, NOT S4U."
    Write-Host "!!"
    Write-Host "!!  IT WILL NOT RUN WHILE YOU ARE LOGGED OFF. A Windows Update reboot that"
    Write-Host "!!  lands on a logon screen silently costs every run until the next login -"
    Write-Host "!!  that is the 2026-08-12 incident (9.3 h lost, no alert possible)."
    Write-Host "!!"
    Write-Host "!!  For THIS task the cost is staleness: the CDN keeps the last build and the"
    Write-Host "!!  next run catches up, but new parcels show the register headline meanwhile."
    if ($PriorLogonType -eq "S4U") {
    Write-Host "!!"
    Write-Host "!!  THIS RUN JUST DOWNGRADED IT. The task was S4U a moment ago; re-registering"
    Write-Host "!!  it unelevated put it back to $ActualLogonType. Re-run elevated NOW."
    }
    if ($S4UError) {
    Write-Host "!!"
    Write-Host "!!  Reason: $S4UError"
    Write-Host "!!  ('Access is denied' just means this prompt is not elevated - expected.)"
    }
    Write-Host "!!"
    Write-Host "!!  FIX: re-run this registrar from an ELEVATED prompt (Run as administrator):"
    Write-Host "!!    powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Write-Host "!!  Setting an S4U principal is an administrative operation; there is no"
    Write-Host "!!  unelevated route. Re-running is idempotent and safe."
    Write-Host "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
}
