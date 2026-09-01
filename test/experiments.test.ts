import { strict as assert } from "node:assert";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  FORGE_NATIVE_RUNTIME_IDENTITY,
  type AgentRuntime,
} from "../packages/agent-runtime/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  assertExperimentRegistration,
  registerExperiment,
  runRegisteredExperiment,
} from "../packages/experiments/src/index.js";
import { OPENROUTER_MODEL_CLIENT_DESCRIPTOR } from "../packages/model-client/src/index.js";
import {
  assertAcceptanceSpec,
  assertAcceptanceSpecReferences,
  assertIntegrationConstraint,
  assertIntegrationConstraintReferences,
  assertRequirementSet,
  createAcceptanceSpec,
  createIntegrationConstraint,
  createRequirementSet,
  resolveRequirementView,
  type Requirement,
} from "../packages/semantic-authority/src/index.js";
import {
  createRuntimeEvalDefinition,
  createRuntimeEvaluatorConfiguration,
  createStudioExecutionPlan,
  gradeRuntimeObservations,
  type RuntimeObservationEnvelope,
  STUDIO_CAPABILITY_SET,
} from "../packages/studio-capabilities/src/index.js";

const SEED = resolve("test/fixtures/empty-declared-source-root");
const CREATOR_PROMPT =
  "Create a server controller for the observed Mover while preserving EndpointA and EndpointB.";
const PROJECT_ID = "project_registered_motion";
const PROJECT_SNAPSHOT_HASH = contentHash("registered-motion-snapshot");

