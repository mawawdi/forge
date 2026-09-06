import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CreatorConversationCoordinator } from "./conversation-coordinator.js";
import {
  ImmutableBinaryArtifactStore,
  assertBinaryArtifactReference,
} from "../../artifact-store/src/index.js";
import { CreatorTurnNotAdmittedError } from "./turn-admission-error.js";
import {
  ROBLOX_API_CATALOG,
  ROBLOX_API_CATALOG_HASH,
  STUDIO_CAPABILITY_COVERAGE_REPORT,
  STUDIO_CAPABILITY_COVERAGE_REPORT_HASH,
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  STUDIO_CONNECTOR_BUILD_HASH,
  getRobloxApiCatalogLookupEntry,
  type RobloxApiCatalogCounts,
  type RobloxApiCatalogLookupEntry,
  type StudioCapabilityDisposition,
  type StudioCapabilityReason,
} from "../../studio-evidence/src/index.js";

/**
 * Closed maximum for a complete UTF-8 creator-control request body.
 *
 * The largest text field the current control contract advertises is 64 KiB.
 * JSON may encode each one-byte control character as a six-byte `\u00XX`
 * escape, so the transport budget must cover escaping and bounded request
 * framing rather than duplicating the field budget. 512 KiB leaves that
 * worst-case 384 KiB representation sufficient room for every bounded ID,
 * hash, and JSON delimiter while remaining a fixed DoS boundary.
 */
const MAX_CREATOR_CONTROL_WIRE_BODY_BYTES = 512 * 1024;
const MAX_SUBSCRIBERS = 32;
const MAX_EVENTS = 256;
const COOKIE_NAME = "forge_creator_session";
const DEFAULT_CAPABILITY_PAGE_SIZE = 40;
const MAX_CAPABILITY_PAGE_SIZE = 100;
const MAX_CAPABILITY_QUERY_LENGTH = 160;
const MAX_CLASS_NAME_LENGTH = 128;

export * from "./conversation-coordinator.js";
export * from "./turn-admission-error.js";
export * from "./store-lease.js";

/**
 * A small, static view of the pinned Roblox catalog and its proof-policy
 * coverage. This intentionally excludes catalog entries; callers must use the
 * paginated explorer below to inspect them.
 */
export interface StudioCatalogSummaryView {
  readonly kind: "StudioCatalogSummary";
  readonly catalog: {
    readonly hash: string;
    readonly source: {
      readonly repository: string;
      readonly commit: string;
      readonly engineReferencePath: string;
      readonly sourceTreeHash: string;
    };
    readonly counts: RobloxApiCatalogCounts;
  };
  readonly coverage: {
    readonly hash: string;
    readonly catalogHash: string;
    readonly policyHash: string;
    readonly manifestHash: string;
    readonly summary: {
      readonly total: number;
      readonly byDisposition: Readonly<Record<StudioCapabilityDisposition, number>>;
      readonly byReason: Readonly<Partial<Record<StudioCapabilityReason, number>>>;
      readonly authorableClasses: number;
      readonly authorableProperties: number;
    };
    readonly catalogBinding: "matched" | "mismatched";
    readonly manifestBinding: "matched" | "mismatched";
  };
  readonly manifest: {
    readonly hash: string;
    readonly connectorBuildHash: string;
    readonly classCount: number;
    readonly writablePropertyCount: number;
    readonly roots: readonly string[];
    readonly operationKinds: readonly string[];
  };
}

export interface StudioCapabilityExplorerEntryView extends RobloxApiCatalogLookupEntry {
  /** The explicit manifest proof route, present only for authorable properties. */
  readonly proofObligations?: readonly string[];
}

export interface StudioCapabilityExplorerPage {
  readonly kind: "StudioCapabilityExplorerPage";
  readonly catalogHash: string;
  readonly coverageHash: string;
  readonly selection: {
    readonly className?: string;
    readonly query?: string;
  };
  readonly page: {
    readonly cursor: number;
    readonly limit: number;
    readonly total: number;
    readonly nextCursor?: number;
  };
  readonly entries: readonly StudioCapabilityExplorerEntryView[];
}

export interface StudioCapabilityExplorerRequest {
  readonly className?: string;
  readonly query?: string;
  readonly cursor?: number;
  readonly limit?: number;
}

export interface CreatorControlDiscovery {
  kind: "ForgeCreatorControlDiscovery";
  controlId: string;
  host: "127.0.0.1";
  port: number;
  bearerToken: string;
  pid: number;
  startedAt: string;
}

