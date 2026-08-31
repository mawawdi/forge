--!strict
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local HttpService = game:GetService("HttpService")
local Constants = require(script.Parent.Constants)
local StudioInstancePolicy = require(script.Parent.StudioInstancePolicy)

local IdentityRegistry = {}
IdentityRegistry.__index = IdentityRegistry

function IdentityRegistry.new()
	return setmetatable({ byId = {} :: {[string]: Instance}, connections = {} :: {RBXScriptConnection} }, IdentityRegistry)
end

function IdentityRegistry:enrollInstance(instance: Instance): boolean
	if not StudioInstancePolicy.shouldHaveStableIdentity(instance) then return false end
	local current = instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE)
	local stableId = typeof(current) == "string" and current or ""
	if stableId == "" or (self.byId[stableId] and self.byId[stableId] ~= instance) then
		stableId = "forge_" .. string.gsub(HttpService:GenerateGUID(false), "-", "")
		instance:SetAttribute(Constants.IDENTITY_ATTRIBUTE, stableId)
	end
	self.byId[stableId] = instance
	return true
end

function IdentityRegistry:enrollProject(): number
	local recording = ChangeHistoryService:TryBeginRecording("Forge identity enrollment")
	local count = 0
	for _, rootName in ipairs(StudioInstancePolicy.rootNames()) do
		local root = game:FindFirstChild(rootName)
		if root then
			for _, instance in ipairs(root:GetDescendants()) do
				if self:enrollInstance(instance) then count += 1 end
			end
		end
	end
	if recording then ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end
	return count
end

function IdentityRegistry:start(): () -> ()
	self:enrollProject()
	table.insert(self.connections, game.DescendantAdded:Connect(function(instance)
		self:enrollInstance(instance)
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
					self:enrollInstance(candidate)
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
