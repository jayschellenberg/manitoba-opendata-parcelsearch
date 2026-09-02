# rebuild-basemap.ps1 -- refresh the self-hosted Protomaps streets basemap
# (basemap-manitoba.pmtiles) from the newest Protomaps daily OpenStreetMap
# build and publish it to BOTH R2 buckets (Manitoba app + Winnipeg app).
#
# Context: since 2026-09 the Streets basemap in both ParcelSearch apps is one
# PMTiles archive on R2, cut from the Protomaps planet build with `pmtiles
# extract --bbox`, and styled in the browser by @protomaps/basemaps. Nothing
# about it needs a key or a quota; the one thing it needs is to be re-cut
# now and then so road changes reach the map. See MAINTENANCE.md 7b.
#
# What "safe to run unattended" means here, in order:
#   1. The newest daily build is found by probing build.protomaps.com for
#      today's date and walking back up to 14 days (there is no machine-
#      readable index). Its metadata is read remotely (header + metadata only,
#      not the 137 GB planet) BEFORE anything is extracted.
#   2. Schema gate: the build's tileset major version must equal the one the
#      deployed @protomaps/basemaps was written against, and every source-layer
#      the style reads must be present. A build that fails this is REFUSED,
#      not uploaded -- the style would render nothing against it.
#   3. Extract to a local temp dir (never Dropbox: 1 GB of churn for nothing),
#      then `pmtiles verify` + a size band (800 MB - 3 GB; a truncated extract
#      is the realistic failure) + the bbox/maxzoom read back from the header.
#   4. Staged publish per bucket: upload under a .staging name, size-verify,
#      server-side rename over the live object, size-verify again, then a
#      public HTTP range probe. Production never has a moment with no file,
#      and a failed upload leaves the previous archive serving -- the same
#      lesson as the 2026-08-05 parcels release outage.
#   5. A small meta sidecar (basemap-manitoba.meta.json) is published next to
#      the archive. basemap-staleness-check.ps1 reads it from the public URL
#      -- i.e. it watches what production actually serves, not this machine.
#
# The pmtiles CLI is pinned by version AND zip SHA-256 and self-installs into
# %LOCALAPPDATA%\Programs\pmtiles when missing, so a fresh machine or a wiped
# temp dir cannot silently turn this into a no-op.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File rebuild-basemap.ps1                     # extract + verify, leave on disk
#   powershell -ExecutionPolicy Bypass -File rebuild-basemap.ps1 -Publish            # ... and publish to both buckets
#   powershell -ExecutionPolicy Bypass -File rebuild-basemap.ps1 -IfStale -Publish   # what the schedule runs
#   powershell -ExecutionPolicy Bypass -File rebuild-basemap.ps1 -Build 20260831     # pin a specific daily build
#   powershell -ExecutionPolicy Bypass -File rebuild-basemap.ps1 -TestAlert          # prove the alert path
#
# Exit codes: 0 clean (including "skipped, already current"), 1 a step failed
# (alert sent). ASCII-only on purpose so Windows PowerShell 5.1 (the
# scheduled-task runtime) parses it without a BOM.

[CmdletBinding()]
param(
    # Skip when the published sidecar already records this daily build. The
    # schedule passes this; a manual run without it always re-cuts.
    [switch]$IfStale,

    # Publish to both buckets. Opt-in like rebuild-parcel-tiles.ps1: the
    # unattended schedule passes it, a human iterating on bbox/zoom does not.
    [switch]$Publish,

    # Send a test through the alert path and exit.
    [switch]$TestAlert,

    # Daily build to use, YYYYMMDD. Default: newest one that exists.
    [string]$Build,

    # Where the extract lands. Default is local temp, deliberately outside
    # Dropbox.
    [string]$WorkDir = (Join-Path $env:LOCALAPPDATA 'Temp\mb-basemap')
)

# ---- constants -------------------------------------------------------------
# -jks suffix: the topic-name convention every wrapper here follows, and the
# thing actually subscribed in the ntfy app.
$NtfyTopic = 'mbps-basemap-jks'

# Both apps serve the identical archive from their own bucket (each CSP allows
# only its own r2.dev host). Order matters only for the -IfStale check, which
# reads the first target's sidecar.
$Targets = @(
    @{ Name = 'Manitoba'; Remote = 'r2-mb:mb-ortho'; Public = 'https://pub-091058079bf6458da1681945177e1682.r2.dev' },
    @{ Name = 'Winnipeg'; Remote = 'r2:wpg-ortho';   Public = 'https://pub-f351b204f73e4b2287acad946d79681c.r2.dev' }
)
$ObjectName = 'basemap-manitoba.pmtiles'
$MetaName   = 'basemap-manitoba.meta.json'

