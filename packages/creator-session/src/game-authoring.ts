import { z } from "zod";
import { contentHash } from "../../contracts/src/index.js";
import {
  GAME_DESIGN_SPEC_SCHEMA,
  GAME_NATIVE_GRAPH_SCHEMA,
  GAME_SCENE_HANDLE_COMPONENT_SCHEMA,
  GAME_SOURCE_PACKAGE_SCHEMA,
  GAME_UI_GRAPH_SCHEMA,
  type GameDesignSpec,
} from "../../game-ir/src/index.js";
import {
  DEFAULT_GAME_ADMISSION_POLICY,
  entityId,
  hashSchema,
  type GameAdmissionPolicy,
} from "../../game-ir/src/primitives.js";
import { canonicalGameDataSchema } from "../../game-ir/src/data-contracts.js";
import {
  NATIVE_GRAPH_DECLARATION_SCHEMA,
  UI_CONTROLLER_SOURCE,
  UI_GRAPH_DECLARATION_SCHEMA,
} from "../../game-composition/src/index.js";
import { assertUiValid } from "../../game-composition/src/ui-validation.js";
import { CompositionError } from "../../game-composition/src/config-schema.js";
import { loadForgeRuntimeBundle } from "../../game-runtime/src/index.js";
import type { ApprovedSceneCompilationAuthorities } from "../../native-scene/src/index.js";
import {
  BLENDER_COMPILER_PROFILE,
  BLENDER_SCENE_DECLARATION_SCHEMA,
  BLENDER_SCENE_SPEC_ABI,
  VISUAL_WORLD_WORKFLOW_ABI,
  VISUAL_WORLD_WORKFLOW_EVENT_SCHEMA,
  blenderSceneSpecHandle,
  type BlenderSceneSpec,
} from "../../visual-world/src/index.js";
import {
  BLENDER_COMPILER_ABI,
  BLENDER_EXPORT_PROFILE,
  BLENDER_INSTALLATION_QUALIFICATION_ABI,
} from "../../blender-compiler/src/index.js";
import {
  STUDIO_CAPABILITY_MANIFEST,
  STUDIO_CAPABILITY_MANIFEST_HASH,
} from "../../studio-evidence/src/index.js";

export interface CreatorUtilitySourceInterface {
  id: string;
  fileId: string;
  context: "client" | "shared";
  sourceHash: string;
  utf8Bytes: number;
  studioPath: string;
  ports: readonly string[];
  obligations: readonly string[];
}

export interface CreatorGameCapabilities {
  kind: "CreatorGameCapabilities";
  compilerAbi: "forge-game-compiler@6";
  studioCapabilityManifestHash: string;
  componentKinds: readonly ["source_package", "native_graph", "ui_graph", "scene_handle"];
  declarationSchemas: {
    sourcePackage: object;
    nativeGraph: object;
    uiGraph: object;
    sceneHandle: object;
  };
  operationSchemas: {
    nativeGraphKinds: readonly ["studio_objects", "collections", "lighting"];
    sceneImport: "import_approved_scene@2";
  };
  visualWorld: {
    sceneAbi: typeof BLENDER_SCENE_SPEC_ABI;
    workflowAbi: typeof VISUAL_WORLD_WORKFLOW_ABI;
    compilerAbi: typeof BLENDER_COMPILER_ABI;
    compilerProfile: typeof BLENDER_COMPILER_PROFILE;
    exportProfile: typeof BLENDER_EXPORT_PROFILE;
    installationQualificationAbi: typeof BLENDER_INSTALLATION_QUALIFICATION_ABI;
    declarationSchema: object;
    workflowEventSchema: object;
    credentialModes: readonly ["oauth2", "api_key", "manual_studio_import"];
    sceneHandleReadiness: "eligible" | "incomplete";
    installationQualificationHash?: string;
  };
  utilitySources: CreatorUtilitySourceInterface[];
}

export interface CreatorGameEnvironment {
  capabilities: CreatorGameCapabilities;
  lockedSources: ReadonlyMap<string, string>;
  visualSceneAuthority: CreatorVisualSceneAuthority;
  validateComponent(component: GameDesignSpec["components"][number]): void;
}

export interface CreatorVisualSceneAuthority {
  resolve(scene: { sceneId: string; revision: number; hash: string }):
    | {
        readonly scene: BlenderSceneSpec;
        readonly authority: ApprovedSceneCompilationAuthorities;
      }
    | undefined;
}

export function resolveCreatorApprovedVisualScenes(
  design: GameDesignSpec,
  environment: CreatorGameEnvironment,
): Array<{
  componentId: string;
  scene: BlenderSceneSpec;
  authority: ApprovedSceneCompilationAuthorities;
}> {
  return design.components.flatMap((component) => {
    if (component.kind !== "scene_handle") return [];
    const approved = environment.visualSceneAuthority.resolve(component.scene);
    if (!approved)
      throw new Error(`Scene handle is unknown or no longer approved: ${component.id}`);
    const retainedHandle = blenderSceneSpecHandle(approved.scene);
    if (
      retainedHandle.sceneId !== component.scene.sceneId ||
      retainedHandle.revision !== component.scene.revision ||
      retainedHandle.hash !== component.scene.hash
    )
      throw new Error(`Scene handle is stale or ambiguously retained: ${component.id}`);
    return [{ componentId: component.id, scene: approved.scene, authority: approved.authority }];
  });
}

