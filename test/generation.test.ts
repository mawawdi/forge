import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertFixtureManifest, assertMechanicContract, contentHash, type MechanicContract, type MechanicImplementationSpec } from "../packages/contracts/src/index.js";
import { buildGeneratedCandidate, compilePatchProposal, loadCandidateArtifact, parseModelPatchProposal, repairCandidateRegression, reverifyCandidateRegression, type ModelProvider, type ModelRequest, type ModelResult } from "../packages/generation/src/index.js";
import { buildSemanticMap, compileMechanicImplementationSpec } from "../packages/semantic-map/src/index.js";

const ROOT = resolve(process.cwd());

class FixtureProvider implements ModelProvider {
  private call = 0;
  readonly prompts: string[] = [];
  readonly requests: ModelRequest[] = [];
  async generate(request: ModelRequest): Promise<ModelResult> {
    this.call += 1;
    this.prompts.push(request.prompt);
    this.requests.push(request);
    const content = this.call === 1 ? intent() : proposal(request.prompt.match(/Contract ID: ([^\n]+)/)?.[1] ?? "missing");
    return { content, requestHash: `request-${request.purpose}`, responseHash: `response-${request.purpose}`, usage: { inputTokens: 10, outputTokens: 20, costUsd: null } };
  }
}

class VulnerableProvider extends FixtureProvider {
  override async generate(request: ModelRequest): Promise<ModelResult> {
    const result = await super.generate(request);
    if (request.purpose === "patch") return { ...result, content: vulnerableProposal(request.prompt.match(/Contract ID: ([^\n]+)/)?.[1] ?? "missing") };
    return result;
  }
}

class RepairOnlyProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly distance = 20) {}
  async generate(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request);
    const content = proposal("ignored") as { rationale: string; operations: Array<{ path: string; after: string }> };
    content.operations[0]!.after = content.operations[0]!.after.replace("local MAX_DISTANCE = 20", `local MAX_DISTANCE = ${this.distance}`);
    return { content, requestHash: contentHash(`repair-request-${this.distance}`), responseHash: contentHash(`repair-response-${this.distance}`), usage: { inputTokens: 4000, outputTokens: 800, costUsd: 0.01 } };
  }
}

test("M3.25 compiles strict model intent and bounded two-file CollectFruit candidate without mutating seed", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "forge-generation-"));
  const seed = join(sandbox, "seed");
  await cp(join(ROOT, "examples/collect-fruit/generated-seed"), seed, { recursive: true });
  const before = await readFile(join(seed, "src/server/CollectFruit.server.luau"), "utf8");
  const provider = new FixtureProvider();
  const result = await buildGeneratedCandidate({ seedRoot: seed, prompt: "Make a fruit collection game where I get richer", provider });
  assert.equal(result.run.status, "verified", JSON.stringify(result.verification?.report));
  assert.equal(result.run.classification, "FIRST_PASS_VERIFIED");
  assert.equal(result.patchSet?.operations.length, 2);
  assert.equal(result.verification?.report.gate.status, "verified");
  assert.equal(await readFile(join(seed, "src/server/CollectFruit.server.luau"), "utf8"), before);
  assert.ok(result.outputRoot);
  assert.equal(result.outputRoot!.startsWith(`${seed}/`), false);
  assert.match(await readFile(join(result.outputRoot!, "src/server/CollectFruit.server.luau"), "utf8"), /Fruit42/);
  assert.match(result.contextSummary ? JSON.stringify(result.contextSummary) : "", /./);
  assert.equal(provider.prompts.some((prompt) => /ForgeTestHarness|StudioProof|repaired\/|ProofBundle/.test(prompt)), false);
  const intentSchema = provider.requests.find((request) => request.purpose === "intent")!.schema as { properties: { selectedMechanic: { type: string }; coreLoop: { properties: { edges: { items: { required: string[] } } } } } };
  assert.equal(intentSchema.properties.selectedMechanic.type, "string");
  assert.deepEqual(intentSchema.properties.coreLoop.properties.edges.items.required, ["from", "to", "condition"]);
  assertStructuredOutputSchema(intentSchema);
  assertStructuredOutputSchema(provider.requests.find((request) => request.purpose === "patch")!.schema);
});

