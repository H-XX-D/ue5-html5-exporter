#include "UE5HTML5ExportLibrary.h"
#include "UE5BlueprintGraphExporter.h"
#include "UE5HTML5DiscordActivitySettings.h"
#include "UE5HTML5SHA256.h"

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
    constexpr int64 BytesPerMiB = 1024 * 1024;
    constexpr const TCHAR* ProjectAdapterSchema = TEXT("ue5-html5-custom-adapters/v1");

    FString ProjectAdapterDirectory()
    {
        return FPaths::Combine(FPaths::ProjectConfigDir(), TEXT("UE5HTML5"));
    }

    FString EmptyProjectAdapterManifest()
    {
        return FString::Printf(
            TEXT("{\n  \"schema\": \"%s\",\n  \"functions\": []\n}\n"),
            ProjectAdapterSchema);
    }

    FString EmptyProjectAdapterModule()
    {
        return TEXT("// Register project C++ or unsupported Blueprint replacements here.\n")
            TEXT("// window.UE5HTML5.registerFunction('NativeFunctionName', (args, instance, runtime) => ({ returnvalue: true }));\n")
            TEXT("export {};\n");
    }

    FString NormalizeAdapterName(const FString& Value)
    {
        FString Result;
        for (const TCHAR Character : Value)
        {
            if (FChar::IsAlnum(Character)) Result.AppendChar(FChar::ToLower(Character));
        }
        return Result;
    }

    bool PrepareProjectAdapters(
        const FString& OutputDirectory,
        TSet<FString>& OutFunctions,
        FString& OutError)
    {
        const FString SourceDirectory = ProjectAdapterDirectory();
        const FString SourceManifest = FPaths::Combine(SourceDirectory, TEXT("custom-adapters.json"));
        const FString SourceModule = FPaths::Combine(SourceDirectory, TEXT("custom-adapters.js"));
        const bool bHasManifest = FPaths::FileExists(SourceManifest);
        const bool bHasModule = FPaths::FileExists(SourceModule);
        const FString LogicDirectory = FPaths::Combine(OutputDirectory, TEXT("logic"));
        IFileManager::Get().MakeDirectory(*LogicDirectory, true);
        const FString DestinationManifest = FPaths::Combine(LogicDirectory, TEXT("custom-adapters.json"));
        const FString DestinationModule = FPaths::Combine(LogicDirectory, TEXT("custom-adapters.js"));

        if (!bHasManifest && !bHasModule)
        {
            if (!FFileHelper::SaveStringToFile(EmptyProjectAdapterManifest(), *DestinationManifest)
                || !FFileHelper::SaveStringToFile(EmptyProjectAdapterModule(), *DestinationModule))
            {
                OutError = TEXT("Could not write the empty project adapter contract into logic/.");
                return false;
            }
            return true;
        }
        if (!bHasManifest || !bHasModule)
        {
            OutError = TEXT("Config/UE5HTML5 must contain both custom-adapters.json and custom-adapters.js, or neither file.");
            return false;
        }

        FString Json;
        TSharedPtr<FJsonObject> Manifest;
        if (!FFileHelper::LoadFileToString(Json, *SourceManifest))
        {
            OutError = TEXT("Could not read Config/UE5HTML5/custom-adapters.json.");
            return false;
        }
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
        if (!FJsonSerializer::Deserialize(Reader, Manifest)
            || !Manifest.IsValid())
        {
            OutError = TEXT("Config/UE5HTML5/custom-adapters.json is not valid JSON.");
            return false;
        }
        FString Schema;
        if (!Manifest->TryGetStringField(TEXT("schema"), Schema) || Schema != ProjectAdapterSchema)
        {
            OutError = FString::Printf(TEXT("Config/UE5HTML5/custom-adapters.json must use schema %s."), ProjectAdapterSchema);
            return false;
        }
        const TArray<TSharedPtr<FJsonValue>>* Functions = nullptr;
        if (!Manifest->TryGetArrayField(TEXT("functions"), Functions) || !Functions)
        {
            OutError = TEXT("Config/UE5HTML5/custom-adapters.json.functions must be an array.");
            return false;
        }
        for (int32 Index = 0; Index < Functions->Num(); ++Index)
        {
            FString Name;
            if (!(*Functions)[Index].IsValid() || !(*Functions)[Index]->TryGetString(Name))
            {
                OutError = FString::Printf(TEXT("Custom adapter function %d must be a string."), Index);
                return false;
            }
            Name.TrimStartAndEndInline();
            const FString Normalized = NormalizeAdapterName(Name);
            if (Name.IsEmpty() || Name.Len() > 128 || Normalized.IsEmpty())
            {
                OutError = FString::Printf(TEXT("Custom adapter function %d must be a non-empty name of at most 128 characters."), Index);
                return false;
            }
            if (OutFunctions.Contains(Normalized))
            {
                OutError = FString::Printf(TEXT("Custom adapter function '%s' duplicates another declaration after normalization."), *Name);
                return false;
            }
            OutFunctions.Add(Normalized);
        }

        if (IFileManager::Get().Copy(*DestinationManifest, *SourceManifest, true, true) != COPY_OK
            || IFileManager::Get().Copy(*DestinationModule, *SourceModule, true, true) != COPY_OK)
        {
            OutError = TEXT("Could not copy the project adapter contract into logic/.");
            return false;
        }
        return true;
    }

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
            TEXT("scripts/activity-release.mjs"),
            TEXT("scripts/activity-release-assistant.mjs"),
            TEXT("release-discord-activity.cmd"),
            TEXT("release-discord-activity.command"),
            TEXT("release-discord-activity.sh")
        };
        return Files;
    }

    bool HasFilesMatching(const FString& Directory, const FString& Pattern)
    {
        TArray<FString> Matches;
        IFileManager::Get().FindFiles(Matches, *FPaths::Combine(Directory, Pattern), true, false);
        return !Matches.IsEmpty();
    }

    FString BrowserRelativePath(const FString& OutputDirectory, const FString& FilePath)
    {
        FString RelativePath = FPaths::ConvertRelativePathToFull(FilePath);
        FString Root = FPaths::ConvertRelativePathToFull(OutputDirectory);
        FPaths::NormalizeDirectoryName(Root);
        Root += TEXT("/");
        FPaths::MakePathRelativeTo(RelativePath, *Root);
        RelativePath.ReplaceInline(TEXT("\\"), TEXT("/"));
        return RelativePath;
    }

    int64 MeasureBrowserFile(
        const FString& OutputDirectory,
        const FString& FilePath,
        FUE5HTML5ExportResult& Result)
    {
        const int64 Size = IFileManager::Get().FileSize(*FilePath);
        if (Size < 0)
        {
            return 0;
        }
        const FString RelativePath = BrowserRelativePath(OutputDirectory, FilePath);
        if (Size > Result.LargestBrowserArtifactBytes
            || (Size == Result.LargestBrowserArtifactBytes
                && (Result.LargestBrowserArtifactPath.IsEmpty() || RelativePath < Result.LargestBrowserArtifactPath)))
        {
            Result.LargestBrowserArtifactBytes = Size;
            Result.LargestBrowserArtifactPath = RelativePath;
        }
        return Size;
    }

    int64 MeasureBrowserDirectory(
        const FString& OutputDirectory,
        const FString& RelativeDirectory,
        FUE5HTML5ExportResult& Result)
    {
        TArray<FString> Files;
        IFileManager::Get().FindFilesRecursive(
            Files,
            *FPaths::Combine(OutputDirectory, RelativeDirectory),
            TEXT("*"),
            true,
            false,
            false);
        Files.Sort();
        int64 Total = 0;
        for (const FString& File : Files)
        {
            Total += MeasureBrowserFile(OutputDirectory, File, Result);
        }
        return Total;
    }

    void MeasureBrowserPayload(const FString& OutputDirectory, FUE5HTML5ExportResult& Result)
    {
        const UUE5HTML5DiscordActivitySettings* ProjectSettings = GetDefault<UUE5HTML5DiscordActivitySettings>();
        Result.BrowserPayloadBudgetBytes = static_cast<int64>(FMath::Max(1, ProjectSettings->BrowserPayloadBudgetMiB)) * BytesPerMiB;
        Result.IndexBytes = MeasureBrowserFile(OutputDirectory, FPaths::Combine(OutputDirectory, TEXT("index.html")), Result);
        Result.RuntimeBytes = MeasureBrowserDirectory(OutputDirectory, TEXT("runtime"), Result);
        Result.AssetBytes = MeasureBrowserDirectory(OutputDirectory, TEXT("assets"), Result);
        Result.SceneBytes = MeasureBrowserFile(OutputDirectory, FPaths::Combine(OutputDirectory, TEXT("assets/scene.glb")), Result);
        Result.LogicBytes = MeasureBrowserDirectory(OutputDirectory, TEXT("logic"), Result);
        Result.BrowserPayloadBytes = Result.IndexBytes + Result.RuntimeBytes + Result.AssetBytes + Result.LogicBytes;
        Result.bBrowserPayloadExceedsAdvisoryBudget = Result.BrowserPayloadBytes > Result.BrowserPayloadBudgetBytes;
    }

    FString AssetPackKind(const FString& Path)
    {
        if (Path == TEXT("assets/scene.glb")) return TEXT("scene");
        if (Path == TEXT("logic/blueprints.json")) return TEXT("blueprint-ir");
        if (Path == TEXT("logic/custom-adapters.json")) return TEXT("adapter-manifest");
        return TEXT("asset");
    }

    bool BuildAssetPack(const FString& OutputDirectory, FUE5HTML5ExportResult& Result, FString& OutError)
    {
        if (!UE5HTML5::VerifySHA256())
        {
            OutError = TEXT("The portable SHA-256 implementation failed its known-vector self-check.");
            return false;
        }

        TArray<FString> Files;
        IFileManager::Get().FindFilesRecursive(
            Files,
            *FPaths::Combine(OutputDirectory, TEXT("assets")),
            TEXT("*"),
            true,
            false,
            false);
        for (const FString& RelativePath : {
            FString(TEXT("logic/blueprints.json")),
            FString(TEXT("logic/custom-adapters.json")) })
        {
            const FString File = FPaths::Combine(OutputDirectory, RelativePath);
            if (FPaths::FileExists(File)) Files.Add(File);
        }
        Files.Sort([&OutputDirectory](const FString& Left, const FString& Right) {
            return BrowserRelativePath(OutputDirectory, Left) < BrowserRelativePath(OutputDirectory, Right);
        });

        Result.AssetPackResources.Reset();
        Result.AssetPackBytes = 0;
        FString Canonical;
        for (const FString& File : Files)
        {
            const int64 FileSize = IFileManager::Get().FileSize(*File);
            if (FileSize < 0 || FileSize > static_cast<int64>(MAX_uint32))
            {
                OutError = FString::Printf(TEXT("Asset-pack resource must be readable and no larger than 4 GiB: %s"), *File);
                return false;
            }
            TArray<uint8> Bytes;
            if (!FFileHelper::LoadFileToArray(Bytes, *File))
            {
                OutError = FString::Printf(TEXT("Could not read asset-pack resource: %s"), *File);
                return false;
            }
            FUE5HTML5AssetPackResource Resource;
            Resource.Path = BrowserRelativePath(OutputDirectory, File);
            Resource.Kind = AssetPackKind(Resource.Path);
            Resource.SHA256 = UE5HTML5::SHA256Hex(Bytes.GetData(), static_cast<uint64>(Bytes.Num()));
            Resource.Bytes = FileSize;
            Result.AssetPackResources.Add(Resource);
            Result.AssetPackBytes += FileSize;
            Canonical += FString::Printf(TEXT("%s\n%lld\n%s\n"), *Resource.Path, Resource.Bytes, *Resource.SHA256);
        }

        FTCHARToUTF8 CanonicalUtf8(*Canonical);
        Result.AssetPackVersion = UE5HTML5::SHA256Hex(
            reinterpret_cast<const uint8*>(CanonicalUtf8.Get()),
            static_cast<uint64>(CanonicalUtf8.Length()));
        return true;
    }

    TSharedRef<FJsonObject> BuildAssetPackJson(const FUE5HTML5ExportResult& Result)
    {
        TSharedRef<FJsonObject> Pack = MakeShared<FJsonObject>();
        Pack->SetStringField(TEXT("schema"), TEXT("ue5-html5-asset-pack/v1"));
        Pack->SetStringField(TEXT("strategy"), TEXT("origin-scoped-cache-api"));
        Pack->SetStringField(TEXT("version"), FString::Printf(TEXT("sha256:%s"), *Result.AssetPackVersion));
        Pack->SetStringField(TEXT("runtimeStrategy"), TEXT("content-hashed-http-cache"));
        Pack->SetStringField(TEXT("scope"), TEXT("activity-origin"));
        Pack->SetStringField(TEXT("integrity"), TEXT("sha256"));
        Pack->SetStringField(TEXT("fallback"), TEXT("network"));
        Pack->SetNumberField(TEXT("bytes"), Result.AssetPackBytes);
        TArray<TSharedPtr<FJsonValue>> Resources;
        for (const FUE5HTML5AssetPackResource& Resource : Result.AssetPackResources)
        {
            TSharedRef<FJsonObject> Value = MakeShared<FJsonObject>();
            Value->SetStringField(TEXT("path"), Resource.Path);
            Value->SetStringField(TEXT("kind"), Resource.Kind);
            Value->SetNumberField(TEXT("bytes"), Resource.Bytes);
            Value->SetStringField(TEXT("sha256"), Resource.SHA256);
            Resources.Add(MakeShared<FJsonValueObject>(Value));
        }
        Pack->SetArrayField(TEXT("resources"), Resources);
        return Pack;
    }

    TSharedRef<FJsonObject> BuildAssetDelivery(const FUE5HTML5ExportResult& Result)
    {
        TSharedRef<FJsonObject> Delivery = MakeShared<FJsonObject>();
        Delivery->SetStringField(
            TEXT("status"),
            Result.bBrowserPayloadExceedsAdvisoryBudget
                ? TEXT("exceeds-advisory-budget")
                : TEXT("within-advisory-budget"));
        Delivery->SetBoolField(TEXT("advisoryOnly"), true);
        Delivery->SetNumberField(TEXT("browserPayloadBytes"), Result.BrowserPayloadBytes);
        Delivery->SetNumberField(TEXT("advisoryBudgetBytes"), Result.BrowserPayloadBudgetBytes);
        Delivery->SetNumberField(TEXT("indexBytes"), Result.IndexBytes);
        Delivery->SetNumberField(TEXT("runtimeBytes"), Result.RuntimeBytes);
        Delivery->SetNumberField(TEXT("assetBytes"), Result.AssetBytes);
        Delivery->SetNumberField(TEXT("sceneBytes"), Result.SceneBytes);
        Delivery->SetNumberField(TEXT("logicBytes"), Result.LogicBytes);
        Delivery->SetStringField(TEXT("largestArtifactPath"), Result.LargestBrowserArtifactPath);
        Delivery->SetNumberField(TEXT("largestArtifactBytes"), Result.LargestBrowserArtifactBytes);
        TArray<TSharedPtr<FJsonValue>> MeasuredPaths;
        for (const FString& Path : {
            FString(TEXT("index.html")), FString(TEXT("runtime/**")),
            FString(TEXT("assets/**")), FString(TEXT("logic/**")) })
        {
            MeasuredPaths.Add(MakeShared<FJsonValueString>(Path));
        }
        Delivery->SetArrayField(TEXT("measuredPaths"), MeasuredPaths);
        Delivery->SetStringField(
            TEXT("details"),
            TEXT("Exporter advisory only; this is not a Discord platform limit or a performance certification. Test load time, frame rate, memory, and thermal behavior on real Discord desktop and mobile clients."));
        return Delivery;
    }

    bool WriteActivityHandoff(const FString& OutputDirectory, UWorld* World, const FUE5HTML5ExportResult& Result)
    {
        TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
        Root->SetStringField(TEXT("schema"), TEXT("ue5-discord-activity-handoff/v6"));
        Root->SetStringField(TEXT("sourceMap"), World->GetPathName());
        const bool bNeedsBlueprintAdapters = Result.UnsupportedBlueprintNodeCount > 0;
        const bool bNeedsRuntimeValidation = Result.CustomAdapterBlueprintNodeCount > 0;
        Root->SetStringField(
            TEXT("handoffStatus"),
            bNeedsBlueprintAdapters
                ? TEXT("unreal-export-needs-blueprint-adapters")
                : (bNeedsRuntimeValidation ? TEXT("unreal-export-needs-runtime-validation") : TEXT("unreal-export-complete")));
        Root->SetBoolField(TEXT("standalonePlayable"), true);

        const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("UE5HTML5Exporter"));
        Root->SetStringField(TEXT("exporterVersion"), Plugin.IsValid() ? Plugin->GetDescriptor().VersionName : TEXT("unknown"));
        const UUE5HTML5DiscordActivitySettings* ProjectSettings = GetDefault<UUE5HTML5DiscordActivitySettings>();

        TSharedRef<FJsonObject> Activity = MakeShared<FJsonObject>();
        Activity->SetStringField(TEXT("apiPath"), TEXT("/api/activity"));
        Activity->SetStringField(TEXT("defaultDeploymentAdapter"), TEXT("vercel"));
        Activity->SetStringField(TEXT("persistenceAdapter"), TEXT("supabase"));
        Activity->SetStringField(
            TEXT("configurationStatus"),
            ProjectSettings->HasCompleteTargetSet() ? TEXT("project-targets-complete") : TEXT("project-targets-incomplete"));
        Activity->SetStringField(TEXT("workflow"), TEXT("DISCORD_ACTIVITY_WORKFLOW.md"));
        Activity->SetStringField(TEXT("releaseTool"), TEXT("scripts/activity-release.mjs"));
        Root->SetObjectField(TEXT("discordActivity"), Activity);

        TSharedRef<FJsonObject> ProjectTargets = MakeShared<FJsonObject>();
        ProjectTargets->SetStringField(TEXT("source"), TEXT("Unreal Project Settings > Plugins > UE5 HTML5 Discord Activity"));
        ProjectTargets->SetBoolField(TEXT("containsSecrets"), false);
        ProjectTargets->SetBoolField(TEXT("configured"), ProjectSettings->HasCompleteTargetSet());
        ProjectTargets->SetStringField(TEXT("discordApplicationId"), ProjectSettings->DiscordApplicationId);
        ProjectTargets->SetStringField(TEXT("discordPublicKey"), ProjectSettings->DiscordPublicKey);
        ProjectTargets->SetStringField(TEXT("vercelProjectName"), ProjectSettings->VercelProjectName);
        ProjectTargets->SetStringField(TEXT("supabaseProjectRef"), ProjectSettings->SupabaseProjectRef);
        ProjectTargets->SetStringField(TEXT("productionUrl"), ProjectSettings->ProductionUrl);
        TArray<FString> MissingTargetNames;
        ProjectSettings->GetMissingRequiredTargets(MissingTargetNames);
        TArray<TSharedPtr<FJsonValue>> MissingTargets;
        for (const FString& Name : MissingTargetNames)
        {
            MissingTargets.Add(MakeShared<FJsonValueString>(Name));
        }
        ProjectTargets->SetArrayField(TEXT("missingRequiredTargets"), MissingTargets);
        Root->SetObjectField(TEXT("projectTargets"), ProjectTargets);

        TArray<TSharedPtr<FJsonValue>> RequiredEnvironment;
        for (const FString& Name : {
            FString(TEXT("DISCORD_CLIENT_ID")), FString(TEXT("DISCORD_CLIENT_SECRET")),
            FString(TEXT("DISCORD_BOT_TOKEN")), FString(TEXT("SUPABASE_URL")),
            FString(TEXT("SUPABASE_PUBLISHABLE_KEY")), FString(TEXT("SUPABASE_SECRET_KEY")),
            FString(TEXT("ACTIVITY_STATE_SECRET")) })
        {
            RequiredEnvironment.Add(MakeShared<FJsonValueString>(Name));
        }
        Root->SetArrayField(TEXT("releaseEnvironment"), RequiredEnvironment);

        TArray<TSharedPtr<FJsonValue>> OptionalEnvironment;
        OptionalEnvironment.Add(MakeShared<FJsonValueString>(TEXT("SUPABASE_JWT_PRIVATE_KEY")));
        OptionalEnvironment.Add(MakeShared<FJsonValueString>(TEXT("SUPABASE_JWT_KEY_ID")));
        Root->SetArrayField(TEXT("optionalReleaseEnvironment"), OptionalEnvironment);

        TSharedRef<FJsonObject> Compatibility = MakeShared<FJsonObject>();
        Compatibility->SetStringField(
            TEXT("status"),
            bNeedsBlueprintAdapters
                ? TEXT("needs-adapters")
                : (bNeedsRuntimeValidation ? TEXT("project-adapters-require-runtime-validation") : TEXT("compatible")));
        Compatibility->SetNumberField(TEXT("blueprintCount"), Result.BlueprintCount);
        Compatibility->SetNumberField(TEXT("nodeCount"), Result.BlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("builtInSupportedNodeCount"), Result.BuiltInSupportedBlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("customAdapterNodeCount"), Result.CustomAdapterBlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("supportedNodeCount"), Result.SupportedBlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("unsupportedNodeCount"), Result.UnsupportedBlueprintNodeCount);
        Compatibility->SetStringField(TEXT("details"), TEXT("logic/blueprints.json"));
        Root->SetObjectField(TEXT("blueprintCompatibility"), Compatibility);
        Root->SetObjectField(TEXT("assetDelivery"), BuildAssetDelivery(Result));
        Root->SetObjectField(TEXT("assetPack"), BuildAssetPackJson(Result));

        TArray<TSharedPtr<FJsonValue>> ReleaseSteps;
        if (!ProjectSettings->HasCompleteTargetSet())
        {
            ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Complete the required public Discord, Vercel, and Supabase targets in Unreal Project Settings, then export again.")));
        }
        if (bNeedsBlueprintAdapters)
        {
            ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Resolve or replace the unsupported Blueprint nodes listed in logic/blueprints.json, then export again.")));
        }
        if (bNeedsRuntimeValidation)
        {
            ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Run the local Discord preview and exercise every project-owned custom adapter before release; static declaration and registration checks do not certify behavior.")));
        }
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("For a first-person target-range export, run the included certify-browser launcher and retain its passing browser-certification.json report.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Run npm install, then review the dry-run from npm run release:activity.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Review the non-secret project targets copied from Unreal Project Settings; the release tool refuses mismatched Discord, Vercel, or Supabase identities.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Re-run the release tool with --apply to migrate Supabase, configure Vercel, verify services, and create a deployment.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Copy the two printed URL mappings into the Discord Developer Portal.")));
        ReleaseSteps.Add(MakeShared<FJsonValueString>(TEXT("Complete the printed Discord portal checklist for installation contexts, OAuth2 redirect, Activity enablement, Entry Point, platforms, and metadata.")));
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
        Root->SetStringField(TEXT("schema"), TEXT("ue5-html5-export/v5"));
        const TSharedPtr<IPlugin> ExporterPlugin = IPluginManager::Get().FindPlugin(TEXT("UE5HTML5Exporter"));
        Root->SetStringField(TEXT("exporterVersion"), ExporterPlugin.IsValid() ? ExporterPlugin->GetDescriptor().VersionName : TEXT("unknown"));
        Root->SetStringField(TEXT("sourceMap"), World->GetPathName());
        Root->SetBoolField(TEXT("selectionOnly"), !SelectedActors.IsEmpty());
        Root->SetNumberField(TEXT("actorCount"), Result.ActorCount);
        Root->SetStringField(TEXT("scene"), TEXT("assets/scene.glb"));
        Root->SetStringField(TEXT("blueprintLogic"), TEXT("logic/blueprints.json"));
        Root->SetStringField(TEXT("projectAdapterManifest"), TEXT("logic/custom-adapters.json"));
        Root->SetStringField(TEXT("projectAdapterModule"), TEXT("logic/custom-adapters.js"));

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
            Result.UnsupportedBlueprintNodeCount > 0
                ? TEXT("needs-adapters")
                : (Result.CustomAdapterBlueprintNodeCount > 0
                    ? TEXT("project-adapters-require-runtime-validation")
                    : TEXT("compatible")));
        Compatibility->SetNumberField(TEXT("blueprintCount"), Result.BlueprintCount);
        Compatibility->SetNumberField(TEXT("nodeCount"), Result.BlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("builtInSupportedNodeCount"), Result.BuiltInSupportedBlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("customAdapterNodeCount"), Result.CustomAdapterBlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("supportedNodeCount"), Result.SupportedBlueprintNodeCount);
        Compatibility->SetNumberField(TEXT("unsupportedNodeCount"), Result.UnsupportedBlueprintNodeCount);
        Compatibility->SetStringField(TEXT("details"), TEXT("logic/blueprints.json"));
        Root->SetObjectField(TEXT("blueprintCompatibility"), Compatibility);
        Root->SetObjectField(TEXT("assetDelivery"), BuildAssetDelivery(Result));
        Root->SetObjectField(TEXT("assetPack"), BuildAssetPackJson(Result));

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

