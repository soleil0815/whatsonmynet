# WhatsOnMyNet @VERSIONTEXT@ - Windows report (read only). Sends CPU, RAM, drives, uptime and the state of the automatic services
# every 5 minutes to WhatsOnMyNet - plus hardware (model, serial number, BIOS, CPU, memory modules, network cards),
# physical disks with their health, pending Windows updates and restart, virus protection and firewall, critical
# events of the last 24 hours and certificates of the machine. No agent, no open port, nothing installed: run it once as administrator (or via
# software distribution / GPO) - it sets itself up as scheduled task under SYSTEM. Removing: womn-host-uninstall.ps1.
# Talks only to the address below; loads nothing from anywhere - except, when WhatsOnMyNet offers it, a newer version of
# this script from that same address (checked by its fingerprint, see "Self-update" at the end).
# The version of this script (also in the registry: HKLM\SOFTWARE\WhatsOnMyNet)
$ScriptVersion = @VERSION@
$ErrorActionPreference = 'Stop'
# No progress bar: under the scheduled task there is no console window to draw it in - Windows PowerShell then
# logs "System error" (event 4100) on every run, and web requests are faster without it
$ProgressPreference = 'SilentlyContinue'
$Url = @URL@
$Token = @TOKEN@
@PINCHECK@
@SETUP@
@SEND@
# The fingerprint of a file by certutil (on every Windows): the .NET hash classes are words PowerShell logs as
# "suspicious" (event 4104 on every run) - for plugins and the self-update
function Get-Sha256([string]$Path) {
  foreach ($l in @(& certutil.exe -hashfile $Path SHA256)) { $x = ([string]$l -replace '\s', '').ToLower(); if ($x -match '^[0-9a-f]{64}$') { return $x } }
  return ''
}
# A copy that updated itself writes its version for software distribution and inventory tools on its next run
if (-not $Setup) {
  try {
    $RegKey = 'HKLM:\SOFTWARE\WhatsOnMyNet'
    if ((Test-Path -LiteralPath $RegKey) -and [string](Get-ItemProperty -LiteralPath $RegKey -Name @REGNAME@ -ErrorAction SilentlyContinue).@REGNAME@ -ne $ScriptVersion) {
      Set-ItemProperty -LiteralPath $RegKey -Name @REGNAME@ -Value $ScriptVersion
    }
  } catch { $null = $_ }
}
$UpdState = Join-Path $Dir 'womn-host-update.json'
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
  $bat = @(Get-CimInstance Win32_Battery)[0]
  if ($bat) {
    $rt = [int64]$bat.EstimatedRunTime
    $ups = @{ status = $(if (@(1, 4, 5) -contains [int]$bat.BatteryStatus) { 'OB' } else { 'OL' }) + $(if (@(4, 5) -contains [int]$bat.BatteryStatus) { ' LB' } else { '' })
      charge = $bat.EstimatedChargeRemaining; runtime = $(if ($rt -gt 0 -and $rt -lt 71582788) { $rt * 60 } else { $null }); model = [string]$bat.Name; kind = 'battery' }
  }
} catch { $ups = $null }
# Every part on its own: what this Windows cannot tell (older version, role missing) is simply left out
function Try-Get([scriptblock]$Block) { try { & $Block } catch { $null } }
# The first entries are taken by index, never with Select-Object -First: it stops the command before it with an
# exception that Windows PowerShell logs as "System error" (event 4100, warning) - several times per run
# Network cards, disks, Defender and firewall straight from their WMI classes - not through Get-NetAdapter,
# Get-PhysicalDisk, Get-MpComputerStatus or Get-NetFirewallProfile: those modules are generated anew in every run, and
# PowerShell script block logging writes each of them as a "suspicious" event 4104 (some 70 per run)
$StorageNs = 'root/Microsoft/Windows/Storage'
# Only what this Windows has: asking for a namespace or class that is not there is a cmdlet error, and Windows
# PowerShell logs it as event 4100 even when it is caught (Windows Server has no Security Center; with another virus
# protection there is no Defender namespace). So it looks first - a query that finds nothing is no error.
$CimSeen = @{}
function Test-Cim([string]$Ns, [string]$Class) {
  $key = "$Ns|$Class"
  if (-not $CimSeen.ContainsKey($key)) {
    $parts = @($Ns -split '/')
    $ok = $true
    for ($i = 1; $ok -and $i -lt $parts.Count; $i++) {
      $ok = @(Get-CimInstance -Namespace ($parts[0..($i - 1)] -join '/') -ClassName '__NAMESPACE' -Filter "Name='$($parts[$i])'").Count -gt 0
    }
    if ($ok) { $ok = @(Get-CimInstance -Namespace $Ns -Query "SELECT * FROM meta_class WHERE __CLASS = '$Class'").Count -gt 0 }
    $CimSeen[$key] = $ok
  }
  $CimSeen[$key]
}
function Get-Cim([string]$Ns, [string]$Class, [string]$Filter) {
  if (-not (Test-Cim $Ns $Class)) { return }
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
      $mac = Format-Mac ([string]@(@($_.NetworkAddresses) | Where-Object { $_ })[0]); if (-not $mac) { $mac = Format-Mac ([string]$_.PermanentAddress) }
      @{ name = [string]$_.Name; desc = [string]$_.InterfaceDescription; mac = $mac; speed = [int64]$_.Speed; up = ([int]$_.InterfaceOperationalStatus -eq 1) } } }) }
}

