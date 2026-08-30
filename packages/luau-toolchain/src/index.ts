import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import type { VerificationIssue, VerificationReport } from "../../contracts/src/index.js";

type ToolRecord = VerificationReport["toolchain"][number];
type TierStatus = "pass" | "fail" | "unavailable";

export interface LuauAnalysisTier {
  name: "official_luau_syntax" | "roblox_type_analysis";
  status: TierStatus;
  issueIds: string[];
}

export interface LuauAnalysisResult {
  tools: ToolRecord[];
  tiers: [LuauAnalysisTier, LuauAnalysisTier];
  issues: VerificationIssue[];
  stdout: string;
  stderr: string;
}

interface DefinitionMetadata {
  kind: "RobloxTypeDefinitions";
  schemaVersion: 1;
  source: string;
  sourceCommit: string;
  luauLspVersion: string;
  sha256: string;
}

export function analyzeWithRobloxLuau(root: string, files: string[]): LuauAnalysisResult {
  const canonicalRoot = resolve(root);
  const relativeFiles = [...files].sort((left, right) => left.localeCompare(right));
  const syntax = analyzeSyntax(canonicalRoot, relativeFiles);
  if (syntax.status !== "pass") {
    return {
      tools: syntax.tools,
      tiers: [tier("official_luau_syntax", syntax.status, syntax.issues), tier("roblox_type_analysis", "unavailable", [])],
      issues: syntax.issues,
      stdout: syntax.stdout,
      stderr: syntax.stderr
    };
  }
  const roblox = analyzeRobloxTypes(canonicalRoot, relativeFiles);
  return {
    tools: [...syntax.tools, ...roblox.tools],
    tiers: [tier("official_luau_syntax", "pass", syntax.issues), tier("roblox_type_analysis", roblox.status, roblox.issues)],
    issues: [...syntax.issues, ...roblox.issues],
    stdout: `${syntax.stdout}${roblox.stdout}`,
    stderr: `${syntax.stderr}${roblox.stderr}`
  };
}

