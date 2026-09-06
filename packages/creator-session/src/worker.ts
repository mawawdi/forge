import { join, resolve } from "node:path";
import type { ModelImage } from "../../model-client/src/contracts.js";
import type { GameBuildGraph } from "../../game-compiler/src/index.js";
import {
  AgentExecutionJournalStore,
  assertAgentExecutionSlot,
  createAgentExecutionJournalResume,
  persistCreatorPhaseAgentRun,
  type AgentExecutionSlot,
  type AgentRuntime,
  type BudgetPolicy,
} from "../../agent-runtime/src/index.js";
import { ImmutableJsonArtifactStore } from "../../artifact-store/src/index.js";
import { HostPhaseRecorder } from "../../flight-recorder/src/host-phase.js";
import type { ArtifactReference } from "../../artifact-store/src/index.js";
import { creatorBuildRecoveryBinding, loadCreatorBuildRecovery } from "./build-recovery.js";
import { loadCreatorBuildProposal } from "./build-proposal.js";
import type {
  CreatorSourceConsultation,
  StudioSourceIndex,
  VerifiedSourceResolver,
} from "../../source-intelligence/src/index.js";
import {
  CreatorBuilderToolHost,
  creatorBuilderSystemPrompt,
  creatorOrientation,
  runCreatorBuilder,
  runCreatorPlanner,
  type CreatorAgentContextCitation,
  type CreatorAgentWorkerDescriptor,
  type CreatorAgentOutcome,
  type CreatorApproval,
  type CreatorBuildContract,
  type CreatorSourceWriteBlobCapture,
  type CreatorProjectIndexView,
  type CreatorPlan,
  type CreatorSession,
  type CreatorSessionBundle,
  type StudioOwnershipMap,
} from "./index.js";

export interface CreatorAgentWorker {
  readonly descriptor: CreatorAgentWorkerDescriptor;
  plan(input: {
    session: CreatorSession;
    ownership: StudioOwnershipMap;
    projectIndex: CreatorProjectIndexView;
    sourceIndex: StudioSourceIndex;
    sourceResolver: VerifiedSourceResolver;
    creatorPrompt: string;
    agentPrompt: string;
    initialImages?: readonly ModelImage[];
    contextCitations?: readonly CreatorAgentContextCitation[];
    budgets: BudgetPolicy;
    execution: AgentExecutionSlot;
    /** Continue a durable response boundary in this exact journal. */
    resume?: true;
  }): Promise<CreatorWorkerPlanResult>;
  build(input: {
    session: CreatorSession;
    ownership: StudioOwnershipMap;
    projectIndex: CreatorProjectIndexView;
    sourceIndex: StudioSourceIndex;
    sourceResolver: VerifiedSourceResolver;
    creatorPrompt: string;
    agentPrompt: string;
    initialImages?: readonly ModelImage[];
    plan: CreatorPlan;
    planApproval: CreatorApproval;
    sourceConsultation: CreatorSourceConsultation;
    buildRecovery?: ArtifactReference;
    buildProposal?: ArtifactReference;
    verificationFeedback?: readonly string[];
    budgets: BudgetPolicy;
    execution: AgentExecutionSlot;
  }): Promise<CreatorWorkerBuildResult>;
}

export type CreatorWorkerPlanResult =
  | {
      status: "sealed";
      outcome: CreatorAgentOutcome;
      evidence: CreatorSessionBundle["agentRuns"][number];
      source: CreatorWorkerSourceEvidence;
    }
  | {
      status: "unsealed";
      failure: { code: string; detail: string };
      evidence: CreatorSessionBundle["agentRuns"][number];
      source: CreatorWorkerSourceEvidence;
    };
export interface CreatorWorkerSourceEvidence {
  index: StudioSourceIndex;
  indexArtifact: ArtifactReference;
  consultation: CreatorSourceConsultation;
  consultationArtifact: ArtifactReference;
}
export type CreatorWorkerBuildResult =
  | {
      status: "preparation_failed";
      failure: { stage: "preparation"; code: string; detail: string };
      diagnostic: ArtifactReference;
    }
  | {
      status: "sealed";
      buildContract: CreatorBuildContract;
      graph: GameBuildGraph;
      summary: string;
      sourceWriteBlobs: readonly CreatorSourceWriteBlobCapture[];
      evidence: CreatorSessionBundle["agentRuns"][number];
    }
  | {
      status: "unsealed";
      buildContract: CreatorBuildContract;
      failure: { code: string; detail: string };
      evidence: CreatorSessionBundle["agentRuns"][number];
    };

