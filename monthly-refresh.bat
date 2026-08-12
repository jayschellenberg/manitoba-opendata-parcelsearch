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
REM   5. Re-shard water influence from the same mao-assembly Parquet
REM      (non-fatal, same reasoning as step 4). Previously this script
REM      had no water step at all, so water shards only ever refreshed
REM      when someone remembered to run r\build_water.R by hand.
REM   6. Rebuild the RollEntry fallback snapshot from the newest
REM      RollEntry_YYYYMMDD.gpkg in this repo root (non-fatal). This was
REM      event-driven and manual until 2026-08-12 — "rebuild it whenever
REM      a fresh gpkg lands" — which meant in practice it lagged: on
REM      2026-08-12 all 187 shards were still built from the 2026-08-04
REM      gpkg while _20260811 sat in the repo, i.e. the degraded-mode
REM      fallback would have served week-old geometry during exactly the
REM      upstream outage it exists to cover. Monthly is the floor, not
REM      the ideal; rerun r\build_rollentry_snapshot.R by hand after any
REM      off-cycle download.
REM   7. Rebuild + VALIDATE the data manifest (--validate compares the
REM      fresh shard set against the previously written manifest and
REM      aborts on collapsed row counts / vanished datasets / corrupt
REM      sample shards, leaving the prior manifest in place). For a
REM      legitimate big change, rerun step 7 by hand with
REM      --accept-large-change.
REM
REM NOT part of this refresh: the Land Cover "Detailed" raster tiles
REM (r/build_landcover_tiles.R -> web/public/data/landcover-tiles/). They
REM derive from the static 2020 LCR_RCT_*.tif, so they only need
REM rebuilding when a NEW provincial land-cover raster lands — run that
REM script by hand then (it needs GDAL on PATH; ~15-45 min).
REM
REM No git commit or push happens here — the rebuilt JSON shards are
REM left in place under web/public/data/ and in the mb-parcel-data
REM clone. Next time you open the repo, `git status` will surface the
REM changed files; review the diff and commit when ready. The scheduled
REM companion task mb-parcelsearch-publish-indexes (04:30, 30 min later)
REM is what actually publishes and repins them.
REM
REM Non-fatal steps (4, 5, 6) leave the previous shards in place and let
REM the run continue, but they now set SOFTFAIL so the script still
REM exits nonzero at the end. Before 2026-08-12 a failed shard build was
REM logged and otherwise silent: the run "COMPLETED", Task Scheduler
REM recorded 0, the wrapper sent no alert, and the only symptom was data
REM that quietly stopped moving. Exit codes: 1 = aborted at a fatal
REM step, 3 = finished but one or more shard builds failed.
REM
REM Designed to be invoked by Windows Task Scheduler (see
REM schedule_monthly.ps1). Logs to logs/monthly-YYYYMMDD-HHmm.log so
REM scheduled runs leave a paper trail. Exits non-zero on any step
REM failure so Task Scheduler records the failure code.
REM
REM CAUTION when editing the error blocks below: literal parentheses in an
REM echo inside an if-block must be escaped as ^( and ^). cmd matches parens
REM while parsing the block, so an unescaped ")" closes the block early and
REM every following line runs UNCONDITIONALLY. Until 2026-08-12 all six
REM blocks read "(exit code !errorlevel!)", which made "exit /b 1" run even
REM on success — the script would have aborted at step 1 reporting a failure
REM that never happened. It was never caught because this .bat had never
REM actually run (logs/ held no monthly-*.log and the task had never fired).

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

REM Set by any non-fatal step that fails; converted to exit /b 3 at the end
REM so the wrapper alerts instead of the failure passing silently.
set SOFTFAIL=

REM ---------------------------------------------------------------
REM Step 1 — mao-scrape delta.
REM ---------------------------------------------------------------
echo --- step 1/7: mao-scrape delta --- >> "%LOGFILE%"
call "..\mao-scrape\run_delta.bat" >> "%LOGFILE%" 2>&1
set DELTARC=!errorlevel!
REM $2run_delta.R exits 2 for "DONE - WITH PROBLEMS": the delta COMPLETED and
REM wrote its parquets, but some rolls could not be re-fetched and were queued
REM in checkpoints\pending_refetch.csv for automatic retry. It exits nonzero
REM deliberately so the nightly wrapper alerts -- it is loud, not broken.
REM
REM `if errorlevel 1` is true for ANY code >= 1, so until 2026-08-12 that
REM routine outcome aborted this whole refresh at step 1 and steps 2-7 never
REM ran. It was never noticed because this .bat had never run: the delta has
REM ended "WITH PROBLEMS" on every one of the last 12+ nights (chunked-*.log
REM back to 2026-07-31), so the first scheduled run on 2026-08-15 would have
REM aborted immediately, reporting a failure that had not happened.
REM Exit 2 is now a soft failure: continue, but still exit 3 at the end so the
REM wrapper alerts. Anything else nonzero is still fatal.
if !DELTARC! EQU 2 (
  echo *** mao-scrape delta finished WITH PROBLEMS ^(exit 2^) - continuing with the rebuild >> "%LOGFILE%"
  echo *** unrecovered rolls are queued in mao-scrape\checkpoints\pending_refetch.csv >> "%LOGFILE%"
  set SOFTFAIL=1
) else if !DELTARC! NEQ 0 (
  echo *** mao-scrape delta FAILED ^(exit code !DELTARC!^) >> "%LOGFILE%"
  echo monthly-refresh aborted at step 1. See %LOGFILE% for details.
  exit /b 1
)

