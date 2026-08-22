#include "UE5HTML5DiscordBlueprintLibrary.h"

DEFINE_LOG_CATEGORY_STATIC(LogUE5HTML5Discord, Log, All);

namespace
{
    void LogNativeFallback(const TCHAR* FunctionName)
    {
        UE_LOG(LogUE5HTML5Discord, Verbose,
            TEXT("%s is available after HTML5 export inside a configured Discord Activity."), FunctionName);
    }
}

bool UUE5HTML5DiscordBlueprintLibrary::IsDiscordActivityReady()
{
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityBroadcast(const FString& Event, const FString& JsonPayload)
{
    LogNativeFallback(TEXT("DiscordActivityBroadcast"));
    return false;
}

void UUE5HTML5DiscordBlueprintLibrary::DiscordActivityOpenInviteDialog()
{
    LogNativeFallback(TEXT("DiscordActivityOpenInviteDialog"));
}

void UUE5HTML5DiscordBlueprintLibrary::DiscordActivityEncourageHardwareAcceleration()
{
    LogNativeFallback(TEXT("DiscordActivityEncourageHardwareAcceleration"));
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivitySetRichPresence(
    const FString& Details,
    const FString& State,
    int32 CurrentPartySize,
    int32 MaximumPartySize,
    const FString& LargeImage,
    const FString& LargeText)
{
    LogNativeFallback(TEXT("DiscordActivitySetRichPresence"));
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityClearRichPresence()
{
    LogNativeFallback(TEXT("DiscordActivityClearRichPresence"));
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityShareLink(
    const FString& Message,
    const FString& CustomId,
    const FString& LinkId,
    FString& OutShareResultJson)
{
    OutShareResultJson = TEXT("{\"success\":false,\"supported\":false}");
    LogNativeFallback(TEXT("DiscordActivityShareLink"));
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityOpenExternalLink(const FString& Url)
{
    LogNativeFallback(TEXT("DiscordActivityOpenExternalLink"));
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityGetLaunchContext(
    FString& OutCustomId,
    bool& bOutHasReferrer)
{
    OutCustomId.Reset();
    bOutHasReferrer = false;
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityGetParticipants(FString& OutParticipantsJson)
{
    OutParticipantsJson = TEXT("{\"participants\":[]}");
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityGetSkus(FString& OutSkusJson)
{
    OutSkusJson = TEXT("[]");
    LogNativeFallback(TEXT("DiscordActivityGetSkus"));
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityGetVerifiedEntitlements(FString& OutEntitlementsJson)
{
    OutEntitlementsJson = TEXT("[]");
    LogNativeFallback(TEXT("DiscordActivityGetVerifiedEntitlements"));
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityHasEntitlement(const FString& SkuId)
{
    LogNativeFallback(TEXT("DiscordActivityHasEntitlement"));
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityStartPurchase(const FString& SkuId, FString& OutPurchaseJson)
{
    OutPurchaseJson = TEXT("null");
    LogNativeFallback(TEXT("DiscordActivityStartPurchase"));
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityLoadWorldState(FString& OutJsonState, int64& OutRevision)
{
    OutJsonState = TEXT("null");
    OutRevision = 0;
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivitySaveWorldState(const FString& JsonState, int64& OutRevision, int64 ExpectedRevision)
{
    OutRevision = ExpectedRevision;
    LogNativeFallback(TEXT("DiscordActivitySaveWorldState"));
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivityLoadPlayerState(FString& OutJsonState, int64& OutRevision)
{
    OutJsonState = TEXT("null");
    OutRevision = 0;
    return false;
}

bool UUE5HTML5DiscordBlueprintLibrary::DiscordActivitySavePlayerState(const FString& JsonState, int64& OutRevision, int64 ExpectedRevision)
{
    OutRevision = ExpectedRevision;
    LogNativeFallback(TEXT("DiscordActivitySavePlayerState"));
    return false;
}
