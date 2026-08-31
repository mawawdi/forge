import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z, type ZodRawShape } from "zod";
import { contentHash, stableJson, type BuildOutcome, type BuildTrace, type TracePersistence, type VerificationIssue } from "../../contracts/src/index.js";
import { compileAgentOrientation, type AgentOrientation } from "../../context-compiler/src/index.js";
import { FlightRecorder, JsonFileTraceSink } from "../../flight-recorder/src/index.js";
import type { ModelClient, ModelMessage, ModelResponseFacts, ModelToolCall, ModelTurnResult, ModelUsage } from "../../model-client/src/contracts.js";
import { assertRequirementSet, resolveRequirementView, type RequirementSet } from "../../semantic-authority/src/index.js";
import { createProjectSnapshot, FilesystemProjectSourceAdapter } from "../../semantic-map/src/index.js";
import { verifyProject, type VerificationRun } from "../../verifier/src/index.js";

export type AgentRunStatus = "locally_eligible" | "rejected" | "incomplete";
export type AgentFailureClassification = "none" | "agent_failure" | "tool_failure" | "budget_exhausted" | "verification_failure" | "workspace_capability_violation" | "provider_failure" | "harness_failure" | "incomplete";

export interface BudgetPolicy {
  maxTurns: number; maxToolCalls: number; maxWrites: number; maxVerifierCalls: number;
  maxChangedFiles: number; maxAddedLines: number; maxRemovedLines: number;
  maxBytesPerFile: number; maxChangedSourceBytes: number; maxToolResultBytes: number;
  maxDurationMs: number; maxBudgetUsd: number; maxInputTokens: number; maxOutputTokens: number;
}

export const INITIAL_EXPERIMENT_BUDGETS: BudgetPolicy = {
  maxTurns: 12, maxToolCalls: 48, maxWrites: 12, maxVerifierCalls: 4,
  maxChangedFiles: 6, maxAddedLines: 520, maxRemovedLines: 140,
  maxBytesPerFile: 48_000, maxChangedSourceBytes: 96_000, maxToolResultBytes: 256 * 1024,
  maxDurationMs: 8 * 60_000, maxBudgetUsd: 2, maxInputTokens: 100_000, maxOutputTokens: 20_000
};

export interface HarnessConfigurationInput {
  systemPrompt: string;
  tools: readonly { name: string; description: string; schema: unknown }[];
  capabilityPolicy: { sourceRoots: string[]; blockedPathPrefixes: string[]; allowedExtensions: string[] };
  orientation: Pick<AgentOrientation, "policy" | "contentHash">;
  requirementViewHash: string;
  budgets: BudgetPolicy;
  runtime: { name: string; version: string };
  model: { transport: string; name: string; clientVersion: string; transportConfiguration: ModelClient["descriptor"]["configuration"] };
}

export interface HarnessConfiguration extends HarnessConfigurationInput {
  kind: "HarnessConfiguration"; schemaVersion: 3; id: string; hash: string;
}

export function createHarnessConfiguration(input: HarnessConfigurationInput): HarnessConfiguration {
  assertNonEmpty(input.systemPrompt, "HarnessConfiguration system prompt");
  const canonical = canonicalHarnessInput(input);
  const hash = contentHash(stableJson(canonical));
  const configuration: HarnessConfiguration = { kind: "HarnessConfiguration", schemaVersion: 3, id: `harness_configuration_${hash.slice(0, 24)}`, hash, ...canonical };
  assertHarnessConfiguration(configuration);
  return configuration;
}

export function assertHarnessConfiguration(value: unknown): asserts value is HarnessConfiguration {
  if (!isRecord(value) || value.kind !== "HarnessConfiguration" || value.schemaVersion !== 3 || !isIdentifier(value.id) || !isHash(value.hash) || typeof value.systemPrompt !== "string" || !Array.isArray(value.tools) || !isRecord(value.capabilityPolicy) || !isRecord(value.orientation) || !isHash(value.requirementViewHash) || !isRecord(value.budgets) || !isRecord(value.runtime) || !isRecord(value.model) || !isRecord(value.model.transportConfiguration)) throw new Error("Invalid HarnessConfiguration");
  const canonical = canonicalHarnessInput(value as unknown as HarnessConfigurationInput);
  const expectedHash = contentHash(stableJson(canonical));
  if (value.hash !== expectedHash || value.id !== `harness_configuration_${expectedHash.slice(0, 24)}`) throw new Error("Invalid HarnessConfiguration identity");
}

function canonicalHarnessInput(input: HarnessConfigurationInput): HarnessConfigurationInput {
  return {
    systemPrompt: input.systemPrompt,
    tools: [...input.tools].map((tool) => ({ name: tool.name, description: tool.description, schema: tool.schema })),
    capabilityPolicy: { sourceRoots: [...input.capabilityPolicy.sourceRoots].sort(), blockedPathPrefixes: [...input.capabilityPolicy.blockedPathPrefixes].sort(), allowedExtensions: [...input.capabilityPolicy.allowedExtensions].sort() },
    orientation: { policy: input.orientation.policy, contentHash: input.orientation.contentHash },
    requirementViewHash: input.requirementViewHash,
    budgets: { ...input.budgets }, runtime: { ...input.runtime }, model: { ...input.model }
  };
}

export interface BuildPlan {
  kind: "BuildPlan"; schemaVersion: 1; id: string; revision: number; goal: string;
  steps: Array<{ id: string; statement: string; status: "pending" | "in_progress" | "completed" }>;
  currentStepId?: string; assumptions: string[]; expectedTouchedAreas: string[]; verificationIntentions: string[];
  status: "draft" | "active" | "complete"; source: "agent_plan"; authority: "hypothesis";
}

export interface WorkspaceDeltaOperation { path: string; beforeHash: string | null; afterHash: string; addedLines: number; removedLines: number; bytes: number }
export interface WorkspaceDelta { kind: "WorkspaceDelta"; schemaVersion: 1; id: string; seedHash: string; candidateHash: string; operations: WorkspaceDeltaOperation[] }
export type WorkspaceWritePrecondition = { kind: "sha256"; hash: string } | { kind: "absent" };

export interface WorkspaceCandidateArtifact {
  kind: "WorkspaceCandidateArtifact"; schemaVersion: 1; id: string; artifactHash: string;
  origin: { kind: "agent_run"; agentRunId: string };
  createdAt: string; seedRoot: string; seedHash: string; candidateDirectory: string; candidateHash: string;
  workspaceDelta: WorkspaceDelta; requirementSetId: string; requirementViewId: string;
  harnessConfigurationId: string; harnessConfigurationHash: string;
  sourceFiles: Array<{ path: string; sourceHash: string; executionContext: "server" | "client" | "shared" | "unknown" }>;
  localGate: { status: "locally_eligible"; reportHash: string; traceId: string };
}

export interface WorkspaceCandidateArtifactPersistence { path: string; artifactHash: string; mode: number }
export interface LoadedWorkspaceCandidateArtifact { artifact: WorkspaceCandidateArtifact; candidateRoot: string; verification: VerificationRun }
export interface ToolResult { ok: boolean; value?: unknown; error?: { code: string; message: string }; truncated: boolean; resultHash: string; bytes: number }
export interface ToolCallRecord { sequence: number; name: string; inputHash: string; resultHash: string; truncated: boolean; bytes: number; at: string; input: unknown; result: ToolResult }
export interface AgentToolDefinition { name: string; description: string; inputShape: ZodRawShape; schema: unknown }
export interface ToolBatchDecision { valid: boolean; feedback: Array<{ id: string; name: string; result: ToolResult }>; budgetExhausted: boolean }
export interface AgentToolHost {
  definitions(): AgentToolDefinition[];
  validateBatch(calls: readonly ModelToolCall[], seenIds: ReadonlySet<string>): ToolBatchDecision;
  execute(name: string, input: unknown): Promise<ToolResult>;
  records(): readonly ToolCallRecord[];
}

