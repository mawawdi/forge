import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  advanceSession,
  createCreatorControlView,
  createCreatorSession,
  createStudioOwnershipMap,
  type CreatorChangeSet,
  type CreatorPlan,
  type CreatorSessionBundle,
  type StudioChangeOperation,
} from "../packages/creator-session/src/index.js";
import {
  createPlanReviewPresentation,
  reconcileAppliedChangeSet,
} from "../packages/creator-session/src/coordinator.js";
import type { StudioSnapshotObservation } from "../packages/semantic-map/src/index.js";

const REVISION = contentHash("coordinator-closure-revision");
const PROMPT =
  "Create a runtime controller and keep the existing generator unchanged.";
const OBSERVATION: StudioSnapshotObservation = {
  kind: "StudioSnapshotObservation",
  project: { name: "CoordinatorClosure", placeId: 0, universeId: 0 },
  capturedAt: "2026-08-31T00:00:00.000Z",
  instances: [
    {
      stableId: "workspace",
      path: "Workspace",
      className: "Workspace",
      properties: [],
      attributes: [],
      tags: [],
    },
    {
      stableId: "generator",
      path: "Workspace/Generator",
      className: "Part",
      properties: [{ name: "Anchored", value: true }],
      attributes: [],
      tags: [],
    },
  ],
  scripts: [],
  remotes: [],
};

