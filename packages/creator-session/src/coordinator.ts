import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { INITIAL_EXPERIMENT_BUDGETS } from "../../agent-runtime/src/index.js";
import {
  ImmutableJsonArtifactStore,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  createBackendMessage,
  type StudioBridgeConnection,
  type StudioBridgeSession,
} from "../../studio-bridge/src/index.js";
import { type PluginToBackendMessage } from "../../studio-protocol/src/index.js";
import {
  createStudioExecutionPlan,
  STUDIO_CAPABILITY_SET,
  type RuntimeObservationEnvelope,
} from "../../studio-capabilities/src/index.js";
import {
  executeCreatorVerificationPlan,
  requestFreshStudioSnapshot,
} from "../../studio-runtime/src/index.js";
import {
  advanceSession,
  assertCreatorControlActionBinding,
  createCreatorControlView,
  createCreatorApproval,
  createCreatorReviewReport,
  createCreatorSession,
  createStudioOwnershipMap,
  loadCreatorBundle,
  persistCreatorBundle,
  persistCreatorPrompt,
  serializeCreatorChangeSet,
  type CreatorChangeSet,
  type CreatorCheckpoint,
  type CreatorDashboardState,
  type CreatorProgressStage,
  type CreatorSessionBundle,
  type CreatorControlActionId,
  type CreatorControlView,
  type CreatorPlanChange,
  type CreatorVerificationRecord,
} from "./index.js";
import {
  createCharterExecution,
  createVerificationFailureFacts,
  gradeRuntimeCharter,
  gradeSnapshotCharter,
  replayCreatorVerification,
  verificationEvidenceHash,
} from "./verification.js";
import type { CreatorAgentWorker } from "./worker.js";

export type CreatorControlAction =
  | { action: "start"; prompt: string }
  | {
      action: "act";
      sessionId: string;
      viewId: string;
      viewHash: string;
      actionId: CreatorControlActionId;
      report?: string;
    };

export class CreatorSessionCoordinator {
  private readonly bundles = new Map<string, CreatorSessionBundle>();
  private readonly pendingRecordings = new Map<
    string,
    {
      recordingId: string;
      beforeRevisionHash: string;
      afterRevisionHash: string;
      inverseMaterialHash: string;
    }
  >();
  private readonly inFlight = new Set<string>();
  private readonly views = new Map<string, CreatorControlView>();
  private readonly consumedViewHashes = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private pairedSession?: StudioBridgeSession;
  private unsubscribe: () => void;
  private readonly artifactStore: ImmutableJsonArtifactStore;

  constructor(
    private readonly input: {
      connection: StudioBridgeConnection;
      worker: CreatorAgentWorker;
      directory: string;
      timeoutMs?: number;
      externalRojoPaths?: readonly string[];
    },
  ) {
    this.artifactStore = new ImmutableJsonArtifactStore(
      resolve(input.directory),
    );
    this.unsubscribe = input.connection.subscribeWithSession(
      (message, session) => {
        void this.onPluginMessage(message, session);
      },
    );
  }

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pairedStudio(): StudioBridgeSession | undefined {
    if (
      "getSessions" in this.input.connection &&
      typeof this.input.connection.getSessions === "function"
    ) {
      const sessions = (
        this.input.connection.getSessions as () => StudioBridgeSession[]
      )();
      if (sessions.length === 1) this.pairedSession = sessions[0]!;
      else delete this.pairedSession;
    }
    return this.pairedSession ? structuredClone(this.pairedSession) : undefined;
  }