# Physical disks with health and - where the disk tells - temperature, wear, hours and uncorrected errors
$pdisks = @(Try-Get { Get-Cim $StorageNs 'MSFT_PhysicalDisk' | ForEach-Object {
  $r = $null; try { $r = @(Get-CimAssociatedInstance -InputObject $_ -ResultClassName 'MSFT_StorageReliabilityCounter')[0] } catch { $r = $null }
  @{ name = [string]$_.FriendlyName; serial = ([string]$_.SerialNumber).Trim(); media = (Get-EnumName $MediaNames $_.MediaType); bus = (Get-EnumName $BusNames $_.BusType)
    size = [int64]$_.Size; health = (Get-EnumName $HealthNames $_.HealthStatus)
    temp = $(if ($r) { $r.Temperature }); wear = $(if ($r) { $r.Wear }); hours = $(if ($r) { $r.PowerOnHours })
    readErrors = $(if ($r) { $r.ReadErrorsUncorrected }); writeErrors = $(if ($r) { $r.WriteErrorsUncorrected }) } } })
# Storage Spaces: the pools (not the primordial one every disk sits in), their virtual disks and the disks in them that
# are not healthy - through the WMI classes and what is linked to them, not the Storage module (see above)
$spaces = @(Try-Get {
  foreach ($p in @(Get-Cim $StorageNs 'MSFT_StoragePool' | Where-Object { -not $_.IsPrimordial })) {
    $vds = @(Get-CimAssociatedInstance -InputObject $p -ResultClassName MSFT_VirtualDisk | ForEach-Object { @{ name = [string]$_.FriendlyName; health = $_.HealthStatus } })
    $bad = @(Get-CimAssociatedInstance -InputObject $p -ResultClassName MSFT_PhysicalDisk | Where-Object { [int]$_.HealthStatus -ne 0 }).Count
    @{ name = [string]$p.FriendlyName; health = $p.HealthStatus; size = [int64]$p.Size; alloc = [int64]$p.AllocatedSize; vdisks = $vds; badDisks = $bad }
  }
})

