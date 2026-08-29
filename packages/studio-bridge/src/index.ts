import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { assertPluginToBackendMessage, assertBackendToPluginMessage, type BackendToPluginMessage, type PairAcceptedPayload, type PluginProjectIdentity, type PluginToBackendMessage, type StudioTransport } from "../../studio-protocol/src/index.js";

export interface PairingCode {
  token: string;
  expiresAt: string;
}

export interface StudioBridgeOptions {
  host?: string;
  port?: number;
  pairingTtlMs?: number;
  now?: () => Date;
}

export interface StudioBridgeSession {
  sessionId: string;
  projectId: string;
  project: PluginProjectIdentity;
  pluginVersion: string;
  studioVersion: string;
  sessionToken: string;
  connectedAt: string;
}

type MessageHandler = (message: PluginToBackendMessage, session: StudioBridgeSession) => void | Promise<void>;

export class StudioBridgeServer implements StudioTransport {
  private readonly host: string;
  private readonly port: number;
  private readonly pairingTtlMs: number;
  private readonly now: () => Date;
  private readonly server: Server;
  private readonly handlers = new Set<MessageHandler>();
  private readonly sessions = new Map<string, StudioBridgeSession>();
  private readonly outbound = new Map<string, BackendToPluginMessage[]>();
  private pairing: PairingCode | undefined;

  constructor(options: StudioBridgeOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8787;
    this.pairingTtlMs = options.pairingTtlMs ?? 10 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.server = createServer((request, response) => { void this.handle(request, response); });
  }

  createPairing(): PairingCode {
    const expiresAt = new Date(this.now().getTime() + this.pairingTtlMs).toISOString();
    this.pairing = { token: randomBytes(18).toString("base64url"), expiresAt };
    return { ...this.pairing };
  }

  async listen(): Promise<{ host: string; port: number; pairing: PairingCode }> {
    const pairing = this.createPairing();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    const actualPort = typeof address === "object" && address ? address.port : this.port;
    return { host: this.host, port: actualPort, pairing };
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
    queue.push(message);
    this.outbound.set(sessionId, queue);
  }

