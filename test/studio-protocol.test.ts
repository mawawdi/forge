import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { stableJson } from "../packages/contracts/src/index.js";
import {
  StudioBridgeServer,
  createBackendMessage,
} from "../packages/studio-bridge/src/index.js";
import {
  STUDIO_MATERIALS,
  createCreatorControlView,
} from "../packages/creator-session/src/index.js";
import {
  STUDIO_CAPABILITY_SET,
  createStudioExecutionPlan,
  serializeStudioExecutionPlan,
} from "../packages/studio-capabilities/src/index.js";
import {
  assertBackendToPluginMessage,
  assertPluginToBackendMessage,
  type PluginToBackendMessage,
  type StudioCapability,
} from "../packages/studio-protocol/src/index.js";

const time = "2026-08-31T00:00:00.000Z";
const identity = { name: "RuntimeFixture", placeId: 0, universeId: 0 };
const capabilities: StudioCapability[] = [
  "snapshot",
  "snapshot_chunks",
  "sha256",
  "stable_identity",
  "studio_play_mode",
  "http_polling",
  "bounded_diagnostics",
  "runtime_eval",
  "studio_authoring",
  "creator_control",
];
const base = {
  kind: "StudioProtocolMessage" as const,
  direction: "plugin_to_backend" as const,
  sentAt: time,
};

test("the protocol accepts only the canonical creator and evaluation capability surface", () => {
  const pair: PluginToBackendMessage = {
    ...base,
    type: "PairProject",
    messageId: "pair",
    payload: { pairingToken: "pairing-token", project: identity, capabilities },
  };
  assertPluginToBackendMessage(pair);
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...pair,
        payload: {
          ...pair.payload,
          capabilities: [...capabilities, "typed_patch"],
        },
      }),
    /PairProject/,
  );
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...base,
        type: "PatchApplied",
        messageId: "old",
        payload: {},
      }),
    /message type/,
  );
});

test("runtime execution accepts one canonical JSON string and keeps hostile text as data", () => {
  const hash = createHash("sha256").update("snapshot").digest("hex");
  const plan = createStudioExecutionPlan({
    purpose: "capability_canary",
    capabilitySetId: STUDIO_CAPABILITY_SET.id,
    capabilitySetHash: STUDIO_CAPABILITY_SET.hash,
    binding: {
      runId: "run",
      correlationId: "correlation",
      sessionId: "session",
      projectId: "project",
      project: identity,
      projectSnapshotHash: hash,
    },
    targets: [
      {
        id: "target",
        path: 'Workspace/Door"; error("injected") --',
        expectedClass: "BasePart",
      },
    ],
    calls: [{ id: "call", capability: "instance.resolve", targetId: "target" }],
    budget: { maxExecutionMs: 1000, maxResultBytes: 4096 },
  });
  const json = serializeStudioExecutionPlan(plan);
  assert.match(json, /error/);
  const message = createBackendMessage(
    "ExecuteRuntimeEvalPlan",
    {
      requestId: "request",
      expectedRevision: hash,
      executionPlanJson: json,
      executionPlanJsonHash: createHash("sha256").update(json).digest("hex"),
      startPolicy: "explicit_plugin_action",
    },
    "session",
    "request",
    () => new Date(time),
  );
  assertBackendToPluginMessage(message);
  assert.throws(
    () =>
      assertBackendToPluginMessage({
        ...message,
        payload: {
          ...message.payload,
          executionPlanJson: `${json} `,
          executionPlanJsonHash: createHash("sha256")
            .update(`${json} `)
            .digest("hex"),
        },
      }),
    /canonical plan JSON string/,
  );
  assert.throws(
    () =>
      assertBackendToPluginMessage({
        ...message,
        payload: { ...message.payload, executionPlanJsonHash: "0".repeat(64) },
      }),
    /ExecuteRuntimeEvalPlan/,
  );
});

test("runtime execution permits service-root resolution but rejects service-root BasePart observation", () => {
  const hash = createHash("sha256").update("snapshot").digest("hex");
  const binding = {
    runId: "service-root-run",
    correlationId: "service-root-correlation",
    sessionId: "session",
    projectId: "project",
    project: identity,
    projectSnapshotHash: hash,
  };
  const scriptPlan = createStudioExecutionPlan({
    purpose: "creator_verification",
    capabilitySetId: STUDIO_CAPABILITY_SET.id,
    capabilitySetHash: STUDIO_CAPABILITY_SET.hash,
    binding,
    targets: [
      {
        id: "controller",
        path: "ServerScriptService/StatusBeaconController",
        expectedClass: "Script",
      },
    ],
    calls: [
      {
        id: "resolve-controller",
        capability: "instance.resolve",
        targetId: "controller",
      },
    ],
    budget: { maxExecutionMs: 1000, maxResultBytes: 4096 },
  });
  assert.doesNotThrow(() => serializeStudioExecutionPlan(scriptPlan));
  assert.throws(
    () =>
      createStudioExecutionPlan({
        purpose: "creator_verification",
        capabilitySetId: STUDIO_CAPABILITY_SET.id,
        capabilitySetHash: STUDIO_CAPABILITY_SET.hash,
        binding,
        targets: [
          {
            id: "stored-part",
            path: "ServerStorage/StoredPart",
            expectedClass: "BasePart",
          },
        ],
        calls: [
          {
            id: "call-01-resolve-stored-part",
            capability: "instance.resolve",
            targetId: "stored-part",
          },
          {
            id: "call-02-position-stored-part",
            capability: "base_part.position",
            targetId: "stored-part",
          },
        ],
        budget: { maxExecutionMs: 1000, maxResultBytes: 4096 },
      }),
    /Workspace/,
  );
});

