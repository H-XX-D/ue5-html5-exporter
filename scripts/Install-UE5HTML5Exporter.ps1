[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Project,

    [string]$Plugin = (Join-Path $PSScriptRoot '..\UE5HTML5Exporter'),

    [switch]$SourceOnly,

    [switch]$Replace
)

$ErrorActionPreference = 'Stop'

$projectPath = (Resolve-Path -LiteralPath $Project).Path
$pluginPath = (Resolve-Path -LiteralPath $Plugin).Path
if ([System.IO.Path]::GetExtension($projectPath) -ne '.uproject') {
    throw "Expected a .uproject file: $projectPath"
}

$descriptor = Join-Path $pluginPath 'UE5HTML5Exporter.uplugin'
if (-not (Test-Path -LiteralPath $descriptor -PathType Leaf)) {
    throw "Plugin descriptor was not found: $descriptor"
}

$projectDirectory = Split-Path -Parent $projectPath
$pluginsDirectory = Join-Path $projectDirectory 'Plugins'
$destination = Join-Path $pluginsDirectory 'UE5HTML5Exporter'
$backup = $null

if (Test-Path -LiteralPath $destination) {
    if (-not $Replace) {
        throw "Plugin already exists at $destination. Re-run with -Replace to back it up."
    }
    $backupDirectory = Join-Path $projectDirectory '.ue5html5-backups'
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
    $backup = Join-Path $backupDirectory "UE5HTML5Exporter-$stamp"
    Move-Item -LiteralPath $destination -Destination $backup
}

try {
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem -LiteralPath $pluginPath -Force | Where-Object {
        $_.Name -ne 'Intermediate' -and
        $_.Name -ne '.DS_Store' -and
        (-not $SourceOnly -or $_.Name -ne 'Binaries')
    } | Copy-Item -Destination $destination -Recurse -Force
}
catch {
    if ($backup -and -not (Test-Path -LiteralPath $destination)) {
        Move-Item -LiteralPath $backup -Destination $destination
    }
    throw
}

Write-Host "Installed UE5HTML5Exporter to $destination"
if ($backup) {
    Write-Host "Previous installation backed up to $backup"
}
if ($SourceOnly) {
    Write-Host 'Open the project and allow Unreal Build Tool to compile the plugin for this machine.'
}
