import { strict as assert } from "node:assert";
import { test } from "node:test";
import { StudioBridgeServer, createBackendMessage } from "../packages/studio-bridge/src/index.js";
import { assertBackendToPluginMessage, assertPluginToBackendMessage, type PluginToBackendMessage } from "../packages/studio-protocol/src/index.js";

test("Studio bridge pairs one plugin and delivers typed messages over polling", async () => {
  const bridge = new StudioBridgeServer({ port: 0, now: () => new Date("2026-08-29T00:00:00.000Z") });
  const received: PluginToBackendMessage[] = [];
  bridge.subscribe((message) => { received.push(message); });
  const started = await bridge.listen();
  try {
    const hello: PluginToBackendMessage = { kind: "StudioProtocolMessage", schemaVersion: 1, direction: "plugin_to_backend", type: "PluginHello", messageId: "msg_hello", sentAt: "2026-08-29T00:00:00.000Z", payload: { pluginVersion: "test-plugin", studioVersion: "test-studio", supportedProtocolVersions: [1], capabilities: ["snapshot", "http_polling"] } };
    const helloResponse = await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(hello) });
    assert.equal(helloResponse.status, 202);

    const pair: PluginToBackendMessage = { kind: "StudioProtocolMessage", schemaVersion: 1, direction: "plugin_to_backend", type: "PairProject", messageId: "msg_pair", sentAt: "2026-08-29T00:00:00.000Z", payload: { pairingToken: started.pairing.token, project: { name: "Fruit Islands", placeId: 123, universeId: 456 }, pluginVersion: "test-plugin", studioVersion: "test-studio" } };
    const pairResponse = await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pair) });
    assert.equal(pairResponse.status, 200);
    const pairing = await pairResponse.json() as { sessionId: string; sessionToken: string };
    assert.ok(pairing.sessionId.startsWith("studio_"));
    assert.ok(pairing.sessionToken.length > 10);
    assert.equal(received.length, 1);
    assertPluginToBackendMessage(received[0]);

    const poll = await fetch(`http://${started.host}:${started.port}/v1/poll?sessionId=${encodeURIComponent(pairing.sessionId)}&sessionToken=${encodeURIComponent(pairing.sessionToken)}`);
    assert.equal(poll.status, 200);
    const polled = await poll.json() as { messages: unknown[] };
    assert.equal(polled.messages.length, 1);
    assertBackendToPluginMessage(polled.messages[0]);
    assert.equal(polled.messages[0].type, "PairAccepted");

    const heartbeat: PluginToBackendMessage = { kind: "StudioProtocolMessage", schemaVersion: 1, direction: "plugin_to_backend", type: "Heartbeat", messageId: "msg_heartbeat", sentAt: "2026-08-29T00:00:00.000Z", sessionId: pairing.sessionId, payload: { pluginVersion: "test-plugin", studioVersion: "test-studio", project: { name: "Fruit Islands", placeId: 123, universeId: 456 } } };
    const missingToken = await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(heartbeat) });
    assert.equal(missingToken.status, 401);
    const authenticated = await fetch(`http://${started.host}:${started.port}/v1/message`, { method: "POST", headers: { "content-type": "application/json", "x-forge-session-token": pairing.sessionToken }, body: JSON.stringify(heartbeat) });
    assert.equal(authenticated.status, 202);

    await bridge.send(createBackendMessage("RequestSnapshot", { requestId: "request_snapshot", reason: "manual" }, pairing.sessionId));
    const nextPoll = await fetch(`http://${started.host}:${started.port}/v1/poll?sessionId=${encodeURIComponent(pairing.sessionId)}&sessionToken=${encodeURIComponent(pairing.sessionToken)}`);
    const next = await nextPoll.json() as { messages: unknown[] };
    assert.equal(next.messages.length, 1);
    assertBackendToPluginMessage(next.messages[0]);
    assert.equal(next.messages[0].type, "RequestSnapshot");
  } finally {
    await bridge.close();
  }
});

test("Studio protocol rejects a backend message sent in the plugin direction", () => {
  assert.throws(() => assertPluginToBackendMessage({ kind: "StudioProtocolMessage", schemaVersion: 1, direction: "plugin_to_backend", type: "RequestSnapshot", messageId: "msg_invalid", sentAt: "2026-08-29T00:00:00.000Z", payload: {} }), /Invalid plugin message type/);
  assert.throws(() => assertBackendToPluginMessage({ kind: "StudioProtocolMessage", schemaVersion: 1, direction: "backend_to_plugin", type: "PairAccepted", messageId: "msg_invalid_pair", sentAt: "2026-08-29T00:00:00.000Z", payload: { sessionId: "studio_1", projectId: "project_1", expiresAt: "2026-08-29T00:10:00.000Z" } }), /Invalid PairAccepted payload/);
  assert.throws(() => assertPluginToBackendMessage({ kind: "StudioProtocolMessage", schemaVersion: 1, direction: "plugin_to_backend", type: "ProjectSnapshot", messageId: "msg_invalid_snapshot", sentAt: "2026-08-29T00:00:00.000Z", payload: { project: { name: "x", placeId: 1, universeId: 2 }, observation: {} } }), /Invalid ProjectSnapshot payload/);
});
