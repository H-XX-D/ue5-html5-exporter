#include "UE5BlueprintGraphExporter.h"
#include "UE5HTML5BlueprintFallbackScaffolder.h"

#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphPin.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "GameFramework/Actor.h"
#include "K2Node_CallFunction.h"
#include "K2Node_FunctionEntry.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/AutomationTest.h"
#include "UE5HTML5TargetComponent.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUE5HTML5BlueprintFallbackPolicyTest,
    "UE5HTML5Exporter.Editor.BlueprintFallbackPolicy",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUE5HTML5BlueprintFallbackPolicyTest::RunTest(const FString& Parameters)
{
    const TSet<FString> BlueprintFunctions = {
        TEXT("webnativeapplydamage"),
        TEXT("webnativeplayeffect")
    };

    TestEqual(
        TEXT("An impure action call without connected data outputs finds its Web_ Blueprint function"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            TEXT("NativeApplyDamage"), BlueprintFunctions, false, false),
        FString(TEXT("Web_NativeApplyDamage")));
    TestTrue(
        TEXT("Pure calls cannot use a side-effect-only Blueprint fallback"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            TEXT("NativeApplyDamage"), BlueprintFunctions, true, false).IsEmpty());
    TestTrue(
        TEXT("Calls with connected data outputs cannot discard their result"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            TEXT("NativeApplyDamage"), BlueprintFunctions, false, true).IsEmpty());
    TestTrue(
        TEXT("A missing Web_ Blueprint function leaves the call unsupported"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            TEXT("NativeMissing"), BlueprintFunctions, false, false).IsEmpty());
    TestTrue(
        TEXT("An empty function name cannot create a fallback"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            FString(), BlueprintFunctions, false, false).IsEmpty());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FUE5HTML5BlueprintFallbackScaffoldingTest,
    "UE5HTML5Exporter.Editor.BlueprintFallbackScaffolding",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUE5HTML5BlueprintFallbackScaffoldingTest::RunTest(const FString& Parameters)
{
    UBlueprint* Blueprint = FKismetEditorUtilities::CreateBlueprint(
        AActor::StaticClass(),
        GetTransientPackage(),
        MakeUniqueObjectName(GetTransientPackage(), UBlueprint::StaticClass(), TEXT("BP_WebFallbackScaffoldTest")),
        BPTYPE_Normal,
        NAME_None);
    TestNotNull(TEXT("A transient Blueprint is available"), Blueprint);
    if (!Blueprint || Blueprint->UbergraphPages.IsEmpty())
    {
        return false;
    }

    UFunction* NativeFunction = UUE5HTML5TargetComponent::StaticClass()->FindFunctionByName(
        GET_FUNCTION_NAME_CHECKED(UUE5HTML5TargetComponent, ApplyTargetPracticeDamage));
    TestNotNull(TEXT("The native action used by the fixture is reflected"), NativeFunction);
    if (!NativeFunction)
    {
        return false;
    }

    UEdGraph* SourceGraph = Blueprint->UbergraphPages[0];
    UK2Node_CallFunction* Call = NewObject<UK2Node_CallFunction>(SourceGraph);
    Call->SetFlags(RF_Transactional);
    Call->CreateNewGuid();
    Call->SetFromFunction(NativeFunction);
    Call->AllocateDefaultPins();
    SourceGraph->AddNode(Call, false, false);

    FUE5HTML5BlueprintRepairCandidate Candidate;
    Candidate.BlueprintPath = Blueprint->GetPathName();
    Candidate.BlueprintName = Blueprint->GetName();
    Candidate.GraphName = SourceGraph->GetName();
    Candidate.NodeId = Call->NodeGuid;
    Candidate.NodeTitle = TEXT("Apply Target Practice Damage");
    Candidate.FunctionName = TEXT("ApplyTargetPracticeDamage");
    Candidate.SuggestedFunctionName = TEXT("Web_ApplyTargetPracticeDamage");
    TArray<FUE5HTML5BlueprintRepairCandidate> Candidates = { Candidate };
    const FUE5HTML5BlueprintFallbackScaffoldResult Result =
        FUE5HTML5BlueprintFallbackScaffolder::CreateDrafts(Candidates);
    TestTrue(TEXT("An eligible impure native action can be scaffolded"), Result.bSuccess);
    TestEqual(TEXT("Exactly one fallback draft is created"), Result.CreatedDraftCount, 1);
    const FString DraftFunction = Candidate.SuggestedFunctionName;
    TestEqual(TEXT("The scaffold uses the runtime fallback convention"), DraftFunction, FString(TEXT("Web_ApplyTargetPracticeDamage")));

    const auto FindDraftGraph = [Blueprint, &DraftFunction]() -> UEdGraph*
    {
        for (UEdGraph* Graph : Blueprint->FunctionGraphs)
        {
            if (Graph && Graph->GetName() == DraftFunction)
            {
                return Graph;
            }
        }
        return nullptr;
    };
    UEdGraph* DraftGraph = FindDraftGraph();
    TestNotNull(TEXT("The matching function graph is created"), DraftGraph);
    if (!DraftGraph)
    {
        return false;
    }
    TestTrue(
        TEXT("The visible draft marker prevents premature compatibility coverage"),
        FUE5BlueprintGraphExporter::IsBlueprintFallbackDraftGraph(DraftGraph));
    TSet<FString> ExportableFunctions;
    if (!FUE5BlueprintGraphExporter::IsBlueprintFallbackDraftGraph(DraftGraph))
    {
        ExportableFunctions.Add(TEXT("webapplytargetpracticedamage"));
    }
    TestTrue(
        TEXT("A marked draft cannot cover the original call"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            TEXT("ApplyTargetPracticeDamage"), ExportableFunctions, false, false).IsEmpty());

    TArray<UK2Node_FunctionEntry*> Entries;
    DraftGraph->GetNodesOfClass(Entries);
    TestEqual(TEXT("The draft has one function entry"), Entries.Num(), 1);
    const UEdGraphPin* DamagePin = Entries.Num() == 1 ? Entries[0]->FindPin(TEXT("Damage"), EGPD_Output) : nullptr;
    TestNotNull(TEXT("The native Damage input is copied into the Blueprint function"), DamagePin);
    if (DamagePin)
    {
        TestEqual(TEXT("The copied input keeps its integer type"), DamagePin->PinType.PinCategory, UEdGraphSchema_K2::PC_Int);
    }

    TestTrue(TEXT("Undo removes the generated draft transaction"), GEditor->UndoTransaction());
    TestNull(TEXT("The draft graph is absent after Undo"), FindDraftGraph());
    TestTrue(TEXT("Redo restores the generated draft transaction"), GEditor->RedoTransaction());
    DraftGraph = FindDraftGraph();
    TestNotNull(TEXT("The draft graph returns after Redo"), DraftGraph);
    if (!DraftGraph)
    {
        return false;
    }

    UEdGraphNode* DraftMarker = nullptr;
    for (UEdGraphNode* Node : DraftGraph->Nodes)
    {
        if (Node && Node->NodeComment.StartsWith(TEXT("UE5HTML5 DRAFT FALLBACK")))
        {
            DraftMarker = Node;
            break;
        }
    }
    TestNotNull(TEXT("The draft marker is an ordinary deletable graph node"), DraftMarker);
    if (DraftMarker)
    {
        DraftGraph->RemoveNode(DraftMarker);
    }
    TestFalse(
        TEXT("Deleting the marker makes the completed function eligible for fallback coverage"),
        FUE5BlueprintGraphExporter::IsBlueprintFallbackDraftGraph(DraftGraph));
    ExportableFunctions.Add(TEXT("webapplytargetpracticedamage"));
    TestEqual(
        TEXT("The finalized graph can cover the original native action"),
        FUE5BlueprintGraphExporter::FindBlueprintFallbackFunction(
            TEXT("ApplyTargetPracticeDamage"), ExportableFunctions, false, false),
        FString(TEXT("Web_ApplyTargetPracticeDamage")));
    return true;
}

#endif
