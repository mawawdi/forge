import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import { HostPhaseRecorder } from "../packages/flight-recorder/src/host-phase.js";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import {
  createCreatorProjectChangeNotice,
  writeCreatorProjectIndexArtifacts,
} from "../packages/creator-session/src/project-refresh.js";
import {
  advanceSession,
  createCreatorSession,
  createStudioOwnershipMap,
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
  type StudioProjectIndexCapture,
} from "../packages/studio-evidence/src/index.js";
import type { StudioBridgeSession } from "../packages/studio-bridge/src/index.js";
import {
  createStudioProjectIdentityState,
  type BackendToPluginMessage,
} from "../packages/studio-protocol/src/index.js";

const project = { name: "Deferred coordinator follow-up", placeId: 901, universeId: 902 };

test("concurrent and retried finalization acknowledgements keep the exact command identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-finalization-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = {
    ...JSON.parse(await readFile("test/fixtures/creator-finalization-incident.json", "utf8")),
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
  };
  const sent: BackendToPluginMessage[] = [];
  let rejectFirst = true;
  const coordinator = Object.assign(Object.create(CreatorSessionCoordinator.prototype), {
    timings: new HostPhaseRecorder(directory),
    finalizationAcknowledgementCommands: new Map(),
    input: {
      connection: {
        send: async (command: BackendToPluginMessage) => {
          sent.push(structuredClone(command));
          if (rejectFirst) {
            rejectFirst = false;
            throw new Error("lost acknowledgement transport");
          }
        },
      },
    },
  }) as {
    sendFinalizationAcknowledgement(
      studio: StudioBridgeSession,
      requestId: string,
      pending: unknown,
    ): Promise<void>;
  };
  const pending = { receipt };
  const requestId = "creator_finalization_ack_incident";
  await assert.rejects(
    coordinator.sendFinalizationAcknowledgement(studio, requestId, pending),
    /lost acknowledgement/,
  );
  await Promise.all([
    coordinator.sendFinalizationAcknowledgement(studio, requestId, pending),
    coordinator.sendFinalizationAcknowledgement(studio, requestId, pending),
  ]);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(sent[2], sent[0]);
  assert.equal(sent[0]!.type, "AcknowledgeCreatorChangeFinalization");
  assert.equal(sent[0]!.requestId, requestId);
});
const studio: StudioBridgeSession = {
  sessionId: "studio_session_deferred_follow_up",
  projectId: "studio_project_deferred_follow_up",
  conversationProjectId: "studio_project_deferred_follow_up",
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
  sessionToken: "studio_session_token_deferred_follow_up",
  connectedAt: "2026-09-03T00:00:00.000Z",
};

test("overlapping conversations queue only their project capture boundary", async () => {
  const coordinator = Object.assign(Object.create(CreatorSessionCoordinator.prototype), {
    projectOperationQueues: new Map<string, Promise<void>>(),
  }) as {
    lockProject<T>(projectId: string, operation: () => Promise<T>): Promise<T>;
    projectOperationQueues: Map<string, Promise<void>>;
  };
  const order: string[] = [];
  let releaseFirst!: () => void;
  let confirmFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    confirmFirstStarted = resolve;
  });
  const first = coordinator.lockProject(studio.projectId, async () => {
    order.push("first-started");
    confirmFirstStarted();
    await firstGate;
    order.push("first-finished");
  });
  const second = coordinator.lockProject(studio.projectId, async () => {
    order.push("second-started");
  });

  await firstStarted;
  assert.deepEqual(order, ["first-started"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-started", "first-finished", "second-started"]);
  assert.equal(coordinator.projectOperationQueues.size, 0);
});

interface ConfirmationHarness {
  artifactStore: ImmutableJsonArtifactStore;
  bundles: Map<string, CreatorSessionBundle>;
  views: Map<string, unknown>;
  viewPublicationEpochs: Map<string, number>;
  pendingTransactionProjectChanges: Map<string, Array<{ artifact: { artifactHash: string } }>>;
  projectAuthorityEpochs: Map<string, number>;
  deferredTaskFailures: Map<string, string>;
  collectProjectIndex(value: StudioBridgeSession): Promise<StudioProjectIndexCapture>;
  persist(value: CreatorSessionBundle): Promise<CreatorSessionBundle>;
  view(value: CreatorSessionBundle, detail: string): Promise<never>;
  publishView(
    value: CreatorSessionBundle,
    detail: string,
    authority?: { projectId: string; epoch: number },
  ): Promise<void>;
  flushDeferredTransactionAcknowledgements(sessionId: string): Promise<void>;
  confirmTransactionProjectChange(
    value: CreatorSessionBundle,
    paired: StudioBridgeSession,
  ): Promise<CreatorSessionBundle>;
}

