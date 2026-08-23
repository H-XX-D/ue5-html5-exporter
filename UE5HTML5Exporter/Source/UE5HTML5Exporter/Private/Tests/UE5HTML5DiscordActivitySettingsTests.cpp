#include "UE5HTML5DiscordActivitySettings.h"

#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUE5HTML5DiscordInstallUrlTest,
    "UE5HTML5Exporter.Editor.DiscordInstallUrl",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUE5HTML5DiscordInstallUrlTest::RunTest(const FString& Parameters)
{
    UUE5HTML5DiscordActivitySettings* Settings = NewObject<UUE5HTML5DiscordActivitySettings>();
    FString Url;
    FString Error;

    Settings->DiscordApplicationId.Reset();
    TestFalse(TEXT("A missing Application ID is rejected"), Settings->TryGetDiscordInstallUrl(Url, Error));
    TestTrue(TEXT("A missing Application ID explains the required setting"), Error.Contains(TEXT("Discord Application ID")));

    Settings->DiscordApplicationId = TEXT("1540833293098819795");
    TestTrue(TEXT("A Discord snowflake produces an install URL"), Settings->TryGetDiscordInstallUrl(Url, Error));
    TestEqual(
        TEXT("The install URL targets Discord's provided OAuth flow"),
        Url,
        FString(TEXT("https://discord.com/oauth2/authorize?client_id=1540833293098819795")));
    TestTrue(TEXT("A valid install URL has no error"), Error.IsEmpty());

    Settings->DiscordApplicationId = TEXT("154083329309881979x");
    TestFalse(TEXT("A non-digit Application ID is rejected"), Settings->TryGetDiscordInstallUrl(Url, Error));
    TestTrue(TEXT("A rejected ID never produces a URL"), Url.IsEmpty());

    Settings->DiscordApplicationId = TEXT("1234567890123456");
    TestFalse(TEXT("A short Application ID is rejected"), Settings->TryGetDiscordInstallUrl(Url, Error));
    return true;
}

#endif
