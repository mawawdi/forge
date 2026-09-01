import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import {
  STUDIO_CAPABILITY_MANIFEST_HASH,
  compileProjectStateProjection,
  createStudioEvidenceEnvelope,
  studioEvidenceFactKey,
} from "../packages/studio-evidence/src/index.js";
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
  "evidence_chunks",
  "sha256",
  "stable_identity",
  "reflection_attestation",
  "detached_preflight",
  "transactional_authoring",
  "recording_recovery",
  "studio_play_mode",
  "bounded_diagnostics",
  "http_polling",
];
const session: StudioBridgeSession = {
  sessionId: "studio_session_recovery",
  projectId: "studio_project_recovery",
  project,
  capabilities,
  manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
  connectorBuildHash: "1".repeat(64),
  capabilityAttestationProjectionHash: "2".repeat(64),
  projectStateProjectionHash: "3".repeat(64),
  sessionToken: "studio_session_token_recovery",
  connectedAt: sentAt,
};

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
  const sent: BackendToPluginMessage[] = [];
  const connection = {
    async send(message: BackendToPluginMessage) {
      sent.push(message);
    },
    subscribeWithSession(next: typeof handler) {
      handler = next;
      return () => {
        if (handler === next) handler = undefined;
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
          capabilities,
          connectorBuildHash: session.connectorBuildHash,
          manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
        },
      },
      session,
    );
    const binding = {
      creatorSessionId: "creator_session_missing_after_reset",
      changeSetId: "creator_change_set_missing_after_reset",
      changeSetHash: "4".repeat(64),
      projectionId: "studio_mutation_projection_missing_after_reset",
      projectionHash: "5".repeat(64),
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      beforeRevisionHash: "6".repeat(64),
      recordingId: "recording_missing_after_reset",
    };
    const projection = compileProjectStateProjection({
      id: "studio_recovery_state_missing_after_reset",
      project,
      binding: {
        sessionId: binding.creatorSessionId,
        changeSetHash: binding.changeSetHash,
      },
    });
    const target = { kind: "project" as const };
    const evidence = createStudioEvidenceEnvelope(
      {
        manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
        projectionId: projection.id,
        projectionHash: projection.contentHash,
        bindingHash: projection.bindingHash,
        project,
        authoritative: true,
        startedAt: sentAt,
        endedAt: "2026-09-01T00:00:01.000Z",
        completion: "complete",
        facts: [
          {
            kind: "inventory",
            key: studioEvidenceFactKey("inventory", target),
            target,
            result: { status: "observed", value: [] },
          },
        ],
      },
      projection,
    );
    await handler!(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "CreatorRecordingRecovery",
        messageId: "recovery-not-open",
        sentAt,
        payload: {
          ...binding,
          recordingState: "not_open",
          evidenceProjection: projection,
          evidence,
        },
      },
      session,
    );
    await eventually(
      () => sent.some((message) => message.type === "AcknowledgeClosedCreatorRecording"),
    );
    const blocked = await coordinator.dashboardState();
    assert.match(blocked.pairedStudio.message, /waiting for the exact durable acknowledgement/i);
    assert.equal(workerCalled, false);

    const acknowledgement = sent.find(
      (message): message is Extract<BackendToPluginMessage, { type: "AcknowledgeClosedCreatorRecording" }> =>
        message.type === "AcknowledgeClosedCreatorRecording",
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
          recoveryProjectionHash: projection.contentHash,
          recoveryEvidenceHash: evidence.contentHash,
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
  } finally {
    coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});
