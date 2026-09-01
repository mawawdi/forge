import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
        pairedStudio: { status: "unpaired", message: "waiting" },
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
    assert.equal((await state.json() as { kind: string }).kind, "CreatorDashboardState");
    assert.equal(state.headers.get("access-control-allow-origin"), null);

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
    for (let index = 0; index < 257; index += 1)
      for (const listener of listeners) listener();
    const expiredEvents = await fetch(
      `${origin}/api/control/events?after=0`,
      { headers: { authorization: `Bearer ${address.bearerToken}` } },
    );
    assert.equal(expiredEvents.status, 409);
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
