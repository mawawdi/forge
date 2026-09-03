import { randomUUID } from "node:crypto";
import {
  AgentExecutionJournalStore,
  assessAgentExecutionJournalRecovery,
  createAgentExecutionJournalResume,
  createAgentExecutionSlot,
  type AgentExecutionSlot,
  type AgentRun,
  type LoadedAgentExecutionJournal,
} from "../../agent-runtime/src/index.js";
import type { ArtifactReference } from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  CreatorConversationStore,
  type CreatorConversationStoreOptions,
  CreatorProjectIdentityJobStore,
  assertCreatorActionRequestBinding,
  assertCreatorControlView,
  assertCreatorActionRequest,
  assertCreatorTurnRequest,
  assertCreatorWorkJobRequestBinding,
  creatorWorkRequestHash,
  sealCreatorCitation,
  sealCreatorControlView,
  sealCreatorConversationEvent,
  sealCreatorConversationTurn,
  sealCreatorModelRegistry,
  sealCreatorMemoryRevision,
  sealCreatorPlanRevision,
  sealCreatorProjectConversation,
  sealCreatorPublishedIdentityContinuityReceipt,
  sealCreatorTurnContract,
  sealCreatorWorkEpisode,
  sealCreatorWorkJob,
  type CreatorActionRequest,
  type CreatorArtifactBinding,
  type CreatorCitation,
  type CreatorControlActionDescriptor,
  type CreatorControlView,
  type CreatorConversationAttachment,
  type CreatorConversationEvent,
  type CreatorConversationEventPage,
  type CreatorConversationTurn,
  type CreatorDashboardState,
  type CreatorModelRegistry,
  type CreatorMemoryRevision,
  type CreatorProjectConversation,
  type CreatorProjectIdentity,
  type CreatorProjectIdentityJob,
  type CreatorTechnicalAttachment,
  type LoadedCreatorProjectIdentityJob,
  type CreatorTurnRequest,
  type CreatorWorkAdmission,
  type CreatorWorkEpisode,
  type CreatorWorkEpisodeStatus,
  type CreatorWorkJob,
  type LoadedCreatorConversation,
} from "../../creator-conversation/src/index.js";
import { deriveStudioProjectIdentityAuthority } from "../../studio-evidence/src/index.js";
import type {
  CreatorTransactionControlAction as TransactionControlAction,
  CreatorSessionCoordinator,
} from "../../creator-session/src/coordinator.js";
import type {
  CreatorAgentCitation,
  CreatorAgentContextCitation,
  CreatorTransactionControlView as TransactionControlView,
  CreatorMutationAttempt,
  CreatorMutationReconciliation,
  CreatorSessionBundle,
  CreatorSessionStatus,
} from "../../creator-session/src/index.js";
import {
  assertCreatorMutationFinalization,
  assertCreatorRequestArtifact,
  createCreatorAgentContextCitation,
} from "../../creator-session/src/index.js";
import {
  CREATOR_MODEL_REGISTRY,
  resolveCreatorModelSelection,
  type CreatorModelCatalog,
  type CreatorModelId,
} from "../../model-client/src/index.js";
import {
  createBackendMessage,
  StudioCommandRejectedError,
  type StudioBridgeConnection,
  type StudioBridgeSession,
} from "../../studio-bridge/src/index.js";
import {
  assertStudioProjectIdentityFinalizationReceipt,
  assertStudioProjectIdentityOperation,
  createStudioProjectIdentityOperation,
  type StudioProjectIdentityFinalizationReceipt,
  type StudioProjectIdentityOperation,
} from "../../studio-protocol/src/index.js";
import { agentFailureMessage, agentRunFailure } from "./agent-failure.js";
import { activityDetail, failedActivityDetail } from "./agent-activity.js";

const MAX_TURN_BYTES = 64 * 1024;
const DEFAULT_EVENT_PAGE_SIZE = 80;
const MAX_EVENT_PAGE_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 120_000;

type ConversationRequest = CreatorTurnRequest | CreatorActionRequest;

interface InternalEpisodeState {
  conversationId: string;
  episodeId: string;
}

/**
 * The sole authority for interactive source inspection. The event and source
 * index are both immutable conversation evidence; a conversation ID alone is
 * deliberately insufficient because its latest episode may be newer.
 */
export interface CreatorSourceEvidenceAnchor {
  readonly conversationId: string;
  readonly eventId: string;
  readonly eventHash: string;
  readonly sourceIndexHash: string;
}

interface WorkExecution {
  request: ConversationRequest;
  jobId: string;
  conversationId: string;
  creatorTurnId?: string;
}

type JobExecutionAssessment =
  | { readonly kind: "not_applicable"; readonly providerOutcome: "not_applicable" }
  | { readonly kind: "never_dispatched"; readonly providerOutcome: "never_dispatched" }
  | {
      readonly kind: "provider_outcome_unknown";
      readonly providerOutcome: "outcome_unknown";
    }
  | {
      readonly kind: "continuation_unavailable";
      readonly providerOutcome: "response_persisted";
    }
  | {
      /** A durable response/tool boundary that the creator may consume once. */
      readonly kind: "resumable_response";
      readonly providerOutcome: "response_persisted";
      readonly journal: LoadedAgentExecutionJournal;
    }
  | {
      readonly kind: "terminal";
      readonly providerOutcome: "response_persisted" | "failure_persisted";
      readonly journal: LoadedAgentExecutionJournal;
    };

/**
 * Conversation-first control plane over the proven transaction coordinator.
 * The lower layer remains the sole Studio action authority; this class adds
 * durable chronology, idempotent admission, foreground jobs, and presentation
 * contracts without deriving legal actions from status strings in the browser.
 */
