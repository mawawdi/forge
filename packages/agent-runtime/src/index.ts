import { randomUUID } from "node:crypto";
import { COMPACTION_SYSTEM_PROMPT, ConversationCompactionToolHost } from "./compaction.js";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z, type ZodRawShape } from "zod";
import {
  contentHash,
  stableJson,
  type BuildOutcome,
  type BuildTrace,
  type TracePersistence,
  type VerificationIssue,
} from "../../contracts/src/index.js";
import {
  compileAgentOrientation,
  type AgentOrientation,
} from "../../context-compiler/src/index.js";
import {
  FlightRecorder,
  JsonFileTraceSink,
  createSystemFlightRecorderClock,
  type FlightRecorderClock,
} from "../../flight-recorder/src/index.js";
import type {
  ModelClient,
  ModelMessage,
  ModelResponseFacts,
  ModelRequestSizes,
  ModelToolCall,
  ModelTurnResult,
  ModelUsage,
} from "../../model-client/src/contracts.js";
import {
  assertRequirementSet,
  resolveRequirementView,
  type RequirementSet,
} from "../../semantic-authority/src/index.js";
import {
  createProjectSnapshot,
  FilesystemProjectSourceAdapter,
} from "../../semantic-map/src/index.js";
import { verifyProject, type VerificationRun } from "../../verifier/src/index.js";
import {
  AgentExecutionJournalStore,
  createBatchValidatedCheckpoint,
  createRequestIntentCheckpoint,
  measureRequestSizes,
  createResponseReceivedCheckpoint,
  createTerminalCheckpoint,
  createToolCompletedCheckpoint,
  createToolExecutionIntentCheckpoint,
  type AgentExecutionBoundaryState,
  type AgentExecutionJournalSink,
  type AgentExecutionJournalResume,
  type LoadedAgentExecutionJournal,
} from "./execution-journal.js";
import {
  assertArtifactReference,
  type ArtifactReference,
  type ImmutableJsonArtifactStore,
} from "../../artifact-store/src/index.js";

export * from "./execution-journal.js";

export type AgentRunStatus = "locally_eligible" | "rejected" | "incomplete";
export type AgentFailureClassification =
  | "none"
  | "agent_failure"
  | "tool_failure"
  | "budget_exhausted"
  | "verification_failure"
  | "workspace_capability_violation"
  | "provider_failure"
  | "harness_failure"
  | "incomplete";

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

export const DEFAULT_AGENT_BUDGETS: BudgetPolicy = Object.freeze({
  // Remote finite guardrails for malformed or runaway execution, not product quotas.
  maxTurns: 10_000,
  maxToolCalls: 100_000,
  maxWrites: 100_000,
  maxVerifierCalls: 10_000,
  maxChangedFiles: 100_000,
  maxAddedLines: 10_000_000,
  maxRemovedLines: 10_000_000,
  maxBytesPerFile: 16 * 1024 * 1024,
  maxChangedSourceBytes: 512 * 1024 * 1024,
  maxToolResultBytes: 512 * 1024 * 1024,
  maxDurationMs: 7 * 24 * 60 * 60_000,
  maxBudgetUsd: 1_000,
  maxInputTokens: 1_000_000_000_000,
  maxOutputTokens: 100_000_000_000,
});

export interface HarnessConfigurationInput {
  systemPrompt: string;
  tools: readonly { name: string; description: string; schema: unknown }[];
  capabilityPolicy: {
    sourceRoots: string[];
    blockedPathPrefixes: string[];
    allowedExtensions: string[];
    executionWorker?: CreatorAgentExecutionWorker;
  };
  orientation: Pick<AgentOrientation, "policy" | "contentHash">;
  requirementViewHash: string;
  budgets: BudgetPolicy;
  runtime: { name: string };
  model: {
    transport: string;
    name: string;
    transportConfiguration: ModelClient["descriptor"]["configuration"];
  };
}

export interface HarnessConfiguration extends HarnessConfigurationInput {
  kind: "HarnessConfiguration";
  id: string;
  hash: string;
}

export function createHarnessConfiguration(input: HarnessConfigurationInput): HarnessConfiguration {
  assertNonEmpty(input.systemPrompt, "HarnessConfiguration system prompt");
  const canonical = canonicalHarnessInput(input);
  const hash = contentHash(stableJson(canonical));
  const configuration: HarnessConfiguration = {
    kind: "HarnessConfiguration",
    id: `harness_configuration_${hash.slice(0, 24)}`,
    hash,
    ...canonical,
  };
  assertHarnessConfiguration(configuration);
  return configuration;
}

export function assertHarnessConfiguration(value: unknown): asserts value is HarnessConfiguration {
  if (
    !isRecord(value) ||
    value.kind !== "HarnessConfiguration" ||
    !isIdentifier(value.id) ||
    !isHash(value.hash) ||
    typeof value.systemPrompt !== "string" ||
    !Array.isArray(value.tools) ||
    !isRecord(value.capabilityPolicy) ||
    !isRecord(value.orientation) ||
    value.orientation.policy !== "mode_scoped_project_capabilities" ||
    !isHash(value.orientation.contentHash) ||
    !isHash(value.requirementViewHash) ||
    !isRecord(value.budgets) ||
    !isRecord(value.runtime) ||
    !isRecord(value.model) ||
    !isRecord(value.model.transportConfiguration)
  )
    throw new Error("Invalid HarnessConfiguration");
  if (
    value.capabilityPolicy.executionWorker !== undefined &&
    !isCurrentCreatorWorker(value.capabilityPolicy.executionWorker)
  )
    throw new Error("Invalid HarnessConfiguration creator worker");
  const canonical = canonicalHarnessInput(value as unknown as HarnessConfigurationInput);
  const expectedHash = contentHash(stableJson(canonical));
  if (
    value.hash !== expectedHash ||
    value.id !== `harness_configuration_${expectedHash.slice(0, 24)}`
  )
    throw new Error("Invalid HarnessConfiguration identity");
}

function canonicalHarnessInput(input: HarnessConfigurationInput): HarnessConfigurationInput {
  return {
    systemPrompt: input.systemPrompt,
    tools: [...input.tools].map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
    })),
    capabilityPolicy: {
      sourceRoots: [...input.capabilityPolicy.sourceRoots].sort(),
      blockedPathPrefixes: [...input.capabilityPolicy.blockedPathPrefixes].sort(),
      allowedExtensions: [...input.capabilityPolicy.allowedExtensions].sort(),
      ...(input.capabilityPolicy.executionWorker
        ? { executionWorker: { ...input.capabilityPolicy.executionWorker } }
        : {}),
    },
    orientation: {
      policy: input.orientation.policy,
      contentHash: input.orientation.contentHash,
    },
    requirementViewHash: input.requirementViewHash,
    budgets: { ...input.budgets },
    runtime: { ...input.runtime },
    model: { ...input.model },
  };
}

export interface BuildPlan {
  kind: "BuildPlan";
  id: string;
  revision: number;
  goal: string;
  steps: Array<{
    id: string;
    statement: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  currentStepId?: string;
  assumptions: string[];
  expectedTouchedAreas: string[];
  verificationIntentions: string[];
  status: "draft" | "active" | "complete";
  source: "agent_plan";
  authority: "hypothesis";
}

export interface WorkspaceDeltaOperation {
  path: string;
  beforeHash: string | null;
  afterHash: string;
  addedLines: number;
  removedLines: number;
  bytes: number;
}
export interface WorkspaceDelta {
  kind: "WorkspaceDelta";
  id: string;
  seedHash: string;
  candidateHash: string;
  operations: WorkspaceDeltaOperation[];
}
export type WorkspaceWritePrecondition = { kind: "sha256"; hash: string } | { kind: "absent" };

export interface WorkspaceCandidateArtifact {
  kind: "WorkspaceCandidateArtifact";
  id: string;
  artifactHash: string;
  origin:
    | {
        kind: "creator_session";
        agentRunId: string;
        creatorSessionId: string;
        creatorSessionHash: string;
      }
    | {
        kind: "registered_experiment";
        agentRunId: string;
        experimentRegistrationId: string;
        experimentRegistrationHash: string;
      };
  createdAt: string;
  seedRoot: string;
  seedHash: string;
  candidateDirectory: string;
  candidateHash: string;
  workspaceDelta: WorkspaceDelta;
  requirementSetId: string;
  requirementViewId: string;
  harnessConfigurationId: string;
  harnessConfigurationHash: string;
  sourceFiles: Array<{
    path: string;
    sourceHash: string;
    executionContext: "server" | "client" | "shared" | "unknown";
  }>;
  localGate: {
    status: "locally_eligible";
    reportHash: string;
    traceId: string;
  };
}

export interface WorkspaceCandidateArtifactPersistence {
  path: string;
  artifactHash: string;
  mode: number;
}
export interface LoadedWorkspaceCandidateArtifact {
  artifact: WorkspaceCandidateArtifact;
  candidateRoot: string;
  verification: VerificationRun;
}
export interface ToolResult {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
  truncated: boolean;
  resultHash: string;
  bytes: number;
}
export interface ToolCallRecord {
  sequence: number;
  toolCallId: string;
  disposition: "executed" | "rejected";
  name: string;
  inputHash: string;
  resultHash: string;
  truncated: boolean;
  bytes: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  input: unknown;
  result: ToolResult;
}
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputShape: ZodRawShape;
  schema: unknown;
}
export interface ToolBatchDecision {
  valid: boolean;
  feedback: Array<{ id: string; name: string; result: ToolResult }>;
  budgetExhausted: boolean;
}
export type AgentToolCompletionStatus =
  { ready: true } | { ready: false; code: string; message: string };
export interface AgentToolHost {
  definitions(): AgentToolDefinition[];
  validateBatch(calls: readonly ModelToolCall[], seenIds: ReadonlySet<string>): ToolBatchDecision;
  execute(name: string, input: unknown): Promise<ToolResult>;
  completionStatus?(): AgentToolCompletionStatus;
  /** Content identity of accepted semantic progress, when the host can expose it. */
  progressToken?(): string;
}

export interface AgentModelTurn {
  sequence: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  requestHash: string;
  resultKind: ModelTurnResult["kind"];
  responseHash?: string;
  providerMetadataHash?: string;
  stopReason?: Extract<ModelTurnResult, { kind: "assistant" }>["stopReason"];
  responseFacts?: ModelResponseFacts;
  toolCallIds: string[];
  usage: ModelUsage;
  requestSizes: ModelRequestSizes;
  errorClass?: string;
}
export interface RuntimeUsage extends ModelUsage {
  turns: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}
export interface RuntimeTiming {
  startedAt: string;
  endedAt: string;
  durationMs: number;
}
export interface AgentRuntimeInput {
  systemPrompt: string;
  prompt: string;
  orientation?: AgentOrientation;
  tools: AgentToolHost;
  budgets: BudgetPolicy;
  model: string;
  executionJournal?: AgentExecutionJournalSink;
  /** Explicit creator-authorized consumption of a durable response boundary. */
  resumeFromJournal?: AgentExecutionJournalResume;
}
export interface AgentRuntimeResult {
  status: "completed" | "failed" | "budget_exhausted";
  trialStarted: boolean;
  summary?: string;
  error?: string;
  failureCode?: string;
  failureKind?: "provider" | "model" | "tool" | "harness";
  usage: RuntimeUsage;
  timing: RuntimeTiming;
  turns: AgentModelTurn[];
  toolCalls: ToolCallRecord[];
}
export interface AgentRuntime {
  readonly identity: { name: string };
  readonly modelClientDescriptor: ModelClient["descriptor"];
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>;
}

export const FORGE_NATIVE_RUNTIME_IDENTITY = {
  name: "forge-native-agent-runtime",
} as const;

export class ForgeNativeAgentRuntime implements AgentRuntime {
  readonly identity = FORGE_NATIVE_RUNTIME_IDENTITY;
  readonly modelClientDescriptor: ModelClient["descriptor"];
  private readonly clock: FlightRecorderClock;
  constructor(
    private readonly modelClient: ModelClient,
    options: { clock?: FlightRecorderClock } = {},
  ) {
    this.modelClientDescriptor = { ...modelClient.descriptor };
    this.clock = options.clock ?? createSystemFlightRecorderClock();
  }

