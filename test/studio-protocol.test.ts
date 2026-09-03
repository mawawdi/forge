import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  STUDIO_CONNECTOR_BUILD_HASH,
  compileMutationEvidenceProjection,
  createCreatorSourceWriteBlobCapture,
  createStudioEvidenceEnvelope,
  createStudioProjectEvidenceShard,
  createStudioProjectIndexCapture,
  createStudioProjectIndexProjection,
  serializeStudioEvidenceProjection,
  studioEvidenceFactKey,
  type StudioEvidenceFact,
  type StudioEvidenceTarget,
} from "../packages/studio-evidence/src/index.js";
import {
  assertBackendToPluginMessage,
  assertPluginToBackendMessage,
  BACKEND_COMMAND_FRAGMENT_BYTES,
  createCreatorChangePrepareTransfer,
  createStudioSemanticMessageTransfer,
  MAX_PROTOCOL_MESSAGE_BYTES,
  STUDIO_PROJECT_CHANGE_SOURCES,
  STUDIO_SEMANTIC_FRAGMENT_BYTES,
  type CreatorChangePrepareDocument,
  type PluginToBackendMessage,
  type StudioCapability,
  type StudioStreamedSemanticMessage,
} from "../packages/studio-protocol/src/index.js";
import { createCreatorProjectChangeNotice } from "../packages/creator-session/src/project-refresh.js";
import {
  StudioBridgeClient,
  StudioBridgeServer,
  createBackendMessage,
  type StudioBridgeSession,
} from "../packages/studio-bridge/src/index.js";

const sentAt = "2026-09-01T00:00:00.000Z";
const project = { name: "Protocol Evidence", placeId: 1, universeId: 2 };
const connectorEpoch = "connector_epoch_protocol";
const target: Extract<StudioEvidenceTarget, { readonly kind: "instance" }> = {
  kind: "instance",
  identity: { kind: "forge_attribute", stableId: "prompt-1" },
  path: "Workspace/Door/Prompt",
  className: "ProximityPrompt",
};
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
  "http_polling",
];

function creatorChangePrepareDocument(changeSetJson: string): CreatorChangePrepareDocument {
  const binding = {
    sessionId: "creator_prepare_session",
    changeSetHash: "b".repeat(64),
    approvalHash: "c".repeat(64),
    revisionHash: "d".repeat(64),
    buildHash: "e".repeat(64),
    dashboardReviewHash: "f".repeat(64),
  };
  const operations = [
    {
      id: "prepare-false",
      kind: "update" as const,
      target,
      properties: { RequiresLineOfSight: { kind: "boolean" as const, value: false } },
    },
  ];
  const projection = compileMutationEvidenceProjection({
    id: "creator-prepare-readback",
    project,
    binding,
    operations,
  });
  const preflightProjection = compileMutationEvidenceProjection({
    id: "creator-prepare-preflight",
    project,
    binding,
    operations,
    purpose: "mutation_preflight",
  });
  const projectionJson = serializeStudioEvidenceProjection(projection);
  const preflightProjectionJson = serializeStudioEvidenceProjection(preflightProjection);
  return {
    requestId: "creator_prepare_request",
    creatorSessionId: binding.sessionId,
    expectedProjectRevisionHash: binding.revisionHash,
    changeSetJson,
    changeSetJsonHash: contentHash(changeSetJson),
    changeSetId: "creator_change_set_prepare",
    changeSetHash: binding.changeSetHash,
    approvalHash: binding.approvalHash,
    dashboardReviewHash: binding.dashboardReviewHash,
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    projectionJson,
    projectionJsonHash: contentHash(projectionJson),
    projectionHash: projection.contentHash,
    preflightProjectionJson,
    preflightProjectionJsonHash: contentHash(preflightProjectionJson),
    preflightProjectionHash: preflightProjection.contentHash,
    beforeProjectIndexManifestId: "studio_project_index_prepare",
    beforeProjectRevisionHash: binding.revisionHash,
    beforeProjectDetectorEpoch: 0,
  };
}

function streamedEvidenceMessage(
  sessionId: string,
  factCount: number,
): Extract<PluginToBackendMessage, { type: "StudioEvidenceProduced" }> {
  const binding = { sessionId: "semantic_creator_session", changeSetHash: "a".repeat(64) };
  const operations = Array.from({ length: factCount }, (_, index) => ({
    id: `semantic-update-${index}`,
    kind: "update" as const,
    target: {
      kind: "instance" as const,
      identity: {
        kind: "forge_attribute" as const,
        stableId: `semantic-value-${String(index).padStart(4, "0")}`,
      },
      path: `Workspace/SemanticValue${String(index).padStart(4, "0")}`,
      className: "StringValue",
    },
    // This remains a manifest-valid 3,996-byte value while NUL escaping and
    // non-ASCII code points exercise the logical and enclosing wire encoders.
    properties: { Value: { kind: "string_utf8" as const, value: "\0\0\0✓".repeat(666) } },
  }));
  const projection = compileMutationEvidenceProjection({
    id: "semantic-stream-projection",
    project,
    binding,
    operations,
    purpose: "mutation_preflight",
  });
  const facts = projection.requirements.map((requirement) => {
    assert.equal(requirement.kind, "property");
    assert.ok(requirement.propertyName);
    assert.ok(requirement.expected);
    return {
      kind: "property",
      key: requirement.key,
      target: requirement.target,
      propertyName: requirement.propertyName,
      result: { status: "observed", value: requirement.expected },
    } as StudioEvidenceFact;
  });
  const envelope = createStudioEvidenceEnvelope(
    {
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      bindingHash: projection.bindingHash,
      project,
      authoritative: true,
      startedAt: sentAt,
      endedAt: sentAt,
      completion: "complete",
      facts,
    },
    projection,
  );
  return {
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "StudioEvidenceProduced",
    messageId: `semantic-evidence-${factCount}`,
    requestId: "semantic-stream-request",
    sessionId,
    sentAt,
    payload: { project, reason: "pre_apply", projection, envelope },
  };
}

function streamedMutationMessages(
  sessionId: string,
  factCount: number,
): readonly StudioStreamedSemanticMessage[] {
  const evidence = streamedEvidenceMessage(sessionId, factCount);
  const { envelope, projection } = evidence.payload;
  if (!evidence.requestId) throw new Error("semantic test fixture has no request binding");
  const common = {
    kind: "StudioProtocolMessage" as const,
    direction: "plugin_to_backend" as const,
    requestId: evidence.requestId,
    sessionId,
    sentAt,
  };
  const changeBinding = {
    creatorSessionId: "semantic_creator_session",
    changeSetId: "semantic_change_set",
    changeSetHash: "a".repeat(64),
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    beforeProjectIndexManifestId: "semantic_before_index",
    beforeProjectRevisionHash: "b".repeat(64),
    beforeProjectDetectorEpoch: 0,
  };
  return [
    evidence,
    {
      ...common,
      type: "CreatorChangePreflighted",
      messageId: `semantic-preflight-${factCount}`,
      payload: {
        ...changeBinding,
        preflightProjectionId: projection.id,
        preflightProjectionHash: projection.contentHash,
        preflightEvidence: envelope,
        status: "passed",
      },
    },
    {
      ...common,
      type: "CreatorMutationProvisional",
      messageId: `semantic-provisional-${factCount}`,
      payload: {
        ...changeBinding,
        recordingId: "semantic_recording",
        directReadbackEvidence: envelope,
        postApplyProjectIndexManifestId: "semantic_after_index",
        postApplyProjectRevisionHash: "c".repeat(64),
        postApplyProjectDetectorEpoch: 0,
        status: "provisional",
      },
    },
  ];
}

function semanticTransferMessages(
  logical: StudioStreamedSemanticMessage,
): readonly PluginToBackendMessage[] {
  const transfer = createStudioSemanticMessageTransfer(logical);
  const boundary = {
    transferId: transfer.transferId,
    documentHash: transfer.documentHash,
    utf8Bytes: transfer.utf8Bytes,
    pieceCount: transfer.fragments.length,
    semanticType: transfer.semanticType,
    semanticMessageId: transfer.semanticMessageId,
    ...(transfer.semanticRequestId ? { semanticRequestId: transfer.semanticRequestId } : {}),
  };
  const base = {
    kind: "StudioProtocolMessage" as const,
    direction: "plugin_to_backend" as const,
    sentAt: logical.sentAt,
    ...(logical.requestId ? { requestId: logical.requestId } : {}),
    ...(logical.sessionId ? { sessionId: logical.sessionId } : {}),
  };
  return [
    {
      ...base,
      type: "StudioSemanticMessageStarted",
      messageId: `${logical.messageId}-start`,
      payload: boundary,
    },
    ...transfer.fragments.map((fragment): PluginToBackendMessage => ({
      ...base,
      type: "StudioSemanticMessageChunk",
      messageId: `${logical.messageId}-chunk-${fragment.sequence}`,
      payload: {
        transferId: transfer.transferId,
        documentHash: transfer.documentHash,
        sequence: fragment.sequence,
        encoding: "json",
        payload: fragment.payload,
        payloadHash: fragment.payloadHash,
      },
    })),
    {
      ...base,
      type: "StudioSemanticMessageCompleted",
      messageId: `${logical.messageId}-complete`,
      payload: boundary,
    },
  ];
}

