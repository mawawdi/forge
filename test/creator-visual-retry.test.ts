import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import { createAgentExecutionSlot } from "../packages/agent-runtime/src/index.js";
import { contentHash } from "../packages/contracts/src/index.js";
import { CreatorConversationCoordinator } from "../packages/creator-control/src/conversation-coordinator.js";
import {
  sealCreatorWorkJob,
  type CreatorTurnRequest,
  type CreatorWorkJob,
} from "../packages/creator-conversation/src/index.js";
import { assertCreatorTransactionControlAction } from "../packages/creator-session/src/coordinator.js";
import { sealCreatorVisualObservations } from "../packages/creator-session/src/visual-context.js";
import { parseOpenRouterModelCatalog } from "../packages/model-client/src/model-registry.js";
import type { VisualObservationInput } from "../packages/visual-evidence/src/contracts.js";

const MODEL = "openai/gpt-5.6-luna";
const NOW = "2026-09-05T00:00:00.000Z";
const PROJECT = "project_visual_retry";
const REVISION = "a".repeat(64);
const ORIGINAL_SESSION = "creator_session_original-visual";
const NEXT_SESSION = "creator_session_retried-visual";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const images: VisualObservationInput[] = [
  {
    kind: "reference",
    caption: "Creator reference",
    image: { mimeType: "image/png", base64: PNG },
  },
  {
    kind: "rendered_view",
    caption: "Creator-reported entry view",
    viewId: "entry",
    state: "Menu open",
    graphicsSettings: "Manual 8",
    image: { mimeType: "image/png", base64: PNG },
  },
];
const visualContext = {
  expectedProjectId: PROJECT,
  expectedRevisionHash: REVISION,
  plan: { hash: "b".repeat(64), buildHash: "c".repeat(64), viewIds: ["entry"] },
};
const stoppedAfterValidation = new Error("test stops at the validated provider boundary");

