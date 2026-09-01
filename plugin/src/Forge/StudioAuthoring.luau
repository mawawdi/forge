--!strict
-- Applies a sealed CreatorChangeSet only as a provisional ChangeHistory
-- transaction. Capability dispatch, values and codecs all come from the
-- generated manifest; this module owns only the transaction boundary.
local StudioAuthoring = {}
StudioAuthoring.__index = StudioAuthoring

local Generated = if script ~= nil then require(script.Parent.GeneratedStudioEvidence) else require("./GeneratedStudioEvidence")

local function changeHistoryService() return game:GetService("ChangeHistoryService") end
local function httpService() return game:GetService("HttpService") end
local function sha256(value: string): string
	local Hash = if script ~= nil then require(script.Parent.Hash) else require("./Hash")
	return Hash.sha256(value)
end

local function pathOf(instance: Instance): string
	local parts = {}
	local cursor: Instance? = instance
	while cursor and cursor ~= game do table.insert(parts, 1, cursor.Name); cursor = cursor.Parent end
	return table.concat(parts, "/")
end

local function resolvePath(path: any): Instance?
	if typeof(path) ~= "string" or path == "" or string.sub(path, 1, 1) == "/" or string.sub(path, -1) == "/" or not Generated.isAllowedRoot(path) then return nil end
	local pieces = string.split(path, "/")
	local current: Instance? = game:FindFirstChild(pieces[1])
	for index = 2, #pieces do
		local name = pieces[index]
		if not current or name == "" or name == "." or name == ".." then return nil end
		current = current:FindFirstChild(name)
	end
	return current
end

local function validName(value: any)
	if typeof(value) ~= "string" or value == "" or #value > 100 or string.find(value, "/", 1, true) or value == "." or value == ".." then error("invalid instance name") end
end

local function classForOperation(operation: any): string
	if operation.kind == "create" then return operation.className end
	return operation.expectedClass
end

local function referenceResolver(registry, reference: any): Instance
	if typeof(reference) ~= "table" then error("Instance reference is malformed") end
	local instance = registry:find(reference.stableId)
	if not instance or pathOf(instance) ~= reference.path or instance.ClassName ~= reference.className then error("Instance reference precondition mismatch") end
	return instance
end

local function validateProperties(className: string, properties: any, registry, requireStudioPreflight: boolean?)
	if typeof(properties) ~= "table" then error("properties must be a table") end
	for name, value in pairs(properties) do
		if typeof(name) ~= "string" then error("property name must be a string") end
		local metadata = Generated.propertyMetadata(className, name)
		if not metadata then error("property is not writable in the generated manifest: " .. name) end
		if requireStudioPreflight == false then
			-- Module tests run without Roblox datatype constructors. Production
			-- preflight always takes the conversion route below.
			Generated.validateValue(metadata.codec, value, metadata)
		else
			-- Conversion is a side-effect-free preflight for every supported codec.
			-- In particular, stable Instance references resolve against the same
			-- identity/path/class binding that the subsequent write uses.
			Generated.toStudio(metadata.codec, value, metadata, function(reference) return referenceResolver(registry, reference) end)
		end
	end
end

local function applyProperties(instance: Instance, className: string, properties: any, registry)
	for name, value in pairs(properties) do
		local metadata = Generated.propertyMetadata(className, name)
		if not metadata then error("property is not writable in the generated manifest: " .. tostring(name)) end
		Generated.write(instance, name, value, function(reference) return referenceResolver(registry, reference) end)
	end
end

local function applyAttributes(instance: Instance, attributes: any, removed: any?)
	local canonical = Generated.validateAttributes(attributes)
	for name, value in pairs(canonical) do instance:SetAttribute(name, value) end
	for _, name in ipairs(removed or {}) do instance:SetAttribute(name, nil) end
end

local function validateRemovedAttributes(removed: any, attributes: any)
	if typeof(removed) ~= "table" or #removed > Generated.manifest.attributes.maximumCount then error("removed attributes must be a bounded sequence") end
	local seen = {}
	for _, name in ipairs(removed) do
		if typeof(name) ~= "string" or seen[name] or attributes[name] ~= nil then error("removed attribute is invalid, repeated, or also set") end
		seen[name] = true
	end
end

local function validateExisting(operation: any, registry): Instance
	if typeof(operation.stableId) ~= "string" or typeof(operation.expectedPath) ~= "string" or typeof(operation.expectedClass) ~= "string" then error("existing operation target is malformed") end
	local instance = registry:find(operation.stableId)
	if not instance or pathOf(instance) ~= operation.expectedPath or instance.ClassName ~= operation.expectedClass or not Generated.classMetadata(instance.ClassName) then error("existing target precondition mismatch") end
	return instance
end