  getSessions(): StudioBridgeSession[] { return [...this.sessions.values()].map((session) => ({ ...session })); }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    try {
      if (request.method === "GET" && request.url === "/health") return writeJson(response, 200, { kind: "ForgeStudioBridgeHealth", schemaVersion: 1, status: "ok" });
      if (request.method === "GET" && request.url?.startsWith("/v1/poll")) return this.poll(request, response);
      if (request.method === "POST" && request.url === "/v1/message") return await this.receive(request, response);
      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeJson(response, error instanceof ProtocolHttpError ? error.status : 400, { kind: "ForgeStudioBridgeError", schemaVersion: 1, code: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private poll(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://forge.local");
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const sessionToken = url.searchParams.get("sessionToken") ?? "";
    const session = this.sessions.get(sessionId);
    if (!session || session.sessionToken !== sessionToken) throw new ProtocolHttpError(401, "Invalid Studio session");
    const messages = this.outbound.get(sessionId) ?? [];
    this.outbound.set(sessionId, []);
    writeJson(response, 200, { kind: "ForgeStudioPollResponse", schemaVersion: 1, sessionId, messages });
  }

  private async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const message = JSON.parse(await readBody(request)) as unknown;
    assertPluginToBackendMessage(message);
    if (message.type === "PairProject") return await this.pair(message, response);
    if (message.type === "PluginHello" && !message.sessionId) {
      writeJson(response, 202, { kind: "ForgeStudioMessageAccepted", schemaVersion: 1, messageId: message.messageId });
      return;
    }
    const session = message.sessionId ? this.sessions.get(message.sessionId) : undefined;
    if (!session) throw new ProtocolHttpError(401, "Studio message requires a connected session");
    const sessionToken = request.headers["x-forge-session-token"];
    if (typeof sessionToken !== "string" || sessionToken !== session.sessionToken) throw new ProtocolHttpError(401, "Invalid Studio session token");
    await Promise.all([...this.handlers].map((handler) => handler(message, session)));
    writeJson(response, 202, { kind: "ForgeStudioMessageAccepted", schemaVersion: 1, messageId: message.messageId });
  }

  private async pair(message: Extract<PluginToBackendMessage, { type: "PairProject" }>, response: ServerResponse): Promise<void> {
    if (!this.pairing || this.pairing.token !== message.payload.pairingToken || new Date(this.pairing.expiresAt).getTime() <= this.now().getTime()) throw new ProtocolHttpError(401, "Pairing token is invalid or expired");
    const sessionId = `studio_${randomUUID()}`;
    const sessionToken = randomBytes(24).toString("base64url");
    const projectId = `studio_project_${message.payload.project.placeId}`;
    const session: StudioBridgeSession = { sessionId, projectId, project: message.payload.project, pluginVersion: message.payload.pluginVersion, studioVersion: message.payload.studioVersion, sessionToken, connectedAt: this.now().toISOString() };
    this.sessions.set(sessionId, session);
    this.outbound.set(sessionId, []);
    this.pairing = undefined;
    const payload: PairAcceptedPayload = { sessionId, sessionToken, projectId, expiresAt: new Date(this.now().getTime() + this.pairingTtlMs).toISOString() };
    writeJson(response, 200, { kind: "ForgeStudioPairAccepted", schemaVersion: 1, ...payload });
    const accepted = { kind: "StudioProtocolMessage", schemaVersion: 1, direction: "backend_to_plugin", type: "PairAccepted", messageId: `msg_${randomUUID()}`, sentAt: this.now().toISOString(), sessionId, payload } satisfies BackendToPluginMessage;
    this.outbound.set(sessionId, [accepted]);
    await Promise.all([...this.handlers].map((handler) => handler(message, session)));
  }
}

export function createBackendMessage<T extends keyof BackendPayloadByType>(type: T, payload: BackendPayloadByType[T], sessionId: string, requestId?: string, now: () => Date = () => new Date()): BackendToPluginMessage {
  const message = { kind: "StudioProtocolMessage", schemaVersion: 1, direction: "backend_to_plugin", type, messageId: `msg_${randomUUID()}`, ...(requestId ? { requestId } : {}), sessionId, sentAt: now().toISOString(), payload } as BackendToPluginMessage;
  assertBackendToPluginMessage(message);
  return message;
}

export type BackendPayloadByType = {
  PairProject: { projectId: string; pairingToken: string; expiresAt: string };
  PairAccepted: PairAcceptedPayload;
  PairRejected: { reason: string; retryable: boolean };
  RequestSnapshot: { requestId: string; reason: "pairing" | "pre_patch" | "post_patch" | "manual" };
  ApplyPatchSet: { requestId: string; transactionId: string; expectedSnapshotHash: string; patchSet: import("../../contracts/src/index.js").PatchSet };
  BeginTransaction: { requestId: string; transactionId: string; expectedSnapshotHash: string };
  CommitTransaction: { requestId: string; transactionId: string; expectedSnapshotHash: string };
  RollbackTransaction: { requestId: string; transactionId: string; expectedSnapshotHash: string };
  StartPlaytest: { requestId: string; runId: string; mode: "play" | "run" | "multiplayer"; playerCount: number; args: Record<string, string | number | boolean> };
  StopPlaytest: { requestId: string; runId: string };
  ExecuteAssertionPlan: { requestId: string; runId: string; testPlanId: string; assertions: import("../../contracts/src/index.js").StudioAssertion[]; adversarial: boolean };
  RequestRuntimeState: { requestId: string; runId: string; paths: string[] };
};

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1024 * 1024) throw new ProtocolHttpError(413, "Studio protocol message exceeds 1 MiB");
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
