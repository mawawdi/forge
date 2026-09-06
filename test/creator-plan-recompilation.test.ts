import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  createCreatorApproval,
  createCreatorBuildContract,
} from "../packages/creator-session/src/index.js";
import {
  assertCreatorPlanRecompilation,
  creatorRecompilationObservationHash,
  creatorRecompilationReviewSummary,
  recompileRetainedCreatorPlan,
} from "../packages/creator-session/src/plan-recompilation.js";
import {
  createStudioProjectIndexCapture,
  createStudioProjectEvidenceShard,
  projectIndexMaterial,
  type StudioProjectIndexCapture,
  type StudioProjectIndexNode,
} from "../packages/studio-evidence/src/index.js";
import {
  creatorPlanRecompilationFixture,
  recompilationCapture,
  recompilationSession,
} from "./helpers/creator-plan-recompilation-fixture.js";
import { completeProjectProperties } from "./helpers/studio-project-fixtures.js";
import { compileGamePlan } from "../packages/game-compiler/src/index.js";

function withNodes(capture: StudioProjectIndexCapture, nodes: readonly StudioProjectIndexNode[]) {
  return createStudioProjectIndexCapture({
    ...capture,
    shards: [createStudioProjectEvidenceShard({ root: "Workspace", ordinal: 0, nodes })],
    completedAt: capture.indexManifest.completedAt,
  });
}

function addedNode(
  capture: StudioProjectIndexCapture,
  path: string,
  className = "Folder",
): StudioProjectIndexNode {
  const root = capture.shards[0]!.nodes.find((node) => node.displayPath === "Workspace")!;
  const properties = completeProjectProperties(className);
  return {
    identity: {
      kind: "studio_ephemeral",
      connectorEpoch: capture.projection.connectorEpoch,
      opaqueHash: contentHash(path),
    },
    displayPath: path,
    name: path.split("/").at(-1)!,
    className,
    parentIdentity: root.identity,
    attributes: { AddedBy: "observed-save" },
    tags: [],
    coveredProperties: properties,
    coveredPropertyNames: Object.keys(properties),
  };
}

test("retained design admits exact additive nodes and attributes under fresh review", () => {
  const fixture = creatorPlanRecompilationFixture();
  const nodes = fixture.afterCapture.shards[0]!.nodes.map((node) =>
    node.displayPath === "Workspace"
      ? { ...node, attributes: { ...node.attributes, NativeMetadata: true, Zero: 0 } }
      : node,
  );
  const afterCapture = withNodes(fixture.afterCapture, [
    ...nodes,
    addedNode(fixture.afterCapture, "Workspace/ExtraDetail", "Part"),
    addedNode(fixture.afterCapture, "Workspace/ExtraContainer"),
  ]);
  const result = recompileRetainedCreatorPlan({
    ...fixture,
    afterCapture,
    ...recompilationSession(afterCapture, fixture.creatorPrompt),
  });
  assert.deepEqual(result.plan.compiled.inventory, fixture.previousPlan.compiled.inventory);
  assert.notEqual(
    result.recompilation.retention.beforeObservationHash,
    result.recompilation.retention.afterObservationHash,
  );
  assert.deepEqual(
    result.recompilation.additions.nodes.map((node) => node.path),
    ["Workspace/ExtraContainer", "Workspace/ExtraDetail"],
  );
  assert.deepEqual(
    result.recompilation.additions.attributes.map((attribute) => ({
      path: attribute.path,
      name: attribute.name,
    })),
    [
      { path: "Workspace", name: "NativeMetadata" },
      { path: "Workspace", name: "Zero" },
    ],
  );
  assert.equal(
    result.recompilation.additions.attributes[1]!.canonicalValue,
    projectIndexMaterial(0),
  );
  assert.notEqual(
    result.recompilation.additions.attributes[1]!.canonicalValue,
    projectIndexMaterial(-0),
  );
  for (const node of result.recompilation.additions.nodes)
    assert.equal(node.nodeHash, contentHash(node.canonicalFacts));
  assertCreatorPlanRecompilation(JSON.parse(stableJson(result.recompilation)));
  const summary = creatorRecompilationReviewSummary(result.recompilation);
  assert.match(summary, /2 added objects: Workspace\/ExtraContainer, Workspace\/ExtraDetail/);
  assert.match(summary, /2 added attributes: Workspace.NativeMetadata, Workspace.Zero/);
  assert.notEqual(result.plan.hash, fixture.previousPlan.hash);
});

