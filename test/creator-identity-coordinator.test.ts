import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { CreatorConversationCoordinator } from "../packages/creator-control/src/conversation-coordinator.js";
import type { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import {
  parseOpenRouterModelCatalog,
  unconfirmedCreatorModelCatalog,
} from "../packages/model-client/src/model-registry.js";
import { projectIndexHash } from "../packages/studio-evidence/src/index.js";
import {
  CreatorConversationStore,
  CreatorProjectIdentityJobStore,
  assertCreatorPublishedIdentityContinuityReceipt,
  type CreatorActionRequest,
  type CreatorTurnRequest,
} from "../packages/creator-conversation/src/index.js";
import {
  StudioCommandRejectedError,
  type StudioBridgeConnection,
  type StudioBridgeSession,
} from "../packages/studio-bridge/src/index.js";
import {
  createStudioProjectIdentityFinalizationReceipt,
  createStudioProjectIdentityOperation,
  createStudioProjectIdentityState,
  type BackendToPluginMessage,
} from "../packages/studio-protocol/src/index.js";

const time = "2026-09-03T12:00:00.000Z";
const project = { name: "Identity Coordinator", placeId: 0, universeId: 0 };

function session(): StudioBridgeSession {
  const projectIdentity = createStudioProjectIdentityState({
    project,
    reservedAttribute: { status: "absent" },
  });
  return {
    sessionId: "studio_identity_coordinator",
    projectId: "studio_project_identity_coordinator",
    conversationProjectId: "studio_project_identity_coordinator",
    project,
    projectIdentity,
    projectIdentityTransaction: { status: "none" },
    capabilities: ["project_identity"],
    manifestHash: "1".repeat(64),
    connectorBuildHash: "2".repeat(64),
    capabilityAttestationProjectionHash: "3".repeat(64),
    sessionToken: "identity-session-token",
    connectedAt: time,
  };
}

function publishedSession(
  name: string,
  universeId: number,
  placeId: number,
  sessionId: string,
): StudioBridgeSession {
  const publishedProject = { name, universeId, placeId };
  const projectIdentity = createStudioProjectIdentityState({
    project: publishedProject,
    reservedAttribute: { status: "absent" },
  });
  return {
    ...session(),
    sessionId,
    projectId: `studio_project_${universeId}_${placeId}`,
    conversationProjectId: `published:${universeId}:${placeId}`,
    project: publishedProject,
    projectIdentity,
  };
}

function transactionMock(getSession: () => StudioBridgeSession) {
  return {
    subscribe: () => () => undefined,
    pairedStudio: getSession,
    dashboardState: async () => ({
      kind: "CreatorTransactionState",
      sessions: [],
      stages: [],
      pairedStudio: {
        status: "paired",
        projectId: getSession().projectId,
        projectName: getSession().project.name,
        transactionInventoryStatus: "clear",
        message: "Studio is paired.",
      },
      serverTime: time,
    }),
  } as unknown as CreatorSessionCoordinator;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for identity foreground work");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("project Link admission returns before Studio and idempotently reaches a durable receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-coordinator-"));
  let studio = session();
  let releaseLink!: () => void;
  const linkGate = new Promise<void>((resolve) => {
    releaseLink = resolve;
  });
  const commands: BackendToPluginMessage[] = [];
  const handleCommand = async (message: BackendToPluginMessage): Promise<void> => {
    commands.push(message);
    if (message.type === "LinkStudioProject") {
      await linkGate;
      const afterIdentity = createStudioProjectIdentityState({
        project,
        reservedAttribute: {
          status: "observed",
          forgeProjectId: message.payload.operation.assignedForgeProjectId,
        },
      });
      const receipt = createStudioProjectIdentityFinalizationReceipt({
        operation: message.payload.operation,
        beforeIdentity: message.payload.operation.expectedIdentity,
        afterIdentity,
        recordingId: "identity-coordinator-recording",
        finalization: "ordinary",
        status: "linked",
        completedAt: time,
      });
      studio = {
        ...studio,
        projectId: `studio_project_${message.payload.operation.assignedForgeProjectId}`,
        conversationProjectId: message.payload.operation.assignedForgeProjectId,
        projectIdentity: afterIdentity,
        projectIdentityTransaction: { status: "finalized", receipt },
      };
    } else if (message.type === "AcknowledgeStudioProjectIdentityFinalization") {
      studio = { ...studio, projectIdentityTransaction: { status: "none" } };
    }
  };
  const connection = {
    sendAndWaitForSettlement: handleCommand,
    send: handleCommand,
    subscribeWithSession: () => () => undefined,
    close: async () => undefined,
  } as StudioBridgeConnection;
  const coordinator = new CreatorConversationCoordinator({
    transaction: transactionMock(() => studio),
    connection,
    directory,
    defaultModelId: "openai/gpt-5.6-luna",
    modelCatalog: unconfirmedCreatorModelCatalog(time, "catalog_request_failed"),
    now: () => new Date(time),
  });
  await coordinator.initialize();
  const state = await coordinator.dashboardState();
  const action = state.controlView!.actions.find(
    (candidate) => candidate.actionId === "link_project",
  )!;
  const request: CreatorActionRequest = {
    kind: "CreatorActionRequest",
    conversationId: state.controlView!.conversationId,
    viewId: state.controlView!.id,
    viewHash: state.controlView!.hash,
    actionInstanceId: action.actionInstanceId,
    idempotencyKey: "identity-coordinator-link-0001",
  };
  const admission = await coordinator.submitAction(request);
  assert.match(admission.jobId, /^creator_identity_job_/);
  await waitFor(() => commands.some((command) => command.type === "LinkStudioProject"));
  assert.equal(
    commands.some((command) => command.type === "AcknowledgeStudioProjectIdentityFinalization"),
    false,
  );
  assert.equal(
    (await new CreatorProjectIdentityJobStore(directory).enumerate()).jobs[0]!.job.status,
    "running",
  );

  releaseLink();
  await waitFor(() =>
    commands.some((command) => command.type === "AcknowledgeStudioProjectIdentityFinalization"),
  );
  await waitFor(
    async () =>
      (await new CreatorProjectIdentityJobStore(directory).enumerate()).jobs[0]?.job.status ===
      "succeeded",
  );
  const replay = await coordinator.submitAction(request);
  assert.equal(replay.jobId, admission.jobId);
  assert.equal(commands.filter((command) => command.type === "LinkStudioProject").length, 1);

  const linkedState = await coordinator.dashboardState();
  const linkedConversationId = linkedState.selectedConversationId!;
  assert.equal(linkedState.selectedConversation?.project.kind, "local_linked");
  assert.ok(
    linkedState.controlView?.actions.some((candidate) => candidate.actionId === "fork_project"),
    "an idle linked local place must expose an explicit Fork action",
  );

  const publishedProject = { ...project, placeId: 2468, universeId: 1357 };
  const publishedIdentity = createStudioProjectIdentityState({
    project: publishedProject,
    reservedAttribute: studio.projectIdentity.reservedAttribute,
  });
  studio = {
    ...studio,
    project: publishedProject,
    projectId: "studio_project_published_identity",
    conversationProjectId: "published:1357:2468",
    projectIdentity: publishedIdentity,
  };
  const staleFork = linkedState.controlView!.actions.find(
    (candidate) => candidate.actionId === "fork_project",
  )!;
  await assert.rejects(
    coordinator.submitAction({
      kind: "CreatorActionRequest",
      conversationId: linkedConversationId,
      viewId: linkedState.controlView!.id,
      viewHash: linkedState.controlView!.hash,
      actionInstanceId: staleFork.actionInstanceId,
      idempotencyKey: "identity-coordinator-stale-local-action-0001",
    }),
    /open and pair this project/i,
  );
  const publishedState = await coordinator.dashboardState(linkedConversationId);
  assert.match(publishedState.controlView?.title ?? "", /now published/);
  const continueAction = publishedState.controlView!.actions.find(
    (candidate) => candidate.actionId === "continue_published_project",
  )!;
  const continuityRequest: CreatorActionRequest = {
    kind: "CreatorActionRequest",
    conversationId: linkedConversationId,
    viewId: publishedState.controlView!.id,
    viewHash: publishedState.controlView!.hash,
    actionInstanceId: continueAction.actionInstanceId,
    idempotencyKey: "identity-coordinator-published-continuity-0001",
  };
  await coordinator.submitAction(continuityRequest);
  const conversationStore = new CreatorConversationStore(directory);
  await waitFor(async () => {
    const loaded = await conversationStore.load(linkedConversationId);
    return loaded.conversation.project.kind === "published";
  });
  const continued = await conversationStore.load(linkedConversationId);
  const continuityEvent = continued.events.find(
    (event) =>
      event.eventType === "project_identity" && event.data.state === "published_continuity",
  );
  assert.ok(continuityEvent && continuityEvent.eventType === "project_identity");
  const continuityReceipt = await conversationStore.artifactStore.read(
    continuityEvent.data.continuityReceipt!.artifact,
    assertCreatorPublishedIdentityContinuityReceipt,
  );
  assert.equal(continuityReceipt.choice, "continue_conversation");
  assert.deepEqual(continued.conversation.project, {
    kind: "published",
    universeId: "1357",
    placeId: "2468",
  });
  coordinator.close();
});

