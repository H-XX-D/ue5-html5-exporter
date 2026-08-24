#include "UE5HTML5BlueprintFallbackScaffolder.h"

#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphNode_Comment.h"
#include "Engine/Blueprint.h"
#include "K2Node_CallFunction.h"
#include "K2Node_FunctionEntry.h"
#include "K2Node_FunctionResult.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "ScopedTransaction.h"
#include "UE5BlueprintGraphExporter.h"

namespace
{
    UEdGraph* FindGraph(const UBlueprint* Blueprint, const FString& GraphName)
    {
        if (!Blueprint)
        {
            return nullptr;
        }
        TArray<UEdGraph*> Graphs;
        Blueprint->GetAllGraphs(Graphs);
        for (UEdGraph* Graph : Graphs)
        {
            if (Graph && Graph->GetName() == GraphName)
            {
                return Graph;
            }
        }
        return nullptr;
    }

    UK2Node_CallFunction* FindCall(UEdGraph* Graph, const FGuid& NodeId)
    {
        if (!Graph)
        {
            return nullptr;
        }
        for (UEdGraphNode* Node : Graph->Nodes)
        {
            if (Node && Node->NodeGuid == NodeId)
            {
                return Cast<UK2Node_CallFunction>(Node);
            }
        }
        return nullptr;
    }

    UEdGraph* FindFunctionGraph(const UBlueprint* Blueprint, const FString& FunctionName)
    {
        if (!Blueprint)
        {
            return nullptr;
        }
        for (UEdGraph* Graph : Blueprint->FunctionGraphs)
        {
            if (Graph && Graph->GetName().Equals(FunctionName, ESearchCase::IgnoreCase))
            {
                return Graph;
            }
        }
        return nullptr;
    }

    bool HasConnectedDataOutput(const UK2Node_CallFunction* Call)
    {
        if (!Call)
        {
            return false;
        }
        for (const UEdGraphPin* Pin : Call->Pins)
        {
            if (Pin
                && Pin->Direction == EGPD_Output
                && Pin->PinType.PinCategory != UEdGraphSchema_K2::PC_Exec
                && Pin->LinkedTo.Num() > 0)
            {
                return true;
            }
        }
        return false;
    }

    FString CandidateKey(const FUE5HTML5BlueprintRepairCandidate& Candidate)
    {
        return Candidate.BlueprintPath.ToLower() + TEXT("|") + Candidate.SuggestedFunctionName.ToLower();
    }
}

