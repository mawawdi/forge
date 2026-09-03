import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertPluginToBackendMessage,
  assertBackendToPluginMessage,
  MAX_STUDIO_SEMANTIC_DOCUMENT_BYTES,
  MAX_PROTOCOL_MESSAGE_BYTES,
  type StudioSemanticMessageBoundaryPayload,
  type StudioStreamedSemanticMessage,
  type BackendToPluginMessage,
  type PairingResponse,
  type PluginProjectIdentity,
  type PluginToBackendMessage,
  type StudioCapability,
  type StudioProjectIdentityOperation,
  type StudioProjectIdentityRejectionEvidence,
  type StudioProjectIdentityState,
  type StudioProjectIdentityTransactionInventory,
  type StudioTransport,
  identityRejectionProvesNoEffect,
} from "../../studio-protocol/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  STUDIO_CONNECTOR_BUILD_HASH,
  createStudioEvidenceProjection,
  deriveStudioProjectIdentityAuthority,
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
  /**
   * Maximum authenticated transport silence before a session reservation is
   * released. Durable Studio transaction cursors live in the plugin and are
   * deliberately unaffected by transport expiry.
   */
  sessionIdleTtlMs?: number;
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

export async function writeStudioBridgeDiscovery(
  discovery: StudioBridgeDiscovery,
  filePath: string = defaultStudioBridgeDiscoveryPath(),
): Promise<void> {
  assertStudioBridgeDiscovery(discovery);
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(discovery, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

export async function readStudioBridgeDiscovery(
  filePath: string = defaultStudioBridgeDiscoveryPath(),
): Promise<StudioBridgeDiscovery> {
  let metadata;
  try {
    metadata = await stat(filePath);
  } catch {
    throw new Error(
      "Forge Studio bridge is not running. Start `node bin/forge.js studio bridge` first.",
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    throw new Error(
      "Forge Studio bridge discovery file permissions are too broad; restart the bridge",
    );
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  assertStudioBridgeDiscovery(value);
  return value;
}

export async function removeStudioBridgeDiscovery(
  bridgeId: string,
  filePath: string = defaultStudioBridgeDiscoveryPath(),
): Promise<void> {
  try {
    const current = await readStudioBridgeDiscovery(filePath);
    if (current.bridgeId === bridgeId) await rm(filePath, { force: true });
  } catch {
    // Missing, malformed, or replaced discovery belongs to no longer-running
    // state and must not make bridge shutdown fail.
  }
}

function assertStudioBridgeDiscovery(value: unknown): asserts value is StudioBridgeDiscovery {
  if (!value || typeof value !== "object")
    throw new Error("Invalid Forge Studio bridge discovery state");
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== "ForgeStudioBridgeDiscovery" ||
    typeof candidate.bridgeId !== "string" ||
    candidate.bridgeId.length < 8 ||
    candidate.host !== "127.0.0.1" ||
    typeof candidate.port !== "number" ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65_535 ||
    typeof candidate.controlToken !== "string" ||
    candidate.controlToken.length < 24 ||
    typeof candidate.pid !== "number" ||
    !Number.isInteger(candidate.pid) ||
    candidate.pid < 1 ||
    typeof candidate.startedAt !== "string"
  )
    throw new Error("Invalid Forge Studio bridge discovery state");
}

export interface StudioBridgeSession {
  sessionId: string;
  projectId: string;
  conversationProjectId: string;
  project: PluginProjectIdentity;
  projectIdentity: StudioProjectIdentityState;
  projectIdentityTransaction: StudioProjectIdentityTransactionInventory;
  capabilities: StudioCapability[];
  manifestHash: string;
  connectorBuildHash: string;
  capabilityAttestationProjectionHash: string;
  sessionToken: string;
  connectedAt: string;
}

type MessageHandler = (
  message: PluginToBackendMessage,
  session: StudioBridgeSession,
) => void | Promise<void>;

interface RetainedOutboundCommand {
  readonly message: BackendToPluginMessage;
  readonly commandHash: string;
}

interface RetainedOutboundMessageIds {
  readonly hashes: Map<string, string>;
  readonly order: string[];
}

interface ReceivedPluginMessage {
  readonly fingerprint: string;
  status: "processing" | "completed";
}

interface ReceivedPluginMessageIds {
  readonly messages: Map<string, ReceivedPluginMessage>;
  readonly order: string[];
}

interface InboundSemanticStream {
  readonly boundary: StudioSemanticMessageBoundaryPayload;
  readonly sessionId: string;
  readonly fragments: string[];
  bytes: number;
  nextSequence: number;
  reconstructed?: StudioStreamedSemanticMessage;
}
type SemanticTransportFrame =
  | Extract<PluginToBackendMessage, { type: "StudioSemanticMessageStarted" }>
  | Extract<PluginToBackendMessage, { type: "StudioSemanticMessageChunk" }>
  | Extract<PluginToBackendMessage, { type: "StudioSemanticMessageCompleted" }>;

type CommandSettlement = Extract<
  PluginToBackendMessage,
  { type: "StudioCommandSettled" }
>["payload"];

interface CommandSettlementWaiter {
  readonly command: BackendToPluginMessage;
  readonly commandHash: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface RetainedCommandSettlements {
  readonly settlements: Map<string, CommandSettlement>;
  readonly order: string[];
}

function identityCommandOperation(
  command: BackendToPluginMessage,
): StudioProjectIdentityOperation | undefined {
  return command.type === "LinkStudioProject" || command.type === "ForkStudioProject"
    ? command.payload.operation
    : undefined;
}

/**
 * A terminal plugin rejection with the exact command and transport receipt
 * that caused it. Identity callers must inspect `identityNoEffectProven`; a
 * rejected command alone never establishes that Studio remained unchanged.
 */
export class StudioCommandRejectedError extends Error {
  readonly command: BackendToPluginMessage;
  readonly settlement: Extract<CommandSettlement, { disposition: "rejected" }>;
  readonly identityNoEffectProven: boolean;

  constructor(
    command: BackendToPluginMessage,
    settlement: Extract<CommandSettlement, { disposition: "rejected" }>,
  ) {
    if (settlement.commandHash !== messageFingerprint(command))
      throw new Error("Studio command rejection does not bind the exact command body");
    super(`Studio command rejected (${settlement.classification}): ${settlement.detail}`);
    this.name = "StudioCommandRejectedError";
    this.command = command;
    this.settlement = settlement;
    const operation = identityCommandOperation(command);
    this.identityNoEffectProven =
      operation !== undefined &&
      identityRejectionProvesNoEffect(operation, settlement.identityRejection);
  }
}

function rejectedCommandError(
  command: BackendToPluginMessage,
  settlement: Extract<CommandSettlement, { disposition: "rejected" }>,
): StudioCommandRejectedError {
  return new StudioCommandRejectedError(command, settlement);
}

export interface StudioBridgeConnection {
  send(message: BackendToPluginMessage): Promise<void>;
  /**
   * Resolves only after the paired plugin has executed this exact hash-bound
   * command, and rejects immediately when the plugin terminally rejects it.
   * Use this for bounded command streams whose next leaf must not enter the
   * bridge before the prior leaf was settled.
   */
  sendAndWaitForSettlement(message: BackendToPluginMessage, timeoutMs: number): Promise<void>;
  subscribeWithSession(handler: MessageHandler): () => void;
  close(): Promise<void>;
}

export class StudioBridgeServer implements StudioTransport {
  private readonly host: string;
  private readonly port: number;
  private readonly pairingTtlMs: number;
  private readonly sessionIdleTtlMs: number;
  private readonly now: () => Date;
  private readonly controlToken: string;
  private readonly maxRetainedEvents: number;
  private readonly server: Server;
  private readonly handlers = new Set<MessageHandler>();
  private readonly sessions = new Map<string, StudioBridgeSession>();
  private readonly sessionLastSeen = new Map<string, number>();
  /** Commands remain until the plugin sends the exact hash-bound settlement. */
  private readonly outbound = new Map<string, RetainedOutboundCommand[]>();
  private readonly outboundMessageIds = new Map<string, RetainedOutboundMessageIds>();
  /** Recently settled commands satisfy a waiter which attached just after delivery. */
  private readonly settledOutbound = new Map<string, RetainedCommandSettlements>();
  private readonly settlementWaiters = new Map<string, Map<string, CommandSettlementWaiter>>();
  /** Inbound messages are only completed after every subscriber succeeds. */
  private readonly receivedMessageIds = new Map<string, ReceivedPluginMessageIds>();
  /** Physical stream frames are never exposed as semantic Studio events. */
  private readonly semanticStreams = new Map<string, InboundSemanticStream>();
  private readonly events = new Map<
    string,
    { baseCursor: number; messages: PluginToBackendMessage[] }
  >();
  private readonly pairings = new Map<string, PairingCode>();
  /** Link/Fork target ids stay reserved until exact final evidence or disconnect. */
  private readonly projectIdentityReservations = new Map<string, string>();

  constructor(options: StudioBridgeOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    if (this.host !== "127.0.0.1")
      throw new Error("Forge Studio bridge supports loopback host 127.0.0.1 only");
    this.port = options.port ?? 8787;
    this.pairingTtlMs = options.pairingTtlMs ?? 10 * 60 * 1000;
    this.sessionIdleTtlMs = options.sessionIdleTtlMs ?? 45_000;
    if (!Number.isSafeInteger(this.sessionIdleTtlMs) || this.sessionIdleTtlMs < 5_000)
      throw new Error("Studio session idle TTL must be an integer of at least five seconds");
    this.now = options.now ?? (() => new Date());
    this.controlToken = options.controlToken ?? randomBytes(24).toString("base64url");
    this.maxRetainedEvents = options.maxRetainedEvents ?? 512;
    this.server = createServer((request, response) => {
      // The Studio connector retries exact envelopes when it cannot observe a
      // response. A dead HTTP peer is therefore a transport outcome, never a
      // reason to let an asynchronous request rejection escape the bridge
      // callback and take down the creator service.
      void this.serveRequest(request, response);
    });
  }

  createPairing(): PairingCode {
    this.pruneExpiredSessions();
    this.prunePairings();
    const expiresAt = new Date(this.now().getTime() + this.pairingTtlMs).toISOString();
    const pairing = { token: randomBytes(18).toString("base64url"), expiresAt };
    this.pairings.set(pairing.token, pairing);
    while (this.pairings.size > 32)
      this.pairings.delete(this.pairings.keys().next().value as string);
    return { ...pairing };
  }

  async listen(): Promise<{
    host: "127.0.0.1";
    port: number;
    controlToken: string;
  }> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    const actualPort = typeof address === "object" && address ? address.port : this.port;
    return {
      host: "127.0.0.1",
      port: actualPort,
      controlToken: this.controlToken,
    };
  }

  async close(): Promise<void> {
    this.rejectSettlementWaiters(new Error("Studio bridge closed before command settlement"));
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
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
    this.pruneExpiredSessions();
    assertBackendToPluginMessage(message);
    const sessionId = message.sessionId;
    if (!sessionId || !this.sessions.has(sessionId))
      throw new Error("Studio session is not connected");
    const queue = this.outbound.get(sessionId) ?? [];
    const commandHash = messageFingerprint(message);
    const knownHash = this.outboundMessageIds.get(sessionId)?.hashes.get(message.messageId);
    if (knownHash !== undefined) {
      if (knownHash !== commandHash)
        throw new Error("Studio outbound command messageId conflicts with a different body");
      return;
    }
    this.assertCommandDeliveryFits(sessionId, message, commandHash);
    if (queue.length >= 128) throw new Error("Studio outbound command queue is full");
    this.assertProjectIdentityCommandMatchesSession(sessionId, message);
    this.assertIdentityOperationReservationAvailable(sessionId, message);
    this.rememberOutbound(sessionId, message.messageId, commandHash);
    queue.push({ message, commandHash });
    this.outbound.set(sessionId, queue);
  }

  async sendAndWaitForSettlement(
    message: BackendToPluginMessage,
    timeoutMs: number,
  ): Promise<void> {
    await this.send(message);
    await this.waitForCommandSettlement(message, timeoutMs);
  }

  getSessions(): StudioBridgeSession[] {
    this.pruneExpiredSessions();
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  private async serveRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Node emits `error` on these EventEmitters independently of the request
    // promise. Retain terminal listeners for the lifetime of the peer so a
    // socket reset cannot become an unhandled EventEmitter error after the
    // route has returned.
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    try {
      await this.handle(request, response);
    } catch {
      // `handle` turns semantic failures into their established HTTP response.
      // This is only a final containment boundary for unexpected failures or a
      // response write racing with peer teardown.
      writeJson(response, 500, {
        kind: "ForgeStudioBridgeError",
        code: "BridgeRequestFailure",
        message: "The local Studio bridge could not complete this request.",
      });
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isRequestActive(request) || !isResponseWritable(response)) return;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    try {
      if (request.method === "GET" && request.url === "/health")
        return writeJson(response, 200, {
          kind: "ForgeStudioBridgeHealth",
          status: "ok",
        });
      if (request.method === "GET" && request.url === "/pairing")
        return this.autoPairing(request, response);
      if (request.method === "GET" && request.url === "/sessions") {
        this.assertControl(request);
        return this.listSessions(response);
      }
      if (request.method === "GET" && request.url?.startsWith("/events")) {
        this.assertControl(request);
        return this.eventsFor(request, response);
      }
      if (request.method === "POST" && request.url === "/command") {
        this.assertControl(request);
        return await this.command(request, response);
      }
      if (request.method === "GET" && request.url?.startsWith("/poll"))
        return this.poll(request, response);
      if (request.method === "POST" && request.url === "/message")
        return await this.receive(request, response);
      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeJson(response, error instanceof ProtocolHttpError ? error.status : 400, {
        kind: "ForgeStudioBridgeError",
        code: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private autoPairing(request: IncomingMessage, response: ServerResponse): void {
    this.assertActivePeer(request, response);
    // Each discovery request gets an independent one-use grant. Multiple open
    // Studio windows must never steal one global pairing slot from each other.
    writeJson(response, 200, {
      kind: "ForgeStudioAutoPairing",
      pairing: this.createPairing(),
    });
  }

  private poll(request: IncomingMessage, response: ServerResponse): void {
    this.pruneExpiredSessions();
    const url = new URL(request.url ?? "/", "http://forge.local");
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const sessionToken = request.headers["x-forge-session-token"];
    const session = this.sessions.get(sessionId);
    if (!session || typeof sessionToken !== "string" || session.sessionToken !== sessionToken)
      throw new ProtocolHttpError(401, "Invalid Studio session");
    this.touchSession(sessionId);
    const command = (this.outbound.get(sessionId) ?? [])[0];
    // Delivery is intentionally non-destructive. A poll carries at most one
    // command, so the plugin settles its exact body before the next
    // queued command can be delivered. This is also the bridge's response-byte
    // bound; enqueue rejects an individual command that cannot fit this page.
    writeJson(response, 200, this.commandDelivery(sessionId, command));
  }

  private listSessions(response: ServerResponse): void {
    writeJson(response, 200, {
      kind: "ForgeStudioSessions",
      sessions: this.getSessions().map(({ sessionToken: _sessionToken, ...session }) => ({
        ...session,
        baseCursor: this.eventBaseCursor(session.sessionId),
        eventCursor: this.eventCursor(session.sessionId),
      })),
    });
  }

  private eventsFor(request: IncomingMessage, response: ServerResponse): void {
    this.pruneExpiredSessions();
    const url = new URL(request.url ?? "/", "http://forge.local");
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const after = Number(url.searchParams.get("after") ?? "0");
    if (!this.sessions.has(sessionId) || !Number.isInteger(after) || after < 0)
      throw new ProtocolHttpError(400, "Invalid Studio event cursor");
    const retained = this.events.get(sessionId) ?? {
      baseCursor: 0,
      messages: [],
    };
    if (after < retained.baseCursor)
      throw new ProtocolHttpError(
        409,
        "Studio event cursor expired; restart verification from a fresh paired session",
      );
    const offset = after - retained.baseCursor;
    const messages = retained.messages.slice(offset, offset + 128);
    writeJson(response, 200, {
      kind: "ForgeStudioEvents",
      sessionId,
      cursor: after + messages.length,
      messages,
    });
  }

  private async command(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.pruneExpiredSessions();
    const message = JSON.parse(await readBody(request)) as unknown;
    this.assertActivePeer(request, response);
    assertBackendToPluginMessage(message);
    const sessionId = message.sessionId;
    if (!sessionId || !this.sessions.has(sessionId))
      throw new ProtocolHttpError(401, "Studio session is not connected");
    const commandHash = messageFingerprint(message);
    const knownHash = this.outboundMessageIds.get(sessionId)?.hashes.get(message.messageId);
    if (knownHash !== undefined) {
      if (knownHash !== commandHash)
        throw new ProtocolHttpError(
          409,
          "Studio command messageId conflicts with a different body",
        );
      writeJson(response, 202, {
        kind: "ForgeStudioCommandAccepted",
        messageId: message.messageId,
        duplicate: true,
      });
      return;
    }
    this.assertCommandDeliveryFits(sessionId, message, commandHash);
    const queue = this.outbound.get(sessionId) ?? [];
    if (queue.length >= 128)
      throw new ProtocolHttpError(429, "Studio outbound command queue is full");
    this.assertProjectIdentityCommandMatchesSession(sessionId, message);
    this.assertIdentityOperationReservationAvailable(sessionId, message);
    this.rememberOutbound(sessionId, message.messageId, commandHash);
    queue.push({ message, commandHash });
    this.outbound.set(sessionId, queue);
    writeJson(response, 202, {
      kind: "ForgeStudioCommandAccepted",
      messageId: message.messageId,
    });
  }

  private async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const message = JSON.parse(await readBody(request)) as unknown;
    this.assertActivePeer(request, response);
    assertPluginToBackendMessage(message);
    if (message.type === "PairProject") return await this.pair(message, response);
    this.pruneExpiredSessions();
    const session = message.sessionId ? this.sessions.get(message.sessionId) : undefined;
    if (!session) throw new ProtocolHttpError(401, "Studio message requires a connected session");
    const sessionToken = request.headers["x-forge-session-token"];
    if (typeof sessionToken !== "string" || sessionToken !== session.sessionToken)
      throw new ProtocolHttpError(401, "Invalid Studio session token");
    if (isStreamedSemanticType(message.type))
      throw new ProtocolHttpError(
        400,
        "Studio semantic evidence must use the bounded start/chunk/complete transport",
      );
    if (message.type === "Heartbeat") this.assertHeartbeatProjectTransition(message, session);
    if (
      message.type === "StudioProjectIdentityFinalized" &&
      !sameProjectIdentity(message.payload.receipt.operation.project, session.project)
    )
      throw new ProtocolHttpError(
        409,
        "Studio project identity receipt belongs to another project",
      );
    this.touchSession(session.sessionId);
    if (message.type === "UnpairProject") {
      await Promise.all([...this.handlers].map((handler) => handler(message, session)));
      this.dropSession(session.sessionId);
      writeJson(response, 202, {
        kind: "ForgeStudioMessageAccepted",
        messageId: message.messageId,
      });
      return;
    }
    const fingerprint = messageFingerprint(message);
    const received = this.receivedMessageIds.get(session.sessionId) ?? {
      messages: new Map<string, ReceivedPluginMessage>(),
      order: [],
    };
    const existing = received.messages.get(message.messageId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint)
        throw new ProtocolHttpError(409, "Studio messageId conflicts with a different body");
      if (existing.status === "processing")
        throw new ProtocolHttpError(409, "Studio message is still processing");
      writeJson(response, 202, {
        kind: "ForgeStudioMessageAccepted",
        messageId: message.messageId,
        duplicate: true,
      });
      return;
    }
    // Keep completed replay fingerprints bounded below the hard concurrent
    // processing ceiling. Without this pre-admission prune, a session that had
    // successfully delivered exactly `2 * maxRetainedEvents` messages became
    // permanently unable to accept another message.
    this.pruneReceived(session.sessionId, received);
    if (received.messages.size >= this.maxRetainedEvents * 2)
      throw new ProtocolHttpError(429, "Studio inbound message receipt cache is full");
    received.messages.set(message.messageId, {
      fingerprint,
      status: "processing",
    });
    received.order.push(message.messageId);
    this.receivedMessageIds.set(session.sessionId, received);
    try {
      if (message.type === "StudioCommandSettled") {
        const settlement = this.settleCommand(session, message);
        // Command settlements are transport receipts, but they are also
        // needed by a remote StudioBridgeClient to implement the same delivery
        // guarantee as the in-process server connection. They deliberately do
        // not enter semantic subscribers: a subscriber failure must never turn
        // an already-recorded terminal transport outcome into an HTTP failure.
        this.retainEvent(session.sessionId, message);
        received.messages.get(message.messageId)!.status = "completed";
        this.pruneReceived(session.sessionId, received);
        writeJson(response, 202, {
          kind: "ForgeStudioCommandSettled",
          commandMessageId: message.payload.commandMessageId,
          disposition: message.payload.disposition,
          ...(settlement.duplicate ? { duplicate: true } : {}),
        });
        return;
      }
      if (isSemanticTransportFrame(message)) {
        const reconstructed = this.acceptSemanticTransportFrame(message, session);
        if (reconstructed) {
          await Promise.all([...this.handlers].map((handler) => handler(reconstructed, session)));
          this.retainEvent(session.sessionId, reconstructed);
          this.semanticStreams.delete(`${session.sessionId}:${message.payload.transferId}`);
        }
      } else {
        // Identity observations are transport authority, not a handler-derived
        // read model. Publish the new authority on the session before semantic
        // subscribers see the receipt, so a successful Link/Fork cannot leave
        // the host issuing commands against the provisional unlinked id.
        this.assertIncomingProjectIdentityAvailable(message, session);
        this.updateSessionProjectIdentity(message, session);
        await Promise.all([...this.handlers].map((handler) => handler(message, session)));
        this.retainEvent(session.sessionId, message);
      }
      received.messages.get(message.messageId)!.status = "completed";
      this.pruneReceived(session.sessionId, received);
      writeJson(response, 202, {
        kind: "ForgeStudioMessageAccepted",
        messageId: message.messageId,
      });
    } catch (error) {
      // A failed handler did not produce an accepted protocol outcome. Forget
      // the in-flight receipt so the same exact envelope may be retried.
      received.messages.delete(message.messageId);
      const index = received.order.lastIndexOf(message.messageId);
      if (index >= 0) received.order.splice(index, 1);
      throw error;
    }
  }

  private updateSessionProjectIdentity(
    message: PluginToBackendMessage,
    session: StudioBridgeSession,
  ): void {
    updateBridgeSessionProjectIdentity(message, session);
    if (
      message.type === "Heartbeat" &&
      message.payload.projectIdentity.reservedAttribute.status === "observed"
    ) {
      const forgeProjectId = message.payload.projectIdentity.reservedAttribute.forgeProjectId;
      if (this.projectIdentityReservations.get(forgeProjectId) === session.sessionId)
        this.projectIdentityReservations.delete(forgeProjectId);
    }
    if (message.type === "StudioProjectIdentityFinalized") {
      const forgeProjectId = message.payload.receipt.operation.assignedForgeProjectId;
      if (this.projectIdentityReservations.get(forgeProjectId) === session.sessionId)
        this.projectIdentityReservations.delete(forgeProjectId);
    }
  }

  private assertHeartbeatProjectTransition(
    message: Extract<PluginToBackendMessage, { type: "Heartbeat" }>,
    session: StudioBridgeSession,
  ): void {
    const prior = session.project;
    const next = message.payload.project;
    const samePlatform = prior.placeId === next.placeId && prior.universeId === next.universeId;
    if (samePlatform) return;
    const priorIsLocal = prior.placeId === 0 && prior.universeId === 0;
    const nextIsPublished = next.placeId > 0 && next.universeId > 0;
    const beforeAttribute = session.projectIdentity.reservedAttribute;
    const afterAttribute = message.payload.projectIdentity.reservedAttribute;
    const preservesEmbeddedIdentity =
      beforeAttribute.status === "observed" &&
      afterAttribute.status === "observed" &&
      beforeAttribute.forgeProjectId === afterAttribute.forgeProjectId;
    if (
      priorIsLocal &&
      nextIsPublished &&
      preservesEmbeddedIdentity &&
      session.projectIdentityTransaction.status === "none"
    )
      return;
    throw new ProtocolHttpError(
      409,
      "Studio heartbeat attempted a project-authority transition outside the paired identity",
    );
  }

  private assertIncomingProjectIdentityAvailable(
    message: PluginToBackendMessage,
    session: StudioBridgeSession,
  ): void {
    const identity =
      message.type === "Heartbeat"
        ? message.payload.projectIdentity
        : message.type === "StudioProjectIdentityFinalized"
          ? message.payload.receipt.afterIdentity
          : undefined;
    const project =
      message.type === "Heartbeat"
        ? message.payload.project
        : message.type === "StudioProjectIdentityFinalized"
          ? message.payload.receipt.afterIdentity.project
          : undefined;
    if (!identity || !project || !hasDurableProjectIdentity(project, identity)) return;
    const key = studioProjectKey(project, identity);
    for (const existing of this.sessions.values()) {
      if (
        existing.sessionId !== session.sessionId &&
        hasDurableProjectIdentity(existing.project, existing.projectIdentity) &&
        studioProjectKey(existing.project, existing.projectIdentity) === key
      )
        throw new ProtocolHttpError(
          409,
          "This durable Studio project identity is already connected; close the other place or explicitly fork it",
        );
    }
  }

  private assertProjectIdentityCommandMatchesSession(
    sessionId: string,
    message: BackendToPluginMessage,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProtocolHttpError(401, "Studio session is not connected");
    if (message.type === "LinkStudioProject" || message.type === "ForkStudioProject") {
      const operation = message.payload.operation;
      const expectedConnectorEpoch = deriveStudioProjectIdentityAuthority({
        sessionId: session.sessionId,
        connectorBuildHash: session.connectorBuildHash,
        identity: session.projectIdentity,
      }).connectorEpoch;
      if (
        !sameProjectIdentity(operation.project, session.project) ||
        operation.expectedIdentity.hash !== session.projectIdentity.hash ||
        operation.connectorEpoch !== expectedConnectorEpoch
      )
        throw new ProtocolHttpError(
          409,
          "Studio project identity command does not continue the paired authority",
        );
      return;
    }
    if (message.type === "AbandonOpeningStudioProjectIdentity") {
      const inventory = session.projectIdentityTransaction;
      const payload = message.payload;
      if (
        inventory.status !== "pending" ||
        inventory.operation.id !== payload.operationId ||
        inventory.operation.hash !== payload.operationHash ||
        inventory.cursorHash !== payload.transactionCursorHash ||
        payload.expectedIdentityStateHash !== session.projectIdentity.hash
      )
        throw new ProtocolHttpError(
          409,
          "Project identity recovery command does not match the exact paired cursor",
        );
      if (inventory.phase !== "opening" || inventory.recordingState !== "not_open")
        throw new ProtocolHttpError(
          409,
          "Opening project identity abandonment lacks exact no-recording proof",
        );
      return;
    }
    if (
      message.type === "CancelInterruptedStudioProjectIdentity" ||
      message.type === "SettleClosedStudioProjectIdentity"
    ) {
      const inventory = session.projectIdentityTransaction;
      const payload = message.payload;
      if (
        inventory.status !== "pending" ||
        inventory.operation.id !== payload.operationId ||
        inventory.operation.hash !== payload.operationHash ||
        inventory.cursorHash !== payload.transactionCursorHash ||
        inventory.recordingId !== payload.recordingId ||
        payload.expectedIdentityStateHash !== session.projectIdentity.hash
      )
        throw new ProtocolHttpError(
          409,
          "Project identity recovery command does not match the exact paired cursor",
        );
      if (message.type === "SettleClosedStudioProjectIdentity") {
        if (
          inventory.phase !== "finalizing" ||
          inventory.recordingState !== "not_open" ||
          inventory.finalization !== message.payload.expectedFinalization
        )
          throw new ProtocolHttpError(
            409,
            "Closed project identity settlement does not match the exact paired cursor",
          );
      } else if (inventory.phase === "opening" || inventory.recordingState !== "open")
        throw new ProtocolHttpError(
          409,
          "Project identity cancellation does not match the exact paired open cursor",
        );
      return;
    }
    if (message.type === "AcknowledgeStudioProjectIdentityFinalization") {
      const inventory = session.projectIdentityTransaction;
      if (
        inventory.status !== "finalized" ||
        inventory.receipt.id !== message.payload.receiptId ||
        inventory.receipt.hash !== message.payload.receiptHash
      )
        throw new ProtocolHttpError(
          409,
          "Project identity acknowledgement does not match the retained terminal receipt",
        );
    }
  }

  private assertIdentityOperationReservationAvailable(
    sessionId: string,
    message: BackendToPluginMessage,
  ): void {
    if (message.type !== "LinkStudioProject" && message.type !== "ForkStudioProject") return;
    const assigned = message.payload.operation.assignedForgeProjectId;
    const reservedBy = this.projectIdentityReservations.get(assigned);
    if (reservedBy !== undefined)
      throw new ProtocolHttpError(
        409,
        reservedBy === sessionId
          ? "The prior project identity transaction outcome is not yet finalized for this Studio session"
          : "This durable Studio project identity is reserved by another exact transaction",
      );
    if ([...this.projectIdentityReservations.values()].includes(sessionId))
      throw new ProtocolHttpError(
        409,
        "The prior project identity transaction outcome is not yet finalized for this Studio session",
      );
    for (const existing of this.sessions.values()) {
      if (
        existing.sessionId !== sessionId &&
        ((existing.projectIdentity.reservedAttribute.status === "observed" &&
          existing.projectIdentity.reservedAttribute.forgeProjectId === assigned) ||
          (existing.projectIdentityTransaction.status === "pending" &&
            existing.projectIdentityTransaction.operation.assignedForgeProjectId === assigned))
      )
        throw new ProtocolHttpError(
          409,
          "This durable Studio project identity is already connected or reserved by another exact transaction",
        );
    }
    for (const [queuedSessionId, commands] of this.outbound) {
      for (const queued of commands) {
        if (
          (queued.message.type === "LinkStudioProject" ||
            queued.message.type === "ForkStudioProject") &&
          queued.message.payload.operation.assignedForgeProjectId === assigned
        )
          throw new ProtocolHttpError(
            409,
            queuedSessionId === sessionId
              ? "A project identity transaction is already queued for this Studio session"
              : "This durable Studio project identity is reserved by another queued transaction",
          );
      }
    }
    this.projectIdentityReservations.set(assigned, sessionId);
  }

  private async pair(
    message: Extract<PluginToBackendMessage, { type: "PairProject" }>,
    response: ServerResponse,
  ): Promise<void> {
    // A grant may have been issued before the prior connector's lease expired.
    // Recheck liveness at admission instead of letting a stale in-memory
    // session indefinitely block the durable project identity.
    this.pruneExpiredSessions();
    this.prunePairings();
    const pairing = this.pairings.get(message.payload.pairingToken);
    if (!pairing)
      throw new ProtocolHttpError(401, "Pairing grant is invalid, expired, or already used");
    this.pairings.delete(pairing.token);
    const sessionId = `studio_${randomUUID()}`;
    const sessionToken = randomBytes(24).toString("base64url");
    const authority = deriveStudioProjectIdentityAuthority({
      sessionId,
      connectorBuildHash: STUDIO_CONNECTOR_BUILD_HASH,
      identity: message.payload.projectIdentity,
    });
    const { projectId, conversationProjectId } = authority;
    if (message.payload.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH)
      throw new ProtocolHttpError(
        409,
        "Studio connector manifest is incompatible with this Forge build",
      );
    if (message.payload.connectorBuildHash !== STUDIO_CONNECTOR_BUILD_HASH)
      throw new ProtocolHttpError(
        409,
        "Studio connector protocol is incompatible with this Forge build",
      );
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
    const session: StudioBridgeSession = {
      sessionId,
      projectId,
      conversationProjectId,
      project: message.payload.project,
      projectIdentity: message.payload.projectIdentity,
      projectIdentityTransaction: message.payload.projectIdentityTransaction,
      capabilities: [...message.payload.capabilities],
      manifestHash: message.payload.manifestHash,
      connectorBuildHash: STUDIO_CONNECTOR_BUILD_HASH,
      capabilityAttestationProjectionHash: capabilityAttestationProjection.contentHash,
      sessionToken,
      connectedAt: this.now().toISOString(),
    };
    for (const existing of this.sessions.values()) {
      if (
        hasDurableProjectIdentity(session.project, session.projectIdentity) &&
        studioProjectKey(existing.project, existing.projectIdentity) ===
          studioProjectKey(session.project, session.projectIdentity)
      )
        throw new ProtocolHttpError(
          409,
          "This durable Studio project identity is already connected; close the other place or explicitly fork it",
        );
    }
    if (message.payload.projectIdentity.reservedAttribute.status === "observed") {
      const forgeProjectId = message.payload.projectIdentity.reservedAttribute.forgeProjectId;
      if (this.projectIdentityReservations.has(forgeProjectId))
        throw new ProtocolHttpError(
          409,
          "This durable Studio project identity is reserved by another exact transaction",
        );
      for (const existing of this.sessions.values()) {
        if (
          existing.projectIdentityTransaction.status === "pending" &&
          existing.projectIdentityTransaction.operation.assignedForgeProjectId === forgeProjectId
        )
          throw new ProtocolHttpError(
            409,
            "This durable Studio project identity is reserved by another exact transaction",
          );
      }
    }
    if (message.payload.projectIdentityTransaction.status === "pending") {
      const assigned = message.payload.projectIdentityTransaction.operation.assignedForgeProjectId;
      const reservedBy = this.projectIdentityReservations.get(assigned);
      if (reservedBy !== undefined)
        throw new ProtocolHttpError(
          409,
          "This durable Studio project identity is reserved by another exact transaction",
        );
      for (const existing of this.sessions.values()) {
        if (
          (existing.projectIdentity.reservedAttribute.status === "observed" &&
            existing.projectIdentity.reservedAttribute.forgeProjectId === assigned) ||
          (existing.projectIdentityTransaction.status === "pending" &&
            existing.projectIdentityTransaction.operation.assignedForgeProjectId === assigned)
        )
          throw new ProtocolHttpError(
            409,
            "This durable Studio project identity is already connected or reserved by another exact transaction",
          );
      }
    }
    this.sessions.set(sessionId, session);
    this.touchSession(sessionId);
    if (message.payload.projectIdentityTransaction.status === "pending")
      this.projectIdentityReservations.set(
        message.payload.projectIdentityTransaction.operation.assignedForgeProjectId,
        sessionId,
      );
    this.outbound.set(sessionId, []);
    this.outboundMessageIds.set(sessionId, { hashes: new Map(), order: [] });
    this.events.set(sessionId, { baseCursor: 0, messages: [] });
    this.receivedMessageIds.set(sessionId, { messages: new Map(), order: [] });
    const capabilityAttestationProjectionJson = serializeStudioEvidenceProjection(
      capabilityAttestationProjection,
    );
    const payload: PairingResponse = {
      sessionId,
      sessionToken,
      projectId,
      conversationProjectId,
      projectIdentity: message.payload.projectIdentity,
      projectIdentityTransaction: message.payload.projectIdentityTransaction,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      connectorBuildHash: STUDIO_CONNECTOR_BUILD_HASH,
      capabilityAttestationProjectionJson,
      capabilityAttestationProjectionJsonHash: createHash("sha256")
        .update(capabilityAttestationProjectionJson)
        .digest("hex"),
      capabilityAttestationProjectionHash: capabilityAttestationProjection.contentHash,
      expiresAt: new Date(this.now().getTime() + this.pairingTtlMs).toISOString(),
    };
    // Pairing has exactly one synchronous response path. Complete host
    // enrollment before advertising success; otherwise an async handler error
    // would leave a ghost session and attempt to write a second HTTP response.
    // A failed enrollment consumes this one-time grant and the plugin obtains a
    // fresh grant for its next bounded attempt.
    try {
      await Promise.all([...this.handlers].map((handler) => handler(message, session)));
    } catch (error) {
      this.dropSession(sessionId);
      throw error;
    }
    writeJson(response, 200, { kind: "ForgeStudioPairAccepted", ...payload });
  }

  private dropSession(sessionId: string): void {
    this.rejectSessionSettlementWaiters(
      sessionId,
      new Error("Studio session disconnected before command settlement"),
    );
    this.sessions.delete(sessionId);
    this.sessionLastSeen.delete(sessionId);
    this.outbound.delete(sessionId);
    this.outboundMessageIds.delete(sessionId);
    this.settledOutbound.delete(sessionId);
    this.events.delete(sessionId);
    this.receivedMessageIds.delete(sessionId);
    for (const [forgeProjectId, reservedSessionId] of this.projectIdentityReservations)
      if (reservedSessionId === sessionId) this.projectIdentityReservations.delete(forgeProjectId);
    for (const key of this.semanticStreams.keys())
      if (key.startsWith(`${sessionId}:`)) this.semanticStreams.delete(key);
  }

  private eventCursor(sessionId: string): number {
    const retained = this.events.get(sessionId) ?? {
      baseCursor: 0,
      messages: [],
    };
    return retained.baseCursor + retained.messages.length;
  }

  private eventBaseCursor(sessionId: string): number {
    return (this.events.get(sessionId) ?? { baseCursor: 0, messages: [] }).baseCursor;
  }

  private prunePairings(): void {
    const now = this.now().getTime();
    for (const [token, pairing] of this.pairings)
      if (new Date(pairing.expiresAt).getTime() <= now) this.pairings.delete(token);
  }

  private touchSession(sessionId: string): void {
    this.sessionLastSeen.set(sessionId, this.now().getTime());
  }

  private pruneExpiredSessions(): void {
    const now = this.now().getTime();
    for (const [sessionId, lastSeen] of this.sessionLastSeen) {
      const processing = [
        ...(this.receivedMessageIds.get(sessionId)?.messages.values() ?? []),
      ].some((message) => message.status === "processing");
      if (!processing && now - lastSeen >= this.sessionIdleTtlMs) this.dropSession(sessionId);
    }
  }

  private rememberOutbound(sessionId: string, messageId: string, commandHash: string): void {
    const retained = this.outboundMessageIds.get(sessionId) ?? {
      hashes: new Map<string, string>(),
      order: [],
    };
    retained.hashes.set(messageId, commandHash);
    retained.order.push(messageId);
    while (retained.order.length > 256) {
      const expired = retained.order.shift();
      if (expired) retained.hashes.delete(expired);
    }
    this.outboundMessageIds.set(sessionId, retained);
  }

  private commandDelivery(
    sessionId: string,
    command: RetainedOutboundCommand | undefined,
  ): {
    kind: "ForgeStudioCommandDelivery";
    sessionId: string;
    commands: Array<{ commandJson: string; commandHash: string }>;
  } {
    return {
      kind: "ForgeStudioCommandDelivery",
      sessionId,
      commands: command
        ? [
            {
              commandJson: stableJson(command.message),
              commandHash: command.commandHash,
            },
          ]
        : [],
    };
  }

  private assertCommandDeliveryFits(
    sessionId: string,
    message: BackendToPluginMessage,
    commandHash: string,
  ): void {
    const response = this.commandDelivery(sessionId, { message, commandHash });
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_PROTOCOL_MESSAGE_BYTES)
      throw new ProtocolHttpError(
        413,
        "Studio outbound command exceeds the bounded command-delivery response",
      );
  }

  private waitForCommandSettlement(
    message: BackendToPluginMessage,
    timeoutMs: number,
  ): Promise<void> {
    assertBackendToPluginMessage(message);
    const sessionId = message.sessionId;
    if (!sessionId || !this.sessions.has(sessionId))
      return Promise.reject(new Error("Studio session is not connected"));
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new Error("Studio command settlement timeout must be positive"));
    const commandHash = messageFingerprint(message);
    const settled = this.settledOutbound.get(sessionId)?.settlements.get(message.messageId);
    if (settled !== undefined) {
      if (settled.commandHash !== commandHash)
        return Promise.reject(
          new Error("Studio command settlement conflicts with a different command body"),
        );
      return settled.disposition === "executed"
        ? Promise.resolve()
        : Promise.reject(rejectedCommandError(message, settled));
    }
    const waiters = this.settlementWaiters.get(sessionId) ?? new Map();
    const existing = waiters.get(message.messageId);
    if (existing !== undefined) {
      if (existing.commandHash !== commandHash)
        return Promise.reject(
          new Error("Studio command settlement waiter conflicts with a different command body"),
        );
      return Promise.reject(new Error("Studio command settlement is already being awaited"));
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const current = this.settlementWaiters.get(sessionId);
        if (current?.get(message.messageId)?.timeout !== timeout) return;
        current.delete(message.messageId);
        if (current.size === 0) this.settlementWaiters.delete(sessionId);
        reject(new Error("Timed out waiting for exact Studio command settlement"));
      }, timeoutMs);
      waiters.set(message.messageId, { command: message, commandHash, resolve, reject, timeout });
      this.settlementWaiters.set(sessionId, waiters);
    });
  }

  private rememberSettlement(
    sessionId: string,
    messageId: string,
    settlement: CommandSettlement,
  ): boolean {
    const retained = this.settledOutbound.get(sessionId) ?? {
      settlements: new Map<string, CommandSettlement>(),
      order: [],
    };
    const existing = retained.settlements.get(messageId);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(settlement))
        throw new ProtocolHttpError(
          409,
          "Studio command settlement conflicts with a retained command",
        );
      return true;
    }
    retained.settlements.set(messageId, settlement);
    retained.order.push(messageId);
    while (retained.order.length > 256) {
      const expired = retained.order.shift();
      if (expired) retained.settlements.delete(expired);
    }
    this.settledOutbound.set(sessionId, retained);
    const waiter = this.settlementWaiters.get(sessionId)?.get(messageId);
    if (waiter !== undefined) {
      if (waiter.commandHash !== settlement.commandHash) {
        clearTimeout(waiter.timeout);
        this.settlementWaiters.get(sessionId)!.delete(messageId);
        waiter.reject(new Error("Studio command settlement hash conflicts with the waiter"));
      } else {
        clearTimeout(waiter.timeout);
        this.settlementWaiters.get(sessionId)!.delete(messageId);
        if (settlement.disposition === "executed") waiter.resolve();
        else waiter.reject(rejectedCommandError(waiter.command, settlement));
      }
      if (this.settlementWaiters.get(sessionId)?.size === 0)
        this.settlementWaiters.delete(sessionId);
    }
    return false;
  }

  private rejectSettlementWaiters(error: Error): void {
    for (const waiters of this.settlementWaiters.values())
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    this.settlementWaiters.clear();
  }

  private rejectSessionSettlementWaiters(sessionId: string, error: Error): void {
    const waiters = this.settlementWaiters.get(sessionId);
    if (!waiters) return;
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.settlementWaiters.delete(sessionId);
  }

  private settleCommand(
    session: StudioBridgeSession,
    message: Extract<PluginToBackendMessage, { type: "StudioCommandSettled" }>,
  ): { duplicate: boolean } {
    const { commandMessageId, commandHash } = message.payload;
    const knownHash = this.outboundMessageIds.get(session.sessionId)?.hashes.get(commandMessageId);
    if (knownHash === undefined)
      throw new ProtocolHttpError(
        409,
        "Studio command settlement does not name a retained command",
      );
    if (knownHash !== commandHash)
      throw new ProtocolHttpError(
        409,
        "Studio command settlement hash conflicts with the retained command",
      );
    const queue = this.outbound.get(session.sessionId) ?? [];
    const queueHead = queue[0];
    const retained = this.settledOutbound.get(session.sessionId)?.settlements.get(commandMessageId);
    if (retained !== undefined) {
      // A duplicate settlement is a transport retry, not a new identity
      // observation. In particular, it must not release a reservation created
      // by a later command in this session.
      const duplicate = this.rememberSettlement(
        session.sessionId,
        commandMessageId,
        message.payload,
      );
      if (!duplicate)
        throw new ProtocolHttpError(409, "Studio command settlement retention is inconsistent");
      return { duplicate: true };
    }
    if (queueHead?.message.messageId !== commandMessageId || queueHead.commandHash !== commandHash)
      throw new ProtocolHttpError(
        409,
        "Studio command settlement does not name the current delivery head",
      );
    this.acceptRejectedIdentitySettlement(session, queueHead.message, message.payload);
    if (
      message.payload.disposition === "executed" &&
      queueHead?.message.type === "AcknowledgeStudioProjectIdentityFinalization" &&
      session.projectIdentityTransaction.status === "finalized" &&
      queueHead.message.payload.receiptId === session.projectIdentityTransaction.receipt.id &&
      queueHead.message.payload.receiptHash === session.projectIdentityTransaction.receipt.hash
    )
      session.projectIdentityTransaction = { status: "none" };
    const duplicate = this.rememberSettlement(session.sessionId, commandMessageId, message.payload);
    const remaining = queue.filter((command) => command.message.messageId !== commandMessageId);
    this.outbound.set(session.sessionId, remaining);
    return { duplicate };
  }

  /**
   * A Link/Fork handler rejection is terminal only after it captures an exact
   * identity/recovery boundary. This is deliberately evaluated before the
   * transport settlement is retained, so malformed, stale, or generic proof
   * cannot consume the queued command or release any durable-id reservation.
   */
  private acceptRejectedIdentitySettlement(
    session: StudioBridgeSession,
    command: BackendToPluginMessage,
    settlement: CommandSettlement,
  ): void {
    const operation = identityCommandOperation(command);
    if (operation === undefined) {
      if (settlement.disposition === "rejected" && settlement.identityRejection !== undefined)
        throw new ProtocolHttpError(
          409,
          "Only rejected Link/Fork commands may carry project identity rejection evidence",
        );
      return;
    }
    if (settlement.disposition !== "rejected") return;
    const proof = settlement.identityRejection;
    if (proof === undefined)
      throw new ProtocolHttpError(
        409,
        "Rejected Link/Fork command lacks exact project identity rejection evidence",
      );
    this.assertIdentityRejectionBoundToCommand(session, operation, proof);
    if (proof.status === "observed") {
      // Retain the exact Studio inventory for recovery even when it does not
      // prove no effect. It comes from a command-bound observation, not from
      // the rejected disposition.
      session.projectIdentity = proof.identity;
      session.projectIdentityTransaction = proof.transaction;
      applyStudioProjectIdentityAuthority(session, session.project, proof.identity);
    }
    if (
      identityRejectionProvesNoEffect(operation, proof) &&
      this.projectIdentityReservations.get(operation.assignedForgeProjectId) === session.sessionId
    )
      this.projectIdentityReservations.delete(operation.assignedForgeProjectId);
  }

  private assertIdentityRejectionBoundToCommand(
    session: StudioBridgeSession,
    operation: StudioProjectIdentityOperation,
    proof: StudioProjectIdentityRejectionEvidence,
  ): void {
    if (proof.operationId !== operation.id || proof.operationHash !== operation.hash)
      throw new ProtocolHttpError(
        409,
        "Studio project identity rejection evidence does not bind the exact command operation",
      );
    if (
      proof.status === "observed" &&
      (!sameProjectIdentity(proof.identity.project, operation.project) ||
        !sameProjectIdentity(proof.identity.project, session.project))
    )
      throw new ProtocolHttpError(
        409,
        "Studio project identity rejection evidence belongs to another paired project",
      );
  }

  private retainEvent(sessionId: string, message: PluginToBackendMessage): void {
    const retained = this.events.get(sessionId) ?? {
      baseCursor: 0,
      messages: [],
    };
    retained.messages.push(message);
    if (retained.messages.length > this.maxRetainedEvents) {
      const removed = retained.messages.length - this.maxRetainedEvents;
      retained.messages.splice(0, removed);
      retained.baseCursor += removed;
    }
    this.events.set(sessionId, retained);
  }

  private acceptSemanticTransportFrame(
    message: SemanticTransportFrame,
    session: StudioBridgeSession,
  ): StudioStreamedSemanticMessage | undefined {
    const payload = message.payload as
      | StudioSemanticMessageBoundaryPayload
      | Extract<PluginToBackendMessage, { type: "StudioSemanticMessageChunk" }>["payload"];
    const key = `${session.sessionId}:${payload.transferId}`;
    if (message.type === "StudioSemanticMessageStarted") {
      const boundary = message.payload as StudioSemanticMessageBoundaryPayload;
      const activeForSession = [...this.semanticStreams.values()].filter(
        (stream) => stream.sessionId === session.sessionId,
      ).length;
      if (activeForSession >= 8)
        throw new ProtocolHttpError(429, "Too many concurrent Studio semantic streams");
      if (this.semanticStreams.has(key))
        throw new ProtocolHttpError(409, "Studio semantic stream already started");
      this.semanticStreams.set(key, {
        boundary,
        sessionId: session.sessionId,
        fragments: [],
        bytes: 0,
        nextSequence: 0,
      });
      return undefined;
    }
    const pending = this.semanticStreams.get(key);
    if (!pending)
      throw new ProtocolHttpError(409, "Studio semantic stream has no accepted start boundary");
    if (message.requestId !== pending.boundary.semanticRequestId)
      throw new ProtocolHttpError(409, "Studio semantic stream request binding changed");
    if (payload.documentHash !== pending.boundary.documentHash)
      throw new ProtocolHttpError(409, "Studio semantic stream document binding changed");
    if (message.type === "StudioSemanticMessageChunk") {
      const chunk = message.payload as Extract<
        PluginToBackendMessage,
        { type: "StudioSemanticMessageChunk" }
      >["payload"];
      if (pending.reconstructed)
        throw new ProtocolHttpError(409, "Studio semantic stream is already complete");
      if (chunk.sequence !== pending.nextSequence)
        throw new ProtocolHttpError(409, "Studio semantic stream fragment is missing or reordered");
      const fragmentBytes = Buffer.byteLength(chunk.payload, "utf8");
      const nextBytes = pending.bytes + fragmentBytes;
      if (nextBytes > pending.boundary.utf8Bytes || nextBytes > MAX_STUDIO_SEMANTIC_DOCUMENT_BYTES)
        throw new ProtocolHttpError(413, "Studio semantic stream exceeds its exact byte boundary");
      pending.fragments.push(chunk.payload);
      pending.bytes = nextBytes;
      pending.nextSequence += 1;
      return undefined;
    }
    const completion = message.payload as StudioSemanticMessageBoundaryPayload;
    if (stableJson(completion) !== stableJson(pending.boundary))
      throw new ProtocolHttpError(409, "Studio semantic completion boundary changed");
    if (
      pending.nextSequence !== pending.boundary.pieceCount ||
      pending.bytes !== pending.boundary.utf8Bytes
    )
      throw new ProtocolHttpError(409, "Studio semantic stream is incomplete");
    if (pending.reconstructed) return pending.reconstructed;
    const encoded = pending.fragments.join("");
    if (contentHash(encoded) !== pending.boundary.documentHash)
      throw new ProtocolHttpError(409, "Studio semantic document SHA-256 mismatch");
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      throw new ProtocolHttpError(400, "Studio semantic document is not valid JSON");
    }
    assertPluginToBackendMessage(decoded);
    if (
      !isStreamedSemanticType(decoded.type) ||
      decoded.type !== pending.boundary.semanticType ||
      decoded.messageId !== pending.boundary.semanticMessageId ||
      decoded.sessionId !== session.sessionId ||
      decoded.requestId !== pending.boundary.semanticRequestId
    )
      throw new ProtocolHttpError(409, "Studio semantic document boundary mismatch");
    if (
      decoded.type === "StudioEvidenceProduced" &&
      !sameProjectIdentity(decoded.payload.project, session.project)
    )
      throw new ProtocolHttpError(409, "Studio evidence project does not match its paired session");
    pending.reconstructed = decoded;
    return decoded;
  }

  private pruneReceived(sessionId: string, received: ReceivedPluginMessageIds): void {
    // Retain a full event window of completed fingerprints for replay/conflict
    // detection while leaving a second bounded window for concurrently
    // processing HTTP requests. A slow oldest request must not prevent pruning
    // later completed entries and deadlock the session at its hard ceiling.
    while (received.order.length > this.maxRetainedEvents) {
      const completedIndex = received.order.findIndex(
        (messageId) => received.messages.get(messageId)?.status === "completed",
      );
      if (completedIndex < 0) break;
      const [candidate] = received.order.splice(completedIndex, 1);
      if (candidate) received.messages.delete(candidate);
    }
    this.receivedMessageIds.set(sessionId, received);
  }

  private assertControl(request: IncomingMessage): void {
    const token = request.headers["x-forge-control-token"];
    if (typeof token !== "string" || token !== this.controlToken)
      throw new ProtocolHttpError(401, "Invalid Forge bridge control token");
  }

  private assertActivePeer(request: IncomingMessage, response: ServerResponse): void {
    if (!isRequestActive(request) || !isResponseWritable(response))
      throw new PeerDisconnectedError();
  }
}

