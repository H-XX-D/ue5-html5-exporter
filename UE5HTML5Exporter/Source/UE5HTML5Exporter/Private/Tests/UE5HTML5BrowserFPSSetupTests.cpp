#if WITH_AUTOMATION_TESTS

#include "UE5HTML5BrowserFPSSetup.h"

#include "Editor.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerStart.h"
#include "Misc/AutomationTest.h"
#include "Tests/AutomationEditorCommon.h"
#include "UE5HTML5PracticeTargetActor.h"
#include "UE5HTML5TargetComponent.h"

namespace
{
    int32 CountTargets(UWorld* World)
    {
        int32 Count = 0;
        for (TActorIterator<AActor> Iterator(World); Iterator; ++Iterator)
        {
            Count += Iterator->FindComponentByClass<UUE5HTML5TargetComponent>() ? 1 : 0;
        }
        return Count;
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUE5HTML5BrowserFPSSetupTest,
    "UE5HTML5Exporter.Editor.BrowserFPSSetup",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUE5HTML5BrowserFPSSetupTest::RunTest(const FString& Parameters)
{
    UWorld* World = FAutomationEditorCommonUtils::CreateNewMap();
    if (!TestNotNull(TEXT("Created an isolated editor map"), World))
    {
        return false;
    }

    const FUE5HTML5BrowserFPSSetupResult MissingStart =
        FUE5HTML5BrowserFPSSetup::Apply(World, false, false);
    TestEqual(
        TEXT("Setup refuses to mutate without a Player Start"),
        MissingStart.Status,
        EUE5HTML5BrowserFPSSetupStatus::MissingPlayerStart);
    TestEqual(TEXT("No target exists before setup"), CountTargets(World), 0);

    APlayerStart* FirstStart = Cast<APlayerStart>(GEditor->AddActor(
        World->GetCurrentLevel(),
        APlayerStart::StaticClass(),
        FTransform(FRotator::ZeroRotator, FVector(25.0f, 50.0f, 75.0f)),
        false,
        RF_Transactional,
        false));
    if (!TestNotNull(TEXT("Created the first Player Start"), FirstStart))
    {
        return false;
    }
    GEditor->SelectNone(false, true, false);
    TestEqual(
        TEXT("Falls back to the first Player Start when none is selected"),
        FUE5HTML5BrowserFPSSetup::FindPreferredPlayerStart(World),
        FirstStart);

    const FVector SelectedLocation(100.0f, 200.0f, 300.0f);
    APlayerStart* SelectedStart = Cast<APlayerStart>(GEditor->AddActor(
        World->GetCurrentLevel(),
        APlayerStart::StaticClass(),
        FTransform(FRotator(0.0f, 90.0f, 0.0f), SelectedLocation),
        false,
        RF_Transactional,
        false));
    if (!TestNotNull(TEXT("Created the selected Player Start"), SelectedStart))
    {
        return false;
    }
    GEditor->SelectActor(SelectedStart, true, true, true);
    TestEqual(
        TEXT("Selected Player Start takes precedence"),
        FUE5HTML5BrowserFPSSetup::FindPreferredPlayerStart(World),
        SelectedStart);

    const FUE5HTML5BrowserFPSSetupResult Preview =
        FUE5HTML5BrowserFPSSetup::Apply(World, false, false);
    TestEqual(
        TEXT("Preview reports that creation needs confirmation"),
        Preview.Status,
        EUE5HTML5BrowserFPSSetupStatus::ReadyToCreate);
    TestEqual(TEXT("Preview does not create a target"), CountTargets(World), 0);

    const FUE5HTML5BrowserFPSSetupResult Created =
        FUE5HTML5BrowserFPSSetup::Apply(World, true, false);
    TestEqual(TEXT("Setup creates a target"), Created.Status, EUE5HTML5BrowserFPSSetupStatus::Created);
    AUE5HTML5PracticeTargetActor* Target = Cast<AUE5HTML5PracticeTargetActor>(Created.TargetActor);
    if (!TestNotNull(TEXT("Created the practice-target actor"), Target))
    {
        return false;
    }

    const FVector ExpectedLocation(100.0f, 800.0f, 365.0f);
    TestTrue(TEXT("Target is six meters forward at camera height"), Target->GetActorLocation().Equals(ExpectedLocation, 0.1f));
    TestTrue(TEXT("Target faces the Player Start"), FMath::IsNearlyEqual(Target->GetActorRotation().Yaw, -90.0f, 0.1f));
    TestEqual(TEXT("Target receives the portable actor label"), Target->GetActorLabel(), FString(TEXT("UE5HTML5_PracticeTarget")));
    TestTrue(TEXT("Target is transactional"), Target->HasAnyFlags(RF_Transactional));
    TestNotNull(TEXT("Target owns browser rules"), Target->TargetRules.Get());
    if (Target->TargetRules)
    {
        TestEqual(TEXT("Default max health is three"), Target->TargetRules->MaxHealth, 3);
        TestEqual(TEXT("Default damage per shot is one"), Target->TargetRules->DamagePerShot, 1);
        TestEqual(TEXT("Default score is one hundred"), Target->TargetRules->ScoreValue, 100);
        TestTrue(TEXT("Respawn is enabled by default"), Target->TargetRules->bRespawn);
    }

    const FUE5HTML5BrowserFPSSetupResult Repeated =
        FUE5HTML5BrowserFPSSetup::Apply(World, true, false);
    TestEqual(
        TEXT("Repeated setup selects the existing target"),
        Repeated.Status,
        EUE5HTML5BrowserFPSSetupStatus::ExistingTargetSelected);
    TestEqual(TEXT("Repeated setup reports one target"), Repeated.TargetCount, 1);
    TestEqual(TEXT("Repeated setup returns the same target"), Repeated.TargetActor, Created.TargetActor);
    TestEqual(TEXT("Repeated setup creates no duplicate"), CountTargets(World), 1);

    TestTrue(TEXT("Undo transaction succeeds"), GEditor->UndoTransaction());
    TestEqual(TEXT("Undo removes the created target"), CountTargets(World), 0);
    TestTrue(TEXT("Redo transaction succeeds"), GEditor->RedoTransaction());
    TestEqual(TEXT("Redo restores exactly one target"), CountTargets(World), 1);
    TestTrue(TEXT("Final cleanup undo succeeds"), GEditor->UndoTransaction());
    TestEqual(TEXT("Final cleanup removes the target"), CountTargets(World), 0);

    return true;
}

#endif
