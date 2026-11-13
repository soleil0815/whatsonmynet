# WhatsOnMyNet - Windows report (read only). Sends CPU, RAM, drives, uptime and the state of the automatic services
# every 5 minutes to WhatsOnMyNet. No agent, no open port, nothing installed: run it once as administrator (or via
# software distribution / GPO) - it sets itself up as scheduled task under SYSTEM. Removing: womn-host-uninstall.ps1.
# Talks only to the address below; loads nothing from anywhere.
$ErrorActionPreference = 'Stop'
$Url = @URL@
$Token = @TOKEN@
$Thumb = @THUMB@
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($Thumb) {
  # Self-signed certificate of WhatsOnMyNet: trust exactly this one
  Add-Type -TypeDefinition @"
using System.Net; using System.Net.Security; using System.Security.Cryptography.X509Certificates;
public static class WomnPin { static string Thumb;
  static bool Check(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) { return c != null && c.GetCertHashString() == Thumb; }
  public static void Enable(string t) { Thumb = t; ServicePointManager.ServerCertificateValidationCallback = Check; } }
"@
  [WomnPin]::Enable($Thumb.Replace(':', '').ToUpper())
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
$net = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE')
$body = @{
  hostname = $env:COMPUTERNAME; os = "$($os.Caption) $($os.Version)".Trim(); cpu = [int]$cpu
  memTotal = [int64]$os.TotalVisibleMemorySize * 1024; memUsed = ([int64]$os.TotalVisibleMemorySize - [int64]$os.FreePhysicalMemory) * 1024
  uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds; disks = $disks; services = $services
  macs = @($net | ForEach-Object { $_.MACAddress } | Where-Object { $_ }); ips = @($net | ForEach-Object { $_.IPAddress } | Where-Object { $_ -match '^\d+\.' })
} | ConvertTo-Json -Depth 4 -Compress
Invoke-RestMethod -Method Post -Uri $Url -Headers @{ Authorization = "Bearer $Token"; 'X-WOMN-Request' = '1' } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 | Out-Null
