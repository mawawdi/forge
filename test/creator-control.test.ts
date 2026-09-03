import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  CreatorControlServer,
  readCreatorControlDiscovery,
  writeCreatorControlDiscovery,
} from "../packages/creator-control/src/index.js";
import type { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";

test("creator control exchanges one-time launch grants and separates cookie and bearer authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-creator-control-"));
  const dashboard = join(root, "dashboard");
  await mkdir(dashboard);
  await writeFile(join(dashboard, "index.html"), "<!doctype html><title>Forge</title>");
  const listeners = new Set<() => void>();
  const fake = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dashboardState() {
      return {
        kind: "CreatorDashboardState",
        sessions: [],
        pairedStudio: {
          status: "paired",
          message: "Studio paired, but its capability attestation was rejected.",
          attestationStatus: "rejected",
          attestationHash: "c".repeat(64),
          attestationArtifact: {
            locator: "studio-evidence/attestation-envelope.json",
            artifactHash: "c".repeat(64),
            bytes: 2_048,
          },
          attestation: {
            detail: "The backend verifier found one missing reflection row.",
            totalFacts: 183,
            observedFacts: 182,
            unavailableFacts: 0,
            readErrorFacts: 0,
            mismatchedFacts: 0,
            missingFacts: 1,
            findingsTruncated: false,
            findings: [
              {
                key: "reflection:project:Beam.Attachment0",
                code: "missing_fact",
                expected: {
                  catalogType: { category: "class", name: "Attachment" },
                  reflection: {
                    engineType: "RefType",
                    scriptType: "Instance",
                    instanceType: "Attachment",
                  },
                },
              },
            ],
          },
        },
        stages: [],
        serverTime: "2026-09-01T00:00:00.000Z",
      };
    },
    async action(value: unknown) {
      return value;
    },
    async readAuthorizedArtifact(hash: string) {
      if (hash !== "a".repeat(64)) throw new Error("unauthorized");
      return { safe: true };
    },
    async replayVerification(id: string) {
      return { kind: "CreatorVerificationReplay", verificationId: id };
    },
  } as unknown as CreatorSessionCoordinator;
  const server = new CreatorControlServer({
    coordinator: fake,
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
    assert.equal((await fetch(launch, { redirect: "manual" })).status, 401);

    const state = await fetch(`${origin}/api/control/state`, {
      headers: { cookie: cookie! },
    });
    assert.equal(state.status, 200);
    const dashboardState = (await state.json()) as {
      kind: string;
      pairedStudio: {
        attestation?: { missingFacts?: number; findings?: Array<{ code?: string }> };
        attestationArtifact?: { artifactHash?: string };
      };
    };
    assert.equal(dashboardState.kind, "CreatorDashboardState");
    assert.equal(dashboardState.pairedStudio.attestation?.missingFacts, 1);
    assert.equal(dashboardState.pairedStudio.attestation?.findings?.[0]?.code, "missing_fact");
    assert.equal(dashboardState.pairedStudio.attestationArtifact?.artifactHash, "c".repeat(64));
    assert.equal(state.headers.get("access-control-allow-origin"), null);

    const catalog = await fetch(`${origin}/api/control/catalog`, {
      headers: { authorization: `Bearer ${address.bearerToken}` },
    });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.headers.get("cache-control"), "no-store");
    assert.equal(((await catalog.json()) as { kind: string }).kind, "StudioCatalogSummary");

    const capabilities = await fetch(`${origin}/api/control/capabilities?class=Part&limit=1`, {
      headers: { authorization: `Bearer ${address.bearerToken}` },
    });
    assert.equal(capabilities.status, 200);
    const capabilityPage = (await capabilities.json()) as {
      kind: string;
      entries: unknown[];
      page: { limit: number };
    };
    assert.equal(capabilityPage.kind, "StudioCapabilityExplorerPage");
    assert.equal(capabilityPage.page.limit, 1);
    assert.ok(capabilityPage.entries.length <= 1);
    assert.equal(
      (
        await fetch(`${origin}/api/control/capabilities?limit=101`, {
          headers: { authorization: `Bearer ${address.bearerToken}` },
        })
      ).status,
      400,
    );

    const wrongOrigin = await fetch(`${origin}/api/control/action`, {
      method: "POST",
      headers: {
        cookie: cookie!,
        origin: "http://evil.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "start", prompt: "x" }),
    });
    assert.equal(wrongOrigin.status, 403);
    const bearer = await fetch(`${origin}/api/control/action`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${address.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "start", prompt: "x" }),
    });
    assert.equal(bearer.status, 200);
    const oversized = await fetch(`${origin}/api/control/action`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${address.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "start", prompt: "x".repeat(70_000) }),
    });
    assert.equal(oversized.status, 413);
    for (let index = 0; index < 257; index += 1) for (const listener of listeners) listener();
    const expiredEventsAbort = new AbortController();
    const expiredEvents = await fetch(`${origin}/api/control/events?after=0`, {
      headers: { authorization: `Bearer ${address.bearerToken}` },
      signal: expiredEventsAbort.signal,
    });
    assert.equal(expiredEvents.status, 200);
    const reader = expiredEvents.body?.getReader();
    assert.ok(reader);
    const reset = await reader.read();
    assert.match(new TextDecoder().decode(reset.value), /event: reset/);
    assert.match(new TextDecoder().decode(reset.value), /id: 257/);
    for (const listener of listeners) listener();
    const invalidation = await reader.read();
    assert.match(new TextDecoder().decode(invalidation.value), /id: 258/);
    await reader.cancel();
    expiredEventsAbort.abort();
    // A dropped SSE peer is removed before the next coordinator invalidation.
    // Invalidation must not throw or take down the control server.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    for (const listener of listeners) listener();
    assert.equal(
      (
        await fetch(`${origin}/api/control/state`, {
          headers: { authorization: `Bearer ${address.bearerToken}` },
        })
      ).status,
      200,
    );
    const artifact = await fetch(`${origin}/api/artifacts/${"a".repeat(64)}`, {
      headers: { authorization: `Bearer ${address.bearerToken}` },
    });
    assert.deepEqual(await artifact.json(), { safe: true });
    assert.equal(
      (
        await fetch(`${origin}/api/artifacts/${"b".repeat(64)}`, {
          headers: { authorization: `Bearer ${address.bearerToken}` },
        })
      ).status,
      400,
    );
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
      startedAt: "2026-09-01T00:00:00.000Z",
    };
    await writeCreatorControlDiscovery(discovery, path);
    assert.deepEqual(await readCreatorControlDiscovery(path), discovery);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creator control drops a backpressured SSE peer instead of retaining its write buffer", async () => {
  const listeners = new Set<() => void>();
  const fake = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as CreatorSessionCoordinator;
  const server = new CreatorControlServer({
    coordinator: fake,
    dashboardDirectory: process.cwd(),
    port: 0,
  });
  const internal = server as unknown as {
    subscribers: Set<unknown>;
    invalidate(): void;
  };
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

