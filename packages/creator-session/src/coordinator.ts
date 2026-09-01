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
  CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS,
  assertStudioExecutionPlan,
  createStudioExecutionPlan,
} from "../../studio-capabilities/src/index.js";
import {
  executeCreatorVerificationPlan,
  requestFreshStudioEvidence,
} from "../../studio-runtime/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  compileProjectStateProjection,
  deriveMutationStateDelta,
  projectStateFromEvidence,
  assertEvidenceAgainstProjection,
  gradeStudioCapabilityAttestation,
  serializeStudioEvidenceProjection,
  type StudioCapabilityAttestationGrade,
  type StudioEvidenceBinding,
  type StudioEvidenceEnvelope,
  type StudioEvidenceProjection,
} from "../../studio-evidence/src/index.js";
import {
  advanceSession,
  assertCreatorControlActionBinding,
  assertCreatorVerificationRecord,
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
  type CreatorActiveMutation,
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
import {
  adaptCreatorChangeSetMutationOperations,
  compileCreatorChangeSetMutationProjection,
  createIncompleteApplyMutationAttempt,
  createIncompleteCreatorMutationAttempt,
  createCreatorMutationAttempt,
  createCreatorMutationFinalization,
  createMutationFailureFacts,
  reconcileCreatorMutation,
  replayCreatorMutation,
  type CreatorMutationArtifactBinding,
  type CreatorMutationFailureFact,
  type CreatorMutationAttempt,
  type CreatorSettledMutationAttempt,
  type CreatorMutationChangeSetLike,
  type CreatorMutationReconciliation,
} from "./mutation-evidence.js";
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
      projection: StudioEvidenceProjection;
      preflightProjection: StudioEvidenceProjection;
      changeSetEvidence: CreatorMutationChangeSetLike;
      attemptId: string;
      before: Awaited<ReturnType<typeof requestFreshStudioEvidence>>;
      preflight: StudioEvidenceEnvelope;
      directReadback: StudioEvidenceEnvelope;
      afterProjection: StudioEvidenceProjection;
      afterEvidence: StudioEvidenceEnvelope;
      afterRevision: import("../../studio-evidence/src/index.js").StudioStateRevision;
      reconciliation: CreatorMutationReconciliation;
    }
  >();
  private readonly inFlight = new Set<string>();
  private readonly views = new Map<string, CreatorControlView>();
  private readonly consumedViewHashes = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly attestations = new Map<
    string,
    {
      status: "verified" | "rejected" | "incomplete";
      projection: StudioEvidenceProjection;
      envelope: StudioEvidenceEnvelope;
      projectionArtifact: ArtifactReference;
      artifact: ArtifactReference;
      grade: StudioCapabilityAttestationGrade;
      detail: string;
    }
  >();
  private readonly recordingRecovery = new Map<
    string,
    {
      studioSessionId: string;
      recordingState: "open" | "not_open" | "unknown";
      recordingId: string;
      evidence: StudioEvidenceEnvelope;
      projectionArtifact: ArtifactReference;
      artifact: ArtifactReference;
    }
  >();
  private readonly recordingScans = new Map<
    string,
    {
      projectId: string;
      status: "pending" | "clear" | "blocked";
      detail: string;
    }
  >();
  private readonly pendingClosedRecordingAcknowledgements = new Map<
    string,
    {
      studioSessionId: string;
      projectId: string;
      creatorSessionId: string;
      changeSetId: string;
      changeSetHash: string;
      projectionId: string;
      projectionHash: string;
      manifestHash: string;
      beforeRevisionHash: string;
      recordingId: string;
      recoveryProjectionHash: string;
      recoveryEvidenceHash: string;
      recoveryRecordArtifact: ArtifactReference;
      bundleId?: string;
    }
  >();
  private readonly pluginMessageFailures = new Map<string, string>();
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
        void this.onPluginMessage(message, session).catch((error: unknown) => {
          this.pluginMessageFailures.set(
            session.sessionId,
            `Studio protocol processing failed closed: ${error instanceof Error ? error.message : String(error)}`,
          );
          this.emit();
        });
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
      if (["planning", "building", "repairing", "preflighting"].includes(bundle.session.status)) {
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
        ["applying", "awaiting_verification", "verifying", "cancelling", "committing"].includes(
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
    const recordingScan = studio
      ? this.recordingScans.get(studio.sessionId)
      : undefined;
    const pluginMessageFailure = studio
      ? this.pluginMessageFailures.get(studio.sessionId)
      : undefined;
    const attestation = studio
      ? this.attestations.get(studio.sessionId)
      : undefined;
    const selectedView = selected
      ? (this.views.get(selected.session.id) ??
        (await this.view(selected, restoredCreatorControlDetail(selected))))
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
            manifestHash: studio.manifestHash,
            connectorBuildHash: studio.connectorBuildHash,
            attestationStatus: attestation?.status ?? "pending",
            ...(attestation?.envelope.contentHash
              ? {
                  attestationHash: attestation.envelope.contentHash,
                  attestationArtifact: attestation.artifact,
                  attestation: attestationSummary(attestation.grade),
                }
              : {}),
            message:
              pluginMessageFailure
                ? pluginMessageFailure
              : recordingScan?.status === "blocked"
                ? recordingScan.detail
                : recordingScan?.status !== "clear"
                  ? "Studio is paired; waiting for its transaction-recovery inventory."
              : attestation?.status === "verified"
                ? "Studio is paired and its curated capability manifest is attested."
                : attestation?.status === "rejected"
                  ? attestation.detail
                : attestation?.status === "incomplete"
                  ? attestation.detail
                  : "Studio paired; waiting for its capability attestation.",
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
      .concat(
        [...this.attestations.values()].flatMap((attestation) => [
          attestation.projectionArtifact,
          attestation.artifact,
        ]),
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

  async replayMutation(attemptId: string) {
    for (const bundle of this.bundles.values()) {
      const attempt = bundle.mutationAttempts.find((candidate) => candidate.id === attemptId);
      if (attempt) return replayCreatorMutation(attempt, this.artifactStore);
    }
    throw new Error("Creator mutation attempt was not found");
  }

  async action(value: unknown): Promise<unknown> {
    const action = assertControlAction(value);
    if (action.action === "start") return this.start(action.prompt);
    const bundle = await this.bundle(action.sessionId);
    return this.lock(bundle.session.id, async () => {
      const view =
        this.views.get(bundle.session.id) ??
        (await this.view(bundle, restoredCreatorControlDetail(bundle)));
      assertActionBinding(action, view, this.consumedViewHashes);
      if (
        [
          "approve_and_apply_changes",
          "start_checks",
          "cancel_changes",
          "cancel_interrupted_recording",
          "reject_and_rollback",
        ].includes(action.actionId)
      )
        await this.currentAttestedStudioSession();
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
      if (action.actionId === "cancel_interrupted_recording")
        return this.cancelInterruptedRecording(bundle);
      if (action.actionId === "accept_result")
        return this.review(bundle, "accepted", action.report);
      if (action.actionId === "reject_and_rollback")
        return this.rejectAndRollback(bundle, action.report);
      throw new Error("The requested creator action is unavailable");
    });
  }

  private async onPluginMessage(
    message: PluginToBackendMessage,
    session: StudioBridgeSession,
  ): Promise<void> {
    this.pairedSession = session;
    if (message.type === "PairProject") {
      this.attestations.delete(session.sessionId);
      this.pluginMessageFailures.delete(session.sessionId);
      this.recordingScans.set(session.sessionId, {
        projectId: session.projectId,
        status: "pending",
        detail: "Waiting for Studio to report its durable creator-transaction state.",
      });
    } else if (message.type === "UnpairProject") {
      this.attestations.delete(session.sessionId);
      this.recordingScans.delete(session.sessionId);
      this.pluginMessageFailures.delete(session.sessionId);
      for (const [requestId, pending] of this.pendingClosedRecordingAcknowledgements) {
        if (pending.studioSessionId === session.sessionId)
          this.pendingClosedRecordingAcknowledgements.delete(requestId);
      }
    } else if (
      message.type === "StudioEvidenceProduced" &&
      message.payload.reason === "capability_attestation"
    ) {
      let grade: StudioCapabilityAttestationGrade;
      try {
        if (
          message.payload.projection.contentHash !==
          session.capabilityAttestationProjectionHash
        )
          throw new Error("Capability attestation projection differs from the paired projection");
        grade = gradeStudioCapabilityAttestation(
          STUDIO_CAPABILITY_MANIFEST,
          STUDIO_CAPABILITY_MANIFEST_HASH,
          message.payload.projection,
          message.payload.envelope,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        grade = rejectedAttestationGrade(detail);
      }
      const [projectionArtifact, artifact] = await Promise.all([
        this.artifactStore.write(message.payload.projection),
        this.artifactStore.write(message.payload.envelope),
      ]);
      this.attestations.set(session.sessionId, {
        status: grade.status,
        projection: message.payload.projection,
        envelope: message.payload.envelope,
        projectionArtifact,
        artifact,
        grade,
        detail: grade.detail,
      });
    } else if (message.type === "CreatorRecordingRecovery") {
      if (message.payload.recordingState === "none") {
        this.recordingScans.set(session.sessionId, {
          projectId: session.projectId,
          status: "clear",
          detail: "Studio reported no durable creator transaction cursor.",
        });
        this.emit();
        return;
      }
      const recoveryPayload = message.payload;
      let projectionArtifact: ArtifactReference;
      let artifact: ArtifactReference;
      try {
        if (
          stableJson(recoveryPayload.evidenceProjection.project) !==
          stableJson(session.project)
        )
          throw new Error("Recovery evidence belongs to a different Studio project");
        assertEvidenceAgainstProjection(
          recoveryPayload.evidence,
          recoveryPayload.evidenceProjection,
        );
        if (
          recoveryPayload.evidenceProjection.purpose !== "project_state" ||
          recoveryPayload.evidenceProjection.scope.mode !== "project_state"
        )
          throw new Error("Recovery evidence is not a complete project-state projection");
        if (recoveryPayload.evidence.completion !== "complete")
          throw new Error("Recovery project-state evidence is incomplete");
        [projectionArtifact, artifact] = await Promise.all([
          this.artifactStore.write(recoveryPayload.evidenceProjection),
          this.artifactStore.write(recoveryPayload.evidence),
        ]);
      } catch (error) {
        this.recordingScans.set(session.sessionId, {
          projectId: session.projectId,
          status: "blocked",
          detail: `Recovery required: ${error instanceof Error ? error.message : String(error)}`,
        });
        this.emit();
        return;
      }
      this.recordingScans.set(session.sessionId, {
        projectId: session.projectId,
        status: "blocked",
        detail:
          recoveryPayload.recordingState === "not_open"
            ? "Studio proved a retained Forge recording is closed; waiting for the exact durable acknowledgement."
            : `Recovery required: Studio reported the retained recording as ${recoveryPayload.recordingState}.`,
      });
      const recoveryRecordArtifact = await this.artifactStore.write({
        kind: "CreatorRecordingRecoveryRecord",
        studioSessionId: session.sessionId,
        projectId: session.projectId,
        creatorSessionId: recoveryPayload.creatorSessionId,
        changeSetId: recoveryPayload.changeSetId,
        changeSetHash: recoveryPayload.changeSetHash,
        projectionId: recoveryPayload.projectionId,
        projectionHash: recoveryPayload.projectionHash,
        manifestHash: recoveryPayload.manifestHash,
        beforeRevisionHash: recoveryPayload.beforeRevisionHash,
        recordingId: recoveryPayload.recordingId,
        recordingState: recoveryPayload.recordingState,
        evidenceProjection: projectionArtifact,
        evidence: artifact,
        receivedAt: message.sentAt,
      });
      const bundle = this.bundles.get(message.payload.creatorSessionId);
      const active = bundle?.activeMutation;
      let matchedBundleId: string | undefined;
      if (
        bundle &&
        active &&
        bundle.session.projectId === session.projectId &&
        active.changeSetHash === message.payload.changeSetHash &&
        active.projectionHash === message.payload.projectionHash &&
        active.changeSetId === message.payload.changeSetId &&
        active.projectionId === message.payload.projectionId &&
        message.payload.manifestHash === STUDIO_CAPABILITY_MANIFEST_HASH &&
        active.beforeRevisionHash === message.payload.beforeRevisionHash &&
        active.beforeState.projection.hash ===
          message.payload.evidenceProjection.contentHash &&
        (!active.recordingId || active.recordingId === message.payload.recordingId)
      ) {
        matchedBundleId = bundle.session.id;
        const nextBundle: CreatorSessionBundle = {
          ...bundle,
          activeMutation: {
            ...active,
            recordingId: message.payload.recordingId,
          },
        };
        this.bundles.set(bundle.session.id, nextBundle);
        await this.persist(nextBundle);
        this.recordingRecovery.set(nextBundle.session.id, {
          studioSessionId: session.sessionId,
          recordingState: message.payload.recordingState,
          recordingId: message.payload.recordingId,
          evidence: message.payload.evidence,
          projectionArtifact,
          artifact,
        });
        await this.publishView(
          nextBundle,
          message.payload.recordingState === "open"
            ? "Studio proved the exact interrupted recording is open. You may explicitly cancel it."
            : `Studio reported the interrupted recording as ${message.payload.recordingState}; Forge will not mutate it automatically.`,
        );
      }
      if (recoveryPayload.recordingState === "not_open") {
        const requestId = `creator_closed_recording_ack_${randomUUID()}`;
        this.pendingClosedRecordingAcknowledgements.set(requestId, {
          studioSessionId: session.sessionId,
          projectId: session.projectId,
          creatorSessionId: recoveryPayload.creatorSessionId,
          changeSetId: recoveryPayload.changeSetId,
          changeSetHash: recoveryPayload.changeSetHash,
          projectionId: recoveryPayload.projectionId,
          projectionHash: recoveryPayload.projectionHash,
          manifestHash: recoveryPayload.manifestHash,
          beforeRevisionHash: recoveryPayload.beforeRevisionHash,
          recordingId: recoveryPayload.recordingId,
          recoveryProjectionHash: recoveryPayload.evidenceProjection.contentHash,
          recoveryEvidenceHash: recoveryPayload.evidence.contentHash,
          recoveryRecordArtifact,
          ...(matchedBundleId ? { bundleId: matchedBundleId } : {}),
        });
        await this.input.connection.send(
          createBackendMessage(
            "AcknowledgeClosedCreatorRecording",
            {
              requestId,
              creatorSessionId: recoveryPayload.creatorSessionId,
              changeSetId: recoveryPayload.changeSetId,
              changeSetHash: recoveryPayload.changeSetHash,
              projectionId: recoveryPayload.projectionId,
              projectionHash: recoveryPayload.projectionHash,
              manifestHash: recoveryPayload.manifestHash,
              beforeRevisionHash: recoveryPayload.beforeRevisionHash,
              recordingId: recoveryPayload.recordingId,
              recoveryProjectionHash: recoveryPayload.evidenceProjection.contentHash,
              recoveryEvidenceHash: recoveryPayload.evidence.contentHash,
            },
            session.sessionId,
            requestId,
          ),
        );
      }
    } else if (message.type === "CreatorClosedRecordingAcknowledged") {
      const pending = message.requestId
        ? this.pendingClosedRecordingAcknowledgements.get(message.requestId)
        : undefined;
      if (!pending || pending.studioSessionId !== session.sessionId)
        return;
      const exact =
        message.payload.status === "closed_cursor_cleared" &&
        message.payload.creatorSessionId === pending.creatorSessionId &&
        message.payload.changeSetId === pending.changeSetId &&
        message.payload.changeSetHash === pending.changeSetHash &&
        message.payload.projectionId === pending.projectionId &&
        message.payload.projectionHash === pending.projectionHash &&
        message.payload.manifestHash === pending.manifestHash &&
        message.payload.beforeRevisionHash === pending.beforeRevisionHash &&
        message.payload.recordingId === pending.recordingId &&
        message.payload.recoveryProjectionHash === pending.recoveryProjectionHash &&
        message.payload.recoveryEvidenceHash === pending.recoveryEvidenceHash;
      if (!exact) return;
      await this.artifactStore.write({
        kind: "CreatorClosedRecordingAcknowledgement",
        studioSessionId: session.sessionId,
        projectId: session.projectId,
        recovery: pending.recoveryRecordArtifact,
        payload: message.payload,
        acknowledgedAt: message.sentAt,
      });
      this.pendingClosedRecordingAcknowledgements.delete(message.requestId!);
      this.recordingScans.set(session.sessionId, {
        projectId: session.projectId,
        status: "clear",
        detail: "Studio proved the retained recording was closed; Forge durably acknowledged and cleared only its stale connector cursor.",
      });
      if (pending.bundleId) {
        const bundle = this.bundles.get(pending.bundleId);
        if (bundle?.session.status === "recovery_required") {
          const nextBundle = {
            ...bundle,
            session: advanceSession(bundle.session, {
              status: "incomplete",
              failure: {
                code: "interrupted_recording_not_open",
                detail:
                  "Studio proved the exact retained recording was not open. Forge cleared only its stale connector cursor; no mutation was resumed or finalized.",
              },
            }),
          };
          this.bundles.set(bundle.session.id, nextBundle);
          this.recordingRecovery.delete(bundle.session.id);
          await this.persist(nextBundle);
          await this.publishView(
            nextBundle,
            "Studio proved the interrupted recording was not open. The attempt remains incomplete and was not resumed.",
          );
        }
      }
    } else if (
      message.type === "CreatorChangeFinalized" &&
      message.requestId === undefined
    ) {
      const bundle = this.bundles.get(message.payload.creatorSessionId);
      if (
        bundle?.session.status === "recovery_required" &&
        bundle.activeMutation?.changeSetHash === message.payload.changeSetHash &&
        bundle.activeMutation.projectionHash === message.payload.projectionHash &&
        (!bundle.activeMutation.recordingId ||
          bundle.activeMutation.recordingId === message.payload.recordingId)
      )
        await this.recoverFinalizedMutation(bundle, message, session);
    }
    this.emit();
  }

  private async start(prompt: string): Promise<unknown> {
    const canonicalPrompt = prompt.trim();
    if (canonicalPrompt.length === 0)
      throw new Error("Creator prompt must be non-empty");
    const studio = await this.currentAttestedStudioSession();
    const attestation = this.attestations.get(studio.sessionId);
    if (!attestation || attestation.status !== "verified")
      throw new Error("The paired Studio connector has no verified capability attestation");
    const pluginMessageFailure = this.pluginMessageFailures.get(studio.sessionId);
    if (pluginMessageFailure) throw new Error(pluginMessageFailure);
    await this.requireClearRecordingInventory(studio);
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
      const fresh = await requestFreshStudioEvidence(
        this.input.connection,
        studio,
        this.timeout(),
      );
      const ownership = createStudioOwnershipMap({
        projectId: studio.projectId,
        revisionHash: fresh.revision.stateHash,
        observation: fresh.state,
        ...(this.input.externalRojoPaths
          ? { externalRojoPaths: this.input.externalRojoPaths }
          : {}),
      });
      let session = createCreatorSession({
        prompt: canonicalPrompt,
        projectId: studio.projectId,
        revisionHash: fresh.revision.stateHash,
        ownership,
      });
      let bundle: CreatorSessionBundle = {
        session,
        ownership,
        observation: fresh.state,
        observationHistory: [
          {
            revisionHash: fresh.revision.stateHash,
            observation: structuredClone(fresh.state),
          },
        ],
        buildContracts: [],
        approvals: [],
        changeSets: [],
        mutationAttempts: [],
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
          observation: fresh.state,
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
        status: decision === "approved" ? "preflighting" : "creator_rejected",
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
    if (bundle.session.status !== "preflighting" || !bundle.session.changeApproval)
      throw new Error("Creator change set is not approved for application");
    if (!bundle.plan)
      throw new Error("Creator change set has no approved verification charter");
    // Compile the runtime dependency graph before the first Studio mutation.
    // Exact execution identity and revision are added only after matched
    // provisional readback establishes the state that will be verified.
    const charterExecution = createCharterExecution(bundle.plan.charter.clauses);
    const verificationRunId = `creator_verify_${randomUUID()}`;
    const verificationCorrelationId = `creator_correlation_${randomUUID()}`;
    const studio = await this.currentAttestedStudioSession();
    const attestation = this.attestations.get(studio.sessionId);
    if (!attestation || attestation.status !== "verified")
      throw new Error("The paired Studio connector has no verified capability attestation");
    if (studio.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH)
      return this.failIncomplete(bundle, "incompatible_studio_manifest", "The paired connector does not implement the approved Studio capability manifest.");
    const dashboardReviewHash = this.views.get(bundle.session.id)?.hash ?? bundle.session.changeApproval.hash;
    const binding: StudioEvidenceBinding = {
      sessionId: bundle.session.id,
      changeSetHash: changeSet.hash,
      approvalHash: bundle.session.changeApproval.hash,
      revisionHash: changeSet.expectedRevisionHash,
      buildHash: changeSet.buildContractHash,
      dashboardReviewHash,
    };
    // This template compiles the complete fixed runner/evidence projection
    // before Forge may ask Studio to open a ChangeHistory recording. The
    // matched post-apply state revision is substituted into the exact plan
    // below, but its targets, calls, budget, and observation window cannot
    // first become invalid after mutation.
    createStudioExecutionPlan({
      purpose: "creator_verification",
      binding: {
        runId: verificationRunId,
        correlationId: verificationCorrelationId,
        sessionId: studio.sessionId,
        projectId: studio.projectId,
        project: studio.project,
        projectStateRevisionHash: changeSet.expectedRevisionHash,
      },
      targets: charterExecution.targets,
      calls: charterExecution.calls,
      budget: { maxExecutionMs: 20_000, maxResultBytes: 64 * 1024 },
      observationWindowMs: CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS,
    });
    const beforeProjection = compileProjectStateProjection({
      id: `creator_mutation_before_${changeSet.hash.slice(0, 24)}`,
      project: studio.project,
      binding,
    });
    const fresh = await requestFreshStudioEvidence(this.input.connection, studio, this.timeout(), "pre_apply", beforeProjection);
    const stateDelta = deriveMutationStateDelta(
      adaptCreatorChangeSetMutationOperations(changeSet),
      fresh.projection,
      fresh.envelope,
    );
    const deletedSubtrees = stateDelta.deletedSubtrees;
    const allowedStateDelta = stateDelta.allowedStateDelta;
    const projection = compileCreatorChangeSetMutationProjection(changeSet, {
      project: studio.project,
      binding,
      allowedStateDelta,
      deletedSubtrees,
    });
    const preflightProjection = compileCreatorChangeSetMutationProjection(changeSet, {
      project: studio.project,
      binding,
      allowedStateDelta,
      deletedSubtrees,
      purpose: "mutation_preflight",
    });
    const changeSetEvidence: CreatorMutationChangeSetLike = {
      kind: "CreatorChangeSet",
      id: changeSet.id,
      hash: changeSet.hash,
      project: studio.project,
      binding,
      projectionId: projection.id,
      operations: adaptCreatorChangeSetMutationOperations(changeSet, deletedSubtrees),
      allowedStateDelta,
    };
    const attemptId = `creator_mutation_attempt_${changeSet.hash.slice(0, 24)}_${changeSet.attempt}`;
    if (fresh.revision.stateHash !== changeSet.expectedRevisionHash) {
      const detail = `Complete pre-Apply Studio state differs from the approved revision: expected ${changeSet.expectedRevisionHash}, observed ${fresh.revision.stateHash}.`;
      bundle = await this.recordIncompletePreflightAttempt(
        bundle,
        attemptId,
        changeSetEvidence,
        projection,
        preflightProjection,
        fresh,
        attestation,
        detail,
        "project_drift",
      );
      return this.drift(bundle, detail);
    }
    const messages: PluginToBackendMessage[] = [];
    const unsubscribe = this.capture(studio, messages);
    try {
      const requestId = `creator_apply_${randomUUID()}`;
      const json = serializeCreatorChangeSet(changeSet);
      const projectionJson = serializeStudioEvidenceProjection(projection);
      const preflightProjectionJson = serializeStudioEvidenceProjection(preflightProjection);
      const beforeStateProjectionJson = serializeStudioEvidenceProjection(fresh.projection);
      await this.input.connection.send(
        createBackendMessage(
          "PrepareCreatorChangeSet",
          {
            requestId,
            creatorSessionId: bundle.session.id,
            expectedRevision: fresh.revision.stateHash,
            changeSetJson: json,
            changeSetJsonHash: contentHash(json),
            changeSetId: changeSet.id,
            changeSetHash: changeSet.hash,
            approvalHash: bundle.session.changeApproval.hash,
            dashboardReviewHash,
            manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
            projectionJson,
            projectionJsonHash: contentHash(projectionJson),
            projectionHash: projection.contentHash,
            preflightProjectionJson,
            preflightProjectionJsonHash: contentHash(preflightProjectionJson),
            preflightProjectionHash: preflightProjection.contentHash,
            beforeStateProjectionJson,
            beforeStateProjectionJsonHash: contentHash(beforeStateProjectionJson),
            beforeStateProjectionHash: fresh.projection.contentHash,
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
          message.payload.beforeRevisionHash === fresh.revision.stateHash &&
          message.payload.projectionHash === projection.contentHash &&
          message.payload.preflightProjectionHash === preflightProjection.contentHash &&
          message.payload.status === "prepared",
        this.timeout(),
        "creator change preparation",
      );
      await this.input.connection.send(createBackendMessage("PreflightCreatorChangeSet", {
        requestId,
        creatorSessionId: bundle.session.id,
        changeSetId: changeSet.id,
        changeSetHash: changeSet.hash,
        projectionId: projection.id,
        projectionHash: projection.contentHash,
        preflightProjectionId: preflightProjection.id,
        preflightProjectionHash: preflightProjection.contentHash,
        manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
        expectedRevision: fresh.revision.stateHash,
      }, studio.sessionId, requestId));
      const preflight = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "CreatorChangePreflighted" | "CreatorMutationFailed" }> =>
        message.requestId === requestId &&
        (message.type === "CreatorChangePreflighted" || message.type === "CreatorMutationFailed") &&
        message.payload.creatorSessionId === bundle.session.id &&
        message.payload.changeSetHash === changeSet.hash,
      this.timeout(), "creator mutation preflight");
      if (preflight.type === "CreatorMutationFailed") {
        bundle = await this.recordIncompletePreflightAttempt(
          bundle,
          attemptId,
          changeSetEvidence,
          projection,
          preflightProjection,
          fresh,
          attestation,
          preflight.payload.failureCode,
        );
        return this.failIncomplete(bundle, "capability_preflight_failed", preflight.payload.failureCode);
      }
      await this.artifactStore.write(preflightProjection);
      await this.artifactStore.write(preflight.payload.preflightEvidence);
      if (preflight.payload.status !== "passed" || preflight.payload.preflightEvidence.completion !== "complete") {
        const failureDetail = preflight.payload.failureCode ?? "Detached mutation preflight evidence was incomplete.";
        bundle = await this.recordIncompletePreflightAttempt(
          bundle,
          attemptId,
          changeSetEvidence,
          projection,
          preflightProjection,
          fresh,
          attestation,
          failureDetail,
          "capability_preflight_failed",
          preflight.payload.preflightEvidence,
        );
        return this.failIncomplete(bundle, "capability_preflight_failed", failureDetail);
      }
      assertEvidenceAgainstProjection(preflight.payload.preflightEvidence, preflightProjection);
      let activeMutation = await this.createActiveMutation(
        attemptId,
        changeSet,
        changeSetEvidence,
        projection,
        preflightProjection,
        preflight.payload.preflightEvidence,
        fresh,
        attestation,
      );
      bundle = { ...bundle, activeMutation };
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      activeMutation = { ...activeMutation, stage: "recording_may_be_open" };
      bundle = {
        ...bundle,
        activeMutation,
        session: advanceSession(bundle.session, { status: "applying" }),
      };
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      await this.input.connection.send(
        createBackendMessage(
          "ApplyCreatorChangeSet",
          {
            requestId,
            creatorSessionId: bundle.session.id,
            changeSetId: changeSet.id,
            changeSetHash: changeSet.hash,
            projectionId: projection.id,
            projectionHash: projection.contentHash,
            manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
            expectedRevision: fresh.revision.stateHash,
          },
          studio.sessionId,
          requestId,
        ),
      );
      const applied = await waitFor(
        messages,
        (message): message is Extract<PluginToBackendMessage, { type: "CreatorMutationProvisional" | "CreatorMutationFailed" }> =>
          (message.type === "CreatorMutationProvisional" || message.type === "CreatorMutationFailed") &&
          message.requestId === requestId &&
          message.payload.creatorSessionId === bundle.session.id &&
          message.payload.changeSetId === changeSet.id &&
          message.payload.changeSetHash === changeSet.hash &&
          message.payload.projectionHash === projection.contentHash,
        this.timeout(),
        "provisional creator mutation",
      );
      if (applied.type === "CreatorMutationFailed") {
        const failureFacts = createMutationFailureFacts([
          {
            code: "mutation_execution_failed",
            detail: applied.payload.failureCode,
          },
        ]);
        const failureEvidence = {
          kind: "CreatorMutationExecutionFailure" as const,
          attemptId,
          failureFacts,
        };
        const executionFailure = await this.mutationBinding(
          failureEvidence,
          contentHash(stableJson(failureEvidence)),
        );
        bundle = {
          ...bundle,
          activeMutation: {
            ...activeMutation,
            executionFailure,
          },
          session: advanceSession(bundle.session, {
            status: "recovery_required",
            failure: {
              code: "mutation_recovery_required",
              detail: applied.payload.failureCode,
            },
          }),
        };
        this.bundles.set(bundle.session.id, bundle);
        await this.persist(bundle);
        if (
          applied.payload.recordingState !== "not_open" ||
          applied.payload.cancellationProven !== true
        )
          return this.finish(
            bundle,
            `Studio mutation failed and exact cancellation is not yet proven: ${applied.payload.failureCode}`,
          );
        const finalized = await waitFor(
          messages,
          (
            message,
          ): message is Extract<
            PluginToBackendMessage,
            { type: "CreatorChangeFinalized" }
          > =>
            message.type === "CreatorChangeFinalized" &&
            message.requestId === requestId &&
            message.payload.creatorSessionId === bundle.session.id &&
            message.payload.changeSetId === changeSet.id &&
            message.payload.changeSetHash === changeSet.hash &&
            message.payload.projectionId === projection.id &&
            message.payload.projectionHash === projection.contentHash &&
            message.payload.manifestHash === STUDIO_CAPABILITY_MANIFEST_HASH &&
            message.payload.beforeRevisionHash === fresh.revision.stateHash &&
            message.payload.action === "cancel" &&
            message.payload.status === "cancelled",
          this.timeout(),
          "failed creator mutation cancellation finalization",
        );
        bundle = await this.recordIncompleteApplyAttempt(
          bundle,
          finalized,
          failureFacts,
        );
        const attempt = bundle.mutationAttempts.find(
          (candidate) => candidate.id === attemptId,
        )!;
        const finalState = projectStateFromEvidence(
          finalized.payload.postFinalizeStateEvidence,
          finalized.payload.postFinalizeStateProjection,
        );
        const { activeMutation: _activeMutation, ...settledBundle } = bundle;
        bundle = recordObservation(
          {
            ...settledBundle,
            session: advanceSession(bundle.session, {
              status: "incomplete",
              revisionHash: finalized.payload.afterRevision.stateHash,
              failure: {
                code: "mutation_execution_failed",
                detail: applied.payload.failureCode,
              },
            }),
          },
          finalized.payload.afterRevision.stateHash,
          finalState,
        );
        const result = await this.finish(
          bundle,
          "The failed Studio mutation proved its cancellation and preserved complete post-cancel evidence. No mutation verdict was invented.",
        );
        await this.acknowledgeFinalization(studio, finalized, attempt.hash);
        return result;
      }
      assertEvidenceAgainstProjection(applied.payload.directReadbackEvidence, projection);
      assertEvidenceAgainstProjection(applied.payload.postApplyStateEvidence, applied.payload.postApplyStateProjection);
      await this.persistMutationCore(changeSetEvidence, projection, preflightProjection, preflight.payload.preflightEvidence, fresh, applied.payload.directReadbackEvidence, applied.payload.postApplyStateProjection, applied.payload.postApplyStateEvidence, applied.payload.postApplyRevision);
      const reconciliation = reconcileCreatorMutation({
        sessionId: bundle.session.id,
        attemptId,
        manifest: STUDIO_CAPABILITY_MANIFEST,
        manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
        changeSet: changeSetEvidence,
        projection,
        preflight: { projection: preflightProjection, envelope: preflight.payload.preflightEvidence },
        directReadback: applied.payload.directReadbackEvidence,
        beforeState: { projection: fresh.projection, envelope: fresh.envelope, revision: fresh.revision },
        afterState: { projection: applied.payload.postApplyStateProjection, envelope: applied.payload.postApplyStateEvidence, revision: applied.payload.postApplyRevision },
      });
      const reconciliationArtifact = await this.artifactStore.write(reconciliation);
      activeMutation = {
        ...activeMutation,
        stage: "provisional",
        recordingId: applied.payload.recordingId,
        directReadback: await this.mutationBinding(
          applied.payload.directReadbackEvidence,
          applied.payload.directReadbackEvidence.contentHash,
        ),
        afterState: {
          projection: await this.mutationBinding(
            applied.payload.postApplyStateProjection,
            applied.payload.postApplyStateProjection.contentHash,
          ),
          envelope: await this.mutationBinding(
            applied.payload.postApplyStateEvidence,
            applied.payload.postApplyStateEvidence.contentHash,
          ),
          revision: await this.mutationBinding(
            applied.payload.postApplyRevision,
            applied.payload.postApplyRevision.stateHash,
          ),
        },
        reconciliation: { artifact: reconciliationArtifact, hash: reconciliation.hash },
      };
      bundle = { ...bundle, activeMutation };
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      const afterState = projectStateFromEvidence(applied.payload.postApplyStateEvidence, applied.payload.postApplyStateProjection);
      const afterRevisionHash = applied.payload.postApplyRevision.stateHash;
      if (reconciliation.status !== "matched") {
        bundle = appendObservationHistory(bundle, afterRevisionHash, afterState);
        bundle = { ...bundle, session: advanceSession(bundle.session, { status: "cancelling" }) };
        this.bundles.set(bundle.session.id, bundle); await this.persist(bundle);
        const finalized = await this.finalizeRecording(studio, bundle.session.id, changeSet, projection, fresh.revision.stateHash, applied.payload.recordingId, "cancel", messages);
        bundle = await this.recordMutationAttempt(bundle, attemptId, changeSetEvidence, projection, preflightProjection, preflight.payload.preflightEvidence, fresh, applied.payload.directReadbackEvidence, applied.payload.postApplyStateProjection, applied.payload.postApplyStateEvidence, applied.payload.postApplyRevision, reconciliation, finalized);
        const attempt = bundle.mutationAttempts.find((candidate) => candidate.id === attemptId)!;
        const reverted = projectStateFromEvidence(finalized.payload.postFinalizeStateEvidence, finalized.payload.postFinalizeStateProjection);
        bundle = recordObservation({ ...bundle, session: advanceSession(bundle.session, { status: "incomplete", revisionHash: finalized.payload.afterRevision.stateHash, failure: { code: reconciliation.status === "mismatched" ? "post_apply_mismatch" : "post_apply_evidence_incomplete", detail: reconciliation.failureFacts.map((fact) => fact.detail).join("; ") } }) }, finalized.payload.afterRevision.stateHash, reverted);
        const result = await this.finish(bundle, `Provisional mutation was cancelled after ${reconciliation.status} reconciliation.`);
        await this.acknowledgeFinalization(studio, finalized, attempt.hash);
        return result;
      }
      const executionPlan = createStudioExecutionPlan({
        purpose: "creator_verification",
        binding: {
          runId: verificationRunId,
          correlationId: verificationCorrelationId,
          sessionId: studio.sessionId,
          projectId: studio.projectId,
          project: studio.project,
          projectStateRevisionHash: afterRevisionHash,
        },
        targets: charterExecution.targets,
        calls: charterExecution.calls,
        budget: { maxExecutionMs: 20_000, maxResultBytes: 64 * 1024 },
        observationWindowMs: CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS,
      });
      const executionPlanArtifact = await this.artifactStore.write(executionPlan);
      bundle = {
        ...bundle,
        activeMutation: {
          ...activeMutation,
          verificationPlan: {
            artifact: executionPlanArtifact,
            hash: executionPlan.hash,
          },
        },
      };
      bundle = recordObservation(
        {
          ...bundle,
          session: advanceSession(bundle.session, {
            status: "awaiting_verification",
            revisionHash: afterRevisionHash,
          }),
        },
        afterRevisionHash,
        afterState,
      );
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      this.pendingRecordings.set(bundle.session.id, {
        recordingId: applied.payload.recordingId,
        beforeRevisionHash: fresh.revision.stateHash,
        afterRevisionHash,
        projection,
        preflightProjection,
        changeSetEvidence,
        attemptId,
        before: fresh,
        preflight: preflight.payload.preflightEvidence,
        directReadback: applied.payload.directReadbackEvidence,
        afterProjection: applied.payload.postApplyStateProjection,
        afterEvidence: applied.payload.postApplyStateEvidence,
        afterRevision: applied.payload.postApplyRevision,
        reconciliation,
      });
      await this.publishView(
        bundle,
        `Changes are applied inside an open Studio recording. The exact execution plan is preserved and will keep Play Solo open for a bounded ${CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS / 1000}-second creator-observation window. Start the approved checks, perform the visible creator-review interactions during that window, or cancel the uncommitted changes.`,
      );
      return summary(bundle);
    } finally {
      unsubscribe();
    }
  }

  private async failIncomplete(bundle: CreatorSessionBundle, code: string, detailValue: string): Promise<unknown> {
    return this.finish({ ...bundle, session: advanceSession(bundle.session, { status: "incomplete", failure: { code, detail: detailValue } }) }, detailValue);
  }

  private async createActiveMutation(
    attemptId: string,
    changeSet: CreatorChangeSet,
    changeSetEvidence: CreatorMutationChangeSetLike,
    projection: StudioEvidenceProjection,
    preflightProjection: StudioEvidenceProjection,
    preflight: StudioEvidenceEnvelope,
    before: Awaited<ReturnType<typeof requestFreshStudioEvidence>>,
    attestation: {
      projection: StudioEvidenceProjection;
      envelope: StudioEvidenceEnvelope;
      projectionArtifact: ArtifactReference;
      artifact: ArtifactReference;
    },
  ): Promise<CreatorActiveMutation> {
    return {
      attemptId,
      stage: "preflighted",
      changeSetId: changeSet.id,
      changeSetHash: changeSet.hash,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      beforeRevisionHash: before.revision.stateHash,
      manifest: await this.mutationBinding(
        STUDIO_CAPABILITY_MANIFEST,
        STUDIO_CAPABILITY_MANIFEST_HASH,
      ),
      attestation: {
        projection: {
          artifact: attestation.projectionArtifact,
          hash: attestation.projection.contentHash,
        },
        envelope: {
          artifact: attestation.artifact,
          hash: attestation.envelope.contentHash,
        },
      },
      changeSet: await this.mutationBinding(changeSetEvidence, changeSetEvidence.hash),
      projection: await this.mutationBinding(projection, projection.contentHash),
      preflight: {
        projection: await this.mutationBinding(
          preflightProjection,
          preflightProjection.contentHash,
        ),
        envelope: await this.mutationBinding(preflight, preflight.contentHash),
      },
      beforeState: {
        projection: await this.mutationBinding(
          before.projection,
          before.projection.contentHash,
        ),
        envelope: await this.mutationBinding(
          before.envelope,
          before.envelope.contentHash,
        ),
        revision: await this.mutationBinding(
          before.revision,
          before.revision.stateHash,
        ),
      },
    };
  }

  private async recordIncompletePreflightAttempt(
    bundle: CreatorSessionBundle,
    attemptId: string,
    changeSet: CreatorMutationChangeSetLike,
    projection: StudioEvidenceProjection,
    preflightProjection: StudioEvidenceProjection,
    before: Awaited<ReturnType<typeof requestFreshStudioEvidence>>,
    attestation: {
      projection: StudioEvidenceProjection;
      envelope: StudioEvidenceEnvelope;
      projectionArtifact: ArtifactReference;
      artifact: ArtifactReference;
    },
    detailValue: string,
    failureCode = "capability_preflight_failed",
    preflight?: StudioEvidenceEnvelope,
  ): Promise<CreatorSessionBundle> {
    const attempt = createIncompleteCreatorMutationAttempt(attemptId, {
      sessionId: bundle.session.id,
      manifest: await this.mutationBinding(
        STUDIO_CAPABILITY_MANIFEST,
        STUDIO_CAPABILITY_MANIFEST_HASH,
      ),
      attestation: {
        projection: {
          artifact: attestation.projectionArtifact,
          hash: attestation.projection.contentHash,
        },
        envelope: {
          artifact: attestation.artifact,
          hash: attestation.envelope.contentHash,
        },
      },
      changeSet: await this.mutationBinding(changeSet, changeSet.hash),
      projection: await this.mutationBinding(projection, projection.contentHash),
      preflightProjection: await this.mutationBinding(
        preflightProjection,
        preflightProjection.contentHash,
      ),
      ...(preflight
        ? {
            preflight: {
              projection: await this.mutationBinding(
                preflightProjection,
                preflightProjection.contentHash,
              ),
              envelope: await this.mutationBinding(
                preflight,
                preflight.contentHash,
              ),
            },
          }
        : {}),
      beforeState: {
        projection: await this.mutationBinding(
          before.projection,
          before.projection.contentHash,
        ),
        envelope: await this.mutationBinding(
          before.envelope,
          before.envelope.contentHash,
        ),
        revision: await this.mutationBinding(
          before.revision,
          before.revision.stateHash,
        ),
      },
      failureFacts: createMutationFailureFacts([
        { code: failureCode, detail: detailValue },
      ]),
    });
    const next = {
      ...bundle,
      mutationAttempts: [...bundle.mutationAttempts, attempt],
    };
    this.bundles.set(next.session.id, next);
    await this.persist(next);
    return next;
  }

  private async recordIncompleteApplyAttempt(
    bundle: CreatorSessionBundle,
    finalized: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>,
    failureFacts: readonly CreatorMutationFailureFact[],
  ): Promise<CreatorSessionBundle> {
    const active = bundle.activeMutation;
    if (!active)
      throw new Error("Failed mutation finalization has no durable active cursor");
    if (
      finalized.payload.creatorSessionId !== bundle.session.id ||
      finalized.payload.changeSetId !== active.changeSetId ||
      finalized.payload.changeSetHash !== active.changeSetHash ||
      finalized.payload.projectionId !== active.projectionId ||
      finalized.payload.projectionHash !== active.projectionHash ||
      finalized.payload.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH ||
      finalized.payload.beforeRevisionHash !== active.beforeRevisionHash ||
      (active.recordingId !== undefined &&
        finalized.payload.recordingId !== active.recordingId) ||
      finalized.payload.action !== "cancel" ||
      finalized.payload.status !== "cancelled"
    )
      throw new Error("Failed mutation cancellation finalization binding mismatch");
    assertEvidenceAgainstProjection(
      finalized.payload.postFinalizeStateEvidence,
      finalized.payload.postFinalizeStateProjection,
    );
    const finalization = createCreatorMutationFinalization({
      attemptId: active.attemptId,
      sessionId: bundle.session.id,
      changeSetId: active.changeSetId,
      changeSetHash: active.changeSetHash,
      projectionId: active.projectionId,
      projectionHash: active.projectionHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      beforeRevisionHash: active.beforeRevisionHash,
      recordingId: finalized.payload.recordingId,
      action: "cancel",
      status: "cancelled",
      afterRevisionHash: finalized.payload.afterRevision.stateHash,
      postFinalizeProjectionHash:
        finalized.payload.postFinalizeStateProjection.contentHash,
      postFinalizeEvidenceHash:
        finalized.payload.postFinalizeStateEvidence.contentHash,
    });
    const attempt = createIncompleteApplyMutationAttempt(active.attemptId, {
      sessionId: bundle.session.id,
      manifest: active.manifest,
      attestation: active.attestation,
      changeSet: active.changeSet,
      projection: active.projection,
      preflightProjection: active.preflight.projection,
      preflight: active.preflight,
      beforeState: active.beforeState,
      finalState: {
        projection: await this.mutationBinding(
          finalized.payload.postFinalizeStateProjection,
          finalized.payload.postFinalizeStateProjection.contentHash,
        ),
        envelope: await this.mutationBinding(
          finalized.payload.postFinalizeStateEvidence,
          finalized.payload.postFinalizeStateEvidence.contentHash,
        ),
        revision: await this.mutationBinding(
          finalized.payload.afterRevision,
          finalized.payload.afterRevision.stateHash,
        ),
      },
      finalization: await this.mutationBinding(finalization, finalization.hash),
      failureFacts,
    });
    return {
      ...bundle,
      mutationAttempts: [...bundle.mutationAttempts, attempt],
    };
  }

  private async persistMutationCore(
    changeSet: CreatorMutationChangeSetLike,
    projection: StudioEvidenceProjection,
    preflightProjection: StudioEvidenceProjection,
    preflight: StudioEvidenceEnvelope,
    before: Awaited<ReturnType<typeof requestFreshStudioEvidence>>,
    directReadback: StudioEvidenceEnvelope,
    afterProjection: StudioEvidenceProjection,
    afterEvidence: StudioEvidenceEnvelope,
    afterRevision: import("../../studio-evidence/src/index.js").StudioStateRevision,
    reconciliation?: CreatorMutationReconciliation,
  ): Promise<void> {
    await Promise.all([
      this.artifactStore.write(STUDIO_CAPABILITY_MANIFEST),
      this.artifactStore.write(changeSet),
      this.artifactStore.write(projection),
      this.artifactStore.write(preflightProjection),
      this.artifactStore.write(preflight),
      this.artifactStore.write(before.projection),
      this.artifactStore.write(before.envelope),
      this.artifactStore.write(before.revision),
      this.artifactStore.write(directReadback),
      this.artifactStore.write(afterProjection),
      this.artifactStore.write(afterEvidence),
      this.artifactStore.write(afterRevision),
      ...(reconciliation ? [this.artifactStore.write(reconciliation)] : []),
    ]);
  }

  private async mutationBinding(value: unknown, hash: string): Promise<CreatorMutationArtifactBinding> {
    return { artifact: await this.artifactStore.write(value), hash };
  }

  private async recordMutationAttempt(
    bundle: CreatorSessionBundle,
    attemptId: string,
    changeSet: CreatorMutationChangeSetLike,
    projection: StudioEvidenceProjection,
    preflightProjection: StudioEvidenceProjection,
    preflight: StudioEvidenceEnvelope,
    before: Awaited<ReturnType<typeof requestFreshStudioEvidence>>,
    directReadback: StudioEvidenceEnvelope,
    afterProjection: StudioEvidenceProjection,
    afterEvidence: StudioEvidenceEnvelope,
    afterRevision: import("../../studio-evidence/src/index.js").StudioStateRevision,
    reconciliation: CreatorMutationReconciliation,
    finalized: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>,
    recoveryCancellation = false,
  ): Promise<CreatorSessionBundle> {
    assertEvidenceAgainstProjection(finalized.payload.postFinalizeStateEvidence, finalized.payload.postFinalizeStateProjection);
    const finalization = createCreatorMutationFinalization({
      attemptId,
      sessionId: bundle.session.id,
      changeSetId: finalized.payload.changeSetId,
      changeSetHash: finalized.payload.changeSetHash,
      projectionId: finalized.payload.projectionId,
      projectionHash: finalized.payload.projectionHash,
      manifestHash: finalized.payload.manifestHash,
      beforeRevisionHash: finalized.payload.beforeRevisionHash,
      recordingId: finalized.payload.recordingId,
      reconciliationHash: reconciliation.hash,
      action: recoveryCancellation
        ? "recovery_cancel"
        : finalized.payload.action,
      status: recoveryCancellation
        ? "recovery_cancelled"
        : finalized.payload.status === "committed"
          ? "committed"
          : "cancelled",
      afterRevisionHash: finalized.payload.afterRevision.stateHash,
      postFinalizeProjectionHash: finalized.payload.postFinalizeStateProjection.contentHash,
      postFinalizeEvidenceHash: finalized.payload.postFinalizeStateEvidence.contentHash,
    });
    const attestation = bundle.activeMutation?.attestation;
    if (!attestation)
      throw new Error("Mutation attempt is missing its paired capability attestation");
    const attempt = createCreatorMutationAttempt(attemptId, {
      sessionId: bundle.session.id,
      manifest: await this.mutationBinding(STUDIO_CAPABILITY_MANIFEST, STUDIO_CAPABILITY_MANIFEST_HASH),
      attestation,
      changeSet: await this.mutationBinding(changeSet, changeSet.hash),
      projection: await this.mutationBinding(projection, projection.contentHash),
      preflight: {
        projection: await this.mutationBinding(preflightProjection, preflightProjection.contentHash),
        envelope: await this.mutationBinding(preflight, preflight.contentHash),
      },
      directReadback: await this.mutationBinding(directReadback, directReadback.contentHash),
      beforeState: {
        projection: await this.mutationBinding(before.projection, before.projection.contentHash),
        envelope: await this.mutationBinding(before.envelope, before.envelope.contentHash),
        revision: await this.mutationBinding(before.revision, before.revision.stateHash),
      },
      afterState: {
        projection: await this.mutationBinding(afterProjection, afterProjection.contentHash),
        envelope: await this.mutationBinding(afterEvidence, afterEvidence.contentHash),
        revision: await this.mutationBinding(afterRevision, afterRevision.stateHash),
      },
      finalState: {
        projection: await this.mutationBinding(finalized.payload.postFinalizeStateProjection, finalized.payload.postFinalizeStateProjection.contentHash),
        envelope: await this.mutationBinding(finalized.payload.postFinalizeStateEvidence, finalized.payload.postFinalizeStateEvidence.contentHash),
        revision: await this.mutationBinding(finalized.payload.afterRevision, finalized.payload.afterRevision.stateHash),
      },
      reconciliation: await this.mutationBinding(reconciliation, reconciliation.hash),
      finalization: await this.mutationBinding(finalization, finalization.hash),
    });
    const { activeMutation: _activeMutation, ...settledBundle } = bundle;
    const next: CreatorSessionBundle = {
      ...settledBundle,
      mutationAttempts: [...bundle.mutationAttempts, attempt],
    };
    this.bundles.set(next.session.id, next);
    await this.persist(next);
    return next;
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
    const studio = await this.currentAttestedStudioSession();
    const activeMutation = bundle.activeMutation;
    if (!activeMutation || activeMutation.attemptId !== pending.attemptId)
      throw new Error("Verification lost its durable mutation transaction cursor");
    if (!activeMutation.verificationPlan)
      throw new Error("Verification has no pre-materialized execution plan");
    const executionPlan = await this.artifactStore.read(
      activeMutation.verificationPlan.artifact,
      assertStudioExecutionPlan,
    );
    const expectedExecution = createCharterExecution(plan.charter.clauses);
    if (
      executionPlan.hash !== activeMutation.verificationPlan.hash ||
      executionPlan.purpose !== "creator_verification" ||
      executionPlan.binding.sessionId !== studio.sessionId ||
      executionPlan.binding.projectId !== studio.projectId ||
      executionPlan.binding.projectStateRevisionHash !== bundle.session.currentRevisionHash ||
      stableJson(executionPlan.targets) !== stableJson(expectedExecution.targets) ||
      stableJson(executionPlan.calls) !== stableJson(expectedExecution.calls) ||
      executionPlan.observationWindowMs !== CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS
    )
      throw new Error("Pre-materialized creator verification plan binding mismatch");
    bundle = {
      ...bundle,
      session: advanceSession(bundle.session, { status: "verifying" }),
      activeMutation,
    };
    this.bundles.set(bundle.session.id, bundle);
    await this.persist(bundle);
    await this.publishView(
      bundle,
      `Starting the exact creator-approved checks. Studio will enter Play Solo once and keep the approved observation active for ${CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS / 1000} seconds; perform the visible creator-review interactions during that window.`,
    );
    const stateFailures = gradeSnapshotCharter(
      plan.charter.clauses,
      bundle.observation,
    );
    const observed =
      stateFailures.length === 0
        ? await executeCreatorVerificationPlan({
            connection: this.input.connection,
            session: studio,
            executionPlan,
            timeoutMs: this.timeout(),
          })
        : undefined;
    const failures =
      stateFailures.length > 0
        ? stateFailures
        : observed?.status === "completed" && observed.evidence
          ? gradeRuntimeCharter(plan.charter.clauses, observed.evidence)
          : [
              observed?.failure?.detail ??
                "Studio verification did not complete",
            ];
    const runtimeEvidenceArtifact = observed?.evidence
      ? await this.artifactStore.write(observed.evidence)
      : undefined;
    const verification = createVerificationRecord(
      bundle.session.id,
      changeSet,
      plan.charter,
      executionPlan,
      activeMutation.verificationPlan.artifact,
      bundle.session.currentRevisionHash,
      verificationEvidenceHash(bundle.observation),
      { id: pending.attemptId, reconciliationHash: pending.reconciliation.hash },
      observed?.evidence,
      runtimeEvidenceArtifact,
      failures,
      stateFailures.length > 0 || observed?.status === "completed",
      observed?.failure?.detail,
    );
    const verificationDraftArtifact = await this.artifactStore.write(verification);
    bundle = {
      ...bundle,
      activeMutation: {
        ...activeMutation,
        verificationDraft: {
          artifact: verificationDraftArtifact,
          hash: verification.hash,
        },
      },
    };
    this.bundles.set(bundle.session.id, bundle);
    await this.persist(bundle);
    const messages: PluginToBackendMessage[] = [];
    const unsubscribe = this.capture(studio, messages);
    try {
      if (failures.length === 0) {
        bundle = { ...bundle, session: advanceSession(bundle.session, { status: "committing" }) };
        this.bundles.set(bundle.session.id, bundle); await this.persist(bundle);
        const finalized = await this.finalizeRecording(
          studio,
          bundle.session.id,
          changeSet,
          pending.projection,
          pending.beforeRevisionHash,
          pending.recordingId,
          "commit",
          messages,
        );
        const finalizedRevision = finalized.payload.afterRevision.stateHash;
        assertEvidenceAgainstProjection(finalized.payload.postFinalizeStateEvidence, finalized.payload.postFinalizeStateProjection);
        const committed = projectStateFromEvidence(finalized.payload.postFinalizeStateEvidence, finalized.payload.postFinalizeStateProjection);
        bundle = await this.recordMutationAttempt(bundle, pending.attemptId, pending.changeSetEvidence, pending.projection, pending.preflightProjection, pending.preflight, pending.before, pending.directReadback, pending.afterProjection, pending.afterEvidence, pending.afterRevision, pending.reconciliation, finalized);
        const attempt = requiredSettledMutationAttempt(bundle, pending.attemptId);
        const boundVerification = bindVerificationMutationAttempt(verification, attempt);
        bundle = { ...bundle, verifications: [...bundle.verifications, boundVerification] };
        const checkpoint = createCheckpoint(
          bundle.session.id,
          changeSet,
          pending,
          finalizedRevision,
          attempt,
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
          committed,
        );
        this.pendingRecordings.delete(bundle.session.id);
        this.bundles.set(bundle.session.id, bundle);
        await this.persist(bundle);
        await this.publishView(
          bundle,
          "Machine checks completed. Visually review the exact result, then accept it or reject and roll it back.",
        );
        await this.acknowledgeFinalization(studio, finalized, attempt.hash);
        return summary(bundle);
      }
      bundle = { ...bundle, session: advanceSession(bundle.session, { status: "cancelling" }) };
      this.bundles.set(bundle.session.id, bundle); await this.persist(bundle);
      const finalized = await this.finalizeRecording(
        studio,
        bundle.session.id,
        changeSet,
        pending.projection,
        pending.beforeRevisionHash,
        pending.recordingId,
        "cancel",
        messages,
      );
      this.pendingRecordings.delete(bundle.session.id);
      const rollbackRevision = finalized.payload.afterRevision.stateHash;
      const reverted = projectStateFromEvidence(finalized.payload.postFinalizeStateEvidence, finalized.payload.postFinalizeStateProjection);
      bundle = await this.recordMutationAttempt(bundle, pending.attemptId, pending.changeSetEvidence, pending.projection, pending.preflightProjection, pending.preflight, pending.before, pending.directReadback, pending.afterProjection, pending.afterEvidence, pending.afterRevision, pending.reconciliation, finalized);
      const attempt = requiredSettledMutationAttempt(bundle, pending.attemptId);
      const boundVerification = bindVerificationMutationAttempt(verification, attempt);
      bundle = { ...bundle, verifications: [...bundle.verifications, boundVerification] };
      if (boundVerification.status === "incomplete") {
        bundle = recordObservation(
          {
            ...bundle,
            session: advanceSession(bundle.session, {
              status: "incomplete",
              revisionHash: rollbackRevision,
              failure: {
                code: "verification_evidence_incomplete",
                detail: failures.join("; "),
              },
            }),
          },
          rollbackRevision,
          reverted,
        );
        const result = await this.finish(
          bundle,
          `Verification evidence was incomplete and the provisional change was cancelled: ${failures.join("; ")}`,
        );
        await this.acknowledgeFinalization(studio, finalized, attempt.hash);
        return result;
      }
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
          reverted,
        );
        const result = await this.finish(
          bundle,
          `Verification failed and the repair budget is exhausted: ${failures.join("; ")}`,
        );
        await this.acknowledgeFinalization(studio, finalized, attempt.hash);
        return result;
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
        reverted,
      );
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      await this.acknowledgeFinalization(studio, finalized, attempt.hash);
      return this.repair(bundle, boundVerification);
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
    await this.currentAttestedStudioSession();
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
      const studio = await this.currentAttestedStudioSession();
      const changeSet = requiredChangeSet(bundle);
      const pending = this.pendingRecordings.get(bundle.session.id);
      if (!pending)
        throw new Error("No active Studio recording can be cancelled");
      const messages: PluginToBackendMessage[] = [];
      const unsubscribe = this.capture(studio, messages);
      try {
        bundle = { ...bundle, session: advanceSession(bundle.session, { status: "cancelling" }) };
        this.bundles.set(bundle.session.id, bundle); await this.persist(bundle);
        const finalized = await this.finalizeRecording(
          studio,
          bundle.session.id,
          changeSet,
          pending.projection,
          pending.beforeRevisionHash,
          pending.recordingId,
          "cancel",
          messages,
        );
        const rollbackRevision = finalized.payload.afterRevision.stateHash;
        const reverted = projectStateFromEvidence(finalized.payload.postFinalizeStateEvidence, finalized.payload.postFinalizeStateProjection);
        bundle = await this.recordMutationAttempt(bundle, pending.attemptId, pending.changeSetEvidence, pending.projection, pending.preflightProjection, pending.preflight, pending.before, pending.directReadback, pending.afterProjection, pending.afterEvidence, pending.afterRevision, pending.reconciliation, finalized);
        const attempt = bundle.mutationAttempts.find((candidate) => candidate.id === pending.attemptId)!;
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
          reverted,
        );
        const result = await this.finish(
          bundle,
          "The creator cancelled the uncommitted Studio change recording.",
        );
        await this.acknowledgeFinalization(studio, finalized, attempt.hash);
        return result;
      } finally {
        unsubscribe();
      }
    }
    if (
      (bundle.session.status === "awaiting_review" ||
        bundle.session.status === "creator_rejected") &&
      bundle.checkpoint?.status === "committed"
    ) {
      const studio = await this.currentAttestedStudioSession();
      const changeSet = requiredChangeSet(bundle);
      const checkpoint = bundle.checkpoint;
      const fresh = await requestFreshStudioEvidence(
        this.input.connection,
        studio,
        this.timeout(),
      );
      if (fresh.revision.stateHash !== checkpoint.afterRevisionHash)
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
        assertEvidenceAgainstProjection(rolled.payload.evidence, rolled.payload.evidenceProjection);
        const afterRevision = rolled.payload.afterRevision.stateHash;
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
          projectStateFromEvidence(rolled.payload.evidence, rolled.payload.evidenceProjection),
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

  private async cancelInterruptedRecording(
    bundle: CreatorSessionBundle,
  ): Promise<unknown> {
    const active = bundle.activeMutation;
    const recovery = this.recordingRecovery.get(bundle.session.id);
    if (
      bundle.session.status !== "recovery_required" ||
      !active ||
      !active.recordingId ||
      !recovery ||
      recovery.recordingState !== "open" ||
      recovery.recordingId !== active.recordingId
    )
      throw new Error(
        "The exact interrupted Studio recording has not been proven open",
      );
    const studio = await this.currentAttestedStudioSession();
    if (recovery.studioSessionId !== studio.sessionId)
      throw new Error("Recording recovery evidence belongs to a stale Studio pairing");
    const messages: PluginToBackendMessage[] = [];
    const unsubscribe = this.capture(studio, messages);
    try {
      bundle = {
        ...bundle,
        session: advanceSession(bundle.session, { status: "cancelling" }),
      };
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      const requestId = `creator_recovery_cancel_${randomUUID()}`;
      await this.input.connection.send(
        createBackendMessage(
          "CancelInterruptedRecording",
          {
            requestId,
            creatorSessionId: bundle.session.id,
            changeSetId: active.changeSetId,
            changeSetHash: active.changeSetHash,
            projectionId: active.projectionId,
            projectionHash: active.projectionHash,
            recordingId: active.recordingId,
            manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
            beforeRevisionHash: active.beforeRevisionHash,
            recoveryEvidenceHash: recovery.evidence.contentHash,
          },
          studio.sessionId,
          requestId,
        ),
      );
      const finalized = await waitFor(
        messages,
        (
          message,
        ): message is Extract<
          PluginToBackendMessage,
          { type: "CreatorChangeFinalized" }
        > =>
          message.type === "CreatorChangeFinalized" &&
          message.requestId === requestId &&
          message.payload.creatorSessionId === bundle.session.id &&
          message.payload.changeSetId === active.changeSetId &&
          message.payload.changeSetHash === active.changeSetHash &&
          message.payload.projectionId === active.projectionId &&
          message.payload.projectionHash === active.projectionHash &&
          message.payload.manifestHash === STUDIO_CAPABILITY_MANIFEST_HASH &&
          message.payload.beforeRevisionHash === active.beforeRevisionHash &&
          message.payload.recordingId === active.recordingId &&
          message.payload.action === "cancel" &&
          message.payload.status === "cancelled",
        this.timeout(),
        "interrupted creator recording cancellation",
      );
      assertEvidenceAgainstProjection(
        finalized.payload.postFinalizeStateEvidence,
        finalized.payload.postFinalizeStateProjection,
      );
      let settledAttemptHash: string | undefined;
      if (
        active.stage === "provisional" &&
        active.directReadback &&
        active.afterState &&
        active.reconciliation
      ) {
        const [changeSetEvidence, projection, preflightProjection, preflight, beforeProjection, beforeEnvelope, beforeRevision, directReadback, afterProjection, afterEvidence, afterRevision, reconciliation] = await Promise.all([
          this.artifactStore.read(active.changeSet.artifact),
          this.artifactStore.read(active.projection.artifact),
          this.artifactStore.read(active.preflight.projection.artifact),
          this.artifactStore.read(active.preflight.envelope.artifact),
          this.artifactStore.read(active.beforeState.projection.artifact),
          this.artifactStore.read(active.beforeState.envelope.artifact),
          this.artifactStore.read(active.beforeState.revision.artifact),
          this.artifactStore.read(active.directReadback.artifact),
          this.artifactStore.read(active.afterState.projection.artifact),
          this.artifactStore.read(active.afterState.envelope.artifact),
          this.artifactStore.read(active.afterState.revision.artifact),
          this.artifactStore.read(active.reconciliation.artifact),
        ]);
        bundle = await this.recordMutationAttempt(
          bundle,
          active.attemptId,
          changeSetEvidence as CreatorMutationChangeSetLike,
          projection as StudioEvidenceProjection,
          preflightProjection as StudioEvidenceProjection,
          preflight as StudioEvidenceEnvelope,
          {
            projection: beforeProjection as StudioEvidenceProjection,
            envelope: beforeEnvelope as StudioEvidenceEnvelope,
            revision: beforeRevision as Awaited<ReturnType<typeof requestFreshStudioEvidence>>["revision"],
            state: projectStateFromEvidence(
              beforeEnvelope as StudioEvidenceEnvelope,
              beforeProjection as StudioEvidenceProjection,
            ),
          },
          directReadback as StudioEvidenceEnvelope,
          afterProjection as StudioEvidenceProjection,
          afterEvidence as StudioEvidenceEnvelope,
          afterRevision as Awaited<ReturnType<typeof requestFreshStudioEvidence>>["revision"],
          reconciliation as CreatorMutationReconciliation,
          finalized,
          true,
        );
        settledAttemptHash = bundle.mutationAttempts.find(
          (candidate) => candidate.id === active.attemptId,
        )!.hash;
      } else {
        const recoveryFinalization = await this.mutationBinding(
          finalized.payload,
          contentHash(stableJson(finalized.payload)),
        );
        bundle = {
          ...bundle,
          activeMutation: {
            ...active,
            stage: "recovery_cancelled",
            recoveryFinalization,
            finalState: {
              projection: await this.mutationBinding(
                finalized.payload.postFinalizeStateProjection,
                finalized.payload.postFinalizeStateProjection.contentHash,
              ),
              envelope: await this.mutationBinding(
                finalized.payload.postFinalizeStateEvidence,
                finalized.payload.postFinalizeStateEvidence.contentHash,
              ),
              revision: await this.mutationBinding(
                finalized.payload.afterRevision,
                finalized.payload.afterRevision.stateHash,
              ),
            },
          },
        };
      }
      this.recordingRecovery.delete(bundle.session.id);
      const finalState = projectStateFromEvidence(
        finalized.payload.postFinalizeStateEvidence,
        finalized.payload.postFinalizeStateProjection,
      );
      bundle = recordObservation(
        {
          ...bundle,
          session: advanceSession(bundle.session, {
            status: "incomplete",
            revisionHash: finalized.payload.afterRevision.stateHash,
            failure: {
              code: "interrupted_recording_cancelled",
              detail:
                "The creator explicitly cancelled the exact interrupted Studio recording; the mutation was not resumed.",
            },
          }),
        },
        finalized.payload.afterRevision.stateHash,
        finalState,
      );
      const result = await this.finish(
        bundle,
        "The exact interrupted Studio recording was cancelled. This attempt remains incomplete and was not resumed.",
      );
      if (settledAttemptHash)
        await this.acknowledgeFinalization(
          studio,
          finalized,
          settledAttemptHash,
        );
      return result;
    } finally {
      unsubscribe();
    }
  }

  private async recoverFinalizedMutation(
    bundle: CreatorSessionBundle,
    finalized: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>,
    studio: StudioBridgeSession,
  ): Promise<void> {
    const active = bundle.activeMutation;
    if (!active) return;
    try {
      assertEvidenceAgainstProjection(
        finalized.payload.postFinalizeStateEvidence,
        finalized.payload.postFinalizeStateProjection,
      );
      if (active.executionFailure) {
        const failureEvidence = await this.artifactStore.read(
          active.executionFailure.artifact,
        );
        const failureFacts = assertMutationExecutionFailure(
          failureEvidence,
          active.attemptId,
          active.executionFailure.hash,
        );
        bundle = await this.recordIncompleteApplyAttempt(
          bundle,
          finalized,
          failureFacts,
        );
        const attempt = bundle.mutationAttempts.find(
          (candidate) => candidate.id === active.attemptId,
        )!;
        const { activeMutation: _activeMutation, ...settledBundle } = bundle;
        bundle = recordObservation(
          {
            ...settledBundle,
            session: advanceSession(bundle.session, {
              status: "incomplete",
              revisionHash: finalized.payload.afterRevision.stateHash,
              failure: {
                code: "mutation_execution_failed",
                detail: failureFacts.map((fact) => fact.detail).join("; "),
              },
            }),
          },
          finalized.payload.afterRevision.stateHash,
          projectStateFromEvidence(
            finalized.payload.postFinalizeStateEvidence,
            finalized.payload.postFinalizeStateProjection,
          ),
        );
        await this.finish(
          bundle,
          "The failed Studio mutation's persisted cancellation receipt was recovered. Complete post-cancel evidence is preserved and no mutation verdict was invented.",
        );
        await this.acknowledgeFinalization(studio, finalized, attempt.hash);
        return;
      }
      if (
        active.stage !== "provisional" ||
        !active.directReadback ||
        !active.afterState ||
        !active.reconciliation
      ) {
        const artifact = await this.artifactStore.write(finalized.payload);
        bundle = {
          ...bundle,
          activeMutation: {
            ...active,
            recoveryFinalization: {
              artifact,
              hash: contentHash(stableJson(finalized.payload)),
            },
            finalState: {
              projection: await this.mutationBinding(
                finalized.payload.postFinalizeStateProjection,
                finalized.payload.postFinalizeStateProjection.contentHash,
              ),
              envelope: await this.mutationBinding(
                finalized.payload.postFinalizeStateEvidence,
                finalized.payload.postFinalizeStateEvidence.contentHash,
              ),
              revision: await this.mutationBinding(
                finalized.payload.afterRevision,
                finalized.payload.afterRevision.stateHash,
              ),
            },
          },
        };
        this.bundles.set(bundle.session.id, bundle);
        await this.persist(bundle);
        await this.publishView(
          bundle,
          "Studio finalized the interrupted recording, but the persisted mutation graph is incomplete. No checkpoint or verdict was invented.",
        );
        return;
      }
      bundle = await this.recordAttemptFromActive(bundle, finalized, false);
      const attempt = requiredSettledMutationAttempt(bundle, active.attemptId);
      const changeSet = requiredChangeSet(bundle);
      const finalState = projectStateFromEvidence(
        finalized.payload.postFinalizeStateEvidence,
        finalized.payload.postFinalizeStateProjection,
      );
      const draft = active.verificationDraft
        ? await this.artifactStore.read(active.verificationDraft.artifact)
        : undefined;
      if (draft !== undefined) assertCreatorVerificationRecord(draft);
      const boundVerification = draft
        ? bindVerificationMutationAttempt(draft, attempt)
        : undefined;
      if (
        finalized.payload.action === "commit" &&
        boundVerification?.status === "passed"
      ) {
        const checkpoint = createCheckpoint(
          bundle.session.id,
          changeSet,
          {
            beforeRevisionHash: active.beforeRevisionHash,
            afterRevisionHash: finalized.payload.afterRevision.stateHash,
          },
          finalized.payload.afterRevision.stateHash,
          attempt,
        );
        bundle = recordObservation(
          {
            ...bundle,
            verifications: [...bundle.verifications, boundVerification],
            checkpoint,
            session: advanceSession(bundle.session, {
              status: "awaiting_review",
              checkpoint,
              revisionHash: finalized.payload.afterRevision.stateHash,
            }),
          },
          finalized.payload.afterRevision.stateHash,
          finalState,
        );
      } else {
        bundle = recordObservation(
          {
            ...bundle,
            ...(boundVerification
              ? { verifications: [...bundle.verifications, boundVerification] }
              : {}),
            session: advanceSession(bundle.session, {
              status: "incomplete",
              revisionHash: finalized.payload.afterRevision.stateHash,
              failure: {
                code:
                  finalized.payload.action === "commit"
                    ? "commit_without_persisted_verification"
                    : "control_process_interrupted",
                detail:
                  "The interrupted transaction was finalized, but Forge will not resume an interrupted verification or provider phase.",
              },
            }),
          },
          finalized.payload.afterRevision.stateHash,
          finalState,
        );
      }
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      await this.publishView(
        bundle,
        bundle.session.status === "awaiting_review"
          ? "Recovered the exact committed mutation, persisted verification, and post-commit state. Creator review may resume."
          : "Recovered the exact finalized mutation as incomplete; no worker or Studio operation was retried.",
      );
      await this.acknowledgeFinalization(studio, finalized, attempt.hash);
    } catch (error) {
      const failed = bundle;
      this.bundles.set(failed.session.id, failed);
      await this.persist(failed);
      await this.publishView(
        failed,
        `Finalization recovery evidence could not be bound exactly. Forge made no Studio change: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async recordAttemptFromActive(
    bundle: CreatorSessionBundle,
    finalized: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>,
    recoveryCancellation: boolean,
  ): Promise<CreatorSessionBundle> {
    const active = bundle.activeMutation;
    if (
      !active ||
      active.stage !== "provisional" ||
      !active.directReadback ||
      !active.afterState ||
      !active.reconciliation
    )
      throw new Error("Complete provisional mutation evidence is unavailable");
    const [changeSetEvidence, projection, preflightProjection, preflight, beforeProjection, beforeEnvelope, beforeRevision, directReadback, afterProjection, afterEvidence, afterRevision, reconciliation] = await Promise.all([
      this.artifactStore.read(active.changeSet.artifact),
      this.artifactStore.read(active.projection.artifact),
      this.artifactStore.read(active.preflight.projection.artifact),
      this.artifactStore.read(active.preflight.envelope.artifact),
      this.artifactStore.read(active.beforeState.projection.artifact),
      this.artifactStore.read(active.beforeState.envelope.artifact),
      this.artifactStore.read(active.beforeState.revision.artifact),
      this.artifactStore.read(active.directReadback.artifact),
      this.artifactStore.read(active.afterState.projection.artifact),
      this.artifactStore.read(active.afterState.envelope.artifact),
      this.artifactStore.read(active.afterState.revision.artifact),
      this.artifactStore.read(active.reconciliation.artifact),
    ]);
    return this.recordMutationAttempt(
      bundle,
      active.attemptId,
      changeSetEvidence as CreatorMutationChangeSetLike,
      projection as StudioEvidenceProjection,
      preflightProjection as StudioEvidenceProjection,
      preflight as StudioEvidenceEnvelope,
      {
        projection: beforeProjection as StudioEvidenceProjection,
        envelope: beforeEnvelope as StudioEvidenceEnvelope,
        revision: beforeRevision as Awaited<ReturnType<typeof requestFreshStudioEvidence>>["revision"],
        state: projectStateFromEvidence(
          beforeEnvelope as StudioEvidenceEnvelope,
          beforeProjection as StudioEvidenceProjection,
        ),
      },
      directReadback as StudioEvidenceEnvelope,
      afterProjection as StudioEvidenceProjection,
      afterEvidence as StudioEvidenceEnvelope,
      afterRevision as Awaited<ReturnType<typeof requestFreshStudioEvidence>>["revision"],
      reconciliation as CreatorMutationReconciliation,
      finalized,
      recoveryCancellation,
    );
  }

  private async acknowledgeFinalization(
    studio: StudioBridgeSession,
    finalized: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>,
    attemptHash: string,
  ): Promise<void> {
    requiredHash(attemptHash, "Persisted creator mutation attempt");
    const requestId = `creator_finalization_ack_${randomUUID()}`;
    try {
      await this.input.connection.send(
        createBackendMessage(
        "AcknowledgeCreatorChangeFinalization",
        {
          requestId,
          creatorSessionId: finalized.payload.creatorSessionId,
          changeSetId: finalized.payload.changeSetId,
          changeSetHash: finalized.payload.changeSetHash,
          projectionId: finalized.payload.projectionId,
          projectionHash: finalized.payload.projectionHash,
          manifestHash: finalized.payload.manifestHash,
          beforeRevisionHash: finalized.payload.beforeRevisionHash,
          recordingId: finalized.payload.recordingId,
          action: finalized.payload.action,
          status: finalized.payload.action === "commit" ? "committed" : "cancelled",
          afterRevisionHash: finalized.payload.afterRevision.stateHash,
          postFinalizeProjectionHash:
            finalized.payload.postFinalizeStateProjection.contentHash,
          postFinalizeEvidenceHash:
            finalized.payload.postFinalizeStateEvidence.contentHash,
        },
        studio.sessionId,
          requestId,
        ),
      );
    } catch {
      // The exact receipt stays durable in the connector and will be replayed
      // on re-pair. The already-persisted creator outcome is not rolled back or
      // reclassified because notification acknowledgement transport failed.
    }
  }

  private async finalizeRecording(
    studio: StudioBridgeSession,
    sessionId: string,
    changeSet: CreatorChangeSet,
    projection: StudioEvidenceProjection,
    beforeRevisionHash: string,
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
          projectionId: projection.id,
          projectionHash: projection.contentHash,
          manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
          beforeRevisionHash,
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
        message.payload.projectionHash === projection.contentHash &&
        message.payload.manifestHash === STUDIO_CAPABILITY_MANIFEST_HASH &&
        message.payload.beforeRevisionHash === beforeRevisionHash &&
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
  private async currentAttestedStudioSession(): Promise<StudioBridgeSession> {
    const studio = await this.currentStudioSession();
    const deadline = Date.now() + Math.min(this.timeout(), 15_000);
    while (Date.now() < deadline) {
      const attestation = this.attestations.get(studio.sessionId);
      if (attestation?.status === "verified") return studio;
      if (attestation?.status === "rejected")
        throw new Error(
          `Studio capability attestation was rejected: ${attestation.detail}`,
        );
      if (attestation?.status === "incomplete")
        throw new Error(
          `Studio capability attestation is incomplete: ${attestation.detail}`,
        );
      await new Promise((resolveValue) => setTimeout(resolveValue, 50));
    }
    throw new Error(
      "The paired Studio connector did not produce a complete capability attestation",
    );
  }
  private async requireClearRecordingInventory(
    studio: StudioBridgeSession,
  ): Promise<void> {
    const deadline = Date.now() + Math.min(this.timeout(), 15_000);
    while (Date.now() < deadline) {
      const scan = this.recordingScans.get(studio.sessionId);
      if (scan?.status === "clear") return;
      if (scan?.status === "blocked") throw new Error(scan.detail);
      await new Promise((resolveValue) => setTimeout(resolveValue, 50));
    }
    throw new Error(
      "The paired Studio connector did not report its durable creator-transaction state",
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
    const latestAttempt = bundle.mutationAttempts.at(-1);
    const activeMutation = bundle.activeMutation;
    const studio = this.pairedStudio();
    const attestation =
      studio?.projectId === bundle.session.projectId
        ? this.attestations.get(studio.sessionId)
        : undefined;
    const mutationPresentation = await this.mutationPresentation(
      bundle,
      latestAttempt,
      activeMutation,
    );
    const artifacts = {
      prompt: promptArtifact,
      ...(planArtifact ? { plan: planArtifact } : {}),
      ...(changeSetArtifact ? { changeSet: changeSetArtifact } : {}),
      ...(verification?.executionPlan
        ? { studioExecutionPlan: verification.executionPlan.artifact }
        : activeMutation?.verificationPlan
          ? { studioExecutionPlan: activeMutation.verificationPlan.artifact }
          : {}),
      ...(verification?.runtimeEvidence
        ? { runtimeEvidence: verification.runtimeEvidence.artifact }
        : {}),
      ...((latestAttempt ?? activeMutation) ? {
        capabilityManifest: (latestAttempt ?? activeMutation)!.manifest.artifact,
        mutationProjection: (latestAttempt ?? activeMutation)!.projection.artifact,
        ...((latestAttempt ?? activeMutation)!.preflight
          ? { mutationPreflight: (latestAttempt ?? activeMutation)!.preflight!.envelope.artifact }
          : {}),
      } : {}),
      ...(latestAttempt?.completion === "settled"
        ? {
            mutationReadback: latestAttempt.directReadback.artifact,
            projectState: latestAttempt.afterState.envelope.artifact,
            mutationReconciliation: latestAttempt.reconciliation.artifact,
            mutationFinalization: latestAttempt.finalization.artifact,
          }
        : activeMutation
          ? {
              ...(activeMutation.directReadback
                ? { mutationReadback: activeMutation.directReadback.artifact }
                : {}),
              ...(activeMutation.afterState
                ? { projectState: activeMutation.afterState.envelope.artifact }
                : {}),
              ...(activeMutation.reconciliation
                ? { mutationReconciliation: activeMutation.reconciliation.artifact }
                : {}),
            }
          : {}),
      ...(attestation?.status === "verified"
        ? { capabilityAttestation: attestation.artifact }
        : (latestAttempt ?? activeMutation)
          ? { capabilityAttestation: (latestAttempt ?? activeMutation)!.attestation.envelope.artifact }
        : {}),
      ...(verificationArtifact ? { verification: verificationArtifact } : {}),
      ...(bundle.review ? { reviewReport: bundle.review.artifact } : {}),
      ...(latestRun
        ? { agentRun: latestRun.agentRun, trace: latestRun.trace }
        : {}),
    };
    const recovery = this.recordingRecovery.get(bundle.session.id);
    return controlView(
      bundle,
      detailValue,
      prompt,
      artifacts,
      mutationPresentation,
      recovery?.recordingState === "open" &&
        recovery.recordingId === activeMutation?.recordingId,
    );
  }

  private async mutationPresentation(
    bundle: CreatorSessionBundle,
    attempt: CreatorMutationAttempt | undefined,
    active: CreatorActiveMutation | undefined,
  ): Promise<CreatorControlView["mutation"]> {
    const cursor = attempt ?? active;
    if (!cursor) return undefined;
    const projection = await this.artifactStore.read(cursor.projection.artifact) as StudioEvidenceProjection;
    const reconciliationBinding =
      attempt?.completion === "settled"
        ? attempt.reconciliation
        : active?.reconciliation;
    const reconciliation = reconciliationBinding
      ? await this.artifactStore.read(reconciliationBinding.artifact) as CreatorMutationReconciliation
      : undefined;
    const failureFacts = (
      attempt?.completion === "incomplete"
        ? attempt.failureFacts
        : reconciliation?.failureFacts ?? []
    ).map((fact) => ({ statement: fact.detail, hash: fact.hash }));
    const status = attempt
      ? bundle.checkpoint?.mutationAttemptId === attempt.id
        ? bundle.checkpoint.status === "rolled_back"
          ? "rolled_back" as const
          : "committed" as const
        : attempt.completion === "incomplete"
          ? attempt.phase === "preflight"
            ? "preflight_failed" as const
            : "incomplete" as const
        : attempt.finalization.hash
          ? "cancelled" as const
          : reconciliation?.status ?? "incomplete"
      : bundle.session.status === "recovery_required"
        ? "recovery_required" as const
        : reconciliation?.status ?? (active?.stage === "preflighted" ? "preflighting" as const : "provisional" as const);
    return {
      attemptId: attempt?.id ?? active!.attemptId,
      status,
      failureFacts,
      replayable:
        attempt?.completion === "settled" &&
        reconciliation?.status !== "incomplete",
      projectionFactCount: projection.requirements.length,
    };
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
function requiredSettledMutationAttempt(
  bundle: CreatorSessionBundle,
  attemptId: string,
): CreatorSettledMutationAttempt {
  const attempt = bundle.mutationAttempts.find(
    (candidate) => candidate.id === attemptId,
  );
  if (!attempt || attempt.completion !== "settled")
    throw new Error("The finalized mutation attempt is missing or incomplete");
  return attempt;
}
function bundleArtifactReferences(
  bundle: CreatorSessionBundle,
): ArtifactReference[] {
  return [
    ...bundle.agentRuns.flatMap((run) => [run.agentRun, run.trace]),
    ...bundle.verifications.flatMap((verification) => [
      verification.executionPlan.artifact,
      ...(verification.runtimeEvidence
        ? [verification.runtimeEvidence.artifact]
        : []),
    ]),
    ...bundle.mutationAttempts.flatMap((attempt) => mutationAttemptReferences(attempt)),
    ...(bundle.activeMutation
      ? activeMutationReferences(bundle.activeMutation)
      : []),
    ...(bundle.review ? [bundle.review.artifact] : []),
  ];
}
function activeMutationReferences(active: CreatorActiveMutation): ArtifactReference[] {
  return [
    active.manifest.artifact,
    active.attestation.projection.artifact,
    active.attestation.envelope.artifact,
    active.changeSet.artifact,
    active.projection.artifact,
    active.preflight.projection.artifact,
    active.preflight.envelope.artifact,
    active.beforeState.projection.artifact,
    active.beforeState.envelope.artifact,
    active.beforeState.revision.artifact,
    ...(active.directReadback ? [active.directReadback.artifact] : []),
    ...(active.afterState
      ? [active.afterState.projection.artifact, active.afterState.envelope.artifact, active.afterState.revision.artifact]
      : []),
    ...(active.reconciliation ? [active.reconciliation.artifact] : []),
    ...(active.executionFailure ? [active.executionFailure.artifact] : []),
    ...(active.verificationPlan ? [active.verificationPlan.artifact] : []),
    ...(active.verificationDraft ? [active.verificationDraft.artifact] : []),
    ...(active.recoveryFinalization
      ? [active.recoveryFinalization.artifact]
      : []),
    ...(active.finalState
      ? [active.finalState.projection.artifact, active.finalState.envelope.artifact, active.finalState.revision.artifact]
      : []),
  ];
}
function mutationAttemptReferences(attempt: CreatorMutationAttempt): ArtifactReference[] {
  const common = [
    attempt.manifest.artifact, attempt.attestation.projection.artifact, attempt.attestation.envelope.artifact,
    attempt.changeSet.artifact, attempt.projection.artifact,
    attempt.beforeState.projection.artifact, attempt.beforeState.envelope.artifact, attempt.beforeState.revision.artifact,
    ...(attempt.completion === "incomplete" ? [attempt.preflightProjection.artifact] : []),
    ...(attempt.preflight ? [attempt.preflight.projection.artifact, attempt.preflight.envelope.artifact] : []),
  ];
  if (attempt.completion === "incomplete")
    return attempt.phase === "apply"
      ? [
          ...common,
          attempt.finalState.projection.artifact,
          attempt.finalState.envelope.artifact,
          attempt.finalState.revision.artifact,
          attempt.finalization.artifact,
        ]
      : common;
  return [
    ...common,
    attempt.directReadback.artifact,
    attempt.afterState.projection.artifact, attempt.afterState.envelope.artifact, attempt.afterState.revision.artifact,
    attempt.finalState.projection.artifact, attempt.finalState.envelope.artifact, attempt.finalState.revision.artifact,
    attempt.reconciliation.artifact, attempt.finalization.artifact,
  ];
}
function assertMutationExecutionFailure(
  value: unknown,
  attemptId: string,
  expectedHash: string,
): readonly CreatorMutationFailureFact[] {
  if (
    !isRecord(value) ||
    value.kind !== "CreatorMutationExecutionFailure" ||
    value.attemptId !== attemptId ||
    !Array.isArray(value.failureFacts)
  )
    throw new Error("Invalid persisted mutation execution failure");
  const actualHash = contentHash(stableJson(value));
  if (actualHash !== expectedHash)
    throw new Error("Mutation execution failure artifact binding changed");
  const facts = createMutationFailureFacts(
    value.failureFacts.map((fact) => {
      if (
        !isRecord(fact) ||
        typeof fact.code !== "string" ||
        typeof fact.detail !== "string" ||
        typeof fact.hash !== "string"
      )
        throw new Error("Invalid persisted mutation execution failure fact");
      return { code: fact.code, detail: fact.detail };
    }),
  );
  if (stableJson(facts) !== stableJson(value.failureFacts))
    throw new Error("Mutation execution failure facts are not canonical");
  return facts;
}
function attestationSummary(
  grade: StudioCapabilityAttestationGrade,
): Omit<StudioCapabilityAttestationGrade, "status"> {
  const { status: _status, ...summary } = grade;
  return summary;
}
function rejectedAttestationGrade(detail: string): StudioCapabilityAttestationGrade {
  return {
    status: "rejected",
    totalFacts: 0,
    observedFacts: 0,
    unavailableFacts: 0,
    readErrorFacts: 0,
    mismatchedFacts: 0,
    missingFacts: 0,
    findingsTruncated: false,
    findings: [{ key: "attestation", code: "attestation_validation_failed" }],
    detail: `Capability attestation rejected: ${detail}`,
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isTerminalStatus(
  status: CreatorSessionBundle["session"]["status"],
): boolean {
  return [
    "creator_accepted",
    "creator_rejected",
    "rolled_back",
    "incomplete",
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
                "preflighting", "applying",
                "awaiting_verification",
                "verifying",
                "repairing", "cancelling", "committing",
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
        ? status === "incomplete" && session.failure
          ? `${status.replaceAll("_", " ")}: ${session.failure.code.replaceAll("_", " ")}`
          : status.replaceAll("_", " ")
        : `${labels[id]} evidence`,
  }));
}

/**
 * Reconstructs a truthful creator-facing lifecycle explanation from durable
 * session bindings. Control views themselves are intentionally ephemeral, so
 * this path must never replace a restored terminal or recovery state with a
 * generic "ready" message after a control-process restart.
 */
export function restoredCreatorControlDetail(
  bundle: CreatorSessionBundle,
): string {
  const { session } = bundle;
  switch (session.status) {
    case "planning":
      return "Forge is producing a bounded plan. Studio remains read-only.";
    case "awaiting_plan_approval":
      return "Review the exact plan and proof obligations. Studio remains read-only until you approve them.";
    case "building":
      return "Forge is producing the exact typed change set from the approved plan. Studio remains read-only.";
    case "awaiting_change_approval":
      return "Review the exact typed mutation and projected proof obligations before authorizing Studio preflight and provisional application.";
    case "preflighting":
      return "Studio is checking only the approved capabilities on detached scratch instances. No place recording may open during preflight.";
    case "applying":
      return "Studio may own the exact approved provisional recording. Forge will not infer, retry, commit, or cancel it without bound evidence.";
    case "awaiting_verification":
      return "The provisional mutation has complete matched readback and state evidence. Start the exact approved checks or cancel it.";
    case "verifying":
      return "Studio is running the exact creator-approved checks. Forge is waiting for complete bound evidence and will not invent a verdict.";
    case "repairing":
      return "Forge is producing a bounded repair from recorded failure evidence. Studio will not be mutated without another exact approval.";
    case "cancelling":
      return "Forge is waiting for exact cancellation acknowledgement and post-cancel state evidence.";
    case "committing":
      return "Forge is waiting for exact commit acknowledgement and post-commit state evidence before creating a checkpoint.";
    case "awaiting_review":
      return "The committed result and its evidence are ready for your required free-form review report and final decision.";
    case "creator_accepted":
      return "The creator accepted the committed result. The final report and replayable evidence remain preserved.";
    case "creator_rejected":
      return "The creator rejected this attempt before accepting a result. Its evidence remains preserved.";
    case "rolled_back":
      return "The creator rejected the result and Studio acknowledged the exact rollback. The evidence remains preserved.";
    case "recovery_required":
      return restoredRecoveryDetail(bundle);
    case "incomplete":
      return restoredIncompleteDetail(bundle);
  }
}

function restoredRecoveryDetail(bundle: CreatorSessionBundle): string {
  const failure = bundle.session.failure;
  const reason = failure
    ? `${failure.code.replaceAll("_", " ")} (detail ${failure.detailHash.slice(0, 12)}…)`
    : "an interrupted Studio transaction";
  return `Recovery is required because of ${reason}. Forge will not retry, commit, cancel, or assume rollback automatically. Only an exact open-recording recovery action may change Studio.`;
}

function restoredIncompleteDetail(bundle: CreatorSessionBundle): string {
  const failure = bundle.session.failure;
  const reason = failure
    ? `${failure.code.replaceAll("_", " ")} (detail ${failure.detailHash.slice(0, 12)}…)`
    : "missing required evidence";
  const latestAttempt = bundle.mutationAttempts.at(-1);
  if (!latestAttempt && !bundle.activeMutation) {
    const boundary = bundle.session.changeApproval
      ? "after the exact change was approved but before any Studio mutation attempt was durably recorded"
      : bundle.session.planApproval
        ? "after the plan was approved but before an approved Studio mutation existed"
        : bundle.session.plan
          ? "while the plan was being prepared or reviewed"
          : "before an approved change existed";
    return `This attempt ended incomplete ${boundary}: ${reason}. There is no mutation-attempt or verification evidence, so Forge makes no claim that the place changed. This terminal attempt cannot resume; start a new request to retry.`;
  }
  const attemptDetail = latestAttempt
    ? latestAttempt.completion === "incomplete"
      ? `Mutation attempt ${latestAttempt.id} ended incomplete during ${latestAttempt.phase}.`
      : `Mutation attempt ${latestAttempt.id} has settled mutation evidence.`
    : "A durable mutation cursor remains bound to this session.";
  return `This attempt ended incomplete: ${reason}. ${attemptDetail} Forge makes no unproven verification claim. Inspect the preserved mutation evidence, then start a new request if you want to retry.`;
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
      "cancel_interrupted_recording",
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
  mutation?: CreatorControlView["mutation"],
  recoveryCancellationAvailable = false,
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
      "preflighting",
      "applying",
      "awaiting_verification",
      "verifying",
      "cancelling",
      "committing",
      "awaiting_review",
      "recovery_required",
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
  const actions = controlActions(
    bundle.session.status,
    recoveryCancellationAvailable,
  );
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
    ...(mutation ? { mutation } : {}),
    ...actions,
  });
}
function controlActions(
  status: CreatorSessionBundle["session"]["status"],
  recoveryCancellationAvailable = false,
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
  if (status === "recovery_required" && recoveryCancellationAvailable)
    return {
      primaryAction: {
        id: "cancel_interrupted_recording",
        label: "Cancel Interrupted Recording",
        intent: "primary",
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
    preflighting: "Preflighting Capabilities",
    applying: "Applying Approved Changes",
    awaiting_verification: "Ready for Checks",
    verifying: "Running Approved Checks",
    cancelling: "Cancelling Provisional Change",
    committing: "Committing Proven Change",
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
    proofObligations: adaptCreatorChangeSetMutationOperations(changeSet).flatMap(
      mutationProofObligations,
    ),
  };
}
function mutationProofObligations(
  operation: ReturnType<typeof adaptCreatorChangeSetMutationOperations>[number],
): Array<{ fact: string; expected: string }> {
  if (operation.target.kind !== "instance")
    throw new Error("Creator mutation proof obligations require an instance target");
  const target = `${operation.target.className} ${operation.target.path}`;
  const obligations: Array<{ fact: string; expected: string }> = [];
  if (operation.kind === "create" || operation.kind === "move")
    obligations.push({
      fact: `${target} structure`,
      expected: stableJson(operation.structure),
    });
  if (operation.kind === "delete")
    obligations.push({ fact: `${target} structure`, expected: "absent" });
  for (const [name, value] of Object.entries(operation.properties ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) obligations.push({
    fact: `${target}.${name}`,
    expected: stableJson(value),
  });
  for (const [name, value] of Object.entries(operation.attributes ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) obligations.push({
    fact: `${target} attribute ${name}`,
    expected: stableJson(value),
  });
  for (const name of [...(operation.removedAttributes ?? [])].sort())
    obligations.push({
      fact: `${target} attribute ${name}`,
      expected: "absent",
    });
  if (operation.sourceHash)
    obligations.push({
      fact: `${target} source hash`,
      expected: operation.sourceHash,
    });
  return obligations;
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
function createVerificationRecord(
  sessionId: string,
  changeSet: CreatorChangeSet,
  charter: import("./index.js").VerificationCharter,
  executionPlan: import("../../studio-capabilities/src/index.js").StudioExecutionPlan,
  executionPlanArtifact: ArtifactReference,
  stateRevisionHash: string,
  stateEvidenceHash: string,
  mutationAttempt: { id: string; reconciliationHash: string },
  evidence: StudioEvidenceEnvelope | undefined,
  runtimeEvidenceArtifact: ArtifactReference | undefined,
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
    stateRevisionHash,
    stateEvidenceHash,
    mutationAttempt: { ...mutationAttempt, hash: "0".repeat(64) },
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
    ...(evidence && runtimeEvidenceArtifact
      ? {
          runtimeEvidence: {
            evidenceHash: verificationEvidenceHash(evidence),
            diagnosticsHash: verificationEvidenceHash(evidence.diagnostics ?? []),
            artifact: runtimeEvidenceArtifact,
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
  },
  afterRevisionHash: string,
  attempt: CreatorSettledMutationAttempt,
): CreatorCheckpoint {
  const payload = {
    sessionId,
    changeSetId: changeSet.id,
    changeSetHash: changeSet.hash,
    beforeRevisionHash: pending.beforeRevisionHash,
    afterRevisionHash,
    mutationAttemptId: attempt.id,
    mutationAttemptHash: attempt.hash,
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
function bindVerificationMutationAttempt(
  verification: CreatorVerificationRecord,
  attempt: CreatorSettledMutationAttempt,
): CreatorVerificationRecord {
  const { kind: _kind, id: _id, hash: _hash, ...prior } = verification;
  const payload = {
    ...prior,
    mutationAttempt: {
      id: attempt.id,
      hash: attempt.hash,
      reconciliationHash: attempt.reconciliation.hash,
    },
  };
  const hash = contentHash(stableJson(payload));
  return { kind: "CreatorVerificationRecord", id: `creator_verification_${hash.slice(0, 24)}`, hash, ...payload };
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
    mutationAttemptId: checkpoint.mutationAttemptId,
    mutationAttemptHash: checkpoint.mutationAttemptHash,
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
