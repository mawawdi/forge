import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { StudioBridgeServer, createBackendMessage } from "../packages/studio-bridge/src/index.js";
import { STUDIO_CAPABILITY_SET, createStudioExecutionPlan, serializeStudioExecutionPlan } from "../packages/studio-capabilities/src/index.js";
import { STUDIO_PLUGIN_VERSION, STUDIO_PROTOCOL_VERSION, assertBackendToPluginMessage, assertPluginToBackendMessage, type PluginToBackendMessage, type StudioCapability } from "../packages/studio-protocol/src/index.js";

const time = "2026-08-31T00:00:00.000Z";
const identity = { name: "RuntimeFixture", placeId: 0, universeId: 0 };
const capabilities: StudioCapability[] = ["snapshot", "snapshot_chunks", "sha256", "stable_identity", "studio_play_mode", "http_polling", "bounded_diagnostics", "runtime_eval_v1"];
const base = { kind: "StudioProtocolMessage" as const, schemaVersion: STUDIO_PROTOCOL_VERSION, direction: "plugin_to_backend" as const, sentAt: time };

test("protocol v12 accepts only the canonical generic capability surface", () => {
  const pair: PluginToBackendMessage = { ...base, type: "PairProject", messageId: "pair", payload: { pairingToken: "pairing-token", project: identity, pluginVersion: STUDIO_PLUGIN_VERSION, studioVersion: "studio", protocolVersion: STUDIO_PROTOCOL_VERSION, capabilities } };
  assertPluginToBackendMessage(pair);
  assert.throws(() => assertPluginToBackendMessage({ ...pair, schemaVersion: 11 }), /envelope/);
  assert.throws(() => assertPluginToBackendMessage({ ...pair, payload: { ...pair.payload, capabilities: [...capabilities, "typed_patch"] } }), /PairProject/);
  assert.throws(() => assertPluginToBackendMessage({ ...base, type: "PatchApplied", messageId: "old", payload: {} }), /message type/);
});

test("runtime execution accepts one canonical JSON string and keeps hostile text as data", () => {
  const hash = createHash("sha256").update("snapshot").digest("hex");
  const plan = createStudioExecutionPlan({ purpose: "capability_canary", capabilitySetId: STUDIO_CAPABILITY_SET.id, capabilitySetHash: STUDIO_CAPABILITY_SET.hash, binding: { runId: "run", correlationId: "correlation", sessionId: "session", projectId: "project", project: identity, projectSnapshotHash: hash }, targets: [{ id: "target", path: "Workspace/Door\"; error(\"injected\") --", expectedClass: "BasePart" }], calls: [{ id: "call", capability: "instance.resolve", version: 1, targetId: "target" }], budget: { maxExecutionMs: 1000, maxResultBytes: 4096 } });
  const json = serializeStudioExecutionPlan(plan);
  assert.match(json, /error/);
  const message = createBackendMessage("ExecuteRuntimeEvalPlan", { requestId: "request", expectedRevision: hash, executionPlanJson: json, executionPlanJsonHash: createHash("sha256").update(json).digest("hex") }, "session", "request", () => new Date(time));
  assertBackendToPluginMessage(message);
  assert.throws(() => assertBackendToPluginMessage({ ...message, payload: { ...message.payload, executionPlanJson: `${json} `, executionPlanJsonHash: createHash("sha256").update(`${json} `).digest("hex") } }), /canonical plan JSON string/);
  assert.throws(() => assertBackendToPluginMessage({ ...message, payload: { ...message.payload, executionPlanJsonHash: "0".repeat(64) } }), /ExecuteRuntimeEvalPlan/);
});

test("bridge pairs one plugin session and enforces control authentication", async () => {
  const bridge = new StudioBridgeServer({ port: 0, controlToken: "control_token_12345678901234567890" });
  const address = await bridge.listen();
  const url = `http://${address.host}:${address.port}`;
  try {
    const grant = await fetch(`${url}/v1/pairing`).then((response) => response.json()) as { pairing: { token: string } };
    const pair: PluginToBackendMessage = { ...base, type: "PairProject", messageId: "pair-live", payload: { pairingToken: grant.pairing.token, project: identity, pluginVersion: STUDIO_PLUGIN_VERSION, studioVersion: "studio", protocolVersion: STUDIO_PROTOCOL_VERSION, capabilities } };
    const paired = await fetch(`${url}/v1/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pair) });
    assert.equal(paired.status, 200);
    const session = await paired.json() as { sessionId: string; sessionToken: string };
    assert.equal(bridge.getSessions().length, 1);
    assert.equal((await fetch(`${url}/v1/sessions`)).status, 401);
    assert.equal((await fetch(`${url}/v1/sessions`, { headers: { "x-forge-control-token": address.controlToken } })).status, 200);
    const heartbeat: PluginToBackendMessage = { ...base, type: "Heartbeat", messageId: "heartbeat", sessionId: session.sessionId, payload: { pluginVersion: STUDIO_PLUGIN_VERSION, studioVersion: "studio", project: identity } };
    assert.equal((await fetch(`${url}/v1/message`, { method: "POST", headers: { "content-type": "application/json", "x-forge-session-token": session.sessionToken }, body: JSON.stringify(heartbeat) })).status, 202);
  } finally { await bridge.close(); }
});

test("snapshot chunks require bounded indices and SHA-256 payload integrity", () => {
  const payload = "{\"kind\":\"StudioSnapshotObservation\"}";
  const chunk: PluginToBackendMessage = { ...base, type: "SnapshotChunk", messageId: "chunk", sessionId: "session", payload: { project: identity, revision: { kind: "StudioRevision", schemaVersion: 1, observationHash: "a".repeat(64), identityHash: "b".repeat(64), capturedAt: time }, reason: "pre_play", snapshotId: "snapshot", index: 0, total: 1, encoding: "json", payload, payloadHash: createHash("sha256").update(payload).digest("hex") } };
  assertPluginToBackendMessage(chunk);
  assert.throws(() => assertPluginToBackendMessage({ ...chunk, payload: { ...chunk.payload, payloadHash: "0".repeat(64) } }), /SnapshotChunk/);
  assert.throws(() => assertPluginToBackendMessage({ ...chunk, payload: { ...chunk.payload, index: 1 } }), /SnapshotChunk/);
});

test("plugin contains only observation, transport, identity, and fixed capability execution modules", async () => {
  assert.deepEqual((await readdir(resolve("plugin/src/Forge"))).sort(), [
    "Constants.luau", "Hash.luau", "IdentityRegistry.luau", "ObservationRevision.luau", "Runtime.luau",
    "RuntimeCapabilityEncoding.luau", "RuntimeCapabilityExecutor.luau", "SnapshotCollector.luau"
  ]);
  const runtime = await readFile(resolve("plugin/src/Forge/RuntimeCapabilityExecutor.luau"), "utf8");
  assert.doesNotMatch(runtime, /loadstring|PatchExecutor|TransactionManager|HarnessRegistry|StudioProofExecutor/);
  assert.match(runtime, /capability == "instance\.resolve"/);
  assert.match(runtime, /capability == "base_part\.position"/);
  assert.match(runtime, /capability == "base_part\.position_series"/);
});