/**
 * Client for a bridge owned by a separate `forge studio bridge` process.
 * The verifier never owns that server's port or pairing token. The control
 * endpoints are intentionally loopback-only in the supported workflow.
 */
export class StudioBridgeClient implements StudioBridgeConnection {
  private static readonly pollIntervalMs = 150;
  private static readonly maxPollFailureBackoffMs = 5_000;

  private readonly baseUrl: string;
  private readonly handlers = new Set<MessageHandler>();
  private readonly cursors = new Map<string, number>();
  private sessions = new Map<string, StudioBridgeSession>();
  private polling = false;
  private pollPromise: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closed = false;
  /** Aborts every client-owned wait when the verifier releases this connection. */
  private readonly lifetimeAbort = new AbortController();
  private terminalError: Error | undefined;
  private readonly settledCommands = new Map<string, RetainedCommandSettlements>();
  private readonly settlementWaiters = new Map<string, Map<string, CommandSettlementWaiter>>();

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
      this.throwIfTerminal();
      await this.refreshSessions();
      const sessions = [...this.sessions.values()];
      if (sessions.length === 1) return { ...sessions[0]! };
      if (sessions.length > 1) {
        const projects = sessions
          .map((session) => `${session.project.name} (${session.sessionId})`)
          .sort()
          .join(", ");
        throw new Error(
          `Multiple Studio projects are connected: ${projects}. Disconnect or close the unrelated Studio windows, then retry verification.`,
        );
      }
      await delay(250, this.lifetimeAbort.signal);
    }
    throw new Error(
      "No paired Studio session found on the existing Forge bridge. Pair the plugin, then retry.",
    );
  }

  subscribeWithSession(handler: MessageHandler): () => void {
    this.throwIfTerminal();
    this.handlers.add(handler);
    this.startPolling();
    return () => this.handlers.delete(handler);
  }

  async send(message: BackendToPluginMessage): Promise<void> {
    this.throwIfTerminal();
    assertBackendToPluginMessage(message);
    const response = await fetch(`${this.baseUrl}/command`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-control-token": this.controlToken,
      },
      body: JSON.stringify(message),
      signal: this.requestSignal(20_000),
    });
    if (!response.ok)
      throw new Error(`Forge bridge command failed: ${response.status} ${await response.text()}`);
  }

  async sendAndWaitForSettlement(
    message: BackendToPluginMessage,
    timeoutMs: number,
  ): Promise<void> {
    this.throwIfTerminal();
    this.startPolling();
    await this.send(message);
    await this.waitForCommandSettlement(message, timeoutMs);
  }

  getSessions(): StudioBridgeSession[] {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  /** A retained event cursor expired and requires a fresh paired session. */
  getFailure(): Error | undefined {
    return this.terminalError;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.polling = false;
    this.lifetimeAbort.abort();
    this.closePromise = (async () => {
      await this.pollPromise;
      this.rejectSettlementWaiters(
        new Error("Studio bridge client closed before command settlement"),
      );
      this.handlers.clear();
      this.cursors.clear();
      this.sessions.clear();
    })();
    return this.closePromise;
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.pollPromise = this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    let nextFailureDelayMs = StudioBridgeClient.pollIntervalMs;
    while (this.polling) {
      let delayMs = StudioBridgeClient.pollIntervalMs;
      try {
        await this.refreshSessions();
        for (const session of this.sessions.values()) await this.readEvents(session);
        // A complete refresh/event cycle resets the outage backoff. Only a
        // fully successful cycle proves the control channel has recovered.
        nextFailureDelayMs = StudioBridgeClient.pollIntervalMs;
      } catch {
        if (this.terminalError) return;
        if (this.closed || this.lifetimeAbort.signal.aborted) return;
        // The verifier's bounded wait reports a useful failure. Transient
        // bridge outages are retried without inventing a Studio result. A
        // capped exponential delay prevents a disconnected bridge from
        // consuming a core or flooding its loopback server.
        delayMs = nextFailureDelayMs;
        nextFailureDelayMs = Math.min(
          StudioBridgeClient.maxPollFailureBackoffMs,
          nextFailureDelayMs * 2,
        );
      }
      if (!this.polling) return;
      try {
        await delay(delayMs, this.lifetimeAbort.signal);
      } catch {
        // Closing is an ordinary lifecycle transition, not a transport
        // failure. It must release a fetch or delay immediately.
        if (this.closed || this.lifetimeAbort.signal.aborted) return;
        throw new Error("Studio bridge poll delay was interrupted unexpectedly");
      }
    }
  }

  private async refreshSessions(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sessions`, {
      headers: { "x-forge-control-token": this.controlToken },
      signal: this.requestSignal(5_000),
    });
    if (!response.ok) throw new Error(`Forge bridge is unavailable (${response.status})`);
    const body = (await response.json()) as {
      sessions?: Array<StudioBridgeSession & { baseCursor: number; eventCursor: number }>;
    };
    if (!Array.isArray(body.sessions))
      throw new Error("Forge bridge returned an invalid session list");
    const next = new Map(
      body.sessions.map(({ baseCursor, eventCursor, ...session }) => {
        if (
          !Number.isInteger(baseCursor) ||
          baseCursor < 0 ||
          !Number.isInteger(eventCursor) ||
          eventCursor < baseCursor
        )
          throw new Error("Forge bridge returned invalid retained event cursors");
        // A client beginning at high-water would silently skip retained
        // attestation/inventory events created before its discovery request.
        if (!this.sessions.has(session.sessionId)) this.cursors.set(session.sessionId, baseCursor);
        return [session.sessionId, { ...session, sessionToken: "" }] as const;
      }),
    );
    for (const sessionId of this.sessions.keys()) {
      if (next.has(sessionId)) continue;
      this.rejectSessionSettlementWaiters(
        sessionId,
        new Error("Studio session disconnected before command settlement"),
      );
      this.settledCommands.delete(sessionId);
      this.cursors.delete(sessionId);
    }
    this.sessions = next;
  }

  private async readEvents(session: StudioBridgeSession): Promise<void> {
    const after = this.cursors.get(session.sessionId) ?? 0;
    const response = await fetch(
      `${this.baseUrl}/events?sessionId=${encodeURIComponent(session.sessionId)}&after=${after}`,
      {
        headers: { "x-forge-control-token": this.controlToken },
        signal: this.requestSignal(5_000),
      },
    );
    if (!response.ok) {
      if (response.status === 409) {
        this.terminalError = new Error(
          "Forge bridge event cursor expired; restart verification from a fresh paired session",
        );
        this.polling = false;
        throw this.terminalError;
      }
      throw new Error(`Forge bridge event stream failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      cursor?: number;
      messages?: unknown[];
    };
    if (
      typeof body.cursor !== "number" ||
      !Number.isInteger(body.cursor) ||
      !Array.isArray(body.messages)
    )
      return;
    for (const value of body.messages) {
      assertPluginToBackendMessage(value);
      if (value.type === "StudioCommandSettled") {
        this.acceptCommandSettlement(value);
      } else {
        await this.dispatch(value, session);
      }
    }
    // Cursor commit is after handler dispatch, so a failure replays the whole
    // retained batch instead of silently discarding a protocol event.
    this.cursors.set(session.sessionId, body.cursor);
  }

  private async dispatch(
    message: PluginToBackendMessage,
    session: StudioBridgeSession,
  ): Promise<void> {
    updateBridgeSessionProjectIdentity(message, session);
    await Promise.all([...this.handlers].map((handler) => handler(message, session)));
  }

  private waitForCommandSettlement(
    message: BackendToPluginMessage,
    timeoutMs: number,
  ): Promise<void> {
    assertBackendToPluginMessage(message);
    const sessionId = message.sessionId;
    if (!sessionId)
      return Promise.reject(new Error("Studio command settlement requires a session"));
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new Error("Studio command settlement timeout must be positive"));
    const commandHash = messageFingerprint(message);
    const settled = this.settledCommands.get(sessionId)?.settlements.get(message.messageId);
    if (settled !== undefined) {
      if (settled.commandHash !== commandHash)
        return Promise.reject(
          new Error("Studio command settlement conflicts with a different command body"),
        );
      return settled.disposition === "executed"
        ? Promise.resolve()
        : Promise.reject(rejectedCommandError(message, settled));
    }
    const waiters = this.settlementWaiters.get(sessionId) ?? new Map();
    const existing = waiters.get(message.messageId);
    if (existing !== undefined) {
      if (existing.commandHash !== commandHash)
        return Promise.reject(
          new Error("Studio command settlement waiter conflicts with a different command body"),
        );
      return Promise.reject(new Error("Studio command settlement is already being awaited"));
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const current = this.settlementWaiters.get(sessionId);
        if (current?.get(message.messageId)?.timeout !== timeout) return;
        current.delete(message.messageId);
        if (current.size === 0) this.settlementWaiters.delete(sessionId);
        reject(new Error("Timed out waiting for exact Studio command settlement"));
      }, timeoutMs);
      waiters.set(message.messageId, { command: message, commandHash, resolve, reject, timeout });
      this.settlementWaiters.set(sessionId, waiters);
    });
  }

  private acceptCommandSettlement(
    message: Extract<PluginToBackendMessage, { type: "StudioCommandSettled" }>,
  ): void {
    const sessionId = message.sessionId;
    if (!sessionId) throw new Error("Studio command settlement requires a session");
    const { commandMessageId, commandHash } = message.payload;
    const retained = this.settledCommands.get(sessionId) ?? {
      settlements: new Map<string, CommandSettlement>(),
      order: [],
    };
    const existing = retained.settlements.get(commandMessageId);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(message.payload))
        throw new Error("Studio command settlement conflicts with a retained command");
      return;
    }
    retained.settlements.set(commandMessageId, message.payload);
    retained.order.push(commandMessageId);
    while (retained.order.length > 256) {
      const expired = retained.order.shift();
      if (expired) retained.settlements.delete(expired);
    }
    this.settledCommands.set(sessionId, retained);
    const waiters = this.settlementWaiters.get(sessionId);
    const waiter = waiters?.get(commandMessageId);
    if (waiter === undefined) return;
    clearTimeout(waiter.timeout);
    waiters!.delete(commandMessageId);
    if (waiters!.size === 0) this.settlementWaiters.delete(sessionId);
    if (waiter.commandHash !== commandHash)
      waiter.reject(new Error("Studio command settlement hash conflicts with the waiter"));
    else if (message.payload.disposition === "executed") waiter.resolve();
    else waiter.reject(rejectedCommandError(waiter.command, message.payload));
  }

  private rejectSettlementWaiters(error: Error): void {
    for (const waiters of this.settlementWaiters.values())
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    this.settlementWaiters.clear();
  }

  private rejectSessionSettlementWaiters(sessionId: string, error: Error): void {
    const waiters = this.settlementWaiters.get(sessionId);
    if (!waiters) return;
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.settlementWaiters.delete(sessionId);
  }

  private throwIfTerminal(): void {
    if (this.closed) throw new Error("Studio bridge client is closed");
    if (this.terminalError) throw this.terminalError;
  }

  private requestSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([this.lifetimeAbort.signal, AbortSignal.timeout(timeoutMs)]);
  }
}

