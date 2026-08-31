--!strict
-- Fixed Studio capability executor. The execution plan crosses
-- into the runner only as one canonical JSON string; assertions remain backend
-- data and are never injected into Studio source.
local HttpService = game:GetService("HttpService")
local StudioTestService = game:GetService("StudioTestService")
local Workspace = game:GetService("Workspace")
local Constants = require(script.Parent.Constants)
local Hash = require(script.Parent.Hash)
local Encoding = require(script.Parent.RuntimeCapabilityEncoding)

local RuntimeCapabilityExecutor = {}
RuntimeCapabilityExecutor.__index = RuntimeCapabilityExecutor

local SERVER_NAME = "__ForgeRuntimeCapabilityServer__"

local function iso(): string return os.date("!%Y-%m-%dT%H:%M:%SZ") end

local function destroyRunner()
	local existing = Workspace:FindFirstChild(SERVER_NAME)
	if existing then existing:Destroy() end
end

local function executeWithDeadline(callback, seconds: number)
	local done, ok, value = false, false, nil
	task.spawn(function()
		ok, value = pcall(callback)
		done = true
	end)
	local deadline = os.clock() + seconds
	while not done and os.clock() < deadline do task.wait(0.1) end
	if not done then return false, "Play session did not return before the bounded runtime-capability deadline", true end
	return ok, value, false
end

local function tableKeys(value: any): string
	if typeof(value) ~= "table" then return typeof(value) end
	local keys = {}
	for key in pairs(value) do table.insert(keys, tostring(key)) end
	table.sort(keys)
	return table.concat(keys, ",")
end