export class CreatorConversationCoordinator {
  private readonly store: CreatorConversationStore;
  private readonly identityJobStore: CreatorProjectIdentityJobStore;
  private readonly modelRegistry: CreatorModelRegistry;
  private readonly listeners = new Set<() => void>();
  private readonly loaded = new Map<string, LoadedCreatorConversation>();
  private readonly identityJobs = new Map<string, LoadedCreatorProjectIdentityJob>();
  private readonly corruptHeads: { readonly error: string }[] = [];
  private readonly unreadableIdentityHeads: {
    readonly headLocator: string;
    readonly error: string;
  }[] = [];
  private readonly sessionEpisodes = new Map<string, InternalEpisodeState>();
  private readonly transactionHashes = new Map<string, string>();
  private readonly controlViews = new Map<string, CreatorControlView>();
  private readonly controlProjectScopes = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly workQueues = new Map<string, Promise<void>>();
  private readonly scheduledSessionSync = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private initialized = false;
  private accepting = true;
  private progressTimer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly options: {
      readonly transaction: CreatorSessionCoordinator;
      readonly connection: StudioBridgeConnection;
      readonly directory: string;
      readonly defaultModelId: CreatorModelId;
      readonly modelCatalog: CreatorModelCatalog;
      readonly timeoutMs?: number;
      readonly now?: () => Date;
      /** Test-only immutable-head publication boundary. */
      readonly conversationStoreOptions?: CreatorConversationStoreOptions;
    },
  ) {
    this.store = new CreatorConversationStore(options.directory, options.conversationStoreOptions);
    this.identityJobStore = new CreatorProjectIdentityJobStore(this.store.artifactStore);
    this.modelRegistry = materializeModelRegistry(
      options.defaultModelId,
      options.modelCatalog,
      this.now(),
    );
    this.unsubscribe = options.transaction.subscribe(() => this.onTransactionInvalidated());
  }

  async initialize(): Promise<void> {
    const [enumeration, identityEnumeration] = await Promise.all([
      this.store.enumerate(),
      this.identityJobStore.enumerate(),
    ]);
    for (const conversation of enumeration.conversations) {
      this.loaded.set(conversation.conversation.id, conversation);
      for (const episode of conversation.episodes)
        this.sessionEpisodes.set(episode.sessionBundle.id, {
          conversationId: conversation.conversation.id,
          episodeId: episode.id,
        });
    }
    for (const job of identityEnumeration.jobs) this.identityJobs.set(job.job.id, job);
    this.corruptHeads.push(...enumeration.corrupt, ...identityEnumeration.corrupt);
    this.unreadableIdentityHeads.push(...identityEnumeration.corrupt);
    this.initialized = true;
    await this.markInterruptedIdentityJobs();
    await this.markInterruptedJobs();
    await this.ensurePairedConversation();
    this.progressTimer = setInterval(() => {
      if (this.inFlight.size > 0) this.emit();
    }, 1500);
    this.progressTimer.unref();
  }

  async close(): Promise<void> {
    this.accepting = false;
    clearInterval(this.progressTimer);
    this.unsubscribe();
    await Promise.allSettled([...this.inFlight]);
    this.initialized = false;
    this.listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dashboardState(conversationId?: string): Promise<CreatorDashboardState> {
    this.assertInitialized();
    const ensured = await this.ensurePairedConversation();
    const selectedId =
      conversationId ?? ensured?.conversation.id ?? newest(this.loaded)?.conversation.id;
    const selected = selectedId ? this.loaded.get(selectedId) : undefined;
    const studioBeforeRead = this.options.transaction.pairedStudio();
    const selectedSessionBeforeRead =
      selected && conversationMatchesStudio(selected, studioBeforeRead)
        ? latestEpisode(selected)?.sessionBundle.id
        : undefined;
    const transactionState =
      await this.options.transaction.dashboardState(selectedSessionBeforeRead);
    const pairedSession = this.options.transaction.pairedStudio();
    const selectedIsPaired = selected ? conversationMatchesStudio(selected, pairedSession) : false;
    const selectedTransactionSessionId =
      selected && selectedIsPaired ? latestEpisode(selected)?.sessionBundle.id : undefined;
    const identityJob = pairedSession
      ? controllingIdentityJob(this.identityJobForStudio(pairedSession))
      : undefined;
    const identityControlView = pairedSession
      ? this.unlinkedProjectControlView(transactionState.pairedStudio, identityJob)
      : undefined;
    let controlView =
      identityControlView ??
      (selected
        ? await this.materializeControlView(
            selected,
            selectedIsPaired && selectedTransactionSessionId
              ? transactionState.controlView
              : undefined,
          )
        : undefined);
    if (this.unreadableIdentityHeads.length > 0 && controlView) {
      const {
        kind: _kind,
        hash: _hash,
        turnContract: _turnContract,
        activeActivity: _activity,
        ...prior
      } = controlView;
      controlView = sealCreatorControlView({
        ...prior,
        id: `creator_control_${contentHash(stableJson(this.unreadableIdentityHeads)).slice(0, 24)}`,
        status: "recovery_required",
        title: "Identity evidence needs a clean store",
        detail:
          "Forge cannot read retained project identity jobs in the current format. No new work is permitted because their outcomes cannot be inferred. Stop Forge, preserve an external rollback snapshot, then use a fresh creator store and re-pair Studio to inspect its durable transaction inventory. No legacy jobs will be migrated or resumed.",
        actions: [],
      });
    }
    if (controlView) this.controlViews.set(controlView.conversationId, controlView);
    const conversations = [...this.loaded.values()]
      .sort((left, right) =>
        right.conversation.updatedAt.localeCompare(left.conversation.updatedAt),
      )
      .map((conversation) => {
        const view = this.controlViews.get(conversation.conversation.id);
        const episode = latestEpisode(conversation);
        return {
          id: conversation.conversation.id,
          hash: conversation.conversation.hash,
          title: conversationTitle(conversation),
          projectName: conversation.conversation.title,
          project: conversation.conversation.project,
          status: view?.status ?? controlStatusForEpisode(episode),
          ...(episode ? { currentProjectRevisionHash: episode.currentProjectRevisionHash } : {}),
          latestEventSequence: conversation.conversation.latestEventSequence,
          episodeCount: conversation.episodes.length,
          updatedAt: conversation.conversation.updatedAt,
        };
      });
    const agentActivity = selected ? await this.readAgentActivity(selected) : undefined;
    const preferences = selected ? this.projectMemoryOwner(selected) : undefined;
    return {
      kind: "CreatorDashboardState",
      ...(agentActivity ? { agentActivity } : {}),
      ...(preferences
        ? {
            projectSettings: {
              controlView: this.memoryControlView(preferences),
              memories: memorySummaries(preferences),
            },
          }
        : {}),
      conversations,
      ...(selected
        ? {
            selectedConversationId: selected.conversation.id,
            selectedConversation: selected.conversation,
            eventPage: this.eventPage(selected, undefined, DEFAULT_EVENT_PAGE_SIZE),
          }
        : controlView
          ? { selectedConversationId: controlView.conversationId }
          : {}),
      episodes: selected
        ? selected.episodes.map((episode) => ({
            id: episode.id,
            hash: episode.hash,
            ordinal: episode.ordinal,
            status: episode.status,
            selectedModelId: episode.selectedModelId,
            currentProjectRevisionHash: episode.currentProjectRevisionHash,
            createdAt: episode.createdAt,
            updatedAt: episode.updatedAt,
          }))
        : [],
      memories: selected ? memorySummaries(selected) : [],
      modelRegistry: this.modelRegistry,
      ...(controlView ? { controlView } : {}),
      pairedStudio: pairedStudioView(transactionState.pairedStudio, this.corruptHeads.length),
      serverTime: this.now(),
    };
  }

  private async readAgentActivity(
    conversation: LoadedCreatorConversation,
  ): Promise<CreatorDashboardState["agentActivity"]> {
    const job = [...conversation.jobs].reverse().find((item) => item.agentExecutions.length > 0);
    const slot = job?.agentExecutions.at(-1);
    if (!job || !slot) return undefined;
    const running = ["queued", "running", "awaiting_external"].includes(job.status);
    const base = {
      jobId: job.id,
      agentRunId: slot.agentRunId,
      running,
      startedAt: job.createdAt,
      updatedAt: job.updatedAt,
      modelTurns: 0,
      steps: [],
    };
    try {
      const journal = await new AgentExecutionJournalStore(this.store.artifactStore).loadIfPresent(
        slot.journalId,
      );
      if (!journal)
        return {
          ...base,
          currentStep: running ? "Reading the project" : "Work stopped before the agent started",
        };
      const checkpoints = journal.entries.map((entry) => entry.checkpoint);
      const last = checkpoints.at(-1)!;
      const steps = checkpoints
        .flatMap((checkpoint, index) =>
          checkpoint.checkpointType === "tool_completed"
            ? [
                {
                  sequence: index + 1,
                  label: toolActivityLabel(checkpoint.toolCall.name),
                  detail: checkpoint.toolCall.result.ok
                    ? toolActivityDetail(checkpoint.toolCall.input)
                    : failedActivityDetail(checkpoint.toolCall.result.error?.message),
                  status: checkpoint.toolCall.result.ok
                    ? ("complete" as const)
                    : ("failed" as const),
                },
              ]
            : [],
        )
        .slice(-80);
      let currentStep = "Thinking through the next step";
      if (last.checkpointType === "tool_execution_intent")
        currentStep = toolActivityLabel(last.toolCall.name);
      if (last.checkpointType === "terminal")
        currentStep = last.result.error
          ? agentFailureMessage(last.result)
          : running
            ? "Saving the result"
            : job.status === "failed"
              ? "The agent finished, but Forge couldn't add its result to this conversation."
              : "Work finished";
      return {
        ...base,
        updatedAt: last.occurredAt,
        modelTurns: checkpoints.filter((item) => item.checkpointType === "response_received")
          .length,
        currentStep,
        steps,
      };
    } catch {
      return {
        ...base,
        currentStep:
          "Activity details are unavailable. Open the run details to inspect its saved evidence.",
      };
    }
  }

  private projectMemoryOwner(conversation: LoadedCreatorConversation): LoadedCreatorConversation {
    const project = stableJson(conversation.conversation.project);
    const originalId = `creator_conversation_${contentHash(project).slice(0, 24)}`;
    return (
      this.loaded.get(originalId) ??
      [...this.loaded.values()]
        .filter((item) => stableJson(item.conversation.project) === project)
        .sort(
          (a, b) =>
            a.conversation.createdAt.localeCompare(b.conversation.createdAt) ||
            a.conversation.id.localeCompare(b.conversation.id),
        )[0]!
    );
  }

  private memoryControlView(conversation: LoadedCreatorConversation): CreatorControlView {
    const id = `creator_settings_${conversation.conversation.hash.slice(0, 24)}`;
    return sealCreatorControlView({
      id,
      conversationId: conversation.conversation.id,
      conversationHash: conversation.conversation.hash,
      eventSequence: conversation.conversation.latestEventSequence,
      status: "ready",
      title: "Project preferences",
      detail: "These preferences apply to every conversation in this project.",
      actions: conversationMatchesStudio(conversation, this.options.transaction.pairedStudio())
        ? memoryActionDescriptors(id, conversation.events.at(-1)!, conversation)
        : [],
      technicalAttachments: [],
    });
  }

  async conversationEvents(
    conversationId: string,
    input: { readonly before?: string; readonly limit?: number },
  ): Promise<CreatorConversationEventPage> {
    this.assertInitialized();
    const conversation = await this.load(conversationId);
    const limit = input.limit ?? DEFAULT_EVENT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE_SIZE)
      throw new Error("Conversation event page size must be 1..200");
    return this.eventPage(conversation, input.before, limit);
  }

  async submitTurn(value: unknown): Promise<CreatorWorkAdmission> {
    this.assertInitialized();
    this.assertAccepting();
    assertCreatorTurnRequest(value);
    const request = value as CreatorTurnRequest;
    const ensured = request.conversationId
      ? await this.load(request.conversationId)
      : await this.ensurePairedConversation();
    if (!ensured) throw new Error("Link this unpublished Studio place before starting work");
    if (!conversationMatchesStudio(ensured, this.options.transaction.pairedStudio()))
      throw new Error("Open and pair this project before continuing its conversation");
    const conversationId = ensured.conversation.id;
    const replay = findIdempotentJob(ensured, request);
    if (replay) return admission(replay, this.now());
    const selection = resolveCreatorModelSelection(
      request.selectedModelId,
      this.options.modelCatalog,
    );
    if (!selection.definition || selection.availability !== "available")
      throw new Error(`Selected model is unavailable: ${selection.reason}`);
    const view = await this.currentControlView(conversationId);
    const contract = view.turnContract;
    if (
      !contract ||
      contract.id !== request.turnContractId ||
      contract.hash !== request.turnContractHash ||
      contract.modelRegistryHash !== this.modelRegistry.hash ||
      !contract.allowedTurnTypes.includes(request.turnKind)
    )
      throw new Error("Creator turn is stale or unavailable in the current conversation view");
    if (request.conversationId !== undefined && request.conversationId !== conversationId)
      throw new Error("Creator turn belongs to another project conversation");
    const bytes = Buffer.byteLength(request.text, "utf8");
    if (bytes < contract.minimumBytes || bytes > contract.maximumBytes)
      throw new Error("Creator turn text is outside the exact control-view bounds");
    const admitted = await this.serialize(conversationId, async () => {
      let current = await this.load(conversationId);
      if (!conversationMatchesStudio(current, this.options.transaction.pairedStudio()))
        throw new Error("Paired Studio project changed before durable turn admission");
      const existing = findIdempotentJob(current, request);
      if (existing) return { job: existing };
      const liveView = await this.currentControlView(conversationId);
      const liveContract = liveView.turnContract;
      if (
        !liveContract ||
        liveContract.id !== request.turnContractId ||
        liveContract.hash !== request.turnContractHash ||
        liveView.conversationHash !== current.conversation.hash
      )
        throw new Error("Creator turn became stale before durable admission");
      const activeEpisode = current.conversation.activeEpisodeId
        ? current.episodes.find(
            (candidate) => candidate.id === current.conversation.activeEpisodeId,
          )
        : undefined;
      const episode = ["clarification", "plan_refinement"].includes(request.turnKind)
        ? activeEpisode
        : undefined;
      const turn = sealCreatorConversationTurn({
        id: `creator_turn_${randomUUID()}`,
        conversationId,
        ...(episode ? { episodeId: episode.id } : {}),
        role: "creator",
        turnType: request.turnKind,
        text: request.text,
        selectedModelId: request.selectedModelId,
        ...(episode ? { projectRevisionHash: episode.currentProjectRevisionHash } : {}),
        ...(liveContract.replyToEventId ? { replyToEventId: liveContract.replyToEventId } : {}),
        createdAt: this.now(),
      });
      const turnReference = await this.store.artifactStore.write(turn);
      const admittedRequest = await this.store.artifactStore.write(request);
      const admissionAuthority = await this.store.artifactStore.write(liveContract);
      const agentExecutions = [createAgentExecutionSlot({ purpose: "planner", ordinal: 1 })];
      const job = sealCreatorWorkJob({
        id: `creator_job_${randomUUID()}`,
        conversationId,
        ...(episode ? { episodeId: episode.id } : {}),
        turnId: turn.id,
        idempotencyKey: request.idempotencyKey,
        requestHash: creatorWorkRequestHash(request),
        admittedRequest,
        admissionAuthority,
        transactionSessionId: `creator_session_${randomUUID()}`,
        agentExecutions,
        jobType: "agent_turn",
        status: "queued",
        phase: "admitted",
        selectedModelId: request.selectedModelId,
        providerOutcome: "never_dispatched",
        createdAt: this.now(),
        updatedAt: this.now(),
      });
      const jobReference = await this.store.artifactStore.write(job);
      const updatedEpisode = episode
        ? sealCreatorWorkEpisode({
            ...withoutRecordIdentity(episode),
            activeJob: { id: job.id, hash: job.hash },
            updatedAt: this.now(),
          })
        : undefined;
      current = await this.append(current, {
        authority: "creator",
        eventType: "creator_turn",
        ...(updatedEpisode ? { episodeId: updatedEpisode.id, episode: updatedEpisode } : {}),
        turn,
        job,
        data: {
          turn: binding(turn.id, turn.hash, turnReference),
          turnType: request.turnKind,
          text: request.text,
          selectedModelId: request.selectedModelId,
          job: binding(job.id, job.hash, jobReference),
        },
        attachments: [],
      });
      return { job, turnId: turn.id };
    });
    this.schedule({
      request,
      jobId: admitted.job.id,
      conversationId,
      ...(admitted.turnId ? { creatorTurnId: admitted.turnId } : {}),
    });
    return admission(admitted.job, this.now());
  }

  async submitAction(value: unknown): Promise<CreatorWorkAdmission> {
    this.assertInitialized();
    this.assertAccepting();
    assertCreatorActionRequest(value);
    const request = value as CreatorActionRequest;
    const current = this.loaded.get(request.conversationId);
    const pairedStudio = this.options.transaction.pairedStudio();
    if (current && !conversationMatchesStudio(current, pairedStudio)) {
      const continuityView = this.publishedContinuityControlView(current);
      if (
        !continuityView ||
        continuityView.id !== request.viewId ||
        continuityView.hash !== request.viewHash
      )
        throw new Error("Open and pair this project before continuing its conversation");
    }
    if (current) {
      const replay = findIdempotentJob(current, request);
      if (replay) {
        const target = newConversationId(request);
        return {
          ...admission(replay, this.now()),
          ...(this.loaded.has(target) ? { conversationId: target } : {}),
        };
      }
    }
    const settingsView = current ? this.memoryControlView(current) : undefined;
    const isSettingsRequest = settingsView?.id === request.viewId;
    const view = isSettingsRequest ? settingsView : this.controlViews.get(request.conversationId);
    if (!current || !view || view.id !== request.viewId || view.hash !== request.viewHash)
      return this.submitIdentityAction(request);
    const descriptor = assertCreatorActionRequestBinding(view, request);
    if (descriptor.actionId === "revise_plan") this.assertRefinementModelBinding(request, view);
    if (
      ["link_project", "fork_project", "resume_work", "cancel_recovery"].includes(
        descriptor.actionId,
      ) &&
      (descriptor.actionId === "fork_project" ||
        (this.options.transaction.pairedStudio() &&
          controllingIdentityJob(
            this.identityJobForStudio(this.options.transaction.pairedStudio()!),
          )))
    )
      return this.submitIdentityAction(request);
    validateActionInput(descriptor, request, current);
    const job = await this.serialize(request.conversationId, async () => {
      const loaded = await this.load(request.conversationId);
      const liveStudio = this.options.transaction.pairedStudio();
      if (!conversationMatchesStudio(loaded, liveStudio)) {
        const continuityView = this.publishedContinuityControlView(loaded);
        if (
          !continuityView ||
          continuityView.id !== request.viewId ||
          continuityView.hash !== request.viewHash
        )
          throw new Error("Paired Studio project changed before durable action admission");
      }
      const existing = findIdempotentJob(loaded, request);
      if (existing) return existing;
      const liveView = isSettingsRequest
        ? this.memoryControlView(loaded)
        : await this.currentControlView(request.conversationId);
      if (
        liveView.id !== request.viewId ||
        liveView.hash !== request.viewHash ||
        liveView.conversationHash !== loaded.conversation.hash
      )
        throw new Error("Creator action became stale before durable admission");
      const liveDescriptor = assertCreatorActionRequestBinding(liveView, request);
      validateActionInput(liveDescriptor, request, loaded);
      if (liveDescriptor.actionId === "revise_plan")
        this.assertRefinementModelBinding(request, liveView);
      const resumesAgentWork =
        liveDescriptor.actionId === "resume_work" || liveDescriptor.actionId === "retry_work";
      const resumedJob = resumesAgentWork
        ? resumableAgentJob(loaded, liveDescriptor.actionId)
        : undefined;
      if (resumesAgentWork && !resumedJob)
        throw new Error("Interrupted agent work is no longer eligible for this exact action");
      if (resumedJob) this.assertModelAvailable(resumedJob.selectedModelId);
      const resumedAssessment = resumedJob ? await this.assessJobExecution(resumedJob) : undefined;
      const resumesPersistedResponse =
        liveDescriptor.actionId === "resume_work" &&
        resumedJob?.jobType === "agent_turn" &&
        resumedAssessment?.kind === "resumable_response";
      const memoryAction = isMemoryAction(liveDescriptor.actionId);
      const episode =
        memoryAction || liveDescriptor.actionId === "new_conversation"
          ? undefined
          : resumedJob?.episodeId
            ? loaded.episodes.find((candidate) => candidate.id === resumedJob.episodeId)
            : resumesAgentWork
              ? undefined
              : latestEpisode(loaded);
      const decisionBinding = decisionBindingForAction(liveView, episode);
      const admissionEventId = `creator_event_${randomUUID()}`;
      let refinementTurnId: string | undefined;
      let refinement:
        | Extract<CreatorConversationEvent, { eventType: "decision" }>["data"]["refinement"]
        | undefined;
      let refinementTurn: CreatorConversationTurn | undefined;
      if (liveDescriptor.actionId === "revise_plan") {
        const text = request.input?.text;
        if (!text) throw new Error("Plan refinement text is required");
        const selectedModelId = request.input?.selectedModelId;
        if (!selectedModelId) throw new Error("Plan refinement lost its creator-selected model");
        const turn = sealCreatorConversationTurn({
          id: `creator_turn_${randomUUID()}`,
          conversationId: request.conversationId,
          ...(episode ? { episodeId: episode.id } : {}),
          role: "creator",
          turnType: "plan_refinement",
          text,
          selectedModelId,
          ...(episode ? { projectRevisionHash: episode.currentProjectRevisionHash } : {}),
          replyToEventId: admissionEventId,
          createdAt: this.now(),
        });
        if (turn.role !== "creator") throw new Error("Plan refinement turn lost creator authority");
        const turnReference = await this.store.artifactStore.write(turn);
        refinement = {
          turn: binding(turn.id, turn.hash, turnReference),
          text: turn.text,
          selectedModelId: turn.selectedModelId,
        };
        refinementTurn = turn;
        refinementTurnId = turn.id;
      }
      const admittedRequest = await this.store.artifactStore.write(request);
      const admissionAuthority = await this.store.artifactStore.write(liveView);
      const isAgentTurn =
        liveDescriptor.actionId === "revise_plan" || resumedJob?.jobType === "agent_turn";
      const executionPurpose =
        resumedJob?.agentExecutions[0]?.purpose ??
        executionPurposeForAction(liveDescriptor.actionId);
      const agentExecutions = resumesPersistedResponse
        ? resumedJob.agentExecutions
        : executionPurpose
          ? [createAgentExecutionSlot({ purpose: executionPurpose, ordinal: 1 })]
          : [];
      const selectedModelId = executionPurpose
        ? liveDescriptor.actionId === "revise_plan"
          ? request.input?.selectedModelId
          : (resumedJob?.selectedModelId ?? episode?.selectedModelId)
        : undefined;
      if (executionPurpose && !selectedModelId)
        throw new Error("Provider-capable action lost its creator-selected model");
      if (selectedModelId) this.assertModelAvailable(selectedModelId);
      const queued = sealCreatorWorkJob({
        id: `creator_job_${randomUUID()}`,
        conversationId: request.conversationId,
        ...(episode ? { episodeId: episode.id } : {}),
        ...(refinementTurnId
          ? { turnId: refinementTurnId }
          : resumedJob?.turnId
            ? { turnId: resumedJob.turnId }
            : {}),
        idempotencyKey: request.idempotencyKey,
        requestHash: creatorWorkRequestHash(request),
        admittedRequest,
        admissionAuthority,
        jobType: isAgentTurn
          ? "agent_turn"
          : executionPurpose
            ? "agent_action"
            : liveDescriptor.actionId === "apply_changes"
              ? "studio_transaction"
              : "control_action",
        status: "queued",
        phase: liveDescriptor.actionId,
        providerOutcome: executionPurpose
          ? resumesPersistedResponse
            ? "response_persisted"
            : "never_dispatched"
          : "not_applicable",
        agentExecutions,
        ...(resumesPersistedResponse
          ? { conversationContext: resumedJob.conversationContext }
          : {}),
        ...(isAgentTurn
          ? {
              transactionSessionId: resumesPersistedResponse
                ? requiredTransactionSessionId(resumedJob)
                : `creator_session_${randomUUID()}`,
            }
          : {}),
        ...(resumedJob ? { resumesJob: { id: resumedJob.id, hash: resumedJob.hash } } : {}),
        ...(selectedModelId ? { selectedModelId } : {}),
        createdAt: this.now(),
        updatedAt: this.now(),
      });
      const reference = await this.store.artifactStore.write(queued);
      const nextEpisode = episode
        ? sealCreatorWorkEpisode({
            ...withoutRecordIdentity(episode),
            activeJob: { id: queued.id, hash: queued.hash },
            updatedAt: this.now(),
          })
        : undefined;
      await this.append(loaded, {
        eventId: admissionEventId,
        authority: "creator",
        eventType: "decision",
        ...(nextEpisode ? { episodeId: nextEpisode.id, episode: nextEpisode } : {}),
        ...(decisionBinding ? { binding: decisionBinding } : {}),
        ...(refinementTurn ? { turn: refinementTurn } : {}),
        job: queued,
        data: {
          actionInstanceId: liveDescriptor.actionInstanceId,
          decision: decisionForAction(liveDescriptor.actionId),
          ...(request.input?.report ? { report: request.input.report } : {}),
          job: binding(queued.id, queued.hash, reference),
          ...(refinement ? { refinement } : {}),
        },
        attachments: [],
      });
      return queued;
    });
    if (descriptor.actionId === "new_conversation") {
      await this.execute({ request, jobId: job.id, conversationId: request.conversationId });
      const target = newConversationId(request);
      if (!this.loaded.has(target))
        throw new Error("The conversation could not be created. Try again.");
      return { ...admission(job, this.now()), conversationId: target };
    }
    this.schedule({ request, jobId: job.id, conversationId: request.conversationId });
    return admission(job, this.now());
  }

  async readAuthorizedArtifact(hash: string): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid artifact hash");
    for (const conversation of this.loaded.values()) {
      const reference = authorizedConversationArtifact(conversation, hash);
      if (reference) return this.store.artifactStore.read(reference);
    }
    for (const retained of this.identityJobs.values()) {
      const loaded = await this.identityJobStore.load(retained.job.id);
      const reference = [
        ...loaded.references,
        ...loaded.history.flatMap((job) => [
          job.admittedRequest,
          job.operation.artifact,
          ...(job.receipt ? [job.receipt.artifact] : []),
        ]),
      ].find((item) => item.artifactHash === hash);
      if (reference) return this.store.artifactStore.read(reference);
    }
    throw new Error("Artifact is not referenced by verified conversation or identity job history");
  }

  async replayVerification(id: string): Promise<unknown> {
    const binding = authorizedReplayBinding(this.loaded.values(), "verification", id);
    if (!binding)
      throw new Error("Verification is not referenced by verified conversation history");
    return this.options.transaction.replayVerification(binding.id, binding.hash);
  }

  async replayMutation(id: string): Promise<unknown> {
    const binding = authorizedReplayBinding(this.loaded.values(), "mutation", id);
    if (!binding) throw new Error("Mutation is not referenced by verified conversation history");
    return this.options.transaction.replayMutation(binding.id, binding.hash);
  }

  async sourceDocuments(
    anchor: CreatorSourceEvidenceAnchor,
    input: { limit?: number; cursor?: string },
  ) {
    return this.options.transaction.sourceDocuments(
      this.sessionForSourceEvidence(anchor),
      anchor.sourceIndexHash,
      input,
    );
  }

  async sourceSearch(
    anchor: CreatorSourceEvidenceAnchor,
    input: Parameters<CreatorSessionCoordinator["sourceSearch"]>[2],
  ) {
    return this.options.transaction.sourceSearch(
      this.sessionForSourceEvidence(anchor),
      anchor.sourceIndexHash,
      input,
    );
  }

  async sourceRead(
    anchor: CreatorSourceEvidenceAnchor,
    input: Parameters<CreatorSessionCoordinator["sourceRead"]>[2],
  ) {
    return this.options.transaction.sourceRead(
      this.sessionForSourceEvidence(anchor),
      anchor.sourceIndexHash,
      input,
    );
  }

  async sourceSymbols(
    anchor: CreatorSourceEvidenceAnchor,
    input: Parameters<CreatorSessionCoordinator["sourceSymbols"]>[2],
  ) {
    return this.options.transaction.sourceSymbols(
      this.sessionForSourceEvidence(anchor),
      anchor.sourceIndexHash,
      input,
    );
  }

  async sourceReferences(
    anchor: CreatorSourceEvidenceAnchor,
    input: Parameters<CreatorSessionCoordinator["sourceReferences"]>[2],
  ) {
    return this.options.transaction.sourceReferences(
      this.sessionForSourceEvidence(anchor),
      anchor.sourceIndexHash,
      input,
    );
  }

  async sourceDependencies(
    anchor: CreatorSourceEvidenceAnchor,
    input: Parameters<CreatorSessionCoordinator["sourceDependencies"]>[2],
  ) {
    return this.options.transaction.sourceDependencies(
      this.sessionForSourceEvidence(anchor),
      anchor.sourceIndexHash,
      input,
    );
  }

  async sourceDiff(
    anchor: CreatorSourceEvidenceAnchor,
    input: Parameters<CreatorSessionCoordinator["sourceDiff"]>[1],
  ) {
    if (input.sourceIndexHash !== anchor.sourceIndexHash)
      throw new Error("Exact source diff lost its sealed source-index anchor");
    return this.options.transaction.sourceDiff(this.sessionForSourceEvidence(anchor), input);
  }

  private async execute(execution: WorkExecution): Promise<void> {
    const queued = (await this.load(execution.conversationId)).jobs.find(
      (candidate) => candidate.id === execution.jobId,
    );
    if (!queued) throw new Error("Foreground work job disappeared before dispatch");
    const dispatchesProvider = queued.agentExecutions.length > 0;
    const consumesPersistedResponse = queued.providerOutcome === "response_persisted";
    const running = await this.updateJob(execution, {
      status: "running",
      phase: consumesPersistedResponse
        ? "response_resume_authorized"
        : dispatchesProvider
          ? "preparing_context"
          : "dispatching",
      providerOutcome: consumesPersistedResponse
        ? "response_persisted"
        : dispatchesProvider
          ? "never_dispatched"
          : "not_applicable",
      message: consumesPersistedResponse
        ? "Forge is consuming a creator-authorized durable provider response."
        : "Forge is working. Keep the creator service running while this activity is active.",
    });
    try {
      if (execution.request.kind === "CreatorTurnRequest")
        await this.executeTurn(execution, running);
      else await this.executeAction(execution, running);
    } catch (error) {
      const latest = (await this.load(execution.conversationId)).jobs.find(
        (candidate) => candidate.id === execution.jobId,
      );
      const current = latest ?? running;
      const assessment = await this.assessJobExecution(current);
      await this.updateJob(execution, {
        status: assessment.kind === "provider_outcome_unknown" ? "outcome_unknown" : "failed",
        phase: "stopped",
        providerOutcome: assessment.providerOutcome,
        message: boundedError(error),
        failureCode:
          assessment.kind === "provider_outcome_unknown"
            ? "provider_outcome_unknown"
            : assessment.kind === "resumable_response"
              ? "agent_execution_response_ready"
              : assessment.kind === "continuation_unavailable"
                ? "agent_execution_boundary_not_resumable"
                : "foreground_job_failed",
      });
    }
  }

  private async executeTurn(execution: WorkExecution, running: CreatorWorkJob): Promise<void> {
    const request = execution.request as CreatorTurnRequest;
    const before = await this.load(execution.conversationId);
    const activeEpisode = latestEpisode(before);
    const continuesEpisode =
      request.turnKind === "clarification" || request.turnKind === "plan_refinement";
    const priorEpisode = continuesEpisode ? activeEpisode : undefined;
    if (continuesEpisode) {
      if (!priorEpisode) throw new Error("Conversational refinement has no active work episode");
      await this.options.transaction.supersedeConversationCandidate(priorEpisode.sessionBundle.id);
    }
    const context = await this.materializeConversationContext(
      before,
      request,
      execution.creatorTurnId ?? requiredTurnId(running),
    );
    const prepared = await this.updateJob(execution, {
      status: "running",
      phase: "context_persisted",
      providerOutcome: "never_dispatched",
      conversationContext: context.artifact,
      message: "Reading your project and conversation.",
    });
    const transactionSessionId = requiredTransactionSessionId(prepared);
    const result = await this.options.transaction.action({
      action: "start",
      creatorText: request.text,
      agentPrompt: context.modelPrompt,
      model: request.selectedModelId,
      creatorSessionId: transactionSessionId,
      contextCitations: context.contextCitations,
      agentExecutions: prepared.agentExecutions,
    });
    const executionAssessment = await this.requireTerminalJobExecution(prepared);
    const sessionId = sessionIdFromSummary(result);
    if (sessionId !== transactionSessionId)
      throw new Error("Transaction coordinator returned another preassigned creator session");
    const snapshot = await this.options.transaction.conversationSnapshot(sessionId);
    const completedRun = await latestAgentRun(this.store, snapshot.bundle);
    const completedResponse =
      snapshot.bundle.agentOutcome && completedRun
        ? exactResponseAttribution(completedRun, request.selectedModelId)
        : undefined;
    const episode = await this.publishAgentOutcome({
      conversationId: execution.conversationId,
      creatorTurnId: execution.creatorTurnId ?? requiredTurnId(running),
      request,
      snapshot: snapshot.bundle,
      ...(priorEpisode ? { priorEpisode } : {}),
      contextArtifact: context.artifact,
    });
    this.sessionEpisodes.set(sessionId, {
      conversationId: execution.conversationId,
      episodeId: episode.id,
    });
    this.transactionHashes.set(sessionId, snapshot.bundle.session.hash);
    await this.updateJob(execution, {
      status: snapshot.bundle.agentOutcome ? "succeeded" : "failed",
      phase: snapshot.bundle.session.status,
      providerOutcome: executionAssessment.providerOutcome,
      ...(completedResponse?.responseId ? { providerRequestId: completedResponse.responseId } : {}),
      ...(snapshot.bundle.agentOutcome
        ? { message: "The agent outcome is durably published." }
        : agentRunFailure(completedRun)),
    });
  }

  private async executeAction(execution: WorkExecution, running: CreatorWorkJob): Promise<void> {
    const request = execution.request as CreatorActionRequest;
    const view = await this.store.artifactStore.read(
      running.admissionAuthority,
      assertCreatorControlView,
    );
    const descriptor = assertCreatorActionRequestBinding(view, request);
    if (
      view.id !== request.viewId ||
      view.hash !== request.viewHash ||
      view.conversationId !== request.conversationId
    )
      throw new Error("The admitted action lost its exact control binding");
    if (isMemoryAction(descriptor.actionId)) {
      await this.executeMemoryAction(execution, running, descriptor, request);
      return;
    }
    if (descriptor.actionId === "new_conversation") {
      const source = await this.load(request.conversationId);
      if (!conversationMatchesStudio(source, this.options.transaction.pairedStudio()))
        throw new Error("Open this project before starting a conversation.");
      const id = newConversationId(request);
      const now = this.now();
      await this.serialize(id, async () => {
        if (this.loaded.has(id)) return;
        const conversation = sealCreatorProjectConversation({
          id,
          project: source.conversation.project,
          title: source.conversation.title,
          createdAt: now,
          updatedAt: now,
          latestEventSequence: 1,
          episodeIds: [],
          memoryHeads: [],
        });
        const event = sealCreatorConversationEvent({
          id: `creator_event_${randomUUID()}`,
          conversationId: id,
          sequence: 1,
          occurredAt: now,
          authority: "creator",
          attachments: [],
          eventType: "project_identity",
          data: {
            state: "linked",
            project: conversation.project,
            message: "New conversation. This chat has its own history and context.",
          },
        });
        await this.store.append({ conversation, event, expectedHead: null });
        this.loaded.set(id, await this.store.load(id));
      });
      await this.updateJob(execution, {
        status: "succeeded",
        phase: "conversation_created",
        providerOutcome: "not_applicable",
        message: "Created a new conversation.",
      });
      return;
    }
    if (
      descriptor.actionId === "continue_published_project" ||
      descriptor.actionId === "start_published_project"
    ) {
      await this.executePublishedContinuity(execution, running, descriptor, request);
      return;
    }
    if (descriptor.actionId === "resume_work" || descriptor.actionId === "retry_work") {
      await this.executeResumedAgentWork(execution, running, descriptor.actionId);
      return;
    }
    if (descriptor.actionId === "revise_plan") {
      const text = request.input?.text;
      if (!text) throw new Error("Plan refinement text is required");
      const loaded = await this.load(request.conversationId);
      const episode = latestEpisode(loaded);
      if (!episode) throw new Error("Plan refinement has no active episode");
      const selectedModelId = requiredSelectedModelId(running);
      await this.options.transaction.supersedeConversationCandidate(episode.sessionBundle.id);
      const synthetic: CreatorTurnRequest = {
        kind: "CreatorTurnRequest",
        conversationId: request.conversationId,
        turnContractId: view.turnContract?.id ?? "turn_contract_missing",
        turnContractHash: view.turnContract?.hash ?? "0".repeat(64),
        turnKind: "plan_refinement",
        text,
        selectedModelId,
        idempotencyKey: request.idempotencyKey,
      };
      const context = await this.materializeConversationContext(
        loaded,
        synthetic,
        requiredTurnId(running),
      );
      const prepared = await this.updateJob(execution, {
        status: "running",
        phase: "context_persisted",
        providerOutcome: "never_dispatched",
        conversationContext: context.artifact,
        message:
          "The refinement context is durable; provider intent is journaled only by the lower runtime.",
      });
      const transactionSessionId = requiredTransactionSessionId(prepared);
      const result = await this.options.transaction.action({
        action: "start",
        creatorText: text,
        agentPrompt: context.modelPrompt,
        model: selectedModelId,
        creatorSessionId: transactionSessionId,
        contextCitations: context.contextCitations,
        agentExecutions: prepared.agentExecutions,
      });
      const executionAssessment = await this.requireTerminalJobExecution(prepared);
      const sessionId = sessionIdFromSummary(result);
      if (sessionId !== transactionSessionId)
        throw new Error("Transaction coordinator returned another preassigned creator session");
      const snapshot = await this.options.transaction.conversationSnapshot(sessionId);
      const completedRun = await latestAgentRun(this.store, snapshot.bundle);
      const completedResponse =
        snapshot.bundle.agentOutcome && completedRun
          ? exactResponseAttribution(completedRun, selectedModelId)
          : undefined;
      const updated = await this.publishAgentOutcome({
        conversationId: request.conversationId,
        creatorTurnId: requiredTurnId(running),
        request: synthetic,
        snapshot: snapshot.bundle,
        priorEpisode: episode,
        contextArtifact: context.artifact,
      });
      this.sessionEpisodes.set(sessionId, {
        conversationId: request.conversationId,
        episodeId: updated.id,
      });
      this.transactionHashes.set(sessionId, snapshot.bundle.session.hash);
      await this.updateJob(execution, {
        status: snapshot.bundle.agentOutcome ? "succeeded" : "failed",
        phase: snapshot.bundle.session.status,
        providerOutcome: executionAssessment.providerOutcome,
        ...(completedResponse?.responseId
          ? { providerRequestId: completedResponse.responseId }
          : {}),
        ...(snapshot.bundle.agentOutcome
          ? { message: "The refined agent outcome is durably published." }
          : agentRunFailure(completedRun)),
      });
      return;
    }
    const currentEpisode = latestEpisode(await this.load(request.conversationId));
    if (!currentEpisode) throw new Error("Conversation action has no transaction episode");
    const inner = transactionAction(descriptor, view, request, currentEpisode.sessionBundle.id);
    const actionResult = await this.options.transaction.action({
      ...inner,
      agentExecutions: running.agentExecutions,
    });
    await this.syncSession(currentEpisode.sessionBundle.id);
    const assessment = await this.assessJobExecution(running);
    if (
      assessment.kind === "provider_outcome_unknown" ||
      assessment.kind === "continuation_unavailable"
    )
      throw new Error("Creator action stopped at a non-resumable provider boundary");
    if (descriptor.actionId === "build_plan" && assessment.kind !== "terminal")
      throw new Error("Creator builder returned without a terminal execution journal");
    if (descriptor.actionId === "refresh_project") {
      const refreshedSessionId = sessionIdFromSummary(actionResult);
      if (refreshedSessionId !== currentEpisode.sessionBundle.id) {
        if (assessment.kind !== "terminal")
          throw new Error("Changed project refresh returned without a terminal planner journal");
        const [predecessorSnapshot, successorSnapshot] = await Promise.all([
          this.options.transaction.conversationSnapshot(currentEpisode.sessionBundle.id),
          this.options.transaction.conversationSnapshot(refreshedSessionId),
        ]);
        const successorEpisode = await this.publishRefreshSuccessor({
          execution,
          job: running,
          predecessorEpisodeId: currentEpisode.id,
          predecessor: predecessorSnapshot.bundle,
          successor: successorSnapshot.bundle,
        });
        const completedRun = await latestAgentRun(this.store, successorSnapshot.bundle);
        const completedResponse =
          successorSnapshot.bundle.agentOutcome && completedRun
            ? exactResponseAttribution(completedRun, requiredSelectedModelId(running))
            : undefined;
        await this.updateJob(execution, {
          status: successorSnapshot.bundle.agentOutcome ? "succeeded" : "failed",
          phase: successorSnapshot.bundle.session.status,
          providerOutcome: assessment.providerOutcome,
          ...(completedResponse?.responseId
            ? { providerRequestId: completedResponse.responseId }
            : {}),
          ...(successorSnapshot.bundle.agentOutcome
            ? {
                message: `The refreshed project was replanned in successor episode ${successorEpisode.id}.`,
              }
            : agentRunFailure(completedRun)),
        });
        return;
      }
    }
    const snapshot = await this.options.transaction.conversationSnapshot(
      currentEpisode.sessionBundle.id,
    );
    const awaitingExternal =
      (descriptor.actionId === "apply_changes" || descriptor.actionId === "retry_play") &&
      ["awaiting_verification", "verifying", "repairing"].includes(snapshot.bundle.session.status);
    const transactionFailed = ["incomplete", "recovery_required"].includes(
      snapshot.bundle.session.status,
    );
    await this.updateJob(execution, {
      status: awaitingExternal ? "awaiting_external" : transactionFailed ? "failed" : "succeeded",
      phase: awaitingExternal ? snapshot.bundle.session.status : descriptor.actionId,
      providerOutcome: assessment.providerOutcome,
      message: awaitingExternal
        ? "Studio work is awaiting its passive external boundary; no provider retry is implied."
        : "The creator action reached its durable transaction boundary.",
      ...(transactionFailed ? { failureCode: "creator_transaction_failed" } : {}),
    });
  }

  private assertModelAvailable(modelId: string | undefined): void {
    if (!modelId) throw new Error("Agent work lost its exact selected model");
    const selection = resolveCreatorModelSelection(modelId, this.options.modelCatalog);
    if (!selection.definition || selection.availability !== "available")
      throw new Error(`Selected model is unavailable: ${selection.reason}`);
  }

  private assertRefinementModelBinding(
    request: CreatorActionRequest,
    view: CreatorControlView,
  ): void {
    const selectedModelId = request.input?.selectedModelId;
    if (
      !selectedModelId ||
      request.input?.modelRegistryHash !== this.modelRegistry.hash ||
      view.turnContract?.modelRegistryHash !== this.modelRegistry.hash
    )
      throw new Error("Plan refinement is not bound to the current model registry");
    this.assertModelAvailable(selectedModelId);
  }

  private async assessJobExecution(job: CreatorWorkJob): Promise<JobExecutionAssessment> {
    const execution = job.agentExecutions[0];
    if (!execution) return { kind: "not_applicable", providerOutcome: "not_applicable" };
    if (job.agentExecutions.length !== 1)
      throw new Error("Current creator jobs require exactly one provider execution reservation");
    const journal = await new AgentExecutionJournalStore(this.store.artifactStore).loadIfPresent(
      execution.journalId,
    );
    if (!journal) return { kind: "never_dispatched", providerOutcome: "never_dispatched" };
    const recovery = assessAgentExecutionJournalRecovery(journal);
    if (recovery.kind === "provider_outcome_unknown")
      return { kind: "provider_outcome_unknown", providerOutcome: "outcome_unknown" };
    if (recovery.kind === "tool_outcome_unknown")
      return { kind: "continuation_unavailable", providerOutcome: "response_persisted" };
    if (recovery.kind === "response_ready") {
      // Parse the complete replay plan here so the foreground action cannot
      // admit a resume that the lower worker would later downgrade to a retry.
      createAgentExecutionJournalResume(journal);
      return { kind: "resumable_response", providerOutcome: "response_persisted", journal };
    }
    const terminal = journal.entries.at(-1)?.checkpoint;
    if (!terminal || terminal.checkpointType !== "terminal")
      throw new Error("Terminal execution journal lost its terminal checkpoint");
    return {
      kind: "terminal",
      providerOutcome:
        terminal.result.status === "completed" ? "response_persisted" : "failure_persisted",
      journal,
    };
  }

  private async requireTerminalJobExecution(
    job: CreatorWorkJob,
  ): Promise<Extract<JobExecutionAssessment, { kind: "terminal" }>> {
    const assessment = await this.assessJobExecution(job);
    if (assessment.kind !== "terminal")
      throw new Error(
        `Lower creator runtime did not reach a terminal execution-journal boundary (${assessment.kind})`,
      );
    return assessment;
  }

  private async executeResumedAgentWork(
    execution: WorkExecution,
    running: CreatorWorkJob,
    actionId: "resume_work" | "retry_work",
  ): Promise<void> {
    const loaded = await this.load(execution.conversationId);
    const prior = running.resumesJob
      ? loaded.jobs.find(
          (candidate) =>
            candidate.id === running.resumesJob?.id && candidate.hash === running.resumesJob.hash,
        )
      : undefined;
    if (!prior || agentRecoveryAction(prior) !== actionId)
      throw new Error("The exact interrupted agent job is no longer eligible for this action");

    const admitted = await this.readAdmittedRequest(prior);
    const recovery = await this.assessJobExecution(prior);
    if (
      actionId === "resume_work" &&
      prior.jobType === "agent_turn" &&
      recovery.kind === "resumable_response"
    ) {
      await this.executePersistedAgentResponse(execution, running, prior, admitted);
      return;
    }
    if (prior.jobType === "agent_action") {
      await this.executeResumedAgentAction(execution, running, prior, admitted);
      return;
    }
    const request = await this.agentTurnRequestForJob(prior, admitted);
    if (request.selectedModelId !== running.selectedModelId)
      throw new Error("Resumed work lost the exact model selected for the original turn");
    this.assertModelAvailable(request.selectedModelId);
    const priorEpisode = prior.episodeId
      ? loaded.episodes.find((candidate) => candidate.id === prior.episodeId)
      : undefined;
    if (prior.episodeId && !priorEpisode)
      throw new Error("Resumed work lost its immutable work episode");

    if (priorEpisode) {
      const candidate = await this.options.transaction.conversationSnapshot(
        priorEpisode.sessionBundle.id,
      );
      if (
        ["awaiting_clarification", "awaiting_plan_approval"].includes(
          candidate.bundle.session.status,
        )
      )
        await this.options.transaction.supersedeConversationCandidate(
          priorEpisode.sessionBundle.id,
        );
      else if (
        candidate.bundle.session.status === "incomplete" &&
        [
          "control_process_interrupted",
          "provider_outcome_unknown",
          "agent_execution_boundary_not_resumable",
          "agent_terminal_boundary_unpublished",
        ].includes(prior.failure?.code ?? "")
      ) {
        // The lower coordinator already closed this pre-mutation candidate on
        // restart. The creator-authorized replacement below gets a fresh slot.
      } else if (candidate.bundle.session.status !== "superseded")
        throw new Error(
          "The prior conversational candidate reached another boundary and cannot be retried",
        );
    }

    await this.options.transaction.abandonInterruptedConversationCandidate(
      requiredTransactionSessionId(prior),
    );
    const refreshed = await this.load(execution.conversationId);
    const context = await this.materializeConversationContext(
      refreshed,
      request,
      requiredTurnId(running),
    );
    const prepared = await this.updateJob(execution, {
      status: "running",
      phase: "context_persisted",
      providerOutcome: "never_dispatched",
      conversationContext: context.artifact,
      message:
        actionId === "resume_work"
          ? "The creator-authorized resumed context is durable; its new provider intent belongs to the lower journal."
          : "The creator-authorized replacement context is durable; its new provider intent belongs to the lower journal.",
    });
    const transactionSessionId = requiredTransactionSessionId(prepared);
    const result = await this.options.transaction.action({
      action: "start",
      creatorText: request.text,
      agentPrompt: context.modelPrompt,
      model: request.selectedModelId,
      creatorSessionId: transactionSessionId,
      contextCitations: context.contextCitations,
      agentExecutions: prepared.agentExecutions,
    });
    const executionAssessment = await this.requireTerminalJobExecution(prepared);
    const sessionId = sessionIdFromSummary(result);
    if (sessionId !== transactionSessionId)
      throw new Error("Transaction coordinator returned another preassigned creator session");
    const snapshot = await this.options.transaction.conversationSnapshot(sessionId);
    const completedRun = await latestAgentRun(this.store, snapshot.bundle);
    const completedResponse =
      snapshot.bundle.agentOutcome && completedRun
        ? exactResponseAttribution(completedRun, request.selectedModelId)
        : undefined;
    const episode = await this.publishAgentOutcome({
      conversationId: execution.conversationId,
      creatorTurnId: requiredTurnId(running),
      request,
      snapshot: snapshot.bundle,
      ...(priorEpisode ? { priorEpisode } : {}),
      contextArtifact: context.artifact,
    });
    this.sessionEpisodes.set(sessionId, {
      conversationId: execution.conversationId,
      episodeId: episode.id,
    });
    this.transactionHashes.set(sessionId, snapshot.bundle.session.hash);
    await this.updateJob(execution, {
      status: snapshot.bundle.agentOutcome ? "succeeded" : "failed",
      phase: snapshot.bundle.session.status,
      providerOutcome: executionAssessment.providerOutcome,
      ...(completedResponse?.responseId ? { providerRequestId: completedResponse.responseId } : {}),
      ...(snapshot.bundle.agentOutcome
        ? { message: "The explicitly authorized agent result is durably published." }
        : agentRunFailure(completedRun)),
    });
  }

  /**
   * Consume a persisted planner response through the same lower session and
   * execution journal. This never rebuilds context, abandons the candidate,
   * or allocates a provider request identity for the received response.
   */
  private async executePersistedAgentResponse(
    execution: WorkExecution,
    running: CreatorWorkJob,
    prior: CreatorWorkJob,
    admitted: ConversationRequest,
  ): Promise<void> {
    const request = await this.agentTurnRequestForJob(prior, admitted);
    if (request.selectedModelId !== running.selectedModelId)
      throw new Error("Resumed response lost the exact model selected for the original turn");
    this.assertModelAvailable(request.selectedModelId);
    if (stableJson(prior.agentExecutions) !== stableJson(running.agentExecutions))
      throw new Error("Resumed response must retain the original provider execution journal");
    const transactionSessionId = requiredTransactionSessionId(prior);
    if (requiredTransactionSessionId(running) !== transactionSessionId)
      throw new Error("Resumed response must retain the original transaction session");
    if (!prior.conversationContext)
      throw new Error("Resumed response lost its durable original conversation context");
    const loaded = await this.load(execution.conversationId);
    const priorEpisode = prior.episodeId
      ? loaded.episodes.find((candidate) => candidate.id === prior.episodeId)
      : undefined;
    if (prior.episodeId && !priorEpisode)
      throw new Error("Resumed response lost its immutable work episode");
    const prepared = await this.updateJob(execution, {
      status: "running",
      phase: "response_resume_authorized",
      providerOutcome: "response_persisted",
      conversationContext: prior.conversationContext,
      message:
        "Creator authority is consuming the durable provider response in its original journal; no received provider response is replayed.",
    });
    const result = await this.options.transaction.action({
      action: "resume",
      creatorSessionId: transactionSessionId,
      agentExecutions: prepared.agentExecutions,
    });
    const executionAssessment = await this.requireTerminalJobExecution(prepared);
    const sessionId = sessionIdFromSummary(result);
    if (sessionId !== transactionSessionId)
      throw new Error("Response resume returned another creator session");
    const snapshot = await this.options.transaction.conversationSnapshot(sessionId);
    const completedRun = await latestAgentRun(this.store, snapshot.bundle);
    const completedResponse =
      snapshot.bundle.agentOutcome && completedRun
        ? exactResponseAttribution(completedRun, request.selectedModelId)
        : undefined;
    const episode = await this.publishAgentOutcome({
      conversationId: execution.conversationId,
      creatorTurnId: requiredTurnId(running),
      request,
      snapshot: snapshot.bundle,
      ...(priorEpisode ? { priorEpisode } : {}),
      contextArtifact: prior.conversationContext,
    });
    this.sessionEpisodes.set(sessionId, {
      conversationId: execution.conversationId,
      episodeId: episode.id,
    });
    this.transactionHashes.set(sessionId, snapshot.bundle.session.hash);
    await this.updateJob(execution, {
      status: snapshot.bundle.agentOutcome ? "succeeded" : "failed",
      phase: snapshot.bundle.session.status,
      providerOutcome: executionAssessment.providerOutcome,
      ...(completedResponse?.responseId ? { providerRequestId: completedResponse.responseId } : {}),
      ...(snapshot.bundle.agentOutcome
        ? { message: "The creator-authorized response resume is durably published." }
        : agentRunFailure(completedRun)),
    });
  }

  private async executeResumedAgentAction(
    execution: WorkExecution,
    running: CreatorWorkJob,
    prior: CreatorWorkJob,
    admitted: ConversationRequest,
  ): Promise<void> {
    if (admitted.kind !== "CreatorActionRequest")
      throw new Error("Interrupted agent action lost its exact admitted action request");
    const authority = await this.store.artifactStore.read(
      prior.admissionAuthority,
      assertCreatorControlView,
    );
    const descriptor = assertCreatorActionRequestBinding(authority, admitted);
    const loaded = await this.load(execution.conversationId);
    const episode = prior.episodeId
      ? loaded.episodes.find((candidate) => candidate.id === prior.episodeId)
      : undefined;
    if (!episode) throw new Error("Interrupted agent action lost its exact transaction episode");
    if (
      prior.selectedModelId !== running.selectedModelId ||
      prior.agentExecutions[0]?.purpose !== running.agentExecutions[0]?.purpose
    )
      throw new Error("Resumed agent action changed its selected model or execution purpose");
    this.assertModelAvailable(running.selectedModelId);
    const inner = transactionAction(descriptor, authority, admitted, episode.sessionBundle.id);
    const result = await this.options.transaction.action({
      ...inner,
      agentExecutions: running.agentExecutions,
    });
    await this.syncSession(episode.sessionBundle.id);
    const assessment = await this.assessJobExecution(running);
    if (
      assessment.kind === "provider_outcome_unknown" ||
      assessment.kind === "continuation_unavailable"
    )
      throw new Error("Resumed creator action stopped at a non-resumable provider boundary");
    if (descriptor.actionId === "build_plan" && assessment.kind !== "terminal")
      throw new Error("Resumed creator builder returned without a terminal execution journal");
    if (descriptor.actionId === "refresh_project") {
      const refreshedSessionId = sessionIdFromSummary(result);
      if (refreshedSessionId !== episode.sessionBundle.id) {
        if (assessment.kind !== "terminal")
          throw new Error("Resumed changed refresh returned without a terminal planner journal");
        const [predecessorSnapshot, successorSnapshot] = await Promise.all([
          this.options.transaction.conversationSnapshot(episode.sessionBundle.id),
          this.options.transaction.conversationSnapshot(refreshedSessionId),
        ]);
        await this.publishRefreshSuccessor({
          execution,
          job: running,
          predecessorEpisodeId: episode.id,
          predecessor: predecessorSnapshot.bundle,
          successor: successorSnapshot.bundle,
        });
        await this.updateJob(execution, {
          status: successorSnapshot.bundle.agentOutcome ? "succeeded" : "failed",
          phase: successorSnapshot.bundle.session.status,
          providerOutcome: assessment.providerOutcome,
          ...(successorSnapshot.bundle.agentOutcome
            ? { message: "The explicitly resumed refresh published a linked successor episode." }
            : agentRunFailure(await latestAgentRun(this.store, successorSnapshot.bundle))),
        });
        return;
      }
    }
    const snapshot = await this.options.transaction.conversationSnapshot(episode.sessionBundle.id);
    const awaitingExternal =
      (descriptor.actionId === "apply_changes" || descriptor.actionId === "retry_play") &&
      ["awaiting_verification", "verifying", "repairing"].includes(snapshot.bundle.session.status);
    const failed = ["incomplete", "recovery_required"].includes(snapshot.bundle.session.status);
    await this.updateJob(execution, {
      status: awaitingExternal ? "awaiting_external" : failed ? "failed" : "succeeded",
      phase: awaitingExternal ? snapshot.bundle.session.status : descriptor.actionId,
      providerOutcome: assessment.providerOutcome,
      message: awaitingExternal
        ? "The explicitly resumed Studio action is awaiting its passive external boundary."
        : "The explicitly resumed action reached its durable transaction boundary.",
      ...(failed ? { failureCode: "creator_transaction_failed" } : {}),
    });
  }

  private async executeMemoryAction(
    execution: WorkExecution,
    running: CreatorWorkJob,
    descriptor: CreatorControlActionDescriptor,
    request: CreatorActionRequest,
  ): Promise<void> {
    const revision = await this.serialize(request.conversationId, async () => {
      let loaded = await this.load(request.conversationId);
      const prior = request.target
        ? loaded.memoryRevisions.find(
            (candidate) =>
              candidate.itemId === request.target?.itemId &&
              candidate.id === request.target.revisionId &&
              candidate.hash === request.target.revisionHash,
          )
        : undefined;
      const latest = request.target
        ? loaded.conversation.memoryHeads.find((head) => head.itemId === request.target?.itemId)
        : undefined;
      if (
        request.target &&
        (!prior || !latest || latest.revisionId !== prior.id || latest.revisionHash !== prior.hash)
      )
        throw new Error("Memory action target is no longer the current memory head");
      const operation = memoryOperation(descriptor.actionId);
      const text =
        operation === "remember" || operation === "correct" ? request.input?.text : prior?.text;
      if (text === undefined) throw new Error("Memory text is unavailable");
      const category =
        operation === "remember"
          ? request.input?.memoryCategory
          : (request.input?.memoryCategory ?? prior?.category);
      if (!category) throw new Error("Memory category is required");
      const itemId = prior?.itemId ?? `creator_memory_item_${randomUUID()}`;
      const memory = sealCreatorMemoryRevision({
        id: `creator_memory_revision_${randomUUID()}`,
        conversationId: request.conversationId,
        itemId,
        revision: (prior?.revision ?? 0) + 1,
        operation,
        category,
        text,
        state: operation === "forget" ? "forgotten" : "active",
        pinned:
          operation === "forget"
            ? false
            : operation === "pin"
              ? true
              : operation === "unpin"
                ? false
                : (prior?.pinned ?? false),
        ...(prior ? { priorRevision: { id: prior.id, hash: prior.hash } } : {}),
        authority: "creator",
        createdAt: this.now(),
      });
      const reference = await this.store.artifactStore.write(memory);
      loaded = await this.append(loaded, {
        authority: "creator",
        eventType: "memory",
        memoryRevision: memory,
        data: {
          memoryRevision: binding(memory.id, memory.hash, reference),
          operation: memory.operation,
        },
        attachments: [],
      });
      return memory;
    });
    await this.updateJob(execution, {
      status: "succeeded",
      phase: revision.operation,
      providerOutcome: running.providerOutcome,
      message: `Project memory ${revision.operation.replaceAll("_", " ")} was durably recorded.`,
    });
  }

  private async publishAgentOutcome(input: {
    conversationId: string;
    creatorTurnId: string;
    request: Pick<CreatorTurnRequest, "selectedModelId">;
    snapshot: CreatorSessionBundle;
    priorEpisode?: CreatorWorkEpisode;
    successorOf?: CreatorWorkEpisode;
    newEpisodeId?: string;
    contextArtifact: ArtifactReference;
  }): Promise<CreatorWorkEpisode> {
    if (input.priorEpisode && input.successorOf)
      throw new Error("Agent outcome cannot both revise and succeed an episode");
    if (input.newEpisodeId && !input.successorOf)
      throw new Error("A preassigned episode identity is only valid for a refresh successor");
    const snapshotReference = await this.writeSessionSnapshot(input.snapshot);
    const runBinding = input.snapshot.agentRuns.at(-1);
    const run = runBinding
      ? ((await this.store.artifactStore.read(runBinding.agentRun)) as AgentRunView)
      : undefined;
    const outcome = input.snapshot.agentOutcome?.outcome;
    const episodeStatus = episodeStatusForSession(input.snapshot.session.status);
    const now = this.now();
    let loaded = await this.load(input.conversationId);
    let episode = sealCreatorWorkEpisode({
      id: input.priorEpisode?.id ?? input.newEpisodeId ?? `creator_episode_${randomUUID()}`,
      conversationId: input.conversationId,
      ordinal: input.priorEpisode?.ordinal ?? loaded.episodes.length + 1,
      status: episodeStatus,
      selectedModelId: input.request.selectedModelId,
      initialProjectRevisionHash:
        input.priorEpisode?.initialProjectRevisionHash ??
        input.snapshot.session.initialRevisionHash,
      currentProjectRevisionHash: input.snapshot.session.currentRevisionHash,
      sessionBundle: binding(
        input.snapshot.session.id,
        snapshotReference.artifactHash,
        snapshotReference,
      ),
      creatorTurnId:
        input.priorEpisode?.creatorTurnId ??
        input.successorOf?.creatorTurnId ??
        input.creatorTurnId,
      ...(input.priorEpisode?.planRevision
        ? { planRevision: input.priorEpisode.planRevision }
        : {}),
      ...(input.priorEpisode?.predecessorEpisodeId
        ? { predecessorEpisodeId: input.priorEpisode.predecessorEpisodeId }
        : input.successorOf
          ? { predecessorEpisodeId: input.successorOf.id }
          : {}),
      ...(input.priorEpisode?.successorEpisodeId
        ? { successorEpisodeId: input.priorEpisode.successorEpisodeId }
        : {}),
      createdAt: input.priorEpisode?.createdAt ?? now,
      updatedAt: now,
    });
    if (!outcome || !run) {
      await this.append(loaded, {
        authority: "forge",
        eventType: "terminal_output",
        episodeId: episode.id,
        episode,
        projectRevisionHash: input.snapshot.session.currentRevisionHash,
        binding: sessionBinding(input.snapshot),
        data: {
          outcome: "incomplete",
          message: agentRunFailure(run).message,
          studioHasAcceptedResult: false,
        },
        attachments: await this.technicalAttachments(input.snapshot, input.contextArtifact),
      });
      return episode;
    }
    const response = exactResponseAttribution(run, input.request.selectedModelId);
    const sourceIndexHash = input.snapshot.sourceConsultations.at(-1)?.indexHash;
    const citations = outcome.citations.flatMap((citation) =>
      conversationCitations(input.conversationId, run.id, citation, sourceIndexHash),
    );
    const text =
      outcome.kind === "answer"
        ? outcome.text
        : outcome.kind === "clarification_requested"
          ? outcome.question
          : outcome.plan.goal;
    const turn = sealCreatorConversationTurn({
      id: `agent_turn_${randomUUID()}`,
      conversationId: input.conversationId,
      episodeId: episode.id,
      role: "agent",
      outcome: outcome.kind,
      text,
      modelId: input.request.selectedModelId,
      providerId: response.providerId,
      responseModelId: response.modelId,
      agentRunId: run.id,
      timing: run.timing,
      usage: aggregateAgentUsage(run),
      projectRevisionHash: input.snapshot.session.currentRevisionHash,
      citations,
      createdAt: now,
    });
    const turnReference = await this.store.artifactStore.write(turn);
    loaded = await this.append(loaded, {
      authority: "agent",
      eventType: "agent_turn",
      episodeId: episode.id,
      episode,
      turn,
      projectRevisionHash: input.snapshot.session.currentRevisionHash,
      binding: sessionBinding(input.snapshot),
      data: {
        turn: binding(turn.id, turn.hash, turnReference),
        outcome: outcome.kind,
        modelId: input.request.selectedModelId,
        providerId: response.providerId,
        responseModelId: response.modelId,
        agentRunId: run.id,
        timing: run.timing,
        usage: aggregateAgentUsage(run),
        text,
        citations,
      },
      attachments: await this.technicalAttachments(input.snapshot, input.contextArtifact),
    });
    if (outcome.kind === "plan_proposed") {
      const planReference = await this.store.artifactStore.write(outcome.plan);
      const consultation = input.snapshot.sourceConsultations.at(-1);
      const previousPlan = loaded.planRevisions
        .filter((candidate) => candidate.episodeId === episode.id)
        .at(-1);
      const revision = sealCreatorPlanRevision({
        id: `creator_plan_revision_${randomUUID()}`,
        conversationId: input.conversationId,
        episodeId: episode.id,
        revision: (previousPlan?.revision ?? 0) + 1,
        projectRevisionHash: outcome.plan.projectRevisionHash,
        modelId: input.request.selectedModelId,
        plan: binding(outcome.plan.id, outcome.plan.hash, planReference),
        ...(consultation
          ? {
              sourceConsultation: binding(
                consultation.id,
                consultation.hash,
                consultation.artifact,
              ),
            }
          : {}),
        ...(previousPlan ? { supersedes: { id: previousPlan.id, hash: previousPlan.hash } } : {}),
        publishedAt: now,
      });
      const revisionReference = await this.store.artifactStore.write(revision);
      episode = sealCreatorWorkEpisode({
        ...withoutRecordIdentity(episode),
        planRevision: { id: revision.id, hash: revision.hash },
        updatedAt: this.now(),
      });
      await this.append(loaded, {
        authority: "agent",
        eventType: "plan_revision",
        episodeId: episode.id,
        episode,
        planRevision: revision,
        projectRevisionHash: outcome.plan.projectRevisionHash,
        binding: {
          ...sessionBinding(input.snapshot),
          planRevisionId: revision.id,
          planRevisionHash: revision.hash,
        },
        data: {
          planRevision: binding(revision.id, revision.hash, revisionReference),
          revision: revision.revision,
          summary: outcome.plan.goal,
        },
        attachments: await this.technicalAttachments(input.snapshot, input.contextArtifact),
      });
    }
    return episode;
  }

  private async publishRefreshSuccessor(input: {
    execution: WorkExecution;
    job: CreatorWorkJob;
    predecessorEpisodeId: string;
    predecessor: CreatorSessionBundle;
    successor: CreatorSessionBundle;
  }): Promise<CreatorWorkEpisode> {
    if (
      input.predecessor.successorSessionId !== input.successor.session.id ||
      input.successor.predecessorSessionId !== input.predecessor.session.id
    )
      throw new Error("Project refresh lost its reciprocal lower-session successor binding");
    const executionSlot = input.job.agentExecutions[0];
    if (
      input.job.agentExecutions.length !== 1 ||
      executionSlot?.purpose !== "planner" ||
      input.successor.agentRuns.at(-1)?.agentRunId !== executionSlot.agentRunId
    )
      throw new Error("Project refresh successor is not bound to its preassigned planner run");
    if (
      input.successor.session.model !== input.job.selectedModelId ||
      input.predecessor.session.model !== input.job.selectedModelId
    )
      throw new Error("Project refresh successor changed the exact selected model");

    const creatorRequest = await this.store.artifactStore.read(
      input.successor.creatorRequest,
      assertCreatorRequestArtifact,
    );
    if (creatorRequest.sessionId !== input.successor.session.id)
      throw new Error("Project refresh successor request belongs to another session");

    const loaded = await this.load(input.execution.conversationId);
    const alreadyPublished = loaded.episodes.find(
      (episode) => episode.sessionBundle.id === input.successor.session.id,
    );
    if (alreadyPublished) return alreadyPublished;
    const predecessor = loaded.episodes.find(
      (episode) => episode.id === input.predecessorEpisodeId,
    );
    if (!predecessor || predecessor.sessionBundle.id !== input.predecessor.session.id)
      throw new Error("Project refresh lost its immutable predecessor episode");
    const refresh = input.predecessor.projectRefreshes.at(-1);
    if (
      !refresh ||
      refresh.refresh.outcome !== "superseded" ||
      refresh.refresh.successorSessionId !== input.successor.session.id
    )
      throw new Error("Project refresh successor has no exact superseding refresh evidence");

    const successorEpisodeId = `creator_episode_${randomUUID()}`;
    const predecessorReference = await this.writeSessionSnapshot(input.predecessor);
    const linkedPredecessor = sealCreatorWorkEpisode({
      ...withoutRecordIdentity(predecessor),
      status: "superseded",
      currentProjectRevisionHash: input.predecessor.session.currentRevisionHash,
      sessionBundle: binding(
        input.predecessor.session.id,
        predecessorReference.artifactHash,
        predecessorReference,
      ),
      successorEpisodeId,
      updatedAt: this.now(),
    });
    await this.append(loaded, {
      authority: "forge",
      eventType: "project_change",
      episodeId: linkedPredecessor.id,
      episode: linkedPredecessor,
      projectRevisionHash: input.predecessor.session.currentRevisionHash,
      binding: sessionBinding(input.predecessor),
      data: {
        state: "superseded",
        message:
          "A complete refresh changed the project. The prior episode is superseded and no plan, approval, change set, or action authority was inherited.",
        predecessorEpisodeId: linkedPredecessor.id,
        successorEpisodeId,
      },
      attachments: [
        {
          role: "refresh",
          label: "Project refresh",
          binding: binding(refresh.refresh.id, refresh.refresh.hash, refresh.artifact),
        },
      ],
    });
    const successor = await this.publishAgentOutcome({
      conversationId: input.execution.conversationId,
      creatorTurnId: linkedPredecessor.creatorTurnId,
      request: { selectedModelId: input.job.selectedModelId! },
      snapshot: input.successor,
      successorOf: linkedPredecessor,
      newEpisodeId: successorEpisodeId,
      // The lower CreatorRequest is the exact immutable planner input retained
      // across refresh; no synthetic conversation context is invented here.
      contextArtifact: input.successor.creatorRequest,
    });
    this.sessionEpisodes.set(input.successor.session.id, {
      conversationId: input.execution.conversationId,
      episodeId: successor.id,
    });
    this.transactionHashes.set(input.successor.session.id, input.successor.session.hash);
    return successor;
  }

  private async syncSession(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const state = this.sessionEpisodes.get(sessionId);
    if (!state) return;
    const snapshot = await this.options.transaction.conversationSnapshot(sessionId);
    if (this.transactionHashes.get(sessionId) === snapshot.bundle.session.hash) return;
    let jobToSettle: CreatorWorkJob | undefined;
    await this.serialize(state.conversationId, async () => {
      const loaded = await this.load(state.conversationId);
      const current = loaded.episodes.find((episode) => episode.id === state.episodeId);
      if (!current) return;
      const reference = await this.writeSessionSnapshot(snapshot.bundle);
      const episode = sealCreatorWorkEpisode({
        ...withoutRecordIdentity(current),
        status: episodeStatusForSession(snapshot.bundle.session.status),
        selectedModelId: snapshot.bundle.session.model,
        currentProjectRevisionHash: snapshot.bundle.session.currentRevisionHash,
        sessionBundle: binding(sessionId, reference.artifactHash, reference),
        updatedAt: this.now(),
      });
      const activeJob = current.activeJob
        ? loaded.jobs.find((job) => job.id === current.activeJob?.id)
        : undefined;
      const activeJobArtifact = activeJob
        ? await this.store.artifactStore.write(activeJob)
        : undefined;
      const events = await transactionMilestoneEvents({
        bundle: snapshot.bundle,
        episode,
        existingEvents: loaded.events,
        ...(activeJob ? { activeJob } : {}),
        ...(activeJobArtifact ? { activeJobArtifact } : {}),
        writeArtifact: (value) => this.store.artifactStore.write(value),
        readArtifact: (reference) => this.store.artifactStore.read(reference),
      });
      let next = loaded;
      for (const event of events) next = await this.append(next, event);
      this.transactionHashes.set(sessionId, snapshot.bundle.session.hash);
      if (
        activeJob?.status === "awaiting_external" &&
        ![
          "preflighting",
          "applying",
          "awaiting_verification",
          "verifying",
          "repairing",
          "cancelling",
          "committing",
        ].includes(snapshot.bundle.session.status)
      )
        jobToSettle = activeJob;
    });
    if (jobToSettle) {
      const request = await this.readAdmittedRequest(jobToSettle);
      const assessment = await this.assessJobExecution(jobToSettle);
      const failedSession = ["incomplete", "recovery_required"].includes(
        snapshot.bundle.session.status,
      );
      await this.updateJob(
        { request, jobId: jobToSettle.id, conversationId: state.conversationId },
        assessment.kind === "provider_outcome_unknown"
          ? {
              status: "outcome_unknown",
              phase: "provider_outcome_unknown",
              providerOutcome: "outcome_unknown",
              message:
                "The passive Studio boundary ended with an unconfirmed provider response. Forge will not retry automatically.",
              failureCode: "provider_outcome_unknown",
            }
          : assessment.kind === "continuation_unavailable"
            ? {
                status: "failed",
                phase: "explicit_new_run_required",
                providerOutcome: assessment.providerOutcome,
                message:
                  "A provider response is durable, but opaque continuation or host state is unavailable. A new creator-authorized AgentRun is required.",
                failureCode: "agent_execution_boundary_not_resumable",
              }
            : {
                status: failedSession ? "failed" : "succeeded",
                phase: snapshot.bundle.session.status,
                providerOutcome: assessment.providerOutcome,
                message: failedSession
                  ? "The external transaction reached a durable terminal failure boundary."
                  : "The external transaction reached its durable creator boundary.",
                ...(failedSession ? { failureCode: "creator_transaction_failed" } : {}),
              },
      );
    }
  }

  private async technicalAttachments(
    bundle: CreatorSessionBundle,
    context?: ArtifactReference,
  ): Promise<CreatorConversationAttachment[]> {
    const result: CreatorConversationAttachment[] = [];
    const push = (
      role: CreatorConversationAttachment["role"],
      label: string,
      id: string,
      hash: string,
      artifact: ArtifactReference,
    ): void => {
      if (
        !result.some(
          (candidate) => candidate.binding.artifact.artifactHash === artifact.artifactHash,
        )
      )
        result.push({ role, label, binding: binding(id, hash, artifact) });
    };
    const write = async (
      role: CreatorConversationAttachment["role"],
      label: string,
      value: { readonly id: string; readonly hash: string },
    ): Promise<void> => {
      push(role, label, value.id, value.hash, await this.store.artifactStore.write(value));
    };

    if (context)
      push(
        "technical_detail",
        "Conversation context",
        `conversation_context_${context.artifactHash.slice(0, 24)}`,
        context.artifactHash,
        context,
      );
    const projectIndex = bundle.projectIndices.at(-1);
    if (projectIndex) {
      push(
        "project_index",
        "Project index manifest",
        projectIndex.manifest.id,
        projectIndex.manifest.hash,
        projectIndex.manifest.artifact,
      );
      push(
        "project_index",
        "Project revision",
        projectIndex.revision.id,
        projectIndex.revision.hash,
        projectIndex.revision.artifact,
      );
    }
    const source = bundle.sourceConsultations.at(-1);
    if (source)
      push("source_consultation", "Source consultation", source.id, source.hash, source.artifact);
    const run = bundle.agentRuns.at(-1);
    if (run) {
      push("agent_run", "Agent run", run.agentRunId, run.agentRun.artifactHash, run.agentRun);
      push("build_trace", "Build trace", run.traceId, run.trace.artifactHash, run.trace);
    }
    if (bundle.agentOutcome)
      push(
        bundle.agentOutcome.outcome.kind === "plan_proposed" ? "plan" : "technical_detail",
        "Agent outcome",
        bundle.agentOutcome.outcome.id,
        bundle.agentOutcome.outcome.hash,
        bundle.agentOutcome.artifact,
      );
    const change = bundle.changeSets.at(-1);
    if (change) await write("change_set", "Exact change set", change);
    const mutation = bundle.mutationAttempts.at(-1);
    if (mutation) await write("mutation", "Mutation attempt", mutation);
    const verification = bundle.verifications.at(-1);
    if (verification) await write("verification", "Verification", verification);
    const refresh = bundle.projectRefreshes.at(-1);
    if (refresh)
      push(
        "refresh",
        "Project refresh",
        refresh.refresh.id,
        refresh.refresh.hash,
        refresh.artifact,
      );
    if (bundle.review)
      push(
        "review_report",
        "Creator review report",
        bundle.review.report.id,
        bundle.review.report.hash,
        bundle.review.artifact,
      );
    return result;
  }

  private onTransactionInvalidated(): void {
    this.emit();
    if (!this.initialized || !this.accepting) return;
    for (const sessionId of this.sessionEpisodes.keys()) {
      if (this.scheduledSessionSync.has(sessionId)) continue;
      this.scheduledSessionSync.add(sessionId);
      const synchronization = Promise.resolve().then(async () => {
        this.scheduledSessionSync.delete(sessionId);
        await this.syncSession(sessionId).catch(() => undefined);
      });
      this.track(synchronization);
    }
  }

  private async updateJob(
    execution: WorkExecution,
    update: {
      status: CreatorWorkJob["status"];
      phase: string;
      providerOutcome: CreatorWorkJob["providerOutcome"];
      message: string;
      failureCode?: string;
      conversationContext?: ArtifactReference;
      providerRequestId?: string;
    },
  ): Promise<CreatorWorkJob> {
    return this.serialize(execution.conversationId, async () => {
      const loaded = await this.load(execution.conversationId);
      const prior = loaded.jobs.find((job) => job.id === execution.jobId);
      if (!prior)
        throw new Error("Foreground work job is missing from durable conversation history");
      const now = this.now();
      const job = sealCreatorWorkJob({
        ...withoutRecordIdentity(prior),
        status: update.status,
        phase: update.phase,
        providerOutcome: update.providerOutcome,
        ...(update.conversationContext ? { conversationContext: update.conversationContext } : {}),
        ...(update.providerRequestId ? { providerRequestId: update.providerRequestId } : {}),
        ...(update.failureCode
          ? {
              failure: {
                code: update.failureCode,
                detailHash: contentHash(update.message),
              },
            }
          : {}),
        updatedAt: now,
      });
      const reference = await this.store.artifactStore.write(job);
      const currentEpisode = prior.episodeId
        ? loaded.episodes.find((episode) => episode.id === prior.episodeId)
        : undefined;
      const episode = currentEpisode
        ? sealCreatorWorkEpisode({
            ...withoutActiveJob(currentEpisode),
            ...(terminalJobStatus(job.status) ? {} : { activeJob: { id: job.id, hash: job.hash } }),
            updatedAt: now,
          })
        : undefined;
      await this.append(loaded, {
        authority: "forge",
        eventType: "activity",
        ...(episode ? { episodeId: episode.id, episode } : {}),
        job,
        data: {
          job: binding(job.id, job.hash, reference),
          status: job.status,
          phase: job.phase,
          message: update.message,
        },
        attachments: [],
      });
      return job;
    });
  }

  private async markInterruptedJobs(): Promise<void> {
    for (const conversation of [...this.loaded.values()]) {
      for (const persistedJob of conversation.jobs.filter((candidate) =>
        ["queued", "running", "awaiting_external"].includes(candidate.status),
      )) {
        let job = persistedJob;
        if (job.jobType !== "agent_turn" && job.episodeId) {
          await this.syncSession(
            conversation.episodes.find((episode) => episode.id === job.episodeId)?.sessionBundle.id,
          );
          const refreshed = (await this.load(conversation.conversation.id)).jobs.find(
            (candidate) => candidate.id === job.id,
          );
          if (!refreshed) throw new Error("Interrupted work job disappeared during recovery");
          if (!["queued", "running", "awaiting_external"].includes(refreshed.status)) continue;
          job = refreshed;
        }
        const request = await this.readAdmittedRequest(job);
        const assessment = await this.assessJobExecution(job);
        if (assessment.kind === "terminal" && job.jobType === "agent_turn") {
          const recovered = await this.recoverPersistedAgentBoundary(conversation, job, request);
          if (recovered) continue;
        }
        if (job.jobType === "agent_action") {
          const recovered = await this.recoverPersistedAgentActionBoundary(
            await this.load(conversation.conversation.id),
            job,
            request,
            assessment,
          );
          if (recovered) continue;
        }
        const exactAgentActionResume =
          assessment.kind === "never_dispatched" &&
          job.jobType === "agent_action" &&
          (await this.canResumeExactAgentAction(
            await this.load(conversation.conversation.id),
            job,
            request,
          ));
        await this.updateJob(
          { request, jobId: job.id, conversationId: conversation.conversation.id },
          assessment.kind === "provider_outcome_unknown"
            ? {
                status: "outcome_unknown",
                phase: "provider_outcome_unknown",
                providerOutcome: "outcome_unknown",
                message:
                  "The exact lower journal proves provider intent but no response boundary. Forge will not retry automatically.",
                failureCode: "provider_outcome_unknown",
              }
            : assessment.kind === "continuation_unavailable"
              ? {
                  status: "failed",
                  phase: "explicit_new_run_required",
                  providerOutcome: assessment.providerOutcome,
                  message:
                    "The exact lower journal contains a provider response but not a restorable continuation/host boundary. A new creator-authorized AgentRun is required.",
                  failureCode: "agent_execution_boundary_not_resumable",
                }
              : assessment.kind === "resumable_response"
                ? {
                    status: "failed",
                    phase: "resume_required",
                    providerOutcome: "response_persisted",
                    message:
                      "The received provider response and completed tool records are durable. Explicit creator resume will consume this exact journal without replaying the provider response.",
                    failureCode: "agent_execution_response_ready",
                  }
                : assessment.kind === "terminal"
                  ? {
                      status: "failed",
                      phase: "terminal_boundary_unpublished",
                      providerOutcome: assessment.providerOutcome,
                      message:
                        "The lower runtime is terminal, but its transaction result was not durably published. Forge will not reconstruct mutable host state or redispatch the provider.",
                      failureCode: "agent_terminal_boundary_unpublished",
                    }
                  : exactAgentActionResume
                    ? {
                        status: "failed",
                        phase: "resume_required",
                        providerOutcome: "never_dispatched",
                        message:
                          "No lower provider intent exists and the exact approved transaction action remains eligible. Resume requires explicit creator authority and a fresh preassigned AgentRun.",
                        failureCode: "agent_action_resume_exact",
                      }
                    : {
                        status: "failed",
                        phase: "resume_required",
                        providerOutcome: assessment.providerOutcome,
                        message:
                          "No lower provider intent exists. Resume requires explicit creator authority and a fresh preassigned AgentRun.",
                        failureCode: "control_process_interrupted",
                      },
        );
      }
    }
  }

  private async markInterruptedIdentityJobs(): Promise<void> {
    for (const loaded of [...this.identityJobs.values()]) {
      if (loaded.job.status === "queued") {
        const detail = "Forge stopped before dispatching this durable project identity job.";
        await this.transitionIdentityJob(loaded.job.id, {
          status: "failed",
          phase: "resume_required",
          failure: {
            code: "control_process_interrupted",
            detail,
            detailHash: contentHash(detail),
          },
          updatedAt: this.now(),
        });
      } else if (loaded.job.status === "running") {
        const detail =
          "Forge stopped after persisting project identity dispatch intent; Studio outcome is unknown.";
        await this.transitionIdentityJob(loaded.job.id, {
          status: "outcome_unknown",
          phase: "studio_outcome_unknown",
          failure: {
            code: "studio_identity_outcome_unknown",
            detail,
            detailHash: contentHash(detail),
          },
          updatedAt: this.now(),
        });
      }
    }
  }

  private findIdempotentIdentityJob(
    request: CreatorActionRequest,
  ): LoadedCreatorProjectIdentityJob | undefined {
    const candidate = [...this.identityJobs.values()].find(
      (loaded) => loaded.job.idempotencyKey === request.idempotencyKey,
    );
    if (!candidate) return undefined;
    if (
      candidate.job.provisionalConversationId !== request.conversationId ||
      candidate.job.requestHash !== creatorWorkRequestHash(request)
    )
      throw new Error("Project identity idempotency key is bound to another exact request");
    return candidate;
  }

  private identityJobForStudio(
    studio: StudioBridgeSession,
  ): LoadedCreatorProjectIdentityJob | undefined {
    const forgeProjectId =
      studio.projectIdentity.reservedAttribute.status === "observed"
        ? studio.projectIdentity.reservedAttribute.forgeProjectId
        : undefined;
    const transactionOperationHash =
      studio.projectIdentityTransaction.status === "pending"
        ? studio.projectIdentityTransaction.operation.hash
        : studio.projectIdentityTransaction.status === "finalized"
          ? studio.projectIdentityTransaction.receipt.operation.hash
          : undefined;
    return [...this.identityJobs.values()]
      .filter(
        (loaded) =>
          loaded.job.pairedStudioSessionId === studio.sessionId ||
          (transactionOperationHash !== undefined &&
            loaded.job.operation.hash === transactionOperationHash) ||
          (forgeProjectId !== undefined && loaded.job.assignedForgeProjectId === forgeProjectId),
      )
      .sort((left, right) => right.job.updatedAt.localeCompare(left.job.updatedAt))[0];
  }

  private async recoverPersistedAgentBoundary(
    conversation: LoadedCreatorConversation,
    job: CreatorWorkJob,
    admitted: ConversationRequest,
  ): Promise<boolean> {
    let snapshot: Awaited<ReturnType<CreatorSessionCoordinator["conversationSnapshot"]>>;
    try {
      snapshot = await this.options.transaction.conversationSnapshot(
        requiredTransactionSessionId(job),
      );
    } catch {
      return false;
    }
    if (
      !snapshot.bundle.agentOutcome &&
      snapshot.bundle.agentRuns.length === 0 &&
      snapshot.bundle.session.status !== "incomplete"
    )
      return false;
    const request = await this.agentTurnRequestForJob(job, admitted);
    const priorEpisode = job.episodeId
      ? conversation.episodes.find((episode) => episode.id === job.episodeId)
      : undefined;
    const episode = await this.publishAgentOutcome({
      conversationId: conversation.conversation.id,
      creatorTurnId: requiredTurnId(job),
      request,
      snapshot: snapshot.bundle,
      ...(priorEpisode ? { priorEpisode } : {}),
      contextArtifact: job.conversationContext!,
    });
    this.sessionEpisodes.set(snapshot.bundle.session.id, {
      conversationId: conversation.conversation.id,
      episodeId: episode.id,
    });
    this.transactionHashes.set(snapshot.bundle.session.id, snapshot.bundle.session.hash);
    const run = await latestAgentRun(this.store, snapshot.bundle);
    const response = run ? exactResponseAttribution(run, request.selectedModelId) : undefined;
    const executionAssessment = await this.requireTerminalJobExecution(job);
    await this.updateJob(
      { request: admitted, jobId: job.id, conversationId: conversation.conversation.id },
      {
        status: snapshot.bundle.agentOutcome ? "succeeded" : "failed",
        phase: snapshot.bundle.session.status,
        providerOutcome: executionAssessment.providerOutcome,
        ...(response?.responseId ? { providerRequestId: response.responseId } : {}),
        ...(snapshot.bundle.agentOutcome
          ? {
              message:
                "A previously persisted provider result was deterministically published after restart.",
            }
          : agentRunFailure(run)),
      },
    );
    return true;
  }

  private async recoverPersistedAgentActionBoundary(
    conversation: LoadedCreatorConversation,
    job: CreatorWorkJob,
    admitted: ConversationRequest,
    assessment: JobExecutionAssessment,
  ): Promise<boolean> {
    if (job.jobType !== "agent_action" || admitted.kind !== "CreatorActionRequest") return false;
    if (
      assessment.kind === "provider_outcome_unknown" ||
      assessment.kind === "continuation_unavailable"
    )
      return false;
    const authority = await this.store.artifactStore.read(
      job.admissionAuthority,
      assertCreatorControlView,
    );
    const descriptor = assertCreatorActionRequestBinding(authority, admitted);
    const episode = job.episodeId
      ? conversation.episodes.find((candidate) => candidate.id === job.episodeId)
      : undefined;
    if (!episode) return false;
    let snapshot: Awaited<ReturnType<CreatorSessionCoordinator["conversationSnapshot"]>>;
    try {
      snapshot = await this.options.transaction.conversationSnapshot(episode.sessionBundle.id);
    } catch {
      return false;
    }
    if (
      assessment.kind === "never_dispatched" &&
      lowerActionStillEligible(descriptor.actionId, snapshot.bundle.session.status)
    )
      return false;

    if (descriptor.actionId === "refresh_project" && snapshot.bundle.successorSessionId) {
      if (assessment.kind !== "terminal") return false;
      const successor = await this.options.transaction.conversationSnapshot(
        snapshot.bundle.successorSessionId,
      );
      await this.publishRefreshSuccessor({
        execution: {
          request: admitted,
          jobId: job.id,
          conversationId: conversation.conversation.id,
        },
        job,
        predecessorEpisodeId: episode.id,
        predecessor: snapshot.bundle,
        successor: successor.bundle,
      });
      await this.updateJob(
        { request: admitted, jobId: job.id, conversationId: conversation.conversation.id },
        {
          status: successor.bundle.agentOutcome ? "succeeded" : "failed",
          phase: successor.bundle.session.status,
          providerOutcome: assessment.providerOutcome,
          ...(successor.bundle.agentOutcome
            ? {
                message:
                  "The terminal refresh journal and linked successor were reconstructed without redispatch.",
              }
            : agentRunFailure(await latestAgentRun(this.store, successor.bundle))),
        },
      );
      return true;
    }

    const awaitingExternal =
      (descriptor.actionId === "apply_changes" || descriptor.actionId === "retry_play") &&
      ["awaiting_verification", "verifying", "repairing"].includes(snapshot.bundle.session.status);
    const failed = ["incomplete", "recovery_required"].includes(snapshot.bundle.session.status);
    if (
      !awaitingExternal &&
      !failed &&
      assessment.kind === "never_dispatched" &&
      descriptor.actionId !== "refresh_project"
    )
      return false;
    await this.updateJob(
      { request: admitted, jobId: job.id, conversationId: conversation.conversation.id },
      {
        status: awaitingExternal ? "awaiting_external" : failed ? "failed" : "succeeded",
        phase: snapshot.bundle.session.status,
        providerOutcome: assessment.providerOutcome,
        message: awaitingExternal
          ? "The persisted transaction is awaiting its passive external boundary; no provider was redispatched."
          : failed
            ? "The persisted transaction ended at a durable failure boundary without provider redispatch."
            : "The terminal provider journal and lower transaction boundary were reconstructed without redispatch.",
        ...(failed ? { failureCode: "creator_transaction_failed" } : {}),
      },
    );
    return true;
  }

  private async canResumeExactAgentAction(
    conversation: LoadedCreatorConversation,
    job: CreatorWorkJob,
    admitted: ConversationRequest,
  ): Promise<boolean> {
    if (job.jobType !== "agent_action" || admitted.kind !== "CreatorActionRequest") return false;
    try {
      const authority = await this.store.artifactStore.read(
        job.admissionAuthority,
        assertCreatorControlView,
      );
      const descriptor = assertCreatorActionRequestBinding(authority, admitted);
      const episode = job.episodeId
        ? conversation.episodes.find((candidate) => candidate.id === job.episodeId)
        : undefined;
      if (!episode) return false;
      const snapshot = await this.options.transaction.conversationSnapshot(
        episode.sessionBundle.id,
      );
      return lowerActionStillEligible(descriptor.actionId, snapshot.bundle.session.status);
    } catch {
      return false;
    }
  }

  private async agentTurnRequestForJob(
    job: CreatorWorkJob,
    admitted: ConversationRequest,
  ): Promise<CreatorTurnRequest> {
    if (admitted.kind === "CreatorTurnRequest") return admitted;
    if (!job.selectedModelId || !admitted.input?.text)
      throw new Error("Refinement job lost its selected model or exact creator text");
    const authority = await this.store.artifactStore.read(
      job.admissionAuthority,
      assertCreatorControlView,
    );
    return {
      kind: "CreatorTurnRequest",
      conversationId: job.conversationId,
      turnContractId: authority.turnContract?.id ?? "turn_contract_refinement_action",
      turnContractHash: authority.turnContract?.hash ?? "0".repeat(64),
      turnKind: "plan_refinement",
      text: admitted.input.text,
      selectedModelId: job.selectedModelId,
      idempotencyKey: admitted.idempotencyKey,
    };
  }

  private async readAdmittedRequest(job: CreatorWorkJob): Promise<ConversationRequest> {
    const request = await this.store.artifactStore.read(job.admittedRequest);
    if (
      typeof request === "object" &&
      request !== null &&
      "kind" in request &&
      request.kind === "CreatorTurnRequest"
    )
      assertCreatorTurnRequest(request);
    else assertCreatorActionRequest(request);
    assertCreatorWorkJobRequestBinding(job, request);
    return request;
  }

  private async ensurePairedConversation(): Promise<LoadedCreatorConversation | undefined> {
    const studio = this.options.transaction.pairedStudio();
    if (!studio) return undefined;
    if (
      studio.project.placeId === 0 &&
      studio.project.universeId === 0 &&
      studio.projectIdentityTransaction.status === "pending"
    )
      return undefined;
    const identity = projectIdentity(studio);
    if (!identity) return undefined;
    const existing = [...this.loaded.values()].find(
      (candidate) => stableJson(candidate.conversation.project) === stableJson(identity),
    );
    if (existing) return existing;
    if (
      identity.kind === "published" &&
      studio.projectIdentity.reservedAttribute.status === "observed"
    ) {
      const embeddedForgeProjectId = studio.projectIdentity.reservedAttribute.forgeProjectId;
      const linkedLocal = [...this.loaded.values()].find(
        (candidate) =>
          candidate.conversation.project.kind === "local_linked" &&
          candidate.conversation.project.forgeProjectId === embeddedForgeProjectId,
      );
      if (linkedLocal) return linkedLocal;
    }
    const now = this.now();
    const id = `creator_conversation_${contentHash(stableJson(identity)).slice(0, 24)}`;
    return this.serialize(id, async () => {
      const liveStudio = this.options.transaction.pairedStudio();
      const liveIdentity = liveStudio ? projectIdentity(liveStudio) : undefined;
      if (!liveStudio || stableJson(liveIdentity) !== stableJson(identity)) return undefined;
      const alreadyLoaded = [...this.loaded.values()].find(
        (candidate) => stableJson(candidate.conversation.project) === stableJson(identity),
      );
      if (alreadyLoaded) return alreadyLoaded;
      const conversation = sealCreatorProjectConversation({
        id,
        project: identity,
        title: liveStudio.project.name,
        createdAt: now,
        updatedAt: now,
        latestEventSequence: 1,
        episodeIds: [],
        memoryHeads: [],
      });
      const event = sealCreatorConversationEvent({
        id: `creator_event_${randomUUID()}`,
        conversationId: id,
        sequence: 1,
        occurredAt: now,
        authority: "studio",
        attachments: [],
        eventType: "project_identity",
        data: {
          state: "linked",
          project: identity,
          message:
            identity.kind === "published"
              ? "Published Studio identity established this project conversation."
              : "The embedded Forge project identity established this durable conversation.",
        },
      });
      await this.store.append({ conversation, event, expectedHead: null });
      const loaded = await this.store.load(id);
      this.loaded.set(id, loaded);
      this.emit();
      return loaded;
    });
  }

  private async submitIdentityAction(request: CreatorActionRequest): Promise<CreatorWorkAdmission> {
    const replay = this.findIdempotentIdentityJob(request);
    if (replay) return identityAdmission(replay.job, this.now());
    const studio = this.options.transaction.pairedStudio();
    const pairedView = (await this.options.transaction.dashboardState()).pairedStudio;
    const cached = this.controlViews.get(request.conversationId);
    const view =
      cached?.id === request.viewId && cached.hash === request.viewHash
        ? cached
        : studio
          ? this.unlinkedProjectControlView(
              pairedView,
              controllingIdentityJob(this.identityJobForStudio(studio)),
            )
          : undefined;
    if (!studio || !view || view.id !== request.viewId || view.hash !== request.viewHash)
      throw new Error("Project identity action is stale or unavailable");
    const descriptor = view.actions.find(
      (candidate) => candidate.actionInstanceId === request.actionInstanceId,
    );
    if (
      !descriptor ||
      !["link_project", "fork_project", "resume_work", "cancel_recovery"].includes(
        descriptor.actionId,
      )
    )
      throw new Error("Project identity action is unavailable");
    const admitted = await this.serialize(request.conversationId, async () => {
      const existing = this.findIdempotentIdentityJob(request);
      if (existing) return existing;
      const liveStudio = this.options.transaction.pairedStudio();
      if (!liveStudio || liveStudio.sessionId !== studio.sessionId)
        throw new Error("Paired Studio changed before durable project identity admission");
      const liveView = await this.currentControlView(request.conversationId);
      if (liveView.id !== request.viewId || liveView.hash !== request.viewHash)
        throw new Error("Project identity action became stale before durable admission");
      const liveDescriptor = assertCreatorActionRequestBinding(liveView, request);
      if (
        !["link_project", "fork_project", "resume_work", "cancel_recovery"].includes(
          liveDescriptor.actionId,
        )
      )
        throw new Error("Project identity action is unavailable");
      const active = controllingIdentityJob(this.identityJobForStudio(liveStudio));
      const inventory = liveStudio.projectIdentityTransaction;
      let operation: StudioProjectIdentityOperation;
      let executionMode: CreatorProjectIdentityJob["executionMode"];
      let retainedReceipt: CreatorProjectIdentityJob["receipt"];
      if (
        liveDescriptor.actionId === "link_project" ||
        liveDescriptor.actionId === "fork_project"
      ) {
        if (inventory.status !== "none")
          throw new Error("Project identity transaction inventory must be clear before admission");
        if (active)
          throw new Error(
            "A project identity operation is already active for this paired Studio session",
          );
        operation = createStudioProjectIdentityOperation({
          action: liveDescriptor.actionId === "link_project" ? "link" : "fork",
          project: liveStudio.project,
          connectorEpoch: connectorEpoch(liveStudio),
          expectedIdentity: liveStudio.projectIdentity,
          assignedForgeProjectId: `forge_project_${randomUUID().replaceAll("-", "")}`,
        });
        executionMode = "initial";
      } else {
        if (!active) throw new Error("Project identity recovery has no durable foreground job");
        const priorOperation = await this.identityJobStore.artifactStore.read(
          active.job.operation.artifact,
          assertStudioProjectIdentityOperation,
        );
        if (
          liveDescriptor.actionId === "resume_work" &&
          identityJobCanRetry(active.job, liveStudio)
        ) {
          operation = createStudioProjectIdentityOperation({
            action: priorOperation.action,
            project: liveStudio.project,
            connectorEpoch: connectorEpoch(liveStudio),
            expectedIdentity: liveStudio.projectIdentity,
            assignedForgeProjectId: priorOperation.assignedForgeProjectId,
          });
          executionMode = "resume_undispatched";
        } else {
          operation = priorOperation;
          if (
            liveDescriptor.actionId === "cancel_recovery" &&
            inventory.status === "pending" &&
            inventory.phase === "opening" &&
            inventory.recordingState === "not_open"
          ) {
            executionMode = "recover_abandon";
          } else if (
            liveDescriptor.actionId === "cancel_recovery" &&
            inventory.status === "pending" &&
            inventory.phase !== "opening" &&
            inventory.recordingState === "open"
          ) {
            executionMode = "recover_cancel";
          } else if (
            liveDescriptor.actionId === "resume_work" &&
            inventory.status === "pending" &&
            inventory.phase === "finalizing" &&
            inventory.recordingState === "not_open"
          ) {
            executionMode = "recover_settle";
          } else if (
            liveDescriptor.actionId === "resume_work" &&
            inventory.status === "finalized"
          ) {
            executionMode = "finalize_receipt";
          } else if (
            liveDescriptor.actionId === "resume_work" &&
            inventory.status === "none" &&
            active.job.receipt
          ) {
            executionMode = "host_finalize";
            retainedReceipt = active.job.receipt;
          } else {
            throw new Error("Project identity recovery does not match the exact paired inventory");
          }
        }
      }
      const admittedRequest = await this.identityJobStore.artifactStore.write(request);
      const operationArtifact = await this.identityJobStore.artifactStore.write(operation);
      const now = this.now();
      const loaded = await this.identityJobStore.admit({
        id: `creator_identity_job_${randomUUID()}`,
        provisionalConversationId: request.conversationId,
        pairedStudioSessionId: liveStudio.sessionId,
        idempotencyKey: request.idempotencyKey,
        requestHash: creatorWorkRequestHash(request),
        admittedRequest,
        command: operation.action,
        executionMode,
        operation: binding(operation.id, operation.hash, operationArtifact),
        connectorEpoch: operation.connectorEpoch,
        expectedIdentityStateHash: operation.expectedIdentity.hash,
        assignedForgeProjectId: operation.assignedForgeProjectId,
        status: "queued",
        phase: "admitted",
        ...(retainedReceipt ? { receipt: retainedReceipt } : {}),
        createdAt: now,
        updatedAt: now,
      });
      this.identityJobs.set(loaded.job.id, loaded);
      return loaded;
    });
    this.scheduleIdentityJob(admitted.job.id);
    this.emit();
    return identityAdmission(admitted.job, this.now());
  }

  private scheduleIdentityJob(jobId: string): void {
    this.track(Promise.resolve().then(() => this.executeIdentityJob(jobId)));
  }

  private async executeIdentityJob(jobId: string): Promise<void> {
    let current = this.identityJobs.get(jobId);
    if (!current) return;
    let initialDispatchStarted = false;
    try {
      current = await this.transitionIdentityJob(jobId, {
        status: "running",
        phase: "dispatch_intent_persisted",
        updatedAt: this.now(),
      });
      const operation = await this.identityJobStore.artifactStore.read(
        current.job.operation.artifact,
        assertStudioProjectIdentityOperation,
      );
      const studio = this.options.transaction.pairedStudio();
      if (!studio)
        throw new Error("Studio disconnected after identity dispatch intent was durable");
      if (studio.sessionId !== current.job.pairedStudioSessionId)
        throw new Error(
          "Paired Studio changed before identity command dispatch; no command was sent",
        );
      if (
        current.job.executionMode === "initial" ||
        current.job.executionMode === "resume_undispatched"
      ) {
        if (
          connectorEpoch(studio) !== operation.connectorEpoch ||
          studio.projectIdentity.hash !== operation.expectedIdentity.hash ||
          studio.projectIdentityTransaction.status !== "none"
        )
          throw new Error(
            "Project identity or transaction inventory changed before dispatch; no command was sent",
          );
        const requestId = operation.id;
        initialDispatchStarted = true;
        await this.options.connection.sendAndWaitForSettlement(
          createBackendMessage(
            operation.action === "link" ? "LinkStudioProject" : "ForkStudioProject",
            { requestId, operation, operationHash: operation.hash },
            studio.sessionId,
            requestId,
          ),
          this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      } else if (current.job.executionMode === "recover_abandon") {
        const inventory = studio.projectIdentityTransaction;
        if (
          inventory.status !== "pending" ||
          inventory.phase !== "opening" ||
          inventory.recordingState !== "not_open"
        )
          throw new Error("Opening identity intent no longer has exact no-recording proof");
        const requestId = current.job.id;
        await this.options.connection.sendAndWaitForSettlement(
          createBackendMessage(
            "AbandonOpeningStudioProjectIdentity",
            {
              requestId,
              operationId: operation.id,
              operationHash: operation.hash,
              transactionCursorHash: inventory.cursorHash,
              expectedIdentityStateHash: studio.projectIdentity.hash,
            },
            studio.sessionId,
            requestId,
          ),
          this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      } else if (current.job.executionMode === "recover_cancel") {
        const inventory = studio.projectIdentityTransaction;
        if (
          inventory.status !== "pending" ||
          inventory.phase === "opening" ||
          inventory.recordingState !== "open" ||
          !inventory.recordingId
        )
          throw new Error("Open identity recording is no longer exactly proven");
        const requestId = current.job.id;
        await this.options.connection.sendAndWaitForSettlement(
          createBackendMessage(
            "CancelInterruptedStudioProjectIdentity",
            {
              requestId,
              operationId: operation.id,
              operationHash: operation.hash,
              transactionCursorHash: inventory.cursorHash,
              recordingId: inventory.recordingId,
              expectedIdentityStateHash: studio.projectIdentity.hash,
            },
            studio.sessionId,
            requestId,
          ),
          this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      } else if (current.job.executionMode === "recover_settle") {
        const inventory = studio.projectIdentityTransaction;
        if (
          inventory.status !== "pending" ||
          inventory.phase !== "finalizing" ||
          inventory.recordingState !== "not_open" ||
          !inventory.recordingId ||
          !inventory.finalization
        )
          throw new Error("Closed identity recording cursor is no longer exactly proven");
        const requestId = current.job.id;
        await this.options.connection.sendAndWaitForSettlement(
          createBackendMessage(
            "SettleClosedStudioProjectIdentity",
            {
              requestId,
              operationId: operation.id,
              operationHash: operation.hash,
              transactionCursorHash: inventory.cursorHash,
              recordingId: inventory.recordingId,
              expectedIdentityStateHash: studio.projectIdentity.hash,
              expectedFinalization: inventory.finalization,
            },
            studio.sessionId,
            requestId,
          ),
          this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      }

      const afterCommand = this.options.transaction.pairedStudio();
      let receipt: StudioProjectIdentityFinalizationReceipt | undefined;
      if (current.job.executionMode === "host_finalize" && current.job.receipt) {
        receipt = (await this.identityJobStore.artifactStore.read(
          current.job.receipt.artifact,
        )) as StudioProjectIdentityFinalizationReceipt;
      } else if (afterCommand?.projectIdentityTransaction.status === "finalized") {
        receipt = afterCommand.projectIdentityTransaction.receipt;
      }
      assertIdentityReceipt(receipt, operation.hash);
      const receiptArtifact = await this.identityJobStore.artifactStore.write(receipt);
      const receiptBinding = binding(receipt.id, receipt.hash, receiptArtifact);
      current = await this.transitionIdentityJob(jobId, {
        status: "awaiting_external",
        phase: "receipt_persisted",
        receipt: receiptBinding,
        updatedAt: this.now(),
      });

      let resultConversationId: string | undefined;
      if (receipt.status === "linked" || receipt.status === "forked") {
        const conversation = await this.ensurePairedConversation();
        if (!conversation)
          throw new Error("Committed identity did not establish its durable project conversation");
        await this.appendIdentityReceipt(conversation, receipt, receiptArtifact);
        resultConversationId = conversation.conversation.id;
        current = await this.transitionIdentityJob(jobId, {
          status: "awaiting_external",
          phase: "conversation_published",
          receipt: receiptBinding,
          resultConversationId,
          updatedAt: this.now(),
        });
      }

      const settledStudio = this.options.transaction.pairedStudio();
      if (
        current.job.executionMode !== "host_finalize" ||
        settledStudio?.projectIdentityTransaction.status === "finalized"
      ) {
        if (!settledStudio) throw new Error("Studio disconnected before identity acknowledgement");
        current = await this.transitionIdentityJob(jobId, {
          status: "awaiting_external",
          phase: "acknowledgement_pending",
          receipt: receiptBinding,
          ...(resultConversationId ? { resultConversationId } : {}),
          updatedAt: this.now(),
        });
        const requestId = current.job.id;
        await this.options.connection.sendAndWaitForSettlement(
          createBackendMessage(
            "AcknowledgeStudioProjectIdentityFinalization",
            { requestId, receiptId: receipt.id, receiptHash: receipt.hash },
            settledStudio.sessionId,
            requestId,
          ),
          this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      }
      const recoveredCancellation =
        receipt.status === "cancelled" &&
        ["recovery_abandon", "recovery_cancel"].includes(receipt.finalization);
      await this.transitionIdentityJob(jobId, {
        status: receipt.status === "cancelled" && !recoveredCancellation ? "failed" : "succeeded",
        phase:
          receipt.status === "cancelled" && !recoveredCancellation
            ? "identity_transaction_failed"
            : "acknowledged",
        receipt: receiptBinding,
        ...(resultConversationId ? { resultConversationId } : {}),
        ...(receipt.status === "cancelled" && !recoveredCancellation
          ? {
              failure: {
                code: "identity_transaction_cancelled",
                detail: boundedError(receipt.failureDetail ?? "Identity transaction cancelled"),
                detailHash: contentHash(
                  boundedError(receipt.failureDetail ?? "Identity transaction cancelled"),
                ),
              },
            }
          : {}),
        updatedAt: this.now(),
      });
    } catch (error) {
      const latest = this.identityJobs.get(jobId);
      if (!latest || ["succeeded", "failed", "outcome_unknown"].includes(latest.job.status)) return;
      if (latest.job.status === "awaiting_external") {
        // The exact durable boundary is already sufficient for explicit
        // recovery. Never advance the journal merely because a later boundary
        // failed: doing so could label an un-published successful Link/Fork as
        // acknowledgement-pending and strand its conversation evidence.
        return;
      }
      const detail = boundedError(error);
      const rejection =
        error instanceof StudioCommandRejectedError &&
        (error.command.type === "LinkStudioProject" || error.command.type === "ForkStudioProject")
          ? { command: error.command, settlement: error.settlement }
          : undefined;
      const provenNoEffect =
        rejection !== undefined &&
        error instanceof StudioCommandRejectedError &&
        error.identityNoEffectProven;
      const neverDispatched =
        !initialDispatchStarted &&
        (latest.job.executionMode === "initial" ||
          latest.job.executionMode === "resume_undispatched");
      await this.transitionIdentityJob(jobId, {
        status: provenNoEffect || neverDispatched ? "failed" : "outcome_unknown",
        phase: provenNoEffect
          ? "command_rejected"
          : neverDispatched
            ? "resume_required"
            : "studio_outcome_unknown",
        failure: {
          code: provenNoEffect
            ? "studio_identity_rejected"
            : neverDispatched
              ? "identity_dispatch_not_started"
              : "studio_identity_outcome_unknown",
          detail,
          detailHash: contentHash(detail),
          ...(rejection ? { rejection } : {}),
        },
        updatedAt: this.now(),
      });
    }
  }

  private async appendIdentityReceipt(
    conversation: LoadedCreatorConversation,
    receipt: StudioProjectIdentityFinalizationReceipt,
    receiptArtifact: ArtifactReference,
  ): Promise<void> {
    if (
      conversation.events.some((event) =>
        event.attachments.some((attachment) => attachment.binding.hash === receipt.hash),
      )
    )
      return;
    await this.serialize(conversation.conversation.id, async () => {
      const loaded = await this.load(conversation.conversation.id);
      if (
        loaded.events.some((event) =>
          event.attachments.some((attachment) => attachment.binding.hash === receipt.hash),
        )
      )
        return;
      await this.append(loaded, {
        authority: "studio",
        eventType: "project_identity",
        data: {
          state: receipt.status === "forked" ? "forked" : "linked",
          project: loaded.conversation.project,
          message: "Studio committed and directly read back the embedded project identity.",
        },
        attachments: [
          {
            role: "project_identity",
            label: "Project identity receipt",
            binding: binding(receipt.id, receipt.hash, receiptArtifact),
          },
        ],
      });
    });
  }

  private async executePublishedContinuity(
    execution: WorkExecution,
    running: CreatorWorkJob,
    descriptor: CreatorControlActionDescriptor,
    request: CreatorActionRequest,
  ): Promise<void> {
    const loaded = await this.load(request.conversationId);
    const studio = this.options.transaction.pairedStudio();
    const published = publishedContinuityTarget(studio, loaded);
    if (!studio || !published || loaded.conversation.project.kind !== "local_linked")
      throw new Error("Published identity continuity is stale or unavailable");
    const receipt = sealCreatorPublishedIdentityContinuityReceipt({
      id: `creator_published_continuity_${randomUUID()}`,
      choice:
        descriptor.actionId === "continue_published_project"
          ? "continue_conversation"
          : "start_new_conversation",
      sourceConversationId: loaded.conversation.id,
      sourceConversationHash: loaded.conversation.hash,
      localIdentity: loaded.conversation.project,
      publishedIdentity: published,
      controlViewId: request.viewId,
      controlViewHash: request.viewHash,
      actionInstanceId: request.actionInstanceId,
      requestHash: creatorWorkRequestHash(request),
      createdAt: this.now(),
    });
    const receiptArtifact = await this.store.artifactStore.write(receipt);
    const attachment: CreatorConversationAttachment = {
      role: "project_identity",
      label: "Published identity continuity choice",
      binding: binding(receipt.id, receipt.hash, receiptArtifact),
    };
    const continuityReceipt = attachment.binding;
    if (descriptor.actionId === "continue_published_project") {
      await this.serialize(loaded.conversation.id, async () => {
        const current = await this.load(loaded.conversation.id);
        await this.append(current, {
          authority: "creator",
          eventType: "project_identity",
          projectIdentityTransition: published,
          data: {
            state: "published_continuity",
            project: published,
            continuityReceipt,
            message:
              "The creator explicitly continued this conversation under the published universe/place identity.",
          },
          attachments: [attachment],
        });
      });
    } else {
      const existingPublished = [...this.loaded.values()].find(
        (candidate) => stableJson(candidate.conversation.project) === stableJson(published),
      );
      if (existingPublished)
        throw new Error(
          "Published project conversation already exists; continuity choice is stale",
        );
      const now = this.now();
      const conversationId = `creator_conversation_${contentHash(stableJson(published)).slice(0, 24)}`;
      const conversation = sealCreatorProjectConversation({
        id: conversationId,
        project: published,
        title: studio.project.name,
        createdAt: now,
        updatedAt: now,
        latestEventSequence: 1,
        episodeIds: [],
        memoryHeads: [],
      });
      const event = sealCreatorConversationEvent({
        id: `creator_event_${randomUUID()}`,
        conversationId,
        sequence: 1,
        occurredAt: now,
        authority: "creator",
        attachments: [attachment],
        eventType: "project_identity",
        data: {
          state: "published_new",
          project: published,
          continuityReceipt,
          message:
            "The creator explicitly started a separate conversation for the published universe/place identity.",
        },
      });
      await this.store.append({ conversation, event, expectedHead: null });
      this.loaded.set(conversationId, await this.store.load(conversationId));
      await this.serialize(loaded.conversation.id, async () => {
        const current = await this.load(loaded.conversation.id);
        await this.append(current, {
          authority: "creator",
          eventType: "project_identity",
          data: {
            state: "published_new",
            project: published,
            continuityReceipt,
            message:
              "The creator kept this local conversation separate from the newly published project conversation.",
          },
          attachments: [attachment],
        });
      });
    }
    await this.updateJob(execution, {
      status: "succeeded",
      phase: descriptor.actionId,
      providerOutcome: running.providerOutcome,
      message: "The explicit published-project continuity choice is durably recorded.",
    });
  }

  private async transitionIdentityJob(
    jobId: string,
    update: Parameters<CreatorProjectIdentityJobStore["transition"]>[1],
  ): Promise<LoadedCreatorProjectIdentityJob> {
    const loaded = await this.identityJobStore.transition(jobId, update);
    this.identityJobs.set(jobId, loaded);
    this.emit();
    return loaded;
  }

  private async materializeControlView(
    conversation: LoadedCreatorConversation,
    transactionView?: TransactionControlView,
  ): Promise<CreatorControlView> {
    const continuityView = this.publishedContinuityControlView(conversation);
    if (continuityView) return continuityView;
    if (!conversationMatchesStudio(conversation, this.options.transaction.pairedStudio())) {
      const episode = latestEpisode(conversation);
      const activity = activeActivity(conversation);
      return sealCreatorControlView({
        id: `creator_control_${contentHash(
          stableJson({
            conversationHash: conversation.conversation.hash,
            pairedProject: this.options.transaction.pairedStudio()?.projectIdentity.hash ?? null,
            purpose: "historical_read_only",
          }),
        ).slice(0, 24)}`,
        conversationId: conversation.conversation.id,
        conversationHash: conversation.conversation.hash,
        eventSequence: conversation.conversation.latestEventSequence,
        ...(episode ? { episodeId: episode.id } : {}),
        status: activity.activeActivity ? "working" : controlStatusForEpisode(episode),
        title: "Open this project to continue",
        detail: "Open this place in Studio and connect Forge to continue chatting.",
        actions: [],
        ...activity,
        technicalAttachments: [],
      });
    }
    const cached = this.controlViews.get(conversation.conversation.id);
    const projectScope = contentHash(
      stableJson(
        [...this.loaded.values()]
          .filter(
            (item) =>
              stableJson(item.conversation.project) ===
              stableJson(conversation.conversation.project),
          )
          .map((item) => item.conversation.hash)
          .sort(),
      ),
    );
    if (
      cached &&
      this.controlProjectScopes.get(conversation.conversation.id) === projectScope &&
      cached.eventSequence === conversation.conversation.latestEventSequence &&
      (transactionView
        ? cached.technicalAttachments.some((item) => item.binding.hash === transactionView.hash)
        : !cached.technicalAttachments.some((item) => item.label === "Transaction control binding"))
    )
      return cached;
    this.controlProjectScopes.set(conversation.conversation.id, projectScope);
    const episode = latestEpisode(conversation);
    const latestEvent = conversation.events.at(-1)!;
    const id = `creator_control_${randomUUID()}`;
    const projectBusy = [...this.loaded.values()].find(
      (other) =>
        other.conversation.id !== conversation.conversation.id &&
        stableJson(other.conversation.project) === stableJson(conversation.conversation.project) &&
        (hasUnfinishedAgentWork(other) ||
          (latestEpisode(other) &&
            !["accepted", "rejected", "incomplete", "superseded"].includes(
              latestEpisode(other)!.status,
            ))),
    );
    const pairedStudio = this.options.transaction.pairedStudio();
    const interruptedAgentWork = agentRecoveryCandidate(conversation);
    const activity = activeActivity(conversation);
    const workOwnsControl = activity.activeActivity !== undefined;
    const canForkLocalProject =
      conversation.conversation.project.kind === "local_linked" &&
      pairedStudio?.project.placeId === 0 &&
      pairedStudio.project.universeId === 0 &&
      pairedStudio.projectIdentity.reservedAttribute.status === "observed" &&
      pairedStudio.projectIdentity.reservedAttribute.forgeProjectId ===
        conversation.conversation.project.forgeProjectId &&
      pairedStudio.projectIdentityTransaction.status === "none" &&
      !controllingIdentityJob(this.identityJobForStudio(pairedStudio)) &&
      (!transactionView || controlStatus(transactionView.status) === "terminal");
    const actions = [
      descriptor(id, latestEvent, "new_conversation", "New conversation", "secondary", {
        kind: "none",
      }),
      ...(transactionView && !workOwnsControl && !interruptedAgentWork && !projectBusy
        ? actionDescriptors(id, latestEvent, transactionView)
        : []),
      ...(canForkLocalProject && !workOwnsControl && !interruptedAgentWork
        ? [
            {
              actionInstanceId: `creator_action_${contentHash(`${id}:fork_project:${pairedStudio.projectIdentity.hash}`).slice(0, 24)}`,
              actionId: "fork_project" as const,
              label: "Give this place a separate project identity",
              intent: "secondary" as const,
              controlViewId: id,
              authorizingEventId: latestEvent.id,
              authorizingEventHash: latestEvent.hash,
              target: "none" as const,
              input: { kind: "none" as const },
            },
          ]
        : []),
      ...(interruptedAgentWork
        ? [
            descriptor(
              id,
              latestEvent,
              interruptedAgentWork.actionId,
              interruptedAgentWork.actionId === "resume_work" ? "Resume work" : "Try again",
              "primary",
              { kind: "none" },
            ),
          ]
        : []),
      ...memoryActionDescriptors(id, latestEvent, conversation),
    ].slice(0, 16);
    const allowedTurns =
      interruptedAgentWork || workOwnsControl || projectBusy
        ? ([] as const)
        : turnTypesForEpisode(episode);
    const turnContract =
      allowedTurns.length > 0
        ? sealCreatorTurnContract({
            id: `creator_turn_contract_${randomUUID()}`,
            conversationId: conversation.conversation.id,
            ...(episode
              ? { episodeId: episode.id, projectRevisionHash: episode.currentProjectRevisionHash }
              : {}),
            allowedTurnTypes: allowedTurns,
            replyToEventId: latestEvent.id,
            ...(episode?.planRevision
              ? {
                  planRevisionId: episode.planRevision.id,
                  planRevisionHash: episode.planRevision.hash,
                }
              : {}),
            modelRegistryHash: this.modelRegistry.hash,
            minimumBytes: 1,
            maximumBytes: MAX_TURN_BYTES,
            issuedAt: this.now(),
          })
        : undefined;
    return sealCreatorControlView({
      id,
      conversationId: conversation.conversation.id,
      conversationHash: conversation.conversation.hash,
      eventSequence: conversation.conversation.latestEventSequence,
      ...(episode ? { episodeId: episode.id } : {}),
      status: projectBusy
        ? "blocked"
        : workOwnsControl
          ? "working"
          : transactionView
            ? controlStatus(transactionView.status)
            : controlStatusForEpisode(episode),
      title:
        (projectBusy ? "Another conversation is using this project" : undefined) ??
        transactionView?.title ??
        (episode ? "Project conversation" : "What would you like to make?"),
      detail:
        (projectBusy
          ? `Finish the current step in “${conversationTitle(projectBusy)}” before sending a message here.`
          : undefined) ??
        transactionView?.detail ??
        (episode
          ? "Continue working on this project."
          : "Ask about this place or describe a change. Forge will inspect it before proposing work."),
      ...(turnContract ? { turnContract } : {}),
      actions,
      ...activity,
      technicalAttachments: transactionView
        ? [
            ...(await technicalAttachmentsFromView(transactionView, this.store)),
            {
              role: "technical_detail",
              label: "Transaction control binding",
              binding: {
                id: transactionView.id,
                hash: transactionView.hash,
                artifact: await this.store.artifactStore.write(transactionView),
              },
            },
          ]
        : [],
    });
  }

  private publishedContinuityControlView(
    conversation: LoadedCreatorConversation,
  ): CreatorControlView | undefined {
    const studio = this.options.transaction.pairedStudio();
    const published = publishedContinuityTarget(studio, conversation);
    if (!studio || !published) return undefined;
    const latestEvent = conversation.events.at(-1)!;
    const id = `creator_control_${contentHash(
      stableJson({
        conversationHash: conversation.conversation.hash,
        projectIdentityHash: studio.projectIdentity.hash,
        purpose: "published_continuity",
      }),
    ).slice(0, 24)}`;
    const activity = activeActivity(conversation);
    const actions = activity.activeActivity
      ? []
      : [
          descriptor(
            id,
            latestEvent,
            "continue_published_project",
            "Continue this conversation",
            "primary",
            { kind: "none" },
          ),
          descriptor(
            id,
            latestEvent,
            "start_published_project",
            "Start a new conversation",
            "secondary",
            { kind: "none" },
          ),
        ];
    return sealCreatorControlView({
      id,
      conversationId: conversation.conversation.id,
      conversationHash: conversation.conversation.hash,
      eventSequence: conversation.conversation.latestEventSequence,
      status: activity.activeActivity ? "working" : "awaiting_creator",
      title: "This linked place is now published",
      detail:
        "Choose explicitly whether the published universe/place identity continues this local conversation or starts a separate one. Forge never infers continuity from the filename.",
      actions,
      ...activity,
      technicalAttachments: [],
    });
  }

  private unlinkedProjectControlView(
    paired: Awaited<ReturnType<CreatorSessionCoordinator["dashboardState"]>>["pairedStudio"],
    activeIdentityJob?: LoadedCreatorProjectIdentityJob,
  ): CreatorControlView | undefined {
    const studio = this.options.transaction.pairedStudio();
    if (!studio || studio.project.placeId !== 0 || studio.project.universeId !== 0)
      return undefined;
    const identity = studio.projectIdentity.reservedAttribute;
    if (identity.status === "observed" && !activeIdentityJob) return undefined;
    const epoch = connectorEpoch(studio);
    const conversationId =
      activeIdentityJob?.job.provisionalConversationId ??
      `pairing_${contentHash(epoch).slice(0, 24)}`;
    const authorityHash = contentHash(
      stableJson({
        connectorEpoch: epoch,
        ...(activeIdentityJob ? { jobHash: activeIdentityJob.job.hash } : {}),
        projectIdentityHash: studio.projectIdentity.hash,
        transaction: studio.projectIdentityTransaction,
      }),
    );
    const id = `creator_control_${contentHash(`${studio.projectIdentity.hash}:${authorityHash}`).slice(0, 24)}`;
    let actionId: CreatorControlActionDescriptor["actionId"] | undefined;
    let label = "Link project";
    if (!activeIdentityJob) {
      actionId =
        identity.status === "absent" && studio.projectIdentityTransaction.status === "none"
          ? "link_project"
          : undefined;
    } else if (identityJobCanRetry(activeIdentityJob.job, studio)) {
      actionId = "resume_work";
      label =
        activeIdentityJob.job.phase === "command_rejected"
          ? activeIdentityJob.job.command === "fork"
            ? "Retry forking"
            : "Retry linking"
          : activeIdentityJob.job.command === "fork"
            ? "Resume forking"
            : "Resume linking";
    } else if (
      studio.projectIdentityTransaction.status === "pending" &&
      ((studio.projectIdentityTransaction.phase === "opening" &&
        studio.projectIdentityTransaction.recordingState === "not_open" &&
        studio.projectIdentity.hash ===
          studio.projectIdentityTransaction.operation.expectedIdentity.hash) ||
        (studio.projectIdentityTransaction.phase !== "opening" &&
          studio.projectIdentityTransaction.recordingState === "open"))
    ) {
      actionId = "cancel_recovery";
      label =
        studio.projectIdentityTransaction.phase === "opening"
          ? "Abandon interrupted identity intent"
          : "Cancel interrupted link";
    } else if (
      studio.projectIdentityTransaction.status === "finalized" ||
      (studio.projectIdentityTransaction.status === "pending" &&
        studio.projectIdentityTransaction.phase === "finalizing" &&
        studio.projectIdentityTransaction.recordingState === "not_open") ||
      (studio.projectIdentityTransaction.status === "none" && activeIdentityJob.job.receipt)
    ) {
      actionId = "resume_work";
      label = "Finish identity recovery";
    }
    const actions: CreatorControlActionDescriptor[] = actionId
      ? [
          {
            actionInstanceId: `creator_action_${contentHash(`${id}:${actionId}`).slice(0, 24)}`,
            actionId,
            label,
            intent: actionId === "cancel_recovery" ? "danger" : "primary",
            controlViewId: id,
            authorizingEventId:
              activeIdentityJob?.job.id ??
              `project_identity_${studio.projectIdentity.hash.slice(0, 24)}`,
            authorizingEventHash: authorityHash,
            target: "none",
            input: { kind: "none" },
          },
        ]
      : [];
    return sealCreatorControlView({
      id,
      conversationId,
      conversationHash: authorityHash,
      eventSequence: 0,
      status:
        identity.status === "invalid"
          ? "blocked"
          : activeIdentityJob && ["queued", "running"].includes(activeIdentityJob.job.status)
            ? "working"
            : activeIdentityJob &&
                ["awaiting_external", "outcome_unknown"].includes(activeIdentityJob.job.status)
              ? "recovery_required"
              : "awaiting_creator",
      title:
        identity.status === "invalid"
          ? "Reserved project identity is invalid"
          : activeIdentityJob?.job.status === "queued"
            ? "Project link queued"
            : activeIdentityJob?.job.status === "running"
              ? "Linking this project"
              : activeIdentityJob?.job.phase === "command_rejected"
                ? `Studio rejected project ${activeIdentityJob.job.command === "fork" ? "forking" : "linking"}`
                : activeIdentityJob
                  ? "Project identity needs attention"
                  : "Link this project",
      detail:
        identity.status === "invalid"
          ? "Remove the invalid reserved attribute in Studio before linking. Forge will not guess or overwrite it."
          : activeIdentityJob
            ? identityJobDetail(activeIdentityJob.job, studio)
            : `${paired.message} Linking creates one visible ChangeHistory recording and direct readback receipt.`,
      actions,
      ...(activeIdentityJob && !["succeeded", "failed"].includes(activeIdentityJob.job.status)
        ? {
            activeActivity: {
              jobId: activeIdentityJob.job.id,
              status: activeIdentityJob.job.status,
              phase: activeIdentityJob.job.phase,
              message: boundedError(identityJobDetail(activeIdentityJob.job, studio)),
              startedAt: activeIdentityJob.job.createdAt,
            },
          }
        : {}),
      technicalAttachments: activeIdentityJob
        ? [
            {
              role: "project_identity",
              label: "Project identity job",
              binding: {
                id: activeIdentityJob.job.id,
                hash: activeIdentityJob.job.hash,
                artifact: activeIdentityJob.head.snapshot,
              },
            },
            {
              role: "project_identity",
              label: "Approved identity operation",
              binding: activeIdentityJob.job.operation,
            },
          ]
        : [],
    });
  }

  private async currentControlView(conversationId: string): Promise<CreatorControlView> {
    const state = await this.dashboardState(conversationId);
    if (!state.controlView) throw new Error("Conversation has no current control view");
    return state.controlView;
  }

  private eventPage(
    conversation: LoadedCreatorConversation,
    before: string | undefined,
    limit: number,
  ): CreatorConversationEventPage {
    const boundary = before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
    if (!Number.isSafeInteger(boundary) || boundary < 1)
      throw new Error("Conversation event cursor is invalid");
    const eligible = conversation.events.filter((event) => event.sequence < boundary);
    const events = eligible.slice(Math.max(0, eligible.length - limit));
    return {
      conversationId: conversation.conversation.id,
      events,
      ...(before ? { beforeCursor: before } : {}),
      ...(events[0] && events[0].sequence > 1
        ? { nextBeforeCursor: String(events[0].sequence) }
        : {}),
      complete: events.length === 0 || events[0]!.sequence === 1,
    };
  }

  private async append(
    loaded: LoadedCreatorConversation,
    input: AppendEventWithoutConversation,
  ): Promise<LoadedCreatorConversation> {
    const occurredAt = this.now();
    const sequence = loaded.head.sequence + 1;
    const introducesEpisode =
      input.episode !== undefined && !loaded.conversation.episodeIds.includes(input.episode.id);
    const episodeIds =
      introducesEpisode && input.episode
        ? [...loaded.conversation.episodeIds, input.episode.id]
        : loaded.conversation.episodeIds;
    const memoryHeads = input.memoryRevision
      ? nextMemoryHeads(loaded.conversation.memoryHeads, input.memoryRevision)
      : loaded.conversation.memoryHeads;
    const conversation = sealCreatorProjectConversation({
      ...withoutRecordIdentity(loaded.conversation),
      updatedAt: occurredAt,
      latestEventSequence: sequence,
      episodeIds,
      memoryHeads,
      ...(input.projectIdentityTransition ? { project: input.projectIdentityTransition } : {}),
      ...(introducesEpisode && input.episode
        ? { activeEpisodeId: input.episode.id }
        : loaded.conversation.activeEpisodeId
          ? { activeEpisodeId: loaded.conversation.activeEpisodeId }
          : input.episode
            ? { activeEpisodeId: input.episode.id }
            : {}),
    });
    const event = sealCreatorConversationEvent({
      id: input.eventId ?? `creator_event_${randomUUID()}`,
      conversationId: conversation.id,
      sequence,
      occurredAt,
      authority: input.authority,
      ...(input.projectRevisionHash ? { projectRevisionHash: input.projectRevisionHash } : {}),
      ...(input.episodeId ? { episodeId: input.episodeId } : {}),
      ...(input.binding ? { binding: input.binding } : {}),
      attachments: input.attachments,
      eventType: input.eventType,
      data: input.data,
    } as CreatorConversationEvent);
    await this.store.append({
      conversation,
      event,
      ...(input.episode ? { episode: input.episode } : {}),
      ...(input.turn ? { turn: input.turn } : {}),
      ...(input.planRevision ? { planRevision: input.planRevision } : {}),
      ...(input.memoryRevision ? { memoryRevision: input.memoryRevision } : {}),
      ...(input.job ? { job: input.job } : {}),
      expectedHead: { sequence: loaded.head.sequence, commitHash: loaded.head.commitHash },
    });
    const next = await this.store.load(conversation.id);
    this.loaded.set(conversation.id, next);
    this.controlViews.delete(conversation.id);
    this.emit();
    return next;
  }

  private async load(conversationId: string): Promise<LoadedCreatorConversation> {
    const loaded = await this.store.load(conversationId);
    this.loaded.set(conversationId, loaded);
    return loaded;
  }

  private async writeSessionSnapshot(bundle: CreatorSessionBundle): Promise<ArtifactReference> {
    return this.store.artifactStore.write({
      kind: "CreatorSessionEvidenceSnapshot",
      id: bundle.session.id,
      sessionHash: bundle.session.hash,
      capturedAt: this.now(),
      bundle,
    });
  }

  private async materializeConversationContext(
    loaded: LoadedCreatorConversation,
    request: CreatorTurnRequest,
    currentTurnId: string,
  ): Promise<{
    artifact: ArtifactReference;
    modelPrompt: string;
    contextCitations: readonly CreatorAgentContextCitation[];
  }> {
    const maximumUtf8Bytes = 128 * 1024;
    const allActiveMemories = memorySummaries(this.projectMemoryOwner(loaded)).filter(
      (memory) => memory.state === "active",
    );
    const activeMemoryCandidates = allActiveMemories.slice(0, 32);
    const allPriorTurns = loaded.turns.filter((turn) => turn.id !== currentTurnId);
    const turnCandidates = allPriorTurns.slice(-20).map((turn) => ({
      id: turn.id,
      hash: turn.hash,
      role: turn.role,
      text: turn.text,
      ...(turn.role === "agent"
        ? {
            outcome: turn.outcome,
            citations: turn.citations.map((citation) => ({
              id: citation.id,
              hash: citation.hash,
              handle: citation.handle,
              target: citation.target,
            })),
          }
        : { turnType: turn.turnType }),
    }));
    const allDecisionEvents = loaded.events.filter((event) => event.eventType === "decision");
    const decisionCandidates = allDecisionEvents
      .slice(-20)
      .map((event) => ({ id: event.id, hash: event.hash, data: event.data }));
    const allPriorEvidence = loaded.events.flatMap((event) =>
      event.attachments.map((attachment) => ({
        eventId: event.id,
        eventHash: event.hash,
        evidence: attachment.binding,
        label: attachment.label,
      })),
    );
    const priorEvidenceCandidates = allPriorEvidence.slice(-32);
    const context: {
      kind: "CreatorConversationContext";
      conversationId: string;
      project: CreatorProjectIdentity;
      currentProjectRevisionHash?: string;
      selectedModelId: string;
      includedMemories: typeof activeMemoryCandidates;
      priorDecisions: typeof decisionCandidates;
      priorEvidence: typeof priorEvidenceCandidates;
      priorTurns: typeof turnCandidates;
      contextCitations: readonly CreatorAgentContextCitation[];
      currentTurn: { kind: CreatorTurnRequest["turnKind"]; text: string };
      budgets: {
        maximumPriorTurns: number;
        maximumDecisions: number;
        maximumMemories: number;
        maximumPriorEvidence: number;
        maximumUtf8Bytes: number;
        omittedPriorTurns: number;
        omittedDecisions: number;
        omittedMemories: number;
        omittedPriorEvidence: number;
      };
    } = {
      kind: "CreatorConversationContext",
      conversationId: loaded.conversation.id,
      project: loaded.conversation.project,
      ...(latestEpisode(loaded)?.currentProjectRevisionHash
        ? { currentProjectRevisionHash: latestEpisode(loaded)!.currentProjectRevisionHash }
        : {}),
      selectedModelId: request.selectedModelId,
      includedMemories: [],
      priorDecisions: [],
      priorEvidence: [],
      priorTurns: [],
      contextCitations: [],
      currentTurn: { kind: request.turnKind, text: request.text },
      budgets: {
        maximumPriorTurns: 20,
        maximumDecisions: 20,
        maximumMemories: 32,
        maximumPriorEvidence: 32,
        maximumUtf8Bytes,
        omittedPriorTurns: allPriorTurns.length,
        omittedDecisions: allDecisionEvents.length,
        omittedMemories: allActiveMemories.length,
        omittedPriorEvidence: allPriorEvidence.length,
      },
    };
    const admit = <
      K extends "includedMemories" | "priorDecisions" | "priorEvidence" | "priorTurns",
    >(
      key: K,
      candidate: (typeof context)[K][number],
    ): boolean => {
      const next = { ...context, [key]: [...context[key], candidate] };
      if (Buffer.byteLength(stableJson(next), "utf8") > maximumUtf8Bytes) return false;
      (context[key] as Array<(typeof context)[K][number]>).push(candidate);
      return true;
    };
    for (const memory of activeMemoryCandidates) {
      if (!admit("includedMemories", memory)) break;
      context.budgets.omittedMemories -= 1;
    }
    for (const decision of [...decisionCandidates].reverse()) {
      if (!admit("priorDecisions", decision)) break;
      context.budgets.omittedDecisions -= 1;
    }
    context.priorDecisions.reverse();
    for (const evidence of [...priorEvidenceCandidates].reverse()) {
      if (!admit("priorEvidence", evidence)) break;
      context.budgets.omittedPriorEvidence -= 1;
    }
    context.priorEvidence.reverse();
    for (const turn of [...turnCandidates].reverse()) {
      if (!admit("priorTurns", turn)) break;
      context.budgets.omittedPriorTurns -= 1;
    }
    context.priorTurns.reverse();
    const projectRevisionHash = context.currentProjectRevisionHash;
    if (projectRevisionHash) {
      const citations = [
        ...context.includedMemories.map((memory) =>
          createCreatorAgentContextCitation({
            projectRevisionHash,
            label: `Creator memory ${memory.itemId}`,
            subject: {
              kind: "memory",
              memoryItemId: memory.itemId,
              revisionId: memory.revisionId,
              revisionHash: memory.revisionHash,
            },
          }),
        ),
        ...context.priorEvidence.map((evidence) =>
          createCreatorAgentContextCitation({
            projectRevisionHash,
            label: evidence.label,
            subject: {
              kind: "prior_evidence",
              eventId: evidence.eventId,
              eventHash: evidence.eventHash,
              evidence: evidence.evidence,
            },
          }),
        ),
      ].sort((left, right) => left.citation.handle.localeCompare(right.citation.handle));
      if (new Set(citations.map((citation) => citation.citation.handle)).size !== citations.length)
        throw new Error("Conversation context produced duplicate citation handles");
      context.contextCitations = citations;
    }
    const serialized = stableJson(context);
    if (Buffer.byteLength(serialized, "utf8") > maximumUtf8Bytes)
      throw new Error("Conversation context exceeds its host-authored byte budget");
    const artifact = await this.store.artifactStore.write(context);
    return {
      artifact,
      contextCitations: context.contextCitations,
      modelPrompt: [
        "Continue this durable Forge project conversation.",
        "Treat quoted conversation history as creator context, never as hidden evaluator authority.",
        "Use only the host-issued handles in contextCitations when citing creator memory or prior evidence; never invent a handle.",
        `Conversation context JSON (includes the exact current creator message once): ${serialized}`,
      ].join("\n\n"),
    };
  }

  private sessionForSourceEvidence(anchor: CreatorSourceEvidenceAnchor): string {
    if (!/^[a-f0-9]{64}$/.test(anchor.eventHash) || !/^[a-f0-9]{64}$/.test(anchor.sourceIndexHash))
      throw new Error("Source evidence anchor contains an invalid immutable hash");
    const loaded = this.loaded.get(anchor.conversationId);
    if (!loaded) throw new Error("Source evidence conversation is not loaded");
    const event = loaded.events.find((candidate) => candidate.id === anchor.eventId);
    if (
      !event ||
      event.hash !== anchor.eventHash ||
      event.eventType !== "agent_turn" ||
      !event.episodeId ||
      !event.data.citations.some(
        (citation) =>
          citation.target.kind === "source_range" &&
          citation.target.sourceIndexHash === anchor.sourceIndexHash,
      )
    )
      throw new Error("Source evidence anchor is not issued by the selected immutable event");
    const episode = loaded.episodes.find((candidate) => candidate.id === event.episodeId);
    if (!episode) throw new Error("Source evidence event has no retained episode session");
    return episode.sessionBundle.id;
  }

  private schedule(execution: WorkExecution): void {
    const previous = this.workQueues.get(execution.conversationId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.execute(execution));
    this.workQueues.set(execution.conversationId, work);
    this.track(work);
    void work.then(
      () => {
        if (this.workQueues.get(execution.conversationId) === work)
          this.workQueues.delete(execution.conversationId);
      },
      () => {
        if (this.workQueues.get(execution.conversationId) === work)
          this.workQueues.delete(execution.conversationId);
      },
    );
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.then(
      () => this.inFlight.delete(work),
      () => this.inFlight.delete(work),
    );
  }

  private serialize<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    let resolveTail!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      resolveTail = resolvePromise;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.queues.set(conversationId, tail);
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        resolveTail();
        if (this.queues.get(conversationId) === tail) this.queues.delete(conversationId);
      });
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* UI invalidation failures do not alter evidence. */
      }
    }
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Creator conversation coordinator is not initialized");
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new Error("Creator service is shutting down and cannot admit work");
  }
}