  async compact(input: {
    prompt: string;
    model: string;
    executionJournal: AgentExecutionJournalSink;
  }) {
    const tools = new ConversationCompactionToolHost();
    const result = await this.run({
      ...input,
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      tools,
      budgets: {
        ...DEFAULT_AGENT_BUDGETS,
        maxDurationMs: 20 * 60_000,
        maxTurns: 3,
        maxToolCalls: 3,
        maxOutputTokens: 32_000,
      },
    });
    return {
      result,
      ...(result.status === "completed" && tools.summary ? { summary: tools.summary } : {}),
    };
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const resumed = input.resumeFromJournal;
    if (resumed !== undefined && input.executionJournal === undefined)
      throw new Error("A resumed runtime requires its durable execution-journal sink");
    if (
      resumed !== undefined &&
      input.executionJournal?.journalId !== undefined &&
      input.executionJournal.journalId !== resumed.journalId
    )
      throw new Error("Runtime resume journal does not match its checkpoint sink");
    const initialMessage = input.orientation
      ? `${input.prompt}\n\n<forge_project_orientation>\n${stableJson(input.orientation)}\n</forge_project_orientation>`
      : input.prompt;
    const messages: ModelMessage[] =
      resumed === undefined
        ? [{ role: "user", content: initialMessage }]
        : resumeMessages(resumed.request.messages);
    if (resumed !== undefined) assertRuntimeResumeInput(input, resumed, initialMessage);
    const turns: AgentModelTurn[] =
      resumed === undefined ? [] : resumed.modelTurns.map((turn) => ({ ...turn }));
    const seenToolCallIds = new Set<string>(resumed?.state.seenToolCallIds ?? []);
    const toolCalls: ToolCallRecord[] =
      resumed === undefined ? [] : resumed.toolCalls.map(copyToolCallRecord);
    const rejectedBatchCounts = new Map<string, number>(
      (resumed?.state.rejectedBatchRepeats ?? []).map((counter) => [
        counter.fingerprint,
        counter.count,
      ]),
    );
    const noProgressBatchCounts = new Map<string, number>(
      (resumed?.state.noProgressBatchRepeats ?? []).map((counter) => [
        counter.fingerprint,
        counter.count,
      ]),
    );
    let prematureCompletionRepairs = resumed?.state.prematureCompletionRepairs ?? 0;
    const timeline = createRuntimeTimeline(this.clock);
    const invocationStarted = startTiming(timeline);
    const runtimeStarted =
      resumed === undefined
        ? invocationStarted
        : startTimingAt(timeline, resumed.state.runtimeStartedAt);
    const invocationDurationBudgetMs =
      resumed?.state.remaining.durationMs ?? input.budgets.maxDurationMs;
    const opaqueContinuationHashes = new Set<string>(resumed?.opaqueContinuationHashes ?? []);
    const finish = async (
      outcome: Omit<AgentRuntimeResult, "timing" | "toolCalls">,
    ): Promise<AgentRuntimeResult> => {
      const completed = {
        ...outcome,
        timing: finishTiming(timeline, runtimeStarted),
        toolCalls: toolCalls.map(copyToolCallRecord),
      };
      await input.executionJournal?.checkpoint(
        createTerminalCheckpoint(runtimeNowIso(timeline), completed, [...opaqueContinuationHashes]),
      );
      return completed;
    };
    let trialStarted = resumed?.state.trialStarted ?? false;
    let usage: RuntimeUsage =
      resumed === undefined ? emptyRuntimeUsage() : { ...resumed.state.usage };
    const executionBoundaryState = (
      turnSequence: number,
      toolHostProgressToken: string | undefined,
    ): AgentExecutionBoundaryState => {
      const materializedToolResultBytes = toolCalls.reduce(
        (sum, toolCall) => sum + toolCall.bytes,
        0,
      );
      return {
        runtimeStartedAt: timingStartIso(timeline, runtimeStarted),
        usage: { ...usage },
        trialStarted,
        remaining: {
          turns: Math.max(0, input.budgets.maxTurns - turnSequence + 1),
          toolCalls: Math.max(0, input.budgets.maxToolCalls - toolCalls.length),
          toolResultBytes: Math.max(
            0,
            input.budgets.maxToolResultBytes - materializedToolResultBytes,
          ),
          durationMs: Math.max(
            0,
            invocationDurationBudgetMs - elapsedSince(timeline, invocationStarted),
          ),
          inputTokens:
            usage.inputTokens === null
              ? null
              : Math.max(0, input.budgets.maxInputTokens - usage.inputTokens),
          outputTokens:
            usage.outputTokens === null
              ? null
              : Math.max(0, input.budgets.maxOutputTokens - usage.outputTokens),
          budgetUsd:
            usage.costUsd === null ? null : Math.max(0, input.budgets.maxBudgetUsd - usage.costUsd),
        },
        seenToolCallIds: [...seenToolCallIds].sort(),
        rejectedBatchRepeats: repeatCounterSnapshot(rejectedBatchCounts),
        noProgressBatchRepeats: repeatCounterSnapshot(noProgressBatchCounts),
        prematureCompletionRepairs,
        toolHostProgressTokenHash:
          toolHostProgressToken === undefined ? null : contentHash(toolHostProgressToken),
        materializedToolCalls: toolCalls.length,
        materializedToolResultBytes,
      };
    };
    const tools = input.tools.definitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
    }));
    if (resumed !== undefined && stableJson(tools) !== stableJson(resumed.request.tools))
      throw new Error("Runtime resume no longer matches its declared tool authority");
    let pendingResponse = resumed;
    for (
      let sequence = resumed?.turnSequence ?? 1;
      sequence <= input.budgets.maxTurns;
      sequence += 1
    ) {
      const remainingMs = invocationDurationBudgetMs - elapsedSince(timeline, invocationStarted);
      if (remainingMs <= 0)
        return finish(runtimeBudgetResult("Duration budget exhausted", usage, turns, trialStarted));
      const remainingOutput = input.budgets.maxOutputTokens - (usage.outputTokens ?? 0);
      if (remainingOutput <= 0 && pendingResponse === undefined)
        return finish(
          runtimeBudgetResult("Output-token budget exhausted", usage, turns, trialStarted),
        );
      const consumingPersistedResponse = pendingResponse !== undefined;
      const persistedResponseHasOpaqueContinuation =
        pendingResponse?.response.kind === "assistant" &&
        pendingResponse.response.message.continuation.present;
      const opaqueContinuationResumeFailure = () =>
        finish({
          status: "failed",
          trialStarted,
          failureKind: "provider",
          failureCode: "OPAQUE_CONTINUATION_NEW_RUN_REQUIRED",
          error:
            "The durable provider response carried an opaque continuation that Forge did not persist. The stored response and tool records were consumed, but any further provider turn requires an explicit creator-authorized retry_work/new AgentRun.",
          usage,
          turns,
        });
      let result: ModelTurnResult;
      let requestIntent: { readonly intentHash: string };
      if (pendingResponse !== undefined) {
        result = resumeResult(pendingResponse.response);
        requestIntent = { intentHash: pendingResponse.intentHash };
        pendingResponse = undefined;
      } else {
        const modelTurnStarted = startTiming(timeline);
        const request = {
          model: input.model,
          system: input.systemPrompt,
          messages,
          tools,
          maxOutputTokens: Math.min(
            this.modelClientDescriptor.configuration.request.maxOutputTokensPerTurn,
            remainingOutput,
          ),
          timeoutMs: Math.min(
            remainingMs,
            this.modelClientDescriptor.configuration.request.maxDurationMsPerTurn,
          ),
        };
        const checkpoint = createRequestIntentCheckpoint(
          sequence,
          runtimeNowIso(timeline),
          request,
          executionBoundaryState(sequence, input.tools.progressToken?.()),
        );
        requestIntent = checkpoint;
        await input.executionJournal?.checkpoint(checkpoint);
        try {
          result = await this.modelClient.complete(request);
        } catch (error) {
          const timing = finishTiming(timeline, modelTurnStarted);
          turns.push({
            sequence,
            ...timing,
            requestHash: contentHash(
              stableJson({
                model: input.model,
                systemPromptHash: contentHash(input.systemPrompt),
                messageCount: messages.length,
              }),
            ),
            resultKind: "provider_error",
            requestSizes: measureRequestSizes(request),
            toolCallIds: [],
            usage: {
              reasoningTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              inputTokens: null,
              outputTokens: null,
              costUsd: null,
            },
            errorClass: "provider_exception",
          });
          return finish({
            status: "failed",
            trialStarted,
            failureKind: "provider",
            error: error instanceof Error ? error.message : String(error),
            usage,
            turns,
          });
        }
        if (result.kind === "assistant" && result.message.continuation !== undefined)
          opaqueContinuationHashes.add(result.message.continuation.hash);
        const modelTurnTiming = finishTiming(timeline, modelTurnStarted);
        if (result.kind !== "provider_error" || result.responseFacts.responseId !== null)
          trialStarted = true;
        usage = addUsage(usage, result.usage);
        const turn: AgentModelTurn = {
          sequence,
          ...modelTurnTiming,
          requestHash: result.requestHash,
          requestSizes: measureRequestSizes(request),
          resultKind: result.kind,
          ...(result.kind === "assistant"
            ? {
                responseHash: result.responseHash,
                stopReason: result.stopReason,
                toolCallIds: result.message.toolCalls.map((call) => call.id),
              }
            : { errorClass: result.errorClass, toolCallIds: [] }),
          ...(result.responseFacts ? { responseFacts: { ...result.responseFacts } } : {}),
          ...(result.providerMetadataHash
            ? { providerMetadataHash: result.providerMetadataHash }
            : {}),
          usage: { ...result.usage },
        };
        turns.push(turn);
        await input.executionJournal?.checkpoint(
          createResponseReceivedCheckpoint({
            turnSequence: sequence,
            occurredAt: runtimeNowIso(timeline),
            intentHash: requestIntent.intentHash,
            result,
            state: executionBoundaryState(sequence, input.tools.progressToken?.()),
            turn,
          }),
        );
      }
      const modelBudgetFailure = modelUsageBudgetFailure(input.budgets, usage);
      if (modelBudgetFailure !== undefined)
        return finish(runtimeBudgetResult(modelBudgetFailure, usage, turns, trialStarted));
      if (result.kind === "provider_error")
        return finish({
          status: "failed",
          trialStarted,
          failureKind: "provider",
          error: `${result.errorClass}: ${result.message}`,
          usage,
          turns,
        });
      if (result.kind === "invalid_model_response")
        return finish({
          status: "failed",
          trialStarted,
          failureKind: "model",
          error: `${result.errorClass}: ${result.message}`,
          usage,
          turns,
        });
      if (result.stopReason === "max_tokens" || result.stopReason === "refusal")
        return finish({
          status: "failed",
          trialStarted,
          failureKind: "model",
          failureCode:
            result.stopReason === "max_tokens"
              ? "MODEL_RESPONSE_TRUNCATED"
              : "MODEL_RESPONSE_REFUSED",
          error:
            result.stopReason === "max_tokens"
              ? "The model reached its response length limit. No tools from the incomplete response were executed."
              : "The model refused the request. No tools from this response were executed.",
          usage,
          turns,
        });
      if (result.message.toolCalls.length === 0) {
        if (input.tools.completionStatus) {
          try {
            const completion = input.tools.completionStatus();
            if (!completion.ready) {
              if (prematureCompletionRepairs >= MAX_PREMATURE_COMPLETION_REPAIRS)
                return finish({
                  status: "failed",
                  trialStarted,
                  failureKind: "model",
                  failureCode: completion.code,
                  error: `${completion.message}. The model exhausted ${MAX_PREMATURE_COMPLETION_REPAIRS} mandatory completion-repair attempts.`,
                  usage,
                  turns,
                });
              prematureCompletionRepairs += 1;
              messages.push(result.message);
              messages.push({
                role: "user",
                content: stableJson({
                  forgeCompletionRequired: true,
                  attempt: prematureCompletionRepairs,
                  maximumAttempts: MAX_PREMATURE_COMPLETION_REPAIRS,
                  code: completion.code,
                  message: completion.message,
                  instruction:
                    "The required phase artifact is still unsealed. Continue with the available tools and do not end the turn until the host reports completion.",
                }),
              });
              if (persistedResponseHasOpaqueContinuation) return opaqueContinuationResumeFailure();
              continue;
            }
          } catch (error) {
            return finish({
              status: "failed",
              trialStarted,
              failureKind: "harness",
              failureCode: "TOOL_COMPLETION_CHECK_FAILED",
              error: error instanceof Error ? error.message : String(error),
              usage,
              turns,
            });
          }
        }
        return finish({
          status: "completed",
          trialStarted,
          ...(result.message.content ? { summary: result.message.content } : {}),
          usage,
          turns,
        });
      }
      const recoveredBatch = consumingPersistedResponse ? resumed?.batch : undefined;
      const progressBefore = input.tools.progressToken?.();
      if (consumingPersistedResponse) assertResumeHostBoundary(resumed!, progressBefore);
      let validationTiming: RuntimeTiming;
      let decision: ToolBatchDecision;
      if (recoveredBatch) {
        validationTiming = zeroTiming(runtimeNowIso(timeline));
        decision = recoveredBatch.decision;
      } else {
        const validationStarted = startTiming(timeline);
        const hostDecision = input.tools.validateBatch(result.message.toolCalls, seenToolCallIds);
        validationTiming = finishTiming(timeline, validationStarted);
        decision =
          toolCalls.length + result.message.toolCalls.length > input.budgets.maxToolCalls
            ? rejectedToolBudgetDecision(result.message.toolCalls)
            : hostDecision;
      }
      if (!recoveredBatch)
        for (const call of result.message.toolCalls)
          if (call.id.length > 0) seenToolCallIds.add(call.id);
      if (!decision.valid) {
        const fingerprint = rejectedBatchFingerprint(decision.feedback, progressBefore);
        const repeats = recoveredBatch
          ? (rejectedBatchCounts.get(fingerprint) ?? 0)
          : (rejectedBatchCounts.get(fingerprint) ?? 0) + 1;
        if (!recoveredBatch) {
          rejectedBatchCounts.set(fingerprint, repeats);
          await input.executionJournal?.checkpoint(
            createBatchValidatedCheckpoint({
              turnSequence: sequence,
              occurredAt: runtimeNowIso(timeline),
              intentHash: requestIntent.intentHash,
              responseHash: result.responseHash,
              calls: result.message.toolCalls,
              decision,
              state: executionBoundaryState(sequence, progressBefore),
            }),
          );
        }
        const completed = new Set(consumingPersistedResponse ? resumed!.completedToolCallIds : []);
        for (const call of result.message.toolCalls) {
          if (completed.has(call.id)) continue;
          const [toolCall] = materializeRejectedToolCalls(
            [call],
            decision.feedback,
            validationTiming,
            toolCalls,
            input.budgets,
          );
          if (!toolCall) throw new Error("Rejected tool batch did not materialize its tool record");
          toolCalls.push(toolCall);
          await input.executionJournal?.checkpoint(
            createToolCompletedCheckpoint({
              turnSequence: sequence,
              occurredAt: runtimeNowIso(timeline),
              intentHash: requestIntent.intentHash,
              responseHash: result.responseHash,
              toolCall,
              state: executionBoundaryState(sequence, progressBefore),
            }),
          );
        }
        const invalidEnvelope = decision.feedback.some((item) =>
          ["TOOL_CALL_ID_EMPTY", "TOOL_CALL_ID_DUPLICATE", "TOOL_UNKNOWN"].includes(
            item.result.error?.code ?? "",
          ),
        );
        if (!invalidEnvelope) {
          messages.push(result.message);
          for (const call of result.message.toolCalls) {
            const feedback = decision.feedback.find((item) => item.id === call.id);
            if (!feedback) throw new Error("Rejected batch lost a tool result");
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: stableJson(feedback.result),
            });
          }
        } else {
          messages.push({
            role: "user",
            content: stableJson({
              forgeToolBatchRejected: true,
              rule: "No tool was executed. Correct the invalid call envelope before retrying.",
              attemptedCalls: result.message.toolCalls.map(({ id, name }) => ({
                id: id.slice(0, 128),
                name: name.slice(0, 128),
              })),
              feedback: decision.feedback,
            }),
          });
        }
        const accountedToolCalls = toolCalls.length;
        const accountedToolResultBytes = toolCalls.reduce((sum, record) => sum + record.bytes, 0);
        const rejectedOutputBudgetExceeded = result.message.toolCalls
          .map((call) => toolCalls.find((record) => record.toolCallId === call.id))
          .some((record) => record?.result.error?.code === "TOOL_OUTPUT_BUDGET_EXHAUSTED");
        if (
          decision.budgetExhausted ||
          rejectedOutputBudgetExceeded ||
          accountedToolCalls > input.budgets.maxToolCalls ||
          accountedToolResultBytes > input.budgets.maxToolResultBytes
        )
          return finish(
            runtimeBudgetResult(
              "Tool-call or tool-output budget exhausted while rejecting a model batch",
              usage,
              turns,
              trialStarted,
            ),
          );
        if (repeats >= MAX_IDENTICAL_REJECTED_TOOL_BATCHES) {
          return finish({
            status: "failed",
            trialStarted,
            failureKind: "model",
            failureCode: "REPEATED_REJECTED_TOOL_BATCH",
            error:
              "Model repeated the same unresolved tool validation failure three times without accepted progress.",
            usage,
            turns,
          });
        }
        if (persistedResponseHasOpaqueContinuation) return opaqueContinuationResumeFailure();
        continue;
      }
      if (!recoveredBatch)
        await input.executionJournal?.checkpoint(
          createBatchValidatedCheckpoint({
            turnSequence: sequence,
            occurredAt: runtimeNowIso(timeline),
            intentHash: requestIntent.intentHash,
            responseHash: result.responseHash,
            calls: result.message.toolCalls,
            decision,
            state: executionBoundaryState(sequence, progressBefore),
          }),
        );
      messages.push(result.message);
      const batchResults: ToolResult[] = [];
      const completedRecords = new Map(
        (consumingPersistedResponse
          ? toolCalls.filter((toolCall) =>
              resumed!.completedToolCallIds.includes(toolCall.toolCallId),
            )
          : []
        ).map((toolCall) => [toolCall.toolCallId, toolCall] as const),
      );
      for (const call of result.message.toolCalls) {
        const completedRecord = completedRecords.get(call.id);
        if (completedRecord !== undefined) {
          batchResults.push(structuredClone(completedRecord.result));
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: stableJson(completedRecord.result),
          });
          continue;
        }
        await input.executionJournal?.checkpoint(
          createToolExecutionIntentCheckpoint({
            turnSequence: sequence,
            occurredAt: runtimeNowIso(timeline),
            intentHash: requestIntent.intentHash,
            responseHash: result.responseHash,
            toolCall: call,
            state: executionBoundaryState(sequence, input.tools.progressToken?.()),
          }),
        );
        const toolStarted = startTiming(timeline);
        let toolResult: ToolResult;
        try {
          toolResult = await input.tools.execute(call.name, call.arguments);
        } catch (error) {
          toolResult = fail(
            "TOOL_EXECUTION_THROWN",
            error instanceof Error ? error.message : String(error),
          );
        }
        const toolTiming = finishTiming(timeline, toolStarted);
        toolResult = enforceToolResultBudget(toolResult, toolCalls, input.budgets);
        const toolCall = materializeToolCall(
          call,
          toolResult,
          "executed",
          toolTiming,
          toolCalls.length + 1,
        );
        toolCalls.push(toolCall);
        await input.executionJournal?.checkpoint(
          createToolCompletedCheckpoint({
            turnSequence: sequence,
            occurredAt: runtimeNowIso(timeline),
            intentHash: requestIntent.intentHash,
            responseHash: result.responseHash,
            toolCall,
            state: executionBoundaryState(sequence, input.tools.progressToken?.()),
          }),
        );
        batchResults.push(toolResult);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: stableJson(toolResult),
        });
        if (
          !toolResult.ok &&
          ["TOOL_BUDGET_EXHAUSTED", "TOOL_OUTPUT_BUDGET_EXHAUSTED"].includes(
            toolResult.error?.code ?? "",
          )
        )
          return finish(
            runtimeBudgetResult(
              toolResult.error?.message ?? "Tool budget exhausted",
              usage,
              turns,
              trialStarted,
            ),
          );
      }
      const progressAfter = input.tools.progressToken?.();
      if (input.tools.completionStatus) {
        try {
          if (input.tools.completionStatus().ready)
            return finish({ status: "completed", trialStarted, usage, turns });
        } catch (error) {
          return finish({
            status: "failed",
            trialStarted,
            failureKind: "harness",
            failureCode: "TOOL_COMPLETION_CHECK_FAILED",
            error: error instanceof Error ? error.message : String(error),
            usage,
            turns,
          });
        }
      }
      if (progressBefore !== undefined && progressAfter === progressBefore) {
        const fingerprint = batchResults.some((entry) => !entry.ok)
          ? rejectedBatchFingerprint(
              result.message.toolCalls.map((call, index) => ({
                id: call.id,
                name: call.name,
                result: batchResults[index]!,
              })),
              progressBefore,
            )
          : contentHash(
              stableJson({
                progressToken: progressBefore,
                calls: result.message.toolCalls.map((call, index) => ({
                  name: call.name,
                  arguments: call.arguments,
                  ok: batchResults[index]?.ok,
                  errorCode: batchResults[index]?.error?.code,
                  resultHash: batchResults[index]?.resultHash,
                })),
              }),
            );
        const repeats = (noProgressBatchCounts.get(fingerprint) ?? 0) + 1;
        noProgressBatchCounts.set(fingerprint, repeats);
        if (repeats >= MAX_IDENTICAL_REJECTED_TOOL_BATCHES) {
          return finish({
            status: "failed",
            trialStarted,
            failureKind: "model",
            failureCode: "REPEATED_NO_PROGRESS_TOOL_BATCH",
            error:
              "Model repeated the same unresolved tool result three times without accepted progress.",
            usage,
            turns,
          });
        }
      } else if (progressAfter !== progressBefore) {
        noProgressBatchCounts.clear();
        rejectedBatchCounts.clear();
      }
      if (persistedResponseHasOpaqueContinuation) return opaqueContinuationResumeFailure();
    }
    return finish(runtimeBudgetResult("Turn budget exhausted", usage, turns, trialStarted));
  }
}

