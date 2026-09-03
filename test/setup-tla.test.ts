import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

interface PinnedContent {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface PinnedTlaSetup {
  ensurePinnedTlaTools(input: {
    readonly directory: string;
    readonly lock: PinnedContent;
    readonly attempts?: number;
    readonly attemptTimeoutMs?: number;
    readonly retryDelayMs?: number;
    readonly fetchImpl?: (
      url: string,
      options: { readonly signal: AbortSignal },
    ) => Promise<Response>;
    readonly onRetry?: (input: {
      readonly attempt: number;
      readonly attempts: number;
      readonly delayMs: number;
      readonly error: unknown;
    }) => void;
  }): Promise<{ readonly status: "ready" | "installed"; readonly target: string }>;
}

const { ensurePinnedTlaTools } = (await import(
  resolve(process.cwd(), "scripts/setup-tla.mjs")
)) as PinnedTlaSetup;

function fixture(content = Buffer.from("pinned TLA+ fixture", "utf8")) {
  return {
    content,
    lock: {
      url: "https://example.invalid/tla2tools.jar",
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
    },
  };
}

test("TLA+ setup retries transient network and 5xx failures before atomically publishing pinned bytes", async () => {
  const root = await mkdtemp(join(process.cwd(), ".forge-tla-test-"));
  const directory = join(root, "tooling", "tla", "fixture");
  const { content, lock } = fixture();
  const failures: (Error | Response)[] = [
    new TypeError("fetch failed"),
    new Response("unavailable", { status: 503, statusText: "Service Unavailable" }),
    new Response(content),
  ];
  let fetches = 0;
  const retries: { readonly attempt: number; readonly delayMs: number }[] = [];

  try {
    const installed = await ensurePinnedTlaTools({
      directory,
      lock,
      attempts: 3,
      attemptTimeoutMs: 1,
      retryDelayMs: 0,
      fetchImpl: async (_url, options) => {
        assert.equal(options.signal.aborted, false);
        const next = failures[fetches++];
        if (next instanceof Error) throw next;
        return next!;
      },
      onRetry: ({ attempt, delayMs }) => retries.push({ attempt, delayMs }),
    });
    assert.equal(installed.status, "installed");
    assert.equal(fetches, 3);
    assert.deepEqual(retries, [
      { attempt: 1, delayMs: 0 },
      { attempt: 2, delayMs: 0 },
    ]);
    const reused = await ensurePinnedTlaTools({
      directory,
      lock,
      attempts: 1,
      attemptTimeoutMs: 1,
      fetchImpl: async () => {
        throw new Error("verified cache must not fetch");
      },
    });
    assert.equal(reused.status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TLA+ setup retries 429 but does not retry other 4xx responses or accept a symlinked target", async () => {
  const root = await mkdtemp(join(process.cwd(), ".forge-tla-test-"));
  const directory = join(root, "tooling", "tla", "fixture");
  const { content, lock } = fixture();
  let fetches = 0;

  try {
    const rateLimited = await ensurePinnedTlaTools({
      directory,
      lock,
      attempts: 2,
      attemptTimeoutMs: 1,
      retryDelayMs: 0,
      fetchImpl: async () => {
        fetches += 1;
        return fetches === 1
          ? new Response("limited", { status: 429, statusText: "Too Many Requests" })
          : new Response(content);
      },
    });
    assert.equal(rateLimited.status, "installed");
    assert.equal(fetches, 2);
    await unlink(join(directory, "tla2tools.jar"));
    fetches = 0;
    await assert.rejects(
      ensurePinnedTlaTools({
        directory,
        lock,
        attempts: 3,
        attemptTimeoutMs: 1,
        retryDelayMs: 0,
        fetchImpl: async () => {
          fetches += 1;
          return new Response("missing", { status: 404, statusText: "Not Found" });
        },
      }),
      /404 Not Found/,
    );
    assert.equal(fetches, 1);

    await writeFile(join(directory, "tla2tools.jar"), Buffer.alloc(content.byteLength, 0x61));
    await assert.rejects(
      ensurePinnedTlaTools({
        directory,
        lock,
        fetchImpl: async () => {
          throw new Error("mismatched cache must not fetch");
        },
      }),
      /SHA-256 mismatch/,
    );
    await unlink(join(directory, "tla2tools.jar"));
    await writeFile(join(root, "other.jar"), content);
    await symlink(join(root, "other.jar"), join(directory, "tla2tools.jar"));
    await assert.rejects(
      ensurePinnedTlaTools({
        directory,
        lock,
        fetchImpl: async () => {
          throw new Error("symlinked cache must not fetch");
        },
      }),
      /not a regular file/,
    );
  } finally {
    await unlink(join(directory, "tla2tools.jar")).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
