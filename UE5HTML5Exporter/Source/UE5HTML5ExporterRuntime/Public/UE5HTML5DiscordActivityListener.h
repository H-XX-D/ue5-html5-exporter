#pragma once

#include "CoreMinimal.h"
#include "UObject/Interface.h"
#include "UE5HTML5DiscordActivityListener.generated.h"

/**
 * Add this interface to a Blueprint to receive Discord display and mobile
 * lifecycle events after HTML5 export. Native Unreal play remains inert.
 */
UINTERFACE(BlueprintType)
class UE5HTML5EXPORTERRUNTIME_API UUE5HTML5DiscordActivityListener : public UInterface
{
    GENERATED_BODY()
};

class UE5HTML5EXPORTERRUNTIME_API IUE5HTML5DiscordActivityListener
{
    GENERATED_BODY()

public:
    UFUNCTION(BlueprintImplementableEvent, Category = "UE5 HTML5|Discord Activity|Display")
    void DiscordActivityThermalStateChanged(int32 ThermalState, const FString& ThermalStateName);

    UFUNCTION(BlueprintImplementableEvent, Category = "UE5 HTML5|Discord Activity|Display")
    void DiscordActivityOrientationChanged(int32 Orientation, const FString& OrientationName);

    UFUNCTION(BlueprintImplementableEvent, Category = "UE5 HTML5|Discord Activity|Display")
    void DiscordActivityLayoutModeChanged(int32 LayoutMode, const FString& LayoutModeName);
};
