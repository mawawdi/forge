import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  normalize,
  parse,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { stableJson } from "../../contracts/src/index.js";

/**
 * A content-addressed reference to an immutable JSON artifact.
 *
 * `locator` is always relative to the store root. `artifactHash` hashes the
 * exact persisted UTF-8 bytes, including the trailing newline.
 */
export interface ArtifactReference {
  locator: string;
  artifactHash: string;
  bytes: number;
}

export interface ImmutableJsonArtifactStoreOptions {
  /** Maximum serialized artifact size accepted by this store. */
  maxBytes?: number;
}

export type JsonArtifactAssertion<T> = (value: unknown) => asserts value is T;

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const ARTIFACT_DIRECTORY = "artifacts";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * A local, immutable JSON evidence store. It has no process-working-directory
 * behaviour: every locator is resolved only from the root passed at creation.
 */
export class ImmutableJsonArtifactStore {
  public readonly root: string;
  public readonly maxBytes: number;

  constructor(root: string, options: ImmutableJsonArtifactStoreOptions = {}) {
    if (typeof root !== "string" || root.trim().length === 0)
      throw new Error("Artifact store root must be a non-empty path");
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("Artifact store maxBytes must be a positive safe integer");
    this.root = resolve(root);
    this.maxBytes = maxBytes;
  }

  /** Canonically serialize and atomically persist a JSON value. */
  async write(value: unknown): Promise<ArtifactReference> {
    const serialized = serializeCanonicalJson(value);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > this.maxBytes)
      throw new Error(`Artifact exceeds byte limit (${bytes} > ${this.maxBytes})`);
    const artifactHash = hashBytes(serialized);
    const locator = `${ARTIFACT_DIRECTORY}/${artifactHash}.json`;
    const reference: ArtifactReference = { locator, artifactHash, bytes };

