import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertArtifactReference,
  serializeCanonicalJson,
  type ArtifactReference,
  type ImmutableJsonArtifactStore,
} from "../../artifact-store/src/index.js";
import {
  assertAgentRun,
  assertAgentExecutionJournalBinding,
  verifyAgentRunExecutionJournal,
  type AgentExecutionJournalBinding,
  type ToolCallRecord,
} from "../../agent-runtime/src/index.js";
import { DEFAULT_GAME_COMPILER_POLICY } from "../../game-compiler/src/index.js";
import { DEFAULT_GAME_ADMISSION_POLICY } from "../../game-ir/src/index.js";
import { assertBoundedGameJson } from "../../game-ir/src/primitives.js";
import {
  assertCreatorBuildProposal,
  loadCreatorBuildProposal,
  type CreatorBuildProposal,
} from "./build-proposal.js";
import {
  assertCreatorSourceMemberDiagnosticFrame,
  creatorSourceMemberDiagnostic,
  type CreatorSourceMemberDiagnostic,
  type CreatorSourceMemberDiagnosticFrame,
} from "./source-repair-obligations.js";
import {
  assertCreatorApproval,
  assertCreatorBuildContract,
  assertCreatorPlan,
  assertCreatorSession,
  patchCreatorDraftSource,
  type CreatorDraftLineEdit,
  type CreatorApproval,
  type CreatorBuildContract,
  type CreatorPlan,
  type CreatorSession,
} from "./index.js";

export interface CreatorBuildRecoveryBinding {
  sessionId: string;
  projectId: string;
  promptHash: string;
  revisionHash: string;
  planHash: string;
  compiledPlanHash: string;
  approvalHash: string;
  buildContract: { id: string; hash: string };
}
export interface CreatorBuildRecoveryCall {
  agentRunId: string;
  toolCallId: string;
  sequence: number;
  name: "studio.build" | "studio.repair";
  input: unknown;
  inputHash: string;
  expectedChanges: Record<string, unknown>[];
  sourceMemberDiagnostics: {
    slotId: string;
    diagnostics: CreatorSourceMemberDiagnostic[];
  }[];
}
export interface CreatorBuildRecovery {
  kind: "CreatorBuildRecovery";
  id: string;
  hash: string;
  binding: CreatorBuildRecoveryBinding;
  initialProposal?: ArtifactReference;
  sourceRuns: {
    agentRun: ArtifactReference;
    agentRunId: string;
    journal: AgentExecutionJournalBinding;
  }[];
  calls: CreatorBuildRecoveryCall[];
}
interface RecoveryAuthority {
  expected: CreatorBuildRecoveryBinding;
  plan: CreatorPlan;
  approval: CreatorApproval;
  contract: CreatorBuildContract;
}
interface RecoveryStoreInput extends RecoveryAuthority {
  store: ImmutableJsonArtifactStore;
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1);
const bindingSchema = z
  .object({
    sessionId: identifier,
    projectId: identifier,
    promptHash: hash,
    revisionHash: hash,
    planHash: hash,
    compiledPlanHash: hash,
    approvalHash: hash,
    buildContract: z.object({ id: identifier, hash }).strict(),
  })
  .strict();
