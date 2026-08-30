import { contentHash, stableJson, type MechanicContract, type MechanicImplementationSpec, type PatchSet, type VerificationIssue } from "../../contracts/src/index.js";
import { affectedVerificationCone, canonicalProjectSemanticMap, type ProjectSemanticMap } from "../../semantic-map/src/index.js";

export type ContextPriority = 0 | 1 | 2 | 3 | 4;
export type ContextItemType = "game_intent" | "core_loop" | "mechanic_contract" | "mechanic_implementation_spec" | "generation_policy" | "verification_issue" | "requested_change" | "source" | "semantic_map" | "project_memory" | "retrieved_knowledge";

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
  mechanicImplementationSpec: MechanicImplementationSpec;
  verificationIssues: VerificationIssue[];
  requestedChange?: string;
  patchSet?: PatchSet;
  generationPolicy?: { allowedPaths: string[]; maxFiles: number; maxAddedLines: number; maxRemovedLines: number; maxSourceBytes: number };
  /** Provenance-bearing loop context for an incremental mechanic extension. */
  gameIntent?: unknown;
  coreLoop?: unknown;
  verifiedMechanics?: Array<{ name: string; contract: unknown; proofBundleId: string; sourceHashes: Record<string, string> }>;
  /** Explicit seed allow-list. Omitted means normal repair context selection. */
  allowedSourcePaths?: string[];
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
    if (input.gameIntent) items.push(makeItem("game_intent", "game-intent", 0, "The preserved GameIntent constrains an incremental extension.", input.mechanicContract.id, stableJson(input.gameIntent), true));
    if (input.coreLoop) items.push(makeItem("core_loop", "core-loop", 0, "The preserved CoreLoop fixes node identity and status transitions.", input.mechanicContract.id, stableJson(input.coreLoop), true));
    items.push(makeItem("mechanic_contract", `contract:${input.mechanicContract.id}`, 0, "MechanicContract is the non-evictable semantic target.", input.mechanicContract.id, stableJson(input.mechanicContract), true));
    items.push(makeItem("mechanic_implementation_spec", `implementation:${input.mechanicImplementationSpec.id}`, 0, "MechanicImplementationSpec is the Forge-owned, non-evictable project ABI and state boundary.", input.mechanicImplementationSpec.id, stableJson(input.mechanicImplementationSpec), true));
    if (input.mechanicImplementationSpec.interactionBinding) {
      const interaction = input.semanticMap.interactionBindings.find((binding) => binding.mechanicName === input.mechanicContract.name);
      if (!interaction) throw new Error(`ProjectSemanticMap is missing the declared interaction binding for ${input.mechanicContract.name}`);
      items.push(makeItem("semantic_map", `interaction:${input.mechanicContract.name}`, 1, "Production initiation and independent server authorization are required project interface facts.", input.mechanicContract.id, stableJson(interaction), true));
    }
    if (input.generationPolicy) items.push(makeItem("generation_policy", "generation-policy", 0, "Generation policy is a non-evictable hard boundary.", input.mechanicContract.id, stableJson(input.generationPolicy), true));
    for (const issue of [...input.verificationIssues].sort((left, right) => left.id.localeCompare(right.id))) items.push(makeItem("verification_issue", `issue:${issue.id}`, 0, "Current verification failure is required to guide a repair.", issue.path, stableJson(issue), true));
    if (input.requestedChange) items.push(makeItem("requested_change", "request:change", 0, "The exact requested change is required context.", input.mechanicContract.id, input.requestedChange, true));
    if (input.patchSet) items.push(makeItem("requested_change", `patch:${input.patchSet.id}`, 0, "The bounded PatchSet is required to explain the candidate change.", input.patchSet.mechanicContractId, stableJson({ id: input.patchSet.id, operations: input.patchSet.operations, expectedEffects: input.patchSet.expectedEffects }), true));

    const candidatePaths = cone.affectedScriptPaths.length > 0 ? cone.affectedScriptPaths : changedPaths;
    const sharedStateNames = new Set(input.mechanicImplementationSpec.stateBindings.map((binding) => binding.name));
    const sharedStatePaths = input.semanticMap.remoteFlows
      .filter((flow) => flow.declaration.name !== input.mechanicContract.name && flow.declaration.implementation?.stateBindings.some((binding) => sharedStateNames.has(binding.name)))
      .map((flow) => flow.server.path);
    const declaredSourceTargets = input.mechanicImplementationSpec.sourceTargets.map((target) => target.path);
    const selectedPaths = [...new Set([...candidatePaths, ...sharedStatePaths, ...declaredSourceTargets])]
      .filter((path) => !input.allowedSourcePaths || input.allowedSourcePaths.includes(path));
    for (const path of selectedPaths) {
      const source = input.semanticMap.files.find((file) => file.path === path);
      if (source) {
        const shared = sharedStatePaths.includes(path) && !changedPaths.includes(path);
        items.push(makeItem("source", `source:${source.path}`, 1, shared ? "Server source shares a declared authoritative state binding with this mechanic." : "Script is directly changed or reachable from the affected verification cone.", source.path, source.source, true));
      }
    }
    for (const verified of input.verifiedMechanics ?? []) items.push(makeItem("semantic_map", `verified-mechanic:${verified.name}`, 1, "Prior verified mechanic provenance protects a regression binding without exposing a historical answer patch.", verified.name, stableJson({ name: verified.name, contract: verified.contract, proofBundleId: verified.proofBundleId, sourceHashes: verified.sourceHashes }), true));
    const relevantFlows = input.semanticMap.remoteFlows.filter((flow) => flow.declaration.name === input.mechanicContract.name || cone.affectedRemoteIds.some((remoteId) => remoteId.includes(flow.declaration.name)));
    if (relevantFlows.length > 0) items.push(makeItem("semantic_map", `semantic-map:${input.mechanicContract.id}`, 1, "Remote flow and dependency neighborhood connects the contract to client/server state.", input.mechanicContract.id, stableJson(relevantFlows.map((flow) => ({ declaration: flow.declaration, clientAction: flow.client.path, interactionClient: flow.interactionClient.path, server: flow.server.path, clientEvidence: flow.clientEvidence, interactionEvidence: flow.interactionEvidence, serverEvidence: flow.serverEvidence }))), true));
    const canonical = canonicalProjectSemanticMap(input.semanticMap);
    items.push(makeItem("semantic_map", `semantic-map:project:${input.semanticMap.projectId}`, 2, "Canonical project metadata provides local structure without selecting unrelated source files.", input.semanticMap.projectId, stableJson({ instances: canonical.instances, remotes: canonical.remotes, interactionBindings: canonical.interactionBindings, dependencies: canonical.dependencies, persistentState: canonical.persistentState, uiBindings: canonical.uiBindings }), false));
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
  return map.remoteFlows.filter((flow) => flow.declaration.name === mechanicName).flatMap((flow) => [flow.client.path, flow.interactionClient.path, flow.server.path]);
}