local function validateOperation(operation: any, registry)
	if typeof(operation) ~= "table" or typeof(operation.id) ~= "string" or operation.id == "" or typeof(operation.kind) ~= "string" then error("invalid creator operation") end
	if operation.kind == "create" then
		if typeof(operation.tempId) ~= "string" or operation.tempId == "" or typeof(operation.className) ~= "string" then error("invalid create operation") end
		local metadata = Generated.classMetadata(operation.className)
		if not metadata or metadata.creatable ~= true then error("create class is not in the generated manifest") end
		validName(operation.name)
		local parent = resolvePath(operation.parentPath)
		if not parent or parent:FindFirstChild(operation.name) then error("create parent is missing, forbidden, or collides") end
		validateProperties(operation.className, operation.properties, registry)
		Generated.validateAttributes(operation.attributes)
		Generated.validateSource(operation.source, metadata.source ~= "forbidden")
	elseif operation.kind == "update" then
		validateProperties(classForOperation(operation), operation.properties, registry); Generated.validateAttributes(operation.attributes); validateRemovedAttributes(operation.removedAttributes, operation.attributes); validateExisting(operation, registry)
	elseif operation.kind == "move" then
		local instance = validateExisting(operation, registry); validName(operation.name)
		local parent = resolvePath(operation.parentPath)
		if not parent then error("move parent is missing or forbidden") end
		local collision = parent:FindFirstChild(operation.name)
		if collision and collision ~= instance then error("move target collides") end
		validateProperties(classForOperation(operation), operation.properties, registry); Generated.validateAttributes(operation.attributes); validateRemovedAttributes(operation.removedAttributes, operation.attributes)
	elseif operation.kind == "delete" then
		local instance = validateExisting(operation, registry)
		local descendants = instance:GetDescendants()
		if #descendants > Generated.manifest.attributes.maximumCount then error("delete subtree exceeds generated evidence bound") end
		for _, descendant in ipairs(descendants) do if not Generated.classMetadata(descendant.ClassName) then error("delete subtree has an unmanifested descendant") end end
	elseif operation.kind == "write_source" then
		local instance = validateExisting(operation, registry)
		local metadata = Generated.classMetadata(instance.ClassName)
		if not metadata or metadata.source == "forbidden" or not instance:IsA("LuaSourceContainer") then error("source capability is not in the generated manifest") end
		Generated.validateSource(operation.source, true); Generated.validateAttributes(operation.attributes); validateRemovedAttributes(operation.removedAttributes, operation.attributes)
		if typeof(operation.beforeSourceHash) ~= "string" or sha256(instance.Source) ~= operation.beforeSourceHash then error("source precondition mismatch") end
	else
		error("operation kind is not in the generated manifest")
	end
end

local function applyOperation(operation: any, registry, createdStableId: string?)
	if operation.kind == "create" then
		local instance = Instance.new(operation.className)
		instance.Name = operation.name
		applyProperties(instance, operation.className, operation.properties, registry)
		applyAttributes(instance, operation.attributes)
		if Generated.classMetadata(operation.className).source ~= "forbidden" then instance.Source = operation.source end
		local parent = resolvePath(operation.parentPath)
		if not parent then instance:Destroy(); error("create parent changed after approved precondition") end
		instance.Parent = parent
		if not registry:enrollInstance(instance, createdStableId) then error("created instance is outside the generated identity scope") end
	elseif operation.kind == "update" then
		local instance = validateExisting(operation, registry)
		applyProperties(instance, operation.expectedClass, operation.properties, registry); applyAttributes(instance, operation.attributes, operation.removedAttributes)
	elseif operation.kind == "move" then
		local instance = validateExisting(operation, registry)
		local parent = resolvePath(operation.parentPath)
		if not parent then error("move parent changed after approved precondition") end
		applyProperties(instance, operation.expectedClass, operation.properties, registry); applyAttributes(instance, operation.attributes, operation.removedAttributes); instance.Name = operation.name; instance.Parent = parent
	elseif operation.kind == "delete" then
		validateExisting(operation, registry):Destroy()
	elseif operation.kind == "write_source" then
		local instance = validateExisting(operation, registry)
		applyAttributes(instance, operation.attributes, operation.removedAttributes); instance.Source = operation.source
	end
end

-- Plugin settings are a JSON persistence boundary, not an in-memory table
-- store. Roblox documents both restricted setting keys and silent write
-- failure, so transaction keys contain no punctuation and every phase change
-- is written as a fresh immutable snapshot and read back before Studio may
-- cross the next mutation boundary.
local ACTIVE_RECORDING_SETTING = "ForgeCreatorActiveRecordingV3"
local FINALIZATION_RECEIPT_SETTING = "ForgeCreatorFinalizationReceiptV3"
local LAST_COMMIT_SETTING = "ForgeCreatorLastCommitV3"

local function settingSnapshot(value: any, seen: any?): any
	local valueType = typeof(value)
	if valueType == "nil" or valueType == "boolean" or valueType == "number" or valueType == "string" then return value end
	if valueType ~= "table" then error("creator transaction setting contains a non-JSON value") end
	local visited = seen or {}
	if visited[value] then error("creator transaction setting contains a cycle") end
	visited[value] = true
	local copy = {}
	for key, item in pairs(value) do
		local keyType = typeof(key)
		if keyType ~= "string" and keyType ~= "number" then error("creator transaction setting contains an invalid key") end
		copy[key] = settingSnapshot(item, visited)
	end
	visited[value] = nil
	return copy
end

local function sameOptionalFlag(left: any, right: any, field: string): boolean
	return (left[field] == true) == (right[field] == true)
end

local function sameRecordingBinding(left: any, right: any): boolean
	return typeof(left) == "table" and typeof(right) == "table"
		and left.creatorSessionId == right.creatorSessionId
		and left.changeSetId == right.changeSetId
		and left.changeSetHash == right.changeSetHash
		and left.projectionId == right.projectionId
		and left.projectionHash == right.projectionHash
		and left.manifestHash == right.manifestHash
		and left.beforeRevisionHash == right.beforeRevisionHash
		and left.recordingId == right.recordingId
end

