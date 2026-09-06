import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  CreatorPlannerToolHost,
  createCreatorSession,
  createStudioOwnershipMap,
  creatorOrientation,
  type CreatorProjectIndexView,
} from "../packages/creator-session/src/index.js";
import type { CreatorGameCatalog } from "../packages/creator-session/src/game-authoring.js";
import {
  STUDIO_PATCH_DEFINITION,
  STUDIO_PATCH_EXPANDER,
} from "../packages/game-composition/src/index.js";
import {
  createGameDefinitionRegistry,
  gameRecipeDefinitionLock,
} from "../packages/game-ir/src/index.js";
import { createPinnedLuauLspSourceIndex } from "../packages/source-intelligence/src/index.js";
import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";

const revisionHash = contentHash("optional-checks-observation");
const projectCaptureHash = contentHash("optional-checks-capture");
const workspaceIdentity = { kind: "forge_attribute", stableId: "workspace" } as const;
const projectIndex: CreatorProjectIndexView = {
  project: { name: "Optional checks", placeId: 0, universeId: 0 },
  revision: { hash: revisionHash } as CreatorProjectIndexView["revision"],
  instances: [
    {
      objectId: "forge_attribute:workspace",
      identity: workspaceIdentity,
      path: "Workspace",
      name: "Workspace",
      className: "Workspace",
      engineContainer: { path: "Workspace", className: "Workspace" },
      properties: {},
      attributes: {},
      tags: [],
    },
    ...[
      { id: "existing", name: "Existing", className: "Folder" },
      { id: "terrain", name: "Terrain", className: "Terrain" },
    ].map((entry) => ({
      objectId: `forge_attribute:${entry.id}`,
      identity: { kind: "forge_attribute" as const, stableId: entry.id },
      parentIdentity: workspaceIdentity,
      path: `Workspace/${entry.name}`,
      name: entry.name,
      className: entry.className,
      properties: {},
      attributes: {},
      tags: [],
    })),
  ],
  scripts: [],
};
const catalog: CreatorGameCatalog = {
  definitions: [STUDIO_PATCH_DEFINITION],
  registry: createGameDefinitionRegistry([STUDIO_PATCH_DEFINITION]),
  expanders: [STUDIO_PATCH_EXPANDER],
  lockedSources: new Map(),
};

function fixture() {
  const ownership = createStudioOwnershipMap({
    projectId: "optional-checks",
    revisionHash,
    projectIndex,
  });
  const session = createCreatorSession({
    projectId: ownership.projectId,
    prompt: "Create two nested folders.",
    revisionHash,
    projectCaptureHash,
    ownership,
  });
  const sourceIndex = createPinnedLuauLspSourceIndex(
    { snapshotHash: projectCaptureHash, documents: [] },
    { symbols: [], references: [] },
    {
      analysisConfigHash: contentHash("empty-fixture-analysis"),
      pinnedToolchainProof: {
        hash: contentHash("empty-fixture-proof"),
        lockHash: contentHash("empty-fixture-lock"),
        platform: "test",
      },
      sourcemapHash: contentHash("empty-fixture-sourcemap"),
    },
    { maximumStaticDependencyRows: 1024 },
  );
  const host = new CreatorPlannerToolHost({
    session,
    ownership,
    projectIndex,
    prompt: "Create two nested folders.",
    catalog,
    sourceIndex,
    sourceResolver: createTestFixtureSourceResolver([]),
  });
  return { host, session, ownership };
}

async function prepare(host: CreatorPlannerToolHost, parent = { kind: "engine", id: "Workspace" }) {
  const inspected = await host.execute("project.inspect", {
    objectIds: projectIndex.instances.map((entry) => entry.objectId),
  });
  assert.equal(inspected.ok, true, JSON.stringify(inspected.error));
  const component = await host.execute("creator.define_component", {
    component: {
      kind: "recipe_instance",
      id: "folders",
      definition: gameRecipeDefinitionLock(STUDIO_PATCH_DEFINITION),
      config: {
        operations: [
          { id: "outer", name: "NewFolder", parent },
          { id: "inner", name: "Nested", parent: { kind: "generated", id: "outer" } },
        ].map((entry) => ({
          ...entry,
          kind: "create",
          className: "Folder",
          properties: [],
          valueSlots: [],
          attributes: [],
          removedAttributes: [],
          dependencies: [],
        })),
      },
    },
  });
  assert.equal(component.ok, true, JSON.stringify(component.error));
  return {
    inspectionObjectIds: ["forge_attribute:workspace", "forge_attribute:existing"],
    steps: [
      {
        title: "Create the nested folder structure",
        details:
          "Add both declared folders in dependency order so the inner folder is created beneath its new parent.",
        componentIds: [(component.value as { componentId: string }).componentId],
      },
    ],
    design: {
      kind: "GameDesignSpec",
      worldAuthoring: { mode: "none" },
      id: "nested-folders",
      intent: "Create two nested folders.",
      componentIds: [(component.value as { componentId: string }).componentId],
      connections: [],
      artifactDependencies: [],
    },
  };
}

