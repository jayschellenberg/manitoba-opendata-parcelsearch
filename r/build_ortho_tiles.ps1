# build_ortho_tiles.ps1
#
# Turn ANY high-resolution Manitoba aerial ortho mosaic (ECW or GeoTIFF) into a
# single web PMTiles archive for the app's optional "Aerial <year>" basemap.
# Ported from the WpgOpenData ParcelSearch build (which auto-resolved the City
# of Winnipeg ECW), generalized here because non-Winnipeg Manitoba has NO live
# ortho tile service -- the public sources are download-only rasters (a
# municipal ortho mosaic, or an MLI regional block), so we tile them ourselves.
#
# There is deliberately no province-wide default source: pick a source raster
# that is actually higher quality than the Esri World Imagery the app already
# ships, and only for the extent it covers (the app falls back to Esri outside
# it). Candidates:
#   - City of Winnipeg annual ortho (7.5 cm ECW) -- data.winnipeg.ca sf35-zz6g;
#     its blob URL can be passed to -SourceUrl (see WpgOpenData for the index).
#   - MLI regional colour ortho (Capital Region 50 cm, ~2014) -- mli.gov.mb.ca,
#     download the .SID/.TIF blocks and mosaic them, then pass -SourceFile.
#   - Any municipal open-data ortho GeoTIFF.
#
# Pipeline:
#   1. acquire the source (download -SourceUrl resumably, or use -SourceFile)
#   2. (if a .zip) unzip and find the largest raster inside
#   3. gdalwarp -> EPSG:3857, capped at -TargetResM, into MBTiles (JPEG);
#      gdaladdo builds the lower-zoom pyramid
#   4. pmtiles convert MBTiles -> <Name>.pmtiles
#   5. print the Cloudflare R2 upload + app-wiring steps (creds stay with you)
#
# PREREQUISITES:
#   - OSGeo4W GDAL. The ECW plugin (gdal_ECW_JP2ECW.dll under
#     apps\gdal\lib\gdalplugins) is required ONLY for .ecw sources -- usually
#     already present with OSGeo4W. This script sources o4w_env.bat itself so a
#     plain PowerShell run works. Add the plugin once if an .ecw source fails:
#       C:\OSGeo4W\bin\osgeo4w-setup.exe -q -k -P gdal-ecw
#   - go-pmtiles binary (default: the sibling WpgOpenData\tools\pmtiles.exe).
#   - Free scratch disk ~2-3x the source size during the build.
#
# Usage:
#   # a downloaded Winnipeg ECW mosaic (7.5 cm), tiled to ~15 cm/px (z20):
#   powershell -ExecutionPolicy Bypass -File r\build_ortho_tiles.ps1 `
#     -SourceUrl 'https://wpgopendata.blob.core.windows.net/ortho-photos-2024/...ecw.zip' `
#     -Name 'mb-ortho-winnipeg-2024' -OrthoYear 2024 `
#     -Attribution 'Aerial imagery (c) City of Winnipeg 2024'
#
#   # a local MLI Capital Region mosaic (50 cm), coarser cap:
#   powershell -ExecutionPolicy Bypass -File r\build_ortho_tiles.ps1 `
#     -SourceFile 'D:\MBOrtho\capital-region-2014.tif' -TargetResM 0.5 `
#     -Name 'mb-ortho-capitalregion-2014' -OrthoYear 2014 `
#     -Attribution 'Aerial imagery (c) Manitoba Land Initiative ~2014'

