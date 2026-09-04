import { isNodeError } from "../../artifact-store/src/index.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import type {
  ModelMessage,
  ModelResponseFacts,
  ModelRequestSizes,
  ModelTurnRequest,
  ModelTurnResult,
  ModelUsage,
} from "../../model-client/src/contracts.js";
import type {
  AgentModelTurn,
  AgentRuntimeResult,
  RuntimeUsage,
  ToolBatchDecision,
  ToolCallRecord,
} from "./index.js";

export type JournalModelMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls: readonly {
        readonly id: string;
        readonly name: string;
        readonly arguments: unknown;
      }[];
      readonly continuation:
        | { readonly present: false }
        | {
            readonly present: true;
            readonly transport: string;
            readonly hash: string;
            readonly bytes: number;
          };
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
    };

export interface JournalModelRequest {
  readonly model: string;
  readonly requestSizes: ModelRequestSizes;
  readonly systemHash: string;
  readonly messages: readonly JournalModelMessage[];
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  }[];
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export type JournalModelResult =
  | {
      readonly kind: "assistant";
      readonly message: Extract<JournalModelMessage, { readonly role: "assistant" }>;
      readonly stopReason: Extract<ModelTurnResult, { kind: "assistant" }>["stopReason"];
      readonly responseHash: string;
      readonly responseFacts: ModelResponseFacts;
      readonly providerRequestHash: string;
      readonly providerMetadataHash?: string;
      readonly usage: ModelUsage;
    }
  | {
      readonly kind: "invalid_model_response" | "provider_error";
      readonly errorClass: string;
      readonly message: string;
      readonly retryable?: boolean;
      readonly responseFacts: ModelResponseFacts;
      readonly providerRequestHash: string;
      readonly providerMetadataHash?: string;
      readonly usage: ModelUsage;
    };

interface CheckpointBase {
  readonly occurredAt: string;
}

export interface AgentExecutionBoundaryState {
  /**
   * Wall-clock origin of the original invocation. A resumed runtime keeps it
   * for one auditable enclosing interval, while `remaining.durationMs`
   * carries the active execution budget across process downtime.
   */
  readonly runtimeStartedAt: string;
  readonly usage: RuntimeUsage;
  readonly trialStarted: boolean;
  readonly remaining: {
    readonly turns: number;
    readonly toolCalls: number;
    readonly toolResultBytes: number;
    readonly durationMs: number;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly budgetUsd: number | null;
  };
  readonly seenToolCallIds: readonly string[];
  readonly rejectedBatchRepeats: readonly {
    readonly fingerprint: string;
    readonly count: number;
  }[];
  readonly noProgressBatchRepeats: readonly {
    readonly fingerprint: string;
    readonly count: number;
  }[];
  readonly prematureCompletionRepairs: number;
  readonly toolHostProgressTokenHash: string | null;
  readonly materializedToolCalls: number;
  readonly materializedToolResultBytes: number;
}

export type AgentExecutionCheckpoint =
  | (CheckpointBase & {
      readonly checkpointType: "request_intent";
      readonly turnSequence: number;
      readonly intentHash: string;
      readonly request: JournalModelRequest;
      readonly state: AgentExecutionBoundaryState;
    })
  | (CheckpointBase & {
      readonly checkpointType: "response_received";
      readonly turnSequence: number;
      readonly intentHash: string;
      readonly result: JournalModelResult;
      /** State after accounting for this received provider result. */
      readonly state: AgentExecutionBoundaryState;
      /** Provider-neutral timing and attribution needed for exact replay. */
      readonly turn: AgentModelTurn;
    })
  | (CheckpointBase & {
      readonly checkpointType: "batch_validated";
      readonly turnSequence: number;
      readonly intentHash: string;
      readonly responseHash: string;
      readonly calls: readonly {
        readonly id: string;
        readonly name: string;
        readonly inputHash: string;
      }[];
      readonly decision: ToolBatchDecision;
      readonly state: AgentExecutionBoundaryState;
    })
  | (CheckpointBase & {
      readonly checkpointType: "tool_completed";
      readonly turnSequence: number;
      readonly intentHash: string;
      readonly responseHash: string;
      readonly toolCall: ToolCallRecord;
      readonly state: AgentExecutionBoundaryState;
    })
  | (CheckpointBase & {
      /**
       * Durable intent before invoking a potentially mutating host tool.  A
       * crash after this point but before tool_completed never retries it.
       */
      readonly checkpointType: "tool_execution_intent";
      readonly turnSequence: number;
      readonly intentHash: string;
      readonly responseHash: string;
      readonly toolCall: {
        readonly id: string;
        readonly name: string;
        readonly inputHash: string;
      };
      readonly state: AgentExecutionBoundaryState;
    })
  | (CheckpointBase & {
      readonly checkpointType: "terminal";
      readonly result: AgentRuntimeResult;
      readonly continuationBoundary:
        | { readonly kind: "not_required" }
        | {
            readonly kind: "opaque_continuation_not_persisted";
            readonly hashes: readonly string[];
            readonly rule: "explicit_new_agent_run_required_for_any_further_provider_turn";
          };
    });

/**
 * An awaited boundary hook. Implementations must resolve only after the
 * checkpoint is durable. Runtime execution never fire-and-forgets evidence.
 */
export interface AgentExecutionJournalSink {
  /** Present for store-backed sinks, allowing a resume binding check. */
  readonly journalId?: string;
  checkpoint(checkpoint: AgentExecutionCheckpoint): Promise<void>;
}

export interface AgentExecutionJournalEntry {
  readonly kind: "AgentExecutionJournalEntry";
  readonly id: string;
  readonly hash: string;
  readonly journalId: string;
  readonly sequence: number;
  readonly previousEntryHash?: string;
  readonly previousEntry?: ArtifactReference;
  readonly checkpoint: AgentExecutionCheckpoint;
}

export interface AgentExecutionJournalHead {
  readonly kind: "AgentExecutionJournalHead";
  readonly journalId: string;
  readonly sequence: number;
  readonly entryHash: string;
  readonly entry: ArtifactReference;
  readonly updatedAt: string;
}

export interface LoadedAgentExecutionJournal {
  readonly head: AgentExecutionJournalHead;
  readonly entries: readonly AgentExecutionJournalEntry[];
}

export type AgentExecutionJournalRecovery =
  | {
      readonly kind: "terminal";
      readonly automaticProviderDispatchAllowed: false;
    }
  | {
      readonly kind: "provider_outcome_unknown";
      readonly turnSequence: number;
      readonly intentHash: string;
      readonly exactSafeCreatorAction: "retry_work";
      readonly rule: "explicit_creator_authorized_retry_work_required";
      readonly automaticProviderDispatchAllowed: false;
    }
  | {
      readonly kind: "tool_outcome_unknown";
      readonly turnSequence: number;
      readonly responseHash: string;
      readonly toolCallId: string;
      readonly exactSafeCreatorAction: "retry_work";
      readonly rule: "explicit_creator_authorized_retry_work_required";
      readonly automaticProviderDispatchAllowed: false;
    }
  | {
      readonly kind: "response_ready";
      readonly turnSequence: number;
      readonly responseHash: string | null;
      readonly exactSafeCreatorAction: "resume_work";
      readonly rule: "persisted_response_must_be_consumed_before_any_new_provider_turn";
      readonly automaticProviderDispatchAllowed: false;
    };

