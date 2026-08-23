#pragma once

#include "Components/ActorComponent.h"
#include "CoreMinimal.h"
#include "UE5HTML5TargetComponent.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(
    FUE5HTML5TargetHitSignature,
    int32,
    RemainingHealth,
    int32,
    AppliedDamage);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FUE5HTML5TargetDepletedSignature, int32, ScoreValue);
DECLARE_DYNAMIC_MULTICAST_DELEGATE(FUE5HTML5TargetRespawnedSignature);

/**
 * Add this component to any placed actor to make it a zero-code target in an
 * exported first-person browser game. The same health/respawn contract can be
 * driven natively from Blueprint through Apply Target Practice Damage.
 */
UCLASS(
    ClassGroup = (UE5HTML5),
    BlueprintType,
    meta = (BlueprintSpawnableComponent, DisplayName = "UE5 HTML5 Target"))
class UE5HTML5EXPORTERRUNTIME_API UUE5HTML5TargetComponent final : public UActorComponent
{
    GENERATED_BODY()

public:
    UUE5HTML5TargetComponent();

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "UE5 HTML5|Target Practice", meta = (ClampMin = "1", UIMin = "1"))
    int32 MaxHealth = 3;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "UE5 HTML5|Target Practice", meta = (ClampMin = "1", UIMin = "1"))
    int32 DamagePerShot = 1;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "UE5 HTML5|Target Practice", meta = (ClampMin = "0", UIMin = "0"))
    int32 ScoreValue = 100;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "UE5 HTML5|Target Practice")
    bool bRespawn = true;

    UPROPERTY(
        EditAnywhere,
        BlueprintReadWrite,
        Category = "UE5 HTML5|Target Practice",
        meta = (EditCondition = "bRespawn", ClampMin = "0.05", UIMin = "0.05", Units = "s"))
    float RespawnDelaySeconds = 2.0f;

    UPROPERTY(
        EditAnywhere,
        BlueprintReadWrite,
        Category = "UE5 HTML5|Target Practice",
        meta = (ClampMin = "0.0", UIMin = "0.0", Units = "s"))
    float HitFlashSeconds = 0.12f;

    UPROPERTY(BlueprintReadOnly, Transient, Category = "UE5 HTML5|Target Practice")
    int32 CurrentHealth = 3;

    UPROPERTY(BlueprintAssignable, Category = "UE5 HTML5|Target Practice")
    FUE5HTML5TargetHitSignature OnTargetHit;

    UPROPERTY(BlueprintAssignable, Category = "UE5 HTML5|Target Practice")
    FUE5HTML5TargetDepletedSignature OnTargetDepleted;

    UPROPERTY(BlueprintAssignable, Category = "UE5 HTML5|Target Practice")
    FUE5HTML5TargetRespawnedSignature OnTargetRespawned;

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Target Practice", meta = (DisplayName = "Apply Target Practice Damage"))
    bool ApplyTargetPracticeDamage(int32 Damage = 1);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Target Practice")
    void ResetTarget();

protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
    void RestoreTarget(bool bBroadcastRespawn);

    FTimerHandle RespawnTimer;
    bool bInitialHidden = false;
    bool bInitialCollision = true;
};
