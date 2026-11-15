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
# Network cards, disks, Defender and firewall straight from their WMI classes - not through Get-NetAdapter,
# Get-PhysicalDisk, Get-MpComputerStatus or Get-NetFirewallProfile: those modules are generated anew in every run, and
# PowerShell script block logging writes each of them as a "suspicious" event 4104 (some 70 per run)
$StorageNs = 'root/Microsoft/Windows/Storage'
function Get-Cim([string]$Ns, [string]$Class, [string]$Filter) {
  if ($Filter) { Get-CimInstance -Namespace $Ns -ClassName $Class -Filter $Filter } else { Get-CimInstance -Namespace $Ns -ClassName $Class } }
# The words the Storage module shows for its numbers (what WhatsOnMyNet has always been sent)
$BusNames = @{ 0 = 'Unknown'; 1 = 'SCSI'; 2 = 'ATAPI'; 3 = 'ATA'; 4 = '1394'; 5 = 'SSA'; 6 = 'Fibre Channel'; 7 = 'USB'; 8 = 'RAID'; 9 = 'iSCSI'; 10 = 'SAS'
  11 = 'SATA'; 12 = 'SD'; 13 = 'MMC'; 14 = 'Virtual'; 15 = 'File Backed Virtual'; 16 = 'Storage Spaces'; 17 = 'NVMe'; 18 = 'SCM'; 19 = 'UFS' }
$MediaNames = @{ 0 = 'Unspecified'; 3 = 'HDD'; 4 = 'SSD'; 5 = 'SCM' }
$HealthNames = @{ 0 = 'Healthy'; 1 = 'Warning'; 2 = 'Unhealthy'; 5 = 'Unknown' }
function Get-EnumName($Map, $Value) { if ($null -eq $Value) { return '' }; $n = $Map[[int]$Value]; if ($n) { $n } else { [string]$Value } }
function Format-Mac([string]$Raw) { $h = ($Raw -replace '[^0-9A-Fa-f]', '').ToUpper(); if ($h.Length -ne 12) { return '' }; ($h -split '(..)' | Where-Object { $_ }) -join '-' }

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
    # physical cards (as Get-NetAdapter -Physical: with a connector); the address in use, else the burnt-in one
    nics = @(Try-Get { Get-Cim 'root/StandardCimv2' 'MSFT_NetAdapter' 'ConnectorPresent=TRUE' | ForEach-Object {
      $mac = Format-Mac ([string](@($_.NetworkAddresses) | Where-Object { $_ } | Select-Object -First 1)); if (-not $mac) { $mac = Format-Mac ([string]$_.PermanentAddress) }
      @{ name = [string]$_.Name; desc = [string]$_.InterfaceDescription; mac = $mac; speed = [int64]$_.Speed; up = ([int]$_.InterfaceOperationalStatus -eq 1) } } }) }
}