/**
 * Provider-neutral material needed to consume an already durable response.
 * It contains no SDK values and no opaque reasoning continuation payload.
 */
export interface AgentExecutionJournalResume {
  readonly kind: "AgentExecutionJournalResume";
  readonly journalId: string;
  readonly turnSequence: number;
  readonly intentHash: string;
  readonly request: JournalModelRequest;
  readonly response: JournalModelResult;
  readonly state: AgentExecutionBoundaryState;
  readonly modelTurns: readonly AgentModelTurn[];
  readonly toolCalls: readonly ToolCallRecord[];
  readonly batch?: Extract<AgentExecutionCheckpoint, { checkpointType: "batch_validated" }>;
  readonly completedToolCallIds: readonly string[];
  readonly opaqueContinuationHashes: readonly string[];
}

export interface AgentExecutionJournalStoreOptions {
  readonly beforePublishHead?: (
    head: AgentExecutionJournalHead,
    entry: AgentExecutionJournalEntry,
  ) => void | Promise<void>;
}

const HEAD_DIRECTORY = "agent-execution-journals";
const HEAD_SUFFIX = ".head.json";
const HEAD_MAX_BYTES = 64 * 1024;
const MAX_CHAIN_LENGTH = 1_000_000;
const MAX_JOURNAL_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_TOOL_RECORD_BYTES = 4 * 1024 * 1024;
const JOURNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/** Append-only, provider-neutral runtime checkpoints over immutable artifacts. */
export class AgentExecutionJournalStore {
  readonly artifactStore: ImmutableJsonArtifactStore;
  private readonly options: AgentExecutionJournalStoreOptions;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    store: ImmutableJsonArtifactStore | string,
    options: AgentExecutionJournalStoreOptions = {},
  ) {
    this.artifactStore = typeof store === "string" ? new ImmutableJsonArtifactStore(store) : store;
    this.options = options;
  }

  sink(journalId: string): AgentExecutionJournalSink {
    assertJournalId(journalId);
    return {
      journalId,
      checkpoint: async (checkpoint) => {
        await this.append(journalId, checkpoint);
      },
    };
  }

  async append(
    journalId: string,
    checkpoint: AgentExecutionCheckpoint,
  ): Promise<AgentExecutionJournalEntry> {
    assertJournalId(journalId);
    assertAgentExecutionCheckpoint(checkpoint);
    return this.serialize(journalId, async () => {
      const current = await this.readHead(journalId);
      if (current !== undefined) {
        const currentEntry = await this.artifactStore.read(
          current.entry,
          assertAgentExecutionJournalEntry,
        );
        if (
          currentEntry.journalId !== journalId ||
          currentEntry.sequence !== current.sequence ||
          currentEntry.hash !== current.entryHash
        )
          throw new Error("Agent execution journal head binding mismatch");
        if (currentEntry.checkpoint.checkpointType === "terminal")
          throw new Error("Agent execution journal is already terminal");
      }
      const sequence = (current?.sequence ?? 0) + 1;
      const draft = {
        kind: "AgentExecutionJournalEntry" as const,
        id: `agent_execution_checkpoint:${journalId}:${sequence}`,
        journalId,
        sequence,
        ...(current === undefined
          ? {}
          : { previousEntryHash: current.entryHash, previousEntry: current.entry }),
        checkpoint,
      };
      const entry: AgentExecutionJournalEntry = {
        ...draft,
        hash: contentHash(stableJson(draft)),
      };
      assertAgentExecutionJournalEntry(entry);
      const reference = await this.artifactStore.write(entry);
      const head: AgentExecutionJournalHead = {
        kind: "AgentExecutionJournalHead",
        journalId,
        sequence,
        entryHash: entry.hash,
        entry: reference,
        updatedAt: checkpoint.occurredAt,
      };
      assertAgentExecutionJournalHead(head);
      await this.options.beforePublishHead?.(head, entry);
      await this.writeHead(head);
      return entry;
    });
  }

  async load(journalId: string): Promise<LoadedAgentExecutionJournal> {
    assertJournalId(journalId);
    const head = await this.readHead(journalId);
    if (head === undefined) throw new Error(`Agent execution journal is missing: ${journalId}`);
    const reverse: AgentExecutionJournalEntry[] = [];
    const visited = new Set<string>();
    let expectedSequence = head.sequence;
    let expectedHash = head.entryHash;
    let reference: ArtifactReference | undefined = head.entry;
    while (reference !== undefined) {
      if (reverse.length >= MAX_CHAIN_LENGTH)
        throw new Error("Agent execution journal exceeds maximum chain length");
      if (visited.has(reference.artifactHash))
        throw new Error("Agent execution journal contains an artifact cycle");
      visited.add(reference.artifactHash);
      const entry: AgentExecutionJournalEntry = await this.artifactStore.read(
        reference,
        assertAgentExecutionJournalEntry,
      );
      if (
        entry.journalId !== journalId ||
        entry.sequence !== expectedSequence ||
        entry.hash !== expectedHash
      )
        throw new Error("Agent execution journal chain binding mismatch");
      reverse.push(entry);
      expectedSequence -= 1;
      expectedHash = entry.previousEntryHash ?? "";
      reference = entry.previousEntry;
    }
    if (expectedSequence !== 0 || expectedHash !== "")
      throw new Error("Agent execution journal chain ended before its genesis");
    const entries = reverse.reverse();
    assertCheckpointOrder(entries);
    return { head, entries };
  }

  /** Read-only admission check used before dispatch and during restart. */
  async loadIfPresent(journalId: string): Promise<LoadedAgentExecutionJournal | undefined> {
    assertJournalId(journalId);
    const head = await this.readHead(journalId);
    return head === undefined ? undefined : this.load(journalId);
  }

  private async readHead(journalId: string): Promise<AgentExecutionJournalHead | undefined> {
    await this.ensureHeadDirectory();
    try {
      const descriptor = await open(
        this.headPath(journalId),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await descriptor.stat();
        if (!info.isFile() || info.size <= 0 || info.size > HEAD_MAX_BYTES)
          throw new Error("Agent execution journal head is not a bounded regular file");
        const serialized = await descriptor.readFile({ encoding: "utf8" });
        let parsed: unknown;
        try {
          parsed = JSON.parse(serialized) as unknown;
        } catch {
          throw new Error("Agent execution journal head is not valid JSON");
        }
        if (`${stableJson(parsed)}\n` !== serialized)
          throw new Error("Agent execution journal head JSON is not canonical");
        assertAgentExecutionJournalHead(parsed);
        return parsed;
      } finally {
        await descriptor.close();
      }
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async writeHead(head: AgentExecutionJournalHead): Promise<void> {
    await this.ensureHeadDirectory();
    const destination = this.headPath(head.journalId);
    await assertReplaceableRegularFile(destination);
    const temporary = join(
      this.artifactStore.root,
      HEAD_DIRECTORY,
      `.${basename(destination)}.${randomUUID()}.tmp`,
    );
    const descriptor = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await descriptor.writeFile(`${stableJson(head)}\n`, { encoding: "utf8" });
      await descriptor.chmod(0o600);
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    try {
      await rename(temporary, destination);
      await syncDirectory(join(this.artifactStore.root, HEAD_DIRECTORY));
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  }

  private async ensureHeadDirectory(): Promise<void> {
    try {
      await mkdir(this.artifactStore.root, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const root = await lstat(this.artifactStore.root);
    if (root.isSymbolicLink() || !root.isDirectory())
      throw new Error("Unsafe agent execution journal root");
    const directory = join(this.artifactStore.root, HEAD_DIRECTORY);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Unsafe agent execution journal head directory");
  }

  private headPath(journalId: string): string {
    assertJournalId(journalId);
    return join(this.artifactStore.root, HEAD_DIRECTORY, `${journalId}${HEAD_SUFFIX}`);
  }

  private async serialize<T>(journalId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(journalId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(journalId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(journalId) === tail) this.tails.delete(journalId);
    }
  }
}

/**
 * Classifies an interrupted chain without authorizing a replay of its most
 * recent provider intent. A durable response is safe to consume because its
 * assistant/tool data is canonical JSON; opaque provider continuation state is
 * deliberately never part of that reconstruction.
 */
export function assessAgentExecutionJournalRecovery(
  journal: LoadedAgentExecutionJournal,
): AgentExecutionJournalRecovery {
  const terminal = lastJournalCheckpoint(journal.entries, "terminal");
  if (terminal !== undefined) return { kind: "terminal", automaticProviderDispatchAllowed: false };
  const latestIntent = lastJournalCheckpoint(journal.entries, "request_intent");
  if (latestIntent === undefined)
    throw new Error("Agent execution journal has no request intent or terminal boundary");
  const response = lastJournalCheckpoint(
    journal.entries,
    "response_received",
    latestIntent.turnSequence,
  );
  if (response === undefined)
    return {
      kind: "provider_outcome_unknown",
      turnSequence: latestIntent.turnSequence,
      intentHash: latestIntent.intentHash,
      exactSafeCreatorAction: "retry_work",
      rule: "explicit_creator_authorized_retry_work_required",
      automaticProviderDispatchAllowed: false,
    };
  const pendingTool = pendingToolExecution(journal.entries, latestIntent.turnSequence);
  if (pendingTool !== undefined)
    return {
      kind: "tool_outcome_unknown",
      turnSequence: latestIntent.turnSequence,
      responseHash:
        pendingTool.responseHash ??
        (response.result.kind === "assistant"
          ? response.result.responseHash
          : contentHash(stableJson(response.result))),
      toolCallId: pendingTool.toolCall.id,
      exactSafeCreatorAction: "retry_work",
      rule: "explicit_creator_authorized_retry_work_required",
      automaticProviderDispatchAllowed: false,
    };
  return {
    kind: "response_ready",
    turnSequence: latestIntent.turnSequence,
    responseHash: response.result.kind === "assistant" ? response.result.responseHash : null,
    exactSafeCreatorAction: "resume_work",
    rule: "persisted_response_must_be_consumed_before_any_new_provider_turn",
    automaticProviderDispatchAllowed: false,
  };
}

/** Builds an immutable replay plan only for an already received safe boundary. */
export function createAgentExecutionJournalResume(
  journal: LoadedAgentExecutionJournal,
): AgentExecutionJournalResume {
  const recovery = assessAgentExecutionJournalRecovery(journal);
  if (recovery.kind !== "response_ready")
    throw new Error(
      `Agent execution journal cannot resume this boundary (${recovery.kind}); ${
        "exactSafeCreatorAction" in recovery ? recovery.exactSafeCreatorAction : "no action"
      } is required`,
    );
  const request = lastJournalCheckpoint(journal.entries, "request_intent", recovery.turnSequence);
  const response = lastJournalCheckpoint(
    journal.entries,
    "response_received",
    recovery.turnSequence,
  );
  if (!request || !response) throw new Error("Resumable journal lost its exact response binding");
  const batch = lastJournalCheckpoint(journal.entries, "batch_validated", recovery.turnSequence);
  const state =
    lastJournalCheckpoint(journal.entries, "tool_completed", recovery.turnSequence)?.state ??
    batch?.state ??
    response.state;
  const toolCalls = journal.entries
    .map((entry) => entry.checkpoint)
    .filter(
      (
        checkpoint,
      ): checkpoint is Extract<AgentExecutionCheckpoint, { checkpointType: "tool_completed" }> =>
        checkpoint.checkpointType === "tool_completed",
    )
    .map((checkpoint) => copyJson(checkpoint.toolCall));
  const modelTurns = journal.entries
    .map((entry) => entry.checkpoint)
    .filter(
      (
        checkpoint,
      ): checkpoint is Extract<AgentExecutionCheckpoint, { checkpointType: "response_received" }> =>
        checkpoint.checkpointType === "response_received",
    )
    .map((checkpoint) => copyJson(checkpoint.turn));
  const opaqueContinuationHashes = journal.entries
    .map((entry) => entry.checkpoint)
    .filter(
      (
        checkpoint,
      ): checkpoint is Extract<AgentExecutionCheckpoint, { checkpointType: "response_received" }> =>
        checkpoint.checkpointType === "response_received" &&
        checkpoint.result.kind === "assistant" &&
        checkpoint.result.message.continuation.present,
    )
    .map((checkpoint) =>
      checkpoint.result.kind === "assistant" && checkpoint.result.message.continuation.present
        ? checkpoint.result.message.continuation.hash
        : "",
    )
    .filter((hash) => hash.length > 0)
    .sort();
  return {
    kind: "AgentExecutionJournalResume",
    journalId: journal.head.journalId,
    turnSequence: recovery.turnSequence,
    intentHash: request.intentHash,
    request: copyJson(request.request),
    response: copyJson(response.result),
    state: copyJson(state),
    modelTurns,
    toolCalls,
    ...(batch === undefined ? {} : { batch: copyJson(batch) }),
    completedToolCallIds: journal.entries
      .map((entry) => entry.checkpoint)
      .filter(
        (
          checkpoint,
        ): checkpoint is Extract<AgentExecutionCheckpoint, { checkpointType: "tool_completed" }> =>
          checkpoint.checkpointType === "tool_completed" &&
          checkpoint.turnSequence === recovery.turnSequence,
      )
      .map((checkpoint) => checkpoint.toolCall.toolCallId),
    opaqueContinuationHashes,
  };
}

function pendingToolExecution(
  entries: readonly AgentExecutionJournalEntry[],
  turnSequence: number,
): Extract<AgentExecutionCheckpoint, { checkpointType: "tool_execution_intent" }> | undefined {
  let pending:
    Extract<AgentExecutionCheckpoint, { checkpointType: "tool_execution_intent" }> | undefined;
  for (const entry of entries) {
    const checkpoint = entry.checkpoint;
    if (
      checkpoint.checkpointType === "tool_execution_intent" &&
      checkpoint.turnSequence === turnSequence
    )
      pending = checkpoint;
    else if (
      checkpoint.checkpointType === "tool_completed" &&
      checkpoint.turnSequence === turnSequence &&
      pending?.toolCall.id === checkpoint.toolCall.toolCallId
    )
      pending = undefined;
  }
  return pending;
}

function lastJournalCheckpoint<T extends AgentExecutionCheckpoint["checkpointType"]>(
  entries: readonly AgentExecutionJournalEntry[],
  checkpointType: T,
  turnSequence?: number,
): Extract<AgentExecutionCheckpoint, { checkpointType: T }> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const checkpoint = entries[index]!.checkpoint;
    if (
      checkpoint.checkpointType === checkpointType &&
      (turnSequence === undefined ||
        ("turnSequence" in checkpoint && checkpoint.turnSequence === turnSequence))
    )
      return checkpoint as Extract<AgentExecutionCheckpoint, { checkpointType: T }>;
  }
  return undefined;
}

export function createRequestIntentCheckpoint(
  turnSequence: number,
  occurredAt: string,
  request: ModelTurnRequest,
  state: AgentExecutionBoundaryState,
): Extract<AgentExecutionCheckpoint, { checkpointType: "request_intent" }> {
  const sanitized: JournalModelRequest = {
    model: request.model,
    requestSizes: measureRequestSizes(request),
    systemHash: contentHash(request.system),
    messages: request.messages.map(sanitizeModelMessage),
    tools: request.tools.map((tool) => ({ ...tool })),
    maxOutputTokens: request.maxOutputTokens,
    timeoutMs: request.timeoutMs,
  };
  const checkpoint = {
    checkpointType: "request_intent" as const,
    turnSequence,
    occurredAt,
    intentHash: contentHash(stableJson(sanitized)),
    request: sanitized,
    state: copyJson(state),
  };
  assertAgentExecutionCheckpoint(checkpoint);
  return checkpoint;
}

export function createResponseReceivedCheckpoint(input: {
  readonly turnSequence: number;
  readonly occurredAt: string;
  readonly intentHash: string;
  readonly result: ModelTurnResult;
  readonly state: AgentExecutionBoundaryState;
  readonly turn: AgentModelTurn;
}): Extract<AgentExecutionCheckpoint, { checkpointType: "response_received" }> {
  const common = {
    providerRequestHash: input.result.requestHash,
    ...(input.result.providerMetadataHash === undefined
      ? {}
      : { providerMetadataHash: input.result.providerMetadataHash }),
    responseFacts: { ...input.result.responseFacts },
    usage: { ...input.result.usage },
  };
  const sanitized: JournalModelResult =
    input.result.kind === "assistant"
      ? {
          kind: "assistant",
          message: sanitizeAssistantMessage(input.result.message),
          stopReason: input.result.stopReason,
          responseHash: input.result.responseHash,
          ...common,
        }
      : {
          kind: input.result.kind,
          errorClass: input.result.errorClass,
          message: input.result.message,
          ...(input.result.kind === "provider_error" ? { retryable: input.result.retryable } : {}),
          ...common,
        };
  const checkpoint = {
    checkpointType: "response_received" as const,
    turnSequence: input.turnSequence,
    occurredAt: input.occurredAt,
    intentHash: input.intentHash,
    result: sanitized,
    state: copyJson(input.state),
    turn: copyJson(input.turn),
  };
  assertAgentExecutionCheckpoint(checkpoint);
  return checkpoint;
}

export function createBatchValidatedCheckpoint(input: {
  turnSequence: number;
  occurredAt: string;
  intentHash: string;
  responseHash: string;
  calls: Extract<ModelMessage, { role: "assistant" }>["toolCalls"];
  decision: ToolBatchDecision;
  state: AgentExecutionBoundaryState;
}): Extract<AgentExecutionCheckpoint, { checkpointType: "batch_validated" }> {
  const checkpoint = {
    checkpointType: "batch_validated" as const,
    turnSequence: input.turnSequence,
    occurredAt: input.occurredAt,
    intentHash: input.intentHash,
    responseHash: input.responseHash,
    calls: input.calls.map((call) => ({
      id: call.id,
      name: call.name,
      inputHash: contentHash(stableJson(call.arguments)),
    })),
    decision: {
      valid: input.decision.valid,
      budgetExhausted: input.decision.budgetExhausted,
      feedback: input.decision.feedback.map((feedback) => ({
        id: feedback.id,
        name: feedback.name,
        result: copyJson(feedback.result),
      })),
    },
    state: copyJson(input.state),
  };
  assertAgentExecutionCheckpoint(checkpoint);
  return checkpoint;
}

export function createToolCompletedCheckpoint(input: {
  turnSequence: number;
  occurredAt: string;
  intentHash: string;
  responseHash: string;
  toolCall: ToolCallRecord;
  state: AgentExecutionBoundaryState;
}): Extract<AgentExecutionCheckpoint, { checkpointType: "tool_completed" }> {
  const checkpoint = {
    checkpointType: "tool_completed" as const,
    turnSequence: input.turnSequence,
    occurredAt: input.occurredAt,
    intentHash: input.intentHash,
    responseHash: input.responseHash,
    toolCall: copyJson(input.toolCall),
    state: copyJson(input.state),
  };
  assertAgentExecutionCheckpoint(checkpoint);
  return checkpoint;
}

export function createToolExecutionIntentCheckpoint(input: {
  turnSequence: number;
  occurredAt: string;
  intentHash: string;
  responseHash: string;
  toolCall: Extract<ModelMessage, { role: "assistant" }>["toolCalls"][number];
  state: AgentExecutionBoundaryState;
}): Extract<AgentExecutionCheckpoint, { checkpointType: "tool_execution_intent" }> {
  const checkpoint = {
    checkpointType: "tool_execution_intent" as const,
    turnSequence: input.turnSequence,
    occurredAt: input.occurredAt,
    intentHash: input.intentHash,
    responseHash: input.responseHash,
    toolCall: {
      id: input.toolCall.id,
      name: input.toolCall.name,
      inputHash: contentHash(stableJson(input.toolCall.arguments)),
    },
    state: copyJson(input.state),
  };
  assertAgentExecutionCheckpoint(checkpoint);
  return checkpoint;
}

export function createTerminalCheckpoint(
  occurredAt: string,
  result: AgentRuntimeResult,
  opaqueContinuationHashes: readonly string[],
): Extract<AgentExecutionCheckpoint, { checkpointType: "terminal" }> {
  const hashes = [...new Set(opaqueContinuationHashes)].sort();
  const checkpoint = {
    checkpointType: "terminal" as const,
    occurredAt,
    result: copyJson(result),
    continuationBoundary:
      hashes.length === 0
        ? ({ kind: "not_required" } as const)
        : ({
            kind: "opaque_continuation_not_persisted" as const,
            hashes,
            rule: "explicit_new_agent_run_required_for_any_further_provider_turn" as const,
          } as const),
  };
  assertAgentExecutionCheckpoint(checkpoint);
  return checkpoint;
}

export function assertAgentExecutionCheckpoint(
  value: unknown,
): asserts value is AgentExecutionCheckpoint {
  const record = asRecord(value, "Invalid agent execution checkpoint");
  assertIso(record.occurredAt, "checkpoint occurredAt");
  if (typeof record.checkpointType !== "string")
    throw new Error("Invalid agent execution checkpoint type");
  // Stable JSON also rejects functions, cycles, bigint, and undefined-bearing
  // payloads before they can enter the durable provider-neutral record.
  assertBoundedJournalJson(record, MAX_JOURNAL_CHECKPOINT_BYTES, "journal checkpoint");
  switch (record.checkpointType) {
    case "request_intent":
      assertPositiveInteger(record.turnSequence, "request intent turn sequence");
      assertHash(record.intentHash, "request intent hash");
      assertJournalModelRequest(record.request);
      assertAgentExecutionBoundaryState(record.state);
      if (contentHash(stableJson(record.request)) !== record.intentHash)
        throw new Error("Agent request intent hash mismatch");
      break;
    case "response_received":
      assertPositiveInteger(record.turnSequence, "response turn sequence");
      assertHash(record.intentHash, "response intent hash");
      assertJournalModelResult(record.result);
      assertAgentExecutionBoundaryState(record.state);
      assertAgentModelTurn(record.turn);
      assertBoundedJournalJson(record.result, MAX_JOURNAL_RESPONSE_BYTES, "journal response");
      assertResponseTurnConsistency(
        record.turnSequence as number,
        record.result as JournalModelResult,
        record.turn as AgentModelTurn,
      );
      break;
    case "batch_validated":
      assertPositiveInteger(record.turnSequence, "batch turn sequence");
      assertHash(record.intentHash, "batch intent hash");
      assertHash(record.responseHash, "batch response hash");
      if (!Array.isArray(record.calls)) throw new Error("Invalid journal batch calls");
      for (const call of record.calls) {
        const callRecord = asRecord(call, "Invalid journal batch call");
        assertNonEmptyString(callRecord.id, "journal batch call ID");
        assertNonEmptyString(callRecord.name, "journal batch call name");
        assertHash(callRecord.inputHash, "journal batch call input hash");
      }
      assertToolBatchDecision(record.decision);
      assertAgentExecutionBoundaryState(record.state);
      break;
    case "tool_completed":
      assertPositiveInteger(record.turnSequence, "tool turn sequence");
      assertHash(record.intentHash, "tool intent hash");
      assertHash(record.responseHash, "tool response hash");
      assertToolCallRecord(record.toolCall);
      assertAgentExecutionBoundaryState(record.state);
      assertBoundedJournalJson(
        record.toolCall,
        MAX_JOURNAL_TOOL_RECORD_BYTES,
        "journal tool record",
      );
      break;
    case "tool_execution_intent": {
      assertPositiveInteger(record.turnSequence, "tool intent turn sequence");
      assertHash(record.intentHash, "tool intent request hash");
      assertHash(record.responseHash, "tool intent response hash");
      const toolCall = asRecord(record.toolCall, "Invalid journal tool execution intent");
      assertNonEmptyString(toolCall.id, "journal tool intent ID");
      assertNonEmptyString(toolCall.name, "journal tool intent name");
      assertHash(toolCall.inputHash, "journal tool intent input hash");
      assertAgentExecutionBoundaryState(record.state);
      break;
    }
    case "terminal":
      assertAgentRuntimeResult(record.result);
      assertContinuationBoundary(record.continuationBoundary);
      break;
    default:
      throw new Error("Unknown agent execution checkpoint type");
  }
}

export function assertAgentExecutionJournalEntry(
  value: unknown,
): asserts value is AgentExecutionJournalEntry {
  const record = asRecord(value, "Invalid agent execution journal entry");
  if (record.kind !== "AgentExecutionJournalEntry")
    throw new Error("Invalid agent execution journal entry kind");
  assertJournalId(record.journalId);
  assertPositiveInteger(record.sequence, "journal entry sequence");
  if (record.id !== `agent_execution_checkpoint:${record.journalId}:${record.sequence}`)
    throw new Error("Invalid agent execution journal entry ID");
  assertHash(record.hash, "journal entry hash");
  if (record.sequence === 1) {
    if (record.previousEntry !== undefined || record.previousEntryHash !== undefined)
      throw new Error("Journal genesis cannot have a predecessor");
  } else {
    assertHash(record.previousEntryHash, "previous journal entry hash");
    assertArtifactReference(record.previousEntry);
  }
  assertAgentExecutionCheckpoint(record.checkpoint);
  const { hash: _hash, ...draft } = record;
  if (contentHash(stableJson(draft)) !== record.hash)
    throw new Error("Agent execution journal entry hash mismatch");
}

export function assertAgentExecutionJournalHead(
  value: unknown,
): asserts value is AgentExecutionJournalHead {
  const record = asRecord(value, "Invalid agent execution journal head");
  if (record.kind !== "AgentExecutionJournalHead")
    throw new Error("Invalid agent execution journal head kind");
  assertJournalId(record.journalId);
  assertPositiveInteger(record.sequence, "journal head sequence");
  assertHash(record.entryHash, "journal head entry hash");
  assertArtifactReference(record.entry);
  assertIso(record.updatedAt, "journal head updatedAt");
}

function sanitizeModelMessage(message: ModelMessage): JournalModelMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        name: message.name,
        content: message.content,
      };
    case "assistant":
      return sanitizeAssistantMessage(message);
  }
}

