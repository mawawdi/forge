import { strict as assert } from "node:assert";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { FORGE_NATIVE_RUNTIME_IDENTITY, type AgentRuntime } from "../packages/agent-runtime/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { assertExperimentRegistration, registerExperiment, runRegisteredExperiment } from "../packages/experiments/src/index.js";
import { OPENROUTER_MODEL_CLIENT_DESCRIPTOR } from "../packages/model-client/src/index.js";
import { assertAcceptanceSpec, assertAcceptanceSpecReferences, assertIntegrationConstraint, assertIntegrationConstraintReferences, assertRequirementSet, resolveRequirementView, type AcceptanceSpec, type IntegrationConstraint, type RequirementSet } from "../packages/semantic-authority/src/index.js";
import { createStudioExecutionPlan, gradeRuntimeObservations, type RuntimeEvalDefinition, type RuntimeEvaluatorConfiguration, type RuntimeObservationEnvelope, STUDIO_CAPABILITY_SET } from "../packages/studio-capabilities/src/index.js";

const EXAMPLE = resolve("examples/vertical-shuttle");
const SEED = join(EXAMPLE, "seed");
const TASK = join(EXAMPLE, "task");

async function taskArtifacts() {
  const [creatorPrompt, requirementsValue, acceptanceValue, definitionValue, configurationValue] = await Promise.all([
    readFile(join(TASK, "creator-prompt.txt"), "utf8"), readFile(join(TASK, "requirements.json"), "utf8"), readFile(join(TASK, "acceptance.json"), "utf8"), readFile(join(TASK, "evaluator/runtime-eval-definition.json"), "utf8"), readFile(join(TASK, "evaluator/runtime-evaluator-configuration.json"), "utf8")
  ]);
  const runtimeEvalDefinition = JSON.parse(definitionValue) as RuntimeEvalDefinition;
  const runtimeEvaluatorConfiguration = JSON.parse(configurationValue) as RuntimeEvaluatorConfiguration;
  return {
    creatorPrompt: creatorPrompt.trim(),
    requirementSet: JSON.parse(requirementsValue) as RequirementSet,
    acceptanceSpec: JSON.parse(acceptanceValue) as AcceptanceSpec,
    runtimeEvalDefinition,
    runtimeEvaluatorConfiguration
  };
}

async function registration(seedRoot = SEED) {
  const artifacts = await taskArtifacts();
  return registerExperiment({ repositoryRoot: resolve("."), seedRoot, name: "vertical-shuttle", hypothesis: "A registered source-root treatment can produce a locally eligible candidate and a separately graded Studio runtime outcome.", ...artifacts, runtime: { identity: FORGE_NATIVE_RUNTIME_IDENTITY, modelClientDescriptor: OPENROUTER_MODEL_CLIENT_DESCRIPTOR }, model: "openai/gpt-5.6-luna" });
}

test("Vertical Shuttle task is evaluator-isolated and fully bound to implemented position capabilities", async () => {
  const artifacts = await taskArtifacts();
  assertRequirementSet(artifacts.requirementSet); assertAcceptanceSpec(artifacts.acceptanceSpec); assertAcceptanceSpecReferences(artifacts.acceptanceSpec, artifacts.requirementSet);
  for (const value of JSON.parse(await readFile(join(TASK, "integration-constraints.json"), "utf8")) as IntegrationConstraint[]) { assertIntegrationConstraint(value); assertIntegrationConstraintReferences(value, artifacts.requirementSet); }
  const builder = resolveRequirementView(artifacts.requirementSet, { phase: "build", environment: "benchmark", audience: "builder" });
  const evaluator = resolveRequirementView(artifacts.requirementSet, { phase: "evaluate", environment: "benchmark", audience: "evaluator" });
  assert.equal(artifacts.runtimeEvalDefinition.requirementSetId, artifacts.requirementSet.id);
  assert.equal(artifacts.runtimeEvalDefinition.evaluatorViewId, evaluator.id);
  assert.equal(artifacts.runtimeEvalDefinition.evaluatorViewHash, contentHash(stableJson(evaluator)));
  assert.equal(artifacts.runtimeEvaluatorConfiguration.runtimeEvalDefinitionId, artifacts.runtimeEvalDefinition.id);
  const builderJson = stableJson(builder);
  assert.doesNotMatch(builderJson, /evaluator-vertical-shuttle-motion|Hidden benchmark/);
  assert.match(builderJson, /Workspace\/Shuttle/);
  assert.deepEqual(JSON.parse(await readFile(join(SEED, "forge.fixture.json"), "utf8")).luauRoots, ["src/server"]);
});

