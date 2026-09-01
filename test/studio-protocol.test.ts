import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST_HASH,
  STUDIO_CONNECTOR_BUILD_HASH,
  compileMutationEvidenceProjection,
  compileProjectStateProjection,
  createStudioEvidenceEnvelope,
  serializeStudioEvidenceProjection,
  studioEvidenceFactKey,
  type StudioEvidenceTarget,
} from "../packages/studio-evidence/src/index.js";
import {
  assertBackendToPluginMessage,
  assertPluginToBackendMessage,
  type PluginToBackendMessage,
  type StudioCapability,
} from "../packages/studio-protocol/src/index.js";
import { StudioBridgeServer } from "../packages/studio-bridge/src/index.js";

const sentAt = "2026-09-01T00:00:00.000Z";
const project = { name: "Protocol Evidence", placeId: 1, universeId: 2 };
const target: StudioEvidenceTarget = { kind: "instance", stableId: "prompt-1", path: "Workspace/Door/Prompt", className: "ProximityPrompt" };
const capabilities: StudioCapability[] = [
  "studio_evidence", "evidence_chunks", "sha256", "stable_identity", "reflection_attestation", "detached_preflight", "transactional_authoring", "recording_recovery", "studio_play_mode", "bounded_diagnostics", "http_polling",
];

function envelopeForProjection(projection: ReturnType<typeof compileMutationEvidenceProjection>, fact: Parameters<typeof createStudioEvidenceEnvelope>[0]["facts"][number]) {
  return createStudioEvidenceEnvelope({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    bindingHash: projection.bindingHash,
    project,
    authoritative: true,
    startedAt: sentAt,
    endedAt: "2026-09-01T00:00:01.000Z",
    completion: "complete",
    facts: [fact],
  }, projection);
}

test("pairing is bound to the generated manifest and exact capability attestation surface", () => {
  const pair: PluginToBackendMessage = {
    kind: "StudioProtocolMessage", direction: "plugin_to_backend", type: "PairProject", messageId: "pair-1", sentAt,
    payload: { pairingToken: "pairing-token", project, capabilities, connectorBuildHash: "a".repeat(64), manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH },
  };
  assertPluginToBackendMessage(pair);
  assertPluginToBackendMessage({ ...pair, payload: { ...pair.payload, manifestHash: "0".repeat(64) } });
  assert.throws(() => assertPluginToBackendMessage({ ...pair, payload: { ...pair.payload, manifestHash: "not-a-hash" } }), /PairProject/);
  assert.throws(() => assertPluginToBackendMessage({ ...pair, payload: { ...pair.payload, capabilities: capabilities.slice(1) } }), /PairProject/);
});

test("protocol preserves explicit false as observed mutation evidence", () => {
  const projection = compileMutationEvidenceProjection({
    id: "protocol-false", project, binding: { sessionId: "protocol-session", changeSetHash: "protocol-change" },
    operations: [{ id: "set-line-of-sight", kind: "update", target, properties: { RequiresLineOfSight: { kind: "boolean", value: false } } }],
  });
  const fact = { kind: "property" as const, key: studioEvidenceFactKey("property", target, "RequiresLineOfSight"), target, propertyName: "RequiresLineOfSight", result: { status: "observed" as const, value: { kind: "boolean" as const, value: false } } };
  const envelope = envelopeForProjection(projection, fact);
  const message: PluginToBackendMessage = {
    kind: "StudioProtocolMessage", direction: "plugin_to_backend", type: "StudioEvidenceProduced", messageId: "evidence-false", sentAt,
    payload: { project, reason: "post_apply", projection, envelope },
  };
  assertPluginToBackendMessage(message);
  assert.equal((message.payload.envelope.facts[0]?.result as { status: string; value?: { value?: boolean } }).value?.value, false);
  assert.throws(() => assertPluginToBackendMessage({ ...message, payload: { ...message.payload, envelope: { ...envelope, facts: [{ ...fact, result: { status: "observed", value: { kind: "boolean", value: true } } }] } } }), /content hash/);
});

test("protocol accepts deletion only as an explicit absent structure fact", () => {
  const projection = compileMutationEvidenceProjection({
    id: "protocol-delete", project, binding: { sessionId: "protocol-delete-session", changeSetHash: "protocol-delete-change" },
    operations: [{ id: "delete-prompt", kind: "delete", target }],
  });
  const fact = { kind: "structure" as const, key: studioEvidenceFactKey("structure", target), target, result: { status: "absent" as const } };
  const envelope = envelopeForProjection(projection, fact);
  assertPluginToBackendMessage({
    kind: "StudioProtocolMessage", direction: "plugin_to_backend", type: "StudioEvidenceProduced", messageId: "evidence-delete", sentAt,
    payload: { project, reason: "post_apply", projection, envelope },
  });
  assert.throws(() => envelopeForProjection(projection, { ...fact, result: { status: "observed", value: { stableId: target.stableId, path: target.path, className: target.className } } }), /incomplete required evidence/);
});

