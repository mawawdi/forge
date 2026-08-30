import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertCoreLoop, assertFixtureManifest, assertGameIntent, assertMechanicContract, contentHash, stableJson } from "../packages/contracts/src/index.js";
import { compileCoreLoopExtension, parseCoreLoopExtensionDraft } from "../packages/intent/src/index.js";
import { DeterministicContextCompiler } from "../packages/context-compiler/src/index.js";
import { buildSemanticMap, compileMechanicImplementationSpec, createProjectSnapshot } from "../packages/semantic-map/src/index.js";
import { COLLECT_SELL_HARNESS_HASH, COLLECT_SELL_HARNESS_ID, COLLECT_SELL_HARNESS_VERSION, STUDIO_HARNESS_REGISTRY } from "../packages/studio-protocol/src/index.js";
import { assertStudioTestPlan, collectSellTestPlan } from "../packages/studio-proof/src/index.js";
import { CLIENT_CONTROLLED_PAYOUT_FAULT_BOUNDS, injectClientPayoutFault } from "../packages/studio-proof/src/runner.js";
import { verifyProject } from "../packages/verifier/src/index.js";
import { SELL_INVENTORY_GENERATION_POLICY } from "../packages/generation/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const seed = resolve(root, "examples/core-loop/sell-inventory-seed");
const safeCandidate = resolve(root, "examples/core-loop/.forge-generation-runs/generation_cc30bcfe-c00a-4e46-ac4e-25b95fbdcd14/model-repaired");

async function fixture() {
  const manifest: unknown = JSON.parse(await readFile(resolve(seed, "forge.fixture.json"), "utf8"));
  const gameIntent: unknown = JSON.parse(await readFile(resolve(seed, "contracts/GameIntent.json"), "utf8"));
  const coreLoop: unknown = JSON.parse(await readFile(resolve(seed, "contracts/CoreLoop.json"), "utf8"));
  const collectContract: unknown = JSON.parse(await readFile(resolve(seed, "contracts/CollectFruit.json"), "utf8"));
  assertFixtureManifest(manifest); assertGameIntent(gameIntent); assertCoreLoop(coreLoop); assertMechanicContract(collectContract);
  return { manifest, gameIntent, coreLoop, collectContract };
}

test("M3.5 seed pins the sealed M3.25 CollectFruit bytes and explicit regression provenance", async () => {
  const { manifest } = await fixture();
  const hashes = manifest.generationTarget?.verifiedMechanics.find((entry) => entry.name === "CollectFruit")?.sourceHashes;
  assert.deepEqual(hashes, {
    "src/client/CollectFruitClient.client.luau": "bc6e639520ed7e59c1d53ba4336aaff632a382f5a32465a48202ab21c67d4885",
    "src/server/CollectFruit.server.luau": "a6ae74d993785990ca71ffb5bea5424660f6c37f47eb9b6ac9d398e4182b60c1"
  });
  for (const [path, hash] of Object.entries(hashes ?? {})) assert.equal(createHash("sha256").update(await readFile(resolve(seed, path), "utf8")).digest("hex"), hash);
  assert.equal(manifest.generationTarget?.verifiedMechanics[0]?.proofBundleId, "proof_932e3d0abd04b04894b38e73");
});

test("M3.5 compiles SellInventory incrementally and keeps CollectFruit verified", async () => {
  const { gameIntent, coreLoop } = await fixture();
  const draft = parseCoreLoopExtensionDraft({ normalizedGoal: "Players sell collected fruit for server-calculated coins.", desiredOutcomes: ["secure selling"], unresolvedQuestions: [], selectedMechanic: "SellInventory" });
  const compiled = compileCoreLoopExtension("Now let players sell fruit for coins.", draft, gameIntent, coreLoop, "node_sell", new Date("2026-08-30T00:00:00.000Z"));
  assert.equal(compiled.gameIntent.id, gameIntent.id);
  assert.equal(compiled.coreLoop.id, coreLoop.id);
  assert.equal(compiled.coreLoop.nodes.find((node) => node.id === "node_collect")?.status, "verified");
  assert.equal(compiled.coreLoop.nodes.find((node) => node.id === "node_sell")?.status, "in_progress");
  assert.equal(compiled.coreLoop.nodes.find((node) => node.id === "node_upgrade")?.status, "proposed");
  assert.deepEqual(compiled.mechanicContract.authorityModel.clientInputs, []);
  assert.deepEqual(compiled.mechanicContract.authorityModel.stateMutations.map((mutation) => mutation.field), ["Inventory", "Coins"]);
});

