import { stableJson } from "../../contracts/src/index.js";
import {
  type ArtifactReference,
  type ImmutableJsonArtifactStore,
} from "../../artifact-store/src/index.js";
import {
  assertCreatorSessionBundle,
  assertCreatorRequestArtifact,
  type CreatorPlan,
  type CreatorSessionBundle,
} from "./index.js";

export function creatorPlanRefreshIsReadOnly(bundle: CreatorSessionBundle): boolean {
  return (
    !bundle.activeMutation &&
    !bundle.closedMutation &&
    !bundle.projectAuthority &&
    bundle.mutationAttempts.length === 0 &&
    bundle.rojoSourceMutations.length === 0 &&
    bundle.changeSets.length === 0 &&
    (bundle.gameBuilds?.length ?? 0) === 0
  );
}

/** Exact immutable refresh ancestry, newest first. It supplies intent, never inherited approval. */
export async function verifyCreatorPlanRefreshLineage(input: {
  store: ImmutableJsonArtifactStore;
  references: readonly ArtifactReference[];
  immediatePredecessorSessionId: string;
  plan: CreatorPlan;
}): Promise<readonly CreatorSessionBundle[]> {
  if (input.references.length === 0 || input.references.length > 32)
    throw new Error("Plan recompilation requires 1–32 immutable refresh lineage entries");
  const bundles: CreatorSessionBundle[] = [];
  const ids = new Set<string>();
  for (const reference of input.references) {
    const bundle = await input.store.read(
      reference,
      (value): asserts value is CreatorSessionBundle =>
        assertCreatorSessionBundle(value as CreatorSessionBundle),
    );
    if (
      ids.has(bundle.session.id) ||
      !creatorPlanRefreshIsReadOnly(bundle) ||
      bundle.session.projectId !== input.plan.projectId ||
      bundle.session.promptHash !== input.plan.promptHash
    )
      throw new Error("Refresh lineage changes prompt, project, or native mutation authority");
    ids.add(bundle.session.id);
    bundles.push(bundle);
  }
  if (bundles[0]!.session.id !== input.immediatePredecessorSessionId)
    throw new Error("Refresh lineage does not begin at the immediate predecessor");
  const origin = bundles.at(-1)!;
  if (
    origin.session.id !== input.plan.sessionId ||
    stableJson(origin.plan) !== stableJson(input.plan)
  )
    throw new Error("Refresh lineage does not end at its exact retained plan");
  if (
    bundles.length > 1 &&
    !origin.approvals.some(
      (approval) =>
        approval.decision === "approved" &&
        approval.artifactKind === "plan" &&
        approval.artifactId === input.plan.id &&
        approval.artifactHash === input.plan.hash,
    )
  )
    throw new Error("Ancestor intent requires its historical accepted-plan provenance");
  const request = await input.store.read(origin.creatorRequest, assertCreatorRequestArtifact);
  for (let index = 0; index < bundles.length; index++) {
    const current = bundles[index]!;
    const currentRequest = await input.store.read(
      current.creatorRequest,
      assertCreatorRequestArtifact,
    );
    if (
      currentRequest.sessionId !== current.session.id ||
      currentRequest.promptHash !== input.plan.promptHash ||
      currentRequest.creatorText !== request.creatorText ||
      currentRequest.agentPrompt !== request.agentPrompt ||
      stableJson(currentRequest.contextCitations) !== stableJson(request.contextCitations) ||
      stableJson(currentRequest.visualObservations ?? []) !==
        stableJson(request.visualObservations ?? [])
    )
      throw new Error("Refresh lineage does not retain the exact creator request and context");
    const parent = bundles[index + 1];
    if (
      parent &&
      (current.predecessorSessionId !== parent.session.id ||
        parent.successorSessionId !== current.session.id ||
        current.plan !== undefined)
    )
      throw new Error("Refresh lineage is not an exact uninterrupted predecessor chain");
  }
  return bundles;
}
