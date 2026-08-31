import { createHash } from "node:crypto";

export type ID = string;
export type ISO8601 = string;
export type RelativePath = string;
export type Hash = string;
export type VerificationStatus = "pass" | "fail" | "not_run" | "unknown";
export type RemoteValidationCategory = "type" | "value" | "context" | "permission" | "rate_limit" | "ownership";
export type ValidationApplicability = "required" | "not_applicable";

export interface RemoteFlowDeclaration {
  name: string;
  direction: "client_to_server" | "server_to_client";
  remote: { stableId: ID; path: string; className: "RemoteEvent" | "RemoteFunction"; preserveExisting: boolean };
  clientScript: RelativePath;
  serverScript: RelativePath;
  clientInputs: Array<{ position: number; role: string; type: string; trust: "untrusted" | "informational" }>;
  serverArguments: Array<{ position: number; role: string; type: string; source: "roblox_server" | "client" }>;
  validationRequirements: Array<{ category: RemoteValidationCategory; subjectRole: string; applicability: ValidationApplicability; rationale: string }>;
  stateMutations: Array<{ field: string; sourceExpression: string; authority: "client" | "server" | "shared" | "external"; operation: string }>;
}

export interface ForgeFixtureManifest {
  kind: "ForgeFixture";
    name: string;
  luauRoots: RelativePath[];
  remoteFlows: RemoteFlowDeclaration[];
  instances?: Array<{
    path: string;
    className: string;
    parentPath?: string;
    position?: { x: number; y: number; z: number };
    properties?: Record<string, string | number | boolean>;
    attributes?: Record<string, string | number | boolean>;
    tags?: string[];
  }>;
}

export interface VerificationIssue {
  kind: "VerificationIssue";
    id: ID;
  ruleId: string;
  severity: "info" | "warning" | "error" | "critical";
  category: "language" | "tooling" | "replication" | "security" | "structure";
  message: string;
  path?: RelativePath;
  location?: { line: number; column: number; endLine?: number; endColumn?: number };
  evidence: Array<{ type: string; statement: string; data?: Record<string, string | number | boolean> }>;
  remediation?: { kind: "deterministic" | "model" | "creator"; steps: string[] };
  authoritativeTier: "schema" | "static" | "preflight" | "studio" | "evaluator";
}

export interface VerificationReport {
  kind: "VerificationReport";
  projectPath: RelativePath;
  projectHash: Hash;
  toolchain: Array<{ name: string; command: string; configHash: Hash }>;
  issues: VerificationIssue[];
  checks: Array<{ name: string; status: VerificationStatus; issueIds: ID[] }>;
  gate: { status: "eligible" | "rejected" | "incomplete"; reasons: string[] };
  reproducibility: { inputHash: Hash; dependencyHash: Hash; ruleSetHash: Hash; deterministic: boolean };
}

export type TraceAttributeValue = string | number | boolean | string[];
export type ForgeSpanName =
  | "forge.project.snapshot"
  | "forge.agent.execute"
  | "forge.model.generate"
  | "forge.tool.call"
  | "forge.verify.luau"
  | "forge.verify.replication"
  | "forge.studio.assert";
export type ForgeEventName = "forge.issue.detected" | "forge.build.completed";

export interface ComponentDescriptor { name: string; configHash?: Hash }
export interface ModelConfiguration { provider: string; name: string; configurationHash: Hash }
export interface BuildTraceSpan { id: ID; sequence: number; name: ForgeSpanName; startedAt: ISO8601; endedAt: ISO8601; durationMs: number; status: "ok" | "error"; attributes: Record<string, TraceAttributeValue> }
export interface BuildTraceEvent { id: ID; sequence: number; name: ForgeEventName; occurredAt: ISO8601; attributes: Record<string, TraceAttributeValue> }

