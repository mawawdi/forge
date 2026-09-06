import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CreatorControlServer,
  CreatorTurnNotAdmittedError,
  readCreatorControlDiscovery,
  writeCreatorControlDiscovery,
  type CreatorControlCoordinator,
} from "../packages/creator-control/src/index.js";
import type { CreatorTurnRequest } from "../packages/creator-conversation/src/index.js";

function fakeCoordinator(
  overrides: Partial<CreatorControlCoordinator> = {},
): CreatorControlCoordinator {
  return {
    subscribe: () => () => undefined,
    async dashboardState() {
      return {
        kind: "CreatorDashboardState",
        conversations: [],
        episodes: [],
        memories: [],
        modelRegistry: {
          kind: "CreatorModelRegistry",
          id: "creator_model_registry_test",
          hash: "c".repeat(64),
          generatedAt: "2026-09-03T00:00:00.000Z",
          defaultModelId: "openai/gpt-5.6-luna",
          models: [
            {
              id: "openai/gpt-5.6-luna",
              displayName: "Luna",
              availability: "available",
              imageInput: "supported",
              requiredCapabilities: ["tools"],
              providerFallback: "disabled",
            },
          ],
        },
        pairedStudio: {
          status: "ready",
          message: "Studio is paired.",
          transactionStatus: "clear",
        },
        serverTime: "2026-09-03T00:00:00.000Z",
      };
    },
    async conversationEvents(conversationId) {
      return { conversationId, events: [], complete: true };
    },
    async submitTurn() {
      return {
        kind: "CreatorWorkAdmission",
        jobId: "creator_job_turn",
        conversationId: "creator_conversation_test",
        acceptedAt: "2026-09-03T00:00:00.000Z",
      };
    },
    async submitAction() {
      return {
        kind: "CreatorWorkAdmission",
        jobId: "creator_job_action",
        conversationId: "creator_conversation_test",
        acceptedAt: "2026-09-03T00:00:00.000Z",
      };
    },
    async renameWorkspace() {
      return { name: "Renamed project" };
    },
    async readAuthorizedArtifact(hash) {
      if (hash !== "a".repeat(64)) throw new Error("unauthorized");
      return { safe: true };
    },
    async replayVerification(id) {
      return { kind: "CreatorVerificationReplay", verificationId: id };
    },
    async replayMutation(id) {
      return { kind: "CreatorMutationReplay", attemptId: id };
    },
    async sourceDocuments() {
      return { documents: [] };
    },
    async sourceSearch() {
      return { matches: [] };
    },
    async sourceRead() {
      return { text: "" };
    },
    async sourceSymbols() {
      return { symbols: [] };
    },
    async sourceReferences() {
      return { references: [] };
    },
    async sourceDependencies() {
      return { nodes: [] };
    },
    async sourceDiff() {
      return { text: "" };
    },
    ...overrides,
  } as CreatorControlCoordinator;
}

