import { createHash } from "node:crypto";
import { assertProofBundle, assertStudioAssertion, contentHash, stableJson, type Hash, type MechanicContract, type ProofBundle, type StudioAssertion, type VerificationStatus } from "../../contracts/src/index.js";
import { assertProjectSnapshot, type ProjectSnapshot } from "../../semantic-map/src/index.js";
import { assertPluginToBackendMessage, type PluginProjectIdentity, type PluginToBackendMessage, type StudioHarnessRunEnvelope } from "../../studio-protocol/src/index.js";

export interface StudioTestPlan {
  kind: "StudioTestPlan";
  schemaVersion: 2;
  id: string;
  mechanicContractId: string;
  mechanicContractHash: Hash;
  projectSnapshotHash: Hash;
  setup: Array<{ action: string; actor: "server" | "client_1" | "client_2" | "system"; args?: Record<string, string | number | boolean> }>;
  actors: Array<{ id: "server" | "client_1" | "client_2" | "system"; role: "authority" | "requester" | "adversary" | "observer" }>;
  actions: Array<{ action: string; actor: "server" | "client_1" | "client_2" | "system"; args?: Record<string, string | number | boolean> }>;
  assertions: StudioAssertion[];
  adversarialCases: Array<{ id: string; assertionIds: string[]; description: string }>;
  cleanup: Array<{ action: string; actor: "server" | "client_1" | "client_2" | "system"; args?: Record<string, string | number | boolean> }>;
  version: string;
}

export interface StudioAssertionResult {
  kind: "StudioAssertionResult";
  schemaVersion: 2;
  id: string;
  runId: string;
  testPlanId: string;
  assertionId: string;
  status: VerificationStatus;
  expected: string | number | boolean;
  observed: string | number | boolean;
  evidence: Array<{ type: "state" | "remote" | "log" | "error" | "instance"; statement: string; data?: Record<string, string | number | boolean> }>;
  authoritative: boolean;
  durationMs: number;
  emittedAt: string;
}

export interface StudioProofRun {
  kind: "StudioProofRun";
  schemaVersion: 5;
  runId: string;
  testPlan: StudioTestPlan;
  projectSnapshot: ProjectSnapshot;
  pluginVersion: string;
  studioVersion: string;
  transactionId?: string;
  correlationId: string;
  sessionId: string;
  projectId: string;
  projectSnapshotHash: Hash;
  mechanicContractHash: Hash;
  harnessId: string;
  harnessVersion: string;
  harnessHash: Hash;
  nonceHash: Hash;
  assertionResults: StudioAssertionResult[];
  status: "pass" | "fail" | "incomplete";
  authoritative: boolean;
}

export interface StudioProofCaptureOptions {
  runId: string;
  testPlan: StudioTestPlan;
  projectSnapshot: ProjectSnapshot;
  pluginVersion: string;
  studioVersion: string;
  transactionId?: string;
  authoritativeSession: boolean;
  correlationId: string;
  sessionId: string;
  projectId: string;
  project: PluginProjectIdentity;
  projectSnapshotHash: Hash;
  mechanicContractHash: Hash;
  nonceCommitment: string;
  harnessId: string;
  harnessVersion: string;
  harnessHash: Hash;
}

export class StudioProofCapture {
  private readonly results = new Map<string, StudioAssertionResult>();
  private playtestStarted = false;
  private playtestStopped = false;
  private resultEnvelopeAccepted = false;
  private envelope: StudioHarnessRunEnvelope | undefined;
  private armedNonceCommitment: string | undefined;

  constructor(private readonly options: StudioProofCaptureOptions) {}

  get runId(): string { return this.options.runId; }

