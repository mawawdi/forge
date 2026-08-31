local ObservationRevision = require("../plugin/src/Forge/ObservationRevision")
local RuntimeCapabilityEncoding = require("../plugin/src/Forge/RuntimeCapabilityEncoding")

local function observation(capturedAt: string, stableId: string, sourceHash: string)
	return {
		kind = "StudioSnapshotObservation",
		schemaVersion = 3,
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

print("plugin module tests passed")