# Windows updates: the search takes a while, so it runs after the report at most every 6 hours; the report sends
# the last result. A pending restart is read every time (registry, quick).
$UpdFile = Join-Path $Dir 'womn-updates.json'
# (only when it is there: Get-Content on a missing file is a cmdlet error - logged as event 4100 even when caught)
$upd = $null
if (Test-Path -LiteralPath $UpdFile) { $upd = Try-Get { Get-Content -Raw -LiteralPath $UpdFile | ConvertFrom-Json } }
$reboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or
  (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
$updates = @{ pending = $(if ($upd) { $upd.pending }); security = $(if ($upd) { $upd.security }); checkedAt = $(if ($upd) { $upd.checkedAt })
  lastInstalled = $(if ($upd) { $upd.lastInstalled }); reboot = [bool]$reboot }

# Virus protection: Defender, on client Windows also another product registered in the Security Center
$av = Try-Get {
  $m = Try-Get { @(Get-Cim 'root/Microsoft/Windows/Defender' 'MSFT_MpComputerStatus')[0] }
  $sc = @(Try-Get { Get-Cim 'root/SecurityCenter2' 'AntiVirusProduct' })
  $other = @($sc | Where-Object { $_.displayName -notmatch 'Defender' -and ([int]$_.productState -band 0x1000) })[0]
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
    items = @($all[0..9] | ForEach-Object { @{ at = $_.TimeCreated.ToUniversalTime().ToString('o'); level = $(if ($_.Level -eq 1) { 'critical' } else { 'error' })
      source = [string]$_.ProviderName; id = [int]$_.Id; message = ([string]$_.Message -split "`n")[0].Trim() } }) }
}