test("pairing is bound to the exact generated connector surface", () => {
  const pair: PluginToBackendMessage = {
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "PairProject",
    messageId: "pair-1",
    sentAt,
    payload: {
      pairingToken: "pairing-token",
      project,
      capabilities,
      connectorBuildHash: STUDIO_CONNECTOR_BUILD_HASH,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    },
  };
  assertPluginToBackendMessage(pair);
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...pair,
        payload: { ...pair.payload, capabilities: capabilities.slice(1) },
      }),
    /PairProject/,
  );
});

test("request-bearing payloads are bound to the same envelope request", () => {
  const requestId = "project-index-request";
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch,
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const message = createBackendMessage(
    "CollectStudioProjectIndex",
    { requestId, resourcePolicy: CREATOR_DEFAULT_RESOURCE_POLICY, projection },
    "studio-session",
    requestId,
    () => new Date(sentAt),
  );
  assertBackendToPluginMessage(message);
  assert.throws(
    () => assertBackendToPluginMessage({ ...message, requestId: "different-request" }),
    /requestId binding mismatch/,
  );
  const { requestId: _outerRequestId, ...withoutOuterRequest } = message;
  assert.throws(
    () => assertBackendToPluginMessage(withoutOuterRequest),
    /requestId binding mismatch/,
  );
});

test("command settlements are hash-bound terminal protocol messages", () => {
  const settlement: PluginToBackendMessage = {
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "StudioCommandSettled",
    messageId: "command-settlement-1",
    sessionId: "studio-session",
    sentAt,
    payload: {
      commandMessageId: "command-1",
      commandHash: "a".repeat(64),
      disposition: "executed",
    },
  };
  assertPluginToBackendMessage(settlement);
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...settlement,
        payload: { ...settlement.payload, commandHash: "not-a-hash" },
      }),
    /StudioCommandSettled/,
  );
  assertPluginToBackendMessage({
    ...settlement,
    payload: {
      commandMessageId: "command-1",
      commandHash: "a".repeat(64),
      disposition: "rejected",
      classification: "SECURITY_REJECTION",
      detail: "exact binding rejected",
    },
  });
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...settlement,
        payload: {
          commandMessageId: "command-1",
          commandHash: "a".repeat(64),
          disposition: "rejected",
          classification: "SECURITY_REJECTION",
          detail: "x".repeat(4 * 1024 + 1),
        },
      }),
    /StudioCommandSettled/,
  );
});

test("protocol preserves explicit false in projection-bound evidence", () => {
  const projection = compileMutationEvidenceProjection({
    id: "protocol-false",
    project,
    binding: {
      sessionId: "protocol-session",
      changeSetHash: "protocol-change",
    },
    operations: [
      {
        id: "set-line-of-sight",
        kind: "update",
        target,
        properties: { RequiresLineOfSight: { kind: "boolean", value: false } },
      },
    ],
  });
  const fact = {
    kind: "property" as const,
    key: studioEvidenceFactKey("property", target, "RequiresLineOfSight"),
    target,
    propertyName: "RequiresLineOfSight",
    result: {
      status: "observed" as const,
      value: { kind: "boolean" as const, value: false },
    },
  };
  const envelope = createStudioEvidenceEnvelope(
    {
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      bindingHash: projection.bindingHash,
      project,
      authoritative: true,
      startedAt: sentAt,
      endedAt: sentAt,
      completion: "complete",
      facts: [fact],
    },
    projection,
  );
  const message: PluginToBackendMessage = {
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "StudioEvidenceProduced",
    messageId: "evidence-false",
    sentAt,
    payload: { project, reason: "pre_apply", projection, envelope },
  };
  assertPluginToBackendMessage(message);
  assert.equal(envelope.facts[0]?.result.status, "observed");
});

test("project index transport is a bounded typed fragment stream", () => {
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch,
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const shard = createStudioProjectEvidenceShard({
    root: "Workspace",
    ordinal: 0,
    nodes: [
      {
        identity: {
          kind: "studio_ephemeral",
          connectorEpoch,
          opaqueHash: "a".repeat(64),
        },
        displayPath: "Workspace/Door",
        name: "Door",
        // Transport coverage does not depend on a manifest-observed class.
        // Use Folder so this fragment fixture remains about ordering/bounds
        // rather than duplicating the generated Part property surface.
        className: "Folder",
        attributes: {},
        tags: [],
        coveredProperties: {},
        coveredPropertyNames: [],
      },
    ],
  });
  const capture = createStudioProjectIndexCapture({
    projection,
    shards: [shard],
    sourceManifests: [],
    sourceChunks: [],
    completedAt: sentAt,
    detectorEpoch: 0,
  });
  assertBackendToPluginMessage({
    kind: "StudioProtocolMessage",
    direction: "backend_to_plugin",
    type: "CollectStudioProjectIndex",
    messageId: "collect-index",
    requestId: "collect-index",
    sentAt,
    payload: {
      requestId: "collect-index",
      resourcePolicy: CREATOR_DEFAULT_RESOURCE_POLICY,
      projection,
    },
  });
  assertPluginToBackendMessage({
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "StudioProjectIndexStarted",
    messageId: "index-start",
    requestId: "collect-index",
    sentAt,
    payload: {
      project,
      captureId: capture.indexManifest.id,
      projection,
      pieceCount: 1,
      expectedShardCount: 1,
      expectedSourceManifestCount: 0,
      expectedSourceChunkCount: 0,
      expectedCanonicalBytes: capture.indexManifest.canonicalBytes,
      detectorEpoch: 0,
    },
  });
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "StudioProjectIndexStarted",
        messageId: "index-start-without-detector",
        requestId: "collect-index",
        sentAt,
        payload: {
          project,
          captureId: capture.indexManifest.id,
          projection,
          pieceCount: 1,
          expectedShardCount: 1,
          expectedSourceManifestCount: 0,
          expectedSourceChunkCount: 0,
          expectedCanonicalBytes: capture.indexManifest.canonicalBytes,
        },
      }),
    /StudioProjectIndexStarted/,
  );
  const payload = stableJson(shard);
  assertPluginToBackendMessage({
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "StudioProjectEvidenceShard",
    messageId: "index-shard",
    requestId: "collect-index",
    sentAt,
    payload: {
      project,
      captureId: capture.indexManifest.id,
      sequence: 0,
      artifact: { kind: shard.kind, id: shard.id, hash: shard.hash },
      fragmentOrdinal: 0,
      fragmentCount: 1,
      encoding: "json",
      payload,
      payloadHash: contentHash(payload),
    },
  });
  const { sourceManifestHashes: _sourceManifestHashes, ...indexManifest } = capture.indexManifest;
  assertPluginToBackendMessage({
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "StudioProjectIndexCompleted",
    messageId: "index-complete",
    requestId: "collect-index",
    sentAt,
    payload: {
      project,
      captureId: capture.indexManifest.id,
      pieceCount: 1,
      indexManifest: { ...indexManifest, sourceManifestCount: 0 },
      revision: capture.revision,
      captureHash: capture.hash,
      detectorEpoch: 0,
    },
  });
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "StudioProjectIndexCompleted",
        messageId: "index-complete-negative-detector",
        requestId: "collect-index",
        sentAt,
        payload: {
          project,
          captureId: capture.indexManifest.id,
          pieceCount: 1,
          indexManifest: { ...indexManifest, sourceManifestCount: 0 },
          revision: capture.revision,
          captureHash: capture.hash,
          detectorEpoch: -1,
        },
      }),
    /StudioProjectIndexCompleted/,
  );
});

