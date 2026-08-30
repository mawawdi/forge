import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z, type ZodRawShape } from "zod";
import { contentHash, stableJson, type BuildOutcome, type BuildTrace, type TracePersistence, type VerificationIssue } from "../../contracts/src/index.js";
import { compileAgentOrientation, type AgentOrientation } from "../../context-compiler/src/index.js";
import { JsonFileTraceSink, FlightRecorder } from "../../flight-recorder/src/index.js";
import { resolveRequirementView, assertRequirementSet, type RequirementSet } from "../../semantic-authority/src/index.js";
import { FilesystemProjectSourceAdapter } from "../../semantic-map/src/index.js";
import { verifyProject, type VerificationRun } from "../../verifier/src/index.js";

export type AgentRunStatus = "locally_eligible" | "rejected" | "incomplete";
export type AgentFailureClassification = "accepted" | "agent_failure" | "tool_failure" | "budget_exhausted" | "verification_failure" | "workspace_capability_violation" | "provider_failure" | "harness_failure" | "incomplete";

export interface BudgetPolicy {
  maxTurns: number;
  maxToolCalls: number;
  maxWrites: number;
  maxVerifierCalls: number;
  maxChangedFiles: number;
  maxAddedLines: number;
  maxRemovedLines: number;
  maxBytesPerFile: number;
  maxChangedSourceBytes: number;
  maxToolResultBytes: number;
  maxDurationMs: number;
  maxBudgetUsd: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export const INITIAL_EXPERIMENT_BUDGETS: BudgetPolicy = {
  maxTurns: 12, maxToolCalls: 48, maxWrites: 12, maxVerifierCalls: 4, maxChangedFiles: 6,
  maxAddedLines: 520, maxRemovedLines: 140, maxBytesPerFile: 48_000, maxChangedSourceBytes: 96_000,
  maxToolResultBytes: 256 * 1024, maxDurationMs: 8 * 60_000, maxBudgetUsd: 2, maxInputTokens: 100_000, maxOutputTokens: 20_000
};

export interface HarnessConfigurationInput {
  systemPrompt: string;
  tools: readonly { name: string; description: string; schema: unknown }[];
  capabilityPolicy: { sourceRoots: string[]; blockedPathPrefixes: string[]; allowedExtensions: string[] };
  orientation: Pick<AgentOrientation, "policy" | "contentHash">;
  requirementViewHash: string;
  budgets: BudgetPolicy;
  runtimeAdapter: { name: string; version: string };
  model: { provider: string; name: string; version?: string };
}

export interface HarnessConfiguration extends HarnessConfigurationInput {
  kind: "HarnessConfiguration";
  schemaVersion: 1;
  id: string;
  hash: string;
}

export function createHarnessConfiguration(input: HarnessConfigurationInput): HarnessConfiguration {
  assertNonEmpty(input.systemPrompt, "HarnessConfiguration system prompt");
  const canonical = canonicalHarnessInput(input);
  const hash = contentHash(stableJson(canonical));
  const configuration = { kind: "HarnessConfiguration" as const, schemaVersion: 1 as const, id: `harness_configuration_${hash.slice(0, 24)}`, hash, ...canonical };
  assertHarnessConfiguration(configuration);
  return configuration;
}

export function assertHarnessConfiguration(value: unknown): asserts value is HarnessConfiguration {
  if (!isRecord(value) || value.kind !== "HarnessConfiguration" || value.schemaVersion !== 1 || !isIdentifier(value.id) || !isHash(value.hash) || typeof value.systemPrompt !== "string" || !Array.isArray(value.tools) || !isRecord(value.capabilityPolicy) || !isRecord(value.orientation) || !isHash(value.requirementViewHash) || !isRecord(value.budgets) || !isRecord(value.runtimeAdapter) || !isRecord(value.model)) throw new Error("Invalid HarnessConfiguration");
  const expected = createHarnessConfigurationUnchecked(value as unknown as HarnessConfigurationInput).hash;
  if (value.hash !== expected || value.id !== `harness_configuration_${expected.slice(0, 24)}`) throw new Error("Invalid HarnessConfiguration identity");
}

function createHarnessConfigurationUnchecked(input: HarnessConfigurationInput): HarnessConfiguration {
  const canonical = canonicalHarnessInput(input);
  const hash = contentHash(stableJson(canonical));
  return { kind: "HarnessConfiguration", schemaVersion: 1, id: `harness_configuration_${hash.slice(0, 24)}`, hash, ...canonical };
}

function canonicalHarnessInput(input: HarnessConfigurationInput): HarnessConfigurationInput {
  return {
    systemPrompt: input.systemPrompt,
    tools: [...input.tools].map((tool) => ({ name: tool.name, description: tool.description, schema: tool.schema })).sort((left, right) => left.name.localeCompare(right.name)),
    capabilityPolicy: { sourceRoots: [...input.capabilityPolicy.sourceRoots].sort(), blockedPathPrefixes: [...input.capabilityPolicy.blockedPathPrefixes].sort(), allowedExtensions: [...input.capabilityPolicy.allowedExtensions].sort() },
    orientation: { policy: input.orientation.policy, contentHash: input.orientation.contentHash },
    requirementViewHash: input.requirementViewHash,
    budgets: { ...input.budgets },
    runtimeAdapter: { name: input.runtimeAdapter.name, version: input.runtimeAdapter.version },
    model: { provider: input.model.provider, name: input.model.name, ...(input.model.version ? { version: input.model.version } : {}) }
  };
}

export interface BuildPlan {
  kind: "BuildPlan";
  schemaVersion: 1;
  id: string;
  revision: number;
  goal: string;
  steps: Array<{ id: string; statement: string; status: "pending" | "in_progress" | "completed" }>;
  currentStepId?: string;
  assumptions: string[];
  expectedTouchedAreas: string[];
  verificationIntentions: string[];
  status: "draft" | "active" | "complete";
  source: "agent_plan";
  authority: "hypothesis";
}

export interface WorkspaceDeltaOperation { path: string; beforeHash: string | null; afterHash: string; addedLines: number; removedLines: number; bytes: number; }
export interface WorkspaceDelta { kind: "WorkspaceDelta"; schemaVersion: 1; id: string; seedHash: string; candidateHash: string; operations: WorkspaceDeltaOperation[]; }

export interface ToolResult { ok: boolean; value?: unknown; error?: { code: string; message: string }; truncated: boolean; resultHash: string; bytes: number; }
export interface ToolCallRecord { sequence: number; name: string; inputHash: string; resultHash: string; truncated: boolean; bytes: number; at: string; input: unknown; result: ToolResult; }
export interface AgentToolDefinition { name: string; description: string; inputShape: ZodRawShape; schema: unknown; }

export interface AgentToolHost {
  definitions(): AgentToolDefinition[];
  execute(name: string, input: unknown): Promise<ToolResult>;
  records(): readonly ToolCallRecord[];
}

export interface AgentProviderInput { systemPrompt: string; prompt: string; orientation: AgentOrientation; tools: AgentToolHost; budgets: BudgetPolicy; }
export interface AgentProviderResult { status: "completed" | "failed" | "budget_exhausted"; summary?: string; error?: string; usage: { turns: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }; }
export interface AgentProvider { identity: { name: string; version: string }; run(input: AgentProviderInput): Promise<AgentProviderResult>; }

export interface AgentRun {
  kind: "AgentRun";
  schemaVersion: 1;
  id: string;
  createdAt: string;
  status: AgentRunStatus;
  classification: AgentFailureClassification;
  creatorPromptHash: string;
  requirementSetId: string;
  requirementViewId: string;
  orientationId: string;
  harnessConfigurationId: string;
  harnessConfigurationHash: string;
  seedHash: string;
  workspaceDelta?: WorkspaceDelta;
  provider: { name: string; version: string; model: string };
  plans: BuildPlan[];
  toolCalls: ToolCallRecord[];
  budgets: { policy: BudgetPolicy; consumed: BudgetConsumption; exhausted: string[] };
  finalVerification?: { gate: "verified" | "rejected" | "incomplete"; reportHash: string; traceId: string };
  buildTraceId?: string;
  studio: "not_run";
  summary?: string;
  error?: string;
}

export interface BudgetConsumption { turns: number; toolCalls: number; writes: number; verifierCalls: number; changedFiles: number; addedLines: number; removedLines: number; changedSourceBytes: number; toolResultBytes: number; durationMs: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; }

export interface AgentRunPersistence { path: string; artifactHash: string; mode: number; }
export interface AgentBuildRequest { seedRoot: string; creatorPrompt: string; requirementSet: RequirementSet; provider: AgentProvider; model: { provider: string; name: string; version?: string }; runDirectory: string; traceDirectory: string; environment?: "production" | "benchmark"; budgets?: BudgetPolicy; systemPrompt?: string; }
export interface AgentBuildResult { status: AgentRunStatus; classification: AgentFailureClassification; run: AgentRun; persistence: AgentRunPersistence; candidateRoot: string; trace: BuildTrace; tracePersistence: TracePersistence; finalVerification: VerificationRun; }

export function assertBuildPlan(value: unknown): asserts value is BuildPlan { if (!isRecord(value) || value.kind !== "BuildPlan" || value.schemaVersion !== 1 || !isIdentifier(value.id) || !Number.isInteger(value.revision) || typeof value.goal !== "string" || !Array.isArray(value.steps) || value.source !== "agent_plan" || value.authority !== "hypothesis") throw new Error("Invalid BuildPlan"); }
export function assertWorkspaceDelta(value: unknown): asserts value is WorkspaceDelta { if (!isRecord(value) || value.kind !== "WorkspaceDelta" || value.schemaVersion !== 1 || !isIdentifier(value.id) || !isHash(value.seedHash) || !isHash(value.candidateHash) || !Array.isArray(value.operations)) throw new Error("Invalid WorkspaceDelta"); }
export function assertAgentRun(value: unknown): asserts value is AgentRun { if (!isRecord(value) || value.kind !== "AgentRun" || value.schemaVersion !== 1 || !isIdentifier(value.id) || !["locally_eligible", "rejected", "incomplete"].includes(String(value.status)) || !["accepted", "agent_failure", "tool_failure", "budget_exhausted", "verification_failure", "workspace_capability_violation", "provider_failure", "harness_failure", "incomplete"].includes(String(value.classification)) || value.studio !== "not_run") throw new Error("Invalid AgentRun"); }

const BLOCKED_PREFIXES = [".forge", "runs", "proofs", "regressions", "patches", "credentials", "hidden", "benchmark", "repair"];
const ALLOWED_EXTENSIONS = [".lua", ".luau"];

export async function runBoundedAgent(request: AgentBuildRequest): Promise<AgentBuildResult> {
  assertRequirementSet(request.requirementSet);
  assertNonEmpty(request.creatorPrompt, "creator prompt");
  const creator = request.requirementSet.requirements.find((requirement) => requirement.source === "creator" && requirement.evidence.some((evidence) => evidence.kind === "creator_request" && evidence.requestHash === contentHash(request.creatorPrompt)));
  if (!creator) throw new Error("Creator prompt must have hash-matched creator requirement evidence");
  const budgets = { ...(request.budgets ?? INITIAL_EXPERIMENT_BUDGETS) };
  const startedAt = Date.now();
  const runId = `agent_run_${randomUUID()}`;
  const environment = request.environment ?? "production";
  const requirementView = resolveRequirementView(request.requirementSet, { phase: "build", environment, audience: "builder" });
  const workspace = await CandidateWorkspace.create(request.seedRoot, request.runDirectory, budgets);
  const semanticMap = await workspace.semanticMap();
  const snapshotHash = (await workspace.semanticMap()).hashes.sourceHash;
  const orientation = compileAgentOrientation({ semanticMap, projectSnapshotHash: snapshotHash, requirementView });
  const toolHost = new BoundedToolHost(workspace, budgets);
  const systemPrompt = request.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const configuration = createHarnessConfiguration({
    systemPrompt,
    tools: toolHost.definitions().map((tool) => ({ name: tool.name, description: tool.description, schema: tool.schema })),
    capabilityPolicy: { sourceRoots: workspace.sourceRoots, blockedPathPrefixes: BLOCKED_PREFIXES, allowedExtensions: ALLOWED_EXTENSIONS },
    orientation: { policy: orientation.policy, contentHash: orientation.contentHash },
    requirementViewHash: contentHash(stableJson(requirementView)), budgets,
    runtimeAdapter: request.provider.identity, model: request.model
  });
  let providerResult: AgentProviderResult;
  let classification: AgentFailureClassification = "incomplete";
  let status: AgentRunStatus = "incomplete";
  let finalVerification: VerificationRun | undefined;
  let providerError: string | undefined;
  try {
    providerResult = await request.provider.run({ systemPrompt, prompt: creator.statement, orientation, tools: toolHost, budgets });
    if (providerResult.status === "budget_exhausted") classification = "budget_exhausted";
    else if (providerResult.status === "failed") classification = "provider_failure";
    else classification = "agent_failure";
  } catch (error) {
    providerResult = { status: "failed", error: error instanceof Error ? error.message : String(error), usage: { turns: 0, inputTokens: null, outputTokens: null, costUsd: null } };
    classification = "provider_failure";
    providerError = providerResult.error;
  }
  const delta = await workspace.freezeDelta();
  const consumption = workspace.consumption(toolHost.records(), Date.now() - startedAt, providerResult.usage);
  const exhausted = exhaustedBudgets(budgets, consumption);
  if (exhausted.length > 0) classification = "budget_exhausted";
  finalVerification = await verifyProject(workspace.candidateRoot, { traceDirectory: request.traceDirectory, traceReferences: { agentRunId: runId, requirementSetId: request.requirementSet.id, requirementViewId: requirementView.id, workspaceDeltaId: delta.id, harnessConfigurationId: configuration.id, harnessConfigurationHash: configuration.hash } });
  if (classification !== "budget_exhausted" && providerResult.status === "completed") {
    if (finalVerification.report.gate.status === "verified") { status = "locally_eligible"; classification = "accepted"; }
    else if (finalVerification.report.gate.status === "rejected") {
      status = "rejected";
      const errors = toolHost.records().filter((call) => !call.result.ok).map((call) => call.result.error?.code ?? "");
      classification = errors.some((code) => ["PATH_FORBIDDEN", "PATH_NOT_REGULAR_FILE", "STALE_WRITE", "PLAN_REQUIRED", "WRITE_BUDGET_EXHAUSTED", "WRITE_SIZE_EXCEEDED", "DELTA_BUDGET_EXCEEDED"].includes(code)) ? "workspace_capability_violation" : errors.length > 0 ? "tool_failure" : "verification_failure";
    }
    else { status = "incomplete"; classification = "incomplete"; }
  }
  if (classification === "budget_exhausted") status = "incomplete";
  else if (providerResult.status !== "completed") status = "incomplete";
  await workspace.assertSeedUnchanged();
  const run: AgentRun = {
    kind: "AgentRun", schemaVersion: 1, id: runId, createdAt: new Date().toISOString(), status, classification,
    creatorPromptHash: contentHash(request.creatorPrompt), requirementSetId: request.requirementSet.id, requirementViewId: requirementView.id,
    orientationId: orientation.id, harnessConfigurationId: configuration.id, harnessConfigurationHash: configuration.hash, seedHash: workspace.seedTreeHash,
    ...(delta.operations.length > 0 ? { workspaceDelta: delta } : {}), provider: { name: request.provider.identity.name, version: request.provider.identity.version, model: request.model.name },
    plans: toolHost.plans(), toolCalls: [...toolHost.records()], budgets: { policy: budgets, consumed: consumption, exhausted },
    ...(finalVerification ? { finalVerification: { gate: finalVerification.report.gate.status, reportHash: contentHash(stableJson(finalVerification.report)), traceId: finalVerification.trace.id } } : {}),
    studio: "not_run", ...(providerResult.summary ? { summary: providerResult.summary } : {}), ...(providerError ?? providerResult.error ? { error: providerError ?? providerResult.error } : {})
  };
  assertAgentRun(run);
  const trace = createAgentBuildTrace(run, configuration, consumption, finalVerification);
  const traceSink = new JsonFileTraceSink(request.traceDirectory);
  const tracePersistence = await traceSink.persist(trace);
  run.buildTraceId = trace.id;
  const persistence = await persistAgentRun(run, request.runDirectory);
  return { status, classification, run, persistence, candidateRoot: workspace.candidateRoot, trace, tracePersistence, finalVerification };
}

/** Read-only seed and writable isolated candidate; it never shares path identity with its source. */
export class CandidateWorkspace {
  readonly seedRoot: string;
  readonly candidateRoot: string;
  readonly sourceRoots: string[];
  readonly seedTreeHash: string;
  private readonly initialFiles: Map<string, { hash: string; source: string }>;
  private lastDelta: WorkspaceDelta | undefined;
  private writes = 0;
  private verifierCalls = 0;

