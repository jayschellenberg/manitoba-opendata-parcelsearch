# prune-releases.ps1 - delete old "Data indexes" GitHub Releases so the weekly
# auto-publish (schedule_publish.ps1, since 2026-10-05) does not pile up
# ~170 MB per week (~9 GB/year) of superseded legal + assessment indexes.
#
# Keeps the newest -Keep releases tagged data-YYYY-MM-DD (default 4, about a
# month of weekly runs), so a bad publish can be rolled back by pointing
# api/*.js at an earlier tag. NEVER deletes a tag that api/legal-index.js or
# api/assessment-index.js currently reference, whatever its age. Releases with
# any other tag shape are not touched.
#
# Called by auto-publish-indexes.ps1 as its last step, after the push. Run by
# hand to preview:
#   powershell -ExecutionPolicy Bypass -File prune-releases.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File prune-releases.ps1 -Keep 6

param([int]$Keep = 4, [switch]$DryRun)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Two at least: right after a publish the edge functions still serve the
# previous tag until Vercel finishes the redeploy.
if ($Keep -lt 2) { throw "-Keep must be at least 2 (got $Keep)" }

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
  foreach ($p in @("$env:USERPROFILE\bin\gh.exe", 'C:\Program Files\GitHub CLI\gh.exe')) {
    if (Test-Path $p) { $gh = $p; break }
  }
}
if (-not $gh) { throw 'gh CLI not found (PATH, %USERPROFILE%\bin, or Program Files)' }

# Tags the live edge functions point at.
$inUse = foreach ($f in @('api\legal-index.js', 'api\assessment-index.js')) {
  $m = [regex]::Match((Get-Content (Join-Path $root $f) -Raw), '/releases/download/([^/]+)/')
  if (-not $m.Success) { throw "No RELEASE_URL found in $f - refusing to prune" }
  $m.Groups[1].Value
}
$inUse = @($inUse | Sort-Object -Unique)

$json = & $gh release list --limit 200 --json tagName,createdAt
if ($LASTEXITCODE -ne 0) { throw "gh release list failed (exit $LASTEXITCODE)" }
# Assigned before piping: Windows PowerShell 5.1's ConvertFrom-Json emits a
# JSON array as ONE object, so piping it straight on filters the whole array.
$parsed = ($json -join "`n") | ConvertFrom-Json
$releases = @($parsed | ForEach-Object { $_ } |
  Where-Object { $_.tagName -match '^data-\d{4}-\d{2}-\d{2}$' } |
  Sort-Object createdAt -Descending)

$drop = @($releases | Select-Object -Skip $Keep | Where-Object { $inUse -notcontains $_.tagName })
Write-Host ("{0} data release(s); keeping newest {1} plus in-use [{2}]; {3} to delete" -f `
  $releases.Count, $Keep, ($inUse -join ', '), $drop.Count)

foreach ($r in $drop) {
  if ($DryRun) { Write-Host "[dry-run] would delete $($r.tagName)"; continue }
  & $gh release delete $r.tagName --yes --cleanup-tag
  if ($LASTEXITCODE -ne 0) { throw "gh release delete $($r.tagName) failed (exit $LASTEXITCODE)" }
  Write-Host "deleted $($r.tagName)"
}
exit 0
