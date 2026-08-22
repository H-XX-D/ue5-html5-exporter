#include "UE5BlueprintGraphExporter.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/AssetData.h"
#include "BehaviorTree/BehaviorTree.h"
#include "BehaviorTree/BTCompositeNode.h"
#include "BehaviorTree/BTNode.h"
#include "Blueprint/WidgetTree.h"
#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "Components/PanelWidget.h"
#include "Components/Widget.h"
#include "Dom/JsonObject.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "Engine/Blueprint.h"
#include "Engine/SCS_Node.h"
#include "Engine/SimpleConstructionScript.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameMapsSettings.h"
#include "GameFramework/Actor.h"
#include "GameFramework/Character.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/GameStateBase.h"
#include "GameFramework/HUD.h"
#include "GameFramework/InputSettings.h"
#include "GameFramework/PlayerStart.h"
#include "GameFramework/PlayerState.h"
#include "GameFramework/SpectatorPawn.h"
#include "GameFramework/WorldSettings.h"
#include "HAL/FileManager.h"
#include "K2Node.h"
#include "K2Node_CallFunction.h"
#include "K2Node_Event.h"
#include "K2Node_FunctionEntry.h"
#include "K2Node_InputKey.h"
#include "K2Node_InputKeyEvent.h"
#include "K2Node_Variable.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "InputTriggers.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/UnrealType.h"
#include "WidgetBlueprint.h"

namespace
{
    struct FBlueprintExportTarget
    {
        TArray<AActor*> PlacedActors;
        TMap<FString, UClass*> RuntimeClasses;
    };

    UObject* ExportParent(const UObject* Object)
    {
        return const_cast<UObject*>(Object);
    }

    FString Normalize(const FString& Value)
    {
        FString Result;
        for (const TCHAR Character : Value)
        {
            if (FChar::IsAlnum(Character))
            {
                Result.AppendChar(FChar::ToLower(Character));
            }
        }
        return Result;
    }

    FString NodeKind(const UEdGraphNode* Node)
    {
        const FString ClassName = Node->GetClass()->GetName();
        if (ClassName.Contains(TEXT("EnhancedInputAction")) || ClassName.Contains(TEXT("InputAction"))) return TEXT("inputAction");
        if (ClassName.Contains(TEXT("InputKey"))) return TEXT("inputKey");
        if (ClassName == TEXT("EdGraphNode_Comment")) return TEXT("comment");
        if (Node->IsA<UK2Node_Event>()) return TEXT("event");
        if (Node->IsA<UK2Node_FunctionEntry>()) return TEXT("functionEntry");
        if (ClassName == TEXT("K2Node_FunctionResult")) return TEXT("functionResult");
        if (ClassName == TEXT("K2Node_CreateWidget")) return TEXT("createWidget");
        if (ClassName == TEXT("K2Node_GetSubsystem")) return TEXT("getSubsystem");
        if (ClassName == TEXT("K2Node_VariableGet")) return TEXT("variableGet");
        if (ClassName == TEXT("K2Node_VariableSet")) return TEXT("variableSet");
        if (ClassName.Contains(TEXT("CallDelegate")) || ClassName.Contains(TEXT("AddDelegate")) || ClassName.Contains(TEXT("RemoveDelegate"))) return TEXT("delegate");
        if (ClassName.Contains(TEXT("Message")) || ClassName.Contains(TEXT("Interface"))) return TEXT("interfaceCall");
        if (Node->IsA<UK2Node_CallFunction>()) return TEXT("callFunction");
        if (ClassName == TEXT("K2Node_IfThenElse")) return TEXT("branch");
        if (ClassName == TEXT("K2Node_SwitchString")) return TEXT("switchString");
        if (ClassName == TEXT("K2Node_ExecutionSequence")) return TEXT("sequence");
        if (ClassName == TEXT("K2Node_Knot")) return TEXT("knot");
        if (ClassName == TEXT("K2Node_Self")) return TEXT("self");
        if (ClassName == TEXT("K2Node_Literal") || ClassName.Contains(TEXT("EnumLiteral"))) return TEXT("literal");
        if (ClassName == TEXT("K2Node_MakeStruct")) return TEXT("makeStruct");
        if (ClassName == TEXT("K2Node_BreakStruct")) return TEXT("breakStruct");
        if (ClassName.Contains(TEXT("DoOnce"))) return TEXT("doOnce");
        if (ClassName.Contains(TEXT("FlipFlop"))) return TEXT("flipFlop");
        return TEXT("unsupported");
    }

