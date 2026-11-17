# Pretends to be a Windows server for the Windows host script, so that it can run under PowerShell on Linux:
# functions take precedence over cmdlets of the same name. Then the generated script is called; what it would send
# goes to $env:WOMN_BODY. Used by test/hosts.test.js (skipped where pwsh is missing).
param([string]$Script)
$ErrorActionPreference = 'Stop'
$o = { param($h) [pscustomobject]$h }

# The namespaces and classes of this (server) Windows: no Security Center. Asking for anything else throws, as WMI does
# ("Invalid namespace" / "Invalid class") - and Windows would log it as event 4100, so the script must look first.
$CimNs = @('root', 'root/cimv2', 'root/StandardCimv2', 'root/Microsoft', 'root/Microsoft/Windows', 'root/Microsoft/Windows/Storage', 'root/Microsoft/Windows/Defender')
$CimClasses = @('MSFT_NetAdapter', 'MSFT_NetFirewallProfile', 'MSFT_PhysicalDisk', 'MSFT_MpComputerStatus')
function Get-CimInstance {
  param([Parameter(Position = 0)][string]$ClassName, [string]$Filter, [string]$Namespace, [string]$Query)
  if ($Namespace -and $CimNs -notcontains $Namespace) { throw "Invalid namespace $Namespace" }
  if ($ClassName -eq '__NAMESPACE') {
    $n = if ($Filter -match "^Name='(.+)'$") { $Matches[1] } else { throw "filter $Filter" }
    if ($CimNs -contains "$Namespace/$n") { & $o @{ Name = $n } }
    return
  }
  if ($Query) {
    if ($Query -notmatch "^SELECT \* FROM meta_class WHERE __CLASS = '(.+)'$") { throw "query $Query" }
    if ($CimClasses -contains $Matches[1] -or $Matches[1] -like 'Win32_*') { & $o @{ CimClassName = $Matches[1] } }
    return
  }
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
    # what the WMI classes answer: numbers where the modules show words
    'MSFT_NetAdapter' { if ($Filter -ne 'ConnectorPresent=TRUE') { throw "filter $Filter" }
      & $o @{ Name = 'Ethernet 1'; InterfaceDescription = 'Broadcom NetXtreme Gigabit Ethernet'; NetworkAddresses = @('00155D010203'); PermanentAddress = '00155D010203'; Speed = 1000000000; InterfaceOperationalStatus = 1 }
      & $o @{ Name = 'Ethernet 2'; InterfaceDescription = 'Broadcom NetXtreme Gigabit Ethernet #2'; NetworkAddresses = $null; PermanentAddress = '00155D010204'; Speed = 0; InterfaceOperationalStatus = 2 } }
    'MSFT_PhysicalDisk' { if ($Namespace -ne 'root/Microsoft/Windows/Storage') { throw 'namespace' }
      & $o @{ FriendlyName = 'SAMSUNG MZ7LH480'; SerialNumber = ' S45PNA0M123456 '; MediaType = [uint16]4; BusType = [uint16]11; Size = [uint64]480103981056; HealthStatus = [uint16]0 }
      & $o @{ FriendlyName = 'ST4000NM0035'; SerialNumber = 'ZC1ABCDE'; MediaType = [uint16]3; BusType = [uint16]10; Size = [uint64]4000787030016; HealthStatus = [uint16]1 } }
    'MSFT_MpComputerStatus' { & $o @{ AntivirusEnabled = $true; RealTimeProtectionEnabled = $true; AntivirusSignatureAge = 1 } }
    'MSFT_NetFirewallProfile' { foreach ($p in @(@('Domain', 1), @('Private', 1), @('Public', 0))) { & $o @{ Name = $p[0]; Enabled = [uint16]$p[1] } } }
    default { throw "unexpected class $ClassName" }
  }
}
function Get-CimAssociatedInstance { param($InputObject, [string]$ResultClassName)
  if ($ResultClassName -ne 'MSFT_StorageReliabilityCounter') { throw "unexpected $ResultClassName" }
  if ([int]$InputObject.MediaType -eq 4) { & $o @{ Temperature = 34; Wear = 7; PowerOnHours = 21000; ReadErrorsUncorrected = 0; WriteErrorsUncorrected = 0 } } else { throw 'Access denied' } }