export function validateCreatorGameComponent(
  component: GameDesignSpec["components"][number],
): void {
  if (component.kind === "source_package") {
    const allowedEngineContainers = STUDIO_CAPABILITY_MANIFEST.authoringContainers.map(
      ({ className, path }) => ({ className, path }),
    );
    const issues = component.files.flatMap((file, index) => {
      const placement = file.placement;
      if (placement?.kind !== "create" || placement.parent.kind !== "engine_container") return [];
      const { className, path } = placement.parent;
      if (
        allowedEngineContainers.some(
          (entry) => entry.className === className && entry.path === path,
        )
      )
        return [];
      return [
        {
          code: "invalid_engine_container",
          fileId: file.id,
          path: `files[${index}].placement.parent`,
          actual: { className, path },
          expected: "one exact className/path pair from allowedEngineContainers",
        },
      ];
    });
    if (issues.length)
      throw new CompositionError(
        "invalid_source_placement",
        JSON.stringify({
          componentId: component.id,
          manifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
          issues,
          allowedEngineContainers,
        }),
      );
    return;
  }
  if (component.kind === "native_graph") {
    NATIVE_GRAPH_DECLARATION_SCHEMA.parse(component.graph);
    return;
  }
  if (component.kind === "ui_graph") {
    assertUiValid(UI_GRAPH_DECLARATION_SCHEMA.parse(component.ui), component.id);
    return;
  }
  GAME_SCENE_HANDLE_COMPONENT_SCHEMA.parse(component);
}

function creatorSourceFilesSchema() {
  const file = GAME_SOURCE_PACKAGE_SCHEMA.shape.files.element;
  const [observed, create, edit] = file.shape.placement.unwrap().options;
  const [instanceParent, engineParent, generatedParent, componentParent] =
    create.shape.parent.options;
  const createInput = create.omit({ className: true }).extend({
    parent: z.union([
      instanceParent,
      engineParent.omit({ className: true }).extend({
        path: z.enum(STUDIO_CAPABILITY_MANIFEST.authoringContainers.map(({ path }) => path)),
      }),
      generatedParent,
      componentParent,
    ]),
  });
  const installedFile = (
    role: "module" | "entrypoint",
    className: "ModuleScript" | "Script" | "LocalScript",
    context: z.ZodType<"server" | "client" | "shared"> = file.shape.context,
  ) =>
    file.extend({
      role: z.literal(role),
      context,
      placement: z.discriminatedUnion("kind", [
        createInput,
        edit.extend({ target: edit.shape.target.extend({ className: z.literal(className) }) }),
      ]),
    });
  return z
    .array(
      z.union([
        installedFile("module", "ModuleScript"),
        installedFile("entrypoint", "Script", z.enum(["server"])),
        installedFile("entrypoint", "LocalScript", z.enum(["client"])),
        file.extend({
          role: z.literal("module"),
          content: file.shape.content.options[0],
          placement: observed.extend({
            target: observed.shape.target.extend({ className: z.literal("ModuleScript") }),
          }),
        }),
      ]),
    )
    .min(1);
}

export function creatorGameComponentSchema() {
  return z.discriminatedUnion("kind", [
    GAME_SOURCE_PACKAGE_SCHEMA.extend({ files: creatorSourceFilesSchema() }),
    GAME_NATIVE_GRAPH_SCHEMA.extend({ graph: NATIVE_GRAPH_DECLARATION_SCHEMA }),
    GAME_UI_GRAPH_SCHEMA.extend({ ui: UI_GRAPH_DECLARATION_SCHEMA }),
    GAME_SCENE_HANDLE_COMPONENT_SCHEMA,
  ]);
}

export function creatorGameComponentEnvelopeSchema() {
  return creatorGameComponentSchema();
}

export type CreatorGameComponentInput = z.infer<ReturnType<typeof creatorGameComponentSchema>>;

export function resolveCreatorGameComponentInput(
  input: CreatorGameComponentInput,
  policy: GameAdmissionPolicy = DEFAULT_GAME_ADMISSION_POLICY,
): GameDesignSpec["components"][number] {
  if (input.kind !== "source_package") return structuredClone(input);
  return GAME_SOURCE_PACKAGE_SCHEMA.parse({
    ...input,
    ports: input.ports.map((port) => ({
      ...port,
      schema: canonicalGameDataSchema(port.schema, policy),
    })),
    files: input.files.map((file) => {
      const placement = file.placement;
      if (placement.kind !== "create") return file;
      const parent = placement.parent;
      const engineContainer =
        parent.kind === "engine_container"
          ? STUDIO_CAPABILITY_MANIFEST.authoringContainers.find(({ path }) => path === parent.path)
          : undefined;
      if (parent.kind === "engine_container" && !engineContainer)
        throw new CompositionError(
          "invalid_engine_container",
          `Unknown engine parent: ${parent.path}`,
        );
      return {
        ...file,
        placement: {
          ...placement,
          className:
            file.role === "module"
              ? "ModuleScript"
              : file.context === "server"
                ? "Script"
                : "LocalScript",
          parent: engineContainer ? { ...parent, className: engineContainer.className } : parent,
        },
      };
    }),
  });
}