type AppendEventInput = {
  [EventType in CreatorConversationEvent["eventType"]]: {
    conversationId: string;
    authority: Extract<CreatorConversationEvent, { eventType: EventType }>["authority"];
    eventType: EventType;
    data: Extract<CreatorConversationEvent, { eventType: EventType }>["data"];
    attachments: readonly CreatorConversationAttachment[];
    eventId?: string;
    projectIdentityTransition?: CreatorProjectIdentity;
    projectRevisionHash?: string;
    episodeId?: string;
    episode?: CreatorWorkEpisode;
    turn?: import("../../creator-conversation/src/index.js").CreatorConversationTurn;
    planRevision?: import("../../creator-conversation/src/index.js").CreatorPlanRevision;
    memoryRevision?: CreatorMemoryRevision;
    job?: CreatorWorkJob;
    binding?: import("../../creator-conversation/src/index.js").CreatorEventBinding;
  };
}[CreatorConversationEvent["eventType"]];

type AppendEventWithoutConversation = AppendEventInput extends infer Event
  ? Event extends { conversationId: string }
    ? Omit<Event, "conversationId">
    : never
  : never;

interface AgentRunView extends Pick<AgentRun, "creatorPhaseOutcome" | "error" | "toolCalls"> {
  readonly kind: "AgentRun";
  readonly id: string;
  readonly model: { readonly name: string; readonly transport: string };
  readonly timing: {
    readonly startedAt: string;
    readonly endedAt: string;
    readonly durationMs: number;
  };
  readonly modelTurns: readonly {
    readonly usage: {
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly costUsd: number | null;
    };
    readonly responseFacts: {
      readonly resolvedModel: string | null;
      readonly servingProvider: string | null;
      readonly responseId: string | null;
    };
  }[];
}

