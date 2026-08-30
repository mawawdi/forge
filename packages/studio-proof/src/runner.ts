import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { assertFixtureManifest, assertMechanicContract, assertPatchSet, contentHash, stableJson, type BuildTrace, type ForgeSpanName, type MechanicContract, type PatchSet, type ProofBundle } from "../../contracts/src/index.js";
import { applyPatchSet } from "../../patch-model/src/index.js";
import { assembleStaticSemanticProof } from "../../proofs/src/index.js";
import { createProjectSnapshot, FilesystemProjectSourceAdapter, mergeStudioObservation, type ProjectSemanticMap, type ProjectSnapshot, type StudioSnapshotObservation } from "../../semantic-map/src/index.js";
import { StudioBridgeClient, createBackendMessage, type StudioBridgeConnection, type StudioBridgeSession } from "../../studio-bridge/src/index.js";
import { COLLECT_FRUIT_HARNESS_HASH, COLLECT_FRUIT_HARNESS_ID, COLLECT_FRUIT_HARNESS_VERSION, COLLECT_SELL_HARNESS_HASH, COLLECT_SELL_HARNESS_ID, COLLECT_SELL_HARNESS_VERSION, STUDIO_PLUGIN_VERSION, type PluginToBackendMessage, type StudioPatchPlan } from "../../studio-protocol/src/index.js";
import { attachStudioProof, collectFruitTestPlan, collectSellTestPlan, StudioProofCapture, type StudioProofRun, type StudioTestPlan } from "./index.js";
import { verifyProject, type VerificationRun } from "../../verifier/src/index.js";
import type { CandidateArtifact } from "../../generation/src/index.js";

export type StudioFaultMode = "client-controlled-reward" | "client-controlled-payout";

/** Exact line budget for the bounded no-client-input payout fault mutation. */
export const CLIENT_CONTROLLED_PAYOUT_FAULT_BOUNDS = { maxAddedLines: 5, maxRemovedLines: 2 } as const;

export interface StudioVerifyOptions {
  projectRoot: string;
  contract: MechanicContract;
  host?: string;
  port?: number;
  /** Printed by `forge studio bridge`; authorizes this verifier against that bridge only. */
  controlToken: string;
  timeoutMs?: number;
  traceDirectory?: string;
  proofDirectory?: string;
  /** Explicitly runs one Forge-owned adversarial mutation. Fault runs are
   * expected to reject and rollback; they can never produce a verified commit. */
  fault?: StudioFaultMode;
  /** M3.25 seam: a candidate already preflighted on disk before any live Studio edit. */
  candidatePatchSet?: PatchSet;
  candidateVerification?: VerificationRun;
  candidateProjectRoot?: string;
  candidateArtifact?: CandidateArtifact;
  onReady?: (address: { host: string; port: number }) => void;
  onMessage?: (message: PluginToBackendMessage) => void;
}

/**
 * Runs the unchanged authoritative StudioProof protocol for an externally
 * compiled, typed PatchSet. The caller must have preflighted candidateProjectRoot
 * with official Luau and M2 before this function is invoked.
 */
export async function runStudioPatchVerification(options: StudioVerifyOptions & { candidatePatchSet: PatchSet; candidateVerification: VerificationRun; candidateProjectRoot: string }): Promise<StudioVerificationRun> {
  return runStudioVerification(options);
}

/** Selects an external candidate without evaluating fixture-only fallback code. */
export async function resolveStudioPatchSet(candidate: PatchSet | undefined, createFallback: () => Promise<PatchSet>): Promise<PatchSet> {
  return candidate ?? await createFallback();
}

/** Binds each source operation to the exact class observed for its stable ID. */
export function resolveStudioPatchTargets(patchSet: PatchSet, observation: StudioSnapshotObservation): StudioPatchPlan["targets"] {
  return patchSet.operations.map((operation, opIndex) => {
    const matches = observation.scripts.filter((script) => sourceContainerName(script.path) === sourceContainerName(operation.path));
    if (matches.length !== 1) throw new StudioVerificationError("PATCH_TARGET_MISSING", `The live Studio observation identifies ${matches.length} targets for ${operation.path}; exactly one is required.`, "rejected");
    const sourceTarget = matches[0]!;
    const instanceTarget = observation.instances.find((instance) => instance.stableId === sourceTarget.stableId);
    if (!instanceTarget || !["Script", "LocalScript", "ModuleScript"].includes(instanceTarget.className)) throw new StudioVerificationError("PATCH_TARGET_CLASS_MISMATCH", `The live Studio target for ${operation.path} is not an observed LuaSourceContainer.`, "rejected");
    return { opIndex, target: { stableId: sourceTarget.stableId, path: sourceTarget.path, className: instanceTarget.className, sourceHash: sourceTarget.sourceHash } };
  });
}