local function sameActiveCursor(left: any, right: any): boolean
	if not sameRecordingBinding(left, right)
		or left.preflightHash ~= right.preflightHash
		or not sameOptionalFlag(left, right, "opening")
	then return false end
	if typeof(right.beforeStateProjection) == "table" then
		if typeof(left.beforeStateProjection) ~= "table"
			or left.beforeStateProjection.contentHash ~= right.beforeStateProjection.contentHash
		then return false end
	end
	if typeof(right.finalization) == "table" then
		if typeof(left.finalization) ~= "table"
			or left.finalization.action ~= right.finalization.action
			or not sameOptionalFlag(left.finalization, right.finalization, "failedApply")
			or not sameOptionalFlag(left.finalization, right.finalization, "recovery")
			or left.finalization.failureCode ~= right.finalization.failureCode
		then return false end
	elseif left.finalization ~= nil then return false end
	if right.recoveryEvidenceHash ~= nil and left.recoveryEvidenceHash ~= right.recoveryEvidenceHash then return false end
	if typeof(right.provisional) == "table" then
		return typeof(left.provisional) == "table"
			and left.provisional.directReadbackEvidenceHash == right.provisional.directReadbackEvidenceHash
			and left.provisional.postApplyStateEvidenceHash == right.provisional.postApplyStateEvidenceHash
			and left.provisional.postApplyRevisionHash == right.provisional.postApplyRevisionHash
	end
	return left.provisional == nil
end

local function persistSetting(plugin: Plugin, key: string, value: any?, validator: ((any, any) -> boolean)?, label: string): any
	local snapshot = value == nil and nil or settingSnapshot(value)
	plugin:SetSetting(key, snapshot)
	local stored = plugin:GetSetting(key)
	if snapshot == nil then
		if stored ~= nil then error(label .. " setting clear verification failed") end
		return nil
	end
	if typeof(stored) ~= "table" or not validator or not validator(stored, snapshot) then
		error(label .. " setting write/read verification failed")
	end
	return stored
end

local function activeSetting(plugin: Plugin): any return plugin:GetSetting(ACTIVE_RECORDING_SETTING) end
local function setActive(plugin: Plugin, active: any?): any return persistSetting(plugin, ACTIVE_RECORDING_SETTING, active, sameActiveCursor, "active recording") end
local function finalizationReceipt(plugin: Plugin): any return plugin:GetSetting(FINALIZATION_RECEIPT_SETTING) end

local function sameFinalizationReceipt(left: any, right: any): boolean
	return sameRecordingBinding(left, right)
		and left.kind == right.kind
		and left.action == right.action
		and left.status == right.status
		and typeof(left.afterRevision) == "table" and typeof(right.afterRevision) == "table"
		and left.afterRevision.stateHash == right.afterRevision.stateHash
		and typeof(left.postFinalizeStateProjection) == "table" and typeof(right.postFinalizeStateProjection) == "table"
		and left.postFinalizeStateProjection.contentHash == right.postFinalizeStateProjection.contentHash
		and typeof(left.postFinalizeStateEvidence) == "table" and typeof(right.postFinalizeStateEvidence) == "table"
		and left.postFinalizeStateEvidence.contentHash == right.postFinalizeStateEvidence.contentHash
end

local function setFinalizationReceipt(plugin: Plugin, receipt: any?): any
	return persistSetting(plugin, FINALIZATION_RECEIPT_SETTING, receipt, sameFinalizationReceipt, "finalization receipt")
end

local function setLastCommit(plugin: Plugin, receipt: any?): any
	return persistSetting(plugin, LAST_COMMIT_SETTING, receipt, sameFinalizationReceipt, "last commit")
end

local function decodedSealed(payload: any, field: string, hashField: string, expectedKind: string): any
	if typeof(payload[field]) ~= "string" or typeof(payload[hashField]) ~= "string" or sha256(payload[field]) ~= payload[hashField] then error(field .. " transport binding mismatch") end
	local ok, value = pcall(function() return httpService():JSONDecode(payload[field]) end)
	if not ok or typeof(value) ~= "table" or value.kind ~= expectedKind then error(field .. " is malformed") end
	return value
end

local function exactProjectionBinding(projection: any, payload: any, changeSet: any, revision: string, collector): boolean
	if typeof(projection) ~= "table" or typeof(projection.binding) ~= "table" or typeof(projection.project) ~= "table" then return false end
	local binding = projection.binding
	local project = collector:identity()
	return typeof(binding) == "table"
		and projection.manifestHash == Generated.manifestHash
		and projection.project.name == project.name and projection.project.placeId == project.placeId and projection.project.universeId == project.universeId
		and binding.sessionId == payload.creatorSessionId
		and binding.changeSetHash == changeSet.hash and changeSet.hash == payload.changeSetHash
		and binding.approvalHash == payload.approvalHash
		and binding.revisionHash == revision and revision == payload.expectedRevision
		and binding.buildHash == changeSet.buildContractHash
		and binding.dashboardReviewHash == payload.dashboardReviewHash
end

function StudioAuthoring.new(plugin: Plugin, registry, collector)
	return setmetatable({ plugin = plugin, registry = registry, collector = collector, prepared = nil, active = nil, lastFailure = nil }, StudioAuthoring)
end

function StudioAuthoring:hasPossibleRecording(): boolean
	return self.active ~= nil or typeof(activeSetting(self.plugin)) == "table"
end

function StudioAuthoring:recovery()
	local active = activeSetting(self.plugin)
	if typeof(active) ~= "table" then return { recordingState = "not_open" } end
	-- A process may stop after the durable opening intent but before
	-- TryBeginRecording returns its opaque recording id.  Forge cannot prove
	-- that no recording opened, so this is deliberately recovery-required and
	-- never triggers an automatic Studio operation.
	if active.opening == true then return { recordingState = "unknown", recording = active } end
	if typeof(active.recordingId) ~= "string" then return { recordingState = "unknown", recording = active } end
	local ok, open = pcall(function() return changeHistoryService():IsRecordingInProgress(active.recordingId) end)
	return { recordingState = ok and (open and "open" or "not_open") or "unknown", recording = active }
end

