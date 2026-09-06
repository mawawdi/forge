import { contentHash, stableJson } from "../../packages/contracts/src/index.js";
import {
  createCreatorPlan,
  createCreatorSession,
  createStudioOwnershipMap,
} from "../../packages/creator-session/src/index.js";
import type { CreatorGameCatalog } from "../../packages/creator-session/src/game-authoring.js";
import {
  compileGamePlan,
  expandGameDesign,
  gameGeneratedTarget,
  type GameInventoryItem,
} from "../../packages/game-compiler/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
  type GameRecipeDefinition,
} from "../../packages/game-ir/src/index.js";
import {
  createPinnedLuauLspSourceIndex,
  SourceConsultationRecorder,
} from "../../packages/source-intelligence/src/index.js";
import {
  CREATOR_DEFAULT_RESOURCE_POLICY,
  STUDIO_CAPABILITY_MANIFEST_HASH,
  createStudioProjectIndexProjection,
  createStudioProjectEvidenceShard,
  createStudioProjectIndexCapture,
  createStudioSourceBlobCapture,
  studioProjectIndexMetadataView,
  studioProjectIndexSourceDocuments,
  type StudioProjectIndexCapture,
  type StudioProjectIndexNode,
  type StudioObjectIdentity,
} from "../../packages/studio-evidence/src/index.js";
import { createTestFixtureSourceResolver } from "./source-fixtures.js";
import { completeProjectProperties } from "./studio-project-fixtures.js";

export function recompilationCapture(
  options: {
    epoch?: string;
    source?: string;
    editorSource?: boolean;
    stableId?: string;
    attribute?: number;
    tag?: string;
    partName?: string;
    sourceName?: string;
    referenceTarget?: "first" | "second";
    duplicatePath?: boolean;
    sourceIdentity?: StudioObjectIdentity;
  } = {},
): StudioProjectIndexCapture {
  const epoch = options.epoch ?? "epoch-before";
  const identity = (name: string): StudioObjectIdentity => ({
    kind: "studio_ephemeral",
    connectorEpoch: epoch,
    opaqueHash: contentHash(epoch + name),
  });
  const node = (
    path: string,
    className: string,
    extra: Partial<StudioProjectIndexNode> = {},
  ): StudioProjectIndexNode => {
    const properties = completeProjectProperties(className);
    return {
      identity: identity(path),
      displayPath: path,
      name: path.split("/").at(-1)!,
      className,
      ...(path === "Workspace"
        ? { engineContainer: { path, className } }
        : { parentIdentity: identity("Workspace") }),
      attributes: {},
      tags: [],
      coveredProperties: properties,
      coveredPropertyNames: Object.keys(properties),
      ...extra,
    };
  };
  const first = node("Workspace/" + (options.partName ?? "First"), "Part", {
    attributes: { Weight: options.attribute ?? 0 },
    tags: [options.tag ?? "structural"],
  });
  const second = node(options.duplicatePath ? first.displayPath : "Workspace/Second", "Part", {
    identity: { kind: "forge_attribute", stableId: options.stableId ?? "second-part" },
  });
  const selected = options.referenceTarget === "second" ? second : first;
  const model = node("Workspace/Observed", "Model", {
    coveredProperties: completeProjectProperties("Model", {
      PrimaryPart: {
        kind: "instance_ref",
        state: "reference",
        identity: selected.identity,
        path: selected.displayPath,
        className: selected.className,
        expectedClass: "BasePart",
      },
    }),
  });
  const sourceNode = node(
    "Workspace/" + (options.sourceName ?? "ObservedModule"),
    "ModuleScript",
    options.sourceIdentity === undefined ? {} : { identity: options.sourceIdentity },
  );
  const source = createStudioSourceBlobCapture({
    identity: sourceNode.identity,
    source: options.source ?? "return { value = 1 }\n",
    editorSource: options.editorSource ?? false,
  });
  return createStudioProjectIndexCapture({
    projection: createStudioProjectIndexProjection({
      manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      project: { name: "Recompilation fixture", placeId: 0, universeId: 0 },
      connectorEpoch: epoch,
      purpose: "creator_project_index",
      roots: ["Workspace"],
      bounds: CREATOR_DEFAULT_RESOURCE_POLICY,
    }),
    shards: [
      createStudioProjectEvidenceShard({
        root: "Workspace",
        ordinal: 0,
        nodes: [
          node("Workspace", "Workspace"),
          first,
          second,
          model,
          { ...sourceNode, sourceManifestHash: source.manifest.hash },
        ],
      }),
    ],
    sourceManifests: [source.manifest],
    sourceChunks: source.chunks,
    detectorEpoch: epoch === "epoch-before" ? 0 : 1,
    completedAt: "2026-09-06T12:00:00.000Z",
  });
}

