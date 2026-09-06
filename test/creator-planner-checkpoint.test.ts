import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  DEFAULT_AGENT_BUDGETS,
  ForgeNativeAgentRuntime,
  AgentExecutionJournalStore,
  createAgentExecutionJournalResume,
  type AgentToolBatchResult,
  type BudgetPolicy,
  type AgentExecutionCheckpoint,
} from "../packages/agent-runtime/src/index.js";
import {
  createCreatorSession,
  createStudioOwnershipMap,
  CreatorPlannerToolHost,
  CREATOR_PLANNER_SYSTEM_PROMPT,
  CREATOR_BUILDER_SYSTEM_PROMPT,
  creatorOrientation,
  type CreatorProjectIndexView,
} from "../packages/creator-session/src/index.js";
import { CreatorDesignDraft } from "../packages/creator-session/src/design-draft.js";
import {
  creatorGameCatalog,
  type CreatorGameCatalog,
} from "../packages/creator-session/src/game-authoring.js";
import {
  STUDIO_PATCH_DEFINITION,
  STUDIO_PATCH_EXPANDER,
} from "../packages/game-composition/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
} from "../packages/game-ir/src/index.js";
import {
  OpenRouterModelClient,
  DEFAULT_CREATOR_MODEL_ID,
  type ModelClient,
  type ModelToolCall,
  type ModelTurnRequest,
} from "../packages/model-client/src/index.js";
import { createPinnedLuauLspSourceIndex } from "../packages/source-intelligence/src/index.js";
import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";

const catalog: CreatorGameCatalog = {
  definitions: [STUDIO_PATCH_DEFINITION],
  registry: createGameDefinitionRegistry([STUDIO_PATCH_DEFINITION]),
  expanders: [STUDIO_PATCH_EXPANDER],
  lockedSources: new Map(),
};
const prompt =
  "Preserve the original request sentinel and create a folder after consulting source.";
function fixture(
  source = "-- full source checkpoint sentinel: λ\nreturn { label = 'consulted' }\n",
  gameCatalog: CreatorGameCatalog = catalog,
  budgets: BudgetPolicy = DEFAULT_AGENT_BUDGETS,
) {
  const revisionHash = contentHash("checkpoint-revision");
  const projectCaptureHash = contentHash("checkpoint-capture");
  const identity = { kind: "forge_attribute", stableId: "module" } as const;
  const workspace = { kind: "forge_attribute", stableId: "workspace" } as const;
  const document = {
    documentId: "forge_attribute:module",
    path: "Workspace/Module",
    className: "ModuleScript",
    executionContext: "shared" as const,
    sourceHash: contentHash(source),
    source,
  };
  const index: CreatorProjectIndexView = {
    project: { name: "Checkpoint", placeId: 0, universeId: 0 },
    revision: { hash: revisionHash } as CreatorProjectIndexView["revision"],
    instances: [
      {
        objectId: "forge_attribute:workspace",
        identity: workspace,
        path: "Workspace",
        name: "Workspace",
        className: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
        properties: {},
        attributes: {},
        tags: [],
      },
      {
        objectId: document.documentId,
        identity,
        parentIdentity: workspace,
        path: document.path,
        name: "Module",
        className: "ModuleScript",
        properties: {},
        attributes: {},
        tags: [],
      },
    ],
    scripts: [
      {
        documentId: document.documentId,
        path: document.path,
        className: document.className,
        executionContext: document.executionContext,
        sourceHash: document.sourceHash,
        utf8Bytes: Buffer.byteLength(source),
      },
    ],
  };
  const sourceIndex = createPinnedLuauLspSourceIndex(
    { snapshotHash: projectCaptureHash, documents: [document] },
    { symbols: [], references: [] },
    {
      analysisConfigHash: contentHash("fixture-config"),
      pinnedToolchainProof: {
        hash: contentHash("fixture-proof"),
        lockHash: contentHash("fixture-lock"),
        platform: "test",
      },
      sourcemapHash: contentHash("fixture-sourcemap"),
    },
    { maximumStaticDependencyRows: 1024 },
  );
  const ownership = createStudioOwnershipMap({
    projectId: "checkpoint",
    revisionHash,
    projectIndex: index,
  });
  const session = createCreatorSession({
    projectId: ownership.projectId,
    prompt,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const hostInput = {
    session,
    ownership,
    projectIndex: index,
    sourceIndex,
    sourceResolver: createTestFixtureSourceResolver([document]),
    prompt,
    catalog: gameCatalog,
    budgets,
  };
  const host = new CreatorPlannerToolHost(hostInput);
  return {
    host,
    freshHost: () => new CreatorPlannerToolHost(hostInput),
    source,
    orientation: creatorOrientation({ session, ownership, projectIndex: index }),
  };
}
function component(name = "First") {
  return {
    kind: "recipe_instance",
    id: "folders",
    definition: gameRecipeDefinitionLock(STUDIO_PATCH_DEFINITION),
    config: {
      operations: [
        {
          id: "folder",
          kind: "create",
          name,
          className: "Folder",
          parent: { kind: "engine", id: "Workspace" },
          properties: [],
          valueSlots: [],
          attributes: [],
          removedAttributes: [],
          dependencies: [],
        },
      ],
    },
  };
}
function call(id: string, name: string, args: unknown): ModelToolCall {
  return { id, name, arguments: args };
}
const inspect = { objectIds: ["forge_attribute:workspace", "forge_attribute:module"] };
const readSource = { documentId: "forge_attribute:module", maximumUtf8Bytes: 32768 };
function checkpoint(request: ModelTurnRequest) {
  assert.ok(request.messages.length >= 4);
  const assistant = request.messages[2];
  assert.equal(assistant?.role, "assistant");
  if (assistant?.role !== "assistant") throw new Error("Missing completed exchange");
  assert.deepEqual(
    request.messages
      .slice(3)
      .map((message) => (message.role === "tool" ? message.toolCallId : null)),
    assistant.toolCalls.map((call) => call.id),
    "checkpoint retains each call's exact corresponding result",
  );
  assert.match(stableJson(request.messages[0]), /original request sentinel/);
  const message = request.messages[1];
  assert.equal(message?.role, "user");
  if (message?.role !== "user") throw new Error("Missing checkpoint");
  const prefix = "<forge_semantic_checkpoint>\n";
  assert.ok(message.content.startsWith(prefix));
  const end = message.content.indexOf("\n</forge_semantic_checkpoint>", prefix.length);
  assert.ok(end > prefix.length);
  return JSON.parse(message.content.slice(prefix.length, end));
}

/** Expand local reference factoring while retaining recursive schema boundaries. */
function expandedSchema(root: unknown): unknown {
  const walk = (value: unknown, ancestors: readonly unknown[] = []): unknown => {
    if (Array.isArray(value)) return value.map((child) => walk(child, ancestors));
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string") {
      assert.ok(record.$ref.startsWith("#/$defs/"), "all schema references resolve locally");
      const target = record.$ref
        .split("/")
        .slice(1)
        .reduce<unknown>((parent, key) => {
          assert.ok(parent !== null && typeof parent === "object");
          const result = (parent as Record<string, unknown>)[
            key.replaceAll("~1", "/").replaceAll("~0", "~")
          ];
          assert.notEqual(result, undefined, "schema references must have a target");
          return result;
        }, root);
      if (ancestors.includes(target)) return { recursiveSchema: true };
      const { $ref: _ref, ...siblings } = record;
      return {
        ...(walk(target, [...ancestors, target]) as Record<string, unknown>),
        ...(walk(siblings, ancestors) as Record<string, unknown>),
      };
    }
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "$defs")
        .map(([key, child]) => [key, walk(child, ancestors)]),
    );
  };
  return walk(root);
}

