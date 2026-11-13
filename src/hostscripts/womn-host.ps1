# WhatsOnMyNet - Windows report (read only). Sends CPU, RAM, drives, uptime and the state of the automatic services
# every 5 minutes to WhatsOnMyNet - plus hardware (model, serial number, BIOS, CPU, memory modules, network cards),
# physical disks with their health, pending Windows updates and restart, virus protection and firewall, critical
# events of the last 24 hours and certificates of the machine. No agent, no open port, nothing installed: run it once as administrator (or via
# software distribution / GPO) - it sets itself up as scheduled task under SYSTEM. Removing: womn-host-uninstall.ps1.
# Talks only to the address below; loads nothing from anywhere.
$ErrorActionPreference = 'Stop'
$Url = @URL@
$Token = @TOKEN@
$Thumb = @THUMB@
$KeyPin = @KEYPIN@
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($Thumb -or $KeyPin) {
  # Self-signed certificate of WhatsOnMyNet: trust exactly its key (it stays the same when the certificate is renewed),
  # or this one certificate
  Add-Type -TypeDefinition @"
using System; using System.Net; using System.Net.Security; using System.Security.Cryptography; using System.Security.Cryptography.X509Certificates;
public static class WomnPin { static string Thumb; static string Key;
  static bool Check(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) {
    if (c == null) return false;
    if (Thumb.Length > 0 && c.GetCertHashString() == Thumb) return true;
    using (SHA256 h = SHA256.Create()) { return Key.Length > 0 && BitConverter.ToString(h.ComputeHash(c.GetPublicKey())).Replace("-", "") == Key; } }
  public static void Enable(string t, string k) { Thumb = t; Key = k; ServicePointManager.ServerCertificateValidationCallback = Check; } }
"@
  [WomnPin]::Enable($Thumb.Replace(':', '').ToUpper(), $KeyPin.ToUpper())
}
@SETUP@
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.Size -gt 0 } | ForEach-Object {
  @{ name = $_.DeviceID; label = [string]$_.VolumeName; used = [int64]($_.Size - $_.FreeSpace); total = [int64]$_.Size } })
# Automatic services: state and exit code (a service that stopped with an error code counts as failed; trigger-start
# services that stopped normally do not)
$services = @(Get-CimInstance Win32_Service -Filter "StartMode='Auto'" | ForEach-Object {
  $st = if ($_.State -eq 'Running') { 'running' } else { 'stopped' }
  @{ name = $_.Name; display = $_.DisplayName; state = $st; failed = ($st -ne 'running' -and $_.ExitCode -ne 0) } })
# UPS on USB: Windows sees it like a battery (BatteryStatus 1 = discharging, 4/5 = low/critical)
$ups = $null
try {
  $bat = @(Get-CimInstance Win32_Battery) | Select-Object -First 1
  if ($bat) {
    $rt = [int64]$bat.EstimatedRunTime
    $ups = @{ status = $(if (@(1, 4, 5) -contains [int]$bat.BatteryStatus) { 'OB' } else { 'OL' }) + $(if (@(4, 5) -contains [int]$bat.BatteryStatus) { ' LB' } else { '' })
      charge = $bat.EstimatedChargeRemaining; runtime = $(if ($rt -gt 0 -and $rt -lt 71582788) { $rt * 60 } else { $null }); model = [string]$bat.Name; kind = 'battery' }
  }
} catch { $ups = $null }
# Every part on its own: what this Windows cannot tell (older version, role missing) is simply left out
function Try-Get([scriptblock]$Block) { try { & $Block } catch { $null } }

