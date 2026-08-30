import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { StudioBridgeClient, StudioBridgeServer, createBackendMessage, readStudioBridgeDiscovery, removeStudioBridgeDiscovery, writeStudioBridgeDiscovery } from "../packages/studio-bridge/src/index.js";
import { assertBackendToPluginMessage, assertPluginToBackendMessage, COLLECT_FRUIT_HARNESS_HASH, COLLECT_FRUIT_HARNESS_VERSION, STUDIO_PLUGIN_VERSION, type PluginToBackendMessage } from "../packages/studio-protocol/src/index.js";

const time = "2026-08-29T00:00:00.000Z";
const identity = { name: "Fruit Islands", placeId: 123, universeId: 456 };
const base = { kind: "StudioProtocolMessage" as const, schemaVersion: 10 as const, direction: "plugin_to_backend" as const, messageId: "msg_protocol", sentAt: time };
const binding = { projectId: "project_1", sessionId: "session_1", project: identity, runId: "run_1", testPlanId: "plan_1", correlationId: "correlation_1", projectSnapshotHash: "snapshot_1", mechanicContractHash: "contract_1", nonceCommitment: "a".repeat(64) };

test("Studio bridge v10 auto-pairs, authenticates control, and delivers messages", async () => {
  const bridge = new StudioBridgeServer({ port: 0, now: () => new Date(time) }); const received: PluginToBackendMessage[] = []; bridge.subscribe((message) => { received.push(message); }); const started = await bridge.listen();
  try {
    const autoPairing = await (await fetch(`http://${started.host}:${started.port}/v1/pairing`)).json() as { pairing: { token: string } };
    const pair: Extract<PluginToBackendMessage, { type: "PairProject" }> = { ...base, messageId: "msg_pair", type: "PairProject", payload: { pairingToken: autoPairing.pairing.token, project: identity, pluginVersion: STUDIO_PLUGIN_VERSION, studioVersion: "test-studio", protocolVersion: 10, capabilities: ["snapshot", "snapshot_chunks", "sha256", "stable_identity", "typed_patch", "transaction", "studio_play_mode", "http_polling", "bounded_diagnostics"] } };
    const response = await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pair) }); assert.equal(response.status, 200); const session = await response.json() as { sessionId: string; sessionToken: string };
    assert.equal((await fetch(`http://${started.host}:${started.port}/v1/sessions`)).status, 401);
    const client = new StudioBridgeClient({ host: started.host, port: started.port, controlToken: started.controlToken }); const attached = await client.waitForSession(1_000); assert.equal(attached.sessionId, session.sessionId);
    const heartbeat: PluginToBackendMessage = { ...base, messageId: "msg_heartbeat", type: "Heartbeat", sessionId: session.sessionId, payload: { pluginVersion: "test-plugin", studioVersion: "test-studio", project: identity } }; const headers = { "content-type": "application/json", "x-forge-session-token": session.sessionToken };
    assert.equal((await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers, body: JSON.stringify(heartbeat) })).status, 202);
    const observationRequest = createBackendMessage("RequestObservation", { requestId: "request_snapshot", reason: "manual" }, session.sessionId);
    await client.send(observationRequest); await client.send(observationRequest);
    const poll = await fetch(`http://${started.host}:${started.port}/v1/poll?sessionId=${session.sessionId}`, { headers: { "x-forge-session-token": session.sessionToken } }); const body = await poll.json() as { messages: unknown[] }; assert.equal(body.messages.filter((message) => (message as { type?: string }).type === "RequestObservation").length, 1);
    const unpair: PluginToBackendMessage = { ...base, messageId: "msg_unpair", type: "UnpairProject", sessionId: session.sessionId, payload: { reason: "user" } };
    const unpaired = await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers, body: JSON.stringify(unpair) });
    assert.equal(unpaired.status, 202);
    await unpaired.json();
    const sessionsAfterUnpair = await fetch(`http://${started.host}:${started.port}/v1/sessions`, { headers: { "x-forge-control-token": started.controlToken } });
    assert.equal(((await sessionsAfterUnpair.json()) as { sessions: unknown[] }).sessions.length, 0);
    const nextAutoPairing = await (await fetch(`http://${started.host}:${started.port}/v1/pairing`)).json() as { pairing: { token: string } };
    const rePair: PluginToBackendMessage = { ...pair, messageId: "msg_repair", payload: { ...pair.payload, pairingToken: nextAutoPairing.pairing.token } };
    assert.equal((await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rePair) })).status, 200);
    await client.close();
  } finally { await bridge.close(); }
});

