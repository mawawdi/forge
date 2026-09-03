import { randomUUID } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_AGENT_BUDGETS,
  assertAgentExecutionSlot,
  type AgentExecutionSlot,
} from "../../agent-runtime/src/index.js";
import {
  ImmutableJsonArtifactStore,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  RojoMutationApplyError,
  applyRojoSourceChangeSet,
  assertProjectAuthorityHostContext,
  assertProjectAuthorityMap,
  assertRojoMutationAttempt,
  assertRojoSourceChangeSet,
  assertRojoSourceRevert,
  assertRojoSourceRevertSyncProof,
  assertRojoSyncProof,
  createProjectAuthorityMap,
  createRojoSourceChangeSet,
  createRojoSourceRevertSyncProof,
  createRojoSyncProof,
  replayRojoMutation,
  rojoOwnedStudioPaths,
  rojoSourceFilename,
  revertRojoSourceMutation,
  type ProjectAuthorityHostContext,
  type ProjectAuthorityMap,
  type RojoMutationAttempt,
  type RojoSourceClass,
  type RojoSourceOperation,
  type RojoSourceChangeSet,
  type RojoSourceRevert,
} from "../../project-authority/src/index.js";
import {
  assertProductionStudioSourceIndex,
  assertCreatorSourceConsultation,
  assertStudioSourceIndex,
  createHashVerifiedChunkSourceResolver,
  findStudioSourceReferences,
  findStudioSourceSymbols,
  inspectStudioSourceDependencies,
  listStudioSourceDocuments,
  readStudioSourceAsync,
  searchStudioSourceAsync,
  type CreatorSourceConsultation,
  type PinnedSourceAnalysisArtifact,
  type PinnedSourceAnalysisOutcome,
  type SourceDocumentDescriptor,
  type StudioSourceIndex,
  type VerifiedSourceResolver,
} from "../../source-intelligence/src/index.js";
import {
  createBackendMessage,
  type StudioBridgeConnection,
  type StudioBridgeSession,
} from "../../studio-bridge/src/index.js";
import {
  BACKEND_COMMAND_FRAGMENT_BYTES,
  createCreatorChangePrepareTransfer,
  type CreatorChangePrepareDocument,
  type PluginToBackendMessage,
} from "../../studio-protocol/src/index.js";
import {
  CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS,
  assertStudioExecutionPlan,
  createStudioExecutionPlan,
} from "../../studio-capabilities/src/index.js";
import {
  StudioProjectIndexStreamRouter,
  executeCreatorVerificationPlan,
  isStudioProjectIndexStreamMessage,
  requestStudioProjectIndex,
  waitForStudioProjectIndexCapture,
} from "../../studio-runtime/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  assertStudioProjectIndexCapture,
  createStudioConnectorEpoch,
  studioObjectIdentityKey,
  studioProjectIndexMetadataView,
  studioProjectIndexSourceMetadata,
  assertEvidenceAgainstProjection,
  assertStudioEvidenceEnvelope,
  gradeStudioCapabilityAttestation,
  serializeStudioEvidenceProjection,
  type StudioCapabilityAttestationGrade,
  type StudioEvidenceBinding,
  type StudioEvidenceEnvelope,
  type StudioEvidenceProjection,
  type StudioProjectIndexCapture,
} from "../../studio-evidence/src/index.js";
import {
  advanceSession,
  assertCreatorTransactionControlActionBinding,
  assertCreatorAgentContextCitation,
  assertCreatorRequestArtifact,
  assertCreatorVerificationRecord,
  createCreatorTransactionControlView,
  createCreatorApproval,
  createCreatorReviewReport,
  createCreatorSession,
  createStudioOwnershipMap,
  loadCreatorBundle,
  persistCreatorBundle,
  serializeCreatorChangeSet,
  type CreatorChangeSet,
  type CreatorCheckpoint,
  type CreatorTransactionState,
  type CreatorTransactionStage,
  type CreatorSessionStatus,
  type CreatorSessionBundle,
  type CreatorActiveMutation,
  type CreatorAgentContextCitation,
  type CreatorTransactionControlActionId,
  type CreatorTransactionControlView,
  type CreatorPlanChange,
  type CreatorVerificationRecord,
  assertCreatorTransactionTopologyOrder,
} from "./index.js";
import {
  createCreatorProjectChangeNotice,
  createCreatorRestartChangeNotice,
  createCreatorProjectDelta,
  createCreatorProjectRefresh,
  createCreatorTransactionProjectChangeConfirmation,
  creatorProjectIndexArtifactReferences,
  readCreatorProjectIndexArtifacts,
  readCreatorProjectIndexMetadataArtifacts,
  writeCreatorProjectIndexArtifacts,
  type CreatorProjectIndexArtifactBinding,
  type CreatorProjectChangeNotice,
} from "./project-refresh.js";
import {
  writeCreatorSourceWriteArtifacts,
  readCreatorSourceWriteArtifacts,
  readCreatorSourceWriteArtifactRange,
} from "./source-write.js";
import {
  createCharterExecution,
  createVerificationFailureFacts,
  gradeRuntimeCharter,
  gradeProjectIndexCharter,
  replayCreatorVerification,
  verificationEvidenceHash,
} from "./verification.js";
import {
  adaptCreatorChangeSetMutationOperations,
  compileCreatorChangeSetMutationProjection,
  creatorDeleteSubtreesFromProjectIndex,
  creatorStructuralParentsFromProjectIndex,
  createIncompleteApplyMutationAttempt,
  createIncompleteCreatorMutationAttempt,
  createIncompleteDurableIntentMutationAttempt,
  createCreatorMutationAttempt,
  createCreatorMutationFinalization,
  assertCreatorMutationFinalization,
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

export type CreatorTransactionControlAction =
  | {
      action: "start";
      /** Exact creator-authored request. */
      creatorText: string;
      /** Host-authored model input, including any bounded conversation context. */
      agentPrompt: string;
      model: string;
      creatorSessionId: string;
      /** Host-issued conversation evidence, retained with the request. */
      contextCitations: readonly CreatorAgentContextCitation[];
      /** Exact provider execution reserved before the foreground job was published. */
      agentExecutions: readonly AgentExecutionSlot[];
    }
  | {
      /**
       * Consume a previously received, durable planner response. This is only
       * reachable after the conversation layer records explicit creator
       * authority; it never constructs a new provider request for that turn.
       */
      action: "resume";
      creatorSessionId: string;
      agentExecutions: readonly AgentExecutionSlot[];
    }
  | {
      action: "act";
      sessionId: string;
      viewId: string;
      viewHash: string;
      actionId: CreatorTransactionControlActionId;
      report?: string;
      /** Empty unless this exact action is allowed to invoke a planner/builder/repair. */
      agentExecutions: readonly AgentExecutionSlot[];
    };

export interface CreatorSourceAnalysisHost {
  analyze(input: {
    readonly snapshotHash: string;
    readonly documents: readonly SourceDocumentDescriptor[];
    readonly resolver: VerifiedSourceResolver;
  }): Promise<PinnedSourceAnalysisOutcome>;
}

interface ProjectAuthorityLease {
  readonly projectId: string;
  readonly epoch: number;
}

interface PendingTransactionProjectChange {
  readonly notice: CreatorProjectChangeNotice;
  readonly artifact: ArtifactReference;
}

interface PendingFinalizationAcknowledgement {
  readonly studioSessionId: string;
  readonly projectId: string;
  readonly receipt: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>["payload"];
  readonly receiptArtifact: ArtifactReference;
  readonly authorityHash: string;
}

function mergeCreatorProjectChangeEdges(
  bundle: CreatorSessionBundle,
  current: CreatorSessionBundle | undefined,
): CreatorSessionBundle {
  if (!current || current === bundle) return bundle;
  const byArtifact = new Map(
    bundle.projectChanges.map((change) => [change.artifact.artifactHash, change] as const),
  );
  for (const persisted of current.projectChanges) {
    const candidate = byArtifact.get(persisted.artifact.artifactHash);
    if (!candidate) {
      byArtifact.set(persisted.artifact.artifactHash, persisted);
      continue;
    }
    if (candidate.priorStatus !== persisted.priorStatus)
      throw new Error("Conflicting durable project-change prior status");
    if (
      candidate.confirmation !== undefined &&
      persisted.confirmation !== undefined &&
      candidate.confirmation.artifact.artifactHash !== persisted.confirmation.artifact.artifactHash
    )
      throw new Error("Conflicting durable project-change confirmation");
    if (candidate.confirmation === undefined && persisted.confirmation !== undefined)
      byArtifact.set(persisted.artifact.artifactHash, {
        ...candidate,
        confirmation: persisted.confirmation,
      });
  }
  const projectChanges = [
    ...bundle.projectChanges.map((change) => byArtifact.get(change.artifact.artifactHash)!),
    ...current.projectChanges
      .filter(
        (change) =>
          !bundle.projectChanges.some(
            (candidate) => candidate.artifact.artifactHash === change.artifact.artifactHash,
          ),
      )
      .map((change) => byArtifact.get(change.artifact.artifactHash)!),
  ];
  return projectChanges.length === bundle.projectChanges.length &&
    projectChanges.every((change, index) => change === bundle.projectChanges[index])
    ? bundle
    : { ...bundle, projectChanges };
}

/** Preserve append-only dirty evidence through concurrent local continuations. */
class CreatorSessionBundleStore extends Map<string, CreatorSessionBundle> {
  override set(key: string, bundle: CreatorSessionBundle): this {
    return super.set(key, mergeCreatorProjectChangeEdges(bundle, this.get(key)));
  }
}

/**
 * A confirmed transaction-bound project change revokes authority. A dirty
 * notice is only advisory until a complete read-only index proves drift (or
 * the confirmation itself is incomplete). Long-running Apply work retains
 * this error instead of writing a stale local bundle over that boundary.
 */
class ProjectAuthorityRevokedError extends Error {
  constructor(readonly lease: ProjectAuthorityLease) {
    super(`Project authority was revoked for ${lease.projectId}`);
    this.name = "ProjectAuthorityRevokedError";
  }
}

type CreatorPreRecordingPhase =
  | "source_transfer"
  | "prepare_transport"
  | "preflight_transport"
  | "preflight_evidence_persistence"
  | "durable_intent";

class CreatorPreRecordingFailure extends Error {
  constructor(
    readonly phase: CreatorPreRecordingPhase,
    readonly diagnosticCode: string,
    detailValue: string,
  ) {
    super(detailValue);
    this.name = "CreatorPreRecordingFailure";
  }
}

/** Server-produced, bounded source-edit evidence for the authenticated UI. */
export interface CreatorExactSourceDiffPage {
  readonly kind: "CreatorExactSourceDiffPage";
  readonly sessionId: string;
  readonly sourceIndex: {
    readonly id: string;
    readonly hash: string;
    readonly snapshotHash: string;
  };
  readonly changeSet: { readonly id: string; readonly hash: string };
  readonly operation: {
    readonly id: string;
    readonly document: StudioSourceIndex["documents"][number];
    readonly beforeSourceHash: string;
    readonly finalSourceHash: string;
    readonly finalByteCount: number;
  };
  readonly edit: {
    readonly ordinal: number;
    readonly editCount: number;
    readonly before: {
      readonly totalUtf8Bytes: number;
      readonly range: { readonly startByte: number; readonly endByte: number };
      readonly source: string;
    };
    readonly replacement: {
      readonly sourceHash: string;
      readonly totalUtf8Bytes: number;
      readonly range: { readonly startByte: number; readonly endByte: number };
      readonly source: string;
    };
  };
  readonly nextCursor?: string;
}

export class CreatorSessionCoordinator {
  private readonly bundles = new CreatorSessionBundleStore();
  /** Per-session durable writes must not race through independent async paths. */
  private readonly bundlePersistQueues = new Map<string, Promise<void>>();
  /** Monotonic project-level invalidation epoch for all Apply authority. */
  private readonly projectAuthorityEpochs = new Map<string, number>();
  /** Last accepted advisory monitor epoch for one project/connector epoch. */
  private readonly projectChangeDetectorEpochs = new Map<string, number>();
  /**
   * Dirty receipts that arrived while a transaction might own a recording.
   * They are a barrier to verification/finalization, not a revision verdict.
   */
  private readonly pendingTransactionProjectChanges = new Map<
    string,
    PendingTransactionProjectChange[]
  >();
  /** Receipts admitted by bridge ingress but not yet durably bound as artifacts. */
  private readonly pendingTransactionProjectChangeIngress = new Map<string, Set<string>>();
  private readonly scheduledTransactionProjectConfirmations = new Set<string>();
  /**
   * A confirmation worker can discover that the session lock is currently
   * owned by Apply, verification, or finalization.  The lock owner records a
   * release edge here, so the worker can wait for that edge rather than polling
   * the lock with an unbounded sequence of immediates.
   */
  private readonly transactionProjectConfirmationRequestedAfterLockRelease = new Set<string>();
  /**
   * Once Studio has finalized a recording, the final capture—not the earlier
   * provisional capture—is the only valid baseline for a dirty confirmation.
   * Keep it in memory until the transaction has reached its durable terminal
   * edge; it is always already retained in the immutable project-index graph.
   */
  private readonly finalizedTransactionProjectChangeCaptures = new Map<
    string,
    StudioProjectIndexCapture
  >();
  private readonly projectCaptures = new Map<string, StudioProjectIndexCapture>();
  private readonly pendingRecordings = new Map<
    string,
    {
      recordingId: string;
      beforeIndexRevisionHash: string;
      afterIndexRevisionHash: string;
      projection: StudioEvidenceProjection;
      preflightProjection: StudioEvidenceProjection;
      changeSetEvidence: CreatorMutationChangeSetLike;
      attemptId: string;
      beforeIndexCapture: StudioProjectIndexCapture;
      preflight: StudioEvidenceEnvelope;
      directReadback: StudioEvidenceEnvelope;
      afterIndexCapture: StudioProjectIndexCapture;
      afterProjectDetectorEpoch: number;
      reconciliation: CreatorMutationReconciliation;
    }
  >();
  private readonly inFlight = new Set<string>();
  private readonly automaticVerifications = new Set<string>();
  /** One creator-job-owned repair reservation retained across passive Play. */
  private readonly pendingRepairExecutions = new Map<string, AgentExecutionSlot>();
  private readonly views = new Map<string, CreatorTransactionControlView>();
  private readonly viewPublicationEpochs = new Map<string, number>();
  private readonly consumedViewHashes = new Set<string>();
  private readonly listeners = new Set<() => void>();
  /**
   * Presentation and deferred-delivery faults are operational diagnostics,
   * not Studio observations or transaction verdicts.  Keep them out of the
   * immutable mutation graph while still exposing them to the local control
   * plane on the next read.
   */
  private readonly deferredTaskFailures = new Map<string, string>();
  private lastPublicationListenerFailure?: string;
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
      recordingState: "open" | "not_open" | "unknown" | "finalizing";
      recordingId: string;
      projectIndexCapture: StudioProjectIndexCapture;
      projectIndexArtifact: ArtifactReference;
      projectDetectorEpoch: number;
      replacesAction?: "commit" | "cancel";
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
      beforeProjectIndexManifestId: string;
      beforeProjectRevisionHash: string;
      beforeProjectDetectorEpoch: number;
      recordingId: string;
      recoveryProjectIndexManifestId: string;
      recoveryProjectRevisionHash: string;
      recoveryProjectDetectorEpoch: number;
      recoveryRecordArtifact: ArtifactReference;
      bundleId?: string;
    }
  >();
  private readonly pendingFinalizationAcknowledgements = new Map<
    string,
    PendingFinalizationAcknowledgement
  >();
  /**
   * Request ids whose finalization receipts still have a live, local owner.
   *
   * The global plugin-message handler retains every receipt. It may only defer
   * recovery/acknowledgement while one of these exact waiters is alive; a
   * requestId by itself is not proof that anyone is still waiting for it.
   */
  private readonly activeFinalizationRequests = new Set<string>();
  private readonly pluginMessageFailures = new Map<
    string,
    { readonly messageId: string; readonly detail: string }
  >();
  private readonly pluginMessageQueues = new Map<string, Promise<void>>();
  private readonly unsolicitedProjectIndexStreams = new Map<
    string,
    StudioProjectIndexStreamRouter
  >();
  private readonly observingCreatorPlay = new Set<string>();
  private pairedSession?: StudioBridgeSession;
  private unsubscribe: () => void;
  private readonly artifactStore: ImmutableJsonArtifactStore;

  constructor(
    private readonly input: {
      connection: StudioBridgeConnection;
      worker: CreatorAgentWorker;
      directory: string;
      sourceAnalysisHost: CreatorSourceAnalysisHost;
      timeoutMs?: number;
      projectAuthority?: ProjectAuthorityHostContext;
    },
  ) {
    if (input.projectAuthority !== undefined)
      assertProjectAuthorityHostContext(input.projectAuthority);
    this.artifactStore = new ImmutableJsonArtifactStore(resolve(input.directory));
    this.unsubscribe = input.connection.subscribeWithSession((message, session) => {
      // Project-index fragments are consumed by a stream receiver before the
      // bridge acknowledges their POST. Unsolicited pairing/recovery streams
      // are cached globally; request-scoped streams have their own transaction
      // receiver. Keep semantic handling inside the bridge's durable ingress
      // acknowledgement: if persistence fails, the exact plugin message must
      // remain retryable rather than being marked complete prematurely.
      if (isStudioProjectIndexStreamMessage(message)) {
        if (message.requestId === undefined)
          this.observeUnsolicitedProjectIndexMessage(message, session);
        return;
      }
      return this.enqueuePluginMessage(message, session);
    });
  }

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.unsolicitedProjectIndexStreams.clear();
    this.finalizedTransactionProjectChangeCaptures.clear();
    this.transactionProjectConfirmationRequestedAfterLockRelease.clear();
    this.bundlePersistQueues.clear();
    this.pendingRepairExecutions.clear();
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
      const sessions = (this.input.connection.getSessions as () => StudioBridgeSession[])();
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
      for (const binding of bundle.projectIndices) {
        const capture = await readCreatorProjectIndexArtifacts(this.artifactStore, binding);
        this.cacheProjectCapture(capture);
      }
      const recoveredSettledBundle = await this.recoverPersistedSettledBundleAfterRestart(bundle);
      if (recoveredSettledBundle) {
        bundle = recoveredSettledBundle;
        await this.persist(bundle);
      } else if (
        ["awaiting_plan_approval", "awaiting_change_approval", "awaiting_review"].includes(
          bundle.session.status,
        )
      ) {
        const binding = bundle.projectIndices.at(-1);
        if (!binding)
          throw new Error(
            `Resumable creator session has no complete project index: ${bundle.session.id}`,
          );
        const capture = await readCreatorProjectIndexArtifacts(this.artifactStore, binding);
        const notice = createCreatorRestartChangeNotice({
          projectId: bundle.session.projectId,
          connectorEpoch: capture.revision.connectorEpoch,
        });
        const artifact = await this.artifactStore.write(notice);
        const priorStatus = bundle.session.status;
        bundle = {
          ...bundle,
          projectChanges: [...bundle.projectChanges, { notice, artifact, priorStatus }],
          session: advanceSession(bundle.session, {
            status: "refresh_required",
          }),
        };
        await this.persist(bundle);
      } else if (
        [
          "indexing",
          "planning",
          "refining_plan",
          "building",
          "repairing",
          "refreshing",
          "preflighting",
        ].includes(bundle.session.status)
      ) {
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
        [
          "applying",
          "awaiting_verification",
          "verifying",
          "awaiting_verification_retry",
          "cancelling",
          "committing",
        ].includes(bundle.session.status)
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
      await this.rehydrateTransactionProjectChangeBarriers(bundle);
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

  /**
   * A process restart must not erase a transaction-bound dirty barrier. The
   * notice artifacts are append-only bundle edges, so rebuild their ingress
   * ordering fence and pending confirmation queue before accepting any
   * recovered recording/finalization receipt. No Studio command is sent here.
   */
  private async rehydrateTransactionProjectChangeBarriers(
    bundle: CreatorSessionBundle,
  ): Promise<void> {
    for (const entry of bundle.projectChanges) {
      const key = this.projectChangeEpochKey(entry.notice.projectId, entry.notice.connectorEpoch);
      this.projectChangeDetectorEpochs.set(
        key,
        Math.max(this.projectChangeDetectorEpochs.get(key) ?? 0, entry.notice.detectorEpoch),
      );
    }
    const transactionStatuses: readonly CreatorSessionStatus[] = [
      "applying",
      "awaiting_verification",
      "verifying",
      "awaiting_verification_retry",
      "cancelling",
      "committing",
      "recovery_required",
    ];
    const unresolved = bundle.projectChanges.filter(
      (entry) =>
        entry.confirmation === undefined && transactionStatuses.includes(entry.priorStatus),
    );
    if (unresolved.length === 0) return;
    for (const entry of unresolved)
      this.bindPendingTransactionProjectChange(bundle.session.id, {
        notice: entry.notice,
        artifact: entry.artifact,
      });
    const active = bundle.activeMutation;
    let baselineBinding:
      import("./mutation-evidence.js").CreatorMutationArtifactIndexCapture | undefined =
      active?.finalIndexCapture ?? active?.afterIndexCapture;
    if (!baselineBinding) {
      const settled = [...bundle.mutationAttempts]
        .reverse()
        .find((attempt) => attempt.completion === "settled" || attempt.phase === "apply");
      if (settled?.completion === "settled") baselineBinding = settled.finalIndexCapture;
      else if (settled?.completion === "incomplete" && settled.phase === "apply")
        baselineBinding = settled.finalIndexCapture;
    }
    // A dirty hint can be durable before the transaction's post-Apply or
    // recovery capture exists. Preserve the barrier, but do not fabricate an
    // incomplete comparison against the pre-Apply state. Pairing recovery will
    // install the first legitimate baseline and schedule the read-only check.
    if (!baselineBinding) return;
    const baseline = await readCreatorProjectIndexArtifacts(this.artifactStore, baselineBinding);
    this.cacheProjectCapture(baseline);
    if (active?.finalIndexCapture || !active)
      this.finalizedTransactionProjectChangeCaptures.set(bundle.session.id, baseline);
  }

  /**
   * A process can stop after the immutable mutation attempt is persisted but
   * before the session tail is advanced. Reconstruct only that already-proven
   * local metadata; never repeat or infer a Studio operation.
   */
  private async recoverPersistedSettledBundleAfterRestart(
    bundle: CreatorSessionBundle,
  ): Promise<CreatorSessionBundle | undefined> {
    if (
      !["applying", "awaiting_verification", "verifying", "cancelling", "committing"].includes(
        bundle.session.status,
      )
    )
      return undefined;
    const attempt = [...bundle.mutationAttempts]
      .reverse()
      .find(
        (candidate): candidate is CreatorSettledMutationAttempt =>
          candidate.completion === "settled" && candidate.sessionId === bundle.session.id,
      );
    if (!attempt) return undefined;
    const replay = await replayCreatorMutation(attempt, this.artifactStore);
    if (replay.result !== "exact_match") return undefined;
    const [finalization, finalIndexCapture] = await Promise.all([
      this.artifactStore.read(attempt.finalization.artifact, assertCreatorMutationFinalization),
      readCreatorProjectIndexArtifacts(this.artifactStore, attempt.finalIndexCapture),
    ]);
    if (
      finalization.hash !== attempt.finalization.hash ||
      finalization.sessionId !== bundle.session.id ||
      finalization.changeSetHash !== attempt.changeSet.hash ||
      finalization.projectionHash !== attempt.projection.hash ||
      finalization.finalIndexCaptureHash !== finalIndexCapture.hash ||
      finalization.finalIndexRevisionHash !== finalIndexCapture.revision.hash ||
      attempt.finalIndexCapture.captureHash !== finalIndexCapture.hash
    )
      return undefined;
    const state = projectIndexViewForCreator(studioProjectIndexMetadataView(finalIndexCapture));
    const { activeMutation: _activeMutation, ...settledBundle } = bundle;
    if (finalization.action === "commit" && finalization.status === "committed") {
      const verification = bundle.verifications.find(
        (candidate) =>
          candidate.status === "passed" &&
          candidate.mutationAttempt.id === attempt.id &&
          candidate.mutationAttempt.hash === attempt.hash,
      );
      if (verification) {
        const changeSet = requiredChangeSet(bundle);
        const checkpoint =
          bundle.checkpoint ??
          createCheckpoint(
            bundle.session.id,
            changeSet,
            {
              beforeIndexRevisionHash: finalization.beforeIndexRevisionHash,
              afterIndexRevisionHash: finalization.finalIndexRevisionHash,
            },
            finalization.finalIndexRevisionHash,
            attempt,
          );
        return recordObservation(
          {
            ...settledBundle,
            checkpoint,
            session: advanceSession(bundle.session, {
              status: "awaiting_review",
              checkpoint,
              projectCapture: {
                captureHash: finalIndexCapture.hash,
                revisionHash: finalIndexCapture.revision.hash,
              },
            }),
          },
          finalIndexCapture.revision.hash,
          state,
        );
      }
    }
    return recordObservation(
      {
        ...settledBundle,
        session: advanceSession(bundle.session, {
          status: "incomplete",
          projectCapture: {
            captureHash: finalIndexCapture.hash,
            revisionHash: finalIndexCapture.revision.hash,
          },
          failure: {
            code:
              finalization.action === "commit"
                ? "commit_without_persisted_verification"
                : "control_process_interrupted",
            detail:
              finalization.action === "commit"
                ? "Studio commit was durably persisted, but no exact passed verification was available to resume creator review."
                : "Studio cancellation and its final state were durably persisted before the control process stopped. No provider work was resumed.",
          },
        }),
      },
      finalIndexCapture.revision.hash,
      state,
    );
  }

  async dashboardState(sessionId?: string): Promise<CreatorTransactionState> {
    const bundles = [...this.bundles.values()].sort((left, right) =>
      right.session.updatedAt.localeCompare(left.session.updatedAt),
    );
    const selected = sessionId ? await this.bundle(sessionId) : bundles[0];
    const sessions = await Promise.all(
      bundles.map(async (bundle) => ({
        id: bundle.session.id,
        hash: bundle.session.hash,
        projectId: bundle.session.projectId,
        prompt: await this.creatorPrompt(bundle),
        promptHash: bundle.session.promptHash,
        status: bundle.session.status,
        createdAt: bundle.session.createdAt,
        updatedAt: bundle.session.updatedAt,
        latestVerificationStatus: bundle.verifications.at(-1)?.status ?? ("not_run" as const),
        ...(bundle.session.failure ? { failure: { ...bundle.session.failure } } : {}),
      })),
    );
    const studio = this.pairedStudio();
    const recordingScan = studio ? this.recordingScans.get(studio.sessionId) : undefined;
    const inventoryStatus = !studio
      ? ("unavailable" as const)
      : [...this.pendingFinalizationAcknowledgements.values()].some(
            (pending) => pending.studioSessionId === studio.sessionId,
          ) || recordingScan?.status === "blocked"
        ? ("blocked" as const)
        : recordingScan?.status === "clear"
          ? ("clear" as const)
          : ("pending" as const);
    const pluginMessageFailure = studio
      ? this.pluginMessageFailures.get(studio.sessionId)?.detail
      : undefined;
    const deferredTaskFailure = selected
      ? this.deferredTaskFailures.get(selected.session.id)
      : this.lastPublicationListenerFailure;
    const attestation = studio ? this.attestations.get(studio.sessionId) : undefined;
    const cachedView = selected ? this.views.get(selected.session.id) : undefined;
    const selectedView = selected
      ? cachedView?.creatorSessionHash === selected.session.hash
        ? cachedView
        : await this.view(selected, restoredCreatorControlDetail(selected))
      : undefined;
    if (
      selected &&
      selectedView &&
      this.bundles.get(selected.session.id)?.session.hash === selected.session.hash
    )
      this.views.set(selected.session.id, selectedView);
    return {
      kind: "CreatorTransactionState",
      ...(selected ? { selectedSessionId: selected.session.id } : {}),
      sessions,
      ...(selectedView ? { controlView: selectedView } : {}),
      stages: creatorProgress(
        selected?.session,
        selected ? this.observingCreatorPlay.has(selected.session.id) : false,
      ),
      pairedStudio: studio
        ? {
            status: "paired",
            projectId: studio.projectId,
            projectName: studio.project.name,
            capabilities: [...studio.capabilities],
            manifestHash: studio.manifestHash,
            connectorBuildHash: studio.connectorBuildHash,
            transactionInventoryStatus: inventoryStatus,
            attestationStatus: attestation?.status ?? "pending",
            ...(attestation?.envelope.contentHash
              ? {
                  attestationHash: attestation.envelope.contentHash,
                  attestationArtifact: attestation.artifact,
                  attestation: attestationSummary(attestation.grade),
                }
              : {}),
            message: pluginMessageFailure
              ? pluginMessageFailure
              : deferredTaskFailure
                ? deferredTaskFailure
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
            transactionInventoryStatus: inventoryStatus,
            message: "Open the Forge connector in Studio to pair this dashboard.",
          },
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * Read-only bridge for the durable conversation layer. The transaction
   * bundle remains the authoritative lower-level evidence; callers receive a
   * clone so presentation code cannot mutate coordinator state.
   */
  async conversationSnapshot(sessionId: string): Promise<{
    readonly bundle: CreatorSessionBundle;
    readonly prompt: string;
  }> {
    const bundle = await this.bundle(sessionId);
    return { bundle: structuredClone(bundle), prompt: await this.creatorPrompt(bundle) };
  }

  /**
   * Refinement and clarification revoke the prior candidate before another
   * provider turn can start. No plan approval or Studio authority crosses
   * this boundary.
   */
  async supersedeConversationCandidate(sessionId: string): Promise<void> {
    const bundle = await this.bundle(sessionId);
    await this.lock(bundle.session.id, async () => {
      const live = await this.bundle(sessionId);
      if (!["awaiting_clarification", "awaiting_plan_approval"].includes(live.session.status))
        throw new Error("The current creator candidate cannot be refined");
      const refining = {
        ...live,
        session: advanceSession(live.session, { status: "refining_plan" }),
      };
      const superseded = {
        ...refining,
        session: advanceSession(refining.session, { status: "superseded" }),
      };
      this.bundles.set(sessionId, superseded);
      await this.persist(superseded);
      await this.publishView(
        superseded,
        "This candidate was superseded for explicit conversational refinement. No approval or Studio authority was inherited.",
      );
    });
  }

  /**
   * Close an interrupted pre-mutation agent transaction before an explicitly
   * authorized conversation retry starts another provider request. This is a
   * host-state finalization only: it cannot apply, commit, cancel, or otherwise
   * touch Studio. A persisted agent outcome must be recovered instead.
   */
  async abandonInterruptedConversationCandidate(sessionId: string): Promise<void> {
    if (!this.bundles.has(sessionId)) return;
    await this.lock(sessionId, async () => {
      const live = await this.bundle(sessionId);
      if (isTerminalStatus(live.session.status)) return;
      if (
        !["indexing", "planning", "refining_plan"].includes(live.session.status) ||
        live.agentOutcome !== undefined ||
        live.activeMutation !== undefined ||
        live.session.planApproval !== undefined ||
        live.session.changeSet !== undefined ||
        live.session.changeApproval !== undefined
      )
        throw new Error(
          "Interrupted creator work has a deterministic or Studio-affecting boundary and cannot be abandoned as an unknown provider attempt",
        );
      const incomplete = {
        ...live,
        session: advanceSession(live.session, {
          status: "incomplete",
          failure: {
            code: "provider_retry_authorized",
            detail:
              "The creator explicitly authorized a new request after the prior pre-mutation provider outcome could not be confirmed.",
          },
        }),
      };
      this.bundles.set(sessionId, incomplete);
      await this.persist(incomplete);
      await this.publishView(
        incomplete,
        "The interrupted pre-mutation provider attempt was closed without any Studio effect. A separate creator-authorized retry may now begin.",
      );
    });
  }

  async sourceDocuments(
    sessionId: string,
    sourceIndexHash: string,
    input: { limit?: number; cursor?: string },
  ): Promise<unknown> {
    return listStudioSourceDocuments(
      await this.sealedSourceIndex(sessionId, sourceIndexHash),
      input,
    );
  }

  private connectorEpoch(session: StudioBridgeSession): string {
    return createStudioConnectorEpoch({
      sessionId: session.sessionId,
      projectId: session.projectId,
      connectorBuildHash: session.connectorBuildHash,
    });
  }

  /**
   * A semantic revision deliberately excludes observation order. Transaction
   * authority does not: the manifest and detector epoch identify the exact
   * complete capture that fenced a command. Never cache or recover one by a
   * revision hash alone.
   */
  private projectCaptureKey(
    manifestId: string,
    revisionHash: string,
    detectorEpoch: number,
  ): string {
    return stableJson({ manifestId, revisionHash, detectorEpoch });
  }

  private cacheProjectCapture(capture: StudioProjectIndexCapture): void {
    assertStudioProjectIndexCapture(capture);
    this.projectCaptures.set(
      this.projectCaptureKey(
        capture.indexManifest.id,
        capture.revision.hash,
        capture.detectorEpoch,
      ),
      capture,
    );
  }

  private cachedProjectCapture(
    manifestId: string,
    revisionHash: string,
    detectorEpoch: number,
  ): StudioProjectIndexCapture | undefined {
    return this.projectCaptures.get(
      this.projectCaptureKey(manifestId, revisionHash, detectorEpoch),
    );
  }

  private observeUnsolicitedProjectIndexMessage(
    message: PluginToBackendMessage,
    session: StudioBridgeSession,
  ): void {
    let router = this.unsolicitedProjectIndexStreams.get(session.sessionId);
    if (!router) {
      router = new StudioProjectIndexStreamRouter();
      this.unsolicitedProjectIndexStreams.set(session.sessionId, router);
    }
    if (!router.observe(message))
      throw new Error("Unsolicited project-index router rejected a stream message");
    const capture = router.takeCompleted();
    if (!capture) return;
    if (stableJson(capture.indexManifest.project) !== stableJson(session.project))
      throw new Error("Unsolicited Studio project index belongs to another paired project");
    if (capture.revision.connectorEpoch !== this.connectorEpoch(session))
      throw new Error("Unsolicited Studio project index belongs to a stale connector epoch");
    this.cacheProjectCapture(capture);
  }

  private async collectProjectIndex(
    session: StudioBridgeSession,
    authority?: ProjectAuthorityLease,
  ): Promise<StudioProjectIndexCapture> {
    const capture = await this.awaitProjectAuthority(
      authority,
      requestStudioProjectIndex({
        connection: this.input.connection,
        session,
        connectorEpoch: this.connectorEpoch(session),
        timeoutMs: this.timeout(),
      }),
    );
    const binding = stableJson(capture.indexManifest.project);
    if (binding !== stableJson(session.project))
      throw new Error("Studio project index belongs to a different paired project");
    if (capture.revision.connectorEpoch !== this.connectorEpoch(session))
      throw new Error("Studio project index belongs to a stale connector epoch");
    this.assertProjectAuthority(authority);
    this.cacheProjectCapture(capture);
    return capture;
  }

  private async persistProjectIndex(
    capture: StudioProjectIndexCapture,
  ): Promise<CreatorProjectIndexArtifactBinding> {
    return writeCreatorProjectIndexArtifacts(this.artifactStore, capture);
  }

  private async persistRojoAuthorityMap(
    projectId: string,
    capture: StudioProjectIndexCapture,
  ): Promise<{
    readonly binding: NonNullable<CreatorSessionBundle["projectAuthority"]>;
    readonly authorityMap: ProjectAuthorityMap;
  }> {
    const context = this.input.projectAuthority;
    if (!context?.manifest.rojo || !context.rojo)
      throw new Error("Rojo source authority requires a verified host sourcemap context");
    const authorityMap = await createProjectAuthorityMap({
      projectId,
      studioRevisionHash: capture.revision.hash,
      manifest: context.manifest,
      workspaceRoot: context.workspaceRoot,
      rojo: { sourcemap: context.rojo.sourcemap },
    });
    assertRojoInitialStudioParity(capture, authorityMap);
    const artifact = await this.artifactStore.write(authorityMap);
    return {
      binding: {
        authorityMap: {
          id: authorityMap.id,
          hash: authorityMap.hash,
          artifact,
        },
      },
      authorityMap,
    };
  }

  private async rojoAuthorityMap(bundle: CreatorSessionBundle): Promise<ProjectAuthorityMap> {
    if (!bundle.ownership.availableAuthorities.includes("rojo_source") || !bundle.projectAuthority)
      throw new Error("Creator session has no Rojo source-authority binding");
    const authorityMap = await this.artifactStore.read(
      bundle.projectAuthority.authorityMap.artifact,
      assertProjectAuthorityMap,
    );
    if (
      authorityMap.id !== bundle.projectAuthority.authorityMap.id ||
      authorityMap.hash !== bundle.projectAuthority.authorityMap.hash ||
      authorityMap.projectId !== bundle.session.projectId
    )
      throw new Error("Rojo source-authority map binding mismatch");
    return authorityMap;
  }

  private async projectIndexCaptureBinding(
    capture: StudioProjectIndexCapture,
  ): Promise<import("./mutation-evidence.js").CreatorMutationArtifactIndexCapture> {
    return writeCreatorProjectIndexArtifacts(this.artifactStore, capture);
  }

  private async retainProjectIndex(
    bundle: CreatorSessionBundle,
    capture: StudioProjectIndexCapture,
    authority?: ProjectAuthorityLease,
  ): Promise<CreatorSessionBundle> {
    this.assertProjectAuthority(authority);
    const existing = bundle.projectIndices.some((binding) => binding.captureHash === capture.hash);
    if (existing) return bundle;
    const binding = await this.awaitProjectAuthority(authority, this.persistProjectIndex(capture));
    const next = this.mergeConcurrentProjectChanges({
      ...bundle,
      projectIndices: [...bundle.projectIndices, binding],
    });
    this.assertProjectAuthority(authority);
    this.cacheProjectCapture(capture);
    this.bundles.set(next.session.id, next);
    await this.awaitProjectAuthority(authority, this.persist(next));
    return next;
  }

  /** Persist every raw source body before its binding reaches an approval or
   * Studio transport boundary.  A replay later reads these immutable leaves,
   * not process memory or a model payload. */
  private async retainSourceWriteBlobs(
    bundle: CreatorSessionBundle,
    captures: readonly import("./index.js").CreatorSourceWriteBlobCapture[],
  ): Promise<CreatorSessionBundle> {
    const existing = new Set(bundle.sourceWriteBlobs.map((binding) => binding.manifest.hash));
    const appended = [] as CreatorSessionBundle["sourceWriteBlobs"];
    for (const capture of captures) {
      if (existing.has(capture.manifest.hash)) continue;
      appended.push(await writeCreatorSourceWriteArtifacts(this.artifactStore, capture));
      existing.add(capture.manifest.hash);
    }
    return appended.length === 0
      ? bundle
      : {
          ...bundle,
          sourceWriteBlobs: [...bundle.sourceWriteBlobs, ...appended],
        };
  }

  private async sourceWriteCaptures(
    bundle: CreatorSessionBundle,
    changeSet: CreatorChangeSet,
  ): Promise<readonly import("./index.js").CreatorSourceWriteBlobCapture[]> {
    const retained = new Map(
      bundle.sourceWriteBlobs.map((binding) => [binding.manifest.hash, binding]),
    );
    return Promise.all(
      changeSet.sourceWriteBlobs.map(async (sourceWrite) => {
        const artifact = retained.get(sourceWrite.manifestHash);
        if (
          artifact === undefined ||
          artifact.manifest.id !== sourceWrite.manifestId ||
          artifact.manifest.hash !== sourceWrite.manifestHash
        )
          throw new Error("Approved source write has no immutable artifact graph");
        const capture = await readCreatorSourceWriteArtifacts(this.artifactStore, artifact);
        if (
          capture.manifest.sourceHash !== sourceWrite.sourceHash ||
          capture.manifest.utf8Bytes !== sourceWrite.utf8Bytes
        )
          throw new Error(
            "Approved source-write artifact graph does not match its change-set binding",
          );
        return capture;
      }),
    );
  }

  private async streamSourceWriteCapture(
    studio: StudioBridgeSession,
    requestId: string,
    capture: import("./index.js").CreatorSourceWriteBlobCapture,
    messages: PluginToBackendMessage[],
    authority?: ProjectAuthorityLease,
  ): Promise<void> {
    const fragmentBytes = BACKEND_COMMAND_FRAGMENT_BYTES;
    const pieceCount = capture.chunks.reduce(
      (count, chunk) => count + countCanonicalJsonFragments(stableJson(chunk), fragmentBytes),
      0,
    );
    this.assertProjectAuthority(authority);
    await this.awaitProjectAuthority(
      authority,
      this.input.connection.sendAndWaitForSettlement(
        createBackendMessage(
          "CreatorSourceWriteBlobStarted",
          {
            requestId,
            manifest: capture.manifest,
            pieceCount,
          },
          studio.sessionId,
          requestId,
        ),
        this.timeout(),
      ),
    );
    let sequence = 0;
    for (const chunk of capture.chunks) {
      const fragments = fragmentCanonicalJson(stableJson(chunk), fragmentBytes);
      for (let ordinal = 0; ordinal < fragments.length; ordinal += 1) {
        const payload = fragments[ordinal]!;
        this.assertProjectAuthority(authority);
        await this.awaitProjectAuthority(
          authority,
          this.input.connection.sendAndWaitForSettlement(
            createBackendMessage(
              "CreatorSourceWriteBlobChunk",
              {
                requestId,
                manifestId: capture.manifest.id,
                sequence,
                artifact: {
                  kind: "CreatorSourceWriteBlobChunk",
                  id: chunk.id,
                  hash: chunk.hash,
                },
                fragmentOrdinal: ordinal,
                fragmentCount: fragments.length,
                encoding: "json",
                payload,
                payloadHash: contentHash(payload),
              },
              studio.sessionId,
              requestId,
            ),
            this.timeout(),
          ),
        );
        sequence += 1;
      }
    }
    this.assertProjectAuthority(authority);
    await this.awaitProjectAuthority(
      authority,
      this.input.connection.sendAndWaitForSettlement(
        createBackendMessage(
          "CreatorSourceWriteBlobCompleted",
          {
            requestId,
            manifestId: capture.manifest.id,
            manifestHash: capture.manifest.hash,
            sourceHash: capture.manifest.sourceHash,
            utf8Bytes: capture.manifest.utf8Bytes,
            pieceCount,
          },
          studio.sessionId,
          requestId,
        ),
        this.timeout(),
      ),
    );
    await this.awaitProjectAuthority(
      authority,
      waitFor(
        messages,
        (
          message,
        ): message is Extract<PluginToBackendMessage, { type: "CreatorSourceWriteBlobAccepted" }> =>
          message.type === "CreatorSourceWriteBlobAccepted" &&
          message.requestId === requestId &&
          message.payload.manifestId === capture.manifest.id &&
          message.payload.manifestHash === capture.manifest.hash &&
          message.payload.sourceHash === capture.manifest.sourceHash &&
          message.payload.utf8Bytes === capture.manifest.utf8Bytes &&
          message.payload.status === "accepted",
        this.timeout(),
        "creator source-write blob acknowledgement",
        requestId,
      ),
    );
  }

  private async streamCreatorChangePrepare(
    studio: StudioBridgeSession,
    document: CreatorChangePrepareDocument,
    authority?: ProjectAuthorityLease,
  ): Promise<void> {
    const transfer = createCreatorChangePrepareTransfer(document);
    const boundary = {
      requestId: document.requestId,
      transferId: transfer.transferId,
      documentHash: transfer.documentHash,
      utf8Bytes: transfer.utf8Bytes,
      pieceCount: transfer.fragments.length,
    };
    this.assertProjectAuthority(authority);
    await this.awaitProjectAuthority(
      authority,
      this.input.connection.sendAndWaitForSettlement(
        createBackendMessage(
          "CreatorChangePrepareStarted",
          boundary,
          studio.sessionId,
          document.requestId,
        ),
        this.timeout(),
      ),
    );
    for (const fragment of transfer.fragments) {
      this.assertProjectAuthority(authority);
      await this.awaitProjectAuthority(
        authority,
        this.input.connection.sendAndWaitForSettlement(
          createBackendMessage(
            "CreatorChangePrepareChunk",
            {
              requestId: document.requestId,
              transferId: transfer.transferId,
              documentHash: transfer.documentHash,
              sequence: fragment.sequence,
              encoding: "json",
              payload: fragment.payload,
              payloadHash: fragment.payloadHash,
            },
            studio.sessionId,
            document.requestId,
          ),
          this.timeout(),
        ),
      );
    }
    this.assertProjectAuthority(authority);
    await this.awaitProjectAuthority(
      authority,
      this.input.connection.sendAndWaitForSettlement(
        createBackendMessage(
          "CreatorChangePrepareCompleted",
          boundary,
          studio.sessionId,
          document.requestId,
        ),
        this.timeout(),
      ),
    );
  }

  private async waitForTransactionProjectIndex(
    messages: PluginToBackendMessage[],
    requestId: string,
    manifestId: string,
    revisionHash: string,
    detectorEpoch: number,
    label: string,
    streams?: StudioProjectIndexStreamRouter,
  ): Promise<StudioProjectIndexCapture> {
    if (streams)
      return streams.wait({
        requestId,
        manifestId,
        revisionHash,
        detectorEpoch,
        timeoutMs: this.timeout(),
        label,
      });
    return waitForStudioProjectIndexCapture({
      messages,
      requestId,
      manifestId,
      revisionHash,
      detectorEpoch,
      timeoutMs: this.timeout(),
      label,
    });
  }

  private resolveProjectIndexBinding(
    manifestId: string,
    revisionHash: string,
    detectorEpoch: number,
  ): StudioProjectIndexCapture {
    const cached = this.cachedProjectCapture(manifestId, revisionHash, detectorEpoch);
    if (!cached)
      throw new Error(
        "Exact retained transaction project index was not received before its recovery receipt",
      );
    return cached;
  }

  private async captureForBundle(bundle: CreatorSessionBundle): Promise<StudioProjectIndexCapture> {
    const binding = bundle.projectIndices.find(
      (entry) => entry.captureHash === bundle.session.currentProjectCaptureHash,
    );
    if (!binding)
      throw new Error("Creator session has no project index for its current capture binding");
    const cached = this.cachedProjectCapture(
      binding.manifest.id,
      binding.revision.hash,
      binding.detectorEpoch,
    );
    if (cached) return cached;
    const capture = await readCreatorProjectIndexArtifacts(this.artifactStore, binding);
    this.cacheProjectCapture(capture);
    return capture;
  }

  /**
   * Change-set review is a statement about the topology that existed before
   * its transaction.  In particular, a `create` target is deliberately
   * absent from that baseline and will be present in the current project
   * index after provisional Apply.  Rendering the approved change against
   * that later index would reinterpret a successful create as a duplicate
   * create and, worse, let a presentation fault affect an open recording.
   *
   * Prefer the transaction's retained before-capture.  A settled attempt is
   * equally authoritative after its active cursor has been cleared.  Before
   * Apply, no transaction capture exists, so use the retained capture bound
   * to the change set's approved revision.  The current capture remains the
   * source for the separately displayed project-index status.
   */
  private async changeReviewCaptureForBundle(
    bundle: CreatorSessionBundle,
    changeSet: CreatorChangeSet,
  ): Promise<StudioProjectIndexCapture> {
    const active = bundle.activeMutation;
    if (active?.changeSetId === changeSet.id && active.changeSetHash === changeSet.hash)
      return readCreatorProjectIndexArtifacts(this.artifactStore, active.beforeIndexCapture);

    const matchingAttempt = [...bundle.mutationAttempts]
      .reverse()
      .find((attempt) => attempt.changeSet.hash === changeSet.hash);
    if (matchingAttempt)
      return readCreatorProjectIndexArtifacts(
        this.artifactStore,
        matchingAttempt.beforeIndexCapture,
      );

    const currentBinding = bundle.projectIndices.find(
      (entry) =>
        entry.captureHash === bundle.session.currentProjectCaptureHash &&
        entry.revision.hash === changeSet.expectedRevisionHash,
    );
    const revisionBinding =
      currentBinding ??
      bundle.projectIndices.find((entry) => entry.revision.hash === changeSet.expectedRevisionHash);
    if (!revisionBinding)
      throw new Error("Creator change review has no complete index bound to its approved revision");
    return readCreatorProjectIndexArtifacts(this.artifactStore, revisionBinding);
  }

  private async observationForBundle(
    bundle: CreatorSessionBundle,
  ): Promise<ReturnType<typeof projectIndexViewForCreator>> {
    const binding = bundle.projectIndices.find(
      (entry) => entry.captureHash === bundle.session.currentProjectCaptureHash,
    );
    if (!binding)
      throw new Error("Creator session has no project index for its current capture binding");
    return projectIndexViewForCreator(
      (await readCreatorProjectIndexMetadataArtifacts(this.artifactStore, binding)).view,
    );
  }

  private projectSourceMaterial(capture: StudioProjectIndexCapture): {
    documents: readonly SourceDocumentDescriptor[];
    resolver: VerifiedSourceResolver;
  } {
    const orderedDocuments = [...studioProjectIndexSourceMetadata(capture)];
    return {
      documents: orderedDocuments,
      resolver: createHashVerifiedChunkSourceResolver({
        documents: orderedDocuments,
        chunks: capture.sourceChunks.map((chunk) => ({
          sourceHash: chunk.sourceHash,
          ordinal: chunk.ordinal,
          startByte: chunk.startByte,
          endByte: chunk.endByte,
          utf8: chunk.utf8,
        })),
      }),
    };
  }

  private async analyzeProjectSources(capture: StudioProjectIndexCapture): Promise<{
    index: StudioSourceIndex;
    resolver: VerifiedSourceResolver;
    indexArtifact: ArtifactReference;
    analysis: PinnedSourceAnalysisArtifact;
    analysisArtifact: ArtifactReference;
  }> {
    const material = this.projectSourceMaterial(capture);
    const outcome = await this.input.sourceAnalysisHost.analyze({
      snapshotHash: capture.hash,
      documents: material.documents,
      resolver: material.resolver,
    });
    if (outcome.status !== "complete") throw new Error(`${outcome.code}: ${outcome.reason}`);
    assertProductionStudioSourceIndex(outcome.index);
    const [indexArtifact, analysisArtifact] = await Promise.all([
      this.artifactStore.write(outcome.index),
      this.artifactStore.write(outcome.artifact),
    ]);
    return {
      index: outcome.index,
      resolver: material.resolver,
      indexArtifact,
      analysis: outcome.artifact,
      analysisArtifact,
    };
  }

  async sourceSearch(
    sessionId: string,
    sourceIndexHash: string,
    input: {
      query: string;
      pathPrefix?: string;
      contextUtf8Bytes?: number;
      limit?: number;
      cursor?: string;
    },
  ): Promise<unknown> {
    const { index, resolver } = await this.sealedSourceMaterial(sessionId, sourceIndexHash);
    return searchStudioSourceAsync(index, resolver, input);
  }

  async sourceRead(
    sessionId: string,
    sourceIndexHash: string,
    input: { documentId: string; maximumUtf8Bytes?: number; cursor?: string },
  ): Promise<unknown> {
    const { index, resolver } = await this.sealedSourceMaterial(sessionId, sourceIndexHash);
    return readStudioSourceAsync(index, resolver, input);
  }

  /**
   * Return one bounded, immutable diff hunk from a sealed `edit_source`
   * operation. This is deliberately not a browser-computed diff: both sides
   * are read from retained artifact graphs and tied to the exact change set,
   * source index, and project revision that the operation approved.
   */
  async sourceDiff(
    sessionId: string,
    input: {
      readonly sourceIndexHash: string;
      readonly operationId: string;
      readonly changeSetId?: string;
      readonly cursor?: string;
      readonly maximumUtf8Bytes?: number;
    },
  ): Promise<CreatorExactSourceDiffPage> {
    const bundle = await this.bundle(sessionId);
    const candidates = bundle.changeSets.flatMap((changeSet) =>
      input.changeSetId !== undefined && changeSet.id !== input.changeSetId
        ? []
        : changeSet.operations.flatMap((operation) =>
            operation.kind === "edit_source" && operation.id === input.operationId
              ? [{ changeSet, operation }]
              : [],
          ),
    );
    if (candidates.length !== 1)
      throw new Error(
        "Exact source diff requires one sealed edit-source operation in this session",
      );
    const { changeSet, operation } = candidates[0]!;
    const plan = bundle.plan;
    if (!plan || plan.id !== changeSet.planId || plan.hash !== changeSet.planHash)
      throw new Error("Exact source diff change set lost its sealed plan binding");
    const sourceIndexBinding = bundle.sourceIndices.find(
      (binding) => binding.id === plan.sourceIndexId && binding.hash === plan.sourceIndexHash,
    );
    if (!sourceIndexBinding)
      throw new Error("Exact source diff change set lost its immutable source index");
    const sourceIndex = await this.artifactStore.read(
      sourceIndexBinding.artifact,
      assertStudioSourceIndex,
    );
    if (sourceIndex.hash !== input.sourceIndexHash)
      throw new Error("Exact source diff does not match the sealed source-index anchor");
    if (sourceIndex.snapshotHash !== plan.projectCaptureHash)
      throw new Error("Exact source diff source index does not bind the plan project capture");
    const projectBinding = bundle.projectIndices.find(
      (binding) => binding.captureHash === plan.projectCaptureHash,
    );
    if (!projectBinding)
      throw new Error("Exact source diff change set lost its before project index");
    const project = await readCreatorProjectIndexMetadataArtifacts(
      this.artifactStore,
      projectBinding,
    );
    const documentId = studioObjectIdentityKey(operation.target.identity);
    const document = sourceIndex.documents.find((candidate) => candidate.documentId === documentId);
    const sourceDocument = project.sourceDocuments.find(
      (candidate) => candidate.documentId === documentId,
    );
    if (
      !document ||
      !sourceDocument ||
      document.sourceHash !== operation.beforeSourceHash ||
      sourceDocument.sourceHash !== operation.beforeSourceHash ||
      document.path !== sourceDocument.path ||
      document.className !== sourceDocument.className ||
      document.executionContext !== sourceDocument.executionContext
    )
      throw new Error("Exact source diff target lost its immutable before-source binding");
    const maximumUtf8Bytes = exactDiffPageSize(input.maximumUtf8Bytes);
    const cursor =
      input.cursor === undefined
        ? { editIndex: 0, beforeOffset: 0, replacementOffset: 0 }
        : decodeExactDiffCursor(input.cursor, {
            sessionId,
            changeSetId: changeSet.id,
            changeSetHash: changeSet.hash,
            operationId: operation.id,
            sourceIndexHash: sourceIndex.hash,
          });
    const edit = operation.edits[cursor.editIndex];
    if (!edit) throw new Error("Exact source diff cursor is outside the sealed edit list");
    const beforeLength = edit.endByte - edit.startByte;
    if (cursor.beforeOffset > beforeLength)
      throw new Error("Exact source diff cursor exceeds the before-source range");
    const before = await project.sourceResolver.readRange(document, {
      startByte: edit.startByte + cursor.beforeOffset,
      endByte: Math.min(edit.endByte, edit.startByte + cursor.beforeOffset + maximumUtf8Bytes),
    });
    if (before.startByte !== edit.startByte + cursor.beforeOffset || before.endByte > edit.endByte)
      throw new Error(
        "Exact source diff before-source resolver did not honor the sealed edit range",
      );
    const sourceWrite = bundle.sourceWriteBlobs.find(
      (binding) =>
        binding.manifest.id === edit.replacementBlob.manifestId &&
        binding.manifest.hash === edit.replacementBlob.manifestHash,
    );
    if (!sourceWrite)
      throw new Error("Exact source diff replacement lost its immutable source-write artifact");
    const replacement = await readCreatorSourceWriteArtifactRange(this.artifactStore, sourceWrite, {
      startByte: cursor.replacementOffset,
      endByte: Math.min(
        edit.replacementBlob.utf8Bytes,
        cursor.replacementOffset + maximumUtf8Bytes,
      ),
    });
    if (
      replacement.sourceHash !== edit.replacementBlob.sourceHash ||
      replacement.totalUtf8Bytes !== edit.replacementBlob.utf8Bytes ||
      replacement.range.startByte !== cursor.replacementOffset
    )
      throw new Error(
        "Exact source diff replacement artifact does not match the sealed edit binding",
      );
    const next = nextExactDiffCursor({
      editCount: operation.edits.length,
      editIndex: cursor.editIndex,
      beforeOffset: before.endByte - edit.startByte,
      beforeLength,
      replacementOffset: replacement.range.endByte,
      replacementLength: replacement.totalUtf8Bytes,
    });
    const cursorBinding = {
      sessionId,
      changeSetId: changeSet.id,
      changeSetHash: changeSet.hash,
      operationId: operation.id,
      sourceIndexHash: sourceIndex.hash,
    };
    return {
      kind: "CreatorExactSourceDiffPage",
      sessionId,
      sourceIndex: {
        id: sourceIndex.id,
        hash: sourceIndex.hash,
        snapshotHash: sourceIndex.snapshotHash,
      },
      changeSet: { id: changeSet.id, hash: changeSet.hash },
      operation: {
        id: operation.id,
        document,
        beforeSourceHash: operation.beforeSourceHash,
        finalSourceHash: operation.finalSourceHash,
        finalByteCount: operation.finalByteCount,
      },
      edit: {
        ordinal: cursor.editIndex,
        editCount: operation.edits.length,
        before: {
          totalUtf8Bytes: beforeLength,
          range: {
            startByte: before.startByte - edit.startByte,
            endByte: before.endByte - edit.startByte,
          },
          source: before.source,
        },
        replacement: {
          sourceHash: replacement.sourceHash,
          totalUtf8Bytes: replacement.totalUtf8Bytes,
          range: replacement.range,
          source: replacement.source,
        },
      },
      ...(next ? { nextCursor: encodeExactDiffCursor({ ...cursorBinding, ...next }) } : {}),
    };
  }

  async sourceSymbols(
    sessionId: string,
    sourceIndexHash: string,
    input: {
      query: string;
      pathPrefix?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<unknown> {
    return findStudioSourceSymbols(await this.sealedSourceIndex(sessionId, sourceIndexHash), input);
  }

  async sourceReferences(
    sessionId: string,
    sourceIndexHash: string,
    input: {
      symbol: string;
      pathPrefix?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<unknown> {
    return findStudioSourceReferences(
      await this.sealedSourceIndex(sessionId, sourceIndexHash),
      input,
    );
  }

  async sourceDependencies(
    sessionId: string,
    sourceIndexHash: string,
    input: {
      documentId: string;
      direction: "imports" | "importers" | "closure";
      maxDepth?: number;
      limit?: number;
      cursor?: string;
    },
  ): Promise<unknown> {
    return inspectStudioSourceDependencies(
      await this.sealedSourceIndex(sessionId, sourceIndexHash),
      input,
    );
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

  async replayVerification(verificationId: string, verificationHash: string) {
    if (!/^[a-f0-9]{64}$/.test(verificationHash))
      throw new Error("Invalid creator verification hash");
    for (const bundle of this.bundles.values()) {
      const verification = bundle.verifications.find(
        (candidate) => candidate.id === verificationId && candidate.hash === verificationHash,
      );
      if (verification) return replayCreatorVerification(bundle, verification, this.artifactStore);
    }
    throw new Error("Creator verification was not found");
  }

  async replayMutation(attemptId: string, attemptHash: string) {
    if (!/^[a-f0-9]{64}$/.test(attemptHash))
      throw new Error("Invalid creator mutation-attempt hash");
    for (const bundle of this.bundles.values()) {
      const attempt = bundle.mutationAttempts.find(
        (candidate) => candidate.id === attemptId && candidate.hash === attemptHash,
      );
      if (attempt) return replayCreatorMutation(attempt, this.artifactStore);
      const rojo = bundle.rojoSourceMutations.find(
        (candidate) => candidate.attempt.id === attemptId && candidate.attempt.hash === attemptHash,
      );
      if (rojo) {
        const [changeSet, sourceAttempt, proof] = await Promise.all([
          this.artifactStore.read(rojo.changeSet.artifact, assertRojoSourceChangeSet),
          this.artifactStore.read(rojo.attempt.artifact, assertRojoMutationAttempt),
          rojo.syncProofs.at(-1)
            ? this.artifactStore.read(rojo.syncProofs.at(-1)!.artifact, assertRojoSyncProof)
            : undefined,
        ]);
        return replayRojoMutation({
          changeSet,
          attempt: sourceAttempt,
          ...(proof ? { syncProof: proof } : {}),
        });
      }
    }
    throw new Error("Creator mutation attempt was not found");
  }

  async action(value: unknown): Promise<unknown> {
    const action = assertCreatorTransactionControlAction(value);
    if (action.action === "start")
      return this.start(
        action.creatorText,
        action.agentPrompt,
        action.model,
        action.creatorSessionId,
        action.contextCitations,
        requiredSingleAgentExecution(action.agentExecutions, "planner"),
      );
    if (action.action === "resume")
      return this.resumePlanner(
        action.creatorSessionId,
        requiredSingleAgentExecution(action.agentExecutions, "planner"),
      );
    assertActionAgentExecutions(action.actionId, action.agentExecutions);
    const bundle = await this.bundle(action.sessionId);
    return this.lock(bundle.session.id, async () => {
      const view =
        this.views.get(bundle.session.id) ??
        (await this.view(bundle, restoredCreatorControlDetail(bundle)));
      assertActionBinding(action, view, this.consumedViewHashes);
      if (
        [
          "transaction_approve_and_apply_changes",
          "transaction_retry_play_verification",
          "transaction_cancel_changes",
          "transaction_refresh_project",
          "transaction_check_source_sync",
          "transaction_revert_source_changes",
          "transaction_cancel_interrupted_recording",
          "transaction_reject_and_rollback",
        ].includes(action.actionId)
      )
        await this.currentAttestedStudioSession();
      if (
        action.actionId === "transaction_approve_and_apply_changes" &&
        requiredChangeSet(bundle).mutationAuthority === "studio_document"
      ) {
        const studio = await this.currentAttestedStudioSession();
        await this.requireClearRecordingInventory(studio);
      }
      this.consumedViewHashes.add(action.viewHash);
      if (action.actionId === "transaction_approve_plan")
        return this.decidePlan(
          bundle,
          requiredArtifactHash(view, "plan"),
          "approved",
          requiredSingleAgentExecution(action.agentExecutions, "builder"),
        );
      if (action.actionId === "transaction_reject_plan")
        return this.decidePlan(bundle, requiredArtifactHash(view, "plan"), "rejected");
      if (action.actionId === "transaction_approve_and_apply_changes")
        return this.decideChanges(
          bundle,
          requiredArtifactHash(view, "change_set"),
          "approved",
          requiredSingleAgentExecution(action.agentExecutions, "repair"),
        );
      if (action.actionId === "transaction_reject_changes")
        return this.decideChanges(bundle, requiredArtifactHash(view, "change_set"), "rejected");
      if (action.actionId === "transaction_retry_play_verification")
        return this.retryPlayVerification(
          bundle,
          requiredSingleAgentExecution(action.agentExecutions, "repair"),
        );
      if (action.actionId === "transaction_cancel_changes") return this.rollback(bundle);
      if (action.actionId === "transaction_refresh_project")
        return this.refreshProject(
          bundle,
          requiredSingleAgentExecution(action.agentExecutions, "planner"),
        );
      if (action.actionId === "transaction_check_source_sync")
        return this.checkRojoSourceSync(bundle);
      if (action.actionId === "transaction_revert_source_changes")
        return this.revertRojoSourceChanges(bundle);
      if (action.actionId === "transaction_cancel_interrupted_recording")
        return this.cancelInterruptedRecording(bundle);
      if (action.actionId === "transaction_accept_result")
        return this.review(bundle, "accepted", action.report);
      if (action.actionId === "transaction_reject_and_rollback")
        return requiredChangeSet(bundle).mutationAuthority === "rojo_source"
          ? this.rejectAndRevertRojoSource(bundle, action.report)
          : this.rejectAndRollback(bundle, action.report);
      throw new Error("The requested creator action is unavailable");
    });
  }

  private async onPluginMessage(
    message: PluginToBackendMessage,
    session: StudioBridgeSession,
    finalizationOwnedAtReceipt = false,
    projectChangeAccepted = true,
  ): Promise<void> {
    this.pairedSession = session;
    if (
      [
        "PairProject",
        "UnpairProject",
        "CreatorRecordingRecovery",
        "CreatorClosedRecordingAcknowledged",
        "CreatorChangeFinalized",
      ].includes(message.type) ||
      (message.type === "StudioEvidenceProduced" &&
        message.payload.reason === "capability_attestation")
    )
      this.invalidateViewsForProject(session.projectId);
    if (message.type === "StudioProjectChangeDetected") {
      if (!projectChangeAccepted) return;
      if (stableJson(message.payload.project) !== stableJson(session.project))
        throw new Error("Project-change notification belongs to a different Studio project");
      if (message.payload.connectorEpoch !== this.connectorEpoch(session))
        throw new Error("Project-change notification belongs to a stale connector epoch");
      for (const current of [...this.bundles.values()]) {
        if (current.session.projectId !== session.projectId) continue;
        const admittedDuringTransaction =
          this.pendingTransactionProjectChangeIngress
            .get(current.session.id)
            ?.has(message.messageId) ?? false;
        // A message admitted while finalization was in flight must retain its
        // exact notice edge even if the older continuation has just written a
        // terminal bundle. It is compared against the final capture, never
        // discarded as a post-terminal dashboard invalidation.
        if (isTerminalStatus(current.session.status) && !admittedDuringTransaction) continue;
        const notice = createCreatorProjectChangeNotice({
          projectId: session.projectId,
          connectorEpoch: message.payload.connectorEpoch,
          payload: message.payload,
        });
        const artifact = await this.artifactStore.write(notice);
        const mightOwnRecording =
          admittedDuringTransaction || this.mightOwnStudioRecording(current);
        const change = { notice, artifact, priorStatus: current.session.status };
        const nextStatus =
          isTerminalStatus(current.session.status) ||
          current.session.status === "recovery_required" ||
          current.session.status === "awaiting_source_sync"
            ? current.session.status
            : mightOwnRecording
              ? current.session.status
              : "refresh_required";
        const next: CreatorSessionBundle = {
          ...current,
          projectChanges: [...current.projectChanges, change],
          session:
            nextStatus === current.session.status
              ? current.session
              : advanceSession(current.session, {
                  status: nextStatus,
                }),
        };
        this.bundles.set(next.session.id, next);
        await this.persist(next);
        if (mightOwnRecording) {
          this.bindPendingTransactionProjectChange(next.session.id, change);
          this.clearPendingTransactionProjectChangeIngress(next.session.id, message.messageId);
          await this.publishView(
            next,
            "Studio reported an advisory project change while a Forge recording may be open. Forge is collecting a complete read-only index confirmation before it can verify or finalize anything.",
          );
        } else {
          // Only a fully validated and durably retained notice may revoke an
          // ordinary pre-recording operation. A raw wire message is advisory
          // input, not enough authority to strand an unrelated transaction.
          this.revokeProjectAuthority(session.projectId);
          await this.publishView(
            next,
            "Studio changed. Refresh the complete project index to compare revisions and replan explicitly.",
          );
        }
      }
      this.emit();
      return;
    }
    if (message.type === "PairProject") {
      this.attestations.delete(session.sessionId);
      this.pluginMessageFailures.delete(session.sessionId);
      for (const [requestId, pending] of this.pendingFinalizationAcknowledgements) {
        if (
          pending.projectId === session.projectId &&
          pending.studioSessionId !== session.sessionId
        )
          this.pendingFinalizationAcknowledgements.delete(requestId);
      }
      this.recordingScans.set(session.sessionId, {
        projectId: session.projectId,
        status: "pending",
        detail: "Waiting for Studio to report its durable creator-transaction state.",
      });
    } else if (message.type === "UnpairProject") {
      this.unsolicitedProjectIndexStreams.delete(session.sessionId);
      this.attestations.delete(session.sessionId);
      this.recordingScans.delete(session.sessionId);
      this.pluginMessageFailures.delete(session.sessionId);
      for (const [requestId, pending] of this.pendingClosedRecordingAcknowledgements) {
        if (pending.studioSessionId === session.sessionId)
          this.pendingClosedRecordingAcknowledgements.delete(requestId);
      }
      for (const [requestId, pending] of this.pendingFinalizationAcknowledgements) {
        if (pending.studioSessionId === session.sessionId)
          this.pendingFinalizationAcknowledgements.delete(requestId);
      }
      for (const bundle of this.bundles.values()) {
        if (bundle.session.projectId !== session.projectId) continue;
        this.observingCreatorPlay.delete(bundle.session.id);
        // `CreatorTransactionControlView` is cached for its exact action binding. Clear
        // an already-rendered Observing title immediately on disconnect rather
        // than waiting for the runtime promise to unwind and publish its
        // recovery view.
        if (bundle.session.status === "verifying")
          await this.publishView(
            bundle,
            "Studio disconnected while the approved Play observation was active. Forge is preserving the provisional transaction and will not infer, re-arm, commit, or cancel it.",
          );
      }
    } else if (
      message.type === "StudioEvidenceProduced" &&
      message.payload.reason === "capability_attestation"
    ) {
      let grade: StudioCapabilityAttestationGrade;
      try {
        if (message.payload.projection.contentHash !== session.capabilityAttestationProjectionHash)
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
      if (message.payload.finalizationRequestId !== undefined) {
        const pending = this.pendingFinalizationAcknowledgements.get(
          message.payload.finalizationRequestId,
        );
        if (!pending || pending.studioSessionId !== session.sessionId) {
          this.recordingScans.set(session.sessionId, {
            projectId: session.projectId,
            status: "blocked",
            detail: "Recovery required: Studio reported an unknown finalization acknowledgement.",
          });
          this.emit();
          return;
        }
        await this.artifactStore.write({
          kind: "CreatorChangeFinalizationAcknowledgement",
          studioSessionId: session.sessionId,
          projectId: session.projectId,
          receipt: pending.receiptArtifact,
          authorityHash: pending.authorityHash,
          requestId: message.payload.finalizationRequestId,
          resultingRecordingState: message.payload.recordingState,
          acknowledgedAt: message.sentAt,
        });
        this.pendingFinalizationAcknowledgements.delete(message.payload.finalizationRequestId);
      }
      if (message.payload.recordingState === "none") {
        this.setRecordingInventoryClearIfSettled(
          session,
          message.payload.finalizationRequestId
            ? "Studio consumed the exact finalization acknowledgement and proved no durable creator transaction cursor remains."
            : "Studio reported no durable creator transaction cursor.",
        );
        this.emit();
        return;
      }
      const recoveryPayload = message.payload;
      let projectIndexCapture: StudioProjectIndexCapture;
      try {
        projectIndexCapture = this.resolveProjectIndexBinding(
          recoveryPayload.recoveryProjectIndexManifestId,
          recoveryPayload.recoveryProjectRevisionHash,
          recoveryPayload.recoveryProjectDetectorEpoch,
        );
      } catch (error) {
        this.recordingScans.set(session.sessionId, {
          projectId: session.projectId,
          status: "blocked",
          detail: `Recovery required: ${detail(error)}`,
        });
        this.emit();
        return;
      }
      const projectIndexArtifacts = await this.persistProjectIndex(projectIndexCapture);
      this.recordingScans.set(session.sessionId, {
        projectId: session.projectId,
        status: "blocked",
        detail:
          recoveryPayload.recordingState === "not_open"
            ? "Studio proved a retained Forge recording is closed; waiting for exact durable acknowledgement."
            : `Recovery required: Studio reported the retained recording as ${recoveryPayload.recordingState}.`,
      });
      const recoveryRecordArtifact = await this.artifactStore.write({
        kind: "CreatorRecordingRecoveryRecord",
        studioSessionId: session.sessionId,
        projectId: session.projectId,
        payload: recoveryPayload,
        projectIndex: projectIndexArtifacts,
        receivedAt: message.sentAt,
      });
      const bundle = this.bundles.get(recoveryPayload.creatorSessionId);
      const active = bundle?.activeMutation;
      let matchedBundleId: string | undefined;
      if (bundle && active) {
        const beforeCapture = await readCreatorProjectIndexArtifacts(
          this.artifactStore,
          active.beforeIndexCapture,
        );
        if (
          bundle.session.projectId === session.projectId &&
          active.changeSetHash === recoveryPayload.changeSetHash &&
          active.projectionHash === recoveryPayload.projectionHash &&
          active.changeSetId === recoveryPayload.changeSetId &&
          active.projectionId === recoveryPayload.projectionId &&
          recoveryPayload.manifestHash === STUDIO_CAPABILITY_MANIFEST_HASH &&
          active.beforeIndexRevisionHash === recoveryPayload.beforeProjectRevisionHash &&
          beforeCapture.indexManifest.id === recoveryPayload.beforeProjectIndexManifestId &&
          beforeCapture.detectorEpoch === recoveryPayload.beforeProjectDetectorEpoch &&
          (!active.recordingId || active.recordingId === recoveryPayload.recordingId)
        ) {
          matchedBundleId = bundle.session.id;
          const nextBundle: CreatorSessionBundle = {
            ...bundle,
            activeMutation: {
              ...active,
              recordingId: recoveryPayload.recordingId,
            },
          };
          this.bundles.set(bundle.session.id, nextBundle);
          await this.persist(nextBundle);
          this.recordingRecovery.set(nextBundle.session.id, {
            studioSessionId: session.sessionId,
            recordingState: recoveryPayload.recordingState,
            recordingId: recoveryPayload.recordingId,
            projectIndexCapture,
            projectIndexArtifact: projectIndexArtifacts.revision.artifact,
            projectDetectorEpoch: recoveryPayload.recoveryProjectDetectorEpoch,
            ...(recoveryPayload.replacesAction === undefined
              ? {}
              : { replacesAction: recoveryPayload.replacesAction }),
          });
          if (this.hasPendingTransactionProjectChange(nextBundle.session.id))
            this.scheduleTransactionProjectChangeConfirmation(nextBundle.session.id);
          await this.publishView(
            nextBundle,
            recoveryPayload.recordingState === "open"
              ? "Studio proved the exact interrupted recording is open. You may explicitly cancel it."
              : `Studio reported the interrupted recording as ${recoveryPayload.recordingState}; Forge will not mutate it automatically.`,
          );
        }
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
          beforeProjectIndexManifestId: recoveryPayload.beforeProjectIndexManifestId,
          beforeProjectRevisionHash: recoveryPayload.beforeProjectRevisionHash,
          beforeProjectDetectorEpoch: recoveryPayload.beforeProjectDetectorEpoch,
          recordingId: recoveryPayload.recordingId,
          recoveryProjectIndexManifestId: recoveryPayload.recoveryProjectIndexManifestId,
          recoveryProjectRevisionHash: recoveryPayload.recoveryProjectRevisionHash,
          recoveryProjectDetectorEpoch: recoveryPayload.recoveryProjectDetectorEpoch,
          recoveryRecordArtifact,
          ...(matchedBundleId ? { bundleId: matchedBundleId } : {}),
        });
        if (!matchedBundleId || !this.hasPendingTransactionProjectChange(matchedBundleId))
          await this.sendClosedRecordingAcknowledgement(requestId);
      }
    } else if (message.type === "CreatorClosedRecordingAcknowledged") {
      const pending = message.requestId
        ? this.pendingClosedRecordingAcknowledgements.get(message.requestId)
        : undefined;
      if (!pending || pending.studioSessionId !== session.sessionId) return;
      const exact =
        message.payload.status === "closed_cursor_cleared" &&
        message.payload.creatorSessionId === pending.creatorSessionId &&
        message.payload.changeSetId === pending.changeSetId &&
        message.payload.changeSetHash === pending.changeSetHash &&
        message.payload.projectionId === pending.projectionId &&
        message.payload.projectionHash === pending.projectionHash &&
        message.payload.manifestHash === pending.manifestHash &&
        message.payload.beforeProjectIndexManifestId === pending.beforeProjectIndexManifestId &&
        message.payload.beforeProjectRevisionHash === pending.beforeProjectRevisionHash &&
        message.payload.beforeProjectDetectorEpoch === pending.beforeProjectDetectorEpoch &&
        message.payload.recordingId === pending.recordingId &&
        message.payload.recoveryProjectIndexManifestId === pending.recoveryProjectIndexManifestId &&
        message.payload.recoveryProjectRevisionHash === pending.recoveryProjectRevisionHash &&
        message.payload.recoveryProjectDetectorEpoch === pending.recoveryProjectDetectorEpoch;
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
      this.setRecordingInventoryClearIfSettled(
        session,
        "Studio proved the retained recording was closed; Forge durably acknowledged and cleared only its stale connector cursor.",
      );
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
    } else if (message.type === "CreatorChangeFinalized") {
      await this.retainFinalizationReceipt(session, message);
      this.recordingScans.set(session.sessionId, {
        projectId: session.projectId,
        status: "blocked",
        detail:
          "Studio retains a settled creator finalization receipt; waiting for its exact durable acknowledgement and a fresh transaction-inventory report.",
      });
      if (finalizationOwnedAtReceipt) {
        this.emit();
        return;
      }
      const bundle = this.bundles.get(message.payload.creatorSessionId);
      if (
        bundle !== undefined &&
        ["recovery_required", "committing", "cancelling"].includes(bundle.session.status) &&
        bundle.activeMutation?.changeSetHash === message.payload.changeSetHash &&
        bundle.activeMutation.projectionHash === message.payload.projectionHash &&
        (!bundle.activeMutation.recordingId ||
          bundle.activeMutation.recordingId === message.payload.recordingId)
      )
        await this.recoverFinalizedMutation(bundle, message, session);
      else await this.acknowledgeFinalization(session, message);
    }
    this.emit();
  }

  private projectChangeEpochKey(projectId: string, connectorEpoch: string): string {
    return `${projectId}:${connectorEpoch}`;
  }

  private mightOwnStudioRecording(bundle: CreatorSessionBundle): boolean {
    return (
      bundle.activeMutation !== undefined ||
      [
        "applying",
        "awaiting_verification",
        "verifying",
        "awaiting_verification_retry",
        "cancelling",
        "committing",
        "recovery_required",
      ].includes(bundle.session.status)
    );
  }

  /**
   * Admit only strictly newer monitor epochs before they influence a session.
   * The monitor's epoch is a delivery ordering token, not a revision claim.
   */
  private admitProjectChangeAtIngress(
    message: PluginToBackendMessage,
    session: StudioBridgeSession,
  ): boolean {
    if (message.type !== "StudioProjectChangeDetected") return true;
    if (
      stableJson(message.payload.project) !== stableJson(session.project) ||
      message.payload.connectorEpoch !== this.connectorEpoch(session)
    )
      return true;
    const key = this.projectChangeEpochKey(session.projectId, message.payload.connectorEpoch);
    const previous = this.projectChangeDetectorEpochs.get(key);
    if (previous !== undefined && message.payload.epoch <= previous) return false;
    this.projectChangeDetectorEpochs.set(key, message.payload.epoch);
    for (const bundle of this.bundles.values()) {
      if (
        bundle.session.projectId !== session.projectId ||
        isTerminalStatus(bundle.session.status) ||
        !this.mightOwnStudioRecording(bundle)
      )
        continue;
      let ingress = this.pendingTransactionProjectChangeIngress.get(bundle.session.id);
      if (!ingress) {
        ingress = new Set();
        this.pendingTransactionProjectChangeIngress.set(bundle.session.id, ingress);
      }
      ingress.add(message.messageId);
    }
    return true;
  }

  private clearPendingTransactionProjectChangeIngress(sessionId: string, messageId: string): void {
    const ingress = this.pendingTransactionProjectChangeIngress.get(sessionId);
    if (!ingress) return;
    ingress.delete(messageId);
    if (ingress.size === 0) this.pendingTransactionProjectChangeIngress.delete(sessionId);
  }

  private bindPendingTransactionProjectChange(
    sessionId: string,
    change: PendingTransactionProjectChange,
  ): void {
    const pending = this.pendingTransactionProjectChanges.get(sessionId) ?? [];
    if (!pending.some((entry) => entry.artifact.artifactHash === change.artifact.artifactHash))
      this.pendingTransactionProjectChanges.set(sessionId, [...pending, change]);
  }

  /**
   * Confirmation is per immutable notice, never per session. A newer notice
   * may arrive and be durably merged while a current-index collection is in
   * flight; retiring the whole session queue at that point would let an
   * unconfirmed receipt stop blocking finalization.
   */
  private clearConfirmedTransactionProjectChanges(
    sessionId: string,
    confirmedArtifacts: { readonly has: (artifactHash: string) => boolean },
  ): void {
    const pending = this.pendingTransactionProjectChanges.get(sessionId);
    if (!pending) return;
    const remaining = pending.filter(
      (change) => !confirmedArtifacts.has(change.artifact.artifactHash),
    );
    if (remaining.length === 0) this.pendingTransactionProjectChanges.delete(sessionId);
    else this.pendingTransactionProjectChanges.set(sessionId, remaining);
  }

  private hasPendingTransactionProjectChange(sessionId: string): boolean {
    return (
      (this.pendingTransactionProjectChangeIngress.get(sessionId)?.size ?? 0) > 0 ||
      (this.pendingTransactionProjectChanges.get(sessionId)?.length ?? 0) > 0
    );
  }

  private hasBoundPendingTransactionProjectChange(sessionId: string): boolean {
    return (this.pendingTransactionProjectChanges.get(sessionId)?.length ?? 0) > 0;
  }

  /**
   * A dirty hint is comparable only after its transaction phase has an exact
   * post-state. Before that point it is a durable barrier, not failed evidence.
   * Recovery and settled-finalization captures supersede a provisional phase
   * baseline because they describe the later legitimate Studio state.
   */
  private transactionProjectChangeConfirmationOverride(
    sessionId: string,
  ): StudioProjectIndexCapture | undefined {
    return (
      this.finalizedTransactionProjectChangeCaptures.get(sessionId) ??
      this.recordingRecovery.get(sessionId)?.projectIndexCapture
    );
  }

  private hasTransactionProjectChangeConfirmationBaseline(sessionId: string): boolean {
    return (
      this.transactionProjectChangeConfirmationOverride(sessionId) !== undefined ||
      this.bundles.get(sessionId)?.activeMutation?.afterIndexCapture !== undefined
    );
  }

  /**
   * Finalization is a mutation command. A monitor receipt is not a revision
   * verdict, but until its exact read-only confirmation is durable the host
   * cannot truthfully bind an expected-current capture for commit or cancel.
   */
  private assertFinalizationGateClear(sessionId: string): void {
    if (!this.hasPendingTransactionProjectChange(sessionId)) return;
    if (this.hasTransactionProjectChangeConfirmationBaseline(sessionId))
      this.scheduleTransactionProjectChangeConfirmation(sessionId);
    throw new Error(
      "Creator finalization is blocked until every admitted Studio project-change notice has an exact current-index confirmation.",
    );
  }

  /**
   * Defer a read-only confirmation until after the semantic notification has
   * been acknowledged to Studio. The callback takes the normal per-session
   * lock and never performs a recording, finalization, or provider call.
   */
  private scheduleTransactionProjectChangeConfirmation(sessionId: string): void {
    if (this.scheduledTransactionProjectConfirmations.has(sessionId)) return;
    this.scheduledTransactionProjectConfirmations.add(sessionId);
    setImmediate(() => {
      void this.runScheduledTransactionProjectChangeConfirmation(sessionId).catch(
        (error: unknown) => {
          // Every scheduler branch is terminally contained.  This catch is a
          // last-resort guard for programmer errors in its own containment
          // path; it never writes a transaction verdict.
          this.recordDeferredTaskFailure(sessionId, "project-change confirmation scheduler", error);
        },
      );
    });
  }

  private async runScheduledTransactionProjectChangeConfirmation(sessionId: string): Promise<void> {
    let deferredToLockOwner = false;
    try {
      if (this.inFlight.has(sessionId)) {
        // The owner records a release edge in `lock`. Polling a long-running
        // Play verification here previously formed an unbounded setImmediate
        // loop that competed with the very Studio traffic being awaited.
        deferredToLockOwner = true;
        return;
      }
      await this.lock(sessionId, async () => {
        const bundle = await this.bundle(sessionId);
        // An ingress marker prevents an unsafe verifier/finalizer from
        // advancing, but only a persisted notice artifact may be adjudicated.
        // The bridge queue will schedule this again after it has materialized
        // the exact evidence edge; never turn an unretained wire message into
        // recovery evidence.
        if (!this.hasBoundPendingTransactionProjectChange(sessionId)) return summary(bundle);
        if (!this.hasTransactionProjectChangeConfirmationBaseline(sessionId))
          return summary(bundle);
        const studio = await this.currentAttestedStudioSession();
        const confirmed = await this.confirmTransactionProjectChange(
          bundle,
          studio,
          this.transactionProjectChangeConfirmationOverride(sessionId),
        );
        if (
          confirmed.session.status === "awaiting_verification" &&
          !this.hasPendingTransactionProjectChange(confirmed.session.id)
        )
          this.scheduleAutomaticVerification(confirmed.session.id);
        return summary(confirmed);
      });
    } catch (error) {
      const bundle = this.bundles.get(sessionId);
      const expected = this.transactionProjectChangeConfirmationOverride(sessionId);
      if (!bundle || !this.hasTransactionProjectChangeConfirmationBaseline(sessionId)) {
        this.recordDeferredTaskFailure(sessionId, "project-change confirmation", error);
        return;
      }
      try {
        await this.recordTransactionProjectChangeConfirmationFailure(
          bundle,
          error,
          undefined,
          expected,
        );
      } catch (recoveryError) {
        // A failed attempt to persist/present fail-closed recovery must not
        // become an unhandled rejection in the timer queue.  The existing
        // durable transaction evidence remains the sole authority.
        this.recordDeferredTaskFailure(
          sessionId,
          "project-change confirmation recovery",
          recoveryError,
        );
      }
    } finally {
      this.scheduledTransactionProjectConfirmations.delete(sessionId);
      const requestedAfterLockRelease =
        this.transactionProjectConfirmationRequestedAfterLockRelease.delete(sessionId);
      if (
        this.hasBoundPendingTransactionProjectChange(sessionId) &&
        (this.pendingTransactionProjectChangeIngress.get(sessionId)?.size ?? 0) === 0 &&
        this.hasTransactionProjectChangeConfirmationBaseline(sessionId) &&
        (requestedAfterLockRelease || !deferredToLockOwner)
      )
        this.scheduleTransactionProjectChangeConfirmation(sessionId);
    }
  }

  /**
   * Retain the exact current project index for every advisory notice. A clean
   * equality result clears the barrier; a differing or incomplete collection
   * is recovery-required. A dirty message itself never establishes drift.
   */
  private async confirmTransactionProjectChange(
    bundle: CreatorSessionBundle,
    studio: StudioBridgeSession,
    expectedCaptureOverride?: StudioProjectIndexCapture,
  ): Promise<CreatorSessionBundle> {
    if (!this.hasPendingTransactionProjectChange(bundle.session.id)) return bundle;
    const active = bundle.activeMutation;
    if (!active && !expectedCaptureOverride) return bundle;
    // Apply may admit the dirty hint before it has retained direct post-state.
    // Waiting is fail-closed: verification/finalization remain blocked, while
    // no comparison outcome is invented from the unrelated pre-Apply capture.
    if (!expectedCaptureOverride && !active?.afterIndexCapture) return bundle;
    const changes = this.pendingTransactionProjectChanges.get(bundle.session.id) ?? [];
    if (changes.length === 0) return bundle;
    let expected: StudioProjectIndexCapture;
    try {
      expected =
        expectedCaptureOverride ??
        (await readCreatorProjectIndexArtifacts(this.artifactStore, active!.afterIndexCapture!));
    } catch (error) {
      return this.recordTransactionProjectChangeConfirmationFailure(
        bundle,
        error,
        changes,
        expectedCaptureOverride,
      );
    }
    let observed: StudioProjectIndexCapture;
    try {
      observed = await this.collectProjectIndex(studio);
    } catch (error) {
      return this.recordTransactionProjectChangeConfirmationFailure(
        bundle,
        error,
        changes,
        expected,
      );
    }
    // A later notification proves only that this capture cannot confirm the
    // whole outstanding advisory set. Discard this read and wait for the exact
    // notice artifact to be retained; absence of a quiet cut is not itself an
    // incomplete Studio observation or a recovery verdict.
    if ((this.pendingTransactionProjectChangeIngress.get(bundle.session.id)?.size ?? 0) > 0) {
      return bundle;
    }
    bundle = await this.retainProjectIndex(bundle, observed);
    const delta = createCreatorProjectDelta(expected, observed);
    const deltaArtifact = await this.artifactStore.write(delta);
    const outcome = expected.revision.hash === observed.revision.hash ? "unchanged" : "drift";
    const confirmations = await Promise.all(
      changes.map(async (change) => {
        const record = createCreatorTransactionProjectChangeConfirmation({
          sessionId: bundle.session.id,
          notice: change.artifact,
          expectedCaptureHash: expected.hash,
          expectedRevisionHash: expected.revision.hash,
          outcome,
          observedCaptureHash: observed.hash,
          observedRevisionHash: observed.revision.hash,
          delta: deltaArtifact,
          detail:
            outcome === "unchanged"
              ? "A complete current Studio project index exactly matched the bound provisional revision."
              : `A complete current Studio project index differs from the bound provisional revision: expected ${expected.revision.hash}, observed ${observed.revision.hash}.`,
          confirmedAt: new Date().toISOString(),
        });
        return { change, record, artifact: await this.artifactStore.write(record) };
      }),
    );
    const confirmationsByNotice = new Map(
      confirmations.map((entry) => [entry.change.artifact.artifactHash, entry] as const),
    );
    const nextStatus =
      outcome === "unchanged" || isTerminalStatus(bundle.session.status)
        ? bundle.session.status
        : "recovery_required";
    bundle = {
      ...bundle,
      projectChanges: bundle.projectChanges.map((entry) => {
        const confirmation = confirmationsByNotice.get(entry.artifact.artifactHash);
        return confirmation
          ? {
              ...entry,
              confirmation: { record: confirmation.record, artifact: confirmation.artifact },
            }
          : entry;
      }),
      session:
        nextStatus === bundle.session.status
          ? bundle.session
          : advanceSession(bundle.session, {
              status: nextStatus,
              failure: {
                code: "unattributed_project_change_during_transaction",
                detail:
                  "A complete post-notice Studio project index proved drift while a Forge recording may be open. Forge will not commit, cancel, or infer recovery automatically.",
              },
            }),
    };
    this.bundles.set(bundle.session.id, bundle);
    bundle = await this.persist(bundle);
    this.clearConfirmedTransactionProjectChanges(bundle.session.id, confirmationsByNotice);
    if (isTerminalStatus(bundle.session.status))
      this.finalizedTransactionProjectChangeCaptures.delete(bundle.session.id);
    // The confirmation record, its state transition, and the pending-barrier
    // removal are durable above.  Publishing that durable fact or delivering
    // an acknowledgement is operational follow-up, not additional Studio
    // evidence.  Do not let either failure fall back into the scheduler and
    // fabricate a second, incomplete confirmation verdict.
    const followUpErrors: unknown[] = [];
    if (outcome === "drift") {
      this.revokeProjectAuthority(bundle.session.projectId);
      try {
        await this.publishView(
          bundle,
          "A complete current Studio index proved project drift during a transaction. Exact recording recovery is required; Forge will not finalize automatically.",
        );
      } catch (error) {
        followUpErrors.push(error);
      }
    } else {
      try {
        await this.publishView(
          bundle,
          "A complete current Studio index matched the bound provisional revision. The advisory project-change notice is cleared without a mutation or provider call.",
        );
      } catch (error) {
        followUpErrors.push(error);
      }
      try {
        await this.flushDeferredTransactionAcknowledgements(bundle.session.id);
      } catch (error) {
        followUpErrors.push(error);
      }
    }
    if (followUpErrors.length > 0)
      this.recordDeferredTaskFailure(
        bundle.session.id,
        "post-confirmation presentation or acknowledgement",
        new Error(followUpErrors.map((error) => operationalDetail(error)).join("; ")),
      );
    return bundle;
  }

  private async recordTransactionProjectChangeConfirmationFailure(
    bundle: CreatorSessionBundle,
    error: unknown,
    changes = this.pendingTransactionProjectChanges.get(bundle.session.id) ?? [],
    expected?: StudioProjectIndexCapture,
  ): Promise<CreatorSessionBundle> {
    const active = bundle.activeMutation;
    const expectedCaptureHash =
      expected?.hash ??
      active?.afterIndexCapture?.captureHash ??
      active?.beforeIndexCapture.captureHash;
    const expectedRevisionHash =
      expected?.revision.hash ??
      active?.afterIndexCapture?.revision.hash ??
      active?.beforeIndexCapture.revision.hash;
    if (!expectedCaptureHash || !expectedRevisionHash) return bundle;
    const detailValue = `Forge could not complete a read-only current-index confirmation after an advisory project-change notice: ${detail(error)}`;
    const confirmations = await Promise.all(
      changes.map(async (change) => {
        const record = createCreatorTransactionProjectChangeConfirmation({
          sessionId: bundle.session.id,
          notice: change.artifact,
          expectedCaptureHash,
          expectedRevisionHash,
          outcome: "incomplete",
          detail: detailValue,
          confirmedAt: new Date().toISOString(),
        });
        return { change, record, artifact: await this.artifactStore.write(record) };
      }),
    );
    const confirmationsByNotice = new Map(
      confirmations.map((entry) => [entry.change.artifact.artifactHash, entry] as const),
    );
    let next = {
      ...bundle,
      projectChanges: bundle.projectChanges.map((entry) => {
        const confirmation = confirmationsByNotice.get(entry.artifact.artifactHash);
        return confirmation
          ? {
              ...entry,
              confirmation: { record: confirmation.record, artifact: confirmation.artifact },
            }
          : entry;
      }),
      session:
        bundle.session.status === "recovery_required" || isTerminalStatus(bundle.session.status)
          ? bundle.session
          : advanceSession(bundle.session, {
              status: "recovery_required",
              failure: {
                code: "project_change_confirmation_incomplete",
                detail: detailValue,
              },
            }),
    };
    this.bundles.set(next.session.id, next);
    next = await this.persist(next);
    this.clearConfirmedTransactionProjectChanges(next.session.id, confirmationsByNotice);
    if (isTerminalStatus(next.session.status))
      this.finalizedTransactionProjectChangeCaptures.delete(next.session.id);
    this.revokeProjectAuthority(next.session.projectId);
    try {
      await this.publishView(
        next,
        "Forge could not complete the read-only current-index confirmation after an advisory project-change notice. Exact recording recovery is required; Forge will not finalize automatically.",
      );
    } catch (presentationError) {
      this.recordDeferredTaskFailure(
        next.session.id,
        "incomplete confirmation presentation",
        presentationError,
      );
    }
    return next;
  }

  /**
   * A finalization changes the legitimate project revision.  Bind that exact
   * final index before deciding whether an already-admitted dirty receipt is
   * harmless or proves drift; comparing it with the provisional readback
   * would turn every successful commit/cancel into a fabricated mismatch.
   */
  private async confirmFinalizedTransactionProjectChanges(
    bundle: CreatorSessionBundle,
    studio: StudioBridgeSession,
    finalCapture: StudioProjectIndexCapture,
  ): Promise<CreatorSessionBundle> {
    this.finalizedTransactionProjectChangeCaptures.set(bundle.session.id, finalCapture);
    if (!this.hasPendingTransactionProjectChange(bundle.session.id)) return bundle;
    return this.confirmTransactionProjectChange(bundle, studio, finalCapture);
  }

  private acquireProjectAuthority(projectId: string): ProjectAuthorityLease {
    const epoch = this.projectAuthorityEpochs.get(projectId) ?? 0;
    this.projectAuthorityEpochs.set(projectId, epoch);
    return { projectId, epoch };
  }

  private revokeProjectAuthority(projectId: string): void {
    this.projectAuthorityEpochs.set(
      projectId,
      (this.projectAuthorityEpochs.get(projectId) ?? 0) + 1,
    );
  }

  private assertProjectAuthority(lease: ProjectAuthorityLease | undefined): void {
    if (!lease) return;
    if ((this.projectAuthorityEpochs.get(lease.projectId) ?? 0) !== lease.epoch)
      throw new ProjectAuthorityRevokedError(lease);
  }

  private async awaitProjectAuthority<T>(
    lease: ProjectAuthorityLease | undefined,
    operation: Promise<T>,
  ): Promise<T> {
    this.assertProjectAuthority(lease);
    const result = await operation;
    this.assertProjectAuthority(lease);
    return result;
  }

  private enqueuePluginMessage(
    message: PluginToBackendMessage,
    session: StudioBridgeSession,
  ): Promise<void> {
    const projectChangeAccepted = this.admitProjectChangeAtIngress(message, session);
    // Capture ownership synchronously at delivery. The serialized handler may
    // be delayed behind earlier plugin messages, after the local waiter has
    // already consumed the receipt and released its request id.
    const finalizationOwnedAtReceipt =
      message.type === "CreatorChangeFinalized" &&
      message.requestId !== undefined &&
      this.activeFinalizationRequests.has(message.requestId);
    const previous = this.pluginMessageQueues.get(session.sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.onPluginMessage(
            message,
            session,
            finalizationOwnedAtReceipt,
            projectChangeAccepted,
          );
          if (message.type === "StudioProjectChangeDetected" && projectChangeAccepted)
            for (const bundle of this.bundles.values())
              if (
                bundle.session.projectId === session.projectId &&
                this.hasPendingTransactionProjectChange(bundle.session.id) &&
                this.hasTransactionProjectChangeConfirmationBaseline(bundle.session.id)
              )
                this.scheduleTransactionProjectChangeConfirmation(bundle.session.id);
          if (this.pluginMessageFailures.get(session.sessionId)?.messageId === message.messageId)
            this.pluginMessageFailures.delete(session.sessionId);
        } catch (error) {
          this.pluginMessageFailures.set(session.sessionId, {
            messageId: message.messageId,
            detail: `Studio protocol processing failed closed: ${error instanceof Error ? error.message : String(error)}`,
          });
          this.emit();
          // The bridge retains a plugin receipt only after every semantic
          // subscriber succeeds. Rejecting here keeps the exact envelope
          // retryable; acknowledging and reporting the failure later would lose
          // the only durable recovery/finalization delivery.
          throw error;
        }
      });
    this.pluginMessageQueues.set(session.sessionId, current);
    return current.finally(() => {
      if (this.pluginMessageQueues.get(session.sessionId) === current)
        this.pluginMessageQueues.delete(session.sessionId);
    });
  }

  private async start(
    creatorText: string,
    agentPrompt: string,
    model: string,
    creatorSessionId: string,
    contextCitations: readonly CreatorAgentContextCitation[],
    execution: AgentExecutionSlot,
  ): Promise<unknown> {
    const canonicalCreatorText = creatorText.trim();
    const canonicalAgentPrompt = agentPrompt.trim();
    if (canonicalCreatorText.length === 0) throw new Error("Creator prompt must be non-empty");
    if (canonicalAgentPrompt.length === 0)
      throw new Error("Creator agent prompt must be non-empty");
    const studio = await this.currentAttestedStudioSession();
    const attestation = this.attestations.get(studio.sessionId);
    if (!attestation || attestation.status !== "verified")
      throw new Error("The paired Studio connector has no verified capability attestation");
    const pluginMessageFailure = this.pluginMessageFailures.get(studio.sessionId)?.detail;
    if (pluginMessageFailure) throw new Error(pluginMessageFailure);
    await this.requireClearRecordingInventory(studio);
    return this.lock(`project:${studio.projectId}`, async () => {
      if (this.bundles.has(creatorSessionId))
        throw new Error("Preassigned creator session identity was already consumed");
      const active = [...this.bundles.values()].find(
        (bundle) =>
          bundle.session.projectId === studio.projectId && !isTerminalStatus(bundle.session.status),
      );
      if (active)
        throw new Error(
          `Studio project already has a nonterminal creator session: ${active.session.id}`,
        );
      const projectIndex = await this.collectProjectIndex(studio);
      const projectIndexBinding = await this.persistProjectIndex(projectIndex);
      const projectView = studioProjectIndexMetadataView(projectIndex);
      const freshState = projectIndexViewForCreator(projectView);
      const projectAuthorityState = this.input.projectAuthority?.manifest.rojo
        ? await this.persistRojoAuthorityMap(studio.projectId, projectIndex)
        : undefined;
      const projectAuthorityPaths = projectAuthorityState
        ? rojoOwnedStudioPaths(projectAuthorityState.authorityMap)
        : undefined;
      if (projectAuthorityState && !projectAuthorityPaths)
        throw new Error("Verified Rojo authority map has no Studio-visible mappings");
      const ownership =
        projectAuthorityState && projectAuthorityPaths
          ? createStudioOwnershipMap({
              projectId: studio.projectId,
              revisionHash: projectIndex.revision.hash,
              projectIndex: freshState,
              projectAuthority: this.input.projectAuthority!.manifest,
              rojoOwnedPaths: projectAuthorityPaths,
            })
          : createStudioOwnershipMap({
              projectId: studio.projectId,
              revisionHash: projectIndex.revision.hash,
              projectIndex: freshState,
              ...(this.input.projectAuthority
                ? { projectAuthority: this.input.projectAuthority.manifest }
                : {}),
            });
      let session = createCreatorSession({
        id: creatorSessionId,
        prompt: canonicalCreatorText,
        projectId: studio.projectId,
        revisionHash: projectIndex.revision.hash,
        projectCaptureHash: projectIndex.hash,
        ownership,
        model,
      });
      const creatorRequest = await this.artifactStore.write({
        kind: "CreatorRequest",
        sessionId: session.id,
        promptHash: session.promptHash,
        creatorText: canonicalCreatorText,
        agentPrompt: canonicalAgentPrompt,
        contextCitations: structuredClone(contextCitations),
      });
      let bundle: CreatorSessionBundle = {
        session,
        creatorRequest,
        projectIndices: [projectIndexBinding],
        projectChanges: [],
        projectRefreshes: [],
        ownership,
        ...(projectAuthorityState ? { projectAuthority: projectAuthorityState.binding } : {}),
        rojoSourceMutations: [],
        sourceIndices: [],
        sourceConsultations: [],
        sourceWriteBlobs: [],
        buildContracts: [],
        approvals: [],
        changeSets: [],
        mutationAttempts: [],
        verifications: [],
        agentRuns: [],
      };
      this.bundles.set(session.id, bundle);
      await this.persist(bundle);
      await this.publishView(
        bundle,
        "Indexing current Script Editor source with the pinned analysis toolchain. Studio is read-only.",
      );
      try {
        const analyzed = await this.analyzeProjectSources(projectIndex);
        session = advanceSession(session, { status: "planning" });
        bundle = {
          ...bundle,
          session,
          sourceIndices: [
            {
              id: analyzed.index.id,
              hash: analyzed.index.hash,
              artifact: analyzed.indexArtifact,
              analysis: {
                id: analyzed.analysis.id,
                hash: analyzed.analysis.hash,
                artifact: analyzed.analysisArtifact,
              },
            },
          ],
        };
        this.bundles.set(session.id, bundle);
        await this.persist(bundle);
        await this.publishView(
          bundle,
          "Generating a visible plan and verification charter from the verified source index. Studio is read-only.",
        );
        const planned = await this.input.worker.plan({
          session,
          ownership,
          projectIndex: freshState,
          sourceIndex: analyzed.index,
          sourceResolver: analyzed.resolver,
          creatorPrompt: canonicalCreatorText,
          agentPrompt: canonicalAgentPrompt,
          contextCitations,
          budgets: DEFAULT_AGENT_BUDGETS,
          execution,
        });
        if (
          planned.source.index.id !== analyzed.index.id ||
          planned.source.index.hash !== analyzed.index.hash
        )
          throw new Error("Planner returned a source index outside the pinned analysis binding");
        const liveAfterPlanning = this.bundles.get(session.id);
        if (liveAfterPlanning?.session.status === "refresh_required") {
          const staleResultBundle: CreatorSessionBundle = {
            ...liveAfterPlanning,
            agentRuns: [...liveAfterPlanning.agentRuns, planned.evidence],
            sourceConsultations: [
              ...liveAfterPlanning.sourceConsultations,
              {
                id: planned.source.consultation.id,
                hash: planned.source.consultation.hash,
                indexId: planned.source.consultation.indexId,
                indexHash: planned.source.consultation.indexHash,
                artifact: planned.source.consultationArtifact,
              },
            ],
          };
          this.bundles.set(session.id, staleResultBundle);
          await this.persist(staleResultBundle);
          await this.publishView(
            staleResultBundle,
            "The planner AgentRun was preserved as evidence, but its candidate was discarded because Studio changed. Refresh explicitly to establish a complete current index; stale output will not be revived.",
          );
          return summary(staleResultBundle);
        }
        bundle = {
          ...bundle,
          agentRuns: [...bundle.agentRuns, planned.evidence],
          sourceConsultations: [
            ...bundle.sourceConsultations,
            {
              id: planned.source.consultation.id,
              hash: planned.source.consultation.hash,
              indexId: planned.source.consultation.indexId,
              indexHash: planned.source.consultation.indexHash,
              artifact: planned.source.consultationArtifact,
            },
          ],
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
          return this.finish(bundle, `Planner stopped: ${planned.failure.detail}`);
        }
        const outcomeArtifact = await this.artifactStore.write(planned.outcome);
        bundle = {
          ...bundle,
          agentOutcome: { outcome: planned.outcome, artifact: outcomeArtifact },
        };
        if (planned.outcome.kind === "answer") {
          session = advanceSession(session, { status: "answered" });
          bundle = { ...bundle, session };
          this.bundles.set(session.id, bundle);
          await this.persist(bundle);
          await this.publishView(bundle, planned.outcome.text);
          return summary(bundle);
        }
        if (planned.outcome.kind === "clarification_requested") {
          session = advanceSession(session, { status: "awaiting_clarification" });
          bundle = { ...bundle, session };
          this.bundles.set(session.id, bundle);
          await this.persist(bundle);
          await this.publishView(bundle, planned.outcome.question);
          return summary(bundle);
        }
        const plan = planned.outcome.plan;
        session = advanceSession(session, {
          status: "awaiting_plan_approval",
          plan,
        });
        bundle = { ...bundle, session, plan };
        this.bundles.set(session.id, bundle);
        await this.persist(bundle);
        await this.publishView(
          bundle,
          "Review the exact plan, typed changes, and generated machine-check thresholds before approving.",
        );
        return summary(bundle);
      } catch (error) {
        const liveAfterFailure = this.bundles.get(session.id);
        if (liveAfterFailure?.session.status === "refresh_required") {
          await this.publishView(
            liveAfterFailure,
            "Studio changed while planning. The failed/stale worker completion granted no authority; refresh explicitly.",
          );
          return summary(liveAfterFailure);
        }
        const detail = error instanceof Error ? error.message : String(error);
        session = advanceSession(session, {
          status: "incomplete",
          failure: {
            code: detail.startsWith("source_analysis_resource_exhausted:")
              ? "source_analysis_resource_exhausted"
              : detail.startsWith("source_analysis_failed:")
                ? "source_analysis_failed"
                : "planner_failure",
            detail,
          },
        });
        bundle = { ...bundle, session };
        return this.finish(bundle, detail);
      }
    });
  }

  /**
   * Re-enter a planner at the durable response/tool boundary. All model input,
   * source material, and execution identity are recovered from immutable
   * session artifacts; this deliberately does not recollect Studio or create a
   * fresh provider execution reservation.
   */
  private async resumePlanner(
    creatorSessionId: string,
    execution: AgentExecutionSlot,
  ): Promise<unknown> {
    const initial = await this.bundle(creatorSessionId);
    return this.lock(initial.session.id, async () => {
      let bundle = await this.bundle(creatorSessionId);
      if (bundle.session.status !== "planning")
        throw new Error("Creator response resume requires the exact planning session boundary");
      if (bundle.agentOutcome || bundle.agentRuns.length > 0)
        throw new Error(
          "Creator response resume cannot replace an already-published planner result",
        );
      const request = await this.creatorRequest(bundle);
      const sourceBinding = bundle.sourceIndices.at(-1);
      if (!sourceBinding)
        throw new Error("Creator response resume lost its immutable source-index binding");
      const sourceIndex = await this.artifactStore.read(
        sourceBinding.artifact,
        assertStudioSourceIndex,
      );
      if (sourceIndex.id !== sourceBinding.id || sourceIndex.hash !== sourceBinding.hash)
        throw new Error("Creator response resume source-index artifact binding mismatch");
      if (sourceIndex.snapshotHash !== bundle.session.currentProjectCaptureHash)
        throw new Error(
          "Creator response resume source index is outside the session capture boundary",
        );
      const projectBinding = bundle.projectIndices.find(
        (candidate) => candidate.captureHash === sourceIndex.snapshotHash,
      );
      if (!projectBinding)
        throw new Error("Creator response resume lost the source index project capture");
      const capture = await readCreatorProjectIndexArtifacts(this.artifactStore, projectBinding);
      const projectIndex = await this.observationForBundle(bundle);
      const planned = await this.input.worker.plan({
        session: bundle.session,
        ownership: bundle.ownership,
        projectIndex,
        sourceIndex,
        sourceResolver: this.projectSourceMaterial(capture).resolver,
        creatorPrompt: request.creatorText,
        agentPrompt: request.agentPrompt,
        contextCitations: request.contextCitations,
        budgets: DEFAULT_AGENT_BUDGETS,
        execution,
        resume: true,
      });
      if (
        planned.source.index.id !== sourceIndex.id ||
        planned.source.index.hash !== sourceIndex.hash
      )
        throw new Error("Resumed planner returned a source index outside the pinned boundary");
      const liveAfterPlanning = this.bundles.get(creatorSessionId);
      if (liveAfterPlanning?.session.status === "refresh_required") {
        const staleResultBundle: CreatorSessionBundle = {
          ...liveAfterPlanning,
          agentRuns: [...liveAfterPlanning.agentRuns, planned.evidence],
          sourceConsultations: [
            ...liveAfterPlanning.sourceConsultations,
            {
              id: planned.source.consultation.id,
              hash: planned.source.consultation.hash,
              indexId: planned.source.consultation.indexId,
              indexHash: planned.source.consultation.indexHash,
              artifact: planned.source.consultationArtifact,
            },
          ],
        };
        this.bundles.set(creatorSessionId, staleResultBundle);
        await this.persist(staleResultBundle);
        await this.publishView(
          staleResultBundle,
          "The resumed planner AgentRun was preserved as evidence, but Studio changed. Refresh explicitly to establish a complete current index; stale output will not be revived.",
        );
        return summary(staleResultBundle);
      }
      bundle = {
        ...bundle,
        agentRuns: [...bundle.agentRuns, planned.evidence],
        sourceConsultations: [
          ...bundle.sourceConsultations,
          {
            id: planned.source.consultation.id,
            hash: planned.source.consultation.hash,
            indexId: planned.source.consultation.indexId,
            indexHash: planned.source.consultation.indexHash,
            artifact: planned.source.consultationArtifact,
          },
        ],
      };
      if (planned.status === "unsealed") {
        const session = advanceSession(bundle.session, {
          status: "incomplete",
          failure: { code: planned.failure.code, detail: planned.failure.detail },
        });
        return this.finish(
          { ...bundle, session },
          `Resumed planner stopped: ${planned.failure.detail}`,
        );
      }
      const outcomeArtifact = await this.artifactStore.write(planned.outcome);
      bundle = { ...bundle, agentOutcome: { outcome: planned.outcome, artifact: outcomeArtifact } };
      if (planned.outcome.kind === "answer") {
        const session = advanceSession(bundle.session, { status: "answered" });
        bundle = { ...bundle, session };
        this.bundles.set(creatorSessionId, bundle);
        await this.persist(bundle);
        await this.publishView(bundle, planned.outcome.text);
        return summary(bundle);
      }
      if (planned.outcome.kind === "clarification_requested") {
        const session = advanceSession(bundle.session, { status: "awaiting_clarification" });
        bundle = { ...bundle, session };
        this.bundles.set(creatorSessionId, bundle);
        await this.persist(bundle);
        await this.publishView(bundle, planned.outcome.question);
        return summary(bundle);
      }
      const plan = planned.outcome.plan;
      const session = advanceSession(bundle.session, { status: "awaiting_plan_approval", plan });
      bundle = { ...bundle, session, plan };
      this.bundles.set(creatorSessionId, bundle);
      await this.persist(bundle);
      await this.publishView(
        bundle,
        "Review the exact plan, typed changes, and generated machine-check thresholds before approving.",
      );
      return summary(bundle);
    });
  }

  private async refreshProject(
    bundle: CreatorSessionBundle,
    execution: AgentExecutionSlot,
  ): Promise<unknown> {
    if (bundle.session.status !== "refresh_required" || bundle.activeMutation)
      throw new Error("Project refresh is unavailable while a Studio recording might exist");
    const noticeBinding = bundle.projectChanges.at(-1);
    if (!noticeBinding) throw new Error("Project refresh has no authenticated dirty notice");
    const studio = await this.currentAttestedStudioSession();
    if (studio.projectId !== bundle.session.projectId)
      throw new Error("Project refresh requires the same paired Studio project");
    const before = await this.captureForBundle(bundle);
    bundle = {
      ...bundle,
      session: advanceSession(bundle.session, { status: "refreshing" }),
    };
    this.bundles.set(bundle.session.id, bundle);
    await this.persist(bundle);
    await this.publishView(
      bundle,
      "Collecting and validating a complete project index. No provider or Studio mutation is running.",
    );

    let after: StudioProjectIndexCapture;
    try {
      after = await this.collectProjectIndex(studio);
    } catch (error) {
      const failed = {
        ...bundle,
        session: advanceSession(bundle.session, {
          status: "refresh_required",
          failure: {
            code: "project_refresh_incomplete",
            detail: detail(error),
          },
        }),
      };
      return this.finish(failed, `Project refresh remains required: ${detail(error)}`);
    }
    const afterBinding = await this.persistProjectIndex(after);
    const delta = createCreatorProjectDelta(before, after);
    const deltaArtifact = await this.artifactStore.write(delta);
    if (!delta.changed) {
      const restoredStatus = noticeBinding.priorStatus;
      let restoredSession = advanceSession(bundle.session, {
        status: restoredStatus,
        projectCapture: {
          captureHash: after.hash,
          revisionHash: after.revision.hash,
        },
      });
      let restored: CreatorSessionBundle = {
        ...bundle,
        projectIndices: [...bundle.projectIndices, afterBinding],
        session: restoredSession,
      };
      if (["planning", "building", "repairing"].includes(restoredStatus)) {
        restoredSession = advanceSession(restoredSession, {
          status: "incomplete",
          failure: {
            code: "project_change_invalidated_agent_result",
            detail:
              "Studio changed while an agent phase was running. Its AgentRun was preserved, but its candidate was discarded and cannot be revived by a later refresh.",
          },
        });
        restored = { ...restored, session: restoredSession };
      }
      const refresh = createCreatorProjectRefresh({
        predecessorSessionId: bundle.session.id,
        notice: noticeBinding.artifact,
        delta: deltaArtifact,
        beforeCaptureHash: before.hash,
        afterCaptureHash: after.hash,
        beforeRevisionHash: before.revision.hash,
        afterRevisionHash: after.revision.hash,
        outcome: "unchanged",
        refreshedAt: new Date().toISOString(),
      });
      const refreshArtifact = await this.artifactStore.write(refresh);
      restored = {
        ...restored,
        projectRefreshes: [...restored.projectRefreshes, { refresh, artifact: refreshArtifact }],
      };
      this.bundles.set(restored.session.id, restored);
      await this.persist(restored);
      await this.publishView(
        restored,
        "The complete refreshed index is unchanged. The advisory dirty state was cleared without another provider call.",
      );
      return summary(restored);
    }

    const priorRequest = await this.creatorRequest(bundle);
    const creatorPrompt = priorRequest.creatorText;
    const agentPrompt = priorRequest.agentPrompt;
    const nextView = projectIndexViewForCreator(studioProjectIndexMetadataView(after));
    const successorAuthorityState = this.input.projectAuthority?.manifest.rojo
      ? await this.persistRojoAuthorityMap(studio.projectId, after)
      : undefined;
    const successorAuthorityPaths = successorAuthorityState
      ? rojoOwnedStudioPaths(successorAuthorityState.authorityMap)
      : undefined;
    if (successorAuthorityState && !successorAuthorityPaths)
      throw new Error("Verified Rojo authority map has no Studio-visible mappings");
    const ownership =
      successorAuthorityState && successorAuthorityPaths
        ? createStudioOwnershipMap({
            projectId: studio.projectId,
            revisionHash: after.revision.hash,
            projectIndex: nextView,
            projectAuthority: this.input.projectAuthority!.manifest,
            rojoOwnedPaths: successorAuthorityPaths,
          })
        : createStudioOwnershipMap({
            projectId: studio.projectId,
            revisionHash: after.revision.hash,
            projectIndex: nextView,
            ...(this.input.projectAuthority
              ? { projectAuthority: this.input.projectAuthority.manifest }
              : {}),
          });
    const successorSession = createCreatorSession({
      prompt: creatorPrompt,
      projectId: studio.projectId,
      revisionHash: after.revision.hash,
      projectCaptureHash: after.hash,
      ownership,
      model: bundle.session.model,
    });
    const successorRequest = await this.artifactStore.write({
      kind: "CreatorRequest",
      sessionId: successorSession.id,
      promptHash: successorSession.promptHash,
      creatorText: creatorPrompt,
      agentPrompt,
      contextCitations: priorRequest.contextCitations,
    });
    const successor: CreatorSessionBundle = {
      session: successorSession,
      creatorRequest: successorRequest,
      projectIndices: [afterBinding],
      projectChanges: [],
      projectRefreshes: [],
      predecessorSessionId: bundle.session.id,
      ownership,
      ...(successorAuthorityState ? { projectAuthority: successorAuthorityState.binding } : {}),
      rojoSourceMutations: [],
      sourceIndices: [],
      sourceConsultations: [],
      sourceWriteBlobs: [],
      buildContracts: [],
      approvals: [],
      changeSets: [],
      mutationAttempts: [],
      verifications: [],
      agentRuns: [],
    };
    const refresh = createCreatorProjectRefresh({
      predecessorSessionId: bundle.session.id,
      successorSessionId: successor.session.id,
      notice: noticeBinding.artifact,
      delta: deltaArtifact,
      beforeCaptureHash: before.hash,
      afterCaptureHash: after.hash,
      beforeRevisionHash: before.revision.hash,
      afterRevisionHash: after.revision.hash,
      outcome: "superseded",
      refreshedAt: new Date().toISOString(),
    });
    const refreshArtifact = await this.artifactStore.write(refresh);
    const predecessor: CreatorSessionBundle = {
      ...bundle,
      successorSessionId: successor.session.id,
      projectIndices: [...bundle.projectIndices, afterBinding],
      projectRefreshes: [...bundle.projectRefreshes, { refresh, artifact: refreshArtifact }],
      session: advanceSession(bundle.session, {
        status: "superseded",
        projectCapture: {
          captureHash: after.hash,
          revisionHash: after.revision.hash,
        },
      }),
    };
    this.bundles.set(predecessor.session.id, predecessor);
    this.bundles.set(successor.session.id, successor);
    await Promise.all([this.persist(predecessor), this.persist(successor)]);
    await this.publishView(
      predecessor,
      `A complete refresh found a changed project. This session is superseded by ${successor.session.id}; no approval or action authority was inherited.`,
    );
    await this.publishView(
      successor,
      "Replanning from the complete refreshed project index. Studio remains read-only.",
    );
    return this.planSuccessor(
      successor,
      creatorPrompt,
      agentPrompt,
      after,
      priorRequest.contextCitations,
      execution,
    );
  }

  private async planSuccessor(
    bundle: CreatorSessionBundle,
    creatorPrompt: string,
    agentPrompt: string,
    capture: StudioProjectIndexCapture,
    contextCitations: readonly CreatorAgentContextCitation[],
    execution: AgentExecutionSlot,
  ): Promise<unknown> {
    let analyzed: Awaited<ReturnType<CreatorSessionCoordinator["analyzeProjectSources"]>>;
    try {
      analyzed = await this.analyzeProjectSources(capture);
    } catch (error) {
      const failed = {
        ...bundle,
        session: advanceSession(bundle.session, {
          status: "incomplete",
          failure: {
            code: detail(error).startsWith("source_analysis_resource_exhausted:")
              ? "source_analysis_resource_exhausted"
              : "source_analysis_failed",
            detail: detail(error),
          },
        }),
      };
      return this.finish(failed, detail(error));
    }
    bundle = {
      ...bundle,
      session: advanceSession(bundle.session, { status: "planning" }),
      sourceIndices: [
        {
          id: analyzed.index.id,
          hash: analyzed.index.hash,
          artifact: analyzed.indexArtifact,
          analysis: {
            id: analyzed.analysis.id,
            hash: analyzed.analysis.hash,
            artifact: analyzed.analysisArtifact,
          },
        },
      ],
    };
    this.bundles.set(bundle.session.id, bundle);
    await this.persist(bundle);
    const observation = await this.observationForBundle(bundle);
    const planned = await this.input.worker.plan({
      session: bundle.session,
      ownership: bundle.ownership,
      projectIndex: observation,
      sourceIndex: analyzed.index,
      sourceResolver: analyzed.resolver,
      creatorPrompt,
      agentPrompt,
      contextCitations,
      budgets: DEFAULT_AGENT_BUDGETS,
      execution,
    });
    if (
      planned.source.index.id !== analyzed.index.id ||
      planned.source.index.hash !== analyzed.index.hash
    )
      throw new Error("Planner returned a source index outside the pinned analysis binding");
    let next: CreatorSessionBundle = {
      ...bundle,
      agentRuns: [...bundle.agentRuns, planned.evidence],
      sourceConsultations: [
        ...bundle.sourceConsultations,
        {
          id: planned.source.consultation.id,
          hash: planned.source.consultation.hash,
          indexId: planned.source.consultation.indexId,
          indexHash: planned.source.consultation.indexHash,
          artifact: planned.source.consultationArtifact,
        },
      ],
    };
    if (planned.status === "unsealed") {
      next = {
        ...next,
        session: advanceSession(next.session, {
          status: "incomplete",
          failure: planned.failure,
        }),
      };
      return this.finish(next, `Planner stopped: ${planned.failure.detail}`);
    }
    const outcomeArtifact = await this.artifactStore.write(planned.outcome);
    next = {
      ...next,
      agentOutcome: { outcome: planned.outcome, artifact: outcomeArtifact },
    };
    if (planned.outcome.kind === "answer") {
      next = {
        ...next,
        session: advanceSession(next.session, { status: "answered" }),
      };
      this.bundles.set(next.session.id, next);
      await this.persist(next);
      await this.publishView(next, planned.outcome.text);
      return summary(next);
    }
    if (planned.outcome.kind === "clarification_requested") {
      next = {
        ...next,
        session: advanceSession(next.session, { status: "awaiting_clarification" }),
      };
      this.bundles.set(next.session.id, next);
      await this.persist(next);
      await this.publishView(next, planned.outcome.question);
      return summary(next);
    }
    const plan = planned.outcome.plan;
    next = {
      ...next,
      plan,
      session: advanceSession(next.session, {
        status: "awaiting_plan_approval",
        plan,
      }),
    };
    this.bundles.set(next.session.id, next);
    await this.persist(next);
    await this.publishView(
      next,
      "Review the replanned exact artifacts. No approval or action authority was inherited from the superseded session.",
    );
    return summary(next);
  }

  private async decidePlan(
    bundle: CreatorSessionBundle,
    hash: string,
    decision: "approved" | "rejected",
    execution?: AgentExecutionSlot,
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
    if (!execution) throw new Error("Approved plan has no preassigned builder execution");
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
    const creatorPrompt = await this.creatorPrompt(bundle);
    const agentPrompt = await this.agentPrompt(bundle);
    try {
      const source = await this.sourceEvidence(bundle);
      const observation = await this.observationForBundle(bundle);
      const built = await this.input.worker.build({
        session,
        ownership: bundle.ownership,
        projectIndex: observation,
        creatorPrompt,
        agentPrompt,
        plan,
        planApproval: approval,
        ...source,
        budgets: DEFAULT_AGENT_BUDGETS,
        execution,
      });
      const liveAfterBuild = this.bundles.get(session.id);
      if (liveAfterBuild?.session.status === "refresh_required") {
        const staleResultBundle: CreatorSessionBundle = {
          ...liveAfterBuild,
          buildContracts: [...liveAfterBuild.buildContracts, built.buildContract],
          agentRuns: [...liveAfterBuild.agentRuns, built.evidence],
        };
        this.bundles.set(session.id, staleResultBundle);
        await this.persist(staleResultBundle);
        await this.publishView(
          staleResultBundle,
          "The builder AgentRun was preserved as evidence, but its candidate was discarded because Studio changed. Refresh explicitly to establish a complete current index; stale output will not be revived.",
        );
        return summary(staleResultBundle);
      }
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
      bundle = await this.retainSourceWriteBlobs(bundle, built.sourceWriteBlobs);
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
      const liveAfterFailure = this.bundles.get(session.id);
      if (liveAfterFailure?.session.status === "refresh_required") {
        await this.publishView(
          liveAfterFailure,
          "Studio changed while building. The failed/stale worker completion granted no authority; refresh explicitly.",
        );
        return summary(liveAfterFailure);
      }
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
    repairExecution?: AgentExecutionSlot,
  ): Promise<unknown> {
    const changeSet = requiredChangeSet(bundle);
    if (bundle.session.status !== "awaiting_change_approval" || changeSet.hash !== hash)
      throw new Error("Change approval does not match the active immutable change set");
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
    if (decision === "approved") {
      if (!repairExecution)
        throw new Error("Approved change has no preassigned verification-repair execution");
      try {
        return await this.apply(bundle, repairExecution);
      } catch (error) {
        const current = this.bundles.get(bundle.session.id) ?? bundle;
        if (error instanceof ProjectAuthorityRevokedError) return summary(current);
        if (error instanceof CreatorPreRecordingFailure)
          return this.failIncomplete(current, error.diagnosticCode, error.message);
        if (current.session.status === "preflighting")
          return this.failIncomplete(
            current,
            "creator_pre_recording_failure_unclassified",
            `The creator transaction stopped before a recording could open, outside a classified source, Prepare, preflight, evidence-persistence, or durable-intent boundary: ${detail(error)}`,
          );
        if (["applying", "cancelling", "committing"].includes(current.session.status)) {
          const recoveryBundle = {
            ...current,
            session: advanceSession(current.session, {
              status: "recovery_required",
              failure: {
                code: "studio_transaction_interrupted",
                detail: `Studio transaction transport stopped after a recording might have opened: ${detail(error)}`,
              },
            }),
          };
          return this.finish(
            recoveryBundle,
            "Studio may retain the exact approved recording. Forge did not retry, commit, cancel, or assume rollback; reconnect the connector to inspect durable transaction state.",
          );
        }
        throw error;
      }
    }
    return this.finish(bundle, "The creator rejected the change set.");
  }

  /**
   * The source-authority path is intentionally outside ChangeHistory. It
   * makes a sealed, source-only translation and then waits for a later
   * complete Studio index; no filesystem receipt is treated as synchronization
   * proof and no Studio transaction is opened here.
   */
  private async applyRojoSourceChanges(
    bundle: CreatorSessionBundle,
    authority: ProjectAuthorityLease,
  ): Promise<unknown> {
    const guarded = <T>(operation: Promise<T>) => this.awaitProjectAuthority(authority, operation);
    const assertAuthority = () => this.assertProjectAuthority(authority);
    if (
      bundle.session.status !== "preflighting" ||
      requiredChangeSet(bundle).mutationAuthority !== "rojo_source"
    )
      throw new Error("Rojo source changes require a preflighting Rojo-owned session");
    const context = this.input.projectAuthority;
    if (!context?.rojo) throw new Error("Rojo source authority has no verified host context");
    const studio = await guarded(this.currentAttestedStudioSession());
    const before = await guarded(this.collectProjectIndex(studio, authority));
    bundle = await guarded(this.retainProjectIndex(bundle, before, authority));
    const authorityMap = await guarded(this.rojoAuthorityMap(bundle));
    if (
      authorityMap.manifestHash !== contentHash(stableJson(context.manifest)) ||
      !authorityMap.rojo ||
      authorityMap.rojo.sourcemap.hash !== context.rojo.sourcemap.hash ||
      authorityMap.studioRevisionHash !== before.revision.hash
    )
      throw new Error("Rojo source-authority host context or pre-Apply revision binding changed");
    const changeSet = requiredChangeSet(bundle);
    if (before.revision.hash !== changeSet.expectedRevisionHash)
      return guarded(
        this.drift(
          bundle,
          `Complete pre-Apply Studio index differs from the approved revision: expected ${changeSet.expectedRevisionHash}, observed ${before.revision.hash}.`,
          authority,
        ),
      );

    const sourceChangeSet = await guarded(
      this.translateRojoSourceChangeSet(bundle, changeSet, authorityMap, before),
    );
    const sourceChangeSetArtifact = await guarded(this.artifactStore.write(sourceChangeSet));
    bundle = {
      ...bundle,
      session: advanceSession(bundle.session, { status: "applying" }),
    };
    assertAuthority();
    this.bundles.set(bundle.session.id, bundle);
    await guarded(this.persist(bundle));

    let attempt: RojoMutationAttempt;
    try {
      attempt = await guarded(
        applyRojoSourceChangeSet({
          workspaceRoot: context.workspaceRoot,
          authorityMap,
          changeSet: sourceChangeSet,
        }),
      );
    } catch (error) {
      if (error instanceof ProjectAuthorityRevokedError) throw error;
      if (error instanceof RojoMutationApplyError) {
        const partialArtifact = await guarded(this.artifactStore.write(error.attempt));
        const incomplete = {
          ...bundle,
          rojoSourceMutations: [
            ...bundle.rojoSourceMutations,
            {
              changeSet: {
                id: sourceChangeSet.id,
                hash: sourceChangeSet.hash,
                artifact: sourceChangeSetArtifact,
              },
              attempt: {
                id: error.attempt.id,
                hash: error.attempt.hash,
                artifact: partialArtifact,
              },
              syncProofs: [],
              revertSyncProofs: [],
            },
          ],
          session: advanceSession(bundle.session, {
            status: "recovery_required",
            failure: {
              code: "rojo_source_write_partially_applied",
              detail:
                "A guarded filesystem write stopped after a partial attempt. Forge did not infer a rollback; explicitly revert the exact source attempt, then prove the reverse Studio synchronization.",
            },
          }),
        };
        return guarded(
          this.finish(
            incomplete,
            "A guarded Rojo source write was only partially applied. Filesystem and Studio state require explicit recovery; Forge made no automatic rollback.",
            authority,
          ),
        );
      }
      throw error;
    }
    const attemptArtifact = await guarded(this.artifactStore.write(attempt));
    const awaiting = createRojoSyncProof({
      attempt,
      changeSet: sourceChangeSet,
    });
    const syncArtifact = await guarded(this.artifactStore.write(awaiting));
    const next: CreatorSessionBundle = {
      ...bundle,
      rojoSourceMutations: [
        ...bundle.rojoSourceMutations,
        {
          changeSet: {
            id: sourceChangeSet.id,
            hash: sourceChangeSet.hash,
            artifact: sourceChangeSetArtifact,
          },
          attempt: {
            id: attempt.id,
            hash: attempt.hash,
            artifact: attemptArtifact,
          },
          syncProofs: [{ id: awaiting.id, hash: awaiting.hash, artifact: syncArtifact }],
          revertSyncProofs: [],
        },
      ],
      session: advanceSession(bundle.session, {
        status: "awaiting_source_sync",
      }),
    };
    return guarded(
      this.finish(
        next,
        "The guarded Rojo source write has immutable receipts. Click Check Source Sync after the project has synchronized so a complete Studio index can prove the mapped source and every non-source fact.",
        authority,
      ),
    );
  }

  private async translateRojoSourceChangeSet(
    bundle: CreatorSessionBundle,
    changeSet: CreatorChangeSet,
    authorityMap: ProjectAuthorityMap,
    before: StudioProjectIndexCapture,
  ): Promise<RojoSourceChangeSet> {
    if (!authorityMap.rojo)
      throw new Error("Rojo source change translation requires a Rojo authority map");
    const beforeView = studioProjectIndexMetadataView(before);
    const captures = new Map(
      (await this.sourceWriteCaptures(bundle, changeSet)).map((capture) => [
        capture.manifest.hash,
        capture,
      ]),
    );
    const sourceText = (binding: import("./index.js").CreatorSourceWriteBlobBinding): string => {
      const capture = captures.get(binding.manifestHash);
      if (!capture) throw new Error("Rojo source operation lost its immutable source-write blob");
      return capture.chunks.map((chunk) => chunk.utf8).join("");
    };
    const operations = changeSet.operations.map((operation) => {
      if (operation.kind === "edit_source") {
        return {
          id: operation.id,
          kind: "edit_source" as const,
          studioPath: operation.target.path,
          className: operation.target.className,
          beforeHash: operation.beforeSourceHash,
          edits: operation.edits.map((edit) => ({
            startByte: edit.startByte,
            endByte: edit.endByte,
            replacement: sourceText(edit.replacementBlob),
          })),
          finalSourceHash: operation.finalSourceHash,
          finalByteCount: operation.finalByteCount,
        };
      }
      if (
        operation.kind === "create" &&
        isRojoSourceClass(operation.className) &&
        operation.sourceBlob !== undefined &&
        Object.keys(operation.properties).length === 0 &&
        Object.keys(operation.attributes).length === 0
      ) {
        const directory = authorityMap.rojo!.sourcemap.directories.find(
          (entry) => entry.studioPath === operation.parent.path,
        );
        if (!directory)
          throw new Error(
            `Rojo source creation parent is not an exact mapped directory: ${operation.parent.path}`,
          );
        return {
          id: operation.id,
          kind: "create_source" as const,
          parentStudioPath: operation.parent.path,
          name: operation.name,
          className: operation.className,
          sourcePath: `${directory.directoryPath}/${rojoSourceFilename(operation.name, operation.className)}`,
          source: sourceText(operation.sourceBlob),
        };
      }
      throw new Error("Rojo source authority rejects a mixed or non-source CreatorChangeSet");
    });
    return createRojoSourceChangeSet({
      id: `rojo_source_change_${changeSet.id}`,
      authorityMap,
      beforeStudioRevisionHash: before.revision.hash,
      beforeStudioNonSourceHash: rojoStudioNonSourceHash(beforeView),
      afterStudioNonSourceHash: rojoStudioNonSourceHash(beforeView, operations),
      operations,
    });
  }

  private async checkRojoSourceSync(bundle: CreatorSessionBundle): Promise<unknown> {
    if (
      bundle.session.status !== "awaiting_source_sync" ||
      requiredChangeSet(bundle).mutationAuthority !== "rojo_source"
    )
      throw new Error("Creator session is not awaiting a Rojo source synchronization proof");
    const mutation = bundle.rojoSourceMutations.at(-1);
    if (!mutation) throw new Error("Rojo source synchronization has no mutation attempt");
    const [changeSet, attempt] = await Promise.all([
      this.artifactStore.read(mutation.changeSet.artifact, assertRojoSourceChangeSet),
      this.artifactStore.read(mutation.attempt.artifact, assertRojoMutationAttempt),
    ]);
    const studio = await this.currentAttestedStudioSession();
    const capture = await this.collectProjectIndex(studio);
    bundle = await this.retainProjectIndex(bundle, capture);
    const observation = rojoSyncObservation(
      capture,
      mutation.revert
        ? attempt.beforeFilesystemRevision.entries
        : attempt.afterFilesystemRevision.entries,
    );
    if (mutation.revert) {
      const revert = await this.artifactStore.read(
        mutation.revert.artifact,
        assertRojoSourceRevert,
      );
      const proof = createRojoSourceRevertSyncProof({
        revert,
        changeSet,
        observation,
      });
      const artifact = await this.artifactStore.write(proof);
      const next = appendRojoRevertProof(bundle, mutation.attempt.id, {
        id: proof.id,
        hash: proof.hash,
        artifact,
      });
      if (proof.status === "matched") {
        return this.finish(
          {
            ...next,
            session: advanceSession(next.session, {
              status: "incomplete",
              failure: {
                code: "rojo_source_changes_reverted",
                detail:
                  "The explicit guarded filesystem revert and complete Studio reverse-sync proof matched exactly.",
              },
            }),
          },
          "Source changes were explicitly reverted and the complete Studio index proves the original mapped source and non-source state.",
        );
      }
      return this.finish(
        next,
        rojoProofDetail("The revert has not synchronized exactly", proof.failureFacts),
      );
    }
    const proof = createRojoSyncProof({ attempt, changeSet, observation });
    const artifact = await this.artifactStore.write(proof);
    const next = appendRojoForwardProof(bundle, mutation.attempt.id, {
      id: proof.id,
      hash: proof.hash,
      artifact,
    });
    if (proof.status === "matched") {
      return this.finish(
        {
          ...next,
          session: advanceSession(next.session, { status: "awaiting_review" }),
        },
        "Complete Studio index evidence exactly matches the guarded Rojo source mutation. Review the result; this proof establishes source synchronization, not gameplay behavior.",
      );
    }
    return this.finish(
      next,
      rojoProofDetail(
        "Source synchronization does not yet match the exact approved evidence",
        proof.failureFacts,
      ),
    );
  }

  private async revertRojoSourceChanges(bundle: CreatorSessionBundle): Promise<unknown> {
    if (
      !isRojoRevertStatus(bundle.session.status) ||
      requiredChangeSet(bundle).mutationAuthority !== "rojo_source"
    )
      throw new Error("Creator session has no reversible Rojo source mutation");
    const mutation = bundle.rojoSourceMutations.at(-1);
    const context = this.input.projectAuthority;
    if (!mutation || mutation.revert || !context?.rojo)
      throw new Error(
        "Rojo source mutation is absent, already reverted, or lacks its verified host context",
      );
    const [authorityMap, attempt] = await Promise.all([
      this.rojoAuthorityMap(bundle),
      this.artifactStore.read(mutation.attempt.artifact, assertRojoMutationAttempt),
    ]);
    const recoveryRoot = await mkdtemp(join(tmpdir(), "forge-rojo-source-recovery-"));
    let revert: RojoSourceRevert;
    try {
      revert = await revertRojoSourceMutation({
        workspaceRoot: context.workspaceRoot,
        recoveryRoot,
        authorityMap,
        attempt,
      });
    } catch (error) {
      const next = {
        ...bundle,
        session: advanceSession(bundle.session, {
          status: "recovery_required",
          failure: {
            code: "rojo_source_revert_failed",
            detail: `Explicit source revert failed without an automatic retry: ${detail(error)}`,
          },
        }),
      };
      return this.finish(
        next,
        "Forge could not complete the guarded filesystem revert. The source attempt remains recoverable only through an explicit, exact recovery action.",
      );
    }
    const artifact = await this.artifactStore.write(revert);
    const next = appendRojoRevert(bundle, mutation.attempt.id, {
      id: revert.id,
      hash: revert.hash,
      artifact,
    });
    return this.finish(
      {
        ...next,
        session:
          next.session.status === "awaiting_source_sync"
            ? next.session
            : advanceSession(next.session, { status: "awaiting_source_sync" }),
      },
      "The filesystem source mutation was explicitly reverted with guarded receipts. Click Check Source Sync after Studio has synchronized to prove the reverse result.",
    );
  }

  private async apply(
    bundle: CreatorSessionBundle,
    repairExecution: AgentExecutionSlot,
  ): Promise<unknown> {
    const authority = this.acquireProjectAuthority(bundle.session.projectId);
    const guarded = <T>(operation: Promise<T>) => this.awaitProjectAuthority(authority, operation);
    const assertAuthority = () => this.assertProjectAuthority(authority);
    const changeSet = requiredChangeSet(bundle);
    const changeApproval = bundle.session.changeApproval;
    if (bundle.session.status !== "preflighting" || !changeApproval)
      throw new Error("Creator change set is not approved for application");
    if (!bundle.plan) throw new Error("Creator change set has no approved verification charter");
    if (requiredChangeSet(bundle).mutationAuthority === "rojo_source")
      return this.applyRojoSourceChanges(bundle, authority);
    const approvedIndex = await guarded(this.captureForBundle(bundle));
    const charterExecution = createCharterExecution(
      bundle.plan.charter.clauses,
      studioProjectIndexMetadataView(approvedIndex),
      changeSet,
    );
    const verificationRunId = `creator_verify_${randomUUID()}`;
    const verificationCorrelationId = `creator_correlation_${randomUUID()}`;
    const studio = await guarded(this.currentAttestedStudioSession());
    const attestation = this.attestations.get(studio.sessionId);
    if (!attestation || attestation.status !== "verified")
      throw new Error("The paired Studio connector has no verified capability attestation");
    try {
      await guarded(this.requireClearRecordingInventory(studio));
    } catch (error) {
      return guarded(
        this.failIncomplete(
          bundle,
          "creator_transaction_inventory_not_clear",
          `Studio transaction inventory changed after approval and before mutation: ${detail(error)}`,
          authority,
        ),
      );
    }
    if (studio.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH)
      return guarded(
        this.failIncomplete(
          bundle,
          "incompatible_studio_manifest",
          "The paired connector does not implement the approved Studio capability manifest.",
          authority,
        ),
      );
    const dashboardReviewHash = this.views.get(bundle.session.id)?.hash ?? changeApproval.hash;
    const binding: StudioEvidenceBinding = {
      sessionId: bundle.session.id,
      changeSetHash: changeSet.hash,
      approvalHash: changeApproval.hash,
      revisionHash: changeSet.expectedRevisionHash,
      buildHash: changeSet.buildContractHash,
      dashboardReviewHash,
    };
    createStudioExecutionPlan({
      purpose: "creator_verification",
      binding: {
        runId: verificationRunId,
        correlationId: verificationCorrelationId,
        sessionId: studio.sessionId,
        projectId: studio.projectId,
        project: studio.project,
        projectRevisionHash: changeSet.expectedRevisionHash,
      },
      targets: charterExecution.targets,
      calls: charterExecution.calls,
      budget: {
        maxExecutionMs: STUDIO_CAPABILITY_MANIFEST.limits.maximumRuntimeMs,
        maxResultBytes: STUDIO_CAPABILITY_MANIFEST.limits.maximumRuntimeResultBytes,
      },
      observationWindowMs: CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS,
    });
    let beforeIndexCapture: StudioProjectIndexCapture;
    try {
      beforeIndexCapture = await guarded(this.collectProjectIndex(studio, authority));
      bundle = await guarded(this.retainProjectIndex(bundle, beforeIndexCapture, authority));
    } catch (error) {
      return guarded(
        this.failIncomplete(
          bundle,
          "project_index_incomplete",
          `Forge could not establish a complete pre-Apply project revision: ${detail(error)}`,
          authority,
        ),
      );
    }
    try {
      assertCreatorTransactionTopologyOrder({
        initial: studioProjectIndexMetadataView(beforeIndexCapture).instances,
        operations: changeSet.operations,
      });
    } catch (error) {
      return guarded(
        this.failIncomplete(
          bundle,
          "creator_transaction_topology_invalid",
          `The approved change set cannot form one valid Studio transaction: ${detail(error)}`,
          authority,
        ),
      );
    }
    const initialTopology = studioProjectIndexMetadataView(beforeIndexCapture).instances;
    const deletedSubtrees = creatorDeleteSubtreesFromProjectIndex(changeSet, beforeIndexCapture);
    const structuralParents = creatorStructuralParentsFromProjectIndex(
      changeSet,
      beforeIndexCapture,
    );
    const projection = compileCreatorChangeSetMutationProjection(changeSet, {
      project: studio.project,
      binding,
      initialTopology,
      deletedSubtrees,
      structuralParents,
    });
    const preflightProjection = compileCreatorChangeSetMutationProjection(changeSet, {
      project: studio.project,
      binding,
      initialTopology,
      deletedSubtrees,
      structuralParents,
      purpose: "mutation_preflight",
    });
    const changeSetEvidence: CreatorMutationChangeSetLike = {
      kind: "CreatorChangeSet",
      id: changeSet.id,
      hash: changeSet.hash,
      project: studio.project,
      binding,
      projectionId: projection.id,
      operations: adaptCreatorChangeSetMutationOperations(
        changeSet,
        initialTopology,
        deletedSubtrees,
        structuralParents,
      ),
    };
    const attemptId = `creator_mutation_attempt_${changeSet.hash.slice(0, 24)}_${changeSet.attempt}`;
    const exactTransaction = {
      creatorSessionId: bundle.session.id,
      changeSetId: changeSet.id,
      changeSetHash: changeSet.hash,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      preflightProjectionId: preflightProjection.id,
      preflightProjectionHash: preflightProjection.contentHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      beforeProjectIndexManifestId: beforeIndexCapture.indexManifest.id,
      beforeProjectRevisionHash: beforeIndexCapture.revision.hash,
      beforeProjectDetectorEpoch: beforeIndexCapture.detectorEpoch,
    } as const;
    if (beforeIndexCapture.revision.hash !== changeSet.expectedRevisionHash) {
      const driftDetail = `Complete pre-Apply Studio index differs from the approved revision: expected ${changeSet.expectedRevisionHash}, observed ${beforeIndexCapture.revision.hash}.`;
      bundle = await guarded(
        this.recordIncompletePreflightAttempt(
          bundle,
          attemptId,
          changeSetEvidence,
          projection,
          preflightProjection,
          beforeIndexCapture,
          attestation,
          driftDetail,
          "project_drift",
          undefined,
          authority,
        ),
      );
      return guarded(this.drift(bundle, driftDetail, authority));
    }
    const messages: PluginToBackendMessage[] = [];
    const indexStreams = new StudioProjectIndexStreamRouter();
    const unsubscribe = this.capture(studio, messages, indexStreams);
    const requestId = `creator_apply_${randomUUID()}`;
    let preRecordingPhase: CreatorPreRecordingPhase = "source_transfer";
    let receivedPreflightEvidence: StudioEvidenceEnvelope | undefined;
    assertAuthority();
    this.beginFinalizationRequest(requestId);
    try {
      // The plugin must acknowledge every hash-bound immutable source blob
      // before it even parses the sealed change set.  A transport restart
      // therefore cannot turn a missing large source into an implicit body or
      // a partial Prepare.
      for (const sourceWrite of await guarded(this.sourceWriteCaptures(bundle, changeSet)))
        await guarded(
          this.streamSourceWriteCapture(studio, requestId, sourceWrite, messages, authority),
        );
      const json = serializeCreatorChangeSet(changeSet);
      const projectionJson = serializeStudioEvidenceProjection(projection);
      const preflightProjectionJson = serializeStudioEvidenceProjection(preflightProjection);
      preRecordingPhase = "prepare_transport";
      assertAuthority();
      await guarded(
        this.streamCreatorChangePrepare(
          studio,
          {
            requestId,
            creatorSessionId: bundle.session.id,
            expectedProjectRevisionHash: beforeIndexCapture.revision.hash,
            changeSetJson: json,
            changeSetJsonHash: contentHash(json),
            changeSetId: changeSet.id,
            changeSetHash: changeSet.hash,
            approvalHash: changeApproval.hash,
            dashboardReviewHash,
            manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
            projectionJson,
            projectionJsonHash: contentHash(projectionJson),
            projectionHash: projection.contentHash,
            preflightProjectionJson,
            preflightProjectionJsonHash: contentHash(preflightProjectionJson),
            preflightProjectionHash: preflightProjection.contentHash,
            beforeProjectIndexManifestId: beforeIndexCapture.indexManifest.id,
            beforeProjectRevisionHash: beforeIndexCapture.revision.hash,
            beforeProjectDetectorEpoch: beforeIndexCapture.detectorEpoch,
          },
          authority,
        ),
      );
      await guarded(
        waitFor(
          messages,
          (
            message,
          ): message is Extract<PluginToBackendMessage, { type: "CreatorChangePrepared" }> =>
            message.type === "CreatorChangePrepared" &&
            message.requestId === requestId &&
            matchesExactPreparedTransaction(message.payload, exactTransaction) &&
            message.payload.status === "prepared",
          this.timeout(),
          "creator change preparation",
          requestId,
        ),
      );
      preRecordingPhase = "preflight_transport";
      assertAuthority();
      await guarded(
        this.input.connection.send(
          createBackendMessage(
            "PreflightCreatorChangeSet",
            {
              requestId,
              creatorSessionId: bundle.session.id,
              changeSetId: changeSet.id,
              changeSetHash: changeSet.hash,
              projectionId: projection.id,
              projectionHash: projection.contentHash,
              preflightProjectionId: preflightProjection.id,
              preflightProjectionHash: preflightProjection.contentHash,
              manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
              expectedProjectRevisionHash: beforeIndexCapture.revision.hash,
              beforeProjectIndexManifestId: beforeIndexCapture.indexManifest.id,
              beforeProjectDetectorEpoch: beforeIndexCapture.detectorEpoch,
            },
            studio.sessionId,
            requestId,
          ),
        ),
      );
      const preflight = await guarded(
        waitFor(
          messages,
          (
            message,
          ): message is Extract<
            PluginToBackendMessage,
            { type: "CreatorChangePreflighted" | "CreatorMutationFailed" }
          > =>
            message.requestId === requestId &&
            (message.type === "CreatorChangePreflighted" ||
              message.type === "CreatorMutationFailed") &&
            (message.type !== "CreatorMutationFailed" || message.payload.stage === "preflight") &&
            matchesExactPreparedTransaction(message.payload, exactTransaction),
          this.timeout(),
          "creator mutation preflight",
          requestId,
        ),
      );
      if (preflight.type === "CreatorMutationFailed") {
        bundle = await guarded(
          this.recordIncompletePreflightAttempt(
            bundle,
            attemptId,
            changeSetEvidence,
            projection,
            preflightProjection,
            beforeIndexCapture,
            attestation,
            preflight.payload.failureDetail,
            preflight.payload.failureCode,
            undefined,
            authority,
          ),
        );
        return guarded(
          this.failIncomplete(
            bundle,
            preflight.payload.failureCode,
            preflight.payload.failureDetail,
            authority,
          ),
        );
      }
      preRecordingPhase = "preflight_evidence_persistence";
      receivedPreflightEvidence = preflight.payload.preflightEvidence;
      await guarded(this.artifactStore.write(preflightProjection));
      await guarded(this.artifactStore.write(preflight.payload.preflightEvidence));
      if (
        preflight.payload.status !== "passed" ||
        preflight.payload.preflightEvidence.completion !== "complete"
      ) {
        const failureDetail =
          preflight.payload.failureCode ?? "Detached mutation preflight evidence was incomplete.";
        bundle = await guarded(
          this.recordIncompletePreflightAttempt(
            bundle,
            attemptId,
            changeSetEvidence,
            projection,
            preflightProjection,
            beforeIndexCapture,
            attestation,
            failureDetail,
            "capability_preflight_failed",
            preflight.payload.preflightEvidence,
            authority,
          ),
        );
        return guarded(
          this.failIncomplete(bundle, "capability_preflight_failed", failureDetail, authority),
        );
      }
      assertEvidenceAgainstProjection(preflight.payload.preflightEvidence, preflightProjection);
      let activeMutation = await guarded(
        this.createActiveMutation(
          attemptId,
          changeSet,
          changeSetEvidence,
          projection,
          preflightProjection,
          preflight.payload.preflightEvidence,
          beforeIndexCapture,
          attestation,
        ),
      );
      preRecordingPhase = "durable_intent";
      activeMutation = { ...activeMutation, stage: "recording_may_be_open" };
      const applyingBundle = {
        ...bundle,
        activeMutation,
        session: advanceSession(bundle.session, { status: "applying" }),
      };
      assertAuthority();
      // Persist the exact effect intent before exposing the in-memory
      // `applying` state or sending Studio the command. If this atomic write
      // fails, no recording can have opened and the pre-recording diagnostic
      // remains `durable_intent`; after it succeeds, restart must conservatively
      // treat the recording as possibly open.
      await guarded(this.persist(applyingBundle));
      bundle = applyingBundle;
      this.bundles.set(bundle.session.id, bundle);
      assertAuthority();
      await guarded(
        this.input.connection.send(
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
              expectedProjectRevisionHash: beforeIndexCapture.revision.hash,
              beforeProjectIndexManifestId: beforeIndexCapture.indexManifest.id,
              beforeProjectDetectorEpoch: beforeIndexCapture.detectorEpoch,
            },
            studio.sessionId,
            requestId,
          ),
        ),
      );
      const applied = await guarded(
        waitFor(
          messages,
          (
            message,
          ): message is Extract<
            PluginToBackendMessage,
            { type: "CreatorMutationProvisional" | "CreatorMutationFailed" }
          > =>
            (message.type === "CreatorMutationProvisional" ||
              message.type === "CreatorMutationFailed") &&
            message.requestId === requestId &&
            matchesExactTransactionBinding(message.payload, exactTransaction) &&
            (message.type !== "CreatorMutationFailed" ||
              ((["apply", "readback", "post_state"] as readonly string[]).includes(
                message.payload.stage,
              ) &&
                matchesExactPreparedTransaction(message.payload, exactTransaction))),
          this.timeout(),
          "provisional creator mutation",
          requestId,
        ),
      );
      if (applied.type === "CreatorMutationFailed") {
        const failedRecordingId = applied.payload.recordingId;
        const failureFacts = createMutationFailureFacts([
          {
            code: applied.payload.failureCode,
            detail: applied.payload.failureDetail,
          },
        ]);
        if (
          applied.payload.stage === "apply" &&
          applied.payload.recordingId === undefined &&
          applied.payload.recordingState === "not_open"
        ) {
          bundle = await guarded(this.recordIncompleteDurableIntentAttempt(bundle, failureFacts));
          bundle = {
            ...bundle,
            session: advanceSession(bundle.session, {
              status: "incomplete",
              failure: {
                code: applied.payload.failureCode,
                detail: `Studio rejected the exact Apply command before TryBeginRecording. No Studio recording or place mutation was attempted: ${applied.payload.failureDetail}`,
              },
            }),
          };
          assertAuthority();
          this.bundles.set(bundle.session.id, bundle);
          await guarded(this.persist(bundle));
          return guarded(
            this.finish(
              bundle,
              "Studio rejected Apply before opening a recording. The exact failure is preserved and no place mutation was attempted.",
              authority,
            ),
          );
        }
        const failureEvidence = {
          kind: "CreatorMutationExecutionFailure" as const,
          attemptId,
          failureFacts,
        };
        const executionFailure = await guarded(
          this.mutationBinding(failureEvidence, contentHash(stableJson(failureEvidence))),
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
              detail: applied.payload.failureDetail,
            },
          }),
        };
        assertAuthority();
        this.bundles.set(bundle.session.id, bundle);
        await guarded(this.persist(bundle));
        if (
          applied.payload.recordingState !== "not_open" ||
          applied.payload.cancellationProven !== true ||
          failedRecordingId === undefined
        )
          return guarded(
            this.finish(
              bundle,
              `Studio mutation failed and exact cancellation is not yet proven: ${applied.payload.failureDetail}`,
              authority,
            ),
          );
        const finalized = await guarded(
          waitFor(
            messages,
            (
              message,
            ): message is Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }> =>
              message.type === "CreatorChangeFinalized" &&
              message.requestId === requestId &&
              message.payload.creatorSessionId === bundle.session.id &&
              message.payload.changeSetId === changeSet.id &&
              message.payload.changeSetHash === changeSet.hash &&
              message.payload.projectionId === projection.id &&
              message.payload.projectionHash === projection.contentHash &&
              message.payload.manifestHash === STUDIO_CAPABILITY_MANIFEST_HASH &&
              message.payload.beforeProjectIndexManifestId ===
                beforeIndexCapture.indexManifest.id &&
              message.payload.beforeProjectRevisionHash === beforeIndexCapture.revision.hash &&
              message.payload.beforeProjectDetectorEpoch === beforeIndexCapture.detectorEpoch &&
              message.payload.recordingId === failedRecordingId &&
              message.payload.expectedCurrentProjectIndexManifestId ===
                beforeIndexCapture.indexManifest.id &&
              message.payload.expectedCurrentProjectRevisionHash ===
                beforeIndexCapture.revision.hash &&
              message.payload.expectedCurrentProjectDetectorEpoch ===
                beforeIndexCapture.detectorEpoch &&
              message.payload.action === "cancel" &&
              message.payload.finalizationKind === "ordinary" &&
              message.payload.status === "cancelled",
            this.timeout(),
            "failed creator mutation cancellation finalization",
            requestId,
          ),
        );
        const finalIndexCapture = await guarded(
          this.waitForTransactionProjectIndex(
            messages,
            finalized.requestId!,
            finalized.payload.afterProjectIndexManifestId,
            finalized.payload.afterProjectRevisionHash,
            finalized.payload.afterProjectDetectorEpoch,
            "failed creator mutation cancellation project index",
            indexStreams,
          ),
        );
        bundle = await guarded(this.retainProjectIndex(bundle, finalIndexCapture, authority));
        bundle = await guarded(
          this.confirmFinalizedTransactionProjectChanges(bundle, studio, finalIndexCapture),
        );
        if (
          bundle.session.status === "recovery_required" ||
          this.hasPendingTransactionProjectChange(bundle.session.id)
        )
          return summary(bundle);
        bundle = await guarded(
          this.recordIncompleteApplyAttempt(bundle, finalized, finalIndexCapture, failureFacts),
        );
        const attempt = bundle.mutationAttempts.find((candidate) => candidate.id === attemptId)!;
        const { activeMutation: _activeMutation, ...settledBundle } = bundle;
        bundle = recordObservation(
          {
            ...settledBundle,
            session: advanceSession(bundle.session, {
              status: "incomplete",
              projectCapture: {
                captureHash: finalIndexCapture.hash,
                revisionHash: finalIndexCapture.revision.hash,
              },
              failure: {
                code: "mutation_execution_failed",
                detail: applied.payload.failureDetail,
              },
            }),
          },
          finalIndexCapture.revision.hash,
          projectIndexViewForCreator(studioProjectIndexMetadataView(finalIndexCapture)),
        );
        const result = await guarded(
          this.finish(
            bundle,
            "The failed Studio mutation proved its cancellation and preserved complete post-cancel evidence. No mutation verdict was invented.",
            authority,
          ),
        );
        await guarded(this.acknowledgeFinalization(studio, finalized, attempt.hash, authority));
        return result;
      }
      assertEvidenceAgainstProjection(applied.payload.directReadbackEvidence, projection);
      const afterIndexCapture = await guarded(
        this.waitForTransactionProjectIndex(
          messages,
          applied.requestId!,
          applied.payload.postApplyProjectIndexManifestId,
          applied.payload.postApplyProjectRevisionHash,
          applied.payload.postApplyProjectDetectorEpoch,
          "post-Apply project index",
          indexStreams,
        ),
      );
      bundle = await guarded(this.retainProjectIndex(bundle, afterIndexCapture, authority));
      await guarded(
        this.persistMutationCore(
          changeSetEvidence,
          projection,
          preflightProjection,
          preflight.payload.preflightEvidence,
          beforeIndexCapture,
          applied.payload.directReadbackEvidence,
          afterIndexCapture,
        ),
      );
      const reconciliation = reconcileCreatorMutation({
        sessionId: bundle.session.id,
        attemptId,
        manifest: STUDIO_CAPABILITY_MANIFEST,
        manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
        changeSet: changeSetEvidence,
        projection,
        preflight: {
          projection: preflightProjection,
          envelope: preflight.payload.preflightEvidence,
        },
        directReadback: applied.payload.directReadbackEvidence,
        beforeIndexCapture,
        afterIndexCapture,
      });
      const reconciliationArtifact = await guarded(this.artifactStore.write(reconciliation));
      activeMutation = {
        ...activeMutation,
        stage: "provisional",
        recordingId: applied.payload.recordingId,
        directReadback: await guarded(
          this.mutationBinding(
            applied.payload.directReadbackEvidence,
            applied.payload.directReadbackEvidence.contentHash,
          ),
        ),
        afterIndexCapture: await guarded(this.projectIndexCaptureBinding(afterIndexCapture)),
        afterProjectDetectorEpoch: afterIndexCapture.detectorEpoch,
        reconciliation: {
          artifact: reconciliationArtifact,
          hash: reconciliation.hash,
        },
      };
      bundle = { ...bundle, activeMutation };
      assertAuthority();
      this.bundles.set(bundle.session.id, bundle);
      await guarded(this.persist(bundle));
      const afterState = projectIndexViewForCreator(
        studioProjectIndexMetadataView(afterIndexCapture),
      );
      const afterRevisionHash = afterIndexCapture.revision.hash;
      if (reconciliation.status !== "matched") {
        this.assertFinalizationGateClear(bundle.session.id);
        bundle = {
          ...bundle,
          session: advanceSession(bundle.session, { status: "cancelling" }),
        };
        assertAuthority();
        this.bundles.set(bundle.session.id, bundle);
        await guarded(this.persist(bundle));
        const finalized = await guarded(
          this.finalizeRecording(
            studio,
            bundle.session.id,
            changeSet,
            projection,
            beforeIndexCapture,
            applied.payload.recordingId,
            afterIndexCapture,
            applied.payload.postApplyProjectDetectorEpoch,
            "cancel",
            messages,
            authority,
          ),
        );
        const finalIndexCapture = await guarded(
          this.waitForTransactionProjectIndex(
            messages,
            finalized.requestId!,
            finalized.payload.afterProjectIndexManifestId,
            finalized.payload.afterProjectRevisionHash,
            finalized.payload.afterProjectDetectorEpoch,
            "post-cancel project index",
            indexStreams,
          ),
        );
        bundle = await guarded(this.retainProjectIndex(bundle, finalIndexCapture, authority));
        bundle = await guarded(
          this.confirmFinalizedTransactionProjectChanges(bundle, studio, finalIndexCapture),
        );
        if (
          bundle.session.status === "recovery_required" ||
          this.hasPendingTransactionProjectChange(bundle.session.id)
        )
          return summary(bundle);
        bundle = await guarded(
          this.recordMutationAttempt(
            bundle,
            attemptId,
            changeSetEvidence,
            projection,
            preflightProjection,
            preflight.payload.preflightEvidence,
            beforeIndexCapture,
            applied.payload.directReadbackEvidence,
            afterIndexCapture,
            reconciliation,
            finalized,
            finalIndexCapture,
            false,
            authority,
          ),
        );
        const attempt = bundle.mutationAttempts.find((candidate) => candidate.id === attemptId)!;
        const reverted = projectIndexViewForCreator(
          studioProjectIndexMetadataView(finalIndexCapture),
        );
        bundle = recordObservation(
          {
            ...bundle,
            session: advanceSession(bundle.session, {
              status: "incomplete",
              projectCapture: {
                captureHash: finalIndexCapture.hash,
                revisionHash: finalIndexCapture.revision.hash,
              },
              failure: {
                code:
                  reconciliation.status === "mismatched"
                    ? "post_apply_mismatch"
                    : "post_apply_evidence_incomplete",
                detail: reconciliation.failureFacts.map((fact) => fact.detail).join("; "),
              },
            }),
          },
          finalIndexCapture.revision.hash,
          reverted,
        );
        const result = await guarded(
          this.finish(
            bundle,
            `Provisional mutation was cancelled after ${reconciliation.status} reconciliation.`,
            authority,
          ),
        );
        await guarded(this.acknowledgeFinalization(studio, finalized, attempt.hash, authority));
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
          projectRevisionHash: afterRevisionHash,
        },
        targets: charterExecution.targets,
        calls: charterExecution.calls,
        budget: {
          maxExecutionMs: STUDIO_CAPABILITY_MANIFEST.limits.maximumRuntimeMs,
          maxResultBytes: STUDIO_CAPABILITY_MANIFEST.limits.maximumRuntimeResultBytes,
        },
        observationWindowMs: CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS,
      });
      const executionPlanArtifact = await guarded(this.artifactStore.write(executionPlan));
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
            projectCapture: {
              captureHash: afterIndexCapture.hash,
              revisionHash: afterRevisionHash,
            },
          }),
        },
        afterRevisionHash,
        afterState,
      );
      assertAuthority();
      this.bundles.set(bundle.session.id, bundle);
      await guarded(this.persist(bundle));
      assertAuthority();
      this.pendingRecordings.set(bundle.session.id, {
        recordingId: applied.payload.recordingId,
        beforeIndexRevisionHash: beforeIndexCapture.revision.hash,
        afterIndexRevisionHash: afterRevisionHash,
        projection,
        preflightProjection,
        changeSetEvidence,
        attemptId,
        beforeIndexCapture,
        preflight: preflight.payload.preflightEvidence,
        directReadback: applied.payload.directReadbackEvidence,
        afterIndexCapture,
        afterProjectDetectorEpoch: applied.payload.postApplyProjectDetectorEpoch,
        reconciliation,
      });
      await guarded(
        this.publishView(
          bundle,
          "Changes are provisionally applied with matched mutation evidence. Forge is silently arming the next normal Studio Play session; press Play, perform the approved interactions, then press Stop to return to review.",
          authority,
        ),
      );
      assertAuthority();
      this.pendingRepairExecutions.set(bundle.session.id, repairExecution);
      this.scheduleAutomaticVerification(bundle.session.id);
      return summary(bundle);
    } catch (error) {
      if (error instanceof ProjectAuthorityRevokedError) throw error;
      const current = this.bundles.get(bundle.session.id) ?? bundle;
      if (
        current.session.status === "preflighting" &&
        current.activeMutation === undefined &&
        !current.mutationAttempts.some((attempt) => attempt.id === attemptId)
      ) {
        const diagnostic = preRecordingDiagnostic(preRecordingPhase, detail(error));
        await guarded(
          this.recordIncompletePreflightAttempt(
            current,
            attemptId,
            changeSetEvidence,
            projection,
            preflightProjection,
            beforeIndexCapture,
            attestation,
            diagnostic.detail,
            diagnostic.code,
            receivedPreflightEvidence,
            authority,
          ),
        );
        throw new CreatorPreRecordingFailure(preRecordingPhase, diagnostic.code, diagnostic.detail);
      }
      throw error;
    } finally {
      this.endFinalizationRequest(requestId);
      unsubscribe();
      if (
        this.hasPendingTransactionProjectChange(bundle.session.id) &&
        this.hasTransactionProjectChangeConfirmationBaseline(bundle.session.id)
      )
        this.scheduleTransactionProjectChangeConfirmation(bundle.session.id);
    }
  }

  private async failIncomplete(
    bundle: CreatorSessionBundle,
    code: string,
    detailValue: string,
    authority?: ProjectAuthorityLease,
  ): Promise<unknown> {
    return this.finish(
      {
        ...bundle,
        session: advanceSession(bundle.session, {
          status: "incomplete",
          failure: { code, detail: detailValue },
        }),
      },
      detailValue,
      authority,
    );
  }

  private async createActiveMutation(
    attemptId: string,
    changeSet: CreatorChangeSet,
    changeSetEvidence: CreatorMutationChangeSetLike,
    projection: StudioEvidenceProjection,
    preflightProjection: StudioEvidenceProjection,
    preflight: StudioEvidenceEnvelope,
    beforeIndexCapture: StudioProjectIndexCapture,
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
      beforeIndexRevisionHash: beforeIndexCapture.revision.hash,
      beforeProjectDetectorEpoch: beforeIndexCapture.detectorEpoch,
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
      beforeIndexCapture: await this.projectIndexCaptureBinding(beforeIndexCapture),
    };
  }

  private async recordIncompletePreflightAttempt(
    bundle: CreatorSessionBundle,
    attemptId: string,
    changeSet: CreatorMutationChangeSetLike,
    projection: StudioEvidenceProjection,
    preflightProjection: StudioEvidenceProjection,
    beforeIndexCapture: StudioProjectIndexCapture,
    attestation: {
      projection: StudioEvidenceProjection;
      envelope: StudioEvidenceEnvelope;
      projectionArtifact: ArtifactReference;
      artifact: ArtifactReference;
    },
    detailValue: string,
    failureCode = "capability_preflight_failed",
    preflight?: StudioEvidenceEnvelope,
    authority?: ProjectAuthorityLease,
  ): Promise<CreatorSessionBundle> {
    const guarded = <T>(operation: Promise<T>) => this.awaitProjectAuthority(authority, operation);
    const attempt = createIncompleteCreatorMutationAttempt(attemptId, {
      sessionId: bundle.session.id,
      manifest: await guarded(
        this.mutationBinding(STUDIO_CAPABILITY_MANIFEST, STUDIO_CAPABILITY_MANIFEST_HASH),
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
      changeSet: await guarded(this.mutationBinding(changeSet, changeSet.hash)),
      projection: await guarded(this.mutationBinding(projection, projection.contentHash)),
      preflightProjection: await guarded(
        this.mutationBinding(preflightProjection, preflightProjection.contentHash),
      ),
      ...(preflight
        ? {
            preflight: {
              projection: await guarded(
                this.mutationBinding(preflightProjection, preflightProjection.contentHash),
              ),
              envelope: await guarded(this.mutationBinding(preflight, preflight.contentHash)),
            },
          }
        : {}),
      beforeIndexCapture: await guarded(this.projectIndexCaptureBinding(beforeIndexCapture)),
      failureFacts: createMutationFailureFacts([{ code: failureCode, detail: detailValue }]),
    });
    const next = {
      ...bundle,
      mutationAttempts: [...bundle.mutationAttempts, attempt],
    };
    this.assertProjectAuthority(authority);
    this.bundles.set(next.session.id, next);
    await guarded(this.persist(next));
    return next;
  }

  private async recordIncompleteApplyAttempt(
    bundle: CreatorSessionBundle,
    finalized: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>,
    finalIndexCapture: StudioProjectIndexCapture,
    failureFacts: readonly CreatorMutationFailureFact[],
  ): Promise<CreatorSessionBundle> {
    const active = bundle.activeMutation;
    if (!active) throw new Error("Failed mutation finalization has no durable active cursor");
    if (
      finalized.payload.creatorSessionId !== bundle.session.id ||
      finalized.payload.changeSetId !== active.changeSetId ||
      finalized.payload.changeSetHash !== active.changeSetHash ||
      finalized.payload.projectionId !== active.projectionId ||
      finalized.payload.projectionHash !== active.projectionHash ||
      finalized.payload.manifestHash !== STUDIO_CAPABILITY_MANIFEST_HASH ||
      finalized.payload.beforeProjectRevisionHash !== active.beforeIndexRevisionHash ||
      finalized.payload.beforeProjectDetectorEpoch !== active.beforeProjectDetectorEpoch ||
      finalized.payload.expectedCurrentProjectIndexManifestId !==
        (await readCreatorProjectIndexArtifacts(this.artifactStore, active.beforeIndexCapture))
          .indexManifest.id ||
      finalized.payload.expectedCurrentProjectRevisionHash !== active.beforeIndexRevisionHash ||
      finalized.payload.expectedCurrentProjectDetectorEpoch !== active.beforeProjectDetectorEpoch ||
      (active.recordingId !== undefined && finalized.payload.recordingId !== active.recordingId) ||
      finalized.payload.action !== "cancel" ||
      finalized.payload.finalizationKind !== "ordinary" ||
      finalized.payload.status !== "cancelled"
    )
      throw new Error("Failed mutation cancellation finalization binding mismatch");
    assertStudioProjectIndexCapture(finalIndexCapture);
    if (
      finalized.payload.afterProjectIndexManifestId !== finalIndexCapture.indexManifest.id ||
      finalized.payload.afterProjectRevisionHash !== finalIndexCapture.revision.hash ||
      finalized.payload.afterProjectDetectorEpoch !== finalIndexCapture.detectorEpoch
    )
      throw new Error("Failed mutation cancellation project-index binding mismatch");
    const finalization = createCreatorMutationFinalization({
      attemptId: active.attemptId,
      sessionId: bundle.session.id,
      changeSetId: active.changeSetId,
      changeSetHash: active.changeSetHash,
      projectionId: active.projectionId,
      projectionHash: active.projectionHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      beforeIndexCaptureHash: active.beforeIndexCapture.captureHash,
      beforeIndexRevisionHash: active.beforeIndexRevisionHash,
      afterIndexCaptureHash: active.beforeIndexCapture.captureHash,
      afterIndexRevisionHash: active.beforeIndexRevisionHash,
      finalIndexCaptureHash: finalIndexCapture.hash,
      finalIndexRevisionHash: finalIndexCapture.revision.hash,
      recordingId: finalized.payload.recordingId,
      action: "cancel",
      status: "cancelled",
    });
    const attempt = createIncompleteApplyMutationAttempt(active.attemptId, {
      sessionId: bundle.session.id,
      manifest: active.manifest,
      attestation: active.attestation,
      changeSet: active.changeSet,
      projection: active.projection,
      preflightProjection: active.preflight.projection,
      preflight: active.preflight,
      beforeIndexCapture: active.beforeIndexCapture,
      finalIndexCapture: await this.projectIndexCaptureBinding(finalIndexCapture),
      finalization: await this.mutationBinding(finalization, finalization.hash),
      failureFacts,
    });
    return {
      ...bundle,
      mutationAttempts: [...bundle.mutationAttempts, attempt],
    };
  }

  private async recordIncompleteDurableIntentAttempt(
    bundle: CreatorSessionBundle,
    failureFacts: readonly CreatorMutationFailureFact[],
  ): Promise<CreatorSessionBundle> {
    const active = bundle.activeMutation;
    if (!active) throw new Error("Durable-intent failure has no persisted host mutation cursor");
    if (active.stage !== "recording_may_be_open")
      throw new Error("Durable-intent failure arrived outside the exact Apply boundary");
    const attempt = createIncompleteDurableIntentMutationAttempt(active.attemptId, {
      sessionId: bundle.session.id,
      manifest: active.manifest,
      attestation: active.attestation,
      changeSet: active.changeSet,
      projection: active.projection,
      preflightProjection: active.preflight.projection,
      preflight: active.preflight,
      beforeIndexCapture: active.beforeIndexCapture,
      failureFacts,
    });
    const { activeMutation: _activeMutation, ...settledBundle } = bundle;
    return {
      ...settledBundle,
      mutationAttempts: [...bundle.mutationAttempts, attempt],
    };
  }

  private async persistMutationCore(
    changeSet: CreatorMutationChangeSetLike,
    projection: StudioEvidenceProjection,
    preflightProjection: StudioEvidenceProjection,
    preflight: StudioEvidenceEnvelope,
    beforeIndexCapture: StudioProjectIndexCapture,
    directReadback: StudioEvidenceEnvelope,
    afterIndexCapture: StudioProjectIndexCapture,
    reconciliation?: CreatorMutationReconciliation,
  ): Promise<void> {
    await Promise.all([
      this.artifactStore.write(STUDIO_CAPABILITY_MANIFEST),
      this.artifactStore.write(changeSet),
      this.artifactStore.write(projection),
      this.artifactStore.write(preflightProjection),
      this.artifactStore.write(preflight),
      this.artifactStore.write(beforeIndexCapture),
      this.artifactStore.write(directReadback),
      this.artifactStore.write(afterIndexCapture),
      ...(reconciliation ? [this.artifactStore.write(reconciliation)] : []),
    ]);
  }

  private async mutationBinding(
    value: unknown,
    hash: string,
  ): Promise<CreatorMutationArtifactBinding> {
    return { artifact: await this.artifactStore.write(value), hash };
  }

  private async recordMutationAttempt(
    bundle: CreatorSessionBundle,
    attemptId: string,
    changeSet: CreatorMutationChangeSetLike,
    projection: StudioEvidenceProjection,
    preflightProjection: StudioEvidenceProjection,
    preflight: StudioEvidenceEnvelope,
    beforeIndexCapture: StudioProjectIndexCapture,
    directReadback: StudioEvidenceEnvelope,
    afterIndexCapture: StudioProjectIndexCapture,
    reconciliation: CreatorMutationReconciliation,
    finalized: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>,
    finalIndexCapture: StudioProjectIndexCapture,
    recoveryCancellation = false,
    authority?: ProjectAuthorityLease,
  ): Promise<CreatorSessionBundle> {
    assertStudioProjectIndexCapture(finalIndexCapture);
    const finalization = createCreatorMutationFinalization({
      attemptId,
      sessionId: bundle.session.id,
      changeSetId: finalized.payload.changeSetId,
      changeSetHash: finalized.payload.changeSetHash,
      projectionId: finalized.payload.projectionId,
      projectionHash: finalized.payload.projectionHash,
      manifestHash: finalized.payload.manifestHash,
      beforeIndexCaptureHash: beforeIndexCapture.hash,
      beforeIndexRevisionHash: beforeIndexCapture.revision.hash,
      afterIndexCaptureHash: afterIndexCapture.hash,
      afterIndexRevisionHash: afterIndexCapture.revision.hash,
      finalIndexCaptureHash: finalIndexCapture.hash,
      finalIndexRevisionHash: finalIndexCapture.revision.hash,
      recordingId: finalized.payload.recordingId,
      reconciliationHash: reconciliation.hash,
      action: recoveryCancellation ? "recovery_cancel" : finalized.payload.action,
      status: recoveryCancellation
        ? "recovery_cancelled"
        : finalized.payload.status === "committed"
          ? "committed"
          : "cancelled",
    });
    const attestation = bundle.activeMutation?.attestation;
    if (!attestation)
      throw new Error("Mutation attempt is missing its paired capability attestation");
    const attempt = createCreatorMutationAttempt(attemptId, {
      sessionId: bundle.session.id,
      manifest: await this.mutationBinding(
        STUDIO_CAPABILITY_MANIFEST,
        STUDIO_CAPABILITY_MANIFEST_HASH,
      ),
      attestation,
      changeSet: await this.mutationBinding(changeSet, changeSet.hash),
      projection: await this.mutationBinding(projection, projection.contentHash),
      preflight: {
        projection: await this.mutationBinding(
          preflightProjection,
          preflightProjection.contentHash,
        ),
        envelope: await this.mutationBinding(preflight, preflight.contentHash),
      },
      directReadback: await this.mutationBinding(directReadback, directReadback.contentHash),
      beforeIndexCapture: await this.projectIndexCaptureBinding(beforeIndexCapture),
      afterIndexCapture: await this.projectIndexCaptureBinding(afterIndexCapture),
      finalIndexCapture: await this.projectIndexCaptureBinding(finalIndexCapture),
      reconciliation: await this.mutationBinding(reconciliation, reconciliation.hash),
      finalization: await this.mutationBinding(finalization, finalization.hash),
    });
    const { activeMutation: _activeMutation, ...settledBundle } = bundle;
    const next: CreatorSessionBundle = this.mergeConcurrentProjectChanges({
      ...settledBundle,
      mutationAttempts: [...bundle.mutationAttempts, attempt],
    });
    this.assertProjectAuthority(authority);
    this.bundles.set(next.session.id, next);
    await this.awaitProjectAuthority(authority, this.persist(next));
    return next;
  }

  private async verify(bundle: CreatorSessionBundle): Promise<unknown> {
    const changeSet = requiredChangeSet(bundle);
    const pending = this.pendingRecordings.get(bundle.session.id);
    if (bundle.session.status !== "awaiting_verification" || !pending || !bundle.plan)
      throw new Error("Creator session has no applied change awaiting verification");
    const plan = bundle.plan;
    const studio = await this.currentAttestedStudioSession();
    const activeMutation = bundle.activeMutation;
    if (!activeMutation || activeMutation.attemptId !== pending.attemptId)
      throw new Error("Verification lost its durable mutation transaction cursor");
    if (this.hasPendingTransactionProjectChange(bundle.session.id)) {
      // An advisory notice is not enough to fabricate drift, but it is enough
      // to prevent a new Play observer or finalization until the read-only
      // current-index confirmation has been durably completed.
      this.scheduleTransactionProjectChangeConfirmation(bundle.session.id);
      return summary(bundle);
    }
    if (!activeMutation.verificationPlan)
      throw new Error("Verification has no pre-materialized execution plan");
    const executionPlan = await this.artifactStore.read(
      activeMutation.verificationPlan.artifact,
      assertStudioExecutionPlan,
    );
    const verificationIndex = await readCreatorProjectIndexArtifacts(
      this.artifactStore,
      activeMutation.beforeIndexCapture,
    );
    const expectedExecution = createCharterExecution(
      plan.charter.clauses,
      studioProjectIndexMetadataView(verificationIndex),
      changeSet,
    );
    if (
      executionPlan.hash !== activeMutation.verificationPlan.hash ||
      executionPlan.purpose !== "creator_verification" ||
      executionPlan.binding.sessionId !== studio.sessionId ||
      executionPlan.binding.projectId !== studio.projectId ||
      executionPlan.binding.projectRevisionHash !== bundle.session.currentRevisionHash ||
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
      "Forge is armed for the next ordinary Studio Play session. Press Play, perform the approved interaction, then press Stop; Forge will grade only the bound facts captured before Studio returns to Edit mode.",
    );
    const observation = await this.observationForBundle(bundle);
    const stateFailures = gradeProjectIndexCharter(plan.charter.clauses, observation);
    const observed =
      stateFailures.length === 0
        ? await executeCreatorVerificationPlan({
            connection: this.input.connection,
            session: studio,
            executionPlan,
            timeoutMs: this.timeout(),
            onLifecycle: (event) => this.setVerificationPlayObservation(bundle.session.id, event),
          })
        : undefined;
    this.observingCreatorPlay.delete(bundle.session.id);
    const failures =
      stateFailures.length > 0
        ? stateFailures
        : observed?.evidence?.completion === "incomplete"
          ? runtimeEvidenceIssues(observed.evidence)
          : observed?.status === "completed" && observed.evidence
            ? gradeRuntimeCharter(plan.charter.clauses, observed.evidence)
            : [observed?.failure?.detail ?? "Studio verification did not complete"];
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
      verificationEvidenceHash(observation),
      {
        id: pending.attemptId,
        reconciliationHash: pending.reconciliation.hash,
      },
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
    if (this.hasPendingTransactionProjectChange(bundle.session.id)) {
      bundle = await this.confirmTransactionProjectChange(bundle, studio);
      if (
        bundle.session.status === "recovery_required" ||
        this.hasPendingTransactionProjectChange(bundle.session.id)
      ) {
        this.scheduleTransactionProjectChangeConfirmation(bundle.session.id);
        return summary(bundle);
      }
    }
    if (verification.status === "incomplete") {
      this.pendingRepairExecutions.delete(bundle.session.id);
      // Only a valid runtime envelope received after the exact Stop lifecycle
      // acknowledgement proves that the plugin retired its prior observer.
      // Timeouts, disconnects, and pre-start/plugin errors leave that runtime
      // cursor unknown; automatically issuing another arm in those cases was
      // the source of duplicate-run rejections and can never be safe.
      const stopSealedIncompleteEvidence =
        observed?.status === "incomplete" && observed.evidence?.completion === "incomplete";
      if (!stopSealedIncompleteEvidence) {
        bundle = {
          ...bundle,
          session: advanceSession(bundle.session, {
            status: "recovery_required",
            failure: {
              code: "runtime_observer_state_unknown",
              detail:
                "Forge did not receive a complete Stop-sealed runtime envelope, so it will not re-arm, commit, cancel, or assume the provisional Studio recording state.",
            },
          }),
        };
        this.bundles.set(bundle.session.id, bundle);
        await this.persist(bundle);
        await this.publishView(
          bundle,
          "Forge did not receive complete Stop-sealed runtime evidence. The runtime observer may be unknown, so automatic re-arm is disabled. Re-pair the connector to obtain exact recording recovery evidence; Forge will not mutate Studio automatically.",
        );
        return summary(bundle);
      }
      bundle = {
        ...bundle,
        session: advanceSession(bundle.session, {
          status: "awaiting_verification_retry",
        }),
      };
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      await this.publishView(
        bundle,
        `The Play session ended and was sealed, but its bound evidence is incomplete: ${failures.join("; ")}. The matched provisional change remains open and unchanged. Retry or cancel explicitly.`,
      );
      return summary(bundle);
    }
    const messages: PluginToBackendMessage[] = [];
    const indexStreams = new StudioProjectIndexStreamRouter();
    const unsubscribe = this.capture(studio, messages, indexStreams);
    try {
      if (failures.length === 0) {
        this.pendingRepairExecutions.delete(bundle.session.id);
        this.assertFinalizationGateClear(bundle.session.id);
        bundle = {
          ...bundle,
          session: advanceSession(bundle.session, { status: "committing" }),
        };
        this.bundles.set(bundle.session.id, bundle);
        await this.persist(bundle);
        const finalized = await this.finalizeRecording(
          studio,
          bundle.session.id,
          changeSet,
          pending.projection,
          pending.beforeIndexCapture,
          pending.recordingId,
          pending.afterIndexCapture,
          pending.afterProjectDetectorEpoch,
          "commit",
          messages,
        );
        const finalIndexCapture = await this.waitForTransactionProjectIndex(
          messages,
          finalized.requestId!,
          finalized.payload.afterProjectIndexManifestId,
          finalized.payload.afterProjectRevisionHash,
          finalized.payload.afterProjectDetectorEpoch,
          "post-commit project index",
          indexStreams,
        );
        bundle = await this.retainProjectIndex(bundle, finalIndexCapture);
        bundle = await this.confirmFinalizedTransactionProjectChanges(
          bundle,
          studio,
          finalIndexCapture,
        );
        if (
          bundle.session.status === "recovery_required" ||
          this.hasPendingTransactionProjectChange(bundle.session.id)
        )
          return summary(bundle);
        const finalizedRevision = finalIndexCapture.revision.hash;
        const committed = projectIndexViewForCreator(
          studioProjectIndexMetadataView(finalIndexCapture),
        );
        bundle = await this.recordMutationAttempt(
          bundle,
          pending.attemptId,
          pending.changeSetEvidence,
          pending.projection,
          pending.preflightProjection,
          pending.preflight,
          pending.beforeIndexCapture,
          pending.directReadback,
          pending.afterIndexCapture,
          pending.reconciliation,
          finalized,
          finalIndexCapture,
        );
        const attempt = requiredSettledMutationAttempt(bundle, pending.attemptId);
        const boundVerification = bindVerificationMutationAttempt(verification, attempt);
        bundle = {
          ...bundle,
          verifications: [...bundle.verifications, boundVerification],
        };
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
              projectCapture: {
                captureHash: finalIndexCapture.hash,
                revisionHash: finalizedRevision,
              },
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
      this.assertFinalizationGateClear(bundle.session.id);
      bundle = {
        ...bundle,
        session: advanceSession(bundle.session, { status: "cancelling" }),
      };
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      const finalized = await this.finalizeRecording(
        studio,
        bundle.session.id,
        changeSet,
        pending.projection,
        pending.beforeIndexCapture,
        pending.recordingId,
        pending.afterIndexCapture,
        pending.afterProjectDetectorEpoch,
        "cancel",
        messages,
      );
      const finalIndexCapture = await this.waitForTransactionProjectIndex(
        messages,
        finalized.requestId!,
        finalized.payload.afterProjectIndexManifestId,
        finalized.payload.afterProjectRevisionHash,
        finalized.payload.afterProjectDetectorEpoch,
        "post-cancel project index",
        indexStreams,
      );
      bundle = await this.retainProjectIndex(bundle, finalIndexCapture);
      bundle = await this.confirmFinalizedTransactionProjectChanges(
        bundle,
        studio,
        finalIndexCapture,
      );
      if (
        bundle.session.status === "recovery_required" ||
        this.hasPendingTransactionProjectChange(bundle.session.id)
      )
        return summary(bundle);
      this.pendingRecordings.delete(bundle.session.id);
      const rollbackRevision = finalIndexCapture.revision.hash;
      const reverted = projectIndexViewForCreator(
        studioProjectIndexMetadataView(finalIndexCapture),
      );
      bundle = await this.recordMutationAttempt(
        bundle,
        pending.attemptId,
        pending.changeSetEvidence,
        pending.projection,
        pending.preflightProjection,
        pending.preflight,
        pending.beforeIndexCapture,
        pending.directReadback,
        pending.afterIndexCapture,
        pending.reconciliation,
        finalized,
        finalIndexCapture,
      );
      const attempt = requiredSettledMutationAttempt(bundle, pending.attemptId);
      const boundVerification = bindVerificationMutationAttempt(verification, attempt);
      bundle = {
        ...bundle,
        verifications: [...bundle.verifications, boundVerification],
      };
      if (bundle.session.repairsUsed >= 2) {
        bundle = recordObservation(
          {
            ...bundle,
            session: advanceSession(bundle.session, {
              status: "incomplete",
              projectCapture: {
                captureHash: finalIndexCapture.hash,
                revisionHash: rollbackRevision,
              },
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
            projectCapture: {
              captureHash: finalIndexCapture.hash,
              revisionHash: rollbackRevision,
            },
          }),
        },
        rollbackRevision,
        reverted,
      );
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
      if (!this.hasPendingTransactionProjectChange(bundle.session.id))
        this.finalizedTransactionProjectChangeCaptures.delete(bundle.session.id);
      await this.acknowledgeFinalization(studio, finalized, attempt.hash);
      const repairExecution = this.pendingRepairExecutions.get(bundle.session.id);
      if (!repairExecution)
        throw new Error("Verification repair lost its creator-job execution reservation");
      this.pendingRepairExecutions.delete(bundle.session.id);
      return this.repair(bundle, boundVerification, repairExecution);
    } finally {
      unsubscribe();
    }
  }

  private async repair(
    bundle: CreatorSessionBundle,
    verification: CreatorVerificationRecord,
    execution: AgentExecutionSlot,
  ): Promise<unknown> {
    if (!bundle.plan) throw new Error("Repair requires the approved plan");
    const planApproval = bundle.approvals.find(
      (approval) => approval.artifactKind === "plan" && approval.decision === "approved",
    );
    if (!planApproval) throw new Error("Repair requires the original plan approval");
    const creatorPrompt = await this.creatorPrompt(bundle);
    const agentPrompt = await this.agentPrompt(bundle);
    if (
      verification.status !== "failed" ||
      verification.failureFacts.length === 0 ||
      !bundle.verifications.some(
        (record) => record.id === verification.id && record.hash === verification.hash,
      )
    )
      throw new Error("Repair requires persisted canonical verification failure facts");
    const source = await this.sourceEvidence(bundle);
    const observation = await this.observationForBundle(bundle);
    const built = await this.input.worker.build({
      session: bundle.session,
      ownership: bundle.ownership,
      projectIndex: observation,
      creatorPrompt,
      agentPrompt,
      plan: bundle.plan,
      planApproval,
      verificationFeedback: verification.failureFacts.map((fact) => fact.statement),
      budgets: DEFAULT_AGENT_BUDGETS,
      ...source,
      execution,
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
      return this.finish(bundle, `Repair builder stopped: ${built.failure.detail}`);
    }
    bundle = await this.retainSourceWriteBlobs(bundle, built.sourceWriteBlobs);
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
    if (changeSet.mutationAuthority === "rojo_source") {
      const mutation = bundle.rojoSourceMutations.at(-1);
      const proofBinding = mutation?.syncProofs.at(-1);
      if (
        !mutation ||
        mutation.revert ||
        !proofBinding ||
        bundle.session.status !== "awaiting_review" ||
        !bundle.plan
      )
        throw new Error("Rojo source session is not awaiting a complete source-sync review");
      const proof = await this.artifactStore.read(proofBinding.artifact, assertRojoSyncProof);
      if (
        proof.status !== "matched" ||
        proof.attemptId !== mutation.attempt.id ||
        proof.attemptHash !== mutation.attempt.hash
      )
        throw new Error(
          "Creator review requires the exact matched Rojo source synchronization proof",
        );
      const observation = await this.observationForBundle(bundle);
      const review = createCreatorReviewReport({
        sessionId: bundle.session.id,
        changeSetId: changeSet.id,
        changeSetHash: changeSet.hash,
        charterId: bundle.plan.charter.id,
        charterHash: bundle.plan.charter.hash,
        decision,
        report: report ?? "",
        reviewedObservationHash: verificationEvidenceHash(observation),
        reviewedAt: new Date().toISOString(),
      });
      const artifact = await this.artifactStore.write(review);
      return this.finish(
        {
          ...bundle,
          review: { report: review, artifact },
          session: advanceSession(bundle.session, {
            status: decision === "accepted" ? "creator_accepted" : "creator_rejected",
            review,
          }),
        },
        decision === "accepted"
          ? "The creator accepted the exact Rojo source synchronization proof. It does not claim unobserved runtime behavior."
          : "The creator rejected the exact Rojo source synchronization proof.",
      );
    }
    if (bundle.session.status !== "awaiting_review" || !bundle.checkpoint || !bundle.plan)
      throw new Error("Creator session is not awaiting final review");
    const observation = await this.observationForBundle(bundle);
    const review = createCreatorReviewReport({
      sessionId: bundle.session.id,
      changeSetId: changeSet.id,
      changeSetHash: changeSet.hash,
      charterId: bundle.plan.charter.id,
      charterHash: bundle.plan.charter.hash,
      decision,
      report: report ?? "",
      reviewedObservationHash: verificationEvidenceHash(observation),
      reviewedAt: new Date().toISOString(),
    });
    const artifact = await this.artifactStore.write(review);
    bundle = {
      ...bundle,
      review: { report: review, artifact },
      session: advanceSession(bundle.session, {
        status: decision === "accepted" ? "creator_accepted" : "creator_rejected",
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

  private async rejectAndRollback(bundle: CreatorSessionBundle, report?: string): Promise<unknown> {
    if (bundle.session.status !== "awaiting_review" || !bundle.plan)
      throw new Error("Creator session is not awaiting final review");
    // Do not seal the creator's rejection until guarded undo has a paired
    // Studio authority available. An offline review must remain resumable.
    await this.currentAttestedStudioSession();
    const changeSet = requiredChangeSet(bundle);
    const observation = await this.observationForBundle(bundle);
    const review = createCreatorReviewReport({
      sessionId: bundle.session.id,
      changeSetId: changeSet.id,
      changeSetHash: changeSet.hash,
      charterId: bundle.plan.charter.id,
      charterHash: bundle.plan.charter.hash,
      decision: "rejected" as const,
      report: report ?? "",
      reviewedObservationHash: verificationEvidenceHash(observation),
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

  private async rejectAndRevertRojoSource(
    bundle: CreatorSessionBundle,
    report?: string,
  ): Promise<unknown> {
    if (
      bundle.session.status !== "awaiting_review" ||
      requiredChangeSet(bundle).mutationAuthority !== "rojo_source" ||
      !bundle.plan
    )
      throw new Error("Rojo source session is not awaiting final review");
    const changeSet = requiredChangeSet(bundle);
    const observation = await this.observationForBundle(bundle);
    const review = createCreatorReviewReport({
      sessionId: bundle.session.id,
      changeSetId: changeSet.id,
      changeSetHash: changeSet.hash,
      charterId: bundle.plan.charter.id,
      charterHash: bundle.plan.charter.hash,
      decision: "rejected",
      report: report ?? "",
      reviewedObservationHash: verificationEvidenceHash(observation),
      reviewedAt: new Date().toISOString(),
    });
    const artifact = await this.artifactStore.write(review);
    const reviewed = { ...bundle, review: { report: review, artifact } };
    this.bundles.set(reviewed.session.id, reviewed);
    await this.persist(reviewed);
    return this.revertRojoSourceChanges(reviewed);
  }

  private async retryPlayVerification(
    bundle: CreatorSessionBundle,
    repairExecution: AgentExecutionSlot,
  ): Promise<unknown> {
    if (bundle.session.status !== "awaiting_verification_retry")
      throw new Error("Creator session is not awaiting a Play verification retry");
    const pending = this.pendingRecordings.get(bundle.session.id);
    const active = bundle.activeMutation;
    if (
      !pending ||
      !active ||
      pending.attemptId !== active.attemptId ||
      pending.recordingId !== active.recordingId ||
      !active.verificationPlan ||
      !active.verificationDraft
    )
      throw new Error("Verification retry lost its exact provisional transaction binding");
    const draft = await this.artifactStore.read(
      active.verificationDraft.artifact,
      assertCreatorVerificationRecord,
    );
    if (
      draft.hash !== active.verificationDraft.hash ||
      draft.status !== "incomplete" ||
      !draft.runtimeEvidence ||
      draft.stateRevisionHash !== bundle.session.currentRevisionHash ||
      draft.mutationAttempt.id !== active.attemptId
    )
      throw new Error("Verification retry is not bound to the current incomplete draft");
    const evidence = await this.artifactStore.read(
      draft.runtimeEvidence.artifact,
      assertStudioEvidenceEnvelope,
    );
    const executionPlan = await this.artifactStore.read(
      active.verificationPlan.artifact,
      assertStudioExecutionPlan,
    );
    if (
      executionPlan.hash !== active.verificationPlan.hash ||
      draft.executionPlan.id !== executionPlan.id ||
      draft.executionPlan.hash !== executionPlan.hash ||
      evidence.completion !== "incomplete" ||
      verificationEvidenceHash(evidence) !== draft.runtimeEvidence.evidenceHash
    )
      throw new Error("Verification retry requires the exact incomplete runtime envelope");
    assertEvidenceAgainstProjection(evidence, executionPlan.evidenceProjection);
    bundle = {
      ...bundle,
      session: advanceSession(bundle.session, {
        status: "awaiting_verification",
      }),
    };
    this.bundles.set(bundle.session.id, bundle);
    await this.persist(bundle);
    await this.publishView(
      bundle,
      "Retry authorized for this exact incomplete Play receipt and unchanged provisional recording. Forge will observe the next ordinary Studio Play once.",
    );
    this.pendingRepairExecutions.set(bundle.session.id, repairExecution);
    this.scheduleAutomaticVerification(bundle.session.id);
    return summary(bundle);
  }

  private async rollback(bundle: CreatorSessionBundle): Promise<unknown> {
    if (["awaiting_verification", "awaiting_verification_retry"].includes(bundle.session.status)) {
      const studio = await this.currentAttestedStudioSession();
      const changeSet = requiredChangeSet(bundle);
      const pending = this.pendingRecordings.get(bundle.session.id);
      if (!pending) throw new Error("No active Studio recording can be cancelled");
      const verificationDraft = bundle.activeMutation?.verificationDraft
        ? await this.artifactStore.read(
            bundle.activeMutation.verificationDraft.artifact,
            assertCreatorVerificationRecord,
          )
        : undefined;
      const messages: PluginToBackendMessage[] = [];
      const indexStreams = new StudioProjectIndexStreamRouter();
      const unsubscribe = this.capture(studio, messages, indexStreams);
      try {
        this.assertFinalizationGateClear(bundle.session.id);
        bundle = {
          ...bundle,
          session: advanceSession(bundle.session, { status: "cancelling" }),
        };
        this.bundles.set(bundle.session.id, bundle);
        await this.persist(bundle);
        const finalized = await this.finalizeRecording(
          studio,
          bundle.session.id,
          changeSet,
          pending.projection,
          pending.beforeIndexCapture,
          pending.recordingId,
          pending.afterIndexCapture,
          pending.afterProjectDetectorEpoch,
          "cancel",
          messages,
        );
        const finalIndexCapture = await this.waitForTransactionProjectIndex(
          messages,
          finalized.requestId!,
          finalized.payload.afterProjectIndexManifestId,
          finalized.payload.afterProjectRevisionHash,
          finalized.payload.afterProjectDetectorEpoch,
          "post-cancel project index",
          indexStreams,
        );
        bundle = await this.retainProjectIndex(bundle, finalIndexCapture);
        bundle = await this.confirmFinalizedTransactionProjectChanges(
          bundle,
          studio,
          finalIndexCapture,
        );
        if (
          bundle.session.status === "recovery_required" ||
          this.hasPendingTransactionProjectChange(bundle.session.id)
        )
          return summary(bundle);
        const rollbackRevision = finalIndexCapture.revision.hash;
        const reverted = projectIndexViewForCreator(
          studioProjectIndexMetadataView(finalIndexCapture),
        );
        bundle = await this.recordMutationAttempt(
          bundle,
          pending.attemptId,
          pending.changeSetEvidence,
          pending.projection,
          pending.preflightProjection,
          pending.preflight,
          pending.beforeIndexCapture,
          pending.directReadback,
          pending.afterIndexCapture,
          pending.reconciliation,
          finalized,
          finalIndexCapture,
        );
        const attempt = requiredSettledMutationAttempt(bundle, pending.attemptId);
        if (verificationDraft) {
          const boundVerification = bindVerificationMutationAttempt(verificationDraft, attempt);
          bundle = {
            ...bundle,
            verifications: [...bundle.verifications, boundVerification],
          };
        }
        this.pendingRecordings.delete(bundle.session.id);
        bundle = recordObservation(
          {
            ...bundle,
            session: advanceSession(bundle.session, {
              status: "creator_rejected",
              projectCapture: {
                captureHash: finalIndexCapture.hash,
                revisionHash: rollbackRevision,
              },
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
      const fresh = await this.collectProjectIndex(studio);
      if (fresh.revision.hash !== checkpoint.afterRevisionHash)
        throw new Error(
          "Guarded rollback refused because Studio changed after the Forge checkpoint",
        );
      const messages: PluginToBackendMessage[] = [];
      const indexStreams = new StudioProjectIndexStreamRouter();
      const unsubscribe = this.capture(studio, messages, indexStreams);
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
              expectedProjectRevisionHash: checkpoint.afterRevisionHash,
            },
            studio.sessionId,
            requestId,
          ),
        );
        const rolled = await waitFor(
          messages,
          (
            message,
          ): message is Extract<PluginToBackendMessage, { type: "CreatorCheckpointRolledBack" }> =>
            message.type === "CreatorCheckpointRolledBack" &&
            message.requestId === requestId &&
            message.payload.creatorSessionId === bundle.session.id &&
            message.payload.checkpointId === checkpoint.id &&
            message.payload.changeSetId === changeSet.id &&
            message.payload.changeSetHash === changeSet.hash &&
            message.payload.beforeProjectRevisionHash === checkpoint.afterRevisionHash &&
            message.payload.status === "rolled_back",
          this.timeout(),
          "guarded creator rollback",
          requestId,
        );
        const afterIndexCapture = await this.waitForTransactionProjectIndex(
          messages,
          rolled.requestId!,
          rolled.payload.afterProjectIndexManifestId,
          rolled.payload.afterProjectRevisionHash,
          rolled.payload.afterProjectDetectorEpoch,
          "post-rollback project index",
          indexStreams,
        );
        bundle = await this.retainProjectIndex(bundle, afterIndexCapture);
        const afterRevision = afterIndexCapture.revision.hash;
        const rolledCheckpoint = updateCheckpointStatus(checkpoint, "rolled_back");
        bundle = recordObservation(
          {
            ...bundle,
            checkpoint: rolledCheckpoint,
            session: advanceSession(bundle.session, {
              status: "rolled_back",
              checkpoint: rolledCheckpoint,
              projectCapture: {
                captureHash: afterIndexCapture.hash,
                revisionHash: afterRevision,
              },
            }),
          },
          afterRevision,
          projectIndexViewForCreator(studioProjectIndexMetadataView(afterIndexCapture)),
        );
        return this.finish(
          bundle,
          "The exact Forge checkpoint was rolled back through Studio Change History.",
        );
      } finally {
        unsubscribe();
      }
    }
    throw new Error("This creator session has no exact rollback-eligible Studio checkpoint");
  }

  private async cancelInterruptedRecording(bundle: CreatorSessionBundle): Promise<unknown> {
    const active = bundle.activeMutation;
    const recovery = this.recordingRecovery.get(bundle.session.id);
    if (
      bundle.session.status !== "recovery_required" ||
      !active ||
      !active.recordingId ||
      !recovery ||
      recovery.recordingState !== "open" ||
      recovery.recordingId !== active.recordingId ||
      recovery.replacesAction === undefined
    )
      throw new Error("The exact interrupted Studio recording has not been proven open");
    const studio = await this.currentAttestedStudioSession();
    if (recovery.studioSessionId !== studio.sessionId)
      throw new Error("Recording recovery evidence belongs to a stale Studio pairing");
    this.assertFinalizationGateClear(bundle.session.id);
    const messages: PluginToBackendMessage[] = [];
    const indexStreams = new StudioProjectIndexStreamRouter();
    const unsubscribe = this.capture(studio, messages, indexStreams);
    const requestId = `creator_recovery_cancel_${randomUUID()}`;
    this.beginFinalizationRequest(requestId);
    try {
      bundle = {
        ...bundle,
        session: advanceSession(bundle.session, { status: "cancelling" }),
      };
      this.bundles.set(bundle.session.id, bundle);
      await this.persist(bundle);
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
            beforeProjectIndexManifestId: active.beforeIndexCapture.manifest.id,
            beforeProjectRevisionHash: active.beforeIndexRevisionHash,
            beforeProjectDetectorEpoch: active.beforeProjectDetectorEpoch,
            action: "cancel",
            finalizationKind: "recovery_cancel",
            replacesAction: recovery.replacesAction,
            expectedCurrentProjectIndexManifestId: recovery.projectIndexCapture.indexManifest.id,
            expectedCurrentProjectRevisionHash: recovery.projectIndexCapture.revision.hash,
            expectedCurrentProjectDetectorEpoch: recovery.projectDetectorEpoch,
          },
          studio.sessionId,
          requestId,
        ),
      );
      const finalized = await waitFor(
        messages,
        (message): message is Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }> =>
          message.type === "CreatorChangeFinalized" &&
          message.requestId === requestId &&
          message.payload.creatorSessionId === bundle.session.id &&
          message.payload.changeSetId === active.changeSetId &&
          message.payload.changeSetHash === active.changeSetHash &&
          message.payload.projectionId === active.projectionId &&
          message.payload.projectionHash === active.projectionHash &&
          message.payload.manifestHash === STUDIO_CAPABILITY_MANIFEST_HASH &&
          message.payload.beforeProjectIndexManifestId === active.beforeIndexCapture.manifest.id &&
          message.payload.beforeProjectRevisionHash === active.beforeIndexRevisionHash &&
          message.payload.beforeProjectDetectorEpoch === active.beforeProjectDetectorEpoch &&
          message.payload.recordingId === active.recordingId &&
          message.payload.action === "cancel" &&
          message.payload.finalizationKind === "recovery_cancel" &&
          message.payload.replacesAction === recovery.replacesAction &&
          message.payload.expectedCurrentProjectIndexManifestId ===
            recovery.projectIndexCapture.indexManifest.id &&
          message.payload.expectedCurrentProjectRevisionHash ===
            recovery.projectIndexCapture.revision.hash &&
          message.payload.expectedCurrentProjectDetectorEpoch === recovery.projectDetectorEpoch &&
          message.payload.status === "cancelled",
        this.timeout(),
        "interrupted creator recording cancellation",
        requestId,
      );
      const finalIndexCapture = await this.waitForTransactionProjectIndex(
        messages,
        finalized.requestId!,
        finalized.payload.afterProjectIndexManifestId,
        finalized.payload.afterProjectRevisionHash,
        finalized.payload.afterProjectDetectorEpoch,
        "recovery-cancel project index",
        indexStreams,
      );
      bundle = await this.retainProjectIndex(bundle, finalIndexCapture);
      bundle = await this.confirmFinalizedTransactionProjectChanges(
        bundle,
        studio,
        finalIndexCapture,
      );
      if (
        bundle.session.status === "recovery_required" ||
        this.hasPendingTransactionProjectChange(bundle.session.id)
      )
        return summary(bundle);
      let settledAttemptHash: string | undefined;
      if (
        active.stage === "provisional" &&
        active.directReadback &&
        active.afterIndexCapture &&
        active.reconciliation
      ) {
        const [
          changeSetEvidence,
          projection,
          preflightProjection,
          preflight,
          beforeIndexCapture,
          directReadback,
          afterIndexCapture,
          reconciliation,
        ] = await Promise.all([
          this.artifactStore.read(active.changeSet.artifact),
          this.artifactStore.read(active.projection.artifact),
          this.artifactStore.read(active.preflight.projection.artifact),
          this.artifactStore.read(active.preflight.envelope.artifact),
          readCreatorProjectIndexArtifacts(this.artifactStore, active.beforeIndexCapture),
          this.artifactStore.read(active.directReadback.artifact),
          readCreatorProjectIndexArtifacts(this.artifactStore, active.afterIndexCapture),
          this.artifactStore.read(active.reconciliation.artifact),
        ]);
        bundle = await this.recordMutationAttempt(
          bundle,
          active.attemptId,
          changeSetEvidence as CreatorMutationChangeSetLike,
          projection as StudioEvidenceProjection,
          preflightProjection as StudioEvidenceProjection,
          preflight as StudioEvidenceEnvelope,
          beforeIndexCapture,
          directReadback as StudioEvidenceEnvelope,
          afterIndexCapture,
          reconciliation as CreatorMutationReconciliation,
          finalized,
          finalIndexCapture,
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
            finalIndexCapture: await this.projectIndexCaptureBinding(finalIndexCapture),
          },
        };
      }
      this.recordingRecovery.delete(bundle.session.id);
      const finalState = projectIndexViewForCreator(
        studioProjectIndexMetadataView(finalIndexCapture),
      );
      bundle = recordObservation(
        {
          ...bundle,
          session: advanceSession(bundle.session, {
            status: "incomplete",
            projectCapture: {
              captureHash: finalIndexCapture.hash,
              revisionHash: finalIndexCapture.revision.hash,
            },
            failure: {
              code: "interrupted_recording_cancelled",
              detail:
                "The creator explicitly cancelled the exact interrupted Studio recording; the mutation was not resumed.",
            },
          }),
        },
        finalIndexCapture.revision.hash,
        finalState,
      );
      const result = await this.finish(
        bundle,
        "The exact interrupted Studio recording was cancelled. This attempt remains incomplete and was not resumed.",
      );
      if (settledAttemptHash)
        await this.acknowledgeFinalization(studio, finalized, settledAttemptHash);
      return result;
    } finally {
      this.endFinalizationRequest(requestId);
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
      this.assertRecoveredFinalizationGate(bundle, finalized.payload);
      const finalIndexCapture = this.resolveProjectIndexBinding(
        finalized.payload.afterProjectIndexManifestId,
        finalized.payload.afterProjectRevisionHash,
        finalized.payload.afterProjectDetectorEpoch,
      );
      bundle = await this.retainProjectIndex(bundle, finalIndexCapture);
      bundle = await this.confirmFinalizedTransactionProjectChanges(
        bundle,
        studio,
        finalIndexCapture,
      );
      if (
        bundle.session.status === "recovery_required" ||
        this.hasPendingTransactionProjectChange(bundle.session.id)
      )
        return;
      if (active.executionFailure) {
        const failureEvidence = await this.artifactStore.read(active.executionFailure.artifact);
        const failureFacts = assertMutationExecutionFailure(
          failureEvidence,
          active.attemptId,
          active.executionFailure.hash,
        );
        bundle = await this.recordIncompleteApplyAttempt(
          bundle,
          finalized,
          finalIndexCapture,
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
              projectCapture: {
                captureHash: finalIndexCapture.hash,
                revisionHash: finalIndexCapture.revision.hash,
              },
              failure: {
                code: "mutation_execution_failed",
                detail: failureFacts.map((fact) => fact.detail).join("; "),
              },
            }),
          },
          finalIndexCapture.revision.hash,
          projectIndexViewForCreator(studioProjectIndexMetadataView(finalIndexCapture)),
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
        !active.afterIndexCapture ||
        !active.reconciliation
      ) {
        const finalState = projectIndexViewForCreator(
          studioProjectIndexMetadataView(finalIndexCapture),
        );
        const { activeMutation: _activeMutation, ...settledBundle } = bundle;
        bundle = recordObservation(
          {
            ...settledBundle,
            session: advanceSession(bundle.session, {
              status: "incomplete",
              projectCapture: {
                captureHash: finalIndexCapture.hash,
                revisionHash: finalIndexCapture.revision.hash,
              },
              failure: {
                code: "control_process_interrupted",
                detail:
                  "Studio finalized the interrupted recording, but the persisted mutation graph was incomplete. No checkpoint or verdict was invented.",
              },
            }),
          },
          finalIndexCapture.revision.hash,
          finalState,
        );
        this.bundles.set(bundle.session.id, bundle);
        await this.persist(bundle);
        await this.publishView(
          bundle,
          "Studio finalized the interrupted recording, but the persisted mutation graph is incomplete. No checkpoint or verdict was invented.",
        );
        await this.acknowledgeFinalization(studio, finalized);
        return;
      }
      bundle = await this.recordAttemptFromActive(bundle, finalized, finalIndexCapture, false);
      const attempt = requiredSettledMutationAttempt(bundle, active.attemptId);
      const changeSet = requiredChangeSet(bundle);
      const finalState = projectIndexViewForCreator(
        studioProjectIndexMetadataView(finalIndexCapture),
      );
      const draft = active.verificationDraft
        ? await this.artifactStore.read(active.verificationDraft.artifact)
        : undefined;
      if (draft !== undefined) assertCreatorVerificationRecord(draft);
      const boundVerification = draft ? bindVerificationMutationAttempt(draft, attempt) : undefined;
      if (finalized.payload.action === "commit" && boundVerification?.status === "passed") {
        const checkpoint = createCheckpoint(
          bundle.session.id,
          changeSet,
          {
            beforeIndexRevisionHash: active.beforeIndexRevisionHash,
            afterIndexRevisionHash: finalIndexCapture.revision.hash,
          },
          finalIndexCapture.revision.hash,
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
              projectCapture: {
                captureHash: finalIndexCapture.hash,
                revisionHash: finalIndexCapture.revision.hash,
              },
            }),
          },
          finalIndexCapture.revision.hash,
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
              projectCapture: {
                captureHash: finalIndexCapture.hash,
                revisionHash: finalIndexCapture.revision.hash,
              },
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
          finalIndexCapture.revision.hash,
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
    finalIndexCapture: StudioProjectIndexCapture,
    recoveryCancellation: boolean,
  ): Promise<CreatorSessionBundle> {
    const active = bundle.activeMutation;
    if (
      !active ||
      active.stage !== "provisional" ||
      !active.directReadback ||
      !active.afterIndexCapture ||
      !active.reconciliation
    )
      throw new Error("Complete provisional mutation evidence is unavailable");
    const [
      changeSetEvidence,
      projection,
      preflightProjection,
      preflight,
      beforeIndexCapture,
      directReadback,
      afterIndexCapture,
      reconciliation,
    ] = await Promise.all([
      this.artifactStore.read(active.changeSet.artifact),
      this.artifactStore.read(active.projection.artifact),
      this.artifactStore.read(active.preflight.projection.artifact),
      this.artifactStore.read(active.preflight.envelope.artifact),
      readCreatorProjectIndexArtifacts(this.artifactStore, active.beforeIndexCapture),
      this.artifactStore.read(active.directReadback.artifact),
      readCreatorProjectIndexArtifacts(this.artifactStore, active.afterIndexCapture),
      this.artifactStore.read(active.reconciliation.artifact),
    ]);
    return this.recordMutationAttempt(
      bundle,
      active.attemptId,
      changeSetEvidence as CreatorMutationChangeSetLike,
      projection as StudioEvidenceProjection,
      preflightProjection as StudioEvidenceProjection,
      preflight as StudioEvidenceEnvelope,
      beforeIndexCapture,
      directReadback as StudioEvidenceEnvelope,
      afterIndexCapture,
      reconciliation as CreatorMutationReconciliation,
      finalized,
      finalIndexCapture,
      recoveryCancellation,
    );
  }

  /**
   * A replayed finalization receipt is actionable only when it echoes the
   * exact host-side phase baseline. A recovery cancellation is fenced by the
   * read-only recovery capture; every other finalization is fenced by the
   * direct post-Apply capture. Never infer either binding from a status.
   */
  private assertRecoveredFinalizationGate(
    bundle: CreatorSessionBundle,
    receipt: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>["payload"],
  ): void {
    const active = bundle.activeMutation;
    if (!active) throw new Error("Recovered finalization has no active transaction cursor");
    const recovery = this.recordingRecovery.get(bundle.session.id);
    if (receipt.finalizationKind === "recovery_cancel") {
      if (
        recovery?.recordingId !== receipt.recordingId ||
        recovery.replacesAction === undefined ||
        receipt.replacesAction !== recovery.replacesAction
      )
        throw new Error("Recovered recovery cancellation provenance mismatch");
    }
    const expected =
      receipt.finalizationKind === "recovery_cancel" && recovery !== undefined
        ? {
            capture: recovery.projectIndexCapture,
            detectorEpoch: recovery.projectDetectorEpoch,
          }
        : active.afterIndexCapture
          ? {
              capture: this.cachedProjectCapture(
                active.afterIndexCapture.manifest.id,
                active.afterIndexCapture.revision.hash,
                active.afterIndexCapture.detectorEpoch,
              ),
              detectorEpoch: active.afterProjectDetectorEpoch,
            }
          : {
              capture: this.cachedProjectCapture(
                active.beforeIndexCapture.manifest.id,
                active.beforeIndexRevisionHash,
                active.beforeIndexCapture.detectorEpoch,
              ),
              detectorEpoch: active.beforeProjectDetectorEpoch,
            };
    if (!expected.capture || expected.detectorEpoch === undefined)
      throw new Error("Recovered finalization has no durable expected-current project capture");
    if (
      receipt.expectedCurrentProjectIndexManifestId !== expected.capture.indexManifest.id ||
      receipt.expectedCurrentProjectRevisionHash !== expected.capture.revision.hash ||
      receipt.expectedCurrentProjectDetectorEpoch !== expected.detectorEpoch
    )
      throw new Error("Recovered finalization expected-current project gate mismatch");
  }

  private async acknowledgeFinalization(
    studio: StudioBridgeSession,
    finalized: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>,
    attemptHash?: string,
    authority?: ProjectAuthorityLease,
  ): Promise<void> {
    this.assertProjectAuthority(authority);
    if (attemptHash !== undefined) requiredHash(attemptHash, "Persisted creator mutation attempt");
    const settledStatus = finalized.payload.action === "commit" ? "committed" : "cancelled";
    if (finalized.payload.status !== settledStatus)
      throw new Error("Creator finalization receipt is not settled and cannot be acknowledged");
    const retained = await this.awaitProjectAuthority(
      authority,
      this.retainFinalizationReceipt(studio, finalized),
    );
    const requestId = retained.requestId;
    const authorityHash = attemptHash ?? retained.pending.authorityHash;
    if (authorityHash !== retained.pending.authorityHash)
      this.pendingFinalizationAcknowledgements.set(requestId, {
        ...retained.pending,
        authorityHash,
      });
    const bundle = this.bundles.get(finalized.payload.creatorSessionId);
    if (bundle && this.hasPendingTransactionProjectChange(bundle.session.id)) {
      this.scheduleTransactionProjectChangeConfirmation(bundle.session.id);
      return;
    }
    this.assertProjectAuthority(authority);
    this.recordingScans.set(studio.sessionId, {
      projectId: studio.projectId,
      status: "blocked",
      detail:
        "Studio retains a settled creator finalization receipt; waiting for its exact durable acknowledgement and a fresh transaction-inventory report.",
    });
    try {
      this.assertProjectAuthority(authority);
      await this.awaitProjectAuthority(
        authority,
        this.sendFinalizationAcknowledgement(
          studio,
          requestId,
          this.pendingFinalizationAcknowledgements.get(requestId)!,
        ),
      );
    } catch (error) {
      if (error instanceof ProjectAuthorityRevokedError) throw error;
      // The exact receipt stays durable in the connector and will be replayed
      // on re-pair. The already-persisted creator outcome is not rolled back or
      // reclassified because notification acknowledgement transport failed.
    }
  }

  private async retainFinalizationReceipt(
    studio: StudioBridgeSession,
    finalized: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>,
  ): Promise<{
    requestId: string;
    pending: {
      studioSessionId: string;
      projectId: string;
      receipt: Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }>["payload"];
      receiptArtifact: ArtifactReference;
      authorityHash: string;
    };
  }> {
    const receiptArtifact = await this.artifactStore.write(finalized.payload);
    const existing = [...this.pendingFinalizationAcknowledgements.entries()].find(
      ([, pending]) =>
        pending.studioSessionId === studio.sessionId &&
        pending.receiptArtifact.artifactHash === receiptArtifact.artifactHash,
    );
    if (existing) return { requestId: existing[0], pending: existing[1] };
    const requestId = `creator_finalization_ack_${randomUUID()}`;
    const pending = {
      studioSessionId: studio.sessionId,
      projectId: studio.projectId,
      receipt: structuredClone(finalized.payload),
      receiptArtifact,
      authorityHash: receiptArtifact.artifactHash,
    };
    await this.artifactStore.write({
      kind: "CreatorChangeFinalizationReceiptDelivery",
      studioSessionId: studio.sessionId,
      projectId: studio.projectId,
      receipt: receiptArtifact,
      receivedAt: finalized.sentAt,
    });
    this.pendingFinalizationAcknowledgements.set(requestId, pending);
    return { requestId, pending };
  }

  private async sendClosedRecordingAcknowledgement(requestId: string): Promise<void> {
    const pending = this.pendingClosedRecordingAcknowledgements.get(requestId);
    if (!pending) return;
    if (pending.bundleId && this.hasPendingTransactionProjectChange(pending.bundleId)) return;
    await this.input.connection.send(
      createBackendMessage(
        "AcknowledgeClosedCreatorRecording",
        {
          requestId,
          creatorSessionId: pending.creatorSessionId,
          changeSetId: pending.changeSetId,
          changeSetHash: pending.changeSetHash,
          projectionId: pending.projectionId,
          projectionHash: pending.projectionHash,
          manifestHash: pending.manifestHash,
          beforeProjectIndexManifestId: pending.beforeProjectIndexManifestId,
          beforeProjectRevisionHash: pending.beforeProjectRevisionHash,
          beforeProjectDetectorEpoch: pending.beforeProjectDetectorEpoch,
          recordingId: pending.recordingId,
          recoveryProjectIndexManifestId: pending.recoveryProjectIndexManifestId,
          recoveryProjectRevisionHash: pending.recoveryProjectRevisionHash,
          recoveryProjectDetectorEpoch: pending.recoveryProjectDetectorEpoch,
        },
        pending.studioSessionId,
        requestId,
      ),
    );
  }

  /** Resume notification acknowledgements only after dirty evidence cleared. */
  private async flushDeferredTransactionAcknowledgements(sessionId: string): Promise<void> {
    if (this.hasPendingTransactionProjectChange(sessionId)) return;
    for (const [requestId, pending] of this.pendingClosedRecordingAcknowledgements)
      if (pending.bundleId === sessionId) await this.sendClosedRecordingAcknowledgement(requestId);
    const studio = this.pairedStudio();
    if (!studio) return;
    for (const [requestId, pending] of this.pendingFinalizationAcknowledgements) {
      if (
        pending.receipt.creatorSessionId !== sessionId ||
        pending.studioSessionId !== studio.sessionId
      )
        continue;
      await this.sendFinalizationAcknowledgement(studio, requestId, pending);
    }
  }

  private async sendFinalizationAcknowledgement(
    studio: StudioBridgeSession,
    requestId: string,
    pending: typeof this.pendingFinalizationAcknowledgements extends Map<string, infer Value>
      ? Value
      : never,
  ): Promise<void> {
    const receipt = pending.receipt;
    await this.input.connection.send(
      createBackendMessage(
        "AcknowledgeCreatorChangeFinalization",
        {
          requestId,
          creatorSessionId: receipt.creatorSessionId,
          changeSetId: receipt.changeSetId,
          changeSetHash: receipt.changeSetHash,
          projectionId: receipt.projectionId,
          projectionHash: receipt.projectionHash,
          manifestHash: receipt.manifestHash,
          beforeProjectIndexManifestId: receipt.beforeProjectIndexManifestId,
          beforeProjectRevisionHash: receipt.beforeProjectRevisionHash,
          beforeProjectDetectorEpoch: receipt.beforeProjectDetectorEpoch,
          recordingId: receipt.recordingId,
          action: receipt.action,
          finalizationKind: receipt.finalizationKind,
          ...(receipt.replacesAction === undefined
            ? {}
            : { replacesAction: receipt.replacesAction }),
          expectedCurrentProjectIndexManifestId: receipt.expectedCurrentProjectIndexManifestId,
          expectedCurrentProjectRevisionHash: receipt.expectedCurrentProjectRevisionHash,
          expectedCurrentProjectDetectorEpoch: receipt.expectedCurrentProjectDetectorEpoch,
          status: receipt.action === "commit" ? "committed" : "cancelled",
          afterProjectIndexManifestId: receipt.afterProjectIndexManifestId,
          afterProjectRevisionHash: receipt.afterProjectRevisionHash,
          afterProjectDetectorEpoch: receipt.afterProjectDetectorEpoch,
        },
        studio.sessionId,
        requestId,
      ),
    );
  }

  private setRecordingInventoryClearIfSettled(
    studio: StudioBridgeSession,
    clearDetail: string,
  ): void {
    const pendingFinalization = [...this.pendingFinalizationAcknowledgements.values()].some(
      (pending) => pending.studioSessionId === studio.sessionId,
    );
    this.recordingScans.set(studio.sessionId, {
      projectId: studio.projectId,
      status: pendingFinalization ? "blocked" : "clear",
      detail: pendingFinalization
        ? "Studio retains a settled creator finalization receipt; an unrelated recording-inventory report cannot acknowledge it."
        : clearDetail,
    });
  }

  private async finalizeRecording(
    studio: StudioBridgeSession,
    sessionId: string,
    changeSet: CreatorChangeSet,
    projection: StudioEvidenceProjection,
    beforeIndexCapture: StudioProjectIndexCapture,
    recordingId: string,
    expectedCurrentIndexCapture: StudioProjectIndexCapture,
    expectedCurrentProjectDetectorEpoch: number,
    action: "commit" | "cancel",
    messages: PluginToBackendMessage[],
    authority?: ProjectAuthorityLease,
  ) {
    const requestId = `creator_finalize_${randomUUID()}`;
    const exactTransaction = {
      creatorSessionId: sessionId,
      changeSetId: changeSet.id,
      changeSetHash: changeSet.hash,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      beforeProjectIndexManifestId: beforeIndexCapture.indexManifest.id,
      beforeProjectRevisionHash: beforeIndexCapture.revision.hash,
      beforeProjectDetectorEpoch: beforeIndexCapture.detectorEpoch,
    } as const;
    this.assertProjectAuthority(authority);
    this.assertFinalizationGateClear(sessionId);
    this.beginFinalizationRequest(requestId);
    try {
      this.assertProjectAuthority(authority);
      await this.awaitProjectAuthority(
        authority,
        this.input.connection.send(
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
              beforeProjectIndexManifestId: beforeIndexCapture.indexManifest.id,
              beforeProjectRevisionHash: beforeIndexCapture.revision.hash,
              beforeProjectDetectorEpoch: beforeIndexCapture.detectorEpoch,
              recordingId,
              action,
              finalizationKind: "ordinary",
              expectedCurrentProjectIndexManifestId: expectedCurrentIndexCapture.indexManifest.id,
              expectedCurrentProjectRevisionHash: expectedCurrentIndexCapture.revision.hash,
              expectedCurrentProjectDetectorEpoch,
            },
            studio.sessionId,
            requestId,
          ),
        ),
      );
      return this.awaitProjectAuthority(
        authority,
        waitFor(
          messages,
          (
            message,
          ): message is Extract<PluginToBackendMessage, { type: "CreatorChangeFinalized" }> =>
            message.type === "CreatorChangeFinalized" &&
            message.requestId === requestId &&
            matchesExactTransactionBinding(message.payload, exactTransaction) &&
            message.payload.recordingId === recordingId &&
            message.payload.action === action &&
            message.payload.finalizationKind === "ordinary" &&
            message.payload.expectedCurrentProjectIndexManifestId ===
              expectedCurrentIndexCapture.indexManifest.id &&
            message.payload.expectedCurrentProjectRevisionHash ===
              expectedCurrentIndexCapture.revision.hash &&
            message.payload.expectedCurrentProjectDetectorEpoch ===
              expectedCurrentProjectDetectorEpoch &&
            message.payload.status === (action === "commit" ? "committed" : "cancelled"),
          this.timeout(),
          `creator change ${action}`,
          requestId,
        ),
      );
    } finally {
      this.endFinalizationRequest(requestId);
    }
  }

  private beginFinalizationRequest(requestId: string): void {
    if (this.activeFinalizationRequests.has(requestId))
      throw new Error(`Duplicate live creator finalization request ${requestId}`);
    this.activeFinalizationRequests.add(requestId);
  }

  private endFinalizationRequest(requestId: string): void {
    this.activeFinalizationRequests.delete(requestId);
  }

  private async publishView(
    bundle: CreatorSessionBundle,
    detailValue: string,
    authority?: ProjectAuthorityLease,
  ): Promise<void> {
    this.assertProjectAuthority(authority);
    const epoch = (this.viewPublicationEpochs.get(bundle.session.id) ?? 0) + 1;
    this.viewPublicationEpochs.set(bundle.session.id, epoch);
    let view: CreatorTransactionControlView;
    try {
      view = await this.view(bundle, detailValue);
    } catch (error) {
      // Authority revocation is a semantic safety boundary and must still
      // interrupt the owning continuation. Every other failure here belongs
      // only to the derived control-plane presentation: the bundle was
      // already persisted by its caller and must not be reclassified as a
      // failed Studio observation, mutation, or finalization.
      this.assertProjectAuthority(authority);
      this.views.delete(bundle.session.id);
      this.recordDeferredTaskFailure(bundle.session.id, "control-view materialization", error);
      return;
    }
    this.assertProjectAuthority(authority);
    const current = this.bundles.get(bundle.session.id);
    if (
      this.viewPublicationEpochs.get(bundle.session.id) !== epoch ||
      current?.session.hash !== bundle.session.hash
    )
      return;
    this.assertProjectAuthority(authority);
    this.views.set(bundle.session.id, view);
    this.emit();
  }

  /**
   * Runtime lifecycle notifications come from the request-bound studio-runtime
   * execution, not the coordinator's broad protocol subscription. A sealed
   * plan may be re-armed with the same hash, so plan/project matching alone
   * could otherwise make the dashboard show an old Play session as current.
   */
  private async setVerificationPlayObservation(
    sessionId: string,
    event: "started" | "stopped",
  ): Promise<void> {
    const bundle = this.bundles.get(sessionId);
    if (!bundle || bundle.session.status !== "verifying") return;
    if (event === "started") {
      this.observingCreatorPlay.add(sessionId);
      await this.publishView(
        bundle,
        "Studio Play was detected. Forge is capturing only the approved bounded facts; press Stop when the interaction is complete.",
      );
      return;
    }
    this.observingCreatorPlay.delete(sessionId);
    await this.publishView(
      bundle,
      "Studio returned to Edit mode. Forge is grading the exact Stop-sealed evidence.",
    );
  }

  private capture(
    studio: StudioBridgeSession,
    messages: PluginToBackendMessage[],
    indexStreams?: StudioProjectIndexStreamRouter,
  ): () => void {
    return this.input.connection.subscribeWithSession((message, session) => {
      if (session.sessionId === studio.sessionId && message.sessionId === studio.sessionId) {
        if (indexStreams?.observe(message)) return;
        messages.push(message);
      }
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
    if (!("getSessions" in this.input.connection) && this.pairedSession) return this.pairedSession;
    throw new Error("Exactly one Studio project must be paired with forge creator serve");
  }
  private async currentAttestedStudioSession(): Promise<StudioBridgeSession> {
    const studio = await this.currentStudioSession();
    const deadline = Date.now() + Math.min(this.timeout(), 15_000);
    while (Date.now() < deadline) {
      const attestation = this.attestations.get(studio.sessionId);
      if (attestation?.status === "verified") return studio;
      if (attestation?.status === "rejected")
        throw new Error(`Studio capability attestation was rejected: ${attestation.detail}`);
      if (attestation?.status === "incomplete")
        throw new Error(`Studio capability attestation is incomplete: ${attestation.detail}`);
      await new Promise((resolveValue) => setTimeout(resolveValue, 50));
    }
    throw new Error(
      "The paired Studio connector did not produce a complete capability attestation",
    );
  }
  private async requireClearRecordingInventory(studio: StudioBridgeSession): Promise<void> {
    const deadline = Date.now() + Math.min(this.timeout(), 15_000);
    while (Date.now() < deadline) {
      const scan = this.recordingScans.get(studio.sessionId);
      const pendingFinalization = [...this.pendingFinalizationAcknowledgements.values()].some(
        (pending) => pending.studioSessionId === studio.sessionId,
      );
      if (scan?.status === "clear" && !pendingFinalization) return;
      if (scan?.status === "blocked") throw new Error(scan.detail);
      await new Promise((resolveValue) => setTimeout(resolveValue, 50));
    }
    throw new Error(
      "The paired Studio connector did not report its durable creator-transaction state",
    );
  }
  private timeout(): number {
    // A complete project index is allowed ten minutes by its persisted
    // resource policy. The control transport gets one additional minute to
    // seal and verify the final streamed artifact graph. Tests and explicit
    // operator configuration can still select a smaller bound.
    return this.input.timeoutMs ?? 660_000;
  }
  private async creatorRequest(bundle: CreatorSessionBundle) {
    const request = await this.artifactStore.read(
      bundle.creatorRequest,
      assertCreatorRequestArtifact,
    );
    if (request.sessionId !== bundle.session.id || request.promptHash !== bundle.session.promptHash)
      throw new Error("Creator request artifact does not bind its session");
    return request;
  }
  private async creatorPrompt(bundle: CreatorSessionBundle): Promise<string> {
    return (await this.creatorRequest(bundle)).creatorText;
  }
  private async agentPrompt(bundle: CreatorSessionBundle): Promise<string> {
    return (await this.creatorRequest(bundle)).agentPrompt;
  }
  private async sourceEvidence(bundle: CreatorSessionBundle): Promise<{
    sourceIndex: StudioSourceIndex;
    sourceConsultation: CreatorSourceConsultation;
    sourceResolver: VerifiedSourceResolver;
  }> {
    const plan = bundle.plan;
    if (!plan) throw new Error("Creator source evidence requires a plan");
    const indexBinding = bundle.sourceIndices.find(
      (binding) => binding.id === plan.sourceIndexId && binding.hash === plan.sourceIndexHash,
    );
    const consultationBinding = bundle.sourceConsultations.find(
      (binding) =>
        binding.id === plan.sourceConsultationId &&
        binding.hash === plan.sourceConsultationHash &&
        binding.indexId === plan.sourceIndexId &&
        binding.indexHash === plan.sourceIndexHash,
    );
    if (!indexBinding || !consultationBinding)
      throw new Error("Creator plan lost its source consultation evidence");
    const sourceIndex = await this.artifactStore.read(
      indexBinding.artifact,
      assertStudioSourceIndex,
    );
    const sourceConsultation = (await this.artifactStore.read(
      consultationBinding.artifact,
    )) as CreatorSourceConsultation;
    assertCreatorSourceConsultation(sourceConsultation, sourceIndex);
    const projectBinding = bundle.projectIndices.find(
      (binding) => binding.captureHash === sourceIndex.snapshotHash,
    );
    if (!projectBinding) throw new Error("Creator source index lost its exact project capture");
    const capture = await readCreatorProjectIndexArtifacts(this.artifactStore, projectBinding);
    return {
      sourceIndex,
      sourceConsultation,
      sourceResolver: this.projectSourceMaterial(capture).resolver,
    };
  }

  private async sealedSourceIndex(
    sessionId: string,
    sourceIndexHash: string,
  ): Promise<StudioSourceIndex> {
    const bundle = await this.bundle(sessionId);
    const binding = bundle.sourceIndices.find((candidate) => candidate.hash === sourceIndexHash);
    if (!binding) throw new Error("This session does not retain the requested sealed source index");
    const index = await this.artifactStore.read(binding.artifact, assertStudioSourceIndex);
    if (index.id !== binding.id || index.hash !== sourceIndexHash)
      throw new Error("Sealed source-index artifact binding mismatch");
    return index;
  }

  private async sealedSourceMaterial(
    sessionId: string,
    sourceIndexHash: string,
  ): Promise<{
    index: StudioSourceIndex;
    resolver: import("../../source-intelligence/src/index.js").AsyncVerifiedSourceResolver;
  }> {
    const bundle = await this.bundle(sessionId);
    const index = await this.sealedSourceIndex(sessionId, sourceIndexHash);
    const projectBinding = bundle.projectIndices.find(
      (candidate) => candidate.captureHash === index.snapshotHash,
    );
    if (!projectBinding) throw new Error("Source index lost its exact Studio project capture");
    const material = await readCreatorProjectIndexMetadataArtifacts(
      this.artifactStore,
      projectBinding,
    );
    if (projectBinding.captureHash !== index.snapshotHash)
      throw new Error("Source index lost its exact Studio project capture");
    return { index, resolver: material.sourceResolver };
  }

  private async sourceSyncPresentation(
    bundle: CreatorSessionBundle,
  ): Promise<CreatorTransactionControlView["sourceSync"]> {
    const mutation = bundle.rojoSourceMutations.at(-1);
    if (!mutation) return undefined;
    if (mutation.revert) {
      const proof = mutation.revertSyncProofs.at(-1);
      if (!proof)
        return {
          status: "reverted",
          attemptId: mutation.attempt.id,
          artifact: mutation.revert.artifact,
        };
      const value = await this.artifactStore.read(proof.artifact, assertRojoSourceRevertSyncProof);
      return {
        status:
          value.status === "matched"
            ? "reverted"
            : value.status === "mismatched"
              ? "mismatched"
              : "awaiting",
        attemptId: mutation.attempt.id,
        artifact: proof.artifact,
      };
    }
    const proof = mutation.syncProofs.at(-1);
    if (!proof) return { status: "awaiting", attemptId: mutation.attempt.id };
    const value = await this.artifactStore.read(proof.artifact, assertRojoSyncProof);
    return {
      status:
        value.status === "matched"
          ? "matched"
          : value.status === "mismatched"
            ? "mismatched"
            : "awaiting",
      attemptId: mutation.attempt.id,
      artifact: proof.artifact,
    };
  }

  private async view(
    bundle: CreatorSessionBundle,
    detailValue: string,
  ): Promise<CreatorTransactionControlView> {
    const prompt = await this.creatorPrompt(bundle);
    const changeSet = activeChangeSet(bundle);
    const activeMutation = bundle.activeMutation;
    const settledVerification = bundle.verifications.at(-1);
    const draftVerification = activeMutation?.verificationDraft
      ? await this.artifactStore.read(
          activeMutation.verificationDraft.artifact,
          assertCreatorVerificationRecord,
        )
      : undefined;
    // An active mutation draft is the current verification authority. A
    // settled verification from an earlier repair attempt must never shadow
    // the Stop-sealed evidence for the recording that is open now.
    const verification = draftVerification ?? settledVerification;
    const runtimeEvidence = verification?.runtimeEvidence
      ? await this.artifactStore.read(
          verification.runtimeEvidence.artifact,
          assertStudioEvidenceEnvelope,
        )
      : undefined;
    const latestRojoMutation = bundle.rojoSourceMutations.at(-1);
    const sourceSync = await this.sourceSyncPresentation(bundle);
    const [planArtifact, changeSetArtifact, verificationArtifact] = await Promise.all([
      bundle.plan ? this.artifactStore.write(bundle.plan) : undefined,
      changeSet ? this.artifactStore.write(changeSet) : undefined,
      activeMutation?.verificationDraft?.artifact ??
        (settledVerification ? this.artifactStore.write(settledVerification) : undefined),
    ]);
    const latestRun = bundle.agentRuns.at(-1);
    const latestAttempt = bundle.mutationAttempts.at(-1);
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
    const currentIndexBinding = bundle.projectIndices.find(
      (entry) => entry.revision.hash === bundle.session.currentRevisionHash,
    );
    const latestConsultation = bundle.sourceConsultations.at(-1);
    const latestChange = bundle.projectChanges.at(-1);
    const latestRefresh = bundle.projectRefreshes.at(-1);
    const artifacts = {
      prompt: bundle.creatorRequest,
      ...(currentIndexBinding ? { projectIndex: currentIndexBinding.revision.artifact } : {}),
      ...(latestConsultation ? { sourceConsultation: latestConsultation.artifact } : {}),
      ...(latestChange ? { projectChangeNotice: latestChange.artifact } : {}),
      ...(latestRefresh ? { projectDelta: latestRefresh.refresh.delta } : {}),
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
      ...((latestAttempt ?? activeMutation)
        ? {
            capabilityManifest: (latestAttempt ?? activeMutation)!.manifest.artifact,
            mutationProjection: (latestAttempt ?? activeMutation)!.projection.artifact,
            ...((latestAttempt ?? activeMutation)!.preflight
              ? {
                  mutationPreflight: (latestAttempt ?? activeMutation)!.preflight!.envelope
                    .artifact,
                }
              : {}),
          }
        : {}),
      ...(latestAttempt?.completion === "settled"
        ? {
            mutationReadback: latestAttempt.directReadback.artifact,
            mutationReconciliation: latestAttempt.reconciliation.artifact,
            mutationFinalization: latestAttempt.finalization.artifact,
          }
        : activeMutation
          ? {
              ...(activeMutation.directReadback
                ? { mutationReadback: activeMutation.directReadback.artifact }
                : {}),
              ...(activeMutation.reconciliation
                ? {
                    mutationReconciliation: activeMutation.reconciliation.artifact,
                  }
                : {}),
            }
          : {}),
      ...(attestation?.status === "verified"
        ? { capabilityAttestation: attestation.artifact }
        : (latestAttempt ?? activeMutation)
          ? {
              capabilityAttestation: (latestAttempt ?? activeMutation)!.attestation.envelope
                .artifact,
            }
          : {}),
      ...(verificationArtifact ? { verification: verificationArtifact } : {}),
      ...(bundle.review ? { reviewReport: bundle.review.artifact } : {}),
      ...(bundle.projectAuthority
        ? { projectAuthorityMap: bundle.projectAuthority.authorityMap.artifact }
        : {}),
      ...(latestRojoMutation
        ? {
            rojoSourceChangeSet: latestRojoMutation.changeSet.artifact,
            rojoMutationAttempt: latestRojoMutation.attempt.artifact,
            ...(sourceSync?.artifact ? { sourceSync: sourceSync.artifact } : {}),
            ...(latestRojoMutation.revert
              ? { sourceRevert: latestRojoMutation.revert.artifact }
              : {}),
            ...(latestRojoMutation.revertSyncProofs.at(-1)
              ? {
                  sourceRevertSync: latestRojoMutation.revertSyncProofs.at(-1)!.artifact,
                }
              : {}),
          }
        : {}),
      ...(latestRun ? { agentRun: latestRun.agentRun, trace: latestRun.trace } : {}),
    };
    const recovery = this.recordingRecovery.get(bundle.session.id);
    const recordingScan =
      studio?.projectId === bundle.session.projectId
        ? this.recordingScans.get(studio.sessionId)
        : undefined;
    const applyReady =
      studio?.projectId === bundle.session.projectId &&
      attestation?.status === "verified" &&
      this.isRecordingInventoryClear(studio);
    const effectiveDetail =
      bundle.session.status === "awaiting_change_approval" && !applyReady
        ? `${detailValue} Apply is unavailable until Studio transaction inventory is closed${recordingScan?.detail ? `: ${recordingScan.detail}` : "."}`
        : detailValue;
    const currentCapture = await this.captureForBundle(bundle);
    const currentObservation = projectIndexViewForCreator(
      studioProjectIndexMetadataView(currentCapture),
    );
    const reviewObservation = changeSet
      ? projectIndexViewForCreator(
          studioProjectIndexMetadataView(
            await this.changeReviewCaptureForBundle(bundle, changeSet),
          ),
        )
      : currentObservation;
    const sourceConsultationEvidence = latestConsultation
      ? ((await this.artifactStore.read(latestConsultation.artifact)) as CreatorSourceConsultation)
      : undefined;
    if (sourceConsultationEvidence) {
      const sourceIndexBinding = bundle.sourceIndices.find(
        (entry) => entry.hash === sourceConsultationEvidence.indexHash,
      );
      if (!sourceIndexBinding)
        throw new Error("Source consultation has no immutable source-index binding");
      const sourceIndex = await this.artifactStore.read(
        sourceIndexBinding.artifact,
        assertStudioSourceIndex,
      );
      assertCreatorSourceConsultation(sourceConsultationEvidence, sourceIndex);
    }
    return controlView(
      bundle,
      reviewObservation,
      effectiveDetail,
      prompt,
      artifacts,
      mutationPresentation,
      verification
        ? {
            id: verification.id,
            status: verification.status,
            failureFacts: verification.failureFacts.map((fact) => ({
              ...fact,
            })),
            replayable: verification.status !== "incomplete",
            ...(runtimeEvidence ? { runtimeSummary: creatorRuntimeSummary(runtimeEvidence) } : {}),
          }
        : undefined,
      {
        status:
          bundle.session.status === "indexing" || bundle.session.status === "refreshing"
            ? "indexing"
            : bundle.session.status === "refresh_required"
              ? "dirty"
              : "complete",
        authorityMode:
          bundle.changeSets.at(-1)?.mutationAuthority ??
          bundle.plan?.mutationAuthority ??
          "studio_document",
        connectorEpoch: currentCapture.revision.connectorEpoch,
        manifestHash: currentCapture.indexManifest.hash,
        rootHash: currentCapture.revision.merkleRoot,
        indexedInstances: currentCapture.indexManifest.instanceCount,
        indexedBytes: currentCapture.indexManifest.canonicalBytes,
        sourceBlobs: currentCapture.sourceManifests.length,
        dirty: bundle.session.status === "refresh_required",
        ...(currentIndexBinding ? { artifact: currentIndexBinding.revision.artifact } : {}),
      },
      latestConsultation
        ? {
            artifact: latestConsultation.artifact,
            sourceIndexHash: latestConsultation.indexHash,
            sourceCount: sourceConsultationEvidence!.sources.length,
            rangeCount: sourceConsultationEvidence!.sources.reduce(
              (count, source) => count + source.ranges.length,
              0,
            ),
            dependencyNodeCount: sourceConsultationEvidence!.dependencies.length,
          }
        : undefined,
      latestChange
        ? {
            detectedAt: latestChange.notice.detectedAt,
            reasons: [...latestChange.notice.reasons],
            notice: latestChange.artifact,
            ...(latestRefresh ? { delta: latestRefresh.refresh.delta } : {}),
            ...(bundle.predecessorSessionId
              ? { predecessorSessionId: bundle.predecessorSessionId }
              : {}),
            ...(bundle.successorSessionId ? { successorSessionId: bundle.successorSessionId } : {}),
          }
        : undefined,
      sourceSync,
      recovery?.recordingState === "open" && recovery.recordingId === activeMutation?.recordingId,
      this.observingCreatorPlay.has(bundle.session.id),
      applyReady,
      Boolean(latestRojoMutation && !latestRojoMutation.revert),
    );
  }

  private async mutationPresentation(
    bundle: CreatorSessionBundle,
    attempt: CreatorMutationAttempt | undefined,
    active: CreatorActiveMutation | undefined,
  ): Promise<CreatorTransactionControlView["mutation"]> {
    const cursor = attempt ?? active;
    if (!cursor) return undefined;
    const projection = (await this.artifactStore.read(
      cursor.projection.artifact,
    )) as StudioEvidenceProjection;
    const reconciliationBinding =
      attempt?.completion === "settled" ? attempt.reconciliation : active?.reconciliation;
    const reconciliation = reconciliationBinding
      ? ((await this.artifactStore.read(
          reconciliationBinding.artifact,
        )) as CreatorMutationReconciliation)
      : undefined;
    const failureFacts = (
      attempt?.completion === "incomplete"
        ? attempt.failureFacts
        : (reconciliation?.failureFacts ?? [])
    ).map((fact) => ({
      code: fact.code,
      statement: fact.detail,
      hash: fact.hash,
    }));
    const status = attempt
      ? bundle.checkpoint?.mutationAttemptId === attempt.id
        ? bundle.checkpoint.status === "rolled_back"
          ? ("rolled_back" as const)
          : ("committed" as const)
        : attempt.completion === "incomplete"
          ? (preRecordingFailureStatus(attempt.failureFacts) ??
            (attempt.phase === "preflight"
              ? ("preflight_failed" as const)
              : ("incomplete" as const)))
          : attempt.finalization.hash
            ? ("cancelled" as const)
            : (reconciliation?.status ?? "incomplete")
      : bundle.session.status === "recovery_required"
        ? ("recovery_required" as const)
        : (reconciliation?.status ??
          (active?.stage === "preflighted" ? ("preflighting" as const) : ("provisional" as const)));
    return {
      attemptId: attempt?.id ?? active!.attemptId,
      status,
      failureFacts,
      replayable: attempt?.completion === "settled" && reconciliation?.status !== "incomplete",
      projectionFactCount: projection.requirements.length,
    };
  }
  private async bundle(id: string): Promise<CreatorSessionBundle> {
    const cached = this.bundles.get(id);
    if (cached) return cached;
    const loaded = await loadCreatorBundle(join(resolve(this.input.directory), `${id}.json`));
    this.bundles.set(id, loaded);
    return loaded;
  }
  private async persist(bundle: CreatorSessionBundle): Promise<CreatorSessionBundle> {
    const sessionId = bundle.session.id;
    const previous = this.bundlePersistQueues.get(sessionId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        const current = this.mergeConcurrentProjectChanges(bundle);
        this.bundles.set(current.session.id, current);
        const durable = this.bundles.get(current.session.id)!;
        await persistCreatorBundle(durable, this.input.directory);
        this.emit();
      });
    this.bundlePersistQueues.set(sessionId, write);
    try {
      await write;
      return this.bundles.get(sessionId)!;
    } finally {
      if (this.bundlePersistQueues.get(sessionId) === write)
        this.bundlePersistQueues.delete(sessionId);
    }
  }

  /**
   * A Studio dirty receipt is persisted by the bridge queue while an Apply or
   * finalization continuation can still hold an older local bundle value.
   * Preserve the append-only notice edge (and its later confirmation) when
   * that continuation writes another part of the transaction graph.  This is
   * deliberately narrower than a generic last-writer-wins merge: lifecycle
   * state, mutation evidence, and approvals remain serialized by their own
   * exact protocol paths.
   */
  private mergeConcurrentProjectChanges(bundle: CreatorSessionBundle): CreatorSessionBundle {
    return mergeCreatorProjectChangeEdges(bundle, this.bundles.get(bundle.session.id));
  }
  private async finish(
    bundle: CreatorSessionBundle,
    message: string,
    authority?: ProjectAuthorityLease,
  ): Promise<unknown> {
    this.assertProjectAuthority(authority);
    bundle = this.mergeConcurrentProjectChanges(bundle);
    this.bundles.set(bundle.session.id, bundle);
    bundle = await this.awaitProjectAuthority(authority, this.persist(bundle));
    await this.publishView(bundle, message, authority);
    if (
      isTerminalStatus(bundle.session.status) &&
      !this.hasPendingTransactionProjectChange(bundle.session.id)
    )
      this.finalizedTransactionProjectChangeCaptures.delete(bundle.session.id);
    return summary(bundle);
  }
  private async drift(
    bundle: CreatorSessionBundle,
    message: string,
    authority?: ProjectAuthorityLease,
  ): Promise<unknown> {
    bundle = {
      ...bundle,
      session: advanceSession(bundle.session, {
        status: "incomplete",
        failure: { code: "project_drift", detail: message },
      }),
    };
    return this.finish(bundle, message, authority);
  }
  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.inFlight.has(key))
      throw new Error("A creator operation is already running for this session");
    this.inFlight.add(key);
    try {
      return await operation();
    } finally {
      this.inFlight.delete(key);
      // Only ordinary creator-session locks carry transaction confirmation
      // barriers. Project-start locks use a distinct key and cannot schedule
      // one. Schedule after releasing the lock so a deferred worker cannot be
      // swallowed by its own still-live scheduled marker.
      if (
        this.bundles.has(key) &&
        this.hasBoundPendingTransactionProjectChange(key) &&
        (this.pendingTransactionProjectChangeIngress.get(key)?.size ?? 0) === 0 &&
        this.hasTransactionProjectChangeConfirmationBaseline(key)
      ) {
        this.transactionProjectConfirmationRequestedAfterLockRelease.add(key);
        this.scheduleTransactionProjectChangeConfirmation(key);
      }
    }
  }

  private scheduleAutomaticVerification(sessionId: string): void {
    if (this.automaticVerifications.has(sessionId)) return;
    this.automaticVerifications.add(sessionId);
    setTimeout(() => {
      void this.lock(sessionId, async () => {
        const bundle = await this.bundle(sessionId);
        if (bundle.session.status !== "awaiting_verification") return summary(bundle);
        return this.verify(bundle);
      })
        .catch(async (error) => {
          try {
            await this.recoverAutomaticVerificationFailure(sessionId, error);
          } catch (recoveryError) {
            // Recovery is a background safety path.  Its own failure cannot
            // be allowed to escape the timer queue or create new evidence.
            this.recordDeferredTaskFailure(
              sessionId,
              "automatic verification recovery",
              recoveryError,
            );
          }
        })
        .finally(() => {
          this.automaticVerifications.delete(sessionId);
        })
        .catch((error: unknown) => {
          // Keep a terminal non-throwing handler after `finally`: a future
          // cleanup change must not accidentally turn this timer into an
          // unhandled rejection.
          this.recordDeferredTaskFailure(sessionId, "automatic verification scheduler", error);
        });
    }, 0);
  }

  private async recoverAutomaticVerificationFailure(
    sessionId: string,
    error: unknown,
  ): Promise<void> {
    const bundle = await this.bundle(sessionId).catch(() => undefined);
    if (!bundle) return;
    if (bundle.session.status === "awaiting_verification") {
      await this.publishView(
        bundle,
        `Forge could not arm the next Studio Play session: ${detail(error)}. The provisional change remains open and no automatic retry occurred.`,
      ).catch(() => undefined);
      return;
    }
    if (
      !(["verifying", "repairing", "committing", "cancelling"] as readonly string[]).includes(
        bundle.session.status,
      )
    )
      return;
    const pending = this.pendingRecordings.get(sessionId);
    const active = bundle.activeMutation;
    const coherentCursor =
      active !== undefined &&
      pending !== undefined &&
      active.attemptId === pending.attemptId &&
      active.recordingId !== undefined &&
      active.recordingId === pending.recordingId;
    const failureCode = coherentCursor
      ? "studio_transaction_interrupted"
      : "verification_transaction_cursor_inconsistent";
    const failureDetail = coherentCursor
      ? `Automatic verification stopped during ${bundle.session.status} after Studio may have retained or finalized the exact recording: ${detail(error)}`
      : `Automatic verification stopped during ${bundle.session.status}, but the host's active and pending recording cursors no longer agree: ${detail(error)}`;
    const recoveryBundle = {
      ...bundle,
      session: advanceSession(bundle.session, {
        status: "recovery_required",
        failure: { code: failureCode, detail: failureDetail },
      }),
    };
    this.bundles.set(sessionId, recoveryBundle);
    try {
      await this.persist(recoveryBundle);
    } catch (persistenceError) {
      await this.publishView(
        recoveryBundle,
        `Forge entered fail-closed recovery in memory, but could not persist that transition: ${detail(persistenceError)}. No further Studio command or automatic retry was issued.`,
      ).catch(() => {
        this.views.delete(sessionId);
        this.emit();
      });
      return;
    }
    await this.publishView(
      recoveryBundle,
      coherentCursor
        ? "Automatic Play verification was interrupted after a recording might have been finalized. Forge did not re-arm, commit, cancel, or discard the exact transaction cursor; reconnect Studio to inspect durable recovery state."
        : "Automatic Play verification lost a coherent exact recording cursor. Forge stopped fail-closed and will not issue another Studio command until recovery evidence is re-established.",
    ).catch(() => undefined);
  }

  /**
   * Retain operational follow-up failures separately from transaction
   * evidence.  In particular, a local dashboard/socket or acknowledgement
   * failure after a durable confirmation must not be rewritten as a Studio
   * observation failure.
   */
  private recordDeferredTaskFailure(sessionId: string, phase: string, error: unknown): void {
    this.deferredTaskFailures.set(
      sessionId,
      `Forge retained its existing transaction evidence, but ${phase} failed: ${operationalDetail(error)}`,
    );
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        // A subscriber is presentation-only.  Its exception must not reject
        // a persistence queue or a Studio transaction handler.
        this.lastPublicationListenerFailure = `A local control-state subscriber failed without changing transaction evidence: ${operationalDetail(error)}`;
      }
    }
  }

  private invalidateViewsForProject(projectId: string): void {
    for (const bundle of this.bundles.values())
      if (bundle.session.projectId === projectId) this.views.delete(bundle.session.id);
  }

  private isRecordingInventoryClear(studio: StudioBridgeSession): boolean {
    const scan = this.recordingScans.get(studio.sessionId);
    return (
      scan?.status === "clear" &&
      ![...this.pendingFinalizationAcknowledgements.values()].some(
        (pending) => pending.studioSessionId === studio.sessionId,
      )
    );
  }
}

