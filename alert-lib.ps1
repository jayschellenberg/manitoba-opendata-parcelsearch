# alert-lib.ps1 - shared failure-alert helpers (email + ntfy push).
#
# Dot-sourced by the scheduled-task wrappers (monthly-refresh-wrapper.ps1 and
# semiannual-archive-wrapper.ps1) so they share ONE alert path instead of each
# carrying its own copy. Two channels:
#
#   1. EMAIL via SMTP (Send-MailMessage) - the real alert. Needs a one-time app
#      password in alert-email.local.txt (gitignored). See that file's keys in
#      Get-AlertConfig below.
#   2. ntfy.sh push to a per-task topic - anonymous publish is free, no account.
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
#
# 2026-08-12 -- DELIVERY IS NOT THE SAME AS "SOMETHING RETURNED TRUE".
# Send-FailureAlert returns ($emailed -or $pushed), and six callers wrote a
# suppression stamp on that boolean. But Send-AlertPush returns $true on any
# HTTP 200 from ntfy.sh, and an anonymous publish returns 200 for ANY topic
# whether or not a single subscriber exists -- so "pushed" is evidence that
# ntfy accepted the message, never that a human was reached. The failure mode
# that motivated this: the day the Gmail app password is revoked, every alert
# still "succeeds" on push, gets stamped, and is then suppressed for the rest of
# its dedupe period -- the watchdogs go silent exactly when they matter. Real
# evidence it was already live: logs\hpi-alert-stamp.txt holds 24319 written
# 2026-07-25, and no log anywhere in the project has ever contained the string
# 'Alert email sent' or 'Email send failed', i.e. nothing recorded whether the
# email half worked at all.
# So: Send-FailureAlert now also publishes the PER-CHANNEL outcome in
# $global:MbpsLastAlert, callers gate their stamp on Test-AlertDelivered, and
# every send logs one ALERT CHANNELS line so the email outcome is on the record.

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

# Is the EMAIL channel set up at all? Send-AlertEmail and Send-FailureAlert both
# ask THIS one predicate, so "configured" can never come to mean two different
# things in two places -- the stamp rule below turns on the distinction between
# "email is not configured" (push is the best channel available, stamping is
# correct) and "email is configured but failed" (worth retrying tomorrow).
function Test-AlertEmailConfigured([hashtable]$cfg) {
  if (-not $cfg) { return $false }
  if (-not ($cfg.to -and $cfg.smtp_host -and $cfg.smtp_user -and $cfg.smtp_pass)) { return $false }
  if ($cfg.smtp_pass -match '^<.*>$') { return $false }   # placeholder, never a real password
  return $true
}

