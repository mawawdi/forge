import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, relative, resolve, sep } from "node:path";
import type { VerificationIssue, VerificationReport } from "../../contracts/src/index.js";
import {
  AnalysisProcessDeadline,
  type AnalysisProcessFailure,
  type LuauAnalysisExecutionOptions,
} from "./process.js";

export type { LuauAnalysisExecutionOptions } from "./process.js";

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

export interface StudioLuauAnalysisNode {
  studioPath: string;
  className: string;
}

export interface StudioLuauAnalysisSource extends StudioLuauAnalysisNode {
  id: string;
  className: "Script" | "LocalScript" | "ModuleScript";
  source: string;
}

interface DefinitionMetadata {
  kind: "RobloxTypeDefinitions";
  source: string;
  sha256: string;
}

export function analyzeWithRobloxLuau(
  root: string,
  files: string[],
  options: LuauAnalysisExecutionOptions = {},
): LuauAnalysisResult {
  const execution = new AnalysisProcessDeadline(options);
  const canonicalRoot = resolve(root);
  const relativeFiles = [...files].sort((left, right) => left.localeCompare(right));
  const syntax = analyzeSyntax(canonicalRoot, relativeFiles, execution);
  if (syntax.status !== "pass") {
    return {
      tools: syntax.tools,
      tiers: [
        tier("official_luau_syntax", syntax.status, syntax.issues),
        tier("roblox_type_analysis", "unavailable", []),
      ],
      issues: syntax.issues,
      stdout: syntax.stdout,
      stderr: syntax.stderr,
    };
  }
  const roblox = analyzeRobloxTypes(canonicalRoot, relativeFiles, execution);
  return {
    tools: [...syntax.tools, ...roblox.tools],
    tiers: [
      tier("official_luau_syntax", "pass", syntax.issues),
      tier("roblox_type_analysis", roblox.status, roblox.issues),
    ],
    issues: [...syntax.issues, ...roblox.issues],
    stdout: `${syntax.stdout}${roblox.stdout}`,
    stderr: `${syntax.stderr}${roblox.stderr}`,
  };
}

/**
 * Analyze staged Studio source in the exact approved DataModel topology.
 *
 * A flat temporary Rojo project cannot resolve sibling ModuleScripts and can
 * therefore turn valid `require` calls into source errors. This adapter keeps
 * temporary host paths out of diagnostics and binds every source file to its
 * logical Studio path before the Roblox-aware analyzer runs.
 */
