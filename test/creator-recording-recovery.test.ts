import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  advanceSession,
  closeInterruptedCreatorRecording,
  createCreatorSession,
  createStudioOwnershipMap,
  type CreatorSessionBundle,
} from "../packages/creator-session/src/index.js";
import { writeCreatorProjectIndexArtifacts } from "../packages/creator-session/src/project-refresh.js";
import { readCreatorRecordingRecoveryAuthority } from "../packages/creator-session/src/recording-recovery-authority.js";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioConnectorEpoch,
  createStudioProjectEvidenceShard,
  createStudioProjectIndexCapture,
  createStudioProjectIndexProjection,
  studioProjectIndexMetadataView,
} from "../packages/studio-evidence/src/index.js";
import { createStudioProjectIdentityState } from "../packages/studio-protocol/src/index.js";
import type {
  BackendToPluginMessage,
  PluginToBackendMessage,
  StudioCapability,
} from "../packages/studio-protocol/src/index.js";
import type {
  StudioBridgeConnection,
  StudioBridgeSession,
} from "../packages/studio-bridge/src/index.js";
import type { CreatorAgentWorker } from "../packages/creator-session/src/worker.js";

const sentAt = "2026-09-01T00:00:00.000Z";
const project = { name: "Recovery Project", placeId: 41, universeId: 42 };
const capabilities: StudioCapability[] = [
  "studio_evidence",
  "studio_project_index",
  "opaque_identity",
  "project_change_monitor",
  "semantic_message_stream",
  "sha256",
  "stable_identity",
  "reflection_attestation",
  "detached_preflight",
  "transactional_authoring",
  "recording_recovery",
  "studio_play_mode",
  "bounded_diagnostics",
  "project_identity",
  "http_polling",
];
const session: StudioBridgeSession = {
  sessionId: "studio_session_recovery",
  projectId: "studio_project_recovery",
  conversationProjectId: "studio_project_recovery",
  project,
  projectIdentity: createStudioProjectIdentityState({
    project,
    reservedAttribute: { status: "absent" },
  }),
  projectIdentityTransaction: { status: "none" },
  capabilities,
  manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
  connectorBuildHash: "1".repeat(64),
  capabilityAttestationProjectionHash: "2".repeat(64),
  sessionToken: "studio_session_token_recovery",
  connectedAt: sentAt,
};