export class LocalCreatorAgentWorker implements CreatorAgentWorker {
  readonly descriptor: CreatorAgentWorkerDescriptor = {
    kind: "CreatorAgentWorkerDescriptor",
    name: "forge-local-creator-agent-worker",
    environment: "local_process",
    isolation: "none",
  };

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly directory: string,
  ) {}

  async plan(input: {
    session: CreatorSession;
    ownership: StudioOwnershipMap;
    projectIndex: CreatorProjectIndexView;
    sourceIndex: StudioSourceIndex;
    sourceResolver: VerifiedSourceResolver;
    creatorPrompt: string;
    agentPrompt: string;
    initialImages?: readonly ModelImage[];
    contextCitations?: readonly CreatorAgentContextCitation[];
    budgets: BudgetPolicy;
    execution: AgentExecutionSlot;
    resume?: true;
  }): Promise<CreatorWorkerPlanResult> {
    assertWorkerExecution(input.execution, "planner");
    const artifactStore = new ImmutableJsonArtifactStore(resolve(this.directory));
    const journalStore = new AgentExecutionJournalStore(artifactStore);
    const resumeFromJournal = await executionJournalResume(
      journalStore,
      input.execution,
      input.resume === true,
    );
    const result = await runCreatorPlanner({
      session: input.session,
      ownership: input.ownership,
      projectIndex: input.projectIndex,
      sourceIndex: input.sourceIndex,
      sourceResolver: input.sourceResolver,
      creatorPrompt: input.creatorPrompt,
      agentPrompt: input.agentPrompt,
      ...(input.initialImages ? { initialImages: input.initialImages } : {}),
      ...(input.contextCitations ? { contextCitations: input.contextCitations } : {}),
      runtime: this.runtime,
      budgets: input.budgets,
      executionJournal: journalStore.sink(input.execution.journalId),
      ...(resumeFromJournal ? { resumeFromJournal } : {}),
    });
    const executionJournal = await journalStore.load(input.execution.journalId);
    const phase = await persistCreatorPhaseAgentRun({
      agentRunId: input.execution.agentRunId,
      phase: "creator_planner",
      creatorSession: { id: input.session.id, hash: input.session.hash },
      promptHash: input.session.promptHash,
      projectId: input.session.projectId,
      revisionHash: input.session.currentRevisionHash,
      orientation: creatorOrientation({
        session: input.session,
        ownership: input.ownership,
        projectIndex: input.projectIndex,
      }),
      systemPrompt: result.systemPrompt,
      finalization: result.finalization,
      runtime: this.runtime,
      runtimeResult: result.runtimeResult,
      model: input.session.model,
      toolHost: result.toolHost,
      budgets: input.budgets,
      directory: join(resolve(this.directory), "agent-runs"),
      traceDirectory: join(resolve(this.directory), "traces"),
      executionWorker: this.descriptor,
      executionJournal,
    });
    const evidence = await reference(phase, "creator_planner", artifactStore);
    const sourceIndex = result.toolHost.getSourceIndex();
    const sourceConsultation = result.toolHost.getSourceConsultation();
    const source: CreatorWorkerSourceEvidence = {
      index: sourceIndex,
      indexArtifact: await artifactStore.write(sourceIndex),
      consultation: sourceConsultation,
      consultationArtifact: await artifactStore.write(sourceConsultation),
    };
    if (phase.run.status !== "locally_eligible")
      return {
        status: "unsealed",
        failure: {
          code:
            phase.run.creatorPhaseOutcome?.status === "unsealed"
              ? phase.run.creatorPhaseOutcome.failureCode
              : "CREATOR_PHASE_NOT_ADMITTED",
          detail:
            phase.run.error ?? "Persisted creator planner evidence did not pass local admission",
        },
        evidence,
        source,
      };
    if (result.finalization.status === "unsealed" || !result.outcome)
      return {
        status: "unsealed",
        failure: {
          code:
            result.finalization.status === "unsealed"
              ? result.finalization.failureCode
              : "CREATOR_OUTCOME_NOT_PUBLISHED",
          detail:
            result.finalization.status === "unsealed"
              ? result.finalization.detail
              : "Creator agent did not publish an answer, clarification, or plan",
        },
        evidence,
        source,
      };
    return { status: "sealed", outcome: result.outcome, evidence, source };
  }

  async build(input: {
    session: CreatorSession;
    ownership: StudioOwnershipMap;
    projectIndex: CreatorProjectIndexView;
    creatorPrompt: string;
    agentPrompt: string;
    initialImages?: readonly ModelImage[];
    plan: CreatorPlan;
    planApproval: CreatorApproval;
    sourceIndex: StudioSourceIndex;
    sourceResolver: VerifiedSourceResolver;
    sourceConsultation: CreatorSourceConsultation;
    buildRecovery?: ArtifactReference;
    buildProposal?: ArtifactReference;
    verificationFeedback?: readonly string[];
    budgets: BudgetPolicy;
    execution: AgentExecutionSlot;
  }): Promise<CreatorWorkerBuildResult> {
    assertWorkerExecution(
      input.execution,
      input.verificationFeedback === undefined ? "builder" : "repair",
    );
    const artifactStore = new ImmutableJsonArtifactStore(resolve(this.directory));
    const journalStore = new AgentExecutionJournalStore(artifactStore);
    await executionJournalResume(journalStore, input.execution, false);
    const timing = {
      recorder: new HostPhaseRecorder(this.directory),
      correlation: {
        sessionId: input.session.id,
        projectId: input.session.projectId,
        agentRunId: input.execution.agentRunId,
        revisionHash: input.session.currentRevisionHash,
      },
    };
    let prepared: CreatorBuilderToolHost;
    try {
      prepared = await timing.recorder.measure(
        "build_preparation",
        timing.correlation,
        async () => {
          const host = new CreatorBuilderToolHost({ ...input, timing });
          creatorBuilderSystemPrompt(
            input.plan,
            host.contract,
            input.projectIndex,
            input.verificationFeedback,
          );
          if (input.buildProposal) {
            const proposal = await loadCreatorBuildProposal({
              store: artifactStore,
              artifact: input.buildProposal,
              plan: input.plan,
            });
            await host.restoreProposal(proposal);
          }
          if (input.buildRecovery) {
            const recovery = await loadCreatorBuildRecovery({
              store: artifactStore,
              artifact: input.buildRecovery,
              expected: creatorBuildRecoveryBinding({
                session: input.session,
                plan: input.plan,
                approval: input.planApproval,
                contract: host.contract,
              }),
              plan: input.plan,
              approval: input.planApproval,
              contract: host.contract,
            });
            if (JSON.stringify(recovery.initialProposal) !== JSON.stringify(input.buildProposal))
              throw new Error("Recovery initial source proposal binding differs");
            await host.restoreRecovery(recovery);
          }
          return host;
        },
      );
    } catch (error) {
      const failure = {
        stage: "preparation" as const,
        code: "BUILD_PREPARATION_FAILED",
        detail: error instanceof Error ? error.message : String(error),
      };
      const diagnostic = await artifactStore.write({
        kind: "CreatorPreparationDiagnostic",
        execution: input.execution,
        planId: input.plan.id,
        planHash: input.plan.hash,
        approvalHash: input.planApproval.hash,
        revisionHash: input.session.currentRevisionHash,
        failure,
      });
      return { status: "preparation_failed", failure, diagnostic };
    }
    const result = await runCreatorBuilder({
      preparedHost: prepared,
      timing,
      session: input.session,
      ownership: input.ownership,
      projectIndex: input.projectIndex,
      sourceIndex: input.sourceIndex,
      sourceResolver: input.sourceResolver,
      creatorPrompt: input.creatorPrompt,
      agentPrompt: input.agentPrompt,
      ...(input.initialImages ? { initialImages: input.initialImages } : {}),
      plan: input.plan,
      planApproval: input.planApproval,
      sourceConsultation: input.sourceConsultation,
      ...(input.verificationFeedback === undefined
        ? {}
        : { verificationFeedback: input.verificationFeedback }),
      runtime: this.runtime,
      budgets: input.budgets,
      executionJournal: journalStore.sink(input.execution.journalId),
    });
    const executionJournal = await journalStore.load(input.execution.journalId);
    const phase = await persistCreatorPhaseAgentRun({
      agentRunId: input.execution.agentRunId,
      phase: "creator_builder",
      creatorSession: { id: input.session.id, hash: input.session.hash },
      promptHash: input.session.promptHash,
      projectId: input.session.projectId,
      revisionHash: input.session.currentRevisionHash,
      orientation: creatorOrientation({
        session: input.session,
        ownership: input.ownership,
        projectIndex: input.projectIndex,
      }),
      systemPrompt: result.systemPrompt,
      finalization: result.finalization,
      runtime: this.runtime,
      runtimeResult: result.runtimeResult,
      model: input.session.model,
      toolHost: result.toolHost,
      budgets: input.budgets,
      directory: join(resolve(this.directory), "agent-runs"),
      traceDirectory: join(resolve(this.directory), "traces"),
      executionWorker: this.descriptor,
      executionJournal,
      creatorBuildContract: {
        id: result.toolHost.contract.id,
        hash: result.toolHost.contract.hash,
      },
    });
    const evidence = await reference(phase, "creator_builder", artifactStore);
    if (phase.run.status !== "locally_eligible")
      return {
        status: "unsealed",
        buildContract: result.toolHost.contract,
        failure: {
          code:
            phase.run.creatorPhaseOutcome?.status === "unsealed"
              ? phase.run.creatorPhaseOutcome.failureCode
              : "CREATOR_PHASE_NOT_ADMITTED",
          detail:
            phase.run.error ?? "Persisted creator builder evidence did not pass local admission",
        },
        evidence,
      };
    if (result.finalization.status === "unsealed" || !result.graph)
      return {
        status: "unsealed",
        buildContract: result.toolHost.contract,
        failure: {
          code:
            result.finalization.status === "unsealed"
              ? result.finalization.failureCode
              : "CHANGE_SET_NOT_SEALED",
          detail:
            result.finalization.status === "unsealed"
              ? result.finalization.detail
              : "Creator builder did not seal a change set",
        },
        evidence,
      };
    return {
      status: "sealed",
      buildContract: result.toolHost.contract,
      graph: result.graph,
      summary: result.summary!,
      sourceWriteBlobs:
        result.sourceWriteBlobs ??
        (() => {
          throw new Error("Sealed builder result lost source-write blobs");
        })(),
      evidence,
    };
  }
}

