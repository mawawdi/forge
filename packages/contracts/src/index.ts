import { createHash } from "node:crypto";

export type ID = string;
export type ISO8601 = string;
export type RelativePath = string;
export type Hash = string;

export type Risk = "low" | "medium" | "high" | "critical";
export type Authority = "client" | "server" | "shared" | "external";
export type VerificationStatus = "pass" | "fail" | "not_run" | "unknown";
export type RemoteValidationCategory = "type" | "value" | "context" | "permission" | "rate_limit" | "ownership";
export type ValidationApplicability = "required" | "not_applicable";

export interface GameIntent {
  kind: "GameIntent";
  schemaVersion: 1;
  id: ID;
  rawPrompt: string;
  normalizedGoal: string;
  audience: "novice_creator" | "experienced_creator" | "unknown";
  genreSignals: string[];
  desiredOutcomes: string[];
  constraints: Array<{ id: ID; statement: string; source: "creator" | "system" }>;
  referencedMechanics: string[];
  unresolvedQuestions: string[];
  source: { type: "creator_prompt"; createdAt: ISO8601 };
}

/**
 * The only shape a model may use to describe a creator request. Forge assigns
 * all durable IDs and security-relevant semantics after locally validating it.
 */
export interface IntentDraft {
  kind: "IntentDraft";
  schemaVersion: 1;
  normalizedGoal: string;
  audience: "novice_creator" | "experienced_creator" | "unknown";
  genreSignals: string[];
  desiredOutcomes: string[];
  unresolvedQuestions: string[];
  selectedMechanic: "CollectFruit";
  coreLoop: {
    title: string;
    nodes: Array<{ id: string; label: string; category: CoreLoop["nodes"][number]["category"] }>;
    edges: Array<{ from: string; to: string; condition?: string }>;
    entryNodeId: string;
  };
}

/** A bounded follow-up request against an already-declared CoreLoop. */
export interface CoreLoopExtensionDraft {
  kind: "CoreLoopExtensionDraft";
  schemaVersion: 1;
  normalizedGoal: string;
  desiredOutcomes: string[];
  unresolvedQuestions: string[];
  selectedMechanic: "SellInventory";
}

/** A model proposal is deliberately source-only; Forge supplies every precondition. */
export interface ModelPatchProposal {
  kind: "ModelPatchProposal";
  schemaVersion: 1;
  mechanicContractId: string;
  rationale: string;
  operations: Array<{ type: "replace_text"; path: RelativePath; after: string }>;
}

export interface GenerationAttempt {
  kind: "GenerationAttempt";
  schemaVersion: 1;
  id: ID;
  type: "initial" | "model_repair" | "deterministic_repair";
  model?: { provider: string; name: string; requestHash: Hash; responseHash: Hash };
  patchSetId?: ID;
  verificationStatus: "verified" | "rejected" | "incomplete";
  issueCodes: string[];
}

export interface GenerationRun {
  kind: "GenerationRun";
  schemaVersion: 1;
  id: ID;
  status: "verified" | "rejected" | "incomplete";
  classification: "FIRST_PASS_VERIFIED" | "DETERMINISTICALLY_REPAIRED_VERIFIED" | "MODEL_REPAIRED_VERIFIED" | null;
  gameIntentId?: ID;
  coreLoopId?: ID;
  mechanicContractId?: ID;
  patchSetId?: ID;
  attempts: GenerationAttempt[];
  traceId?: ID;
  proofBundleId?: ID;
  generatedAt: ISO8601;
}

export interface CoreLoop {
  kind: "CoreLoop";
  schemaVersion: 1;
  id: ID;
  intentId: ID;
  title: string;
  nodes: Array<{
    id: ID;
    label: string;
    category: "acquisition" | "conversion" | "progression" | "social" | "retention" | "monetization";
    mechanicContractId?: ID;
    status: "proposed" | "in_progress" | "verified";
  }>;
  edges: Array<{ from: ID; to: ID; condition?: string }>;
  entryNodeId: ID;
  nextRecommendedNodeId?: ID;
  invariants: string[];
}

export interface MechanicContract {
  kind: "MechanicContract";
  schemaVersion: 2;
  id: ID;
  coreLoopId: ID;
  name: string;
  playerGoal: string;
  preconditions: Array<{ id: ID; statement: string; authority: Authority }>;
  postconditions: Array<{ id: ID; statement: string; authority: Authority }>;
  authorityModel: {
    stateOwner: Authority;
    clientInputs: Array<{ position: number; role: string; type: string; trust: "untrusted" | "informational" }>;
    validationRequirements: Array<{ category: RemoteValidationCategory; subjectRole: string; applicability: ValidationApplicability; rationale: string }>;
    stateMutations: Array<{ field: string; authority: Authority; operation: string }>;
  };
  persistentState: Array<{ field: string; type: string; owner: "server"; durability: "session" | "persistent" }>;
  uiOutputs: Array<{ binding: string; sourceField: string; direction: "server_to_client" | "local" }>;
  economyEffects: Array<{ currency: string; delta: string; computedBy: "server" | "none" }>;
  instrumentation: Array<{ event: string; fields: string[]; privacyClass: "none" | "project" | "creator_sensitive" }>;
  studioAssertions: ID[];
  risk: Risk;
}

/**
 * Forge-owned project interface supplied to a model. It describes the exact
 * ABI, state representation, and safety boundary without containing source or
 * an implementation template.
 */