export interface BuildOutcome {
  status: "locally_eligible" | "runtime_verified" | "creator_accepted" | "creator_rejected" | "recovery_required" | "rejected" | "incomplete";
  localGate: "eligible" | "rejected" | "incomplete";
  runtimeGate: "not_run" | "runtime_verified" | "rejected" | "incomplete";
  assertions: { total: number; passed: number };
  modelUsage: { calls: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  latencyMs: { total: number; projectSnapshot?: number; luau?: number; replication?: number; studio?: number };
  issueCounts: Record<"info" | "warning" | "error" | "critical", number>;
}

export interface BuildTrace {
  kind: "BuildTrace";
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
    snapshotRetention: "not_retained";
  };
  references: {
    agentRunId?: ID;
    creatorSessionId?: ID;
    creatorSessionHash?: Hash;
    creatorBuildContractId?: ID;
    creatorBuildContractHash?: Hash;
    experimentRegistrationId?: ID;
    experimentRegistrationHash?: Hash;
    requirementSetId?: ID;
    requirementViewId?: ID;
    workspaceDeltaId?: ID;
    harnessConfigurationId?: ID;
    harnessConfigurationHash?: Hash;
    workspaceCandidateArtifactId?: ID;
    workspaceCandidateArtifactHash?: Hash;
    runtimeEvalPlanId?: ID;
    runtimeEvalPlanHash?: Hash;
    studioCapabilitySetId?: ID;
    studioCapabilitySetHash?: Hash;
    runtimeEvaluatorConfigurationId?: ID;
    runtimeEvaluatorConfigurationHash?: Hash;
    runtimeEvaluationRunId?: ID;
    runtimeProofId?: ID;
  };
  components: { toolchain: ComponentDescriptor[]; verifiers: ComponentDescriptor[]; agent?: ComponentDescriptor; model?: ModelConfiguration; studio?: ComponentDescriptor };
  spans: BuildTraceSpan[];
  events: BuildTraceEvent[];
  outcome: BuildOutcome;
  evidence: { verificationReportHash?: Hash; runtimeProofId?: ID; issues: Array<{ id: ID; ruleId: string; severity: VerificationIssue["severity"]; category: VerificationIssue["category"]; evidenceHash: Hash }> };
  replayability: { level: "none" | "semantic_reproduction"; reasons: string[]; randomSeeds: Record<string, number> };
  privacy: { rawSourceStored: false; rawPromptStored: false; creatorIdentityStored: false };
}

export interface TracePersistence {
  kind: "TracePersistence";
    traceId: ID;
  buildKey: ID;
  status: "written" | "failed";
  artifactHash?: Hash;
  locator?: RelativePath;
  error?: string;
}

export function contentHash(value: string): Hash { return createHash("sha256").update(value).digest("hex"); }
export function stableJson(value: unknown): string { return JSON.stringify(normalizeJson(value)); }

export function assertFixtureManifest(value: unknown): asserts value is ForgeFixtureManifest {
  if (!isRecord(value) || value.kind !== "ForgeFixture" || !isNonEmpty(value.name) || !Array.isArray(value.luauRoots) || !value.luauRoots.every(isSafeRelative) || !Array.isArray(value.remoteFlows)) throw new Error("Invalid ForgeFixture manifest");
  if (value.instances !== undefined && (!Array.isArray(value.instances) || !value.instances.every((entry) => isRecord(entry) && isNonEmpty(entry.path) && isNonEmpty(entry.className) && (entry.position === undefined || isVector3(entry.position))))) throw new Error("Invalid ForgeFixture instances");
  for (const flow of value.remoteFlows) assertRemoteFlow(flow);
}

export function assertBuildTrace(value: unknown): asserts value is BuildTrace {
  if (!isRecord(value) || value.kind !== "BuildTrace" || !isNonEmpty(value.id) || !isNonEmpty(value.buildKey) || !isNonEmpty(value.startedAt) || !isNonEmpty(value.endedAt) || !isRecord(value.project) || !isRecord(value.references) || !isRecord(value.components) || !Array.isArray(value.spans) || !Array.isArray(value.events) || !isRecord(value.outcome) || !isRecord(value.evidence) || !isRecord(value.replayability) || !isRecord(value.privacy)) throw new Error("Invalid BuildTrace");
  if (!["locally_eligible", "runtime_verified", "creator_accepted", "creator_rejected", "recovery_required", "rejected", "incomplete"].includes(String(value.outcome.status))) throw new Error("Invalid BuildTrace outcome");
}

function assertRemoteFlow(value: unknown): asserts value is RemoteFlowDeclaration {
  if (!isRecord(value) || !isNonEmpty(value.name) || !["client_to_server", "server_to_client"].includes(String(value.direction)) || !isRecord(value.remote) || !isNonEmpty(value.remote.stableId) || !isNonEmpty(value.remote.path) || !["RemoteEvent", "RemoteFunction"].includes(String(value.remote.className)) || typeof value.remote.preserveExisting !== "boolean" || !isSafeRelative(value.clientScript) || !isSafeRelative(value.serverScript) || !Array.isArray(value.clientInputs) || !Array.isArray(value.serverArguments) || !Array.isArray(value.validationRequirements) || !Array.isArray(value.stateMutations)) throw new Error("Invalid remote flow declaration");
  const positions = value.clientInputs.map((input) => isRecord(input) ? input.position : -1);
  if (!positions.every((position) => Number.isInteger(position) && Number(position) > 0) || new Set(positions).size !== positions.length) throw new Error("Remote client inputs require unique positive positions");
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, normalizeJson(value[key])]));
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isSafeRelative(value: unknown): value is string { return isNonEmpty(value) && !value.startsWith("/") && !value.startsWith("\\") && !value.includes("\0") && !value.split(/[\\/]+/).includes(".."); }
function isVector3(value: unknown): boolean { return isRecord(value) && [value.x, value.y, value.z].every((part) => typeof part === "number" && Number.isFinite(part)); }
