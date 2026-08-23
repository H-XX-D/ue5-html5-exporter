#pragma once

#include "CoreMinimal.h"

namespace UE5HTML5
{
    /** Portable SHA-256 used by the cross-platform export contract. */
    FString SHA256Hex(const uint8* Data, uint64 ByteSize);

    /** Known-vector guard for compiler and platform regressions. */
    bool VerifySHA256();
}
