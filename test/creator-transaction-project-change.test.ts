import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  CreatorSessionCoordinator,
  createChangeReviewPresentation,
} from "../packages/creator-session/src/coordinator.js";
import {
  createCreatorProjectChangeNotice,
  writeCreatorProjectIndexArtifacts,
} from "../packages/creator-session/src/project-refresh.js";
import {
  advanceSession,
  createCreatorSession,
  createStudioOwnershipMap,
  type CreatorChangeSet,
  type CreatorProjectIndexView,
  type CreatorSessionBundle,
} from "../packages/creator-session/src/index.js";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioConnectorEpoch,
  createStudioProjectEvidenceShard,
  createStudioProjectIndexCapture,
  createStudioProjectIndexProjection,
  studioProjectIndexMetadataView,
  type StudioProjectIndexCapture,
} from "../packages/studio-evidence/src/index.js";
import type { PluginToBackendMessage } from "../packages/studio-protocol/src/index.js";
import type { StudioBridgeSession } from "../packages/studio-bridge/src/index.js";
import { createStudioProjectIdentityState } from "../packages/studio-protocol/src/index.js";

interface DirtyConfirmationHarness {
  artifactStore: ImmutableJsonArtifactStore;
  bundles: Map<string, CreatorSessionBundle>;
  pendingTransactionProjectChanges: Map<
    string,
    Array<{ notice: unknown; artifact: { artifactHash: string } }>
  >;
  pendingTransactionProjectChangeIngress: Map<string, Set<string>>;
  projectAuthorityEpochs: Map<string, number>;
  finalizedTransactionProjectChangeCaptures: Map<string, StudioProjectIndexCapture>;
  retainProjectIndex(
    bundle: CreatorSessionBundle,
    value: StudioProjectIndexCapture,
  ): Promise<CreatorSessionBundle>;
  collectProjectIndex(value: StudioBridgeSession): Promise<StudioProjectIndexCapture>;
  persist(value: CreatorSessionBundle): Promise<CreatorSessionBundle>;
  publishView(value: CreatorSessionBundle, detail: string): Promise<void>;
  onPluginMessage(
    message: PluginToBackendMessage,
    paired: StudioBridgeSession,
    finalizationOwnedAtReceipt?: boolean,
    projectChangeAccepted?: boolean,
  ): Promise<void>;
  emit(): void;
  confirmTransactionProjectChange(
    value: CreatorSessionBundle,
    paired: StudioBridgeSession,
    expectedCaptureOverride?: StudioProjectIndexCapture,
  ): Promise<CreatorSessionBundle>;
  confirmFinalizedTransactionProjectChanges(
    value: CreatorSessionBundle,
    paired: StudioBridgeSession,
    finalCapture: StudioProjectIndexCapture,
  ): Promise<CreatorSessionBundle>;
  transactionProjectChangeConfirmationOverride(
    sessionId: string,
  ): StudioProjectIndexCapture | undefined;
  hasTransactionProjectChangeConfirmationBaseline(sessionId: string): boolean;
  rehydrateTransactionProjectChangeBarriers(value: CreatorSessionBundle): Promise<void>;
  recordingRecovery: Map<
    string,
    {
      recordingId: string;
      projectIndexCapture: StudioProjectIndexCapture;
      projectDetectorEpoch: number;
      replacesAction?: "commit" | "cancel";
    }
  >;
  assertRecoveredFinalizationGate(
    value: CreatorSessionBundle,
    receipt: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>["payload"],
  ): void;
}

interface ChangeReviewHarness {
  artifactStore: ImmutableJsonArtifactStore;
  bundles: Map<string, CreatorSessionBundle>;
}

const project = { name: "Transaction dirty confirmation", placeId: 601, universeId: 602 };
const studio: StudioBridgeSession = {
  sessionId: "studio_session_dirty_confirmation",
  projectId: "studio_project_dirty_confirmation",
  conversationProjectId: "studio_project_dirty_confirmation",
  project,
  projectIdentity: createStudioProjectIdentityState({
    project,
    reservedAttribute: { status: "absent" },
  }),
  projectIdentityTransaction: { status: "none" },
  capabilities: [],
  manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
  connectorBuildHash: "a".repeat(64),
  capabilityAttestationProjectionHash: "b".repeat(64),
  sessionToken: "studio_session_token_dirty_confirmation",
  connectedAt: "2026-09-01T00:00:00.000Z",
};