export interface AgentModelTurn {
  sequence: number; requestHash: string; resultKind: ModelTurnResult["kind"]; responseHash?: string;
  providerMetadataHash?: string; stopReason?: Extract<ModelTurnResult, { kind: "assistant" }>["stopReason"];
  responseFacts?: ModelResponseFacts; toolCallIds: string[]; usage: ModelUsage; errorClass?: string;
}
export interface RuntimeUsage { turns: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
export interface AgentRuntimeInput { systemPrompt: string; prompt: string; orientation: AgentOrientation; tools: AgentToolHost; budgets: BudgetPolicy; model: string }
export interface AgentRuntimeResult { status: "completed" | "failed" | "budget_exhausted"; trialStarted: boolean; summary?: string; error?: string; failureKind?: "provider" | "model" | "tool" | "harness"; usage: RuntimeUsage; turns: AgentModelTurn[] }
export interface AgentRuntime { readonly identity: { name: string; version: string }; readonly modelClientDescriptor: ModelClient["descriptor"]; run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> }

export class ForgeNativeAgentRuntime implements AgentRuntime {
  readonly identity = { name: "forge-native-agent-runtime", version: "1.1.0" };
  readonly modelClientDescriptor: ModelClient["descriptor"];
  constructor(private readonly modelClient: ModelClient) { this.modelClientDescriptor = { ...modelClient.descriptor }; }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const messages: ModelMessage[] = [{ role: "user", content: stableJson({ creatorRequest: input.prompt, orientation: input.orientation }) }];
    const turns: AgentModelTurn[] = [];
    const seenToolCallIds = new Set<string>();
    let trialStarted = false;
    let usage: RuntimeUsage = emptyRuntimeUsage();
    const startedAt = Date.now();
    const tools = input.tools.definitions().map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.schema }));
    for (let sequence = 1; sequence <= input.budgets.maxTurns; sequence += 1) {
      const remainingMs = input.budgets.maxDurationMs - (Date.now() - startedAt);
      if (remainingMs <= 0) return runtimeBudgetResult("Duration budget exhausted", usage, turns, trialStarted);
      const remainingOutput = input.budgets.maxOutputTokens - (usage.outputTokens ?? 0);
      if (remainingOutput <= 0) return runtimeBudgetResult("Output-token budget exhausted", usage, turns, trialStarted);
      let result: ModelTurnResult;
      try {
        result = await this.modelClient.complete({ model: input.model, system: input.systemPrompt, messages, tools, maxOutputTokens: Math.min(this.modelClientDescriptor.configuration.request.maxOutputTokensPerTurn, remainingOutput), timeoutMs: remainingMs });
      } catch (error) {
        return { status: "failed", trialStarted, failureKind: "provider", error: error instanceof Error ? error.message : String(error), usage, turns };
      }
      if (result.kind !== "provider_error" || result.responseFacts.responseId !== null) trialStarted = true;
      usage = addUsage(usage, result.usage);
      turns.push({ sequence, requestHash: result.requestHash, resultKind: result.kind,
        ...(result.kind === "assistant" ? { responseHash: result.responseHash, stopReason: result.stopReason, toolCallIds: result.message.toolCalls.map((call) => call.id) } : { errorClass: result.errorClass, toolCallIds: [] }),
        ...(result.responseFacts ? { responseFacts: { ...result.responseFacts } } : {}),
        ...(result.providerMetadataHash ? { providerMetadataHash: result.providerMetadataHash } : {}), usage: { ...result.usage } });
      if (exceedsModelBudgets(input.budgets, usage)) return runtimeBudgetResult("Provider usage exceeded a post-step budget", usage, turns, trialStarted);
      if (result.kind === "provider_error") return { status: "failed", trialStarted, failureKind: "provider", error: `${result.errorClass}: ${result.message}`, usage, turns };
      if (result.kind === "invalid_model_response") return { status: "failed", trialStarted, failureKind: "model", error: `${result.errorClass}: ${result.message}`, usage, turns };
      if (result.message.toolCalls.length === 0) {
        if (result.stopReason === "max_tokens") return runtimeBudgetResult("Model stopped at the output-token limit", usage, turns, trialStarted);
        if (result.stopReason === "refusal") return { status: "failed", trialStarted, failureKind: "model", error: "Model refused the bounded build request", usage, turns };
        return { status: "completed", trialStarted, ...(result.message.content ? { summary: result.message.content } : {}), usage, turns };
      }
      const decision = input.tools.validateBatch(result.message.toolCalls, seenToolCallIds);
      for (const call of result.message.toolCalls) if (call.id.length > 0) seenToolCallIds.add(call.id);
      if (!decision.valid) {
        messages.push({ role: "user", content: stableJson({ forgeToolBatchRejected: true, rule: "No tool was executed because the full batch was not valid.", feedback: decision.feedback }) });
        if (decision.budgetExhausted) return runtimeBudgetResult("Tool-call or tool-output budget exhausted while rejecting a model batch", usage, turns, trialStarted);
        continue;
      }
      messages.push(result.message);
      for (const call of result.message.toolCalls) {
        const toolResult = await input.tools.execute(call.name, call.arguments);
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: stableJson(toolResult) });
        if (!toolResult.ok && ["TOOL_BUDGET_EXHAUSTED", "TOOL_OUTPUT_BUDGET_EXHAUSTED"].includes(toolResult.error?.code ?? "")) return runtimeBudgetResult(toolResult.error?.message ?? "Tool budget exhausted", usage, turns, trialStarted);
      }
    }
    return runtimeBudgetResult("Turn budget exhausted", usage, turns, trialStarted);
  }
}