test("the protocol carries one canonical control view and one view-bound creator action", () => {
  const view = createCreatorControlView({
    creatorSessionId: "creator_session_protocol",
    creatorSessionHash: "a".repeat(64),
    status: "awaiting_plan_approval",
    title: "Review Plan",
    detail: "Review exact changes.",
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
  const viewJson = stableJson(view);
  const presented = createBackendMessage(
    "PresentCreatorControlView",
    {
      viewJson,
      viewJsonHash: createHash("sha256").update(viewJson).digest("hex"),
    },
    "session",
    undefined,
    () => new Date(time),
  );
  assertBackendToPluginMessage(presented);
  assert.throws(
    () =>
      assertBackendToPluginMessage({
        ...presented,
        payload: { ...presented.payload, viewJsonHash: "0".repeat(64) },
      }),
    /ControlView/,
  );
  const requested: PluginToBackendMessage = {
    ...base,
    type: "CreatorControlActionRequested",
    messageId: "creator-action",
    sessionId: "session",
    payload: {
      creatorSessionId: view.creatorSessionId,
      viewId: view.id,
      viewHash: view.hash,
      actionId: "approve_plan",
    },
  };
  assertPluginToBackendMessage(requested);
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...requested,
        payload: { ...requested.payload, actionId: "apply" },
      }),
    /ControlAction/,
  );
});

test("creator apply is bound to the same observed revision as preparation", () => {
  const expectedRevision = "a".repeat(64);
  const apply = createBackendMessage(
    "ApplyCreatorChangeSet",
    {
      requestId: "apply_request",
      creatorSessionId: "creator_session_apply",
      changeSetId: "creator_change_set_apply",
      changeSetHash: "b".repeat(64),
      expectedRevision,
    },
    "studio_session",
    "apply_request",
    () => new Date(time),
  );
  assertBackendToPluginMessage(apply);
  const invalid = structuredClone(apply) as unknown as {
    payload: Record<string, unknown>;
  };
  delete invalid.payload.expectedRevision;
  assert.throws(
    () => assertBackendToPluginMessage(invalid),
    /ApplyCreatorChangeSet/,
  );
});

test("bridge pairs one plugin session and enforces control authentication", async () => {
  const bridge = new StudioBridgeServer({
    port: 0,
    controlToken: "control_token_12345678901234567890",
  });
  const address = await bridge.listen();
  const url = `http://${address.host}:${address.port}`;
  try {
    const grant = (await fetch(`${url}/pairing`).then((response) =>
      response.json(),
    )) as { pairing: { token: string } };
    const pair: PluginToBackendMessage = {
      ...base,
      type: "PairProject",
      messageId: "pair-live",
      payload: {
        pairingToken: grant.pairing.token,
        project: identity,
        capabilities,
      },
    };
    const paired = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pair),
    });
    assert.equal(paired.status, 200);
    const session = (await paired.json()) as {
      sessionId: string;
      sessionToken: string;
    };
    assert.equal(bridge.getSessions().length, 1);
    assert.equal((await fetch(`${url}/sessions`)).status, 401);
    assert.equal(
      (
        await fetch(`${url}/sessions`, {
          headers: { "x-forge-control-token": address.controlToken },
        })
      ).status,
      200,
    );
    const heartbeat: PluginToBackendMessage = {
      ...base,
      type: "Heartbeat",
      messageId: "heartbeat",
      sessionId: session.sessionId,
      payload: { project: identity },
    };
    assert.equal(
      (
        await fetch(`${url}/message`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forge-session-token": session.sessionToken,
          },
          body: JSON.stringify(heartbeat),
        })
      ).status,
      202,
    );
  } finally {
    await bridge.close();
  }
});

test("snapshot chunks require bounded indices and SHA-256 payload integrity", () => {
  const payload = '{"kind":"StudioSnapshotObservation"}';
  const chunk: PluginToBackendMessage = {
    ...base,
    type: "SnapshotChunk",
    messageId: "chunk",
    sessionId: "session",
    payload: {
      project: identity,
      revision: {
        kind: "StudioRevision",
        observationHash: "a".repeat(64),
        identityHash: "b".repeat(64),
        capturedAt: time,
      },
      reason: "pre_play",
      snapshotId: "snapshot",
      index: 0,
      total: 1,
      encoding: "json",
      payload,
      payloadHash: createHash("sha256").update(payload).digest("hex"),
    },
  };
  assertPluginToBackendMessage(chunk);
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...chunk,
        payload: { ...chunk.payload, payloadHash: "0".repeat(64) },
      }),
    /SnapshotChunk/,
  );
  assert.throws(
    () =>
      assertPluginToBackendMessage({
        ...chunk,
        payload: { ...chunk.payload, index: 1 },
      }),
    /SnapshotChunk/,
  );
});

