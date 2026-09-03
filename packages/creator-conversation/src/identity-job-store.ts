import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertStudioProjectIdentityFinalizationReceipt,
  assertStudioProjectIdentityOperation,
  assertBackendToPluginMessage,
  assertStudioCommandSettledPayload,
  identityRejectionProvesNoEffect,
  type BackendToPluginMessage,
  type StudioCommandSettledPayload,
  type StudioProjectIdentityFinalizationReceipt,
  type StudioProjectIdentityOperation,
} from "../../studio-protocol/src/index.js";
import { assertCreatorActionRequest } from "./contracts.js";
import { creatorWorkRequestHash } from "./store.js";

type IdentityJobDraft = Omit<CreatorProjectIdentityJob, "kind" | "hash">;

export type CreatorProjectIdentityJobStatus =
  "queued" | "running" | "awaiting_external" | "outcome_unknown" | "succeeded" | "failed";

export interface CreatorIdentityArtifactBinding {
  readonly id: string;
  readonly hash: string;
  readonly artifact: ArtifactReference;
}

/**
 * Durable foreground journal for Link/Fork admission before a project has a
 * durable conversation identity. It deliberately does not manufacture an
 * unlinked CreatorProjectConversation.
 */
export interface CreatorProjectIdentityJob {
  readonly kind: "CreatorProjectIdentityJob";
  readonly id: string;
  readonly hash: string;
  readonly revision: number;
  readonly provisionalConversationId: string;
  readonly pairedStudioSessionId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly admittedRequest: ArtifactReference;
  readonly command: "link" | "fork";
  readonly executionMode:
    | "initial"
    | "resume_undispatched"
    | "recover_abandon"
    | "recover_cancel"
    | "recover_settle"
    | "finalize_receipt"
    | "host_finalize";
  readonly operation: CreatorIdentityArtifactBinding;
  readonly connectorEpoch: string;
  readonly expectedIdentityStateHash: string;
  readonly assignedForgeProjectId: string;
  readonly status: CreatorProjectIdentityJobStatus;
  readonly phase:
    | "admitted"
    | "dispatch_intent_persisted"
    | "receipt_persisted"
    | "conversation_published"
    | "acknowledgement_pending"
    | "acknowledged"
    | "resume_required"
    | "command_rejected"
    | "studio_outcome_unknown"
    | "identity_transaction_failed";
  readonly receipt?: CreatorIdentityArtifactBinding;
  readonly resultConversationId?: string;
  readonly failure?: {
    readonly code: string;
    readonly detail: string;
    readonly detailHash: string;
    readonly rejection?: {
      readonly command: BackendToPluginMessage;
      readonly settlement: Extract<StudioCommandSettledPayload, { disposition: "rejected" }>;
    };
  };
  readonly previousSnapshot?: ArtifactReference;
  readonly previousSnapshotHash?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatorProjectIdentityJobHead {
  readonly kind: "CreatorProjectIdentityJobHead";
  readonly jobId: string;
  readonly revision: number;
  readonly jobHash: string;
  readonly snapshot: ArtifactReference;
  readonly updatedAt: string;
}

export interface LoadedCreatorProjectIdentityJob {
  readonly head: CreatorProjectIdentityJobHead;
  readonly job: CreatorProjectIdentityJob;
  readonly history: readonly CreatorProjectIdentityJob[];
  readonly references: readonly ArtifactReference[];
}

export interface CreatorProjectIdentityJobEnumeration {
  readonly jobs: readonly LoadedCreatorProjectIdentityJob[];
  readonly corrupt: readonly { readonly headLocator: string; readonly error: string }[];
}

export interface CreatorProjectIdentityJobStoreOptions {
  readonly beforePublishHead?: (
    head: CreatorProjectIdentityJobHead,
    job: CreatorProjectIdentityJob,
  ) => void | Promise<void>;
}

export interface CreatorProjectIdentityJobTransition {
  readonly status: CreatorProjectIdentityJob["status"];
  readonly phase: CreatorProjectIdentityJob["phase"];
  readonly updatedAt: string;
  readonly receipt?: CreatorIdentityArtifactBinding;
  readonly resultConversationId?: string;
  readonly failure?: CreatorProjectIdentityJob["failure"];
}

const HEAD_DIRECTORY = "identity-jobs";
const HEAD_SUFFIX = ".head.json";
const HEAD_MAX_BYTES = 64 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CHAIN_LENGTH = 100_000;

export class CreatorProjectIdentityJobStore {
  public readonly artifactStore: ImmutableJsonArtifactStore;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    store: ImmutableJsonArtifactStore | string,
    private readonly options: CreatorProjectIdentityJobStoreOptions = {},
  ) {
    this.artifactStore = typeof store === "string" ? new ImmutableJsonArtifactStore(store) : store;
  }