test("concurrent distinct Link admissions from one stale view produce one durable operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-admission-race-"));
  const studio = session();
  const commands: BackendToPluginMessage[] = [];
  const rejectCommand = async (message: BackendToPluginMessage): Promise<void> => {
    commands.push(message);
    throw new Error("Synthetic connector interruption after durable dispatch intent");
  };
  const coordinator = new CreatorConversationCoordinator({
    transaction: transactionMock(() => studio),
    connection: {
      sendAndWaitForSettlement: rejectCommand,
      send: rejectCommand,
      subscribeWithSession: () => () => undefined,
      close: async () => undefined,
    } as StudioBridgeConnection,
    directory,
    defaultModelId: "openai/gpt-5.6-luna",
    modelCatalog: unconfirmedCreatorModelCatalog(time, "catalog_request_failed"),
    now: () => new Date(time),
  });
  await coordinator.initialize();
  const state = await coordinator.dashboardState();
  const action = state.controlView!.actions.find(
    (candidate) => candidate.actionId === "link_project",
  )!;
  const request = (idempotencyKey: string): CreatorActionRequest => ({
    kind: "CreatorActionRequest",
    conversationId: state.controlView!.conversationId,
    viewId: state.controlView!.id,
    viewHash: state.controlView!.hash,
    actionInstanceId: action.actionInstanceId,
    idempotencyKey,
  });

  const outcomes = await Promise.allSettled([
    coordinator.submitAction(request("identity-concurrent-link-0001")),
    coordinator.submitAction(request("identity-concurrent-link-0002")),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  await waitFor(() => commands.some((command) => command.type === "LinkStudioProject"));
  await coordinator.close();

  const jobs = (await new CreatorProjectIdentityJobStore(directory).enumerate()).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(commands.filter((command) => command.type === "LinkStudioProject").length, 1);
});

