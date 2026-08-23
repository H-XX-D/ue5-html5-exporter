#pragma once

#include "CoreMinimal.h"

class AActor;
class APlayerStart;
class UWorld;

enum class EUE5HTML5BrowserFPSSetupStatus : uint8
{
    MissingWorld,
    MissingPlayerStart,
    ReadyToCreate,
    Created,
    ExistingTargetSelected,
    SpawnFailed
};

struct FUE5HTML5BrowserFPSSetupResult
{
    EUE5HTML5BrowserFPSSetupStatus Status = EUE5HTML5BrowserFPSSetupStatus::MissingWorld;
    AActor* TargetActor = nullptr;
    int32 TargetCount = 0;
};

/** Dialog-free editor policy shared by the Tools menu and native automation tests. */
class UE5HTML5EXPORTER_API FUE5HTML5BrowserFPSSetup
{
public:
    static APlayerStart* FindPreferredPlayerStart(UWorld* World);
    static FTransform MakeTargetTransform(const APlayerStart& PlayerStart);
    static FUE5HTML5BrowserFPSSetupResult Apply(UWorld* World, bool bAllowCreate, bool bSelectAndFocus);
};