# The modules must not be used any more (each run would leave ~70 "suspicious" events 4104)
foreach ($n in 'Get-NetAdapter', 'Get-PhysicalDisk', 'Get-StorageReliabilityCounter', 'Get-MpComputerStatus', 'Get-NetFirewallProfile') {
  Set-Item -Path "function:global:$n" -Value ([scriptblock]::Create("throw 'module cmdlet $n used'")) }
function Get-WinEvent { param([hashtable]$FilterHashtable, [int]$MaxEvents)
  & $o @{ Level = 1; TimeCreated = (Get-Date).AddHours(-2); ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 41; Message = "The system has rebooted without cleanly shutting down first.`r`nMore text" }
  & $o @{ Level = 2; TimeCreated = (Get-Date).AddHours(-5); ProviderName = 'disk'; Id = 7; Message = 'The device, \Device\Harddisk1\DR1, has a bad block.' } }
function Get-ChildItem { param([Parameter(Position = 0)][string]$Path, [string]$LiteralPath, [switch]$Force, [switch]$File)
  if ($Path -like 'Cert:*') {
    & $o @{ Subject = 'CN=rdg.firma.de'; Issuer = "CN=R11, O=Let's Encrypt"; FriendlyName = ''; NotAfter = (Get-Date).AddDays(12); Thumbprint = 'A1B2C3' }
    & $o @{ Subject = 'CN=old'; Issuer = 'CN=old'; FriendlyName = ''; NotAfter = (Get-Date).AddDays(-90); Thumbprint = 'DEAD' }
  } else { Microsoft.PowerShell.Management\Get-ChildItem @PSBoundParameters } }
function Test-Path { param([Parameter(Position = 0)][string]$Path, [string]$LiteralPath)
  if ($LiteralPath) { return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath }
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
# The setup calls icacls and schtasks: noted in $env:WOMN_CALLS (when set), nothing changed
function Note-Call([string]$Line) { if ($env:WOMN_CALLS) { Add-Content -LiteralPath $env:WOMN_CALLS -Value $Line }; $global:LASTEXITCODE = 0 }
# Rights of the folder as the setup finds them: SYSTEM, Administrators and one account given access by hand
function Get-Acl { param([string]$LiteralPath)
  $acl = [pscustomobject]@{}
  $acl | Add-Member ScriptMethod GetAccessRules { param($a, $b, $c)
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-21-1000-2000-3000-1104') { [pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $sid } } } }
  $acl }
function icacls.exe { Note-Call ('icacls ' + ($args -join ' ')) }
function schtasks.exe { Note-Call ('schtasks ' + ($args -join ' ')) }
# The report goes to $env:WOMN_BODY instead of the network: an alias wins over the function the script defines
function Save-Report([string]$Json) { [IO.File]::WriteAllBytes($env:WOMN_BODY, [Text.Encoding]::UTF8.GetBytes($Json)) }
Set-Alias -Name Send-Report -Value Save-Report
# The registry (version for software distribution): noted like the other calls
function Set-ItemProperty { param([string]$LiteralPath, [string]$Name, $Value) Note-Call "reg $LiteralPath $Name $Value" }

. $Script

# The certificate check the script set (pinning of a self-signed certificate of WhatsOnMyNet): asked with the
# certificates in $env:WOMN_CERTS (paths separated by ;), the answers go to $env:WOMN_PINRESULT
if ($env:WOMN_CERTS) {
  $cb = [Net.ServicePointManager]::ServerCertificateValidationCallback
  $out = foreach ($p in $env:WOMN_CERTS.Split(';')) {
    $c = [Security.Cryptography.X509Certificates.X509Certificate2]::new($p)
    if ($cb) { [string]$cb.Invoke($null, $c, $null, [Net.Security.SslPolicyErrors]::RemoteCertificateChainErrors) } else { 'none' }
  }
  Set-Content -LiteralPath $env:WOMN_PINRESULT -Value ($out -join ',')
}
