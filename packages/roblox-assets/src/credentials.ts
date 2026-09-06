import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { contentHash, stableJson } from "../../contracts/src/index.js";

export const ROBLOX_OAUTH_REDIRECT_URI = "http://localhost:57913/oauth/callback";
export const ROBLOX_OAUTH_AUTHORIZE_ENDPOINT = "https://apis.roblox.com/oauth/v1/authorize";
export const ROBLOX_OAUTH_TOKEN_ENDPOINT = "https://apis.roblox.com/oauth/v1/token";
export const ROBLOX_OAUTH_USERINFO_ENDPOINT = "https://apis.roblox.com/oauth/v1/userinfo";

export interface RobloxCredentialHelperQualification {
  kind: "RobloxCredentialHelperQualification";
  abi: "forge-roblox-credential-helper@2";
  executablePath: string;
  executableSha256: string;
}

export interface RobloxCredentialCapability {
  kind: "RobloxCredentialCapability";
  mode: "api_key" | "oauth2";
  accountId: string;
  actorId: string;
  scopes: string[];
  expiresAt?: string;
  capabilityHash: string;
}

export interface RobloxSecretStore {
  put(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string | undefined>;
  delete(account: string): Promise<void>;
}

/** Keychain access is isolated in a fixed native helper; secrets travel only over stdin/stdout. */
export class RobloxCredentialStore {
  constructor(private readonly helper: RobloxCredentialHelperQualification) {
    if (
      helper.kind !== "RobloxCredentialHelperQualification" ||
      helper.abi !== "forge-roblox-credential-helper@2" ||
      !/^[0-9a-f]{64}$/u.test(helper.executableSha256)
    )
      throw new Error("Roblox credential helper qualification is malformed");
  }

  async put(account: string, secret: string): Promise<void> {
    await this.invoke({ operation: "put", account, secret });
  }

  async get(account: string): Promise<string | undefined> {
    const response = await this.invoke({ operation: "get", account });
    if (response.status === "absent") return undefined;
    if (
      response.status !== "present" ||
      typeof response.secret !== "string" ||
      response.secret.length === 0
    )
      throw new Error("Credential helper returned a malformed read response");
    return response.secret;
  }

  async delete(account: string): Promise<void> {
    await this.invoke({ operation: "delete", account });
  }

  private async invoke(input: {
    operation: "put" | "get" | "delete";
    account: string;
    secret?: string;
  }): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(input.account))
      throw new Error("Credential account is invalid");
    const actualHash = await hashFile(this.helper.executablePath, 16 * 1024 * 1024);
    if (actualHash !== this.helper.executableSha256)
      throw new Error("Credential helper differs from its qualified identity");
    const output = await runHelper(
      this.helper.executablePath,
      JSON.stringify(input),
      10_000,
      1024 * 1024,
    );
    if (output.exitCode !== 0) throw new Error("Credential helper operation failed");
    try {
      return JSON.parse(output.stdout) as Record<string, unknown>;
    } catch {
      throw new Error("Credential helper returned malformed JSON");
    }
  }
}

export interface RobloxOAuthTransport {
  request(input: {
    endpoint: typeof ROBLOX_OAUTH_TOKEN_ENDPOINT | typeof ROBLOX_OAUTH_USERINFO_ENDPOINT;
    method: "POST" | "GET";
    form?: Readonly<Record<string, string>>;
    bearer?: string;
  }): Promise<{ status: number; body: unknown }>;
}

export interface RobloxOAuthAuthorization {
  kind: "RobloxOAuthAuthorization";
  attemptId: string;
  authorizationUrl: string;
  createdAt: string;
  expiresAt: string;
}

interface RobloxOAuthAttempt {
  authorization: RobloxOAuthAuthorization;
  state: string;
  codeVerifier: string;
  clientId: string;
  scopes: string[];
  used: boolean;
  server: Server;
  callback: Promise<{ state: string; code: string }>;
}

export class RobloxOAuthPkceClient {
  private readonly attempts = new Map<string, RobloxOAuthAttempt>();
  private readonly refreshes = new Map<string, Promise<RobloxCredentialCapability>>();