test("historical project selection is read-only and cached authority dies after a Studio switch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-project-boundary-"));
  let studio = publishedSession("Project A", 1001, 2001, "studio_project_a");
  const dashboardSelections: Array<string | undefined> = [];
  const transaction = {
    subscribe: () => () => undefined,
    pairedStudio: () => studio,
    dashboardState: async (sessionId?: string) => {
      dashboardSelections.push(sessionId);
      return {
        kind: "CreatorTransactionState",
        sessions: [],
        stages: [],
        pairedStudio: {
          status: "paired",
          projectId: studio.projectId,
          projectName: studio.project.name,
          transactionInventoryStatus: "clear",
          message: "Studio is paired.",
        },
        serverTime: time,
      };
    },
  } as unknown as CreatorSessionCoordinator;
  const coordinator = new CreatorConversationCoordinator({
    transaction,
    connection: {} as StudioBridgeConnection,
    directory,
    defaultModelId: "openai/gpt-5.6-luna",
    modelCatalog: unconfirmedCreatorModelCatalog(time, "catalog_request_failed"),
    now: () => new Date(time),
  });
  await coordinator.initialize();
  const projectA = await coordinator.dashboardState();
  const projectAId = projectA.selectedConversationId!;
  const cachedView = projectA.controlView!;
  const turnContract = cachedView.turnContract!;
  const remember = cachedView.actions.find((candidate) => candidate.actionId === "remember")!;

  studio = publishedSession("Project B", 1002, 2002, "studio_project_b");
  const projectB = await coordinator.dashboardState();
  assert.notEqual(projectB.selectedConversationId, projectAId);
  const historical = await coordinator.dashboardState(projectAId);
  assert.equal(historical.controlView?.title, "Open this project to continue");
  assert.deepEqual(historical.controlView?.actions, []);
  assert.equal(historical.controlView?.turnContract, undefined);
  assert.equal(dashboardSelections.at(-1), undefined);

  const staleTurn: CreatorTurnRequest = {
    kind: "CreatorTurnRequest",
    conversationId: projectAId,
    turnContractId: turnContract.id,
    turnContractHash: turnContract.hash,
    turnKind: "new_work",
    text: "Change project A after project B was paired.",
    selectedModelId: "openai/gpt-5.6-luna",
    idempotencyKey: "stale-project-turn-0001",
  };
  await assert.rejects(coordinator.submitTurn(staleTurn), /open and pair this project/i);
  const staleAction: CreatorActionRequest = {
    kind: "CreatorActionRequest",
    conversationId: projectAId,
    viewId: cachedView.id,
    viewHash: cachedView.hash,
    actionInstanceId: remember.actionInstanceId,
    idempotencyKey: "stale-project-action-0001",
    input: { text: "Remember the stale project.", memoryCategory: "goal" },
  };
  await assert.rejects(coordinator.submitAction(staleAction), /open and pair this project/i);
  studio = session();
  const unlinked = await coordinator.dashboardState(projectAId);
  assert.match(unlinked.controlView?.conversationId ?? "", /^pairing_/);
  assert.notEqual(unlinked.controlView?.conversationId, projectAId);
  await coordinator.close();
});