test("M3.5 implementation spec exposes Sell plus the bounded shared-state and production-action Collect correction", async () => {
  const { manifest, gameIntent, coreLoop } = await fixture();
  const map = await buildSemanticMap(seed, manifest);
  const extension = compileCoreLoopExtension("sell", parseCoreLoopExtensionDraft({ normalizedGoal: "sell", desiredOutcomes: ["coins"], unresolvedQuestions: [], selectedMechanic: "SellInventory" }), gameIntent, coreLoop, "node_sell");
  const spec = compileMechanicImplementationSpec(map, extension.mechanicContract, { allowedPaths: [...SELL_INVENTORY_GENERATION_POLICY.allowedPaths], allowedPatchOperations: ["replace_text"] });
  assert.equal(spec.schemaVersion, 4);
  assert.deepEqual(spec.clientInputs, []);
  assert.deepEqual(spec.sourceTargets.map((target) => target.path).sort(), [...SELL_INVENTORY_GENERATION_POLICY.allowedPaths].sort());
  assert.equal(spec.interactionBinding?.clientAction.kind, "module_function");
  assert.deepEqual(spec.stateMutations.map((mutation) => mutation.field), ["Inventory", "Coins"]);
});

test("M3.5 context includes the shared Collect authority source and excludes harnesses and historical patches", async () => {
  const { manifest, gameIntent, coreLoop } = await fixture();
  const map = await buildSemanticMap(seed, manifest);
  const extension = compileCoreLoopExtension("sell", parseCoreLoopExtensionDraft({ normalizedGoal: "sell", desiredOutcomes: ["coins"], unresolvedQuestions: [], selectedMechanic: "SellInventory" }), gameIntent, coreLoop, "node_sell");
  const spec = compileMechanicImplementationSpec(map, extension.mechanicContract, { allowedPaths: [...SELL_INVENTORY_GENERATION_POLICY.allowedPaths], allowedPatchOperations: ["replace_text"] });
  const context = await new DeterministicContextCompiler().compile({
    semanticMap: map,
    mechanicContract: extension.mechanicContract,
    mechanicImplementationSpec: spec,
    verificationIssues: [],
    requestedChange: "Add SellInventory without changing the Forge-owned ABI.",
    gameIntent,
    coreLoop,
    verifiedMechanics: [{ name: "CollectFruit", contract: await readFile(resolve(seed, "contracts/CollectFruit.json"), "utf8"), proofBundleId: manifest.generationTarget!.verifiedMechanics[0]!.proofBundleId, sourceHashes: manifest.generationTarget!.verifiedMechanics[0]!.sourceHashes }],
    allowedSourcePaths: spec.sourceTargets.map((target) => target.path)
  });
  const collect = context.items.find((item) => item.source === "source:src/server/CollectFruit.server.luau");
  assert.equal(collect?.reason, "Server source shares a declared authoritative state binding with this mechanic.");
  assert.ok(context.items.some((item) => item.source === "source:src/server/SellInventory.server.luau"));
  assert.ok(context.items.some((item) => item.source === "source:src/client/SellInventoryClient.client.luau"));
  assert.ok(context.items.some((item) => item.source === "source:src/ReplicatedStorage/ClientActions/SellInventoryAction.luau"));
  assert.ok(context.items.some((item) => item.source === "source:src/ReplicatedStorage/ClientActions/CollectFruitAction.luau"));
  assert.ok(!context.modelReadyContent.includes("CollectSellHarness"));
  assert.ok(!context.modelReadyContent.includes("candidate_repair_f3e69e1e"));
  const interactionItem = context.items.find((item) => item.source === "interaction:SellInventory");
  assert.equal(interactionItem?.required, true);
  assert.match(interactionItem?.content ?? "", /Workspace\/SellZone\/SellPrompt/);
  assert.match(interactionItem?.content ?? "", /MaxActivationDistance/);
  assert.match(interactionItem?.content ?? "", /"x":18/);
});

