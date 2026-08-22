#include "UE5HTML5ExportCommandlet.h"

#include "FileHelpers.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
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
    FParse::Value(*Params, TEXT("Map="), MapPath);
    FParse::Value(*Params, TEXT("Output="), OutputDirectory);

    if (MapPath.IsEmpty() || OutputDirectory.IsEmpty())
    {
        UE_LOG(LogTemp, Error, TEXT("Usage: -run=UE5HTML5Export -Map=/Game/Maps/Main -Output=/absolute/output/folder"));
        return 2;
    }

    UWorld* World = UEditorLoadingAndSavingUtils::LoadMap(MapPath);
    if (!World)
    {
        UE_LOG(LogTemp, Error, TEXT("Could not load map: %s"), *MapPath);
        return 3;
    }

    const FUE5HTML5ExportResult Result = FUE5HTML5ExportLibrary::ExportWorld(World, OutputDirectory, {});
    if (!Result.bSuccess)
    {
        UE_LOG(LogTemp, Error, TEXT("HTML5 export failed: %s"), *Result.Error);
        return 4;
    }

    UE_LOG(LogTemp, Display, TEXT("Exported %d actors to %s"), Result.ActorCount, *Result.OutputDirectory);
    return 0;
}
