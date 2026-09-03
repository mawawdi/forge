--!strict
-- Dedicated local-place identity transaction. This authority is intentionally
-- disjoint from the generated authoring manifest: only an exact host-issued
-- Link/Fork command can write the reserved DataModel attribute.
local Constants = if script ~= nil then require(script.Parent.Constants) else require("./Constants")
local Hash = if script ~= nil then require(script.Parent.Hash) else require("./Hash")
local Canonical = if script ~= nil then require(script.Parent.StudioProjectIndexCanonical) else require("./StudioProjectIndexCanonical")

local StudioProjectIdentity = {}
StudioProjectIdentity.__index = StudioProjectIdentity

local TRANSACTION_SETTING = "ForgeStudioProjectIdentityTransactionV1"
local PROJECT_ID_PATTERN = "^forge_project_[0-9a-f]+$"
local MAXIMUM_SETTING_MATERIAL_BYTES = 64 * 1024

local function exactKeys(value: any, required: {string}, optional: {string}?): boolean
	if typeof(value) ~= "table" then return false end
	local allowed, count = {}, 0
	for _, key in ipairs(required) do allowed[key] = true end
	for _, key in ipairs(optional or {}) do allowed[key] = true end
	for key in pairs(value) do
		if typeof(key) ~= "string" or not allowed[key] then return false end
		count += 1
	end
	for _, key in ipairs(required) do if value[key] == nil then return false end end
	return count >= #required
end

local function isText(value: any, maximum: number): boolean
	if typeof(value) ~= "string" or value == "" or #value > maximum then return false end
	local valid, length = pcall(function() return utf8.len(value) end)
	return valid and length ~= nil
end

local function isIdentifier(value: any, maximum: number): boolean
	return isText(value, maximum) and string.find(value, "%s") == nil
end

local function isHash(value: any): boolean
	return typeof(value) == "string" and #value == 64 and string.match(value, "^[0-9a-f]+$") ~= nil
end

local function isProjectId(value: any): boolean
	return typeof(value) == "string" and #value == 46 and string.match(value, PROJECT_ID_PATTERN) ~= nil
end

local function isIso(value: any): boolean
	return isText(value, 64) and string.match(value, "^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.%d%d%dZ$") ~= nil
end

local function projectOf(root: any): any
	return { name = root.Name, placeId = root.PlaceId, universeId = root.GameId }
end

local function canonicalProject(value: any): any
	if not exactKeys(value, { "name", "placeId", "universeId" })
		or not isText(value.name, 512)
		or typeof(value.placeId) ~= "number"
		or value.placeId < 0
		or value.placeId % 1 ~= 0
		or value.placeId > 9007199254740991
		or typeof(value.universeId) ~= "number"
		or value.universeId < 0
		or value.universeId % 1 ~= 0
		or value.universeId > 9007199254740991
	then error("project identity project is malformed") end
	return { name = value.name, placeId = value.placeId, universeId = value.universeId }
end

local function sameProject(left: any, right: any): boolean
	return left.name == right.name and left.placeId == right.placeId and left.universeId == right.universeId
end

local function canonicalAttribute(value: any): any
	if typeof(value) ~= "table" or typeof(value.status) ~= "string" then error("project identity attribute state is malformed") end
	if value.status == "absent" then
		if not exactKeys(value, { "status" }) then error("project identity absent state is malformed") end
		return { status = "absent" }
	end
	if value.status == "observed" then
		if not exactKeys(value, { "status", "forgeProjectId" }) or not isProjectId(value.forgeProjectId) then error("project identity observed state is malformed") end
		return { status = "observed", forgeProjectId = value.forgeProjectId }
	end
	if value.status ~= "invalid" or not exactKeys(value, { "status", "valueType" }) or not isText(value.valueType, 64) then error("project identity invalid state is malformed") end
	return { status = "invalid", valueType = value.valueType }
end

local function statePayload(project: any, attribute: any): any
	local platform: any
	if project.placeId == 0 and project.universeId == 0 then
		platform = { kind = "local" }
	else
		platform = { kind = "published", universeId = project.universeId, placeId = project.placeId }
	end
	return {
		kind = "StudioProjectIdentityState",
		project = project,
		platform = platform,
		reservedAttribute = attribute,
	}
end

local function sealState(project: any, attribute: any): any
	local semantic = statePayload(canonicalProject(project), canonicalAttribute(attribute))
	semantic.hash = Hash.sha256(Canonical.material(semantic))
	return semantic
end

