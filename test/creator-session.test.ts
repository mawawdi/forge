import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  advanceSession,
  assertCreatorControlActionBinding,
  assertCreatorBuildContract,
  assertCreatorChangeSet,
  assertOwnershipMap,
  canonicalizeCreatorPropertyInput,
  createCreatorApproval,
  createCreatorBuildContract,
  createCreatorPlan,
  createCreatorControlView,
  assertCreatorSessionBundle,
  creatorOrientation,
  createCreatorSession,
  createStudioOwnershipMap,
  CreatorBuilderToolHost,
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
  createTestFixtureSourceResolver,
  type SourceDocumentInput,
} from "../packages/source-intelligence/src/index.js";
import {
  assertCreatorControlAction,
  restoredCreatorControlDetail,
} from "../packages/creator-session/src/coordinator.js";
import { CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS } from "../packages/studio-capabilities/src/index.js";

const revisionHash = contentHash("initial evidence revision");
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
  assert.equal(
    orientation.content.instances.find((entry) => entry.path === "Workspace/StudioDoor")?.owner,
    "studio_document",
  );
  assert.equal(
    orientation.content.scripts.find((entry) => entry.path === "Workspace/RojoSystem/Controller")
      ?.owner,
    "rojo_source",
  );

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
  const view = createCreatorControlView({
    creatorSessionId: "creator_session_retry",
    creatorSessionHash: "a".repeat(64),
    status: "awaiting_verification_retry",
    title: "Play Evidence Incomplete",
    detail: "The completed Play interval has read errors.",
    primaryAction: {
      id: "retry_play_verification",
      label: "Retry Play Verification",
      intent: "primary",
    },
    secondaryAction: {
      id: "cancel_changes",
      label: "Cancel Changes",
      intent: "secondary",
    },
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
  assert.doesNotThrow(() =>
    assertCreatorControlActionBinding(view, {
      creatorSessionId: view.creatorSessionId,
      viewId: view.id,
      viewHash: view.hash,
      actionId: "retry_play_verification",
    }),
  );
  assert.throws(
    () =>
      assertCreatorControlActionBinding(view, {
        creatorSessionId: view.creatorSessionId,
        viewId: view.id,
        viewHash: "b".repeat(64),
        actionId: "retry_play_verification",
      }),
    /stale or bound to a different/,
  );
  assert.deepEqual(
    assertCreatorControlAction({
      action: "act",
      sessionId: view.creatorSessionId,
      viewId: view.id,
      viewHash: view.hash,
      actionId: "retry_play_verification",
    }),
    {
      action: "act",
      sessionId: view.creatorSessionId,
      viewId: view.id,
      viewHash: view.hash,
      actionId: "retry_play_verification",
    },
  );
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
    new RegExp(
      `\\(sampleCount - 1\\) \\* intervalMs >= ${CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS}`,
    ),
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

  const host = new CreatorPlannerToolHost({
    session,
    ownership,
    projectIndex: platformObservation,
    sourceIndex: sources.sourceIndex,
    sourceResolver: sources.sourceResolver,
    prompt,
  });
  const rejected = await host.execute("creator.propose_plan", {
    inspectionPaths: [],
    steps: [
      {
        id: "invalid-parent",
        statement: "Attempt one create below an absent mutable parent.",
        changeIds: ["invalid-create"],
      },
    ],
    changes: [
      {
        id: "invalid-create",
        kind: "create",
        path: "Workspace/Missing/NewFolder",
        parent: {
          kind: "instance",
          identity: { kind: "forge_attribute", stableId: "missing" },
          path: "Workspace/Missing",
          className: "Folder",
        },
        className: "Folder",
        initialization: "initial_properties",
      },
    ],
    clauses: [
      {
        id: "folder-exists",
        kind: "studio_check",
        check: "instance_exists",
        path: "Workspace/Missing/NewFolder",
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
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, "PLAN_INVALID");
  assert.match(rejected.error?.message ?? "", /parent identity is absent or stale/i);
  const completion = host.completionStatus();
  assert.equal(completion.ready, false);
  if (!completion.ready) assert.match(completion.message, /Last proposal failure/);
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
  const staged = await host.execute("studio.stage", {
    change: { planChangeId: "camera-child", properties: {}, attributes: {} },
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
          changeIds: ["protocol", "server"],
        },
      ],
      changes: [
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

  const protocol = await host.execute("studio.stage", {
    change: {
      planChangeId: "protocol",
      source: "return { Enabled = true }\n",
    },
  });
  assert.equal(protocol.ok, true);
  const invalidServer = await host.execute("studio.stage", {
    change: {
      planChangeId: "server",
      source: "--!strict\nlocal impossible: string = 1\nprint(impossible)\n",
    },
  });
  assert.equal(invalidServer.ok, true);
  const rejected = await host.execute("forge.verify", {});
  assert.equal(rejected.ok, true);
  const rejectedValue = rejected.value as {
    status: string;
    issues: Array<{
      planChangeId?: string;
      path?: string;
      message?: string;
      location?: { line: number; column: number };
    }>;
  };
  assert.equal(rejectedValue.status, "rejected");
  assert.equal(host.completionStatus().ready, false);
  assert.ok(rejectedValue.issues.length > 0);
  assert.doesNotMatch(JSON.stringify(rejectedValue), /forge-studio-luau-analysis|\/var\/folders/);

  const replacementSource = [
    'local ReplicatedStorage = game:GetService("ReplicatedStorage")',
    'local system = ReplicatedStorage:WaitForChild("AirlockSystem")',
    'local protocol = require(system:WaitForChild("Protocol"))',
    "assert(protocol.Enabled)",
    "",
  ].join("\n");
  const replacement = await host.execute("studio.stage", {
    change: { planChangeId: "server", source: replacementSource },
  });
  assert.equal(replacement.ok, true);
  assert.equal((replacement.value as { replaced?: boolean }).replaced, true);
  assert.equal(host.stagedOperations().length, 2);
  const stagedServer = host
    .stagedOperations()
    .find((operation) => operation.planChangeId === "server");
  assert.ok(stagedServer && stagedServer.kind === "create" && stagedServer.sourceBlob);
  assert.equal(stagedServer.sourceBlob.sourceHash, contentHash(replacementSource));
  assert.equal(stagedServer.sourceBlob.utf8Bytes, Buffer.byteLength(replacementSource, "utf8"));
  const rejectedReplacement = await host.execute("studio.stage", {
    change: { planChangeId: "server" },
  });
  assert.equal(rejectedReplacement.ok, false);
  const preservedServer = host
    .stagedOperations()
    .find((operation) => operation.planChangeId === "server");
  assert.ok(preservedServer && preservedServer.kind === "create" && preservedServer.sourceBlob);
  assert.equal(preservedServer.sourceBlob.sourceHash, contentHash(replacementSource));

  const incomplete = await host.execute("forge.verify", {});
  const repeated = await host.execute("forge.verify", {});
  assert.equal((incomplete.value as { status: string }).status, "eligible");
  assert.deepEqual(repeated.value, incomplete.value);
  assert.equal(host.completionStatus().ready, true);
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
  const staged = await host.execute("studio.stage", {
    change: {
      planChangeId: "server",
      source: [
        'local ReplicatedStorage = game:GetService("ReplicatedStorage")',
        'local system = ReplicatedStorage:WaitForChild("AirlockSystem")',
        'local protocol = require(system:WaitForChild("Protocol"))',
        "assert(protocol.Enabled)",
        "",
      ].join("\n"),
    },
  });
  assert.equal(staged.ok, true);
  const verified = await host.execute("forge.verify", {});
  assert.equal(verified.ok, true);
  assert.equal(
    (verified.value as { status: string }).status,
    "eligible",
    JSON.stringify(verified.value),
  );
  assert.equal(host.completionStatus().ready, true);
});

test("creator session history is bound to immutable project-index captures", () => {
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
    ["Attachment", "Visible", false, "boolean"],
    [
      "Beam",
      "Attachment0",
      {
        identity: { kind: "forge_attribute", stableId: "attachment-a" },
        path: "Workspace/AttachmentA",
        className: "Attachment",
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
