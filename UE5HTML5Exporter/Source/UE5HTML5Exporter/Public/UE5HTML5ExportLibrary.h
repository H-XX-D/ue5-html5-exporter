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

class FUE5HTML5ExportLibrary
{
public:
    static FUE5HTML5ExportResult ExportWorld(UWorld* World, const FString& OutputDirectory, const TSet<AActor*>& SelectedActors);
};