local function canonicalState(value: any): any
	if not exactKeys(value, { "kind", "project", "platform", "reservedAttribute", "hash" }) or value.kind ~= "StudioProjectIdentityState" or not isHash(value.hash) then error("project identity state is malformed") end
	local sealed = sealState(value.project, value.reservedAttribute)
	if Canonical.material(sealed.platform) ~= Canonical.material(value.platform) or sealed.hash ~= value.hash then error("project identity state hash mismatch") end
	return sealed
end

local function observe(root: any): any
	local project = canonicalProject(projectOf(root))
	local read, raw = pcall(function() return root:GetAttribute(Constants.PROJECT_IDENTITY_ATTRIBUTE) end)
	local attribute: any
	if not read then
		attribute = { status = "invalid", valueType = "read_error" }
	elseif raw == nil then
		attribute = { status = "absent" }
	elseif isProjectId(raw) then
		attribute = { status = "observed", forgeProjectId = raw }
	else
		attribute = { status = "invalid", valueType = typeof(raw) }
	end
	return sealState(project, attribute)
end

local function operationPayload(value: any): any
	return {
		kind = "StudioProjectIdentityOperation",
		action = value.action,
		project = canonicalProject(value.project),
		connectorEpoch = value.connectorEpoch,
		expectedIdentity = canonicalState(value.expectedIdentity),
		assignedForgeProjectId = value.assignedForgeProjectId,
	}
end

local function canonicalOperation(value: any): any
	if not exactKeys(value, { "kind", "id", "hash", "action", "project", "connectorEpoch", "expectedIdentity", "assignedForgeProjectId" })
		or value.kind ~= "StudioProjectIdentityOperation"
		or (value.action ~= "link" and value.action ~= "fork")
		or not isHash(value.connectorEpoch)
		or not isProjectId(value.assignedForgeProjectId)
		or not isHash(value.hash)
	then error("project identity operation is malformed") end
	local semantic = operationPayload(value)
	if not sameProject(semantic.project, semantic.expectedIdentity.project)
		or semantic.project.placeId ~= 0
		or semantic.project.universeId ~= 0
		or (semantic.action == "link" and semantic.expectedIdentity.reservedAttribute.status ~= "absent")
		or (semantic.action == "fork" and semantic.expectedIdentity.reservedAttribute.status ~= "observed")
		or (semantic.expectedIdentity.reservedAttribute.status == "observed" and semantic.expectedIdentity.reservedAttribute.forgeProjectId == semantic.assignedForgeProjectId)
	then error("project identity operation authority is invalid") end
	local hash = Hash.sha256(Canonical.material(semantic))
	if value.hash ~= hash or value.id ~= "studio_project_identity_operation_" .. string.sub(hash, 1, 24) then error("project identity operation hash mismatch") end
	semantic.id = value.id
	semantic.hash = hash
	return semantic
end

local function receiptPayload(value: any): any
	local payload: any = {
		kind = "StudioProjectIdentityFinalizationReceipt",
		operation = canonicalOperation(value.operation),
		action = value.action,
		beforeIdentity = canonicalState(value.beforeIdentity),
		afterIdentity = canonicalState(value.afterIdentity),
		finalization = value.finalization,
		status = value.status,
		completedAt = value.completedAt,
	}
	if value.recordingId ~= nil then payload.recordingId = value.recordingId end
	if value.failureDetail ~= nil then payload.failureDetail = value.failureDetail end
	return payload
end