export interface BudgetConsumption {
  turns: number;
  toolCalls: number;
  writes: number;
  verifierCalls: number;
  changedFiles: number;
  addedLines: number;
  removedLines: number;
  changedSourceBytes: number;
  toolResultBytes: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}
export interface AgentRunPersistence {
  path: string;
  artifactHash: string;
  mode: number;
}
export interface CreatorAgentExecutionWorker {
  kind: "CreatorAgentWorkerDescriptor";
  name: "forge-local-creator-agent-worker";
  environment: "local_process";
  isolation: "none";
}
export type CreatorPhaseArtifact = {
  kind: "creator_outcome" | "change_set";
  id: string;
  hash: string;
};
export type CreatorPhaseOutcome =
  | { status: "sealed"; artifact: CreatorPhaseArtifact; attemptHash: string }
  | {
      status: "unsealed";
      intendedArtifactKind: CreatorPhaseArtifact["kind"];
      failureStage: "runtime" | "finalization";
      failureCode: string;
      detailHash: string;
      attemptHash: string;
    };
export type CreatorPhaseFinalization =
  | { status: "sealed"; artifact: CreatorPhaseArtifact }
  | {
      status: "unsealed";
      intendedArtifactKind: CreatorPhaseArtifact["kind"];
      failureStage: "runtime" | "finalization";
      failureCode: string;
      detail: string;
      failureKind: "provider" | "model" | "tool" | "harness";
    };
export interface AgentRun {
  kind: "AgentRun";
  id: string;
  createdAt: string;
  status: AgentRunStatus;
  classification: AgentFailureClassification;
  trialStarted: boolean;
  phase: "workspace_build" | "creator_planner" | "creator_builder";
  origin:
    | {
        kind: "creator_session";
        creatorSessionId: string;
        creatorSessionHash: string;
      }
    | {
        kind: "registered_experiment";
        experimentRegistrationId: string;
        experimentRegistrationHash: string;
      };
  creatorPromptHash: string;
  requirementSetId: string;
  requirementViewId: string;
  orientationId: string;
  harnessConfigurationId: string;
  harnessConfigurationHash: string;
  seedHash: string;
  workspaceDelta?: WorkspaceDelta;
  runtime: { name: string };
  timing: RuntimeTiming;
  model: {
    transport: string;
    name: string;
    transportConfiguration: ModelClient["descriptor"]["configuration"];
  };
  modelTurns: AgentModelTurn[];
  plans: BuildPlan[];
  toolCalls: ToolCallRecord[];
  budgets: {
    policy: BudgetPolicy;
    consumed: BudgetConsumption;
    exhausted: string[];
  };
  finalVerification: {
    gate: "eligible" | "rejected" | "incomplete";
    reportHash: string;
    traceId: string;
  };
  buildTraceId?: string;
  studio: "not_run";
  summary?: string;
  error?: string;
  creatorPhaseOutcome?: CreatorPhaseOutcome;
  executionWorker?: CreatorAgentExecutionWorker;
  executionJournal?: AgentExecutionJournalBinding;
  creatorBuildContract?: { id: string; hash: string };
}
export interface AgentExecutionJournalBinding {
  journalId: string;
  sequence: number;
  entryHash: string;
  entry: ArtifactReference;
  terminalResultHash: string;
}

/**
 * Creator-owned reservation for exactly one lower runtime invocation.  The
 * reservation is durable before dispatch; the runtime may only materialize
 * the journal derived from this exact AgentRun identity.
 */
export interface AgentExecutionSlot {
  readonly purpose: "planner" | "builder" | "repair";
  readonly ordinal: number;
  readonly agentRunId: string;
  readonly journalId: string;
}
export interface ExperimentRegistrationBinding {
  id: string;
  hash: string;
  expected: {
    seedHash: string;
    sourceRoots: string[];
    orientationId: string;
    orientationContentHash: string;
    toolDescriptionsHash: string;
    harnessConfigurationId: string;
    harnessConfigurationHash: string;
  };
}
export interface AgentBuildRequest {
  seedRoot: string;
  creatorPrompt: string;
  requirementSet: RequirementSet;
  runtime: AgentRuntime;
  model: string;
  runDirectory: string;
  traceDirectory: string;
  environment?: "production" | "benchmark";
  budgets?: BudgetPolicy;
  systemPrompt?: string;
  experiment?: ExperimentRegistrationBinding;
  creatorSession?: { id: string; hash: string };
  registrationPreflight?: true;
  beforeModelInvocation?: () => Promise<void>;
}
export interface PreparedAgentBuild {
  creatorStatement: string;
  budgets: BudgetPolicy;
  requirementView: ReturnType<typeof resolveRequirementView>;
  workspace: CandidateWorkspace;
  orientation: AgentOrientation;
  toolHost: BoundedToolHost;
  systemPrompt: string;
  modelDescriptor: {
    transport: string;
    name: string;
    transportConfiguration: ModelClient["descriptor"]["configuration"];
  };
  configuration: HarnessConfiguration;
}
export interface AgentBuildResult {
  status: AgentRunStatus;
  classification: AgentFailureClassification;
  run: AgentRun;
  persistence: AgentRunPersistence;
  candidateRoot: string;
  candidateArtifact?: {
    artifact: WorkspaceCandidateArtifact;
    persistence: WorkspaceCandidateArtifactPersistence;
  };
  trace: BuildTrace;
  tracePersistence: TracePersistence;
  finalVerification: VerificationRun;
}
export interface CreatorPhaseAgentRunResult {
  run: AgentRun;
  persistence: AgentRunPersistence;
  trace: BuildTrace;
  tracePersistence: TracePersistence;
  configuration: HarnessConfiguration;
}

export function assertBuildPlan(value: unknown): asserts value is BuildPlan {
  if (
    !isRecord(value) ||
    value.kind !== "BuildPlan" ||
    !isIdentifier(value.id) ||
    !Number.isInteger(value.revision) ||
    typeof value.goal !== "string" ||
    !Array.isArray(value.steps) ||
    value.source !== "agent_plan" ||
    value.authority !== "hypothesis"
  )
    throw new Error("Invalid BuildPlan");
}
export function assertWorkspaceDelta(value: unknown): asserts value is WorkspaceDelta {
  if (
    !isRecord(value) ||
    value.kind !== "WorkspaceDelta" ||
    !isIdentifier(value.id) ||
    !isHash(value.seedHash) ||
    !isHash(value.candidateHash) ||
    !Array.isArray(value.operations)
  )
    throw new Error("Invalid WorkspaceDelta");
}
export function assertAgentRun(value: unknown): asserts value is AgentRun {
  if (
    !isRecord(value) ||
    value.kind !== "AgentRun" ||
    !isIdentifier(value.id) ||
    !["workspace_build", "creator_planner", "creator_builder"].includes(String(value.phase)) ||
    typeof value.trialStarted !== "boolean" ||
    !["locally_eligible", "rejected", "incomplete"].includes(String(value.status)) ||
    ![
      "none",
      "agent_failure",
      "tool_failure",
      "budget_exhausted",
      "verification_failure",
      "workspace_capability_violation",
      "provider_failure",
      "harness_failure",
      "incomplete",
    ].includes(String(value.classification)) ||
    value.studio !== "not_run" ||
    !Array.isArray(value.modelTurns) ||
    !isRuntimeTiming(value.timing) ||
    !Array.isArray(value.toolCalls) ||
    !isRecord(value.finalVerification) ||
    !isRecord(value.model) ||
    !isRecord(value.model.transportConfiguration) ||
    !isRecord(value.origin)
  )
    throw new Error("Invalid AgentRun");
  if (!value.modelTurns.every(isAgentModelTurn) || !value.toolCalls.every(isToolCallRecord))
    throw new Error("Invalid AgentRun timing evidence");
  assertTimelineWithinRuntime(value.timing, value.modelTurns, value.toolCalls);
  if (value.phase === "workspace_build" && value.creatorPhaseOutcome !== undefined)
    throw new Error("Workspace AgentRun cannot carry a creator phase outcome");
  if (value.phase === "workspace_build" && value.executionWorker !== undefined)
    throw new Error("Workspace AgentRun cannot carry a creator worker descriptor");
  if (value.phase === "workspace_build" && value.executionJournal !== undefined)
    throw new Error("Workspace AgentRun cannot carry a creator execution journal");
  if (value.phase !== "creator_builder" && value.creatorBuildContract !== undefined)
    throw new Error("Only creator-builder AgentRun may carry a build contract");
  if (
    value.phase === "creator_builder" &&
    (!isRecord(value.creatorBuildContract) ||
      !isIdentifier(value.creatorBuildContract.id) ||
      !isHash(value.creatorBuildContract.hash))
  )
    throw new Error("Creator builder AgentRun requires its exact build contract");
  if (value.phase !== "workspace_build" && !isCreatorPhaseOutcome(value.creatorPhaseOutcome))
    throw new Error("Creator phase AgentRun requires a sealed or unsealed phase outcome");
  if (value.phase !== "workspace_build" && !isCurrentCreatorWorker(value.executionWorker))
    throw new Error("Creator phase AgentRun requires the current execution-worker binding");
  if (value.phase !== "workspace_build") {
    assertAgentExecutionJournalBinding(value.executionJournal);
    if (value.executionJournal.journalId !== agentExecutionJournalIdForAgentRun(value.id))
      throw new Error("Creator phase AgentRun has another execution journal identity");
  }
  if (value.origin.kind === "creator_session") {
    if (!isIdentifier(value.origin.creatorSessionId) || !isHash(value.origin.creatorSessionHash))
      throw new Error("Invalid AgentRun creator session origin");
    return;
  }
  if (
    value.origin.kind !== "registered_experiment" ||
    !isIdentifier(value.origin.experimentRegistrationId) ||
    !isHash(value.origin.experimentRegistrationHash)
  )
    throw new Error("Invalid AgentRun origin");
}

export function agentExecutionJournalIdForAgentRun(agentRunId: string): string {
  if (!isIdentifier(agentRunId)) throw new Error("Invalid AgentRun ID for execution journal");
  return `agent_execution_journal:${agentRunId}`;
}

export function createAgentExecutionSlot(input: {
  purpose: AgentExecutionSlot["purpose"];
  ordinal: number;
  agentRunId?: string;
}): AgentExecutionSlot {
  const slot: AgentExecutionSlot = {
    purpose: input.purpose,
    ordinal: input.ordinal,
    agentRunId: input.agentRunId ?? `agent_run_${randomUUID()}`,
    journalId: "",
  };
  const result = { ...slot, journalId: agentExecutionJournalIdForAgentRun(slot.agentRunId) };
  assertAgentExecutionSlot(result);
  return result;
}

export function assertAgentExecutionSlot(value: unknown): asserts value is AgentExecutionSlot {
  if (
    !isRecord(value) ||
    !["planner", "builder", "repair"].includes(String(value.purpose)) ||
    !Number.isSafeInteger(value.ordinal) ||
    Number(value.ordinal) <= 0 ||
    !isIdentifier(value.agentRunId) ||
    !String(value.agentRunId).startsWith("agent_run_") ||
    value.journalId !== agentExecutionJournalIdForAgentRun(String(value.agentRunId))
  )
    throw new Error("Invalid preassigned agent execution slot");
}

export function assertAgentExecutionJournalBinding(
  value: unknown,
): asserts value is AgentExecutionJournalBinding {
  if (
    !isRecord(value) ||
    typeof value.journalId !== "string" ||
    !/^agent_execution_journal:agent_run_[A-Za-z0-9_-]+$/.test(value.journalId) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) <= 0 ||
    !isHash(value.entryHash) ||
    !isHash(value.terminalResultHash)
  )
    throw new Error("Invalid creator execution journal binding");
  assertArtifactReference(value.entry);
}

export async function verifyAgentRunExecutionJournal(
  run: AgentRun,
  artifactStore: ImmutableJsonArtifactStore,
): Promise<void> {
  assertAgentRun(run);
  if (run.phase === "workspace_build") return;
  const binding = run.executionJournal!;
  const loaded = await new AgentExecutionJournalStore(artifactStore).load(binding.journalId);
  const terminal = loaded.entries.at(-1);
  if (
    loaded.head.sequence !== binding.sequence ||
    loaded.head.entryHash !== binding.entryHash ||
    stableJson(loaded.head.entry) !== stableJson(binding.entry) ||
    terminal?.checkpoint.checkpointType !== "terminal" ||
    contentHash(stableJson(terminal.checkpoint.result)) !== binding.terminalResultHash
  )
    throw new Error("Creator AgentRun execution-journal evidence does not match its binding");
}