    bool IsSupportedFunction(const FString& FunctionName)
    {
        const FString Name = Normalize(FunctionName);
        static const TArray<FString> Prefixes = {
            TEXT("add"), TEXT("subtract"), TEXT("multiply"), TEXT("divide"), TEXT("greater"), TEXT("less"),
            TEXT("equalequal"), TEXT("notequal"), TEXT("booleanand"), TEXT("booleanor"), TEXT("not"),
            TEXT("clamp"), TEXT("abs"), TEXT("lerp")
        };
        for (const FString& Prefix : Prefixes)
        {
            if (Name.StartsWith(Prefix)) return true;
        }
        static const TSet<FString> Exact = {
            TEXT("delay"), TEXT("printstring"), TEXT("printtext"),
            TEXT("setactorlocation"), TEXT("k2setactorlocation"), TEXT("addactorworldoffset"), TEXT("k2addactorworldoffset"),
            TEXT("addactorlocaloffset"), TEXT("setactorrotation"), TEXT("k2setactorrotation"), TEXT("setactorscale3d"),
            TEXT("setactorhiddeningame"), TEXT("setvisibility"), TEXT("destroyactor"),
            TEXT("getactorlocation"), TEXT("k2getactorlocation"), TEXT("getactorscale3d"),
            TEXT("getactorforwardvector"), TEXT("getactorrightvector"),
            TEXT("addmovementinput"), TEXT("jump"), TEXT("stopjumping"),
            TEXT("addcontrolleryawinput"), TEXT("addcontrollerpitchinput"),
            TEXT("islocalplayercontroller"), TEXT("getplatformname"), TEXT("shouldusetouchcontrols"),
            TEXT("delayuntilnextframe")
        };
        if (Exact.Contains(Name)) return true;
        static const TArray<FString> AdapterFamilies = {
            TEXT("gameplaytag"), TEXT("gameplayeffect"), TEXT("numericattribute"), TEXT("activateability"),
            TEXT("widget"), TEXT("viewport"), TEXT("settext"), TEXT("spawnsystem"), TEXT("spawnemitter"),
            TEXT("delegate"), TEXT("broadcast"), TEXT("interface"), TEXT("settimer"), TEXT("cleartimer"), TEXT("openurl"),
            TEXT("loadasset"), TEXT("movecomponentto"), TEXT("httpgetjson"), TEXT("asyncdownloadjson"),
            TEXT("mappingcontext"), TEXT("runbehaviortree"), TEXT("simulatephysics"), TEXT("enablegravity"),
            TEXT("physicslinearvelocity"), TEXT("addimpulse"), TEXT("addforce"), TEXT("setpercent"),
            TEXT("discordactivity")
        };
        for (const FString& Family : AdapterFamilies)
        {
            if (Name.Contains(Family)) return true;
        }
        return false;
    }

    bool IsSupportedEvent(const UEdGraphNode* Node, const FString& EventName)
    {
        if (Node->GetClass()->GetName().Contains(TEXT("InputKey"))) return true;
        const FString Name = Normalize(EventName);
        return Name == TEXT("receivebeginplay") || Name == TEXT("beginplay") || Name == TEXT("receivetick") || Name == TEXT("tick")
            || Name.Contains(TEXT("actorbeginoverlap")) || Name.Contains(TEXT("actorendoverlap"))
            || Name.Contains(TEXT("componentbeginoverlap")) || Name.Contains(TEXT("componentendoverlap"))
            || Name.Contains(TEXT("hit"))
            || Node->GetClass()->GetName() == TEXT("K2Node_CustomEvent");
    }

    FString ReflectedPropertyText(const UObject* Object, const TArray<FName>& Names)
    {
        if (!Object) return FString();
        for (const FName Name : Names)
        {
            const FProperty* Property = Object->GetClass()->FindPropertyByName(Name);
            if (!Property) continue;
            FString Value;
            Property->ExportText_InContainer(0, Value, Object, Object, ExportParent(Object), PPF_None);
            if (!Value.IsEmpty()) return Value;
        }
        return FString();
    }

    FString InputActionName(const UEdGraphNode* Node)
    {
        FString Value = ReflectedPropertyText(Node, { TEXT("InputAction"), TEXT("InputActionName"), TEXT("ActionName") });
        Value.RemoveFromStart(TEXT("InputAction'"));
        Value.RemoveFromEnd(TEXT("'"));
        if (Value.Contains(TEXT("."))) Value = FPaths::GetBaseFilename(Value);
        return Value;
    }

    FString EventName(const UEdGraphNode* Node)
    {
        if (const UK2Node_Event* Event = Cast<UK2Node_Event>(Node))
        {
            const FName ReferenceName = Event->EventReference.GetMemberName();
            return !ReferenceName.IsNone() ? ReferenceName.ToString() : Event->CustomFunctionName.ToString();
        }
        return FString();
    }

    FString FunctionName(const UEdGraphNode* Node)
    {
        if (const UK2Node_CallFunction* Call = Cast<UK2Node_CallFunction>(Node))
        {
            return Call->FunctionReference.GetMemberName().ToString();
        }
        if (const UK2Node_FunctionEntry* Entry = Cast<UK2Node_FunctionEntry>(Node))
        {
            return Entry->CustomGeneratedFunctionName.ToString();
        }
        return FString();
    }

    FString VariableName(const UEdGraphNode* Node)
    {
        if (const UK2Node_Variable* Variable = Cast<UK2Node_Variable>(Node))
        {
            return Variable->GetVarNameString();
        }
        return FString();
    }

