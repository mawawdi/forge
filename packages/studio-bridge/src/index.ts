import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertPluginToBackendMessage, assertBackendToPluginMessage, MAX_PROTOCOL_MESSAGE_BYTES, type BackendToPluginMessage, type PairingResponse, type PluginProjectIdentity, type PluginToBackendMessage, type StudioCapability, type StudioEvidenceProducedPayload, type StudioTransport } from "../../studio-protocol/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  STUDIO_CONNECTOR_BUILD_HASH,
  compileProjectStateProjection,
  createStudioEvidenceProjection,
  serializeStudioEvidenceProjection,
  studioEvidenceFactKey,
  type StudioEvidenceProjection,
} from "../../studio-evidence/src/index.js";

export interface PairingCode {
  token: string;
  expiresAt: string;
}

export interface StudioBridgeOptions {
  host?: string;
  port?: number;
  pairingTtlMs?: number;
  now?: () => Date;
  /** Required to use backend control endpoints. Never sent to the Studio plugin. */
  controlToken?: string;
  maxRetainedEvents?: number;
}

export interface StudioBridgeDiscovery {
  kind: "ForgeStudioBridgeDiscovery";
    bridgeId: string;
  host: "127.0.0.1";
  port: number;
  controlToken: string;
  pid: number;
  startedAt: string;
}

export function defaultStudioBridgeDiscoveryPath(cwd: string = process.cwd()): string {
  return resolve(cwd, ".forge", "studio-bridge.json");
}