test("M3.25 rejects untrusted patch-envelope fields, foreign targets, preserved-remote recreation, and Forge/Test APIs", async () => {
  assert.throws(() => parseModelPatchProposal({ kind: "ModelPatchProposal", schemaVersion: 1, mechanicContractId: "contract", rationale: "x", operations: [] }, "contract"));
  const root = join(ROOT, "examples/collect-fruit/generated-seed");
  const { contract, spec } = await loadInterface(root);
  await assert.rejects(() => compilePatchProposal(root, { kind: "ModelPatchProposal", schemaVersion: 1, mechanicContractId: contract.id, rationale: "x", operations: [{ type: "replace_text", path: "../escape.luau", after: "return {}" }, { type: "replace_text", path: "src/client/CollectFruitClient.client.luau", after: "return {}" }] }, contract, spec, { model: "test", promptHash: "hash" }));
  await assert.rejects(() => compilePatchProposal(root, { kind: "ModelPatchProposal", schemaVersion: 1, mechanicContractId: contract.id, rationale: "x", operations: [{ type: "replace_text", path: "src/server/CollectFruit.server.luau", after: "game:GetService('StudioTestService')" }, { type: "replace_text", path: "src/client/CollectFruitClient.client.luau", after: "return {}" }] }, contract, spec, { model: "test", promptHash: "hash" }));
  await assert.rejects(() => compilePatchProposal(root, { kind: "ModelPatchProposal", schemaVersion: 1, mechanicContractId: contract.id, rationale: "x", operations: [{ type: "replace_text", path: "src/server/CollectFruit.server.luau", after: "local x = Instance.new('RemoteEvent')" }, { type: "replace_text", path: "src/client/CollectFruitClient.client.luau", after: "return {}" }] }, contract, spec, { model: "test", promptHash: "hash" }), /requires preserving/);
});

test("M3.25 gives model repair the complete candidate/spec/diagnostic context", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "forge-generation-repair-"));
  const seed = join(sandbox, "seed");
  await cp(join(ROOT, "examples/collect-fruit/generated-seed"), seed, { recursive: true });
  const provider = new VulnerableProvider();
  const result = await buildGeneratedCandidate({ seedRoot: seed, prompt: "Fruit game", provider, runDirectory: join(sandbox, "runs") });
  assert.equal(result.run.status, "verified", JSON.stringify(result.verification?.report));
  assert.equal(result.run.classification, "MODEL_REPAIRED_VERIFIED");
  assert.deepEqual(result.run.attempts.map((entry) => entry.type), ["initial", "model_repair"]);
  const repairPrompt = provider.requests.find((request) => request.purpose === "repair")?.prompt ?? "";
  assert.match(repairPrompt, /MechanicImplementationSpec/);
  assert.match(repairPrompt, /REMOTE_CLIENT_CONTROLLED_REWARD/);
  assert.match(repairPrompt, /CollectFruit\.server\.luau/);
  assert.match(repairPrompt, /mutation/);
});

test("the exact historical Luna source is an immutable regression with a new justified local verdict", async () => {
  const regressionRoot = join(ROOT, "examples/collect-fruit/regressions/luna-first-pass");
  const result = await reverifyCandidateRegression(regressionRoot, await mkdtemp(join(tmpdir(), "forge-luna-traces-")));
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.historical.verdict, "rejected");
  assert.equal(result.historical.buildTraceId, "trace_18b2c1f6-8d75-46ea-a9c8-df5f7b1ea73c");
  assert.equal(result.patchSet.id, "patch_generated_8466abed9e2eec8a2b8f3060");
  assert.equal(result.verification.report.gate.status, "rejected", JSON.stringify(result.verification.report));
  assert.deepEqual(result.verification.report.issues.map((issue) => issue.ruleId), ["IMPLEMENTATION_CONSTANT_MISMATCH"]);
  assert.equal(result.verification.report.checks.find((check) => check.name === "roblox_type_analysis")?.status, "pass");
  assert.equal(result.verification.trace.references.modelResponseHash, "837b2ce2135a38874eb553291b44b4e5a4cb4554bf6c99aabce9b111ac076f8c");
  const server = await readFile(join(regressionRoot, "src/server/CollectFruit.server.luau"), "utf8");
  assert.equal(/owner|ownership/i.test(server), false, "not-applicable ownership must not require keyword-shaped code");
});