export interface MechanicImplementationSpec {
  kind: "MechanicImplementationSpec";
  schemaVersion: 4;
  id: ID;
  mechanicContractId: ID;
  mechanicName: string;
  remote: {
    stableId: ID;
    path: string;
    className: "RemoteEvent" | "RemoteFunction";
    direction: "client_to_server" | "server_to_client";
    preserveExisting: boolean;
  };
  interactionBinding?: InteractionBinding;
  clientInputs: Array<{ position: number; role: string; type: string; trust: "untrusted" | "informational" }>;
  serverArguments: Array<{ position: number; role: string; type: string; source: "roblox_server" | "client" }>;
  stateBindings: Array<{
    role: string;
    subject: "player" | "target" | "world";
    storage: "attribute" | "property" | "table" | "instance" | "tag";
    name: string;
    type: string;
    authority: Authority;
  }>;
  constants: Array<{ role: string; type: "number" | "string" | "boolean"; value: string | number | boolean }>;
  validationRequirements: Array<{ category: RemoteValidationCategory; subjectRole: string; applicability: ValidationApplicability; rationale: string }>;
  stateMutations: Array<{ field: string; authority: Authority; operation: string }>;
  postconditions: string[];
  authorityInvariants: string[];
  sourceTargets: Array<{ path: RelativePath; executionContext: "server" | "client" | "shared" }>;
  allowedPatchOperations: Array<"replace_text" | "create_script">;
}

/** Bounded production initiation plus an independent server authorization boundary. */
export type InteractionBinding = {
  kind: "InteractionBinding";
  schemaVersion: 2;
  requirement: "explicit_user_action";
  production:
    | { kind: "pointer_click"; event: "Button1Down"; targetTag: string }
    | { kind: "proximity_prompt"; path: string; className: "ProximityPrompt"; event: "Triggered"; maxActivationDistance: number };
  clientAction:
    | { kind: "input_event" }
    | { kind: "module_function"; modulePath: string; sourcePath: RelativePath; functionName: string; argumentMode: "none" | "target_instance" };
  serverAuthorization:
    | { kind: "distance"; target: "requested_target"; maxDistance: number }
    | { kind: "distance"; target: "bound_instance"; path: string; maxDistance: number };
};

export interface PatchSet {
  kind: "PatchSet";
  schemaVersion: 1;
  id: ID;
  projectHash: Hash;
  mechanicContractId: ID;
  operations: Array<
    | { type: "create_script"; path: RelativePath; source: string; executionContext: "server" | "client" | "shared" }
    | { type: "replace_function"; path: RelativePath; symbol: string; beforeHash: Hash; source: string }
    | { type: "replace_text"; path: RelativePath; beforeHash: Hash; before: string; after: string }
    | { type: "create_instance"; opId?: ID; path: string; className: string; properties?: Record<string, string | number | boolean>; attributes?: Record<string, string | number | boolean>; tags?: string[] }
    | { type: "delete_instance"; opId?: ID; path: string; expectedClassName?: string }
    | { type: "set_property"; opId?: ID; path: string; property: string; value: string | number | boolean; before?: string | number | boolean }
    | { type: "set_attribute"; opId?: ID; path: string; attribute: string; value: string | number | boolean; before?: string | number | boolean }
    | { type: "move_instance"; opId?: ID; path: string; parentPath: string }
    | { type: "insert_statement"; path: RelativePath; symbol: string; anchor: string; source: string }
    | { type: "create_remote"; path: RelativePath; name: string; direction: "client_to_server" | "server_to_client" }
    | { type: "bind_ui"; path: RelativePath; binding: string; sourceField: string }
  >;
  expectedEffects: Array<{ statement: string; evidence: "static" | "contract" | "preflight" | "studio" }>;
  provenance: { model?: string; promptHash?: Hash; generatedAt: ISO8601 };
  bounds: { maxFiles: number; maxAddedLines: number; maxRemovedLines: number };
}

export interface VerificationIssue {
  kind: "VerificationIssue";
  schemaVersion: 1;
  id: ID;
  ruleId: string;
  severity: "info" | "warning" | "error" | "critical";
  category: "language" | "runtime_boundary" | "replication" | "security" | "persistence" | "economy" | "structure" | "performance" | "tooling";
  message: string;
  path?: RelativePath;
  location?: { line: number; column: number; endLine?: number; endColumn?: number };
  evidence: Array<{ type: "analyzer" | "ast" | "semantic_graph" | "test" | "studio"; statement: string; data?: Record<string, string | number | boolean> }>;
  remediation?: { kind: "deterministic" | "model_required" | "manual"; steps: string[] };
  authoritativeTier: "static" | "preflight" | "studio";
}

export interface StudioAssertion {
  kind: "StudioAssertion";
  schemaVersion: 1;
  id: ID;
  mechanicContractId: ID;
  name: string;
  setup: Array<{ action: string; actor: "server" | "client_1" | "client_2" | "system"; args?: Record<string, string | number | boolean> }>;
  actions: Array<{ action: string; actor: "server" | "client_1" | "client_2" | "system"; args?: Record<string, string | number | boolean> }>;
  observations: Array<{ path: string; relation: "equals" | "not_equals" | "increases_by" | "exists" | "rejected"; expected: string | number | boolean }>;
  authorityExpectation?: { mutationPath: string; owner: "server"; clientCannotSet: string[] };
  timeoutMs: number;
  tags: string[];
}

export type TrajectoryEventName = "intent_received" | "core_loop_resolved" | "contract_compiled" | "patch_proposed" | "verification_completed" | "repair_applied" | "studio_run_completed" | "creator_accepted" | "creator_rejected";

export interface TrajectoryEvent {
  kind: "TrajectoryEvent";
  schemaVersion: 1;
  id: ID;
  sequence: number;
  occurredAt: ISO8601;
  event: TrajectoryEventName;
  actor: "creator" | "forge" | "model" | "tool" | "studio" | "system";
  projectId: ID;
  references: Partial<BuildTrace["references"]>;
  payloadHash: Hash;
  attributes: Record<string, TraceAttributeValue>;
  privacyClass: "none" | "project" | "creator_sensitive";
}