# Certificates of the machine (store "My"): IIS, RDP gateway, Exchange … - the expired ones only for 30 days
$certs = @(Try-Get { @(Get-ChildItem -Path Cert:\LocalMachine\My | Where-Object { $_.NotAfter -gt (Get-Date).AddDays(-30) })[0..49] | ForEach-Object {
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
    foreach ($f in @(@(Get-ChildItem -LiteralPath $ChkDir -File | Where-Object { @('.ps1', '.cmd', '.bat') -contains $_.Extension.ToLower() } | Sort-Object Name)[0..49])) {
      if (-not (Test-Safe $f.FullName)) { $checks += Check-Entry $f.Name 'owner or rights not safe - not run (owner must be Administrators)' $f.Name; continue }
      $p = New-Object System.Diagnostics.Process
      # A check of the administrators (owner and rights checked above) runs under RemoteSigned: a download mark is
      # removed instead of switching the execution policy off
      if ($f.Extension -ieq '.ps1') { try { Unblock-File -LiteralPath $f.FullName } catch { $null = $_ }
        $p.StartInfo.FileName = 'powershell.exe'; $p.StartInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$($f.FullName)`"" }
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

# Plugins written in WhatsOnMyNet (Settings → Plugins), put into the plugins folder by the administrators. A plugin
# runs only when WhatsOnMyNet named exactly this file for this machine in its answer to the last report: id, version
# and fingerprint (SHA-256) - a changed file, an old version or a plugin meant for other machines does not run. The
# same rights rules as for the checks; at most 50. Lines in the check format or "Name: value unit" (e.g.
# "Backup-Alter: 26 h") are sent with the report.
$plugins = @()
$PlugDir = Join-Path $Dir 'plugins'
$AllowFile = Join-Path $Dir 'womn-plugins.txt'
$allow = @{}
if (Test-Path -LiteralPath $AllowFile) {
  foreach ($a in ([string](Try-Get { [IO.File]::ReadAllText($AllowFile) }) -split '\s+')) {
    if ($a -match '^(\d{1,9}):(\d{1,9}):([0-9a-f]{64}):(\d{1,3}):(\d{1,4})$') { $allow[[int]$Matches[1]] = @{ v = [int]$Matches[2]; sha = $Matches[3]; t = [int]$Matches[4]; every = [int]$Matches[5] } }
  }
}
function Plugin-Entry($File, $Id, $Version, $State, $Text) { @{ file = $File; id = $Id; version = $Version; state = $State; text = $Text } }
if (Test-Path -LiteralPath $PlugDir) {
  if (-not (Test-Safe $PlugDir)) { $plugins = @(Plugin-Entry '' $null $null 'unsafe' "folder $PlugDir may be changed by others - plugins not run") }
  else {
    $PlugStart = Get-Date
    foreach ($f in @(@(Get-ChildItem -LiteralPath $PlugDir -File | Where-Object { $_.Extension -ieq '.ps1' } | Sort-Object Name)[0..49])) {
      $bytes = [IO.File]::ReadAllBytes($f.FullName)
      $head = [Text.Encoding]::UTF8.GetString($bytes, 0, [Math]::Min($bytes.Length, 600))
      if ($head -notmatch '# womn-plugin id=(\d{1,9}) version=(\d{1,9})') { $plugins += Plugin-Entry $f.Name $null $null 'noHeader' 'not a plugin of WhatsOnMyNet - not run'; continue }
      $id = [int]$Matches[1]; $ver = [int]$Matches[2]
      if (-not (Test-Safe $f.FullName)) { $plugins += Plugin-Entry $f.Name $id $ver 'unsafe' 'owner or rights not safe - not run (owner must be Administrators)'; continue }
      $sha = Get-Sha256 $f.FullName
      $a = $allow[$id]
      if (-not $a) { $plugins += Plugin-Entry $f.Name $id $ver 'notAssigned' 'not meant for this machine (or switched off) - not run'; continue }
      if ($a.sha -ne $sha) {
        if ($ver -lt $a.v) { $plugins += Plugin-Entry $f.Name $id $ver 'outdated' "version $ver - WhatsOnMyNet has version $($a.v): download it again" }
        else { $plugins += Plugin-Entry $f.Name $id $ver 'changed' 'the file is not the one from WhatsOnMyNet - download it again' }
        continue
      }
      # Not every run: a plugin that runs every 60 minutes gives its last output again in between (same file only)
      $cache = Join-Path $Dir "womn-plugin-$id.out"
      $out = $null; $cachedAt = $null
      if (Test-Path -LiteralPath $cache) {
        $c = [string](Try-Get { [IO.File]::ReadAllText($cache) })
        if ($c -match '^([0-9a-f]{64}) (\d{1,20})\r?\n') {
          $then = [datetime]::FromFileTimeUtc([int64]$Matches[2])
          if ($Matches[1] -eq $sha -and ((Get-Date).ToUniversalTime() - $then).TotalMinutes -lt ($a.every - 1)) { $out = $c.Substring($Matches[0].Length); $cachedAt = $then }
        }
      }
      if ($null -eq $out) {
        # at most 3 minutes for all plugins of a run, so the report still goes out every 5 minutes - the rest runs next time
        if (((Get-Date) - $PlugStart).TotalSeconds -gt 180) { $plugins += Plugin-Entry $f.Name $id $ver 'deferred' 'time budget of this run used up - runs next time'; continue }
      try { Unblock-File -LiteralPath $f.FullName } catch { $null = $_ }
      $p = New-Object System.Diagnostics.Process
      $p.StartInfo.FileName = 'powershell.exe'; $p.StartInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$($f.FullName)`""
      $p.StartInfo.UseShellExecute = $false; $p.StartInfo.RedirectStandardOutput = $true; $p.StartInfo.RedirectStandardInput = $true; $p.StartInfo.CreateNoWindow = $true
      try { [void]$p.Start(); $p.StandardInput.Close(); $read = $p.StandardOutput.ReadToEndAsync() } catch { $plugins += Plugin-Entry $f.Name $id $ver 'error' "could not start: $($_.Exception.Message)"; continue }
      if (-not $p.WaitForExit($a.t * 1000)) { try { $p.Kill() } catch { $null = $_ }; $plugins += Plugin-Entry $f.Name $id $ver 'timeout' "timeout ($($a.t) s)"; continue }
      $out = [string]$read.Result; if ($out.Length -gt 20000) { $out = $out.Substring(0, 20000) }
      if ($a.every -gt 5) { try { [IO.File]::WriteAllText($cache, "$sha $((Get-Date).ToUniversalTime().ToFileTimeUtc())`n$out") } catch { $null = $_ } }
      }
      $found = 0
      foreach ($line in ($out -split "`r?`n")) {
        if ($line -match '^([0-3])\s+(\S+)\s+(\S+)\s*(.*)$') {
          $st = [int]$Matches[1]; $nm = $Matches[2]; $perf = $Matches[3]; $txt = $Matches[4]; $val = $null
          if ($perf -ne '-' -and $perf -match '^[^=|]+=(-?\d+(?:\.\d+)?)') { $val = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture) }
          $checks += @{ name = $nm; status = $st; text = $txt; value = $val; file = $f.Name; plugin = $id; unit = '' }; $found++
        } elseif ($line -match '^\s*([^:]{1,60}?)\s*:\s*(-?\d+(?:[.,]\d+)?)\s*([^\s\d]\S{0,11})?\s*$') {
          $nm = ($Matches[1].Trim() -replace '\s+', '_'); $unit = [string]$Matches[3]
          $val = [double]::Parse(($Matches[2] -replace ',', '.'), [Globalization.CultureInfo]::InvariantCulture)
          $checks += @{ name = $nm; status = 0; text = "$($Matches[2]) $unit".Trim(); value = $val; file = $f.Name; plugin = $id; unit = $unit }; $found++
        }
      }
      if ($found -and $cachedAt) { $plugins += Plugin-Entry $f.Name $id $ver 'ok' "$found value(s), runs every $($a.every) min - last run $([int]((Get-Date).ToUniversalTime() - $cachedAt).TotalMinutes) min ago" }
      elseif ($found) { $plugins += Plugin-Entry $f.Name $id $ver 'ok' "$found value(s)" }
      else { $plugins += Plugin-Entry $f.Name $id $ver 'error' "no line in a known format (exit code $($p.ExitCode))" }
    }
  }
}