test("projection-bound requests reject noncanonical and legacy observation messages", () => {
  const projection = compileMutationEvidenceProjection({
    id: "protocol-request", project, binding: { sessionId: "protocol-request-session", changeSetHash: "protocol-request-change" },
    operations: [{ id: "set-prompt", kind: "update", target, properties: { Enabled: { kind: "boolean", value: false } } }],
  });
  const projectionJson = serializeStudioEvidenceProjection(projection);
  const request = {
    kind: "StudioProtocolMessage" as const, direction: "backend_to_plugin" as const, type: "RequestStudioEvidence" as const, messageId: "request-evidence", sentAt,
    payload: { requestId: "request-evidence", reason: "post_apply" as const, projectionJson, projectionJsonHash: contentHash(projectionJson), projectionHash: projection.contentHash },
  };
  assertBackendToPluginMessage(request);
  assert.throws(() => assertBackendToPluginMessage({ ...request, payload: { ...request.payload, projectionJson: `${projectionJson} ` } }), /projection JSON/);
  assert.throws(() => assertBackendToPluginMessage({ ...request, payload: { ...request.payload, projectionJsonHash: projection.contentHash } }), /projection JSON/);
  assert.throws(() => assertBackendToPluginMessage({ ...request, payload: { ...request.payload, projectionHash: contentHash(projectionJson) } }), /projection JSON/);
  assert.throws(() => assertPluginToBackendMessage({ kind: "StudioProtocolMessage", direction: "plugin_to_backend", type: "SnapshotChunk", messageId: "legacy", sentAt, payload: {} }), /message type/);

  const chunk = { kind: "StudioProtocolMessage" as const, direction: "plugin_to_backend" as const, type: "StudioEvidenceChunk" as const, messageId: "chunk-1", sentAt, payload: { project, reason: "post_apply" as const, evidenceId: "evidence-1", index: 0, total: 1, encoding: "json" as const, payload: projectionJson, payloadHash: contentHash(projectionJson) } };
  assertPluginToBackendMessage(chunk);
});

test("recording recovery requires an explicit inventory and exact closed-cursor acknowledgement", () => {
  const creatorSessionId = "creator_session_recovery";
  const changeSetHash = "a".repeat(64);
  const recoveryProjection = compileProjectStateProjection({
    id: "studio_recovery_projection",
    project,
    binding: { sessionId: creatorSessionId, changeSetHash },
  });
  const inventoryTarget = { kind: "project" as const };
  const recoveryEvidence = createStudioEvidenceEnvelope(
    {
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      projectionId: recoveryProjection.id,
      projectionHash: recoveryProjection.contentHash,
      bindingHash: recoveryProjection.bindingHash,
      project,
      authoritative: true,
      startedAt: sentAt,
      endedAt: "2026-09-01T00:00:01.000Z",
      completion: "complete",
      facts: [
        {
          kind: "inventory",
          key: studioEvidenceFactKey("inventory", inventoryTarget),
          target: inventoryTarget,
          result: { status: "observed", value: [] },
        },
      ],
    },
    recoveryProjection,
  );
  const binding = {
    creatorSessionId,
    changeSetId: "creator_change_set_recovery",
    changeSetHash,
    projectionId: "studio_mutation_projection_recovery",
    projectionHash: "b".repeat(64),
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    beforeRevisionHash: "c".repeat(64),
    recordingId: "recording_recovery",
  };
  assertPluginToBackendMessage({
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "CreatorRecordingRecovery",
    messageId: "recovery-not-open",
    sentAt,
    payload: {
      ...binding,
      recordingState: "not_open",
      evidenceProjection: recoveryProjection,
      evidence: recoveryEvidence,
    },
  });
  assertPluginToBackendMessage({
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "CreatorRecordingRecovery",
    messageId: "recovery-none",
    sentAt,
    payload: { recordingState: "none" },
  });
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "CreatorRecordingRecovery",
        messageId: "recovery-ambiguous-none",
        sentAt,
        payload: { recordingState: "none", recordingId: "stale" },
      }),
    /CreatorRecordingRecovery/,
  );
  assertBackendToPluginMessage({
    kind: "StudioProtocolMessage",
    direction: "backend_to_plugin",
    type: "AcknowledgeClosedCreatorRecording",
    messageId: "ack-closed",
    requestId: "ack-closed",
    sentAt,
    payload: {
      requestId: "ack-closed",
      ...binding,
      recoveryProjectionHash: recoveryProjection.contentHash,
      recoveryEvidenceHash: recoveryEvidence.contentHash,
    },
  });
});

test("the bridge rejects a stale connector identity before creating a session", async () => {
  const bridge = new StudioBridgeServer({ port: 0 });
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const pairingResponse = await fetch(`${origin}/pairing`);
    const pairing = (await pairingResponse.json()) as {
      pairing: { token: string };
    };
    const pairMessage = (token: string, connectorBuildHash: string) => ({
      kind: "StudioProtocolMessage",
      direction: "plugin_to_backend",
      type: "PairProject",
      messageId: `pair-${connectorBuildHash.slice(0, 8)}`,
      sentAt,
      payload: {
        pairingToken: token,
        project,
        capabilities,
        connectorBuildHash,
        manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      },
    });
    const stale = await fetch(`${origin}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pairMessage(pairing.pairing.token, "0".repeat(64))),
    });
    assert.equal(stale.status, 409);
    assert.match(
      ((await stale.json()) as { message: string }).message,
      /connector protocol is incompatible/i,
    );
    assert.equal(bridge.getSessions().length, 0);

    const freshPairing = (await (
      await fetch(`${origin}/pairing`)
    ).json()) as { pairing: { token: string } };
    const accepted = await fetch(`${origin}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        pairMessage(freshPairing.pairing.token, STUDIO_CONNECTOR_BUILD_HASH),
      ),
    });
    assert.equal(accepted.status, 200);
    assert.equal(
      ((await accepted.json()) as { connectorBuildHash: string })
        .connectorBuildHash,
      STUDIO_CONNECTOR_BUILD_HASH,
    );
    assert.equal(bridge.getSessions().length, 1);
  } finally {
    await bridge.close();
  }
});