export interface StudioVerificationRun {
  kind: "StudioVerificationRun";
  schemaVersion: 1;
  status: "verified" | "rejected" | "incomplete";
  projectRoot: string;
  session: StudioBridgeSession;
  patchSet: PatchSet;
  patchSetHash: string;
  beforeSnapshot: ProjectSnapshot;
  afterSnapshot: ProjectSnapshot;
  testPlan: StudioTestPlan;
  studioProof: StudioProofRun;
  proofBundle: ProofBundle;
  proofRunPath?: string;
  trace?: BuildTrace;
  tracePath?: string;
  proofPath?: string;
  staticBefore: VerificationRun;
  staticAfter: VerificationRun;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function runStudioVerification(options: StudioVerifyOptions): Promise<StudioVerificationRun> {
  const root = resolve(options.projectRoot);
  assertMechanicContract(options.contract);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const adapter = new FilesystemProjectSourceAdapter();
  const manifestValue: unknown = JSON.parse(await readFile(join(root, "forge.fixture.json"), "utf8"));
  assertFixtureManifest(manifestValue);
  const manifest = manifestValue;
  const staticMap = await adapter.load({ root, manifest });
  const beforeSnapshot = adapter.snapshot(staticMap);
  const staticBefore = await verifyProject(root, options.traceDirectory ? { traceDirectory: options.traceDirectory, traceReferences: { mechanicContractId: options.contract.id } } : { traceReferences: { mechanicContractId: options.contract.id } });
  if (staticBefore.report.gate.status !== "verified" && !options.candidatePatchSet) throw new StudioVerificationError("STATIC_GATE_REJECTED", "Static verification rejected the Studio target before any live edit.", "rejected", staticBefore.report);

  const patchSet = await resolveStudioPatchSet(options.candidatePatchSet, async () => {
    // Generated seeds intentionally do not contain the fixture fallback's
    // source anchor, so this closure must stay lazy for external candidates.
    const fallback = options.fault
      ? createFaultMutation(staticMap, options.contract, options.fault)
      : await createSafeFallbackMutation(staticMap);
    return {
      kind: "PatchSet", schemaVersion: 1, id: `patch_studio_${randomUUID()}`, projectHash: beforeSnapshot.sourceHash, mechanicContractId: options.contract.id,
      operations: [{ type: "replace_text", path: fallback.source.path, beforeHash: contentHash(fallback.source.source), before: fallback.source.source, after: fallback.after }],
      expectedEffects: [{ statement: fallback.effect, evidence: "static" }, { statement: `Studio executes the ${options.contract.name === "SellInventory" ? "combined CollectFruit and SellInventory" : "CollectFruit"} assertions against the patched place.`, evidence: "studio" }],
      provenance: { generatedAt: new Date().toISOString() }, bounds: { maxFiles: 1, ...fallback.bounds }
    };
  });
  assertPatchSet(patchSet);
  if (patchSet.mechanicContractId !== options.contract.id || patchSet.projectHash !== beforeSnapshot.sourceHash || patchSet.operations.some((operation) => operation.type !== "replace_text")) {
    throw new StudioVerificationError("CANDIDATE_PATCH_REJECTED", "StudioProof requires a current typed replace_text PatchSet bound to this exact seed snapshot and primary contract.", "rejected");
  }
  const replaceOperations = patchSet.operations as Array<Extract<PatchSet["operations"][number], { type: "replace_text" }>>;
  const afterSources = new Map(replaceOperations.map((operation) => [operation.path, operation.after]));
  const patchSetHash = contentHash(stableJson(patchSet));
  const mechanicContractHash = contentHash(stableJson(options.contract));

  const bridge = new StudioBridgeClient({ ...(options.host ? { host: options.host } : {}), ...(options.port !== undefined ? { port: options.port } : {}), controlToken: options.controlToken });
  const messages: PluginToBackendMessage[] = [];
  let session: StudioBridgeSession | undefined;
  let liveMap: ProjectSemanticMap | undefined;
  let liveAfterSnapshot: ProjectSnapshot | undefined;
  let capture: StudioProofCapture | undefined;
  let transactionActive = false;
  let transactionId: string | undefined;
  let unsubscribe = () => {};
  const acceptBridgeMessage = (message: PluginToBackendMessage, messageSession: StudioBridgeSession) => {
    messages.push(message);
    options.onMessage?.(message);
    if (!session) session = messageSession;
    if (session.sessionId !== messageSession.sessionId || message.sessionId !== messageSession.sessionId) return;
    if (message.type === "ProjectObservation") {
      if (message.payload.project.placeId !== messageSession.project.placeId || message.payload.project.universeId !== messageSession.project.universeId) return;
      liveMap = mergeStudioObservation(staticMap, message.payload.observation);
      liveAfterSnapshot = createProjectSnapshot(liveMap);
    }
    if (capture) {
      try { capture.accept(message); } catch { /* malformed or duplicate proof evidence is handled as an incomplete run below */ }
    }
  };

  try {
    options.onReady?.({ host: options.host ?? "127.0.0.1", port: options.port ?? 8787 });
    const connectedSession = await bridge.waitForSession(timeoutMs);
    if (connectedSession.pluginVersion !== STUDIO_PLUGIN_VERSION) throw new StudioVerificationError("PLUGIN_VERSION_MISMATCH", `StudioProof requires ${STUDIO_PLUGIN_VERSION}; connected session reports ${connectedSession.pluginVersion}. Restart the bridge and reload the current plugin.`, "incomplete");
    session = connectedSession;
    unsubscribe = bridge.subscribeWithSession(acceptBridgeMessage);
    const observationRequestId = `request_${randomUUID()}`;
    await bridge.send(createBackendMessage("RequestObservation", { requestId: observationRequestId, reason: "pre_patch" }, connectedSession.sessionId));
    const snapshotMessage = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "ProjectObservation" }> => message.type === "ProjectObservation" && message.sessionId === connectedSession.sessionId && message.payload.reason === "pre_patch", timeoutMs, "fresh pre-patch Studio observation");
    if (!connectedSession) throw new StudioVerificationError("SESSION_MISSING", "Studio sent a snapshot without a paired session.", "incomplete");
    if (!liveMap || !liveAfterSnapshot) throw new StudioVerificationError("LIVE_SNAPSHOT_MISSING", "The paired Studio observation could not be mapped to a canonical ProjectSnapshot.", "incomplete");
    const pluginRevision = snapshotMessage.payload.revision.observationHash;
    const conflictingHarnesses = snapshotMessage.payload.observation.scripts.filter((script) =>
      /(?:^|\/)__ForgeStudioProof/i.test(script.path),
    );
    if (conflictingHarnesses.length > 0) {
      throw new StudioVerificationError("STALE_STUDIO_HARNESS", `The open Studio place contains a conflicting client test harness (${conflictingHarnesses.map((script) => script.path).join(", ")}). Close Studio, reopen the freshly rebuilt CollectFruit place, and pair it again.`, "rejected");
    }