test("M3.5 semantic map keeps client activation and server authorization as distinct radii", async () => {
  const { manifest, gameIntent, coreLoop } = await fixture();
  const map = await buildSemanticMap(seed, manifest);
  const extension = compileCoreLoopExtension("sell", parseCoreLoopExtensionDraft({ normalizedGoal: "sell", desiredOutcomes: ["coins"], unresolvedQuestions: [], selectedMechanic: "SellInventory" }), gameIntent, coreLoop, "node_sell");
  const spec = compileMechanicImplementationSpec(map, extension.mechanicContract, { allowedPaths: [...SELL_INVENTORY_GENERATION_POLICY.allowedPaths], allowedPatchOperations: ["replace_text"] });
  assert.equal(spec.interactionBinding?.production.kind, "proximity_prompt");
  if (spec.interactionBinding?.production.kind !== "proximity_prompt") assert.fail("expected ProximityPrompt interaction");
  assert.equal(spec.interactionBinding.production.maxActivationDistance, 12);
  assert.equal(spec.interactionBinding.serverAuthorization.maxDistance, 20);
  const semantic = map.interactionBindings.find((entry) => entry.mechanicName === "SellInventory");
  assert.equal(semantic?.productionInstance?.properties.MaxActivationDistance, 12);
  assert.deepEqual(semantic?.authorizationInstance?.position, { x: 18, y: 2, z: 0 });
});

