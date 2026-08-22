#include "UE5HTML5ExporterModule.h"

#include "DesktopPlatformModule.h"
#include "Editor.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/PlatformProcess.h"
#include "Interfaces/IMainFrameModule.h"
#include "ISettingsModule.h"
#include "LevelEditor.h"
#include "Misc/MessageDialog.h"
#include "Selection.h"
#include "ToolMenus.h"
#include "UE5HTML5ExportLibrary.h"

#define LOCTEXT_NAMESPACE "FUE5HTML5ExporterModule"

void FUE5HTML5ExporterModule::StartupModule()
{
    UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FUE5HTML5ExporterModule::RegisterMenus));
}

void FUE5HTML5ExporterModule::ShutdownModule()
{
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
            Message += TEXT("\nFix these blockers, then choose Export Discord Activity again.");
            FMessageDialog::Open(EAppMsgType::Ok, FText::FromString(Message));
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

    const FString Message = FString::Printf(
        TEXT("Exported %d actors to:\n%s\n\n%s\n\n")
        TEXT("activity-handoff.json contains the release-operator steps.\n\nOpen the export folder now?"),
        Result.ActorCount,
        *Result.OutputDirectory,
        *Compatibility);
    if (FMessageDialog::Open(EAppMsgType::YesNo, FText::FromString(Message)) == EAppReturnType::Yes)
    {
        FPlatformProcess::ExploreFolder(*Result.OutputDirectory);
    }
}

IMPLEMENT_MODULE(FUE5HTML5ExporterModule, UE5HTML5Exporter)

#undef LOCTEXT_NAMESPACE