function requiredChangeSet(bundle: CreatorSessionBundle): CreatorChangeSet {
  const changeSet = activeChangeSet(bundle);
  if (!changeSet) throw new Error("Creator session has no active change set");
  return changeSet;
}

function rojoStudioNonSourceHash(
  view: ReturnType<typeof studioProjectIndexMetadataView>,
  operations: readonly RojoSourceOperation[] = [],
): string {
  const created = operations.filter(
    (operation): operation is Extract<RojoSourceOperation, { readonly kind: "create_source" }> =>
      operation.kind === "create_source",
  );
  const instances = [
    ...view.instances.map((instance) => ({
      path: instance.path,
      className: instance.className,
      properties: instance.properties,
      attributes: instance.attributes,
      tags: instance.tags,
    })),
    ...created.map((operation) => ({
      path: `${operation.parentStudioPath}/${operation.name}`,
      className: operation.className,
      properties: {},
      attributes: {},
      tags: [],
    })),
  ].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.className.localeCompare(right.className),
  );
  const scripts = [
    ...view.scripts.map((script) => ({
      path: script.path,
      className: script.className,
      executionContext: script.executionContext,
    })),
    ...created.map((operation) => ({
      path: `${operation.parentStudioPath}/${operation.name}`,
      className: operation.className,
      executionContext:
        operation.className === "Script"
          ? ("server" as const)
          : operation.className === "LocalScript"
            ? ("client" as const)
            : ("shared" as const),
    })),
  ].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.className.localeCompare(right.className),
  );
  return contentHash(stableJson({ instances, scripts }));
}

