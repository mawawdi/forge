import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { RequirementView } from "../../semantic-authority/src/index.js";
import type { ProjectSemanticMap } from "../../semantic-map/src/index.js";

/** Source-free starting facts; source text is discovered through bounded tools. */
export interface AgentOrientation {
  kind: "AgentOrientation";
  schemaVersion: 1;
  id: string;
  policy: "source_free_project_facts_v1";
  requirementViewId: string;
  projectSnapshotHash: string;
  content: {
    projectId: string;
    files: Array<{ path: string; executionContext: string; sourceHash: string }>;
    remotes: Array<{ path: string; className: string; direction: string; clientScript: string; serverScript: string }>;
    instances: Array<{ id: string; path: string; className: string; position?: { x: number; y: number; z: number } }>;
    visibleRequirements: Array<{ id: string; statement: string; enforcement: string; verificationModes: string[] }>;
  };
  contentHash: string;
}

export function compileAgentOrientation(input: { semanticMap: ProjectSemanticMap; projectSnapshotHash: string; requirementView: RequirementView }): AgentOrientation {
  const visibleRequirements = input.requirementView.decisions
    .filter((decision): decision is Extract<typeof decision, { visible: true }> => decision.visible)
    .map((decision) => ({
      id: decision.requirement.id,
      statement: decision.requirement.statement,
      enforcement: decision.requirement.enforcement,
      verificationModes: [...decision.requirement.verificationModes]
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const content: AgentOrientation["content"] = {
    projectId: input.semanticMap.projectId,
    files: input.semanticMap.files.map((file) => ({ path: file.path, executionContext: file.executionContext, sourceHash: contentHash(file.source) })).sort((left, right) => left.path.localeCompare(right.path)),
    remotes: input.semanticMap.remotes.map((remote) => ({ path: remote.path, className: remote.className, direction: remote.direction, clientScript: remote.clientScript, serverScript: remote.serverScript })).sort((left, right) => left.path.localeCompare(right.path)),
    instances: input.semanticMap.instances.map((instance) => ({
      id: instance.id,
      path: instance.path,
      className: instance.className,
      ...(instance.position ? { position: { ...instance.position } } : {})
    })).sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id)),
    visibleRequirements
  };
  const contentHashValue = contentHash(stableJson(content));
  return {
    kind: "AgentOrientation",
    schemaVersion: 1,
    id: `agent_orientation_${contentHash(stableJson({ policy: "source_free_project_facts_v1", requirementViewId: input.requirementView.id, projectSnapshotHash: input.projectSnapshotHash, contentHash: contentHashValue })).slice(0, 24)}`,
    policy: "source_free_project_facts_v1",
    requirementViewId: input.requirementView.id,
    projectSnapshotHash: input.projectSnapshotHash,
    content,
    contentHash: contentHashValue
  };
}
