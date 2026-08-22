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
    const TArray<FString>& RequiredActivityTemplateFiles()
    {
        static const TArray<FString> Files = {
            TEXT("index.html"),
            TEXT("api/activity.mjs"),
            TEXT("vercel.json"),
            TEXT("package.json"),
            TEXT(".env.example"),
            TEXT("DISCORD_ACTIVITY_WORKFLOW.md"),
            TEXT("scripts/activity-preflight.mjs")
        };
        return Files;
    }

    bool HasFilesMatching(const FString& Directory, const FString& Pattern)
    {
        TArray<FString> Matches;
        IFileManager::Get().FindFiles(Matches, *FPaths::Combine(Directory, Pattern), true, false);
        return !Matches.IsEmpty();
    }

    bool WriteActivityHandoff(const FString& OutputDirectory, UWorld* World)
    {
        TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
        Root->SetStringField(TEXT("schema"), TEXT("ue5-discord-activity-handoff/v1"));
        Root->SetStringField(TEXT("sourceMap"), World->GetPathName());
        Root->SetStringField(TEXT("handoffStatus"), TEXT("unreal-export-complete"));
        Root->SetBoolField(TEXT("standalonePlayable"), true);

        const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("UE5HTML5Exporter"));
        Root->SetStringField(TEXT("exporterVersion"), Plugin.IsValid() ? Plugin->GetDescriptor().VersionName : TEXT("unknown"));

        TSharedRef<FJsonObject> Activity = MakeShared<FJsonObject>();
        Activity->SetStringField(TEXT("apiPath"), TEXT("/api/activity"));
        Activity->SetStringField(TEXT("defaultDeploymentAdapter"), TEXT("vercel"));
        Activity->SetStringField(TEXT("persistenceAdapter"), TEXT("supabase"));
        Activity->SetStringField(TEXT("configurationStatus"), TEXT("release-operator-required"));
        Activity->SetStringField(TEXT("workflow"), TEXT("DISCORD_ACTIVITY_WORKFLOW.md"));
        Root->SetObjectField(TEXT("discordActivity"), Activity);

        TArray<TSharedPtr<FJsonValue>> RequiredEnvironment;
        for (const FString& Name : {
            FString(TEXT("DISCORD_CLIENT_ID")), FString(TEXT("DISCORD_CLIENT_SECRET")),
            FString(TEXT("DISCORD_BOT_TOKEN")), FString(TEXT("SUPABASE_URL")),
            FString(TEXT("SUPABASE_PUBLISHABLE_KEY")), FString(TEXT("SUPABASE_SECRET_KEY")),
            FString(TEXT("SUPABASE_JWT_PRIVATE_KEY")), FString(TEXT("ACTIVITY_STATE_SECRET")) })
        {
            RequiredEnvironment.Add(MakeShared<FJsonValueString>(Name));
        }
        Root->SetArrayField(TEXT("releaseEnvironment"), RequiredEnvironment);

        TArray<TSharedPtr<FJsonValue>> ReleaseSteps;
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Run npm install and npm run preflight:package in this folder.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Select a Discord test Activity and a Supabase project; do not reuse an existing production app by accident.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Apply the included Supabase migration and configure server-only environment values.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Deploy to an HTTPS host and map the public URL in the Discord Developer Portal.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Run npm run preflight:online and test with two Discord participants.")));
        Root->SetArrayField(TEXT("releaseSteps"), ReleaseSteps);

        TSharedRef<FJsonObject> Privacy = MakeShared<FJsonObject>();
        Privacy->SetBoolField(TEXT("storesDiscordProfile"), false);
        Privacy->SetBoolField(TEXT("storesEmail"), false);
        Privacy->SetBoolField(TEXT("storesBillingDetails"), false);
        Privacy->SetStringField(TEXT("allowedPersistence"), TEXT("game-created world and player state under opaque server-derived keys"));
        Root->SetObjectField(TEXT("privacyBoundary"), Privacy);

        FString Json;
        const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
        return FJsonSerializer::Serialize(Root, Writer)
            && FFileHelper::SaveStringToFile(Json, *FPaths::Combine(OutputDirectory, TEXT("activity-handoff.json")));
    }

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