$net = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE')
# Network cards (physical, wired): state, speed, bytes and errors - read only when WhatsOnMyNet asked for them (its
# answer to the last report: the ports of this machine are watched there). By CIM like the disks (no NetAdapter
# cmdlets: those would log warning 4104 on every run); Windows versions without the namespace send none. Wi-Fi left
# out: its speed changes all the time.
$NicsFile = Join-Path $Dir 'womn-nics.txt'
$nics = @()
$nicStats = @{}
$wantNics = Test-Path -LiteralPath $NicsFile
if ($wantNics) {
  foreach ($x in @(Try-Get { Get-Cim 'root/StandardCimv2' 'MSFT_NetAdapterStatisticsSettingData' '' })) {
    if ($x) { $nicStats[[string]$x.Name] = $x }
  }
}
foreach ($a in @($(if ($wantNics) { Try-Get { Get-Cim 'root/StandardCimv2' 'MSFT_NetAdapter' 'ConnectorPresent=TRUE' } }))) {
  if (-not $a -or $nics.Count -ge 32 -or [int]$a.NdisPhysicalMedium -eq 9) { continue }
  $st = $nicStats[[string]$a.Name]
  $nics += @{ name = [string]$a.Name; descr = [string]$a.InterfaceDescription; up = ([int]$a.InterfaceOperationalStatus -eq 1); speed = [int64]([double]$a.Speed / 1000000)
    rxBytes = $st.ReceivedBytes; txBytes = $st.SentBytes; rxErrors = $st.ReceivedPacketErrors; txErrors = $st.OutboundPacketErrors }
}
$body = @{
  hostname = $env:COMPUTERNAME; os = "$($os.Caption) $($os.Version)".Trim(); cpu = [int]$cpu
  memTotal = [int64]$os.TotalVisibleMemorySize * 1024; memUsed = ([int64]$os.TotalVisibleMemorySize - [int64]$os.FreePhysicalMemory) * 1024
  uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds; disks = $disks; services = $services
  macs = @($net | ForEach-Object { $_.MACAddress } | Where-Object { $_ }); ips = @($net | ForEach-Object { $_.IPAddress } | Where-Object { $_ -match '^\d+\.' }); ups = $ups
  hw = $hw; pdisks = $pdisks; updates = $updates; av = $av; firewall = $fw; events = $events; certs = $certs; checks = $checks; plugins = $plugins; spaces = $spaces; nics = $nics; script = $ScriptVersion
  selfUpdate = (Try-Get { if (Test-Path -LiteralPath $UpdState) { [IO.File]::ReadAllText($UpdState) | ConvertFrom-Json } })
} | ConvertTo-Json -Depth 6 -Compress
Send-Report $body