test("current planner schemas and prompts expose host-owned repair handles and semantic arguments", () => {
  const { host } = fixture();
  const define = host.definitions().find((entry) => entry.name === "creator.define_component")!;
  const api = host.definitions().find((entry) => entry.name === "studio.api_lookup")!;
  const repair = host.definitions().find((entry) => entry.name === "creator.repair_component")!;
  assert.deepEqual(Object.keys(define.inputShape).sort(), ["activity", "component"]);
  assert.equal("memberKind" in api.inputShape, false);
  assert.doesNotMatch(CREATOR_PLANNER_SYSTEM_PROMPT, /expectedHash|memberKind/);
  assert.match(
    CREATOR_PLANNER_SYSTEM_PROMPT,
    /When a component rejection includes repair\.attemptId/,
  );
  assert.match(CREATOR_PLANNER_SYSTEM_PROMPT, /expired handles or changes beyond repair bounds/);
  assert.match(CREATOR_PLANNER_SYSTEM_PROMPT, /Never invent a handle/);
  assert.match(CREATOR_PLANNER_SYSTEM_PROMPT, /creator\.read_components with attemptId/);
  assert.match(repair.description, /op replace supplies value/);
  assert.match(repair.description, /op remove deletes an existing field or array entry/);
  assert.match(repair.description, /op add supplies value for an absent named property/);
  assert.match(CREATOR_BUILDER_SYSTEM_PROMPT, /Start with forge_source_reference/);
  assert.match(CREATOR_BUILDER_SYSTEM_PROMPT, /After a rejected or incomplete review/);
  assert.match(CREATOR_BUILDER_SYSTEM_PROMPT, /recorded member error remains an obligation/);
  assert.match(
    CREATOR_BUILDER_SYSTEM_PROMPT,
    /changing the receiver to any or casting it to an unrelated native class does not resolve/,
  );
});

test("planner schema factoring preserves every advertised constraint and reduces repeated bytes", async () => {
  const { host } = fixture(undefined, await creatorGameCatalog());
  let inlineBytes = 0;
  let factoredBytes = 0;
  for (const definition of host.definitions()) {
    const inline = z.toJSONSchema(z.object(definition.inputShape).strict());
    assert.deepEqual(
      expandedSchema(definition.schema),
      expandedSchema(inline),
      `${definition.name}: factoring must retain exact schema semantics and descriptions`,
    );
    inlineBytes += Buffer.byteLength(stableJson(inline));
    factoredBytes += Buffer.byteLength(stableJson(definition.schema));
  }
  assert.ok(
    factoredBytes < inlineBytes * 0.8,
    `full installed planner schemas should lose duplicate declarations: ${inlineBytes} → ${factoredBytes}`,
  );
});

