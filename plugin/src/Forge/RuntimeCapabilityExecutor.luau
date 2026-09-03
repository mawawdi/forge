--!strict
-- Fixed Studio capability executor. The sealed execution plan is interpreted
-- directly by generated manifest dispatch in the Play Server plugin. No plan
-- data is ever converted into source or written into the place.
local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local StudioTestService = game:GetService("StudioTestService")
local Constants = require(script.Parent.Constants)
local DirectRuntimeObserver = require(script.Parent.DirectRuntimeObserver)
local Generated = require(script.Parent.GeneratedStudioEvidence)
local Hash = require(script.Parent.Hash)

local RuntimeCapabilityExecutor = {}
RuntimeCapabilityExecutor.__index = RuntimeCapabilityExecutor

-- This is deliberately the only passive-runtime setting. It crosses the
-- Edit, Play Server, and return-to-Edit DataModels without writing any place
-- object or touching ChangeHistory.
local PASSIVE_RUNTIME_SETTING = "ForgePassiveRuntimeDirectV2"
local PASSIVE_RUNTIME_KIND = "ForgePassiveCreatorRuntimeDirectV2"

local function contains(values: {any}, needle: any): boolean
	for _, value in ipairs(values) do if value == needle then return true end end
	return false
end

local function sortDiagnostics(values: {any})
	table.sort(values, function(left, right)
		return left.code < right.code or left.code == right.code and left.messageHash < right.messageHash
	end)
end

local function isText(value: any): boolean return typeof(value) == "string" and value ~= "" end
local function isHash(value: any): boolean return typeof(value) == "string" and string.match(value, "^[0-9a-f]+$") ~= nil and #value == 64 end
local function validObjectIdentity(value: any): boolean
	if typeof(value) ~= "table" then return false end
	if value.kind == "forge_attribute" then return isText(value.stableId) end
	if value.kind == "studio_ephemeral" then return isText(value.connectorEpoch) and isHash(value.opaqueHash) end
	if value.kind == "rojo_sourcemap" then return isHash(value.authorityMapHash) and isHash(value.sourcemapHash) and isText(value.mappingId) end
	return false
end
local function validProject(value: any): boolean
	return typeof(value) == "table"
		and isText(value.name)
		and typeof(value.placeId) == "number" and value.placeId == math.floor(value.placeId) and value.placeId >= 0
		and typeof(value.universeId) == "number" and value.universeId == math.floor(value.universeId) and value.universeId >= 0
end
local function sameProject(left: any, right: any): boolean
	return validProject(left) and validProject(right)
		and left.name == right.name and left.placeId == right.placeId and left.universeId == right.universeId
end

