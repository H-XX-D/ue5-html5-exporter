[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PathFile
)

$ErrorActionPreference = 'Stop'

$MinimumNodeVersion = [version]'22.12.0'
$PinnedNodeVersion = '22.23.2'
# Pinned from https://nodejs.org/dist/v22.23.2/SHASUMS256.txt.
$NodeChecksums = @{
    'arm64' = 'fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3'
    'x64' = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'
}

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

function Resolve-UE5HTML5Node {
    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($systemNode) {
        $systemVersion = Get-CompatibleNodeVersion -Executable $systemNode.Source
        if ($systemVersion) {
            Write-Host "Using system Node.js $systemVersion."
            return $systemNode.Source
        }
    }

    $architecture = Get-WindowsNodeArchitecture
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $localAppData) { throw 'Windows Local AppData could not be resolved for the private tool cache.' }
    $cacheRoot = Join-Path $localAppData 'UE5HTML5Exporter\Node'
    $archiveName = "node-v$PinnedNodeVersion-win-$architecture.zip"
    $installRoot = Join-Path $cacheRoot "v$PinnedNodeVersion\$architecture"
    $localNode = Join-Path $installRoot 'node.exe'
    if ((Test-Path -LiteralPath $localNode -PathType Leaf) -and
        (Get-CompatibleNodeVersion -Executable $localNode)) {
        Write-Host "Using verified local Node.js $PinnedNodeVersion."
        return $localNode
    }

    if (${env:CI} -or ${env:UE5_ACTIVITY_NO_NODE_BOOTSTRAP} -eq '1') {
        throw "Node.js $MinimumNodeVersion or newer was not found. Install Node.js 22 LTS or allow the interactive UE5HTML5Exporter bootstrap."
    }

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

    $downloadUri = "https://nodejs.org/dist/v$PinnedNodeVersion/$archiveName"
    $expectedHash = $NodeChecksums[$architecture]
    $workRoot = Join-Path $cacheRoot "bootstrap-$([Guid]::NewGuid().ToString('N'))"
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

    $installedVersion = Get-CompatibleNodeVersion -Executable $localNode
    if (-not $installedVersion) {
        throw "Portable Node.js installation did not produce a compatible runtime at $localNode"
    }
    Write-Host "Portable Node.js $installedVersion is ready in the UE5HTML5Exporter user cache."
    return $localNode
}

$node = Resolve-UE5HTML5Node
$resolvedPathFile = [System.IO.Path]::GetFullPath($PathFile)
$pathFileParent = Split-Path -Parent $resolvedPathFile
if ($pathFileParent) { New-Item -ItemType Directory -Path $pathFileParent -Force | Out-Null }
Set-Content -LiteralPath $resolvedPathFile -Value $node -Encoding ascii -NoNewline