function Send-AlertEmail([hashtable]$cfg, [string]$title, [string]$body) {
  if (-not (Test-AlertEmailConfigured $cfg)) {
    if ($cfg -and ($cfg.smtp_pass -match '^<.*>$')) {
      Write-Warning 'smtp_pass in alert-email.local.txt is still the placeholder - skipping email.'
    } else {
      Write-Warning 'Email not configured (need to=/smtp_host=/smtp_user=/smtp_pass= in alert-email.local.txt) - skipping email.'
    }
    return $false
  }
  try {
    # Force TLS 1.2 - Windows PowerShell 5.1 (the scheduled-task runtime)
    # defaults to TLS 1.0/1.1, which Gmail / M365 SMTP submission rejects.
    try { [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
    $from = if ($cfg.from) { $cfg.from } else { $cfg.smtp_user }
    $port = if ($cfg.smtp_port) { [int]$cfg.smtp_port } else { 587 }
    # Use System.Net.Mail.SmtpClient directly, not Send-MailMessage: under
    # Windows PowerShell 5.1 the cmdlet hangs on Gmail's STARTTLS, whereas
    # SmtpClient with an explicit timeout sends in ~3s.
    $msg = New-Object System.Net.Mail.MailMessage
    $msg.From = $from
    $msg.To.Add($cfg.to)
    $msg.Subject = $title
    $msg.Body    = $body
    $smtp = New-Object System.Net.Mail.SmtpClient($cfg.smtp_host, $port)
    $smtp.EnableSsl   = $true
    $smtp.Timeout     = 30000   # 30s - fail fast, never hang an unattended job
    $smtp.Credentials = New-Object System.Net.NetworkCredential($cfg.smtp_user, $cfg.smtp_pass)
    try { $smtp.Send($msg) } finally { $msg.Dispose(); $smtp.Dispose() }
    Write-Host "Alert email sent to $($cfg.to) via $($cfg.smtp_host)"
    return $true
  } catch {
    Write-Warning "Email send failed: $($_.Exception.Message)"
    return $false
  }
}

# Returns $true when ntfy.sh ACCEPTED the publish - which is NOT the same as a
# human receiving it. Anonymous publish answers 200 for any topic name, even one
# nobody has ever subscribed to. Treat this as "best effort", never as proof;
# see Test-AlertDelivered below for what the stamp writers are allowed to trust.
function Send-AlertPush([string]$topic, [string]$title, [string]$body) {
  try {
    # NOTE: Title rides in an HTTP header - ASCII only.
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

# Per-channel outcome of the LAST Send-FailureAlert call in this process.
#
# Deliberately a global side-channel instead of a richer return value: about
# twenty call sites do `if (Send-FailureAlert ...)`, and in PowerShell a
# hashtable is unconditionally truthy -- returning one would make every one of
# those sites treat total delivery failure as success, silently. So the return
# type stays [bool] forever and the detail rides here.
#
# Keys: Emailed / Pushed / EmailConfigured / Delivered (bool), Title, Topic,
# To, When. $null until the first Send-FailureAlert call of the process.
$global:MbpsLastAlert = $null

# THE stamp rule. A caller may write its suppression stamp only when delivery is
# actually verifiable:
#   * email succeeded                      -> verified, stamp.
#   * email not configured AND push worked -> push is the best channel this
#     install has; stamp, or an unconfigured user gets nagged every single run.
#   * email configured but FAILED          -> do NOT stamp, whatever push did.
#     That is the revoked-app-password case: leave the stamp alone so the next
#     scheduled run tries again instead of going quiet for a month.
# Reads $global:MbpsLastAlert, so call it immediately after Send-FailureAlert.
function Test-AlertDelivered {
  $s = $global:MbpsLastAlert
  if (-not $s) { return $false }
  if ($s.Emailed) { return $true }
  return ((-not $s.EmailConfigured) -and $s.Pushed)
}

# Fire BOTH channels for one alert. Returns $true if at least one channel
# accepted the message (unchanged contract -- see the note on MbpsLastAlert).
# For "should I suppress the next one?" ask Test-AlertDelivered, not this.
function Send-FailureAlert([string]$root, [string]$topic, [string]$title, [string]$body) {
  $cfg = Get-AlertConfig $root
  $emailConfigured = Test-AlertEmailConfigured $cfg
  $emailed = Send-AlertEmail $cfg $title $body
  $pushed  = Send-AlertPush $topic $title $body

  $global:MbpsLastAlert = @{
    Emailed         = [bool]$emailed
    Pushed          = [bool]$pushed
    EmailConfigured = [bool]$emailConfigured
    Title           = $title
    Topic           = $topic
    To              = $cfg.to
    When            = (Get-Date)
  }
  $global:MbpsLastAlert.Delivered = [bool](Test-AlertDelivered)

  # One line, EVERY send, so the email outcome is on the record in the task log.
  # Before this the email half left no trace either way, which is how a dead
  # SMTP path could sit unnoticed. Assigned to variables first, not inlined:
  # Windows PowerShell 5.1 (the scheduled-task runtime) will not accept an 'if'
  # expression as a command argument.
  $emailWord = if (-not $emailConfigured) { 'not-configured' }
               elseif ($emailed)          { 'SENT' }
               else                       { 'FAILED' }
  $pushWord  = if ($pushed) { 'accepted-by-ntfy' } else { 'FAILED' }
  $verdict   = if ($global:MbpsLastAlert.Delivered) { 'delivery VERIFIED (stamping allowed)' }
               else { 'delivery NOT verified (do not suppress)' }
  Write-Host "ALERT CHANNELS: email=$emailWord push=$pushWord -- $verdict"

  return ($emailed -or $pushed)
}
