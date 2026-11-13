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
Write-Output 'WhatsOnMyNet: removed.'