test("a derived control-view failure cannot reject or reclassify durable session work", async () => {
  const { coordinator, bundle, directory } = await confirmationHarness();
  try {
    coordinator.views.set(bundle.session.id, { stale: true });
    coordinator.view = async () => {
      throw new Error("change review cannot render the current projection");
    };

    await coordinator.publishView(bundle, "durable state already persisted");

    assert.equal(coordinator.views.has(bundle.session.id), false);
    assert.equal(coordinator.bundles.get(bundle.session.id)?.session.hash, bundle.session.hash);
    assert.match(
      coordinator.deferredTaskFailures.get(bundle.session.id) ?? "",
      /control-view materialization failed: change review cannot render the current projection/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project-authority revocation still interrupts a failed view publication", async () => {
  const { coordinator, bundle, directory } = await confirmationHarness();
  try {
    const lease = { projectId: bundle.session.projectId, epoch: 0 };
    coordinator.projectAuthorityEpochs.set(lease.projectId, lease.epoch);
    coordinator.view = async () => {
      coordinator.projectAuthorityEpochs.set(lease.projectId, lease.epoch + 1);
      throw new Error("presentation failed after authority changed");
    };

    await assert.rejects(
      coordinator.publishView(bundle, "must retain semantic authority fencing", lease as never),
      /Project authority was revoked/,
    );
    assert.equal(coordinator.deferredTaskFailures.has(bundle.session.id), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function projectCapture(completedAt: string): StudioProjectIndexCapture {
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
  return createStudioProjectIndexCapture({
    projection,
    shards: [createStudioProjectEvidenceShard({ root: "Workspace", ordinal: 0, nodes: [] })],
    sourceManifests: [],
    sourceChunks: [],
    completedAt,
    detectorEpoch: 0,
  });
}

async function confirmationHarness() {
  const directory = await mkdtemp(join(tmpdir(), "forge-deferred-follow-up-"));
  const coordinator = new CreatorSessionCoordinator({
    connection: {
      subscribeWithSession: () => () => undefined,
      send: async () => undefined,
    } as never,
    worker: {} as never,
    sourceAnalysisHost: {
      analyze: async () => {
        throw new Error("source analysis is outside this containment test");
      },
    },
    directory,
  }) as unknown as ConfirmationHarness;
  const expected = projectCapture("2026-09-03T00:00:00.000Z");
  const expectedBinding = await writeCreatorProjectIndexArtifacts(
    coordinator.artifactStore,
    expected,
  );
  const connectorEpoch = createStudioConnectorEpoch({
    sessionId: studio.sessionId,
    projectId: studio.projectId,
    connectorBuildHash: studio.connectorBuildHash,
  });
  const notice = createCreatorProjectChangeNotice({
    projectId: studio.projectId,
    connectorEpoch,
    payload: {
      project,
      connectorEpoch,
      epoch: 1,
      observedAt: "2026-09-03T00:00:01.000Z",
      sources: ["property"],
    },
  });
  const noticeArtifact = await coordinator.artifactStore.write(notice);
  const observation: CreatorProjectIndexView = {
    project,
    revision: { hash: expected.revision.hash } as CreatorProjectIndexView["revision"],
    instances: [],
    scripts: [],
  };
  const ownership = createStudioOwnershipMap({
    projectId: studio.projectId,
    revisionHash: expected.revision.hash,
    projectIndex: observation,
  });
  let session = createCreatorSession({
    prompt: "Keep durable confirmation independent from the dashboard.",
    projectId: studio.projectId,
    revisionHash: expected.revision.hash,
    projectCaptureHash: expected.hash,
    ownership,
    now: new Date("2026-09-03T00:00:00.000Z"),
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
      attemptId: "creator_mutation_attempt_deferred_follow_up",
      stage: "provisional",
      changeSetId: "creator_change_set_deferred_follow_up",
      changeSetHash: "c".repeat(64),
      projectionId: "studio_mutation_projection_deferred_follow_up",
      projectionHash: "d".repeat(64),
      beforeIndexRevisionHash: expected.revision.hash,
      afterIndexCapture: expectedBinding,
    },
  } as unknown as CreatorSessionBundle;
  coordinator.bundles.set(session.id, bundle);
  coordinator.pendingTransactionProjectChanges.set(session.id, [{ artifact: noticeArtifact }]);
  coordinator.collectProjectIndex = async () => projectCapture("2026-09-03T00:00:02.000Z");
  coordinator.persist = async (value) => {
    coordinator.bundles.set(value.session.id, value);
    return value;
  };
  return { coordinator, bundle, directory };
}

test("a post-persist confirmation publication failure leaves the exact unchanged evidence intact", async () => {
  const { coordinator, bundle, directory } = await confirmationHarness();
  try {
    coordinator.publishView = async () => {
      throw new Error("SSE subscriber disconnected after persistence");
    };

    const confirmed = await coordinator.confirmTransactionProjectChange(bundle, studio);

    assert.equal(confirmed.session.status, "awaiting_verification");
    assert.equal(confirmed.projectChanges[0]?.confirmation?.record.outcome, "unchanged");
    assert.equal(coordinator.pendingTransactionProjectChanges.has(bundle.session.id), false);
    assert.equal(coordinator.projectAuthorityEpochs.size, 0);
    assert.match(
      coordinator.deferredTaskFailures.get(bundle.session.id) ?? "",
      /SSE subscriber disconnected after persistence/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a post-persist deferred acknowledgement failure leaves the exact unchanged evidence intact", async () => {
  const { coordinator, bundle, directory } = await confirmationHarness();
  try {
    coordinator.publishView = async () => undefined;
    coordinator.flushDeferredTransactionAcknowledgements = async () => {
      throw new Error("finalization acknowledgement transport disconnected");
    };

    const confirmed = await coordinator.confirmTransactionProjectChange(bundle, studio);

    assert.equal(confirmed.session.status, "awaiting_verification");
    assert.equal(confirmed.projectChanges[0]?.confirmation?.record.outcome, "unchanged");
    assert.equal(coordinator.pendingTransactionProjectChanges.has(bundle.session.id), false);
    assert.equal(coordinator.projectAuthorityEpochs.size, 0);
    assert.match(
      coordinator.deferredTaskFailures.get(bundle.session.id) ?? "",
      /finalization acknowledgement transport disconnected/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

interface SchedulerHarness {
  automaticVerifications: Set<string>;
  inFlight: Set<string>;
  deferredTaskFailures: Map<string, string>;
  listeners: Set<() => void>;
  lock<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  recoverAutomaticVerificationFailure(sessionId: string, error: unknown): Promise<void>;
  scheduleAutomaticVerification(sessionId: string): void;
}

test("a failing automatic-recovery handler is terminally contained by the scheduler", async () => {
  const coordinator = Object.create(CreatorSessionCoordinator.prototype) as SchedulerHarness;
  coordinator.automaticVerifications = new Set();
  coordinator.inFlight = new Set();
  coordinator.deferredTaskFailures = new Map();
  coordinator.listeners = new Set();
  coordinator.lock = async () => {
    throw new Error("automatic verification failed");
  };
  coordinator.recoverAutomaticVerificationFailure = async () => {
    throw new Error("recovery handler failed");
  };

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    coordinator.scheduleAutomaticVerification("creator_session_background_containment");
    const deadline = Date.now() + 1_000;
    while (coordinator.automaticVerifications.size > 0) {
      if (Date.now() >= deadline)
        throw new Error("automatic verification scheduler did not settle");
      await new Promise((resolveValue) => setTimeout(resolveValue, 10));
    }
    // Let Node run its unhandled-rejection checkpoint after the timer chain.
    await new Promise((resolveValue) => setTimeout(resolveValue, 10));
    assert.deepEqual(unhandled, []);
    assert.match(
      coordinator.deferredTaskFailures.get("creator_session_background_containment") ?? "",
      /recovery handler failed/,
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
