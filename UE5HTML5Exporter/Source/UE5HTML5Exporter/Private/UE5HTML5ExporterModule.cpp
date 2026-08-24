#include "UE5HTML5ExporterModule.h"

#include "DesktopPlatformModule.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "Interfaces/IMainFrameModule.h"
#include "ISettingsModule.h"
#include "LevelEditor.h"
#include "Misc/MessageDialog.h"
#include "Misc/Paths.h"
#include "Selection.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "ToolMenus.h"
#include "UE5HTML5BlueprintFallbackScaffolder.h"
#include "UE5HTML5BrowserFPSSetup.h"
#include "UE5HTML5DiscordActivitySettings.h"
#include "UE5HTML5ExportLibrary.h"

#define LOCTEXT_NAMESPACE "FUE5HTML5ExporterModule"

namespace
{
    FString DiscordActivityReleaseLauncher(const FString& OutputDirectory)
    {
#if PLATFORM_WINDOWS
        return FPaths::Combine(OutputDirectory, TEXT("release-discord-activity.cmd"));
#elif PLATFORM_MAC
        return FPaths::Combine(OutputDirectory, TEXT("release-discord-activity.command"));
#else
        return FPaths::Combine(OutputDirectory, TEXT("release-discord-activity.sh"));
#endif
    }

    FString DiscordActivityPreviewLauncher(const FString& OutputDirectory)
    {
#if PLATFORM_WINDOWS
        return FPaths::Combine(OutputDirectory, TEXT("preview-discord-activity.cmd"));
#elif PLATFORM_MAC
        return FPaths::Combine(OutputDirectory, TEXT("preview-discord-activity.command"));
#else
        return FPaths::Combine(OutputDirectory, TEXT("preview-discord-activity.sh"));
#endif
    }

    FString BrowserCertificationLauncher(const FString& OutputDirectory)
    {
#if PLATFORM_WINDOWS
        return FPaths::Combine(OutputDirectory, TEXT("certify-browser.cmd"));
#elif PLATFORM_MAC
        return FPaths::Combine(OutputDirectory, TEXT("certify-browser.command"));
#else
        return FPaths::Combine(OutputDirectory, TEXT("certify-browser.sh"));
#endif
    }

    FString ReleaseReceiptVerificationLauncher(const FString& OutputDirectory)
    {
#if PLATFORM_WINDOWS
        return FPaths::Combine(OutputDirectory, TEXT("verify-discord-activity-release.cmd"));
#elif PLATFORM_MAC
        return FPaths::Combine(OutputDirectory, TEXT("verify-discord-activity-release.command"));
#else
        return FPaths::Combine(OutputDirectory, TEXT("verify-discord-activity-release.sh"));
#endif
    }

    FString BundledPythonExecutable()
    {
#if PLATFORM_WINDOWS
        return FPaths::Combine(FPaths::EngineDir(), TEXT("Binaries/ThirdParty/Python3/Win64/python.exe"));
#elif PLATFORM_MAC
        return FPaths::Combine(FPaths::EngineDir(), TEXT("Binaries/ThirdParty/Python3/Mac/bin/python3"));
#else
        return FPaths::Combine(FPaths::EngineDir(), TEXT("Binaries/ThirdParty/Python3/Linux/bin/python3"));
#endif
    }

    bool LaunchDiscordActivityReleaseAssistant(const FString& OutputDirectory)
    {
        const FString Launcher = DiscordActivityReleaseLauncher(OutputDirectory);
        if (!FPaths::FileExists(Launcher))
        {
            return false;
        }

#if PLATFORM_LINUX
        const TArray<TPair<FString, FString>> TerminalCandidates = {
            { TEXT("/usr/bin/x-terminal-emulator"), FString::Printf(TEXT("-e \"%s\""), *Launcher) },
            { TEXT("/usr/bin/gnome-terminal"), FString::Printf(TEXT("-- \"%s\""), *Launcher) },
            { TEXT("/usr/bin/konsole"), FString::Printf(TEXT("-e \"%s\""), *Launcher) }
        };
        for (const TPair<FString, FString>& Candidate : TerminalCandidates)
        {
            if (!FPaths::FileExists(Candidate.Key))
            {
                continue;
            }
            FProcHandle Process = FPlatformProcess::CreateProc(
                *Candidate.Key,
                *Candidate.Value,
                true,
                false,
                false,
                nullptr,
                0,
                *OutputDirectory,
                nullptr);
            if (Process.IsValid())
            {
                return true;
            }
        }
#endif

        return FPlatformProcess::LaunchFileInDefaultExternalApplication(*Launcher);
    }
}

void FUE5HTML5ExporterModule::StartupModule()
{
    UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FUE5HTML5ExporterModule::RegisterMenus));
}

void FUE5HTML5ExporterModule::ShutdownModule()
{
    StopDiscordActivityPreview();
    UToolMenus::UnRegisterStartupCallback(this);
    UToolMenus::UnregisterOwner(this);
}