test("the complete planner tool set stays inside the portable provider schema subset", async () => {
  const { host } = fixture(undefined, await creatorGameCatalog());
  let attempts = 0;
  const client = new OpenRouterModelClient({
    apiKey: "secret",
    fetchImpl: async (_input, init) => {
      attempts += 1;
      const body = JSON.parse(String(init?.body)) as { model: string };
      return new Response(
        JSON.stringify({
          id: "portable-provider-schema",
          model: body.model,
          provider: "Portable Schema Fixture",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "ok" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await client.complete({
    model: DEFAULT_CREATOR_MODEL_ID,
    system: "Portable schema contract fixture.",
    messages: [{ role: "user", content: "ok" }],
    tools: host
      .definitions()
      .map(({ name, description, schema }) => ({ name, description, parameters: schema })),
    maxOutputTokens: 16,
    timeoutMs: 5_000,
  });
  assert.equal(result.kind, "assistant");
  assert.equal(attempts, 1);
});

function invalidSourceDeclaration() {
  return {
    component: {
      kind: "source_package",
      id: "interaction",
      files: [
        {
          id: "module",
          path: "Interaction.luau",
          context: "shared",
          role: "module",
          content: { kind: "slot", maximumUtf8Bytes: 4096 },
          placement: {
            kind: "create",
            operationId: "install-module",
            name: "Interaction",
            parent: {
              kind: "engine_container",
              path: "ReplicatedStorage",
            },
          },
        },
      ],
      ports: [{ id: "event", direction: "input", schema: { type: "string" } as unknown }],
      obligations: [{ id: "review" }],
    },
  };
}

test("planner union diagnostics retain all missing fields in the actual shared module and string schemas", async () => {
  const { host } = fixture();
  const input = invalidSourceDeclaration();
  const result = await host.execute("creator.define_component", input);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "TOOL_ARGUMENTS_INVALID");
  const message = result.error!.message;
  for (const path of [
    "component.files.0.imports",
    "component.ports.0.schema.maxLength",
    "component.obligations.0.description",
    "component.obligations.0.evidence",
  ])
    assert.ok(message.includes(path), path);
  assert.doesNotMatch(
    message,
    /files\.0\.(role|context)|className|schema\.(items|maxItems|properties|anyOf)/,
  );
  const batch = host.validateBatch([call("invalid", "creator.define_component", input)], new Set());
  assert.equal(batch.valid, false);
  assert.equal(batch.feedback[0]!.result.error!.message, message);
});

test("planner diagnostics follow valid nested schema types without losing their required fields", async () => {
  const { host } = fixture();
  const input = invalidSourceDeclaration();
  input.component.ports[0]!.schema = {
    type: "object",
    properties: { label: { type: "string" } },
    required: ["label"],
    additionalProperties: false,
  };
  const result = await host.execute("creator.define_component", input);
  assert.equal(result.ok, false);
  assert.match(result.error!.message, /component\.ports\.0\.schema\.properties\.label\.maxLength/);
  assert.doesNotMatch(
    result.error!.message,
    /schema\.(items|maxItems|anyOf)|expected "entrypoint"/,
  );
  assert.match(result.error!.message, /component\.files\.0\.imports/);
});

test("unknown schema discriminators report the complete allowed set instead of guessing a branch", async () => {
  const { host } = fixture();
  const input = invalidSourceDeclaration();
  input.component.ports[0]!.schema = { type: "unknown-type" };
  const result = await host.execute("creator.define_component", input);
  assert.equal(result.ok, false);
  const message = (JSON.parse(result.error!.message) as { diagnostic: string }).diagnostic;
  assert.match(message, /component\.ports\.0\.schema\.type: Invalid option/);
  for (const allowed of [
    "string",
    "number",
    "integer",
    "boolean",
    "null",
    "array",
    "union",
    "object",
  ])
    assert.ok(message.includes(JSON.stringify(allowed)), allowed);
  assert.doesNotMatch(message, /schema\.(maxLength|maxItems|properties)/);
  assert.match(message, /component\.files\.0\.imports/);
});

test("draft snapshots are complete, sorted and detached from saved declarations", () => {
  const draft = new CreatorDesignDraft(catalog);
  const ref = draft.define({ component: component() });
  const snapshot = draft.snapshot();
  assert.deepEqual(snapshot.refs, [ref]);
  assert.deepEqual(snapshot.components, [component()]);
  assert.equal(snapshot.hash, draft.hash);
  snapshot.refs[0]!.componentHash = "0".repeat(64);
  snapshot.components[0]!.id = "mutated";
  assert.deepEqual(draft.snapshot().refs, [ref]);
  assert.equal(draft.snapshot().components[0]!.id, "folders");
});

test("real planner/runtime checkpoints retain complete consulted reads, current drafts and unresolved failures", async () => {
  const { host, source, orientation } = fixture(undefined, {
    ...catalog,
    validateComponent(value) {
      if (value.id === "discarded") throw new Error("Declared component is invalid");
    },
  });
  let turn = 0;
  let originalSystem: string | undefined;
  let currentRef: { componentId: string; componentHash: string };
  let firstReadResult: unknown;
  const client: ModelClient = {
    descriptor: {
      ...new OpenRouterModelClient({ apiKey: "offline-fixture" }).descriptor,
      transport: "offline-scripted",
    },
    async complete(request) {
      turn++;
      originalSystem ??= request.system;
      assert.equal(request.system, originalSystem);
      let calls: ModelToolCall[];
      if (turn === 1) {
        calls = [
          call("inspect-a", "project.inspect", inspect),
          call("inspect-b", "project.inspect", inspect),
          call("source", "source.read", readSource),
          call("dependencies", "source.dependencies", {
            documentId: readSource.documentId,
            direction: "closure",
          }),
          call("search", "project.search", { queries: [{ query: "Module" }] }),
          call("children", "project.children", { queries: [{ rootPath: "Workspace" }] }),
          call("api", "studio.api_lookup", { ownerName: "Part", query: "Color", limit: 1 }),
          call("catalog", "game.catalog", {}),
        ];
      } else if (turn === 2) {
        assert.equal(
          request.messages.some(
            (entry) =>
              entry.role === "user" && entry.content.startsWith("<forge_semantic_checkpoint>"),
          ),
          false,
          "read-only batches retain conversation history",
        );
        const read = request.messages.find(
          (entry) => entry.role === "tool" && entry.toolCallId === "source",
        );
        assert.ok(read?.role === "tool");
        firstReadResult = JSON.parse(read.content);
        assert.ok(stableJson(firstReadResult).includes(JSON.stringify(source).slice(1, -1)));
        calls = [
          call("define", "creator.define_component", {
            component: component(),
          }),
          call("read-components", "creator.read_components", {
            componentIds: ["folders"],
          }),
          call("failed-definition", "creator.define_component", {
            component: { ...component("Discarded"), id: "discarded" },
          }),
        ];
      } else if (turn === 3) {
        const state = checkpoint(request);
        currentRef = state.draft.refs[0];
        assert.deepEqual(state.draft.components, [component()]);
        assert.deepEqual(
          state.reads.find((entry: { name: string }) => entry.name === "source.read").result,
          firstReadResult,
        );
        assert.equal(
          state.reads.filter((entry: { name: string }) => entry.name === "project.inspect").length,
          1,
        );
        assert.deepEqual(state.inspectedObjectIds, inspect.objectIds.slice().sort());
        assert.ok(state.citations.length > 0);
        assert.ok(
          state.sourceConsultation.operations.some(
            (operation: { kind: string }) => operation.kind === "read",
          ),
        );
        assert.deepEqual(
          state.latestBatch.map((entry: { toolCallId: string }) => entry.toolCallId),
          ["define", "read-components", "failed-definition"],
        );
        assert.deepEqual(state.latestBatch[0].inputFromDraft, {
          fields: {},
          snapshotComponent: currentRef,
        });
        assert.equal(state.latestBatch[0].input, undefined);
        assert.deepEqual(
          {
            ...state.latestBatch[0].inputFromDraft.fields,
            component: state.draft.components.find(
              (entry: { id: string }) => entry.id === currentRef.componentId,
            ),
          },
          { component: component() },
          "the original successful input is reconstructed exactly without a duplicate body",
        );
        assert.equal(state.latestBatch[2].result.ok, false);
        assert.equal(state.latestBatch[2].input.component.config.operations[0].name, "Discarded");
        const read = state.reads.find(
          (entry: { name: string }) => entry.name === "creator.read_components",
        );
        assert.deepEqual(read.resultFromDraft.components, [{ snapshotComponent: currentRef }]);
        const reconstructedValue = {
          ...read.resultFromDraft.value,
          components: state.draft.components,
        };
        assert.equal(
          contentHash(stableJson(reconstructedValue)),
          read.resultFromDraft.metadata.resultHash,
        );
        calls = [
          call("bad-proposal", "creator.propose_plan", {
            inspectionObjectIds: inspect.objectIds,
            design: {
              kind: "GameDesignSpec",
              worldAuthoring: { mode: "none" },
              id: "folders",
              intent: prompt,
              componentIds: [currentRef.componentId],
              connections: [],
              artifactDependencies: [{ from: "folders", to: "absent" }],
            },
            steps: [
              {
                title: "Create the planned folder",
                details:
                  "Build the declared folder component and preserve its exact placement under the selected parent.",
                componentIds: [currentRef.componentId],
              },
            ],
            checks: [],
          }),
        ];
      } else if (turn === 4) {
        assert.ok(request.messages.length > 2, "failed proposals do not rebase context");
        assert.match(stableJson(request.messages), /PLAN_INVALID/);
        calls = [
          call("same-definition", "creator.define_component", {
            component: component(),
          }),
          call("new-read", "studio.api_lookup", { ownerName: "Folder", limit: 1 }),
        ];
      } else if (turn === 5) {
        assert.ok(
          request.messages.length > 2,
          "an unchanged definition plus new reads does not rebase context",
        );
        assert.match(stableJson(request.messages), /bad-proposal/);
        calls = [
          call("changed-definition", "creator.define_component", {
            component: component("Renamed"),
          }),
          call("failed-read", "studio.api_lookup", {}),
        ];
      } else if (turn === 6) {
        const state = checkpoint(request);
        assert.deepEqual(state.draft.components, [component("Renamed")]);
        assert.deepEqual(state.latestBatch[0].inputFromDraft.fields, {});
        assert.deepEqual(
          state.latestBatch[0].inputFromDraft.snapshotComponent,
          state.draft.refs[0],
        );
        assert.equal(state.latestProposalAttempt.result.error.code, "PLAN_INVALID");
        assert.match(state.latestProposalAttempt.result.error.message, /undeclared component/);
        assert.deepEqual(state.latestProposalAttempt.input.design.artifactDependencies, [
          { from: "folders", to: "absent" },
        ]);
        assert.equal(state.latestBatch[1].result.error.code, "ROBLOX_API_LOOKUP_INVALID");
        assert.deepEqual(state.latestBatch[1].input, {});
        assert.deepEqual(
          state.reads.find((entry: { name: string }) => entry.name === "source.read").result,
          firstReadResult,
        );
        const priorRead = state.reads.find(
          (entry: { name: string }) => entry.name === "creator.read_components",
        );
        assert.deepEqual(
          priorRead.resultFromDraft.components,
          [{ inlineComponent: component() }],
          "a superseded body that was explicitly read is not substituted with the new version",
        );
        calls = [
          call("finish", "creator.answer", {
            text: "The consulted design is retained for further review.",
            citationHandles: [],
          }),
        ];
      } else throw new Error("Unexpected offline turn");
      return {
        kind: "assistant",
        message: { role: "assistant", content: "", toolCalls: calls },
        stopReason: "tool_calls",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: 0,
        },
        requestHash: contentHash(stableJson(request)),
        responseHash: contentHash(stableJson(calls)),
        responseFacts: {
          requestedModel: request.model,
          resolvedModel: request.model,
          servingProvider: "offline",
          responseId: `offline-${turn}`,
          latencyMs: 0,
          retryCount: 0,
          finishReason: "tool-calls",
          continuationHash: null,
          continuationBytes: null,
        },
      };
    },
  };
  const result = await new ForgeNativeAgentRuntime(client).run({
    systemPrompt: "Offline planner checkpoint test.",
    prompt,
    orientation,
    tools: host,
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 8 },
    model: DEFAULT_CREATOR_MODEL_ID,
  });
  assert.equal(result.status, "completed", stableJson(result));
  assert.equal(turn, 6);
  assert.equal(
    result.toolCalls.length,
    17,
    "runtime evidence keeps all reads, definitions and failures after context replacement",
  );
  assert.ok(
    result.toolCalls.some((entry) => entry.toolCallId === "failed-definition" && !entry.result.ok),
  );
  assert.ok(
    result.toolCalls.some((entry) => entry.toolCallId === "bad-proposal" && !entry.result.ok),
  );
});

async function executeBatch(host: CreatorPlannerToolHost, calls: ModelToolCall[]) {
  const before = host.progressToken();
  const validation = host.validateBatch(calls, new Set());
  assert.equal(validation.valid, true, stableJson(validation));
  const batch: AgentToolBatchResult[] = [];
  for (const entry of calls) {
    const result = await host.execute(entry.name, entry.arguments);
    assert.equal(result.ok, true, stableJson(result.error));
    batch.push({ toolCallId: entry.id, name: entry.name, result });
  }
  return host.contextCheckpoint(batch, before);
}

test("schema-rejected and suppressed proposal metadata survives later component checkpoints", async () => {
  const { host } = fixture();
  const invalid = {
    design: { intent: "Unsubmitted visual direction λ", architecture: { name: "Lighting study" } },
  };
  const rejected = host.validateBatch(
    [call("invalid-plan", "creator.propose_plan", invalid)],
    new Set(),
  );
  assert.equal(rejected.valid, false);
  const first = await executeBatch(host, [
    call("first", "creator.define_component", { component: component() }),
  ]);
  assert.ok(first);
  const state = JSON.parse(first);
  assert.deepEqual(state.latestProposalAttempt.input, invalid);
  assert.deepEqual(state.latestProposalAttempt.result, rejected.feedback[0]!.result);
  assert.equal(state.latestProposalAttempt.authority, "untrusted_model_attempt");
  assert.equal(state.latestProposalAttempt.inputHash, contentHash(stableJson(invalid)));
  assert.deepEqual(state.latestProposalAttempt.origin, {
    stage: "batch_validation",
    toolCallId: "invalid-plan",
  });
  assert.equal(host.getOutcome(), undefined);

  const proposal = {
    inspectionObjectIds: [],
    design: {
      kind: "GameDesignSpec",
      worldAuthoring: { mode: "none" },
      id: "folders",
      intent: "Updated visual direction",
      componentIds: state.draft.refs.map((ref: { componentId: string }) => ref.componentId),
      connections: [],
      artifactDependencies: [],
    },
    steps: [
      {
        title: "Create the planned folder",
        details:
          "Build the retained folder component and preserve its exact placement under the selected parent.",
        componentIds: state.draft.refs.map((ref: { componentId: string }) => ref.componentId),
      },
    ],
    checks: [],
  };
  const invalidComponent = {
    component: { ...component(), id: "unfinished", unexpected: true },
  };
  const suppressed = host.validateBatch(
    [
      call("bad-component", "creator.define_component", invalidComponent),
      call("suppressed-plan", "creator.propose_plan", proposal),
    ],
    new Set(),
  );
  assert.equal(suppressed.valid, false);
  assert.equal(suppressed.feedback[1]!.result.error?.code, "TOOL_BATCH_REJECTED");
  const next = await executeBatch(host, [
    call("other", "creator.define_component", {
      component: { ...component(), id: "other" },
    }),
  ]);
  assert.ok(next);
  const updated = JSON.parse(next);
  assert.deepEqual(updated.latestProposalAttempt.input, proposal);
  assert.deepEqual(updated.latestProposalAttempt.result, suppressed.feedback[1]!.result);
  assert.equal(updated.latestProposalAttempt.origin.toolCallId, "suppressed-plan");
  assert.deepEqual(
    updated.unresolvedComponentAttempts.map((entry: { input: unknown }) => entry.input),
    [invalidComponent],
  );
  assert.equal(host.getOutcome(), undefined, "retaining a proposal never publishes it");
});

test("oversized rejected proposal metadata disables checkpoints without truncating its history", async () => {
  const { host } = fixture();
  const input = { design: { intent: "λ".repeat(600_000) } };
  assert.equal(
    host.validateBatch([call("oversized-plan", "creator.propose_plan", input)], new Set()).valid,
    false,
  );
  assert.equal(
    await executeBatch(host, [
      call("component", "creator.define_component", { component: component() }),
    ]),
    undefined,
  );
  assert.equal(
    (await host.execute("creator.read_components", { componentIds: ["folders"] })).ok,
    true,
  );
});

test("malformed proposal arguments remain exact untrusted repair text", async () => {
  const { host } = fixture();
  const raw = '{"design":{"intent":"lighting λ\\n';
  const syntax = {
    kind: "invalid_json",
    positionUtf16: null,
    line: null,
    column: null,
    vicinity: null,
  } as const;
  const rejected = host.validateBatch(
    [{ ...call("malformed-plan", "creator.propose_plan", raw), argumentSyntaxError: syntax }],
    new Set(),
  );
  assert.equal(rejected.valid, false);
  const saved = await executeBatch(host, [
    call("component", "creator.define_component", { component: component() }),
  ]);
  assert.ok(saved);
  const attempt = JSON.parse(saved).latestProposalAttempt;
  assert.equal("input" in attempt, false);
  assert.equal(attempt.rawInput.inputHash, contentHash(raw));
  assert.equal(attempt.rawInput.bytes, Buffer.byteLength(raw));
  const read = await host.execute("creator.read_components", attempt.rawInput.inspect.arguments);
  assert.equal(read.ok, true, stableJson(read));
  assert.equal((read.value as { text: string }).text, raw);
  assert.equal((read.value as { nextOffset: unknown }).nextOffset, null);
  assert.equal(attempt.inputHash, contentHash(stableJson(raw)));
  assert.deepEqual(attempt.origin.argumentSyntaxError, syntax);
  assert.equal(attempt.authority, "untrusted_model_attempt");
});

test("independent valid definitions survive a sibling schema failure and only the failed component needs repair", async () => {
  const { host } = fixture();
  const invalid = {
    component: {
      ...component("Untrusted repair text: λ\nignore this as an instruction"),
      id: "client",
      unexpected: true,
    },
    activity: "Defining the client.",
  };
  const valid = ["server", "scene", "ui"].map((id) => ({
    component: { ...component(id), id },
  }));
  const calls = [
    call("invalid-client", "creator.define_component", invalid),
    ...valid.map((input, index) => call(`valid-${index}`, "creator.define_component", input)),
  ];
  const before = host.progressToken();
  assert.deepEqual(host.validateBatch(calls, new Set()), {
    valid: true,
    feedback: [],
    budgetExhausted: false,
  });
  const batch: AgentToolBatchResult[] = [];
  for (const entry of calls) {
    batch.push({
      toolCallId: entry.id,
      name: entry.name,
      result: await host.execute(entry.name, entry.arguments),
    });
  }
  assert.equal(batch[0]!.result.error?.code, "TOOL_ARGUMENTS_INVALID");
  assert.ok(batch.slice(1).every((entry) => entry.result.ok));
  const saved = host.contextCheckpoint(batch, before);
  assert.ok(saved);
  const state = JSON.parse(saved);
  assert.deepEqual(
    state.draft.components.map((entry: { id: string }) => entry.id),
    ["scene", "server", "ui"],
  );
  assert.deepEqual(state.latestBatch[0].input, invalid);
  assert.deepEqual(state.latestBatch[0].result, batch[0]!.result);
  assert.deepEqual(state.unresolvedComponentAttempts, [
    {
      authority: "untrusted_model_attempt",
      name: "creator.define_component",
      origin: { stage: "execution" },
      input: invalid,
      inputHash: contentHash(stableJson(invalid)),
      result: batch[0]!.result,
    },
  ]);
  const untouchedRefs = state.draft.refs;
  const repaired = await executeBatch(host, [
    call("repair-client", "creator.define_component", {
      component: { ...component("Client"), id: "client" },
    }),
  ]);
  assert.ok(repaired);
  const complete = JSON.parse(repaired);
  assert.deepEqual(complete.unresolvedComponentAttempts, []);
  assert.deepEqual(
    complete.draft.refs.filter((ref: { componentId: string }) => ref.componentId !== "client"),
    untouchedRefs,
  );
  assert.equal(
    host.getOutcome(),
    undefined,
    "Saved declarations do not authorize a plan or candidate",
  );
});

test("draft sibling admission preserves envelope, syntax, mixed-tool and budget rejection", async () => {
  const valid = call("valid", "creator.define_component", {
    component: component(),
  });
  const invalid = call("invalid", "creator.define_component", {
    component: { ...component(), id: "invalid", unexpected: true },
  });
  const cases: Array<{
    calls: ModelToolCall[];
    seen?: string[];
    budget?: BudgetPolicy;
  }> = [
    { calls: [valid, { ...invalid, id: valid.id }] },
    { calls: [valid, invalid], seen: [valid.id] },
    { calls: [valid, { ...invalid, id: "" }] },
    { calls: [valid, { ...invalid, name: "creator.unknown" }] },
    { calls: [valid, invalid, call("read", "creator.read_components", {})] },
    { calls: [valid, invalid, call("propose", "creator.propose_plan", {})] },
    {
      calls: [
        valid,
        call("unidentified", "creator.define_component", {
          component: { unexpected: true },
        }),
      ],
    },
    {
      calls: [
        valid,
        {
          ...invalid,
          arguments: '{"component":',
          argumentSyntaxError: {
            kind: "invalid_json",
            positionUtf16: null,
            line: null,
            column: null,
            vicinity: null,
          },
        },
      ],
    },
    {
      calls: [valid, invalid],
      budget: { ...DEFAULT_AGENT_BUDGETS, maxToolCalls: 1 },
    },
  ];
  for (const entry of cases) {
    const { host } = fixture(undefined, catalog, entry.budget);
    const before = host.progressToken();
    const decision = host.validateBatch(entry.calls, new Set(entry.seen));
    assert.equal(decision.valid, false, stableJson(entry));
    assert.equal(decision.feedback.length, entry.calls.length);
    assert.equal(host.progressToken(), before);
    assert.equal(decision.budgetExhausted, entry.budget !== undefined);
  }
});

test("the native runtime continues from partial draft progress without replaying valid siblings", async () => {
  const { host, orientation, freshHost } = fixture();
  const journal: AgentExecutionCheckpoint[] = [];
  let turns = 0;
  const invalid = {
    component: { ...component(""), id: "client" },
  };
  const client: ModelClient = {
    descriptor: {
      ...new OpenRouterModelClient({ apiKey: "offline-fixture" }).descriptor,
      transport: "offline-scripted",
    },
    async complete(request) {
      turns++;
      let calls: ModelToolCall[];
      if (turns === 1) {
        calls = [
          call("client-invalid", "creator.define_component", invalid),
          ...["scene", "server", "ui"].map((id) =>
            call(id, "creator.define_component", {
              component: { ...component(id), id },
            }),
          ),
        ];
      } else {
        assert.equal(turns, 2);
        const saved = checkpoint(request);
        assert.deepEqual(
          saved.draft.refs.map((ref: { componentId: string }) => ref.componentId),
          ["scene", "server", "ui"],
        );
        assert.deepEqual(saved.latestBatch[0].input, invalid);
        assert.equal(saved.latestBatch[0].result.error.code, "TOOL_ARGUMENTS_INVALID");
        calls = [
          call("client-repaired", "creator.repair_component", {
            attemptId: JSON.parse(saved.latestBatch[0].result.error.message).repair.attemptId,
            edits: [
              {
                op: "replace",
                path: ["component", "config", "operations", 0, "name"],
                value: "Client",
              },
            ],
          }),
          call("finish", "creator.answer", {
            text: "Draft declarations are retained.",
            citationHandles: [],
          }),
        ];
      }
      return {
        kind: "assistant",
        message: { role: "assistant", content: "", toolCalls: calls },
        stopReason: "tool_calls",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: 0,
        },
        requestHash: contentHash(stableJson(request)),
        responseHash: contentHash(stableJson(calls)),
        responseFacts: {
          requestedModel: request.model,
          resolvedModel: request.model,
          servingProvider: "offline",
          responseId: `partial-${turns}`,
          latencyMs: 0,
          retryCount: 0,
          finishReason: "tool-calls",
          continuationHash: null,
          continuationBytes: null,
        },
      };
    },
  };
  const result = await new ForgeNativeAgentRuntime(client).run({
    systemPrompt: "Offline independent planner definitions.",
    executionJournal: {
      async checkpoint(entry) {
        journal.push(structuredClone(entry));
      },
    },
    prompt,
    orientation,
    tools: host,
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 3 },
    model: DEFAULT_CREATOR_MODEL_ID,
  });
  assert.equal(result.status, "completed", stableJson(result));
  assert.equal(turns, 2);
  assert.equal(result.toolCalls.length, 6);
  assert.ok(result.toolCalls.every((entry) => entry.disposition === "executed"));
  assert.equal(result.toolCalls.filter((entry) => !entry.result.ok).length, 1);
  assert.equal(result.toolCalls[0]!.result.error?.code, "TOOL_ARGUMENTS_INVALID");
  for (const id of ["scene", "server", "ui"])
    assert.equal(result.toolCalls.filter((entry) => entry.toolCallId === id).length, 1);
  // Reconstruct only from exact recorded completed calls under the same immutable
  // fixture boundary. This is offline proof, not automatic planner-resume policy.
  const replay = freshHost();
  const restored = JSON.parse(JSON.stringify(journal)) as AgentExecutionCheckpoint[];
  for (const entry of restored) {
    if (entry.checkpointType !== "tool_completed") continue;
    const actual = await replay.execute(entry.toolCall.name, entry.toolCall.input);
    assert.equal(actual.resultHash, entry.toolCall.resultHash);
    assert.deepEqual(actual, entry.toolCall.result);
  }
  assert.equal(replay.progressToken(), host.progressToken());
  assert.deepEqual(replay.getOutcome(), host.getOutcome());
});

test("durable partial planner batches resume from the exact completed sibling prefix", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-partial-planner-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentExecutionJournalStore(directory);
  const sink = store.sink("partial-planner-resume");
  const { host, freshHost, orientation } = fixture();
  let requests = 0;
  const firstCalls = [
    call("invalid", "creator.define_component", { component: { ...component(""), id: "client" } }),
    ...["scene", "server", "ui"].map((id) =>
      call(id, "creator.define_component", { component: { ...component(id), id } }),
    ),
  ];
  const client: ModelClient = {
    descriptor: {
      ...new OpenRouterModelClient({ apiKey: "offline-fixture" }).descriptor,
      transport: "offline-scripted",
    },
    async complete(request) {
      requests++;
      assert(requests <= 2, "A persisted model response cannot be redispatched");
      const calls =
        requests === 1
          ? firstCalls
          : [
              call("answer", "creator.answer", {
                text: "The three independent declarations are retained.",
                citationHandles: [],
              }),
            ];
      return {
        kind: "assistant",
        message: { role: "assistant", content: "", toolCalls: calls },
        stopReason: "tool_calls",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: 0,
        },
        requestHash: contentHash(stableJson(request)),
        responseHash: contentHash(stableJson(calls)),
        responseFacts: {
          requestedModel: request.model,
          resolvedModel: request.model,
          servingProvider: "offline",
          responseId: "partial-resume-" + requests,
          latencyMs: 0,
          retryCount: 0,
          finishReason: "tool-calls",
          continuationHash: null,
          continuationBytes: null,
        },
      };
    },
  };
  const runtime = new ForgeNativeAgentRuntime(client);
  const common = {
    systemPrompt: "Offline partial planner restart.",
    prompt,
    orientation,
    budgets: DEFAULT_AGENT_BUDGETS,
    model: DEFAULT_CREATOR_MODEL_ID,
  };
  await assert.rejects(
    runtime.run({
      ...common,
      tools: host,
      executionJournal: {
        journalId: "partial-planner-resume",
        async checkpoint(entry) {
          await sink.checkpoint(entry);
          if (entry.checkpointType === "tool_completed" && entry.toolCall.toolCallId === "scene")
            throw new Error("Interrupted after durable successful sibling");
        },
      },
    }),
    /Interrupted after durable successful sibling/,
  );
  const interrupted = await store.load("partial-planner-resume");
  const decision = interrupted.entries.find(
    (entry) => entry.checkpoint.checkpointType === "batch_validated",
  )!.checkpoint;
  assert.equal(decision.checkpointType, "batch_validated");
  if (decision.checkpointType !== "batch_validated") throw new Error("Missing validated batch");
  assert.equal(decision.decision.valid, true);
  const completed = interrupted.entries.flatMap((entry) =>
    entry.checkpoint.checkpointType === "tool_completed" ? [entry.checkpoint.toolCall] : [],
  );
  assert.deepEqual(
    completed.map((entry) => [entry.toolCallId, entry.result.ok]),
    [
      ["invalid", false],
      ["scene", true],
    ],
  );
  await assert.rejects(
    runtime.run({
      ...common,
      tools: freshHost(),
      executionJournal: sink,
      resumeFromJournal: createAgentExecutionJournalResume(interrupted),
    }),
    /host state changed after its durable boundary/,
  );
  assert.equal(requests, 1);
  const restored = freshHost();
  for (const call of completed) {
    const result = await restored.execute(call.name, call.input);
    assert.equal(result.resultHash, call.resultHash);
    assert.deepEqual(result, call.result);
  }
  assert.equal(restored.progressToken(), host.progressToken());
  const newExecutions: unknown[] = [];
  const execute = restored.execute.bind(restored);
  restored.execute = async (name, input) => {
    newExecutions.push(input);
    return execute(name, input);
  };
  const result = await runtime.run({
    ...common,
    tools: restored,
    executionJournal: sink,
    resumeFromJournal: createAgentExecutionJournalResume(interrupted),
  });
  assert.equal(result.status, "completed", stableJson(result));
  assert.equal(requests, 2);
  assert.deepEqual(newExecutions, [
    firstCalls[2]!.arguments,
    firstCalls[3]!.arguments,
    { text: "The three independent declarations are retained.", citationHandles: [] },
  ]);
  const terminal = await store.load("partial-planner-resume");
  const records = terminal.entries.flatMap((entry) =>
    entry.checkpoint.checkpointType === "tool_completed"
      ? [entry.checkpoint.toolCall.toolCallId]
      : [],
  );
  assert.deepEqual(records, ["invalid", "scene", "server", "ui", "answer"]);
});