function messageFingerprint(message: BackendToPluginMessage | PluginToBackendMessage): string {
  return contentHash(stableJson(message));
}

function isStreamedSemanticType(
  type: PluginToBackendMessage["type"],
): type is StudioStreamedSemanticMessage["type"] {
  return [
    "StudioEvidenceProduced",
    "CreatorChangePreflighted",
    "CreatorMutationProvisional",
  ].includes(type);
}

function isSemanticTransportFrame(
  message: PluginToBackendMessage,
): message is SemanticTransportFrame {
  return (
    message.type === "StudioSemanticMessageStarted" ||
    message.type === "StudioSemanticMessageChunk" ||
    message.type === "StudioSemanticMessageCompleted"
  );
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = () => finish(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(reason?: unknown): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (reason === undefined) resolve();
      else reject(reason);
    }
  });
}

function studioProjectKey(
  project: PluginProjectIdentity,
  identity: StudioProjectIdentityState,
): string {
  if (project.placeId !== 0 || project.universeId !== 0)
    return `published:${project.universeId}:${project.placeId}`;
  if (identity.reservedAttribute.status === "observed")
    return `linked:${identity.reservedAttribute.forgeProjectId}`;
  return `local-unlinked:${identity.hash}`;
}

function hasDurableProjectIdentity(
  project: PluginProjectIdentity,
  identity: StudioProjectIdentityState,
): boolean {
  return (
    project.placeId !== 0 ||
    project.universeId !== 0 ||
    identity.reservedAttribute.status === "observed"
  );
}