void FUE5HTML5ExporterModule::RegisterMenus()
{
    FToolMenuOwnerScoped Owner(this);
    UToolMenu* Menu = UToolMenus::Get()->ExtendMenu("LevelEditor.MainMenu.Tools");
    FToolMenuSection& Section = Menu->FindOrAddSection("UE5HTML5Exporter", LOCTEXT("Section", "HTML5 Export"));

    Section.AddMenuEntry(
        "UE5HTML5ExportDiscordActivity",
        LOCTEXT("ExportDiscordActivity", "Export Discord Activity…"),
        LOCTEXT("ExportDiscordActivityTooltip", "Run the Discord readiness gate, export the current level, and report exact Blueprint compatibility."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::ExportInteractive, false, true)));

    Section.AddMenuEntry(
        "UE5HTML5PreviewDiscordActivity",
        LOCTEXT("PreviewDiscordActivity", "Export & Preview Discord Blueprint Logic"),
        LOCTEXT("PreviewDiscordActivityTooltip", "Export to the project's Saved folder and launch a local-only browser preview backed by Discord's official SDK mock. No credentials or deployment required."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::ExportDiscordActivityPreviewInteractive)));

    Section.AddMenuEntry(
        "UE5HTML5QuickStartDiscordFPSPreview",
        LOCTEXT("QuickStartDiscordFPSPreview", "Quick Start Discord FPS Preview"),
        LOCTEXT("QuickStartDiscordFPSPreviewTooltip", "Select an existing browser target—or offer to add an undoable practice target—then export and launch the local Discord SDK mock preview. No credentials or deployment required."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::QuickStartDiscordFPSPreviewInteractive)));

    Section.AddMenuEntry(
        "UE5HTML5SetupBrowserFPSTestLevel",
        LOCTEXT("SetupBrowserFPSTestLevel", "Set Up Browser FPS Test Level"),
        LOCTEXT("SetupBrowserFPSTestLevelTooltip", "Select an existing target or add a configured UE5 HTML5 Practice Target in front of the selected or first Player Start. The level change supports Undo."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::SetupBrowserFPSTestLevelInteractive)));

    Section.AddMenuEntry(
        "UE5HTML5CertifyBrowserFPS",
        LOCTEXT("CertifyBrowserFPS", "Export & Certify Browser FPS"),
        LOCTEXT("CertifyBrowserFPSTooltip", "Export the current level, prove cold and warm asset delivery, fire the real first-person center ray, and write a machine-readable target score/respawn certificate."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::ExportBrowserCertificationInteractive)));

    Section.AddMenuEntry(
        "UE5HTML5ExportLevel",
        LOCTEXT("ExportLevel", "Export Level to HTML5…"),
        LOCTEXT("ExportLevelTooltip", "Export the current level as a ready-to-host WebGL site."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::ExportInteractive, false, false)));

    Section.AddMenuEntry(
        "UE5HTML5ExportSelection",
        LOCTEXT("ExportSelection", "Export Selection to HTML5…"),
        LOCTEXT("ExportSelectionTooltip", "Export only selected actors as a ready-to-host WebGL site."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::ExportInteractive, true, false)));

    Section.AddMenuEntry(
        "UE5HTML5DiscordActivitySettings",
        LOCTEXT("DiscordActivitySettings", "Discord Activity Project Settings…"),
        LOCTEXT("DiscordActivitySettingsTooltip", "Set the non-secret Discord, Vercel, and Supabase project targets shared with every export."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::OpenDiscordActivitySettings)));

    Section.AddMenuEntry(
        "UE5HTML5DiscordActivityInstallPage",
        LOCTEXT("DiscordActivityInstallPage", "Open Discord Activity Install Page…"),
        LOCTEXT("DiscordActivityInstallPageTooltip", "Open Discord's official Add to My Apps / Add to Server page for this project's public Application ID. This does not authorize the app automatically."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::OpenDiscordActivityInstallPage)));

    Section.AddMenuEntry(
        "UE5HTML5VerifyDiscordActivityReleaseReceipt",
        LOCTEXT("VerifyDiscordActivityReleaseReceipt", "Verify Hosted Discord Activity Receipt…"),
        LOCTEXT("VerifyDiscordActivityReleaseReceiptTooltip", "Choose the secret-free release receipt from the operator, independently verify both hosted URLs and exact release identities, and write a shareable verification record."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::VerifyDiscordActivityReleaseReceipt)));

    Section.AddMenuEntry(
        "UE5HTML5ImportDiscordActivityProjectTargets",
        LOCTEXT("ImportDiscordActivityProjectTargets", "Import Public Discord Activity Targets…"),
        LOCTEXT("ImportDiscordActivityProjectTargetsTooltip", "Import the allowlisted public Discord, Vercel, and Supabase project identity from a teammate JSON file. Credentials are rejected."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::ImportDiscordActivityProjectTargets)));

    Section.AddMenuEntry(
        "UE5HTML5ExportDiscordActivityProjectTargets",
        LOCTEXT("ExportDiscordActivityProjectTargets", "Export Public Discord Activity Targets…"),
        LOCTEXT("ExportDiscordActivityProjectTargetsTooltip", "Create a shareable JSON file containing only the current project's public Discord, Vercel, and Supabase identity."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::ExportDiscordActivityProjectTargets)));

    Section.AddMenuEntry(
        "UE5HTML5DiscordActivityReadiness",
        LOCTEXT("DiscordActivityReadiness", "Check Discord Activity Readiness…"),
        LOCTEXT("DiscordActivityReadinessTooltip", "Check the exporter and runtime prerequisites before measuring Blueprint compatibility during export."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::CheckDiscordActivityReadinessInteractive)));

    Section.AddMenuEntry(
        "UE5HTML5BlueprintCompatibility",
        LOCTEXT("BlueprintCompatibility", "Check Blueprint Web Compatibility…"),
        LOCTEXT("BlueprintCompatibilityTooltip", "Scan the current map's exported Blueprint scope without exporting scene assets, then write a readable adapter report."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::CheckBlueprintCompatibilityInteractive)));

    Section.AddMenuEntry(
        "UE5HTML5CreateBlueprintFallbackDrafts",
        LOCTEXT("CreateBlueprintFallbackDrafts", "Create Blueprint Web Fallback Drafts…"),
        LOCTEXT("CreateBlueprintFallbackDraftsTooltip", "Audit the current export scope and create undoable Web_ function drafts with matching input and output pins for eligible unsupported synchronous action calls. Drafts remain unsupported until their visible marker is deleted."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::CreateBlueprintFallbackDraftsInteractive)));

    Section.AddMenuEntry(
        "UE5HTML5CustomWebAdapters",
        LOCTEXT("CustomWebAdapters", "Open Custom Web Adapters Folder"),
        LOCTEXT("CustomWebAdaptersTooltip", "Create or open the source-controlled Config/UE5HTML5 adapter contract for project C++ and unsupported Blueprint functions."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::OpenCustomWebAdapters)));
}