function capture(
  changed = false,
  completedAt = "2026-09-01T00:00:00.000Z",
): StudioProjectIndexCapture {
  const connectorEpoch = createStudioConnectorEpoch({
    sessionId: studio.sessionId,
    projectId: studio.projectId,
    connectorBuildHash: studio.connectorBuildHash,
  });
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch,
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const nodes = changed
    ? [
        {
          identity: { kind: "forge_attribute" as const, stableId: "concurrent-folder" },
          displayPath: "Workspace/ConcurrentFolder",
          name: "ConcurrentFolder",
          className: "Folder",
          attributes: {},
          tags: [],
          coveredProperties: {},
          coveredPropertyNames: [],
        },
      ]
    : [];
  return createStudioProjectIndexCapture({
    projection,
    shards: [createStudioProjectEvidenceShard({ root: "Workspace", ordinal: 0, nodes })],
    sourceManifests: [],
    sourceChunks: [],
    completedAt,
    detectorEpoch: 0,
  });
}

/**
 * A minimal completed pre-/post-Apply index pair.  The post index includes
 * the create target, exactly as Studio correctly reports it after Apply.
 */
function captureForChangeReview(
  includesCreatedTarget: boolean,
  completedAt: string,
): StudioProjectIndexCapture {
  const connectorEpoch = createStudioConnectorEpoch({
    sessionId: studio.sessionId,
    projectId: studio.projectId,
    connectorBuildHash: studio.connectorBuildHash,
  });
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch,
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const parentIdentity = { kind: "forge_attribute" as const, stableId: "review-parent" };
  const createdIdentity = {
    kind: "forge_attribute" as const,
    stableId: "review-created-target",
  };
  const nodes = [
    {
      identity: parentIdentity,
      displayPath: "Workspace/ReviewParent",
      name: "ReviewParent",
      className: "Folder",
      attributes: {},
      tags: [],
      coveredProperties: {},
      coveredPropertyNames: [],
    },
    ...(includesCreatedTarget
      ? [
          {
            identity: createdIdentity,
            parentIdentity,
            displayPath: "Workspace/ReviewParent/CreatedFolder",
            name: "CreatedFolder",
            className: "Folder",
            attributes: {},
            tags: [],
            coveredProperties: {},
            coveredPropertyNames: [],
          },
        ]
      : []),
  ];
  return createStudioProjectIndexCapture({
    projection,
    shards: [createStudioProjectEvidenceShard({ root: "Workspace", ordinal: 0, nodes })],
    sourceManifests: [],
    sourceChunks: [],
    completedAt,
    detectorEpoch: 0,
  });
}

function awaitingVerificationSession(revisionHash: string, projectCaptureHash: string) {
  const observation: CreatorProjectIndexView = {
    project,
    revision: { hash: revisionHash } as CreatorProjectIndexView["revision"],
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
    ],
    scripts: [],
  };
  const ownership = createStudioOwnershipMap({
    projectId: studio.projectId,
    revisionHash,
    projectIndex: observation,
  });
  let session = createCreatorSession({
    prompt: "Confirm dirty project evidence.",
    projectId: studio.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
    now: new Date("2026-09-01T00:00:00.000Z"),
  });
  for (const status of [
    "planning",
    "awaiting_plan_approval",
    "building",
    "awaiting_change_approval",
    "preflighting",
    "applying",
    "awaiting_verification",
  ] as const)
    session = advanceSession(session, { status });
  return { session, ownership };
}