FUE5HTML5ReadinessReport FUE5HTML5ExportLibrary::CheckDiscordActivityReadiness(UWorld* World)
{
    FUE5HTML5ReadinessReport Report;

    if (World)
    {
        Report.PassedChecks.Add(FString::Printf(TEXT("Open level: %s"), *World->GetName()));
    }
    else
    {
        Report.Blockers.Add(TEXT("Open the level you want to export."));
    }

    const TSharedPtr<IPlugin> GLTFPlugin = IPluginManager::Get().FindPlugin(TEXT("GLTFExporter"));
    if (GLTFPlugin.IsValid() && GLTFPlugin->IsEnabled())
    {
        Report.PassedChecks.Add(TEXT("Epic glTF Exporter is enabled."));
    }
    else
    {
        Report.Blockers.Add(TEXT("Enable Epic's GLTF Exporter plugin and restart Unreal Editor."));
    }

    const TSharedPtr<IPlugin> ExporterPlugin = IPluginManager::Get().FindPlugin(TEXT("UE5HTML5Exporter"));
    if (!ExporterPlugin.IsValid())
    {
        Report.Blockers.Add(TEXT("UE5HTML5Exporter is not installed as a discoverable Unreal plugin."));
    }
    else
    {
        const FString TemplateDirectory = FPaths::Combine(ExporterPlugin->GetBaseDir(), TEXT("Resources/WebTemplate"));
        TArray<FString> MissingFiles;
        for (const FString& RelativePath : RequiredActivityTemplateFiles())
        {
            if (!FPaths::FileExists(FPaths::Combine(TemplateDirectory, RelativePath)))
            {
                MissingFiles.Add(RelativePath);
            }
        }
        if (!HasFilesMatching(FPaths::Combine(TemplateDirectory, TEXT("runtime")), TEXT("viewer-*.js")))
        {
            MissingFiles.Add(TEXT("runtime/viewer-<content-hash>.js"));
        }
        if (!HasFilesMatching(FPaths::Combine(TemplateDirectory, TEXT("runtime")), TEXT("discord-activity-*.js")))
        {
            MissingFiles.Add(TEXT("runtime/discord-activity-<content-hash>.js"));
        }
        if (!HasFilesMatching(FPaths::Combine(TemplateDirectory, TEXT("supabase/migrations")), TEXT("*.sql")))
        {
            MissingFiles.Add(TEXT("supabase/migrations/<migration>.sql"));
        }

        if (MissingFiles.IsEmpty())
        {
            Report.PassedChecks.Add(FString::Printf(TEXT("Bundled Discord Activity runtime is complete (exporter %s)."), *ExporterPlugin->GetDescriptor().VersionName));
        }
        else
        {
            Report.Blockers.Add(FString::Printf(TEXT("The plugin package is incomplete. Reinstall it; missing: %s"), *FString::Join(MissingFiles, TEXT(", "))));
        }
    }

    Report.Notes.Add(TEXT("You can build the level and gameplay in Unreal; the export includes the browser runtime and deployment files."));
    Report.Notes.Add(TEXT("The release operator supplies Discord and Supabase configuration after export; no credentials belong in the Unreal project."));
    Report.Notes.Add(TEXT("Every export includes activity-handoff.json and per-Blueprint compatibility details."));
    Report.bReady = Report.Blockers.IsEmpty();
    return Report;
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

    if (!WriteActivityHandoff(Result.OutputDirectory, World))
    {
        Result.Error = TEXT("The scene exported, but activity-handoff.json could not be written.");
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
        TEXT("Give the entire folder to the release operator; `activity-handoff.json` lists their remaining configuration steps.\n")
        TEXT("See `export-manifest.json` and `logic/blueprints.json` for scope and per-node compatibility warnings.\n")
        TEXT("Replace native project functions with `window.UE5HTML5.registerFunction(name, implementation)`.\n");
    FFileHelper::SaveStringToFile(ExportReadme, *FPaths::Combine(Result.OutputDirectory, TEXT("README.md")));

    Result.bSuccess = true;
    return Result;
}
