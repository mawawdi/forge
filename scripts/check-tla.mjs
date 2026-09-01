import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const lock = await readLock(resolve(root, "formal/tla-tools.lock.json"));
const jar = resolve(root, ".forge/tooling/tla", `v${lock.version}`, "tla2tools.jar");
await assertVerifiedJar(jar, lock);
await assertJava11OrLater();

const metadir = await mkdtemp(join(tmpdir(), "forge-tlc-"));
try {
  await run("java", [
    "-cp", jar,
    "tlc2.TLC",
    "-workers", "1",
    "-deadlock",
    "-metadir", metadir,
    "-config", resolve(root, "formal/CreatorMutationTransaction.cfg"),
    resolve(root, "formal/CreatorMutationTransaction.tla"),
  ], root);
} finally {
  await rm(metadir, { recursive: true, force: true });
}
process.stdout.write("TLC completed the CreatorMutationTransaction model with one worker.\n");

async function readLock(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value) || value.kind !== "ForgeTlaToolsLock" || value.version !== "1.7.4" || value.url !== "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar" || value.sha256 !== "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88" || value.bytes !== 2274532) throw new Error("Invalid pinned TLA+ tools lock");
  return value;
}

async function assertVerifiedJar(path, expected) {
  const info = await lstat(path).catch((error) => {
    if (isMissing(error)) throw new Error("Pinned TLA+ JAR is missing. Run npm run formal:setup first.");
    throw error;
  });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Pinned TLA+ JAR is not a regular file");
  if (info.size !== expected.bytes) throw new Error("Pinned TLA+ JAR size mismatch");
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== expected.sha256) throw new Error("Pinned TLA+ JAR SHA-256 mismatch");
}

async function assertJava11OrLater() {
  const result = await capture("java", ["-version"]);
  if (result.code !== 0) throw new Error(`Java is required for TLC: ${result.output.trim()}`);
  const match = result.output.match(/(?:version|openjdk)\s+"?(\d+)(?:\.(\d+))?/i);
  const major = match ? (Number(match[1]) === 1 ? Number(match[2]) : Number(match[1])) : Number.NaN;
  if (!Number.isInteger(major) || major < 11) throw new Error(`Java 11 or newer is required for TLC (found: ${result.output.trim()})`);
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`TLC failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ code: code ?? 1, output }));
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
