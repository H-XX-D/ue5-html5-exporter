#pragma once

#include "CoreMinimal.h"
#include "UE5HTML5BlueprintRepair.h"

class UBlueprint;
class UK2Node_CallFunction;

struct FUE5HTML5BlueprintFallbackScaffoldResult
{
    bool bSuccess = false;
    int32 AuditedCallCount = 0;
    int32 UniqueDraftCount = 0;
    int32 CreatedDraftCount = 0;
    int32 ExistingDraftCount = 0;
    int32 SkippedDraftCount = 0;
    TArray<FString> CreatedFunctions;
    TArray<FString> ExistingFunctions;
    TArray<FString> Warnings;
    TArray<TWeakObjectPtr<UBlueprint>> ModifiedBlueprints;
};

class FUE5HTML5BlueprintFallbackScaffolder
{
public:
    static FUE5HTML5BlueprintFallbackScaffoldResult CreateDrafts(
        const TArray<FUE5HTML5BlueprintRepairCandidate>& Candidates);

    static bool CreateDraft(
        UBlueprint* Blueprint,
        UK2Node_CallFunction* Call,
        const FString& FunctionName,
        FString& OutDraftFunction,
        FString& OutError);
};
