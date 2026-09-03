import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { RequirementView } from "../../semantic-authority/src/index.js";
import type { ProjectSemanticMap } from "../../semantic-map/src/index.js";
import type { StudioProjectIndexMetadataView } from "../../studio-evidence/src/index.js";

export type OrientationMode = "registered_experiment" | "creator_session";
export type CreatorProjectAuthority = "studio_document" | "rojo_source";

export interface AgentOrientation {
  kind: "AgentOrientation";
  id: string;
  policy: "mode_scoped_project_capabilities";
  mode: OrientationMode;
  requirementViewId?: string;
  projectSnapshotHash: string;
  content: ExperimentOrientationContent | CreatorOrientationContent;
  contentHash: string;
}

export interface ExperimentOrientationContent {
  mode: "registered_experiment";
  projectId: string;
  sourceRoots: string[];
  files: Array<{ path: string; executionContext: string; sourceHash: string }>;
  remotes: Array<{
    path: string;
    className: string;
    direction: string;
    clientScript: string;
    serverScript: string;
  }>;
  instances: Array<{
    id: string;
    path: string;
    className: string;
    position?: { x: number; y: number; z: number };
  }>;
  visibleRequirements: Array<{
    id: string;
    statement: string;
    enforcement: string;
    verificationModes: string[];
  }>;
}

export interface CreatorOrientationContent {
  mode: "creator_session";
  projectId: string;
  sourceRoots: [];
  project: StudioProjectIndexMetadataView["project"];
  revisionHash: string;
  /** The exact writer is derived from the sealed plan/change set, never from
   * the presence of an optional project-authority manifest. */
  writerSelection: "per_change_set";
  availableAuthorities: CreatorProjectAuthority[];
  /**
   * Deliberately bounded orientation. Exact instances and source are available
   * only through cursor-bound tools so large places do not become an implicit,
   * unreviewable model-context dump.
   */
  overview: {
    instanceCount: number;
    scriptCount: number;
    topLevelRoots: Array<{ path: string; descendantCount: number }>;
    classCounts: Array<{ className: string; count: number }>;
    omittedClassCount: number;
  };
  exploration: {
    projectTools: ["project.search", "project.children", "project.inspect"];
    sourceTools: [
      "source.search",
      "source.read",
      "source.symbols",
      "source.references",
      "source.dependencies",
    ];
    exactFactsRequireToolConsultation: true;
    cursorsBoundToRevision: true;
  };
  studioAuthoring: {
    available: boolean;
    writableOwner: "studio_document";
    allowedClasses: string[];
    resolvableClasses: string[];
    allowedOperations: Array<"create" | "update" | "move" | "delete" | "edit_source">;
    createInitialization: {
      scriptClasses: "inline_source_required";
      nonScriptClasses: "initial_properties";
    };
    writeSourceTargets: "initial_snapshot_scripts_only";
    createAndMoveParents: "must_exist_in_initial_snapshot_and_be_studio_writable";
    plannedInstancesMayParentPlannedInstances: false;
    machineChecks: Array<
      "instance_exists" | "position_series" | "playtest_diagnostics" | "subtree_unchanged"
    >;
    checkScopes: {
      instanceExists: "allowlisted_studio_roots";
      positionSeries: "Workspace_BasePart_only";
      subtreeUnchanged: "initial_snapshot_allowlisted_studio_roots";
    };
    machineCheckStatements: "forge_generated_from_typed_fields";
    arbitraryCodeExecution: false;
    genericPropertyAccess: false;
  };
}

