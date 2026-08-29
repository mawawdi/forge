import { createHash } from "node:crypto";

export type ID = string;
export type ISO8601 = string;
export type RelativePath = string;
export type Hash = string;

export type Risk = "low" | "medium" | "high" | "critical";
export type Authority = "client" | "server" | "shared" | "external";
export type VerificationStatus = "pass" | "fail" | "not_run" | "unknown";

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
  schemaVersion: 1;
  id: ID;
  coreLoopId: ID;
  name: string;
  playerGoal: string;
  preconditions: Array<{ id: ID; statement: string; authority: Authority }>;
  postconditions: Array<{ id: ID; statement: string; authority: Authority }>;
  authorityModel: {
    stateOwner: Authority;
    clientInputs: Array<{ name: string; type: string; trust: "untrusted" | "informational" }>;
    serverValidations: Array<"type" | "value" | "context" | "permission" | "rate_limit" | "ownership">;
    stateMutations: Array<{ field: string; authority: Authority; operation: string }>;
  };
  persistentState: Array<{ field: string; type: string; owner: "server"; durability: "session" | "persistent" }>;
  uiOutputs: Array<{ binding: string; sourceField: string; direction: "server_to_client" | "local" }>;
  economyEffects: Array<{ currency: string; delta: string; computedBy: "server" | "none" }>;
  instrumentation: Array<{ event: string; fields: string[]; privacyClass: "none" | "project" | "creator_sensitive" }>;
  studioAssertions: ID[];
  risk: Risk;
}

export interface PatchSet {
  kind: "PatchSet";
  schemaVersion: 1;
  id: ID;
  projectHash: Hash;
  mechanicContractId: ID;
  operations: Array<
    | { type: "create_script"; path: RelativePath; source: string; executionContext: "server" | "client" | "shared" }
    | { type: "replace_function"; path: RelativePath; symbol: string; beforeHash: Hash; source: string }
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

export interface ProofBundle {
  kind: "ProofBundle";
  schemaVersion: 1;
  id: ID;
  projectHash: Hash;
  patchSetId?: ID;
  generatedAt: ISO8601;
  toolchain: Array<{ name: string; version: string; command: string; configHash: Hash }>;
  checks: Array<{ name: string; tier: "static" | "preflight" | "studio"; status: VerificationStatus; issueIds: ID[]; resultHash?: Hash }>;
  issues: VerificationIssue[];
  assertions: Array<{ assertionId: ID; status: VerificationStatus; observed?: Record<string, string | number | boolean>; runId?: ID }>;
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
  | "forge.studio.start"
  | "forge.studio.playtest"
  | "forge.studio.assert"
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
  modelUsage: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
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
    manifestHash?: Hash;
    snapshotRetention: "not_retained" | "external_reference" | "embedded_fixture";
  };
  references: {
    gameIntentId?: ID;
    coreLoopId?: ID;
    mechanicContractId?: ID;
    patchSetId?: ID;
    benchmarkCaseId?: ID;
  };
  components: {
    toolchain: ComponentVersion[];
    verifiers: ComponentVersion[];
    agent?: ComponentVersion;
    model?: ModelConfiguration;
    repairPolicy?: ComponentVersion;
  };
  spans: BuildTraceSpan[];
  events: BuildTraceEvent[];
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
  clientScript: RelativePath;
  serverScript: RelativePath;
  clientInput: { name: string; type: string };
  serverValidations: Array<"type" | "value" | "context" | "permission" | "rate_limit" | "ownership">;
  mutation: { field: string; sourceExpression: string; authority: Authority };
}