test("source-write transport carries ordered multi-chunk immutable leaves and rejects tampered fragments", () => {
  const capture = createCreatorSourceWriteBlobCapture({
    source: "-- streamed source\n" + "m".repeat(320 * 1024),
  });
  assert.ok(capture.manifest.utf8Bytes > 48 * 1024);
  assert.ok(capture.chunks.length >= 2);
  const requestId = "source-write-request";
  const serialized = capture.chunks.map((chunk) => stableJson(chunk));
  const fragments = serialized.flatMap((chunk) => {
    const bytes = Buffer.from(chunk, "utf8");
    return Array.from(
      { length: Math.ceil(bytes.length / BACKEND_COMMAND_FRAGMENT_BYTES) },
      (_, index) =>
        bytes
          .subarray(
            index * BACKEND_COMMAND_FRAGMENT_BYTES,
            Math.min(bytes.length, (index + 1) * BACKEND_COMMAND_FRAGMENT_BYTES),
          )
          .toString("utf8"),
    );
  });
  assertBackendToPluginMessage({
    kind: "StudioProtocolMessage",
    direction: "backend_to_plugin",
    type: "CreatorSourceWriteBlobStarted",
    messageId: "source-write-start",
    requestId,
    sentAt,
    payload: {
      requestId,
      manifest: capture.manifest,
      pieceCount: fragments.length,
    },
  });
  assert.throws(
    () =>
      assertBackendToPluginMessage({
        kind: "StudioProtocolMessage",
        direction: "backend_to_plugin",
        type: "CreatorSourceWriteBlobStarted",
        messageId: "source-write-impossible-piece-count",
        requestId,
        sentAt,
        payload: {
          requestId,
          manifest: capture.manifest,
          pieceCount: capture.manifest.chunkHashes.length - 1,
        },
      }),
    /CreatorSourceWriteBlobStarted/,
  );
  let sequence = 0;
  for (const [chunkIndex, chunk] of capture.chunks.entries()) {
    const bytes = Buffer.from(serialized[chunkIndex]!, "utf8");
    const fragmentCount = Math.ceil(bytes.length / BACKEND_COMMAND_FRAGMENT_BYTES);
    for (let ordinal = 0; ordinal < fragmentCount; ordinal += 1) {
      const payload = bytes
        .subarray(
          ordinal * BACKEND_COMMAND_FRAGMENT_BYTES,
          Math.min(bytes.length, (ordinal + 1) * BACKEND_COMMAND_FRAGMENT_BYTES),
        )
        .toString("utf8");
      const message = {
        kind: "StudioProtocolMessage" as const,
        direction: "backend_to_plugin" as const,
        type: "CreatorSourceWriteBlobChunk" as const,
        messageId: `source-write-${sequence}`,
        requestId,
        sentAt,
        payload: {
          requestId,
          manifestId: capture.manifest.id,
          sequence,
          artifact: {
            kind: "CreatorSourceWriteBlobChunk" as const,
            id: chunk.id,
            hash: chunk.hash,
          },
          fragmentOrdinal: ordinal,
          fragmentCount,
          encoding: "json" as const,
          payload,
          payloadHash: contentHash(payload),
        },
      };
      assertBackendToPluginMessage(message);
      if (sequence === 0)
        assert.throws(
          () =>
            assertBackendToPluginMessage({
              ...message,
              payload: { ...message.payload, payloadHash: "0".repeat(64) },
            }),
          /CreatorSourceWriteBlobChunk/,
        );
      sequence += 1;
    }
  }
  assertBackendToPluginMessage({
    kind: "StudioProtocolMessage",
    direction: "backend_to_plugin",
    type: "CreatorSourceWriteBlobCompleted",
    messageId: "source-write-completed",
    requestId,
    sentAt,
    payload: {
      requestId,
      manifestId: capture.manifest.id,
      manifestHash: capture.manifest.hash,
      sourceHash: capture.manifest.sourceHash,
      utf8Bytes: capture.manifest.utf8Bytes,
      pieceCount: sequence,
    },
  });
  assert.throws(
    () =>
      assertBackendToPluginMessage({
        kind: "StudioProtocolMessage",
        direction: "backend_to_plugin",
        type: "CreatorSourceWriteBlobCompleted",
        messageId: "source-write-missing-piece",
        requestId,
        sentAt,
        payload: {
          requestId,
          manifestId: capture.manifest.id,
          manifestHash: capture.manifest.hash,
          sourceHash: capture.manifest.sourceHash,
          utf8Bytes: capture.manifest.utf8Bytes,
          pieceCount: 0,
        },
      }),
    /CreatorSourceWriteBlobCompleted/,
  );

  // Transport pieces count canonical JSON leaves, not raw source bytes. An
  // empty replacement still has one leaf, while JSON escaping can expand a
  // source into substantially more fragments than its byte length suggests.
  for (const [label, source] of [
    ["empty", ""],
    ["escape-heavy", '\\"'.repeat(BACKEND_COMMAND_FRAGMENT_BYTES)],
  ] as const) {
    const boundaryCapture = createCreatorSourceWriteBlobCapture({ source });
    const boundaryPieceCount = boundaryCapture.chunks.reduce(
      (count, chunk) =>
        count +
        Math.ceil(Buffer.byteLength(stableJson(chunk), "utf8") / BACKEND_COMMAND_FRAGMENT_BYTES),
      0,
    );
    assert.ok(boundaryPieceCount >= boundaryCapture.manifest.chunkHashes.length);
    if (label === "empty") assert.equal(boundaryPieceCount, 1);
    else
      assert.ok(
        boundaryPieceCount >
          Math.ceil(boundaryCapture.manifest.utf8Bytes / (BACKEND_COMMAND_FRAGMENT_BYTES - 3)),
        "escaped source transport must not be bounded from raw source bytes",
      );
    assertBackendToPluginMessage({
      kind: "StudioProtocolMessage",
      direction: "backend_to_plugin",
      type: "CreatorSourceWriteBlobStarted",
      messageId: `source-write-${label}-start`,
      requestId,
      sentAt,
      payload: {
        requestId,
        manifest: boundaryCapture.manifest,
        pieceCount: boundaryPieceCount,
      },
    });
  }
});

test("project-change messages are advisory, ordered, and epoch-bound", () => {
  const message = {
    kind: "StudioProtocolMessage" as const,
    direction: "plugin_to_backend" as const,
    type: "StudioProjectChangeDetected" as const,
    messageId: "change-1",
    sentAt,
    payload: {
      project,
      connectorEpoch,
      epoch: 7,
      observedAt: sentAt,
      sources: ["hierarchy", "script_editor"] as const,
    },
  };
  assertPluginToBackendMessage(message);
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...message,
        payload: {
          ...message.payload,
          sources: ["script_editor", "hierarchy"],
        },
      }),
    /StudioProjectChangeDetected/,
  );
});

test("every protocol-admitted dirty source materializes the same creator evidence vocabulary", () => {
  for (const source of STUDIO_PROJECT_CHANGE_SOURCES) {
    const payload = {
      project,
      connectorEpoch,
      epoch: 1,
      observedAt: sentAt,
      sources: [source],
    };
    assert.doesNotThrow(() =>
      assertPluginToBackendMessage({
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "StudioProjectChangeDetected",
        messageId: `change-source-${source}`,
        sentAt,
        payload,
      }),
    );
    const notice = createCreatorProjectChangeNotice({
      projectId: "studio_project_protocol",
      connectorEpoch,
      payload,
    });
    assert.deepEqual(notice.reasons, [source]);
  }
});

test("passive runtime finalization clears only an exact stopped arm", () => {
  const binding = {
    executionPlanId: "studio_execution_plan_passive",
    executionPlanHash: "a".repeat(64),
    projectionId: "studio_projection_passive",
    projectionHash: "b".repeat(64),
    bindingHash: "c".repeat(64),
    nonceCommitment: "d".repeat(64),
  };
  assertBackendToPluginMessage({
    kind: "StudioProtocolMessage",
    direction: "backend_to_plugin",
    type: "FinalizePassiveRuntimeEval",
    messageId: "finalize-passive",
    requestId: "runtime-request",
    sessionId: "studio-session",
    sentAt,
    payload: { requestId: "runtime-request", ...binding },
  });
  assertPluginToBackendMessage({
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "PassiveRuntimeEvalFinalized",
    messageId: "passive-finalized",
    requestId: "runtime-request",
    sessionId: "studio-session",
    sentAt,
    payload: { ...binding, status: "cleared" },
  });
});