function sameProjectIdentity(left: PluginProjectIdentity, right: PluginProjectIdentity): boolean {
  return (
    left.name === right.name &&
    left.placeId === right.placeId &&
    left.universeId === right.universeId
  );
}

function updateBridgeSessionProjectIdentity(
  message: PluginToBackendMessage,
  session: StudioBridgeSession,
): void {
  if (message.type === "Heartbeat") {
    // The authenticated heartbeat may update display metadata, or carry the
    // one authority-preserving local-linked -> published transition admitted
    // above. Adopt the exact observed project before deriving host authority.
    applyStudioProjectIdentityAuthority(
      session,
      message.payload.project,
      message.payload.projectIdentity,
    );
    return;
  }
  if (message.type !== "StudioProjectIdentityFinalized") return;
  const receipt = message.payload.receipt;
  session.projectIdentityTransaction = { status: "finalized", receipt };
  if (
    session.projectIdentity.hash !== receipt.beforeIdentity.hash &&
    session.projectIdentity.hash !== receipt.afterIdentity.hash
  )
    throw new ProtocolHttpError(
      409,
      "Studio project identity receipt does not continue the paired identity state",
    );
  applyStudioProjectIdentityAuthority(session, session.project, receipt.afterIdentity);
}

function applyStudioProjectIdentityAuthority(
  session: StudioBridgeSession,
  project: PluginProjectIdentity,
  identity: StudioProjectIdentityState,
): void {
  if (!sameProjectIdentity(project, identity.project))
    throw new ProtocolHttpError(409, "Studio project identity does not match the paired project");
  const authority = deriveStudioProjectIdentityAuthority({
    sessionId: session.sessionId,
    connectorBuildHash: session.connectorBuildHash,
    identity,
  });
  session.project = project;
  session.projectIdentity = identity;
  session.projectId = authority.projectId;
  session.conversationProjectId = authority.conversationProjectId;
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
        key: studioEvidenceFactKey(
          "reflection",
          target,
          `${classDefinition.name}.${property.name}`,
        ),
        kind: "reflection" as const,
        target,
      })),
    ),
    scope: { roots: [] },
    bounds: {
      maximumFacts: STUDIO_CAPABILITY_MANIFEST.limits.maximumProjectionFacts,
      maximumBytes: STUDIO_CAPABILITY_MANIFEST.limits.maximumProjectionBytes,
      roots: [],
    },
  });
}

