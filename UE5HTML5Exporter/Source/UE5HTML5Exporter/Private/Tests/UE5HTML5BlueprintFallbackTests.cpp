#include "UE5BlueprintGraphExporter.h"

#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUE5HTML5BlueprintFallbackPolicyTest,
    "UE5HTML5Exporter.Editor.BlueprintFallbackPolicy",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUE5HTML5BlueprintFallbackPolicyTest::RunTest(const FString& Parameters)
{
    const TSet<FString> BlueprintFunctions = {
        TEXT("webnativeapplydamage"),
        TEXT("webnativeplayeffect")
    };

    TestEqual(
        TEXT("An impure action call without connected data outputs finds its Web_ Blueprint function"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            TEXT("NativeApplyDamage"), BlueprintFunctions, false, false),
        FString(TEXT("Web_NativeApplyDamage")));
    TestTrue(
        TEXT("Pure calls cannot use a side-effect-only Blueprint fallback"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            TEXT("NativeApplyDamage"), BlueprintFunctions, true, false).IsEmpty());
    TestTrue(
        TEXT("Calls with connected data outputs cannot discard their result"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            TEXT("NativeApplyDamage"), BlueprintFunctions, false, true).IsEmpty());
    TestTrue(
        TEXT("A missing Web_ Blueprint function leaves the call unsupported"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            TEXT("NativeMissing"), BlueprintFunctions, false, false).IsEmpty());
    TestTrue(
        TEXT("An empty function name cannot create a fallback"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            FString(), BlueprintFunctions, false, false).IsEmpty());
    return true;
}

#endif