# Self-update: the answer to the report names a newer version of this script ("update": "<version>:<sha256>") when
# WhatsOnMyNet offers one. It is fetched from the same address with the same key and certificate check, its
# fingerprint and version must match, the address, key and certificate pin of this copy are put in, and the copy
# replaces itself - the next run is the new version; the task, the key and the settings stay. Not during the setup.
# A failed try leaves the old copy running and is repeated on the next run; its result goes with the next report.
if (-not $Setup -and -not $SendFailed -and [string]$script:Answer -match '"update"\s*:\s*"(\d{1,4}\.\d{1,4}\.\d{1,6}):([0-9a-f]{64})"') {
  $newVer = $Matches[1]; $newSha = $Matches[2]; $updMsg = ''; $updOk = $false; $bytes = $null
  $tmp = "$Dest.download"; $new = "$Dest.new"
  try {
    $req = [Net.HttpWebRequest]::Create(($Url -replace '/push$', '/script'))
    $req.Method = 'GET'; $req.Timeout = 60000; $req.ReadWriteTimeout = 60000
    $req.Headers.Add('Authorization', "Bearer $Token"); $req.Headers.Add('X-WOMN-Request', '1')
    $resp = $null
    try { $resp = $req.GetResponse() } catch {
      $ex = $_.Exception
      while ($ex.InnerException -and -not ($ex -is [Net.WebException])) { $ex = $ex.InnerException }
      if ($ex -is [Net.WebException] -and $ex.Response) { $resp = $ex.Response } else { $updMsg = [string]$ex.Message }
    }
    if ($resp) {
      # read as text like the answer to the report (UTF-8 there and back gives the same bytes, so the fingerprint holds)
      if ([int]$resp.StatusCode -eq 200 -and $resp.ContentLength -le 1048576) {
        $r = [IO.StreamReader]::new($resp.GetResponseStream(), [Text.UTF8Encoding]::new($false)); $bytes = [Text.Encoding]::UTF8.GetBytes($r.ReadToEnd()); $r.Close()
      } elseif ([int]$resp.StatusCode -eq 200) { $updMsg = 'too large' } else { $updMsg = "answer $([int]$resp.StatusCode)" }
      $resp.Close()
    }
    if ($bytes -and $bytes.Length -gt 1048576) { $updMsg = 'too large' }
    elseif ($bytes) {
      [IO.File]::WriteAllBytes($tmp, $bytes)
      if ((Get-Sha256 $tmp) -ne $newSha) { $updMsg = 'fingerprint does not match' }
      else {
        $text = [Text.Encoding]::UTF8.GetString($bytes)
        if ($text -notmatch ('(?m)^\$ScriptVersion = ''' + [regex]::Escape($newVer) + '''')) { $updMsg = 'version does not match' }
        else {
          $q = { param($v) "'" + ([string]$v -replace "['‘’‚‛]", '$0$0') + "'" }
          # the marks are put together here, so this block itself is not changed when the marks are filled in
          $mk = '@@' + 'WOMN_'
          $text = $text.Replace($mk + 'URL@@', (& $q $Url)).Replace($mk + 'TOKEN@@', (& $q $Token)).Replace($mk + 'THUMB@@', (& $q $Thumb)).Replace($mk + 'PUBKEY@@', (& $q $PublicKey))
          if ($text.Contains($mk)) { $updMsg = 'unknown mark in the new version' }
          else {
            [IO.File]::WriteAllText($new, $text, [Text.UTF8Encoding]::new($true))
            # (no backup file: [NullString] - a plain $null would arrive as an empty path)
            [IO.File]::Replace($new, $Dest, [NullString]::Value)
            $updOk = $true
          }
        }
      }
    }
  } catch { $updMsg = [string]$_.Exception.Message }
  foreach ($f in @($tmp, $new)) { if (Test-Path -LiteralPath $f) { try { Remove-Item -LiteralPath $f -Force } catch { $null = $_ } } }
  if (-not $updOk -and -not $updMsg) { $updMsg = 'no answer' }
  if ($updMsg.Length -gt 200) { $updMsg = $updMsg.Substring(0, 200) }
  try { @{ at = (Get-Date).ToUniversalTime().ToString('o'); ok = $updOk; version = $newVer; message = $updMsg } | ConvertTo-Json -Compress | Set-Content -Path $UpdState -Encoding UTF8 } catch { $null = $_ }
}

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
# a refused or failed report: in the status file, and the task shows result 2 (nothing in the event log)
if ($SendFailed) { exit 2 }
