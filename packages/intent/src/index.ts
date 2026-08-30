import { contentHash, type CoreLoop, type CoreLoopExtensionDraft, type GameIntent, type IntentDraft, type MechanicContract } from "../../contracts/src/index.js";

const ASSERTION_IDS = ["CF-001", "CF-002", "CF-003", "CF-004", "CF-005", "CF-006", "CF-007"] as const;

export interface CompiledIntent {
  gameIntent: GameIntent;
  coreLoop: CoreLoop;
  mechanicContract: MechanicContract;
}

export interface CompiledCoreLoopExtension extends CompiledIntent {
  priorGameIntent: GameIntent;
  priorCoreLoop: CoreLoop;
}

/** Validate an untrusted model answer before it reaches Forge domain objects. */
export function parseIntentDraft(value: unknown): IntentDraft {
  if (!record(value)) throw new Error("IntentDraft must be an object");
  exactKeys(value, ["normalizedGoal", "audience", "genreSignals", "desiredOutcomes", "unresolvedQuestions", "selectedMechanic", "coreLoop"]);
  if (!string(value.normalizedGoal) || !audience(value.audience) || !strings(value.genreSignals) || !strings(value.desiredOutcomes) || !strings(value.unresolvedQuestions) || value.selectedMechanic !== "CollectFruit") throw new Error("Invalid IntentDraft fields");
  if (!record(value.coreLoop)) throw new Error("IntentDraft coreLoop must be an object");
  exactKeys(value.coreLoop, ["title", "nodes", "edges", "entryNodeId"]);
  if (!string(value.coreLoop.title) || !string(value.coreLoop.entryNodeId) || !Array.isArray(value.coreLoop.nodes) || !Array.isArray(value.coreLoop.edges)) throw new Error("Invalid IntentDraft coreLoop");
  const nodes = value.coreLoop.nodes.map((node) => parseNode(node));
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (!nodeIds.has(value.coreLoop.entryNodeId) || nodeIds.size !== nodes.length) throw new Error(`IntentDraft coreLoop has invalid nodes (entry=${value.coreLoop.entryNodeId}, nodeIds=${nodes.map((node) => node.id).join(",")})`);
  const edges = value.coreLoop.edges.map((edge) => parseEdge(edge));
  if (edges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))) throw new Error("IntentDraft coreLoop edge references unknown node");
  return {
    kind: "IntentDraft", schemaVersion: 1, normalizedGoal: value.normalizedGoal.trim(), audience: value.audience,
    genreSignals: normalizedStrings(value.genreSignals), desiredOutcomes: normalizedStrings(value.desiredOutcomes), unresolvedQuestions: normalizedStrings(value.unresolvedQuestions), selectedMechanic: "CollectFruit",
    coreLoop: { title: value.coreLoop.title.trim(), nodes, edges, entryNodeId: value.coreLoop.entryNodeId }
  };
}

export function parseCoreLoopExtensionDraft(value: unknown): CoreLoopExtensionDraft {
  if (!record(value)) throw new Error("CoreLoopExtensionDraft must be an object");
  exactKeys(value, ["normalizedGoal", "desiredOutcomes", "unresolvedQuestions", "selectedMechanic"]);
  if (!string(value.normalizedGoal) || !strings(value.desiredOutcomes) || !strings(value.unresolvedQuestions) || value.selectedMechanic !== "SellInventory") throw new Error("Invalid CoreLoopExtensionDraft fields");
  return { kind: "CoreLoopExtensionDraft", schemaVersion: 1, normalizedGoal: value.normalizedGoal.trim(), desiredOutcomes: normalizedStrings(value.desiredOutcomes), unresolvedQuestions: normalizedStrings(value.unresolvedQuestions), selectedMechanic: "SellInventory" };
}

