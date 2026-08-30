--!strict
local ScriptEditorService = game:GetService("ScriptEditorService")
local Hash = require(script.Parent.Hash)

local PatchExecutor = {}
PatchExecutor.__index = PatchExecutor

function PatchExecutor.new(registry, transactions)
	return setmetatable({ registry = registry, transactions = transactions }, PatchExecutor)
end

local function updateSource(instance: LuaSourceContainer, source: string): (boolean, string?)
	local updated, failure = pcall(function() ScriptEditorService:UpdateSourceAsync(instance, function() return source end) end)
	if updated then return true end
	local assigned, assignmentFailure = pcall(function() instance.Source = source end)
	return assigned, tostring(assignmentFailure or failure)
end

function PatchExecutor:apply(plan)
	if plan.kind ~= "StudioPatchPlan" or plan.schemaVersion ~= 1 then error("unsupported StudioPatchPlan") end
	local results = {}
	for _, targetPlan in ipairs(plan.targets) do
		local operation = plan.patchSet.operations[targetPlan.opIndex + 1]
		local target = targetPlan.target
		local result = { opId = plan.patchSet.id .. "_" .. tostring(targetPlan.opIndex), type = operation.type, status = "rejected", target = target or { path = operation.path or "", className = "Unknown" } }
		local ok, failure = pcall(function()
			if operation.type ~= "replace_text" and operation.type ~= "create_script" then error("Forge only permits typed replace_text/create_script operations") end
			if operation.type == "replace_text" then
				if not target then error("replace_text requires a stable target") end
				local instance = self.registry:find(target.stableId)
				if not instance or not instance:IsA("LuaSourceContainer") then error("stable script target missing") end
				if instance.ClassName ~= target.className then error("stable target class mismatch") end
				local before = instance.Source
				if target.sourceHash and Hash.sha256(before) ~= target.sourceHash then error("stable target source hash mismatch") end
				if before ~= operation.before then error("source precondition mismatch") end
				local changed, updateError = updateSource(instance, operation.after)
				if not changed then error(updateError) end
				self.transactions:recordInverse(function()
					local reverted, revertError = updateSource(instance, before)
					if not reverted then error(revertError) end
				end)
				result.expectedBefore, result.observedBefore, result.observedAfter = operation.beforeHash, Hash.sha256(before), Hash.sha256(operation.after)
				result.beforeHash, result.afterHash = Hash.sha256(before), Hash.sha256(operation.after)
			else
				if not target then error("create_script requires a stable parent target") end
				local parent = self.registry:find(target.stableId)
				if not parent or parent.ClassName ~= target.className then error("stable parent target missing") end
				local className = operation.executionContext == "server" and "Script" or operation.executionContext == "client" and "LocalScript" or "ModuleScript"
				local created = Instance.new(className)
				created.Name = string.match(operation.path, "([^/]+)$") or "ForgeScript"
				(created :: LuaSourceContainer).Source = operation.source
				created.Parent = parent
				self.registry:enrollInstance(created)
				self.transactions:recordInverse(function() if created.Parent then created:Destroy() end end)
				result.observedAfter = Hash.sha256(operation.source)
			end
			result.status = "applied"
		end)
		if not ok then result.error = string.sub(tostring(failure), 1, 4000) end
		table.insert(results, result)
		if result.status ~= "applied" then return results, result.error end
	end
	return results, nil
end

return PatchExecutor