function sanitizeAssistantMessage(
  message: Extract<ModelMessage, { role: "assistant" }>,
): Extract<JournalModelMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: message.content,
    toolCalls: message.toolCalls.map((call) => ({ ...call })),
    continuation:
      message.continuation === undefined
        ? { present: false }
        : {
            present: true,
            transport: message.continuation.transport,
            hash: message.continuation.hash,
            bytes: message.continuation.bytes,
          },
  };
}

function assertCheckpointOrder(entries: readonly AgentExecutionJournalEntry[]): void {
  let terminal = false;
  let previousTurn = 0;
  const intents = new Map<number, string>();
  const responses = new Map<
    number,
    {
      responseHash: string | null;
      calls: readonly { readonly id: string; readonly name: string; readonly inputHash: string }[];
    }
  >();
  const validated = new Map<number, boolean>();
  const completedCallIds = new Set<string>();
  const activeToolExecution = new Map<
    number,
    { readonly id: string; readonly name: string; readonly inputHash: string }
  >();
  const opaqueContinuationHashes = new Set<string>();
  for (const entry of entries) {
    const checkpoint = entry.checkpoint;
    if (terminal) throw new Error("Agent execution journal contains evidence after terminal");
    switch (checkpoint.checkpointType) {
      case "request_intent":
        if (
          checkpoint.turnSequence <= previousTurn ||
          intents.has(checkpoint.turnSequence) ||
          activeToolExecution.size > 0
        )
          throw new Error("Agent execution journal request intents are unordered");
        intents.set(checkpoint.turnSequence, checkpoint.intentHash);
        previousTurn = checkpoint.turnSequence;
        break;
      case "response_received":
        if (
          intents.get(checkpoint.turnSequence) !== checkpoint.intentHash ||
          responses.has(checkpoint.turnSequence)
        )
          throw new Error("Agent execution response has no exact request intent");
        if (checkpoint.result.kind === "assistant") {
          const continuation = checkpoint.result.message.continuation;
          if (continuation.present) opaqueContinuationHashes.add(continuation.hash);
          responses.set(checkpoint.turnSequence, {
            responseHash: checkpoint.result.responseHash,
            calls: checkpoint.result.message.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              inputHash: contentHash(stableJson(call.arguments)),
            })),
          });
        } else {
          responses.set(checkpoint.turnSequence, {
            responseHash: null,
            calls: [],
          });
        }
        break;
      case "batch_validated": {
        const response = responses.get(checkpoint.turnSequence);
        if (
          intents.get(checkpoint.turnSequence) !== checkpoint.intentHash ||
          response?.responseHash !== checkpoint.responseHash ||
          validated.has(checkpoint.turnSequence)
        )
          throw new Error("Agent execution batch has no exact response");
        if (stableJson(checkpoint.calls) !== stableJson(response.calls))
          throw new Error("Agent execution batch calls do not match its response");
        validated.set(checkpoint.turnSequence, checkpoint.decision.valid);
        break;
      }
      case "tool_execution_intent": {
        const response = responses.get(checkpoint.turnSequence);
        const matchingCall = response?.calls.find(
          (call) =>
            call.id === checkpoint.toolCall.id &&
            call.name === checkpoint.toolCall.name &&
            call.inputHash === checkpoint.toolCall.inputHash,
        );
        if (
          intents.get(checkpoint.turnSequence) !== checkpoint.intentHash ||
          response?.responseHash !== checkpoint.responseHash ||
          validated.get(checkpoint.turnSequence) !== true ||
          !matchingCall ||
          activeToolExecution.has(checkpoint.turnSequence) ||
          completedCallIds.has(checkpoint.toolCall.id)
        )
          throw new Error("Agent tool execution intent has no exact validated batch");
        activeToolExecution.set(checkpoint.turnSequence, checkpoint.toolCall);
        break;
      }
      case "tool_completed": {
        const response = responses.get(checkpoint.turnSequence);
        const matchingCall = response?.calls.find(
          (call) =>
            call.id === checkpoint.toolCall.toolCallId &&
            call.name === checkpoint.toolCall.name &&
            call.inputHash === checkpoint.toolCall.inputHash,
        );
        const active = activeToolExecution.get(checkpoint.turnSequence);
        if (
          intents.get(checkpoint.turnSequence) !== checkpoint.intentHash ||
          !validated.has(checkpoint.turnSequence) ||
          !matchingCall ||
          completedCallIds.has(checkpoint.toolCall.toolCallId) ||
          (validated.get(checkpoint.turnSequence) &&
            (checkpoint.toolCall.disposition !== "executed" ||
              active?.id !== checkpoint.toolCall.toolCallId ||
              active.name !== checkpoint.toolCall.name ||
              active.inputHash !== checkpoint.toolCall.inputHash)) ||
          (!validated.get(checkpoint.turnSequence) &&
            (checkpoint.toolCall.disposition !== "rejected" || active !== undefined))
        )
          throw new Error("Agent tool completion has no exact validated batch");
        completedCallIds.add(checkpoint.toolCall.toolCallId);
        activeToolExecution.delete(checkpoint.turnSequence);
        break;
      }
      case "terminal":
        if (activeToolExecution.size > 0)
          throw new Error("Agent execution journal terminal follows an unknown tool outcome");
        if (checkpoint.continuationBoundary.kind === "not_required") {
          if (opaqueContinuationHashes.size > 0)
            throw new Error("Terminal journal omitted opaque-continuation boundary");
        } else if (
          stableJson(checkpoint.continuationBoundary.hashes) !==
          stableJson([...opaqueContinuationHashes].sort())
        ) {
          throw new Error("Terminal continuation boundary does not match received responses");
        }
        terminal = true;
        break;
    }
  }
}

