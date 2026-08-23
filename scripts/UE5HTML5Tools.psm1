Set-StrictMode -Version Latest

function Test-UE5EngineRoot {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    $runUat = Join-Path $Path 'Engine\Build\BatchFiles\RunUAT.bat'
    $editor = Join-Path $Path 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe'
    return (Test-Path -LiteralPath $runUat -PathType Leaf) -and
        (Test-Path -LiteralPath $editor -PathType Leaf)
}

function Get-UE5EngineVersion {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$EngineRoot)

    $buildVersion = Join-Path $EngineRoot 'Engine\Build\Build.version'
    if (Test-Path -LiteralPath $buildVersion -PathType Leaf) {
        try {
            $metadata = Get-Content -LiteralPath $buildVersion -Raw | ConvertFrom-Json
            return [version]::new(
                [int]$metadata.MajorVersion,
                [int]$metadata.MinorVersion,
                [int]$metadata.PatchVersion
            )
        }
        catch {
            throw "Unreal Build.version is invalid: $buildVersion ($($_.Exception.Message))"
        }
    }

    $directoryName = Split-Path -Leaf $EngineRoot
    if ($directoryName -match '^UE_(\d+)\.(\d+)(?:\.(\d+))?') {
        $patch = if ($Matches.ContainsKey(3) -and $Matches[3]) { [int]$Matches[3] } else { 0 }
        return [version]::new([int]$Matches[1], [int]$Matches[2], $patch)
    }
    throw "Could not determine the Unreal version at $EngineRoot."
}

function Get-UE5LauncherInstallations {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$LauncherManifest)

    if (-not (Test-Path -LiteralPath $LauncherManifest -PathType Leaf)) { return @() }
    try {
        $manifest = Get-Content -LiteralPath $LauncherManifest -Raw | ConvertFrom-Json
    }
    catch {
        throw "Epic Launcher installation manifest is invalid: $LauncherManifest ($($_.Exception.Message))"
    }

    $installations = @()
    foreach ($entry in @($manifest.InstallationList)) {
        if ($null -eq $entry) { continue }
        if ([string]$entry.AppName -notmatch '^UE_\d+\.\d+') { continue }
        $path = [string]$entry.InstallLocation
        if (-not (Test-UE5EngineRoot -Path $path)) { continue }
        $installations += [pscustomobject]@{
            AppName = [string]$entry.AppName
            AppVersion = [string]$entry.AppVersion
            EngineRoot = (Resolve-Path -LiteralPath $path).Path
            EngineVersion = Get-UE5EngineVersion -EngineRoot $path
            Source = 'EpicLauncher'
        }
    }
    return $installations
}