test("recording recovery reports durable state without mutating Studio", () => {
  assertPluginToBackendMessage({
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "CreatorRecordingRecovery",
    messageId: "recovery-none",
    sentAt,
    payload: { recordingState: "none" },
  });
  const binding = {
    creatorSessionId: "creator-session",
    changeSetId: "change-set",
    changeSetHash: "a".repeat(64),
    projectionId: "projection",
    projectionHash: "b".repeat(64),
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    beforeProjectIndexManifestId: "before-manifest",
    beforeProjectRevisionHash: "c".repeat(64),
    beforeProjectDetectorEpoch: 0,
    recordingId: "recording-1",
  };
  assertPluginToBackendMessage({
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "CreatorRecordingRecovery",
    messageId: "recovery-open",
    sentAt,
    payload: {
      ...binding,
      recordingState: "open",
      recoveryProjectIndexManifestId: "recovery-manifest",
      recoveryProjectRevisionHash: "d".repeat(64),
      recoveryProjectDetectorEpoch: 0,
    },
  });
  assertPluginToBackendMessage({
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "CreatorRecordingRecovery",
    messageId: "recovery-finalizing",
    sentAt,
    payload: {
      ...binding,
      recordingState: "finalizing",
      recoveryProjectIndexManifestId: "recovery-manifest",
      recoveryProjectRevisionHash: "d".repeat(64),
      recoveryProjectDetectorEpoch: 0,
    },
  });
});

test("the bridge rejects a stale connector identity before creating a session", async () => {
  const bridge = new StudioBridgeServer({ port: 0 });
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const pair = async (connectorBuildHash: string) => {
      const pairing = (await (await fetch(`${origin}/pairing`)).json()) as {
        pairing: { token: string };
      };
      return fetch(`${origin}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "StudioProtocolMessage",
          direction: "plugin_to_backend",
          type: "PairProject",
          messageId: `pair-${connectorBuildHash.slice(0, 8)}`,
          sentAt,
          payload: {
            pairingToken: pairing.pairing.token,
            project,
            capabilities,
            connectorBuildHash,
            manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
          },
        }),
      });
    };
    const stale = await pair("0".repeat(64));
    assert.equal(stale.status, 409);
    assert.equal(bridge.getSessions().length, 0);
    const accepted = await pair(STUDIO_CONNECTOR_BUILD_HASH);
    assert.equal(accepted.status, 200);
    assert.equal(bridge.getSessions().length, 1);
  } finally {
    await bridge.close();
  }
});

test("pairing is not advertised or retained when host enrollment fails", async () => {
  const bridge = new StudioBridgeServer({ port: 0 });
  bridge.subscribe(() => {
    throw new Error("host enrollment failed");
  });
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const pairing = (await (await fetch(`${origin}/pairing`)).json()) as {
      pairing: { token: string };
    };
    const response = await fetch(`${origin}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "PairProject",
        messageId: "pair-handler-failure",
        sentAt,
        payload: {
          pairingToken: pairing.pairing.token,
          project,
          capabilities,
          connectorBuildHash: STUDIO_CONNECTOR_BUILD_HASH,
          manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
        },
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(bridge.getSessions().length, 0);
  } finally {
    await bridge.close();
  }
});

async function pairBridge(origin: string, suffix: string): Promise<StudioBridgeSession> {
  const pairing = (await (await fetch(`${origin}/pairing`)).json()) as {
    pairing: { token: string };
  };
  const response = await fetch(`${origin}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "StudioProtocolMessage",
      direction: "plugin_to_backend",
      type: "PairProject",
      messageId: `pair-${suffix}`,
      sentAt,
      payload: {
        pairingToken: pairing.pairing.token,
        project,
        capabilities,
        connectorBuildHash: STUDIO_CONNECTOR_BUILD_HASH,
        manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      },
    }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as StudioBridgeSession;
}

test("every large Studio evidence outcome has one bounded semantic transport", () => {
  for (const logical of streamedMutationMessages("studio-semantic-bounds", 90)) {
    assertPluginToBackendMessage(logical);
    assert.ok(
      Buffer.byteLength(stableJson(logical), "utf8") > MAX_PROTOCOL_MESSAGE_BYTES,
      `${logical.type} must exercise the production oversized-document boundary`,
    );
    const frames = semanticTransferMessages(logical);
    assert.ok(frames.length > 3);
    for (const frame of frames) {
      assertPluginToBackendMessage(frame);
      assert.ok(
        Buffer.byteLength(JSON.stringify(frame), "utf8") < MAX_PROTOCOL_MESSAGE_BYTES,
        `${logical.type} emitted an oversized physical frame`,
      );
      assert.equal(frame.sessionId, logical.sessionId);
      assert.equal(frame.requestId, logical.requestId);
    }
    assert.throws(
      () =>
        assertPluginToBackendMessage({
          ...frames[0],
          requestId: "different-semantic-request",
        }),
      /semantic transport requestId binding mismatch/,
    );
  }
});

test("bridge reassembles one ordered semantic stream without exposing physical fragments", async () => {
  const bridge = new StudioBridgeServer({ port: 0 });
  const delivered: PluginToBackendMessage[] = [];
  bridge.subscribe((message) => {
    delivered.push(message);
  });
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const session = await pairBridge(origin, "semantic-stream");
    // Pairing is semantic too; isolate the transfer under test.
    delivered.length = 0;
    const post = (body: unknown) =>
      fetch(`${origin}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forge-session-token": session.sessionToken,
        },
        body: JSON.stringify(body),
      });

    const direct = streamedEvidenceMessage(session.sessionId, 1);
    assert.equal((await post(direct)).status, 400, "the superseded direct path must be closed");
    assert.equal(delivered.length, 0);

    const logical = streamedEvidenceMessage(session.sessionId, 90);
    const transfer = createStudioSemanticMessageTransfer(logical);
    assert.ok(Buffer.byteLength(stableJson(logical), "utf8") > MAX_PROTOCOL_MESSAGE_BYTES);
    assert.ok(transfer.fragments.length > 1);
    assert.ok(
      transfer.fragments.every(
        (fragment) => Buffer.byteLength(fragment.payload, "utf8") <= STUDIO_SEMANTIC_FRAGMENT_BYTES,
      ),
    );
    const boundary = {
      transferId: transfer.transferId,
      documentHash: transfer.documentHash,
      utf8Bytes: transfer.utf8Bytes,
      pieceCount: transfer.fragments.length,
      semanticType: transfer.semanticType,
      semanticMessageId: transfer.semanticMessageId,
      semanticRequestId: transfer.semanticRequestId,
    };
    const physical = (
      type:
        | "StudioSemanticMessageStarted"
        | "StudioSemanticMessageChunk"
        | "StudioSemanticMessageCompleted",
      payload:
        | typeof boundary
        | ((typeof transfer.fragments)[number] & {
            transferId: string;
            documentHash: string;
            encoding: "json";
          }),
      messageId: string,
    ): PluginToBackendMessage =>
      ({
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type,
        messageId,
        requestId: logical.requestId,
        sessionId: session.sessionId,
        sentAt,
        payload,
      }) as PluginToBackendMessage;
    const started = physical("StudioSemanticMessageStarted", boundary, "semantic-start");
    const chunks = transfer.fragments.map((fragment) =>
      physical(
        "StudioSemanticMessageChunk",
        {
          transferId: transfer.transferId,
          documentHash: transfer.documentHash,
          sequence: fragment.sequence,
          encoding: "json",
          payload: fragment.payload,
          payloadHash: fragment.payloadHash,
        },
        `semantic-chunk-${fragment.sequence}`,
      ),
    );
    const completed = physical("StudioSemanticMessageCompleted", boundary, "semantic-completed");
    for (const frame of [started, ...chunks, completed]) {
      assertPluginToBackendMessage(frame);
      assert.ok(Buffer.byteLength(JSON.stringify(frame), "utf8") < MAX_PROTOCOL_MESSAGE_BYTES);
    }

    assert.equal((await post(started)).status, 202);
    // A lost HTTP response is recovered by replaying the exact same frame;
    // the bridge acknowledges it without advancing twice.
    assert.equal((await post(started)).status, 202);
    assert.equal((await post(chunks[1])).status, 409, "a missing fragment must block progress");
    assert.equal(delivered.length, 0);
    assert.equal((await post(chunks[0])).status, 202);
    assert.equal((await post(chunks[0])).status, 202);
    const oversized = await fetch(`${origin}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-session-token": session.sessionToken,
      },
      body: `{"padding":"${"x".repeat(MAX_PROTOCOL_MESSAGE_BYTES)}"}`,
    });
    assert.equal(oversized.status, 413);
    assert.equal(delivered.length, 0);
    for (const chunk of chunks.slice(1)) assert.equal((await post(chunk)).status, 202);
    assert.equal(delivered.length, 0, "fragments are transport, never semantic events");
    assert.equal((await post(completed)).status, 202);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0], logical);
    assert.equal((await post(completed)).status, 202);
    assert.equal(delivered.length, 1, "completion replay must not redeliver semantics");

    const smallMutationOutcomes = streamedMutationMessages(session.sessionId, 1).slice(1);
    const largeMutationOutcomes = streamedMutationMessages(session.sessionId, 90).slice(1);
    for (let index = 0; index < largeMutationOutcomes.length; index += 1) {
      assert.equal(
        (await post(smallMutationOutcomes[index]!)).status,
        400,
        "every semantic outcome must reject the superseded direct wire path",
      );
      const outcome = largeMutationOutcomes[index]!;
      const frames = semanticTransferMessages(outcome);
      const deliveryCount: number = delivered.length;
      for (const frame of frames) assert.equal((await post(frame)).status, 202);
      assert.equal(delivered.length, deliveryCount + 1);
      assert.deepEqual(delivered.at(-1), outcome);
    }

    const wrongSessionLogical = streamedEvidenceMessage("different-studio-session", 1);
    const wrongSessionFrames = semanticTransferMessages(wrongSessionLogical).map((frame) => ({
      ...frame,
      sessionId: session.sessionId,
    }));
    const deliveryCount: number = delivered.length;
    for (const frame of wrongSessionFrames.slice(0, -1))
      assert.equal((await post(frame)).status, 202);
    assert.equal((await post(wrongSessionFrames.at(-1)!)).status, 409);
    assert.equal(
      delivered.length,
      deliveryCount,
      "a reassembled logical message cannot cross its paired Studio session",
    );
  } finally {
    await bridge.close();
  }
});

function heartbeat(
  session: StudioBridgeSession,
  messageId: string,
  revision = "a".repeat(64),
): PluginToBackendMessage {
  return {
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "Heartbeat",
    messageId,
    sessionId: session.sessionId,
    sentAt,
    payload: {
      project,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      currentProjectRevisionHash: revision,
    },
  };
}

test("bridge retains hash-bound commands until the exact settlement", async () => {
  const bridge = new StudioBridgeServer({ port: 0 });
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const session = await pairBridge(origin, "commands");
    const command = createBackendMessage(
      "RollbackCreatorCheckpoint",
      {
        requestId: "rollback-request",
        creatorSessionId: "creator-session",
        checkpointId: "checkpoint-1",
        changeSetId: "change-set",
        changeSetHash: "b".repeat(64),
        expectedProjectRevisionHash: "c".repeat(64),
      },
      session.sessionId,
      "rollback-request",
      () => new Date(sentAt),
    );
    const accepted = await fetch(`${origin}/command`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-control-token": address.controlToken,
      },
      body: JSON.stringify(command),
    });
    assert.equal(accepted.status, 202);
    const poll = async () =>
      fetch(`${origin}/poll?sessionId=${encodeURIComponent(session.sessionId)}`, {
        headers: { "x-forge-session-token": session.sessionToken },
      });
    const first = (await (await poll()).json()) as {
      kind: string;
      commands: Array<{ commandJson: string; commandHash: string }>;
    };
    assert.equal(first.kind, "ForgeStudioCommandDelivery");
    assert.equal(first.commands.length, 1);
    assert.equal(first.commands[0]?.commandHash, contentHash(stableJson(command)));
    assert.deepEqual(JSON.parse(first.commands[0]!.commandJson), command);
    const redelivered = (await (await poll()).json()) as {
      commands: unknown[];
    };
    assert.equal(redelivered.commands.length, 1);

    const duplicate = await fetch(`${origin}/command`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-control-token": address.controlToken,
      },
      body: JSON.stringify(command),
    });
    assert.equal(duplicate.status, 202);
    const conflicting = {
      ...command,
      payload: { ...command.payload, checkpointId: "checkpoint-2" },
    };
    const conflict = await fetch(`${origin}/command`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-control-token": address.controlToken,
      },
      body: JSON.stringify(conflicting),
    });
    assert.equal(conflict.status, 409);

    const settlement = heartbeat(
      session,
      "command-settlement",
    ) as unknown as PluginToBackendMessage;
    const settled = {
      ...settlement,
      type: "StudioCommandSettled" as const,
      payload: {
        commandMessageId: command.messageId,
        commandHash: first.commands[0]!.commandHash,
        disposition: "executed" as const,
      },
    };
    const settlementResponse = await fetch(`${origin}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-session-token": session.sessionToken,
      },
      body: JSON.stringify(settled),
    });
    assert.equal(settlementResponse.status, 202);
    const drained = (await (await poll()).json()) as { commands: unknown[] };
    assert.equal(drained.commands.length, 0);
    const replayedSettlement = await fetch(`${origin}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-session-token": session.sessionToken,
      },
      body: JSON.stringify(settled),
    });
    assert.equal(replayedSettlement.status, 202);
    const conflictingSettlement = await fetch(`${origin}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-session-token": session.sessionToken,
      },
      body: JSON.stringify({
        ...settled,
        payload: { ...settled.payload, commandHash: "d".repeat(64) },
      }),
    });
    assert.equal(conflictingSettlement.status, 409);
  } finally {
    await bridge.close();
  }
});

