[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$module = Join-Path $PSScriptRoot 'UE5HTML5Tools.psm1'
Import-Module $module -Force

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    try {
        & $Action
    }
    catch {
        Assert-True ($_.Exception.Message -match $Pattern) "$Message (actual: $($_.Exception.Message))"
        return
    }
    throw "Assertion failed: $Message (no exception was thrown)"
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ue5html5-windows-tooling-$([Guid]::NewGuid().ToString('N'))"
try {
    $engine57 = Join-Path $testRoot 'UE_5.7'
    $engine58 = Join-Path $testRoot 'UE_5.8'
    foreach ($engine in @($engine57, $engine58)) {
        New-Item -ItemType Directory -Path (Join-Path $engine 'Engine\Build\BatchFiles') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $engine 'Engine\Binaries\Win64') -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $engine 'Engine\Build\BatchFiles\RunUAT.bat') -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $engine 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe') -Force | Out-Null
    }
    @{ MajorVersion = 5; MinorVersion = 7; PatchVersion = 2 } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $engine57 'Engine\Build\Build.version') -Encoding utf8
    @{ MajorVersion = 5; MinorVersion = 8; PatchVersion = 1 } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $engine58 'Engine\Build\Build.version') -Encoding utf8

    $manifest = Join-Path $testRoot 'LauncherInstalled.dat'
    @{
        InstallationList = @(
            @{ AppName = 'UE_5.7'; AppVersion = '5.7.2'; InstallLocation = $engine57 },
            @{ AppName = 'UE_5.8'; AppVersion = '5.8.1'; InstallLocation = $engine58 }
        )
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifest -Encoding utf8

    $resolved = Resolve-UE5EngineRoot -LauncherManifest $manifest
    Assert-True ($resolved -eq (Resolve-Path -LiteralPath $engine58).Path) 'launcher discovery must select the newest valid Unreal installation'
    $projectEngine = Resolve-UE5EngineRoot -LauncherManifest $manifest -EngineAssociation '5.7'
    Assert-True ($projectEngine -eq (Resolve-Path -LiteralPath $engine57).Path) 'project association must select the matching Unreal minor version'
    Assert-True ((Get-UE5EngineVersion -EngineRoot $engine58) -eq [version]'5.8.1') 'Build.version must drive engine version detection'
    Assert-True (Test-UE5VisualStudioCompatibility -EngineVersion ([version]'5.8.1') -VisualStudioVersion ([version]'17.14.0')) 'UE 5.8 must accept VS 2022 17.14'
    Assert-True (-not (Test-UE5VisualStudioCompatibility -EngineVersion ([version]'5.8.1') -VisualStudioVersion ([version]'17.13.9'))) 'UE 5.8 must reject VS 2022 17.13'
    Assert-True (Test-UE5VisualStudioCompatibility -EngineVersion ([version]'5.8.1') -VisualStudioVersion ([version]'18.0.0')) 'UE 5.8 must accept VS 2026 18.0'

    $visualStudio = [pscustomobject]@{
        displayName = 'Visual Studio Community 2022'
        installationVersion = '17.14.10'
        installationPath = 'C:\Program Files\Microsoft Visual Studio\2022\Community'
    }
    $readyParameters = @{
        EngineRoot = $engine58
        RequireVisualStudio = $true
        RequireNode = $true
        VisualStudioInstallation = $visualStudio
        WindowsSdkVersion = [version]'10.0.26100.0'
        NodeVersion = [version]'22.12.0'
    }
    $ready = Get-UE5HTML5WorkstationReport @readyParameters
    Assert-True $ready.ready 'complete supported toolchain must be ready'
    Assert-True ($ready.blockers.Count -eq 0) 'ready report must have no blockers'

    $oldNodeParameters = $readyParameters.Clone()
    $oldNodeParameters.NodeVersion = [version]'21.0.0'
    $oldNode = Get-UE5HTML5WorkstationReport @oldNodeParameters
    Assert-True (-not $oldNode.ready) 'Node 21 must fail certification readiness'
    Assert-True (($oldNode.blockers -join ' ') -match 'Node.js 21') 'old Node blocker must be actionable'

    $systemNode = Get-Command node.exe -ErrorAction Stop
    $systemNodeVersion = (& $systemNode.Source --version).Trim().TrimStart('v')
    $nodePathFile = Join-Path $testRoot 'node-path.txt'
    $nodeReportFile = Join-Path $testRoot 'node-report.json'
    Set-Content -LiteralPath $nodePathFile -Value $systemNode.Source -Encoding ascii -NoNewline
    [ordered]@{
        schema = 'ue5-html5-node-resolution/v1'
        version = $systemNodeVersion
        source = 'system'
        managedByExporter = $false
        checksumVerified = $false
        archiveSha256 = $null
        executableSha256 = $null
        administratorRequired = $false
        systemPathChanged = $false
    } | ConvertTo-Json | Set-Content -LiteralPath $nodeReportFile -Encoding utf8
    $systemNodeEvidence = Get-UE5HTML5NodeResolutionEvidence -PathFile $nodePathFile -ReportFile $nodeReportFile
    Assert-True ($systemNodeEvidence.source -eq 'system') 'node evidence must preserve a compatible system runtime'
    Assert-True (-not $systemNodeEvidence.managedByExporter) 'system node must not claim exporter-managed provenance'

    $portableNodeRoot = Join-Path $testRoot 'portable-node'
    New-Item -ItemType Directory -Path $portableNodeRoot -Force | Out-Null
    $portableNode = Join-Path $portableNodeRoot 'node.exe'
    Copy-Item -LiteralPath $systemNode.Source -Destination $portableNode
    $portableExecutableHash = (Get-FileHash -LiteralPath $portableNode -Algorithm SHA256).Hash.ToLowerInvariant()
    $portableArchiveHash = 'a' * 64
    [ordered]@{
        schema = 'ue5-html5-node-runtime/v1'
        nodeVersion = $systemNodeVersion
        architecture = 'x64'
        archiveSha256 = $portableArchiveHash
        executableSha256 = $portableExecutableHash
        sourceUrl = 'https://nodejs.org/example.zip'
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $portableNodeRoot 'ue5html5-node-runtime.json') -Encoding utf8
    Set-Content -LiteralPath $nodePathFile -Value $portableNode -Encoding ascii -NoNewline
    [ordered]@{
        schema = 'ue5-html5-node-resolution/v1'
        version = $systemNodeVersion
        source = 'verified-portable-cache'
        managedByExporter = $true
        checksumVerified = $true
        archiveSha256 = $portableArchiveHash
        executableSha256 = $portableExecutableHash
        administratorRequired = $false
        systemPathChanged = $false
    } | ConvertTo-Json | Set-Content -LiteralPath $nodeReportFile -Encoding utf8
    $portableNodeEvidence = Get-UE5HTML5NodeResolutionEvidence -PathFile $nodePathFile -ReportFile $nodeReportFile
    Assert-True ($portableNodeEvidence.source -eq 'verified-portable-cache') 'node evidence must accept a re-hashed portable runtime'
    Assert-True $portableNodeEvidence.checksumVerified 'portable node must retain checksum evidence'
    $portableManifest = Get-Content -LiteralPath (Join-Path $portableNodeRoot 'ue5html5-node-runtime.json') -Raw | ConvertFrom-Json
    $portableManifest.executableSha256 = '0' * 64
    $portableManifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $portableNodeRoot 'ue5html5-node-runtime.json') -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5NodeResolutionEvidence -PathFile $nodePathFile -ReportFile $nodeReportFile
    } 'does not match its verified runtime manifest' 'node evidence must reject a modified portable executable or manifest'

    $inventoryRoot = Join-Path $testRoot 'inventory'
    New-Item -ItemType Directory -Path (Join-Path $inventoryRoot 'nested') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $inventoryRoot 'alpha.txt') -Value 'alpha' -Encoding ascii -NoNewline
    Set-Content -LiteralPath (Join-Path $inventoryRoot 'nested\beta.txt') -Value 'beta' -Encoding ascii -NoNewline
    Set-Content -LiteralPath (Join-Path $inventoryRoot 'excluded.txt') -Value 'private report' -Encoding ascii -NoNewline
    $inventory = Get-UE5HTML5DirectoryInventory -Root $inventoryRoot -Exclude @('excluded.txt')
    $secondInventory = Get-UE5HTML5DirectoryInventory -Root $inventoryRoot -Exclude @('excluded.txt')
    Assert-True ($inventory.schema -eq 'ue5-html5-directory-inventory/v1') 'certification inventory schema must be explicit'
    Assert-True ($inventory.fileCount -eq 2) 'certification inventory must honor exact exclusions'
    Assert-True ($inventory.totalBytes -eq 9) 'certification inventory must sum included bytes'
    Assert-True ($inventory.sha256 -match '^[0-9a-f]{64}$') 'certification inventory must have a SHA-256 digest'
    Assert-True ($inventory.sha256 -eq $secondInventory.sha256) 'certification inventory must be deterministic'
    Assert-True (($inventory.files.path -join ',') -eq 'alpha.txt,nested/beta.txt') 'certification inventory paths must be sorted and portable'
    Set-Content -LiteralPath (Join-Path $inventoryRoot 'nested\beta.txt') -Value 'changed' -Encoding ascii -NoNewline
    $changedInventory = Get-UE5HTML5DirectoryInventory -Root $inventoryRoot -Exclude @('excluded.txt')
    Assert-True ($inventory.sha256 -ne $changedInventory.sha256) 'certification inventory must detect changed content'

    $browserCertificationPath = Join-Path $testRoot 'browser-certification.json'
    $assetPackVersion = "sha256:$('a' * 64)"
    $browserCertification = [ordered]@{
        schema = 'ue5-html5-browser-certification/v3'
        status = 'passed'
        verifiedAtUtc = '2026-08-23T12:00:00.000Z'
        exporterVersion = '0.3.37'
        manifestSchema = 'ue5-html5-export/v8'
        assetPack = [ordered]@{
            schema = 'ue5-html5-asset-pack/v3'
            version = $assetPackVersion
            cacheBusting = 'pack-version-query'
            resourceCount = 3
            cacheResourceCount = 2
            versionedModuleCount = 1
            cold = @{ coverage = @(
                @{ path = 'assets/scene.glb'; mode = 'network-cached'; cacheBustVersion = $assetPackVersion; passed = $true },
                @{ path = 'logic/blueprints.json'; mode = 'network-cached'; cacheBustVersion = $assetPackVersion; passed = $true }
            ); versionedModuleCoverage = @(
                @{ path = 'logic/custom-adapters.js'; mode = 'versioned-module'; cacheBustVersion = $assetPackVersion; passed = $true }
            ) }
            warm = @{ coverage = @(
                @{ path = 'assets/scene.glb'; mode = 'cache-hit'; cacheBustVersion = $assetPackVersion; passed = $true },
                @{ path = 'logic/blueprints.json'; mode = 'cache-hit'; cacheBustVersion = $assetPackVersion; passed = $true }
            ); versionedModuleCoverage = @(
                @{ path = 'logic/custom-adapters.js'; mode = 'versioned-module'; cacheBustVersion = $assetPackVersion; passed = $true }
            ) }
        }
        runtime = @{ blueprintReady = $true; firstPersonEnabled = $true }
        performance = @{
            advisoryOnly = $true
            context = 'local-browser-only'
            runtimeReadyFromNavigationStartMs = 850.5
            framePacing = @{
                sampleCount = 120
                durationMs = 2000
                averageFramesPerSecond = 60
                p50FrameMs = 16.667
                p95FrameMs = 17.5
                maxFrameMs = 25
                framesOver33Ms = 0
                framesOver50Ms = 0
            }
            deviceMetadataCollected = $false
        }
        targetPractice = @{
            shots = 3
            scoreDelta = 100
            afterShots = @{ depletedTargets = 1 }
            afterRespawn = @{ activeTargets = 1 }
        }
        privacy = @{ credentialsAccessed = $false; personalPlayerDataCollected = $false; deviceMetadataCollected = $false }
    }
    $browserCertification | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $browserCertificationPath -Encoding utf8
    $browserEvidence = Get-UE5HTML5BrowserCertificationEvidence `
        -CertificationFile $browserCertificationPath `
        -ExpectedExporterVersion '0.3.37' `
        -ExpectedManifestSchema 'ue5-html5-export/v8' `
        -ExpectedAssetPackSchema 'ue5-html5-asset-pack/v3' `
        -ExpectedAssetPackVersion $assetPackVersion
    Assert-True ($browserEvidence.status -eq 'passed') 'browser certification bridge must accept the complete matching report'
    Assert-True ($browserEvidence.assetPack.resourceCount -eq 3) 'browser certification bridge must preserve resource coverage evidence'
    Assert-True ($browserEvidence.assetPack.versionedModuleCount -eq 1) 'browser certification bridge must preserve versioned module evidence'
    Assert-True ($browserEvidence.targetPractice.scoreDelta -eq 100) 'browser certification bridge must preserve gameplay evidence'
    Assert-True ($browserEvidence.performance.framePacing.averageFramesPerSecond -eq 60) 'browser certification bridge must preserve advisory frame-pacing evidence'

    $browserCertification.assetPack.warm.coverage[1].mode = 'network-cached'
    $browserCertification | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $browserCertificationPath -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5BrowserCertificationEvidence `
            -CertificationFile $browserCertificationPath `
            -ExpectedExporterVersion '0.3.37' `
            -ExpectedManifestSchema 'ue5-html5-export/v8' `
            -ExpectedAssetPackSchema 'ue5-html5-asset-pack/v3' `
            -ExpectedAssetPackVersion $assetPackVersion
    } 'proxy-versioned cold/warm coverage' 'browser certification bridge must reject the wrong warm delivery mode'

    $browserCertification.assetPack.warm.coverage[1].mode = 'cache-hit'
    $browserCertification.assetPack.cold.versionedModuleCoverage[0].cacheBustVersion = "sha256:$('0' * 64)"
    $browserCertification | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $browserCertificationPath -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5BrowserCertificationEvidence `
            -CertificationFile $browserCertificationPath `
            -ExpectedExporterVersion '0.3.37' `
            -ExpectedManifestSchema 'ue5-html5-export/v8' `
            -ExpectedAssetPackSchema 'ue5-html5-asset-pack/v3' `
            -ExpectedAssetPackVersion $assetPackVersion
    } 'proxy-versioned cold/warm coverage' 'browser certification bridge must reject the wrong adapter-module version'

    $browserCertification.assetPack.cold.versionedModuleCoverage[0].cacheBustVersion = $assetPackVersion
    $browserCertification.performance.framePacing.averageFramesPerSecond = 0
    $browserCertification | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $browserCertificationPath -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5BrowserCertificationEvidence `
            -CertificationFile $browserCertificationPath `
            -ExpectedExporterVersion '0.3.37' `
            -ExpectedManifestSchema 'ue5-html5-export/v8' `
            -ExpectedAssetPackSchema 'ue5-html5-asset-pack/v3' `
            -ExpectedAssetPackVersion $assetPackVersion
    } 'frame-pacing evidence' 'browser certification bridge must reject invalid frame-pacing evidence'

    $browserCertification.performance.framePacing.averageFramesPerSecond = 60
    $browserCertification.status = 'failed'
    $browserCertification | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $browserCertificationPath -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5BrowserCertificationEvidence `
            -CertificationFile $browserCertificationPath `
            -ExpectedExporterVersion '0.3.37' `
            -ExpectedManifestSchema 'ue5-html5-export/v8' `
            -ExpectedAssetPackSchema 'ue5-html5-asset-pack/v3' `
            -ExpectedAssetPackVersion $assetPackVersion
    } 'does not contain a passing run' 'browser certification bridge must reject a failed report'

    $editorAutomationPath = Join-Path $testRoot 'editor-automation.json'
    $editorAutomation = [ordered]@{
        succeeded = 5
        succeededWithWarnings = 0
        failed = 0
        notRun = 0
        inProcess = 0
        tests = @(
            [ordered]@{
                fullTestPath = 'UE5HTML5Exporter.Editor.BlueprintFallbackPolicy'
                state = 'Success'
                duration = 0.02
                errors = 0
                warnings = 0
            },
            [ordered]@{
                fullTestPath = 'UE5HTML5Exporter.Editor.BlueprintFallbackScaffolding'
                state = 'Success'
                duration = 0.04
                errors = 0
                warnings = 0
            },
            [ordered]@{
                fullTestPath = 'UE5HTML5Exporter.Editor.BrowserFPSSetup'
                state = 'Success'
                duration = 0.17
                errors = 0
                warnings = 0
            },
            [ordered]@{
                fullTestPath = 'UE5HTML5Exporter.Editor.DiscordInstallUrl'
                state = 'Success'
                duration = 0.03
                errors = 0
                warnings = 0
            },
            [ordered]@{
                fullTestPath = 'UE5HTML5Exporter.Editor.ReleaseReceiptWorkspace'
                state = 'Success'
                duration = 0.05
                errors = 0
                warnings = 0
            }
        )
    }
    $editorAutomation | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $editorAutomationPath -Encoding utf8
    $editorEvidence = Get-UE5HTML5EditorAutomationEvidence -ReportFile $editorAutomationPath
    Assert-True ($editorEvidence.status -eq 'passed') 'editor automation bridge must accept the exact clean passing certification suite'
    Assert-True ($editorEvidence.schema -eq 'ue5-html5-editor-automation-evidence/v2') 'editor automation evidence must use the multi-test schema'
    Assert-True ($editorEvidence.tests.Count -eq 5) 'editor automation evidence must retain all native test results'
    Assert-True (($editorEvidence.tests.testPath -join ',') -eq 'UE5HTML5Exporter.Editor.BlueprintFallbackPolicy,UE5HTML5Exporter.Editor.BlueprintFallbackScaffolding,UE5HTML5Exporter.Editor.BrowserFPSSetup,UE5HTML5Exporter.Editor.DiscordInstallUrl,UE5HTML5Exporter.Editor.ReleaseReceiptWorkspace') 'editor automation evidence must retain the exact native test paths'
    Assert-True ($editorEvidence.durationSeconds -eq 0.31) 'editor automation evidence must sum native test duration'

    $editorAutomation.tests[0].state = 'Fail'
    $editorAutomation.failed = 1
    $editorAutomation.succeeded = 1
    $editorAutomation | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $editorAutomationPath -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5EditorAutomationEvidence -ReportFile $editorAutomationPath
    } 'does not prove a clean passing run' 'editor automation bridge must reject a failed native setup test'

    $editorAutomation.tests[0].state = 'Success'
    $editorAutomation.failed = 0
    $editorAutomation.succeeded = 5
    $editorAutomation.tests[1].fullTestPath = 'UE5HTML5Exporter.Editor.SomeOtherTest'
    $editorAutomation | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $editorAutomationPath -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5EditorAutomationEvidence -ReportFile $editorAutomationPath
    } 'does not contain exactly the requested test suite' 'editor automation bridge must reject the wrong test path'

    $revisionPath = Join-Path $testRoot 'source-revision.json'
    $cleanCommit = '0123456789abcdef0123456789abcdef01234567'
    @{
        schema = 'ue5-html5-source-revision/v1'
        commit = $cleanCommit
        ref = 'refs/heads/main'
        dirty = $false
    } | ConvertTo-Json | Set-Content -LiteralPath $revisionPath -Encoding utf8
    $source = Resolve-UE5HTML5CertificationSource `
        -SourceCommit $cleanCommit `
        -Repository 'H-XX-D/ue5-html5-exporter' `
        -SourceRevisionFile $revisionPath `
        -RepositoryRoot $testRoot
    Assert-True ($source.commit -eq $cleanCommit) 'clean source bundle must preserve its exact commit'
    Assert-True $source.clean 'clean source bundle must produce clean certification evidence'
    Assert-True ($source.ref -eq 'refs/heads/main') 'clean source bundle must preserve its source ref'
    Assert-True ($source.evidence -eq 'source-bundle-metadata') 'source bundle must identify metadata-only provenance'
    Assert-True (-not $source.releaseGradeSourceProof) 'unsigned source bundle metadata must not be called release-grade proof'

    $dirtyRevision = @{
        schema = 'ue5-html5-source-revision/v1'
        commit = $cleanCommit
        ref = 'refs/heads/main'
        dirty = $true
    }
    $dirtyRevision | ConvertTo-Json | Set-Content -LiteralPath $revisionPath -Encoding utf8
    Assert-Throws {
        Resolve-UE5HTML5CertificationSource -SourceRevisionFile $revisionPath -RepositoryRoot $testRoot
    } 'does not prove an exact clean commit' 'dirty source bundle must be rejected'

    $unknownRevision = @{
        schema = 'ue5-html5-source-revision/v1'
        commit = $cleanCommit
        ref = 'refs/heads/main'
        dirty = $null
    }
    $unknownRevision | ConvertTo-Json | Set-Content -LiteralPath $revisionPath -Encoding utf8
    Assert-Throws {
        Resolve-UE5HTML5CertificationSource -SourceRevisionFile $revisionPath -RepositoryRoot $testRoot
    } 'does not prove an exact clean commit' 'unknown source cleanliness must be rejected'

    $stringRevision = @{
        schema = 'ue5-html5-source-revision/v1'
        commit = $cleanCommit
        ref = 'refs/heads/main'
        dirty = 'false'
    }
    $stringRevision | ConvertTo-Json | Set-Content -LiteralPath $revisionPath -Encoding utf8
    Assert-Throws {
        Resolve-UE5HTML5CertificationSource -SourceRevisionFile $revisionPath -RepositoryRoot $testRoot
    } 'does not prove an exact clean commit' 'non-Boolean source cleanliness must be rejected'

    $dirtyRevision.dirty = $false
    $dirtyRevision | ConvertTo-Json | Set-Content -LiteralPath $revisionPath -Encoding utf8
    Assert-Throws {
        Resolve-UE5HTML5CertificationSource `
            -SourceCommit 'fedcba9876543210fedcba9876543210fedcba98' `
            -SourceRevisionFile $revisionPath `
            -RepositoryRoot $testRoot
    } 'does not match source-revision.json' 'requested commit mismatch must be rejected'
    Assert-Throws {
        Resolve-UE5HTML5CertificationSource `
            -SourceCommit 'main' `
            -SourceRevisionFile $revisionPath `
            -RepositoryRoot $testRoot
    } 'requires an exact 40-character source commit' 'non-commit source identifiers must be rejected'

    $setupLauncher = Join-Path $PSScriptRoot 'Start-UE5HTML5Setup.ps1'
    $launcherCheck = (& $setupLauncher -LauncherCheck | Out-String)
    Assert-True ($launcherCheck -match 'Windows setup launcher check passed') 'click installer coordinator must pass its non-interactive check'

    $certificationLauncher = Join-Path $PSScriptRoot 'Start-UE5HTML5Certification.ps1'
    $certificationLauncherCheck = (& $certificationLauncher -LauncherCheck | Out-String)
    Assert-True ($certificationLauncherCheck -match 'Windows certification launcher check passed') 'click certification coordinator must pass its non-interactive check'

    Write-Host 'Windows tooling contract tests passed.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