test("concurrent first reads publish one deterministic conversation head", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-first-read-race-"));
  const pairing: { studio?: StudioBridgeSession } = {};
  const transaction = {
    subscribe: () => () => undefined,
    pairedStudio: () => pairing.studio,
    dashboardState: async () => ({
      kind: "CreatorTransactionState",
      sessions: [],
      stages: [],
      pairedStudio: pairing.studio
        ? {
            status: "paired",
            projectId: pairing.studio.projectId,
            projectName: pairing.studio.project.name,
            transactionInventoryStatus: "clear",
            message: "Studio is paired.",
          }
        : {
            status: "unpaired",
            transactionInventoryStatus: "unknown",
            message: "Studio is not paired.",
          },
      serverTime: time,
    }),
  } as unknown as CreatorSessionCoordinator;
  const coordinator = new CreatorConversationCoordinator({
    transaction,
    connection: {} as StudioBridgeConnection,
    directory,
    defaultModelId: "openai/gpt-5.6-luna",
    modelCatalog: unconfirmedCreatorModelCatalog(time, "catalog_request_failed"),
    now: () => new Date(time),
  });
  await coordinator.initialize();
  pairing.studio = publishedSession("Concurrent Project", 3001, 4001, "studio_project_concurrent");
  const [left, right] = await Promise.all([
    coordinator.dashboardState(),
    coordinator.dashboardState(),
  ]);
  assert.equal(left.selectedConversationId, right.selectedConversationId);
  const enumeration = await new CreatorConversationStore(directory).enumerate();
  assert.equal(enumeration.corrupt.length, 0);
  assert.equal(enumeration.conversations.length, 1);
  assert.equal(enumeration.conversations[0]?.head.sequence, 1);
  await coordinator.close();
});