void FUE5HTML5ExporterModule::OpenDiscordActivitySettings()
{
    ISettingsModule& SettingsModule = FModuleManager::LoadModuleChecked<ISettingsModule>(TEXT("Settings"));
    SettingsModule.ShowViewer(TEXT("Project"), TEXT("Plugins"), TEXT("UE5HTML5DiscordActivity"));
}

void FUE5HTML5ExporterModule::OpenDiscordActivityInstallPage()
{
    const UUE5HTML5DiscordActivitySettings* Settings = GetDefault<UUE5HTML5DiscordActivitySettings>();
    FString InstallUrl;
    FString Error;
    if (!Settings->TryGetDiscordInstallUrl(InstallUrl, Error))
    {
        const FString Message = Error + TEXT("\n\nChoose Yes to open the project settings now.");
        if (FMessageDialog::Open(EAppMsgType::YesNo, FText::FromString(Message)) == EAppReturnType::Yes)
        {
            OpenDiscordActivitySettings();
        }
        return;
    }

    FString LaunchError;
    FPlatformProcess::LaunchURL(*InstallUrl, nullptr, &LaunchError);
    if (!LaunchError.IsEmpty())
    {
        FMessageDialog::Open(
            EAppMsgType::Ok,
            FText::FromString(FString::Printf(
                TEXT("Could not open the Discord Activity install page:\n%s\n\n%s"),
                *InstallUrl,
                *LaunchError)));
    }
}

void FUE5HTML5ExporterModule::VerifyDiscordActivityReleaseReceipt()
{
    IDesktopPlatform* DesktopPlatform = FDesktopPlatformModule::Get();
    if (!DesktopPlatform)
    {
        FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("ReceiptVerifyNoDesktop", "The operating-system file picker is unavailable."));
        return;
    }
    const void* ParentHandle = FSlateApplication::Get().FindBestParentWindowHandleForDialogs(nullptr);
    TArray<FString> Files;
    if (!DesktopPlatform->OpenFileDialog(
        ParentHandle,
        TEXT("Choose the Discord Activity release receipt"),
        FPaths::ProjectDir(),
        TEXT("activity-release-receipt.json"),
        TEXT("JSON files (*.json)|*.json"),
        EFileDialogFlags::None,
        Files)
        || Files.Num() != 1)
    {
        return;
    }

    FString VerificationDirectory;
    FString Error;
    if (!FUE5HTML5ExportLibrary::PrepareReleaseReceiptVerification(Files[0], VerificationDirectory, Error))
    {
        FMessageDialog::Open(EAppMsgType::Ok, FText::FromString(Error));
        return;
    }
    if (!LaunchReleaseReceiptVerifier(VerificationDirectory))
    {
        FPlatformProcess::ExploreFolder(*VerificationDirectory);
        FMessageDialog::Open(
            EAppMsgType::Ok,
            LOCTEXT(
                "ReceiptVerifierLaunchFailed",
                "Unreal could not start hosted release verification automatically. The disposable verification folder is open; run the verify-discord-activity-release launcher for this operating system."));
        return;
    }

    FMessageDialog::Open(
        EAppMsgType::Ok,
        FText::FromString(FString::Printf(
            TEXT("Hosted Discord Activity verification started.\n\n")
            TEXT("The terminal independently checks the receipt contract, immutable deployment URL, stable public URL, exporter version, manifest schema, complete manifest identity, reusable asset-pack identity, iframe compatibility, and enabled Activity API.\n\n")
            TEXT("It uses no Discord, Vercel, or Supabase credentials and writes no player or billing information. A successful run creates:\n%s"),
            *FPaths::Combine(VerificationDirectory, TEXT("activity-release-verification.json")))));
}

void FUE5HTML5ExporterModule::ImportDiscordActivityProjectTargets()
{
    IDesktopPlatform* DesktopPlatform = FDesktopPlatformModule::Get();
    if (!DesktopPlatform)
    {
        FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("TargetImportNoDesktop", "The operating-system file picker is unavailable."));
        return;
    }
    const void* ParentHandle = FSlateApplication::Get().FindBestParentWindowHandleForDialogs(nullptr);
    TArray<FString> Files;
    if (!DesktopPlatform->OpenFileDialog(
        ParentHandle,
        TEXT("Choose public Discord Activity project targets"),
        FPaths::ProjectDir(),
        TEXT("discord-activity-project-targets.json"),
        TEXT("JSON files (*.json)|*.json"),
        EFileDialogFlags::None,
        Files)
        || Files.Num() != 1)
    {
        return;
    }

    FString Error;
    UUE5HTML5DiscordActivitySettings* Settings = GetMutableDefault<UUE5HTML5DiscordActivitySettings>();
    if (!Settings->ImportPublicTargets(Files[0], Error))
    {
        FMessageDialog::Open(EAppMsgType::Ok, FText::FromString(Error));
        return;
    }
    FMessageDialog::Open(
        EAppMsgType::Ok,
        LOCTEXT(
            "TargetImportComplete",
            "Imported the complete public Discord Activity target set into DefaultGame.ini. Credential fields and player data are not part of this contract."));
}

void FUE5HTML5ExporterModule::ExportDiscordActivityProjectTargets()
{
    IDesktopPlatform* DesktopPlatform = FDesktopPlatformModule::Get();
    if (!DesktopPlatform)
    {
        FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("TargetExportNoDesktop", "The operating-system file picker is unavailable."));
        return;
    }
    const void* ParentHandle = FSlateApplication::Get().FindBestParentWindowHandleForDialogs(nullptr);
    TArray<FString> Files;
    if (!DesktopPlatform->SaveFileDialog(
        ParentHandle,
        TEXT("Save public Discord Activity project targets"),
        FPaths::ProjectDir(),
        TEXT("discord-activity-project-targets.json"),
        TEXT("JSON files (*.json)|*.json"),
        EFileDialogFlags::None,
        Files)
        || Files.Num() != 1)
    {
        return;
    }

    FString Error;
    const UUE5HTML5DiscordActivitySettings* Settings = GetDefault<UUE5HTML5DiscordActivitySettings>();
    if (!Settings->ExportPublicTargets(Files[0], Error))
    {
        FMessageDialog::Open(EAppMsgType::Ok, FText::FromString(Error));
        return;
    }
    FMessageDialog::Open(
        EAppMsgType::Ok,
        FText::FromString(FString::Printf(
            TEXT("Saved public Discord Activity targets to:\n%s\n\nThe file contains only the allowlisted public target fields. Review it before sharing, just like any project configuration file."),
            *Files[0])));
}

