# changelog-lib.ps1 - shared helpers for build-draft.ps1 and send-draft.ps1.
# Dot-sourced. Reuses alert-lib.ps1 for the SMTP config (alert-email.local.txt),
# so the monthly update rides the same Gmail app password as the alerts.

$ChangelogDir = $PSScriptRoot
$RepoRoot     = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $RepoRoot 'alert-lib.ps1')

$DraftsDir      = Join-Path $ChangelogDir 'drafts'
$StateFile      = Join-Path $ChangelogDir 'state\last-sent.json'
$RecipientsFile = Join-Path $ChangelogDir 'recipients.local.txt'
$Utf8NoBom      = New-Object System.Text.UTF8Encoding $false

function Write-Utf8([string]$path, [string]$text) {
  $dir = Split-Path $path -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  [IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}

function Read-Utf8([string]$path) { [IO.File]::ReadAllText($path, $Utf8NoBom) }

# One address per line; blank lines and # comments ignored.
function Get-Recipients {
  if (-not (Test-Path $RecipientsFile)) { return @() }
  @(Get-Content $RecipientsFile -Encoding UTF8 |
      ForEach-Object { ($_ -replace '#.*$', '').Trim() } |
      Where-Object { $_ -match '^[^@\s]+@[^@\s]+\.[^@\s]+$' })
}

# The window always starts where the last SENT issue ended, so a draft that was
# never sent rolls its PRs into the next month instead of losing them.
function Get-WindowStart {
  if (Test-Path $StateFile) {
    $s = (Read-Utf8 $StateFile) | ConvertFrom-Json
    if ($s.windowEnd) { return [DateTime]::Parse($s.windowEnd).ToUniversalTime() }
  }
  $now = Get-Date
  return (Get-Date -Year $now.Year -Month $now.Month -Day 1 -Hour 0 -Minute 0 -Second 0).AddMonths(-1).ToUniversalTime()
}

function Set-WindowEnd([string]$windowEndIso, [string]$draft) {
  Write-Utf8 $StateFile (@{ windowEnd = $windowEndIso; draft = $draft; sentAt = (Get-Date).ToString('o') } |
    ConvertTo-Json)
}

# HTML mail over the alert-lib SMTP config. $bcc keeps recipients from seeing
# each other's addresses; the visible To is always Jason.
function Send-HtmlMail([hashtable]$cfg, [string]$subject, [string]$html, [string[]]$bcc = @()) {
  if (-not (Test-AlertEmailConfigured $cfg)) { throw 'SMTP not configured in alert-email.local.txt' }
  try { [Net.ServicePointManager]::SecurityProtocol =
          [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
  $from = if ($cfg.from) { $cfg.from } else { $cfg.smtp_user }
  $port = if ($cfg.smtp_port) { [int]$cfg.smtp_port } else { 587 }
  $msg = New-Object System.Net.Mail.MailMessage
  $msg.From = New-Object System.Net.Mail.MailAddress($from, 'Jason Schellenberg')
  $msg.To.Add($cfg.to)
  foreach ($b in $bcc) { if ($b -ne $cfg.to) { $msg.Bcc.Add($b) } }
  $msg.Subject         = $subject
  $msg.SubjectEncoding = [Text.Encoding]::UTF8
  $msg.Body            = $html
  $msg.BodyEncoding    = [Text.Encoding]::UTF8
  $msg.IsBodyHtml      = $true
  $smtp = New-Object System.Net.Mail.SmtpClient($cfg.smtp_host, $port)
  $smtp.EnableSsl   = $true
  $smtp.Timeout     = 30000
  $smtp.Credentials = New-Object System.Net.NetworkCredential($cfg.smtp_user, $cfg.smtp_pass)
  try { $smtp.Send($msg) } finally { $msg.Dispose(); $smtp.Dispose() }
}

function New-EmailHtml([string]$fragment, [string]$banner = '') {
  $bannerHtml = ''
  if ($banner) {
    $bannerHtml = "<div style=`"background:#fff4d6;border:1px solid #e0c060;padding:10px 14px;margin-bottom:18px;font-size:13px`">$banner</div>"
  }
  @"
<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:680px">
$bannerHtml
$fragment
<p style="margin-top:24px">Jason</p>
<p style="font-size:13px;color:#666;border-top:1px solid #ddd;padding-top:10px;margin-top:20px">
<a href="https://manitoba-opendata-parcelsearch.vercel.app">Manitoba Parcel Search</a> &middot;
<a href="https://winnipeg-opendata-parcelsearch.vercel.app">Winnipeg Parcel Search</a><br>
JKS Consulting Inc.</p>
</div>
"@
}