export function assertWorkspaceCandidateArtifact(
  value: unknown,
): asserts value is WorkspaceCandidateArtifact {
  if (
    !isRecord(value) ||
    value.kind !== "WorkspaceCandidateArtifact" ||
    !isIdentifier(value.id) ||
    !isHash(value.artifactHash) ||
    !isString(value.createdAt) ||
    !isString(value.seedRoot) ||
    !isHash(value.seedHash) ||
    !isSafeRelative(String(value.candidateDirectory)) ||
    !isHash(value.candidateHash) ||
    !isRecord(value.origin) ||
    !isIdentifier(value.requirementSetId) ||
    !isIdentifier(value.requirementViewId) ||
    !isIdentifier(value.harnessConfigurationId) ||
    !isHash(value.harnessConfigurationHash) ||
    !Array.isArray(value.sourceFiles) ||
    !isRecord(value.localGate)
  )
    throw new Error("Invalid WorkspaceCandidateArtifact");
  if (value.origin.kind === "creator_session") {
    if (
      !isIdentifier(value.origin.agentRunId) ||
      !isIdentifier(value.origin.creatorSessionId) ||
      !isHash(value.origin.creatorSessionHash)
    )
      throw new Error("Invalid WorkspaceCandidateArtifact origin");
  } else if (
    value.origin.kind !== "registered_experiment" ||
    !isIdentifier(value.origin.agentRunId) ||
    !isIdentifier(value.origin.experimentRegistrationId) ||
    !isHash(value.origin.experimentRegistrationHash)
  )
    throw new Error("Invalid WorkspaceCandidateArtifact origin");
  assertWorkspaceDelta(value.workspaceDelta);
  if (
    value.workspaceDelta.seedHash !== value.seedHash ||
    value.workspaceDelta.candidateHash !== value.candidateHash
  )
    throw new Error("WorkspaceCandidateArtifact delta hashes do not match");
  if (
    !(value.sourceFiles as unknown[]).every(
      (file) =>
        isRecord(file) &&
        isSafeRelative(String(file.path)) &&
        isHash(file.sourceHash) &&
        ["server", "client", "shared", "unknown"].includes(String(file.executionContext)),
    )
  )
    throw new Error("Invalid WorkspaceCandidateArtifact source manifest");
  const files = value.sourceFiles as Array<{ path: string }>;
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file, index) => index > 0 && files[index - 1]!.path.localeCompare(file.path) >= 0)
  )
    throw new Error("WorkspaceCandidateArtifact source manifest is not canonical");
  if (
    value.localGate.status !== "locally_eligible" ||
    !isHash(value.localGate.reportHash) ||
    !isIdentifier(value.localGate.traceId)
  )
    throw new Error("Invalid WorkspaceCandidateArtifact local gate");
  const { id: _id, artifactHash, ...payload } = value;
  const expectedHash = contentHash(stableJson(payload));
  if (
    artifactHash !== expectedHash ||
    value.id !== `workspace_candidate_${expectedHash.slice(0, 24)}`
  )
    throw new Error("Invalid WorkspaceCandidateArtifact identity");
}

const BLOCKED_PREFIXES = [
  ".forge",
  "runs",
  "proofs",
  "regressions",
  "patches",
  "credentials",
  "hidden",
  "benchmark",
  "repair",
];
const ALLOWED_EXTENSIONS = [".lua", ".luau"];
const WORKSPACE_CAPABILITY_CODES = new Set([
  "PATH_FORBIDDEN",
  "PATH_NOT_REGULAR_FILE",
  "PATH_NOT_REGULAR_DIRECTORY",
  "PATH_ALREADY_EXISTS",
  "STALE_WRITE",
  "PLAN_REQUIRED",
  "WRITE_BUDGET_EXHAUSTED",
  "WRITE_SIZE_EXCEEDED",
  "DELTA_BUDGET_EXCEEDED",
]);

export async function prepareAgentBuild(request: AgentBuildRequest): Promise<PreparedAgentBuild> {
  if (
    (request.experiment ? 1 : 0) +
      (request.creatorSession ? 1 : 0) +
      (request.registrationPreflight ? 1 : 0) !==
    1
  )
    throw new Error(
      "AgentBuildRequest requires exactly one registered-experiment, creator-session, or registration-preflight origin",
    );
  if (
    request.creatorSession &&
    (!isIdentifier(request.creatorSession.id) || !isHash(request.creatorSession.hash))
  )
    throw new Error("Invalid creator-session binding");
  assertRequirementSet(request.requirementSet);
  assertNonEmpty(request.creatorPrompt, "creator prompt");
  assertNonEmpty(request.model, "model");
  const creator = request.requirementSet.requirements.find(
    (requirement) =>
      requirement.source === "creator" &&
      requirement.evidence.some(
        (evidence) =>
          evidence.kind === "creator_request" &&
          evidence.requestHash === contentHash(request.creatorPrompt),
      ),
  );
  if (!creator)
    throw new Error("Creator prompt must have hash-matched creator requirement evidence");
  const budgets = { ...(request.budgets ?? DEFAULT_AGENT_BUDGETS) };
  const requirementView = resolveRequirementView(request.requirementSet, {
    phase: "build",
    environment: request.environment ?? "production",
    audience: "builder",
  });
  const workspace = await CandidateWorkspace.create(
    request.seedRoot,
    request.runDirectory,
    budgets,
    request.traceDirectory,
  );
  const semanticMap = await workspace.semanticMap();
  const orientation = compileAgentOrientation({
    semanticMap,
    projectSnapshotHash: createProjectSnapshot(semanticMap).projectSemanticHash,
    requirementView,
    sourceRoots: workspace.sourceRoots,
  });
  const toolHost = new BoundedToolHost(workspace, budgets);
  const systemPrompt = request.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const modelDescriptor = {
    transport: request.runtime.modelClientDescriptor.transport,
    name: request.model,
    transportConfiguration: request.runtime.modelClientDescriptor.configuration,
  };
  const configuration = createHarnessConfiguration({
    systemPrompt,
    tools: toolHost.definitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
    })),
    capabilityPolicy: {
      sourceRoots: workspace.sourceRoots,
      blockedPathPrefixes: BLOCKED_PREFIXES,
      allowedExtensions: ALLOWED_EXTENSIONS,
    },
    orientation: {
      policy: orientation.policy,
      contentHash: orientation.contentHash,
    },
    requirementViewHash: contentHash(stableJson(requirementView)),
    budgets,
    runtime: request.runtime.identity,
    model: modelDescriptor,
  });
  return {
    creatorStatement: creator.statement,
    budgets,
    requirementView,
    workspace,
    orientation,
    toolHost,
    systemPrompt,
    modelDescriptor,
    configuration,
  };
}

export function orderedToolDescriptionsHash(
  tools: readonly Pick<AgentToolDefinition, "name" | "description">[],
): string {
  return contentHash(
    stableJson(tools.map((tool) => ({ name: tool.name, description: tool.description }))),
  );
}

function assertExperimentPreparation(
  binding: ExperimentRegistrationBinding,
  prepared: PreparedAgentBuild,
): void {
  if (
    !isIdentifier(binding.id) ||
    !isHash(binding.hash) ||
    !isHash(binding.expected.seedHash) ||
    !Array.isArray(binding.expected.sourceRoots) ||
    !isIdentifier(binding.expected.orientationId) ||
    !isHash(binding.expected.orientationContentHash) ||
    !isHash(binding.expected.toolDescriptionsHash) ||
    !isIdentifier(binding.expected.harnessConfigurationId) ||
    !isHash(binding.expected.harnessConfigurationHash)
  )
    throw new Error("Invalid ExperimentRegistration binding");
  const actual = {
    seedHash: prepared.workspace.seedTreeHash,
    sourceRoots: prepared.workspace.sourceRoots,
    orientationId: prepared.orientation.id,
    orientationContentHash: prepared.orientation.contentHash,
    toolDescriptionsHash: orderedToolDescriptionsHash(prepared.toolHost.definitions()),
    harnessConfigurationId: prepared.configuration.id,
    harnessConfigurationHash: prepared.configuration.hash,
  };
  if (stableJson(actual) !== stableJson(binding.expected))
    throw new Error("ExperimentRegistration drift detected before model invocation");
}

export async function runBoundedAgent(request: AgentBuildRequest): Promise<AgentBuildResult> {
  const runId = `agent_run_${randomUUID()}`;
  const prepared = await prepareAgentBuild(request);
  if (request.experiment) assertExperimentPreparation(request.experiment, prepared);
  await request.beforeModelInvocation?.();

  let runtimeResult: AgentRuntimeResult;
  try {
    runtimeResult = await request.runtime.run({
      systemPrompt: prepared.systemPrompt,
      prompt: prepared.creatorStatement,
      orientation: prepared.orientation,
      tools: prepared.toolHost,
      budgets: prepared.budgets,
      model: request.model,
    });
  } catch (error) {
    runtimeResult = {
      status: "failed",
      trialStarted: false,
      failureKind: "harness",
      error: error instanceof Error ? error.message : String(error),
      usage: emptyRuntimeUsage(),
      turns: [],
      toolCalls: [],
      timing: zeroRuntimeTiming(),
    };
  }

  let delta: WorkspaceDelta;
  try {
    delta = await prepared.workspace.freezeDelta();
  } catch (error) {
    runtimeResult = {
      ...runtimeResult,
      status: "failed",
      failureKind: "tool",
      error: error instanceof Error ? error.message : String(error),
    };
    delta = await prepared.workspace.currentDeltaUnchecked();
  }
  const toolCalls = runtimeResult.toolCalls;
  const consumption = prepared.workspace.consumption(
    toolCalls,
    runtimeResult.timing.durationMs,
    runtimeResult.usage,
  );
  const exhausted = exhaustedBudgets(prepared.budgets, consumption);
  const finalVerification = await verifyProject(prepared.workspace.candidateRoot, {
    traceDirectory: request.traceDirectory,
    traceReferences: {
      agentRunId: runId,
      ...(request.experiment
        ? {
            experimentRegistrationId: request.experiment.id,
            experimentRegistrationHash: request.experiment.hash,
          }
        : {}),
      requirementSetId: request.requirementSet.id,
      requirementViewId: prepared.requirementView.id,
      workspaceDeltaId: delta.id,
      harnessConfigurationId: prepared.configuration.id,
      harnessConfigurationHash: prepared.configuration.hash,
    },
  });
  await prepared.workspace.assertSeedUnchanged();

  let status: AgentRunStatus = "incomplete";
  let classification: AgentFailureClassification = "incomplete";
  if (runtimeResult.status === "budget_exhausted" || exhausted.length > 0)
    classification = "budget_exhausted";
  else if (runtimeResult.status === "failed")
    classification =
      runtimeResult.failureKind === "provider"
        ? "provider_failure"
        : runtimeResult.failureKind === "model"
          ? "agent_failure"
          : runtimeResult.failureKind === "tool"
            ? "tool_failure"
            : "harness_failure";
  else if (prepared.toolHost.plans().length === 0 || delta.operations.length === 0)
    classification = "agent_failure";
  else if (finalVerification.report.gate.status === "eligible") {
    status = "locally_eligible";
    classification = "none";
  } else if (finalVerification.report.gate.status === "rejected") {
    status = "rejected";
    const failureCodes = toolCalls.flatMap((record) =>
      record.result.error?.code ? [record.result.error.code] : [],
    );
    classification = failureCodes.some((code) => WORKSPACE_CAPABILITY_CODES.has(code))
      ? "workspace_capability_violation"
      : failureCodes.length > 0
        ? "tool_failure"
        : "verification_failure";
  }

  const run: AgentRun = {
    kind: "AgentRun",
    id: runId,
    createdAt: new Date().toISOString(),
    status,
    classification,
    trialStarted: runtimeResult.trialStarted,
    phase: "workspace_build",
    origin: request.experiment
      ? {
          kind: "registered_experiment",
          experimentRegistrationId: request.experiment.id,
          experimentRegistrationHash: request.experiment.hash,
        }
      : {
          kind: "creator_session",
          creatorSessionId: request.creatorSession!.id,
          creatorSessionHash: request.creatorSession!.hash,
        },
    creatorPromptHash: contentHash(request.creatorPrompt),
    requirementSetId: request.requirementSet.id,
    requirementViewId: prepared.requirementView.id,
    orientationId: prepared.orientation.id,
    harnessConfigurationId: prepared.configuration.id,
    harnessConfigurationHash: prepared.configuration.hash,
    seedHash: prepared.workspace.seedTreeHash,
    ...(delta.operations.length > 0 ? { workspaceDelta: delta } : {}),
    runtime: { ...request.runtime.identity },
    timing: { ...runtimeResult.timing },
    model: prepared.modelDescriptor,
    modelTurns: runtimeResult.turns,
    plans: prepared.toolHost.plans(),
    toolCalls,
    budgets: { policy: prepared.budgets, consumed: consumption, exhausted },
    finalVerification: {
      gate: finalVerification.report.gate.status,
      reportHash: contentHash(stableJson(finalVerification.report)),
      traceId: finalVerification.trace.id,
    },
    studio: "not_run",
    ...(runtimeResult.summary ? { summary: runtimeResult.summary } : {}),
    ...(runtimeResult.error ? { error: runtimeResult.error } : {}),
  };
  assertAgentRun(run);
  const trace = createAgentBuildTrace(run, prepared.configuration, finalVerification);
  const tracePersistence = await new JsonFileTraceSink(request.traceDirectory).persist(trace);
  run.buildTraceId = trace.id;
  const persistence = await persistAgentRun(run, request.runDirectory);
  const candidateArtifact =
    status === "locally_eligible" && run.workspaceDelta
      ? await persistWorkspaceCandidateArtifact({
          directory: request.runDirectory,
          workspace: prepared.workspace,
          run,
          delta: run.workspaceDelta,
          requirementSetId: request.requirementSet.id,
          requirementViewId: prepared.requirementView.id,
          configuration: prepared.configuration,
          verification: finalVerification,
        })
      : undefined;
  return {
    status,
    classification,
    run,
    persistence,
    candidateRoot: prepared.workspace.candidateRoot,
    ...(candidateArtifact ? { candidateArtifact } : {}),
    trace,
    tracePersistence,
    finalVerification,
  };
}

