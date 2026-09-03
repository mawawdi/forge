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
  assertOwnershipMap,
  canonicalizeCreatorPropertyInput,
  createCreatorApproval,
  createCreatorBuildContract,
  createCreatorPlan,
  createCreatorTransactionControlView,
  createCreatorAgentContextCitation,
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
  assertCreatorTransactionControlAction,
  restoredCreatorControlDetail,
} from "../packages/creator-session/src/coordinator.js";
import { CREATOR_VERIFICATION_OBSERVATION_WINDOW_MS } from "../packages/studio-capabilities/src/index.js";
import {
  OpenRouterModelClient,
  DEFAULT_CREATOR_MODEL_ID,
} from "../packages/model-client/src/index.js";

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
      assert.deepEqual(searchSchema.required, ["query"]);
      const childrenSchema = body.tools.find(
        (entry: { function: { name: string } }) => entry.function.name === "project_children",
      ).function.parameters;
      assert.equal(childrenSchema.required, undefined);
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
                    function: { name: "project_search", arguments: '{"query":"Folder","limit":1}' },
                  },
                  {
                    id: "children-first",
                    type: "function",
                    function: {
                      name: "project_children",
                      arguments: '{"rootPath":"Workspace","limit":1}',
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
    assert.equal(Object.hasOwn(call.arguments as object, "cursor"), false);
    const first = await host.execute(call.name, call.arguments);
    assert.equal(first.ok, true);
    const page = first.value as { results: { objectId: string }[]; nextCursor: string };
    assert.equal(page.results[0]?.objectId, "forge_attribute:folder-1");
    assert.ok(page.nextCursor);
    const next = await host.execute(call.name, {
      ...(call.arguments as object),
      cursor: page.nextCursor,
    });
    assert.equal(next.ok, true);
    assert.equal((next.value as typeof page).results[0]?.objectId, "forge_attribute:folder-2");
    const stale = await host.execute(call.name, { ...(call.arguments as object), cursor: "0" });
    assert.equal(stale.error?.code, "PROJECT_CURSOR_STALE");
    assert.match(stale.error?.message ?? "", /Omit cursor/);
  }
  const conflicting = await host.execute("project.children", {
    rootPath: "Workspace",
    parentObjectId: "root",
  });
  assert.equal(conflicting.error?.code, "PROJECT_PARENT_INVALID");
  assert.match(conflicting.error?.message ?? "", /omit parentObjectId/);
  const byId = await host.execute("project.children", {
    parentObjectId: observation.instances[0]!.objectId,
  });
  assert.equal(byId.ok, true);
  assert.equal((byId.value as { results: unknown[] }).results.length, 2);
  assert.equal(calls, 1);
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