test("rejected execution attempts persist until a successful definition of that same component", async () => {
  const { host } = fixture();
  await executeBatch(host, [
    call("initial", "creator.define_component", { component: component() }),
  ]);
  const stale = {
    component: { ...component("Rejected replacement"), unexpected: true },
  };
  const failed = await host.execute("creator.define_component", stale);
  assert.equal(failed.ok, false);
  const unrelated = await executeBatch(host, [
    call("other", "creator.define_component", {
      component: { ...component("Other"), id: "other" },
    }),
  ]);
  assert.ok(unrelated);
  const state = JSON.parse(unrelated);
  assert.deepEqual(state.unresolvedComponentAttempts, [
    {
      authority: "untrusted_model_attempt",
      name: "creator.define_component",
      origin: { stage: "execution" },
      input: stale,
      inputHash: contentHash(stableJson(stale)),
      result: failed,
    },
  ]);
  const repaired = await executeBatch(host, [
    call("repair", "creator.define_component", {
      component: component("Accepted replacement"),
    }),
  ]);
  assert.ok(repaired);
  assert.deepEqual(JSON.parse(repaired).unresolvedComponentAttempts, []);
});

test("retained repairs revalidate complete declarations and reject superseded bases", async () => {
  const { host } = fixture();
  const invalid = { component: component("") };
  const failed = await host.execute("creator.define_component", invalid);
  assert.equal(failed.ok, false);
  const attemptId = JSON.parse(failed.error!.message).repair.attemptId as string;
  const stillInvalid = {
    attemptId,
    edits: [{ op: "replace", path: ["component", "config", "operations", 0, "name"], value: "" }],
  };
  const rejected = await host.execute("creator.repair_component", stillInvalid);
  assert.equal(rejected.error?.code, "TOOL_ARGUMENTS_INVALID");
  const nextAttemptId = JSON.parse(rejected.error!.message).repair.attemptId as string;
  assert.notEqual(nextAttemptId, attemptId);
  const before = host.progressToken();
  const repaired = await host.execute("creator.repair_component", {
    attemptId: nextAttemptId,
    edits: [
      { op: "replace", path: ["component", "config", "operations", 0, "name"], value: "Repaired" },
    ],
  });
  assert.equal(repaired.ok, true, stableJson(repaired));
  assert.notEqual(host.progressToken(), before);
  assert.equal(
    (repaired.value as { componentHash: string }).componentHash,
    contentHash(stableJson(component("Repaired"))),
  );
  const stale = await host.execute("creator.repair_component", stillInvalid);
  assert.equal(stale.ok, false);
  const read = await host.execute("creator.read_components", { componentIds: ["folders"] });
  assert.deepEqual((read.value as { components: unknown[] }).components, [component("Repaired")]);
  assert.equal(host.getOutcome(), undefined);
});