    transactionId = `studio_tx_${randomUUID()}`;
    await bridge.send(createBackendMessage("BeginTransaction", { requestId: `request_${randomUUID()}`, transactionId, expectedRevision: pluginRevision }, connectedSession.sessionId));
    await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "TransactionStarted" }> => message.type === "TransactionStarted" && message.payload.transactionId === transactionId, timeoutMs, "transaction start acknowledgement");
    transactionActive = true;

    const targets = resolveStudioPatchTargets(patchSet, snapshotMessage.payload.observation);
    await bridge.send(createBackendMessage("ApplyPatchSet", { requestId: `request_${randomUUID()}`, transactionId, expectedRevision: pluginRevision, patchSetHash, patchPlan: { kind: "StudioPatchPlan", schemaVersion: 1, patchSet, targets } }, connectedSession.sessionId));
    const patchMessage = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "PatchApplied" | "PatchRejected" }> => (message.type === "PatchApplied" || message.type === "PatchRejected") && message.payload.patchSetId === patchSet.id, timeoutMs, "PatchSet acknowledgement");
    if (patchMessage.type === "PatchRejected") {
      await rollback(bridge, connectedSession.sessionId, transactionId, pluginRevision, messages, timeoutMs);
      throw new StudioVerificationError("PATCH_REJECTED", patchMessage.payload.reason, "rejected");
    }
    if (patchMessage.payload.patchSetHash !== patchSetHash || patchMessage.payload.operations.length !== patchSet.operations.length || patchMessage.payload.operations.some((result) => result.status !== "applied")) {
      await rollback(bridge, connectedSession.sessionId, transactionId, patchedRevision(messages), messages, timeoutMs);
      throw new StudioVerificationError("PATCH_EVIDENCE_MISMATCH", "Studio acknowledged a patch with mismatched hash or incomplete operation evidence.", "rejected");
    }
    const patchedSnapshotMessage = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "ProjectObservation" }> => message.type === "ProjectObservation" && [...afterSources.entries()].every(([path, after]) => message.payload.observation.scripts.some((script) => sourceContainerName(script.path) === sourceContainerName(path) && script.source !== undefined && script.source === after)), timeoutMs, "post-patch Studio observation");
    if (!liveMap || !liveAfterSnapshot) throw new StudioVerificationError("POST_PATCH_SNAPSHOT_MISSING", "The live post-patch Studio observation was not available.", "incomplete");
    const afterSnapshot = liveAfterSnapshot;

    const temporaryDestination = options.candidateProjectRoot ? resolve(options.candidateProjectRoot) : join(await mkdtempSafe(), "patched-project");
    if (!options.candidateProjectRoot) await applyPatchSet(root, patchSet, temporaryDestination);
    const staticAfter = options.candidateVerification ?? await verifyProject(temporaryDestination, options.traceDirectory ? { traceDirectory: options.traceDirectory, traceReferences: { mechanicContractId: options.contract.id, patchSetId: patchSet.id } } : { traceReferences: { mechanicContractId: options.contract.id, patchSetId: patchSet.id } });
    if (staticAfter.report.gate.status !== "verified" && !options.fault) {
      await rollback(bridge, connectedSession.sessionId, transactionId, patchedSnapshotMessage.payload.revision.observationHash, messages, timeoutMs);
      throw new StudioVerificationError("PATCHED_STATIC_GATE_REJECTED", "The patched project failed official Luau or semantic verification; the Studio transaction was not committed.", "rejected", staticAfter.report);
    }

    const planBinding = await resolvePlanBinding(root, manifest, options.contract, afterSnapshot);
    const testPlan = planBinding.testPlan;
    const harness = planBinding.harness;
    const correlationId = `studio_correlation_${randomUUID()}`;
    const runId = `studio_run_${randomUUID()}`;
    await bridge.send(createBackendMessage("ExecuteAssertionPlan", { requestId: `request_${randomUUID()}`, transactionId, projectId: connectedSession.projectId, sessionId: connectedSession.sessionId, project: connectedSession.project, runId, testPlanId: testPlan.id, correlationId, projectSnapshotHash: afterSnapshot.projectSemanticHash, mechanicContractHash, expectedRevision: patchedSnapshotMessage.payload.revision.observationHash, assertions: testPlan.assertions, adversarial: true, harnessId: harness.id, harnessVersion: harness.version }, connectedSession.sessionId));
    const accepted = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "AssertionPlanAccepted" }> => message.type === "AssertionPlanAccepted" && message.payload.runId === runId && message.payload.testPlanId === testPlan.id, timeoutMs, "Studio assertion plan acceptance");
    if (accepted.payload.harnessId !== harness.id || accepted.payload.harnessVersion !== harness.version) throw new StudioVerificationError("HARNESS_VERSION_MISMATCH", `Studio accepted ${accepted.payload.harnessId}@${accepted.payload.harnessVersion}; Forge requires ${harness.id}@${harness.version}.`, "incomplete");
    capture = new StudioProofCapture({ runId, testPlan, projectSnapshot: afterSnapshot, pluginVersion: connectedSession.pluginVersion, studioVersion: connectedSession.studioVersion, transactionId, authoritativeSession: true, correlationId, sessionId: connectedSession.sessionId, projectId: connectedSession.projectId, project: connectedSession.project, projectSnapshotHash: afterSnapshot.projectSemanticHash, mechanicContractHash, nonceCommitment: accepted.payload.nonceCommitment, harnessId: harness.id, harnessVersion: harness.version, harnessHash: harness.hash });
    capture.accept(accepted);
    const acceptedIndex = messages.indexOf(accepted);
    for (const message of messages.slice(acceptedIndex + 1)) {
      if ((message.type === "PlaytestStarted" || message.type === "StudioTestResult" || message.type === "PlaytestStopped") && message.payload.runId === runId) capture.accept(message);
    }
    const started = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "PlaytestStarted" }> => message.type === "PlaytestStarted" && message.payload.runId === runId, timeoutMs, "explicit user-triggered StudioProof start");
    if (messages.indexOf(started) < messages.indexOf(accepted)) throw new StudioVerificationError("LIFECYCLE_ORDER", "Studio test started before its assertion plan was accepted.", "rejected");
    await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "StudioTestResult" }> => message.type === "StudioTestResult" && message.payload.runId === runId, timeoutMs, "atomic authoritative Studio server result");
    await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "PlaytestStopped" }> => message.type === "PlaytestStopped" && message.payload.runId === runId, timeoutMs, "authoritative Studio Play Solo stop");
    const studioProof = capture.complete();
    const proofDirectory = options.proofDirectory ?? join(root, ".forge", "studio-proofs");
    const proofRunPath = await persistStudioProof(studioProof, proofDirectory);
    const staticBundle = assembleStaticSemanticProof(staticAfter.report, options.contract, patchSet.id, patchSetHash, beforeSnapshot.projectSemanticHash, afterSnapshot.projectSemanticHash, new Date().toISOString());
    const candidate = options.candidateArtifact;
    const candidateClassification: "FIRST_PASS_VERIFIED" | "DETERMINISTICALLY_REPAIRED_VERIFIED" | "MODEL_REPAIRED_VERIFIED" | null = candidate ? (candidate.attempt.type === "initial" ? "FIRST_PASS_VERIFIED" : candidate.attempt.type === "model_repair" ? "MODEL_REPAIRED_VERIFIED" : "DETERMINISTICALLY_REPAIRED_VERIFIED") : null;
    const candidateBoundBundle: ProofBundle = candidate?.lineage.gameIntent && candidate.lineage.gameIntentHash && candidate.lineage.coreLoop && candidate.lineage.coreLoopHash ? {
      ...staticBundle,
      candidate: {
        artifactId: candidate.id,
        artifactHash: candidate.artifactHash,
        gameIntentId: candidate.lineage.gameIntent.id,
        gameIntentHash: candidate.lineage.gameIntentHash,
        coreLoopId: candidate.lineage.coreLoop.id,
        coreLoopHash: candidate.lineage.coreLoopHash,
        implementationSpecId: candidate.implementationSpec.id,
        implementationSpecHash: candidate.implementationSpecHash,
        contextCompositionHash: candidate.lineage.contextCompositionHash,
        model: { provider: candidate.model.provider, name: candidate.model.name, classification: candidateClassification }
      }
    } : staticBundle;
    let proofBundle = attachStudioProof(candidateBoundBundle, studioProof);
    if (proofBundle.gate.status !== "verified") {
      await rollback(bridge, connectedSession.sessionId, transactionId, patchedSnapshotMessage.payload.revision.observationHash, messages, timeoutMs);
      transactionActive = false;
    } else {
      await bridge.send(createBackendMessage("CommitTransaction", { requestId: `request_${randomUUID()}`, transactionId, expectedRevision: patchedSnapshotMessage.payload.revision.observationHash }, connectedSession.sessionId));
      await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "TransactionCommitted" }> => message.type === "TransactionCommitted" && message.payload.transactionId === transactionId, timeoutMs, "transaction commit acknowledgement");
      transactionActive = false;
    }

    const traceRun = await verifyProject(temporaryDestination, {
      ...(options.traceDirectory ? { traceDirectory: options.traceDirectory } : {}), traceReferences: { mechanicContractId: options.contract.id, patchSetId: patchSet.id }, traceComponents: { studio: { name: "Roblox Studio Plugin", version: connectedSession.pluginVersion } }, traceProofBundleId: proofBundle.id,
      tracePreludeSpans: studioTraceSpans(studioProof, proofBundle.gate.status === "verified"), outcomeOverrides: { status: proofBundle.gate.status === "verified" ? "accepted" : proofBundle.gate.status === "rejected" ? "rejected" : "incomplete", verified: proofBundle.gate.status === "verified", studioPass: studioProof.status === "pass" && studioProof.authoritative ? "pass" : studioProof.status === "fail" ? "fail" : "unknown", assertions: { total: studioProof.testPlan.assertions.length, passed: studioProof.assertionResults.filter((result) => result.status === "pass").length } }
    });
    proofBundle = { ...proofBundle, buildTraceId: traceRun.trace.id };
    const proofPath = await persistProof(proofBundle, proofDirectory);
    const result: StudioVerificationRun = { kind: "StudioVerificationRun", schemaVersion: 1, status: proofBundle.gate.status, projectRoot: root, session: connectedSession, patchSet, patchSetHash, beforeSnapshot, afterSnapshot, testPlan, studioProof, proofBundle, trace: traceRun.trace, ...(traceRun.tracePersistence.locator ? { tracePath: traceRun.tracePersistence.locator } : {}), proofPath, proofRunPath, staticBefore, staticAfter };
    return result;
  } catch (error) {
    if (capture) {
      try { await persistStudioProof(capture.complete(), options.proofDirectory ?? join(root, ".forge", "studio-proofs")); } catch { /* preserve the primary failure; malformed/partial runs remain non-authoritative */ }
    }
    if (transactionActive && session && transactionId) {
      try { await rollback(bridge, session.sessionId, transactionId, patchedRevision(messages), messages, Math.min(timeoutMs, 15_000)); } catch { /* preserve the original failure; plugin unload also cancels an open recording */ }
    }
    throw error;
  } finally {
    capture = undefined;
    unsubscribe();
    await bridge.close();
  }
}

