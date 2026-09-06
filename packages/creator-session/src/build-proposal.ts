import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertArtifactReference,
  type ArtifactReference,
  type ImmutableJsonArtifactStore,
} from "../../artifact-store/src/index.js";
import {
  assertCreatorApproval,
  assertCreatorBuildContract,
  assertCreatorPlan,
  type CreatorPlan,
} from "./index.js";
import {
  assertCreatorBuildRecovery,
  loadCreatorBuildRecovery,
  replayCreatorBuildRecoverySources,
  type CreatorBuildRecovery,
} from "./build-recovery.js";
import {
  assertCreatorSourceMemberDiagnosticFrame,
  type CreatorSourceMemberDiagnosticFrame,
} from "./source-repair-obligations.js";

/** Historical source material offered to a new plan, never inherited mutation authority. */
export interface CreatorBuildProposal {
  kind: "CreatorBuildProposal";
  id: string;
  hash: string;
  planId: string;
  planHash: string;
  predecessor: {
    plan: ArtifactReference;
    approval: ArtifactReference;
    contract: ArtifactReference;
    recovery: ArtifactReference;
  };
  input: { sources: { slotId: string; source: string }[]; summary: string };
  sourceMemberHistory: CreatorSourceMemberDiagnosticFrame[];
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z
  .object({
    kind: z.literal("CreatorBuildProposal"),
    id: z.string().min(1),
    hash,
    planId: z.string().min(1),
    planHash: hash,
    predecessor: z
      .object({
        plan: z.unknown(),
        approval: z.unknown(),
        contract: z.unknown(),
        recovery: z.unknown(),
      })
      .strict(),
    input: z
      .object({
        sources: z.array(z.object({ slotId: z.string().min(1), source: z.string() }).strict()),
        summary: z.string().min(1),
      })
      .strict(),
    sourceMemberHistory: z.array(z.unknown()),
  })
  .strict();
export function assertCreatorBuildProposal(value: unknown): asserts value is CreatorBuildProposal {
  schema.parse(value);
  const proposal = value as CreatorBuildProposal;
  for (const reference of Object.values(proposal.predecessor)) assertArtifactReference(reference);
  for (const frame of proposal.sourceMemberHistory) assertCreatorSourceMemberDiagnosticFrame(frame);
  if (
    new Set(proposal.sourceMemberHistory.map((frame) => stableJson(frame))).size !==
    proposal.sourceMemberHistory.length
  )
    throw new Error("Source proposal repeats a member diagnostic frame");
  if (
    proposal.sourceMemberHistory.some(
      (frame) => !proposal.input.sources.some((source) => source.slotId === frame.slotId),
    )
  )
    throw new Error("Source proposal member history is outside its declared sources");
  if (
    new Set(proposal.input.sources.map((source) => source.slotId)).size !==
    proposal.input.sources.length
  )
    throw new Error("Source proposal repeats a slot");
  const { id, hash: digest, ...payload } = proposal;
  const expected = contentHash(stableJson(payload));
  if (digest !== expected || id !== "creator_build_proposal_" + expected.slice(0, 24))
    throw new Error("Source proposal identity mismatch");
}
function equivalentSlots(before: CreatorPlan, after: CreatorPlan): void {
  assertCreatorPlan(before);
  assertCreatorPlan(after);
  if (
    before.sessionId === after.sessionId ||
    before.hash === after.hash ||
    before.projectId !== after.projectId ||
    before.promptHash !== after.promptHash ||
    before.compiled.compilerAbi !== after.compiled.compilerAbi ||
    before.compiled.manifestHash !== after.compiled.manifestHash ||
    stableJson(before.compiled.design) !== stableJson(after.compiled.design) ||
    stableJson(before.compiled.inventory) !== stableJson(after.compiled.inventory) ||
    before.compiled.inventory.some(
      (item) => item.change.kind !== "create" || item.valueSlots.length > 0,
    ) ||
    before.compiled.observedSources.length > 0
  )
    throw new Error(
      "Source proposal requires exact unchanged pure-create source interfaces, inventory and locks without value slots",
    );
}
async function deriveInput(
  store: ImmutableJsonArtifactStore,
  plan: CreatorPlan,
  recovery: CreatorBuildRecovery,
): Promise<Pick<CreatorBuildProposal, "input" | "sourceMemberHistory">> {
  const slots = new Map(
    plan.compiled.inventory
      .filter((item) => item.source?.content.kind === "slot")
      .map((item) => [item.id, item.source!.content]),
  );
  let initialProposal: CreatorBuildProposal | undefined;
  if (recovery.initialProposal) {
    // loadCreatorBuildRecovery already verified this entire provenance chain.
    // Read its immutable bytes once here rather than recursively verifying the
    // same predecessor a second time at every generation of the lineage.
    const prior = await store.read(recovery.initialProposal, assertCreatorBuildProposal);
    if (prior.planId !== plan.id || prior.planHash !== plan.hash)
      throw new Error("Initial proposed source binding changed");
    initialProposal = prior;
  }
  for (const call of recovery.calls) {
    const input = call.input as { values?: unknown[]; repairs?: { kind: string }[] };
    if (input.values?.length) throw new Error("Source proposal cannot carry property material");
    if (input.repairs?.some((repair) => repair.kind !== "source"))
      throw new Error("Source proposal contains unsupported historical repairs");
  }
  const { sources, summary, sourceMemberHistory } = replayCreatorBuildRecoverySources(
    recovery,
    initialProposal,
  );
  if (
    sources.size !== slots.size ||
    [...sources].some(
      ([id, source]) =>
        !slots.has(id) ||
        typeof source !== "string" ||
        Buffer.byteLength(source) >
          (slots.get(id) as { maximumUtf8Bytes: number }).maximumUtf8Bytes,
    ) ||
    !summary
  )
    throw new Error("Source proposal does not completely fill the exact declared source slots");
  return {
    input: {
      sources: [...sources]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([slotId, source]) => ({ slotId, source })),
      summary,
    },
    sourceMemberHistory,
  };
}
export async function createCreatorBuildProposal(input: {
  store: ImmutableJsonArtifactStore;
  plan: CreatorPlan;
  predecessor: CreatorBuildProposal["predecessor"];
}): Promise<CreatorBuildProposal> {
  const prior = await input.store.read(input.predecessor.plan, assertCreatorPlan);
  equivalentSlots(prior, input.plan);
  const approval = await input.store.read(input.predecessor.approval, assertCreatorApproval);
  const contract = await input.store.read(input.predecessor.contract, assertCreatorBuildContract);
  const retained = await input.store.read(input.predecessor.recovery, assertCreatorBuildRecovery);
  const recovery = await loadCreatorBuildRecovery({
    store: input.store,
    artifact: input.predecessor.recovery,
    expected: retained.binding,
    plan: prior,
    approval,
    contract,
  });
  const proposed = await deriveInput(input.store, prior, recovery);
  const payload = {
    kind: "CreatorBuildProposal" as const,
    planId: input.plan.id,
    planHash: input.plan.hash,
    predecessor: input.predecessor,
    ...proposed,
  };
  const digest = contentHash(stableJson(payload));
  const proposal = {
    ...payload,
    id: "creator_build_proposal_" + digest.slice(0, 24),
    hash: digest,
  };
  assertCreatorBuildProposal(proposal);
  return proposal;
}
export async function loadCreatorBuildProposal(input: {
  store: ImmutableJsonArtifactStore;
  artifact: ArtifactReference;
  plan: CreatorPlan;
}): Promise<CreatorBuildProposal> {
  const proposal = await input.store.read(input.artifact, assertCreatorBuildProposal);
  if (proposal.planId !== input.plan.id || proposal.planHash !== input.plan.hash)
    throw new Error("Source proposal belongs to another newly reviewed plan");
  const derived = await createCreatorBuildProposal({ ...input, predecessor: proposal.predecessor });
  if (stableJson(derived) !== stableJson(proposal))
    throw new Error("Source proposal differs from verified predecessor source provenance");
  return proposal;
}