test("additive observations still reject exact plan path collisions and introduced source or property references", () => {
  const fixture = creatorPlanRecompilationFixture();
  const first = fixture.afterCapture.shards[0]!.nodes.find(
    (node) => node.displayPath === "Workspace/First",
  )!;
  const model = addedNode(fixture.afterCapture, "Workspace/AddedModel", "Model");
  const variants = [
    addedNode(fixture.afterCapture, "Workspace/NewRoot"),
    addedNode(fixture.afterCapture, "Workspace/ExtraModule", "ModuleScript"),
    {
      ...model,
      coveredProperties: completeProjectProperties("Model", {
        PrimaryPart: {
          kind: "instance_ref",
          state: "reference",
          identity: first.identity,
          path: first.displayPath,
          className: first.className,
          expectedClass: "BasePart",
        },
      }),
    },
  ];
  for (const node of variants)
    assert.throws(() => {
      const afterCapture = withNodes(fixture.afterCapture, [
        ...fixture.afterCapture.shards[0]!.nodes,
        node,
      ]);
      recompileRetainedCreatorPlan({
        ...fixture,
        afterCapture,
        ...recompilationSession(afterCapture, fixture.creatorPrompt),
      });
    });
});

test("retained observations reject removals and changes even beside permitted additions", () => {
  const fixture = creatorPlanRecompilationFixture();
  const original = fixture.afterCapture.shards[0]!.nodes;
  const changed = [
    original.filter((node) => node.displayPath !== "Workspace/Second"),
    original.map((node) =>
      node.displayPath === "Workspace/First" ? { ...node, attributes: {} } : node,
    ),
    original.map((node) =>
      node.displayPath === "Workspace/First"
        ? { ...node, attributes: { ...node.attributes, Weight: 1 } }
        : node,
    ),
    original.map((node) =>
      node.displayPath === "Workspace/First" ? { ...node, tags: ["changed"] } : node,
    ),
    original.map((node) =>
      node.displayPath === "Workspace/First"
        ? {
            ...node,
            coveredProperties: completeProjectProperties("Part", {
              Anchored: { kind: "boolean", value: true },
            }),
          }
        : node,
    ),
  ];
  for (const nodes of changed) {
    const afterCapture = withNodes(fixture.afterCapture, [
      ...nodes,
      addedNode(fixture.afterCapture, "Workspace/Addition"),
    ]);
    assert.throws(
      () =>
        recompileRetainedCreatorPlan({
          ...fixture,
          afterCapture,
          ...recompilationSession(afterCapture, fixture.creatorPrompt),
        }),
      /removed|remain exact|attributes changed/,
    );
  }
  for (const sourceChange of [{ source: "return { value = 2 }\n" }, { editorSource: true }]) {
    const captured = recompilationCapture({ epoch: "epoch-after", ...sourceChange });
    const afterCapture = withNodes(captured, [
      ...captured.shards[0]!.nodes,
      addedNode(captured, "Workspace/Addition"),
    ]);
    assert.throws(
      () =>
        recompileRetainedCreatorPlan({
          ...fixture,
          afterCapture,
          ...recompilationSession(afterCapture, fixture.creatorPrompt),
        }),
      /retained complete observed source/,
    );
  }
});