export function createBackendMessage<T extends keyof BackendPayloadByType>(
  type: T,
  payload: BackendPayloadByType[T],
  sessionId: string,
  requestId?: string,
  now: () => Date = () => new Date(),
): BackendToPluginMessage {
  const message = {
    kind: "StudioProtocolMessage",
    direction: "backend_to_plugin",
    type,
    messageId: `msg_${randomUUID()}`,
    ...(requestId ? { requestId } : {}),
    sessionId,
    sentAt: now().toISOString(),
    payload,
  } as BackendToPluginMessage;
  assertBackendToPluginMessage(message);
  return message;
}

export type BackendPayloadByType = {
  CollectStudioProjectIndex: import("../../studio-protocol/src/index.js").CollectStudioProjectIndexPayload;
  CreatorSourceWriteBlobStarted: import("../../studio-protocol/src/index.js").CreatorSourceWriteBlobStartedPayload;
  CreatorSourceWriteBlobChunk: import("../../studio-protocol/src/index.js").CreatorSourceWriteBlobChunkPayload;
  CreatorSourceWriteBlobCompleted: import("../../studio-protocol/src/index.js").CreatorSourceWriteBlobCompletedPayload;
  RequestStudioEvidence: import("../../studio-protocol/src/index.js").RequestStudioEvidencePayload;
  ExecuteRuntimeEvalPlan: import("../../studio-protocol/src/index.js").ExecuteRuntimeEvalPlanPayload;
  FinalizePassiveRuntimeEval: import("../../studio-protocol/src/index.js").FinalizePassiveRuntimeEvalPayload;
  CreatorChangePrepareStarted: import("../../studio-protocol/src/index.js").CreatorChangePrepareStartedPayload;
  CreatorChangePrepareChunk: import("../../studio-protocol/src/index.js").CreatorChangePrepareChunkPayload;
  CreatorChangePrepareCompleted: import("../../studio-protocol/src/index.js").CreatorChangePrepareCompletedPayload;
  PreflightCreatorChangeSet: import("../../studio-protocol/src/index.js").PreflightCreatorChangeSetPayload;
  ApplyCreatorChangeSet: import("../../studio-protocol/src/index.js").ApplyCreatorChangeSetPayload;
  FinalizeCreatorChangeSet: import("../../studio-protocol/src/index.js").FinalizeCreatorChangeSetPayload;
  RequestCreatorRecordingRecovery: import("../../studio-protocol/src/index.js").RequestCreatorRecordingRecoveryPayload;
  AcknowledgeClosedCreatorRecording: import("../../studio-protocol/src/index.js").AcknowledgeClosedCreatorRecordingPayload;
  CancelInterruptedRecording: import("../../studio-protocol/src/index.js").CancelInterruptedRecordingPayload;
  AcknowledgeCreatorChangeFinalization: import("../../studio-protocol/src/index.js").AcknowledgeCreatorChangeFinalizationPayload;
  RollbackCreatorCheckpoint: import("../../studio-protocol/src/index.js").RollbackCreatorCheckpointPayload;
  LinkStudioProject: import("../../studio-protocol/src/index.js").StudioProjectIdentityCommandPayload;
  ForkStudioProject: import("../../studio-protocol/src/index.js").StudioProjectIdentityCommandPayload;
  AbandonOpeningStudioProjectIdentity: import("../../studio-protocol/src/index.js").AbandonOpeningStudioProjectIdentityPayload;
  CancelInterruptedStudioProjectIdentity: import("../../studio-protocol/src/index.js").CancelInterruptedStudioProjectIdentityPayload;
  SettleClosedStudioProjectIdentity: import("../../studio-protocol/src/index.js").SettleClosedStudioProjectIdentityPayload;
  AcknowledgeStudioProjectIdentityFinalization: import("../../studio-protocol/src/index.js").AcknowledgeStudioProjectIdentityFinalizationPayload;
};

