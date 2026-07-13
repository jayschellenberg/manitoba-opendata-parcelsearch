# Build the complete southern Manitoba MLI Ortho Refresh mosaic (2007-2013
# acquisition years; published by MLI as the 2007-2014 collection).
#
# Source order is chronological. GDAL VRT gives later rasters priority where
# acquisitions overlap, so the resulting mosaic shows the newest MLI image.

param(
  [string] $WorkDir = 'D:\MBOrtho',
  [string] $Name = 'mb-mli-ortho-2007-2013',
  [int] $DownloadThrottle = 12,
  [switch] $DownloadOnly,
  [switch] $SkipDownload,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$GdalBin = 'C:\OSGeo4W\bin'
$GenericBuilder = Join-Path $PSScriptRoot 'build_ortho_tiles.ps1'

function Step([string] $Message) {
  Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Get-MliLinks([string] $PageUrl) {
  $html = (Invoke-WebRequest -Uri $PageUrl -TimeoutSec 60).Content
  $base = [uri] $PageUrl
  @(
    [regex]::Matches($html, '(?i)href\s*=\s*["'']?([^"'' >]+\.sid(?:\?[^"'' >]*)?)') |
      ForEach-Object { ([uri]::new($base, $_.Groups[1].Value)).AbsoluteUri } |
      Sort-Object -Unique
  )
}

function New-DownloadItems([string[]] $Urls, [string] $Directory) {
  foreach ($url in $Urls) {
    [pscustomobject]@{
      Url = $url
      Path = Join-Path $Directory ([uri]::UnescapeDataString(([uri] $url).Segments[-1]))
    }
  }
}

function Invoke-Downloads([object[]] $Items, [int] $Throttle) {
  if (-not $Items.Count) { return }
  $results = $Items | ForEach-Object -Parallel {
    $item = $_
    try {
      if (Test-Path -LiteralPath $item.Path) {
        return [pscustomobject]@{ Success = $true; Url = $item.Url }
      }
      $part = "$($item.Path).part"
      New-Item -ItemType Directory -Force -Path (Split-Path $item.Path) | Out-Null
      # MLI advertises byte ranges but intermittently answers an open-ended
      # resume request with HTTP 200, which curl correctly refuses to append.
      # Restart incomplete files and rename only after a clean transfer.
      if (Test-Path -LiteralPath $part) { Remove-Item -Force -LiteralPath $part }
      $curlArgs = @('--fail', '--location', '--retry', '5', '--retry-delay', '2',
        '--silent', '--show-error', '--output', $part)
      $curlArgs += $item.Url
      & curl.exe @curlArgs
      if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{ Success = $false; Url = $item.Url }
      }
      Move-Item -Force -LiteralPath $part -Destination $item.Path
      [pscustomobject]@{ Success = $true; Url = $item.Url }
    } catch {
      [pscustomobject]@{ Success = $false; Url = $item.Url; Error = $_.Exception.Message }
    }
  } -ThrottleLimit $Throttle
  $failed = @($results | Where-Object { -not $_.Success })
  if ($failed.Count) {
    $failed | ForEach-Object { Write-Error "download failed: $($_.Url) $($_.Error)" -ErrorAction Continue }
    throw "$($failed.Count) download(s) failed; completed files were preserved"
  }
}

if (-not (Test-Path $GenericBuilder)) { throw "missing generic builder: $GenericBuilder" }
$o4w = Join-Path $GdalBin 'o4w_env.bat'
if (-not (Test-Path $o4w)) { throw "missing OSGeo4W environment: $o4w" }
cmd /c "`"$o4w`" >nul 2>&1 && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$' -and $matches[1] -notmatch '^[=(]') {
    try { Set-Item -Path "Env:\$($matches[1])" -Value $matches[2] -ErrorAction Stop } catch {}
  }
}

$sourceRoot = Join-Path $WorkDir 'mli-source'
$groups = [ordered]@{
  year12 = Join-Path $sourceRoot 'year12'
  year34 = Join-Path $sourceRoot 'year34'
  year5 = Join-Path $sourceRoot 'year5'
  shilo2012 = Join-Path $sourceRoot 'shilo2012'
  year7 = Join-Path $sourceRoot 'year7'
}
$groups.Values | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

$year12Urls = @(Get-MliLinks 'https://mli.gov.mb.ca/ortho/mrsid_tiles/orthoindex.html')
$year34Urls = @(Get-MliLinks 'https://mli.gov.mb.ca/ortho/index_orthor_3_image_map_alt.html')
$year5Urls = 130, 140, 150, 160, 170, 180, 190 | ForEach-Object {
  "https://mli.gov.mb.ca/ortho/mrsid_tiles/img_070142_rgb_1.0m_blk_$($_)_sid_mosaic.sid"
}
$shiloUrls = @(
  'https://mli.gov.mb.ca/ortho_refresh/img_110038_rgb_1.0m_shilo_resampled_sid_mosaic/shilo_10038_rgb_1.0m_resampled_mosaic.sid'
)
$year7ZipUrls = @(
  'https://mli.gov.mb.ca/ortho/year7_mosaics/ortho_refresh_year7_blockNE_N_1m.zip',
  'https://mli.gov.mb.ca/ortho/year7_mosaics/ortho_refresh_year7_blockNE_S_1m.zip',
  'https://mli.gov.mb.ca/ortho/year7_mosaics/ortho_refresh_year7_blockSE_1m.zip'
)

$downloadSets = @(
  [pscustomobject]@{ Name = 'Years 1-2 mosaics'; Items = @(New-DownloadItems $year12Urls $groups.year12) },
  [pscustomobject]@{ Name = 'Years 3-4 tiles'; Items = @(New-DownloadItems $year34Urls $groups.year34) },
  [pscustomobject]@{ Name = 'Year 5 block mosaics'; Items = @(New-DownloadItems $year5Urls $groups.year5) },
  [pscustomobject]@{ Name = '2012 Shilo patch'; Items = @(New-DownloadItems $shiloUrls $groups.shilo2012) },
  [pscustomobject]@{ Name = 'Year 7 eastern mosaics'; Items = @(New-DownloadItems $year7ZipUrls $groups.year7) }
)

if (-not $SkipDownload) {
  foreach ($set in $downloadSets) {
    Step "Download $($set.Name) ($($set.Items.Count) files)"
    Invoke-Downloads $set.Items $DownloadThrottle
  }
}

Step 'Extract Year 7 mosaics'
Get-ChildItem -LiteralPath $groups.year7 -Filter '*.zip' | ForEach-Object {
  $target = Join-Path $groups.year7 $_.BaseName
  if ($Force -and (Test-Path $target)) { Remove-Item -Recurse -Force -LiteralPath $target }
  if (-not (Test-Path $target)) { Expand-Archive -LiteralPath $_.FullName -DestinationPath $target }
}

$orderedSources = @(
  Get-ChildItem -LiteralPath $groups.year12 -Filter '*.sid' -File | Sort-Object Name
  Get-ChildItem -LiteralPath $groups.year34 -Filter '*.sid' -File | Sort-Object Name
  Get-ChildItem -LiteralPath $groups.year5 -Filter '*.sid' -File | Sort-Object Name
  Get-ChildItem -LiteralPath $groups.shilo2012 -Filter '*.sid' -File | Sort-Object Name
  Get-ChildItem -LiteralPath $groups.year7 -Filter '*.sid' -File -Recurse | Sort-Object FullName
)
if (-not $orderedSources.Count) { throw 'no source rasters found' }
$expectedCounts = [ordered]@{ year12 = 20; year34 = 1608; year5 = 7; shilo2012 = 1; year7 = 3 }
foreach ($entry in $expectedCounts.GetEnumerator()) {
  $actual = @(Get-ChildItem -LiteralPath $groups[$entry.Key] -Filter '*.sid' -File -Recurse).Count
  if ($actual -ne $entry.Value) {
    throw "incomplete $($entry.Key) source set: expected $($entry.Value) SID files, found $actual"
  }
}

$inventoryPath = Join-Path $WorkDir "$Name-sources.csv"
$orderedSources | Select-Object FullName, Length, LastWriteTime |
  Export-Csv -NoTypeInformation -Encoding utf8 $inventoryPath
$sourceList = Join-Path $WorkDir "$Name-source-list.txt"
$orderedSources.FullName | Set-Content -Encoding utf8 $sourceList

$totalGb = [math]::Round((($orderedSources | Measure-Object Length -Sum).Sum / 1GB), 2)
Write-Host "  sources: $($orderedSources.Count) files, $totalGb GB"
Write-Host "  inventory: $inventoryPath"
if ($DownloadOnly) { return }

Step 'Build chronological VRT (newest source wins overlaps)'
$vrt = Join-Path $WorkDir "$Name.vrt"
if ($Force -and (Test-Path $vrt)) { Remove-Item -Force $vrt }
if (-not (Test-Path $vrt)) {
  # One Year 1-2 SID lacks an embedded CRS (its coordinates are still UTM 14),
  # and the Year 7 mosaics add an alpha band. Assign the documented collection
  # CRS, allow the missing source CRS, and select RGB consistently.
  & (Join-Path $GdalBin 'gdalbuildvrt.exe') -overwrite -resolution highest `
    -allow_projection_difference -a_srs EPSG:26914 -b 1 -b 2 -b 3 `
    -input_file_list $sourceList $vrt
  if ($LASTEXITCODE -ne 0) { throw "gdalbuildvrt failed ($LASTEXITCODE)" }
}

Step 'Build Web Mercator zoom-16 PMTiles archive'
# Exact EPSG:3857 z16 resolution. At southern Manitoba's latitude this is
# about 1.54 ground metres/pixel: close to the nominal 1 m historical source,
# while keeping the province-scale JPEG archive and conversion copy practical.
& $GenericBuilder -SourceFile $vrt -Name $Name -OrthoYear 2013 -TargetResM 2.388657133911758 `
  -Attribution '(c) 2001 Her Majesty the Queen in Right of Manitoba, as represented by the Minister of Conservation. All rights reserved. MLI imagery acquired 2007-2013.' `
  -WorkDir $WorkDir -Force:$Force
if ($LASTEXITCODE -ne 0) { throw "PMTiles build failed ($LASTEXITCODE)" }

Write-Host "`nComplete: $(Join-Path $WorkDir "$Name.pmtiles")" -ForegroundColor Green