function assertWorkerExecution(
  execution: AgentExecutionSlot,
  expectedPurpose: AgentExecutionSlot["purpose"],
): void {
  assertAgentExecutionSlot(execution);
  if (execution.purpose !== expectedPurpose)
    throw new Error(
      `Creator worker expected a ${expectedPurpose} execution slot, received ${execution.purpose}`,
    );
}

async function executionJournalResume(
  store: AgentExecutionJournalStore,
  execution: AgentExecutionSlot,
  resume: boolean,
): Promise<ReturnType<typeof createAgentExecutionJournalResume> | undefined> {
  const journal = await store.loadIfPresent(execution.journalId);
  if (!resume) {
    if (journal !== undefined)
      throw new Error("Preassigned creator execution journal was already dispatched");
    return undefined;
  }
  if (!journal)
    throw new Error("Creator-authorized response resume has no durable execution journal");
  return createAgentExecutionJournalResume(journal);
}

async function reference(
  result: Awaited<ReturnType<typeof persistCreatorPhaseAgentRun>>,
  phase: "creator_planner" | "creator_builder",
  store: ImmutableJsonArtifactStore,
): Promise<CreatorSessionBundle["agentRuns"][number]> {
  if (result.run.origin.kind !== "creator_session")
    throw new Error("Creator phase AgentRun lost its creator-session origin");
  if (!result.run.creatorPhaseOutcome)
    throw new Error("Creator phase AgentRun lost its terminal outcome");
  if (
    result.tracePersistence.status !== "written" ||
    !result.tracePersistence.locator ||
    !result.tracePersistence.artifactHash
  )
    throw new Error("Creator phase trace persistence did not produce content-bound evidence");
  const [agentRun, trace] = await Promise.all([store.write(result.run), store.write(result.trace)]);
  return {
    phase,
    agentRunId: result.run.id,
    agentRun,
    traceId: result.trace.id,
    trace,
    traceBuildKey: result.tracePersistence.buildKey,
    creatorSessionHash: result.run.origin.creatorSessionHash,
    ...(result.run.creatorBuildContract
      ? { buildContract: { ...result.run.creatorBuildContract } }
      : {}),
    outcome: structuredClone(result.run.creatorPhaseOutcome),
  };
}