local function canonicalReceipt(value: any): any
	if not exactKeys(value, { "kind", "id", "hash", "operation", "action", "beforeIdentity", "afterIdentity", "finalization", "status", "completedAt" }, { "recordingId", "failureDetail" })
		or value.kind ~= "StudioProjectIdentityFinalizationReceipt"
		or not isHash(value.hash)
		or not isIso(value.completedAt)
		or (value.failureDetail ~= nil and not isText(value.failureDetail, Constants.MAX_DIAGNOSTIC_CHARS))
		or (value.finalization ~= "ordinary" and value.finalization ~= "recovery_abandon" and value.finalization ~= "recovery_cancel" and value.finalization ~= "recovery_settle")
		or (value.finalization == "recovery_abandon" and value.recordingId ~= nil)
		or (value.finalization ~= "recovery_abandon" and not isIdentifier(value.recordingId, 512))
	then error("project identity receipt is malformed") end
	local semantic = receiptPayload(value)
	local operation = semantic.operation
	local successStatus = if operation.action == "link" then "linked" else "forked"
	local succeeded = semantic.status == successStatus
	if semantic.action ~= operation.action
		or Canonical.material(semantic.beforeIdentity) ~= Canonical.material(operation.expectedIdentity)
		or (semantic.status ~= "cancelled" and not succeeded)
		or ((semantic.finalization == "recovery_abandon" or semantic.finalization == "recovery_cancel") and semantic.status ~= "cancelled")
		or (semantic.status ~= "cancelled" and semantic.failureDetail ~= nil)
		or (semantic.status == "cancelled" and ((semantic.finalization == "ordinary" and semantic.failureDetail == nil) or ((semantic.finalization == "recovery_abandon" or semantic.finalization == "recovery_cancel") and semantic.failureDetail ~= nil)))
		or (semantic.status == "cancelled" and Canonical.material(semantic.afterIdentity) ~= Canonical.material(semantic.beforeIdentity))
		or (succeeded and (semantic.afterIdentity.reservedAttribute.status ~= "observed" or semantic.afterIdentity.reservedAttribute.forgeProjectId ~= operation.assignedForgeProjectId or not sameProject(semantic.afterIdentity.project, operation.project)))
	then error("project identity receipt semantics are invalid") end
	local hash = Hash.sha256(Canonical.material(semantic))
	if value.hash ~= hash or value.id ~= "studio_project_identity_receipt_" .. string.sub(hash, 1, 24) then error("project identity receipt hash mismatch") end
	semantic.id = value.id
	semantic.hash = hash
	return semantic
end

local function sealReceipt(value: any): any
	local semantic = receiptPayload(value)
	local hash = Hash.sha256(Canonical.material(semantic))
	semantic.id = "studio_project_identity_receipt_" .. string.sub(hash, 1, 24)
	semantic.hash = hash
	return canonicalReceipt(semantic)
end

local function cursorPayload(value: any): any
	local payload: any = {
		kind = "StudioProjectIdentityTransactionCursor",
		operation = canonicalOperation(value.operation),
		beforeIdentity = canonicalState(value.beforeIdentity),
		phase = value.phase,
	}
	if value.recordingId ~= nil then payload.recordingId = value.recordingId end
	if value.finalization ~= nil then payload.finalization = value.finalization end
	if value.failureDetail ~= nil then payload.failureDetail = value.failureDetail end
	return payload
end

local function sealCursor(value: any): any
	if not exactKeys(value, { "kind", "operation", "beforeIdentity", "phase" }, { "recordingId", "finalization", "failureDetail", "cursorHash" })
		or value.kind ~= "StudioProjectIdentityTransactionCursor"
		or (value.phase ~= "opening" and value.phase ~= "open" and value.phase ~= "finalizing")
		or (value.phase == "opening" and (value.recordingId ~= nil or value.finalization ~= nil or value.failureDetail ~= nil))
		or (value.phase == "open" and (not isIdentifier(value.recordingId, 512) or value.finalization ~= nil or value.failureDetail ~= nil))
		or (value.phase == "finalizing" and (not isIdentifier(value.recordingId, 512) or (value.finalization ~= "commit" and value.finalization ~= "cancel")))
		or (value.failureDetail ~= nil and (value.phase ~= "finalizing" or value.finalization ~= "cancel" or not isText(value.failureDetail, Constants.MAX_DIAGNOSTIC_CHARS)))
	then error("project identity transaction cursor is malformed") end
	local payload = cursorPayload(value)
	if Canonical.material(payload.beforeIdentity) ~= Canonical.material(payload.operation.expectedIdentity) then
		error("project identity transaction cursor does not continue its approved state")
	end
	local cursorHash = Hash.sha256(Canonical.material(payload))
	payload.cursorHash = cursorHash
	return payload
end

local function canonicalCursor(value: any): any
	if not isHash(value and value.cursorHash) then error("project identity cursor hash is malformed") end
	local sealed = sealCursor(value)
	if sealed.cursorHash ~= value.cursorHash then error("project identity cursor hash mismatch") end
	return sealed
end

local function settingValue(raw: any): any
	if raw == nil then return nil end
	if typeof(raw) ~= "table" then error("project identity setting is malformed") end
	if raw.kind == "StudioProjectIdentityTransactionCursor" then return canonicalCursor(raw) end
	if raw.kind == "StudioProjectIdentityFinalizationReceipt" then return canonicalReceipt(raw) end
	error("project identity setting kind is unsupported")
end