function StudioAuthoring:recordRecoveryEvidence(evidenceHash: string)
	local active = activeSetting(self.plugin)
	if typeof(active) ~= "table" or typeof(evidenceHash) ~= "string" then error("recording recovery evidence binding rejected") end
	local updated = table.clone(active)
	updated.recoveryEvidenceHash = evidenceHash
	local persisted = setActive(self.plugin, updated)
	if self.active then self.active.binding = persisted end
end

local function acknowledgeClosedRecording(plugin: Plugin, payload: any, recordingState: string): any
	local stored = activeSetting(plugin)
	if recordingState ~= "not_open"
		or typeof(payload) ~= "table"
		or typeof(stored) ~= "table"
		or not sameRecordingBinding(payload, stored)
		or typeof(stored.beforeStateProjection) ~= "table"
		or payload.recoveryProjectionHash ~= stored.beforeStateProjection.contentHash
		or payload.recoveryEvidenceHash ~= stored.recoveryEvidenceHash
	then error("closed-recording acknowledgement binding rejected") end
	setActive(plugin, nil)
	return stored
end

-- This acknowledgement clears only Forge's durable transaction cursor after
-- Studio has directly proved the exact opaque recording id is not open and the
-- coordinator has durably persisted the bound recovery projection/envelope.
-- It never calls ChangeHistoryService:FinishRecording or changes the place.
function StudioAuthoring:acknowledgeClosedRecording(payload: any)
	local recovery = self:recovery()
	local stored = acknowledgeClosedRecording(self.plugin, payload, recovery.recordingState)
	self.active = nil
	return stored
end

function StudioAuthoring:failure()
	return self.lastFailure
end

-- A receipt is not an open recording and therefore does not make creator
-- actions illegal.  It is retained independently until the backend confirms
-- durable persistence of this exact finalization message.
function StudioAuthoring:finalizationReceipt()
	local receipt = finalizationReceipt(self.plugin)
	return typeof(receipt) == "table" and receipt or nil
end

function StudioAuthoring:hasPendingFinalizationReceipt(): boolean
	return self:finalizationReceipt() ~= nil
end

-- The recording stays locally bound until the coordinator has received both
-- immutable provisional envelopes. Plugin settings retain their exact hashes,
-- while the bounded evidence bodies are sent to the coordinator's immutable
-- artifact store. A transport interruption remains recovery-required and is
-- never mistaken for rollback or matched evidence.
function StudioAuthoring:recordProvisionalEvidence(active: any, direct: any, post: any)
	if self.active ~= active or typeof(direct) ~= "table" or typeof(post) ~= "table" then error("provisional evidence binding rejected") end
	local stored = activeSetting(self.plugin)
	if typeof(stored) ~= "table" then error("active recording cursor is unavailable before provisional persistence") end
	if not sameRecordingBinding(stored, active.binding) then error("active recording cursor changed before provisional persistence") end
	if typeof(direct.contentHash) ~= "string" then error("direct readback evidence has no content hash") end
	if typeof(post.envelope) ~= "table" or typeof(post.envelope.contentHash) ~= "string" then error("post-apply state evidence has no content hash") end
	if typeof(post.revision) ~= "table" or typeof(post.revision.stateHash) ~= "string" then error("post-apply state evidence has no complete revision") end
	local updated = table.clone(stored)
	updated.provisional = {
		directReadbackEvidenceHash = direct.contentHash,
		postApplyStateEvidenceHash = post.envelope.contentHash,
		postApplyRevisionHash = post.revision.stateHash,
	}
	active.binding = setActive(self.plugin, updated)
end