function isRojoSourceClass(value: string): value is RojoSourceClass {
  return value === "Script" || value === "LocalScript" || value === "ModuleScript";
}

/**
 * Planner source evidence must start from a synchronized authority pair. A
 * filesystem revision alone is never enough: otherwise Forge could consult
 * Studio source A and later write a guarded edit against filesystem source B.
 */
function assertRojoInitialStudioParity(
  capture: StudioProjectIndexCapture,
  authorityMap: ProjectAuthorityMap,
): void {
  if (!authorityMap.rojo) throw new Error("Rojo initial parity requires a Rojo authority map");
  const scripts = new Map(
    studioProjectIndexMetadataView(capture).scripts.map(
      (script) => [`${script.path}\u0000${script.className}`, script.sourceHash] as const,
    ),
  );
  for (const entry of authorityMap.rojo.filesystemRevision.entries) {
    const observed = scripts.get(`${entry.studioPath}\u0000${entry.className}`);
    if (observed !== entry.sourceHash)
      throw new Error(
        `Rojo source authority is not synchronized before planning at ${entry.studioPath}; refresh Rojo/Studio before starting a creator request`,
      );
  }
}

function isRojoRevertStatus(
  status: CreatorSessionBundle["session"]["status"],
): status is "awaiting_source_sync" | "recovery_required" | "awaiting_review" {
  return (
    status === "awaiting_source_sync" ||
    status === "recovery_required" ||
    status === "awaiting_review"
  );
}

