import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ImmutableJsonArtifactStore,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertArtifactReferenceShape,
  assertCreatorCitation,
  assertCreatorActionRequest,
  assertCreatorActionRequestBinding,
  assertCreatorConversationCommit,
  assertCreatorConversationEvent,
  assertCreatorConversationTurn,
  assertCreatorControlView,
  assertCreatorMemoryRevision,
  assertCreatorModelRegistry,
  assertCreatorPlanRevision,
  assertCreatorProjectConversation,
  assertCreatorTurnContract,
  assertCreatorTurnRequest,
  assertCreatorWorkEpisode,
  assertCreatorWorkJob,
  type CreatorCitation,
  type CreatorActionRequest,
  type CreatorArtifactBinding,
  type CreatorConversationCommit,
  type CreatorConversationEvent,
  type CreatorConversationTurn,
  type CreatorControlActionDescriptor,
  type CreatorControlView,
  type CreatorMemoryRevision,
  type CreatorModelRegistry,
  type CreatorPlanRevision,
  type CreatorProjectConversation,
  type CreatorTurnContract,
  type CreatorTurnRequest,
  type CreatorWorkEpisode,
  type CreatorWorkJob,
} from "./contracts.js";
import { assertCreatorPublishedIdentityContinuityReceipt } from "./identity-contracts.js";

type RecordDraft<T> = T extends unknown ? Omit<T, "kind" | "hash"> : never;

export interface CreatorConversationHead {
  readonly kind: "CreatorConversationHead";
  readonly conversationId: string;
  readonly sequence: number;
  readonly conversationHash: string;
  readonly commitHash: string;
  readonly commit: ArtifactReference;
  readonly updatedAt: string;
}

export interface CreatorConversationAppendInput {
  readonly conversation: CreatorProjectConversation;
  readonly event: CreatorConversationEvent;
  readonly episode?: CreatorWorkEpisode;
  readonly turn?: CreatorConversationTurn;
  readonly memoryRevision?: CreatorMemoryRevision;
  readonly planRevision?: CreatorPlanRevision;
  readonly job?: CreatorWorkJob;
  /**
   * Optional optimistic guard. `null` asserts that no conversation head exists;
   * a value asserts the exact head observed by the caller.
   */
  readonly expectedHead?: null | { readonly sequence: number; readonly commitHash: string };
}

export interface CreatorConversationAppendResult {
  readonly head: CreatorConversationHead;
  readonly commit: CreatorConversationCommit;
  readonly references: {
    readonly conversation: ArtifactReference;
    readonly event: ArtifactReference;
    readonly episode?: ArtifactReference;
    readonly turn?: ArtifactReference;
    readonly citations: readonly ArtifactReference[];
    readonly memoryRevision?: ArtifactReference;
    readonly planRevision?: ArtifactReference;
    readonly job?: ArtifactReference;
    readonly commit: ArtifactReference;
  };
}

export interface LoadedCreatorConversation {
  readonly head: CreatorConversationHead;
  readonly conversation: CreatorProjectConversation;
  readonly commits: readonly CreatorConversationCommit[];
  readonly events: readonly CreatorConversationEvent[];
  readonly episodes: readonly CreatorWorkEpisode[];
  readonly turns: readonly CreatorConversationTurn[];
  readonly citations: readonly CreatorCitation[];
  readonly memoryRevisions: readonly CreatorMemoryRevision[];
  readonly planRevisions: readonly CreatorPlanRevision[];
  readonly jobs: readonly CreatorWorkJob[];
}

export interface CorruptCreatorConversation {
  readonly headLocator: string;
  readonly conversationId?: string;
  readonly error: string;
}

export interface CreatorConversationEnumeration {
  readonly conversations: readonly LoadedCreatorConversation[];
  readonly corrupt: readonly CorruptCreatorConversation[];
}

export interface CreatorConversationStoreOptions {
  /** Fault-injection boundary used to prove that artifacts precede head publication. */
  readonly beforePublishHead?: (
    head: CreatorConversationHead,
    commit: CreatorConversationCommit,
  ) => void | Promise<void>;
}

const HEAD_DIRECTORY = "conversations";
const HEAD_SUFFIX = ".head.json";
const HEAD_MAX_BYTES = 64 * 1024;
const MAX_CHAIN_LENGTH = 1_000_000;
const MAX_REACHABLE_ARTIFACTS = 1_000_000;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Append-only conversation history over the generic immutable artifact store.
 *
 * All immutable bodies are durable before the single mutable head is atomically
 * replaced. Calls for one conversation are serialized in invocation order;
 * unrelated conversations remain independent.
 */
