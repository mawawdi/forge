import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  ImmutableBinaryArtifactStore,
  ImmutableJsonArtifactStore,
} from "../packages/artifact-store/src/index.js";
import {
  AuthorizedOpenCloudAssetUploader,
  OpenCloudAssetOperationJournal,
  classifyOpenCloudOperationResponse,
  createManualSceneImportPacket,
  derivePendingNativeAssetReceipt,
  robloxAssetCapabilityProfile,
} from "../packages/roblox-assets/src/index.js";
import {
  APPROVED_SCENE_ASSET_INSPECTION_SCHEMA,
  CREATOR_VISUAL_WORLD_ACCEPTANCE_SCHEMA,
  CREATOR_VISUAL_WORLD_PROPOSAL_SCHEMA,
  NATIVE_ASSET_RECEIPT_SCHEMA,
  NATIVE_UPLOAD_AUTHORIZATION_SCHEMA,
  approvedSceneAssetContentHash,
  approvedScenePlatformEnvelopeHash,
  blenderSceneSpecHandle,
  createApprovedSceneInspectionCommand,
  deriveApprovedSceneAssetInspection,
  deriveSaveReopenEvidence,
  evaluateNativeSceneEligibility,
  retainNativeAssetConversionExpectation,
  sealWorkflowArtifact,
  solveBlenderScene,
} from "../packages/visual-world/src/index.js";
import { visualWorldIntent } from "./helpers/visual-world-fixture.js";

const NOW = "2026-09-06T12:00:00.000Z";
const HASH = "b".repeat(64);

function eligibleAuthorityFixture() {
  const solve = solveBlenderScene(visualWorldIntent());
  assert.equal(solve.status, "eligible");
  if (solve.status !== "eligible") throw new Error("fixture scene did not solve");
  const scene = blenderSceneSpecHandle(solve.spec);
  const proposal = sealWorkflowArtifact(CREATOR_VISUAL_WORLD_PROPOSAL_SCHEMA, {
    kind: "CreatorVisualWorldProposal",
    projectId: "fixture-project",
    projectRevisionHash: HASH,
    creatorRequestHash: "a".repeat(64),
    referenceHashes: [],
    agentRunId: "agent-run-fixture",
    agentRunHash: "e".repeat(64),
    semanticDesignHash: "c".repeat(64),
    solvedScene: scene,
    sourceConsultationHash: "d".repeat(64),
    intendedImplementation: "Compile the exact solved scene through the fixed worker.",
    proposedAt: NOW,
  });
  const acceptance = sealWorkflowArtifact(CREATOR_VISUAL_WORLD_ACCEPTANCE_SCHEMA, {
    kind: "CreatorVisualWorldAcceptance",
    proposalId: proposal.id,
    proposalHash: proposal.hash,
    decision: "accepted",
    decidedAt: NOW,
  });
  const exportArtifact = { id: "static-glb", hash: "e".repeat(64), bytes: 128 };
  const authorization = sealWorkflowArtifact(NATIVE_UPLOAD_AUTHORIZATION_SCHEMA, {
    kind: "NativeUploadAuthorization",
    scene,
    bundleManifestHash: "f".repeat(64),
    reviewId: "fixture-review",
    reviewHash: "1".repeat(64),
    exportArtifacts: [exportArtifact],
    creator: { kind: "user", id: "1234" },
    target: { projectId: "fixture-project", universeId: 99 },
    credentialCapability: {
      kind: "api_key",
      scopes: ["asset:read", "asset:write"],
      capabilityHash: "2".repeat(64),
    },
    authorizedAt: NOW,
  });
  const node = {
    assetId: "987654",
    sourceArtifactHash: exportArtifact.hash,
    stableId: "fixture-imported-mesh",
    relativePath: "FixtureMesh",
    name: "FixtureMesh",
    className: "MeshPart",
    contentIdentity: '{"meshId":"rbxassetid://987654","textureId":""}',
    materialIdentity: "Metal",
    pivotHash: "3".repeat(64),
    transformHash: "3".repeat(64),
    boundsHash: "4".repeat(64),
    executable: false,
  };
  const receipt = sealWorkflowArtifact(NATIVE_ASSET_RECEIPT_SCHEMA, {
    kind: "NativeAssetReceipt",
    authorizationHash: authorization.hash,
    sourceArtifactHash: exportArtifact.hash,
    operationResponseHash: "5".repeat(64),
    declarationAuthority: "open_cloud",
    assetId: node.assetId,
    versionNumber: 7,
    contentHash: approvedSceneAssetContentHash([node]),
    owner: authorization.creator,
    moderation: "approved",
    dependencyAccess: "eligible",
    observedAt: NOW,
  });
  const capability = robloxAssetCapabilityProfile();
  const inspection = sealWorkflowArtifact(APPROVED_SCENE_ASSET_INSPECTION_SCHEMA, {
    kind: "ApprovedSceneAssetInspection",
    scene,
    bundleManifestHash: authorization.bundleManifestHash,
    capabilityProfileHash: capability.hash,
    receipts: [
      { assetId: receipt.assetId, versionNumber: receipt.versionNumber, receiptHash: receipt.hash },
    ],
    detached: true,
    platformEnvelope: {
      className: "Model",
      packageLinkRemoved: true,
      envelopeHash: approvedScenePlatformEnvelopeHash(),
    },
    expectedNodes: [node],
    observedNodes: [node],
    inspectedAt: NOW,
  });
  return { proposal, acceptance, authorization, receipt, inspection, scene, exportArtifact, node };
}

