import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { GAME_SOURCE_CONTENT_SCHEMA, GAME_SOURCE_PLACEMENT_SCHEMA } from "./source.js";
import { GAME_VISUAL_DIRECTION_SCHEMA, validateGameVisualDirection } from "./visual-direction.js";
export { GAME_VISUAL_DIRECTION_SCHEMA, gameVisualReviewStatements } from "./visual-direction.js";
export type { GameVisualDirection } from "./visual-direction.js";
export type { GameSourceContent, GameSourcePlacement, GamePlacementParent } from "./source.js";
export { GAME_STUDIO_IDENTITY_SCHEMA } from "./source.js";
import {
  assertBoundedGameJson,
  compareGameStrings,
  entityId,
  GameAdmissionError,
  GAME_ADMISSION_POLICY_SCHEMA,
  hashSchema,
  type GameAdmissionPolicy,
} from "./primitives.js";
import {
  canonicalGamePorts,
  GAME_DATA_SCHEMA,
  GAME_OBLIGATION_SCHEMA,
  GAME_PORT_SCHEMA,
  uniqueGameIds,
  type GameObligation,
  type GamePort,
} from "./data-contracts.js";

export { DEFAULT_GAME_ADMISSION_POLICY, GameAdmissionError } from "./primitives.js";
export type { GameAdmissionPolicy, GameJsonValue } from "./primitives.js";
export type { GameDataSchema, GameObligation, GamePort } from "./data-contracts.js";

const FILE_REFERENCE_SCHEMA = z.object({ componentId: entityId, fileId: entityId }).strict();
const sourcePath = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*\.luau$/)
  .describe(
    "Relative source file path ending in .luau, e.g. Services/Interaction.luau. Editor placement belongs in placement; this is not a Roblox hierarchy path.",
  );
const SOURCE_FILE_SCHEMA = z
  .object({
    id: entityId,
    path: sourcePath,
    context: z.enum(["server", "client", "shared"]),
    role: z
      .enum(["module", "entrypoint"])
      .describe(
        "Per-file role. Entrypoints execute on server or client; shared files are modules.",
      ),
    content: GAME_SOURCE_CONTENT_SCHEMA,
    placement: GAME_SOURCE_PLACEMENT_SCHEMA.optional(),
    imports: z
      .array(FILE_REFERENCE_SCHEMA)
      .describe(
        "Approved upper bound of modules this file may require. Actual static imports must be a subset. Unused declarations are warnings and remain conservative build dependencies; they do not require module execution.",
      ),
  })
  .strict();
export const GAME_SOURCE_PACKAGE_SCHEMA = z
  .object({
    kind: z.literal("source_package"),
    id: entityId,
    files: z.array(SOURCE_FILE_SCHEMA).min(1),
    ports: z.array(
      z
        .object({
          id: entityId,
          direction: z.enum(["input", "output"]),
          schema: GAME_DATA_SCHEMA,
          fileId: entityId,
        })
        .strict(),
    ),
    obligations: z.array(GAME_OBLIGATION_SCHEMA),
  })
  .strict();
const DIRECT_COMPONENT_INTERFACE_FIELDS = {
  ports: z.array(GAME_PORT_SCHEMA),
  obligations: z.array(GAME_OBLIGATION_SCHEMA),
};
export const GAME_NATIVE_GRAPH_SCHEMA = z
  .object({
    kind: z.literal("native_graph"),
    id: entityId,
    graph: z.record(z.string(), z.unknown()),
    ...DIRECT_COMPONENT_INTERFACE_FIELDS,
  })
  .strict();
export const GAME_UI_GRAPH_SCHEMA = z
  .object({
    kind: z.literal("ui_graph"),
    id: entityId,
    ui: z.record(z.string(), z.unknown()),
    ...DIRECT_COMPONENT_INTERFACE_FIELDS,
  })
  .strict();
export const GAME_SCENE_HANDLE_COMPONENT_SCHEMA = z
  .object({
    kind: z.literal("scene_handle"),
    id: entityId,
    scene: z
      .object({ sceneId: entityId, revision: z.number().int().positive(), hash: hashSchema })
      .strict(),
    ...DIRECT_COMPONENT_INTERFACE_FIELDS,
  })
  .strict();