bool FUE5HTML5BlueprintFallbackScaffolder::CreateDraft(
    UBlueprint* Blueprint,
    UK2Node_CallFunction* Call,
    const FString& FunctionName,
    FString& OutDraftFunction,
    FString& OutError)
{
    OutDraftFunction = FUE5BlueprintGraphExporter::BlueprintFallbackFunctionName(FunctionName);
    if (!Blueprint || !Call || OutDraftFunction.IsEmpty())
    {
        OutError = TEXT("The audited Blueprint call is no longer available.");
        return false;
    }
    const bool bOriginalCallIsPure = Call->IsNodePure();
    if (bOriginalCallIsPure && !HasConnectedDataOutput(Call))
    {
        OutError = TEXT("The pure call no longer has a connected output to rebuild.");
        return false;
    }
    if (FUE5BlueprintGraphExporter::IsBuiltInSupportedFunction(FunctionName))
    {
        OutError = TEXT("The call is now handled by the built-in browser runtime and needs no fallback.");
        return false;
    }
    if (FindFunctionGraph(Blueprint, OutDraftFunction))
    {
        OutError = TEXT("The Blueprint already contains the suggested Web_ function.");
        return false;
    }
    const FName UniqueDraftName = FBlueprintEditorUtils::FindUniqueKismetName(Blueprint, OutDraftFunction);
    if (!UniqueDraftName.ToString().Equals(OutDraftFunction, ESearchCase::CaseSensitive))
    {
        OutError = FString::Printf(
            TEXT("The name %s conflicts with another Blueprint member. Rename that member or use a JavaScript project adapter."),
            *OutDraftFunction);
        return false;
    }

    Blueprint->Modify();
    UEdGraph* DraftGraph = FBlueprintEditorUtils::CreateNewGraph(
        Blueprint,
        FName(*OutDraftFunction),
        UEdGraph::StaticClass(),
        UEdGraphSchema_K2::StaticClass());
    if (!DraftGraph)
    {
        OutError = FString::Printf(TEXT("Could not create %s."), *OutDraftFunction);
        return false;
    }
    FBlueprintEditorUtils::AddFunctionGraph<UFunction>(Blueprint, DraftGraph, true, nullptr);

    TArray<UK2Node_FunctionEntry*> Entries;
    DraftGraph->GetNodesOfClass(Entries);
    if (Entries.Num() != 1)
    {
        FBlueprintEditorUtils::RemoveGraph(Blueprint, DraftGraph, EGraphRemoveFlags::MarkTransient);
        OutError = FString::Printf(TEXT("Unreal did not create the function entry for %s."), *OutDraftFunction);
        return false;
    }

    UK2Node_FunctionEntry* Entry = Entries[0];
    Entry->Modify();
    Entry->NodePosX = 0;
    Entry->NodePosY = 0;
    for (const UEdGraphPin* Pin : Call->Pins)
    {
        if (!Pin
            || Pin->Direction != EGPD_Input
            || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec
            || Pin->PinName == UEdGraphSchema_K2::PN_Self
            || Pin->bHidden)
        {
            continue;
        }
        if (!Entry->CreateUserDefinedPin(Pin->PinName, Pin->PinType, EGPD_Output, false))
        {
            const FString FailedPin = Pin->PinName.ToString();
            FBlueprintEditorUtils::RemoveGraph(Blueprint, DraftGraph, EGraphRemoveFlags::MarkTransient);
            OutError = FString::Printf(
                TEXT("Unreal cannot copy input '%s' into %s. Use a JavaScript project adapter for this signature."),
                *FailedPin,
                *OutDraftFunction);
            return false;
        }
    }

    TArray<const UEdGraphPin*> DataOutputs;
    for (const UEdGraphPin* Pin : Call->Pins)
    {
        if (Pin
            && Pin->Direction == EGPD_Output
            && Pin->PinType.PinCategory != UEdGraphSchema_K2::PC_Exec
            && !Pin->bHidden)
        {
            DataOutputs.Add(Pin);
        }
    }
    if (!DataOutputs.IsEmpty())
    {
        UK2Node_FunctionResult* FunctionResult = FBlueprintEditorUtils::FindOrCreateFunctionResultNode(Entry);
        if (!FunctionResult)
        {
            FBlueprintEditorUtils::RemoveGraph(Blueprint, DraftGraph, EGraphRemoveFlags::MarkTransient);
            OutError = FString::Printf(TEXT("Unreal could not create the return node for %s."), *OutDraftFunction);
            return false;
        }
        FunctionResult->Modify();
        for (const UEdGraphPin* Pin : DataOutputs)
        {
            if (!FunctionResult->CreateUserDefinedPin(Pin->PinName, Pin->PinType, EGPD_Input, false))
            {
                const FString FailedPin = Pin->PinName.ToString();
                FBlueprintEditorUtils::RemoveGraph(Blueprint, DraftGraph, EGraphRemoveFlags::MarkTransient);
                OutError = FString::Printf(
                    TEXT("Unreal cannot copy output '%s' into %s. Use a JavaScript project adapter for this signature."),
                    *FailedPin,
                    *OutDraftFunction);
                return false;
            }
        }
    }

    if (bOriginalCallIsPure)
    {
        Entry->AddExtraFlags(FUNC_BlueprintPure);
    }

    UEdGraphNode_Comment* Marker = NewObject<UEdGraphNode_Comment>(DraftGraph);
    Marker->SetFlags(RF_Transactional);
    Marker->NodePosX = -260;
    Marker->NodePosY = -180;
    Marker->NodeWidth = 1000;
    Marker->NodeHeight = 460;
    Marker->MoveMode = ECommentBoxMode::NoGroupMovement;
    Marker->CommentColor = FLinearColor(0.75f, 0.33f, 0.02f, 1.0f);
    Marker->PostPlacedNewNode();
    Marker->AllocateDefaultPins();
    Marker->NodeComment = FUE5BlueprintGraphExporter::BlueprintFallbackDraftMarker();
    const FString PureGuidance = bOriginalCallIsPure
        ? TEXT(" Keep this fallback deterministic and side-effect-free because the original call is pure.")
        : FString();
    Marker->NodeDetails = FText::FromString(FString::Printf(
        TEXT("This function receives the same visible input and output pins as %s. Rebuild only the portable behavior needed in the browser.%s The exporter deliberately keeps the original call unsupported while this marker exists."),
        *FunctionName,
        *PureGuidance));
    DraftGraph->Modify();
    DraftGraph->AddNode(Marker, true, false);

    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
    return true;
}