local function fixedRunnerSource(planJson: string, nonce: string): string
	local planLiteral = Encoding.singleStringLiteral(planJson)
	local nonceLiteral = Encoding.singleStringLiteral(nonce)
	-- Only planLiteral and nonceLiteral are dynamic and both are one quoted
	-- string. All resolution/observation behavior below is fixed Forge source.
	return [[
local HttpService = game:GetService("HttpService")
local StudioTestService = game:GetService("StudioTestService")
local Workspace = game:GetService("Workspace")
local planJson = ]] .. planLiteral .. [[
local nonce = ]] .. nonceLiteral .. [[
local function finite(value) return typeof(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge end
local function vector(value) return { x = value.X, y = value.Y, z = value.Z } end
local function workspaceTarget(path)
	if typeof(path) ~= "string" then return nil end
	local pieces = string.split(path, "/")
	if #pieces < 2 or pieces[1] ~= "Workspace" then return nil end
	local current = Workspace
	for index = 2, #pieces do
		local part = pieces[index]
		if part == "" or part == "." or part == ".." then return nil end
		current = current:FindFirstChild(part)
		if not current then return nil end
	end
	return current
end
local function fail(detail)
	StudioTestService:EndTest(HttpService:JSONEncode({ kind = "RuntimeCapabilityRunnerFailure", detail = tostring(detail) }))
end
local ok, plan = pcall(function() return HttpService:JSONDecode(planJson) end)
if not ok or typeof(plan) ~= "table" or plan.kind ~= "StudioExecutionPlan" then fail("invalid fixed-data execution plan") return end
if typeof(plan.budget) ~= "table" or typeof(plan.budget.maxExecutionMs) ~= "number" or plan.budget.maxExecutionMs < 1 or plan.budget.maxExecutionMs > 20000 or typeof(plan.budget.maxResultBytes) ~= "number" or plan.budget.maxResultBytes < 1 or plan.budget.maxResultBytes > 65536 then fail("invalid runtime execution budget") return end
local started = os.clock()
local results = {}
local resolved = {}
local targets = {}
local seenCallIds = {}
if typeof(plan.targets) ~= "table" or #plan.targets < 1 or #plan.targets > 8 or typeof(plan.calls) ~= "table" or #plan.calls < 1 or #plan.calls > 16 then fail("invalid plan collections") return end
for _, target in ipairs(plan.targets) do
	if typeof(target) ~= "table" or typeof(target.id) ~= "string" or targets[target.id] ~= nil or typeof(target.path) ~= "string" or target.expectedClass ~= "BasePart" then fail("invalid plan target") return end
	targets[target.id] = target
end
for _, call in ipairs(plan.calls) do
	if typeof(call) ~= "table" or typeof(call.id) ~= "string" or seenCallIds[call.id] or typeof(call.targetId) ~= "string" or call.version ~= 1 then fail("invalid plan call") return end
	seenCallIds[call.id] = true
	local target = targets[call.targetId]
	if not target then fail("unknown target") return end
	if call.capability == "instance.resolve" then
		local instance = workspaceTarget(target.path)
		if not instance then
			table.insert(results, { id = call.id, capability = "instance.resolve", targetId = call.targetId, status = "missing" })
		elseif not instance:IsA("BasePart") then
			table.insert(results, { id = call.id, capability = "instance.resolve", targetId = call.targetId, status = "class_mismatch", path = target.path, className = instance.ClassName })
		else
			resolved[call.targetId] = instance
			table.insert(results, { id = call.id, capability = "instance.resolve", targetId = call.targetId, status = "resolved", path = target.path, className = instance.ClassName })
		end
	elseif call.capability == "base_part.position" then
		local instance = resolved[call.targetId]
		if not instance then
			table.insert(results, { id = call.id, capability = "base_part.position", targetId = call.targetId, status = "unavailable" })
		else
			local position = instance.Position
			if not finite(position.X) or not finite(position.Y) or not finite(position.Z) then fail("non-finite BasePart position") return end
			table.insert(results, { id = call.id, capability = "base_part.position", targetId = call.targetId, status = "ok", position = vector(position), elapsedMs = math.floor((os.clock() - started) * 1000) })
		end
	elseif call.capability == "base_part.position_series" then
		local instance = resolved[call.targetId]
		if not instance then
			table.insert(results, { id = call.id, capability = "base_part.position_series", targetId = call.targetId, status = "unavailable" })
		else
			if typeof(call.sampleCount) ~= "number" or typeof(call.intervalMs) ~= "number" or call.sampleCount < 1 or call.sampleCount > 32 or call.intervalMs < 100 or call.intervalMs > 1000 then fail("series capability bounds rejected") return end
			local samples = {}
			for sequence = 1, call.sampleCount do
				local position = instance.Position
				if not finite(position.X) or not finite(position.Y) or not finite(position.Z) then fail("non-finite BasePart position") return end
				table.insert(samples, { sequence = sequence, elapsedMs = math.floor((os.clock() - started) * 1000), position = vector(position) })
				if sequence < call.sampleCount then task.wait(call.intervalMs / 1000) end
			end
			table.insert(results, { id = call.id, capability = "base_part.position_series", targetId = call.targetId, status = "ok", samples = samples })
		end
	else
		fail("capability is not allowlisted") return
	end
	if (os.clock() - started) * 1000 > plan.budget.maxExecutionMs then fail("execution deadline exceeded") return end
end
local ended = os.clock()
local envelope = {
	kind = "RuntimeObservationEnvelope", schemaVersion = 1,
	executionPlanId = plan.id, executionPlanHash = plan.hash, binding = plan.binding,
	nonce = nonce, nonceCommitment = nil, authoritative = true,
	startedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"), endedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"),
	durationMs = math.floor((ended - started) * 1000), results = results,
}
local encoded = HttpService:JSONEncode(envelope)
if #encoded > plan.budget.maxResultBytes then fail("runtime result exceeded execution-plan bound") return end
StudioTestService:EndTest(encoded)
]]
end

function RuntimeCapabilityExecutor.new(send, state)
	return setmetatable({ send = send, state = state, active = nil, blocked = false }, RuntimeCapabilityExecutor)
end

function RuntimeCapabilityExecutor:isActive(): boolean return self.active ~= nil end

function RuntimeCapabilityExecutor:abort()
	if not self.active then return end
	local wasRunning = self.active.phase == "running"
	self.active.closed = true
	destroyRunner()
	self.active = nil
	if wasRunning then
		self.blocked = true
		self.state("PLUGIN RELOAD REQUIRED", "The active generic runtime execution was interrupted. Press Stop, then reload Forge.")
	end
end