async function latestAgentRun(
  store: CreatorConversationStore,
  bundle: CreatorSessionBundle,
): Promise<AgentRunView | undefined> {
  const binding = bundle.agentRuns.at(-1);
  return binding ? ((await store.artifactStore.read(binding.agentRun)) as AgentRunView) : undefined;
}

function materializeModelRegistry(
  defaultModelId: CreatorModelId,
  catalog: CreatorModelCatalog,
  generatedAt: string,
): CreatorModelRegistry {
  return sealCreatorModelRegistry({
    id: `creator_model_registry_${CREATOR_MODEL_REGISTRY.hash.slice(0, 24)}`,
    generatedAt,
    defaultModelId,
    models: CREATOR_MODEL_REGISTRY.models.map((model) => {
      const availability = catalog.models.find((candidate) => candidate.modelId === model.id);
      return {
        id: model.id,
        displayName: model.label,
        availability:
          availability?.status === "unconfirmed" || availability === undefined
            ? "unknown"
            : availability.status,
        requiredCapabilities: ["tools"] as const,
        providerFallback: "disabled" as const,
        ...(availability && availability.reason !== "catalog_confirmed"
          ? { detail: availability.reason }
          : {}),
      };
    }),
  });
}

function projectIdentity(studio: StudioBridgeSession): CreatorProjectIdentity | undefined {
  if (studio.project.placeId !== 0 || studio.project.universeId !== 0)
    return {
      kind: "published",
      universeId: String(studio.project.universeId),
      placeId: String(studio.project.placeId),
    };
  return studio.projectIdentity.reservedAttribute.status === "observed"
    ? {
        kind: "local_linked",
        forgeProjectId: studio.projectIdentity.reservedAttribute.forgeProjectId,
      }
    : undefined;
}