FUE5HTML5BlueprintFallbackScaffoldResult FUE5HTML5BlueprintFallbackScaffolder::CreateDrafts(
    const TArray<FUE5HTML5BlueprintRepairCandidate>& Candidates)
{
    FUE5HTML5BlueprintFallbackScaffoldResult Result;
    Result.AuditedCallCount = Candidates.Num();
    TSet<FString> Processed;
    const FScopedTransaction Transaction(
        FText::FromString(TEXT("Create UE5 HTML5 Blueprint Web Fallback Drafts")));

    for (const FUE5HTML5BlueprintRepairCandidate& Candidate : Candidates)
    {
        const FString Key = CandidateKey(Candidate);
        if (Processed.Contains(Key))
        {
            continue;
        }
        Processed.Add(Key);
        ++Result.UniqueDraftCount;

        UBlueprint* Blueprint = FindObject<UBlueprint>(nullptr, *Candidate.BlueprintPath);
        if (!Blueprint)
        {
            Blueprint = LoadObject<UBlueprint>(nullptr, *Candidate.BlueprintPath);
        }
        if (!Blueprint)
        {
            ++Result.SkippedDraftCount;
            Result.Warnings.Add(FString::Printf(TEXT("Could not load %s."), *Candidate.BlueprintPath));
            continue;
        }
        if (UEdGraph* Existing = FindFunctionGraph(Blueprint, Candidate.SuggestedFunctionName))
        {
            if (FUE5BlueprintGraphExporter::IsBlueprintFallbackDraftGraph(Existing))
            {
                ++Result.ExistingDraftCount;
                Result.ExistingFunctions.Add(FString::Printf(
                    TEXT("%s.%s"), *Candidate.BlueprintName, *Candidate.SuggestedFunctionName));
            }
            else
            {
                ++Result.SkippedDraftCount;
                Result.Warnings.Add(FString::Printf(
                    TEXT("%s already contains %s without a draft marker; rerun compatibility before scaffolding."),
                    *Candidate.BlueprintName,
                    *Candidate.SuggestedFunctionName));
            }
            continue;
        }

        UEdGraph* SourceGraph = FindGraph(Blueprint, Candidate.GraphName);
        UK2Node_CallFunction* Call = FindCall(SourceGraph, Candidate.NodeId);
        if (!Call || Call->FunctionReference.GetMemberName().ToString() != Candidate.FunctionName)
        {
            ++Result.SkippedDraftCount;
            Result.Warnings.Add(FString::Printf(
                TEXT("%s / %s changed after the audit; rerun compatibility before scaffolding."),
                *Candidate.BlueprintName,
                *Candidate.NodeTitle));
            continue;
        }

        FString DraftFunction;
        FString Error;
        if (!CreateDraft(Blueprint, Call, Candidate.FunctionName, DraftFunction, Error))
        {
            ++Result.SkippedDraftCount;
            Result.Warnings.Add(FString::Printf(TEXT("%s: %s"), *Candidate.BlueprintName, *Error));
            continue;
        }
        ++Result.CreatedDraftCount;
        Result.CreatedFunctions.Add(FString::Printf(TEXT("%s.%s"), *Candidate.BlueprintName, *DraftFunction));
        Result.ModifiedBlueprints.AddUnique(Blueprint);
    }

    Result.bSuccess = Result.SkippedDraftCount == 0;
    return Result;
}