  async admit(draft: Omit<IdentityJobDraft, "revision">): Promise<LoadedCreatorProjectIdentityJob> {
    return this.serialize(draft.id, async () => {
      if (await this.readHead(draft.id))
        throw new Error(`Creator project identity job already exists: ${draft.id}`);
      const job = sealCreatorProjectIdentityJob({ ...draft, revision: 1 });
      await this.verifyBindings(job);
      const snapshot = await this.artifactStore.write(job);
      const head = identityJobHead(job, snapshot);
      await this.options.beforePublishHead?.(head, job);
      await this.writeHead(head);
      return { head, job, history: [job], references: [snapshot] };
    });
  }

  async transition(
    jobId: string,
    update: CreatorProjectIdentityJobTransition,
  ): Promise<LoadedCreatorProjectIdentityJob> {
    return this.serialize(jobId, async () => {
      const current = await this.load(jobId);
      const prior = current.job;
      const previousSnapshot = current.references.at(-1)!;
      const job = sealCreatorProjectIdentityJob({
        ...withoutIdentity(prior),
        revision: prior.revision + 1,
        status: update.status,
        phase: update.phase,
        ...(update.receipt === undefined ? {} : { receipt: update.receipt }),
        ...(update.resultConversationId === undefined
          ? {}
          : { resultConversationId: update.resultConversationId }),
        ...(update.failure === undefined ? {} : { failure: update.failure }),
        previousSnapshot,
        previousSnapshotHash: prior.hash,
        updatedAt: update.updatedAt,
      });
      assertIdentityJobProgression(prior, job);
      await this.verifyBindings(job);
      const snapshot = await this.artifactStore.write(job);
      const head = identityJobHead(job, snapshot);
      await this.options.beforePublishHead?.(head, job);
      await this.writeHead(head);
      return {
        head,
        job,
        history: [...current.history, job],
        references: [...current.references, snapshot],
      };
    });
  }

  async load(jobId: string): Promise<LoadedCreatorProjectIdentityJob> {
    assertId(jobId, "identity job ID");
    const head = await this.readHead(jobId);
    if (!head) throw new Error(`Creator project identity job is missing: ${jobId}`);
    const reversed: CreatorProjectIdentityJob[] = [];
    const reversedReferences: ArtifactReference[] = [];
    const visited = new Set<string>();
    let reference: ArtifactReference | undefined = head.snapshot;
    let expectedRevision = head.revision;
    let expectedHash = head.jobHash;
    while (reference) {
      if (reversed.length >= MAX_CHAIN_LENGTH)
        throw new Error("Creator project identity job chain exceeds its bound");
      if (visited.has(reference.artifactHash))
        throw new Error("Creator project identity job chain contains a cycle");
      visited.add(reference.artifactHash);
      const job: CreatorProjectIdentityJob = await this.artifactStore.read(
        reference,
        assertCreatorProjectIdentityJob,
      );
      assertCreatorProjectIdentityJobIdentity(job);
      if (job.id !== head.jobId || job.revision !== expectedRevision || job.hash !== expectedHash)
        throw new Error("Creator project identity job chain binding mismatch");
      await this.verifyBindings(job);
      reversed.push(job);
      reversedReferences.push(reference);
      if (job.revision === 1) {
        if (job.previousSnapshot || job.previousSnapshotHash)
          throw new Error("Initial creator project identity job has a predecessor");
        reference = undefined;
      } else {
        if (!job.previousSnapshot || !job.previousSnapshotHash)
          throw new Error("Creator project identity job predecessor is missing");
        reference = job.previousSnapshot;
        expectedHash = job.previousSnapshotHash;
        expectedRevision -= 1;
      }
    }
    if (expectedRevision !== 1)
      throw new Error("Creator project identity job chain did not reach its admission");
    const history = reversed.reverse();
    for (let index = 1; index < history.length; index += 1)
      assertIdentityJobProgression(history[index - 1]!, history[index]!);
    const job = history.at(-1)!;
    if (job.hash !== head.jobHash || job.updatedAt !== head.updatedAt)
      throw new Error("Creator project identity job head binding mismatch");
    return {
      head,
      job,
      history,
      references: reversedReferences.reverse(),
    };
  }

