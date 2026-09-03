import assert from "node:assert/strict";
import test from "node:test";
import {
  createCharterExecution,
  gradeRuntimeCharter,
} from "../packages/creator-session/src/verification.js";
import { createStudioExecutionPlan } from "../packages/studio-capabilities/src/index.js";
import {
  compileRuntimeEvidenceProjection,
  createStudioEvidenceEnvelope,
  type StudioEvidenceEnvelope,
  type StudioEvidenceProjection,
  type StudioProjectIndexMetadataView,
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

const verificationProjectIndex: StudioProjectIndexMetadataView = {
  project,
  revision: {
    hash: "a".repeat(64),
  } as StudioProjectIndexMetadataView["revision"],
  instances: [
    {
      objectId: "forge_attribute:workspace",
      identity: { kind: "forge_attribute", stableId: "workspace" },
      path: "Workspace",
      name: "Workspace",
      engineContainer: { path: "Workspace", className: "Workspace" },
      className: "Workspace",
      properties: {},
      attributes: {},
      tags: [],
    },
    {
      objectId: "forge_attribute:door",
      identity: { kind: "forge_attribute", stableId: "door" },
      path: "Workspace/Door",
      name: "Door",
      parentIdentity: { kind: "forge_attribute" as const, stableId: "workspace" },
      className: "Part",
      properties: {},
      attributes: {},
      tags: [],
    },
  ],
  scripts: [],
};

function runtimeEvidence(moving: boolean): {
  projection: StudioEvidenceProjection;
  envelope: StudioEvidenceEnvelope;
} {
  const execution = createCharterExecution(clauses, verificationProjectIndex);
  const target = {
    kind: "instance" as const,
    identity: { kind: "forge_attribute" as const, stableId: "door" },
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
            result: {
              status: "observed" as const,
              value: { path: "Workspace/Door", className: "Part" },
            },
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
              {
                sequence: 1,
                elapsedMs: 100,
                value: { x: moving ? 2 : 0, y: 0, z: 0 },
              },
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
  assert.deepEqual(gradeRuntimeCharter(clauses, runtimeEvidence(false).envelope), [
    "The door moves through distinct positions.",
  ]);
});

test("creator charter targets retain one canonical order beyond nine targets", () => {
  const manyClauses: VerificationCharterClause[] = Array.from({ length: 12 }, (_, index) => ({
    id: `exists-${index + 1}`,
    kind: "studio_check" as const,
    check: "instance_exists" as const,
    statement: `Target ${index + 1} exists.`,
    path: `Workspace/Target${String(index + 1).padStart(2, "0")}`,
    expectedClass: "Folder" as const,
  }));
  const manyProjectIndex: StudioProjectIndexMetadataView = {
    project,
    revision: {
      hash: "b".repeat(64),
    } as StudioProjectIndexMetadataView["revision"],
    instances: [
      {
        objectId: "forge_attribute:workspace",
        identity: { kind: "forge_attribute" as const, stableId: "workspace" },
        path: "Workspace",
        name: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
        className: "Workspace",
        properties: {},
        attributes: {},
        tags: [],
      },
      ...manyClauses.map((_clause, index) => ({
        objectId: `forge_attribute:target-${index + 1}`,
        identity: {
          kind: "forge_attribute" as const,
          stableId: `target-${index + 1}`,
        },
        path: `Workspace/Target${String(index + 1).padStart(2, "0")}`,
        name: `Target${String(index + 1).padStart(2, "0")}`,
        parentIdentity: { kind: "forge_attribute" as const, stableId: "workspace" },
        className: "Folder",
        properties: {},
        attributes: {},
        tags: [],
      })),
    ],
    scripts: [],
  };
  const execution = createCharterExecution(manyClauses, manyProjectIndex);
  const plan = createStudioExecutionPlan({
    purpose: "creator_verification",
    binding: {
      runId: "creator-many-targets",
      correlationId: "creator-many-targets-correlation",
      sessionId: "creator-many-targets-session",
      projectId: "creator-many-targets-project",
      project,
      projectRevisionHash: "b".repeat(64),
    },
    targets: execution.targets,
    calls: execution.calls,
    budget: { maxExecutionMs: 1_000, maxResultBytes: 16_384 },
    observationWindowMs: 0,
  });

  assert.deepEqual(plan.targets, execution.targets);
  assert.deepEqual(
    execution.targets.map((target) => target.id),
    [
      "creator_target_1",
      "creator_target_10",
      "creator_target_11",
      "creator_target_12",
      "creator_target_2",
      "creator_target_3",
      "creator_target_4",
      "creator_target_5",
      "creator_target_6",
      "creator_target_7",
      "creator_target_8",
      "creator_target_9",
    ],
  );
});
