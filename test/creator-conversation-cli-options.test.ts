import assert from "node:assert/strict";
import test from "node:test";
import {
  createCreatorActionCommandRequest,
  createCreatorTurnCommandRequest,
  creatorActionCommandInput,
  parseCreatorActionCommandOptions,
  parseCreatorTurnCommandOptions,
} from "../packages/cli/src/creator-conversation-options.js";
import { submitCreatorControlWork } from "../packages/cli/src/creator-control-client.js";
import {
  assertCreatorDashboardState,
  sealCreatorControlView,
  sealCreatorModelRegistry,
  sealCreatorProjectConversation,
  sealCreatorTurnContract,
  type CreatorControlActionDescriptor,
  type CreatorDashboardState,
} from "../packages/creator-conversation/src/index.js";

const NOW = "2026-09-03T10:00:00.000Z";
const MODEL = "openai/gpt-5.6-luna";
const MEMORY_HASH = "b".repeat(64);

test("creator turn parser preserves exact text and selects only an available registered model", () => {
  const parsed = parseCreatorTurnCommandOptions([
    "creator_conversation_cli",
    "--prompt",
    "  Keep this exact message.\n",
    "--model",
    MODEL,
    "--kind",
    "follow_up",
  ]);
  assert.equal(parsed.valid, true);
  if (!parsed.valid || parsed.prompt === undefined) throw new Error("Expected valid turn options");
  const request = createCreatorTurnCommandRequest({
    state: stateFor(),
    ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
    turnKind: parsed.turnKind!,
    text: parsed.prompt,
    selectedModelId: parsed.model!,
    idempotencyKey: "creator-cli-turn-0001",
  });
  assert.equal(request.text, "  Keep this exact message.\n");
  assert.equal(request.selectedModelId, MODEL);
  assert.equal(request.conversationId, "creator_conversation_cli");

  assert.equal(parseCreatorTurnCommandOptions(["--prompt", "one", "--prompt", "two"]).valid, false);
  assert.throws(
    () =>
      createCreatorTurnCommandRequest({
        state: stateFor(),
        text: " \n ",
        idempotencyKey: "creator-cli-turn-0002",
      }),
    /non-whitespace/i,
  );
  assert.throws(
    () =>
      createCreatorTurnCommandRequest({
        state: stateFor(),
        text: "Use an unavailable engine.",
        selectedModelId: "openai/not-in-the-current-registry",
        idempotencyKey: "creator-cli-turn-0003",
      }),
    /unavailable/i,
  );
});

test("creator actions derive descriptor-bound text, report, memory target, and category inputs", () => {
  const remembered = parseCreatorActionCommandOptions([
    "--text",
    "  Keep blue doors quiet.\n",
    "--memory-category",
    "convention",
  ]);
  assert.equal(remembered.valid, true);
  const rememberRequest = createCreatorActionCommandRequest({
    state: stateFor(memoryAction("remember", "none", "memory")),
    conversationId: "creator_conversation_cli",
    actionInstanceId: "creator_action_remember",
    commandInput: creatorActionCommandInput(remembered)!,
    memoryCategory: remembered.memoryCategory!,
    idempotencyKey: "creator-cli-action-remember",
  });
  assert.deepEqual(rememberRequest.input, {
    text: "  Keep blue doors quiet.\n",
    memoryCategory: "convention",
  });

  const correction = parseCreatorActionCommandOptions([
    "--text",
    "  Doors should pulse amber.\n",
    "--memory-item-id",
    "creator_memory_item_cli",
    "--memory-revision-id",
    "creator_memory_revision_cli",
    "--memory-revision-hash",
    MEMORY_HASH,
    "--memory-category",
    "goal",
  ]);
  assert.equal(correction.valid, true);
  const correctionRequest = createCreatorActionCommandRequest({
    state: stateFor(memoryAction("correct_memory", "memory_head", "memory")),
    conversationId: "creator_conversation_cli",
    actionInstanceId: "creator_action_correct_memory",
    commandInput: creatorActionCommandInput(correction)!,
    memoryTarget: {
      itemId: correction.memoryItemId!,
      revisionId: correction.memoryRevisionId!,
      revisionHash: correction.memoryRevisionHash!,
    },
    memoryCategory: correction.memoryCategory!,
    idempotencyKey: "creator-cli-action-correct",
  });
  assert.deepEqual(correctionRequest.target, {
    kind: "memory_head",
    itemId: "creator_memory_item_cli",
    revisionId: "creator_memory_revision_cli",
    revisionHash: MEMORY_HASH,
  });
  assert.deepEqual(correctionRequest.input, {
    text: "  Doors should pulse amber.\n",
    memoryCategory: "goal",
  });

  const report = parseCreatorActionCommandOptions(["--report", "  It worked in Play.\n"]);
  assert.equal(report.valid, true);
  const reportRequest = createCreatorActionCommandRequest({
    state: stateFor(memoryAction("keep_changes", "none", "report")),
    conversationId: "creator_conversation_cli",
    actionInstanceId: "creator_action_keep_changes",
    commandInput: creatorActionCommandInput(report)!,
    idempotencyKey: "creator-cli-action-report",
  });
  assert.deepEqual(reportRequest.input, { report: "  It worked in Play.\n" });

  assert.throws(
    () =>
      createCreatorActionCommandRequest({
        state: stateFor(memoryAction("correct_memory", "memory_head", "memory")),
        conversationId: "creator_conversation_cli",
        actionInstanceId: "creator_action_correct_memory",
        commandInput: { field: "text", value: "Correct this." },
        idempotencyKey: "creator-cli-action-missing-target",
      }),
    /memory target/i,
  );
  assert.equal(
    parseCreatorActionCommandOptions([
      "--memory-item-id",
      "creator_memory_item_cli",
      "--memory-revision-id",
      "creator_memory_revision_cli",
    ]).valid,
    false,
  );
});

