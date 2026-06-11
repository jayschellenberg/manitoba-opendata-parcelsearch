# alert-lib.ps1 — shared failure-alert helpers (email + ntfy push).
#
# Dot-sourced by the scheduled-task wrappers (monthly-refresh-wrapper.ps1 and
# semiannual-archive-wrapper.ps1) so they share ONE alert path instead of each
# carrying its own copy. Two channels:
#
#   1. EMAIL via SMTP (Send-MailMessage) — the real alert. Needs a one-time app
#      password in alert-email.local.txt (gitignored). See that file's keys in
#      Get-AlertConfig below.
#   2. ntfy.sh push to a per-task topic — anonymous publish is free, no account.
#      Works even before SMTP is configured, but only reaches you if you
#      subscribe to the topic in the ntfy app.
#
# alert-email.local.txt (gitignored, key=value lines):
#   to=you@example.com
#   smtp_host=smtp.office365.com      # or smtp.gmail.com
#   smtp_port=587
#   smtp_user=you@example.com
#   smtp_pass=<app password>          # M365: Security info -> App passwords
#                                     # Gmail: myaccount.google.com/apppasswords
#   from=you@example.com              # optional; defaults to smtp_user
# A legacy single-line file holding just the address still works (email is then
# skipped until SMTP keys are added; push still fires).

function Get-AlertConfig([string]$root) {
  $cfg = @{}
  $f = Join-Path $root 'alert-email.local.txt'
  if (Test-Path $f) {
    foreach ($line in Get-Content $f) {
      $t = $line.Trim()
      if (-not $t -or $t.StartsWith('#')) { continue }
      if ($t -match '^([a-z_]+)\s*=\s*(.+)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
      elseif ($t -match '@' -and -not $cfg.to) { $cfg.to = $t }  # legacy single-line form
    }
  }
  if (-not $cfg.to -and $env:MBPS_ALERT_EMAIL) { $cfg.to = $env:MBPS_ALERT_EMAIL.Trim() }
  return $cfg
}

function Send-AlertEmail([hashtable]$cfg, [string]$title, [string]$body) {
  if (-not ($cfg.to -and $cfg.smtp_host -and $cfg.smtp_user -and $cfg.smtp_pass)) {
    Write-Warning 'Email not configured (need to=/smtp_host=/smtp_user=/smtp_pass= in alert-email.local.txt) — skipping email.'
    return $false
  }
  if ($cfg.smtp_pass -match '^<.*>$') {
    Write-Warning 'smtp_pass in alert-email.local.txt is still the placeholder — skipping email.'
    return $false
  }
  try {
    $sec  = ConvertTo-SecureString $cfg.smtp_pass -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential($cfg.smtp_user, $sec)
    $from = if ($cfg.from) { $cfg.from } else { $cfg.smtp_user }
    $port = if ($cfg.smtp_port) { [int]$cfg.smtp_port } else { 587 }
    # Send-MailMessage is marked obsolete upstream but remains the only
    # dependency-free SMTP client in the box; fine for a local alert.
    Send-MailMessage -To $cfg.to -From $from -Subject $title -Body $body `
      -SmtpServer $cfg.smtp_host -Port $port -UseSsl -Credential $cred `
      -WarningAction SilentlyContinue -ErrorAction Stop
    Write-Host "Alert email sent to $($cfg.to) via $($cfg.smtp_host)"
    return $true
  } catch {
    Write-Warning "Email send failed: $($_.Exception.Message)"
    return $false
  }
}

function Send-AlertPush([string]$topic, [string]$title, [string]$body) {
  try {
    # NOTE: Title rides in an HTTP header — ASCII only.
    Invoke-RestMethod -Uri "https://ntfy.sh/$topic" -Method Post `
      -Headers @{ Title = $title; Priority = 'high'; Tags = 'rotating_light' } `
      -Body $body -ContentType 'text/plain' -TimeoutSec 30 | Out-Null
    Write-Host "Alert pushed to ntfy.sh/$topic (subscribe in the ntfy app to receive these)"
    return $true
  } catch {
    Write-Warning "ntfy push failed: $($_.Exception.Message)"
    return $false
  }
}

# Fire BOTH channels for one alert. Returns $true if at least one reached out.
function Send-FailureAlert([string]$root, [string]$topic, [string]$title, [string]$body) {
  $cfg = Get-AlertConfig $root
  $emailed = Send-AlertEmail $cfg $title $body
  $pushed  = Send-AlertPush $topic $title $body
  return ($emailed -or $pushed)
}
