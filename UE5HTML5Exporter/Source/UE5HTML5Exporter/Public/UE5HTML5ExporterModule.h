#pragma once

#include "HAL/PlatformProcess.h"
#include "Modules/ModuleManager.h"

class FUE5HTML5ExporterModule final : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

private:
    void RegisterMenus();
    void OpenDiscordActivitySettings();
    void ImportDiscordActivityProjectTargets();
    void ExportDiscordActivityProjectTargets();
    void OpenCustomWebAdapters();
    void CheckDiscordActivityReadinessInteractive();
    void CheckBlueprintCompatibilityInteractive();
    void ExportInteractive(bool bSelectionOnly, bool bDiscordGuided = false);
    void ExportDiscordActivityPreviewInteractive();
    bool LaunchDiscordActivityPreview(const FString& OutputDirectory);
    void StopDiscordActivityPreview();

    FProcHandle PreviewServerProcess;
};