function RuntimeCapabilityExecutor:arm(payload: any, requestId: string?, expected: any)
	if self.active then error("a generic runtime execution is already armed or running") end
	if self.blocked then error("generic runtime execution is blocked after interruption; reload Forge") end
	if typeof(StudioTestService.ExecutePlayModeAsync) ~= "function" then error("this Roblox Studio version does not provide ExecutePlayModeAsync") end
	if typeof(payload.executionPlanJson) ~= "string" or typeof(payload.executionPlanJsonHash) ~= "string" then error("runtime execution plan must be canonical JSON and transport hash") end
	if Hash.sha256(payload.executionPlanJson) ~= payload.executionPlanJsonHash then error("runtime execution plan transport hash mismatch") end
	local decodedOk, plan = pcall(function() return HttpService:JSONDecode(payload.executionPlanJson) end)
	if not decodedOk or typeof(plan) ~= "table" then error("invalid runtime execution JSON") end
	if plan.kind ~= "StudioExecutionPlan" or plan.schemaVersion ~= 1 or typeof(plan.hash) ~= "string" or plan.id == nil or plan.capabilitySetId ~= Constants.RUNTIME_CAPABILITY_SET_ID or plan.capabilitySetHash ~= Constants.RUNTIME_CAPABILITY_SET_HASH or plan.purpose ~= "runtime_evaluation" and plan.purpose ~= "capability_canary" then error("runtime execution plan schema rejected") end
	if typeof(plan.binding) ~= "table" or typeof(plan.binding.sessionId) ~= "string" or typeof(plan.binding.projectId) ~= "string" or typeof(plan.binding.projectSnapshotHash) ~= "string" then error("runtime execution binding rejected") end
	if plan.binding.projectSnapshotHash ~= payload.expectedRevision then error("runtime execution snapshot precondition mismatch") end
	if typeof(expected) ~= "table" or plan.binding.sessionId ~= expected.sessionId or plan.binding.projectId ~= expected.projectId or plan.binding.projectSnapshotHash ~= expected.revision or typeof(plan.binding.project) ~= "table" or plan.binding.project.name ~= expected.project.name or plan.binding.project.placeId ~= expected.project.placeId or plan.binding.project.universeId ~= expected.project.universeId then error("runtime execution session/project/snapshot binding mismatch") end
	if typeof(plan.targets) ~= "table" or typeof(plan.calls) ~= "table" or #plan.targets < 1 or #plan.targets > 8 or #plan.calls < 1 or #plan.calls > 16 or typeof(plan.budget) ~= "table" or typeof(plan.budget.maxExecutionMs) ~= "number" or typeof(plan.budget.maxResultBytes) ~= "number" or plan.budget.maxExecutionMs > 20000 or plan.budget.maxResultBytes > 65536 then error("runtime execution capability bounds rejected") end
	local targets = {}
	for _, target in ipairs(plan.targets) do
		if typeof(target) ~= "table" or typeof(target.id) ~= "string" or targets[target.id] or typeof(target.path) ~= "string" or string.sub(target.path, 1, 10) ~= "Workspace/" or string.find(target.path, "%.%.") or target.expectedClass ~= "BasePart" then error("runtime target rejected") end
		targets[target.id] = true
	end
	local resolved, callIds = {}, {}
	for _, call in ipairs(plan.calls) do
		if typeof(call) ~= "table" or typeof(call.id) ~= "string" or callIds[call.id] or typeof(call.targetId) ~= "string" or not targets[call.targetId] or call.version ~= 1 then error("runtime call rejected") end
		callIds[call.id] = true
		if call.capability == "instance.resolve" then
			resolved[call.targetId] = true
		elseif call.capability == "base_part.position" then
			if not resolved[call.targetId] then error("runtime position observation requires prior resolution") end
		elseif call.capability == "base_part.position_series" then
			if not resolved[call.targetId] or typeof(call.sampleCount) ~= "number" or call.sampleCount < 1 or call.sampleCount > 32 or typeof(call.intervalMs) ~= "number" or call.intervalMs < 100 or call.intervalMs > 1000 then error("runtime position series rejected") end
		else
			error("runtime capability is not allowlisted")
		end
	end
	local nonce = HttpService:GenerateGUID(false) .. HttpService:GenerateGUID(false)
	local commitment = Hash.sha256(nonce)
	self.active = { payload = payload, requestId = requestId, plan = plan, nonce = nonce, commitment = commitment, phase = "armed", closed = false }
	self.send("RuntimeEvalPlanAccepted", { executionPlanId = plan.id, executionPlanHash = plan.hash, binding = plan.binding, nonceCommitment = commitment, callCount = #plan.calls, instruction = "Runtime capability execution is armed. Click Evaluate in Studio." }, requestId)
	self.state("READY TO EVALUATE", "Click Evaluate in Studio. Forge will run fixed, bounded capability observations in one Play Solo session.")
end

function RuntimeCapabilityExecutor:start()
	local run = self.active
	if not run then error("no generic runtime execution is armed") end
	if run.phase ~= "armed" then error("generic runtime execution is already running") end
	local prepared, prepareError = pcall(function()
		local probe = Instance.new("Script")
		probe.Name = "__ForgeRuntimePermissionProbe__"
		local allowed, permissionError = pcall(function()
			probe.Source = "-- Forge fixed runtime capability runner injection probe"
			probe.Parent = Workspace
		end)
		probe:Destroy()
		if not allowed then error("Studio script-injection permission was not granted: " .. tostring(permissionError)) end
		destroyRunner()
		local server = Instance.new("Script")
		server.Name = SERVER_NAME
		server.Source = fixedRunnerSource(run.payload.executionPlanJson, run.nonce)
		server.Parent = Workspace
		run.server = server
	end)
	if not prepared then destroyRunner(); self.active = nil; error(tostring(prepareError)) end
	run.phase = "running"
	self.send("RuntimeEvalStarted", { executionPlanId = run.plan.id, executionPlanHash = run.plan.hash, binding = run.plan.binding, nonceCommitment = run.commitment, mode = "play_solo", playerCount = 1, control = "plugin_action" }, run.requestId)
	self.state("RUNTIME RUNNING", "Play Solo is running the bounded generic capability plan.")
	task.spawn(function()
		local ok, returned, timedOut = executeWithDeadline(function()
			return StudioTestService:ExecutePlayModeAsync({ forgeRuntimeCapabilityRunId = run.plan.binding.runId })
		end, Constants.EXECUTION_DEADLINE_SECONDS + 15)
		if run.closed then return end
		destroyRunner()
		if not ok or typeof(returned) ~= "string" then
			self.send("PluginError", { code = "STUDIO_FAILURE", message = string.sub((not ok and tostring(returned) or "ExecutePlayModeAsync returned " .. typeof(returned) .. " (keys=" .. tableKeys(returned) .. ") instead of direct runtime evidence"), 1, Constants.MAX_DIAGNOSTIC_CHARS), retryable = timedOut }, run.requestId)
			self.active = nil
			if timedOut then self.blocked = true; self.state("PLUGIN RELOAD REQUIRED", "Runtime execution timed out. Press Stop, then reload Forge.") else self.state("RUNTIME INCOMPLETE", "Play Solo stopped before authoritative runtime observations returned.") end
			return
		end
		local decodedOk, envelope = pcall(function() return HttpService:JSONDecode(returned) end)
		if not decodedOk or typeof(envelope) ~= "table" or envelope.kind ~= "RuntimeObservationEnvelope" or envelope.executionPlanId ~= run.plan.id or envelope.executionPlanHash ~= run.plan.hash or envelope.nonce ~= run.nonce or envelope.binding ~= nil and (envelope.binding.runId ~= run.plan.binding.runId or envelope.binding.correlationId ~= run.plan.binding.correlationId or envelope.binding.sessionId ~= run.plan.binding.sessionId or envelope.binding.projectId ~= run.plan.binding.projectId or envelope.binding.projectSnapshotHash ~= run.plan.binding.projectSnapshotHash) then
			self.send("PluginError", { code = "SECURITY_REJECTION", message = "Studio returned invalid or uncorrelated generic runtime evidence", retryable = false }, run.requestId)
			self.active = nil
			self.state("RUNTIME REJECTED", "Studio returned invalid generic runtime evidence.")
			return
		end
		envelope.nonceCommitment = run.commitment
		envelope.authoritative = true
		local encoded = HttpService:JSONEncode(envelope)
		if #encoded > run.plan.budget.maxResultBytes then
			self.send("PluginError", { code = "SECURITY_REJECTION", message = "Runtime observations exceeded the configured result bound", retryable = false }, run.requestId)
			self.active = nil
			self.state("RUNTIME REJECTED", "Runtime observations exceeded their bounded result limit.")
			return
		end
		self.send("RuntimeEvalResult", envelope, run.requestId)
		self.send("RuntimeEvalStopped", { executionPlanId = run.plan.id, executionPlanHash = run.plan.hash, binding = run.plan.binding, nonceCommitment = run.commitment, mode = "play_solo", playerCount = 1, control = "plugin_action" }, run.requestId)
		self.active = nil
		self.state("RUNTIME COMPLETE", "Bounded factual observations returned to Forge for backend-only grading.")
	end)
end

return RuntimeCapabilityExecutor
