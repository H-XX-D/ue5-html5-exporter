#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"

#include "UE5HTML5DiscordActivitySettings.generated.h"

/**
 * Public, project-scoped deployment identity shared by Unreal developers and the release operator.
 * Never add client secrets, bot tokens, service-role keys, or signing private keys here.
 */
UCLASS(Config = Game, DefaultConfig, meta = (DisplayName = "UE5 HTML5 Discord Activity"))
class UUE5HTML5DiscordActivitySettings final : public UDeveloperSettings
{
    GENERATED_BODY()

public:
    UUE5HTML5DiscordActivitySettings();

    /** Discord application ID (public snowflake), visible on General Information in the Developer Portal. */
    UPROPERTY(Config, EditAnywhere, Category = "Non-Secret Project Targets", meta = (DisplayName = "Discord Application ID"))
    FString DiscordApplicationId;

    /** Discord application public key used to verify requests. This is not the client secret. */
    UPROPERTY(Config, EditAnywhere, Category = "Non-Secret Project Targets", meta = (DisplayName = "Discord Public Key"))
    FString DiscordPublicKey;

    /** Exact Vercel project name that should host this Activity. */
    UPROPERTY(Config, EditAnywhere, Category = "Non-Secret Project Targets")
    FString VercelProjectName;

    /** Exact 20-character Supabase project reference assigned to this game. */
    UPROPERTY(Config, EditAnywhere, Category = "Non-Secret Project Targets")
    FString SupabaseProjectRef;

    /** Optional public HTTPS URL used for the production Activity. */
    UPROPERTY(Config, EditAnywhere, Category = "Non-Secret Project Targets")
    FString ProductionUrl;

    bool HasAnyTarget() const;
    void ValidateTargets(TArray<FString>& OutErrors) const;
};
