# Fluent Bit as sender of Windows events, as the manual describes it: installed, started with the configuration of
# the manual (only address and port changed), two events written - they must arrive at the parser of WhatsOnMyNet
# with number, source, log, severity and umlauts as Windows has them.
param([Parameter(Mandatory)][string]$Work)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Work | Out-Null

# 1. Fluent Bit (Chocolatey checks the checksum of the package)
& choco install fluent-bit -y --no-progress | Select-Object -Last 3
$exe = @(Get-ChildItem -Path "$env:ProgramFiles\fluent-bit", "${env:ProgramFiles(x86)}\fluent-bit" -Filter fluent-bit.exe -Recurse -ErrorAction SilentlyContinue)[0]
if (-not $exe) { 'fluent-bit.exe not found'; exit 1 }
& $exe.FullName --version

# 2. the configuration of the manual (the block that starts with [SERVICE]) - only host and port for this check
$manual = Get-Content -Raw -Encoding UTF8 -Path 'public/help/manual.en.md'
$m = [regex]::Match($manual, '(?s)```\s*(\[SERVICE\].*?)```')
if (-not $m.Success) { 'configuration not found in the manual'; exit 1 }
$conf = $m.Groups[1].Value -replace 'womn\.firma\.local', '127.0.0.1' -replace '(?m)^(\s*Port\s+)1514', '${1}15140' -replace 'C:\\ProgramData\\fluent-bit', ($Work -replace '\\', '\\')
Set-Content -Path (Join-Path $Work 'fluent-bit.conf') -Value $conf -Encoding ASCII
Get-Content (Join-Path $Work 'fluent-bit.conf')

# 3. the stand-in receiver, then Fluent Bit
$got = Join-Path $Work 'received.jsonl'
$rx = Start-Process -FilePath node -ArgumentList 'tools/wincheck/listen.mjs', '15140', $got -PassThru -RedirectStandardOutput (Join-Path $Work 'listen.log') -RedirectStandardError (Join-Path $Work 'listen.err')
Start-Sleep -Seconds 3
$fb = Start-Process -FilePath $exe.FullName -ArgumentList '-c', (Join-Path $Work 'fluent-bit.conf') -PassThru -RedirectStandardOutput (Join-Path $Work 'fluent-bit.log') -RedirectStandardError (Join-Path $Work 'fluent-bit.err')
Start-Sleep -Seconds 8

# 4. two events: a warning and an error of a source of their own, with umlauts
& eventcreate.exe /T WARNING /ID 777 /L APPLICATION /SO WOMN-Pruefung /D 'WhatsOnMyNet-Prüfung: Grüße über Fluent Bit' | Out-Null
& eventcreate.exe /T ERROR /ID 778 /L APPLICATION /SO WOMN-Pruefung /D 'WhatsOnMyNet-Prüfung: Fehler' | Out-Null

$rows = @()
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  $rows = @(Get-Content -Path $got -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.app -eq 'WOMN-Pruefung' })
  if ($rows.Count -ge 2) { break }
}
Stop-Process -Id $fb.Id -ErrorAction SilentlyContinue
Stop-Process -Id $rx.Id -ErrorAction SilentlyContinue
Get-Content (Join-Path $Work 'fluent-bit.log'), (Join-Path $Work 'fluent-bit.err') -ErrorAction SilentlyContinue | Select-Object -Last 20
"received: $(@(Get-Content -Path $got -ErrorAction SilentlyContinue).Count) messages, of the check: $($rows.Count)"
$rows | ForEach-Object { $_ | ConvertTo-Json -Compress }

$w = $rows | Where-Object { $_.eventId -eq 777 } | Select-Object -First 1
$e = $rows | Where-Object { $_.eventId -eq 778 } | Select-Object -First 1
if (-not $w -or -not $e) { 'the two events did not arrive'; exit 1 }
if ($w.channel -ne 'Application' -or $w.severity -ne 4 -or $e.severity -ne 3) { 'log or severity wrong'; exit 1 }
if ($w.text -notmatch 'Grüße über Fluent Bit') { "umlauts wrong: $($w.text)"; exit 1 }
if (-not $w.host) { 'no computer name'; exit 1 }
'Fluent Bit: number, source, log, severity, computer and umlauts arrive.'
