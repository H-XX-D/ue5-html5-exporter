[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Project,

    [string]$Map = '/Game/FirstPerson/Lvl_FirstPerson',

    [string]$Plugin,

    [string]$EngineRoot,

    [string]$LauncherManifest,

    [string]$VsWhere,

    [switch]$NoOpen,

    [switch]$LauncherCheck
)

$ErrorActionPreference = 'Stop'

$verify = Join-Path $PSScriptRoot 'Verify-UE5HTML5Exporter.ps1'
if (-not (Test-Path -LiteralPath $verify -PathType Leaf)) {
    throw "UE5HTML5Exporter certification tool was not found: $verify"
}

if ($LauncherCheck) {
    Write-Output 'UE5HTML5Exporter Windows certification launcher check passed.'
    return
}

Add-Type -AssemblyName System.Windows.Forms
if (-not $Project) {
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Choose the Unreal project to certify with UE5HTML5Exporter'
    $dialog.Filter = 'Unreal Engine projects (*.uproject)|*.uproject'
    $dialog.CheckFileExists = $true
    $dialog.Multiselect = $false
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        Write-Host 'UE5HTML5Exporter certification cancelled; no files were changed.'
        exit 2
    }
    $Project = $dialog.FileName
}

if (-not $PSBoundParameters.ContainsKey('Map')) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    $Map = [Microsoft.VisualBasic.Interaction]::InputBox(
        'Enter the Unreal content path of the map to export and certify.',
        'UE5HTML5Exporter map',
        $Map
    )
    if (-not $Map) {
        Write-Host 'UE5HTML5Exporter certification cancelled; no files were changed.'
        exit 2
    }
}

$projectPath = (Resolve-Path -LiteralPath $Project).Path
if ([System.IO.Path]::GetExtension($projectPath) -ne '.uproject') {
    throw "Expected a .uproject file: $projectPath"
}
if ($Map -notmatch '^/Game/') {
    throw "Map must be an Unreal content path beginning with /Game/: $Map"
}

$confirmation = [System.Windows.Forms.MessageBox]::Show(
    "This will build the Win64 plugin, back up any installed copy, install the new package, run the native Unreal FPS setup/Undo and Discord install-handoff tests, export $Map, and open the default browser to certify cold/warm asset loading, advisory runtime-ready/frame pacing, FPS shooting, score, depletion, and respawn.`n`nIf compatible Node.js is not already installed, the certifier can download a checksum-verified portable copy into your Windows user cache. It needs no administrator access and does not change system PATH.`n`nKeep the browser open until it reports PASS.`n`nContinue?",
    'Certify UE5HTML5Exporter for Win64',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
)
if ($confirmation -ne [System.Windows.Forms.DialogResult]::Yes) {
    Write-Host 'UE5HTML5Exporter certification cancelled; no files were changed.'
    exit 2
}

$stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
$packagePath = Join-Path ([System.IO.Path]::GetTempPath()) "UE5HTML5Exporter-Win64-$stamp"
$projectDirectory = Split-Path -Parent $projectPath
$exportPath = Join-Path $projectDirectory "Saved\UE5HTML5Certification\$stamp"
$arguments = @{
    Project = $projectPath
    Map = $Map
    PackageOutput = $packagePath
    ExportOutput = $exportPath
    CertifyBrowser = $true
}
if ($Plugin) { $arguments.Plugin = $Plugin }
if ($EngineRoot) { $arguments.EngineRoot = $EngineRoot }
if ($LauncherManifest) { $arguments.LauncherManifest = $LauncherManifest }
if ($VsWhere) { $arguments.VsWhere = $VsWhere }

& $verify @arguments
if ($LASTEXITCODE -ne 0) {
    throw "UE5HTML5Exporter certification failed with status $LASTEXITCODE."
}

$reportPath = Join-Path $exportPath 'workstation-certification.json'
if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw "Certification finished without producing its evidence report: $reportPath"
}

[System.Windows.Forms.MessageBox]::Show(
    "Win64, native editor suite, and browser FPS certification passed.`n`nEvidence: $reportPath",
    'UE5HTML5Exporter certification complete',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
) | Out-Null

if (-not $NoOpen) {
    Start-Process -FilePath $exportPath
}
