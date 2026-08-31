local ObservationRevision = require("../plugin/src/Forge/ObservationRevision")
local RuntimeCapabilityEncoding = require("../plugin/src/Forge/RuntimeCapabilityEncoding")
local CreatorUiState = require("../plugin/src/Forge/CreatorUiState")
local StudioAuthoring = require("../plugin/src/Forge/StudioAuthoring")
local StudioInstancePolicy = require("../plugin/src/Forge/StudioInstancePolicy")

local function fakeInstance(className: string, inheritedClasses: {string}?)
	local inherited = {}
	for _, name in ipairs(inheritedClasses or {}) do inherited[name] = true end
	return {
		ClassName = className,
		IsA = function(_, requested: string): boolean
			return requested == className or inherited[requested] == true
		end,
	}
end

for _, className in ipairs({ "Part", "ProximityPrompt", "Folder", "Model", "RemoteEvent", "RemoteFunction", "Script", "Frame", "ScreenGui", "Tool", "StarterPlayerScripts", "StarterCharacterScripts", "Team" }) do
	local inherited = if className == "Part" then { "BasePart" }
		elseif className == "Script" then { "LuaSourceContainer" }
		elseif className == "Frame" then { "GuiObject" }
		elseif className == "ScreenGui" then { "LayerCollector" }
		else nil
	assert(StudioInstancePolicy.isSnapshotRelevant(fakeInstance(className, inherited)), className .. " must share snapshot and identity eligibility")
end
assert(not StudioInstancePolicy.isSnapshotRelevant(fakeInstance("Camera")), "unmodeled instances must stay outside snapshot and identity enrollment")
local roots = StudioInstancePolicy.rootNames()
assert(roots[1] == "Workspace" and table.find(roots, "ServerScriptService") and table.find(roots, "StarterPlayer"), "snapshot roots must cover world, source, and starter containers")
roots[1] = "mutated"
assert(StudioInstancePolicy.rootNames()[1] == "Workspace", "callers must not mutate the canonical snapshot-root policy")

local function observation(capturedAt: string, stableId: string, sourceHash: string)
	return {
		kind = "StudioSnapshotObservation",

		project = { name = "ForgeRuntimeFixture", placeId = 1, universeId = 2 },
		capturedAt = capturedAt,
		instances = {
			{ stableId = stableId, path = "ServerScriptService/RuntimeScript", className = "Script", properties = { { name = "Enabled", value = true } }, attributes = {}, tags = {} },
		},
		scripts = {
			{ stableId = stableId, path = "ServerScriptService/RuntimeScript", executionContext = "server", sourceHash = sourceHash },
		},
		remotes = {},
	}
end

local first = observation("2026-08-29T00:00:00Z", "forge_a", "source_a")
local later = observation("2026-08-29T00:00:10Z", "forge_a", "source_a")
assert(ObservationRevision.material(first) == ObservationRevision.material(later), "capture timestamps must not change live revisions")

local changedSource = observation("2026-08-29T00:00:10Z", "forge_a", "source_b")
assert(ObservationRevision.material(first) ~= ObservationRevision.material(changedSource), "source changes must change live revisions")

local changedIdentity = observation("2026-08-29T00:00:10Z", "forge_b", "source_a")
assert(ObservationRevision.material(first) ~= ObservationRevision.material(changedIdentity), "stable target identity changes must change live revisions")
assert(ObservationRevision.identityMaterial(first) ~= ObservationRevision.identityMaterial(changedIdentity), "identity revisions must detect identity changes")

-- The trusted runner receives untrusted plan JSON only as one escaped
-- literal; these hostile characters must not escape into runner syntax.
local hostile = '{"path":"Workspace/MovingPlatform\" .. error(\"injected\") .. ","line":"\\n-- injected"}'
local literal = RuntimeCapabilityEncoding.singleStringLiteral(hostile)
assert(string.sub(literal, 1, 1) == '"' and string.sub(literal, -1) == '"', "runtime plan must be exactly one quoted literal")
assert(not string.find(literal, "\n-- injected", 1, true), "raw plan newlines must stay escaped")

-- The fixed executor is deliberately the only interpreter. Protocol tests cover
-- its service-root resolution policy; this module test keeps the hostile plan
-- fixture anchored to a Workspace-only BasePart target.
assert(string.find(hostile, "Workspace/", 1, true), "BasePart observation fixtures must remain Workspace-scoped")

local statuses = { "planning", "awaiting_plan_approval", "building", "awaiting_change_approval", "applying", "awaiting_verification", "verifying", "repairing", "awaiting_review", "creator_accepted", "creator_rejected", "rolled_back", "incomplete", "recovery_required" }
for _, status in ipairs(statuses) do
	local view = { kind = "CreatorControlView", id = "view_" .. status, hash = string.rep("a", 64), creatorSessionId = "creator_session_test", creatorSessionHash = string.rep("b", 64), status = status, title = status, detail = "detail" }
	if status == "awaiting_plan_approval" then view.primaryAction = { id = "approve_plan", label = "Approve Plan", intent = "primary" }; view.secondaryAction = { id = "reject_plan", label = "Reject", intent = "secondary" }
	elseif status == "awaiting_change_approval" then view.primaryAction = { id = "approve_and_apply_changes", label = "Approve & Apply", intent = "primary" }; view.secondaryAction = { id = "reject_changes", label = "Reject", intent = "secondary" }
	elseif status == "awaiting_verification" then view.primaryAction = { id = "start_checks", label = "Start Approved Checks", intent = "primary" }; view.secondaryAction = { id = "cancel_changes", label = "Cancel Changes", intent = "secondary" }
	elseif status == "awaiting_review" then view.primaryAction = { id = "accept_result", label = "Accept Result", intent = "primary" }; view.secondaryAction = { id = "reject_and_rollback", label = "Reject & Roll Back", intent = "secondary" } end
	local mapped = CreatorUiState.fromView(view)
	assert(mapped.status == status, "creator UI mapping must preserve every coordinator status")
	if view.primaryAction then
		local payload = CreatorUiState.actionPayload(view, "primary")
		assert(payload.viewId == view.id and payload.viewHash == view.hash and payload.actionId == view.primaryAction.id, "creator action must remain bound to the exact view hash")
	else assert(mapped.primary == nil and mapped.secondary == nil, "non-interactive statuses must not invent plugin actions") end
