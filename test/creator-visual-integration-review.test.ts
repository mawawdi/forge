import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_AGENT_BUDGETS,
  ForgeNativeAgentRuntime,
  createAgentExecutionSlot,
} from "../packages/agent-runtime/src/index.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  advanceSession,
  createCreatorSession,
  createStudioOwnershipMap,
  verifyCreatorBundleArtifacts,
  type CreatorRequestArtifact,
  type CreatorSessionBundle,
} from "../packages/creator-session/src/index.js";
import {
  captureCreatorOfflineRegression,
  replayCreatorOfflineRegression,
} from "../packages/creator-session/src/offline-regression.js";
import { writeCreatorProjectIndexArtifacts } from "../packages/creator-session/src/project-refresh.js";
import {
  creatorVisualModelImages,
  creatorVisualMetadata,
  creatorVisualPrompt,
  sealCreatorVisualObservations,
} from "../packages/creator-session/src/visual-context.js";
import { LocalCreatorAgentWorker } from "../packages/creator-session/src/worker.js";
import {
  OPENROUTER_MODEL_CLIENT_DESCRIPTOR,
  type ModelClient,
  type ModelImage,
} from "../packages/model-client/src/index.js";
import { createPinnedLuauLspSourceIndex } from "../packages/source-intelligence/src/index.js";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioProjectEvidenceShard,
  createStudioProjectIndexCapture,
  createStudioProjectIndexProjection,
  studioProjectIndexMetadataView,
} from "../packages/studio-evidence/src/index.js";
import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";

// Fixed PNGs exercise byte/provenance replay; they are not native render evidence.
const RED =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const BLUE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==";
const MODEL = "fixture/visual-replay";
const PROMPT = "Inspect the supplied visual reference.";

async function fixture(
  directory: string,
  actualImages?: (images: ModelImage[]) => ModelImage[],
  visualGuidance?: string,
) {
  const store = new ImmutableJsonArtifactStore(directory);
  const projection = createStudioProjectIndexProjection({
    manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
    project: { name: "Visual replay fixture", placeId: 0, universeId: 0 },
    connectorEpoch: "a".repeat(64),
    purpose: "creator_project_index",
    roots: ["Workspace"],
    bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
  });
  const capture = createStudioProjectIndexCapture({
    projection,
    shards: [createStudioProjectEvidenceShard({ root: "Workspace", ordinal: 0, nodes: [] })],
    sourceManifests: [],
    sourceChunks: [],
    completedAt: "2026-09-05T00:00:00.000Z",
    detectorEpoch: 0,
  });
  const projectIndex = studioProjectIndexMetadataView(capture);
  const ownership = createStudioOwnershipMap({
    projectId: "visual-replay",
    revisionHash: capture.revision.hash,
    projectIndex,
  });
  const session = createCreatorSession({
    id: "creator_session_visual_replay",
    prompt: PROMPT,
    projectId: ownership.projectId,
    ownership,
    revisionHash: capture.revision.hash,
    projectCaptureHash: capture.hash,
    model: MODEL,
  });
  const observations = (base64: string, caption = "Warm reference") =>
    sealCreatorVisualObservations(
      [{ kind: "reference", caption, image: { mimeType: "image/png", base64 } }],
      {},
      session.projectId,
      session.initialRevisionHash,
    );
  const request: CreatorRequestArtifact = {
    kind: "CreatorRequest",
    sessionId: session.id,
    promptHash: session.promptHash,
    creatorText: PROMPT,
    agentPrompt:
      visualGuidance === undefined
        ? PROMPT + creatorVisualPrompt(observations(RED))
        : `${PROMPT}\n\n${visualGuidance}\n${creatorVisualMetadata(observations(RED))}`,
    contextCitations: [],
    visualObservations: observations(RED),
  };
  const descriptor: ModelClient["descriptor"] = structuredClone(OPENROUTER_MODEL_CLIENT_DESCRIPTOR);
  descriptor.transport = "offline-visual-replay-fixture";
  descriptor.configuration.routing.allowlistedModels = [MODEL];
  descriptor.configuration.request.inputModalitiesByModel = { [MODEL]: ["text", "image"] };
  descriptor.configuration.request.inputModalityCatalogHash = "b".repeat(64);
  let calls = 0;
  const client: ModelClient = {
    descriptor,
    async complete(input) {
      calls++;
      return {
        kind: "provider_error",
        errorClass: "fixture_failure",
        message: "Offline recorded failure",
        retryable: false,
        requestHash: contentHash(stableJson(input)),
        usage: {
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
        responseFacts: {
          requestedModel: input.model,
          resolvedModel: null,
          servingProvider: null,
          responseId: null,
          latencyMs: 1,
          retryCount: 0,
          finishReason: null,
          continuationHash: null,
          continuationBytes: null,
        },
      };
    },
  };
  const sourceIndex = createPinnedLuauLspSourceIndex(
    { snapshotHash: capture.hash, documents: [] },
    { symbols: [], references: [] },
    {
      analysisConfigHash: "c".repeat(64),
      sourcemapHash: "d".repeat(64),
      pinnedToolchainProof: { hash: "e".repeat(64), lockHash: "f".repeat(64), platform: "test" },
    },
    { maximumStaticDependencyRows: 1024 },
  );
  const images = creatorVisualModelImages(request.visualObservations!);
  const result = await new LocalCreatorAgentWorker(
    new ForgeNativeAgentRuntime(client),
    directory,
  ).plan({
    session,
    ownership,
    projectIndex,
    sourceIndex,
    sourceResolver: createTestFixtureSourceResolver([]),
    creatorPrompt: PROMPT,
    agentPrompt: request.agentPrompt,
    initialImages: actualImages ? actualImages(images) : images,
    budgets: DEFAULT_AGENT_BUDGETS,
    execution: createAgentExecutionSlot({ purpose: "planner", ordinal: 1 }),
  });
  assert.equal(result.status, "unsealed");
  assert.equal(calls, 1);
  const bundle: CreatorSessionBundle = {
    session: advanceSession(session, {
      status: "incomplete",
      failure: {
        code: "FIXTURE_FAILURE",
        detail: "Offline recorded failure",
      },
    }),
    ownership,
    creatorRequest: await store.write(request),
    projectIndices: [await writeCreatorProjectIndexArtifacts(store, capture)],
    projectChanges: [],
    projectRefreshes: [],
    rojoSourceMutations: [],
    sourceWriteBlobs: [],
    sourceIndices: [],
    sourceConsultations: [],
    buildContracts: [],
    approvals: [],
    changeSets: [],
    mutationAttempts: [],
    verifications: [],
    agentRuns: [result.evidence],
  };
  return { store, bundle, request, observations, calls: () => calls };
}

test("creator bundle replay binds valid pixels and caption metadata to the actual worker journal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-visual-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, bundle, request, observations, calls } = await fixture(directory);
  await verifyCreatorBundleArtifacts(bundle, store);
  for (const visualObservations of [observations(BLUE), observations(RED, "Changed caption")]) {
    const swapped = {
      ...request,
      visualObservations,
      agentPrompt: PROMPT + creatorVisualPrompt(visualObservations),
    };
    await assert.rejects(
      verifyCreatorBundleArtifacts(
        {
          ...bundle,
          creatorRequest: await store.write(swapped),
        },
        store,
      ),
      /prompt differs from AgentRun request-intent/,
    );
  }
  await assert.rejects(
    verifyCreatorBundleArtifacts(
      {
        ...bundle,
        creatorRequest: await store.write({ ...request, visualObservations: observations(BLUE) }),
      },
      store,
    ),
    /prompt does not bind its visual observation metadata/,
  );
  const captured = await captureCreatorOfflineRegression({ store, bundle });
  assert.equal(captured.status, "captured");
  if (captured.status !== "captured") throw new Error("Expected immutable capture");
  await rm(join(directory, "agent-execution-journals"), { recursive: true });
  const replay = await replayCreatorOfflineRegression({ store, artifact: captured.artifact });
  assert.equal(replay.result, "exact_match", JSON.stringify(replay));
  assert.equal(calls(), 1, "Replay must use the retained head without model dispatch");
});