test("creator actions enforce the live input field and byte bounds", () => {
  const messageAction = memoryAction("revise_plan", "none", "message", 2, 4);
  const state = stateFor(messageAction);
  assert.throws(
    () =>
      createCreatorActionCommandRequest({
        state,
        conversationId: "creator_conversation_cli",
        actionInstanceId: "creator_action_revise_plan",
        commandInput: { field: "report", value: "Plan" },
        idempotencyKey: "creator-cli-action-wrong-field",
      }),
    /--text/i,
  );
  assert.throws(
    () =>
      createCreatorActionCommandRequest({
        state,
        conversationId: "creator_conversation_cli",
        actionInstanceId: "creator_action_revise_plan",
        commandInput: { field: "text", value: "Five!" },
        idempotencyKey: "creator-cli-action-too-long",
      }),
    /between 2 and 4 bytes/i,
  );

  const revision = parseCreatorActionCommandOptions(["--text", "Plan", "--model", MODEL]);
  assert.equal(revision.valid, true);
  const revisionRequest = createCreatorActionCommandRequest({
    state,
    conversationId: "creator_conversation_cli",
    actionInstanceId: "creator_action_revise_plan",
    commandInput: creatorActionCommandInput(revision)!,
    selectedModelId: revision.model!,
    idempotencyKey: "creator-cli-action-model-binding",
  });
  assert.deepEqual(revisionRequest.input, {
    text: "Plan",
    selectedModelId: MODEL,
    modelRegistryHash: state.modelRegistry.hash,
  });

  assert.throws(
    () =>
      createCreatorActionCommandRequest({
        state: stateFor(memoryAction("keep_changes", "none", "report")),
        conversationId: "creator_conversation_cli",
        actionInstanceId: "creator_action_keep_changes",
        commandInput: { field: "report", value: "Looks good." },
        selectedModelId: MODEL,
        idempotencyKey: "creator-cli-action-model-not-allowed",
      }),
    /only plan refinement/i,
  );
});