export function recompilationSession(
  capture: StudioProjectIndexCapture,
  prompt: string,
  projectId = "recompilation-fixture",
) {
  const observation = studioProjectIndexMetadataView(capture);
  const ownership = createStudioOwnershipMap({
    projectId,
    revisionHash: capture.revision.hash,
    projectIndex: observation,
  });
  const session = createCreatorSession({
    projectId,
    prompt,
    revisionHash: capture.revision.hash,
    projectCaptureHash: capture.hash,
    ownership,
  });
  const documents = studioProjectIndexSourceDocuments(capture);
  const sourceIndex = createPinnedLuauLspSourceIndex(
    { snapshotHash: capture.hash, documents },
    { symbols: [], references: [] },
    {
      analysisConfigHash: contentHash("config"),
      pinnedToolchainProof: {
        hash: contentHash("proof"),
        lockHash: contentHash("lock"),
        platform: "test",
      },
      sourcemapHash: contentHash("sourcemap"),
    },
    { maximumStaticDependencyRows: 1024 },
  );
  const recorder = new SourceConsultationRecorder(
    sourceIndex,
    createTestFixtureSourceResolver(documents),
  );
  return {
    session,
    ownership,
    sourceIndex,
    sourceConsultation: recorder.seal(),
    recorder,
    observation,
  };
}