test("native eligibility requires exact ownership, moderation, version, hierarchy, and content", () => {
  const fixture = eligibleAuthorityFixture();
  assert.deepEqual(
    evaluateNativeSceneEligibility({
      authorization: fixture.authorization,
      receipts: [fixture.receipt],
      inspection: fixture.inspection,
    }),
    { status: "eligible" },
  );

  const pending = sealWorkflowArtifact(NATIVE_ASSET_RECEIPT_SCHEMA, {
    ...withoutSeal(fixture.receipt),
    moderation: "pending",
  });
  assert.equal(
    evaluateNativeSceneEligibility({ authorization: fixture.authorization, receipts: [pending] })
      .status,
    "incomplete",
  );
  const rejected = sealWorkflowArtifact(NATIVE_ASSET_RECEIPT_SCHEMA, {
    ...withoutSeal(fixture.receipt),
    moderation: "rejected",
  });
  assert.equal(
    evaluateNativeSceneEligibility({ authorization: fixture.authorization, receipts: [rejected] })
      .status,
    "rejected",
  );

  const changedVersion = sealWorkflowArtifact(APPROVED_SCENE_ASSET_INSPECTION_SCHEMA, {
    ...withoutSeal(fixture.inspection),
    receipts: [{ ...fixture.inspection.receipts[0]!, versionNumber: 8 }],
  });
  assert.equal(
    evaluateNativeSceneEligibility({
      authorization: fixture.authorization,
      receipts: [fixture.receipt],
      inspection: changedVersion,
    }).status,
    "rejected",
  );
  const executableNode = { ...fixture.node, className: "Script", executable: true };
  const executable = sealWorkflowArtifact(APPROVED_SCENE_ASSET_INSPECTION_SCHEMA, {
    ...withoutSeal(fixture.inspection),
    expectedNodes: [executableNode],
    observedNodes: [executableNode],
  });
  assert.equal(
    evaluateNativeSceneEligibility({
      authorization: fixture.authorization,
      receipts: [fixture.receipt],
      inspection: executable,
    }).status,
    "rejected",
  );
});