test("candidate repair makes exactly one repair call, preserves history, and verifies an isolated model-authored result", async () => {
  const regressionRoot = join(ROOT, "examples/collect-fruit/regressions/luna-first-pass");
  const sandbox = await mkdtemp(join(tmpdir(), "forge-candidate-repair-"));
  const sourcePaths = ["src/server/CollectFruit.server.luau", "src/client/CollectFruitClient.client.luau"];
  const before = await Promise.all(sourcePaths.map((path) => readFile(join(regressionRoot, path), "utf8")));
  const provider = new RepairOnlyProvider();
  const result = await repairCandidateRegression({ regressionRoot, provider, runDirectory: join(sandbox, "runs"), traceDirectory: join(sandbox, "traces") });
  assert.deepEqual(provider.requests.map((request) => request.purpose), ["repair"]);
  assert.match(provider.requests[0]!.prompt, /MechanicImplementationSpec/);
  assert.match(provider.requests[0]!.prompt, /IMPLEMENTATION_CONSTANT_MISMATCH/);
  assert.match(provider.requests[0]!.prompt, /MAX_DISTANCE = 12/);
  assert.equal(result.source.unchanged, true);
  assert.equal(result.source.generationRunId, "generation_65a285b6-1b69-4e59-8851-cabc2857e056");
  assert.equal(result.source.patchSetId, "patch_generated_8466abed9e2eec8a2b8f3060");
  assert.equal(result.attempt.type, "model_repair");
  assert.equal(result.verification.report.gate.status, "verified", JSON.stringify(result.verification.report));
  assert.equal(result.verification.trace.outcome.modelUsage.calls, 1);
  assert.equal(result.verification.trace.outcome.modelRepairs, 1);
  assert.equal(result.verification.trace.references.modelResponseHash, "837b2ce2135a38874eb553291b44b4e5a4cb4554bf6c99aabce9b111ac076f8c");
  assert.equal(result.outputRoot.startsWith(`${regressionRoot}/`), false);
  assert.equal(result.outputRoot.startsWith(`${result.seedRoot}/`), false);
  assert.equal(await readFile(result.artifactPath, "utf8").then((value) => JSON.parse(value).kind), "CandidateArtifact");
  const loaded = await loadCandidateArtifact(result.artifactPath, join(sandbox, "load-traces"));
  assert.equal(loaded.artifact.artifactHash, result.artifact.artifactHash);
  assert.equal(loaded.artifact.patchSet.id, result.patchSet.id);
  assert.equal(loaded.verification.report.gate.status, "verified");
  assert.equal(loaded.verification.trace.outcome.modelUsage.calls, 0);
  assert.deepEqual(await Promise.all(sourcePaths.map((path) => readFile(join(regressionRoot, path), "utf8"))), before);

  const tamperedArtifactPath = join(sandbox, "tampered-artifact.json");
  const tamperedArtifact = JSON.parse(await readFile(result.artifactPath, "utf8")) as Record<string, unknown>;
  (tamperedArtifact.origin as Record<string, unknown>).regressionId = "different-regression";
  await writeFile(tamperedArtifactPath, JSON.stringify(tamperedArtifact), "utf8");
  await assert.rejects(() => loadCandidateArtifact(tamperedArtifactPath, join(sandbox, "artifact-tamper-traces")), /artifact hash mismatch/);

  const serverPath = join(result.outputRoot, "src/server/CollectFruit.server.luau");
  await writeFile(serverPath, `${await readFile(serverPath, "utf8")}\n-- changed after artifact creation\n`, "utf8");
  await assert.rejects(() => loadCandidateArtifact(result.artifactPath, join(sandbox, "tamper-traces")), /output source changed/);
});

test("candidate repair retains a genuine model defect as a rejected one-call result", async () => {
  const regressionRoot = join(ROOT, "examples/collect-fruit/regressions/luna-first-pass");
  const sandbox = await mkdtemp(join(tmpdir(), "forge-candidate-repair-reject-"));
  const provider = new RepairOnlyProvider(12);
  const result = await repairCandidateRegression({ regressionRoot, provider, runDirectory: join(sandbox, "runs"), traceDirectory: join(sandbox, "traces") });
  assert.deepEqual(provider.requests.map((request) => request.purpose), ["repair"]);
  assert.equal(result.verification.report.gate.status, "rejected");
  assert.deepEqual(result.verification.report.issues.map((issue) => issue.ruleId), ["IMPLEMENTATION_CONSTANT_MISMATCH"]);
  assert.equal(result.verification.trace.outcome.modelUsage.calls, 1);
  await assert.rejects(() => loadCandidateArtifact(result.artifactPath, join(sandbox, "load-traces")), /not eligible for Studio/);
});

test("candidate repair has no Studio execution flags", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "dist/packages/cli/src/index.js"), "candidate", "repair", "examples/collect-fruit/regressions/luna-first-pass", "--studio"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: forge candidate repair/);
  assert.doesNotMatch(result.stderr, /--studio/);
});