  constructor(
    private readonly credentials: RobloxSecretStore,
    private readonly transport: RobloxOAuthTransport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async begin(input: {
    clientId: string;
    scopes: readonly string[];
  }): Promise<RobloxOAuthAuthorization> {
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(input.clientId))
      throw new Error("OAuth client ID is invalid");
    const scopes = [...new Set(input.scopes)].sort();
    if (
      scopes.length === 0 ||
      scopes.length > 16 ||
      scopes.some((scope) => !/^[a-z][a-z0-9:_-]{0,63}$/u.test(scope))
    )
      throw new Error("OAuth scope request is invalid");
    const codeVerifier = base64Url(randomBytes(64));
    const state = base64Url(randomBytes(32));
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + 5 * 60_000);
    const parameters = new URLSearchParams({
      client_id: input.clientId,
      code_challenge: base64Url(createHash("sha256").update(codeVerifier).digest()),
      code_challenge_method: "S256",
      redirect_uri: ROBLOX_OAUTH_REDIRECT_URI,
      scope: scopes.join(" "),
      response_type: "code",
      state,
    });
    const authorization: RobloxOAuthAuthorization = {
      kind: "RobloxOAuthAuthorization",
      attemptId: `roblox_oauth_${contentHash(stableJson([state, createdAt.toISOString()])).slice(0, 24)}`,
      authorizationUrl: `${ROBLOX_OAUTH_AUTHORIZE_ENDPOINT}?${parameters.toString()}`,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    let settle: ((value: { state: string; code: string }) => void) | undefined;
    let rejectCallback: ((error: Error) => void) | undefined;
    const callback = new Promise<{ state: string; code: string }>(
      (resolvePromise, rejectPromise) => {
        settle = resolvePromise;
        rejectCallback = rejectPromise;
      },
    );
    const server = createServer((request, response) => {
      try {
        if (request.method !== "GET" || !request.url)
          throw new Error("OAuth callback request is malformed");
        const callbackUrl = new URL(request.url, ROBLOX_OAUTH_REDIRECT_URI);
        if (callbackUrl.pathname !== "/oauth/callback")
          throw new Error("OAuth callback path differs");
        const returnedState = callbackUrl.searchParams.get("state") ?? "";
        const code = callbackUrl.searchParams.get("code") ?? "";
        const remoteError = callbackUrl.searchParams.get("error");
        if (remoteError) throw new Error("Roblox rejected OAuth authorization");
        if (returnedState !== state || !/^[A-Za-z0-9._~-]{1,4096}$/u.test(code))
          throw new Error("OAuth callback state or code is invalid");
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end("Forge received the Roblox authorization. You can close this tab.");
        settle?.({ state: returnedState, code });
      } catch (error: unknown) {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end("Forge rejected this OAuth callback.");
        rejectCallback?.(error instanceof Error ? error : new Error("OAuth callback failed"));
      } finally {
        server.close();
      }
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", (error) =>
        rejectPromise(
          (error as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? new Error("OAuth callback port 57913 is already in use")
            : error,
        ),
      );
      server.listen(57913, "127.0.0.1", () => resolvePromise());
    });
    const attempt: RobloxOAuthAttempt = {
      authorization,
      state,
      codeVerifier,
      clientId: input.clientId,
      scopes,
      used: false,
      server,
      callback,
    };
    this.attempts.set(authorization.attemptId, attempt);
    return structuredClone(authorization);
  }

  async awaitCallback(attemptId: string): Promise<RobloxCredentialCapability> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error("OAuth attempt is absent");
    let timeout: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => {
          attempt.server.close();
          reject(new Error("OAuth callback expired; reconnect before retrying"));
        },
        Math.max(0, Date.parse(attempt.authorization.expiresAt) - this.now().getTime()),
      );
    });
    try {
      const callback = await Promise.race([attempt.callback, expiry]);
      return await this.complete({ attemptId, ...callback });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async complete(input: {
    attemptId: string;
    state: string;
    code: string;
  }): Promise<RobloxCredentialCapability> {
    const attempt = this.attempts.get(input.attemptId);
    if (
      !attempt ||
      attempt.used ||
      attempt.state !== input.state ||
      this.now().getTime() > Date.parse(attempt.authorization.expiresAt)
    )
      throw new Error("OAuth callback state is absent, replayed, expired, or mismatched");
    attempt.used = true;
    if (!/^[A-Za-z0-9._~-]{1,4096}$/u.test(input.code))
      throw new Error("OAuth authorization code is malformed");
    let tokenResponse: { status: number; body: unknown };
    try {
      tokenResponse = await this.transport.request({
        endpoint: ROBLOX_OAUTH_TOKEN_ENDPOINT,
        method: "POST",
        form: {
          grant_type: "authorization_code",
          code: input.code,
          client_id: attempt.clientId,
          code_verifier: attempt.codeVerifier,
          redirect_uri: ROBLOX_OAUTH_REDIRECT_URI,
        },
      });
    } catch {
      throw new Error("OAuth token exchange outcome is uncertain; reconnect before retrying");
    }
    const token = parseTokenResponse(tokenResponse, this.now);
    let identityResponse: { status: number; body: unknown };
    try {
      identityResponse = await this.transport.request({
        endpoint: ROBLOX_OAUTH_USERINFO_ENDPOINT,
        method: "GET",
        bearer: token.accessToken,
      });
    } catch {
      throw new Error(
        "OAuth identity verification outcome is uncertain; reconnect before retrying",
      );
    }
    const actorId = parseIdentity(identityResponse);
    const accountId = `oauth2:${attempt.clientId}:${actorId}`;
    await this.credentials.put(
      accountId,
      JSON.stringify({ ...token, clientId: attempt.clientId, actorId }),
    );
    return capability("oauth2", accountId, actorId, token.scopes, token.expiresAt);
  }

  async refresh(accountId: string): Promise<RobloxCredentialCapability> {
    const existing = this.refreshes.get(accountId);
    if (existing) return existing;
    const refresh = this.refreshOne(accountId).finally(() => this.refreshes.delete(accountId));
    this.refreshes.set(accountId, refresh);
    return refresh;
  }

  private async refreshOne(accountId: string): Promise<RobloxCredentialCapability> {
    const stored = await this.credentials.get(accountId);
    if (!stored) throw new Error("OAuth credential is disconnected");
    const prior = JSON.parse(stored) as Record<string, unknown>;
    if (
      typeof prior.refreshToken !== "string" ||
      typeof prior.clientId !== "string" ||
      typeof prior.actorId !== "string"
    )
      throw new Error("OAuth credential record is malformed");
    let response: { status: number; body: unknown };
    try {
      response = await this.transport.request({
        endpoint: ROBLOX_OAUTH_TOKEN_ENDPOINT,
        method: "POST",
        form: {
          grant_type: "refresh_token",
          refresh_token: prior.refreshToken,
          client_id: prior.clientId,
        },
      });
    } catch {
      await this.credentials.delete(accountId);
      throw new Error("OAuth refresh outcome is uncertain; reconnect before retrying");
    }
    let token: ReturnType<typeof parseTokenResponse>;
    try {
      token = parseTokenResponse(response, this.now);
    } catch (error: unknown) {
      await this.credentials.delete(accountId);
      throw error;
    }
    await this.credentials.put(
      accountId,
      JSON.stringify({ ...token, clientId: prior.clientId, actorId: prior.actorId }),
    );
    return capability("oauth2", accountId, prior.actorId, token.scopes, token.expiresAt);
  }

  async disconnect(accountId: string): Promise<void> {
    await this.credentials.delete(accountId);
  }
}

