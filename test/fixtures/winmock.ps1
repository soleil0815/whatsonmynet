# Pretends to be a Windows server for the Windows host script, so that it can run under PowerShell on Linux:
# functions take precedence over cmdlets of the same name. Then the generated script is called; what it would send
# goes to $env:WOMN_BODY. Used by test/hosts.test.js (skipped where pwsh is missing).
param([string]$Script)
$ErrorActionPreference = 'Stop'
$o = { param($h) [pscustomobject]$h }

function Get-CimInstance {
  param([Parameter(Position = 0)][string]$ClassName, [string]$Filter, [string]$Namespace)
  switch ($ClassName) {
    'Win32_OperatingSystem' { & $o @{ Caption = 'Microsoft Windows Server 2022 Standard'; Version = '10.0.20348'; TotalVisibleMemorySize = 33554432; FreePhysicalMemory = 8388608; LastBootUpTime = (Get-Date).AddDays(-3) } }
    'Win32_Processor' { foreach ($i in 0, 1) { & $o @{ LoadPercentage = 12; Name = 'Intel(R) Xeon(R) Silver 4210R CPU @ 2.40GHz  '; NumberOfCores = 10; NumberOfLogicalProcessors = 20 } } }
    'Win32_LogicalDisk' { & $o @{ DeviceID = 'C:'; VolumeName = 'System'; Size = 255999995904; FreeSpace = 100000000000 } }
    'Win32_Service' { & $o @{ Name = 'Spooler'; DisplayName = 'Druckwarteschlange'; State = 'Running'; ExitCode = 0 } }
    'Win32_Battery' { }
    'Win32_NetworkAdapterConfiguration' { & $o @{ MACAddress = '00:15:5D:01:02:03'; IPAddress = @('10.0.0.21', 'fe80::1') } }
    'Win32_ComputerSystem' { & $o @{ Manufacturer = 'Dell Inc.'; Model = 'PowerEdge R650' } }
    'Win32_BIOS' { & $o @{ SerialNumber = ' 7XK2Q93 '; SMBIOSBIOSVersion = '1.13.2'; ReleaseDate = [datetime]'2024-03-05' } }
    'Win32_PhysicalMemory' { foreach ($s in 'A1', 'B1') { & $o @{ DeviceLocator = $s; Capacity = 17179869184; Speed = 3200; Manufacturer = 'Hynix '; PartNumber = 'HMA82GR7DJR8N-XN    ' } } }
    'AntiVirusProduct' { throw 'Invalid namespace' }
    default { throw "unexpected class $ClassName" }
  }
}
function Get-NetAdapter { param([switch]$Physical)
  & $o @{ Name = 'Ethernet 1'; InterfaceDescription = 'Broadcom NetXtreme Gigabit Ethernet'; MacAddress = '00-15-5D-01-02-03'; Speed = 1000000000; Status = 'Up' }
  & $o @{ Name = 'Ethernet 2'; InterfaceDescription = 'Broadcom NetXtreme Gigabit Ethernet #2'; MacAddress = '00-15-5D-01-02-04'; Speed = 0; Status = 'Disconnected' } }
function Get-PhysicalDisk {
  & $o @{ FriendlyName = 'SAMSUNG MZ7LH480'; SerialNumber = ' S45PNA0M123456 '; MediaType = 'SSD'; BusType = 'SATA'; Size = 480103981056; HealthStatus = 'Healthy' }
  & $o @{ FriendlyName = 'ST4000NM0035'; SerialNumber = 'ZC1ABCDE'; MediaType = 'HDD'; BusType = 'SAS'; Size = 4000787030016; HealthStatus = 'Warning' } }
function Get-StorageReliabilityCounter { param([Parameter(ValueFromPipeline = $true)]$Disk)
  process { if ($Disk.MediaType -eq 'SSD') { & $o @{ Temperature = 34; Wear = 7; PowerOnHours = 21000; ReadErrorsUncorrected = 0; WriteErrorsUncorrected = 0 } } else { throw 'Access denied' } } }
function Get-MpComputerStatus { & $o @{ AntivirusEnabled = $true; RealTimeProtectionEnabled = $true; AntivirusSignatureAge = 1 } }
function Get-NetFirewallProfile { foreach ($p in @(@('Domain', 'True'), @('Private', 'True'), @('Public', 'False'))) { & $o @{ Name = $p[0]; Enabled = $p[1] } } }
function Get-WinEvent { param([hashtable]$FilterHashtable, [int]$MaxEvents)
  & $o @{ Level = 1; TimeCreated = (Get-Date).AddHours(-2); ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 41; Message = "The system has rebooted without cleanly shutting down first.`r`nMore text" }
  & $o @{ Level = 2; TimeCreated = (Get-Date).AddHours(-5); ProviderName = 'disk'; Id = 7; Message = 'The device, \Device\Harddisk1\DR1, has a bad block.' } }
function Get-ChildItem { param([Parameter(Position = 0)][string]$Path)
  if ($Path -like 'Cert:*') {
    & $o @{ Subject = 'CN=rdg.firma.de'; Issuer = "CN=R11, O=Let's Encrypt"; FriendlyName = ''; NotAfter = (Get-Date).AddDays(12); Thumbprint = 'A1B2C3' }
    & $o @{ Subject = 'CN=old'; Issuer = 'CN=old'; FriendlyName = ''; NotAfter = (Get-Date).AddDays(-90); Thumbprint = 'DEAD' }
  } else { Microsoft.PowerShell.Management\Get-ChildItem @PSBoundParameters } }
function Test-Path { param([Parameter(Position = 0)][string]$Path)
  if ($Path -like 'HKLM:*') { return ($Path -like '*RebootRequired') } Microsoft.PowerShell.Management\Test-Path @PSBoundParameters }
function New-Object { param([string]$ComObject, [Parameter(Position = 0)][string]$TypeName)
  if (-not $ComObject) { return Microsoft.PowerShell.Utility\New-Object $TypeName }
  $searcher = [pscustomobject]@{}
  $searcher | Add-Member ScriptMethod Search { param($q) [pscustomobject]@{ Updates = @([pscustomobject]@{ Title = 'KB5048654'; MsrcSeverity = 'Critical' },
    [pscustomobject]@{ Title = 'Defender'; MsrcSeverity = $null }, [pscustomobject]@{ Title = 'KB5049993'; MsrcSeverity = 'Important' }) } }
  $searcher | Add-Member ScriptMethod GetTotalHistoryCount { 3 }
  $searcher | Add-Member ScriptMethod QueryHistory { param($a, $b) , @([pscustomobject]@{ Date = [datetime]'2026-11-01T03:00:00Z' }) }
  $sess = [pscustomobject]@{}
  $sess | Add-Member NoteProperty Searcher $searcher
  $sess | Add-Member ScriptMethod CreateUpdateSearcher { $this.Searcher }
  $sess }
function Invoke-RestMethod { param($Method, $Uri, $Headers, $ContentType, $Body, $TimeoutSec)
  [IO.File]::WriteAllBytes($env:WOMN_BODY, [byte[]]$Body) }

. $Script
