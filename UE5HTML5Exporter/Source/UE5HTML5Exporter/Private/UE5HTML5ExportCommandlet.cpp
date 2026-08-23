#include "UE5HTML5ExportCommandlet.h"

#include "FileHelpers.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "UE5HTML5DiscordActivitySettings.h"
#include "UE5HTML5ExportLibrary.h"

UUE5HTML5ExportCommandlet::UUE5HTML5ExportCommandlet()
{
    IsClient = false;
    IsEditor = true;
    IsServer = false;
    LogToConsole = true;
}

int32 UUE5HTML5ExportCommandlet::Main(const FString& Params)
{
    FString MapPath;
    FString OutputDirectory;
    FString ProjectTargetsFile;
    FString ExportProjectTargetsFile;
    const bool bCheckOnly = FParse::Param(*Params, TEXT("CheckOnly"));
    const bool bBlueprintCheckOnly = FParse::Param(*Params, TEXT("BlueprintCheckOnly"));
    const bool bFailOnUnsupported = FParse::Param(*Params, TEXT("FailOnUnsupported"));
    FParse::Value(*Params, TEXT("Map="), MapPath);
    FParse::Value(*Params, TEXT("Output="), OutputDirectory);
    FParse::Value(*Params, TEXT("ProjectTargets="), ProjectTargetsFile);
    FParse::Value(*Params, TEXT("ExportProjectTargets="), ExportProjectTargetsFile);

    if (bCheckOnly && bBlueprintCheckOnly)
    {
        UE_LOG(LogTemp, Error, TEXT("Choose either -CheckOnly or -BlueprintCheckOnly, not both."));
        return 2;
    }
    const bool bHasMapOperation = !MapPath.IsEmpty();
    const bool bMapArgumentsWithoutMap = !bHasMapOperation
        && (bCheckOnly || bBlueprintCheckOnly || bFailOnUnsupported || !OutputDirectory.IsEmpty());
    if ((MapPath.IsEmpty() && ExportProjectTargetsFile.IsEmpty())
        || bMapArgumentsWithoutMap
        || (bHasMapOperation && !bCheckOnly && !bBlueprintCheckOnly && OutputDirectory.IsEmpty()))
    {
        UE_LOG(LogTemp, Error, TEXT("Usage: -run=UE5HTML5Export [-ProjectTargets=/absolute/public-targets.json] [-ExportProjectTargets=/absolute/public-targets.json] [-Map=/Game/Maps/Main [-CheckOnly | -BlueprintCheckOnly [-FailOnUnsupported] [-Output=/absolute/report/folder] | -Output=/absolute/export/folder]]"));
        return 2;
    }

    if (!ProjectTargetsFile.IsEmpty())
    {
        FString Error;
        UUE5HTML5DiscordActivitySettings* Settings = GetMutableDefault<UUE5HTML5DiscordActivitySettings>();
        if (!Settings->ImportPublicTargets(ProjectTargetsFile, Error))
        {
            UE_LOG(LogTemp, Error, TEXT("Public project target import failed: %s"), *Error);
            return 7;
        }
        UE_LOG(LogTemp, Display, TEXT("Imported complete public Discord Activity project targets; credential fields and player data are not part of this contract."));
    }

    if (!ExportProjectTargetsFile.IsEmpty())
    {
        FString Error;
        const UUE5HTML5DiscordActivitySettings* Settings = GetDefault<UUE5HTML5DiscordActivitySettings>();
        if (!Settings->ExportPublicTargets(ExportProjectTargetsFile, Error))
        {
            UE_LOG(LogTemp, Error, TEXT("Public project target export failed: %s"), *Error);
            return 8;
        }
        UE_LOG(LogTemp, Display, TEXT("Exported allowlisted public Discord Activity project targets to %s"), *FPaths::ConvertRelativePathToFull(ExportProjectTargetsFile));
    }

    if (!bHasMapOperation)
    {
        return 0;
    }

    UWorld* World = UEditorLoadingAndSavingUtils::LoadMap(MapPath);
    if (!World)
    {
        UE_LOG(LogTemp, Error, TEXT("Could not load map: %s"), *MapPath);
        return 3;
    }

    if (bCheckOnly)
    {
        const FUE5HTML5ReadinessReport Report = FUE5HTML5ExportLibrary::CheckDiscordActivityReadiness(World);
        for (const FString& Check : Report.PassedChecks)
        {
            UE_LOG(LogTemp, Display, TEXT("Readiness passed: %s"), *Check);
        }
        for (const FString& Note : Report.Notes)
        {
            UE_LOG(LogTemp, Display, TEXT("Readiness note: %s"), *Note);
        }
        for (const FString& Blocker : Report.Blockers)
        {
            UE_LOG(LogTemp, Error, TEXT("Readiness blocker: %s"), *Blocker);
        }
        if (!Report.bReady)
        {
            UE_LOG(LogTemp, Error, TEXT("Discord Activity readiness check failed with %d blocker(s)."), Report.Blockers.Num());
            return 5;
        }
        UE_LOG(LogTemp, Display, TEXT("Discord Activity readiness check passed."));
        return 0;
    }

    if (bBlueprintCheckOnly)
    {
        if (OutputDirectory.IsEmpty())
        {
            OutputDirectory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UE5HTML5/BlueprintCompatibility"));
        }
        const FUE5HTML5BlueprintCompatibilityReport Report =
            FUE5HTML5ExportLibrary::AnalyzeBlueprintCompatibility(World, OutputDirectory);
        if (!Report.bSuccess)
        {
            UE_LOG(LogTemp, Error, TEXT("Blueprint compatibility check failed: %s"), *Report.Error);
            return 4;
        }
        UE_LOG(
            LogTemp,
            Display,
            TEXT("Blueprint compatibility: %d/%d nodes covered across %d Blueprints and %d actor instances; %d built-in, %d Blueprint-fallback-covered, %d project-adapter-covered, %d uncovered."),
            Report.SupportedNodeCount,
            Report.NodeCount,
            Report.BlueprintCount,
            Report.ActorInstanceCount,
            Report.BuiltInSupportedNodeCount,
            Report.BlueprintFallbackNodeCount,
            Report.CustomAdapterNodeCount,
            Report.UnsupportedNodeCount);
        if (Report.CustomAdapterNodeCount > 0)
        {
            UE_LOG(LogTemp, Warning, TEXT("Project-adapter coverage requires local Discord preview and gameplay validation; registration alone does not certify behavior."));
        }
        for (const FString& Node : Report.UnsupportedNodes)
        {
            UE_LOG(LogTemp, Warning, TEXT("Unsupported Blueprint node: %s"), *Node);
        }
        UE_LOG(
            LogTemp,
            Display,
            TEXT("%s"),
            *FUE5HTML5ExportLibrary::FormatDiscordAccessSummary(
                Report.DiscordFeatures,
                Report.RequiredDiscordOAuthScopes));
        UE_LOG(LogTemp, Display, TEXT("Blueprint compatibility report: %s"), *Report.ReportPath);
        if (bFailOnUnsupported && Report.UnsupportedNodeCount > 0)
        {
            UE_LOG(LogTemp, Error, TEXT("Blueprint compatibility gate failed because -FailOnUnsupported was set."));
            return 6;
        }
        return 0;
    }

    const FUE5HTML5ExportResult Result = FUE5HTML5ExportLibrary::ExportWorld(World, OutputDirectory, {});
    if (!Result.bSuccess)
    {
        UE_LOG(LogTemp, Error, TEXT("HTML5 export failed: %s"), *Result.Error);
        return 4;
    }

    UE_LOG(LogTemp, Display, TEXT("Exported %d actors to %s"), Result.ActorCount, *Result.OutputDirectory);
    UE_LOG(
        LogTemp,
        Display,
        TEXT("Blueprint compatibility: %d/%d nodes covered; %d built-in, %d Blueprint-fallback-covered, %d project-adapter-covered, %d uncovered."),
        Result.SupportedBlueprintNodeCount,
        Result.BlueprintNodeCount,
        Result.BuiltInSupportedBlueprintNodeCount,
        Result.BlueprintFallbackNodeCount,
        Result.CustomAdapterBlueprintNodeCount,
        Result.UnsupportedBlueprintNodeCount);
    UE_LOG(
        LogTemp,
        Display,
        TEXT("Primary browser payload: %.1f MiB / %.1f MiB advisory budget; largest artifact %s (%.1f MiB); review recommended: %s."),
        static_cast<double>(Result.BrowserPayloadBytes) / 1024.0 / 1024.0,
        static_cast<double>(Result.BrowserPayloadBudgetBytes) / 1024.0 / 1024.0,
        *Result.LargestBrowserArtifactPath,
        static_cast<double>(Result.LargestBrowserArtifactBytes) / 1024.0 / 1024.0,
        Result.bBrowserPayloadExceedsAdvisoryBudget ? TEXT("yes") : TEXT("no"));
    UE_LOG(
        LogTemp,
        Display,
        TEXT("%s"),
        *FUE5HTML5ExportLibrary::FormatDiscordAccessSummary(
            Result.DiscordFeatures,
            Result.RequiredDiscordOAuthScopes));
    return 0;
}
