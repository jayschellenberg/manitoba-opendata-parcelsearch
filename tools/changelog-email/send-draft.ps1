# send-draft.ps1 - send a reviewed monthly update draft to recipients.local.txt.
#
#   powershell -ExecutionPolicy Bypass -File send-draft.ps1                # newest unsent draft
#   powershell -ExecutionPolicy Bypass -File send-draft.ps1 -Draft drafts\2026-11-01.html
#   ... -WhatIf                                                            # show, don't send
#
# Sends exactly the HTML file on disk (edit it first if needed), To: Jason,
# BCC: everyone in recipients.local.txt. Then records the draft's window end so
# next month's draft starts where this one stopped.
param([string]$Draft, [switch]$WhatIf)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'changelog-lib.ps1')

if (-not $Draft) {
  $Draft = Get-ChildItem $DraftsDir -Filter '*.html' -ErrorAction SilentlyContinue |
    Where-Object { -not (Test-Path ($_.FullName -replace '\.html$', '.sent')) } |
    Sort-Object Name | Select-Object -Last 1 -ExpandProperty FullName
  if (-not $Draft) { throw "No unsent draft in $DraftsDir" }
}
$Draft = (Resolve-Path $Draft).Path
$meta  = (Read-Utf8 ($Draft -replace '\.html$', '.json')) | ConvertFrom-Json
$recips = Get-Recipients
if (-not $recips.Count) { throw "recipients.local.txt has no addresses" }

Write-Host "Draft:      $Draft"
Write-Host "Subject:    $($meta.subject)"
Write-Host "Period:     $($meta.period)"
Write-Host "Recipients: $($recips.Count) (BCC) - $($recips -join ', ')"
if ($WhatIf) { Write-Host 'WhatIf: not sent.'; return }

$cfg = Get-AlertConfig $RepoRoot
Send-HtmlMail $cfg $meta.subject (Read-Utf8 $Draft) $recips
Write-Utf8 ($Draft -replace '\.html$', '.sent') ("sent {0:o} to {1}" -f (Get-Date), ($recips -join ', '))
Set-WindowEnd $meta.windowEnd (Split-Path $Draft -Leaf)
Write-Host "Sent. Next draft will start from $($meta.windowEnd)."