  private constructor(seedRoot: string, candidateRoot: string, sourceRoots: string[], seedTreeHash: string, initialFiles: Map<string, { hash: string; source: string }>, private readonly budgets: BudgetPolicy) { this.seedRoot = seedRoot; this.candidateRoot = candidateRoot; this.sourceRoots = sourceRoots; this.seedTreeHash = seedTreeHash; this.initialFiles = initialFiles; }

  static async create(seedRoot: string, runDirectory: string, budgets: BudgetPolicy): Promise<CandidateWorkspace> {
    const seed = resolve(seedRoot);
    const manifest = JSON.parse(await readFile(join(seed, "forge.fixture.json"), "utf8")) as { luauRoots?: unknown };
    if (!Array.isArray(manifest.luauRoots) || !manifest.luauRoots.every((item) => typeof item === "string" && isSafeRelative(item))) throw new Error("Seed fixture must declare safe luauRoots");
    const parent = resolve(runDirectory, "workspaces");
    if (parent === seed || parent.startsWith(`${seed}${sep}`)) throw new Error("Agent run directory must be outside the seed workspace");
    await mkdir(parent, { recursive: true });
    const candidate = await mkdtemp(join(parent, "candidate-"));
    await cp(seed, candidate, { recursive: true, dereference: false, errorOnExist: false, force: true });
    const sourceRoots = [...manifest.luauRoots].sort();
    const initialFiles = await sourceFileSnapshots(candidate, sourceRoots);
    return new CandidateWorkspace(seed, candidate, sourceRoots, await treeHash(seed), initialFiles, budgets);
  }