export function analyzeStudioSourcesWithRobloxLuau(
  input: {
    nodes: readonly StudioLuauAnalysisNode[];
    sources: readonly StudioLuauAnalysisSource[];
    /** Existing trusted project source used only to resolve candidate imports. */
    dependencySources?: readonly StudioLuauAnalysisSource[];
  },
  options: LuauAnalysisExecutionOptions = {},
): LuauAnalysisResult {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "forge-studio-luau-analysis-"));
  try {
    // Untyped candidate files otherwise use Luau's nonstrict default, which
    // can erase an optional instance's type after a nil guard and miss a
    // runtime error such as calling Vector3.Magnitude. This config changes
    // analysis only; candidate source bytes and diagnostic lines stay exact.
    writeFileSync(join(temporaryRoot, ".luaurc"), JSON.stringify({ languageMode: "strict" }), {
      encoding: "utf8",
      mode: 0o600,
    });
    const sources = [...input.sources].sort(
      (left, right) =>
        left.studioPath.localeCompare(right.studioPath) || left.id.localeCompare(right.id),
    );
    const dependencySources = [...(input.dependencySources ?? [])].sort(
      (left, right) =>
        left.studioPath.localeCompare(right.studioPath) || left.id.localeCompare(right.id),
    );
    const allSources = [...sources, ...dependencySources];
    const sourceFiles = allSources.map((source, index) => {
      const suffix =
        source.className === "Script"
          ? ".server.luau"
          : source.className === "LocalScript"
            ? ".client.luau"
            : ".luau";
      const safeId = source.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96) || "source";
      const file = `${String(index).padStart(4, "0")}_${safeId}${suffix}`;
      writeFileSync(join(temporaryRoot, file), source.source, { encoding: "utf8", mode: 0o600 });
      return { ...source, file };
    });
    const tree = studioProjectTree(input.nodes, sourceFiles, temporaryRoot);
    writeFileSync(
      join(temporaryRoot, "default.project.json"),
      JSON.stringify({ name: "ForgeCreatorCandidate", tree }),
      { encoding: "utf8", mode: 0o600 },
    );
    const candidateFiles = sourceFiles.slice(0, sources.length).map((source) => source.file);
    const result = analyzeWithRobloxLuau(temporaryRoot, candidateFiles, options);
    const sourceByFile = new Map(
      sourceFiles.flatMap((source) =>
        studioDiagnosticPaths(source.file, temporaryRoot).map((path) => [path, source] as const),
      ),
    );
    const remappedIssues = result.issues.map((issue) => remapStudioIssue(issue, sourceByFile));
    const remappedIssueIds = new Map(
      result.issues.map((issue, index) => [issue.id, remappedIssues[index]!.id]),
    );
    // luau-lsp can report a module once through an import and again as a
    // directly analyzed file. Deduplicate only after their source identities
    // have been resolved against this exact temporary project.
    const issues = [...new Map(remappedIssues.map((issue) => [issue.id, issue])).values()];
    return {
      ...result,
      tiers: result.tiers.map((entry) => ({
        ...entry,
        issueIds: [...new Set(entry.issueIds.map((id) => remappedIssueIds.get(id) ?? id))],
      })) as LuauAnalysisResult["tiers"],
      issues,
      stdout: remapStudioDiagnosticOutput(result.stdout, sourceFiles, temporaryRoot),
      stderr: remapStudioDiagnosticOutput(result.stderr, sourceFiles, temporaryRoot),
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function analyzeSyntax(
  root: string,
  files: string[],
  execution: AnalysisProcessDeadline,
): {
  status: TierStatus;
  tools: ToolRecord[];
  issues: VerificationIssue[];
  stdout: string;
  stderr: string;
} {
  const executable = resolveExecutable("FORGE_LUAU_COMPILE", "luau-compile");
  if (!executable) {
    const issue = toolIssue(
      "LUAU_SYNTAX_TOOL_UNAVAILABLE",
      "Official luau-compile was not found. Install Luau or set FORGE_LUAU_COMPILE; no parser fallback is allowed.",
    );
    return { status: "unavailable", tools: [], issues: [issue], stdout: "", stderr: "" };
  }
  const tools: ToolRecord[] = [
    {
      name: "luau-compile",
      command: "luau-compile --only-parse <files>",
      configHash: hash(
        JSON.stringify({
          executableHash: binaryHash(executable),
          mode: "official-luau-syntax",
          execution: execution.policy,
          maxBuffer: 10 * 1024 * 1024,
        }),
      ),
    },
  ];
  const issues: VerificationIssue[] = [];
  let stdout = "";
  let stderr = "";
  let failed = false;
  for (const file of files) {
    const result = execution.run(executable, ["--only-parse", resolve(root, file)], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout += result.stdout ?? "";
    stderr += result.stderr ?? "";
    if (result.failure) {
      issues.push(processFailureIssue("LUAU_SYNTAX", "luau-compile", result.failure));
      break;
    }
    const diagnostics = parseCompilerDiagnostics(`${result.stdout}${result.stderr}`, root);
    issues.push(...diagnostics);
    if (result.status !== 0) {
      failed = true;
      if (diagnostics.length === 0) {
        issues.push(
          toolIssue(
            "LUAU_SYNTAX_TOOL_FAILURE",
            "luau-compile failed without a parseable diagnostic.",
          ),
        );
        break;
      }
    }
  }
  return {
    status: issues.some((issue) => issue.category === "tooling")
      ? "unavailable"
      : failed
        ? "fail"
        : "pass",
    tools,
    issues,
    stdout,
    stderr,
  };
}

function analyzeRobloxTypes(
  root: string,
  files: string[],
  execution: AnalysisProcessDeadline,
): {
  status: TierStatus;
  tools: ToolRecord[];
  issues: VerificationIssue[];
  stdout: string;
  stderr: string;
} {
  const executable = resolveExecutable("FORGE_LUAU_LSP", "luau-lsp");
  const rojo = resolveExecutable("FORGE_ROJO", "rojo");
  const definitionPath = resolveDefinitionsPath();
  const metadataPath = resolveDefinitionMetadataPath();
  if (!executable || !rojo || !definitionPath || !metadataPath) {
    const missing = [
      !executable ? "luau-lsp" : "",
      !rojo ? "rojo" : "",
      !definitionPath || !metadataPath ? "pinned Roblox definitions" : "",
    ]
      .filter(Boolean)
      .join(", ");
    return unavailable(
      `Roblox-aware type analysis is unavailable: missing ${missing}. Install the pinned Rokit tools and retain the vendored definitions; Forge will not attribute host-type failures to source.`,
    );
  }

  let metadata: DefinitionMetadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as DefinitionMetadata;
  } catch {
    return unavailable("Pinned Roblox definition metadata is unreadable.");
  }
  const definitionsHash = hash(readFileSync(definitionPath));
  if (metadata.kind !== "RobloxTypeDefinitions" || metadata.sha256 !== definitionsHash) {
    return unavailable(
      `Pinned Roblox definitions failed integrity validation (expected ${metadata.sha256}, observed ${definitionsHash}).`,
    );
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "forge-roblox-analysis-"));
  try {
    const sourcemapPath = join(temporaryRoot, "sourcemap.json");
    const projectPath =
      existingProjectPath(root) ?? writeSyntheticProject(temporaryRoot, root, files);
    const rojoTool: ToolRecord = {
      name: "rojo-sourcemap",
      command: "rojo sourcemap <project> --include-non-scripts --output <temporary>",
      configHash: hash(
        JSON.stringify({
          executableHash: binaryHash(rojo),
          includeNonScripts: true,
          execution: execution.policy,
          maxBuffer: 10 * 1024 * 1024,
        }),
      ),
    };
    const sourcemap = execution.run(
      rojo,
      ["sourcemap", projectPath, "--include-non-scripts", "--output", sourcemapPath],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 },
    );
    if (sourcemap.failure)
      return {
        status: "unavailable",
        tools: [rojoTool],
        issues: [processFailureIssue("ROBLOX_SOURCEMAP", "Rojo sourcemap", sourcemap.failure)],
        stdout: sourcemap.stdout,
        stderr: sourcemap.stderr,
      };
    if (sourcemap.status !== 0 || !existsSync(sourcemapPath)) {
      const detail = `${sourcemap.stdout ?? ""}${sourcemap.stderr ?? ""}`.trim();
      return unavailable(`Rojo sourcemap generation failed${detail ? `: ${detail}` : "."}`, [
        rojoTool,
      ]);
    }
    let sourcemapSource: string;
    try {
      sourcemapSource = readFileSync(sourcemapPath, "utf8");
      writeFileSync(
        sourcemapPath,
        JSON.stringify(absolutizeSourcemapPaths(JSON.parse(sourcemapSource) as unknown, root)),
      );
    } catch {
      return unavailable("Rojo produced an unreadable or invalid JSON sourcemap.", [rojoTool]);
    }
    const sourcemapHash = hash(sourcemapSource);
    rojoTool.configHash = hash(`${rojoTool.configHash}|${sourcemapHash}`);
    const configPath = resolve(root, ".luaurc");
    const args = [
      "analyze",
      "--formatter=gnu",
      "--platform=roblox",
      `--definitions=@roblox=${definitionPath}`,
      `--sourcemap=${sourcemapPath}`,
      ...(existsSync(configPath) ? [`--base-luaurc=${configPath}`] : []),
      ...files.map((file) => resolve(root, file)),
    ];
    // Rojo must resolve project-relative $path entries from the candidate root,
    // but a Rokit-managed luau-lsp shim must launch from the Forge tool project
    // that pins it. The generated sourcemap and absolute source paths preserve
    // candidate resolution without making the shim depend on candidate files.
    const result = execution.run(executable, args, {
      cwd: toolExecutionRoot(),
      maxBuffer: 20 * 1024 * 1024,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    // Interrupted output is retained for troubleshooting, not promoted to
    // authoritative language diagnostics from an unfinished analysis.
    const issues = result.failure
      ? [processFailureIssue("ROBLOX_TYPE", "luau-lsp", result.failure)]
      : parseLspDiagnostics(`${stdout}${stderr}`, root);
    if (result.status !== 0 && issues.length === 0)
      issues.push(
        toolIssue(
          "ROBLOX_TYPE_TOOL_FAILURE",
          `luau-lsp exited with code ${result.status ?? "unknown"} without a parseable diagnostic.`,
        ),
      );
    const configHash = hash(
      JSON.stringify({
        platform: "roblox",
        executableHash: binaryHash(executable),
        definitionsHash,
        sourcemapHash,
        luaurcHash: existsSync(configPath) ? hash(readFileSync(configPath)) : hash("no-config"),
        execution: execution.policy,
        maxBuffer: 20 * 1024 * 1024,
      }),
    );
    const tools: ToolRecord[] = [
      {
        name: "luau-lsp-roblox",
        command:
          "luau-lsp analyze --platform=roblox --definitions=@roblox --sourcemap=<generated> --formatter=gnu <files>",
        configHash,
      },
      { name: "roblox-global-types", command: metadata.source, configHash: definitionsHash },
      rojoTool,
    ];
    return {
      status: issues.some((issue) => issue.category === "tooling")
        ? "unavailable"
        : result.status === 0
          ? "pass"
          : "fail",
      tools,
      issues,
      stdout,
      stderr,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  function unavailable(
    message: string,
    tools: ToolRecord[] = [],
  ): {
    status: "unavailable";
    tools: ToolRecord[];
    issues: VerificationIssue[];
    stdout: string;
    stderr: string;
  } {
    return {
      status: "unavailable",
      tools,
      issues: [toolIssue("ROBLOX_TYPE_ENV_UNAVAILABLE", message)],
      stdout: "",
      stderr: "",
    };
  }
}

function writeSyntheticProject(temporaryRoot: string, root: string, files: string[]): string {
  const tree: Record<string, unknown> = { $className: "DataModel" };
  for (const file of files) {
    const name = basename(file)
      .replace(/\.(server|client)?\.?lua(u)?$/, "")
      .replace(/[^A-Za-z0-9_]/g, "_");
    const absolutePath = resolve(root, file);
    if (
      file.endsWith(".server.luau") ||
      file.endsWith(".server.lua") ||
      file.includes("ServerScriptService")
    ) {
      const service = child(tree, "ServerScriptService", "ServerScriptService");
      service[uniqueName(service, name)] = { $path: absolutePath };
    } else if (
      file.endsWith(".client.luau") ||
      file.endsWith(".client.lua") ||
      file.includes("StarterPlayerScripts")
    ) {
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

function absolutizeSourcemapPaths(value: unknown, root: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => absolutizeSourcemapPaths(entry, root));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "filePaths" && Array.isArray(entry)) {
      result[key] = entry.map((path) => (typeof path === "string" ? resolve(root, path) : path));
    } else {
      result[key] = absolutizeSourcemapPaths(entry, root);
    }
  }
  return result;
}

function child(
  parent: Record<string, unknown>,
  name: string,
  className: string,
): Record<string, unknown> {
  const existing = parent[name];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing))
    return existing as Record<string, unknown>;
  const value: Record<string, unknown> = { $className: className };
  parent[name] = value;
  return value;
}

function uniqueName(parent: Record<string, unknown>, preferred: string): string {
  let candidate = preferred || "Script";
  let suffix = 2;
  while (candidate in parent) {
    candidate = `${preferred}_${suffix}`;
    suffix += 1;
  }
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
    issues.push(
      diagnosticIssue(
        "LUAU_PARSE_ERROR",
        "error",
        path,
        location,
        message,
        `luau-compile reported ${match[4]}: ${message}`,
      ),
    );
  }
  return issues;
}