export class CreatorConversationStore {
  public readonly artifactStore: ImmutableJsonArtifactStore;
  private readonly options: CreatorConversationStoreOptions;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    store: ImmutableJsonArtifactStore | string,
    options: CreatorConversationStoreOptions = {},
  ) {
    this.artifactStore = typeof store === "string" ? new ImmutableJsonArtifactStore(store) : store;
    this.options = options;
  }

  async append(input: CreatorConversationAppendInput): Promise<CreatorConversationAppendResult> {
    assertCreatorConversationAppendInput(input);
    return this.serialize(input.conversation.id, () => this.appendSerialized(input));
  }

  async load(conversationId: string): Promise<LoadedCreatorConversation> {
    assertConversationId(conversationId);
    const head = await this.readHead(conversationId);
    if (head === undefined) throw new Error(`Creator conversation is missing: ${conversationId}`);
    return this.loadFromHead(head);
  }

  async enumerate(): Promise<CreatorConversationEnumeration> {
    const directory = join(this.artifactStore.root, HEAD_DIRECTORY);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return { conversations: [], corrupt: [] };
      throw error;
    }
    const conversations: LoadedCreatorConversation[] = [];
    const corrupt: CorruptCreatorConversation[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const locator = `${HEAD_DIRECTORY}/${entry.name}`;
      const candidate = entry.name.endsWith(HEAD_SUFFIX)
        ? entry.name.slice(0, -HEAD_SUFFIX.length)
        : undefined;
      if (!entry.isFile() || candidate === undefined || !isConversationId(candidate)) {
        corrupt.push({ headLocator: locator, error: "Invalid conversation head entry" });
        continue;
      }
      try {
        const head = await this.readHeadFile(join(directory, entry.name));
        if (head.conversationId !== candidate)
          throw new Error("Conversation head filename binding mismatch");
        conversations.push(await this.loadFromHead(head));
      } catch (error: unknown) {
        corrupt.push({
          headLocator: locator,
          conversationId: candidate,
          error: errorMessage(error),
        });
      }
    }
    conversations.sort((left, right) =>
      left.conversation.updatedAt === right.conversation.updatedAt
        ? left.conversation.id.localeCompare(right.conversation.id)
        : right.conversation.updatedAt.localeCompare(left.conversation.updatedAt),
    );
    return { conversations, corrupt };
  }

  private async appendSerialized(
    input: CreatorConversationAppendInput,
  ): Promise<CreatorConversationAppendResult> {
    const current = await this.tryLoad(input.conversation.id);
    assertExpectedHead(input.expectedHead, current?.head);
    validateAppendTransition(input, current);
    await verifyExternalBindings(this.artifactStore, input);

    const conversationReference = await this.artifactStore.write(input.conversation);
    const eventReference = await this.artifactStore.write(input.event);
    const episodeReference =
      input.episode === undefined ? undefined : await this.artifactStore.write(input.episode);
    const turnReference =
      input.turn === undefined ? undefined : await this.artifactStore.write(input.turn);
    const citationReferences: ArtifactReference[] = [];
    if (input.turn?.role === "agent") {
      for (const citation of input.turn.citations)
        citationReferences.push(await this.artifactStore.write(citation));
    }
    const memoryReference =
      input.memoryRevision === undefined
        ? undefined
        : await this.artifactStore.write(input.memoryRevision);
    const planReference =
      input.planRevision === undefined
        ? undefined
        : await this.artifactStore.write(input.planRevision);
    const jobReference =
      input.job === undefined ? undefined : await this.artifactStore.write(input.job);

    const commit = sealCreatorConversationCommit({
      id: `creator_commit:${input.conversation.id}:${input.event.sequence}`,
      conversationId: input.conversation.id,
      sequence: input.event.sequence,
      ...(current === undefined
        ? {}
        : {
            previousCommitHash: current.commits.at(-1)!.hash,
            previousCommit: current.head.commit,
          }),
      conversation: conversationReference,
      conversationHash: input.conversation.hash,
      event: eventReference,
      eventId: input.event.id,
      eventHash: input.event.hash,
      ...(input.episode === undefined
        ? {}
        : {
            episodeSnapshot: episodeReference!,
            episodeId: input.episode.id,
            episodeHash: input.episode.hash,
          }),
      ...(input.turn === undefined
        ? {}
        : {
            turn: turnReference!,
            turnId: input.turn.id,
            turnHash: input.turn.hash,
          }),
      citations:
        input.turn?.role === "agent"
          ? input.turn.citations.map((citation, index) => ({
              id: citation.id,
              hash: citation.hash,
              artifact: citationReferences[index]!,
            }))
          : [],
      ...(input.memoryRevision === undefined
        ? {}
        : {
            memoryRevision: memoryReference!,
            memoryRevisionId: input.memoryRevision.id,
            memoryRevisionHash: input.memoryRevision.hash,
          }),
      ...(input.planRevision === undefined
        ? {}
        : {
            planRevision: planReference!,
            planRevisionId: input.planRevision.id,
            planRevisionHash: input.planRevision.hash,
          }),
      ...(input.job === undefined
        ? {}
        : { job: jobReference!, jobId: input.job.id, jobHash: input.job.hash }),
      committedAt: input.event.occurredAt,
    });
    const commitReference = await this.artifactStore.write(commit);
    const head: CreatorConversationHead = {
      kind: "CreatorConversationHead",
      conversationId: input.conversation.id,
      sequence: commit.sequence,
      conversationHash: input.conversation.hash,
      commitHash: commit.hash,
      commit: commitReference,
      updatedAt: input.conversation.updatedAt,
    };
    assertCreatorConversationHead(head);
    await this.options.beforePublishHead?.(head, commit);
    await this.writeHead(head);
    return {
      head,
      commit,
      references: {
        conversation: conversationReference,
        event: eventReference,
        ...(episodeReference === undefined ? {} : { episode: episodeReference }),
        ...(turnReference === undefined ? {} : { turn: turnReference }),
        citations: citationReferences,
        ...(memoryReference === undefined ? {} : { memoryRevision: memoryReference }),
        ...(planReference === undefined ? {} : { planRevision: planReference }),
        ...(jobReference === undefined ? {} : { job: jobReference }),
        commit: commitReference,
      },
    };
  }

  private async tryLoad(conversationId: string): Promise<LoadedCreatorConversation | undefined> {
    const head = await this.readHead(conversationId);
    return head === undefined ? undefined : this.loadFromHead(head);
  }

  private async loadFromHead(head: CreatorConversationHead): Promise<LoadedCreatorConversation> {
    assertCreatorConversationHead(head);
    const reverseCommits: CreatorConversationCommit[] = [];
    const reverseEvents: CreatorConversationEvent[] = [];
    const episodes = new Map<string, CreatorWorkEpisode>();
    const turns = new Map<string, CreatorConversationTurn>();
    const citations = new Map<string, CreatorCitation>();
    const memoryRevisions = new Map<string, CreatorMemoryRevision>();
    const planRevisions = new Map<string, CreatorPlanRevision>();
    const jobs = new Map<string, CreatorWorkJob>();
    const newerEpisodeSnapshots = new Map<string, CreatorWorkEpisode>();
    const newerJobSnapshots = new Map<string, CreatorWorkJob>();
    const visitedArtifacts = new Set<string>();
    let expectedSequence = head.sequence;
    let expectedCommitHash = head.commitHash;
    let reference: ArtifactReference | undefined = head.commit;
    let currentConversation: CreatorProjectConversation | undefined;
    let newerConversation: CreatorProjectConversation | undefined;

    while (reference !== undefined) {
      if (reverseCommits.length >= MAX_CHAIN_LENGTH)
        throw new Error("Creator conversation exceeds maximum chain length");
      if (visitedArtifacts.has(reference.artifactHash))
        throw new Error("Creator conversation commit chain contains a cycle");
      visitedArtifacts.add(reference.artifactHash);
      const commit: CreatorConversationCommit = await this.artifactStore.read(
        reference,
        assertCreatorConversationCommit,
      );
      assertCreatorRecordIdentity(commit);
      if (
        commit.conversationId !== head.conversationId ||
        commit.sequence !== expectedSequence ||
        commit.hash !== expectedCommitHash
      )
        throw new Error("Creator conversation commit chain binding mismatch");
      const conversation = await this.artifactStore.read(
        commit.conversation,
        assertCreatorProjectConversation,
      );
      assertCreatorRecordIdentity(conversation);
      if (
        conversation.id !== head.conversationId ||
        conversation.hash !== commit.conversationHash ||
        conversation.latestEventSequence !== commit.sequence
      )
        throw new Error("Creator conversation snapshot binding mismatch");
      const event = await this.artifactStore.read(commit.event, assertCreatorConversationEvent);
      assertCreatorRecordIdentity(event);
      if (
        event.id !== commit.eventId ||
        event.hash !== commit.eventHash ||
        event.conversationId !== head.conversationId ||
        event.sequence !== commit.sequence
      )
        throw new Error("Creator conversation event binding mismatch");
      if (currentConversation === undefined) {
        currentConversation = conversation;
        newerConversation = conversation;
      } else {
        assertConversationSnapshotProgression(
          conversation,
          newerConversation!,
          reverseEvents.at(-1)!,
        );
        newerConversation = conversation;
      }
      reverseCommits.push(commit);
      reverseEvents.push(event);
      await loadOptionalCommitRecords({
        store: this.artifactStore,
        commit,
        event,
        episodes,
        turns,
        citations,
        memoryRevisions,
        planRevisions,
        jobs,
        newerEpisodeSnapshots,
        newerJobSnapshots,
      });
      if (commit.sequence === 1) {
        if (commit.previousCommit !== undefined || commit.previousCommitHash !== undefined)
          throw new Error("Initial creator conversation commit has a predecessor");
        reference = undefined;
      } else {
        if (commit.previousCommit === undefined || commit.previousCommitHash === undefined)
          throw new Error("Creator conversation commit predecessor is missing");
        reference = commit.previousCommit;
        expectedCommitHash = commit.previousCommitHash;
        expectedSequence -= 1;
      }
    }
    if (expectedSequence !== 1 || currentConversation === undefined)
      throw new Error("Creator conversation chain did not reach its initial commit");
    if (
      currentConversation.hash !== head.conversationHash ||
      currentConversation.updatedAt !== head.updatedAt
    )
      throw new Error("Creator conversation head snapshot binding mismatch");

    const commits = reverseCommits.reverse();
    const events = reverseEvents.reverse();
    assertLoadedHistoryContinuity(commits, events);
    assertConversationMemoryHeads(currentConversation, memoryRevisions);
    assertConversationEpisodeTopology(currentConversation, episodes, turns, jobs);
    assertPlanRevisionTopology(currentConversation, episodes, planRevisions, events);
    assertJobResumeTopology(jobs);
    assertJobExecutionTopology(jobs);
    // The commit chain is the root of the complete immutable evidence graph.
    // Structured loading above validates the conversation records themselves;
    // this traversal additionally proves that every artifact they transitively
    // reference still exists and retains its exact canonical bytes.
    await verifyReachableArtifactGraph(this.artifactStore, [head.commit]);
    return {
      head,
      conversation: currentConversation,
      commits,
      events,
      episodes: sortedByOrdinal(episodes.values()),
      turns: sortedByCreatedAt(turns.values()),
      citations: [...citations.values()].sort((left, right) => left.id.localeCompare(right.id)),
      memoryRevisions: [...memoryRevisions.values()].sort((left, right) =>
        left.itemId === right.itemId
          ? left.revision - right.revision
          : left.itemId.localeCompare(right.itemId),
      ),
      planRevisions: [...planRevisions.values()].sort((left, right) =>
        left.episodeId === right.episodeId
          ? left.revision - right.revision
          : left.episodeId.localeCompare(right.episodeId),
      ),
      jobs: sortedByCreatedAt(jobs.values()),
    };
  }

  private async readHead(conversationId: string): Promise<CreatorConversationHead | undefined> {
    await this.ensureHeadDirectory();
    try {
      return await this.readHeadFile(this.headPath(conversationId));
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async readHeadFile(path: string): Promise<CreatorConversationHead> {
    const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await descriptor.stat();
      if (!info.isFile()) throw new Error("Conversation head is not a regular file");
      if (info.size <= 0 || info.size > HEAD_MAX_BYTES)
        throw new Error("Conversation head has an invalid byte count");
      const serialized = await descriptor.readFile({ encoding: "utf8" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized) as unknown;
      } catch {
        throw new Error("Conversation head is not valid JSON");
      }
      if (`${stableJson(parsed)}\n` !== serialized)
        throw new Error("Conversation head JSON is not canonical");
      assertCreatorConversationHead(parsed);
      return parsed;
    } finally {
      await descriptor.close();
    }
  }

  private async writeHead(head: CreatorConversationHead): Promise<void> {
    await this.ensureHeadDirectory();
    const destination = this.headPath(head.conversationId);
    await assertReplaceableRegularFile(destination);
    const temporary = join(
      this.artifactStore.root,
      HEAD_DIRECTORY,
      `.${basename(destination)}.${randomUUID()}.tmp`,
    );
    const serialized = `${stableJson(head)}\n`;
    const descriptor = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await descriptor.writeFile(serialized, { encoding: "utf8" });
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
    // Writing an empty private artifact is unnecessary; mkdir is safe only
    // after checking both the store root and the dedicated child component.
    try {
      await mkdir(this.artifactStore.root, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const rootInfo = await lstat(this.artifactStore.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      throw new Error("Unsafe creator conversation store root");
    const directory = join(this.artifactStore.root, HEAD_DIRECTORY);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Unsafe creator conversation head directory");
  }

  private headPath(conversationId: string): string {
    assertConversationId(conversationId);
    return join(this.artifactStore.root, HEAD_DIRECTORY, `${conversationId}${HEAD_SUFFIX}`);
  }

  private async serialize<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(conversationId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(conversationId) === tail) this.tails.delete(conversationId);
    }
  }
}

export function sealCreatorProjectConversation(
  draft: RecordDraft<CreatorProjectConversation>,
): CreatorProjectConversation {
  return sealRecord("CreatorProjectConversation", draft, assertCreatorProjectConversation);
}

export function sealCreatorConversationTurn<T extends CreatorConversationTurn>(
  draft: RecordDraft<T>,
): T {
  return sealRecord("CreatorConversationTurn", draft, assertCreatorConversationTurn) as T;
}

export function sealCreatorCitation(draft: RecordDraft<CreatorCitation>): CreatorCitation {
  return sealRecord("CreatorCitation", draft, assertCreatorCitation);
}

export function sealCreatorWorkEpisode(draft: RecordDraft<CreatorWorkEpisode>): CreatorWorkEpisode {
  return sealRecord("CreatorWorkEpisode", draft, assertCreatorWorkEpisode);
}

export function sealCreatorConversationEvent<T extends CreatorConversationEvent>(
  draft: RecordDraft<T>,
): T {
  return sealRecord("CreatorConversationEvent", draft, assertCreatorConversationEvent) as T;
}

export function sealCreatorMemoryRevision(
  draft: RecordDraft<CreatorMemoryRevision>,
): CreatorMemoryRevision {
  return sealRecord("CreatorMemoryRevision", draft, assertCreatorMemoryRevision);
}

export function sealCreatorPlanRevision(
  draft: RecordDraft<CreatorPlanRevision>,
): CreatorPlanRevision {
  return sealRecord("CreatorPlanRevision", draft, assertCreatorPlanRevision);
}

export function sealCreatorWorkJob(draft: RecordDraft<CreatorWorkJob>): CreatorWorkJob {
  return sealRecord("CreatorWorkJob", draft, assertCreatorWorkJob);
}

export function sealCreatorModelRegistry(
  draft: RecordDraft<CreatorModelRegistry>,
): CreatorModelRegistry {
  return sealRecord("CreatorModelRegistry", draft, assertCreatorModelRegistry);
}

export function sealCreatorTurnContract(
  draft: RecordDraft<CreatorTurnContract>,
): CreatorTurnContract {
  return sealRecord("CreatorTurnContract", draft, assertCreatorTurnContract);
}

export function sealCreatorControlView(draft: RecordDraft<CreatorControlView>): CreatorControlView {
  return sealRecord("CreatorControlView", draft, assertCreatorControlView);
}

export function sealCreatorConversationCommit(
  draft: RecordDraft<CreatorConversationCommit>,
): CreatorConversationCommit {
  return sealRecord("CreatorConversationCommit", draft, assertCreatorConversationCommit);
}

export function creatorWorkRequestHash(request: CreatorTurnRequest | CreatorActionRequest): string {
  if (request.kind === "CreatorTurnRequest") assertCreatorTurnRequest(request);
  else assertCreatorActionRequest(request);
  return contentHash(`${stableJson(request)}\n`);
}

export function assertCreatorWorkJobRequestBinding(
  job: CreatorWorkJob,
  request: CreatorTurnRequest | CreatorActionRequest,
): void {
  assertCreatorWorkJob(job);
  if (
    job.requestHash !== creatorWorkRequestHash(request) ||
    job.idempotencyKey !== request.idempotencyKey ||
    job.conversationId !== request.conversationId ||
    (request.kind === "CreatorTurnRequest" && job.selectedModelId !== request.selectedModelId)
  )
    throw new Error("Creator work job is bound to another admitted request");
  if (
    request.kind === "CreatorTurnRequest" &&
    (job.agentExecutions.length !== 1 || job.agentExecutions[0]?.purpose !== "planner")
  )
    throw new Error("Creator turn job requires exactly one planner execution reservation");
}

export function assertCreatorRecordIdentity(
  value:
    | CreatorProjectConversation
    | CreatorConversationTurn
    | CreatorCitation
    | CreatorWorkEpisode
    | CreatorConversationEvent
    | CreatorMemoryRevision
    | CreatorPlanRevision
    | CreatorWorkJob
    | CreatorModelRegistry
    | CreatorTurnContract
    | CreatorControlView
    | CreatorConversationCommit,
): void {
  const { hash, ...payload } = value;
  if (contentHash(stableJson(payload)) !== hash)
    throw new Error(`Invalid ${value.kind} content identity`);
}

function sealRecord<
  T extends { readonly kind: string; readonly id: string; readonly hash: string },
>(kind: T["kind"], draft: RecordDraft<T>, assertion: (value: unknown) => asserts value is T): T {
  const canonical = JSON.parse(stableJson({ kind, ...draft })) as Omit<T, "hash">;
  const sealed = { ...canonical, hash: contentHash(stableJson(canonical)) } as T;
  assertion(sealed);
  assertCreatorRecordIdentity(
    sealed as unknown as Parameters<typeof assertCreatorRecordIdentity>[0],
  );
  return sealed;
}

function assertCreatorConversationAppendInput(input: CreatorConversationAppendInput): void {
  assertCreatorProjectConversation(input.conversation);
  assertCreatorRecordIdentity(input.conversation);
  assertCreatorConversationEvent(input.event);
  assertCreatorRecordIdentity(input.event);
  if (input.episode !== undefined) {
    assertCreatorWorkEpisode(input.episode);
    assertCreatorRecordIdentity(input.episode);
  }
  if (input.turn !== undefined) {
    assertCreatorConversationTurn(input.turn);
    assertCreatorRecordIdentity(input.turn);
  }
  if (input.memoryRevision !== undefined) {
    assertCreatorMemoryRevision(input.memoryRevision);
    assertCreatorRecordIdentity(input.memoryRevision);
  }
  if (input.planRevision !== undefined) {
    assertCreatorPlanRevision(input.planRevision);
    assertCreatorRecordIdentity(input.planRevision);
  }
  if (input.job !== undefined) {
    assertCreatorWorkJob(input.job);
    assertCreatorRecordIdentity(input.job);
  }
  if (input.expectedHead !== undefined && input.expectedHead !== null) {
    if (!Number.isSafeInteger(input.expectedHead.sequence) || input.expectedHead.sequence <= 0)
      throw new Error("Invalid expected conversation-head sequence");
    assertHash(input.expectedHead.commitHash, "expected conversation-head hash");
  }
}

function validateAppendTransition(
  input: CreatorConversationAppendInput,
  current: LoadedCreatorConversation | undefined,
): void {
  const conversationId = input.conversation.id;
  if (input.event.conversationId !== conversationId)
    throw new Error("Conversation event is bound to another conversation");
  const expectedSequence = (current?.head.sequence ?? 0) + 1;
  if (
    input.event.sequence !== expectedSequence ||
    input.conversation.latestEventSequence !== expectedSequence
  )
    throw new Error("Conversation append sequence is not the exact next sequence");
  if (input.event.episodeId !== undefined) {
    if (input.episode?.id !== input.event.episodeId)
      throw new Error("Episode-bearing event requires its exact episode snapshot");
  } else if (input.episode !== undefined) {
    throw new Error("Conversation event is missing its episode binding");
  }
  if (input.episode !== undefined) {
    if (
      input.episode.conversationId !== conversationId ||
      !input.conversation.episodeIds.includes(input.episode.id)
    )
      throw new Error("Conversation episode snapshot binding mismatch");
  }
  validateAssociatedEventRecords(input);
  validateAgentTurnCitationBindings(input.turn, current);
  if (current === undefined) {
    if (input.conversation.latestEventSequence !== 1)
      throw new Error("Initial conversation append must have sequence one");
    return;
  }
  const prior = current.conversation;
  if (
    (stableJson(prior.project) !== stableJson(input.conversation.project) &&
      !isPublishedContinuityTransition(prior, input.conversation, input.event)) ||
    prior.createdAt !== input.conversation.createdAt
  )
    throw new Error("Conversation immutable identity changed across snapshots");
  if (Date.parse(input.conversation.updatedAt) < Date.parse(prior.updatedAt))
    throw new Error("Conversation updatedAt moved backwards");
  if (Date.parse(input.event.occurredAt) < Date.parse(current.events.at(-1)!.occurredAt))
    throw new Error("Conversation event time moved backwards");
  if (
    prior.episodeIds.length > input.conversation.episodeIds.length ||
    !prior.episodeIds.every((id, index) => input.conversation.episodeIds[index] === id)
  )
    throw new Error("Conversation episode history is not append-only");
  assertMemoryHeadTransition(prior, input.conversation, input.memoryRevision);
  if (input.planRevision) {
    const previous = current.planRevisions
      .filter((candidate) => candidate.episodeId === input.planRevision!.episodeId)
      .at(-1);
    if (
      input.planRevision.revision !== (previous?.revision ?? 0) + 1 ||
      (previous === undefined && input.planRevision.supersedes !== undefined) ||
      (previous !== undefined &&
        (input.planRevision.supersedes?.id !== previous.id ||
          input.planRevision.supersedes.hash !== previous.hash))
    )
      throw new Error("Plan revision does not extend the exact prior proposal");
  }
  if (
    input.event.eventType === "decision" &&
    ["build", "revise_plan", "reject_plan"].includes(input.event.data.decision)
  ) {
    const plan = input.event.binding?.planRevisionId
      ? current.planRevisions.find(
          (candidate) => candidate.id === input.event.binding?.planRevisionId,
        )
      : undefined;
    if (
      !plan ||
      plan.hash !== input.event.binding?.planRevisionHash ||
      plan.episodeId !== input.event.episodeId
    )
      throw new Error("Plan decision is not bound to its exact immutable revision");
  }
  if (input.job?.resumesJob) {
    const priorJob = current.jobs.find((candidate) => candidate.id === input.job?.resumesJob?.id);
    if (!priorJob || priorJob.hash !== input.job.resumesJob.hash)
      throw new Error("Resumed work job does not bind the exact prior terminal job");
  }
  if (input.job) {
    const priorSnapshot = current.jobs.find((priorJob) => priorJob.id === input.job?.id);
    if (priorSnapshot) assertJobSnapshotProgression(priorSnapshot, input.job);
    for (const priorJob of current.jobs) {
      if (priorJob.id === input.job.id) continue;
      for (const execution of input.job.agentExecutions) {
        if (
          priorJob.agentExecutions.some(
            (priorExecution) =>
              priorExecution.agentRunId === execution.agentRunId ||
              priorExecution.journalId === execution.journalId,
          )
        )
          if (
            !isSameJournalResponseResume(priorJob, input.job) &&
            !isSameJournalResponseResume(input.job, priorJob)
          )
            throw new Error("Creator work job reuses an existing provider execution identity");
      }
    }
  }
}

/**
 * Memory and prior-evidence citations can only enter an agent turn through
 * host-issued context.  Verify that their immutable targets were already in
 * this conversation before accepting the new append.  Project/source handles
 * are instead validated by the lower transaction's exact source/index graph.
 */
function validateAgentTurnCitationBindings(
  turn: CreatorConversationTurn | undefined,
  current: LoadedCreatorConversation | undefined,
): void {
  if (turn?.role !== "agent") return;
  for (const citation of turn.citations) {
    const target = citation.target;
    if (target.kind === "memory") {
      const { memoryItemId, revisionId, revisionHash } = target;
      const revision = current?.memoryRevisions.find(
        (candidate) =>
          candidate.itemId === memoryItemId &&
          candidate.id === revisionId &&
          candidate.hash === revisionHash,
      );
      if (!revision)
        throw new Error("Creator-memory citation was not issued from prior conversation history");
      continue;
    }
    if (target.kind !== "prior_evidence") continue;
    const { eventId, eventHash, evidence: evidenceBinding } = target;
    const event = current?.events.find(
      (candidate) => candidate.id === eventId && candidate.hash === eventHash,
    );
    if (!event)
      throw new Error("Prior-evidence citation was not issued from prior conversation history");
    const evidence = event.attachments.find(
      (attachment) =>
        attachment.binding.id === evidenceBinding.id &&
        attachment.binding.hash === evidenceBinding.hash &&
        stableJson(attachment.binding.artifact) === stableJson(evidenceBinding.artifact),
    );
    if (!evidence)
      throw new Error("Prior-evidence citation does not bind an attachment from its cited event");
  }
}

function validateAssociatedEventRecords(input: CreatorConversationAppendInput): void {
  const { event } = input;
  const sameBinding = (
    binding: { readonly id: string; readonly hash: string },
    value: { readonly id: string; readonly hash: string } | undefined,
    label: string,
  ): void => {
    if (value === undefined || binding.id !== value.id || binding.hash !== value.hash)
      throw new Error(`${label} event record binding mismatch`);
  };
  const turnBinding = eventTurnBinding(event);
  if (turnBinding !== undefined) {
    sameBinding(turnBinding, input.turn, "Conversation turn");
    if (
      event.eventType === "creator_turn" &&
      (input.turn?.role !== "creator" ||
        event.data.turnType !== input.turn.turnType ||
        event.data.text !== input.turn.text ||
        event.data.selectedModelId !== input.turn.selectedModelId)
    )
      throw new Error("Creator-turn presentation does not match its immutable turn");
    if (
      event.eventType === "agent_turn" &&
      (input.turn?.role !== "agent" ||
        event.data.outcome !== input.turn.outcome ||
        event.data.modelId !== input.turn.modelId ||
        event.data.providerId !== input.turn.providerId ||
        event.data.responseModelId !== input.turn.responseModelId ||
        event.data.agentRunId !== input.turn.agentRunId ||
        stableJson(event.data.timing) !== stableJson(input.turn.timing) ||
        stableJson(event.data.usage) !== stableJson(input.turn.usage) ||
        event.data.text !== input.turn.text ||
        stableJson(event.data.citations) !== stableJson(input.turn.citations))
    )
      throw new Error("Agent-turn presentation does not match its immutable turn");
    if (
      event.eventType === "decision" &&
      (input.turn?.role !== "creator" ||
        input.turn.turnType !== "plan_refinement" ||
        event.data.refinement?.text !== input.turn.text ||
        event.data.refinement?.selectedModelId !== input.turn.selectedModelId)
    )
      throw new Error("Plan-refinement decision does not match its immutable creator turn");
  } else if (input.turn !== undefined) {
    throw new Error("Turn record requires a turn event");
  }
  if (event.eventType === "plan_revision")
    sameBinding(event.data.planRevision, input.planRevision, "Plan revision");
  else if (input.planRevision !== undefined)
    throw new Error("Plan revision record requires a plan event");
  if (event.eventType === "memory")
    sameBinding(event.data.memoryRevision, input.memoryRevision, "Memory revision");
  else if (input.memoryRevision !== undefined)
    throw new Error("Memory revision record requires a memory event");
  const jobBinding = eventJobBinding(event);
  if (jobBinding !== undefined) sameBinding(jobBinding, input.job, "Work job");
  else if (input.job !== undefined)
    throw new Error("Work job record requires an event that publishes its exact binding");
}

async function verifyExternalBindings(
  store: ImmutableJsonArtifactStore,
  input: CreatorConversationAppendInput,
): Promise<void> {
  const references = new Map<string, ArtifactReference>();
  const bindings: CreatorArtifactBinding[] = [];
  const add = (reference: ArtifactReference): void => {
    references.set(reference.artifactHash, reference);
  };
  const addBinding = (binding: CreatorArtifactBinding): void => {
    bindings.push(binding);
  };
  if (input.episode !== undefined) addBinding(input.episode.sessionBundle);
  for (const attachment of input.event.attachments) addBinding(attachment.binding);
  for (const binding of eventDataArtifactBindings(input.event)) addBinding(binding);
  if (input.planRevision !== undefined) {
    addBinding(input.planRevision.plan);
    if (input.planRevision.sourceConsultation !== undefined)
      addBinding(input.planRevision.sourceConsultation);
  }
  if (input.turn?.role === "agent")
    for (const citation of input.turn.citations)
      if (citation.target.kind === "prior_evidence") addBinding(citation.target.evidence);
  if (input.job !== undefined) add(input.job.admittedRequest);
  if (input.job !== undefined) add(input.job.admissionAuthority);
  if (input.job?.conversationContext !== undefined) add(input.job.conversationContext);
  await verifyReachableArtifactGraph(store, references.values(), bindings);
  await verifyPublishedIdentityEvent(store, input.event);
}

async function verifyReachableArtifactGraph(
  store: ImmutableJsonArtifactStore,
  roots: Iterable<ArtifactReference>,
  boundRoots: Iterable<CreatorArtifactBinding> = [],
): Promise<void> {
  const pending: ReachableArtifact[] = [
    ...[...roots].map((reference) => ({ reference })),
    ...[...boundRoots].map((binding) => ({ reference: binding.artifact, binding })),
  ];
  const references = new Map<string, ArtifactReference>();
  const bodies = new Map<string, unknown>();
  while (pending.length > 0) {
    const reachable = pending.pop()!;
    const { reference } = reachable;
    assertArtifactReferenceShape(reference, "reachable artifact");
    const prior = references.get(reference.artifactHash);
    if (prior !== undefined) {
      if (stableJson(prior) !== stableJson(reference))
        throw new Error("Conflicting references identify the same reachable artifact");
      if (reachable.binding !== undefined)
        assertArtifactBindingBodyIdentity(reachable.binding, bodies.get(reference.artifactHash));
      continue;
    }
    if (references.size >= MAX_REACHABLE_ARTIFACTS)
      throw new Error("Creator conversation exceeds maximum reachable artifact count");
    references.set(reference.artifactHash, reference);
    const body = await store.read(reference);
    bodies.set(reference.artifactHash, body);
    if (reachable.binding !== undefined) assertArtifactBindingBodyIdentity(reachable.binding, body);
    pending.push(...nestedArtifacts(body));
  }
}

interface ReachableArtifact {
  readonly reference: ArtifactReference;
  readonly binding?: CreatorArtifactBinding;
}

function nestedArtifacts(value: unknown): ReachableArtifact[] {
  const references: ReachableArtifact[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (Array.isArray(candidate)) {
      pending.push(...candidate);
      continue;
    }
    if (typeof candidate !== "object" || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (stableJson(keys) === stableJson(["artifact", "hash", "id"])) {
      if (typeof record.id !== "string" || !isConversationId(record.id))
        throw new Error("Invalid nested artifact binding ID");
      assertHash(record.hash, "nested artifact binding hash");
      assertArtifactReferenceShape(record.artifact, "nested bound artifact");
      references.push({
        reference: record.artifact,
        binding: record as unknown as CreatorArtifactBinding,
      });
      continue;
    }
    if (stableJson(keys) === stableJson(["artifactHash", "bytes", "locator"])) {
      assertArtifactReferenceShape(record, "nested artifact");
      references.push({ reference: record as unknown as ArtifactReference });
      continue;
    }
    pending.push(...Object.values(record));
  }
  return references;
}

function assertArtifactBindingBodyIdentity(binding: CreatorArtifactBinding, body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("Bound creator artifact does not contain an object body");
  const record = body as Record<string, unknown>;
  if (record.id !== undefined && record.id !== binding.id)
    throw new Error("Creator artifact binding ID does not match its body");
  if (record.hash !== undefined) {
    assertHash(record.hash, "bound creator artifact body hash");
    if (record.hash !== binding.hash)
      throw new Error("Creator artifact binding hash does not match its body");
  }
}

async function verifyPublishedIdentityEvent(
  store: ImmutableJsonArtifactStore,
  event: CreatorConversationEvent,
): Promise<void> {
  if (
    event.eventType !== "project_identity" ||
    !["published_continuity", "published_new"].includes(event.data.state)
  )
    return;
  const binding = event.data.continuityReceipt!;
  const receipt = await store.read(
    binding.artifact,
    assertCreatorPublishedIdentityContinuityReceipt,
  );
  if (
    receipt.id !== binding.id ||
    receipt.hash !== binding.hash ||
    stableJson(receipt.publishedIdentity) !== stableJson(event.data.project) ||
    (event.data.state === "published_continuity" &&
      (receipt.choice !== "continue_conversation" ||
        receipt.sourceConversationId !== event.conversationId)) ||
    (event.data.state === "published_new" && receipt.choice !== "start_new_conversation")
  )
    throw new Error("Published project identity event has an invalid continuity receipt");
}

function eventDataArtifactBindings(event: CreatorConversationEvent): CreatorArtifactLike[] {
  switch (event.eventType) {
    case "creator_turn":
      return [event.data.turn, ...(event.data.job ? [event.data.job] : [])];
    case "agent_turn":
      return [event.data.turn];
    case "activity":
    case "job":
      return [event.data.job];
    case "decision":
      return [
        ...(event.data.job ? [event.data.job] : []),
        ...(event.data.refinement ? [event.data.refinement.turn] : []),
      ];
    case "plan_revision":
      return [event.data.planRevision];
    case "change_set":
      return [event.data.changeSet];
    case "verification":
      return [event.data.verification];
    case "final_review":
      return event.data.report === undefined ? [] : [event.data.report];
    case "memory":
      return [event.data.memoryRevision];
    default:
      return [];
  }
}

function eventTurnBinding(event: CreatorConversationEvent): CreatorArtifactBinding | undefined {
  if (event.eventType === "creator_turn" || event.eventType === "agent_turn")
    return event.data.turn;
  return event.eventType === "decision" ? event.data.refinement?.turn : undefined;
}

function eventJobBinding(event: CreatorConversationEvent): CreatorArtifactBinding | undefined {
  if (event.eventType === "activity" || event.eventType === "job") return event.data.job;
  if (event.eventType === "creator_turn" || event.eventType === "decision") return event.data.job;
  return undefined;
}

interface CreatorArtifactLike {
  readonly id: string;
  readonly hash: string;
  readonly artifact: ArtifactReference;
}

async function loadOptionalCommitRecords(input: {
  store: ImmutableJsonArtifactStore;
  commit: CreatorConversationCommit;
  event: CreatorConversationEvent;
  episodes: Map<string, CreatorWorkEpisode>;
  turns: Map<string, CreatorConversationTurn>;
  citations: Map<string, CreatorCitation>;
  memoryRevisions: Map<string, CreatorMemoryRevision>;
  planRevisions: Map<string, CreatorPlanRevision>;
  jobs: Map<string, CreatorWorkJob>;
  newerEpisodeSnapshots: Map<string, CreatorWorkEpisode>;
  newerJobSnapshots: Map<string, CreatorWorkJob>;
}): Promise<void> {
  const { store, commit, event } = input;
  await verifyPublishedIdentityEvent(store, event);
  if (commit.episodeSnapshot !== undefined) {
    const episode = await store.read(commit.episodeSnapshot, assertCreatorWorkEpisode);
    assertCreatorRecordIdentity(episode);
    assertRecordBinding(
      episode,
      commit.episodeId,
      commit.episodeHash,
      event.conversationId,
      "episode",
    );
    if (event.episodeId !== episode.id) throw new Error("Commit episode/event binding mismatch");
    const newer = input.newerEpisodeSnapshots.get(episode.id);
    if (newer === undefined) input.episodes.set(episode.id, episode);
    else assertEpisodeSnapshotProgression(episode, newer);
    input.newerEpisodeSnapshots.set(episode.id, episode);
  } else if (event.episodeId !== undefined) {
    throw new Error("Episode event commit is missing an episode snapshot");
  }
  if (commit.turn !== undefined) {
    const turn = await store.read(commit.turn, assertCreatorConversationTurn);
    assertCreatorRecordIdentity(turn);
    assertRecordBinding(turn, commit.turnId, commit.turnHash, event.conversationId, "turn");
    const eventTurn = eventTurnBinding(event);
    if (eventTurn === undefined || eventTurn.id !== turn.id || eventTurn.hash !== turn.hash)
      throw new Error("Commit turn/event binding mismatch");
    if (input.turns.has(turn.id)) throw new Error("Duplicate conversation turn ID");
    input.turns.set(turn.id, turn);
  } else if (eventTurnBinding(event) !== undefined) {
    throw new Error("Turn event commit is missing its turn artifact");
  }
  for (const citationBinding of commit.citations) {
    const citation = await store.read(citationBinding.artifact, assertCreatorCitation);
    assertCreatorRecordIdentity(citation);
    assertRecordBinding(
      citation,
      citationBinding.id,
      citationBinding.hash,
      event.conversationId,
      "citation",
    );
    if (input.citations.has(citation.id)) throw new Error("Duplicate conversation citation ID");
    input.citations.set(citation.id, citation);
  }
  if (commit.turn !== undefined) {
    const turn = input.turns.get(commit.turnId!)!;
    const expected = turn.role === "agent" ? turn.citations.map((citation) => citation.id) : [];
    const actual = commit.citations.map((citation) => citation.id);
    if (stableJson(expected) !== stableJson(actual))
      throw new Error("Commit citation list does not match its turn");
  } else if (commit.citations.length > 0) {
    throw new Error("Commit citations require an agent turn");
  }
  if (commit.memoryRevision !== undefined) {
    const memory = await store.read(commit.memoryRevision, assertCreatorMemoryRevision);
    assertCreatorRecordIdentity(memory);
    assertRecordBinding(
      memory,
      commit.memoryRevisionId,
      commit.memoryRevisionHash,
      event.conversationId,
      "memory revision",
    );
    if (event.eventType !== "memory" || event.data.memoryRevision.id !== memory.id)
      throw new Error("Commit memory/event binding mismatch");
    if (input.memoryRevisions.has(memory.id)) throw new Error("Duplicate memory revision ID");
    input.memoryRevisions.set(memory.id, memory);
  } else if (event.eventType === "memory") {
    throw new Error("Memory event commit is missing its revision artifact");
  }
  if (commit.planRevision !== undefined) {
    const plan = await store.read(commit.planRevision, assertCreatorPlanRevision);
    assertCreatorRecordIdentity(plan);
    assertRecordBinding(
      plan,
      commit.planRevisionId,
      commit.planRevisionHash,
      event.conversationId,
      "plan revision",
    );
    if (event.eventType !== "plan_revision" || event.data.planRevision.id !== plan.id)
      throw new Error("Commit plan/event binding mismatch");
    if (input.planRevisions.has(plan.id)) throw new Error("Duplicate plan revision ID");
    input.planRevisions.set(plan.id, plan);
  } else if (event.eventType === "plan_revision") {
    throw new Error("Plan event commit is missing its revision artifact");
  }
  if (commit.job !== undefined) {
    const job = await store.read(commit.job, assertCreatorWorkJob);
    assertCreatorRecordIdentity(job);
    const admittedRequest = await store.read(job.admittedRequest);
    if (
      typeof admittedRequest === "object" &&
      admittedRequest !== null &&
      "kind" in admittedRequest &&
      admittedRequest.kind === "CreatorTurnRequest"
    )
      assertCreatorTurnRequest(admittedRequest);
    else assertCreatorActionRequest(admittedRequest);
    assertCreatorWorkJobRequestBinding(job, admittedRequest);
    if (admittedRequest.kind === "CreatorTurnRequest") {
      const authority = await store.read(job.admissionAuthority, assertCreatorTurnContract);
      assertCreatorRecordIdentity(authority);
      if (
        authority.id !== admittedRequest.turnContractId ||
        authority.hash !== admittedRequest.turnContractHash ||
        authority.conversationId !== job.conversationId
      )
        throw new Error("Agent job turn-contract authority binding mismatch");
    } else {
      const authority = await store.read(job.admissionAuthority, assertCreatorControlView);
      assertCreatorRecordIdentity(authority);
      if (
        authority.id !== admittedRequest.viewId ||
        authority.hash !== admittedRequest.viewHash ||
        authority.conversationId !== job.conversationId
      )
        throw new Error("Action job control-view authority binding mismatch");
      const descriptor = assertCreatorActionRequestBinding(authority, admittedRequest);
      assertJobExecutionAuthority(
        job,
        descriptor.actionId,
        admittedRequest,
        job.episodeId ? input.episodes.get(job.episodeId) : undefined,
        authority,
      );
      const isResumeAction =
        descriptor.actionId === "resume_work" || descriptor.actionId === "retry_work";
      if (isResumeAction !== (job.resumesJob !== undefined))
        throw new Error("Agent resume job lost its exact creator action binding");
    }
    assertRecordBinding(job, commit.jobId, commit.jobHash, event.conversationId, "job");
    const eventJob = eventJobBinding(event);
    if (eventJob === undefined || eventJob.id !== job.id || eventJob.hash !== job.hash)
      throw new Error("Commit job/event binding mismatch");
    const newer = input.newerJobSnapshots.get(job.id);
    if (newer === undefined) input.jobs.set(job.id, job);
    else assertJobSnapshotProgression(job, newer);
    input.newerJobSnapshots.set(job.id, job);
  } else if (eventJobBinding(event) !== undefined) {
    throw new Error("Job event commit is missing its job artifact");
  }
}

function assertConversationSnapshotProgression(
  older: CreatorProjectConversation,
  newer: CreatorProjectConversation,
  newerEvent: CreatorConversationEvent,
): void {
  if (
    older.id !== newer.id ||
    older.createdAt !== newer.createdAt ||
    (stableJson(older.project) !== stableJson(newer.project) &&
      !isPublishedContinuityTransition(older, newer, newerEvent)) ||
    older.latestEventSequence >= newer.latestEventSequence ||
    Date.parse(older.updatedAt) > Date.parse(newer.updatedAt) ||
    older.episodeIds.length > newer.episodeIds.length ||
    !older.episodeIds.every((id, index) => newer.episodeIds[index] === id)
  )
    throw new Error("Creator conversation snapshots violate append-only progression");
}

function isPublishedContinuityTransition(
  prior: CreatorProjectConversation,
  next: CreatorProjectConversation,
  event: CreatorConversationEvent,
): boolean {
  return (
    prior.project.kind === "local_linked" &&
    next.project.kind === "published" &&
    event.eventType === "project_identity" &&
    event.authority === "creator" &&
    event.data.state === "published_continuity" &&
    stableJson(event.data.project) === stableJson(next.project) &&
    event.data.continuityReceipt !== undefined &&
    event.attachments.some(
      (attachment) =>
        attachment.role === "project_identity" &&
        attachment.binding.id === event.data.continuityReceipt!.id &&
        attachment.binding.hash === event.data.continuityReceipt!.hash &&
        stableJson(attachment.binding.artifact) ===
          stableJson(event.data.continuityReceipt!.artifact),
    )
  );
}

function assertMemoryHeadTransition(
  prior: CreatorProjectConversation,
  next: CreatorProjectConversation,
  revision: CreatorMemoryRevision | undefined,
): void {
  const heads = new Map(prior.memoryHeads.map((head) => [head.itemId, head]));
  if (revision !== undefined) {
    const previous = heads.get(revision.itemId);
    if (revision.revision === 1) {
      if (previous !== undefined) throw new Error("Memory item was introduced twice");
    } else if (
      previous === undefined ||
      previous.revisionId !== revision.priorRevision?.id ||
      previous.revisionHash !== revision.priorRevision.hash
    ) {
      throw new Error("Memory revision does not extend the current head");
    }
    heads.set(revision.itemId, {
      itemId: revision.itemId,
      revisionId: revision.id,
      revisionHash: revision.hash,
    });
  }
  const expected = [...heads.values()].sort((left, right) =>
    left.itemId.localeCompare(right.itemId),
  );
  if (stableJson(expected) !== stableJson(next.memoryHeads))
    throw new Error("Conversation memory heads changed without their exact revision");
}

function assertConversationMemoryHeads(
  conversation: CreatorProjectConversation,
  revisions: ReadonlyMap<string, CreatorMemoryRevision>,
): void {
  const latest = new Map<string, CreatorMemoryRevision>();
  for (const revision of revisions.values()) {
    const current = latest.get(revision.itemId);
    if (current === undefined || revision.revision > current.revision)
      latest.set(revision.itemId, revision);
  }
  const expected = [...latest.values()]
    .map((revision) => ({
      itemId: revision.itemId,
      revisionId: revision.id,
      revisionHash: revision.hash,
    }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
  if (stableJson(expected) !== stableJson(conversation.memoryHeads))
    throw new Error("Conversation memory heads do not match immutable revision history");
}

function assertConversationEpisodeTopology(
  conversation: CreatorProjectConversation,
  episodes: ReadonlyMap<string, CreatorWorkEpisode>,
  turns: ReadonlyMap<string, CreatorConversationTurn>,
  jobs: ReadonlyMap<string, CreatorWorkJob>,
): void {
  const ordered = [...episodes.values()].sort((left, right) => left.ordinal - right.ordinal);
  if (
    ordered.length !== conversation.episodeIds.length ||
    ordered.some(
      (episode, index) =>
        episode.id !== conversation.episodeIds[index] || episode.ordinal !== index + 1,
    )
  )
    throw new Error("Conversation episode IDs do not match immutable episode history");
  if (ordered.length > 0 && conversation.activeEpisodeId !== ordered.at(-1)!.id)
    throw new Error("Conversation active episode is not the latest immutable episode");
  for (const episode of ordered) {
    const creatorTurn = turns.get(episode.creatorTurnId);
    if (
      creatorTurn?.role !== "creator" ||
      creatorTurn.conversationId !== conversation.id ||
      (creatorTurn.episodeId !== undefined && creatorTurn.episodeId !== episode.id)
    )
      throw new Error("Work episode is not bound to its exact creator turn");
    if (episode.activeJob) {
      const job = jobs.get(episode.activeJob.id);
      if (
        !job ||
        job.hash !== episode.activeJob.hash ||
        job.episodeId !== episode.id ||
        terminalJobStatus(job.status)
      )
        throw new Error("Work episode active job is not an exact nonterminal job snapshot");
    }
    if (episode.predecessorEpisodeId) {
      const predecessor = episodes.get(episode.predecessorEpisodeId);
      if (
        !predecessor ||
        (predecessor.successorEpisodeId !== undefined &&
          predecessor.successorEpisodeId !== episode.id)
      )
        throw new Error("Work episode predecessor linkage is not reciprocal");
    }
    if (episode.successorEpisodeId) {
      const successor = episodes.get(episode.successorEpisodeId);
      // Publishing a linked successor uses two immutable commits. The first
      // head may point forward while the predecessor is still the active tail;
      // once another episode is active, the reciprocal record is mandatory.
      if (!successor && conversation.activeEpisodeId !== episode.id)
        throw new Error("Work episode successor linkage is incomplete");
      if (successor && successor.predecessorEpisodeId !== episode.id)
        throw new Error("Work episode successor linkage is not reciprocal");
    }
  }
  for (const turn of turns.values()) {
    if (turn.conversationId !== conversation.id)
      throw new Error("Conversation contains a turn from another project");
    if (turn.role === "agent" && (!turn.episodeId || !episodes.has(turn.episodeId)))
      throw new Error("Agent turn is not bound to an immutable work episode");
  }
  for (const job of jobs.values()) {
    if (!job.episodeId || terminalJobStatus(job.status)) continue;
    const episode = episodes.get(job.episodeId);
    if (episode?.activeJob?.id !== job.id || episode.activeJob.hash !== job.hash)
      throw new Error("Nonterminal work job is not the episode's exact active job");
  }
}

function assertPlanRevisionTopology(
  conversation: CreatorProjectConversation,
  episodes: ReadonlyMap<string, CreatorWorkEpisode>,
  revisions: ReadonlyMap<string, CreatorPlanRevision>,
  events: readonly CreatorConversationEvent[],
): void {
  const byEpisode = new Map<string, CreatorPlanRevision[]>();
  for (const revision of revisions.values()) {
    if (revision.conversationId !== conversation.id || !episodes.has(revision.episodeId))
      throw new Error("Plan revision is outside its immutable conversation episode");
    const existing = byEpisode.get(revision.episodeId) ?? [];
    existing.push(revision);
    byEpisode.set(revision.episodeId, existing);
  }
  for (const [episodeId, candidates] of byEpisode) {
    const ordered = candidates.sort((left, right) => left.revision - right.revision);
    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index]!;
      const prior = ordered[index - 1];
      if (current.revision !== index + 1)
        throw new Error("Plan revisions must be contiguous within a work episode");
      if (
        (prior === undefined && current.supersedes !== undefined) ||
        (prior !== undefined &&
          (current.supersedes?.id !== prior.id || current.supersedes.hash !== prior.hash))
      )
        throw new Error("Plan revision does not supersede the exact prior proposal");
    }
    const episode = episodes.get(episodeId)!;
    const latest = ordered.at(-1)!;
    if (episode.planRevision?.id !== latest.id || episode.planRevision.hash !== latest.hash)
      throw new Error("Work episode does not bind its latest immutable plan revision");
  }
  for (const event of events) {
    if (event.eventType !== "decision") continue;
    if (!["build", "revise_plan", "reject_plan"].includes(event.data.decision)) continue;
    const plan = event.binding?.planRevisionId
      ? revisions.get(event.binding.planRevisionId)
      : undefined;
    if (
      !plan ||
      plan.hash !== event.binding?.planRevisionHash ||
      plan.episodeId !== event.episodeId
    )
      throw new Error("Plan decision is not bound to its exact immutable revision");
  }
}

function assertEpisodeSnapshotProgression(
  older: CreatorWorkEpisode,
  newer: CreatorWorkEpisode,
): void {
  if (
    older.id !== newer.id ||
    older.conversationId !== newer.conversationId ||
    older.ordinal !== newer.ordinal ||
    older.selectedModelId !== newer.selectedModelId ||
    older.initialProjectRevisionHash !== newer.initialProjectRevisionHash ||
    older.creatorTurnId !== newer.creatorTurnId ||
    older.createdAt !== newer.createdAt ||
    older.predecessorEpisodeId !== newer.predecessorEpisodeId ||
    Date.parse(older.updatedAt) > Date.parse(newer.updatedAt) ||
    !isEpisodeStatusTransition(older.status, newer.status)
  )
    throw new Error("Creator work-episode snapshots violate immutable identity or status order");
  if (
    older.successorEpisodeId !== undefined &&
    older.successorEpisodeId !== newer.successorEpisodeId
  )
    throw new Error("Creator work-episode successor binding changed");
}

function assertJobSnapshotProgression(older: CreatorWorkJob, newer: CreatorWorkJob): void {
  const changed: string[] = [];
  if (older.id !== newer.id) changed.push("id");
  if (older.conversationId !== newer.conversationId) changed.push("conversationId");
  if (older.episodeId !== newer.episodeId) changed.push("episodeId");
  if (older.turnId !== newer.turnId) changed.push("turnId");
  if (older.idempotencyKey !== newer.idempotencyKey) changed.push("idempotencyKey");
  if (older.requestHash !== newer.requestHash) changed.push("requestHash");
  if (older.admittedRequest.artifactHash !== newer.admittedRequest.artifactHash)
    changed.push("admittedRequest");
  if (older.admissionAuthority.artifactHash !== newer.admissionAuthority.artifactHash)
    changed.push("admissionAuthority");
  if (stableJson(older.agentExecutions) !== stableJson(newer.agentExecutions))
    changed.push("agentExecutions");
  if (older.jobType !== newer.jobType) changed.push("jobType");
  if (older.selectedModelId !== newer.selectedModelId) changed.push("selectedModelId");
  if (older.transactionSessionId !== newer.transactionSessionId)
    changed.push("transactionSessionId");
  if (
    older.resumesJob?.id !== newer.resumesJob?.id ||
    older.resumesJob?.hash !== newer.resumesJob?.hash
  )
    changed.push("resumesJob");
  if (older.createdAt !== newer.createdAt) changed.push("createdAt");
  if (Date.parse(older.updatedAt) > Date.parse(newer.updatedAt)) changed.push("updatedAt");
  if (!isJobStatusTransition(older.status, newer.status))
    changed.push(`status:${older.status}->${newer.status}`);
  if (!isProviderOutcomeTransition(older.providerOutcome, newer.providerOutcome))
    changed.push(`providerOutcome:${older.providerOutcome}->${newer.providerOutcome}`);
  if (changed.length > 0)
    throw new Error(
      `Creator work-job snapshots violate immutable identity or status order (${changed.join(", ")})`,
    );
  if (older.providerRequestId !== undefined && older.providerRequestId !== newer.providerRequestId)
    throw new Error("Creator work-job provider request binding changed");
  if (
    older.conversationContext !== undefined &&
    older.conversationContext.artifactHash !== newer.conversationContext?.artifactHash
  )
    throw new Error("Creator work-job conversation context binding changed");
}

function assertJobExecutionTopology(jobs: ReadonlyMap<string, CreatorWorkJob>): void {
  const runOwners = new Map<string, string>();
  const journalOwners = new Map<string, string>();
  for (const job of jobs.values()) {
    for (const execution of job.agentExecutions) {
      const runOwner = runOwners.get(execution.agentRunId);
      const journalOwner = journalOwners.get(execution.journalId);
      if ((runOwner && runOwner !== job.id) || (journalOwner && journalOwner !== job.id)) {
        const prior = runOwner
          ? jobs.get(runOwner)
          : journalOwner
            ? jobs.get(journalOwner)
            : undefined;
        if (
          !prior ||
          (!isSameJournalResponseResume(prior, job) && !isSameJournalResponseResume(job, prior))
        )
          throw new Error("Creator work jobs reuse a preassigned provider execution identity");
        continue;
      }
      runOwners.set(execution.agentRunId, job.id);
      journalOwners.set(execution.journalId, job.id);
    }
  }
}

function assertJobExecutionAuthority(
  job: CreatorWorkJob,
  actionId: CreatorControlActionDescriptor["actionId"],
  request: CreatorActionRequest,
  episode: CreatorWorkEpisode | undefined,
  authority: CreatorControlView,
): void {
  const expectedPurpose =
    actionId === "resume_work" || actionId === "retry_work"
      ? job.agentExecutions[0]?.purpose
      : actionId === "revise_plan"
        ? "planner"
        : actionId === "build_plan"
          ? "builder"
          : actionId === "refresh_project"
            ? "planner"
            : actionId === "apply_changes" || actionId === "retry_play"
              ? "repair"
              : undefined;
  if (
    job.agentExecutions.length !== (expectedPurpose ? 1 : 0) ||
    (expectedPurpose !== undefined && job.agentExecutions[0]?.purpose !== expectedPurpose)
  )
    throw new Error("Creator work job execution reservation exceeds its exact action authority");
  // The action binding below is the only place a duplicate execution identity
  // can become authority: a response resume reuses one exact journal, while
  // retry_work always owns a fresh reservation.
  if (
    job.resumesJob !== undefined &&
    actionId !== "resume_work" &&
    job.providerOutcome === "response_persisted"
  )
    throw new Error("Only resume_work may consume a persisted provider response journal");
  if (actionId === "revise_plan") {
    if (
      job.selectedModelId !== request.input?.selectedModelId ||
      request.input?.modelRegistryHash !== authority.turnContract?.modelRegistryHash
    )
      throw new Error("Plan-refinement job model differs from its exact creator request");
  } else if (
    expectedPurpose !== undefined &&
    !["resume_work", "retry_work"].includes(actionId) &&
    (!episode || job.selectedModelId !== episode.selectedModelId)
  ) {
    throw new Error("Provider-capable action job model differs from its work episode");
  }
}

function assertJobResumeTopology(jobs: ReadonlyMap<string, CreatorWorkJob>): void {
  for (const job of jobs.values()) {
    if (!job.resumesJob) continue;
    const prior = jobs.get(job.resumesJob.id);
    if (
      !prior ||
      prior.hash !== job.resumesJob.hash ||
      !["agent_turn", "agent_action"].includes(prior.jobType) ||
      job.jobType !== prior.jobType ||
      !["failed", "outcome_unknown"].includes(prior.status) ||
      prior.turnId !== job.turnId ||
      prior.episodeId !== job.episodeId ||
      prior.selectedModelId !== job.selectedModelId ||
      prior.agentExecutions[0]?.purpose !== job.agentExecutions[0]?.purpose ||
      Date.parse(prior.updatedAt) > Date.parse(job.createdAt)
    )
      throw new Error("Resumed work job is not bound to an exact terminal agent job");
    if (
      stableJson(prior.agentExecutions) === stableJson(job.agentExecutions) &&
      !isSameJournalResponseResume(prior, job)
    )
      throw new Error("Resumed work may reuse an execution journal only at a response boundary");
  }
}

/**
 * A response resume is a continuation of an already-received provider result,
 * not a second provider execution. The reference must be exact so all other
 * retries retain global execution-identity uniqueness.
 */
function isSameJournalResponseResume(prior: CreatorWorkJob, job: CreatorWorkJob): boolean {
  return (
    job.resumesJob?.id === prior.id &&
    job.resumesJob.hash === prior.hash &&
    prior.jobType === "agent_turn" &&
    job.jobType === "agent_turn" &&
    prior.status === "failed" &&
    prior.providerOutcome === "response_persisted" &&
    prior.failure?.code === "agent_execution_response_ready" &&
    job.providerOutcome === "response_persisted" &&
    prior.transactionSessionId !== undefined &&
    prior.transactionSessionId === job.transactionSessionId &&
    prior.conversationContext?.artifactHash === job.conversationContext?.artifactHash &&
    prior.agentExecutions.length === 1 &&
    stableJson(prior.agentExecutions) === stableJson(job.agentExecutions)
  );
}

function isEpisodeStatusTransition(
  from: CreatorWorkEpisode["status"],
  to: CreatorWorkEpisode["status"],
): boolean {
  if (from === to) return true;
  const allowed: Record<CreatorWorkEpisode["status"], readonly CreatorWorkEpisode["status"][]> = {
    indexing: ["planning", "refresh_required", "incomplete"],
    planning: [
      "awaiting_clarification",
      "awaiting_plan_decision",
      "refresh_required",
      "incomplete",
    ],
    awaiting_clarification: ["planning", "refining_plan", "refresh_required", "incomplete"],
    awaiting_plan_decision: [
      "refining_plan",
      "building",
      "rejected",
      "refresh_required",
      "incomplete",
    ],
    refining_plan: [
      "awaiting_clarification",
      "awaiting_plan_decision",
      "refresh_required",
      "incomplete",
    ],
    building: ["awaiting_change_decision", "refresh_required", "incomplete"],
    awaiting_change_decision: ["applying", "rejected", "refresh_required", "incomplete"],
    applying: [
      "awaiting_play",
      "awaiting_review",
      "awaiting_source_sync",
      "recovery_required",
      "incomplete",
    ],
    awaiting_play: ["observing_play", "recovery_required", "incomplete"],
    observing_play: [
      "awaiting_verification_retry",
      "awaiting_review",
      "recovery_required",
      "incomplete",
    ],
    awaiting_verification_retry: ["awaiting_play", "recovery_required", "rejected", "incomplete"],
    awaiting_review: ["accepted", "rejected", "recovery_required", "incomplete"],
    refresh_required: ["superseded", "recovery_required", "incomplete"],
    recovery_required: ["rejected", "incomplete"],
    awaiting_source_sync: ["awaiting_review", "recovery_required", "rejected", "incomplete"],
    accepted: [],
    rejected: [],
    superseded: [],
    incomplete: [],
  };
  return allowed[from].includes(to);
}

function isJobStatusTransition(
  from: CreatorWorkJob["status"],
  to: CreatorWorkJob["status"],
): boolean {
  if (from === to) return true;
  const allowed: Record<CreatorWorkJob["status"], readonly CreatorWorkJob["status"][]> = {
    queued: ["running", "awaiting_external", "outcome_unknown", "succeeded", "failed", "cancelled"],
    running: ["awaiting_external", "outcome_unknown", "succeeded", "failed", "cancelled"],
    awaiting_external: ["running", "outcome_unknown", "succeeded", "failed", "cancelled"],
    outcome_unknown: ["failed", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: [],
  };
  return allowed[from].includes(to);
}

function terminalJobStatus(status: CreatorWorkJob["status"]): boolean {
  return ["succeeded", "failed", "cancelled", "outcome_unknown"].includes(status);
}

function isProviderOutcomeTransition(
  from: CreatorWorkJob["providerOutcome"],
  to: CreatorWorkJob["providerOutcome"],
): boolean {
  if (from === to) return true;
  const allowed: Record<
    CreatorWorkJob["providerOutcome"],
    readonly CreatorWorkJob["providerOutcome"][]
  > = {
    not_applicable: [],
    never_dispatched: [
      "intent_persisted",
      "response_persisted",
      "failure_persisted",
      "outcome_unknown",
    ],
    intent_persisted: ["response_persisted", "failure_persisted", "outcome_unknown"],
    response_persisted: [],
    failure_persisted: [],
    outcome_unknown: [],
  };
  return allowed[from].includes(to);
}

function assertRecordBinding(
  record: { readonly id: string; readonly hash: string; readonly conversationId: string },
  id: string | undefined,
  hash: string | undefined,
  conversationId: string,
  label: string,
): void {
  if (record.id !== id || record.hash !== hash || record.conversationId !== conversationId)
    throw new Error(`Commit ${label} binding mismatch`);
}

function assertLoadedHistoryContinuity(
  commits: readonly CreatorConversationCommit[],
  events: readonly CreatorConversationEvent[],
): void {
  if (commits.length !== events.length || commits.length === 0)
    throw new Error("Creator conversation has an invalid history length");
  const eventIds = new Set<string>();
  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index]!;
    const event = events[index]!;
    if (commit.sequence !== index + 1 || event.sequence !== index + 1)
      throw new Error("Creator conversation history has an invalid sequence");
    if (eventIds.has(event.id)) throw new Error("Creator conversation contains a duplicate event");
    eventIds.add(event.id);
    if (index > 0) {
      const prior = commits[index - 1]!;
      if (commit.previousCommitHash !== prior.hash || commit.previousCommit === undefined)
        throw new Error("Creator conversation previous-commit hash is invalid");
      if (Date.parse(event.occurredAt) < Date.parse(events[index - 1]!.occurredAt))
        throw new Error("Creator conversation event times are unordered");
    }
  }
}

function sortedByOrdinal(values: Iterable<CreatorWorkEpisode>): CreatorWorkEpisode[] {
  return [...values].sort((left, right) => left.ordinal - right.ordinal);
}

function sortedByCreatedAt<T extends { readonly createdAt: string; readonly id: string }>(
  values: Iterable<T>,
): T[] {
  return [...values].sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt),
  );
}

