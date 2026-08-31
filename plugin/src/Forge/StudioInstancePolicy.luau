--!strict

-- This is the single connector-side definition of instances that participate
-- in Forge snapshots and therefore require stable identity. Snapshot discovery
-- and identity enrollment must never maintain independent class lists.
local StudioInstancePolicy = {}

local ROOT_NAMES = { "Workspace", "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterPlayer", "StarterGui", "StarterPack", "ReplicatedFirst", "Lighting", "SoundService", "Teams" }
local ROOT_SET = {} :: {[string]: boolean}
for _, name in ipairs(ROOT_NAMES) do ROOT_SET[name] = true end

local DIRECT_CLASSES = {
	ProximityPrompt = true,
	Folder = true,
	Model = true,
	RemoteEvent = true,
	RemoteFunction = true,
	Tool = true,
	StarterPlayerScripts = true,
	StarterCharacterScripts = true,
	Team = true,
}

function StudioInstancePolicy.isSnapshotRelevant(instance): boolean
	if instance:IsA("BasePart")
		or instance:IsA("LuaSourceContainer")
		or instance:IsA("GuiObject")
		or instance:IsA("LayerCollector") then
		return true
	end
	return DIRECT_CLASSES[instance.ClassName] == true
end

function StudioInstancePolicy.rootNames(): {string}
	return table.clone(ROOT_NAMES)
end

function StudioInstancePolicy.isWithinSnapshotRoot(instance): boolean
	local cursor = instance
	while cursor.Parent and cursor.Parent ~= game do cursor = cursor.Parent end
	return cursor.Parent == game and ROOT_SET[cursor.Name] == true
end

function StudioInstancePolicy.shouldHaveStableIdentity(instance): boolean
	return StudioInstancePolicy.isWithinSnapshotRoot(instance)
		and StudioInstancePolicy.isSnapshotRelevant(instance)
end

return StudioInstancePolicy