test("creator bundle replay rejects valid substituted pixels or missing attachments even with unchanged prompt", async (t) => {
  for (const replacement of ["blue", "missing"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "forge-visual-binding-mismatch-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { store, bundle } = await fixture(directory, () =>
      replacement === "missing"
        ? []
        : creatorVisualModelImages(
            sealCreatorVisualObservations(
              [
                {
                  kind: "reference",
                  caption: "Fixture",
                  image: { mimeType: "image/png", base64: BLUE },
                },
              ],
              {},
              "visual-replay",
              "a".repeat(64),
            ),
          ),
    );
    await assert.rejects(
      verifyCreatorBundleArtifacts(bundle, store),
      /visual images differ from AgentRun request-intent/,
    );
  }
});

test("visual replay binds retained metadata and journal wording independently of current prompt guidance", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-visual-guidance-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, bundle, request, calls } = await fixture(
    directory,
    undefined,
    "Visual guidance retained exactly as authored for this fixture request.",
  );
  assert.ok(!request.agentPrompt.endsWith(creatorVisualPrompt(request.visualObservations!)));
  await verifyCreatorBundleArtifacts(bundle, store);

  const metadata = creatorVisualMetadata(request.visualObservations!);
  for (const agentPrompt of [
    PROMPT,
    `${PROMPT}\n${metadata.replace("Warm reference", "Altered caption")}`,
    `${PROMPT}\n${metadata}\nUnbound trailing data`,
  ]) {
    await assert.rejects(
      verifyCreatorBundleArtifacts(
        { ...bundle, creatorRequest: await store.write({ ...request, agentPrompt }) },
        store,
      ),
      /prompt does not bind its visual observation metadata/,
    );
  }
  await assert.rejects(
    verifyCreatorBundleArtifacts(
      {
        ...bundle,
        creatorRequest: await store.write({
          ...request,
          agentPrompt: PROMPT + creatorVisualPrompt(request.visualObservations!),
        }),
      },
      store,
    ),
    /prompt differs from AgentRun request-intent evidence/,
  );

  const captured = await captureCreatorOfflineRegression({ store, bundle });
  assert.equal(captured.status, "captured");
  if (captured.status !== "captured") throw new Error("Expected immutable capture");
  await rm(join(directory, "agent-execution-journals"), { recursive: true });
  const replay = await replayCreatorOfflineRegression({ store, artifact: captured.artifact });
  assert.equal(replay.result, "exact_match", JSON.stringify(replay));
  assert.equal(calls(), 1, "Replay must not dispatch a model to reconstruct retained guidance");
});