export interface ProofBundle {
  kind: "ProofBundle";
  schemaVersion: 4;
  id: ID;
  projectHash: Hash;
  projectSnapshotBeforeHash: Hash;
  projectSnapshotAfterHash: Hash;
  mechanicContractId: ID;
  mechanicContractHash: Hash;
  patchSetId: ID;
  patchSetHash: Hash;
  buildTraceId?: ID;
  generatedAt: ISO8601;
  toolchain: Array<{ name: string; version: string; command: string; configHash: Hash }>;
  checks: Array<{ name: string; tier: "static" | "preflight" | "studio"; status: VerificationStatus; issueIds: ID[]; resultHash?: Hash }>;
  issues: VerificationIssue[];
  assertions: Array<{ assertionId: ID; mechanicContractId: ID; status: VerificationStatus; observed?: Record<string, string | number | boolean>; runId?: ID }>;
  candidate?: {
    artifactId: ID;
    artifactHash: Hash;
    gameIntentId: ID;
    gameIntentHash: Hash;
    coreLoopId: ID;
    coreLoopHash: Hash;
    implementationSpecId: ID;
    implementationSpecHash: Hash;
    contextCompositionHash: Hash;
    model: { provider: string; name: string; classification: GenerationRun["classification"] };
  };
  regressions?: Array<{ mechanicContractId: ID; mechanicContractHash: Hash; proofBundleId: ID; sourceHashes: Record<RelativePath, Hash> }>;
  studioProof?: {
    testPlanId: ID;
    testPlanVersion: string;
    runId: ID;
    proofRunHash: Hash;
    correlationId: ID;
    sessionId: ID;
    projectId: ID;
    mechanicContractHash: Hash;
    harnessId: string;
    harnessVersion: string;
    harnessHash: Hash;
    projectSnapshotHash: Hash;
    pluginVersion: string;
    studioVersion: string;
    assertionResultIds: ID[];
    status: "pass" | "fail" | "incomplete";
    authoritative: boolean;
  };
  gate: { status: "verified" | "rejected" | "incomplete"; reasons: string[] };
  reproducibility: { inputHash: Hash; dependencyHash: Hash; ruleSetHash: Hash; deterministic: boolean };
}

export type TraceAttributeValue = string | number | boolean | string[];

export type ForgeSpanName =
  | "forge.project.snapshot"
  | "forge.intent.compile"
  | "forge.contract.validate"
  | "forge.agent.execute"
  | "forge.model.generate"
  | "forge.tool.call"
  | "forge.patch.create"
  | "forge.patch.apply"
  | "forge.verify.luau"
  | "forge.verify.replication"
  | "forge.verify.economy"
  | "forge.verify.structure"
  | "forge.repair.deterministic"
  | "forge.repair.model"
  | "forge.studio.connect"
  | "forge.studio.snapshot"
  | "forge.studio.transaction.begin"
  | "forge.studio.patch.apply"
  | "forge.studio.start"
  | "forge.studio.playtest"
  | "forge.studio.action"
  | "forge.studio.assert"
  | "forge.studio.adversarial"
  | "forge.studio.playtest.stop"
  | "forge.studio.transaction.commit"
  | "forge.studio.transaction.rollback"
  | "forge.commit.verified"
  | "forge.commit.rejected";

export type ForgeEventName = "forge.issue.detected" | "forge.build.completed";

export interface ComponentVersion {
  name: string;
  version: string;
  configHash?: Hash;
}

export interface ModelConfiguration {
  provider: string;
  name: string;
  version?: string;
  configurationHash: Hash;
}

export interface BuildTraceSpan {
  id: ID;
  sequence: number;
  name: ForgeSpanName;
  startedAt: ISO8601;
  endedAt: ISO8601;
  durationMs: number;
  status: "ok" | "error";
  attributes: Record<string, TraceAttributeValue>;
}

export interface BuildTraceEvent {
  id: ID;
  sequence: number;
  name: ForgeEventName;
  occurredAt: ISO8601;
  attributes: Record<string, TraceAttributeValue>;
}