test("an aborted command upload leaves the bridge live and its retained queue unchanged", async () => {
  const bridge = new StudioBridgeServer({ port: 0 });
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const session = await pairBridge(origin, "aborted-command");
    const command = createBackendMessage(
      "RollbackCreatorCheckpoint",
      {
        requestId: "aborted-command-request",
        creatorSessionId: "creator-session",
        checkpointId: "checkpoint-aborted",
        changeSetId: "change-set",
        changeSetHash: "b".repeat(64),
        expectedProjectRevisionHash: "c".repeat(64),
      },
      session.sessionId,
      "aborted-command-request",
      () => new Date(sentAt),
    );
    const encoded = JSON.stringify(command);
    const closed = new Promise<void>((resolvePromise) => {
      const request = httpRequest(`${origin}/command`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forge-control-token": address.controlToken,
          "content-length": Buffer.byteLength(encoded, "utf8"),
        },
      });
      request.once("error", () => resolvePromise());
      request.once("close", () => resolvePromise());
      request.write(encoded.slice(0, -1));
      setTimeout(() => request.destroy(), 5);
    });
    await closed;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));

    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200, "a torn peer must not terminate the bridge process");
    const delivery = (await (
      await fetch(`${origin}/poll?sessionId=${encodeURIComponent(session.sessionId)}`, {
        headers: { "x-forge-session-token": session.sessionToken },
      })
    ).json()) as { commands?: unknown[] };
    assert.deepEqual(
      delivery.commands,
      [],
      "a request aborted before its complete body is accepted cannot enqueue a retained command",
    );
  } finally {
    await bridge.close();
  }
});

