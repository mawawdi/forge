import assert from "node:assert/strict";
import test from "node:test";
import {
  createCharterExecution,
  gradeRuntimeCharter,
} from "../packages/creator-session/src/verification.js";
import {
  compileRuntimeEvidenceProjection,
  createStudioEvidenceEnvelope,
  type StudioEvidenceEnvelope,
  type StudioEvidenceProjection,
} from "../packages/studio-evidence/src/index.js";
import type { VerificationCharterClause } from "../packages/creator-session/src/index.js";

const project = { name: "VerificationEvidence", placeId: 0, universeId: 0 };
const clauses: VerificationCharterClause[] = [
  {
    id: "exists",
    kind: "studio_check",
    check: "instance_exists",
    statement: "The door exists.",
    path: "Workspace/Door",
    expectedClass: "BasePart",
  },
  {
    id: "moves",
    kind: "studio_check",
    check: "position_series",
    statement: "The door moves through distinct positions.",
    path: "Workspace/Door",
    expectedClass: "BasePart",
    sampleCount: 2,
    intervalMs: 100,
    quantizationStuds: 1,
    minimumDistinctPositions: 2,
  },
];

function runtimeEvidence(moving: boolean): {
  projection: StudioEvidenceProjection;
  envelope: StudioEvidenceEnvelope;
} {
  const execution = createCharterExecution(clauses);
  const target = {
    kind: "instance" as const,
    stableId: "door",
    path: "Workspace/Door",
    className: "BasePart",
  };
  const projection = compileRuntimeEvidenceProjection({
    id: "creator-verification-runtime",
    project,
    binding: { sessionId: "creator-session", revisionHash: "a".repeat(64) },
    calls: execution.calls.map((call) => ({
      id: call.id,
      targetId: call.targetId,
      target,
      capability: call.capability,
    })),
    purpose: "creator_verification",
  });
  const envelope = createStudioEvidenceEnvelope(
    {
      manifestHash: projection.manifestHash,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      bindingHash: projection.bindingHash,
      project,
      authoritative: true,
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      completion: "complete",
      facts: projection.requirements.map((requirement) => {
        if (requirement.kind === "runtime_resolution")
          return {
            kind: "runtime_resolution" as const,
            key: requirement.key,
            target: requirement.target,
            callId: requirement.callId!,
            runtimeTargetId: requirement.runtimeTargetId!,
            capability: "instance.resolve" as const,
            result: { status: "observed" as const, value: { path: "Workspace/Door", className: "Part" } },
          };
        return {
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
              { sequence: 1, elapsedMs: 100, value: { x: moving ? 2 : 0, y: 0, z: 0 } },
            ],
          },
        };
      }),
    },
    projection,
  );
  return { projection, envelope };
}

test("creator runtime charter grading consumes only projection-bound envelopes", () => {
  assert.deepEqual(gradeRuntimeCharter(clauses, runtimeEvidence(true).envelope), []);
  assert.deepEqual(
    gradeRuntimeCharter(clauses, runtimeEvidence(false).envelope),
    ["The door moves through distinct positions."],
  );
});