test("repair diagnostics are budgeted before tool-result publication", async () => {
  const { host } = fixture(undefined, catalog, { ...DEFAULT_AGENT_BUDGETS, maxToolResultBytes: 1 });
  const result = await host.execute("creator.define_component", { component: component("") });
  assert.equal(result.error?.code, "TOOL_OUTPUT_BUDGET_EXHAUSTED");
  assert.doesNotMatch(result.error!.message, /creator_component_attempt_/);
});

test("rejected candidates remain readable by attempt ID and unsaved IDs provide exact navigation", async () => {
  const { host } = fixture();
  const invalid = { component: { ...component(""), unexpected: "remove exactly this" } };
  const rejected = await host.execute("creator.define_component", invalid);
  const failure = JSON.parse(rejected.error!.message);
  const attemptId = failure.repair.attemptId as string;
  assert.deepEqual(failure.repair.inspect, {
    tool: "creator.read_components",
    arguments: { attemptId },
  });
  assert.ok(
    failure.issues.items.some(
      (item: { path: unknown; current: unknown }) =>
        stableJson(item.path) === stableJson(["component", "unexpected"]) &&
        stableJson(item.current) ===
          stableJson({ status: "present", value: "remove exactly this" }),
    ),
  );
  const notSaved = await host.execute("creator.read_components", { componentIds: ["folders"] });
  assert.equal(notSaved.error?.code, "COMPONENT_NOT_SAVED");
  assert.deepEqual(
    JSON.parse(notSaved.error!.message).details.components[0].inspect,
    failure.repair.inspect,
  );
  const read = await host.execute("creator.read_components", { attemptId });
  assert.equal(read.ok, true, stableJson(read));
  const value = read.value as {
    authority: string;
    selected: { value: unknown };
    inputHash: string;
  };
  assert.equal(value.authority, "untrusted_model_attempt");
  assert.deepEqual(value.selected.value, invalid.component);
  assert.equal(value.inputHash, contentHash(stableJson(invalid)));
  assert.equal(
    (await host.execute("creator.read_components", { attemptId, componentIds: ["folders"] })).error
      ?.code,
    "COMPONENT_READ_AMBIGUOUS",
  );
  assert.equal(
    (await host.execute("creator.read_components", { path: ["component"] })).error?.code,
    "COMPONENT_READ_AMBIGUOUS",
  );
  const repaired = await host.execute("creator.repair_component", {
    attemptId,
    edits: [
      { op: "remove", path: ["component", "unexpected"] },
      { op: "replace", path: ["component", "config", "operations", 0, "name"], value: "Repaired" },
    ],
  });
  assert.equal(repaired.ok, true, stableJson(repaired));
  assert.equal((await host.execute("creator.read_components", { attemptId })).ok, false);
  const saved = await host.execute("creator.read_components", { componentIds: ["folders"] });
  assert.deepEqual((saved.value as { components: unknown[] }).components, [component("Repaired")]);
  assert.equal(host.getOutcome(), undefined);
});

