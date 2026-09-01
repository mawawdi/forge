import assert from "node:assert/strict";
import test from "node:test";
import {
  STUDIO_CAPABILITY_MANIFEST_HASH,
} from "../packages/studio-evidence/src/index.js";
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
import { executeCreatorVerificationPlan } from "../packages/studio-runtime/src/index.js";

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
  projectStateProjectionHash: "c".repeat(64),
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
      projectStateRevisionHash: "d".repeat(64),
    },
    targets: [
      {
        id: "creator_target_door",
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
): StudioBridgeConnection {
  let handler:
    | Parameters<StudioBridgeConnection["subscribeWithSession"]>[0]
    | undefined;
  return {
    async send(request) {
      if (!handler) throw new Error("runtime listener was not installed before dispatch");
      emit(request, handler);
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
    const requestId = request.requestId;
    assert.ok(requestId);
    void handler(
      pluginError(requestId, "runtime evidence projection rejected"),
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
