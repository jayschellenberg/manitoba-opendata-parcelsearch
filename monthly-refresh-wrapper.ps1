# monthly-refresh-wrapper.ps1 — run monthly-refresh.bat and ALERT on failure.
#
# Why a wrapper: the .bat logs to logs\monthly-*.log and exits, but a
# 04:00 scheduled run that dies has nobody watching. On any nonzero
# exit this wrapper sends the last 40 log lines through two channels:
#
#   1. EMAIL via SMTP (Send-MailMessage) — the real alert. Needs a
#      one-time app password; see the config block below.
#   2. ntfy.sh push to topic mbps-monthly-refresh-jks — anonymous
#      publish is free, no account. Works even before SMTP is
#      configured, but only reaches you if you subscribe to the topic
#      in the ntfy app. (ntfy.sh's hosted EMAIL relay now requires a
#      paid account — "anonymous email sending is not allowed" — which
#      is why SMTP is the email path here.)
#
# Configuration — alert-email.local.txt (gitignored, key=value lines):
#   to=you@example.com
#   smtp_host=smtp.office365.com      # or smtp.gmail.com
#   smtp_port=587
#   smtp_user=you@example.com
#   smtp_pass=<app password>          # M365: Security info → App passwords
#                                     # Gmail: myaccount.google.com/apppasswords
#   from=you@example.com              # optional; defaults to smtp_user
# A legacy single-line file holding just the address still works (email
# is then skipped until SMTP keys are added; push still fires).
#
# Test the alert path without running the refresh:
#   powershell -ExecutionPolicy Bypass -File monthly-refresh-wrapper.ps1 -TestAlert
#
# Scheduled via schedule_monthly.ps1, which points the Task Scheduler
# entry here instead of at the .bat directly. Exit code passes through
# so Task Scheduler still records the underlying failure.

param([switch]$TestAlert)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NtfyTopic = 'mbps-monthly-refresh-jks'   # public namespace; carries no secrets

function Get-AlertConfig {
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

function Send-AlertPush([string]$title, [string]$body) {
  try {
    # NOTE: Title rides in an HTTP header — ASCII only.
    Invoke-RestMethod -Uri "https://ntfy.sh/$NtfyTopic" -Method Post `
      -Headers @{ Title = $title; Priority = 'high'; Tags = 'rotating_light' } `
      -Body $body -ContentType 'text/plain' -TimeoutSec 30 | Out-Null
    Write-Host "Alert pushed to ntfy.sh/$NtfyTopic (subscribe in the ntfy app to receive these)"
    return $true
  } catch {
    Write-Warning "ntfy push failed: $($_.Exception.Message)"
    return $false
  }
}

function Send-FailureAlert([string]$title, [string]$body) {
  $cfg = Get-AlertConfig
  $emailed = Send-AlertEmail $cfg $title $body
  $pushed  = Send-AlertPush $title $body
  return ($emailed -or $pushed)
}

if ($TestAlert) {
  $ok = Send-FailureAlert 'TEST - MB parcel monthly refresh alerts' `
    ("Test alert from monthly-refresh-wrapper.ps1 on $env:COMPUTERNAME at $(Get-Date -Format s).`n" +
     'If this reached you, refresh-failure alerts are wired up.')
  if ($ok) { exit 0 } else { exit 1 }
}

Write-Host 'Running monthly-refresh.bat ...'
& cmd.exe /c (Join-Path $root 'monthly-refresh.bat')
$code = $LASTEXITCODE

if ($code -eq 0) {
  Write-Host 'monthly-refresh.bat completed OK.'
  exit 0
}

# Failure — grab the tail of the newest log for the alert body.
$log = Get-ChildItem (Join-Path $root 'logs\monthly-*.log') -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$tail = if ($log) { (Get-Content $log.FullName -Tail 40) -join "`n" } else { '(no log file found)' }
$logName = if ($log) { $log.Name } else { 'n/a' }
$body = "monthly-refresh.bat exited with code $code on $env:COMPUTERNAME at $(Get-Date -Format s).`n`n" +
        "Last 40 lines of ${logName}:`n$tail"
Send-FailureAlert "FAILED - MB parcel monthly refresh (exit $code)" $body | Out-Null
exit $code