function parseLspDiagnostics(output: string, root: string): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.*?):(\d+)\.(\d+)(?:-(\d+)\.(\d+))?:\s*([^:]+):\s*(.*)$/);
    if (!match?.[1] || !match[2] || !match[3] || !match[6] || !match[7]) continue;
    const label = match[6].trim();
    const rawMessage = match[7].trim();
    const message =
      rawMessage === "Unknown require: unsupported path"
        ? `${rawMessage}. The analyzer needs a statically resolvable instance path. Use inferred GetService/WaitForChild aliases without :: casts in the import chain, then require(module). Keep shared code in its ModuleScript; do not duplicate it. Dynamic imports remain unresolved.`
        : rawMessage;
    const location = {
      line: Number(match[2]),
      column: Number(match[3]),
      ...(match[4] ? { endLine: Number(match[4]) } : {}),
      ...(match[5] ? { endColumn: Number(match[5]) } : {}),
    };
    const severity =
      label === "TypeError" || label === "SyntaxError" || label === "Error"
        ? ("error" as const)
        : ("warning" as const);
    const ruleId =
      label === "TypeError"
        ? "LUAU_TYPE_ERROR"
        : label === "SyntaxError"
          ? "LUAU_PARSE_ERROR"
          : severity === "warning"
            ? `LUAU_LINT_${normalizeRule(label)}`
            : "LUAU_ANALYZER_ERROR";
    issues.push(
      diagnosticIssue(
        ruleId,
        severity,
        relativePath(root, match[1]),
        location,
        message,
        `luau-lsp Roblox analysis reported ${label}: ${rawMessage}`,
      ),
    );
  }
  return issues;
}