function assertJournalModelRequest(value: unknown): void {
  const record = asRecord(value, "Invalid journal model request");
  assertNonEmptyString(record.model, "journal requested model");
  assertHash(record.systemHash, "journal system prompt hash");
  const sizes = asRecord(record.requestSizes, "Invalid request size breakdown");
  for (const field of ["systemInstructions", "conversation", "toolSchemas", "toolResults"])
    if (!Number.isSafeInteger(sizes[field]) || Number(sizes[field]) < 0)
      throw new Error(`Invalid request size ${field}`);
  if (!Array.isArray(record.messages)) throw new Error("Invalid journal request messages");
  for (const message of record.messages) assertJournalModelMessage(message);
  if (!Array.isArray(record.tools)) throw new Error("Invalid journal request tools");
  for (const tool of record.tools) {
    const toolRecord = asRecord(tool, "Invalid journal tool definition");
    assertNonEmptyString(toolRecord.name, "journal tool name");
    if (typeof toolRecord.description !== "string")
      throw new Error("Invalid journal tool description");
    if (!("parameters" in toolRecord)) throw new Error("Journal tool parameters are missing");
  }
  assertPositiveInteger(record.maxOutputTokens, "journal request output-token limit");
  assertPositiveInteger(record.timeoutMs, "journal request timeout");
}

