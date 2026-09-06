import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";

export const VISUAL_WORLD_WORKFLOW_ABI = "forge-visual-world-workflow@2" as const;
export const VISUAL_WORLD_WORKFLOW_STATES = [
  "draft",
  "proposed",
  "accepted",
  "compiling",
  "bundle_review",
  "upload_authorization",
  "asset_processing",
  "native_inspection",
  "native_plan_review",
  "building",
  "awaiting_studio_apply",
  "reconciled",
  "rejected",
  "superseded",
  "incomplete",
  "uncertain",
] as const;
export type VisualWorldWorkflowState = (typeof VISUAL_WORLD_WORKFLOW_STATES)[number];

export const VISUAL_WORLD_WORKFLOW_ACTIONS = [
  "revise_draft",
  "solve_draft",
  "propose",
  "accept_proposal",
  "start_compilation",
  "review_bundle",
  "authorize_upload",
  "start_asset_processing",
  "retain_native_inspection",
  "approve_native_plan",
  "start_building",
  "request_studio_apply",
  "reconcile",
  "reject",
  "supersede",
  "mark_incomplete",
  "mark_uncertain",
] as const;
export type VisualWorldWorkflowAction = (typeof VISUAL_WORLD_WORKFLOW_ACTIONS)[number];

const stateSchema = z.enum(VISUAL_WORLD_WORKFLOW_STATES);
const actionSchema = z.enum(VISUAL_WORLD_WORKFLOW_ACTIONS);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(512).regex(/^\S+$/u);

