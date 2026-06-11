# release-indexes.ps1 — one-command refresh of the GitHub-Release-hosted
# data indexes (legal-index.json ~130 MB, assessment-index.json ~17 MB).
#
# Replaces the manual 3-step dance (rebuild -> upload to a GitHub
# release -> hand-edit RELEASE_URL in two edge functions) that
# FUTURE_WORK.md flagged as maintenance friction:
#
#   1. Rebuilds both indexes via the R scripts (skip with -SkipBuild
#      when the JSONs are already fresh, e.g. right after a
#      monthly-refresh run).
#   2. Sanity-checks the output sizes so a stub file can't ship.
#   3. Creates GitHub release <tag> carrying both JSONs as assets.
#   4. Rewrites the RELEASE_URL tag segment in api/legal-index.js and
#      api/assessment-index.js (owner/repo/asset names are preserved
#      from whatever the files already point at).
#   5. Stops short of committing — review `git diff api/`, then commit
#      and push; Vercel redeploys the edge functions and the 7-day
#      edge cache keys off the new URL automatically.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File release-indexes.ps1
#   powershell ... -File release-indexes.ps1 -Tag data-2026-07-15 -SkipBuild
#   powershell ... -File release-indexes.ps1 -DryRun     # print, change nothing

param(
  [string]$Tag = ("data-{0}" -f (Get-Date -Format 'yyyy-MM-dd')),
  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$assets = @(
  @{ file = Join-Path $root 'web\public\data\legal-index.json';      api = Join-Path $root 'api\legal-index.js';      minMB = 50; build = 'r\build_legal_index.R' },
  @{ file = Join-Path $root 'web\public\data\assessment-index.json'; api = Join-Path $root 'api\assessment-index.js'; minMB = 5;  build = 'r\build_assessment_index.R' }
)

function Find-Rscript {
  $cmd = Get-Command Rscript -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $found = Get-ChildItem 'C:\Program Files\R\R-*\bin\Rscript.exe' -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.FullName -replace '.*\\R-([\d.]+)\\.*', '$1') } -Descending |
    Select-Object -First 1
  if ($found) { return $found.FullName }
  throw 'Rscript.exe not found on PATH or under C:\Program Files\R'
}

function Find-Gh {
  $cmd = Get-Command gh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:USERPROFILE\bin\gh.exe", 'C:\Program Files\GitHub CLI\gh.exe')) {
    if (Test-Path $p) { return $p }
  }
  throw 'gh CLI not found (PATH, %USERPROFILE%\bin, or Program Files)'
}

# --- preflight ---------------------------------------------------------
$gh = Find-Gh
& $gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw 'gh CLI is not authenticated (run: gh auth login)' }
& $gh release view $Tag *> $null
if ($LASTEXITCODE -eq 0) { throw "Release '$Tag' already exists — pass -Tag with a new name" }

# --- 1. rebuild --------------------------------------------------------
if ($SkipBuild) {
  Write-Host 'Skipping index rebuild (-SkipBuild).'
} elseif ($DryRun) {
  Write-Host "[dry-run] would rebuild: $($assets.build -join ', ')"
} else {
  $rscript = Find-Rscript
  foreach ($a in $assets) {
    Write-Host "Building $($a.build) ..."
    & $rscript $a.build
    if ($LASTEXITCODE -ne 0) { throw "$($a.build) failed (exit $LASTEXITCODE)" }
  }
}

# --- 2. sanity-check sizes ---------------------------------------------
foreach ($a in $assets) {
  if (-not (Test-Path $a.file)) { throw "Missing: $($a.file) — run without -SkipBuild" }
  $mb = (Get-Item $a.file).Length / 1MB
  if ($mb -lt $a.minMB) {
    throw ("{0} is only {1:n1} MB (expected >= {2} MB) — refusing to release a stub" -f `
      [IO.Path]::GetFileName($a.file), $mb, $a.minMB)
  }
  Write-Host ("  {0,-24} {1,8:n1} MB" -f [IO.Path]::GetFileName($a.file), $mb)
}

# --- 3. create the release ---------------------------------------------
$files = $assets | ForEach-Object { $_.file }
if ($DryRun) {
  Write-Host "[dry-run] would run: gh release create $Tag <both JSONs> --title 'Data indexes $Tag'"
} else {
  Write-Host "Creating release $Tag (the 130 MB upload takes a few minutes) ..."
  & $gh release create $Tag @files --title "Data indexes $Tag" `
    --notes 'legal-index.json + assessment-index.json rebuilt from the latest mao-scrape. Served to the app through the api/ edge functions.'
  if ($LASTEXITCODE -ne 0) { throw "gh release create failed (exit $LASTEXITCODE)" }
}

# --- 4. point the edge functions at the new tag -------------------------
foreach ($a in $assets) {
  $assetName = [IO.Path]::GetFileName($a.file)
  $content = Get-Content $a.api -Raw
  $pattern = '(?<=/releases/download/)[^/]+(?=/' + [regex]::Escape($assetName) + ')'
  if ($content -notmatch $pattern) { throw "No RELEASE_URL for $assetName found in $($a.api)" }
  $old = [regex]::Match($content, $pattern).Value
  if ($DryRun) {
    Write-Host "[dry-run] $([IO.Path]::GetFileName($a.api)): tag $old -> $Tag"
  } else {
    Set-Content -Path $a.api -Value ($content -replace $pattern, $Tag) -NoNewline
    Write-Host "$([IO.Path]::GetFileName($a.api)): tag $old -> $Tag"
  }
}

if ($DryRun) {
  Write-Host "`n[dry-run] no changes made."
} else {
  Write-Host "`nDone. Review `git diff api/`, then commit + push — Vercel redeploys the"
  Write-Host 'edge functions and clients pick up the new index on their next fetch.'
}
# Don't let the last native command's exit code (e.g. the expected
# nonzero from `gh release view` on a fresh tag) leak out as failure.
exit 0
