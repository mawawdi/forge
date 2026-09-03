--!strict
-- Executes a sealed StudioExecutionPlan directly inside the Play Server plugin.
-- No place object, source injection, output parsing, or arbitrary callback crosses
-- the authority boundary: the generated manifest selects one fixed result handler.
local DirectRuntimeObserver = {}
DirectRuntimeObserver.__index = DirectRuntimeObserver

local function finite(value: any): boolean
	return typeof(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

local function vector(value: Vector3): any
	return { x = value.X, y = value.Y, z = value.Z }
end

-- Play-mode clones cannot retain an edit-mode opaque engine handle. Only a
-- Forge attribute enrolled in the approved transaction is a stable Play
-- lookup. Other closed identities are still legal plan bindings, but produce
-- unavailable evidence rather than an invented "missing" fact.
local function resolveTarget(target: any): (Instance?, "missing" | "unavailable"?)
	if typeof(target) ~= "table" or typeof(target.path) ~= "string" or typeof(target.identity) ~= "table" then return nil, "unavailable" end
	if target.identity.kind ~= "forge_attribute" or typeof(target.identity.stableId) ~= "string" then return nil, "unavailable" end
	local match: Instance? = nil
	for _, candidate in ipairs(game:GetDescendants()) do
		if candidate:GetAttribute("_forgeStableId") == target.identity.stableId then
			if match ~= nil then error("duplicate Forge runtime identity") end
			match = candidate
		end
	end
	return match, if match == nil then "missing" else nil
end

local function connectHeartbeat(callback: () -> ()): any
	return game:GetService("RunService").Heartbeat:Connect(callback)
end

local function elapsedMs(self: any): number
	return math.max(0, math.floor((self.clock() - self.startedClock) * 1000))
end

function DirectRuntimeObserver.new(plan: any, dependencies: any?): any
	local injected = dependencies or {}
	if typeof(injected.generated) ~= "table" then error("direct runtime observer requires generated manifest dispatch") end
	return setmetatable({
		plan = plan,
		generated = injected.generated,
		clock = injected.clock or os.clock,
		resolveTarget = injected.resolveTarget or resolveTarget,
		connectHeartbeat = injected.connectHeartbeat or connectHeartbeat,
		startedClock = 0,
		results = {},
		resolved = {},
		series = {},
		connection = nil,
		failure = nil,
		started = false,
		sealed = false,
	}, DirectRuntimeObserver)
end

function DirectRuntimeObserver:_record(result: any)
	if self.results[result.id] ~= nil then error("duplicate runtime result") end
	self.results[result.id] = result
end

function DirectRuntimeObserver:_sample(entry: any)
	local call, instance, result = entry.call, entry.instance, entry.result
	if result.status ~= "ok" or #result.samples >= call.sampleCount then return end
	local captured = elapsedMs(self)
	if call.capability == "base_part.position_series" then
		local position = (instance :: BasePart).Position
		if not finite(position.X) or not finite(position.Y) or not finite(position.Z) then error("non-finite BasePart position") end
		table.insert(result.samples, { sequence = #result.samples + 1, elapsedMs = captured, position = vector(position) })
	else
		local metadata = self.generated.propertyMetadata(entry.target.expectedClass, call.propertyName)
		if metadata == nil or metadata.codec == "instance_ref" then error("runtime manifest property series is outside the fixed observation domain") end
		local value = self.generated.read(instance, call.propertyName)
		table.insert(result.samples, { sequence = #result.samples + 1, elapsedMs = captured, value = value })
	end
	entry.nextAtMs = captured + call.intervalMs
end

function DirectRuntimeObserver:_execute(call: any, targets: any)
	local target = targets[call.targetId]
	self.generated.runtimeDispatch(call.capability, {
		instance_identity = function()
			local instance, resolution = self.resolveTarget(target)
			if resolution == "unavailable" then
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, status = "unavailable" })
			elseif not instance then
				self.resolved[call.targetId] = false
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, status = "missing" })
			elseif not instance:IsA(target.expectedClass) then
				-- The projected target includes both path and expected class. An
				-- instance of another class proves that projected target absent.
				self.resolved[call.targetId] = false
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, status = "missing" })
			else
				self.resolved[call.targetId] = instance
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, status = "resolved", path = target.path, className = instance.ClassName })
			end
		end,
		vector3_f32 = function()
			local instance = self.resolved[call.targetId]
			if instance == false then
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, status = "missing" })
				return
			end
			if not instance or not instance:IsA("BasePart") then
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, status = "unavailable" })
				return
			end
			local position = (instance :: BasePart).Position
			if not finite(position.X) or not finite(position.Y) or not finite(position.Z) then error("non-finite BasePart position") end
			self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, status = "ok", position = vector(position), elapsedMs = elapsedMs(self) })
		end,
		position_series_f32 = function(metadata: any)
			if typeof(call.sampleCount) ~= "number" or call.sampleCount % 1 ~= 0 or call.sampleCount < 1 or call.sampleCount > metadata.maximumSamples or typeof(call.intervalMs) ~= "number" or call.intervalMs % 1 ~= 0 or call.intervalMs < metadata.minimumIntervalMs or call.intervalMs > metadata.maximumIntervalMs then error("runtime position series bounds rejected") end
			local instance = self.resolved[call.targetId]
			if instance == false then
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, status = "missing" })
				return
			end
			if not instance or not instance:IsA("BasePart") then
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, status = "unavailable" })
				return
			end
			local result = { id = call.id, capability = call.capability, targetId = call.targetId, status = "ok", samples = {} }
			self:_record(result)
			local entry = { call = call, target = target, instance = instance, result = result, nextAtMs = 0 }
			table.insert(self.series, entry)
			self:_sample(entry)
		end,
		manifest_property = function()
			local instance = self.resolved[call.targetId]
			if instance == false then
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, propertyName = call.propertyName, status = "missing" })
				return
			end
			local metadata = self.generated.propertyMetadata(target.expectedClass, call.propertyName)
			if not instance or metadata == nil or metadata.codec == "instance_ref" then
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, propertyName = call.propertyName, status = "unavailable" })
				return
			end
			local value = self.generated.read(instance, call.propertyName)
			self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, propertyName = call.propertyName, status = "ok", value = value, elapsedMs = elapsedMs(self) })
		end,
		manifest_property_series = function(capabilityMetadata: any)
			if typeof(call.sampleCount) ~= "number" or call.sampleCount % 1 ~= 0 or call.sampleCount < 1 or call.sampleCount > capabilityMetadata.maximumSamples or typeof(call.intervalMs) ~= "number" or call.intervalMs % 1 ~= 0 or call.intervalMs < capabilityMetadata.minimumIntervalMs or call.intervalMs > capabilityMetadata.maximumIntervalMs then error("runtime property series bounds rejected") end
			local instance = self.resolved[call.targetId]
			if instance == false then
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, propertyName = call.propertyName, status = "missing" })
				return
			end
			local propertyMetadata = self.generated.propertyMetadata(target.expectedClass, call.propertyName)
			if not instance or propertyMetadata == nil or propertyMetadata.codec == "instance_ref" then
				self:_record({ id = call.id, capability = call.capability, targetId = call.targetId, propertyName = call.propertyName, status = "unavailable" })
				return
			end
			local result = { id = call.id, capability = call.capability, targetId = call.targetId, propertyName = call.propertyName, status = "ok", samples = {} }
			self:_record(result)
			local entry = { call = call, target = target, instance = instance, result = result, nextAtMs = 0 }
			table.insert(self.series, entry)
			self:_sample(entry)
		end,
	}, { call = call, target = target })
