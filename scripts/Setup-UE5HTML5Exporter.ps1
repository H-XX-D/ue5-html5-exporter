[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$Project,

    [string]$Plugin = (Join-Path $PSScriptRoot '..\UE5HTML5Exporter'),

    [string]$EngineRoot,

    [string]$LauncherManifest,

    [string]$VsWhere,

    [switch]$SourceOnly,

    [switch]$Replace,

    [switch]$CheckOnly,

    [switch]$Launch,

    [switch]$Json
)

$ErrorActionPreference = 'Stop'

$module = Join-Path $PSScriptRoot 'UE5HTML5Tools.psm1'
$installer = Join-Path $PSScriptRoot 'Install-UE5HTML5Exporter.ps1'
foreach ($required in @($module, $installer)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required setup component was not found: $required"
    }
}
Import-Module $module -Force

$projectPath = (Resolve-Path -LiteralPath $Project).Path
$pluginPath = (Resolve-Path -LiteralPath $Plugin).Path
if ([System.IO.Path]::GetExtension($projectPath) -ne '.uproject') {
    throw "Expected a .uproject file: $projectPath"
}
$descriptor = Join-Path $pluginPath 'UE5HTML5Exporter.uplugin'
if (-not (Test-Path -LiteralPath $descriptor -PathType Leaf)) {
    throw "Plugin descriptor was not found: $descriptor"
}
$projectDescriptor = Get-Content -LiteralPath $projectPath -Raw | ConvertFrom-Json
$engineAssociation = [string]$projectDescriptor.EngineAssociation

$hasWin64Binaries = Test-Path -LiteralPath (Join-Path $pluginPath 'Binaries\Win64') -PathType Container
$compileFromSource = $SourceOnly -or -not $hasWin64Binaries
$reportParameters = @{
    RequireVisualStudio = $compileFromSource
    RequireNode = $false
}
if ($EngineRoot) { $reportParameters.EngineRoot = $EngineRoot }
if ($LauncherManifest) { $reportParameters.LauncherManifest = $LauncherManifest }
if ($engineAssociation) { $reportParameters.EngineAssociation = $engineAssociation }
if ($VsWhere) { $reportParameters.VsWhere = $VsWhere }
$report = Get-UE5HTML5WorkstationReport @reportParameters
$report | Add-Member -NotePropertyName projectFile -NotePropertyValue ([System.IO.Path]::GetFileName($projectPath))
$report | Add-Member -NotePropertyName installMode -NotePropertyValue $(if ($compileFromSource) { 'source' } else { 'prebuilt-win64' })

if (-not $report.ready) {
    if ($Json) { $report | ConvertTo-Json -Depth 6 }
    else {
        Write-Host 'UE5HTML5Exporter workstation check failed:' -ForegroundColor Red
        foreach ($blocker in $report.blockers) { Write-Host "- $blocker" -ForegroundColor Red }
        Write-Host 'Open Visual Studio Installer and enable Game development with C++, Visual Studio Tools for Unreal Engine, and a supported Windows SDK.'
    }
    exit 1
}

if ($CheckOnly) {
    if ($Json) { $report | ConvertTo-Json -Depth 6 }
    else {
        Write-Host "Windows workstation is ready for UE5HTML5Exporter $($report.installMode)."
        Write-Host "Unreal Engine: $($report.engineVersion) at $($report.engineRoot)"
        if ($report.visualStudio) { Write-Host "Visual Studio: $($report.visualStudio.displayName) $($report.visualStudio.version)" }
        foreach ($warning in $report.warnings) { Write-Warning $warning }
    }
    exit 0
}

if ($PSCmdlet.ShouldProcess($projectPath, "Install UE5HTML5Exporter ($($report.installMode))")) {
    $installParameters = @{ Project = $projectPath; Plugin = $pluginPath }
    if ($compileFromSource) { $installParameters.SourceOnly = $true }
    if ($Replace) { $installParameters.Replace = $true }
    & $installer @installParameters
    $report | Add-Member -NotePropertyName installed -NotePropertyValue $true
}
else {
    $report | Add-Member -NotePropertyName installed -NotePropertyValue $false
}

if ($Launch -and $report.installed) {
    Start-Process -FilePath $projectPath
    $report | Add-Member -NotePropertyName launched -NotePropertyValue $true
}
else {
    $report | Add-Member -NotePropertyName launched -NotePropertyValue $false
}

if ($Json) { $report | ConvertTo-Json -Depth 6 }
else {
    Write-Host 'Setup complete. Open the project, accept the Unreal rebuild if prompted, then use Tools -> HTML5 Export.'
    foreach ($warning in $report.warnings) { Write-Warning $warning }
}
