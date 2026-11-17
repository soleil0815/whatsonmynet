# WhatsOnMyNet @VERSIONTEXT@ - Hyper-V host report (read only). Sends host load, volumes and VMs every 5 minutes.
# Run it once as administrator (or via software distribution): it sets itself up as scheduled task under SYSTEM.
# Reads with Get-VM / CIM only, changes nothing. Removing: womn-hyperv-uninstall.ps1.
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
$body = @{ nodes = @($node); guests = $guests; storages = $storages; script = $ScriptVersion } | ConvertTo-Json -Depth 4 -Compress
Send-Report $body
# a refused or failed report: in the status file, and the task shows result 2 (nothing in the event log)
if ($SendFailed) { exit 2 }
