import { contentHash, stableJson } from "../../contracts/src/index.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertArtifactReference,
  assertSafeAbsoluteDirectory,
  isNodeError,
  type ArtifactReference,
  type ImmutableJsonArtifactStore,
} from "../../artifact-store/src/index.js";
import {
  AgentExecutionJournalStore,
  assertAgentRun,
  assertAgentExecutionJournalHead,
  type AgentExecutionJournalHead,
} from "../../agent-runtime/src/index.js";
import {
  assertCreatorSessionBundle,
  verifyCreatorBundleArtifacts,
  type CreatorSessionBundle,
} from "./index.js";
import { replayCreatorMutation } from "./mutation-evidence.js";
import { replayCreatorVerification } from "./verification.js";

export const CREATOR_REGRESSION_BOUNDS = Object.freeze({
  maximumArtifacts: 4096,
  maximumAggregateBytes: 128 * 1024 * 1024,
  maximumJsonNodes: 1_000_000,
  maximumJsonDepth: 128,
});
const LIMITATIONS = [
  "This is a reference-based regression in the original creator artifact store, not a portable export. All referenced immutable leaves must remain available; mutable journal heads are not replay inputs.",
  "Replay validates retained host contracts and evidence. It makes zero model, Studio, candidate-code, compiler-subprocess or network calls and does not rerun gameplay or claim native success.",
  "A complete artifact closure is not proof that an interrupted model request or native transaction completed. Missing and incomplete evidence stays incomplete.",
];
export interface CreatorOfflineRegression {
  kind: "CreatorOfflineRegression";
  id: string;
  hash: string;
  sessionId: string;
  sessionHash: string;
  bundle: ArtifactReference;
  classification: ReturnType<typeof failureClassification>;
  journals: Array<{ journalId: string; head?: ArtifactReference; issue?: string }>;
  closure: {
    status: "complete" | "incomplete";
    references: Array<{
      artifact: ArtifactReference;
      status: "verified" | "unavailable";
      issue?: string;
    }>;
    bytes: number;
    issues: string[];
  };
  bounds: typeof CREATOR_REGRESSION_BOUNDS;
  limitations: string[];
}
export interface CreatorOfflineRegressionReplay {
  kind: "CreatorOfflineRegressionReplay";
  result: "exact_match" | "mismatch" | "incomplete";
  artifact: ArtifactReference;
  regressionId?: string;
  classification?: CreatorOfflineRegression["classification"];
  checks: Array<{
    kind: string;
    id: string;
    result: "exact_match" | "mismatch" | "incomplete";
    detail?: string;
  }>;
  issues: string[];
  limitations: readonly string[];
}

/** Persist an immutable snapshot only after a failed generation transition. */
export async function captureCreatorOfflineRegression(input: {
  bundle: CreatorSessionBundle;
  store: ImmutableJsonArtifactStore;
}): Promise<
  | { status: "not_failed" }
  | {
      status: "captured";
      manifest: CreatorOfflineRegression;
      artifact: ArtifactReference;
      pointer: { locator: string; artifactHash: string; bytes: number };
    }
> {
  const { store } = input;
  if (!failedGeneration(input.bundle)) return { status: "not_failed" };
  const bundle = structuredClone(input.bundle);
  assertCreatorSessionBundle(bundle);
  const bundleReference = await store.write(bundle);
  const journals: CreatorOfflineRegression["journals"] = [];
  const journalIds = new Set(
    bundle.preparationFailure ? [bundle.preparationFailure.execution.journalId] : [],
  );
  let runBytes = 0;
  for (const run of bundle.agentRuns) {
    runBytes += run.agentRun.bytes;
    if (
      runBytes > CREATOR_REGRESSION_BOUNDS.maximumAggregateBytes ||
      journalIds.size >= CREATOR_REGRESSION_BOUNDS.maximumArtifacts
    )
      break;
    try {
      const material = await store.read(run.agentRun, assertAgentRun);
      if (material.executionJournal) journalIds.add(material.executionJournal.journalId);
    } catch {
      /* The closure records the exact missing or invalid artifact below. */
    }
  }
  for (const journalId of [...journalIds].sort()) {
    try {
      const head = await new AgentExecutionJournalStore(store).readHead(journalId);
      if (head) journals.push({ journalId, head: await store.write(head) });
      else journals.push({ journalId, issue: "Execution journal was not retained at capture" });
    } catch (error) {
      journals.push({ journalId, issue: detail(error, store.root) });
    }
  }
  const closure = await collectArtifactClosure(store, [
    bundleReference,
    ...journals.flatMap((journal) => (journal.head ? [journal.head] : [])),
  ]);
  const payload = {
    kind: "CreatorOfflineRegression" as const,
    sessionId: bundle.session.id,
    sessionHash: bundle.session.hash,
    bundle: bundleReference,
    classification: failureClassification(bundle),
    journals,
    closure,
    bounds: CREATOR_REGRESSION_BOUNDS,
    limitations: LIMITATIONS,
  };
  const hash = contentHash(stableJson(payload));
  const manifest: CreatorOfflineRegression = {
    ...payload,
    id: "creator_regression_" + hash.slice(0, 24),
    hash,
  };
  const artifact = await store.write(manifest);
  const pointer = await publishRegressionPointer(store, manifest, artifact);
  return { status: "captured", manifest, artifact, pointer };
}

