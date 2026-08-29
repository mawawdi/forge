import { assertProofBundle, assertStudioAssertion, contentHash, stableJson, type Hash, type MechanicContract, type ProofBundle, type StudioAssertion, type VerificationIssue, type VerificationStatus } from "../../contracts/src/index.js";
import { assertProjectSnapshot, type ProjectSnapshot } from "../../semantic-map/src/index.js";
import { assertPluginToBackendMessage, type PluginToBackendMessage } from "../../studio-protocol/src/index.js";

export interface StudioTestPlan {
  kind: "StudioTestPlan";
  schemaVersion: 1;
  id: string;
  mechanicContractId: string;
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
  schemaVersion: 1;
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
}

export interface StudioProofRun {
  kind: "StudioProofRun";
  schemaVersion: 1;
  runId: string;
  testPlan: StudioTestPlan;
  beforeSnapshot: ProjectSnapshot;
  afterSnapshot?: ProjectSnapshot;
  pluginVersion: string;
  studioVersion: string;
  transactionId?: string;
  assertionResults: StudioAssertionResult[];
  runtimeEvidence: Array<{ type: "state" | "remote" | "log" | "error" | "instance"; statement: string; data?: Record<string, string | number | boolean> }>;
  status: "pass" | "fail" | "incomplete";
  authoritative: boolean;
}

export interface StudioProofCaptureOptions {
  runId: string;
  testPlan: StudioTestPlan;
  beforeSnapshot: ProjectSnapshot;
  pluginVersion: string;
  studioVersion: string;
  transactionId?: string;
  authoritativeSession: boolean;
}

export class StudioProofCapture {
  private readonly results = new Map<string, StudioAssertionResult>();
  private readonly runtimeEvidence: StudioProofRun["runtimeEvidence"] = [];
  private afterSnapshot: ProjectSnapshot | undefined;
  private playtestStopped = false;

  constructor(private readonly options: StudioProofCaptureOptions) {}

  accept(message: PluginToBackendMessage): void {
    assertPluginToBackendMessage(message);
    if (message.type === "ProjectSnapshot") {
      assertProjectSnapshot(message.payload.snapshot);
      this.afterSnapshot = message.payload.snapshot;
      return;
    }
    if (message.type === "AssertionResult") {
      if (message.payload.runId !== this.options.runId || message.payload.testPlanId !== this.options.testPlan.id) throw new Error("Studio assertion result does not match the active run");
      this.results.set(message.payload.id, { kind: "StudioAssertionResult", schemaVersion: 1, ...message.payload });
      return;
    }
    if (message.type === "RuntimeEvidence") {
      if (message.payload.runId !== this.options.runId) throw new Error("Runtime evidence does not match the active run");
      this.runtimeEvidence.push(...message.payload.instances.map((instance) => ({ type: "instance" as const, statement: `Observed ${instance.className} at ${instance.path}`, data: { path: instance.path, className: instance.className } })));
      this.runtimeEvidence.push(...message.payload.logs.map((log) => ({ type: "log" as const, statement: log })));
      this.runtimeEvidence.push(...message.payload.errors.map((error) => ({ type: "error" as const, statement: error })));
      return;
    }
    if (message.type === "StudioOutput") {
      if (message.payload.runId && message.payload.runId !== this.options.runId) return;
      this.runtimeEvidence.push({ type: message.payload.stream === "error" ? "error" : "log", statement: message.payload.text });
      return;
    }
    if (message.type === "PlaytestStopped" && message.payload.runId === this.options.runId) this.playtestStopped = true;
  }

  complete(): StudioProofRun {
    const expectedIds = new Set(this.options.testPlan.assertions.map((assertion) => assertion.id));
    const results = [...this.results.values()].filter((result) => expectedIds.has(result.assertionId));
    const complete = results.length === expectedIds.size && expectedIds.size > 0;
    const authoritative = this.options.authoritativeSession && this.playtestStopped;
    const status: StudioProofRun["status"] = !complete ? "incomplete" : results.every((result) => result.status === "pass") ? "pass" : "fail";
    return { kind: "StudioProofRun", schemaVersion: 1, runId: this.options.runId, testPlan: this.options.testPlan, beforeSnapshot: this.options.beforeSnapshot, ...(this.afterSnapshot ? { afterSnapshot: this.afterSnapshot } : {}), pluginVersion: this.options.pluginVersion, studioVersion: this.options.studioVersion, ...(this.options.transactionId ? { transactionId: this.options.transactionId } : {}), assertionResults: results.map((result) => ({ ...result, authoritative: authoritative && result.authoritative })), runtimeEvidence: [...this.runtimeEvidence], status, authoritative };
  }
}

export function collectFruitTestPlan(contract: MechanicContract, snapshot: ProjectSnapshot): StudioTestPlan {
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
    kind: "StudioTestPlan", schemaVersion: 1, id: `studio_plan_${contentHash(stableJson({ contractId: contract.id, snapshotHash: snapshot.projectSemanticHash, assertionIds: assertions.map((item) => item.id) })).slice(0, 24)}`,
    mechanicContractId: contract.id, projectSnapshotHash: snapshot.projectSemanticHash,
    setup: [{ action: "reset isolated test state", actor: "system" }],
    actors: [{ id: "server", role: "authority" }, { id: "client_1", role: "requester" }, { id: "system", role: "observer" }],
    actions: [], assertions,
    adversarialCases: assertions.filter((item) => item.tags.includes("adversarial")).map((item) => ({ id: item.id, assertionIds: [item.id], description: item.name })),
    cleanup: [{ action: "stop playtest and restore test state", actor: "system" }], version: "collect-fruit-v1"
  };
}