export interface BuildOutcome {
  status: "accepted" | "rejected" | "incomplete";
  verified: boolean;
  staticPass: boolean;
  semanticPass: boolean;
  studioPass: VerificationStatus;
  attempts: number;
  deterministicRepairs: number;
  modelRepairs: number;
  assertions: { total: number; passed: number };
  modelUsage: { calls: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  latencyMs: { total: number; projectSnapshot?: number; luau?: number; replication?: number; studio?: number };
  issueCounts: Record<"info" | "warning" | "error" | "critical", number>;
}

export interface BuildTrace {
  kind: "BuildTrace";
  schemaVersion: 1;
  id: ID;
  buildKey: ID;
  startedAt: ISO8601;
  endedAt: ISO8601;
  project: {
    id: ID;
    startingSnapshotHash?: Hash;
    resultingSnapshotHash?: Hash;
    sourceHash?: Hash;
    structureHash?: Hash;
    semanticHash?: Hash;
    manifestHash?: Hash;
    snapshotRetention: "not_retained" | "external_reference" | "embedded_fixture";
  };
  references: {
    gameIntentId?: ID;
    coreLoopId?: ID;
    mechanicContractId?: ID;
    patchSetId?: ID;
    benchmarkCaseId?: ID;
    generationRunId?: ID;
    generationAttemptId?: ID;
    modelResponseHash?: Hash;
    /** Additive M4.1 harness references. Absent on preserved historical traces. */
    agentRunId?: ID;
    requirementSetId?: ID;
    requirementViewId?: ID;
    workspaceDeltaId?: ID;
    harnessConfigurationId?: ID;
    harnessConfigurationHash?: Hash;
  };
  components: {
    toolchain: ComponentVersion[];
    verifiers: ComponentVersion[];
    agent?: ComponentVersion;
    model?: ModelConfiguration;
    repairPolicy?: ComponentVersion;
    studio?: ComponentVersion;
  };
  spans: BuildTraceSpan[];
  events: BuildTraceEvent[];
  context?: {
    itemCount: number;
    requiredItemCount: number;
    totalTokenEstimate: number;
    candidateTokenEstimate: number;
    evictedTokenEstimate: number;
    compositionHash: Hash;
  };
  outcome: BuildOutcome;
  evidence: {
    verificationReportHash?: Hash;
    proofBundleId?: ID;
    issues: Array<{ id: ID; ruleId: string; severity: VerificationIssue["severity"]; category: VerificationIssue["category"]; evidenceHash: Hash }>;
  };
  replayability: {
    level: "none" | "semantic_reproduction" | "exact_replay";
    reasons: string[];
    randomSeeds: Record<string, number>;
  };
  privacy: {
    rawSourceStored: false;
    rawPromptStored: false;
    creatorIdentityStored: false;
  };
}

export interface TracePersistence {
  kind: "TracePersistence";
  schemaVersion: 1;
  traceId: ID;
  buildKey: ID;
  status: "written" | "failed" | "disabled";
  artifactHash?: Hash;
  locator?: RelativePath;
  error?: string;
}

export interface RemoteFlowDeclaration {
  name: string;
  direction: "client_to_server" | "server_to_client";
  remote: { stableId: ID; path: string; className: "RemoteEvent" | "RemoteFunction"; preserveExisting: boolean };
  clientScript: RelativePath;
  interactionScript?: RelativePath;
  serverScript: RelativePath;
  clientInputs: Array<{ position: number; role: string; type: string; trust: "untrusted" | "informational" }>;
  serverArguments: Array<{ position: number; role: string; type: string; source: "roblox_server" | "client" }>;
  interactionBinding?: InteractionBinding;
  validationRequirements: Array<{ category: RemoteValidationCategory; subjectRole: string; applicability: ValidationApplicability; rationale: string }>;
  stateMutations: Array<{ field: string; sourceExpression: string; authority: Authority; operation: string }>;
  implementation?: {
    stateBindings: MechanicImplementationSpec["stateBindings"];
    constants: MechanicImplementationSpec["constants"];
    postconditions: string[];
    authorityInvariants: string[];
  };
}

export interface ForgeFixtureManifest {
  kind: "ForgeFixture";
  schemaVersion: 5;
  name: string;
  luauRoots: RelativePath[];
  remoteFlows: RemoteFlowDeclaration[];
  instances?: Array<{ path: string; className: string; parentPath?: string; position?: { x: number; y: number; z: number }; properties?: Record<string, string | number | boolean>; attributes?: Record<string, string | number | boolean>; tags?: string[] }>;
  persistentState?: Array<{ field: string; type: string; owner: "server"; durability: "session" | "persistent" }>;
  uiBindings?: Array<{ path: string; sourceField: string; direction: "server_to_client" | "local" }>;
  generationTarget?: {
    mode: "core_loop_extension";
    gameIntentPath: RelativePath;
    coreLoopPath: RelativePath;
    targetNodeId: ID;
    verifiedMechanics: Array<{ name: string; contractPath: RelativePath; proofBundleId: ID; sourceHashes: Record<RelativePath, Hash> }>;
  };
}

export interface VerificationReport {
  kind: "VerificationReport";
  schemaVersion: 1;
  projectPath: RelativePath;
  projectHash: Hash;
  toolchain: Array<{ name: string; version: string; command: string; configHash: Hash }>;
  issues: VerificationIssue[];
  checks: Array<{ name: string; status: VerificationStatus; issueIds: ID[] }>;
  gate: { status: "verified" | "rejected" | "incomplete"; reasons: string[] };
  reproducibility: { inputHash: Hash; dependencyHash: Hash; ruleSetHash: Hash; deterministic: boolean };
}

export function contentHash(value: string): Hash {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function assertBuildTrace(value: unknown): asserts value is BuildTrace {
  if (!isRecord(value) || value.kind !== "BuildTrace" || value.schemaVersion !== 1) {
    throw new Error("Invalid BuildTrace: expected schemaVersion 1");
  }
  if (!isString(value.id) || !isString(value.buildKey) || !isString(value.startedAt) || !isString(value.endedAt)) {
    throw new Error("Invalid BuildTrace: missing trace identity or timestamps");
  }
  if (!isProjectReference(value.project)) {
    throw new Error("Invalid BuildTrace: invalid project reference");
  }
  if (!isTraceReferences(value.references) || !isTraceComponents(value.components) || (value.context !== undefined && !isTraceContext(value.context)) || !Array.isArray(value.spans) || !Array.isArray(value.events)) {
    throw new Error("Invalid BuildTrace: invalid execution context");
  }
  if (!isBuildOutcome(value.outcome) || !isTraceEvidence(value.evidence) || !isReplayability(value.replayability) || !isPrivacy(value.privacy)) {
    throw new Error("Invalid BuildTrace: invalid outcome or evidence");
  }
  for (const span of value.spans) assertTraceSpan(span);
  for (const event of value.events) assertTraceEvent(event);
}

export function assertTracePersistence(value: unknown): asserts value is TracePersistence {
  if (!isRecord(value) || value.kind !== "TracePersistence" || value.schemaVersion !== 1 || !isString(value.traceId) || !isString(value.buildKey) || !isTracePersistenceStatus(value.status)) {
    throw new Error("Invalid TracePersistence");
  }
}

export function assertFixtureManifest(value: unknown): asserts value is ForgeFixtureManifest {
  if (!isRecord(value) || value.kind !== "ForgeFixture" || value.schemaVersion !== 5 || typeof value.name !== "string") {
    throw new Error("Invalid ForgeFixture manifest: expected schemaVersion 5");
  }
  if (!Array.isArray(value.luauRoots) || !value.luauRoots.every((entry) => typeof entry === "string")) {
    throw new Error("Invalid ForgeFixture manifest: luauRoots must be string[]");
  }
  if (!Array.isArray(value.remoteFlows)) {
    throw new Error("Invalid ForgeFixture manifest: remoteFlows must be an array");
  }
  if (value.instances !== undefined && (!Array.isArray(value.instances) || !value.instances.every((entry) => isRecord(entry) && isString(entry.path) && isString(entry.className) && (entry.position === undefined || isVector3(entry.position))))) throw new Error("Invalid ForgeFixture instances");
  if (value.persistentState !== undefined && !Array.isArray(value.persistentState)) throw new Error("Invalid ForgeFixture persistentState");
  if (value.uiBindings !== undefined && !Array.isArray(value.uiBindings)) throw new Error("Invalid ForgeFixture uiBindings");
  if (value.generationTarget !== undefined) {
    if (!isRecord(value.generationTarget) || value.generationTarget.mode !== "core_loop_extension" || !isString(value.generationTarget.gameIntentPath) || !isString(value.generationTarget.coreLoopPath) || !isString(value.generationTarget.targetNodeId) || !Array.isArray(value.generationTarget.verifiedMechanics)) throw new Error("Invalid ForgeFixture generation target");
    for (const mechanic of value.generationTarget.verifiedMechanics) {
      if (!isRecord(mechanic) || !isString(mechanic.name) || !isString(mechanic.contractPath) || !isString(mechanic.proofBundleId) || !isRecord(mechanic.sourceHashes) || !Object.values(mechanic.sourceHashes).every(isString)) throw new Error("Invalid ForgeFixture verified mechanic provenance");
    }
  }
  for (const flow of value.remoteFlows) assertRemoteFlow(flow);
}

export function assertGameIntent(value: unknown): asserts value is GameIntent {
  if (!isRecord(value) || value.kind !== "GameIntent" || value.schemaVersion !== 1 || !isString(value.id) || !isString(value.rawPrompt) || !isString(value.normalizedGoal) || !Array.isArray(value.genreSignals) || !Array.isArray(value.desiredOutcomes) || !Array.isArray(value.constraints) || !Array.isArray(value.referencedMechanics) || !Array.isArray(value.unresolvedQuestions) || !isRecord(value.source) || value.source.type !== "creator_prompt" || !isString(value.source.createdAt)) {
    throw new Error("Invalid GameIntent: expected schemaVersion 1");
  }
}

export function assertCoreLoop(value: unknown): asserts value is CoreLoop {
  if (!isRecord(value) || value.kind !== "CoreLoop" || value.schemaVersion !== 1 || !isString(value.id) || !isString(value.intentId) || !isString(value.title) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !isString(value.entryNodeId) || !Array.isArray(value.invariants)) {
    throw new Error("Invalid CoreLoop: expected schemaVersion 1");
  }
}

export function assertMechanicContract(value: unknown): asserts value is MechanicContract {
  if (!isRecord(value) || value.kind !== "MechanicContract" || value.schemaVersion !== 2 || !isString(value.id) || !isString(value.coreLoopId) || !isString(value.name) || !isString(value.playerGoal) || !isArrayOfRecords(value.preconditions) || !isArrayOfRecords(value.postconditions) || !isRecord(value.authorityModel) || !isString(value.authorityModel.stateOwner) || !Array.isArray(value.authorityModel.clientInputs) || !Array.isArray(value.authorityModel.validationRequirements) || !Array.isArray(value.authorityModel.stateMutations) || !Array.isArray(value.persistentState) || !Array.isArray(value.uiOutputs) || !Array.isArray(value.economyEffects) || !Array.isArray(value.instrumentation) || !Array.isArray(value.studioAssertions) || !isRisk(value.risk)) {
    throw new Error("Invalid MechanicContract: expected schemaVersion 2");
  }
  assertPositionalInputs(value.authorityModel.clientInputs, "MechanicContract client inputs");
  assertValidationRequirements(value.authorityModel.validationRequirements, "MechanicContract validation requirements");
}

export function assertMechanicImplementationSpec(value: unknown): asserts value is MechanicImplementationSpec {
  if (!isRecord(value) || value.kind !== "MechanicImplementationSpec" || value.schemaVersion !== 4 || !isString(value.id) || !isString(value.mechanicContractId) || !isString(value.mechanicName) || !isRecord(value.remote) || !isString(value.remote.stableId) || !isString(value.remote.path) || !["RemoteEvent", "RemoteFunction"].includes(String(value.remote.className)) || !["client_to_server", "server_to_client"].includes(String(value.remote.direction)) || typeof value.remote.preserveExisting !== "boolean" || !Array.isArray(value.clientInputs) || !Array.isArray(value.serverArguments) || !Array.isArray(value.stateBindings) || !Array.isArray(value.constants) || !Array.isArray(value.validationRequirements) || !Array.isArray(value.stateMutations) || !Array.isArray(value.postconditions) || !Array.isArray(value.authorityInvariants) || !Array.isArray(value.sourceTargets) || !Array.isArray(value.allowedPatchOperations)) {
    throw new Error("Invalid MechanicImplementationSpec");
  }
  if (value.interactionBinding !== undefined) assertInteractionBinding(value.interactionBinding, "MechanicImplementationSpec interaction binding");
  assertPositionalInputs(value.clientInputs, "MechanicImplementationSpec client inputs");
  assertServerArguments(value.serverArguments, "MechanicImplementationSpec server arguments");
  assertValidationRequirements(value.validationRequirements, "MechanicImplementationSpec validation requirements");
  if (!value.sourceTargets.every((target) => isRecord(target) && isString(target.path) && ["server", "client", "shared"].includes(String(target.executionContext)))) throw new Error("Invalid MechanicImplementationSpec source targets");
  if (!value.allowedPatchOperations.every((operation) => operation === "replace_text" || operation === "create_script")) throw new Error("Invalid MechanicImplementationSpec patch operations");
}

export function assertPatchSet(value: unknown): asserts value is PatchSet {
  if (!isRecord(value) || value.kind !== "PatchSet" || value.schemaVersion !== 1 || !isString(value.id) || !isString(value.projectHash) || !isString(value.mechanicContractId) || !Array.isArray(value.operations) || !Array.isArray(value.expectedEffects) || !isRecord(value.provenance) || !isString(value.provenance.generatedAt) || !isRecord(value.bounds) || !isNonNegativeInteger(value.bounds.maxFiles) || !isNonNegativeInteger(value.bounds.maxAddedLines) || !isNonNegativeInteger(value.bounds.maxRemovedLines)) {
    throw new Error("Invalid PatchSet: expected schemaVersion 1");
  }
  for (const operation of value.operations) {
    if (!isRecord(operation) || !isString(operation.type) || !isString(operation.path)) throw new Error("Invalid PatchSet operation");
    if (operation.type === "replace_text" && (!isString(operation.beforeHash) || !isString(operation.before) || !isString(operation.after))) throw new Error("Invalid PatchSet replace_text operation");
    if (operation.type === "replace_function" && (!isString(operation.symbol) || !isString(operation.beforeHash) || !isString(operation.source))) throw new Error("Invalid PatchSet replace_function operation");
    if (operation.type === "create_script" && (!isString(operation.source) || !isExecutionContext(operation.executionContext))) throw new Error("Invalid PatchSet create_script operation");
    if (operation.type === "create_instance" && (!isString(operation.className) || !optionalRecord(operation.properties) || !optionalRecord(operation.attributes) || !optionalStringArray(operation.tags))) throw new Error("Invalid PatchSet create_instance operation");
    if (operation.type === "delete_instance" && operation.expectedClassName !== undefined && !isString(operation.expectedClassName)) throw new Error("Invalid PatchSet delete_instance operation");
    if (operation.type === "set_property" && (!isString(operation.property) || !isPrimitive(operation.value) || !optionalPrimitive(operation.before))) throw new Error("Invalid PatchSet set_property operation");
    if (operation.type === "set_attribute" && (!isString(operation.attribute) || !isPrimitive(operation.value) || !optionalPrimitive(operation.before))) throw new Error("Invalid PatchSet set_attribute operation");
    if (operation.type === "move_instance" && !isString(operation.parentPath)) throw new Error("Invalid PatchSet move_instance operation");
    if (operation.type === "insert_statement" && (!isString(operation.symbol) || !isString(operation.anchor) || !isString(operation.source))) throw new Error("Invalid PatchSet insert_statement operation");
    if (operation.type === "create_remote" && (!isString(operation.name) || !isRemoteDirection(operation.direction))) throw new Error("Invalid PatchSet create_remote operation");
    if (operation.type === "bind_ui" && (!isString(operation.binding) || !isString(operation.sourceField))) throw new Error("Invalid PatchSet bind_ui operation");
    if (!["replace_text", "replace_function", "create_script", "create_instance", "delete_instance", "set_property", "set_attribute", "move_instance", "insert_statement", "create_remote", "bind_ui"].includes(operation.type)) throw new Error(`Invalid PatchSet operation type: ${operation.type}`);
  }
}

export function assertStudioAssertion(value: unknown): asserts value is StudioAssertion {
  if (!isRecord(value) || value.kind !== "StudioAssertion" || value.schemaVersion !== 1 || !isString(value.id) || !isString(value.mechanicContractId) || !isString(value.name) || !Array.isArray(value.setup) || !Array.isArray(value.actions) || !Array.isArray(value.observations) || !isNonNegativeInteger(value.timeoutMs) || !Array.isArray(value.tags)) {
    throw new Error("Invalid StudioAssertion: expected schemaVersion 1");
  }
}

export function assertTrajectoryEvent(value: unknown): asserts value is TrajectoryEvent {
  if (!isRecord(value) || value.kind !== "TrajectoryEvent" || value.schemaVersion !== 1 || !isString(value.id) || !isNonNegativeInteger(value.sequence) || !isString(value.occurredAt) || !isTrajectoryEventName(value.event) || !isString(value.actor) || !isString(value.projectId) || !isTraceReferences(value.references) || !isString(value.payloadHash) || !isTraceAttributes(value.attributes) || !["none", "project", "creator_sensitive"].includes(String(value.privacyClass))) {
    throw new Error("Invalid TrajectoryEvent: expected schemaVersion 1");
  }
}

export function assertProofBundle(value: unknown): asserts value is ProofBundle {
  if (!isRecord(value) || value.kind !== "ProofBundle" || value.schemaVersion !== 4 || !isString(value.id) || !isString(value.projectHash) || !isString(value.projectSnapshotBeforeHash) || !isString(value.projectSnapshotAfterHash) || !isString(value.mechanicContractId) || !isString(value.mechanicContractHash) || !isString(value.patchSetId) || !isString(value.patchSetHash) || !isString(value.generatedAt) || !Array.isArray(value.toolchain) || !Array.isArray(value.checks) || !Array.isArray(value.issues) || !Array.isArray(value.assertions) || !isRecord(value.gate) || !isGateStatus(value.gate.status) || !Array.isArray(value.gate.reasons) || !isRecord(value.reproducibility) || optionalString(value.buildTraceId) === false || (value.studioProof !== undefined && !isStudioProof(value.studioProof))) {
    throw new Error("Invalid ProofBundle: expected schemaVersion 4");
  }
}

function assertRemoteFlow(value: unknown): asserts value is RemoteFlowDeclaration {
  if (!isRecord(value) || typeof value.name !== "string" || (value.direction !== "client_to_server" && value.direction !== "server_to_client")) {
    throw new Error("Invalid ForgeFixture remote flow");
  }
  if (!isRecord(value.remote) || !isString(value.remote.stableId) || !isString(value.remote.path) || !["RemoteEvent", "RemoteFunction"].includes(String(value.remote.className)) || typeof value.remote.preserveExisting !== "boolean") throw new Error("Invalid ForgeFixture remote identity");
  if (typeof value.clientScript !== "string" || typeof value.serverScript !== "string" || (value.interactionScript !== undefined && typeof value.interactionScript !== "string")) throw new Error("Invalid ForgeFixture remote flow paths");
  assertPositionalInputs(value.clientInputs, "ForgeFixture client inputs");
  assertServerArguments(value.serverArguments, "ForgeFixture server arguments");
  if (value.interactionBinding !== undefined) assertInteractionBinding(value.interactionBinding, "ForgeFixture interaction binding");
  assertValidationRequirements(value.validationRequirements, "ForgeFixture validation requirements");
  if (!Array.isArray(value.stateMutations) || !value.stateMutations.every((mutation) => isRecord(mutation) && isString(mutation.field) && isString(mutation.sourceExpression) && isString(mutation.authority) && isString(mutation.operation))) throw new Error("Invalid ForgeFixture state mutations");
}

function assertInteractionBinding(value: unknown, label: string): asserts value is InteractionBinding {
  if (!isRecord(value) || value.kind !== "InteractionBinding" || value.schemaVersion !== 2 || value.requirement !== "explicit_user_action" || !isRecord(value.production) || !isRecord(value.clientAction) || !isRecord(value.serverAuthorization) || value.serverAuthorization.kind !== "distance" || !isFinitePositiveNumber(value.serverAuthorization.maxDistance)) throw new Error(`Invalid ${label}`);
  if (value.clientAction.kind === "module_function") {
    if (!isString(value.clientAction.modulePath) || !isString(value.clientAction.sourcePath) || !isString(value.clientAction.functionName) || !["none", "target_instance"].includes(String(value.clientAction.argumentMode))) throw new Error(`Invalid ${label} client action module`);
  } else if (value.clientAction.kind !== "input_event") throw new Error(`Invalid ${label} client action`);
  if (value.production.kind === "pointer_click") {
    if (value.production.event !== "Button1Down" || !isString(value.production.targetTag) || value.serverAuthorization.target !== "requested_target") throw new Error(`Invalid ${label} pointer click`);
  } else if (value.production.kind === "proximity_prompt") {
    if (!isString(value.production.path) || value.production.className !== "ProximityPrompt" || value.production.event !== "Triggered" || !isFinitePositiveNumber(value.production.maxActivationDistance) || value.serverAuthorization.target !== "bound_instance" || !isString(value.serverAuthorization.path)) throw new Error(`Invalid ${label} ProximityPrompt`);
  } else throw new Error(`Invalid ${label} production initiation`);
}

function isVector3(value: unknown): value is { x: number; y: number; z: number } {
  return isRecord(value) && typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y) && typeof value.z === "number" && Number.isFinite(value.z);
}

function isFinitePositiveNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }

function assertPositionalInputs(value: unknown, label: string): void {
  if (!Array.isArray(value) || !value.every((entry) => isRecord(entry) && isNonNegativeInteger(entry.position) && entry.position >= 1 && isString(entry.role) && isString(entry.type) && (entry.trust === "untrusted" || entry.trust === "informational"))) throw new Error(`Invalid ${label}`);
  const positions = value.map((entry) => (entry as { position: number }).position);
  if (new Set(positions).size !== positions.length || [...positions].sort((a, b) => a - b).some((position, index) => position !== index + 1)) throw new Error(`Invalid ${label}: positions must be unique and contiguous from 1`);
}

function assertServerArguments(value: unknown, label: string): void {
  if (!Array.isArray(value) || !value.every((entry) => isRecord(entry) && isNonNegativeInteger(entry.position) && isString(entry.role) && isString(entry.type) && (entry.source === "roblox_server" || entry.source === "client"))) throw new Error(`Invalid ${label}`);
  const positions = value.map((entry) => (entry as { position: number }).position);
  if (new Set(positions).size !== positions.length) throw new Error(`Invalid ${label}: duplicate positions`);
}

function assertValidationRequirements(value: unknown, label: string): void {
  if (!Array.isArray(value) || !value.every((entry) => isRecord(entry) && isRemoteValidationCategory(entry.category) && isString(entry.subjectRole) && (entry.applicability === "required" || entry.applicability === "not_applicable") && isString(entry.rationale))) throw new Error(`Invalid ${label}`);
}