export interface ForgeFixtureManifest {
  kind: "ForgeFixture";
  schemaVersion: 1;
  name: string;
  luauRoots: RelativePath[];
  remoteFlows: RemoteFlowDeclaration[];
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
  if (!isTraceReferences(value.references) || !isTraceComponents(value.components) || !Array.isArray(value.spans) || !Array.isArray(value.events)) {
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
  if (!isRecord(value) || value.kind !== "ForgeFixture" || value.schemaVersion !== 1 || typeof value.name !== "string") {
    throw new Error("Invalid ForgeFixture manifest: expected schemaVersion 1");
  }
  if (!Array.isArray(value.luauRoots) || !value.luauRoots.every((entry) => typeof entry === "string")) {
    throw new Error("Invalid ForgeFixture manifest: luauRoots must be string[]");
  }
  if (!Array.isArray(value.remoteFlows)) {
    throw new Error("Invalid ForgeFixture manifest: remoteFlows must be an array");
  }
  for (const flow of value.remoteFlows) assertRemoteFlow(flow);
}

function assertRemoteFlow(value: unknown): asserts value is RemoteFlowDeclaration {
  if (!isRecord(value) || typeof value.name !== "string" || (value.direction !== "client_to_server" && value.direction !== "server_to_client")) {
    throw new Error("Invalid ForgeFixture remote flow");
  }
  if (typeof value.clientScript !== "string" || typeof value.serverScript !== "string") throw new Error("Invalid ForgeFixture remote flow paths");
  if (!isRecord(value.clientInput) || typeof value.clientInput.name !== "string" || typeof value.clientInput.type !== "string") throw new Error("Invalid ForgeFixture client input");
  if (!Array.isArray(value.serverValidations) || !value.serverValidations.every((entry) => typeof entry === "string")) throw new Error("Invalid ForgeFixture validations");
  if (!isRecord(value.mutation) || typeof value.mutation.field !== "string" || typeof value.mutation.sourceExpression !== "string" || typeof value.mutation.authority !== "string") throw new Error("Invalid ForgeFixture mutation");
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
  return isRecord(value) && isOutcomeStatus(value.status) && typeof value.verified === "boolean" && typeof value.staticPass === "boolean" && typeof value.semanticPass === "boolean" && isVerificationStatus(value.studioPass) && typeof value.attempts === "number" && typeof value.deterministicRepairs === "number" && typeof value.modelRepairs === "number" && isRecord(value.assertions) && typeof value.assertions.total === "number" && typeof value.assertions.passed === "number" && isRecord(value.modelUsage) && typeof value.modelUsage.calls === "number" && typeof value.modelUsage.inputTokens === "number" && typeof value.modelUsage.outputTokens === "number" && typeof value.modelUsage.costUsd === "number" && isLatency(value.latencyMs) && isIssueCounts(value.issueCounts);
}

function isTraceEvidence(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.issues) && value.issues.every((issue) => isRecord(issue) && isString(issue.id) && isString(issue.ruleId) && isIssueSeverity(issue.severity) && isIssueCategory(issue.category) && isString(issue.evidenceHash));
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
  return isRecord(value) && isString(value.id) && (value.snapshotRetention === "not_retained" || value.snapshotRetention === "external_reference" || value.snapshotRetention === "embedded_fixture") && optionalString(value.startingSnapshotHash) && optionalString(value.resultingSnapshotHash) && optionalString(value.manifestHash);
}

function isTraceReferences(value: unknown): boolean {
  return isRecord(value) && optionalString(value.gameIntentId) && optionalString(value.coreLoopId) && optionalString(value.mechanicContractId) && optionalString(value.patchSetId) && optionalString(value.benchmarkCaseId);
}

function isTraceComponents(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.toolchain) && value.toolchain.every(isComponentVersion) && Array.isArray(value.verifiers) && value.verifiers.every(isComponentVersion) && optionalComponent(value.agent) && optionalModel(value.model) && optionalComponent(value.repairPolicy);
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
  "forge.project.snapshot", "forge.intent.compile", "forge.contract.validate", "forge.agent.execute", "forge.model.generate", "forge.tool.call", "forge.patch.create", "forge.patch.apply", "forge.verify.luau", "forge.verify.replication", "forge.verify.economy", "forge.verify.structure", "forge.repair.deterministic", "forge.repair.model", "forge.studio.start", "forge.studio.playtest", "forge.studio.assert", "forge.commit.verified", "forge.commit.rejected"
]);
