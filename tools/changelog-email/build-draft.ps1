# build-draft.ps1 - monthly "What's new in Parcel Search" draft.
#
# Collects every PR merged into the Manitoba and Winnipeg Parcel Search repos
# since the last SENT issue, has Claude (claude -p, no tools) turn the PR
# descriptions into an appraiser-facing summary per prompt.md, saves it under
# drafts\, and emails Jason the draft with a banner saying who it would go to.
# Nothing reaches anyone else until Jason runs send-draft.ps1.
#
#   powershell -ExecutionPolicy Bypass -File build-draft.ps1            # normal run
#   powershell -ExecutionPolicy Bypass -File build-draft.ps1 -NoEmail   # draft file only
#   ... -ClaudeOutput <file>   # skip claude -p, use a saved SUBJECT:+HTML output
#
# Run by the scheduled task "ParcelSearch Monthly Update Email" (1st, 07:00).
# Needs claude-token.local.txt (gitignored) holding a `claude setup-token` token.
param([switch]$NoEmail, [string]$ClaudeOutput)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'changelog-lib.ps1')

$logDir = Join-Path $ChangelogDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
Start-Transcript -Path (Join-Path $logDir ("build-{0:yyyy-MM-dd_HHmm}.log" -f (Get-Date))) | Out-Null

# PR bodies are written for the developer: half of each is verification, test
# and implementation notes no appraiser sees. Keep the user-facing sections and
# cap the rest - 7 weeks of untrimmed bodies (241 PRs, 430 KB) overflowed the
# model's context ("Prompt is too long").
function Compress-PrBody([string]$body, [int]$cap = 2500) {
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false; $fence = $false
  foreach ($line in ($body -split "`r?`n")) {
    if ($line -match '^\s*(```|~~~)') { $fence = -not $fence; continue }
    if ($fence) { continue }
    if ($line -match '^#{1,6}\s') {
      $skip = $line -match '^#{1,6}\s*(Verif|Test|How\b|Implementation|Technical|Files|Notes? for|Screenshots?|Checklist|Review|Gap|Known|Follow|Out of scope|Deploy|CI\b)'
      if ($skip) { continue }
    }
    if ($skip -or $line -match '^\s*(!\[|<img|<!--|\|)') { continue }   # images, comments, tables
    $out.Add($line)
  }
  $t = (($out -join "`n") -replace '(\n\s*){3,}', "`n`n").Trim()
  if ($t.Length -gt $cap) { $t = $t.Substring(0, $cap) + ' [...]' }
  return $t
}