function Resolve-UE5EngineRoot {
    [CmdletBinding()]
    param(
        [string]$EngineRoot,
        [string]$LauncherManifest,
        [string]$EngineAssociation
    )

    if ($EngineRoot) {
        $resolved = (Resolve-Path -LiteralPath $EngineRoot -ErrorAction Stop).Path
        if (-not (Test-UE5EngineRoot -Path $resolved)) {
            throw "Unreal Automation Tool or UnrealEditor-Cmd.exe was not found under: $resolved"
        }
        return $resolved
    }

    if (-not $LauncherManifest) {
        $commonData = [Environment]::GetFolderPath('CommonApplicationData')
        if ($commonData) {
            $LauncherManifest = Join-Path $commonData 'Epic\UnrealEngineLauncher\LauncherInstalled.dat'
        }
    }

    $candidates = @()
    if ($LauncherManifest) {
        $candidates += Get-UE5LauncherInstallations -LauncherManifest $LauncherManifest
    }

    $programRoots = @()
    if (${env:ProgramW6432}) { $programRoots += (Join-Path ${env:ProgramW6432} 'Epic Games') }
    if (${env:ProgramFiles}) { $programRoots += (Join-Path ${env:ProgramFiles} 'Epic Games') }
    foreach ($root in ($programRoots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($directory in @(Get-ChildItem -LiteralPath $root -Directory -Filter 'UE_*' -ErrorAction SilentlyContinue)) {
            if (-not (Test-UE5EngineRoot -Path $directory.FullName)) { continue }
            $candidates += [pscustomobject]@{
                AppName = $directory.Name
                AppVersion = ''
                EngineRoot = $directory.FullName
                EngineVersion = Get-UE5EngineVersion -EngineRoot $directory.FullName
                Source = 'CommonInstallPath'
            }
        }
    }

    if ($EngineAssociation -match '^(?:UE_)?(\d+)\.(\d+)') {
        $associationMajor = [int]$Matches[1]
        $associationMinor = [int]$Matches[2]
        $candidates = @($candidates | Where-Object {
            $_.EngineVersion.Major -eq $associationMajor -and $_.EngineVersion.Minor -eq $associationMinor
        })
        if ($candidates.Count -eq 0) {
            throw "The project requests Unreal Engine $associationMajor.$associationMinor, but no matching installation was found. Pass -EngineRoot only when intentionally upgrading the project."
        }
    }

    $selected = $candidates |
        Sort-Object -Property @{ Expression = { $_.EngineVersion }; Descending = $true } |
        Select-Object -First 1
    if ($null -eq $selected) {
        throw 'No compatible Unreal Engine installation was found. Install UE through Epic Games Launcher or pass -EngineRoot.'
    }
    return $selected.EngineRoot
}

function Get-UE5VisualStudioInstallation {
    [CmdletBinding()]
    param([string]$VsWhere)

    if (-not $VsWhere) {
        $installerRoot = ${env:ProgramFiles(x86)}
        if ($installerRoot) {
            $candidate = Join-Path $installerRoot 'Microsoft Visual Studio\Installer\vswhere.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $VsWhere = $candidate }
        }
    }
    if (-not $VsWhere) {
        $command = Get-Command vswhere.exe -ErrorAction SilentlyContinue
        if ($command) { $VsWhere = $command.Source }
    }
    if (-not $VsWhere -or -not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) { return $null }

    $json = & $VsWhere -latest -products '*' -requires Microsoft.VisualStudio.Workload.NativeGame -format json -utf8
    if ($LASTEXITCODE -ne 0) { throw "vswhere exited with status $LASTEXITCODE." }
    if (-not $json) { return $null }
    $installations = @($json | Out-String | ConvertFrom-Json)
    if ($installations.Count -eq 0) { return $null }
    return $installations[0]
}

function Test-UE5VisualStudioCompatibility {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][version]$EngineVersion,
        [Parameter(Mandatory = $true)][version]$VisualStudioVersion
    )

    if ($EngineVersion.Major -ne 5) { return $false }
    if ($EngineVersion.Minor -ge 8) {
        return $VisualStudioVersion -ge [version]'18.0' -or
            ($VisualStudioVersion -ge [version]'17.14' -and $VisualStudioVersion -lt [version]'18.0')
    }
    if ($EngineVersion.Minor -ge 5) { return $VisualStudioVersion -ge [version]'17.8' }
    if ($EngineVersion.Minor -ge 3) { return $VisualStudioVersion -ge [version]'17.4' }
    return $VisualStudioVersion -ge [version]'17.0'
}

function Get-UE5WindowsSdkVersion {
    [CmdletBinding()]
    param()

    $programFilesX86 = ${env:ProgramFiles(x86)}
    if (-not $programFilesX86) { return $null }
    $sdkLib = Join-Path $programFilesX86 'Windows Kits\10\Lib'
    if (-not (Test-Path -LiteralPath $sdkLib -PathType Container)) { return $null }
    $versions = @()
    foreach ($directory in @(Get-ChildItem -LiteralPath $sdkLib -Directory -ErrorAction SilentlyContinue)) {
        $parsed = $null
        if ([version]::TryParse($directory.Name, [ref]$parsed)) { $versions += $parsed }
    }
    return $versions | Sort-Object -Descending | Select-Object -First 1
}

