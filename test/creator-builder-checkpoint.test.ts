import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type {
  AgentToolBatchResult,
  AgentToolDefinition,
  ToolResult,
} from "../packages/agent-runtime/src/index.js";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  CreatorBuilderToolHost,
  createCreatorApproval,
  createCreatorPlan,
  createCreatorSession,
  createStudioOwnershipMap,
  type CreatorProjectIndexView,
} from "../packages/creator-session/src/index.js";
import { compileGamePlan } from "../packages/game-compiler/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameRecipeDefinition,
} from "../packages/game-ir/src/index.js";
import {
  createPinnedLuauLspSourceIndex,
  SourceConsultationRecorder,
} from "../packages/source-intelligence/src/index.js";
import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";

const READS = [
  "game.read_locked_source",
  "game.source_context",
  "game.inspect_inventory",
  "studio.api_lookup",
  "studio.read_observations",
  "source.read",
];

// This fixture admits a real minimal plan, then supplies fixed tool observations
// and progress transitions to isolate checkpoint memory. No Luau or native work runs.
function fixture() {
  const prompt = "Retain consulted API evidence during a bounded build.";
  const revisionHash = contentHash("builder-cache-revision");
  const captureHash = contentHash("builder-cache-capture");
  const projectIndex: CreatorProjectIndexView = {
    project: { name: "Builder memory", placeId: 0, universeId: 0 },
    revision: { hash: revisionHash } as CreatorProjectIndexView["revision"],
    instances: [
      {
        objectId: "forge_attribute:workspace",
        identity: { kind: "forge_attribute", stableId: "workspace" },
        path: "Workspace",
        name: "Workspace",
        className: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
        properties: {},
        attributes: {},
        tags: [],
      },
    ],
    scripts: [],
  };
  const ownership = createStudioOwnershipMap({
    projectId: "builder-cache",
    revisionHash,
    projectIndex,
  });
  const session = createCreatorSession({
    projectId: ownership.projectId,
    prompt,
    revisionHash,
    projectCaptureHash: captureHash,
    ownership,
  });
  const sourceIndex = createPinnedLuauLspSourceIndex(
    { snapshotHash: captureHash, documents: [] },
    { symbols: [], references: [] },
    {
      analysisConfigHash: contentHash("config"),
      pinnedToolchainProof: {
        hash: contentHash("proof"),
        lockHash: contentHash("lock"),
        platform: "test",
      },
      sourcemapHash: contentHash("map"),
    },
    { maximumStaticDependencyRows: 1024 },
  );
  const sourceResolver = createTestFixtureSourceResolver([]);
  const sourceConsultation = new SourceConsultationRecorder(sourceIndex, sourceResolver).seal();
  const definition: GameRecipeDefinition = {
    kind: "GameRecipeDefinition",
    id: "test-container",
    abi: "1",
    sourceExports: [],
    configSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    ports: [],
    obligations: [],
  };
  const change = {
    id: "folder",
    kind: "create" as const,
    path: "Workspace/Folder",
    className: "Folder" as const,
    initialization: "initial_properties" as const,
    parent: { kind: "engine_container" as const, path: "Workspace", className: "Workspace" },
  };
  const compiled = compileGamePlan({
    design: {
      kind: "GameDesignSpec",
      worldAuthoring: { mode: "none" },
      id: "cache",
      intent: prompt,
      components: [
        {
          kind: "recipe_instance",
          id: "container",
          definition: gameRecipeDefinitionLock(definition),
          config: {},
        },
      ],
      connections: [],
      artifactDependencies: [],
    },
    registry: createGameDefinitionRegistry([definition]),
    projectId: ownership.projectId,
    project: projectIndex.project,
    sessionId: session.id,
    observedRevisionHash: revisionHash,
    initialTopology: projectIndex.instances,
    inventory: [
      {
        id: change.id,
        componentId: "container",
        change,
        lockedProperties: {},
        valueSlots: [],
        attributes: {},
        removedAttributes: [],
        dependencies: [],
      },
    ],
  });
  const plan = createCreatorPlan(
    {
      sessionId: session.id,
      promptHash: session.promptHash,
      creatorPrompt: prompt,
      projectRevisionHash: revisionHash,
      projectCaptureHash: captureHash,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      sourceIndex,
      sourceConsultation,
      compiled,
      changes: compiled.inventory.map((item) => item.change),
      inspectionPaths: [],
      steps: [{ id: "container", statement: "Create the container.", changeIds: ["folder"] }],
      charter: {
        clauses: [
          {
            id: "exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "Workspace/Folder",
            expectedClass: "Folder",
          },
        ],
      },
    },
    projectIndex,
    ownership,
  );
  return new FixedReadBuilder({
    session,
    ownership,
    projectIndex,
    plan,
    sourceIndex,
    sourceResolver,
    sourceConsultation,
    planApproval: createCreatorApproval({
      sessionId: session.id,
      artifactKind: "plan",
      artifactId: plan.id,
      artifactHash: plan.hash,
      decision: "approved",
      decidedAt: "2026-09-05T12:00:00.000Z",
    }),
  });
}