function analyzeSyntax(root: string, files: string[]): { status: TierStatus; tools: ToolRecord[]; issues: VerificationIssue[]; stdout: string; stderr: string } {
  const executable = resolveExecutable("FORGE_LUAU_COMPILE", "luau-compile");
  if (!executable) {
    const issue = toolIssue("LUAU_SYNTAX_TOOL_UNAVAILABLE", "Official luau-compile was not found. Install Luau or set FORGE_LUAU_COMPILE; no parser fallback is allowed.");
    return { status: "unavailable", tools: [], issues: [issue], stdout: "", stderr: "" };
  }
  const version = `binary-sha256:${binaryHash(executable)}`;
  const tools: ToolRecord[] = [{ name: "luau-compile", version, command: "luau-compile --only-parse <files>", configHash: hash("official-luau-syntax-v1") }];
  const issues: VerificationIssue[] = [];
  let stdout = "";
  let stderr = "";
  let failed = false;
  for (const file of files) {
    const result = spawnSync(executable, ["--only-parse", resolve(root, file)], { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    stdout += result.stdout ?? "";
    stderr += result.stderr ?? "";
    issues.push(...parseCompilerDiagnostics(`${result.stdout ?? ""}${result.stderr ?? ""}`, root));
    if (result.error) issues.push(toolIssue("LUAU_SYNTAX_TOOL_UNAVAILABLE", `luau-compile failed to start: ${result.error.message}`));
    if (result.status !== 0 || result.error) failed = true;
  }
  if (failed && issues.length === 0) issues.push(toolIssue("LUAU_SYNTAX_TOOL_FAILURE", "luau-compile failed without a parseable diagnostic."));
  return { status: issues.some((issue) => issue.category === "tooling") ? "unavailable" : failed ? "fail" : "pass", tools, issues, stdout, stderr };
}

function analyzeRobloxTypes(root: string, files: string[]): { status: TierStatus; tools: ToolRecord[]; issues: VerificationIssue[]; stdout: string; stderr: string } {
  const executable = resolveExecutable("FORGE_LUAU_LSP", "luau-lsp", ["--version"]);
  const rojo = resolveExecutable("FORGE_ROJO", "rojo", ["--version"]);
  const definitionPath = resolveDefinitionsPath();
  const metadataPath = resolveDefinitionMetadataPath();
  if (!executable || !rojo || !definitionPath || !metadataPath) {
    const missing = [!executable ? "luau-lsp" : "", !rojo ? "rojo" : "", !definitionPath || !metadataPath ? "pinned Roblox definitions" : ""].filter(Boolean).join(", ");
    return unavailable(`Roblox-aware type analysis is unavailable: missing ${missing}. Install the pinned Rokit tools and retain the vendored definitions; Forge will not attribute host-type failures to source.`);
  }

  let metadata: DefinitionMetadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as DefinitionMetadata;
  } catch {
    return unavailable("Pinned Roblox definition metadata is unreadable.");
  }
  const definitionsHash = hash(readFileSync(definitionPath));
  if (metadata.kind !== "RobloxTypeDefinitions" || metadata.schemaVersion !== 1 || metadata.sha256 !== definitionsHash) {
    return unavailable(`Pinned Roblox definitions failed integrity validation (expected ${metadata.sha256}, observed ${definitionsHash}).`);
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "forge-roblox-analysis-"));
  try {
    const sourcemapPath = join(temporaryRoot, "sourcemap.json");
    const projectPath = existingProjectPath(root) ?? writeSyntheticProject(temporaryRoot, root, files);
    const sourcemap = spawnSync(rojo, ["sourcemap", projectPath, "--output", sourcemapPath], { cwd: toolExecutionRoot(), encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (sourcemap.error || sourcemap.status !== 0 || !existsSync(sourcemapPath)) {
      const detail = `${sourcemap.stdout ?? ""}${sourcemap.stderr ?? ""}`.trim();
      return unavailable(`Rojo sourcemap generation failed${detail ? `: ${detail}` : "."}`);
    }
    const sourcemapHash = hash(readFileSync(sourcemapPath));
    const configPath = resolve(root, ".luaurc");
    const args = [
      "analyze", "--formatter=gnu", "--platform=roblox",
      `--definitions=@roblox=${definitionPath}`,
      `--sourcemap=${sourcemapPath}`,
      ...(existsSync(configPath) ? [`--base-luaurc=${configPath}`] : []),
      ...files.map((file) => resolve(root, file))
    ];
    const result = spawnSync(executable, args, { cwd: toolExecutionRoot(), encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const issues = parseLspDiagnostics(`${stdout}${stderr}`, root);
    if (result.error) issues.push(toolIssue("ROBLOX_TYPE_ENV_UNAVAILABLE", `luau-lsp failed to start: ${result.error.message}`));
    if (result.status !== 0 && issues.length === 0) issues.push(toolIssue("ROBLOX_TYPE_TOOL_FAILURE", `luau-lsp exited with code ${result.status ?? "unknown"} without a parseable diagnostic.`));
    const lspVersion = executableVersion(executable, ["--version"]);
    const rojoVersion = executableVersion(rojo, ["--version"]);
    const configHash = hash(JSON.stringify({ platform: "roblox", definitionsHash, sourcemapHash, luaurcHash: existsSync(configPath) ? hash(readFileSync(configPath)) : hash("no-config") }));
    const tools: ToolRecord[] = [
      { name: "luau-lsp-roblox", version: `${lspVersion}+binary-${binaryHash(executable).slice(0, 16)}`, command: "luau-lsp analyze --platform=roblox --definitions=@roblox --sourcemap=<generated> --formatter=gnu <files>", configHash },
      { name: "roblox-global-types", version: `luau-lsp-${metadata.luauLspVersion}@${metadata.sourceCommit}`, command: metadata.source, configHash: definitionsHash },
      { name: "rojo-sourcemap", version: `${rojoVersion}+binary-${binaryHash(rojo).slice(0, 16)}`, command: "rojo sourcemap <project> --output <temporary>", configHash: sourcemapHash }
    ];
    return { status: issues.some((issue) => issue.category === "tooling") ? "unavailable" : result.status === 0 ? "pass" : "fail", tools, issues, stdout, stderr };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  function unavailable(message: string): { status: "unavailable"; tools: ToolRecord[]; issues: VerificationIssue[]; stdout: string; stderr: string } {
    return { status: "unavailable", tools: [], issues: [toolIssue("ROBLOX_TYPE_ENV_UNAVAILABLE", message)], stdout: "", stderr: "" };
  }
}

function writeSyntheticProject(temporaryRoot: string, root: string, files: string[]): string {
  const tree: Record<string, unknown> = { $className: "DataModel" };
  for (const file of files) {
    const name = basename(file).replace(/\.(server|client)?\.?lua(u)?$/, "").replace(/[^A-Za-z0-9_]/g, "_");
    const absolutePath = resolve(root, file);
    if (file.endsWith(".server.luau") || file.endsWith(".server.lua") || file.includes("ServerScriptService")) {
      const service = child(tree, "ServerScriptService", "ServerScriptService");
      service[uniqueName(service, name)] = { $path: absolutePath };
    } else if (file.endsWith(".client.luau") || file.endsWith(".client.lua") || file.includes("StarterPlayerScripts")) {
      const starterPlayer = child(tree, "StarterPlayer", "StarterPlayer");
      const scripts = child(starterPlayer, "StarterPlayerScripts", "StarterPlayerScripts");
      scripts[uniqueName(scripts, name)] = { $path: absolutePath };
    } else {
      const storage = child(tree, "ReplicatedStorage", "ReplicatedStorage");
      storage[uniqueName(storage, name)] = { $path: absolutePath };
    }
  }
  const path = join(temporaryRoot, "default.project.json");
  writeFileSync(path, JSON.stringify({ name: "ForgeRobloxAnalysis", tree }));
  return path;
}

function child(parent: Record<string, unknown>, name: string, className: string): Record<string, unknown> {
  const existing = parent[name];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) return existing as Record<string, unknown>;
  const value: Record<string, unknown> = { $className: className };
  parent[name] = value;
  return value;
}

function uniqueName(parent: Record<string, unknown>, preferred: string): string {
  let candidate = preferred || "Script";
  let suffix = 2;
  while (candidate in parent) { candidate = `${preferred}_${suffix}`; suffix += 1; }
  return candidate;
}

function existingProjectPath(root: string): string | null {
  const project = resolve(root, "default.project.json");
  return existsSync(project) ? project : null;
}

function parseCompilerDiagnostics(output: string, root: string): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.*?)\((\d+),(\d+)\):\s*(SyntaxError|TypeError|Error):\s*(.*)$/);
    if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) continue;
    const path = relativePath(root, match[1]);
    const location = { line: Number(match[2]), column: Number(match[3]) };
    const message = match[5].trim();
    issues.push(diagnosticIssue("LUAU_PARSE_ERROR", "error", path, location, message, `luau-compile reported ${match[4]}: ${message}`));
  }
  return issues;
}