test("addition proof rejects tampered native facts and noncanonical duplicates", () => {
  const fixture = creatorPlanRecompilationFixture();
  const afterCapture = withNodes(fixture.afterCapture, [
    ...fixture.afterCapture.shards[0]!.nodes,
    addedNode(fixture.afterCapture, "Workspace/Addition"),
  ]);
  const { recompilation } = recompileRetainedCreatorPlan({
    ...fixture,
    afterCapture,
    ...recompilationSession(afterCapture, fixture.creatorPrompt),
  });
  const node = recompilation.additions.nodes[0]!;
  assert.throws(
    () =>
      assertCreatorPlanRecompilation({
        ...recompilation,
        additions: {
          nodes: [{ ...node, canonicalFacts: node.canonicalFacts + "changed" }],
          attributes: [],
        },
      }),
    /facts hash mismatch/,
  );
  assert.throws(
    () =>
      assertCreatorPlanRecompilation({
        ...recompilation,
        additions: { nodes: [node, node], attributes: [] },
      }),
    /unique/,
  );
});

test("recompilation keeps complete intent and inventory while requiring a newly accepted plan", () => {
  const fixture = creatorPlanRecompilationFixture();
  const before = stableJson(fixture);
  const first = recompileRetainedCreatorPlan(fixture);
  const second = recompileRetainedCreatorPlan(fixture);
  assert.deepEqual(
    first,
    second,
    "same retained intent and new observation compile byte identically",
  );
  assert.equal(stableJson(fixture), before, "compilation does not mutate input authority");
  assert.notEqual(first.plan.hash, fixture.previousPlan.hash);
  assert.equal(first.plan.sessionId, fixture.session.id);
  assert.equal(first.plan.projectCaptureHash, fixture.afterCapture.hash);
  assert.deepEqual(first.plan.compiled.inventory, fixture.previousPlan.compiled.inventory);
  assert.deepEqual(first.plan.compiled.design, fixture.previousPlan.compiled.design);
  assert.deepEqual(first.plan.charter, fixture.previousPlan.charter);
  assert.deepEqual(first.plan.steps, fixture.previousPlan.steps);
  assert.equal(first.recompilation.predecessor.planHash, fixture.previousPlan.hash);
  assertCreatorPlanRecompilation(first.recompilation);
  const oldApproval = createCreatorApproval({
    sessionId: fixture.previousPlan.sessionId,
    artifactKind: "plan",
    artifactId: fixture.previousPlan.id,
    artifactHash: fixture.previousPlan.hash,
    decision: "approved",
    decidedAt: "2026-09-06T12:00:00.000Z",
  });
  assert.throws(
    () =>
      createCreatorBuildContract({
        session: fixture.session,
        plan: first.plan,
        planApproval: oldApproval,
        ownership: fixture.ownership,
        projectIndex: fixture.observation,
      }),
    /binding|accepted|approval/i,
  );
  const newApproval = createCreatorApproval({
    sessionId: first.plan.sessionId,
    artifactKind: "plan",
    artifactId: first.plan.id,
    artifactHash: first.plan.hash,
    decision: "approved",
    decidedAt: "2026-09-06T12:00:00.000Z",
  });
  assert.doesNotThrow(() =>
    createCreatorBuildContract({
      session: fixture.session,
      plan: first.plan,
      planApproval: newApproval,
      ownership: fixture.ownership,
      projectIndex: fixture.observation,
    }),
  );
});

test("observation comparison normalizes only ephemeral identities across connector epochs", () => {
  const before = recompilationCapture();
  const after = recompilationCapture({ epoch: "epoch-after" });
  assert.notEqual(before.hash, after.hash);
  assert.notEqual(before.revision.hash, after.revision.hash);
  assert.equal(
    creatorRecompilationObservationHash(before),
    creatorRecompilationObservationHash(after),
  );
  const variants: Parameters<typeof recompilationCapture>[0][] = [
    { source: "return { value = 2 }\n" },
    { editorSource: true },
    { sourceName: "MovedModule" },
    { stableId: "replacement-part" },
    { attribute: 1 },
    { attribute: -0 },
    { tag: "replacement-tag" },
    { partName: "RenamedPart" },
    { referenceTarget: "second" },
    { sourceIdentity: { kind: "forge_attribute", stableId: "module" } },
    {
      sourceIdentity: {
        kind: "rojo_sourcemap",
        authorityMapHash: contentHash("authority"),
        sourcemapHash: contentHash("map"),
        mappingId: "module",
      },
    },
  ];
  for (const variant of variants)
    assert.notEqual(
      creatorRecompilationObservationHash(before),
      creatorRecompilationObservationHash(
        recompilationCapture({ epoch: "epoch-after", ...variant }),
      ),
      stableJson(variant),
    );
  const durable = recompilationCapture({
    sourceIdentity: {
      kind: "rojo_sourcemap",
      authorityMapHash: contentHash("authority"),
      sourcemapHash: contentHash("map"),
      mappingId: "module",
    },
  });
  const changedDurable = recompilationCapture({
    epoch: "epoch-after",
    sourceIdentity: {
      kind: "rojo_sourcemap",
      authorityMapHash: contentHash("authority"),
      sourcemapHash: contentHash("map-new"),
      mappingId: "module",
    },
  });
  assert.notEqual(
    creatorRecompilationObservationHash(durable),
    creatorRecompilationObservationHash(changedDurable),
  );
});