test("creator control survives an aborted client after its action is admitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-creator-control-abort-"));
  const dashboard = join(root, "dashboard");
  await mkdir(dashboard);
  await writeFile(join(dashboard, "index.html"), "<!doctype html><title>Forge</title>");
  let actionCalls = 0;
  let beginAction!: () => void;
  let completeAction!: () => void;
  const actionStarted = new Promise<void>((resolvePromise) => {
    beginAction = resolvePromise;
  });
  const actionCompletion = new Promise<void>((resolvePromise) => {
    completeAction = resolvePromise;
  });
  const fake = {
    subscribe: () => () => undefined,
    async action() {
      actionCalls += 1;
      beginAction();
      await actionCompletion;
    },
    async dashboardState() {
      return { kind: "CreatorDashboardState" };
    },
  } as unknown as CreatorSessionCoordinator;
  const server = new CreatorControlServer({
    coordinator: fake,
    dashboardDirectory: dashboard,
    port: 0,
    bearerToken: "bearer_token_aborted_request_123456789012",
  });
  try {
    const address = await server.listen();
    const body = JSON.stringify({ action: "start", prompt: "Bounded request" });
    const socket = createConnection({ host: address.host, port: address.port });
    await once(socket, "connect");
    socket.write(
      [
        "POST /api/control/action HTTP/1.1",
        `Host: ${address.host}:${address.port}`,
        `Authorization: Bearer ${address.bearerToken}`,
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
        "",
        body,
      ].join("\r\n"),
    );
    await actionStarted;
    const closed = once(socket, "close");
    socket.destroy();
    await closed;
    completeAction();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    assert.equal(actionCalls, 1);
    const health = await fetch(`http://${address.host}:${address.port}/api/control/state`, {
      headers: { authorization: `Bearer ${address.bearerToken}` },
    });
    assert.equal(health.status, 200);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed action whose resulting view fails is reported as an ambiguous outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-creator-control-ambiguous-"));
  const dashboard = join(root, "dashboard");
  await mkdir(dashboard);
  await writeFile(join(dashboard, "index.html"), "<!doctype html><title>Forge</title>");
  let actionCalls = 0;
  const fake = {
    subscribe: () => () => undefined,
    async action() {
      actionCalls += 1;
    },
    async dashboardState() {
      throw new Error("change presentation failed after persistence");
    },
  } as unknown as CreatorSessionCoordinator;
  const server = new CreatorControlServer({
    coordinator: fake,
    dashboardDirectory: dashboard,
    port: 0,
    bearerToken: "bearer_token_ambiguous_123456789012345678",
  });
  try {
    const address = await server.listen();
    const response = await fetch(`http://${address.host}:${address.port}/api/control/action`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${address.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "start", prompt: "Bounded request" }),
    });
    assert.equal(actionCalls, 1);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      kind: "CreatorControlActionOutcomeUnknown",
      message:
        "The creator action completed, but Forge could not materialize its resulting dashboard state: change presentation failed after persistence",
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