export function creatorPlanRecompilationFixture(
  options: {
    observedParent?: boolean;
    observedReference?: boolean;
    lockedSource?: boolean;
    sourceObservedParent?: boolean;
    observedSource?: boolean;
  } = {},
) {
  const beforeCapture = recompilationCapture();
  const afterCapture = recompilationCapture({ epoch: "epoch-after" });
  const creatorPrompt = "Compose a generic nested object graph and a source interface.";
  const previous = recompilationSession(beforeCapture, creatorPrompt);
  const current = recompilationSession(afterCapture, creatorPrompt);
  const definition: GameRecipeDefinition = {
    kind: "GameRecipeDefinition",
    id: "recompilation-fixture",
    abi: "1",
    sourceExports: [],
    ports: [],
    obligations: [],
    configSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  };
  const lock = gameRecipeDefinitionLock(definition);
  const expander = {
    definition: lock,
    expand({ projectId }: { projectId: string }): GameInventoryItem[] {
      const base = {
        componentId: "objects",
        lockedProperties: {},
        valueSlots: [],
        attributes: {},
        removedAttributes: [],
        dependencies: [],
      };
      const parent = options.observedParent
        ? {
            kind: "instance" as const,
            identity: previous.observation.instances[0]!.identity,
            path: previous.observation.instances[0]!.path,
            className: previous.observation.instances[0]!.className,
          }
        : { kind: "engine_container" as const, path: "Workspace", className: "Workspace" };
      const root = {
        id: "new-root",
        kind: "create" as const,
        path: parent.path + "/NewRoot",
        parent,
        className: "Model" as const,
        initialization: "initial_properties" as const,
      };
      const child = gameGeneratedTarget({
        projectId,
        operationId: "new-child",
        path: root.path + "/Child",
        className: "Part",
      });
      const observed = previous.observation.instances.find(
        (instance) => instance.path === "Workspace/First",
      )!;
      const reference = options.observedReference ? observed : child;
      return [
        {
          ...base,
          id: root.id,
          change: root,
          lockedProperties: {
            PrimaryPart: {
              kind: "instance_ref",
              state: "reference",
              identity: reference.identity,
              path: reference.path,
              className: reference.className,
              expectedClass: "BasePart",
            },
          },
        },
        {
          ...base,
          id: "new-child",
          dependencies: [root.id],
          change: {
            id: "new-child",
            kind: "create",
            path: child.path,
            className: "Part",
            initialization: "initial_properties",
            parent: gameGeneratedTarget({
              projectId,
              operationId: root.id,
              path: root.path,
              className: "Model",
            }),
          },
        },
      ];
    },
  };
  const lockedText = options.observedSource ? "return { value = 1 }\n" : "return {}\n";
  const observedModule = previous.observation.instances.find(
    (instance) => instance.path === "Workspace/ObservedModule",
  )!;
  const observedRoot = previous.observation.instances.find(
    (instance) => instance.path === "Workspace",
  )!;
  const catalog: CreatorGameCatalog = {
    definitions: [definition],
    registry: createGameDefinitionRegistry([definition]),
    expanders: [expander],
    lockedSources: new Map([[contentHash(lockedText), lockedText]]),
  };
  const design = {
    kind: "GameDesignSpec" as const,
    worldAuthoring: { mode: "none" } as const,
    id: "generic",
    intent: creatorPrompt,
    components: [
      { kind: "recipe_instance" as const, id: "objects", definition: lock, config: {} },
      {
        kind: "source_package" as const,
        id: "logic",
        files: [
          {
            id: "module",
            path: "Module.luau",
            context: "shared" as const,
            role: "module" as const,
            content:
              options.lockedSource || options.observedSource
                ? {
                    kind: "locked" as const,
                    sourceHash: contentHash(lockedText),
                    utf8Bytes: Buffer.byteLength(lockedText),
                  }
                : { kind: "slot" as const, maximumUtf8Bytes: 4096 },
            placement: options.observedSource
              ? {
                  kind: "observed" as const,
                  target: {
                    kind: "instance" as const,
                    identity: observedModule.identity,
                    path: observedModule.path,
                    className: observedModule.className,
                  },
                }
              : {
                  operationId: "new-module",
                  kind: "create" as const,
                  parent: options.sourceObservedParent
                    ? {
                        kind: "instance" as const,
                        identity: observedRoot.identity,
                        path: observedRoot.path,
                        className: observedRoot.className,
                      }
                    : { kind: "generated" as const, operationId: "new-root" },
                  name: "Module",
                  className: "ModuleScript" as const,
                },
            imports: [],
          },
        ],
        ports: [],
        obligations: [],
      },
    ],
    connections: [],
    artifactDependencies: [],
  };
  const compilerInput = {
    design,
    registry: catalog.registry,
    projectId: previous.session.projectId,
    project: previous.observation.project,
    initialTopology: previous.observation.instances,
    observation: previous.observation,
    recipeExpanders: catalog.expanders,
  };
  const expanded = expandGameDesign(compilerInput);
  const compiled = compileGamePlan({
    ...compilerInput,
    ...expanded,
    sessionId: previous.session.id,
    observedRevisionHash: beforeCapture.revision.hash,
  });
  const previousPlan = createCreatorPlan(
    {
      sessionId: previous.session.id,
      promptHash: previous.session.promptHash,
      creatorPrompt,
      projectRevisionHash: beforeCapture.revision.hash,
      projectCaptureHash: beforeCapture.hash,
      ownershipMapId: previous.ownership.id,
      ownershipMapHash: previous.ownership.hash,
      sourceIndex: previous.sourceIndex,
      sourceConsultation: previous.sourceConsultation,
      compiled,
      changes: compiled.inventory.map((item) => item.change),
      inspectionPaths: ["Workspace"],
      steps: [
        {
          id: "compose",
          statement: "Create the declared graph and module.",
          changeIds: compiled.inventory.map((item) => item.id),
        },
      ],
      charter: {
        clauses: [
          { id: "syntax", kind: "local_check", check: "luau_syntax" },
          ...compiled.inventory.map((item, index) => ({
            id: "exists-" + index,
            kind: "studio_check" as const,
            check: "instance_exists" as const,
            path: item.change.kind === "create" ? item.change.path : "",
            expectedClass:
              item.change.kind === "create" ? item.change.className : ("Folder" as const),
          })),
          { id: "review", kind: "creator_review", statement: "Review the composition." },
        ],
      },
    },
    previous.observation,
    previous.ownership,
  );
  const bytes = stableJson(previousPlan) + "\n";
  const artifactHash = contentHash(bytes);
  return {
    previousPlan,
    predecessorPlan: {
      artifactHash,
      bytes: Buffer.byteLength(bytes),
      locator: `artifacts/${artifactHash}.json`,
    },
    beforeCapture,
    afterCapture,
    ...current,
    creatorPrompt,
    catalog,
    previous,
  };
}
