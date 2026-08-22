[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$EngineRoot,

    [Parameter(Mandatory = $true)]
    [string]$Project,

    [Parameter(Mandatory = $true)]
    [string]$Map,

    [string]$Plugin = (Join-Path $PSScriptRoot '..\UE5HTML5Exporter\UE5HTML5Exporter.uplugin'),

    [string]$PackageOutput,

    [string]$ExportOutput
)

$ErrorActionPreference = 'Stop'

$enginePath = (Resolve-Path -LiteralPath $EngineRoot).Path
$projectPath = (Resolve-Path -LiteralPath $Project).Path
$pluginPath = (Resolve-Path -LiteralPath $Plugin).Path
if ([System.IO.Path]::GetExtension($projectPath) -ne '.uproject') {
    throw "Expected a .uproject file: $projectPath"
}
if ($Map -notmatch '^/Game/') {
    throw "Map must be an Unreal content path beginning with /Game/: $Map"
}

$editorCommand = Join-Path $enginePath 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe'
if (-not (Test-Path -LiteralPath $editorCommand -PathType Leaf)) {
    throw "UnrealEditor-Cmd.exe was not found: $editorCommand"
}
$node = Get-Command node -ErrorAction Stop

$stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
if (-not $PackageOutput) {
    $PackageOutput = Join-Path ([System.IO.Path]::GetTempPath()) "UE5HTML5Exporter-Win64-$stamp"
}
if (-not $ExportOutput) {
    $ExportOutput = Join-Path (Split-Path -Parent $projectPath) "Saved\UE5HTML5Certification\$stamp"
}
$packagePath = [System.IO.Path]::GetFullPath($PackageOutput)
$exportPath = [System.IO.Path]::GetFullPath($ExportOutput)
if (Test-Path -LiteralPath $packagePath) {
    throw "PackageOutput already exists; choose a new path: $packagePath"
}
if (Test-Path -LiteralPath $exportPath) {
    throw "ExportOutput already exists; choose a new path: $exportPath"
}

$packageScript = Join-Path $PSScriptRoot 'Package-UE5HTML5Exporter.ps1'
$installScript = Join-Path $PSScriptRoot 'Install-UE5HTML5Exporter.ps1'
foreach ($script in @($packageScript, $installScript)) {
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
        throw "Required certification helper was not found: $script"
    }
}

& $packageScript -EngineRoot $enginePath -Platform Win64 -Plugin $pluginPath -Output $packagePath
if ($LASTEXITCODE -ne 0) { throw "Win64 plugin packaging failed with status $LASTEXITCODE." }

& $installScript -Project $projectPath -Plugin $packagePath -Replace
if ($LASTEXITCODE -ne 0) { throw "Packaged plugin installation failed with status $LASTEXITCODE." }

& $editorCommand $projectPath -run=UE5HTML5Export "-Map=$Map" -CheckOnly -unattended -nop4 -NullRHI
if ($LASTEXITCODE -ne 0) { throw "Unreal readiness check failed with status $LASTEXITCODE." }

& $editorCommand $projectPath -run=UE5HTML5Export "-Map=$Map" "-Output=$exportPath" -unattended -nop4 -NullRHI
if ($LASTEXITCODE -ne 0) { throw "Unreal export failed with status $LASTEXITCODE." }

$packagePreflight = Join-Path $exportPath 'scripts\activity-preflight.mjs'
if (-not (Test-Path -LiteralPath $packagePreflight -PathType Leaf)) {
    throw "Exported package preflight was not found: $packagePreflight"
}
& $node.Source $packagePreflight --package-only
if ($LASTEXITCODE -ne 0) { throw "Discord Activity package preflight failed with status $LASTEXITCODE." }

$descriptor = Get-Content -LiteralPath (Join-Path $packagePath 'UE5HTML5Exporter.uplugin') -Raw | ConvertFrom-Json
$report = [ordered]@{
    schema = 'ue5-html5-workstation-certification/v1'
    verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
    platform = 'Win64'
    exporterVersion = $descriptor.VersionName
    projectFile = [System.IO.Path]::GetFileName($projectPath)
    map = $Map
    pluginPackageArtifact = 'UE5HTML5Exporter-Win64'
    exportArtifact = 'UE5HTML5Exporter-Certified-Export'
    readiness = 'passed'
    unrealExport = 'passed'
    activityPackagePreflight = 'passed'
}
$reportPath = Join-Path $exportPath 'workstation-certification.json'
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportPath -Encoding utf8

Write-Host "UE5HTML5Exporter Win64 workstation certification passed."
Write-Host "Plugin package: $packagePath"
Write-Host "Verified export: $exportPath"
Write-Host "Report: $reportPath"