function isRemoteValidationCategory(value: unknown): value is RemoteValidationCategory {
  return value === "type" || value === "value" || value === "context" || value === "permission" || value === "rate_limit" || value === "ownership";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot serialize non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
      const item = value[key];
      if (item !== undefined) normalized[key] = normalizeJson(item);
    }
    return normalized;
  }
  throw new TypeError(`Cannot serialize value of type ${typeof value}`);
}

function assertTraceSpan(value: unknown): asserts value is BuildTraceSpan {
  if (!isRecord(value) || !isString(value.id) || typeof value.sequence !== "number" || !isForgeSpanName(value.name) || !isString(value.startedAt) || !isString(value.endedAt) || typeof value.durationMs !== "number" || (value.status !== "ok" && value.status !== "error") || !isTraceAttributes(value.attributes)) {
    throw new Error("Invalid BuildTrace span");
  }
}

function assertTraceEvent(value: unknown): asserts value is BuildTraceEvent {
  if (!isRecord(value) || !isString(value.id) || typeof value.sequence !== "number" || !isForgeEventName(value.name) || !isString(value.occurredAt) || !isTraceAttributes(value.attributes)) {
    throw new Error("Invalid BuildTrace event");
  }
}

function isBuildOutcome(value: unknown): value is BuildOutcome {
  return isRecord(value) && isOutcomeStatus(value.status) && typeof value.verified === "boolean" && typeof value.staticPass === "boolean" && typeof value.semanticPass === "boolean" && isVerificationStatus(value.studioPass) && typeof value.attempts === "number" && typeof value.deterministicRepairs === "number" && typeof value.modelRepairs === "number" && isRecord(value.assertions) && typeof value.assertions.total === "number" && typeof value.assertions.passed === "number" && isRecord(value.modelUsage) && typeof value.modelUsage.calls === "number" && nullableNumber(value.modelUsage.inputTokens) && nullableNumber(value.modelUsage.outputTokens) && nullableNumber(value.modelUsage.costUsd) && isLatency(value.latencyMs) && isIssueCounts(value.issueCounts);
}