-- Tags and byte lengths make the durable arm's identity independent of JSON
-- object-key ordering in Plugin:SetSetting/GetSetting.
local function tagged(values: {any}): string
	local material = { "forge-passive-runtime" }
	for _, entry in ipairs(values) do
		table.insert(material, #entry[1] .. ":" .. entry[1] .. #entry[2] .. ":" .. entry[2])
	end
	return table.concat(material, "")
end

local function armHash(arm: any): string
	return Hash.sha256(tagged({
		{ "manifest", arm.manifestHash }, { "build", arm.connectorBuildHash },
		{ "request", arm.requestId }, { "studio-session", arm.sessionId }, { "studio-project", arm.projectId },
		{ "token", arm.sessionToken }, { "bridge", arm.bridgeUrl }, { "revision", arm.expectedProjectRevisionHash },
		{ "project-name", arm.project.name }, { "project-place", tostring(arm.project.placeId) }, { "project-universe", tostring(arm.project.universeId) },
		{ "plan-json", arm.executionPlanJsonHash }, { "plan", arm.executionPlanHash }, { "plan-id", arm.executionPlanId },
		{ "projection-json", arm.evidenceProjectionJsonHash }, { "projection", arm.projectionHash }, { "projection-id", arm.projectionId },
		{ "binding", arm.bindingHash }, { "nonce", arm.nonce }, { "nonce-commitment", arm.nonceCommitment },
		{ "creator-session", arm.creatorSessionId },
	}))
end

local function lifecyclePayload(arm: any): any
	return {
		executionPlanId = arm.executionPlanId,
		executionPlanHash = arm.executionPlanHash,
		projectionId = arm.projectionId,
		projectionHash = arm.projectionHash,
		bindingHash = arm.bindingHash,
		nonceCommitment = arm.nonceCommitment,
		mode = "play_solo",
		playerCount = 1,
		control = "creator_action",
	}
end

local function receiptHash(arm: any, receipt: any): string
	return Hash.sha256(tagged({
		{ "arm", arm.armHash }, { "status", receipt.status }, { "envelope", receipt.envelope.contentHash },
		{ "started", receipt.lifecycle.executionPlanHash }, { "stopped", receipt.lifecycle.nonceCommitment },
	}))
end

local function sameArm(left: any, right: any): boolean
	return typeof(left) == "table" and typeof(right) == "table"
		and left.armHash == right.armHash
		and left.manifestHash == right.manifestHash
		and left.connectorBuildHash == right.connectorBuildHash
		and left.requestId == right.requestId
		and left.sessionId == right.sessionId and left.projectId == right.projectId and left.sessionToken == right.sessionToken
		and left.bridgeUrl == right.bridgeUrl and left.expectedProjectRevisionHash == right.expectedProjectRevisionHash
		and left.executionPlanJson == right.executionPlanJson and left.executionPlanJsonHash == right.executionPlanJsonHash
		and left.executionPlanId == right.executionPlanId and left.executionPlanHash == right.executionPlanHash
		and left.evidenceProjectionJson == right.evidenceProjectionJson and left.evidenceProjectionJsonHash == right.evidenceProjectionJsonHash
		and left.projectionId == right.projectionId and left.projectionHash == right.projectionHash
		and left.bindingHash == right.bindingHash and left.nonce == right.nonce and left.nonceCommitment == right.nonceCommitment
		and left.creatorSessionId == right.creatorSessionId and sameProject(left.project, right.project)
end

local function sameReceipt(left: any, right: any): boolean
	return typeof(left) == "table" and typeof(right) == "table"
		and left.status == right.status and left.receiptHash == right.receiptHash
		and typeof(left.envelope) == "table" and typeof(right.envelope) == "table"
		and left.envelope.contentHash == right.envelope.contentHash
		and typeof(left.lifecycle) == "table" and typeof(right.lifecycle) == "table"
		and left.lifecycle.executionPlanId == right.lifecycle.executionPlanId
		and left.lifecycle.executionPlanHash == right.lifecycle.executionPlanHash
		and left.lifecycle.projectionId == right.lifecycle.projectionId
		and left.lifecycle.projectionHash == right.lifecycle.projectionHash
		and left.lifecycle.bindingHash == right.lifecycle.bindingHash
		and left.lifecycle.nonceCommitment == right.lifecycle.nonceCommitment
end

local function samePassiveFinalization(left: any, right: any): boolean
	return typeof(left) == "table" and typeof(right) == "table"
		and left.kind == "ForgePassiveRuntimeFinalization" and right.kind == "ForgePassiveRuntimeFinalization"
		and left.requestId == right.requestId and left.messageId == right.messageId
		and typeof(left.acknowledgement) == "table" and typeof(right.acknowledgement) == "table"
		and left.acknowledgement.executionPlanId == right.acknowledgement.executionPlanId
		and left.acknowledgement.executionPlanHash == right.acknowledgement.executionPlanHash
		and left.acknowledgement.projectionId == right.acknowledgement.projectionId
		and left.acknowledgement.projectionHash == right.acknowledgement.projectionHash
		and left.acknowledgement.bindingHash == right.acknowledgement.bindingHash
		and left.acknowledgement.nonceCommitment == right.acknowledgement.nonceCommitment
		and left.acknowledgement.status == "cleared" and right.acknowledgement.status == "cleared"
end

local function samePassiveSetting(left: any, right: any): boolean
	if typeof(left) ~= "table" or typeof(right) ~= "table" or left.kind ~= PASSIVE_RUNTIME_KIND or right.kind ~= PASSIVE_RUNTIME_KIND or not sameArm(left.arm, right.arm) then return false end
	if right.receipt == nil then
		if left.receipt ~= nil then return false end
	else
		if not sameReceipt(left.receipt, right.receipt) then return false end
	end
	if right.finalization == nil then
		if left.finalization ~= nil then return false end
	elseif not samePassiveFinalization(left.finalization, right.finalization) then return false end
	return left.transportAbandoned == right.transportAbandoned
end

local function settingSnapshot(value: any): any
	local encoded = HttpService:JSONEncode(value)
	if #encoded > Constants.MAX_MESSAGE_BYTES then error("passive runtime setting exceeds the bounded protocol body") end
	return HttpService:JSONDecode(encoded)
end

local function persistPassive(plugin: Plugin, value: any?): any
	local snapshot = value == nil and nil or settingSnapshot(value)
	plugin:SetSetting(PASSIVE_RUNTIME_SETTING, snapshot)
	local stored = plugin:GetSetting(PASSIVE_RUNTIME_SETTING)
	if snapshot == nil then
		if stored ~= nil then error("passive runtime setting clear verification failed") end
		return nil
	end
	if not samePassiveSetting(stored, snapshot) then error("passive runtime setting write/read verification failed") end
	return stored
end

local function passiveSetting(plugin: Plugin): any return plugin:GetSetting(PASSIVE_RUNTIME_SETTING) end

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
			output.result = result.status == "ok" and { status = "observed", value = Generated.canonicalValue({ kind = "vector3_f32", x = result.position.x, y = result.position.y, z = result.position.z }) } or result.status == "missing" and { status = "absent" } or { status = "unavailable", code = "runtime_position_unavailable" }
		elseif requirement.kind == "position_series" then
			if result.status == "missing" then output.result = { status = "absent" }
			elseif result.status ~= "ok" then output.result = { status = "unavailable", code = "runtime_series_unavailable" }
			else
				local samples = {}
				for _, sample in ipairs(result.samples) do table.insert(samples, { sequence = sample.sequence, elapsedMs = sample.elapsedMs, value = { x = sample.position.x, y = sample.position.y, z = sample.position.z } }) end
				output.result = { status = "observed", value = samples }
			end
		elseif requirement.kind == "runtime_property" then
			local metadata = requirement.target.kind == "instance" and Generated.propertyMetadata(requirement.target.className, requirement.propertyName) or nil
			if result.status == "missing" then output.result = { status = "absent" }
			elseif result.status ~= "ok" or result.propertyName ~= requirement.propertyName or metadata == nil then output.result = { status = "unavailable", code = "runtime_manifest_property_unavailable" }
			else
				local ok, value = pcall(function() return Generated.validateValue(metadata.codec, result.value, metadata) end)
				output.result = ok and { status = "observed", value = value } or { status = "read_error", code = "runtime_manifest_property_invalid" }
			end
		elseif requirement.kind == "runtime_property_series" then
			local metadata = requirement.target.kind == "instance" and Generated.propertyMetadata(requirement.target.className, requirement.propertyName) or nil
			if result.status == "missing" then output.result = { status = "absent" }
			elseif result.status ~= "ok" or result.propertyName ~= requirement.propertyName or metadata == nil then output.result = { status = "unavailable", code = "runtime_manifest_property_series_unavailable" }
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
	for _, fact in ipairs(facts) do if fact.result.status == "unavailable" or fact.result.status == "read_error" then complete = false; break end end
	local envelope: any = { kind = "StudioEvidenceEnvelope", manifestHash = Generated.manifestHash, projectionId = projection.id, projectionHash = projection.contentHash, bindingHash = projection.bindingHash, project = projection.project, authoritative = true, startedAt = raw.startedAt, endedAt = raw.endedAt, completion = complete and "complete" or "incomplete", facts = facts }
	envelope.contentHash = Generated.envelopeHash(envelope)
	return envelope
end

local function parseRuntimePayload(payload: any, expected: any): (any, any)
	if typeof(payload.executionPlanJson) ~= "string" or typeof(payload.executionPlanJsonHash) ~= "string" or Hash.sha256(payload.executionPlanJson) ~= payload.executionPlanJsonHash then error("runtime execution plan transport hash mismatch") end
	local decodedOk, plan = pcall(function() return HttpService:JSONDecode(payload.executionPlanJson) end)
	if not decodedOk or typeof(plan) ~= "table" then error("invalid runtime execution JSON") end
	if plan.kind ~= "StudioExecutionPlan" or not isHash(plan.hash) or not isText(plan.id) or (plan.purpose ~= "runtime_evaluation" and plan.purpose ~= "capability_canary" and plan.purpose ~= "creator_verification") then error("runtime execution plan rejected") end
	if (payload.startPolicy ~= "explicit_plugin_action" and payload.startPolicy ~= "observe_next_creator_play") or (plan.purpose == "creator_verification") ~= (payload.startPolicy == "observe_next_creator_play") then error("runtime start policy rejected") end
	if plan.manifestHash ~= Generated.manifestHash or typeof(plan.binding) ~= "table" or not isText(plan.binding.sessionId) or not isText(plan.binding.projectId) or not isHash(plan.binding.projectRevisionHash) then error("runtime execution binding rejected") end
	if plan.binding.projectRevisionHash ~= payload.expectedProjectRevisionHash then error("runtime execution project-revision precondition mismatch") end
	if typeof(expected) ~= "table" or plan.binding.sessionId ~= expected.sessionId or plan.binding.projectId ~= expected.projectId or plan.binding.projectRevisionHash ~= expected.projectRevisionHash or not sameProject(plan.binding.project, expected.project) then error("runtime execution session/project/project-revision binding mismatch") end
	if typeof(plan.targets) ~= "table" or typeof(plan.calls) ~= "table" or #plan.targets < 1 or #plan.targets > Generated.manifest.limits.maximumRuntimeTargets or #plan.calls < 1 or #plan.calls > Generated.manifest.limits.maximumRuntimeCalls or typeof(plan.budget) ~= "table" or typeof(plan.budget.maxExecutionMs) ~= "number" or typeof(plan.budget.maxResultBytes) ~= "number" or plan.budget.maxExecutionMs < 1 or plan.budget.maxExecutionMs > Generated.manifest.limits.maximumRuntimeMs or plan.budget.maxResultBytes < 1 or plan.budget.maxResultBytes > Generated.manifest.limits.maximumRuntimeResultBytes or typeof(plan.observationWindowMs) ~= "number" or plan.observationWindowMs % 1 ~= 0 or plan.observationWindowMs < 0 or plan.observationWindowMs > plan.budget.maxExecutionMs then error("runtime execution capability bounds rejected") end
	local evidenceProjectionOk, evidenceProjection = pcall(function()
		if typeof(payload.evidenceProjectionJson) ~= "string" or typeof(payload.evidenceProjectionJsonHash) ~= "string" or Hash.sha256(payload.evidenceProjectionJson) ~= payload.evidenceProjectionJsonHash then error("runtime evidence projection transport hash mismatch") end
		local decoded = HttpService:JSONDecode(payload.evidenceProjectionJson)
		Generated.validateProjection(decoded)
		local expectedProjectionPurpose = plan.purpose == "creator_verification" and "creator_verification" or "runtime_evaluation"
		if not isHash(payload.evidenceProjectionHash) or decoded.contentHash ~= payload.evidenceProjectionHash or decoded.purpose ~= expectedProjectionPurpose or typeof(plan.evidenceProjection) ~= "table" or plan.evidenceProjection.contentHash ~= decoded.contentHash or plan.evidenceProjection.purpose ~= expectedProjectionPurpose then error("runtime evidence projection rejected") end
		return decoded
	end)
	if not evidenceProjectionOk then error(tostring(evidenceProjection)) end
	local targets, resolved, callIds, scheduledWaitMs = {}, {}, {}, 0
	for _, target in ipairs(plan.targets) do
		local pieces = typeof(target) == "table" and typeof(target.path) == "string" and string.split(target.path, "/") or nil
		if typeof(target) ~= "table" or not isText(target.id) or targets[target.id] or not pieces or #pieces < 2 or not Generated.isAllowedRoot(pieces[1]) or string.find(target.path, "%.%.") or not contains(Generated.resolvableClasses, target.expectedClass) or not validObjectIdentity(target.identity) then error("runtime target rejected") end
		for _, piece in ipairs(pieces) do if piece == "" or piece == "." or piece == ".." then error("runtime target rejected") end end
		targets[target.id] = target
	end
	for _, call in ipairs(plan.calls) do
		if typeof(call) ~= "table" or not isText(call.id) or callIds[call.id] or not isText(call.targetId) or not targets[call.targetId] then error("runtime call rejected") end
		callIds[call.id] = true
		Generated.runtimeDispatch(call.capability, {
			instance_identity = function() resolved[call.targetId] = true end,
			vector3_f32 = function()
				if not resolved[call.targetId] or targets[call.targetId].expectedClass ~= "BasePart" or not string.match(targets[call.targetId].path, "^Workspace/") then error("runtime vector observation requires prior Workspace BasePart resolution") end
			end,
			position_series_f32 = function(metadata: any)
				if not resolved[call.targetId] or targets[call.targetId].expectedClass ~= "BasePart" or not string.match(targets[call.targetId].path, "^Workspace/") or typeof(call.sampleCount) ~= "number" or call.sampleCount < 1 or call.sampleCount > metadata.maximumSamples or typeof(call.intervalMs) ~= "number" or call.intervalMs < metadata.minimumIntervalMs or call.intervalMs > metadata.maximumIntervalMs then error("runtime position series rejected") end
				local seriesDurationMs = (call.sampleCount - 1) * call.intervalMs
				if plan.purpose == "creator_verification" and seriesDurationMs < plan.observationWindowMs then error("creator position series ends before the observation window") end
				scheduledWaitMs = math.max(scheduledWaitMs, seriesDurationMs)
			end,
			manifest_property = function()
				if not resolved[call.targetId] or not isText(call.propertyName) then error("runtime manifest property requires prior resolution and a property name") end
				local property = Generated.propertyMetadata(targets[call.targetId].expectedClass, call.propertyName)
				if property == nil or property.codec == "instance_ref" then error("runtime manifest property is outside the fixed observation domain") end
			end,
			manifest_property_series = function(metadata: any)
				if not resolved[call.targetId] or not isText(call.propertyName) or typeof(call.sampleCount) ~= "number" or call.sampleCount < 1 or call.sampleCount > metadata.maximumSamples or typeof(call.intervalMs) ~= "number" or call.intervalMs < metadata.minimumIntervalMs or call.intervalMs > metadata.maximumIntervalMs then error("runtime manifest property series rejected") end
				local property = Generated.propertyMetadata(targets[call.targetId].expectedClass, call.propertyName)
				if property == nil or property.codec == "instance_ref" then error("runtime manifest property series is outside the fixed observation domain") end
				scheduledWaitMs = math.max(scheduledWaitMs, (call.sampleCount - 1) * call.intervalMs)
			end,
		}, { call = call, target = targets[call.targetId] })
	end
	if math.max(scheduledWaitMs, plan.observationWindowMs) > plan.budget.maxExecutionMs then error("runtime execution schedule exceeds budget") end
	return plan, evidenceProjection
end

local function validPassiveArm(arm: any): boolean
	if typeof(arm) ~= "table" or arm.manifestHash ~= Generated.manifestHash or arm.connectorBuildHash ~= Generated.connectorBuildHash or not isText(arm.requestId) or not isText(arm.sessionId) or not isText(arm.projectId) or not isText(arm.sessionToken) or not isText(arm.bridgeUrl) or not isHash(arm.expectedProjectRevisionHash) or not isText(arm.executionPlanJson) or not isHash(arm.executionPlanJsonHash) or not isText(arm.executionPlanId) or not isHash(arm.executionPlanHash) or not isText(arm.evidenceProjectionJson) or not isHash(arm.evidenceProjectionJsonHash) or not isText(arm.projectionId) or not isHash(arm.projectionHash) or not isHash(arm.bindingHash) or not isText(arm.nonce) or not isHash(arm.nonceCommitment) or not isText(arm.creatorSessionId) or not validProject(arm.project) or not isHash(arm.armHash) then return false end
	local hashed, actual = pcall(function() return armHash(arm) end)
	return hashed and actual == arm.armHash and Hash.sha256(arm.executionPlanJson) == arm.executionPlanJsonHash and Hash.sha256(arm.evidenceProjectionJson) == arm.evidenceProjectionJsonHash and Hash.sha256(arm.nonce) == arm.nonceCommitment
end

local function validPassiveReceipt(arm: any, receipt: any): boolean
	if typeof(receipt) ~= "table" or (receipt.status ~= "complete" and receipt.status ~= "incomplete") or typeof(receipt.envelope) ~= "table" or typeof(receipt.lifecycle) ~= "table" or not isHash(receipt.receiptHash) then return false end
	local lifecycle = lifecyclePayload(arm)
	if receipt.lifecycle.executionPlanId ~= lifecycle.executionPlanId or receipt.lifecycle.executionPlanHash ~= lifecycle.executionPlanHash or receipt.lifecycle.projectionId ~= lifecycle.projectionId or receipt.lifecycle.projectionHash ~= lifecycle.projectionHash or receipt.lifecycle.bindingHash ~= lifecycle.bindingHash or receipt.lifecycle.nonceCommitment ~= lifecycle.nonceCommitment then return false end
	local validEnvelope, expectedHash = pcall(function() return Generated.envelopeHash(receipt.envelope) end)
	if not validEnvelope or receipt.envelope.contentHash ~= expectedHash or receipt.envelope.manifestHash ~= Generated.manifestHash or receipt.envelope.projectionId ~= arm.projectionId or receipt.envelope.projectionHash ~= arm.projectionHash or receipt.envelope.bindingHash ~= arm.bindingHash then return false end
	local validHash, expectedReceiptHash = pcall(function() return receiptHash(arm, receipt) end)
	return validHash and expectedReceiptHash == receipt.receiptHash
end

local function passiveMessageId(arm: any, suffix: string): string
	return "passive_runtime_" .. string.sub(Hash.sha256(arm.armHash .. ":" .. suffix), 1, 24)
end

local function passiveAcknowledgement(arm: any): any
	local lifecycle = lifecyclePayload(arm)
	return {
		executionPlanId = lifecycle.executionPlanId, executionPlanHash = lifecycle.executionPlanHash,
		projectionId = lifecycle.projectionId, projectionHash = lifecycle.projectionHash,
		bindingHash = lifecycle.bindingHash, nonceCommitment = lifecycle.nonceCommitment,
		status = "cleared",
	}
end

local function validPassiveFinalization(arm: any, finalization: any): boolean
	if typeof(finalization) ~= "table" or finalization.kind ~= "ForgePassiveRuntimeFinalization" or finalization.requestId ~= arm.requestId or finalization.messageId ~= passiveMessageId(arm, "finalized") then return false end
	return samePassiveFinalization(finalization, {
		kind = "ForgePassiveRuntimeFinalization", requestId = arm.requestId,
		messageId = passiveMessageId(arm, "finalized"), acknowledgement = passiveAcknowledgement(arm),
	})
end

local function validPassiveSetting(value: any): boolean
	return typeof(value) == "table"
		and value.kind == PASSIVE_RUNTIME_KIND
		and validPassiveArm(value.arm)
		and (value.receipt == nil or validPassiveReceipt(value.arm, value.receipt))
		and (value.finalization == nil or value.receipt ~= nil and validPassiveFinalization(value.arm, value.finalization))
		and (value.transportAbandoned == nil or typeof(value.transportAbandoned) == "boolean")
end

local function canReplacePassiveArm(value: any, expected: any): boolean
	if value == nil then return true end
	if not validPassiveSetting(value) or value.transportAbandoned == true or value.receipt == nil or value.finalization == nil or typeof(expected) ~= "table" then return false end
	return value.arm.creatorSessionId == expected.creatorSessionId
		and value.arm.sessionId == expected.sessionId
		and value.arm.projectId == expected.projectId
		and value.arm.expectedProjectRevisionHash == expected.projectRevisionHash
		and sameProject(value.arm.project, expected.project)
end

function RuntimeCapabilityExecutor.new(plugin: Plugin, send, state)
	return setmetatable({ plugin = plugin, send = send, state = state, active = nil, blocked = false }, RuntimeCapabilityExecutor)
end

function RuntimeCapabilityExecutor:isActive(): boolean return self.active ~= nil end

function RuntimeCapabilityExecutor:abort()
	if not self.active then return end
	self.active.closed = true
	if self.active.diagnosticConnection then self.active.diagnosticConnection:Disconnect() end
	-- A creator arm is a durable handoff. Never clear it on reload, unpair, or
	-- transport error; only exact finalization or transaction cancellation may.
	if self.active.control ~= "creator_action" and self.active.phase == "running" then self.blocked = true end
	self.active = nil
end

function RuntimeCapabilityExecutor:arm(payload: any, requestId: string?, expected: any)
	if self.active then error("a generic runtime execution is already armed or running") end
	if self.blocked then error("generic runtime execution is blocked after interruption; reload Forge") end
	if payload.startPolicy == "explicit_plugin_action" and typeof(StudioTestService.ExecutePlayModeAsync) ~= "function" then error("this Roblox Studio build does not provide ExecutePlayModeAsync") end
	local plan, evidenceProjection = parseRuntimePayload(payload, expected)
	local nonce = HttpService:GenerateGUID(false) .. HttpService:GenerateGUID(false)
	local commitment = Hash.sha256(nonce)
	if payload.startPolicy == "observe_next_creator_play" then
		if not isText(requestId) or typeof(expected) ~= "table" or not isText(expected.sessionToken) or not isText(expected.bridgeUrl) or not isText(expected.creatorSessionId) then error("passive runtime durable binding rejected") end
		if not canReplacePassiveArm(passiveSetting(self.plugin), expected) then error("passive runtime replacement requires the exact finalized receipt for this creator transaction") end
		local arm = {
			manifestHash = Generated.manifestHash, connectorBuildHash = Generated.connectorBuildHash,
			requestId = requestId, sessionId = expected.sessionId, projectId = expected.projectId, sessionToken = expected.sessionToken, bridgeUrl = expected.bridgeUrl, expectedProjectRevisionHash = expected.projectRevisionHash,
			executionPlanJson = payload.executionPlanJson, executionPlanJsonHash = payload.executionPlanJsonHash, executionPlanId = plan.id, executionPlanHash = plan.hash,
			evidenceProjectionJson = payload.evidenceProjectionJson, evidenceProjectionJsonHash = payload.evidenceProjectionJsonHash, projectionId = evidenceProjection.id, projectionHash = evidenceProjection.contentHash, bindingHash = evidenceProjection.bindingHash,
			nonce = nonce, nonceCommitment = commitment, project = expected.project, creatorSessionId = expected.creatorSessionId,
		}
		arm.armHash = armHash(arm)
		persistPassive(self.plugin, { kind = PASSIVE_RUNTIME_KIND, arm = arm })
		self.active = { payload = payload, requestId = requestId, plan = plan, projection = evidenceProjection, nonce = nonce, commitment = commitment, phase = "armed", closed = false, control = "creator_action", arm = arm }
		self.send("RuntimeEvalPlanAccepted", { executionPlanId = plan.id, executionPlanHash = plan.hash, projectionId = evidenceProjection.id, projectionHash = evidenceProjection.contentHash, bindingHash = evidenceProjection.bindingHash, nonceCommitment = commitment, callCount = #plan.calls, instruction = "Forge stored the exact Play-server observer. Press Studio Play normally, perform the approved interaction, then press Stop." }, requestId, passiveMessageId(arm, "accepted"))
		self.state("WAITING FOR PLAY", "Forge stored the exact observer for the next ordinary Studio Play session.")
		return
	end
	self.active = { payload = payload, requestId = requestId, plan = plan, projection = evidenceProjection, nonce = nonce, commitment = commitment, phase = "armed", closed = false, control = "plugin_action" }
	self.send("RuntimeEvalPlanAccepted", { executionPlanId = plan.id, executionPlanHash = plan.hash, projectionId = evidenceProjection.id, projectionHash = evidenceProjection.contentHash, bindingHash = evidenceProjection.bindingHash, nonceCommitment = commitment, callCount = #plan.calls, instruction = "Runtime capability execution is armed. Click Evaluate in Studio." }, requestId)
	self.state("READY TO EVALUATE", "Runtime capability execution is armed. Click Evaluate in Studio.")
end

function RuntimeCapabilityExecutor:_attachPassiveDiagnostics(run: any)
	run.diagnosticConnection = LogService.MessageOut:Connect(function(message, messageType)
		if run.closed then return end
		local text = tostring(message)
		local code = messageType == Enum.MessageType.MessageError and "error" or messageType == Enum.MessageType.MessageWarning and "warning" or nil
		if not code then return end
		if #run.diagnostics.entries < Generated.manifest.limits.maximumDiagnostics - 1 then table.insert(run.diagnostics.entries, { code = code, messageHash = Hash.sha256(string.sub(text, 1, Constants.MAX_DIAGNOSTIC_CHARS)) })
		else run.diagnostics.truncated = true end
	end)
end

function RuntimeCapabilityExecutor:resumePassive()
	if self.active then error("passive runtime resume found an active executor") end
	local stored = passiveSetting(self.plugin)
	if not validPassiveSetting(stored) then error("no valid durable passive runtime arm") end
	if stored.transportAbandoned == true then return false end
	if stored.receipt ~= nil then
		if not validPassiveReceipt(stored.arm, stored.receipt) then error("durable passive runtime receipt is malformed") end
		if stored.finalization ~= nil and not validPassiveFinalization(stored.arm, stored.finalization) then error("durable passive runtime finalization is malformed") end
		return false
	end
	if stored.finalization ~= nil then error("durable passive runtime finalization exists without a terminal receipt") end
	local arm = stored.arm
	local payload = {
			expectedProjectRevisionHash = arm.expectedProjectRevisionHash, executionPlanJson = arm.executionPlanJson, executionPlanJsonHash = arm.executionPlanJsonHash,
		evidenceProjectionJson = arm.evidenceProjectionJson, evidenceProjectionJsonHash = arm.evidenceProjectionJsonHash, evidenceProjectionHash = arm.projectionHash,
		startPolicy = "observe_next_creator_play",
	}
	local plan, projection = parseRuntimePayload(payload, { sessionId = arm.sessionId, projectId = arm.projectId, projectRevisionHash = arm.expectedProjectRevisionHash, project = arm.project })
	if plan.id ~= arm.executionPlanId or plan.hash ~= arm.executionPlanHash or projection.id ~= arm.projectionId or projection.contentHash ~= arm.projectionHash or projection.bindingHash ~= arm.bindingHash then error("durable passive runtime arm identity mismatch") end
	local run = { payload = payload, requestId = arm.requestId, plan = plan, projection = projection, nonce = arm.nonce, commitment = arm.nonceCommitment, phase = "running", closed = false, control = "creator_action", arm = arm, diagnostics = { entries = {}, truncated = false }, startedAt = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), startedClock = os.clock(), finalizing = false }
	self.active = run
	self:_attachPassiveDiagnostics(run)
	run.observer = DirectRuntimeObserver.new(plan, { generated = Generated })
	local prepared, prepareError = pcall(function() return run.observer:start() end)
	if not prepared then run.observerFailure = "direct Play-server observer failed to start: " .. tostring(prepareError)
	elseif prepareError ~= true then run.observerFailure = run.observer.failure or "direct Play-server observer failed to start" end
	self.send("RuntimeEvalStarted", lifecyclePayload(arm), arm.requestId, passiveMessageId(arm, "started"))
	self.state("OBSERVING PLAY", "Forge is silently observing only the exact approved runtime facts.")
	return true
end

function RuntimeCapabilityExecutor:sealPassive()
	local run = self.active
	if not run or run.control ~= "creator_action" or run.finalizing then return false end
	run.finalizing = true
	if run.diagnosticConnection then run.diagnosticConnection:Disconnect() end
	local results = {}
	if run.observer then
		local sealed, observerFailure = run.observer:seal()
		results = sealed
		if observerFailure and not run.observerFailure then run.observerFailure = observerFailure end
	end
	local raw = { kind = "ForgeRuntimeResults", executionPlanId = run.plan.id, executionPlanHash = run.plan.hash, binding = run.plan.binding, nonce = run.nonce, authoritative = true, startedAt = run.startedAt, endedAt = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), durationMs = math.max(0, math.floor((os.clock() - run.startedClock) * 1000)), results = results }
	local universal = runtimeEnvelope(run.projection, raw)
	universal.diagnostics = {}
	for _, diagnostic in ipairs(run.diagnostics.entries) do table.insert(universal.diagnostics, diagnostic) end
	if run.diagnostics.truncated then universal.completion = "incomplete"; table.insert(universal.diagnostics, { code = "diagnostics_truncated", messageHash = Hash.sha256("Studio diagnostics exceeded the bounded capture limit") }) end
	if run.observerFailure then universal.completion = "incomplete"; table.insert(universal.diagnostics, { code = "runtime_observer_failure", messageHash = Hash.sha256(string.sub(run.observerFailure, 1, Constants.MAX_DIAGNOSTIC_CHARS)) }) end
	sortDiagnostics(universal.diagnostics)
	universal.contentHash = Generated.envelopeHash(universal)
	local encodedOk, encoded = pcall(function() return HttpService:JSONEncode(universal) end)
	if not encodedOk or #encoded > run.plan.budget.maxResultBytes then
		self.send("PluginError", { code = "SECURITY_REJECTION", message = "Runtime observations exceeded the configured result bound and were not persisted", retryable = false }, run.requestId, passiveMessageId(run.arm, "persistence_error"))
		self.active = nil
		return false
	end
	local receipt = { status = universal.completion == "complete" and "complete" or "incomplete", envelope = universal, lifecycle = lifecyclePayload(run.arm) }
	receipt.receiptHash = receiptHash(run.arm, receipt)
	local storedOk, storedOrFailure = pcall(function() return persistPassive(self.plugin, { kind = PASSIVE_RUNTIME_KIND, arm = run.arm, receipt = receipt }) end)
	if not storedOk then
		self.send("PluginError", { code = "STUDIO_FAILURE", message = "Passive runtime terminal receipt could not be persisted: " .. string.sub(tostring(storedOrFailure), 1, Constants.MAX_DIAGNOSTIC_CHARS), retryable = false }, run.requestId, passiveMessageId(run.arm, "persistence_error"))
		self.active = nil
		return false
	end
	self.send("StudioEvidenceProduced", { project = run.projection.project, reason = "runtime", projection = run.projection, envelope = universal }, run.requestId, passiveMessageId(run.arm, "evidence"))
	self.send("RuntimeEvalStopped", lifecyclePayload(run.arm), run.requestId, passiveMessageId(run.arm, "stopped"))
	self.active = nil
	self.state(universal.completion == "complete" and "PLAY EVIDENCE READY" or "PLAY EVIDENCE INCOMPLETE", "Forge persisted the terminal Play-server evidence before attempting transport.")
	return true
end

function RuntimeCapabilityExecutor:replayPassiveReceipt(): boolean
	local stored = passiveSetting(self.plugin)
	if not validPassiveSetting(stored) or stored.receipt == nil or stored.transportAbandoned == true then return false end
	local arm, receipt = stored.arm, stored.receipt
	if stored.finalization ~= nil then
		if not validPassiveFinalization(arm, stored.finalization) then error("persisted passive runtime finalization is malformed") end
		self.send("PassiveRuntimeEvalFinalized", stored.finalization.acknowledgement, arm.requestId, stored.finalization.messageId)
		return true
	end
	local payload = { expectedProjectRevisionHash = arm.expectedProjectRevisionHash, executionPlanJson = arm.executionPlanJson, executionPlanJsonHash = arm.executionPlanJsonHash, evidenceProjectionJson = arm.evidenceProjectionJson, evidenceProjectionJsonHash = arm.evidenceProjectionJsonHash, evidenceProjectionHash = arm.projectionHash, startPolicy = "observe_next_creator_play" }
	local plan, projection = parseRuntimePayload(payload, { sessionId = arm.sessionId, projectId = arm.projectId, projectRevisionHash = arm.expectedProjectRevisionHash, project = arm.project })
	if plan.id ~= arm.executionPlanId or plan.hash ~= arm.executionPlanHash or projection.id ~= arm.projectionId or projection.contentHash ~= arm.projectionHash then error("persisted passive receipt plan binding mismatch") end
	self.send("RuntimeEvalStarted", lifecyclePayload(arm), arm.requestId, passiveMessageId(arm, "started"))
	self.send("StudioEvidenceProduced", { project = projection.project, reason = "runtime", projection = projection, envelope = receipt.envelope }, arm.requestId, passiveMessageId(arm, "evidence"))
	self.send("RuntimeEvalStopped", lifecyclePayload(arm), arm.requestId, passiveMessageId(arm, "stopped"))
	return true
end

function RuntimeCapabilityExecutor:finalizePassive(payload: any): any
	local stored = passiveSetting(self.plugin)
	if typeof(stored) ~= "table" or stored.kind ~= PASSIVE_RUNTIME_KIND or not validPassiveArm(stored.arm) or not validPassiveReceipt(stored.arm, stored.receipt) then error("passive runtime has no valid terminal receipt") end
	local arm, lifecycle = stored.arm, lifecyclePayload(stored.arm)
	if typeof(payload) ~= "table" or payload.requestId ~= arm.requestId then error("passive runtime finalizer request binding mismatch") end
	for _, field in ipairs({ "executionPlanId", "executionPlanHash", "projectionId", "projectionHash", "bindingHash", "nonceCommitment" }) do if payload[field] ~= lifecycle[field] then error("passive runtime finalizer lifecycle binding mismatch") end end
	if stored.finalization ~= nil then
		if not validPassiveFinalization(arm, stored.finalization) then error("passive runtime finalization is malformed") end
		return stored.finalization.acknowledgement
	end
	-- The backend has observed the exact terminal lifecycle, but the following
	-- acknowledgement can still lose transport while Edit reloads.  Preserve a
	-- readback-verified inert tombstone in the same setting; it can only replay
	-- the acknowledgement and can never start a new Play observer.
	local acknowledgement = passiveAcknowledgement(arm)
	local finalization = {
		kind = "ForgePassiveRuntimeFinalization", requestId = arm.requestId,
		messageId = passiveMessageId(arm, "finalized"), acknowledgement = acknowledgement,
	}
	persistPassive(self.plugin, { kind = PASSIVE_RUNTIME_KIND, arm = arm, receipt = stored.receipt, finalization = finalization })
	self.active = nil
	return acknowledgement
end

function RuntimeCapabilityExecutor.passiveContext(plugin: Plugin): any?
	local stored = passiveSetting(plugin)
	if stored == nil then return nil end
	if not validPassiveSetting(stored) then error("durable passive runtime setting is malformed") end
	-- Abandoned evidence remains available to exact recovery/cleanup helpers,
	-- but must never repopulate a stale bridge transport after a plugin reload.
	if stored.transportAbandoned == true then return nil end
	return stored.arm
end

function RuntimeCapabilityExecutor.passiveFinalizationMessageId(plugin: Plugin): string
	local stored = passiveSetting(plugin)
	if typeof(stored) ~= "table" or stored.kind ~= PASSIVE_RUNTIME_KIND or not validPassiveArm(stored.arm) or not validPassiveReceipt(stored.arm, stored.receipt) then error("passive runtime has no finalizable receipt") end
	return passiveMessageId(stored.arm, "finalized")
end

function RuntimeCapabilityExecutor.discardPassiveForCreatorSession(plugin: Plugin, creatorSessionId: string): boolean
	local stored = passiveSetting(plugin)
	if stored == nil then return false end
	if not validPassiveSetting(stored) then error("durable passive runtime setting is malformed") end
	if stored.arm.creatorSessionId ~= creatorSessionId then return false end
	persistPassive(plugin, nil)
	return true
end

-- Invalid current-version state cannot be replayed, finalized, or bound to a
-- creator session. It is cleared only by the creator's explicit connector UI
-- action so normal pairing can report the independent recording inventory.
-- A valid arm or receipt is never accepted by this recovery boundary.
function RuntimeCapabilityExecutor.discardInvalidPassive(plugin: Plugin): boolean
	local stored = passiveSetting(plugin)
	if stored == nil then return false end
	if validPassiveSetting(stored) then error("refusing to discard valid durable passive runtime evidence") end
	persistPassive(plugin, nil)
	return true
end

function RuntimeCapabilityExecutor.hasFinalizedPassiveForCreatorSession(plugin: Plugin, creatorSessionId: string): boolean
	local stored = passiveSetting(plugin)
	return validPassiveSetting(stored)
		and stored.arm.creatorSessionId == creatorSessionId
		and validPassiveReceipt(stored.arm, stored.receipt)
		and validPassiveFinalization(stored.arm, stored.finalization)
end

function RuntimeCapabilityExecutor.abandonPassiveTransport(plugin: Plugin): boolean
	local stored = passiveSetting(plugin)
	if stored == nil then return false end
	if not validPassiveSetting(stored) then error("durable passive runtime setting is malformed") end
	if stored.transportAbandoned == true then return true end
	local abandoned: any = { kind = PASSIVE_RUNTIME_KIND, arm = stored.arm, transportAbandoned = true }
	if stored.receipt ~= nil then abandoned.receipt = stored.receipt end
	if stored.finalization ~= nil then abandoned.finalization = stored.finalization end
	persistPassive(plugin, abandoned)
	return true
end

function RuntimeCapabilityExecutor.settingKeysForTest(): any return { passive = PASSIVE_RUNTIME_SETTING } end

-- Programmatic registered evaluations use StudioTestService only as their
-- lifecycle owner. The Play Server plugin reads the exact sealed plan from
-- GetTestArgs and observes it directly; no source-bearing place object exists.
function RuntimeCapabilityExecutor.runProgrammaticTest(): boolean
	local argsOk, args = pcall(function() return StudioTestService:GetTestArgs() end)
	local payload = argsOk and typeof(args) == "table" and args.forgeRuntimeDirectV1 or nil
	if typeof(payload) ~= "table" then return false end
	local decodedOk, decodedPlan = pcall(function() return HttpService:JSONDecode(payload.executionPlanJson) end)
	if not decodedOk or typeof(decodedPlan) ~= "table" then error("programmatic direct runtime plan is invalid") end
	local plan, projection = parseRuntimePayload(payload, {
		sessionId = decodedPlan.binding.sessionId,
		projectId = decodedPlan.binding.projectId,
		projectRevisionHash = decodedPlan.binding.projectRevisionHash,
		project = decodedPlan.binding.project,
	})
	if not isText(payload.nonce) or Hash.sha256(payload.nonce) ~= payload.nonceCommitment then error("programmatic direct runtime nonce is invalid") end
	local diagnostics = { entries = {}, truncated = false }
	local diagnosticConnection = LogService.MessageOut:Connect(function(message, messageType)
		local code = messageType == Enum.MessageType.MessageError and "error" or messageType == Enum.MessageType.MessageWarning and "warning" or nil
		if not code then return end
		if #diagnostics.entries < Generated.manifest.limits.maximumDiagnostics - 1 then table.insert(diagnostics.entries, { code = code, messageHash = Hash.sha256(string.sub(tostring(message), 1, Constants.MAX_DIAGNOSTIC_CHARS)) })
		else diagnostics.truncated = true end
	end)
	local observer = DirectRuntimeObserver.new(plan, { generated = Generated })
	local startedAt, startedClock = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), os.clock()
	local started, startFailure = pcall(function() return observer:start() end)
	local deadline = startedClock + (plan.budget.maxExecutionMs / 1000)
	if started and startFailure == true then
		while not observer:isFinished() and os.clock() < deadline do task.wait(0.01) end
	end
	local results, observerFailure = observer:seal()
	diagnosticConnection:Disconnect()
	local failure = not started and tostring(startFailure) or startFailure ~= true and (observer.failure or "direct runtime observer failed to start") or os.clock() >= deadline and "execution deadline exceeded" or observerFailure
	local raw = { kind = "ForgeRuntimeResults", executionPlanId = plan.id, executionPlanHash = plan.hash, binding = plan.binding, nonce = payload.nonce, authoritative = true, startedAt = startedAt, endedAt = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), durationMs = math.max(0, math.floor((os.clock() - startedClock) * 1000)), results = results }
	local envelope = runtimeEnvelope(projection, raw)
	envelope.diagnostics = {}
	for _, diagnostic in ipairs(diagnostics.entries) do table.insert(envelope.diagnostics, diagnostic) end
	if diagnostics.truncated then envelope.completion = "incomplete"; table.insert(envelope.diagnostics, { code = "diagnostics_truncated", messageHash = Hash.sha256("Studio diagnostics exceeded the bounded capture limit") }) end
	if failure then envelope.completion = "incomplete"; table.insert(envelope.diagnostics, { code = "runtime_observer_failure", messageHash = Hash.sha256(string.sub(tostring(failure), 1, Constants.MAX_DIAGNOSTIC_CHARS)) }) end
	sortDiagnostics(envelope.diagnostics)
	envelope.contentHash = Generated.envelopeHash(envelope)
	local returned = HttpService:JSONEncode({ kind = "ForgeDirectRuntimeResult", nonce = payload.nonce, envelope = envelope })
	if #returned > plan.budget.maxResultBytes then error("programmatic direct runtime result exceeded its bound") end
	StudioTestService:EndTest(returned)
	return true
end

function RuntimeCapabilityExecutor:start()
	local run = self.active
	if not run then error("no generic runtime execution is armed") end
	if run.phase ~= "armed" then error("generic runtime execution is already running") end
	run.phase = "running"
	self.send("RuntimeEvalStarted", { executionPlanId = run.plan.id, executionPlanHash = run.plan.hash, projectionId = run.projection.id, projectionHash = run.projection.contentHash, bindingHash = run.projection.bindingHash, nonceCommitment = run.commitment, mode = "play_solo", playerCount = 1, control = run.control }, run.requestId)
	self.state("RUNTIME RUNNING", "Play Solo is running the direct bounded capability observer.")
	task.spawn(function()
		local programmaticPayload = {
			expectedProjectRevisionHash = run.plan.binding.projectRevisionHash,
			executionPlanJson = run.payload.executionPlanJson,
			executionPlanJsonHash = run.payload.executionPlanJsonHash,
			evidenceProjectionJson = run.payload.evidenceProjectionJson,
			evidenceProjectionJsonHash = run.payload.evidenceProjectionJsonHash,
			evidenceProjectionHash = run.payload.evidenceProjectionHash,
			startPolicy = "explicit_plugin_action",
			nonce = run.nonce,
			nonceCommitment = run.commitment,
		}
		local ok, returned = pcall(function() return StudioTestService:ExecutePlayModeAsync({ forgeRuntimeDirectV1 = programmaticPayload }) end)
		if run.closed then return end
		if not ok or typeof(returned) ~= "string" then
			self.send("PluginError", { code = "STUDIO_FAILURE", message = string.sub((not ok and tostring(returned) or "ExecutePlayModeAsync did not return direct runtime evidence"), 1, Constants.MAX_DIAGNOSTIC_CHARS), retryable = false }, run.requestId)
			self.active = nil
			self.state("RUNTIME INCOMPLETE", "Play Solo stopped before authoritative runtime observations returned.")
			return
		end
		local decodedOk, result = pcall(function() return HttpService:JSONDecode(returned) end)
		local envelope = decodedOk and typeof(result) == "table" and result.envelope or nil
		local hashOk, computedHash = pcall(function() return Generated.envelopeHash(envelope) end)
		if not decodedOk or typeof(result) ~= "table" or result.kind ~= "ForgeDirectRuntimeResult" or result.nonce ~= run.nonce or typeof(envelope) ~= "table" or not hashOk or envelope.contentHash ~= computedHash or envelope.projectionId ~= run.projection.id or envelope.projectionHash ~= run.projection.contentHash or envelope.bindingHash ~= run.projection.bindingHash then
			self.send("PluginError", { code = "SECURITY_REJECTION", message = "Studio returned invalid or uncorrelated generic runtime evidence", retryable = false }, run.requestId)
			self.active = nil
			self.state("RUNTIME REJECTED", "Studio returned invalid generic runtime evidence.")
			return
		end
		local encoded = HttpService:JSONEncode(envelope)
		if #encoded > run.plan.budget.maxResultBytes then
			self.send("PluginError", { code = "SECURITY_REJECTION", message = "Runtime observations exceeded the configured result bound", retryable = false }, run.requestId)
			self.active = nil
			self.state("RUNTIME REJECTED", "Runtime observations exceeded their bounded result limit.")
			return
		end
		self.send("StudioEvidenceProduced", { project = run.projection.project, reason = "runtime", projection = run.projection, envelope = envelope }, run.requestId)
		self.send("RuntimeEvalStopped", { executionPlanId = run.plan.id, executionPlanHash = run.plan.hash, projectionId = run.projection.id, projectionHash = run.projection.contentHash, bindingHash = run.projection.bindingHash, nonceCommitment = run.commitment, mode = "play_solo", playerCount = 1, control = run.control }, run.requestId)
		self.active = nil
		self.state("RUNTIME COMPLETE", "Bounded factual observations returned to Forge for backend-only grading.")
	end)
end

return RuntimeCapabilityExecutor
