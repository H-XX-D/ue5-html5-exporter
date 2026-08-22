#pragma once

#include "Commandlets/Commandlet.h"
#include "UE5HTML5ExportCommandlet.generated.h"

UCLASS()
class UE5HTML5EXPORTER_API UUE5HTML5ExportCommandlet final : public UCommandlet
{
    GENERATED_BODY()

public:
    UUE5HTML5ExportCommandlet();
    virtual int32 Main(const FString& Params) override;
};
