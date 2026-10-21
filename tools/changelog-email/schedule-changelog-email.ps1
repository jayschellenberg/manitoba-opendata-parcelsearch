# schedule-changelog-email.ps1 - register the monthly update-email draft task.
#
#   powershell -ExecutionPolicy Bypass -File schedule-changelog-email.ps1
#
# 1st of every month, 07:00. Interactive logon (runs while Jason is logged in;
# StartWhenAvailable catches up a missed run at next logon). Deliberately NOT
# S4U: gh keeps its GitHub token in Windows Credential Manager, which an S4U
# task cannot read, so the PR fetch would fail on every unattended run.
$ErrorActionPreference = 'Stop'
$TaskName = 'ParcelSearch Monthly Update Email'
$Script   = Join-Path $PSScriptRoot 'build-draft.ps1'

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Script`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Weekly -At 7am -DaysOfWeek Monday   # placeholder, replaced below
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
              -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'Drafts the monthly Parcel Search "what''s new" email and sends the draft to Jason for review. tools\changelog-email in mb-parcelsearch.' -Force | Out-Null

# New-ScheduledTaskTrigger has no monthly option; set a MonthlyTrigger via COM.
$svc = New-Object -ComObject Schedule.Service; $svc.Connect()
$def = $svc.GetFolder('\').GetTask($TaskName).Definition
$def.Triggers.Clear()
$t = $def.Triggers.Create(4)                 # TASK_TRIGGER_MONTHLY
$t.DaysOfMonth   = 1                          # bitmask: day 1
$t.MonthsOfYear  = 0xFFF                      # all 12 months
$t.StartBoundary = (Get-Date -Day 1 -Hour 7 -Minute 0 -Second 0).AddMonths(1).ToString('yyyy-MM-ddTHH:mm:ss')
$svc.GetFolder('\').RegisterTaskDefinition($TaskName, $def, 4, $null, $null, 3) | Out-Null  # 4=update, 3=interactive token

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Registered '$TaskName' - next run $($info.NextRunTime)"
