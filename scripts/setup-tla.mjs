import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { parse, resolve, sep } from "node:path";

const root = resolve(process.cwd());
const lockPath = resolve(root, "formal/tla-tools.lock.json");
const lock = await readLock(lockPath);
const targetDirectory = resolve(root, ".forge/tooling/tla", `v${lock.version}`);
const target = resolve(targetDirectory, "tla2tools.jar");

await ensureSafeDirectory(targetDirectory);
if (await isVerifiedRegularFile(target, lock)) {
  process.stdout.write(`TLA+ ${lock.version} is ready at ${target}\n`);
  process.exit(0);
}
await rejectExistingUnsafeFile(target);

const response = await fetch(lock.url, { redirect: "follow" });
if (!response.ok) throw new Error(`Unable to download TLA+ tools (${response.status} ${response.statusText})`);
const content = Buffer.from(await response.arrayBuffer());
if (content.byteLength !== lock.bytes) throw new Error(`Downloaded TLA+ tools size mismatch (${content.byteLength} != ${lock.bytes})`);
if (sha256(content) !== lock.sha256) throw new Error("Downloaded TLA+ tools SHA-256 mismatch");

const temporary = resolve(targetDirectory, `.tla2tools.${randomUUID()}.tmp`);
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
  if (!(await isVerifiedRegularFile(target, lock))) throw new Error("Concurrent TLA+ tools installation did not produce the pinned JAR");
} finally {
  await unlink(temporary).catch((error) => {
    if (!isMissing(error)) throw error;
  });
}
if (!(await isVerifiedRegularFile(target, lock))) throw new Error("Atomic TLA+ tools installation verification failed");
process.stdout.write(`Installed pinned TLA+ ${lock.version} at ${target}\n`);

async function readLock(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value) || value.kind !== "ForgeTlaToolsLock" || value.version !== "1.7.4" || value.url !== "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar" || value.sha256 !== "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88" || value.bytes !== 2274532) throw new Error("Invalid pinned TLA+ tools lock");
  return value;
}

async function ensureSafeDirectory(directory) {
  const absolute = resolve(directory);
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const info = await lstat(current).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe TLA+ directory: ${current}`);
      continue;
    }
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (!isAlreadyExists(error)) throw error;
    });
    const created = await lstat(current);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error(`Unsafe TLA+ directory: ${current}`);
  }
}

async function rejectExistingUnsafeFile(path) {
  const info = await lstat(path).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
  if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error("Pinned TLA+ JAR target is not a regular file");
}

async function isVerifiedRegularFile(path, expected) {
  const info = await lstat(path).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Pinned TLA+ JAR target is not a regular file");
  if (info.size !== expected.bytes) return false;
  return sha256(await readFile(path)) === expected.sha256;
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