function patchedRevision(messages: PluginToBackendMessage[]): string {
  const snapshot = [...messages].reverse().find((message) => message.type === "ProjectObservation");
  if (snapshot?.type === "ProjectObservation") return snapshot.payload.revision.observationHash;
  return "unavailable";
}

async function resolvePlanBinding(root: string, manifest: Awaited<ReturnType<typeof readFixtureManifest>>, contract: MechanicContract, snapshot: ProjectSnapshot): Promise<{ testPlan: StudioTestPlan; harness: { id: "collect-fruit" | "collect-sell"; version: string; hash: string } }> {
  if (contract.name !== "SellInventory") return { testPlan: collectFruitTestPlan(contract, snapshot), harness: { id: COLLECT_FRUIT_HARNESS_ID, version: COLLECT_FRUIT_HARNESS_VERSION, hash: COLLECT_FRUIT_HARNESS_HASH } };
  const verified = manifest.generationTarget?.verifiedMechanics.find((entry) => entry.name === "CollectFruit");
  if (!verified) throw new StudioVerificationError("REGRESSION_BINDING_MISSING", "SellInventory StudioProof requires the verified CollectFruit regression binding.", "rejected");
  const value: unknown = JSON.parse(await readFile(join(root, verified.contractPath), "utf8"));
  assertMechanicContract(value);
  return { testPlan: collectSellTestPlan(contract, value, verified.proofBundleId, verified.sourceHashes, snapshot), harness: { id: COLLECT_SELL_HARNESS_ID, version: COLLECT_SELL_HARNESS_VERSION, hash: COLLECT_SELL_HARNESS_HASH } };
}