export type CreatorControlCoordinator = Pick<
  CreatorConversationCoordinator,
  | "subscribe"
  | "dashboardState"
  | "conversationEvents"
  | "submitTurn"
  | "submitAction"
  | "visualWorldState"
  | "submitVisualWorldAction"
  | "renameWorkspace"
  | "readAuthorizedArtifact"
  | "replayVerification"
  | "replayMutation"
  | "sourceDocuments"
  | "sourceSearch"
  | "sourceRead"
  | "sourceSymbols"
  | "sourceReferences"
  | "sourceDependencies"
  | "sourceDiff"
>;

export interface CreatorControlServerOptions {
  coordinator: CreatorControlCoordinator;
  dashboardDirectory: string;
  host?: string;
  port?: number;
  now?: () => Date;
  launchTtlMs?: number;
  bearerToken?: string;
  artifactRoot?: string;
}

export class CreatorControlServer {
  private readonly host: "127.0.0.1";
  private readonly port: number;
  private readonly now: () => Date;
  private readonly launchTtlMs: number;
  private readonly bearerToken: string;
  private readonly browserSession = randomBytes(32).toString("base64url");
  private readonly launches = new Map<string, number>();
  private readonly dashboardDirectory: string;
  private readonly binaryArtifacts: ImmutableBinaryArtifactStore | undefined;
  private readonly server: Server;
  private readonly subscribers = new Set<ServerResponse>();
  private cursor = 0;
  private baseCursor = 0;
  private readonly events: number[] = [];
  private readonly unsubscribe: () => void;

  constructor(private readonly options: CreatorControlServerOptions) {
    const host = options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1") throw new Error("Creator control server supports loopback only");
    this.host = host;
    this.port = options.port ?? 8788;
    this.now = options.now ?? (() => new Date());
    this.launchTtlMs = options.launchTtlMs ?? 5 * 60_000;
    this.bearerToken = options.bearerToken ?? randomBytes(32).toString("base64url");
    this.dashboardDirectory = resolve(options.dashboardDirectory);
    this.binaryArtifacts = options.artifactRoot
      ? new ImmutableBinaryArtifactStore(resolve(options.artifactRoot), {
          maxBytes: 1024 * 1024 * 1024,
        })
      : undefined;
    this.server = createServer((request, response) => {
      // A client can disconnect while a Studio-backed action is still settling.
      // No request-path exception may escape this callback: doing so would turn a
      // single dead socket into an unhandled rejection for the creator service.
      void this.serveRequest(request, response).catch(() => safeEnd(response));
    });
    this.unsubscribe = options.coordinator.subscribe(() => this.invalidate());
  }

  async listen(): Promise<{
    host: "127.0.0.1";
    port: number;
    bearerToken: string;
  }> {
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolvePromise();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    return {
      host: this.host,
      port: typeof address === "object" && address ? address.port : this.port,
      bearerToken: this.bearerToken,
    };
  }

  createLaunchUrl(port: number): string {
    this.pruneLaunches();
    const grant = randomBytes(24).toString("base64url");
    this.launches.set(grant, this.now().getTime() + this.launchTtlMs);
    return `http://${this.host}:${port}/?launch=${encodeURIComponent(grant)}`;
  }

