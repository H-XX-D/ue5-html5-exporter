#pragma once

#include "CoreMinimal.h"

class AActor;

struct FUE5BlueprintExportSummary
{
    bool bSuccess = false;
    int32 BlueprintCount = 0;
    int32 ActorInstanceCount = 0;
    int32 NodeCount = 0;
    int32 SupportedNodeCount = 0;
    int32 UnsupportedNodeCount = 0;
    FString Error;
    TArray<FString> Warnings;
};

class FUE5BlueprintGraphExporter
{
public:
    static FUE5BlueprintExportSummary Export(const TArray<AActor*>& Actors, const FString& OutputDirectory);
};