    await this.ensureRoot();
    const destination = await this.resolveForWrite(locator);
    try {
      await this.createNewArtifact(destination, serialized);
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      // A competing/previous writer is valid only when its immutable bytes
      // exactly match this content address. Never overwrite a conflict.
      await this.read(reference);
    }
    return reference;
  }

  /** Read, integrity-check, parse, and optionally assert an artifact. */
  async read<T = unknown>(
    reference: ArtifactReference,
    assertion?: JsonArtifactAssertion<T>,
  ): Promise<T> {
    assertArtifactReference(reference);
    if (reference.bytes > this.maxBytes)
      throw new Error(
        `Artifact reference exceeds byte limit (${reference.bytes} > ${this.maxBytes})`,
      );
    const destination = await this.resolveForRead(reference.locator);
    const serialized = await readRegularFileWithoutFollowingTarget(
      destination,
      reference.bytes,
      this.maxBytes,
    );
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes !== reference.bytes) throw new Error("Artifact byte count mismatch");
    if (hashBytes(serialized) !== reference.artifactHash)
      throw new Error("Artifact SHA-256 mismatch");

    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      throw new Error("Artifact is not valid JSON");
    }
    if (serializeCanonicalJson(value) !== serialized)
      throw new Error("Artifact JSON is not canonical");
    if (assertion !== undefined) {
      const assertionCallback: JsonArtifactAssertion<T> = assertion;
      assertionCallback(value);
    }
    return value as T;
  }

  /** Validate a reference and all of its persisted integrity properties. */
  async verify(reference: ArtifactReference): Promise<void> {
    await this.read(reference);
  }

  private async ensureRoot(): Promise<void> {
    await ensureSafeAbsoluteDirectory(this.root);
  }

  private async resolveForWrite(locator: string): Promise<string> {
    const destination = resolveLocator(this.root, locator);
    const artifactDirectory = dirname(destination);
    await ensureSafeDirectoryWithinRoot(this.root, artifactDirectory);
    return destination;
  }

  private async resolveForRead(locator: string): Promise<string> {
    const destination = resolveLocator(this.root, locator);
    await assertSafeExistingPathWithinRoot(this.root, destination, true);
    return destination;
  }

  private async createNewArtifact(destination: string, serialized: string): Promise<void> {
    const temporary = `${dirname(destination)}/.${basename(destination)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      // The process umask can only remove permissions, but chmod makes the
      // persistent private-file contract explicit and deterministic.
      await chmod(temporary, 0o600);
      await link(temporary, destination);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  }
}

export function assertArtifactReference(value: unknown): asserts value is ArtifactReference {
  if (!isRecord(value)) throw new Error("Invalid ArtifactReference");
  const { locator, artifactHash, bytes } = value;
  if (
    typeof locator !== "string" ||
    !isSafeLocator(locator) ||
    typeof artifactHash !== "string" ||
    !HASH_PATTERN.test(artifactHash) ||
    locator !== `${ARTIFACT_DIRECTORY}/${artifactHash}.json` ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0
  ) {
    throw new Error("Invalid ArtifactReference");
  }
}

export function isSafeArtifactLocator(value: string): boolean {
  return isSafeLocator(value);
}

function serializeCanonicalJson(value: unknown): string {
  const json = stableJson(value);
  if (typeof json !== "string") throw new Error("Artifact must be JSON-serializable");
  return `${json}\n`;
}

function hashBytes(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resolveLocator(root: string, locator: string): string {
  if (!isSafeLocator(locator))
    throw new Error("Artifact locator must be a safe root-relative path");
  const destination = resolve(root, ...locator.split("/"));
  const fromRoot = relative(root, destination);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw new Error("Artifact locator escapes store root");
  return destination;
}

function isSafeLocator(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  )
    return false;
  const normalized = normalize(value).replaceAll("\\", "/");
  if (normalized !== value) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * Build a missing absolute directory component by component. This refuses a
 * symlink at every component rather than relying on recursive mkdir, which
 * would silently traverse a malicious link.
 */
async function ensureSafeAbsoluteDirectory(directory: string): Promise<void> {
  const absolute = resolve(directory);
  const parsed = parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  for (const part of parts) {
    current = `${current}${current.endsWith(sep) ? "" : sep}${part}`;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() && current !== absolute) continue;
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe artifact store directory: ${current}`);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError: unknown) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe artifact store directory: ${current}`);
    }
  }
}

async function ensureSafeDirectoryWithinRoot(root: string, directory: string): Promise<void> {
  const fromRoot = relative(root, directory);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw new Error("Artifact directory escapes store root");
  let current = root;
  for (const part of fromRoot.split(sep)) {
    if (!part) continue;
    current = `${current}${sep}${part}`;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe artifact directory: ${current}`);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError: unknown) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe artifact directory: ${current}`);
    }
  }
}

async function assertSafeExistingPathWithinRoot(
  root: string,
  destination: string,
  includeTarget: boolean,
): Promise<void> {
  const fromRoot = relative(root, destination);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw new Error("Artifact path escapes store root");
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if (isMissing(error)) throw new Error("Artifact store root does not exist");
    throw error;
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error("Unsafe artifact store root");
  const parts = fromRoot.split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) throw new Error("Invalid artifact path");
    current = `${current}${sep}${part}`;
    const info = await lstat(current).catch((error: unknown) => {
      if (isMissing(error)) throw new Error("Artifact file is missing");
      throw error;
    });
    if (info.isSymbolicLink()) throw new Error("Artifact path contains a symbolic link");
    const target = index === parts.length - 1;
    if ((!target || !includeTarget) && !info.isDirectory())
      throw new Error("Artifact path component is not a directory");
    if (target && includeTarget && !info.isFile())
      throw new Error("Artifact target is not a regular file");
  }
}

async function readRegularFileWithoutFollowingTarget(
  path: string,
  expectedBytes: number,
  maxBytes: number,
): Promise<string> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await descriptor.stat();
    if (!info.isFile()) throw new Error("Artifact target is not a regular file");
    if (info.size > maxBytes)
      throw new Error(`Artifact exceeds byte limit (${info.size} > ${maxBytes})`);
    if (info.size !== expectedBytes) throw new Error("Artifact byte count mismatch");
    return await descriptor.readFile({ encoding: "utf8" });
  } finally {
    await descriptor.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error, "EEXIST");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
