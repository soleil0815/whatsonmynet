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

# an own check, as administrators put them into the checks folder
$chk = Join-Path $env:ProgramData 'WhatsOnMyNet\checks'
[void](New-Item -ItemType Directory -Force -Path $chk)
Set-Content -Path (Join-Path $chk 'ci-check.ps1') -Value "Write-Output '0 CI_Check count=1 all fine'" -Encoding ASCII
Set-Content -Path (Join-Path $chk 'ci-check.cmd') -Value '@echo 1 CI_Cmd - only a warning' -Encoding ASCII

# 2. the scheduled task, twice (the first of these also looks for Windows updates; before the second the system log
#    is emptied - a machine without errors in the last 24 hours)
$task = 'WhatsOnMyNet-Host'
function Get-TaskRow { @(& schtasks.exe /Query /TN $task /FO CSV /V | ConvertFrom-Csv)[0] }
foreach ($i in 1, 2) {
  if ($i -eq 2) { & wevtutil.exe cl System }
  $before = (Get-TaskRow).'Last Run Time'
  & schtasks.exe /Run /TN $task | Out-Null
  $until = (Get-Date).AddMinutes(10)
  do { Start-Sleep -Seconds 5; $row = Get-TaskRow } while (($row.Status -eq 'Running' -or $row.'Last Run Time' -eq $before) -and (Get-Date) -lt $until)
  "task run ${i}: status $($row.Status), last result $($row.'Last Result')"
  if ($row.'Last Result' -ne '0') { exit 1 }
}
# the version of the script for software distribution, in the registry
$reg = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\WhatsOnMyNet').HostScript
"registry: HostScript $reg"
if (-not $reg) { 'no version in the registry'; exit 1 }

# 3. WhatsOnMyNet refuses the report (key no longer valid), then cannot be reached at all: no error in the PowerShell
#    log - result 2 of the task and the answer in the status file next to the script
$sendFile = Join-Path $env:ProgramData 'WhatsOnMyNet\womn-host-send.json'
foreach ($case in 'reject', 'down') {
  Set-Content -Path (Join-Path $Work $case) -Value '1'
  $before = (Get-TaskRow).'Last Run Time'
  & schtasks.exe /Run /TN $task | Out-Null
  $until = (Get-Date).AddMinutes(10)
  do { Start-Sleep -Seconds 5; $row = Get-TaskRow } while (($row.Status -eq 'Running' -or $row.'Last Run Time' -eq $before) -and (Get-Date) -lt $until)
  Remove-Item -Path (Join-Path $Work $case)
  $st = Get-Content -Raw -Path $sendFile | ConvertFrom-Json
  "task run ${case}: last result $($row.'Last Result'), status file: ok $($st.ok), status $($st.status), $($st.message)"
  if ($row.'Last Result' -ne '2' -or $st.ok) { 'expected result 2 and the failure in the status file'; exit 1 }
  if ($case -eq 'reject' -and ($st.status -ne 401 -or $st.message -ne 'Bitte melde dich an.')) { 'expected 401 and the message of WhatsOnMyNet'; exit 1 }
}

# 4. what other Windows have not: a namespace or class missing (Windows Server has no Security Center, another virus
#    protection leaves no Defender namespace) - the helpers of the script, as installed, on their own
$installed = Get-Content -Raw -Path (Join-Path $env:ProgramData 'WhatsOnMyNet\womn-host.ps1')
$from = $installed.IndexOf('$CimSeen = @{}'); $to = $installed.IndexOf('# The words the Storage module')
if ($from -lt 0 -or $to -lt $from) { 'helpers not found in the script'; exit 1 }
$probe = Join-Path $Work 'probe.ps1'
Set-Content -Path $probe -Encoding UTF8 -Value ("`$ErrorActionPreference = 'Stop'`r`n" + $installed.Substring($from, $to - $from) + @'
$r = @(
  (Test-Cim 'root/NotThere' 'X'),
  (Test-Cim 'root/Microsoft/Windows/NotThere' 'X'),
  (Test-Cim 'root/cimv2' 'Not_A_Class'),
  (Test-Cim 'root/cimv2' 'Win32_OperatingSystem'),
  (@(Get-Cim 'root/NotThere' 'X').Count),
  (@(Get-Cim 'root/cimv2' 'Win32_OperatingSystem').Count)
)
$r -join ' '
'@)
$res = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $probe
"helpers: $res"
if ([string]$res -ne 'False False False True 0 1') { 'expected: False False False True 0 1'; exit 1 }
Start-Sleep -Seconds 3
(Get-Date).ToUniversalTime().ToString('o') | Set-Content -Path (Join-Path $Work 'end.txt')