# The cut. Manitoba plus a margin so neighbouring provinces/states draw at
# province-wide zooms. z15 is the planet build's own maximum; MapLibre
# overzooms it cleanly to z20.
$Bbox    = '-102.5,48.5,-88.5,60.5'
$MaxZoom = 15

# Schema gate. @protomaps/basemaps' layers() are written against the tileset
# schema; the deployed package is 5.x, which targets tileset v4. Bump this
# together with the npm package, never alone.
$ExpectedTilesetMajor = 4
$RequiredLayers = @('boundaries','buildings','earth','landcover','landuse','places','pois','roads','water')

# Sanity band for the finished archive. First build was 1.09 GB.
$MinBytes = 800MB
$MaxBytes = 3GB

# Pinned CLI. Bumping: update all three, and re-derive the hash from the
# release zip (Get-FileHash -Algorithm SHA256).
$PmtilesVersion   = '1.31.2'
$PmtilesZipSha256 = 'a658baa4d7e55020aef6ca17bd9ff9faa1582671266b36f58c52db0ac8e785a1'
$PmtilesZipUrl    = "https://github.com/protomaps/go-pmtiles/releases/download/v$PmtilesVersion/go-pmtiles_${PmtilesVersion}_Windows_x86_64.zip"
$PmtilesHome      = Join-Path $env:LOCALAPPDATA 'Programs\pmtiles'

$BuildBase = 'https://build.protomaps.com'

# 'Continue', not 'Stop': under Windows PowerShell 5.1 a native command's
# stderr redirected with 2>&1 becomes error records, and with Stop the first
# progress line pmtiles prints would abort the run. Every step checks
# $LASTEXITCODE explicitly instead.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'alert-lib.ps1')