bool FUE5HTML5ExportLibrary::EnsureProjectAdapterFiles(FString& OutDirectory, FString& OutError)
{
    OutDirectory = ProjectAdapterDirectory();
    IFileManager::Get().MakeDirectory(*OutDirectory, true);
    const FString Manifest = FPaths::Combine(OutDirectory, TEXT("custom-adapters.json"));
    const FString Module = FPaths::Combine(OutDirectory, TEXT("custom-adapters.js"));
    if (!FPaths::FileExists(Manifest) && !FFileHelper::SaveStringToFile(EmptyProjectAdapterManifest(), *Manifest))
    {
        OutError = FString::Printf(TEXT("Could not create %s."), *Manifest);
        return false;
    }
    if (!FPaths::FileExists(Module) && !FFileHelper::SaveStringToFile(EmptyProjectAdapterModule(), *Module))
    {
        OutError = FString::Printf(TEXT("Could not create %s."), *Module);
        return false;
    }
    return true;
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
    else if (ProjectSettings->HasCompleteTargetSet())
    {
        Report.PassedChecks.Add(TEXT("All required non-secret Discord Activity project targets are valid."));
    }
    else
    {
        TArray<FString> MissingTargets;
        ProjectSettings->GetMissingRequiredTargets(MissingTargets);
        Report.Blockers.Add(FString::Printf(
            TEXT("Complete Project Settings > Plugins > UE5 HTML5 Discord Activity. Missing: %s."),
            *FString::Join(MissingTargets, TEXT(", "))));
    }

    Report.Notes.Add(TEXT("You can build the level and gameplay in Unreal; the export includes the browser runtime and deployment files."));
    Report.Notes.Add(TEXT("This prerequisite check does not certify gameplay; exact Blueprint compatibility is measured and reported during export."));
    Report.Notes.Add(TEXT("The Unreal project may store only public target identity; credentials remain with the release operator and are never written into the export handoff."));
    Report.Notes.Add(TEXT("Every export includes activity-handoff.json and per-Blueprint compatibility details."));
    Report.bReady = Report.Blockers.IsEmpty();
    return Report;
}

