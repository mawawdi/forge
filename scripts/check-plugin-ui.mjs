import { execFile as callbackExecFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(callbackExecFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "forge-plugin-ui-types-"));
const sourcemap = join(temporary, "plugin.json");
const options = { cwd: join(root, "plugin"), maxBuffer: 4 * 1024 * 1024 };

try {
  // A native plugin is a Script tree, not a running Studio DataModel.
  // Rojo's map resolves sibling ModuleScripts for static analysis only.
  await execFile("rojo", ["sourcemap", "default.project.json", "--output", sourcemap], options);
  await execFile(
    "luau-lsp",
    [
      "analyze",
      "--sourcemap",
      sourcemap,
      "--definitions",
      join(root, "packages/luau-toolchain/roblox/globalTypes.d.luau"),
      "src/Forge/ConnectorPresentation.luau",
      "src/Forge/ConnectorView.luau",
    ],
    options,
  );
  process.stdout.write("Native connector UI type analysis passed\n");
} catch (error) {
  process.stderr.write(String(error.stdout ?? "") + String(error.stderr ?? ""));
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