test("visual direction becomes creator review in the accepted-plan path without fabricating machine checks", async () => {
  const { host } = fixture();
  const proposal = await prepare(host);
  const result = await host.execute("creator.propose_plan", {
    ...proposal,
    checks: [],
    design: {
      ...proposal.design,
      visualDirection: {
        artDirection: "An open composition with clear visual hierarchy.",
        views: [
          {
            id: "overview",
            name: "Overview",
            componentIds: ["folders"],
            setup: "Inspect the opened project.",
            criteria: ["The intended composition is readable."],
          },
        ],
      },
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const outcome = host.getOutcome();
  assert.ok(outcome?.kind === "plan_proposed");
  assert.equal(outcome.plan.compiled.design.visualDirection?.views[0]?.id, "overview");
  assert.deepEqual(outcome.plan.steps, [
    {
      id: "plan-step-1",
      statement:
        "Create the nested folder structure: Add both declared folders in dependency order so the inner folder is created beneath its new parent.",
      changeIds: outcome.plan.changes.map((change) => change.id),
    },
  ]);
  assert.ok(
    outcome.plan.charter.clauses.some(
      (clause) =>
        clause.kind === "creator_review" &&
        clause.statement.includes("intended composition is readable"),
    ),
  );
});

test("proposal schema removes free-form reviews and rejects shallow multi-component plans", async () => {
  const { host } = fixture();
  const definition = host.definitions().find((entry) => entry.name === "creator.propose_plan")!;
  const schema = definition.schema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.equal(schema.properties.reviews, undefined);
  assert.ok(schema.required.includes("steps"));

  const componentIds: string[] = [];
  for (let index = 1; index <= 3; index++) {
    const component = await host.execute("creator.define_component", {
      component: {
        kind: "recipe_instance",
        id: `area-${index}`,
        definition: gameRecipeDefinitionLock(STUDIO_PATCH_DEFINITION),
        config: {
          operations: [
            {
              id: "folder",
              kind: "create",
              className: "Folder",
              name: `Area${index}`,
              parent: { kind: "engine", id: "Workspace" },
              properties: [],
              valueSlots: [],
              attributes: [],
              removedAttributes: [],
              dependencies: [],
            },
          ],
        },
      },
    });
    assert.equal(component.ok, true, JSON.stringify(component.error));
    componentIds.push((component.value as { componentId: string }).componentId);
  }
  const result = await host.execute("creator.propose_plan", {
    inspectionObjectIds: [],
    steps: [
      {
        title: "Build every gameplay area",
        details:
          "Create all three declared areas and arrange their editor outputs as one broad implementation task.",
        componentIds,
      },
    ],
    design: {
      kind: "GameDesignSpec",
      worldAuthoring: { mode: "none" },
      id: "three-areas",
      intent: "Create three distinct gameplay areas.",
      componentIds,
      connections: [],
      artifactDependencies: [],
    },
    checks: [],
  });
  assert.equal(result.error?.code, "PLAN_STEPS_INVALID");
  assert.match(result.error!.message, /PLAN_STEPS_TOO_SHALLOW/);
  assert.equal(host.getOutcome(), undefined);
});

test("creator orientation describes compiled parents without granting engine-container checks", () => {
  const { session, ownership } = fixture();
  const orientation = creatorOrientation({ session, ownership, projectIndex });
  assert.equal(orientation.content.mode, "creator_session");
  if (orientation.content.mode !== "creator_session") return;
  const authoring = orientation.content.studioAuthoring;
  assert.deepEqual(authoring.createAndMoveParents, {
    existing: "observed_studio_writable_instances_or_manifest_engine_containers",
    generated: "exact_parent_instances_in_compiled_inventory",
    componentOutputs: "declared_component_output_aliases_resolved_before_approval",
    validation: "exact_identity_class_path_and_acyclic_dependency_order",
  });
  assert.equal("plannedInstancesMayParentPlannedInstances" in authoring, false);
  assert.equal(authoring.allowedClasses.includes("Workspace"), false);
  assert.equal(authoring.resolvableClasses.includes("Workspace"), false);
  assert.match(authoring.checkScopes.instanceExists, /supported_descendant_classes/);
});

test("optional check failures aggregate exact target reasons and can be corrected in one proposal", async () => {
  const { host } = fixture();
  const proposal = await prepare(host);
  const rejected = await host.execute("creator.propose_plan", {
    ...proposal,
    checks: [
      { check: "instance_exists", objectId: "forge_attribute:workspace" },
      { check: "instance_exists", objectId: "forge_attribute:terrain" },
      {
        check: "position_series",
        objectId: "forge_attribute:existing",
        sampleCount: 2,
        intervalMs: 100,
        quantizationStuds: 1,
        minimumDistinctPositions: 2,
      },
      { check: "instance_exists", objectId: "forge_attribute:missing" },
      { check: "subtree_unchanged", objectId: "forge_attribute:workspace" },
    ],
  });
  assert.equal(rejected.error?.code, "PLAN_CHECKS_INVALID");
  assert.equal(rejected.truncated, false);
  assert.equal(host.getOutcome(), undefined);
  const report = JSON.parse(rejected.error!.message) as {
    details: {
      issues: Array<{
        path: string;
        code: string;
        target?: { path: string; className: string };
      }>;
    };
  };
  assert.deepEqual(
    report.details.issues.map((issue) => [issue.path, issue.code]),
    [
      ["checks[0].objectId", "PLAN_CHECK_ROOT_UNSUPPORTED"],
      ["checks[1].objectId", "PLAN_CHECK_CLASS_UNSUPPORTED"],
      ["checks[2].objectId", "PLAN_CHECK_TARGET_INVALID"],
      ["checks[3].objectId", "PLAN_OBJECT_NOT_OBSERVED"],
      ["checks[4].objectId", "PLAN_CHECK_CLASS_UNSUPPORTED"],
    ],
  );
  assert.deepEqual(report.details.issues[0]!.target, { path: "Workspace", className: "Workspace" });
  assert.equal(report.details.issues[3]!.target, undefined);
  assert.equal(rejected.error!.message.includes("invalid_union"), false);
  assert.ok(Buffer.byteLength(rejected.error!.message) < 3500);

  const accepted = await host.execute("creator.propose_plan", {
    ...proposal,
    checks: [
      { check: "instance_exists", objectId: "forge_attribute:existing" },
      { check: "subtree_unchanged", objectId: "forge_attribute:existing" },
    ],
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
  const outcome = host.getOutcome();
  assert.equal(outcome?.kind, "plan_proposed");
  if (outcome?.kind !== "plan_proposed") return;
  assert.deepEqual(
    outcome.plan.charter.clauses
      .filter((clause) => clause.kind === "studio_check")
      .map((clause) => "path" in clause && clause.path)
      .sort(),
    ["Workspace/Existing", "Workspace/NewFolder", "Workspace/NewFolder/Nested"],
  );
  assert.equal(outcome.plan.changes.length, 2);
});

test("optional preservation checks report plan conflicts before sealing a charter", async () => {
  const { host } = fixture();
  const proposal = await prepare(host, { kind: "object", id: "forge_attribute:existing" });
  const result = await host.execute("creator.propose_plan", {
    ...proposal,
    checks: [{ check: "subtree_unchanged", objectId: "forge_attribute:existing" }],
  });
  assert.equal(result.error?.code, "PLAN_CHECKS_INVALID");
  assert.match(result.error!.message, /cannot be declared unchanged/);
  assert.equal(host.getOutcome(), undefined);
});

test("model check schema explicitly distinguishes descendant observations from engine parents", () => {
  const { host } = fixture();
  const definition = host.definitions().find((entry) => entry.name === "creator.propose_plan")!;
  assert.match(
    JSON.stringify(definition.schema),
    /Engine roots and engine-container classes are not runtime check targets/,
  );
  assert.match(
    JSON.stringify(definition.schema),
    /Planned output existence checks are generated automatically/,
  );
});
