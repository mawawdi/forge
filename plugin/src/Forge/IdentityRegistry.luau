--!strict
local Constants = require(script.Parent.Constants)
local Hash = require(script.Parent.Hash)
local Generated = require(script.Parent.GeneratedStudioEvidence)
local StudioInstancePolicy = require(script.Parent.StudioInstancePolicy)

local IdentityRegistry = {}
IdentityRegistry.__index = IdentityRegistry

local function inKnownRoot(instance: Instance): boolean
	return StudioInstancePolicy.isWithinEvidenceRoot(instance)
end

function IdentityRegistry.new()
	return setmetatable({
		byId = {} :: {[string]: Instance},
		byOpaqueHash = {} :: {[string]: Instance},
		connections = {} :: {RBXScriptConnection},
		connectorEpoch = nil :: string?,
	}, IdentityRegistry)
end

function IdentityRegistry:setConnectorEpoch(connectorEpoch: string)
	Generated.studioObjectIdentity({ kind = "studio_ephemeral", connectorEpoch = connectorEpoch, opaqueHash = string.rep("0", 64) })
	if self.connectorEpoch ~= nil and self.connectorEpoch ~= connectorEpoch then table.clear(self.byOpaqueHash) end
	self.connectorEpoch = connectorEpoch
end

function IdentityRegistry:opaqueHashFor(instance: Instance): string
	if not self.connectorEpoch then error("connector epoch is unavailable") end
	if not inKnownRoot(instance) then error("opaque identity is outside an indexed Studio root") end
	-- Paths are display data and need not be unique: same-name siblings are
	-- legal Studio objects. GetDebugId is plugin-local engine identity; only its
	-- epoch-bound digest leaves the plugin and a raw debug id is never persisted.
	local read, debugId = pcall(function() return instance:GetDebugId(0) end)
	if not read or typeof(debugId) ~= "string" or debugId == "" then error("Studio opaque identity debug id is unavailable") end
	return Hash.sha256(self.connectorEpoch .. "\0" .. debugId)
end

function IdentityRegistry:indexInstance(instance: Instance): boolean
	if not inKnownRoot(instance) then return false end
	if self.connectorEpoch then self.byOpaqueHash[self:opaqueHashFor(instance)] = instance end
	local stableId = instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE)
	if typeof(stableId) ~= "string" or stableId == "" then return false end
	Generated.studioObjectIdentity({ kind = "forge_attribute", stableId = stableId })
	local existing = self.byId[stableId]
	if existing and existing ~= instance then error("duplicate Forge stable identity") end
	self.byId[stableId] = instance
	return true
end

-- Indexing is deliberately read-only. The evidence protocol must not create a
-- ChangeHistory recording or mutate a place merely because the connector
-- paired or restarted. Forge attributes are written only by a bound mutation.
function IdentityRegistry:indexProject(cooperate: (() -> ())?): number
	local count = 0
	local visited = 0
	for _, rootName in ipairs(StudioInstancePolicy.rootNames()) do
		local root = game:FindFirstChild(rootName)
		if root then
			-- Avoid one uninterruptible GetDescendants allocation. A depth-first
			-- traversal bounds each engine call to one sibling set and lets pairing
			-- yield under large existing places.
			local stack = { root }
			while #stack > 0 do
				local instance = table.remove(stack)
				visited += 1
				if visited > Constants.PROJECT_INDEX_MAXIMUM_INSTANCES then error("identity registry instance resource policy exceeded") end
				if self:indexInstance(instance) then count += 1 end
				local children = instance:GetChildren()
				for index = #children, 1, -1 do table.insert(stack, children[index]); if cooperate then cooperate() end end
				if cooperate then cooperate() end
			end
		end
	end
	return count
end

function IdentityRegistry:identityFor(instance: Instance): any
	if not inKnownRoot(instance) then error("Studio object is outside indexed roots") end
	local stableId = instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE)
	if typeof(stableId) == "string" and stableId ~= "" then
		Generated.studioObjectIdentity({ kind = "forge_attribute", stableId = stableId })
		self:indexInstance(instance)
		return { kind = "forge_attribute", stableId = stableId }
	end
	local opaqueHash = self:opaqueHashFor(instance)
	self.byOpaqueHash[opaqueHash] = instance
	return { kind = "studio_ephemeral", connectorEpoch = self.connectorEpoch, opaqueHash = opaqueHash }
end

function IdentityRegistry:findOpaque(identity: any): Instance?
	local accepted, canonicalOrFailure = pcall(function() return Generated.studioObjectIdentity(identity) end)
	if not accepted then return nil end
	local canonical = canonicalOrFailure
	if canonical.kind ~= "studio_ephemeral" or canonical.connectorEpoch ~= self.connectorEpoch then return nil end
	local instance = self.byOpaqueHash[canonical.opaqueHash]
	if instance and inKnownRoot(instance) and self:opaqueHashFor(instance) == canonical.opaqueHash then return instance end
	self.byOpaqueHash[canonical.opaqueHash] = nil
	-- The registry is complete before pairing is announced and observes every
	-- later DescendantAdded. A cache miss is stale authority, not permission to
	-- synchronously rescan the whole place from a mutation callback.
	return nil
end

function IdentityRegistry:enrollInstance(instance: Instance, assignedStableId: string?): boolean
	if not inKnownRoot(instance) then return false end
	local stableId = assignedStableId
	if typeof(stableId) ~= "string" then error("approved create requires a deterministic stable identity") end
	Generated.studioObjectIdentity({ kind = "forge_attribute", stableId = stableId })
	if self.byId[stableId] and self.byId[stableId] ~= instance then error("generated stable identity collides") end
	if instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE) ~= stableId then instance:SetAttribute(Constants.IDENTITY_ATTRIBUTE, stableId) end
	self.byId[stableId] = instance
	return true
end

-- This conversion is intentionally not used by the index path. Callers must
-- be inside a separately approved transaction operation that names the exact
-- ephemeral identity and resulting Forge stable ID.
function IdentityRegistry:enrollOpaque(identity: any, assignedStableId: string): boolean
	local instance = self:findOpaque(identity)
	if not instance then error("opaque identity is stale, missing, or outside this connector epoch") end
	return self:enrollInstance(instance, assignedStableId)
end

function IdentityRegistry:start(cooperate: (() -> ())?): () -> ()
	-- Subscribe before the cooperative initial scan so an object added while a
	-- slice yields cannot fall into a scan/listener race.
	table.insert(self.connections, game.DescendantAdded:Connect(function(instance) self:indexInstance(instance) end))
	local indexed, failure = pcall(function() self:indexProject(cooperate) end)
	if not indexed then self:destroy(); error(failure) end
	return function() self:destroy() end
end

function IdentityRegistry:find(stableId: string): Instance?
	local accepted = pcall(function() Generated.studioObjectIdentity({ kind = "forge_attribute", stableId = stableId }) end)
	if not accepted then return nil end
	local instance = self.byId[stableId]
	if instance and inKnownRoot(instance) and instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE) == stableId then return instance end
	self.byId[stableId] = nil
	-- A missing or manually changed identity invalidates the exact handle. Do
	-- not hide that drift behind a blocking whole-place fallback scan.
	return nil
end

function IdentityRegistry:destroy()
	for _, connection in ipairs(self.connections) do connection:Disconnect() end
	table.clear(self.connections); table.clear(self.byId); table.clear(self.byOpaqueHash)
end

return IdentityRegistry
