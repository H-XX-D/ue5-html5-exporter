#pragma once

#include "CoreMinimal.h"

class AActor;
class UWorld;

struct FUE5HTML5ExportResult
{
    bool bSuccess = false;
    FString OutputDirectory;
    FString Error;
    TArray<FString> Warnings;
    int32 ActorCount = 0;
};

struct FUE5HTML5ReadinessReport
{
    bool bReady = false;
    TArray<FString> PassedChecks;
    TArray<FString> Blockers;
    TArray<FString> Notes;
};

class FUE5HTML5ExportLibrary
{
public:
    static FUE5HTML5ReadinessReport CheckDiscordActivityReadiness(UWorld* World);
    static FUE5HTML5ExportResult ExportWorld(UWorld* World, const FString& OutputDirectory, const TSet<AActor*>& SelectedActors);
};
