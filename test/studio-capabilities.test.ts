import assert from "node:assert/strict";
import test from "node:test";
import {
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioEvidenceEnvelope,
  runtimeResultsFromEvidence,
  type StudioEvidenceFact,
} from "../packages/studio-evidence/src/index.js";
import {
  assertRuntimeEvidence,
  createRuntimeEvalDefinition,
  createStudioExecutionPlan,
  gradeRuntimeEvidence,
} from "../packages/studio-capabilities/src/index.js";

const hash = "a".repeat(64);
const project = { name: "Evidence Runtime", placeId: 1, universeId: 2 };

function plan() {
  return createStudioExecutionPlan({
    purpose: "runtime_evaluation",
    binding: {
      runId: "runtime-run", correlationId: "runtime-correlation", sessionId: "runtime-session", projectId: "runtime-project", project,
      projectStateRevisionHash: hash, candidateHash: "b".repeat(64),
    },
    targets: [{ id: "door", path: "Workspace/Door", expectedClass: "BasePart" }],
    calls: [
      { id: "resolve-door", capability: "instance.resolve", targetId: "door" },
      { id: "sample-door", capability: "base_part.position_series", targetId: "door", sampleCount: 3, intervalMs: 100 },
    ],
    budget: { maxExecutionMs: 1_000, maxResultBytes: 4_096 },
    observationWindowMs: 0,
  });
}

function observedRuntimeFacts(): StudioEvidenceFact[] {
  return [
    {
      kind: "runtime_resolution", key: "runtime_resolution:door@Workspace/Door:BasePart:resolve-door", target: { kind: "instance", stableId: "door", path: "Workspace/Door", className: "BasePart" },
      callId: "resolve-door", runtimeTargetId: "door", capability: "instance.resolve", result: { status: "observed", value: { path: "Workspace/Door", className: "Part" } },
    },
    {
      kind: "position_series", key: "position_series:door@Workspace/Door:BasePart:sample-door", target: { kind: "instance", stableId: "door", path: "Workspace/Door", className: "BasePart" },
      callId: "sample-door", runtimeTargetId: "door", capability: "base_part.position_series", result: { status: "observed", value: [
        { sequence: 0, elapsedMs: 0, value: { x: 0, y: 4, z: 0 } },
        { sequence: 1, elapsedMs: 100, value: { x: 4, y: 4, z: 0 } },
        { sequence: 2, elapsedMs: 200, value: { x: 8, y: 4, z: 0 } },
      ] },
    },
  ];
}

test("runtime plans compile the manifest-bound evidence projection", () => {
  const executionPlan = plan();
  assert.equal(executionPlan.manifestHash, STUDIO_CAPABILITY_MANIFEST_HASH);
  assert.equal(executionPlan.evidenceProjection.manifestHash, STUDIO_CAPABILITY_MANIFEST_HASH);
  assert.deepEqual(executionPlan.evidenceProjection.requirements.map((requirement) => requirement.kind), ["position_series", "runtime_resolution"]);
});

test("fixed runtime property observations stay inside the generated manifest", () => {
  const executionPlan = createStudioExecutionPlan({
    purpose: "runtime_evaluation",
    binding: {
      runId: "runtime-property-run", correlationId: "runtime-property-correlation", sessionId: "runtime-property-session", projectId: "runtime-property-project", project,
      projectStateRevisionHash: hash,
    },
    targets: [{ id: "label", path: "StarterGui/Hud/Label", expectedClass: "TextLabel" }],
    calls: [
      { id: "resolve-label", capability: "instance.resolve", targetId: "label" },
      { id: "read-label-text", capability: "instance.property", targetId: "label", propertyName: "Text" },
      { id: "sample-label-transparency", capability: "instance.property_series", targetId: "label", propertyName: "TextTransparency", sampleCount: 2, intervalMs: 100 },
    ],
    budget: { maxExecutionMs: 1_000, maxResultBytes: 4_096 },
    observationWindowMs: 0,
  });
  assert.deepEqual(executionPlan.calls.map((call) => call.capability), ["instance.resolve", "instance.property", "instance.property_series"]);
  assert.deepEqual(executionPlan.evidenceProjection.requirements.map((requirement) => [requirement.kind, requirement.propertyName]), [["runtime_property", "Text"], ["runtime_property_series", "TextTransparency"], ["runtime_resolution", undefined]]);
  assert.throws(() => createStudioExecutionPlan({
    ...executionPlan,
    binding: { ...executionPlan.binding, runId: "runtime-property-invalid", correlationId: "runtime-property-invalid-correlation" },
    calls: [{ id: "resolve-label", capability: "instance.resolve", targetId: "label" }, { id: "read-reference", capability: "instance.property", targetId: "label", propertyName: "Parent" }],
  }), /manifest property is not observable/);
});

test("creator verification plans retain their distinct projection purpose", () => {
  const runtimePlan = plan();
  const creatorPlan = createStudioExecutionPlan({
    purpose: "creator_verification",
    binding: {
      ...runtimePlan.binding,
      runId: "creator-verification-run",
      correlationId: "creator-verification-correlation",
    },
    targets: runtimePlan.targets,
    calls: runtimePlan.calls,
    budget: runtimePlan.budget,
    observationWindowMs: 0,
  });
  assert.equal(creatorPlan.evidenceProjection.purpose, "creator_verification");
});

