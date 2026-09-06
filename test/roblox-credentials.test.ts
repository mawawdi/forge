import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { ImmutableBinaryArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  ROBLOX_OAUTH_REDIRECT_URI,
  RobloxAuthenticatedHttpTransport,
  RobloxOAuthPkceClient,
  retainApiKeyCredential,
  type RobloxOAuthTransport,
  type RobloxSecretStore,
} from "../packages/roblox-assets/src/index.js";

class MemorySecrets implements RobloxSecretStore {
  readonly values = new Map<string, string>();
  async put(account: string, secret: string): Promise<void> {
    this.values.set(account, secret);
  }
  async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }
  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

test("OAuth PKCE uses a one-use fixed loopback callback and stores only host secrets", async () => {
  const secrets = new MemorySecrets();
  const requests: Parameters<RobloxOAuthTransport["request"]>[0][] = [];
  const client = new RobloxOAuthPkceClient(secrets, {
    async request(input) {
      requests.push(input);
      return input.endpoint.endsWith("/token")
        ? {
            status: 200,
            body: {
              access_token: "access-secret",
              refresh_token: "refresh-secret",
              expires_in: 899,
              scope: "openid asset:read asset:write",
            },
          }
        : { status: 200, body: { sub: "123456" } };
    },
  });
  const authorization = await client.begin({
    clientId: "fixture-client",
    scopes: ["openid", "asset:read", "asset:write"],
  });
  assert.equal("codeVerifier" in authorization, false);
  const authorizationUrl = new URL(authorization.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), ROBLOX_OAUTH_REDIRECT_URI);
  const waiting = client.awaitCallback(authorization.attemptId);
  const callback = new URL(ROBLOX_OAUTH_REDIRECT_URI);
  callback.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
  callback.searchParams.set("code", "fixture-code");
  const browserResponse = await fetch(callback);
  assert.equal(browserResponse.status, 200);
  const capability = await waiting;
  assert.equal(capability.actorId, "123456");
  assert.equal(JSON.stringify(capability).includes("access-secret"), false);
  const verifierLength = requests[0]?.form?.code_verifier?.length;
  assert.equal(typeof verifierLength === "number" && verifierLength >= 43, true);
  assert.equal(secrets.values.size, 1);
  await assert.rejects(client.awaitCallback(authorization.attemptId), /replayed/i);
});

test("OAuth reports a loopback port conflict before creating an authorization", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(57913, "127.0.0.1", resolve);
  });
  try {
    const client = new RobloxOAuthPkceClient(new MemorySecrets(), {
      async request() {
        throw new Error("transport must not run");
      },
    });
    await assert.rejects(
      client.begin({ clientId: "fixture-client", scopes: ["openid"] }),
      /port 57913 is already in use/i,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("refresh is serialized and uncertain rotation disconnects the credential", async () => {
  const secrets = new MemorySecrets();
  const accountId = "oauth2:fixture-client:123456";
  await secrets.put(
    accountId,
    JSON.stringify({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      clientId: "fixture-client",
      actorId: "123456",
    }),
  );
  let refreshCalls = 0;
  const client = new RobloxOAuthPkceClient(secrets, {
    async request() {
      refreshCalls += 1;
      throw new Error("connection reset after request");
    },
  });
  const results = await Promise.allSettled([client.refresh(accountId), client.refresh(accountId)]);
  assert.equal(refreshCalls, 1);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(await secrets.get(accountId), undefined);
});

test("API-key capability never contains the protected key", async () => {
  const secrets = new MemorySecrets();
  const capability = await retainApiKeyCredential({
    store: secrets,
    accountId: "api-key:fixture",
    actorId: "123456",
    scopes: ["asset:read", "asset:write"],
    apiKey: "super-secret-api-key-material",
  });
  assert.equal(JSON.stringify(capability).includes("super-secret"), false);
  assert.equal(await secrets.get("api-key:fixture"), "super-secret-api-key-material");
});

test("authenticated asset transport uses fixed endpoints, hidden headers, and retained exact versions", async () => {
  const secrets = new MemorySecrets();
  await secrets.put("api-key:fixture", "super-secret-api-key-material");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).includes("asset-delivery-api"))
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-length": "4" },
      });
    return new Response(JSON.stringify({ path: "operations/fixture-operation" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const transport = new RobloxAuthenticatedHttpTransport(
    secrets,
    { kind: "api_key", accountId: "api-key:fixture" },
    1000,
    1024,
    fetcher,
  );
  const response = await transport.send({
    method: "POST",
    url: "https://apis.roblox.com/assets/v1/assets",
    metadata: {
      assetType: "Model",
      displayName: "Fixture",
      description: "Fixture upload",
      creationContext: { creator: { userId: "123456" } },
    },
    file: {
      filename: "fixture.glb",
      contentType: "model/gltf-binary",
      bytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    },
  });
  assert.equal(response.httpStatus, 200);
  const first = calls[0]!;
  assert.equal(first.init.redirect, "error");
  assert.equal(new Headers(first.init.headers).get("x-api-key"), "super-secret-api-key-material");
  assert.equal(first.url.includes("super-secret"), false);
  assert.equal(String(first.init.body).includes("super-secret"), false);
  await assert.rejects(() =>
    transport.send({ method: "GET", url: "https://example.com/assets/v1/operations/fixture" }),
  );

  const root = await mkdtemp(resolve(import.meta.dirname, "../.asset-delivery-test-"));
  try {
    const binaryStore = new ImmutableBinaryArtifactStore(root);
    const artifact = await transport.retainExactVersion({
      assetId: "987654",
      versionNumber: 7,
      binaryStore,
    });
    assert.deepEqual(Array.from(await binaryStore.read(artifact)), [1, 2, 3, 4]);
    assert.match(calls.at(-1)!.url, /assetId\/987654\/version\/7$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
