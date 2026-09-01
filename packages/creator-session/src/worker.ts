import { join, resolve } from "node:path";
import {
  persistCreatorPhaseAgentRun,
  type AgentRuntime,
  type BudgetPolicy,
} from "../../agent-runtime/src/index.js";
import { ImmutableJsonArtifactStore } from "../../artifact-store/src/index.js";
import type { StudioSnapshotObservation } from "../../semantic-map/src/index.js";
import {
  creatorOrientation,
  runCreatorBuilder,
  runCreatorPlanner,
  type CreatorAgentWorkerDescriptor,
  type CreatorApproval,
  type CreatorBuildContract,
  type CreatorChangeSet,
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
    observation: StudioSnapshotObservation;
    prompt: string;
    budgets: BudgetPolicy;
  }): Promise<CreatorWorkerPlanResult>;
  build(input: {
    session: CreatorSession;
    ownership: StudioOwnershipMap;
    observation: StudioSnapshotObservation;
    prompt: string;
    plan: CreatorPlan;
    planApproval: CreatorApproval;
    verificationFeedback?: readonly string[];
    budgets: BudgetPolicy;
  }): Promise<CreatorWorkerBuildResult>;
}

export type CreatorWorkerPlanResult =
  | {
      status: "sealed";
      plan: CreatorPlan;
      evidence: CreatorSessionBundle["agentRuns"][number];
    }
  | {
      status: "unsealed";
      failure: { code: string; detail: string };
      evidence: CreatorSessionBundle["agentRuns"][number];
    };
export type CreatorWorkerBuildResult =
  | {
      status: "sealed";
      buildContract: CreatorBuildContract;
      changeSet: CreatorChangeSet;
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
    observation: StudioSnapshotObservation;
    prompt: string;
    budgets: BudgetPolicy;
  }): Promise<CreatorWorkerPlanResult> {
    const result = await runCreatorPlanner({ ...input, runtime: this.runtime });
    const phase = await persistCreatorPhaseAgentRun({
      phase: "creator_planner",
      creatorSession: { id: input.session.id, hash: input.session.hash },
      promptHash: input.session.promptHash,
      projectId: input.session.projectId,
      revisionHash: input.session.currentRevisionHash,
      orientation: creatorOrientation({
        session: input.session,
        ownership: input.ownership,
        observation: input.observation,
      }),
      systemPrompt: result.systemPrompt,
      finalization: result.finalization,
      runtime: this.runtime,
      runtimeResult: result.runtimeResult,
      toolHost: result.toolHost,
      budgets: input.budgets,
      directory: join(resolve(this.directory), "agent-runs"),
      traceDirectory: join(resolve(this.directory), "traces"),
      executionWorker: this.descriptor,
    });
    const evidence = await reference(
      phase,
      "creator_planner",
      new ImmutableJsonArtifactStore(resolve(this.directory)),
    );
    if (phase.run.status !== "locally_eligible")
      return {
        status: "unsealed",
        failure: {
          code:
            phase.run.creatorPhaseOutcome?.status === "unsealed"
              ? phase.run.creatorPhaseOutcome.failureCode
              : "CREATOR_PHASE_NOT_ADMITTED",
          detail:
            phase.run.error ??
            "Persisted creator planner evidence did not pass local admission",
        },
        evidence,
      };
    if (result.finalization.status === "unsealed" || !result.plan)
      return {
        status: "unsealed",
        failure: {
          code:
            result.finalization.status === "unsealed"
              ? result.finalization.failureCode
              : "PLAN_NOT_PUBLISHED",
          detail:
            result.finalization.status === "unsealed"
              ? result.finalization.detail
              : "Creator planner did not publish a plan",
        },
        evidence,
      };
    return { status: "sealed", plan: result.plan, evidence };
  }

  async build(input: {
    session: CreatorSession;
    ownership: StudioOwnershipMap;
    observation: StudioSnapshotObservation;
    prompt: string;
    plan: CreatorPlan;
    planApproval: CreatorApproval;
    verificationFeedback?: readonly string[];
    budgets: BudgetPolicy;
  }): Promise<CreatorWorkerBuildResult> {
    const result = await runCreatorBuilder({ ...input, runtime: this.runtime });
    const phase = await persistCreatorPhaseAgentRun({
      phase: "creator_builder",
      creatorSession: { id: input.session.id, hash: input.session.hash },
      promptHash: input.session.promptHash,
      projectId: input.session.projectId,
      revisionHash: input.session.currentRevisionHash,
      orientation: creatorOrientation({
        session: input.session,
        ownership: input.ownership,
        observation: input.observation,
      }),
      systemPrompt: result.systemPrompt,
      finalization: result.finalization,
      runtime: this.runtime,
      runtimeResult: result.runtimeResult,
      toolHost: result.toolHost,
      budgets: input.budgets,
      directory: join(resolve(this.directory), "agent-runs"),
      traceDirectory: join(resolve(this.directory), "traces"),
      executionWorker: this.descriptor,
      creatorBuildContract: {
        id: result.toolHost.contract.id,
        hash: result.toolHost.contract.hash,
      },
    });
    const evidence = await reference(
      phase,
      "creator_builder",
      new ImmutableJsonArtifactStore(resolve(this.directory)),
    );
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
            phase.run.error ??
            "Persisted creator builder evidence did not pass local admission",
        },
        evidence,
      };
    if (result.finalization.status === "unsealed" || !result.changeSet)
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
      changeSet: result.changeSet,
      evidence,
    };
  }
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
    throw new Error(
      "Creator phase trace persistence did not produce content-bound evidence",
    );
  const [agentRun, trace] = await Promise.all([
    store.write(result.run),
    store.write(result.trace),
  ]);
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