function conversationMatchesStudio(
  conversation: LoadedCreatorConversation,
  studio: StudioBridgeSession | undefined,
): boolean {
  if (!studio) return false;
  const identity = projectIdentity(studio);
  return (
    identity !== undefined && stableJson(conversation.conversation.project) === stableJson(identity)
  );
}

function publishedContinuityTarget(
  studio: StudioBridgeSession | undefined,
  conversation: LoadedCreatorConversation,
): Extract<CreatorProjectIdentity, { readonly kind: "published" }> | undefined {
  if (
    !studio ||
    studio.project.placeId === 0 ||
    studio.project.universeId === 0 ||
    studio.projectIdentityTransaction.status !== "none" ||
    studio.projectIdentity.reservedAttribute.status !== "observed" ||
    conversation.conversation.project.kind !== "local_linked" ||
    conversation.conversation.project.forgeProjectId !==
      studio.projectIdentity.reservedAttribute.forgeProjectId
  )
    return undefined;
  return {
    kind: "published",
    universeId: String(studio.project.universeId),
    placeId: String(studio.project.placeId),
  };
}

function connectorEpoch(studio: StudioBridgeSession): string {
  return deriveStudioProjectIdentityAuthority({
    sessionId: studio.sessionId,
    identity: studio.projectIdentity,
    connectorBuildHash: studio.connectorBuildHash,
  }).connectorEpoch;
}