# Hardware: model, serial number, BIOS, processors, memory modules, network cards
$hw = Try-Get {
  $cs = Get-CimInstance Win32_ComputerSystem
  $bios = Get-CimInstance Win32_BIOS
  $procs = @(Get-CimInstance Win32_Processor)
  @{ vendor = [string]$cs.Manufacturer; model = [string]$cs.Model; serial = ([string]$bios.SerialNumber).Trim()
    bios = [string]$bios.SMBIOSBIOSVersion; biosDate = $(if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { '' })
    cpu = ([string]$procs[0].Name).Trim(); sockets = $procs.Count
    cores = [int](($procs | Measure-Object -Property NumberOfCores -Sum).Sum); threads = [int](($procs | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
    virtual = [bool]($cs.Model -match 'Virtual|VMware|KVM|QEMU|HVM|Xen|VirtualBox' -or $cs.Manufacturer -match 'QEMU|Xen|innotek|Parallels')
    ram = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { @{ slot = [string]$_.DeviceLocator; size = [int64]$_.Capacity; speed = [int]$_.Speed
      vendor = ([string]$_.Manufacturer).Trim(); part = ([string]$_.PartNumber).Trim() } })
    nics = @(Try-Get { Get-NetAdapter -Physical | ForEach-Object { @{ name = [string]$_.Name; desc = [string]$_.InterfaceDescription
      mac = [string]$_.MacAddress; speed = [int64]$_.Speed; up = ($_.Status -eq 'Up') } } }) }
}

# Physical disks with health and - where the disk tells - temperature, wear, hours and uncorrected errors
$pdisks = @(Try-Get { Get-PhysicalDisk | ForEach-Object {
  $r = $null; try { $r = $_ | Get-StorageReliabilityCounter } catch { $r = $null }
  @{ name = [string]$_.FriendlyName; serial = ([string]$_.SerialNumber).Trim(); media = [string]$_.MediaType; bus = [string]$_.BusType
    size = [int64]$_.Size; health = [string]$_.HealthStatus
    temp = $(if ($r) { $r.Temperature }); wear = $(if ($r) { $r.Wear }); hours = $(if ($r) { $r.PowerOnHours })
    readErrors = $(if ($r) { $r.ReadErrorsUncorrected }); writeErrors = $(if ($r) { $r.WriteErrorsUncorrected }) } } })

# Windows updates: the search takes a while, so it runs after the report at most every 6 hours; the report sends
# the last result. A pending restart is read every time (registry, quick).
$UpdFile = Join-Path $Dir 'womn-updates.json'
$upd = Try-Get { Get-Content -Raw -Path $UpdFile | ConvertFrom-Json }
$reboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or
  (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
$updates = @{ pending = $(if ($upd) { $upd.pending }); security = $(if ($upd) { $upd.security }); checkedAt = $(if ($upd) { $upd.checkedAt })
  lastInstalled = $(if ($upd) { $upd.lastInstalled }); reboot = [bool]$reboot }

# Virus protection: Defender, on client Windows also another product registered in the Security Center
$av = Try-Get {
  $m = Try-Get { Get-MpComputerStatus }
  $sc = @(Try-Get { Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct })
  $other = $sc | Where-Object { $_.displayName -notmatch 'Defender' -and ([int]$_.productState -band 0x1000) } | Select-Object -First 1
  if ($m -and $m.AntivirusEnabled -and $m.RealTimeProtectionEnabled) {
    @{ name = 'Microsoft Defender'; enabled = $true; realtime = $true; upToDate = ([int]$m.AntivirusSignatureAge -le 3); sigAge = [int]$m.AntivirusSignatureAge }
  } elseif ($other) {
    @{ name = [string]$other.displayName; enabled = $true; realtime = $true; upToDate = (([int]$other.productState -band 0x10) -eq 0); sigAge = $null }
  } elseif ($m) {
    @{ name = 'Microsoft Defender'; enabled = [bool]$m.AntivirusEnabled; realtime = [bool]$m.RealTimeProtectionEnabled; upToDate = ([int]$m.AntivirusSignatureAge -le 3); sigAge = [int]$m.AntivirusSignatureAge }
  } elseif ($sc.Count) {
    @{ name = [string]$sc[0].displayName; enabled = $false; realtime = $false; upToDate = (([int]$sc[0].productState -band 0x10) -eq 0); sigAge = $null }
  }
}
$fw = Try-Get {
  $p = @(Get-NetFirewallProfile)
  $on = { param($n) "$(($p | Where-Object { $_.Name -eq $n }).Enabled)" -eq 'True' }
  @{ domain = (& $on 'Domain'); private = (& $on 'Private'); public = (& $on 'Public') }
}

# Critical events and errors of the system log in the last 24 hours (the newest 10 with text)
$events = Try-Get {
  $all = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2; StartTime = (Get-Date).AddHours(-24) } -MaxEvents 300 -ErrorAction SilentlyContinue)
  @{ hours = 24; critical = @($all | Where-Object { $_.Level -eq 1 }).Count; errors = @($all | Where-Object { $_.Level -eq 2 }).Count
    items = @($all | Select-Object -First 10 | ForEach-Object { @{ at = $_.TimeCreated.ToUniversalTime().ToString('o'); level = $(if ($_.Level -eq 1) { 'critical' } else { 'error' })
      source = [string]$_.ProviderName; id = [int]$_.Id; message = ([string]$_.Message -split "`n")[0].Trim() } }) }
}