test("plugin contains only observation, transport, identity, fixed capability execution, and typed authoring modules", async () => {
  assert.deepEqual((await readdir(resolve("plugin/src/Forge"))).sort(), [
    "Constants.luau",
    "CreatorUiState.luau",
    "Hash.luau",
    "IdentityRegistry.luau",
    "ObservationRevision.luau",
    "Runtime.luau",
    "RuntimeCapabilityEncoding.luau",
    "RuntimeCapabilityExecutor.luau",
    "SnapshotCollector.luau",
    "StudioAuthoring.luau",
    "StudioInstancePolicy.luau",
  ]);
  const runtime = await readFile(
    resolve("plugin/src/Forge/RuntimeCapabilityExecutor.luau"),
    "utf8",
  );
  assert.doesNotMatch(
    runtime,
    /loadstring|PatchExecutor|TransactionManager|HarnessRegistry|StudioProofExecutor/,
  );
  assert.match(runtime, /capability == "instance\.resolve"/);
  assert.match(runtime, /capability == "base_part\.position"/);
  assert.match(runtime, /capability == "base_part\.position_series"/);
  assert.match(runtime, /ServerScriptService/);
  assert.match(runtime, /Workspace BasePart resolution/);
  const authoring = await readFile(
    resolve("plugin/src/Forge/StudioAuthoring.luau"),
    "utf8",
  );
  assert.doesNotMatch(
    authoring,
    /loadstring|\[operation\.property\]|operation\.callback/,
  );
  assert.match(authoring, /ALLOWED_CLASSES/);
  assert.match(authoring, /MATERIAL_ENUM_NAMES/);
  for (const material of STUDIO_MATERIALS)
    assert.match(authoring, new RegExp(`${material} = true`));
  assert.match(authoring, /Enum\.Material\[value\.value\]/);
  assert.match(authoring, /Transparency must be between 0 and 1/);
  assert.match(authoring, /Size components must be greater than 0/);
  assert.match(authoring, /MAX_SOURCE_UTF8_BYTES/);
  assert.match(authoring, /validUtf8/);
  assert.match(
    authoring,
    /preflightProperties\(operation\.className, operation\.properties\)/,
  );
  assert.match(
    authoring,
    /validateRemovedAttributes\(operation\.removedAttributes, operation\.attributes\)/,
  );
  const connector = await readFile(
    resolve("plugin/src/Forge/Runtime.luau"),
    "utf8",
  );
  assert.doesNotMatch(
    connector,
    /primaryButton\.Text = ui\.primary and ui\.primary\.label or "Waiting…"/,
  );
  assert.match(connector, /Submit New Request/);
  assert.match(
    connector,
    /currentView = if ui\.primary ~= nil or ui\.secondary ~= nil then view else nil/,
  );
  assert.match(
    connector,
    /local presentation = if view\.artifact ~= nil then view\.artifact\.presentation else view\.evidence/,
  );
  assert.match(connector, /artifactBox\.Visible = presentation ~= nil/);
  assert.match(connector, /primaryButton\.Visible = true/);
  assert.match(connector, /runButton\.Visible = false/);
  assert.match(
    connector,
    /requireFreshRevision\(message\.payload\.expectedRevision, "creator change preparation"\)/,
  );
  assert.match(
    connector,
    /requireFreshRevision\(message\.payload\.expectedRevision, "creator change application"\)/,
  );
  assert.match(authoring, /prepared\.beforeRevision ~= currentRevision/);
  assert.match(
    authoring,
    /operation\.kind == "move"[\s\S]*preflightProperties\(operation\.expectedClass, operation\.properties\)/,
  );
  assert.match(
    authoring,
    /operation\.kind == "write_source"[\s\S]*validateRemovedAttributes\(operation\.removedAttributes, operation\.attributes\)/,
  );
  const collector = await readFile(
    resolve("plugin/src/Forge/SnapshotCollector.luau"),
    "utf8",
  );
  const registry = await readFile(
    resolve("plugin/src/Forge/IdentityRegistry.luau"),
    "utf8",
  );
  const instancePolicy = await readFile(
    resolve("plugin/src/Forge/StudioInstancePolicy.luau"),
    "utf8",
  );
  assert.match(collector, /StudioInstancePolicy\.rootNames/);
  assert.match(collector, /StudioInstancePolicy\.shouldHaveStableIdentity/);
  assert.match(registry, /StudioInstancePolicy\.rootNames/);
  assert.match(registry, /StudioInstancePolicy\.shouldHaveStableIdentity/);
  assert.doesNotMatch(registry, /local function eligible/);
  assert.doesNotMatch(registry, /game:GetDescendants/);
  for (const parentClass of [
    "LayerCollector",
    "Tool",
    "StarterPlayerScripts",
    "StarterCharacterScripts",
    "Team",
  ])
    assert.match(instancePolicy, new RegExp(parentClass));
});
