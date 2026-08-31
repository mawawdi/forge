--!strict
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local Constants = require(script.Parent.Constants)
local Hash = require(script.Parent.Hash)
local ObservationRevision = require(script.Parent.ObservationRevision)
local StudioInstancePolicy = require(script.Parent.StudioInstancePolicy)

local SnapshotCollector = {}
SnapshotCollector.__index = SnapshotCollector

local function project()
	return { name = game.Name, placeId = game.PlaceId, universeId = game.GameId }
end
local function iso(): string return os.date("!%Y-%m-%dT%H:%M:%SZ") end
local function pathOf(instance: Instance): string
	local parts = {}
	local cursor: Instance? = instance
	while cursor and cursor ~= game do table.insert(parts, 1, cursor.Name); cursor = cursor.Parent end
	return table.concat(parts, "/")
end
local function primitive(instance: Instance): {{name: string, value: string | number | boolean}}
	local result = {}
	for _, property in ipairs({ "CanTouch", "CanCollide", "Anchored", "Enabled", "Value", "Transparency", "ActionText", "ObjectText", "MaxActivationDistance", "HoldDuration" }) do
		local ok, value = pcall(function() return (instance :: any)[property] end)
		if ok and (typeof(value) == "string" or typeof(value) == "number" or typeof(value) == "boolean") then table.insert(result, { name = property, value = value }) end
	end
	if instance:IsA("BasePart") then
		local size = instance.Size; local color = instance.Color
		local components = { instance.CFrame:GetComponents() }
		table.insert(result, { name = "Material", value = instance.Material.Name })
		table.insert(result, { name = "Size", value = table.concat({ tostring(size.X), tostring(size.Y), tostring(size.Z) }, ",") })
		table.insert(result, { name = "Color", value = table.concat({ tostring(color.R), tostring(color.G), tostring(color.B) }, ",") })
		local serialized = {} :: {string}; for _, component in ipairs(components) do table.insert(serialized, tostring(component)) end
		table.insert(result, { name = "CFrame", value = table.concat(serialized, ",") })
	end
	table.sort(result, function(left, right) return left.name < right.name end)
	return result
end
local function primitiveAttributes(instance: Instance): {{name: string, value: string | number | boolean}}
	local result = {}
	for name, value in pairs(instance:GetAttributes()) do
		if name ~= Constants.IDENTITY_ATTRIBUTE then
			if typeof(value) ~= "string" and typeof(value) ~= "number" and typeof(value) ~= "boolean" then
				error("Forge cannot represent attribute " .. name .. " on " .. pathOf(instance) .. " because its type is " .. typeof(value))
			end
			table.insert(result, { name = name, value = value })
		end
	end
	table.sort(result, function(left, right) return left.name < right.name end)
	return result
end
local function position(instance: Instance): {x: number, y: number, z: number}?
	if not instance:IsA("BasePart") then return nil end
	return { x = instance.Position.X, y = instance.Position.Y, z = instance.Position.Z }
end

function SnapshotCollector.new(registry)
	return setmetatable({ registry = registry }, SnapshotCollector)
end

function SnapshotCollector:collect()
	local instances, scripts, remotes = {}, {}, {}
	for _, rootName in ipairs(StudioInstancePolicy.rootNames()) do
		local root = game:FindFirstChild(rootName)
		if root then
			-- Service roots are explicit parent facts. They are not authoring
			-- targets, so they use stable synthetic identities and do not need a
			-- Forge attribute or registry entry.
			table.insert(instances, { stableId = "forge_service_root_" .. rootName, path = rootName, className = root.ClassName, properties = {}, attributes = {}, tags = {} })
			local descendants = root:GetDescendants()
			for _, instance in ipairs(descendants) do
				if StudioInstancePolicy.shouldHaveStableIdentity(instance) then self.registry:enrollInstance(instance) end
			end
			table.sort(descendants, function(a, b)
				local left, right = pathOf(a), pathOf(b)
				if left ~= right then return left < right end
				if a.ClassName ~= b.ClassName then return a.ClassName < b.ClassName end
				return tostring(a:GetAttribute(Constants.IDENTITY_ATTRIBUTE)) < tostring(b:GetAttribute(Constants.IDENTITY_ATTRIBUTE))
			end)
			for _, instance in ipairs(descendants) do
				if StudioInstancePolicy.shouldHaveStableIdentity(instance) then
					local stableId = instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE)
					if typeof(stableId) ~= "string" then error("Forge stable identity enrollment failed for " .. pathOf(instance) .. " (" .. instance.ClassName .. ")") end
					local attributes = primitiveAttributes(instance)
					local tags = CollectionService:GetTags(instance)
					table.sort(tags)
					local entry: any = { stableId = stableId, path = pathOf(instance), className = instance.ClassName, properties = primitive(instance), attributes = attributes, tags = tags }
					local worldPosition = position(instance)
					if worldPosition then entry.position = worldPosition end
					table.insert(instances, entry)
					if instance:IsA("LuaSourceContainer") then
						local readable, source = pcall(function() return instance.Source end)
						if not readable or typeof(source) ~= "string" then error("Forge requires complete readable Script.Source for " .. pathOf(instance)) end
						local context = instance:IsA("LocalScript") and "client" or instance:IsA("Script") and "server" or "shared"
						table.insert(scripts, { stableId = stableId, path = pathOf(instance), executionContext = context, sourceHash = Hash.sha256(source), source = source })
					end
					if instance:IsA("RemoteEvent") or instance:IsA("RemoteFunction") then table.insert(remotes, { path = pathOf(instance), name = instance.Name, className = instance.ClassName, direction = "client_to_server" }) end
				end
			end
		end
	end
	table.sort(instances, function(a, b) return a.path < b.path or (a.path == b.path and (a.className < b.className or (a.className == b.className and a.stableId < b.stableId))) end)
	table.sort(scripts, function(a, b) return a.path < b.path or (a.path == b.path and a.stableId < b.stableId) end)
	table.sort(remotes, function(a, b) return a.path < b.path or (a.path == b.path and a.className < b.className) end)
	local observation = { kind = "StudioSnapshotObservation", project = project(), capturedAt = iso(), instances = instances, scripts = scripts, remotes = remotes }
	local encoded = HttpService:JSONEncode(observation)
	local observationHash = Hash.sha256(ObservationRevision.material(observation))
	return {
		project = project(),
		revision = { kind = "StudioRevision", observationHash = observationHash, identityHash = Hash.sha256(ObservationRevision.identityMaterial(observation)), capturedAt = observation.capturedAt },
		observation = observation,
		encoded = encoded,
	}
end

function SnapshotCollector:chunks(snapshot, reason: string)
	local payload = snapshot.encoded
	local size = Constants.MAX_SNAPSHOT_BYTES
	local total = math.ceil(#payload / size)
	if total > Constants.MAX_SNAPSHOT_CHUNKS then error("Studio snapshot exceeds Forge chunk limits") end
	local id = "snapshot_" .. HttpService:GenerateGUID(false)
	local chunks = {}
	for index = 1, total do
		local part = string.sub(payload, (index - 1) * size + 1, index * size)
		table.insert(chunks, { project = snapshot.project, revision = snapshot.revision, reason = reason, snapshotId = id, index = index - 1, total = total, encoding = "json", payload = part, payloadHash = Hash.sha256(part) })
	end
	return chunks
end

return SnapshotCollector