function Get-UE5HTML5WorkstationReport {
    [CmdletBinding()]
    param(
        [string]$EngineRoot,
        [string]$LauncherManifest,
        [string]$EngineAssociation,
        [string]$VsWhere,
        [switch]$RequireVisualStudio,
        [switch]$RequireNode,
        [AllowNull()][object]$VisualStudioInstallation,
        [AllowNull()][version]$WindowsSdkVersion,
        [AllowNull()][version]$NodeVersion
    )

    $blockers = [System.Collections.Generic.List[string]]::new()
    $warnings = [System.Collections.Generic.List[string]]::new()
    $enginePath = $null
    $engineVersion = $null
    try {
        $resolver = @{}
        if ($EngineRoot) { $resolver.EngineRoot = $EngineRoot }
        if ($LauncherManifest) { $resolver.LauncherManifest = $LauncherManifest }
        if ($EngineAssociation) { $resolver.EngineAssociation = $EngineAssociation }
        $enginePath = Resolve-UE5EngineRoot @resolver
        $engineVersion = Get-UE5EngineVersion -EngineRoot $enginePath
        if ($engineVersion.Major -ne 5 -or $engineVersion.Minor -lt 3) {
            $blockers.Add("UE5HTML5Exporter requires Unreal Engine 5.3 or newer; found $engineVersion.")
        }
    }
    catch {
        $blockers.Add($_.Exception.Message)
    }

    $visualStudio = $VisualStudioInstallation
    if ($RequireVisualStudio) {
        if ($null -eq $visualStudio) { $visualStudio = Get-UE5VisualStudioInstallation -VsWhere $VsWhere }
        if ($null -eq $visualStudio) {
            $blockers.Add('Visual Studio with the Game development with C++ workload was not found.')
        }
        elseif ($null -ne $engineVersion) {
            $vsVersion = [version]([string]$visualStudio.installationVersion)
            if (-not (Test-UE5VisualStudioCompatibility -EngineVersion $engineVersion -VisualStudioVersion $vsVersion)) {
                $blockers.Add("Visual Studio $vsVersion is not supported by Unreal Engine $engineVersion. UE 5.8 requires VS 2022 17.14+ or VS 2026 18.0+.")
            }
        }

        if ($null -eq $WindowsSdkVersion) { $WindowsSdkVersion = Get-UE5WindowsSdkVersion }
        $minimumSdk = if ($null -ne $engineVersion -and $engineVersion.Minor -ge 8) {
            [version]'10.0.22621.0'
        }
        else {
            [version]'10.0.18362.0'
        }
        if ($null -eq $WindowsSdkVersion) {
            $blockers.Add("Windows SDK $minimumSdk or newer was not found.")
        }
        elseif ($WindowsSdkVersion -lt $minimumSdk) {
            $blockers.Add("Windows SDK $WindowsSdkVersion is too old; Unreal Engine $engineVersion requires $minimumSdk or newer.")
        }
    }

    if ($RequireNode) {
        if ($null -eq $NodeVersion) {
            $node = Get-Command node -ErrorAction SilentlyContinue
            if ($node) {
                $rawVersion = (& $node.Source --version).TrimStart('v')
                $NodeVersion = [version]$rawVersion
            }
        }
        if ($null -eq $NodeVersion) {
            $blockers.Add('Node.js 22.12 or newer was not found.')
        }
        elseif ($NodeVersion -lt [version]'22.12') {
            $blockers.Add("Node.js $NodeVersion is too old; 22.12 or newer is required.")
        }
    }

    if ($null -ne $engineVersion -and $engineVersion.Minor -ge 8 -and
        $null -ne $visualStudio -and [version]([string]$visualStudio.installationVersion) -lt [version]'18.0') {
        $warnings.Add('Epic recommends Visual Studio 2026 for general UE 5.8 development; VS 2022 17.14+ remains supported.')
    }

    return [pscustomobject]@{
        schema = 'ue5-html5-windows-workstation/v1'
        ready = $blockers.Count -eq 0
        engineRoot = $enginePath
        engineVersion = if ($null -ne $engineVersion) { $engineVersion.ToString() } else { $null }
        engineAssociation = if ($EngineAssociation) { $EngineAssociation } else { $null }
        visualStudio = if ($null -ne $visualStudio) {
            [pscustomobject]@{
                displayName = [string]$visualStudio.displayName
                version = [string]$visualStudio.installationVersion
                installationPath = [string]$visualStudio.installationPath
            }
        }
        else { $null }
        windowsSdkVersion = if ($null -ne $WindowsSdkVersion) { $WindowsSdkVersion.ToString() } else { $null }
        nodeVersion = if ($null -ne $NodeVersion) { $NodeVersion.ToString() } else { $null }
        blockers = @($blockers)
        warnings = @($warnings)
    }
}

