#include "UE5HTML5SHA256.h"

namespace
{
    constexpr uint32 SHA256BlockBytes = 64;
    constexpr uint32 SHA256DigestBytes = 32;

    uint32 RotateRight(const uint32 Value, const uint32 Count)
    {
        return (Value >> Count) | (Value << (32u - Count));
    }

    class FSHA256State
    {
    public:
        FSHA256State()
            : Hash{
                0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u }
        {
        }

        void Update(const uint8* Data, uint64 ByteSize)
        {
            check(Data != nullptr || ByteSize == 0);
            TotalBytes += ByteSize;

            while (ByteSize > 0)
            {
                const uint32 CopyBytes = static_cast<uint32>(FMath::Min<uint64>(
                    ByteSize,
                    SHA256BlockBytes - BufferBytes));
                FMemory::Memcpy(Buffer + BufferBytes, Data, CopyBytes);
                BufferBytes += CopyBytes;
                Data += CopyBytes;
                ByteSize -= CopyBytes;

                if (BufferBytes == SHA256BlockBytes)
                {
                    Transform(Buffer);
                    BufferBytes = 0;
                }
            }
        }

        void Final(uint8 OutDigest[SHA256DigestBytes])
        {
            const uint64 BitLength = TotalBytes * 8u;
            Buffer[BufferBytes++] = 0x80u;

            if (BufferBytes > 56u)
            {
                FMemory::Memzero(Buffer + BufferBytes, SHA256BlockBytes - BufferBytes);
                Transform(Buffer);
                BufferBytes = 0;
            }

            FMemory::Memzero(Buffer + BufferBytes, 56u - BufferBytes);
            for (uint32 Index = 0; Index < 8u; ++Index)
            {
                Buffer[56u + Index] = static_cast<uint8>(BitLength >> (56u - (Index * 8u)));
            }
            Transform(Buffer);

            for (uint32 Index = 0; Index < 8u; ++Index)
            {
                OutDigest[(Index * 4u)] = static_cast<uint8>(Hash[Index] >> 24u);
                OutDigest[(Index * 4u) + 1u] = static_cast<uint8>(Hash[Index] >> 16u);
                OutDigest[(Index * 4u) + 2u] = static_cast<uint8>(Hash[Index] >> 8u);
                OutDigest[(Index * 4u) + 3u] = static_cast<uint8>(Hash[Index]);
            }
        }

    private:
        void Transform(const uint8 Block[SHA256BlockBytes])
        {
            static constexpr uint32 Constants[64] = {
                0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
                0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
                0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
                0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
                0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
                0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
                0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
                0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
                0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
                0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
                0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
                0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
                0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
                0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
                0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
                0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u };

            uint32 Words[64];
            for (uint32 Index = 0; Index < 16u; ++Index)
            {
                const uint32 Offset = Index * 4u;
                Words[Index] = (static_cast<uint32>(Block[Offset]) << 24u)
                    | (static_cast<uint32>(Block[Offset + 1u]) << 16u)
                    | (static_cast<uint32>(Block[Offset + 2u]) << 8u)
                    | static_cast<uint32>(Block[Offset + 3u]);
            }
            for (uint32 Index = 16u; Index < 64u; ++Index)
            {
                const uint32 Sigma0 = RotateRight(Words[Index - 15u], 7u)
                    ^ RotateRight(Words[Index - 15u], 18u)
                    ^ (Words[Index - 15u] >> 3u);
                const uint32 Sigma1 = RotateRight(Words[Index - 2u], 17u)
                    ^ RotateRight(Words[Index - 2u], 19u)
                    ^ (Words[Index - 2u] >> 10u);
                Words[Index] = Words[Index - 16u] + Sigma0 + Words[Index - 7u] + Sigma1;
            }

            uint32 A = Hash[0];
            uint32 B = Hash[1];
            uint32 C = Hash[2];
            uint32 D = Hash[3];
            uint32 E = Hash[4];
            uint32 F = Hash[5];
            uint32 G = Hash[6];
            uint32 H = Hash[7];

            for (uint32 Index = 0; Index < 64u; ++Index)
            {
                const uint32 Sum1 = RotateRight(E, 6u) ^ RotateRight(E, 11u) ^ RotateRight(E, 25u);
                const uint32 Choice = (E & F) ^ ((~E) & G);
                const uint32 Temp1 = H + Sum1 + Choice + Constants[Index] + Words[Index];
                const uint32 Sum0 = RotateRight(A, 2u) ^ RotateRight(A, 13u) ^ RotateRight(A, 22u);
                const uint32 Majority = (A & B) ^ (A & C) ^ (B & C);
                const uint32 Temp2 = Sum0 + Majority;

                H = G;
                G = F;
                F = E;
                E = D + Temp1;
                D = C;
                C = B;
                B = A;
                A = Temp1 + Temp2;
            }

            Hash[0] += A;
            Hash[1] += B;
            Hash[2] += C;
            Hash[3] += D;
            Hash[4] += E;
            Hash[5] += F;
            Hash[6] += G;
            Hash[7] += H;
        }

        uint32 Hash[8];
        uint8 Buffer[SHA256BlockBytes] = {};
        uint64 TotalBytes = 0;
        uint32 BufferBytes = 0;
    };
}

FString UE5HTML5::SHA256Hex(const uint8* Data, const uint64 ByteSize)
{
    FSHA256State State;
    State.Update(Data, ByteSize);

    uint8 Digest[SHA256DigestBytes];
    State.Final(Digest);

    static constexpr TCHAR HexCharacters[] = TEXT("0123456789abcdef");
    FString Result;
    Result.Reserve(SHA256DigestBytes * 2u);
    for (const uint8 Byte : Digest)
    {
        Result.AppendChar(HexCharacters[Byte >> 4u]);
        Result.AppendChar(HexCharacters[Byte & 0x0fu]);
    }
    return Result;
}

bool UE5HTML5::VerifySHA256()
{
    static constexpr uint8 ABC[] = { 'a', 'b', 'c' };
    return SHA256Hex(nullptr, 0)
            == TEXT("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        && SHA256Hex(ABC, UE_ARRAY_COUNT(ABC))
            == TEXT("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}
