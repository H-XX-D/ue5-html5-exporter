#pragma once

#include "CoreMinimal.h"

/**
 * One unsupported call that can be rebuilt as a same-Blueprint Web_ function.
 * The node GUID keeps the repair assistant bound to the exact audited graph.
 */
struct FUE5HTML5BlueprintRepairCandidate
{
    FString BlueprintPath;
    FString BlueprintName;
    FString GraphName;
    FGuid NodeId;
    FString NodeTitle;
    FString FunctionName;
    FString SuggestedFunctionName;
};