void FUE5HTML5ExporterModule::OpenCustomWebAdapters()
{
    FString Directory;
    FString Error;
    if (!FUE5HTML5ExportLibrary::EnsureProjectAdapterFiles(Directory, Error))
    {
        FMessageDialog::Open(EAppMsgType::Ok, FText::FromString(Error));
        return;
    }
    FPlatformProcess::ExploreFolder(*Directory);
}

void FUE5HTML5ExporterModule::CheckDiscordActivityReadinessInteractive()
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    const FUE5HTML5ReadinessReport Report = FUE5HTML5ExportLibrary::CheckDiscordActivityReadiness(World);

    FString Message = Report.bReady
        ? TEXT("READY FOR DISCORD EXPORT\n\nThe exporter prerequisites are ready. Blueprint compatibility will be measured during export.\n")
        : TEXT("NOT READY YET\n\nFix the blockers below, then run this check again.\n");

    if (!Report.PassedChecks.IsEmpty())
    {
        Message += TEXT("\nPassed:\n");
        for (const FString& Check : Report.PassedChecks)
        {
            Message += FString::Printf(TEXT("  + %s\n"), *Check);
        }
    }
    if (!Report.Blockers.IsEmpty())
    {
        Message += TEXT("\nBlockers:\n");
        for (const FString& Blocker : Report.Blockers)
        {
            Message += FString::Printf(TEXT("  - %s\n"), *Blocker);
        }
    }
    if (!Report.Notes.IsEmpty())
    {
        Message += TEXT("\nHandoff notes:\n");
        for (const FString& Note : Report.Notes)
        {
            Message += FString::Printf(TEXT("  * %s\n"), *Note);
        }
    }

    const UUE5HTML5DiscordActivitySettings* ProjectSettings = GetDefault<UUE5HTML5DiscordActivitySettings>();
    if (!Report.bReady && !ProjectSettings->HasCompleteTargetSet())
    {
        Message += TEXT("\nChoose Yes to open the required public project targets now.");
        if (FMessageDialog::Open(EAppMsgType::YesNo, FText::FromString(Message)) == EAppReturnType::Yes)
        {
            OpenDiscordActivitySettings();
        }
        return;
    }
    FMessageDialog::Open(EAppMsgType::Ok, FText::FromString(Message));
}

void FUE5HTML5ExporterModule::CheckBlueprintCompatibilityInteractive()
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("NoCompatibilityWorld", "Open a level before checking Blueprint web compatibility."));
        return;
    }

    const FString OutputDirectory = FPaths::ConvertRelativePathToFull(
        FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UE5HTML5/BlueprintCompatibility")));
    const FUE5HTML5BlueprintCompatibilityReport Report =
        FUE5HTML5ExportLibrary::AnalyzeBlueprintCompatibility(World, OutputDirectory);
    if (!Report.bSuccess)
    {
        FMessageDialog::Open(EAppMsgType::Ok, FText::Format(
            LOCTEXT("BlueprintCompatibilityFailed", "Blueprint compatibility check failed:\n{0}"),
            FText::FromString(Report.Error)));
        return;
    }

    FString Message = FString::Printf(
        TEXT("BLUEPRINT WEB COMPATIBILITY\n\n")
        TEXT("%d of %d nodes are covered across %d Blueprints and %d actor instances.\n")
        TEXT("%d use the built-in runtime; %d use Blueprint fallbacks; %d use project adapters and still require runtime validation.\n")
        TEXT("%d uncovered call(s) can be scaffolded and completed entirely in Blueprint.\n"),
        Report.SupportedNodeCount,
        Report.NodeCount,
        Report.BlueprintCount,
        Report.ActorInstanceCount,
        Report.BuiltInSupportedNodeCount,
        Report.BlueprintFallbackNodeCount,
        Report.CustomAdapterNodeCount,
        Report.BlueprintRepairCandidateNodeCount);
    if (Report.UnsupportedNodeCount == 0)
    {
        Message += TEXT("\nNo unsupported nodes were found in the current export scope.\n");
    }
    else
    {
        Message += FString::Printf(TEXT("\n%d nodes require web adapters:\n"), Report.UnsupportedNodeCount);
        const int32 VisibleCount = FMath::Min(Report.UnsupportedNodes.Num(), 12);
        for (int32 Index = 0; Index < VisibleCount; ++Index)
        {
            Message += FString::Printf(TEXT("  - %s\n"), *Report.UnsupportedNodes[Index]);
        }
        if (Report.UnsupportedNodes.Num() > VisibleCount)
        {
            Message += FString::Printf(TEXT("  ... and %d more in the report.\n"), Report.UnsupportedNodes.Num() - VisibleCount);
        }
    }
    Message += TEXT("\n");
    Message += FUE5HTML5ExportLibrary::FormatDiscordAccessSummary(
        Report.DiscordFeatures,
        Report.RequiredDiscordOAuthScopes);
    Message += TEXT("\n\nThis fast check does not export scene assets or certify browser runtime behavior.\n\nOpen the complete report folder now?");
    if (FMessageDialog::Open(EAppMsgType::YesNo, FText::FromString(Message)) == EAppReturnType::Yes)
    {
        FPlatformProcess::ExploreFolder(*Report.OutputDirectory);
    }
}

