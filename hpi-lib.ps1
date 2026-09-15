# hpi-lib.ps1 -- shared parsing for CREA's MLS HPI download page.
#
# Dot-sourced by hpi-download.ps1 (the daily downloader) and
# hpi-staleness-check.ps1 (the backstop watchdog) so there is ONE definition of
# "what is an MLS HPI zip link" and "what month is that token", instead of the
# two hand-copied regexes and two hand-built month tables they carried until
# 2026-09-15.
#
# WHY THIS FILE EXISTS -- the 2026-09-15 outage.
# CREA renames this zip constantly. Seen so far: MLS_HPI_May_2026.zip,
# MLS_HPI-July-2026_EN.zip, MLS_HPI_Aug_2026.zip, MLS_HPI_Sept_2026.zip. The
# 2026-09-04 fix loosened the SEPARATORS (hyphen or underscore, optional _EN)
# but left the month vocabulary as InvariantCulture's full and THREE-LETTER
# names -- 'september' and 'sep', never 'sept'. So on 2026-09-15 the one link on
# the page matched the regex, failed the month lookup, was skipped, and the
# downloader hard-failed with "no link found" while staring straight at one.
#
# Two things follow, and this file is where both live:
#
#   1. MONTH TOKENS ARE RESOLVED BY PREFIX, not by a fixed list of spellings.
#      Any token of 3+ characters that is the start of exactly one month name
#      resolves to that month, so 'Sep', 'Sept' and 'September' are all 9 and
#      the next spelling CREA invents ('Septem') needs no hotfix. Ambiguity is
#      rejected rather than guessed: 'ma' matches March and May, so it is 0.
#
#   2. LINK DISCOVERY IS SEPARATE FROM MONTH PARSING. Get-HpiZipLinks finds
#      EVERY MLS_HPI*.zip href on the page and reports each one's Readable flag.
#      A link it can see but cannot date is a first-class, reportable result --
#      not silence. That distinction is the whole point: it is what lets the
#      watchdog say "CREA published something and our parser cannot read it"
#      without needing to know anything about months, which is precisely the
#      alarm that could not be raised while both scripts shared one regex and
#      agreed, wrongly, that the page was empty.
#
# ASCII-only and Windows PowerShell 5.1 clean on purpose: the scheduled tasks
# run powershell.exe, not pwsh.
#
# Tests: hpi-lib.tests.ps1 (run it directly, or via web/test/hpiParsing.test.js).

# Month name -> 1..12 by unambiguous prefix; 0 when unknown or ambiguous.
#
# Deliberately NOT a lookup table. A table can only hold the spellings someone
# thought of, and the spelling nobody thought of ('Sept') is the one that took
# the pipeline down. Requiring 3+ characters is what makes every real month
# abbreviation unambiguous: 'jan'...'dec' each start exactly one month name,
# while the only genuinely ambiguous prefix in the calendar -- 'ma' for March
# and May -- is too short to be accepted at all.
function Get-HpiMonthNumber([string]$token) {
  if ([string]::IsNullOrWhiteSpace($token)) { return 0 }
  $t = $token.Trim().ToLower()
  if ($t.Length -lt 3) { return 0 }
  $ci  = [System.Globalization.CultureInfo]::InvariantCulture
  $hit = 0
  for ($m = 1; $m -le 12; $m++) {
    if ($ci.DateTimeFormat.GetMonthName($m).ToLower().StartsWith($t)) {
      if ($hit -ne 0) { return 0 }   # ambiguous -- refuse to guess
      $hit = $m
    }
  }
  return $hit
}

# Full invariant month name for 1..12 ('' when out of range). The local folder
# name is ALWAYS built from this, so MLS_HPI_September_2026 is the folder
# whether the link said Sep, Sept or September -- the form both the dashboard
# glob (MLS_HPI_*) and the watchdog regex (^MLS_HPI_<Month>_<Year>$) expect.
function Get-HpiMonthName([int]$n) {
  if ($n -lt 1 -or $n -gt 12) { return '' }
  return [System.Globalization.CultureInfo]::InvariantCulture.DateTimeFormat.GetMonthName($n)
}

# Every MLS_HPI*.zip link on the page, newest-readable first is NOT assumed --
# callers rank them. Each entry:
#
#   Url       absolute URL
#   Name      file name only (query string and fragment stripped)
#   Readable  $true when both month and year parsed
#   YM        year*12+month, or 0 when not readable
#   Month     full invariant month name, or '' when not readable
#   Year      4-digit year string, or '' when not readable
#
# The href pattern is deliberately broad -- any href containing MLS_HPI and
# ending .zip, either quote style. Narrowing it to the expected NAME shape is
# what made an unreadable link indistinguishable from no link at all.
function Get-HpiZipLinks([string]$html, [string]$pageUrl) {
  $out  = @()
  $seen = @{}
  # ...\.zip may be followed by a query string or fragment: CDN cache-busting
  # (?v=2) is ordinary and must not make a link invisible.
  $rx   = [regex]'href\s*=\s*["'']([^"'']*MLS_HPI[^"'']*\.zip(?:[?#][^"'']*)?)["'']'
  foreach ($m in $rx.Matches($html)) {
    $url = $m.Groups[1].Value
    if ($url -notmatch '^https?://') {
      try { $url = (New-Object System.Uri((New-Object System.Uri($pageUrl)), $url)).AbsoluteUri }
      catch { continue }
    }
    if ($seen.ContainsKey($url)) { continue }
    $seen[$url] = $true

    $name = ($url -split '[?#]')[0]
    $name = $name.Substring($name.LastIndexOf('/') + 1)

    $ym = 0; $mon = ''; $yr = ''
    if ($name -match '^MLS_HPI[-_]([A-Za-z]+)[-_](\d{4})(?:_EN)?\.zip$') {
      $n = Get-HpiMonthNumber $Matches[1]
      if ($n -gt 0) {
        $yr  = $Matches[2]
        $ym  = [int]$yr * 12 + $n
        $mon = Get-HpiMonthName $n
      }
    }
    $out += @{ Url = $url; Name = $name; Readable = ($ym -gt 0); YM = $ym; Month = $mon; Year = $yr }
  }
  return $out
}

# The newest link whose month+year parsed, or $null when none did. $null with a
# non-empty link list is the parser-broken signal both callers act on.
function Get-HpiNewestReadable($links) {
  $best = $null
  foreach ($l in @($links)) {
    if (-not $l.Readable) { continue }
    if (-not $best -or $l.YM -gt $best.YM) { $best = $l }
  }
  return $best
}