async function readFixtureManifest(root: string) {
  const value: unknown = JSON.parse(await readFile(join(root, "forge.fixture.json"), "utf8"));
  assertFixtureManifest(value);
  return value;
}

async function findCollectFruitSource(map: ProjectSemanticMap): Promise<{ path: string; source: string }> {
  const source = map.files.find((file) => basename(file.path) === "CollectFruit.server.luau" && file.executionContext === "server");
  if (!source) throw new StudioVerificationError("PATCH_TARGET_MISSING", "The CollectFruit server script was not found in the fixture.", "rejected");
  return source;
}

async function createSafeFallbackMutation(map: ProjectSemanticMap): Promise<{ source: { path: string; source: string }; after: string; effect: string; bounds: { maxAddedLines: number; maxRemovedLines: number } }> {
  const source = await findCollectFruitSource(map);
  return { source, after: addServerGuard(source.source), effect: "Server rejects a mutated collectible before awarding inventory.", bounds: { maxAddedLines: 3, maxRemovedLines: 0 } };
}

function createFaultMutation(map: ProjectSemanticMap, contract: MechanicContract, fault: StudioFaultMode): { source: { path: string; source: string }; after: string; effect: string; bounds: { maxAddedLines: number; maxRemovedLines: number } } {
  if (fault === "client-controlled-reward") {
    if (contract.name !== "CollectFruit") throw new StudioVerificationError("FAULT_CONTRACT_MISMATCH", "client-controlled-reward applies only to CollectFruit.", "rejected");
    const source = map.files.find((file) => basename(file.path) === "CollectFruit.server.luau" && file.executionContext === "server");
    if (!source) throw new StudioVerificationError("PATCH_TARGET_MISSING", "The CollectFruit server script was not found in the fixture.", "rejected");
    return { source, after: injectClientRewardFault(source.source), effect: "Intentional fault: client-controlled reward reaches authoritative inventory mutation.", bounds: { maxAddedLines: 0, maxRemovedLines: 0 } };
  }
  if (contract.name !== "SellInventory") throw new StudioVerificationError("FAULT_CONTRACT_MISMATCH", "client-controlled-payout applies only to SellInventory.", "rejected");
  const source = map.files.find((file) => basename(file.path) === "SellInventory.server.luau" && file.executionContext === "server");
  if (!source) throw new StudioVerificationError("PATCH_TARGET_MISSING", "The SellInventory server script was not found in the fixture.", "rejected");
  return { source, after: injectClientPayoutFault(source.source), effect: "Intentional fault: client-controlled payout reaches authoritative Coins mutation.", bounds: CLIENT_CONTROLLED_PAYOUT_FAULT_BOUNDS };
}