end

local staleOk = pcall(function() CreatorUiState.actionPayload({ kind = "CreatorControlView", id = "stale", hash = string.rep("c", 64), creatorSessionId = "session", creatorSessionHash = string.rep("d", 64), status = "awaiting_plan_approval", title = "Review", detail = "", primaryAction = { id = "apply", label = "Legacy Apply", intent = "primary" } }, "primary") end)
assert(not staleOk, "legacy or unavailable workflow actions must fail closed in the plugin mapping")

local function payload(properties, source, sourceRequired)
	return { kind = "create", className = sourceRequired and "Script" or "Part", properties = properties, attributes = { CreatorOwned = true }, source = source, sourceRequired = sourceRequired == true }
end

local identityCFrame = { type = "cframe", components = { 0, 2, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1 } }
assert(StudioAuthoring.validatePayloadForTest(payload({
	Transparency = { type = "number", value = 0 },
	Size = { type = "vector3", x = 4, y = 1, z = 4 },
	Color = { type = "color3", r = 0, g = 1, b = 0 },
	CFrame = identityCFrame,
	Material = { type = "string", value = "Neon" },
}, nil, false)), "valid typed Part payload must pass Studio preflight")

local invalidPayloads = {
	payload({ Transparency = { type = "number", value = -0.001 } }, nil, false),
	payload({ Transparency = { type = "number", value = 1.001 } }, nil, false),
	payload({ Size = { type = "vector3", x = 0, y = 1, z = 1 } }, nil, false),
	payload({ Size = { type = "vector3", x = 2049, y = 1, z = 1 } }, nil, false),
	payload({ Color = { type = "color3", r = 1.001, g = 0, b = 0 } }, nil, false),
	payload({ Color = { type = "color3", r = 0.1, g = 1, b = 0.2 } }, nil, false),
	payload({ CFrame = { type = "cframe", components = { math.huge, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1 } } }, nil, false),
	payload({ CFrame = { type = "cframe", components = { 100001, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1 } } }, nil, false),
	payload({ CFrame = { type = "cframe", components = { 0, 0, 0, 1.01, 0, 0, 0, 1, 0, 0, 0, 1 } } }, nil, false),
	payload({ Material = { type = "string", value = "ExploitMaterial" } }, nil, false),
	payload({ CFrame = { type = "cframe", components = { 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1 }, extra = true } }, nil, false),
}
for _, invalid in ipairs(invalidPayloads) do
	assert(not pcall(function() StudioAuthoring.validatePayloadForTest(invalid) end), "unsafe typed property payload must fail Studio preflight")
end

assert(StudioAuthoring.validatePayloadForTest(payload({}, string.rep("é", 24000), true)), "48,000-byte valid UTF-8 source must pass")
assert(not pcall(function() StudioAuthoring.validatePayloadForTest(payload({}, string.rep("é", 24001), true)) end), "source byte cap must count UTF-8 bytes")
assert(not pcall(function() StudioAuthoring.validatePayloadForTest(payload({}, string.char(255), true)) end), "invalid UTF-8 source must fail")
assert(not pcall(function() StudioAuthoring.validatePayloadForTest(payload({}, "   \n", true)) end), "empty script source must fail")

-- The transport-level tests assert that create passes allowNull=false while
-- update passes allowNull=true. Lua tables cannot retain a literal nil key,
-- so module tests cover every value that has a concrete runtime representation.
assert(not pcall(function() StudioAuthoring.validatePayloadForTest({ kind = "create", className = "Part", properties = {}, attributes = { _forgeReserved = true }, sourceRequired = false }) end), "reserved create attributes must fail before mutation")
assert(StudioAuthoring.validatePayloadForTest({ kind = "update", className = "Part", properties = {}, attributes = { Current = true }, removedAttributes = { "Legacy" }, sourceRequired = false }), "explicit disjoint attribute removal must pass")
assert(not pcall(function() StudioAuthoring.validatePayloadForTest({ kind = "update", className = "Part", properties = {}, attributes = { Same = true }, removedAttributes = { "Same" }, sourceRequired = false }) end), "an attribute cannot be set and removed together")
assert(not pcall(function() StudioAuthoring.validatePayloadForTest({ kind = "update", className = "Part", properties = {}, attributes = {}, removedAttributes = { "Repeated", "Repeated" }, sourceRequired = false }) end), "duplicate attribute removals must fail")

print("plugin module tests passed")
