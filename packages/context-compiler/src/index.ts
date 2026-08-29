import { contentHash, stableJson, type MechanicContract, type PatchSet, type VerificationIssue } from "../../contracts/src/index.js";
import { affectedVerificationCone, canonicalProjectSemanticMap, type ProjectSemanticMap } from "../../semantic-map/src/index.js";

export type ContextPriority = 0 | 1 | 2 | 3 | 4;
export type ContextItemType = "mechanic_contract" | "verification_issue" | "requested_change" | "source" | "semantic_map" | "project_memory" | "retrieved_knowledge";

export interface ContextItem {
  kind: "ContextItem";
  schemaVersion: 1;
  id: string;
  type: ContextItemType;
  source: string;
  priority: ContextPriority;
  reason: string;
  tokenEstimate: number;
  contentHash: string;
  content: string;
  relevantEntity?: string;
  required: boolean;
  evictable: boolean;
}

export interface ContextCompilationRequest {
  semanticMap: ProjectSemanticMap;
  mechanicContract: MechanicContract;
  verificationIssues: VerificationIssue[];
  requestedChange?: string;
  patchSet?: PatchSet;
}

export interface CompiledContext {
  kind: "CompiledContext";
  schemaVersion: 1;
  mechanicContractId: string;
  items: ContextItem[];
  totalTokenEstimate: number;
  candidateTokenEstimate: number;
  evictedTokenEstimate: number;
  compositionHash: string;
  modelReadyContent: string;
}

export interface ContextCompiler {
  compile(input: ContextCompilationRequest): Promise<CompiledContext>;
}

export class DeterministicContextCompiler implements ContextCompiler {
  async compile(input: ContextCompilationRequest): Promise<CompiledContext> {
    const changedPaths = input.patchSet?.operations.map((operation) => operation.path) ?? relevantRemotePaths(input.semanticMap, input.mechanicContract.name);
    const cone = affectedVerificationCone(input.semanticMap, changedPaths);
    const items: ContextItem[] = [];
    items.push(makeItem("mechanic_contract", `contract:${input.mechanicContract.id}`, 0, "MechanicContract is the non-evictable semantic target.", input.mechanicContract.id, stableJson(input.mechanicContract), true));
    for (const issue of [...input.verificationIssues].sort((left, right) => left.id.localeCompare(right.id))) items.push(makeItem("verification_issue", `issue:${issue.id}`, 0, "Current verification failure is required to guide a repair.", issue.path, stableJson(issue), true));
    if (input.requestedChange) items.push(makeItem("requested_change", "request:change", 0, "The exact requested change is required context.", input.mechanicContract.id, input.requestedChange, true));
    if (input.patchSet) items.push(makeItem("requested_change", `patch:${input.patchSet.id}`, 0, "The bounded PatchSet is required to explain the candidate change.", input.patchSet.mechanicContractId, stableJson({ id: input.patchSet.id, operations: input.patchSet.operations, expectedEffects: input.patchSet.expectedEffects }), true));

    for (const path of cone.affectedScriptPaths.length > 0 ? cone.affectedScriptPaths : changedPaths) {
      const source = input.semanticMap.files.find((file) => file.path === path);
      if (source) items.push(makeItem("source", `source:${source.path}`, 1, "Script is directly changed or reachable from the affected verification cone.", source.path, source.source, true));
    }
    const relevantFlows = input.semanticMap.remoteFlows.filter((flow) => flow.declaration.name === input.mechanicContract.name || cone.affectedRemoteIds.some((remoteId) => remoteId.includes(flow.declaration.name)));
    if (relevantFlows.length > 0) items.push(makeItem("semantic_map", `semantic-map:${input.mechanicContract.id}`, 1, "Remote flow and dependency neighborhood connects the contract to client/server state.", input.mechanicContract.id, stableJson(relevantFlows.map((flow) => ({ declaration: flow.declaration, client: flow.client.path, server: flow.server.path, clientEvidence: flow.clientEvidence, serverEvidence: flow.serverEvidence }))), true));
    const canonical = canonicalProjectSemanticMap(input.semanticMap);
    items.push(makeItem("semantic_map", `semantic-map:project:${input.semanticMap.projectId}`, 2, "Canonical project metadata provides local structure without selecting unrelated source files.", input.semanticMap.projectId, stableJson({ instances: canonical.instances, remotes: canonical.remotes, dependencies: canonical.dependencies, persistentState: canonical.persistentState, uiBindings: canonical.uiBindings }), false));
    const ordered = items.sort((left, right) => left.priority - right.priority || Number(right.required) - Number(left.required) || left.id.localeCompare(right.id));
    const totalTokenEstimate = ordered.reduce((sum, item) => sum + item.tokenEstimate, 0);
    const compositionHash = contentHash(stableJson(ordered.map(({ content, ...item }) => item)));
    return { kind: "CompiledContext", schemaVersion: 1, mechanicContractId: input.mechanicContract.id, items: ordered, totalTokenEstimate, candidateTokenEstimate: totalTokenEstimate, evictedTokenEstimate: 0, compositionHash, modelReadyContent: ordered.map((item) => `## ${item.type}: ${item.source}\n${item.content}`).join("\n\n") };
  }
}

export function contextSummary(context: CompiledContext): NonNullable<import("../../contracts/src/index.js").BuildTrace["context"]> {
  return { itemCount: context.items.length, requiredItemCount: context.items.filter((item) => item.required).length, totalTokenEstimate: context.totalTokenEstimate, candidateTokenEstimate: context.candidateTokenEstimate, evictedTokenEstimate: context.evictedTokenEstimate, compositionHash: context.compositionHash };
}

function makeItem(type: ContextItemType, source: string, priority: ContextPriority, reason: string, relevantEntity: string | undefined, content: string, required: boolean): ContextItem {
  return { kind: "ContextItem", schemaVersion: 1, id: `context_${contentHash(`${type}|${source}`).slice(0, 24)}`, type, source, priority, reason, tokenEstimate: Math.ceil(content.length / 4), contentHash: contentHash(content), content, ...(relevantEntity ? { relevantEntity } : {}), required, evictable: !required };
}

function relevantRemotePaths(map: ProjectSemanticMap, mechanicName: string): string[] {
  return map.remoteFlows.filter((flow) => flow.declaration.name === mechanicName).flatMap((flow) => [flow.client.path, flow.server.path]);
}