-- Prepare is pure with respect to Studio: it checks exact payload/projection
-- bindings and reconstructs the mutation projection before consent proceeds.
function StudioAuthoring:prepare(payload: any, currentRevision: string, beforeProjection: any, beforeEnvelope: any)
	if self:hasPossibleRecording() then error("RECOVERY_REQUIRED: a recording may already be open") end
	-- A settled receipt does not make Studio recording state ambiguous, so it is
	-- deliberately excluded from hasPossibleRecording.  It still prevents a new
	-- transaction until the coordinator has durably recorded and acknowledged
	-- the exact prior finalization; otherwise two finalizations could contend for
	-- the single receipt slot after a transport interruption.
	if self:hasPendingFinalizationReceipt() then error("creator prepare requires acknowledgement of the prior finalization receipt") end
	if typeof(payload) ~= "table" or payload.expectedRevision ~= currentRevision or payload.manifestHash ~= Generated.manifestHash then error("creator prepare binding mismatch") end
	local changeSet = decodedSealed(payload, "changeSetJson", "changeSetJsonHash", "CreatorChangeSet")
	local projection = decodedSealed(payload, "projectionJson", "projectionJsonHash", "StudioEvidenceProjection")
	local preflightProjection = decodedSealed(payload, "preflightProjectionJson", "preflightProjectionJsonHash", "StudioEvidenceProjection")
	Generated.validateProjection(projection)
	Generated.validateProjection(preflightProjection)
	if projection.contentHash ~= payload.projectionHash or preflightProjection.contentHash ~= payload.preflightProjectionHash then error("creator projection semantic hash mismatch") end
	if projection.manifestHash ~= Generated.manifestHash or projection.purpose ~= "mutation_direct_readback" or preflightProjection.purpose ~= "mutation_preflight" then error("mutation projection manifest or purpose mismatch") end
	if changeSet.id ~= payload.changeSetId or changeSet.hash ~= payload.changeSetHash or changeSet.sessionId ~= payload.creatorSessionId or changeSet.expectedRevisionHash ~= currentRevision or changeSet.localGate.status ~= "eligible" or typeof(changeSet.operations) ~= "table" or #changeSet.operations < 1 or #changeSet.operations > Generated.manifest.limits.maximumOperations then error("creator change set rejected") end
	if not exactProjectionBinding(projection, payload, changeSet, currentRevision, self.collector) or not exactProjectionBinding(preflightProjection, payload, changeSet, currentRevision, self.collector) then error("creator projection binding mismatch") end
	-- Recompile from the sealed change set using generated manifest dispatch and
	-- require exact material/hash equality.  Validation alone is insufficient:
	-- a syntactically valid projection must not omit, add, or retarget proof
	-- obligations before Apply.
	Generated.assertRecompiledMutationProjection(changeSet, projection, beforeProjection, beforeEnvelope)
	Generated.assertRecompiledMutationProjection(changeSet, preflightProjection, beforeProjection, beforeEnvelope)
	local operationIds, planChangeIds, targetIds, createPaths = {}, {}, {}, {}
	for _, operation in ipairs(changeSet.operations) do
		if operationIds[operation.id] or typeof(operation.planChangeId) ~= "string" or planChangeIds[operation.planChangeId] then error("operation identity binding is not unique") end
		operationIds[operation.id] = true; planChangeIds[operation.planChangeId] = true
		if operation.kind == "create" then
			local key = tostring(operation.tempId) .. ":" .. tostring(operation.parentPath) .. "/" .. tostring(operation.name)
			if createPaths[key] then error("create identity is not unique") end
			createPaths[key] = true
		else
			if targetIds[operation.stableId] then error("multiple operations target the same instance") end
			targetIds[operation.stableId] = true
		end
		validateOperation(operation, self.registry)
	end
	self.prepared = { changeSet = changeSet, projection = projection, preflightProjection = preflightProjection, beforeStateProjection = beforeProjection, beforeRevision = currentRevision, transportHash = payload.changeSetJsonHash, projectionTransportHash = payload.projectionJsonHash }
	return { creatorSessionId = changeSet.sessionId, changeSetId = changeSet.id, changeSetHash = changeSet.hash, manifestHash = Generated.manifestHash, projectionId = projection.id, projectionHash = projection.contentHash, preflightProjectionId = preflightProjection.id, preflightProjectionHash = preflightProjection.contentHash, beforeRevisionHash = currentRevision, status = "prepared" }
end

-- Detached preflight exercises only manifest-scoped conversion and readback.
-- Scratch instances stay unparented and are always destroyed before return.
function StudioAuthoring:preflight(payload: any)
	local prepared = self.prepared
	if not prepared or payload.creatorSessionId ~= prepared.changeSet.sessionId or payload.changeSetId ~= prepared.changeSet.id or payload.changeSetHash ~= prepared.changeSet.hash or payload.projectionId ~= prepared.projection.id or payload.projectionHash ~= prepared.projection.contentHash or payload.preflightProjectionId ~= prepared.preflightProjection.id or payload.preflightProjectionHash ~= prepared.preflightProjection.contentHash or payload.manifestHash ~= Generated.manifestHash or payload.expectedRevision ~= prepared.beforeRevision then error("creator preflight binding mismatch") end
	local facts, complete = {}, true
	for _, operation in ipairs(prepared.changeSet.operations) do
		local className = classForOperation(operation)
		if operation.kind ~= "delete" then
			local scratch: Instance? = nil
			local ok, _failure = pcall(function()
				scratch = Instance.new(className)
				applyProperties(scratch :: Instance, className, operation.properties or {}, self.registry)
				applyAttributes(scratch :: Instance, operation.attributes or {}, operation.removedAttributes)
				if Generated.classMetadata(className).source ~= "forbidden" and operation.source ~= nil then (scratch :: any).Source = operation.source end
			end)
			if scratch then scratch:Destroy() end
			if not ok then complete = false end
		end
	end
	for _, requirement in ipairs(Generated.projectionRequirements(prepared.preflightProjection)) do
		local output: any = { kind = requirement.kind, key = requirement.key, target = requirement.target }
		if requirement.kind == "property" then output.propertyName = requirement.propertyName
		elseif requirement.kind == "attribute" then output.attributeName = requirement.attributeName end
		local expectedStatus = requirement.expectedStatus or "observed"
		if expectedStatus == "absent" then
			local checked, failure = pcall(function()
				if requirement.kind == "attribute" then
					local scratch = Instance.new(requirement.target.className)
					scratch:SetAttribute(requirement.attributeName, true)
					scratch:SetAttribute(requirement.attributeName, nil)
					local absent = scratch:GetAttribute(requirement.attributeName) == nil
					scratch:Destroy()
					if not absent then error("attribute removal did not round-trip") end
				elseif requirement.kind == "structure" then
					local scratch = Instance.new(requirement.target.className)
					scratch:Destroy()
				else
					error("absent canary kind is outside the generated mutation projection")
				end
			end)
			if checked then output.result = { status = "absent" } else output.result = { status = "read_error", code = string.sub(tostring(failure), 1, 512) }; complete = false end
		else
			local checked, value = pcall(function()
				if requirement.kind == "property" then
					local scratch = Instance.new(requirement.target.className)
					local metadata = Generated.propertyMetadata(requirement.target.className, requirement.propertyName)
					if not metadata then scratch:Destroy(); error("canary property outside generated manifest") end
					(scratch :: any)[requirement.propertyName] = Generated.toStudio(metadata.codec, requirement.expected, metadata, function(reference) return referenceResolver(self.registry, reference) end)
					local result = Generated.read(scratch, requirement.propertyName, function(reference: Instance, property: any)
						local expected = requirement.expected
						if typeof(expected) ~= "table" or expected.state ~= "reference" or referenceResolver(self.registry, expected) ~= reference or property.referenceClass ~= expected.expectedClass then error("canary Instance reference readback mismatch") end
						return expected
					end); scratch:Destroy(); return result
				elseif requirement.kind == "attribute" then
					local scratch = Instance.new(requirement.target.className); local canonical = Generated.canonicalAttribute(requirement.expected); scratch:SetAttribute(requirement.attributeName, canonical); local result = Generated.canonicalAttribute(scratch:GetAttribute(requirement.attributeName)); scratch:Destroy(); return result
				elseif requirement.kind == "source_hash" then
					local source: string? = nil
					for _, operation in ipairs(prepared.changeSet.operations) do if classForOperation(operation) == requirement.target.className and typeof(operation.source) == "string" and sha256(operation.source) == requirement.expected then source = operation.source; break end end
					if not source then error("canary source does not bind the approved source hash") end
					local scratch = Instance.new(requirement.target.className); (scratch :: any).Source = source; local result = sha256((scratch :: any).Source); scratch:Destroy(); return result
				elseif requirement.kind == "structure" then
					local scratch = Instance.new(requirement.target.className); local result = { stableId = requirement.expected.stableId, path = requirement.expected.path, className = scratch.ClassName, parentPath = requirement.expected.parentPath }; scratch:Destroy(); return result
				end
				return requirement.expected
			end)
			if checked then
				output.result = { status = "observed", value = value }
				-- Comparison is delegated to the generated tagged fact material so
				-- float32, -0, colors, CFrames, and UTF-8 never fall back to Lua's
				-- display formatting or table identity.
				if requirement.expected ~= nil then
					local expected = table.clone(output)
					expected.result = { status = "observed", value = requirement.expected }
					if Generated.factMaterial(output) ~= Generated.factMaterial(expected) then
						output.result = { status = "read_error", code = "canary_round_trip_mismatch" }
						complete = false
					end
				end
			else output.result = { status = "read_error", code = string.sub(tostring(value), 1, 512) }; complete = false end
		end
		table.insert(facts, output)
	end
	facts = Generated.sortFacts(facts)
	local envelope: any = { kind = "StudioEvidenceEnvelope", manifestHash = Generated.manifestHash, projectionId = prepared.preflightProjection.id, projectionHash = prepared.preflightProjection.contentHash, bindingHash = prepared.preflightProjection.bindingHash, project = prepared.preflightProjection.project, authoritative = true, startedAt = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), endedAt = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), completion = complete and "complete" or "incomplete", facts = facts }
	envelope.contentHash = Generated.envelopeHash(envelope)
	prepared.preflight = envelope
	return envelope
