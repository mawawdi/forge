#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const entrypoint = resolve(import.meta.dirname, "../dist/packages/cli/src/index.js");
if (!existsSync(entrypoint)) {
  process.stderr.write("Forge is not built. Run npm run build first.\n");
  process.exit(2);
}

const child = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
