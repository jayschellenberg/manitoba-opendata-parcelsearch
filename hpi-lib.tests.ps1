# hpi-lib.tests.ps1 -- contract tests for the CREA MLS HPI page parser.
#
# WHY THIS EXISTS. hpi-lib.ps1 is the single point of failure for the whole HPI
# pipeline, and its failure mode is silence: on 2026-09-04 and again on
# 2026-09-15 a renamed zip made the parser return "nothing on the page" while
# the page held a perfectly good link, and the download simply stopped. Each
# fixture below is a file name CREA has actually served. The suite exists so the
# NEXT rename is a failing test rather than a fortnight of stale dashboards.
#
# Run:  powershell -ExecutionPolicy Bypass -File hpi-lib.tests.ps1
#       (also run by web/test/hpiParsing.test.js as part of `npm test`)
#
# ASCII-only, Windows PowerShell 5.1 clean -- same constraints as the scripts.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'hpi-lib.ps1')

$script:pass = 0
$script:fail = 0
function Test-Case([string]$name, [scriptblock]$body) {
  try { & $body; $script:pass++; Write-Host "  OK   $name" }
  catch { $script:fail++; Write-Host "  FAIL $name"; Write-Host "       $($_.Exception.Message)" }
}
function Assert-Equal($expected, $actual, [string]$what) {
  if ("$expected" -ne "$actual") { throw "$what -- expected '$expected', got '$actual'" }
}
function Assert-True($cond, [string]$what) { if (-not $cond) { throw $what } }

Write-Host 'Get-HpiMonthNumber'

# The 2026-09-15 outage in one line. 'Sept' is not a 3-letter abbreviation and
# not a full month name, so the old lookup table did not hold it at all.
Test-Case "'Sept' resolves to 9 (the 2026-09-15 outage)" {
  Assert-Equal 9 (Get-HpiMonthNumber 'Sept') "Get-HpiMonthNumber 'Sept'"
}

Test-Case 'every 3-letter and full month name resolves, either case' {
  $ci = [System.Globalization.CultureInfo]::InvariantCulture
  for ($m = 1; $m -le 12; $m++) {
    $full = $ci.DateTimeFormat.GetMonthName($m)
    $abbr = $ci.DateTimeFormat.GetAbbreviatedMonthName($m)
    Assert-Equal $m (Get-HpiMonthNumber $full)            "full '$full'"
    Assert-Equal $m (Get-HpiMonthNumber $abbr)            "abbr '$abbr'"
    Assert-Equal $m (Get-HpiMonthNumber $full.ToUpper())  "upper '$full'"
    Assert-Equal $m (Get-HpiMonthNumber $abbr.ToLower())  "lower '$abbr'"
  }
}

# Prefix resolution is what buys us the NEXT spelling for free; these are the
# forms CREA has not used yet but plausibly could.
Test-Case 'unseen prefixes resolve without a code change' {
  Assert-Equal 9  (Get-HpiMonthNumber 'Septem')   "'Septem'"
  Assert-Equal 1  (Get-HpiMonthNumber 'Janu')     "'Janu'"
  Assert-Equal 2  (Get-HpiMonthNumber 'Febr')     "'Febr'"
  Assert-Equal 11 (Get-HpiMonthNumber 'Novem')    "'Novem'"
}

# Refusing to guess matters as much as resolving: a wrong month silently
# installs real data under a folder name that misdates it, and every consumer
# downstream believes the label.
Test-Case 'ambiguous and junk tokens resolve to 0, never a guess' {
  Assert-Equal 0 (Get-HpiMonthNumber 'ma')        "'ma' is March and May"
  Assert-Equal 0 (Get-HpiMonthNumber 'j')         "'j' is four months"
  Assert-Equal 0 (Get-HpiMonthNumber 'ju')        "'ju' is June and July"
  Assert-Equal 0 (Get-HpiMonthNumber 'Smarch')    "not a month"
  Assert-Equal 0 (Get-HpiMonthNumber 'septembre') "longer than the month name"
  Assert-Equal 0 (Get-HpiMonthNumber '')          "empty"
  Assert-Equal 0 (Get-HpiMonthNumber $null)       "null"
}