export const VISUAL_WORLD_WORKFLOW_EVENT_SCHEMA = z
  .object({
    kind: z.literal("VisualWorldWorkflowEvent"),
    abi: z.literal(VISUAL_WORLD_WORKFLOW_ABI),
    id,
    hash,
    workflowId: id,
    projectId: id,
    sequence: z.number().int().nonnegative().safe(),
    previousEventHash: hash.optional(),
    previousEventArtifact: z
      .object({ locator: z.string(), artifactHash: hash, bytes: z.number().int().positive() })
      .strict()
      .optional(),
    from: stateSchema.optional(),
    to: stateSchema,
    action: z.union([z.literal("create_draft"), actionSchema]),
    actionInstanceId: id,
    actor: z.enum(["creator", "forge_host", "studio_connector", "platform"]),
    artifacts: z.record(id, hash),
    detail: z.string().min(1).max(4096),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type VisualWorldWorkflowEvent = z.infer<typeof VISUAL_WORLD_WORKFLOW_EVENT_SCHEMA>;

const cursorSchema = z
  .object({
    kind: z.literal("VisualWorldWorkflowCursor"),
    abi: z.literal(VISUAL_WORLD_WORKFLOW_ABI),
    workflowId: id,
    event: z
      .object({ locator: z.string(), artifactHash: hash, bytes: z.number().int().positive() })
      .strict(),
    eventHash: hash,
    state: stateSchema,
    sequence: z.number().int().nonnegative().safe(),
    checksum: hash,
  })
  .strict();
type VisualWorldWorkflowCursor = z.infer<typeof cursorSchema>;

const NEXT: Readonly<
  Record<
    Exclude<
      VisualWorldWorkflowAction,
      "reject" | "supersede" | "mark_incomplete" | "mark_uncertain"
    >,
    readonly [VisualWorldWorkflowState, VisualWorldWorkflowState]
  >
> = {
  revise_draft: ["draft", "draft"],
  solve_draft: ["draft", "draft"],
  propose: ["draft", "proposed"],
  accept_proposal: ["proposed", "accepted"],
  start_compilation: ["accepted", "compiling"],
  review_bundle: ["compiling", "bundle_review"],
  authorize_upload: ["bundle_review", "upload_authorization"],
  start_asset_processing: ["upload_authorization", "asset_processing"],
  retain_native_inspection: ["asset_processing", "native_inspection"],
  approve_native_plan: ["native_inspection", "native_plan_review"],
  start_building: ["native_plan_review", "building"],
  request_studio_apply: ["building", "awaiting_studio_apply"],
  reconcile: ["awaiting_studio_apply", "reconciled"],
};

const REQUIRED_ARTIFACTS: Partial<
  Record<VisualWorldWorkflowAction | "create_draft", readonly string[]>
> = {
  create_draft: ["sceneDeclarationHash", "creatorRequestHash"],
  revise_draft: ["sceneDeclarationHash"],
  solve_draft: ["sceneDeclarationHash", "solvedSceneHash", "geometryAnalysisHash"],
  propose: ["proposalHash", "solvedSceneHash", "agentRunHash", "sourceConsultationHash"],
  accept_proposal: ["proposalAcceptanceHash"],
  start_compilation: ["compilationIntentHash", "installationQualificationHash"],
  review_bundle: ["bundleManifestHash", "bundleReviewHash"],
  authorize_upload: ["uploadAuthorizationHash"],
  start_asset_processing: ["uploadDispatchSetHash"],
  retain_native_inspection: ["nativeInspectionHash", "assetReceiptSetHash"],
  approve_native_plan: ["gamePlanHash", "nativePlanApprovalHash", "projectRevisionHash"],
  start_building: ["buildArtifactHash"],
  request_studio_apply: ["studioApplyRequestHash", "connectorBuildHash"],
  reconcile: ["finalizationReceiptHash", "reconciliationHash"],
};

export class VisualWorldWorkflowJournal {
  readonly root: string;
  readonly events: ImmutableJsonArtifactStore;

  constructor(root: string) {
    this.root = resolve(root);
    this.events = new ImmutableJsonArtifactStore(resolve(this.root, "events"));
  }

  async create(input: {
    workflowId: string;
    projectId: string;
    actionInstanceId: string;
    actor: "creator" | "forge_host";
    artifacts: Readonly<Record<string, string>>;
    detail: string;
    occurredAt: string;
  }): Promise<VisualWorldWorkflowEvent> {
    return this.withLease(input.workflowId, async () => {
      if (await this.readCursor(input.workflowId, true))
        throw new Error("Visual-world workflow already exists");
      return this.publish({
        workflowId: input.workflowId,
        projectId: input.projectId,
        sequence: 0,
        to: "draft",
        action: "create_draft",
        actionInstanceId: input.actionInstanceId,
        actor: input.actor,
        artifacts: input.artifacts,
        detail: input.detail,
        occurredAt: input.occurredAt,
      });
    });
  }

  async advance(input: {
    workflowId: string;
    expectedEventHash: string;
    action: VisualWorldWorkflowAction;
    actionInstanceId: string;
    actor: "creator" | "forge_host" | "studio_connector" | "platform";
    artifacts: Readonly<Record<string, string>>;
    detail: string;
    occurredAt: string;
  }): Promise<VisualWorldWorkflowEvent> {
    return this.withLease(input.workflowId, async () => {
      const current = await this.current(input.workflowId);
      const currentCursor = await this.readCursor(input.workflowId, false);
      if (!currentCursor) throw new Error("Visual-world workflow is absent");
      if (current.hash !== input.expectedEventHash)
        throw new Error("Visual-world workflow action is stale");
      const replay = await this.findAction(current, input.actionInstanceId);
      if (replay) throw new Error("Visual-world workflow action instance was already consumed");
      let to: VisualWorldWorkflowState;
      const ordinary = NEXT[input.action as keyof typeof NEXT];
      if (ordinary) {
        if (ordinary[0] !== current.to)
          throw new Error(`Visual-world workflow cannot ${input.action} from ${current.to}`);
        to = ordinary[1];
      } else {
        if (["reconciled", "rejected", "superseded"].includes(current.to))
          throw new Error(`Visual-world workflow terminal state cannot transition: ${current.to}`);
        to =
          input.action === "reject"
            ? "rejected"
            : input.action === "supersede"
              ? "superseded"
              : input.action === "mark_incomplete"
                ? "incomplete"
                : "uncertain";
      }
      return this.publish({
        workflowId: current.workflowId,
        projectId: current.projectId,
        sequence: current.sequence + 1,
        previousEventHash: current.hash,
        previousEventArtifact: currentCursor.event,
        from: current.to,
        to,
        action: input.action,
        actionInstanceId: input.actionInstanceId,
        actor: input.actor,
        artifacts: input.artifacts,
        detail: input.detail,
        occurredAt: input.occurredAt,
      });
    });
  }

  async current(workflowId: string): Promise<VisualWorldWorkflowEvent> {
    const cursor = await this.readCursor(workflowId, false);
    if (!cursor) throw new Error("Visual-world workflow is absent");
    const event = await this.events.read(cursor.event, assertVisualWorldWorkflowEvent);
    if (
      event.hash !== cursor.eventHash ||
      event.workflowId !== workflowId ||
      event.sequence !== cursor.sequence ||
      event.to !== cursor.state
    )
      throw new Error("Visual-world workflow cursor differs from its immutable event");
    return event;
  }

  /**
   * Returns the current immutable head of every retained workflow. Directory
   * entries are treated as untrusted host state and never followed through a
   * symlink. This is a bounded presentation/read-recovery operation only.
   */
  async listCurrent(): Promise<VisualWorldWorkflowEvent[]> {
    const directory = resolve(this.root, "cursors-v2");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const cursorEntries = entries.filter((entry) => entry.name.endsWith(".json"));
    if (cursorEntries.length > 1024)
      throw new Error("Visual-world workflow inventory exceeds its bound");
    for (const entry of cursorEntries)
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("Visual-world workflow inventory contains a non-regular cursor");
    const workflowIds = cursorEntries
      .map((entry) => entry.name.slice(0, -".json".length))
      .sort((left, right) => left.localeCompare(right));
    return Promise.all(workflowIds.map((workflowId) => this.current(workflowId)));
  }

  async history(workflowId: string): Promise<VisualWorldWorkflowEvent[]> {
    const output: VisualWorldWorkflowEvent[] = [];
    let current = await this.current(workflowId);
    while (true) {
      output.push(current);
      if (!current.previousEventHash) break;
      if (!current.previousEventArtifact)
        throw new Error("Visual-world workflow predecessor artifact is absent");
      const previous = await this.events.read(
        current.previousEventArtifact,
        assertVisualWorldWorkflowEvent,
      );
      if (
        previous.workflowId !== workflowId ||
        previous.hash !== current.previousEventHash ||
        previous.sequence + 1 !== current.sequence ||
        previous.to !== current.from
      )
        throw new Error("Visual-world workflow event chain is invalid");
      current = previous;
      if (output.length > 128) throw new Error("Visual-world workflow history exceeds its bound");
    }
    return output.reverse();
  }

  /**
   * Explicit crash recovery for an abandoned process lease. A live or
   * unreadable owner is never displaced.
   */
  async recoverAbandonedLease(workflowId: string): Promise<void> {
    const path = this.leasePath(workflowId);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("Visual-world workflow lease is not a regular file");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isSafeInteger((value as { pid?: unknown }).pid) ||
      Number((value as { pid: number }).pid) <= 0
    )
      throw new Error("Visual-world workflow lease owner is malformed");
    const pid = Number((value as { pid: number }).pid);
    try {
      process.kill(pid, 0);
      throw new Error("Visual-world workflow lease owner is still running");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await rm(path);
  }

  private async findAction(
    current: VisualWorldWorkflowEvent,
    actionInstanceId: string,
  ): Promise<VisualWorldWorkflowEvent | undefined> {
    let cursor = current;
    for (let count = 0; count < 128; count += 1) {
      if (cursor.actionInstanceId === actionInstanceId) return cursor;
      if (!cursor.previousEventHash) return undefined;
      if (!cursor.previousEventArtifact)
        throw new Error("Visual-world workflow predecessor artifact is absent");
      cursor = await this.events.read(cursor.previousEventArtifact, assertVisualWorldWorkflowEvent);
    }
    throw new Error("Visual-world workflow history exceeds its bound");
  }

  private async publish(
    material: Omit<VisualWorldWorkflowEvent, "kind" | "abi" | "id" | "hash">,
  ): Promise<VisualWorldWorkflowEvent> {
    assertRequiredArtifacts(material.action, material.artifacts);
    const canonical = {
      kind: "VisualWorldWorkflowEvent" as const,
      abi: VISUAL_WORLD_WORKFLOW_ABI,
      ...material,
    };
    const eventHash = contentHash(stableJson(canonical));
    const event = VISUAL_WORLD_WORKFLOW_EVENT_SCHEMA.parse({
      ...canonical,
      id: `visual_workflow_event_${eventHash.slice(0, 24)}`,
      hash: eventHash,
    });
    const reference = await this.events.write(event);
    await this.writeCursor({
      kind: "VisualWorldWorkflowCursor",
      abi: VISUAL_WORLD_WORKFLOW_ABI,
      workflowId: event.workflowId,
      event: reference,
      eventHash: event.hash,
      state: event.to,
      sequence: event.sequence,
    });
    return event;
  }

  private cursorPath(workflowId: string): string {
    if (!/^\S{1,512}$/u.test(workflowId) || workflowId.includes("/") || workflowId.includes("\\"))
      throw new Error("Visual-world workflow ID is unsafe");
    return resolve(this.root, "cursors-v2", `${workflowId}.json`);
  }

  private leasePath(workflowId: string): string {
    return resolve(this.root, "leases-v2", `${workflowId}.lease`);
  }

  private async withLease<T>(workflowId: string, run: () => Promise<T>): Promise<T> {
    const leasePath = this.leasePath(workflowId);
    await ensurePrivateDirectory(dirname(leasePath));
    const lease = await open(
      leasePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    ).catch((error: unknown) => {
      throw new Error(
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "Visual-world workflow is leased by another process or requires recovery"
          : error instanceof Error
            ? error.message
            : String(error),
      );
    });
    try {
      await lease.writeFile(stableJson({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      return await run();
    } finally {
      await lease.close();
      await rm(leasePath, { force: true });
    }
  }

  private async readCursor(
    workflowId: string,
    missingAllowed: boolean,
  ): Promise<VisualWorldWorkflowCursor | undefined> {
    const path = this.cursorPath(workflowId);
    let raw: string;
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new Error("Visual-world workflow cursor is not a regular file");
      raw = await readFile(path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && missingAllowed) return undefined;
      throw error;
    }
    const cursor = cursorSchema.parse(JSON.parse(raw));
    const { checksum, ...material } = cursor;
    if (contentHash(stableJson(material)) !== checksum)
      throw new Error("Visual-world workflow cursor checksum mismatch");
    assertArtifactReference(cursor.event);
    return cursor;
  }

  private async writeCursor(input: Omit<VisualWorldWorkflowCursor, "checksum">): Promise<void> {
    const path = this.cursorPath(input.workflowId);
    await ensurePrivateDirectory(dirname(path));
    const cursor = cursorSchema.parse({
      ...input,
      checksum: contentHash(stableJson(input)),
    });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${stableJson(cursor)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
}

function assertRequiredArtifacts(
  action: VisualWorldWorkflowAction | "create_draft",
  artifacts: Readonly<Record<string, string>>,
): void {
  if (Object.keys(artifacts).length > 64)
    throw new Error("Visual-world workflow artifact binding count exceeds its bound");
  for (const [key, value] of Object.entries(artifacts))
    if (!/^\S{1,512}$/u.test(key) || !/^[a-f0-9]{64}$/u.test(value))
      throw new Error("Visual-world workflow artifact binding is malformed");
  for (const key of REQUIRED_ARTIFACTS[action] ?? [])
    if (!artifacts[key]) throw new Error(`Visual-world workflow action requires ${key}`);
}

function assertVisualWorldWorkflowEvent(value: unknown): asserts value is VisualWorldWorkflowEvent {
  const event = VISUAL_WORLD_WORKFLOW_EVENT_SCHEMA.parse(value);
  const { id: eventId, hash: eventHash, ...material } = event;
  const expectedHash = contentHash(stableJson(material));
  if (
    eventHash !== expectedHash ||
    eventId !== `visual_workflow_event_${expectedHash.slice(0, 24)}`
  )
    throw new Error("Visual-world workflow event identity mismatch");
  assertRequiredArtifacts(event.action, event.artifacts);
  if (event.sequence === 0) {
    if (
      event.action !== "create_draft" ||
      event.from !== undefined ||
      event.previousEventHash ||
      event.previousEventArtifact
    )
      throw new Error("Visual-world workflow genesis event is malformed");
  } else if (
    !event.from ||
    !event.previousEventHash ||
    !event.previousEventArtifact ||
    event.action === "create_draft"
  )
    throw new Error("Visual-world workflow continuation event is malformed");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("Visual-world workflow state root is not a safe directory");
}