test("adding an explicitly missing field still revalidates the complete rejected component", async () => {
  const { host } = fixture();
  const input = JSON.parse(stableJson({ component: component("Added") }));
  delete input.component.config.operations[0].name;
  const rejected = await host.execute("creator.define_component", input);
  assert.equal(rejected.ok, false);
  const failure = JSON.parse(rejected.error!.message);
  const item = failure.issues.items.find(
    (issue: { path: unknown }) =>
      stableJson(issue.path) === stableJson(["component", "config", "operations", 0, "name"]),
  );
  assert.deepEqual(item.current, { status: "missing" });
  assert.deepEqual(item.operations, ["add"]);
  const repaired = await host.execute("creator.repair_component", {
    attemptId: failure.repair.attemptId,
    edits: [{ op: "add", path: ["component", "config", "operations", 0, "name"], value: "Added" }],
  });
  assert.equal(repaired.ok, true, stableJson(repaired));
});

test("definitions and repairs for the same component reject together without changing its draft", async () => {
  const { host } = fixture();
  const invalid = await host.execute("creator.define_component", { component: component("") });
  const attemptId = JSON.parse(invalid.error!.message).repair.attemptId as string;
  const repair = call("repair", "creator.repair_component", {
    attemptId,
    edits: [
      { op: "replace", path: ["component", "config", "operations", 0, "name"], value: "Repaired" },
    ],
  });
  const before = host.progressToken();
  const decision = host.validateBatch(
    [repair, call("define", "creator.define_component", { component: component("Other") })],
    new Set(),
  );
  assert.equal(decision.valid, false);
  assert.ok(
    decision.feedback.every((entry) => entry.result.error?.code === "DRAFT_COMPONENT_ID_DUPLICATE"),
  );
  assert.equal(host.progressToken(), before);
});