param(
  [string] $SourceUrl   = '',                                    # URL to a source raster (ecw/tif) or .zip; OR use -SourceFile
  [string] $SourceFile  = '',                                    # local source raster (ecw/tif); takes precedence over -SourceUrl
  [Parameter(Mandatory = $true)]
  [string] $Name,                                                # output basename, e.g. 'mb-ortho-winnipeg-2024' (no extension, no path)
  [int]    $OrthoYear   = 0,                                     # stamped into the wiring hint; defaults to the current year if 0
  [string] $Attribution = '',                                    # basemap attribution string (required for defensible sourcing)
  [double] $TargetResM  = 0.149,                                 # 3857 m/px cap: 0.075~z21, 0.149~z20, 0.3~z19, 0.5/1.0 for coarse provincial sources
  [int]    $JpegQuality = 82,
  [string] $WorkDir     = 'D:\MBOrtho',                          # scratch: OUTSIDE Dropbox + the git repo (build churns many GB of transient files)
  [string] $GdalBin     = 'C:\OSGeo4W\bin',
  [string] $PmtilesExe  = 'D:\Dropbox\ClaudeCode\WpgOpenData\tools\pmtiles.exe',
  [switch] $Force
)
$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

if ($Name -match '[\\/:*?"<>|]') { throw "-Name must be a bare filename (no path/extension): '$Name'" }
if (-not $SourceUrl -and -not $SourceFile) { throw "provide -SourceUrl or -SourceFile (no province-wide default source exists)" }
if (-not $Attribution) { throw "-Attribution is required (the ortho's source-of-record, shown on the map)" }
if ($OrthoYear -le 0) { $OrthoYear = (Get-Date).Year }

$gdalinfo = Join-Path $GdalBin 'gdalinfo.exe'
$gdalwarp = Join-Path $GdalBin 'gdalwarp.exe'
$gdaladdo = Join-Path $GdalBin 'gdaladdo.exe'
foreach ($exe in @($gdalinfo, $gdalwarp, $gdaladdo, $PmtilesExe)) {
  if (-not (Test-Path $exe)) { throw "missing tool: $exe" }
}

# --- Load the OSGeo4W environment ------------------------------------------
# The OSGeo4W GDAL exes need GDAL_DATA / PROJ_LIB and -- crucially -- the
# gdal-plugins path on GDAL_DRIVER_PATH, or the ECW driver silently doesn't
# load. o4w_env.bat sets all of it; import its vars into this session so a
# plain PowerShell run works.
$o4w = Join-Path $GdalBin 'o4w_env.bat'
if (Test-Path $o4w) {
  cmd /c "`"$o4w`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$' -and $matches[1] -notmatch '^[=(]') {
      try { Set-Item -Path "Env:\$($matches[1])" -Value $matches[2] -ErrorAction Stop } catch {}
    }
  }
} else {
  Write-Warning "OSGeo4W env script not found at $o4w -- GDAL may miss its data / the ECW plugin."
}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

# --- 1. acquire the source raster ------------------------------------------
Step "Acquire source"
$src = $null
if ($SourceFile) {
  if (-not (Test-Path $SourceFile)) { throw "-SourceFile not found: $SourceFile" }
  $src = (Get-Item $SourceFile)
  Write-Host "  using local source: $($src.FullName)"
} else {
  # download (resumable) into the scratch dir, keeping the URL's extension
  $ext = [System.IO.Path]::GetExtension(($SourceUrl -split '\?')[0])
  if (-not $ext) { $ext = '.dat' }
  $dl = Join-Path $WorkDir ("$Name-source$ext")
  if ($Force -or -not (Test-Path $dl)) {
    Write-Host "  downloading $SourceUrl"
    & curl.exe -fL -C - --retry 5 -o $dl $SourceUrl           # -C - resumes a partial file
    if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE)" }
  } else { Write-Host "  have $dl" }
  # if it's a zip, unzip and take the largest raster inside
  if ($ext -ieq '.zip') {
    Step "Unzip"
    $before = Get-ChildItem -Path $WorkDir -File -Include '*.ecw', '*.tif', '*.tiff' -Recurse -ErrorAction SilentlyContinue
    Expand-Archive -Path $dl -DestinationPath $WorkDir -Force
    $src = Get-ChildItem -Path $WorkDir -File -Include '*.ecw', '*.tif', '*.tiff' -Recurse |
           Sort-Object Length -Descending | Select-Object -First 1
    if (-not $src) { throw "no .ecw/.tif raster found after unzip of $dl" }
  } else {
    $src = Get-Item $dl
  }
}
$srcExt = $src.Extension.ToLower()
Write-Host "  source raster: $($src.FullName)  ($([math]::Round($src.Length/1GB,2)) GB, $srcExt)"

# ECW driver is only needed for .ecw sources.
if ($srcExt -eq '.ecw') {
  $fmts = & $gdalinfo --formats 2>&1
  if (-not ($fmts -match '(?i)\bECW\b')) {
    throw "source is .ecw but GDAL has no ECW driver. Install it once:`n" +
          "  C:\OSGeo4W\bin\osgeo4w-setup.exe -q -k -P gdal-ecw`n" +
          "then re-run. (gdalinfo --formats must list ECW.)"
  }
}