local function sameValue(left: any, right: any): boolean
	local leftOk, leftValue = pcall(settingValue, left)
	local rightOk, rightValue = pcall(settingValue, right)
	return leftOk and rightOk and Canonical.material(leftValue) == Canonical.material(rightValue)
end

local function persist(plugin: any, value: any?): any
	local snapshot = value
	if value ~= nil then
		if value.kind == "StudioProjectIdentityTransactionCursor" then snapshot = sealCursor(value)
		elseif value.kind == "StudioProjectIdentityFinalizationReceipt" then snapshot = canonicalReceipt(value)
		else error("project identity setting write kind is unsupported") end
		if #Canonical.material(snapshot) > MAXIMUM_SETTING_MATERIAL_BYTES then error("project identity setting exceeds its resource bound") end
	end
	plugin:SetSetting(TRANSACTION_SETTING, snapshot)
	local stored = plugin:GetSetting(TRANSACTION_SETTING)
	if snapshot == nil then
		if stored ~= nil then error("project identity setting clear readback failed") end
		return nil
	end
	if not sameValue(stored, snapshot) then error("project identity setting write/readback failed") end
	return settingValue(stored)
end

local function exactRecordingState(changeHistory: any, recordingId: any): string
	if not isIdentifier(recordingId, 512) then return "unknown" end
	local read, open = pcall(function() return changeHistory:IsRecordingInProgress(recordingId) end)
	if not read or typeof(open) ~= "boolean" then return "unknown" end
	return if open then "open" else "not_open"
end

-- An opening cursor deliberately has no recording id. The only authoritative
-- no-effect proof available at this boundary is that ChangeHistoryService says
-- no recording of any kind is in progress. A positive or failed read cannot be
-- attributed to this operation and therefore remains unknown.
local function openingRecordingState(changeHistory: any): string
	local read, open = pcall(function() return changeHistory:IsRecordingInProgress() end)
	if read and open == false then return "not_open" end
	return "unknown"
end

local function targetState(operation: any): any
	return sealState(operation.project, { status = "observed", forgeProjectId = operation.assignedForgeProjectId })
end

local function boundedFailureDetail(value: any): string
	local converted, raw = pcall(function() return tostring(value) end)
	local detail = if converted and typeof(raw) == "string" and raw ~= "" then raw else "Project identity mutation failed"
	if #detail <= Constants.MAX_DIAGNOSTIC_CHARS then
		local valid, length = pcall(function() return utf8.len(detail) end)
		if valid and length ~= nil then return detail end
		return "Project identity mutation failed"
	end
	local lastByte = Constants.MAX_DIAGNOSTIC_CHARS
	while lastByte > 0 do
		local candidate = string.sub(detail, 1, lastByte)
		local valid, length = pcall(function() return utf8.len(candidate) end)
		if valid and length ~= nil then return candidate end
		lastByte -= 1
	end
	return "Project identity mutation failed"
end

local function makeReceipt(operation: any, beforeIdentity: any, afterIdentity: any, recordingId: string?, finalization: string, status: string, completedAt: string, failureDetail: any?): any
	local value: any = {
		operation = operation,
		action = operation.action,
		beforeIdentity = beforeIdentity,
		afterIdentity = afterIdentity,
		finalization = finalization,
		status = status,
		completedAt = completedAt,
	}
	if recordingId ~= nil then value.recordingId = recordingId end
	if failureDetail ~= nil then value.failureDetail = boundedFailureDetail(failureDetail) end
	return sealReceipt(value)
end

local function monitorFact(monitor: any, root: any, beforeIdentity: any, afterIdentity: any)
	if monitor == nil then return end
	monitor:expectExactForgeMutationFact({
		source = "attribute",
		instance = root,
		field = Constants.PROJECT_IDENTITY_ATTRIBUTE,
		matchesBefore = function() return observe(root).hash == beforeIdentity.hash end,
		matchesAfter = function() return observe(root).hash == afterIdentity.hash end,
		beforeEventBudget = 1,
		afterEventBudget = 1,
	})
end

local function finishRecording(changeHistory: any, monitor: any, recordingId: string, operation: any): (boolean, any)
	if monitor then
		local registered, registrationFailure = pcall(function() monitor:expectExactForgeRecordingFinish(recordingId) end)
		if not registered then return false, "recording-finish monitor binding failed: " .. boundedFailureDetail(registrationFailure) end
	end
	local finished, failure = pcall(function() return changeHistory:FinishRecording(recordingId, operation) end)
	if not finished then
		if monitor then monitor:clearExpectedForgeRecordingFinish(recordingId) end
		return false, "FinishRecording failed: " .. tostring(failure)
	end
	local state = exactRecordingState(changeHistory, recordingId)
	if monitor then monitor:clearExpectedForgeRecordingFinish(recordingId) end
	if state ~= "not_open" then return false, "recording closure readback is " .. state end
	return true, nil
