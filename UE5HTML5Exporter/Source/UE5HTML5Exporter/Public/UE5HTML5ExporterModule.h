#pragma once

#include "Modules/ModuleManager.h"

class FUE5HTML5ExporterModule final : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

private:
    void RegisterMenus();
    void CheckDiscordActivityReadinessInteractive();
    void ExportInteractive(bool bSelectionOnly);
};