function assertAgentExecutionBoundaryState(value: unknown): void {
  const record = asRecord(value, "Invalid agent execution boundary state");
  assertIso(record.runtimeStartedAt, "boundary runtime startedAt");
  const usage = asRecord(record.usage, "Invalid boundary cumulative usage");
  if (!Number.isSafeInteger(usage.turns) || (usage.turns as number) < 0)
    throw new Error("Invalid boundary cumulative turns");
  assertModelUsage(usage);
  if (typeof record.trialStarted !== "boolean")
    throw new Error("Invalid boundary trial-started flag");
  const remaining = asRecord(record.remaining, "Invalid boundary remaining budgets");
  for (const key of ["turns", "toolCalls", "toolResultBytes", "durationMs"]) {
    const amount = remaining[key];
    if (!Number.isSafeInteger(amount) || (amount as number) < 0)
      throw new Error(`Invalid boundary remaining ${key}`);
  }
  for (const key of ["inputTokens", "outputTokens"]) {
    const amount = remaining[key];
    if (amount !== null && (!Number.isSafeInteger(amount) || (amount as number) < 0))
      throw new Error(`Invalid boundary remaining ${key}`);
  }
  if (
    remaining.budgetUsd !== null &&
    (typeof remaining.budgetUsd !== "number" ||
      !Number.isFinite(remaining.budgetUsd) ||
      remaining.budgetUsd < 0)
  )
    throw new Error("Invalid boundary remaining budgetUsd");
  if (!Array.isArray(record.seenToolCallIds))
    throw new Error("Invalid boundary seen tool-call IDs");
  const seen = record.seenToolCallIds.map((id) => {
    assertNonEmptyString(id, "boundary seen tool-call ID");
    return id;
  });
  if (stableJson(seen) !== stableJson([...new Set(seen)].sort()))
    throw new Error("Boundary seen tool-call IDs are not canonical");
  assertRepeatCounters(record.rejectedBatchRepeats, "rejected batch");
  assertRepeatCounters(record.noProgressBatchRepeats, "no-progress batch");
  if (
    !Number.isSafeInteger(record.prematureCompletionRepairs) ||
    (record.prematureCompletionRepairs as number) < 0
  )
    throw new Error("Invalid boundary completion-repair count");
  if (record.toolHostProgressTokenHash !== null)
    assertHash(record.toolHostProgressTokenHash, "boundary progress-token hash");
  for (const key of ["materializedToolCalls", "materializedToolResultBytes"]) {
    const amount = record[key];
    if (!Number.isSafeInteger(amount) || (amount as number) < 0)
      throw new Error(`Invalid boundary ${key}`);
  }
}