/** Persist one prompt-only creator planner or builder phase as an AgentRun. */
export async function persistCreatorPhaseAgentRun(input: {
  agentRunId: string;
  phase: "creator_planner" | "creator_builder";
  creatorSession: { id: string; hash: string };
  promptHash: string;
  projectId: string;
  revisionHash: string;
  orientation: AgentOrientation;
  systemPrompt: string;
  finalization: CreatorPhaseFinalization;
  runtime: AgentRuntime;
  runtimeResult: AgentRuntimeResult;
  /** Exact registry-selected model requested for this phase, even when no
   * provider response exists from which to recover attribution. */
  model: string;
  toolHost: AgentToolHost;
  budgets: BudgetPolicy;
  directory: string;
  traceDirectory: string;
  executionWorker: CreatorAgentExecutionWorker;
  executionJournal: LoadedAgentExecutionJournal;
  creatorBuildContract?: { id: string; hash: string };
}): Promise<CreatorPhaseAgentRunResult> {
  if (
    !isIdentifier(input.agentRunId) ||
    !input.agentRunId.startsWith("agent_run_") ||
    !isIdentifier(input.creatorSession.id) ||
    !isHash(input.creatorSession.hash) ||
    !isHash(input.promptHash) ||
    !isIdentifier(input.projectId) ||
    !isHash(input.revisionHash) ||
    typeof input.model !== "string" ||
    input.model.length === 0 ||
    input.model.length > 256
  )
    throw new Error("Invalid creator phase AgentRun binding");
  const terminalJournalEntry = input.executionJournal.entries.at(-1);
  if (
    input.executionJournal.head.journalId !==
      agentExecutionJournalIdForAgentRun(input.agentRunId) ||
    input.executionJournal.head.sequence !== input.executionJournal.entries.length ||
    terminalJournalEntry?.hash !== input.executionJournal.head.entryHash ||
    terminalJournalEntry.checkpoint.checkpointType !== "terminal" ||
    stableJson(terminalJournalEntry.checkpoint.result) !== stableJson(input.runtimeResult)
  )
    throw new Error("Creator phase AgentRun requires its exact terminal execution journal");
  if (
    input.runtimeResult.turns.some(
      (turn) =>
        turn.responseFacts !== undefined && turn.responseFacts.requestedModel !== input.model,
    )
  )
    throw new Error("Creator phase model-turn attribution does not match the requested model");
  if (input.finalization.status === "sealed") {
    if (!isIdentifier(input.finalization.artifact.id) || !isHash(input.finalization.artifact.hash))
      throw new Error("Invalid sealed creator artifact binding");
  } else if (
    !isIdentifier(input.finalization.failureCode) ||
    input.finalization.detail.length === 0
  )
    throw new Error("Invalid unsealed creator phase outcome");
  const intendedArtifactKind = input.phase === "creator_planner" ? "creator_outcome" : "change_set";
  if (
    (input.phase === "creator_builder") !== (input.creatorBuildContract !== undefined) ||
    (input.creatorBuildContract &&
      (!isIdentifier(input.creatorBuildContract.id) || !isHash(input.creatorBuildContract.hash)))
  )
    throw new Error("Creator build-contract binding does not match its phase");
  if (
    (input.finalization.status === "sealed"
      ? input.finalization.artifact.kind
      : input.finalization.intendedArtifactKind) !== intendedArtifactKind
  )
    throw new Error("Creator phase outcome kind does not match its phase");
  if (input.finalization.status === "sealed" && input.runtimeResult.status !== "completed")
    throw new Error("A failed creator runtime cannot bind a sealed artifact");
  if (
    input.finalization.status === "unsealed" &&
    (input.finalization.failureStage === "runtime") === (input.runtimeResult.status === "completed")
  )
    throw new Error("Creator phase failure stage does not match its runtime status");
  const definitions = input.toolHost.definitions();
  const configuration = createHarnessConfiguration({
    systemPrompt: input.systemPrompt,
    tools: definitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
    })),
    capabilityPolicy: {
      sourceRoots: [],
      blockedPathPrefixes: [],
      allowedExtensions: [],
      executionWorker: { ...input.executionWorker },
    },
    orientation: {
      policy: input.orientation.policy,
      contentHash: input.orientation.contentHash,
    },
    requirementViewHash: input.promptHash,
    budgets: { ...input.budgets },
    runtime: { ...input.runtime.identity },
    model: {
      transport: input.runtime.modelClientDescriptor.transport,
      name: input.model,
      transportConfiguration: input.runtime.modelClientDescriptor.configuration,
    },
  });
  const toolCalls = input.runtimeResult.toolCalls;
  const consumed: BudgetConsumption = {
    turns: input.runtimeResult.usage.turns,
    toolCalls: toolCalls.length,
    writes: toolCalls.filter((call) => call.name === "studio.stage").length,
    verifierCalls: toolCalls.filter((call) => call.name === "forge.verify").length,
    changedFiles: 0,
    addedLines: 0,
    removedLines: 0,
    changedSourceBytes: toolCalls.reduce((sum, call) => sum + creatorStageSourceBytes(call), 0),
    toolResultBytes: toolCalls.reduce((sum, call) => sum + call.bytes, 0),
    durationMs: input.runtimeResult.timing.durationMs,
    inputTokens: input.runtimeResult.usage.inputTokens,
    outputTokens: input.runtimeResult.usage.outputTokens,
    costUsd: input.runtimeResult.usage.costUsd,
  };
  const exhausted = exhaustedBudgets(input.budgets, consumed);
  const attemptHash = contentHash(
    stableJson({
      phase: input.phase,
      model: input.model,
      intendedArtifactKind,
      runtime: {
        status: input.runtimeResult.status,
        trialStarted: input.runtimeResult.trialStarted,
        failureKind: input.runtimeResult.failureKind,
        failureCode: input.runtimeResult.failureCode,
        errorHash: input.runtimeResult.error ? contentHash(input.runtimeResult.error) : undefined,
        usage: input.runtimeResult.usage,
        timing: input.runtimeResult.timing,
        turns: input.runtimeResult.turns,
      },
      tools: toolCalls.map((call) => ({
        sequence: call.sequence,
        toolCallId: call.toolCallId,
        disposition: call.disposition,
        name: call.name,
        inputHash: call.inputHash,
        resultHash: call.resultHash,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        durationMs: call.durationMs,
      })),
      finalization:
        input.finalization.status === "sealed"
          ? input.finalization
          : {
              ...input.finalization,
              detail: undefined,
              detailHash: contentHash(input.finalization.detail),
            },
      executionJournal: {
        journalId: input.executionJournal.head.journalId,
        sequence: input.executionJournal.head.sequence,
        entryHash: input.executionJournal.head.entryHash,
        artifactHash: input.executionJournal.head.entry.artifactHash,
        terminalResultHash: contentHash(stableJson(input.runtimeResult)),
      },
      ...(input.creatorBuildContract ? { creatorBuildContract: input.creatorBuildContract } : {}),
    }),
  );
  const admitted =
    input.runtimeResult.status === "completed" &&
    input.finalization.status === "sealed" &&
    exhausted.length === 0;
  const phaseOutcome: CreatorPhaseOutcome = admitted
    ? {
        status: "sealed",
        artifact: {
          ...(input.finalization as Extract<CreatorPhaseFinalization, { status: "sealed" }>)
            .artifact,
        },
        attemptHash,
      }
    : input.finalization.status === "sealed"
      ? {
          status: "unsealed",
          intendedArtifactKind,
          failureStage: "finalization",
          failureCode: "CREATOR_PHASE_BUDGET_NOT_ADMITTED",
          detailHash: contentHash(
            `Creator phase exceeded: ${exhausted.join(", ") || "runtime budget"}`,
          ),
          attemptHash,
        }
      : {
          status: "unsealed",
          intendedArtifactKind: input.finalization.intendedArtifactKind,
          failureStage: input.finalization.failureStage,
          failureCode: input.finalization.failureCode,
          detailHash: contentHash(input.finalization.detail),
          attemptHash,
        };
  const status: AgentRunStatus = admitted ? "locally_eligible" : "incomplete";
  const classification: AgentFailureClassification =
    exhausted.length > 0 || input.runtimeResult.status === "budget_exhausted"
      ? "budget_exhausted"
      : input.runtimeResult.failureKind === "provider"
        ? "provider_failure"
        : input.finalization.status === "unsealed"
          ? input.finalization.failureKind === "tool"
            ? "tool_failure"
            : input.finalization.failureKind === "harness"
              ? "harness_failure"
              : "agent_failure"
          : input.runtimeResult.status === "completed"
            ? "none"
            : input.runtimeResult.failureKind === "tool"
              ? "tool_failure"
              : input.runtimeResult.failureKind === "harness"
                ? "harness_failure"
                : "agent_failure";
  const runId = input.agentRunId;
  const recorder = new FlightRecorder({
    projectId: input.projectId,
    references: {
      agentRunId: runId,
      creatorSessionId: input.creatorSession.id,
      creatorSessionHash: input.creatorSession.hash,
      ...(input.creatorBuildContract
        ? {
            creatorBuildContractId: input.creatorBuildContract.id,
            creatorBuildContractHash: input.creatorBuildContract.hash,
          }
        : {}),
      requirementSetId: `creator_requirement_set_${input.promptHash.slice(0, 24)}`,
      requirementViewId: `creator_requirement_view_${input.promptHash.slice(0, 24)}`,
      harnessConfigurationId: configuration.id,
      harnessConfigurationHash: configuration.hash,
    },
    components: {
      toolchain: [
        {
          name: input.executionWorker.name,
          configHash: contentHash(stableJson(input.executionWorker)),
        },
      ],
      verifiers: [],
      agent: {
        name: input.runtime.identity.name,
        configHash: configuration.hash,
      },
      model: {
        provider: input.runtime.modelClientDescriptor.transport,
        name: input.model,
        configurationHash: configuration.hash,
      },
    },
  });
  recorder.recordSpan(
    "forge.agent.execute",
    status === "locally_eligible" ? "ok" : "error",
    {
      "forge.agent.run_id": runId,
      "forge.creator.phase": input.phase,
      "forge.creator.session_id": input.creatorSession.id,
      "forge.creator.phase_outcome": phaseOutcome.status,
      "forge.creator.attempt_hash": attemptHash,
      "forge.agent.execution_journal_id": input.executionJournal.head.journalId,
      "forge.agent.execution_journal_entry_hash": input.executionJournal.head.entryHash,
      ...(input.creatorBuildContract
        ? {
            "forge.creator.build_contract_id": input.creatorBuildContract.id,
            "forge.creator.build_contract_hash": input.creatorBuildContract.hash,
          }
        : {}),
      ...(phaseOutcome.status === "sealed"
        ? { "forge.creator.artifact_hash": phaseOutcome.artifact.hash }
        : { "forge.creator.failure_code": phaseOutcome.failureCode }),
      "forge.worker.environment": input.executionWorker.environment,
      "forge.worker.isolation": input.executionWorker.isolation,
    },
    input.runtimeResult.timing,
  );
  for (const turn of input.runtimeResult.turns)
    recorder.recordSpan(
      "forge.model.generate",
      turn.resultKind === "provider_error" || turn.resultKind === "invalid_model_response"
        ? "error"
        : "ok",
      {
        "forge.model.turn_sequence": turn.sequence,
        "forge.model.request_hash": turn.requestHash,
      },
      turn,
    );
  for (const call of toolCalls)
    recorder.recordSpan(
      "forge.tool.call",
      call.result.ok ? "ok" : "error",
      {
        "forge.tool.name": call.name,
        "forge.tool.call_id": call.toolCallId,
        "forge.tool.disposition": call.disposition,
        "forge.tool.input_hash": call.inputHash,
        "forge.tool.result_hash": call.resultHash,
        "forge.tool.truncated": call.truncated,
        ...(call.result.error ? { "forge.tool.error_code": call.result.error.code } : {}),
      },
      call,
    );
  const trace = recorder.complete(
    {
      status,
      localGate: status === "locally_eligible" ? "eligible" : "incomplete",
      runtimeGate: "not_run",
      assertions: { total: 0, passed: 0 },
      modelUsage: {
        calls: consumed.turns,
        inputTokens: consumed.inputTokens,
        outputTokens: consumed.outputTokens,
        costUsd: consumed.costUsd,
      },
      latencyMs: { total: consumed.durationMs },
      issueCounts: {
        info: 0,
        warning: 0,
        error: status === "locally_eligible" ? 0 : 1,
        critical: 0,
      },
    },
    { verificationReportHash: attemptHash, issues: [] },
    {
      level: "semantic_reproduction",
      reasons: [
        phaseOutcome.status === "sealed"
          ? "The trace binds one model phase to the exact prompt-only creator session and sealed reviewed artifact."
          : "The trace binds one incomplete model phase, its tool history, and its unsealed terminal outcome to the exact prompt-only creator session.",
      ],
      randomSeeds: {},
    },
  );
  const phaseError =
    input.finalization.status === "unsealed"
      ? input.finalization.detail
      : admitted
        ? input.runtimeResult.error
        : `Creator phase exceeded: ${exhausted.join(", ") || "runtime budget"}`;
  const run: AgentRun = {
    kind: "AgentRun",
    id: runId,
    createdAt: new Date().toISOString(),
    status,
    classification,
    trialStarted: input.runtimeResult.trialStarted,
    phase: input.phase,
    origin: {
      kind: "creator_session",
      creatorSessionId: input.creatorSession.id,
      creatorSessionHash: input.creatorSession.hash,
    },
    creatorPromptHash: input.promptHash,
    requirementSetId: `creator_requirement_set_${input.promptHash.slice(0, 24)}`,
    requirementViewId: `creator_requirement_view_${input.promptHash.slice(0, 24)}`,
    orientationId: input.orientation.id,
    harnessConfigurationId: configuration.id,
    harnessConfigurationHash: configuration.hash,
    seedHash: input.revisionHash,
    runtime: { ...input.runtime.identity },
    timing: { ...input.runtimeResult.timing },
    model: {
      transport: input.runtime.modelClientDescriptor.transport,
      name: input.model,
      transportConfiguration: input.runtime.modelClientDescriptor.configuration,
    },
    modelTurns: input.runtimeResult.turns,
    plans: [],
    toolCalls,
    budgets: { policy: { ...input.budgets }, consumed, exhausted },
    finalVerification: {
      gate: status === "locally_eligible" ? "eligible" : "incomplete",
      reportHash: contentHash(stableJson({ phase: input.phase, phaseOutcome, status })),
      traceId: trace.id,
    },
    buildTraceId: trace.id,
    studio: "not_run",
    creatorPhaseOutcome: phaseOutcome,
    executionWorker: { ...input.executionWorker },
    executionJournal: {
      journalId: input.executionJournal.head.journalId,
      sequence: input.executionJournal.head.sequence,
      entryHash: input.executionJournal.head.entryHash,
      entry: { ...input.executionJournal.head.entry },
      terminalResultHash: contentHash(stableJson(input.runtimeResult)),
    },
    ...(input.creatorBuildContract
      ? { creatorBuildContract: { ...input.creatorBuildContract } }
      : {}),
    ...(input.runtimeResult.summary ? { summary: input.runtimeResult.summary } : {}),
    ...(phaseError ? { error: phaseError } : {}),
  };
  assertAgentRun(run);
  const [persistence, tracePersistence] = await Promise.all([
    persistAgentRun(run, input.directory),
    new JsonFileTraceSink(input.traceDirectory).persist(trace),
  ]);
  return { run, persistence, trace, tracePersistence, configuration };
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

  private constructor(
    seedRoot: string,
    candidateRoot: string,
    sourceRoots: string[],
    seedTreeHash: string,
    initialFiles: Map<string, { hash: string; source: string }>,
    private readonly budgets: BudgetPolicy,
    private readonly traceDirectory: string,
  ) {
    this.seedRoot = seedRoot;
    this.candidateRoot = candidateRoot;
    this.sourceRoots = sourceRoots;
    this.seedTreeHash = seedTreeHash;
    this.initialFiles = initialFiles;
  }

  static async create(
    seedRoot: string,
    runDirectory: string,
    budgets: BudgetPolicy,
    traceDirectory = resolve(runDirectory, "traces"),
  ): Promise<CandidateWorkspace> {
    const seed = resolve(seedRoot);
    const manifest = JSON.parse(await readFile(join(seed, "forge.fixture.json"), "utf8")) as {
      luauRoots?: unknown;
    };
    if (
      !Array.isArray(manifest.luauRoots) ||
      !manifest.luauRoots.every((item) => typeof item === "string" && isSafeRelative(item))
    )
      throw new Error("Seed fixture must declare safe luauRoots");
    const parent = resolve(runDirectory, "workspaces");
    if (parent === seed || parent.startsWith(`${seed}${sep}`))
      throw new Error("Agent run directory must be outside the seed workspace");
    await mkdir(parent, { recursive: true });
    const candidate = await mkdtemp(join(parent, "candidate-"));
    await cp(seed, candidate, {
      recursive: true,
      dereference: false,
      errorOnExist: false,
      force: true,
    });
    const sourceRoots = [...manifest.luauRoots].sort();
    const initialFiles = await sourceFileSnapshots(candidate, sourceRoots);
    return new CandidateWorkspace(
      seed,
      candidate,
      sourceRoots,
      await treeHash(seed),
      initialFiles,
      budgets,
      traceDirectory,
    );
  }

  async semanticMap() {
    const manifest = JSON.parse(
      await readFile(join(this.candidateRoot, "forge.fixture.json"), "utf8"),
    ) as Parameters<FilesystemProjectSourceAdapter["load"]>[0]["manifest"];
    return new FilesystemProjectSourceAdapter().load({
      root: this.candidateRoot,
      manifest,
    });
  }
  async list(): Promise<Array<{ path: string; bytes: number }>> {
    return (await sourceFiles(this.candidateRoot, this.sourceRoots)).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  }
  async read(path: string): Promise<string> {
    const target = this.resolveSourcePath(path);
    await this.assertSafeExistingTarget(target);
    return readFile(target, "utf8");
  }
  async write(
    path: string,
    precondition: WorkspaceWritePrecondition,
    content: string,
  ): Promise<void> {
    if (this.writes >= this.budgets.maxWrites)
      throw new CapabilityError("WRITE_BUDGET_EXHAUSTED", "Workspace write budget exhausted");
    if (Buffer.byteLength(content, "utf8") > this.budgets.maxBytesPerFile)
      throw new CapabilityError("WRITE_SIZE_EXCEEDED", "Workspace write exceeds per-file budget");
    const target = this.resolveSourcePath(path);
    if (precondition.kind === "sha256") {
      await this.assertSafeExistingTarget(target);
      const existing = await readFile(target, "utf8");
      if (contentHash(existing) !== precondition.hash)
        throw new CapabilityError(
          "STALE_WRITE",
          "Workspace write precondition hash does not match",
        );
      await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    } else {
      await this.assertSafeParent(target);
      try {
        await lstat(target);
        throw new CapabilityError(
          "PATH_ALREADY_EXISTS",
          "Absent-file write precondition failed because the target exists",
        );
      } catch (error) {
        if (error instanceof CapabilityError) throw error;
        if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
      }
      try {
        await writeFile(target, content, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST")
          throw new CapabilityError(
            "PATH_ALREADY_EXISTS",
            "Absent-file write precondition failed because the target exists",
          );
        throw error;
      }
    }
    this.writes += 1;
  }
  async verify(): Promise<VerificationRun> {
    if (this.verifierCalls >= this.budgets.maxVerifierCalls)
      throw new CapabilityError("VERIFY_BUDGET_EXHAUSTED", "Verifier-call budget exhausted");
    this.verifierCalls += 1;
    return verifyProject(this.candidateRoot, {
      traceDirectory: this.traceDirectory,
    });
  }
  async freezeDelta(): Promise<WorkspaceDelta> {
    const delta = await this.currentDeltaUnchecked();
    const usage = this.consumption([], 0, emptyRuntimeUsage());
    const failures = exhaustedBudgets(this.budgets, usage).filter((item) =>
      ["maxChangedFiles", "maxAddedLines", "maxRemovedLines", "maxChangedSourceBytes"].includes(
        item,
      ),
    );
    if (failures.length > 0)
      throw new CapabilityError(
        "DELTA_BUDGET_EXCEEDED",
        `Workspace delta exceeds budget: ${failures.join(", ")}`,
      );
    return delta;
  }
  async currentDeltaUnchecked(): Promise<WorkspaceDelta> {
    const current = await sourceFileSnapshots(this.candidateRoot, this.sourceRoots);
    const operations: WorkspaceDeltaOperation[] = [];
    for (const path of [...new Set([...this.initialFiles.keys(), ...current.keys()])].sort()) {
      const before = this.initialFiles.get(path);
      const after = current.get(path);
      if (before?.hash === after?.hash) continue;
      const beforeText = before?.source ?? "";
      const afterText = after?.source ?? "";
      operations.push({
        path,
        beforeHash: before?.hash ?? null,
        afterHash: after?.hash ?? contentHash(""),
        addedLines: Math.max(0, lineCount(afterText) - lineCount(beforeText)),
        removedLines: Math.max(0, lineCount(beforeText) - lineCount(afterText)),
        bytes: Buffer.byteLength(afterText, "utf8"),
      });
    }
    const candidateHash = (await this.semanticMap()).hashes.sourceHash;
    const payload = { seedHash: this.seedTreeHash, candidateHash, operations };
    const delta: WorkspaceDelta = {
      kind: "WorkspaceDelta",
      id: `workspace_delta_${contentHash(stableJson(payload)).slice(0, 24)}`,
      ...payload,
    };
    assertWorkspaceDelta(delta);
    this.lastDelta = delta;
    return delta;
  }
  async assertSeedUnchanged(): Promise<void> {
    if ((await treeHash(this.seedRoot)) !== this.seedTreeHash)
      throw new Error("Seed workspace changed during AgentRun");
  }
  consumption(
    records: readonly ToolCallRecord[],
    durationMs: number,
    usage: RuntimeUsage,
  ): BudgetConsumption {
    const delta = this.lastDelta;
    return {
      turns: usage.turns,
      toolCalls: records.length,
      writes: this.writes,
      verifierCalls: this.verifierCalls,
      changedFiles: delta?.operations.length ?? 0,
      addedLines: delta?.operations.reduce((sum, item) => sum + item.addedLines, 0) ?? 0,
      removedLines: delta?.operations.reduce((sum, item) => sum + item.removedLines, 0) ?? 0,
      changedSourceBytes: delta?.operations.reduce((sum, item) => sum + item.bytes, 0) ?? 0,
      toolResultBytes: records.reduce((sum, item) => sum + item.bytes, 0),
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    };
  }
  private resolveSourcePath(path: string): string {
    if (
      !isSafeRelative(path) ||
      !ALLOWED_EXTENSIONS.some((extension) => path.endsWith(extension)) ||
      BLOCKED_PREFIXES.some((prefix) => path.split("/").includes(prefix))
    )
      throw new CapabilityError("PATH_FORBIDDEN", "Path is outside allowed source capability");
    if (!this.sourceRoots.some((root) => path === root || path.startsWith(`${root}/`)))
      throw new CapabilityError("PATH_FORBIDDEN", "Path is not within a declared source root");
    const target = resolve(this.candidateRoot, path);
    if (!target.startsWith(`${this.candidateRoot}${sep}`))
      throw new CapabilityError("PATH_FORBIDDEN", "Path escapes candidate workspace");
    return target;
  }
  private async assertSafeExistingTarget(target: string): Promise<void> {
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new CapabilityError(
        "PATH_NOT_REGULAR_FILE",
        "Workspace target must be a regular non-symlink file",
      );
    const [resolvedTarget, resolvedRoot] = await Promise.all([
      realpath(target),
      realpath(this.candidateRoot),
    ]);
    if (!resolvedTarget.startsWith(`${resolvedRoot}${sep}`))
      throw new CapabilityError("PATH_FORBIDDEN", "Workspace target escapes through a symlink");
  }
  private async assertSafeParent(target: string): Promise<void> {
    const parent = dirname(target);
    let metadata;
    try {
      metadata = await lstat(parent);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT")
        throw new CapabilityError(
          "PATH_NOT_REGULAR_DIRECTORY",
          "Workspace target parent must already exist",
        );
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new CapabilityError(
        "PATH_NOT_REGULAR_DIRECTORY",
        "Workspace target parent must be a regular non-symlink directory",
      );
    const [resolvedParent, resolvedRoot] = await Promise.all([
      realpath(parent),
      realpath(this.candidateRoot),
    ]);
    if (resolvedParent !== resolvedRoot && !resolvedParent.startsWith(`${resolvedRoot}${sep}`))
      throw new CapabilityError(
        "PATH_FORBIDDEN",
        "Workspace target parent escapes through a symlink",
      );
  }
}

export class BoundedToolHost implements AgentToolHost {
  private readonly buildPlans: BuildPlan[] = [];
  constructor(
    private readonly workspace: CandidateWorkspace,
    _budgets: BudgetPolicy,
  ) {}
  definitions(): AgentToolDefinition[] {
    return TOOL_DEFINITIONS;
  }
  plans(): BuildPlan[] {
    return [...this.buildPlans];
  }
  validateBatch(calls: readonly ModelToolCall[], seenIds: ReadonlySet<string>): ToolBatchDecision {
    const idCounts = new Map<string, number>();
    for (const call of calls) idCounts.set(call.id, (idCounts.get(call.id) ?? 0) + 1);
    const errors = calls.map((call): { code: string; message: string } | undefined => {
      if (call.id.trim().length === 0)
        return {
          code: "TOOL_CALL_ID_EMPTY",
          message: "Tool-call IDs must be non-empty.",
        };
      if (seenIds.has(call.id) || (idCounts.get(call.id) ?? 0) > 1)
        return {
          code: "TOOL_CALL_ID_DUPLICATE",
          message: `Tool-call ID was already used in this AgentRun: ${call.id}`,
        };
      const definition = TOOL_DEFINITIONS.find((item) => item.name === call.name);
      if (!definition)
        return {
          code: "TOOL_UNKNOWN",
          message: `Unknown Forge tool: ${call.name}`,
        };
      const parsed = z.object(definition.inputShape).strict().safeParse(call.arguments);
      if (!parsed.success)
        return {
          code: "TOOL_ARGUMENTS_INVALID",
          message: `Arguments did not match the exact schema for ${call.name}.`,
        };
      return undefined;
    });
    if (errors.every((error) => error === undefined))
      return { valid: true, feedback: [], budgetExhausted: false };
    const feedback = calls.map((call, index) => {
      const error = errors[index] ?? {
        code: "TOOL_BATCH_REJECTED",
        message: "No tool was executed because another request in the batch was invalid.",
      };
      return {
        id: call.id,
        name: call.name,
        result: fail(error.code, error.message),
      };
    });
    return {
      valid: false,
      feedback,
      budgetExhausted: false,
    };
  }
  async execute(name: string, input: unknown): Promise<ToolResult> {
    const definition = TOOL_DEFINITIONS.find((item) => item.name === name);
    if (!definition) return fail("TOOL_UNKNOWN", `Unknown Forge tool: ${name}`);
    try {
      const parsed = z.object(definition.inputShape).strict().parse(input);
      let value: unknown;
      switch (name) {
        case "project.list":
          value = (await this.workspace.list()).slice(0, 100);
          break;
        case "project.search":
          value = await this.search(parsed as { query: string; maxResults?: number });
          break;
        case "project.read":
          value = await this.read(
            parsed as { path: string; startLine?: number; maxLines?: number },
          );
          break;
        case "project.inspect":
          value = await this.inspect();
          break;
        case "plan.update":
          value = this.updatePlan(parsed as Parameters<BoundedToolHost["updatePlan"]>[0]);
          break;
        case "workspace.write": {
          if (this.buildPlans.length === 0)
            throw new CapabilityError(
              "PLAN_REQUIRED",
              "workspace.write requires a BuildPlan first",
            );
          const write = parsed as {
            path: string;
            precondition: WorkspaceWritePrecondition;
            content: string;
          };
          await this.workspace.write(write.path, write.precondition, write.content);
          value = {
            path: write.path,
            written: true,
            created: write.precondition.kind === "absent",
          };
          break;
        }
        case "workspace.diff":
          value = await this.diff();
          break;
        case "forge.verify":
          value = await this.verify();
          break;
        default:
          value = null;
      }
      return bounded(value);
    } catch (error) {
      return fail(
        error instanceof CapabilityError ? error.code : "TOOL_INPUT_OR_EXECUTION",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  private async search(input: { query: string; maxResults?: number }): Promise<unknown> {
    assertNonEmpty(input.query, "search query");
    const results: Array<{ path: string; line: number; text: string }> = [];
    for (const file of await this.workspace.list()) {
      const source = await this.workspace.read(file.path);
      for (const [index, line] of source.split("\n").entries())
        if (line.includes(input.query))
          results.push({
            path: file.path,
            line: index + 1,
            text: line.slice(0, 300),
          });
    }
    return results.slice(0, Math.min(input.maxResults ?? 40, 40));
  }
  private async read(input: {
    path: string;
    startLine?: number;
    maxLines?: number;
  }): Promise<unknown> {
    const source = await this.workspace.read(input.path);
    const start = Math.max(1, input.startLine ?? 1);
    const max = Math.min(200, input.maxLines ?? 200);
    const sourceLines = source.split("\n");
    return {
      path: input.path,
      startLine: start,
      lines: sourceLines.slice(start - 1, start - 1 + max),
      sourceHash: contentHash(source),
      truncated: start - 1 + max < sourceLines.length,
    };
  }
  private async inspect(): Promise<unknown> {
    const map = await this.workspace.semanticMap();
    return {
      projectId: map.projectId,
      files: map.files.map((file) => ({
        path: file.path,
        executionContext: file.executionContext,
        sourceHash: contentHash(file.source),
      })),
      instances: map.instances
        .map((instance) => ({
          id: instance.id,
          path: instance.path,
          className: instance.className,
          ...(instance.position ? { position: { ...instance.position } } : {}),
        }))
        .sort(
          (left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id),
        ),
      remotes: map.remotes.map(({ path, className, direction, clientScript, serverScript }) => ({
        path,
        className,
        direction,
        clientScript,
        serverScript,
      })),
      snapshotHash: createProjectSnapshot(map).projectSemanticHash,
    };
  }
  private updatePlan(input: {
    goal: string;
    steps: Array<{
      id: string;
      statement: string;
      status: "pending" | "in_progress" | "completed";
    }>;
    currentStepId?: string;
    assumptions?: string[];
    expectedTouchedAreas?: string[];
    verificationIntentions?: string[];
    status: "draft" | "active" | "complete";
  }): BuildPlan {
    const revision = this.buildPlans.length + 1;
    const plan: BuildPlan = {
      kind: "BuildPlan",
      id: `build_plan_${contentHash(stableJson({ goal: input.goal, revision, steps: input.steps })).slice(0, 24)}`,
      revision,
      goal: input.goal,
      steps: [...input.steps],
      ...(input.currentStepId ? { currentStepId: input.currentStepId } : {}),
      assumptions: [...(input.assumptions ?? [])],
      expectedTouchedAreas: [...(input.expectedTouchedAreas ?? [])],
      verificationIntentions: [...(input.verificationIntentions ?? [])],
      status: input.status,
      source: "agent_plan",
      authority: "hypothesis",
    };
    assertBuildPlan(plan);
    this.buildPlans.push(plan);
    return plan;
  }
  private async diff(): Promise<unknown> {
    const delta = await this.workspace.freezeDelta();
    return {
      id: delta.id,
      operations: delta.operations.map(
        ({ path, beforeHash, afterHash, addedLines, removedLines }) => ({
          path,
          beforeHash,
          afterHash,
          addedLines,
          removedLines,
        }),
      ),
    };
  }
  private async verify(): Promise<unknown> {
    const run = await this.workspace.verify();
    return {
      gate: run.report.gate.status === "eligible" ? "locally_eligible" : run.report.gate.status,
      issues: run.report.issues.slice(0, 50).map(sanitizeIssue),
      reportHash: contentHash(stableJson(run.report)),
    };
  }
}

const TOOL_DEFINITIONS: AgentToolDefinition[] = [
  definition("project.list", "List bounded source files only.", {}),
  definition("project.search", "Search bounded source files for a literal string.", {
    query: z.string().min(1),
    maxResults: z.number().int().positive().max(40).optional(),
  }),
  definition("project.read", "Read a bounded range from one source file.", {
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    maxLines: z.number().int().positive().max(200).optional(),
  }),
  definition(
    "project.inspect",
    "Inspect sanitized project facts without exposing fixture expectations or hidden evaluator data.",
    {},
  ),
  definition(
    "plan.update",
    "Create or revise the agent-owned high-level BuildPlan. Call before the first write.",
    {
      goal: z.string().min(1),
      steps: z
        .array(
          z.object({
            id: z.string().min(1),
            statement: z.string().min(1),
            status: z.enum(["pending", "in_progress", "completed"]),
          }),
        )
        .min(1),
      currentStepId: z.string().min(1).optional(),
      assumptions: z.array(z.string()).optional(),
      expectedTouchedAreas: z.array(z.string()).optional(),
      verificationIntentions: z.array(z.string()).optional(),
      status: z.enum(["draft", "active", "complete"]),
    },
  ),
  definition(
    "workspace.write",
    "Create one new source file with an absent-file guard, or replace one existing source file with its current SHA-256 guard. Paths are candidate-relative, must begin with a declared root in orientation.content.sourceRoots, and are not Roblox service or absolute host paths. A BuildPlan is required first.",
    {
      path: z.string().min(1),
      precondition: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("sha256"),
          hash: z.string().regex(/^[0-9a-f]{64}$/),
        }),
        z.object({ kind: z.literal("absent") }),
      ]),
      content: z.string(),
    },
  ),
  definition("workspace.diff", "Return a bounded summary of changed source files.", {}),
  definition(
    "forge.verify",
    "Run the local static and semantic verifier and return sanitized diagnostics. This is optional; an independent final gate always runs.",
    {},
  ),
];