  async semanticMap() {
    const manifest = JSON.parse(await readFile(join(this.candidateRoot, "forge.fixture.json"), "utf8")) as Parameters<FilesystemProjectSourceAdapter["load"]>[0]["manifest"];
    return new FilesystemProjectSourceAdapter().load({ root: this.candidateRoot, manifest });
  }
  async list(): Promise<Array<{ path: string; bytes: number }>> { return (await sourceFiles(this.candidateRoot, this.sourceRoots)).map(({ path, bytes }) => ({ path, bytes })).sort((a, b) => a.path.localeCompare(b.path)); }
  async read(path: string): Promise<string> { const target = this.resolveSourcePath(path); await this.assertSafeExistingTarget(target); return readFile(target, "utf8"); }
  async write(path: string, beforeHash: string, content: string): Promise<void> {
    if (this.writes >= this.budgets.maxWrites) throw new CapabilityError("WRITE_BUDGET_EXHAUSTED", "Workspace write budget exhausted");
    if (Buffer.byteLength(content, "utf8") > this.budgets.maxBytesPerFile) throw new CapabilityError("WRITE_SIZE_EXCEEDED", "Workspace write exceeds per-file budget");
    const target = this.resolveSourcePath(path);
    await this.assertSafeExistingTarget(target);
    const targetStat = await lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new CapabilityError("PATH_NOT_REGULAR_FILE", "Workspace target must be a regular source file");
    const existing = await readFile(target, "utf8");
    if (contentHash(existing) !== beforeHash) throw new CapabilityError("STALE_WRITE", "Workspace write precondition hash does not match");
    await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    this.writes += 1;
  }
  async verify(): Promise<VerificationRun> { if (this.verifierCalls >= this.budgets.maxVerifierCalls) throw new CapabilityError("VERIFY_BUDGET_EXHAUSTED", "Verifier-call budget exhausted"); this.verifierCalls += 1; return verifyProject(this.candidateRoot); }
  async freezeDelta(): Promise<WorkspaceDelta> {
    const current = await sourceFileSnapshots(this.candidateRoot, this.sourceRoots);
    const paths = [...new Set([...this.initialFiles.keys(), ...current.keys()])].sort();
    const operations: WorkspaceDeltaOperation[] = [];
    for (const path of paths) {
      const before = this.initialFiles.get(path); const after = current.get(path);
      if (before?.hash === after?.hash) continue;
      const beforeText = before?.source ?? "";
      const afterText = after?.source ?? "";
      operations.push({ path, beforeHash: before?.hash ?? null, afterHash: after?.hash ?? contentHash(""), addedLines: Math.max(0, lines(afterText) - lines(beforeText)), removedLines: Math.max(0, lines(beforeText) - lines(afterText)), bytes: Buffer.byteLength(afterText, "utf8") });
    }
    const candidateHash = (await this.semanticMap()).hashes.sourceHash;
    const delta: WorkspaceDelta = { kind: "WorkspaceDelta", schemaVersion: 1, id: "", seedHash: this.seedTreeHash, candidateHash, operations };
    delta.id = `workspace_delta_${contentHash(stableJson({ seedHash: delta.seedHash, candidateHash: delta.candidateHash, operations })).slice(0, 24)}`;
    assertWorkspaceDelta(delta);
    this.lastDelta = delta;
    const consumption = this.consumption([], 0, { turns: 0, inputTokens: null, outputTokens: null, costUsd: null });
    const failures = exhaustedBudgets(this.budgets, consumption);
    if (failures.some((item) => item === "maxChangedFiles" || item === "maxAddedLines" || item === "maxRemovedLines" || item === "maxChangedSourceBytes")) throw new CapabilityError("DELTA_BUDGET_EXCEEDED", `Workspace delta exceeds budget: ${failures.join(", ")}`);
    return delta;
  }
  async assertSeedUnchanged(): Promise<void> { if (await treeHash(this.seedRoot) !== this.seedTreeHash) throw new Error("Seed workspace changed during AgentRun"); }
  consumption(records: readonly ToolCallRecord[], durationMs: number, usage: AgentProviderResult["usage"]): BudgetConsumption {
    const delta = this.lastDelta;
    return { turns: usage.turns, toolCalls: records.length, writes: this.writes, verifierCalls: this.verifierCalls, changedFiles: delta?.operations.length ?? 0, addedLines: delta?.operations.reduce((sum, item) => sum + item.addedLines, 0) ?? 0, removedLines: delta?.operations.reduce((sum, item) => sum + item.removedLines, 0) ?? 0, changedSourceBytes: delta?.operations.reduce((sum, item) => sum + item.bytes, 0) ?? 0, toolResultBytes: records.reduce((sum, item) => sum + item.bytes, 0), durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd };
  }
  private resolveSourcePath(path: string): string {
    if (!isSafeRelative(path) || !ALLOWED_EXTENSIONS.some((extension) => path.endsWith(extension)) || BLOCKED_PREFIXES.some((prefix) => path.split("/").includes(prefix))) throw new CapabilityError("PATH_FORBIDDEN", "Path is outside allowed source capability");
    if (!this.sourceRoots.some((root) => path === root || path.startsWith(`${root}/`))) throw new CapabilityError("PATH_FORBIDDEN", "Path is not within a declared source root");
    const target = resolve(this.candidateRoot, path);
    if (!target.startsWith(`${this.candidateRoot}${sep}`)) throw new CapabilityError("PATH_FORBIDDEN", "Path escapes candidate workspace");
    return target;
  }
  private async assertSafeExistingTarget(target: string): Promise<void> { const targetStat = await lstat(target); if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new CapabilityError("PATH_NOT_REGULAR_FILE", "Workspace target must be a regular non-symlink file"); const [resolvedTarget, resolvedRoot] = await Promise.all([realpath(target), realpath(this.candidateRoot)]); if (!resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) throw new CapabilityError("PATH_FORBIDDEN", "Workspace target escapes through a symlink"); }
}

export class BoundedToolHost implements AgentToolHost {
  private readonly callRecords: ToolCallRecord[] = [];
  private readonly buildPlans: BuildPlan[] = [];
  private totalResultBytes = 0;
  constructor(private readonly workspace: CandidateWorkspace, private readonly budgets: BudgetPolicy) {}
  definitions(): AgentToolDefinition[] { return TOOL_DEFINITIONS; }
  records(): readonly ToolCallRecord[] { return this.callRecords; }
  plans(): BuildPlan[] { return [...this.buildPlans]; }
  async execute(name: string, input: unknown): Promise<ToolResult> {
    const definition = TOOL_DEFINITIONS.find((item) => item.name === name);
    if (!definition) return this.record(name, input, fail("TOOL_UNKNOWN", `Unknown Forge tool: ${name}`));
    if (this.callRecords.length >= this.budgets.maxToolCalls) return this.record(name, input, fail("TOOL_BUDGET_EXHAUSTED", "Tool-call budget exhausted"));
    try {
      const parsed = z.object(definition.inputShape).parse(input);
      let value: unknown;
      switch (name) {
        case "project.list": value = (await this.workspace.list()).slice(0, 100); break;
        case "project.search": value = await this.search(parsed as { query: string }); break;
        case "project.read": value = await this.read(parsed as { path: string; startLine?: number; maxLines?: number }); break;
        case "project.inspect": value = await this.inspect(); break;
        case "plan.update": value = this.updatePlan(parsed as Parameters<BoundedToolHost["updatePlan"]>[0]); break;
        case "workspace.write": if (this.buildPlans.length === 0) throw new CapabilityError("PLAN_REQUIRED", "workspace.write requires a BuildPlan first"); await this.workspace.write((parsed as { path: string }).path, (parsed as { beforeHash: string }).beforeHash, (parsed as { content: string }).content); value = { path: (parsed as { path: string }).path, written: true }; break;
        case "workspace.diff": value = await this.diff(); break;
        case "forge.verify": value = await this.verify(); break;
        default: value = null;
      }
      return this.record(name, input, bounded(value));
    } catch (error) { return this.record(name, input, fail(error instanceof CapabilityError ? error.code : "TOOL_INPUT_OR_EXECUTION", error instanceof Error ? error.message : String(error))); }
  }
  private record(name: string, input: unknown, result: ToolResult): ToolResult {
    this.totalResultBytes += result.bytes;
    if (this.totalResultBytes > this.budgets.maxToolResultBytes) result = fail("TOOL_OUTPUT_BUDGET_EXHAUSTED", "Aggregate tool-result budget exhausted");
    this.callRecords.push({ sequence: this.callRecords.length + 1, name, inputHash: contentHash(stableJson(input)), resultHash: result.resultHash, truncated: result.truncated, bytes: result.bytes, at: new Date().toISOString(), input, result });
    return result;
  }
  private async search(input: { query: string; maxResults?: number }): Promise<unknown> { assertNonEmpty(input.query, "search query"); const results: Array<{ path: string; line: number; text: string }> = []; for (const file of await this.workspace.list()) { const source = await this.workspace.read(file.path); for (const [index, line] of source.split("\n").entries()) if (line.includes(input.query)) results.push({ path: file.path, line: index + 1, text: line.slice(0, 300) }); } return results.slice(0, Math.min(input.maxResults ?? 40, 40)); }
  private async read(input: { path: string; startLine?: number; maxLines?: number }): Promise<unknown> { const source = await this.workspace.read(input.path); const start = Math.max(1, input.startLine ?? 1); const max = Math.min(200, input.maxLines ?? 200); const linesOut = source.split("\n").slice(start - 1, start - 1 + max); return { path: input.path, startLine: start, lines: linesOut, sourceHash: contentHash(source), truncated: start - 1 + max < source.split("\n").length }; }
  private async inspect(): Promise<unknown> { const map = await this.workspace.semanticMap(); return { projectId: map.projectId, files: map.files.map((file) => ({ path: file.path, executionContext: file.executionContext, sourceHash: contentHash(file.source) })), remotes: map.remotes.map(({ path, className, direction, clientScript, serverScript }) => ({ path, className, direction, clientScript, serverScript })), persistentState: map.persistentState, uiBindings: map.uiBindings, snapshotHash: map.hashes.sourceHash }; }
  private updatePlan(input: { goal: string; steps: Array<{ id: string; statement: string; status: "pending" | "in_progress" | "completed" }>; currentStepId?: string; assumptions?: string[]; expectedTouchedAreas?: string[]; verificationIntentions?: string[]; status: "draft" | "active" | "complete" }): BuildPlan { if (this.buildPlans.length === 0 && input.steps.length === 0) throw new CapabilityError("PLAN_INVALID", "BuildPlan needs at least one step"); const revision = this.buildPlans.length + 1; const plan: BuildPlan = { kind: "BuildPlan", schemaVersion: 1, id: `build_plan_${contentHash(stableJson({ goal: input.goal, revision, steps: input.steps })).slice(0, 24)}`, revision, goal: input.goal, steps: [...input.steps], ...(input.currentStepId ? { currentStepId: input.currentStepId } : {}), assumptions: [...(input.assumptions ?? [])], expectedTouchedAreas: [...(input.expectedTouchedAreas ?? [])], verificationIntentions: [...(input.verificationIntentions ?? [])], status: input.status, source: "agent_plan", authority: "hypothesis" }; assertBuildPlan(plan); this.buildPlans.push(plan); return plan; }
  private async diff(): Promise<unknown> { const delta = await this.workspace.freezeDelta(); return { id: delta.id, operations: delta.operations.map(({ path, beforeHash, afterHash, addedLines, removedLines }) => ({ path, beforeHash, afterHash, addedLines, removedLines })) }; }
  private async verify(): Promise<unknown> { const run = await this.workspace.verify(); return { gate: run.report.gate.status === "verified" ? "locally_eligible" : run.report.gate.status, issues: run.report.issues.slice(0, 50).map(sanitizeIssue), reportHash: contentHash(stableJson(run.report)) }; }
}

const TOOL_DEFINITIONS: AgentToolDefinition[] = [
  definition("project.list", "List bounded source files only.", {}),
  definition("project.search", "Search bounded source files for a literal string.", { query: z.string().min(1), maxResults: z.number().int().positive().max(40).optional() }),
  definition("project.read", "Read a bounded range from one source file.", { path: z.string().min(1), startLine: z.number().int().positive().optional(), maxLines: z.number().int().positive().max(200).optional() }),
  definition("project.inspect", "Inspect sanitized project facts without exposing fixture expectations or hidden evaluator data.", {}),
  definition("plan.update", "Create or revise the agent-owned high-level BuildPlan. Call before the first write.", { goal: z.string().min(1), steps: z.array(z.object({ id: z.string().min(1), statement: z.string().min(1), status: z.enum(["pending", "in_progress", "completed"]) })).min(1), currentStepId: z.string().min(1).optional(), assumptions: z.array(z.string()).optional(), expectedTouchedAreas: z.array(z.string()).optional(), verificationIntentions: z.array(z.string()).optional(), status: z.enum(["draft", "active", "complete"]) }),
  definition("workspace.write", "Replace one existing source file using its current content hash. A BuildPlan is required first.", { path: z.string().min(1), beforeHash: z.string().regex(/^[0-9a-f]{64}$/), content: z.string() }),
  definition("workspace.diff", "Return a bounded summary of changed source files.", {}),
  definition("forge.verify", "Run the local static/semantic verifier and return sanitized diagnostics. This is optional; an independent final gate always runs.", {})
];

function definition(name: string, description: string, inputShape: ZodRawShape): AgentToolDefinition { return { name, description, inputShape, schema: z.toJSONSchema(z.object(inputShape)) }; }

function createAgentBuildTrace(run: AgentRun, configuration: HarnessConfiguration, consumption: BudgetConsumption, verification: VerificationRun | undefined): BuildTrace {
  const recorder = new FlightRecorder({ projectId: `project_${contentHash(run.seedHash).slice(0, 24)}`, references: { agentRunId: run.id, requirementSetId: run.requirementSetId, requirementViewId: run.requirementViewId, ...(run.workspaceDelta ? { workspaceDeltaId: run.workspaceDelta.id } : {}), harnessConfigurationId: configuration.id, harnessConfigurationHash: configuration.hash }, components: { toolchain: [], verifiers: [], agent: { name: run.provider.name, version: run.provider.version, configHash: configuration.hash }, model: { provider: run.provider.name, name: run.provider.model, version: run.provider.version, configurationHash: configuration.hash } } });
  recorder.recordSpan("forge.agent.execute", run.classification === "accepted" ? "ok" : "error", { "forge.agent.run_id": run.id, "forge.harness.configuration_hash": configuration.hash, "forge.tool.call_count": run.toolCalls.length });
  recorder.recordSpan("forge.model.generate", run.classification === "provider_failure" ? "error" : "ok", { "forge.model.turns": consumption.turns, "forge.model.cost_usd": consumption.costUsd ?? 0 });
  for (const call of run.toolCalls) recorder.recordSpan("forge.tool.call", call.result.ok ? "ok" : "error", { "forge.tool.name": call.name, "forge.tool.result_hash": call.resultHash, "forge.tool.truncated": call.truncated });
  const counts = { info: 0, warning: 0, error: 0, critical: 0 };
  for (const issue of verification?.report.issues ?? []) counts[issue.severity] += 1;
  const outcome: BuildOutcome = { status: run.status === "locally_eligible" ? "accepted" : run.status === "rejected" ? "rejected" : "incomplete", verified: false, staticPass: run.status === "locally_eligible", semanticPass: run.status === "locally_eligible", studioPass: "unknown", attempts: 1, deterministicRepairs: 0, modelRepairs: 0, assertions: { total: 0, passed: 0 }, modelUsage: { calls: consumption.turns, inputTokens: consumption.inputTokens, outputTokens: consumption.outputTokens, costUsd: consumption.costUsd }, latencyMs: { total: consumption.durationMs }, issueCounts: counts };
  return recorder.complete(outcome, { ...(verification ? { verificationReportHash: contentHash(stableJson(verification.report)) } : {}), issues: (verification?.report.issues ?? []).map((issue) => ({ id: issue.id, ruleId: issue.ruleId, severity: issue.severity, category: issue.category, evidenceHash: contentHash(stableJson(issue.evidence)) })) }, { level: "semantic_reproduction", reasons: ["M4.1 records local eligibility only; real Studio execution was not run."], randomSeeds: {} });
}

async function persistAgentRun(run: AgentRun, directory: string): Promise<AgentRunPersistence> { const path = join(resolve(directory), `${run.id}.json`); await mkdir(dirname(path), { recursive: true }); const serialized = `${stableJson(run)}\n`; const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`); await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); return { path: relative(process.cwd(), path), artifactHash: contentHash(serialized), mode: 0o600 }; }
function bounded(value: unknown): ToolResult { const serialized = stableJson(value); const limit = 32 * 1024; const rendered = Buffer.byteLength(serialized, "utf8") > limit ? serialized.slice(0, limit) : serialized; const truncated = rendered !== serialized; const result = truncated ? { truncated: true, preview: rendered } : value; return { ok: true, value: result, truncated, resultHash: contentHash(serialized), bytes: Buffer.byteLength(rendered, "utf8") }; }
function fail(code: string, message: string): ToolResult { const value = { code, message }; return { ok: false, error: value, truncated: false, resultHash: contentHash(stableJson(value)), bytes: Buffer.byteLength(stableJson(value), "utf8") }; }
function sanitizeIssue(issue: VerificationIssue): unknown { return { id: issue.id, ruleId: issue.ruleId, severity: issue.severity, category: issue.category, ...(issue.path ? { path: issue.path } : {}), ...(issue.location ? { line: issue.location.line } : {}) }; }
function exhaustedBudgets(policy: BudgetPolicy, used: BudgetConsumption): string[] { const pairs: Array<[keyof BudgetPolicy, number | null]> = [["maxTurns", used.turns], ["maxToolCalls", used.toolCalls], ["maxWrites", used.writes], ["maxVerifierCalls", used.verifierCalls], ["maxChangedFiles", used.changedFiles], ["maxAddedLines", used.addedLines], ["maxRemovedLines", used.removedLines], ["maxChangedSourceBytes", used.changedSourceBytes], ["maxToolResultBytes", used.toolResultBytes], ["maxDurationMs", used.durationMs], ["maxBudgetUsd", used.costUsd], ["maxInputTokens", used.inputTokens], ["maxOutputTokens", used.outputTokens]]; return pairs.filter(([key, value]) => value !== null && value > policy[key]).map(([key]) => String(key)); }
async function sourceFiles(root: string, roots: string[]): Promise<Array<{ path: string; bytes: number }>> { const entries: Array<{ path: string; bytes: number }> = []; for (const sourceRoot of roots) await visit(join(root, sourceRoot), sourceRoot, entries); return entries; }
async function sourceFileSnapshots(root: string, roots: string[]): Promise<Map<string, { hash: string; source: string }>> { const snapshots = new Map<string, { hash: string; source: string }>(); for (const file of await sourceFiles(root, roots)) { const source = await readFile(join(root, file.path), "utf8"); snapshots.set(file.path, { hash: contentHash(source), source }); } return snapshots; }
async function visit(absolute: string, relativePath: string, results: Array<{ path: string; bytes: number }>): Promise<void> { for (const entry of await readdir(absolute, { withFileTypes: true })) { const path = join(absolute, entry.name); const rel = `${relativePath}/${entry.name}`; if (entry.isDirectory()) await visit(path, rel, results); else if (entry.isFile() && ALLOWED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) results.push({ path: rel, bytes: (await stat(path)).size }); } }
async function treeHash(root: string): Promise<string> { const files: Array<{ path: string; hash: string }> = []; async function walk(directory: string): Promise<void> { for (const entry of await readdir(directory, { withFileTypes: true })) { const target = join(directory, entry.name); const rel = relative(root, target).replaceAll("\\", "/"); if (entry.isDirectory()) await walk(target); else if (entry.isFile()) files.push({ path: rel, hash: contentHash(await readFile(target, "utf8")) }); } } await walk(root); return contentHash(stableJson(files.sort((left, right) => left.path.localeCompare(right.path)))); }
function lines(value: string): number { return value.length === 0 ? 0 : value.split("\n").length; }
function isSafeRelative(path: string): boolean { return path.length > 0 && !path.includes("\0") && !path.startsWith("/") && !path.startsWith("\\") && !path.split(/[\\/]+/).includes(".."); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isIdentifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !/\s/.test(value); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function assertNonEmpty(value: string, label: string): void { if (value.trim().length === 0) throw new Error(`${label} must be non-empty`); }
class CapabilityError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const DEFAULT_SYSTEM_PROMPT = "You are a bounded Forge builder. Work only through Forge tools. Inspect first, publish a high-level plan before writing, preserve observed integration facts unless the creator explicitly asks to change them, and do not claim Studio execution. Complete the task or report limits honestly.";