function planBundle(): CreatorSessionBundle {
  const ownership = createStudioOwnershipMap({
    projectId: "studio_project_coordinator_closure",
    revisionHash: REVISION,
    observation: OBSERVATION,
  });
  const initial = createCreatorSession({
    prompt: PROMPT,
    projectId: ownership.projectId,
    revisionHash: REVISION,
    ownership,
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
  const clauses = [
    {
      id: "controller_exists",
      kind: "studio_check" as const,
      check: "instance_exists" as const,
      statement:
        "Workspace/StatusBeaconController resolves as Script during the approved playtest.",
      path: "Workspace/StatusBeaconController",
      expectedClass: "Script" as const,
    },
    {
      id: "syntax",
      kind: "local_check" as const,
      check: "luau_syntax" as const,
      statement:
        "Every staged Luau source passes the bounded local Luau syntax and analysis gate.",
    },
    {
      id: "diagnostics",
      kind: "studio_check" as const,
      check: "playtest_diagnostics" as const,
      statement:
        "The complete approved playtest emits at most 0 errors and 0 warnings; diagnostic capture must not truncate.",
      maximumErrors: 0,
      maximumWarnings: 0,
    },
    {
      id: "review_runtime",
      kind: "creator_review" as const,
      statement:
        "Confirm the controller performs the requested runtime behavior.",
    },
  ];
  const charterPayload = {
    visibility: "creator_visible" as const,
    authority: "creator_approved_hypothesis" as const,
    clauses,
  };
  const charterHash = contentHash(stableJson(charterPayload));
  const planPayload = {
    sessionId: initial.id,
    promptHash: initial.promptHash,
    projectRevisionHash: REVISION,
    projectStateHash: contentHash(
      stableJson({
        project: OBSERVATION.project,
        instances: OBSERVATION.instances,
        scripts: OBSERVATION.scripts,
        remotes: OBSERVATION.remotes,
      }),
    ),
    ownershipMapId: ownership.id,
    ownershipMapHash: ownership.hash,
    goal: PROMPT,
    inspectionPaths: ["Workspace/Generator"],
    steps: [
      {
        id: "create_controller",
        statement: "Create the controller at its exact approved path.",
        changeIds: ["create_controller"],
      },
    ],
    changes: [
      {
        id: "create_controller",
        kind: "create" as const,
        path: "Workspace/StatusBeaconController",
        className: "Script" as const,
        initialization: "inline_source_required" as const,
      },
    ],
    charter: {
      kind: "VerificationCharter" as const,
      id: `verification_charter_${charterHash.slice(0, 24)}`,
      hash: charterHash,
      ...charterPayload,
    },
  };
  const planHash = contentHash(stableJson(planPayload));
  const plan: CreatorPlan = {
    kind: "CreatorPlan",
    id: `creator_plan_${planHash.slice(0, 24)}`,
    hash: planHash,
    ...planPayload,
  };
  const session = advanceSession(initial, {
    status: "awaiting_plan_approval",
    plan,
  });
  return {
    session,
    ownership,
    observation: OBSERVATION,
    observationHistory: [{ revisionHash: REVISION, observation: OBSERVATION }],
    plan,
    buildContracts: [],
    approvals: [],
    changeSets: [],
    verifications: [],
    agentRuns: [],
  };
}

test("plan review presentation binds the exact private creator request and exposes generated closure facts", () => {
  const bundle = planBundle();
  const presentation = createPlanReviewPresentation(bundle, PROMPT) as {
    creatorRequest: { text: string; promptHash: string };
    changes: Array<{
      id: string;
      summary: string;
      initializationCommitments: string[];
    }>;
    outputCheckCoverage: Array<{
      changeId: string;
      path: string;
      className: string;
      clauseIds: string[];
      covered: boolean;
    }>;
    machineCheckClauses: Array<{ id: string }>;
    creatorReviewClauses: Array<{ id: string; statement: string }>;
  };
  assert.deepEqual(presentation.creatorRequest, {
    text: PROMPT,
    promptHash: bundle.session.promptHash,
  });
  assert.match(
    presentation.changes[0]!.summary,
    /Create Script at Workspace\/StatusBeaconController/,
  );
  assert.match(
    presentation.changes[0]!.initializationCommitments.join("\n"),
    /inline source/,
  );
  assert.deepEqual(presentation.outputCheckCoverage, [
    {
      changeId: "create_controller",
      path: "Workspace/StatusBeaconController",
      className: "Script",
      clauseIds: ["controller_exists"],
      covered: true,
    },
  ]);
  assert.deepEqual(
    presentation.machineCheckClauses.map((clause) => clause.id),
    ["controller_exists", "syntax", "diagnostics"],
  );
  assert.deepEqual(presentation.creatorReviewClauses, [
    {
      id: "review_runtime",
      statement:
        "Confirm the controller performs the requested runtime behavior.",
    },
  ]);
  assert.throws(
    () => createPlanReviewPresentation(bundle, `${PROMPT} changed`),
    /does not match/,
  );
  const view = createCreatorControlView({
    creatorSessionId: bundle.session.id,
    creatorSessionHash: bundle.session.hash,
    status: bundle.session.status,
    title: "Review Plan",
    detail: "Review the exact plan.",
    artifact: {
      kind: "plan",
      id: bundle.plan!.id,
      hash: bundle.plan!.hash,
      presentation,
      presentationHash: contentHash(stableJson(presentation)),
    },
    primaryAction: {
      id: "approve_plan",
      label: "Approve Plan",
      intent: "primary",
    },
    secondaryAction: {
      id: "reject_plan",
      label: "Reject",
      intent: "secondary",
    },
  });
  const alteredPresentation = {
    ...presentation,
    creatorRequest: {
      ...presentation.creatorRequest,
      text: "different request",
    },
  };
  const altered = createCreatorControlView({
    creatorSessionId: bundle.session.id,
    creatorSessionHash: bundle.session.hash,
    status: bundle.session.status,
    title: "Review Plan",
    detail: "Review the exact plan.",
    artifact: {
      kind: "plan",
      id: bundle.plan!.id,
      hash: bundle.plan!.hash,
      presentation: alteredPresentation,
      presentationHash: contentHash(stableJson(alteredPresentation)),
    },
    primaryAction: {
      id: "approve_plan",
      label: "Approve Plan",
      intent: "primary",
    },
    secondaryAction: {
      id: "reject_plan",
      label: "Reject",
      intent: "secondary",
    },
  });
  assert.notEqual(
    view.hash,
    altered.hash,
    "the creator request is part of the hash-bound view",
  );
});

test("post-apply reconciliation rejects a created script whose observed source hash differs from the approved inline source", () => {
  const bundle = planBundle();
  const plan = bundle.plan!;
  const source = "return 'approved'\n";
  const operation: StudioChangeOperation = {
    id: "create-controller",
    planChangeId: "create_controller",
    kind: "create",
    tempId: "controller",
    parentPath: "Workspace",
    className: "Script",
    name: "StatusBeaconController",
    properties: {},
    attributes: {},
    source,
  };
  const changeSet: CreatorChangeSet = {
    kind: "CreatorChangeSet",
    id: "creator_change_set_coordinator_closure",
    hash: contentHash("coordinator-closure-change-set"),
    sessionId: bundle.session.id,
    attempt: 1,
    promptHash: bundle.session.promptHash,
    planId: plan.id,
    planHash: plan.hash,
    charterId: plan.charter.id,
    charterHash: plan.charter.hash,
    planApprovalId: "creator_approval_coordinator_closure",
    planApprovalHash: contentHash("coordinator-closure-plan-approval"),
    buildContractId: "creator_build_contract_coordinator_closure",
    buildContractHash: contentHash("coordinator-closure-build-contract"),
    ownershipMapId: bundle.ownership.id,
    ownershipMapHash: bundle.ownership.hash,
    expectedRevisionHash: REVISION,
    operations: [operation],
    localGate: { status: "eligible", issueHashes: [] },
  };
  const observed: StudioSnapshotObservation = {
    ...OBSERVATION,
    instances: [
      ...OBSERVATION.instances,
      {
        stableId: "controller",
        path: "Workspace/StatusBeaconController",
        className: "Script",
        properties: [],
        attributes: [],
        tags: [],
      },
    ],
    scripts: [
      {
        stableId: "controller",
        path: "Workspace/StatusBeaconController",
        executionContext: "server",
        source: "return 'tampered'\n",
        sourceHash: contentHash("return 'tampered'\n"),
      },
    ],
  };
  assert.equal(
    reconcileAppliedChangeSet(changeSet, observed),
    "created script source hash mismatch: Workspace/StatusBeaconController",
  );
  const matching = {
    ...observed,
    scripts: [
      { ...observed.scripts[0]!, source, sourceHash: contentHash(source) },
    ],
  };
  assert.equal(reconcileAppliedChangeSet(changeSet, matching), undefined);
});