export async function retainApiKeyCredential(input: {
  store: RobloxSecretStore;
  accountId: string;
  actorId: string;
  scopes: readonly string[];
  apiKey: string;
}): Promise<RobloxCredentialCapability> {
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(input.accountId))
    throw new Error("API-key account identity is invalid");
  if (!/^[1-9][0-9]{0,19}$/u.test(input.actorId))
    throw new Error("API-key actor identity is invalid");
  const scopes = [...new Set(input.scopes)].sort();
  if (
    scopes.length === 0 ||
    scopes.length > 16 ||
    scopes.some((scope) => !/^[a-z][a-z0-9:_-]{0,63}$/u.test(scope))
  )
    throw new Error("API-key scope declaration is invalid");
  if (input.apiKey.length < 20 || input.apiKey.length > 4096 || /[\r\n\0]/u.test(input.apiKey))
    throw new Error("API key is malformed");
  await input.store.put(input.accountId, input.apiKey);
  return capability("api_key", input.accountId, input.actorId, scopes);
}

function capability(
  mode: "api_key" | "oauth2",
  accountId: string,
  actorId: string,
  scopes: string[],
  expiresAt?: string,
): RobloxCredentialCapability {
  const material = {
    kind: "RobloxCredentialCapability" as const,
    mode,
    accountId,
    actorId,
    scopes: [...scopes].sort(),
    ...(expiresAt ? { expiresAt } : {}),
  };
  return { ...material, capabilityHash: contentHash(stableJson(material)) };
}

function parseTokenResponse(
  response: { status: number; body: unknown },
  now: () => Date,
): {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: string;
} {
  if (
    response.status < 200 ||
    response.status >= 300 ||
    !response.body ||
    typeof response.body !== "object"
  )
    throw new Error("OAuth token endpoint rejected the request");
  const body = response.body as Record<string, unknown>;
  if (
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.expires_in !== "number" ||
    !Number.isSafeInteger(body.expires_in) ||
    body.expires_in <= 0 ||
    typeof body.scope !== "string"
  )
    throw new Error("OAuth token endpoint returned a malformed response");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scopes: body.scope.split(/\s+/u).filter(Boolean).sort(),
    expiresAt: new Date(now().getTime() + body.expires_in * 1000).toISOString(),
  };
}

function parseIdentity(response: { status: number; body: unknown }): string {
  if (
    response.status < 200 ||
    response.status >= 300 ||
    !response.body ||
    typeof response.body !== "object"
  )
    throw new Error("OAuth identity verification failed");
  const subject = (response.body as Record<string, unknown>).sub;
  if (typeof subject !== "string" || !/^[1-9][0-9]{0,19}$/u.test(subject))
    throw new Error("OAuth identity response is malformed");
  return subject;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function hashFile(path: string, maximumBytes: number): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes)
      throw new Error("Credential helper is not a bounded regular file");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (read.bytesRead <= 0) throw new Error("Credential helper changed while hashing");
      digest.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error("Credential helper changed while hashing");
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function runHelper(
  path: string,
  input: string,
  timeoutMs: number,
  maximumBytes: number,
): Promise<{ exitCode: number; stdout: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(path, [], { env: {}, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (bytes > maximumBytes)
        return rejectPromise(new Error("Credential helper response exceeded its bound"));
      resolvePromise({ exitCode: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8") });
    });
    child.stdin.end(input);
  });
}