function treatmentArtifacts() {
  const observation = (id: string, path: string): Requirement => ({
    kind: "Requirement",
    id,
    statement: `${path} is an observed existing BasePart to preserve.`,
    source: "project_observation",
    authority: "fact",
    visibility: "builder_visible",
    enforcement: "blocking",
    verificationModes: ["schema", "studio"],
    evidence: [
      {
        kind: "project_observation",
        id: `evidence-${id}`,
        projectId: PROJECT_ID,
        projectSnapshotHash: PROJECT_SNAPSHOT_HASH,
        locator: path,
        observationHash: contentHash(path),
      },
    ],
  });
  const requirementSet = createRequirementSet([
    {
      kind: "Requirement",
      id: "creator-registered-motion",
      statement: CREATOR_PROMPT,
      source: "creator",
      authority: "policy",
      visibility: "builder_visible",
      enforcement: "blocking",
      verificationModes: ["studio"],
      evidence: [
        {
          kind: "creator_request",
          id: "evidence-creator-registered-motion",
          intentId: "intent-registered-motion",
          requestHash: contentHash(CREATOR_PROMPT),
        },
      ],
    },
    {
      kind: "Requirement",
      id: "evaluator-motion-hidden",
      statement: "Hidden evaluator motion thresholds gate this synthetic treatment.",
      source: "evaluator",
      authority: "evaluation_only",
      visibility: "evaluator_only",
      enforcement: "blocking",
      verificationModes: ["studio"],
      evidence: [
        {
          kind: "evaluation_spec",
          id: "evidence-evaluator-motion-hidden",
          evaluationId: "registered-motion-evaluation",
          criterionId: "motion-observation",
          specificationHash: contentHash("hidden-motion-thresholds"),
        },
      ],
    },
    observation("observation-endpoint-a", "Workspace/EndpointA"),
    observation("observation-endpoint-b", "Workspace/EndpointB"),
    observation("observation-mover", "Workspace/Mover"),
  ]);
  const acceptanceSpec = createAcceptanceSpec({
    requirementSet,
    requirementIds: [
      "evaluator-motion-hidden",
      "observation-endpoint-a",
      "observation-endpoint-b",
      "observation-mover",
    ],
    assertionIds: [
      "assert-distinct-positions",
      "assert-exists-endpoint-a",
      "assert-exists-endpoint-b",
      "assert-exists-mover",
      "assert-ordered-visits",
    ],
  });
  const evaluatorView = resolveRequirementView(requirementSet, {
    phase: "evaluate",
    environment: "benchmark",
    audience: "evaluator",
  });
  const runtimeEvalDefinition = createRuntimeEvalDefinition({
    requirementSetId: requirementSet.id,
    evaluatorViewId: evaluatorView.id,
    evaluatorViewHash: contentHash(stableJson(evaluatorView)),
    acceptanceSpecId: acceptanceSpec.id,
    provenance: {
      source: "evaluator",
      authority: "evaluation_only",
      visibility: "evaluator_only",
    },
    capabilitySetId: STUDIO_CAPABILITY_SET.id,
    capabilitySetHash: STUDIO_CAPABILITY_SET.hash,
    targets: [
      {
        id: "target-endpoint-a",
        path: "Workspace/EndpointA",
        expectedClass: "BasePart",
      },
      {
        id: "target-endpoint-b",
        path: "Workspace/EndpointB",
        expectedClass: "BasePart",
      },
      {
        id: "target-mover",
        path: "Workspace/Mover",
        expectedClass: "BasePart",
      },
    ],
    calls: [
      {
        id: "call-01-resolve-endpoint-a",
        capability: "instance.resolve",
        targetId: "target-endpoint-a",
      },
      {
        id: "call-02-position-endpoint-a",
        capability: "base_part.position",
        targetId: "target-endpoint-a",
      },
      {
        id: "call-03-resolve-endpoint-b",
        capability: "instance.resolve",
        targetId: "target-endpoint-b",
      },
      {
        id: "call-04-position-endpoint-b",
        capability: "base_part.position",
        targetId: "target-endpoint-b",
      },
      {
        id: "call-05-resolve-mover",
        capability: "instance.resolve",
        targetId: "target-mover",
      },
      {
        id: "call-06-series-mover",
        capability: "base_part.position_series",
        targetId: "target-mover",
        sampleCount: 32,
        intervalMs: 250,
      },
    ],
    budget: { maxExecutionMs: 12_000, maxResultBytes: 64 * 1024 },
    assertions: [
      {
        id: "assert-distinct-positions",
        requirementId: "evaluator-motion-hidden",
        acceptanceAssertionId: "assert-distinct-positions",
        kind: "distinct_positions_at_least",
        observationId: "call-06-series-mover",
        quantizationStuds: 0.5,
        minimumDistinctPositions: 5,
      },
      {
        id: "assert-exists-endpoint-a",
        requirementId: "observation-endpoint-a",
        acceptanceAssertionId: "assert-exists-endpoint-a",
        kind: "exists",
        observationId: "call-01-resolve-endpoint-a",
      },
      {
        id: "assert-exists-endpoint-b",
        requirementId: "observation-endpoint-b",
        acceptanceAssertionId: "assert-exists-endpoint-b",
        kind: "exists",
        observationId: "call-03-resolve-endpoint-b",
      },
      {
        id: "assert-exists-mover",
        requirementId: "observation-mover",
        acceptanceAssertionId: "assert-exists-mover",
        kind: "exists",
        observationId: "call-05-resolve-mover",
      },
      {
        id: "assert-ordered-visits",
        requirementId: "evaluator-motion-hidden",
        acceptanceAssertionId: "assert-ordered-visits",
        kind: "ordered_position_visits",
        seriesObservationId: "call-06-series-mover",
        endpointAObservationId: "call-02-position-endpoint-a",
        endpointBObservationId: "call-04-position-endpoint-b",
        toleranceStuds: 1.5,
        minimumLegMs: 2_000,
        maximumLegMs: 4_000,
        acceptedOrders: [
          ["A", "B", "A"],
          ["B", "A", "B"],
        ],
      },
    ],
  });
  const runtimeEvaluatorConfiguration = createRuntimeEvaluatorConfiguration({
    capabilitySetId: STUDIO_CAPABILITY_SET.id,
    capabilitySetHash: STUDIO_CAPABILITY_SET.hash,
    assertionEngine: { name: "forge_runtime_assertions" },
    runtimeEvalDefinitionId: runtimeEvalDefinition.id,
    runtimeEvalDefinitionHash: runtimeEvalDefinition.hash,
    executionPolicy: "creator_triggered_play_solo",
    bindingPolicy: "candidate_source_and_world_snapshot",
    maxResultBytes: 64 * 1024,
  });
  const integrationConstraints = [
    "observation-endpoint-a",
    "observation-endpoint-b",
    "observation-mover",
  ].map((requirementId) =>
    createIntegrationConstraint({
      requirementSet,
      requirementId,
      projectId: PROJECT_ID,
      projectSnapshotHash: PROJECT_SNAPSHOT_HASH,
    }),
  );
  return {
    creatorPrompt: CREATOR_PROMPT,
    requirementSet,
    acceptanceSpec,
    runtimeEvalDefinition,
    runtimeEvaluatorConfiguration,
    integrationConstraints,
  };
}

async function registration(seedRoot = SEED) {
  const artifacts = treatmentArtifacts();
  return registerExperiment({
    repositoryRoot: resolve("."),
    seedRoot,
    name: "registered-motion",
    hypothesis:
      "A registered source-root treatment can produce a locally eligible candidate and a separately graded Studio runtime outcome.",
    ...artifacts,
    runtime: {
      identity: FORGE_NATIVE_RUNTIME_IDENTITY,
      modelClientDescriptor: OPENROUTER_MODEL_CLIENT_DESCRIPTOR,
    },
    model: "openai/gpt-5.6-luna",
  });
}