function addServerGuard(source: string): string {
	const marker = '    if Fruit42:GetAttribute("FruitType") ~= "Apple" then\n        return\n    end\n';
	if (source.includes(marker)) return source;
  const anchor = '    if typeof(fruitId) ~= "string" or fruitId ~= "Fruit42" then\n        return\n    end\n';
	if (!source.includes(anchor)) throw new StudioVerificationError("PATCH_ANCHOR_MISSING", "The expected CollectFruit server validation anchor was not found.", "rejected");
	return source.replace(anchor, anchor + marker);
}

function injectClientRewardFault(source: string): string {
  const safeExpression = 'player:SetAttribute("Inventory", (player:GetAttribute("Inventory") or 0) + Fruit42:GetAttribute("Reward"))';
  const vulnerableExpression = 'player:SetAttribute("Inventory", (player:GetAttribute("Inventory") or 0) + _claimedAmount)';
  if (source.includes(vulnerableExpression)) return source;
  if (!source.includes(safeExpression)) throw new StudioVerificationError("FAULT_ANCHOR_MISSING", "The expected server-owned reward expression was not found for fault injection.", "rejected");
  return source.replace(safeExpression, vulnerableExpression);
}

/**
 * One real adversarial mutation for the SellInventory contract. The production
 * client ABI remains zero-argument; only a malicious direct RemoteEvent call
 * supplies `claimedPayout`, which the faulty server then trusts. This is a
 * fault fixture, never model-authored implementation or repair output.
 */
