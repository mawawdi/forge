import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import { ImmutableJsonArtifactStore } from "../packages/artifact-store/src/index.js";
import {
  advanceSession,
  assertCreatorSessionBundle,
  createCreatorApproval,
  type CreatorSessionBundle,
} from "../packages/creator-session/src/index.js";
import { writeCreatorProjectIndexArtifacts } from "../packages/creator-session/src/project-refresh.js";
import {
  creatorPlanRefreshIsReadOnly,
  verifyCreatorPlanRefreshLineage,
} from "../packages/creator-session/src/plan-refresh-lineage.js";
import { CreatorSessionCoordinator } from "../packages/creator-session/src/coordinator.js";
import { creatorPlanRecompilationFixture } from "./helpers/creator-plan-recompilation-fixture.js";

test("refresh lineage retains an accepted ancestor through an interrupted successor without inheriting authority", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "forge-refresh-lineage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ImmutableJsonArtifactStore(directory);
  const fixture = creatorPlanRecompilationFixture();
  const leaf = await store.write({ kind: "OfflineAnalysisFixture" });
  async function bundle(current: boolean): Promise<CreatorSessionBundle> {
    const facts = current ? fixture : fixture.previous;
    const capture = current ? fixture.afterCapture : fixture.beforeCapture;
    const creatorRequest = await store.write({
      kind: "CreatorRequest",
      sessionId: facts.session.id,
      promptHash: facts.session.promptHash,
      creatorText: fixture.creatorPrompt,
      agentPrompt: fixture.creatorPrompt,
      contextCitations: [],
    });
    return {
      session: facts.session,
      ownership: facts.ownership,
      creatorRequest,
      projectIndices: [await writeCreatorProjectIndexArtifacts(store, capture)],
      projectChanges: [],
      projectRefreshes: [],
      rojoSourceMutations: [],
      sourceWriteBlobs: [],
      sourceIndices: [
        {
          id: facts.sourceIndex.id,
          hash: facts.sourceIndex.hash,
          artifact: await store.write(facts.sourceIndex),
          analysis: { id: "analysis-fixture", hash: contentHash("analysis"), artifact: leaf },
        },
      ],
      sourceConsultations: [
        {
          id: facts.sourceConsultation.id,
          hash: facts.sourceConsultation.hash,
          indexId: facts.sourceIndex.id,
          indexHash: facts.sourceIndex.hash,
          artifact: await store.write(facts.sourceConsultation),
        },
      ],
      buildContracts: [],
      approvals: [],
      changeSets: [],
      mutationAttempts: [],
      verifications: [],
      agentRuns: [],
    };
  }
  let origin = await bundle(false);
  let latest = await bundle(true);
  const approval = createCreatorApproval({
    sessionId: origin.session.id,
    artifactKind: "plan",
    artifactId: fixture.previousPlan.id,
    artifactHash: fixture.previousPlan.hash,
    decision: "approved",
    decidedAt: "2026-09-06T12:00:00.000Z",
  });
  origin = {
    ...origin,
    plan: fixture.previousPlan,
    approvals: [approval],
    successorSessionId: latest.session.id,
    session: advanceSession(
      advanceSession(
        advanceSession(
          advanceSession(
            advanceSession(advanceSession(origin.session, { status: "planning" }), {
              status: "awaiting_plan_approval",
              plan: fixture.previousPlan,
            }),
            { status: "building", approval },
          ),
          { status: "incomplete" },
        ),
        { status: "refresh_required" },
      ),
      { status: "refreshing" },
    ),
  };
  origin = { ...origin, session: advanceSession(origin.session, { status: "superseded" }) };
  latest = {
    ...latest,
    predecessorSessionId: origin.session.id,
    session: advanceSession(advanceSession(latest.session, { status: "planning" }), {
      status: "incomplete",
    }),
  };
  assertCreatorSessionBundle(origin);
  assertCreatorSessionBundle(latest);
  const originalRef = await store.write(origin);
  const latestRef = await store.write(latest);
  const input = {
    store,
    references: [latestRef, originalRef],
    immediatePredecessorSessionId: latest.session.id,
    plan: fixture.previousPlan,
  };
  assert.deepEqual(
    (await verifyCreatorPlanRefreshLineage(input)).map((item) => item.session.id),
    [latest.session.id, origin.session.id],
  );
  const harness = Object.assign(Object.create(CreatorSessionCoordinator.prototype), {
    bundles: new Map([
      [origin.session.id, origin],
      [latest.session.id, latest],
    ]),
  }) as {
    retainedRefreshPlan(
      bundle: CreatorSessionBundle,
    ): { origin: CreatorSessionBundle; lineage: CreatorSessionBundle[] } | undefined;
  };
  assert.equal(harness.retainedRefreshPlan(latest)?.origin.plan?.hash, fixture.previousPlan.hash);
  assert.equal(
    harness.retainedRefreshPlan({ ...latest, changeSets: [{}] } as CreatorSessionBundle),
    undefined,
  );
  for (const unsafe of [
    { activeMutation: {} },
    { closedMutation: {} },
    { mutationAttempts: [{}] },
    { rojoSourceMutations: [{}] },
    { changeSets: [{}] },
    { gameBuilds: [{}] },
    { projectAuthority: {} },
  ])
    assert.equal(
      creatorPlanRefreshIsReadOnly({ ...latest, ...unsafe } as CreatorSessionBundle),
      false,
    );
  await assert.rejects(
    () =>
      verifyCreatorPlanRefreshLineage({
        ...input,
        references: [latestRef, latestRef, originalRef],
      }),
    /lineage/,
  );
  await assert.rejects(
    () =>
      verifyCreatorPlanRefreshLineage({
        ...input,
        immediatePredecessorSessionId: origin.session.id,
      }),
    /immediate predecessor/,
  );
  const request = (await store.read(latest.creatorRequest)) as Record<string, unknown>;
  const changed = {
    ...latest,
    creatorRequest: await store.write({
      ...request,
      agentPrompt: fixture.creatorPrompt + " changed context",
    }),
  };
  const changedReference = await store.write(changed);
  await assert.rejects(
    () =>
      verifyCreatorPlanRefreshLineage({
        ...input,
        references: [changedReference, originalRef],
      }),
    /exact creator request/,
  );
  const detached = { ...origin, successorSessionId: "creator_session_unrelated" };
  const detachedReference = await store.write(detached);
  await assert.rejects(
    () =>
      verifyCreatorPlanRefreshLineage({
        ...input,
        references: [latestRef, detachedReference],
      }),
    /predecessor chain/,
  );
});