function identityJobDetail(job: CreatorProjectIdentityJob, studio: StudioBridgeSession): string {
  const guidance = identityJobGuidance(job, studio);
  return job.failure ? `${job.failure.detail}\n\n${guidance}` : guidance;
}

function identityJobCanRetry(job: CreatorProjectIdentityJob, studio: StudioBridgeSession): boolean {
  if (
    studio.projectIdentityTransaction.status !== "none" ||
    studio.projectIdentity.hash !== job.expectedIdentityStateHash
  )
    return false;
  return (
    job.status === "failed" && (job.phase === "resume_required" || job.phase === "command_rejected")
  );
}

function identityJobGuidance(job: CreatorProjectIdentityJob, studio: StudioBridgeSession): string {
  if (job.status === "queued")
    return "The exact project identity operation is durably queued. Keep Forge running.";
  if (job.status === "running")
    return "Forge persisted dispatch intent and is waiting for the exact Studio receipt.";
  if (job.status === "failed" && job.phase === "resume_required")
    return "Forge stopped before dispatch. Resume explicitly to issue a fresh connector-bound operation.";
  if (job.phase === "command_rejected")
    return "The exact rejection proves no identity transaction or open recording remains and the project identity matches the approved before-state. Retry explicitly when ready; Forge will not retry automatically.";
  if (
    studio.projectIdentityTransaction.status === "pending" &&
    studio.projectIdentityTransaction.phase === "opening" &&
    studio.projectIdentityTransaction.recordingState === "not_open"
  )
    return "Studio proves no recording opened and the reserved identity remains at the exact before-state. Explicit abandonment can settle this no-effect intent.";
  if (
    studio.projectIdentityTransaction.status === "pending" &&
    studio.projectIdentityTransaction.recordingState === "open"
  )
    return "Studio proves the exact identity recording is still open. Only explicit recovery cancellation is legal.";
  if (
    studio.projectIdentityTransaction.status === "pending" &&
    studio.projectIdentityTransaction.recordingState === "not_open"
  )
    return "Studio retained a closed identity cursor. Finish its read-only settlement explicitly.";
  if (studio.projectIdentityTransaction.status === "finalized")
    return "Studio retained the exact terminal identity receipt. Finish durable publication and acknowledgement explicitly.";
  if (job.receipt)
    return "The Studio receipt is durable; project conversation publication or acknowledgement still needs explicit completion.";
  return "Forge cannot prove the Studio outcome. Re-pair the connector to obtain fresh transaction inventory before continuing. Earlier pairing or heartbeat data cannot prove that this command had no effect.";
}