const PORT_REFERENCE_SCHEMA = z.object({ componentId: entityId, portId: entityId }).strict();

/** Creator-authored game concepts, tied to the implementation they describe. */
export const GAME_SEMANTIC_ARCHITECTURE_SCHEMA = z
  .object({
    name: z.string().min(1).max(160),
    icon: z.string().min(1).max(32).optional(),
    nodes: z
      .array(
        z
          .object({
            id: entityId,
            name: z.string().min(1).max(160),
            icon: z.string().min(1).max(32).optional(),
            description: z.string().min(1).max(2048),
            parentId: entityId.optional(),
            componentIds: z.array(entityId),
          })
          .strict(),
      )
      .min(1),
    relationships: z.array(
      z
        .object({ id: entityId, from: entityId, to: entityId, label: z.string().min(1).max(160) })
        .strict(),
    ),
  })
  .strict();
export type GameSemanticArchitecture = z.infer<typeof GAME_SEMANTIC_ARCHITECTURE_SCHEMA>;

const persistentWorldRoot = z
  .string()
  .min(11)
  .max(512)
  .regex(
    /^Workspace\/[^/\u0000-\u001f]+(?:\/[^/\u0000-\u001f]+)*$/u,
    "Persistent world roots must be exact descendant paths under Workspace",
  );

/** Explicit authoring boundary for the creator-visible three-dimensional world. */
export const GAME_WORLD_AUTHORING_SCHEMA = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("persistent"),
      roots: z
        .array(persistentWorldRoot)
        .min(1)
        .max(32)
        .describe(
          "Exact Workspace roots that contain the persistent, edit-mode world. Each root must exist in the compiled final topology and contain authored spatial geometry.",
        ),
    })
    .strict(),
  z
    .object({
      mode: z.literal("runtime_generated"),
      rationale: z
        .string()
        .min(24)
        .max(512)
        .describe(
          "Why the creator explicitly needs the primary world generated only while Play is running. Procedural geometry alone is not sufficient: Forge can compile procedural structure into persistent instances.",
        ),
    })
    .strict(),
  z.object({ mode: z.literal("none") }).strict(),
]);
export type GameWorldAuthoring = z.infer<typeof GAME_WORLD_AUTHORING_SCHEMA>;

/** Internal schema: callers must use validation so plain-JSON budgets run first. */
export const GAME_DESIGN_SPEC_SCHEMA = z
  .object({
    kind: z.literal("GameDesignSpec"),
    id: entityId,
    intent: z.string().min(1),
    worldAuthoring: GAME_WORLD_AUTHORING_SCHEMA.describe(
      "How the creator-visible 3D world is authored. Choose persistent for ordinary game scenes, runtime_generated only when the creator explicitly requests a Play-only generated world, and none when no 3D world is in scope.",
    ),
    architecture: GAME_SEMANTIC_ARCHITECTURE_SCHEMA.optional(),
    visualDirection: GAME_VISUAL_DIRECTION_SCHEMA.optional(),
    components: z
      .array(
        z.discriminatedUnion("kind", [
          GAME_SOURCE_PACKAGE_SCHEMA,
          GAME_NATIVE_GRAPH_SCHEMA,
          GAME_UI_GRAPH_SCHEMA,
          GAME_SCENE_HANDLE_COMPONENT_SCHEMA,
        ]),
      )
      .min(1),
    connections: z.array(
      z.object({ id: entityId, from: PORT_REFERENCE_SCHEMA, to: PORT_REFERENCE_SCHEMA }).strict(),
    ),
    artifactDependencies: z.array(z.object({ from: entityId, to: entityId }).strict()),
  })
  .strict();
type ParsedGameDesignSpec = z.infer<typeof GAME_DESIGN_SPEC_SCHEMA>;
export type GameSourcePackage = z.infer<typeof GAME_SOURCE_PACKAGE_SCHEMA>;
export type GameSourceFile = z.infer<typeof SOURCE_FILE_SCHEMA>;
export type GameNativeGraph = z.infer<typeof GAME_NATIVE_GRAPH_SCHEMA>;
export type GameUiGraph = z.infer<typeof GAME_UI_GRAPH_SCHEMA>;
export type GameSceneHandleComponent = z.infer<typeof GAME_SCENE_HANDLE_COMPONENT_SCHEMA>;
export type GameDesignSpec = ParsedGameDesignSpec;
export interface GameDesignDiagnostic {
  code: string;
  subject: string;
  detail: string;
}
export interface GameDesignObligation extends GameObligation {
  componentId: string;
}
export type GameDesignValidation =
  | {
      status: "eligible";
      scope: "composition_declarations";
      spec: GameDesignSpec;
      hash: string;
      obligations: GameDesignObligation[];
      limitations: string[];
    }
  | { status: "rejected"; diagnostics: GameDesignDiagnostic[] };