export interface BudgetConsumption { turns: number; toolCalls: number; writes: number; verifierCalls: number; changedFiles: number; addedLines: number; removedLines: number; changedSourceBytes: number; toolResultBytes: number; durationMs: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
export interface AgentRunPersistence { path: string; artifactHash: string; mode: number }
export interface AgentRun {
  kind: "AgentRun"; schemaVersion: 3; id: string; createdAt: string; status: AgentRunStatus; classification: AgentFailureClassification; trialStarted: boolean;
  creatorPromptHash: string; requirementSetId: string; requirementViewId: string; orientationId: string;
  harnessConfigurationId: string; harnessConfigurationHash: string; seedHash: string; workspaceDelta?: WorkspaceDelta;
  runtime: { name: string; version: string }; model: { transport: string; name: string; clientVersion: string; transportConfiguration: ModelClient["descriptor"]["configuration"] }; modelTurns: AgentModelTurn[];
  plans: BuildPlan[]; toolCalls: ToolCallRecord[]; budgets: { policy: BudgetPolicy; consumed: BudgetConsumption; exhausted: string[] };
  finalVerification: { gate: "eligible" | "rejected" | "incomplete"; reportHash: string; traceId: string };
  buildTraceId?: string; studio: "not_run"; summary?: string; error?: string;
}
export interface AgentBuildRequest { seedRoot: string; creatorPrompt: string; requirementSet: RequirementSet; runtime: AgentRuntime; model: string; runDirectory: string; traceDirectory: string; environment?: "production" | "benchmark"; budgets?: BudgetPolicy; systemPrompt?: string }
export interface AgentBuildResult { status: AgentRunStatus; classification: AgentFailureClassification; run: AgentRun; persistence: AgentRunPersistence; candidateRoot: string; candidateArtifact?: { artifact: WorkspaceCandidateArtifact; persistence: WorkspaceCandidateArtifactPersistence }; trace: BuildTrace; tracePersistence: TracePersistence; finalVerification: VerificationRun }

export function assertBuildPlan(value: unknown): asserts value is BuildPlan { if (!isRecord(value) || value.kind !== "BuildPlan" || value.schemaVersion !== 1 || !isIdentifier(value.id) || !Number.isInteger(value.revision) || typeof value.goal !== "string" || !Array.isArray(value.steps) || value.source !== "agent_plan" || value.authority !== "hypothesis") throw new Error("Invalid BuildPlan"); }
export function assertWorkspaceDelta(value: unknown): asserts value is WorkspaceDelta { if (!isRecord(value) || value.kind !== "WorkspaceDelta" || value.schemaVersion !== 1 || !isIdentifier(value.id) || !isHash(value.seedHash) || !isHash(value.candidateHash) || !Array.isArray(value.operations)) throw new Error("Invalid WorkspaceDelta"); }
export function assertAgentRun(value: unknown): asserts value is AgentRun { if (!isRecord(value) || value.kind !== "AgentRun" || value.schemaVersion !== 3 || !isIdentifier(value.id) || typeof value.trialStarted !== "boolean" || !["locally_eligible", "rejected", "incomplete"].includes(String(value.status)) || !["none", "agent_failure", "tool_failure", "budget_exhausted", "verification_failure", "workspace_capability_violation", "provider_failure", "harness_failure", "incomplete"].includes(String(value.classification)) || value.studio !== "not_run" || !Array.isArray(value.modelTurns) || !isRecord(value.finalVerification) || !isRecord(value.model) || !isRecord(value.model.transportConfiguration)) throw new Error("Invalid AgentRun"); }

export function assertWorkspaceCandidateArtifact(value: unknown): asserts value is WorkspaceCandidateArtifact {
  if (!isRecord(value) || value.kind !== "WorkspaceCandidateArtifact" || value.schemaVersion !== 1 || !isIdentifier(value.id) || !isHash(value.artifactHash) || !isString(value.createdAt) || !isString(value.seedRoot) || !isHash(value.seedHash) || !isSafeRelative(String(value.candidateDirectory)) || !isHash(value.candidateHash) || !isRecord(value.origin) || !isIdentifier(value.requirementSetId) || !isIdentifier(value.requirementViewId) || !isIdentifier(value.harnessConfigurationId) || !isHash(value.harnessConfigurationHash) || !Array.isArray(value.sourceFiles) || !isRecord(value.localGate)) throw new Error("Invalid WorkspaceCandidateArtifact");
  if (value.origin.kind !== "agent_run" || !isIdentifier(value.origin.agentRunId)) throw new Error("Invalid WorkspaceCandidateArtifact origin");
  assertWorkspaceDelta(value.workspaceDelta);
  if (value.workspaceDelta.seedHash !== value.seedHash || value.workspaceDelta.candidateHash !== value.candidateHash) throw new Error("WorkspaceCandidateArtifact delta hashes do not match");
  if (!(value.sourceFiles as unknown[]).every((file) => isRecord(file) && isSafeRelative(String(file.path)) && isHash(file.sourceHash) && ["server", "client", "shared", "unknown"].includes(String(file.executionContext)))) throw new Error("Invalid WorkspaceCandidateArtifact source manifest");
  const files = value.sourceFiles as Array<{ path: string }>;
  if (new Set(files.map((file) => file.path)).size !== files.length || files.some((file, index) => index > 0 && files[index - 1]!.path.localeCompare(file.path) >= 0)) throw new Error("WorkspaceCandidateArtifact source manifest is not canonical");
  if (value.localGate.status !== "locally_eligible" || !isHash(value.localGate.reportHash) || !isIdentifier(value.localGate.traceId)) throw new Error("Invalid WorkspaceCandidateArtifact local gate");
  const { id: _id, artifactHash, ...payload } = value;
  const expectedHash = contentHash(stableJson(payload));
  if (artifactHash !== expectedHash || value.id !== `workspace_candidate_${expectedHash.slice(0, 24)}`) throw new Error("Invalid WorkspaceCandidateArtifact identity");
}

const BLOCKED_PREFIXES = [".forge", "runs", "proofs", "regressions", "patches", "credentials", "hidden", "benchmark", "repair"];
const ALLOWED_EXTENSIONS = [".lua", ".luau"];
const WORKSPACE_CAPABILITY_CODES = new Set(["PATH_FORBIDDEN", "PATH_NOT_REGULAR_FILE", "PATH_NOT_REGULAR_DIRECTORY", "PATH_ALREADY_EXISTS", "STALE_WRITE", "PLAN_REQUIRED", "WRITE_BUDGET_EXHAUSTED", "WRITE_SIZE_EXCEEDED", "DELTA_BUDGET_EXCEEDED"]);

export async function runBoundedAgent(request: AgentBuildRequest): Promise<AgentBuildResult> {
  assertRequirementSet(request.requirementSet);
  assertNonEmpty(request.creatorPrompt, "creator prompt");
  assertNonEmpty(request.model, "model");
  const creator = request.requirementSet.requirements.find((requirement) => requirement.source === "creator" && requirement.evidence.some((evidence) => evidence.kind === "creator_request" && evidence.requestHash === contentHash(request.creatorPrompt)));
  if (!creator) throw new Error("Creator prompt must have hash-matched creator requirement evidence");
  const budgets = { ...(request.budgets ?? INITIAL_EXPERIMENT_BUDGETS) };
  const startedAt = Date.now();
  const runId = `agent_run_${randomUUID()}`;
  const requirementView = resolveRequirementView(request.requirementSet, { phase: "build", environment: request.environment ?? "production", audience: "builder" });
  const workspace = await CandidateWorkspace.create(request.seedRoot, request.runDirectory, budgets, request.traceDirectory);
  const semanticMap = await workspace.semanticMap();
  const orientation = compileAgentOrientation({ semanticMap, projectSnapshotHash: createProjectSnapshot(semanticMap).projectSemanticHash, requirementView });
  const toolHost = new BoundedToolHost(workspace, budgets);
  const systemPrompt = request.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const modelDescriptor = { transport: request.runtime.modelClientDescriptor.transport, name: request.model, clientVersion: request.runtime.modelClientDescriptor.version, transportConfiguration: request.runtime.modelClientDescriptor.configuration };
  const configuration = createHarnessConfiguration({
    systemPrompt,
    tools: toolHost.definitions().map((tool) => ({ name: tool.name, description: tool.description, schema: tool.schema })),
    capabilityPolicy: { sourceRoots: workspace.sourceRoots, blockedPathPrefixes: BLOCKED_PREFIXES, allowedExtensions: ALLOWED_EXTENSIONS },
    orientation: { policy: orientation.policy, contentHash: orientation.contentHash },
    requirementViewHash: contentHash(stableJson(requirementView)), budgets,
    runtime: request.runtime.identity, model: modelDescriptor
  });

  let runtimeResult: AgentRuntimeResult;
  try {
    runtimeResult = await request.runtime.run({ systemPrompt, prompt: creator.statement, orientation, tools: toolHost, budgets, model: request.model });
  } catch (error) {
    runtimeResult = { status: "failed", trialStarted: false, failureKind: "harness", error: error instanceof Error ? error.message : String(error), usage: emptyRuntimeUsage(), turns: [] };
  }

  let delta: WorkspaceDelta;
  try { delta = await workspace.freezeDelta(); }
  catch (error) {
    runtimeResult = { ...runtimeResult, status: "failed", failureKind: "tool", error: error instanceof Error ? error.message : String(error) };
    delta = await workspace.currentDeltaUnchecked();
  }
  const consumption = workspace.consumption(toolHost.records(), Date.now() - startedAt, runtimeResult.usage);
  const exhausted = exhaustedBudgets(budgets, consumption);
  const finalVerification = await verifyProject(workspace.candidateRoot, { traceDirectory: request.traceDirectory, traceReferences: { agentRunId: runId, requirementSetId: request.requirementSet.id, requirementViewId: requirementView.id, workspaceDeltaId: delta.id, harnessConfigurationId: configuration.id, harnessConfigurationHash: configuration.hash } });
  await workspace.assertSeedUnchanged();

  let status: AgentRunStatus = "incomplete";
  let classification: AgentFailureClassification = "incomplete";
  if (runtimeResult.status === "budget_exhausted" || exhausted.length > 0) classification = "budget_exhausted";
  else if (runtimeResult.status === "failed") classification = runtimeResult.failureKind === "provider" ? "provider_failure" : runtimeResult.failureKind === "model" ? "agent_failure" : runtimeResult.failureKind === "tool" ? "tool_failure" : "harness_failure";
  else if (toolHost.plans().length === 0 || delta.operations.length === 0) classification = "agent_failure";
  else if (finalVerification.report.gate.status === "eligible") { status = "locally_eligible"; classification = "none"; }
  else if (finalVerification.report.gate.status === "rejected") {
    status = "rejected";
    const failureCodes = toolHost.records().flatMap((record) => record.result.error?.code ? [record.result.error.code] : []);
    classification = failureCodes.some((code) => WORKSPACE_CAPABILITY_CODES.has(code)) ? "workspace_capability_violation" : failureCodes.length > 0 ? "tool_failure" : "verification_failure";
  }

  const run: AgentRun = {
    kind: "AgentRun", schemaVersion: 3, id: runId, createdAt: new Date().toISOString(), status, classification, trialStarted: runtimeResult.trialStarted,
    creatorPromptHash: contentHash(request.creatorPrompt), requirementSetId: request.requirementSet.id, requirementViewId: requirementView.id,
    orientationId: orientation.id, harnessConfigurationId: configuration.id, harnessConfigurationHash: configuration.hash, seedHash: workspace.seedTreeHash,
    ...(delta.operations.length > 0 ? { workspaceDelta: delta } : {}),
    runtime: { ...request.runtime.identity }, model: modelDescriptor, modelTurns: runtimeResult.turns,
    plans: toolHost.plans(), toolCalls: [...toolHost.records()], budgets: { policy: budgets, consumed: consumption, exhausted },
    finalVerification: { gate: finalVerification.report.gate.status, reportHash: contentHash(stableJson(finalVerification.report)), traceId: finalVerification.trace.id },
    studio: "not_run", ...(runtimeResult.summary ? { summary: runtimeResult.summary } : {}), ...(runtimeResult.error ? { error: runtimeResult.error } : {})
  };
  assertAgentRun(run);
  const trace = createAgentBuildTrace(run, configuration, finalVerification);
  const tracePersistence = await new JsonFileTraceSink(request.traceDirectory).persist(trace);
  run.buildTraceId = trace.id;
  const persistence = await persistAgentRun(run, request.runDirectory);
  const candidateArtifact = status === "locally_eligible" && run.workspaceDelta
    ? await persistWorkspaceCandidateArtifact({ directory: request.runDirectory, workspace, run, delta: run.workspaceDelta, requirementSetId: request.requirementSet.id, requirementViewId: requirementView.id, configuration, verification: finalVerification })
    : undefined;
  return { status, classification, run, persistence, candidateRoot: workspace.candidateRoot, ...(candidateArtifact ? { candidateArtifact } : {}), trace, tracePersistence, finalVerification };
}

export class CandidateWorkspace {
  readonly seedRoot: string;
  readonly candidateRoot: string;
  readonly sourceRoots: string[];
  readonly seedTreeHash: string;
  private readonly initialFiles: Map<string, { hash: string; source: string }>;
  private lastDelta: WorkspaceDelta | undefined;
  private writes = 0;
  private verifierCalls = 0;

