import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  BLENDER_SCENE_DECLARATION_SCHEMA,
  VisualWorldAuthoringStore,
  VisualWorldWorkflowJournal,
  createProceduralSceneAuthority,
} from "../packages/visual-world/src/index.js";
import { visualWorldIntent } from "./helpers/visual-world-fixture.js";

const NOW = "2026-09-07T00:00:00.000Z";
const h = (value: string) => value.repeat(64).slice(0, 64);

test("visual workflow survives restart and consumes each exact action once", async () => {
  const root = await mkdtemp(resolve(import.meta.dirname, "../.visual-lifecycle-test-"));
  try {
    const workflowId = "visual-workflow-fixture";
    const journal = new VisualWorldWorkflowJournal(root);
    const draft = await journal.create({
      workflowId,
      projectId: "fixture-project",
      actionInstanceId: "create-draft-action",
      actor: "creator",
      artifacts: { sceneDeclarationHash: h("1"), creatorRequestHash: h("2") },
      detail: "Create the exact visual scene draft.",
      occurredAt: NOW,
    });
    const proposed = await journal.advance({
      workflowId,
      expectedEventHash: draft.hash,
      action: "propose",
      actionInstanceId: "propose-action",
      actor: "forge_host",
      artifacts: {
        proposalHash: h("3"),
        solvedSceneHash: h("4"),
        agentRunHash: h("5"),
        sourceConsultationHash: h("6"),
      },
      detail: "Retain the solved proposal and its authoring provenance.",
      occurredAt: NOW,
    });
    const restarted = new VisualWorldWorkflowJournal(root);
    assert.deepEqual(await restarted.current(workflowId), proposed);
    assert.deepEqual(await restarted.listCurrent(), [proposed]);
    assert.deepEqual(
      (await restarted.history(workflowId)).map((event) => event.to),
      ["draft", "proposed"],
    );
    await assert.rejects(() =>
      restarted.advance({
        workflowId,
        expectedEventHash: draft.hash,
        action: "accept_proposal",
        actionInstanceId: "stale-accept",
        actor: "creator",
        artifacts: { proposalAcceptanceHash: h("7") },
        detail: "Stale acceptance.",
        occurredAt: NOW,
      }),
    );
    const attempts = await Promise.allSettled(
      ["accept-a", "accept-b"].map((actionInstanceId) =>
        restarted.advance({
          workflowId,
          expectedEventHash: proposed.hash,
          action: "accept_proposal",
          actionInstanceId,
          actor: "creator",
          artifacts: { proposalAcceptanceHash: h("8") },
          detail: "Accept the exact proposal.",
          occurredAt: NOW,
        }),
      ),
    );
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await restarted.current(workflowId)).to, "accepted");
    assert.equal((await restarted.listCurrent())[0]?.to, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("visual workflow enforces all approval boundaries in order", async () => {
  const root = await mkdtemp(resolve(import.meta.dirname, "../.visual-lifecycle-order-test-"));
  try {
    const journal = new VisualWorldWorkflowJournal(root);
    let event = await journal.create({
      workflowId: "ordered-visual-workflow",
      projectId: "fixture-project",
      actionInstanceId: "ordered-create",
      actor: "creator",
      artifacts: { sceneDeclarationHash: h("1"), creatorRequestHash: h("2") },
      detail: "Create draft.",
      occurredAt: NOW,
    });
    const steps = [
      [
        "propose",
        {
          proposalHash: h("3"),
          solvedSceneHash: h("4"),
          agentRunHash: h("5"),
          sourceConsultationHash: h("6"),
        },
      ],
      ["accept_proposal", { proposalAcceptanceHash: h("7") }],
      [
        "start_compilation",
        { compilationIntentHash: h("8"), installationQualificationHash: h("9") },
      ],
      ["review_bundle", { bundleManifestHash: h("a"), bundleReviewHash: h("b") }],
      ["authorize_upload", { uploadAuthorizationHash: h("c") }],
      ["start_asset_processing", { uploadDispatchSetHash: h("d") }],
      ["retain_native_inspection", { nativeInspectionHash: h("e"), assetReceiptSetHash: h("f") }],
      [
        "approve_native_plan",
        { gamePlanHash: h("1"), nativePlanApprovalHash: h("2"), projectRevisionHash: h("3") },
      ],
      ["start_building", { buildArtifactHash: h("4") }],
      ["request_studio_apply", { studioApplyRequestHash: h("5"), connectorBuildHash: h("6") }],
      ["reconcile", { finalizationReceiptHash: h("7"), reconciliationHash: h("8") }],
    ] as const;
    for (const [action, artifacts] of steps)
      event = await journal.advance({
        workflowId: event.workflowId,
        expectedEventHash: event.hash,
        action,
        actionInstanceId: `ordered-${action}`,
        actor:
          action === "accept_proposal" || action === "authorize_upload" ? "creator" : "forge_host",
        artifacts,
        detail: `Advance through ${action}.`,
        occurredAt: NOW,
      });
    assert.equal(event.to, "reconciled");
    assert.equal((await journal.history(event.workflowId)).length, 12);
    await assert.rejects(() =>
      journal.advance({
        workflowId: event.workflowId,
        expectedEventHash: event.hash,
        action: "mark_incomplete",
        actionInstanceId: "after-terminal",
        actor: "forge_host",
        artifacts: {},
        detail: "Cannot reopen terminal workflow.",
        occurredAt: NOW,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary visual authoring retains declaration, solve, and actual AgentRun proposal across restart", async () => {
  const root = await mkdtemp(resolve(import.meta.dirname, "../.visual-authoring-test-"));
  try {
    const intent = visualWorldIntent();
    const declaration = BLENDER_SCENE_DECLARATION_SCHEMA.parse({
      kind: "BlenderSceneDeclaration",
      abi: intent.abi,
      sceneId: intent.sceneId,
      seed: intent.seed,
      visualBrief: intent.visualBrief,
      frames: intent.frames,
      zones: intent.zones,
      verticalLayers: intent.verticalLayers,
      routes: intent.routes,
      landmarks: intent.landmarks,
      geometries: intent.geometries,
      materials: intent.materials,
      objects: intent.objects,
      instances: intent.instances,
      sockets: intent.sockets,
      collections: intent.collections,
      partitions: intent.partitions,
      collisionProxies: intent.collisionProxies,
      gameplayAnchors: intent.gameplayAnchors,
      interactiveProps: intent.interactiveProps,
      effects: intent.effects,
      reviewViews: intent.reviewViews,
      constraints: intent.constraints,
    });
    const authority = createProceduralSceneAuthority({
      declaration,
      revision: intent.revision,
      projectId: intent.projectId,
      creatorRequestHash: intent.creatorRequestHash,
      referenceHashes: intent.referenceHashes,
      compiler: {
        blenderVersion: intent.compiler.blenderVersion,
        blenderBinarySha256: intent.compiler.blenderBinarySha256,
        workerSha256: intent.compiler.workerSha256,
        inspectorSha256: intent.compiler.inspectorSha256,
        operationSetSha256: intent.compiler.operationSetSha256,
        exportProfileSha256: intent.compiler.exportProfileSha256,
      },
    });
    assert.equal(authority.provenance[0]?.authority, "creator");
    assert.equal(
      authority.expectedOutputs.filter((output) => output.kind === "manifest").length,
      1,
    );
    const authoring = new VisualWorldAuthoringStore(root);
    const created = await authoring.createDraft({
      workflowId: "workflow-authoring-fixture",
      projectId: intent.projectId,
      actionInstanceId: "action-create",
      creatorRequestHash: intent.creatorRequestHash,
      declaration,
      authority,
      retainedAt: NOW,
    });
    const solved = await authoring.solveDraft({
      workflowId: "workflow-authoring-fixture",
      expectedEventHash: created.event.hash,
      actionInstanceId: "action-solve",
      draft: created.binding,
      solvedAt: "2026-09-07T00:00:01.000Z",
    });
    assert.equal(solved.status, "eligible", JSON.stringify(solved));
    if (solved.status !== "eligible") return;
    const proposed = await authoring.propose({
      workflowId: "workflow-authoring-fixture",
      expectedEventHash: solved.event.hash,
      actionInstanceId: "action-propose",
      solved: solved.binding,
      projectRevisionHash: "1".repeat(64),
      agentRunId: "agent-run-authoring-fixture",
      agentRunHash: "2".repeat(64),
      sourceConsultationHash: "3".repeat(64),
      intendedImplementation: "Compile the exact solved scene before native planning.",
      proposedAt: "2026-09-07T00:00:02.000Z",
    });
    assert.equal(proposed.proposal.agentRunHash, "2".repeat(64));
    assert.equal(proposed.proposal.solvedScene.hash, solved.solved.scene.hash);
    const restarted = new VisualWorldAuthoringStore(root);
    assert.equal((await restarted.workflow.current("workflow-authoring-fixture")).to, "proposed");
    assert.equal((await restarted.readSolved(solved.binding)).hash, solved.solved.hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