test("job admission authority and host context are authenticated conversation artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-conversation-artifact-graph-"));
  const studio = publishedSession("Artifact Project", 5001, 6001, "studio_project_artifact");
  let replayCalls = 0;
  const transaction = {
    subscribe: () => () => undefined,
    pairedStudio: () => studio,
    dashboardState: async () => ({
      kind: "CreatorTransactionState",
      sessions: [],
      stages: [],
      pairedStudio: {
        status: "paired",
        projectId: studio.projectId,
        projectName: studio.project.name,
        transactionInventoryStatus: "clear",
        message: "Studio is paired.",
      },
      serverTime: time,
    }),
    action: async () => {
      throw new Error("Deliberate no-provider transaction stop");
    },
    replayVerification: async () => {
      replayCalls += 1;
      return {};
    },
    replayMutation: async () => {
      replayCalls += 1;
      return {};
    },
  } as unknown as CreatorSessionCoordinator;
  const catalog = parseOpenRouterModelCatalog(
    {
      data: [
        "meta/muse-spark-1.3-contributor",
        "z-ai/glm-5.3-flash",
        "deepseek/deepseek-v4-flash-0731",
        "openai/gpt-5.6-luna",
      ].map((id) => ({ id, supported_parameters: ["tools"] })),
    },
    time,
  );
  const coordinator = new CreatorConversationCoordinator({
    transaction,
    connection: {} as StudioBridgeConnection,
    directory,
    defaultModelId: "openai/gpt-5.6-luna",
    modelCatalog: catalog,
    now: () => new Date(time),
  });
  await coordinator.initialize();
  const state = await coordinator.dashboardState();
  const contract = state.controlView!.turnContract!;
  await coordinator.submitTurn({
    kind: "CreatorTurnRequest",
    conversationId: state.selectedConversationId,
    turnContractId: contract.id,
    turnContractHash: contract.hash,
    turnKind: "new_work",
    text: "Inspect this request without dispatching a provider.",
    selectedModelId: "openai/gpt-5.6-luna",
    idempotencyKey: "artifact-graph-turn-0001",
  });
  const store = new CreatorConversationStore(directory);
  let job: Awaited<ReturnType<typeof store.load>>["jobs"][number] | undefined;
  await waitFor(async () => {
    job = (await store.load(state.selectedConversationId!)).jobs.at(-1);
    return job?.conversationContext !== undefined && job.status === "failed";
  });
  assert.ok(job?.conversationContext);
  assert.equal(
    (
      (await coordinator.readAuthorizedArtifact(job.admittedRequest.artifactHash)) as {
        kind: string;
      }
    ).kind,
    "CreatorTurnRequest",
  );
  assert.equal(
    (
      (await coordinator.readAuthorizedArtifact(job.admissionAuthority.artifactHash)) as {
        kind: string;
      }
    ).kind,
    "CreatorTurnContract",
  );
  assert.equal(
    (
      (await coordinator.readAuthorizedArtifact(job.conversationContext.artifactHash)) as {
        kind: string;
      }
    ).kind,
    "CreatorConversationContext",
  );
  const unrelated = await store.artifactStore.write({ kind: "UnrelatedEvidence", value: true });
  await assert.rejects(
    coordinator.readAuthorizedArtifact(unrelated.artifactHash),
    /not referenced by verified conversation or identity job history/i,
  );
  await assert.rejects(
    coordinator.replayVerification("verification_not_linked"),
    /not referenced/i,
  );
  await assert.rejects(coordinator.replayMutation("mutation_not_linked"), /not referenced/i);
  assert.equal(replayCalls, 0);
  await coordinator.close();
});

