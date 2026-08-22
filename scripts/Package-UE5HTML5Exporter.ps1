[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$EngineRoot,

    [ValidateSet('Win64', 'Mac', 'Linux')]
    [string[]]$Platform = @('Win64'),

    [string]$Plugin = (Join-Path $PSScriptRoot '..\UE5HTML5Exporter\UE5HTML5Exporter.uplugin'),

    [Parameter(Mandatory = $true)]
    [string]$Output,

    [switch]$Replace
)

$ErrorActionPreference = 'Stop'

$enginePath = (Resolve-Path -LiteralPath $EngineRoot).Path
$pluginPath = (Resolve-Path -LiteralPath $Plugin).Path
$runUat = Join-Path $enginePath 'Engine\Build\BatchFiles\RunUAT.bat'
if (-not (Test-Path -LiteralPath $runUat -PathType Leaf)) {
    throw "Unreal Automation Tool was not found: $runUat"
}

$outputPath = [System.IO.Path]::GetFullPath($Output)
$backup = $null
if (Test-Path -LiteralPath $outputPath) {
    if (-not $Replace) {
        throw "Package output already exists at $outputPath. Re-run with -Replace to back it up."
    }
    $stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
    $backup = "$outputPath.backup-$stamp"
    Move-Item -LiteralPath $outputPath -Destination $backup
}

$targetPlatforms = $Platform -join '+'
& $runUat BuildPlugin "-Plugin=$pluginPath" "-Package=$outputPath" "-TargetPlatforms=$targetPlatforms" -Rocket
if ($LASTEXITCODE -ne 0) {
    throw "Unreal BuildPlugin exited with status $LASTEXITCODE."
}

Write-Host "Packaged UE5HTML5Exporter for $($Platform -join ', ') at $outputPath"
if ($backup) {
    Write-Host "Previous package backed up to $backup"
}