function diagnosticIssue(
  ruleId: string,
  severity: "warning" | "error",
  path: string,
  location: NonNullable<VerificationIssue["location"]>,
  message: string,
  statement: string,
): VerificationIssue {
  return {
    kind: "VerificationIssue",
    id: issueId(ruleId, path, location, message),
    ruleId,
    severity,
    category: "language",
    message,
    path,
    location,
    evidence: [{ type: "analyzer", statement }],
    authoritativeTier: "static",
  };
}

function toolIssue(ruleId: string, message: string): VerificationIssue {
  return {
    kind: "VerificationIssue",
    id: issueId(ruleId, "", { line: 0, column: 0 }, message),
    ruleId,
    severity: "error",
    category: "tooling",
    message,
    evidence: [{ type: "analyzer", statement: message }],
    authoritativeTier: "static",
  };
}

function processFailureIssue(
  prefix: string,
  tool: string,
  failure: AnalysisProcessFailure,
): VerificationIssue {
  return toolIssue(
    `${prefix}_TOOL_${failure.kind.toUpperCase()}`,
    `${tool}: ${failure.detail}. Analysis is incomplete; this is not a source diagnostic.`,
  );
}

function tier(
  name: LuauAnalysisTier["name"],
  status: TierStatus,
  issues: VerificationIssue[],
): LuauAnalysisTier {
  return { name, status, issueIds: issues.map((issue) => issue.id) };
}

