--!strict
local Constants = require(script.Parent.Constants)
local StudioInstancePolicy = require(script.Parent.StudioInstancePolicy)

local IdentityRegistry = {}
IdentityRegistry.__index = IdentityRegistry

function IdentityRegistry.new()
	return setmetatable({ byId = {} :: {[string]: Instance}, connections = {} :: {RBXScriptConnection} }, IdentityRegistry)
end

-- Indexing is deliberately read-only.  The evidence protocol must not create
-- a ChangeHistory recording or mutate a place merely because the connector
-- paired or restarted.  Forge identities are written only for an approved
-- create operation, inside that operation's recording.
function IdentityRegistry:indexInstance(instance: Instance): boolean
	if not StudioInstancePolicy.shouldHaveStableIdentity(instance) then return false end
	local stableId = instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE)
	if typeof(stableId) ~= "string" or stableId == "" then return false end
	local existing = self.byId[stableId]
	if existing and existing ~= instance then error("duplicate Forge stable identity") end
	self.byId[stableId] = instance
	return true
end

function IdentityRegistry:enrollInstance(instance: Instance, assignedStableId: string?): boolean
	if not StudioInstancePolicy.shouldHaveStableIdentity(instance) then return false end
	local current = instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE)
	-- The mutation projection fixes create identities as
	-- `${changeSet.id}:${operation.tempId}`.  Never manufacture an identity
	-- while indexing an existing project; that would be an unapproved write.
	local stableId = assignedStableId
	if typeof(stableId) ~= "string" or stableId == "" then error("approved create requires a deterministic stable identity") end
	if self.byId[stableId] and self.byId[stableId] ~= instance then error("generated stable identity collides") end
	if current ~= stableId then
		instance:SetAttribute(Constants.IDENTITY_ATTRIBUTE, stableId)
	end
	self.byId[stableId] = instance
	return true
end

function IdentityRegistry:indexProject(): number
	local count = 0
	for _, rootName in ipairs(StudioInstancePolicy.rootNames()) do
		local root = game:FindFirstChild(rootName)
		if root then
			local instances = root:GetDescendants()
			table.insert(instances, 1, root)
			for _, instance in ipairs(instances) do
				if self:indexInstance(instance) then count += 1 end
			end
		end
	end
	return count
end

function IdentityRegistry:start(): () -> ()
	self:indexProject()
	table.insert(self.connections, game.DescendantAdded:Connect(function(instance)
		self:indexInstance(instance)
	end))
	return function() self:destroy() end
end

function IdentityRegistry:find(stableId: string): Instance?
	local instance = self.byId[stableId]
	if instance and StudioInstancePolicy.shouldHaveStableIdentity(instance) and instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE) == stableId then return instance end
	self.byId[stableId] = nil
	for _, rootName in ipairs(StudioInstancePolicy.rootNames()) do
		local root = game:FindFirstChild(rootName)
		if root then
			for _, candidate in ipairs(root:GetDescendants()) do
				if StudioInstancePolicy.shouldHaveStableIdentity(candidate) and candidate:GetAttribute(Constants.IDENTITY_ATTRIBUTE) == stableId then
					self:indexInstance(candidate)
					return self.byId[stableId]
				end
			end
		end
	end
	return nil
end

function IdentityRegistry:destroy()
	for _, connection in ipairs(self.connections) do connection:Disconnect() end
	table.clear(self.connections)
	table.clear(self.byId)
end

return IdentityRegistry
