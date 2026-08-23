#include "UE5HTML5DiscordActivitySettings.h"

#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
    constexpr const TCHAR* ProjectTargetsSchema = TEXT("ue5-discord-activity-project-targets/v1");

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

    bool IsValidDiscordApplicationId(const FString& Value)
    {
        if (Value.Len() < 17 || Value.Len() > 20)
        {
            return false;
        }
        for (const TCHAR Character : Value)
        {
            if (Character < TEXT('0') || Character > TEXT('9'))
            {
                return false;
            }
        }
        return true;
    }

    void AddTargetValidationErrors(
        const FString& DiscordApplicationId,
        const FString& DiscordPublicKey,
        const FString& VercelProjectName,
        const FString& SupabaseProjectRef,
        const FString& ProductionUrl,
        TArray<FString>& OutErrors)
    {
        if (!DiscordApplicationId.IsEmpty() && !IsValidDiscordApplicationId(DiscordApplicationId))
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
            && (!ProductionUrl.StartsWith(TEXT("https://"), ESearchCase::IgnoreCase)
                || ProductionUrl.Contains(TEXT(" "))
                || ProductionUrl.Contains(TEXT("?"))
                || ProductionUrl.Contains(TEXT("#"))
                || ProductionUrl.Contains(TEXT("@"))))
        {
            OutErrors.Add(TEXT("Production URL must be a public HTTPS URL without spaces, user information, query parameters, or fragments."));
        }
    }

    bool ReadRequiredString(const TSharedPtr<FJsonObject>& Root, const TCHAR* Name, FString& OutValue, FString& OutError)
    {
        if (!Root->TryGetStringField(Name, OutValue))
        {
            OutError = FString::Printf(TEXT("Public target file field '%s' must be a string."), Name);
            return false;
        }
        OutValue.TrimStartAndEndInline();
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
    AddTargetValidationErrors(
        DiscordApplicationId,
        DiscordPublicKey,
        VercelProjectName,
        SupabaseProjectRef,
        ProductionUrl,
        OutErrors);
}

bool UUE5HTML5DiscordActivitySettings::TryGetDiscordInstallUrl(FString& OutUrl, FString& OutError) const
{
    OutUrl.Reset();
    OutError.Reset();
    if (DiscordApplicationId.IsEmpty())
    {
        OutError = TEXT("Set the public Discord Application ID in Discord Activity Project Settings first.");
        return false;
    }
    if (!IsValidDiscordApplicationId(DiscordApplicationId))
    {
        OutError = TEXT("Discord Application ID must contain 17 to 20 digits before its install page can be opened.");
        return false;
    }
    OutUrl = FString::Printf(
        TEXT("https://discord.com/oauth2/authorize?client_id=%s"),
        *DiscordApplicationId);
    return true;
}

