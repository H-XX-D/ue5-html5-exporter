#include "UE5HTML5DiscordActivitySettings.h"

namespace
{
    bool IsLowerAlphaNumeric(const TCHAR Character)
    {
        return (Character >= TEXT('a') && Character <= TEXT('z'))
            || (Character >= TEXT('0') && Character <= TEXT('9'));
    }

    bool IsSafeProjectName(const FString& Value)
    {
        if (Value.IsEmpty() || Value.Len() > 100 || !IsLowerAlphaNumeric(Value[0]) || !IsLowerAlphaNumeric(Value[Value.Len() - 1]))
        {
            return false;
        }
        for (const TCHAR Character : Value)
        {
            if (!IsLowerAlphaNumeric(Character) && Character != TEXT('-') && Character != TEXT('_') && Character != TEXT('.'))
            {
                return false;
            }
        }
        return true;
    }
}

UUE5HTML5DiscordActivitySettings::UUE5HTML5DiscordActivitySettings()
{
    CategoryName = TEXT("Plugins");
    SectionName = TEXT("UE5HTML5DiscordActivity");
}

bool UUE5HTML5DiscordActivitySettings::HasAnyTarget() const
{
    return !DiscordApplicationId.IsEmpty()
        || !DiscordPublicKey.IsEmpty()
        || !VercelProjectName.IsEmpty()
        || !SupabaseProjectRef.IsEmpty()
        || !ProductionUrl.IsEmpty();
}

bool UUE5HTML5DiscordActivitySettings::HasCompleteTargetSet() const
{
    return !DiscordApplicationId.IsEmpty()
        && !DiscordPublicKey.IsEmpty()
        && !VercelProjectName.IsEmpty()
        && !SupabaseProjectRef.IsEmpty();
}

void UUE5HTML5DiscordActivitySettings::GetMissingRequiredTargets(TArray<FString>& OutMissingTargets) const
{
    if (DiscordApplicationId.IsEmpty())
    {
        OutMissingTargets.Add(TEXT("Discord Application ID"));
    }
    if (DiscordPublicKey.IsEmpty())
    {
        OutMissingTargets.Add(TEXT("Discord Public Key"));
    }
    if (VercelProjectName.IsEmpty())
    {
        OutMissingTargets.Add(TEXT("Vercel Project Name"));
    }
    if (SupabaseProjectRef.IsEmpty())
    {
        OutMissingTargets.Add(TEXT("Supabase Project Ref"));
    }
}

void UUE5HTML5DiscordActivitySettings::ValidateTargets(TArray<FString>& OutErrors) const
{
    if (!DiscordApplicationId.IsEmpty()
        && (DiscordApplicationId.Len() < 17 || DiscordApplicationId.Len() > 20 || !DiscordApplicationId.IsNumeric()))
    {
        OutErrors.Add(TEXT("Discord Application ID must contain 17 to 20 digits."));
    }

    if (!DiscordPublicKey.IsEmpty())
    {
        bool bIsHex = DiscordPublicKey.Len() == 64;
        for (const TCHAR Character : DiscordPublicKey)
        {
            bIsHex = bIsHex && FChar::IsHexDigit(Character);
        }
        if (!bIsHex)
        {
            OutErrors.Add(TEXT("Discord Public Key must contain exactly 64 hexadecimal characters."));
        }
    }

    if (!VercelProjectName.IsEmpty() && !IsSafeProjectName(VercelProjectName))
    {
        OutErrors.Add(TEXT("Vercel Project Name must be 1 to 100 lowercase letters, numbers, dots, underscores, or hyphens and start and end with a letter or number."));
    }

    if (!SupabaseProjectRef.IsEmpty())
    {
        bool bIsValid = SupabaseProjectRef.Len() == 20;
        for (const TCHAR Character : SupabaseProjectRef)
        {
            bIsValid = bIsValid && IsLowerAlphaNumeric(Character);
        }
        if (!bIsValid)
        {
            OutErrors.Add(TEXT("Supabase Project Ref must contain exactly 20 lowercase letters or numbers."));
        }
    }

    if (!ProductionUrl.IsEmpty()
        && (!ProductionUrl.StartsWith(TEXT("https://"), ESearchCase::IgnoreCase) || ProductionUrl.Contains(TEXT(" "))))
    {
        OutErrors.Add(TEXT("Production URL must be a public HTTPS URL without spaces."));
    }
}