async function fixture(
  options: {
    imageCapable?: boolean;
    currentProject?: string;
    currentRevision?: string;
    retainedProject?: string;
    runningModel?: string;
    tamperAdmittedImage?: boolean;
    inheritedImages?: boolean;
    ordinaryTurn?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "forge-visual-retry-"));
  const store = new ImmutableJsonArtifactStore(root);
  const request: CreatorTurnRequest = {
    kind: "CreatorTurnRequest",
    conversationId: "conversation_visual_retry",
    turnContractId: "turn_contract_visual_retry",
    turnContractHash: "d".repeat(64),
    turnKind: options.inheritedImages ? "clarification" : "new_work",
    text: "Improve the visual composition using these images.",
    selectedModelId: MODEL,
    idempotencyKey: "visual-retry-original-request",
    ...(options.inheritedImages ? {} : { visualObservations: images }),
  };
  const observed = sealCreatorVisualObservations(images, visualContext, PROJECT, REVISION);
  const creatorRequest = await store.write({
    kind: "CreatorRequest",
    sessionId: ORIGINAL_SESSION,
    promptHash: contentHash(request.text),
    creatorText: request.text,
    agentPrompt: request.text,
    contextCitations: [],
    visualObservations: observed,
  });
  const admittedRequest = await store.write(
    options.tamperAdmittedImage
      ? {
          ...request,
          visualObservations: images.map((image) => ({
            ...image,
            caption: "Different admitted reference",
          })),
        }
      : request,
  );
  const authority = await store.write({ kind: "TestOnlyRetryAdmissionAuthority" });
  const context = await store.write({ kind: "TestOnlyRetainedConversationContext" });
  const prior = sealCreatorWorkJob({
    id: "creator_job_visual_prior",
    conversationId: request.conversationId!,
    turnId: "creator_turn_visual_prior",
    idempotencyKey: request.idempotencyKey,
    requestHash: admittedRequest.artifactHash,
    admittedRequest,
    admissionAuthority: authority,
    transactionSessionId: ORIGINAL_SESSION,
    agentExecutions: [createAgentExecutionSlot({ purpose: "planner", ordinal: 1 })],
    conversationContext: context,
    jobType: "agent_turn",
    status: "outcome_unknown",
    phase: "interrupted",
    providerOutcome: "outcome_unknown",
    selectedModelId: MODEL,
    failure: { code: "provider_outcome_unknown", detailHash: "e".repeat(64) },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const running = sealCreatorWorkJob({
    id: "creator_job_visual_retry",
    conversationId: request.conversationId!,
    turnId: "creator_turn_visual_retry",
    idempotencyKey: "visual-retry-new-execution",
    requestHash: admittedRequest.artifactHash,
    admittedRequest,
    admissionAuthority: authority,
    transactionSessionId: NEXT_SESSION,
    agentExecutions: [createAgentExecutionSlot({ purpose: "planner", ordinal: 1 })],
    resumesJob: { id: prior.id, hash: prior.hash },
    jobType: "agent_turn",
    status: "running",
    phase: "retry_admitted",
    providerOutcome: "never_dispatched",
    selectedModelId: options.runningModel ?? MODEL,
    createdAt: NOW,
    updatedAt: NOW,
  });
  let starts = 0,
    providerDispatches = 0;
  let captured: ReturnType<typeof assertCreatorTransactionControlAction> | undefined;
  const abandoned: string[] = [];
  const bundle = {
    session: {
      id: ORIGINAL_SESSION,
      projectId: options.retainedProject ?? PROJECT,
      initialRevisionHash: REVISION,
      promptHash: contentHash(request.text),
    },
    creatorRequest,
  };
  type Harness = {
    executeTurn(execution: unknown, running: CreatorWorkJob): Promise<void>;
    executeResumedAgentWork(
      execution: unknown,
      running: CreatorWorkJob,
      actionId: "retry_work",
    ): Promise<void>;
  };
  const coordinator = Object.create(CreatorConversationCoordinator.prototype) as Harness;
  // Fixed upstream admission/classification and persistence boundaries isolate the real retry route.
  // Request reading, original visual artifact replay, model checks and visual-context reconstruction are real.
  Object.assign(coordinator, {
    store: { artifactStore: store },
    options: {
      modelCatalog: parseOpenRouterModelCatalog(
        {
          data: [
            {
              id: MODEL,
              supported_parameters: ["tools"],
              architecture: {
                input_modalities: options.imageCapable === false ? ["text"] : ["text", "image"],
              },
            },
          ],
        },
        NOW,
      ),
      transaction: {
        supersedeConversationCandidate: async () => undefined,
        conversationSnapshot: async (sessionId: string) => {
          assert.equal(sessionId, ORIGINAL_SESSION);
          return { bundle };
        },
        abandonInterruptedConversationCandidate: async (sessionId: string) => {
          abandoned.push(sessionId);
        },
        action: async (value: unknown) => {
          starts++;
          captured = assertCreatorTransactionControlAction(value);
          assert.equal(captured.action, "start");
          if (captured.action !== "start") throw new Error("Expected retry start");
          const replayed = sealCreatorVisualObservations(
            captured.visualObservations ?? [],
            captured.visualContext ?? {},
            options.currentProject ?? PROJECT,
            options.currentRevision ?? REVISION,
          );
          assert.deepEqual(replayed, observed);
          providerDispatches++;
          throw stoppedAfterValidation;
        },
      },
    },
    load: async () => ({
      jobs: [prior, running],
      conversation: { activeEpisodeId: "episode_visual" },
      episodes: options.ordinaryTurn
        ? [{ id: "episode_visual", sessionBundle: { id: ORIGINAL_SESSION } }]
        : [],
      events: options.inheritedImages ? [{ attachments: [{ role: "visual_observation" }] }] : [],
    }),
    assessJobExecution: async () => ({
      kind: "provider_outcome_unknown",
      providerOutcome: "outcome_unknown",
    }),
    materializeConversationContext: async () => ({
      artifact: context,
      modelPrompt: "Fixed test-owned conversational context",
      contextCitations: [],
    }),
    updateJob: async () => running,
  });
  return {
    run: () =>
      options.ordinaryTurn
        ? coordinator.executeTurn(
            { request, conversationId: request.conversationId, jobId: running.id },
            running,
          )
        : coordinator.executeResumedAgentWork(
            { conversationId: request.conversationId, jobId: running.id },
            running,
            "retry_work",
          ),
    state: () => ({ starts, providerDispatches, captured, abandoned }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test("actual retry route starts with images and visual context reconstructed from the exact original CreatorRequest", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run, (error) => error === stoppedAfterValidation);
    const state = f.state();
    assert.equal(state.starts, 1);
    assert.equal(state.providerDispatches, 1);
    assert.deepEqual(state.abandoned, [ORIGINAL_SESSION]);
    assert.equal(state.captured?.action, "start");
    if (state.captured?.action !== "start") throw new Error("Expected captured start");
    assert.equal(state.captured.creatorSessionId, NEXT_SESSION);
    assert.deepEqual(state.captured.visualObservations, images);
    assert.deepEqual(state.captured.visualContext, visualContext);
  } finally {
    await f.dispose();
  }
});

test("clarification and its retry retain earlier reference images without requiring another upload", async () => {
  for (const ordinaryTurn of [true, false]) {
    const f = await fixture({ inheritedImages: true, ordinaryTurn });
    try {
      await assert.rejects(f.run, (error) => error === stoppedAfterValidation);
      const state = f.state();
      assert.equal(state.providerDispatches, 1);
      assert.equal(state.captured?.action, "start");
      if (state.captured?.action !== "start") throw new Error("Expected visual start");
      assert.deepEqual(state.captured.visualObservations, images);
      assert.deepEqual(state.captured.visualContext, visualContext);
    } finally {
      await f.dispose();
    }
  }
});

test("retry preserves original project and revision so either change fails before provider dispatch", async () => {
  for (const options of [
    { currentRevision: "f".repeat(64) },
    { currentProject: "foreign-project" },
  ]) {
    const f = await fixture(options);
    try {
      await assert.rejects(f.run, /project changed before visual attachment admission/);
      assert.equal(f.state().starts, 1);
      assert.equal(f.state().providerDispatches, 0);
    } finally {
      await f.dispose();
    }
  }
});

test("retry rejects missing image support, another model, foreign retained project or changed admitted visuals before start", async () => {
  for (const [options, message] of [
    [{ imageCapable: false }, /does not confirm image input/],
    [{ runningModel: "openai/gpt-5.6-sol" }, /exact model selected/],
    [{ retainedProject: "foreign-project" }, /does not bind the creator session/],
    [{ tamperAdmittedImage: true }, /retry images differ/],
  ] as const) {
    const f = await fixture(options);
    try {
      await assert.rejects(f.run, message);
      assert.equal(f.state().starts, 0);
      assert.equal(f.state().providerDispatches, 0);
      assert.deepEqual(f.state().abandoned, []);
    } finally {
      await f.dispose();
    }
  }
});