# TLS 1.2 for the GitHub / R2 / Protomaps fetches under 5.1.
try { [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir ("basemap-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    # Write-Host, NOT Write-Output: this is called inside functions that
    # return values (Resolve-Pmtiles), and Write-Output would splice the log
    # line into the return value -- the 2026-09-01 first run failed exactly
    # that way, with $pm becoming @('[18:58:42] installing...', 'C:\...exe').
    Write-Host $line
    # logs\ lives inside Dropbox (deliberately -- see MAINTENANCE.md), and
    # Dropbox's sync client briefly locks a file it has just noticed, so a
    # burst of log lines can hit "being used by another process". Retry a
    # few times; a lost log line is not worth failing a publish over.
    for ($try = 1; $try -le 5; $try++) {
        try { Add-Content -Path $log -Value $line -ErrorAction Stop; break }
        catch { if ($try -eq 5) { Write-Host "  (log write skipped: $($_.Exception.Message))" } else { Start-Sleep -Milliseconds 250 } }
    }
}

function Fail([string]$what, [string]$detail) {
    Write-Log "FAILED: $what"
    if ($detail) { Write-Log $detail }
    try {
        Send-FailureAlert $root $NtfyTopic `
            "FAILED - Protomaps basemap rebuild on $env:COMPUTERNAME" `
            "$what`n`n$detail`n`nLog: $log" | Out-Null
    } catch {
        Write-Log "(alert delivery also failed: $($_.Exception.Message))"
    }
    exit 1
}

# Run a native command, capture everything, return @{ Code; Lines }. pmtiles
# prints progress with carriage returns; keep only the last state of each line.
function Invoke-Native([string]$exe, [string[]]$argv) {
    $raw = & $exe @argv 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $lines = @()
    foreach ($r in $raw) { foreach ($piece in ($r -split "`r")) { if ($piece.Trim()) { $lines += $piece } } }
    return @{ Code = $code; Lines = $lines }
}

$started = Get-Date
Write-Log "Protomaps basemap rebuild starting"
Write-Log "Log: $log"

if ($TestAlert) {
    $ok = Send-FailureAlert $root $NtfyTopic 'TEST - Protomaps basemap rebuild alerts' `
          ("Test alert from rebuild-basemap.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
           'If this reached you, basemap-rebuild failure alerts are wired up.')
    Write-Log ("Test alert sent. email={0} push={1} topic={2}" -f `
        $global:MbpsLastAlert.Emailed, $global:MbpsLastAlert.Pushed, $NtfyTopic)
    if ($ok) { exit 0 } else { exit 1 }
}

# ---- Step 0: tooling --------------------------------------------------------
# rclone: from PATH only; its config holds the R2 credentials and lives
# outside this repo on purpose.
if ($Publish -and -not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    Fail 'rclone is not on PATH' 'Publishing needs rclone with the r2 and r2-mb remotes configured (see MAINTENANCE.md 1e).'
}

function Resolve-Pmtiles {
    $cmd = Get-Command pmtiles.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $exe = Join-Path $PmtilesHome 'pmtiles.exe'
    if (Test-Path $exe) { return $exe }

    Write-Log "pmtiles CLI not found -- installing v$PmtilesVersion into $PmtilesHome"
    New-Item -ItemType Directory -Force -Path $PmtilesHome | Out-Null
    $zip = Join-Path $PmtilesHome "go-pmtiles_$PmtilesVersion.zip"
    try {
        Invoke-WebRequest -Uri $PmtilesZipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop
    } catch {
        Fail "could not download the pmtiles CLI" "$PmtilesZipUrl`n$($_.Exception.Message)"
    }
    $have = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
    if ($have -ne $PmtilesZipSha256) {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Fail "pmtiles CLI zip hash mismatch -- refusing to run an unverified binary" `
             "expected $PmtilesZipSha256`ngot      $have`nIf go-pmtiles re-published v$PmtilesVersion, re-derive the pin from a zip you have inspected."
    }
    try {
        Expand-Archive -Path $zip -DestinationPath $PmtilesHome -Force -ErrorAction Stop
    } catch {
        Fail "could not unzip the pmtiles CLI" $_.Exception.Message
    }
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $exe)) { Fail "pmtiles.exe missing after unzip" "looked in $PmtilesHome" }
    return $exe
}

$pm = Resolve-Pmtiles
$ver = Invoke-Native $pm @('version')
if ($ver.Code -ne 0) { Fail "pmtiles version check failed (exit $($ver.Code))" ($ver.Lines -join "`n") }
Write-Log "pmtiles: $pm -- $($ver.Lines[0])"

# ---- Step 1: which daily build? -------------------------------------------
function Test-BuildExists([string]$date) {
    try {
        $r = Invoke-WebRequest -Uri "$BuildBase/$date.pmtiles" -Method Head -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

if ($Build) {
    if ($Build -notmatch '^\d{8}$') { Fail "-Build must be YYYYMMDD" "got '$Build'" }
    if (-not (Test-BuildExists $Build)) { Fail "daily build $Build does not exist" "$BuildBase/$Build.pmtiles answered non-200" }
} else {
    for ($i = 0; $i -le 14; $i++) {
        $cand = (Get-Date).AddDays(-$i).ToString('yyyyMMdd')
        if (Test-BuildExists $cand) { $Build = $cand; break }
    }
    if (-not $Build) { Fail "no Protomaps daily build found in the last 15 days" "$BuildBase/<YYYYMMDD>.pmtiles all non-200 -- has the build channel moved? See https://docs.protomaps.com/basemaps/downloads" }
}
$buildUrl = "$BuildBase/$Build.pmtiles"
Write-Log "Daily build: $buildUrl"

# ---- Step 2: schema gate (remote metadata read, no extract yet) ------------
$md = Invoke-Native $pm @('show', '--metadata', $buildUrl)
if ($md.Code -ne 0) { Fail "could not read the build's metadata (exit $($md.Code))" ($md.Lines -join "`n") }
try { $meta = ($md.Lines -join "`n") | ConvertFrom-Json } catch { Fail "build metadata is not JSON" ($md.Lines -join "`n") }

$tilesetVersion = [string]$meta.version
$tilesetMajor = $null
if ($tilesetVersion -match '^(\d+)\.') { $tilesetMajor = [int]$Matches[1] }
$osmTime = [string]$meta.'planetiler:osm:osmosisreplicationtime'
$layerIds = @()
if ($meta.vector_layers) { $layerIds = @($meta.vector_layers | ForEach-Object { [string]$_.id }) }
$missingLayers = @($RequiredLayers | Where-Object { $layerIds -notcontains $_ })

Write-Log "Tileset version: $tilesetVersion (major $tilesetMajor; app expects $ExpectedTilesetMajor)"
Write-Log "OSM data time  : $osmTime"
Write-Log "Source layers  : $($layerIds -join ', ')"

if ($tilesetMajor -ne $ExpectedTilesetMajor) {
    Fail "REFUSED: build $Build is tileset v$tilesetVersion, the deployed style expects v$ExpectedTilesetMajor.x" `
         ("Uploading it would leave both apps rendering an empty basemap. Upgrade @protomaps/basemaps in both web/ trees " +
          "to a release that targets tileset v$tilesetMajor, redeploy, bump `$ExpectedTilesetMajor here, then re-run. " +
          "Production keeps serving the previous archive meanwhile.")
}
if ($missingLayers.Count -gt 0) {
    Fail "REFUSED: build $Build lacks source layer(s) the style reads: $($missingLayers -join ', ')" `
         "Present: $($layerIds -join ', ')"
}

# ---- Step 3: anything to do? ------------------------------------------------
function Get-PublishedMeta([hashtable]$t) {
    try {
        return Invoke-RestMethod -Uri "$($t.Public)/$MetaName" -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    } catch { return $null }
}
if ($IfStale) {
    $pub = Get-PublishedMeta $Targets[0]
    if ($pub -and ([string]$pub.source_build -eq $Build)) {
        Write-Log "Already current: $($Targets[0].Name) bucket serves build $Build (OSM $($pub.osm_data_time)). Exiting 0."
        exit 0
    }
    if ($pub) { Write-Log "Published: build $($pub.source_build) (OSM $($pub.osm_data_time)) -> rebuilding from $Build" }
    else      { Write-Log "No published sidecar readable at $($Targets[0].Public)/$MetaName -> rebuilding" }
}

# ---- Step 4: extract --------------------------------------------------------
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$archive = Join-Path $WorkDir "basemap-manitoba.$Build.pmtiles"
$metaOut = Join-Path $WorkDir "basemap-manitoba.$Build.meta.json"
if (Test-Path $archive) { Remove-Item $archive -Force }

Write-Log "Extracting bbox $Bbox to z$MaxZoom -> $archive (about 3-4 min)"
$ex = Invoke-Native $pm @('extract', $buildUrl, $archive, "--bbox=$Bbox", "--maxzoom=$MaxZoom", '--download-threads=8')
$ex.Lines | Select-Object -Last 6 | ForEach-Object { Write-Log "  $_" }
if ($ex.Code -ne 0) { Fail "pmtiles extract exited $($ex.Code)" ($ex.Lines | Select-Object -Last 20 | Out-String) }
if (-not (Test-Path $archive)) { Fail "pmtiles extract reported success but wrote nothing" "expected $archive" }

# ---- Step 5: verify ---------------------------------------------------------
$bytes = (Get-Item $archive).Length
$sizeMb = [math]::Round($bytes / 1MB, 1)
Write-Log "Archive: $sizeMb MB"
if ($bytes -lt $MinBytes -or $bytes -gt $MaxBytes) {
    Fail "archive size $sizeMb MB is outside the sanity band ($([int]($MinBytes/1MB))-$([int]($MaxBytes/1MB)) MB)" `
         "A short extract is the usual cause. Nothing was published."
}
$vf = Invoke-Native $pm @('verify', $archive)
if ($vf.Code -ne 0) { Fail "pmtiles verify failed (exit $($vf.Code))" ($vf.Lines -join "`n") }
Write-Log "verify: $($vf.Lines | Select-Object -Last 1)"

$sh = Invoke-Native $pm @('show', $archive)
if ($sh.Code -ne 0) { Fail "pmtiles show failed on the extract (exit $($sh.Code))" ($sh.Lines -join "`n") }
$hdr = $sh.Lines -join "`n"
if ($hdr -notmatch "max zoom:\s*$MaxZoom\b") { Fail "extract header max zoom is not $MaxZoom" $hdr }
if ($hdr -notmatch 'tile type:\s*mvt') { Fail "extract is not an MVT archive" $hdr }
$bb = $Bbox -split ','
if ($hdr -notmatch [regex]::Escape("long: $($bb[0])")) { Fail "extract bounds do not start at bbox west $($bb[0])" $hdr }

$sha256 = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLower()

# ---- Step 6: sidecar --------------------------------------------------------
# What basemap-staleness-check.ps1 and a human reading the bucket need; osm
# data time is the age that matters, not the day this script ran.
$sidecar = [ordered]@{
    object          = $ObjectName
    built           = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    source_build    = $Build
    source_url      = $buildUrl
    osm_data_time   = $osmTime
    tileset_version = $tilesetVersion
    bbox            = $Bbox
    maxzoom         = $MaxZoom
    size_bytes      = $bytes
    sha256          = $sha256
    pmtiles_cli     = $PmtilesVersion
    built_by        = "rebuild-basemap.ps1 on $env:COMPUTERNAME"
}
($sidecar | ConvertTo-Json) | Set-Content -Path $metaOut -Encoding ASCII
Write-Log "Sidecar: $metaOut"

$mins = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
Write-Log "Built and verified in $mins min"

if (-not $Publish) {
    Write-Log ""
    Write-Log "NEXT: re-run with -Publish (or -Build $Build -Publish) to stage + swap it into both buckets."
    Write-Log "DONE"
    exit 0
}

# ---- Step 7: staged publish, both buckets -----------------------------------
function Get-RemoteSize([string]$obj) {
    $j = & rclone lsjson $obj 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }
    try { return ([string]::Join('', $j) | ConvertFrom-Json)[0].Size } catch { return $null }
}

$published = @()
foreach ($t in $Targets) {
    $live    = "$($t.Remote)/$ObjectName"
    $staging = "$($t.Remote)/$ObjectName.staging"
    Write-Log "[$($t.Name)] uploading to $staging ..."
    $up = & rclone copyto $archive $staging --s3-no-check-bucket --s3-chunk-size 64M --s3-upload-concurrency 8 --stats-one-line --stats 60s 2>&1
    $upCode = $LASTEXITCODE
    $up | ForEach-Object { Write-Log "  $_" }
    if ($upCode -ne 0) {
        Fail "[$($t.Name)] rclone upload to staging exited $upCode" `
             ("Production on $($t.Name) is untouched (still serving the previous archive). Already published to: " +
              $(if ($published) { $published -join ', ' } else { 'none' }) + "`n`n$($up | Out-String)")
    }
    $stSize = Get-RemoteSize $staging
    if ($stSize -ne $bytes) {
        Fail "[$($t.Name)] staging object size mismatch" "local $bytes bytes, staging $stSize bytes. Live object untouched."
    }
    Write-Log "[$($t.Name)] staging verified ($stSize bytes); swapping into $live"
    $mv = & rclone moveto $staging $live --s3-no-check-bucket 2>&1
    $mvCode = $LASTEXITCODE
    if ($mvCode -ne 0) {
        Fail "[$($t.Name)] server-side rename staging -> live exited $mvCode" `
             "Staging object may still exist at $staging; live may be old or new -- check with rclone lsjson before re-running.`n$($mv | Out-String)"
    }
    $liveSize = Get-RemoteSize $live
    if ($liveSize -ne $bytes) {
        Fail "[$($t.Name)] live object size does not match the build after swap" "local $bytes bytes, live $liveSize bytes. Re-run -Publish immediately."
    }

    # Public probe: what the browser will do -- a ranged GET on the CDN host.
    # HttpWebRequest.AddRange, not Invoke-WebRequest -Headers: under Windows
    # PowerShell 5.1 'Range' is a restricted header and -Headers throws
    # "must be modified using the appropriate property" (the 2026-09-01
    # second run failed here, after the Manitoba swap had already succeeded).
    $probeUrl = "$($t.Public)/$ObjectName"
    try {
        $req = [System.Net.HttpWebRequest]::Create($probeUrl)
        $req.Method = 'GET'
        $req.AddRange(0, 127)
        $req.Timeout = 60000
        $resp = $req.GetResponse()
        try {
            $status = [int]$resp.StatusCode
            $cr = [string]$resp.Headers['Content-Range']
        } finally { $resp.Close() }
        if ($status -ne 206 -or $cr -notmatch "/$bytes$") {
            Fail "[$($t.Name)] public range probe unexpected" "status $status, Content-Range '$cr' (expected .../$bytes)"
        }
        Write-Log "[$($t.Name)] public probe OK: 206, Content-Range $cr"
    } catch {
        Fail "[$($t.Name)] public range probe failed" "$probeUrl`n$($_.Exception.Message)"
    }

    $mc = & rclone copyto $metaOut "$($t.Remote)/$MetaName" --s3-no-check-bucket 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "[$($t.Name)] sidecar upload failed" ($mc | Out-String) }
    Write-Log "[$($t.Name)] sidecar published: $($t.Public)/$MetaName"
    $published += $t.Name
}

# Keep the sidecar for the record, drop the 1 GB extract.
Remove-Item $archive -Force -ErrorAction SilentlyContinue
$mins = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
Write-Log "Published build $Build (OSM $osmTime, $sizeMb MB) to: $($published -join ', ') in $mins min"
Write-Log "DONE"
exit 0
