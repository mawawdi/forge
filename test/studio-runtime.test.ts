import assert from "node:assert/strict";
import test from "node:test";
import {
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioProjectEvidenceShard,
  createStudioEvidenceEnvelope,
  createStudioProjectIndexCapture,
  createStudioProjectIndexProjection,
} from "../packages/studio-evidence/src/index.js";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  createStudioExecutionPlan,
  type StudioExecutionPlan,
} from "../packages/studio-capabilities/src/index.js";
import type {
  StudioBridgeConnection,
  StudioBridgeSession,
} from "../packages/studio-bridge/src/index.js";
import type {
  BackendToPluginMessage,
  PluginToBackendMessage,
} from "../packages/studio-protocol/src/index.js";
import {
  StudioProjectIndexStreamRouter,
  executeCreatorVerificationPlan,
  executeStudioCapabilityCanary,
  waitForStudioProjectIndexCapture,
} from "../packages/studio-runtime/src/index.js";
import {
  completeProjectProperties,
  completeProjectPropertyNames,
} from "./helpers/studio-project-fixtures.js";

const hash = "a".repeat(64);
const project = { name: "Runtime Failure Vector", placeId: 0, universeId: 0 };
const session: StudioBridgeSession = {
  sessionId: "studio_session_runtime_failure",
  projectId: "studio_project_runtime_failure",
  project,
  capabilities: ["studio_play_mode"],
  manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
  connectorBuildHash: hash,
  capabilityAttestationProjectionHash: "b".repeat(64),
  sessionToken: "runtime_session_token_1234567890123456",
  connectedAt: "2026-09-01T00:00:00.000Z",
};

function creatorPlan(): StudioExecutionPlan {
  return createStudioExecutionPlan({
    purpose: "creator_verification",
    binding: {
      runId: "creator_runtime_run",
      correlationId: "creator_runtime_correlation",
      sessionId: session.sessionId,
      projectId: session.projectId,
      project,
      projectRevisionHash: "d".repeat(64),
    },
    targets: [
      {
        id: "creator_target_door",
        identity: { kind: "forge_attribute", stableId: "creator-runtime-door" },
        path: "Workspace/Door",
        expectedClass: "BasePart",
      },
    ],
    calls: [
      {
        id: "resolve_creator_target_door",
        capability: "instance.resolve",
        targetId: "creator_target_door",
      },
    ],
    budget: { maxExecutionMs: 1_000, maxResultBytes: 4_096 },
    observationWindowMs: 0,
  });
}

function canaryCapture(detectorEpoch = 0) {
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project,
    connectorEpoch: "runtime_test_connector_epoch",
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: {
      kind: "CreatorResourcePolicy",
      maximumInstances: 8,
      maximumCanonicalIndexBytes: 65_536,
      maximumSourceBlobBytes: 16_384,
      maximumIndexingDurationMs: 1_000,
      maximumNodesPerShard: 8,
      maximumCanonicalShardBytes: 65_536,
      transportChunkBytes: 4_096,
    },
  });
  const shard = createStudioProjectEvidenceShard({
    root: "Workspace",
    ordinal: 0,
    nodes: [
      {
        identity: { kind: "forge_attribute", stableId: "runtime_canary_door" },
        displayPath: "Workspace/Door",
        name: "Door",
        className: "Part",
        attributes: {},
        tags: [],
        coveredProperties: completeProjectProperties("Part", {
          Position: { kind: "vector3_f32", x: 0, y: 0, z: 0 },
        }),
        coveredPropertyNames: completeProjectPropertyNames("Part"),
      },
    ],
  });
  return createStudioProjectIndexCapture({
    projection,
    shards: [shard],
    sourceManifests: [],
    sourceChunks: [],
    completedAt: "2026-09-01T00:00:00.000Z",
    detectorEpoch,
  });
}

