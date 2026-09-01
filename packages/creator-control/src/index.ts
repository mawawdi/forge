import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { CreatorSessionCoordinator } from "../../creator-session/src/coordinator.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SUBSCRIBERS = 32;
const MAX_EVENTS = 256;
const COOKIE_NAME = "forge_creator_session";

export interface CreatorControlDiscovery {
  kind: "ForgeCreatorControlDiscovery";
  controlId: string;
  host: "127.0.0.1";
  port: number;
  bearerToken: string;
  pid: number;
  startedAt: string;
}

export interface CreatorControlServerOptions {
  coordinator: CreatorSessionCoordinator;
  dashboardDirectory: string;
  host?: string;
  port?: number;
  now?: () => Date;
  launchTtlMs?: number;
  bearerToken?: string;
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
  private readonly server: Server;
  private readonly subscribers = new Set<ServerResponse>();
  private cursor = 0;
  private baseCursor = 0;
  private readonly events: number[] = [];
  private readonly unsubscribe: () => void;

  constructor(private readonly options: CreatorControlServerOptions) {
    const host = options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1")
      throw new Error("Creator control server supports loopback only");
    this.host = host;
    this.port = options.port ?? 8788;
    this.now = options.now ?? (() => new Date());
    this.launchTtlMs = options.launchTtlMs ?? 5 * 60_000;
    this.bearerToken =
      options.bearerToken ?? randomBytes(32).toString("base64url");
    this.dashboardDirectory = resolve(options.dashboardDirectory);
    this.server = createServer((request, response) => {
      void this.handle(request, response);
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
      port:
        typeof address === "object" && address ? address.port : this.port,
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
    for (const response of this.subscribers) response.end();
    this.subscribers.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolvePromise, reject) =>
      this.server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    setSecurityHeaders(response);
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${this.host}:${this.actualPort()}`,
      );
      if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("launch"))
        return this.exchangeLaunch(url, response);
      this.assertAuthenticated(request);
      if (request.method === "GET" && url.pathname === "/api/control/state") {
        return writeJson(
          response,
          200,
          await this.options.coordinator.dashboardState(
            url.searchParams.get("sessionId") ?? undefined,
          ),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/control/events")
        return this.openEvents(request, url, response);
      if (request.method === "POST" && url.pathname === "/api/control/action") {
        this.assertSameOrigin(request);
        const action = JSON.parse(await readBody(request)) as unknown;
        await this.options.coordinator.action(action);
        const selected =
          action && typeof action === "object" && "sessionId" in action
            ? String((action as { sessionId: unknown }).sessionId)
            : undefined;
        return writeJson(
          response,
          200,
          await this.options.coordinator.dashboardState(selected),
        );
      }
      const artifact = /^\/api\/artifacts\/([a-f0-9]{64})$/.exec(url.pathname);
      if (request.method === "GET" && artifact?.[1])
        return writeJson(
          response,
          200,
          await this.options.coordinator.readAuthorizedArtifact(artifact[1]),
        );
      const replay = /^\/api\/verifications\/([^/]+)\/replay$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && replay?.[1]) {
        this.assertSameOrigin(request);
        const result = await this.options.coordinator.replayVerification(
          decodeURIComponent(replay[1]),
        );
        return writeJson(response, 200, result);
      }
      if (request.method === "GET") return this.serveAsset(url.pathname, response);
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error instanceof HttpError ? error.status : 400;
      writeJson(response, status, {
        kind: "CreatorControlError",
        message: error instanceof Error ? error.message : String(error),
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

  private openEvents(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
  ): void {
    if (this.subscribers.size >= MAX_SUBSCRIBERS)
      throw new HttpError(429, "Creator event subscriber limit reached");
    const requested = Number(
      request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0",
    );
    if (!Number.isInteger(requested) || requested < this.baseCursor)
      throw new HttpError(409, "Creator event cursor expired");
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    for (const cursor of this.events.filter((candidate) => candidate > requested))
      writeSse(response, cursor);
    this.subscribers.add(response);
    request.once("close", () => this.subscribers.delete(response));
  }

  private invalidate(): void {
    this.cursor += 1;
    this.events.push(this.cursor);
    while (this.events.length > MAX_EVENTS) {
      const removed = this.events.shift();
      if (removed !== undefined) this.baseCursor = removed;
    }
    for (const response of this.subscribers) writeSse(response, this.cursor);
  }

  private async serveAsset(pathname: string, response: ServerResponse): Promise<void> {
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split("/").includes(".."))
      throw new HttpError(404, "Asset not found");
    let destination = resolve(this.dashboardDirectory, relative);
    if (!destination.startsWith(`${this.dashboardDirectory}/`))
      throw new HttpError(404, "Asset not found");
    try {
      const info = await stat(destination);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      destination = join(this.dashboardDirectory, "index.html");
    }
    response.statusCode = 200;
    response.setHeader("content-type", contentType(destination));
    response.end(await readFile(destination));
  }

  private actualPort(): number {
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : this.port;
  }

  private pruneLaunches(): void {
    const now = this.now().getTime();
    for (const [grant, expiry] of this.launches)
      if (expiry < now) this.launches.delete(grant);
  }
}

export function defaultCreatorControlDiscoveryPath(
  cwd: string = process.cwd(),
): string {
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

function assertCreatorControlDiscovery(
  value: unknown,
): asserts value is CreatorControlDiscovery {
  if (!value || typeof value !== "object")
    throw new Error("Invalid creator control discovery");
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

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function writeSse(response: ServerResponse, cursor: number): void {
  response.write(`id: ${cursor}\ndata: ${JSON.stringify({ cursor })}\n\n`);
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