# Physical disks with health and - where the disk tells - temperature, wear, hours and uncorrected errors
$pdisks = @(Try-Get { Get-Cim $StorageNs 'MSFT_PhysicalDisk' | ForEach-Object {
  $r = $null; try { $r = @(Get-CimAssociatedInstance -InputObject $_ -ResultClassName 'MSFT_StorageReliabilityCounter')[0] } catch { $r = $null }
  @{ name = [string]$_.FriendlyName; serial = ([string]$_.SerialNumber).Trim(); media = (Get-EnumName $MediaNames $_.MediaType); bus = (Get-EnumName $BusNames $_.BusType)
    size = [int64]$_.Size; health = (Get-EnumName $HealthNames $_.HealthStatus)
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
  $m = Try-Get { Get-Cim 'root/Microsoft/Windows/Defender' 'MSFT_MpComputerStatus' | Select-Object -First 1 }
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
  # Enabled: 1 = on, 0 = off, 2 = not configured (counts as off, as before)
  $p = @(Get-Cim 'root/StandardCimv2' 'MSFT_NetFirewallProfile')
  $on = { param($n) [int](@($p | Where-Object { $_.Name -eq $n })[0].Enabled) -eq 1 }
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

# Own checks: every .ps1, .cmd or .bat in the checks folder prints lines in the Checkmk "local check" format
#   <0|1|2|3> <name> <value or -> <text>      (0 OK, 1 WARN, 2 CRIT, 3 UNKNOWN; value e.g. "count=12" or "-")
# They run as SYSTEM - so only from the folder of this script (rights only for SYSTEM and administrators, set by the
# setup), never a link, only files owned by SYSTEM, administrators or TrustedInstaller that nobody else may change;
# at most 50, each at most 30 seconds.
$checks = @()
$ChkDir = Join-Path $Dir 'checks'
function Test-Safe([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
  $acl = Get-Acl -LiteralPath $Path
  $trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return $false }
  foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($r.AccessControlType -ne 'Allow' -or $trusted -contains $r.IdentityReference.Value) { continue }
    # write, append, attributes, delete, change rights, take ownership
    if (([int]$r.FileSystemRights -band 0xD0116) -ne 0) { return $false }
  }
  return $true
}
function Check-Entry($Name, $Text, $File) { @{ name = $Name; status = 3; text = $Text; value = $null; file = $File } }
if (Test-Path -LiteralPath $ChkDir) {
  if (-not (Test-Safe $ChkDir)) { $checks = @(Check-Entry '_checks' "folder $ChkDir may be changed by others - checks not run" '') }
  else {
    foreach ($f in @(Get-ChildItem -LiteralPath $ChkDir -File | Where-Object { @('.ps1', '.cmd', '.bat') -contains $_.Extension.ToLower() } | Sort-Object Name | Select-Object -First 50)) {
      if (-not (Test-Safe $f.FullName)) { $checks += Check-Entry $f.Name 'owner or rights not safe - not run (owner must be Administrators)' $f.Name; continue }
      $p = New-Object System.Diagnostics.Process
      if ($f.Extension -ieq '.ps1') { $p.StartInfo.FileName = 'powershell.exe'; $p.StartInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$($f.FullName)`"" }
      else { $p.StartInfo.FileName = 'cmd.exe'; $p.StartInfo.Arguments = "/c `"`"$($f.FullName)`"`"" }
      $p.StartInfo.UseShellExecute = $false; $p.StartInfo.RedirectStandardOutput = $true; $p.StartInfo.RedirectStandardInput = $true; $p.StartInfo.CreateNoWindow = $true
      try { [void]$p.Start(); $p.StandardInput.Close(); $read = $p.StandardOutput.ReadToEndAsync() } catch { $checks += Check-Entry $f.Name "could not start: $($_.Exception.Message)" $f.Name; continue }
      if (-not $p.WaitForExit(30000)) { try { $p.Kill() } catch { $null = $_ }; $checks += Check-Entry $f.Name 'timeout (30 s)' $f.Name; continue }
      $out = [string]$read.Result; if ($out.Length -gt 20000) { $out = $out.Substring(0, 20000) }
      $found = 0
      foreach ($line in ($out -split "`r?`n")) {
        if ($line -notmatch '^([0-3])\s+(\S+)\s+(\S+)\s*(.*)$') { continue }
        $st = [int]$Matches[1]; $nm = $Matches[2]; $perf = $Matches[3]; $txt = $Matches[4]; $val = $null
        if ($perf -ne '-' -and $perf -match '^[^=|]+=(-?\d+(?:\.\d+)?)') { $val = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture) }
        $checks += @{ name = $nm; status = $st; text = $txt; value = $val; file = $f.Name }; $found++
      }
      if (-not $found) { $checks += Check-Entry $f.Name "no line in the check format (exit code $($p.ExitCode))" $f.Name }
    }
  }
}

$net = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE')
$body = @{
  hostname = $env:COMPUTERNAME; os = "$($os.Caption) $($os.Version)".Trim(); cpu = [int]$cpu
  memTotal = [int64]$os.TotalVisibleMemorySize * 1024; memUsed = ([int64]$os.TotalVisibleMemorySize - [int64]$os.FreePhysicalMemory) * 1024
  uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds; disks = $disks; services = $services
  macs = @($net | ForEach-Object { $_.MACAddress } | Where-Object { $_ }); ips = @($net | ForEach-Object { $_.IPAddress } | Where-Object { $_ -match '^\d+\.' }); ups = $ups
  hw = $hw; pdisks = $pdisks; updates = $updates; av = $av; firewall = $fw; events = $events; certs = $certs; checks = $checks
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