function resolveExecutable(environmentName: string, command: string): string | null {
  const configured = process.env[environmentName];
  if (configured) return existsSync(configured) ? resolve(configured) : null;
  // Resolve PATH directly: a login-shell startup is an additional unbounded
  // process and can execute unrelated host profile code.
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, process.platform === "win32" ? `${command}.exe` : command);
    try {
      if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue to the next PATH entry when this one does not contain the tool.
    }
  }
  return null;
}

function binaryHash(executable: string): string {
  try {
    return hash(readFileSync(executable));
  } catch {
    return "unknown";
  }
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
  return resolve(repositoryAsset("globalTypes.d.luau"), "../../../..");
}

function relativePath(root: string, value: string): string {
  const absolute = resolve(root, value);
  const relativeValue = relative(root, absolute).split(sep).join("/");
  return relativeValue.startsWith("../") ? value : relativeValue;
}

function studioProjectTree(
  nodes: readonly StudioLuauAnalysisNode[],
  sources: readonly (StudioLuauAnalysisSource & { file: string })[],
  root: string,
): Record<string, unknown> {
  const classes = new Map<string, string>();
  for (const node of [...nodes, ...sources]) {
    const path = assertStudioAnalysisPath(node.studioPath);
    if (node.className.trim().length === 0)
      throw new Error(`Studio analysis class is empty at ${path}`);
    const existing = classes.get(path);
    if (existing && existing !== node.className)
      throw new Error(`Studio analysis topology has conflicting classes at ${path}`);
    classes.set(path, node.className);
  }
  const sourcePaths = new Set<string>();
  for (const source of sources) {
    const path = assertStudioAnalysisPath(source.studioPath);
    if (sourcePaths.has(path))
      throw new Error(`Studio analysis topology has duplicate source at ${path}`);
    sourcePaths.add(path);
  }

  const tree: Record<string, unknown> = { $className: "DataModel" };
  for (const [path] of [...classes].sort(
    ([left], [right]) => pathDepth(left) - pathDepth(right) || left.localeCompare(right),
  )) {
    const segments = path.split("/");
    let cursor = tree;
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!;
      if (name.startsWith("$"))
        throw new Error(`Studio analysis path uses reserved Rojo name ${name}`);
      const prefix = segments.slice(0, index + 1).join("/");
      const existing = cursor[name];
      const childNode =
        typeof existing === "object" && existing !== null && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : { $className: classes.get(prefix) ?? (index === 0 ? name : "Folder") };
      cursor[name] = childNode;
      cursor = childNode;
    }
  }
  for (const source of sources) {
    const leaf = studioTreeNode(tree, source.studioPath);
    delete leaf.$className;
    leaf.$path = resolve(root, source.file);
  }
  return tree;
}