test("comparison rejects duplicate paths and incomplete or tampered covered properties", () => {
  assert.throws(
    () => creatorRecompilationObservationHash(recompilationCapture({ duplicatePath: true })),
    /duplicate observed paths/,
  );
  const capture = recompilationCapture();
  const original = capture.shards[0]!.nodes.find((node) => node.className === "Part")!;
  const mutations: StudioProjectIndexNode[] = [
    {
      ...original,
      coveredPropertyNames: original.coveredPropertyNames.filter((name) => name !== "Anchored"),
    },
    {
      ...original,
      coveredProperties: {
        ...original.coveredProperties,
        Anchored: { kind: "boolean", value: "not-a-boolean" },
      },
    },
  ];
  for (const replacement of mutations)
    assert.throws(() => {
      const shards = [
        createStudioProjectEvidenceShard({
          root: "Workspace",
          ordinal: 0,
          nodes: capture.shards[0]!.nodes.map((node) => (node === original ? replacement : node)),
        }),
      ];
      creatorRecompilationObservationHash(
        createStudioProjectIndexCapture({
          ...capture,
          shards,
          completedAt: capture.indexManifest.completedAt,
        }),
      );
    });
});

test("recompilation rejects changed project facts even when new session authority is correctly sealed", () => {
  const fixture = creatorPlanRecompilationFixture();
  const afterCapture = recompilationCapture({ epoch: "epoch-after", tag: "externally-edited" });
  assert.throws(
    () =>
      recompileRetainedCreatorPlan({
        ...fixture,
        afterCapture,
        ...recompilationSession(afterCapture, fixture.creatorPrompt),
      }),
    /every prior node, property, tag, source and reference fact/,
  );
});

test("recompilation binds the exact predecessor artifact, capture, prompt, and fresh session", () => {
  const fixture = creatorPlanRecompilationFixture();
  assert.throws(
    () =>
      recompileRetainedCreatorPlan({
        ...fixture,
        predecessorPlan: { ...fixture.predecessorPlan, bytes: fixture.predecessorPlan.bytes + 1 },
      }),
    /predecessor artifact/,
  );
  assert.throws(
    () =>
      recompileRetainedCreatorPlan({
        ...fixture,
        creatorPrompt: fixture.creatorPrompt + " Changed",
      }),
    /bindings differ/,
  );
  assert.throws(
    () => recompileRetainedCreatorPlan({ ...fixture, ...fixture.previous }),
    /bindings differ/,
  );
  const beforeCapture = createStudioProjectIndexCapture({
    ...fixture.beforeCapture,
    detectorEpoch: 10,
    completedAt: fixture.beforeCapture.indexManifest.completedAt,
  });
  assert.equal(beforeCapture.revision.hash, fixture.beforeCapture.revision.hash);
  assert.notEqual(beforeCapture.hash, fixture.beforeCapture.hash);
  assert.throws(
    () => recompileRetainedCreatorPlan({ ...fixture, beforeCapture }),
    /bindings differ/,
  );
  assert.throws(
    () => recompileRetainedCreatorPlan({ ...fixture, ownership: fixture.previous.ownership }),
    /fresh session/,
  );
  fixture.recorder.documentsPage();
  assert.throws(
    () => recompileRetainedCreatorPlan({ ...fixture, sourceConsultation: fixture.recorder.seal() }),
    /must not claim model inspections/,
  );
});