class FixedReadBuilder extends CreatorBuilderToolHost {
  payload = "immutable source λ";
  private revision = 0;
  override definitions(): AgentToolDefinition[] {
    const inputShape = {
      id: z.string(),
      fail: z.boolean().optional(),
      activity: z.string().optional(),
    };
    return [...READS, "studio.read_drafts", "studio.build", "studio.repair"].map((name) => ({
      name,
      description: "Fixed test observation",
      inputShape,
      schema: z.toJSONSchema(z.object(inputShape).strict()),
    }));
  }
  override progressToken() {
    return String(this.revision);
  }
  protected override async dispatch(name: string, input: unknown): Promise<unknown> {
    const request = input as { id: string; fail?: boolean };
    if (request.fail) throw new Error("fixed failure");
    if (name === "studio.build" || name === "studio.repair") this.revision++;
    return { id: request.id, sourceHash: contentHash(this.payload), text: this.payload };
  }
}

function batch(name: string, result: ToolResult): AgentToolBatchResult {
  return { toolCallId: name, name, result };
}
async function changedCheckpoint(host: FixedReadBuilder, priorBatch: AgentToolBatchResult[] = []) {
  const before = host.progressToken();
  const result = await host.execute("studio.repair", { id: "changed" });
  assert.equal(result.ok, true);
  return host.contextCheckpoint([...priorBatch, batch("studio.repair", result)], before);
}

test("builder checkpoints retain every immutable read across changed stages and detach returned values", async () => {
  const host = fixture();
  for (const name of READS) {
    const result = await host.execute(name, { id: name, activity: "First consultation" });
    assert.equal(result.ok, true);
    (result.value as { text: string }).text = "caller mutation must not poison memory";
  }
  const first = JSON.parse((await changedCheckpoint(host))!);
  assert.equal(first.consultedReads.length, READS.length);
  assert.ok(
    first.consultedReads.every(
      (read: { result: ToolResult }) =>
        (read.result.value as { text: string }).text === "immutable source λ",
    ),
  );
  first.consultedReads[0].result.value.text = "checkpoint consumer mutation";
  const second = JSON.parse((await changedCheckpoint(host))!);
  assert.equal(second.consultedReads[0].result.value.text, "immutable source λ");
  assert.deepEqual(
    second.consultedReads.map((read: { name: string }) => read.name),
    READS,
  );
});

test("identical reads deduplicate despite changed activity, while failures remain in the current batch", async () => {
  const host = fixture();
  host.payload = "x".repeat(550_000);
  await host.execute("game.read_locked_source", { id: "module", activity: "Read API" });
  await host.execute("game.read_locked_source", { id: "module", activity: "Review API" });
  host.payload = "small build result";
  const failure = await host.execute("studio.api_lookup", { id: "missing", fail: true });
  const checkpoint = JSON.parse(
    (await changedCheckpoint(host, [batch("studio.api_lookup", failure)]))!,
  );
  assert.equal(checkpoint.consultedReads.length, 1);
  assert.equal(checkpoint.consultedReads[0].result.value.text.length, 550_000);
  assert.equal(checkpoint.latestBatch[0].result.ok, false);
  assert.equal(checkpoint.latestBatch[0].result.error.message, "fixed failure");
});

test("mutable draft pages are not retained as current source after a changed checkpoint", async () => {
  const host = fixture();
  host.payload = "old draft";
  const old = await host.execute("studio.read_drafts", { id: "draft" });
  host.payload = "new draft";
  const checkpoint = JSON.parse(
    (await changedCheckpoint(host, [batch("studio.read_drafts", old)]))!,
  );
  assert.deepEqual(checkpoint.consultedReads, []);
  assert.equal(checkpoint.latestBatch[0].evidenceScope, "historical_draft_hash");
  assert.equal(checkpoint.latestBatch[0].result.value.sourceHash, contentHash("old draft"));
  assert.equal(checkpoint.latestBatch[1].result.value.sourceHash, contentHash("new draft"));
  assert.match(checkpoint.instruction, /not current source after a repair/);
  const next = JSON.parse((await changedCheckpoint(host))!);
  assert.equal(JSON.stringify(next).includes("old draft"), false);
});

test("read-cache or full-checkpoint overflow permanently declines compaction without eviction", async () => {
  const host = fixture();
  host.payload = "x".repeat(550_000);
  await host.execute("game.read_locked_source", { id: "first" });
  host.payload = "small";
  assert.ok(await changedCheckpoint(host));
  host.payload = "y".repeat(550_000);
  await host.execute("game.read_locked_source", { id: "second" });
  host.payload = "small";
  assert.equal(await changedCheckpoint(host), undefined);
  await host.execute("game.read_locked_source", { id: "third" });
  assert.equal(await changedCheckpoint(host), undefined);

  const largeBatch = fixture();
  largeBatch.payload = "z".repeat(1_050_000);
  assert.equal(await changedCheckpoint(largeBatch), undefined);
  largeBatch.payload = "small";
  assert.equal(await changedCheckpoint(largeBatch), undefined);
});
