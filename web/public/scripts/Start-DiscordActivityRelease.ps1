[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PathFile,

    [switch]$ForcePortableNode,

    [string]$CacheRoot,

    [string]$ReportFile
)

$ErrorActionPreference = 'Stop'

$MinimumNodeVersion = [version]'22.12.0'
$PinnedNodeVersion = '22.23.2'
# Pinned from https://nodejs.org/dist/v22.23.2/SHASUMS256.txt.
$NodeChecksums = @{
    'arm64' = 'fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3'
    'x64' = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'
}
$NodeExecutableChecksums = @{
    'arm64' = '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878'
    'x64' = '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4'
}
$script:ResolvedNodeSource = $null
$script:ResolvedNodeVersion = $null
$script:ResolvedNodeArchiveSha256 = $null
$script:ResolvedNodeExecutableSha256 = $null

function Get-CompatibleNodeVersion {
    param([Parameter(Mandatory = $true)][string]$Executable)

    try {
        $raw = (& $Executable --version 2>$null).Trim().TrimStart('v')
        if ($LASTEXITCODE -ne 0) { return $null }
        $parsed = $null
        if (-not [version]::TryParse($raw, [ref]$parsed)) { return $null }
        if ($parsed -lt $MinimumNodeVersion) { return $null }
        return $parsed
    }
    catch { return $null }
}

function Get-WindowsNodeArchitecture {
    $architecture = if (${env:PROCESSOR_ARCHITEW6432}) {
        ${env:PROCESSOR_ARCHITEW6432}
    }
    else {
        ${env:PROCESSOR_ARCHITECTURE}
    }
    switch -Regex ($architecture) {
        '^(?:AMD64|x64)$' { return 'x64' }
        '^(?:ARM64|AARCH64)$' { return 'arm64' }
        default { throw "UE5HTML5Exporter supports the Discord release runtime on Windows x64 and ARM64; found '$architecture'." }
    }
}

function Get-VerifiedPortableNode {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$Architecture
    )

    $manifestPath = Join-Path $InstallRoot 'ue5html5-node-runtime.json'
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or
        -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        return $null
    }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ([string]$manifest.schema -ne 'ue5-html5-node-runtime/v1' -or
            [string]$manifest.nodeVersion -ne $PinnedNodeVersion -or
            [string]$manifest.architecture -ne $Architecture -or
            [string]$manifest.archiveSha256 -ne $NodeChecksums[$Architecture] -or
            [string]$manifest.executableSha256 -ne $NodeExecutableChecksums[$Architecture]) {
            return $null
        }
        $actualExecutableHash = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualExecutableHash -ne $NodeExecutableChecksums[$Architecture]) { return $null }
        $version = Get-CompatibleNodeVersion -Executable $Executable
        if (-not $version -or $version.ToString() -ne $PinnedNodeVersion) { return $null }
        return [pscustomobject]@{
            version = $version
            archiveSha256 = [string]$manifest.archiveSha256
            executableSha256 = $actualExecutableHash
        }
    }
    catch { return $null }
}