async function readBody(request: IncomingMessage): Promise<string> {
  if (!isRequestActive(request)) throw new PeerDisconnectedError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!isRequestActive(request)) throw new PeerDisconnectedError();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_PROTOCOL_MESSAGE_BYTES)
      throw new ProtocolHttpError(413, "Studio protocol message exceeds its byte limit");
    chunks.push(buffer);
  }
  if (!isRequestActive(request)) throw new PeerDisconnectedError();
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (!isResponseWritable(response)) return;
  try {
    const body = JSON.stringify(value);
    if (!isResponseWritable(response)) return;
    response.statusCode = status;
    response.end(body);
  } catch {
    safeEnd(response);
  }
}

function safeEnd(response: ServerResponse): void {
  if (!isResponseWritable(response)) return;
  try {
    response.end();
  } catch {
    // A response that failed while closing has no recovery action.
  }
}

function isResponseWritable(response: ServerResponse): boolean {
  return !response.destroyed && !response.writableEnded;
}

function isRequestActive(request: IncomingMessage): boolean {
  // Node marks a fully consumed IncomingMessage as `destroyed` before the
  // route sends its response. `aborted` is the terminal signal that means its
  // body was not completely delivered, so it is the only safe rejection test
  // at an HTTP request boundary.
  return !request.aborted;
}

class ProtocolHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A peer closed before its bounded envelope was accepted. */
class PeerDisconnectedError extends Error {
  constructor() {
    super("Studio HTTP peer disconnected before request completion");
  }
}