test("recompilation rejects observed instance parents and references", () => {
  assert.throws(
    () => recompileRetainedCreatorPlan(creatorPlanRecompilationFixture({ observedParent: true })),
    /observed instance parents/,
  );
  assert.throws(
    () =>
      recompileRetainedCreatorPlan(creatorPlanRecompilationFixture({ observedReference: true })),
    /observed instance references/,
  );
  assert.throws(
    () =>
      recompileRetainedCreatorPlan(creatorPlanRecompilationFixture({ sourceObservedParent: true })),
    /observed source or instance placement/,
  );
  assert.throws(
    () => recompileRetainedCreatorPlan(creatorPlanRecompilationFixture({ observedSource: true })),
    /pure create graph without observed source/,
  );
});

test("recompilation requires exact current recipe expansion, semantic admission and locked sources", () => {
  const fixture = creatorPlanRecompilationFixture({ lockedSource: true });
  assert.doesNotThrow(() => recompileRetainedCreatorPlan(fixture));
  assert.throws(
    () =>
      recompileRetainedCreatorPlan({
        ...fixture,
        catalog: { ...fixture.catalog, lockedSources: new Map() },
      }),
    /exact installed bytes/,
  );
  assert.throws(
    () =>
      recompileRetainedCreatorPlan({
        ...fixture,
        catalog: {
          ...fixture.catalog,
          validateComponent() {
            throw new Error("current admission rejected");
          },
        },
      }),
    /current admission rejected/,
  );
  const original = fixture.catalog.expanders[0]!;
  const changed = {
    ...original,
    expand(input: Parameters<typeof original.expand>[0]) {
      return original.expand(input).map((item) => ({ ...item, attributes: { Added: true } }));
    },
  };
  assert.throws(
    () =>
      recompileRetainedCreatorPlan({
        ...fixture,
        catalog: { ...fixture.catalog, expanders: [changed] },
      }),
    /changed the exact design, inventory/,
  );
});

test("retained recompilation applies current compiler policy and rejects a changed policy lock", () => {
  const fixture = creatorPlanRecompilationFixture();
  const prior = fixture.previousPlan;
  const compiled = compileGamePlan({
    ...prior.compiled,
    registry: fixture.catalog.registry,
    policy: {
      ...prior.compiled.policy,
      maximumOperations: prior.compiled.policy.maximumOperations + 1,
    },
  });
  const { id: _id, hash: _hash, kind: _kind, ...priorPayload } = prior;
  const payload = { ...priorPayload, compiled };
  const hash = contentHash(stableJson(payload));
  const previousPlan = {
    ...payload,
    kind: "CreatorPlan" as const,
    id: "creator_plan_" + hash.slice(0, 24),
    hash,
  };
  const bytes = stableJson(previousPlan) + "\n";
  const artifactHash = contentHash(bytes);
  assert.throws(
    () =>
      recompileRetainedCreatorPlan({
        ...fixture,
        previousPlan,
        predecessorPlan: {
          artifactHash,
          bytes: Buffer.byteLength(bytes),
          locator: `artifacts/${artifactHash}.json`,
        },
      }),
    /locked compiler authority/,
  );
});

test("recompilation receipt hashes all provenance and cannot claim the prior plan as current", () => {
  const fixture = creatorPlanRecompilationFixture();
  const { recompilation } = recompileRetainedCreatorPlan(fixture);
  assert.throws(() =>
    assertCreatorPlanRecompilation({ ...recompilation, afterCaptureHash: contentHash("fake") }),
  );
  const {
    id: _id,
    hash: _hash,
    ...payload
  } = { ...recompilation, sessionId: recompilation.predecessor.sessionId };
  const hash = contentHash(stableJson(payload));
  assert.throws(
    () =>
      assertCreatorPlanRecompilation({
        ...payload,
        hash,
        id: "creator_plan_recompilation_" + hash.slice(0, 24),
      }),
    /new session/,
  );
});