const LIMITATIONS = [
  "Source hashes, byte counts, imports, contexts and interfaces are declarations; source bytes have not been loaded or analyzed.",
  "Configuration and connection consistency do not establish runtime behavior, permissions, confinement, lifecycle cleanup or determinism.",
  "Composition admission grants no creator approval, editor mutation authority or Studio verification.",
];

/** Pure declaration admission. No candidate source or compiler code is executed. */
export function validateGameDesignSpec(
  input: unknown,
  options: {
    policy: GameAdmissionPolicy;
  },
): GameDesignValidation {
  try {
    const policy = GAME_ADMISSION_POLICY_SCHEMA.parse(options.policy);
    assertBoundedGameJson(input, policy);
    const parsed = GAME_DESIGN_SPEC_SCHEMA.safeParse(input);
    if (!parsed.success)
      return {
        status: "rejected",
        diagnostics: parsed.error.issues.map((issue) => ({
          code: "invalid_game_design",
          subject: issue.path.length ? issue.path.join(".") : "$",
          detail: issue.message,
        })),
      };
    // Plain JSON admission has already excluded undefined, callbacks and other non-JSON config values.
    const spec = parsed.data as GameDesignSpec;
    if (spec.worldAuthoring.mode === "persistent") {
      if (new Set(spec.worldAuthoring.roots).size !== spec.worldAuthoring.roots.length)
        throw new GameAdmissionError(
          "duplicate_world_root",
          spec.id,
          "Persistent world roots must be distinct",
        );
      spec.worldAuthoring.roots.sort(compareGameStrings);
    }
    if (
      spec.components.length > policy.maximumComponents ||
      spec.connections.length > policy.maximumConnections ||
      spec.artifactDependencies.length > policy.maximumArtifactDependencies
    )
      throw new GameAdmissionError(
        "resource_limit",
        spec.id,
        "Composition count exceeds admission policy",
      );
    uniqueGameIds(spec.components, "components");
    uniqueGameIds(spec.connections, "connections");
    const components = new Map(spec.components.map((component) => [component.id, component]));
    if (spec.visualDirection)
      validateGameVisualDirection(spec.visualDirection, new Set(components.keys()));
    if (spec.architecture) {
      const architecture = spec.architecture;
      if (
        architecture.nodes.length > policy.maximumComponents ||
        architecture.relationships.length > policy.maximumConnections
      )
        throw new GameAdmissionError(
          "resource_limit",
          "architecture",
          "Semantic architecture exceeds the active admission profile",
        );
      uniqueGameIds(architecture.nodes, "architecture.nodes");
      uniqueGameIds(architecture.relationships, "architecture.relationships");
      const nodes = new Map(architecture.nodes.map((node) => [node.id, node]));
      for (const node of architecture.nodes) {
        if (
          new Set(node.componentIds).size !== node.componentIds.length ||
          node.componentIds.some((id) => !components.has(id))
        )
          throw new GameAdmissionError(
            "invalid_architecture_implementation",
            node.id,
            "Semantic nodes must reference declared implementation components exactly once",
          );
        if (
          node.componentIds.length === 0 &&
          !architecture.nodes.some((child) => child.parentId === node.id)
        )
          throw new GameAdmissionError(
            "unbound_architecture_node",
            node.id,
            "A leaf game concept needs an implementation component",
          );
        const seen = new Set([node.id]);
        let parent = node.parentId;
        while (parent !== undefined) {
          if (seen.has(parent))
            throw new GameAdmissionError(
              "architecture_hierarchy_cycle",
              node.id,
              "Semantic grouping contains a cycle",
            );
          const ancestor = nodes.get(parent);
          if (!ancestor)
            throw new GameAdmissionError(
              "invalid_architecture_parent",
              node.id,
              "Semantic parent is undeclared",
            );
          seen.add(parent);
          parent = ancestor.parentId;
        }
        node.componentIds.sort(compareGameStrings);
      }
      for (const relationship of architecture.relationships)
        if (!nodes.has(relationship.from) || !nodes.has(relationship.to))
          throw new GameAdmissionError(
            "invalid_architecture_relationship",
            relationship.id,
            "Semantic relationship endpoints must be declared game concepts",
          );
      architecture.nodes.sort((a, b) => compareGameStrings(a.id, b.id));
      architecture.relationships.sort((a, b) => compareGameStrings(a.id, b.id));
    }
    const ports = new Map<string, GamePort>();
    const files = new Map<string, Pick<GameSourceFile, "role" | "context">>();
    const sourceEdges = new Map<string, Set<string>>();
    const artifactEdges = new Map(
      spec.components.map((component) => [component.id, new Set<string>()]),
    );
    const obligations: GameDesignObligation[] = [];
    let fileCount = 0;
    let sourceBytes = 0;

    for (const component of spec.components) {
      uniqueGameIds(component.obligations, component.id + ".obligations");
      const componentPorts = canonicalGamePorts(component.ports, policy);
      const componentObligations: GameObligation[] = component.obligations;
      if (component.kind === "source_package") {
        uniqueGameIds(component.files, component.id + ".files");
        const paths = new Set<string>();
        for (const file of component.files) {
          if (paths.has(file.path))
            throw new GameAdmissionError(
              "invalid_source_manifest",
              component.id,
              "Source paths must be unique within a package",
            );
          paths.add(file.path);
          if (
            file.placement?.kind === "observed" &&
            (file.content.kind !== "locked" ||
              file.role !== "module" ||
              file.placement.target.className !== "ModuleScript")
          )
            throw new GameAdmissionError(
              "invalid_source_manifest",
              component.id + "." + file.id,
              "Observed source placement requires a locked existing ModuleScript",
            );
          if (file.role === "entrypoint" && file.context === "shared")
            throw new GameAdmissionError(
              "invalid_source_manifest",
              component.id + "." + file.id,
              "Entrypoints must declare client or server execution; shared modules have separate per-context state",
            );
          const declaredBytes =
            file.content.kind === "locked" ? file.content.utf8Bytes : file.content.maximumUtf8Bytes;
          if (++fileCount > policy.maximumFiles || declaredBytes > policy.maximumFileSourceBytes)
            throw new GameAdmissionError(
              "resource_limit",
              component.id,
              "Declared source file budget exceeded",
            );
          sourceBytes += declaredBytes;
          if (!Number.isSafeInteger(sourceBytes) || sourceBytes > policy.maximumDeclaredSourceBytes)
            throw new GameAdmissionError(
              "resource_limit",
              component.id,
              "Aggregate declared source byte budget exceeded",
            );
          const key = fileKey(component.id, file.id);
          files.set(key, file);
          sourceEdges.set(key, new Set());
        }
        const fileIds = new Set(component.files.map((file) => file.id));
        for (const port of component.ports)
          if (!fileIds.has(port.fileId))
            throw new GameAdmissionError(
              "invalid_reference",
              component.id + "." + port.id,
              "Source port references an undeclared file",
            );
        component.ports = component.ports
          .map((port) => ({
            ...port,
            schema: componentPorts.find((candidate) => candidate.id === port.id)!.schema,
          }))
          .sort(byId);
        component.files = component.files
          .map((file) => ({
            ...file,
            imports: [...file.imports].sort((a, b) =>
              compareGameStrings(
                fileKey(a.componentId, a.fileId),
                fileKey(b.componentId, b.fileId),
              ),
            ),
          }))
          .sort(byId);
        component.obligations = [...component.obligations].sort(byId);
      } else {
        component.ports = componentPorts;
        component.obligations = [...component.obligations].sort(byId);
      }
      for (const port of componentPorts) ports.set(portKey(component.id, port.id), port);
      obligations.push(
        ...componentObligations.map((obligation) => ({ componentId: component.id, ...obligation })),
      );
    }
    // Approved import bounds are conservative source dependencies, not runtime event connections.
    for (const component of spec.components) {
      if (component.kind !== "source_package") continue;
      for (const file of component.files) {
        const fromKey = fileKey(component.id, file.id);
        for (const imported of file.imports) {
          const targetKey = fileKey(imported.componentId, imported.fileId);
          const target = files.get(targetKey);
          if (!target)
            throw new GameAdmissionError(
              "invalid_reference",
              fromKey,
              "Static import references an undeclared source file",
            );
          if (sourceEdges.get(fromKey)!.has(targetKey))
            throw new GameAdmissionError("duplicate_id", fromKey, "Duplicate static import");
          if (
            target.role !== "module" ||
            (target.context !== "shared" && target.context !== file.context)
          )
            throw new GameAdmissionError(
              "invalid_source_manifest",
              fromKey,
              "Static imports must target modules available in the declared execution context",
            );
          sourceEdges.get(fromKey)!.add(targetKey);
        }
      }
    }
    for (const edge of spec.artifactDependencies) {
      if (!components.has(edge.from) || !components.has(edge.to))
        throw new GameAdmissionError(
          "invalid_reference",
          "artifactDependencies",
          "Artifact dependency references an undeclared component",
        );
      if (artifactEdges.get(edge.from)!.has(edge.to))
        throw new GameAdmissionError(
          "duplicate_id",
          "artifactDependencies",
          "Duplicate artifact dependency",
        );
      artifactEdges.get(edge.from)!.add(edge.to);
    }
    assertDependencyDag(sourceEdges, "static imports");
    assertDependencyDag(artifactEdges, "artifactDependencies");

    for (const connection of spec.connections) {
      const from = ports.get(portKey(connection.from.componentId, connection.from.portId));
      const to = ports.get(portKey(connection.to.componentId, connection.to.portId));
      if (!from || !to)
        throw new GameAdmissionError(
          "invalid_reference",
          connection.id,
          "Connection references an undeclared port",
        );
      if (
        from.direction !== "output" ||
        to.direction !== "input" ||
        stableJson(from.schema) !== stableJson(to.schema)
      )
        throw new GameAdmissionError(
          "incompatible_connection",
          connection.id,
          "Connections require output-to-input direction and identical declared data contracts",
        );
    }
    spec.components.sort(byId);
    spec.connections.sort(byId);
    spec.artifactDependencies.sort(
      (a, b) => compareGameStrings(a.from, b.from) || compareGameStrings(a.to, b.to),
    );
    // Stable JSON also orders config object keys while preserving config array order.
    assertBoundedGameJson(spec, policy);
    const canonical = stableJson(spec);
    return {
      status: "eligible",
      scope: "composition_declarations",
      spec: JSON.parse(canonical) as GameDesignSpec,
      hash: contentHash(canonical),
      obligations: obligations.sort(
        (a, b) => compareGameStrings(a.componentId, b.componentId) || byId(a, b),
      ),
      limitations: [...LIMITATIONS],
    };
  } catch (error) {
    return {
      status: "rejected",
      diagnostics: [
        {
          code: error instanceof GameAdmissionError ? error.code : "invalid_game_design",
          subject: error instanceof GameAdmissionError ? error.subject : "$",
          detail:
            error instanceof GameAdmissionError
              ? error.message
              : "Composition or admission options are invalid",
        },
      ],
    };
  }
}

function byId(left: { id: string }, right: { id: string }): number {
  return compareGameStrings(left.id, right.id);
}
function fileKey(componentId: string, fileId: string): string {
  return componentId + "/" + fileId;
}
function portKey(componentId: string, portId: string): string {
  return componentId + "/" + portId;
}

/** Iterative elimination keeps validation bounded even for a long declared chain. */
function assertDependencyDag(
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  subject: string,
): void {
  const incoming = new Map([...edges.keys()].map((key) => [key, 0]));
  for (const targets of edges.values())
    for (const target of targets) incoming.set(target, incoming.get(target)! + 1);
  const ready = [...incoming].filter(([, count]) => count === 0).map(([key]) => key);
  let visited = 0;
  while (ready.length > 0) {
    const key = ready.pop()!;
    visited++;
    for (const target of edges.get(key)!) {
      const count = incoming.get(target)! - 1;
      incoming.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  if (visited !== edges.size)
    throw new GameAdmissionError(
      "dependency_cycle",
      subject,
      "Build/source dependency cycles are not admissible; runtime connection cycles are separate",
    );
}