void FUE5HTML5ExporterModule::CreateBlueprintFallbackDraftsInteractive()
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("NoFallbackDraftWorld", "Open a level before creating Blueprint web fallback drafts."));
        return;
    }

    const FString OutputDirectory = FPaths::ConvertRelativePathToFull(
        FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UE5HTML5/BlueprintCompatibility")));
    const FUE5HTML5BlueprintCompatibilityReport Report =
        FUE5HTML5ExportLibrary::AnalyzeBlueprintCompatibility(World, OutputDirectory);
    if (!Report.bSuccess)
    {
        FMessageDialog::Open(EAppMsgType::Ok, FText::FromString(FString::Printf(
            TEXT("Blueprint fallback audit failed:\n%s"),
            *Report.Error)));
        return;
    }
    if (Report.BlueprintRepairCandidates.IsEmpty())
    {
        const FString Message = Report.UnsupportedNodeCount == 0
            ? TEXT("No uncovered Blueprint calls need fallback drafts in the current export scope.")
            : FString::Printf(
                TEXT("None of the %d uncovered nodes can use a synchronous Blueprint fallback. Pure calls and non-call nodes still need built-in runtime support or a project JavaScript adapter.\n\nComplete report:\n%s"),
                Report.UnsupportedNodeCount,
                *Report.ReportPath);
        FMessageDialog::Open(EAppMsgType::Ok, FText::FromString(Message));
        return;
    }

    TSet<FString> UniqueFunctions;
    for (const FUE5HTML5BlueprintRepairCandidate& Candidate : Report.BlueprintRepairCandidates)
    {
        UniqueFunctions.Add(Candidate.BlueprintName + TEXT(".") + Candidate.SuggestedFunctionName);
    }
    TArray<FString> Functions = UniqueFunctions.Array();
    Functions.Sort();
    FString Message = FString::Printf(
        TEXT("Create %d Blueprint web fallback draft(s) for %d uncovered call site(s)?\n\n"),
        Functions.Num(),
        Report.BlueprintRepairCandidates.Num());
    const int32 VisibleCount = FMath::Min(Functions.Num(), 12);
    for (int32 Index = 0; Index < VisibleCount; ++Index)
    {
        Message += FString::Printf(TEXT("  + %s\n"), *Functions[Index]);
    }
    if (Functions.Num() > VisibleCount)
    {
        Message += FString::Printf(TEXT("  ... and %d more\n"), Functions.Num() - VisibleCount);
    }
    Message += TEXT(
        "\nEach new Web_ function receives the native call's input and output pins. A large orange DRAFT comment keeps it unsupported until you rebuild the portable behavior, set every required output, and delete that marker.\n\n"
        "This changes Blueprint assets in memory, supports Undo, and does not save them automatically.");
    if (FMessageDialog::Open(EAppMsgType::YesNo, FText::FromString(Message)) != EAppReturnType::Yes)
    {
        return;
    }

    const FUE5HTML5BlueprintFallbackScaffoldResult Result =
        FUE5HTML5BlueprintFallbackScaffolder::CreateDrafts(Report.BlueprintRepairCandidates);
    if (!Result.ModifiedBlueprints.IsEmpty())
    {
        if (UAssetEditorSubsystem* AssetEditors = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>())
        {
            AssetEditors->OpenEditorForAsset(Result.ModifiedBlueprints[0].Get());
        }
    }

    FString ResultMessage = FString::Printf(
        TEXT("Created %d Blueprint fallback draft(s); %d matching draft(s) already existed; %d were skipped.\n\n"),
        Result.CreatedDraftCount,
        Result.ExistingDraftCount,
        Result.SkippedDraftCount);
    if (!Result.CreatedFunctions.IsEmpty())
    {
        ResultMessage += TEXT("Created:\n");
        for (const FString& Function : Result.CreatedFunctions)
        {
            ResultMessage += FString::Printf(TEXT("  + %s\n"), *Function);
        }
    }
    if (!Result.Warnings.IsEmpty())
    {
        ResultMessage += TEXT("\nReview:\n");
        for (const FString& Warning : Result.Warnings)
        {
            ResultMessage += FString::Printf(TEXT("  - %s\n"), *Warning);
        }
    }
    ResultMessage += TEXT(
        "\nBuild each draft with supported Blueprint nodes. Delete its orange UE5HTML5 DRAFT FALLBACK comment only when the replacement is ready, then rerun Check Blueprint Web Compatibility.");
    FMessageDialog::Open(EAppMsgType::Ok, FText::FromString(ResultMessage));
}

