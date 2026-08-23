#include "UE5HTML5ExportLibrary.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "HAL/FileManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUE5HTML5ReleaseReceiptWorkspaceTest,
    "UE5HTML5Exporter.Editor.ReleaseReceiptWorkspace",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUE5HTML5ReleaseReceiptWorkspaceTest::RunTest(const FString& Parameters)
{
    const FString FixtureDirectory = FPaths::Combine(FPaths::AutomationTransientDir(), TEXT("UE5HTML5ReleaseReceiptWorkspace"));
    IFileManager::Get().DeleteDirectory(*FixtureDirectory, false, true);
    IFileManager::Get().MakeDirectory(*FixtureDirectory, true);
    const FString ReceiptPath = FPaths::Combine(FixtureDirectory, TEXT("operator-receipt.json"));
    const FString Receipt = TEXT("{\n  \"schema\": \"ue5-discord-activity-release-receipt/v1\"\n}\n");
    TestTrue(TEXT("Receipt fixture is written"), FFileHelper::SaveStringToFile(Receipt, *ReceiptPath));

    FString Workspace;
    FString Error;
    TestTrue(
        TEXT("A bounded receipt creates a self-contained verification workspace"),
        FUE5HTML5ExportLibrary::PrepareReleaseReceiptVerification(ReceiptPath, Workspace, Error));
    TestTrue(TEXT("Workspace error remains empty"), Error.IsEmpty());
    const TArray<FString> ExpectedFiles = {
        TEXT("activity-release-receipt.json"),
        TEXT("verify-discord-activity-release.cmd"),
        TEXT("verify-discord-activity-release.command"),
        TEXT("verify-discord-activity-release.sh"),
        TEXT("scripts/Start-DiscordActivityRelease.ps1"),
        TEXT("scripts/activity-preflight.mjs"),
        TEXT("scripts/activity-release.mjs"),
        TEXT("scripts/activity-release-receipt.mjs")
    };
    for (const FString& RelativePath : ExpectedFiles)
    {
        TestTrue(*FString::Printf(TEXT("Workspace contains %s"), *RelativePath), FPaths::FileExists(FPaths::Combine(Workspace, RelativePath)));
    }
    FString CopiedReceipt;
    TestTrue(
        TEXT("Copied receipt remains readable"),
        FFileHelper::LoadFileToString(CopiedReceipt, *FPaths::Combine(Workspace, TEXT("activity-release-receipt.json"))));
    TestEqual(TEXT("Selected receipt is copied byte-for-text"), CopiedReceipt, Receipt);

    const FString OversizedPath = FPaths::Combine(FixtureDirectory, TEXT("oversized.json"));
    TestTrue(TEXT("Oversized fixture is written"), FFileHelper::SaveStringToFile(FString::ChrN(64 * 1024 + 1, TEXT('x')), *OversizedPath));
    FString RejectedWorkspace;
    FString RejectedError;
    TestFalse(
        TEXT("An oversized receipt is rejected before workspace replacement"),
        FUE5HTML5ExportLibrary::PrepareReleaseReceiptVerification(OversizedPath, RejectedWorkspace, RejectedError));
    TestTrue(TEXT("Oversized rejection is actionable"), RejectedError.Contains(TEXT("between 1 and")));

    IFileManager::Get().DeleteDirectory(*FixtureDirectory, false, true);
    IFileManager::Get().DeleteDirectory(*Workspace, false, true);
    return true;
}

#endif