test("synthetic registered treatment is evaluator-isolated and fully bound to implemented position capabilities", () => {
  const artifacts = treatmentArtifacts();
  assertRequirementSet(artifacts.requirementSet);
  assertAcceptanceSpec(artifacts.acceptanceSpec);
  assertAcceptanceSpecReferences(
    artifacts.acceptanceSpec,
    artifacts.requirementSet,
  );
  for (const value of artifacts.integrationConstraints) {
    assertIntegrationConstraint(value);
    assertIntegrationConstraintReferences(value, artifacts.requirementSet);
  }
  const builder = resolveRequirementView(artifacts.requirementSet, {
    phase: "build",
    environment: "benchmark",
    audience: "builder",
  });
  const evaluator = resolveRequirementView(artifacts.requirementSet, {
    phase: "evaluate",
    environment: "benchmark",
    audience: "evaluator",
  });
  assert.equal(
    artifacts.runtimeEvalDefinition.requirementSetId,
    artifacts.requirementSet.id,
  );
  assert.equal(artifacts.runtimeEvalDefinition.evaluatorViewId, evaluator.id);
  assert.equal(
    artifacts.runtimeEvalDefinition.evaluatorViewHash,
    contentHash(stableJson(evaluator)),
  );
  assert.equal(
    artifacts.runtimeEvaluatorConfiguration.runtimeEvalDefinitionId,
    artifacts.runtimeEvalDefinition.id,
  );
  const builderJson = stableJson(builder);
  assert.doesNotMatch(
    builderJson,
    /evaluator-motion-hidden|Hidden evaluator motion thresholds/,
  );
  assert.match(builderJson, /Workspace\/Mover/);
});

