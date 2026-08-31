import assert from "node:assert/strict";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  STUDIO_CAPABILITY_SET,
  STUDIO_INSTANCE_RESOLUTION_ROOTS,
  assertStudioExecutionPlan,
  createRuntimeEvalDefinition,
  createRuntimeEvalPlan,
  createRuntimeEvaluatorConfiguration,
  createStudioExecutionPlan,
  gradeRuntimeObservations,
  type RuntimeObservationEnvelope,
  type StudioExecutionPlan,
} from "../packages/studio-capabilities/src/index.js";
import { executeRuntimeEvaluation, executeStudioCapabilityCanary } from "../packages/studio-runtime/src/index.js";
import type { StudioBridgeConnection, StudioBridgeSession } from "../packages/studio-bridge/src/index.js";
import type { BackendToPluginMessage, PluginToBackendMessage } from "../packages/studio-protocol/src/index.js";
import type { StudioSnapshotObservation } from "../packages/semantic-map/src/index.js";

const execFile = promisify(execFileCallback);

const HASH = contentHash("studio-capability-test");
const SESSION: StudioBridgeSession = {
  sessionId: "session_runtime", projectId: "project_runtime", project: { name: "MovingPlatform", placeId: 0, universeId: 0 }, capabilities: ["snapshot", "snapshot_chunks", "sha256", "stable_identity", "studio_play_mode", "http_polling", "bounded_diagnostics", "runtime_eval", "studio_authoring", "creator_control"], sessionToken: "private", connectedAt: "2026-08-30T00:00:00.000Z"
};

const TARGETS = [
  { id: "target-a", path: "Workspace/EndpointA", expectedClass: "BasePart" as const },
  { id: "target-b", path: "Workspace/EndpointB", expectedClass: "BasePart" as const },
  { id: "target-platform", path: "Workspace/MovingPlatform", expectedClass: "BasePart" as const },
];
const CALLS = [
  { id: "call-01-resolve-a", capability: "instance.resolve" as const, targetId: "target-a" },
  { id: "call-02-position-a", capability: "base_part.position" as const, targetId: "target-a" },
  { id: "call-03-resolve-b", capability: "instance.resolve" as const, targetId: "target-b" },
  { id: "call-04-position-b", capability: "base_part.position" as const, targetId: "target-b" },
  { id: "call-05-resolve-platform", capability: "instance.resolve" as const, targetId: "target-platform" },
  { id: "call-06-series-platform", capability: "base_part.position_series" as const, targetId: "target-platform", sampleCount: 9, intervalMs: 250 },
];

const PRE_PLAY_OBSERVATION: StudioSnapshotObservation = {
  kind: "StudioSnapshotObservation",
    project: SESSION.project,
  capturedAt: "2026-08-30T00:00:00.000Z",
  instances: [
    { stableId: "instance-a", path: "Workspace/EndpointA", className: "Part", position: { x: -12, y: 4, z: 0 }, properties: [], attributes: [], tags: [] },
    { stableId: "instance-b", path: "Workspace/EndpointB", className: "Part", position: { x: 12, y: 4, z: 0 }, properties: [], attributes: [], tags: [] },
    { stableId: "instance-platform", path: "Workspace/MovingPlatform", className: "Part", position: { x: -12, y: 4, z: 0 }, properties: [], attributes: [], tags: [] }
  ],
  scripts: [],
  remotes: []
};