test("M3.5 resolves Rojo action-module requires from the candidate root and traces the selected target into the action", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "forge-action-module-regression-"));
  try {
    await cp(seed, sandbox, { recursive: true });
    await writeFile(resolve(sandbox, "src/ReplicatedStorage/ClientActions/CollectFruitAction.luau"), `local ReplicatedStorage = game:GetService("ReplicatedStorage")\nlocal collect = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("CollectFruit")\nlocal Action = {}\nfunction Action.request(target: Instance?)\n  if target then collect:FireServer(target.Name, 0) end\nend\nreturn Action\n`);
    await writeFile(resolve(sandbox, "src/client/CollectFruitClient.client.luau"), `local Players = game:GetService("Players")\nlocal ReplicatedStorage = game:GetService("ReplicatedStorage")\nlocal CollectionService = game:GetService("CollectionService")\nlocal action = require(ReplicatedStorage.ClientActions.CollectFruitAction)\nlocal mouse = Players.LocalPlayer:GetMouse()\nlocal function findCollectible(target: Instance?): Instance?\n  if target and CollectionService:HasTag(target, "collectible") then return target end\n  return nil\nend\nmouse.Button1Down:Connect(function()\n  local fruit = findCollectible(mouse.Target)\n  if fruit then action.request(fruit) end\nend)\n`);
    await writeFile(resolve(sandbox, "src/ReplicatedStorage/ClientActions/SellInventoryAction.luau"), `local ReplicatedStorage = game:GetService("ReplicatedStorage")\nlocal sell = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("SellInventory")\nlocal Action = {}\nfunction Action.request() sell:FireServer() end\nreturn Action\n`);
    await writeFile(resolve(sandbox, "src/client/SellInventoryClient.client.luau"), `local ReplicatedStorage = game:GetService("ReplicatedStorage")\nlocal Workspace = game:GetService("Workspace")\nlocal action = require(ReplicatedStorage.ClientActions.SellInventoryAction)\nlocal prompt = Workspace:WaitForChild("SellZone"):WaitForChild("SellPrompt")\nprompt.Triggered:Connect(function() action.request() end)\n`);
    const report = await verifyProject(sandbox);
    const disallowed = new Set(["LUAU_TYPE_ERROR", "CLIENT_ACTION_ARGUMENT_MISMATCH", "CLIENT_INTERACTION_TARGET_MISMATCH", "REMOTE_ABI_ARITY_MISMATCH"]);
    assert.deepEqual(report.report.issues.filter((issue) => disallowed.has(issue.ruleId)).map((issue) => issue.ruleId), [], JSON.stringify(report.report.issues));
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test("M3.5 rejects periodic initiation for an explicit ProximityPrompt contract without banning Heartbeat globally", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "forge-interaction-regression-"));
  try {
    await cp(seed, sandbox, { recursive: true });
    await writeFile(resolve(sandbox, "src/client/SellInventoryClient.client.luau"), `local ReplicatedStorage = game:GetService("ReplicatedStorage")\nlocal RunService = game:GetService("RunService")\nlocal actions = ReplicatedStorage:WaitForChild("ClientActions")\nlocal sellAction = require(actions:WaitForChild("SellInventoryAction"))\nRunService.Heartbeat:Connect(function()\n  sellAction.request()\nend)\n`);
    const report = await verifyProject(sandbox);
    assert.ok(report.report.issues.some((issue) => issue.ruleId === "CLIENT_AUTONOMOUS_INTERACTION" && issue.path?.endsWith("SellInventoryClient.client.luau")));
    assert.ok(report.report.issues.some((issue) => issue.ruleId === "CLIENT_INTERACTION_BINDING_MISMATCH" && issue.path?.endsWith("SellInventoryClient.client.luau")));
    await writeFile(resolve(sandbox, "src/client/SellInventoryClient.client.luau"), `local ReplicatedStorage = game:GetService("ReplicatedStorage")\nlocal RunService = game:GetService("RunService")\nlocal Workspace = game:GetService("Workspace")\nlocal actions = ReplicatedStorage:WaitForChild("ClientActions")\nlocal sellAction = require(actions:WaitForChild("SellInventoryAction"))\nlocal prompt = Workspace:WaitForChild("SellZone"):WaitForChild("SellPrompt")\nRunService.Heartbeat:Connect(function()\n  local _frameTime = os.clock()\nend)\nprompt.Triggered:Connect(function()\n  sellAction.request()\nend)\n`);
    const explicitReport = await verifyProject(sandbox);
    assert.equal(explicitReport.report.issues.some((issue) => issue.ruleId === "CLIENT_AUTONOMOUS_INTERACTION" && issue.path?.endsWith("SellInventoryClient.client.luau")), false);
    assert.equal(explicitReport.report.issues.some((issue) => issue.ruleId === "CLIENT_INTERACTION_BINDING_MISMATCH" && issue.path?.endsWith("SellInventoryClient.client.luau")), false);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test("M3.5 combined Studio plan is exactly fourteen correlated assertions with Collect regression binding", async () => {
  const { manifest, gameIntent, coreLoop, collectContract } = await fixture();
  const extension = compileCoreLoopExtension("sell", parseCoreLoopExtensionDraft({ normalizedGoal: "sell", desiredOutcomes: ["coins"], unresolvedQuestions: [], selectedMechanic: "SellInventory" }), gameIntent, coreLoop, "node_sell");
  const snapshot = createProjectSnapshot(await buildSemanticMap(seed, manifest));
  const binding = manifest.generationTarget?.verifiedMechanics[0]!;
  const plan = collectSellTestPlan(extension.mechanicContract, collectContract, binding.proofBundleId, binding.sourceHashes, snapshot);
  assertStudioTestPlan(plan);
  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.assertions.length, 14);
  assert.equal(plan.assertions.filter((assertion) => assertion.mechanicContractId === collectContract.id).length, 7);
  assert.equal(plan.assertions.filter((assertion) => assertion.mechanicContractId === extension.mechanicContract.id).length, 7);
  assert.deepEqual(plan.regressionContracts, [{ mechanicContractId: collectContract.id, mechanicContractHash: contentHash(stableJson(collectContract)), proofBundleId: binding.proofBundleId, sourceHashes: binding.sourceHashes }]);
});