test("ExperimentRegistration is deterministic, secret-free, and rejects a changed treatment", async () => {
  const first = await registration(); const second = await registration();
  assert.equal(first.hash, second.hash); assert.equal(first.id, second.id);
  assert.equal(first.model.name, "openai/gpt-5.6-luna");
  assert.deepEqual(first.seed.sourceRoots, ["src/server"]);
  assert.equal(first.expected.seedHash, first.seed.hash);
  assert.doesNotMatch(stableJson(first), /OPENROUTER_API_KEY|apiKey|\/Users\//);
  assert.throws(() => assertExperimentRegistration({ ...first, creatorPrompt: "Changed prompt" }));
  assert.throws(() => assertExperimentRegistration({ ...first, model: { ...first.model, name: "openai/gpt-5.6-sol" } }));
  assert.throws(() => assertExperimentRegistration({ ...first, budgets: { ...first.budgets, maxTurns: first.budgets.maxTurns + 1 } }));
  assert.throws(() => assertExperimentRegistration({ ...first, artifacts: { ...first.artifacts, requirementSetHash: contentHash("changed") } }));
  assert.throws(() => assertExperimentRegistration({ ...first, expected: { ...first.expected, sourceRoots: ["src/shared"] } }));
  assert.throws(() => assertExperimentRegistration({ ...first, studio: { ...first.studio, capabilitySetHash: "0".repeat(64) } }));
});

test("registered execution exposes only builder facts, propagates registration evidence, and fails closed before a drifted seed reaches a runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-experiment-test-"));
  const seed = join(root, "seed");
  await cp(SEED, seed, { recursive: true });
  try {
    const registered = await registration(seed);
    let calls = 0;
    const runtime: AgentRuntime = {
      identity: FORGE_NATIVE_RUNTIME_IDENTITY,
      modelClientDescriptor: OPENROUTER_MODEL_CLIENT_DESCRIPTOR,
      async run(input) {
        calls += 1;
        const initial = stableJson(input.orientation);
        assert.match(initial, /src\/server/);
        assert.doesNotMatch(initial, /Hidden benchmark|evaluator-vertical-shuttle-motion|forge-experiment-test/);
        assert.equal((await input.tools.execute("plan.update", { goal: "Create the shuttle controller", steps: [{ id: "create-controller", statement: "Create one server controller", status: "in_progress" }], status: "active" })).ok, true);
        assert.equal((await input.tools.execute("workspace.write", { path: "src/server/ShuttleController.server.luau", precondition: { kind: "absent" }, content: "local shuttle = workspace:WaitForChild(\"Shuttle\")\nshuttle.Anchored = true\n" })).ok, true);
        return { status: "completed", trialStarted: true, usage: { turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 }, turns: [] };
      }
    };
    const runDirectory = join(root, "runs");
    const result = await runRegisteredExperiment({ registration: registered, repositoryRoot: resolve("."), seedRoot: seed, runtime, runDirectory, traceDirectory: join(root, "traces") });
    assert.equal(calls, 1); assert.equal(result.status, "locally_eligible");
    assert.equal(result.run.origin.kind, "registered_experiment");
    assert.equal(result.run.origin.kind === "registered_experiment" && result.run.origin.experimentRegistrationHash, registered.hash);
    assert.equal(result.candidateArtifact?.artifact.origin.kind, "registered_experiment");
    assert.equal(result.trace.references.experimentRegistrationId, registered.id);
    await writeFile(join(seed, "src/server/Drift.server.luau"), "return nil\n", "utf8");
    calls = 0;
    await assert.rejects(() => runRegisteredExperiment({ registration: registered, repositoryRoot: resolve("."), seedRoot: seed, runtime, runDirectory: join(root, "drift-runs"), traceDirectory: join(root, "drift-traces") }), /drift/i);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Vertical Shuttle evaluator grades an authoritative moving envelope and rejects a static one", async () => {
  const { runtimeEvalDefinition: definition } = await taskArtifacts();
  const plan = createStudioExecutionPlan({ purpose: "runtime_evaluation", capabilitySetId: STUDIO_CAPABILITY_SET.id, capabilitySetHash: STUDIO_CAPABILITY_SET.hash, binding: { runId: "runtime_run_vertical", correlationId: "runtime_correlation_vertical", sessionId: "session_vertical", projectId: "project_vertical", project: { name: "Vertical Shuttle", placeId: 0, universeId: 0 }, projectSnapshotHash: "a".repeat(64), candidateHash: "b".repeat(64) }, targets: definition.targets, calls: definition.calls, budget: definition.budget });
  const envelope = (moving: boolean): RuntimeObservationEnvelope => ({
    kind: "RuntimeObservationEnvelope", executionPlanId: plan.id, executionPlanHash: plan.hash, binding: plan.binding, nonce: "vertical_shuttle_nonce_0123456789", nonceCommitment: contentHash("vertical_shuttle_nonce_0123456789"), authoritative: true, startedAt: "2026-08-31T00:00:00.000Z", endedAt: "2026-08-31T00:00:08.000Z", durationMs: 8_000, diagnostics: { errors: 0, warnings: 0, messageHashes: [], truncated: false },
    results: [
      { id: "call-01-resolve-lower-stop", capability: "instance.resolve", targetId: "target-lower-stop", status: "resolved", path: "Workspace/LowerStop", className: "Part" },
      { id: "call-02-position-lower-stop", capability: "base_part.position", targetId: "target-lower-stop", status: "ok", position: { x: 0, y: 2, z: 0 }, elapsedMs: 1 },
      { id: "call-03-resolve-upper-stop", capability: "instance.resolve", targetId: "target-upper-stop", status: "resolved", path: "Workspace/UpperStop", className: "Part" },
      { id: "call-04-position-upper-stop", capability: "base_part.position", targetId: "target-upper-stop", status: "ok", position: { x: 0, y: 20, z: 0 }, elapsedMs: 2 },
      { id: "call-05-resolve-shuttle", capability: "instance.resolve", targetId: "target-shuttle", status: "resolved", path: "Workspace/Shuttle", className: "Part" },
      { id: "call-06-series-shuttle", capability: "base_part.position_series", targetId: "target-shuttle", status: "ok", samples: Array.from({ length: 32 }, (_, index) => ({ sequence: index + 1, elapsedMs: index * 250, position: { x: 0, y: moving ? index <= 12 ? 2 + 18 * (index / 12) : 20 - 18 * ((index - 12) / 12) : 2, z: 0 } })) }
    ]
  });
  assert.ok(gradeRuntimeObservations(definition, envelope(true)).every((result) => result.status === "pass"));
  assert.ok(gradeRuntimeObservations(definition, envelope(false)).some((result) => result.status === "fail"));
});