function studioTreeNode(tree: Record<string, unknown>, path: string): Record<string, unknown> {
  let cursor = tree;
  for (const segment of assertStudioAnalysisPath(path).split("/")) {
    const childNode = cursor[segment];
    if (typeof childNode !== "object" || childNode === null || Array.isArray(childNode))
      throw new Error(`Studio analysis topology is missing ${path}`);
    cursor = childNode as Record<string, unknown>;
  }
  return cursor;
}

function assertStudioAnalysisPath(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  )
    throw new Error(`Invalid Studio analysis path ${value}`);
  return value;
}

function pathDepth(value: string): number {
  return value.split("/").length;
}

function remapStudioIssue(
  issue: VerificationIssue,
  sourceByFile: ReadonlyMap<string, StudioLuauAnalysisSource & { file: string }>,
): VerificationIssue {
  if (!issue.path) return issue;
  const decorated = issue.path.match(/^(.+) \[game\/(.+)\]$/);
  const source = sourceByFile.get(decorated?.[1] ?? issue.path);
  if (!source) return issue;
  // The bracketed label is not authority on its own. Both its generated file
  // and its complete DataModel path must match the host's source map.
  if (decorated && decorated[2] !== source.studioPath) return issue;
  const location = issue.location ?? { line: 0, column: 0 };
  return {
    ...issue,
    id: issueId(issue.ruleId, source.studioPath, location, issue.message),
    path: source.studioPath,
  };
}

function remapStudioDiagnosticOutput(
  output: string,
  sources: readonly (StudioLuauAnalysisSource & { file: string })[],
  root: string,
): string {
  let value = output;
  for (const source of sources) {
    const variants = studioDiagnosticPaths(source.file, root).sort(
      (left, right) => right.length - left.length,
    );
    for (const variant of variants) value = value.split(variant).join(source.studioPath);
  }
  return value;
}

function studioDiagnosticPaths(file: string, root: string): string[] {
  const absolute = resolve(root, file);
  // The compiler reports candidate-relative paths, while luau-lsp may report
  // absolute paths or paths relative to its pinned tool execution directory.
  return [absolute, relative(toolExecutionRoot(), absolute).split(sep).join("/"), file];
}

function normalizeRule(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
}

function issueId(
  ruleId: string,
  path: string,
  location: NonNullable<VerificationIssue["location"]>,
  message: string,
): string {
  return `${ruleId}:${hash(`${ruleId}|${path}|${location.line}|${location.column}|${location.endLine ?? 0}|${location.endColumn ?? 0}|${message}`).slice(0, 16)}`;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