# --- 2. warp -> EPSG:3857 MBTiles (JPEG) + overview pyramid -----------------
Step "Warp -> MBTiles (3857, JPEG q$JpegQuality, $TargetResM m/px)"
$mbt = Join-Path $WorkDir ("$Name.mbtiles")
if ((Test-Path $mbt) -and $Force) { Remove-Item $mbt -Force }
if (-not (Test-Path $mbt)) {
  # -tr in 3857 metres caps the base zoom. -b 1/2/3 drops any alpha so the JPEG
  # tile format is happy. This is the long step (tens of minutes on big sources).
  & $gdalwarp -t_srs EPSG:3857 -tr $TargetResM $TargetResM -r bilinear `
      -b 1 -b 2 -b 3 -of MBTILES `
      -co "TILE_FORMAT=JPEG" -co "QUALITY=$JpegQuality" `
      -multi -wo NUM_THREADS=ALL_CPUS -co "NUM_THREADS=ALL_CPUS" `
      $src.FullName $mbt
  if ($LASTEXITCODE -ne 0) { throw "gdalwarp failed ($LASTEXITCODE)" }

  Step "Build overview pyramid (lower zooms)"
  & $gdaladdo -r average $mbt 2 4 8 16 32 64 128 256
  if ($LASTEXITCODE -ne 0) { throw "gdaladdo failed ($LASTEXITCODE)" }
}
Write-Host "  MBTiles: $([math]::Round((Get-Item $mbt).Length/1GB,2)) GB"

# --- 3. MBTiles -> PMTiles -------------------------------------------------
Step "Convert -> PMTiles"
$pm = Join-Path $WorkDir ("$Name.pmtiles")
if (Test-Path $pm) { Remove-Item $pm -Force }
& $PmtilesExe convert $mbt $pm
if ($LASTEXITCODE -ne 0) { throw "pmtiles convert failed ($LASTEXITCODE)" }
Write-Host "  PMTiles: $([math]::Round((Get-Item $pm).Length/1GB,2)) GB  -> $pm"
& $PmtilesExe show $pm 2>&1 | Select-String -Pattern 'tile type|min zoom|max zoom|bounds' | ForEach-Object { "    $_" }

# --- 4. upload to Cloudflare R2 + wire the app (you run this) ---------------
Step "Next: upload to Cloudflare R2, then wire the app"
@"
The tileset is built: $pm

1. Upload to your R2 bucket (egress is free):
     rclone copy "$pm" r2:<your-bucket>/ --s3-no-check-bucket --progress
   Enable public access (R2 dashboard -> Settings -> Public access, or a custom
   domain). Public URL will be e.g. https://<public-r2-domain>/$Name.pmtiles

2. Pin it in web/src/map.js:
     ORTHO_YEAR        = $OrthoYear
     ORTHO_PMTILES_URL = 'https://<public-r2-domain>/$Name.pmtiles'
     ORTHO_ATTRIBUTION = '$Attribution'

3. Allow the R2 host in vercel.json (JSON has no comments, so edit directly):
   add  https://<public-r2-domain>  to the Content-Security-Policy connect-src
   directive (next to the existing arcgis / cartocdn hosts).

Then the basemap toggle becomes a 3-state Streets -> Satellite -> Aerial cycle;
until the URL is pinned it stays the current 2-state Streets <-> Satellite.
"@ | Write-Host
