using UnrealBuildTool;

public class UE5HTML5ExporterRuntime : ModuleRules
{
    public UE5HTML5ExporterRuntime(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
    }
}