$cfg = Get-AlertConfig $RepoRoot
try {
  $windowStart = Get-WindowStart
  $windowEnd   = (Get-Date).ToUniversalTime()
  $periodLabel = '{0:MMMM d} to {1:MMMM d, yyyy}' -f $windowStart.ToLocalTime(), $windowEnd.ToLocalTime()
  Write-Host "Window: $($windowStart.ToString('o')) .. $($windowEnd.ToString('o'))  ($periodLabel)"

  $repos = @(
    @{ name = 'Manitoba Parcel Search'; slug = 'jayschellenberg/manitoba-opendata-parcelsearch' },
    @{ name = 'Winnipeg Parcel Search'; slug = 'jayschellenberg/winnipeg-opendata-parcelsearch' }
  )

  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine((Read-Utf8 (Join-Path $ChangelogDir 'prompt.md')))
  [void]$sb.AppendLine("Period: $periodLabel`n")
  $total = 0
  foreach ($r in $repos) {
    $r.prs = @()
    # gh's search is date-granular; filter to the exact timestamp below.
    $since = $windowStart.ToString('yyyy-MM-dd')
    $json = & gh pr list -R $r.slug --state merged --search "merged:>=$since" --limit 300 `
              --json number,title,body,mergedAt 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh pr list failed for $($r.slug): $json" }
    # gh writes UTF-8; PS 5.1 decoded it with the console code page, so re-decode.
    $text = [Text.Encoding]::UTF8.GetString([Console]::OutputEncoding.GetBytes(($json -join "`n")))
    # Assign first: PS 5.1 ConvertFrom-Json emits a JSON array as ONE object.
    $all = $text | ConvertFrom-Json
    $prs = @($all | Where-Object {
      $m = [DateTime]::Parse($_.mergedAt).ToUniversalTime()
      $m -gt $windowStart -and $m -le $windowEnd
    } | Sort-Object mergedAt)
    Write-Host "$($r.name): $($prs.Count) merged PRs"
    $total += $prs.Count
    $r.prs = $prs
  }

  # Split a fixed budget (~75k tokens) across the PRs: the full 2,500 chars each
  # in a typical month, less in a busy stretch, never under 600.
  $cap = [Math]::Max(600, [Math]::Min(2500, [int](280000 / [Math]::Max(1, $total))))
  Write-Host "Per-PR body cap: $cap chars"
  foreach ($r in $repos) {
    $prs = $r.prs
    [void]$sb.AppendLine("# $($r.name) - $($prs.Count) merged pull requests`n")
    foreach ($p in $prs) {
      $body = Compress-PrBody ([string]$p.body) $cap
      [void]$sb.AppendLine("## $($p.title)  (merged $(([DateTime]::Parse($p.mergedAt)).ToLocalTime().ToString('yyyy-MM-dd')))")
      [void]$sb.AppendLine($body)
      [void]$sb.AppendLine()
    }
  }

  $stamp = '{0:yyyy-MM-dd}' -f (Get-Date)
  $work  = Join-Path $DraftsDir "$stamp.work"
  New-Item -ItemType Directory -Force $work | Out-Null
  $inFile = Join-Path $work 'input.md'; $outFile = Join-Path $work 'claude-out.txt'; $errFile = Join-Path $work 'claude-err.txt'
  Write-Utf8 $inFile $sb.ToString()

  # Unattended runs need a long-lived token: the CLI's normal login expires and
  # a scheduled task cannot re-authenticate. `claude setup-token` makes one.
  $tokenFile = Join-Path $ChangelogDir 'claude-token.local.txt'
  if (Test-Path $tokenFile) { $env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content $tokenFile -TotalCount 1).Trim() }

  if ($ClaudeOutput) {
    $result = (Read-Utf8 $ClaudeOutput).Trim()   # testing: reuse a saved summary
  } elseif ($total -eq 0) {
    $result = 'NOTHING_TO_REPORT'
  } else {
    # cmd.exe redirection keeps the bytes UTF-8 end to end (PS 5.1 pipes would
    # re-encode through the console code page). --tools "" = text in, text out.
    # Isolate it from this PC's Claude setup: the MCP servers' tool lists alone
    # overflow the context, so even a two-word prompt fails "Prompt is too long"
    # without --strict-mcp-config / --setting-sources "" (measured 2026-10-21).
    $cmdline = "claude -p --model opus --tools `"`" --strict-mcp-config --setting-sources `"`" " +
               "--disable-slash-commands --system-prompt `"You write clear, plain-English emails.`" " +
               "--no-session-persistence " +
               "`"Write the email exactly as the instructions at the top of the input say.`" " +
               "< `"$inFile`" > `"$outFile`" 2> `"$errFile`""
    $p = Start-Process cmd.exe -ArgumentList "/d /s /c `"$cmdline`"" -Wait -NoNewWindow -PassThru
    $result = if (Test-Path $outFile) { (Read-Utf8 $outFile).Trim() } else { '' }
    if ($p.ExitCode -ne 0 -or -not $result) {
      $err = if (Test-Path $errFile) { Read-Utf8 $errFile } else { '' }
      throw "claude -p failed (exit $($p.ExitCode)): $err $result"
    }
  }

  if ($result -eq 'NOTHING_TO_REPORT') {
    Write-Host "Nothing user-visible in $periodLabel; advancing the window."
    Set-WindowEnd $windowEnd.ToString('o') ''
    if (-not $NoEmail) {
      Send-HtmlMail $cfg "[Parcel Search update] nothing to send for $periodLabel" (New-EmailHtml (
        "<p>$total pull requests merged in $periodLabel, none of them user-visible, so no update email this month. The next one will start from today.</p>"))
    }
    return
  }

  if ($result -notmatch '^SUBJECT:\s*(.+?)\r?\n') { throw "Claude output has no SUBJECT line:`n$result" }
  $subject  = $Matches[1].Trim()
  $fragment = $result.Substring($Matches[0].Length).Trim() -replace '^```(html)?\s*', '' -replace '\s*```$', ''

  $htmlFile = Join-Path $DraftsDir "$stamp.html"
  Write-Utf8 $htmlFile (New-EmailHtml $fragment)
  Write-Utf8 (Join-Path $DraftsDir "$stamp.json") (@{
    subject = $subject; windowStart = $windowStart.ToString('o'); windowEnd = $windowEnd.ToString('o')
    period = $periodLabel; prCount = $total; created = (Get-Date).ToString('o')
  } | ConvertTo-Json)
  Write-Host "Draft: $htmlFile"
  Write-Host "Subject: $subject"

  if (-not $NoEmail) {
    $recips = Get-Recipients
    $who = if ($recips.Count) { ($recips -join ', ') } else { '<b>nobody yet</b> - add addresses to recipients.local.txt' }
    $sendCmd = "powershell -ExecutionPolicy Bypass -File `"$ChangelogDir\send-draft.ps1`""
    $banner = "<b>DRAFT - not sent to anyone else yet.</b> Covers $periodLabel ($total PRs).<br>" +
              "Would go to ($($recips.Count)): $who<br>" +
              "To edit: <code>$htmlFile</code><br>To send: <code>$sendCmd</code>"
    Send-HtmlMail $cfg "[DRAFT] $subject" (New-EmailHtml $fragment $banner)
    Write-Host "Draft emailed to $($cfg.to)"
  }
} catch {
  $msg = $_.Exception.Message
  Write-Warning "Build failed: $msg"
  if (-not $NoEmail) { [void](Send-AlertEmail $cfg 'Parcel Search monthly update email FAILED' "build-draft.ps1 failed:`n`n$msg`n`nLog: $logDir") }
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
