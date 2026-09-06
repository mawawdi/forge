import {
  creatorGameCatalog,
  projectCreatorGameComponentInput,
} from "../packages/creator-session/src/game-authoring.js";
import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_AGENT_BUDGETS,
  ForgeNativeAgentRuntime,
} from "../packages/agent-runtime/src/index.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  compileGamePlan,
  type GameInventoryItem,
  type GameObservedSourceArtifact,
} from "../packages/game-compiler/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameRecipeDefinition,
  type GameDesignSpec,
  type GameSourcePlacement,
  type GameSourceFile,
} from "../packages/game-ir/src/index.js";
import {
  STUDIO_PATCH_DEFINITION,
  PROJECT_ASSEMBLY_DEFINITION,
  gameAssemblyOperationId,
} from "../packages/game-composition/src/index.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  advanceSession,
  assertCreatorTransactionControlActionBinding,
  assertCreatorBuildContract,
  assertCreatorChangeSet,
  assertCreatorRequestArtifact,
  assertCreatorAgentOutcome,
  assertOwnershipMap,
  canonicalizeCreatorPropertyInput,
  createCreatorApproval,
  createCreatorBuildContract,
  prepareCreatorBuildPlan,
  createCreatorPlan,
  createCreatorTransactionControlView,
  createCreatorAgentContextCitation,
  assertCreatorSessionBundle,
  creatorOrientation,
  creatorLayoutNotes,
  creatorBuilderSystemPrompt,
  creatorPlanSummary,
  createCreatorSession,
  createStudioOwnershipMap,
  CreatorBuilderToolHost,
  patchCreatorDraftSource,
  creatorDraftPage,
  CreatorPlannerToolHost,
  type CreatorPlanChange,
  type CreatorProjectIndexView,
  type CreatorSessionBundle,
  type VerificationCharterProposalClause,
} from "../packages/creator-session/src/index.js";
import type { ProjectAuthorityManifest } from "../packages/project-authority/src/index.js";
import {
  SourceConsultationRecorder,
  createPinnedLuauLspSourceIndex,
  type SourceDocumentInput,
} from "../packages/source-intelligence/src/index.js";
import {
  assertCreatorTransactionControlAction,
  restoredCreatorControlDetail,
} from "../packages/creator-session/src/coordinator.js";
import { CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS } from "../packages/studio-capabilities/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_RESOLVABLE_CLASSES,
  studioObjectIdentityKey,
  type StudioObjectIdentity,
} from "../packages/studio-evidence/src/index.js";
import {
  OpenRouterModelClient,
  DEFAULT_CREATOR_MODEL_ID,
} from "../packages/model-client/src/index.js";

const plannerCatalog = await creatorGameCatalog();

/** Inspect the advertised schema through local references, without assuming inline storage. */
function schemaAt(root: unknown, path: readonly (string | number)[]): Record<string, unknown> {
  const record = (value: unknown): Record<string, unknown> => {
    assert.ok(value !== null && typeof value === "object", "schema path must resolve to an object");
    return value as Record<string, unknown>;
  };
  const resolve = (value: unknown, active = new Set<string>()): Record<string, unknown> => {
    const node = record(value);
    if (typeof node.$ref !== "string") return node;
    assert.ok(node.$ref.startsWith("#/$defs/"), "tool schemas must use local definitions");
    assert.equal(active.has(node.$ref), false, "direct schema reference cycles are invalid");
    const reference = node.$ref;
    const target = reference
      .split("/")
      .slice(1)
      .reduce<unknown>((parent, key) => {
        const decoded = key.replaceAll("~1", "/").replaceAll("~0", "~");
        const object = record(parent);
        assert.ok(Object.hasOwn(object, decoded), `unresolved schema reference ${reference}`);
        return object[decoded];
      }, root);
    const { $ref: _reference, ...siblings } = node;
    return { ...resolve(target, new Set([...active, reference])), ...siblings };
  };
  return resolve(path.reduce<unknown>((value, key) => resolve(value)[key], root));
}

/** Submit a full fixture through the model's component authoring protocol. */
async function submitDesign(
  host: CreatorPlannerToolHost,
  proposal: { design: { components: unknown[]; [key: string]: unknown }; [key: string]: unknown },
) {
  const componentIds: string[] = [];
  for (const component of proposal.design.components) {
    const result = await host.execute("creator.define_component", {
      component:
        (component as { kind: string; files?: unknown[] }).kind === "source_package" &&
        Array.isArray((component as { files?: unknown[] }).files)
          ? projectCreatorGameComponentInput(component as GameDesignSpec["components"][number])
          : component,
    });
    if (!result.ok) return result;
    const ref = result.value as { componentId: string; componentHash: string };
    componentIds.push(ref.componentId);
  }
  const { components: _components, ...metadata } = proposal.design;
  return host.execute("creator.propose_plan", {
    ...proposal,
    steps:
      proposal.steps ??
      componentIds.map((componentId, index) => ({
        title: `Implementation area ${index + 1}`,
        details:
          "Implement the declared component and connect its exact editor output to the requested experience.",
        componentIds: [componentId],
      })),
    design: { ...metadata, componentIds },
  });
}

const revisionHash = contentHash("initial evidence revision");

/** Test fixtures compile their exact inventory through the production compiler. */
function createTestPlan(
  input: Omit<Parameters<typeof createCreatorPlan>[0], "compiled">,
  index: Parameters<typeof createCreatorPlan>[1],
  ownership: Parameters<typeof createCreatorPlan>[2],
  payloads: Record<
    string,
    Partial<Pick<GameInventoryItem, "lockedProperties" | "valueSlots" | "attributes">>
  > = {},
  sourceContract: { imports?: Record<string, string[]>; observed?: Record<string, string> } = {},
) {
  const definition: GameRecipeDefinition = {
    kind: "GameRecipeDefinition",
    id: "test-inventory",
    abi: "1",
    sourceExports: [],
    configSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    ports: [],
    obligations: [],
  };
  const inventory: GameInventoryItem[] = input.changes.map((change) => {
    const observed =
      change.kind === "create"
        ? undefined
        : index.instances.find(
            (instance) => stableJson(instance.identity) === stableJson(change.target.identity),
          );
    const source =
      observed && index.scripts.find((script) => script.documentId === observed.objectId);
    const sourceBearing =
      change.kind === "edit_source" ||
      (change.kind === "create" &&
        ["Script", "LocalScript", "ModuleScript"].includes(change.className));
    return {
      id: change.id,
      componentId: sourceBearing ? "fixture-source" : "fixture",
      change,
      lockedProperties: {},
      valueSlots: [],
      attributes: {},
      removedAttributes: [],
      dependencies: [],
      ...(sourceBearing
        ? {
            source: {
              fileId: change.id,
              content: { kind: "slot" as const, maximumUtf8Bytes: 256 * 1024 },
            },
          }
        : {}),
      ...(change.kind === "edit_source"
        ? { beforeSourceHash: source!.sourceHash, beforeSourceBytes: source!.utf8Bytes }
        : observed
          ? { beforeHash: contentHash(stableJson(observed)) }
          : {}),
      ...payloads[change.id],
    };
  });
  const sourceImports = (id: string) =>
    (sourceContract.imports?.[id] ?? []).map((fileId) => ({
      componentId: "fixture-source",
      fileId,
    }));
  const files: GameSourceFile[] = inventory.flatMap((item) => {
    if (!item.source) return [];
    const change = item.change;
    if (change.kind !== "create" && change.kind !== "edit_source")
      throw new Error("Fixture source placement is not a write");
    const className = change.kind === "create" ? change.className : change.target.className;
    if (className !== "Script" && className !== "LocalScript" && className !== "ModuleScript")
      throw new Error("Fixture source must be a script");
    return [
      {
        id: item.source.fileId,
        path: item.id + ".luau",
        content: item.source.content,
        role: className === "ModuleScript" ? "module" : "entrypoint",
        context:
          className === "Script" ? "server" : className === "LocalScript" ? "client" : "shared",
        imports: sourceImports(item.source.fileId),
        placement:
          change.kind === "create"
            ? {
                kind: "create",
                operationId: item.id,
                className,
                parent: change.parent,
                name: change.path.split("/").at(-1)!,
              }
            : {
                kind: "edit_source",
                operationId: item.id,
                target: change.target,
                beforeSourceHash: item.beforeSourceHash!,
                beforeSourceBytes: item.beforeSourceBytes!,
              },
      },
    ];
  });
  const observedSources: GameObservedSourceArtifact[] = Object.entries(
    sourceContract.observed ?? {},
  ).map(([fileId, documentId]) => {
    const instance = index.instances.find((instance) => instance.objectId === documentId)!;
    const source = index.scripts.find((source) => source.documentId === documentId)!;
    const target = {
      kind: "instance" as const,
      identity: instance.identity,
      path: instance.path,
      className: instance.className,
    };
    files.push({
      id: fileId,
      path: fileId + ".luau",
      role: "module",
      context: "shared",
      content: { kind: "locked", sourceHash: source.sourceHash, utf8Bytes: source.utf8Bytes },
      imports: sourceImports(fileId),
      placement: { kind: "observed", target },
    });
    return {
      componentId: "fixture-source",
      fileId,
      target,
      sourceHash: source.sourceHash,
      utf8Bytes: source.utf8Bytes,
      imports: sourceImports(fileId),
    };
  });
  const compiled = compileGamePlan({
    design: {
      kind: "GameDesignSpec",
      worldAuthoring: { mode: "none" },
      id: "fixture",
      intent: input.creatorPrompt,
      components: [
        {
          kind: "recipe_instance",
          id: "fixture",
          definition: gameRecipeDefinitionLock(definition),
          config: {},
        },
        ...(files.length
          ? [
              {
                kind: "source_package" as const,
                id: "fixture-source",
                ports: [],
                obligations: [],
                files,
              },
            ]
          : []),
      ],
      connections: [],
      artifactDependencies: [],
    },
    registry: createGameDefinitionRegistry([definition]),
    projectId: ownership.projectId,
    project: index.project,
    sessionId: input.sessionId,
    observedRevisionHash: input.projectRevisionHash,
    initialTopology: index.instances,
    observation: index,
    inventory,
    observedSources,
  });
  return createCreatorPlan(
    { ...input, compiled, changes: compiled.inventory.map((item) => item.change) },
    index,
    ownership,
  );
}