end

function StudioAuthoring:apply(payload: any, currentRevision: string)
	local prepared = self.prepared
	self.lastFailure = nil
	if not prepared or not prepared.preflight or prepared.preflight.completion ~= "complete" then error("creator apply requires a complete preflight envelope") end
	if payload.creatorSessionId ~= prepared.changeSet.sessionId or payload.changeSetId ~= prepared.changeSet.id or payload.changeSetHash ~= prepared.changeSet.hash or payload.projectionId ~= prepared.projection.id or payload.projectionHash ~= prepared.projection.contentHash or payload.manifestHash ~= Generated.manifestHash or payload.expectedRevision ~= currentRevision or prepared.beforeRevision ~= currentRevision then error("creator apply revision/projection mismatch") end
	for _, operation in ipairs(prepared.changeSet.operations) do validateOperation(operation, self.registry) end
	local binding = {
		-- This is an opaque placeholder, used only to retain a conservative
		-- recovery record until Studio returns the actual recording id.  An
		-- opening record is always reported as unknown and can never be
		-- cancellation-authorized.
		recordingId = "pending_recording_" .. prepared.changeSet.id,
		opening = true,
		creatorSessionId = prepared.changeSet.sessionId,
		changeSetId = prepared.changeSet.id,
		changeSetHash = prepared.changeSet.hash,
		manifestHash = Generated.manifestHash,
		projectionId = prepared.projection.id,
		projectionHash = prepared.projection.contentHash,
		preflightHash = prepared.preflight.contentHash,
		beforeRevisionHash = currentRevision,
		-- Persist every immutable input needed to identify an interrupted
		-- transaction.  Restart/re-pair may report these artifacts, but it never
		-- replays a write, commit, or cancel from them.
		changeSet = prepared.changeSet,
		projection = prepared.projection,
		preflightProjection = prepared.preflightProjection,
		preflightEvidence = prepared.preflight,
		beforeStateProjection = prepared.beforeStateProjection,
	}
	binding = setActive(self.plugin, binding)
	local opened, recordingOrFailure = pcall(function()
		return changeHistoryService():TryBeginRecording("Forge creator change " .. prepared.changeSet.id)
	end)
	if not opened or typeof(recordingOrFailure) ~= "string" or recordingOrFailure == "" then
		-- The opening intent remains durable.  We cannot infer whether Studio
		-- opened a recording when its API call faults or returns no opaque id.
		-- Retain the exact binding for recovery and make the failed attempt
		-- reportable without attempting any automatic corrective action.
		self.lastFailure = { binding = binding, cancellationProven = false, failureCode = "recording_open_failed" }
		error("RECOVERY_REQUIRED: Studio did not return an exact recording id after opening intent persisted")
	end
	local recording = recordingOrFailure
	local recordingBinding = table.clone(binding)
	recordingBinding.recordingId = recording
	recordingBinding.opening = nil
	local persisted, persistedOrFailure = pcall(function() return setActive(self.plugin, recordingBinding) end)
	if not persisted then
		-- No place operation has run yet. This call owns the exact recording id,
		-- so it may cancel that recording; it must still prove the cancellation
		-- and preserve a finalization cursor before reporting a settled failure.
		local cancelled = pcall(function() changeHistoryService():FinishRecording(recording, Enum.FinishRecordingOperation.Cancel) end)
		local checked, stillOpen = pcall(function() return changeHistoryService():IsRecordingInProgress(recording) end)
		if cancelled and checked and not stillOpen then
			local cancelledBinding = table.clone(recordingBinding)
			cancelledBinding.finalization = { action = "cancel", failedApply = true, failureCode = "recording_cursor_persistence_failed" }
			local saved, savedOrFailure = pcall(function() return setActive(self.plugin, cancelledBinding) end)
			self.lastFailure = { binding = saved and savedOrFailure or cancelledBinding, cancellationProven = saved, failureCode = "recording_cursor_persistence_failed" }
			self.prepared = nil
			error("MUTATION_FAILED: recording cursor persistence failed before place mutation: " .. tostring(persistedOrFailure))
		end
		self.lastFailure = { binding = recordingBinding, cancellationProven = false, failureCode = "recording_cursor_persistence_failed" }
		error("RECOVERY_REQUIRED: recording cursor persistence failed and exact cancellation was not proven: " .. tostring(persistedOrFailure))
	end
	binding = persistedOrFailure
	local applied, failure = pcall(function()
		for _, operation in ipairs(prepared.changeSet.operations) do
			applyOperation(operation, self.registry, operation.kind == "create" and (prepared.changeSet.id .. ":" .. operation.tempId) or nil)
		end
	end)
	if not applied then
		-- This is the one call which opened the recording, so it may attempt a
		-- local cancellation. Failure leaves its exact persisted binding intact.
		local cancelled = pcall(function() changeHistoryService():FinishRecording(recording, Enum.FinishRecordingOperation.Cancel) end)
		local checked, stillOpen = pcall(function() return changeHistoryService():IsRecordingInProgress(recording) end)
		if cancelled and checked and not stillOpen then
			-- Cancellation is proven by the same call which opened this recording,
			-- but finalization is not complete until Runtime stores a complete
			-- post-cancel state receipt.  Retain this binding across a crash so
			-- re-pair can produce that evidence without resuming the mutation.
			local cancelledBinding = table.clone(binding)
			cancelledBinding.finalization = { action = "cancel", failedApply = true, failureCode = "mutation_apply_failed" }
			local saved, savedOrFailure = pcall(function() return setActive(self.plugin, cancelledBinding) end)
			self.lastFailure = { binding = saved and savedOrFailure or cancelledBinding, cancellationProven = saved, failureCode = "mutation_apply_failed" }
			self.prepared = nil
			error("MUTATION_FAILED: " .. tostring(failure))
		end
		self.lastFailure = { binding = binding, cancellationProven = false, failureCode = "mutation_apply_failed" }
		error("RECOVERY_REQUIRED: mutation failed and this call could not prove cancellation: " .. tostring(failure))
	end
	self.active = { recording = recording, prepared = prepared, binding = binding }
	self.prepared = nil
	return self.active
