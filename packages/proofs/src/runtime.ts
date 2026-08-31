import { contentHash, stableJson } from "../../contracts/src/index.js";

/** Content-addressed evidence for one exact authoritative runtime evaluation. */
export interface RuntimeProofBundle {
  kind: "RuntimeProofBundle";
  schemaVersion: 1;
  id: string;
  hash: string;
  status: "runtime_verified" | "rejected" | "incomplete";
  creatorPromptHash: string;
  requirementSetId: string;
  requirementViewId: string;
  evaluatorViewId: string;
  harnessConfigurationId: string;
  harnessConfigurationHash: string;
  agentRunId: string;
  workspaceCandidateArtifactId: string;
  workspaceCandidateArtifactHash: string;
  seedHash: string;
  candidateHash: string;
  workspaceDeltaId: string;
  localVerificationReportHash: string;
  localVerificationTraceId: string;
  runtimeEvalDefinitionId: string;
  runtimeEvalDefinitionHash: string;
  runtimeEvalPlanId: string;
  runtimeEvalPlanHash: string;
  studioCapabilitySetId: string;
  studioCapabilitySetHash: string;
  runtimeEvaluatorConfigurationId: string;
  runtimeEvaluatorConfigurationHash: string;
  runtimeEvaluationRunId: string;
  runtimeEvaluationRunHash: string;
  pluginVersion: string;
  studioVersion: string;
  assertionResults: Array<{ id: string; status: "pass" | "fail"; evidenceHash: string }>;
  /** Explicitly scoped: no universal-mechanic or quality claim is implied. */
  scope: "exact_runtime_definition_capability_set_configuration_authoritative_run";
}

export function createRuntimeProofBundle(input: Omit<RuntimeProofBundle, "kind" | "schemaVersion" | "id" | "hash">): RuntimeProofBundle {
  const canonicalPayload = canonical(input);
  const hash = contentHash(stableJson(canonicalPayload));
  const proof: RuntimeProofBundle = { kind: "RuntimeProofBundle", schemaVersion: 1, id: `runtime_proof_${hash.slice(0, 24)}`, hash, ...canonicalPayload };
  assertRuntimeProofBundle(proof);
  return proof;
}

export function assertRuntimeProofBundle(value: unknown): asserts value is RuntimeProofBundle {
  if (!isRecord(value) || value.kind !== "RuntimeProofBundle" || value.schemaVersion !== 1 || !isId(value.id) || !isHash(value.hash) || !["runtime_verified", "rejected", "incomplete"].includes(String(value.status)) || !isHash(value.creatorPromptHash) || !isId(value.requirementSetId) || !isId(value.requirementViewId) || !isId(value.evaluatorViewId) || !isId(value.harnessConfigurationId) || !isHash(value.harnessConfigurationHash) || !isId(value.agentRunId) || !isId(value.workspaceCandidateArtifactId) || !isHash(value.workspaceCandidateArtifactHash) || !isHash(value.seedHash) || !isHash(value.candidateHash) || !isId(value.workspaceDeltaId) || !isHash(value.localVerificationReportHash) || !isId(value.localVerificationTraceId) || !isId(value.runtimeEvalDefinitionId) || !isHash(value.runtimeEvalDefinitionHash) || !isId(value.runtimeEvalPlanId) || !isHash(value.runtimeEvalPlanHash) || !isId(value.studioCapabilitySetId) || !isHash(value.studioCapabilitySetHash) || !isId(value.runtimeEvaluatorConfigurationId) || !isHash(value.runtimeEvaluatorConfigurationHash) || !isId(value.runtimeEvaluationRunId) || !isHash(value.runtimeEvaluationRunHash) || !isString(value.pluginVersion) || !isString(value.studioVersion) || !Array.isArray(value.assertionResults) || value.scope !== "exact_runtime_definition_capability_set_configuration_authoritative_run") throw new Error("Invalid RuntimeProofBundle");
  const assertions = value.assertionResults as unknown[];
  if ((value.status !== "incomplete" && assertions.length === 0) || !assertions.every((assertion) => isRecord(assertion) && isId(assertion.id) && (assertion.status === "pass" || assertion.status === "fail") && isHash(assertion.evidenceHash)) || !isCanonical(assertions.map((assertion) => (assertion as { id: string }).id))) throw new Error("Invalid RuntimeProofBundle assertion results");
  const { kind: _kind, schemaVersion: _schema, id: _id, hash: _hash, ...payload } = value;
  const expected = contentHash(stableJson(canonical(payload as Omit<RuntimeProofBundle, "kind" | "schemaVersion" | "id" | "hash">)));
  if (value.hash !== expected || value.id !== `runtime_proof_${expected.slice(0, 24)}`) throw new Error("Invalid RuntimeProofBundle identity");
}

function canonical(input: Omit<RuntimeProofBundle, "kind" | "schemaVersion" | "id" | "hash">): Omit<RuntimeProofBundle, "kind" | "schemaVersion" | "id" | "hash"> {
  return { ...input, assertionResults: [...input.assertionResults].map((result) => ({ ...result })).sort((left, right) => left.id.localeCompare(right.id)) };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isId(value: unknown): value is string { return isString(value) && value.length > 0 && !/\s/.test(value); }
function isHash(value: unknown): value is string { return isString(value) && /^[0-9a-f]{64}$/.test(value); }
function isCanonical(ids: string[]): boolean { return new Set(ids).size === ids.length && ids.every((id, index) => index === 0 || ids[index - 1]!.localeCompare(id) < 0); }
