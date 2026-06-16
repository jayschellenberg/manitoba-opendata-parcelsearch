# auto-publish-indexes.ps1 — Unattended: rebuild the GitHub-Release-hosted legal +
# assessment indexes from the CURRENT mao-scrape parquets, then publish + deploy so the
# live site's "Data refreshed" date tracks the data automatically.
#
# This is the missing "deploy" half of the refresh story. monthly-refresh.bat rebuilds
# the index JSONs LOCALLY and stops; release-indexes.ps1 publishes but is run by hand.
# This script chains rebuild -> validate -> release -> commit -> push so no human step
# is needed. It does NOT re-scrape — the nightly mao-scrape delta keeps
# ../mao-scrape/results/*.parquet fresh; we just re-emit the indexes from them.
#
# Chain (aborts on the FIRST failure, so bad/partial data never reaches the live site):
#   1. Rscript r/build_legal_index.R + r/build_assessment_index.R   (from ../mao-scrape/results/*.parquet)
#   2. node web/scripts/build-manifest.js --validate                (regen manifest.json; GATE: row-collapse / vanished / truncated -> abort, nothing published)
#   3. release-indexes.ps1 -SkipBuild                               (size-check + GitHub Release + bump api/*.js RELEASE_URL)
#   4. git add api/*.js web/public/data/manifest.json; commit; push (Vercel auto-deploys the edge fns + new manifest)
#
# Safe to run anytime. Logs to logs/auto-publish-YYYYMMDD-HHmm.log; on any failure sends
# an email + ntfy alert (alert-lib.ps1). If nothing actually changed, the commit is a
# no-op and the push is skipped. Scheduled by schedule_publish.ps1.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File auto-publish-indexes.ps1
#   powershell -ExecutionPolicy Bypass -File auto-publish-indexes.ps1 -DryRun   # rebuild+validate only; no release/commit/push
#   powershell -ExecutionPolicy Bypass -File auto-publish-indexes.ps1 -TestAlert

param([switch]$DryRun, [switch]$TestAlert)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
. (Join-Path $root 'alert-lib.ps1')
$NtfyTopic = 'mbps-publish-indexes-jks'

if (-not (Test-Path logs)) { New-Item -ItemType Directory logs | Out-Null }
$ts  = Get-Date -Format 'yyyyMMdd-HHmm'
$log = Join-Path $root "logs\auto-publish-$ts.log"
function Log($m) { $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m; Write-Host $line; Add-Content -Path $log -Value $line }

if ($TestAlert) {
  $ok = Send-FailureAlert $root $NtfyTopic 'TEST - MB parcel index auto-publish alerts' `
        ("Test alert from auto-publish-indexes.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
         'If this reached you, auto-publish failure alerts are wired up.')
  if ($ok) { exit 0 } else { exit 1 }
}

function Find-Rscript {
  $cmd = Get-Command Rscript -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $f = Get-ChildItem 'C:\Program Files\R\R-*\bin\Rscript.exe' -ErrorAction SilentlyContinue |
       Sort-Object { [version]($_.FullName -replace '.*\\R-([\d.]+)\\.*', '$1') } -Descending | Select-Object -First 1
  if ($f) { return $f.FullName }
  throw 'Rscript.exe not found on PATH or under C:\Program Files\R'
}

try {
  Log "=== auto-publish-indexes started on $env:COMPUTERNAME (DryRun=$DryRun) ==="
  $rscript = Find-Rscript

  # 1. Rebuild both indexes from the current mao-scrape parquets.
  foreach ($s in @('r\build_legal_index.R', 'r\build_assessment_index.R')) {
    Log "rebuild: $s"
    & $rscript $s *>> $log
    if ($LASTEXITCODE -ne 0) { throw "$s failed (exit $LASTEXITCODE)" }
  }

  # 2. Regenerate + VALIDATE the manifest. The --validate gate refuses to write when a
  #    rebuild looks broken (collapsed row counts / vanished datasets / truncated files),
  #    so a bad scrape can never propagate to a public Release or the live site.
  Log 'build-manifest.js --validate'
  & node web\scripts\build-manifest.js --validate *>> $log
  if ($LASTEXITCODE -ne 0) { throw 'build-manifest --validate failed — NOT publishing (previous data stays live)' }

  if ($DryRun) {
    Log '[dry-run] validated OK; would now release-indexes.ps1 -SkipBuild + commit + push.'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'release-indexes.ps1') -SkipBuild -DryRun *>> $log
    Log '=== dry-run complete (no changes made) ==='; exit 0
  }

  # 3. Publish the rebuilt JSONs to a new GitHub Release and bump the edge-fn RELEASE_URLs.
  Log 'release-indexes.ps1 -SkipBuild'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'release-indexes.ps1') -SkipBuild *>> $log
  if ($LASTEXITCODE -ne 0) { throw "release-indexes.ps1 failed (exit $LASTEXITCODE)" }

  # 4. Commit the edge-fn URL bumps + manifest and push -> Vercel auto-deploys.
  & git add api/legal-index.js api/assessment-index.js web/public/data/manifest.json *>> $log
  $staged = git diff --cached --name-only
  if (-not $staged) { Log 'nothing changed to commit — already current; no deploy needed'; Log '=== complete ==='; exit 0 }
  Log "committing: $($staged -join ', ')"
  git commit -m "Auto-publish refreshed legal + assessment indexes ($ts)" `
             -m 'Rebuilt from the current mao-scrape parquets; new GitHub Release + manifest. Unattended via auto-publish-indexes.ps1.' `
             -m 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>' *>> $log
  if ($LASTEXITCODE -ne 0) { throw "git commit failed (exit $LASTEXITCODE)" }
  git push origin HEAD *>> $log   # explicit remote+ref: works even when the branch has no upstream set
  if ($LASTEXITCODE -ne 0) { throw "git push failed (exit $LASTEXITCODE)" }
  Log "pushed — Vercel will redeploy; the Data Sources 'Data refreshed' date updates once the deploy is live."
  Log '=== complete ==='
  exit 0
}
catch {
  Log "FAILED: $($_.Exception.Message)"
  $tail = if (Test-Path $log) { (Get-Content $log -Tail 40) -join "`n" } else { $_.Exception.Message }
  Send-FailureAlert $root $NtfyTopic "FAILED - MB parcel index auto-publish on $env:COMPUTERNAME" `
    ("auto-publish-indexes.ps1 failed at $(Get-Date -Format s).`n`nLast 40 log lines:`n$tail") | Out-Null
  exit 1
}