bool UUE5HTML5DiscordActivitySettings::ImportPublicTargets(const FString& Filename, FString& OutError)
{
    const FString ResolvedFilename = FPaths::ConvertRelativePathToFull(Filename);
    FString Json;
    if (!FFileHelper::LoadFileToString(Json, *ResolvedFilename))
    {
        OutError = FString::Printf(TEXT("Could not read public Discord Activity targets: %s"), *ResolvedFilename);
        return false;
    }

    TSharedPtr<FJsonObject> Root;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
    if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
    {
        OutError = TEXT("Public Discord Activity targets must be a JSON object.");
        return false;
    }

    static const TSet<FString> AllowedFields = {
        TEXT("schema"), TEXT("containsSecrets"), TEXT("discordApplicationId"),
        TEXT("discordPublicKey"), TEXT("vercelProjectName"), TEXT("supabaseProjectRef"),
        TEXT("productionUrl")
    };
    for (const TPair<FString, TSharedPtr<FJsonValue>>& Entry : Root->Values)
    {
        if (!AllowedFields.Contains(Entry.Key))
        {
            OutError = FString::Printf(
                TEXT("Public target file contains unsupported field '%s'. Only the allowlisted public identity fields are accepted."),
                *Entry.Key);
            return false;
        }
    }

    FString Schema;
    if (!Root->TryGetStringField(TEXT("schema"), Schema) || Schema != ProjectTargetsSchema)
    {
        OutError = FString::Printf(TEXT("Public target file must use schema %s."), ProjectTargetsSchema);
        return false;
    }
    bool bContainsSecrets = true;
    if (!Root->TryGetBoolField(TEXT("containsSecrets"), bContainsSecrets) || bContainsSecrets)
    {
        OutError = TEXT("Public target file must explicitly declare containsSecrets as false.");
        return false;
    }

    FString NewDiscordApplicationId;
    FString NewDiscordPublicKey;
    FString NewVercelProjectName;
    FString NewSupabaseProjectRef;
    FString NewProductionUrl;
    if (!ReadRequiredString(Root, TEXT("discordApplicationId"), NewDiscordApplicationId, OutError)
        || !ReadRequiredString(Root, TEXT("discordPublicKey"), NewDiscordPublicKey, OutError)
        || !ReadRequiredString(Root, TEXT("vercelProjectName"), NewVercelProjectName, OutError)
        || !ReadRequiredString(Root, TEXT("supabaseProjectRef"), NewSupabaseProjectRef, OutError)
        || !ReadRequiredString(Root, TEXT("productionUrl"), NewProductionUrl, OutError))
    {
        return false;
    }

    TArray<FString> Errors;
    AddTargetValidationErrors(
        NewDiscordApplicationId,
        NewDiscordPublicKey,
        NewVercelProjectName,
        NewSupabaseProjectRef,
        NewProductionUrl,
        Errors);
    if (NewDiscordApplicationId.IsEmpty()
        || NewDiscordPublicKey.IsEmpty()
        || NewVercelProjectName.IsEmpty()
        || NewSupabaseProjectRef.IsEmpty())
    {
        Errors.Add(TEXT("Public target file must contain the complete Discord, Vercel, and Supabase target set."));
    }
    if (!Errors.IsEmpty())
    {
        OutError = FString::Join(Errors, TEXT("\n- "));
        OutError = TEXT("Public target file is invalid:\n- ") + OutError;
        return false;
    }

    const FString PreviousDiscordApplicationId = DiscordApplicationId;
    const FString PreviousDiscordPublicKey = DiscordPublicKey;
    const FString PreviousVercelProjectName = VercelProjectName;
    const FString PreviousSupabaseProjectRef = SupabaseProjectRef;
    const FString PreviousProductionUrl = ProductionUrl;
    DiscordApplicationId = NewDiscordApplicationId;
    DiscordPublicKey = NewDiscordPublicKey;
    VercelProjectName = NewVercelProjectName;
    SupabaseProjectRef = NewSupabaseProjectRef;
    ProductionUrl = NewProductionUrl;
    if (!TryUpdateDefaultConfigFile())
    {
        DiscordApplicationId = PreviousDiscordApplicationId;
        DiscordPublicKey = PreviousDiscordPublicKey;
        VercelProjectName = PreviousVercelProjectName;
        SupabaseProjectRef = PreviousSupabaseProjectRef;
        ProductionUrl = PreviousProductionUrl;
        OutError = FString::Printf(TEXT("Could not update the Unreal project's DefaultGame.ini: %s"), *GetDefaultConfigFilename());
        return false;
    }
    return true;
}

bool UUE5HTML5DiscordActivitySettings::ExportPublicTargets(const FString& Filename, FString& OutError) const
{
    TArray<FString> Errors;
    ValidateTargets(Errors);
    if (!HasCompleteTargetSet())
    {
        Errors.Add(TEXT("Configure the complete Discord, Vercel, and Supabase target set before exporting it."));
    }
    if (!Errors.IsEmpty())
    {
        OutError = FString::Join(Errors, TEXT("\n- "));
        OutError = TEXT("Public project targets are not exportable:\n- ") + OutError;
        return false;
    }

    TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
    Root->SetStringField(TEXT("schema"), ProjectTargetsSchema);
    Root->SetBoolField(TEXT("containsSecrets"), false);
    Root->SetStringField(TEXT("discordApplicationId"), DiscordApplicationId);
    Root->SetStringField(TEXT("discordPublicKey"), DiscordPublicKey);
    Root->SetStringField(TEXT("vercelProjectName"), VercelProjectName);
    Root->SetStringField(TEXT("supabaseProjectRef"), SupabaseProjectRef);
    Root->SetStringField(TEXT("productionUrl"), ProductionUrl);

    FString Json;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
    if (!FJsonSerializer::Serialize(Root, Writer))
    {
        OutError = TEXT("Could not serialize the public project target file.");
        return false;
    }
    Json += TEXT("\n");

    const FString ResolvedFilename = FPaths::ConvertRelativePathToFull(Filename);
    IFileManager::Get().MakeDirectory(*FPaths::GetPath(ResolvedFilename), true);
    if (!FFileHelper::SaveStringToFile(Json, *ResolvedFilename))
    {
        OutError = FString::Printf(TEXT("Could not write public Discord Activity targets: %s"), *ResolvedFilename);
        return false;
    }
    return true;
}