function Get-UE5HTML5DirectoryInventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string[]]$Exclude = @()
    )

    $rootPath = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
        throw "Inventory root is not a directory: $rootPath"
    }

    $excluded = @{}
    foreach ($entry in $Exclude) {
        if (-not $entry) { continue }
        $normalized = $entry.Replace('\', '/').TrimStart('/')
        $excluded[$normalized] = $true
    }

    $files = @()
    [Int64]$totalBytes = 0
    $children = @(Get-ChildItem -LiteralPath $rootPath -File -Recurse -Force | Sort-Object -Property FullName)
    foreach ($file in $children) {
        $relative = $file.FullName.Substring($rootPath.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
        if ($excluded.ContainsKey($relative)) { continue }
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $length = [Int64]$file.Length
        $totalBytes += $length
        $files += [pscustomobject][ordered]@{
            path = $relative
            bytes = $length
            sha256 = $hash
        }
    }

    $canonicalLines = @($files | ForEach-Object { "$($_.sha256) $($_.bytes) $($_.path)" })
    $canonical = if ($canonicalLines.Count -gt 0) { ($canonicalLines -join "`n") + "`n" } else { '' }
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digestBytes = $algorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($canonical))
    }
    finally {
        $algorithm.Dispose()
    }
    $digest = ([System.BitConverter]::ToString($digestBytes)).Replace('-', '').ToLowerInvariant()

    return [pscustomobject][ordered]@{
        schema = 'ue5-html5-directory-inventory/v1'
        algorithm = 'sha256'
        canonicalFormat = '<sha256> <bytes> <forward-slash-relative-path> LF'
        fileCount = $files.Count
        totalBytes = $totalBytes
        sha256 = $digest
        files = $files
    }
}

