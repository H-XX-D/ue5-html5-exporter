[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Project,

    [string]$Plugin,

    [string]$EngineRoot,

    [string]$LauncherManifest,

    [string]$VsWhere,

    [switch]$SourceOnly,

    [switch]$Replace,

    [switch]$CheckOnly,

    [switch]$NoLaunch,

    [switch]$Json,

    [switch]$LauncherCheck
)

$ErrorActionPreference = 'Stop'

if (-not $Plugin) { $Plugin = Join-Path $PSScriptRoot '..\UE5HTML5Exporter' }

$windowsFormsLoaded = $false
function Import-UE5HTML5WindowsForms {
    if (-not $script:windowsFormsLoaded) {
        Add-Type -AssemblyName System.Windows.Forms
        $script:windowsFormsLoaded = $true
    }
}

$setup = Join-Path $PSScriptRoot 'Setup-UE5HTML5Exporter.ps1'
if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) {
    throw "UE5HTML5Exporter setup tool was not found: $setup"
}

if ($LauncherCheck) {
    Write-Output 'UE5HTML5Exporter Windows setup launcher check passed.'
    return
}

if (-not $Project) {
    Import-UE5HTML5WindowsForms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Choose the Unreal project that should receive UE5HTML5Exporter'
    $dialog.Filter = 'Unreal Engine projects (*.uproject)|*.uproject'
    $dialog.CheckFileExists = $true
    $dialog.Multiselect = $false
    $selection = $dialog.ShowDialog()
    if ($selection -ne [System.Windows.Forms.DialogResult]::OK) {
        Write-Host 'UE5HTML5Exporter setup cancelled; no files were changed.'
        exit 2
    }
    $Project = $dialog.FileName
}

if (-not $Replace -and -not $CheckOnly) {
    $projectPath = (Resolve-Path -LiteralPath $Project).Path
    $installedPlugin = Join-Path (Split-Path -Parent $projectPath) 'Plugins\UE5HTML5Exporter'
    if (Test-Path -LiteralPath $installedPlugin -PathType Container) {
        Import-UE5HTML5WindowsForms
        $choice = [System.Windows.Forms.MessageBox]::Show(
            "UE5HTML5Exporter is already installed in this project.`n`nBack up the current copy and install this version?",
            'Update UE5HTML5Exporter',
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question
        )
        if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
            Write-Host 'UE5HTML5Exporter update cancelled; no files were changed.'
            exit 2
        }
        $Replace = $true
    }
}

$arguments = @{
    Project = $Project
    Plugin = $Plugin
}
if ($EngineRoot) { $arguments.EngineRoot = $EngineRoot }
if ($LauncherManifest) { $arguments.LauncherManifest = $LauncherManifest }
if ($VsWhere) { $arguments.VsWhere = $VsWhere }
if ($SourceOnly) { $arguments.SourceOnly = $true }
if ($Replace) { $arguments.Replace = $true }
if ($CheckOnly) { $arguments.CheckOnly = $true }
if ($Json) { $arguments.Json = $true }
if (-not $NoLaunch -and -not $CheckOnly) { $arguments.Launch = $true }

& $setup @arguments