function definition() {
  return createRuntimeEvalDefinition({
    requirementSetId: "requirement_set_runtime", evaluatorViewId: "requirement_view_runtime", evaluatorViewHash: HASH, acceptanceSpecId: "acceptance_spec_runtime",
    provenance: { source: "evaluator", authority: "evaluation_only", visibility: "evaluator_only" }, capabilitySetId: STUDIO_CAPABILITY_SET.id, capabilitySetHash: STUDIO_CAPABILITY_SET.hash,
    targets: TARGETS, calls: CALLS, budget: { maxExecutionMs: 10_000, maxResultBytes: 64 * 1024 },
    assertions: [
      { id: "assert-distinct", requirementId: "requirement-motion", acceptanceAssertionId: "acceptance-distinct", kind: "distinct_positions_at_least", observationId: "call-06-series-platform", quantizationStuds: 0.5, minimumDistinctPositions: 5 },
      { id: "assert-exists-a", requirementId: "requirement-a", acceptanceAssertionId: "acceptance-a", kind: "exists", observationId: "call-01-resolve-a" },
      { id: "assert-exists-b", requirementId: "requirement-b", acceptanceAssertionId: "acceptance-b", kind: "exists", observationId: "call-03-resolve-b" },
      { id: "assert-exists-platform", requirementId: "requirement-platform", acceptanceAssertionId: "acceptance-platform", kind: "exists", observationId: "call-05-resolve-platform" },
      { id: "assert-visits", requirementId: "requirement-motion", acceptanceAssertionId: "acceptance-visits", kind: "ordered_position_visits", seriesObservationId: "call-06-series-platform", endpointAObservationId: "call-02-position-a", endpointBObservationId: "call-04-position-b", toleranceStuds: 2, minimumLegMs: 1000, maximumLegMs: 3500, acceptedOrders: [["A", "B", "A"]] }
    ]
  });
}

function executionPlan(purpose: "runtime_evaluation" | "capability_canary" = "runtime_evaluation"): StudioExecutionPlan {
  return createStudioExecutionPlan({
    purpose, capabilitySetId: STUDIO_CAPABILITY_SET.id, capabilitySetHash: STUDIO_CAPABILITY_SET.hash,
    binding: { runId: "runtime_run", correlationId: "runtime_correlation", sessionId: SESSION.sessionId, projectId: SESSION.projectId, project: SESSION.project, projectSnapshotHash: HASH, ...(purpose === "runtime_evaluation" ? { candidateHash: HASH } : {}) },
    targets: TARGETS, calls: CALLS, budget: { maxExecutionMs: 10_000, maxResultBytes: 64 * 1024 }
  });
}

function envelope(plan: StudioExecutionPlan, moving = true): RuntimeObservationEnvelope {
  const nonce = "nonce_runtime_01234567890123456789";
  const values = moving ? [-12, -8, -4, 0, 4, 8, 12, 8, -12] : [-12, -12, -12, -12, -12, -12, -12, -12, -12];
  return {
    kind: "RuntimeObservationEnvelope", executionPlanId: plan.id, executionPlanHash: plan.hash, binding: plan.binding, nonce, nonceCommitment: contentHash(nonce), authoritative: true,
    startedAt: "2026-08-30T00:00:00.000Z", endedAt: "2026-08-30T00:00:04.000Z", durationMs: 4_000,
    diagnostics: { errors: 0, warnings: 0, messageHashes: [], truncated: false }, results: [
      { id: "call-01-resolve-a", capability: "instance.resolve", targetId: "target-a", status: "resolved", path: "Workspace/EndpointA", className: "Part" },
      { id: "call-02-position-a", capability: "base_part.position", targetId: "target-a", status: "ok", position: { x: -12, y: 4, z: 0 }, elapsedMs: 1 },
      { id: "call-03-resolve-b", capability: "instance.resolve", targetId: "target-b", status: "resolved", path: "Workspace/EndpointB", className: "Part" },
      { id: "call-04-position-b", capability: "base_part.position", targetId: "target-b", status: "ok", position: { x: 12, y: 4, z: 0 }, elapsedMs: 2 },
      { id: "call-05-resolve-platform", capability: "instance.resolve", targetId: "target-platform", status: "resolved", path: "Workspace/MovingPlatform", className: "Part" },
      { id: "call-06-series-platform", capability: "base_part.position_series", targetId: "target-platform", status: "ok", samples: values.map((x, index) => ({ sequence: index + 1, elapsedMs: index * 500, position: { x, y: 4, z: 0 } })) }
    ]
  };
}

