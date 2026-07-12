@echo off
REM monthly-refresh.bat — orchestrates the monthly MAO data refresh.
REM
REM Steps:
REM   1. Call the mao-scrape delta runner ($2run_delta.R via run_delta.bat).
REM   2. Rebuild the legal-index JSON from results/parcels.parquet.
REM   3. Rebuild the assessment-index JSON + per-muni shards.
REM   4. Re-shard the land-cover buckets from the latest mao-assembly
REM      Parquet (non-fatal — skipped with a warning if that sister
REM      project's output isn't present; the 2020 raster is static so
REM      this only changes when parcels change).
REM   5. Rebuild + VALIDATE the data manifest (--validate compares the
REM      fresh shard set against the previously written manifest and
REM      aborts on collapsed row counts / vanished datasets / corrupt
REM      sample shards, leaving the prior manifest in place). For a
REM      legitimate big change, rerun step 5 by hand with
REM      --accept-large-change.
REM
REM NOT part of this refresh: the Land Cover "Detailed" raster tiles
REM (r/build_landcover_tiles.R -> web/public/data/landcover-tiles/). They
REM derive from the static 2020 LCR_RCT_*.tif, so they only need
REM rebuilding when a NEW provincial land-cover raster lands — run that
REM script by hand then (it needs GDAL on PATH; ~15-45 min).
REM
REM No git commit or push happens here — the rebuilt JSON shards are
REM left in place under web/public/data/. Next time you open the
REM repo, `git status` will surface the changed files; review the diff
REM and commit when ready.
REM
REM Designed to be invoked by Windows Task Scheduler (see
REM schedule_monthly.ps1). Logs to logs/monthly-YYYYMMDD-HHmm.log so
REM scheduled runs leave a paper trail. Exits non-zero on any step
REM failure so Task Scheduler records the failure code.

setlocal EnableDelayedExpansion

REM Always run from this script's directory (the mb-parcelsearch repo root).
cd /d "%~dp0"

REM Build a YYYYMMDD-HHMM timestamp.
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd-HHmm'"`) do set TS=%%t

if not exist logs mkdir logs
set LOGFILE=logs\monthly-%TS%.log

REM Locate Rscript: prefer PATH, else the newest R under Program Files.
REM (Previously pinned to R-4.5.3, which broke on every R upgrade.)
set RSCRIPT=
for /f "usebackq delims=" %%p in (`where Rscript 2^>nul`) do if not defined RSCRIPT set RSCRIPT="%%p"
if not defined RSCRIPT (
  for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "Get-ChildItem 'C:\Program Files\R\R-*\bin\Rscript.exe' -ErrorAction SilentlyContinue | Sort-Object {[version]($_.FullName -replace '.*\\R-([\d.]+)\\.*','$1')} -Descending | Select-Object -First 1 -ExpandProperty FullName"`) do set RSCRIPT="%%p"
)
if not defined RSCRIPT (
  echo *** Rscript.exe not found on PATH or under "C:\Program Files\R" — install R or add it to PATH
  echo *** Rscript.exe not found on PATH or under "C:\Program Files\R" >> "%LOGFILE%"
  exit /b 1
)
set NODE="node"

echo === monthly-refresh started %DATE% %TIME% > "%LOGFILE%"
echo === working dir: %CD% >> "%LOGFILE%"
echo. >> "%LOGFILE%"

REM ---------------------------------------------------------------
REM Step 1 — mao-scrape delta.
REM ---------------------------------------------------------------
echo --- step 1/5: mao-scrape delta --- >> "%LOGFILE%"
call "..\mao-scrape\run_delta.bat" >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo *** mao-scrape delta FAILED (exit code !errorlevel!) >> "%LOGFILE%"
  echo monthly-refresh aborted at step 1. See %LOGFILE% for details.
  exit /b 1
)

REM ---------------------------------------------------------------
REM Step 2 — rebuild legal-index JSON.
REM ---------------------------------------------------------------
echo. >> "%LOGFILE%"
echo --- step 2/5: build_legal_index.R --- >> "%LOGFILE%"
%RSCRIPT% r\build_legal_index.R >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo *** build_legal_index.R FAILED (exit code !errorlevel!) >> "%LOGFILE%"
  echo monthly-refresh aborted at step 2. See %LOGFILE% for details.
  exit /b 1
)

REM ---------------------------------------------------------------
REM Step 3 — rebuild assessment-index + per-muni shards.
REM ---------------------------------------------------------------
echo. >> "%LOGFILE%"
echo --- step 3/5: build_assessment_index.R --- >> "%LOGFILE%"
%RSCRIPT% r\build_assessment_index.R >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo *** build_assessment_index.R FAILED (exit code !errorlevel!) >> "%LOGFILE%"
  echo monthly-refresh aborted at step 3. See %LOGFILE% for details.
  exit /b 1
)

REM ---------------------------------------------------------------
REM Step 4 — re-shard land-cover buckets from the mao-assembly Parquet.
REM Non-fatal: this bridges a sister project's output, which may not be
REM present on every machine. A failure here logs a warning and leaves
REM the existing landcover shards in place rather than aborting the run.
REM ---------------------------------------------------------------
echo. >> "%LOGFILE%"
echo --- step 4/5: build_landcover.R --- >> "%LOGFILE%"
%RSCRIPT% r\build_landcover.R >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo *** build_landcover.R FAILED (exit code !errorlevel!) — continuing >> "%LOGFILE%"
  echo *** existing web\public\data\landcover shards left untouched >> "%LOGFILE%"
)

REM ---------------------------------------------------------------
REM Step 5 — rebuild the public/data manifest.
REM ---------------------------------------------------------------
echo. >> "%LOGFILE%"
echo --- step 5/5: build-manifest.js --validate --- >> "%LOGFILE%"
%NODE% web\scripts\build-manifest.js --validate >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo *** build-manifest.js FAILED (exit code !errorlevel!) >> "%LOGFILE%"
  echo monthly-refresh aborted at step 5. See %LOGFILE% for details.
  exit /b 1
)

echo. >> "%LOGFILE%"
echo === monthly-refresh COMPLETED %DATE% %TIME% >> "%LOGFILE%"
echo. >> "%LOGFILE%"
echo Refreshed shards left under web\public\data\. Open the repo and >> "%LOGFILE%"
echo `git status` will surface the changes for your review + commit. >> "%LOGFILE%"

endlocal & exit /b 0
