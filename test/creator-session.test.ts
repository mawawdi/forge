import { createTestFixtureSourceResolver } from "./helpers/source-fixtures.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
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
  authorizeCreatorPlanExecution,
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

const revisionHash = contentHash("initial evidence revision");

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
  assert.throws(
    () =>
      patchCreatorDraftSource(source, hash, [
        { startLine: 2, deleteCount: 1, replacement: "local answer = 2" },
      ]),
    /must end with a newline/,
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
      const plan = createCreatorPlan(
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
        ["create", "update", "move", "delete", "edit_source"],
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

test("engine settings are writable only through observed update targets", () => {
  const updateOnly = STUDIO_CAPABILITY_MANIFEST.classes
    .filter((classDefinition) => !classDefinition.creatable)
    .map((classDefinition) => classDefinition.name);
  assert.deepEqual(updateOnly, [
    "Lighting",
    "MaterialService",
    "SoundService",
    "StarterGui",
    "StarterPlayer",
    "Terrain",
    "TextChatService",
    "Workspace",
  ]);
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
  for (const className of updateOnly) assert.equal(allowed.has(className), false, className);
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
    session,
    ownership,
    projectIndex: index,
    prompt,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
  });
  const proposal = {
    inspectionObjectIds: [script.objectId],
    steps: [{ statement: prompt, changeIds: ["edit"] }],
    changes: [{ id: "edit", kind: "edit_source", objectId: script.objectId }],
    checks: [{ check: "playtest_diagnostics", maximumErrors: 0, maximumWarnings: 0 }],
    reviews: ["Try the requested interaction in Studio."],
  };
  assert.equal((await host.execute("creator.propose_plan", proposal)).ok, false);
  await host.execute("project.search", { queries: [{ query: "Script" }] });
  assert.equal(
    (await host.execute("creator.propose_plan", proposal)).ok,
    false,
    "Search alone does not satisfy inspection",
  );
  await host.execute("project.inspect", { objectIds: [script.objectId] });
  const unconsulted = await host.execute("creator.propose_plan", proposal);
  assert.equal(unconsulted.error?.code, "SOURCE_CONSULTATION_INCOMPLETE");
  await host.execute("source.read", { documentId: script.objectId });
  assert.equal(
    (await host.execute("creator.propose_plan", proposal)).error?.code,
    "SOURCE_CONSULTATION_INCOMPLETE",
    "Reading source must still include its dependency closure",
  );
  await host.execute("source.dependencies", { documentId: script.objectId, direction: "closure" });
  const unknown = await host.execute("creator.propose_plan", {
    ...proposal,
    changes: [{ ...proposal.changes[0], objectId: "stale-id" }],
  });
  assert.equal(unknown.ok, false);
  const result = await host.execute("creator.propose_plan", proposal);
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
  const draftSchema = draftDefinition.schema as {
    properties: { drafts: { items: { properties: { planChangeId: { enum: string[] } } } } };
  };
  assert.deepEqual(draftSchema.properties.drafts.items.properties.planChangeId.enum, ["edit"]);
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
  const stagedSource = "print('new')\n";
  assert.equal(
    (
      await builder.execute("studio.build", {
        changes: [
          {
            planChangeId: "edit",
            sourceEdits: [
              { startByte: 0, endByte: Buffer.byteLength(source), replacement: stagedSource },
            ],
          },
        ],
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
  assert.deepEqual(orientation.content.exploration.projectTools, [
    "project.search",
    "project.children",
    "project.inspect",
  ]);
  assert.equal(orientation.content.exploration.exactFactsRequireToolConsultation, true);

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
  const studioPlan = createCreatorPlan(
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
  const rojoPlan = createCreatorPlan(
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
      createCreatorPlan(
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
    session,
    ownership,
    projectIndex: observation,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
    prompt,
  });
  assert.ok(host.definitions().some((entry) => entry.name === "studio.api_lookup"));
  assert.match(
    host.definitions().find((entry) => entry.name === "creator.propose_plan")?.description ?? "",
    new RegExp(`at least ${CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS} ms`),
  );
  const result = await host.execute("studio.api_lookup", {
    className: "ProximityPrompt",
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

  const invalid = await host.execute("studio.api_lookup", {});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, "ROBLOX_API_LOOKUP_INVALID");
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
  const host = new CreatorPlannerToolHost({ session, ownership, projectIndex, ...sources, prompt });
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
      }
      const searchSchema = body.tools.find(
        (entry: { function: { name: string } }) => entry.function.name === "project_search",
      ).function.parameters;
      assert.deepEqual(searchSchema.required, ["queries"]);
      assert.deepEqual(searchSchema.properties.queries.items.required, ["query"]);
      const childrenSchema = body.tools.find(
        (entry: { function: { name: string } }) => entry.function.name === "project_children",
      ).function.parameters;
      assert.deepEqual(childrenSchema.required, ["queries"]);
      const planSchema = body.tools.find(
        (entry: { function: { name: string } }) => entry.function.name === "creator_propose_plan",
      ).function.parameters;
      assert.equal(planSchema.properties.changes.items.oneOf, undefined);
      assert.equal(planSchema.properties.changes.items.anyOf.length, 5);
      assert.equal(planSchema.properties.checks.items.anyOf.length, 4);
      assert.ok(
        planSchema.properties.changes.items.anyOf.every(
          (branch: { type: string }) => branch.type === "object",
        ),
      );
      assert.match(planSchema.properties.checks.description, /maximumErrors/);
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
    steps: [{ statement: "Create an empty folder.", changeIds: ["folder"] }],
    changes: [
      {
        id: "folder",
        kind: "create",
        name: "NewFolder",
        parent: { rootPath: "Workspace" },
        className: "Folder",
      },
    ],
    checks: [{ check: "playtest_diagnostics", maximumErrors: 0, maximumWarnings: 0 }],
    reviews: [],
  };
  const malformed = await host.execute("creator.propose_plan", {
    ...proposal,
    changes: [{ ...proposal.changes[0], className: undefined, name: undefined }],
  });
  assert.equal(malformed.error?.code, "TOOL_ARGUMENTS_INVALID");
  assert.match(malformed.error?.message ?? "", /changes\.0\.className/);
  assert.match(malformed.error?.message ?? "", /changes\.0\.name/);
  const duplicate = await host.execute("creator.propose_plan", {
    ...proposal,
    steps: [{ statement: "Create two folders.", changeIds: ["folder", "other"] }],
    changes: [...proposal.changes, { ...proposal.changes[0], id: "other" }],
  });
  assert.equal(duplicate.ok, false);
  const result = await host.execute("creator.propose_plan", proposal);
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
  const plan = createCreatorPlan(
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
  for (const step of plan.steps) assert.ok(visiblePlan.includes(step.statement));
  for (const clause of plan.charter.clauses)
    assert.equal(visiblePlan.includes(clause.statement), clause.kind === "creator_review");
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
  assert.deepEqual(
    context.changes.map((change: { planChangeId: string }) => change.planChangeId),
    contract.changes.map((change) => change.planChangeId),
  );
  for (const change of context.changes) {
    const policy = context.propertyPolicies[change.propertyPolicyIndex];
    assert.deepEqual(
      {
        attributes: "primitive",
        source: policy.source,
        allowedProperties: Object.entries(policy.properties).map(([name, index]) => ({
          name,
          valueKinds: [context.propertyRules[index as number].type],
          nullable: context.propertyRules[index as number].nullable ?? false,
          constraints: context.propertyRules[index as number].constraints,
        })),
      },
      contract.changes.find((entry) => entry.planChangeId === change.planChangeId)!.propertyPolicy,
    );
  }
  assert.deepEqual(context.steps, plan.steps);
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
    session,
    ownership,
    projectIndex: platformObservation,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
    prompt,
  });
  const rejected = await host.execute("creator.propose_plan", {
    inspectionObjectIds: [],
    steps: [
      {
        statement: "Attempt one create below an absent mutable parent.",
        changeIds: ["invalid-create"],
      },
    ],
    changes: [
      {
        id: "invalid-create",
        kind: "create",
        name: "NewFolder",
        parent: { objectId: "forge_attribute:missing" },
        className: "Folder",
      },
    ],
    checks: [{ check: "playtest_diagnostics", maximumErrors: 0, maximumWarnings: 0 }],
    reviews: [],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, "PLAN_OBJECT_NOT_OBSERVED");
  assert.match(rejected.error?.message ?? "", /Unknown or stale object IDs/i);
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
  const plan = createCreatorPlan(
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
    changes: [{ planChangeId: "camera-child", properties: {}, attributes: {} }],
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
  const plan = createCreatorPlan(
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
    changes: [
      { planChangeId: "protocol", source: "return { Enabled = true }\n" },
      {
        planChangeId: "panel",
        properties: {
          CFrame: {
            X: 0,
            Y: 4,
            Z: 0,
            R00: 1,
            R01: 0,
            R02: 0,
            R10: 0,
            R11: 1,
            R12: 0,
            R20: 0,
            R21: 0,
            R22: 1,
          },
        },
      },
      {
        planChangeId: "server",
        source: "--!strict\nlocal impossible: string = 1\nprint(impossible)\n",
      },
    ],
    summary: "Built the airlock implementation.",
  });
  assert.equal(rejectedBatch.ok, false);
  assert.equal(host.progressToken(), beforeBatch);
  assert.equal(host.stagedOperations().length, 0, "an invalid complete batch is atomic");

  const built = await host.execute("studio.build", {
    changes: [
      { planChangeId: "protocol", source: "return { Enabled = true }\n" },
      {
        planChangeId: "panel",
        properties: {
          CFrame: { position: { x: 0, y: 4, z: 0 } },
          Transparency: 0.2,
          Reflectance: 0.1,
        },
        attributes: { Purpose: "status" },
      },
      {
        planChangeId: "server",
        source: "--!strict\nlocal impossible: string = 1\nprint(impossible)\n",
      },
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

  const replacementSource = [
    'local ReplicatedStorage = game:GetService("ReplicatedStorage")',
    'local system = ReplicatedStorage:WaitForChild("AirlockSystem")',
    'local protocol = require(system:WaitForChild("Protocol"))',
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
  const sealed = host.seal();
  assert.equal(sealed.summary, "Built the requested server behavior.");
  const delegated = authorizeCreatorPlanExecution(planApproval, sealed, "2026-09-04T10:00:00.000Z");
  assert.equal(delegated.authority, "accepted_plan");
  assert.deepEqual(delegated.planAuthorization, { id: planApproval.id, hash: planApproval.hash });
  assert.throws(() =>
    authorizeCreatorPlanExecution(
      { ...planApproval, artifactHash: "f".repeat(64) },
      sealed,
      delegated.decidedAt,
    ),
  );
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
  const plan = createCreatorPlan(
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
    changes: [
      {
        planChangeId: "server",
        source: [
          'local ReplicatedStorage = game:GetService("ReplicatedStorage")',
          'local system = ReplicatedStorage:WaitForChild("AirlockSystem")',
          'local protocol = require(system:WaitForChild("Protocol"))',
          "assert(protocol.Enabled)",
          "",
        ].join("\n"),
      },
    ],
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
          { ...reference, outcome: { ...reference.outcome, intendedArtifactKind: "change_set" } },
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
    () => createCreatorPlan(input, runtimeObservation, runtimeOwnership),
    new RegExp(`capacity for at least ${CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS} ms`),
  );
  assert.doesNotThrow(() =>
    createCreatorPlan(
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
    ["Lighting", "TimeOfDay", "21:30:00", "string_utf8"],
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