test("creator CLI accepts only an exact durable 202 work admission", async () => {
  const discovery = {
    kind: "ForgeCreatorControlDiscovery" as const,
    controlId: "creator_control_cli_test",
    host: "127.0.0.1" as const,
    port: 8788,
    bearerToken: "creator-cli-bearer-token-1234567890",
    pid: 123,
    startedAt: NOW,
  };
  const admission = {
    kind: "CreatorWorkAdmission",
    jobId: "creator_job_cli_admitted",
    conversationId: "creator_conversation_cli",
    acceptedAt: NOW,
  };
  const request = { kind: "CreatorTurnRequest" };
  const response = (status: number, body?: unknown): typeof fetch =>
    (async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      })) as typeof fetch;

  assert.deepEqual(
    await submitCreatorControlWork(discovery, "/api/control/turn", request, {
      fetchImpl: response(202, admission),
    }),
    admission,
  );
  await assert.rejects(
    submitCreatorControlWork(discovery, "/api/control/turn", request, {
      fetchImpl: response(200, admission),
    }),
    /expected 202/i,
  );
  await assert.rejects(
    submitCreatorControlWork(discovery, "/api/control/action", request, {
      fetchImpl: response(204),
    }),
    /expected 202/i,
  );
  await assert.rejects(
    submitCreatorControlWork(discovery, "/api/control/turn", request, {
      fetchImpl: response(202, { ...admission, kind: "SomethingElse" }),
    }),
    /invalid 202 admission contract/i,
  );
  await assert.rejects(
    submitCreatorControlWork(discovery, "/api/control/turn", request, {
      fetchImpl: (async () =>
        new Response("not-json", {
          status: 202,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    }),
    /invalid 202 admission body/i,
  );
});

function stateFor(action?: CreatorControlActionDescriptor): CreatorDashboardState {
  const registry = sealCreatorModelRegistry({
    id: "creator_model_registry_cli",
    generatedAt: NOW,
    defaultModelId: MODEL,
    models: [
      {
        id: MODEL,
        displayName: "GPT-5.6 Luna",
        availability: "available",
        imageInput: "supported",
        requiredCapabilities: ["tools"],
        providerFallback: "disabled",
      },
    ],
  });
  const conversation = sealCreatorProjectConversation({
    id: "creator_conversation_cli",
    project: { kind: "local_linked", forgeProjectId: "forge_project_cli" },
    title: "CLI conversation",
    createdAt: NOW,
    updatedAt: NOW,
    latestEventSequence: 1,
    episodeIds: [],
    memoryHeads: [
      {
        itemId: "creator_memory_item_cli",
        revisionId: "creator_memory_revision_cli",
        revisionHash: MEMORY_HASH,
      },
    ],
  });
  const turnContract = sealCreatorTurnContract({
    id: "creator_turn_contract_cli",
    conversationId: conversation.id,
    allowedTurnTypes: ["follow_up"],
    modelRegistryHash: registry.hash,
    minimumBytes: 1,
    maximumBytes: 64,
    issuedAt: NOW,
  });
  const view = sealCreatorControlView({
    id: "creator_control_view_cli",
    conversationId: conversation.id,
    conversationHash: conversation.hash,
    eventSequence: 1,
    status: "awaiting_creator",
    title: "Ready",
    detail: "Choose the next action.",
    turnContract,
    actions: action ? [action] : [],
    technicalAttachments: [],
  });
  const state: CreatorDashboardState = {
    kind: "CreatorDashboardState",
    conversations: [
      {
        id: conversation.id,
        hash: conversation.hash,
        title: conversation.title,
        projectName: conversation.title,
        project: conversation.project,
        status: view.status,
        latestEventSequence: conversation.latestEventSequence,
        episodeCount: 0,
        updatedAt: NOW,
      },
    ],
    selectedConversationId: conversation.id,
    selectedConversation: conversation,
    eventPage: { conversationId: conversation.id, events: [], complete: true },
    episodes: [],
    memories: [
      {
        itemId: "creator_memory_item_cli",
        revisionId: "creator_memory_revision_cli",
        revisionHash: MEMORY_HASH,
        category: "convention",
        text: "Original memory.",
        pinned: false,
        state: "active",
      },
    ],
    modelRegistry: registry,
    controlView: view,
    pairedStudio: {
      status: "ready",
      message: "Studio ready",
      project: conversation.project,
      transactionStatus: "clear",
    },
    serverTime: NOW,
  };
  assertCreatorDashboardState(state);
  return state;
}

function memoryAction(
  actionId: CreatorControlActionDescriptor["actionId"],
  target: CreatorControlActionDescriptor["target"],
  field: "message" | "report" | "memory",
  minimumBytes = 1,
  maximumBytes = 64,
): CreatorControlActionDescriptor {
  return {
    actionInstanceId: `creator_action_${actionId}`,
    actionId,
    label: `CLI ${actionId}`,
    intent: "secondary",
    controlViewId: "creator_control_view_cli",
    authorizingEventId: "creator_event_cli",
    authorizingEventHash: "a".repeat(64),
    target,
    input: {
      kind: "text",
      field,
      label: `CLI ${field}`,
      minimumBytes,
      maximumBytes,
      multiline: true,
    },
  };
}
