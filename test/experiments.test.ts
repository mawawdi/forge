import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeEvalDefinition,
  createRuntimeEvaluatorConfiguration,
  createStudioExecutionPlan,
  gradeRuntimeEvidence,
} from "../packages/studio-capabilities/src/index.js";
import { createStudioEvidenceEnvelope } from "../packages/studio-evidence/src/index.js";

const project = { name: "ExperimentEvidence", placeId: 0, universeId: 0 };
const target = {
  id: "door",
  identity: { kind: "forge_attribute" as const, stableId: "experiment-door" },
  path: "Workspace/Door",
  expectedClass: "BasePart" as const,
};
const calls = [
  { id: "resolve-door", capability: "instance.resolve" as const, targetId: target.id },
  {
    id: "series-door",
    capability: "base_part.position_series" as const,
    targetId: target.id,
    sampleCount: 2,
    intervalMs: 100,
  },
];
const budget = { maxExecutionMs: 1_000, maxResultBytes: 4_096 };

test("runtime experiments grade universal evidence rather than legacy runtime envelopes", () => {
  const definition = createRuntimeEvalDefinition({
    requirementSetId: "requirements",
    evaluatorViewId: "evaluator-view",
    evaluatorViewHash: "a".repeat(64),
    acceptanceSpecId: "acceptance",
    provenance: { source: "evaluator", authority: "evaluation_only", visibility: "evaluator_only" },
    targets: [target],
    calls,
    budget,
    assertions: [
      {
        id: "door-exists",
        requirementId: "door",
        acceptanceAssertionId: "exists",
        kind: "exists",
        observationId: "resolve-door",
      },
      {
        id: "door-moves",
        requirementId: "door",
        acceptanceAssertionId: "moves",
        kind: "distinct_positions_at_least",
        observationId: "series-door",
        quantizationStuds: 1,
        minimumDistinctPositions: 2,
      },
    ],
  });
  const configuration = createRuntimeEvaluatorConfiguration({
    assertionEngine: { name: "forge_runtime_assertions" },
    runtimeEvalDefinitionId: definition.id,
    runtimeEvalDefinitionHash: definition.hash,
    executionPolicy: "creator_triggered_play_solo",
    bindingPolicy: "candidate_source_and_world_state",
    maxResultBytes: budget.maxResultBytes,
  });
  assert.equal(configuration.runtimeEvalDefinitionHash, definition.hash);
  const executionPlan = createStudioExecutionPlan({
    purpose: "runtime_evaluation",
    binding: {
      runId: "runtime-run",
      correlationId: "runtime-correlation",
      sessionId: "studio-session",
      projectId: "studio-project",
      project,
      projectRevisionHash: "b".repeat(64),
      candidateHash: "c".repeat(64),
    },
    targets: [target],
    calls,
    budget,
    observationWindowMs: 0,
  });
  const envelope = createStudioEvidenceEnvelope(
    {
      manifestHash: executionPlan.manifestHash,
      projectionId: executionPlan.evidenceProjection.id,
      projectionHash: executionPlan.evidenceProjection.contentHash,
      bindingHash: executionPlan.evidenceProjection.bindingHash,
      project,
      authoritative: true,
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      completion: "complete",
      facts: executionPlan.evidenceProjection.requirements.map((requirement) =>
        requirement.kind === "runtime_resolution"
          ? {
              kind: "runtime_resolution" as const,
              key: requirement.key,
              target: requirement.target,
              callId: requirement.callId!,
              runtimeTargetId: requirement.runtimeTargetId!,
              capability: "instance.resolve" as const,
              result: {
                status: "observed" as const,
                value: { path: target.path, className: "Part" },
              },
            }
          : {
              kind: "position_series" as const,
              key: requirement.key,
              target: requirement.target,
              callId: requirement.callId!,
              runtimeTargetId: requirement.runtimeTargetId!,
              capability: "base_part.position_series" as const,
              result: {
                status: "observed" as const,
                value: [
                  { sequence: 0, elapsedMs: 0, value: { x: 0, y: 0, z: 0 } },
                  { sequence: 1, elapsedMs: 100, value: { x: 2, y: 0, z: 0 } },
                ],
              },
            },
      ),
    },
    executionPlan.evidenceProjection,
  );
  assert.deepEqual(
    gradeRuntimeEvidence(definition, envelope, executionPlan.evidenceProjection).map(
      (result) => result.status,
    ),
    ["pass", "pass"],
  );
});