function rojoSyncObservation(
  capture: StudioProjectIndexCapture,
  expectedEntries: readonly {
    readonly studioPath: string;
    readonly className: "Script" | "LocalScript" | "ModuleScript";
    readonly sourceHash: string;
  }[],
) {
  const view = studioProjectIndexMetadataView(capture);
  const scripts = new Map(
    view.scripts.map((script) => [`${script.path}\u0000${script.className}`, script] as const),
  );
  const sourceEntries = expectedEntries.flatMap((expected) => {
    const actual = scripts.get(`${expected.studioPath}\u0000${expected.className}`);
    return actual
      ? [
          {
            studioPath: expected.studioPath,
            className: expected.className,
            sourceHash: actual.sourceHash,
          },
        ]
      : [];
  });
  return {
    complete: true,
    studioRevisionHash: capture.revision.hash,
    nonSourceStateHash: rojoStudioNonSourceHash(view),
    sourceEntries,
  };
}

function rojoProofDetail(prefix: string, facts: readonly { readonly statement: string }[]): string {
  const detail = facts.map((fact) => fact.statement).join(" ");
  return `${prefix}.${detail ? ` ${detail}` : ""}`;
}

function appendRojoForwardProof(
  bundle: CreatorSessionBundle,
  attemptId: string,
  proof: CreatorSessionBundle["rojoSourceMutations"][number]["syncProofs"][number],
): CreatorSessionBundle {
  let found = false;
  const rojoSourceMutations = bundle.rojoSourceMutations.map((mutation) => {
    if (mutation.attempt.id !== attemptId) return mutation;
    found = true;
    if (mutation.revert)
      throw new Error("Forward source-sync proof cannot follow an explicit revert");
    return { ...mutation, syncProofs: [...mutation.syncProofs, proof] };
  });
  if (!found) throw new Error("Rojo source mutation attempt is absent from the bundle");
  return { ...bundle, rojoSourceMutations };
}

