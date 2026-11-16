# Windows check (CI): what the PowerShell logs got while the script ran (run.ps1). Every warning or error fails the
# check - a customer sees them in the event viewer as coming from WhatsOnMyNet (4104 "suspicious", 4100 "system
# error", ...). Informational script block events (4104, level 5) are only counted.
param([Parameter(Mandatory)][string]$Work)
$start = [datetime]::Parse((Get-Content (Join-Path $Work 'start.txt')), $null, 'RoundtripKind').ToLocalTime()
$end = [datetime]::Parse((Get-Content (Join-Path $Work 'end.txt')), $null, 'RoundtripKind').ToLocalTime()
$all = @()
foreach ($log in 'Microsoft-Windows-PowerShell/Operational', 'Windows PowerShell') {
  $all += @(Get-WinEvent -LogName $log -ErrorAction SilentlyContinue | Where-Object { $_.TimeCreated -ge $start -and $_.TimeCreated -le $end })
}
"events in the window: $($all.Count)"
$all | Group-Object { "$($_.LogName) $($_.Id) level $($_.Level)" } | Sort-Object Name | ForEach-Object { "  $($_.Name): $($_.Count)" }
$bad = @($all | Where-Object { $_.Level -ge 1 -and $_.Level -le 3 })
$out = Join-Path $Work 'events.txt'
$all | Sort-Object TimeCreated | ForEach-Object { "==== $($_.TimeCreated.ToString('o')) $($_.LogName) $($_.Id) level $($_.Level) pid $($_.ProcessId)`n$($_.Message)`n" } | Set-Content -Path $out -Encoding UTF8
if ($bad.Count) {
  "`n$($bad.Count) warning(s)/error(s):"
  foreach ($e in $bad) { "---- $($e.Id) level $($e.Level) $($e.TimeCreated.ToString('o'))"; $m = [string]$e.Message; if ($m.Length -gt 3000) { $m.Substring(0, 3000) + ' ...' } else { $m } }
  exit 1
}
$lines = @(Get-Content (Join-Path $Work 'reports.jsonl'))
$n = $lines.Count
# what the last report said about the own checks and the events of the system log
$last = $lines[-1] | ConvertFrom-Json
"checks in the last report: $(@($last.checks | ForEach-Object { "$($_.name)=$($_.status)" }) -join ', ')"
"system log in the last report: $($last.events.errors) error(s), $($last.events.critical) critical"
if (@($last.checks).Count -lt 2) { 'expected the two own checks in the report'; exit 1 }
"reports received: $n"
if ($n -lt 3) { 'expected 3 reports (first run and two task runs)'; exit 1 }
'no warnings or errors in the PowerShell logs'