function sourceDesign(placement: GameSourcePlacement, intent: string): GameDesignSpec {
  const className = placement.kind === "create" ? placement.className : placement.target.className;
  return {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "source-change",
    intent,
    components: [
      {
        kind: "source_package",
        id: "custom-source",
        ports: [],
        obligations: [],
        files: [
          {
            id: "main",
            path: "Main.luau",
            context:
              className === "LocalScript" ? "client" : className === "Script" ? "server" : "shared",
            role: className === "ModuleScript" ? "module" : "entrypoint",
            imports: [],
            content: { kind: "slot", maximumUtf8Bytes: 256 * 1024 },
            placement,
          },
        ],
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
}

function folderDesign(
  name: string,
  parent: { kind: "engine" | "object"; id: string },
): GameDesignSpec {
  return {
    kind: "GameDesignSpec",
    worldAuthoring: { mode: "none" },
    id: "folder-change",
    intent: "Create the requested folder.",
    components: [
      {
        kind: "recipe_instance",
        id: "folder",
        definition: gameRecipeDefinitionLock(STUDIO_PATCH_DEFINITION),
        config: {
          operations: [
            {
              id: "folder",
              kind: "create",
              name,
              className: "Folder",
              parent,
              properties: [],
              valueSlots: [],
              attributes: [],
              removedAttributes: [],
              dependencies: [],
            },
          ],
        },
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
}

test("GUI inspection calls out collapsed fixed containers without misdiagnosing UDim2", () => {
  const size = { kind: "udim2" as const, x: { scale: 0, offset: 0 }, y: { scale: 0, offset: 0 } };
  assert.equal(
    creatorLayoutNotes({ Size: size, AutomaticSize: { kind: "enum_name", value: "None" } }).length,
    1,
  );
  assert.deepEqual(
    creatorLayoutNotes({ Size: size, AutomaticSize: { kind: "enum_name", value: "XY" } }),
    [],
  );
  assert.deepEqual(
    creatorLayoutNotes({
      Size: { ...size, x: { scale: 1, offset: -24 }, y: { scale: 0, offset: 280 } },
      AutomaticSize: { kind: "enum_name", value: "None" },
    }),
    [],
  );
});

test("draft line patches are hash-bound, atomic, unambiguous and Unicode-safe", () => {
  const source = "local name = 'שלום'\nlocal answer = 1\nprint(answer)\n";
  const hash = contentHash(source);
  assert.equal(
    patchCreatorDraftSource(source, hash, [
      { startLine: 2, deleteCount: 1, replacement: "local answer = 2\n" },
    ]),
    source.replace("answer = 1", "answer = 2"),
  );
  assert.throws(
    () =>
      patchCreatorDraftSource(source, contentHash("stale"), [
        { startLine: 2, deleteCount: 1, replacement: "" },
      ]),
    /draft changed/i,
  );
  assert.equal(
    patchCreatorDraftSource(source, hash, [
      { startLine: 2, deleteCount: 1, replacement: "local answer = 2" },
    ]),
    source.replace("answer = 1", "answer = 2"),
  );
  assert.throws(
    () =>
      patchCreatorDraftSource(source, hash, [{ startLine: 2, deleteCount: 9, replacement: "" }]),
    /outside the 3-line draft/,
  );
  assert.throws(
    () =>
      patchCreatorDraftSource(source, hash, [
        { startLine: 2, deleteCount: 2, replacement: "" },
        { startLine: 3, deleteCount: 1, replacement: "" },
      ]),
    /overlap/,
  );
  assert.throws(
    () =>
      patchCreatorDraftSource(source, hash, [
        { startLine: 0, deleteCount: 1, replacement: "" },
        { startLine: 9, deleteCount: 1, replacement: "" },
      ]),
    /Edit 1:[\s\S]*Edit 2:[\s\S]*No edits were applied/,
  );
  const repeated = "end\r\nend\r\nreturn 'שלום'";
  assert.equal(
    patchCreatorDraftSource(repeated, contentHash(repeated), [
      { startLine: 2, deleteCount: 1, replacement: "print('middle')\r\n" },
      { startLine: 3, deleteCount: 1, replacement: "return '你好'" },
    ]),
    "end\r\nprint('middle')\r\nreturn '你好'",
  );
  assert.equal(
    patchCreatorDraftSource("", contentHash(""), [
      { startLine: 1, deleteCount: 0, replacement: "return true" },
    ]),
    "return true",
  );
  assert.equal(
    patchCreatorDraftSource("a\n", contentHash("a\n"), [
      { startLine: 2, deleteCount: 0, replacement: "b\n" },
    ]),
    "a\nb\n",
  );
  assert.throws(
    () =>
      patchCreatorDraftSource(source, hash, [
        { startLine: 2, deleteCount: 0, replacement: "-- first\n" },
        { startLine: 2, deleteCount: 0, replacement: "-- second\n" },
      ]),
    /overlap/,
  );
  const page = creatorDraftPage(repeated, 2, 1);
  assert.deepEqual(page.lines, [{ line: 2, text: "end\r\n" }]);
  assert.equal(page.nextLine, 3);
  assert.equal(page.sourceHash, contentHash(repeated));
});

test("build preparation covers every creatable class and operation across stable and ephemeral identities", () => {
  for (const identityKind of ["forge_attribute", "studio_ephemeral"] as const) {
    for (const { name: className } of STUDIO_CAPABILITY_MANIFEST.classes.filter(
      (classDefinition) => classDefinition.creatable,
    )) {
      const identity = (name: string): StudioObjectIdentity =>
        identityKind === "forge_attribute"
          ? { kind: identityKind, stableId: name }
          : { kind: identityKind, connectorEpoch: "matrix-epoch", opaqueHash: contentHash(name) };
      const existing = ["Update", "Move", "Delete", "Source"].map((name) => ({
        objectId: studioObjectIdentityKey(identity(name)),
        identity: identity(name),
        path: `Workspace/${name}`,
        name,
        className: name === "Source" ? "Script" : className,
        parentIdentity: observation.instances[0]!.identity,
        properties: {},
        attributes: {},
        tags: [],
      }));
      const source = "print('existing')\n";
      const scriptRows = existing
        .filter((item) => ["Script", "LocalScript", "ModuleScript"].includes(item.className))
        .map((item) => ({
          documentId: item.objectId,
          path: item.path,
          className: item.className as "Script" | "LocalScript" | "ModuleScript",
          executionContext: "server" as const,
          sourceHash: contentHash(source),
          utf8Bytes: Buffer.byteLength(source),
        }));
      const index: CreatorProjectIndexView = {
        ...observation,
        instances: [...observation.instances, ...existing],
        scripts: scriptRows,
      };
      const sources = sourceEvidence(
        index,
        projectCaptureHash,
        scriptRows.map((item) => ({ ...item, source })),
      );
      const ownership = createStudioOwnershipMap({
        projectId: "matrix",
        revisionHash,
        projectIndex: index,
      });
      const prompt = "Create, update, move, delete and edit source.";
      const session = createCreatorSession({
        prompt,
        projectId: ownership.projectId,
        revisionHash,
        projectCaptureHash,
        ownership,
      });
      const target = (name: string) => {
        const item = existing.find((item) => item.name === name)!;
        return {
          kind: "instance" as const,
          identity: item.identity,
          path: item.path,
          className: item.className,
        };
      };
      const parent = {
        kind: "engine_container" as const,
        path: "Workspace",
        className: "Workspace" as const,
      };
      const changes = [
        {
          id: "create",
          kind: "create",
          path: "Workspace/Created",
          className,
          parent,
          initialization: ["Script", "LocalScript", "ModuleScript"].includes(className)
            ? "inline_source_required"
            : "initial_properties",
        },
        { id: "update", kind: "update", target: target("Update"), expectedClass: className },
        {
          id: "move",
          kind: "move",
          target: target("Move"),
          expectedClass: className,
          parent,
          toPath: "Workspace/Moved",
        },
        { id: "delete", kind: "delete", target: target("Delete"), expectedClass: className },
        { id: "source", kind: "edit_source", target: target("Source"), expectedClass: "Script" },
      ] as CreatorPlanChange[];
      const plan = createTestPlan(
        {
          sessionId: session.id,
          promptHash: session.promptHash,
          projectRevisionHash: revisionHash,
          projectCaptureHash,
          ownershipMapId: ownership.id,
          ownershipMapHash: ownership.hash,
          creatorPrompt: prompt,
          inspectionPaths: [],
          changes,
          steps: [{ id: "work", statement: prompt, changeIds: changes.map((change) => change.id) }],
          ...planSourceBinding(sources),
          charter: {
            clauses: [
              {
                id: "created",
                kind: "studio_check",
                check: "instance_exists",
                path: "Workspace/Created",
                expectedClass: className as (typeof STUDIO_RESOLVABLE_CLASSES)[number],
              },
              {
                id: "moved",
                kind: "studio_check",
                check: "instance_exists",
                path: "Workspace/Moved",
                expectedClass: className as (typeof STUDIO_RESOLVABLE_CLASSES)[number],
              },
              { id: "syntax", kind: "local_check", check: "luau_syntax" },
              {
                id: "diagnostics",
                kind: "studio_check",
                check: "playtest_diagnostics",
                maximumErrors: 0,
                maximumWarnings: 0,
              },
            ],
          },
        },
        index,
        ownership,
      );
      const prepared = prepareCreatorBuildPlan(plan, index);
      assert.deepEqual(
        prepared.changes.map((change) => change.kind),
        ["create", "delete", "move", "edit_source", "update"],
      );
      const approval = createCreatorApproval({
        sessionId: session.id,
        artifactKind: "plan",
        artifactId: plan.id,
        artifactHash: plan.hash,
        decision: "approved",
        decidedAt: "2026-09-04T00:00:00.000Z",
      });
      const contract = createCreatorBuildContract({
        session,
        plan,
        planApproval: approval,
        ownership,
        projectIndex: index,
      });
      assertCreatorBuildContract(contract);
      assert.deepEqual(contract.changes, prepared.changes, `${identityKind}/${className}`);
    }
  }
});

test("a built draft can be refined before application, but an applying change cannot", () => {
  const ownership = createStudioOwnershipMap({
    projectId: "draft-review",
    revisionHash,
    projectIndex: observation,
  });
  let session = createCreatorSession({
    prompt: "Create a folder.",
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  for (const status of [
    "planning",
    "awaiting_plan_approval",
    "building",
    "awaiting_change_approval",
  ] as const)
    session = advanceSession(session, { status });
  const refined = advanceSession(session, { status: "refining_plan" });
  const superseded = advanceSession(refined, { status: "superseded" });
  assert.equal(superseded.status, "superseded");
  assert.throws(() => advanceSession(superseded, { status: "preflighting" }), /transition/i);
  const applying = advanceSession(advanceSession(session, { status: "preflighting" }), {
    status: "applying",
  });
  assert.throws(() => advanceSession(applying, { status: "refining_plan" }), /transition/i);
});

test("engine settings without detached preflight remain parent containers but are not writable", () => {
  const updateOnly = STUDIO_CAPABILITY_MANIFEST.classes
    .filter((classDefinition) => !classDefinition.creatable)
    .map((classDefinition) => classDefinition.name);
  assert.deepEqual(updateOnly, []);
  const engineClasses = [
    "Lighting",
    "MaterialService",
    "SoundService",
    "StarterGui",
    "StarterPlayer",
    "Terrain",
    "TextChatService",
    "Workspace",
  ];
  for (const className of engineClasses)
    assert.equal(
      STUDIO_CAPABILITY_MANIFEST.classes.some((entry) => entry.name === className),
      false,
    );
  for (const className of engineClasses.filter((name) => name !== "Terrain"))
    assert.ok(
      STUDIO_CAPABILITY_MANIFEST.authoringContainers.some((entry) => entry.className === className),
    );
  const ownership = createStudioOwnershipMap({
    projectId: "engine-settings",
    revisionHash,
    projectIndex: observation,
  });
  const session = createCreatorSession({
    prompt: "Adjust the lighting.",
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const orientation = creatorOrientation({ session, ownership, projectIndex: observation });
  assert.equal(orientation.content.mode, "creator_session");
  if (orientation.content.mode !== "creator_session") return;
  const allowed = new Set(orientation.content.studioAuthoring.allowedClasses);
  for (const className of engineClasses) assert.equal(allowed.has(className), false, className);
});

test("compact planning uses inspected handles, rejects stale authority and generates structural checks", async () => {
  const source = "print('existing')\n";
  const script = {
    objectId: "forge_attribute:script",
    identity: { kind: "forge_attribute" as const, stableId: "script" },
    path: "Workspace/Script",
    name: "Script",
    className: "Script",
    parentIdentity: observation.instances[0]!.identity,
    properties: {},
    attributes: {},
    tags: [],
  };
  const index: CreatorProjectIndexView = {
    ...observation,
    instances: [...observation.instances, script],
    scripts: [
      {
        documentId: script.objectId,
        path: script.path,
        className: "Script",
        executionContext: "server",
        sourceHash: contentHash(source),
        utf8Bytes: Buffer.byteLength(source),
      },
    ],
  };
  const sources = sourceEvidence(index, projectCaptureHash, [{ ...index.scripts[0]!, source }]);
  const ownership = createStudioOwnershipMap({
    projectId: "compact",
    revisionHash,
    projectIndex: index,
  });
  const prompt = "Update the script.";
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const host = new CreatorPlannerToolHost({
    catalog: plannerCatalog,
    session,
    ownership,
    projectIndex: index,
    prompt,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
  });
  const proposal = {
    inspectionObjectIds: [script.objectId],
    design: sourceDesign(
      {
        operationId: "edit",
        kind: "edit_source",
        target: {
          kind: "instance",
          identity: script.identity,
          path: script.path,
          className: script.className,
        },
        beforeSourceHash: contentHash(source),
        beforeSourceBytes: Buffer.byteLength(source),
      },
      prompt,
    ),
    checks: [{ check: "playtest_diagnostics", maximumErrors: 0, maximumWarnings: 0 }],
  };
  assert.equal((await submitDesign(host, proposal)).ok, false);
  await host.execute("project.search", { queries: [{ query: "Script" }] });
  assert.equal(
    (await submitDesign(host, proposal)).ok,
    false,
    "Search alone does not satisfy inspection",
  );
  await host.execute("project.inspect", { objectIds: [script.objectId] });
  const unconsulted = await submitDesign(host, proposal);
  assert.equal(unconsulted.error?.code, "SOURCE_CONSULTATION_INCOMPLETE");
  await host.execute("source.read", { documentId: script.objectId });
  assert.equal(
    (await submitDesign(host, proposal)).error?.code,
    "SOURCE_CONSULTATION_INCOMPLETE",
    "Reading source must still include its dependency closure",
  );
  await host.execute("source.dependencies", { documentId: script.objectId, direction: "closure" });
  const unknown = await submitDesign(host, {
    ...proposal,
    design: sourceDesign(
      {
        operationId: "edit",
        kind: "edit_source",
        target: {
          kind: "instance",
          identity: { kind: "forge_attribute", stableId: "stale-id" },
          path: script.path,
          className: script.className,
        },
        beforeSourceHash: contentHash(source),
        beforeSourceBytes: Buffer.byteLength(source),
      },
      prompt,
    ),
  });
  assert.equal(unknown.ok, false);
  const result = await submitDesign(host, proposal);
  assert.equal(result.ok, true, JSON.stringify(result));
  const outcome = host.getOutcome();
  assert.equal(outcome?.kind, "plan_proposed");
  if (outcome?.kind !== "plan_proposed") return;
  assert.deepEqual(outcome.plan.inspectionPaths, [script.path]);
  assert.ok(
    outcome.plan.charter.clauses.some(
      (clause) => clause.kind === "local_check" && clause.check === "luau_syntax",
    ),
  );
  assert.ok(
    outcome.plan.charter.clauses.some(
      (clause) =>
        clause.kind === "studio_check" &&
        clause.check === "instance_exists" &&
        clause.path === script.path,
    ),
  );
  assert.equal(prepareCreatorBuildPlan(outcome.plan, index).changes.length, 1);
  const builder = new CreatorBuilderToolHost({
    session,
    ownership,
    projectIndex: index,
    plan: outcome.plan,
    planApproval: createCreatorApproval({
      sessionId: session.id,
      artifactKind: "plan",
      artifactId: outcome.plan.id,
      artifactHash: outcome.plan.hash,
      decision: "approved",
      decidedAt: new Date().toISOString(),
    }),
    ...sources,
    sourceConsultation: host.getSourceConsultation(),
  });
  const draftDefinition = builder.definitions().find((tool) => tool.name === "studio.read_drafts")!;
  assert.deepEqual(
    schemaAt(draftDefinition.schema, [
      "properties",
      "drafts",
      "items",
      "properties",
      "planChangeId",
    ]).enum,
    ["edit"],
  );
  assert.equal(
    builder.definitions().some((tool) => tool.name === "studio.inspect"),
    false,
  );
  assert.equal(
    (await builder.execute("studio.read_drafts", { drafts: [{ planChangeId: "panel" }] })).error
      ?.code,
    "TOOL_ARGUMENTS_INVALID",
    "Non-script handles are excluded from the model-facing draft interface",
  );
  const sourceShapeError = await builder.execute("studio.build", {
    changes: [{ planChangeId: "edit", source: "print('new')\n" }],
    summary: "Updated the script.",
  });
  assert.equal(sourceShapeError.error?.code, "TOOL_ARGUMENTS_INVALID");
  const buildRequired = (
    builder.definitions().find((tool) => tool.name === "studio.build")!.schema as {
      required: string[];
    }
  ).required;
  assert.ok(buildRequired.includes("sources"));
  assert.ok(!buildRequired.includes("values"), "No empty collection is required for zero slots");
  assert.equal(
    (await builder.execute("studio.build", { summary: "Missing the required source." })).error
      ?.code,
    "TOOL_ARGUMENTS_INVALID",
  );
  const stagedSource = "print('new')\n";
  assert.equal(
    (
      await builder.execute("studio.build", {
        sources: [{ slotId: "edit", source: stagedSource }],
        summary: "Updated the script.",
      })
    ).ok,
    true,
  );
  const patched = await builder.execute("studio.repair", {
    repairs: [
      {
        kind: "source",
        planChangeId: "edit",
        expectedSourceHash: contentHash(stagedSource),
        edits: [{ startLine: 1, deleteCount: 1, replacement: "print('repaired')\n" }],
      },
    ],
    summary: "Repaired the script.",
  });
  assert.equal(patched.ok, true, JSON.stringify(patched.error));
  const repairedOperation = builder.stagedOperations()[0];
  assert.equal(repairedOperation?.kind, "edit_source");
  assert.equal(
    repairedOperation?.kind === "edit_source" ? repairedOperation.finalSourceHash : "",
    contentHash("print('repaired')\n"),
  );
});

test("common UI and asset properties use the complete creator codec pipeline", () => {
  const examples = [
    { className: "UICorner", propertyName: "CornerRadius", value: { scale: 0, offset: 12 } },
    { className: "UIPadding", propertyName: "PaddingLeft", value: { scale: 0, offset: 16 } },
    { className: "UIListLayout", propertyName: "SortOrder", value: "LayoutOrder" },
    { className: "UIStroke", propertyName: "Thickness", value: 2 },
    { className: "TextBox", propertyName: "PlaceholderText", value: "Message" },
    { className: "ImageLabel", propertyName: "Image", value: "" },
    { className: "ImageLabel", propertyName: "ImageContent", value: "rbxassetid://12345" },
    { className: "Sound", propertyName: "SoundId", value: "" },
    {
      className: "ParticleEmitter",
      propertyName: "Texture",
      value: "rbxasset://textures/particles/sparkles_main.dds",
    },
  ] as const;
  for (const example of examples) assert.ok(canonicalizeCreatorPropertyInput(example));
});

function captureHashFor(revision: string): string {
  return contentHash(`complete project-index capture:${revision}`);
}
const projectCaptureHash = captureHashFor(revisionHash);
const observation: CreatorProjectIndexView = {
  project: { name: "EvidenceFirst", placeId: 0, universeId: 0 },
  revision: { hash: revisionHash } as CreatorProjectIndexView["revision"],
  instances: [
    {
      objectId: "forge_attribute:workspace",
      identity: { kind: "forge_attribute", stableId: "workspace" },
      path: "Workspace",
      name: "Workspace",
      engineContainer: { path: "Workspace", className: "Workspace" },
      className: "Workspace",
      properties: {},
      attributes: {},
      tags: [],
    },
  ],
  scripts: [],
};

function projectIndexBinding(revision: string, captureHash = projectCaptureHash) {
  const artifactHash = "a".repeat(64);
  const artifact = {
    locator: `artifacts/${artifactHash}.json`,
    artifactHash,
    bytes: 1,
  };
  return {
    captureId: "project-index-capture",
    captureHash,
    detectorEpoch: 0,
    projection: {
      id: "project-index-projection",
      hash: "c".repeat(64),
      artifact,
    },
    manifest: { id: "project-index-manifest", hash: "d".repeat(64), artifact },
    revision: { id: "project-index-revision", hash: revision, artifact },
    shards: [],
    sourceManifests: [],
    sourceChunks: [],
  };
}

/** Fixture-only source authority; production resolves separately persisted blobs. */
function sourceEvidence(
  projectIndex: CreatorProjectIndexView,
  projectCaptureHash: string,
  sourceDocuments: readonly SourceDocumentInput[] = [],
) {
  const metadataById = new Map(
    projectIndex.scripts.map((document) => [document.documentId, document] as const),
  );
  if (
    metadataById.size !== sourceDocuments.length ||
    sourceDocuments.some((document) => {
      const metadata = metadataById.get(document.documentId);
      return (
        !metadata ||
        metadata.path !== document.path ||
        metadata.className !== document.className ||
        metadata.executionContext !== document.executionContext ||
        metadata.sourceHash !== document.sourceHash ||
        metadata.utf8Bytes !== Buffer.byteLength(document.source, "utf8")
      );
    })
  )
    throw new Error("Test source bodies must exactly match the metadata-only project index");
  const sourceIndex = createPinnedLuauLspSourceIndex(
    { snapshotHash: projectCaptureHash, documents: sourceDocuments },
    { symbols: [], references: [] },
    {
      analysisConfigHash: contentHash("creator-session-test-analysis-config"),
      pinnedToolchainProof: {
        hash: contentHash("creator-session-test-toolchain-proof"),
        lockHash: contentHash("creator-session-test-toolchain-lock"),
        platform: "test",
      },
      sourcemapHash: contentHash("creator-session-test-sourcemap"),
    },
    { maximumStaticDependencyRows: 1_024 },
  );
  const sourceResolver = createTestFixtureSourceResolver(sourceDocuments);
  const recorder = new SourceConsultationRecorder(sourceIndex, sourceResolver);
  for (const document of sourceIndex.documents) {
    recorder.read({ documentId: document.documentId });
    recorder.dependenciesPage({
      documentId: document.documentId,
      direction: "closure",
    });
  }
  return {
    sourceIndex,
    sourceResolver,
    sourceConsultation: recorder.seal(),
  };
}

function planSourceBinding(sources: ReturnType<typeof sourceEvidence>) {
  return {
    sourceIndex: sources.sourceIndex,
    sourceConsultation: sources.sourceConsultation,
  };
}

function rehashedChangeSet(payload: Record<string, unknown>): unknown {
  const hash = contentHash(stableJson(payload));
  return {
    kind: "CreatorChangeSet",
    id: `creator_change_set_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

test("persisted change sets reject every unsupported direct operation target", () => {
  const target = {
    kind: "instance",
    identity: { kind: "forge_attribute", stableId: "unsupported-direct-target" },
    path: "Workspace/UnsupportedDirectTarget",
    className: "Camera",
  };
  const sourceBlob = {
    manifestId: "creator_source_manifest_unsupported_target",
    manifestHash: "a".repeat(64),
    sourceHash: "b".repeat(64),
    utf8Bytes: 1,
  };
  const shared = {
    sessionId: "creator_schema_replay_session",
    attempt: 1,
    promptHash: "c".repeat(64),
    planId: "creator_plan_schema_replay",
    planHash: "d".repeat(64),
    charterId: "verification_charter_schema_replay",
    charterHash: "e".repeat(64),
    planApprovalId: "creator_approval_schema_replay",
    planApprovalHash: "f".repeat(64),
    buildContractId: "creator_build_contract_schema_replay",
    buildContractHash: "0".repeat(64),
    ownershipMapId: "studio_ownership_schema_replay",
    ownershipMapHash: "1".repeat(64),
    mutationAuthority: "studio_document",
    expectedRevisionHash: "2".repeat(64),
    localGate: { status: "eligible", issueHashes: [] },
  };
  const operations = [
    {
      id: "unsupported-create",
      planChangeId: "plan-unsupported-create",
      kind: "create",
      tempId: "temp-unsupported-create",
      target,
      parent: {
        kind: "engine_container",
        path: "Workspace",
        className: "Workspace",
      },
      className: "Folder",
      name: "UnsupportedDirectTarget",
      properties: {},
      attributes: {},
    },
    {
      id: "unsupported-update",
      planChangeId: "plan-unsupported-update",
      kind: "update",
      target,
      beforeHash: "3".repeat(64),
      properties: {},
      attributes: {},
      removedAttributes: [],
    },
    {
      id: "unsupported-move",
      planChangeId: "plan-unsupported-move",
      kind: "move",
      target,
      beforeHash: "4".repeat(64),
      parent: {
        kind: "engine_container",
        path: "Workspace",
        className: "Workspace",
      },
      name: "UnsupportedDirectTargetMoved",
      properties: {},
      attributes: {},
      removedAttributes: [],
    },
    {
      id: "unsupported-delete",
      planChangeId: "plan-unsupported-delete",
      kind: "delete",
      target,
      beforeHash: "5".repeat(64),
    },
    {
      id: "unsupported-edit-source",
      planChangeId: "plan-unsupported-edit-source",
      kind: "edit_source",
      target,
      beforeSourceHash: "6".repeat(64),
      edits: [{ startByte: 0, endByte: 0, replacementBlob: sourceBlob }],
      finalSourceHash: "7".repeat(64),
      finalByteCount: 1,
    },
  ];
  for (const operation of operations) {
    assert.throws(() =>
      assertCreatorChangeSet(
        rehashedChangeSet({
          ...shared,
          operations: [operation],
          sourceWriteBlobs: operation.kind === "edit_source" ? [sourceBlob] : [],
        }),
      ),
    );
  }
});

test("persisted change sets reject Studio-invalid create and move names", () => {
  const target = {
    kind: "instance",
    identity: { kind: "forge_attribute", stableId: "valid-name-target" },
    path: "Workspace/ValidNameTarget",
    className: "Folder",
  };
  const shared = {
    sessionId: "creator_name_schema_replay_session",
    attempt: 1,
    promptHash: "a".repeat(64),
    planId: "creator_plan_name_schema_replay",
    planHash: "b".repeat(64),
    charterId: "verification_charter_name_schema_replay",
    charterHash: "c".repeat(64),
    planApprovalId: "creator_approval_name_schema_replay",
    planApprovalHash: "d".repeat(64),
    buildContractId: "creator_build_contract_name_schema_replay",
    buildContractHash: "e".repeat(64),
    ownershipMapId: "studio_ownership_name_schema_replay",
    ownershipMapHash: "f".repeat(64),
    mutationAuthority: "studio_document",
    expectedRevisionHash: "0".repeat(64),
    sourceWriteBlobs: [],
    localGate: { status: "eligible", issueHashes: [] },
  };
  const parent = {
    kind: "engine_container",
    path: "Workspace",
    className: "Workspace",
  };
  for (const name of ["Bad/Name", ".", "..", "🚀".repeat(26)]) {
    for (const operation of [
      {
        id: `invalid-create-${name.length}`,
        planChangeId: `plan-invalid-create-${name.length}`,
        kind: "create",
        tempId: `temp-invalid-create-${name.length}`,
        target,
        parent,
        className: "Folder",
        name,
        properties: {},
        attributes: {},
      },
      {
        id: `invalid-move-${name.length}`,
        planChangeId: `plan-invalid-move-${name.length}`,
        kind: "move",
        target,
        beforeHash: "1".repeat(64),
        parent,
        name,
        properties: {},
        attributes: {},
        removedAttributes: [],
      },
    ]) {
      assert.throws(() =>
        assertCreatorChangeSet(
          rehashedChangeSet({
            ...shared,
            operations: [operation],
          }),
        ),
      );
    }
  }
});

test("project-authority adapter selects exactly one writer per change set", () => {
  const manifest: ProjectAuthorityManifest = {
    kind: "ProjectAuthorityManifest",
    studioRoots: ["Workspace"],
    rojo: { projectFile: "default.project.json", sourceRoots: ["src"] },
  };
  const source = "return { Enabled = true }\n";
  const projectIndex: CreatorProjectIndexView = {
    ...observation,
    instances: [
      ...observation.instances,
      {
        objectId: "forge_attribute:studio-door",
        identity: { kind: "forge_attribute", stableId: "studio-door" },
        path: "Workspace/StudioDoor",
        name: "StudioDoor",
        parentIdentity: { kind: "forge_attribute", stableId: "workspace" },
        className: "Part",
        properties: {},
        attributes: {},
        tags: [],
      },
      {
        objectId: "forge_attribute:rojo-system",
        identity: { kind: "forge_attribute", stableId: "rojo-system" },
        path: "Workspace/RojoSystem",
        name: "RojoSystem",
        parentIdentity: { kind: "forge_attribute", stableId: "workspace" },
        className: "Folder",
        properties: {},
        attributes: {},
        tags: [],
      },
      {
        objectId: "forge_attribute:rojo-script",
        identity: { kind: "forge_attribute", stableId: "rojo-script" },
        path: "Workspace/RojoSystem/Controller",
        name: "Controller",
        parentIdentity: { kind: "forge_attribute", stableId: "rojo-system" },
        className: "ModuleScript",
        properties: {},
        attributes: {},
        tags: [],
      },
    ],
    scripts: [
      {
        documentId: "forge_attribute:rojo-script",
        path: "Workspace/RojoSystem/Controller",
        className: "ModuleScript",
        executionContext: "shared",
        sourceHash: contentHash(source),
        utf8Bytes: Buffer.byteLength(source, "utf8"),
      },
    ],
  };
  const ownership = createStudioOwnershipMap({
    projectId: "project-rojo-authority",
    revisionHash,
    projectIndex,
    projectAuthority: manifest,
    rojoOwnedPaths: ["Workspace/RojoSystem", "Workspace/RojoSystem/Controller"],
  });
  assert.deepEqual(ownership.availableAuthorities, ["rojo_source", "studio_document"]);
  assert.equal(ownership.authorityManifestHash, contentHash(stableJson(manifest)));
  assert.deepEqual(
    ownership.entries.map((entry) => [entry.path, entry.owner]),
    [
      ["Workspace", "studio_document"],
      ["Workspace/RojoSystem", "rojo_source"],
      ["Workspace/RojoSystem/Controller", "rojo_source"],
      ["Workspace/StudioDoor", "studio_document"],
    ],
  );
  const {
    kind: _ownershipKind,
    id: _ownershipId,
    hash: _ownershipHash,
    ...ownershipPayload
  } = ownership;
  const legacyPayload = {
    ...ownershipPayload,
    entries: ownership.entries.map((entry) => ({
      ...entry,
      writable: entry.owner === "studio_document",
    })),
  };
  const legacyHash = contentHash(stableJson(legacyPayload));
  assert.throws(
    () =>
      assertOwnershipMap({
        kind: "StudioOwnershipMap",
        id: `studio_ownership_map_${legacyHash.slice(0, 24)}`,
        hash: legacyHash,
        ...legacyPayload,
      }),
    /Invalid StudioOwnershipMap/,
    "the removed writer-derived boolean must not remain a compatible persisted shape",
  );
  for (const invalidOwnershipPayload of [
    {
      ...ownershipPayload,
      availableAuthorities: ["rojo_source", "studio_document", "studio_document"],
    },
    {
      ...ownershipPayload,
      availableAuthorities: ["studio_document", "rojo_source"],
    },
    {
      ...ownershipPayload,
      entries: [...ownership.entries].reverse(),
    },
    {
      ...ownershipPayload,
      entries: [...ownership.entries, ownership.entries[0]],
    },
  ]) {
    const invalidHash = contentHash(stableJson(invalidOwnershipPayload));
    assert.throws(
      () =>
        assertOwnershipMap({
          kind: "StudioOwnershipMap",
          id: `studio_ownership_map_${invalidHash.slice(0, 24)}`,
          hash: invalidHash,
          ...invalidOwnershipPayload,
        }),
      /Invalid StudioOwnershipMap/,
      "ownership maps accept exactly one canonical authority sequence and unique sorted entries",
    );
  }
  assert.throws(
    () =>
      createStudioOwnershipMap({
        projectId: "project-unmapped-rojo-authority",
        revisionHash,
        projectIndex,
        projectAuthority: manifest,
        rojoOwnedPaths: ["Workspace/Missing"],
      }),
    /is absent from the current project index/,
  );
  assert.throws(
    () =>
      createStudioOwnershipMap({
        projectId: "project-missing-rojo-authority",
        revisionHash,
        projectIndex,
        projectAuthority: manifest,
      }),
    /exact host-verified Studio path mappings/,
  );

  const session = createCreatorSession({
    prompt: "Update one Studio part or one mapped source file.",
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const orientation = creatorOrientation({ session, ownership, projectIndex });
  assert.equal(orientation.content.mode, "creator_session");
  if (orientation.content.mode !== "creator_session")
    throw new Error("Expected creator orientation");
  assert.equal(orientation.content.writerSelection, "per_change_set");
  assert.deepEqual(orientation.content.availableAuthorities, ["rojo_source", "studio_document"]);
  assert.equal(orientation.content.studioAuthoring.available, true);
  assert.equal(orientation.content.overview.instanceCount, projectIndex.instances.length);
  assert.equal(orientation.content.overview.scriptCount, projectIndex.scripts.length);
  assert.equal(
    orientation.content.exploration.projectFacts,
    "use_supplied_revision_facts_retrieve_missing_through_offered_tools",
  );
  assert.equal(orientation.content.exploration.availableTools, "current_phase_tool_schema");
  assert.equal(orientation.content.studioAuthoring.scope, "edit_mode_transactions_only");
  assert.equal(
    orientation.content.gameRuntime.runtimeInstanceCreation,
    "transient_or_explicit_runtime_generated_world_only",
  );
  assert.equal(orientation.content.gameRuntime.grantsEditorMutationAuthority, false);

  const sources = sourceEvidence(projectIndex, projectCaptureHash, [
    {
      documentId: "forge_attribute:rojo-script",
      path: "Workspace/RojoSystem/Controller",
      className: "ModuleScript",
      executionContext: "shared",
      sourceHash: contentHash(source),
      source,
    },
  ]);
  const planInput = (
    changes: CreatorPlanChange[],
    clauses: VerificationCharterProposalClause[],
  ) => ({
    sessionId: session.id,
    promptHash: session.promptHash,
    projectRevisionHash: revisionHash,
    projectCaptureHash,
    ownershipMapId: ownership.id,
    ownershipMapHash: ownership.hash,
    creatorPrompt: "Update one Studio part or one mapped source file.",
    inspectionPaths: ["Workspace/StudioDoor"],
    steps: [
      {
        id: "change",
        statement: "Apply the bounded change.",
        changeIds: changes.map((change) => change.id),
      },
    ],
    changes,
    charter: { clauses },
    ...planSourceBinding(sources),
  });
  const commonClauses: VerificationCharterProposalClause[] = [
    {
      id: "door-exists",
      kind: "studio_check" as const,
      check: "instance_exists" as const,
      path: "Workspace/StudioDoor",
      expectedClass: "Part" as const,
    },
    {
      id: "diagnostics",
      kind: "studio_check" as const,
      check: "playtest_diagnostics" as const,
      maximumErrors: 0,
      maximumWarnings: 0,
    },
  ];
  const studioPlan = createTestPlan(
    planInput(
      [
        {
          id: "update-door",
          kind: "update" as const,
          target: {
            kind: "instance" as const,
            identity: {
              kind: "forge_attribute" as const,
              stableId: "studio-door",
            },
            path: "Workspace/StudioDoor",
            className: "Part" as const,
          },
          expectedClass: "Part" as const,
        },
      ],
      commonClauses,
    ),
    projectIndex,
    ownership,
  );
  assert.equal(studioPlan.mutationAuthority, "studio_document");

  const rojoChange = {
    id: "edit-controller",
    kind: "edit_source" as const,
    target: {
      kind: "instance" as const,
      identity: { kind: "forge_attribute" as const, stableId: "rojo-script" },
      path: "Workspace/RojoSystem/Controller",
      className: "ModuleScript" as const,
    },
    expectedClass: "ModuleScript" as const,
  };
  const rojoPlan = createTestPlan(
    planInput(
      [rojoChange],
      [
        {
          id: "syntax",
          kind: "local_check" as const,
          check: "luau_syntax" as const,
        },
        ...commonClauses,
      ],
    ),
    projectIndex,
    ownership,
  );
  assert.equal(rojoPlan.mutationAuthority, "rojo_source");
  assert.throws(
    () =>
      createTestPlan(
        planInput(
          [
            rojoChange,
            {
              id: "update-door",
              kind: "update" as const,
              target: {
                kind: "instance" as const,
                identity: {
                  kind: "forge_attribute" as const,
                  stableId: "studio-door",
                },
                path: "Workspace/StudioDoor",
                className: "Part" as const,
              },
              expectedClass: "Part" as const,
            },
          ],
          [
            {
              id: "syntax",
              kind: "local_check" as const,
              check: "luau_syntax" as const,
            },
            ...commonClauses,
          ],
        ),
        projectIndex,
        ownership,
      ),
    /Mixed creator-plan authority is rejected before approval/,
  );
});

test("technical Play incompleteness exposes only exact retry and cancellation authority", () => {
  const agentExecutions = [
    {
      purpose: "repair" as const,
      ordinal: 1,
      agentRunId: "agent_run_retry_play_verification",
      journalId: "agent_execution_journal:agent_run_retry_play_verification",
    },
  ];
  const view = createCreatorTransactionControlView({
    creatorSessionId: "creator_session_retry",
    creatorSessionHash: "a".repeat(64),
    status: "awaiting_verification_retry",
    title: "Play Evidence Incomplete",
    detail: "The completed Play interval has read errors.",
    actions: [
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
    ],
    verification: {
      id: "creator_verification_retry",
      status: "incomplete",
      replayable: false,
      failureFacts: [],
      runtimeSummary: {
        startedAt: "2026-09-01T00:00:00.000Z",
        endedAt: "2026-09-01T00:00:01.000Z",
        observedFacts: 0,
        absentFacts: 0,
        unavailableFacts: 0,
        readErrorFacts: 1,
        diagnosticCount: 0,
        issues: [
          {
            key: "runtime_resolution:door",
            status: "read_error",
            code: "engine_read_failed",
          },
        ],
      },
    },
  });
  assert.equal(view.kind, "CreatorTransactionControlView");
  assert.deepEqual(
    view.actions.map((action) => action.id),
    ["transaction_retry_play_verification", "transaction_cancel_changes"],
  );
  assert.doesNotThrow(() =>
    assertCreatorTransactionControlActionBinding(view, {
      creatorSessionId: view.creatorSessionId,
      viewId: view.id,
      viewHash: view.hash,
      actionId: "transaction_retry_play_verification",
    }),
  );
  assert.throws(
    () =>
      assertCreatorTransactionControlActionBinding(view, {
        creatorSessionId: view.creatorSessionId,
        viewId: view.id,
        viewHash: "b".repeat(64),
        actionId: "transaction_retry_play_verification",
      }),
    /stale or bound to a different/,
  );
  assert.deepEqual(
    assertCreatorTransactionControlAction({
      action: "act",
      sessionId: view.creatorSessionId,
      viewId: view.id,
      viewHash: view.hash,
      actionId: "transaction_retry_play_verification",
      agentExecutions,
    }),
    {
      action: "act",
      sessionId: view.creatorSessionId,
      viewId: view.id,
      viewHash: view.hash,
      actionId: "transaction_retry_play_verification",
      agentExecutions,
    },
  );
});

test("creator start keeps exact creator authority separate from host-authored model context", () => {
  const execution = {
    purpose: "planner" as const,
    ordinal: 1,
    agentRunId: "agent_run_creator_authority_split",
    journalId: "agent_execution_journal:agent_run_creator_authority_split",
  };
  const creatorText = "Change the door safely.";
  const agentPrompt = `Host-authored conversation context.\n\nExact creator request: ${creatorText}`;
  assert.deepEqual(
    assertCreatorTransactionControlAction({
      action: "start",
      creatorText,
      agentPrompt,
      model: "openai/gpt-5.6-luna",
      creatorSessionId: "creator_session_authority-split",
      contextCitations: [],
      agentExecutions: [execution],
    }),
    {
      action: "start",
      creatorText,
      agentPrompt,
      model: "openai/gpt-5.6-luna",
      creatorSessionId: "creator_session_authority-split",
      contextCitations: [],
      agentExecutions: [execution],
    },
  );
  assert.throws(
    () =>
      assertCreatorTransactionControlAction({
        action: "start",
        prompt: agentPrompt,
        model: "openai/gpt-5.6-luna",
        creatorSessionId: "creator_session_authority-split",
        contextCitations: [],
        agentExecutions: [execution],
      }),
    /Invalid creator transaction control action/,
  );
});

test("resume-build control actions survive transport validation without provider authority", () => {
  const action = {
    action: "act" as const,
    sessionId: "creator_session_resume-build",
    viewId: "creator_view_resume-build",
    viewHash: "a".repeat(64),
    actionId: "transaction_resume_build" as const,
    agentExecutions: [],
  };
  assert.deepEqual(assertCreatorTransactionControlAction(action), action);
});

test("pasted requests normalize whitespace and retain the dashboard's full byte limit", () => {
  const start = {
    action: "start",
    agentPrompt: "Host context",
    model: "openai/gpt-5.6-luna",
    creatorSessionId: "creator_session_pasted-request",
    contextCitations: [],
    agentExecutions: [
      {
        purpose: "planner",
        ordinal: 1,
        agentRunId: "agent_run_pasted_request",
        journalId: "agent_execution_journal:agent_run_pasted_request",
      },
    ],
  };
  for (const text of ["\n  Make the airlock.\n", "é".repeat(32 * 1024)]) {
    const parsed = assertCreatorTransactionControlAction({ ...start, creatorText: text });
    assert.equal(parsed.action, "start");
    if (parsed.action !== "start") throw new Error("Expected start");
    assert.equal(parsed.creatorText, text.trim());
    assert.doesNotThrow(() =>
      assertCreatorRequestArtifact({
        kind: "CreatorRequest",
        sessionId: start.creatorSessionId,
        promptHash: contentHash(parsed.creatorText),
        creatorText: parsed.creatorText,
        agentPrompt: start.agentPrompt,
        contextCitations: [],
      }),
    );
  }
  for (const text of [" \n\t", "é".repeat(32 * 1024) + "x"])
    assert.throws(() => assertCreatorTransactionControlAction({ ...start, creatorText: text }));
});

test("creator planner exposes bounded pinned Roblox API context", async () => {
  const ownership = createStudioOwnershipMap({
    projectId: "project-api-lookup",
    revisionHash,
    projectIndex: observation,
  });
  const prompt = "Use a documented Roblox event in bounded source.";
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const sources = sourceEvidence(observation, projectCaptureHash);
  const staleSources = sourceEvidence(
    observation,
    contentHash("different complete project-index capture"),
  );
  assert.throws(
    () =>
      new CreatorPlannerToolHost({
        catalog: plannerCatalog,
        session,
        ownership,
        projectIndex: observation,
        sourceIndex: staleSources.sourceIndex,
        sourceResolver: staleSources.sourceResolver,
        prompt,
      }),
    /current project-index capture/,
  );
  const host = new CreatorPlannerToolHost({
    catalog: plannerCatalog,
    session,
    ownership,
    projectIndex: observation,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
    prompt,
  });
  assert.ok(host.definitions().some((entry) => entry.name === "studio.api_lookup"));
  assert.equal(
    Object.hasOwn(
      schemaAt(host.definitions().find((entry) => entry.name === "studio.api_lookup")!.schema, [
        "properties",
      ]),
      "memberKind",
    ),
    false,
  );
  for (const [ownerName, query, entryKind] of [
    ["RemoteEvent", "OnServerEvent", "class_event"],
    ["ProximityPrompt", "Triggered", "class_event"],
    ["Model", "GetPivot", "class_method"],
    ["Instance", "new", "datatype_constructor"],
    ["Vector3", "new", "datatype_constructor"],
    ["task", "wait", "library_function"],
  ] as const) {
    const metadata = await host.execute("studio.api_lookup", { ownerName, query });
    assert.equal(metadata.ok, true, `${ownerName}.${query}`);
    const entry = (metadata.value as { entries: Array<{ name: string; entryKind: string }> })
      .entries[0];
    assert.equal(entry?.name, query);
    assert.equal(entry?.entryKind, entryKind);
  }
  const oldKind = await host.execute("studio.api_lookup", {
    ownerName: "RemoteEvent",
    query: "OnServerEvent",
    memberKind: "method",
  });
  assert.equal(oldKind.ok, false, "The former public classification field is not accepted");
  const definitionsBeforeCatalog = host.definitions();
  const catalogResult = await host.execute("game.catalog", {});
  assert.equal(catalogResult.ok, true);
  const catalogValue = catalogResult.value as {
    configurationSchemasIncluded: boolean;
    definitions: Array<{ id: string; lock: { hash: string }; configSchema?: unknown }>;
  };
  assert.equal(catalogValue.configurationSchemasIncluded, false);
  const componentSchema = JSON.stringify(
    definitionsBeforeCatalog.find((entry) => entry.name === "creator.define_component")!.schema,
  );
  for (const definition of catalogValue.definitions) {
    assert.ok(componentSchema.includes(definition.lock.hash));
    assert.equal(
      definition.configSchema,
      undefined,
      "The compact catalog does not repeat configuration schemas",
    );
  }
  const selected = catalogValue.definitions[0]!;
  const detailResult = await host.execute("game.catalog", { definitionIds: [selected.id] });
  assert.equal(detailResult.ok, true);
  const detailValue = detailResult.value as typeof catalogValue;
  assert.equal(detailValue.configurationSchemasIncluded, true);
  assert.deepEqual(
    detailValue.definitions.map(({ id }) => id),
    [selected.id],
  );
  assert.equal(typeof detailValue.definitions[0]!.configSchema, "object");
  assert.strictEqual(
    host.definitions(),
    definitionsBeforeCatalog,
    "Catalog reads do not rebuild or change the run's schemas",
  );
  assert.match(
    host.definitions().find((entry) => entry.name === "creator.propose_plan")?.description ?? "",
    /GameDesignSpec/,
  );
  const result = await host.execute("studio.api_lookup", {
    ownerName: "ProximityPrompt",
    query: "Triggered",
    limit: 2,
  });
  assert.equal(result.ok, true);
  const value = result.value as {
    kind: string;
    entries: Array<{ name: string; disposition: string }>;
  };
  assert.equal(value.kind, "RobloxApiCatalogLookupResult");
  assert.equal(value.entries[0]?.name, "Triggered");
  assert.equal(value.entries[0]?.disposition, "source_only");

  const firstPage = await host.execute("studio.api_lookup", {
    ownerName: "Instance",
    limit: 1,
  });
  assert.equal(firstPage.ok, true);
  const page = firstPage.value as {
    nextCursor: string;
    entries: Array<{ catalogEntryId: string }>;
  };
  assert.ok(page.nextCursor);
  const nextPage = await host.execute("studio.api_lookup", {
    ownerName: "Instance",
    limit: 1,
    cursor: page.nextCursor,
  });
  assert.equal(nextPage.ok, true);
  assert.notEqual(
    (nextPage.value as typeof page).entries[0]?.catalogEntryId,
    page.entries[0]?.catalogEntryId,
  );
  const invalidCursor = await host.execute("studio.api_lookup", {
    ownerName: "Instance",
    limit: 1,
    cursor: "invalid-cursor",
  });
  assert.equal(invalidCursor.ok, false);
  if (!invalidCursor.ok) {
    assert(invalidCursor.error);
    assert.match(invalidCursor.error.message, /unchanged lookup filters and limit/);
    assert.doesNotMatch(invalidCursor.error.message, /memberKind/);
  }
  const superseded = await host.execute("studio.api_lookup", {
    className: "Instance",
    query: "new",
  });
  assert.equal(superseded.ok, false);

  const invalid = await host.execute("studio.api_lookup", {});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, "ROBLOX_API_LOOKUP_INVALID");
});

test("creator planning and Build materialize arbitrary reused assemblies from one exact accepted design", async () => {
  const ownership = createStudioOwnershipMap({
    projectId: "assembly-creator-workflow",
    revisionHash,
    projectIndex: observation,
  });
  const prompt = "Compose independently placed project objects with local interaction anchors.";
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const sources = sourceEvidence(observation, projectCaptureHash);
  const planner = new CreatorPlannerToolHost({
    catalog: plannerCatalog,
    session,
    ownership,
    projectIndex: observation,
    ...sources,
    prompt,
  });
  const empty = {
    properties: [],
    references: [],
    valueSlots: [],
    attributes: [],
    dependencies: [],
  };
  const config = {
    templates: [
      {
        id: "project-object",
        nodes: [
          {
            ...empty,
            id: "root",
            name: "Object",
            className: "Model",
            references: [{ propertyName: "PrimaryPart", target: { kind: "local", id: "anchor" } }],
          },
          {
            ...empty,
            id: "anchor",
            parentId: "root",
            name: "Anchor",
            className: "Part",
            properties: [
              { name: "Anchored", valueJson: stableJson({ kind: "boolean", value: true }) },
            ],
          },
          {
            ...empty,
            id: "prompt",
            parentId: "anchor",
            name: "Interaction",
            className: "ProximityPrompt",
          },
        ],
      },
    ],
    copies: Array.from({ length: 48 }, (_, index) => ({
      id: "copy-" + index,
      templateId: "project-object",
      name: "Object" + index,
      parent: { kind: "engine", id: "Workspace" },
      overrides: [],
    })),
    sharedReferences: [],
  };
  const proposed = await submitDesign(planner, {
    inspectionObjectIds: [],
    citationHandles: [],
    checks: [],
    design: {
      kind: "GameDesignSpec",
      worldAuthoring: { mode: "none" },
      id: "project-composition",
      intent: prompt,
      components: [
        {
          kind: "recipe_instance",
          id: "objects",
          definition: gameRecipeDefinitionLock(PROJECT_ASSEMBLY_DEFINITION),
          config,
        },
      ],
      connections: [],
      artifactDependencies: [],
    },
  });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const outcome = planner.getOutcome();
  assert.ok(outcome?.kind === "plan_proposed");
  assert.equal(outcome.plan.compiled.inventory.length, 144);
  const builder = new CreatorBuilderToolHost({
    session,
    ownership,
    projectIndex: observation,
    ...sources,
    plan: outcome.plan,
    sourceConsultation: planner.getSourceConsultation(),
    planApproval: createCreatorApproval({
      sessionId: session.id,
      artifactKind: "plan",
      artifactId: outcome.plan.id,
      artifactHash: outcome.plan.hash,
      decision: "approved",
      decidedAt: "2026-09-05T00:00:00.000Z",
    }),
  });
  assert.equal(builder.stagedOperations().length, 0);
  const built = await builder.execute("studio.build", {
    summary: "Composed the reviewed project objects.",
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(builder.completionStatus().ready, true);
  const graph = builder.sealedGraph();
  assert.equal(graph.operations.length, 144);
  assert.ok(graph.partitions.length > 1);
  const secondRoot = graph.operations.find(
    (operation) => operation.planChangeId === gameAssemblyOperationId("objects", "copy-1", "root"),
  );
  assert.ok(secondRoot?.kind === "create");
  const reference = secondRoot.properties.PrimaryPart;
  assert.ok(reference?.kind === "instance_ref" && reference.state === "reference");
  assert.equal(reference.path, "Workspace/Object1/Anchor");
});

test("provider wire preserves omitted planner fields and host-issued pagination without weakening query guards", async () => {
  const projectIndex: CreatorProjectIndexView = {
    ...observation,
    instances: [
      ...observation.instances,
      ...[1, 2].map((index) => ({
        objectId: `forge_attribute:folder-${index}`,
        identity: { kind: "forge_attribute" as const, stableId: `folder-${index}` },
        parentIdentity: observation.instances[0]!.identity,
        path: `Workspace/Folder${index}`,
        name: `Folder${index}`,
        className: "Folder",
        properties: {},
        attributes: {},
        tags: [],
      })),
    ],
  };
  const ownership = createStudioOwnershipMap({
    projectId: "project-wire-query",
    revisionHash,
    projectIndex,
  });
  const prompt = "Inspect the project before proposing a plan.";
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const sources = sourceEvidence(projectIndex, projectCaptureHash);
  const host = new CreatorPlannerToolHost({
    catalog: plannerCatalog,
    session,
    ownership,
    projectIndex,
    ...sources,
    prompt,
  });
  let calls = 0;
  const client = new OpenRouterModelClient({
    apiKey: "offline-test-key",
    fetchImpl: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      for (const entry of body.tools) {
        // OpenAI Responses may normalize optional fields when strict is absent.
        // Inspect the actual HTTP payload, after the pinned SDK adapter runs.
        assert.equal(entry.function.strict, false);
        const definition = host
          .definitions()
          .find((tool) => tool.name.replace(/[^A-Za-z0-9_-]/g, "_") === entry.function.name);
        assert.ok(definition, "the wire tool must come from the installed host schema");
        assert.deepEqual(entry.function.parameters, definition.schema);
      }
      const searchSchema = body.tools.find(
        (entry: { function: { name: string } }) => entry.function.name === "project_search",
      ).function.parameters;
      assert.deepEqual(searchSchema.required, ["queries"]);
      assert.deepEqual(schemaAt(searchSchema, ["properties", "queries", "items"]).required, [
        "query",
      ]);
      const childrenSchema = body.tools.find(
        (entry: { function: { name: string } }) => entry.function.name === "project_children",
      ).function.parameters;
      assert.deepEqual(childrenSchema.required, ["queries"]);
      const planSchema = body.tools.find(
        (entry: { function: { name: string } }) => entry.function.name === "creator_propose_plan",
      ).function.parameters;
      assert.equal(planSchema.properties.changes, undefined);
      assert.equal(planSchema.properties.reviews, undefined);
      const planStep = schemaAt(planSchema, ["properties", "steps", "items"]);
      assert.deepEqual(planStep.required, ["title", "details", "componentIds"]);
      assert.equal(schemaAt(planStep, ["properties", "details"]).minLength, 48);
      assert.equal(schemaAt(planStep, ["properties", "componentIds"]).minItems, 1);
      assert.equal(schemaAt(planSchema, ["properties", "design"]).type, "object");
      const checks = schemaAt(planSchema, ["properties", "checks", "items"]).anyOf;
      assert.ok(Array.isArray(checks));
      assert.equal(checks.length, 4);
      assert.ok(planSchema.required.includes("design"));
      assert.ok(planSchema.required.includes("steps"));
      assert.match(
        String(schemaAt(planSchema, ["properties", "checks"]).description),
        /native evidence/,
      );
      return new Response(
        JSON.stringify({
          id: "offline-inspection-response",
          model: DEFAULT_CREATOR_MODEL_ID,
          provider: "OpenAI",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "search-first",
                    type: "function",
                    function: {
                      name: "project_search",
                      arguments: '{"queries":[{"query":"Folder","limit":1}]}',
                    },
                  },
                  {
                    id: "children-first",
                    type: "function",
                    function: {
                      name: "project_children",
                      arguments: '{"queries":[{"rootPath":"Workspace","limit":1}]}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await client.complete({
    model: DEFAULT_CREATOR_MODEL_ID,
    system: "Inspect only.",
    messages: [{ role: "user", content: prompt }],
    tools: host.definitions().map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.schema,
    })),
    maxOutputTokens: 512,
    timeoutMs: 1000,
  });
  assert.equal(result.kind, "assistant");
  if (result.kind !== "assistant") return;
  assert.equal(host.validateBatch(result.message.toolCalls, new Set()).valid, true);
  for (const call of result.message.toolCalls) {
    const args = call.arguments as {
      queries: { query?: string; rootPath?: string; limit: number; cursor?: string }[];
    };
    assert.equal(Object.hasOwn(args.queries[0]!, "cursor"), false);
    const first = await host.execute(call.name, args);
    assert.equal(first.ok, true);
    const page = (
      first.value as { queries: { results: { objectId: string }[]; nextCursor: string }[] }
    ).queries[0]!;
    assert.equal(page.results[0]?.objectId, "forge_attribute:folder-1");
    assert.ok(page.nextCursor);
    const next = await host.execute(call.name, {
      queries: [{ ...args.queries[0], cursor: page.nextCursor }],
    });
    assert.equal(next.ok, true);
    assert.equal(
      (next.value as { queries: (typeof page)[] }).queries[0]!.results[0]?.objectId,
      "forge_attribute:folder-2",
    );
    const stale = await host.execute(call.name, { queries: [{ ...args.queries[0], cursor: "0" }] });
    assert.equal(stale.error?.code, "PROJECT_CURSOR_STALE");
    assert.match(stale.error?.message ?? "", /Omit cursor/);
  }
  const conflicting = await host.execute("project.children", {
    queries: [{ rootPath: "Workspace", parentObjectId: "root" }],
  });
  assert.equal(conflicting.error?.code, "PROJECT_PARENT_INVALID");
  for (const invalidParent of [
    { rootPath: "Workspace/PreservedScenery" },
    { rootPath: "MissingService" },
    { parentObjectId: "forge_attribute:missing-parent" },
  ]) {
    const invalidChildren = await host.execute("project.children", { queries: [invalidParent] });
    assert.equal(invalidChildren.ok, false);
    assert.equal(
      invalidChildren.error?.code,
      "rootPath" in invalidParent ? "TOOL_ARGUMENTS_INVALID" : "PROJECT_PARENT_INVALID",
    );
  }
  const children = await host.execute("project.children", {
    queries: [
      { parentObjectId: "forge_attribute:folder-1" },
      { parentObjectId: observation.instances[0]!.objectId },
    ],
  });
  assert.equal(children.ok, true);
  const pages = (children.value as { queries: { results: unknown[] }[] }).queries;
  assert.equal(pages[0]!.results.length, 0);
  assert.equal(pages[1]!.results.length, 2);
  const repeatedId = "forge_attribute:folder-1";
  const inspected = await host.execute("project.inspect", {
    objectIds: [repeatedId, repeatedId],
  });
  assert.equal(inspected.ok, true);
  assert.deepEqual(
    (inspected.value as { instances: { objectId: string }[] }).instances.map(
      (item) => item.objectId,
    ),
    [repeatedId],
  );
  const missingId = await host.execute("project.inspect", {
    objectIds: [repeatedId, "forge_attribute:missing"],
  });
  assert.equal(missingId.error?.code, "PROJECT_INSPECTION_ABSENT");
  assert.equal(calls, 1);
});

test("broad project exploration cannot overflow a plan outcome's citation bound", async () => {
  const projectIndex = {
    ...observation,
    instances: [
      ...observation.instances,
      ...Array.from({ length: 40 }, (_, index) => ({
        objectId: `forge_attribute:folder-${index}`,
        identity: { kind: "forge_attribute" as const, stableId: `folder-${index}` },
        path: `Workspace/Folder${index}`,
        name: `Folder${index}`,
        className: "Folder",
        properties: {},
        attributes: {},
        tags: [],
      })),
    ],
  };
  const ownership = createStudioOwnershipMap({
    projectId: "citation-bound",
    revisionHash,
    projectIndex,
  });
  const prompt = "Create a new folder.";
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const sources = sourceEvidence(projectIndex, projectCaptureHash);
  const host = new CreatorPlannerToolHost({
    catalog: plannerCatalog,
    session,
    ownership,
    projectIndex,
    prompt,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
  });
  const search = await host.execute("project.search", {
    queries: [{ query: "Workspace", limit: 100 }],
  });
  assert.equal(search.ok, true);
  const results = (search.value as { queries: { results: { citationHandle: string }[] }[] })
    .queries[0]!.results;
  assert.equal(results.length, 41);
  const proposal = {
    citationHandles: [results[0]!.citationHandle],
    inspectionObjectIds: [],
    design: folderDesign("NewFolder", { kind: "engine", id: "Workspace" }),
    checks: [{ check: "playtest_diagnostics", maximumErrors: 0, maximumWarnings: 0 }],
  };
  const malformed = await submitDesign(host, {
    ...proposal,
    design: { ...proposal.design, components: [{ kind: "source_package", id: "malformed" }] },
  });
  assert.equal(malformed.error?.code, "TOOL_ARGUMENTS_INVALID");
  assert.match(malformed.error?.message ?? "", /component/);
  const duplicate = await submitDesign(host, {
    ...proposal,
    design: {
      ...proposal.design,
      components: [...proposal.design.components, ...proposal.design.components],
    },
  });
  assert.equal(duplicate.ok, false);
  const result = await submitDesign(host, proposal);
  assert.equal(result.ok, true, JSON.stringify(result));
  const outcome = host.getOutcome();
  assertCreatorAgentOutcome(outcome);
  assert.deepEqual(
    outcome.citations.map((citation) => citation.handle),
    proposal.citationHandles,
  );
});

test("creator planner admits only host-issued memory and prior-evidence citation handles", async () => {
  const ownership = createStudioOwnershipMap({
    projectId: "project-conversation-citations",
    revisionHash,
    projectIndex: observation,
  });
  const prompt = "Explain the retained project convention.";
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const sources = sourceEvidence(observation, projectCaptureHash);
  const memory = createCreatorAgentContextCitation({
    projectRevisionHash: revisionHash,
    label: "Creator memory memory-door-style",
    subject: {
      kind: "memory",
      memoryItemId: "memory-door-style",
      revisionId: "memory_revision_door_style",
      revisionHash: contentHash("memory revision door style"),
    },
  });
  const evidenceHash = contentHash("prior conversation evidence");
  const priorEvidence = createCreatorAgentContextCitation({
    projectRevisionHash: revisionHash,
    label: "Prior evidence: approved door plan",
    subject: {
      kind: "prior_evidence",
      eventId: "creator_event_prior_plan",
      eventHash: contentHash("prior plan event"),
      evidence: {
        id: "creator_plan_prior",
        hash: evidenceHash,
        artifact: {
          artifactHash: evidenceHash,
          locator: `artifacts/${evidenceHash}.json`,
          bytes: 1,
        },
      },
    },
  });
  const host = new CreatorPlannerToolHost({
    catalog: plannerCatalog,
    session,
    ownership,
    projectIndex: observation,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
    prompt,
    contextCitations: [memory, priorEvidence],
  });
  const accepted = await host.execute("creator.answer", {
    text: "I will keep the saved door convention and the approved plan evidence in view.",
    citationHandles: [memory.citation.handle, priorEvidence.citation.handle],
  });
  assert.equal(accepted.ok, true);
  const outcome = host.getOutcome();
  assert.equal(outcome?.kind, "answer");
  if (outcome?.kind !== "answer") throw new Error("Expected a creator answer outcome");
  assert.deepEqual(
    outcome.citations.map((citation) => citation.subject.kind),
    ["memory", "prior_evidence"],
  );

  const isolatedHost = new CreatorPlannerToolHost({
    catalog: plannerCatalog,
    session,
    ownership,
    projectIndex: observation,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
    prompt,
  });
  const forged = await isolatedHost.execute("creator.answer", {
    text: "This must not turn a deterministic-looking handle into a citation.",
    citationHandles: [memory.citation.handle],
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.error?.code, "CREATOR_CITATION_NOT_ISSUED");

  assert.doesNotThrow(() =>
    assertCreatorRequestArtifact({
      kind: "CreatorRequest",
      sessionId: session.id,
      promptHash: session.promptHash,
      creatorText: prompt,
      agentPrompt: "Host-authored context.\n\n" + prompt,
      contextCitations: [memory, priorEvidence],
    }),
  );
  assert.throws(
    () =>
      assertCreatorRequestArtifact({
        kind: "CreatorRequest",
        sessionId: session.id,
        promptHash: session.promptHash,
        creatorText: prompt,
        agentPrompt: "Host-authored context.\n\n" + prompt,
        contextCitations: [memory, memory],
      }),
    /must be unique/,
  );
});

test("creator request retains exact conversation citations across artifact-store restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-creator-request-citations-"));
  try {
    const prompt = "Keep the established project convention.";
    const memory = createCreatorAgentContextCitation({
      projectRevisionHash: revisionHash,
      label: "Creator memory memory-convention",
      subject: {
        kind: "memory",
        memoryItemId: "memory-convention",
        revisionId: "memory_revision_convention",
        revisionHash: contentHash("memory revision convention"),
      },
    });
    const store = new ImmutableJsonArtifactStore(directory);
    const reference = await store.write({
      kind: "CreatorRequest",
      sessionId: "creator_session_context_restart",
      promptHash: contentHash(prompt),
      creatorText: prompt,
      agentPrompt: "Host-authored context.\n\n" + prompt,
      contextCitations: [memory],
    });
    const restarted = new ImmutableJsonArtifactStore(directory);
    const restored = await restarted.read(reference, assertCreatorRequestArtifact);
    assert.equal(restored.creatorText, prompt);
    assert.equal(restored.promptHash, contentHash(restored.creatorText));
    assert.notEqual(restored.agentPrompt, restored.creatorText);
    assert.deepEqual(restored.contextCitations, [memory]);
    assert.equal(restored.contextCitations[0]?.citation.handle, memory.citation.handle);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("engine-owned authoring containers are valid parents without entering mutable project evidence", async () => {
  const platformObservation: CreatorProjectIndexView = {
    ...observation,
    instances: [
      ...observation.instances,
      {
        objectId: "forge_attribute:server-script-service",
        identity: { kind: "forge_attribute", stableId: "server-script-service" },
        path: "ServerScriptService",
        name: "ServerScriptService",
        engineContainer: { path: "ServerScriptService", className: "ServerScriptService" },
        className: "ServerScriptService",
        properties: {},
        attributes: {},
        tags: [],
      },
      {
        objectId: "forge_attribute:starter-player",
        identity: { kind: "forge_attribute", stableId: "starter-player" },
        path: "StarterPlayer",
        name: "StarterPlayer",
        engineContainer: { path: "StarterPlayer", className: "StarterPlayer" },
        className: "StarterPlayer",
        properties: {},
        attributes: {},
        tags: [],
      },
      {
        objectId: "forge_attribute:starter-player-scripts",
        identity: { kind: "forge_attribute", stableId: "starter-player-scripts" },
        path: "StarterPlayer/StarterPlayerScripts",
        name: "StarterPlayerScripts",
        parentIdentity: { kind: "forge_attribute", stableId: "starter-player" },
        engineContainer: {
          path: "StarterPlayer/StarterPlayerScripts",
          className: "StarterPlayerScripts",
        },
        className: "StarterPlayerScripts",
        properties: {},
        attributes: {},
        tags: [],
      },
    ],
  };
  const ownership = createStudioOwnershipMap({
    projectId: "project-platform-containers",
    revisionHash,
    projectIndex: platformObservation,
  });
  const prompt = "Create one server script and one starter-player client script.";
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const sources = sourceEvidence(platformObservation, projectCaptureHash);
  const planInput = {
    sessionId: session.id,
    promptHash: session.promptHash,
    projectRevisionHash: revisionHash,
    projectCaptureHash,
    ownershipMapId: ownership.id,
    ownershipMapHash: ownership.hash,
    creatorPrompt: prompt,
    inspectionPaths: [],
    steps: [
      {
        id: "create-runtime-scripts",
        statement: "Create the bounded server and client entry points.",
        changeIds: ["create-server", "create-client"],
      },
    ],
    changes: [
      {
        id: "create-server",
        kind: "create" as const,
        path: "ServerScriptService/TestServer",
        parent: {
          kind: "engine_container" as const,
          path: "ServerScriptService",
          className: "ServerScriptService",
        },
        className: "Script" as const,
        initialization: "inline_source_required" as const,
      },
      {
        id: "create-client",
        kind: "create" as const,
        path: "StarterPlayer/StarterPlayerScripts/TestClient",
        parent: {
          kind: "engine_container" as const,
          path: "StarterPlayer/StarterPlayerScripts",
          className: "StarterPlayerScripts",
        },
        className: "LocalScript" as const,
        initialization: "inline_source_required" as const,
      },
    ],
    charter: {
      clauses: [
        {
          id: "syntax",
          kind: "local_check" as const,
          check: "luau_syntax" as const,
        },
        {
          id: "server-exists",
          kind: "studio_check" as const,
          check: "instance_exists" as const,
          path: "ServerScriptService/TestServer",
          expectedClass: "Script" as const,
        },
        {
          id: "client-exists",
          kind: "studio_check" as const,
          check: "instance_exists" as const,
          path: "StarterPlayer/StarterPlayerScripts/TestClient",
          expectedClass: "LocalScript" as const,
        },
        {
          id: "diagnostics",
          kind: "studio_check" as const,
          check: "playtest_diagnostics" as const,
          maximumErrors: 0,
          maximumWarnings: 0,
        },
      ],
    },
  };
  const plan = createTestPlan(
    { ...planInput, ...planSourceBinding(sources) },
    platformObservation,
    ownership,
  );
  const approval = createCreatorApproval({
    sessionId: session.id,
    artifactKind: "plan",
    artifactId: plan.id,
    artifactHash: plan.hash,
    decision: "approved",
    decidedAt: "2026-09-01T00:00:00.000Z",
  });
  const contract = createCreatorBuildContract({
    session,
    plan,
    planApproval: approval,
    ownership,
    projectIndex: platformObservation,
  });
  assert.deepEqual(contract.initialInspectionPaths, []);
  const visiblePlan = creatorPlanSummary(plan);
  assert.match(visiblePlan, /^World structure:/);
  for (const step of plan.steps) assert.ok(visiblePlan.includes(step.statement));
  for (const clause of plan.charter.clauses)
    assert.equal(visiblePlan.includes(clause.statement), false);
  assert.throws(
    () =>
      creatorPlanSummary({ ...plan, steps: [{ ...plan.steps[0]!, statement: "界".repeat(6000) }] }),
    /16,384 UTF-8 bytes/,
  );
  const builderPrompt = creatorBuilderSystemPrompt(plan, contract, platformObservation);
  assert.match(builderPrompt, /creator-facing prose in GitHub-flavored Markdown/);
  assert.match(builderPrompt, /tool arguments remain exact schema-valid JSON/);
  const context = JSON.parse(
    builderPrompt.split("The creator request is in the conversation message.\n")[1]!,
  );
  assert.deepEqual(context.compiledInventory, {
    count: plan.compiled.inventory.length,
    hash: plan.compiled.hash,
  });
  assert.deepEqual(context.design, plan.compiled.design);
  assert.deepEqual(
    context.sourceSlots.map((slot: { id: string }) => slot.id),
    plan.compiled.inventory.filter((item) => item.source).map((item) => item.id),
  );
  assert.deepEqual(context.valueSlots, []);
  assert.equal(context.propertyPolicies, undefined);
  assert.deepEqual(
    context.steps,
    plan.steps.map((step) => ({
      id: step.id,
      statement: step.statement,
      changeCount: step.changeIds.length,
    })),
  );
  assert.equal(context.acceptedHierarchy.available, true);
  assert.equal(context.acceptedHierarchy.creatorPlanHash, plan.hash);
  assert.equal(context.acceptedHierarchy.planHash, plan.compiled.hash);
  assert.equal(context.acceptedHierarchy.operationCount, plan.compiled.inventory.length);
  assert.match(builderPrompt, /omitted properties are unobserved, never absent/);
  assert.deepEqual(
    context.qualityRequirements,
    plan.charter.clauses
      .filter(
        (clause) =>
          clause.kind === "creator_review" ||
          (clause.kind === "studio_check" && clause.check !== "instance_exists"),
      )
      .map((clause) => clause.statement),
  );
  assert.deepEqual(context.observedObjects, []);
  assert.ok(
    builderPrompt.length < stableJson(plan).length + stableJson(contract).length,
    "unused and repeated class policies must not inflate every model turn",
  );

  const host = new CreatorPlannerToolHost({
    catalog: plannerCatalog,
    session,
    ownership,
    projectIndex: platformObservation,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
    prompt,
  });
  const rejected = await submitDesign(host, {
    inspectionObjectIds: [],
    design: folderDesign("NewFolder", { kind: "object", id: "forge_attribute:missing" }),
    checks: [{ check: "playtest_diagnostics", maximumErrors: 0, maximumWarnings: 0 }],
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error?.message ?? "", /observ|object/i);
  const completion = host.completionStatus();
  assert.equal(completion.ready, false);
  if (!completion.ready) assert.match(completion.message, /Last outcome failure/);
});

test("indexed non-authorable classes remain exact structural parents without gaining mutation authority", async () => {
  const structuralRevision = contentHash("indexed structural parent revision");
  const structuralCaptureHash = captureHashFor(structuralRevision);
  const cameraIdentity = {
    kind: "studio_ephemeral" as const,
    connectorEpoch: "creator_structural_parent_epoch",
    opaqueHash: "7".repeat(64),
  };
  const structuralObservation: CreatorProjectIndexView = {
    project: { name: "Structural Parent", placeId: 0, universeId: 0 },
    revision: { hash: structuralRevision } as CreatorProjectIndexView["revision"],
    instances: [
      ...observation.instances,
      {
        objectId: `studio_ephemeral:${cameraIdentity.connectorEpoch}:${cameraIdentity.opaqueHash}`,
        identity: cameraIdentity,
        path: "Workspace/ExistingCamera",
        name: "ExistingCamera",
        parentIdentity: { kind: "forge_attribute", stableId: "workspace" },
        className: "Camera",
        properties: {},
        attributes: {},
        tags: [],
      },
    ],
    scripts: [],
  };
  const ownership = createStudioOwnershipMap({
    projectId: "project-structural-parent",
    revisionHash: structuralRevision,
    projectIndex: structuralObservation,
  });
  const prompt = "Create one folder beneath the exact existing camera object.";
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash: structuralRevision,
    projectCaptureHash: structuralCaptureHash,
    ownership,
  });
  const sources = sourceEvidence(structuralObservation, structuralCaptureHash);
  const plan = createTestPlan(
    {
      sessionId: session.id,
      promptHash: session.promptHash,
      projectRevisionHash: structuralRevision,
      projectCaptureHash: structuralCaptureHash,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      creatorPrompt: prompt,
      inspectionPaths: ["Workspace/ExistingCamera"],
      steps: [
        {
          id: "create-child",
          statement: "Create the approved child under the exact indexed parent.",
          changeIds: ["camera-child"],
        },
      ],
      changes: [
        {
          id: "camera-child",
          kind: "create",
          path: "Workspace/ExistingCamera/Child",
          parent: {
            kind: "instance",
            identity: cameraIdentity,
            path: "Workspace/ExistingCamera",
            className: "Camera",
          },
          className: "Folder",
          initialization: "initial_properties",
        },
      ],
      charter: {
        clauses: [
          {
            id: "child-exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "Workspace/ExistingCamera/Child",
            expectedClass: "Folder",
          },
          {
            id: "diagnostics",
            kind: "studio_check",
            check: "playtest_diagnostics",
            maximumErrors: 0,
            maximumWarnings: 0,
          },
        ],
      },
      ...planSourceBinding(sources),
    },
    structuralObservation,
    ownership,
  );
  const approval = createCreatorApproval({
    sessionId: session.id,
    artifactKind: "plan",
    artifactId: plan.id,
    artifactHash: plan.hash,
    decision: "approved",
    decidedAt: "2026-09-03T00:00:00.000Z",
  });
  const contract = createCreatorBuildContract({
    session,
    plan,
    planApproval: approval,
    ownership,
    projectIndex: structuralObservation,
  });
  const contractChange = contract.changes[0];
  const planChange = plan.changes[0];
  assert.equal(contractChange?.kind, "create");
  assert.equal(planChange?.kind, "create");
  if (contractChange?.kind !== "create" || planChange?.kind !== "create")
    throw new Error("structural-parent fixture did not retain its create operation");
  assert.deepEqual(contractChange.parent, planChange.parent);

  const host = new CreatorBuilderToolHost({
    session,
    ownership,
    projectIndex: structuralObservation,
    plan,
    planApproval: approval,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
    sourceConsultation: sources.sourceConsultation,
  });
  const staged = await host.execute("studio.build", {
    sources: [],
    values: [],
    summary: "Created the approved child.",
  });
  assert.equal(staged.ok, true);
  assert.equal(host.stagedOperations()[0]?.kind, "create");
});

test("creator verification keeps staged source repair and rejects invalid Luau", async () => {
  const topologyObservation: CreatorProjectIndexView = {
    project: { name: "Creator Topology", placeId: 0, universeId: 0 },
    revision: {
      hash: contentHash("creator topology revision"),
    } as CreatorProjectIndexView["revision"],
    instances: [
      {
        objectId: "forge_attribute:topology-server-script-service",
        identity: { kind: "forge_attribute", stableId: "topology-server-script-service" },
        path: "ServerScriptService",
        name: "ServerScriptService",
        engineContainer: { path: "ServerScriptService", className: "ServerScriptService" },
        className: "ServerScriptService",
        properties: {},
        attributes: {},
        tags: [],
      },
      {
        objectId: "forge_attribute:replicated-storage",
        identity: { kind: "forge_attribute", stableId: "replicated-storage" },
        path: "ReplicatedStorage",
        name: "ReplicatedStorage",
        engineContainer: { path: "ReplicatedStorage", className: "ReplicatedStorage" },
        className: "ReplicatedStorage",
        properties: {},
        attributes: {},
        tags: [],
      },
      {
        objectId: "forge_attribute:airlock-system",
        identity: { kind: "forge_attribute", stableId: "airlock-system" },
        path: "ReplicatedStorage/AirlockSystem",
        name: "AirlockSystem",
        parentIdentity: { kind: "forge_attribute", stableId: "replicated-storage" },
        className: "Folder",
        properties: {},
        attributes: {},
        tags: [],
      },
    ],
    scripts: [],
  };
  const topologyRevision = contentHash("creator topology revision");
  const topologyCaptureHash = captureHashFor(topologyRevision);
  const ownership = createStudioOwnershipMap({
    projectId: "project-creator-topology",
    revisionHash: topologyRevision,
    projectIndex: topologyObservation,
  });
  const prompt = "Create a shared protocol and a server script that requires it.";
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash: topologyRevision,
    projectCaptureHash: topologyCaptureHash,
    ownership,
  });
  const sources = sourceEvidence(topologyObservation, topologyCaptureHash);
  const plan = createTestPlan(
    {
      sessionId: session.id,
      promptHash: session.promptHash,
      projectRevisionHash: topologyRevision,
      projectCaptureHash: topologyCaptureHash,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      creatorPrompt: prompt,
      inspectionPaths: [],
      steps: [
        {
          id: "create-sources",
          statement: "Create the protocol and server source.",
          changeIds: ["protocol", "server", "panel"],
        },
      ],
      changes: [
        {
          id: "panel",
          kind: "create",
          path: "ReplicatedStorage/Panel",
          parent: {
            kind: "engine_container",
            path: "ReplicatedStorage",
            className: "ReplicatedStorage",
          },
          className: "Part",
          initialization: "initial_properties",
        },
        {
          id: "protocol",
          kind: "create",
          path: "ReplicatedStorage/AirlockSystem/Protocol",
          parent: {
            kind: "instance",
            identity: { kind: "forge_attribute", stableId: "airlock-system" },
            path: "ReplicatedStorage/AirlockSystem",
            className: "Folder",
          },
          className: "ModuleScript",
          initialization: "inline_source_required",
        },
        {
          id: "server",
          kind: "create",
          path: "ServerScriptService/AirlockServer",
          parent: {
            kind: "engine_container",
            path: "ServerScriptService",
            className: "ServerScriptService",
          },
          className: "Script",
          initialization: "inline_source_required",
        },
      ],
      charter: {
        clauses: [
          {
            id: "panel-exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "ReplicatedStorage/Panel",
            expectedClass: "Part",
          },
          { id: "syntax", kind: "local_check", check: "luau_syntax" },
          {
            id: "protocol-exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "ReplicatedStorage/AirlockSystem/Protocol",
            expectedClass: "ModuleScript",
          },
          {
            id: "server-exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "ServerScriptService/AirlockServer",
            expectedClass: "Script",
          },
          {
            id: "diagnostics",
            kind: "studio_check",
            check: "playtest_diagnostics",
            maximumErrors: 0,
            maximumWarnings: 0,
          },
        ],
      },
      ...planSourceBinding(sources),
    },
    topologyObservation,
    ownership,
    {
      panel: {
        attributes: { Purpose: "status" },
        valueSlots: [
          {
            id: "panel-cframe",
            propertyName: "CFrame",
            schema: {
              type: "object",
              properties: {
                kind: { type: "string", maxLength: 32, enum: ["cframe_f32x12"] },
                components: { type: "array", items: { type: "number" }, maxItems: 12 },
              },
              required: ["kind", "components"],
              additionalProperties: false,
            },
          },
          ...["Transparency", "Reflectance"].map((propertyName) => ({
            id: "panel-" + propertyName.toLowerCase(),
            propertyName,
            schema: {
              type: "object" as const,
              properties: {
                kind: { type: "string" as const, maxLength: 32, enum: ["number_f32"] },
                value: { type: "number" as const, minimum: 0, maximum: 1 },
              },
              required: ["kind", "value"],
              additionalProperties: false as const,
            },
          })),
        ],
      },
    },
    { imports: { server: ["protocol"] } },
  );
  const planApproval = createCreatorApproval({
    sessionId: session.id,
    artifactKind: "plan",
    artifactId: plan.id,
    artifactHash: plan.hash,
    decision: "approved",
    decidedAt: "2026-09-01T00:00:00.000Z",
  });
  const host = new CreatorBuilderToolHost({
    session,
    ownership,
    projectIndex: topologyObservation,
    plan,
    planApproval,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
    sourceConsultation: sources.sourceConsultation,
  });

  const beforeBatch = host.progressToken();
  const incompleteBatch = await host.execute("studio.build", {
    changes: [
      { planChangeId: "protocol", source: "return {}\n" },
      { planChangeId: "panel", properties: {} },
    ],
    summary: "Built the airlock implementation.",
  });
  assert.equal(incompleteBatch.error?.code, "TOOL_ARGUMENTS_INVALID");
  assert.equal(host.progressToken(), beforeBatch);
  assert.equal(host.stagedOperations().length, 0);
  assert.equal(host.stagedSourceWriteBlobs().length, 0);
  const rejectedBatch = await host.execute("studio.build", {
    sources: [
      { slotId: "protocol", source: "return { Enabled = true }\n" },
      { slotId: "server", source: "--!strict\nlocal impossible: string = 1\nprint(impossible)\n" },
    ],
    values: [
      { slotId: "panel-cframe", value: { X: 0, Y: 4, Z: 0 } },
      { slotId: "panel-transparency", value: 0.2 },
      { slotId: "panel-reflectance", value: 0.1 },
    ],
    summary: "Built the airlock implementation.",
  });
  assert.equal(rejectedBatch.ok, false);
  assert.equal(host.progressToken(), beforeBatch);
  assert.equal(host.stagedOperations().length, 0, "an invalid complete batch is atomic");

  const built = await host.execute("studio.build", {
    sources: [
      { slotId: "protocol", source: "return { Enabled = true }\n" },
      { slotId: "server", source: "--!strict\nlocal impossible: string = 1\nprint(impossible)\n" },
    ],
    values: [
      { slotId: "panel-cframe", value: { position: { x: 0, y: 4, z: 0 } } },
      { slotId: "panel-transparency", value: 0.2 },
      { slotId: "panel-reflectance", value: 0.1 },
    ],
    summary: "Built the requested server behavior.",
  });
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.equal(host.stagedOperations().length, 3);
  const automaticReview = (
    built.value as {
      review: {
        status: string;
        drafts: unknown[];
        issues: Array<{ count: number; locations?: unknown[] }>;
      };
    }
  ).review;
  assert.equal(
    automaticReview.status,
    "rejected",
    "the one build receipt should diagnose the complete draft without another model request",
  );
  assert.ok(automaticReview.drafts.length);
  assert.ok(automaticReview.issues.every((issue) => issue.count >= 1));
  assert.equal(host.completionStatus().ready, false);
  assert.doesNotMatch(JSON.stringify(automaticReview), /forge-studio-luau-analysis|\/var\/folders/);

  const draft = await host.execute("studio.read_drafts", {
    drafts: [{ planChangeId: "server", startLine: 1, lineCount: 3 }],
  });
  assert.equal(draft.ok, true);
  const serverDraft = (
    draft.value as {
      drafts: Array<{ sourceHash: string; lines: unknown[] }>;
    }
  ).drafts[0]!;
  assert.deepEqual(serverDraft.lines, [
    { line: 1, text: "--!strict\n" },
    { line: 2, text: "local impossible: string = 1\n" },
    { line: 3, text: "print(impossible)\n" },
  ]);

  const contextBefore = host.progressToken();
  const context = await host.execute("game.source_context", {
    planHash: plan.compiled.hash,
    operationId: "server",
    offset: 0,
  });
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(host.progressToken(), contextBefore, "source navigation does not stage changes");
  const imports = (context.value as { imports: { requireExpression: string }[] }).imports;
  assert.equal(imports.length, 1);
  assert.equal(
    imports[0]!.requireExpression,
    'require(game:GetService("ReplicatedStorage"):WaitForChild("AirlockSystem"):WaitForChild("Protocol"))',
  );
  const staleContext = await host.execute("game.source_context", {
    planHash: contentHash("another plan"),
    operationId: "server",
    offset: 0,
  });
  assert.equal(staleContext.ok, false);
  const outsideContext = await host.execute("game.source_context", {
    planHash: plan.compiled.hash,
    operationId: "panel",
    offset: 0,
  });
  assert.equal(outsideContext.ok, false);
  const replacementSource = [
    "local protocol = " + imports[0]!.requireExpression,
    "assert(protocol.Enabled)",
    "",
  ].join("\n");
  const panel = host.stagedOperations().find((item) => item.planChangeId === "panel")!;
  const repaired = await host.execute("studio.repair", {
    repairs: [
      {
        kind: "source",
        planChangeId: "server",
        expectedSourceHash: serverDraft.sourceHash,
        edits: [{ startLine: 1, deleteCount: 3, replacement: replacementSource }],
      },
      {
        kind: "properties",
        planChangeId: "panel",
        expectedOperationHash: contentHash(stableJson(panel)),
        properties: { Reflectance: 0.2 },
      },
    ],
    summary: "Built the requested server behavior.",
  });
  assert.equal(repaired.ok, true, JSON.stringify(repaired.error));
  assert.equal((repaired.value as { review: { status: string } }).review.status, "eligible");
  const adjustedPanel = host.stagedOperations().find((item) => item.planChangeId === "panel");
  assert.ok(adjustedPanel?.kind === "create" && panel.kind === "create");
  assert.deepEqual(adjustedPanel.attributes, panel.attributes);
  assert.deepEqual(adjustedPanel.properties, {
    ...panel.properties,
    Reflectance: { kind: "number_f32", value: Math.fround(0.2) },
  });
  const repairedServer = host
    .stagedOperations()
    .find((operation) => operation.planChangeId === "server");
  assert.ok(repairedServer?.kind === "create" && repairedServer.sourceBlob);
  assert.equal(repairedServer.sourceBlob.sourceHash, contentHash(replacementSource));
  const repairedState = host.progressToken();
  const staleRepair = await host.execute("studio.repair", {
    repairs: [
      {
        kind: "source",
        planChangeId: "server",
        expectedSourceHash: serverDraft.sourceHash,
        edits: [{ startLine: 1, deleteCount: 1, replacement: "error('stale')\n" }],
      },
    ],
    summary: "This stale repair must not replace the accepted draft.",
  });
  assert.equal(staleRepair.ok, false);
  assert.equal(host.progressToken(), repairedState, "a stale atomic repair changes nothing");
  assert.equal(host.completionStatus().ready, true);
  const sealed = host.sealedGraph();
  assert.equal(sealed.kind, "GameBuildGraph");
  assert.equal(sealed.acceptanceHash, planApproval.hash);
  assert.equal(sealed.planHash, plan.compiled.hash);
  assert.equal(sealed.localChecks.status, "eligible");
  assert.equal(sealed.operations.length, 3);
});

test("creator verification retains unchanged ModuleScript source and passes valid Luau", async () => {
  const protocolSource = "return { Enabled = true }\n";
  const dependencyObservation: CreatorProjectIndexView = {
    project: { name: "Creator Existing Dependency", placeId: 0, universeId: 0 },
    revision: {
      hash: contentHash("creator existing dependency revision"),
    } as CreatorProjectIndexView["revision"],
    instances: [
      {
        objectId: "forge_attribute:dependency-server-script-service",
        identity: { kind: "forge_attribute", stableId: "dependency-server-script-service" },
        path: "ServerScriptService",
        name: "ServerScriptService",
        engineContainer: { path: "ServerScriptService", className: "ServerScriptService" },
        className: "ServerScriptService",
        properties: {},
        attributes: {},
        tags: [],
      },
      {
        objectId: "forge_attribute:replicated-storage-existing",
        identity: { kind: "forge_attribute", stableId: "replicated-storage-existing" },
        path: "ReplicatedStorage",
        name: "ReplicatedStorage",
        engineContainer: { path: "ReplicatedStorage", className: "ReplicatedStorage" },
        className: "ReplicatedStorage",
        properties: {},
        attributes: {},
        tags: [],
      },
      {
        objectId: "forge_attribute:airlock-system-existing",
        identity: {
          kind: "forge_attribute",
          stableId: "airlock-system-existing",
        },
        path: "ReplicatedStorage/AirlockSystem",
        name: "AirlockSystem",
        parentIdentity: { kind: "forge_attribute", stableId: "replicated-storage-existing" },
        className: "Folder",
        properties: {},
        attributes: {},
        tags: [],
      },
      {
        objectId: "forge_attribute:protocol-existing",
        identity: { kind: "forge_attribute", stableId: "protocol-existing" },
        path: "ReplicatedStorage/AirlockSystem/Protocol",
        name: "Protocol",
        parentIdentity: { kind: "forge_attribute", stableId: "airlock-system-existing" },
        className: "ModuleScript",
        properties: {},
        attributes: {},
        tags: [],
      },
    ],
    scripts: [
      {
        documentId: "forge_attribute:protocol-existing",
        path: "ReplicatedStorage/AirlockSystem/Protocol",
        className: "ModuleScript",
        executionContext: "shared",
        sourceHash: contentHash(protocolSource),
        utf8Bytes: Buffer.byteLength(protocolSource, "utf8"),
      },
    ],
  };
  const dependencyRevision = contentHash("creator existing dependency revision");
  const dependencyCaptureHash = captureHashFor(dependencyRevision);
  const ownership = createStudioOwnershipMap({
    projectId: "project-creator-existing-dependency",
    revisionHash: dependencyRevision,
    projectIndex: dependencyObservation,
  });
  const prompt = "Create a server script that uses the existing shared protocol.";
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash: dependencyRevision,
    projectCaptureHash: dependencyCaptureHash,
    ownership,
  });
  const sources = sourceEvidence(dependencyObservation, dependencyCaptureHash, [
    {
      documentId: "forge_attribute:protocol-existing",
      path: "ReplicatedStorage/AirlockSystem/Protocol",
      className: "ModuleScript",
      executionContext: "shared",
      sourceHash: contentHash(protocolSource),
      source: protocolSource,
    },
  ]);
  const plan = createTestPlan(
    {
      sessionId: session.id,
      promptHash: session.promptHash,
      projectRevisionHash: dependencyRevision,
      projectCaptureHash: dependencyCaptureHash,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      creatorPrompt: prompt,
      inspectionPaths: [],
      steps: [
        {
          id: "create-server",
          statement: "Create the server script against the existing protocol.",
          changeIds: ["server"],
        },
      ],
      changes: [
        {
          id: "server",
          kind: "create",
          path: "ServerScriptService/AirlockServer",
          parent: {
            kind: "engine_container",
            path: "ServerScriptService",
            className: "ServerScriptService",
          },
          className: "Script",
          initialization: "inline_source_required",
        },
      ],
      charter: {
        clauses: [
          { id: "syntax", kind: "local_check", check: "luau_syntax" },
          {
            id: "server-exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "ServerScriptService/AirlockServer",
            expectedClass: "Script",
          },
          {
            id: "diagnostics",
            kind: "studio_check",
            check: "playtest_diagnostics",
            maximumErrors: 0,
            maximumWarnings: 0,
          },
        ],
      },
      ...planSourceBinding(sources),
    },
    dependencyObservation,
    ownership,
    {},
    {
      imports: { server: ["protocol"] },
      observed: { protocol: "forge_attribute:protocol-existing" },
    },
  );
  const planApproval = createCreatorApproval({
    sessionId: session.id,
    artifactKind: "plan",
    artifactId: plan.id,
    artifactHash: plan.hash,
    decision: "approved",
    decidedAt: "2026-09-01T00:00:00.000Z",
  });
  const host = new CreatorBuilderToolHost({
    session,
    ownership,
    projectIndex: dependencyObservation,
    plan,
    planApproval,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
    sourceConsultation: sources.sourceConsultation,
  });
  const staged = await host.execute("studio.build", {
    sources: [
      {
        slotId: "server",
        source: [
          'local ReplicatedStorage = game:GetService("ReplicatedStorage")',
          'local system = ReplicatedStorage:WaitForChild("AirlockSystem")',
          'local protocol = require(system:WaitForChild("Protocol"))',
          "assert(protocol.Enabled)",
          "",
        ].join("\n"),
      },
    ],
    values: [],
    summary: "Built the requested server behavior.",
  });
  assert.equal(staged.ok, true);
  assert.equal(
    (staged.value as { review: { status: string } }).review.status,
    "eligible",
    JSON.stringify(staged.value),
  );
  assert.equal(host.completionStatus().ready, true);
});

test("creator session history is bound to immutable project-index captures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-outcome-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifactStore = new ImmutableJsonArtifactStore(directory);
  const ownership = createStudioOwnershipMap({
    projectId: "project-evidence-first",
    revisionHash,
    projectIndex: observation,
  });
  const session = createCreatorSession({
    prompt: "Create a closed evidence test.",
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
    now: new Date("2026-09-01T00:00:00.000Z"),
  });
  const incomplete = advanceSession(session, {
    status: "incomplete",
    failure: {
      code: "control_process_interrupted",
      detail: "No Studio value was inferred after the interruption.",
    },
    now: new Date("2026-09-01T00:00:01.000Z"),
  });
  const bundle: CreatorSessionBundle = {
    session: incomplete,
    creatorRequest: {
      locator: `artifacts/${"a".repeat(64)}.json`,
      artifactHash: "a".repeat(64),
      bytes: 1,
    },
    ownership,
    projectIndices: [projectIndexBinding(revisionHash)],
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
    agentRuns: [],
  };
  assert.doesNotThrow(() => assertCreatorSessionBundle(bundle));
  // The planner publishes a conversational outcome (answer, question, or plan).
  // A truncated response must retain its real failure instead of failing bundle validation.
  const reference = {
    phase: "creator_planner" as const,
    agentRunId: "agent_run_phase_regression",
    agentRun: bundle.creatorRequest,
    traceId: "trace_phase_regression",
    trace: bundle.creatorRequest,
    traceBuildKey: "trace_build_phase_regression",
    creatorSessionHash: session.hash,
    outcome: {
      status: "unsealed" as const,
      intendedArtifactKind: "creator_outcome" as const,
      failureStage: "runtime" as const,
      failureCode: "RUNTIME_BUDGET_EXHAUSTED",
      detailHash: contentHash("Model stopped at the output-token limit"),
      attemptHash: "b".repeat(64),
    },
  };
  assert.doesNotThrow(() => assertCreatorSessionBundle({ ...bundle, agentRuns: [reference] }));
  assert.throws(
    () =>
      assertCreatorSessionBundle({
        ...bundle,
        agentRuns: [
          {
            ...reference,
            outcome: { ...reference.outcome, intendedArtifactKind: "game_build_graph" },
          },
        ],
      }),
    /does not match its referenced phase/,
  );
  for (const payload of [
    { kind: "answer" as const, text: "This place contains Workspace.", citations: [] },
    {
      kind: "clarification_requested" as const,
      question: "Which door should change?",
      citations: [],
    },
  ]) {
    const hash = contentHash(stableJson(payload));
    const outcome = { ...payload, id: `creator_agent_outcome_${hash.slice(0, 24)}`, hash };
    const artifact = await artifactStore.write(outcome);
    const withOutcome = {
      ...bundle,
      agentOutcome: {
        outcome,
        artifact,
      },
      agentRuns: [
        {
          ...reference,
          outcome: {
            status: "sealed" as const,
            artifact: { kind: "creator_outcome" as const, id: outcome.id, hash },
            attemptHash: "b".repeat(64),
          },
        },
      ],
    };
    assert.doesNotThrow(() => assertCreatorSessionBundle(withOutcome));
    assert.deepEqual(await artifactStore.read(artifact), outcome);
    assert.throws(
      () =>
        assertCreatorSessionBundle({
          ...withOutcome,
          agentOutcome: {
            outcome,
            artifact: {
              ...artifact,
              locator: `artifacts/${contentHash(stableJson(outcome))}.json`,
              artifactHash: contentHash(stableJson(outcome)),
            },
          },
        }),
      /artifact binding mismatch/,
    );
    assert.throws(
      () =>
        assertCreatorSessionBundle({
          ...withOutcome,
          agentRuns: [
            {
              ...withOutcome.agentRuns[0]!,
              outcome: {
                ...withOutcome.agentRuns[0]!.outcome,
                artifact: { kind: "creator_outcome", id: outcome.id, hash: "e".repeat(64) },
              },
            },
          ],
        }),
      /not linked to its outcome/,
    );
  }
  assert.throws(
    () =>
      assertCreatorSessionBundle({
        ...bundle,
        projectIndices: [],
      }),
    /project-index and refresh evidence history/,
  );
  assert.throws(() => {
    const { hash: _hash, ...sessionPayload } = bundle.session;
    const mismatchedSessionPayload = {
      ...sessionPayload,
      currentProjectCaptureHash: contentHash("same revision but a different complete capture"),
    };
    assertCreatorSessionBundle({
      ...bundle,
      session: {
        ...mismatchedSessionPayload,
        hash: contentHash(stableJson(mismatchedSessionPayload)),
      },
    });
  }, /project-index captures must bind persisted evidence/);
  assert.equal(bundle.session.failure?.code, "control_process_interrupted");
  assert.notEqual(bundle.session.failure?.detailHash, contentHash(""));
  const restoredDetail = restoredCreatorControlDetail(bundle);
  assert.match(restoredDetail, /control process interrupted/i);
  assert.match(restoredDetail, /no mutation-attempt or verification evidence/i);
  assert.match(restoredDetail, /start a new request to retry/i);
  assert.doesNotMatch(restoredDetail, /session ready/i);
});

test("creator plans reserve enough Play Solo time for a human-triggered observation", () => {
  const runtimeObservation: CreatorProjectIndexView = {
    project: { name: "Creator Runtime Window", placeId: 0, universeId: 0 },
    revision: {
      hash: contentHash("creator runtime window revision"),
    } as CreatorProjectIndexView["revision"],
    instances: [
      {
        objectId: "forge_attribute:workspace",
        identity: { kind: "forge_attribute", stableId: "workspace" },
        path: "Workspace",
        name: "Workspace",
        engineContainer: { path: "Workspace", className: "Workspace" },
        className: "Workspace",
        properties: {},
        attributes: {},
        tags: [],
      },
      {
        objectId: "forge_attribute:door",
        identity: { kind: "forge_attribute", stableId: "door" },
        path: "Workspace/Door",
        name: "Door",
        parentIdentity: { kind: "forge_attribute", stableId: "workspace" },
        className: "Part",
        properties: {},
        attributes: {},
        tags: [],
      },
    ],
    scripts: [],
  };
  const runtimeRevision = contentHash("creator runtime window revision");
  const runtimeCaptureHash = captureHashFor(runtimeRevision);
  const runtimeOwnership = createStudioOwnershipMap({
    projectId: "creator-runtime-window-project",
    revisionHash: runtimeRevision,
    projectIndex: runtimeObservation,
  });
  const sources = sourceEvidence(runtimeObservation, runtimeCaptureHash);
  const creatorPrompt = "Make the door respond to a creator-triggered interaction.";
  const input = {
    sessionId: "creator-runtime-window-session",
    promptHash: contentHash(creatorPrompt),
    projectRevisionHash: runtimeRevision,
    projectCaptureHash: runtimeCaptureHash,
    ownershipMapId: runtimeOwnership.id,
    ownershipMapHash: runtimeOwnership.hash,
    creatorPrompt,
    inspectionPaths: ["Workspace/Door"],
    steps: [
      {
        id: "update-door-step",
        statement: "Update and verify the door.",
        changeIds: ["update-door"],
      },
    ],
    changes: [
      {
        id: "update-door",
        kind: "update" as const,
        target: {
          kind: "instance" as const,
          identity: { kind: "forge_attribute" as const, stableId: "door" },
          path: "Workspace/Door",
          className: "Part" as const,
        },
        expectedClass: "Part" as const,
      },
    ],
    charter: {
      clauses: [
        {
          id: "door-exists",
          kind: "studio_check" as const,
          check: "instance_exists" as const,
          path: "Workspace/Door",
          expectedClass: "BasePart" as const,
        },
        {
          id: "door-series",
          kind: "studio_check" as const,
          check: "position_series" as const,
          path: "Workspace/Door",
          expectedClass: "BasePart" as const,
          sampleCount: 2,
          intervalMs: 100,
          quantizationStuds: 0.25,
          minimumDistinctPositions: 2,
        },
        {
          id: "diagnostics",
          kind: "studio_check" as const,
          check: "playtest_diagnostics" as const,
          maximumErrors: 0,
          maximumWarnings: 10,
        },
      ],
    },
    ...planSourceBinding(sources),
  };
  assert.throws(
    () => createTestPlan(input, runtimeObservation, runtimeOwnership),
    new RegExp(`capacity for at least ${CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS} ms`),
  );
  assert.doesNotThrow(() =>
    createTestPlan(
      {
        ...input,
        charter: {
          clauses: input.charter.clauses.map((clause) =>
            clause.id === "door-series"
              ? {
                  ...clause,
                  sampleCount: CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS / 1_000 + 1,
                  intervalMs: 1_000,
                }
              : clause,
          ),
        },
      },
      runtimeObservation,
      runtimeOwnership,
    ),
  );
});

test("creator property inputs reach every proof-closed manifest codec", () => {
  const cases = [
    ["Attachment", "Axis", { x: 1, y: 0, z: 0 }, "vector3_f32"],
    [
      "Attachment",
      "CFrame",
      { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 } },
      "cframe_f32x12",
    ],
    ["Part", "CFrame", { position: { x: 0, y: 4, z: -24 } }, "cframe_f32x12"],
    ["Attachment", "Visible", false, "boolean"],
    [
      "Beam",
      "Attachment0",
      {
        objectId: "attachment-a",
      },
      "instance_ref",
    ],
    ["Beam", "Brightness", 0.5, "number_f32"],
    [
      "Beam",
      "Color",
      {
        keypoints: [
          { time: 0, color: { r: 1, g: 0, b: 0 } },
          { time: 1, color: { r: 0, g: 0, b: 1 } },
        ],
      },
      "color_sequence",
    ],
    [
      "Beam",
      "Transparency",
      {
        keypoints: [
          { time: 0, value: 0, envelope: 0 },
          { time: 1, value: 1, envelope: 0 },
        ],
      },
      "number_sequence",
    ],
    ["Color3Value", "Value", { r: 0.5, g: 0.25, b: 1 }, "color3_rgb8"],
    ["Decal", "UVOffset", { x: 0.25, y: -0.5 }, "vector2_f32"],
    ["Decal", "ZIndex", 2, "int32"],
    ["Frame", "Position", { x: { scale: 0.5, offset: 4 }, y: { scale: 1, offset: -2 } }, "udim2"],
    ["ImageLabel", "SliceCenter", { min: { x: 0, y: 0 }, max: { x: 16, y: 16 } }, "rect"],
    ["IntValue", "Value", "9007199254740991", "int64_decimal"],
    ["NumberValue", "Value", Math.PI, "number_f64"],
    ["Part", "CollisionGroup", "Default", "string_utf8"],
    ["Part", "Material", "Plastic", "enum_name"],
    ["ParticleEmitter", "Lifetime", { min: 0.5, max: 2 }, "number_range"],
  ] as const;

  for (const [className, propertyName, value, expectedKind] of cases) {
    const canonical = canonicalizeCreatorPropertyInput({
      className,
      propertyName,
      value,
      resolveReference: (reference) => ({
        identity: {
          kind: "forge_attribute",
          stableId: "objectId" in reference ? reference.objectId : reference.changeId,
        },
        path: "Workspace/AttachmentA",
        className: "Attachment",
      }),
    });
    assert.equal(canonical.kind, expectedKind, `${className}.${propertyName}`);
    if (expectedKind === "instance_ref")
      assert.equal(canonical.kind === "instance_ref" && canonical.state, "reference");
  }
  const nilReference = canonicalizeCreatorPropertyInput({
    className: "ObjectValue",
    propertyName: "Value",
    value: null,
  });
  assert.deepEqual(nilReference, {
    kind: "instance_ref",
    state: "nil",
    expectedClass: "Instance",
  });
  assert.deepEqual(
    canonicalizeCreatorPropertyInput({
      className: "Part",
      propertyName: "CustomPhysicalProperties",
      value: null,
    }),
    { kind: "nil", expectedCodec: "physical_properties" },
  );
  assert.equal(
    canonicalizeCreatorPropertyInput({
      className: "Beam",
      propertyName: "Attachment0",
      value: { changeId: "new-attachment" },
      resolveReference: (reference) => ({
        identity: {
          kind: "forge_attribute",
          stableId: "changeId" in reference ? reference.changeId : reference.objectId,
        },
        path: "Workspace/BeamAttachment",
        className: "Attachment",
      }),
    }).kind,
    "instance_ref",
  );
  assert.throws(
    () =>
      canonicalizeCreatorPropertyInput({
        className: "Part",
        propertyName: "Anchored",
        value: null,
      }),
    /does not declare a nullable value domain/i,
  );
  assert.throws(
    () =>
      canonicalizeCreatorPropertyInput({
        className: "Part",
        propertyName: "Material",
        value: "NotAMaterial",
      }),
    /allowlist|one of/i,
  );
  assert.throws(
    () =>
      canonicalizeCreatorPropertyInput({
        className: "Part",
        propertyName: "CollisionGroup",
        value: "",
      }),
    /UTF-8 byte minimum|string bound/i,
  );
});

test("text widgets accept the current FontFace property through the generated Font codec", () => {
  const value = {
    family: "rbxasset://fonts/families/BuilderSans.json",
    weight: "Regular",
    style: "Normal",
  };
  for (const className of ["TextLabel", "TextButton"] as const) {
    assert.deepEqual(
      canonicalizeCreatorPropertyInput({ className, propertyName: "FontFace", value }),
      { kind: "font", ...value },
    );
    assert.throws(
      () =>
        canonicalizeCreatorPropertyInput({ className, propertyName: "Font", value: "BuilderSans" }),
      /outside.*manifest/,
    );
  }
});

test("immutable build contracts validate their sealed policy rather than today's global manifest", () => {
  const propertyPolicy = {
    allowedProperties: [],
    attributes: "primitive" as const,
    source: "forbidden" as const,
  };
  const payload = {
    sessionId: "creator_session_policy_snapshot",
    promptHash: contentHash("prompt"),
    planId: "creator_plan_policy_snapshot",
    planHash: contentHash("plan"),
    planApprovalId: "creator_approval_policy_snapshot",
    planApprovalHash: contentHash("approval"),
    ownershipMapId: "studio_ownership_policy_snapshot",
    ownershipMapHash: contentHash("ownership"),
    sourceIndexId: "studio_source_index_policy_snapshot",
    sourceIndexHash: contentHash("source index"),
    sourceConsultationId: "creator_source_consultation_policy_snapshot",
    sourceConsultationHash: contentHash("source consultation"),
    mutationAuthority: "studio_document" as const,
    initialRevisionHash: contentHash("revision"),
    initialInspectionPaths: ["Workspace"],
    propertyPolicies: { Folder: propertyPolicy },
    changes: [
      {
        planChangeId: "create_folder",
        operationId: "creator_operation_policy_snapshot",
        kind: "create" as const,
        path: "Workspace/NewFolder",
        target: {
          kind: "instance" as const,
          identity: {
            kind: "forge_attribute" as const,
            stableId: "created-folder",
          },
          path: "Workspace/NewFolder",
          className: "Folder" as const,
        },
        parent: {
          kind: "engine_container" as const,
          path: "Workspace",
          className: "Workspace",
        },
        name: "NewFolder",
        className: "Folder" as const,
        tempId: "creator_temp_policy_snapshot",
        propertyPolicy,
      },
    ],
  };
  const hash = contentHash(stableJson(payload));
  assert.doesNotThrow(() =>
    assertCreatorBuildContract({
      kind: "CreatorBuildContract",
      id: `creator_build_contract_${hash.slice(0, 24)}`,
      hash,
      ...payload,
    }),
  );
});

test("builder checkpoints retain every read in a provider batch and a later failure while reusing staged source", async () => {
  const prompt = "Repair one ordinary shared module after consulting the API.";
  const ownership = createStudioOwnershipMap({
    projectId: "checkpoint-batch",
    revisionHash,
    projectIndex: observation,
  });
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const sources = sourceEvidence(observation, projectCaptureHash);
  const plan = createTestPlan(
    {
      sessionId: session.id,
      promptHash: session.promptHash,
      projectRevisionHash: revisionHash,
      projectCaptureHash,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      creatorPrompt: prompt,
      ...planSourceBinding(sources),
      inspectionPaths: [],
      steps: [
        { id: "module", statement: "Create the ordinary shared module.", changeIds: ["module"] },
      ],
      changes: [
        {
          id: "module",
          kind: "create",
          path: "Workspace/CheckpointModule",
          parent: { kind: "engine_container", path: "Workspace", className: "Workspace" },
          className: "ModuleScript",
          initialization: "inline_source_required",
        },
      ],
      charter: {
        clauses: [
          { id: "syntax", kind: "local_check", check: "luau_syntax" },
          {
            id: "module-exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "Workspace/CheckpointModule",
            expectedClass: "ModuleScript",
          },
        ],
      },
    },
    observation,
    ownership,
  );
  const builder = new CreatorBuilderToolHost({
    session,
    ownership,
    projectIndex: observation,
    plan,
    ...sources,
    planApproval: createCreatorApproval({
      sessionId: session.id,
      artifactKind: "plan",
      artifactId: plan.id,
      artifactHash: plan.hash,
      decision: "approved",
      decidedAt: "2026-09-05T12:00:00.000Z",
    }),
  });
  const source = "local checkpointSourceSentinel: string = 1\nreturn {}\n";
  const checkpoint = (body: {
    messages: Array<{
      role: string;
      content: string;
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    }>;
  }) => {
    const message = body.messages.find(
      (entry) => entry.role === "user" && entry.content.startsWith("<forge_semantic_checkpoint>"),
    );
    assert.ok(message);
    const exchanges = body.messages.filter((entry) =>
      entry.tool_calls?.some((call) => call.id === "initial-build"),
    );
    assert.equal(
      exchanges.length,
      1,
      "the exact latest executed assistant exchange is retained once",
    );
    assert.equal(exchanges[0]!.tool_calls!.length, 1);
    const buildCall = exchanges[0]!.tool_calls![0]!;
    assert.equal(buildCall.function.name, "studio_build");
    assert.deepEqual(JSON.parse(buildCall.function.arguments).sources, [
      { slotId: "module", source },
    ]);
    const result = body.messages[body.messages.indexOf(exchanges[0]!) + 1]!;
    assert.equal(result.role, "tool");
    assert.equal(result.tool_call_id, buildCall.id);
    assert.equal(body.messages.filter((entry) => entry.tool_call_id === buildCall.id).length, 1);
    const end = message.content.indexOf("\n</forge_semantic_checkpoint>");
    assert.ok(end > 0);
    return JSON.parse(message.content.slice("<forge_semantic_checkpoint>\n".length, end));
  };
  let requests = 0;
  let stagedOperationHash: string | undefined;
  const client = new OpenRouterModelClient({
    apiKey: "offline-key",
    fetchImpl: async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      let calls: Array<{ id: string; name: string; arguments: unknown }>;
      const reads = body.messages.filter(
        (entry: { role: string; tool_call_id?: string }) =>
          entry.role === "tool" && entry.tool_call_id !== "initial-build",
      );
      if (requests === 1) {
        calls = [
          {
            id: "initial-build",
            name: "studio_build",
            arguments: {
              sources: [{ slotId: "module", source }],
              values: [],
              summary: "Stage the module for local review.",
            },
          },
        ];
      } else if (requests === 2) {
        const state = checkpoint(body);
        assert.equal(builder.gate().status, "rejected");
        assert.deepEqual(
          state.latestBatch.map((entry: { toolCallId: string }) => entry.toolCallId),
          ["initial-build"],
        );
        assert.equal(state.operations.length, 1);
        assert.equal(state.operations[0].sourceHash, contentHash(source));
        stagedOperationHash = state.operations[0].operationHash;
        calls = [
          {
            id: "read-triggered",
            name: "studio_api_lookup",
            arguments: { ownerName: "ProximityPrompt", query: "Triggered", limit: 1 },
          },
          {
            id: "read-enabled",
            name: "studio_api_lookup",
            arguments: { ownerName: "ProximityPrompt", query: "Enabled", limit: 1 },
          },
        ];
      } else if (requests === 3) {
        const state = checkpoint(body);
        assert.deepEqual(
          reads.map((entry: { tool_call_id: string }) => entry.tool_call_id),
          ["read-triggered", "read-enabled"],
        );
        assert.deepEqual(
          reads.map((entry: { content: string }) => {
            const result = JSON.parse(entry.content);
            return { ok: result.ok, name: result.value.entries[0]?.name };
          }),
          [
            { ok: true, name: "Triggered" },
            { ok: true, name: "Enabled" },
          ],
        );
        assert.equal(state.operations[0].operationHash, stagedOperationHash);
        calls = [
          {
            id: "read-shown",
            name: "studio_api_lookup",
            arguments: { ownerName: "ProximityPrompt", query: "PromptShown", limit: 1 },
          },
        ];
      } else if (requests === 4) {
        checkpoint(body);
        assert.deepEqual(
          reads.map((entry: { tool_call_id: string }) => entry.tool_call_id),
          ["read-triggered", "read-enabled", "read-shown"],
        );
        // Both optional selector fields are omitted: schema-valid, but the
        // production lookup rejects the request during tool execution.
        calls = [{ id: "invalid-read", name: "studio_api_lookup", arguments: {} }];
      } else if (requests === 5) {
        const state = checkpoint(body);
        assert.deepEqual(
          reads.map((entry: { tool_call_id: string }) => entry.tool_call_id),
          ["read-triggered", "read-enabled", "read-shown", "invalid-read"],
        );
        const failure = JSON.parse(reads.at(-1).content);
        assert.equal(failure.ok, false);
        assert.equal(failure.error.code, "ROBLOX_API_LOOKUP_INVALID");
        assert.equal(state.operations[0].operationHash, stagedOperationHash);
        assert.equal(state.operations[0].sourceHash, contentHash(source));
        calls = [
          {
            id: "stale-repair",
            name: "studio_repair",
            arguments: {
              repairs: [
                {
                  kind: "source",
                  planChangeId: "module",
                  expectedSourceHash: contentHash("stale"),
                  edits: [{ startLine: 1, deleteCount: 2, replacement: "return {}\n" }],
                },
              ],
              summary: "Attempt a stale repair.",
            },
          },
        ];
      } else {
        assert.equal(requests, 6);
        const state = checkpoint(body);
        assert.deepEqual(
          reads.map((entry: { tool_call_id: string }) => entry.tool_call_id),
          ["read-triggered", "read-enabled", "read-shown", "invalid-read", "stale-repair"],
        );
        const failure = JSON.parse(reads.at(-1).content);
        assert.equal(failure.ok, false);
        assert.match(failure.error.message, /draft changed/);
        assert.equal(state.operations[0].operationHash, stagedOperationHash);
        calls = [
          {
            id: "repair-module",
            name: "studio_repair",
            arguments: {
              repairs: [
                {
                  kind: "source",
                  planChangeId: "module",
                  expectedSourceHash: contentHash(source),
                  edits: [{ startLine: 1, deleteCount: 2, replacement: "return { value = 1 }\n" }],
                },
              ],
              summary: "Corrected the module syntax.",
            },
          },
        ];
      }
      return new Response(
        JSON.stringify({
          id: `checkpoint-response-${requests}`,
          model: DEFAULT_CREATOR_MODEL_ID,
          provider: "OpenAI",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await new ForgeNativeAgentRuntime(client).run({
    systemPrompt: "Use the declared builder tools.",
    prompt,
    tools: builder,
    model: DEFAULT_CREATOR_MODEL_ID,
    budgets: { ...DEFAULT_AGENT_BUDGETS, maxTurns: 6 },
  });
  assert.equal(result.status, "completed", result.error);
  assert.equal(requests, 6);
  assert.equal(builder.gate().status, "eligible");
  assert.deepEqual(
    result.toolCalls.map((entry) => entry.toolCallId),
    [
      "initial-build",
      "read-triggered",
      "read-enabled",
      "read-shown",
      "invalid-read",
      "stale-repair",
      "repair-module",
    ],
  );
});

function diagnosticReviewBuilder() {
  const prompt = "Create an ordinary module and preserve its exact source diagnostics.";
  const ownership = createStudioOwnershipMap({
    projectId: "diagnostic-review",
    revisionHash,
    projectIndex: observation,
  });
  const session = createCreatorSession({
    prompt,
    projectId: ownership.projectId,
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const sources = sourceEvidence(observation, projectCaptureHash);
  const plan = createTestPlan(
    {
      sessionId: session.id,
      promptHash: session.promptHash,
      projectRevisionHash: revisionHash,
      projectCaptureHash,
      ownershipMapId: ownership.id,
      ownershipMapHash: ownership.hash,
      creatorPrompt: prompt,
      ...planSourceBinding(sources),
      inspectionPaths: [],
      steps: [{ id: "module", statement: prompt, changeIds: ["module"] }],
      changes: [
        {
          id: "module",
          kind: "create",
          path: "Workspace/DiagnosticModule",
          parent: { kind: "engine_container", path: "Workspace", className: "Workspace" },
          className: "ModuleScript",
          initialization: "inline_source_required",
        },
      ],
      charter: {
        clauses: [
          { id: "syntax", kind: "local_check", check: "luau_syntax" },
          {
            id: "module-exists",
            kind: "studio_check",
            check: "instance_exists",
            path: "Workspace/DiagnosticModule",
            expectedClass: "ModuleScript",
          },
        ],
      },
    },
    observation,
    ownership,
  );
  return new CreatorBuilderToolHost({
    session,
    ownership,
    projectIndex: observation,
    plan,
    ...sources,
    planApproval: createCreatorApproval({
      sessionId: session.id,
      artifactKind: "plan",
      artifactId: plan.id,
      artifactHash: plan.hash,
      decision: "approved",
      decidedAt: "2026-09-05T15:00:00.000Z",
    }),
  });
}

test("duplicate source diagnostics preserve a rejected review and unique graph evidence identities", async () => {
  const builder = diagnosticReviewBuilder();
  const before = builder.progressToken();
  const source =
    "local first = require(missing)\nlocal second = require(missing)\nreturn { first, second }\n";
  const result = await builder.execute("studio.build", {
    sources: [{ slotId: "module", source }],
    values: [],
    summary: "Review the module.",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const value = result.value as {
    review: { status: string; issues: Array<{ ruleId: string; count: number }> };
  };
  assert.equal(value.review.status, "rejected");
  assert.equal(
    value.review.issues.find((issue) => issue.ruleId === "game_import_dynamic_target")?.count,
    2,
    "Repeated source facts remain counted in the review",
  );
  assert.equal(builder.gate().issueHashes.length, new Set(builder.gate().issueHashes).size);
  assert.equal(builder.stagedSourceWriteBlobs()[0]?.manifest.sourceHash, contentHash(source));
  const checkpoint = builder.contextCheckpoint(
    [{ toolCallId: "build", name: "studio.build", result }],
    before,
  );
  assert.ok(checkpoint);
  assert.match(checkpoint, /game_import_dynamic_target/);
  assert.doesNotMatch(checkpoint, /Invalid graph local-check evidence bindings/);
  const repair = await builder.execute("studio.repair", {
    repairs: [
      {
        kind: "source",
        planChangeId: "module",
        expectedSourceHash: contentHash(source),
        edits: [{ startLine: 1, deleteCount: 3, replacement: "return {}\n" }],
      },
    ],
    summary: "Repair the source.",
  });
  assert.equal(repair.ok, true, JSON.stringify(repair));
  assert.equal(builder.gate().status, "eligible");
  assert.doesNotThrow(() => builder.sealedGraph());
});

test("a post-analysis graph failure retains actionable source review and repairable draft in the checkpoint", async (t) => {
  const builder = diagnosticReviewBuilder();
  const before = builder.progressToken();
  const source = "local value: string = 1\nreturn value\n";
  const graph = builder as unknown as { compileCurrentGraph(): unknown };
  const failure = t.mock.method(graph, "compileCurrentGraph", () => {
    throw new Error("Injected post-analysis graph fault");
  });
  const result = await builder.execute("studio.build", {
    sources: [{ slotId: "module", source }],
    values: [],
    summary: "Review source before graph binding.",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const value = result.value as {
    review: {
      status: string;
      issues: Array<{ ruleId: string; category: string; message: string }>;
    };
  };
  assert.equal(value.review.status, "incomplete");
  assert.ok(value.review.issues.some((issue) => issue.category === "language"));
  assert.ok(
    value.review.issues.some(
      (issue) =>
        issue.ruleId === "CREATOR_GAME_GRAPH_INVALID" &&
        issue.message === "Injected post-analysis graph fault",
    ),
  );
  assert.equal(builder.gate().status, "incomplete");
  assert.equal(builder.stagedSourceWriteBlobs()[0]?.manifest.sourceHash, contentHash(source));
  const checkpoint = builder.contextCheckpoint(
    [{ toolCallId: "build", name: "studio.build", result }],
    before,
  );
  assert.match(checkpoint ?? "", /CREATOR_GAME_GRAPH_INVALID/);
  assert.match(checkpoint ?? "", /language/);
  assert.throws(() => builder.sealedGraph());
  failure.mock.restore();
  const repair = await builder.execute("studio.repair", {
    repairs: [
      {
        kind: "source",
        planChangeId: "module",
        expectedSourceHash: contentHash(source),
        edits: [{ startLine: 1, deleteCount: 2, replacement: "return {}\n" }],
      },
    ],
    summary: "Repair the source after graph recovery.",
  });
  assert.equal(repair.ok, true, JSON.stringify(repair));
  assert.equal(builder.gate().status, "eligible");
});