# Certificates of the machine (store "My"): IIS, RDP gateway, Exchange … - the expired ones only for 30 days
$certs = @(Try-Get { Get-ChildItem -Path Cert:\LocalMachine\My | Where-Object { $_.NotAfter -gt (Get-Date).AddDays(-30) } | Select-Object -First 50 | ForEach-Object {
  @{ subject = [string]$_.Subject; issuer = [string]$_.Issuer; name = [string]$_.FriendlyName; notAfter = $_.NotAfter.ToUniversalTime().ToString('o'); thumb = [string]$_.Thumbprint } } })

$net = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE')
$body = @{
  hostname = $env:COMPUTERNAME; os = "$($os.Caption) $($os.Version)".Trim(); cpu = [int]$cpu
  memTotal = [int64]$os.TotalVisibleMemorySize * 1024; memUsed = ([int64]$os.TotalVisibleMemorySize - [int64]$os.FreePhysicalMemory) * 1024
  uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds; disks = $disks; services = $services
  macs = @($net | ForEach-Object { $_.MACAddress } | Where-Object { $_ }); ips = @($net | ForEach-Object { $_.IPAddress } | Where-Object { $_ -match '^\d+\.' }); ups = $ups
  hw = $hw; pdisks = $pdisks; updates = $updates; av = $av; firewall = $fw; events = $events; certs = $certs
} | ConvertTo-Json -Depth 6 -Compress
Invoke-RestMethod -Method Post -Uri $Url -Headers @{ Authorization = "Bearer $Token"; 'X-WOMN-Request' = '1' } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 | Out-Null

# After the report: look for Windows updates again when the last search is older than 6 hours (not on the first
# call - the setup should be quick). Only searches, never installs.
$age = Try-Get { if ($upd.checkedAt) { ((Get-Date) - [datetime]::Parse($upd.checkedAt)).TotalHours } }
if (-not $Setup -and ($null -eq $upd -or $null -eq $age -or $age -ge 6)) {
  $found = Try-Get {
    $sess = New-Object -ComObject Microsoft.Update.Session
    $searcher = $sess.CreateUpdateSearcher()
    $res = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
    $list = @($res.Updates | ForEach-Object { $_ })
    $last = Try-Get { $n = $searcher.GetTotalHistoryCount(); if ($n -gt 0) { @($searcher.QueryHistory(0, 1))[0].Date.ToUniversalTime().ToString('o') } }
    @{ pending = $list.Count; security = @($list | Where-Object { $_.MsrcSeverity -in @('Critical', 'Important') }).Count
      checkedAt = (Get-Date).ToUniversalTime().ToString('o'); lastInstalled = $last }
  }
  if ($found) { $found | ConvertTo-Json -Compress | Set-Content -Path $UpdFile -Encoding UTF8 }
}