test("recovery cancellation receipts use retained authority after the host loses its live map", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-cancel-authority-"));
  try {
    const store = new ImmutableJsonArtifactStore(root);
    const capture = recoveryProjectIndex();
    const index = await writeCreatorProjectIndexArtifacts(store, capture);
    const active = {
      changeSetId: "cancel-change",
      changeSetHash: "a".repeat(64),
      projectionId: "cancel-projection",
      projectionHash: "b".repeat(64),
      manifest: { hash: STUDIO_CAPABILITY_MANIFEST_HASH },
      recordingId: "cancel-recording",
      beforeIndexCapture: index,
      beforeIndexRevisionHash: capture.revision.hash,
      beforeProjectDetectorEpoch: capture.detectorEpoch,
    } as CreatorSessionBundle["activeMutation"] & {};
    const binding = {
      creatorSessionId: "cancel-session",
      changeSetId: active.changeSetId,
      changeSetHash: active.changeSetHash,
      projectionId: active.projectionId,
      projectionHash: active.projectionHash,
      manifestHash: active.manifest.hash,
      recordingId: active.recordingId!,
      beforeProjectIndexManifestId: index.manifest.id,
      beforeProjectRevisionHash: active.beforeIndexRevisionHash,
      beforeProjectDetectorEpoch: active.beforeProjectDetectorEpoch,
    };
    for (const cancellation of [
      { kind: "open" },
      { kind: "replace_intent", action: "commit" },
      { kind: "replace_intent", action: "cancel" },
    ] as const) {
      const record = {
        kind: "CreatorRecordingRecoveryRecord",
        studioSessionId: session.sessionId,
        projectId: session.projectId,
        payload: {
          ...binding,
          recordingState: "open",
          cancellation,
          recoveryProjectIndexManifestId: index.manifest.id,
          recoveryProjectRevisionHash: capture.revision.hash,
          recoveryProjectDetectorEpoch: capture.detectorEpoch,
        },
        projectIndex: index,
        receivedAt: sentAt,
      };
      const reference = await store.write(record);
      const context = {
        store,
        reference,
        sessionId: binding.creatorSessionId,
        projectId: session.projectId,
        active,
      };
      assert.equal(
        (await readCreatorRecordingRecoveryAuthority(context)).capture.hash,
        capture.hash,
      );
      const bundle = {
        session: { id: binding.creatorSessionId, projectId: session.projectId },
        activeMutation: { ...active, recordingRecovery: reference },
      } as CreatorSessionBundle;
      const host = Object.create(CreatorSessionCoordinator.prototype) as {
        artifactStore: ImmutableJsonArtifactStore;
        assertRecoveredFinalizationGate(
          bundle: CreatorSessionBundle,
          receipt: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>["payload"],
        ): Promise<void>;
      };
      host.artifactStore = new ImmutableJsonArtifactStore(root);
      const receipt = {
        ...binding,
        action: "cancel" as const,
        finalizationKind: "recovery_cancel" as const,
        status: "cancelled" as const,
        ...(cancellation.kind === "replace_intent" ? { replacesAction: cancellation.action } : {}),
        expectedCurrentProjectIndexManifestId: index.manifest.id,
        expectedCurrentProjectRevisionHash: capture.revision.hash,
        expectedCurrentProjectDetectorEpoch: capture.detectorEpoch,
        afterProjectIndexManifestId: index.manifest.id,
        afterProjectRevisionHash: capture.revision.hash,
        afterProjectDetectorEpoch: capture.detectorEpoch,
      };
      await host.assertRecoveredFinalizationGate(bundle, receipt);
      const { replacesAction: _replaced, ...withoutAction } = receipt;
      const wrongProvenance =
        cancellation.kind === "open"
          ? { ...receipt, replacesAction: "commit" as const }
          : withoutAction;
      await assert.rejects(
        host.assertRecoveredFinalizationGate(bundle, wrongProvenance),
        /provenance/,
      );
      await assert.rejects(
        host.assertRecoveredFinalizationGate(bundle, {
          ...receipt,
          expectedCurrentProjectDetectorEpoch: 1,
        }),
        /gate mismatch/,
      );
      for (const changed of [
        { ...record, projectId: "other-project" },
        { ...record, payload: { ...record.payload, recordingId: "other-recording" } },
        { ...record, payload: { ...record.payload, recoveryProjectRevisionHash: "f".repeat(64) } },
        {
          ...record,
          payload: Object.fromEntries(
            Object.entries(record.payload).filter(([name]) => name !== "cancellation"),
          ),
        },
        { ...record, payload: { ...record.payload, recordingState: "unknown" } },
        { ...record, payload: { ...record.payload, replacesAction: "commit" } },
      ])
        await assert.rejects(
          readCreatorRecordingRecoveryAuthority({
            ...context,
            reference: await store.write(changed),
          }),
        );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a matching closed-recording proof releases only its live cursor and survives persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-closed-recording-"));
  try {
    const store = new ImmutableJsonArtifactStore(root);
    const capture = recoveryProjectIndex();
    const index = await writeCreatorProjectIndexArtifacts(store, capture);
    const ownership = createStudioOwnershipMap({
      projectId: session.projectId,
      revisionHash: capture.revision.hash,
      projectIndex: studioProjectIndexMetadataView(capture),
    });
    let creator = createCreatorSession({
      prompt: "Polish the HUD",
      projectId: session.projectId,
      revisionHash: capture.revision.hash,
      projectCaptureHash: capture.hash,
      ownership,
    });
    for (const status of [
      "planning",
      "awaiting_plan_approval",
      "building",
      "awaiting_change_approval",
      "preflighting",
      "applying",
      "recovery_required",
    ] as const)
      creator = advanceSession(creator, { status });
    const cursor = {
      changeSetId: "change_set_closed",
      changeSetHash: "c".repeat(64),
      projectionId: "projection_closed",
      projectionHash: "d".repeat(64),
      manifest: { hash: STUDIO_CAPABILITY_MANIFEST_HASH },
      recordingId: "recording_closed",
      beforeIndexCapture: index,
    };
    const bundle = { session: creator, activeMutation: cursor } as unknown as CreatorSessionBundle;
    const payload = {
      creatorSessionId: creator.id,
      changeSetId: cursor.changeSetId,
      changeSetHash: cursor.changeSetHash,
      projectionId: cursor.projectionId,
      projectionHash: cursor.projectionHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      recordingId: cursor.recordingId,
      beforeProjectIndexManifestId: capture.indexManifest.id,
      beforeProjectRevisionHash: capture.revision.hash,
      beforeProjectDetectorEpoch: capture.detectorEpoch,
      recoveryProjectIndexManifestId: capture.indexManifest.id,
      recoveryProjectRevisionHash: capture.revision.hash,
      recoveryProjectDetectorEpoch: capture.detectorEpoch,
    };
    const recovery = await store.write({
      kind: "CreatorRecordingRecoveryRecord",
      studioSessionId: session.sessionId,
      projectId: session.projectId,
      payload: { ...payload, recordingState: "not_open" },
      projectIndex: index,
    });
    const receipt = {
      kind: "CreatorClosedRecordingAcknowledgement",
      studioSessionId: session.sessionId,
      projectId: session.projectId,
      recovery,
      payload: { ...payload, status: "closed_cursor_cleared" },
    };
    const acknowledgement = await store.write(receipt);
    const closed = await closeInterruptedCreatorRecording(bundle, acknowledgement, store);
    assert.equal(closed.session.status, "incomplete");
    assert.equal(closed.session.failure?.code, "interrupted_recording_not_open");
    assert.equal(closed.activeMutation, undefined);
    assert.deepEqual(closed.closedMutation, { cursor, acknowledgement });
    assert.equal(bundle.session.status, "recovery_required");
    assert.deepEqual(await store.read(await store.write(closed)), closed);
    for (const changed of [
      { recordingId: "unrelated_recording" },
      { manifestHash: "e".repeat(64) },
      { changeSetHash: "f".repeat(64) },
      { recoveryProjectDetectorEpoch: 5 },
      { beforeProjectRevisionHash: "f".repeat(64) },
    ]) {
      const tampered = await store.write({
        ...receipt,
        payload: { ...receipt.payload, ...changed },
      });
      await assert.rejects(
        closeInterruptedCreatorRecording(bundle, tampered, store),
        /does not match/,
      );
    }
    const stillOpen = await store.write({
      kind: "CreatorRecordingRecoveryRecord",
      studioSessionId: session.sessionId,
      projectId: session.projectId,
      payload: { ...payload, recordingState: "open" },
      projectIndex: index,
    });
    await assert.rejects(
      closeInterruptedCreatorRecording(
        bundle,
        await store.write({ ...receipt, recovery: stillOpen }),
        store,
      ),
      /not-open recovery proof/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function recoveryProjectIndex() {
  const connectorEpoch = createStudioConnectorEpoch({
    sessionId: session.sessionId,
    projectId: session.projectId,
    connectorBuildHash: session.connectorBuildHash,
  });
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch,
    purpose: "creator_project_index",
    roots: [
      "Lighting",
      "ReplicatedFirst",
      "ReplicatedStorage",
      "ServerScriptService",
      "ServerStorage",
      "SoundService",
      "StarterGui",
      "StarterPack",
      "StarterPlayer",
      "Teams",
      "Workspace",
    ],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  return createStudioProjectIndexCapture({
    projection,
    shards: projection.roots.map((root) =>
      createStudioProjectEvidenceShard({ root, ordinal: 0, nodes: [] }),
    ),
    sourceManifests: [],
    sourceChunks: [],
    completedAt: sentAt,
    detectorEpoch: 0,
  });
}

function projectIndexStream(
  capture: ReturnType<typeof recoveryProjectIndex>,
  requestId: string,
): PluginToBackendMessage[] {
  const fragments = capture.shards.map((shard, sequence) => {
    const payload = stableJson(shard);
    return {
      kind: "StudioProtocolMessage" as const,
      direction: "plugin_to_backend" as const,
      type: "StudioProjectEvidenceShard" as const,
      messageId: `${requestId}-shard-${sequence}`,
      requestId,
      sessionId: session.sessionId,
      sentAt,
      payload: {
        project,
        captureId: capture.indexManifest.id,
        sequence,
        artifact: { kind: shard.kind, id: shard.id, hash: shard.hash },
        fragmentOrdinal: 0,
        fragmentCount: 1,
        encoding: "json" as const,
        payload,
        payloadHash: contentHash(payload),
      },
    };
  });
  const { sourceManifestHashes: _sourceManifestHashes, ...indexManifest } = capture.indexManifest;
  return [
    {
      kind: "StudioProtocolMessage",
      direction: "plugin_to_backend",
      type: "StudioProjectIndexStarted",
      messageId: `${requestId}-started`,
      requestId,
      sessionId: session.sessionId,
      sentAt,
      payload: {
        project,
        captureId: capture.indexManifest.id,
        projection: capture.projection,
        pieceCount: fragments.length,
        expectedShardCount: capture.shards.length,
        expectedSourceManifestCount: 0,
        expectedSourceChunkCount: 0,
        expectedCanonicalBytes: capture.indexManifest.canonicalBytes,
        detectorEpoch: 0,
      },
    },
    ...fragments,
    {
      kind: "StudioProtocolMessage",
      direction: "plugin_to_backend",
      type: "StudioProjectIndexCompleted",
      messageId: `${requestId}-completed`,
      requestId,
      sessionId: session.sessionId,
      sentAt,
      payload: {
        project,
        captureId: capture.indexManifest.id,
        pieceCount: fragments.length,
        indexManifest: { ...indexManifest, sourceManifestCount: 0 },
        revision: capture.revision,
        captureHash: capture.hash,
        detectorEpoch: 0,
      },
    },
  ];
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for recovery handshake");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function eventuallyDashboard(
  coordinator: CreatorSessionCoordinator,
  check: (message: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const message = (await coordinator.dashboardState()).pairedStudio.message;
    if (check(message)) return message;
    if (Date.now() >= deadline) throw new Error("timed out waiting for dashboard recovery state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("an unreadable native inventory revokes a previously clean admission scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-unreadable-recording-"));
  let handler:
    | ((message: PluginToBackendMessage, studio: StudioBridgeSession) => void | Promise<void>)
    | undefined;
  const sent: BackendToPluginMessage[] = [];
  const coordinator = new CreatorSessionCoordinator({
    directory: root,
    timeoutMs: 100,
    connection: {
      async send(message: BackendToPluginMessage) {
        sent.push(message);
      },
      subscribeWithSession(next: NonNullable<typeof handler>) {
        handler = next;
        return () => {};
      },
      getSessions: () => [session],
    } as unknown as StudioBridgeConnection,
    worker: {} as CreatorAgentWorker,
    sourceAnalysisHost: {
      async analyze() {
        throw new Error("Inventory admission must not analyze sources");
      },
    },
  });
  const state = coordinator as unknown as {
    requireClearRecordingInventory(studio: StudioBridgeSession): Promise<void>;
    bundles: Map<string, CreatorSessionBundle>;
    views: Map<string, unknown>;
  };
  try {
    assert.ok(handler);
    await handler(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "CreatorRecordingRecovery",
        messageId: "inventory-clean",
        sentAt,
        payload: { recordingState: "none" },
      },
      session,
    );
    await state.requireClearRecordingInventory(session);
    assert.equal(
      (await coordinator.dashboardState()).pairedStudio.transactionInventoryStatus,
      "clear",
    );

    const failure = {
      kind: "StudioProtocolMessage",
      direction: "plugin_to_backend",
      type: "PluginError",
      messageId: "inventory-unreadable",
      sentAt,
      payload: {
        code: "RECOVERY_REQUIRED",
        message: "Stored Forge transaction data cannot be read. Studio writes are blocked.",
        retryable: false,
      },
    } as const;
    await handler({ ...failure, requestId: "scoped-command-failure" }, session);
    await state.requireClearRecordingInventory(session);

    const retained = {
      session: { id: "retained", projectId: session.projectId },
      activeMutation: { recordingId: "retained-recording" },
    } as unknown as CreatorSessionBundle;
    const unrelated = {
      session: { id: "unrelated", projectId: "another-project" },
    } as unknown as CreatorSessionBundle;
    state.bundles.set("retained", retained);
    state.bundles.set("unrelated", unrelated);
    state.views.set("retained", { cached: true });
    state.views.set("unrelated", { cached: true });
    await handler(failure, session);
    assert.equal(state.views.has("retained"), false);
    assert.equal(state.views.has("unrelated"), true);
    assert.equal(
      state.bundles.get("retained"),
      retained,
      "Retained transaction truth is unchanged",
    );
    state.bundles.clear();
    state.views.clear();
    const dashboard = await coordinator.dashboardState();
    assert.equal(dashboard.pairedStudio.transactionInventoryStatus, "blocked");
    assert.equal(dashboard.pairedStudio.message, failure.payload.message);
    await assert.rejects(
      state.requireClearRecordingInventory(session),
      /transaction data cannot be read/,
    );
    assert.deepEqual(sent, [], "Inventory failure must not issue recovery or mutation commands");
  } finally {
    coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an orphaned proved-closed recording is blocked until its exact acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-recording-recovery-"));
  let handler:
    | ((message: PluginToBackendMessage, session: StudioBridgeSession) => void | Promise<void>)
    | undefined;
  const subscribers = new Set<NonNullable<typeof handler>>();
  const sent: BackendToPluginMessage[] = [];
  let pluginMessagePostActive = false;
  const connection = {
    async send(message: BackendToPluginMessage) {
      sent.push(message);
      if (message.type === "CollectStudioProjectIndex") {
        const capture = recoveryProjectIndex();
        setTimeout(async () => {
          // Roblox cannot poll the command which triggers this stream until
          // its current synchronous RequestAsync POST has returned.
          while (pluginMessagePostActive) await new Promise((resolve) => setTimeout(resolve, 1));
          for (const streamed of projectIndexStream(capture, message.payload.requestId))
            for (const subscriber of subscribers) void subscriber(streamed, session);
        }, 0);
      }
    },
    async sendAndWaitForSettlement(message: BackendToPluginMessage) {
      await this.send(message);
    },
    subscribeWithSession(next: typeof handler) {
      if (!next) throw new Error("subscriber is required");
      subscribers.add(next);
      handler ??= next;
      return () => {
        subscribers.delete(next);
        if (handler === next) handler = [...subscribers][0];
      };
    },
    getSessions() {
      return [session];
    },
    async close() {},
  } as StudioBridgeConnection & { getSessions(): StudioBridgeSession[] };
  let workerCalled = false;
  const worker = {
    descriptor: {
      kind: "CreatorAgentWorkerDescriptor",
      name: "forge-local-creator-agent-worker",
      environment: "local_process",
      isolation: "none",
    },
    async plan() {
      workerCalled = true;
      throw new Error("worker must not run during recovery");
    },
    async build() {
      workerCalled = true;
      throw new Error("worker must not run during recovery");
    },
  } as CreatorAgentWorker;
  const coordinator = new CreatorSessionCoordinator({
    connection,
    worker,
    directory: root,
    sourceAnalysisHost: {
      async analyze() {
        throw new Error("recovery must not analyze source");
      },
    },
    timeoutMs: 500,
  });
  try {
    assert.ok(handler);
    await handler!(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "PairProject",
        messageId: "pair-recovery",
        sentAt,
        payload: {
          pairingToken: "pairing-token-recovery",
          project,
          projectIdentity: createStudioProjectIdentityState({
            project,
            reservedAttribute: { status: "absent" },
          }),
          projectIdentityTransaction: { status: "none" },
          capabilities,
          connectorBuildHash: session.connectorBuildHash,
          manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
        },
      },
      session,
    );
    const recoveryIndex = recoveryProjectIndex();
    const binding = {
      creatorSessionId: "creator_session_missing_after_reset",
      changeSetId: "creator_change_set_missing_after_reset",
      changeSetHash: "4".repeat(64),
      projectionId: "studio_mutation_projection_missing_after_reset",
      projectionHash: "5".repeat(64),
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      beforeProjectIndexManifestId: recoveryIndex.indexManifest.id,
      beforeProjectRevisionHash: recoveryIndex.revision.hash,
      beforeProjectDetectorEpoch: recoveryIndex.detectorEpoch,
      recordingId: "recording_missing_after_reset",
    };
    // The current connector always streams the exact recovery projection
    // before posting its semantic recovery receipt. The host must consume that
    // unsolicited stream globally so semantic handling never has to enqueue a
    // command that the plugin cannot poll while RequestAsync is still active.
    for (const streamed of projectIndexStream(recoveryIndex, "recovery-index-stream")) {
      const { requestId: _requestId, ...unscoped } = streamed;
      await handler!(unscoped as PluginToBackendMessage, session);
    }
    pluginMessagePostActive = true;
    const recoveryDelivery = Promise.resolve(
      handler!(
        {
          kind: "StudioProtocolMessage",
          direction: "plugin_to_backend",
          type: "CreatorRecordingRecovery",
          messageId: "recovery-not-open",
          sentAt,
          payload: {
            ...binding,
            recordingState: "not_open",
            recoveryProjectIndexManifestId: recoveryIndex.indexManifest.id,
            recoveryProjectRevisionHash: recoveryIndex.revision.hash,
            recoveryProjectDetectorEpoch: recoveryIndex.detectorEpoch,
          },
        },
        session,
      ),
    );
    const ingressReturnedBeforePluginCanPoll = await Promise.race([
      recoveryDelivery.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    pluginMessagePostActive = false;
    await recoveryDelivery;
    assert.equal(
      ingressReturnedBeforePluginCanPoll,
      true,
      "recovery ingress must resolve from the preceding unsolicited index without another plugin poll",
    );
    assert.equal(
      sent.some((message) => message.type === "CollectStudioProjectIndex"),
      false,
      "retained transaction recovery must never synchronously request a second index",
    );
    await eventually(() =>
      sent.some((message) => message.type === "AcknowledgeClosedCreatorRecording"),
    ).catch(async (error: unknown) => {
      const dashboard = await coordinator.dashboardState();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: ${dashboard.pairedStudio.message}`,
      );
    });
    const blocked = await coordinator.dashboardState();
    assert.match(blocked.pairedStudio.message, /waiting for exact durable acknowledgement/i);
    assert.equal(workerCalled, false);

    const acknowledgement = sent.find(
      (
        message,
      ): message is Extract<
        BackendToPluginMessage,
        { type: "AcknowledgeClosedCreatorRecording" }
      > => message.type === "AcknowledgeClosedCreatorRecording",
    );
    assert.ok(acknowledgement);
    const acknowledgementRequestId = acknowledgement.requestId;
    assert.ok(acknowledgementRequestId);
    await handler!(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "CreatorClosedRecordingAcknowledged",
        messageId: "closed-acknowledged",
        requestId: acknowledgementRequestId,
        sentAt,
        payload: {
          ...binding,
          recoveryProjectIndexManifestId: recoveryIndex.indexManifest.id,
          recoveryProjectRevisionHash: recoveryIndex.revision.hash,
          recoveryProjectDetectorEpoch: recoveryIndex.detectorEpoch,
          status: "closed_cursor_cleared",
        },
      },
      session,
    );
    const releasedMessage = await eventuallyDashboard(
      coordinator,
      (message) => !/recovery required|durable acknowledgement/i.test(message),
    );
    assert.doesNotMatch(releasedMessage, /recovery required|durable acknowledgement/i);
    assert.equal(workerCalled, false);

    const finalizationAckCount = sent.filter(
      (message) => message.type === "AcknowledgeCreatorChangeFinalization",
    ).length;
    const lateRequestId = "creator_finalize_waiter_expired";
    const finalizationPayload = {
      ...binding,
      action: "cancel" as const,
      finalizationKind: "ordinary" as const,
      status: "cancelled" as const,
      afterProjectIndexManifestId: recoveryIndex.indexManifest.id,
      afterProjectRevisionHash: recoveryIndex.revision.hash,
      afterProjectDetectorEpoch: recoveryIndex.detectorEpoch,
      expectedCurrentProjectIndexManifestId: recoveryIndex.indexManifest.id,
      expectedCurrentProjectRevisionHash: recoveryIndex.revision.hash,
      expectedCurrentProjectDetectorEpoch: recoveryIndex.detectorEpoch,
    };
    const finalizationOwnership = coordinator as unknown as {
      beginFinalizationRequest(requestId: string): void;
      endFinalizationRequest(requestId: string): void;
    };
    finalizationOwnership.beginFinalizationRequest(lateRequestId);
    await handler!(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "CreatorChangeFinalized",
        messageId: "owned-finalization-delivery",
        requestId: lateRequestId,
        sentAt,
        payload: finalizationPayload,
      },
      session,
    );
    assert.equal(
      sent.filter((message) => message.type === "AcknowledgeCreatorChangeFinalization").length,
      finalizationAckCount,
      "a live exact waiter owns the first delivery",
    );
    finalizationOwnership.endFinalizationRequest(lateRequestId);
    pluginMessagePostActive = true;
    const orphanFinalizationDelivery = Promise.resolve(
      handler!(
        {
          kind: "StudioProtocolMessage",
          direction: "plugin_to_backend",
          type: "CreatorChangeFinalized",
          messageId: "late-finalization-replay",
          requestId: lateRequestId,
          sentAt,
          payload: finalizationPayload,
        },
        session,
      ),
    );
    const finalizationIngressReturned = await Promise.race([
      orphanFinalizationDelivery.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    pluginMessagePostActive = false;
    await orphanFinalizationDelivery;
    assert.equal(
      finalizationIngressReturned,
      true,
      "an orphan finalization receipt must be retained and acknowledged without a nested Studio command",
    );
    await eventually(
      () =>
        sent.filter((message) => message.type === "AcknowledgeCreatorChangeFinalization").length ===
        finalizationAckCount + 1,
    );
    const finalizationAck = [...sent]
      .reverse()
      .find(
        (
          message,
        ): message is Extract<
          BackendToPluginMessage,
          { type: "AcknowledgeCreatorChangeFinalization" }
        > => message.type === "AcknowledgeCreatorChangeFinalization",
      );
    assert.ok(finalizationAck?.requestId);
    assert.match(
      (await coordinator.dashboardState()).pairedStudio.message,
      /finalization receipt/i,
    );
    await handler!(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "CreatorChangeFinalized",
        messageId: "orphan-finalization-replay-duplicate",
        requestId: lateRequestId,
        sentAt,
        payload: finalizationPayload,
      },
      session,
    );
    const duplicateFinalizationAck = [...sent]
      .reverse()
      .find(
        (
          message,
        ): message is Extract<
          BackendToPluginMessage,
          { type: "AcknowledgeCreatorChangeFinalization" }
        > => message.type === "AcknowledgeCreatorChangeFinalization",
      );
    assert.equal(duplicateFinalizationAck?.requestId, finalizationAck.requestId);

    // This was the production race: an unrelated no-recording report followed
    // the receipt replay and incorrectly released the project for Prepare.
    await handler!(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "CreatorRecordingRecovery",
        messageId: "uncorrelated-recovery-none",
        sentAt,
        payload: { recordingState: "none" },
      },
      session,
    );
    await eventuallyDashboard(coordinator, (message) =>
      /unrelated recording-inventory report/i.test(message),
    );
    await assert.rejects(
      (
        coordinator as unknown as {
          requireClearRecordingInventory(studio: StudioBridgeSession): Promise<void>;
        }
      ).requireClearRecordingInventory(session),
      /unrelated recording-inventory report/i,
    );

    await handler!(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "CreatorRecordingRecovery",
        messageId: "correlated-recovery-none",
        requestId: finalizationAck.requestId,
        sentAt,
        payload: {
          recordingState: "none",
          finalizationRequestId: finalizationAck.requestId,
        },
      },
      session,
    );
    const finalReleasedMessage = await eventuallyDashboard(
      coordinator,
      (message) => !/finalization receipt|unrelated recording-inventory/i.test(message),
    );
    assert.doesNotMatch(
      finalReleasedMessage,
      /finalization receipt|unrelated recording-inventory/i,
    );
    await (
      coordinator as unknown as {
        requireClearRecordingInventory(studio: StudioBridgeSession): Promise<void>;
      }
    ).requireClearRecordingInventory(session);
    assert.equal(workerCalled, false);
  } finally {
    coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});