test("malformed component argument text remains exact and is never guessed into a component identity", async () => {
  const { host, freshHost } = fixture();
  const malformed = '{"component":{"id":"folders","text":"λ\\n';
  const syntax = {
    kind: "invalid_json",
    positionUtf16: null,
    line: null,
    column: null,
    vicinity: null,
  } as const;
  const decision = host.validateBatch(
    [{ ...call("malformed", "creator.define_component", malformed), argumentSyntaxError: syntax }],
    new Set(),
  );
  assert.equal(decision.valid, false);
  const saved = await executeBatch(host, [
    call("successful", "creator.define_component", { component: component() }),
  ]);
  assert.ok(saved);
  const [attempt] = JSON.parse(saved).unresolvedComponentAttempts;
  assert.equal("input" in attempt, false);
  assert.equal(attempt.rawInput.inputHash, contentHash(malformed));
  assert.equal(attempt.rawInput.bytes, Buffer.byteLength(malformed, "utf8"));
  const read = await host.execute("creator.read_components", attempt.rawInput.inspect.arguments);
  assert.equal(read.ok, true, stableJson(read));
  assert.equal((read.value as { text: string }).text, malformed);
  assert.equal((read.value as { authority: string }).authority, "untrusted_model_attempt");
  assert.equal((read.value as { nextOffset: unknown }).nextOffset, null);
  assert.equal(
    (
      await host.execute("creator.read_components", {
        syntaxAttemptId: attempt.rawInput.syntaxAttemptId,
        componentIds: ["folders"],
      })
    ).ok,
    false,
  );
  assert.equal((await host.execute("creator.read_components", { offset: 0 })).ok, false);
  assert.equal(attempt.inputHash, contentHash(stableJson(malformed)));
  assert.deepEqual(attempt.origin.argumentSyntaxError, syntax);
  assert.equal(attempt.origin.toolCallId, "malformed");
  const replay = freshHost();
  replay.validateBatch(
    [{ ...call("malformed", "creator.define_component", malformed), argumentSyntaxError: syntax }],
    new Set(),
  );
  assert.deepEqual(
    await replay.execute("creator.read_components", attempt.rawInput.inspect.arguments),
    read,
  );
});