function projectIndexStream(
  capture: ReturnType<typeof canaryCapture>,
  startedEpoch: number,
  completedEpoch: number,
): PluginToBackendMessage[] {
  assert.equal(
    capture.detectorEpoch,
    startedEpoch,
    "the immutable capture hash must bind the stream's starting detector epoch",
  );
  const shard = capture.shards[0]!;
  const payload = JSON.stringify(shard);
  const { sourceManifestHashes: _sourceManifestHashes, ...indexManifest } = capture.indexManifest;
  return [
    {
      kind: "StudioProtocolMessage",
      direction: "plugin_to_backend",
      type: "StudioProjectIndexStarted",
      messageId: "index-start",
      requestId: "index-request",
      sessionId: session.sessionId,
      sentAt: "2026-09-01T00:00:00.000Z",
      payload: {
        project,
        captureId: capture.indexManifest.id,
        projection: capture.projection,
        pieceCount: 1,
        expectedShardCount: 1,
        expectedSourceManifestCount: 0,
        expectedSourceChunkCount: 0,
        expectedCanonicalBytes: capture.indexManifest.canonicalBytes,
        detectorEpoch: startedEpoch,
      },
    },
    {
      kind: "StudioProtocolMessage",
      direction: "plugin_to_backend",
      type: "StudioProjectEvidenceShard",
      messageId: "index-shard",
      requestId: "index-request",
      sessionId: session.sessionId,
      sentAt: "2026-09-01T00:00:00.000Z",
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
    },
    {
      kind: "StudioProtocolMessage",
      direction: "plugin_to_backend",
      type: "StudioProjectIndexCompleted",
      messageId: "index-completed",
      requestId: "index-request",
      sessionId: session.sessionId,
      sentAt: "2026-09-01T00:00:00.000Z",
      payload: {
        project,
        captureId: capture.indexManifest.id,
        pieceCount: 1,
        indexManifest: { ...indexManifest, sourceManifestCount: 0 },
        revision: capture.revision,
        captureHash: capture.hash,
        detectorEpoch: completedEpoch,
      },
    },
  ];
}

function pluginError(
  requestId: string,
  message: string,
): Extract<PluginToBackendMessage, { type: "PluginError" }> {
  return {
    kind: "StudioProtocolMessage",
    direction: "plugin_to_backend",
    type: "PluginError",
    messageId: `plugin_error_${message.replaceAll(" ", "_")}`,
    requestId,
    sessionId: session.sessionId,
    sentAt: "2026-09-01T00:00:00.000Z",
    payload: {
      code: "SECURITY_REJECTION",
      message,
      retryable: false,
    },
  };
}

function connectionThatEmits(
  emit: (
    request: BackendToPluginMessage,
    handler: Parameters<StudioBridgeConnection["subscribeWithSession"]>[0],
  ) => void,
  options: { acknowledgePassiveFinalization?: boolean } = {},
): StudioBridgeConnection {
  let handler: Parameters<StudioBridgeConnection["subscribeWithSession"]>[0] | undefined;
  return {
    async send(request) {
      if (!handler) throw new Error("runtime listener was not installed before dispatch");
      if (request.type === "FinalizePassiveRuntimeEval") {
        if (options.acknowledgePassiveFinalization === false) return;
        assert.ok(request.requestId);
        await handler(
          {
            kind: "StudioProtocolMessage",
            direction: "plugin_to_backend",
            type: "PassiveRuntimeEvalFinalized",
            messageId: `passive_runtime_finalized_${request.messageId}`,
            requestId: request.requestId,
            sessionId: session.sessionId,
            sentAt: "2026-09-01T00:00:02.000Z",
            payload: {
              executionPlanId: request.payload.executionPlanId,
              executionPlanHash: request.payload.executionPlanHash,
              projectionId: request.payload.projectionId,
              projectionHash: request.payload.projectionHash,
              bindingHash: request.payload.bindingHash,
              nonceCommitment: request.payload.nonceCommitment,
              status: "cleared",
            },
          },
          session,
        );
        return;
      }
      emit(request, handler);
    },
    async sendAndWaitForSettlement(request, _timeoutMs) {
      await this.send(request);
    },
    subscribeWithSession(next) {
      handler = next;
      return () => {
        if (handler === next) handler = undefined;
      };
    },
    async close() {},
  };
}