  async close(): Promise<void> {
    this.unsubscribe();
    for (const response of this.subscribers) safeEnd(response);
    this.subscribers.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolvePromise, reject) =>
      this.server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }

  private async serveRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Peer failures are output-only. An action that has already been admitted
    // may continue to its durable boundary, but its abandoned request must not
    // create an unhandled EventEmitter error or trigger an automatic retry.
    request.once("error", () => undefined);
    request.once("aborted", () => undefined);
    response.on("error", () => undefined);
    try {
      await this.handle(request, response);
    } catch {
      this.writeTerminalFailure(response);
    }
  }

  private writeTerminalFailure(response: ServerResponse): void {
    if (!isWritable(response)) return;
    if (response.headersSent) {
      safeEnd(response);
      return;
    }
    safeWriteJson(response, 500, {
      kind: "CreatorControlError",
      message: "The local control plane could not complete this request.",
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      setSecurityHeaders(response);
      const url = new URL(request.url ?? "/", `http://${this.host}:${this.actualPort()}`);
      if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("launch"))
        return this.exchangeLaunch(url, response);
      this.assertAuthenticated(request);
      if (request.method === "GET" && url.pathname === "/api/control/state") {
        return writeJson(
          response,
          200,
          await this.options.coordinator.dashboardState(
            url.searchParams.get("conversationId") ?? undefined,
          ),
        );
      }
      const visualWorkflow = /^\/api\/visual-workflows\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && visualWorkflow?.[1]) {
        return writeJson(
          response,
          200,
          await this.options.coordinator.visualWorldState(decodeURIComponent(visualWorkflow[1])),
        );
      }
      const conversationEvents = /^\/api\/conversations\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === "GET" && conversationEvents?.[1]) {
        return writeJson(
          response,
          200,
          await this.options.coordinator.conversationEvents(
            decodeURIComponent(conversationEvents[1]),
            {
              ...(url.searchParams.has("before") ? { before: requiredQuery(url, "before") } : {}),
              ...(url.searchParams.has("limit")
                ? {
                    limit: readBoundedInteger(
                      url.searchParams.get("limit"),
                      "Conversation event page size",
                      1,
                      200,
                    ),
                  }
                : {}),
            },
          ),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/control/catalog") {
        return writeJson(response, 200, studioCatalogSummary());
      }
      if (request.method === "GET" && url.pathname === "/api/control/capabilities") {
        return writeJson(
          response,
          200,
          studioCapabilityExplorerPage({
            ...(url.searchParams.has("class")
              ? { className: readClassName(url.searchParams.get("class")) }
              : {}),
            ...(url.searchParams.has("query")
              ? { query: readCapabilityQuery(url.searchParams.get("query")) }
              : {}),
            ...(url.searchParams.has("cursor")
              ? {
                  cursor: readBoundedInteger(
                    url.searchParams.get("cursor"),
                    "Capability cursor",
                    0,
                    Number.MAX_SAFE_INTEGER,
                  ),
                }
              : {}),
            ...(url.searchParams.has("limit")
              ? {
                  limit: readBoundedInteger(
                    url.searchParams.get("limit"),
                    "Capability page size",
                    1,
                    MAX_CAPABILITY_PAGE_SIZE,
                  ),
                }
              : {}),
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/sources/documents") {
        return writeJson(
          response,
          200,
          await this.options.coordinator.sourceDocuments(sourceEvidenceAnchor(url), {
            ...(url.searchParams.has("limit")
              ? {
                  limit: readBoundedInteger(
                    url.searchParams.get("limit"),
                    "Source page size",
                    1,
                    200,
                  ),
                }
              : {}),
            ...(url.searchParams.has("cursor") ? { cursor: requiredQuery(url, "cursor") } : {}),
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/sources/search") {
        return writeJson(
          response,
          200,
          await this.options.coordinator.sourceSearch(sourceEvidenceAnchor(url), {
            query: requiredQuery(url, "query"),
            ...(url.searchParams.has("pathPrefix")
              ? { pathPrefix: requiredQuery(url, "pathPrefix") }
              : {}),
            ...(url.searchParams.has("contextBytes")
              ? {
                  contextUtf8Bytes: readBoundedInteger(
                    url.searchParams.get("contextBytes"),
                    "Source context bytes",
                    1,
                    512,
                  ),
                }
              : {}),
            ...(url.searchParams.has("limit")
              ? {
                  limit: readBoundedInteger(
                    url.searchParams.get("limit"),
                    "Source result limit",
                    1,
                    100,
                  ),
                }
              : {}),
            ...(url.searchParams.has("cursor") ? { cursor: requiredQuery(url, "cursor") } : {}),
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/sources/read") {
        return writeJson(
          response,
          200,
          await this.options.coordinator.sourceRead(sourceEvidenceAnchor(url), {
            documentId: requiredQuery(url, "documentId"),
            ...(url.searchParams.has("limit")
              ? {
                  maximumUtf8Bytes: readBoundedInteger(
                    url.searchParams.get("limit"),
                    "Source read bytes",
                    1,
                    32 * 1024,
                  ),
                }
              : {}),
            ...(url.searchParams.has("cursor") ? { cursor: requiredQuery(url, "cursor") } : {}),
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/sources/symbols") {
        return writeJson(
          response,
          200,
          await this.options.coordinator.sourceSymbols(sourceEvidenceAnchor(url), {
            query: requiredQuery(url, "query"),
            ...(url.searchParams.has("pathPrefix")
              ? { pathPrefix: requiredQuery(url, "pathPrefix") }
              : {}),
            ...(url.searchParams.has("limit")
              ? {
                  limit: readBoundedInteger(
                    url.searchParams.get("limit"),
                    "Symbol result limit",
                    1,
                    200,
                  ),
                }
              : {}),
            ...(url.searchParams.has("cursor") ? { cursor: requiredQuery(url, "cursor") } : {}),
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/sources/references") {
        return writeJson(
          response,
          200,
          await this.options.coordinator.sourceReferences(sourceEvidenceAnchor(url), {
            symbol: requiredQuery(url, "symbol"),
            ...(url.searchParams.has("pathPrefix")
              ? { pathPrefix: requiredQuery(url, "pathPrefix") }
              : {}),
            ...(url.searchParams.has("limit")
              ? {
                  limit: readBoundedInteger(
                    url.searchParams.get("limit"),
                    "Reference result limit",
                    1,
                    200,
                  ),
                }
              : {}),
            ...(url.searchParams.has("cursor") ? { cursor: requiredQuery(url, "cursor") } : {}),
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/sources/dependencies") {
        const direction = requiredQuery(url, "direction");
        if (
          !(["imports", "importers", "closure"] as const).includes(
            direction as "imports" | "importers" | "closure",
          )
        )
          throw new HttpError(400, "Invalid source dependency direction");
        return writeJson(
          response,
          200,
          await this.options.coordinator.sourceDependencies(sourceEvidenceAnchor(url), {
            documentId: requiredQuery(url, "documentId"),
            direction: direction as "imports" | "importers" | "closure",
            ...(url.searchParams.has("maxDepth")
              ? {
                  maxDepth: readBoundedInteger(
                    url.searchParams.get("maxDepth"),
                    "Dependency depth",
                    1,
                    16,
                  ),
                }
              : {}),
            ...(url.searchParams.has("limit")
              ? {
                  limit: readBoundedInteger(
                    url.searchParams.get("limit"),
                    "Dependency result limit",
                    1,
                    1_024,
                  ),
                }
              : {}),
            ...(url.searchParams.has("cursor") ? { cursor: requiredQuery(url, "cursor") } : {}),
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/sources/diff") {
        return writeJson(
          response,
          200,
          await this.options.coordinator.sourceDiff(sourceEvidenceAnchor(url), {
            sourceIndexHash: requiredHashQuery(url, "sourceIndexHash"),
            operationId: requiredQuery(url, "operationId"),
            ...(url.searchParams.has("changeSetId")
              ? { changeSetId: requiredQuery(url, "changeSetId") }
              : {}),
            ...(url.searchParams.has("limit")
              ? {
                  maximumUtf8Bytes: readBoundedInteger(
                    url.searchParams.get("limit"),
                    "Exact source diff bytes",
                    1,
                    32 * 1024,
                  ),
                }
              : {}),
            ...(url.searchParams.has("cursor") ? { cursor: requiredQuery(url, "cursor") } : {}),
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/control/events")
        return this.openEvents(request, url, response);
      if (request.method === "POST" && url.pathname === "/api/control/turn") {
        this.assertSameOrigin(request);
        const body = await readJsonBody(request, "Creator turn", 12 * 1024 * 1024);
        return writeJson(response, 202, await this.options.coordinator.submitTurn(body));
      }
      if (request.method === "POST" && url.pathname === "/api/control/action") {
        this.assertSameOrigin(request);
        const body = await readJsonBody(request, "Creator action");
        return writeJson(response, 202, await this.options.coordinator.submitAction(body));
      }
      if (request.method === "POST" && url.pathname === "/api/control/visual-world") {
        this.assertSameOrigin(request);
        const body = await readJsonBody(request, "Visual-world creator action", 72 * 1024 * 1024);
        return writeJson(
          response,
          200,
          await this.options.coordinator.submitVisualWorldAction(body),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/control/rename") {
        this.assertSameOrigin(request);
        return writeJson(
          response,
          200,
          await this.options.coordinator.renameWorkspace(await readJsonBody(request, "Rename")),
        );
      }
      const artifact = /^\/api\/artifacts\/([a-f0-9]{64})$/.exec(url.pathname);
      if (request.method === "GET" && artifact?.[1])
        return writeJson(
          response,
          200,
          await this.options.coordinator.readAuthorizedArtifact(artifact[1]),
        );
      const binaryArtifact = /^\/api\/binary-artifacts\/([a-f0-9]{64})$/.exec(url.pathname);
      if (request.method === "GET" && binaryArtifact?.[1]) {
        if (!this.binaryArtifacts) throw new HttpError(404, "Binary artifact store is unavailable");
        const bindingHash = requiredHashQuery(url, "binding");
        const binding = await this.options.coordinator.readAuthorizedArtifact(bindingHash);
        const reference = findBoundBinaryArtifact(binding, binaryArtifact[1]);
        if (!reference)
          throw new HttpError(
            404,
            "Binary artifact is not bound by the authorized retained artifact",
          );
        assertBinaryArtifactReference(reference);
        const bytes = await this.binaryArtifacts.read(reference);
        response.statusCode = 200;
        response.setHeader("content-type", reference.mediaType);
        response.setHeader("content-length", String(reference.bytes));
        response.setHeader("etag", `"${reference.artifactHash}"`);
        response.end(bytes);
        return;
      }
      const replay = /^\/api\/verifications\/([^/]+)\/replay$/.exec(url.pathname);
      if (request.method === "POST" && replay?.[1]) {
        this.assertSameOrigin(request);
        const result = await this.options.coordinator.replayVerification(
          decodeURIComponent(replay[1]),
        );
        return writeJson(response, 200, result);
      }
      const mutationReplay = /^\/api\/mutations\/([^/]+)\/replay$/.exec(url.pathname);
      if (request.method === "POST" && mutationReplay?.[1]) {
        this.assertSameOrigin(request);
        const result = await this.options.coordinator.replayMutation(
          decodeURIComponent(mutationReplay[1]),
        );
        return writeJson(response, 200, result);
      }
      if (request.method === "GET") {
        await this.serveAsset(url.pathname, response);
        return;
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (response.headersSent) {
        safeEnd(response);
        return;
      }
      const status = error instanceof HttpError ? error.status : 400;
      safeWriteJson(response, status, {
        kind: "CreatorControlError",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof CreatorTurnNotAdmittedError
          ? {
              admission: "not_admitted",
              idempotencyKey: error.idempotencyKey,
              requestHash: error.requestHash,
            }
          : {}),
      });
    }
  }

  private exchangeLaunch(url: URL, response: ServerResponse): void {
    const grant = url.searchParams.get("launch") ?? "";
    const expiry = this.launches.get(grant);
    this.launches.delete(grant);
    if (!expiry || expiry < this.now().getTime())
      throw new HttpError(401, "Launch grant is missing, expired, or already used");
    response.statusCode = 303;
    response.setHeader(
      "set-cookie",
      `${COOKIE_NAME}=${this.browserSession}; Path=/; HttpOnly; SameSite=Strict`,
    );
    response.setHeader("location", "/");
    response.end();
  }

  private assertAuthenticated(request: IncomingMessage): void {
    const authorization = request.headers.authorization;
    if (authorization === `Bearer ${this.bearerToken}`) return;
    const cookies = parseCookies(request.headers.cookie ?? "");
    if (cookies.get(COOKIE_NAME) === this.browserSession) return;
    throw new HttpError(401, "Creator control authentication required");
  }

  private assertSameOrigin(request: IncomingMessage): void {
    if (request.headers.authorization === `Bearer ${this.bearerToken}`) return;
    const expected = `http://${this.host}:${this.actualPort()}`;
    if (request.headers.origin !== expected)
      throw new HttpError(403, "State-changing requests must be same-origin");
  }

  private openEvents(request: IncomingMessage, url: URL, response: ServerResponse): void {
    if (this.subscribers.size >= MAX_SUBSCRIBERS)
      throw new HttpError(429, "Creator event subscriber limit reached");
    const requested = Number(
      request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0",
    );
    if (!Number.isInteger(requested) || requested < 0)
      throw new HttpError(400, "Creator event cursor is invalid");
    const needsReset = requested < this.baseCursor || requested > this.cursor;
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    if (needsReset) {
      if (!writeSseReset(response, this.cursor)) return;
    } else {
      for (const cursor of this.events.filter((candidate) => candidate > requested))
        if (!writeSse(response, cursor)) return;
    }
    if (!isWritable(response)) return;
    this.subscribers.add(response);
    const remove = () => this.subscribers.delete(response);
    request.once("aborted", remove);
    request.once("error", remove);
    response.once("close", remove);
    response.once("error", remove);
  }

  private invalidate(): void {
    this.cursor += 1;
    this.events.push(this.cursor);
    while (this.events.length > MAX_EVENTS) {
      const removed = this.events.shift();
      if (removed !== undefined) this.baseCursor = removed;
    }
    for (const response of this.subscribers)
      if (!writeSse(response, this.cursor)) this.subscribers.delete(response);
  }

  private async serveAsset(pathname: string, response: ServerResponse): Promise<void> {
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split("/").includes(".."))
      throw new HttpError(404, "Asset not found");
    const asset = await readDashboardAsset(this.dashboardDirectory, relative);
    const fallback = asset ?? (await readDashboardAsset(this.dashboardDirectory, "index.html"));
    if (!fallback) throw new HttpError(404, "Dashboard entrypoint is missing");
    response.statusCode = 200;
    response.setHeader("content-type", contentType(fallback.path));
    response.end(fallback.bytes);
  }

  private actualPort(): number {
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : this.port;
  }

  private pruneLaunches(): void {
    const now = this.now().getTime();
    for (const [grant, expiry] of this.launches) if (expiry < now) this.launches.delete(grant);
  }
}

function findBoundBinaryArtifact(
  root: unknown,
  artifactHash: string,
): { locator: string; artifactHash: string; bytes: number; mediaType: string } | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const visited = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 100_000 || current.depth > 32)
      throw new HttpError(400, "Authorized artifact binary-reference graph exceeds its bound");
    if (typeof current.value !== "object" || current.value === null) continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    if (!Array.isArray(current.value)) {
      const record = current.value as Record<string, unknown>;
      if (
        record.artifactHash === artifactHash &&
        record.locator === `binary-artifacts/${artifactHash}.bin` &&
        typeof record.bytes === "number" &&
        Number.isSafeInteger(record.bytes) &&
        record.bytes > 0 &&
        record.bytes <= 1024 * 1024 * 1024 &&
        typeof record.mediaType === "string" &&
        record.mediaType.length > 0 &&
        record.mediaType.length <= 256
      )
        return {
          locator: record.locator,
          artifactHash,
          bytes: record.bytes,
          mediaType: record.mediaType,
        };
    }
    for (const child of Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>))
      pending.push({ value: child, depth: current.depth + 1 });
  }
  return undefined;
}

/** Returns only pinning and aggregate data; catalog entries remain paginated. */
export function studioCatalogSummary(): StudioCatalogSummaryView {
  const coverage = STUDIO_CAPABILITY_COVERAGE_REPORT;
  const manifest = STUDIO_CAPABILITY_MANIFEST;
  return {
    kind: "StudioCatalogSummary",
    catalog: {
      hash: ROBLOX_API_CATALOG_HASH,
      source: {
        repository: ROBLOX_API_CATALOG.source.repository,
        commit: ROBLOX_API_CATALOG.source.commit,
        engineReferencePath: ROBLOX_API_CATALOG.source.engineReferencePath,
        sourceTreeHash: ROBLOX_API_CATALOG.source.sourceTreeHash,
      },
      counts: ROBLOX_API_CATALOG.counts,
    },
    coverage: {
      hash: STUDIO_CAPABILITY_COVERAGE_REPORT_HASH,
      catalogHash: coverage.catalogHash,
      policyHash: coverage.policyHash,
      manifestHash: coverage.manifestHash,
      summary: coverage.summary,
      catalogBinding: coverage.catalogHash === ROBLOX_API_CATALOG_HASH ? "matched" : "mismatched",
      manifestBinding:
        coverage.manifestHash === STUDIO_CAPABILITY_MANIFEST_HASH ? "matched" : "mismatched",
    },
    manifest: {
      hash: STUDIO_CAPABILITY_MANIFEST_HASH,
      connectorBuildHash: STUDIO_CONNECTOR_BUILD_HASH,
      classCount: manifest.classes.length,
      writablePropertyCount: manifest.classes.reduce(
        (count, entry) => count + entry.properties.length,
        0,
      ),
      roots: manifest.roots,
      operationKinds: manifest.operationKinds,
    },
  };
}

/**
 * Read-only catalog exploration. The page size and request fields are bounded
 * so neither the control API nor ordinary dashboard state can expose the full
 * generated catalog in one response.
 */
export function studioCapabilityExplorerPage(
  request: StudioCapabilityExplorerRequest = {},
): StudioCapabilityExplorerPage {
  const className = request.className;
  const query = request.query?.trim();
  const cursor = request.cursor ?? 0;
  const limit = request.limit ?? DEFAULT_CAPABILITY_PAGE_SIZE;
  assertCapabilityExplorerRequest({
    ...(className !== undefined ? { className } : {}),
    ...(query !== undefined ? { query } : {}),
    cursor,
    limit,
  });

  if (
    className !== undefined &&
    !ROBLOX_API_CATALOG.classes.some((entry) => entry.name === className)
  )
    throw new HttpError(404, `Roblox API class is not present in the pinned catalog: ${className}`);

  const normalizedQuery = query?.toLowerCase();
  const entries = STUDIO_CAPABILITY_COVERAGE_REPORT.entries
    .filter((entry) => matchesCapabilityClass(entry, className))
    .filter((entry) => matchesCapabilityQuery(entry, normalizedQuery))
    .map((entry) => capabilityExplorerEntry(entry))
    .sort((left, right) => left.catalogEntryId.localeCompare(right.catalogEntryId));
  const pageEntries = entries.slice(cursor, cursor + limit);
  const nextCursor = cursor + pageEntries.length;
  return {
    kind: "StudioCapabilityExplorerPage",
    catalogHash: ROBLOX_API_CATALOG_HASH,
    coverageHash: STUDIO_CAPABILITY_COVERAGE_REPORT_HASH,
    selection: {
      ...(className !== undefined ? { className } : {}),
      ...(query ? { query } : {}),
    },
    page: {
      cursor,
      limit,
      total: entries.length,
      ...(nextCursor < entries.length ? { nextCursor } : {}),
    },
    entries: pageEntries,
  };
}

function capabilityExplorerEntry(
  entry: (typeof STUDIO_CAPABILITY_COVERAGE_REPORT.entries)[number],
): StudioCapabilityExplorerEntryView {
  const catalogEntry = getRobloxApiCatalogLookupEntry(entry.catalogEntryId);
  if (!catalogEntry)
    throw new Error(`Pinned Roblox API metadata is missing for ${entry.catalogEntryId}`);
  const proofObligations = manifestProofObligations(entry.owner, entry.name, entry.inheritedBy);
  return {
    ...catalogEntry,
    ...(proofObligations !== undefined ? { proofObligations } : {}),
  };
}

function manifestProofObligations(
  owner: string | undefined,
  name: string,
  inheritedBy: readonly string[] | undefined,
): readonly string[] | undefined {
  const candidateClasses = [owner, ...(inheritedBy ?? [])].filter(
    (candidate): candidate is string => candidate !== undefined,
  );
  for (const className of candidateClasses) {
    const property = STUDIO_CAPABILITY_MANIFEST.classes
      .find((entry) => entry.name === className)
      ?.properties.find((candidate) => candidate.name === name);
    if (property) return property.proof;
  }
  return undefined;
}

function matchesCapabilityClass(
  entry: (typeof STUDIO_CAPABILITY_COVERAGE_REPORT.entries)[number],
  className: string | undefined,
): boolean {
  if (className === undefined) return true;
  return (
    (entry.entryKind === "class" && entry.name === className) ||
    entry.owner === className ||
    entry.inheritedBy?.includes(className) === true
  );
}

function matchesCapabilityQuery(
  entry: (typeof STUDIO_CAPABILITY_COVERAGE_REPORT.entries)[number],
  query: string | undefined,
): boolean {
  if (!query) return true;
  return [
    entry.catalogEntryId,
    entry.entryKind,
    entry.owner,
    entry.name,
    entry.disposition,
    entry.reason,
    entry.authoringGroup,
    entry.codec,
    ...(entry.inheritedBy ?? []),
  ].some((candidate) => candidate?.toLowerCase().includes(query));
}

function assertCapabilityExplorerRequest(
  request: Required<Pick<StudioCapabilityExplorerRequest, "cursor" | "limit">> &
    Pick<StudioCapabilityExplorerRequest, "className" | "query">,
): void {
  if (
    request.className !== undefined &&
    (!isClassName(request.className) || request.className.length > MAX_CLASS_NAME_LENGTH)
  )
    throw new HttpError(400, "Capability class name is invalid");
  if (
    request.query !== undefined &&
    (request.query.length > MAX_CAPABILITY_QUERY_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(request.query))
  )
    throw new HttpError(400, "Capability search query is invalid");
  if (!Number.isSafeInteger(request.cursor) || request.cursor < 0)
    throw new HttpError(400, "Capability cursor is invalid");
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_CAPABILITY_PAGE_SIZE
  )
    throw new HttpError(400, "Capability page size is invalid");
}

function readClassName(value: string | null): string {
  if (value === null) throw new HttpError(400, "Capability class name is required");
  return value;
}

function readCapabilityQuery(value: string | null): string {
  if (value === null) throw new HttpError(400, "Capability search query is required");
  return value;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (
    value === null ||
    value.length === 0 ||
    value.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new HttpError(400, `${name} is missing or invalid`);
  return value;
}

function sourceEvidenceAnchor(url: URL): {
  conversationId: string;
  eventId: string;
  eventHash: string;
  sourceIndexHash: string;
} {
  return {
    conversationId: requiredQuery(url, "conversationId"),
    eventId: requiredQuery(url, "eventId"),
    eventHash: requiredHashQuery(url, "eventHash"),
    sourceIndexHash: requiredHashQuery(url, "sourceIndexHash"),
  };
}

function requiredHashQuery(url: URL, name: string): string {
  const value = requiredQuery(url, name);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new HttpError(400, `Invalid ${name}`);
  return value;
}

function readBoundedInteger(
  value: string | null,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (value === null || !/^\d+$/.test(value)) throw new HttpError(400, `${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new HttpError(400, `${label} is invalid`);
  return parsed;
}

function isClassName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
}

export function defaultCreatorControlDiscoveryPath(cwd: string = process.cwd()): string {
  return resolve(cwd, ".forge", "creator-control.json");
}

export async function writeCreatorControlDiscovery(
  discovery: CreatorControlDiscovery,
  filePath: string = defaultCreatorControlDiscoveryPath(),
): Promise<void> {
  assertCreatorControlDiscovery(discovery);
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(discovery, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

export async function readCreatorControlDiscovery(
  filePath: string = defaultCreatorControlDiscoveryPath(),
): Promise<CreatorControlDiscovery> {
  const info = await stat(filePath).catch(() => {
    throw new Error("Forge creator control server is not running");
  });
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new Error("Creator control discovery permissions are too broad");
  const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  assertCreatorControlDiscovery(value);
  return value;
}

export async function removeCreatorControlDiscovery(
  controlId: string,
  filePath: string = defaultCreatorControlDiscoveryPath(),
): Promise<void> {
  try {
    const current = await readCreatorControlDiscovery(filePath);
    if (current.controlId === controlId) await rm(filePath, { force: true });
  } catch {
    // Missing or replaced discovery does not make shutdown fail.
  }
}

function assertCreatorControlDiscovery(value: unknown): asserts value is CreatorControlDiscovery {
  if (!value || typeof value !== "object") throw new Error("Invalid creator control discovery");
  const item = value as Record<string, unknown>;
  if (
    item.kind !== "ForgeCreatorControlDiscovery" ||
    typeof item.controlId !== "string" ||
    item.host !== "127.0.0.1" ||
    typeof item.port !== "number" ||
    !Number.isInteger(item.port) ||
    item.port < 1 ||
    item.port > 65_535 ||
    typeof item.bearerToken !== "string" ||
    item.bearerToken.length < 24 ||
    typeof item.pid !== "number" ||
    !Number.isInteger(item.pid) ||
    typeof item.startedAt !== "string" ||
    !Number.isFinite(Date.parse(item.startedAt))
  )
    throw new Error("Invalid creator control discovery");
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) throw new HttpError(413, "Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(
  request: IncomingMessage,
  label: string,
  maximumBytes = MAX_CREATOR_CONTROL_WIRE_BODY_BYTES,
): Promise<unknown> {
  try {
    return JSON.parse(await readBody(request, maximumBytes)) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `${label} body must be valid JSON`);
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (!isWritable(response)) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function safeWriteJson(response: ServerResponse, status: number, value: unknown): void {
  try {
    writeJson(response, status, value);
  } catch {
    safeEnd(response);
  }
}

function safeEnd(response: ServerResponse): void {
  if (!isWritable(response)) return;
  try {
    response.end();
  } catch {
    // A response that failed while closing has no remaining recovery action.
  }
}

function isWritable(response: ServerResponse): boolean {
  return !response.destroyed && !response.writableEnded;
}

function writeSse(response: ServerResponse, cursor: number): boolean {
  if (!isWritable(response)) return false;
  try {
    const accepted = response.write(`id: ${cursor}\ndata: ${JSON.stringify({ cursor })}\n\n`);
    if (!accepted) {
      // SSE invalidations are resumable. Drop a backpressured peer instead of
      // retaining an unbounded Node write buffer; EventSource reconnects with
      // its last accepted cursor and receives the bounded retained history.
      safeEnd(response);
      return false;
    }
    return isWritable(response);
  } catch {
    return false;
  }
}

function writeSseReset(response: ServerResponse, cursor: number): boolean {
  if (!isWritable(response)) return false;
  try {
    const accepted = response.write(
      `event: reset\nid: ${cursor}\ndata: ${JSON.stringify({ cursor })}\n\n`,
    );
    if (!accepted) {
      safeEnd(response);
      return false;
    }
    return isWritable(response);
  } catch {
    return false;
  }
}

function parseCookies(value: string): Map<string, string> {
  return new Map(
    value
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((entry): entry is [string, string] => entry.length === 2),
  );
}

function contentType(path: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
  };
  return types[extname(path)] ?? "application/octet-stream";
}

interface DashboardAsset {
  readonly path: string;
  readonly bytes: Buffer;
}

/**
 * Read one dashboard asset without ever traversing a symlink. The dashboard is
 * local, but it still serves authenticated control-plane content and must not
 * become a read primitive for files outside its compiled asset directory.
 */
async function readDashboardAsset(
  dashboardDirectory: string,
  assetPath: string,
): Promise<DashboardAsset | undefined> {
  const destination = resolve(dashboardDirectory, assetPath);
  const fromRoot = relative(dashboardDirectory, destination);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw new HttpError(404, "Asset not found");

  const root = await lstat(dashboardDirectory).catch((error: unknown) => {
    if (isMissingNodeError(error)) throw new HttpError(404, "Dashboard asset directory is missing");
    throw error;
  });
  if (root.isSymbolicLink() || !root.isDirectory())
    throw new HttpError(404, "Dashboard asset directory is unsafe");

  const parts = fromRoot.split(sep).filter(Boolean);
  let current = dashboardDirectory;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) throw new HttpError(404, "Asset not found");
    current = join(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if (isMissingNodeError(error)) return undefined;
      throw error;
    });
    if (info === undefined) return undefined;
    if (info.isSymbolicLink()) throw new HttpError(404, "Dashboard asset path is unsafe");
    const target = index === parts.length - 1;
    if ((!target && !info.isDirectory()) || (target && !info.isFile()))
      throw new HttpError(404, "Dashboard asset is not a regular file");
  }

  const descriptor = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      if (isMissingNodeError(error)) throw new HttpError(404, "Asset not found");
      throw error;
    },
  );
  try {
    const info = await descriptor.stat();
    if (!info.isFile()) throw new HttpError(404, "Dashboard asset is not a regular file");
    return { path: destination, bytes: await descriptor.readFile() };
  } finally {
    await descriptor.close();
  }
}

function isMissingNodeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