/** Read-only replay. No worker, provider, native bridge or Luau runner is accepted. */
export async function replayCreatorOfflineRegression(input: {
  artifact: ArtifactReference;
  store: ImmutableJsonArtifactStore;
}): Promise<CreatorOfflineRegressionReplay> {
  const report: CreatorOfflineRegressionReplay = {
    kind: "CreatorOfflineRegressionReplay",
    result: "exact_match",
    artifact: input.artifact,
    checks: [],
    issues: [],
    limitations: LIMITATIONS,
  };
  const add = (
    kind: string,
    id: string,
    result: "exact_match" | "mismatch" | "incomplete",
    message?: string,
  ) => {
    report.checks.push({
      kind,
      id,
      result,
      ...(message ? { detail: message.split(input.store.root).join("<creator-store>") } : {}),
    });
    if (result === "mismatch") report.result = "mismatch";
    else if (result === "incomplete" && report.result !== "mismatch") report.result = "incomplete";
  };
  try {
    const manifest = await input.store.read(input.artifact, assertCreatorOfflineRegression);
    report.regressionId = manifest.id;
    report.classification = manifest.classification;
    const closure = await collectArtifactClosure(input.store, [
      manifest.bundle,
      ...manifest.journals.flatMap((journal) => (journal.head ? [journal.head] : [])),
    ]);
    if (manifest.closure.status !== "complete" || closure.status !== "complete")
      add(
        "artifact_closure",
        manifest.id,
        "incomplete",
        [...manifest.closure.issues, ...closure.issues].join("; ") ||
          "The captured closure contains unavailable leaves",
      );
    else
      add(
        "artifact_closure",
        manifest.id,
        stableJson(closure) === stableJson(manifest.closure) ? "exact_match" : "mismatch",
        "Recursively verified content-addressed artifacts",
      );
    // Existing semantic validators may follow many leaves. Admit their complete
    // immutable closure under this host budget before invoking them.
    if (manifest.closure.status !== "complete" || closure.status !== "complete") return report;
    const bundle = await input.store.read<CreatorSessionBundle>(manifest.bundle);
    assertCreatorSessionBundle(bundle);
    add(
      "failure_classification",
      bundle.session.id,
      bundle.session.hash === manifest.sessionHash &&
        bundle.session.id === manifest.sessionId &&
        stableJson(failureClassification(bundle)) === stableJson(manifest.classification) &&
        failedGeneration(bundle)
        ? "exact_match"
        : "mismatch",
    );
    const journalHeads = new Map<string, AgentExecutionJournalHead>();
    for (const journal of manifest.journals) {
      if (!journal.head) {
        add("execution_journal", journal.journalId, "incomplete", journal.issue);
        continue;
      }
      try {
        const head = await input.store.read(journal.head, assertAgentExecutionJournalHead);
        const loaded = await new AgentExecutionJournalStore(input.store).loadFromHead(head);
        if (head.journalId !== journal.journalId)
          throw new Error("Captured journal head belongs to a different execution");
        journalHeads.set(journal.journalId, head);
        add(
          "execution_journal",
          journal.journalId,
          stableJson(head) === stableJson(loaded.head) ? "exact_match" : "mismatch",
          "Existing hash-chain and checkpoint-order validator replayed the retained journal",
        );
      } catch (error) {
        add("execution_journal", journal.journalId, "incomplete", detail(error));
      }
    }
    try {
      await verifyCreatorBundleArtifacts(bundle, input.store, {
        verifyAgentJournal: async (run, store) => {
          const binding = run.executionJournal;
          if (!binding) throw new Error("Creator AgentRun requires its retained execution journal");
          const head = journalHeads.get(binding.journalId);
          if (!head) throw new Error("AgentRun journal head was not captured");
          const loaded = await new AgentExecutionJournalStore(store).loadFromHead(head);
          const terminal = loaded.entries.at(-1);
          if (
            head.sequence !== binding.sequence ||
            head.entryHash !== binding.entryHash ||
            stableJson(head.entry) !== stableJson(binding.entry) ||
            terminal?.checkpoint.checkpointType !== "terminal" ||
            contentHash(stableJson(terminal.checkpoint.result)) !== binding.terminalResultHash
          )
            throw new Error("AgentRun differs from its immutable terminal journal binding");
          return loaded;
        },
      });
      add(
        "host_bundle_contracts",
        bundle.session.id,
        "exact_match",
        "Existing plan/build, checkpoint prefix, source, agent journal and mutation artifact bindings revalidated",
      );
    } catch (error) {
      add("host_bundle_contracts", bundle.session.id, "incomplete", detail(error));
    }
    for (const attempt of bundle.mutationAttempts) {
      const replay = await replayCreatorMutation(attempt, input.store);
      add(
        "mutation",
        attempt.id,
        replay.result === "missing_or_incomplete" ? "incomplete" : replay.result,
        replay.detail,
      );
    }
    for (const verification of bundle.verifications) {
      const replay = await replayCreatorVerification(bundle, verification, input.store);
      add(
        "verification",
        verification.id,
        replay.result === "missing_or_incomplete" ? "incomplete" : replay.result,
        replay.detail,
      );
    }
  } catch (error) {
    report.issues.push(detail(error, input.store.root));
    if (report.result !== "mismatch") report.result = "incomplete";
  }
  return report;
}