function parseLspDiagnostics(output: string, root: string): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.*?):(\d+)\.(\d+)(?:-(\d+)\.(\d+))?:\s*([^:]+):\s*(.*)$/);
    if (!match?.[1] || !match[2] || !match[3] || !match[6] || !match[7]) continue;
    const label = match[6].trim();
    const message = match[7].trim();
    const location = { line: Number(match[2]), column: Number(match[3]), ...(match[4] ? { endLine: Number(match[4]) } : {}), ...(match[5] ? { endColumn: Number(match[5]) } : {}) };
    const severity = label === "TypeError" || label === "SyntaxError" || label === "Error" ? "error" as const : "warning" as const;
    const ruleId = label === "TypeError" ? "LUAU_TYPE_ERROR" : label === "SyntaxError" ? "LUAU_PARSE_ERROR" : severity === "warning" ? `LUAU_LINT_${normalizeRule(label)}` : "LUAU_ANALYZER_ERROR";
    issues.push(diagnosticIssue(ruleId, severity, relativePath(root, match[1]), location, message, `luau-lsp Roblox analysis reported ${label}: ${message}`));
  }
  return issues;
}

function diagnosticIssue(ruleId: string, severity: "warning" | "error", path: string, location: NonNullable<VerificationIssue["location"]>, message: string, statement: string): VerificationIssue {
  return {
    kind: "VerificationIssue", schemaVersion: 1,
    id: issueId(ruleId, path, location, message), ruleId, severity, category: "language", message, path, location,
    evidence: [{ type: "analyzer", statement }], authoritativeTier: "static"
  };
}