function assertAgentModelTurn(value: unknown): void {
  const record = asRecord(value, "Invalid journal model turn");
  assertPositiveInteger(record.sequence, "journal model turn sequence");
  assertIso(record.startedAt, "journal model turn startedAt");
  assertIso(record.endedAt, "journal model turn endedAt");
  if (
    !Number.isSafeInteger(record.durationMs) ||
    (record.durationMs as number) < 0 ||
    Date.parse(record.endedAt as string) - Date.parse(record.startedAt as string) !==
      record.durationMs
  )
    throw new Error("Invalid journal model turn duration");
  assertHash(record.requestHash, "journal model turn request hash");
  if (!Array.isArray(record.toolCallIds))
    throw new Error("Invalid journal model turn tool-call IDs");
  for (const id of record.toolCallIds) assertUntrustedToolLabel(id);
  assertModelUsage(record.usage);
  const sizes = asRecord(record.requestSizes, "Invalid journal request sizes");
  for (const key of ["systemInstructions", "conversation", "toolSchemas", "toolResults"])
    if (!Number.isSafeInteger(sizes[key]) || (sizes[key] as number) < 0)
      throw new Error(`Invalid journal request size ${key}`);
  if (
    !["assistant", "invalid_model_response", "provider_error"].includes(String(record.resultKind))
  )
    throw new Error("Invalid journal model turn result kind");
  if (record.responseHash !== undefined)
    assertHash(record.responseHash, "journal model turn response hash");
  if (record.providerMetadataHash !== undefined)
    assertHash(record.providerMetadataHash, "journal model turn provider metadata hash");
  if (
    record.stopReason !== undefined &&
    !["end_turn", "tool_calls", "max_tokens", "refusal", "other"].includes(
      String(record.stopReason),
    )
  )
    throw new Error("Invalid journal model turn stop reason");
  if (record.responseFacts !== undefined) assertModelResponseFacts(record.responseFacts);
  if (record.errorClass !== undefined)
    assertNonEmptyString(record.errorClass, "journal model turn error class");
}