class FakeRuntimeConnection implements StudioBridgeConnection {
  private handlers = new Set<(message: PluginToBackendMessage, session: StudioBridgeSession) => void | Promise<void>>();
  constructor(private readonly options: { motion: boolean; collapseStaticPosition?: boolean; pluginFailure?: boolean; wrongNonce?: boolean; duplicateResult?: boolean; silent?: boolean }) {}
  subscribeWithSession(handler: (message: PluginToBackendMessage, session: StudioBridgeSession) => void | Promise<void>): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  async close(): Promise<void> {}
  async send(message: BackendToPluginMessage): Promise<void> {
    if (message.type !== "ExecuteRuntimeEvalPlan") return;
    if (this.options.silent) return;
    const plan = JSON.parse(message.payload.executionPlanJson) as StudioExecutionPlan;
    assert.equal(message.payload.executionPlanJsonHash, contentHash(message.payload.executionPlanJson));
    const nonce = "nonce_runtime_01234567890123456789";
    const commitment = contentHash(nonce);
    const emit = async (type: PluginToBackendMessage["type"], payload: unknown) => {
      const value = { kind: "StudioProtocolMessage", direction: "plugin_to_backend", type, messageId: `msg_${type}`, sessionId: SESSION.sessionId, requestId: message.requestId, sentAt: "2026-08-30T00:00:00.000Z", payload } as PluginToBackendMessage;
      for (const handler of this.handlers) await handler(value, SESSION);
    };
    await emit("RuntimeEvalPlanAccepted", { executionPlanId: plan.id, executionPlanHash: plan.hash, binding: plan.binding, nonceCommitment: commitment, callCount: plan.calls.length, instruction: "armed" });
    const control = message.payload.startPolicy === "creator_action_already_authorized" ? "creator_action" : "plugin_action";
    await emit("RuntimeEvalStarted", { executionPlanId: plan.id, executionPlanHash: plan.hash, binding: plan.binding, nonceCommitment: commitment, mode: "play_solo", playerCount: 1, control });
    if (this.options.pluginFailure) {
      await emit("PluginError", { code: "STUDIO_FAILURE", message: "Runtime capability runner did not return an observation envelope", retryable: false });
      return;
    }
    const result = envelope(plan, this.options.motion);
    if (this.options.wrongNonce) result.nonce = "wrong_nonce_01234567890123456789";
    if (this.options.collapseStaticPosition) {
      const endpointB = result.results.find((entry) => entry.id === "call-04-position-b");
      if (endpointB?.capability === "base_part.position") endpointB.position = { x: 0, y: 0, z: 0 };
    }
    await emit("RuntimeEvalResult", result);
    if (this.options.duplicateResult) await emit("RuntimeEvalResult", result);
    await emit("RuntimeEvalStopped", { executionPlanId: plan.id, executionPlanHash: plan.hash, binding: plan.binding, nonceCommitment: commitment, mode: "play_solo", playerCount: 1, control });
  }
}

test("capability contracts are deterministic and runtime endpoints originate in position observations", () => {
  const first = definition();
  const second = definition();
  assert.equal(first.hash, second.hash);
  const passing = gradeRuntimeObservations(first, envelope(executionPlan()));
  assert.ok(passing.every((result) => result.status === "pass"));
  const bad = structuredClone(executionPlan()) as unknown as { calls: Array<{ id: string; capability: string }> };
  [bad.calls[0], bad.calls[1]] = [bad.calls[1]!, bad.calls[0]!];
  assert.throws(() => assertStudioExecutionPlan(bad));
  assert.equal(stableJson(first).includes("EndpointA") && stableJson(first).includes("position"), true);
});