/** Forge owns IDs, authority, assertions, and security invariants. */
export function compileIntent(prompt: string, draft: IntentDraft, now: Date = new Date()): CompiledIntent {
  if (!prompt.trim()) throw new Error("Creator prompt must not be empty");
  if (draft.kind !== "IntentDraft" || draft.schemaVersion !== 1) throw new Error("Invalid Forge IntentDraft envelope");
  const parsed = draft;
  const suffix = contentHash(`${prompt}\n${JSON.stringify(parsed)}`).slice(0, 16);
  const intentId = `intent_${suffix}`;
  const loopId = `loop_${suffix}`;
  const contractId = `contract_collect_fruit_${suffix}`;
  const gameIntent: GameIntent = {
    kind: "GameIntent", schemaVersion: 1, id: intentId, rawPrompt: prompt, normalizedGoal: parsed.normalizedGoal,
    audience: parsed.audience, genreSignals: parsed.genreSignals, desiredOutcomes: parsed.desiredOutcomes,
    constraints: [{ id: "constraint_server_authority", statement: "Fruit availability, inventory, and rewards are server-owned.", source: "system" }],
    referencedMechanics: ["CollectFruit"], unresolvedQuestions: parsed.unresolvedQuestions,
    source: { type: "creator_prompt", createdAt: now.toISOString() }
  };
  const coreLoop: CoreLoop = {
    kind: "CoreLoop", schemaVersion: 1, id: loopId, intentId, title: parsed.coreLoop.title,
    nodes: parsed.coreLoop.nodes.map((node) => ({ ...node, ...(node.id === parsed.coreLoop.entryNodeId ? { mechanicContractId: contractId } : {}), status: node.id === parsed.coreLoop.entryNodeId ? "in_progress" : "proposed" })),
    edges: parsed.coreLoop.edges, entryNodeId: parsed.coreLoop.entryNodeId,
    invariants: ["Only the server mutates inventory.", "A client cannot select the reward.", "A fruit is consumed at most once."]
  };
  const mechanicContract: MechanicContract = {
    kind: "MechanicContract", schemaVersion: 2, id: contractId, coreLoopId: loopId, name: "CollectFruit",
    playerGoal: "Request a collectible fruit and receive exactly its server-defined reward once.",
    preconditions: [
      { id: "fruit_exists", statement: "The requested fruit exists and is collectible.", authority: "server" },
      { id: "fruit_available", statement: "The fruit is currently available.", authority: "server" },
      { id: "player_in_range", statement: "The player is in an authorized interaction context and distance.", authority: "server" }
    ],
    postconditions: [
      { id: "fruit_consumed", statement: "The server marks the fruit unavailable after collection.", authority: "server" },
      { id: "inventory_once", statement: "Inventory increases exactly once by the server-derived reward.", authority: "server" }
    ],
    authorityModel: {
      stateOwner: "server",
      clientInputs: [
        { position: 1, role: "fruit_id", type: "string", trust: "untrusted" },
        { position: 2, role: "claimed_reward", type: "number", trust: "untrusted" }
      ],
      validationRequirements: [
        { category: "type", subjectRole: "fruit_id", applicability: "required", rationale: "The identifier crosses an untrusted RemoteEvent boundary." },
        { category: "value", subjectRole: "fruit_id", applicability: "required", rationale: "The identifier must resolve to a permitted collectible." },
        { category: "type", subjectRole: "claimed_reward", applicability: "required", rationale: "Adversarial numeric input must be safely handled even though it is not authoritative." },
        { category: "value", subjectRole: "claimed_reward", applicability: "required", rationale: "Non-finite and negative claims must be rejected." },
        { category: "context", subjectRole: "interaction", applicability: "required", rationale: "The server must establish real collectible and distance context." },
        { category: "permission", subjectRole: "interaction", applicability: "required", rationale: "The request must belong to the server-supplied active player context." },
        { category: "ownership", subjectRole: "target", applicability: "not_applicable", rationale: "Fruit is globally collectible and is not player-owned." }
      ],
      stateMutations: [{ field: "Inventory", authority: "server", operation: "increment by Fruit.Reward" }, { field: "Fruit.Consumed", authority: "server", operation: "set true" }]
    },
    persistentState: [{ field: "Inventory", type: "number", owner: "server", durability: "session" }],
    uiOutputs: [], economyEffects: [{ currency: "fruit", delta: "+ server-defined reward", computedBy: "server" }],
    instrumentation: [{ event: "fruit.collected", fields: ["fruit_id", "reward"], privacyClass: "project" }], studioAssertions: [...ASSERTION_IDS], risk: "critical"
  };
  return { gameIntent, coreLoop, mechanicContract };
}

