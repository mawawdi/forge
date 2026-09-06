import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".forge/bin/forge-roblox-credential-helper-v2");
mkdirSync(resolve(root, ".forge/bin"), { recursive: true, mode: 0o700 });
const result = spawnSync(
  "/usr/bin/xcrun",
  [
    "swiftc",
    "-O",
    "-framework",
    "Security",
    resolve(root, "workers/roblox-credentials/main.swift"),
    "-o",
    output,
  ],
  { cwd: root, encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
);
if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
chmodSync(output, 0o700);
process.stdout.write(`${output}\n`);