function assertResponseTurnConsistency(
  turnSequence: number,
  result: JournalModelResult,
  turn: AgentModelTurn,
): void {
  if (
    turn.sequence !== turnSequence ||
    turn.requestHash !== result.providerRequestHash ||
    turn.resultKind !== result.kind ||
    stableJson(turn.usage) !== stableJson(result.usage) ||
    turn.responseFacts === undefined ||
    stableJson(turn.responseFacts) !== stableJson(result.responseFacts)
  )
    throw new Error("Journal response turn does not match its provider-neutral response");
  if (result.kind === "assistant") {
    if (
      turn.responseHash !== result.responseHash ||
      turn.stopReason !== result.stopReason ||
      stableJson(turn.toolCallIds) !== stableJson(result.message.toolCalls.map((call) => call.id))
    )
      throw new Error("Journal assistant turn does not match its received response");
    return;
  }
  if (turn.errorClass !== result.errorClass || turn.toolCallIds.length !== 0)
    throw new Error("Journal provider failure turn does not match its received response");
}

function assertRepeatCounters(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label} repeat counters`);
  const counters = value.map((counter) => {
    const record = asRecord(counter, `Invalid ${label} repeat counter`);
    assertHash(record.fingerprint, `${label} fingerprint`);
    assertPositiveInteger(record.count, `${label} repeat count`);
    return { fingerprint: record.fingerprint, count: record.count };
  });
  const canonical = [...counters].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
  if (
    stableJson(counters) !== stableJson(canonical) ||
    new Set(counters.map((counter) => counter.fingerprint)).size !== counters.length
  )
    throw new Error(`${label} repeat counters are not canonical`);
}

function assertJournalModelMessage(value: unknown): void {
  const record = asRecord(value, "Invalid journal model message");
  if (record.role === "user") {
    if (typeof record.content !== "string") throw new Error("Invalid journal user message");
    return;
  }
  if (record.role === "tool") {
    assertNonEmptyString(record.toolCallId, "journal tool message call ID");
    assertNonEmptyString(record.name, "journal tool message name");
    if (typeof record.content !== "string") throw new Error("Invalid journal tool message");
    return;
  }
  if (record.role !== "assistant" || typeof record.content !== "string")
    throw new Error("Invalid journal assistant message");
  if (!Array.isArray(record.toolCalls)) throw new Error("Invalid journal assistant tool calls");
  for (const call of record.toolCalls) {
    const callRecord = asRecord(call, "Invalid journal assistant tool call");
    assertUntrustedToolLabel(callRecord.id);
    assertUntrustedToolLabel(callRecord.name);
    if (!("arguments" in callRecord)) throw new Error("Journal tool-call arguments are missing");
  }
  const continuation = asRecord(record.continuation, "Invalid journal continuation descriptor");
  if (continuation.present === false) {
    if (Object.keys(continuation).length !== 1)
      throw new Error("Absent continuation descriptor contains unexpected material");
    return;
  }
  if (continuation.present !== true)
    throw new Error("Invalid journal continuation presence descriptor");
  if ("payload" in continuation)
    throw new Error("Opaque model continuation payload cannot enter an execution journal");
  assertNonEmptyString(continuation.transport, "journal continuation transport");
  assertHash(continuation.hash, "journal continuation hash");
  assertPositiveInteger(continuation.bytes, "journal continuation byte count");
  if (Object.keys(continuation).sort().join(",") !== "bytes,hash,present,transport")
    throw new Error("Continuation descriptor contains unexpected material");
}

function assertJournalModelResult(value: unknown): void {
  const record = asRecord(value, "Invalid journal model result");
  assertHash(record.providerRequestHash, "journal provider request hash");
  if (record.providerMetadataHash !== undefined)
    assertHash(record.providerMetadataHash, "journal provider metadata hash");
  assertModelUsage(record.usage);
  assertModelResponseFacts(record.responseFacts);
  if (record.kind === "assistant") {
    assertHash(record.responseHash, "journal response hash");
    assertJournalModelMessage(record.message);
    const message = record.message as Extract<JournalModelMessage, { role: "assistant" }>;
    const facts = record.responseFacts as ModelResponseFacts;
    if (
      message.continuation.present
        ? facts.continuationHash !== message.continuation.hash ||
          facts.continuationBytes !== message.continuation.bytes
        : facts.continuationHash !== null || facts.continuationBytes !== null
    )
      throw new Error("Journal continuation descriptor does not match provider response facts");
    if (
      !["end_turn", "tool_calls", "max_tokens", "refusal", "other"].includes(
        String(record.stopReason),
      )
    )
      throw new Error("Invalid journal model stop reason");
    return;
  }
  if (record.kind !== "invalid_model_response" && record.kind !== "provider_error")
    throw new Error("Invalid journal model result kind");
  assertNonEmptyString(record.errorClass, "journal model error class");
  if (typeof record.message !== "string") throw new Error("Invalid journal model error message");
  if (record.kind === "provider_error" && typeof record.retryable !== "boolean")
    throw new Error("Invalid journal provider retryability");
}

function assertModelResponseFacts(value: unknown): void {
  const record = asRecord(value, "Invalid journal model response facts");
  assertNonEmptyString(record.requestedModel, "journal response requested model");
  for (const key of ["resolvedModel", "servingProvider", "responseId", "finishReason"])
    if (record[key] !== null && typeof record[key] !== "string")
      throw new Error(`Invalid journal response ${key}`);
  if (!Number.isSafeInteger(record.latencyMs) || (record.latencyMs as number) < 0)
    throw new Error("Invalid journal response latency");
  if (record.retryCount !== 0) throw new Error("Invalid journal response retry count");
  if (record.continuationHash !== null)
    assertHash(record.continuationHash, "journal response continuation hash");
  if (
    record.continuationBytes !== null &&
    (!Number.isSafeInteger(record.continuationBytes) || (record.continuationBytes as number) <= 0)
  )
    throw new Error("Invalid journal response continuation byte count");
  if ((record.continuationHash === null) !== (record.continuationBytes === null))
    throw new Error("Journal continuation response facts are inconsistent");
}

function assertModelUsage(value: unknown): void {
  const record = asRecord(value, "Invalid journal model usage");
  for (const key of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ]) {
    const amount = record[key];
    if (amount !== null && (!Number.isSafeInteger(amount) || (amount as number) < 0))
      throw new Error(`Invalid journal usage ${key}`);
  }
  if (
    record.costUsd !== null &&
    (typeof record.costUsd !== "number" || !Number.isFinite(record.costUsd) || record.costUsd < 0)
  )
    throw new Error("Invalid journal usage costUsd");
}

function assertToolBatchDecision(value: unknown): void {
  const record = asRecord(value, "Invalid journal tool-batch decision");
  if (typeof record.valid !== "boolean" || typeof record.budgetExhausted !== "boolean")
    throw new Error("Invalid journal tool-batch disposition");
  if (!Array.isArray(record.feedback)) throw new Error("Invalid journal tool-batch feedback");
  for (const feedback of record.feedback) {
    const feedbackRecord = asRecord(feedback, "Invalid journal tool-batch feedback item");
    assertUntrustedToolLabel(feedbackRecord.id);
    assertUntrustedToolLabel(feedbackRecord.name);
    assertToolResult(feedbackRecord.result);
  }
}

function assertToolCallRecord(value: unknown): void {
  const record = asRecord(value, "Invalid journal tool-call record");
  assertPositiveInteger(record.sequence, "journal tool-call sequence");
  if (record.disposition === "rejected") assertUntrustedToolLabel(record.toolCallId);
  else assertNonEmptyString(record.toolCallId, "journal tool-call ID");
  if (record.disposition !== "executed" && record.disposition !== "rejected")
    throw new Error("Invalid journal tool-call disposition");
  if (record.disposition === "rejected") assertUntrustedToolLabel(record.name);
  else assertNonEmptyString(record.name, "journal tool-call name");
  assertHash(record.inputHash, "journal tool-call input hash");
  assertHash(record.resultHash, "journal tool-call result hash");
  if (typeof record.truncated !== "boolean") throw new Error("Invalid journal truncation flag");
  assertPositiveInteger(record.bytes, "journal tool-call byte count");
  assertIso(record.startedAt, "journal tool-call startedAt");
  assertIso(record.endedAt, "journal tool-call endedAt");
  if (!Number.isSafeInteger(record.durationMs) || (record.durationMs as number) < 0)
    throw new Error("Invalid journal tool-call duration");
  assertToolResult(record.result);
}

function assertUntrustedToolLabel(value: unknown): void {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Invalid bounded raw tool identifier");
}

function assertToolResult(value: unknown): void {
  const record = asRecord(value, "Invalid journal tool result");
  if (typeof record.ok !== "boolean" || typeof record.truncated !== "boolean")
    throw new Error("Invalid journal tool result disposition");
  assertHash(record.resultHash, "journal tool result hash");
  if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0)
    throw new Error("Invalid journal tool result byte count");
}

function assertAgentRuntimeResult(value: unknown): void {
  const record = asRecord(value, "Invalid journal terminal result");
  if (!["completed", "failed", "budget_exhausted"].includes(String(record.status)))
    throw new Error("Invalid journal terminal status");
  if (typeof record.trialStarted !== "boolean")
    throw new Error("Invalid journal terminal trial flag");
  assertModelUsage(record.usage);
  const timing = asRecord(record.timing, "Invalid journal terminal timing");
  assertIso(timing.startedAt, "journal terminal startedAt");
  assertIso(timing.endedAt, "journal terminal endedAt");
  if (!Number.isSafeInteger(timing.durationMs) || (timing.durationMs as number) < 0)
    throw new Error("Invalid journal terminal duration");
  if (!Array.isArray(record.turns) || !Array.isArray(record.toolCalls))
    throw new Error("Invalid journal terminal evidence arrays");
  for (const toolCall of record.toolCalls) assertToolCallRecord(toolCall);
}

function assertContinuationBoundary(value: unknown): void {
  const record = asRecord(value, "Invalid journal continuation boundary");
  if (record.kind === "not_required") return;
  if (
    record.kind !== "opaque_continuation_not_persisted" ||
    record.rule !== "explicit_new_agent_run_required_for_any_further_provider_turn" ||
    !Array.isArray(record.hashes) ||
    record.hashes.length === 0
  )
    throw new Error("Invalid journal continuation boundary");
  const hashes = record.hashes.map((hash) => {
    assertHash(hash, "journal continuation-boundary hash");
    return hash;
  });
  if (stableJson(hashes) !== stableJson([...new Set(hashes)].sort()))
    throw new Error("Journal continuation hashes are not canonical");
}

function copyJson<T>(value: T): T {
  return JSON.parse(stableJson(value)) as T;
}

function assertBoundedJournalJson(value: unknown, maximumBytes: number, label: string): void {
  if (Buffer.byteLength(stableJson(value), "utf8") > maximumBytes)
    throw new Error(`${label} exceeds its bounded persistence limit`);
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Invalid ${label}`);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function assertIso(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value)
    throw new Error(`Invalid ${label}`);
}

function assertJournalId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !JOURNAL_ID_PATTERN.test(value))
    throw new Error("Invalid agent execution journal ID");
}

async function assertReplaceableRegularFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("Unsafe agent execution journal head target");
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

export function measureRequestSizes(request: ModelTurnRequest): ModelRequestSizes {
  const bytes = (value: unknown) => Buffer.byteLength(stableJson(value), "utf8");
  return {
    systemInstructions: Buffer.byteLength(request.system, "utf8"),
    conversation: bytes(request.messages.filter((message) => message.role !== "tool")),
    toolSchemas: bytes(request.tools),
    toolResults: bytes(request.messages.filter((message) => message.role === "tool")),
  };
}