test("concurrent local Studio windows receive independent grants and identities", async () => {
  const bridge = new StudioBridgeServer({ port: 0, now: () => new Date(time) });
  const started = await bridge.listen();
  const localA = { name: "ForgeCollectFruit-safe.rbxlx", placeId: 0, universeId: 0 };
  const localB = { name: "ForgeCollectFruit-fault.rbxlx", placeId: 0, universeId: 0 };
  const capabilities = ["snapshot", "snapshot_chunks", "sha256", "stable_identity", "typed_patch", "transaction", "studio_play_mode", "http_polling", "bounded_diagnostics"] as const;
  const postPair = (token: string, project: typeof localA, messageId: string) => fetch(`http://${started.host}:${started.port}/v1/message`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, messageId, type: "PairProject", payload: { pairingToken: token, project, pluginVersion: STUDIO_PLUGIN_VERSION, studioVersion: "test-studio", protocolVersion: 10, capabilities } })
  });
  try {
    const [grantA, grantB] = await Promise.all([
      fetch(`http://${started.host}:${started.port}/v1/pairing`).then((response) => response.json()) as Promise<{ pairing: { token: string } }>,
      fetch(`http://${started.host}:${started.port}/v1/pairing`).then((response) => response.json()) as Promise<{ pairing: { token: string } }>,
    ]);
    assert.notEqual(grantA.pairing.token, grantB.pairing.token);
    const [responseA, responseB] = await Promise.all([postPair(grantA.pairing.token, localA, "pair_local_a"), postPair(grantB.pairing.token, localB, "pair_local_b")]);
    assert.equal(responseA.status, 200);
    assert.equal(responseB.status, 200);
    const sessionA = await responseA.json() as { projectId: string };
    const sessionB = await responseB.json() as { projectId: string };
    assert.notEqual(sessionA.projectId, sessionB.projectId);
    assert.equal((await postPair(grantA.pairing.token, localA, "reused_grant")).status, 401);

    const sessionsResponse = await fetch(`http://${started.host}:${started.port}/v1/sessions`, { headers: { "x-forge-control-token": started.controlToken } });
    assert.equal(((await sessionsResponse.json()) as { sessions: unknown[] }).sessions.length, 2);
    const client = new StudioBridgeClient({ host: started.host, port: started.port, controlToken: started.controlToken });
    await assert.rejects(() => client.waitForSession(1_000), /Multiple Studio projects are connected/);
    await client.close();
  } finally {
    await bridge.close();
  }
});

test("a verifier attaches at the live event cursor and requests fresh state", async () => {
  const bridge = new StudioBridgeServer({ port: 0, now: () => new Date(time) });
  const started = await bridge.listen();
  try {
    const grant = await fetch(`http://${started.host}:${started.port}/v1/pairing`).then((response) => response.json()) as { pairing: { token: string } };
    const pair: PluginToBackendMessage = { ...base, messageId: "pair_cursor", type: "PairProject", payload: { pairingToken: grant.pairing.token, project: identity, pluginVersion: STUDIO_PLUGIN_VERSION, studioVersion: "test-studio", protocolVersion: 10, capabilities: ["snapshot", "snapshot_chunks", "sha256", "stable_identity", "typed_patch", "transaction", "studio_play_mode", "http_polling", "bounded_diagnostics"] } };
    const pairResponse = await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pair) });
    const session = await pairResponse.json() as { sessionId: string; sessionToken: string };
    const headers = { "content-type": "application/json", "x-forge-session-token": session.sessionToken };
    const heartbeat = (messageId: string): PluginToBackendMessage => ({ ...base, messageId, type: "Heartbeat", sessionId: session.sessionId, payload: { pluginVersion: STUDIO_PLUGIN_VERSION, studioVersion: "test-studio", project: identity } });
    assert.equal((await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers, body: JSON.stringify(heartbeat("heartbeat_stale")) })).status, 202);

    const client = new StudioBridgeClient({ host: started.host, port: started.port, controlToken: started.controlToken });
    await client.waitForSession(1_000);
    const received: PluginToBackendMessage[] = [];
    const unsubscribe = client.subscribeWithSession((message) => { received.push(message); });
    assert.equal((await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers, body: JSON.stringify(heartbeat("heartbeat_fresh")) })).status, 202);
    const deadline = Date.now() + 1_000;
    while (!received.some((message) => message.messageId === "heartbeat_fresh") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(received.map((message) => message.messageId), ["heartbeat_fresh"]);
    unsubscribe();
    await client.close();
  } finally {
    await bridge.close();
  }
});

