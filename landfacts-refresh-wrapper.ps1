# landfacts-refresh-wrapper.ps1 -- fetch any new crop-inventory year, then
# rebuild the land-facts shards' crop fields (the Land Cover headline) under
# Task Scheduler, logging the run and surfacing a failure loudly.
#
# Registered by schedule_landfacts.ps1 (monthly, 14th 22:00). Safe to run by
# hand at any time.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File landfacts-refresh-wrapper.ps1
#   powershell -ExecutionPolicy Bypass -File landfacts-refresh-wrapper.ps1 -Muni BEAUSEJOUR   # one muni, a trial
#   powershell -ExecutionPolicy Bypass -File landfacts-refresh-wrapper.ps1 -SkipFetch         # rebuild only
#
# WHAT IT IS FOR. Since 2026-09-15 the Land Cover / Cult % columns, popup and
# Dominant overlay lead with the crop inventory read per pixel over the last
# five years (`mix` on the landfacts shards, r/build_landfacts.R), with the
# 2020 Land Cover Register as the cross-check. The register shards rebuild
# inside mb-parcelsearch-monthly-refresh; the land mix did not rebuild
# anywhere, so the headline would have aged silently -- parcels new since the
# last build fell back to the register, and a new inventory year never entered
# the window until someone fetched it. This closes that loop.
#
# TWO STEPS, in order:
#   1. rural-report/fetch_aci.sh -- idempotent; skips cached years, so it is a
#      no-op eleven months a year and picks up the new inventory the month AAFC
#      publishes it (2024 landed 2025-07-31, 2025 landed by 2026-08). A failed
#      fetch is logged and does NOT stop step 2: the cached years still build a
#      correct window, just not a longer one.
#   2. r/build_landfacts.R --crop-only -- rebuilds cp/dom/mix/cc/cn/obs for
#      every municipality from the newest complete mao-assembly Parquet and
#      CARRIES relief, wetland and water from the existing shard. ~2 h for the
#      province. A shard is only ever replaced whole (temp-then-rename in the
#      builder), so a run killed midway leaves the previous shard in place.
#
# WHY THE 14TH AT 22:00. The 15th 04:30 publish (mb-parcelsearch-publish-
# indexes -> update-cdn-pin.ps1) commits and pins whatever is in mb-parcel-data.
# Starting the night before leaves ~6 h for a ~2 h build, so the rebuilt shards
# are what gets published rather than waiting a month. It also runs after the
# Sunday-13th-ish mao-assembly weekly, so the Parquet it reads is settled, and
# clear of the 14th 03:40 DU snapshot.
#
# WHAT A MISSED RUN COSTS. Nothing is lost: the shards on the CDN keep serving,
# the register keeps refreshing, and the next run rebuilds everything from the
# current Parquet. The cost is staleness -- new parcels show the register
# headline (with the "no crop-inventory mix" hover) until the next run.
# StartWhenAvailable is on, so a machine that was off on the 14th runs it when
# it wakes; if that is after 04:30 on the 15th the shards wait for the next
# publish, which is the auto-publish's business, not this script's.