test("a proven no-effect rejection preserves the error and requires an exact explicit retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-rejection-retry-"));
  let studio = session();
  const commands: BackendToPluginMessage[] = [];
  let reject = true;
  const detail = "project identity operation connector epoch mismatch";
  const send = async (message: BackendToPluginMessage): Promise<void> => {
    commands.push(message);
    if (message.type === "LinkStudioProject") {
      if (reject) {
        throw new StudioCommandRejectedError(message, {
          commandMessageId: message.messageId,
          commandHash: contentHash(stableJson(message)),
          disposition: "rejected",
          classification: "STUDIO_FAILURE",
          detail,
          identityRejection: {
            kind: "StudioProjectIdentityRejectionEvidence",
            operationId: message.payload.operation.id,
            operationHash: message.payload.operation.hash,
            status: "observed",
            identity: studio.projectIdentity,
            transaction: { status: "none" },
            recordingState: "not_open",
          },
        });
      }
      const afterIdentity = createStudioProjectIdentityState({
        project,
        reservedAttribute: {
          status: "observed",
          forgeProjectId: message.payload.operation.assignedForgeProjectId,
        },
      });
      const receipt = createStudioProjectIdentityFinalizationReceipt({
        operation: message.payload.operation,
        beforeIdentity: message.payload.operation.expectedIdentity,
        afterIdentity,
        recordingId: "retry-identity-recording",
        finalization: "ordinary",
        status: "linked",
        completedAt: time,
      });
      studio = {
        ...studio,
        projectIdentity: afterIdentity,
        projectIdentityTransaction: { status: "finalized", receipt },
      };
    } else if (message.type === "AcknowledgeStudioProjectIdentityFinalization") {
      studio = { ...studio, projectIdentityTransaction: { status: "none" } };
    }
  };
  const options = {
    transaction: transactionMock(() => studio),
    connection: {
      send,
      sendAndWaitForSettlement: send,
      subscribeWithSession: () => () => undefined,
      close: async () => undefined,
    } as StudioBridgeConnection,
    directory,
    defaultModelId: "openai/gpt-5.6-luna",
    modelCatalog: unconfirmedCreatorModelCatalog(time, "catalog_request_failed"),
    now: () => new Date(time),
  } as const;
  let coordinator = new CreatorConversationCoordinator(options);
  await coordinator.initialize();
  const initial = (await coordinator.dashboardState()).controlView!;
  const request: CreatorActionRequest = {
    kind: "CreatorActionRequest",
    conversationId: initial.conversationId,
    viewId: initial.id,
    viewHash: initial.hash,
    actionInstanceId: initial.actions[0]!.actionInstanceId,
    idempotencyKey: "identity-rejected-initial-0001",
  };
  const admitted = await coordinator.submitAction(request);
  const store = new CreatorProjectIdentityJobStore(directory);
  await waitFor(async () => (await store.load(admitted.jobId)).job.status === "failed");
  const failed = await store.load(admitted.jobId);
  assert.equal(failed.job.phase, "command_rejected");
  assert.match(failed.job.failure!.detail, /connector epoch mismatch/);
  assert.equal(failed.job.failure!.detailHash, contentHash(failed.job.failure!.detail));
  assert.deepEqual(
    await coordinator.readAuthorizedArtifact(failed.head.snapshot.artifactHash),
    failed.job,
  );
  assert.equal(
    (
      (await coordinator.readAuthorizedArtifact(failed.job.operation.artifact.artifactHash)) as {
        hash: string;
      }
    ).hash,
    failed.job.operation.hash,
  );
  assert.equal(commands.filter((command) => command.type === "LinkStudioProject").length, 1);
  await coordinator.close();

  coordinator = new CreatorConversationCoordinator(options);
  await coordinator.initialize();
  const view = (await coordinator.dashboardState()).controlView!;
  assert.match(view.detail, /connector epoch mismatch/);
  assert.deepEqual(
    view.actions.map((action) => action.label),
    ["Retry linking"],
  );
  assert.equal(commands.length, 1, "restart never retries the mutation");
  await assert.rejects(
    coordinator.submitAction({ ...request, idempotencyKey: "identity-stale-link-0001" }),
    /stale|binding|current/i,
  );
  reject = false;
  const retried = await coordinator.submitAction({
    kind: "CreatorActionRequest",
    conversationId: view.conversationId,
    viewId: view.id,
    viewHash: view.hash,
    actionInstanceId: view.actions[0]!.actionInstanceId,
    idempotencyKey: "identity-explicit-retry-0001",
  });
  await waitFor(async () => (await store.load(retried.jobId)).job.status === "succeeded");
  assert.equal(commands.filter((command) => command.type === "LinkStudioProject").length, 2);
  await coordinator.close();
});

test("stale clear inventory is not no-effect proof after an unknown identity outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-unknown-outcome-"));
  const studio = session();
  let dispatches = 0;
  const send = async () => {
    dispatches++;
    throw new Error("transport closed before exact settlement");
  };
  const coordinator = new CreatorConversationCoordinator({
    transaction: transactionMock(() => studio),
    connection: {
      send,
      sendAndWaitForSettlement: send,
      subscribeWithSession: () => () => undefined,
      close: async () => undefined,
    } as StudioBridgeConnection,
    directory,
    defaultModelId: "openai/gpt-5.6-luna",
    modelCatalog: unconfirmedCreatorModelCatalog(time, "catalog_request_failed"),
    now: () => new Date(time),
  });
  await coordinator.initialize();
  const initial = (await coordinator.dashboardState()).controlView!;
  const admitted = await coordinator.submitAction({
    kind: "CreatorActionRequest",
    conversationId: initial.conversationId,
    viewId: initial.id,
    viewHash: initial.hash,
    actionInstanceId: initial.actions[0]!.actionInstanceId,
    idempotencyKey: "identity-unknown-initial-0001",
  });
  const store = new CreatorProjectIdentityJobStore(directory);
  await waitFor(async () => (await store.load(admitted.jobId)).job.status === "outcome_unknown");
  const view = (await coordinator.dashboardState()).controlView!;
  assert.equal(view.status, "recovery_required");
  assert.match(view.detail, /transport closed/);
  assert.match(view.detail, /Re-pair/);
  assert.equal(view.actions.length, 0);
  assert.equal(view.technicalAttachments.length, 2);
  assert.equal(dispatches, 1);
  await coordinator.close();
});