function intent(): unknown { return { normalizedGoal: "Collect fruit to progress.", audience: "novice_creator", genreSignals: ["collection"], desiredOutcomes: ["collect fruit"], unresolvedQuestions: [], selectedMechanic: "CollectFruit", coreLoop: { title: "Collect fruit", nodes: [{ id: "collect", label: "Collect fruit", category: "acquisition" }], edges: [], entryNodeId: "collect" } }; }
function proposal(_contractId: string): unknown { return { rationale: "Server owns collection state.", operations: [{ path: "src/server/CollectFruit.server.luau", after: server() }, { path: "src/client/CollectFruitClient.client.luau", after: client() }] }; }
function vulnerableProposal(_contractId: string): unknown { return { rationale: "Unsafe test proposal.", operations: [{ path: "src/server/CollectFruit.server.luau", after: server().replace('Fruit42:GetAttribute("Reward")', "_claimedAmount") }, { path: "src/client/CollectFruitClient.client.luau", after: client() }] }; }
async function loadInterface(projectRoot: string): Promise<{ contract: MechanicContract; spec: MechanicImplementationSpec }> {
  const contractValue: unknown = JSON.parse(await readFile(join(ROOT, "examples/collect-fruit/regressions/luna-first-pass/MechanicContract.json"), "utf8"));
  assertMechanicContract(contractValue);
  const manifestValue: unknown = JSON.parse(await readFile(join(projectRoot, "forge.fixture.json"), "utf8"));
  assertFixtureManifest(manifestValue);
  const map = await buildSemanticMap(projectRoot, manifestValue);
  return { contract: contractValue, spec: compileMechanicImplementationSpec(map, contractValue, { allowedPaths: ["src/server/CollectFruit.server.luau", "src/client/CollectFruitClient.client.luau"], allowedPatchOperations: ["replace_text"] }) };
}
function assertStructuredOutputSchema(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const forbidden of ["minLength", "maxLength", "minItems", "maxItems", "pattern", "minimum", "maximum"]) assert.equal(forbidden in record, false, `schema must not use provider-variant ${forbidden}`);
  if (("enum" in record || "const" in record) && typeof record.type !== "string") assert.fail("enum and const require an explicit type");
  if (record.type === "object") {
    const properties = record.properties as Record<string, unknown>;
    assert.deepEqual([...(record.required as string[])].sort(), Object.keys(properties).sort(), "strict object fields must all be required");
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) child.forEach(assertStructuredOutputSchema);
    else assertStructuredOutputSchema(child);
  }
}
function server(): string { return `--!nocheck\nlocal Players = game:GetService("Players")\nlocal ReplicatedStorage = game:GetService("ReplicatedStorage")\nlocal Workspace = game:GetService("Workspace")\nlocal CollectFruit = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("CollectFruit")\nlocal Fruit42 = Workspace:WaitForChild("Fruit42")\nlocal MAX_DISTANCE = 20\n\nlocal function initializePlayer(player: Player)\n    player:SetAttribute("Inventory", 0)\nend\n\nPlayers.PlayerAdded:Connect(initializePlayer)\nfor _, player in Players:GetPlayers() do initializePlayer(player) end\n\nCollectFruit.OnServerEvent:Connect(function(player: Player, fruitId: unknown, _claimedAmount: unknown)\n    if player.UserId <= 0 then return end\n    if typeof(fruitId) ~= "string" or fruitId ~= "Fruit42" then return end\n    if typeof(_claimedAmount) ~= "number" or _claimedAmount <= 0 then return end\n    if Fruit42:GetAttribute("Consumed") == true then return end\n    local character = player.Character\n    local root = character and character:FindFirstChild("HumanoidRootPart")\n    if not root or not root:IsA("BasePart") then return end\n    if (root.Position - Fruit42.Position).Magnitude > MAX_DISTANCE then return end\n    Fruit42:SetAttribute("Consumed", true)\n    player:SetAttribute("Inventory", (player:GetAttribute("Inventory") or 0) + Fruit42:GetAttribute("Reward"))\nend)\n`; }
function client(): string { return `local Players = game:GetService("Players")\nlocal ReplicatedStorage = game:GetService("ReplicatedStorage")\nlocal CollectionService = game:GetService("CollectionService")\nlocal Workspace = game:GetService("Workspace")\nlocal player = Players.LocalPlayer\nlocal mouse = player:GetMouse()\nlocal CollectFruit = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("CollectFruit")\n\nmouse.Button1Down:Connect(function()\n    local fruit = mouse.Target\n    if fruit and fruit:IsDescendantOf(Workspace) and CollectionService:HasTag(fruit, "collectible") then\n        CollectFruit:FireServer(fruit.Name, 1)\n    end\nend)\n`; }
