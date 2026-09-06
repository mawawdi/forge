import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOfficialSourceAnalysisToolchain } from "../dist/packages/source-intelligence/src/index.js";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = [
  ["plugin", "plugin/default.project.json", "ForgeStudioPlugin.rbxmx"],
  ["status-beacon", "examples/status-beacon/default.project.json", "StatusBeacon.rbxlx"],
  ["door-control", "examples/door-control/default.project.json", "DoorControl.rbxlx"],
  ["last-light-clean", "examples/last-light/default.project.json", "LastLightClean.rbxlx"],
  [
    "studio-native-conformance",
    "test/fixtures/studio-native-conformance/default.project.json",
    "ForgeNativeConformance.rbxlx",
  ],
  [
    "orbital-freight-airlock",
    "examples/orbital-freight-airlock/default.project.json",
    "OrbitalFreightAirlock.rbxlx",
  ],
];
const execOptions = {
  cwd: root,
  maxBuffer: 4 * 1024 * 1024,
  windowsHide: true,
};

async function assertRegular(path, label) {
  const info = await lstat(path).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isFile())
    throw new Error(`${label} is not a regular file: ${path}`);
  return info;
}

async function main() {
  const toolchain = await assertOfficialSourceAnalysisToolchain(root);
  const rojo = toolchain.tools.find((tool) => tool.name === "rojo");
  if (!rojo) throw new Error("Verified source-analysis toolchain has no Rojo executable");
  const binary = rojo.executable;
  const requiredRojoVersion = rojo.version;
  await assertRegular(binary, "Verified pinned Rojo executable");
  const version = await execFile(binary, ["--version"], execOptions);
  const renderedVersion = `${version.stdout}\n${version.stderr}`.trim();
  if (
    !new RegExp(
      `(?:^|\\s)Rojo\\s+${requiredRojoVersion.replaceAll(".", "\\.")}(?:\\s|$)`,
      "m",
    ).test(renderedVersion)
  ) {
    throw new Error(
      `Expected verified Rojo ${requiredRojoVersion}, received: ${renderedVersion || "no version output"}`,
    );
  }

  const temporary = await mkdtemp(join(tmpdir(), "forge-rojo-check-"));
  try {
    for (const [name, project, filename] of projects) {
      const projectPath = resolve(root, project);
      await assertRegular(projectPath, `${name} project`);
      const output = resolve(temporary, filename);
      await execFile(binary, ["build", projectPath, "--output", output], execOptions);
      const artifact = await assertRegular(output, `${name} temporary Rojo build`);
      if (artifact.size === 0) throw new Error(`${name} temporary Rojo build is empty`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
  process.stdout.write(
    `Rojo check passed with pinned Rojo ${requiredRojoVersion}: ${projects.map(([name]) => name).join(", ")}\n`,
  );
}

await main();
