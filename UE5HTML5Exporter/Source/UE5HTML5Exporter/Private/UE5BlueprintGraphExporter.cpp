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
#include "EdGraphNode_Comment.h"
#include "EdGraphSchema_K2.h"
#include "Engine/Blueprint.h"
#include "Engine/SCS_Node.h"
#include "Engine/SimpleConstructionScript.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Exporters/Exporter.h"
#include "Exporters/SoundExporterWAV.h"
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
#include "Misc/SecureHash.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Sound/SoundBase.h"
#include "Sound/SoundWave.h"
#include "UE5HTML5TargetComponent.h"
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

    bool IsPortableAudioFunction(const FString& FunctionName)
    {
        const FString Name = Normalize(FunctionName);
        return Name == TEXT("playsound2d") || Name == TEXT("playsoundatlocation");
    }

    bool IsPortableRpcFunction(const FString& FunctionName)
    {
        return FunctionName.StartsWith(TEXT("Server"), ESearchCase::IgnoreCase)
            || FunctionName.StartsWith(TEXT("Client"), ESearchCase::IgnoreCase)
            || FunctionName.StartsWith(TEXT("Multicast"), ESearchCase::IgnoreCase);
    }

    void RegisterSoundAsset(UObject* Object, FUE5BlueprintExportSummary& Summary)
    {
        if (USoundWave* SoundWave = Cast<USoundWave>(Object))
        {
            Summary.ReferencedSoundWaves.AddUnique(SoundWave);
        }
        else if (const USoundBase* Sound = Cast<USoundBase>(Object))
        {
            Summary.UnsupportedSoundAssets.AddUnique(Sound->GetPathName());
        }
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
        if (ClassName == TEXT("K2Node_SwitchInteger")) return TEXT("switchInteger");
        if (ClassName == TEXT("K2Node_SwitchName")) return TEXT("switchName");
        if (ClassName == TEXT("K2Node_SwitchEnum")) return TEXT("switchEnum");
        if (ClassName == TEXT("K2Node_ExecutionSequence")) return TEXT("sequence");
        if (ClassName == TEXT("K2Node_Knot")) return TEXT("knot");
        if (ClassName == TEXT("K2Node_Self")) return TEXT("self");
        if (ClassName == TEXT("K2Node_Literal") || ClassName.Contains(TEXT("EnumLiteral"))) return TEXT("literal");
        if (ClassName == TEXT("K2Node_MakeStruct")) return TEXT("makeStruct");
        if (ClassName == TEXT("K2Node_BreakStruct")) return TEXT("breakStruct");
        if (ClassName == TEXT("K2Node_Select")) return TEXT("select");
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
            TEXT("delayuntilnextframe"), TEXT("playsound2d"), TEXT("playsoundatlocation")
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

    bool IsSupportedBrowserInputEvent(const FString& EventName)
    {
        static const TSet<FString> Events = {
            TEXT("primarythumbstick"),
            TEXT("secondarythumbstick"),
            TEXT("touchjumpstart"),
            TEXT("touchjumpend")
        };
        return Events.Contains(Normalize(EventName));
    }

    bool IsSupportedEvent(const UEdGraphNode* Node, const FString& EventName)
    {
        if (Node->GetClass()->GetName().Contains(TEXT("InputKey"))) return true;
        const FString Name = Normalize(EventName);
        return Name == TEXT("receivebeginplay") || Name == TEXT("beginplay") || Name == TEXT("receivetick") || Name == TEXT("tick")
            || Name.Contains(TEXT("actorbeginoverlap")) || Name.Contains(TEXT("actorendoverlap"))
            || Name.Contains(TEXT("componentbeginoverlap")) || Name.Contains(TEXT("componentendoverlap"))
            || Name.Contains(TEXT("hit"))
            || IsSupportedBrowserInputEvent(EventName)
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

    void SetReflectedNumberField(
        const TSharedRef<FJsonObject>& Json,
        const UObject* Object,
        const TCHAR* Field,
        const TArray<FName>& PropertyNames)
    {
        const FString Value = ReflectedPropertyText(Object, PropertyNames);
        if (!Value.IsEmpty())
        {
            Json->SetNumberField(Field, FCString::Atod(*Value));
        }
    }

    void SetReflectedBoolField(
        const TSharedRef<FJsonObject>& Json,
        const UObject* Object,
        const TCHAR* Field,
        const TArray<FName>& PropertyNames)
    {
        const FString Value = ReflectedPropertyText(Object, PropertyNames);
        if (!Value.IsEmpty())
        {
            Json->SetBoolField(Field, Value.Equals(TEXT("True"), ESearchCase::IgnoreCase) || Value == TEXT("1"));
        }
    }

    void AppendInputModifier(
        const UInputModifier* Modifier,
        TArray<TSharedPtr<FJsonValue>>& ModifierNames)
    {
        if (Modifier)
        {
            ModifierNames.Add(MakeShared<FJsonValueString>(Modifier->GetClass()->GetName()));
        }
    }

    void AppendInputTrigger(
        const UInputTrigger* Trigger,
        TArray<TSharedPtr<FJsonValue>>& TriggerNames,
        TArray<TSharedPtr<FJsonValue>>& TriggerDetails)
    {
        if (!Trigger) return;

        const FString ClassName = Trigger->GetClass()->GetName();
        TriggerNames.Add(MakeShared<FJsonValueString>(ClassName));

        TSharedRef<FJsonObject> Detail = MakeShared<FJsonObject>();
        Detail->SetStringField(TEXT("class"), ClassName);
        SetReflectedNumberField(Detail, Trigger, TEXT("actuationThreshold"), { TEXT("ActuationThreshold") });
        SetReflectedNumberField(Detail, Trigger, TEXT("holdTimeThreshold"), { TEXT("HoldTimeThreshold") });
        SetReflectedNumberField(Detail, Trigger, TEXT("tapReleaseTimeThreshold"), { TEXT("TapReleaseTimeThreshold") });
        SetReflectedNumberField(Detail, Trigger, TEXT("interval"), { TEXT("Interval") });
        SetReflectedNumberField(Detail, Trigger, TEXT("triggerLimit"), { TEXT("TriggerLimit") });
        SetReflectedBoolField(Detail, Trigger, TEXT("oneShot"), { TEXT("bIsOneShot") });
        SetReflectedBoolField(Detail, Trigger, TEXT("triggerOnStart"), { TEXT("bTriggerOnStart") });
        TriggerDetails.Add(MakeShared<FJsonValueObject>(Detail));
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

    TSharedRef<FJsonObject> SerializePin(const UEdGraphPin* Pin, FUE5BlueprintExportSummary& Summary)
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
        RegisterSoundAsset(Pin->DefaultObject, Summary);
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

    TSharedRef<FJsonObject> SerializeNode(
        const UEdGraphNode* Node,
        const FString& BlueprintName,
        const FString& GraphName,
        const TSet<FString>& BlueprintFunctions,
        const TSet<FString>& PureBlueprintFunctions,
        const TSet<FString>& CustomAdapterFunctions,
        FUE5BlueprintExportSummary& Summary,
        TArray<TSharedPtr<FJsonValue>>& Unsupported,
        TArray<TSharedPtr<FJsonValue>>& CustomAdapters,
        TArray<TSharedPtr<FJsonValue>>& BlueprintFallbacks)
    {
        TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
        const FString Kind = FUE5BlueprintGraphExporter::ClassifyNodeKind(Node);
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
        bool bBuiltInSupported = Kind != TEXT("unsupported");
        bool bBlueprintFallback = false;
        bool bCustomAdapter = false;
        bool bBlueprintFallbackEligible = false;
        bool bBlueprintFallbackPurityMismatch = false;
        bool bHasConnectedDataOutputs = false;
        FString BlueprintFallbackFunction;
        if (Kind == TEXT("callFunction"))
        {
            const bool bFunctionNameIsBuiltIn = IsSupportedFunction(Function);
            bBuiltInSupported = bFunctionNameIsBuiltIn || BlueprintFunctions.Contains(Normalize(Function));
            if (bBuiltInSupported && IsPortableAudioFunction(Function))
            {
                const UEdGraphPin* SoundPin = nullptr;
                for (const UEdGraphPin* Pin : Node->Pins)
                {
                    if (Pin && Pin->Direction == EGPD_Input && Normalize(Pin->PinName.ToString()) == TEXT("sound"))
                    {
                        SoundPin = Pin;
                        break;
                    }
                }
                if (SoundPin && SoundPin->DefaultObject && !SoundPin->DefaultObject->IsA<USoundWave>())
                {
                    bBuiltInSupported = false;
                }
            }
            bCustomAdapter = !bBuiltInSupported && CustomAdapterFunctions.Contains(Normalize(Function));
            if (!bBuiltInSupported && !bCustomAdapter)
            {
                const UK2Node_CallFunction* Call = CastChecked<UK2Node_CallFunction>(Node);
                for (const UEdGraphPin* Pin : Node->Pins)
                {
                    if (Pin
                        && Pin->Direction == EGPD_Output
                        && Pin->PinType.PinCategory != UEdGraphSchema_K2::PC_Exec
                        && Pin->LinkedTo.Num() > 0)
                    {
                        bHasConnectedDataOutputs = true;
                        break;
                    }
                }
                const FString NormalizedFallbackFunction = Normalize(
                    FUE5BlueprintGraphExporter::BlueprintFallbackFunctionName(Function));
                bBlueprintFallbackPurityMismatch = Call->IsNodePure()
                    && bHasConnectedDataOutputs
                    && BlueprintFunctions.Contains(NormalizedFallbackFunction)
                    && !PureBlueprintFunctions.Contains(NormalizedFallbackFunction);
                bBlueprintFallbackEligible = !bFunctionNameIsBuiltIn
                    && (!Call->IsNodePure() || bHasConnectedDataOutputs)
                    && !bBlueprintFallbackPurityMismatch;
                BlueprintFallbackFunction = FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
                    Function,
                    BlueprintFunctions,
                    PureBlueprintFunctions,
                    Call->IsNodePure(),
                    bHasConnectedDataOutputs);
                bBlueprintFallback = !BlueprintFallbackFunction.IsEmpty();
            }
        }
        if (Kind == TEXT("event")) bBuiltInSupported = IsSupportedEvent(Node, Event);
        if (Kind == TEXT("delegate") || Kind == TEXT("interfaceCall") || Kind == TEXT("inputAction")
            || Kind == TEXT("comment") || Kind == TEXT("functionResult") || Kind == TEXT("createWidget") || Kind == TEXT("getSubsystem")) bBuiltInSupported = true;
        const bool bSupported = bBuiltInSupported || bBlueprintFallback || bCustomAdapter;

        Json->SetStringField(TEXT("id"), Node->NodeGuid.ToString(EGuidFormats::DigitsWithHyphensLower));
        Json->SetStringField(TEXT("class"), Node->GetClass()->GetName());
        Json->SetStringField(TEXT("kind"), Kind);
        Json->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
        Json->SetBoolField(TEXT("supported"), bSupported);
        Json->SetStringField(
            TEXT("supportSource"),
            bCustomAdapter
                ? TEXT("project-adapter")
                : (bBlueprintFallback
                    ? TEXT("blueprint-fallback")
                    : (bBuiltInSupported ? TEXT("built-in") : TEXT("unsupported"))));
        if (bBlueprintFallback)
        {
            Json->SetStringField(TEXT("webFallbackFunction"), BlueprintFallbackFunction);
            Json->SetBoolField(TEXT("webFallbackReturnsValue"), bHasConnectedDataOutputs);
        }
        if (bCustomAdapter) Json->SetBoolField(TEXT("runtimeValidationRequired"), true);
        Json->SetNumberField(TEXT("x"), Node->NodePosX);
        Json->SetNumberField(TEXT("y"), Node->NodePosY);
        if (!Event.IsEmpty()) Json->SetStringField(TEXT("event"), Event);
        if (IsSupportedBrowserInputEvent(Event)) Json->SetStringField(TEXT("eventAdapter"), TEXT("browser-touch-controls"));
        if (!Function.IsEmpty())
        {
            Json->SetStringField(TEXT("function"), Function);
            if (Kind == TEXT("callFunction"))
            {
                Summary.UsedFunctions.Add(Function);
                if (IsPortableRpcFunction(Function)) Summary.bUsesRpcTransport = true;
            }
        }
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
            if (Pin) Pins.Add(MakeShared<FJsonValueObject>(SerializePin(Pin, Summary)));
        }
        Json->SetArrayField(TEXT("pins"), Pins);

        ++Summary.NodeCount;
        if (bBuiltInSupported)
        {
            ++Summary.BuiltInSupportedNodeCount;
            ++Summary.SupportedNodeCount;
        }
        else if (bBlueprintFallback)
        {
            ++Summary.BlueprintFallbackNodeCount;
            ++Summary.SupportedNodeCount;
            TSharedRef<FJsonObject> Coverage = MakeShared<FJsonObject>();
            Coverage->SetStringField(TEXT("graph"), GraphName);
            Coverage->SetStringField(TEXT("node"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
            Coverage->SetStringField(TEXT("class"), Node->GetClass()->GetName());
            Coverage->SetStringField(TEXT("function"), Function);
            Coverage->SetStringField(TEXT("webFallbackFunction"), BlueprintFallbackFunction);
            BlueprintFallbacks.Add(MakeShared<FJsonValueObject>(Coverage));
        }
        else if (bCustomAdapter)
        {
            ++Summary.CustomAdapterNodeCount;
            ++Summary.SupportedNodeCount;
            TSharedRef<FJsonObject> Coverage = MakeShared<FJsonObject>();
            Coverage->SetStringField(TEXT("graph"), GraphName);
            Coverage->SetStringField(TEXT("node"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
            Coverage->SetStringField(TEXT("class"), Node->GetClass()->GetName());
            Coverage->SetStringField(TEXT("function"), Function);
            Coverage->SetBoolField(TEXT("runtimeValidationRequired"), true);
            CustomAdapters.Add(MakeShared<FJsonValueObject>(Coverage));
        }
        else
        {
            ++Summary.UnsupportedNodeCount;
            FString NodeTitle = Node->GetNodeTitle(ENodeTitleType::ListView).ToString();
            NodeTitle.ReplaceInline(TEXT("\r"), TEXT(" "));
            NodeTitle.ReplaceInline(TEXT("\n"), TEXT(" "));
            const FString FunctionDetail = Function.IsEmpty()
                ? FString()
                : FString::Printf(TEXT(" — function %s"), *Function);
            Summary.UnsupportedNodes.Add(FString::Printf(
                TEXT("%s / %s / %s [%s]%s"),
                *BlueprintName,
                *GraphName,
                *NodeTitle,
                *Node->GetClass()->GetName(),
                *FunctionDetail));
            TSharedRef<FJsonObject> Issue = MakeShared<FJsonObject>();
            Issue->SetStringField(TEXT("graph"), GraphName);
            Issue->SetStringField(TEXT("node"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
            Issue->SetStringField(TEXT("class"), Node->GetClass()->GetName());
            if (!Function.IsEmpty()) Issue->SetStringField(TEXT("function"), Function);
            const UBlueprint* OwningBlueprint = Node->GetTypedOuter<UBlueprint>();
            if (Kind == TEXT("callFunction") && bBlueprintFallbackPurityMismatch)
            {
                Issue->SetStringField(TEXT("repairKind"), TEXT("blueprint-fallback-purity"));
                Issue->SetStringField(
                    TEXT("repairReason"),
                    TEXT("The matching Web_ function exists but must be marked Pure before it can cover a pure original call."));
                Issue->SetStringField(
                    TEXT("repairInstructions"),
                    TEXT("Open the matching Web_ Blueprint function, enable Pure in its Details, and keep the graph deterministic and side-effect-free."));
            }
            else if (Kind == TEXT("callFunction") && bBlueprintFallbackEligible && OwningBlueprint)
            {
                const FString SuggestedFunction = FUE5BlueprintGraphExporter::BlueprintFallbackFunctionName(Function);
                Issue->SetStringField(TEXT("repairKind"), TEXT("blueprint-fallback-draft"));
                Issue->SetStringField(TEXT("suggestedBlueprintFunction"), SuggestedFunction);
                Issue->SetStringField(
                    TEXT("repairInstructions"),
                    TEXT("Use Create Blueprint Web Fallback Drafts, rebuild the behavior in this Blueprint, then delete the visible draft marker."));

                FUE5HTML5BlueprintRepairCandidate Candidate;
                Candidate.BlueprintPath = OwningBlueprint->GetPathName();
                Candidate.BlueprintName = BlueprintName;
                Candidate.GraphName = GraphName;
                Candidate.NodeId = Node->NodeGuid;
                Candidate.NodeTitle = NodeTitle;
                Candidate.FunctionName = Function;
                Candidate.SuggestedFunctionName = SuggestedFunction;
                Summary.BlueprintRepairCandidates.Add(MoveTemp(Candidate));
            }
            else
            {
                Issue->SetStringField(TEXT("repairKind"), TEXT("project-adapter"));
                if (Kind == TEXT("callFunction")
                    && CastChecked<UK2Node_CallFunction>(Node)->IsNodePure()
                    && !bHasConnectedDataOutputs)
                {
                    Issue->SetStringField(TEXT("repairReason"), TEXT("A pure call without a connected result has no portable value consumer to rebuild."));
                }
                else if (Kind == TEXT("callFunction") && bBlueprintFallbackEligible && !OwningBlueprint)
                {
                    Issue->SetStringField(TEXT("repairReason"), TEXT("The exporter could not resolve the owning Blueprint for this call."));
                }
                else
                {
                    Issue->SetStringField(TEXT("repairReason"), TEXT("This node is outside the Blueprint-only fallback contract."));
                }
            }
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

    TSharedRef<FJsonObject> SerializeActor(
        const AActor* Actor,
        const UBlueprint* Blueprint,
        FUE5BlueprintExportSummary& Summary,
        const FString& RuntimeRole = FString())
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
            if (const FObjectPropertyBase* ObjectProperty = CastField<FObjectPropertyBase>(Property))
            {
                RegisterSoundAsset(ObjectProperty->GetObjectPropertyValue_InContainer(Actor), Summary);
            }
            FString Value;
            Property->ExportText_InContainer(0, Value, Actor, Actor, ExportParent(Actor), PPF_None);
            TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("value"), Value);
            Entry->SetStringField(TEXT("category"), Variable.VarType.PinCategory.ToString());
            Entry->SetStringField(TEXT("subcategory"), Variable.VarType.PinSubCategory.ToString());
            const bool bReplicated = Property->HasAnyPropertyFlags(CPF_Net);
            Entry->SetBoolField(TEXT("replicated"), bReplicated);
            if (bReplicated) Summary.bUsesReplicatedProperties = true;
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
        TArray<TSharedPtr<FJsonValue>> TargetDefinitions;
        if (World)
        {
            for (TActorIterator<AActor> It(World); It; ++It)
            {
                const AActor* Actor = *It;
                const UUE5HTML5TargetComponent* Target = Actor
                    ? Actor->FindComponentByClass<UUE5HTML5TargetComponent>()
                    : nullptr;
                if (!Actor || !Target)
                {
                    continue;
                }

                TSharedRef<FJsonObject> TargetJson = MakeShared<FJsonObject>();
                TargetJson->SetStringField(TEXT("id"), Actor->GetPathName());
                TargetJson->SetStringField(TEXT("label"), Actor->GetActorLabel());
                TargetJson->SetStringField(TEXT("objectName"), Actor->GetName());
                TargetJson->SetNumberField(TEXT("maxHealth"), FMath::Max(1, Target->MaxHealth));
                TargetJson->SetNumberField(TEXT("damagePerShot"), FMath::Max(1, Target->DamagePerShot));
                TargetJson->SetNumberField(TEXT("scoreValue"), FMath::Max(0, Target->ScoreValue));
                TargetJson->SetBoolField(TEXT("respawn"), Target->bRespawn);
                TargetJson->SetNumberField(TEXT("respawnDelaySeconds"), FMath::Max(0.05f, Target->RespawnDelaySeconds));
                TargetJson->SetNumberField(TEXT("hitFlashSeconds"), FMath::Max(0.0f, Target->HitFlashSeconds));
                TargetDefinitions.Add(MakeShared<FJsonValueObject>(TargetJson));
            }
        }
        Gameplay->SetArrayField(TEXT("targets"), TargetDefinitions);
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

    bool ExportSoundAssets(
        const FString& OutputDirectory,
        bool bExportSupportingAssets,
        FUE5BlueprintExportSummary& Summary,
        const TSharedRef<FJsonObject>& Root)
    {
        TSharedRef<FJsonObject> AudioAssets = MakeShared<FJsonObject>();
        AudioAssets->SetStringField(TEXT("schema"), TEXT("ue5-html5-audio-assets/v1"));
        TArray<TSharedPtr<FJsonValue>> Sounds;
        if (!bExportSupportingAssets)
        {
            AudioAssets->SetArrayField(TEXT("sounds"), Sounds);
            Root->SetObjectField(TEXT("audioAssets"), AudioAssets);
            return true;
        }

        Summary.ReferencedSoundWaves.Sort([](const USoundWave& Left, const USoundWave& Right)
        {
            return Left.GetPathName() < Right.GetPathName();
        });
        const FString AudioDirectory = FPaths::Combine(OutputDirectory, TEXT("assets/audio"));
        if (Summary.ReferencedSoundWaves.Num() > 0 && !IFileManager::Get().MakeDirectory(*AudioDirectory, true))
        {
            Summary.Error = TEXT("Could not create assets/audio for referenced SoundWave files.");
            return false;
        }

        USoundExporterWAV* Exporter = NewObject<USoundExporterWAV>();
        for (USoundWave* SoundWave : Summary.ReferencedSoundWaves)
        {
            if (!SoundWave || !Exporter->SupportsObject(SoundWave))
            {
                Summary.Error = FString::Printf(
                    TEXT("Referenced SoundWave '%s' cannot be exported as a mono/stereo WAV."),
                    SoundWave ? *SoundWave->GetPathName() : TEXT("<null>"));
                return false;
            }
            const FString SourcePath = SoundWave->GetPathName();
            const FString FileName = FString::Printf(
                TEXT("%s-%s.wav"),
                *FMD5::HashAnsiString(*SourcePath).Left(12),
                *FPaths::MakeValidFileName(SoundWave->GetName(), TEXT('_')));
            const FString RelativePath = FString::Printf(TEXT("assets/audio/%s"), *FileName);
            const FString Destination = FPaths::Combine(OutputDirectory, RelativePath);
            if (UExporter::ExportToFile(SoundWave, Exporter, *Destination, false, false, false) != 1)
            {
                Summary.Error = FString::Printf(TEXT("Could not export referenced SoundWave '%s' to WAV."), *SourcePath);
                return false;
            }
            TSharedRef<FJsonObject> Sound = MakeShared<FJsonObject>();
            Sound->SetStringField(TEXT("source"), SourcePath);
            Sound->SetStringField(TEXT("path"), RelativePath);
            Sound->SetNumberField(TEXT("durationSeconds"), FMath::Max(0.0f, SoundWave->Duration));
            Sound->SetNumberField(TEXT("channels"), SoundWave->NumChannels);
            Sounds.Add(MakeShared<FJsonValueObject>(Sound));
        }
        AudioAssets->SetArrayField(TEXT("sounds"), Sounds);
        Root->SetObjectField(TEXT("audioAssets"), AudioAssets);
        return true;
    }
}

FString FUE5BlueprintGraphExporter::ClassifyNodeKind(const UEdGraphNode* Node)
{
    return Node ? NodeKind(Node) : TEXT("unsupported");
}

FString FUE5BlueprintGraphExporter::BlueprintFallbackFunctionName(const FString& FunctionName)
{
    return FunctionName.IsEmpty() ? FString() : FString::Printf(TEXT("Web_%s"), *FunctionName);
}

FString FUE5BlueprintGraphExporter::BlueprintFallbackDraftMarker()
{
    return TEXT("UE5HTML5 DRAFT FALLBACK — rebuild the browser behavior below, test it in Unreal, then delete this comment to mark the fallback ready for export.");
}

bool FUE5BlueprintGraphExporter::IsBlueprintFallbackDraftGraph(const UEdGraph* Graph)
{
    if (!Graph)
    {
        return false;
    }
    for (const UEdGraphNode* Node : Graph->Nodes)
    {
        const UEdGraphNode_Comment* Comment = Cast<UEdGraphNode_Comment>(Node);
        if (Comment && Comment->NodeComment.StartsWith(TEXT("UE5HTML5 DRAFT FALLBACK")))
        {
            return true;
        }
    }
    return false;
}

bool FUE5BlueprintGraphExporter::IsBuiltInSupportedFunction(const FString& FunctionName)
{
    return IsSupportedFunction(FunctionName);
}

FString FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
    const FString& FunctionName,
    const TSet<FString>& BlueprintFunctions,
    const TSet<FString>& PureBlueprintFunctions,
    bool bIsPure,
    bool bHasConnectedDataOutputs)
{
    if (FunctionName.IsEmpty() || (bIsPure && !bHasConnectedDataOutputs))
    {
        return FString();
    }
    const FString Candidate = BlueprintFallbackFunctionName(FunctionName);
    const FString NormalizedCandidate = Normalize(Candidate);
    if (!BlueprintFunctions.Contains(NormalizedCandidate)
        || (bIsPure && !PureBlueprintFunctions.Contains(NormalizedCandidate)))
    {
        return FString();
    }
    return Candidate;
}

FUE5BlueprintExportSummary FUE5BlueprintGraphExporter::Export(
    UWorld* World,
    const TArray<AActor*>& Actors,
    const FString& OutputDirectory,
    const TSet<FString>& CustomAdapterFunctions,
    bool bExportSupportingAssets)
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
    TSharedRef<FJsonObject> AdapterContract = MakeShared<FJsonObject>();
    AdapterContract->SetStringField(TEXT("schema"), TEXT("ue5-html5-custom-adapters/v1"));
    AdapterContract->SetStringField(TEXT("manifest"), TEXT("logic/custom-adapters.json"));
    AdapterContract->SetStringField(TEXT("module"), TEXT("logic/custom-adapters.js"));
    AdapterContract->SetNumberField(TEXT("declaredFunctionCount"), CustomAdapterFunctions.Num());
    AdapterContract->SetBoolField(TEXT("runtimeValidationRequired"), CustomAdapterFunctions.Num() > 0);
    Root->SetObjectField(TEXT("projectAdapters"), AdapterContract);
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
                AppendInputModifier(Modifier, Modifiers);
            }
            for (const UInputModifier* Modifier : Mapping.Action->Modifiers)
            {
                AppendInputModifier(Modifier, Modifiers);
            }
            MappingJson->SetArrayField(TEXT("modifiers"), Modifiers);
            TArray<TSharedPtr<FJsonValue>> Triggers;
            TArray<TSharedPtr<FJsonValue>> TriggerDetails;
            for (const UInputTrigger* Trigger : Mapping.Triggers)
            {
                AppendInputTrigger(Trigger, Triggers, TriggerDetails);
            }
            for (const UInputTrigger* Trigger : Mapping.Action->Triggers)
            {
                AppendInputTrigger(Trigger, Triggers, TriggerDetails);
            }
            MappingJson->SetArrayField(TEXT("triggers"), Triggers);
            MappingJson->SetArrayField(TEXT("triggerDetails"), TriggerDetails);
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
            ActorValues.Add(MakeShared<FJsonValueObject>(SerializeActor(Actor, Blueprint, Summary)));
        }
        for (const TPair<FString, UClass*>& RuntimeClass : Pair.Value.RuntimeClasses)
        {
            if (const AActor* DefaultActor = RuntimeClass.Value->GetDefaultObject<AActor>())
            {
                ActorValues.Add(MakeShared<FJsonValueObject>(SerializeActor(DefaultActor, Blueprint, Summary, RuntimeClass.Key)));
                ++Summary.ActorInstanceCount;
            }
        }
        Program->SetArrayField(TEXT("actors"), ActorValues);

        TArray<TSharedPtr<FJsonValue>> GraphValues;
        TArray<TSharedPtr<FJsonValue>> Unsupported;
        TArray<TSharedPtr<FJsonValue>> CustomAdapters;
        TArray<TSharedPtr<FJsonValue>> BlueprintFallbacks;
        TSet<FString> BlueprintFunctions;
        TSet<FString> PureBlueprintFunctions;
        for (const UEdGraph* FunctionGraph : Blueprint->FunctionGraphs)
        {
            if (FunctionGraph && !IsBlueprintFallbackDraftGraph(FunctionGraph))
            {
                const FString NormalizedFunction = Normalize(FunctionGraph->GetName());
                BlueprintFunctions.Add(NormalizedFunction);
                TArray<UK2Node_FunctionEntry*> Entries;
                FunctionGraph->GetNodesOfClass(Entries);
                if (Entries.Num() == 1 && (Entries[0]->GetFunctionFlags() & FUNC_BlueprintPure) != 0)
                {
                    PureBlueprintFunctions.Add(NormalizedFunction);
                }
            }
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
                if (Node) Nodes.Add(MakeShared<FJsonValueObject>(SerializeNode(
                    Node,
                    Blueprint->GetName(),
                    Graph->GetName(),
                    BlueprintFunctions,
                    PureBlueprintFunctions,
                    CustomAdapterFunctions,
                    Summary,
                    Unsupported,
                    CustomAdapters,
                    BlueprintFallbacks)));
            }
            GraphJson->SetArrayField(TEXT("nodes"), Nodes);
            GraphValues.Add(MakeShared<FJsonValueObject>(GraphJson));
        }
        Program->SetArrayField(TEXT("graphs"), GraphValues);

        TSharedRef<FJsonObject> Compatibility = MakeShared<FJsonObject>();
        Compatibility->SetArrayField(TEXT("unsupported"), Unsupported);
        Compatibility->SetNumberField(TEXT("unsupportedCount"), Unsupported.Num());
        Compatibility->SetArrayField(TEXT("projectAdapters"), CustomAdapters);
        Compatibility->SetNumberField(TEXT("projectAdapterCount"), CustomAdapters.Num());
        Compatibility->SetArrayField(TEXT("blueprintFallbacks"), BlueprintFallbacks);
        Compatibility->SetNumberField(TEXT("blueprintFallbackCount"), BlueprintFallbacks.Num());
        Compatibility->SetBoolField(TEXT("runtimeValidationRequired"), CustomAdapters.Num() > 0);
        Program->SetObjectField(TEXT("compatibility"), Compatibility);
        Programs.Add(MakeShared<FJsonValueObject>(Program));
        ++Summary.BlueprintCount;
    }
    Root->SetArrayField(TEXT("programs"), Programs);
    if (!ExportSoundAssets(OutputDirectory, bExportSupportingAssets, Summary, Root))
    {
        return Summary;
    }
    if (Summary.UnsupportedSoundAssets.Num() > 0)
    {
        Summary.Warnings.Add(FString::Printf(
            TEXT("Audio adapter: %d referenced Sound Cue/procedural asset(s) require direct SoundWave literals or a project adapter."),
            Summary.UnsupportedSoundAssets.Num()));
    }

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
