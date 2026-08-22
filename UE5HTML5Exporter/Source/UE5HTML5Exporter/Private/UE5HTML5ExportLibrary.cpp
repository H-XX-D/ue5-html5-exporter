#include "UE5HTML5ExportLibrary.h"
#include "UE5BlueprintGraphExporter.h"
#include "UE5HTML5DiscordActivitySettings.h"

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
            TEXT("scripts/activity-preflight.mjs"),
            TEXT("scripts/activity-release.mjs")
        };
        return Files;
    }

    bool HasFilesMatching(const FString& Directory, const FString& Pattern)
    {
        TArray<FString> Matches;
        IFileManager::Get().FindFiles(Matches, *FPaths::Combine(Directory, Pattern), true, false);
        return !Matches.IsEmpty();
    }

    bool WriteActivityHandoff(const FString& OutputDirectory, UWorld* World, const FUE5HTML5ExportResult& Result)
    {
        TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
        Root->SetStringField(TEXT("schema"), TEXT("ue5-discord-activity-handoff/v3"));
        Root->SetStringField(TEXT("sourceMap"), World->GetPathName());
        const bool bNeedsBlueprintAdapters = Result.UnsupportedBlueprintNodeCount > 0;
        Root->SetStringField(
            TEXT("handoffStatus"),
            bNeedsBlueprintAdapters ? TEXT("unreal-export-needs-blueprint-adapters") : TEXT("unreal-export-complete"));
        Root->SetBoolField(TEXT("standalonePlayable"), true);

        const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("UE5HTML5Exporter"));
        Root->SetStringField(TEXT("exporterVersion"), Plugin.IsValid() ? Plugin->GetDescriptor().VersionName : TEXT("unknown"));

        TSharedRef<FJsonObject> Activity = MakeShared<FJsonObject>();
        Activity->SetStringField(TEXT("apiPath"), TEXT("/api/activity"));
        Activity->SetStringField(TEXT("defaultDeploymentAdapter"), TEXT("vercel"));
        Activity->SetStringField(TEXT("persistenceAdapter"), TEXT("supabase"));
        Activity->SetStringField(TEXT("configurationStatus"), TEXT("release-operator-required"));
        Activity->SetStringField(TEXT("workflow"), TEXT("DISCORD_ACTIVITY_WORKFLOW.md"));
        Activity->SetStringField(TEXT("releaseTool"), TEXT("scripts/activity-release.mjs"));
        Root->SetObjectField(TEXT("discordActivity"), Activity);

        const UUE5HTML5DiscordActivitySettings* ProjectSettings = GetDefault<UUE5HTML5DiscordActivitySettings>();
        TSharedRef<FJsonObject> ProjectTargets = MakeShared<FJsonObject>();
        ProjectTargets->SetStringField(TEXT("source"), TEXT("Unreal Project Settings > Plugins > UE5 HTML5 Discord Activity"));
        ProjectTargets->SetBoolField(TEXT("containsSecrets"), false);
        ProjectTargets->SetBoolField(TEXT("configured"), ProjectSettings->HasAnyTarget());
        ProjectTargets->SetStringField(TEXT("discordApplicationId"), ProjectSettings->DiscordApplicationId);
        ProjectTargets->SetStringField(TEXT("discordPublicKey"), ProjectSettings->DiscordPublicKey);
        ProjectTargets->SetStringField(TEXT("vercelProjectName"), ProjectSettings->VercelProjectName);
        ProjectTargets->SetStringField(TEXT("supabaseProjectRef"), ProjectSettings->SupabaseProjectRef);
        ProjectTargets->SetStringField(TEXT("productionUrl"), ProjectSettings->ProductionUrl);
        Root->SetObjectField(TEXT("projectTargets"), ProjectTargets);

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

        TSharedRef<FJsonObject> Compatibility = MakeShared<FJsonObject>();
        Compatibility->SetStringField(TEXT("status"), bNeedsBlueprintAdapters ? TEXT("needs-adapters") : TEXT("compatible"));
        Compatibility->SetNumberField(TEXT("blueprintCount"), Result.BlueprintCount);
        Compatibility->SetNumberField(TEXT("nodeCount"), Result.BlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("supportedNodeCount"), Result.SupportedBlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("unsupportedNodeCount"), Result.UnsupportedBlueprintNodeCount);
        Compatibility->SetStringField(TEXT("details"), TEXT("logic/blueprints.json"));
        Root->SetObjectField(TEXT("blueprintCompatibility"), Compatibility);

        TArray<TSharedPtr<FJsonValue>> ReleaseSteps;
        if (bNeedsBlueprintAdapters)
        {
            ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Resolve or replace the unsupported Blueprint nodes listed in logic/blueprints.json, then export again.")));
        }
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Run npm install, then review the dry-run from npm run release:activity.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Review the non-secret project targets copied from Unreal Project Settings; the release tool refuses mismatched Discord, Vercel, or Supabase identities.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Re-run the release tool with --apply to migrate Supabase, configure Vercel, verify services, and create a deployment.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Copy the two printed URL mappings into the Discord Developer Portal.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Launch the deployment inside Discord and test with two participants.")));
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

        TSharedRef<FJsonObject> Compatibility = MakeShared<FJsonObject>();
        Compatibility->SetStringField(
            TEXT("status"),
            Result.UnsupportedBlueprintNodeCount > 0 ? TEXT("needs-adapters") : TEXT("compatible"));
        Compatibility->SetNumberField(TEXT("blueprintCount"), Result.BlueprintCount);
        Compatibility->SetNumberField(TEXT("nodeCount"), Result.BlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("supportedNodeCount"), Result.SupportedBlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("unsupportedNodeCount"), Result.UnsupportedBlueprintNodeCount);
        Compatibility->SetStringField(TEXT("details"), TEXT("logic/blueprints.json"));
        Root->SetObjectField(TEXT("blueprintCompatibility"), Compatibility);

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

    const UUE5HTML5DiscordActivitySettings* ProjectSettings = GetDefault<UUE5HTML5DiscordActivitySettings>();
    TArray<FString> TargetErrors;
    ProjectSettings->ValidateTargets(TargetErrors);
    if (!TargetErrors.IsEmpty())
    {
        for (const FString& Error : TargetErrors)
        {
            Report.Blockers.Add(FString::Printf(TEXT("Discord Activity Project Settings: %s"), *Error));
        }
    }
    else if (ProjectSettings->HasAnyTarget())
    {
        Report.PassedChecks.Add(TEXT("Shared non-secret Discord Activity project targets are valid."));
    }
    else
    {
        Report.Notes.Add(TEXT("Optional: set public project targets under Project Settings > Plugins > UE5 HTML5 Discord Activity to prevent release to the wrong app."));
    }

    Report.Notes.Add(TEXT("You can build the level and gameplay in Unreal; the export includes the browser runtime and deployment files."));
    Report.Notes.Add(TEXT("This prerequisite check does not certify gameplay; exact Blueprint compatibility is measured and reported during export."));
    Report.Notes.Add(TEXT("The Unreal project may store only public target identity; credentials remain with the release operator and are never written into the export handoff."));
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
    Result.BlueprintCount = BlueprintSummary.BlueprintCount;
    Result.BlueprintNodeCount = BlueprintSummary.NodeCount;
    Result.SupportedBlueprintNodeCount = BlueprintSummary.SupportedNodeCount;
    Result.UnsupportedBlueprintNodeCount = BlueprintSummary.UnsupportedNodeCount;
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

    if (!WriteActivityHandoff(Result.OutputDirectory, World, Result))
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
        TEXT("Give the entire folder to the release operator; `activity-handoff.json` records whether Blueprint adapters remain and lists the release steps.\n")
        TEXT("See `export-manifest.json` and `logic/blueprints.json` for scope and per-node compatibility warnings.\n")
        TEXT("Replace native project functions with `window.UE5HTML5.registerFunction(name, implementation)`.\n");
    FFileHelper::SaveStringToFile(ExportReadme, *FPaths::Combine(Result.OutputDirectory, TEXT("README.md")));

    Result.bSuccess = true;
    return Result;
}