export function assertCreatorOfflineRegression(
  value: unknown,
): asserts value is CreatorOfflineRegression {
  if (
    !record(value) ||
    value.kind !== "CreatorOfflineRegression" ||
    typeof value.hash !== "string" ||
    !record(value.closure) ||
    !Array.isArray(value.closure.references) ||
    !Array.isArray(value.journals) ||
    stableJson(value.bounds) !== stableJson(CREATOR_REGRESSION_BOUNDS) ||
    stableJson(value.limitations) !== stableJson(LIMITATIONS)
  )
    throw new Error("Invalid CreatorOfflineRegression");
  const { id, hash, ...payload } = value;
  if (hash !== contentHash(stableJson(payload)) || id !== "creator_regression_" + hash.slice(0, 24))
    throw new Error("Offline regression content binding mismatch");
  assertArtifactReference(value.bundle);
  if (
    value.closure.references.length > CREATOR_REGRESSION_BOUNDS.maximumArtifacts ||
    !["complete", "incomplete"].includes(String(value.closure.status))
  )
    throw new Error("Invalid offline regression closure");
  for (const row of value.closure.references) {
    if (!record(row) || !["verified", "unavailable"].includes(String(row.status)))
      throw new Error("Invalid offline regression closure entry");
    assertArtifactReference(row.artifact);
  }
  for (const journal of value.journals) {
    if (!record(journal) || typeof journal.journalId !== "string")
      throw new Error("Invalid offline regression journal");
    if (journal.head !== undefined) assertArtifactReference(journal.head);
  }
}

function failedGeneration(bundle: CreatorSessionBundle): boolean {
  return (
    bundle.preparationFailure !== undefined ||
    bundle.session.failure !== undefined ||
    ["incomplete", "recovery_required", "rolled_back"].includes(bundle.session.status) ||
    bundle.agentRuns.at(-1)?.outcome.status === "unsealed" ||
    bundle.gameBuilds?.at(-1)?.status === "incomplete"
  );
}
function failureClassification(bundle: CreatorSessionBundle) {
  return {
    sessionStatus: bundle.session.status,
    ...(bundle.session.failure ? { sessionFailure: bundle.session.failure } : {}),
    ...(bundle.preparationFailure
      ? {
          preparation: {
            stage: bundle.preparationFailure.failure.stage,
            code: bundle.preparationFailure.failure.code,
            detailHash: contentHash(bundle.preparationFailure.failure.detail),
          },
        }
      : {}),
    agentRuns: bundle.agentRuns.map((run) => ({
      phase: run.phase,
      agentRunId: run.agentRunId,
      outcome: run.outcome,
    })),
    builds: (bundle.gameBuilds ?? []).map((build) => ({
      hash: build.graph.hash,
      status: build.status,
    })),
    mutations: bundle.mutationAttempts.map((attempt) => ({
      id: attempt.id,
      hash: attempt.hash,
      completion: attempt.completion,
      ...(attempt.completion === "incomplete"
        ? { failureFactHashes: attempt.failureFacts.map((fact) => fact.hash) }
        : { reconciliation: attempt.reconciliation }),
    })),
    verifications: bundle.verifications.map((verification) => ({
      id: verification.id,
      hash: verification.hash,
      status: verification.status,
      failureFactHashes: verification.failureFacts.map((fact) => fact.hash),
    })),
  };
}

