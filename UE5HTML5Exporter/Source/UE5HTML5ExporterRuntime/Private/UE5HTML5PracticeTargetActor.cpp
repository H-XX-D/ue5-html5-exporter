#include "UE5HTML5PracticeTargetActor.h"

#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "UObject/ConstructorHelpers.h"
#include "UE5HTML5TargetComponent.h"

AUE5HTML5PracticeTargetActor::AUE5HTML5PracticeTargetActor()
{
    PrimaryActorTick.bCanEverTick = false;
    TargetMesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("TargetMesh"));
    SetRootComponent(TargetMesh);
    TargetMesh->SetCollisionProfileName(TEXT("BlockAll"));

    static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeMesh(TEXT("/Engine/BasicShapes/Cube.Cube"));
    if (CubeMesh.Succeeded())
    {
        TargetMesh->SetStaticMesh(CubeMesh.Object);
    }

    TargetRules = CreateDefaultSubobject<UUE5HTML5TargetComponent>(TEXT("TargetRules"));
}