function definition(
  name: string,
  description: string,
  inputShape: ZodRawShape,
): AgentToolDefinition {
  return {
    name,
    description,
    inputShape,
    schema: z.toJSONSchema(z.object(inputShape)),
  };
}

function createAgentBuildTrace(
  run: AgentRun,
  configuration: HarnessConfiguration,
  verification: VerificationRun,
): BuildTrace {
  const recorder = new FlightRecorder({
    projectId: `project_${contentHash(run.seedHash).slice(0, 24)}`,
    references: {
      agentRunId: run.id,
      ...(run.origin.kind === "registered_experiment"
        ? {
            experimentRegistrationId: run.origin.experimentRegistrationId,
            experimentRegistrationHash: run.origin.experimentRegistrationHash,
          }
        : {
            creatorSessionId: run.origin.creatorSessionId,
            creatorSessionHash: run.origin.creatorSessionHash,
          }),
      requirementSetId: run.requirementSetId,
      requirementViewId: run.requirementViewId,
      ...(run.workspaceDelta ? { workspaceDeltaId: run.workspaceDelta.id } : {}),
      harnessConfigurationId: configuration.id,
      harnessConfigurationHash: configuration.hash,
    },
    components: {
      toolchain: [],
      verifiers: [],
      agent: { name: run.runtime.name, configHash: configuration.hash },
      model: {
        provider: run.model.transport,
        name: run.model.name,
        configurationHash: configuration.hash,
      },
    },
  });
  recorder.recordSpan(
    "forge.agent.execute",
    run.classification === "none" ? "ok" : "error",
    {
      "forge.agent.run_id": run.id,
      "forge.harness.configuration_hash": configuration.hash,
      "forge.tool.call_count": run.toolCalls.length,
    },
    run.timing,
  );
  for (const turn of run.modelTurns)
    recorder.recordSpan(
      "forge.model.generate",
      turn.resultKind === "provider_error" || turn.resultKind === "invalid_model_response"
        ? "error"
        : "ok",
      {
        "forge.model.turn_sequence": turn.sequence,
        "forge.model.request_hash": turn.requestHash,
        "forge.model.cost_usd": turn.usage.costUsd ?? 0,
      },
      turn,
    );
  for (const call of run.toolCalls)
    recorder.recordSpan(
      "forge.tool.call",
      call.result.ok ? "ok" : "error",
      {
        "forge.tool.name": call.name,
        "forge.tool.call_id": call.toolCallId,
        "forge.tool.disposition": call.disposition,
        "forge.tool.input_hash": call.inputHash,
        "forge.tool.result_hash": call.resultHash,
        "forge.tool.truncated": call.truncated,
        ...(call.result.error ? { "forge.tool.error_code": call.result.error.code } : {}),
      },
      call,
    );
  const counts = { info: 0, warning: 0, error: 0, critical: 0 };
  for (const issue of verification.report.issues) counts[issue.severity] += 1;
  const outcome: BuildOutcome = {
    status: run.status,
    localGate: verification.report.gate.status,
    runtimeGate: "not_run",
    assertions: { total: 0, passed: 0 },
    modelUsage: {
      calls: run.budgets.consumed.turns,
      inputTokens: run.budgets.consumed.inputTokens,
      outputTokens: run.budgets.consumed.outputTokens,
      costUsd: run.budgets.consumed.costUsd,
    },
    latencyMs: { total: run.budgets.consumed.durationMs },
    issueCounts: counts,
  };
  return recorder.complete(
    outcome,
    {
      verificationReportHash: contentHash(stableJson(verification.report)),
      issues: verification.report.issues.map((issue) => ({
        id: issue.id,
        ruleId: issue.ruleId,
        severity: issue.severity,
        category: issue.category,
        evidenceHash: contentHash(stableJson(issue.evidence)),
      })),
    },
    {
      level: "semantic_reproduction",
      reasons: ["The trace proves local eligibility only; Studio runtime evaluation was not run."],
      randomSeeds: {},
    },
  );
}