test("v10 rejects old, malformed, raw Output, and invalid lifecycle envelopes", () => {
  assert.throws(() => assertPluginToBackendMessage({ ...base, schemaVersion: 6, type: "PairProject", payload: {} }), /envelope/);
  assert.throws(() => assertPluginToBackendMessage({ ...base, type: "PairProject", payload: { pairingToken: "token", project: identity, pluginVersion: "forge-studio-plugin-2.1.0", studioVersion: "studio", protocolVersion: 8, capabilities: ["snapshot", "snapshot_chunks", "sha256", "stable_identity", "typed_patch", "transaction", "studio_play_mode", "http_polling", "bounded_diagnostics"] } }), /PairProject/);
  assert.throws(() => assertPluginToBackendMessage({ ...base, type: "RequestObservation", payload: {} }), /Invalid plugin message type/);
  assert.throws(() => assertBackendToPluginMessage({ ...base, direction: "backend_to_plugin", type: "PairAccepted", payload: { sessionId: "s", projectId: "p", expiresAt: time } }), /Unsupported/);
  const evidence = { kind: "StudioHarnessEvidence", schemaVersion: 1, ...binding, nonce: "nonce_1234567890", id: "result_1", assertionId: "assert_1", status: "pass", expected: true, observed: true, evidence: [{ type: "state", statement: "ok" }], authoritative: true, durationMs: 1, emittedAt: time };
  assertPluginToBackendMessage({ ...base, type: "StudioTestResult", payload: { kind: "StudioHarnessRunEnvelope", schemaVersion: 1, ...binding, nonce: "nonce_1234567890", harnessId: "collect-fruit", harnessVersion: COLLECT_FRUIT_HARNESS_VERSION, harnessHash: COLLECT_FRUIT_HARNESS_HASH, status: "completed", authoritative: true, startedAt: time, endedAt: time, durationMs: 1, assertions: [evidence], diagnostics: [] } });
  assert.throws(() => assertPluginToBackendMessage({ ...base, type: "StudioTestResult", payload: { kind: "StudioHarnessRunEnvelope", schemaVersion: 1, ...binding, nonce: "nonce_1234567890", harnessId: "collect-fruit", harnessVersion: COLLECT_FRUIT_HARNESS_VERSION, harnessHash: COLLECT_FRUIT_HARNESS_HASH, status: "completed", authoritative: true, startedAt: time, endedAt: time, durationMs: 1, assertions: [{ ...evidence, observed: {} }], diagnostics: [] } }), /assertions\[0\] observed must be a primitive/);
  assert.throws(() => assertPluginToBackendMessage({ ...base, type: "StudioTestResult", payload: { kind: "StudioHarnessRunEnvelope", schemaVersion: 1, ...binding, nonce: "nonce_1234567890", harnessId: "collect-fruit", harnessVersion: COLLECT_FRUIT_HARNESS_VERSION, harnessHash: COLLECT_FRUIT_HARNESS_HASH, status: "completed", authoritative: true, startedAt: time, endedAt: time, durationMs: 1, assertions: [{ ...evidence, evidence: [{ type: "state", statement: "empty data", data: [] }] }], diagnostics: [] } }), /assertions\[0\] evidence must contain bounded assertion evidence/);
  assert.throws(() => assertPluginToBackendMessage({ ...base, type: "StudioOutput", payload: { stream: "output", text: "CF-001 PASS", occurredAt: time } }), /Unsupported/);
  assert.throws(() => assertPluginToBackendMessage({ ...base, type: "PlaytestStarted", payload: { ...binding, mode: "multiplayer", playerCount: 1, control: "studio_test_service" } }), /PlaytestStarted/);
  assertPluginToBackendMessage({ ...base, type: "PlaytestStarted", payload: { ...binding, mode: "play_solo", playerCount: 1, control: "plugin_action" } });
  assertPluginToBackendMessage({ ...base, type: "TransactionRolledBack", payload: { transactionId: "tx_1", projectSnapshotHash: "revision_1", status: "rolled_back", success: true, rollback: "change_history_cancelled_and_inverse_applied" } });
  assert.throws(() => assertPluginToBackendMessage({ ...base, type: "TransactionRolledBack", payload: { transactionId: "tx_1", projectSnapshotHash: "revision_1", status: "rolled_back" } }), /TransactionRolledBack/);
  const source = "return true";
  const studioObservation = { kind: "StudioSnapshotObservation", schemaVersion: 3, project: identity, capturedAt: time, instances: [{ stableId: "forge_script", path: "ServerScriptService/Test", className: "Script", properties: [], attributes: [], tags: [] }], scripts: [{ stableId: "forge_script", path: "ServerScriptService/Test", executionContext: "server", sourceHash: createHash("sha256").update(source).digest("hex"), source }], remotes: [] };
  const revision = { kind: "StudioRevision", schemaVersion: 1, observationHash: "b".repeat(64), identityHash: "c".repeat(64), capturedAt: time };
  assertPluginToBackendMessage({ ...base, type: "ProjectObservation", payload: { project: identity, revision, reason: "pairing", observation: studioObservation } });
  assert.throws(() => assertPluginToBackendMessage({ ...base, type: "ProjectObservation", payload: { project: identity, revision, reason: "pairing", observation: { ...studioObservation, instances: [{ ...studioObservation.instances[0], properties: {} }] } } }), /instance/);
});