test("class-aware resolution admits service-root Scripts while position remains Workspace BasePart-only", () => {
  const targets = [
    { id: "part", path: "Workspace/Generator", expectedClass: "BasePart" as const },
    { id: "model", path: "Workspace/PreservedTree", expectedClass: "Model" as const },
    { id: "script", path: "ServerScriptService/StatusBeaconScript", expectedClass: "Script" as const }
  ];
  const plan = createStudioExecutionPlan({ purpose: "creator_verification", capabilitySetId: STUDIO_CAPABILITY_SET.id, capabilitySetHash: STUDIO_CAPABILITY_SET.hash, binding: { runId: "creator_class_run", correlationId: "creator_class_correlation", sessionId: SESSION.sessionId, projectId: SESSION.projectId, project: SESSION.project, projectSnapshotHash: HASH }, targets, calls: targets.map((target, index) => ({ id: `resolve-${index}`, capability: "instance.resolve" as const, targetId: target.id })), budget: { maxExecutionMs: 1_000, maxResultBytes: 4_096 } });
  assert.deepEqual(Object.fromEntries(plan.targets.map((target) => [target.id, target.expectedClass])), { model: "Model", part: "BasePart", script: "Script" });
  assert.deepEqual(STUDIO_CAPABILITY_SET.policy.allowedRoots, [...STUDIO_INSTANCE_RESOLUTION_ROOTS]);
  assert.throws(() => createStudioExecutionPlan({ purpose: "creator_verification", capabilitySetId: STUDIO_CAPABILITY_SET.id, capabilitySetHash: STUDIO_CAPABILITY_SET.hash, binding: plan.binding, targets, calls: [{ id: "call-01-resolve-model", capability: "instance.resolve", targetId: "model" }, { id: "call-02-position-model", capability: "base_part.position", targetId: "model" }], budget: plan.budget }), /BasePart/);
  const servicePartTargets = [{ id: "service-part", path: "ServerStorage/StoredPart", expectedClass: "BasePart" as const }];
  assert.throws(() => createStudioExecutionPlan({ purpose: "creator_verification", capabilitySetId: STUDIO_CAPABILITY_SET.id, capabilitySetHash: STUDIO_CAPABILITY_SET.hash, binding: plan.binding, targets: servicePartTargets, calls: [{ id: "call-01-resolve-service-part", capability: "instance.resolve", targetId: "service-part" }, { id: "call-02-position-service-part", capability: "base_part.position", targetId: "service-part" }], budget: plan.budget }), /Workspace/);
});