export function injectClientPayoutFault(source: string): string {
  const safeCallback = "sellInventory.OnServerEvent:Connect(function(player: Player)";
  const faultCallback = "sellInventory.OnServerEvent:Connect(function(player: Player, claimedPayout: number?)";
  const safeMutation = "player:SetAttribute(\"Coins\", coins + payout)";
  const faultMutation = "local creditedPayout = claimedPayout or payout\n\tif not finiteNumber(creditedPayout) or creditedPayout < 0 then\n\t\treturn\n\tend\n\n\tplayer:SetAttribute(\"Coins\", coins + creditedPayout)";
  if (source.includes(faultCallback) && source.includes("coins + creditedPayout")) return source;
  if (!source.includes(safeCallback) || !source.includes(safeMutation)) throw new StudioVerificationError("FAULT_ANCHOR_MISSING", "The expected server-owned SellInventory payout expression was not found for fault injection.", "rejected");
  return source.replace(safeCallback, faultCallback).replace(safeMutation, faultMutation);
}

async function rollback(bridge: StudioBridgeConnection, sessionId: string, transactionId: string, expectedRevision: string, messages: PluginToBackendMessage[], timeoutMs: number): Promise<void> {
  await bridge.send(createBackendMessage("RollbackTransaction", { requestId: `request_${randomUUID()}`, transactionId, expectedRevision }, sessionId));
  const result = await waitFor(messages, (message): message is Extract<PluginToBackendMessage, { type: "TransactionRolledBack" }> => message.type === "TransactionRolledBack" && message.payload.transactionId === transactionId, timeoutMs, "transaction rollback acknowledgement");
  if (!result.payload.success) throw new StudioVerificationError("ROLLBACK_FAILED", result.payload.rollback, "incomplete");
}