test("creator verification treats a plugin rejection before acceptance as terminal", async () => {
  const plan = creatorPlan();
  const connection = connectionThatEmits((request, handler) => {
    assert.equal(request.type, "ExecuteRuntimeEvalPlan");
    if (request.type === "ExecuteRuntimeEvalPlan")
      assert.equal(request.payload.startPolicy, "observe_next_creator_play");
    const requestId = request.requestId;
    assert.ok(requestId);
    void handler(pluginError(requestId, "runtime evidence projection rejected"), session);
  });
  const startedAt = Date.now();
  const result = await executeCreatorVerificationPlan({
    connection,
    session,
    executionPlan: plan,
    timeoutMs: 1_000,
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.failure?.classification, "protocol");
  assert.match(result.failure?.detail ?? "", /runtime evidence projection rejected/);
  assert.ok(Date.now() - startedAt < 250, "request-scoped rejection must not wait for the timeout");
});

test("creator verification treats a plugin rejection before runtime start as terminal", async () => {
  const plan = creatorPlan();
  const connection = connectionThatEmits((request, handler) => {
    const requestId = request.requestId;
    assert.ok(requestId);
    void handler(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "RuntimeEvalPlanAccepted",
        messageId: "runtime_plan_accepted",
        requestId,
        sessionId: session.sessionId,
        sentAt: "2026-09-01T00:00:00.000Z",
        payload: {
          executionPlanId: plan.id,
          executionPlanHash: plan.hash,
          projectionId: plan.evidenceProjection.id,
          projectionHash: plan.evidenceProjection.contentHash,
          bindingHash: plan.evidenceProjection.bindingHash,
          nonceCommitment: "e".repeat(64),
          callCount: plan.calls.length,
          instruction: "Creator-authorized runtime execution is armed.",
        },
      },
      session,
    );
    void handler(
      pluginError(requestId, "runtime precondition requires complete project-state evidence"),
      session,
    );
  });
  const startedAt = Date.now();
  const result = await executeCreatorVerificationPlan({
    connection,
    session,
    executionPlan: plan,
    timeoutMs: 1_000,
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.failure?.classification, "protocol");
  assert.match(result.failure?.detail ?? "", /runtime precondition/);
  assert.ok(Date.now() - startedAt < 250, "pre-start rejection must not wait for the timeout");
});

test("capability canary rejects a complete project index that is not bound to its plan", async () => {
  const prePlayCapture = canaryCapture();
  const plan = createStudioExecutionPlan({
    purpose: "capability_canary",
    binding: {
      runId: "runtime_canary_run",
      correlationId: "runtime_canary_correlation",
      sessionId: session.sessionId,
      projectId: session.projectId,
      project,
      projectRevisionHash: "f".repeat(64),
    },
    targets: [
      {
        id: "canary_door",
        identity: { kind: "forge_attribute", stableId: "runtime_canary_door" },
        path: "Workspace/Door",
        expectedClass: "BasePart",
      },
    ],
    calls: [
      {
        id: "resolve_canary_door",
        capability: "instance.resolve",
        targetId: "canary_door",
      },
      {
        id: "observe_canary_door",
        capability: "base_part.position",
        targetId: "canary_door",
      },
    ],
    budget: { maxExecutionMs: 1_000, maxResultBytes: 4_096 },
    observationWindowMs: 0,
  });
  let sent = false;
  const connection = connectionThatEmits(() => {
    sent = true;
  });
  const result = await executeStudioCapabilityCanary({
    connection,
    session,
    executionPlan: plan,
    prePlayCapture,
    staticTargetIds: ["canary_door"],
    timeoutMs: 1_000,
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.failure?.classification, "protocol");
  assert.match(result.failure?.detail ?? "", /pre-Play project revision/);
  assert.equal(sent, false, "a stale project index must fail before Play is requested");
});

test("project-index stream rejects a detector epoch change during collection", async () => {
  const capture = canaryCapture(12);
  await assert.rejects(
    () =>
      waitForStudioProjectIndexCapture({
        messages: projectIndexStream(capture, 12, 13),
        requestId: "index-request",
        manifestId: capture.indexManifest.id,
        revisionHash: capture.revision.hash,
        detectorEpoch: capture.detectorEpoch,
        timeoutMs: 100,
        label: "detector epoch test",
      }),
    /detector epoch mismatch/,
  );
});

test("project-index stream reassembles one artifact incrementally across fragments", async () => {
  const capture = canaryCapture(12);
  const messages = projectIndexStream(capture, 12, 12);
  const original = messages[1];
  assert.ok(original?.type === "StudioProjectEvidenceShard");
  const midpoint = Math.floor(original.payload.payload.length / 2);
  const fragments = [
    original.payload.payload.slice(0, midpoint),
    original.payload.payload.slice(midpoint),
  ];
  messages[0] = {
    ...messages[0]!,
    payload: { ...messages[0]!.payload, pieceCount: 2 },
  } as PluginToBackendMessage;
  messages.splice(
    1,
    1,
    ...fragments.map((payload, fragmentOrdinal) => ({
      ...original,
      messageId: `index-shard-${fragmentOrdinal}`,
      payload: {
        ...original.payload,
        sequence: fragmentOrdinal,
        fragmentOrdinal,
        fragmentCount: 2,
        payload,
        payloadHash: contentHash(payload),
      },
    })),
  );
  const completed = messages.at(-1)!;
  assert.ok(completed.type === "StudioProjectIndexCompleted");
  messages[messages.length - 1] = {
    ...completed,
    payload: { ...completed.payload, pieceCount: 2 },
  };
  const router = new StudioProjectIndexStreamRouter();
  for (const message of messages) assert.equal(router.observe(message), true);
  const restored = await router.wait({
    requestId: "index-request",
    manifestId: capture.indexManifest.id,
    revisionHash: capture.revision.hash,
    detectorEpoch: capture.detectorEpoch,
    timeoutMs: 100,
    label: "incremental project index",
  });
  assert.equal(restored.hash, capture.hash);
});

test("transaction project-index binding includes the exact detector epoch", async () => {
  const capture = canaryCapture(17);
  const router = new StudioProjectIndexStreamRouter();
  for (const message of projectIndexStream(capture, 17, 17))
    assert.equal(router.observe(message), true);
  await assert.rejects(
    router.wait({
      requestId: "index-request",
      manifestId: capture.indexManifest.id,
      revisionHash: capture.revision.hash,
      detectorEpoch: 18,
      timeoutMs: 100,
      label: "exact detector epoch",
    }),
    /binding mismatch/,
  );
});

test("transaction router rejects a second project-index stream on one request", async () => {
  const capture = canaryCapture(21);
  const messages = projectIndexStream(capture, 21, 21);
  const router = new StudioProjectIndexStreamRouter();
  for (const message of messages) assert.equal(router.observe(message), true);
  assert.equal(router.observe(messages[0]!), true);
  await assert.rejects(
    router.wait({
      requestId: "index-request",
      manifestId: capture.indexManifest.id,
      revisionHash: capture.revision.hash,
      detectorEpoch: capture.detectorEpoch,
      timeoutMs: 100,
      label: "single transaction project index",
    }),
    /more than one stream/,
  );
});

test("transaction router seals and releases an unsolicited recovery index", () => {
  const capture = canaryCapture(31);
  const messages = projectIndexStream(capture, 31, 31).map((message) => {
    const { requestId: _requestId, ...unscoped } = message;
    return unscoped as PluginToBackendMessage;
  });
  const router = new StudioProjectIndexStreamRouter();
  for (const message of messages) assert.equal(router.observe(message), true);
  assert.equal(router.takeCompleted()?.hash, capture.hash);
  assert.equal(router.takeCompleted(), undefined, "a completed recovery stream is consumed once");
});

test("creator verification does not turn human Play latency into a transport timeout", async () => {
  const plan = creatorPlan();
  const lifecycleEvents: string[] = [];
  const requirement = plan.evidenceProjection.requirements[0]!;
  const envelope = createStudioEvidenceEnvelope(
    {
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      projectionId: plan.evidenceProjection.id,
      projectionHash: plan.evidenceProjection.contentHash,
      bindingHash: plan.evidenceProjection.bindingHash,
      project,
      authoritative: true,
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      completion: "complete",
      facts: [
        {
          kind: "runtime_resolution",
          key: requirement.key,
          target: requirement.target,
          callId: requirement.callId!,
          runtimeTargetId: requirement.runtimeTargetId!,
          capability: "instance.resolve",
          result: { status: "observed", value: { path: "Workspace/Door", className: "BasePart" } },
        },
      ],
    },
    plan.evidenceProjection,
  );
  const connection = connectionThatEmits((request, handler) => {
    const requestId = request.requestId!;
    const common = {
      kind: "StudioProtocolMessage" as const,
      direction: "plugin_to_backend" as const,
      requestId,
      sessionId: session.sessionId,
      sentAt: "2026-09-01T00:00:01.000Z",
    };
    const identity = {
      executionPlanId: plan.id,
      executionPlanHash: plan.hash,
      projectionId: plan.evidenceProjection.id,
      projectionHash: plan.evidenceProjection.contentHash,
      bindingHash: plan.evidenceProjection.bindingHash,
      nonceCommitment: "e".repeat(64),
    };
    const lifecycle = {
      ...identity,
      mode: "play_solo" as const,
      playerCount: 1,
      control: "creator_action" as const,
    };
    // A re-arm uses the same immutable execution plan. These deliberately
    // malformed replies therefore prove that the runtime client keys every
    // lifecycle transition to the new requestId, not just the plan hash.
    const staleIdentity = { ...identity, nonceCommitment: "f".repeat(64) };
    void handler(
      {
        ...common,
        requestId: "runtime_request_stale",
        type: "RuntimeEvalPlanAccepted",
        messageId: "stale_accept",
        payload: {
          ...staleIdentity,
          callCount: plan.calls.length,
          instruction: "Ignore stale request.",
        },
      },
      session,
    );
    void handler(
      {
        ...common,
        requestId: "runtime_request_stale",
        type: "RuntimeEvalStarted",
        messageId: "stale_start",
        payload: { ...staleIdentity, mode: "play_solo", playerCount: 1, control: "plugin_action" },
      },
      session,
    );
    void handler(
      {
        ...common,
        type: "RuntimeEvalPlanAccepted",
        messageId: "human_wait_accept",
        payload: {
          ...identity,
          callCount: plan.calls.length,
          instruction: "Press Play when ready.",
        },
      },
      session,
    );
    setTimeout(() => {
      void handler(
        {
          ...common,
          type: "RuntimeEvalStarted",
          messageId: "human_wait_start",
          payload: lifecycle,
        },
        session,
      );
      void handler(
        {
          ...common,
          type: "StudioEvidenceProduced",
          messageId: "human_wait_evidence",
          payload: { project, reason: "runtime", projection: plan.evidenceProjection, envelope },
        },
        session,
      );
      void handler(
        { ...common, type: "RuntimeEvalStopped", messageId: "human_wait_stop", payload: lifecycle },
        session,
      );
    }, 60);
  });
  const result = await executeCreatorVerificationPlan({
    connection,
    session,
    executionPlan: plan,
    timeoutMs: 10,
    onLifecycle: (event) => {
      lifecycleEvents.push(event);
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.evidence?.contentHash, envelope.contentHash);
  assert.deepEqual(lifecycleEvents, ["started", "stopped"]);
});

test("creator verification ends an unbounded human-Play wait when Studio unpairs", async () => {
  const plan = creatorPlan();
  const connection = connectionThatEmits((request, handler) => {
    const requestId = request.requestId!;
    const identity = {
      executionPlanId: plan.id,
      executionPlanHash: plan.hash,
      projectionId: plan.evidenceProjection.id,
      projectionHash: plan.evidenceProjection.contentHash,
      bindingHash: plan.evidenceProjection.bindingHash,
      nonceCommitment: "e".repeat(64),
    };
    void handler(
      {
        kind: "StudioProtocolMessage",
        direction: "plugin_to_backend",
        type: "RuntimeEvalPlanAccepted",
        messageId: "unpair_accept",
        requestId,
        sessionId: session.sessionId,
        sentAt: "2026-09-01T00:00:01.000Z",
        payload: { ...identity, callCount: plan.calls.length, instruction: "Press Play." },
      },
      session,
    );
    setTimeout(() => {
      void handler(
        {
          kind: "StudioProtocolMessage",
          direction: "plugin_to_backend",
          type: "UnpairProject",
          messageId: "unpair_before_play",
          sessionId: session.sessionId,
          sentAt: "2026-09-01T00:00:02.000Z",
          payload: { reason: "plugin_unload" },
        },
        session,
      );
    }, 25);
  });
  const startedAt = Date.now();
  const result = await executeCreatorVerificationPlan({
    connection,
    session,
    executionPlan: plan,
    timeoutMs: 1,
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.failure?.classification, "studio");
  assert.match(result.failure?.detail ?? "", /Studio disconnected while waiting for runtime start/);
  assert.ok(Date.now() - startedAt < 250, "unpair must end an otherwise unbounded human-Play wait");
});

test("creator verification retains a stop-sealed incomplete evidence envelope", async () => {
  const plan = creatorPlan();
  const lifecycleEvents: string[] = [];
  const requirement = plan.evidenceProjection.requirements[0]!;
  const envelope = createStudioEvidenceEnvelope(
    {
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      projectionId: plan.evidenceProjection.id,
      projectionHash: plan.evidenceProjection.contentHash,
      bindingHash: plan.evidenceProjection.bindingHash,
      project,
      authoritative: true,
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      completion: "incomplete",
      facts: [
        {
          kind: "runtime_resolution",
          key: requirement.key,
          target: requirement.target,
          callId: requirement.callId!,
          runtimeTargetId: requirement.runtimeTargetId!,
          capability: "instance.resolve",
          result: { status: "read_error", code: "missing_runtime_result" },
        },
      ],
    },
    plan.evidenceProjection,
  );
  const connection = connectionThatEmits((request, handler) => {
    const requestId = request.requestId!;
    const common = {
      kind: "StudioProtocolMessage" as const,
      direction: "plugin_to_backend" as const,
      requestId,
      sessionId: session.sessionId,
      sentAt: "2026-09-01T00:00:01.000Z",
    };
    const identity = {
      executionPlanId: plan.id,
      executionPlanHash: plan.hash,
      projectionId: plan.evidenceProjection.id,
      projectionHash: plan.evidenceProjection.contentHash,
      bindingHash: plan.evidenceProjection.bindingHash,
      nonceCommitment: "e".repeat(64),
    };
    const lifecycle = {
      ...identity,
      mode: "play_solo" as const,
      playerCount: 1,
      control: "creator_action" as const,
    };
    void handler(
      {
        ...common,
        type: "RuntimeEvalPlanAccepted",
        messageId: "passive_accept",
        payload: { ...identity, callCount: plan.calls.length, instruction: "Press Play." },
      },
      session,
    );
    void handler(
      { ...common, type: "RuntimeEvalStarted", messageId: "passive_start", payload: lifecycle },
      session,
    );
    void handler(
      {
        ...common,
        type: "StudioEvidenceProduced",
        messageId: "passive_evidence",
        payload: { project, reason: "runtime", projection: plan.evidenceProjection, envelope },
      },
      session,
    );
    void handler(
      { ...common, type: "RuntimeEvalStopped", messageId: "passive_stop", payload: lifecycle },
      session,
    );
  });
  const result = await executeCreatorVerificationPlan({
    connection,
    session,
    executionPlan: plan,
    timeoutMs: 1_000,
    onLifecycle: (event) => {
      lifecycleEvents.push(event);
    },
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.evidence?.contentHash, envelope.contentHash);
  assert.equal(result.failure?.classification, "capability");
  assert.deepEqual(lifecycleEvents, ["started", "stopped"]);
});

test("creator verification retains validated evidence when passive cleanup acknowledgement is lost", async () => {
  const plan = creatorPlan();
  const lifecycleEvents: string[] = [];
  const requirement = plan.evidenceProjection.requirements[0]!;
  const envelope = createStudioEvidenceEnvelope(
    {
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      projectionId: plan.evidenceProjection.id,
      projectionHash: plan.evidenceProjection.contentHash,
      bindingHash: plan.evidenceProjection.bindingHash,
      project,
      authoritative: true,
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      completion: "complete",
      facts: [
        {
          kind: "runtime_resolution",
          key: requirement.key,
          target: requirement.target,
          callId: requirement.callId!,
          runtimeTargetId: requirement.runtimeTargetId!,
          capability: "instance.resolve",
          result: { status: "observed", value: { path: "Workspace/Door", className: "BasePart" } },
        },
      ],
    },
    plan.evidenceProjection,
  );
  const connection = connectionThatEmits(
    (request, handler) => {
      const requestId = request.requestId!;
      const common = {
        kind: "StudioProtocolMessage" as const,
        direction: "plugin_to_backend" as const,
        requestId,
        sessionId: session.sessionId,
        sentAt: "2026-09-01T00:00:01.000Z",
      };
      const identity = {
        executionPlanId: plan.id,
        executionPlanHash: plan.hash,
        projectionId: plan.evidenceProjection.id,
        projectionHash: plan.evidenceProjection.contentHash,
        bindingHash: plan.evidenceProjection.bindingHash,
        nonceCommitment: "e".repeat(64),
      };
      const lifecycle = {
        ...identity,
        mode: "play_solo" as const,
        playerCount: 1,
        control: "creator_action" as const,
      };
      void handler(
        {
          ...common,
          type: "RuntimeEvalPlanAccepted",
          messageId: "cleanup_loss_accept",
          payload: { ...identity, callCount: plan.calls.length, instruction: "Press Play." },
        },
        session,
      );
      void handler(
        {
          ...common,
          type: "RuntimeEvalStarted",
          messageId: "cleanup_loss_start",
          payload: lifecycle,
        },
        session,
      );
      void handler(
        {
          ...common,
          type: "StudioEvidenceProduced",
          messageId: "cleanup_loss_evidence",
          payload: { project, reason: "runtime", projection: plan.evidenceProjection, envelope },
        },
        session,
      );
      void handler(
        {
          ...common,
          type: "RuntimeEvalStopped",
          messageId: "cleanup_loss_stop",
          payload: lifecycle,
        },
        session,
      );
    },
    { acknowledgePassiveFinalization: false },
  );
  const result = await executeCreatorVerificationPlan({
    connection,
    session,
    executionPlan: plan,
    timeoutMs: 20,
    onLifecycle: (event) => {
      lifecycleEvents.push(event);
    },
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.evidence?.contentHash, envelope.contentHash);
  assert.equal(result.failure?.classification, "timeout");
  assert.match(result.failure?.detail ?? "", /passive runtime finalization/);
  assert.deepEqual(lifecycleEvents, ["started"]);
});