FUE5HTML5BlueprintCompatibilityReport FUE5HTML5ExportLibrary::AnalyzeBlueprintCompatibility(
    UWorld* World,
    const FString& OutputDirectory)
{
    FUE5HTML5BlueprintCompatibilityReport Report;
    if (!World)
    {
        Report.Error = TEXT("No Unreal world is loaded.");
        return Report;
    }
    if (OutputDirectory.IsEmpty())
    {
        Report.Error = TEXT("Choose a Blueprint compatibility report directory.");
        return Report;
    }

    Report.OutputDirectory = FPaths::ConvertRelativePathToFull(OutputDirectory);
    if (!IFileManager::Get().MakeDirectory(*Report.OutputDirectory, true))
    {
        Report.Error = FString::Printf(TEXT("Could not create compatibility report directory: %s"), *Report.OutputDirectory);
        return Report;
    }

    TArray<AActor*> Actors;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        Actors.Add(*It);
    }

    TSet<FString> CustomAdapterFunctions;
    FString AdapterError;
    if (!PrepareProjectAdapters(Report.OutputDirectory, CustomAdapterFunctions, AdapterError))
    {
        Report.Error = AdapterError;
        return Report;
    }
    const FUE5BlueprintExportSummary Summary = FUE5BlueprintGraphExporter::Export(
        World,
        Actors,
        Report.OutputDirectory,
        CustomAdapterFunctions);
    if (!Summary.bSuccess)
    {
        Report.Error = Summary.Error;
        return Report;
    }

    Report.BlueprintCount = Summary.BlueprintCount;
    Report.ActorInstanceCount = Summary.ActorInstanceCount;
    Report.NodeCount = Summary.NodeCount;
    Report.BuiltInSupportedNodeCount = Summary.BuiltInSupportedNodeCount;
    Report.CustomAdapterNodeCount = Summary.CustomAdapterNodeCount;
    Report.SupportedNodeCount = Summary.SupportedNodeCount;
    Report.UnsupportedNodeCount = Summary.UnsupportedNodeCount;
    Report.UnsupportedNodes = Summary.UnsupportedNodes;
    Report.ReportPath = FPaths::Combine(Report.OutputDirectory, TEXT("BLUEPRINT_COMPATIBILITY.txt"));

    FString Text = FString::Printf(
        TEXT("UE5 HTML5 BLUEPRINT COMPATIBILITY\n")
        TEXT("=================================\n\n")
        TEXT("Map: %s\n")
        TEXT("Blueprints: %d\n")
        TEXT("Actor instances: %d\n")
        TEXT("Covered nodes: %d / %d\n")
        TEXT("Built-in runtime nodes: %d\n")
        TEXT("Project-adapter-covered nodes: %d\n")
        TEXT("Nodes requiring web adapters: %d\n\n"),
        *World->GetPathName(),
        Report.BlueprintCount,
        Report.ActorInstanceCount,
        Report.SupportedNodeCount,
        Report.NodeCount,
        Report.BuiltInSupportedNodeCount,
        Report.CustomAdapterNodeCount,
        Report.UnsupportedNodeCount);

    if (Report.CustomAdapterNodeCount > 0)
    {
        Text += TEXT("Project-adapter coverage requires browser registration checks plus local Discord preview and gameplay validation.\n\n");
    }

    if (Report.UnsupportedNodes.IsEmpty())
    {
        Text += TEXT("No unsupported Blueprint nodes were found in the current export scope.\n");
    }
    else
    {
        Text += TEXT("NODES REQUIRING ADAPTERS\n------------------------\n");
        for (const FString& Node : Report.UnsupportedNodes)
        {
            Text += FString::Printf(TEXT("- %s\n"), *Node);
        }
    }
    Text += TEXT("\nScope: placed Blueprint actors plus the map's runtime GameMode, Pawn, PlayerController, HUD, GameState, PlayerState, and Spectator classes.\n")
        TEXT("Project adapter contract: Config/UE5HTML5/custom-adapters.json + custom-adapters.js. Declared coverage is checked again when the browser module loads, but only gameplay testing can validate behavior.\n")
        TEXT("This is a fast translator-coverage audit. It does not export scene assets and does not certify runtime behavior, networking, Discord authentication, device performance, or browser fidelity.\n")
        TEXT("Machine-readable IR: logic/blueprints.json\n");

    if (!FFileHelper::SaveStringToFile(Text, *Report.ReportPath))
    {
        Report.Error = FString::Printf(TEXT("Could not write compatibility report: %s"), *Report.ReportPath);
        return Report;
    }
    Report.bSuccess = true;
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

    TSet<FString> CustomAdapterFunctions;
    FString AdapterError;
    if (!PrepareProjectAdapters(Result.OutputDirectory, CustomAdapterFunctions, AdapterError))
    {
        Result.Error = AdapterError;
        return Result;
    }
    const FUE5BlueprintExportSummary BlueprintSummary = FUE5BlueprintGraphExporter::Export(
        World,
        ExportActors,
        Result.OutputDirectory,
        CustomAdapterFunctions);
    if (!BlueprintSummary.bSuccess)
    {
        Result.Error = FString::Printf(TEXT("Blueprint logic export failed: %s"), *BlueprintSummary.Error);
        return Result;
    }
    Result.BlueprintCount = BlueprintSummary.BlueprintCount;
    Result.BlueprintNodeCount = BlueprintSummary.NodeCount;
    Result.BuiltInSupportedBlueprintNodeCount = BlueprintSummary.BuiltInSupportedNodeCount;
    Result.CustomAdapterBlueprintNodeCount = BlueprintSummary.CustomAdapterNodeCount;
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

    MeasureBrowserPayload(Result.OutputDirectory, Result);
    if (Result.bBrowserPayloadExceedsAdvisoryBudget)
    {
        Result.Warnings.Add(FString::Printf(
            TEXT("Primary browser payload is %.1f MiB, above the project advisory budget of %.1f MiB. This is not a Discord platform limit; review asset size and test real desktop and mobile clients."),
            static_cast<double>(Result.BrowserPayloadBytes) / BytesPerMiB,
            static_cast<double>(Result.BrowserPayloadBudgetBytes) / BytesPerMiB));
    }

    FString AssetPackError;
    if (!BuildAssetPack(Result.OutputDirectory, Result, AssetPackError))
    {
        Result.Error = FString::Printf(TEXT("The scene exported, but its reusable browser asset pack could not be indexed: %s"), *AssetPackError);
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

    const FString ExportReadme =
        TEXT("# UE5 Web Export\n\nRun `python3 serve.py` for an ordinary browser preview, use the preview-discord-activity launcher to exercise Discord Blueprint logic with the official local SDK mock, or use the certify-browser launcher to prove cold/warm asset delivery, advisory local runtime-ready/frame pacing, and baseline FPS target behavior.\n\n")
        TEXT("Upload this entire folder to any static host. Keep `index.html`, `runtime/`, and `assets/` together.\n")
        TEXT("For a Discord Activity, deploy this folder to an HTTPS host and follow `DISCORD_ACTIVITY_WORKFLOW.md`.\n")
        TEXT("The bundled Vercel adapter is the default; the Activity API endpoint is configurable in index.html.\n")
        TEXT("Before deployment, run `npm run preflight:package`, then `npm run preflight:online` with the server environment loaded.\n")
        TEXT("Give the entire folder to the release operator; `activity-handoff.json` records whether Blueprint adapters remain and lists the release steps.\n")
        TEXT("See `export-manifest.json` and `logic/blueprints.json` for scope and per-node compatibility warnings.\n")
        TEXT("`export-manifest.json` also records exact primary browser payload bytes against the project advisory budget. This is not a Discord platform limit or a performance certification.\n")
        TEXT("Reusable scene and Blueprint data are integrity-checked and cached under this Activity origin. A changed asset-pack hash creates a new cache, and cache unavailability falls back to the network.\n")
        TEXT("A passing `browser-certification.json` proves the local exported browser runtime, cache, center-ray target hit, score, and respawn and records advisory timing-only performance without device metadata; real Discord/mobile/multi-client testing remains required.\n")
        TEXT("Create project-owned native replacements from Tools > HTML5 Export > Open Custom Web Adapters Folder, then declare them in custom-adapters.json and implement them with `window.UE5HTML5.registerFunction(name, implementation)`.\n")
        TEXT("Project-adapter coverage still requires local Discord preview and real gameplay validation.\n");
    FFileHelper::SaveStringToFile(ExportReadme, *FPaths::Combine(Result.OutputDirectory, TEXT("README.md")));

    Result.bSuccess = true;
    return Result;
}