  accept(message: PluginToBackendMessage): void {
    assertPluginToBackendMessage(message);
    if (message.type === "AssertionPlanAccepted") {
      if (message.payload.runId !== this.options.runId || message.payload.testPlanId !== this.options.testPlan.id || message.payload.correlationId !== this.options.correlationId || message.payload.sessionId !== this.options.sessionId || message.payload.projectId !== this.options.projectId || message.payload.projectSnapshotHash !== this.options.projectSnapshotHash || message.payload.mechanicContractHash !== this.options.mechanicContractHash || message.payload.harnessId !== this.options.harnessId || message.payload.harnessVersion !== this.options.harnessVersion || message.payload.nonceCommitment !== this.options.nonceCommitment) throw new Error("Studio assertion plan does not match the active run binding");
      if (this.armedNonceCommitment) throw new Error("Duplicate Studio assertion plan acceptance");
      this.armedNonceCommitment = message.payload.nonceCommitment;
      return;
    }
    if (message.type === "StudioTestResult") {
      if (!this.playtestStarted || this.playtestStopped) throw new Error("Studio test result arrived outside the active playtest");
      const envelope = message.payload;
      if (this.envelope) throw new Error("Duplicate Studio test result envelope");
      if (!this.armedNonceCommitment || envelope.runId !== this.options.runId || envelope.testPlanId !== this.options.testPlan.id || envelope.correlationId !== this.options.correlationId || envelope.sessionId !== this.options.sessionId || envelope.projectId !== this.options.projectId || envelope.projectSnapshotHash !== this.options.projectSnapshotHash || envelope.mechanicContractHash !== this.options.mechanicContractHash || envelope.nonceCommitment !== this.armedNonceCommitment || sha256(envelope.nonce) !== this.armedNonceCommitment || envelope.harnessId !== this.options.harnessId || envelope.harnessVersion !== this.options.harnessVersion || envelope.harnessHash !== this.options.harnessHash) throw new Error("Studio test result does not match the active run binding");
      const expectedIds = new Set(this.options.testPlan.assertions.map((assertion) => assertion.id));
      if (envelope.assertions.length !== expectedIds.size || new Set(envelope.assertions.map((result) => result.assertionId)).size !== envelope.assertions.length || envelope.assertions.some((result) => !expectedIds.has(result.assertionId))) throw new Error("Studio test result does not contain exactly the planned assertions");
      for (const result of envelope.assertions) {
        if (result.projectId !== this.options.projectId || result.sessionId !== this.options.sessionId || result.project.name !== this.options.project.name || result.project.placeId !== this.options.project.placeId || result.project.universeId !== this.options.project.universeId || result.runId !== this.options.runId || result.testPlanId !== this.options.testPlan.id || result.correlationId !== this.options.correlationId || result.projectSnapshotHash !== this.options.projectSnapshotHash || result.mechanicContractHash !== this.options.mechanicContractHash || result.nonceCommitment !== this.armedNonceCommitment || result.nonce !== envelope.nonce) throw new Error("Studio assertion evidence does not match the active run binding");
        this.results.set(result.id, { kind: "StudioAssertionResult", schemaVersion: 2, id: result.id, runId: result.runId, testPlanId: result.testPlanId, assertionId: result.assertionId, status: result.status, expected: result.expected, observed: result.observed, evidence: result.evidence, authoritative: result.authoritative, durationMs: result.durationMs, emittedAt: result.emittedAt });
      }
      this.envelope = envelope;
      this.resultEnvelopeAccepted = true;
      return;
    }
    if (message.type === "PlaytestStarted" || message.type === "PlaytestStopped") {
      if (!this.armedNonceCommitment || message.payload.runId !== this.options.runId || message.payload.testPlanId !== this.options.testPlan.id || message.payload.correlationId !== this.options.correlationId || message.payload.sessionId !== this.options.sessionId || message.payload.project.name !== this.options.project.name || message.payload.project.placeId !== this.options.project.placeId || message.payload.project.universeId !== this.options.project.universeId || message.payload.projectSnapshotHash !== this.options.projectSnapshotHash || message.payload.mechanicContractHash !== this.options.mechanicContractHash || message.payload.nonceCommitment !== this.armedNonceCommitment) throw new Error("Studio playtest lifecycle does not match the active run binding");
      if (message.type === "PlaytestStarted") {
        if (this.playtestStarted) throw new Error("Duplicate Studio playtest start");
        this.playtestStarted = true;
      } else {
        if (!this.playtestStarted) throw new Error("Studio playtest stopped before it started");
        if (this.playtestStopped) throw new Error("Duplicate Studio playtest stop");
        this.playtestStopped = true;
      }
    }
  }