end

-- Evidence collection/persistence runs after provisional place mutation. If it
-- cannot produce a protocol-valid provisional record, the same plugin call
-- cancels only the recording it opened and proves that cancellation before the
-- coordinator may classify the attempt as incomplete.
function StudioAuthoring:cancelActiveForEvidenceFailure(active: any, failureCode: string)
	if self.active ~= active or typeof(failureCode) ~= "string" or failureCode == "" then error("provisional cancellation binding rejected") end
	local cancelled, failure = pcall(function() changeHistoryService():FinishRecording(active.recording, Enum.FinishRecordingOperation.Cancel) end)
	local checked, stillOpen = pcall(function() return changeHistoryService():IsRecordingInProgress(active.recording) end)
	if not cancelled or not checked or stillOpen then
		self.lastFailure = { binding = active.binding, cancellationProven = false, failureCode = failureCode }
		error("RECOVERY_REQUIRED: provisional evidence failed and exact cancellation was not proven: " .. tostring(failure))
	end
	local binding = table.clone(active.binding)
	binding.finalization = { action = "cancel", failureCode = failureCode }
	local persisted = setActive(self.plugin, binding)
	self.active = nil
	self.lastFailure = { binding = persisted, cancellationProven = true, failureCode = failureCode }
	return persisted
end

function StudioAuthoring:finalize(payload: any)
	local active = self.active
	if not active or payload.creatorSessionId ~= active.prepared.changeSet.sessionId or payload.recordingId ~= active.recording or payload.changeSetId ~= active.prepared.changeSet.id or payload.changeSetHash ~= active.prepared.changeSet.hash or payload.projectionId ~= active.prepared.projection.id or payload.projectionHash ~= active.prepared.projection.contentHash or payload.manifestHash ~= Generated.manifestHash or payload.beforeRevisionHash ~= active.binding.beforeRevisionHash or (payload.action ~= "commit" and payload.action ~= "cancel") then error("creator finalization binding mismatch") end
	local operation = payload.action == "commit" and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
	local ok, failure = pcall(function() changeHistoryService():FinishRecording(active.recording, operation) end)
	if not ok then error("RECOVERY_REQUIRED: " .. tostring(failure)) end
	-- Do not discard the exact commit/cancel acknowledgement until its required
	-- post-finalize state evidence has been durably sent.  A restart only
	-- reports this record; it never repeats a finalization operation.
	local finalizedBinding = table.clone(active.binding)
	finalizedBinding.finalization = { action = payload.action }
	active.binding = setActive(self.plugin, finalizedBinding)
	self.active = nil
	return active
end