function studioTraceSpans(run: StudioProofRun, verified: boolean): Array<{ name: ForgeSpanName; status: "ok" | "error"; attributes: Record<string, string | number | boolean | string[]>; durationMs: number }> {
  const status = verified ? "ok" as const : "error" as const;
  const assertionDurationMs = run.assertionResults.reduce((total, result) => total + result.durationMs, 0);
  const common = { "forge.studio.run_id": run.runId, "forge.studio.test_plan_id": run.testPlan.id, "forge.studio.correlation_id": run.correlationId, "forge.studio.session_id": run.sessionId, "forge.project_snapshot_hash": run.projectSnapshotHash, "forge.contract_hash": run.mechanicContractHash, "forge.studio.authoritative": run.authoritative };
  return [
    { name: "forge.studio.connect", status: "ok", attributes: common, durationMs: 0 },
    { name: "forge.studio.snapshot", status: "ok", attributes: common, durationMs: 0 },
    { name: "forge.studio.transaction.begin", status: "ok", attributes: common, durationMs: 0 },
    { name: "forge.studio.patch.apply", status: "ok", attributes: common, durationMs: 0 },
    { name: "forge.studio.start", status: "ok", attributes: common, durationMs: 0 },
    { name: "forge.studio.playtest", status, attributes: { ...common, "forge.studio.assertion_count": run.assertionResults.length }, durationMs: assertionDurationMs },
    { name: "forge.studio.action", status, attributes: { ...common, "forge.studio.action_count": run.testPlan.assertions.reduce((count, assertion) => count + assertion.actions.length, 0) }, durationMs: assertionDurationMs },
    { name: "forge.studio.assert", status, attributes: common, durationMs: assertionDurationMs },
    { name: "forge.studio.adversarial", status, attributes: { ...common, "forge.studio.adversarial_count": run.testPlan.adversarialCases.length }, durationMs: 0 },
    { name: "forge.studio.playtest.stop", status, attributes: common, durationMs: 0 },
    { name: verified ? "forge.studio.transaction.commit" : "forge.studio.transaction.rollback", status, attributes: common, durationMs: 0 },
    { name: verified ? "forge.commit.verified" : "forge.commit.rejected", status, attributes: common, durationMs: 0 }
  ];
}

async function persistProof(proof: ProofBundle, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${proof.id}.json`);
  await writeFile(path, `${stableJson(proof)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

async function persistStudioProof(run: StudioProofRun, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${run.runId}.json`);
  await writeFile(path, `${stableJson(run)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

async function mkdtempSafe(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "forge-studio-"));
}

function sourceContainerName(path: string): string {
  return basename(path).replace(/\.(?:lua|luau)$/, "");
}

async function waitFor<T extends PluginToBackendMessage>(messages: PluginToBackendMessage[], predicate: (message: PluginToBackendMessage) => message is T, timeoutMs: number, description: string): Promise<T> {
  const started = Date.now();
  let index = 0;
  while (Date.now() - started < timeoutMs) {
    while (index < messages.length) {
      const message = messages[index++]!;
      if (message.type === "PluginError") throw new StudioVerificationError("PLUGIN_ERROR", `${message.payload.code}: ${message.payload.message}`, message.payload.retryable ? "incomplete" : "rejected");
      if (predicate(message)) return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new StudioVerificationError("TIMEOUT", `Timed out waiting for ${description}.`, "incomplete");
}

export class StudioVerificationError extends Error {
  constructor(readonly code: string, message: string, readonly status: "rejected" | "incomplete", readonly report?: unknown) { super(message); }
}