test("unresolved attempt overflow preserves runtime history instead of dropping authored inputs", async () => {
  const { host } = fixture();
  const invalid = { component: { id: "large", payload: "λ".repeat(600_000) } };
  assert.equal(
    host.validateBatch([call("large", "creator.define_component", invalid)], new Set()).valid,
    false,
  );
  assert.equal(
    await executeBatch(host, [
      call("valid", "creator.define_component", { component: component() }),
    ]),
    undefined,
  );
  const read = await host.execute("creator.read_components", { componentIds: ["folders"] });
  assert.equal(read.ok, true, "retention pressure does not reject accepted authoring");
  assert.deepEqual((read.value as { components: unknown[] }).components, [component()]);
});

test("checkpoint read identity ignores activity narration while retaining exact latest input and result", async () => {
  const { host } = fixture();
  await host.execute("game.catalog", { activity: "First lookup." });
  const input = { activity: "The same catalog with different narration." };
  const result = await host.execute("game.catalog", input);
  const saved = await executeBatch(host, [
    call("define", "creator.define_component", { component: component() }),
  ]);
  assert.ok(saved);
  assert.deepEqual(JSON.parse(saved).reads, [{ name: "game.catalog", input, result }]);
});

test("source checkpoints preserve canonical authority and exact editable input bodies separately", async () => {
  const { host } = fixture();
  const invalid = invalidSourceDeclaration();
  const input = {
    component: {
      ...invalid.component,
      ports: [],
      obligations: [],
      files: invalid.component.files.map((file) => ({ ...file, imports: [] })),
    },
  };
  const saved = await executeBatch(host, [
    call("source", "creator.define_component", input),
    call("editable", "creator.read_components", { componentIds: ["interaction"] }),
  ]);
  assert.ok(saved);
  const state = JSON.parse(saved);
  const canonical = state.draft.components[0];
  assert.equal(canonical.files[0].placement.className, "ModuleScript");
  assert.equal(canonical.files[0].placement.parent.className, "ReplicatedStorage");
  assert.equal(state.draft.refs[0].componentHash, contentHash(stableJson(canonical)));
  assert.deepEqual(state.latestBatch[0].input, input);
  assert.equal(
    state.latestBatch[0].inputFromDraft,
    undefined,
    "a canonicalized snapshot must not be substituted for the exact authored input",
  );
  assert.deepEqual(state.reads[0].resultFromDraft.components, [
    { inlineComponent: input.component },
  ]);
  const reconstructed = {
    ...state.reads[0].resultFromDraft.value,
    components: [input.component],
  };
  assert.equal(
    contentHash(stableJson(reconstructed)),
    state.reads[0].resultFromDraft.metadata.resultHash,
  );
});

test("large saved definitions appear once while exact input fields remain reconstructible", async () => {
  const { host } = fixture();
  const declaration = component();
  declaration.config.operations = Array.from({ length: 64 }, (_, index) => ({
    ...declaration.config.operations[0]!,
    id: `folder-${index}`,
    name: `Folder ${index}`,
  }));
  const input = {
    component: declaration,

    activity: "Arranging the requested objects.",
  };
  const saved = await executeBatch(host, [call("define", "creator.define_component", input)]);
  assert.ok(saved);
  const state = JSON.parse(saved);
  const entry = state.latestBatch[0];
  assert.equal(entry.input, undefined);
  assert.deepEqual(entry.inputFromDraft.fields, {
    activity: input.activity,
  });
  assert.equal(
    entry.inputFromDraft.snapshotComponent.componentHash,
    contentHash(stableJson(state.draft.components[0])),
  );
  assert.deepEqual({ ...entry.inputFromDraft.fields, component: state.draft.components[0] }, input);
  const { inputFromDraft: _reference, ...metadata } = entry;
  const repeated = stableJson({ ...state, latestBatch: [{ ...metadata, input }] });
  assert.ok(
    Buffer.byteLength(saved) < Buffer.byteLength(repeated) * 0.65,
    "a large accepted declaration is not retransmitted twice in the checkpoint",
  );
});

test("duplicate component identities reject the whole batch before any draft mutation", async () => {
  for (const mixed of [false, true]) {
    const { host } = fixture();
    const calls = [
      call("first", "creator.define_component", { component: component() }),
      call("replacement", "creator.define_component", {
        component: component("Replacement"),
      }),
      ...(mixed ? [call("read", "creator.read_components", {})] : []),
    ];
    const before = host.progressToken();
    const decision = host.validateBatch(calls, new Set());
    assert.equal(decision.valid, false);
    assert.deepEqual(
      decision.feedback.map((entry) => entry.result.error?.code),
      [
        "DRAFT_COMPONENT_ID_DUPLICATE",
        "DRAFT_COMPONENT_ID_DUPLICATE",
        ...(mixed ? ["TOOL_BATCH_REJECTED"] : []),
      ],
    );
    assert.equal(host.progressToken(), before);
    const read = await host.execute("creator.read_components", {});
    assert.deepEqual(read.value, { refs: [], components: [] });
  }
});

test("an oversized latest batch preserves history even when the deduplicated read cache fits", async () => {
  const { host } = fixture(`--${"source bytes stay exact λ ".repeat(2400)}\nreturn {}\n`);
  const calls = Array.from({ length: 40 }, (_, index) =>
    call(`read-${index}`, "source.read", readSource),
  );
  calls.push(call("define", "creator.define_component", { component: component() }));
  assert.equal(await executeBatch(host, calls), undefined);
  const read = await host.execute("creator.read_components", { componentIds: ["folders"] });
  assert.equal(read.ok, true, "checkpoint size never rejects accepted authoring");
  assert.deepEqual((read.value as { components: unknown[] }).components, [component()]);
});

test("read cache overflow disables later checkpoints without evicting history or limiting authoring", async () => {
  const { host } = fixture(`--${"bounded source cache λ ".repeat(2800)}\nreturn {}\n`);
  const reads = Array.from({ length: 40 }, (_, index) =>
    call(`read-${index}`, "source.read", { ...readSource, maximumUtf8Bytes: 30000 + index }),
  );
  assert.equal(await executeBatch(host, reads), undefined);
  assert.equal(
    await executeBatch(host, [
      call("define", "creator.define_component", { component: component() }),
    ]),
    undefined,
  );
  const read = await host.execute("creator.read_components", {});
  assert.equal(read.ok, true);
  assert.equal((read.value as { refs: unknown[] }).refs.length, 1);
});