void FUE5HTML5ExporterModule::ExportInteractive(const bool bSelectionOnly, const bool bDiscordGuided)
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("NoWorld", "Open a level before exporting."));
        return;
    }

    if (bDiscordGuided)
    {
        const FUE5HTML5ReadinessReport Report = FUE5HTML5ExportLibrary::CheckDiscordActivityReadiness(World);
        if (!Report.bReady)
        {
            FString Message = TEXT("DISCORD ACTIVITY EXPORT IS NOT READY\n\n");
            for (const FString& Blocker : Report.Blockers)
            {
                Message += FString::Printf(TEXT("  - %s\n"), *Blocker);
            }
            const UUE5HTML5DiscordActivitySettings* ProjectSettings = GetDefault<UUE5HTML5DiscordActivitySettings>();
            if (!ProjectSettings->HasCompleteTargetSet())
            {
                Message += TEXT("\nChoose Yes to open Project Settings and fill the missing public targets. No credentials are stored there.");
                if (FMessageDialog::Open(EAppMsgType::YesNo, FText::FromString(Message)) == EAppReturnType::Yes)
                {
                    OpenDiscordActivitySettings();
                }
            }
            else
            {
                Message += TEXT("\nFix these blockers, then choose Export Discord Activity again.");
                FMessageDialog::Open(EAppMsgType::Ok, FText::FromString(Message));
            }
            return;
        }
    }

    TSet<AActor*> SelectedActors;
    if (bSelectionOnly)
    {
        for (FSelectionIterator It(*GEditor->GetSelectedActors()); It; ++It)
        {
            if (AActor* Actor = Cast<AActor>(*It))
            {
                SelectedActors.Add(Actor);
            }
        }
        if (SelectedActors.IsEmpty())
        {
            FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("NoSelection", "Select at least one actor before exporting the selection."));
            return;
        }
    }

    IDesktopPlatform* DesktopPlatform = FDesktopPlatformModule::Get();
    FString OutputDirectory;
    const void* ParentHandle = FSlateApplication::Get().FindBestParentWindowHandleForDialogs(nullptr);
    const FString DialogTitle = bDiscordGuided ? TEXT("Choose Discord Activity export folder") : TEXT("Choose HTML5 export folder");
    if (!DesktopPlatform || !DesktopPlatform->OpenDirectoryDialog(ParentHandle, DialogTitle, FPaths::ProjectDir(), OutputDirectory))
    {
        return;
    }

    const FUE5HTML5ExportResult Result = FUE5HTML5ExportLibrary::ExportWorld(World, OutputDirectory, SelectedActors);
    if (!Result.bSuccess)
    {
        FMessageDialog::Open(EAppMsgType::Ok, FText::Format(LOCTEXT("ExportFailed", "HTML5 export failed:\n{0}"), FText::FromString(Result.Error)));
        return;
    }

    FString Compatibility;
    if (Result.UnsupportedBlueprintNodeCount > 0)
    {
        Compatibility = FString::Printf(
            TEXT("Blueprint compatibility: %d of %d nodes translated; %d remain uncovered.\n")
            TEXT("%d eligible call(s) can be scaffolded and rebuilt entirely in Blueprint.\n")
            TEXT("The export is playable, but its handoff is marked NEEDS BLUEPRINT ADAPTERS. Review logic/blueprints.json before release."),
            Result.SupportedBlueprintNodeCount,
            Result.BlueprintNodeCount,
            Result.UnsupportedBlueprintNodeCount,
            Result.BlueprintRepairCandidateNodeCount);
    }
    else if (Result.CustomAdapterBlueprintNodeCount > 0)
    {
        Compatibility = FString::Printf(
            TEXT("Blueprint compatibility: all %d nodes are covered; %d use project adapters.\n")
            TEXT("The browser verifies adapter registration, but local Discord preview and gameplay testing are still required."),
            Result.BlueprintNodeCount,
            Result.CustomAdapterBlueprintNodeCount);
    }
    else
    {
        Compatibility = FString::Printf(
            TEXT("Blueprint compatibility: all %d exported nodes translated."),
            Result.BlueprintNodeCount);
    }

    const FString AssetDelivery = FString::Printf(
        TEXT("Primary browser payload: %.1f MiB of %.1f MiB project advisory budget%s.\n")
        TEXT("Largest artifact: %s (%.1f MiB). This budget is not a Discord platform limit or performance certification."),
        static_cast<double>(Result.BrowserPayloadBytes) / 1024.0 / 1024.0,
        static_cast<double>(Result.BrowserPayloadBudgetBytes) / 1024.0 / 1024.0,
        Result.bBrowserPayloadExceedsAdvisoryBudget ? TEXT(" — REVIEW RECOMMENDED") : TEXT(""),
        *Result.LargestBrowserArtifactPath,
        static_cast<double>(Result.LargestBrowserArtifactBytes) / 1024.0 / 1024.0);
    const FString DiscordAccess = FUE5HTML5ExportLibrary::FormatDiscordAccessSummary(
        Result.DiscordFeatures,
        Result.RequiredDiscordOAuthScopes);

    const FString NextAction = bDiscordGuided
        ? TEXT("Start the Discord Activity release assistant now?\n\nIt opens in a terminal, begins with a non-mutating dry run, then asks before applying that exact plan. Private credentials remain outside Unreal.")
        : TEXT("Open the export folder now?");
    const FString Message = FString::Printf(
        TEXT("Exported %d actors to:\n%s\n\n%s\n\n%s\n\n%s\n\n")
        TEXT("activity-handoff.json contains the release-operator steps.\n\n%s"),
        Result.ActorCount,
        *Result.OutputDirectory,
        *Compatibility,
        *AssetDelivery,
        *DiscordAccess,
        *NextAction);
    if (FMessageDialog::Open(EAppMsgType::YesNo, FText::FromString(Message)) == EAppReturnType::Yes)
    {
        if (!bDiscordGuided)
        {
            FPlatformProcess::ExploreFolder(*Result.OutputDirectory);
        }
        else if (!LaunchDiscordActivityReleaseAssistant(Result.OutputDirectory))
        {
            FPlatformProcess::ExploreFolder(*Result.OutputDirectory);
            FMessageDialog::Open(
                EAppMsgType::Ok,
                LOCTEXT(
                    "ReleaseAssistantLaunchFailed",
                    "Unreal could not start the release assistant automatically. The export folder is open; run the release-discord-activity launcher for this operating system."));
        }
    }
}

void FUE5HTML5ExporterModule::ExportDiscordActivityPreviewInteractive()
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("NoPreviewWorld", "Open a level before starting a Discord Activity preview."));
        return;
    }

    const FString PreviewDirectory = FPaths::ConvertRelativePathToFull(
        FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UE5HTML5/DiscordActivityPreview")));
    StopDiscordActivityPreview();
    IFileManager::Get().DeleteDirectory(*PreviewDirectory, false, true);

    const FUE5HTML5ExportResult Result = FUE5HTML5ExportLibrary::ExportWorld(World, PreviewDirectory, {});
    if (!Result.bSuccess)
    {
        FMessageDialog::Open(EAppMsgType::Ok, FText::Format(
            LOCTEXT("PreviewExportFailed", "Discord Activity preview export failed:\n{0}"),
            FText::FromString(Result.Error)));
        return;
    }

    if (!LaunchDiscordActivityPreview(Result.OutputDirectory))
    {
        FPlatformProcess::ExploreFolder(*Result.OutputDirectory);
        FMessageDialog::Open(
            EAppMsgType::Ok,
            LOCTEXT(
                "PreviewLaunchFailed",
                "Unreal could not start the local preview automatically. The export folder is open; run the preview-discord-activity launcher for this operating system."));
        return;
    }

    const FString Compatibility = Result.UnsupportedBlueprintNodeCount > 0
        ? FString::Printf(
            TEXT("%d of %d Blueprint nodes translated; %d still require adapters."),
            Result.SupportedBlueprintNodeCount,
            Result.BlueprintNodeCount,
            Result.UnsupportedBlueprintNodeCount)
        : FString::Printf(TEXT("All %d exported Blueprint nodes translated."), Result.BlueprintNodeCount);
    FMessageDialog::Open(
        EAppMsgType::Ok,
        FText::FromString(FString::Printf(
            TEXT("Local Discord Blueprint preview started.\n\n%s\n\n%s\n\n")
            TEXT("The browser uses Discord's official SDK mock plus local-only game-state storage. ")
            TEXT("It does not contact Discord, Vercel, or Supabase and does not replace a final in-Discord test.\n\nExport: %s"),
            *Compatibility,
            *FUE5HTML5ExportLibrary::FormatDiscordAccessSummary(
                Result.DiscordFeatures,
                Result.RequiredDiscordOAuthScopes),
            *Result.OutputDirectory)));
}

