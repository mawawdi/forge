import { isNodeError } from "../../artifact-store/src/index.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";
import { stableJson } from "../../contracts/src/index.js";

/** The private, single-writer lease held by a foreground creator service. */
export const CREATOR_STORE_LEASE_FILENAME = ".forge-creator-service.lock";

const MAX_LEASE_BYTES = 4096;
const LEASE_KIND = "ForgeCreatorStoreLease";
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface CreatorStoreLeaseRecord {
  readonly kind: typeof LEASE_KIND;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
}

/**
 * The in-process capability for the exclusive creator-store writer. Retain it
 * for the whole lifetime of the service and release it during shutdown.
 */
export interface CreatorStoreLease {
  readonly storeDirectory: string;
  readonly lockPath: string;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  /**
   * Removes this exact lease. Repeated calls after a successful release are
   * no-ops. A changed, missing, linked, or irregular target is an error: the
   * caller must not continue after it has lost exclusive ownership.
   */
  release(): Promise<void>;
}

/**
 * Atomically acquire the sole creator-service lease for one conversation
 * store. Only a canonical same-host record whose PID is demonstrably gone is
 * reclaimable; every other existing lock fails closed.
 */
export async function acquireCreatorStoreLease(storeDirectory: string): Promise<CreatorStoreLease> {
  const root = assertStoreDirectory(storeDirectory);
  await ensureSafeStoreDirectory(root);
  const lockPath = creatorStoreLeasePath(root);
  const record: CreatorStoreLeaseRecord = {
    kind: LEASE_KIND,
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
  };
  assertCreatorStoreLeaseRecord(record);

  if (!(await tryCreateLease(lockPath, record))) {
    const reclaimed = await reclaimDeadSameHostLease(root, lockPath);
    if (!reclaimed || !(await tryCreateLease(lockPath, record)))
      throw new Error(`Creator store is already leased: ${root}`);
  }

  const persisted = await readLeaseRecord(root, lockPath);
  if (!sameLease(persisted, record))
    throw new Error("Creator store lease changed during acquisition");
  return new HeldCreatorStoreLease(root, lockPath, record);
}

/** Return the private lease filename rooted at a validated creator store. */
export function creatorStoreLeasePath(storeDirectory: string): string {
  return join(assertStoreDirectory(storeDirectory), CREATOR_STORE_LEASE_FILENAME);
}

class HeldCreatorStoreLease implements CreatorStoreLease {
  readonly storeDirectory: string;
  readonly lockPath: string;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  private released = false;
  private releaseTail: Promise<void> = Promise.resolve();

  constructor(
    storeDirectory: string,
    lockPath: string,
    private readonly record: CreatorStoreLeaseRecord,
  ) {
    this.storeDirectory = storeDirectory;
    this.lockPath = lockPath;
    this.token = record.token;
    this.pid = record.pid;
    this.hostname = record.hostname;
    this.startedAt = record.startedAt;
  }

  release(): Promise<void> {
    const release = this.releaseTail.then(async () => {
      if (this.released) return;
      const current = await readLeaseRecord(this.storeDirectory, this.lockPath);
      if (!sameLease(current, this.record))
        throw new Error("Creator store lease ownership changed before release");
      await unlink(this.lockPath);
      await syncDirectory(this.storeDirectory);
      this.released = true;
    });
    this.releaseTail = release.catch(() => undefined);
    return release;
  }
}

async function tryCreateLease(path: string, record: CreatorStoreLeaseRecord): Promise<boolean> {
  let descriptor;
  try {
    descriptor = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error: unknown) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  }
  try {
    const info = await descriptor.stat();
    if (!info.isFile()) throw new Error("Creator store lease target is not a regular file");
    await descriptor.writeFile(`${stableJson(record)}\n`, { encoding: "utf8" });
    await descriptor.chmod(0o600);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  await syncDirectory(dirname(path));
  return true;
}

/**
 * A hard-link marker makes stale-lock deletion a single-contender transition.
 * If a reclaimer is interrupted after publishing that marker, later starters
 * intentionally fail closed instead of guessing whether it was still active.
 */
async function reclaimDeadSameHostLease(root: string, lockPath: string): Promise<boolean> {
  const observed = await readLeaseRecord(root, lockPath);
  if (observed.hostname !== hostname() || !isDemonstrablyDead(observed.pid)) return false;

  const markerPath = `${lockPath}.reclaiming`;
  try {
    await linkLeaseAsReclaimMarker(lockPath, markerPath);
  } catch (error: unknown) {
    if (isNodeError(error, "EEXIST")) {
      await assertSafeReclaimMarker(root, markerPath);
      return false;
    }
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }

  let markerInfo;
  try {
    markerInfo = await lstat(markerPath);
    const currentInfo = await lstat(lockPath);
    assertRegularPrivateFile(markerInfo, "Creator store lease reclaim marker");
    assertRegularPrivateFile(currentInfo, "Creator store lease target");
    if (!sameFile(markerInfo, currentInfo))
      throw new Error("Creator store lease changed during stale-lock recovery");
    const current = await readLeaseRecord(root, lockPath);
    if (!sameLease(current, observed))
      throw new Error("Creator store lease changed during stale-lock recovery");
    if (current.hostname !== hostname() || !isDemonstrablyDead(current.pid)) return false;
    await unlink(lockPath);
    await syncDirectory(root);
    return true;
  } finally {
    if (markerInfo !== undefined) await removeOwnedReclaimMarker(root, markerPath, markerInfo);
  }
}

