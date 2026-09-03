import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableJson } from "../packages/contracts/src/index.js";
import {
  CREATOR_STORE_LEASE_FILENAME,
  acquireCreatorStoreLease,
  creatorStoreLeasePath,
} from "../packages/creator-control/src/store-lease.js";

const STARTED_AT = "2026-09-03T10:00:00.000Z";

test("creator store lease is exclusive, private, and idempotently released", async () => {
  await withLeaseDirectory(async (root) => {
    const lease = await acquireCreatorStoreLease(root);
    const path = creatorStoreLeasePath(root);
    assert.equal(path, join(root, CREATOR_STORE_LEASE_FILENAME));
    assert.equal(lease.lockPath, path);
    assert.equal(lease.storeDirectory, root);
    assert.equal(lease.pid, process.pid);
    assert.equal(lease.hostname, hostname());
    assert.match(lease.token, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(lease.startedAt)));

    const info = await lstat(path);
    assert.ok(info.isFile());
    assert.equal(info.mode & 0o777, 0o600);
    const persisted = JSON.parse(await readFile(path, "utf8")) as { token: string; pid: number };
    assert.equal(persisted.token, lease.token);
    assert.equal(persisted.pid, process.pid);
    await assert.rejects(acquireCreatorStoreLease(root), /already leased/i);

    await lease.release();
    await lease.release();
    await assert.rejects(lstat(path), { code: "ENOENT" });
  });
});

test("creator store lease reclaims only a demonstrably dead same-host owner", async () => {
  await withLeaseDirectory(async (root) => {
    const stale = leaseRecord({ pid: demonstrablyDeadPid(), hostname: hostname() });
    await writeLease(root, stale);
    const recovered = await acquireCreatorStoreLease(root);
    assert.notEqual(recovered.token, stale.token);
    await recovered.release();

    const active = leaseRecord({ pid: process.pid, hostname: hostname() });
    await writeLease(root, active);
    await assert.rejects(acquireCreatorStoreLease(root), /already leased/i);
    assert.deepEqual(JSON.parse(await readFile(creatorStoreLeasePath(root), "utf8")), active);
    await unlink(creatorStoreLeasePath(root));

    const foreign = leaseRecord({ pid: demonstrablyDeadPid(), hostname: "other-host.invalid" });
    await writeLease(root, foreign);
    await assert.rejects(acquireCreatorStoreLease(root), /already leased/i);
    assert.deepEqual(JSON.parse(await readFile(creatorStoreLeasePath(root), "utf8")), foreign);
  });
});

test("creator store lease fails closed for symbolic links and irregular targets", async () => {
  await withLeaseDirectory(async (root) => {
    const path = creatorStoreLeasePath(root);
    const target = join(root, "other-private-file");
    await writeFile(target, "private\n", { encoding: "utf8", mode: 0o600 });
    await chmod(target, 0o600);
    await symlink(target, path);
    await assert.rejects(acquireCreatorStoreLease(root), /not a regular file/i);
    await unlink(path);

    await mkdir(path, { mode: 0o700 });
    await assert.rejects(acquireCreatorStoreLease(root), /not a regular file/i);
    await rm(path, { recursive: true, force: true });

    await writeLease(root, leaseRecord({ pid: process.pid, hostname: hostname() }));
    await chmod(path, 0o644);
    await assert.rejects(acquireCreatorStoreLease(root), /mode 0600/i);
    await unlink(path);

    const linkedStore = join(root, "linked-store");
    await symlink(root, linkedStore);
    await assert.rejects(acquireCreatorStoreLease(linkedStore), /unsafe creator store directory/i);
  });
});

test("creator store lease release is token-bound and leaves a replacement owner intact", async () => {
  await withLeaseDirectory(async (root) => {
    const lease = await acquireCreatorStoreLease(root);
    const replacement = leaseRecord({ pid: process.pid, hostname: hostname() });
    await writeLease(root, replacement);

    await assert.rejects(lease.release(), /ownership changed/i);
    assert.deepEqual(JSON.parse(await readFile(creatorStoreLeasePath(root), "utf8")), replacement);
  });
});

async function withLeaseDirectory(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "forge-creator-store-lease-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function leaseRecord(input: { readonly pid: number; readonly hostname: string }) {
  return {
    kind: "ForgeCreatorStoreLease" as const,
    token: randomUUID(),
    pid: input.pid,
    hostname: input.hostname,
    startedAt: STARTED_AT,
  };
}

async function writeLease(root: string, record: ReturnType<typeof leaseRecord>): Promise<void> {
  const path = creatorStoreLeasePath(root);
  await writeFile(path, `${stableJson(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function demonstrablyDeadPid(): number {
  const candidate = 2_147_483_647;
  try {
    process.kill(candidate, 0);
  } catch (error: unknown) {
    if (isNodeError(error, "ESRCH")) return candidate;
    throw error;
  }
  throw new Error(`Expected PID ${candidate} to be absent`);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