const receiptSchema = z
  .object({
    planChangeId: identifier,
    operationId: identifier.optional(),
    kind: z.enum(["create", "update", "move", "delete", "edit_source"]).optional(),
    operationHash: hash,
    previousOperationHash: hash.optional(),
    sourceHash: hash.optional(),
    sourceBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
const callSchema = z
  .object({
    agentRunId: identifier,
    toolCallId: identifier,
    sequence: z.number().int().positive(),
    name: z.enum(["studio.build", "studio.repair"]),
    input: z.unknown(),
    inputHash: hash,
    expectedChanges: z.array(receiptSchema).min(1),
    sourceMemberDiagnostics: z.array(
      z
        .object({
          slotId: identifier,
          diagnostics: z
            .array(
              z
                .object({
                  message: z.string().regex(/^Key '([^']+)' not found in external type '([^']+)'$/),
                  line: z.number().int().positive(),
                  column: z.number().int().positive(),
                  endLine: z.number().int().positive().optional(),
                  endColumn: z.number().int().positive().optional(),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    ),
  })
  .strict();
const recoverySchema = z
  .object({
    kind: z.literal("CreatorBuildRecovery"),
    id: identifier,
    hash,
    binding: bindingSchema,
    initialProposal: z.unknown().optional(),
    sourceRuns: z
      .array(
        z
          .object({
            agentRun: z.unknown(),
            agentRunId: identifier,
            journal: z.unknown(),
          })
          .strict(),
      )
      .min(1),
    calls: z.array(callSchema),
  })
  .strict();
const readTools = new Set([
  "game.source_context",
  "game.inspect_inventory",
  "game.read_locked_source",
  "studio.read_observations",
  "studio.read_drafts",
  "studio.api_lookup",
  "source.read",
]);

export function assertCreatorBuildRecovery(value: unknown): asserts value is CreatorBuildRecovery {
  assertBoundedGameJson(value, {
    ...DEFAULT_GAME_ADMISSION_POLICY,
    maximumJsonBytes: DEFAULT_GAME_COMPILER_POLICY.maximumCanonicalBytes,
    maximumStringUtf8Bytes: DEFAULT_GAME_COMPILER_POLICY.maximumCanonicalBytes,
    maximumJsonNodes: 1_000_000,
  });
  recoverySchema.parse(value);
  const recovery = value as unknown as CreatorBuildRecovery;
  if (recovery.initialProposal) assertArtifactReference(recovery.initialProposal);
  const runs = new Set<string>();
  for (const source of recovery.sourceRuns) {
    assertArtifactReference(source.agentRun);
    assertAgentExecutionJournalBinding(source.journal);
    if (runs.has(source.agentRunId)) throw new Error("Recovery repeats an originating AgentRun");
    runs.add(source.agentRunId);
  }
  const calls = new Set<string>();
  const runOrder = new Map(recovery.sourceRuns.map((source, index) => [source.agentRunId, index]));
  let previousRun = -1;
  let previousSequence = 0;
  for (const call of recovery.calls) {
    const key = stableJson([call.agentRunId, call.toolCallId]);
    if (
      !runs.has(call.agentRunId) ||
      calls.has(key) ||
      call.inputHash !== contentHash(stableJson(call.input))
    )
      throw new Error("Recovery call identity or original input hash is invalid");
    calls.add(key);
    const currentRun = runOrder.get(call.agentRunId)!;
    if (
      currentRun < previousRun ||
      (currentRun === previousRun && call.sequence <= previousSequence)
    )
      throw new Error("Recovery calls must retain originating run and execution order");
    previousRun = currentRun;
    previousSequence = call.sequence;
    if (
      new Set(call.expectedChanges.map((change) => change.planChangeId)).size !==
      call.expectedChanges.length
    )
      throw new Error("Recovery operation receipts are duplicated");
    if (
      new Set(call.sourceMemberDiagnostics.map((row) => row.slotId)).size !==
      call.sourceMemberDiagnostics.length
    )
      throw new Error("Recovery member diagnostic slots are duplicated");
  }
  if (
    !recovery.initialProposal &&
    recovery.calls.length > 0 &&
    recovery.calls[0]!.name !== "studio.build"
  )
    throw new Error("Recovery lineage requires an initial completed studio.build");
  const { id, hash: digest, ...payload } = recovery;
  const expected = contentHash(stableJson(payload));
  if (digest !== expected || id !== "creator_build_recovery_" + expected.slice(0, 24))
    throw new Error("Recovery artifact identity mismatch");
}

export function creatorBuildRecoveryBinding(input: {
  session: CreatorSession;
  plan: CreatorPlan;
  approval: CreatorApproval;
  contract: CreatorBuildContract;
}): CreatorBuildRecoveryBinding {
  assertCreatorSession(input.session);
  const expected = {
    sessionId: input.session.id,
    projectId: input.session.projectId,
    promptHash: input.session.promptHash,
    revisionHash: input.plan.projectRevisionHash,
    planHash: input.plan.hash,
    compiledPlanHash: input.plan.compiled.hash,
    approvalHash: input.approval.hash,
    buildContract: { id: input.contract.id, hash: input.contract.hash },
  };
  assertAuthority({ ...input, expected });
  return expected;
}

function assertAuthority(input: RecoveryAuthority): void {
  bindingSchema.parse(input.expected);
  assertCreatorPlan(input.plan);
  assertCreatorApproval(input.approval);
  assertCreatorBuildContract(input.contract);
  const { expected, plan, approval, contract } = input;
  if (
    plan.sessionId !== expected.sessionId ||
    plan.projectId !== expected.projectId ||
    plan.promptHash !== expected.promptHash ||
    plan.projectRevisionHash !== expected.revisionHash ||
    plan.hash !== expected.planHash ||
    plan.compiled.hash !== expected.compiledPlanHash ||
    approval.sessionId !== expected.sessionId ||
    approval.decision !== "approved" ||
    approval.artifactKind !== "plan" ||
    approval.artifactId !== plan.id ||
    approval.artifactHash !== plan.hash ||
    approval.hash !== expected.approvalHash ||
    contract.id !== expected.buildContract.id ||
    contract.hash !== expected.buildContract.hash ||
    contract.sessionId !== expected.sessionId ||
    contract.planId !== plan.id ||
    contract.planHash !== plan.hash ||
    contract.planApprovalId !== approval.id ||
    contract.planApprovalHash !== approval.hash ||
    contract.promptHash !== expected.promptHash ||
    contract.initialRevisionHash !== expected.revisionHash
  )
    throw new Error(
      "Recovery does not bind the exact accepted session, project, plan and approval",
    );
}

function assertToolHashes(call: ToolCallRecord): void {
  const resultPayload = call.result.ok ? call.result.value : call.result.error;
  if (
    call.inputHash !== contentHash(stableJson(call.input)) ||
    resultPayload === undefined ||
    call.resultHash !== call.result.resultHash ||
    call.resultHash !== contentHash(stableJson(resultPayload)) ||
    call.result.bytes !== Buffer.byteLength(stableJson(resultPayload)) ||
    call.bytes !== call.result.bytes ||
    call.truncated ||
    call.result.truncated
  )
    throw new Error("Recovery tool input/result bytes or hashes are inconsistent");
}

/** Preserve only recorded pinned type errors, never model-authored explanations. */
function recordedMemberDiagnostics(
  value: unknown,
  slots: ReadonlySet<string>,
): CreatorBuildRecoveryCall["sourceMemberDiagnostics"] {
  const record = (entry: unknown): entry is Record<string, unknown> =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry);
  if (!record(value) || !record(value.review) || !Array.isArray(value.review.issues)) return [];
  const grouped = new Map<string, Map<string, CreatorSourceMemberDiagnostic>>();
  for (const issue of value.review.issues) {
    if (
      !record(issue) ||
      issue.ruleId !== "LUAU_TYPE_ERROR" ||
      issue.severity !== "error" ||
      typeof issue.planChangeId !== "string" ||
      !slots.has(issue.planChangeId) ||
      typeof issue.message !== "string" ||
      !/^Key '([^']+)' not found in external type '([^']+)'$/.test(issue.message)
    )
      continue;
    // The journal stores the creator's bounded diagnostic view: up to twelve
    // recorded locations per group. New live reviews retain all raw diagnostics.
    if (!Array.isArray(issue.locations) || issue.locations.length === 0)
      throw new Error("Recorded member diagnostic lacks exact source locations");
    const diagnostics =
      grouped.get(issue.planChangeId) ?? new Map<string, CreatorSourceMemberDiagnostic>();
    for (const location of issue.locations) {
      const parsed = z
        .object({
          line: z.number().int().positive(),
          column: z.number().int().positive(),
          endLine: z.number().int().positive().optional(),
          endColumn: z.number().int().positive().optional(),
        })
        .strict()
        .parse(location);
      const diagnostic = creatorSourceMemberDiagnostic(issue.message, parsed)!;
      diagnostics.set(stableJson(diagnostic), diagnostic);
    }
    grouped.set(issue.planChangeId, diagnostics);
  }
  return [...grouped]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([slotId, rows]) => ({
      slotId,
      diagnostics: [...rows].sort(([a], [b]) => a.localeCompare(b, "en")).map(([, row]) => row),
    }));
}

/** Reconstruct source bytes and their recorded diagnostic history from verified calls. */
export function replayCreatorBuildRecoverySources(
  recovery: CreatorBuildRecovery,
  initialProposal?: CreatorBuildProposal,
): {
  sources: Map<string, string>;
  summary: string;
  sourceMemberHistory: CreatorSourceMemberDiagnosticFrame[];
} {
  assertCreatorBuildRecovery(recovery);
  if (Boolean(recovery.initialProposal) !== Boolean(initialProposal))
    throw new Error("Diagnostic history requires its exact verified initial source proposal");
  if (initialProposal) {
    assertCreatorBuildProposal(initialProposal);
    const bytes = serializeCanonicalJson(initialProposal);
    if (
      initialProposal.planHash !== recovery.binding.planHash ||
      contentHash(bytes) !== recovery.initialProposal!.artifactHash ||
      Buffer.byteLength(bytes) !== recovery.initialProposal!.bytes
    )
      throw new Error("Diagnostic history initial source proposal binding changed");
  }
  let sources = new Map(
    (initialProposal?.input.sources ?? []).map((source) => [source.slotId, source.source]),
  );
  let summary = initialProposal?.input.summary ?? "";
  const history = new Map<string, CreatorSourceMemberDiagnosticFrame>();
  const add = (frame: CreatorSourceMemberDiagnosticFrame) => {
    assertCreatorSourceMemberDiagnosticFrame(frame);
    history.set(stableJson(frame), structuredClone(frame));
  };
  for (const frame of initialProposal?.sourceMemberHistory ?? []) add(frame);
  for (const call of recovery.calls) {
    const input = call.input as {
      sources?: { slotId: string; source: string }[];
      summary?: string;
      repairs?: {
        kind: string;
        planChangeId: string;
        expectedSourceHash: string;
        edits: CreatorDraftLineEdit[];
      }[];
    };
    if (call.name === "studio.build") {
      const submitted = z
        .array(z.object({ slotId: identifier, source: z.string() }).strict())
        .parse(input.sources ?? []);
      sources = new Map(submitted.map((source) => [source.slotId, source.source]));
      if (sources.size !== submitted.length)
        throw new Error("Recovery repeats submitted source slots");
    } else {
      for (const repair of input.repairs ?? []) {
        if (repair.kind !== "source") continue;
        const before = sources.get(repair.planChangeId);
        if (before === undefined) throw new Error("Recovery source repair has no preceding source");
        sources.set(
          repair.planChangeId,
          patchCreatorDraftSource(before, repair.expectedSourceHash, repair.edits),
        );
      }
    }
    if (typeof input.summary === "string") summary = input.summary;
    for (const receipt of call.expectedChanges) {
      const source = sources.get(String(receipt.planChangeId));
      if (
        source !== undefined &&
        (contentHash(source) !== receipt.sourceHash ||
          Buffer.byteLength(source) !== receipt.sourceBytes)
      )
        throw new Error("Recovery source differs from its verified original receipt");
    }
    for (const row of call.sourceMemberDiagnostics) {
      const source = sources.get(row.slotId);
      if (source === undefined)
        throw new Error("Recorded member diagnostic has no preceding approved source");
      add({
        slotId: row.slotId,
        source,
        sourceHash: contentHash(source),
        diagnostics: row.diagnostics,
      });
    }
  }
  return { sources, summary, sourceMemberHistory: [...history.values()] };
}

export function creatorBuildRecoverySourceMemberHistory(
  recovery: CreatorBuildRecovery,
  initialProposal?: CreatorBuildProposal,
): CreatorSourceMemberDiagnosticFrame[] {
  return replayCreatorBuildRecoverySources(recovery, initialProposal).sourceMemberHistory;
}

async function extractRun(input: RecoveryStoreInput, reference: ArtifactReference) {
  const run = await input.store.read(reference, assertAgentRun);
  const expected = input.expected;
  if (
    run.phase !== "creator_builder" ||
    run.origin.kind !== "creator_session" ||
    run.origin.creatorSessionId !== expected.sessionId ||
    run.creatorPromptHash !== expected.promptHash ||
    run.seedHash !== expected.revisionHash ||
    !["incomplete", "rejected"].includes(run.status) ||
    run.creatorPhaseOutcome?.status !== "unsealed" ||
    stableJson(run.creatorBuildContract) !== stableJson(expected.buildContract)
  )
    throw new Error("Recovery requires the exact incomplete creator-builder AgentRun");
  const journal = await verifyAgentRunExecutionJournal(run, input.store);
  if (!journal) throw new Error("Recovery requires an authoritative terminal execution journal");
  const terminal = journal.entries.at(-1)!.checkpoint;
  if (terminal.checkpointType !== "terminal") throw new Error("Recovery journal is not terminal");
  const completed = journal.entries.flatMap((entry) =>
    entry.checkpoint.checkpointType === "tool_completed" ? [entry.checkpoint.toolCall] : [],
  );
  if (
    stableJson(completed) !== stableJson(run.toolCalls) ||
    stableJson(completed) !== stableJson(terminal.result.toolCalls)
  )
    throw new Error("Recovery run and terminal journal disagree about completed tools");
  const calls: CreatorBuildRecoveryCall[] = [];
  const approvedIds = new Set(input.plan.compiled.inventory.map((item) => item.id));
  const sourceSlotIds = new Set(
    input.plan.compiled.inventory
      .filter((item) => item.source?.content.kind === "slot")
      .map((item) => item.id),
  );
  let progress: string | null | undefined;
  let active: { id: string; progress: string | null } | undefined;
  for (const entry of journal.entries) {
    const checkpoint = entry.checkpoint;
    if (checkpoint.checkpointType === "tool_execution_intent") {
      if (progress !== undefined && progress !== checkpoint.state.toolHostProgressTokenHash)
        throw new Error("Recovery journal changed staged state outside a completed tool");
      active = { id: checkpoint.toolCall.id, progress: checkpoint.state.toolHostProgressTokenHash };
      progress = active.progress;
    } else if (checkpoint.checkpointType === "tool_completed") {
      const call = checkpoint.toolCall;
      assertToolHashes(call);
      const after = checkpoint.state.toolHostProgressTokenHash;
      const before = call.disposition === "executed" ? active?.progress : progress;
      if (
        before === undefined ||
        before === null ||
        after === null ||
        (call.disposition === "executed" && active?.id !== call.toolCallId)
      )
        throw new Error("Recovery tool outcome lacks exact progress boundaries");
      const write = call.name === "studio.build" || call.name === "studio.repair";
      if (call.disposition === "rejected" || !call.result.ok || !write) {
        if (before !== after)
          throw new Error(
            "Recovery cannot ignore a failed or read-only call that changed staged state",
          );
        if (call.disposition === "executed" && !write && !readTools.has(call.name))
          throw new Error("Recovery encountered an unknown executed builder tool");
      } else {
        const value = call.result.value as { changes?: unknown };
        const expectedChanges = z.array(receiptSchema).min(1).parse(value?.changes);
        if (expectedChanges.some((receipt) => !approvedIds.has(receipt.planChangeId)))
          throw new Error("Recovery receipts exceed the accepted inventory");
        if (
          call.name === "studio.build" &&
          new Set(expectedChanges.map((receipt) => receipt.planChangeId)).size !== approvedIds.size
        )
          throw new Error("Recovery build receipts omit accepted inventory targets");
        calls.push({
          agentRunId: run.id,
          toolCallId: call.toolCallId,
          sequence: call.sequence,
          name: call.name as "studio.build" | "studio.repair",
          input: structuredClone(call.input),
          inputHash: call.inputHash,
          expectedChanges,
          sourceMemberDiagnostics: recordedMemberDiagnostics(call.result.value, sourceSlotIds),
        });
      }
      progress = after;
      active = undefined;
    } else if ("state" in checkpoint) {
      if (progress !== undefined && progress !== checkpoint.state.toolHostProgressTokenHash)
        throw new Error("Recovery journal changed staged state outside a completed tool");
      progress = checkpoint.state.toolHostProgressTokenHash;
    }
  }
  if (active) throw new Error("Recovery has an uncertain tool outcome");
  return {
    source: { agentRun: reference, agentRunId: run.id, journal: run.executionJournal! },
    calls,
  };
}

/** Load and re-derive journal provenance; a recovery artifact never grants new authoring authority. */
export async function loadCreatorBuildRecovery(
  input: RecoveryStoreInput & { artifact: ArtifactReference },
): Promise<CreatorBuildRecovery> {
  assertAuthority(input);
  const recovery = await input.store.read(input.artifact, assertCreatorBuildRecovery);
  if (stableJson(recovery.binding) !== stableJson(input.expected))
    throw new Error("Recovery artifact belongs to another accepted build");
  if (recovery.initialProposal)
    await loadCreatorBuildProposal({
      store: input.store,
      artifact: recovery.initialProposal,
      plan: input.plan,
    });
  const calls: CreatorBuildRecoveryCall[] = [];
  for (const source of recovery.sourceRuns) {
    const extracted = await extractRun(input, source.agentRun);
    if (stableJson(extracted.source) !== stableJson(source))
      throw new Error("Recovery originating run or journal binding changed");
    calls.push(...extracted.calls);
  }
  if (stableJson(calls) !== stableJson(recovery.calls))
    throw new Error("Recovery calls differ from their exact completed journal inputs");
  return recovery;
}

export async function createCreatorBuildRecovery(
  input: RecoveryStoreInput & {
    priorRun: ArtifactReference;
    priorRecovery?: ArtifactReference;
    initialProposal?: ArtifactReference;
  },
): Promise<CreatorBuildRecovery> {
  assertAuthority(input);
  const prior = input.priorRecovery
    ? await loadCreatorBuildRecovery({ ...input, artifact: input.priorRecovery })
    : undefined;
  const initialProposal = prior?.initialProposal ?? input.initialProposal;
  if (prior && stableJson(prior.initialProposal) !== stableJson(input.initialProposal))
    throw new Error("Recovery proposed initial source binding changed");
  if (initialProposal)
    await loadCreatorBuildProposal({
      store: input.store,
      artifact: initialProposal,
      plan: input.plan,
    });
  if (
    prior?.sourceRuns.some((source) => stableJson(source.agentRun) === stableJson(input.priorRun))
  )
    throw new Error("This AgentRun is already represented by the retained recovery artifact");
  const extracted = await extractRun(input, input.priorRun);
  const payload = {
    kind: "CreatorBuildRecovery" as const,
    binding: structuredClone(input.expected),
    ...(initialProposal ? { initialProposal } : {}),
    sourceRuns: [...(prior?.sourceRuns ?? []), extracted.source],
    calls: [...(prior?.calls ?? []), ...extracted.calls],
  };
  const digest = contentHash(stableJson(payload));
  const recovery = {
    ...payload,
    id: "creator_build_recovery_" + digest.slice(0, 24),
    hash: digest,
  };
  assertCreatorBuildRecovery(recovery);
  return recovery;
}

export async function writeCreatorBuildRecovery(
  input: RecoveryStoreInput & {
    priorRun: ArtifactReference;
    priorRecovery?: ArtifactReference;
    initialProposal?: ArtifactReference;
  },
) {
  const recovery = await createCreatorBuildRecovery(input);
  return { recovery, artifact: await input.store.write(recovery) };
}
