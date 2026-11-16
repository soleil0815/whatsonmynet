# Older Windows Server (CI): GitHub only offers Windows Server 2022 and 2025 to run on, so the scripts are checked
# against what Server 2012, 2012 R2, 2016 and 2019 have - syntax, commands and .NET types of their PowerShell (3.0,
# 4.0, 5.1) - with the compatibility rules of PSScriptAnalyzer and its recorded profiles of these versions.
param([Parameter(Mandatory)][string]$Dir)
$ErrorActionPreference = 'Stop'
$profiles = @(
  'win-8_x64_6.2.9200.0_3.0_x64_4.0.30319.42000_framework',            # Server 2012, PowerShell 3.0
  'win-8_x64_6.3.9600.0_4.0_x64_4.0.30319.42000_framework',            # Server 2012 R2, PowerShell 4.0
  'win-8_x64_10.0.14393.0_5.1.14393.2791_x64_4.0.30319.42000_framework', # Server 2016, PowerShell 5.1
  'win-8_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework'   # Server 2019, PowerShell 5.1
)
$settings = @{ Rules = @{
  PSUseCompatibleSyntax = @{ Enable = $true; TargetVersions = @('3.0', '4.0', '5.1') }
  PSUseCompatibleCommands = @{ Enable = $true; TargetProfiles = $profiles }
  PSUseCompatibleTypes = @{ Enable = $true; TargetProfiles = $profiles }
} }
$found = @()
foreach ($f in Get-ChildItem -Path $Dir -Filter *.ps1) {
  $r = @(Invoke-ScriptAnalyzer -Path $f.FullName -Settings $settings)
  "$($f.Name): $($r.Count) finding(s)"
  foreach ($x in $r) { "  line $($x.Line): $($x.RuleName): $($x.Message)" }
  $found += $r
}
if ($found.Count) { exit 1 }
'compatible with Windows Server 2012, 2012 R2, 2016 and 2019'