export function assertStudioTestPlan(value: unknown): asserts value is StudioTestPlan {
  if (!isRecord(value) || value.kind !== "StudioTestPlan" || value.schemaVersion !== 1 || !isString(value.id) || !isString(value.mechanicContractId) || !isString(value.projectSnapshotHash) || !Array.isArray(value.setup) || !Array.isArray(value.actors) || !Array.isArray(value.actions) || !Array.isArray(value.assertions) || !Array.isArray(value.adversarialCases) || !Array.isArray(value.cleanup) || !isString(value.version)) throw new Error("Invalid StudioTestPlan: expected schemaVersion 1");
  for (const assertion of value.assertions) assertStudioAssertion(assertion);
}

export function assertStudioProofRun(value: unknown): asserts value is StudioProofRun {
  if (!isRecord(value) || value.kind !== "StudioProofRun" || value.schemaVersion !== 1 || !isString(value.runId) || !isRecord(value.testPlan) || !isRecord(value.beforeSnapshot) || !Array.isArray(value.assertionResults) || !Array.isArray(value.runtimeEvidence) || !isString(value.pluginVersion) || !isString(value.studioVersion) || !["pass", "fail", "incomplete"].includes(String(value.status)) || typeof value.authoritative !== "boolean") throw new Error("Invalid StudioProofRun: expected schemaVersion 1");
  assertStudioTestPlan(value.testPlan);
  assertProjectSnapshot(value.beforeSnapshot);
  if (value.afterSnapshot !== undefined) assertProjectSnapshot(value.afterSnapshot);
  const assertionIds = new Set(value.testPlan.assertions.map((assertion) => assertion.id));
  const resultIds = new Set<string>();
  const resultAssertionIds = new Set<string>();
  for (const result of value.assertionResults) {
    if (!isRecord(result) || result.kind !== "StudioAssertionResult" || result.schemaVersion !== 1 || !isString(result.id) || !isString(result.runId) || result.runId !== value.runId || !isString(result.testPlanId) || result.testPlanId !== value.testPlan.id || !isString(result.assertionId) || !assertionIds.has(result.assertionId) || resultIds.has(result.id) || resultAssertionIds.has(result.assertionId) || !isVerificationStatus(result.status) || !isPrimitive(result.expected) || !isPrimitive(result.observed) || !Array.isArray(result.evidence) || typeof result.authoritative !== "boolean" || typeof result.durationMs !== "number" || result.durationMs < 0) throw new Error("Invalid StudioAssertionResult: result is not correlated to its run and test plan");
    resultIds.add(result.id);
    resultAssertionIds.add(result.assertionId);
  }
}

export function attachStudioProof(bundle: ProofBundle, run: StudioProofRun): ProofBundle {
  assertProofBundle(bundle);
  assertStudioProofRun(run);
  if (!run.authoritative && run.status !== "incomplete") throw new Error("StudioProofRun with pass/fail status must be authoritative");
  const assertionResults = run.assertionResults.map((result) => ({ assertionId: result.assertionId, status: result.status, ...(result.observed !== undefined ? { observed: { observed: result.observed } } : {}), ...(result.runId ? { runId: result.runId } : {}) }));
  const expectedAssertionIds = new Set(run.testPlan.assertions.map((assertion) => assertion.id));
  const observedAssertionIds = new Set(run.assertionResults.map((result) => result.assertionId));
  const allPassed = run.status === "pass" && run.authoritative && expectedAssertionIds.size > 0 && observedAssertionIds.size === expectedAssertionIds.size && [...expectedAssertionIds].every((id) => observedAssertionIds.has(id)) && run.assertionResults.every((result) => result.status === "pass" && result.authoritative);
  const staticPassed = bundle.checks.filter((check) => check.tier === "static").every((check) => check.status === "pass");
  const updated: ProofBundle = {
    ...bundle,
    assertions: assertionResults,
    ...(run.authoritative ? { studioProof: { testPlanId: run.testPlan.id, runId: run.runId, beforeSnapshotHash: run.beforeSnapshot.projectSemanticHash, ...(run.afterSnapshot ? { afterSnapshotHash: run.afterSnapshot.projectSemanticHash } : {}), pluginVersion: run.pluginVersion, studioVersion: run.studioVersion, assertionResultIds: run.assertionResults.map((result) => result.id), authoritative: true } } : {}),
    checks: [...bundle.checks.filter((check) => check.name !== "roblox_studio"), { name: "roblox_studio", tier: "studio", status: allPassed ? "pass" : run.status === "fail" ? "fail" : "unknown", issueIds: [], resultHash: contentHash(stableJson(run)) }],
    gate: { status: staticPassed && allPassed ? "verified" : run.status === "fail" ? "rejected" : "incomplete", reasons: staticPassed && allPassed ? ["Static, semantic, and authoritative Studio assertions passed."] : run.status === "fail" ? ["One or more authoritative Studio assertions failed."] : ["StudioProof did not complete."] }
  };
  assertProofBundle(updated);
  return updated;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isPrimitive(value: unknown): value is string | number | boolean { return isString(value) || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)); }
function isVerificationStatus(value: unknown): value is VerificationStatus { return value === "pass" || value === "fail" || value === "not_run" || value === "unknown"; }
