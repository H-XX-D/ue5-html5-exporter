#include "UE5HTML5ExportLibrary.h"
#include "UE5BlueprintGraphExporter.h"

#include "Components/ActorComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/Blueprint.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Exporters/GLTFExporter.h"
#include "GameFramework/Actor.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformFileManager.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Options/GLTFExportOptions.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
    bool WriteManifest(const FString& OutputDirectory, UWorld* World, const TSet<AActor*>& SelectedActors, FUE5HTML5ExportResult& Result)
    {
        TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
        Root->SetStringField(TEXT("schema"), TEXT("ue5-html5-export/v2"));
        Root->SetStringField(TEXT("sourceMap"), World->GetPathName());
        Root->SetBoolField(TEXT("selectionOnly"), !SelectedActors.IsEmpty());
        Root->SetNumberField(TEXT("actorCount"), Result.ActorCount);
        Root->SetStringField(TEXT("scene"), TEXT("assets/scene.glb"));
        Root->SetStringField(TEXT("blueprintLogic"), TEXT("logic/blueprints.json"));

        TArray<TSharedPtr<FJsonValue>> WarningValues;
        for (const FString& Warning : Result.Warnings)
        {
            WarningValues.Add(MakeShared<FJsonValueString>(Warning));
        }
        Root->SetArrayField(TEXT("warnings"), WarningValues);

        TArray<TSharedPtr<FJsonValue>> Adapters;
        static const TArray<FString> AdapterNames = {
            TEXT("enhanced-input"), TEXT("replication-transport"), TEXT("interfaces-delegates"),
            TEXT("latent-async"), TEXT("physics-collision"), TEXT("gameplay-abilities"),
            TEXT("behavior-trees"), TEXT("umg-dom"), TEXT("niagara-particle-fallback"), TEXT("user-cpp-bridge"),
            TEXT("discord-activity"), TEXT("supabase-realtime"), TEXT("configurable-activity-api")
        };
        for (const FString& Adapter : AdapterNames)
        {
            Adapters.Add(MakeShared<FJsonValueString>(Adapter));
        }
        Root->SetArrayField(TEXT("runtimeAdapters"), Adapters);

        TArray<TSharedPtr<FJsonValue>> Unsupported;
        Unsupported.Add(MakeShared<FJsonValueString>(TEXT("Blueprint nodes listed as unsupported in logic/blueprints.json")));
        Unsupported.Add(MakeShared<FJsonValueString>(TEXT("Exact Niagara/Cascade graph execution and GPU simulation")));
        Unsupported.Add(MakeShared<FJsonValueString>(TEXT("Chaos rigid-body solver, constraints, and deterministic physics")));
        Unsupported.Add(MakeShared<FJsonValueString>(TEXT("Authoritative Unreal networking, relevancy, prediction, and rollback")));
        Unsupported.Add(MakeShared<FJsonValueString>(TEXT("Exact Slate layout/animation and custom widgets")));
        Unsupported.Add(MakeShared<FJsonValueString>(TEXT("Compiled user C++; register JavaScript replacements with UE5HTML5.registerFunction")));
        Unsupported.Add(MakeShared<FJsonValueString>(TEXT("Custom Unreal material shader code")));
        Root->SetArrayField(TEXT("notTransferredExactly"), Unsupported);

        FString Json;
        const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
        if (!FJsonSerializer::Serialize(Root, Writer))
        {
            return false;
        }
        return FFileHelper::SaveStringToFile(Json, *FPaths::Combine(OutputDirectory, TEXT("export-manifest.json")));
    }

    void AddActorWarnings(const AActor* Actor, FUE5HTML5ExportResult& Result)
    {
        if (!Actor)
        {
            return;
        }
        if (Actor->GetClass()->ClassGeneratedBy && Actor->GetClass()->ClassGeneratedBy->IsA<UBlueprint>())
        {
            Result.Warnings.AddUnique(FString::Printf(TEXT("Blueprint actor '%s': graph will be converted with per-node compatibility reporting."), *Actor->GetActorLabel()));
        }
    }
}