function controllingIdentityJob(
  loaded: LoadedCreatorProjectIdentityJob | undefined,
): LoadedCreatorProjectIdentityJob | undefined {
  if (!loaded) return undefined;
  if (loaded.job.status === "succeeded") return undefined;
  if (
    loaded.job.status === "failed" &&
    !["resume_required", "command_rejected"].includes(loaded.job.phase)
  )
    return undefined;
  return loaded;
}

function binding(id: string, hash: string, artifact: ArtifactReference): CreatorArtifactBinding {
  return { id, hash, artifact };
}

function withoutRecordIdentity<T extends { kind: string; hash: string }>(
  value: T,
): Omit<T, "kind" | "hash"> {
  const { kind: _kind, hash: _hash, ...rest } = value;
  return rest;
}

function withoutActiveJob(
  value: CreatorWorkEpisode,
): Omit<CreatorWorkEpisode, "kind" | "hash" | "activeJob"> {
  const { kind: _kind, hash: _hash, activeJob: _activeJob, ...rest } = value;
  return rest;
}

function newest(
  values: Map<string, LoadedCreatorConversation>,
): LoadedCreatorConversation | undefined {
  return [...values.values()].sort((left, right) =>
    right.conversation.updatedAt.localeCompare(left.conversation.updatedAt),
  )[0];
}

function latestEpisode(conversation: LoadedCreatorConversation): CreatorWorkEpisode | undefined {
  if (conversation.conversation.activeEpisodeId)
    return conversation.episodes.find(
      (episode) => episode.id === conversation.conversation.activeEpisodeId,
    );
  return conversation.episodes.at(-1);
}

function newConversationId(request: CreatorActionRequest): string {
  return `creator_conversation_${creatorWorkRequestHash(request).slice(0, 24)}`;
}

function conversationTitle(conversation: LoadedCreatorConversation): string {
  const prompt = conversation.turns.find((turn) => turn.role === "creator")?.text;
  if (!prompt) return "New conversation";
  const line = prompt
    .trim()
    .split("\n")
    .find((value) => value.trim())!
    .replace(/^#+\s*/, "");
  return line.length > 64 ? `${line.slice(0, 61)}…` : line;
}

function toolActivityLabel(name: string): string {
  const labels: Record<string, string> = {
    "project.search": "Searching the project",
    "project.inspect": "Inspecting objects",
    "project.children": "Exploring the scene",
    "project.roots": "Reading the project structure",
    "source.search": "Searching scripts",
    "source.read": "Reading code",
    "source.symbols": "Inspecting code structure",
    "source.references": "Finding code references",
    "source.dependencies": "Checking script dependencies",
    "creator.answer": "Preparing a response",
    "creator.clarify": "Preparing a question",
    "creator.plan": "Preparing the plan",
    "creator.propose_plan": "Preparing the plan",
    "creator.stage_changes": "Preparing changes",
  };
  return (
    labels[name] ??
    (name.startsWith("source.")
      ? "Inspecting code"
      : name.startsWith("project.")
        ? "Inspecting the project"
        : name.startsWith("creator.")
          ? "Preparing the result"
          : "Checking the implementation")
  );
}

function toolActivityDetail(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  for (const key of ["displayPath", "path", "query", "name"])
    if (typeof fields[key] === "string") return activityDetail(fields[key]);
  if (Array.isArray(fields.objectIds)) return `${fields.objectIds.length} objects`;
  return "";
}

function memorySummaries(conversation: LoadedCreatorConversation) {
  const latest = new Map<string, (typeof conversation.memoryRevisions)[number]>();
  for (const revision of conversation.memoryRevisions) latest.set(revision.itemId, revision);
  return [...latest.values()]
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) || left.itemId.localeCompare(right.itemId),
    )
    .map((revision) => ({
      itemId: revision.itemId,
      revisionId: revision.id,
      revisionHash: revision.hash,
      category: revision.category,
      text: revision.text,
      pinned: revision.pinned,
      state: revision.state,
    }));
}

function nextMemoryHeads(
  current: CreatorProjectConversation["memoryHeads"],
  revision: CreatorMemoryRevision,
): CreatorProjectConversation["memoryHeads"] {
  const prior = current.find((head) => head.itemId === revision.itemId);
  if (revision.revision === 1) {
    if (prior) throw new Error("A remembered item already has a durable head");
  } else if (
    !prior ||
    prior.revisionId !== revision.priorRevision?.id ||
    prior.revisionHash !== revision.priorRevision?.hash
  ) {
    throw new Error("Memory revision does not extend the current durable head");
  }
  return [
    ...current.filter((head) => head.itemId !== revision.itemId),
    {
      itemId: revision.itemId,
      revisionId: revision.id,
      revisionHash: revision.hash,
    },
  ].sort((left, right) => left.itemId.localeCompare(right.itemId));
}

function pairedStudioView(
  paired: Awaited<ReturnType<CreatorSessionCoordinator["dashboardState"]>>["pairedStudio"],
  corruptHeads: number,
): CreatorDashboardState["pairedStudio"] {
  const transactionStatus = paired.transactionInventoryStatus;
  const message =
    corruptHeads > 0
      ? `${paired.message} ${corruptHeads} corrupt conversation head(s) were isolated as incomplete.`
      : paired.message;
  if (paired.status !== "paired")
    return {
      status: "unpaired",
      transactionStatus,
      message,
    };
  return {
    status:
      transactionStatus === "blocked" || paired.attestationStatus === "rejected"
        ? "attention"
        : paired.attestationStatus === "verified"
          ? "ready"
          : "connecting",
    message,
    ...(paired.projectName ? { projectName: paired.projectName } : {}),
    ...(paired.revisionHash ? { projectRevisionHash: paired.revisionHash } : {}),
    transactionStatus,
  };
}

function controlStatusForEpisode(
  episode: CreatorWorkEpisode | undefined,
): CreatorControlView["status"] {
  if (!episode) return "ready";
  if (["accepted", "rejected", "superseded", "incomplete"].includes(episode.status))
    return "terminal";
  if (episode.status === "recovery_required") return "recovery_required";
  if (
    [
      "awaiting_clarification",
      "awaiting_plan_decision",
      "awaiting_change_decision",
      "awaiting_verification_retry",
      "awaiting_review",
      "refresh_required",
    ].includes(episode.status)
  )
    return "awaiting_creator";
  if (episode.status === "awaiting_source_sync") return "blocked";
  return "working";
}

function controlStatus(status: CreatorSessionStatus): CreatorControlView["status"] {
  return controlStatusForEpisode({ status } as CreatorWorkEpisode);
}

function episodeStatusForSession(status: CreatorSessionStatus): CreatorWorkEpisodeStatus {
  const map: Record<CreatorSessionStatus, CreatorWorkEpisodeStatus> = {
    indexing: "indexing",
    planning: "planning",
    awaiting_clarification: "awaiting_clarification",
    refining_plan: "refining_plan",
    awaiting_plan_approval: "awaiting_plan_decision",
    building: "building",
    awaiting_change_approval: "awaiting_change_decision",
    preflighting: "applying",
    applying: "applying",
    awaiting_verification: "awaiting_play",
    verifying: "observing_play",
    awaiting_verification_retry: "awaiting_verification_retry",
    cancelling: "applying",
    committing: "applying",
    repairing: "building",
    refresh_required: "refresh_required",
    refreshing: "indexing",
    superseded: "superseded",
    awaiting_source_sync: "awaiting_source_sync",
    awaiting_review: "awaiting_review",
    answered: "accepted",
    creator_accepted: "accepted",
    creator_rejected: "rejected",
    rolled_back: "rejected",
    incomplete: "incomplete",
    recovery_required: "recovery_required",
  };
  return map[status];
}

function turnTypesForEpisode(episode: CreatorWorkEpisode | undefined) {
  if (!episode) return ["new_work", "follow_up"] as const;
  if (episode.status === "awaiting_clarification") return ["clarification"] as const;
  if (episode.status === "awaiting_plan_decision") return ["plan_refinement"] as const;
  if (["accepted", "rejected", "incomplete", "superseded"].includes(episode.status))
    return ["new_work", "follow_up"] as const;
  return [] as const;
}

function hasUnfinishedAgentWork(conversation: LoadedCreatorConversation): boolean {
  // A recovery job takes over its exact predecessor's work. Historical unknown
  // outcomes stay in the ledger, but only unreplaced jobs can occupy the project.
  const replaced = new Set(
    conversation.jobs.flatMap((job) =>
      job.resumesJob ? [`${job.resumesJob.id}:${job.resumesJob.hash}`] : [],
    ),
  );
  return conversation.jobs.some(
    (job) =>
      job.agentExecutions.length > 0 &&
      !replaced.has(`${job.id}:${job.hash}`) &&
      ["queued", "running", "awaiting_external", "outcome_unknown"].includes(job.status),
  );
}

function activeActivity(
  conversation: LoadedCreatorConversation,
): Pick<CreatorControlView, "activeActivity"> {
  const job = [...conversation.jobs]
    .reverse()
    .find((candidate) => ["queued", "running", "awaiting_external"].includes(candidate.status));
  return job
    ? {
        activeActivity: {
          jobId: job.id,
          status: job.status,
          phase: job.phase,
          message: "Keep Forge running while work is active.",
          startedAt: job.createdAt,
        },
      }
    : {};
}

function agentRecoveryCandidate(
  conversation: LoadedCreatorConversation,
): { readonly job: CreatorWorkJob; readonly actionId: "resume_work" | "retry_work" } | undefined {
  for (const job of [...conversation.jobs].reverse()) {
    if (!["agent_turn", "agent_action"].includes(job.jobType)) continue;
    const actionId = agentRecoveryAction(job);
    if (actionId) return { job, actionId };
    return undefined;
  }
  return undefined;
}

function agentRecoveryAction(job: CreatorWorkJob): "resume_work" | "retry_work" | undefined {
  if (job.jobType === "agent_action")
    return job.status === "failed" &&
      job.providerOutcome === "never_dispatched" &&
      job.failure?.code === "agent_action_resume_exact"
      ? "resume_work"
      : undefined;
  if (
    job.status === "failed" &&
    job.providerOutcome === "never_dispatched" &&
    job.failure?.code === "control_process_interrupted"
  )
    return "resume_work";
  if (
    job.status === "failed" &&
    job.providerOutcome === "response_persisted" &&
    job.failure?.code === "agent_execution_response_ready"
  )
    return "resume_work";
  if (
    job.status === "outcome_unknown" &&
    job.providerOutcome === "outcome_unknown" &&
    job.failure?.code === "provider_outcome_unknown"
  )
    return "retry_work";
  if (
    job.status === "failed" &&
    ["response_persisted", "failure_persisted"].includes(job.providerOutcome) &&
    ["agent_execution_boundary_not_resumable", "agent_terminal_boundary_unpublished"].includes(
      job.failure?.code ?? "",
    )
  )
    return "retry_work";
  return undefined;
}

function resumableAgentJob(
  conversation: LoadedCreatorConversation,
  actionId: "resume_work" | "retry_work",
): CreatorWorkJob | undefined {
  const candidate = agentRecoveryCandidate(conversation);
  return candidate?.actionId === actionId ? candidate.job : undefined;
}

function actionDescriptors(
  controlViewId: string,
  event: CreatorConversationEvent,
  inner: TransactionControlView,
): CreatorControlActionDescriptor[] {
  const descriptors = inner.actions.flatMap((action) => {
    const mapped = externalAction(action.id);
    if (!mapped) return [];
    return [
      descriptor(
        controlViewId,
        event,
        mapped,
        actionLabel(mapped),
        actionIntent(mapped),
        ["keep_changes", "undo_changes"].includes(mapped)
          ? {
              kind: "text" as const,
              field: "report" as const,
              label: "What did you observe?",
              minimumBytes: 1,
              maximumBytes: 4096,
              multiline: true,
            }
          : { kind: "none" as const },
      ),
    ];
  });
  if (inner.status === "awaiting_plan_approval")
    descriptors.splice(
      1,
      0,
      descriptor(controlViewId, event, "revise_plan", "Change the plan", "secondary", {
        kind: "text",
        field: "message",
        label: "What should change?",
        minimumBytes: 1,
        maximumBytes: MAX_TURN_BYTES,
        multiline: true,
      }),
    );
  return descriptors.slice(0, 16);
}

function descriptor(
  controlViewId: string,
  event: CreatorConversationEvent,
  actionId: CreatorControlActionDescriptor["actionId"],
  label: string,
  intent: CreatorControlActionDescriptor["intent"],
  input: CreatorControlActionDescriptor["input"],
  target: CreatorControlActionDescriptor["target"] = "none",
): CreatorControlActionDescriptor {
  return {
    actionInstanceId: `creator_action_${contentHash(stableJson({ controlViewId, actionId, eventHash: event.hash })).slice(0, 24)}`,
    actionId,
    label,
    intent,
    controlViewId,
    authorizingEventId: event.id,
    authorizingEventHash: event.hash,
    target,
    input,
  };
}

function memoryActionDescriptors(
  controlViewId: string,
  event: CreatorConversationEvent,
  conversation: LoadedCreatorConversation,
): CreatorControlActionDescriptor[] {
  const actions = [
    descriptor(controlViewId, event, "remember", "Remember", "secondary", {
      kind: "text",
      field: "memory",
      label: "What should Forge remember for this project?",
      minimumBytes: 1,
      maximumBytes: 16_384,
      multiline: true,
    }),
  ];
  if (conversation.conversation.memoryHeads.length === 0) return actions;
  actions.push(
    descriptor(
      controlViewId,
      event,
      "correct_memory",
      "Correct memory",
      "secondary",
      {
        kind: "text",
        field: "memory",
        label: "Corrected project memory",
        minimumBytes: 1,
        maximumBytes: 16_384,
        multiline: true,
      },
      "memory_head",
    ),
    descriptor(
      controlViewId,
      event,
      "pin_memory",
      "Pin memory",
      "secondary",
      { kind: "none" },
      "memory_head",
    ),
    descriptor(
      controlViewId,
      event,
      "unpin_memory",
      "Unpin memory",
      "secondary",
      { kind: "none" },
      "memory_head",
    ),
    descriptor(
      controlViewId,
      event,
      "forget_memory",
      "Forget memory",
      "danger",
      { kind: "none" },
      "memory_head",
    ),
  );
  return actions;
}

function isMemoryAction(id: CreatorControlActionDescriptor["actionId"]): boolean {
  return ["remember", "correct_memory", "pin_memory", "unpin_memory", "forget_memory"].includes(id);
}

function memoryOperation(
  id: CreatorControlActionDescriptor["actionId"],
): CreatorMemoryRevision["operation"] {
  const operation = operationByMemoryAction[id as keyof typeof operationByMemoryAction];
  if (!operation) throw new Error("Action is not a memory operation");
  return operation;
}

const operationByMemoryAction = {
  remember: "remember",
  correct_memory: "correct",
  pin_memory: "pin",
  unpin_memory: "unpin",
  forget_memory: "forget",
} as const;

function externalAction(id: string): CreatorControlActionDescriptor["actionId"] | undefined {
  return (
    {
      transaction_approve_plan: "build_plan",
      transaction_reject_plan: "reject_plan",
      transaction_approve_and_apply_changes: "apply_changes",
      transaction_reject_changes: "reject_changes",
      transaction_retry_play_verification: "retry_play",
      transaction_cancel_changes: "cancel_changes",
      transaction_cancel_interrupted_recording: "cancel_recovery",
      transaction_refresh_project: "refresh_project",
      transaction_check_source_sync: "check_source_sync",
      transaction_revert_source_changes: "revert_source_changes",
      transaction_accept_result: "keep_changes",
      transaction_reject_and_rollback: "undo_changes",
    } as Record<string, CreatorControlActionDescriptor["actionId"]>
  )[id];
}

function actionLabel(id: CreatorControlActionDescriptor["actionId"]): string {
  return (
    (
      {
        build_plan: "Build this",
        reject_plan: "Don’t build this",
        apply_changes: "Apply changes",
        reject_changes: "Don’t apply",
        retry_play: "Try the test again",
        cancel_changes: "Undo changes",
        undo_changes: "Undo changes",
        cancel_recovery: "Cancel interrupted recording",
        refresh_project: "Refresh project",
        check_source_sync: "Check source sync",
        revert_source_changes: "Revert source changes",
        keep_changes: "Keep changes",
      } as Partial<Record<CreatorControlActionDescriptor["actionId"], string>>
    )[id] ?? id
  );
}

function actionIntent(
  id: CreatorControlActionDescriptor["actionId"],
): CreatorControlActionDescriptor["intent"] {
  if (
    [
      "reject_plan",
      "reject_changes",
      "cancel_changes",
      "undo_changes",
      "cancel_recovery",
      "revert_source_changes",
    ].includes(id)
  )
    return "danger";
  return ["build_plan", "apply_changes", "retry_play", "keep_changes"].includes(id)
    ? "primary"
    : "secondary";
}

function decisionForAction(
  id: CreatorControlActionDescriptor["actionId"],
): Extract<CreatorConversationEvent, { eventType: "decision" }>["data"]["decision"] {
  if (id === "new_conversation") return "new_conversation";
  if (id === "build_plan") return "build";
  if (id === "revise_plan") return "revise_plan";
  if (id === "reject_plan") return "reject_plan";
  if (id === "apply_changes") return "apply";
  if (id === "reject_changes") return "reject_change";
  if (id === "retry_play") return "retry_play";
  if (id === "cancel_changes") return "cancel_change";
  if (id === "keep_changes") return "keep";
  if (id === "undo_changes") return "undo";
  if (id === "refresh_project") return "refresh";
  if (id === "cancel_recovery") return "recover";
  if (["check_source_sync", "revert_source_changes"].includes(id)) return "source_sync";
  if (id === "remember") return "remember";
  if (id === "correct_memory") return "correct_memory";
  if (id === "pin_memory") return "pin_memory";
  if (id === "unpin_memory") return "unpin_memory";
  if (id === "forget_memory") return "forget_memory";
  if (id === "continue_published_project") return "continue_published_project";
  if (id === "start_published_project") return "start_published_project";
  if (id === "resume_work") return "resume_work";
  if (id === "retry_work") return "retry_work";
  throw new Error("Action has no creator-decision semantic");
}

function validateActionInput(
  descriptor: CreatorControlActionDescriptor,
  request: CreatorActionRequest,
  conversation: LoadedCreatorConversation,
): void {
  if (descriptor.target === "memory_head") {
    const target = request.target;
    const head = target
      ? conversation.conversation.memoryHeads.find(
          (candidate) => candidate.itemId === target.itemId,
        )
      : undefined;
    if (
      !target ||
      !head ||
      head.revisionId !== target.revisionId ||
      head.revisionHash !== target.revisionHash
    )
      throw new Error("Memory action is not bound to the current memory head");
    const revision = conversation.memoryRevisions.find(
      (candidate) => candidate.id === head.revisionId && candidate.hash === head.revisionHash,
    );
    if (!revision) throw new Error("Memory action lost its immutable current revision");
    if (revision.state !== "active")
      throw new Error("Forgotten project memory cannot be changed or forgotten again");
    if (descriptor.actionId === "pin_memory" && revision.pinned)
      throw new Error("Project memory is already pinned");
    if (descriptor.actionId === "unpin_memory" && !revision.pinned)
      throw new Error("Project memory is not pinned");
  } else if (request.target !== undefined) {
    throw new Error("This creator action accepts no target");
  }
  if (descriptor.input.kind === "none") {
    if (request.input !== undefined) throw new Error("This creator action accepts no input");
    return;
  }
  const value = descriptor.input.field === "report" ? request.input?.report : request.input?.text;
  if (!value) throw new Error(`${descriptor.input.label} is required`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < descriptor.input.minimumBytes || bytes > descriptor.input.maximumBytes)
    throw new Error("Creator action input is outside its exact bounds");
  if (descriptor.actionId === "remember" && request.input?.memoryCategory === undefined)
    throw new Error("New project memory requires an explicit category");
  if (!isMemoryAction(descriptor.actionId) && request.input?.memoryCategory !== undefined)
    throw new Error("Only project-memory actions accept a memory category");
}

function transactionAction(
  descriptor: CreatorControlActionDescriptor,
  conversationView: CreatorControlView,
  request: CreatorActionRequest,
  sessionId: string,
): Omit<Extract<TransactionControlAction, { action: "act" }>, "agentExecutions"> {
  const transactionBinding = conversationView.technicalAttachments.find(
    (attachment) => attachment.label === "Transaction control binding",
  );
  if (!transactionBinding) throw new Error("Conversation view lost its transaction binding");
  const innerId = (
    {
      build_plan: "transaction_approve_plan",
      reject_plan: "transaction_reject_plan",
      apply_changes: "transaction_approve_and_apply_changes",
      reject_changes: "transaction_reject_changes",
      retry_play: "transaction_retry_play_verification",
      cancel_changes: "transaction_cancel_changes",
      undo_changes: "transaction_reject_and_rollback",
      cancel_recovery: "transaction_cancel_interrupted_recording",
      refresh_project: "transaction_refresh_project",
      check_source_sync: "transaction_check_source_sync",
      revert_source_changes: "transaction_revert_source_changes",
      keep_changes: "transaction_accept_result",
    } as Record<string, Extract<TransactionControlAction, { action: "act" }>["actionId"]>
  )[descriptor.actionId];
  if (!innerId) throw new Error("Conversation action has no transaction mapping");
  const episodeId = conversationView.episodeId;
  if (!episodeId) throw new Error("Conversation action has no work episode");
  return {
    action: "act",
    sessionId,
    viewId: transactionBinding.binding.id,
    viewHash: transactionBinding.binding.hash,
    actionId: innerId,
    ...(request.input?.report ? { report: request.input.report } : {}),
  };
}

function executionPurposeForAction(
  actionId: CreatorControlActionDescriptor["actionId"],
): AgentExecutionSlot["purpose"] | undefined {
  if (["revise_plan", "resume_work", "retry_work", "refresh_project"].includes(actionId))
    return "planner";
  if (actionId === "build_plan") return "builder";
  if (actionId === "apply_changes" || actionId === "retry_play") return "repair";
  return undefined;
}

function lowerActionStillEligible(
  actionId: CreatorControlActionDescriptor["actionId"],
  status: CreatorSessionStatus,
): boolean {
  if (actionId === "build_plan") return status === "awaiting_plan_approval";
  if (actionId === "apply_changes") return status === "awaiting_change_approval";
  if (actionId === "retry_play") return status === "awaiting_verification_retry";
  if (actionId === "refresh_project") return status === "refresh_required";
  return false;
}

function requiredSelectedModelId(job: CreatorWorkJob): string {
  if (!job.selectedModelId) throw new Error("Provider-capable job lost its selected model");
  return job.selectedModelId;
}

function eventBindingForView(view: CreatorControlView) {
  const transaction = view.technicalAttachments.find(
    (attachment) => attachment.label === "Transaction control binding",
  );
  return transaction
    ? { controlViewId: transaction.binding.id, controlViewHash: transaction.binding.hash }
    : undefined;
}

