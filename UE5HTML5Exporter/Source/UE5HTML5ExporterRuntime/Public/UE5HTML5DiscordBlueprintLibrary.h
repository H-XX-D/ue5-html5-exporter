#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UE5HTML5DiscordBlueprintLibrary.generated.h"

UENUM(BlueprintType)
enum class EUE5HTML5DiscordOrientationLock : uint8
{
    Default UMETA(DisplayName = "Use Discord Default"),
    Unlocked UMETA(DisplayName = "Unlocked"),
    Portrait UMETA(DisplayName = "Portrait"),
    Landscape UMETA(DisplayName = "Landscape")
};

/**
 * Blueprint-facing Discord Activity operations. In native Unreal play these
 * functions safely report unavailable. The HTML5 exporter maps the same nodes
 * to the Embedded App SDK, a configurable Activity API, and Supabase runtime.
 */
UCLASS()
class UE5HTML5EXPORTERRUNTIME_API UUE5HTML5DiscordBlueprintLibrary final : public UBlueprintFunctionLibrary
{
    GENERATED_BODY()

public:
    UFUNCTION(BlueprintPure, Category = "UE5 HTML5|Discord Activity")
    static bool IsDiscordActivityReady();

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity")
    static bool DiscordActivityBroadcast(const FString& Event, const FString& JsonPayload);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity")
    static void DiscordActivityOpenInviteDialog();

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity")
    static void DiscordActivityEncourageHardwareAcceleration();

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Display", meta = (AdvancedDisplay = "PictureInPictureLockState,GridLockState"))
    static bool DiscordActivitySetOrientationLock(
        EUE5HTML5DiscordOrientationLock LockState,
        EUE5HTML5DiscordOrientationLock PictureInPictureLockState = EUE5HTML5DiscordOrientationLock::Default,
        EUE5HTML5DiscordOrientationLock GridLockState = EUE5HTML5DiscordOrientationLock::Default);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Display", meta = (DisplayName = "Discord Activity Set Interactive PiP"))
    static bool DiscordActivitySetInteractivePip(bool bEnabled);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Display")
    static bool DiscordActivityGetPlatformBehaviors(FString& OutPlatformBehaviorsJson);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Display")
    static bool DiscordActivityGetLocale(FString& OutLocale);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Social", meta = (AdvancedDisplay = "CurrentPartySize,MaximumPartySize,LargeImage,LargeText"))
    static bool DiscordActivitySetRichPresence(
        const FString& Details,
        const FString& State,
        int32 CurrentPartySize,
        int32 MaximumPartySize,
        const FString& LargeImage,
        const FString& LargeText);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Social")
    static bool DiscordActivityClearRichPresence();

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Social", meta = (AdvancedDisplay = "CustomId,LinkId"))
    static bool DiscordActivityShareLink(
        const FString& Message,
        const FString& CustomId,
        const FString& LinkId,
        FString& OutShareResultJson);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Social")
    static bool DiscordActivityOpenExternalLink(const FString& Url);

    UFUNCTION(BlueprintPure, Category = "UE5 HTML5|Discord Activity|Social")
    static bool DiscordActivityGetLaunchContext(FString& OutCustomId, bool& bOutHasReferrer);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity")
    static bool DiscordActivityGetParticipants(FString& OutParticipantsJson);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Monetization")
    static bool DiscordActivityGetSkus(FString& OutSkusJson);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Monetization")
    static bool DiscordActivityGetVerifiedEntitlements(FString& OutEntitlementsJson);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Monetization")
    static bool DiscordActivityHasEntitlement(const FString& SkuId);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Monetization")
    static bool DiscordActivityStartPurchase(const FString& SkuId, FString& OutPurchaseJson);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Persistence")
    static bool DiscordActivityLoadWorldState(FString& OutJsonState, int64& OutRevision);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Persistence", meta = (AdvancedDisplay = "ExpectedRevision"))
    static bool DiscordActivitySaveWorldState(const FString& JsonState, int64& OutRevision, int64 ExpectedRevision = -1);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Persistence")
    static bool DiscordActivityLoadPlayerState(FString& OutJsonState, int64& OutRevision);

    UFUNCTION(BlueprintCallable, Category = "UE5 HTML5|Discord Activity|Persistence", meta = (AdvancedDisplay = "ExpectedRevision"))
    static bool DiscordActivitySavePlayerState(const FString& JsonState, int64& OutRevision, int64 ExpectedRevision = -1);
};
