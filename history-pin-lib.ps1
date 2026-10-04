# history-pin-lib.ps1 -- read / rewrite the app's mb-parcel-history pin in
# web/src/arcgis.js. Dot-source it; shared by semiannual-publish-wrapper.ps1,
# history-staleness-check.ps1 and publish-history-changes.ps1.
#
# Why one place: the pin's FORM changed when shards moved off jsDelivr
# (2026-08-17) from `mb-parcel-history@<sha>` to
# `/gh-data/mb-parcel-history/<sha>`, and the two scripts that each carried
# their own regex silently stopped matching -- the semiannual re-pin logged
# "app pin already at ..." and never re-pinned, and the staleness check could
# not read the pin at all. Both separators are accepted here so either form works.

$script:HistoryPinPattern = 'mb-parcel-history([@/])([0-9a-f]{40})'

# The pinned SHA, or $null when no pin is found.
function Get-HistoryPin([string]$ArcgisJs) {
    if (-not (Test-Path $ArcgisJs)) { return $null }
    $m = [regex]::Match((Get-Content -Raw $ArcgisJs), $script:HistoryPinPattern)
    if ($m.Success) { return $m.Groups[2].Value }
    return $null
}

# Rewrite every pin to $Sha, keeping each one's separator. Returns $true when
# the file changed. Throws when the file holds no pin at all: a silent no-op is
# exactly the failure this helper exists to prevent.
function Set-HistoryPin([string]$ArcgisJs, [string]$Sha) {
    $content = Get-Content -Raw $ArcgisJs
    if (-not [regex]::IsMatch($content, $script:HistoryPinPattern)) {
        throw "no mb-parcel-history pin found in $ArcgisJs -- has its form changed again?"
    }
    $new = [regex]::Replace($content, $script:HistoryPinPattern, { param($m) "mb-parcel-history$($m.Groups[1].Value)$Sha" })
    if ($new -eq $content) { return $false }
    # BOM-less UTF-8: Set-Content -Encoding UTF8 adds a BOM under Windows
    # PowerShell 5.1, which would corrupt the JS file's first bytes.
    [System.IO.File]::WriteAllText($ArcgisJs, $new, (New-Object System.Text.UTF8Encoding($false)))
    return $true
}