test("M3.5 v10 allow-lists the standalone Collect+Sell harness by exact source hash", async () => {
  const source = await readFile(resolve(root, "plugin/src/Forge/CollectSellHarness.luau"), "utf8");
  assert.equal(createHash("sha256").update(source).digest("hex"), COLLECT_SELL_HARNESS_HASH);
  assert.deepEqual(STUDIO_HARNESS_REGISTRY[COLLECT_SELL_HARNESS_ID], { version: COLLECT_SELL_HARNESS_VERSION, hash: COLLECT_SELL_HARNESS_HASH, assertionCount: 14 });
  assert.match(source, /sellInventory:FireServer\(\)/);
  assert.match(source, /claimedPayout=999999/);
  assert.match(source, /next\(data\) ~= nil/);
  assert.match(source, /StudioTestService:EndTest\(HttpService:JSONEncode/);
  assert.match(source, /humanoid\.Health <= 0/);
  assert.match(source, /candidate did not initialize declared player state/);
  assert.match(source, /request\("collect_production"/);
  assert.match(source, /request\("sell_production"/);
  assert.match(source, /collectAction\.request\(fruit\)/);
  assert.match(source, /sellAction\.request\(\)/);
  assert.doesNotMatch(source, /VirtualUser|MoveMouse|InputHoldBegin/);
  assert.doesNotMatch(source, /local before = inventory\(\); request\("collect_direct"/);
  assert.doesNotMatch(source, /request\("sell_direct", \{\}\); local afterSellInventory/);
});

test("M3.5 harness establishes player/world preconditions before the first action and cannot bypass production happy paths", async () => {
  const source = await readFile(resolve(root, "plugin/src/Forge/CollectSellHarness.luau"), "utf8");
  const liveHumanoid = source.indexOf("humanoid.Health <= 0");
  const initializedState = source.indexOf("candidate did not initialize declared player state");
  const firstAction = source.indexOf('request("collect_production"');
  assert.ok(liveHumanoid >= 0 && initializedState > liveHumanoid && firstAction > initializedState);
  assert.match(source, /local prompt = zone and zone:FindFirstChild\("SellPrompt"\)/);
  assert.match(source, /command\.kind == "collect_production"/);
  assert.match(source, /command\.kind == "sell_production"/);
  assert.match(source, /command\.kind == "collect_direct"/);
  assert.match(source, /command\.kind == "sell_direct"/);
});

test("M3.5 rejects a private mirror of a shared Inventory attribute before StudioProof", async () => {
  const report = await verifyProject(seed);
  assert.ok(report.report.issues.some((issue) => issue.ruleId === "ECONOMY_CONFLICTING_STATE_REPRESENTATION"));
});

test("M3.5 payout fault is a bounded real server mutation rejected before Studio and leaves its safe source unchanged", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "forge-sell-payout-fault-"));
  const serverPath = "src/server/SellInventory.server.luau";
  try {
    await cp(safeCandidate, sandbox, { recursive: true });
    const original = await readFile(resolve(safeCandidate, serverPath), "utf8");
    const faulted = injectClientPayoutFault(original);
    assert.match(faulted, /OnServerEvent:Connect\(function\(player: Player, claimedPayout: number\?\)/);
    assert.match(faulted, /local creditedPayout = claimedPayout or payout/);
    assert.match(faulted, /Coins", coins \+ creditedPayout/);
    assert.ok(faulted.split("\n").length - original.split("\n").length <= CLIENT_CONTROLLED_PAYOUT_FAULT_BOUNDS.maxAddedLines);
    await writeFile(resolve(sandbox, serverPath), faulted, "utf8");
    const report = await verifyProject(sandbox);
    assert.equal(report.report.gate.status, "rejected");
    assert.equal(report.report.issues.some((issue) => issue.ruleId === "LUAU_TYPE_ERROR"), false, JSON.stringify(report.report.issues));
    assert.ok(report.report.issues.some((issue) => issue.ruleId === "REMOTE_ABI_ARITY_MISMATCH"));
    assert.ok(report.report.issues.some((issue) => issue.ruleId === "REMOTE_UNDECLARED_CLIENT_INPUT"), JSON.stringify(report.report.issues));
    assert.ok(report.report.issues.some((issue) => issue.ruleId === "ECONOMY_CLIENT_CONTROLLED_PAYOUT"), JSON.stringify(report.report.issues));
    assert.equal(await readFile(resolve(safeCandidate, serverPath), "utf8"), original);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});
