-- Regression against real Roblox place serialization, not a mocked attribute store.
local roblox = require("@lune/roblox")
local Hash = require("../plugin/src/Forge/Hash")
local Identity = require("../plugin/src/Forge/StudioProjectIdentity")

Hash.setDigestForTest(function(_value: string): string return string.rep("\0", 32) end)
local place = roblox.Instance.new("DataModel")
local id = "forge_project_0123456789abcdef0123456789abcdef"
place:GetService("Workspace"):SetAttribute("_forgeProjectId", id)
-- The old storage location is deliberately different: it must never be authority.
place:SetAttribute("_forgeProjectId", "forge_project_ffffffffffffffffffffffffffffffff")
for _, xml in ipairs({ false, true }) do
	local reopened = roblox.deserializePlace(roblox.serializePlace(place, xml))
	assert(reopened:GetAttribute("_forgeProjectId") == nil, "DataModel attributes are not place-persistent")
	assert(reopened:GetService("Workspace"):GetAttribute("_forgeProjectId") == id, "saved place must retain its project ID")
	local renamed = { Name = "Renamed local copy", PlaceId = 0, GameId = 0 }
	function renamed:GetService(name: string): any return reopened:GetService(name) end
	assert(Identity.observeForTest(renamed).reservedAttribute.forgeProjectId == id, "reopening or renaming must continue the same project")
end
print("Project identity persistence passed: binary and XML Save/Open, renamed copy")