function isTraceEvidence(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.issues) && value.issues.every((issue) => isRecord(issue) && isString(issue.id) && isString(issue.ruleId) && isIssueSeverity(issue.severity) && isIssueCategory(issue.category) && isString(issue.evidenceHash));
}

function isTraceContext(value: unknown): boolean {
  return isRecord(value) && isNonNegativeInteger(value.itemCount) && isNonNegativeInteger(value.requiredItemCount) && isNonNegativeInteger(value.totalTokenEstimate) && isNonNegativeInteger(value.candidateTokenEstimate) && isNonNegativeInteger(value.evictedTokenEstimate) && isString(value.compositionHash);
}

function isReplayability(value: unknown): boolean {
  return isRecord(value) && (value.level === "none" || value.level === "semantic_reproduction" || value.level === "exact_replay") && Array.isArray(value.reasons) && isRecord(value.randomSeeds);
}

function isPrivacy(value: unknown): boolean {
  return isRecord(value) && value.rawSourceStored === false && value.rawPromptStored === false && value.creatorIdentityStored === false;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function optionalPrimitive(value: unknown): boolean { return value === undefined || isPrimitive(value); }
function optionalRecord(value: unknown): boolean { return value === undefined || isRecord(value); }
function optionalStringArray(value: unknown): boolean { return value === undefined || (Array.isArray(value) && value.every(isString)); }

function isStudioProof(value: unknown): boolean {
  return isRecord(value) && isString(value.testPlanId) && isString(value.testPlanVersion) && isString(value.runId) && isString(value.proofRunHash) && isString(value.correlationId) && isString(value.sessionId) && isString(value.projectId) && isString(value.mechanicContractHash) && isString(value.harnessId) && isString(value.harnessVersion) && isString(value.harnessHash) && isString(value.projectSnapshotHash) && isString(value.pluginVersion) && isString(value.studioVersion) && Array.isArray(value.assertionResultIds) && value.assertionResultIds.every(isString) && ["pass", "fail", "incomplete"].includes(String(value.status)) && typeof value.authoritative === "boolean";
}

function isArrayOfRecords(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isRecord);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRisk(value: unknown): value is Risk {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isExecutionContext(value: unknown): boolean {
  return value === "server" || value === "client" || value === "shared";
}

function isRemoteDirection(value: unknown): boolean {
  return value === "client_to_server" || value === "server_to_client";
}

function isGateStatus(value: unknown): boolean {
  return value === "verified" || value === "rejected" || value === "incomplete";
}

function isOutcomeStatus(value: unknown): value is BuildOutcome["status"] {
  return value === "accepted" || value === "rejected" || value === "incomplete";
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return value === "pass" || value === "fail" || value === "not_run" || value === "unknown";
}

function isTracePersistenceStatus(value: unknown): value is TracePersistence["status"] {
  return value === "written" || value === "failed" || value === "disabled";
}

function isProjectReference(value: unknown): boolean {
  return isRecord(value) && isString(value.id) && (value.snapshotRetention === "not_retained" || value.snapshotRetention === "external_reference" || value.snapshotRetention === "embedded_fixture") && optionalString(value.startingSnapshotHash) && optionalString(value.resultingSnapshotHash) && optionalString(value.sourceHash) && optionalString(value.structureHash) && optionalString(value.semanticHash) && optionalString(value.manifestHash);
}

function isTraceReferences(value: unknown): boolean {
  return isRecord(value) && optionalString(value.gameIntentId) && optionalString(value.coreLoopId) && optionalString(value.mechanicContractId) && optionalString(value.patchSetId) && optionalString(value.benchmarkCaseId) && optionalString(value.generationRunId) && optionalString(value.generationAttemptId) && optionalString(value.modelResponseHash) && optionalString(value.agentRunId) && optionalString(value.requirementSetId) && optionalString(value.requirementViewId) && optionalString(value.workspaceDeltaId) && optionalString(value.harnessConfigurationId) && optionalString(value.harnessConfigurationHash);
}

function isTraceComponents(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.toolchain) && value.toolchain.every(isComponentVersion) && Array.isArray(value.verifiers) && value.verifiers.every(isComponentVersion) && optionalComponent(value.agent) && optionalModel(value.model) && optionalComponent(value.repairPolicy) && optionalComponent(value.studio);
}

function isComponentVersion(value: unknown): value is ComponentVersion {
  return isRecord(value) && isString(value.name) && isString(value.version) && optionalString(value.configHash);
}

function optionalComponent(value: unknown): boolean {
  return value === undefined || isComponentVersion(value);
}

function optionalModel(value: unknown): boolean {
  return value === undefined || (isRecord(value) && isString(value.provider) && isString(value.name) && optionalString(value.version) && isString(value.configurationHash));
}

function isLatency(value: unknown): boolean {
  return isRecord(value) && typeof value.total === "number" && optionalNumber(value.projectSnapshot) && optionalNumber(value.luau) && optionalNumber(value.replication) && optionalNumber(value.studio);
}

function isIssueCounts(value: unknown): boolean {
  return isRecord(value) && typeof value.info === "number" && typeof value.warning === "number" && typeof value.error === "number" && typeof value.critical === "number";
}

function isTraceAttributes(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isTraceAttributeValue);
}