    TSharedRef<FJsonObject> SerializePin(const UEdGraphPin* Pin)
    {
        TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetStringField(TEXT("id"), Pin->PinId.ToString(EGuidFormats::DigitsWithHyphensLower));
        Json->SetStringField(TEXT("name"), Pin->PinName.ToString());
        Json->SetStringField(TEXT("direction"), Pin->Direction == EGPD_Input ? TEXT("input") : TEXT("output"));
        Json->SetStringField(TEXT("category"), Pin->PinType.PinCategory.ToString());
        Json->SetStringField(TEXT("subcategory"), Pin->PinType.PinSubCategory.ToString());
        if (const UObject* TypeObject = Pin->PinType.PinSubCategoryObject.Get())
        {
            Json->SetStringField(TEXT("typeObject"), TypeObject->GetPathName());
        }
        FString DefaultValue = Pin->DefaultValue;
        if (DefaultValue.IsEmpty() && Pin->DefaultObject)
        {
            DefaultValue = Pin->DefaultObject->GetPathName();
        }
        if (DefaultValue.IsEmpty() && !Pin->DefaultTextValue.IsEmpty())
        {
            DefaultValue = Pin->DefaultTextValue.ToString();
        }
        Json->SetStringField(TEXT("default"), DefaultValue);

        TArray<TSharedPtr<FJsonValue>> Links;
        for (const UEdGraphPin* Linked : Pin->LinkedTo)
        {
            if (!Linked || !Linked->GetOwningNode()) continue;
            TSharedRef<FJsonObject> Link = MakeShared<FJsonObject>();
            Link->SetStringField(TEXT("node"), Linked->GetOwningNode()->NodeGuid.ToString(EGuidFormats::DigitsWithHyphensLower));
            Link->SetStringField(TEXT("pin"), Linked->PinName.ToString());
            Links.Add(MakeShared<FJsonValueObject>(Link));
        }
        Json->SetArrayField(TEXT("links"), Links);
        return Json;
    }

