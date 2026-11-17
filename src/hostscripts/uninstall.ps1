# WhatsOnMyNet - removes the host script again: scheduled task(s) and script file(s). Run as administrator or SYSTEM
# (by hand, software distribution or GPO). Nothing else was installed, so the machine is as before afterwards.
$ErrorActionPreference = 'Continue'
foreach ($task in @TASKS@) {
  & schtasks.exe /Query /TN $task *> $null
  if ($LASTEXITCODE -eq 0) { & schtasks.exe /Delete /F /TN $task | Out-Null; Write-Output "WhatsOnMyNet: task $task removed." }
}
$Dir = Join-Path $env:ProgramData 'WhatsOnMyNet'
foreach ($file in @FILES@) { Remove-Item -Force -ErrorAction SilentlyContinue -Path (Join-Path $Dir $file) }
if ((Test-Path $Dir) -and -not (Get-ChildItem -Force $Dir)) { Remove-Item -Force $Dir }
# the version noted for software distribution - the key goes when nothing else is in it
$RegKey = 'HKLM:\SOFTWARE\WhatsOnMyNet'
if (Test-Path -LiteralPath $RegKey) {
  $item = Get-Item -LiteralPath $RegKey
  if ($item.Property -contains @REGNAME@) { Remove-ItemProperty -LiteralPath $RegKey -Name @REGNAME@ }
  if (-not (Get-Item -LiteralPath $RegKey).Property -and -not (Get-ChildItem -LiteralPath $RegKey)) { Remove-Item -LiteralPath $RegKey -Force }
}
Write-Output 'WhatsOnMyNet: removed.'
