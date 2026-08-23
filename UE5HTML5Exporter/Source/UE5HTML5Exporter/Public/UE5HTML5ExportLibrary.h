#pragma once

#include "CoreMinimal.h"

class AActor;
class UWorld;

struct FUE5HTML5AssetPackResource
{
    FString Path;
    FString Kind;
    FString Delivery;
    FString SHA256;
    int64 Bytes = 0;
};

struct FUE5HTML5ExportResult
{
    bool bSuccess = false;
    FString OutputDirectory;
    FString Error;
    TArray<FString> Warnings;
    int32 ActorCount = 0;
    int32 BlueprintCount = 0;
    int32 BlueprintNodeCount = 0;
    int32 BuiltInSupportedBlueprintNodeCount = 0;
    int32 CustomAdapterBlueprintNodeCount = 0;
    int32 SupportedBlueprintNodeCount = 0;
    int32 UnsupportedBlueprintNodeCount = 0;
    TSet<FString> UsedBlueprintFunctions;
    TArray<FString> DiscordFeatures;
    TArray<FString> RequiredDiscordOAuthScopes;
    TArray<FString> RequiredDiscordEnvironment;
    int64 BrowserPayloadBytes = 0;
    int64 BrowserPayloadBudgetBytes = 0;
    int64 IndexBytes = 0;
    int64 RuntimeBytes = 0;
    int64 AssetBytes = 0;
    int64 SceneBytes = 0;
    int64 LogicBytes = 0;
    FString LargestBrowserArtifactPath;
    int64 LargestBrowserArtifactBytes = 0;
    bool bBrowserPayloadExceedsAdvisoryBudget = false;
    FString AssetPackVersion;
    int64 AssetPackBytes = 0;
    TArray<FUE5HTML5AssetPackResource> AssetPackResources;
};

struct FUE5HTML5ReadinessReport
{
    bool bReady = false;
    TArray<FString> PassedChecks;
    TArray<FString> Blockers;
    TArray<FString> Notes;
};

struct FUE5HTML5BlueprintCompatibilityReport
{
    bool bSuccess = false;
    FString OutputDirectory;
    FString ReportPath;
    FString Error;
    int32 BlueprintCount = 0;
    int32 ActorInstanceCount = 0;
    int32 NodeCount = 0;
    int32 BuiltInSupportedNodeCount = 0;
    int32 CustomAdapterNodeCount = 0;
    int32 SupportedNodeCount = 0;
    int32 UnsupportedNodeCount = 0;
    TArray<FString> UnsupportedNodes;
};

class FUE5HTML5ExportLibrary
{
public:
    static bool EnsureProjectAdapterFiles(FString& OutDirectory, FString& OutError);
    static FUE5HTML5ReadinessReport CheckDiscordActivityReadiness(UWorld* World);
    static FUE5HTML5BlueprintCompatibilityReport AnalyzeBlueprintCompatibility(UWorld* World, const FString& OutputDirectory);
    static FUE5HTML5ExportResult ExportWorld(UWorld* World, const FString& OutputDirectory, const TSet<AActor*>& SelectedActors);
};