end

function StudioProjectIdentity.new(plugin: any, dependencies: any?)
	local selected = dependencies or {}
	return setmetatable({
		plugin = plugin,
		root = selected.root or game,
		changeHistory = selected.changeHistory or game:GetService("ChangeHistoryService"),
		monitor = selected.monitor,
		now = selected.now or function() return os.date("!%Y-%m-%dT%H:%M:%S.000Z") end,
		finishRecordingOperation = selected.finishRecordingOperation or Enum.FinishRecordingOperation,
	}, StudioProjectIdentity)
end

function StudioProjectIdentity:setChangeMonitor(monitor: any?)
	self.monitor = monitor
end

function StudioProjectIdentity:observe(): any
	return observe(self.root)
end

function StudioProjectIdentity:finalizationReceipt(): any?
	local stored = settingValue(self.plugin:GetSetting(TRANSACTION_SETTING))
	if stored and stored.kind == "StudioProjectIdentityFinalizationReceipt" then return stored end
	return nil
end

function StudioProjectIdentity:hasPossibleRecording(): boolean
	local stored = settingValue(self.plugin:GetSetting(TRANSACTION_SETTING))
	return stored ~= nil and stored.kind == "StudioProjectIdentityTransactionCursor"
end

function StudioProjectIdentity:inventory(): any
	local stored = settingValue(self.plugin:GetSetting(TRANSACTION_SETTING))
	if stored == nil then return { status = "none" } end
	if stored.kind == "StudioProjectIdentityFinalizationReceipt" then return { status = "finalized", receipt = stored } end
	local inventory: any = {
		status = "pending",
		operation = stored.operation,
		phase = stored.phase,
		cursorHash = stored.cursorHash,
		recordingState = if stored.phase == "opening" then openingRecordingState(self.changeHistory) else exactRecordingState(self.changeHistory, stored.recordingId),
	}
	if stored.recordingId ~= nil then inventory.recordingId = stored.recordingId end
	if stored.finalization ~= nil then inventory.finalization = stored.finalization end
	if stored.failureDetail ~= nil then inventory.failureDetail = stored.failureDetail end
	return inventory
end

-- A handler rejection is not itself a rollback/no-effect proof. Read the
-- current identity, durable cursor and recording state together, without
-- yielding or modifying Studio. The exact command settlement binds this
-- evidence to the rejected operation; failed reads remain explicitly unknown.
function StudioProjectIdentity:rejectionEvidence(operationValue: any): any
	local operation = canonicalOperation(operationValue)
	local observed, evidence = pcall(function()
		return {
			kind = "StudioProjectIdentityRejectionEvidence",
			operationId = operation.id,
			operationHash = operation.hash,
			status = "observed",
			identity = self:observe(),
			transaction = self:inventory(),
			recordingState = openingRecordingState(self.changeHistory),
		}
	end)
	if observed then return evidence end
	return {
		kind = "StudioProjectIdentityRejectionEvidence",
		operationId = operation.id,
		operationHash = operation.hash,
		status = "unavailable",
		detail = boundedFailureDetail(evidence),
	}
end