void FUE5HTML5ExporterModule::QuickStartDiscordFPSPreviewInteractive()
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    const FUE5HTML5BrowserFPSSetupResult Preview =
        FUE5HTML5BrowserFPSSetup::Apply(World, false, true);
    if (Preview.Status == EUE5HTML5BrowserFPSSetupStatus::ExistingTargetSelected)
    {
        ExportDiscordActivityPreviewInteractive();
        return;
    }
    if (Preview.Status == EUE5HTML5BrowserFPSSetupStatus::MissingWorld)
    {
        FMessageDialog::Open(
            EAppMsgType::Ok,
            LOCTEXT("NoQuickStartFPSWorld", "Open a First Person-style level before starting the Discord FPS preview."));
        return;
    }
    if (Preview.Status == EUE5HTML5BrowserFPSSetupStatus::MissingPlayerStart)
    {
        FMessageDialog::Open(
            EAppMsgType::Ok,
            LOCTEXT(
                "NoQuickStartFPSPlayerStart",
                "No Player Start was found. Add or select a Player Start, then run Quick Start Discord FPS Preview again."));
        return;
    }
    if (Preview.Status != EUE5HTML5BrowserFPSSetupStatus::ReadyToCreate)
    {
        FMessageDialog::Open(
            EAppMsgType::Ok,
            LOCTEXT("QuickStartFPSProbeFailed", "Unreal could not inspect this level for a browser FPS practice target."));
        return;
    }

    const EAppReturnType::Type Confirmation = FMessageDialog::Open(
        EAppMsgType::YesNo,
        LOCTEXT(
            "ConfirmQuickStartFPS",
            "This level has no UE5 HTML5 target. Add one configured Practice Target 6 meters in front of the selected or first Player Start, then export and launch the local Discord FPS preview?\n\nThe level will be marked modified, and the target creation can be undone."));
    if (Confirmation != EAppReturnType::Yes)
    {
        return;
    }

    const FUE5HTML5BrowserFPSSetupResult Result =
        FUE5HTML5BrowserFPSSetup::Apply(World, true, true);
    if (Result.Status != EUE5HTML5BrowserFPSSetupStatus::Created)
    {
        FMessageDialog::Open(
            EAppMsgType::Ok,
            LOCTEXT("QuickStartFPSSpawnFailed", "Unreal could not add the practice target, so the Discord FPS preview was not launched."));
        return;
    }

    ExportDiscordActivityPreviewInteractive();
}

void FUE5HTML5ExporterModule::ExportBrowserCertificationInteractive()
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("NoCertificationWorld", "Open a level before starting browser FPS certification."));
        return;
    }

    const FString CertificationDirectory = FPaths::ConvertRelativePathToFull(
        FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UE5HTML5/BrowserCertification")));
    StopDiscordActivityPreview();
    IFileManager::Get().DeleteDirectory(*CertificationDirectory, false, true);

    const FUE5HTML5ExportResult Result = FUE5HTML5ExportLibrary::ExportWorld(World, CertificationDirectory, {});
    if (!Result.bSuccess)
    {
        FMessageDialog::Open(EAppMsgType::Ok, FText::Format(
            LOCTEXT("BrowserCertificationExportFailed", "Browser FPS certification export failed:\n{0}"),
            FText::FromString(Result.Error)));
        return;
    }

    if (!LaunchBrowserCertification(Result.OutputDirectory))
    {
        FPlatformProcess::ExploreFolder(*Result.OutputDirectory);
        FMessageDialog::Open(
            EAppMsgType::Ok,
            LOCTEXT(
                "BrowserCertificationLaunchFailed",
                "Unreal could not start browser certification automatically. The export folder is open; run the certify-browser launcher for this operating system."));
        return;
    }

    FMessageDialog::Open(
        EAppMsgType::Ok,
        FText::FromString(FString::Printf(
            TEXT("Browser FPS certification started.\n\n")
            TEXT("The browser will perform a cold load, reload from the verified exporter cache, shoot the target through the real first-person controller, confirm score and respawn, then write:\n%s\n\n")
            TEXT("This local certificate does not contact Discord, Vercel, or Supabase and does not replace final in-Discord multi-client testing."),
            *FPaths::Combine(Result.OutputDirectory, TEXT("browser-certification.json")))));
}