function Resolve-UE5HTML5CertificationSource {
    [CmdletBinding()]
    param(
        [string]$SourceCommit,
        [string]$SourceRef,
        [string]$Repository,
        [string]$SourceRevisionFile,
        [string]$RepositoryRoot
    )

    $packagedRevision = $null
    if ($SourceRevisionFile -and (Test-Path -LiteralPath $SourceRevisionFile -PathType Leaf)) {
        try {
            $packagedRevision = Get-Content -LiteralPath $SourceRevisionFile -Raw | ConvertFrom-Json
        }
        catch {
            throw "Source revision metadata is invalid: $SourceRevisionFile ($($_.Exception.Message))"
        }
        if ([string]$packagedRevision.schema -ne 'ue5-html5-source-revision/v1') {
            throw "Source revision metadata has an unsupported schema: $SourceRevisionFile"
        }
    }

    $git = Get-Command git -ErrorAction SilentlyContinue
    $gitAvailable = $null -ne $git -and $RepositoryRoot -and
        (Test-Path -LiteralPath (Join-Path $RepositoryRoot '.git'))
    $gitCommit = $null
    if ($gitAvailable) {
        $gitCommit = (& $git.Source -C $RepositoryRoot rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Git could not resolve the source commit for $RepositoryRoot." }
    }

    if (-not $SourceCommit -and ${env:GITHUB_SHA}) { $SourceCommit = ${env:GITHUB_SHA} }
    if (-not $SourceCommit -and $packagedRevision) { $SourceCommit = [string]$packagedRevision.commit }
    if (-not $SourceCommit -and $gitCommit) { $SourceCommit = $gitCommit }
    if ($SourceCommit -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'Win64 certification requires an exact 40-character source commit from a clean Git checkout or generated source bundle.'
    }
    $SourceCommit = $SourceCommit.ToLowerInvariant()

    $cleanEvidence = $false
    if ($packagedRevision) {
        $packagedCommit = [string]$packagedRevision.commit
        $hasDirtyFlag = $packagedRevision.PSObject.Properties.Name -contains 'dirty'
        if ($packagedCommit -notmatch '^[0-9a-fA-F]{40}$' -or
            -not $hasDirtyFlag -or
            -not ($packagedRevision.dirty -is [bool]) -or
            $packagedRevision.dirty) {
            throw 'The source bundle does not prove an exact clean commit and cannot produce release-grade Win64 certification.'
        }
        if ($packagedCommit.ToLowerInvariant() -ne $SourceCommit) {
            throw "The requested source commit $SourceCommit does not match source-revision.json commit $($packagedCommit.ToLowerInvariant())."
        }
        $cleanEvidence = $true
    }
    if ($gitAvailable) {
        $gitStatus = (& $git.Source -C $RepositoryRoot status --porcelain | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Git could not verify source cleanliness for $RepositoryRoot." }
        if ($gitStatus) {
            throw "Win64 certification requires a clean source checkout; uncommitted files were detected:`n$gitStatus"
        }
        if ($gitCommit.ToLowerInvariant() -ne $SourceCommit) {
            throw "The requested source commit $SourceCommit does not match checkout commit $($gitCommit.ToLowerInvariant())."
        }
        $cleanEvidence = $true
    }
    if (-not $cleanEvidence) {
        throw 'Win64 certification could not prove that its source files match a clean commit.'
    }

    if (-not $SourceRef -and ${env:GITHUB_REF}) { $SourceRef = ${env:GITHUB_REF} }
    if (-not $SourceRef -and $packagedRevision) { $SourceRef = [string]$packagedRevision.ref }
    if (-not $SourceRef -and $gitAvailable) {
        $SourceRef = (& $git.Source -C $RepositoryRoot symbolic-ref --quiet --short HEAD 2>$null | Out-String).Trim()
    }
    if (-not $Repository -and ${env:GITHUB_REPOSITORY}) { $Repository = ${env:GITHUB_REPOSITORY} }

    return [pscustomobject][ordered]@{
        commit = $SourceCommit
        ref = if ($SourceRef) { $SourceRef } else { $null }
        repository = if ($Repository) { $Repository } else { $null }
        clean = $true
        evidence = if ($gitAvailable) { 'git-checkout' } else { 'source-bundle-metadata' }
        releaseGradeSourceProof = [bool]$gitAvailable
    }
}

Export-ModuleMember -Function @(
    'Test-UE5EngineRoot',
    'Get-UE5EngineVersion',
    'Get-UE5LauncherInstallations',
    'Resolve-UE5EngineRoot',
    'Get-UE5VisualStudioInstallation',
    'Test-UE5VisualStudioCompatibility',
    'Get-UE5WindowsSdkVersion',
    'Get-UE5HTML5WorkstationReport',
    'Get-UE5HTML5DirectoryInventory',
    'Resolve-UE5HTML5CertificationSource'
)
