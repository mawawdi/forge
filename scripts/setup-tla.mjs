import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 15_000;
const DOWNLOAD_RETRY_DELAY_MS = 500;

if (isMainModule()) {
  await main();
}

async function main() {
  const root = resolve(process.cwd());
  const lock = await readLock(resolve(root, "formal/tla-tools.lock.json"));
  const targetDirectory = resolve(root, ".forge/tooling/tla", `v${lock.version}`);
  const result = await ensurePinnedTlaTools({ directory: targetDirectory, lock });
  process.stdout.write(
    result.status === "ready"
      ? `TLA+ ${lock.version} is ready at ${result.target}\n`
      : `Installed pinned TLA+ ${lock.version} at ${result.target}\n`,
  );
}

/**
 * Reuses only a verified regular JAR. Network access is reserved for an absent
 * target; malformed or mismatched local material is an integrity failure.
 */
export async function ensurePinnedTlaTools(input) {
  const directory = resolve(input.directory);
  const target = resolve(directory, "tla2tools.jar");
  const lock = validatePinnedContent(input.lock);
  const attempts = boundedPositiveInteger(
    input.attempts ?? DOWNLOAD_ATTEMPTS,
    "TLA+ download attempts",
    DOWNLOAD_ATTEMPTS,
  );
  const attemptTimeoutMs = boundedPositiveInteger(
    input.attemptTimeoutMs ?? DOWNLOAD_ATTEMPT_TIMEOUT_MS,
    "TLA+ download attempt timeout",
    DOWNLOAD_ATTEMPT_TIMEOUT_MS,
  );
  const retryDelayMs = boundedNonNegativeInteger(
    input.retryDelayMs ?? DOWNLOAD_RETRY_DELAY_MS,
    "TLA+ download retry delay",
    DOWNLOAD_RETRY_DELAY_MS,
  );
  const fetchImpl = input.fetchImpl ?? fetch;
  const onRetry = input.onRetry ?? defaultRetryNotice;

  await ensureSafeDirectory(directory);
  if ((await verifiedRegularFileState(target, lock)) === "verified")
    return { status: "ready", target };

  const content = await downloadPinnedContent(lock, {
    fetchImpl,
    attempts,
    attemptTimeoutMs,
    retryDelayMs,
    onRetry,
  });
  await publishRegularFile(directory, target, content, lock);
  if ((await verifiedRegularFileState(target, lock)) !== "verified")
    throw new Error("Atomic TLA+ tools installation verification failed");
  return { status: "installed", target };
}

async function downloadPinnedContent(lock, options) {
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const response = await options.fetchImpl(lock.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(options.attemptTimeoutMs),
      });
      if (!response.ok) {
        const error = new Error(
          `Unable to download TLA+ tools (${response.status} ${response.statusText})`,
        );
        if (!isRetryableStatus(response.status)) throw error;
        throw new RetryableDownloadError(error.message, { cause: error });
      }
      const content = Buffer.from(await response.arrayBuffer());
      if (content.byteLength !== lock.bytes)
        throw new Error(
          `Downloaded TLA+ tools size mismatch (${content.byteLength} != ${lock.bytes})`,
        );
      if (sha256(content) !== lock.sha256)
        throw new Error("Downloaded TLA+ tools SHA-256 mismatch");
      return content;
    } catch (error) {
      if (!(error instanceof RetryableDownloadError) && !isTransientFetchError(error)) throw error;
      if (attempt === options.attempts)
        throw new Error(
          `Unable to download TLA+ tools after ${options.attempts} attempts: ${errorMessage(error)}`,
          { cause: error },
        );
      const delayMs = options.retryDelayMs * 2 ** (attempt - 1);
      options.onRetry({ attempt, attempts: options.attempts, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw new Error("TLA+ download retry loop ended unexpectedly");
}

async function publishRegularFile(directory, target, content, lock) {
  const temporary = resolve(directory, `.tla2tools.${randomUUID()}.tmp`);
  const descriptor = await open(temporary, "wx", 0o600);
  try {
    await descriptor.writeFile(content);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  try {
    await link(temporary, target);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    if ((await verifiedRegularFileState(target, lock)) !== "verified")
      throw new Error("Concurrent TLA+ tools installation did not produce the pinned JAR", {
        cause: error,
      });
  } finally {
    await unlink(temporary).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function readLock(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    !isRecord(value) ||
    value.kind !== "ForgeTlaToolsLock" ||
    value.version !== "1.7.4" ||
    value.url !== "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar" ||
    value.sha256 !== "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88" ||
    value.bytes !== 2274532
  )
    throw new Error("Invalid pinned TLA+ tools lock");
  return value;
}

async function ensureSafeDirectory(directory) {
  const absolute = resolve(directory);
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const info = await lstat(current).catch((error) =>
      isMissing(error) ? undefined : Promise.reject(error),
    );
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe TLA+ directory: ${current}`);
      continue;
    }
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (!isAlreadyExists(error)) throw error;
    });
    const created = await lstat(current);
    if (created.isSymbolicLink() || !created.isDirectory())
      throw new Error(`Unsafe TLA+ directory: ${current}`);
  }
}

async function verifiedRegularFileState(path, expected) {
  const info = await lstat(path).catch((error) =>
    isMissing(error) ? undefined : Promise.reject(error),
  );
  if (!info) return "missing";
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error("Pinned TLA+ JAR target is not a regular file");
  if (info.size !== expected.bytes) throw new Error("Pinned TLA+ JAR size mismatch");
  if (sha256(await readFile(path)) !== expected.sha256)
    throw new Error("Pinned TLA+ JAR SHA-256 mismatch");
  return "verified";
}

function validatePinnedContent(value) {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0
  )
    throw new Error("Invalid pinned TLA+ tools download");
  return value;
}

function boundedPositiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new Error(`Invalid ${label}`);
  return value;
}

function boundedNonNegativeInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`Invalid ${label}`);
  return value;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isTransientFetchError(error) {
  if (error instanceof RetryableDownloadError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError" || error instanceof TypeError)
    return true;
  const code = errorCode(error);
  return (
    code === "ECONNABORTED" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    code === "ENETDOWN" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_TIMEOUT"
  );
}

function errorCode(error) {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return code;
  }
  if (typeof error === "object" && error !== null && "cause" in error)
    return errorCode(error.cause);
  return undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function defaultRetryNotice({ attempt, attempts, delayMs, error }) {
  process.stderr.write(
    `TLA+ tools download attempt ${attempt}/${attempts} failed (${errorMessage(error)}); retrying in ${delayMs}ms.\n`,
  );
}

function sleep(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

function isMainModule() {
  return (
    process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

class RetryableDownloadError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RetryableDownloadError";
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