function StudioAuthoring:recordFinalizationEvidence(binding: any, post: any)
	if typeof(binding) ~= "table" or typeof(post) ~= "table" or typeof(post.projection) ~= "table" or typeof(post.envelope) ~= "table" or typeof(post.revision) ~= "table" or post.envelope.completion ~= "complete" or typeof(post.envelope.contentHash) ~= "string" or typeof(post.revision.stateHash) ~= "string" then error("finalization evidence is malformed") end
	local stored = activeSetting(self.plugin)
	if typeof(stored) ~= "table" or not sameRecordingBinding(stored, binding) or typeof(stored.finalization) ~= "table" or (stored.finalization.action ~= "commit" and stored.finalization.action ~= "cancel") then error("finalization evidence binding rejected") end
	if finalizationReceipt(self.plugin) ~= nil then error("a prior finalization receipt is awaiting backend acknowledgement") end
	local action = stored.finalization.action
	local receipt: any = table.clone(stored)
	receipt.kind = "CreatorChangeFinalizationReceipt"
	receipt.action = action
	receipt.status = action == "commit" and "committed" or "cancelled"
	receipt.afterRevision = post.revision
	receipt.postFinalizeStateProjection = post.projection
	receipt.postFinalizeStateEvidence = post.envelope
	receipt = setFinalizationReceipt(self.plugin, receipt)
	-- The state is settled locally.  Keep only the receipt, which is explicitly
	-- outside hasPossibleRecording and can be replayed without touching Studio.
	setActive(self.plugin, nil)
	self.active = nil
	return receipt
end

function StudioAuthoring:acknowledgeFinalization(payload: any)
	local receipt = finalizationReceipt(self.plugin)
	if typeof(payload) ~= "table" or typeof(receipt) ~= "table" or payload.action ~= receipt.action or payload.status ~= receipt.status or payload.afterRevisionHash ~= receipt.afterRevision.stateHash or payload.postFinalizeProjectionHash ~= receipt.postFinalizeStateProjection.contentHash or payload.postFinalizeEvidenceHash ~= receipt.postFinalizeStateEvidence.contentHash or not sameRecordingBinding(payload, receipt) then error("finalization acknowledgement does not match the retained receipt") end
	if receipt.action == "commit" then
		local committedReceipt = table.clone(receipt)
		committedReceipt.afterRevisionHash = receipt.afterRevision.stateHash
		setLastCommit(self.plugin, committedReceipt)
	end
	setFinalizationReceipt(self.plugin, nil)
	return receipt
end

function StudioAuthoring:cancelInterrupted(payload: any)
	local stored = activeSetting(self.plugin)
	if typeof(stored) ~= "table" or payload.creatorSessionId ~= stored.creatorSessionId or payload.recordingId ~= stored.recordingId or payload.changeSetHash ~= stored.changeSetHash or payload.projectionHash ~= stored.projectionHash or payload.manifestHash ~= stored.manifestHash or payload.recoveryEvidenceHash ~= stored.recoveryEvidenceHash then error("interrupted-recording cancellation binding mismatch") end
	local openOk, open = pcall(function() return changeHistoryService():IsRecordingInProgress(stored.recordingId) end)
	if not openOk or not open then error("RECOVERY_REQUIRED: exact interrupted recording is not proven open") end
	local cancelled, failure = pcall(function() changeHistoryService():FinishRecording(stored.recordingId, Enum.FinishRecordingOperation.Cancel) end)
	if not cancelled then error("RECOVERY_REQUIRED: " .. tostring(failure)) end
	-- The cancellation is complete in Studio, but its post-cancel evidence and
	-- durable backend acknowledgement are still outstanding.  Retain the exact
	-- binding until Runtime records a finalization receipt.
	local cancelledBinding = table.clone(stored)
	cancelledBinding.finalization = { action = "cancel", recovery = true }
	local persisted = setActive(self.plugin, cancelledBinding); self.active = nil
	return persisted
end

function StudioAuthoring:rollback(payload: any, currentRevision: string)
	if self:hasPossibleRecording() then error("cannot roll back while a creator recording may be active") end
	local committed = self.plugin:GetSetting(LAST_COMMIT_SETTING)
	if typeof(committed) ~= "table" or committed.changeSetId ~= payload.changeSetId or committed.changeSetHash ~= payload.changeSetHash or committed.afterRevisionHash ~= currentRevision or payload.expectedRevision ~= currentRevision then error("guarded checkpoint rollback precondition mismatch") end
	local ok, failure = pcall(function() changeHistoryService():Undo() end)
	if not ok then error("RECOVERY_REQUIRED: " .. tostring(failure)) end
	setLastCommit(self.plugin, nil)
	return committed
end

function StudioAuthoring.validatePayloadForTest(input: any): boolean
	if typeof(input) ~= "table" or typeof(input.className) ~= "string" then error("invalid validation test payload") end
	if not Generated.classMetadata(input.className) then error("class is not in generated manifest") end
	validateProperties(input.className, input.properties or {}, nil, false)
	Generated.validateAttributes(input.attributes or {})
	validateRemovedAttributes(input.removedAttributes or {}, input.attributes or {})
	Generated.validateSource(input.source, input.sourceRequired == true)
	return true
end

function StudioAuthoring.persistActiveForTest(plugin: any, value: any): any
	return setActive(plugin, value)
end

function StudioAuthoring.acknowledgeClosedRecordingForTest(plugin: any, payload: any, recordingState: string): any
	return acknowledgeClosedRecording(plugin, payload, recordingState)
end

function StudioAuthoring.settingKeysForTest()
	return { active = ACTIVE_RECORDING_SETTING, finalization = FINALIZATION_RECEIPT_SETTING, lastCommit = LAST_COMMIT_SETTING }
end

return StudioAuthoring