  private constructor(seedRoot: string, candidateRoot: string, sourceRoots: string[], seedTreeHash: string, initialFiles: Map<string, { hash: string; source: string }>, private readonly budgets: BudgetPolicy, private readonly traceDirectory: string) {
    this.seedRoot = seedRoot; this.candidateRoot = candidateRoot; this.sourceRoots = sourceRoots;
    this.seedTreeHash = seedTreeHash; this.initialFiles = initialFiles;
  }

  static async create(seedRoot: string, runDirectory: string, budgets: BudgetPolicy, traceDirectory = resolve(runDirectory, "traces")): Promise<CandidateWorkspace> {
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
    return new CandidateWorkspace(seed, candidate, sourceRoots, await treeHash(seed), initialFiles, budgets, traceDirectory);
  }

  async semanticMap() {
    const manifest = JSON.parse(await readFile(join(this.candidateRoot, "forge.fixture.json"), "utf8")) as Parameters<FilesystemProjectSourceAdapter["load"]>[0]["manifest"];
    return new FilesystemProjectSourceAdapter().load({ root: this.candidateRoot, manifest });
  }
  async list(): Promise<Array<{ path: string; bytes: number }>> { return (await sourceFiles(this.candidateRoot, this.sourceRoots)).sort((left, right) => left.path.localeCompare(right.path)); }
  async read(path: string): Promise<string> { const target = this.resolveSourcePath(path); await this.assertSafeExistingTarget(target); return readFile(target, "utf8"); }
  async write(path: string, precondition: WorkspaceWritePrecondition, content: string): Promise<void> {
    if (this.writes >= this.budgets.maxWrites) throw new CapabilityError("WRITE_BUDGET_EXHAUSTED", "Workspace write budget exhausted");
    if (Buffer.byteLength(content, "utf8") > this.budgets.maxBytesPerFile) throw new CapabilityError("WRITE_SIZE_EXCEEDED", "Workspace write exceeds per-file budget");
    const target = this.resolveSourcePath(path);
    if (precondition.kind === "sha256") {
      await this.assertSafeExistingTarget(target);
      const existing = await readFile(target, "utf8");
      if (contentHash(existing) !== precondition.hash) throw new CapabilityError("STALE_WRITE", "Workspace write precondition hash does not match");
      await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    } else {
      await this.assertSafeParent(target);
      try { await lstat(target); throw new CapabilityError("PATH_ALREADY_EXISTS", "Absent-file write precondition failed because the target exists"); }
      catch (error) { if (error instanceof CapabilityError) throw error; if (!(isNodeError(error) && error.code === "ENOENT")) throw error; }
      try { await writeFile(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
      catch (error) { if (isNodeError(error) && error.code === "EEXIST") throw new CapabilityError("PATH_ALREADY_EXISTS", "Absent-file write precondition failed because the target exists"); throw error; }
    }
    this.writes += 1;
  }
  async verify(): Promise<VerificationRun> { if (this.verifierCalls >= this.budgets.maxVerifierCalls) throw new CapabilityError("VERIFY_BUDGET_EXHAUSTED", "Verifier-call budget exhausted"); this.verifierCalls += 1; return verifyProject(this.candidateRoot, { traceDirectory: this.traceDirectory }); }
  async freezeDelta(): Promise<WorkspaceDelta> {
    const delta = await this.currentDeltaUnchecked();
    const usage = this.consumption([], 0, emptyRuntimeUsage());
    const failures = exhaustedBudgets(this.budgets, usage).filter((item) => ["maxChangedFiles", "maxAddedLines", "maxRemovedLines", "maxChangedSourceBytes"].includes(item));
    if (failures.length > 0) throw new CapabilityError("DELTA_BUDGET_EXCEEDED", `Workspace delta exceeds budget: ${failures.join(", ")}`);
    return delta;
  }
  async currentDeltaUnchecked(): Promise<WorkspaceDelta> {
    const current = await sourceFileSnapshots(this.candidateRoot, this.sourceRoots);
    const operations: WorkspaceDeltaOperation[] = [];
    for (const path of [...new Set([...this.initialFiles.keys(), ...current.keys()])].sort()) {
      const before = this.initialFiles.get(path); const after = current.get(path);
      if (before?.hash === after?.hash) continue;
      const beforeText = before?.source ?? ""; const afterText = after?.source ?? "";
      operations.push({ path, beforeHash: before?.hash ?? null, afterHash: after?.hash ?? contentHash(""), addedLines: Math.max(0, lineCount(afterText) - lineCount(beforeText)), removedLines: Math.max(0, lineCount(beforeText) - lineCount(afterText)), bytes: Buffer.byteLength(afterText, "utf8") });
    }
    const candidateHash = (await this.semanticMap()).hashes.sourceHash;
    const payload = { seedHash: this.seedTreeHash, candidateHash, operations };
    const delta: WorkspaceDelta = { kind: "WorkspaceDelta", schemaVersion: 1, id: `workspace_delta_${contentHash(stableJson(payload)).slice(0, 24)}`, ...payload };
    assertWorkspaceDelta(delta); this.lastDelta = delta; return delta;
  }
  async assertSeedUnchanged(): Promise<void> { if (await treeHash(this.seedRoot) !== this.seedTreeHash) throw new Error("Seed workspace changed during AgentRun"); }
  consumption(records: readonly ToolCallRecord[], durationMs: number, usage: RuntimeUsage): BudgetConsumption {
    const delta = this.lastDelta;
    return { turns: usage.turns, toolCalls: records.length, writes: this.writes, verifierCalls: this.verifierCalls,
      changedFiles: delta?.operations.length ?? 0, addedLines: delta?.operations.reduce((sum, item) => sum + item.addedLines, 0) ?? 0,
      removedLines: delta?.operations.reduce((sum, item) => sum + item.removedLines, 0) ?? 0, changedSourceBytes: delta?.operations.reduce((sum, item) => sum + item.bytes, 0) ?? 0,
      toolResultBytes: records.reduce((sum, item) => sum + item.bytes, 0), durationMs,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd };
  }
  private resolveSourcePath(path: string): string {
    if (!isSafeRelative(path) || !ALLOWED_EXTENSIONS.some((extension) => path.endsWith(extension)) || BLOCKED_PREFIXES.some((prefix) => path.split("/").includes(prefix))) throw new CapabilityError("PATH_FORBIDDEN", "Path is outside allowed source capability");
    if (!this.sourceRoots.some((root) => path === root || path.startsWith(`${root}/`))) throw new CapabilityError("PATH_FORBIDDEN", "Path is not within a declared source root");
    const target = resolve(this.candidateRoot, path);
    if (!target.startsWith(`${this.candidateRoot}${sep}`)) throw new CapabilityError("PATH_FORBIDDEN", "Path escapes candidate workspace");
    return target;
  }
  private async assertSafeExistingTarget(target: string): Promise<void> { const metadata = await lstat(target); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new CapabilityError("PATH_NOT_REGULAR_FILE", "Workspace target must be a regular non-symlink file"); const [resolvedTarget, resolvedRoot] = await Promise.all([realpath(target), realpath(this.candidateRoot)]); if (!resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) throw new CapabilityError("PATH_FORBIDDEN", "Workspace target escapes through a symlink"); }
  private async assertSafeParent(target: string): Promise<void> { const parent = dirname(target); let metadata; try { metadata = await lstat(parent); } catch (error) { if (isNodeError(error) && error.code === "ENOENT") throw new CapabilityError("PATH_NOT_REGULAR_DIRECTORY", "Workspace target parent must already exist"); throw error; } if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new CapabilityError("PATH_NOT_REGULAR_DIRECTORY", "Workspace target parent must be a regular non-symlink directory"); const [resolvedParent, resolvedRoot] = await Promise.all([realpath(parent), realpath(this.candidateRoot)]); if (resolvedParent !== resolvedRoot && !resolvedParent.startsWith(`${resolvedRoot}${sep}`)) throw new CapabilityError("PATH_FORBIDDEN", "Workspace target parent escapes through a symlink"); }
}

export class BoundedToolHost implements AgentToolHost {
  private readonly callRecords: ToolCallRecord[] = [];
  private readonly buildPlans: BuildPlan[] = [];
  private totalResultBytes = 0;
  constructor(private readonly workspace: CandidateWorkspace, private readonly budgets: BudgetPolicy) {}
  definitions(): AgentToolDefinition[] { return TOOL_DEFINITIONS; }
  records(): readonly ToolCallRecord[] { return this.callRecords; }
  plans(): BuildPlan[] { return [...this.buildPlans]; }
  validateBatch(calls: readonly ModelToolCall[], seenIds: ReadonlySet<string>): ToolBatchDecision {
    const idCounts = new Map<string, number>();
    for (const call of calls) idCounts.set(call.id, (idCounts.get(call.id) ?? 0) + 1);
    const errors = calls.map((call): { code: string; message: string } | undefined => {
      if (call.id.trim().length === 0) return { code: "TOOL_CALL_ID_EMPTY", message: "Tool-call IDs must be non-empty." };
      if (seenIds.has(call.id) || (idCounts.get(call.id) ?? 0) > 1) return { code: "TOOL_CALL_ID_DUPLICATE", message: `Tool-call ID was already used in this AgentRun: ${call.id}` };
      const definition = TOOL_DEFINITIONS.find((item) => item.name === call.name);
      if (!definition) return { code: "TOOL_UNKNOWN", message: `Unknown Forge tool: ${call.name}` };
      const parsed = z.object(definition.inputShape).strict().safeParse(call.arguments);
      if (!parsed.success) return { code: "TOOL_ARGUMENTS_INVALID", message: `Arguments did not match the exact schema for ${call.name}.` };
      return undefined;
    });
    const callBudgetExceeded = this.callRecords.length + calls.length > this.budgets.maxToolCalls;
    if (!callBudgetExceeded && errors.every((error) => error === undefined)) return { valid: true, feedback: [], budgetExhausted: false };
    const feedback = calls.map((call, index) => {
      const error = callBudgetExceeded
        ? { code: "TOOL_BUDGET_EXHAUSTED", message: "This batch would exceed the tool-call budget." }
        : errors[index] ?? { code: "TOOL_BATCH_REJECTED", message: "No tool was executed because another request in the batch was invalid." };
      return { id: call.id, name: call.name, result: this.record(call.name, call.arguments, fail(error.code, error.message)) };
    });
    const outputBudgetExceeded = feedback.some((item) => item.result.error?.code === "TOOL_OUTPUT_BUDGET_EXHAUSTED");
    return { valid: false, feedback, budgetExhausted: callBudgetExceeded || outputBudgetExceeded };
  }
  async execute(name: string, input: unknown): Promise<ToolResult> {
    const definition = TOOL_DEFINITIONS.find((item) => item.name === name);
    if (!definition) return this.record(name, input, fail("TOOL_UNKNOWN", `Unknown Forge tool: ${name}`));
    if (this.callRecords.length >= this.budgets.maxToolCalls) return this.record(name, input, fail("TOOL_BUDGET_EXHAUSTED", "Tool-call budget exhausted"));
    try {
      const parsed = z.object(definition.inputShape).strict().parse(input);
      let value: unknown;
      switch (name) {
        case "project.list": value = (await this.workspace.list()).slice(0, 100); break;
        case "project.search": value = await this.search(parsed as { query: string; maxResults?: number }); break;
        case "project.read": value = await this.read(parsed as { path: string; startLine?: number; maxLines?: number }); break;
        case "project.inspect": value = await this.inspect(); break;
        case "plan.update": value = this.updatePlan(parsed as Parameters<BoundedToolHost["updatePlan"]>[0]); break;
        case "workspace.write": {
          if (this.buildPlans.length === 0) throw new CapabilityError("PLAN_REQUIRED", "workspace.write requires a BuildPlan first");
          const write = parsed as { path: string; precondition: WorkspaceWritePrecondition; content: string };
          await this.workspace.write(write.path, write.precondition, write.content);
          value = { path: write.path, written: true, created: write.precondition.kind === "absent" };
          break;
        }
        case "workspace.diff": value = await this.diff(); break;
        case "forge.verify": value = await this.verify(); break;
        default: value = null;
      }
      return this.record(name, input, bounded(value));
    } catch (error) {
      return this.record(name, input, fail(error instanceof CapabilityError ? error.code : "TOOL_INPUT_OR_EXECUTION", error instanceof Error ? error.message : String(error)));
    }
  }
  private record(name: string, input: unknown, result: ToolResult): ToolResult {
    if (this.totalResultBytes + result.bytes > this.budgets.maxToolResultBytes) result = fail("TOOL_OUTPUT_BUDGET_EXHAUSTED", "Aggregate tool-result budget exhausted");
    this.totalResultBytes += result.bytes;
    this.callRecords.push({ sequence: this.callRecords.length + 1, name, inputHash: contentHash(stableJson(input)), resultHash: result.resultHash, truncated: result.truncated, bytes: result.bytes, at: new Date().toISOString(), input, result });
    return result;
  }
  private async search(input: { query: string; maxResults?: number }): Promise<unknown> { assertNonEmpty(input.query, "search query"); const results: Array<{ path: string; line: number; text: string }> = []; for (const file of await this.workspace.list()) { const source = await this.workspace.read(file.path); for (const [index, line] of source.split("\n").entries()) if (line.includes(input.query)) results.push({ path: file.path, line: index + 1, text: line.slice(0, 300) }); } return results.slice(0, Math.min(input.maxResults ?? 40, 40)); }
  private async read(input: { path: string; startLine?: number; maxLines?: number }): Promise<unknown> { const source = await this.workspace.read(input.path); const start = Math.max(1, input.startLine ?? 1); const max = Math.min(200, input.maxLines ?? 200); const sourceLines = source.split("\n"); return { path: input.path, startLine: start, lines: sourceLines.slice(start - 1, start - 1 + max), sourceHash: contentHash(source), truncated: start - 1 + max < sourceLines.length }; }
  private async inspect(): Promise<unknown> {
    const map = await this.workspace.semanticMap();
    return {
      projectId: map.projectId,
      files: map.files.map((file) => ({ path: file.path, executionContext: file.executionContext, sourceHash: contentHash(file.source) })),
      instances: map.instances.map((instance) => ({ id: instance.id, path: instance.path, className: instance.className, ...(instance.position ? { position: { ...instance.position } } : {}) })).sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id)),
      remotes: map.remotes.map(({ path, className, direction, clientScript, serverScript }) => ({ path, className, direction, clientScript, serverScript })),
      snapshotHash: createProjectSnapshot(map).projectSemanticHash
    };
  }
  private updatePlan(input: { goal: string; steps: Array<{ id: string; statement: string; status: "pending" | "in_progress" | "completed" }>; currentStepId?: string; assumptions?: string[]; expectedTouchedAreas?: string[]; verificationIntentions?: string[]; status: "draft" | "active" | "complete" }): BuildPlan {
    const revision = this.buildPlans.length + 1;
    const plan: BuildPlan = {
      kind: "BuildPlan", schemaVersion: 1, id: `build_plan_${contentHash(stableJson({ goal: input.goal, revision, steps: input.steps })).slice(0, 24)}`,
      revision, goal: input.goal, steps: [...input.steps], ...(input.currentStepId ? { currentStepId: input.currentStepId } : {}),
      assumptions: [...(input.assumptions ?? [])], expectedTouchedAreas: [...(input.expectedTouchedAreas ?? [])], verificationIntentions: [...(input.verificationIntentions ?? [])],
      status: input.status, source: "agent_plan", authority: "hypothesis"
    };
    assertBuildPlan(plan); this.buildPlans.push(plan); return plan;
  }
  private async diff(): Promise<unknown> { const delta = await this.workspace.freezeDelta(); return { id: delta.id, operations: delta.operations.map(({ path, beforeHash, afterHash, addedLines, removedLines }) => ({ path, beforeHash, afterHash, addedLines, removedLines })) }; }
  private async verify(): Promise<unknown> { const run = await this.workspace.verify(); return { gate: run.report.gate.status === "eligible" ? "locally_eligible" : run.report.gate.status, issues: run.report.issues.slice(0, 50).map(sanitizeIssue), reportHash: contentHash(stableJson(run.report)) }; }
}

const TOOL_DEFINITIONS: AgentToolDefinition[] = [
  definition("project.list", "List bounded source files only.", {}),
  definition("project.search", "Search bounded source files for a literal string.", { query: z.string().min(1), maxResults: z.number().int().positive().max(40).optional() }),
  definition("project.read", "Read a bounded range from one source file.", { path: z.string().min(1), startLine: z.number().int().positive().optional(), maxLines: z.number().int().positive().max(200).optional() }),
  definition("project.inspect", "Inspect sanitized project facts without exposing fixture expectations or hidden evaluator data.", {}),
  definition("plan.update", "Create or revise the agent-owned high-level BuildPlan. Call before the first write.", { goal: z.string().min(1), steps: z.array(z.object({ id: z.string().min(1), statement: z.string().min(1), status: z.enum(["pending", "in_progress", "completed"]) })).min(1), currentStepId: z.string().min(1).optional(), assumptions: z.array(z.string()).optional(), expectedTouchedAreas: z.array(z.string()).optional(), verificationIntentions: z.array(z.string()).optional(), status: z.enum(["draft", "active", "complete"]) }),
  definition("workspace.write", "Create one new source file with an absent-file guard, or replace one existing source file with its current SHA-256 guard. A BuildPlan is required first.", { path: z.string().min(1), precondition: z.discriminatedUnion("kind", [z.object({ kind: z.literal("sha256"), hash: z.string().regex(/^[0-9a-f]{64}$/) }), z.object({ kind: z.literal("absent") })]), content: z.string() }),
  definition("workspace.diff", "Return a bounded summary of changed source files.", {}),
  definition("forge.verify", "Run the local static and semantic verifier and return sanitized diagnostics. This is optional; an independent final gate always runs.", {})
];

function definition(name: string, description: string, inputShape: ZodRawShape): AgentToolDefinition { return { name, description, inputShape, schema: z.toJSONSchema(z.object(inputShape)) }; }

function createAgentBuildTrace(run: AgentRun, configuration: HarnessConfiguration, verification: VerificationRun): BuildTrace {
  const recorder = new FlightRecorder({
    projectId: `project_${contentHash(run.seedHash).slice(0, 24)}`,
    references: { agentRunId: run.id, requirementSetId: run.requirementSetId, requirementViewId: run.requirementViewId, ...(run.workspaceDelta ? { workspaceDeltaId: run.workspaceDelta.id } : {}), harnessConfigurationId: configuration.id, harnessConfigurationHash: configuration.hash },
    components: { toolchain: [], verifiers: [], agent: { name: run.runtime.name, version: run.runtime.version, configHash: configuration.hash }, model: { provider: run.model.transport, name: run.model.name, version: run.model.clientVersion, configurationHash: configuration.hash } }
  });
  recorder.recordSpan("forge.agent.execute", run.classification === "none" ? "ok" : "error", { "forge.agent.run_id": run.id, "forge.harness.configuration_hash": configuration.hash, "forge.tool.call_count": run.toolCalls.length });
  recorder.recordSpan("forge.model.generate", run.classification === "provider_failure" ? "error" : "ok", { "forge.model.turns": run.budgets.consumed.turns, "forge.model.cost_usd": run.budgets.consumed.costUsd ?? 0 });
  for (const call of run.toolCalls) recorder.recordSpan("forge.tool.call", call.result.ok ? "ok" : "error", { "forge.tool.name": call.name, "forge.tool.result_hash": call.resultHash, "forge.tool.truncated": call.truncated });
  const counts = { info: 0, warning: 0, error: 0, critical: 0 };
  for (const issue of verification.report.issues) counts[issue.severity] += 1;
  const outcome: BuildOutcome = { status: run.status, localGate: verification.report.gate.status, runtimeGate: "not_run", assertions: { total: 0, passed: 0 }, modelUsage: { calls: run.budgets.consumed.turns, inputTokens: run.budgets.consumed.inputTokens, outputTokens: run.budgets.consumed.outputTokens, costUsd: run.budgets.consumed.costUsd }, latencyMs: { total: run.budgets.consumed.durationMs }, issueCounts: counts };
  return recorder.complete(outcome, { verificationReportHash: contentHash(stableJson(verification.report)), issues: verification.report.issues.map((issue) => ({ id: issue.id, ruleId: issue.ruleId, severity: issue.severity, category: issue.category, evidenceHash: contentHash(stableJson(issue.evidence)) })) }, { level: "semantic_reproduction", reasons: ["The trace proves local eligibility only; Studio runtime evaluation was not run."], randomSeeds: {} });
}

async function persistAgentRun(run: AgentRun, directory: string): Promise<AgentRunPersistence> { const path = join(resolve(directory), `${run.id}.json`); await mkdir(dirname(path), { recursive: true }); const serialized = `${stableJson(run)}\n`; const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`); await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); return { path: relative(process.cwd(), path), artifactHash: contentHash(serialized), mode: 0o600 }; }

async function persistWorkspaceCandidateArtifact(input: { directory: string; workspace: CandidateWorkspace; run: AgentRun; delta: WorkspaceDelta; requirementSetId: string; requirementViewId: string; configuration: HarnessConfiguration; verification: VerificationRun }): Promise<{ artifact: WorkspaceCandidateArtifact; persistence: WorkspaceCandidateArtifactPersistence }> {
  if (input.run.status !== "locally_eligible" || input.verification.report.gate.status !== "eligible") throw new Error("Only a locally eligible candidate can be sealed");
  await input.workspace.assertSeedUnchanged();
  const directory = resolve(input.directory);
  const candidateDirectory = relative(directory, input.workspace.candidateRoot).replaceAll("\\", "/");
  if (!isSafeRelative(candidateDirectory) || candidateDirectory === ".") throw new Error("Candidate artifact cannot locate a workspace outside its run directory");
  const map = await input.workspace.semanticMap();
  const sourceFiles = map.files.map((file) => ({ path: file.path, sourceHash: contentHash(file.source), executionContext: file.executionContext })).sort((left, right) => left.path.localeCompare(right.path));
  const payload: Omit<WorkspaceCandidateArtifact, "id" | "artifactHash"> = {
    kind: "WorkspaceCandidateArtifact", schemaVersion: 1, origin: { kind: "agent_run", agentRunId: input.run.id }, createdAt: new Date().toISOString(),
    seedRoot: input.workspace.seedRoot, seedHash: input.workspace.seedTreeHash, candidateDirectory, candidateHash: input.delta.candidateHash,
    workspaceDelta: input.delta, requirementSetId: input.requirementSetId, requirementViewId: input.requirementViewId,
    harnessConfigurationId: input.configuration.id, harnessConfigurationHash: input.configuration.hash, sourceFiles,
    localGate: { status: "locally_eligible", reportHash: contentHash(stableJson(input.verification.report)), traceId: input.verification.trace.id }
  };
  const artifactHash = contentHash(stableJson(payload));
  const artifact: WorkspaceCandidateArtifact = { ...payload, id: `workspace_candidate_${artifactHash.slice(0, 24)}`, artifactHash };
  assertWorkspaceCandidateArtifact(artifact);
  const path = join(directory, `${artifact.id}.json`); await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${stableJson(artifact)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path);
  return { artifact, persistence: { path: relative(process.cwd(), path), artifactHash, mode: 0o600 } };
}

export async function loadWorkspaceCandidateArtifact(artifactPath: string, traceDirectory?: string): Promise<LoadedWorkspaceCandidateArtifact> {
  const resolvedArtifactPath = resolve(artifactPath);
  const artifact = JSON.parse(await readFile(resolvedArtifactPath, "utf8")) as unknown;
  assertWorkspaceCandidateArtifact(artifact);
  const candidateArtifact = artifact as WorkspaceCandidateArtifact;
  const artifactDirectory = dirname(resolvedArtifactPath);
  const candidateRoot = resolve(artifactDirectory, candidateArtifact.candidateDirectory);
  if (!candidateRoot.startsWith(`${artifactDirectory}${sep}`)) throw new Error("WorkspaceCandidateArtifact candidate directory escapes artifact directory");
  if (await treeHash(resolve(candidateArtifact.seedRoot)) !== candidateArtifact.seedHash) throw new Error("WorkspaceCandidateArtifact seed has changed");
  const manifest = JSON.parse(await readFile(join(candidateRoot, "forge.fixture.json"), "utf8")) as Parameters<FilesystemProjectSourceAdapter["load"]>[0]["manifest"];
  const map = await new FilesystemProjectSourceAdapter().load({ root: candidateRoot, manifest });
  if (map.hashes.sourceHash !== candidateArtifact.candidateHash || candidateArtifact.workspaceDelta.candidateHash !== candidateArtifact.candidateHash) throw new Error("WorkspaceCandidateArtifact candidate source hash mismatch");
  const observedFiles = map.files.map((file) => ({ path: file.path, sourceHash: contentHash(file.source), executionContext: file.executionContext })).sort((left, right) => left.path.localeCompare(right.path));
  if (stableJson(observedFiles) !== stableJson(candidateArtifact.sourceFiles)) throw new Error("WorkspaceCandidateArtifact source manifest mismatch");
  const verification = await verifyProject(candidateRoot, { ...(traceDirectory ? { traceDirectory } : {}), traceReferences: { agentRunId: candidateArtifact.origin.agentRunId, requirementSetId: candidateArtifact.requirementSetId, requirementViewId: candidateArtifact.requirementViewId, workspaceDeltaId: candidateArtifact.workspaceDelta.id, harnessConfigurationId: candidateArtifact.harnessConfigurationId, harnessConfigurationHash: candidateArtifact.harnessConfigurationHash } });
  if (verification.report.gate.status !== "eligible") throw new Error(`WorkspaceCandidateArtifact is no longer locally eligible: ${verification.report.gate.reasons.join(", ")}`);
  return { artifact: candidateArtifact, candidateRoot, verification };
}

function bounded(value: unknown): ToolResult { const serialized = stableJson(value); const limit = 32 * 1024; const truncated = Buffer.byteLength(serialized, "utf8") > limit; const rendered = truncated ? serialized.slice(0, limit) : serialized; return { ok: true, value: truncated ? { truncated: true, preview: rendered } : value, truncated, resultHash: contentHash(serialized), bytes: Buffer.byteLength(rendered, "utf8") }; }
function fail(code: string, message: string): ToolResult { const value = { code, message }; const serialized = stableJson(value); return { ok: false, error: value, truncated: false, resultHash: contentHash(serialized), bytes: Buffer.byteLength(serialized, "utf8") }; }
function sanitizeIssue(issue: VerificationIssue): unknown { return { id: issue.id, ruleId: issue.ruleId, severity: issue.severity, category: issue.category, ...(issue.path ? { path: issue.path } : {}), ...(issue.location ? { line: issue.location.line } : {}) }; }
function runtimeBudgetResult(error: string, usage: RuntimeUsage, turns: AgentModelTurn[], trialStarted: boolean): AgentRuntimeResult { return { status: "budget_exhausted", trialStarted, error, usage, turns }; }
function emptyRuntimeUsage(): RuntimeUsage { return { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }; }
function addUsage(current: RuntimeUsage, next: ModelUsage): RuntimeUsage { return { turns: current.turns + 1, inputTokens: addNullable(current.inputTokens, next.inputTokens), outputTokens: addNullable(current.outputTokens, next.outputTokens), costUsd: addNullable(current.costUsd, next.costUsd) }; }
function addNullable(left: number | null, right: number | null): number | null { return left === null || right === null ? null : left + right; }
function exceedsModelBudgets(policy: BudgetPolicy, usage: RuntimeUsage): boolean { return (usage.inputTokens !== null && usage.inputTokens > policy.maxInputTokens) || (usage.outputTokens !== null && usage.outputTokens > policy.maxOutputTokens) || (usage.costUsd !== null && usage.costUsd > policy.maxBudgetUsd); }
function exhaustedBudgets(policy: BudgetPolicy, used: BudgetConsumption): string[] { const pairs: Array<[keyof BudgetPolicy, number | null]> = [["maxTurns", used.turns], ["maxToolCalls", used.toolCalls], ["maxWrites", used.writes], ["maxVerifierCalls", used.verifierCalls], ["maxChangedFiles", used.changedFiles], ["maxAddedLines", used.addedLines], ["maxRemovedLines", used.removedLines], ["maxChangedSourceBytes", used.changedSourceBytes], ["maxToolResultBytes", used.toolResultBytes], ["maxDurationMs", used.durationMs], ["maxBudgetUsd", used.costUsd], ["maxInputTokens", used.inputTokens], ["maxOutputTokens", used.outputTokens]]; return pairs.filter(([key, value]) => value !== null && value > policy[key]).map(([key]) => String(key)); }
async function sourceFiles(root: string, roots: string[]): Promise<Array<{ path: string; bytes: number }>> { const entries: Array<{ path: string; bytes: number }> = []; for (const sourceRoot of roots) await visit(join(root, sourceRoot), sourceRoot, entries); return entries; }
async function sourceFileSnapshots(root: string, roots: string[]): Promise<Map<string, { hash: string; source: string }>> { const snapshots = new Map<string, { hash: string; source: string }>(); for (const file of await sourceFiles(root, roots)) { const source = await readFile(join(root, file.path), "utf8"); snapshots.set(file.path, { hash: contentHash(source), source }); } return snapshots; }
async function visit(absolute: string, relativePath: string, results: Array<{ path: string; bytes: number }>): Promise<void> { for (const entry of await readdir(absolute, { withFileTypes: true })) { const path = join(absolute, entry.name); const rel = `${relativePath}/${entry.name}`; const metadata = await lstat(path); if (metadata.isSymbolicLink()) throw new CapabilityError("PATH_FORBIDDEN", `Source root contains a symlink: ${rel}`); if (metadata.isDirectory()) await visit(path, rel, results); else if (metadata.isFile() && ALLOWED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) results.push({ path: rel, bytes: (await stat(path)).size }); } }
async function treeHash(root: string): Promise<string> { const files: Array<{ path: string; hash: string }> = []; async function walk(directory: string): Promise<void> { for (const entry of await readdir(directory, { withFileTypes: true })) { const target = join(directory, entry.name); const rel = relative(root, target).replaceAll("\\", "/"); const metadata = await lstat(target); if (metadata.isSymbolicLink()) throw new Error(`Tree contains a symbolic link: ${rel}`); if (metadata.isDirectory()) await walk(target); else if (metadata.isFile()) files.push({ path: rel, hash: contentHash((await readFile(target)).toString("base64")) }); } } await walk(root); return contentHash(stableJson(files.sort((left, right) => left.path.localeCompare(right.path)))); }
function lineCount(value: string): number { return value.length === 0 ? 0 : value.split("\n").length; }
function isSafeRelative(path: string): boolean { return path.length > 0 && !path.includes("\0") && !path.startsWith("/") && !path.startsWith("\\") && !path.split(/[\\/]+/).includes(".."); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isIdentifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !/\s/.test(value); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function isNodeError(value: unknown): value is NodeJS.ErrnoException { return value instanceof Error && "code" in value; }
function assertNonEmpty(value: string, label: string): void { if (value.trim().length === 0) throw new Error(`${label} must be non-empty`); }
class CapabilityError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const DEFAULT_SYSTEM_PROMPT = "You are a bounded Forge builder. Work only through Forge tools. Inspect the project, publish a high-level plan before writing, preserve explicit integration constraints, and do not claim Studio execution. Complete the creator request or report a concrete limit honestly.";