function StudioProjectIdentity:abandonOpening(payload: any, creatorRecordingClear: (() -> boolean)?): any
	if not exactKeys(payload, { "requestId", "operationId", "operationHash", "transactionCursorHash", "expectedIdentityStateHash" })
		or not isIdentifier(payload.requestId, 512)
		or not isIdentifier(payload.operationId, 512)
		or not isHash(payload.operationHash)
		or not isHash(payload.transactionCursorHash)
		or not isHash(payload.expectedIdentityStateHash)
	then error("opening project identity abandonment payload is malformed") end
	local stored = settingValue(self.plugin:GetSetting(TRANSACTION_SETTING))
	if stored == nil or stored.kind ~= "StudioProjectIdentityTransactionCursor" or stored.phase ~= "opening" then
		error("RECOVERY_REQUIRED: no opening project identity intent is recoverable")
	end
	if creatorRecordingClear == nil or creatorRecordingClear() ~= true then
		error("RECOVERY_REQUIRED: creator recording inventory is not clear for identity abandonment")
	end
	if payload.operationId ~= stored.operation.id
		or payload.operationHash ~= stored.operation.hash
		or payload.transactionCursorHash ~= stored.cursorHash
	then error("opening project identity abandonment binding mismatch") end
	local current = self:observe()
	if payload.expectedIdentityStateHash ~= current.hash
		or Canonical.material(current) ~= Canonical.material(stored.beforeIdentity)
	then error("opening project identity abandonment state is stale") end
	if openingRecordingState(self.changeHistory) ~= "not_open" then
		error("RECOVERY_REQUIRED: Studio does not prove the opening identity intent had no recording effect")
	end
	local receiptBuilt, receipt = pcall(function()
		return makeReceipt(stored.operation, stored.beforeIdentity, current, nil, "recovery_abandon", "cancelled", self.now(), nil)
	end)
	if not receiptBuilt then error("RECOVERY_REQUIRED: opening identity abandonment receipt construction failed: " .. boundedFailureDetail(receipt)) end
	local receiptPersisted, receiptFailure = pcall(function() persist(self.plugin, receipt) end)
	if not receiptPersisted then error("RECOVERY_REQUIRED: opening identity abandonment receipt persistence failed: " .. boundedFailureDetail(receiptFailure)) end
	return receipt
end

function StudioProjectIdentity:execute(operationValue: any, connectorEpoch: string, creatorRecordingClear: (() -> boolean)?): any
	local operation = canonicalOperation(operationValue)
	if operation.connectorEpoch ~= connectorEpoch then error("project identity operation connector epoch mismatch") end
	if creatorRecordingClear == nil or creatorRecordingClear() ~= true then error("RECOVERY_REQUIRED: creator recording inventory is not clear for project identity mutation") end
	if self.plugin:GetSetting(TRANSACTION_SETTING) ~= nil then error("RECOVERY_REQUIRED: a project identity transaction or receipt already exists") end
	local anyOpenRead, anyOpen = pcall(function() return self.changeHistory:IsRecordingInProgress() end)
	if not anyOpenRead or anyOpen ~= false then error("RECOVERY_REQUIRED: Studio recording inventory is not clear for project identity mutation") end
	local before = self:observe()
	if Canonical.material(before) ~= Canonical.material(operation.expectedIdentity) then error("project identity operation expected state is stale") end
	local after = targetState(operation)
	persist(self.plugin, { kind = "StudioProjectIdentityTransactionCursor", operation = operation, beforeIdentity = before, phase = "opening" })
	local began, recording = pcall(function() return self.changeHistory:TryBeginRecording("Forge project identity " .. operation.id) end)
	if not began or not isIdentifier(recording, 512) then error("RECOVERY_REQUIRED: project identity recording open outcome is unknown") end
	local openPersisted, openCursor = pcall(function()
		return persist(self.plugin, { kind = "StudioProjectIdentityTransactionCursor", operation = operation, beforeIdentity = before, phase = "open", recordingId = recording })
	end)
	if not openPersisted then error("RECOVERY_REQUIRED: project identity recording cursor persistence failed: " .. boundedFailureDetail(openCursor)) end
	local monitorBound, monitorFailure = pcall(function() monitorFact(self.monitor, self.root, before, after) end)
	if not monitorBound then error("RECOVERY_REQUIRED: project identity monitor binding failed: " .. boundedFailureDetail(monitorFailure)) end
	local wrote, failure = pcall(function()
		self.root:SetAttribute(Constants.PROJECT_IDENTITY_ATTRIBUTE, operation.assignedForgeProjectId)
		local observed = self:observe()
		if Canonical.material(observed) ~= Canonical.material(after) then error("project identity direct readback mismatch") end
	end)
	local finalization = if wrote then "commit" else "cancel"
	local finalizationPersisted, finalizing = pcall(function()
		local cursor: any = { kind = "StudioProjectIdentityTransactionCursor", operation = operation, beforeIdentity = before, phase = "finalizing", recordingId = openCursor.recordingId, finalization = finalization }
		if not wrote then cursor.failureDetail = boundedFailureDetail(failure) end
		return persist(self.plugin, cursor)
	end)
	if not finalizationPersisted then error("RECOVERY_REQUIRED: project identity finalization intent persistence failed: " .. boundedFailureDetail(finalizing)) end
	if not wrote and self.monitor then self.monitor:setExactForgeMutationPhase("before") end
	local closed, closeFailure = finishRecording(self.changeHistory, self.monitor, finalizing.recordingId, if wrote then self.finishRecordingOperation.Commit else self.finishRecordingOperation.Cancel)
	if not closed then error("RECOVERY_REQUIRED: project identity finalization is uncertain: " .. tostring(closeFailure)) end
	local observed = self:observe()
	local expected = if wrote then after else before
	if Canonical.material(observed) ~= Canonical.material(expected) then error("RECOVERY_REQUIRED: project identity final state readback mismatch") end
	local status = if wrote then (if operation.action == "link" then "linked" else "forked") else "cancelled"
	local receiptBuilt, receipt = pcall(function()
		return makeReceipt(operation, before, observed, recording, "ordinary", status, self.now(), if wrote then nil else failure)
	end)
	if not receiptBuilt then error("RECOVERY_REQUIRED: project identity terminal receipt construction failed: " .. boundedFailureDetail(receipt)) end
	local receiptPersisted, receiptFailure = pcall(function() persist(self.plugin, receipt) end)
	if not receiptPersisted then error("RECOVERY_REQUIRED: project identity terminal receipt persistence failed: " .. boundedFailureDetail(receiptFailure)) end
	if self.monitor then self.monitor:clearExactForgeMutationFacts() end
	return receipt
