local ObservationRevision = require("../plugin/src/Forge/ObservationRevision")

local function observation(capturedAt: string, stableId: string, sourceHash: string)
	return {
		kind = "StudioSnapshotObservation",
		schemaVersion = 2,
		project = { name = "ForgeCollectFruit", placeId = 1, universeId = 2 },
		capturedAt = capturedAt,
		instances = {
			{ stableId = stableId, path = "ServerScriptService/CollectFruit", className = "Script", properties = { { name = "Enabled", value = true } }, attributes = {}, tags = {} },
		},
		scripts = {
			{ stableId = stableId, path = "ServerScriptService/CollectFruit", executionContext = "server", sourceHash = sourceHash },
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

print("plugin module tests passed")
