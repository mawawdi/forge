import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  advanceSession,
  assertCreatorBuildContract,
  canonicalizeCreatorPropertyInput,
  createCreatorPlan,
  assertCreatorSessionBundle,
  createCreatorSession,
  createStudioOwnershipMap,
  type CreatorSessionBundle,
} from "../packages/creator-session/src/index.js";
import { restoredCreatorControlDetail } from "../packages/creator-session/src/coordinator.js";
import type { StudioProjectState } from "../packages/studio-evidence/src/index.js";

const revisionHash = contentHash("initial evidence revision");
const observation: StudioProjectState = {
  project: { name: "EvidenceFirst", placeId: 0, universeId: 0 },
  instances: [
    {
      stableId: "workspace",
      path: "Workspace",
      className: "Workspace",
      properties: {},
      attributes: {},
      tags: [],
    },
  ],
  scripts: [],
  remotes: [],
};

test("creator session history is bound to explicit project-state evidence", () => {
  const ownership = createStudioOwnershipMap({
    projectId: "project-evidence-first",
    revisionHash,
    observation,
  });
  const session = createCreatorSession({
    prompt: "Create a closed evidence test.",
    projectId: ownership.projectId,
    revisionHash,
    ownership,
    now: new Date("2026-09-01T00:00:00.000Z"),
  });
  const incomplete = advanceSession(session, {
    status: "incomplete",
    failure: {
      code: "control_process_interrupted",
      detail: "No Studio value was inferred after the interruption.",
    },
    now: new Date("2026-09-01T00:00:01.000Z"),
  });
  const bundle: CreatorSessionBundle = {
    session: incomplete,
    ownership,
    observation,
    observationHistory: [{ revisionHash, observation }],
    buildContracts: [],
    approvals: [],
    changeSets: [],
    mutationAttempts: [],
    verifications: [],
    agentRuns: [],
  };
  assert.doesNotThrow(() => assertCreatorSessionBundle(bundle));
  assert.equal(bundle.session.failure?.code, "control_process_interrupted");
  assert.notEqual(bundle.session.failure?.detailHash, contentHash(""));
  const restoredDetail = restoredCreatorControlDetail(bundle);
  assert.match(restoredDetail, /control process interrupted/i);
  assert.match(restoredDetail, /no mutation-attempt or verification evidence/i);
  assert.match(restoredDetail, /start a new request to retry/i);
  assert.doesNotMatch(restoredDetail, /session ready/i);
});

test("creator plans reserve enough Play Solo time for a human-triggered observation", () => {
  const runtimeObservation: StudioProjectState = {
    project: { name: "Creator Runtime Window", placeId: 0, universeId: 0 },
    instances: [
      { stableId: "workspace", path: "Workspace", className: "Workspace", properties: {}, attributes: {}, tags: [] },
      { stableId: "door", path: "Workspace/Door", className: "Part", properties: {}, attributes: {}, tags: [] },
    ],
    scripts: [],
    remotes: [],
  };
  const runtimeRevision = contentHash("creator runtime window revision");
  const runtimeOwnership = createStudioOwnershipMap({
    projectId: "creator-runtime-window-project",
    revisionHash: runtimeRevision,
    observation: runtimeObservation,
  });
  const creatorPrompt = "Make the door respond to a creator-triggered interaction.";
  const input = {
    sessionId: "creator-runtime-window-session",
    promptHash: contentHash(creatorPrompt),
    projectRevisionHash: runtimeRevision,
    ownershipMapId: runtimeOwnership.id,
    ownershipMapHash: runtimeOwnership.hash,
    creatorPrompt,
    inspectionPaths: ["Workspace/Door"],
    steps: [{ id: "update-door-step", statement: "Update and verify the door.", changeIds: ["update-door"] }],
    changes: [{ id: "update-door", kind: "update" as const, path: "Workspace/Door", expectedClass: "Part" as const }],
    charter: {
      clauses: [
        { id: "door-exists", kind: "studio_check" as const, check: "instance_exists" as const, path: "Workspace/Door", expectedClass: "BasePart" as const },
        { id: "door-series", kind: "studio_check" as const, check: "position_series" as const, path: "Workspace/Door", expectedClass: "BasePart" as const, sampleCount: 2, intervalMs: 100, quantizationStuds: 0.25, minimumDistinctPositions: 2 },
        { id: "diagnostics", kind: "studio_check" as const, check: "playtest_diagnostics" as const, maximumErrors: 0, maximumWarnings: 10 },
      ],
    },
  };
  assert.throws(
    () => createCreatorPlan(input, runtimeObservation, runtimeOwnership),
    /must span at least 15000 ms/,
  );
  assert.doesNotThrow(() => createCreatorPlan({
    ...input,
    charter: {
      clauses: input.charter.clauses.map((clause) =>
        clause.id === "door-series" ? { ...clause, sampleCount: 16, intervalMs: 1_000 } : clause,
      ),
    },
  }, runtimeObservation, runtimeOwnership));
});