function appendRojoRevert(
  bundle: CreatorSessionBundle,
  attemptId: string,
  revert: NonNullable<CreatorSessionBundle["rojoSourceMutations"][number]["revert"]>,
): CreatorSessionBundle {
  let found = false;
  const rojoSourceMutations = bundle.rojoSourceMutations.map((mutation) => {
    if (mutation.attempt.id !== attemptId) return mutation;
    found = true;
    if (mutation.revert) throw new Error("Rojo source mutation already has an explicit revert");
    return { ...mutation, revert };
  });
  if (!found) throw new Error("Rojo source mutation attempt is absent from the bundle");
  return { ...bundle, rojoSourceMutations };
}

function appendRojoRevertProof(
  bundle: CreatorSessionBundle,
  attemptId: string,
  proof: CreatorSessionBundle["rojoSourceMutations"][number]["revertSyncProofs"][number],
): CreatorSessionBundle {
  let found = false;
  const rojoSourceMutations = bundle.rojoSourceMutations.map((mutation) => {
    if (mutation.attempt.id !== attemptId) return mutation;
    found = true;
    if (!mutation.revert) throw new Error("Rojo source revert proof has no revert binding");
    return {
      ...mutation,
      revertSyncProofs: [...mutation.revertSyncProofs, proof],
    };
  });
  if (!found) throw new Error("Rojo source mutation attempt is absent from the bundle");
  return { ...bundle, rojoSourceMutations };
}
function requiredSettledMutationAttempt(
  bundle: CreatorSessionBundle,
  attemptId: string,
): CreatorSettledMutationAttempt {
  const attempt = bundle.mutationAttempts.find((candidate) => candidate.id === attemptId);
  if (!attempt || attempt.completion !== "settled")
    throw new Error("The finalized mutation attempt is missing or incomplete");
  return attempt;
}
function bundleArtifactReferences(bundle: CreatorSessionBundle): ArtifactReference[] {
  return [
    bundle.creatorRequest,
    ...(bundle.agentOutcome ? [bundle.agentOutcome.artifact] : []),
    ...bundle.agentRuns.flatMap((run) => [run.agentRun, run.trace]),
    ...bundle.verifications.flatMap((verification) => [
      verification.executionPlan.artifact,
      ...(verification.runtimeEvidence ? [verification.runtimeEvidence.artifact] : []),
    ]),
    ...bundle.mutationAttempts.flatMap((attempt) => mutationAttemptReferences(attempt)),
    ...(bundle.activeMutation ? activeMutationReferences(bundle.activeMutation) : []),
    ...(bundle.projectAuthority ? [bundle.projectAuthority.authorityMap.artifact] : []),
    ...bundle.rojoSourceMutations.flatMap((mutation) => [
      mutation.changeSet.artifact,
      mutation.attempt.artifact,
      ...mutation.syncProofs.map((proof) => proof.artifact),
      ...(mutation.revert ? [mutation.revert.artifact] : []),
      ...mutation.revertSyncProofs.map((proof) => proof.artifact),
    ]),
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
    ...creatorProjectIndexArtifactReferences(active.beforeIndexCapture),
    ...(active.directReadback ? [active.directReadback.artifact] : []),
    ...(active.afterIndexCapture
      ? creatorProjectIndexArtifactReferences(active.afterIndexCapture)
      : []),
    ...(active.reconciliation ? [active.reconciliation.artifact] : []),
    ...(active.executionFailure ? [active.executionFailure.artifact] : []),
    ...(active.verificationPlan ? [active.verificationPlan.artifact] : []),
    ...(active.verificationDraft ? [active.verificationDraft.artifact] : []),
    ...(active.recoveryFinalization ? [active.recoveryFinalization.artifact] : []),
    ...(active.finalIndexCapture
      ? creatorProjectIndexArtifactReferences(active.finalIndexCapture)
      : []),
  ];
}
function mutationAttemptReferences(attempt: CreatorMutationAttempt): ArtifactReference[] {
  const common = [
    attempt.manifest.artifact,
    attempt.attestation.projection.artifact,
    attempt.attestation.envelope.artifact,
    attempt.changeSet.artifact,
    attempt.projection.artifact,
    ...creatorProjectIndexArtifactReferences(attempt.beforeIndexCapture),
    ...(attempt.completion === "incomplete" ? [attempt.preflightProjection.artifact] : []),
    ...(attempt.preflight
      ? [attempt.preflight.projection.artifact, attempt.preflight.envelope.artifact]
      : []),
  ];
  if (attempt.completion === "incomplete")
    return attempt.phase === "apply"
      ? [
          ...common,
          ...creatorProjectIndexArtifactReferences(attempt.finalIndexCapture),
          attempt.finalization.artifact,
        ]
      : common;
  return [
    ...common,
    attempt.directReadback.artifact,
    ...creatorProjectIndexArtifactReferences(attempt.afterIndexCapture),
    ...creatorProjectIndexArtifactReferences(attempt.finalIndexCapture),
    attempt.reconciliation.artifact,
    attempt.finalization.artifact,
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
function isTerminalStatus(status: CreatorSessionBundle["session"]["status"]): boolean {
  return [
    "answered",
    "creator_accepted",
    "creator_rejected",
    "rolled_back",
    "incomplete",
    "superseded",
  ].includes(status);
}
function creatorProgress(
  session: CreatorSessionBundle["session"] | undefined,
  observingCreatorPlay = false,
): CreatorTransactionStage[] {
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
  const activeIndex = [
    "indexing",
    "planning",
    "awaiting_clarification",
    "refining_plan",
    "refresh_required",
    "refreshing",
  ].includes(status)
    ? 1
    : ["awaiting_plan_approval"].includes(status)
      ? 1
      : ["building", "awaiting_change_approval"].includes(status)
        ? 2
        : [
              "preflighting",
              "applying",
              "awaiting_verification",
              "verifying",
              "awaiting_verification_retry",
              "awaiting_source_sync",
              "repairing",
              "cancelling",
              "committing",
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
  const blocked =
    status === "recovery_required" ||
    status === "awaiting_verification_retry" ||
    status === "refresh_required" ||
    status === "awaiting_source_sync";
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
          : status === "verifying" && observingCreatorPlay
            ? "observing Studio Play"
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
export function restoredCreatorControlDetail(bundle: CreatorSessionBundle): string {
  const { session } = bundle;
  switch (session.status) {
    case "indexing":
      return "Forge is collecting and validating a complete sharded project index. Studio remains read-only.";
    case "planning":
      return "Forge is producing a bounded plan. Studio remains read-only.";
    case "awaiting_clarification":
      return bundle.agentOutcome?.outcome.kind === "clarification_requested"
        ? bundle.agentOutcome.outcome.question
        : "Forge needs one clarification before it can continue this intent.";
    case "refining_plan":
      return "Forge is revising the plan from the creator's exact follow-up. Studio remains read-only and the earlier controls are invalid.";
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
      return "The provisional mutation has complete matched readback and state evidence. Forge is armed for the next normal Studio Play session; perform the interaction and press Stop, or cancel the uncommitted change.";
    case "verifying":
      return "Forge is waiting for or observing the next normal Studio Play session. Press Stop when the approved interaction is complete; incomplete evidence preserves the provisional change for retry.";
    case "awaiting_verification_retry":
      return "The completed Play interval produced incomplete technical evidence. The provisional recording remains open; retry this exact verification explicitly or cancel the changes.";
    case "repairing":
      return "Forge is producing a bounded repair from recorded failure evidence. Studio will not be mutated without another exact approval.";
    case "refresh_required":
      return "Studio reported a project change. Refresh the complete project index before Forge can plan, approve, or apply anything.";
    case "refreshing":
      return "Forge is collecting a new complete project index. No previous approval or candidate can advance during refresh.";
    case "superseded":
      return "A complete refresh found a changed project revision. This session is preserved as superseded and grants no action authority.";
    case "awaiting_source_sync":
      return "The guarded filesystem source write is complete, but Forge still needs a complete Studio index proving the mapped source synchronized without collateral drift.";
    case "cancelling":
      return "Forge is waiting for exact cancellation acknowledgement and post-cancel state evidence.";
    case "committing":
      return "Forge is waiting for exact commit acknowledgement and post-commit state evidence before creating a checkpoint.";
    case "awaiting_review":
      return "The committed result and its evidence are ready for your required free-form review report and final decision.";
    case "answered":
      return bundle.agentOutcome?.outcome.kind === "answer"
        ? bundle.agentOutcome.outcome.text
        : "Forge answered without requesting a Studio change.";
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
function activeChangeSet(bundle: CreatorSessionBundle): CreatorChangeSet | undefined {
  const reference = bundle.session.changeSet;
  return reference
    ? bundle.changeSets.find(
        (candidate) => candidate.id === reference.id && candidate.hash === reference.hash,
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

/** A terminal scheduler catch must remain terminal even for hostile thrown values. */
function operationalDetail(error: unknown): string {
  try {
    return detail(error);
  } catch {
    return "The operational error could not be rendered safely.";
  }
}

function requiredHash(value: string | undefined, label: string): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(`Studio omitted a valid ${label} hash`);
  return value;
}
export function assertCreatorTransactionControlAction(
  value: unknown,
): CreatorTransactionControlAction {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid creator transaction control action");
  const action = value as Record<string, unknown>;
  if (
    action.action === "start" &&
    typeof action.creatorText === "string" &&
    action.creatorText.trim().length > 0 &&
    action.creatorText === action.creatorText.trim() &&
    Buffer.byteLength(action.creatorText, "utf8") <= 16_000 &&
    typeof action.agentPrompt === "string" &&
    action.agentPrompt.trim().length > 0 &&
    action.agentPrompt === action.agentPrompt.trim() &&
    Buffer.byteLength(action.agentPrompt, "utf8") <= 256 * 1024 &&
    typeof action.model === "string" &&
    /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(action.model) &&
    typeof action.creatorSessionId === "string" &&
    /^creator_session_[A-Za-z0-9-]{1,200}$/.test(action.creatorSessionId) &&
    Array.isArray(action.contextCitations) &&
    action.contextCitations.length <= 32 &&
    Array.isArray(action.agentExecutions)
  ) {
    const contextCitations = action.contextCitations.map((citation) => {
      assertCreatorAgentContextCitation(citation);
      return structuredClone(citation);
    });
    if (
      new Set(contextCitations.map((citation) => citation.citation.handle)).size !==
      contextCitations.length
    )
      throw new Error("Creator start context citations must be unique");
    const agentExecutions = action.agentExecutions.map((execution) => {
      assertAgentExecutionSlot(execution);
      return structuredClone(execution);
    });
    requiredSingleAgentExecution(agentExecutions, "planner");
    return {
      action: "start",
      creatorText: action.creatorText,
      agentPrompt: action.agentPrompt,
      model: action.model,
      creatorSessionId: action.creatorSessionId,
      contextCitations,
      agentExecutions,
    };
  }
  if (
    action.action === "resume" &&
    typeof action.creatorSessionId === "string" &&
    /^creator_session_[A-Za-z0-9-]{1,200}$/.test(action.creatorSessionId) &&
    Array.isArray(action.agentExecutions)
  ) {
    const agentExecutions = action.agentExecutions.map((execution) => {
      assertAgentExecutionSlot(execution);
      return structuredClone(execution);
    });
    requiredSingleAgentExecution(agentExecutions, "planner");
    return {
      action: "resume",
      creatorSessionId: action.creatorSessionId,
      agentExecutions,
    };
  }
  if (
    action.action === "act" &&
    typeof action.sessionId === "string" &&
    typeof action.viewId === "string" &&
    typeof action.viewHash === "string" &&
    /^[a-f0-9]{64}$/.test(action.viewHash) &&
    Array.isArray(action.agentExecutions) &&
    [
      "transaction_approve_plan",
      "transaction_reject_plan",
      "transaction_approve_and_apply_changes",
      "transaction_reject_changes",
      "transaction_retry_play_verification",
      "transaction_accept_result",
      "transaction_reject_and_rollback",
      "transaction_cancel_changes",
      "transaction_cancel_interrupted_recording",
      "transaction_refresh_project",
      "transaction_check_source_sync",
      "transaction_revert_source_changes",
    ].includes(String(action.actionId)) &&
    (action.report === undefined ||
      (typeof action.report === "string" && Buffer.byteLength(action.report, "utf8") <= 4096)) &&
    (!["transaction_accept_result", "transaction_reject_and_rollback"].includes(
      String(action.actionId),
    ) ||
      (typeof action.report === "string" && action.report.trim().length > 0))
  ) {
    const agentExecutions = action.agentExecutions.map((execution) => {
      assertAgentExecutionSlot(execution);
      return structuredClone(execution);
    });
    assertActionAgentExecutions(
      action.actionId as Extract<CreatorTransactionControlAction, { action: "act" }>["actionId"],
      agentExecutions,
    );
    return {
      action: "act",
      sessionId: action.sessionId as string,
      viewId: action.viewId as string,
      viewHash: action.viewHash as string,
      actionId: action.actionId as Extract<
        CreatorTransactionControlAction,
        { action: "act" }
      >["actionId"],
      ...(typeof action.report === "string" ? { report: action.report } : {}),
      agentExecutions,
    };
  }
  throw new Error("Invalid creator transaction control action");
}

function requiredSingleAgentExecution(
  executions: readonly AgentExecutionSlot[],
  purpose: AgentExecutionSlot["purpose"],
): AgentExecutionSlot {
  const execution = executions[0];
  if (executions.length !== 1 || !execution || execution.purpose !== purpose)
    throw new Error(`Creator action requires exactly one ${purpose} execution reservation`);
  assertAgentExecutionSlot(execution);
  return execution;
}

function assertActionAgentExecutions(
  actionId: Extract<CreatorTransactionControlAction, { action: "act" }>["actionId"],
  executions: readonly AgentExecutionSlot[],
): void {
  const expected =
    actionId === "transaction_approve_plan"
      ? "builder"
      : actionId === "transaction_approve_and_apply_changes" ||
          actionId === "transaction_retry_play_verification"
        ? "repair"
        : actionId === "transaction_refresh_project"
          ? "planner"
          : undefined;
  if (expected === undefined) {
    if (executions.length !== 0)
      throw new Error(
        "Creator action has provider authority without a provider-capable transition",
      );
    return;
  }
  requiredSingleAgentExecution(executions, expected);
}
function assertActionBinding(
  action: Extract<CreatorTransactionControlAction, { action: "act" }>,
  view: CreatorTransactionControlView,
  consumed: Set<string>,
): void {
  assertCreatorTransactionControlActionBinding(
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
  view: CreatorTransactionControlView,
  kind: "plan" | "change_set",
): string {
  if (view.artifact?.kind !== kind)
    throw new Error(`Creator transaction control view does not bind a ${kind}`);
  return view.artifact.hash;
}
function creatorRuntimeSummary(
  evidence: StudioEvidenceEnvelope,
): NonNullable<NonNullable<CreatorTransactionControlView["verification"]>["runtimeSummary"]> {
  const count = (status: StudioEvidenceEnvelope["facts"][number]["result"]["status"]) =>
    evidence.facts.filter((fact) => fact.result.status === status).length;
  return {
    startedAt: evidence.startedAt,
    endedAt: evidence.endedAt,
    observedFacts: count("observed"),
    absentFacts: count("absent"),
    unavailableFacts: count("unavailable"),
    readErrorFacts: count("read_error"),
    diagnosticCount: evidence.diagnostics?.length ?? 0,
    issues: evidence.facts.flatMap((fact) =>
      fact.result.status === "unavailable" || fact.result.status === "read_error"
        ? [
            {
              key: fact.key,
              status: fact.result.status,
              code: fact.result.code,
            },
          ]
        : [],
    ),
  };
}
function controlView(
  bundle: CreatorSessionBundle,
  observation: ReturnType<typeof projectIndexViewForCreator>,
  detailValue: string,
  prompt?: string,
  artifacts?: NonNullable<CreatorTransactionControlView["artifacts"]>,
  mutation?: CreatorTransactionControlView["mutation"],
  verification?: CreatorTransactionControlView["verification"],
  projectIndex?: CreatorTransactionControlView["projectIndex"],
  sourceConsultation?: CreatorTransactionControlView["sourceConsultation"],
  projectChange?: CreatorTransactionControlView["projectChange"],
  sourceSync?: CreatorTransactionControlView["sourceSync"],
  recoveryCancellationAvailable = false,
  observingCreatorPlay = false,
  changeApplicationAvailable = true,
  sourceRevertAvailable = false,
): CreatorTransactionControlView {
  if (bundle.session.status === "awaiting_plan_approval" && bundle.plan && prompt === undefined)
    throw new Error("Plan review requires the exact private creator request");
  const presentsPlan =
    bundle.session.status === "awaiting_plan_approval" && bundle.plan !== undefined;
  const changeSet = activeChangeSet(bundle);
  const presentsChangeSet =
    [
      "awaiting_change_approval",
      "preflighting",
      "applying",
      "awaiting_verification",
      "verifying",
      "awaiting_verification_retry",
      "cancelling",
      "committing",
      "awaiting_source_sync",
      "awaiting_review",
      "recovery_required",
    ].includes(bundle.session.status) && changeSet !== undefined;
  const presentation = presentsPlan
    ? createPlanReviewPresentation(bundle, prompt!)
    : presentsChangeSet
      ? createChangeReviewPresentation(changeSet!, observation)
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
    changeApplicationAvailable,
    sourceRevertAvailable,
  );
  const evidence = bundle.agentRuns.map(
    ({ phase, agentRunId, agentRun, traceId, trace, traceBuildKey }) => ({
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
  return createCreatorTransactionControlView({
    creatorSessionId: bundle.session.id,
    creatorSessionHash: bundle.session.hash,
    status: bundle.session.status,
    title: controlTitle(bundle.session.status, observingCreatorPlay),
    detail: detailValue.slice(0, 4096),
    ...(artifact ? { artifact } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(creatorReviewPrompts && creatorReviewPrompts.length > 0 ? { creatorReviewPrompts } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(verification ? { verification } : {}),
    ...(mutation ? { mutation } : {}),
    ...(projectIndex ? { projectIndex } : {}),
    ...(sourceConsultation ? { sourceConsultation } : {}),
    ...(projectChange ? { projectChange } : {}),
    ...(sourceSync ? { sourceSync } : {}),
    actions,
  });
}
function controlActions(
  status: CreatorSessionBundle["session"]["status"],
  recoveryCancellationAvailable = false,
  changeApplicationAvailable = true,
  sourceRevertAvailable = false,
): CreatorTransactionControlView["actions"] {
  if (status === "refresh_required")
    return [
      {
        id: "transaction_refresh_project",
        label: "Refresh Project",
        intent: "primary",
      },
    ];
  if (status === "awaiting_source_sync")
    return [
      {
        id: "transaction_check_source_sync",
        label: "Check Source Sync",
        intent: "primary",
      },
      ...(sourceRevertAvailable
        ? [
            {
              id: "transaction_revert_source_changes" as const,
              label: "Revert Source Changes",
              intent: "secondary" as const,
            },
          ]
        : []),
    ];
  if (status === "awaiting_plan_approval")
    return [
      {
        id: "transaction_approve_plan",
        label: "Approve Plan",
        intent: "primary",
      },
      {
        id: "transaction_reject_plan",
        label: "Reject",
        intent: "secondary",
      },
    ];
  if (status === "awaiting_change_approval")
    return [
      ...(changeApplicationAvailable
        ? [
            {
              id: "transaction_approve_and_apply_changes" as const,
              label: "Approve & Apply",
              intent: "primary" as const,
            },
          ]
        : []),
      {
        id: "transaction_reject_changes",
        label: "Reject",
        intent: "secondary",
      },
    ];
  if (status === "awaiting_verification")
    return [
      {
        id: "transaction_cancel_changes",
        label: "Cancel Changes",
        intent: "secondary",
      },
    ];
  if (status === "awaiting_verification_retry")
    return [
      {
        id: "transaction_retry_play_verification",
        label: "Retry Play Verification",
        intent: "primary",
      },
      {
        id: "transaction_cancel_changes",
        label: "Cancel Changes",
        intent: "secondary",
      },
    ];
  if (status === "awaiting_review")
    return [
      {
        id: "transaction_accept_result",
        label: "Accept Result",
        intent: "primary",
        requiresReport: true,
      },
      {
        id: "transaction_reject_and_rollback",
        label: "Reject & Roll Back",
        intent: "secondary",
        requiresReport: true,
      },
    ];
  if (status === "recovery_required" && recoveryCancellationAvailable)
    return [
      {
        id: "transaction_cancel_interrupted_recording",
        label: "Cancel Interrupted Recording",
        intent: "primary",
      },
    ];
  return [];
}
function controlTitle(
  status: CreatorSessionBundle["session"]["status"],
  observingCreatorPlay = false,
): string {
  const titles: Record<CreatorSessionBundle["session"]["status"], string> = {
    indexing: "Indexing Project",
    planning: "Planning",
    awaiting_clarification: "One question before I continue",
    refining_plan: "Refining the plan",
    awaiting_plan_approval: "Review Plan",
    building: "Building Changes",
    awaiting_change_approval: "Review Changes",
    preflighting: "Preflighting Capabilities",
    applying: "Applying Approved Changes",
    awaiting_verification: "Ready for Checks",
    verifying: observingCreatorPlay ? "Observing Studio Play" : "Waiting for Studio Play",
    awaiting_verification_retry: "Play Evidence Incomplete",
    cancelling: "Cancelling Provisional Change",
    committing: "Committing Proven Change",
    repairing: "Repairing Changes",
    refresh_required: "Project Refresh Required",
    refreshing: "Refreshing Project",
    superseded: "Superseded by Refresh",
    awaiting_source_sync: "Awaiting Source Sync",
    awaiting_review: "Review Result",
    answered: "Answer",
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
    throw new Error("Plan review presentation requires an awaiting plan approval bundle");
  if (
    contentHash(prompt) !== bundle.session.promptHash ||
    bundle.plan.promptHash !== bundle.session.promptHash
  )
    throw new Error("Plan review creator request does not match the immutable session prompt");
  const plan = bundle.plan;
  const outputCheckCoverage = plan.changes.flatMap((change) => {
    const output = plannedOutput(change);
    if (!output) return [];
    const matching = plan.charter.clauses.filter(
      (clause) =>
        clause.kind === "studio_check" &&
        (clause.check === "instance_exists" || clause.check === "position_series") &&
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
      ...("path" in clause ? { path: clause.path, expectedClass: clause.expectedClass } : {}),
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

function plannedOutput(change: CreatorPlanChange): { path: string; className: string } | undefined {
  if (change.kind === "create") return { path: change.path, className: change.className };
  if (change.kind === "move") return { path: change.toPath, className: change.expectedClass };
  return undefined;
}
function planChangeSummary(change: CreatorPlanChange): string {
  if (change.kind === "create") return `Create ${change.className} at ${change.path}.`;
  if (change.kind === "move")
    return `Move ${change.expectedClass} from ${change.target.path} to ${change.toPath}.`;
  if (change.kind === "update") return `Update ${change.expectedClass} at ${change.target.path}.`;
  if (change.kind === "delete") return `Delete ${change.expectedClass} at ${change.target.path}.`;
  return `Edit source for ${change.expectedClass} at ${change.target.path}.`;
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
  if (change.kind === "edit_source")
    return [
      "The exact UTF-8 byte edits, final source hash, and materialized diff will be presented in the later hash-bound change set before Studio is mutated.",
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
  observation: ReturnType<typeof projectIndexViewForCreator>,
): unknown {
  const sourceDiffs: unknown[] = changeSet.operations.flatMap((operation): unknown[] => {
    if (operation.kind === "edit_source") {
      return [
        {
          path: operation.target.path,
          beforeSourceHash: operation.beforeSourceHash,
          finalSourceHash: operation.finalSourceHash,
          finalByteCount: operation.finalByteCount,
          replacementBlobs: operation.edits.map((edit) => edit.replacementBlob),
        },
      ];
    }
    if (operation.kind === "create" && operation.sourceBlob !== undefined)
      return [
        {
          path: operation.target.path,
          sourceBlob: operation.sourceBlob,
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
    proofObligations: adaptCreatorChangeSetMutationOperations(
      changeSet,
      observation.instances,
      [],
      reviewStructuralParentsFromObservation(changeSet, observation),
    ).flatMap(mutationProofObligations),
  };
}

/**
 * The review is an exact statement of the later direct-readback projection.
 * Engine-container parents are structural-only in a change set, so attach the
 * actual identity retained by the bound metadata index rather than falling
 * back to an ambiguous display path.
 */
function reviewStructuralParentsFromObservation(
  changeSet: CreatorChangeSet,
  observation: ReturnType<typeof projectIndexViewForCreator>,
) {
  const engineContainerByKey = new Map<string, (typeof observation.instances)[number]>();
  for (const instance of observation.instances) {
    if (!instance.engineContainer) continue;
    const { path, className } = instance.engineContainer;
    if (instance.path !== path || instance.className !== className)
      throw new Error("Review index has an inconsistent engine-container identity");
    const key = `${path}\u0000${className}`;
    if (engineContainerByKey.has(key))
      throw new Error("Review index has duplicate engine-container identities");
    engineContainerByKey.set(key, instance);
  }
  return changeSet.operations.flatMap((operation) => {
    if (
      (operation.kind !== "create" && operation.kind !== "move") ||
      operation.parent.kind !== "engine_container"
    )
      return [];
    const parent = engineContainerByKey.get(
      `${operation.parent.path}\u0000${operation.parent.className}`,
    );
    if (!parent) throw new Error("Review index is missing an approved engine-container parent");
    return [
      {
        operationId: operation.id,
        target: {
          kind: "instance" as const,
          identity: parent.identity,
          path: parent.path,
          className: parent.className,
        },
      },
    ];
  });
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
  for (const [name, value] of Object.entries(operation.properties ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  ))
    obligations.push({
      fact: `${target}.${name}`,
      expected: stableJson(value),
    });
  for (const [name, value] of Object.entries(operation.attributes ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  ))
    obligations.push({
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
function operationPresentation(operation: CreatorChangeSet["operations"][number]): unknown {
  const common = {
    id: operation.id,
    planChangeId: operation.planChangeId,
    kind: operation.kind,
    operationHash: contentHash(stableJson(operation)),
  };
  if (operation.kind === "create")
    return {
      ...common,
      target: operation.target,
      className: operation.className,
      parent: operation.parent,
      name: operation.name,
      properties: operation.properties,
      attributes: operation.attributes,
      ...(operation.sourceBlob === undefined
        ? {}
        : {
            sourceHash: operation.sourceBlob.sourceHash,
            sourceUtf8Bytes: operation.sourceBlob.utf8Bytes,
          }),
    };
  if (operation.kind === "update")
    return {
      ...common,
      target: operation.target,
      className: operation.target.className,
      beforeHash: operation.beforeHash,
      properties: operation.properties,
      attributes: operation.attributes,
      removedAttributes: operation.removedAttributes,
    };
  if (operation.kind === "move")
    return {
      ...common,
      target: operation.target,
      destination: { parent: operation.parent, name: operation.name },
      className: operation.target.className,
      beforeHash: operation.beforeHash,
      properties: operation.properties,
      attributes: operation.attributes,
      removedAttributes: operation.removedAttributes,
    };
  if (operation.kind === "delete")
    return {
      ...common,
      target: operation.target,
      className: operation.target.className,
      beforeHash: operation.beforeHash,
    };
  return {
    ...common,
    target: operation.target,
    className: operation.target.className,
    beforeSourceHash: operation.beforeSourceHash,
    edits: operation.edits,
    sourceHash: operation.finalSourceHash,
    sourceUtf8Bytes: operation.finalByteCount,
  };
}
function runtimeEvidenceIssues(evidence: StudioEvidenceEnvelope): string[] {
  const issues = evidence.facts.flatMap((fact) =>
    fact.result.status === "unavailable" || fact.result.status === "read_error"
      ? [`${fact.key}: ${fact.result.status} / ${fact.result.code}`]
      : [],
  );
  return issues.length > 0
    ? issues.slice(0, 32)
    : [
        "The runtime envelope declared incomplete coverage without an unavailable or read-error fact.",
      ];
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
    beforeIndexRevisionHash: string;
    afterIndexRevisionHash: string;
  },
  afterRevisionHash: string,
  attempt: CreatorSettledMutationAttempt,
): CreatorCheckpoint {
  const payload = {
    sessionId,
    changeSetId: changeSet.id,
    changeSetHash: changeSet.hash,
    beforeRevisionHash: pending.beforeIndexRevisionHash,
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
  return {
    kind: "CreatorVerificationRecord",
    id: `creator_verification_${hash.slice(0, 24)}`,
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
  _observation: ReturnType<typeof projectIndexViewForCreator>,
): CreatorSessionBundle {
  requiredHash(revisionHash, "Studio project revision");
  return bundle;
}

function projectIndexViewForCreator(view: ReturnType<typeof studioProjectIndexMetadataView>) {
  return view;
}

type ExactDiffCursorBinding = {
  readonly sessionId: string;
  readonly changeSetId: string;
  readonly changeSetHash: string;
  readonly operationId: string;
  readonly sourceIndexHash: string;
};

function exactDiffPageSize(value: number | undefined): number {
  if (value === undefined) return 32 * 1024;
  if (!Number.isSafeInteger(value) || value < 1 || value > 32 * 1024)
    throw new Error("Exact source diff page size must be 1-32768 UTF-8 bytes");
  return value;
}

function encodeExactDiffCursor(
  input: ExactDiffCursorBinding & {
    readonly editIndex: number;
    readonly beforeOffset: number;
    readonly replacementOffset: number;
  },
): string {
  const payload = {
    sessionId: input.sessionId,
    changeSetId: input.changeSetId,
    changeSetHash: input.changeSetHash,
    operationId: input.operationId,
    sourceIndexHash: input.sourceIndexHash,
    editIndex: input.editIndex,
    beforeOffset: input.beforeOffset,
    replacementOffset: input.replacementOffset,
  };
  return Buffer.from(
    stableJson({ ...payload, hash: contentHash(stableJson(payload)) }),
    "utf8",
  ).toString("base64url");
}

function decodeExactDiffCursor(
  value: string,
  binding: ExactDiffCursorBinding,
): {
  readonly editIndex: number;
  readonly beforeOffset: number;
  readonly replacementOffset: number;
} {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096)
    throw new Error("Exact source diff cursor is invalid");
  let candidate: unknown;
  try {
    candidate = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Exact source diff cursor is invalid");
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("Exact source diff cursor is invalid");
  const cursor = candidate as Record<string, unknown>;
  const payload = {
    sessionId: cursor.sessionId,
    changeSetId: cursor.changeSetId,
    changeSetHash: cursor.changeSetHash,
    operationId: cursor.operationId,
    sourceIndexHash: cursor.sourceIndexHash,
    editIndex: cursor.editIndex,
    beforeOffset: cursor.beforeOffset,
    replacementOffset: cursor.replacementOffset,
  };
  if (
    Object.keys(cursor).length !== 9 ||
    typeof cursor.hash !== "string" ||
    contentHash(stableJson(payload)) !== cursor.hash ||
    payload.sessionId !== binding.sessionId ||
    payload.changeSetId !== binding.changeSetId ||
    payload.changeSetHash !== binding.changeSetHash ||
    payload.operationId !== binding.operationId ||
    payload.sourceIndexHash !== binding.sourceIndexHash ||
    !Number.isSafeInteger(payload.editIndex) ||
    typeof payload.editIndex !== "number" ||
    payload.editIndex < 0 ||
    !Number.isSafeInteger(payload.beforeOffset) ||
    typeof payload.beforeOffset !== "number" ||
    payload.beforeOffset < 0 ||
    !Number.isSafeInteger(payload.replacementOffset) ||
    typeof payload.replacementOffset !== "number" ||
    payload.replacementOffset < 0
  )
    throw new Error("Exact source diff cursor does not bind this immutable edit");
  return {
    editIndex: payload.editIndex,
    beforeOffset: payload.beforeOffset,
    replacementOffset: payload.replacementOffset,
  };
}

function nextExactDiffCursor(input: {
  readonly editCount: number;
  readonly editIndex: number;
  readonly beforeOffset: number;
  readonly beforeLength: number;
  readonly replacementOffset: number;
  readonly replacementLength: number;
}):
  | {
      readonly editIndex: number;
      readonly beforeOffset: number;
      readonly replacementOffset: number;
    }
  | undefined {
  if (input.beforeOffset < input.beforeLength || input.replacementOffset < input.replacementLength)
    return {
      editIndex: input.editIndex,
      beforeOffset: input.beforeOffset,
      replacementOffset: input.replacementOffset,
    };
  if (input.editIndex + 1 >= input.editCount) return undefined;
  return {
    editIndex: input.editIndex + 1,
    beforeOffset: 0,
    replacementOffset: 0,
  };
}

function countCanonicalJsonFragments(value: string, maximumBytes: number): number {
  return fragmentCanonicalJson(value, maximumBytes).length;
}

function preRecordingDiagnostic(
  phase: CreatorPreRecordingPhase,
  failureDetail: string,
): { code: string; detail: string } {
  switch (phase) {
    case "source_transfer":
      return {
        code: "creator_source_transfer_failed",
        detail: `Approved source transfer did not complete before Studio parsed the change set: ${failureDetail}`,
      };
    case "prepare_transport":
      return {
        code: "creator_prepare_transport_failed",
        detail: `The exact change-set Prepare transport did not settle before detached preflight: ${failureDetail}`,
      };
    case "preflight_transport":
      return {
        code: "creator_preflight_transport_failed",
        detail: `Studio detached-preflight transport did not settle before any recording could open: ${failureDetail}`,
      };
    case "preflight_evidence_persistence":
      return {
        code: "creator_preflight_evidence_persistence_failed",
        detail: `Detached-preflight evidence was returned but could not be validated and durably persisted before any recording could open: ${failureDetail}`,
      };
    case "durable_intent":
      return {
        code: "creator_durable_mutation_intent_failed",
        detail: `Forge could not durably persist the exact mutation intent, so it did not ask Studio to open a recording: ${failureDetail}`,
      };
  }
}

function preRecordingFailureStatus(
  failureFacts: readonly CreatorMutationFailureFact[],
): "source_transfer_failed" | "prepare_failed" | undefined {
  if (failureFacts.some((fact) => fact.code === "creator_source_transfer_failed"))
    return "source_transfer_failed";
  if (failureFacts.some((fact) => fact.code === "creator_prepare_transport_failed"))
    return "prepare_failed";
  return undefined;
}

interface ExactTransactionBindingFields {
  readonly creatorSessionId: string;
  readonly changeSetId: string;
  readonly changeSetHash: string;
  readonly projectionId: string;
  readonly projectionHash: string;
  readonly manifestHash: string;
  readonly beforeProjectIndexManifestId: string;
  readonly beforeProjectRevisionHash: string;
  readonly beforeProjectDetectorEpoch: number;
}

interface ExactPreparedTransactionFields extends ExactTransactionBindingFields {
  readonly preflightProjectionId: string;
  readonly preflightProjectionHash: string;
}

/** One predicate owns the cross-message transaction identity vocabulary. */
function matchesExactTransactionBinding(
  actual: ExactTransactionBindingFields,
  expected: ExactTransactionBindingFields,
): boolean {
  return (
    actual.creatorSessionId === expected.creatorSessionId &&
    actual.changeSetId === expected.changeSetId &&
    actual.changeSetHash === expected.changeSetHash &&
    actual.projectionId === expected.projectionId &&
    actual.projectionHash === expected.projectionHash &&
    actual.manifestHash === expected.manifestHash &&
    actual.beforeProjectIndexManifestId === expected.beforeProjectIndexManifestId &&
    actual.beforeProjectRevisionHash === expected.beforeProjectRevisionHash &&
    actual.beforeProjectDetectorEpoch === expected.beforeProjectDetectorEpoch
  );
}

function matchesExactPreparedTransaction(
  actual: ExactPreparedTransactionFields,
  expected: ExactPreparedTransactionFields,
): boolean {
  return (
    matchesExactTransactionBinding(actual, expected) &&
    actual.preflightProjectionId === expected.preflightProjectionId &&
    actual.preflightProjectionHash === expected.preflightProjectionHash
  );
}

/** Split at UTF-8 boundaries so every protocol payload remains valid text. */
function fragmentCanonicalJson(value: string, maximumBytes: number): string[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error("Invalid source-write transport fragment bound");
  const bytes = Buffer.from(value, "utf8");
  const fragments: string[] = [];
  for (let start = 0; start < bytes.length || (bytes.length === 0 && fragments.length === 0);) {
    let end = Math.min(bytes.length, start + maximumBytes);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    if (end === start && end < bytes.length) {
      end += 1;
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end += 1;
    }
    fragments.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    if (bytes.length === 0) break;
  }
  return fragments;
}
async function waitFor<T extends PluginToBackendMessage>(
  messages: PluginToBackendMessage[],
  predicate: (message: PluginToBackendMessage) => message is T,
  timeoutMs: number,
  label: string,
  requestId: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    if (messages.some((message) => message.type === "UnpairProject"))
      throw new Error(`Studio disconnected while waiting for ${label}`);
    const error = messages.find(
      (message) => message.type === "PluginError" && message.requestId === requestId,
    );
    if (error?.type === "PluginError")
      throw new Error(`Studio plugin ${error.payload.code}: ${error.payload.message}`);
    await new Promise((resolveValue) => setTimeout(resolveValue, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
