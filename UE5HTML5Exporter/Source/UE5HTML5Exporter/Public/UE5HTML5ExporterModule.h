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
    void OpenDiscordActivityInstallPage();
    void VerifyDiscordActivityReleaseReceipt();
    void ImportDiscordActivityProjectTargets();
    void ExportDiscordActivityProjectTargets();
    void OpenCustomWebAdapters();
    void CheckDiscordActivityReadinessInteractive();
    void CheckBlueprintCompatibilityInteractive();
    void SetupBrowserFPSTestLevelInteractive();
    void QuickStartDiscordFPSPreviewInteractive();
    void ExportInteractive(bool bSelectionOnly, bool bDiscordGuided = false);
    void ExportDiscordActivityPreviewInteractive();
    void ExportBrowserCertificationInteractive();
    bool LaunchDiscordActivityPreview(const FString& OutputDirectory);
    bool LaunchBrowserCertification(const FString& OutputDirectory);
    bool LaunchReleaseReceiptVerifier(const FString& OutputDirectory);
    void StopDiscordActivityPreview();

    FProcHandle PreviewServerProcess;
};
