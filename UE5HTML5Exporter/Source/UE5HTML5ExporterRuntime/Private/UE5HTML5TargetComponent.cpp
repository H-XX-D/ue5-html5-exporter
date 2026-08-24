#include "UE5HTML5TargetComponent.h"

#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "TimerManager.h"

UUE5HTML5TargetComponent::UUE5HTML5TargetComponent()
{
    PrimaryComponentTick.bCanEverTick = false;
}

void UUE5HTML5TargetComponent::BeginPlay()
{
    Super::BeginPlay();
    if (const AActor* Owner = GetOwner())
    {
        bInitialHidden = Owner->IsHidden();
        bInitialCollision = Owner->GetActorEnableCollision();
    }
    RestoreTarget(false);
}

void UUE5HTML5TargetComponent::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    if (UWorld* World = GetWorld())
    {
        World->GetTimerManager().ClearTimer(RespawnTimer);
    }
    Super::EndPlay(EndPlayReason);
}

bool UUE5HTML5TargetComponent::ApplyTargetPracticeDamage(const int32 Damage)
{
    if (CurrentHealth <= 0 || Damage <= 0)
    {
        return false;
    }

    const int32 AppliedDamage = FMath::Min(CurrentHealth, Damage);
    CurrentHealth -= AppliedDamage;
    OnTargetHit.Broadcast(CurrentHealth, AppliedDamage);
    if (CurrentHealth > 0)
    {
        return false;
    }

    if (AActor* Owner = GetOwner())
    {
        Owner->SetActorHiddenInGame(true);
        Owner->SetActorEnableCollision(false);
    }
    OnTargetDepleted.Broadcast(FMath::Max(0, ScoreValue));

    if (bRespawn)
    {
        if (UWorld* World = GetWorld())
        {
            World->GetTimerManager().SetTimer(
                RespawnTimer,
                this,
                &UUE5HTML5TargetComponent::ResetTarget,
                FMath::Max(0.05f, RespawnDelaySeconds),
                false);
        }
    }
    return true;
}

int32 UUE5HTML5TargetComponent::CalculateTargetPracticeScore(const int32 Multiplier) const
{
    return FMath::Max(0, ScoreValue) * FMath::Max(0, Multiplier);
}

void UUE5HTML5TargetComponent::ResetTarget()
{
    RestoreTarget(true);
}

void UUE5HTML5TargetComponent::RestoreTarget(const bool bBroadcastRespawn)
{
    if (UWorld* World = GetWorld())
    {
        World->GetTimerManager().ClearTimer(RespawnTimer);
    }
    CurrentHealth = FMath::Max(1, MaxHealth);
    if (AActor* Owner = GetOwner())
    {
        Owner->SetActorHiddenInGame(bInitialHidden);
        Owner->SetActorEnableCollision(bInitialCollision);
    }
    if (bBroadcastRespawn)
    {
        OnTargetRespawned.Broadcast();
    }
}