test("in-process bridge rejects a settled command immediately and delivers the next head", async () => {
  const bridge = new StudioBridgeServer({ port: 0 });
  let semanticSettlementDeliveries = 0;
  const unsubscribe = bridge.subscribeWithSession((message) => {
    if (message.type !== "StudioCommandSettled") return;
    semanticSettlementDeliveries += 1;
    throw new Error("transport receipts must not enter semantic subscribers");
  });
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const session = await pairBridge(origin, "rejected-command");
    const command = createBackendMessage(
      "CreatorChangePrepareStarted",
      {
        requestId: "rejected-prepare-request",
        transferId: `creator_prepare_transfer_${"a".repeat(24)}`,
        documentHash: "a".repeat(64),
        utf8Bytes: 1,
        pieceCount: 1,
      },
      session.sessionId,
      "rejected-prepare-request",
      () => new Date(sentAt),
    );
    const waiting = bridge.sendAndWaitForSettlement(command, 2_000);
    const rejectedWaiting = assert.rejects(
      waiting,
      /SECURITY_REJECTION.*creator Prepare binding mismatch/,
    );
    const first = (await (
      await fetch(`${origin}/poll?sessionId=${encodeURIComponent(session.sessionId)}`, {
        headers: { "x-forge-session-token": session.sessionToken },
      })
    ).json()) as { commands: Array<{ commandJson: string; commandHash: string }> };
    assert.equal(first.commands.length, 1);
    const next = createBackendMessage(
      "CreatorChangePrepareStarted",
      {
        requestId: "next-prepare-request",
        transferId: `creator_prepare_transfer_${"b".repeat(24)}`,
        documentHash: "b".repeat(64),
        utf8Bytes: 1,
        pieceCount: 1,
      },
      session.sessionId,
      "next-prepare-request",
      () => new Date(sentAt),
    );
    // Queue the successor before rejecting the head. This exercises the real
    // head-of-line failure instead of merely proving a later fresh send works.
    await bridge.send(next);
    const outOfOrder = await fetch(`${origin}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-session-token": session.sessionToken,
      },
      body: JSON.stringify({
        ...heartbeat(session, "out-of-order-command-settlement"),
        type: "StudioCommandSettled",
        requestId: "next-prepare-request",
        payload: {
          commandMessageId: next.messageId,
          commandHash: contentHash(stableJson(next)),
          disposition: "executed",
        },
      }),
    });
    assert.equal(outOfOrder.status, 409, "a queued tail was never delivered and cannot settle");
    const rejected: PluginToBackendMessage = {
      ...heartbeat(session, "rejected-command-settlement"),
      type: "StudioCommandSettled",
      requestId: "rejected-prepare-request",
      payload: {
        commandMessageId: command.messageId,
        commandHash: first.commands[0]!.commandHash,
        disposition: "rejected",
        classification: "SECURITY_REJECTION",
        detail: "creator Prepare binding mismatch",
      },
    };
    const startedAt = Date.now();
    const response = await fetch(`${origin}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-session-token": session.sessionToken,
      },
      body: JSON.stringify(rejected),
    });
    assert.equal(response.status, 202);
    await rejectedWaiting;
    assert.ok(Date.now() - startedAt < 1_000, "rejection must not wait for the command timeout");
    assert.equal(semanticSettlementDeliveries, 0);
    const advanced = (await (
      await fetch(`${origin}/poll?sessionId=${encodeURIComponent(session.sessionId)}`, {
        headers: { "x-forge-session-token": session.sessionToken },
      })
    ).json()) as { commands: Array<{ commandJson: string }> };
    assert.equal(JSON.parse(advanced.commands[0]!.commandJson).messageId, next.messageId);

    const replay = await fetch(`${origin}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-session-token": session.sessionToken,
      },
      body: JSON.stringify(rejected),
    });
    assert.equal(replay.status, 202);
  } finally {
    unsubscribe();
    await bridge.close();
  }
});

test("remote bridge client rejects from an exact retained command settlement", async () => {
  const bridge = new StudioBridgeServer({ port: 0 });
  let client: StudioBridgeClient | undefined;
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const session = await pairBridge(origin, "remote-rejected-command");
    client = new StudioBridgeClient({
      host: address.host,
      port: address.port,
      controlToken: address.controlToken,
    });
    let semanticSettlementDeliveries = 0;
    client.subscribeWithSession((message) => {
      if (message.type !== "StudioCommandSettled") return;
      semanticSettlementDeliveries += 1;
      throw new Error("transport receipts must not enter semantic subscribers");
    });
    const command = createBackendMessage(
      "CreatorChangePrepareStarted",
      {
        requestId: "remote-rejected-prepare-request",
        transferId: `creator_prepare_transfer_${"c".repeat(24)}`,
        documentHash: "c".repeat(64),
        utf8Bytes: 1,
        pieceCount: 1,
      },
      session.sessionId,
      "remote-rejected-prepare-request",
      () => new Date(sentAt),
    );
    const waiting = client.sendAndWaitForSettlement(command, 2_000);
    const rejectedWaiting = assert.rejects(
      waiting,
      /STUDIO_FAILURE.*detached preflight constructor rejected/,
    );
    let current: { commandJson: string; commandHash: string } | undefined;
    for (let attempt = 0; attempt < 100 && current === undefined; attempt += 1) {
      const delivery = (await (
        await fetch(`${origin}/poll?sessionId=${encodeURIComponent(session.sessionId)}`, {
          headers: { "x-forge-session-token": session.sessionToken },
        })
      ).json()) as { commands: Array<{ commandJson: string; commandHash: string }> };
      current = delivery.commands[0];
      if (!current) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(current);
    const rejected: PluginToBackendMessage = {
      ...heartbeat(session, "remote-rejected-command-settlement"),
      type: "StudioCommandSettled",
      requestId: "remote-rejected-prepare-request",
      payload: {
        commandMessageId: command.messageId,
        commandHash: current.commandHash,
        disposition: "rejected",
        classification: "STUDIO_FAILURE",
        detail: "detached preflight constructor rejected",
      },
    };
    assert.equal(
      (
        await fetch(`${origin}/message`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forge-session-token": session.sessionToken,
          },
          body: JSON.stringify(rejected),
        })
      ).status,
      202,
    );
    await rejectedWaiting;
    assert.equal(semanticSettlementDeliveries, 0);
  } finally {
    if (client) await client.close();
    await bridge.close();
  }
});

test("bridge flow-controls more than 128 source fragments through bounded settlement pages", async () => {
  const bridge = new StudioBridgeServer({ port: 0 });
  let running = true;
  let drain: Promise<void> | undefined;
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const session = await pairBridge(origin, "source-flow-control");
    const deliveredSequences: number[] = [];
    drain = (async () => {
      while (running) {
        const response = await fetch(
          `${origin}/poll?sessionId=${encodeURIComponent(session.sessionId)}`,
          { headers: { "x-forge-session-token": session.sessionToken } },
        );
        assert.equal(response.status, 200);
        const encoded = await response.text();
        assert.ok(Buffer.byteLength(encoded, "utf8") <= MAX_PROTOCOL_MESSAGE_BYTES);
        const delivery = JSON.parse(encoded) as {
          commands: Array<{ commandJson: string; commandHash: string }>;
        };
        assert.ok(delivery.commands.length <= 1, "poll must expose one bounded delivery page");
        const current = delivery.commands[0];
        if (!current) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
        const command = JSON.parse(current.commandJson) as Extract<
          import("../packages/studio-protocol/src/index.js").BackendToPluginMessage,
          { type: "CreatorSourceWriteBlobChunk" }
        >;
        assert.equal(command.type, "CreatorSourceWriteBlobChunk");
        deliveredSequences.push(command.payload.sequence);
        const settlement = {
          ...heartbeat(session, `source-fragment-settlement-${command.payload.sequence}`),
          type: "StudioCommandSettled" as const,
          payload: {
            commandMessageId: command.messageId,
            commandHash: current.commandHash,
            disposition: "executed" as const,
          },
        };
        const settled = await fetch(`${origin}/message`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forge-session-token": session.sessionToken,
          },
          body: JSON.stringify(settlement),
        });
        assert.equal(settled.status, 202);
      }
    })();
    for (let sequence = 0; sequence < 129; sequence += 1) {
      const payload = `fragment ${sequence} \\"quoted\\" \\ unicode ✓`;
      const command = createBackendMessage(
        "CreatorSourceWriteBlobChunk",
        {
          requestId: "source_flow_control_request",
          manifestId: "creator_source_manifest_flow_control",
          sequence,
          artifact: {
            kind: "CreatorSourceWriteBlobChunk",
            id: `creator_source_chunk_flow_control_${sequence}`,
            hash: contentHash(`source-fragment-artifact-${sequence}`),
          },
          fragmentOrdinal: 0,
          fragmentCount: 1,
          encoding: "json",
          payload,
          payloadHash: contentHash(payload),
        },
        session.sessionId,
        "source_flow_control_request",
        () => new Date(sentAt),
      );
      await bridge.sendAndWaitForSettlement(command, 2_000);
    }
    assert.deepEqual(deliveredSequences, [...Array(129).keys()]);
  } finally {
    running = false;
    await drain;
    await bridge.close();
  }
});

test("Prepare streams a greater-than-poll document through exact settled fragments", async () => {
  const bridge = new StudioBridgeServer({ port: 0 });
  let running = true;
  let drain: Promise<void> | undefined;
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const session = await pairBridge(origin, "prepare-flow-control");
    const changeSetJson = stableJson({
      kind: "CreatorChangeSet",
      // Backslashes force the worst relevant expansion through the document,
      // commandJson, and outer /poll JSON string layers.
      padding: "\\".repeat(MAX_PROTOCOL_MESSAGE_BYTES),
    });
    const document = creatorChangePrepareDocument(changeSetJson);
    const transfer = createCreatorChangePrepareTransfer(document);
    assert.ok(Buffer.byteLength(stableJson(document), "utf8") > MAX_PROTOCOL_MESSAGE_BYTES);
    assert.ok(transfer.fragments.length > 1);
    assert.ok(
      transfer.fragments.every(
        (fragment) => Buffer.byteLength(fragment.payload, "utf8") <= BACKEND_COMMAND_FRAGMENT_BYTES,
      ),
    );
    const boundary = {
      requestId: document.requestId,
      transferId: transfer.transferId,
      documentHash: transfer.documentHash,
      utf8Bytes: transfer.utf8Bytes,
      pieceCount: transfer.fragments.length,
    };
    const commands = [
      createBackendMessage(
        "CreatorChangePrepareStarted",
        boundary,
        session.sessionId,
        document.requestId,
        () => new Date(sentAt),
      ),
      ...transfer.fragments.map((fragment) =>
        createBackendMessage(
          "CreatorChangePrepareChunk",
          {
            requestId: document.requestId,
            transferId: transfer.transferId,
            documentHash: transfer.documentHash,
            sequence: fragment.sequence,
            encoding: "json",
            payload: fragment.payload,
            payloadHash: fragment.payloadHash,
          },
          session.sessionId,
          document.requestId,
          () => new Date(sentAt),
        ),
      ),
      createBackendMessage(
        "CreatorChangePrepareCompleted",
        boundary,
        session.sessionId,
        document.requestId,
        () => new Date(sentAt),
      ),
    ];
    const delivered: string[] = [];
    drain = (async () => {
      while (running) {
        const response = await fetch(
          `${origin}/poll?sessionId=${encodeURIComponent(session.sessionId)}`,
          { headers: { "x-forge-session-token": session.sessionToken } },
        );
        assert.equal(response.status, 200);
        const encoded = await response.text();
        assert.ok(Buffer.byteLength(encoded, "utf8") <= MAX_PROTOCOL_MESSAGE_BYTES);
        const delivery = JSON.parse(encoded) as {
          commands: Array<{ commandJson: string; commandHash: string }>;
        };
        const current = delivery.commands[0];
        if (!current) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
        const command = JSON.parse(current.commandJson) as (typeof commands)[number];
        delivered.push(command.type);
        const settlement: PluginToBackendMessage = {
          ...heartbeat(session, `prepare-command-settlement-${delivered.length}`),
          type: "StudioCommandSettled",
          payload: {
            commandMessageId: command.messageId,
            commandHash: current.commandHash,
            disposition: "executed",
          },
        };
        const accepted = await fetch(`${origin}/message`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forge-session-token": session.sessionToken,
          },
          body: JSON.stringify(settlement),
        });
        assert.equal(accepted.status, 202);
      }
    })();
    for (const command of commands) await bridge.sendAndWaitForSettlement(command, 2_000);
    assert.deepEqual(
      delivered,
      commands.map((command) => command.type),
    );
    assert.throws(
      () =>
        assertBackendToPluginMessage({
          ...commands[0],
          type: "PrepareCreatorChangeSet",
          payload: document,
        }),
      /Invalid backend message type/,
    );
  } finally {
    running = false;
    await drain;
    await bridge.close();
  }
});

test("failed inbound handlers are retryable and completed fingerprints reject conflicts", async () => {
  const bridge = new StudioBridgeServer({ port: 0 });
  let deliveries = 0;
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const session = await pairBridge(origin, "inbound");
    bridge.subscribe(() => {
      deliveries += 1;
      if (deliveries === 1) throw new Error("first delivery fails");
    });
    const message = heartbeat(session, "retryable-heartbeat");
    const post = (body: unknown) =>
      fetch(`${origin}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forge-session-token": session.sessionToken,
        },
        body: JSON.stringify(body),
      });
    assert.equal((await post(message)).status, 400);
    assert.equal((await post(message)).status, 202);
    assert.equal(deliveries, 2);
    assert.equal((await post(message)).status, 202);
    assert.equal(deliveries, 2);
    assert.equal((await post(heartbeat(session, message.messageId, "d".repeat(64)))).status, 409);
  } finally {
    await bridge.close();
  }
});