function Resolve-UE5HTML5Node {
    if (-not $ForcePortableNode) {
        $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($systemNode) {
            $systemVersion = Get-CompatibleNodeVersion -Executable $systemNode.Source
            if ($systemVersion) {
                Write-Host "Using system Node.js $systemVersion."
                $script:ResolvedNodeSource = 'system'
                $script:ResolvedNodeVersion = $systemVersion
                return $systemNode.Source
            }
        }
    }

    $architecture = Get-WindowsNodeArchitecture
    $nodeCacheRoot = $CacheRoot
    if (-not $nodeCacheRoot) {
        $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
        if (-not $localAppData) { throw 'Windows Local AppData could not be resolved for the private tool cache.' }
        $nodeCacheRoot = Join-Path $localAppData 'UE5HTML5Exporter\Node'
    }
    else {
        $nodeCacheRoot = [System.IO.Path]::GetFullPath($nodeCacheRoot)
    }
    $archiveName = "node-v$PinnedNodeVersion-win-$architecture.zip"
    $installRoot = Join-Path $nodeCacheRoot "v$PinnedNodeVersion\$architecture"
    $localNode = Join-Path $installRoot 'node.exe'
    $cachedNode = Get-VerifiedPortableNode -Executable $localNode -InstallRoot $installRoot -Architecture $architecture
    if ($cachedNode) {
        Write-Host "Using verified local Node.js $PinnedNodeVersion."
        $script:ResolvedNodeSource = 'verified-portable-cache'
        $script:ResolvedNodeVersion = $cachedNode.version
        $script:ResolvedNodeArchiveSha256 = $cachedNode.archiveSha256
        $script:ResolvedNodeExecutableSha256 = $cachedNode.executableSha256
        return $localNode
    }

    if (-not $ForcePortableNode -and (${env:CI} -or ${env:UE5_ACTIVITY_NO_NODE_BOOTSTRAP} -eq '1')) {
        throw "Node.js $MinimumNodeVersion or newer was not found. Install Node.js 22 LTS or allow the interactive UE5HTML5Exporter bootstrap."
    }

    if (-not $ForcePortableNode) {
        Add-Type -AssemblyName System.Windows.Forms
        $choice = [System.Windows.Forms.MessageBox]::Show(
            "Discord Activity release needs Node.js $MinimumNodeVersion or newer.`n`nInstall a verified portable Node.js $PinnedNodeVersion copy in your Windows user profile?`n`nNo administrator access or system PATH change is required.",
            'Prepare Discord Activity release tools',
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question
        )
        if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
            throw 'Node.js setup was declined; no runtime was downloaded or installed.'
        }
    }

    $downloadUri = "https://nodejs.org/dist/v$PinnedNodeVersion/$archiveName"
    $expectedHash = $NodeChecksums[$architecture]
    $workRoot = Join-Path $nodeCacheRoot "bootstrap-$([Guid]::NewGuid().ToString('N'))"
    $archive = Join-Path $workRoot $archiveName
    $expanded = Join-Path $workRoot 'expanded'
    New-Item -ItemType Directory -Path $expanded -Force | Out-Null
    try {
        Write-Host "Downloading portable Node.js $PinnedNodeVersion from nodejs.org..."
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUri -OutFile $archive
        $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "Node.js archive checksum mismatch; expected $expectedHash but received $actualHash."
        }

        Expand-Archive -LiteralPath $archive -DestinationPath $expanded
        $payload = Join-Path $expanded "node-v$PinnedNodeVersion-win-$architecture"
        $payloadNode = Join-Path $payload 'node.exe'
        if (-not (Test-Path -LiteralPath $payloadNode -PathType Leaf)) {
            throw "Verified Node.js archive did not contain the expected executable: $payloadNode"
        }
        $executableHash = (Get-FileHash -LiteralPath $payloadNode -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($executableHash -ne $NodeExecutableChecksums[$architecture]) {
            throw "Node.js executable checksum mismatch; expected $($NodeExecutableChecksums[$architecture]) but received $executableHash."
        }
        [ordered]@{
            schema = 'ue5-html5-node-runtime/v1'
            nodeVersion = $PinnedNodeVersion
            architecture = $architecture
            archiveSha256 = $expectedHash
            executableSha256 = $executableHash
            sourceUrl = $downloadUri
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $payload 'ue5html5-node-runtime.json') -Encoding utf8

        $installParent = Split-Path -Parent $installRoot
        New-Item -ItemType Directory -Path $installParent -Force | Out-Null
        if (Test-Path -LiteralPath $installRoot) {
            $backup = "$installRoot.backup-$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ'))"
            Move-Item -LiteralPath $installRoot -Destination $backup
            Write-Host "Previous local runtime backed up to $backup"
        }
        Move-Item -LiteralPath $payload -Destination $installRoot
    }
    finally {
        if (Test-Path -LiteralPath $workRoot) {
            Remove-Item -LiteralPath $workRoot -Recurse -Force
        }
    }

    $installedNode = Get-VerifiedPortableNode -Executable $localNode -InstallRoot $installRoot -Architecture $architecture
    if (-not $installedNode) {
        throw "Portable Node.js installation did not produce a verified compatible runtime at $localNode"
    }
    $script:ResolvedNodeSource = 'verified-portable-download'
    $script:ResolvedNodeVersion = $installedNode.version
    $script:ResolvedNodeArchiveSha256 = $installedNode.archiveSha256
    $script:ResolvedNodeExecutableSha256 = $installedNode.executableSha256
    Write-Host "Portable Node.js $($installedNode.version) is ready in the UE5HTML5Exporter user cache."
    return $localNode
}

$node = Resolve-UE5HTML5Node
$resolvedPathFile = [System.IO.Path]::GetFullPath($PathFile)
$pathFileParent = Split-Path -Parent $resolvedPathFile
if ($pathFileParent) { New-Item -ItemType Directory -Path $pathFileParent -Force | Out-Null }
Set-Content -LiteralPath $resolvedPathFile -Value $node -Encoding ascii -NoNewline
if ($ReportFile) {
    $resolvedReportFile = [System.IO.Path]::GetFullPath($ReportFile)
    $reportParent = Split-Path -Parent $resolvedReportFile
    if ($reportParent) { New-Item -ItemType Directory -Path $reportParent -Force | Out-Null }
    [ordered]@{
        schema = 'ue5-html5-node-resolution/v1'
        version = $script:ResolvedNodeVersion.ToString()
        source = $script:ResolvedNodeSource
        managedByExporter = $script:ResolvedNodeSource -ne 'system'
        checksumVerified = $script:ResolvedNodeSource -ne 'system'
        archiveSha256 = if ($script:ResolvedNodeArchiveSha256) { $script:ResolvedNodeArchiveSha256 } else { $null }
        executableSha256 = if ($script:ResolvedNodeExecutableSha256) { $script:ResolvedNodeExecutableSha256 } else { $null }
        administratorRequired = $false
        systemPathChanged = $false
    } | ConvertTo-Json | Set-Content -LiteralPath $resolvedReportFile -Encoding utf8
}