async function persistAgentRun(run: AgentRun, directory: string): Promise<AgentRunPersistence> {
  const path = join(resolve(directory), `${run.id}.json`);
  await mkdir(dirname(path), { recursive: true });
  const serialized = `${stableJson(run)}\n`;
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return {
    path: relative(process.cwd(), path),
    artifactHash: contentHash(serialized),
    mode: 0o600,
  };
}

async function persistWorkspaceCandidateArtifact(input: {
  directory: string;
  workspace: CandidateWorkspace;
  run: AgentRun;
  delta: WorkspaceDelta;
  requirementSetId: string;
  requirementViewId: string;
  configuration: HarnessConfiguration;
  verification: VerificationRun;
}): Promise<{
  artifact: WorkspaceCandidateArtifact;
  persistence: WorkspaceCandidateArtifactPersistence;
}> {
  if (
    input.run.status !== "locally_eligible" ||
    input.verification.report.gate.status !== "eligible"
  )
    throw new Error("Only a locally eligible candidate can be sealed");
  await input.workspace.assertSeedUnchanged();
  const directory = resolve(input.directory);
  const candidateDirectory = relative(directory, input.workspace.candidateRoot).replaceAll(
    "\\",
    "/",
  );
  if (!isSafeRelative(candidateDirectory) || candidateDirectory === ".")
    throw new Error("Candidate artifact cannot locate a workspace outside its run directory");
  const map = await input.workspace.semanticMap();
  const sourceFiles = map.files
    .map((file) => ({
      path: file.path,
      sourceHash: contentHash(file.source),
      executionContext: file.executionContext,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const payload: Omit<WorkspaceCandidateArtifact, "id" | "artifactHash"> = {
    kind: "WorkspaceCandidateArtifact",
    origin:
      input.run.origin.kind === "registered_experiment"
        ? {
            kind: "registered_experiment",
            agentRunId: input.run.id,
            experimentRegistrationId: input.run.origin.experimentRegistrationId,
            experimentRegistrationHash: input.run.origin.experimentRegistrationHash,
          }
        : {
            kind: "creator_session",
            agentRunId: input.run.id,
            creatorSessionId: input.run.origin.creatorSessionId,
            creatorSessionHash: input.run.origin.creatorSessionHash,
          },
    createdAt: new Date().toISOString(),
    seedRoot: input.workspace.seedRoot,
    seedHash: input.workspace.seedTreeHash,
    candidateDirectory,
    candidateHash: input.delta.candidateHash,
    workspaceDelta: input.delta,
    requirementSetId: input.requirementSetId,
    requirementViewId: input.requirementViewId,
    harnessConfigurationId: input.configuration.id,
    harnessConfigurationHash: input.configuration.hash,
    sourceFiles,
    localGate: {
      status: "locally_eligible",
      reportHash: contentHash(stableJson(input.verification.report)),
      traceId: input.verification.trace.id,
    },
  };
  const artifactHash = contentHash(stableJson(payload));
  const artifact: WorkspaceCandidateArtifact = {
    ...payload,
    id: `workspace_candidate_${artifactHash.slice(0, 24)}`,
    artifactHash,
  };
  assertWorkspaceCandidateArtifact(artifact);
  const path = join(directory, `${artifact.id}.json`);
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${stableJson(artifact)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  return {
    artifact,
    persistence: {
      path: relative(process.cwd(), path),
      artifactHash,
      mode: 0o600,
    },
  };
}

export async function loadWorkspaceCandidateArtifact(
  artifactPath: string,
  traceDirectory?: string,
): Promise<LoadedWorkspaceCandidateArtifact> {
  const resolvedArtifactPath = resolve(artifactPath);
  const artifact = JSON.parse(await readFile(resolvedArtifactPath, "utf8")) as unknown;
  assertWorkspaceCandidateArtifact(artifact);
  const candidateArtifact = artifact as WorkspaceCandidateArtifact;
  const artifactDirectory = dirname(resolvedArtifactPath);
  const candidateRoot = resolve(artifactDirectory, candidateArtifact.candidateDirectory);
  if (!candidateRoot.startsWith(`${artifactDirectory}${sep}`))
    throw new Error("WorkspaceCandidateArtifact candidate directory escapes artifact directory");
  if ((await treeHash(resolve(candidateArtifact.seedRoot))) !== candidateArtifact.seedHash)
    throw new Error("WorkspaceCandidateArtifact seed has changed");
  const manifest = JSON.parse(
    await readFile(join(candidateRoot, "forge.fixture.json"), "utf8"),
  ) as Parameters<FilesystemProjectSourceAdapter["load"]>[0]["manifest"];
  const map = await new FilesystemProjectSourceAdapter().load({
    root: candidateRoot,
    manifest,
  });
  if (
    map.hashes.sourceHash !== candidateArtifact.candidateHash ||
    candidateArtifact.workspaceDelta.candidateHash !== candidateArtifact.candidateHash
  )
    throw new Error("WorkspaceCandidateArtifact candidate source hash mismatch");
  const observedFiles = map.files
    .map((file) => ({
      path: file.path,
      sourceHash: contentHash(file.source),
      executionContext: file.executionContext,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (stableJson(observedFiles) !== stableJson(candidateArtifact.sourceFiles))
    throw new Error("WorkspaceCandidateArtifact source manifest mismatch");
  const verification = await verifyProject(candidateRoot, {
    ...(traceDirectory ? { traceDirectory } : {}),
    traceReferences: {
      agentRunId: candidateArtifact.origin.agentRunId,
      ...(candidateArtifact.origin.kind === "registered_experiment"
        ? {
            experimentRegistrationId: candidateArtifact.origin.experimentRegistrationId,
            experimentRegistrationHash: candidateArtifact.origin.experimentRegistrationHash,
          }
        : {}),
      requirementSetId: candidateArtifact.requirementSetId,
      requirementViewId: candidateArtifact.requirementViewId,
      workspaceDeltaId: candidateArtifact.workspaceDelta.id,
      harnessConfigurationId: candidateArtifact.harnessConfigurationId,
      harnessConfigurationHash: candidateArtifact.harnessConfigurationHash,
    },
  });
  if (verification.report.gate.status !== "eligible")
    throw new Error(
      `WorkspaceCandidateArtifact is no longer locally eligible: ${verification.report.gate.reasons.join(", ")}`,
    );
  return { artifact: candidateArtifact, candidateRoot, verification };
}

function bounded(value: unknown): ToolResult {
  const serialized = stableJson(value);
  const limit = 32 * 1024;
  const truncated = Buffer.byteLength(serialized, "utf8") > limit;
  const rendered = truncated ? serialized.slice(0, limit) : serialized;
  return {
    ok: true,
    value: truncated ? { truncated: true, preview: rendered } : value,
    truncated,
    resultHash: contentHash(serialized),
    bytes: Buffer.byteLength(rendered, "utf8"),
  };
}
function fail(code: string, message: string): ToolResult {
  const value = { code, message };
  const serialized = stableJson(value);
  return {
    ok: false,
    error: value,
    truncated: false,
    resultHash: contentHash(serialized),
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}
const MAX_IDENTICAL_REJECTED_TOOL_BATCHES = 3;
const MAX_PREMATURE_COMPLETION_REPAIRS = 2;

function materializeRejectedToolCalls(
  calls: readonly ModelToolCall[],
  feedback: readonly ToolBatchDecision["feedback"][number][],
  timing: RuntimeTiming,
  existingRecords: readonly ToolCallRecord[],
  budgets: BudgetPolicy,
): ToolCallRecord[] {
  const feedbackByCall = new Map<string, ToolResult[]>();
  for (const entry of feedback) {
    const key = `${entry.id}\u0000${entry.name}`;
    const results = feedbackByCall.get(key) ?? [];
    results.push(entry.result);
    feedbackByCall.set(key, results);
  }
  const runtimeRecords: ToolCallRecord[] = [];
  for (const call of calls) {
    const key = `${call.id}\u0000${call.name}`;
    let result =
      feedbackByCall.get(key)?.shift() ??
      fail(
        "TOOL_BATCH_REJECTED",
        "No tool was executed because the rejected batch did not return per-call feedback.",
      );
    result = enforceToolResultBudget(result, [...existingRecords, ...runtimeRecords], budgets);
    runtimeRecords.push({
      ...materializeToolCall(
        call,
        result,
        "rejected",
        timing,
        existingRecords.length + runtimeRecords.length + 1,
      ),
    });
  }
  return runtimeRecords;
}

function rejectedToolBudgetDecision(calls: readonly ModelToolCall[]): ToolBatchDecision {
  return {
    valid: false,
    feedback: calls.map((call) => ({
      id: call.id,
      name: call.name,
      result: fail("TOOL_BUDGET_EXHAUSTED", "This batch would exceed the tool-call budget."),
    })),
    budgetExhausted: true,
  };
}

function materializeToolCall(
  call: ModelToolCall,
  result: ToolResult,
  disposition: ToolCallRecord["disposition"],
  timing: RuntimeTiming,
  sequence: number,
): ToolCallRecord {
  return {
    sequence,
    toolCallId: call.id,
    disposition,
    name: call.name,
    inputHash: contentHash(stableJson(call.arguments)),
    resultHash: result.resultHash,
    truncated: result.truncated,
    bytes: result.bytes,
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    durationMs: timing.durationMs,
    input: structuredClone(call.arguments),
    result: structuredClone(result),
  };
}

function enforceToolResultBudget(
  result: ToolResult,
  existingRecords: readonly ToolCallRecord[],
  budgets: BudgetPolicy,
): ToolResult {
  const existingBytes = existingRecords.reduce((total, record) => total + record.bytes, 0);
  return existingBytes + result.bytes > budgets.maxToolResultBytes
    ? fail("TOOL_OUTPUT_BUDGET_EXHAUSTED", "Aggregate tool-result budget exhausted")
    : result;
}

function rejectedBatchFingerprint(
  feedback: readonly ToolBatchDecision["feedback"][number][],
  progressToken: string | undefined,
): string {
  return contentHash(
    stableJson({
      progressToken: progressToken ?? null,
      rejectionResults: [
        ...new Set(
          feedback
            .filter(
              (entry) => entry.result.error && entry.result.error.code !== "TOOL_BATCH_REJECTED",
            )
            .map((entry) =>
              stableJson({
                name: entry.name,
                code: entry.result.error?.code ?? null,
                issues: semanticFailureIssues(entry.result.error?.message ?? ""),
              }),
            ),
        ),
      ].sort(),
    }),
  );
}

function semanticFailureIssues(message: string): string[] {
  try {
    const value: unknown = JSON.parse(message);
    if (isRecord(value) && typeof value.message === "string") message = value.message;
  } catch {
    /* Plain-text diagnostics are already actionable. */
  }
  return [
    ...new Set(
      message.split("; ").map((issue) =>
        issue
          .replace(/\.[0-9]+(?=\.|:)/g, ".*")
          .replace(/"[^"\n]*"/g, '"value"')
          .replace(/[0-9]+/g, "#"),
      ),
    ),
  ].sort();
}

function copyToolCallRecord(record: ToolCallRecord): ToolCallRecord {
  return {
    ...record,
    input: structuredClone(record.input),
    result: structuredClone(record.result),
  };
}

function creatorStageSourceBytes(record: ToolCallRecord): number {
  if (
    record.name !== "studio.stage" ||
    !record.result.ok ||
    !isRecord(record.input) ||
    !Array.isArray(record.input.changes)
  )
    return 0;
  return record.input.changes.reduce((bytes, change: unknown) => {
    if (!isRecord(change)) return bytes;
    if (typeof change.source === "string") return bytes + Buffer.byteLength(change.source, "utf8");
    if (!Array.isArray(change.sourceEdits)) return bytes;
    return (
      bytes +
      change.sourceEdits.reduce(
        (sum, edit: unknown) =>
          sum +
          (isRecord(edit) && typeof edit.replacement === "string"
            ? Buffer.byteLength(edit.replacement, "utf8")
            : 0),
        0,
      )
    );
  }, 0);
}

function sanitizeIssue(issue: VerificationIssue): unknown {
  return {
    id: issue.id,
    ruleId: issue.ruleId,
    severity: issue.severity,
    category: issue.category,
    message: issue.message.length <= 1_024 ? issue.message : `${issue.message.slice(0, 1_023)}…`,
    ...(issue.path ? { path: issue.path } : {}),
    ...(issue.location
      ? {
          location: {
            line: issue.location.line,
            column: issue.location.column,
            ...(issue.location.endLine !== undefined ? { endLine: issue.location.endLine } : {}),
            ...(issue.location.endColumn !== undefined
              ? { endColumn: issue.location.endColumn }
              : {}),
          },
        }
      : {}),
    ...(issue.remediation
      ? {
          remediation: {
            kind: issue.remediation.kind,
            steps: issue.remediation.steps
              .slice(0, 3)
              .map((step) => (step.length <= 1_024 ? step : `${step.slice(0, 1_023)}…`)),
          },
        }
      : {}),
  };
}
function runtimeBudgetResult(
  error: string,
  usage: RuntimeUsage,
  turns: AgentModelTurn[],
  trialStarted: boolean,
): Omit<AgentRuntimeResult, "timing" | "toolCalls"> {
  return { status: "budget_exhausted", trialStarted, error, usage, turns };
}

interface TimingStart {
  monotonicStartedAt: number;
}

interface RuntimeTimeline {
  clock: FlightRecorderClock;
  wallOriginMs: number;
  monotonicOriginMs: number;
}

function createRuntimeTimeline(clock: FlightRecorderClock): RuntimeTimeline {
  return {
    clock,
    wallOriginMs: clock.now().getTime(),
    monotonicOriginMs: clock.monotonicNow(),
  };
}

function resumeMessages(
  messages: AgentExecutionJournalResume["request"]["messages"],
): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", content: message.content };
    if (message.role === "tool")
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        name: message.name,
        content: message.content,
      };
    return {
      role: "assistant",
      content: message.content,
      toolCalls: message.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: structuredClone(call.arguments),
      })),
    };
  });
}

function resumeResult(response: AgentExecutionJournalResume["response"]): ModelTurnResult {
  if (response.kind === "assistant")
    return {
      kind: "assistant",
      message: {
        role: "assistant",
        content: response.message.content,
        toolCalls: response.message.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: structuredClone(call.arguments),
        })),
      },
      stopReason: response.stopReason,
      requestHash: response.providerRequestHash,
      responseHash: response.responseHash,
      responseFacts: structuredClone(response.responseFacts),
      ...(response.providerMetadataHash === undefined
        ? {}
        : { providerMetadataHash: response.providerMetadataHash }),
      usage: structuredClone(response.usage),
    };
  const common = {
    errorClass: response.errorClass,
    message: response.message,
    requestHash: response.providerRequestHash,
    responseFacts: structuredClone(response.responseFacts),
    ...(response.providerMetadataHash === undefined
      ? {}
      : { providerMetadataHash: response.providerMetadataHash }),
    usage: structuredClone(response.usage),
  };
  return response.kind === "provider_error"
    ? { kind: "provider_error", retryable: response.retryable ?? false, ...common }
    : { kind: "invalid_model_response", ...common };
}