param(
  [string]$Muni,
  [switch]$SkipFetch
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RFile     = Join-Path $ScriptDir 'r\build_landfacts.R'
$FetchSh   = Join-Path (Split-Path -Parent $ScriptDir) 'rural-report\fetch_aci.sh'
$IndexJson = Join-Path (Split-Path -Parent $ScriptDir) 'mb-parcel-data\landfacts\_index.json'
$LogDir    = Join-Path $ScriptDir 'logs'
$LogFile   = Join-Path $LogDir ('landfacts-refresh-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$BashExe   = 'C:\Program Files\Git\bin\bash.exe'

if (-not (Test-Path $RFile)) { Write-Error "Not found: $RFile"; exit 1 }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# The log lives under D:\Dropbox and something on this machine briefly opens a
# file it has just seen -- Dropbox's hasher, or Defender's real-time scan. Under
# $ErrorActionPreference = 'Stop' an unprotected Add-Content is not a lost log
# line, it is a dead run: that is how mb-parcelsearch-parcel-tiles was lost on
# 2026-09-16, four lines in, reporting nothing but exit 1. This wrapper had the
# identical hole and had simply never been unlucky -- it fires monthly and its
# first scheduled run is 2026-10-14. See MAINTENANCE.md, "Scheduled tasks: logs
# live inside Dropbox"; the com.dropbox.ignored flag on `logs\` was set and
# verified on the day it happened, so it is not a substitute for this.
function Write-LogLine([string]$line) {
    for ($i = 1; $i -le 10; $i++) {
        try { Add-Content -Path $LogFile -Value $line -ErrorAction Stop; return }
        catch { Start-Sleep -Milliseconds (100 * $i) }
    }
    Write-Warning ('could not write to log after 10 tries: {0}' -f $line)
}

function Write-Log([string]$msg) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    Write-LogLine $line
}

# Run a native command and hand back everything it printed, stderr included.
#
# fetch_aci.sh drives curl and gdal, and build_landfacts.R reports progress with
# message() -- all of which is STDERR. Under $ErrorActionPreference = 'Stop',
# Windows PowerShell turns the FIRST such line into a TERMINATING
# NativeCommandError, so `& tool ... 2>&1` ends the wrapper on a healthy run.
# rebuild-parcel-tiles.ps1 died exactly that way on 2026-09-16 (tippecanoe's
# first progress line); this wrapper had the same two calls and has simply
# never reached them unattended -- its first scheduled run is 2026-10-14.
#
# $LASTEXITCODE is what decides success, so drop the preference for the call and
# put it back. The call must happen INSIDE this function, not in a scriptblock
# passed to it: a scriptblock resolves $ErrorActionPreference in the scope it
# was DEFINED in, which would find 'Stop' again and quietly undo this.
function Invoke-Native([string]$Exe, [string[]]$Arguments = @()) {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    # PS7's second route to the same failure; harmless no-op on 5.1, which is
    # what the scheduled task runs.
    $PSNativeCommandUseErrorActionPreference = $false
    try { & $Exe @Arguments 2>&1 }
    finally { $ErrorActionPreference = $prevEAP }
}

# ---- Rscript: version-sorted, never a hardcoded path ------------------------
# Same helper as the other wrappers. $RFile is the script and $RscriptExe the
# interpreter -- PowerShell variable names are case-insensitive, and $RScript /
# $rscript would be one variable.
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
# Prefer the real binary over the launcher stub: under a redirected-stream
# launch the stub reports ExitCode 1 on a successful run because the
# grandchild owns the handles (see du-snapshot-wrapper.ps1).
$rscriptDirect = $RscriptExe -replace '\\bin\\Rscript\.exe$', '\bin\x64\Rscript.exe'
if (Test-Path $rscriptDirect) { $RscriptExe = $rscriptDirect }

Write-Log ('landfacts refresh start; log {0}' -f $LogFile)

# ---- 1. new crop-inventory year, if AAFC has published one ------------------
if ($SkipFetch) {
    Write-Log 'fetch: skipped (-SkipFetch)'
} elseif (-not (Test-Path $FetchSh)) {
    Write-Log ('fetch: WARNING script not found, continuing with cached years: {0}' -f $FetchSh)
} elseif (-not (Test-Path $BashExe)) {
    Write-Log ('fetch: WARNING bash not found, continuing with cached years: {0}' -f $BashExe)
} else {
    Write-Log ('fetch: {0} {1}' -f $BashExe, $FetchSh)
    $fetchOut = Invoke-Native $BashExe @(($FetchSh -replace '\\', '/'))
    $fetchOut | ForEach-Object { Write-LogLine ('    ' + $_) }
    $new = @($fetchOut | Where-Object { $_ -match '^\d{4}: aci_' })
    if ($new.Count) { Write-Log ('fetch: NEW inventory year(s) cached: {0}' -f ($new -join '; ')) }
    elseif ($fetchOut -match 'CACHE COMPLETE') { Write-Log 'fetch: nothing new (all years cached)' }
    else { Write-Log 'fetch: WARNING did not report CACHE COMPLETE -- continuing with cached years' }
}

# ---- 2. rebuild the crop fields, carrying the slow layers --------------------
$rArgs = @($RFile, '--crop-only')
if ($Muni) { $rArgs += @('--muni', $Muni) }
Write-Log ('build: {0} {1}' -f $RscriptExe, ($rArgs -join ' '))

Push-Location $ScriptDir
# Same stderr-is-terminating guard as Invoke-Native, inline because this call
# tees to the log as it goes rather than returning its output. R's message()
# progress would otherwise kill the build on its first line.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false
try {
    & $RscriptExe @rArgs 2>&1 | Tee-Object -FilePath $LogFile -Append
    $code = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $prevEAP
    Pop-Location
}

# ---- 3. what got built ---------------------------------------------------------
# The builder prints "(n/m with land mix)" per municipality and "[land mix
# failed: ...]" when the window stack could not be built for one. Both are
# findings worth a line here; neither is fatal on its own (the shard still
# carries cp/dom and the app falls back to the register for that muni).
$log = Get-Content $LogFile -ErrorAction SilentlyContinue
$built   = @($log | Where-Object { $_ -match '\(\d+/\d+ with land mix\)' })
$partial = @($built | Where-Object { $_ -match '\((\d+)/(\d+) with land mix\)' -and $Matches[1] -ne $Matches[2] })
$failed  = @($log | Where-Object { $_ -match 'land mix failed' })
$meta = $null
try { $meta = (Get-Content $IndexJson -Raw | ConvertFrom-Json)._meta } catch { }

Write-Log ('built: {0} municipalities; {1} with an incomplete land mix; {2} window-stack failures' -f $built.Count, $partial.Count, $failed.Count)
if ($meta) {
    Write-Log ('index: generated {0}, source {1}, window {2}, rule >= {3} years{4}' -f $meta.generated_at, $meta.source,
        ($meta.window -join '-'), $meta.cult_rule.min_years, $(if ($meta.cult_rule.recent_override) { ' or latest year' } else { '' }))
} else {
    Write-Log ('index: WARNING could not read {0}' -f $IndexJson)
}

# Prune logs older than 400 days -- a year of runs plus a margin.
Get-ChildItem $LogDir -Filter 'landfacts-refresh-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-400) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($code -ne 0) {
    Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
    Write-Host ('!!  LAND FACTS REBUILD FAILED (exit {0}).' -f $code)
    Write-Host '!!'
    Write-Host '!!  The shards already in mb-parcel-data are untouched (each is replaced'
    Write-Host '!!  whole or not at all), so the site keeps serving the previous build.'
    Write-Host '!!  The 15th 04:30 publish will pin whatever is there -- a mix of old and'
    Write-Host '!!  new shards is safe; the app falls back per parcel.'
    Write-Host '!!'
    Write-Host ('!!  Detail: {0}' -f $LogFile)
    Write-Host '!!  Usual causes: the mao-assembly Parquet missing or partial, or a window'
    Write-Host '!!  year not cached (bash ../rural-report/fetch_aci.sh).'
    Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
    exit $code
}
if ($partial.Count -or $failed.Count) {
    Write-Host ('[landfacts-refresh] done with findings: {0} municipalities with an incomplete mix, {1} window failures -- see {2}' -f $partial.Count, $failed.Count, $LogFile)
    exit 0
}
Write-Host '[landfacts-refresh] done.'
exit 0
