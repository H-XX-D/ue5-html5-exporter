[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$module = Join-Path $PSScriptRoot 'UE5HTML5Tools.psm1'
Import-Module $module -Force

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ue5html5-windows-tooling-$([Guid]::NewGuid().ToString('N'))"
try {
    $engine57 = Join-Path $testRoot 'UE_5.7'
    $engine58 = Join-Path $testRoot 'UE_5.8'
    foreach ($engine in @($engine57, $engine58)) {
        New-Item -ItemType Directory -Path (Join-Path $engine 'Engine\Build\BatchFiles') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $engine 'Engine\Binaries\Win64') -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $engine 'Engine\Build\BatchFiles\RunUAT.bat') -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $engine 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe') -Force | Out-Null
    }
    @{ MajorVersion = 5; MinorVersion = 7; PatchVersion = 2 } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $engine57 'Engine\Build\Build.version') -Encoding utf8
    @{ MajorVersion = 5; MinorVersion = 8; PatchVersion = 1 } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $engine58 'Engine\Build\Build.version') -Encoding utf8

    $manifest = Join-Path $testRoot 'LauncherInstalled.dat'
    @{
        InstallationList = @(
            @{ AppName = 'UE_5.7'; AppVersion = '5.7.2'; InstallLocation = $engine57 },
            @{ AppName = 'UE_5.8'; AppVersion = '5.8.1'; InstallLocation = $engine58 }
        )
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifest -Encoding utf8

    $resolved = Resolve-UE5EngineRoot -LauncherManifest $manifest
    Assert-True ($resolved -eq (Resolve-Path -LiteralPath $engine58).Path) 'launcher discovery must select the newest valid Unreal installation'
    $projectEngine = Resolve-UE5EngineRoot -LauncherManifest $manifest -EngineAssociation '5.7'
    Assert-True ($projectEngine -eq (Resolve-Path -LiteralPath $engine57).Path) 'project association must select the matching Unreal minor version'
    Assert-True ((Get-UE5EngineVersion -EngineRoot $engine58) -eq [version]'5.8.1') 'Build.version must drive engine version detection'
    Assert-True (Test-UE5VisualStudioCompatibility -EngineVersion ([version]'5.8.1') -VisualStudioVersion ([version]'17.14.0')) 'UE 5.8 must accept VS 2022 17.14'
    Assert-True (-not (Test-UE5VisualStudioCompatibility -EngineVersion ([version]'5.8.1') -VisualStudioVersion ([version]'17.13.9'))) 'UE 5.8 must reject VS 2022 17.13'
    Assert-True (Test-UE5VisualStudioCompatibility -EngineVersion ([version]'5.8.1') -VisualStudioVersion ([version]'18.0.0')) 'UE 5.8 must accept VS 2026 18.0'

    $visualStudio = [pscustomobject]@{
        displayName = 'Visual Studio Community 2022'
        installationVersion = '17.14.10'
        installationPath = 'C:\Program Files\Microsoft Visual Studio\2022\Community'
    }
    $readyParameters = @{
        EngineRoot = $engine58
        RequireVisualStudio = $true
        RequireNode = $true
        VisualStudioInstallation = $visualStudio
        WindowsSdkVersion = [version]'10.0.26100.0'
        NodeVersion = [version]'22.12.0'
    }
    $ready = Get-UE5HTML5WorkstationReport @readyParameters
    Assert-True $ready.ready 'complete supported toolchain must be ready'
    Assert-True ($ready.blockers.Count -eq 0) 'ready report must have no blockers'

    $oldNodeParameters = $readyParameters.Clone()
    $oldNodeParameters.NodeVersion = [version]'21.0.0'
    $oldNode = Get-UE5HTML5WorkstationReport @oldNodeParameters
    Assert-True (-not $oldNode.ready) 'Node 21 must fail certification readiness'
    Assert-True (($oldNode.blockers -join ' ') -match 'Node.js 21') 'old Node blocker must be actionable'

    Write-Host 'Windows tooling contract tests passed.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