end

function DirectRuntimeObserver:start(): boolean
	if self.started or self.sealed then error("direct runtime observer cannot start twice") end
	self.started = true
	self.startedClock = self.clock()
	local targets = {}
	for _, target in ipairs(self.plan.targets) do targets[target.id] = target end
	local ok, failure = pcall(function()
		for _, call in ipairs(self.plan.calls) do self:_execute(call, targets) end
	end)
	if not ok then self.failure = tostring(failure) end
	self.connection = self.connectHeartbeat(function()
		if self.sealed or self.failure then return end
		local stepped, stepFailure = pcall(function() self:step() end)
		if not stepped then self.failure = tostring(stepFailure) end
	end)
	return self.failure == nil
end

function DirectRuntimeObserver:step()
	if not self.started or self.sealed then return end
	local elapsed = elapsedMs(self)
	for _, entry in ipairs(self.series) do
		if #entry.result.samples < entry.call.sampleCount and elapsed >= entry.nextAtMs then self:_sample(entry) end
	end
end

function DirectRuntimeObserver:isFinished(): boolean
	if self.failure then return true end
	if elapsedMs(self) < self.plan.observationWindowMs then return false end
	for _, entry in ipairs(self.series) do if #entry.result.samples < entry.call.sampleCount then return false end end
	return true
end

function DirectRuntimeObserver:seal(): (any, string?)
	if self.sealed then error("direct runtime observer cannot seal twice") end
	self.sealed = true
	if self.connection then self.connection:Disconnect(); self.connection = nil end
	local ordered = {}
	if not self.failure then
		for _, call in ipairs(self.plan.calls) do
			local result = self.results[call.id]
			if result ~= nil then table.insert(ordered, result) end
		end
	end
	return ordered, self.failure
end

return DirectRuntimeObserver