test("runtime plans canonicalize dependency order before validating calls", () => {
  const executionPlan = createStudioExecutionPlan({
    purpose: "creator_verification",
    binding: {
      runId: "dependency-order-run",
      correlationId: "dependency-order-correlation",
      sessionId: "dependency-order-session",
      projectId: "dependency-order-project",
      project,
      projectStateRevisionHash: hash,
    },
    targets: [
      { id: "target-b", path: "Workspace/DoorB", expectedClass: "BasePart" },
      { id: "target-a", path: "Workspace/DoorA", expectedClass: "BasePart" },
    ],
    calls: [
      { id: "series-a", capability: "base_part.position_series", targetId: "target-a", sampleCount: 16, intervalMs: 1_000 },
      { id: "resolve-b", capability: "instance.resolve", targetId: "target-b" },
      { id: "resolve-a", capability: "instance.resolve", targetId: "target-a" },
    ],
    budget: { maxExecutionMs: 20_000, maxResultBytes: 4_096 },
    observationWindowMs: 15_000,
  });
  assert.deepEqual(
    executionPlan.calls.map((call) => call.id),
    ["resolve-a", "resolve-b", "series-a"],
  );
  assert.equal(executionPlan.observationWindowMs, 15_000);
});

test("runtime plans reject an observation window outside the execution budget", () => {
  const runtimePlan = plan();
  assert.throws(
    () => createStudioExecutionPlan({
      purpose: "creator_verification",
      binding: {
        ...runtimePlan.binding,
        runId: "impossible-window-run",
        correlationId: "impossible-window-correlation",
      },
      targets: runtimePlan.targets,
      calls: runtimePlan.calls,
      budget: { maxExecutionMs: 10_000, maxResultBytes: 4_096 },
      observationWindowMs: 15_000,
    }),
    /observation window exceeds execution budget/,
  );
});

test("creator position evidence must cover the whole creator observation window", () => {
  const runtimePlan = plan();
  assert.throws(
    () => createStudioExecutionPlan({
      purpose: "creator_verification",
      binding: {
        ...runtimePlan.binding,
        runId: "short-series-run",
        correlationId: "short-series-correlation",
      },
      targets: runtimePlan.targets,
      calls: runtimePlan.calls,
      budget: { maxExecutionMs: 20_000, maxResultBytes: 4_096 },
      observationWindowMs: 15_000,
    }),
    /position series ends before the creator observation window/,
  );
});

test("runtime grading consumes complete runtime evidence rather than a snapshot envelope", () => {
  const executionPlan = plan();
  const envelope = createStudioEvidenceEnvelope({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionId: executionPlan.evidenceProjection.id,
    projectionHash: executionPlan.evidenceProjection.contentHash,
    bindingHash: executionPlan.evidenceProjection.bindingHash,
    project,
    authoritative: true,
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:00:01.000Z",
    completion: "complete",
    facts: observedRuntimeFacts(),
  }, executionPlan.evidenceProjection);
  assertRuntimeEvidence(executionPlan, envelope);
  const definition = createRuntimeEvalDefinition({
    requirementSetId: "runtime-requirements", evaluatorViewId: "runtime-view", evaluatorViewHash: hash, acceptanceSpecId: "runtime-acceptance",
    provenance: { source: "evaluator", authority: "evaluation_only", visibility: "evaluator_only" },
    targets: executionPlan.targets,
    calls: executionPlan.calls,
    budget: executionPlan.budget,
    assertions: [
      { id: "door-exists", requirementId: "door", acceptanceAssertionId: "exists", kind: "exists", observationId: "resolve-door" },
      { id: "door-moves", requirementId: "door", acceptanceAssertionId: "moves", kind: "distinct_positions_at_least", observationId: "sample-door", quantizationStuds: 1, minimumDistinctPositions: 3 },
    ],
  });
  assert.deepEqual(gradeRuntimeEvidence(definition, envelope, executionPlan.evidenceProjection).map((result) => result.status), ["pass", "pass"]);
});

test("unavailable runtime facts cannot be promoted to a matched projection", () => {
  const executionPlan = plan();
  const unavailable = createStudioEvidenceEnvelope({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionId: executionPlan.evidenceProjection.id,
    projectionHash: executionPlan.evidenceProjection.contentHash,
    bindingHash: executionPlan.evidenceProjection.bindingHash,
    project,
    authoritative: true,
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:00:01.000Z",
    completion: "incomplete",
    facts: observedRuntimeFacts().map((fact) => fact.kind === "position_series" ? { ...fact, result: { status: "unavailable" as const, code: "play_solo_unavailable" } } : fact),
  });
  // An incomplete envelope is valid evidence of an unavailable read, but it
  // must not turn into a fabricated matched/observed runtime result.
  assertRuntimeEvidence(executionPlan, unavailable);
  assert.deepEqual(runtimeResultsFromEvidence(unavailable, executionPlan.evidenceProjection).find((result) => result.id === "sample-door"), { id: "sample-door", capability: "base_part.position_series", targetId: "door", status: "unavailable" });
});
