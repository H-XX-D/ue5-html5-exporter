#include "UE5HTML5ExporterModule.h"

#include "DesktopPlatformModule.h"
#include "Editor.h"
#include "Framework/Application/SlateApplication.h"
#include "Interfaces/IMainFrameModule.h"
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
        "UE5HTML5ExportLevel",
        LOCTEXT("ExportLevel", "Export Level to HTML5…"),
        LOCTEXT("ExportLevelTooltip", "Export the current level as a ready-to-host WebGL site."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::ExportInteractive, false)));

    Section.AddMenuEntry(
        "UE5HTML5ExportSelection",
        LOCTEXT("ExportSelection", "Export Selection to HTML5…"),
        LOCTEXT("ExportSelectionTooltip", "Export only selected actors as a ready-to-host WebGL site."),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateRaw(this, &FUE5HTML5ExporterModule::ExportInteractive, true)));
}

void FUE5HTML5ExporterModule::ExportInteractive(const bool bSelectionOnly)
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        FMessageDialog::Open(EAppMsgType::Ok, LOCTEXT("NoWorld", "Open a level before exporting."));
        return;
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
    if (!DesktopPlatform || !DesktopPlatform->OpenDirectoryDialog(ParentHandle, TEXT("Choose HTML5 export folder"), FPaths::ProjectDir(), OutputDirectory))
    {
        return;
    }

    const FUE5HTML5ExportResult Result = FUE5HTML5ExportLibrary::ExportWorld(World, OutputDirectory, SelectedActors);
    if (!Result.bSuccess)
    {
        FMessageDialog::Open(EAppMsgType::Ok, FText::Format(LOCTEXT("ExportFailed", "HTML5 export failed:\n{0}"), FText::FromString(Result.Error)));
        return;
    }

    const FText Message = FText::Format(
        LOCTEXT("ExportComplete", "Exported {0} actors to:\n{1}\n\nRun serve.py or any static HTTP server in that folder, then open the shown URL."),
        FText::AsNumber(Result.ActorCount),
        FText::FromString(Result.OutputDirectory));
    FMessageDialog::Open(EAppMsgType::Ok, Message);
}

IMPLEMENT_MODULE(FUE5HTML5ExporterModule, UE5HTML5Exporter)

#undef LOCTEXT_NAMESPACE