test("unreadable identity history blocks admission without hiding the recovery reason", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-unreadable-"));
  await mkdir(join(directory, "identity-jobs"), { mode: 0o700 });
  await writeFile(
    join(directory, "identity-jobs", "creator_identity_job_unreadable.head.json"),
    "{}\n",
    { mode: 0o600 },
  );
  const studio = session();
  let dispatches = 0;
  const send = async () => {
    dispatches++;
  };
  const coordinator = new CreatorConversationCoordinator({
    transaction: transactionMock(() => studio),
    connection: {
      send,
      sendAndWaitForSettlement: send,
      subscribeWithSession: () => () => undefined,
      close: async () => undefined,
    } as StudioBridgeConnection,
    directory,
    defaultModelId: "openai/gpt-5.6-luna",
    modelCatalog: unconfirmedCreatorModelCatalog(time, "catalog_request_failed"),
    now: () => new Date(time),
  });
  await coordinator.initialize();
  const view = (await coordinator.dashboardState()).controlView!;
  assert.equal(view.status, "recovery_required");
  assert.match(view.detail, /cannot read retained project identity jobs/);
  assert.equal(view.actions.length, 0);
  assert.equal(view.turnContract, undefined);
  assert.equal(dispatches, 0);
  await coordinator.close();
});

test("an orphaned identity cursor cannot authorize a new Link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-orphaned-"));
  const base = session();
  const operation = createStudioProjectIdentityOperation({
    action: "link",
    project,
    expectedIdentity: base.projectIdentity,
    connectorEpoch: "1".repeat(64),
    assignedForgeProjectId: `forge_project_${"3".repeat(32)}`,
  });
  const studio: StudioBridgeSession = {
    ...base,
    projectIdentityTransaction: {
      status: "pending",
      operation,
      phase: "opening",
      cursorHash: "4".repeat(64),
      recordingState: "unknown",
    },
  };
  const coordinator = new CreatorConversationCoordinator({
    transaction: transactionMock(() => studio),
    connection: {
      send: async () => {
        throw new Error("must not send");
      },
      subscribeWithSession: () => () => undefined,
      close: async () => undefined,
    } as unknown as StudioBridgeConnection,
    directory,
    defaultModelId: "openai/gpt-5.6-luna",
    modelCatalog: unconfirmedCreatorModelCatalog(time, "catalog_request_failed"),
    now: () => new Date(time),
  });
  await coordinator.initialize();
  const view = (await coordinator.dashboardState()).controlView!;
  assert.equal(view.actions.length, 0);
  await coordinator.close();
});

test("a pairing switch between admission and dispatch sends no identity command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-dispatch-race-"));
  let studio = session();
  let dispatches = 0;
  const send = async () => {
    dispatches++;
  };
  const coordinator = new CreatorConversationCoordinator({
    transaction: transactionMock(() => studio),
    connection: {
      send,
      sendAndWaitForSettlement: send,
      subscribeWithSession: () => () => undefined,
      close: async () => undefined,
    } as StudioBridgeConnection,
    directory,
    defaultModelId: "openai/gpt-5.6-luna",
    modelCatalog: unconfirmedCreatorModelCatalog(time, "catalog_request_failed"),
    now: () => new Date(time),
  });
  await coordinator.initialize();
  const view = (await coordinator.dashboardState()).controlView!;
  let invalidations = 0;
  coordinator.subscribe(() => {
    if (++invalidations === 2) studio = { ...studio, sessionId: "studio_new_pairing" };
  });
  const admission = await coordinator.submitAction({
    kind: "CreatorActionRequest",
    conversationId: view.conversationId,
    viewId: view.id,
    viewHash: view.hash,
    actionInstanceId: view.actions[0]!.actionInstanceId,
    idempotencyKey: "identity-switch-before-dispatch",
  });
  const store = new CreatorProjectIdentityJobStore(directory);
  await waitFor(async () => (await store.load(admission.jobId)).job.status === "failed");
  const job = (await store.load(admission.jobId)).job;
  assert.equal(dispatches, 0);
  assert.equal(job.phase, "resume_required");
  assert.equal(job.failure?.code, "identity_dispatch_not_started");
  assert.match(job.failure?.detail ?? "", /Paired Studio changed/);
  await coordinator.close();
});