  async initialize(): Promise<void> {
    const directory = resolve(this.input.directory);
    const names = await readdir(directory).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    });
    for (const name of names.filter((entry) => /^creator_session_.+\.json$/.test(entry))) {
      let bundle = await loadCreatorBundle(join(directory, name));
      if (["planning", "building", "repairing"].includes(bundle.session.status)) {
        bundle = {
          ...bundle,
          session: advanceSession(bundle.session, {
            status: "incomplete",
            failure: {
              code: "control_process_interrupted",
              detail: "The creator control process stopped during an agent phase.",
            },
          }),
        };
        await this.persist(bundle);
      } else if (
        ["applying", "awaiting_verification", "verifying"].includes(
          bundle.session.status,
        )
      ) {
        bundle = {
          ...bundle,
          session: advanceSession(bundle.session, {
            status: "recovery_required",
            failure: {
              code: "control_process_interrupted",
              detail:
                "The creator control process stopped while Studio might retain an open recording.",
            },
          }),
        };
        await this.persist(bundle);
      }
      this.bundles.set(bundle.session.id, bundle);
    }
    const activeByProject = new Map<string, string>();
    for (const bundle of this.bundles.values()) {
      if (isTerminalStatus(bundle.session.status)) continue;
      const existing = activeByProject.get(bundle.session.projectId);
      if (existing)
        throw new Error(
          `Studio project has multiple nonterminal creator sessions: ${existing}, ${bundle.session.id}`,
        );
      activeByProject.set(bundle.session.projectId, bundle.session.id);
    }
  }

  async dashboardState(sessionId?: string): Promise<CreatorDashboardState> {
    const bundles = [...this.bundles.values()].sort((left, right) =>
      right.session.updatedAt.localeCompare(left.session.updatedAt),
    );
    const selected = sessionId
      ? await this.bundle(sessionId)
      : bundles[0];
    const sessions = await Promise.all(
      bundles.map(async (bundle) => ({
        id: bundle.session.id,
        hash: bundle.session.hash,
        projectId: bundle.session.projectId,
        prompt: await this.prompt(bundle.session.id),
        promptHash: bundle.session.promptHash,
        status: bundle.session.status,
        createdAt: bundle.session.createdAt,
        updatedAt: bundle.session.updatedAt,
        latestVerificationStatus:
          bundle.verifications.at(-1)?.status ?? ("not_run" as const),
        ...(bundle.session.failure
          ? { failure: { ...bundle.session.failure } }
          : {}),
      })),
    );
    const studio = this.pairedStudio();
    const selectedView = selected
      ? (this.views.get(selected.session.id) ??
        (await this.view(selected, "Creator session ready.")))
      : undefined;
    if (selected && selectedView)
      this.views.set(selected.session.id, selectedView);
    return {
      kind: "CreatorDashboardState",
      ...(selected ? { selectedSessionId: selected.session.id } : {}),
      sessions,
      ...(selectedView ? { controlView: selectedView } : {}),
      stages: creatorProgress(selected?.session),
      pairedStudio: studio
        ? {
            status: "paired",
            projectId: studio.projectId,
            projectName: studio.project.name,
            capabilities: [...studio.capabilities],
            message: "Studio is paired for trusted snapshot and mutation commands.",
          }
        : {
            status: "unpaired",
            message: "Open the Forge connector in Studio to pair this dashboard.",
          },
      serverTime: new Date().toISOString(),
    };
  }

  async readAuthorizedArtifact(hash: string): Promise<unknown> {
    const reference = [...this.bundles.values()]
      .flatMap(bundleArtifactReferences)
      .concat(
        [...this.views.values()].flatMap((view) =>
          view.artifacts ? Object.values(view.artifacts) : [],
        ),
      )
      .find((candidate) => candidate.artifactHash === hash);
    if (!reference) throw new Error("Artifact is not referenced by creator history");
    return this.artifactStore.read(reference);
  }

  async replayVerification(verificationId: string) {
    for (const bundle of this.bundles.values()) {
      const verification = bundle.verifications.find(
        (candidate) => candidate.id === verificationId,
      );
      if (verification)
        return replayCreatorVerification(bundle, verification, this.artifactStore);
    }
    throw new Error("Creator verification was not found");
  }

  async action(value: unknown): Promise<unknown> {
    const action = assertControlAction(value);
    if (action.action === "start") return this.start(action.prompt);
    const bundle = await this.bundle(action.sessionId);
    return this.lock(bundle.session.id, async () => {
      const view =
        this.views.get(bundle.session.id) ??
        (await this.view(bundle, "Creator session ready."));
      assertActionBinding(action, view, this.consumedViewHashes);
      if (
        [
          "approve_and_apply_changes",
          "start_checks",
          "cancel_changes",
          "reject_and_rollback",
        ].includes(action.actionId)
      )
        await this.currentStudioSession();
      this.consumedViewHashes.add(action.viewHash);
      if (action.actionId === "approve_plan")
        return this.decidePlan(
          bundle,
          requiredArtifactHash(view, "plan"),
          "approved",
        );
      if (action.actionId === "reject_plan")
        return this.decidePlan(
          bundle,
          requiredArtifactHash(view, "plan"),
          "rejected",
        );
      if (action.actionId === "approve_and_apply_changes")
        return this.decideChanges(
          bundle,
          requiredArtifactHash(view, "change_set"),
          "approved",
        );
      if (action.actionId === "reject_changes")
        return this.decideChanges(
          bundle,
          requiredArtifactHash(view, "change_set"),
          "rejected",
        );
      if (action.actionId === "start_checks") return this.verify(bundle);
      if (action.actionId === "cancel_changes") return this.rollback(bundle);
      if (action.actionId === "accept_result")
        return this.review(bundle, "accepted", action.report);
      if (action.actionId === "reject_and_rollback")
        return this.rejectAndRollback(bundle, action.report);
      throw new Error("The requested creator action is unavailable");
    });
  }

  private async onPluginMessage(
    _message: PluginToBackendMessage,
    session: StudioBridgeSession,
  ): Promise<void> {
    this.pairedSession = session;
    this.emit();
  }

  private async start(prompt: string): Promise<unknown> {
    const canonicalPrompt = prompt.trim();
    if (canonicalPrompt.length === 0)
      throw new Error("Creator prompt must be non-empty");
    const studio = await this.currentStudioSession();
    return this.lock(`project:${studio.projectId}`, async () => {
      const active = [...this.bundles.values()].find(
        (bundle) =>
          bundle.session.projectId === studio.projectId &&
          !isTerminalStatus(bundle.session.status),
      );
      if (active)
        throw new Error(
          `Studio project already has a nonterminal creator session: ${active.session.id}`,
        );
      const fresh = await requestFreshStudioSnapshot(
        this.input.connection,
        studio,
        this.timeout(),
      );
      const ownership = createStudioOwnershipMap({
        projectId: studio.projectId,
        revisionHash: fresh.revisionHash,
        observation: fresh.observation,
        ...(this.input.externalRojoPaths
          ? { externalRojoPaths: this.input.externalRojoPaths }
          : {}),
      });
      let session = createCreatorSession({
        prompt: canonicalPrompt,
        projectId: studio.projectId,
        revisionHash: fresh.revisionHash,
        ownership,
      });
      let bundle: CreatorSessionBundle = {
        session,
        ownership,
        observation: fresh.observation,
        observationHistory: [
          {
            revisionHash: fresh.revisionHash,
            observation: structuredClone(fresh.observation),
          },
        ],
        buildContracts: [],
        approvals: [],
        changeSets: [],
        verifications: [],
        agentRuns: [],
      };
      this.bundles.set(session.id, bundle);
      await persistCreatorPrompt(
        session,
        canonicalPrompt,
        this.input.directory,
      );
      await this.persist(bundle);
      await this.publishView(
        bundle,
        "Generating a visible plan and verification charter. Studio is read-only.",
      );
      try {
        const planned = await this.input.worker.plan({
          session,
          ownership,
          observation: fresh.observation,
          prompt: canonicalPrompt,
          budgets: INITIAL_EXPERIMENT_BUDGETS,
        });
        bundle = {
          ...bundle,
          agentRuns: [...bundle.agentRuns, planned.evidence],
        };
        if (planned.status === "unsealed") {
          session = advanceSession(session, {
            status: "incomplete",
            failure: {
              code: planned.failure.code,
              detail: planned.failure.detail,
            },
          });
          bundle = { ...bundle, session };
          return this.finish(
            bundle,
            `Planner stopped: ${planned.failure.detail}`,
          );
        }
        session = advanceSession(session, {
          status: "awaiting_plan_approval",
          plan: planned.plan,
        });
        bundle = { ...bundle, session, plan: planned.plan };
        this.bundles.set(session.id, bundle);
        await this.persist(bundle);
        await this.publishView(
          bundle,
          "Review the exact plan, typed changes, and generated machine-check thresholds before approving.",
        );
        return summary(bundle);
      } catch (error) {
        session = advanceSession(session, {
          status: "incomplete",
          failure: {
            code: "planner_failure",
            detail: error instanceof Error ? error.message : String(error),
          },
        });
        bundle = { ...bundle, session };
        this.bundles.set(session.id, bundle);
        await this.persist(bundle);
        throw error;
      }
    });
  }

  private async decidePlan(
    bundle: CreatorSessionBundle,
    hash: string,
    decision: "approved" | "rejected",
  ): Promise<unknown> {
    if (
      bundle.session.status !== "awaiting_plan_approval" ||
      !bundle.plan ||
      bundle.plan.hash !== hash
    )
      throw new Error("Plan approval does not match the active immutable plan");
    const approval = createCreatorApproval({
      sessionId: bundle.session.id,
      artifactKind: "plan",
      artifactId: bundle.plan.id,
      artifactHash: bundle.plan.hash,
      decision,
      decidedAt: new Date().toISOString(),
    });
    if (decision === "rejected") {
      bundle = {
        ...bundle,
        approvals: [...bundle.approvals, approval],
        session: advanceSession(bundle.session, {
          status: "creator_rejected",
          approval,
        }),
      };
      return this.finish(bundle, "The creator rejected the proposed plan.");
    }
    const plan = bundle.plan;
    let session = advanceSession(bundle.session, {
      status: "building",
      approval,
    });
    bundle = { ...bundle, session, approvals: [...bundle.approvals, approval] };
    this.bundles.set(session.id, bundle);
    await this.persist(bundle);
    await this.publishView(
      bundle,
      "Building a virtual Studio change set. The live place remains unchanged.",
    );
    const prompt = await this.prompt(session.id);
    try {
      const built = await this.input.worker.build({
        session,
        ownership: bundle.ownership,
        observation: bundle.observation,
        prompt,
        plan,
        planApproval: approval,
        budgets: INITIAL_EXPERIMENT_BUDGETS,
      });
      bundle = {
        ...bundle,
        buildContracts: [...bundle.buildContracts, built.buildContract],
        agentRuns: [...bundle.agentRuns, built.evidence],
      };
      if (built.status === "unsealed") {
        bundle = {
          ...bundle,
          session: advanceSession(session, {
            status: "incomplete",
            failure: { code: built.failure.code, detail: built.failure.detail },
          }),
        };
        return this.finish(bundle, `Builder stopped: ${built.failure.detail}`);
      }
      session = advanceSession(session, {
        status: "awaiting_change_approval",
        changeSet: built.changeSet,
      });
      bundle = {
        ...bundle,
        session,
        changeSets: [...bundle.changeSets, built.changeSet],
      };
      this.bundles.set(session.id, bundle);
      await this.persist(bundle);
      await this.publishView(
        bundle,
        "Review the exact change-set hash. Approving applies this exact set immediately.",
      );
      return summary(bundle);
    } catch (error) {
      bundle = {
        ...bundle,
        session: advanceSession(session, {
          status: "incomplete",
          failure: { code: "builder_failure", detail: detail(error) },
        }),
      };
      return this.finish(bundle, `Builder stopped: ${detail(error)}`);
    }
  }

  private async decideChanges(
    bundle: CreatorSessionBundle,
    hash: string,
    decision: "approved" | "rejected",
  ): Promise<unknown> {
    const changeSet = requiredChangeSet(bundle);
    if (
      bundle.session.status !== "awaiting_change_approval" ||
      changeSet.hash !== hash
    )
      throw new Error(
        "Change approval does not match the active immutable change set",
      );
    const approval = createCreatorApproval({
      sessionId: bundle.session.id,
      artifactKind: "change_set",
      artifactId: changeSet.id,
      artifactHash: changeSet.hash,
      decision,
      decidedAt: new Date().toISOString(),
    });
    bundle = {
      ...bundle,
      approvals: [...bundle.approvals, approval],
      session: advanceSession(bundle.session, {
        status: decision === "approved" ? "applying" : "creator_rejected",
        approval,
      }),
    };
    this.bundles.set(bundle.session.id, bundle);
    await this.persist(bundle);
    if (decision === "approved") return this.apply(bundle);
    return this.finish(bundle, "The creator rejected the change set.");
  }

  private async apply(bundle: CreatorSessionBundle): Promise<unknown> {
    const changeSet = requiredChangeSet(bundle);
    if (bundle.session.status !== "applying" || !bundle.session.changeApproval)
      throw new Error("Creator change set is not approved for application");
    const studio = await this.currentStudioSession();
    const fresh = await requestFreshStudioSnapshot(
      this.input.connection,
      studio,
      this.timeout(),
    );
    if (fresh.revisionHash !== changeSet.expectedRevisionHash)
      return this.drift(
        bundle,
        "Studio changed after the creator approved the change set",
      );
    const messages: PluginToBackendMessage[] = [];
    const unsubscribe = this.capture(studio, messages);
    try {
      const requestId = `creator_apply_${randomUUID()}`;
      const json = serializeCreatorChangeSet(changeSet);
      await this.input.connection.send(
        createBackendMessage(
          "PrepareCreatorChangeSet",
          {
            requestId,
            creatorSessionId: bundle.session.id,
            expectedRevision: fresh.revisionHash,
            changeSetJson: json,
            changeSetJsonHash: contentHash(json),
          },
          studio.sessionId,
          requestId,
        ),
      );
      await waitFor(
        messages,
        (
          message,
        ): message is Extract<
          PluginToBackendMessage,
          { type: "CreatorChangePrepared" }
        > =>
          message.type === "CreatorChangePrepared" &&
          message.requestId === requestId &&
          message.payload.creatorSessionId === bundle.session.id &&
          message.payload.changeSetId === changeSet.id &&
          message.payload.changeSetHash === changeSet.hash &&
          message.payload.beforeRevisionHash === fresh.revisionHash &&
          message.payload.status === "prepared",
        this.timeout(),
        "creator change preparation",
      );
      await this.input.connection.send(
        createBackendMessage(
          "ApplyCreatorChangeSet",
          {
            requestId,
            creatorSessionId: bundle.session.id,
            changeSetId: changeSet.id,
            changeSetHash: changeSet.hash,
            expectedRevision: fresh.revisionHash,
          },
          studio.sessionId,
          requestId,
        ),
      );
      const applied = await waitFor(
        messages,
        (
          message,
        ): message is Extract<
          PluginToBackendMessage,
          { type: "CreatorChangeApplied" }
        > =>
          message.type === "CreatorChangeApplied" &&
          message.requestId === requestId &&
          message.payload.creatorSessionId === bundle.session.id &&
          message.payload.changeSetId === changeSet.id &&
          message.payload.changeSetHash === changeSet.hash &&
          message.payload.beforeRevisionHash === fresh.revisionHash &&
          message.payload.status === "applied",
        this.timeout(),
        "creator change application",
      );
      const observed = await waitFor(
        messages,
        (
          message,
        ): message is Extract<
          PluginToBackendMessage,
          { type: "ProjectObservation" }
        > =>
          message.type === "ProjectObservation" &&
          message.payload.reason === "post_apply" &&
          message.payload.revision.observationHash ===
            applied.payload.afterRevisionHash,
        this.timeout(),
        "post-apply Studio observation",
      );
      const afterRevisionHash = requiredHash(
        applied.payload.afterRevisionHash,
        "post-apply revision",
      );
      const mismatch = reconcileAppliedChangeSet(
        changeSet,
        observed.payload.observation,
      );
      if (mismatch) {
        // Preserve the transient applied state even though Forge immediately
        // cancels it. A failed reconciliation is still evidence and must not
        // disappear merely because Studio recovered successfully.
        bundle = appendObservationHistory(
          bundle,
          afterRevisionHash,
          observed.payload.observation,
        );
        const finalized = await this.finalizeRecording(
          studio,
          bundle.session.id,
          changeSet,
          applied.payload.recordingId,
          "cancel",
          messages,
        );
        const rollbackRevisionHash = requiredHash(
          finalized.payload.afterRevisionHash,
          "cancelled Studio revision",
        );
        const reverted = await waitFor(
          messages,
          (
            message,
          ): message is Extract<
            PluginToBackendMessage,
            { type: "ProjectObservation" }
          > =>
            message.type === "ProjectObservation" &&
            message.payload.reason === "post_rollback" &&
            message.payload.revision.observationHash === rollbackRevisionHash,
          this.timeout(),
          "post-cancel Studio observation",
        );
        bundle = recordObservation(
          {
            ...bundle,
            session: advanceSession(bundle.session, {
              status: "incomplete",
              revisionHash: rollbackRevisionHash,
              failure: { code: "post_apply_mismatch", detail: mismatch },
            }),
          },
          rollbackRevisionHash,
          reverted.payload.observation,
        );
        return this.finish(
          bundle,
          `Applied state did not match the approved change set: ${mismatch}`,
        );
      }
      const inverseMaterialHash = requiredHash(
        applied.payload.inverseMaterialHash,
        "inverse material",
      );
      this.pendingRecordings.set(bundle.session.id, {
        recordingId: applied.payload.recordingId,
        beforeRevisionHash: applied.payload.beforeRevisionHash,
        afterRevisionHash,
        inverseMaterialHash,
      });
      bundle = recordObservation(
        {
          ...bundle,
          session: advanceSession(bundle.session, {
            status: "awaiting_verification",
            revisionHash: afterRevisionHash,
          }),
        },
        afterRevisionHash,
        observed.payload.observation,
      );
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      await this.publishView(
        bundle,
        "Changes are applied inside an open Studio recording. Start the exact approved checks, or cancel the uncommitted changes.",
      );
      return summary(bundle);
    } finally {
      unsubscribe();
    }
  }

  private async verify(bundle: CreatorSessionBundle): Promise<unknown> {
    const changeSet = requiredChangeSet(bundle);
    const pending = this.pendingRecordings.get(bundle.session.id);
    if (
      bundle.session.status !== "awaiting_verification" ||
      !pending ||
      !bundle.plan
    )
      throw new Error(
        "Creator session has no applied change awaiting verification",
      );
    const plan = bundle.plan;
    const studio = await this.currentStudioSession();
    bundle = {
      ...bundle,
      session: advanceSession(bundle.session, { status: "verifying" }),
    };
    this.bundles.set(bundle.session.id, bundle);
    await this.persist(bundle);
    await this.publishView(
      bundle,
      "Starting the exact creator-approved checks. Studio will enter Play Solo once for this action.",
    );
    const { targets, calls } = createCharterExecution(plan.charter.clauses);
    const executionPlan = createStudioExecutionPlan({
      purpose: "creator_verification",
      capabilitySetId: STUDIO_CAPABILITY_SET.id,
      capabilitySetHash: STUDIO_CAPABILITY_SET.hash,
      binding: {
        runId: `creator_verify_${randomUUID()}`,
        correlationId: `creator_correlation_${randomUUID()}`,
        sessionId: studio.sessionId,
        projectId: studio.projectId,
        project: studio.project,
        projectSnapshotHash: bundle.session.currentRevisionHash,
      },
      targets,
      calls,
      budget: { maxExecutionMs: 20_000, maxResultBytes: 64 * 1024 },
    });
    const snapshotFailures = gradeSnapshotCharter(
      plan.charter.clauses,
      bundle.observation,
    );
    const observed =
      snapshotFailures.length === 0
        ? await executeCreatorVerificationPlan({
            connection: this.input.connection,
            session: studio,
            executionPlan,
            timeoutMs: this.timeout(),
          })
        : undefined;
    const failures =
      snapshotFailures.length > 0
        ? snapshotFailures
        : observed?.status === "completed" && observed.observation
          ? gradeRuntimeCharter(plan.charter.clauses, observed.observation)
          : [
              observed?.failure?.detail ??
                "Studio verification did not complete",
            ];
    const executionPlanArtifact = await this.artifactStore.write(executionPlan);
    const runtimeObservationArtifact = observed?.observation
      ? await this.artifactStore.write(observed.observation)
      : undefined;
    const verification = createVerificationRecord(
      bundle.session.id,
      changeSet,
      plan.charter,
      executionPlan,
      executionPlanArtifact,
      bundle.session.currentRevisionHash,
      verificationEvidenceHash(bundle.observation),
      observed?.observation,
      runtimeObservationArtifact,
      failures,
      snapshotFailures.length > 0 || observed?.status === "completed",
      observed?.failure?.detail,
    );
    bundle = {
      ...bundle,
      verifications: [...bundle.verifications, verification],
    };
    this.bundles.set(bundle.session.id, bundle);
    await this.persist(bundle);
    const messages: PluginToBackendMessage[] = [];
    const unsubscribe = this.capture(studio, messages);
    try {
      if (failures.length === 0) {
        const finalized = await this.finalizeRecording(
          studio,
          bundle.session.id,
          changeSet,
          pending.recordingId,
          "commit",
          messages,
        );
        const finalizedRevision = requiredHash(
          finalized.payload.afterRevisionHash,
          "committed Studio revision",
        );
        const committed = await requestFreshStudioSnapshot(
          this.input.connection,
          studio,
          this.timeout(),
        );
        if (committed.revisionHash !== finalizedRevision)
          throw new Error(
            "Committed creator recording did not reconcile to its reported Studio revision",
          );
        const checkpoint = createCheckpoint(
          bundle.session.id,
          changeSet,
          pending,
          finalizedRevision,
        );
        bundle = recordObservation(
          {
            ...bundle,
            checkpoint,
            session: advanceSession(bundle.session, {
              status: "awaiting_review",
              checkpoint,
              revisionHash: finalizedRevision,
            }),
          },
          finalizedRevision,
          committed.observation,
        );
        this.pendingRecordings.delete(bundle.session.id);
        this.bundles.set(bundle.session.id, bundle);
        await this.persist(bundle);
        await this.publishView(
          bundle,
          "Machine checks completed. Visually review the exact result, then accept it or reject and roll it back.",
        );
        return summary(bundle);
      }
      const finalized = await this.finalizeRecording(
        studio,
        bundle.session.id,
        changeSet,
        pending.recordingId,
        "cancel",
        messages,
      );
      this.pendingRecordings.delete(bundle.session.id);
      const rollbackRevision = requiredHash(
        finalized.payload.afterRevisionHash,
        "rollback revision",
      );
      const reverted = await requestFreshStudioSnapshot(
        this.input.connection,
        studio,
        this.timeout(),
      );
      if (reverted.revisionHash !== rollbackRevision)
        throw new Error(
          "Cancelled creator recording did not reconcile to its reported Studio revision",
        );
      if (bundle.session.repairsUsed >= 2) {
        bundle = recordObservation(
          {
            ...bundle,
            session: advanceSession(bundle.session, {
              status: "incomplete",
              revisionHash: rollbackRevision,
              failure: {
                code: "verification_failed",
                detail: failures.join("; "),
              },
            }),
          },
          rollbackRevision,
          reverted.observation,
        );
        return this.finish(
          bundle,
          `Verification failed and the repair budget is exhausted: ${failures.join("; ")}`,
        );
      }
      bundle = recordObservation(
        {
          ...bundle,
          session: advanceSession(bundle.session, {
            status: "repairing",
            revisionHash: rollbackRevision,
          }),
        },
        rollbackRevision,
        reverted.observation,
      );
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      return this.repair(bundle, verification);
    } finally {
      unsubscribe();
    }
  }

  private async repair(
    bundle: CreatorSessionBundle,
    verification: CreatorVerificationRecord,
  ): Promise<unknown> {
    if (!bundle.plan) throw new Error("Repair requires the approved plan");
    const planApproval = bundle.approvals.find(
      (approval) =>
        approval.artifactKind === "plan" && approval.decision === "approved",
    );
    if (!planApproval)
      throw new Error("Repair requires the original plan approval");
    const prompt = await this.prompt(bundle.session.id);
    if (
      verification.status !== "failed" ||
      verification.failureFacts.length === 0 ||
      !bundle.verifications.some(
        (record) =>
          record.id === verification.id && record.hash === verification.hash,
      )
    )
      throw new Error(
        "Repair requires persisted canonical verification failure facts",
      );
    const built = await this.input.worker.build({
      session: bundle.session,
      ownership: bundle.ownership,
      observation: bundle.observation,
      prompt,
      plan: bundle.plan,
      planApproval,
      verificationFeedback: verification.failureFacts.map(
        (fact) => fact.statement,
      ),
      budgets: INITIAL_EXPERIMENT_BUDGETS,
    });
    bundle = {
      ...bundle,
      buildContracts: [...bundle.buildContracts, built.buildContract],
      agentRuns: [...bundle.agentRuns, built.evidence],
    };
    if (built.status === "unsealed") {
      bundle = {
        ...bundle,
        session: advanceSession(bundle.session, {
          status: "incomplete",
          failure: { code: built.failure.code, detail: built.failure.detail },
        }),
      };
      return this.finish(
        bundle,
        `Repair builder stopped: ${built.failure.detail}`,
      );
    }
    bundle = {
      ...bundle,
      changeSets: [...bundle.changeSets, built.changeSet],
      session: advanceSession(bundle.session, {
        status: "awaiting_change_approval",
        changeSet: built.changeSet,
      }),
    };
    this.bundles.set(bundle.session.id, bundle);
    await this.persist(bundle);
    await this.publishView(
      bundle,
      "The failed attempt was cancelled. Review the repaired exact change set; approval applies it immediately.",
    );
    return summary(bundle);
  }

  private async review(
    bundle: CreatorSessionBundle,
    decision: "accepted" | "rejected",
    report?: string,
  ): Promise<unknown> {
    const changeSet = requiredChangeSet(bundle);
    if (
      bundle.session.status !== "awaiting_review" ||
      !bundle.checkpoint ||
      !bundle.plan
    )
      throw new Error("Creator session is not awaiting final review");
    const review = createCreatorReviewReport({
      sessionId: bundle.session.id,
      changeSetId: changeSet.id,
      changeSetHash: changeSet.hash,
      charterId: bundle.plan.charter.id,
      charterHash: bundle.plan.charter.hash,
      decision,
      report: report ?? "",
      reviewedObservationHash: verificationEvidenceHash(bundle.observation),
      reviewedAt: new Date().toISOString(),
    });
    const artifact = await this.artifactStore.write(review);
    bundle = {
      ...bundle,
      review: { report: review, artifact },
      session: advanceSession(bundle.session, {
        status:
          decision === "accepted" ? "creator_accepted" : "creator_rejected",
        review,
      }),
    };
    return this.finish(
      bundle,
      decision === "accepted"
        ? "The creator accepted the exact reviewed result."
        : "The creator rejected the reviewed result. The committed change remains available for guarded rollback.",
    );
  }

  private async rejectAndRollback(
    bundle: CreatorSessionBundle,
    report?: string,
  ): Promise<unknown> {
    if (bundle.session.status !== "awaiting_review" || !bundle.plan)
      throw new Error("Creator session is not awaiting final review");
    // Do not seal the creator's rejection until guarded undo has a paired
    // Studio authority available. An offline review must remain resumable.
    await this.currentStudioSession();
    const changeSet = requiredChangeSet(bundle);
    const review = createCreatorReviewReport({
      sessionId: bundle.session.id,
      changeSetId: changeSet.id,
      changeSetHash: changeSet.hash,
      charterId: bundle.plan.charter.id,
      charterHash: bundle.plan.charter.hash,
      decision: "rejected" as const,
      report: report ?? "",
      reviewedObservationHash: verificationEvidenceHash(bundle.observation),
      reviewedAt: new Date().toISOString(),
    });
    const artifact = await this.artifactStore.write(review);
    bundle = {
      ...bundle,
      review: { report: review, artifact },
      session: advanceSession(bundle.session, {
        status: "creator_rejected",
        review,
      }),
    };
    this.bundles.set(bundle.session.id, bundle);
    await this.persist(bundle);
    return this.rollback(bundle);
  }

  private async rollback(bundle: CreatorSessionBundle): Promise<unknown> {
    if (bundle.session.status === "awaiting_verification") {
      const studio = await this.currentStudioSession();
      const changeSet = requiredChangeSet(bundle);
      const pending = this.pendingRecordings.get(bundle.session.id);
      if (!pending)
        throw new Error("No active Studio recording can be cancelled");
      const messages: PluginToBackendMessage[] = [];
      const unsubscribe = this.capture(studio, messages);
      try {
        const finalized = await this.finalizeRecording(
          studio,
          bundle.session.id,
          changeSet,
          pending.recordingId,
          "cancel",
          messages,
        );
        const rollbackRevision = requiredHash(
          finalized.payload.afterRevisionHash,
          "cancelled Studio revision",
        );
        const reverted = await requestFreshStudioSnapshot(
          this.input.connection,
          studio,
          this.timeout(),
        );
        if (reverted.revisionHash !== rollbackRevision)
          throw new Error(
            "Cancelled creator recording did not reconcile to its reported Studio revision",
          );
        this.pendingRecordings.delete(bundle.session.id);
        bundle = recordObservation(
          {
            ...bundle,
            session: advanceSession(bundle.session, {
              status: "creator_rejected",
              revisionHash: rollbackRevision,
            }),
          },
          rollbackRevision,
          reverted.observation,
        );
        return this.finish(
          bundle,
          "The creator cancelled the uncommitted Studio change recording.",
        );
      } finally {
        unsubscribe();
      }
    }
    if (
      (bundle.session.status === "awaiting_review" ||
        bundle.session.status === "creator_rejected") &&
      bundle.checkpoint?.status === "committed"
    ) {
      const studio = await this.currentStudioSession();
      const changeSet = requiredChangeSet(bundle);
      const checkpoint = bundle.checkpoint;
      const fresh = await requestFreshStudioSnapshot(
        this.input.connection,
        studio,
        this.timeout(),
      );
      if (fresh.revisionHash !== checkpoint.afterRevisionHash)
        throw new Error(
          "Guarded rollback refused because Studio changed after the Forge checkpoint",
        );
      const messages: PluginToBackendMessage[] = [];
      const unsubscribe = this.capture(studio, messages);
      try {
        const requestId = `creator_rollback_${randomUUID()}`;
        await this.input.connection.send(
          createBackendMessage(
            "RollbackCreatorCheckpoint",
            {
              requestId,
              creatorSessionId: bundle.session.id,
              checkpointId: checkpoint.id,
              changeSetId: changeSet.id,
              changeSetHash: changeSet.hash,
              expectedRevision: checkpoint.afterRevisionHash,
            },
            studio.sessionId,
            requestId,
          ),
        );
        const rolled = await waitFor(
          messages,
          (
            message,
          ): message is Extract<
            PluginToBackendMessage,
            { type: "CreatorCheckpointRolledBack" }
          > =>
            message.type === "CreatorCheckpointRolledBack" &&
            message.requestId === requestId &&
            message.payload.creatorSessionId === bundle.session.id &&
            message.payload.checkpointId === checkpoint.id &&
            message.payload.changeSetId === changeSet.id &&
            message.payload.changeSetHash === changeSet.hash &&
            message.payload.beforeRevisionHash ===
              checkpoint.afterRevisionHash &&
            message.payload.status === "rolled_back",
          this.timeout(),
          "guarded creator rollback",
        );
        const observed = await waitFor(
          messages,
          (
            message,
          ): message is Extract<
            PluginToBackendMessage,
            { type: "ProjectObservation" }
          > =>
            message.type === "ProjectObservation" &&
            message.payload.reason === "post_rollback" &&
            message.payload.revision.observationHash ===
              rolled.payload.afterRevisionHash,
          this.timeout(),
          "post-rollback Studio observation",
        );
        const afterRevision = requiredHash(
          rolled.payload.afterRevisionHash,
          "post-rollback revision",
        );
        const rolledCheckpoint = updateCheckpointStatus(
          checkpoint,
          "rolled_back",
        );
        bundle = recordObservation(
          {
            ...bundle,
            checkpoint: rolledCheckpoint,
            session: advanceSession(bundle.session, {
              status: "rolled_back",
              checkpoint: rolledCheckpoint,
              revisionHash: afterRevision,
            }),
          },
          afterRevision,
          observed.payload.observation,
        );
        return this.finish(
          bundle,
          "The exact Forge checkpoint was rolled back through Studio Change History.",
        );
      } finally {
        unsubscribe();
      }
    }
    throw new Error(
      "This creator session has no exact rollback-eligible Studio checkpoint",
    );
  }

  private async finalizeRecording(
    studio: StudioBridgeSession,
    sessionId: string,
    changeSet: CreatorChangeSet,
    recordingId: string,
    action: "commit" | "cancel",
    messages: PluginToBackendMessage[],
  ) {
    const requestId = `creator_finalize_${randomUUID()}`;
    await this.input.connection.send(
      createBackendMessage(
        "FinalizeCreatorChangeSet",
        {
          requestId,
          creatorSessionId: sessionId,
          changeSetId: changeSet.id,
          changeSetHash: changeSet.hash,
          recordingId,
          action,
        },
        studio.sessionId,
        requestId,
      ),
    );
    return waitFor(
      messages,
      (
        message,
      ): message is Extract<
        PluginToBackendMessage,
        { type: "CreatorChangeFinalized" }
      > =>
        message.type === "CreatorChangeFinalized" &&
        message.requestId === requestId &&
        message.payload.creatorSessionId === sessionId &&
        message.payload.changeSetId === changeSet.id &&
        message.payload.changeSetHash === changeSet.hash &&
        message.payload.recordingId === recordingId &&
        message.payload.action === action &&
        message.payload.status ===
          (action === "commit" ? "committed" : "cancelled"),
      this.timeout(),
      `creator change ${action}`,
    );
  }

  private async publishView(
    bundle: CreatorSessionBundle,
    detailValue: string,
  ): Promise<void> {
    const view = await this.view(bundle, detailValue);
    this.views.set(bundle.session.id, view);
    this.emit();
  }

  private capture(
    studio: StudioBridgeSession,
    messages: PluginToBackendMessage[],
  ): () => void {
    return this.input.connection.subscribeWithSession((message, session) => {
      if (
        session.sessionId === studio.sessionId &&
        message.sessionId === studio.sessionId
      )
        messages.push(message);
    });
  }
  private async currentStudioSession(): Promise<StudioBridgeSession> {
    const sessions =
      "getSessions" in this.input.connection &&
      typeof this.input.connection.getSessions === "function"
        ? (this.input.connection.getSessions as () => StudioBridgeSession[])()
        : [];
    if (sessions.length === 1) {
      this.pairedSession = sessions[0]!;
      return sessions[0]!;
    }
    if (!("getSessions" in this.input.connection) && this.pairedSession)
      return this.pairedSession;
    throw new Error(
      "Exactly one Studio project must be paired with forge creator serve",
    );
  }
  private timeout(): number {
    return this.input.timeoutMs ?? 180_000;
  }
  private async prompt(sessionId: string): Promise<string> {
    return readFile(
      join(resolve(this.input.directory), `${sessionId}.prompt.txt`),
      "utf8",
    );
  }
  private async view(
    bundle: CreatorSessionBundle,
    detailValue: string,
  ): Promise<CreatorControlView> {
    const prompt = await this.prompt(bundle.session.id);
    const changeSet = activeChangeSet(bundle);
    const verification = bundle.verifications.at(-1);
    const [promptArtifact, planArtifact, changeSetArtifact, verificationArtifact] =
      await Promise.all([
        this.artifactStore.write({
          kind: "CreatorPrompt",
          sessionId: bundle.session.id,
          promptHash: bundle.session.promptHash,
          text: prompt,
        }),
        bundle.plan ? this.artifactStore.write(bundle.plan) : undefined,
        changeSet ? this.artifactStore.write(changeSet) : undefined,
        verification ? this.artifactStore.write(verification) : undefined,
      ]);
    const latestRun = bundle.agentRuns.at(-1);
    return controlView(bundle, detailValue, prompt, {
      prompt: promptArtifact,
      ...(planArtifact ? { plan: planArtifact } : {}),
      ...(changeSetArtifact ? { changeSet: changeSetArtifact } : {}),
      ...(verification?.executionPlan
        ? { studioExecutionPlan: verification.executionPlan.artifact }
        : {}),
      ...(verification?.runtimeObservation
        ? { runtimeObservation: verification.runtimeObservation.artifact }
        : {}),
      ...(verificationArtifact ? { verification: verificationArtifact } : {}),
      ...(bundle.review ? { reviewReport: bundle.review.artifact } : {}),
      ...(latestRun
        ? { agentRun: latestRun.agentRun, trace: latestRun.trace }
        : {}),
    });
  }
  private async bundle(id: string): Promise<CreatorSessionBundle> {
    const cached = this.bundles.get(id);
    if (cached) return cached;
    const loaded = await loadCreatorBundle(
      join(resolve(this.input.directory), `${id}.json`),
    );
    this.bundles.set(id, loaded);
    return loaded;
  }
  private async persist(bundle: CreatorSessionBundle): Promise<void> {
    await persistCreatorBundle(bundle, this.input.directory);
    this.emit();
  }
  private async finish(
    bundle: CreatorSessionBundle,
    message: string,
  ): Promise<unknown> {
    this.bundles.set(bundle.session.id, bundle);
    await this.persist(bundle);
    await this.publishView(bundle, message);
    return summary(bundle);
  }
  private async drift(
    bundle: CreatorSessionBundle,
    message: string,
  ): Promise<unknown> {
    bundle = {
      ...bundle,
      session: advanceSession(bundle.session, {
        status: "incomplete",
        failure: { code: "project_drift", detail: message },
      }),
    };
    return this.finish(bundle, message);
  }
  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.inFlight.has(key))
      throw new Error(
        "A creator operation is already running for this session",
      );
    this.inFlight.add(key);
    try {
      return await operation();
    } finally {
      this.inFlight.delete(key);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function requiredChangeSet(bundle: CreatorSessionBundle): CreatorChangeSet {
  const changeSet = activeChangeSet(bundle);
  if (!changeSet) throw new Error("Creator session has no active change set");
  return changeSet;
}
function bundleArtifactReferences(
  bundle: CreatorSessionBundle,
): ArtifactReference[] {
  return [
    ...bundle.agentRuns.flatMap((run) => [run.agentRun, run.trace]),
    ...bundle.verifications.flatMap((verification) => [
      verification.executionPlan.artifact,
      ...(verification.runtimeObservation
        ? [verification.runtimeObservation.artifact]
        : []),
    ]),
    ...(bundle.review ? [bundle.review.artifact] : []),
  ];
}
function isTerminalStatus(
  status: CreatorSessionBundle["session"]["status"],
): boolean {
  return [
    "creator_accepted",
    "creator_rejected",
    "rolled_back",
    "incomplete",
    "recovery_required",
  ].includes(status);
}
function creatorProgress(
  session: CreatorSessionBundle["session"] | undefined,
): CreatorProgressStage[] {
  const order = ["request", "plan", "change", "studio", "review"] as const;
  const labels = {
    request: "Request",
    plan: "Plan",
    change: "Change",
    studio: "Studio",
    review: "Review",
  } as const;
  const authority = {
    request: "creator",
    plan: "agent",
    change: "agent",
    studio: "studio",
    review: "creator",
  } as const;
  if (!session)
    return order.map((id) => ({
      id,
      label: labels[id],
      status: "pending",
      authority: authority[id],
      detail: `${labels[id]} evidence`,
    }));
  const status = session.status;
  const activeIndex = ["planning"].includes(status)
      ? 1
      : ["awaiting_plan_approval"].includes(status)
        ? 1
        : ["building", "awaiting_change_approval"].includes(status)
          ? 2
          : [
                "applying",
                "awaiting_verification",
                "verifying",
                "repairing",
              ].includes(status)
            ? 3
            : status === "recovery_required"
              ? 3
              : status === "incomplete"
                ? !session.plan
                  ? 1
                  : !session.changeSet
                    ? 2
                    : !session.checkpoint
                      ? 3
                      : 4
                : status === "creator_rejected" && !session.review
                  ? session.changeSet
                    ? 2
                    : 1
                  : 4;
  const failed = status === "incomplete" || status === "creator_rejected";
  const blocked = status === "recovery_required";
  return order.map((id, index) => ({
    id,
    label: labels[id],
    status:
      index < activeIndex
        ? "complete"
        : index === activeIndex
          ? blocked
            ? "blocked"
            : failed
              ? "failed"
            : status === "creator_accepted" || status === "rolled_back"
              ? "complete"
              : "active"
          : "pending",
    authority: authority[id],
    detail:
      index === activeIndex
        ? status.replaceAll("_", " ")
        : `${labels[id]} evidence`,
  }));
}
function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
function activeChangeSet(
  bundle: CreatorSessionBundle,
): CreatorChangeSet | undefined {
  const reference = bundle.session.changeSet;
  return reference
    ? bundle.changeSets.find(
        (candidate) =>
          candidate.id === reference.id && candidate.hash === reference.hash,
      )
    : undefined;
}
function summary(bundle: CreatorSessionBundle): unknown {
  const changeSet = activeChangeSet(bundle);
  return {
    kind: "ForgeCreatorSessionSummary",
    creatorSessionId: bundle.session.id,
    creatorSessionHash: bundle.session.hash,
    status: bundle.session.status,
    planId: bundle.plan?.id,
    planHash: bundle.plan?.hash,
    charterId: bundle.plan?.charter.id,
    charterHash: bundle.plan?.charter.hash,
    changeSetId: changeSet?.id,
    changeSetHash: changeSet?.hash,
    checkpointId: bundle.checkpoint?.id,
    verificationIds: bundle.verifications.map((record) => record.id),
    reviewId: bundle.review?.report.id,
    repairsUsed: bundle.session.repairsUsed,
  };
}
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function requiredHash(value: string | undefined, label: string): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(`Studio omitted a valid ${label} hash`);
  return value;
}
function assertControlAction(value: unknown): CreatorControlAction {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid creator control action");
  const action = value as Record<string, unknown>;
  if (
    action.action === "start" &&
    typeof action.prompt === "string" &&
    action.prompt.trim().length > 0 &&
    action.prompt.length <= 16_000
  )
    return { action: "start", prompt: action.prompt };
  if (
    action.action === "act" &&
    typeof action.sessionId === "string" &&
    typeof action.viewId === "string" &&
    typeof action.viewHash === "string" &&
    /^[a-f0-9]{64}$/.test(action.viewHash) &&
    [
      "approve_plan",
      "reject_plan",
      "approve_and_apply_changes",
      "reject_changes",
      "start_checks",
      "accept_result",
      "reject_and_rollback",
      "cancel_changes",
    ].includes(String(action.actionId)) &&
    (action.report === undefined ||
      (typeof action.report === "string" &&
        Buffer.byteLength(action.report, "utf8") <= 4096)) &&
    (!["accept_result", "reject_and_rollback"].includes(
      String(action.actionId),
    ) ||
      (typeof action.report === "string" && action.report.trim().length > 0))
  )
    return action as CreatorControlAction;
  throw new Error("Invalid creator control action");
}
function assertActionBinding(
  action: Extract<CreatorControlAction, { action: "act" }>,
  view: CreatorControlView,
  consumed: Set<string>,
): void {
  assertCreatorControlActionBinding(
    view,
    {
      creatorSessionId: action.sessionId,
      viewId: action.viewId,
      viewHash: action.viewHash,
      actionId: action.actionId,
    },
    consumed.has(action.viewHash),
  );
}
function requiredArtifactHash(
  view: CreatorControlView,
  kind: "plan" | "change_set",
): string {
  if (view.artifact?.kind !== kind)
    throw new Error(`Creator control view does not bind a ${kind}`);
  return view.artifact.hash;
}
function controlView(
  bundle: CreatorSessionBundle,
  detailValue: string,
  prompt?: string,
  artifacts?: NonNullable<CreatorControlView["artifacts"]>,
): CreatorControlView {
  if (
    bundle.session.status === "awaiting_plan_approval" &&
    bundle.plan &&
    prompt === undefined
  )
    throw new Error("Plan review requires the exact private creator request");
  const presentsPlan =
    bundle.session.status === "awaiting_plan_approval" &&
    bundle.plan !== undefined;
  const changeSet = activeChangeSet(bundle);
  const presentsChangeSet =
    [
      "awaiting_change_approval",
      "applying",
      "awaiting_verification",
      "verifying",
      "awaiting_review",
    ].includes(bundle.session.status) && changeSet !== undefined;
  const presentation = presentsPlan
    ? createPlanReviewPresentation(bundle, prompt!)
    : presentsChangeSet
      ? createChangeReviewPresentation(changeSet!, bundle.observation)
      : undefined;
  const artifact = presentsPlan
    ? {
        kind: "plan" as const,
        id: bundle.plan!.id,
        hash: bundle.plan!.hash,
        presentation,
        presentationHash: contentHash(stableJson(presentation)),
      }
    : presentsChangeSet
      ? {
          kind: "change_set" as const,
          id: changeSet!.id,
          hash: changeSet!.hash,
          presentation,
          presentationHash: contentHash(stableJson(presentation)),
        }
      : undefined;
  const actions = controlActions(bundle.session.status);
  const evidence = bundle.agentRuns.map(
    ({
      phase,
      agentRunId,
      agentRun,
      traceId,
      trace,
      traceBuildKey,
    }) => ({
      phase,
      agentRunId,
      agentRun,
      traceId,
      trace,
      traceBuildKey,
    }),
  );
  const creatorReviewPrompts = bundle.plan?.charter.clauses
    .filter((clause) => clause.kind === "creator_review")
    .map((clause) => clause.statement);
  return createCreatorControlView({
    creatorSessionId: bundle.session.id,
    creatorSessionHash: bundle.session.hash,
    status: bundle.session.status,
    title: controlTitle(bundle.session.status),
    detail: detailValue.slice(0, 4096),
    ...(artifact ? { artifact } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(creatorReviewPrompts && creatorReviewPrompts.length > 0
      ? { creatorReviewPrompts }
      : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(bundle.verifications.at(-1)
      ? {
          verification: {
            id: bundle.verifications.at(-1)!.id,
            status: bundle.verifications.at(-1)!.status,
            failureFacts: bundle.verifications.at(-1)!.failureFacts.map(
              (fact) => ({ ...fact }),
            ),
            replayable: bundle.verifications.at(-1)!.status !== "incomplete",
          },
        }
      : {}),
    ...actions,
  });
}
function controlActions(
  status: CreatorSessionBundle["session"]["status"],
): Pick<CreatorControlView, "primaryAction" | "secondaryAction"> {
  if (status === "awaiting_plan_approval")
    return {
      primaryAction: {
        id: "approve_plan",
        label: "Approve Plan",
        intent: "primary",
      },
      secondaryAction: {
        id: "reject_plan",
        label: "Reject",
        intent: "secondary",
      },
    };
  if (status === "awaiting_change_approval")
    return {
      primaryAction: {
        id: "approve_and_apply_changes",
        label: "Approve & Apply",
        intent: "primary",
      },
      secondaryAction: {
        id: "reject_changes",
        label: "Reject",
        intent: "secondary",
      },
    };
  if (status === "awaiting_verification")
    return {
      primaryAction: {
        id: "start_checks",
        label: "Start Approved Checks",
        intent: "primary",
      },
      secondaryAction: {
        id: "cancel_changes",
        label: "Cancel Changes",
        intent: "secondary",
      },
    };
  if (status === "awaiting_review")
    return {
      primaryAction: {
        id: "accept_result",
        label: "Accept Result",
        intent: "primary",
        requiresReport: true,
      },
      secondaryAction: {
        id: "reject_and_rollback",
        label: "Reject & Roll Back",
        intent: "secondary",
        requiresReport: true,
      },
    };
  return {};
}
function controlTitle(
  status: CreatorSessionBundle["session"]["status"],
): string {
  const titles: Record<CreatorSessionBundle["session"]["status"], string> = {
    planning: "Planning",
    awaiting_plan_approval: "Review Plan",
    building: "Building Changes",
    awaiting_change_approval: "Review Changes",
    applying: "Applying Approved Changes",
    awaiting_verification: "Ready for Checks",
    verifying: "Running Approved Checks",
    repairing: "Repairing Changes",
    awaiting_review: "Review Result",
    creator_accepted: "Accepted",
    creator_rejected: "Rejected",
    rolled_back: "Rolled Back",
    incomplete: "Incomplete",
    recovery_required: "Recovery Required",
  };
  return titles[status];
}

/**
 * Creator-visible plan review material. This is generated from the immutable
 * plan plus the private prompt file, rather than trusting the planner's prose
 * to describe either of them. It is included in the control view hash.
 */
export function createPlanReviewPresentation(
  bundle: CreatorSessionBundle,
  prompt: string,
): unknown {
  if (!bundle.plan || bundle.session.status !== "awaiting_plan_approval")
    throw new Error(
      "Plan review presentation requires an awaiting plan approval bundle",
    );
  if (
    contentHash(prompt) !== bundle.session.promptHash ||
    bundle.plan.promptHash !== bundle.session.promptHash
  )
    throw new Error(
      "Plan review creator request does not match the immutable session prompt",
    );
  const plan = bundle.plan;
  const outputCheckCoverage = plan.changes.flatMap((change) => {
    const output = plannedOutput(change);
    if (!output) return [];
    const matching = plan.charter.clauses.filter(
      (clause) =>
        clause.kind === "studio_check" &&
        (clause.check === "instance_exists" ||
          clause.check === "position_series") &&
        clause.path === output.path &&
        classCoversOutput(clause.expectedClass, output.className),
    );
    return [
      {
        changeId: change.id,
        path: output.path,
        className: output.className,
        clauseIds: matching.map((clause) => clause.id),
        covered: matching.length > 0,
      },
    ];
  });
  const machineCheckClauses = plan.charter.clauses
    .filter((clause) => clause.kind !== "creator_review")
    .map((clause) => ({
      id: clause.id,
      kind: clause.kind,
      check: clause.check,
      statement: clause.statement,
      ...("path" in clause
        ? { path: clause.path, expectedClass: clause.expectedClass }
        : {}),
    }));
  const creatorReviewClauses = plan.charter.clauses
    .filter((clause) => clause.kind === "creator_review")
    .map((clause) => ({ id: clause.id, statement: clause.statement }));
  return {
    creatorRequest: { text: prompt, promptHash: bundle.session.promptHash },
    plan: {
      id: plan.id,
      hash: plan.hash,
      goal: plan.goal,
      inspectionPaths: plan.inspectionPaths,
    },
    changes: plan.changes.map((change) => ({
      id: change.id,
      action: change.kind,
      summary: planChangeSummary(change),
      initializationCommitments: initializationCommitments(change),
    })),
    outputCheckCoverage,
    machineCheckClauses,
    creatorReviewClauses,
  };
}

function plannedOutput(
  change: CreatorPlanChange,
): { path: string; className: string } | undefined {
  if (change.kind === "create")
    return { path: change.path, className: change.className };
  if (change.kind === "move")
    return { path: change.toPath, className: change.expectedClass };
  return undefined;
}
function planChangeSummary(change: CreatorPlanChange): string {
  if (change.kind === "create")
    return `Create ${change.className} at ${change.path}.`;
  if (change.kind === "move")
    return `Move ${change.expectedClass} from ${change.fromPath} to ${change.toPath}.`;
  if (change.kind === "update")
    return `Update ${change.expectedClass} at ${change.path}.`;
  if (change.kind === "delete")
    return `Delete ${change.expectedClass} at ${change.path}.`;
  return `Replace source for ${change.expectedClass} at ${change.path}.`;
}
function initializationCommitments(change: CreatorPlanChange): string[] {
  if (change.kind === "create") {
    const commitments = [
      `The exact initial properties and attributes will be presented in the later hash-bound change set before Studio is mutated.`,
    ];
    if (change.initialization === "inline_source_required")
      commitments.push(
        "The later hash-bound create operation must carry the Script's inline source; its source hash is reconciled after apply.",
      );
    return commitments;
  }
  if (change.kind === "write_source")
    return [
      "The exact replacement source and its diff will be presented in the later hash-bound change set before Studio is mutated.",
    ];
  return [
    "The exact preconditions and concrete operation payload will be presented in the later hash-bound change set before Studio is mutated.",
  ];
}
function classCoversOutput(expected: string, actual: string): boolean {
  return (
    expected === actual ||
    (expected === "BasePart" &&
      [
        "Part",
        "MeshPart",
        "UnionOperation",
        "WedgePart",
        "CornerWedgePart",
        "TrussPart",
        "SpawnLocation",
        "VehicleSeat",
        "Seat",
      ].includes(actual))
  );
}
export function createChangeReviewPresentation(
  changeSet: CreatorChangeSet,
  observation: CreatorSessionBundle["observation"],
): unknown {
  const sourceDiffs = changeSet.operations.flatMap((operation) => {
    if (operation.kind === "write_source") {
      const before =
        observation.scripts.find(
          (script) => script.stableId === operation.stableId,
        )?.source ?? "";
      return [
        {
          path: operation.expectedPath,
          unifiedDiff: unifiedDiff(
            operation.expectedPath,
            before,
            operation.source,
          ),
        },
      ];
    }
    if (operation.kind === "create" && operation.source !== undefined)
      return [
        {
          path: `${operation.parentPath}/${operation.name}`,
          unifiedDiff: unifiedDiff(
            `${operation.parentPath}/${operation.name}`,
            "",
            operation.source,
          ),
        },
      ];
    return [];
  });
  return {
    changeSetId: changeSet.id,
    changeSetHash: changeSet.hash,
    localGate: changeSet.localGate,
    sourceDiffs,
    operations: changeSet.operations.map(operationPresentation),
  };
}
function operationPresentation(
  operation: CreatorChangeSet["operations"][number],
): unknown {
  const common = {
    id: operation.id,
    planChangeId: operation.planChangeId,
    kind: operation.kind,
    operationHash: contentHash(stableJson(operation)),
  };
  if (operation.kind === "create")
    return {
      ...common,
      target: `${operation.parentPath}/${operation.name}`,
      className: operation.className,
      parentPath: operation.parentPath,
      name: operation.name,
      properties: operation.properties,
      attributes: operation.attributes,
      ...(operation.source === undefined
        ? {}
        : {
            sourceHash: contentHash(operation.source),
            sourceUtf8Bytes: Buffer.byteLength(operation.source, "utf8"),
          }),
    };
  if (operation.kind === "update")
    return {
      ...common,
      target: operation.expectedPath,
      className: operation.expectedClass,
      beforeHash: operation.beforeHash,
      properties: operation.properties,
      attributes: operation.attributes,
      removedAttributes: operation.removedAttributes,
    };
  if (operation.kind === "move")
    return {
      ...common,
      target: operation.expectedPath,
      destination: `${operation.parentPath}/${operation.name}`,
      className: operation.expectedClass,
      beforeHash: operation.beforeHash,
      properties: operation.properties,
      attributes: operation.attributes,
      removedAttributes: operation.removedAttributes,
    };
  if (operation.kind === "delete")
    return {
      ...common,
      target: operation.expectedPath,
      className: operation.expectedClass,
      beforeHash: operation.beforeHash,
    };
  return {
    ...common,
    target: operation.expectedPath,
    className: operation.expectedClass,
    beforeSourceHash: operation.beforeSourceHash,
    sourceHash: contentHash(operation.source),
    sourceUtf8Bytes: Buffer.byteLength(operation.source, "utf8"),
    attributes: operation.attributes,
    removedAttributes: operation.removedAttributes,
  };
}
function unifiedDiff(path: string, before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}
export function reconcileAppliedChangeSet(
  changeSet: CreatorChangeSet,
  observation: CreatorSessionBundle["observation"],
): string | undefined {
  for (const operation of changeSet.operations) {
    if (operation.kind === "create") {
      const path = `${operation.parentPath}/${operation.name}`;
      const instance = observation.instances.find(
        (entry) =>
          entry.path === path && entry.className === operation.className,
      );
      if (!instance) return `created instance is absent: ${path}`;
      const mismatch = propertyMismatch(
        operation.properties,
        operation.attributes,
        [],
        instance,
      );
      if (mismatch) return `created instance ${instance.path} ${mismatch}`;
      const approvedSource = operation.source;
      if (
        isScriptClass(operation.className) &&
        approvedSource !== undefined &&
        !observation.scripts.some(
          (script) =>
            script.stableId === instance.stableId &&
            script.path === path &&
            script.sourceHash === contentHash(approvedSource),
        )
      )
        return `created script source hash mismatch: ${path}`;
    }
    if (operation.kind === "update") {
      const instance = observation.instances.find(
        (entry) => entry.stableId === operation.stableId,
      );
      if (!instance)
        return `updated instance is absent: ${operation.expectedPath}`;
      const mismatch = propertyMismatch(
        operation.properties,
        operation.attributes,
        operation.removedAttributes,
        instance,
      );
      if (mismatch) return `updated instance ${instance.path} ${mismatch}`;
    }
    if (
      operation.kind === "delete" &&
      observation.instances.some(
        (instance) => instance.stableId === operation.stableId,
      )
    )
      return `deleted instance remains: ${operation.expectedPath}`;
    if (operation.kind === "move") {
      const instance = observation.instances.find(
        (candidate) =>
          candidate.stableId === operation.stableId &&
          candidate.path === `${operation.parentPath}/${operation.name}`,
      );
      if (!instance)
        return `moved instance has the wrong path: ${operation.expectedPath}`;
      const mismatch = propertyMismatch(
        operation.properties,
        operation.attributes,
        operation.removedAttributes,
        instance,
      );
      if (mismatch) return `moved instance ${instance.path} ${mismatch}`;
    }
    if (operation.kind === "write_source") {
      const script = observation.scripts.find(
        (candidate) =>
          candidate.stableId === operation.stableId &&
          candidate.sourceHash === contentHash(operation.source),
      );
      if (!script)
        return `script source hash mismatch: ${operation.expectedPath}`;
      const instance = observation.instances.find(
        (candidate) => candidate.stableId === operation.stableId,
      );
      if (!instance)
        return `updated script instance is absent: ${operation.expectedPath}`;
      const mismatch = propertyMismatch(
        {},
        operation.attributes,
        operation.removedAttributes,
        instance,
      );
      if (mismatch) return `updated script ${instance.path} ${mismatch}`;
    }
  }
  return undefined;
}
function isScriptClass(className: string): boolean {
  return (
    className === "Script" ||
    className === "LocalScript" ||
    className === "ModuleScript"
  );
}
function propertyMismatch(
  properties: Record<string, import("./index.js").StudioValue>,
  attributes: Record<string, string | number | boolean>,
  removedAttributes: string[],
  instance: CreatorSessionBundle["observation"]["instances"][number],
): string | undefined {
  const observedProperties = new Map(
    instance.properties.map((entry) => [entry.name, entry.value]),
  );
  for (const [name, expected] of Object.entries(properties))
    if (!matchesStudioValue(observedProperties.get(name), expected))
      return `has a mismatched ${name} property`;
  const observedAttributes = new Map(
    instance.attributes.map((entry) => [entry.name, entry.value]),
  );
  for (const [name, expected] of Object.entries(attributes))
    if (observedAttributes.get(name) !== expected)
      return `has a mismatched ${name} attribute`;
  for (const name of removedAttributes)
    if (observedAttributes.has(name))
      return `still has removed ${name} attribute`;
  return undefined;
}
function matchesStudioValue(
  observed: string | number | boolean | undefined,
  expected: import("./index.js").StudioValue,
): boolean {
  if (
    expected.type === "boolean" ||
    expected.type === "number" ||
    expected.type === "string"
  )
    return observed === expected.value;
  if (typeof observed !== "string") return false;
  const values = observed.split(",").map(Number);
  const expectedValues =
    expected.type === "vector3"
      ? [expected.x, expected.y, expected.z]
      : expected.type === "color3"
        ? [expected.r, expected.g, expected.b]
        : expected.components;
  return (
    values.length === expectedValues.length &&
    values.every(
      (value, index) =>
        Number.isFinite(value) &&
        Math.abs(value - expectedValues[index]!) <= 1e-5,
    )
  );
}
function createVerificationRecord(
  sessionId: string,
  changeSet: CreatorChangeSet,
  charter: import("./index.js").VerificationCharter,
  executionPlan: import("../../studio-capabilities/src/index.js").StudioExecutionPlan,
  executionPlanArtifact: ArtifactReference,
  snapshotRevisionHash: string,
  snapshotObservationHash: string,
  observation: RuntimeObservationEnvelope | undefined,
  runtimeObservationArtifact: ArtifactReference | undefined,
  failures: string[],
  completed: boolean,
  incompleteDetail: string | undefined,
): CreatorVerificationRecord {
  const payload = {
    sessionId,
    changeSetId: changeSet.id,
    changeSetHash: changeSet.hash,
    charterId: charter.id,
    charterHash: charter.hash,
    snapshotRevisionHash,
    snapshotObservationHash,
    executionPlan: {
      id: executionPlan.id,
      hash: executionPlan.hash,
      artifact: executionPlanArtifact,
    },
    status: !completed
      ? ("incomplete" as const)
      : failures.length === 0
        ? ("passed" as const)
        : ("failed" as const),
    ...(observation && runtimeObservationArtifact
      ? {
          runtimeObservation: {
            observationHash: verificationEvidenceHash(observation),
            diagnosticsHash: verificationEvidenceHash(observation.diagnostics),
            artifact: runtimeObservationArtifact,
          },
        }
      : {}),
    ...(!completed
      ? {
          nonReplayableReason: (
            incompleteDetail ?? "Studio connector evidence is incomplete"
          ).slice(0, 4096),
        }
      : {}),
    failureFacts: createVerificationFailureFacts(failures),
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "CreatorVerificationRecord",
    id: `creator_verification_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}
function createCheckpoint(
  sessionId: string,
  changeSet: CreatorChangeSet,
  pending: {
    beforeRevisionHash: string;
    afterRevisionHash: string;
    inverseMaterialHash: string;
  },
  afterRevisionHash: string,
): CreatorCheckpoint {
  const payload = {
    sessionId,
    changeSetId: changeSet.id,
    changeSetHash: changeSet.hash,
    beforeRevisionHash: pending.beforeRevisionHash,
    afterRevisionHash,
    inverseMaterialHash: pending.inverseMaterialHash,
    status: "committed" as const,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "CreatorCheckpoint",
    id: `creator_checkpoint_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}
function updateCheckpointStatus(
  checkpoint: CreatorCheckpoint,
  status: CreatorCheckpoint["status"],
): CreatorCheckpoint {
  const payload = {
    sessionId: checkpoint.sessionId,
    changeSetId: checkpoint.changeSetId,
    changeSetHash: checkpoint.changeSetHash,
    beforeRevisionHash: checkpoint.beforeRevisionHash,
    afterRevisionHash: checkpoint.afterRevisionHash,
    inverseMaterialHash: checkpoint.inverseMaterialHash,
    status,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "CreatorCheckpoint",
    id: `creator_checkpoint_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}
function recordObservation(
  bundle: CreatorSessionBundle,
  revisionHash: string,
  observation: CreatorSessionBundle["observation"],
): CreatorSessionBundle {
  const withHistory = appendObservationHistory(
    bundle,
    revisionHash,
    observation,
  );
  return { ...withHistory, observation };
}
function appendObservationHistory(
  bundle: CreatorSessionBundle,
  revisionHash: string,
  observation: CreatorSessionBundle["observation"],
): CreatorSessionBundle {
  requiredHash(revisionHash, "Studio observation revision");
  const entryHash = contentHash(stableJson({ revisionHash, observation }));
  const history = bundle.observationHistory.some(
    (entry) => contentHash(stableJson(entry)) === entryHash,
  )
    ? bundle.observationHistory
    : [
        ...bundle.observationHistory,
        { revisionHash, observation: structuredClone(observation) },
      ];
  if (history.length > 32)
    throw new Error("Creator Studio observation history exceeded its bound");
  return { ...bundle, observationHistory: history };
}
async function waitFor<T extends PluginToBackendMessage>(
  messages: PluginToBackendMessage[],
  predicate: (message: PluginToBackendMessage) => message is T,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    const error = messages.find((message) => message.type === "PluginError");
    if (error?.type === "PluginError")
      throw new Error(
        `Studio plugin ${error.payload.code}: ${error.payload.message}`,
      );
    await new Promise((resolveValue) => setTimeout(resolveValue, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