async function fixture(input: {
  readonly observed?: StudioProjectIndexCapture;
  readonly fail?: Error;
}) {
  const directory = await mkdtemp(join(tmpdir(), "forge-dirty-confirmation-"));
  const coordinator = new CreatorSessionCoordinator({
    connection: {
      subscribeWithSession: () => () => undefined,
      send: async () => undefined,
    } as never,
    worker: {} as never,
    sourceAnalysisHost: {
      analyze: async () => {
        throw new Error("source analysis is outside this transaction-confirmation test");
      },
    },
    directory,
  }) as unknown as DirtyConfirmationHarness;
  const store = coordinator.artifactStore;
  const expected = capture(false);
  const expectedBinding = await writeCreatorProjectIndexArtifacts(store, expected);
  const notice = createCreatorProjectChangeNotice({
    projectId: studio.projectId,
    connectorEpoch: expected.revision.connectorEpoch,
    payload: {
      project,
      connectorEpoch: expected.revision.connectorEpoch,
      epoch: 7,
      observedAt: "2026-09-01T00:00:01.000Z",
      sources: ["property"],
    },
  });
  const noticeArtifact = await store.write(notice);
  const { session, ownership } = awaitingVerificationSession(expected.revision.hash, expected.hash);
  const bundle = {
    session,
    creatorRequest: noticeArtifact,
    ownership,
    projectIndices: [expectedBinding],
    projectChanges: [{ notice, artifact: noticeArtifact, priorStatus: "awaiting_verification" }],
    projectRefreshes: [],
    rojoSourceMutations: [],
    sourceWriteBlobs: [],
    sourceIndices: [],
    sourceConsultations: [],
    buildContracts: [],
    approvals: [],
    changeSets: [],
    mutationAttempts: [],
    verifications: [],
    agentRuns: [],
    activeMutation: {
      attemptId: "creator_mutation_attempt_dirty_confirmation",
      stage: "provisional",
      changeSetId: "creator_change_set_dirty_confirmation",
      changeSetHash: "c".repeat(64),
      projectionId: "studio_mutation_projection_dirty_confirmation",
      projectionHash: "d".repeat(64),
      beforeIndexRevisionHash: expected.revision.hash,
      beforeIndexCapture: expectedBinding,
      afterIndexCapture: expectedBinding,
    },
  } as unknown as CreatorSessionBundle;
  coordinator.bundles.set(session.id, bundle);
  coordinator.pendingTransactionProjectChanges.set(session.id, [
    { notice, artifact: noticeArtifact },
  ]);
  coordinator.collectProjectIndex = async () => {
    if (input.fail) throw input.fail;
    return input.observed ?? capture(false, "2026-09-01T00:00:02.000Z");
  };
  coordinator.persist = async (value) => {
    coordinator.bundles.set(value.session.id, value);
    return coordinator.bundles.get(value.session.id)!;
  };
  coordinator.publishView = async () => undefined;
  return { coordinator, bundle, directory };
}