test("creator property inputs reach every proof-closed manifest codec", () => {
  const cases = [
    ["Attachment", "Axis", { x: 1, y: 0, z: 0 }, "vector3_f32"],
    ["Attachment", "CFrame", { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 } }, "cframe_f32x12"],
    ["Attachment", "Visible", false, "boolean"],
    ["Beam", "Attachment0", { stableId: "attachment-a", path: "Workspace/AttachmentA", className: "Attachment" }, "instance_ref"],
    ["Beam", "Brightness", 0.5, "number_f32"],
    ["Beam", "Color", { keypoints: [{ time: 0, color: { r: 1, g: 0, b: 0 } }, { time: 1, color: { r: 0, g: 0, b: 1 } }] }, "color_sequence"],
    ["Beam", "Transparency", { keypoints: [{ time: 0, value: 0, envelope: 0 }, { time: 1, value: 1, envelope: 0 }] }, "number_sequence"],
    ["Color3Value", "Value", { r: 0.5, g: 0.25, b: 1 }, "color3_rgb8"],
    ["Decal", "UVOffset", { x: 0.25, y: -0.5 }, "vector2_f32"],
    ["Decal", "ZIndex", 2, "int32"],
    ["Frame", "Position", { x: { scale: 0.5, offset: 4 }, y: { scale: 1, offset: -2 } }, "udim2"],
    ["ImageLabel", "SliceCenter", { min: { x: 0, y: 0 }, max: { x: 16, y: 16 } }, "rect"],
    ["IntValue", "Value", "9007199254740991", "int64_decimal"],
    ["NumberValue", "Value", Math.PI, "number_f64"],
    ["Part", "CollisionGroup", "Default", "string_utf8"],
    ["Part", "Material", "Plastic", "enum_name"],
    ["ParticleEmitter", "Lifetime", { min: 0.5, max: 2 }, "number_range"],
  ] as const;

  for (const [className, propertyName, value, expectedKind] of cases) {
    const canonical = canonicalizeCreatorPropertyInput({
      className,
      propertyName,
      value,
    });
    assert.equal(canonical.kind, expectedKind, `${className}.${propertyName}`);
    if (expectedKind === "instance_ref") assert.equal(canonical.kind === "instance_ref" && canonical.state, "reference");
  }
  const nilReference = canonicalizeCreatorPropertyInput({ className: "ObjectValue", propertyName: "Value", value: null });
  assert.deepEqual(nilReference, { kind: "instance_ref", state: "nil", expectedClass: "Instance" });
  assert.throws(
    () =>
      canonicalizeCreatorPropertyInput({
        className: "Part",
        propertyName: "Material",
        value: "NotAMaterial",
      }),
    /allowlist|one of/i,
  );
});

test("immutable build contracts validate their sealed policy rather than today's global manifest", () => {
  const propertyPolicy = {
    allowedProperties: [],
    attributes: "primitive" as const,
    source: "forbidden" as const,
  };
  const payload = {
    sessionId: "creator_session_policy_snapshot",
    promptHash: contentHash("prompt"),
    planId: "creator_plan_policy_snapshot",
    planHash: contentHash("plan"),
    planApprovalId: "creator_approval_policy_snapshot",
    planApprovalHash: contentHash("approval"),
    ownershipMapId: "studio_ownership_policy_snapshot",
    ownershipMapHash: contentHash("ownership"),
    initialRevisionHash: contentHash("revision"),
    initialInspectionPaths: ["Workspace"],
    propertyPolicies: { Folder: propertyPolicy },
    changes: [
      {
        planChangeId: "create_folder",
        operationId: "creator_operation_policy_snapshot",
        kind: "create" as const,
        path: "Workspace/NewFolder",
        parentPath: "Workspace",
        name: "NewFolder",
        className: "Folder" as const,
        tempId: "creator_temp_policy_snapshot",
        propertyPolicy,
      },
    ],
  };
  const hash = contentHash(stableJson(payload));
  assert.doesNotThrow(() =>
    assertCreatorBuildContract({
      kind: "CreatorBuildContract",
      id: `creator_build_contract_${hash.slice(0, 24)}`,
      hash,
      ...payload,
    }),
  );
});
