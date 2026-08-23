#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "UE5HTML5PracticeTargetActor.generated.h"

class UStaticMeshComponent;
class UUE5HTML5TargetComponent;

/** Drag-and-drop target-range actor for native Unreal and browser exports. */
UCLASS(BlueprintType, meta = (DisplayName = "UE5 HTML5 Practice Target"))
class UE5HTML5EXPORTERRUNTIME_API AUE5HTML5PracticeTargetActor final : public AActor
{
    GENERATED_BODY()

public:
    AUE5HTML5PracticeTargetActor();

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "UE5 HTML5|Target Practice")
    TObjectPtr<UStaticMeshComponent> TargetMesh;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "UE5 HTML5|Target Practice")
    TObjectPtr<UUE5HTML5TargetComponent> TargetRules;
};