test("v10 reconstructs SHA-256 checked snapshot chunks before dispatch", async () => {
  const bridge = new StudioBridgeServer({ port: 0, now: () => new Date(time) }); const started = await bridge.listen();
  try {
    const autoPairing = await (await fetch(`http://${started.host}:${started.port}/v1/pairing`)).json() as { pairing: { token: string } };
    const pair: PluginToBackendMessage = { ...base, messageId: "msg_chunk_pair", type: "PairProject", payload: { pairingToken: autoPairing.pairing.token, project: identity, pluginVersion: STUDIO_PLUGIN_VERSION, studioVersion: "test-studio", protocolVersion: 10, capabilities: ["snapshot", "snapshot_chunks", "sha256", "stable_identity", "typed_patch", "transaction", "studio_play_mode", "http_polling", "bounded_diagnostics"] } };
    const paired = await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pair) }); const session = await paired.json() as { sessionId: string; sessionToken: string };
    const client = new StudioBridgeClient({ host: started.host, port: started.port, controlToken: started.controlToken }); const received: PluginToBackendMessage[] = []; const unsubscribe = client.subscribeWithSession((message) => { received.push(message); });
    const observation = JSON.stringify({ kind: "StudioSnapshotObservation", schemaVersion: 3, project: identity, capturedAt: time, instances: [], scripts: [], remotes: [] }); const midpoint = Math.ceil(observation.length / 2); const revision = { kind: "StudioRevision" as const, schemaVersion: 1 as const, observationHash: "b".repeat(64), identityHash: "c".repeat(64), capturedAt: time };
    for (const [index, payload] of [observation.slice(0, midpoint), observation.slice(midpoint)].entries()) {
      const chunk: PluginToBackendMessage = { ...base, messageId: `chunk_${index}`, type: "SnapshotChunk", sessionId: session.sessionId, payload: { project: identity, revision, reason: "manual", snapshotId: "snapshot_chunks", index, total: 2, encoding: "json", payload, payloadHash: createHash("sha256").update(payload).digest("hex") } };
      const response = await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers: { "content-type": "application/json", "x-forge-session-token": session.sessionToken }, body: JSON.stringify(chunk) }); assert.equal(response.status, 202);
    }
    const deadline = Date.now() + 1_000; while (!received.some((message) => message.type === "ProjectObservation") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(received.filter((message) => message.type === "ProjectObservation").length, 1); unsubscribe(); await client.close();
  } finally { await bridge.close(); }
});

test("bridge discovery is private, validated, and removed only by its owner", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "forge-studio-discovery-"));
  const filePath = resolve(directory, "studio-bridge.json");
  const discovery = { kind: "ForgeStudioBridgeDiscovery" as const, schemaVersion: 1 as const, bridgeId: "bridge_test_owner", host: "127.0.0.1" as const, port: 8787, controlToken: "control_token_12345678901234567890", pid: process.pid, startedAt: time };
  try {
    await writeStudioBridgeDiscovery(discovery, filePath);
    assert.deepEqual(await readStudioBridgeDiscovery(filePath), discovery);
    if (process.platform !== "win32") assert.equal((await stat(filePath)).mode & 0o077, 0);
    await removeStudioBridgeDiscovery("bridge_different_owner", filePath);
    assert.deepEqual(await readStudioBridgeDiscovery(filePath), discovery);
    await removeStudioBridgeDiscovery(discovery.bridgeId, filePath);
    await assert.rejects(() => readStudioBridgeDiscovery(filePath), /not running/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