  complete(): StudioProofRun {
    const expectedIds = new Set(this.options.testPlan.assertions.map((assertion) => assertion.id));
    const results = [...this.results.values()].filter((result) => expectedIds.has(result.assertionId));
    const complete = results.length === expectedIds.size && expectedIds.size > 0;
    const authoritative = this.options.authoritativeSession && this.playtestStarted && this.playtestStopped && this.resultEnvelopeAccepted && this.envelope?.authoritative === true;
    const status: StudioProofRun["status"] = !complete || !authoritative || this.envelope?.status !== "completed" ? "incomplete" : results.every((result) => result.status === "pass") ? "pass" : "fail";
    return { kind: "StudioProofRun", schemaVersion: 5, runId: this.options.runId, testPlan: this.options.testPlan, projectSnapshot: this.options.projectSnapshot, pluginVersion: this.options.pluginVersion, studioVersion: this.options.studioVersion, ...(this.options.transactionId ? { transactionId: this.options.transactionId } : {}), correlationId: this.options.correlationId, sessionId: this.options.sessionId, projectId: this.options.projectId, projectSnapshotHash: this.options.projectSnapshotHash, mechanicContractHash: this.options.mechanicContractHash, harnessId: this.options.harnessId, harnessVersion: this.options.harnessVersion, harnessHash: this.options.harnessHash, nonceHash: this.options.nonceCommitment, assertionResults: results.map((result) => ({ ...result, authoritative: authoritative && result.authoritative })), status, authoritative };
  }
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function collectFruitTestPlan(contract: MechanicContract, snapshot: ProjectSnapshot): StudioTestPlan {
  const version = "collect-fruit-v7";
  const assertion = (id: string, name: string, action: string, relation: StudioAssertion["observations"][number]["relation"], expected: string | number | boolean, tags: string[]): StudioAssertion => ({
    kind: "StudioAssertion", schemaVersion: 1, id, mechanicContractId: contract.id, name,
    setup: [], actions: [{ action, actor: "client_1" }], observations: [{ path: "runtime", relation, expected }], timeoutMs: 5000, tags
  });
  const assertions = [
    assertion("assert_collect_fruit_success", "Valid collection succeeds", "collect Fruit42", "equals", true, ["happy_path"]),
    assertion("assert_inventory_increases_once", "Inventory transitions 0 to 1", "observe Inventory", "increases_by", 1, ["state"]),
    assertion("assert_fruit_consumed", "Collected fruit becomes unavailable", "observe Fruit42", "not_equals", true, ["state"]),
    assertion("assert_duplicate_collection_rejected", "Duplicate collection does not reward twice", "collect Fruit42", "rejected", true, ["adversarial", "duplicate"]),
    assertion("assert_spoofed_id_rejected", "Spoofed fruit ID is rejected", "collect DoesNotExist", "rejected", true, ["adversarial", "identity"]),
    assertion("assert_impossible_distance_rejected", "Impossible-distance request is rejected", "collect Fruit42 from impossible distance", "rejected", true, ["adversarial", "distance"]),
    assertion("assert_server_authority", "Server remains authoritative over reward", "collect Fruit42 with amount 999999", "rejected", true, ["adversarial", "authority"])
  ];
  return {
    kind: "StudioTestPlan", schemaVersion: 2, id: `studio_plan_${contentHash(stableJson({ version, contractId: contract.id, contractHash: contentHash(stableJson(contract)), snapshotHash: snapshot.projectSemanticHash, assertionIds: assertions.map((item) => item.id) })).slice(0, 24)}`,
    mechanicContractId: contract.id, mechanicContractHash: contentHash(stableJson(contract)), projectSnapshotHash: snapshot.projectSemanticHash,
    setup: [{ action: "reset isolated test state", actor: "system" }],
    actors: [{ id: "server", role: "authority" }, { id: "client_1", role: "requester" }, { id: "system", role: "observer" }],
    actions: [], assertions,
    adversarialCases: assertions.filter((item) => item.tags.includes("adversarial")).map((item) => ({ id: item.id, assertionIds: [item.id], description: item.name })),
    cleanup: [{ action: "end Studio Play Solo test and destroy temporary harness", actor: "system" }], version
  };
}

export function assertStudioTestPlan(value: unknown): asserts value is StudioTestPlan {
  if (!isRecord(value) || value.kind !== "StudioTestPlan" || value.schemaVersion !== 2 || !isString(value.id) || !isString(value.mechanicContractId) || !isString(value.mechanicContractHash) || !isString(value.projectSnapshotHash) || !Array.isArray(value.setup) || !Array.isArray(value.actors) || !Array.isArray(value.actions) || !Array.isArray(value.assertions) || !Array.isArray(value.adversarialCases) || !Array.isArray(value.cleanup) || !isString(value.version)) throw new Error("Invalid StudioTestPlan: expected schemaVersion 2");
  for (const assertion of value.assertions) assertStudioAssertion(assertion);
  const ids = value.assertions.map((assertion) => assertion.id);
  if (new Set(ids).size !== ids.length || value.assertions.some((assertion) => assertion.mechanicContractId !== value.mechanicContractId)) throw new Error("Invalid StudioTestPlan: assertion contract or IDs do not match the plan");
}

export function assertStudioProofRun(value: unknown): asserts value is StudioProofRun {
  if (!isRecord(value) || value.kind !== "StudioProofRun" || value.schemaVersion !== 5 || !isString(value.runId) || !isRecord(value.testPlan) || !isRecord(value.projectSnapshot) || !Array.isArray(value.assertionResults) || !isString(value.pluginVersion) || !isString(value.studioVersion) || !isString(value.correlationId) || !isString(value.sessionId) || !isString(value.projectId) || !isString(value.projectSnapshotHash) || !isString(value.mechanicContractHash) || !isString(value.harnessId) || !isString(value.harnessVersion) || !isString(value.harnessHash) || !isString(value.nonceHash) || !["pass", "fail", "incomplete"].includes(String(value.status)) || typeof value.authoritative !== "boolean") throw new Error("Invalid StudioProofRun: expected schemaVersion 5");
  assertStudioTestPlan(value.testPlan);
  assertProjectSnapshot(value.projectSnapshot);
  if (value.testPlan.mechanicContractHash !== value.mechanicContractHash || value.testPlan.projectSnapshotHash !== value.projectSnapshotHash || value.projectSnapshot.projectSemanticHash !== value.projectSnapshotHash) throw new Error("Invalid StudioProofRun: contract or snapshot binding does not match the run");
  const assertionIds = new Set(value.testPlan.assertions.map((assertion) => assertion.id));
  const resultIds = new Set<string>();
  const resultAssertionIds = new Set<string>();
  for (const result of value.assertionResults) {
    if (!isRecord(result) || result.kind !== "StudioAssertionResult" || result.schemaVersion !== 2 || !isString(result.id) || !isString(result.runId) || result.runId !== value.runId || !isString(result.testPlanId) || result.testPlanId !== value.testPlan.id || !isString(result.assertionId) || !assertionIds.has(result.assertionId) || resultIds.has(result.id) || resultAssertionIds.has(result.assertionId) || !isVerificationStatus(result.status) || !isPrimitive(result.expected) || !isPrimitive(result.observed) || !Array.isArray(result.evidence) || typeof result.authoritative !== "boolean" || typeof result.durationMs !== "number" || result.durationMs < 0 || !isString(result.emittedAt)) throw new Error("Invalid StudioAssertionResult: result is not correlated to its run and test plan");
    resultIds.add(result.id);
    resultAssertionIds.add(result.assertionId);
  }
  if (value.status === "pass" && (!value.authoritative || resultAssertionIds.size !== assertionIds.size || [...resultAssertionIds].some((id) => !assertionIds.has(id)) || value.assertionResults.some((result) => result.status !== "pass" || !result.authoritative))) throw new Error("Invalid StudioProofRun: pass requires every authoritative assertion");
  if (value.authoritative && resultAssertionIds.size !== assertionIds.size) throw new Error("Invalid StudioProofRun: authoritative runs require every planned assertion");
}

export function attachStudioProof(bundle: ProofBundle, run: StudioProofRun): ProofBundle {
  assertProofBundle(bundle);
  assertStudioProofRun(run);
  if (run.testPlan.mechanicContractId !== bundle.mechanicContractId || run.mechanicContractHash !== bundle.mechanicContractHash || run.testPlan.mechanicContractHash !== bundle.mechanicContractHash || run.projectSnapshotHash !== bundle.projectSnapshotAfterHash) throw new Error("StudioProof contract or snapshot does not match the ProofBundle");
  if (!run.authoritative && run.status !== "incomplete") throw new Error("StudioProofRun with pass/fail status must be authoritative");
  const expectedAssertions = run.testPlan.assertions.map((assertion) => {
    const result = run.assertionResults.find((candidate) => candidate.assertionId === assertion.id);
    return result ? { assertionId: result.assertionId, status: result.status, observed: { observed: result.observed }, runId: result.runId } : { assertionId: assertion.id, status: "not_run" as const };
  });
  const expectedAssertionIds = new Set(run.testPlan.assertions.map((assertion) => assertion.id));
  const observedAssertionIds = new Set(run.assertionResults.map((result) => result.assertionId));
  const allPassed = run.status === "pass" && run.authoritative && expectedAssertionIds.size > 0 && observedAssertionIds.size === expectedAssertionIds.size && [...expectedAssertionIds].every((id) => observedAssertionIds.has(id)) && run.assertionResults.every((result) => result.status === "pass" && result.authoritative);
  const staticPassed = bundle.checks.filter((check) => check.tier === "static").every((check) => check.status === "pass");
  const updated: ProofBundle = {
    ...bundle,
    assertions: expectedAssertions,
    studioProof: { testPlanId: run.testPlan.id, testPlanVersion: run.testPlan.version, runId: run.runId, proofRunHash: contentHash(stableJson(run)), correlationId: run.correlationId, sessionId: run.sessionId, projectId: run.projectId, mechanicContractHash: run.mechanicContractHash, harnessId: run.harnessId, harnessVersion: run.harnessVersion, harnessHash: run.harnessHash, projectSnapshotHash: run.projectSnapshotHash, pluginVersion: run.pluginVersion, studioVersion: run.studioVersion, assertionResultIds: run.assertionResults.map((result) => result.id), status: run.status, authoritative: run.authoritative },
    checks: [...bundle.checks.filter((check) => check.name !== "roblox_studio"), { name: "roblox_studio", tier: "studio", status: allPassed ? "pass" : run.status === "fail" ? "fail" : "unknown", issueIds: [], resultHash: contentHash(stableJson(run)) }],
    gate: { status: staticPassed && allPassed ? "verified" : run.status === "fail" ? "rejected" : "incomplete", reasons: staticPassed && allPassed ? ["Static, semantic, and authoritative Studio assertions passed."] : run.status === "fail" ? ["One or more authoritative Studio assertions failed."] : ["StudioProof did not complete."] }
  };
  const identified = { ...updated, id: finalProofBundleId(updated) };
  assertProofBundle(identified);
  return identified;
}

/** Content identity for decision evidence; excludes time and the later trace backlink. */
function finalProofBundleId(bundle: ProofBundle): string {
  const { id: _id, generatedAt: _generatedAt, buildTraceId: _buildTraceId, ...decisionEvidence } = bundle;
  return `proof_${contentHash(stableJson(decisionEvidence)).slice(0, 24)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isPrimitive(value: unknown): value is string | number | boolean { return isString(value) || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)); }
function isVerificationStatus(value: unknown): value is VerificationStatus { return value === "pass" || value === "fail" || value === "not_run" || value === "unknown"; }