Write-Host 'Get-HpiZipLinks'

$PageUrl = 'https://www.crea.ca/housing-market-stats/mls-home-price-index/hpi-tool/'

# Every shape CREA has actually served, in one page. The separator drift
# (hyphen vs underscore), the optional _EN, and the month-token drift are all
# independent axes and have all moved at least once.
$fixture = @'
<html><body>
  <a href="https://www.crea.ca/files/mls-hpi-data/MLS_HPI_May_2026.zip">May</a>
  <a href="https://www.crea.ca/files/mls-hpi-data/MLS_HPI-July-2026_EN.zip">July</a>
  <a href="https://www.crea.ca/files/mls-hpi-data/MLS_HPI_Aug_2026.zip">Aug</a>
  <a href="https://www.crea.ca/files/mls-hpi-data/MLS_HPI_Sept_2026.zip">Sept</a>
  <a href="https://www.crea.ca/files/mls-hpi-data/english/Briefing-on-changes.pdf">not a zip</a>
</body></html>
'@

Test-Case 'all four historical name shapes parse, newest wins' {
  $links = @(Get-HpiZipLinks $fixture $PageUrl)
  Assert-Equal 4 $links.Count 'link count'
  Assert-Equal 0 @($links | Where-Object { -not $_.Readable }).Count 'unreadable links'
  $best = Get-HpiNewestReadable $links
  Assert-Equal 'September' $best.Month 'newest month'
  Assert-Equal '2026'      $best.Year  'newest year'
  Assert-Equal 'MLS_HPI_Sept_2026.zip' $best.Name 'newest file name'
}

# The folder name is the contract with the dashboard glob and the watchdog
# regex; normalizing to the FULL month is how MLS_HPI-July-2026_EN went missing
# in the first place, back when the raw name was used.
Test-Case 'month is normalized to the full name whatever the link said' {
  $one = @(Get-HpiZipLinks '<a href="/f/MLS_HPI_Sept_2026.zip">x</a>' $PageUrl)
  Assert-Equal 'September' $one[0].Month 'Sept -> September'
  Assert-Equal 'https://www.crea.ca/f/MLS_HPI_Sept_2026.zip' $one[0].Url 'relative href resolved'
}

# The distinction the whole 2026-09-15 fix rests on: a link we can see but
# cannot date is NOT the same as an empty page, and the watchdog branches on it.
Test-Case 'unreadable link is reported, not dropped' {
  $links = @(Get-HpiZipLinks '<a href="/f/MLS_HPI_Q3_2026.zip">x</a>' $PageUrl)
  Assert-Equal 1 $links.Count 'the link is still returned'
  Assert-Equal $false $links[0].Readable 'flagged unreadable'
  Assert-Equal 0 $links[0].YM 'no month guessed'
  Assert-True ($null -eq (Get-HpiNewestReadable $links)) 'no newest-readable'
}

Test-Case 'a page with no MLS_HPI zip at all returns nothing' {
  $links = @(Get-HpiZipLinks '<a href="/f/something-else.zip">x</a>' $PageUrl)
  Assert-Equal 0 $links.Count 'no links'
}

Test-Case 'single quotes, query strings and duplicates are handled' {
  $html = "<a href='/f/MLS_HPI_Sept_2026.zip?v=2'>a</a><a href=""/f/MLS_HPI_Sept_2026.zip?v=2"">dup</a>"
  $links = @(Get-HpiZipLinks $html $PageUrl)
  Assert-Equal 1 $links.Count 'deduped by URL'
  Assert-Equal 'MLS_HPI_Sept_2026.zip' $links[0].Name 'query string stripped from name'
  Assert-Equal $true $links[0].Readable 'still readable with a query string'
}

Write-Host ''
Write-Host "$script:pass passed, $script:fail failed."
if ($script:fail -gt 0) { exit 1 }
exit 0