function assertRuntimeResumeInput(
  input: AgentRuntimeInput,
  resume: AgentExecutionJournalResume,
  initialMessage: string,
): void {
  if (
    resume.request.model !== input.model ||
    resume.request.systemHash !== contentHash(input.systemPrompt)
  )
    throw new Error("Runtime resume no longer matches its model or system authority");
  const first = resume.request.messages[0];
  if (first?.role !== "user" || first.content !== initialMessage)
    throw new Error("Runtime resume no longer matches its creator request authority");
  if (
    resume.state.materializedToolCalls !== resume.toolCalls.length ||
    resume.state.materializedToolResultBytes !==
      resume.toolCalls.reduce((total, toolCall) => total + toolCall.bytes, 0)
  )
    throw new Error("Runtime resume tool boundary does not match its durable records");
}

function assertResumeHostBoundary(
  resume: AgentExecutionJournalResume,
  progressToken: string | undefined,
): void {
  const expected = resume.state.toolHostProgressTokenHash;
  if (expected !== null && (progressToken === undefined || contentHash(progressToken) !== expected))
    throw new Error(
      "Runtime resume host state changed after its durable boundary; explicit creator-authorized retry_work is required",
    );
}

function startTiming(timeline: RuntimeTimeline): TimingStart {
  return {
    monotonicStartedAt: timeline.clock.monotonicNow(),
  };
}

function startTimingAt(timeline: RuntimeTimeline, startedAt: string): TimingStart {
  const elapsedMs = Math.max(0, timeline.wallOriginMs - Date.parse(startedAt));
  return { monotonicStartedAt: timeline.monotonicOriginMs - elapsedMs };
}

function timingStartIso(timeline: RuntimeTimeline, started: TimingStart): string {
  return new Date(
    timeline.wallOriginMs + Math.floor(started.monotonicStartedAt - timeline.monotonicOriginMs),
  ).toISOString();
}

function zeroTiming(at: string): RuntimeTiming {
  return { startedAt: at, endedAt: at, durationMs: 0 };
}

function runtimeNowIso(timeline: RuntimeTimeline): string {
  return new Date(
    timeline.wallOriginMs + elapsedFromTimeline(timeline, timeline.clock.monotonicNow()),
  ).toISOString();
}

function repeatCounterSnapshot(
  counts: ReadonlyMap<string, number>,
): Array<{ fingerprint: string; count: number }> {
  return [...counts.entries()]
    .map(([fingerprint, count]) => ({ fingerprint, count }))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function finishTiming(timeline: RuntimeTimeline, started: TimingStart): RuntimeTiming {
  const startedOffsetMs = Math.floor(started.monotonicStartedAt - timeline.monotonicOriginMs);
  const durationMs = elapsedSince(timeline, started);
  const startedAt = new Date(timeline.wallOriginMs + startedOffsetMs).toISOString();
  return {
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
    durationMs,
  };
}

function elapsedSince(timeline: RuntimeTimeline, started: TimingStart): number {
  return Math.max(0, Math.floor(timeline.clock.monotonicNow() - started.monotonicStartedAt));
}

function elapsedFromTimeline(timeline: RuntimeTimeline, monotonicAt: number): number {
  return Math.max(0, Math.floor(monotonicAt - timeline.monotonicOriginMs));
}

function zeroRuntimeTiming(): RuntimeTiming {
  const now = new Date().toISOString();
  return { startedAt: now, endedAt: now, durationMs: 0 };
}
function emptyRuntimeUsage(): RuntimeUsage {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}
function addUsage(current: RuntimeUsage, next: ModelUsage): RuntimeUsage {
  return {
    turns: current.turns + 1,
    inputTokens: addNullable(current.inputTokens, next.inputTokens),
    outputTokens: addNullable(current.outputTokens, next.outputTokens),
    reasoningTokens: addNullable(current.reasoningTokens, next.reasoningTokens),
    cacheReadTokens: addNullable(current.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: addNullable(current.cacheWriteTokens, next.cacheWriteTokens),
    costUsd: addNullable(current.costUsd, next.costUsd),
  };
}

function addNullable(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}
export function modelUsageBudgetFailure(
  policy: BudgetPolicy,
  usage: Pick<RuntimeUsage, "inputTokens" | "outputTokens" | "costUsd">,
): string | undefined {
  const limits = [
    ["cumulative input-token", usage.inputTokens, policy.maxInputTokens],
    ["cumulative output-token", usage.outputTokens, policy.maxOutputTokens],
    ["reported cost in USD", usage.costUsd, policy.maxBudgetUsd],
  ] as const;
  const exceeded = limits
    .filter(([, used, allowed]) => used !== null && used > allowed)
    .map(
      ([label, used, allowed]) =>
        `${label}: ${used!.toLocaleString("en-US", { maximumFractionDigits: 20 })} used / ${allowed.toLocaleString("en-US", { maximumFractionDigits: 20 })} allowed`,
    );
  if (exceeded.length === 0) return undefined;
  return (
    `Forge run limit exceeded (${exceeded.join("; ")}).` +
    (usage.inputTokens !== null && usage.inputTokens > policy.maxInputTokens
      ? " Input tokens add up across requests, including cached input."
      : "")
  );
}
function exhaustedBudgets(policy: BudgetPolicy, used: BudgetConsumption): string[] {
  const pairs: Array<[keyof BudgetPolicy, number | null]> = [
    ["maxTurns", used.turns],
    ["maxToolCalls", used.toolCalls],
    ["maxWrites", used.writes],
    ["maxVerifierCalls", used.verifierCalls],
    ["maxChangedFiles", used.changedFiles],
    ["maxAddedLines", used.addedLines],
    ["maxRemovedLines", used.removedLines],
    ["maxChangedSourceBytes", used.changedSourceBytes],
    ["maxToolResultBytes", used.toolResultBytes],
    ["maxDurationMs", used.durationMs],
    ["maxBudgetUsd", used.costUsd],
    ["maxInputTokens", used.inputTokens],
    ["maxOutputTokens", used.outputTokens],
  ];
  return pairs
    .filter(([key, value]) => value !== null && value > policy[key])
    .map(([key]) => String(key));
}
async function sourceFiles(
  root: string,
  roots: string[],
): Promise<Array<{ path: string; bytes: number }>> {
  const entries: Array<{ path: string; bytes: number }> = [];
  for (const sourceRoot of roots) await visit(join(root, sourceRoot), sourceRoot, entries);
  return entries;
}
async function sourceFileSnapshots(
  root: string,
  roots: string[],
): Promise<Map<string, { hash: string; source: string }>> {
  const snapshots = new Map<string, { hash: string; source: string }>();
  for (const file of await sourceFiles(root, roots)) {
    const source = await readFile(join(root, file.path), "utf8");
    snapshots.set(file.path, { hash: contentHash(source), source });
  }
  return snapshots;
}
async function visit(
  absolute: string,
  relativePath: string,
  results: Array<{ path: string; bytes: number }>,
): Promise<void> {
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const path = join(absolute, entry.name);
    const rel = `${relativePath}/${entry.name}`;
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink())
      throw new CapabilityError("PATH_FORBIDDEN", `Source root contains a symlink: ${rel}`);
    if (metadata.isDirectory()) await visit(path, rel, results);
    else if (
      metadata.isFile() &&
      ALLOWED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
    )
      results.push({ path: rel, bytes: (await stat(path)).size });
  }
}
async function treeHash(root: string): Promise<string> {
  const files: Array<{ path: string; hash: string }> = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      const rel = relative(root, target).replaceAll("\\", "/");
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw new Error(`Tree contains a symbolic link: ${rel}`);
      if (metadata.isDirectory()) await walk(target);
      else if (metadata.isFile())
        files.push({
          path: rel,
          hash: contentHash((await readFile(target)).toString("base64")),
        });
    }
  }
  await walk(root);
  return contentHash(stableJson(files.sort((left, right) => left.path.localeCompare(right.path))));
}
function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}
function isSafeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !path.split(/[\\/]+/).includes("..")
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRuntimeTiming(value: unknown): value is RuntimeTiming {
  if (
    !isRecord(value) ||
    typeof value.startedAt !== "string" ||
    typeof value.endedAt !== "string" ||
    typeof value.durationMs !== "number" ||
    !Number.isSafeInteger(value.durationMs) ||
    value.durationMs < 0
  )
    return false;
  const startedAt = Date.parse(value.startedAt);
  const endedAt = Date.parse(value.endedAt);
  return (
    Number.isFinite(startedAt) &&
    Number.isFinite(endedAt) &&
    new Date(startedAt).toISOString() === value.startedAt &&
    new Date(endedAt).toISOString() === value.endedAt &&
    endedAt >= startedAt &&
    value.durationMs === endedAt - startedAt
  );
}
function isAgentModelTurn(value: unknown): value is AgentModelTurn {
  if (!isRecord(value)) return false;
  const usage = value.usage;
  const requestSizes = value.requestSizes;
  return (
    isRecord(value) &&
    isRuntimeTiming(value) &&
    isIdentifier(value.requestHash) &&
    ["assistant", "invalid_model_response", "provider_error"].includes(String(value.resultKind)) &&
    Array.isArray(value.toolCallIds) &&
    value.toolCallIds.every(isString) &&
    isRecord(usage) &&
    [
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "costUsd",
    ].every(
      (field) =>
        usage[field] === null ||
        (typeof usage[field] === "number" && Number.isFinite(usage[field]) && usage[field] >= 0),
    ) &&
    isRecord(requestSizes) &&
    ["systemInstructions", "conversation", "toolSchemas", "toolResults"].every(
      (field) => Number.isSafeInteger(requestSizes[field]) && Number(requestSizes[field]) >= 0,
    )
  );
}
function isToolCallRecord(value: unknown): value is ToolCallRecord {
  return (
    isRecord(value) &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    isString(value.toolCallId) &&
    ["executed", "rejected"].includes(String(value.disposition)) &&
    isIdentifier(value.name) &&
    isHash(value.inputHash) &&
    isHash(value.resultHash) &&
    typeof value.truncated === "boolean" &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    isRuntimeTiming(value) &&
    isRecord(value.result)
  );
}
function assertTimelineWithinRuntime(
  timing: RuntimeTiming,
  turns: readonly AgentModelTurn[],
  toolCalls: readonly ToolCallRecord[],
): void {
  const runtimeStart = Date.parse(timing.startedAt);
  const runtimeEnd = Date.parse(timing.endedAt);
  for (const [index, turn] of turns.entries()) {
    if (turn.sequence !== index + 1)
      throw new Error("Agent model turns require contiguous sequences");
    const startedAt = Date.parse(turn.startedAt);
    const endedAt = Date.parse(turn.endedAt);
    if (startedAt < runtimeStart || endedAt > runtimeEnd)
      throw new Error("Agent model turn falls outside runtime interval");
  }
  for (const [index, call] of toolCalls.entries()) {
    if (call.sequence !== index + 1) throw new Error("Tool calls require contiguous sequences");
    const startedAt = Date.parse(call.startedAt);
    const endedAt = Date.parse(call.endedAt);
    if (startedAt < runtimeStart || endedAt > runtimeEnd)
      throw new Error("Tool call falls outside runtime interval");
  }
}
function isCreatorPhaseOutcome(value: unknown): value is CreatorPhaseOutcome {
  if (!isRecord(value) || !isHash(value.attemptHash)) return false;
  if (value.status === "sealed")
    return (
      isRecord(value.artifact) &&
      ["creator_outcome", "change_set"].includes(String(value.artifact.kind)) &&
      isIdentifier(value.artifact.id) &&
      isHash(value.artifact.hash)
    );
  return (
    value.status === "unsealed" &&
    ["creator_outcome", "change_set"].includes(String(value.intendedArtifactKind)) &&
    ["runtime", "finalization"].includes(String(value.failureStage)) &&
    isIdentifier(value.failureCode) &&
    isHash(value.detailHash)
  );
}
export function assertCreatorPhaseOutcome(value: unknown): asserts value is CreatorPhaseOutcome {
  if (!isCreatorPhaseOutcome(value)) throw new Error("Invalid creator phase outcome");
}
function isCurrentCreatorWorker(value: unknown): value is CreatorAgentExecutionWorker {
  return (
    isRecord(value) &&
    value.kind === "CreatorAgentWorkerDescriptor" &&
    value.name === "forge-local-creator-agent-worker" &&
    value.environment === "local_process" &&
    value.isolation === "none"
  );
}
function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty`);
}
class CapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const DEFAULT_SYSTEM_PROMPT =
  "You are a bounded Forge builder. Work only through Forge tools. Inspect the project, publish a high-level plan before writing, preserve explicit integration constraints, and do not claim Studio execution. Complete the creator request or report a concrete limit honestly.";