test("a delayed Forge-origin notice clears only after a complete unchanged index confirmation", async () => {
  const { coordinator, bundle, directory } = await fixture({});
  try {
    const confirmed = await coordinator.confirmTransactionProjectChange(bundle, studio);
    assert.equal(confirmed.session.status, "awaiting_verification");
    assert.equal(confirmed.projectChanges[0]?.confirmation?.record.outcome, "unchanged");
    assert.equal(coordinator.projectAuthorityEpochs.size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a later durable notice remains a finalization barrier until its own confirmation", async () => {
  const { coordinator, bundle, directory } = await fixture({});
  try {
    let collectionStarted!: () => void;
    const started = new Promise<void>((resolveValue) => {
      collectionStarted = resolveValue;
    });
    let releaseCollection!: (capture: StudioProjectIndexCapture) => void;
    const collected = new Promise<StudioProjectIndexCapture>((resolveValue) => {
      releaseCollection = resolveValue;
    });
    coordinator.collectProjectIndex = async () => {
      collectionStarted();
      return collected;
    };

    const firstConfirmation = coordinator.confirmTransactionProjectChange(bundle, studio);
    await started;

    const connectorEpoch = createStudioConnectorEpoch({
      sessionId: studio.sessionId,
      projectId: studio.projectId,
      connectorBuildHash: studio.connectorBuildHash,
    });
    await coordinator.onPluginMessage(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "StudioProjectChangeDetected",
        messageId: "confirmation-race-property-8",
        sentAt: "2026-09-01T00:00:02.000Z",
        payload: {
          project,
          connectorEpoch,
          epoch: 8,
          observedAt: "2026-09-01T00:00:02.000Z",
          sources: ["property"],
        },
      },
      studio,
    );
    releaseCollection(capture(false, "2026-09-01T00:00:03.000Z"));

    const first = await firstConfirmation;
    assert.equal(first.projectChanges.length, 2);
    assert.equal(
      first.projectChanges.filter((change) => change.confirmation === undefined).length,
      1,
    );
    assert.equal(coordinator.pendingTransactionProjectChanges.get(bundle.session.id)?.length, 1);

    coordinator.collectProjectIndex = async () => capture(false, "2026-09-01T00:00:04.000Z");
    const second = await coordinator.confirmTransactionProjectChange(first, studio);
    assert.ok(second.projectChanges.every((change) => change.confirmation !== undefined));
    assert.equal(coordinator.pendingTransactionProjectChanges.has(bundle.session.id), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a protocol-valid property notice is durably bound before it can affect an open transaction", async () => {
  const { coordinator, bundle, directory } = await fixture({});
  try {
    const connectorEpoch = createStudioConnectorEpoch({
      sessionId: studio.sessionId,
      projectId: studio.projectId,
      connectorBuildHash: studio.connectorBuildHash,
    });
    coordinator.pendingTransactionProjectChangeIngress.set(
      bundle.session.id,
      new Set(["property-8"]),
    );
    coordinator.emit = () => undefined;
    await coordinator.onPluginMessage(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "StudioProjectChangeDetected",
        messageId: "property-8",
        sentAt: "2026-09-01T00:00:02.000Z",
        payload: {
          project,
          connectorEpoch,
          epoch: 8,
          observedAt: "2026-09-01T00:00:02.000Z",
          sources: ["property"],
        },
      },
      studio,
    );
    assert.equal(coordinator.pendingTransactionProjectChangeIngress.has(bundle.session.id), false);
    assert.equal(coordinator.pendingTransactionProjectChanges.get(bundle.session.id)?.length, 2);
    assert.equal(coordinator.projectAuthorityEpochs.size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a notice processed during Apply survives an older continuation and receives its confirmation", async () => {
  const { coordinator, bundle, directory } = await fixture({});
  try {
    const connectorEpoch = createStudioConnectorEpoch({
      sessionId: studio.sessionId,
      projectId: studio.projectId,
      connectorBuildHash: studio.connectorBuildHash,
    });
    coordinator.pendingTransactionProjectChangeIngress.set(
      bundle.session.id,
      new Set(["apply-race-property-8"]),
    );
    await coordinator.onPluginMessage(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "StudioProjectChangeDetected",
        messageId: "apply-race-property-8",
        sentAt: "2026-09-01T00:00:03.000Z",
        payload: {
          project,
          connectorEpoch,
          epoch: 8,
          observedAt: "2026-09-01T00:00:03.000Z",
          sources: ["property"],
        },
      },
      studio,
    );
    // This models Apply retaining post-Apply evidence from the local bundle it
    // captured before the notification was dispatched.
    const continued = await coordinator.retainProjectIndex(
      bundle,
      capture(false, "2026-09-01T00:00:04.000Z"),
    );
    assert.equal(continued.projectChanges.length, 2);
    const confirmed = await coordinator.confirmTransactionProjectChange(continued, studio);
    assert.equal(confirmed.projectChanges.length, 2);
    assert.ok(confirmed.projectChanges.every((change) => change.confirmation !== undefined));
    assert.equal(coordinator.pendingTransactionProjectChanges.has(bundle.session.id), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a transaction dirty hint waits for post-state instead of inventing a pre-Apply comparison", async () => {
  const { coordinator, bundle, directory } = await fixture({});
  try {
    const active = bundle.activeMutation!;
    const withoutPostState = {
      ...bundle,
      activeMutation: {
        ...active,
        afterIndexCapture: undefined,
      },
    } as unknown as CreatorSessionBundle;
    coordinator.bundles.set(bundle.session.id, withoutPostState);
    let collections = 0;
    coordinator.collectProjectIndex = async () => {
      collections += 1;
      return capture(false, "2026-09-01T00:00:04.000Z");
    };

    const unchanged = await coordinator.confirmTransactionProjectChange(withoutPostState, studio);

    assert.equal(collections, 0);
    assert.equal(unchanged.projectChanges[0]?.confirmation, undefined);
    assert.equal(unchanged.session.status, withoutPostState.session.status);
    assert.equal(coordinator.pendingTransactionProjectChanges.has(bundle.session.id), true);
    assert.equal(coordinator.projectAuthorityEpochs.size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart rehydrates a pre-Apply dirty barrier without treating pre-Apply evidence as its baseline", async () => {
  const { coordinator, bundle, directory } = await fixture({});
  try {
    const withoutPostState = {
      ...bundle,
      activeMutation: {
        ...bundle.activeMutation!,
        afterIndexCapture: undefined,
      },
    } as unknown as CreatorSessionBundle;
    coordinator.pendingTransactionProjectChanges.clear();
    coordinator.bundles.set(bundle.session.id, withoutPostState);

    await coordinator.rehydrateTransactionProjectChangeBarriers(withoutPostState);

    assert.equal(coordinator.pendingTransactionProjectChanges.get(bundle.session.id)?.length, 1);
    assert.equal(
      coordinator.hasTransactionProjectChangeConfirmationBaseline(bundle.session.id),
      false,
    );
    assert.equal(
      coordinator.transactionProjectChangeConfirmationOverride(bundle.session.id),
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a later exact recovery capture unlocks a dirty hint that arrived before post-state", async () => {
  const { coordinator, bundle, directory } = await fixture({});
  try {
    const withoutPostState = {
      ...bundle,
      activeMutation: {
        ...bundle.activeMutation!,
        afterIndexCapture: undefined,
      },
    } as unknown as CreatorSessionBundle;
    coordinator.bundles.set(bundle.session.id, withoutPostState);
    const recoveryCapture = capture(false, "2026-09-01T00:00:04.000Z");
    coordinator.recordingRecovery.set(bundle.session.id, {
      recordingId: "recording_after_missing_post_state",
      projectIndexCapture: recoveryCapture,
      projectDetectorEpoch: recoveryCapture.detectorEpoch,
    });
    coordinator.collectProjectIndex = async () => capture(false, "2026-09-01T00:00:05.000Z");

    const baseline = coordinator.transactionProjectChangeConfirmationOverride(bundle.session.id);
    assert.equal(baseline?.hash, recoveryCapture.hash);
    const confirmed = await coordinator.confirmTransactionProjectChange(
      withoutPostState,
      studio,
      baseline,
    );

    assert.equal(confirmed.projectChanges[0]?.confirmation?.record.outcome, "unchanged");
    assert.equal(
      confirmed.projectChanges[0]?.confirmation?.record.expectedCaptureHash,
      recoveryCapture.hash,
    );
    assert.equal(coordinator.pendingTransactionProjectChanges.has(bundle.session.id), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a newer dirty ingress during confirmation discards the read without inventing recovery", async () => {
  const { coordinator, bundle, directory } = await fixture({});
  try {
    coordinator.pendingTransactionProjectChangeIngress.set(
      bundle.session.id,
      new Set(["notice-arrived-during-confirmation"]),
    );
    let collections = 0;
    coordinator.collectProjectIndex = async () => {
      collections += 1;
      return capture(false, "2026-09-01T00:00:06.000Z");
    };

    const waiting = await coordinator.confirmTransactionProjectChange(bundle, studio);

    assert.equal(collections, 1);
    assert.equal(waiting.session.status, bundle.session.status);
    assert.equal(waiting.projectChanges[0]?.confirmation, undefined);
    assert.equal(coordinator.pendingTransactionProjectChanges.has(bundle.session.id), true);
    assert.equal(coordinator.projectAuthorityEpochs.size, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a complete current index with real concurrent drift enters recovery without finalizing", async () => {
  const { coordinator, bundle, directory } = await fixture({
    observed: capture(true, "2026-09-01T00:00:02.000Z"),
  });
  try {
    const confirmed = await coordinator.confirmTransactionProjectChange(bundle, studio);
    assert.equal(confirmed.session.status, "recovery_required");
    assert.equal(confirmed.projectChanges[0]?.confirmation?.record.outcome, "drift");
    assert.equal(coordinator.projectAuthorityEpochs.get(studio.projectId), 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const phase of [
  "manual cancellation",
  "recovery cancellation",
  "recovered finalization receipt",
] as const) {
  test(`${phase} confirms an admitted notice against its final capture, not provisional state`, async () => {
    const finalCapture = capture(true, "2026-09-01T00:00:05.000Z");
    const { coordinator, bundle, directory } = await fixture({ observed: finalCapture });
    try {
      const confirmed = await coordinator.confirmFinalizedTransactionProjectChanges(
        bundle,
        studio,
        finalCapture,
      );
      const record = confirmed.projectChanges[0]?.confirmation?.record;
      assert.equal(record?.outcome, "unchanged");
      assert.equal(record?.expectedRevisionHash, finalCapture.revision.hash);
      assert.notEqual(
        record?.expectedRevisionHash,
        bundle.activeMutation?.afterIndexCapture?.revision.hash,
      );
      assert.equal(coordinator.pendingTransactionProjectChanges.has(bundle.session.id), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("a terminalized finalization retains and settles a notice instead of rescheduling without an active cursor", async () => {
  const finalCapture = capture(true, "2026-09-01T00:00:06.000Z");
  const { coordinator, bundle, directory } = await fixture({ observed: finalCapture });
  try {
    const { activeMutation: _activeMutation, ...settled } = bundle;
    const terminal = {
      ...settled,
      session: advanceSession(bundle.session, { status: "incomplete" }),
    };
    coordinator.bundles.set(terminal.session.id, terminal);
    const confirmed = await coordinator.confirmFinalizedTransactionProjectChanges(
      terminal,
      studio,
      finalCapture,
    );
    assert.equal(confirmed.session.status, "incomplete");
    assert.equal(confirmed.projectChanges[0]?.confirmation?.record.outcome, "unchanged");
    assert.equal(coordinator.pendingTransactionProjectChanges.has(terminal.session.id), false);
    assert.equal(
      coordinator.finalizedTransactionProjectChangeCaptures.has(terminal.session.id),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an incomplete read-only confirmation enters recovery rather than inventing drift", async () => {
  const { coordinator, bundle, directory } = await fixture({
    fail: new Error("project index stream interrupted"),
  });
  try {
    const confirmed = await coordinator.confirmTransactionProjectChange(bundle, studio);
    assert.equal(confirmed.session.status, "recovery_required");
    assert.equal(confirmed.projectChanges[0]?.confirmation?.record.outcome, "incomplete");
    assert.match(confirmed.session.failure?.code ?? "", /confirmation_incomplete/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dirty ingress ignores duplicate and stale detector epochs before any authority change", () => {
  const coordinator = Object.create(CreatorSessionCoordinator.prototype) as {
    projectChangeDetectorEpochs: Map<string, number>;
    bundles: Map<string, CreatorSessionBundle>;
    pendingTransactionProjectChangeIngress: Map<string, Set<string>>;
    admitProjectChangeAtIngress(
      message: PluginToBackendMessage,
      paired: StudioBridgeSession,
    ): boolean;
  };
  coordinator.projectChangeDetectorEpochs = new Map();
  coordinator.bundles = new Map();
  coordinator.pendingTransactionProjectChangeIngress = new Map();
  const message = (epoch: number, messageId: string) =>
    ({
      kind: "StudioProtocolMessage",
      direction: "plugin_to_backend",
      type: "StudioProjectChangeDetected",
      messageId,
      sentAt: "2026-09-01T00:00:00.000Z",
      payload: {
        project,
        connectorEpoch: createStudioConnectorEpoch({
          sessionId: studio.sessionId,
          projectId: studio.projectId,
          connectorBuildHash: studio.connectorBuildHash,
        }),
        epoch,
        observedAt: "2026-09-01T00:00:00.000Z",
        sources: ["attribute"],
      },
    }) as PluginToBackendMessage;
  assert.equal(coordinator.admitProjectChangeAtIngress(message(8, "notice-8"), studio), true);
  assert.equal(
    coordinator.admitProjectChangeAtIngress(message(8, "notice-8-duplicate"), studio),
    false,
  );
  assert.equal(
    coordinator.admitProjectChangeAtIngress(message(7, "notice-7-stale"), studio),
    false,
  );
  assert.equal(coordinator.admitProjectChangeAtIngress(message(9, "notice-9"), studio), true);
});

test("a dirty-confirmation worker waits for the owning session lock instead of spinning", async () => {
  const sessionId = "creator_session_confirmation_lock_release";
  const coordinator = Object.create(CreatorSessionCoordinator.prototype) as {
    inFlight: Set<string>;
    bundles: Map<string, CreatorSessionBundle>;
    pendingTransactionProjectChanges: Map<string, unknown[]>;
    pendingTransactionProjectChangeIngress: Map<string, Set<string>>;
    scheduledTransactionProjectConfirmations: Set<string>;
    transactionProjectConfirmationRequestedAfterLockRelease: Set<string>;
    finalizedTransactionProjectChangeCaptures: Map<string, StudioProjectIndexCapture>;
    scheduleTransactionProjectChangeConfirmation(sessionId: string): void;
    runScheduledTransactionProjectChangeConfirmation(sessionId: string): Promise<void>;
    lock<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  };
  coordinator.inFlight = new Set([sessionId]);
  coordinator.bundles = new Map([[sessionId, { activeMutation: {} } as CreatorSessionBundle]]);
  coordinator.pendingTransactionProjectChanges = new Map([[sessionId, [{}]]]);
  coordinator.pendingTransactionProjectChangeIngress = new Map();
  coordinator.scheduledTransactionProjectConfirmations = new Set([sessionId]);
  coordinator.transactionProjectConfirmationRequestedAfterLockRelease = new Set();
  coordinator.finalizedTransactionProjectChangeCaptures = new Map([[sessionId, capture(false)]]);
  let reschedules = 0;
  coordinator.scheduleTransactionProjectChangeConfirmation = () => {
    reschedules += 1;
  };

  await coordinator.runScheduledTransactionProjectChangeConfirmation(sessionId);

  assert.equal(reschedules, 0);
  assert.equal(coordinator.scheduledTransactionProjectConfirmations.has(sessionId), false);

  coordinator.inFlight.clear();
  await coordinator.lock(sessionId, async () => undefined);
  assert.equal(reschedules, 1);
  assert.equal(
    coordinator.transactionProjectConfirmationRequestedAfterLockRelease.has(sessionId),
    true,
  );
});

test("recovered recovery cancellation must echo its durable displaced action", async () => {
  const { coordinator, bundle, directory } = await fixture({});
  try {
    const recoveryCapture = capture(true, "2026-09-01T00:00:03.000Z");
    coordinator.recordingRecovery.set(bundle.session.id, {
      recordingId: "recording_recovery_provenance",
      projectIndexCapture: recoveryCapture,
      projectDetectorEpoch: recoveryCapture.detectorEpoch,
      replacesAction: "commit",
    });
    const receipt = {
      creatorSessionId: bundle.session.id,
      changeSetId: bundle.activeMutation!.changeSetId,
      changeSetHash: bundle.activeMutation!.changeSetHash,
      projectionId: bundle.activeMutation!.projectionId,
      projectionHash: bundle.activeMutation!.projectionHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      beforeProjectIndexManifestId: recoveryCapture.indexManifest.id,
      beforeProjectRevisionHash: bundle.activeMutation!.beforeIndexRevisionHash,
      beforeProjectDetectorEpoch: 0,
      recordingId: "recording_recovery_provenance",
      action: "cancel" as const,
      finalizationKind: "recovery_cancel" as const,
      replacesAction: "cancel" as const,
      expectedCurrentProjectIndexManifestId: recoveryCapture.indexManifest.id,
      expectedCurrentProjectRevisionHash: recoveryCapture.revision.hash,
      expectedCurrentProjectDetectorEpoch: recoveryCapture.detectorEpoch,
      status: "cancelled" as const,
      afterProjectIndexManifestId: recoveryCapture.indexManifest.id,
      afterProjectRevisionHash: recoveryCapture.revision.hash,
      afterProjectDetectorEpoch: recoveryCapture.detectorEpoch,
    } as Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>["payload"];
    assert.throws(
      () => coordinator.assertRecoveredFinalizationGate(bundle, receipt),
      /provenance mismatch/,
    );
    assert.doesNotThrow(() =>
      coordinator.assertRecoveredFinalizationGate(bundle, { ...receipt, replacesAction: "commit" }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart has no in-memory dirty-confirmation worker and therefore cannot auto-confirm or mutate", () => {
  const coordinator = Object.create(CreatorSessionCoordinator.prototype) as {
    pendingTransactionProjectChanges: Map<string, unknown[]>;
    pendingTransactionProjectChangeIngress: Map<string, Set<string>>;
    scheduledTransactionProjectConfirmations: Set<string>;
  };
  coordinator.pendingTransactionProjectChanges = new Map();
  coordinator.pendingTransactionProjectChangeIngress = new Map();
  coordinator.scheduledTransactionProjectConfirmations = new Set();
  assert.equal(coordinator.pendingTransactionProjectChanges.size, 0);
  assert.equal(coordinator.pendingTransactionProjectChangeIngress.size, 0);
  assert.equal(coordinator.scheduledTransactionProjectConfirmations.size, 0);
  assert.notEqual(contentHash("restart"), contentHash("automatic mutation"));
});

test("dashboard renders a provisional create from its immutable pre-Apply index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-change-review-baseline-"));
  const coordinator = new CreatorSessionCoordinator({
    connection: {
      subscribeWithSession: () => () => undefined,
    } as never,
    worker: {} as never,
    sourceAnalysisHost: {
      analyze: async () => {
        throw new Error("source analysis is outside this change-review test");
      },
    },
    directory,
  });
  const harness = coordinator as unknown as ChangeReviewHarness;
  try {
    const before = captureForChangeReview(false, "2026-09-01T00:00:00.000Z");
    const after = captureForChangeReview(true, "2026-09-01T00:00:01.000Z");
    const [beforeBinding, afterBinding] = await Promise.all([
      writeCreatorProjectIndexArtifacts(harness.artifactStore, before),
      writeCreatorProjectIndexArtifacts(harness.artifactStore, after),
    ]);
    const { session: initialSession, ownership } = awaitingVerificationSession(
      before.revision.hash,
      before.hash,
    );
    const changeSet = {
      kind: "CreatorChangeSet",
      id: "creator_change_set_review_baseline",
      hash: "e".repeat(64),
      sessionId: initialSession.id,
      attempt: 1,
      promptHash: initialSession.promptHash,
      planId: "creator_plan_review_baseline",
      planHash: "f".repeat(64),
      charterId: "verification_charter_review_baseline",
      charterHash: "a".repeat(64),
      planApprovalId: "creator_approval_review_baseline",
      planApprovalHash: "b".repeat(64),
      buildContractId: "creator_build_contract_review_baseline",
      buildContractHash: "c".repeat(64),
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      mutationAuthority: "studio_document",
      expectedRevisionHash: before.revision.hash,
      operations: [
        {
          id: "creator_operation_review_baseline",
          planChangeId: "creator_plan_change_review_baseline",
          kind: "create",
          tempId: "review-created-target",
          target: {
            kind: "instance",
            identity: { kind: "forge_attribute", stableId: "review-created-target" },
            path: "Workspace/ReviewParent/CreatedFolder",
            className: "Folder",
          },
          parent: {
            kind: "instance",
            identity: { kind: "forge_attribute", stableId: "review-parent" },
            path: "Workspace/ReviewParent",
            className: "Folder",
          },
          className: "Folder",
          name: "CreatedFolder",
          properties: {},
          attributes: {},
        },
      ],
      sourceWriteBlobs: [],
      localGate: { status: "eligible", issueHashes: [] },
    } as CreatorChangeSet;
    // This is the old failure boundary: rendering against Studio's valid
    // post-Apply index treats the create target as an invalid duplicate.
    assert.throws(
      () => createChangeReviewPresentation(changeSet, studioProjectIndexMetadataView(after)),
      /create identity already exists/,
    );
    const request = await harness.artifactStore.write({
      kind: "CreatorRequest",
      sessionId: initialSession.id,
      promptHash: initialSession.promptHash,
      creatorText: "Confirm dirty project evidence.",
      agentPrompt: "Confirm dirty project evidence.",
      contextCitations: [],
    });
    const projectionArtifact = await harness.artifactStore.write({ requirements: [] });
    const inertArtifact = await harness.artifactStore.write({ kind: "test-artifact" });
    const binding = { artifact: inertArtifact, hash: "d".repeat(64) };
    const session = {
      ...initialSession,
      currentProjectCaptureHash: after.hash,
      currentRevisionHash: after.revision.hash,
      changeSet: { id: changeSet.id, hash: changeSet.hash },
    };
    const bundle = {
      session,
      creatorRequest: request,
      ownership,
      projectIndices: [beforeBinding, afterBinding],
      projectChanges: [],
      projectRefreshes: [],
      rojoSourceMutations: [],
      sourceWriteBlobs: [],
      sourceIndices: [],
      sourceConsultations: [],
      buildContracts: [],
      approvals: [],
      changeSets: [changeSet],
      mutationAttempts: [],
      verifications: [],
      agentRuns: [],
      activeMutation: {
        attemptId: "creator_mutation_attempt_review_baseline",
        stage: "provisional",
        changeSetId: changeSet.id,
        changeSetHash: changeSet.hash,
        projectionId: "studio_evidence_projection_review_baseline",
        projectionHash: "9".repeat(64),
        beforeIndexRevisionHash: before.revision.hash,
        beforeProjectDetectorEpoch: before.detectorEpoch,
        manifest: binding,
        attestation: { projection: binding, envelope: binding },
        changeSet: binding,
        projection: { artifact: projectionArtifact, hash: "8".repeat(64) },
        preflight: { projection: binding, envelope: binding },
        beforeIndexCapture: beforeBinding,
        afterIndexCapture: afterBinding,
      },
    } as unknown as CreatorSessionBundle;
    harness.bundles.set(session.id, bundle);

    const state = await coordinator.dashboardState(session.id);
    assert.equal(state.kind, "CreatorTransactionState");
    assert.equal(state.controlView?.artifact?.kind, "change_set");
    assert.equal(state.controlView?.projectIndex?.rootHash, after.revision.merkleRoot);
    const presentation = state.controlView?.artifact?.presentation as {
      proofObligations?: unknown[];
    };
    assert.ok((presentation.proofObligations?.length ?? 0) > 0);
  } finally {
    coordinator.close();
    await rm(directory, { recursive: true, force: true });
  }
});
