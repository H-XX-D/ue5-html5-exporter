#pragma once

#include "CoreMinimal.h"

class AActor;
class USoundWave;
class UWorld;

struct FUE5BlueprintExportSummary
{
    bool bSuccess = false;
    int32 BlueprintCount = 0;
    int32 ActorInstanceCount = 0;
    int32 NodeCount = 0;
    int32 BuiltInSupportedNodeCount = 0;
    int32 CustomAdapterNodeCount = 0;
    int32 SupportedNodeCount = 0;
    int32 UnsupportedNodeCount = 0;
    TArray<FString> UnsupportedNodes;
    TSet<FString> UsedFunctions;
    TArray<USoundWave*> ReferencedSoundWaves;
    TArray<FString> UnsupportedSoundAssets;
    FString Error;
    TArray<FString> Warnings;
};

class FUE5BlueprintGraphExporter
{
public:
    static FUE5BlueprintExportSummary Export(
        UWorld* World,
        const TArray<AActor*>& Actors,
        const FString& OutputDirectory,
        const TSet<FString>& CustomAdapterFunctions = {},
        bool bExportSupportingAssets = true);
};