async function linkLeaseAsReclaimMarker(lockPath: string, markerPath: string): Promise<void> {
  const target = await lstat(lockPath);
  assertRegularPrivateFile(target, "Creator store lease target");
  await openAndCloseRegularLease(lockPath);
  await link(lockPath, markerPath);
}

async function assertSafeReclaimMarker(root: string, markerPath: string): Promise<void> {
  await assertSafeExistingStoreDirectory(root);
  const info = await lstat(markerPath);
  assertRegularPrivateFile(info, "Creator store lease reclaim marker");
  await openAndCloseRegularLease(markerPath);
}

async function removeOwnedReclaimMarker(
  root: string,
  markerPath: string,
  expected: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  await assertSafeExistingStoreDirectory(root);
  const current = await lstat(markerPath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (current === undefined) return;
  assertRegularPrivateFile(current, "Creator store lease reclaim marker");
  if (!sameFile(current, expected))
    throw new Error("Creator store lease reclaim marker changed unexpectedly");
  await unlink(markerPath);
  await syncDirectory(root);
}

async function readLeaseRecord(root: string, path: string): Promise<CreatorStoreLeaseRecord> {
  await assertSafeExistingStoreDirectory(root);
  const entry = await lstat(path);
  assertRegularPrivateFile(entry, "Creator store lease target");
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await descriptor.stat();
    assertRegularPrivateFile(info, "Creator store lease target");
    if (info.size <= 0 || info.size > MAX_LEASE_BYTES)
      throw new Error("Creator store lease has an invalid byte count");
    const serialized = await descriptor.readFile({ encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      throw new Error("Creator store lease is not valid JSON");
    }
    if (`${stableJson(parsed)}\n` !== serialized)
      throw new Error("Creator store lease JSON is not canonical");
    assertCreatorStoreLeaseRecord(parsed);
    return parsed;
  } finally {
    await descriptor.close();
  }
}

async function openAndCloseRegularLease(path: string): Promise<void> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertRegularPrivateFile(await descriptor.stat(), "Creator store lease target");
  } finally {
    await descriptor.close();
  }
}

function assertCreatorStoreLeaseRecord(value: unknown): asserts value is CreatorStoreLeaseRecord {
  if (!isRecord(value)) throw new Error("Invalid creator store lease");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "hostname,kind,pid,startedAt,token")
    throw new Error("Invalid creator store lease fields");
  if (
    value.kind !== LEASE_KIND ||
    typeof value.token !== "string" ||
    !TOKEN_PATTERN.test(value.token)
  )
    throw new Error("Invalid creator store lease token");
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0)
    throw new Error("Invalid creator store lease PID");
  if (
    typeof value.hostname !== "string" ||
    value.hostname.length === 0 ||
    value.hostname.length > 255 ||
    value.hostname !== value.hostname.trim() ||
    value.hostname.includes("\0")
  ) {
    throw new Error("Invalid creator store lease hostname");
  }
  if (typeof value.startedAt !== "string")
    throw new Error("Invalid creator store lease start time");
  const timestamp = Date.parse(value.startedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.startedAt)
    throw new Error("Invalid creator store lease start time");
}

function assertStoreDirectory(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("Creator store directory must be a non-empty path");
  const directory = resolve(value);
  if (directory === parse(directory).root)
    throw new Error("Creator store directory must not be a filesystem root");
  return directory;
}

async function ensureSafeStoreDirectory(directory: string): Promise<void> {
  const parsed = parse(directory);
  let current = parsed.root;
  const parts = directory.slice(parsed.root.length).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      assertSafeStoreDirectoryEntry(info, current);
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError: unknown) {
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
      }
      assertSafeStoreDirectoryEntry(await lstat(current), current);
    }
  }
}

async function assertSafeExistingStoreDirectory(directory: string): Promise<void> {
  const info = await lstat(directory).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) throw new Error("Creator store directory is missing");
    throw error;
  });
  assertSafeStoreDirectoryEntry(info, directory);
}

function assertSafeStoreDirectoryEntry(
  info: Awaited<ReturnType<typeof lstat>>,
  directory: string,
): void {
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`Unsafe creator store directory: ${directory}`);
}

function assertRegularPrivateFile(info: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file`);
  if ((Number(info.mode) & 0o777) !== 0o600) throw new Error(`${label} does not have mode 0600`);
}

function isDemonstrablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return isNodeError(error, "ESRCH");
  }
}

function sameLease(left: CreatorStoreLeaseRecord, right: CreatorStoreLeaseRecord): boolean {
  return (
    left.kind === right.kind &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.hostname === right.hostname &&
    left.startedAt === right.startedAt
  );
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function syncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, constants.O_RDONLY);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