test("detached inspection is derived from exact-version bytes and one hash-bound Studio challenge", async () => {
  const fixture = eligibleAuthorityFixture();
  const root = await mkdtemp(resolve(import.meta.dirname, "../.native-inspection-test-"));
  try {
    const binaryStore = new ImmutableBinaryArtifactStore(resolve(root, "binary"));
    const exactVersionArtifact = await binaryStore.write(
      new TextEncoder().encode("exact retained Roblox model version"),
      "application/octet-stream",
    );
    const capabilityProfileHash = robloxAssetCapabilityProfile().hash;
    const expectation = await retainNativeAssetConversionExpectation({
      binaryStore,
      exactVersionArtifact,
      scene: fixture.scene,
      bundleManifestHash: fixture.authorization.bundleManifestHash,
      uploadAuthorizationHash: fixture.authorization.hash,
      capabilityProfileHash,
      receipt: fixture.receipt,
      partitionId: "static-chunk",
      partitionRole: "WorldStatic",
      sourceGlbReportHash: "7".repeat(64),
      decoderIdentityHash: "8".repeat(64),
      expectedNodes: [fixture.node],
      derivedAt: NOW,
    });
    const command = createApprovedSceneInspectionCommand({
      sessionId: "fixture-session",
      requestId: "fixture-inspection-request",
      messageId: "fixture-inspection-command",
      sentAt: NOW,
      connectorBuildHash: "9".repeat(64),
      targetProjectId: "fixture-project",
      expectedProjectRevisionHash: HASH,
      sceneReviewHash: fixture.authorization.reviewHash,
      expectation,
      receipt: fixture.receipt,
    });
    const observationJson = stableJson({
      kind: "ApprovedSceneAssetObservation",
      abi: "approved-scene-asset-observation@2",
      challengeId: command.payload.challengeId,
      challengeHash: command.payload.challengeHash,
      sceneHash: fixture.scene.hash,
      bundleManifestHash: fixture.authorization.bundleManifestHash,
      uploadAuthorizationHash: fixture.authorization.hash,
      capabilityProfileHash,
      result: {
        status: "eligible",
        partitionId: expectation.partitionId,
        assetId: fixture.receipt.assetId,
        versionNumber: fixture.receipt.versionNumber,
        receiptHash: fixture.receipt.hash,
        sourceArtifactHash: fixture.receipt.sourceArtifactHash,
        contentHash: fixture.receipt.contentHash,
        platformEnvelopeHash: approvedScenePlatformEnvelopeHash(),
        observedNodes: [fixture.node],
      },
    });
    const response = {
      kind: "StudioProtocolMessage" as const,
      direction: "plugin_to_backend" as const,
      type: "ApprovedSceneAssetsInspected" as const,
      messageId: "fixture-inspection-response",
      requestId: command.payload.requestId,
      sessionId: "fixture-session",
      sentAt: NOW,
      payload: {
        requestId: command.payload.requestId,
        challengeId: command.payload.challengeId,
        challengeHash: command.payload.challengeHash,
        connectorBuildHash: command.payload.connectorBuildHash,
        targetProjectId: command.payload.targetProjectId,
        projectRevisionHash: command.payload.expectedProjectRevisionHash,
        sceneHash: command.payload.sceneHash,
        bundleManifestHash: command.payload.bundleManifestHash,
        uploadAuthorizationHash: command.payload.uploadAuthorizationHash,
        capabilityProfileHash: command.payload.capabilityProfileHash,
        inspectionDocumentJsonHash: command.payload.inspectionDocumentJsonHash,
        status: "eligible" as const,
        observationJson,
        observationJsonHash: contentHash(observationJson),
        inspectedAt: NOW,
      },
    };
    const inspection = deriveApprovedSceneAssetInspection({
      scene: fixture.scene,
      bundleManifestHash: fixture.authorization.bundleManifestHash,
      capabilityProfileHash,
      completed: [{ expectation, receipt: fixture.receipt, command, response }],
    });
    assert.deepEqual(inspection.expectedNodes, inspection.observedNodes);
    assert.equal(
      evaluateNativeSceneEligibility({
        authorization: fixture.authorization,
        receipts: [fixture.receipt],
        inspection,
      }).status,
      "eligible",
    );
    assert.throws(() =>
      deriveApprovedSceneAssetInspection({
        scene: fixture.scene,
        bundleManifestHash: fixture.authorization.bundleManifestHash,
        capabilityProfileHash,
        completed: [
          {
            expectation,
            receipt: fixture.receipt,
            command,
            response: {
              ...response,
              payload: { ...response.payload, projectRevisionHash: "0".repeat(64) },
            },
          },
        ],
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("save/reopen evidence requires exact saved bytes and a fresh matching connector capture", async () => {
  const fixture = eligibleAuthorityFixture();
  const root = await mkdtemp(resolve(import.meta.dirname, "../.save-reopen-test-"));
  try {
    const binaryStore = new ImmutableBinaryArtifactStore(resolve(root, "binary"));
    const savedPlace = await binaryStore.write(
      new TextEncoder().encode("opaque saved place bytes"),
      "application/octet-stream",
    );
    const base = {
      binaryStore,
      savedPlace,
      projectId: "fixture-project",
      scene: fixture.scene,
      creatorDeclarationHash: "1".repeat(64),
      matchedMutationHash: "2".repeat(64),
      finalizationReceiptHash: "3".repeat(64),
      expectedNativeStateHash: "4".repeat(64),
      expectedSourceStateHash: "5".repeat(64),
      closedAt: "2026-09-06T12:00:00.000Z",
      reopenedAt: "2026-09-06T12:01:00.000Z",
      derivedAt: "2026-09-06T12:02:00.000Z",
      decoded: {
        decoderIdentityHash: "6".repeat(64),
        savedPlaceArtifactHash: savedPlace.artifactHash,
        projectId: "fixture-project",
        revisionHash: "7".repeat(64),
        nativeStateHash: "4".repeat(64),
        sourceStateHash: "5".repeat(64),
      },
    } as const;
    const reconnectOnly = await deriveSaveReopenEvidence(base);
    assert.equal(reconnectOnly.status, "incomplete");
    const eligible = await deriveSaveReopenEvidence({
      ...base,
      freshCapture: {
        connectorBuildHash: "8".repeat(64),
        connectorSessionId: "fresh-reopened-session",
        projectId: "fixture-project",
        revisionHash: "7".repeat(64),
        nativeStateHash: "4".repeat(64),
        sourceStateHash: "5".repeat(64),
        captureHash: "9".repeat(64),
        capturedAt: "2026-09-06T12:01:30.000Z",
      },
    });
    assert.equal(eligible.status, "eligible");
    const stale = await deriveSaveReopenEvidence({
      ...base,
      freshCapture: {
        connectorBuildHash: "8".repeat(64),
        connectorSessionId: "stale-session",
        projectId: "fixture-project",
        revisionHash: "7".repeat(64),
        nativeStateHash: "4".repeat(64),
        sourceStateHash: "5".repeat(64),
        captureHash: "9".repeat(64),
        capturedAt: "2026-09-06T11:59:00.000Z",
      },
    });
    assert.equal(stale.status, "rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual import uses the same reviewed GLB and cannot manufacture upload eligibility", async () => {
  const fixture = eligibleAuthorityFixture();
  const root = await mkdtemp(resolve(import.meta.dirname, "../.manual-scene-import-test-"));
  try {
    const binaryStore = new ImmutableBinaryArtifactStore(resolve(root, "binary"));
    const bytes = Buffer.alloc(128, 7);
    const artifact = await binaryStore.write(bytes, "model/gltf-binary");
    const path = resolve(root, "static-chunk.glb");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, bytes));
    const manualAuthorization = sealWorkflowArtifact(NATIVE_UPLOAD_AUTHORIZATION_SCHEMA, {
      ...withoutSeal(fixture.authorization),
      exportArtifacts: [{ id: "static-glb", hash: artifact.artifactHash, bytes: artifact.bytes }],
      credentialCapability: {
        kind: "manual_studio_import",
        scopes: [],
        capabilityHash: "6".repeat(64),
      },
    });
    const packet = await createManualSceneImportPacket({
      authorization: manualAuthorization,
      binaryStore,
      glbs: [
        {
          partitionId: "static-chunk",
          absolutePath: path,
          artifact,
        },
      ],
    });
    assert.equal(packet.glbs[0]?.artifactHash, artifact.artifactHash);
    assert.equal(robloxAssetCapabilityProfile().openCloudGlbUpload.status, "available");
    await assert.rejects(
      createManualSceneImportPacket({
        authorization: manualAuthorization,
        binaryStore,
        glbs: [
          {
            partitionId: "static-chunk",
            absolutePath: path,
            artifact: {
              locator: `binary-artifacts/${"7".repeat(64)}.bin`,
              artifactHash: "7".repeat(64),
              bytes: 1,
              mediaType: "model/gltf-binary",
            },
          },
        ],
      }),
      /differs from the approved/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authorized Open Cloud GLB dispatch retains intent first and polls one exact operation", async () => {
  const fixture = eligibleAuthorityFixture();
  const root = await mkdtemp(resolve(import.meta.dirname, "../.open-cloud-upload-test-"));
  try {
    const binaryStore = new ImmutableBinaryArtifactStore(resolve(root, "binary"));
    const binary = await binaryStore.write(Buffer.from("exact-reviewed-glb"), "model/gltf-binary");
    const authorization = sealWorkflowArtifact(NATIVE_UPLOAD_AUTHORIZATION_SCHEMA, {
      ...withoutSeal(fixture.authorization),
      exportArtifacts: [{ id: "static-glb", hash: binary.artifactHash, bytes: binary.bytes }],
    });
    const journal = new OpenCloudAssetOperationJournal(
      new ImmutableJsonArtifactStore(resolve(root, "journal")),
    );
    const retained = await journal.retainIntent({
      authorizationId: authorization.id,
      authorizationHash: authorization.hash,
      artifact: authorization.exportArtifacts[0]!,
      endpoint: "https://apis.roblox.com/assets/v1/assets",
      method: "POST",
      assetType: "Model",
      displayName: "Fixture Static Chunk",
      description: "Exact reviewed Forge visual partition",
      creator: authorization.creator,
      createdAt: NOW,
    });
    const requests: unknown[] = [];
    let polls = 0;
    const uploader = new AuthorizedOpenCloudAssetUploader(journal, binaryStore, {
      async send(request) {
        requests.push(request);
        return request.method === "POST"
          ? { httpStatus: 200, body: { path: "operations/fixture-upload" } }
          : ++polls === 1
            ? { httpStatus: 200, body: { done: false } }
            : {
                httpStatus: 200,
                body: { done: true, response: { assetId: "987654", versionNumber: 7 } },
              };
      },
    });
    const dispatched = await uploader.dispatch(authorization, retained.intent, binary);
    assert.equal(dispatched.status, "response_received");
    if (dispatched.status !== "response_received") return;
    assert.equal(dispatched.intent.dispatchState, "response_received");
    assert.equal(dispatched.response.operationPath, "operations/fixture-upload");
    const post = requests[0] as { file: { bytes: Uint8Array }; metadata: unknown };
    assert.deepEqual(post.file.bytes, Buffer.from("exact-reviewed-glb"));
    assert.equal("credential" in post, false);
    const polled = await uploader.poll(dispatched.intent, dispatched.response);
    assert.equal(polled.response.httpStatus, 200);
    assert.deepEqual(classifyOpenCloudOperationResponse(polled.response), { status: "pending" });
    const completedPoll = await uploader.poll(dispatched.intent, polled.response);
    assert.deepEqual(classifyOpenCloudOperationResponse(completedPoll.response), {
      status: "eligible",
      assetId: "987654",
      versionNumber: 7,
    });
    const pendingReceipt = derivePendingNativeAssetReceipt({
      authorization,
      intent: dispatched.intent,
      response: completedPoll.response,
      observedAt: NOW,
    });
    assert.equal(pendingReceipt.assetId, "987654");
    assert.equal(pendingReceipt.moderation, "pending");
    assert.equal(pendingReceipt.dependencyAccess, "incomplete");
    assert.equal(
      evaluateNativeSceneEligibility({ authorization, receipts: [pendingReceipt] }).status,
      "incomplete",
    );
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[1], {
      method: "GET",
      url: "https://apis.roblox.com/assets/v1/operations/fixture-upload",
    });
    await assert.rejects(
      uploader.dispatch(authorization, dispatched.intent, binary),
      /undispatched/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the durable upload fence permits at most one POST under concurrent replay", async () => {
  const fixture = eligibleAuthorityFixture();
  const root = await mkdtemp(resolve(import.meta.dirname, "../.open-cloud-fence-test-"));
  try {
    const binaryStore = new ImmutableBinaryArtifactStore(resolve(root, "binary"));
    const binary = await binaryStore.write(
      Buffer.from("concurrent-reviewed-glb"),
      "model/gltf-binary",
    );
    const authorization = sealWorkflowArtifact(NATIVE_UPLOAD_AUTHORIZATION_SCHEMA, {
      ...withoutSeal(fixture.authorization),
      exportArtifacts: [{ id: "static-glb", hash: binary.artifactHash, bytes: binary.bytes }],
    });
    const journal = new OpenCloudAssetOperationJournal(
      new ImmutableJsonArtifactStore(resolve(root, "journal")),
    );
    const retained = await journal.retainIntent({
      authorizationId: authorization.id,
      authorizationHash: authorization.hash,
      artifact: authorization.exportArtifacts[0]!,
      endpoint: "https://apis.roblox.com/assets/v1/assets",
      method: "POST",
      assetType: "Model",
      displayName: "Concurrent Fixture",
      description: "One durable dispatch",
      creator: authorization.creator,
      createdAt: NOW,
    });
    let posts = 0;
    const uploader = new AuthorizedOpenCloudAssetUploader(journal, binaryStore, {
      async send() {
        posts += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        return { httpStatus: 200, body: { path: "operations/one-post" } };
      },
    });
    const results = await Promise.allSettled([
      uploader.dispatch(authorization, retained.intent, binary),
      uploader.dispatch(authorization, retained.intent, binary),
    ]);
    assert.equal(posts, 1);
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown Open Cloud dispatch outcomes are retained and never resubmitted", async () => {
  const fixture = eligibleAuthorityFixture();
  const root = await mkdtemp(resolve(import.meta.dirname, "../.open-cloud-journal-test-"));
  try {
    const journal = new OpenCloudAssetOperationJournal(new ImmutableJsonArtifactStore(root));
    const retained = await journal.retainIntent({
      authorizationId: fixture.authorization.id,
      authorizationHash: fixture.authorization.hash,
      artifact: fixture.exportArtifact,
      endpoint: "https://apis.roblox.com/assets/v1/assets",
      method: "POST",
      assetType: "Model",
      displayName: "Fixture Static Chunk",
      description: "Exact reviewed Forge visual partition",
      creator: fixture.authorization.creator,
      createdAt: NOW,
    });
    const dispatching = await journal.markDispatching(retained.intent);
    const unknown = await journal.markUnknown(
      dispatching.intent,
      "connection closed after dispatch",
    );
    assert.deepEqual(journal.recoveryAction(unknown.intent), {
      mayResubmit: false,
      action: "establish_non_submission",
    });
    await assert.rejects(journal.markDispatching(unknown.intent), /undispatched/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function withoutSeal<T extends { id: string; hash: string }>(value: T): Omit<T, "id" | "hash"> {
  const { id: _id, hash: _hash, ...material } = value;
  return material;
}