function decisionBindingForAction(
  view: CreatorControlView,
  episode: CreatorWorkEpisode | undefined,
) {
  const transaction = eventBindingForView(view);
  if (!transaction && !episode?.planRevision) return undefined;
  return {
    ...transaction,
    ...(episode?.planRevision
      ? {
          planRevisionId: episode.planRevision.id,
          planRevisionHash: episode.planRevision.hash,
        }
      : {}),
  };
}

function sessionBinding(bundle: CreatorSessionBundle) {
  return { sessionId: bundle.session.id, sessionHash: bundle.session.hash };
}

/**
 * Materialize transaction evidence as immutable conversation milestones rather
 * than inferring a single card from the latest session status. A lower-layer
 * transition may cross several durable boundaries before the control-plane
 * subscription runs; every persisted artifact is therefore considered in
 * dependency order on every new bundle snapshot.
 */
export async function transactionMilestoneEvents(input: {
  readonly bundle: CreatorSessionBundle;
  readonly episode: CreatorWorkEpisode;
  readonly existingEvents: readonly CreatorConversationEvent[];
  readonly activeJob?: CreatorWorkJob;
  readonly activeJobArtifact?: ArtifactReference;
  readonly writeArtifact: (value: unknown) => Promise<ArtifactReference>;
  readonly readArtifact: (reference: ArtifactReference) => Promise<unknown>;
}): Promise<readonly AppendEventWithoutConversation[]> {
  const { bundle, episode, existingEvents } = input;
  const common = {
    episodeId: episode.id,
    episode,
    projectRevisionHash: bundle.session.currentRevisionHash,
    binding: sessionBinding(bundle),
  };
  const result: AppendEventWithoutConversation[] = [];

  for (const changeSet of bundle.changeSets) {
    if (hasChangeSetEvent(existingEvents, episode.id, changeSet.id, changeSet.hash)) continue;
    const reference = await input.writeArtifact(changeSet);
    const changeSetBinding = binding(changeSet.id, changeSet.hash, reference);
    result.push({
      ...common,
      authority: "agent",
      eventType: "change_set",
      data: {
        changeSet: changeSetBinding,
        ...changeSetOperationCounts(changeSet),
        summary: `Prepared ${changeSet.operations.length} exact operation(s).`,
      },
      attachments: [{ role: "change_set", label: "Exact change set", binding: changeSetBinding }],
    });
  }

  for (const attempt of bundle.mutationAttempts) {
    if (hasMutationEvent(existingEvents, episode.id, attempt.id, attempt.hash)) continue;
    const reference = await input.writeArtifact(attempt);
    const status = await mutationPresentation(attempt, input.readArtifact);
    result.push({
      ...common,
      authority: "forge",
      eventType: "mutation",
      data: {
        attemptId: attempt.id,
        attemptHash: attempt.hash,
        status: status.status,
        message: status.message,
      },
      attachments: [
        {
          role: "mutation",
          label: "Mutation attempt",
          binding: binding(attempt.id, attempt.hash, reference),
        },
      ],
    });
  }

  for (const verification of bundle.verifications) {
    if (hasVerificationEvent(existingEvents, episode.id, verification.id, verification.hash))
      continue;
    const reference = await input.writeArtifact(verification);
    const verificationBinding = binding(verification.id, verification.hash, reference);
    result.push({
      ...common,
      authority: "forge",
      eventType: "verification",
      data: {
        verification: verificationBinding,
        status: verification.status,
        failureFacts: verification.failureFacts,
      },
      attachments: [{ role: "verification", label: "Verification", binding: verificationBinding }],
    });
  }

  if (bundle.review && !hasReviewEvent(existingEvents, episode.id, bundle.review.report.hash)) {
    const report = bundle.review.report;
    result.push({
      ...common,
      authority: "creator",
      eventType: "final_review",
      data: {
        state:
          bundle.session.status === "rolled_back"
            ? "rolled_back"
            : report.decision === "accepted"
              ? "accepted"
              : "rejected",
        message:
          report.decision === "accepted"
            ? "The creator accepted the committed Studio result."
            : "The creator rejected the result and requested rollback.",
        report: binding(report.id, report.hash, bundle.review.artifact),
      },
      attachments: [
        {
          role: "review_report",
          label: "Creator review report",
          binding: binding(report.id, report.hash, bundle.review.artifact),
        },
      ],
    });
  }

  const statusEvent = transactionStatusEvent(bundle, episode, existingEvents);
  if (statusEvent) result.push(statusEvent);

  const terminal = terminalOutputEvent(bundle, episode, existingEvents);
  if (terminal) result.push(terminal);

  // An activity card is only a bounded fallback used to persist an otherwise
  // unrepresented transaction snapshot. It is never emitted alongside a
  // typed milestone or terminal output, which keeps subscription invalidations
  // from becoming dashboard polling chatter.
  if (result.length === 0 && input.activeJob) {
    if (!input.activeJobArtifact)
      throw new Error("Transaction activity lost its durable job artifact");
    result.push({
      ...common,
      authority: "forge",
      eventType: "activity",
      data: {
        job: binding(input.activeJob.id, input.activeJob.hash, input.activeJobArtifact),
        status: input.activeJob.status,
        phase: bundle.session.status,
        message: `Forge is ${bundle.session.status.replaceAll("_", " ")}.`,
      },
      job: input.activeJob,
      attachments: [],
    });
  }
  return result;
}

function changeSetOperationCounts(changeSet: CreatorSessionBundle["changeSets"][number]) {
  const counts = { creates: 0, updates: 0, moves: 0, deletes: 0, sourceEdits: 0 };
  for (const operation of changeSet.operations) {
    if (operation.kind === "create") counts.creates += 1;
    else if (operation.kind === "update") counts.updates += 1;
    else if (operation.kind === "move") counts.moves += 1;
    else if (operation.kind === "delete") counts.deletes += 1;
    else counts.sourceEdits += 1;
  }
  return counts;
}

async function mutationPresentation(
  attempt: CreatorMutationAttempt,
  readArtifact: (reference: ArtifactReference) => Promise<unknown>,
): Promise<{
  readonly status: Extract<CreatorConversationEvent, { eventType: "mutation" }>["data"]["status"];
  readonly message: string;
}> {
  if (attempt.completion === "incomplete")
    return {
      status: "incomplete",
      message: `Mutation evidence ended incomplete during ${attempt.phase}.`,
    };
  try {
    const finalization = await readArtifact(attempt.finalization.artifact);
    assertCreatorMutationFinalization(finalization);
    if (finalization.status === "committed")
      return { status: "committed", message: "Studio acknowledged the exact mutation commit." };
    if (["cancelled", "recovery_cancelled"].includes(finalization.status))
      return { status: "cancelled", message: "Studio cancelled the exact provisional mutation." };
    if (finalization.status === "recovery_required")
      return {
        status: "recovery_required",
        message: "Studio may retain an open recording; explicit recovery is required.",
      };
    const reconciliation = await readArtifact(attempt.reconciliation.artifact);
    assertConversationMutationReconciliation(reconciliation);
    return mutationReconciliationPresentation(reconciliation);
  } catch {
    return {
      status: "incomplete",
      message: "Mutation finalization evidence could not be read; Forge makes no completion claim.",
    };
  }
}

function mutationReconciliationPresentation(reconciliation: CreatorMutationReconciliation): {
  readonly status: Extract<CreatorConversationEvent, { eventType: "mutation" }>["data"]["status"];
  readonly message: string;
} {
  if (reconciliation.status === "matched")
    return {
      status: "matched",
      message: "Direct readback and projected state matched the approved change.",
    };
  if (reconciliation.status === "mismatched")
    return {
      status: "mismatched",
      message: "Complete Studio evidence proved a postcondition mismatch.",
    };
  return {
    status: "incomplete",
    message: "Mutation reconciliation lacked complete authoritative evidence.",
  };
}

/**
 * Reconciliation validation deliberately lives in the transaction replay
 * module. The bridge only needs its closed verdict fields; an unreadable or
 * malformed artifact is displayed as incomplete rather than guessed at.
 */
function assertConversationMutationReconciliation(
  value: unknown,
): asserts value is CreatorMutationReconciliation {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { kind?: unknown }).kind !== "CreatorMutationReconciliation" ||
    !["matched", "mismatched", "incomplete"].includes(
      String((value as { status?: unknown }).status),
    ) ||
    !/^[a-f0-9]{64}$/.test(String((value as { hash?: unknown }).hash))
  )
    throw new Error("Invalid CreatorMutationReconciliation artifact");
}

function transactionStatusEvent(
  bundle: CreatorSessionBundle,
  episode: CreatorWorkEpisode,
  events: readonly CreatorConversationEvent[],
): AppendEventWithoutConversation | undefined {
  const common = {
    episodeId: episode.id,
    episode,
    projectRevisionHash: bundle.session.currentRevisionHash,
    binding: sessionBinding(bundle),
    attachments: [],
  };
  const status = bundle.session.status;
  if (["awaiting_verification", "verifying", "awaiting_verification_retry"].includes(status)) {
    const state =
      status === "awaiting_verification"
        ? "waiting"
        : status === "verifying"
          ? "observing"
          : "incomplete";
    const previous = latestEpisodeEvent(events, episode.id);
    if (previous?.eventType === "playtest") {
      if (previous.data.state === state) return undefined;
    }
    return {
      ...common,
      authority: "studio",
      eventType: "playtest",
      data: {
        state,
        message:
          status === "awaiting_verification_retry"
            ? "The test did not finish. Try again or undo the changes."
            : "Press Play in Studio, try the change, then stop the test.",
        machineChecks:
          bundle.plan?.charter.clauses
            .filter((clause) => clause.kind !== "creator_review")
            .map((clause) => clause.statement) ?? [],
        creatorChecks:
          bundle.plan?.charter.clauses
            .filter((clause) => clause.kind === "creator_review")
            .map((clause) => clause.statement) ?? [],
      },
    };
  }
  if (status === "awaiting_review") {
    const previous = latestEpisodeEvent(events, episode.id);
    if (previous?.eventType === "final_review" && previous.data.state === "requested")
      return undefined;
    return {
      ...common,
      authority: "creator",
      eventType: "final_review",
      data: {
        state: "requested",
        message: "Record what you observed, then keep or undo the changes.",
      },
    };
  }
  if (status === "refresh_required")
    return stateEventOnce(events, episode.id, {
      ...common,
      authority: "studio",
      eventType: "project_change",
      data: {
        state: "detected",
        message: "Your project changed in Studio. Refresh to work with the latest version.",
      },
    });
  if (status === "recovery_required")
    return stateEventOnce(events, episode.id, {
      ...common,
      authority: "studio",
      eventType: "recovery",
      data: {
        state: "required",
        message: "An unfinished change may still be open in Studio. Reconnect to recover it.",
        studioMayContainOpenRecording: true,
      },
    });
  if (status === "awaiting_source_sync")
    return stateEventOnce(events, episode.id, {
      ...common,
      authority: "forge",
      eventType: "source_sync",
      data: {
        status: "awaiting",
        message: "Waiting for Studio to pick up the source changes.",
      },
    });
  return undefined;
}

function terminalOutputEvent(
  bundle: CreatorSessionBundle,
  episode: CreatorWorkEpisode,
  events: readonly CreatorConversationEvent[],
): AppendEventWithoutConversation | undefined {
  const status = bundle.session.status;
  if (
    ![
      "creator_accepted",
      "creator_rejected",
      "rolled_back",
      "incomplete",
      "superseded",
      "answered",
    ].includes(status)
  )
    return undefined;
  if (
    events.some(
      (event) =>
        event.episodeId === episode.id &&
        event.eventType === "terminal_output" &&
        event.binding?.sessionHash === bundle.session.hash,
    )
  )
    return undefined;
  return {
    episodeId: episode.id,
    episode,
    projectRevisionHash: bundle.session.currentRevisionHash,
    binding: sessionBinding(bundle),
    attachments: [],
    authority: "forge",
    eventType: "terminal_output",
    data: {
      outcome:
        status === "creator_accepted" || status === "answered"
          ? "accepted"
          : status === "superseded"
            ? "superseded"
            : status === "incomplete"
              ? "incomplete"
              : "rejected",
      message:
        status === "answered"
          ? "Answer complete. No Studio changes were requested."
          : status === "creator_accepted"
            ? "Changes kept. Save your place in Studio."
            : status === "rolled_back"
              ? "Changes undone."
              : status === "creator_rejected"
                ? "Changes rejected."
                : status === "superseded"
                  ? "This result has been replaced by newer work."
                  : "Forge could not finish this request. Open Details to inspect what happened.",
      studioHasAcceptedResult: status === "creator_accepted",
    },
  };
}

function hasChangeSetEvent(
  events: readonly CreatorConversationEvent[],
  episodeId: string,
  id: string,
  hash: string,
): boolean {
  return events.some(
    (event) =>
      event.episodeId === episodeId &&
      event.eventType === "change_set" &&
      event.data.changeSet.id === id &&
      event.data.changeSet.hash === hash,
  );
}

function hasMutationEvent(
  events: readonly CreatorConversationEvent[],
  episodeId: string,
  id: string,
  hash: string,
): boolean {
  return events.some(
    (event) =>
      event.episodeId === episodeId &&
      event.eventType === "mutation" &&
      event.data.attemptId === id &&
      event.data.attemptHash === hash,
  );
}

function hasVerificationEvent(
  events: readonly CreatorConversationEvent[],
  episodeId: string,
  id: string,
  hash: string,
): boolean {
  return events.some(
    (event) =>
      event.episodeId === episodeId &&
      event.eventType === "verification" &&
      event.data.verification.id === id &&
      event.data.verification.hash === hash,
  );
}

function hasReviewEvent(
  events: readonly CreatorConversationEvent[],
  episodeId: string,
  reportHash: string,
): boolean {
  return events.some(
    (event) =>
      event.episodeId === episodeId &&
      event.eventType === "final_review" &&
      event.data.report?.hash === reportHash,
  );
}

function latestEpisodeEvent(
  events: readonly CreatorConversationEvent[],
  episodeId: string,
): CreatorConversationEvent | undefined {
  return events.filter((event) => event.episodeId === episodeId).at(-1);
}

function stateEventOnce(
  events: readonly CreatorConversationEvent[],
  episodeId: string,
  candidate: AppendEventWithoutConversation,
): AppendEventWithoutConversation | undefined {
  const previous = latestEpisodeEvent(events, episodeId);
  if (previous?.eventType === "project_change" && candidate.eventType === "project_change") {
    const state = (
      candidate.data as Extract<CreatorConversationEvent, { eventType: "project_change" }>["data"]
    ).state;
    if (previous.data.state === state) return undefined;
  }
  if (previous?.eventType === "recovery" && candidate.eventType === "recovery") {
    const state = (
      candidate.data as Extract<CreatorConversationEvent, { eventType: "recovery" }>["data"]
    ).state;
    if (previous.data.state === state) return undefined;
  }
  if (previous?.eventType === "source_sync" && candidate.eventType === "source_sync") {
    const status = (
      candidate.data as Extract<CreatorConversationEvent, { eventType: "source_sync" }>["data"]
    ).status;
    if (previous.data.status === status) return undefined;
  }
  if (previous?.eventType === candidate.eventType) return undefined;
  return candidate;
}

async function technicalAttachmentsFromView(
  view: TransactionControlView,
  store: CreatorConversationStore,
): Promise<CreatorTechnicalAttachment[]> {
  const result: CreatorTechnicalAttachment[] = [];
  const fields = view.artifacts ?? {};
  for (const [label, reference] of Object.entries(fields)) {
    if (!reference) continue;
    const body = await store.artifactStore.read(reference);
    result.push({
      role: attachmentRole(label),
      label: humanize(label),
      binding: artifactBodyIdentity(body, reference) ?? unboundTechnicalReference(reference),
    });
  }
  return result;
}

function artifactBodyIdentity(
  body: unknown,
  artifact: ArtifactReference,
): CreatorArtifactBinding | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as { readonly id?: unknown; readonly hash?: unknown };
  if (
    typeof record.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(record.id) ||
    typeof record.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.hash)
  )
    return undefined;
  return {
    id: record.id,
    hash: record.hash,
    artifact,
  };
}

function unboundTechnicalReference(
  artifact: ArtifactReference,
): CreatorTechnicalAttachment["binding"] {
  return {
    kind: "unbound_technical_reference",
    id: `technical_reference:${artifact.artifactHash}`,
    hash: artifact.artifactHash,
    artifact,
  };
}

function attachmentRole(label: string): CreatorConversationAttachment["role"] {
  if (label.includes("plan")) return "plan";
  if (label.includes("changeSet")) return "change_set";
  if (label.includes("verification")) return "verification";
  if (label.includes("runtime")) return "runtime_evidence";
  if (label.includes("mutation")) return "mutation";
  if (label.includes("trace")) return "build_trace";
  if (label.includes("agentRun")) return "agent_run";
  if (label.includes("review")) return "review_report";
  if (label.includes("source")) return "source_consultation";
  if (label.includes("recovery")) return "recovery";
  return "technical_detail";
}

function humanize(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

function conversationCitations(
  conversationId: string,
  agentRunId: string,
  citation: CreatorAgentCitation,
  sourceIndexHash: string | undefined,
): CreatorCitation[] {
  if (citation.subject.kind === "project_fact")
    return [
      sealCreatorCitation({
        id: `creator_citation_${contentHash(`${agentRunId}:${citation.handle}`).slice(0, 24)}`,
        conversationId,
        issuedForAgentRunId: agentRunId,
        handle: citation.handle,
        label: citation.subject.path,
        target: {
          kind: "project_fact",
          projectRevisionHash: citation.projectRevisionHash,
          factKey: `${citation.subject.objectId}:${citation.subject.path}:${citation.subject.className}`,
          factHash: citation.subject.factHash,
        },
        authority: "forge",
      }),
    ];
  if (citation.subject.kind === "memory")
    return [
      sealCreatorCitation({
        id: `creator_citation_${contentHash(`${agentRunId}:${citation.handle}`).slice(0, 24)}`,
        conversationId,
        issuedForAgentRunId: agentRunId,
        handle: citation.handle,
        label: `Creator memory ${citation.subject.memoryItemId}`,
        target: {
          kind: "memory",
          memoryItemId: citation.subject.memoryItemId,
          revisionId: citation.subject.revisionId,
          revisionHash: citation.subject.revisionHash,
        },
        authority: "forge",
      }),
    ];
  if (citation.subject.kind === "prior_evidence")
    return [
      sealCreatorCitation({
        id: `creator_citation_${contentHash(`${agentRunId}:${citation.handle}`).slice(0, 24)}`,
        conversationId,
        issuedForAgentRunId: agentRunId,
        handle: citation.handle,
        label: `Prior evidence ${citation.subject.evidence.id}`,
        target: {
          kind: "prior_evidence",
          eventId: citation.subject.eventId,
          eventHash: citation.subject.eventHash,
          evidence: citation.subject.evidence,
        },
        authority: "forge",
      }),
    ];
  const subject = citation.subject;
  if (!sourceIndexHash)
    throw new Error("Source citation has no exact source-consultation index binding");
  return subject.ranges.map((range, index) =>
    sealCreatorCitation({
      id: `creator_citation_${contentHash(`${agentRunId}:${citation.handle}:${index}`).slice(0, 24)}`,
      conversationId,
      issuedForAgentRunId: agentRunId,
      handle: `${citation.handle}:${index + 1}`,
      label: range.path,
      target: {
        kind: "source_range",
        projectRevisionHash: citation.projectRevisionHash,
        sourceIndexHash,
        sourceHash: range.sourceHash,
        displayPath: range.path,
        startByte: range.startByte,
        endByte: range.endByte,
      },
      authority: "forge",
    }),
  );
}

function exactResponseAttribution(run: AgentRunView, requestedModel: string) {
  const facts = [...run.modelTurns]
    .reverse()
    .find(
      (turn) =>
        turn.responseFacts.resolvedModel !== null && turn.responseFacts.servingProvider !== null,
    )?.responseFacts;
  if (!facts || facts.resolvedModel !== requestedModel || !facts.servingProvider)
    throw new Error("Agent outcome lacks exact model/provider attribution");
  return {
    modelId: facts.resolvedModel,
    providerId: facts.servingProvider,
    ...(facts.responseId ? { responseId: facts.responseId } : {}),
  };
}

function aggregateAgentUsage(run: AgentRunView): {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
} {
  const sum = (field: "inputTokens" | "outputTokens" | "costUsd"): number | null => {
    const values = run.modelTurns.map((turn) => turn.usage[field]);
    return values.every((value): value is number => value !== null)
      ? values.reduce((total, value) => total + value, 0)
      : null;
  };
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    costUsd: sum("costUsd"),
  };
}

function authorizedConversationArtifact(
  conversation: LoadedCreatorConversation,
  hash: string,
): ArtifactReference | undefined {
  const references: ArtifactReference[] = [conversation.head.commit];
  for (const commit of conversation.commits) {
    references.push(commit.conversation, commit.event);
    if (commit.previousCommit) references.push(commit.previousCommit);
    if (commit.episodeSnapshot) references.push(commit.episodeSnapshot);
    if (commit.turn) references.push(commit.turn);
    references.push(...commit.citations.map((citation) => citation.artifact));
    if (commit.memoryRevision) references.push(commit.memoryRevision);
    if (commit.planRevision) references.push(commit.planRevision);
    if (commit.job) references.push(commit.job);
  }
  for (const event of conversation.events)
    references.push(...event.attachments.map((attachment) => attachment.binding.artifact));
  for (const episode of conversation.episodes) references.push(episode.sessionBundle.artifact);
  for (const plan of conversation.planRevisions) {
    references.push(plan.plan.artifact);
    if (plan.sourceConsultation) references.push(plan.sourceConsultation.artifact);
  }
  for (const citation of conversation.citations) {
    if (citation.target.kind === "prior_evidence")
      references.push(citation.target.evidence.artifact);
  }
  for (const job of conversation.jobs) {
    references.push(job.admittedRequest, job.admissionAuthority);
    if (job.conversationContext) references.push(job.conversationContext);
  }
  return references.find((reference) => reference.artifactHash === hash);
}

function authorizedReplayBinding(
  conversations: Iterable<LoadedCreatorConversation>,
  role: "verification" | "mutation",
  id: string,
): CreatorArtifactBinding | undefined {
  for (const conversation of conversations) {
    for (const event of conversation.events) {
      if (role === "verification" && event.eventType === "verification") {
        const binding = event.data.verification;
        if (
          binding.id === id &&
          event.attachments.some(
            (attachment) =>
              attachment.role === role &&
              attachment.binding.id === binding.id &&
              attachment.binding.hash === binding.hash &&
              attachment.binding.artifact.artifactHash === binding.artifact.artifactHash,
          )
        )
          return binding;
      }
      if (role === "mutation" && event.eventType === "mutation") {
        const binding = event.attachments.find(
          (attachment) =>
            attachment.role === role &&
            attachment.binding.id === id &&
            attachment.binding.id === event.data.attemptId &&
            attachment.binding.hash === event.data.attemptHash,
        )?.binding;
        if (binding) return binding;
      }
    }
  }
  return undefined;
}

function findIdempotentJob(
  conversation: LoadedCreatorConversation,
  request: ConversationRequest,
): CreatorWorkJob | undefined {
  const job = conversation.jobs.find(
    (candidate) => candidate.idempotencyKey === request.idempotencyKey,
  );
  if (!job) return undefined;
  assertCreatorWorkJobRequestBinding(job, request);
  return job;
}

function admission(job: CreatorWorkJob, acceptedAt: string): CreatorWorkAdmission {
  return {
    kind: "CreatorWorkAdmission",
    jobId: job.id,
    conversationId: job.conversationId,
    acceptedAt,
  };
}

function identityAdmission(
  job: CreatorProjectIdentityJob,
  acceptedAt: string,
): CreatorWorkAdmission {
  return {
    kind: "CreatorWorkAdmission",
    jobId: job.id,
    conversationId: job.provisionalConversationId,
    acceptedAt,
  };
}

function terminalJobStatus(status: CreatorWorkJob["status"]): boolean {
  return ["outcome_unknown", "succeeded", "failed", "cancelled"].includes(status);
}

function requiredTurnId(job: CreatorWorkJob): string {
  if (!job.turnId) throw new Error("Agent job lost its creator turn binding");
  return job.turnId;
}

function requiredTransactionSessionId(job: CreatorWorkJob): string {
  if (!job.transactionSessionId)
    throw new Error("Agent job lost its preassigned transaction-session binding");
  return job.transactionSessionId;
}

function sessionIdFromSummary(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    !("creatorSessionId" in value) ||
    typeof value.creatorSessionId !== "string"
  )
    throw new Error("Transaction coordinator did not return a creator session identity");
  return value.creatorSessionId;
}

function assertIdentityReceipt(
  receipt: StudioProjectIdentityFinalizationReceipt | undefined,
  operationHash: string,
): asserts receipt is StudioProjectIdentityFinalizationReceipt {
  if (!receipt) throw new Error("Studio project identity did not produce a terminal receipt");
  assertStudioProjectIdentityFinalizationReceipt(receipt);
  if (receipt.operation.hash !== operationHash)
    throw new Error("Studio project identity did not produce the exact committed receipt");
}

function boundedError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  let bytes = 0;
  let bounded = "";
  for (const character of detail) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > 4096) break;
    bounded += character;
  }
  return bounded || "Foreground creator work failed";
}