export function projectCreatorGameComponentInput(
  component: GameDesignSpec["components"][number],
): CreatorGameComponentInput {
  if (component.kind !== "source_package")
    return structuredClone(component) as CreatorGameComponentInput;
  return {
    ...structuredClone(component),
    files: component.files.map((file) => {
      const placement = file.placement;
      if (placement?.kind !== "create") return structuredClone(file);
      const { className: _className, ...create } = placement;
      if (create.parent.kind !== "engine_container")
        return structuredClone({ ...file, placement: create });
      const { className: _parentClass, ...parent } = create.parent;
      return structuredClone({ ...file, placement: { ...create, parent } });
    }),
  } as CreatorGameComponentInput;
}

export const CREATOR_COMPONENT_REF_SCHEMA = z
  .object({ componentId: entityId, componentHash: hashSchema })
  .strict();
export type CreatorComponentRef = z.infer<typeof CREATOR_COMPONENT_REF_SCHEMA>;

export function creatorGameProposalDesignSchema() {
  return GAME_DESIGN_SPEC_SCHEMA.omit({ components: true }).extend({
    componentIds: z.array(entityId).min(1),
  });
}

export async function loadCreatorGameEnvironment(
  input: {
    visualSceneAuthority?: CreatorVisualSceneAuthority;
    installationQualificationHash?: string;
  } = {},
): Promise<CreatorGameEnvironment> {
  const runtime = await loadForgeRuntimeBundle();
  const utilitySources: CreatorUtilitySourceInterface[] = [
    ...runtime.modules.map((module) => ({
      id: "forge-runtime",
      fileId: module.id,
      context: "shared" as const,
      sourceHash: module.sourceHash,
      utf8Bytes: module.utf8Bytes,
      studioPath: module.path,
      ports: [],
      obligations: [],
    })),
    {
      id: "forge-ui-controller",
      fileId: "controller",
      context: "client",
      sourceHash: contentHash(UI_CONTROLLER_SOURCE),
      utf8Bytes: Buffer.byteLength(UI_CONTROLLER_SOURCE),
      studioPath: "ReplicatedStorage/ForgeUI/<componentId>/Controller",
      ports: ["screen-root", "primary-action"],
      obligations: [
        "Place the controller under the generated ScreenGui",
        "Bind declared responsive states and input actions through the ui_graph declaration",
      ],
    },
  ];
  return {
    capabilities: {
      kind: "CreatorGameCapabilities",
      compilerAbi: "forge-game-compiler@6",
      studioCapabilityManifestHash: STUDIO_CAPABILITY_MANIFEST_HASH,
      componentKinds: ["source_package", "native_graph", "ui_graph", "scene_handle"],
      declarationSchemas: {
        sourcePackage: z.toJSONSchema(GAME_SOURCE_PACKAGE_SCHEMA, { io: "input" }),
        nativeGraph: z.toJSONSchema(NATIVE_GRAPH_DECLARATION_SCHEMA, { io: "input" }),
        uiGraph: z.toJSONSchema(UI_GRAPH_DECLARATION_SCHEMA, { io: "input" }),
        sceneHandle: z.toJSONSchema(GAME_SCENE_HANDLE_COMPONENT_SCHEMA, { io: "input" }),
      },
      operationSchemas: {
        nativeGraphKinds: ["studio_objects", "collections", "lighting"],
        sceneImport: "import_approved_scene@2",
      },
      visualWorld: {
        sceneAbi: BLENDER_SCENE_SPEC_ABI,
        workflowAbi: VISUAL_WORLD_WORKFLOW_ABI,
        compilerAbi: BLENDER_COMPILER_ABI,
        compilerProfile: BLENDER_COMPILER_PROFILE,
        exportProfile: BLENDER_EXPORT_PROFILE,
        installationQualificationAbi: BLENDER_INSTALLATION_QUALIFICATION_ABI,
        declarationSchema: z.toJSONSchema(BLENDER_SCENE_DECLARATION_SCHEMA, { io: "input" }),
        workflowEventSchema: z.toJSONSchema(VISUAL_WORLD_WORKFLOW_EVENT_SCHEMA, { io: "output" }),
        credentialModes: ["oauth2", "api_key", "manual_studio_import"],
        sceneHandleReadiness: input.visualSceneAuthority ? "eligible" : "incomplete",
        ...(input.installationQualificationHash
          ? { installationQualificationHash: input.installationQualificationHash }
          : {}),
      },
      utilitySources,
    },
    validateComponent: validateCreatorGameComponent,
    visualSceneAuthority: input.visualSceneAuthority ?? { resolve: () => undefined },
    lockedSources: new Map([
      ...runtime.modules.map((module) => [module.sourceHash, module.source] as const),
      [contentHash(UI_CONTROLLER_SOURCE), UI_CONTROLLER_SOURCE],
    ]),
  };
}
