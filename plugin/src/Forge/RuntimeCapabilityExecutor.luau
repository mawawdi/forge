--!strict
-- Fixed Studio capability executor. The execution plan crosses
-- into the runner only as one canonical JSON string; assertions remain backend
-- data and are never injected into Studio source.
local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local StudioTestService = game:GetService("StudioTestService")
local Workspace = game:GetService("Workspace")
local Constants = require(script.Parent.Constants)
local Generated = require(script.Parent.GeneratedStudioEvidence)
local Hash = require(script.Parent.Hash)
local Encoding = require(script.Parent.RuntimeCapabilityEncoding)

local RuntimeCapabilityExecutor = {}
RuntimeCapabilityExecutor.__index = RuntimeCapabilityExecutor

local SERVER_NAME = "__ForgeRuntimeCapabilityServer__"

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

local function contains(values: {any}, needle: any): boolean
	for _, value in ipairs(values) do if value == needle then return true end end
	return false
end

local function runtimeEnvelope(projection: any, raw: any): any
	Generated.validateProjection(projection)
	local byCall = {}
	for _, result in ipairs(raw.results) do byCall[result.id] = result end
	local facts = {}
	for _, requirement in ipairs(Generated.projectionRequirements(projection)) do
		local output: any = { kind = requirement.kind, key = requirement.key, target = requirement.target, callId = requirement.callId, runtimeTargetId = requirement.runtimeTargetId, capability = requirement.capability }
		if requirement.kind == "runtime_property" or requirement.kind == "runtime_property_series" then output.propertyName = requirement.propertyName end
		local result = byCall[requirement.callId]
		if not result then output.result = { status = "read_error", code = "missing_runtime_result" }
		elseif requirement.kind == "runtime_resolution" then
			output.result = result.status == "resolved" and { status = "observed", value = { path = result.path, className = result.className } } or result.status == "missing" and { status = "absent" } or { status = "unavailable", code = "runtime_resolution_unavailable" }
		elseif requirement.kind == "position" then
			output.result = result.status == "ok" and { status = "observed", value = Generated.canonicalValue({ kind = "vector3_f32", x = result.position.x, y = result.position.y, z = result.position.z }) } or { status = "unavailable", code = "runtime_position_unavailable" }
		elseif requirement.kind == "position_series" then
			if result.status ~= "ok" then output.result = { status = "unavailable", code = "runtime_series_unavailable" }
			else
				local samples = {}
				for _, sample in ipairs(result.samples) do table.insert(samples, { sequence = sample.sequence, elapsedMs = sample.elapsedMs, value = { x = sample.position.x, y = sample.position.y, z = sample.position.z } }) end
				output.result = { status = "observed", value = samples }
			end
		elseif requirement.kind == "runtime_property" then
			local metadata = requirement.target.kind == "instance" and Generated.propertyMetadata(requirement.target.className, requirement.propertyName) or nil
			if result.status ~= "ok" or result.propertyName ~= requirement.propertyName or metadata == nil then output.result = { status = "unavailable", code = "runtime_manifest_property_unavailable" }
			else
				local ok, value = pcall(function() return Generated.validateValue(metadata.codec, result.value, metadata) end)
				output.result = ok and { status = "observed", value = value } or { status = "read_error", code = "runtime_manifest_property_invalid" }
			end
		elseif requirement.kind == "runtime_property_series" then
			local metadata = requirement.target.kind == "instance" and Generated.propertyMetadata(requirement.target.className, requirement.propertyName) or nil
			if result.status ~= "ok" or result.propertyName ~= requirement.propertyName or metadata == nil then output.result = { status = "unavailable", code = "runtime_manifest_property_series_unavailable" }
			else
				local samples, valid = {}, true
				for _, sample in ipairs(result.samples) do
					local ok, value = pcall(function() return Generated.validateValue(metadata.codec, sample.value, metadata) end)
					if not ok then valid = false; break end
					table.insert(samples, { sequence = sample.sequence, elapsedMs = sample.elapsedMs, value = value })
				end
				output.result = valid and { status = "observed", value = samples } or { status = "read_error", code = "runtime_manifest_property_series_invalid" }
			end
		else output.result = { status = "unavailable", code = "runtime_fact_kind_unsupported" } end
		table.insert(facts, output)
	end
	facts = Generated.sortFacts(facts)
	local complete = true
	for _, fact in ipairs(facts) do if fact.result.status ~= "observed" then complete = false; break end end
	local envelope: any = { kind = "StudioEvidenceEnvelope", manifestHash = Generated.manifestHash, projectionId = projection.id, projectionHash = projection.contentHash, bindingHash = projection.bindingHash, project = projection.project, authoritative = true, startedAt = raw.startedAt, endedAt = raw.endedAt, completion = complete and "complete" or "incomplete", facts = facts }
	envelope.contentHash = Generated.envelopeHash(envelope)
	return envelope