export function compileAgentOrientation(input: {
  semanticMap: ProjectSemanticMap;
  projectSnapshotHash: string;
  requirementView: RequirementView;
  sourceRoots: readonly string[];
}): AgentOrientation {
  const visibleRequirements = input.requirementView.decisions
    .filter((decision): decision is Extract<typeof decision, { visible: true }> => decision.visible)
    .map((decision) => ({
      id: decision.requirement.id,
      statement: decision.requirement.statement,
      enforcement: decision.requirement.enforcement,
      verificationModes: [...decision.requirement.verificationModes],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const content: ExperimentOrientationContent = {
    mode: "registered_experiment",
    projectId: input.semanticMap.projectId,
    sourceRoots: canonicalSourceRoots(input.sourceRoots),
    files: input.semanticMap.files
      .map((file) => ({
        path: file.path,
        executionContext: file.executionContext,
        sourceHash: contentHash(file.source),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    remotes: input.semanticMap.remotes
      .map((remote) => ({
        path: remote.path,
        className: remote.className,
        direction: remote.direction,
        clientScript: remote.clientScript,
        serverScript: remote.serverScript,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    instances: input.semanticMap.instances
      .map((instance) => ({
        id: instance.id,
        path: instance.path,
        className: instance.className,
        ...(instance.position ? { position: { ...instance.position } } : {}),
      }))
      .sort(
        (left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id),
      ),
    visibleRequirements,
  };
  return orientation(
    "registered_experiment",
    input.projectSnapshotHash,
    content,
    input.requirementView.id,
  );
}

export function compileCreatorOrientation(input: {
  projectIndex: StudioProjectIndexMetadataView;
  revisionHash: string;
  projectId: string;
  availableAuthorities: readonly CreatorProjectAuthority[];
  ownership: ReadonlyMap<string, CreatorProjectAuthority>;
  allowedClasses: readonly string[];
  resolvableClasses: readonly string[];
}): AgentOrientation {
  const availableAuthorities = [...input.availableAuthorities].sort();
  if (
    availableAuthorities.length === 0 ||
    new Set(availableAuthorities).size !== availableAuthorities.length ||
    !availableAuthorities.every(
      (authority) => authority === "studio_document" || authority === "rojo_source",
    ) ||
    !availableAuthorities.includes("studio_document")
  )
    throw new Error("Creator orientation authority availability is invalid");
  const rootCounts = new Map<string, number>();
  const classCounts = new Map<string, number>();
  for (const instance of input.projectIndex.instances) {
    const root = instance.path.split("/")[0] ?? instance.path;
    rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
    classCounts.set(instance.className, (classCounts.get(instance.className) ?? 0) + 1);
  }
  const sortedClassCounts = [...classCounts]
    .map(([className, count]) => ({ className, count }))
    .sort(
      (left, right) => right.count - left.count || left.className.localeCompare(right.className),
    );
  const visibleClassCounts = sortedClassCounts.slice(0, 64);
  const content: CreatorOrientationContent = {
    mode: "creator_session",
    projectId: input.projectId,
    sourceRoots: [],
    project: { ...input.projectIndex.project },
    revisionHash: input.revisionHash,
    writerSelection: "per_change_set",
    availableAuthorities,
    overview: {
      instanceCount: input.projectIndex.instances.length,
      scriptCount: input.projectIndex.scripts.length,
      topLevelRoots: [...rootCounts]
        .map(([path, descendantCount]) => ({ path, descendantCount }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      classCounts: visibleClassCounts,
      omittedClassCount: sortedClassCounts.length - visibleClassCounts.length,
    },
    exploration: {
      projectTools: ["project.search", "project.children", "project.inspect"],
      sourceTools: [
        "source.search",
        "source.read",
        "source.symbols",
        "source.references",
        "source.dependencies",
      ],
      exactFactsRequireToolConsultation: true,
      cursorsBoundToRevision: true,
    },
    studioAuthoring: {
      available: availableAuthorities.includes("studio_document"),
      writableOwner: "studio_document",
      allowedClasses: [...input.allowedClasses].sort(),
      resolvableClasses: [...input.resolvableClasses].sort(),
      allowedOperations: ["create", "update", "move", "delete", "edit_source"],
      createInitialization: {
        scriptClasses: "inline_source_required",
        nonScriptClasses: "initial_properties",
      },
      writeSourceTargets: "initial_snapshot_scripts_only",
      createAndMoveParents: "must_exist_in_initial_snapshot_and_be_studio_writable",
      plannedInstancesMayParentPlannedInstances: false,
      machineChecks: [
        "instance_exists",
        "playtest_diagnostics",
        "position_series",
        "subtree_unchanged",
      ],
      checkScopes: {
        instanceExists: "allowlisted_studio_roots",
        positionSeries: "Workspace_BasePart_only",
        subtreeUnchanged: "initial_snapshot_allowlisted_studio_roots",
      },
      machineCheckStatements: "forge_generated_from_typed_fields",
      arbitraryCodeExecution: false,
      genericPropertyAccess: false,
    },
  };
  return orientation("creator_session", input.revisionHash, content);
}

function orientation(
  mode: OrientationMode,
  projectSnapshotHash: string,
  content: AgentOrientation["content"],
  requirementViewId?: string,
): AgentOrientation {
  const contentHashValue = contentHash(stableJson(content));
  const identity = contentHash(
    stableJson({
      policy: "mode_scoped_project_capabilities",
      mode,
      ...(requirementViewId ? { requirementViewId } : {}),
      projectSnapshotHash,
      contentHash: contentHashValue,
    }),
  );
  return {
    kind: "AgentOrientation",
    id: `agent_orientation_${identity.slice(0, 24)}`,
    policy: "mode_scoped_project_capabilities",
    mode,
    ...(requirementViewId ? { requirementViewId } : {}),
    projectSnapshotHash,
    content,
    contentHash: contentHashValue,
  };
}

function canonicalSourceRoots(sourceRoots: readonly string[]): string[] {
  const roots = [...sourceRoots];
  if (!roots.every(isCanonicalRelativeRoot))
    throw new Error("AgentOrientation source roots must be canonical candidate-relative paths");
  roots.sort((left, right) => left.localeCompare(right));
  if (roots.some((root, index) => index > 0 && root === roots[index - 1]))
    throw new Error("AgentOrientation source roots must be unique");
  return roots;
}

function isCanonicalRelativeRoot(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !value.startsWith("/") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}
