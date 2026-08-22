using UnrealBuildTool;

public class UE5HTML5Exporter : ModuleRules
{
    public UE5HTML5Exporter(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
        PrivateDependencyModuleNames.AddRange(new[]
        {
            "AIModule",
            "BlueprintGraph",
            "DesktopPlatform",
            "EnhancedInput",
            "GLTFExporter",
            "InputCore",
            "Json",
            "AssetRegistry",
            "LevelEditor",
            "Projects",
            "Slate",
            "SlateCore",
            "ToolMenus",
            "UMG",
            "UMGEditor",
            "UnrealEd"
        });
    }
}
