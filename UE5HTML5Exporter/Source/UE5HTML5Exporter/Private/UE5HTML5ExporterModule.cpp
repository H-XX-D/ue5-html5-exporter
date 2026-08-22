#include "UE5HTML5ExporterModule.h"

#include "DesktopPlatformModule.h"
#include "Editor.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/PlatformProcess.h"
#include "Interfaces/IMainFrameModule.h"
#include "ISettingsModule.h"
#include "LevelEditor.h"
#include "Misc/MessageDialog.h"
#include "Misc/Paths.h"
#include "Selection.h"
#include "ToolMenus.h"
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
        "UE5HTML5DiscordActivityReadiness",
        LOCTEXT("DiscordActivityReadiness", "Check Discord Activity Readiness…"),
        LOCTEXT("DiscordActivityReadinessTooltip", "Check the exporter and runtime prerequisites before measuring Blueprint compatibility during export."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::CheckDiscordActivityReadinessInteractive)));
}

void FUE5HTML5ExporterModule::OpenDiscordActivitySettings()
{
    ISettingsModule& SettingsModule = FModuleManager::LoadModuleChecked<ISettingsModule>(TEXT("Settings"));
    SettingsModule.ShowViewer(TEXT("Project"), TEXT("Plugins"), TEXT("UE5HTML5DiscordActivity"));
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
            TEXT("Blueprint compatibility: %d of %d nodes translated; %d require adapters.\n")
            TEXT("The export is playable, but its handoff is marked NEEDS BLUEPRINT ADAPTERS. Review logic/blueprints.json before release."),
            Result.SupportedBlueprintNodeCount,
            Result.BlueprintNodeCount,
            Result.UnsupportedBlueprintNodeCount);
    }
    else
    {
        Compatibility = FString::Printf(
            TEXT("Blueprint compatibility: all %d exported nodes translated."),
            Result.BlueprintNodeCount);
    }

    const FString NextAction = bDiscordGuided
        ? TEXT("Start the Discord Activity release assistant now?\n\nIt opens in a terminal and begins with a non-mutating dry run. Private credentials remain outside Unreal.")
        : TEXT("Open the export folder now?");
    const FString Message = FString::Printf(
        TEXT("Exported %d actors to:\n%s\n\n%s\n\n")
        TEXT("activity-handoff.json contains the release-operator steps.\n\n%s"),
        Result.ActorCount,
        *Result.OutputDirectory,
        *Compatibility,
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
            TEXT("Local Discord Blueprint preview started.\n\n%s\n\n")
            TEXT("The browser uses Discord's official SDK mock plus local-only game-state storage. ")
            TEXT("It does not contact Discord, Vercel, or Supabase and does not replace a final in-Discord test.\n\nExport: %s"),
            *Compatibility,
            *Result.OutputDirectory)));
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