test("HTTP distinguishes ledger-proven turn rejection from generic transport and persistence errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forge-turn-proof-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request: CreatorTurnRequest = {
    kind: "CreatorTurnRequest",
    conversationId: "conversation-proof",
    text: "Review the image.",
    selectedModelId: "openai/gpt-5.6-luna",
    turnContractId: "stale-contract",
    turnContractHash: "a".repeat(64),
    turnKind: "new_work",
    idempotencyKey: "saved-proof-request-key",
  };
  const proof = new CreatorTurnNotAdmittedError(request, "This turn was not admitted.");
  let failure: Error = proof;
  const server = new CreatorControlServer({
    coordinator: fakeCoordinator({
      async submitTurn() {
        throw failure;
      },
    }),
    dashboardDirectory: root,
    port: 0,
    bearerToken: "bearer_token_123456789012345678901234",
  });
  const address = await server.listen();
  t.after(() => server.close());
  const endpoint = `http://${address.host}:${address.port}/api/control/turn`;
  const options = {
    method: "POST",
    headers: { authorization: `Bearer ${address.bearerToken}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  };
  const rejected = await fetch(endpoint, options);
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), {
    kind: "CreatorControlError",
    message: proof.message,
    admission: "not_admitted",
    idempotencyKey: request.idempotencyKey,
    requestHash: proof.requestHash,
  });
  failure = new Error("The persistence acknowledgement is uncertain.");
  const uncertain = await fetch(endpoint, options);
  assert.deepEqual(await uncertain.json(), {
    kind: "CreatorControlError",
    message: failure.message,
  });
  const unauthenticated = await fetch(endpoint, { method: "POST", body: options.body });
  assert.equal(unauthenticated.status, 401);
  assert.equal(((await unauthenticated.json()) as { admission?: string }).admission, undefined);
});

test("creator control authenticates conversation reads and admits turns/actions with 202", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-creator-control-"));
  const dashboard = join(root, "dashboard");
  await mkdir(dashboard);
  await writeFile(join(dashboard, "index.html"), "<!doctype html><title>Forge</title>");
  const listeners = new Set<() => void>();
  const sourceRequests: unknown[] = [];
  const coordinator = fakeCoordinator({
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async sourceDocuments(anchor, input) {
      sourceRequests.push({ anchor, input });
      return { documents: [] };
    },
  });
  const server = new CreatorControlServer({
    coordinator,
    dashboardDirectory: dashboard,
    port: 0,
    bearerToken: "bearer_token_123456789012345678901234",
  });
  try {
    const address = await server.listen();
    const origin = `http://${address.host}:${address.port}`;
    const launch = server.createLaunchUrl(address.port);
    const exchange = await fetch(launch, { redirect: "manual" });
    assert.equal(exchange.status, 303);
    assert.equal(exchange.headers.get("location"), "/");
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("forge_creator_session="));
    assert.match(exchange.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(
      exchange.headers.get("content-security-policy") ?? "",
      /img-src 'self' data: blob:;/,
    );
    assert.match(exchange.headers.get("content-security-policy") ?? "", /script-src 'self';/);
    assert.match(exchange.headers.get("content-security-policy") ?? "", /connect-src 'self';/);
    assert.equal((await fetch(launch, { redirect: "manual" })).status, 401);

    const state = await fetch(`${origin}/api/control/state`, { headers: { cookie: cookie! } });
    assert.equal(state.status, 200);
    assert.equal(((await state.json()) as { kind: string }).kind, "CreatorDashboardState");
    assert.equal(state.headers.get("access-control-allow-origin"), null);

    const events = await fetch(
      `${origin}/api/conversations/creator_conversation_test/events?limit=20`,
      { headers: { authorization: `Bearer ${address.bearerToken}` } },
    );
    assert.equal(events.status, 200);
    assert.equal(
      ((await events.json()) as { conversationId: string }).conversationId,
      "creator_conversation_test",
    );

    const unanchoredSource = await fetch(
      `${origin}/api/sources/documents?conversationId=creator_conversation_test`,
      { headers: { authorization: `Bearer ${address.bearerToken}` } },
    );
    assert.equal(unanchoredSource.status, 400);
    const eventHash = "b".repeat(64);
    const sourceIndexHash = "c".repeat(64);
    const anchoredSource = await fetch(
      `${origin}/api/sources/documents?conversationId=creator_conversation_test&eventId=creator_event_historical&eventHash=${eventHash}&sourceIndexHash=${sourceIndexHash}&limit=20`,
      { headers: { authorization: `Bearer ${address.bearerToken}` } },
    );
    assert.equal(anchoredSource.status, 200);
    assert.deepEqual(sourceRequests, [
      {
        anchor: {
          conversationId: "creator_conversation_test",
          eventId: "creator_event_historical",
          eventHash,
          sourceIndexHash,
        },
        input: { limit: 20 },
      },
    ]);

    const wrongOrigin = await fetch(`${origin}/api/control/turn`, {
      method: "POST",
      headers: {
        cookie: cookie!,
        origin: "http://evil.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "CreatorTurnRequest" }),
    });
    assert.equal(wrongOrigin.status, 403);

    const turn = await fetch(`${origin}/api/control/turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${address.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "CreatorTurnRequest" }),
    });
    assert.equal(turn.status, 202);
    assert.equal(((await turn.json()) as { jobId: string }).jobId, "creator_job_turn");

    const action = await fetch(`${origin}/api/control/action`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${address.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "CreatorActionRequest" }),
    });
    assert.equal(action.status, 202);
    assert.equal(((await action.json()) as { jobId: string }).jobId, "creator_job_action");

    const oversized = await fetch(`${origin}/api/control/turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${address.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "x".repeat(12 * 1024 * 1024) }),
    });
    assert.equal(oversized.status, 413);

    const catalog = await fetch(`${origin}/api/control/catalog`, {
      headers: { authorization: `Bearer ${address.bearerToken}` },
    });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.headers.get("cache-control"), "no-store");
    const capabilities = await fetch(`${origin}/api/control/capabilities?class=Part&limit=1`, {
      headers: { authorization: `Bearer ${address.bearerToken}` },
    });
    assert.equal(capabilities.status, 200);

    for (let index = 0; index < 257; index += 1) for (const listener of listeners) listener();
    const eventStream = await fetch(`${origin}/api/control/events?after=0`, {
      headers: { authorization: `Bearer ${address.bearerToken}` },
    });
    const reader = eventStream.body?.getReader();
    assert.ok(reader);
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: reset/);
    for (const listener of listeners) listener();
    assert.match(new TextDecoder().decode((await reader.read()).value), /id: 258/);
    await reader.cancel();

    assert.deepEqual(
      await (
        await fetch(`${origin}/api/artifacts/${"a".repeat(64)}`, {
          headers: { authorization: `Bearer ${address.bearerToken}` },
        })
      ).json(),
      { safe: true },
    );

    const secret = join(root, "outside-dashboard.txt");
    await writeFile(secret, "must not be served", "utf8");
    await symlink(secret, join(dashboard, "leak.js"));
    const linkedAsset = await fetch(`${origin}/leak.js`, {
      headers: { authorization: `Bearer ${address.bearerToken}` },
    });
    assert.equal(linkedAsset.status, 404);
    assert.doesNotMatch(await linkedAsset.text(), /must not be served/);

    await mkdir(join(dashboard, "not-an-asset.js"));
    const irregularAsset = await fetch(`${origin}/not-an-asset.js`, {
      headers: { authorization: `Bearer ${address.bearerToken}` },
    });
    assert.equal(irregularAsset.status, 404);

    const clientRoute = await fetch(`${origin}/conversation`, {
      headers: { authorization: `Bearer ${address.bearerToken}` },
    });
    assert.equal(clientRoute.status, 200);
    assert.match(await clientRoute.text(), /Forge/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("creator control reserves wire framing for the largest advertised text field", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-creator-control-wire-"));
  const dashboard = join(root, "dashboard");
  await mkdir(dashboard);
  await writeFile(join(dashboard, "index.html"), "<!doctype html><title>Forge</title>");
  const maximumTextBytes = 64 * 1024;
  let submittedText: string | undefined;
  const coordinator = fakeCoordinator({
    async submitTurn(value) {
      const request = value as { readonly text?: unknown };
      if (
        typeof request.text !== "string" ||
        Buffer.byteLength(request.text, "utf8") > maximumTextBytes
      )
        throw new Error("Creator turn text is outside the exact control-view bounds");
      submittedText = request.text;
      return {
        kind: "CreatorWorkAdmission",
        jobId: "creator_job_largest_turn",
        conversationId: "creator_conversation_test",
        acceptedAt: "2026-09-03T00:00:00.000Z",
      };
    },
  });
  const server = new CreatorControlServer({
    coordinator,
    dashboardDirectory: dashboard,
    port: 0,
    bearerToken: "bearer_token_123456789012345678901234",
  });
  try {
    const address = await server.listen();
    const origin = `http://${address.host}:${address.port}`;
    const headers = {
      authorization: `Bearer ${address.bearerToken}`,
      "content-type": "application/json",
    };
    // NUL is the worst legal UTF-8 byte for JSON transport: JSON.stringify
    // expands every byte to a six-byte \u0000 escape.
    const exactText = "\0".repeat(maximumTextBytes);
    const exactRequest = {
      kind: "CreatorTurnRequest",
      turnContractId: "creator_turn_contract_test",
      turnContractHash: "a".repeat(64),
      turnKind: "new_work",
      text: exactText,
      selectedModelId: "openai/gpt-5.6-luna",
      idempotencyKey: "idempotency-key-for-largest-wire-test",
    };
    const exactBody = JSON.stringify(exactRequest);
    assert.ok(Buffer.byteLength(exactBody, "utf8") > maximumTextBytes);
    assert.ok(Buffer.byteLength(exactBody, "utf8") < 512 * 1024);
    const exact = await fetch(`${origin}/api/control/turn`, {
      method: "POST",
      headers,
      body: exactBody,
    });
    assert.equal(exact.status, 202);
    assert.equal(submittedText, exactText);

    const overContract = await fetch(`${origin}/api/control/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...exactRequest, text: `${exactText}\0` }),
    });
    // The HTTP boundary has accepted the complete body; the exact
    // control-view validator, rather than transport framing, rejects max + 1.
    assert.equal(overContract.status, 400);

    const overWire = await fetch(`${origin}/api/control/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "x".repeat(12 * 1024 * 1024) }),
    });
    assert.equal(overWire.status, 413);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("visual turn transport admits complete bodies through 12 MiB while actions retain their 512 KiB boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-visual-wire-"));
  const dashboard = join(root, "dashboard");
  await mkdir(dashboard);
  await writeFile(join(dashboard, "index.html"), "<!doctype html><title>Forge</title>");
  let turnBytes = 0;
  let turnCalls = 0;
  let actionCalls = 0;
  const coordinator = fakeCoordinator({
    async submitTurn(value) {
      turnCalls++;
      turnBytes = Buffer.byteLength(JSON.stringify(value));
      return {
        kind: "CreatorWorkAdmission",
        jobId: "creator_job_visual_wire",
        conversationId: "creator_conversation_test",
        acceptedAt: "2026-09-03T00:00:00.000Z",
      };
    },
    async submitAction() {
      actionCalls++;
      return {
        kind: "CreatorWorkAdmission",
        jobId: "creator_job_action_wire",
        conversationId: "creator_conversation_test",
        acceptedAt: "2026-09-03T00:00:00.000Z",
      };
    },
  });
  const server = new CreatorControlServer({
    coordinator,
    dashboardDirectory: dashboard,
    port: 0,
    bearerToken: "bearer_token_123456789012345678901234",
  });
  try {
    const address = await server.listen();
    const origin = `http://${address.host}:${address.port}`;
    const headers = {
      authorization: `Bearer ${address.bearerToken}`,
      "content-type": "application/json",
    };
    // This fixture isolates HTTP framing. The real coordinator's PNG/field checks have separate admission coverage.
    for (const size of [512 * 1024 + 1, 12 * 1024 * 1024]) {
      const body = JSON.stringify({
        text: "x".repeat(size - Buffer.byteLength(JSON.stringify({ text: "" }))),
      });
      assert.equal(Buffer.byteLength(body), size);
      const response = await fetch(`${origin}/api/control/turn`, { method: "POST", headers, body });
      assert.equal(response.status, 202);
      assert.equal(turnBytes, size);
    }
    const tooLarge = await fetch(`${origin}/api/control/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "x".repeat(12 * 1024 * 1024) }),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(turnCalls, 2);
    const action = await fetch(`${origin}/api/control/action`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "x".repeat(512 * 1024) }),
    });
    assert.equal(action.status, 413);
    assert.equal(actionCalls, 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("creator control discovery is private and validated", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-creator-discovery-"));
  const path = join(root, "creator-control.json");
  try {
    const discovery = {
      kind: "ForgeCreatorControlDiscovery" as const,
      controlId: "creator_control_test",
      host: "127.0.0.1" as const,
      port: 8788,
      bearerToken: "bearer_token_123456789012345678901234",
      pid: process.pid,
      startedAt: "2026-09-03T00:00:00.000Z",
    };
    await writeCreatorControlDiscovery(discovery, path);
    assert.deepEqual(await readCreatorControlDiscovery(path), discovery);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creator control drops a backpressured SSE peer", async () => {
  const listeners = new Set<() => void>();
  const server = new CreatorControlServer({
    coordinator: fakeCoordinator({
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    dashboardDirectory: process.cwd(),
    port: 0,
  });
  const internal = server as unknown as { subscribers: Set<unknown>; invalidate(): void };
  let writes = 0;
  let ends = 0;
  const response = {
    destroyed: false,
    writableEnded: false,
    write() {
      writes += 1;
      return false;
    },
    end() {
      ends += 1;
      this.writableEnded = true;
    },
  };
  try {
    internal.subscribers.add(response);
    for (const listener of listeners) listener();
    assert.equal(writes, 1);
    assert.equal(ends, 1);
    assert.equal(internal.subscribers.size, 0);
  } finally {
    await server.close();
  }
});