REM ---------------------------------------------------------------
REM Step 2 — rebuild legal-index JSON.
REM ---------------------------------------------------------------
echo. >> "%LOGFILE%"
echo --- step 2/7: build_legal_index.R --- >> "%LOGFILE%"
%RSCRIPT% r\build_legal_index.R >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo *** build_legal_index.R FAILED ^(exit code !errorlevel!^) >> "%LOGFILE%"
  echo monthly-refresh aborted at step 2. See %LOGFILE% for details.
  exit /b 1
)

REM ---------------------------------------------------------------
REM Step 3 — rebuild assessment-index + per-muni shards.
REM ---------------------------------------------------------------
echo. >> "%LOGFILE%"
echo --- step 3/7: build_assessment_index.R --- >> "%LOGFILE%"
%RSCRIPT% r\build_assessment_index.R >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo *** build_assessment_index.R FAILED ^(exit code !errorlevel!^) >> "%LOGFILE%"
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
echo --- step 4/7: build_landcover.R --- >> "%LOGFILE%"
%RSCRIPT% r\build_landcover.R >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo *** build_landcover.R FAILED ^(exit code !errorlevel!^) — continuing >> "%LOGFILE%"
  echo *** existing landcover shards left untouched >> "%LOGFILE%"
  set SOFTFAIL=1
)

REM ---------------------------------------------------------------
REM Step 5 — re-shard water influence from the mao-assembly Parquet.
REM Non-fatal for the same reason as step 4: it bridges a sister
REM project's output that may not exist on every machine.
REM ---------------------------------------------------------------
echo. >> "%LOGFILE%"
echo --- step 5/7: build_water.R --- >> "%LOGFILE%"
%RSCRIPT% r\build_water.R >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo *** build_water.R FAILED ^(exit code !errorlevel!^) — continuing >> "%LOGFILE%"
  echo *** existing water shards left untouched >> "%LOGFILE%"
  set SOFTFAIL=1
)

REM ---------------------------------------------------------------
REM Step 6 — rebuild the RollEntry fallback snapshot from the newest
REM RollEntry_YYYYMMDD.gpkg in this repo root (dropped here by
REM r\download_parcels.R, which the mao-assembly monthly wrapper runs).
REM Non-fatal like steps 4-5: a stale fallback is worse than a fresh
REM one but far better than aborting the run and publishing nothing.
REM ---------------------------------------------------------------
echo. >> "%LOGFILE%"
echo --- step 6/7: build_rollentry_snapshot.R --- >> "%LOGFILE%"
%RSCRIPT% r\build_rollentry_snapshot.R >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo *** build_rollentry_snapshot.R FAILED ^(exit code !errorlevel!^) — continuing >> "%LOGFILE%"
  echo *** existing rollentry-snapshot shards left untouched >> "%LOGFILE%"
  set SOFTFAIL=1
)

REM ---------------------------------------------------------------
REM Step 7 — rebuild the public/data manifest.
REM ---------------------------------------------------------------
echo. >> "%LOGFILE%"
echo --- step 7/7: build-manifest.js --validate --- >> "%LOGFILE%"
%NODE% web\scripts\build-manifest.js --validate >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo *** build-manifest.js FAILED ^(exit code !errorlevel!^) >> "%LOGFILE%"
  echo monthly-refresh aborted at step 7. See %LOGFILE% for details.
  exit /b 1
)

echo. >> "%LOGFILE%"
if defined SOFTFAIL (
  echo === monthly-refresh COMPLETED WITH PROBLEMS %DATE% %TIME% >> "%LOGFILE%"
  echo === one or more non-fatal shard builds failed - search this log for FAILED >> "%LOGFILE%"
  echo === those datasets still hold their PREVIOUS shards and are now stale >> "%LOGFILE%"
) else (
  echo === monthly-refresh COMPLETED %DATE% %TIME% >> "%LOGFILE%"
)
echo. >> "%LOGFILE%"
echo Refreshed shards left under web\public\data\. Open the repo and >> "%LOGFILE%"
echo `git status` will surface the changes for your review + commit. >> "%LOGFILE%"

if defined SOFTFAIL (
  echo monthly-refresh finished but a shard build failed. See %LOGFILE%.
  endlocal & exit /b 3
)

endlocal & exit /b 0
