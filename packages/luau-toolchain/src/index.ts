import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { VerificationIssue } from "../../contracts/src/index.js";

export interface LuauAnalysisResult {
  tool: { name: "luau-analyze"; version: string; command: string; configHash: string };
  issues: VerificationIssue[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function analyzeWithOfficialLuau(root: string, files: string[]): LuauAnalysisResult {
  const executable = resolveExecutable();
  if (!executable) {
    return {
      tool: { name: "luau-analyze", version: "unavailable", command: "luau-analyze --formatter=gnu --mode=strict", configHash: hash("missing") },
      issues: [toolIssue("Official luau-analyze was not found. Install Luau or set FORGE_LUAU_ANALYZE; no parser fallback is allowed.")],
      exitCode: 127,
      stdout: "",
      stderr: ""
    };
  }
  const relativeFiles = [...files].sort((a, b) => a.localeCompare(b));
  const args = ["--formatter=gnu", "--mode=strict", ...relativeFiles.map((file) => resolve(root, file))];
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}${stderr}`;
  const issues = parseDiagnostics(output, root);
  if (result.error) issues.push(toolIssue(`luau-analyze failed to start: ${result.error.message}`));
  if (result.status !== 0 && issues.length === 0) issues.push(toolIssue(`luau-analyze exited with code ${result.status ?? "unknown"} without a parseable diagnostic.`));
  const exitCode = typeof result.status === "number" ? result.status : result.error ? 127 : 1;
  return { tool: { name: "luau-analyze", version: readVersion(executable), command: `luau-analyze --formatter=gnu --mode=strict ${relativeFiles.join(" ")}`, configHash: hash(readConfig(root)) }, issues, exitCode, stdout, stderr };
}

function resolveExecutable(): string | null {
  const configured = process.env.FORGE_LUAU_ANALYZE;
  if (configured) return existsSync(configured) ? resolve(configured) : null;
  const lookup = spawnSync("sh", ["-lc", "command -v luau-analyze"], { encoding: "utf8" });
  const candidate = lookup.status === 0 ? lookup.stdout.trim() : "";
  return candidate || null;
}

function readVersion(executable: string): string {
  if (process.env.FORGE_LUAU_ANALYZE_VERSION) return process.env.FORGE_LUAU_ANALYZE_VERSION;
  try {
    return `binary-sha256:${hash(readFileSync(executable).toString("base64"))}`;
  } catch {
    return "unknown";
  }
}

function readConfig(root: string): string {
  const config = resolve(root, ".luaurc");
  return existsSync(config) ? readFileSync(config, "utf8") : "no-config";
}

function parseDiagnostics(output: string, root: string): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.*?):(\d+)(?:\.(\d+)(?:-\d+\.\d+)?)?:\s*(?:(TypeError|SyntaxError|Warning|Info):\s*)?(.*)$/);
    if (!match?.[1] || !match[2] || !match[5]) continue;
    const absolutePath = resolve(match[1]);
    const path = absolutePath.startsWith(`${resolve(root)}/`) ? absolutePath.slice(resolve(root).length + 1) : match[1];
    const level = match[4] ?? "Error";
    const message = match[5].trim();
    const severity = level === "Warning" || level === "Info" ? level.toLowerCase() as "warning" | "info" : "error";
    const column = match[3] ? Number(match[3]) : 1;
    issues.push({ kind: "VerificationIssue", schemaVersion: 1, id: issueId("LUAU_ANALYZER", path, Number(match[2]), message), ruleId: classifyLuauMessage(level, message), severity, category: "language", message, path, location: { line: Number(match[2]), column }, evidence: [{ type: "analyzer", statement: `luau-analyze reported: ${level}: ${message}` }], authoritativeTier: "static" });
  }
  return issues;
}

function classifyLuauMessage(level: string, message: string): string {
  if (level === "TypeError") return "LUAU_TYPE_ERROR";
  if (level === "SyntaxError") return "LUAU_PARSE_ERROR";
  const lower = message.toLowerCase();
  if (lower.includes("syntax") || lower.includes("parse")) return "LUAU_PARSE_ERROR";
  if (lower.includes("unknown global") || lower.includes("type") || lower.includes("cannot convert") || lower.includes("not enough arguments") || lower.includes("expected")) return "LUAU_TYPE_ERROR";
  return "LUAU_ANALYZER_ERROR";
}

function toolIssue(message: string): VerificationIssue {
  return { kind: "VerificationIssue", schemaVersion: 1, id: issueId("TOOLING", "", 0, message), ruleId: "TOOLCHAIN_UNAVAILABLE", severity: "error", category: "tooling", message, evidence: [{ type: "analyzer", statement: message }], authoritativeTier: "static" };
}

function issueId(ruleId: string, path: string, line: number, message: string): string {
  return `${ruleId}:${hash(`${ruleId}|${path}|${line}|${message}`).slice(0, 16)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