  async enumerate(): Promise<CreatorProjectIdentityJobEnumeration> {
    const directory = join(this.artifactStore.root, HEAD_DIRECTORY);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return { jobs: [], corrupt: [] };
      throw error;
    }
    const jobs: LoadedCreatorProjectIdentityJob[] = [];
    const corrupt: { headLocator: string; error: string }[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const locator = `${HEAD_DIRECTORY}/${entry.name}`;
      const jobId = entry.name.endsWith(HEAD_SUFFIX)
        ? entry.name.slice(0, -HEAD_SUFFIX.length)
        : undefined;
      if (!entry.isFile() || !jobId || !ID_PATTERN.test(jobId)) {
        corrupt.push({ headLocator: locator, error: "Invalid identity-job head entry" });
        continue;
      }
      try {
        jobs.push(await this.load(jobId));
      } catch (error: unknown) {
        corrupt.push({ headLocator: locator, error: errorMessage(error) });
      }
    }
    jobs.sort((left, right) =>
      left.job.updatedAt === right.job.updatedAt
        ? left.job.id.localeCompare(right.job.id)
        : right.job.updatedAt.localeCompare(left.job.updatedAt),
    );
    return { jobs, corrupt };
  }

  private async verifyBindings(job: CreatorProjectIdentityJob): Promise<void> {
    const request = await this.artifactStore.read(job.admittedRequest, assertCreatorActionRequest);
    if (
      request.idempotencyKey !== job.idempotencyKey ||
      creatorWorkRequestHash(request) !== job.requestHash ||
      request.conversationId !== job.provisionalConversationId
    )
      throw new Error("Creator project identity job request binding mismatch");
    const operation = await this.artifactStore.read(
      job.operation.artifact,
      assertStudioProjectIdentityOperation,
    );
    if (
      operation.id !== job.operation.id ||
      operation.hash !== job.operation.hash ||
      operation.connectorEpoch !== job.connectorEpoch ||
      operation.expectedIdentity.hash !== job.expectedIdentityStateHash ||
      operation.assignedForgeProjectId !== job.assignedForgeProjectId ||
      operation.action !== job.command
    )
      throw new Error("Creator project identity job operation binding mismatch");
    if (job.failure?.rejection) {
      const { command, settlement } = job.failure.rejection;
      if (
        (command.type !== "LinkStudioProject" && command.type !== "ForkStudioProject") ||
        command.sessionId !== job.pairedStudioSessionId ||
        command.payload.operation.hash !== operation.hash ||
        command.payload.operationHash !== operation.hash ||
        settlement.commandMessageId !== command.messageId ||
        settlement.commandHash !== contentHash(stableJson(command)) ||
        settlement.identityRejection?.operationHash !== operation.hash ||
        settlement.identityRejection?.operationId !== operation.id
      )
        throw new Error("Identity job rejection does not bind its exact dispatched operation");
      if (
        (job.phase === "command_rejected") !==
        identityRejectionProvesNoEffect(operation, settlement.identityRejection)
      )
        throw new Error("Identity job rejection classification contradicts its Studio evidence");
    }
    if (job.receipt) {
      const receipt = await this.artifactStore.read(
        job.receipt.artifact,
        assertStudioProjectIdentityFinalizationReceipt,
      );
      if (
        receipt.id !== job.receipt.id ||
        receipt.hash !== job.receipt.hash ||
        receipt.operation.hash !== operation.hash
      )
        throw new Error("Creator project identity job receipt binding mismatch");
      if (
        (job.executionMode === "initial" || job.executionMode === "resume_undispatched") &&
        receipt.finalization !== "ordinary"
      )
        throw new Error("Initial identity execution has a non-ordinary receipt");
      if (
        job.executionMode === "recover_abandon" &&
        (receipt.finalization !== "recovery_abandon" || receipt.status !== "cancelled")
      )
        throw new Error("Opening identity abandonment has an invalid receipt");
      if (
        job.executionMode === "recover_cancel" &&
        (receipt.finalization !== "recovery_cancel" || receipt.status !== "cancelled")
      )
        throw new Error("Identity cancellation recovery has an invalid receipt");
      if (job.executionMode === "recover_settle" && receipt.finalization !== "recovery_settle")
        throw new Error("Closed identity settlement has an invalid receipt");
      const succeeded = receipt.status === "linked" || receipt.status === "forked";
      if (receipt.status === "cancelled" && job.resultConversationId !== undefined)
        throw new Error("Cancelled identity receipt cannot publish a conversation");
      if (job.phase === "conversation_published" && !succeeded)
        throw new Error("Cancelled identity receipt reached conversation publication");
      if (
        succeeded &&
        ["conversation_published", "acknowledgement_pending", "acknowledged"].includes(job.phase) &&
        job.resultConversationId === undefined
      )
        throw new Error("Successful identity receipt lacks its published conversation binding");
    }
  }

  private async readHead(jobId: string): Promise<CreatorProjectIdentityJobHead | undefined> {
    await this.ensureHeadDirectory();
    try {
      const descriptor = await open(
        this.headPath(jobId),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await descriptor.stat();
        if (!info.isFile() || info.size <= 0 || info.size > HEAD_MAX_BYTES)
          throw new Error("Creator project identity job head is not a bounded regular file");
        const serialized = await descriptor.readFile({ encoding: "utf8" });
        const parsed = JSON.parse(serialized) as unknown;
        if (`${stableJson(parsed)}\n` !== serialized)
          throw new Error("Creator project identity job head JSON is not canonical");
        assertCreatorProjectIdentityJobHead(parsed);
        return parsed;
      } finally {
        await descriptor.close();
      }
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async writeHead(head: CreatorProjectIdentityJobHead): Promise<void> {
    await this.ensureHeadDirectory();
    const destination = this.headPath(head.jobId);
    await assertReplaceableRegularFile(destination);
    const directory = join(this.artifactStore.root, HEAD_DIRECTORY);
    const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`);
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
      await syncDirectory(directory);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  }

  private async ensureHeadDirectory(): Promise<void> {
    await ensurePrivateDirectory(this.artifactStore.root, "identity-job store root");
    await ensurePrivateDirectory(
      join(this.artifactStore.root, HEAD_DIRECTORY),
      "identity-job head directory",
    );
  }

  private headPath(jobId: string): string {
    assertId(jobId, "identity job ID");
    return join(this.artifactStore.root, HEAD_DIRECTORY, `${jobId}${HEAD_SUFFIX}`);
  }

  private async serialize<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(jobId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(jobId) === tail) this.tails.delete(jobId);
    }
  }
}

export function sealCreatorProjectIdentityJob(draft: IdentityJobDraft): CreatorProjectIdentityJob {
  const canonical = JSON.parse(stableJson({ kind: "CreatorProjectIdentityJob", ...draft })) as Omit<
    CreatorProjectIdentityJob,
    "hash"
  >;
  const job = { ...canonical, hash: contentHash(stableJson(canonical)) };
  assertCreatorProjectIdentityJob(job);
  assertCreatorProjectIdentityJobIdentity(job);
  return job;
}

export function assertCreatorProjectIdentityJob(
  value: unknown,
): asserts value is CreatorProjectIdentityJob {
  if (!isRecord(value) || value.kind !== "CreatorProjectIdentityJob")
    throw new Error("Invalid CreatorProjectIdentityJob");
  for (const key of [
    "id",
    "hash",
    "provisionalConversationId",
    "pairedStudioSessionId",
    "idempotencyKey",
    "requestHash",
    "connectorEpoch",
    "expectedIdentityStateHash",
    "assignedForgeProjectId",
  ])
    assertIdOrHash(value[key], key, key.toLowerCase().includes("hash"));
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    throw new Error("Invalid creator project identity job revision");
  if (!isRecord(value.operation)) throw new Error("Invalid identity operation binding");
  assertArtifactBinding(value.operation, "identity operation");
  assertArtifactReference(value.admittedRequest);
  if (!(["link", "fork"] as const).includes(value.command as "link" | "fork"))
    throw new Error("Invalid creator project identity job command");
  if (!EXECUTION_MODES.includes(value.executionMode as CreatorProjectIdentityJob["executionMode"]))
    throw new Error("Invalid creator project identity job execution mode");
  if (!JOB_STATUSES.includes(value.status as CreatorProjectIdentityJobStatus))
    throw new Error("Invalid creator project identity job status");
  if (!PHASES.includes(value.phase as CreatorProjectIdentityJob["phase"]))
    throw new Error("Invalid creator project identity job phase");
  const created = canonicalIso(value.createdAt, "identity job createdAt");
  const updated = canonicalIso(value.updatedAt, "identity job updatedAt");
  if (updated < created) throw new Error("Invalid creator project identity job interval");
  if ((value.previousSnapshot === undefined) !== (value.previousSnapshotHash === undefined))
    throw new Error("Incomplete creator project identity job predecessor");
  if (value.previousSnapshot !== undefined) assertArtifactReference(value.previousSnapshot);
  if (value.previousSnapshotHash !== undefined)
    assertHash(value.previousSnapshotHash, "predecessor");
  if (value.receipt !== undefined) {
    if (!isRecord(value.receipt)) throw new Error("Invalid identity receipt binding");
    assertArtifactBinding(value.receipt, "identity receipt");
  }
  if (value.resultConversationId !== undefined)
    assertId(value.resultConversationId, "result conversation ID");
  if (value.failure !== undefined) {
    if (!isRecord(value.failure)) throw new Error("Invalid identity job failure");
    assertId(value.failure.code, "identity job failure code");
    assertHash(value.failure.detailHash, "identity job failure detail");
    if (
      typeof value.failure.detail !== "string" ||
      Buffer.byteLength(value.failure.detail, "utf8") < 1 ||
      Buffer.byteLength(value.failure.detail, "utf8") > 4096 ||
      contentHash(value.failure.detail) !== value.failure.detailHash
    )
      throw new Error("Identity job failure requires exact bounded readable detail");
    if (value.failure.rejection !== undefined) {
      if (!isRecord(value.failure.rejection))
        throw new Error("Invalid identity rejection evidence");
      assertBackendToPluginMessage(value.failure.rejection.command);
      assertStudioCommandSettledPayload(value.failure.rejection.settlement);
      if (value.failure.rejection.settlement.disposition !== "rejected")
        throw new Error("Identity rejection evidence requires a rejected command settlement");
    }
  }
  if (value.status === "queued" && value.phase !== "admitted")
    throw new Error("Queued identity job is not at its admission boundary");
  if (value.status === "running" && value.phase !== "dispatch_intent_persisted")
    throw new Error("Running identity job lacks a durable dispatch intent");
  if (
    value.status === "awaiting_external" &&
    !["receipt_persisted", "conversation_published", "acknowledgement_pending"].includes(
      String(value.phase),
    )
  )
    throw new Error("Invalid awaiting-external identity job phase");
  if (value.status === "awaiting_external" && value.receipt === undefined)
    throw new Error("Awaiting-external identity job lacks its durable Studio receipt");
  if (value.phase === "receipt_persisted" && value.resultConversationId !== undefined)
    throw new Error("Receipt-only identity boundary cannot claim conversation publication");
  if (value.phase === "conversation_published" && value.resultConversationId === undefined)
    throw new Error("Published identity boundary lacks its result conversation");
  if (value.status === "outcome_unknown" && value.phase !== "studio_outcome_unknown")
    throw new Error("Unknown identity outcome lacks its exact phase");
  if (
    value.status === "failed" &&
    !["resume_required", "command_rejected", "identity_transaction_failed"].includes(
      String(value.phase),
    )
  )
    throw new Error("Invalid failed identity job phase");
  if (
    value.phase === "command_rejected" &&
    (!isRecord(value.failure) || value.failure.rejection === undefined)
  )
    throw new Error("Known identity rejection requires authoritative command evidence");
  if (value.status === "succeeded" && value.phase !== "acknowledged")
    throw new Error("Succeeded identity job lacks acknowledgement");
  if (
    ["outcome_unknown", "failed"].includes(String(value.status)) !==
    (value.failure !== undefined)
  )
    throw new Error("Identity job failure binding does not match its status");
  if (value.status === "succeeded" && value.receipt === undefined)
    throw new Error("Succeeded identity job lacks a Studio receipt");
  if (value.resultConversationId !== undefined && value.receipt === undefined)
    throw new Error("Identity job conversation result lacks a Studio receipt");
}

export function assertCreatorProjectIdentityJobIdentity(job: CreatorProjectIdentityJob): void {
  const { hash, ...payload } = job;
  if (contentHash(stableJson(payload)) !== hash)
    throw new Error("Invalid CreatorProjectIdentityJob content identity");
}

function assertIdentityJobProgression(
  prior: CreatorProjectIdentityJob,
  next: CreatorProjectIdentityJob,
): void {
  if (
    next.id !== prior.id ||
    next.revision !== prior.revision + 1 ||
    next.previousSnapshotHash !== prior.hash ||
    next.createdAt !== prior.createdAt ||
    next.provisionalConversationId !== prior.provisionalConversationId ||
    next.pairedStudioSessionId !== prior.pairedStudioSessionId ||
    next.idempotencyKey !== prior.idempotencyKey ||
    next.requestHash !== prior.requestHash ||
    stableJson(next.admittedRequest) !== stableJson(prior.admittedRequest) ||
    next.command !== prior.command ||
    next.executionMode !== prior.executionMode ||
    stableJson(next.operation) !== stableJson(prior.operation) ||
    next.connectorEpoch !== prior.connectorEpoch ||
    next.expectedIdentityStateHash !== prior.expectedIdentityStateHash ||
    next.assignedForgeProjectId !== prior.assignedForgeProjectId
  )
    throw new Error("Creator project identity job immutable binding changed");
  if (Date.parse(next.updatedAt) < Date.parse(prior.updatedAt))
    throw new Error("Creator project identity job time moved backwards");
  const allowed: Record<
    CreatorProjectIdentityJobStatus,
    readonly CreatorProjectIdentityJobStatus[]
  > = {
    queued: ["running", "failed"],
    running: ["awaiting_external", "outcome_unknown", "failed"],
    awaiting_external: ["awaiting_external", "succeeded", "outcome_unknown", "failed"],
    outcome_unknown: [],
    succeeded: [],
    failed: [],
  };
  if (!allowed[prior.status].includes(next.status))
    throw new Error(`Invalid identity job transition ${prior.status} -> ${next.status}`);
  if (
    prior.status === "running" &&
    next.status === "awaiting_external" &&
    next.phase !== "receipt_persisted"
  )
    throw new Error("Identity job skipped its durable receipt boundary");
  if (prior.status === "awaiting_external" && next.status === "awaiting_external") {
    const phaseOrder = ["receipt_persisted", "conversation_published", "acknowledgement_pending"];
    const priorIndex = phaseOrder.indexOf(prior.phase);
    const nextIndex = phaseOrder.indexOf(next.phase);
    if (nextIndex < priorIndex) throw new Error("Identity job durable phase moved backwards");
    const cancelledReceiptSkipsConversation =
      prior.phase === "receipt_persisted" &&
      next.phase === "acknowledgement_pending" &&
      next.resultConversationId === undefined;
    if (nextIndex > priorIndex + 1 && !cancelledReceiptSkipsConversation)
      throw new Error("Identity job skipped a durable publication boundary");
  }
  if (
    prior.status === "awaiting_external" &&
    ["succeeded", "failed"].includes(next.status) &&
    prior.phase !== "acknowledgement_pending"
  )
    throw new Error("Identity job terminated before acknowledgement became pending");
  if (prior.receipt && stableJson(prior.receipt) !== stableJson(next.receipt))
    throw new Error("Identity job receipt changed after persistence");
  if (prior.resultConversationId && prior.resultConversationId !== next.resultConversationId)
    throw new Error("Identity job result conversation changed");
}

function identityJobHead(
  job: CreatorProjectIdentityJob,
  snapshot: ArtifactReference,
): CreatorProjectIdentityJobHead {
  const head: CreatorProjectIdentityJobHead = {
    kind: "CreatorProjectIdentityJobHead",
    jobId: job.id,
    revision: job.revision,
    jobHash: job.hash,
    snapshot,
    updatedAt: job.updatedAt,
  };
  assertCreatorProjectIdentityJobHead(head);
  return head;
}

function assertCreatorProjectIdentityJobHead(
  value: unknown,
): asserts value is CreatorProjectIdentityJobHead {
  if (!isRecord(value) || value.kind !== "CreatorProjectIdentityJobHead")
    throw new Error("Invalid CreatorProjectIdentityJobHead");
  assertId(value.jobId, "identity job head ID");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    throw new Error("Invalid identity job head revision");
  assertHash(value.jobHash, "identity job head hash");
  assertArtifactReference(value.snapshot);
  canonicalIso(value.updatedAt, "identity job head updatedAt");
}

function assertArtifactBinding(value: Record<string, unknown>, label: string): void {
  assertId(value.id, `${label} ID`);
  assertHash(value.hash, `${label} hash`);
  assertArtifactReference(value.artifact);
}

function withoutIdentity(job: CreatorProjectIdentityJob): Omit<IdentityJobDraft, "revision"> {
  const {
    kind: _kind,
    hash: _hash,
    revision: _revision,
    previousSnapshot: _previousSnapshot,
    previousSnapshotHash: _previousSnapshotHash,
    ...draft
  } = job;
  return draft;
}

async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe ${label}`);
}

async function assertReplaceableRegularFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("Unsafe creator project identity job head target");
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

function assertIdOrHash(value: unknown, label: string, hash: boolean): void {
  if (hash) assertHash(value, label);
  else assertId(value, label);
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function canonicalIso(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value)
    throw new Error(`Invalid ${label}`);
  return timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const JOB_STATUSES: readonly CreatorProjectIdentityJobStatus[] = [
  "queued",
  "running",
  "awaiting_external",
  "outcome_unknown",
  "succeeded",
  "failed",
];

const PHASES: readonly CreatorProjectIdentityJob["phase"][] = [
  "admitted",
  "dispatch_intent_persisted",
  "receipt_persisted",
  "conversation_published",
  "acknowledgement_pending",
  "acknowledged",
  "resume_required",
  "command_rejected",
  "studio_outcome_unknown",
  "identity_transaction_failed",
];

const EXECUTION_MODES: readonly CreatorProjectIdentityJob["executionMode"][] = [
  "initial",
  "resume_undispatched",
  "recover_abandon",
  "recover_cancel",
  "recover_settle",
  "finalize_receipt",
  "host_finalize",
];

// Keep the imported protocol types attached to this module's public contract;
// it prevents a structurally similar non-protocol artifact being substituted.
export type CreatorProjectIdentityOperationEvidence = StudioProjectIdentityOperation;
export type CreatorProjectIdentityReceiptEvidence = StudioProjectIdentityFinalizationReceipt;