function isTraceAttributeValue(value: unknown): value is TraceAttributeValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isForgeSpanName(value: unknown): value is ForgeSpanName {
  return typeof value === "string" && FORGE_SPAN_NAMES.has(value as ForgeSpanName);
}

function isForgeEventName(value: unknown): value is ForgeEventName {
  return value === "forge.issue.detected" || value === "forge.build.completed";
}

function isTrajectoryEventName(value: unknown): value is TrajectoryEventName {
  return value === "intent_received" || value === "core_loop_resolved" || value === "contract_compiled" || value === "patch_proposed" || value === "verification_completed" || value === "repair_applied" || value === "studio_run_completed" || value === "creator_accepted" || value === "creator_rejected";
}

function isIssueSeverity(value: unknown): value is VerificationIssue["severity"] {
  return value === "info" || value === "warning" || value === "error" || value === "critical";
}

function isIssueCategory(value: unknown): value is VerificationIssue["category"] {
  return value === "language" || value === "runtime_boundary" || value === "replication" || value === "security" || value === "persistence" || value === "economy" || value === "structure" || value === "performance" || value === "tooling";
}

function optionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

const FORGE_SPAN_NAMES = new Set<ForgeSpanName>([
  "forge.project.snapshot", "forge.intent.compile", "forge.contract.validate", "forge.agent.execute", "forge.model.generate", "forge.tool.call", "forge.patch.create", "forge.patch.apply", "forge.verify.luau", "forge.verify.replication", "forge.verify.economy", "forge.verify.structure", "forge.repair.deterministic", "forge.repair.model", "forge.studio.connect", "forge.studio.snapshot", "forge.studio.transaction.begin", "forge.studio.patch.apply", "forge.studio.start", "forge.studio.playtest", "forge.studio.action", "forge.studio.assert", "forge.studio.adversarial", "forge.studio.playtest.stop", "forge.studio.transaction.commit", "forge.studio.transaction.rollback", "forge.commit.verified", "forge.commit.rejected"
]);