FUE5HTML5ExportResult FUE5HTML5ExportLibrary::ExportWorld(UWorld* World, const FString& OutputDirectory, const TSet<AActor*>& SelectedActors)
{
    FUE5HTML5ExportResult Result;
    Result.OutputDirectory = FPaths::ConvertRelativePathToFull(OutputDirectory);

    if (!World)
    {
        Result.Error = TEXT("No world was provided.");
        return Result;
    }

    const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("UE5HTML5Exporter"));
    if (!Plugin.IsValid())
    {
        Result.Error = TEXT("Could not locate the UE5HTML5Exporter plugin directory.");
        return Result;
    }

    const FString TemplateDirectory = FPaths::Combine(Plugin->GetBaseDir(), TEXT("Resources/WebTemplate"));
    if (!FPaths::FileExists(FPaths::Combine(TemplateDirectory, TEXT("index.html"))))
    {
        Result.Error = TEXT("The bundled web viewer is missing. Run `npm install && npm run build` in the plugin repository, then reinstall the plugin.");
        return Result;
    }

    IFileManager& Files = IFileManager::Get();
    Files.MakeDirectory(*Result.OutputDirectory, true);
    IPlatformFile& PlatformFile = FPlatformFileManager::Get().GetPlatformFile();
    if (!PlatformFile.CopyDirectoryTree(*Result.OutputDirectory, *TemplateDirectory, true))
    {
        Result.Error = TEXT("Could not copy the web viewer into the chosen folder.");
        return Result;
    }

    const FString AssetsDirectory = FPaths::Combine(Result.OutputDirectory, TEXT("assets"));
    Files.MakeDirectory(*AssetsDirectory, true);

    TArray<AActor*> ExportActors;
    if (SelectedActors.IsEmpty())
    {
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            ++Result.ActorCount;
            ExportActors.Add(*It);
            AddActorWarnings(*It, Result);
        }
    }
    else
    {
        Result.ActorCount = SelectedActors.Num();
        for (const AActor* Actor : SelectedActors)
        {
            ExportActors.Add(const_cast<AActor*>(Actor));
            AddActorWarnings(Actor, Result);
        }
    }

    const FUE5BlueprintExportSummary BlueprintSummary = FUE5BlueprintGraphExporter::Export(World, ExportActors, Result.OutputDirectory);
    if (!BlueprintSummary.bSuccess)
    {
        Result.Error = FString::Printf(TEXT("Blueprint logic export failed: %s"), *BlueprintSummary.Error);
        return Result;
    }
    Result.Warnings.Append(BlueprintSummary.Warnings);

    UGLTFExportOptions* Options = NewObject<UGLTFExportOptions>();
    const FString ScenePath = FPaths::Combine(AssetsDirectory, TEXT("scene.glb"));
    if (!UGLTFExporter::ExportToGLTF(World, ScenePath, Options, SelectedActors))
    {
        Result.Error = TEXT("Epic's glTF exporter could not export the level. Check the Unreal Output Log for material or asset errors.");
        return Result;
    }

    if (!WriteManifest(Result.OutputDirectory, World, SelectedActors, Result))
    {
        Result.Error = TEXT("The scene exported, but export-manifest.json could not be written.");
        return Result;
    }

    const FString ServeScript =
        TEXT("#!/usr/bin/env python3\n")
        TEXT("import http.server, socketserver, webbrowser\n")
        TEXT("PORT = 8000\n")
        TEXT("webbrowser.open(f'http://localhost:{PORT}')\n")
        TEXT("with socketserver.TCPServer(('localhost', PORT), http.server.SimpleHTTPRequestHandler) as server:\n")
        TEXT("    print(f'Serving UE5 export at http://localhost:{PORT} (Ctrl+C to stop)')\n")
        TEXT("    server.serve_forever()\n");
    FFileHelper::SaveStringToFile(ServeScript, *FPaths::Combine(Result.OutputDirectory, TEXT("serve.py")));

    const FString ExportReadme =
        TEXT("# UE5 Web Export\n\nRun `python3 serve.py`, then open http://localhost:8000.\n\n")
        TEXT("Upload this entire folder to any static host. Keep `index.html`, `runtime/`, and `assets/` together.\n")
        TEXT("For a Discord Activity, deploy this folder to an HTTPS host and follow `DISCORD_ACTIVITY_WORKFLOW.md`.\n")
        TEXT("The bundled Vercel adapter is the default; the Activity API endpoint is configurable in index.html.\n")
        TEXT("Before deployment, run `npm run preflight:package`, then `npm run preflight:online` with the server environment loaded.\n")
        TEXT("See `export-manifest.json` and `logic/blueprints.json` for scope and per-node compatibility warnings.\n")
        TEXT("Replace native project functions with `window.UE5HTML5.registerFunction(name, implementation)`.\n");
    FFileHelper::SaveStringToFile(ExportReadme, *FPaths::Combine(Result.OutputDirectory, TEXT("README.md")));

    Result.bSuccess = true;
    return Result;
}