end

local function fixedRunnerSource(planJson: string, nonce: string): string
	local planLiteral = Encoding.singleStringLiteral(planJson)
	local nonceLiteral = Encoding.singleStringLiteral(nonce)
	local maximumExecutionMs = tostring(Generated.manifest.limits.maximumRuntimeMs)
	local maximumResultBytes = tostring(Generated.manifest.limits.maximumRuntimeResultBytes)
	local maximumTargets = tostring(Generated.manifest.limits.maximumRuntimeTargets)
	local maximumCalls = tostring(Generated.manifest.limits.maximumRuntimeCalls)
	-- The plan and nonce are encoded as single quoted strings. The only other
	-- substitutions are generated manifest integers bound into the connector
	-- identity; all resolution and observation behavior remains fixed source.
	return [[
local HttpService = game:GetService("HttpService")
local StudioTestService = game:GetService("StudioTestService")
local Workspace = game:GetService("Workspace")
local planJson = ]] .. planLiteral .. [[
local nonce = ]] .. nonceLiteral .. [[
local function finite(value) return typeof(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge end
local function vector(value) return { x = value.X, y = value.Y, z = value.Z } end
local function resolutionTarget(path)
	if typeof(path) ~= "string" then return nil end
	local pieces = string.split(path, "/")
	if #pieces < 2 then return nil end
	local current = game:FindFirstChild(pieces[1])
	if not current then return nil end
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
if typeof(plan.budget) ~= "table" or typeof(plan.budget.maxExecutionMs) ~= "number" or plan.budget.maxExecutionMs < 1 or plan.budget.maxExecutionMs > ]] .. maximumExecutionMs .. [[ or typeof(plan.budget.maxResultBytes) ~= "number" or plan.budget.maxResultBytes < 1 or plan.budget.maxResultBytes > ]] .. maximumResultBytes .. [[ then fail("invalid runtime execution budget") return end
if typeof(plan.observationWindowMs) ~= "number" or plan.observationWindowMs % 1 ~= 0 or plan.observationWindowMs < 0 or plan.observationWindowMs > plan.budget.maxExecutionMs then fail("invalid runtime observation window") return end
local started = os.clock()
local results = {}
local resolved = {}
local targets = {}
local seenCallIds = {}
if typeof(plan.targets) ~= "table" or #plan.targets < 1 or #plan.targets > ]] .. maximumTargets .. [[ or typeof(plan.calls) ~= "table" or #plan.calls < 1 or #plan.calls > ]] .. maximumCalls .. [[ then fail("invalid plan collections") return end
for _, target in ipairs(plan.targets) do
	if typeof(target) ~= "table" or typeof(target.id) ~= "string" or targets[target.id] ~= nil or typeof(target.path) ~= "string" then fail("invalid plan target") return end
	targets[target.id] = target
end
for _, call in ipairs(plan.calls) do
	if typeof(call) ~= "table" or typeof(call.id) ~= "string" or seenCallIds[call.id] or typeof(call.targetId) ~= "string" then fail("invalid plan call") return end
	seenCallIds[call.id] = true
	local target = targets[call.targetId]
	if not target then fail("unknown target") return end
]] .. Generated.runtimeRunnerDispatchSource .. [[
	if (os.clock() - started) * 1000 > plan.budget.maxExecutionMs then fail("execution deadline exceeded") return end
end
local remainingObservationMs = plan.observationWindowMs - ((os.clock() - started) * 1000)
if remainingObservationMs > 0 then task.wait(remainingObservationMs / 1000) end
if (os.clock() - started) * 1000 > plan.budget.maxExecutionMs then fail("observation window exceeded execution deadline") return end
local ended = os.clock()
local envelope = {
	kind = "ForgeRuntimeResults",
	executionPlanId = plan.id, executionPlanHash = plan.hash, binding = plan.binding,
	nonce = nonce, nonceCommitment = nil, authoritative = true,
	startedAt = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), endedAt = os.date("!%Y-%m-%dT%H:%M:%S.000Z"),
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
	if typeof(StudioTestService.ExecutePlayModeAsync) ~= "function" then error("this Roblox Studio build does not provide ExecutePlayModeAsync") end
	if typeof(payload.executionPlanJson) ~= "string" or typeof(payload.executionPlanJsonHash) ~= "string" then error("runtime execution plan must be canonical JSON and transport hash") end
	if Hash.sha256(payload.executionPlanJson) ~= payload.executionPlanJsonHash then error("runtime execution plan transport hash mismatch") end
	local decodedOk, plan = pcall(function() return HttpService:JSONDecode(payload.executionPlanJson) end)
	if not decodedOk or typeof(plan) ~= "table" then error("invalid runtime execution JSON") end
	if plan.kind ~= "StudioExecutionPlan" or typeof(plan.hash) ~= "string" or plan.id == nil or plan.purpose ~= "runtime_evaluation" and plan.purpose ~= "capability_canary" and plan.purpose ~= "creator_verification" then error("runtime execution plan rejected") end
	if payload.startPolicy ~= "explicit_plugin_action" and payload.startPolicy ~= "creator_action_already_authorized" or (plan.purpose == "creator_verification") ~= (payload.startPolicy == "creator_action_already_authorized") then error("runtime start policy rejected") end
	if plan.manifestHash ~= Generated.manifestHash or typeof(plan.binding) ~= "table" or typeof(plan.binding.sessionId) ~= "string" or typeof(plan.binding.projectId) ~= "string" or typeof(plan.binding.projectStateRevisionHash) ~= "string" then error("runtime execution binding rejected") end
	if plan.binding.projectStateRevisionHash ~= payload.expectedRevision then error("runtime execution state-revision precondition mismatch") end
	if typeof(expected) ~= "table" or plan.binding.sessionId ~= expected.sessionId or plan.binding.projectId ~= expected.projectId or plan.binding.projectStateRevisionHash ~= expected.revision or typeof(plan.binding.project) ~= "table" or plan.binding.project.name ~= expected.project.name or plan.binding.project.placeId ~= expected.project.placeId or plan.binding.project.universeId ~= expected.project.universeId then error("runtime execution session/project/state-revision binding mismatch") end
	if typeof(plan.targets) ~= "table" or typeof(plan.calls) ~= "table" or #plan.targets < 1 or #plan.targets > Generated.manifest.limits.maximumRuntimeTargets or #plan.calls < 1 or #plan.calls > Generated.manifest.limits.maximumRuntimeCalls or typeof(plan.budget) ~= "table" or typeof(plan.budget.maxExecutionMs) ~= "number" or typeof(plan.budget.maxResultBytes) ~= "number" or plan.budget.maxExecutionMs > Generated.manifest.limits.maximumRuntimeMs or plan.budget.maxResultBytes > Generated.manifest.limits.maximumRuntimeResultBytes or typeof(plan.observationWindowMs) ~= "number" or plan.observationWindowMs % 1 ~= 0 or plan.observationWindowMs < 0 or plan.observationWindowMs > plan.budget.maxExecutionMs then error("runtime execution capability bounds rejected") end
	local evidenceProjectionOk, evidenceProjection = pcall(function()
		if typeof(payload.evidenceProjectionJson) ~= "string" or typeof(payload.evidenceProjectionJsonHash) ~= "string" or Hash.sha256(payload.evidenceProjectionJson) ~= payload.evidenceProjectionJsonHash then error("runtime evidence projection transport hash mismatch") end
		local decoded = HttpService:JSONDecode(payload.evidenceProjectionJson)
		Generated.validateProjection(decoded)
		local expectedProjectionPurpose = plan.purpose == "creator_verification" and "creator_verification" or "runtime_evaluation"
		if typeof(payload.evidenceProjectionHash) ~= "string" or decoded.contentHash ~= payload.evidenceProjectionHash or decoded.purpose ~= expectedProjectionPurpose or typeof(plan.evidenceProjection) ~= "table" or plan.evidenceProjection.contentHash ~= decoded.contentHash or plan.evidenceProjection.purpose ~= expectedProjectionPurpose then error("runtime evidence projection rejected") end
		return decoded
	end)
	if not evidenceProjectionOk then error(tostring(evidenceProjection)) end
	local targets = {}
	for _, target in ipairs(plan.targets) do
		local pieces = typeof(target) == "table" and typeof(target.path) == "string" and string.split(target.path, "/") or nil
		if typeof(target) ~= "table" or typeof(target.id) ~= "string" or targets[target.id] or not pieces or #pieces < 2 or not Generated.isAllowedRoot(pieces[1]) or string.find(target.path, "%.%.") or not contains(Generated.resolvableClasses, target.expectedClass) then error("runtime target rejected") end
		for _, piece in ipairs(pieces) do if piece == "" or piece == "." or piece == ".." then error("runtime target rejected") end end
		targets[target.id] = target
	end
	local resolved, callIds = {}, {}
	local scheduledWaitMs = 0
	for _, call in ipairs(plan.calls) do
		if typeof(call) ~= "table" or typeof(call.id) ~= "string" or callIds[call.id] or typeof(call.targetId) ~= "string" or not targets[call.targetId] then error("runtime call rejected") end
		callIds[call.id] = true
		-- The generated manifest maps every capability to a closed result-domain
		-- handler.  No handwritten capability-name allowlist exists here.
		Generated.runtimeDispatch(call.capability, {
			instance_identity = function()
				resolved[call.targetId] = true
			end,
			vector3_f32 = function()
				if not resolved[call.targetId] or targets[call.targetId].expectedClass ~= "BasePart" or not string.match(targets[call.targetId].path, "^Workspace/") then error("runtime vector observation requires prior Workspace BasePart resolution") end
			end,
			position_series_f32 = function(metadata: any)
				if not resolved[call.targetId] or targets[call.targetId].expectedClass ~= "BasePart" or not string.match(targets[call.targetId].path, "^Workspace/") or typeof(call.sampleCount) ~= "number" or call.sampleCount < 1 or call.sampleCount > metadata.maximumSamples or typeof(call.intervalMs) ~= "number" or call.intervalMs < metadata.minimumIntervalMs or call.intervalMs > metadata.maximumIntervalMs then error("runtime position series rejected") end
				local seriesDurationMs = (call.sampleCount - 1) * call.intervalMs
				if plan.purpose == "creator_verification" and seriesDurationMs < plan.observationWindowMs then error("creator position series ends before the observation window") end
				scheduledWaitMs += seriesDurationMs
			end,
			manifest_property = function()
				if not resolved[call.targetId] or typeof(call.propertyName) ~= "string" then error("runtime manifest property requires prior resolution and a property name") end
				local property = Generated.propertyMetadata(targets[call.targetId].expectedClass, call.propertyName)
				if property == nil or property.codec == "instance_ref" then error("runtime manifest property is outside the fixed observation domain") end
			end,
			manifest_property_series = function(metadata: any)
				if not resolved[call.targetId] or typeof(call.propertyName) ~= "string" or typeof(call.sampleCount) ~= "number" or call.sampleCount < 1 or call.sampleCount > metadata.maximumSamples or typeof(call.intervalMs) ~= "number" or call.intervalMs < metadata.minimumIntervalMs or call.intervalMs > metadata.maximumIntervalMs then error("runtime manifest property series rejected") end
				local property = Generated.propertyMetadata(targets[call.targetId].expectedClass, call.propertyName)
				if property == nil or property.codec == "instance_ref" then error("runtime manifest property series is outside the fixed observation domain") end
				scheduledWaitMs += (call.sampleCount - 1) * call.intervalMs
			end,
		}, { call = call, target = targets[call.targetId] })
	end
	if math.max(scheduledWaitMs, plan.observationWindowMs) > plan.budget.maxExecutionMs then error("runtime execution schedule exceeds budget") end
	local nonce = HttpService:GenerateGUID(false) .. HttpService:GenerateGUID(false)
	local commitment = Hash.sha256(nonce)
	self.active = { payload = payload, requestId = requestId, plan = plan, projection = evidenceProjection, nonce = nonce, commitment = commitment, phase = "armed", closed = false, control = payload.startPolicy == "creator_action_already_authorized" and "creator_action" or "plugin_action" }
	local instruction = payload.startPolicy == "creator_action_already_authorized" and "Creator-authorized Play Solo will start immediately. Perform the approved interactions during the bounded observation window." or "Runtime capability execution is armed. Click Evaluate in Studio."
	self.send("RuntimeEvalPlanAccepted", { executionPlanId = plan.id, executionPlanHash = plan.hash, projectionId = evidenceProjection.id, projectionHash = evidenceProjection.contentHash, bindingHash = evidenceProjection.bindingHash, nonceCommitment = commitment, callCount = #plan.calls, instruction = instruction }, requestId)
	self.state(payload.startPolicy == "creator_action_already_authorized" and "STARTING CHECKS" or "READY TO EVALUATE", instruction)
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
	local diagnostics = { errors = 0, warnings = 0, messageHashes = {}, truncated = false }
	local diagnosticConnection = LogService.MessageOut:Connect(function(message, messageType)
		if messageType == Enum.MessageType.MessageError then diagnostics.errors += 1
		elseif messageType == Enum.MessageType.MessageWarning then diagnostics.warnings += 1
		else return end
		if #diagnostics.messageHashes < 128 then table.insert(diagnostics.messageHashes, Hash.sha256(string.sub(tostring(message), 1, Constants.MAX_DIAGNOSTIC_CHARS)))
		else diagnostics.truncated = true end
	end)
	self.send("RuntimeEvalStarted", { executionPlanId = run.plan.id, executionPlanHash = run.plan.hash, projectionId = run.projection.id, projectionHash = run.projection.contentHash, bindingHash = run.projection.bindingHash, nonceCommitment = run.commitment, mode = "play_solo", playerCount = 1, control = run.control }, run.requestId)
	self.state("RUNTIME RUNNING", "Play Solo is running the bounded capability plan and creator-observation window.")
	task.spawn(function()
		local ok, returned, timedOut = executeWithDeadline(function()
			return StudioTestService:ExecutePlayModeAsync({ forgeRuntimeCapabilityRunId = run.plan.binding.runId })
		end, run.plan.budget.maxExecutionMs / 1000 + 15)
		diagnosticConnection:Disconnect()
		if run.closed then return end
		destroyRunner()
		if not ok or typeof(returned) ~= "string" then
			self.send("PluginError", { code = "STUDIO_FAILURE", message = string.sub((not ok and tostring(returned) or "ExecutePlayModeAsync returned " .. typeof(returned) .. " (keys=" .. tableKeys(returned) .. ") instead of direct runtime evidence"), 1, Constants.MAX_DIAGNOSTIC_CHARS), retryable = timedOut }, run.requestId)
			self.active = nil
			if timedOut then self.blocked = true; self.state("PLUGIN RELOAD REQUIRED", "Runtime execution timed out. Press Stop, then reload Forge.") else self.state("RUNTIME INCOMPLETE", "Play Solo stopped before authoritative runtime observations returned.") end
			return
		end
		local decodedOk, envelope = pcall(function() return HttpService:JSONDecode(returned) end)
		if not decodedOk or typeof(envelope) ~= "table" or envelope.kind ~= "ForgeRuntimeResults" or envelope.executionPlanId ~= run.plan.id or envelope.executionPlanHash ~= run.plan.hash or envelope.nonce ~= run.nonce or envelope.binding ~= nil and (envelope.binding.runId ~= run.plan.binding.runId or envelope.binding.correlationId ~= run.plan.binding.correlationId or envelope.binding.sessionId ~= run.plan.binding.sessionId or envelope.binding.projectId ~= run.plan.binding.projectId or envelope.binding.projectStateRevisionHash ~= run.plan.binding.projectStateRevisionHash) then
			self.send("PluginError", { code = "SECURITY_REJECTION", message = "Studio returned invalid or uncorrelated generic runtime evidence", retryable = false }, run.requestId)
			self.active = nil
			self.state("RUNTIME REJECTED", "Studio returned invalid generic runtime evidence.")
			return
		end
		local universal = runtimeEnvelope(run.projection, envelope)
		universal.diagnostics = {}
		for _, diagnostic in ipairs(diagnostics.messageHashes) do table.insert(universal.diagnostics, { code = "studio_log", messageHash = diagnostic }) end
		universal.contentHash = Generated.envelopeHash(universal)
		local encoded = HttpService:JSONEncode(universal)
		if #encoded > run.plan.budget.maxResultBytes then
			self.send("PluginError", { code = "SECURITY_REJECTION", message = "Runtime observations exceeded the configured result bound", retryable = false }, run.requestId)
			self.active = nil
			self.state("RUNTIME REJECTED", "Runtime observations exceeded their bounded result limit.")
			return
		end
		self.send("StudioEvidenceProduced", { project = run.projection.project, reason = "runtime", projection = run.projection, envelope = universal }, run.requestId)
		self.send("RuntimeEvalStopped", { executionPlanId = run.plan.id, executionPlanHash = run.plan.hash, projectionId = run.projection.id, projectionHash = run.projection.contentHash, bindingHash = run.projection.bindingHash, nonceCommitment = run.commitment, mode = "play_solo", playerCount = 1, control = run.control }, run.requestId)
		self.active = nil
		self.state("RUNTIME COMPLETE", "Bounded factual observations returned to Forge for backend-only grading.")
	end)
end

return RuntimeCapabilityExecutor