test("completed inbound receipt pruning never permanently saturates a Studio session", async () => {
  const bridge = new StudioBridgeServer({ port: 0, maxRetainedEvents: 2 });
  let deliveries = 0;
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const session = await pairBridge(origin, "receipt-pruning");
    bridge.subscribe(() => {
      deliveries += 1;
    });
    const post = (body: unknown) =>
      fetch(`${origin}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forge-session-token": session.sessionToken,
        },
        body: JSON.stringify(body),
      });

    for (let index = 0; index < 12; index += 1) {
      const response = await post(
        heartbeat(session, `bounded-receipt-${index}`, index.toString(16).padStart(64, "0")),
      );
      assert.equal(response.status, 202);
    }
    assert.equal(deliveries, 12);
  } finally {
    await bridge.close();
  }
});

test("new clients begin at retained base cursors and surface cursor expiry", async () => {
  const bridge = new StudioBridgeServer({ port: 0, maxRetainedEvents: 1 });
  try {
    const address = await bridge.listen();
    const origin = `http://${address.host}:${address.port}`;
    const session = await pairBridge(origin, "cursors");
    const post = (body: unknown) =>
      fetch(`${origin}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forge-session-token": session.sessionToken,
        },
        body: JSON.stringify(body),
      });
    assert.equal((await post(heartbeat(session, "retained-one", "e".repeat(64)))).status, 202);
    assert.equal((await post(heartbeat(session, "retained-two", "f".repeat(64)))).status, 202);
    const listed = (await (
      await fetch(`${origin}/sessions`, {
        headers: { "x-forge-control-token": address.controlToken },
      })
    ).json()) as {
      sessions: Array<{ baseCursor: number; eventCursor: number }>;
    };
    assert.deepEqual(
      listed.sessions.map(({ baseCursor, eventCursor }) => ({
        baseCursor,
        eventCursor,
      })),
      [{ baseCursor: 1, eventCursor: 2 }],
    );

    const connectedClient = new StudioBridgeClient({
      host: address.host,
      port: address.port,
      controlToken: address.controlToken,
    });
    const internals = connectedClient as unknown as {
      refreshSessions(): Promise<void>;
      readEvents(value: StudioBridgeSession): Promise<void>;
      cursors: Map<string, number>;
      handlers: Set<(value: PluginToBackendMessage, current: StudioBridgeSession) => Promise<void>>;
    };
    let observed = 0;
    internals.handlers.add(async () => {
      observed += 1;
    });
    await internals.refreshSessions();
    assert.equal(internals.cursors.get(session.sessionId), 1);
    await internals.readEvents(connectedClient.getSessions()[0]!);
    assert.equal(observed, 1);
    assert.equal(internals.cursors.get(session.sessionId), 2);
    internals.cursors.set(session.sessionId, 0);
    await assert.rejects(internals.readEvents(connectedClient.getSessions()[0]!), /cursor expired/);
    assert.match(connectedClient.getFailure()?.message ?? "", /cursor expired/);
    await connectedClient.close();
  } finally {
    await bridge.close();
  }
});

test("remote bridge client exponentially backs off transient bridge outages", async () => {
  let sessionRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/sessions") {
      sessionRequests += 1;
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("unavailable");
      return;
    }
    response.writeHead(404).end();
  });
  let client: StudioBridgeClient | undefined;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    client = new StudioBridgeClient({
      host: "127.0.0.1",
      port: address.port,
      controlToken: "bridge-outage-control-token",
    });
    client.subscribeWithSession(async () => undefined);

    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_200));
    assert.ok(sessionRequests >= 3, "the client must retry a transient outage");
    assert.ok(
      sessionRequests <= 5,
      `expected capped exponential retries, received ${sessionRequests} attempts in 1.2 seconds`,
    );
  } finally {
    await client?.close();
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }
});

test("remote bridge client close aborts an in-flight bridge poll", async () => {
  let observeRequest: (() => void) | undefined;
  const sessionRequestObserved = new Promise<void>((resolvePromise) => {
    observeRequest = resolvePromise;
  });
  const server = createServer((request, response) => {
    if (request.url !== "/sessions") {
      response.writeHead(404).end();
      return;
    }
    observeRequest?.();
    // Deliberately retain the request. The client must abort it during close
    // instead of waiting for its ordinary five-second polling timeout.
    request.on("error", () => undefined);
  });
  let client: StudioBridgeClient | undefined;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    client = new StudioBridgeClient({
      host: "127.0.0.1",
      port: address.port,
      controlToken: "bridge-close-control-token",
    });
    client.subscribeWithSession(async () => undefined);
    await sessionRequestObserved;

    const startedAt = Date.now();
    await client.close();
    assert.ok(Date.now() - startedAt < 1_000, "close must not wait for the poll timeout");
    client = undefined;
  } finally {
    await client?.close();
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }
});

test("finalization gates reject impossible action, provenance, and settlement combinations", () => {
  const requestId = "finalization-gate-request";
  const gate = {
    requestId,
    creatorSessionId: "creator_finalization_gate_session",
    changeSetId: "creator_finalization_gate_change",
    changeSetHash: "a".repeat(64),
    projectionId: "creator_finalization_gate_projection",
    projectionHash: "b".repeat(64),
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    beforeProjectIndexManifestId: "studio_project_index_manifest_before_gate",
    beforeProjectRevisionHash: "c".repeat(64),
    beforeProjectDetectorEpoch: 3,
    recordingId: "recording_finalization_gate",
    action: "commit" as const,
    finalizationKind: "ordinary" as const,
    expectedCurrentProjectIndexManifestId: "studio_project_index_manifest_current_gate",
    expectedCurrentProjectRevisionHash: "d".repeat(64),
    expectedCurrentProjectDetectorEpoch: 4,
  };
  const ordinary = createBackendMessage(
    "FinalizeCreatorChangeSet",
    gate,
    "studio-finalization-gate",
    requestId,
    () => new Date(sentAt),
  );
  assertBackendToPluginMessage(ordinary);
  assert.throws(
    () =>
      assertBackendToPluginMessage({
        ...ordinary,
        payload: { ...gate, finalizationKind: "recovery_cancel", replacesAction: "commit" },
      }),
    /FinalizeCreatorChangeSet/,
    "a commit cannot be represented as a recovery cancellation",
  );
  assert.throws(
    () =>
      assertBackendToPluginMessage({
        ...ordinary,
        payload: { ...gate, replacesAction: "cancel" },
      }),
    /FinalizeCreatorChangeSet/,
    "ordinary finalization cannot carry recovery provenance",
  );

  const recovery = createBackendMessage(
    "CancelInterruptedRecording",
    {
      ...gate,
      action: "cancel" as const,
      finalizationKind: "recovery_cancel" as const,
      replacesAction: "commit" as const,
    },
    "studio-finalization-gate",
    requestId,
    () => new Date(sentAt),
  );
  assertBackendToPluginMessage(recovery);
  assert.throws(
    () =>
      assertBackendToPluginMessage({
        ...recovery,
        payload: {
          ...recovery.payload,
          replacesAction: undefined,
        },
      }),
    /CancelInterruptedRecording/,
    "recovery cancellation must retain the displaced action",
  );

  const recoveryReceipt = {
    kind: "StudioProtocolMessage" as const,
    direction: "plugin_to_backend" as const,
    type: "CreatorChangeFinalized" as const,
    messageId: "recovery-finalization-receipt",
    requestId,
    sentAt,
    payload: {
      ...recovery.payload,
      status: "cancelled" as const,
      afterProjectIndexManifestId: "studio_project_index_manifest_after_recovery_gate",
      afterProjectRevisionHash: "e".repeat(64),
      afterProjectDetectorEpoch: 9,
    },
  };
  assertPluginToBackendMessage(recoveryReceipt);
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...recoveryReceipt,
        payload: { ...recoveryReceipt.payload, afterProjectDetectorEpoch: undefined },
      }),
    /CreatorChangeFinalized/,
    "a finalization receipt must retain the exact post-finalization capture epoch",
  );
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...recoveryReceipt,
        payload: { ...recoveryReceipt.payload, replacesAction: undefined },
      }),
    /CreatorChangeFinalized/,
    "a recovery-cancel receipt must echo the displaced action",
  );

  const recoveryAcknowledgement = createBackendMessage(
    "AcknowledgeCreatorChangeFinalization",
    {
      ...recoveryReceipt.payload,
      requestId,
    },
    "studio-finalization-gate",
    requestId,
    () => new Date(sentAt),
  );
  assertBackendToPluginMessage(recoveryAcknowledgement);
  assert.throws(
    () =>
      assertBackendToPluginMessage({
        ...recoveryAcknowledgement,
        payload: { ...recoveryAcknowledgement.payload, replacesAction: undefined },
      }),
    /AcknowledgeCreatorChangeFinalization/,
    "a recovery-cancel acknowledgement must echo the displaced action",
  );

  assert.throws(
    () =>
      assertPluginToBackendMessage({
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "CreatorChangeFinalized",
        messageId: "finalization-status-mismatch",
        requestId,
        sentAt,
        payload: {
          ...gate,
          status: "cancelled",
          afterProjectIndexManifestId: "studio_project_index_manifest_after_gate",
          afterProjectRevisionHash: "e".repeat(64),
          afterProjectDetectorEpoch: 9,
        },
      }),
    /CreatorChangeFinalized/,
    "a commit receipt cannot claim cancellation",
  );
});

test("mutation-failure receipts preserve recording-phase truth", () => {
  const binding = {
    creatorSessionId: "creator_failure_phase_session",
    changeSetId: "creator_failure_phase_change",
    changeSetHash: "a".repeat(64),
    projectionId: "creator_failure_phase_projection",
    projectionHash: "b".repeat(64),
    preflightProjectionId: "creator_failure_phase_preflight_projection",
    preflightProjectionHash: "c".repeat(64),
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    beforeProjectIndexManifestId: "studio_project_index_failure_phase",
    beforeProjectRevisionHash: "d".repeat(64),
    beforeProjectDetectorEpoch: 7,
  };
  const preflightFailure = {
    kind: "StudioProtocolMessage" as const,
    direction: "plugin_to_backend" as const,
    type: "CreatorMutationFailed" as const,
    messageId: "creator-failure-phase-preflight",
    requestId: "creator_failure_phase_request",
    sentAt,
    payload: {
      ...binding,
      stage: "preflight" as const,
      failureCode: "capability_preflight_failed",
      failureDetail: "Detached canary rejected the requested property conversion.",
      failureDetailHash: contentHash("Detached canary rejected the requested property conversion."),
      recordingState: "not_open" as const,
    },
  };
  assertPluginToBackendMessage(preflightFailure);

  // These are the two receipt shapes Runtime may emit before it has an exact
  // recording cursor: detached preflight and Apply before TryBeginRecording.
  // Their diagnostics remain canonical payload material, not an unbound
  // command-settlement string.
  const preRecordingApplyFailure = {
    ...preflightFailure,
    messageId: "creator-failure-phase-apply-not-open",
    payload: {
      ...binding,
      stage: "apply" as const,
      failureCode: "recording_intent_persistence_failed",
      failureDetail: "The durable creator recording intent could not be stored.",
      failureDetailHash: contentHash("The durable creator recording intent could not be stored."),
      recordingState: "not_open" as const,
    },
  };
  assertPluginToBackendMessage(preRecordingApplyFailure);
  assert.equal(
    preRecordingApplyFailure.payload.failureDetail,
    "The durable creator recording intent could not be stored.",
    "a valid pre-recording receipt preserves its exact bounded diagnostic",
  );

  assertPluginToBackendMessage({
    ...preflightFailure,
    messageId: "creator-failure-phase-post-recording",
    payload: {
      ...preflightFailure.payload,
      stage: "post_state",
      recordingId: "recording_failure_phase_unknown",
      recordingState: "unknown",
    },
  });

  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...preflightFailure,
        messageId: "creator-failure-phase-preflight-open",
        payload: { ...preflightFailure.payload, recordingState: "open" },
      }),
    /CreatorMutationFailed/,
    "a detached preflight cannot report an open recording",
  );
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...preflightFailure,
        messageId: "creator-failure-phase-readback-unnamed",
        payload: { ...preflightFailure.payload, stage: "readback" },
      }),
    /CreatorMutationFailed/,
    "post-recording failures require an exact recording id",
  );
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...preRecordingApplyFailure,
        messageId: "creator-failure-phase-apply-unknown-unnamed",
        payload: { ...preRecordingApplyFailure.payload, recordingState: "unknown" },
      }),
    /CreatorMutationFailed/,
    "an Apply failure after TryBeginRecording may be possible must not omit its exact recording id",
  );
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...preflightFailure,
        messageId: "creator-failure-phase-preflight-named",
        payload: { ...preflightFailure.payload, recordingId: "recording_preflight" },
      }),
    /CreatorMutationFailed/,
    "a preflight failure cannot claim a recording id",
  );
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...preflightFailure,
        messageId: "creator-failure-phase-unnamed-cancel",
        payload: {
          ...preflightFailure.payload,
          stage: "apply",
          cancellationProven: true,
        },
      }),
    /CreatorMutationFailed/,
    "an unnamed Apply rejection cannot prove cancellation",
  );
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...preflightFailure,
        messageId: "creator-failure-phase-tampered-detail",
        payload: {
          ...preflightFailure.payload,
          failureDetail: "A different diagnostic body.",
        },
      }),
    /CreatorMutationFailed/,
    "failure diagnostics are bound to their exact UTF-8 body",
  );
  const overlongUtf8Detail = "\u{1F6A8}".repeat(1025);
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...preflightFailure,
        messageId: "creator-failure-phase-overlong-utf8-detail",
        payload: {
          ...preflightFailure.payload,
          failureDetail: overlongUtf8Detail,
          failureDetailHash: contentHash(overlongUtf8Detail),
        },
      }),
    /CreatorMutationFailed/,
    "failure diagnostics are bounded by UTF-8 bytes, not JavaScript character count",
  );

  assertPluginToBackendMessage({
    ...preflightFailure,
    messageId: "creator-failure-phase-cancelled",
    payload: {
      ...preflightFailure.payload,
      stage: "readback",
      recordingId: "recording_failure_phase",
      cancellationProven: true,
    },
  });
});
