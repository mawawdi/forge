import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioConnectorEpoch,
  createStudioProjectEvidenceShard,
  createStudioProjectIndexCapture,
  createStudioProjectIndexProjection,
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
