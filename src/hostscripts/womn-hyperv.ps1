# WhatsOnMyNet - Hyper-V host report (read only). Sends host load, volumes and VMs every 5 minutes.
# Runs as scheduled task under SYSTEM; reads with Get-VM / CIM only, changes nothing.
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
$name = $env:COMPUTERNAME
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$node = @{ name = $name; online = $true; cpu = [int]$cpu; memTotal = [int64]$os.TotalVisibleMemorySize * 1024
  memUsed = ([int64]$os.TotalVisibleMemorySize - [int64]$os.FreePhysicalMemory) * 1024; uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds }
$guests = @(Get-VM | ForEach-Object {
  $st = switch ($_.State.ToString()) { 'Running' { 'running' } 'Off' { 'stopped' } 'Saved' { 'stopped' } 'Paused' { 'paused' } default { 'unknown' } }
  $mem = $null; if ($_.MemoryAssigned -gt 0 -and $_.MemoryDemand -gt 0) { $mem = [math]::Round(100 * $_.MemoryDemand / $_.MemoryAssigned) }
  @{ vmid = $_.VMId.ToString(); name = $_.Name; node = $name; status = $st; cpu = [int]$_.CPUUsage; mem = $mem } })
$storages = @(Get-Volume | Where-Object { $_.DriveType -eq 'Fixed' -and $_.Size -gt 0 -and ($_.DriveLetter -or $_.FileSystemLabel) } | ForEach-Object {
  $n = if ($_.DriveLetter) { "$($_.DriveLetter):" } else { $_.FileSystemLabel }
  @{ name = $n; node = $name; used = [int64]($_.Size - $_.SizeRemaining); total = [int64]$_.Size } })
if (Get-Command Get-ClusterSharedVolume -ErrorAction SilentlyContinue) {
  try { foreach ($v in Get-ClusterSharedVolume) { $p = $v.SharedVolumeInfo.Partition
    $storages += @{ name = $v.Name; node = ''; used = [int64]$p.UsedSpace; total = [int64]$p.Size } } } catch { }
}
$body = @{ nodes = @($node); guests = $guests; storages = $storages } | ConvertTo-Json -Depth 4 -Compress
Invoke-RestMethod -Method Post -Uri $Url -Headers @{ Authorization = "Bearer $Token"; 'X-WOMN-Request' = '1' } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 | Out-Null