    TSharedRef<FJsonObject> SerializeNode(const UEdGraphNode* Node, const FString& GraphName, const TSet<FString>& BlueprintFunctions, FUE5BlueprintExportSummary& Summary, TArray<TSharedPtr<FJsonValue>>& Unsupported)
    {
        TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
        const FString Kind = NodeKind(Node);
        const FString Event = EventName(Node);
        FString Function = FunctionName(Node);
        if (Kind == TEXT("functionEntry") && (Function.IsEmpty() || Function == TEXT("None"))) Function = GraphName;
        if (Kind == TEXT("createWidget")) Function = TEXT("CreateWidget");
        if (Kind == TEXT("getSubsystem")) Function = TEXT("GetSubsystem");
        if (Function.IsEmpty() && (Kind == TEXT("delegate") || Kind == TEXT("interfaceCall")))
        {
            Function = ReflectedPropertyText(Node, { TEXT("FunctionReference"), TEXT("DelegateReference"), TEXT("EventReference") });
            if (Function.IsEmpty()) Function = Node->GetNodeTitle(ENodeTitleType::ListView).ToString();
        }
        bool bSupported = Kind != TEXT("unsupported");
        if (Kind == TEXT("callFunction")) bSupported = IsSupportedFunction(Function) || BlueprintFunctions.Contains(Normalize(Function));
        if (Kind == TEXT("event")) bSupported = IsSupportedEvent(Node, Event);
        if (Kind == TEXT("delegate") || Kind == TEXT("interfaceCall") || Kind == TEXT("inputAction")
            || Kind == TEXT("comment") || Kind == TEXT("functionResult") || Kind == TEXT("createWidget") || Kind == TEXT("getSubsystem")) bSupported = true;

        Json->SetStringField(TEXT("id"), Node->NodeGuid.ToString(EGuidFormats::DigitsWithHyphensLower));
        Json->SetStringField(TEXT("class"), Node->GetClass()->GetName());
        Json->SetStringField(TEXT("kind"), Kind);
        Json->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
        Json->SetBoolField(TEXT("supported"), bSupported);
        Json->SetNumberField(TEXT("x"), Node->NodePosX);
        Json->SetNumberField(TEXT("y"), Node->NodePosY);
        if (!Event.IsEmpty()) Json->SetStringField(TEXT("event"), Event);
        if (!Function.IsEmpty()) Json->SetStringField(TEXT("function"), Function);
        const FString Variable = VariableName(Node);
        if (!Variable.IsEmpty()) Json->SetStringField(TEXT("variable"), Variable);
        if (Kind == TEXT("inputAction"))
        {
            const FString Action = InputActionName(Node);
            Json->SetStringField(TEXT("inputAction"), Action);
            Json->SetStringField(TEXT("event"), Action);
            Json->SetStringField(TEXT("triggerEvent"), ReflectedPropertyText(Node, { TEXT("TriggerEvent"), TEXT("InputKeyEvent") }));
        }
        if (Kind == TEXT("switchString"))
        {
            const FString CaseSensitive = ReflectedPropertyText(Node, { TEXT("bIsCaseSensitive"), TEXT("IsCaseSensitive") });
            Json->SetBoolField(TEXT("caseSensitive"), CaseSensitive.Equals(TEXT("True"), ESearchCase::IgnoreCase));
        }

        if (const UK2Node_CallFunction* Call = Cast<UK2Node_CallFunction>(Node))
        {
            Json->SetBoolField(TEXT("pure"), Call->IsNodePure());
        }
        if (const UK2Node_InputKey* Input = Cast<UK2Node_InputKey>(Node))
        {
            Json->SetStringField(TEXT("inputKey"), Input->InputKey.GetFName().ToString());
            Json->SetStringField(TEXT("inputEvent"), TEXT("both"));
            TSharedRef<FJsonObject> Modifiers = MakeShared<FJsonObject>();
            Modifiers->SetBoolField(TEXT("shift"), Input->bShift);
            Modifiers->SetBoolField(TEXT("control"), Input->bControl);
            Modifiers->SetBoolField(TEXT("alt"), Input->bAlt);
            Modifiers->SetBoolField(TEXT("command"), Input->bCommand);
            Json->SetObjectField(TEXT("modifiers"), Modifiers);
        }
        if (const UK2Node_InputKeyEvent* InputEvent = Cast<UK2Node_InputKeyEvent>(Node))
        {
            Json->SetStringField(TEXT("inputKey"), InputEvent->InputChord.Key.GetFName().ToString());
            Json->SetStringField(TEXT("inputEvent"), InputEvent->InputKeyEvent == IE_Released ? TEXT("released") : TEXT("pressed"));
        }

        TArray<TSharedPtr<FJsonValue>> Pins;
        for (const UEdGraphPin* Pin : Node->Pins)
        {
            if (Pin) Pins.Add(MakeShared<FJsonValueObject>(SerializePin(Pin)));
        }
        Json->SetArrayField(TEXT("pins"), Pins);

        ++Summary.NodeCount;
        if (bSupported) ++Summary.SupportedNodeCount;
        else
        {
            ++Summary.UnsupportedNodeCount;
            TSharedRef<FJsonObject> Issue = MakeShared<FJsonObject>();
            Issue->SetStringField(TEXT("graph"), GraphName);
            Issue->SetStringField(TEXT("node"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
            Issue->SetStringField(TEXT("class"), Node->GetClass()->GetName());
            if (!Function.IsEmpty()) Issue->SetStringField(TEXT("function"), Function);
            Unsupported.Add(MakeShared<FJsonValueObject>(Issue));
        }
        return Json;
    }

    TArray<UEdGraph*> CollectGraphs(const UBlueprint* Blueprint)
    {
        TArray<UEdGraph*> Graphs;
        Graphs.Append(Blueprint->UbergraphPages);
        Graphs.Append(Blueprint->FunctionGraphs);
        return Graphs;
    }

    TSharedRef<FJsonObject> SerializeActor(const AActor* Actor, const UBlueprint* Blueprint, const FString& RuntimeRole = FString())
    {
        TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
        const bool bRuntimeSpawned = !RuntimeRole.IsEmpty();
        Json->SetStringField(TEXT("label"), bRuntimeSpawned ? RuntimeRole : Actor->GetActorLabel());
        Json->SetStringField(TEXT("objectName"), bRuntimeSpawned ? FString::Printf(TEXT("__ue_%s"), *RuntimeRole) : Actor->GetName());
        Json->SetStringField(TEXT("path"), Actor->GetPathName());
        Json->SetStringField(TEXT("class"), Actor->GetClass()->GetPathName());
        Json->SetBoolField(TEXT("runtimeSpawned"), bRuntimeSpawned);
        if (bRuntimeSpawned) Json->SetStringField(TEXT("runtimeRole"), RuntimeRole);

        TSharedRef<FJsonObject> InitialState = MakeShared<FJsonObject>();
        for (const FBPVariableDescription& Variable : Blueprint->NewVariables)
        {
            const FProperty* Property = Actor->GetClass()->FindPropertyByName(Variable.VarName);
            if (!Property) continue;
            FString Value;
            Property->ExportText_InContainer(0, Value, Actor, Actor, ExportParent(Actor), PPF_None);
            TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("value"), Value);
            Entry->SetStringField(TEXT("category"), Variable.VarType.PinCategory.ToString());
            Entry->SetStringField(TEXT("subcategory"), Variable.VarType.PinSubCategory.ToString());
            Entry->SetBoolField(TEXT("replicated"), Property->HasAnyPropertyFlags(CPF_Net));
            InitialState->SetObjectField(Variable.VarName.ToString(), Entry);
        }
        Json->SetObjectField(TEXT("initialState"), InitialState);
        return Json;
    }

    UClass* ResolveGameModeClass(UWorld* World)
    {
        if (!World) return nullptr;
        if (const AWorldSettings* WorldSettings = World->GetWorldSettings())
        {
            if (WorldSettings->DefaultGameMode) return WorldSettings->DefaultGameMode.Get();
        }

        const FString MapName = FPaths::GetBaseFilename(World->GetOutermost()->GetName());
        const FString MapGameMode = UGameMapsSettings::GetGameModeForMapName(MapName);
        if (!MapGameMode.IsEmpty())
        {
            if (UClass* Class = LoadClass<AGameModeBase>(nullptr, *MapGameMode)) return Class;
        }
        return LoadClass<AGameModeBase>(nullptr, *UGameMapsSettings::GetGlobalDefaultGameMode());
    }

    void AddRuntimeClass(TMap<UBlueprint*, FBlueprintExportTarget>& Targets, UClass* Class, const FString& Role)
    {
        if (!Class) return;
        if (UBlueprint* Blueprint = Cast<UBlueprint>(Class->ClassGeneratedBy))
        {
            Targets.FindOrAdd(Blueprint).RuntimeClasses.Add(Role, Class);
        }
    }

    TSharedRef<FJsonObject> SerializeGameplay(UWorld* World, UClass* GameModeClass, TMap<UBlueprint*, FBlueprintExportTarget>& Targets)
    {
        TSharedRef<FJsonObject> Gameplay = MakeShared<FJsonObject>();
        Gameplay->SetStringField(TEXT("profile"), TEXT("scene"));
        if (!GameModeClass) return Gameplay;

        const AGameModeBase* GameMode = GameModeClass->GetDefaultObject<AGameModeBase>();
        if (!GameMode) return Gameplay;

        TSharedRef<FJsonObject> Classes = MakeShared<FJsonObject>();
        auto AddClass = [&Targets, &Classes](const TCHAR* Role, UClass* Class)
        {
            if (!Class) return;
            Classes->SetStringField(Role, Class->GetPathName());
            AddRuntimeClass(Targets, Class, Role);
        };
        AddClass(TEXT("gameMode"), GameModeClass);
        AddClass(TEXT("defaultPawn"), GameMode->DefaultPawnClass.Get());
        AddClass(TEXT("playerController"), GameMode->PlayerControllerClass.Get());
        AddClass(TEXT("hud"), GameMode->HUDClass.Get());
        AddClass(TEXT("gameState"), GameMode->GameStateClass.Get());
        AddClass(TEXT("playerState"), GameMode->PlayerStateClass.Get());
        AddClass(TEXT("spectator"), GameMode->SpectatorClass.Get());
        Gameplay->SetObjectField(TEXT("classes"), Classes);

        FVector StartLocation = FVector::ZeroVector;
        FRotator StartRotation = FRotator::ZeroRotator;
        if (World)
        {
            TActorIterator<APlayerStart> It(World);
            if (It)
            {
                StartLocation = It->GetActorLocation();
                StartRotation = It->GetActorRotation();
            }
        }
        TSharedRef<FJsonObject> PlayerStart = MakeShared<FJsonObject>();
        TSharedRef<FJsonObject> Location = MakeShared<FJsonObject>();
        Location->SetNumberField(TEXT("x"), StartLocation.X);
        Location->SetNumberField(TEXT("y"), StartLocation.Y);
        Location->SetNumberField(TEXT("z"), StartLocation.Z);
        PlayerStart->SetObjectField(TEXT("location"), Location);
        TSharedRef<FJsonObject> Rotation = MakeShared<FJsonObject>();
        Rotation->SetNumberField(TEXT("pitch"), StartRotation.Pitch);
        Rotation->SetNumberField(TEXT("yaw"), StartRotation.Yaw);
        Rotation->SetNumberField(TEXT("roll"), StartRotation.Roll);
        PlayerStart->SetObjectField(TEXT("rotation"), Rotation);
        Gameplay->SetObjectField(TEXT("playerStart"), PlayerStart);

        const ACharacter* Character = GameMode->DefaultPawnClass
            ? Cast<ACharacter>(GameMode->DefaultPawnClass->GetDefaultObject())
            : nullptr;
        const UCameraComponent* Camera = Character ? Character->FindComponentByClass<UCameraComponent>() : nullptr;
        if (!Camera && GameMode->DefaultPawnClass)
        {
            const UBlueprint* PawnBlueprint = Cast<UBlueprint>(GameMode->DefaultPawnClass->ClassGeneratedBy);
            if (PawnBlueprint && PawnBlueprint->SimpleConstructionScript)
            {
                for (const USCS_Node* Node : PawnBlueprint->SimpleConstructionScript->GetAllNodes())
                {
                    if (Node && Node->ComponentClass && Node->ComponentClass->IsChildOf(UCameraComponent::StaticClass()))
                    {
                        Camera = Cast<UCameraComponent>(Node->ComponentTemplate);
                        if (Camera) break;
                    }
                }
            }
        }
        if (Character && Camera)
        {
            Gameplay->SetStringField(TEXT("profile"), TEXT("firstPerson"));
            TSharedRef<FJsonObject> Movement = MakeShared<FJsonObject>();
            if (const UCharacterMovementComponent* CharacterMovement = Character->GetCharacterMovement())
            {
                Movement->SetNumberField(TEXT("maxWalkSpeed"), CharacterMovement->MaxWalkSpeed);
                Movement->SetNumberField(TEXT("jumpVelocity"), CharacterMovement->JumpZVelocity);
                Movement->SetNumberField(TEXT("gravityScale"), CharacterMovement->GravityScale);
            }
            if (const UCapsuleComponent* Capsule = Character->GetCapsuleComponent())
            {
                Movement->SetNumberField(TEXT("capsuleRadius"), Capsule->GetUnscaledCapsuleRadius());
                Movement->SetNumberField(TEXT("capsuleHalfHeight"), Capsule->GetUnscaledCapsuleHalfHeight());
            }
            Movement->SetNumberField(TEXT("cameraFov"), Camera->FieldOfView);
            Movement->SetNumberField(TEXT("baseEyeHeight"), Character->BaseEyeHeight);
            TSharedRef<FJsonObject> CameraLocation = MakeShared<FJsonObject>();
            const FVector RelativeLocation = Camera->GetRelativeLocation();
            CameraLocation->SetNumberField(TEXT("x"), RelativeLocation.X);
            CameraLocation->SetNumberField(TEXT("y"), RelativeLocation.Y);
            CameraLocation->SetNumberField(TEXT("z"), RelativeLocation.Z);
            Movement->SetObjectField(TEXT("cameraRelativeLocation"), CameraLocation);
            Gameplay->SetObjectField(TEXT("movement"), Movement);
        }
        return Gameplay;
    }

    TSharedRef<FJsonObject> SerializeBehaviorNode(const UBTNode* Node)
    {
        TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
        if (!Node) return Json;
        Json->SetStringField(TEXT("name"), Node->GetName());
        Json->SetStringField(TEXT("class"), Node->GetClass()->GetName());
        TSharedRef<FJsonObject> Properties = MakeShared<FJsonObject>();
        for (TFieldIterator<FProperty> It(Node->GetClass()); It; ++It)
        {
            const FProperty* Property = *It;
            if (!Property->HasAnyPropertyFlags(CPF_Edit) || Property->HasAnyPropertyFlags(CPF_Transient)) continue;
            FString Value;
            Property->ExportText_InContainer(0, Value, Node, Node, ExportParent(Node), PPF_None);
            Properties->SetStringField(Property->GetName(), Value);
        }
        Json->SetObjectField(TEXT("properties"), Properties);
        TArray<TSharedPtr<FJsonValue>> Children;
        if (const UBTCompositeNode* Composite = Cast<UBTCompositeNode>(Node))
        {
            for (int32 Index = 0; Index < Composite->GetChildrenNum(); ++Index)
            {
                if (const UBTNode* Child = Composite->GetChildNode(Index))
                {
                    Children.Add(MakeShared<FJsonValueObject>(SerializeBehaviorNode(Child)));
                }
            }
        }
        Json->SetArrayField(TEXT("children"), Children);
        return Json;
    }

    TSharedRef<FJsonObject> SerializeWidget(const UWidget* Widget)
    {
        TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
        if (!Widget) return Json;
        Json->SetStringField(TEXT("name"), Widget->GetName());
        Json->SetStringField(TEXT("class"), Widget->GetClass()->GetName());
        TSharedRef<FJsonObject> Properties = MakeShared<FJsonObject>();
        for (TFieldIterator<FProperty> It(Widget->GetClass()); It; ++It)
        {
            const FProperty* Property = *It;
            if (!Property->HasAnyPropertyFlags(CPF_Edit) || Property->HasAnyPropertyFlags(CPF_Transient)) continue;
            FString Value;
            Property->ExportText_InContainer(0, Value, Widget, Widget, ExportParent(Widget), PPF_None);
            if (!Value.IsEmpty()) Properties->SetStringField(Property->GetName(), Value);
        }
        Json->SetObjectField(TEXT("properties"), Properties);
        TArray<TSharedPtr<FJsonValue>> Children;
        if (const UPanelWidget* Panel = Cast<UPanelWidget>(Widget))
        {
            for (int32 Index = 0; Index < Panel->GetChildrenCount(); ++Index)
            {
                if (const UWidget* Child = Panel->GetChildAt(Index))
                {
                    Children.Add(MakeShared<FJsonValueObject>(SerializeWidget(Child)));
                }
            }
        }
        Json->SetArrayField(TEXT("children"), Children);
        return Json;
    }
}

FUE5BlueprintExportSummary FUE5BlueprintGraphExporter::Export(UWorld* World, const TArray<AActor*>& Actors, const FString& OutputDirectory)
{
    FUE5BlueprintExportSummary Summary;
    TMap<UBlueprint*, FBlueprintExportTarget> BlueprintTargets;
    for (AActor* Actor : Actors)
    {
        if (!Actor || !Actor->GetClass()->ClassGeneratedBy) continue;
        if (UBlueprint* Blueprint = Cast<UBlueprint>(Actor->GetClass()->ClassGeneratedBy))
        {
            BlueprintTargets.FindOrAdd(Blueprint).PlacedActors.Add(Actor);
            ++Summary.ActorInstanceCount;
        }
    }

    TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
    Root->SetStringField(TEXT("schema"), TEXT("ue-blueprint-ir/v1"));
    Root->SetStringField(TEXT("runtime"), TEXT("ue5-html5-blueprint-vm/1"));
    Root->SetObjectField(TEXT("gameplay"), SerializeGameplay(World, ResolveGameModeClass(World), BlueprintTargets));
    TArray<TSharedPtr<FJsonValue>> InputMappings;
    if (const UInputSettings* InputSettings = UInputSettings::GetInputSettings())
    {
        for (const FInputActionKeyMapping& Mapping : InputSettings->GetActionMappings())
        {
            TSharedRef<FJsonObject> MappingJson = MakeShared<FJsonObject>();
            MappingJson->SetStringField(TEXT("action"), Mapping.ActionName.ToString());
            MappingJson->SetStringField(TEXT("key"), Mapping.Key.GetFName().ToString());
            MappingJson->SetNumberField(TEXT("scale"), 1.0);
            InputMappings.Add(MakeShared<FJsonValueObject>(MappingJson));
        }
        for (const FInputAxisKeyMapping& Mapping : InputSettings->GetAxisMappings())
        {
            TSharedRef<FJsonObject> MappingJson = MakeShared<FJsonObject>();
            MappingJson->SetStringField(TEXT("action"), Mapping.AxisName.ToString());
            MappingJson->SetStringField(TEXT("key"), Mapping.Key.GetFName().ToString());
            MappingJson->SetNumberField(TEXT("scale"), Mapping.Scale);
            InputMappings.Add(MakeShared<FJsonValueObject>(MappingJson));
        }
    }
    FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
    TArray<FAssetData> MappingContextAssets;
    AssetRegistryModule.Get().GetAssetsByClass(UInputMappingContext::StaticClass()->GetClassPathName(), MappingContextAssets, true);
    for (const FAssetData& Asset : MappingContextAssets)
    {
        const UInputMappingContext* Context = Cast<UInputMappingContext>(Asset.GetAsset());
        if (!Context) continue;
        for (const FEnhancedActionKeyMapping& Mapping : Context->GetMappings())
        {
            if (!Mapping.Action) continue;
            TSharedRef<FJsonObject> MappingJson = MakeShared<FJsonObject>();
            MappingJson->SetStringField(TEXT("context"), Context->GetPathName());
            MappingJson->SetStringField(TEXT("action"), Mapping.Action->GetName());
            MappingJson->SetStringField(TEXT("actionPath"), Mapping.Action->GetPathName());
            MappingJson->SetStringField(TEXT("key"), Mapping.Key.GetFName().ToString());
            MappingJson->SetNumberField(TEXT("scale"), 1.0);
            MappingJson->SetNumberField(TEXT("valueType"), static_cast<int32>(Mapping.Action->ValueType));
            TArray<TSharedPtr<FJsonValue>> Modifiers;
            for (const UInputModifier* Modifier : Mapping.Modifiers)
            {
                if (Modifier) Modifiers.Add(MakeShared<FJsonValueString>(Modifier->GetClass()->GetName()));
            }
            MappingJson->SetArrayField(TEXT("modifiers"), Modifiers);
            TArray<TSharedPtr<FJsonValue>> Triggers;
            for (const UInputTrigger* Trigger : Mapping.Triggers)
            {
                if (Trigger) Triggers.Add(MakeShared<FJsonValueString>(Trigger->GetClass()->GetName()));
            }
            MappingJson->SetArrayField(TEXT("triggers"), Triggers);
            InputMappings.Add(MakeShared<FJsonValueObject>(MappingJson));
        }
    }
    Root->SetArrayField(TEXT("inputMappings"), InputMappings);
    TArray<FAssetData> BehaviorTreeAssets;
    AssetRegistryModule.Get().GetAssetsByClass(UBehaviorTree::StaticClass()->GetClassPathName(), BehaviorTreeAssets, true);
    TArray<TSharedPtr<FJsonValue>> BehaviorTrees;
    for (const FAssetData& Asset : BehaviorTreeAssets)
    {
        const UBehaviorTree* Tree = Cast<UBehaviorTree>(Asset.GetAsset());
        if (!Tree || !Tree->RootNode) continue;
        TSharedRef<FJsonObject> TreeJson = MakeShared<FJsonObject>();
        TreeJson->SetStringField(TEXT("name"), Tree->GetName());
        TreeJson->SetStringField(TEXT("path"), Tree->GetPathName());
        TreeJson->SetObjectField(TEXT("root"), SerializeBehaviorNode(Tree->RootNode));
        BehaviorTrees.Add(MakeShared<FJsonValueObject>(TreeJson));
    }
    Root->SetArrayField(TEXT("behaviorTrees"), BehaviorTrees);
    TArray<FAssetData> WidgetBlueprintAssets;
    AssetRegistryModule.Get().GetAssetsByClass(UWidgetBlueprint::StaticClass()->GetClassPathName(), WidgetBlueprintAssets, true);
    TArray<TSharedPtr<FJsonValue>> WidgetBlueprints;
    for (const FAssetData& Asset : WidgetBlueprintAssets)
    {
        const UWidgetBlueprint* WidgetBlueprint = Cast<UWidgetBlueprint>(Asset.GetAsset());
        if (!WidgetBlueprint || !WidgetBlueprint->WidgetTree || !WidgetBlueprint->WidgetTree->RootWidget) continue;
        TSharedRef<FJsonObject> WidgetJson = MakeShared<FJsonObject>();
        WidgetJson->SetStringField(TEXT("name"), WidgetBlueprint->GetName());
        WidgetJson->SetStringField(TEXT("path"), WidgetBlueprint->GetPathName());
        WidgetJson->SetObjectField(TEXT("root"), SerializeWidget(WidgetBlueprint->WidgetTree->RootWidget));
        WidgetBlueprints.Add(MakeShared<FJsonValueObject>(WidgetJson));
    }
    Root->SetArrayField(TEXT("widgetBlueprints"), WidgetBlueprints);
    TArray<TSharedPtr<FJsonValue>> Programs;

    for (const TPair<UBlueprint*, FBlueprintExportTarget>& Pair : BlueprintTargets)
    {
        UBlueprint* Blueprint = Pair.Key;
        TSharedRef<FJsonObject> Program = MakeShared<FJsonObject>();
        Program->SetStringField(TEXT("name"), Blueprint->GetName());
        Program->SetStringField(TEXT("path"), Blueprint->GetPathName());
        Program->SetStringField(TEXT("generatedClass"), Blueprint->GeneratedClass ? Blueprint->GeneratedClass->GetPathName() : FString());

        TArray<TSharedPtr<FJsonValue>> ActorValues;
        for (const AActor* Actor : Pair.Value.PlacedActors)
        {
            ActorValues.Add(MakeShared<FJsonValueObject>(SerializeActor(Actor, Blueprint)));
        }
        for (const TPair<FString, UClass*>& RuntimeClass : Pair.Value.RuntimeClasses)
        {
            if (const AActor* DefaultActor = RuntimeClass.Value->GetDefaultObject<AActor>())
            {
                ActorValues.Add(MakeShared<FJsonValueObject>(SerializeActor(DefaultActor, Blueprint, RuntimeClass.Key)));
                ++Summary.ActorInstanceCount;
            }
        }
        Program->SetArrayField(TEXT("actors"), ActorValues);

        TArray<TSharedPtr<FJsonValue>> GraphValues;
        TArray<TSharedPtr<FJsonValue>> Unsupported;
        TSet<FString> BlueprintFunctions;
        for (const UEdGraph* FunctionGraph : Blueprint->FunctionGraphs)
        {
            if (FunctionGraph) BlueprintFunctions.Add(Normalize(FunctionGraph->GetName()));
        }
        for (UEdGraph* Graph : CollectGraphs(Blueprint))
        {
            if (!Graph) continue;
            TSharedRef<FJsonObject> GraphJson = MakeShared<FJsonObject>();
            GraphJson->SetStringField(TEXT("name"), Graph->GetName());
            GraphJson->SetStringField(TEXT("id"), Graph->GraphGuid.ToString(EGuidFormats::DigitsWithHyphensLower));
            TArray<TSharedPtr<FJsonValue>> Nodes;
            for (const UEdGraphNode* Node : Graph->Nodes)
            {
                if (Node) Nodes.Add(MakeShared<FJsonValueObject>(SerializeNode(Node, Graph->GetName(), BlueprintFunctions, Summary, Unsupported)));
            }
            GraphJson->SetArrayField(TEXT("nodes"), Nodes);
            GraphValues.Add(MakeShared<FJsonValueObject>(GraphJson));
        }
        Program->SetArrayField(TEXT("graphs"), GraphValues);

        TSharedRef<FJsonObject> Compatibility = MakeShared<FJsonObject>();
        Compatibility->SetArrayField(TEXT("unsupported"), Unsupported);
        Compatibility->SetNumberField(TEXT("unsupportedCount"), Unsupported.Num());
        Program->SetObjectField(TEXT("compatibility"), Compatibility);
        Programs.Add(MakeShared<FJsonValueObject>(Program));
        ++Summary.BlueprintCount;
    }
    Root->SetArrayField(TEXT("programs"), Programs);

    const FString LogicDirectory = FPaths::Combine(OutputDirectory, TEXT("logic"));
    IFileManager::Get().MakeDirectory(*LogicDirectory, true);
    FString Json;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
    if (!FJsonSerializer::Serialize(Root, Writer)
        || !FFileHelper::SaveStringToFile(Json, *FPaths::Combine(LogicDirectory, TEXT("blueprints.json"))))
    {
        Summary.Error = TEXT("Could not write logic/blueprints.json.");
        return Summary;
    }

    if (Summary.UnsupportedNodeCount > 0)
    {
        Summary.Warnings.Add(FString::Printf(TEXT("Blueprint converter: %d of %d nodes are unsupported; see logic/blueprints.json."), Summary.UnsupportedNodeCount, Summary.NodeCount));
    }
    Summary.bSuccess = true;
    return Summary;
}