async function collectArtifactClosure(
  store: ImmutableJsonArtifactStore,
  roots: ArtifactReference[],
): Promise<CreatorOfflineRegression["closure"]> {
  const references: CreatorOfflineRegression["closure"]["references"] = [];
  const issues: string[] = [];
  const pending = [...roots];
  const seen = new Map<string, ArtifactReference>();
  let bytes = 0,
    nodes = 0;
  let next = 0;
  while (next < pending.length) {
    const artifact = pending[next++]!;
    const previous = seen.get(artifact.artifactHash);
    if (previous) {
      if (stableJson(previous) !== stableJson(artifact))
        issues.push("Conflicting artifact references share one content hash");
      continue;
    }
    if (
      seen.size >= CREATOR_REGRESSION_BOUNDS.maximumArtifacts ||
      bytes + artifact.bytes > CREATOR_REGRESSION_BOUNDS.maximumAggregateBytes
    ) {
      issues.push("Artifact closure resource bound exceeded");
      break;
    }
    seen.set(artifact.artifactHash, artifact);
    bytes += artifact.bytes;
    try {
      const value = await store.read(artifact);
      references.push({ artifact, status: "verified" });
      const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
      while (queue.length) {
        const current = queue.pop()!;
        if (
          ++nodes > CREATOR_REGRESSION_BOUNDS.maximumJsonNodes ||
          current.depth > CREATOR_REGRESSION_BOUNDS.maximumJsonDepth
        )
          throw new Error("Artifact JSON traversal resource bound exceeded");
        if (Array.isArray(current.value)) {
          for (const value of current.value) queue.push({ value, depth: current.depth + 1 });
          continue;
        }
        if (!record(current.value)) continue;
        // Only exact structured references are followed. Strings/source text and
        // other locators are never interpreted as files, commands or code.
        if (
          "artifactHash" in current.value &&
          "bytes" in current.value &&
          "locator" in current.value
        ) {
          if (Object.keys(current.value).sort().join(",") !== "artifactHash,bytes,locator")
            throw new Error("Noncanonical artifact reference prevents complete closure admission");
          assertArtifactReference(current.value);
          pending.push(current.value);
        } else
          for (const value of Object.values(current.value))
            queue.push({ value, depth: current.depth + 1 });
      }
    } catch (error) {
      const message = detail(error, store.root);
      const row = references.find((row) => row.artifact.artifactHash === artifact.artifactHash);
      if (row) {
        row.status = "unavailable";
        row.issue = message;
      } else references.push({ artifact, status: "unavailable", issue: message });
      issues.push(message);
      if (nodes > CREATOR_REGRESSION_BOUNDS.maximumJsonNodes) break;
    }
  }
  return {
    status: issues.length ? "incomplete" : "complete",
    references: references.sort((a, b) =>
      a.artifact.artifactHash.localeCompare(b.artifact.artifactHash),
    ),
    bytes,
    issues: [...new Set(issues)].sort(),
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function detail(error: unknown, root?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (root ? message.split(root).join("<creator-store>") : message).slice(0, 2048);
}

/** Private, immutable discovery pointer. It is outside the bundle/closure graph. */
async function publishRegressionPointer(
  store: ImmutableJsonArtifactStore,
  manifest: CreatorOfflineRegression,
  artifact: ArtifactReference,
): Promise<{ locator: string; artifactHash: string; bytes: number }> {
  await assertSafeAbsoluteDirectory(store.root);
  const directory = join(store.root, "offline-regressions");
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (!isNodeError(error, "EEXIST")) throw error;
  });
  await assertSafeAbsoluteDirectory(directory);
  const locator = `offline-regressions/${manifest.sessionHash}-${manifest.bundle.artifactHash}-${artifact.artifactHash}.json`;
  const destination = join(store.root, locator);
  const serialized =
    stableJson({
      kind: "CreatorOfflineRegressionPointer",
      sessionId: manifest.sessionId,
      sessionHash: manifest.sessionHash,
      bundleHash: manifest.bundle.artifactHash,
      manifest: artifact,
    }) + "\n";
  const bytes = Buffer.byteLength(serialized);
  if (bytes > 4096) throw new Error("Offline regression pointer exceeds host bound");
  const temporary = join(directory, "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await link(temporary, destination);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.size !== bytes ||
          info.size > 4096 ||
          (await file.readFile({ encoding: "utf8" })) !== serialized
        )
          throw new Error("Offline regression pointer is not the exact immutable snapshot");
      } finally {
        await file.close();
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }
  return { locator, artifactHash: contentHash(serialized), bytes };
}
