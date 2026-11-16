# Windows check (CI): the Windows script on a real Windows, the way it runs at a customer - once by hand as an
# administrator (it sets itself up), then twice by its scheduled task as SYSTEM - with script block logging on, as a
# group policy would switch it on. Kept plain on purpose (no CIM modules, no cmdlet that may fail): what lands in the
# PowerShell logs between start.txt and end.txt must come from the script under test.
param([Parameter(Mandatory)][string]$Work)
$ErrorActionPreference = 'Stop'
$key = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell\ScriptBlockLogging'
if (-not (Test-Path $key)) { [void](New-Item -Path $key -Force) }
Set-ItemProperty -Path $key -Name EnableScriptBlockLogging -Value 1 -Type DWord
& wevtutil.exe cl 'Microsoft-Windows-PowerShell/Operational'
& wevtutil.exe cl 'Windows PowerShell'
Start-Sleep -Seconds 2
(Get-Date).ToUniversalTime().ToString('o') | Set-Content -Path (Join-Path $Work 'start.txt')

# 1. by hand, as an administrator (software distribution does the same)
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Work 'womn-host.ps1')
"first run: exit code $LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { exit 1 }

# 2. the scheduled task, twice (the first of these also looks for Windows updates)
$task = 'WhatsOnMyNet-Host'
function Get-TaskRow { @(& schtasks.exe /Query /TN $task /FO CSV /V | ConvertFrom-Csv)[0] }
foreach ($i in 1, 2) {
  $before = (Get-TaskRow).'Last Run Time'
  & schtasks.exe /Run /TN $task | Out-Null
  $until = (Get-Date).AddMinutes(10)
  do { Start-Sleep -Seconds 5; $row = Get-TaskRow } while (($row.Status -eq 'Running' -or $row.'Last Run Time' -eq $before) -and (Get-Date) -lt $until)
  "task run ${i}: status $($row.Status), last result $($row.'Last Result')"
  if ($row.'Last Result' -ne '0') { exit 1 }
}
Start-Sleep -Seconds 3
(Get-Date).ToUniversalTime().ToString('o') | Set-Content -Path (Join-Path $Work 'end.txt')