/** Forge preserves the established loop and compiles only its declared next node. */
export function compileCoreLoopExtension(prompt: string, draft: CoreLoopExtensionDraft, previousIntent: GameIntent, previousLoop: CoreLoop, targetNodeId: string, now: Date = new Date()): CompiledCoreLoopExtension {
  if (!prompt.trim() || draft.kind !== "CoreLoopExtensionDraft" || draft.schemaVersion !== 1) throw new Error("Invalid core-loop extension input");
  const target = previousLoop.nodes.find((node) => node.id === targetNodeId);
  if (!target || target.status !== "proposed" || target.category !== "conversion") throw new Error(`CoreLoop extension target ${targetNodeId} is not a proposed conversion node`);
  const suffix = contentHash(`${previousIntent.id}\n${previousLoop.id}\n${prompt}\n${JSON.stringify(draft)}`).slice(0, 16);
  const contractId = `contract_sell_inventory_${suffix}`;
  const gameIntent: GameIntent = {
    ...previousIntent,
    rawPrompt: `${previousIntent.rawPrompt}\n\n${prompt}`,
    normalizedGoal: draft.normalizedGoal,
    desiredOutcomes: [...new Set([...previousIntent.desiredOutcomes, ...draft.desiredOutcomes])].sort(),
    referencedMechanics: [...new Set([...previousIntent.referencedMechanics, "SellInventory"])].sort(),
    unresolvedQuestions: draft.unresolvedQuestions,
    source: { type: "creator_prompt", createdAt: now.toISOString() }
  };
  const nextRecommendedNodeId = previousLoop.nodes.find((node) => node.id === "node_upgrade")?.id;
  const coreLoop: CoreLoop = {
    ...previousLoop,
    nodes: previousLoop.nodes.map((node) => node.id === targetNodeId
      ? { ...node, mechanicContractId: contractId, status: "in_progress" }
      : node.label === "CollectFruit"
        ? { ...node, status: "verified" }
        : node),
    ...(nextRecommendedNodeId ? { nextRecommendedNodeId } : {}),
    invariants: [...new Set([...previousLoop.invariants, "Only the server converts Inventory into Coins.", "A client cannot select sale price, quantity, payout, or resulting coin balance."])]
  };
  const mechanicContract: MechanicContract = {
    kind: "MechanicContract", schemaVersion: 2, id: contractId, coreLoopId: coreLoop.id, name: "SellInventory",
    playerGoal: "Sell the current authoritative fruit inventory for server-calculated coins.",
    preconditions: [
      { id: "inventory_positive", statement: "Player Inventory is greater than zero.", authority: "server" },
      { id: "sell_context", statement: "Player is within the authorized SellZone interaction distance.", authority: "server" }
    ],
    postconditions: [
      { id: "inventory_cleared", statement: "Server clears Inventory exactly to zero before crediting Coins.", authority: "server" },
      { id: "coins_server_derived", statement: "Server credits Coins by Inventory multiplied by server-owned UnitPrice.", authority: "server" }
    ],
    authorityModel: {
      stateOwner: "server", clientInputs: [],
      validationRequirements: [
        { category: "context", subjectRole: "sell_context", applicability: "required", rationale: "Server establishes live player-to-SellZone distance." },
        { category: "permission", subjectRole: "interaction", applicability: "required", rationale: "The server-supplied Player owns the authoritative attributes." }
      ],
      stateMutations: [
        { field: "Inventory", authority: "server", operation: "set exactly zero before payout" },
        { field: "Coins", authority: "server", operation: "increment by server-owned Inventory times UnitPrice" }
      ]
    },
    persistentState: [
      { field: "Inventory", type: "number", owner: "server", durability: "session" },
      { field: "Coins", type: "number", owner: "server", durability: "session" }
    ],
    uiOutputs: [], economyEffects: [{ currency: "coins", delta: "+ Inventory × UnitPrice", computedBy: "server" }],
    instrumentation: [{ event: "inventory.sold", fields: ["inventory_count", "unit_price", "payout"], privacyClass: "project" }],
    studioAssertions: ["SF-001", "SF-002", "SF-003", "SF-004", "SF-005", "SF-006", "CL-001"], risk: "critical"
  };
  return { priorGameIntent: previousIntent, priorCoreLoop: previousLoop, gameIntent, coreLoop, mechanicContract };
}

function parseNode(value: unknown): IntentDraft["coreLoop"]["nodes"][number] {
  if (!record(value)) throw new Error("Invalid CoreLoop node");
  exactKeys(value, ["id", "label", "category"]);
  if (!string(value.id) || !string(value.label) || !["acquisition", "conversion", "progression", "social", "retention", "monetization"].includes(String(value.category))) throw new Error("Invalid CoreLoop node");
  return { id: value.id, label: value.label, category: value.category as IntentDraft["coreLoop"]["nodes"][number]["category"] };
}

function parseEdge(value: unknown): IntentDraft["coreLoop"]["edges"][number] {
  if (!record(value)) throw new Error("Invalid CoreLoop edge");
  exactKeys(value, ["from", "to", "condition"]);
  if (!string(value.from) || !string(value.to) || (value.condition !== null && !string(value.condition))) throw new Error("Invalid CoreLoop edge");
  return value.condition === null ? { from: value.from, to: value.to } : { from: value.from, to: value.to, condition: value.condition };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function string(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(string); }
function normalizedStrings(value: string[]): string[] { return [...new Set(value.map((entry) => entry.trim()))].sort(); }
function audience(value: unknown): value is GameIntent["audience"] { return value === "novice_creator" || value === "experienced_creator" || value === "unknown"; }
function exactKeys(value: Record<string, unknown>, expected: string[]): void { const received = Object.keys(value).sort(); const allowed = [...expected].sort(); if (received.length !== allowed.length || received.some((key, index) => key !== allowed[index])) throw new Error(`Unexpected model output fields: ${received.join(", ")}`); }