function toolIssue(ruleId: string, message: string): VerificationIssue {
  return { kind: "VerificationIssue", schemaVersion: 1, id: issueId(ruleId, "", { line: 0, column: 0 }, message), ruleId, severity: "error", category: "tooling", message, evidence: [{ type: "analyzer", statement: message }], authoritativeTier: "static" };
}

function tier(name: LuauAnalysisTier["name"], status: TierStatus, issues: VerificationIssue[]): LuauAnalysisTier {
  return { name, status, issueIds: issues.map((issue) => issue.id) };
}

function resolveExecutable(environmentName: string, command: string, probeArgs: string[] = []): string | null {
  const configured = process.env[environmentName];
  if (configured) return existsSync(configured) && executableWorks(configured, probeArgs) ? resolve(configured) : null;
  const lookup = spawnSync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  const candidate = lookup.status === 0 ? lookup.stdout.trim() : "";
  return candidate && executableWorks(candidate, probeArgs) ? candidate : null;
}

function executableWorks(path: string, probeArgs: string[]): boolean {
  if (probeArgs.length === 0) return existsSync(path);
  const probe = spawnSync(path, probeArgs, { encoding: "utf8" });
  return probe.status === 0;
}

function executableVersion(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  const value = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/)[0];
  return value || "unknown";
}

function binaryHash(executable: string): string {
  try { return hash(readFileSync(executable)); } catch { return "unknown"; }
}

function resolveDefinitionsPath(): string | null {
  const configured = process.env.FORGE_ROBLOX_TYPES;
  if (configured) return existsSync(configured) ? resolve(configured) : null;
  const candidate = repositoryAsset("globalTypes.d.luau");
  return existsSync(candidate) ? candidate : null;
}

function resolveDefinitionMetadataPath(): string | null {
  const configured = process.env.FORGE_ROBLOX_TYPES_METADATA;
  if (configured) return existsSync(configured) ? resolve(configured) : null;
  const candidate = repositoryAsset("definitions.json");
  return existsSync(candidate) ? candidate : null;
}

function repositoryAsset(name: string): string {
  return resolve(import.meta.dirname, "../../../..", "packages/luau-toolchain/roblox", name);
}

function toolExecutionRoot(): string {
  return resolve(import.meta.dirname, "../../../..");
}

function relativePath(root: string, value: string): string {
  const absolute = resolve(root, value);
  const relativeValue = relative(root, absolute).split(sep).join("/");
  return relativeValue.startsWith("../") ? value : relativeValue;
}

function normalizeRule(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function issueId(ruleId: string, path: string, location: NonNullable<VerificationIssue["location"]>, message: string): string {
  return `${ruleId}:${hash(`${ruleId}|${path}|${location.line}|${location.column}|${location.endLine ?? 0}|${location.endColumn ?? 0}|${message}`).slice(0, 16)}`;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
