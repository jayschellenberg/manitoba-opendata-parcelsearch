# du-snapshot-wrapper.ps1 -- run r/snapshot_dwelling_units.R under Task
# Scheduler, log the run, and surface a refusal loudly.
#
# Registered by schedule_du_snapshot.ps1. Safe to run by hand at any time.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File du-snapshot-wrapper.ps1
#   powershell -ExecutionPolicy Bypass -File du-snapshot-wrapper.ps1 -DryRun
#
# WHAT IT IS FOR. MAO publishes dwelling_units as a CURRENT scalar with no
# history, so a unit-count delta cannot be reconstructed for any period before
# the baseline this took on 2026-09-07. r/build_mf_newbuild.R works around that
# by triggering on assessed BUILDING VALUE (20 years of it) and using dwelling
# units only as a filter; this closes the gap going forward, so that a roll
# which gains units WITHOUT gaining much value -- a conversion, a basement
# suite, a rooming house -- eventually becomes detectable too. Every cycle
# skipped is a hole in that record that cannot be backfilled later.
#
# WHAT A DELTA'S DATE MEANS. It is when the change was OBSERVED, not when it
# happened. Municipalities re-scrape on a rolling cadence (6 months, annual in
# the North), so a unit count that moved in March can first appear in an August
# delta simply because that is when its municipality came round. This is the
# same trap as the sales change log, where "new" means newly SEEN. Never read a
# delta date as an event date; treat it as an upper bound with the muni's
# cadence as the window.

param(
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RFile     = Join-Path $ScriptDir 'r\snapshot_dwelling_units.R'
$LogDir    = Join-Path $ScriptDir 'logs'
$LogFile   = Join-Path $LogDir ('du-snapshot-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

if (-not (Test-Path $RFile)) { Write-Error "Not found: $RFile"; exit 1 }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# ---- Rscript: version-sorted, never a hardcoded path ------------------------
# Same helper as the mao-scrape wrappers. The R-* glob rather than * is
# deliberate: the [version] cast has nothing to bite on for a directory that is
# not R-<version>.
# NOTE: PowerShell variable names are CASE-INSENSITIVE, so $RScript and
# $rscript would be the SAME variable. The R file is $RFile and the
# interpreter is $RscriptExe for exactly that reason - naming them $RScript
# and $rscript silently made the wrapper invoke Rscript.exe with Rscript.exe
# as its script argument.
function Find-Rscript {
    $onPath = (Get-Command Rscript -ErrorAction SilentlyContinue).Source
    if ($onPath) { return $onPath }
    $found = Get-ChildItem 'C:\Program Files\R\R-*\bin\Rscript.exe' -ErrorAction SilentlyContinue |
             Sort-Object { [version]($_.FullName -replace '.*\\R-([\d.]+)\\.*', '$1') } -Descending |
             Select-Object -First 1 -ExpandProperty FullName
    return $found
}
$RscriptExe = Find-Rscript
if (-not $RscriptExe) { Write-Error 'Rscript.exe not found on PATH or under C:\Program Files\R'; exit 1 }

# Prefer the REAL binary over the launcher stub. bin\Rscript.exe re-launches
# bin\x64\Rscript.exe, and under a redirected-stream launch the stub reports
# ExitCode 1 on a completely successful run because the grandchild owns the
# handles. Same reason as process-new-sales-wrapper.ps1; see its note.
$rscriptDirect = $RscriptExe -replace '\\bin\\Rscript\.exe$', '\bin\x64\Rscript.exe'
if (Test-Path $rscriptDirect) { $RscriptExe = $rscriptDirect }

$rArgs = @($RFile)
if ($DryRun) { $rArgs += '--dry-run' }
if ($Force)  { $rArgs += '--force' }

Write-Host ("[du-snapshot] {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Host ("[du-snapshot] {0} {1}" -f $RscriptExe, ($rArgs -join ' '))
Write-Host ("[du-snapshot] log: {0}" -f $LogFile)

# Run from the repo root so the R script's own r/config.R bootstrap resolves.
Push-Location $ScriptDir
try {
    & $RscriptExe @rArgs 2>&1 | Tee-Object -FilePath $LogFile
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}

# Prune logs older than 400 days -- one full year of runs plus a margin, so the
# previous year's cadence is still readable when the annual North munis come
# round for comparison.
Get-ChildItem $LogDir -Filter 'du-snapshot-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-400) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($code -eq 2) {
    # Exit 2 is the R script's sanity gate refusing to record a delta in which
    # too many rolls lost their units at once -- the signature of a truncated
    # parcels.parquet. This is NOT a crash and NOT a no-op: the run declined to
    # write, deliberately, and the replay chain is intact. It needs a human,
    # because the log is append-only and self-replaying, so a bad delta written
    # once silently rewrites every later answer and can only be undone by
    # editing the log by hand.
    Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
    Write-Host '!!  DU SNAPSHOT REFUSED - too many rolls lost their units in one cycle.'
    Write-Host '!!'
    Write-Host '!!  Nothing was written; the replay chain is intact. This usually means'
    Write-Host '!!  parcels.parquet was truncated or read mid-sweep, not that buildings'
    Write-Host '!!  were demolished.'
    Write-Host '!!'
    Write-Host ('!!  Detail: {0}' -f $LogFile)
    Write-Host '!!  Check mao-scrape/results/parcels.parquet, then re-run. Only pass'
    Write-Host '!!  -Force once you have confirmed the loss is real.'
    Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
    exit 2
}
elseif ($code -ne 0) {
    Write-Host ('[du-snapshot] FAILED (exit {0}) - see {1}' -f $code, $LogFile)
    exit $code
}
Write-Host '[du-snapshot] done.'
exit 0
