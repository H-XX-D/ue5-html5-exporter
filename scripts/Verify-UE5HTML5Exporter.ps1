[CmdletBinding()]
param(
    [string]$EngineRoot,

    [string]$LauncherManifest,

    [string]$VsWhere,

    [Parameter(Mandatory = $true)]
    [string]$Project,

    [Parameter(Mandatory = $true)]
    [string]$Map,

    [string]$Plugin,

    [string]$PackageOutput,

    [string]$ExportOutput,

    [string]$SourceCommit,

    [string]$SourceRef,

    [string]$Repository,

    [string]$PluginPackageArtifact = 'UE5HTML5Exporter-Win64',

    [string]$ExportArtifact = 'UE5HTML5Exporter-Certified-Export'
)

$ErrorActionPreference = 'Stop'

if (-not $Plugin) { $Plugin = Join-Path $PSScriptRoot '..\UE5HTML5Exporter\UE5HTML5Exporter.uplugin' }

$module = Join-Path $PSScriptRoot 'UE5HTML5Tools.psm1'
if (-not (Test-Path -LiteralPath $module -PathType Leaf)) {
    throw "Windows tooling module was not found: $module"
}
Import-Module $module -Force
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sourceRevisionFile = Join-Path $repositoryRoot 'source-revision.json'
$source = Resolve-UE5HTML5CertificationSource `
    -SourceCommit $SourceCommit `
    -SourceRef $SourceRef `
    -Repository $Repository `
    -SourceRevisionFile $sourceRevisionFile `
    -RepositoryRoot $repositoryRoot

$projectPath = (Resolve-Path -LiteralPath $Project).Path
if ([System.IO.Path]::GetExtension($projectPath) -ne '.uproject') {
    throw "Expected a .uproject file: $projectPath"
}
$projectDescriptor = Get-Content -LiteralPath $projectPath -Raw | ConvertFrom-Json
$engineAssociation = [string]$projectDescriptor.EngineAssociation
$workstationParameters = @{ RequireVisualStudio = $true; RequireNode = $true }
if ($EngineRoot) { $workstationParameters.EngineRoot = $EngineRoot }
if ($LauncherManifest) { $workstationParameters.LauncherManifest = $LauncherManifest }
if ($VsWhere) { $workstationParameters.VsWhere = $VsWhere }
if ($engineAssociation) { $workstationParameters.EngineAssociation = $engineAssociation }
$workstation = Get-UE5HTML5WorkstationReport @workstationParameters
if (-not $workstation.ready) {
    throw "Windows workstation is not ready:`n- $($workstation.blockers -join "`n- ")"
}
$enginePath = $workstation.engineRoot
$pluginPath = (Resolve-Path -LiteralPath $Plugin).Path
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
$manifestPath = Join-Path $exportPath 'export-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Export manifest was not found after preflight: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$compatibility = $manifest.blueprintCompatibility
if (-not $compatibility) {
    throw 'Export manifest does not contain Blueprint compatibility evidence.'
}
$unsupportedBlueprintNodes = [int]$compatibility.unsupportedNodeCount
$unrealExportStatus = if ($unsupportedBlueprintNodes -gt 0) { 'passed-with-blueprint-adapters-required' } else { 'passed' }
$packageInventory = Get-UE5HTML5DirectoryInventory -Root $packagePath
$exportInventory = Get-UE5HTML5DirectoryInventory -Root $exportPath -Exclude @(
    'workstation-certification.json',
    'workstation-certification.sha256'
)
$environmentKind = if (${env:GITHUB_ACTIONS} -eq 'true') { 'github-actions-self-hosted' } else { 'local-windows-workstation' }
$report = [ordered]@{
    schema = 'ue5-html5-workstation-certification/v2'
    verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
    source = $source
    execution = [ordered]@{
        environment = $environmentKind
        githubRunId = if (${env:GITHUB_RUN_ID}) { ${env:GITHUB_RUN_ID} } else { $null }
        githubRunAttempt = if (${env:GITHUB_RUN_ATTEMPT}) { ${env:GITHUB_RUN_ATTEMPT} } else { $null }
    }
    platform = 'Win64'
    exporterVersion = $descriptor.VersionName
    engineVersion = $workstation.engineVersion
    visualStudioVersion = $workstation.visualStudio.version
    windowsSdkVersion = $workstation.windowsSdkVersion
    nodeVersion = $workstation.nodeVersion
    projectFile = [System.IO.Path]::GetFileName($projectPath)
    map = $Map
    pluginPackageArtifact = $PluginPackageArtifact
    exportArtifact = $ExportArtifact
    pluginPackage = [ordered]@{
        artifact = $PluginPackageArtifact
        inventory = $packageInventory
    }
    exportedGame = [ordered]@{
        artifact = $ExportArtifact
        inventory = $exportInventory
    }
    readiness = 'passed'
    unrealExport = $unrealExportStatus
    blueprintCompatibility = [ordered]@{
        status = [string]$compatibility.status
        blueprintCount = [int]$compatibility.blueprintCount
        nodeCount = [int]$compatibility.nodeCount
        supportedNodeCount = [int]$compatibility.supportedNodeCount
        unsupportedNodeCount = $unsupportedBlueprintNodes
        details = 'logic/blueprints.json'
    }
    activityPackagePreflight = 'passed'
    privacy = [ordered]@{
        credentialsAccessed = $false
        personalPlayerDataCollected = $false
        scope = 'native plugin build, readiness, export, and package preflight only'
    }
}
$reportPath = Join-Path $exportPath 'workstation-certification.json'
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
$reportHash = (Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()
$reportChecksumPath = Join-Path $exportPath 'workstation-certification.sha256'
"$reportHash  workstation-certification.json" | Set-Content -LiteralPath $reportChecksumPath -Encoding ascii

Write-Host "UE5HTML5Exporter Win64 workstation certification passed."
if ($unsupportedBlueprintNodes -gt 0) {
    Write-Warning "$unsupportedBlueprintNodes Blueprint node(s) require adapters; certification records the partial gameplay compatibility explicitly."
}
Write-Host "Plugin package: $packagePath"
Write-Host "Verified export: $exportPath"
Write-Host "Report: $reportPath"
Write-Host "Report SHA-256: $reportHash"