void FUE5HTML5ExporterModule::SetupBrowserFPSTestLevelInteractive()
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    const FUE5HTML5BrowserFPSSetupResult Preview =
        FUE5HTML5BrowserFPSSetup::Apply(World, false, true);
    if (Preview.Status == EUE5HTML5BrowserFPSSetupStatus::MissingWorld)
    {
        FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("NoFPSSetupWorld", "Open a level before setting up the browser FPS test."));
        return;
    }
    if (Preview.Status == EUE5HTML5BrowserFPSSetupStatus::ExistingTargetSelected)
    {
        FMessageDialog::Open(
            EAppMsgType::Ok,
            FText::Format(
                LOCTEXT(
                    "ExistingFPSTargetSelected",
                    "This level already contains {0} UE5 HTML5 target(s). The first target is selected; no actor was created."),
                FText::AsNumber(Preview.TargetCount)));
        return;
    }
    if (Preview.Status == EUE5HTML5BrowserFPSSetupStatus::MissingPlayerStart)
    {
        FMessageDialog::Open(
            EAppMsgType::Ok,
            LOCTEXT(
                "NoFPSSetupPlayerStart",
                "No Player Start was found. Add or select a Player Start, then run Set Up Browser FPS Test Level again."));
        return;
    }

    const EAppReturnType::Type Confirmation = FMessageDialog::Open(
        EAppMsgType::YesNo,
        LOCTEXT(
            "ConfirmFPSSetup",
            "Add one configured UE5 HTML5 Practice Target 6 meters in front of the selected or first Player Start?\n\nThe level will be marked modified, and the change can be undone."));
    if (Confirmation != EAppReturnType::Yes)
    {
        return;
    }

    const FUE5HTML5BrowserFPSSetupResult Result =
        FUE5HTML5BrowserFPSSetup::Apply(World, true, true);
    if (Result.Status == EUE5HTML5BrowserFPSSetupStatus::ExistingTargetSelected)
    {
        FMessageDialog::Open(
            EAppMsgType::Ok,
            FText::Format(
                LOCTEXT(
                    "ExistingFPSTargetSelectedAfterConfirmation",
                    "This level now contains {0} UE5 HTML5 target(s). The first target is selected; no duplicate was created."),
                FText::AsNumber(Result.TargetCount)));
        return;
    }
    if (Result.Status != EUE5HTML5BrowserFPSSetupStatus::Created)
    {
        FMessageDialog::Open(
            EAppMsgType::Ok,
            LOCTEXT("FPSSetupSpawnFailed", "Unreal could not add the browser FPS practice target to the Player Start's level."));
        return;
    }
    FMessageDialog::Open(
        EAppMsgType::Ok,
        LOCTEXT(
            "FPSSetupComplete",
            "The practice target was added and selected with ready-to-test defaults: 3 health, 1 damage per shot, 100 score, and respawn enabled.\n\nSave the level, then choose Export & Certify Browser FPS."));
}

bool FUE5HTML5ExporterModule::LaunchDiscordActivityPreview(const FString& OutputDirectory)
{
    const FString ServeScript = FPaths::Combine(OutputDirectory, TEXT("serve.py"));
    if (!FPaths::FileExists(ServeScript))
    {
        return false;
    }

    const FString Python = BundledPythonExecutable();
    if (FPaths::FileExists(Python))
    {
        const FString Arguments = FString::Printf(TEXT("\"%s\" --discord-preview"), *ServeScript);
        PreviewServerProcess = FPlatformProcess::CreateProc(
            *Python,
            *Arguments,
            false,
            false,
            false,
            nullptr,
            0,
            *OutputDirectory,
            nullptr);
        if (PreviewServerProcess.IsValid())
        {
            return true;
        }
    }

    const FString Launcher = DiscordActivityPreviewLauncher(OutputDirectory);
    return FPaths::FileExists(Launcher)
        && FPlatformProcess::LaunchFileInDefaultExternalApplication(*Launcher);
}

bool FUE5HTML5ExporterModule::LaunchBrowserCertification(const FString& OutputDirectory)
{
    const FString ServeScript = FPaths::Combine(OutputDirectory, TEXT("serve.py"));
    if (!FPaths::FileExists(ServeScript))
    {
        return false;
    }

    const FString Python = BundledPythonExecutable();
    if (FPaths::FileExists(Python))
    {
        const FString Arguments = FString::Printf(TEXT("\"%s\" --certify"), *ServeScript);
        PreviewServerProcess = FPlatformProcess::CreateProc(
            *Python,
            *Arguments,
            false,
            false,
            false,
            nullptr,
            0,
            *OutputDirectory,
            nullptr);
        if (PreviewServerProcess.IsValid())
        {
            return true;
        }
    }

    const FString Launcher = BrowserCertificationLauncher(OutputDirectory);
    return FPaths::FileExists(Launcher)
        && FPlatformProcess::LaunchFileInDefaultExternalApplication(*Launcher);
}

bool FUE5HTML5ExporterModule::LaunchReleaseReceiptVerifier(const FString& OutputDirectory)
{
    const FString Launcher = ReleaseReceiptVerificationLauncher(OutputDirectory);
    if (!FPaths::FileExists(Launcher))
    {
        return false;
    }

#if PLATFORM_LINUX
    const TArray<TPair<FString, FString>> TerminalCandidates = {
        { TEXT("/usr/bin/x-terminal-emulator"), FString::Printf(TEXT("-e \"%s\""), *Launcher) },
        { TEXT("/usr/bin/gnome-terminal"), FString::Printf(TEXT("-- \"%s\""), *Launcher) },
        { TEXT("/usr/bin/konsole"), FString::Printf(TEXT("-e \"%s\""), *Launcher) }
    };
    for (const TPair<FString, FString>& Candidate : TerminalCandidates)
    {
        if (!FPaths::FileExists(Candidate.Key))
        {
            continue;
        }
        const FProcHandle Process = FPlatformProcess::CreateProc(
            *Candidate.Key,
            *Candidate.Value,
            true,
            false,
            false,
            nullptr,
            0,
            *OutputDirectory,
            nullptr);
        if (Process.IsValid())
        {
            return true;
        }
    }
#endif

    return FPlatformProcess::LaunchFileInDefaultExternalApplication(*Launcher);
}

void FUE5HTML5ExporterModule::StopDiscordActivityPreview()
{
    if (!PreviewServerProcess.IsValid())
    {
        return;
    }
    if (FPlatformProcess::IsProcRunning(PreviewServerProcess))
    {
        FPlatformProcess::TerminateProc(PreviewServerProcess, true);
    }
    FPlatformProcess::CloseProc(PreviewServerProcess);
    PreviewServerProcess.Reset();
}

IMPLEMENT_MODULE(FUE5HTML5ExporterModule, UE5HTML5Exporter)

#undef LOCTEXT_NAMESPACE
