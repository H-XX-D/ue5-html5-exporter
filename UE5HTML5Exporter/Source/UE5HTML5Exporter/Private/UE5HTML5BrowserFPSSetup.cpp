#include "UE5HTML5BrowserFPSSetup.h"

#include "Editor.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerStart.h"
#include "ScopedTransaction.h"
#include "Selection.h"
#include "UE5HTML5PracticeTargetActor.h"
#include "UE5HTML5TargetComponent.h"

#define LOCTEXT_NAMESPACE "FUE5HTML5BrowserFPSSetup"

APlayerStart* FUE5HTML5BrowserFPSSetup::FindPreferredPlayerStart(UWorld* World)
{
    if (!World)
    {
        return nullptr;
    }

    if (GEditor)
    {
        if (USelection* Selection = GEditor->GetSelectedActors())
        {
            for (FSelectionIterator Iterator(*Selection); Iterator; ++Iterator)
            {
                APlayerStart* SelectedStart = Cast<APlayerStart>(*Iterator);
                if (SelectedStart && SelectedStart->GetWorld() == World)
                {
                    return SelectedStart;
                }
            }
        }
    }

    TActorIterator<APlayerStart> Iterator(World);
    return Iterator ? *Iterator : nullptr;
}

FTransform FUE5HTML5BrowserFPSSetup::MakeTargetTransform(const APlayerStart& PlayerStart)
{
    const float PlayerYaw = PlayerStart.GetActorRotation().Yaw;
    const FRotator HorizontalFacing(0.0f, PlayerYaw, 0.0f);
    const FVector TargetLocation = PlayerStart.GetActorLocation()
        + HorizontalFacing.Vector() * 600.0f
        + FVector(0.0f, 0.0f, 65.0f);
    return FTransform(FRotator(0.0f, PlayerYaw + 180.0f, 0.0f), TargetLocation);
}

FUE5HTML5BrowserFPSSetupResult FUE5HTML5BrowserFPSSetup::Apply(
    UWorld* World,
    const bool bAllowCreate,
    const bool bSelectAndFocus)
{
    if (!World || !GEditor)
    {
        return {};
    }

    TArray<AActor*> ExistingTargets;
    for (TActorIterator<AActor> Iterator(World); Iterator; ++Iterator)
    {
        if (Iterator->FindComponentByClass<UUE5HTML5TargetComponent>())
        {
            ExistingTargets.Add(*Iterator);
        }
    }
    if (!ExistingTargets.IsEmpty())
    {
        if (bSelectAndFocus)
        {
            GEditor->SelectNone(false, true, false);
            GEditor->SelectActor(ExistingTargets[0], true, true, true);
            GEditor->MoveViewportCamerasToActor(*ExistingTargets[0], false);
        }
        return {
            EUE5HTML5BrowserFPSSetupStatus::ExistingTargetSelected,
            ExistingTargets[0],
            ExistingTargets.Num()
        };
    }

    APlayerStart* PlayerStart = FindPreferredPlayerStart(World);
    if (!PlayerStart)
    {
        return { EUE5HTML5BrowserFPSSetupStatus::MissingPlayerStart };
    }
    if (!bAllowCreate)
    {
        return { EUE5HTML5BrowserFPSSetupStatus::ReadyToCreate };
    }

    FScopedTransaction Transaction(LOCTEXT("AddBrowserFPSTargetTransaction", "Add Browser FPS Practice Target"));
    AActor* AddedActor = GEditor->AddActor(
        PlayerStart->GetLevel(),
        AUE5HTML5PracticeTargetActor::StaticClass(),
        MakeTargetTransform(*PlayerStart),
        false,
        RF_Transactional,
        bSelectAndFocus);
    AUE5HTML5PracticeTargetActor* Target = Cast<AUE5HTML5PracticeTargetActor>(AddedActor);
    if (!Target)
    {
        Transaction.Cancel();
        return { EUE5HTML5BrowserFPSSetupStatus::SpawnFailed };
    }

    Target->SetActorLabel(TEXT("UE5HTML5_PracticeTarget"));
    Target->MarkPackageDirty();
    if (bSelectAndFocus)
    {
        GEditor->MoveViewportCamerasToActor(*Target, false);
    }
    return { EUE5HTML5BrowserFPSSetupStatus::Created, Target, 1 };
}

#undef LOCTEXT_NAMESPACE