test("ExperimentRegistration is deterministic, secret-free, and rejects a changed treatment", async () => {
  const first = await registration();
  const second = await registration();
  assert.equal(first.hash, second.hash);
  assert.equal(first.id, second.id);
  assert.equal(first.model.name, "openai/gpt-5.6-luna");
  assert.deepEqual(first.seed.sourceRoots, ["src/server"]);
  assert.equal(first.expected.seedHash, first.seed.hash);
  assert.doesNotMatch(stableJson(first), /OPENROUTER_API_KEY|apiKey|\/Users\//);
  assert.throws(() =>
    assertExperimentRegistration({ ...first, creatorPrompt: "Changed prompt" }),
  );
  assert.throws(() =>
    assertExperimentRegistration({
      ...first,
      model: { ...first.model, name: "openai/gpt-5.6-sol" },
    }),
  );
  assert.throws(() =>
    assertExperimentRegistration({
      ...first,
      budgets: { ...first.budgets, maxTurns: first.budgets.maxTurns + 1 },
    }),
  );
  assert.throws(() =>
    assertExperimentRegistration({
      ...first,
      artifacts: {
        ...first.artifacts,
        requirementSetHash: contentHash("changed"),
      },
    }),
  );
  assert.throws(() =>
    assertExperimentRegistration({
      ...first,
      expected: { ...first.expected, sourceRoots: ["src/shared"] },
    }),
  );
  assert.throws(() =>
    assertExperimentRegistration({
      ...first,
      studio: { ...first.studio, capabilitySetHash: "0".repeat(64) },
    }),
  );
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
        assert.doesNotMatch(
          initial,
          /Hidden evaluator motion thresholds|evaluator-motion-hidden|forge-experiment-test/,
        );
        assert.equal(
          (
            await input.tools.execute("plan.update", {
              goal: "Create the generic controller",
              steps: [
                {
                  id: "create-controller",
                  statement: "Create one server controller",
                  status: "in_progress",
                },
              ],
              status: "active",
            })
          ).ok,
          true,
        );
        assert.equal(
          (
            await input.tools.execute("workspace.write", {
              path: "src/server/Controller.server.luau",
              precondition: { kind: "absent" },
              content:
                'local mover = workspace:WaitForChild("Mover")\nmover.Anchored = true\n',
            })
          ).ok,
          true,
        );
        return {
          status: "completed",
          trialStarted: true,
          usage: {
            turns: 1,
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0,
          },
          timing: { startedAt: "2026-08-31T00:00:00.000Z", endedAt: "2026-08-31T00:00:00.000Z", durationMs: 0 },
          turns: [],
          toolCalls: [],
        };
      },
    };
    const runDirectory = join(root, "runs");
    const result = await runRegisteredExperiment({
      registration: registered,
      repositoryRoot: resolve("."),
      seedRoot: seed,
      runtime,
      runDirectory,
      traceDirectory: join(root, "traces"),
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "locally_eligible");
    assert.equal(result.run.origin.kind, "registered_experiment");
    assert.equal(
      result.run.origin.kind === "registered_experiment" &&
        result.run.origin.experimentRegistrationHash,
      registered.hash,
    );
    assert.equal(
      result.candidateArtifact?.artifact.origin.kind,
      "registered_experiment",
    );
    assert.equal(result.trace.references.experimentRegistrationId, registered.id);
    await writeFile(
      join(seed, "src/server/Drift.server.luau"),
      "return nil\n",
      "utf8",
    );
    calls = 0;
    await assert.rejects(
      () =>
        runRegisteredExperiment({
          registration: registered,
          repositoryRoot: resolve("."),
          seedRoot: seed,
          runtime,
          runDirectory: join(root, "drift-runs"),
          traceDirectory: join(root, "drift-traces"),
        }),
      /drift/i,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic registered evaluator grades an authoritative moving envelope and rejects a static one", () => {
  const { runtimeEvalDefinition: definition } = treatmentArtifacts();
  const plan = createStudioExecutionPlan({
    purpose: "runtime_evaluation",
    capabilitySetId: STUDIO_CAPABILITY_SET.id,
    capabilitySetHash: STUDIO_CAPABILITY_SET.hash,
    binding: {
      runId: "runtime_run_registered_motion",
      correlationId: "runtime_correlation_registered_motion",
      sessionId: "session_registered_motion",
      projectId: PROJECT_ID,
      project: { name: "Registered Motion", placeId: 0, universeId: 0 },
      projectSnapshotHash: "a".repeat(64),
      candidateHash: "b".repeat(64),
    },
    targets: definition.targets,
    calls: definition.calls,
    budget: definition.budget,
  });
  const envelope = (moving: boolean): RuntimeObservationEnvelope => ({
    kind: "RuntimeObservationEnvelope",
    executionPlanId: plan.id,
    executionPlanHash: plan.hash,
    binding: plan.binding,
    nonce: "registered_motion_nonce_0123456789",
    nonceCommitment: contentHash("registered_motion_nonce_0123456789"),
    authoritative: true,
    startedAt: "2026-08-31T00:00:00.000Z",
    endedAt: "2026-08-31T00:00:08.000Z",
    durationMs: 8_000,
    diagnostics: {
      errors: 0,
      warnings: 0,
      messageHashes: [],
      truncated: false,
    },
    results: [
      {
        id: "call-01-resolve-endpoint-a",
        capability: "instance.resolve",
        targetId: "target-endpoint-a",
        status: "resolved",
        path: "Workspace/EndpointA",
        className: "Part",
      },
      {
        id: "call-02-position-endpoint-a",
        capability: "base_part.position",
        targetId: "target-endpoint-a",
        status: "ok",
        position: { x: 0, y: 2, z: 0 },
        elapsedMs: 1,
      },
      {
        id: "call-03-resolve-endpoint-b",
        capability: "instance.resolve",
        targetId: "target-endpoint-b",
        status: "resolved",
        path: "Workspace/EndpointB",
        className: "Part",
      },
      {
        id: "call-04-position-endpoint-b",
        capability: "base_part.position",
        targetId: "target-endpoint-b",
        status: "ok",
        position: { x: 0, y: 20, z: 0 },
        elapsedMs: 2,
      },
      {
        id: "call-05-resolve-mover",
        capability: "instance.resolve",
        targetId: "target-mover",
        status: "resolved",
        path: "Workspace/Mover",
        className: "Part",
      },
      {
        id: "call-06-series-mover",
        capability: "base_part.position_series",
        targetId: "target-mover",
        status: "ok",
        samples: Array.from({ length: 32 }, (_, index) => ({
          sequence: index + 1,
          elapsedMs: index * 250,
          position: {
            x: 0,
            y: moving
              ? index <= 12
                ? 2 + 18 * (index / 12)
                : 20 - 18 * ((index - 12) / 12)
              : 2,
            z: 0,
          },
        })),
      },
    ],
  });
  assert.ok(
    gradeRuntimeObservations(definition, envelope(true)).every(
      (result) => result.status === "pass",
    ),
  );
  assert.ok(
    gradeRuntimeObservations(definition, envelope(false)).some(
      (result) => result.status === "fail",
    ),
  );
});
