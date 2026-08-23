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
        schema = 'ue5-html5-browser-certification/v2'
        status = 'passed'
        verifiedAtUtc = '2026-08-23T12:00:00.000Z'
        exporterVersion = '0.3.37'
        manifestSchema = 'ue5-html5-export/v5'
        assetPack = [ordered]@{
            schema = 'ue5-html5-asset-pack/v1'
            version = $assetPackVersion
            resourceCount = 2
            cold = @{ coverage = @(
                @{ path = 'assets/scene.glb'; mode = 'network-cached'; passed = $true },
                @{ path = 'logic/blueprints.json'; mode = 'network-cached'; passed = $true }
            ) }
            warm = @{ coverage = @(
                @{ path = 'assets/scene.glb'; mode = 'cache-hit'; passed = $true },
                @{ path = 'logic/blueprints.json'; mode = 'cache-hit'; passed = $true }
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
        -ExpectedManifestSchema 'ue5-html5-export/v5' `
        -ExpectedAssetPackVersion $assetPackVersion
    Assert-True ($browserEvidence.status -eq 'passed') 'browser certification bridge must accept the complete matching report'
    Assert-True ($browserEvidence.assetPack.resourceCount -eq 2) 'browser certification bridge must preserve resource coverage evidence'
    Assert-True ($browserEvidence.targetPractice.scoreDelta -eq 100) 'browser certification bridge must preserve gameplay evidence'
    Assert-True ($browserEvidence.performance.framePacing.averageFramesPerSecond -eq 60) 'browser certification bridge must preserve advisory frame-pacing evidence'

    $browserCertification.assetPack.warm.coverage[1].mode = 'network-cached'
    $browserCertification | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $browserCertificationPath -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5BrowserCertificationEvidence `
            -CertificationFile $browserCertificationPath `
            -ExpectedExporterVersion '0.3.37' `
            -ExpectedManifestSchema 'ue5-html5-export/v5' `
            -ExpectedAssetPackVersion $assetPackVersion
    } 'matching cold network-cached and warm cache-hit coverage' 'browser certification bridge must reject the wrong warm delivery mode'

    $browserCertification.assetPack.warm.coverage[1].mode = 'cache-hit'
    $browserCertification.performance.framePacing.averageFramesPerSecond = 0
    $browserCertification | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $browserCertificationPath -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5BrowserCertificationEvidence `
            -CertificationFile $browserCertificationPath `
            -ExpectedExporterVersion '0.3.37' `
            -ExpectedManifestSchema 'ue5-html5-export/v5' `
            -ExpectedAssetPackVersion $assetPackVersion
    } 'frame-pacing evidence' 'browser certification bridge must reject invalid frame-pacing evidence'

    $browserCertification.performance.framePacing.averageFramesPerSecond = 60
    $browserCertification.status = 'failed'
    $browserCertification | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $browserCertificationPath -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5BrowserCertificationEvidence `
            -CertificationFile $browserCertificationPath `
            -ExpectedExporterVersion '0.3.37' `
            -ExpectedManifestSchema 'ue5-html5-export/v5' `
            -ExpectedAssetPackVersion $assetPackVersion
    } 'does not contain a passing run' 'browser certification bridge must reject a failed report'

    $editorAutomationPath = Join-Path $testRoot 'editor-automation.json'
    $editorAutomation = [ordered]@{
        succeeded = 1
        succeededWithWarnings = 0
        failed = 0
        notRun = 0
        inProcess = 0
        tests = @([ordered]@{
            fullTestPath = 'UE5HTML5Exporter.Editor.BrowserFPSSetup'
            state = 'Success'
            duration = 0.17
            errors = 0
            warnings = 0
        })
    }
    $editorAutomation | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $editorAutomationPath -Encoding utf8
    $editorEvidence = Get-UE5HTML5EditorAutomationEvidence -ReportFile $editorAutomationPath
    Assert-True ($editorEvidence.status -eq 'passed') 'editor automation bridge must accept one exact clean passing setup test'
    Assert-True ($editorEvidence.testPath -eq 'UE5HTML5Exporter.Editor.BrowserFPSSetup') 'editor automation evidence must retain the exact native test path'
    Assert-True ($editorEvidence.durationSeconds -eq 0.17) 'editor automation evidence must retain duration'

    $editorAutomation.tests[0].state = 'Fail'
    $editorAutomation.failed = 1
    $editorAutomation.succeeded = 0
    $editorAutomation | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $editorAutomationPath -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5EditorAutomationEvidence -ReportFile $editorAutomationPath
    } 'does not prove one clean passing run' 'editor automation bridge must reject a failed native setup test'

    $editorAutomation.tests[0].state = 'Success'
    $editorAutomation.failed = 0
    $editorAutomation.succeeded = 1
    $editorAutomation.tests[0].fullTestPath = 'UE5HTML5Exporter.Editor.SomeOtherTest'
    $editorAutomation | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $editorAutomationPath -Encoding utf8
    Assert-Throws {
        Get-UE5HTML5EditorAutomationEvidence -ReportFile $editorAutomationPath
    } 'does not contain exactly the requested test' 'editor automation bridge must reject the wrong test path'

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