export async function writeStudioBridgeDiscovery(discovery: StudioBridgeDiscovery, filePath: string = defaultStudioBridgeDiscoveryPath()): Promise<void> {
  assertStudioBridgeDiscovery(discovery);
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(discovery, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

export async function readStudioBridgeDiscovery(filePath: string = defaultStudioBridgeDiscoveryPath()): Promise<StudioBridgeDiscovery> {
  let metadata;
  try {
    metadata = await stat(filePath);
  } catch {
    throw new Error("Forge Studio bridge is not running. Start `node bin/forge.js studio bridge` first.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Forge Studio bridge discovery file permissions are too broad; restart the bridge");
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  assertStudioBridgeDiscovery(value);
  return value;
}

export async function removeStudioBridgeDiscovery(bridgeId: string, filePath: string = defaultStudioBridgeDiscoveryPath()): Promise<void> {
  try {
    const current = await readStudioBridgeDiscovery(filePath);
    if (current.bridgeId === bridgeId) await rm(filePath, { force: true });
  } catch {
    // Missing, malformed, or replaced discovery belongs to no longer-running
    // state and must not make bridge shutdown fail.
  }
}

function assertStudioBridgeDiscovery(value: unknown): asserts value is StudioBridgeDiscovery {
  if (!value || typeof value !== "object") throw new Error("Invalid Forge Studio bridge discovery state");
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "ForgeStudioBridgeDiscovery" || typeof candidate.bridgeId !== "string" || candidate.bridgeId.length < 8 || candidate.host !== "127.0.0.1" || typeof candidate.port !== "number" || !Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65_535 || typeof candidate.controlToken !== "string" || candidate.controlToken.length < 24 || typeof candidate.pid !== "number" || !Number.isInteger(candidate.pid) || candidate.pid < 1 || typeof candidate.startedAt !== "string") throw new Error("Invalid Forge Studio bridge discovery state");
}

export interface StudioBridgeSession {
  sessionId: string;
  projectId: string;
  project: PluginProjectIdentity;
  capabilities: StudioCapability[];
  manifestHash: string;
  connectorBuildHash: string;
  capabilityAttestationProjectionHash: string;
  projectStateProjectionHash: string;
  sessionToken: string;
  connectedAt: string;
}

type MessageHandler = (message: PluginToBackendMessage, session: StudioBridgeSession) => void | Promise<void>;

export interface StudioBridgeConnection {
  send(message: BackendToPluginMessage): Promise<void>;
  subscribeWithSession(handler: MessageHandler): () => void;
  close(): Promise<void>;
}

export class StudioBridgeServer implements StudioTransport {
  private readonly host: string;
  private readonly port: number;
  private readonly pairingTtlMs: number;
  private readonly now: () => Date;
  private readonly controlToken: string;
  private readonly maxRetainedEvents: number;
  private readonly server: Server;
  private readonly handlers = new Set<MessageHandler>();
  private readonly sessions = new Map<string, StudioBridgeSession>();
  private readonly outbound = new Map<string, BackendToPluginMessage[]>();
  private readonly outboundMessageIds = new Map<string, { ids: Set<string>; order: string[] }>();
  private readonly receivedMessageIds = new Map<string, { ids: Set<string>; order: string[] }>();
  private readonly events = new Map<string, { baseCursor: number; messages: PluginToBackendMessage[] }>();
  private readonly pairings = new Map<string, PairingCode>();

  constructor(options: StudioBridgeOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    if (this.host !== "127.0.0.1") throw new Error("Forge Studio bridge supports loopback host 127.0.0.1 only");
    this.port = options.port ?? 8787;
    this.pairingTtlMs = options.pairingTtlMs ?? 10 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.controlToken = options.controlToken ?? randomBytes(24).toString("base64url");
    this.maxRetainedEvents = options.maxRetainedEvents ?? 512;
    this.server = createServer((request, response) => { void this.handle(request, response); });
  }

  createPairing(): PairingCode {
    this.prunePairings();
    const expiresAt = new Date(this.now().getTime() + this.pairingTtlMs).toISOString();
    const pairing = { token: randomBytes(18).toString("base64url"), expiresAt };
    this.pairings.set(pairing.token, pairing);
    while (this.pairings.size > 32) this.pairings.delete(this.pairings.keys().next().value as string);
    return { ...pairing };
  }

  async listen(): Promise<{ host: "127.0.0.1"; port: number; controlToken: string }> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    const actualPort = typeof address === "object" && address ? address.port : this.port;
    return { host: "127.0.0.1", port: actualPort, controlToken: this.controlToken };
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  subscribe(handler: (message: PluginToBackendMessage) => void | Promise<void>): () => void {
    const wrapped: MessageHandler = (message) => handler(message);
    this.handlers.add(wrapped);
    return () => this.handlers.delete(wrapped);
  }

  subscribeWithSession(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async send(message: BackendToPluginMessage): Promise<void> {
    assertBackendToPluginMessage(message);
    const sessionId = message.sessionId;
    if (!sessionId || !this.sessions.has(sessionId)) throw new Error("Studio session is not connected");
    const queue = this.outbound.get(sessionId) ?? [];
    if (this.outboundMessageIds.get(sessionId)?.ids.has(message.messageId)) return;
    if (queue.length >= 128) throw new Error("Studio outbound command queue is full");
    this.rememberOutbound(sessionId, message.messageId);
    queue.push(message);
    this.outbound.set(sessionId, queue);
  }

  getSessions(): StudioBridgeSession[] { return [...this.sessions.values()].map((session) => ({ ...session })); }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    try {
      if (request.method === "GET" && request.url === "/health") return writeJson(response, 200, { kind: "ForgeStudioBridgeHealth", status: "ok" });
      if (request.method === "GET" && request.url === "/pairing") return this.autoPairing(response);
      if (request.method === "GET" && request.url === "/sessions") { this.assertControl(request); return this.listSessions(response); }
      if (request.method === "GET" && request.url?.startsWith("/events")) { this.assertControl(request); return this.eventsFor(request, response); }
      if (request.method === "POST" && request.url === "/command") { this.assertControl(request); return await this.command(request, response); }
      if (request.method === "GET" && request.url?.startsWith("/poll")) return this.poll(request, response);
      if (request.method === "POST" && request.url === "/message") return await this.receive(request, response);
      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeJson(response, error instanceof ProtocolHttpError ? error.status : 400, { kind: "ForgeStudioBridgeError", code: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private autoPairing(response: ServerResponse): void {
    // Each discovery request gets an independent one-use grant. Multiple open
    // Studio windows must never steal one global pairing slot from each other.
    writeJson(response, 200, { kind: "ForgeStudioAutoPairing", pairing: this.createPairing() });
  }

  private poll(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://forge.local");
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const sessionToken = request.headers["x-forge-session-token"];
    const session = this.sessions.get(sessionId);
    if (!session || typeof sessionToken !== "string" || session.sessionToken !== sessionToken) throw new ProtocolHttpError(401, "Invalid Studio session");
    const messages = this.outbound.get(sessionId) ?? [];
    this.outbound.set(sessionId, []);
    writeJson(response, 200, { kind: "ForgeStudioPollResponse", sessionId, messages });
  }

  private listSessions(response: ServerResponse): void {
    writeJson(response, 200, {
      kind: "ForgeStudioSessions",
            sessions: this.getSessions().map(({ sessionToken: _sessionToken, ...session }) => ({
        ...session,
        eventCursor: this.eventCursor(session.sessionId),
      })),
    });
  }

  private eventsFor(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://forge.local");
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const after = Number(url.searchParams.get("after") ?? "0");
    if (!this.sessions.has(sessionId) || !Number.isInteger(after) || after < 0) throw new ProtocolHttpError(400, "Invalid Studio event cursor");
    const retained = this.events.get(sessionId) ?? { baseCursor: 0, messages: [] };
    if (after < retained.baseCursor) throw new ProtocolHttpError(409, "Studio event cursor expired; restart verification from a fresh paired session");
    const offset = after - retained.baseCursor;
    const messages = retained.messages.slice(offset, offset + 128);
    writeJson(response, 200, { kind: "ForgeStudioEvents", sessionId, cursor: after + messages.length, messages });
  }

  private async command(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const message = JSON.parse(await readBody(request)) as unknown;
    assertBackendToPluginMessage(message);
    const sessionId = message.sessionId;
    if (!sessionId || !this.sessions.has(sessionId)) throw new ProtocolHttpError(401, "Studio session is not connected");
    if (this.outboundMessageIds.get(sessionId)?.ids.has(message.messageId)) {
      writeJson(response, 202, { kind: "ForgeStudioCommandAccepted", messageId: message.messageId, duplicate: true });
      return;
    }
    const queue = this.outbound.get(sessionId) ?? [];
    if (queue.length >= 128) throw new ProtocolHttpError(429, "Studio outbound command queue is full");
    this.rememberOutbound(sessionId, message.messageId);
    queue.push(message);
    this.outbound.set(sessionId, queue);
    writeJson(response, 202, { kind: "ForgeStudioCommandAccepted", messageId: message.messageId });
  }

  private async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const message = JSON.parse(await readBody(request)) as unknown;
    assertPluginToBackendMessage(message);
    if (message.type === "PairProject") return await this.pair(message, response);
    const session = message.sessionId ? this.sessions.get(message.sessionId) : undefined;
    if (!session) throw new ProtocolHttpError(401, "Studio message requires a connected session");
    const sessionToken = request.headers["x-forge-session-token"];
    if (typeof sessionToken !== "string" || sessionToken !== session.sessionToken) throw new ProtocolHttpError(401, "Invalid Studio session token");
    if (
      (message.type === "StudioEvidenceProduced" || message.type === "StudioEvidenceChunk" || message.type === "Heartbeat") &&
      !sameProjectIdentity(message.payload.project, session.project)
    ) throw new ProtocolHttpError(409, "Studio evidence project does not match its paired session");
    if (message.type === "UnpairProject") {
      await Promise.all([...this.handlers].map((handler) => handler(message, session)));
      this.dropSession(session.sessionId);
      writeJson(response, 202, { kind: "ForgeStudioMessageAccepted", messageId: message.messageId });
      return;
    }
    const received = this.receivedMessageIds.get(session.sessionId) ?? { ids: new Set<string>(), order: [] };
    if (received.ids.has(message.messageId)) {
      writeJson(response, 202, { kind: "ForgeStudioMessageAccepted", messageId: message.messageId, duplicate: true });
      return;
    }
    received.ids.add(message.messageId);
    received.order.push(message.messageId);
    while (received.order.length > this.maxRetainedEvents * 2) {
      const expired = received.order.shift();
      if (expired) received.ids.delete(expired);
    }
    this.receivedMessageIds.set(session.sessionId, received);
    const retained = this.events.get(session.sessionId) ?? { baseCursor: 0, messages: [] };
    retained.messages.push(message);
    if (retained.messages.length > this.maxRetainedEvents) {
      const removed = retained.messages.length - this.maxRetainedEvents;
      retained.messages.splice(0, removed);
      retained.baseCursor += removed;
    }
    this.events.set(session.sessionId, retained);
    await Promise.all([...this.handlers].map((handler) => handler(message, session)));
    writeJson(response, 202, { kind: "ForgeStudioMessageAccepted", messageId: message.messageId });
  }

  private async pair(message: Extract<PluginToBackendMessage, { type: "PairProject" }>, response: ServerResponse): Promise<void> {
    this.prunePairings();
    const pairing = this.pairings.get(message.payload.pairingToken);
    if (!pairing) throw new ProtocolHttpError(401, "Pairing grant is invalid, expired, or already used");
    this.pairings.delete(pairing.token);
    const sessionId = `studio_${randomUUID()}`;
    const sessionToken = randomBytes(24).toString("base64url");
    const projectId = studioProjectId(message.payload.project);
    if (message.payload.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH)
      throw new ProtocolHttpError(409, "Studio connector manifest is incompatible with this Forge build");
    if (message.payload.connectorBuildHash !== STUDIO_CONNECTOR_BUILD_HASH)
      throw new ProtocolHttpError(409, "Studio connector protocol is incompatible with this Forge build");
    const evidenceBinding = {
      sessionId,
      projectId,
      buildHash: STUDIO_CONNECTOR_BUILD_HASH,
      pairingHash: createHash("sha256").update(message.payload.pairingToken).digest("hex"),
    };
    const capabilityAttestationProjection = compileCapabilityAttestationProjection(
      sessionId,
      message.payload.project,
      evidenceBinding,
    );
    const projectStateProjection = compileProjectStateProjection({
      id: `studio_project_state_${sessionId}`,
      project: message.payload.project,
      binding: evidenceBinding,
    });
    const session: StudioBridgeSession = {
      sessionId,
      projectId,
      project: message.payload.project,
      capabilities: [...message.payload.capabilities],
      manifestHash: message.payload.manifestHash,
      connectorBuildHash: STUDIO_CONNECTOR_BUILD_HASH,
      capabilityAttestationProjectionHash: capabilityAttestationProjection.contentHash,
      projectStateProjectionHash: projectStateProjection.contentHash,
      sessionToken,
      connectedAt: this.now().toISOString(),
    };
    for (const [existingId, existing] of this.sessions) {
      if (studioProjectKey(existing.project) === studioProjectKey(session.project)) {
        this.dropSession(existingId);
      }
    }
    this.sessions.set(sessionId, session);
    this.outbound.set(sessionId, []);
    this.outboundMessageIds.set(sessionId, { ids: new Set(), order: [] });
    this.events.set(sessionId, { baseCursor: 0, messages: [] });
    this.receivedMessageIds.set(sessionId, { ids: new Set(), order: [] });
    const capabilityAttestationProjectionJson = serializeStudioEvidenceProjection(capabilityAttestationProjection);
    const projectStateProjectionJson = serializeStudioEvidenceProjection(projectStateProjection);
    const payload: PairingResponse = {
      sessionId,
      sessionToken,
      projectId,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      connectorBuildHash: STUDIO_CONNECTOR_BUILD_HASH,
      capabilityAttestationProjectionJson,
      capabilityAttestationProjectionJsonHash: createHash("sha256").update(capabilityAttestationProjectionJson).digest("hex"),
      capabilityAttestationProjectionHash: capabilityAttestationProjection.contentHash,
      projectStateProjectionJson,
      projectStateProjectionJsonHash: createHash("sha256").update(projectStateProjectionJson).digest("hex"),
      projectStateProjectionHash: projectStateProjection.contentHash,
      expiresAt: new Date(this.now().getTime() + this.pairingTtlMs).toISOString(),
    };
    writeJson(response, 200, { kind: "ForgeStudioPairAccepted", ...payload });
    // Pairing has exactly one synchronous response path. It is never also
    // queued as a command, which prevents duplicate enrollment and snapshots.
    await Promise.all([...this.handlers].map((handler) => handler(message, session)));
  }

  private dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.outbound.delete(sessionId);
    this.outboundMessageIds.delete(sessionId);
    this.events.delete(sessionId);
    this.receivedMessageIds.delete(sessionId);
  }

  private eventCursor(sessionId: string): number {
    const retained = this.events.get(sessionId) ?? { baseCursor: 0, messages: [] };
    return retained.baseCursor + retained.messages.length;
  }

  private prunePairings(): void {
    const now = this.now().getTime();
    for (const [token, pairing] of this.pairings) if (new Date(pairing.expiresAt).getTime() <= now) this.pairings.delete(token);
  }

  private rememberOutbound(sessionId: string, messageId: string): void {
    const retained = this.outboundMessageIds.get(sessionId) ?? { ids: new Set<string>(), order: [] };
    retained.ids.add(messageId);
    retained.order.push(messageId);
    while (retained.order.length > 256) {
      const expired = retained.order.shift();
      if (expired) retained.ids.delete(expired);
    }
    this.outboundMessageIds.set(sessionId, retained);
  }

  private assertControl(request: IncomingMessage): void {
    const token = request.headers["x-forge-control-token"];
    if (typeof token !== "string" || token !== this.controlToken) throw new ProtocolHttpError(401, "Invalid Forge bridge control token");
  }
}

/**
 * Client for a bridge owned by a separate `forge studio bridge` process.
 * The verifier never owns that server's port or pairing token. The control
 * endpoints are intentionally loopback-only in the supported workflow.
 */
export class StudioBridgeClient implements StudioBridgeConnection {
  private readonly baseUrl: string;
  private readonly handlers = new Set<MessageHandler>();
  private readonly cursors = new Map<string, number>();
  private readonly evidenceChunks = new Map<string, { session: StudioBridgeSession; project: PluginProjectIdentity; reason: import("../../studio-protocol/src/index.js").StudioEvidenceReason; total: number; bytes: number; chunks: Map<number, string> }>();
  private sessions = new Map<string, StudioBridgeSession>();
  private polling = false;
  private pollPromise: Promise<void> = Promise.resolve();

  constructor(options: Pick<StudioBridgeOptions, "host" | "port" | "controlToken">) {
    this.baseUrl = `http://${options.host ?? "127.0.0.1"}:${options.port ?? 8787}`;
    if (!options.controlToken) throw new Error("Forge bridge control token is required");
    this.controlToken = options.controlToken;
    this.pollPromise = this.pollLoop();
  }

  private readonly controlToken: string;

  async waitForSession(timeoutMs: number): Promise<StudioBridgeSession> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.refreshSessions();
      const sessions = [...this.sessions.values()];
      if (sessions.length === 1) return { ...sessions[0]! };
      if (sessions.length > 1) {
        const projects = sessions.map((session) => `${session.project.name} (${session.sessionId})`).sort().join(", ");
        throw new Error(`Multiple Studio projects are connected: ${projects}. Disconnect or close the unrelated Studio windows, then retry verification.`);
      }
      await delay(250);
    }
    throw new Error("No paired Studio session found on the existing Forge bridge. Pair the plugin, then retry.");
  }

  subscribeWithSession(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    if (!this.polling) {
      this.polling = true;
      this.pollPromise = this.pollLoop();
    }
    return () => this.handlers.delete(handler);
  }

  async send(message: BackendToPluginMessage): Promise<void> {
    assertBackendToPluginMessage(message);
    const response = await fetch(`${this.baseUrl}/command`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forge-control-token": this.controlToken },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Forge bridge command failed: ${response.status} ${await response.text()}`);
  }

  getSessions(): StudioBridgeSession[] { return [...this.sessions.values()].map((session) => ({ ...session })); }

  async close(): Promise<void> {
    this.polling = false;
    await this.pollPromise;
    this.handlers.clear();
    this.cursors.clear();
    this.evidenceChunks.clear();
    this.sessions.clear();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        await this.refreshSessions();
        for (const session of this.sessions.values()) await this.readEvents(session);
      } catch {
        // The verifier's bounded wait reports a useful failure. Transient
        // bridge outages are retried without inventing a Studio result.
      }
      await delay(150);
    }
  }

  private async refreshSessions(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sessions`, { headers: { "x-forge-control-token": this.controlToken }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Forge bridge is unavailable (${response.status})`);
    const body = await response.json() as { sessions?: Array<StudioBridgeSession & { eventCursor: number }> };
    if (!Array.isArray(body.sessions)) throw new Error("Forge bridge returned an invalid session list");
    const next = new Map(body.sessions.map(({ eventCursor, ...session }) => {
      if (!Number.isInteger(eventCursor) || eventCursor < 0) throw new Error("Forge bridge returned an invalid event cursor");
      if (!this.sessions.has(session.sessionId)) this.cursors.set(session.sessionId, eventCursor);
      return [session.sessionId, { ...session, sessionToken: "" }] as const;
    }));
    for (const sessionId of this.sessions.keys()) {
      if (next.has(sessionId)) continue;
      this.cursors.delete(sessionId);
      for (const key of this.evidenceChunks.keys()) if (key.startsWith(`${sessionId}:`)) this.evidenceChunks.delete(key);
    }
    this.sessions = next;
  }

  private async readEvents(session: StudioBridgeSession): Promise<void> {
    const after = this.cursors.get(session.sessionId) ?? 0;
    const response = await fetch(`${this.baseUrl}/events?sessionId=${encodeURIComponent(session.sessionId)}&after=${after}`, { headers: { "x-forge-control-token": this.controlToken }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Forge bridge event stream failed: ${response.status}`);
    const body = await response.json() as { cursor?: number; messages?: unknown[] };
    if (typeof body.cursor !== "number" || !Number.isInteger(body.cursor) || !Array.isArray(body.messages)) return;
    this.cursors.set(session.sessionId, body.cursor);
    for (const value of body.messages) {
      try {
        assertPluginToBackendMessage(value);
        if (value.type === "StudioEvidenceChunk") {
          await this.acceptEvidenceChunk(value, session);
        } else {
          await this.dispatch(value, session);
        }
      } catch {
        // Invalid event data is ignored by the client and cannot become proof.
      }
    }
  }

  private async dispatch(message: PluginToBackendMessage, session: StudioBridgeSession): Promise<void> {
    await Promise.all([...this.handlers].map((handler) => handler(message, session)));
  }

  private async acceptEvidenceChunk(message: Extract<PluginToBackendMessage, { type: "StudioEvidenceChunk" }>, session: StudioBridgeSession): Promise<void> {
    const payload = message.payload;
    if (createHash("sha256").update(payload.payload).digest("hex") !== payload.payloadHash) throw new Error("Studio evidence chunk SHA-256 mismatch");
    if (!sameProjectIdentity(payload.project, session.project)) throw new Error("Studio evidence chunk project does not match its paired session");
    const key = `${session.sessionId}:${payload.evidenceId}`;
    let pending = this.evidenceChunks.get(key);
    if (!pending) {
      if (this.evidenceChunks.size >= 8) throw new Error("Too many concurrent Studio evidence streams");
      pending = { session, project: payload.project, reason: payload.reason, total: payload.total, bytes: 0, chunks: new Map() };
      this.evidenceChunks.set(key, pending);
    }
    if (pending.total !== payload.total || pending.reason !== payload.reason || pending.chunks.has(payload.index)) throw new Error("Invalid or duplicate Studio evidence chunk");
    const nextBytes = pending.bytes + Buffer.byteLength(payload.payload, "utf8");
    if (nextBytes > STUDIO_CAPABILITY_MANIFEST.projectState.maximumEvidenceBytes * 2) {
      this.evidenceChunks.delete(key);
      throw new Error("Studio evidence stream exceeds the manifest evidence bound");
    }
    pending.bytes = nextBytes;
    pending.chunks.set(payload.index, payload.payload);
    if (pending.chunks.size !== pending.total) return;
    const encoded = [...pending.chunks.entries()].sort(([left], [right]) => left - right).map(([, chunk]) => chunk).join("");
    const evidence = JSON.parse(encoded) as StudioEvidenceProducedPayload;
    const reconstructed = {
      kind: "StudioProtocolMessage", direction: "plugin_to_backend", type: "StudioEvidenceProduced", messageId: `evidence_${payload.evidenceId}`, sessionId: session.sessionId, sentAt: evidence.envelope.endedAt,
      payload: evidence,
    } as PluginToBackendMessage;
    assertPluginToBackendMessage(reconstructed);
    this.evidenceChunks.delete(key);
    await this.dispatch(reconstructed, session);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function studioProjectKey(project: PluginProjectIdentity): string {
  if (project.placeId !== 0 || project.universeId !== 0) return `published:${project.universeId}:${project.placeId}`;
  return `local:${project.name.normalize("NFC")}`;
}

function sameProjectIdentity(left: PluginProjectIdentity, right: PluginProjectIdentity): boolean {
  return left.name === right.name && left.placeId === right.placeId && left.universeId === right.universeId;
}

function studioProjectId(project: PluginProjectIdentity): string {
  return `studio_project_${createHash("sha256").update(studioProjectKey(project)).digest("hex").slice(0, 24)}`;
}

function compileCapabilityAttestationProjection(
  sessionId: string,
  project: PluginProjectIdentity,
  binding: Record<string, string>,
): StudioEvidenceProjection {
  const target = { kind: "project" as const };
  return createStudioEvidenceProjection({
    id: `studio_capability_attestation_${sessionId}`,
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    purpose: "capability_attestation",
    project,
    binding,
    requirements: STUDIO_CAPABILITY_MANIFEST.classes.flatMap((classDefinition) =>
      classDefinition.properties.map((property) => ({
        key: studioEvidenceFactKey("reflection", target, `${classDefinition.name}.${property.name}`),
        kind: "reflection" as const,
        target,
      })),
    ),
    scope: { mode: "exact", roots: [], requireCompleteInventory: false },
    bounds: {
      maximumFacts: STUDIO_CAPABILITY_MANIFEST.limits.maximumProjectionFacts,
      maximumBytes: STUDIO_CAPABILITY_MANIFEST.limits.maximumProjectionBytes,
      roots: [],
    },
  });
}

export function createBackendMessage<T extends keyof BackendPayloadByType>(type: T, payload: BackendPayloadByType[T], sessionId: string, requestId?: string, now: () => Date = () => new Date()): BackendToPluginMessage {
  const message = { kind: "StudioProtocolMessage", direction: "backend_to_plugin", type, messageId: `msg_${randomUUID()}`, ...(requestId ? { requestId } : {}), sessionId, sentAt: now().toISOString(), payload } as BackendToPluginMessage;
  assertBackendToPluginMessage(message);
  return message;
}

export type BackendPayloadByType = {
  RequestStudioEvidence: import("../../studio-protocol/src/index.js").RequestStudioEvidencePayload;
  ExecuteRuntimeEvalPlan: import("../../studio-protocol/src/index.js").ExecuteRuntimeEvalPlanPayload;
  PrepareCreatorChangeSet: import("../../studio-protocol/src/index.js").PrepareCreatorChangeSetPayload;
  PreflightCreatorChangeSet: import("../../studio-protocol/src/index.js").PreflightCreatorChangeSetPayload;
  ApplyCreatorChangeSet: import("../../studio-protocol/src/index.js").ApplyCreatorChangeSetPayload;
  FinalizeCreatorChangeSet: import("../../studio-protocol/src/index.js").FinalizeCreatorChangeSetPayload;
  RequestCreatorRecordingRecovery: import("../../studio-protocol/src/index.js").RequestCreatorRecordingRecoveryPayload;
  AcknowledgeClosedCreatorRecording: import("../../studio-protocol/src/index.js").AcknowledgeClosedCreatorRecordingPayload;
  CancelInterruptedRecording: import("../../studio-protocol/src/index.js").CancelInterruptedRecordingPayload;
  AcknowledgeCreatorChangeFinalization: import("../../studio-protocol/src/index.js").AcknowledgeCreatorChangeFinalizationPayload;
  RollbackCreatorCheckpoint: import("../../studio-protocol/src/index.js").RollbackCreatorCheckpointPayload;
};

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_PROTOCOL_MESSAGE_BYTES) throw new ProtocolHttpError(413, "Studio protocol message exceeds its byte limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

class ProtocolHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