function assertExpectedHead(
  expected: CreatorConversationAppendInput["expectedHead"],
  actual: CreatorConversationHead | undefined,
): void {
  if (expected === undefined) return;
  if (expected === null) {
    if (actual !== undefined) throw new Error("Creator conversation already exists");
    return;
  }
  if (
    actual === undefined ||
    actual.sequence !== expected.sequence ||
    actual.commitHash !== expected.commitHash
  )
    throw new Error("Creator conversation head changed since it was read");
}

function assertCreatorConversationHead(value: unknown): asserts value is CreatorConversationHead {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid CreatorConversationHead");
  const record = value as Record<string, unknown>;
  if (record.kind !== "CreatorConversationHead") throw new Error("Invalid conversation head kind");
  assertConversationId(record.conversationId);
  if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) <= 0)
    throw new Error("Invalid conversation head sequence");
  assertHash(record.conversationHash, "conversation head snapshot hash");
  assertHash(record.commitHash, "conversation head commit hash");
  assertArtifactReferenceShape(record.commit, "conversation head commit");
  assertCanonicalIso(record.updatedAt, "conversation head updatedAt");
}

async function assertReplaceableRegularFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("Unsafe creator conversation head target");
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const descriptor = await open(path, constants.O_RDONLY);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

function assertConversationId(value: unknown): asserts value is string {
  if (!isConversationId(value)) throw new Error("Invalid creator conversation ID");
}

function isConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function assertCanonicalIso(value: unknown, label: string): void {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value)
    throw new Error(`Invalid ${label}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 4096) : "Unknown conversation error";
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