end

function StudioProjectIdentity:cancelInterrupted(payload: any, creatorRecordingClear: (() -> boolean)?): any
	if not exactKeys(payload, { "requestId", "operationId", "operationHash", "transactionCursorHash", "recordingId", "expectedIdentityStateHash" })
		or not isIdentifier(payload.requestId, 512)
		or not isIdentifier(payload.operationId, 512)
		or not isHash(payload.operationHash)
		or not isHash(payload.transactionCursorHash)
		or not isIdentifier(payload.recordingId, 512)
		or not isHash(payload.expectedIdentityStateHash)
	then error("project identity recovery payload is malformed") end
	local stored = settingValue(self.plugin:GetSetting(TRANSACTION_SETTING))
	if stored == nil or stored.kind ~= "StudioProjectIdentityTransactionCursor" or stored.phase == "opening" then error("RECOVERY_REQUIRED: no exactly identified project identity recording is recoverable") end
	if creatorRecordingClear == nil or creatorRecordingClear() ~= true then error("RECOVERY_REQUIRED: creator recording inventory is not clear for identity recovery") end
	if payload.operationId ~= stored.operation.id or payload.operationHash ~= stored.operation.hash or payload.transactionCursorHash ~= stored.cursorHash or payload.recordingId ~= stored.recordingId then error("project identity recovery binding mismatch") end
	local current = self:observe()
	if payload.expectedIdentityStateHash ~= current.hash then error("project identity recovery state is stale") end
	if exactRecordingState(self.changeHistory, stored.recordingId) ~= "open" then error("RECOVERY_REQUIRED: exact project identity recording is not proven open") end
	local after = targetState(stored.operation)
	if self.monitor then self.monitor:clearExactForgeMutationFacts() end
	local monitorBound, monitorFailure = pcall(function() monitorFact(self.monitor, self.root, stored.beforeIdentity, after) end)
	if not monitorBound then error("RECOVERY_REQUIRED: project identity recovery monitor binding failed: " .. boundedFailureDetail(monitorFailure)) end
	if self.monitor then self.monitor:setExactForgeMutationPhase("before") end
	local finalizationPersisted, finalizing = pcall(function()
		return persist(self.plugin, { kind = "StudioProjectIdentityTransactionCursor", operation = stored.operation, beforeIdentity = stored.beforeIdentity, phase = "finalizing", recordingId = stored.recordingId, finalization = "cancel" })
	end)
	if not finalizationPersisted then error("RECOVERY_REQUIRED: project identity recovery intent persistence failed: " .. boundedFailureDetail(finalizing)) end
	local closed, failure = finishRecording(self.changeHistory, self.monitor, finalizing.recordingId, self.finishRecordingOperation.Cancel)
	if not closed then error("RECOVERY_REQUIRED: project identity recovery cancellation is uncertain: " .. tostring(failure)) end
	local observed = self:observe()
	if Canonical.material(observed) ~= Canonical.material(stored.beforeIdentity) then error("RECOVERY_REQUIRED: project identity recovery cancellation readback mismatch") end
	local receiptBuilt, receipt = pcall(function()
		return makeReceipt(stored.operation, stored.beforeIdentity, observed, stored.recordingId, "recovery_cancel", "cancelled", self.now(), nil)
	end)
	if not receiptBuilt then error("RECOVERY_REQUIRED: project identity recovery receipt construction failed: " .. boundedFailureDetail(receipt)) end
	local receiptPersisted, receiptFailure = pcall(function() persist(self.plugin, receipt) end)
	if not receiptPersisted then error("RECOVERY_REQUIRED: project identity recovery receipt persistence failed: " .. boundedFailureDetail(receiptFailure)) end
	if self.monitor then self.monitor:clearExactForgeMutationFacts() end
	return receipt