test("trusted runner bounds observations without an unmodeled load delay or arbitrary code execution", async () => {
  const runner = await readFile(resolve("plugin/src/Forge/RuntimeCapabilityExecutor.luau"), "utf8");
  assert.doesNotMatch(runner, /game:IsLoaded\(\)/);
  assert.doesNotMatch(runner, /loadstring|require\s*\(\s*plan|HttpService:GetAsync|HttpService:PostAsync/);
  assert.match(runner, /if \(os\.clock\(\) - started\) \* 1000 > plan\.budget\.maxExecutionMs/);
});

test("fake transport proves same-session runtime success, rejection, and a proof-free canary", async () => {
  const evaluator = definition();
  const plan = executionPlan();
  const config = createRuntimeEvaluatorConfiguration({ capabilitySetId: STUDIO_CAPABILITY_SET.id, capabilitySetHash: STUDIO_CAPABILITY_SET.hash, assertionEngine: { name: "forge_runtime_assertions" }, runtimeEvalDefinitionId: evaluator.id, runtimeEvalDefinitionHash: evaluator.hash, executionPolicy: "creator_triggered_play_solo", bindingPolicy: "candidate_source_and_world_snapshot", maxResultBytes: 64 * 1024 });
  const runtimePlan = createRuntimeEvalPlan({ definitionId: evaluator.id, definitionHash: evaluator.hash, candidateArtifactId: "workspace_candidate_runtime", candidateArtifactHash: HASH, agentRunId: "agent_run_runtime", workspaceDeltaId: "workspace_delta_runtime", candidateHash: HASH, executionPlan: plan });
  const proofInput = {
    creatorPromptHash: HASH,
    experimentRegistrationId: "experiment_registration_runtime",
    experimentRegistrationHash: HASH,
    requirementSetId: "requirement_set_runtime",
    requirementViewId: "requirement_view_builder",
    evaluatorViewId: "requirement_view_runtime",
    harnessConfigurationId: "harness_configuration_runtime",
    harnessConfigurationHash: HASH,
    agentRunId: "agent_run_runtime",
    workspaceCandidateArtifactId: "workspace_candidate_runtime",
    workspaceCandidateArtifactHash: HASH,
    seedHash: HASH,
    candidateHash: HASH,
    workspaceDeltaId: "workspace_delta_runtime",
    localVerificationReportHash: HASH,
    localVerificationTraceId: "trace_local_runtime",
    runtimeEvalDefinitionId: evaluator.id,
    runtimeEvalDefinitionHash: evaluator.hash,
    runtimeEvalPlanId: runtimePlan.id,
    runtimeEvalPlanHash: runtimePlan.hash,
    studioCapabilitySetId: STUDIO_CAPABILITY_SET.id,
    studioCapabilitySetHash: STUDIO_CAPABILITY_SET.hash,
    runtimeEvaluatorConfigurationId: config.id,
    runtimeEvaluatorConfigurationHash: config.hash,
    scope: "exact_runtime_definition_capability_set_configuration_authoritative_run" as const
  };
  const passing = await executeRuntimeEvaluation({
    connection: new FakeRuntimeConnection({ motion: true }), session: SESSION, runtimeEvalPlan: runtimePlan, definition: evaluator, configuration: config, timeoutMs: 1_000,
    proofInput
  });
  assert.equal(passing.run.status, "runtime_verified");
  assert.equal(passing.proof?.status, "runtime_verified");
  assert.equal(passing.proof?.experimentRegistrationId, proofInput.experimentRegistrationId);
  assert.equal(passing.proof?.scope, "exact_runtime_definition_capability_set_configuration_authoritative_run");
  assert.equal(passing.trace.references.runtimeEvaluatorConfigurationHash, config.hash);
  assert.equal(passing.trace.references.runtimeProofId, passing.proof?.id);
  assert.equal(passing.trace.references.experimentRegistrationHash, proofInput.experimentRegistrationHash);
  assert.equal(stableJson(passing.proof).includes('"position"'), false, "public proof must not embed raw runtime observations");
  const failing = await executeRuntimeEvaluation({ connection: new FakeRuntimeConnection({ motion: false }), session: SESSION, runtimeEvalPlan: runtimePlan, definition: evaluator, configuration: config, timeoutMs: 1_000 });
  assert.equal(failing.run.status, "rejected");
  const wrongNonce = await executeRuntimeEvaluation({ connection: new FakeRuntimeConnection({ motion: true, wrongNonce: true }), session: SESSION, runtimeEvalPlan: runtimePlan, definition: evaluator, configuration: config, timeoutMs: 1_000 });
  assert.equal(wrongNonce.run.status, "incomplete"); assert.equal(wrongNonce.run.failure?.classification, "protocol");
  const duplicate = await executeRuntimeEvaluation({ connection: new FakeRuntimeConnection({ motion: true, duplicateResult: true }), session: SESSION, runtimeEvalPlan: runtimePlan, definition: evaluator, configuration: config, timeoutMs: 1_000 });
  assert.equal(duplicate.run.status, "incomplete"); assert.equal(duplicate.run.failure?.classification, "protocol");
  const timeout = await executeRuntimeEvaluation({ connection: new FakeRuntimeConnection({ motion: true, silent: true }), session: SESSION, runtimeEvalPlan: runtimePlan, definition: evaluator, configuration: config, timeoutMs: 25, proofInput });
  assert.equal(timeout.run.status, "incomplete"); assert.equal(timeout.run.failure?.classification, "timeout");
  assert.equal(timeout.proof?.status, "incomplete"); assert.deepEqual(timeout.proof?.assertionResults, []); assert.equal(timeout.trace.replayability.level, "none");
  const canary = await executeStudioCapabilityCanary({ connection: new FakeRuntimeConnection({ motion: true }), session: SESSION, executionPlan: executionPlan("capability_canary"), prePlayObservation: PRE_PLAY_OBSERVATION, staticTargetIds: ["target-a", "target-b"], timeoutMs: 1_000 });
  assert.equal(canary.status, "completed");
  assert.equal("runtimeEvalPlanId" in canary, false);
  const corruptCanary = await executeStudioCapabilityCanary({ connection: new FakeRuntimeConnection({ motion: true, collapseStaticPosition: true }), session: SESSION, executionPlan: executionPlan("capability_canary"), prePlayObservation: PRE_PLAY_OBSERVATION, staticTargetIds: ["target-a", "target-b"], timeoutMs: 1_000 });
  assert.equal(corruptCanary.status, "incomplete");
  assert.equal(corruptCanary.failure?.classification, "capability");
  assert.match(corruptCanary.failure?.detail ?? "", /EndpointB/);
  assert.ok(corruptCanary.observation, "failed integrity attestation retains factual observation evidence");
  const pluginFailure = await executeStudioCapabilityCanary({ connection: new FakeRuntimeConnection({ motion: true, pluginFailure: true }), session: SESSION, executionPlan: executionPlan("capability_canary"), prePlayObservation: PRE_PLAY_OBSERVATION, staticTargetIds: ["target-a", "target-b"], timeoutMs: 1_000 });
  assert.equal(pluginFailure.status, "incomplete");
  assert.equal(pluginFailure.failure?.classification, "studio");
  assert.match(pluginFailure.failure?.detail ?? "", /Runtime capability runner did not return/);
});

test("Status Beacon seed persists part transforms through CFrame rather than derived Position", async () => {
  const seed = resolve("examples/status-beacon");
  const project = JSON.parse(await readFile(resolve(seed, "default.project.json"), "utf8")) as {
    tree: {
      Workspace: {
        Generator: { $properties: Record<string, unknown> };
        PreservedTree: {
          Trunk: { $properties: Record<string, unknown> };
          Crown: { $properties: Record<string, unknown> };
        };
      };
    };
  };
  const parts = {
    Generator: project.tree.Workspace.Generator,
    Trunk: project.tree.Workspace.PreservedTree.Trunk,
    Crown: project.tree.Workspace.PreservedTree.Crown,
  };
  for (const [name, instance] of Object.entries(parts)) {
    const properties = instance.$properties;
    assert.equal(Array.isArray(properties.CFrame) && properties.CFrame.length, 12, `${name} must declare a full CFrame`);
    assert.equal("Position" in properties, false, `${name} must not serialize the derived Position property`);
  }
  const directory = await mkdtemp(join(tmpdir(), "forge-status-beacon-seed-"));
  const output = join(directory, "seed.rbxlx");
  try {
    await execFile("rojo", ["build", resolve(seed, "default.project.json"), "-o", output]);
    const rbxlx = await readFile(output, "utf8");
    assert.match(rbxlx, /<CoordinateFrame name="CFrame">\s*<X>0<\/X>\s*<Y>4<\/Y>/);
    assert.match(rbxlx, /<CoordinateFrame name="CFrame">\s*<X>16<\/X>\s*<Y>5<\/Y>/);
    assert.match(rbxlx, /<CoordinateFrame name="CFrame">\s*<X>16<\/X>\s*<Y>11<\/Y>/);
    assert.doesNotMatch(rbxlx, /<Vector3 name="Position">/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