test("an interrupted opening identity intent is explicitly abandoned only after no-effect proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-identity-opening-recovery-"));
  let studio = session();
  let tick = 0;
  const now = () => new Date(Date.parse(time) + tick++ * 1_000);
  const commands: BackendToPluginMessage[] = [];
  const handleCommand = async (message: BackendToPluginMessage): Promise<void> => {
    commands.push(message);
    if (message.type === "LinkStudioProject") {
      const cursor = {
        kind: "StudioProjectIdentityTransactionCursor" as const,
        operation: message.payload.operation,
        beforeIdentity: message.payload.operation.expectedIdentity,
        phase: "opening" as const,
      };
      studio = {
        ...studio,
        projectIdentityTransaction: {
          status: "pending",
          operation: message.payload.operation,
          phase: "opening",
          cursorHash: projectIndexHash(cursor),
          recordingState: "not_open",
        },
      };
      throw new Error("injected transport loss after durable opening intent");
    }
    if (message.type === "AbandonOpeningStudioProjectIdentity") {
      assert.equal(studio.projectIdentityTransaction.status, "pending");
      assert.equal(message.payload.operationHash, studio.projectIdentityTransaction.operation.hash);
      assert.equal(
        message.payload.transactionCursorHash,
        studio.projectIdentityTransaction.cursorHash,
      );
      const receipt = createStudioProjectIdentityFinalizationReceipt({
        operation: studio.projectIdentityTransaction.operation,
        beforeIdentity: studio.projectIdentityTransaction.operation.expectedIdentity,
        afterIdentity: studio.projectIdentity,
        finalization: "recovery_abandon",
        status: "cancelled",
        completedAt: time,
      });
      studio = {
        ...studio,
        projectIdentityTransaction: { status: "finalized", receipt },
      };
    } else if (message.type === "AcknowledgeStudioProjectIdentityFinalization") {
      studio = { ...studio, projectIdentityTransaction: { status: "none" } };
    }
  };
  const coordinator = new CreatorConversationCoordinator({
    transaction: transactionMock(() => studio),
    connection: {
      sendAndWaitForSettlement: handleCommand,
      send: handleCommand,
      subscribeWithSession: () => () => undefined,
      close: async () => undefined,
    } as StudioBridgeConnection,
    directory,
    defaultModelId: "openai/gpt-5.6-luna",
    modelCatalog: unconfirmedCreatorModelCatalog(time, "catalog_request_failed"),
    now,
  });
  await coordinator.initialize();
  const initial = await coordinator.dashboardState();
  const link = initial.controlView!.actions.find(
    (candidate) => candidate.actionId === "link_project",
  )!;
  await coordinator.submitAction({
    kind: "CreatorActionRequest",
    conversationId: initial.controlView!.conversationId,
    viewId: initial.controlView!.id,
    viewHash: initial.controlView!.hash,
    actionInstanceId: link.actionInstanceId,
    idempotencyKey: "identity-opening-link-0001",
  });
  await waitFor(
    async () =>
      (await new CreatorProjectIdentityJobStore(directory).enumerate()).jobs[0]?.job.status ===
      "outcome_unknown",
  );

  studio = {
    ...studio,
    sessionId: "studio_identity_coordinator_repaired",
    sessionToken: "identity-session-token-repaired",
  };
  const recovery = await coordinator.dashboardState();
  assert.equal(studio.projectIdentityTransaction.status, "pending");
  const abandon = recovery.controlView!.actions.find(
    (candidate) => candidate.actionId === "cancel_recovery",
  );
  assert.equal(abandon?.label, "Abandon interrupted identity intent");
  await coordinator.submitAction({
    kind: "CreatorActionRequest",
    conversationId: recovery.controlView!.conversationId,
    viewId: recovery.controlView!.id,
    viewHash: recovery.controlView!.hash,
    actionInstanceId: abandon!.actionInstanceId,
    idempotencyKey: "identity-opening-abandon-0001",
  });
  await waitFor(async () => {
    const jobs = (await new CreatorProjectIdentityJobStore(directory).enumerate()).jobs;
    return jobs.some(
      (candidate) =>
        candidate.job.executionMode === "recover_abandon" && candidate.job.status === "succeeded",
    );
  });
  assert.deepEqual(studio.projectIdentityTransaction, { status: "none" });
  assert.equal(studio.projectIdentity.reservedAttribute.status, "absent");
  assert.equal(
    commands.filter((command) => command.type === "LinkStudioProject").length,
    1,
    "opening recovery must never retry the identity mutation",
  );
  assert.equal(
    commands.filter((command) => command.type === "AbandonOpeningStudioProjectIdentity").length,
    1,
  );
  coordinator.close();
});