end

function StudioProjectIdentity:settleClosed(payload: any, creatorRecordingClear: (() -> boolean)?): any
	if not exactKeys(payload, { "requestId", "operationId", "operationHash", "transactionCursorHash", "recordingId", "expectedIdentityStateHash", "expectedFinalization" })
		or not isIdentifier(payload.requestId, 512)
		or not isIdentifier(payload.operationId, 512)
		or not isHash(payload.operationHash)
		or not isHash(payload.transactionCursorHash)
		or not isIdentifier(payload.recordingId, 512)
		or not isHash(payload.expectedIdentityStateHash)
		or (payload.expectedFinalization ~= "commit" and payload.expectedFinalization ~= "cancel")
	then error("closed project identity settlement payload is malformed") end
	local stored = settingValue(self.plugin:GetSetting(TRANSACTION_SETTING))
	if stored == nil or stored.kind ~= "StudioProjectIdentityTransactionCursor" or stored.phase ~= "finalizing" then
		error("RECOVERY_REQUIRED: no closed project identity finalization is recoverable")
	end
	if creatorRecordingClear == nil or creatorRecordingClear() ~= true then
		error("RECOVERY_REQUIRED: creator recording inventory is not clear for identity settlement")
	end
	if payload.operationId ~= stored.operation.id
		or payload.operationHash ~= stored.operation.hash
		or payload.transactionCursorHash ~= stored.cursorHash
		or payload.recordingId ~= stored.recordingId
		or payload.expectedFinalization ~= stored.finalization
	then error("closed project identity settlement binding mismatch") end
	if exactRecordingState(self.changeHistory, stored.recordingId) ~= "not_open" then
		error("RECOVERY_REQUIRED: exact project identity recording is not proven closed")
	end
	local current = self:observe()
	if payload.expectedIdentityStateHash ~= current.hash then error("closed project identity settlement state is stale") end
	local expected = if stored.finalization == "commit" then targetState(stored.operation) else stored.beforeIdentity
	if Canonical.material(current) ~= Canonical.material(expected) then
		error("RECOVERY_REQUIRED: closed project identity final state does not match its durable intent")
	end
	local status = if stored.finalization == "commit" then (if stored.operation.action == "link" then "linked" else "forked") else "cancelled"
	local receiptBuilt, receipt = pcall(function()
		return makeReceipt(stored.operation, stored.beforeIdentity, current, stored.recordingId, "recovery_settle", status, self.now(), stored.failureDetail)
	end)
	if not receiptBuilt then error("RECOVERY_REQUIRED: closed project identity receipt construction failed: " .. boundedFailureDetail(receipt)) end
	local receiptPersisted, receiptFailure = pcall(function() persist(self.plugin, receipt) end)
	if not receiptPersisted then error("RECOVERY_REQUIRED: closed project identity receipt persistence failed: " .. boundedFailureDetail(receiptFailure)) end
	if self.monitor then self.monitor:clearExactForgeMutationFacts() end
	return receipt
end

function StudioProjectIdentity:acknowledge(payload: any): any
	if not exactKeys(payload, { "requestId", "receiptId", "receiptHash" })
		or not isIdentifier(payload.requestId, 512)
		or not isIdentifier(payload.receiptId, 512)
		or not isHash(payload.receiptHash)
	then error("project identity finalization acknowledgement is malformed") end
	local receipt = self:finalizationReceipt()
	if receipt == nil or payload.receiptId ~= receipt.id or payload.receiptHash ~= receipt.hash then error("project identity finalization acknowledgement mismatch") end
	persist(self.plugin, nil)
	return receipt
end

function StudioProjectIdentity.observeForTest(root: any): any return observe(root) end
function StudioProjectIdentity.canonicalOperationForTest(value: any): any return canonicalOperation(value) end
function StudioProjectIdentity.canonicalReceiptForTest(value: any): any return canonicalReceipt(value) end
function StudioProjectIdentity.boundedFailureDetailForTest(value: any): string return boundedFailureDetail(value) end
function StudioProjectIdentity.settingKeyForTest(): string return TRANSACTION_SETTING end

return StudioProjectIdentity
