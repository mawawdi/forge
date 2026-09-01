local Generated = require("../plugin/src/Forge/GeneratedStudioEvidence")
local StudioAuthoring = require("../plugin/src/Forge/StudioAuthoring")
local StudioEvidenceCollector = require("../plugin/src/Forge/StudioEvidenceCollector")
local StudioInstancePolicy = require("../plugin/src/Forge/StudioInstancePolicy")
local fs = require("@lune/fs")

local runtimeExecutorSource = fs.readFile("plugin/src/Forge/RuntimeCapabilityExecutor.luau")
local runtimeSource = fs.readFile("plugin/src/Forge/Runtime.luau")
local evidenceCollectorSource = fs.readFile("plugin/src/Forge/StudioEvidenceCollector.luau")
assert(string.find(runtimeExecutorSource, 'expectedProjectionPurpose = plan.purpose == "creator_verification" and "creator_verification" or "runtime_evaluation"', 1, true), "plugin runtime projection purpose must derive from the execution-plan purpose")
assert(not string.find(runtimeExecutorSource, 'decoded.purpose ~= "runtime_evaluation"', 1, true), "creator verification must not be rejected by a runtime-only projection predicate")
assert(string.find(runtimeExecutorSource, 'typeof(plan.observationWindowMs) ~= "number"', 1, true), "plugin runtime must validate the explicit creator-observation window")
assert(string.find(runtimeExecutorSource, "remainingObservationMs", 1, true), "Play Solo must remain open for the approved observation window")
assert(string.find(runtimeExecutorSource, 'requirement.kind == "runtime_property"', 1, true), "fixed manifest property observations must have a dedicated executor path")
assert(string.find(runtimeExecutorSource, 'requirement.kind == "runtime_property_series"', 1, true), "fixed manifest property series must have a dedicated executor path")
assert(string.find(runtimeSource, "return Generated.connectorBuildHash", 1, true), "plugin pairing must use the generated protocol identity")
assert(string.find(runtimeSource, "status >= 400 and status < 500 then autoConnectEnabled = false", 1, true), "deterministic pairing rejection must pause automatic retries")
assert(string.find(runtimeSource, 'unpair(false, "session_replaced", true)', 1, true), "post-pair protocol rejection must pause automatic retries")

-- The collector serializes ReflectionService facts and leaves all semantic
-- comparison to the provider-free verifier. These vectors cover the public
-- alias and class-reference dimensions that EngineType alone cannot express.
assert(not string.find(evidenceCollectorSource, "Generated.reflectionExpectation", 1, true), "the plugin collector must not grade reflection facts against manifest expectations")
assert(not string.find(evidenceCollectorSource, "reflection_type_mismatch", 1, true), "a reflected type contradiction must remain observed evidence")
assert(not string.find(evidenceCollectorSource, "reflection_enum_type_mismatch", 1, true), "a reflected enum contradiction must remain observed evidence")
assert(not string.find(evidenceCollectorSource, "reflection_serialization_mismatch", 1, true), "a reflected serialization contradiction must remain observed evidence")

local classReference, classReferenceError = StudioEvidenceCollector.reflectedPropertyValueForTest({
	Name = "Attachment0",
	Owner = "Beam",
	Serialized = true,
	Type = { EngineType = "Object", ScriptType = "Instance", InstanceType = "Attachment" },
	Permits = { Write = {}, Read = {} },
}, "Beam", "Attachment0")
assert(classReferenceError == nil and classReference ~= nil, "a readable class-reference descriptor must be observed")
assert(classReference.className == "Beam" and classReference.propertyName == "Attachment0", "raw reflection facts bind their requested class and property")
assert(classReference.owner == "Beam" and classReference.inherited == false and classReference.serialized == true, "reflection owner, inheritance, and serialization must be preserved")
assert(classReference.type.engineType == "Object" and classReference.type.scriptType == "Instance" and classReference.type.instanceType == "Attachment" and classReference.type.enumType == nil, "class-reference type dimensions must be preserved without EngineType aliasing")
assert(classReference.permits[1] == "read" and classReference.permits[2] == "write" and #classReference.permits == 2, "reflection permits must remain sorted and bounded")

local datatypeAlias, datatypeAliasError = StudioEvidenceCollector.reflectedPropertyValueForTest({
	Name = "SliceCenter",
	Owner = "ImageLabel",
	Serialized = false,
	Type = { EngineType = "Rect2D", ScriptType = "Rect" },
	Permits = { Read = {}, Write = {} },
}, "ImageLabel", "SliceCenter")
assert(datatypeAliasError == nil and datatypeAlias ~= nil, "a readable datatype alias must be observed")
assert(datatypeAlias.type.engineType == "Rect2D" and datatypeAlias.type.scriptType == "Rect", "a public datatype alias must retain both raw type dimensions")
assert(datatypeAlias.type.enumType == nil and datatypeAlias.type.instanceType == nil, "unavailable reflection type dimensions must not be fabricated")

local inheritedEnum, inheritedEnumError = StudioEvidenceCollector.reflectedPropertyValueForTest({
	Name = "Material",
	Owner = "BasePart",
	Serialized = true,
	Type = { EngineType = "EnumItem", ScriptType = "EnumItem", EnumType = "Material" },
	Permits = { Read = {}, Write = {} },
}, "Part", "Material")
assert(inheritedEnumError == nil and inheritedEnum ~= nil, "a readable enum descriptor must be observed")
assert(inheritedEnum.owner == "BasePart" and inheritedEnum.inherited == true, "inherited reflection ownership must be explicit")
assert(inheritedEnum.type.engineType == "EnumItem" and inheritedEnum.type.scriptType == "EnumItem" and inheritedEnum.type.enumType == "Material", "enum identity must remain independent from EngineType")

local unreadableType, unreadableTypeError = StudioEvidenceCollector.reflectedPropertyValueForTest({ Owner = "Part", Serialized = true, Type = {}, Permits = { Read = {}, Write = {} } }, "Part", "Anchored")
assert(unreadableType == nil and unreadableTypeError == "reflection_engine_type_unavailable", "only missing required raw reflection evidence becomes a read error")
local unreadableOwner, unreadableOwnerError = StudioEvidenceCollector.reflectedPropertyValueForTest({ Owner = nil, Serialized = true, Type = { EngineType = "bool" }, Permits = { Read = {}, Write = {} } }, "Part", "Anchored")
assert(unreadableOwner == nil and unreadableOwnerError == "reflection_owner_unavailable", "missing reflection ownership must not be invented")

local function fakeInstance(className: string)
	return { ClassName = className }
end

-- The identity policy obtains its coverage directly from the generated
-- manifest, so a manifest class never needs a hand-maintained parallel list.
for className in pairs(Generated.classes) do
	assert(StudioInstancePolicy.isEvidenceRelevant(fakeInstance(className)), className .. " must participate in generated evidence eligibility")
end
assert(not StudioInstancePolicy.isEvidenceRelevant(fakeInstance("Camera")), "unmanifested classes must not gain evidence identity")

local roots = StudioInstancePolicy.rootNames()
assert(roots[1] == "Lighting" and roots[#roots] == "Workspace", "generated authoring roots must be canonical")
roots[1] = "mutated"
assert(StudioInstancePolicy.rootNames()[1] == "Lighting", "callers must not mutate generated authoring roots")

for _, vector in ipairs(Generated.vectors) do
	assert(Generated.canonicalValueMaterial(vector.value) == vector.material, vector.name .. " must retain cross-language canonical material")
end
assert(Generated.canonicalValueMaterial({ kind = "boolean", value = false }) ~= Generated.canonicalValueMaterial({ kind = "boolean", value = true }), "false must never be confused with an omitted fact")
assert(Generated.canonicalValueMaterial({ kind = "number_f32", value = -0 }) ~= Generated.canonicalValueMaterial({ kind = "number_f32", value = 0 }), "negative zero must retain its float32 bit pattern")
local emptyListTarget = { kind = "instance", stableId = "empty-list-instance", path = "Workspace/EmptyList", className = "Folder" }
local emptyListEnvelope = {
	kind = "StudioEvidenceEnvelope",
	manifestHash = string.rep("a", 64),
	projectionId = "empty-list-projection",
	projectionHash = string.rep("b", 64),
	bindingHash = string.rep("c", 64),
	project = { name = "Empty List Vector", placeId = 0, universeId = 0 },
	authoritative = true,
	startedAt = "2026-09-01T00:00:00.000Z",
	endedAt = "2026-09-01T00:00:00.000Z",
	completion = "complete",
	facts = {
		{ kind = "tags", key = Generated.factKey("tags", emptyListTarget), target = emptyListTarget, result = { status = "observed", value = {} } },
	},
}
local emptyListMaterial = Generated.envelopeMaterial(emptyListEnvelope)
assert(string.find(emptyListMaterial, "5:array", 1, true) ~= nil and string.find(emptyListMaterial, "6:object", 1, true) == nil, "empty evidence lists must use the shared array material domain")
assert(not pcall(function() Generated.validateValue("number_f32", { kind = "number_f32", value = math.huge }) end), "non-finite values must fail closed")
assert(not pcall(function() Generated.validateValue("color3_rgb8", { kind = "color3_rgb8", r = 0, g = 128.5, b = 255 }) end), "RGB values must be exact bytes")
assert(typeof(Generated.runtimeRunnerDispatchSource) == "string" and string.find(Generated.runtimeRunnerDispatchSource, "base_part.position_series", 1, true), "Play-Solo runtime dispatch must be generated from the manifest")
local generatedSeriesBound = nil
for _, capability in ipairs(Generated.manifest.runtimeCapabilities) do
	if capability.name == "base_part.position_series" then generatedSeriesBound = capability.maximumSamples end
end
assert(generatedSeriesBound ~= nil and string.find(Generated.runtimeRunnerDispatchSource, "call.sampleCount > " .. tostring(generatedSeriesBound), 1, true), "generated runner dispatch must carry manifest series bounds")

-- Projection provenance changes across pairing, approval, and transaction
-- phases. It must remain exact evidence without changing the identity of an
-- otherwise identical complete Studio state.
local stateRequirements = {
	{ kind = "inventory", key = Generated.factKey("inventory", { kind = "project" }), target = { kind = "project" } },
}
local stateProjectionA = {
	id = "pairing-state", manifestHash = Generated.manifestHash, purpose = "project_state",
	project = { name = "Revision Vector", placeId = 0, universeId = 0 },
	binding = { sessionId = "studio-session", projectId = "studio-project", buildHash = string.rep("a", 64) },
	requirements = stateRequirements,
	scope = { mode = "project_state", roots = { "Workspace" }, requireCompleteInventory = true },
	bounds = { maximumFacts = 32, maximumBytes = 4096, roots = { "Workspace" }, maximumInstances = 16 },
}
local stateProjectionB = table.clone(stateProjectionA)
stateProjectionB.id = "approved-before-state"
stateProjectionB.binding = { sessionId = "creator-session", changeSetHash = string.rep("b", 64), approvalHash = string.rep("c", 64), revisionHash = string.rep("d", 64) }
local stateFacts = {
	{ kind = "inventory", key = Generated.factKey("inventory", { kind = "project" }), target = { kind = "project" }, result = { status = "observed", value = {} } },
}
local reboundStateFacts = {
	{ kind = "inventory", key = Generated.factKey("inventory", { kind = "project" }), target = { kind = "project" }, result = { status = "observed", value = {} } },
}
assert(Generated.stateDomainMaterial(stateProjectionA) == Generated.stateDomainMaterial(stateProjectionB), "approval bindings must not change the comparable state domain")
assert(Generated.stateRevisionMaterial(Generated.manifestHash, string.rep("e", 64), stateFacts) == Generated.stateRevisionMaterial(Generated.manifestHash, string.rep("e", 64), reboundStateFacts), "identical facts in the same state domain must retain one revision material")

-- The generated recompiler's hash-free requirement vector proves that the
-- sealed change-set shape, including explicit false and deletion/absence, is
-- compiled from the manifest rather than a StudioAuthoring property table.
local mutationRequirements = Generated.compileMutationRequirements({
	kind = "CreatorChangeSet",
	id = "creator_change_vector",
	operations = {
		{
			id = "update_prompt",
			kind = "update",
			stableId = "prompt_1",
			expectedPath = "Workspace/Door/Prompt",
			expectedClass = "ProximityPrompt",
			properties = { RequiresLineOfSight = { kind = "boolean", value = false } },
			attributes = { EnabledByForge = false },
			removedAttributes = { "LegacyPrompt" },
		},
		{
			id = "delete_old_door",
			kind = "delete",
			stableId = "old_door_1",
			expectedPath = "Workspace/OldDoor",
			expectedClass = "Model",
		},
	},
})
local sawExplicitFalse, sawAbsentDelete = false, false
for _, requirement in ipairs(mutationRequirements) do
	if requirement.kind == "property" and requirement.propertyName == "RequiresLineOfSight" then
		sawExplicitFalse = requirement.expected.kind == "boolean" and requirement.expected.value == false
	end
	if requirement.kind == "structure" and requirement.target.stableId == "old_door_1" then
		sawAbsentDelete = requirement.expectedStatus == "absent" and requirement.expected == nil
	end
end
assert(sawExplicitFalse, "generated mutation vector must retain false as an observed value")
assert(sawAbsentDelete, "generated mutation vector must compile delete as explicit absence")
local deletedDescendantRequirements = Generated.compileMutationRequirements({
	kind = "CreatorChangeSet",
	id = "creator_change_vector",
	operations = {
		{ id = "delete_old_door", kind = "delete", stableId = "old_door_1", expectedPath = "Workspace/OldDoor", expectedClass = "Model" },
	},
}, {
	delete_old_door = {
		{ kind = "instance", stableId = "old_prompt_1", path = "Workspace/OldDoor/Prompt", className = "ProximityPrompt" },
	},
})
local sawAbsentDescendant = false
for _, requirement in ipairs(deletedDescendantRequirements) do
	if requirement.kind == "structure" and requirement.target.stableId == "old_prompt_1" then sawAbsentDescendant = requirement.expectedStatus == "absent" end
end
assert(sawAbsentDescendant, "generated mutation vector must compile bounded delete descendants as absence")
assert(not pcall(function()
	Generated.compileMutationRequirements({ kind = "CreatorChangeSet", id = "bad", operations = {
		{ id = "bad_property", kind = "update", stableId = "part", expectedPath = "Workspace/Part", expectedClass = "Part", properties = { Unknown = { kind = "boolean", value = false } }, attributes = {}, removedAttributes = {} },
	} })
end), "generated mutation recompiler must reject a property outside the manifest")

local function payload(properties, source, sourceRequired)
	return { className = sourceRequired and "Script" or "Part", properties = properties, attributes = { CreatorOwned = true }, source = source, sourceRequired = sourceRequired == true }
end

assert(StudioAuthoring.validatePayloadForTest(payload({
	Transparency = { kind = "number_f32", value = 0 },
	Size = { kind = "vector3_f32", x = 4, y = 1, z = 4 },
	Color = { kind = "color3_rgb8", r = 0, g = 255, b = 0 },
	CFrame = { kind = "cframe_f32x12", components = { 0, 2, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1 } },
	Material = { kind = "enum_name", value = "Neon" },
}, nil, false)), "generated Part values must pass manifest validation")

local invalidPayloads = {
	payload({ Transparency = { kind = "number_f32", value = -0.001 } }, nil, false),
	payload({ Transparency = { kind = "number_f32", value = 1.001 } }, nil, false),
	payload({ Size = { kind = "vector3_f32", x = 0, y = 1, z = 1 } }, nil, false),
	payload({ Size = { kind = "vector3_f32", x = 2049, y = 1, z = 1 } }, nil, false),
	payload({ Color = { kind = "color3_rgb8", r = 256, g = 0, b = 0 } }, nil, false),
	payload({ Material = { kind = "enum_name", value = "ExploitMaterial" } }, nil, false),
	payload({ RequiresLineOfSight = { kind = "boolean", value = false } }, nil, false),
}
for _, invalid in ipairs(invalidPayloads) do
	assert(not pcall(function() StudioAuthoring.validatePayloadForTest(invalid) end), "out-of-manifest or out-of-bounds payload must fail before recording")
end

assert(StudioAuthoring.validatePayloadForTest(payload({}, string.rep("é", 24000), true)), "48,000-byte valid UTF-8 source must pass")
assert(not pcall(function() StudioAuthoring.validatePayloadForTest(payload({}, string.rep("é", 24001), true)) end), "source byte cap must count UTF-8 bytes")
assert(not pcall(function() StudioAuthoring.validatePayloadForTest(payload({}, string.char(255), true)) end), "invalid UTF-8 source must fail")
assert(not pcall(function() StudioAuthoring.validatePayloadForTest(payload({}, "   \n", true)) end), "empty script source must fail")
assert(not pcall(function() StudioAuthoring.validatePayloadForTest({ className = "Part", properties = {}, attributes = { _forgeReserved = true } }) end), "reserved attributes must fail")
assert(StudioAuthoring.validatePayloadForTest({ className = "Part", properties = {}, attributes = { Current = true }, removedAttributes = { "Legacy" } }), "disjoint attribute removal must pass")
assert(not pcall(function() StudioAuthoring.validatePayloadForTest({ className = "Part", properties = {}, attributes = { Same = true }, removedAttributes = { "Same" } }) end), "an attribute cannot be set and removed together")

-- Mutation requirements are rebuilt from the sealed change, not accepted from
-- a dashboard-supplied requirement list.  `false` remains an exact property
-- value rather than a special branch or an omitted fact.
local requirements = Generated.compileMutationRequirements({
	kind = "CreatorChangeSet",
	id = "creator_change_set_test",
	operations = {
		{
			id = "operation_prompt",
			kind = "create",
			tempId = "prompt",
			parentPath = "Workspace",
			name = "DoorPrompt",
			className = "ProximityPrompt",
			properties = { RequiresLineOfSight = { kind = "boolean", value = false } },
			attributes = {},
		},
	},
})
assert(#requirements == 2, "create must recompile structure and changed-property obligations")
local lineOfSight = nil
for _, requirement in ipairs(requirements) do
	assert(requirement.target.stableId == "creator_change_set_test:prompt", "create identity must be deterministic")
	if requirement.kind == "property" then lineOfSight = requirement end
end
assert(lineOfSight ~= nil and lineOfSight.expected.value == false, "RequiresLineOfSight false must remain an explicit expected value")

-- A committed/cancelled recording is not forgotten at the transport boundary.
-- The durable receipt is replayed on re-pair and only an exact backend
-- acknowledgement may clear it; a stale acknowledgement cannot clear a
-- different recording's proof.
local settings = {}
local fakePlugin = {}
function fakePlugin:GetSetting(key) return settings[key] end
function fakePlugin:SetSetting(key, value) settings[key] = value end
local receiptAuthoring = StudioAuthoring.new(fakePlugin, {}, {})
local settingKeys = StudioAuthoring.settingKeysForTest()
assert(not string.find(settingKeys.active, ".", 1, true) and not string.find(settingKeys.finalization, ".", 1, true) and not string.find(settingKeys.lastCommit, ".", 1, true), "transaction setting keys must respect Roblox JSON key restrictions")
local finalizationBinding = {
	creatorSessionId = "creator_session_receipt",
	changeSetId = "creator_change_set_receipt",
	changeSetHash = string.rep("a", 64),
	projectionId = "studio_projection_receipt",
	projectionHash = string.rep("b", 64),
	manifestHash = Generated.manifestHash,
	beforeRevisionHash = string.rep("c", 64),
	recordingId = "recording_receipt",
	beforeStateProjection = { id = "studio_state_projection_receipt" },
	finalization = { action = "commit" },
}
settings[settingKeys.active] = finalizationBinding
local finalizationReceipt = receiptAuthoring:recordFinalizationEvidence(finalizationBinding, {
	projection = { id = "studio_state_projection_receipt", contentHash = string.rep("d", 64) },
	envelope = { completion = "complete", contentHash = string.rep("e", 64) },
	revision = { stateHash = string.rep("f", 64) },
})
assert(settings[settingKeys.active] == nil, "receipt persistence must settle the active recording binding")
assert(receiptAuthoring:finalizationReceipt() == finalizationReceipt, "settled receipt must remain available for replay")
assert(not receiptAuthoring:hasPossibleRecording(), "a settled finalization receipt must not be treated as an open recording")
assert(receiptAuthoring:hasPendingFinalizationReceipt(), "a settled receipt must still block a second transaction until acknowledged")
local staleAcknowledgement = {
	creatorSessionId = finalizationReceipt.creatorSessionId,
	changeSetId = finalizationReceipt.changeSetId,
	changeSetHash = finalizationReceipt.changeSetHash,
	projectionId = finalizationReceipt.projectionId,
	projectionHash = finalizationReceipt.projectionHash,
	manifestHash = finalizationReceipt.manifestHash,
	beforeRevisionHash = finalizationReceipt.beforeRevisionHash,
	recordingId = finalizationReceipt.recordingId,
	action = "commit",
	status = "committed",
	afterRevisionHash = string.rep("0", 64),
	postFinalizeProjectionHash = finalizationReceipt.postFinalizeStateProjection.contentHash,
	postFinalizeEvidenceHash = finalizationReceipt.postFinalizeStateEvidence.contentHash,
}
assert(not pcall(function() receiptAuthoring:acknowledgeFinalization(staleAcknowledgement) end), "a stale finalization acknowledgement must fail closed")
assert(receiptAuthoring:finalizationReceipt() == finalizationReceipt, "a rejected acknowledgement must retain the receipt for replay")
staleAcknowledgement.afterRevisionHash = finalizationReceipt.afterRevision.stateHash
receiptAuthoring:acknowledgeFinalization(staleAcknowledgement)
assert(receiptAuthoring:finalizationReceipt() == nil, "the exact acknowledgement must clear the durable receipt")
assert(not receiptAuthoring:hasPendingFinalizationReceipt(), "acknowledgement must release the next transaction boundary")
assert(settings[settingKeys.lastCommit] ~= nil and settings[settingKeys.lastCommit].recordingId == finalizationReceipt.recordingId, "a committed receipt becomes rollback-eligible only after acknowledgement")

-- A mid-batch failure that its own Apply call cancels is still a durable
-- cancellation finalization, not merely an optional diagnostic envelope.  It
-- must be receipt-backed before a reconnect can safely report it.
settings[settingKeys.active] = {
	creatorSessionId = "creator_session_failed_apply",
	changeSetId = "creator_change_set_failed_apply",
	changeSetHash = string.rep("7", 64),
	projectionId = "studio_projection_failed_apply",
	projectionHash = string.rep("8", 64),
	manifestHash = Generated.manifestHash,
	beforeRevisionHash = string.rep("9", 64),
	recordingId = "recording_failed_apply",
	beforeStateProjection = { id = "studio_state_projection_failed_apply" },
	finalization = { action = "cancel", failedApply = true },
}
local failedApplyBinding = settings[settingKeys.active]
local failedApplyReceipt = receiptAuthoring:recordFinalizationEvidence(failedApplyBinding, {
	projection = { id = "studio_state_projection_failed_apply", contentHash = string.rep("a", 64) },
	envelope = { completion = "complete", contentHash = string.rep("b", 64) },
	revision = { stateHash = string.rep("c", 64) },
})
assert(failedApplyReceipt.action == "cancel" and failedApplyReceipt.status == "cancelled", "same-call cancellation must produce a cancelled receipt")
assert(settings[settingKeys.active] == nil and not receiptAuthoring:hasPossibleRecording(), "a receipt-backed failed-apply cancellation must not masquerade as an open recording")
receiptAuthoring:acknowledgeFinalization({
	creatorSessionId = failedApplyReceipt.creatorSessionId,
	changeSetId = failedApplyReceipt.changeSetId,
	changeSetHash = failedApplyReceipt.changeSetHash,
	projectionId = failedApplyReceipt.projectionId,
	projectionHash = failedApplyReceipt.projectionHash,
	manifestHash = failedApplyReceipt.manifestHash,
	beforeRevisionHash = failedApplyReceipt.beforeRevisionHash,
	recordingId = failedApplyReceipt.recordingId,
	action = "cancel",
	status = "cancelled",
	afterRevisionHash = failedApplyReceipt.afterRevision.stateHash,
	postFinalizeProjectionHash = failedApplyReceipt.postFinalizeStateProjection.contentHash,
	postFinalizeEvidenceHash = failedApplyReceipt.postFinalizeStateEvidence.contentHash,
})
assert(receiptAuthoring:finalizationReceipt() == nil, "the exact cancelled receipt acknowledgement must clear it")

-- The recording-open boundary is persisted before Studio returns its opaque
-- recording id.  A restart at that boundary is explicitly unknown rather than
-- being treated as a safe no-recording state.
settings[settingKeys.active] = {
	creatorSessionId = "creator_session_opening",
	changeSetId = "creator_change_set_opening",
	changeSetHash = string.rep("1", 64),
	projectionId = "studio_projection_opening",
	projectionHash = string.rep("2", 64),
	manifestHash = Generated.manifestHash,
	beforeRevisionHash = string.rep("3", 64),
	recordingId = "pending_recording_creator_change_set_opening",
	opening = true,
}
local openingRecovery = receiptAuthoring:recovery()
assert(openingRecovery.recordingState == "unknown" and openingRecovery.recording ~= nil, "an interrupted recording-open boundary must require recovery")
settings[settingKeys.active] = nil

-- A reset coordinator store may no longer contain the session named by a
-- connector cursor. The cursor may be cleared only after Studio reports the
-- exact recording is closed and the backend acknowledges the exact persisted
-- recovery projection/envelope. Open, unknown, or stale evidence stays blocked.
local closedCursor = {
	creatorSessionId = "creator_session_orphaned",
	changeSetId = "creator_change_set_orphaned",
	changeSetHash = string.rep("4", 64),
	projectionId = "studio_projection_orphaned",
	projectionHash = string.rep("5", 64),
	manifestHash = Generated.manifestHash,
	beforeRevisionHash = string.rep("6", 64),
	recordingId = "recording_orphaned",
	beforeStateProjection = { contentHash = string.rep("7", 64) },
	recoveryEvidenceHash = string.rep("8", 64),
}
local closedAcknowledgement = {
	creatorSessionId = closedCursor.creatorSessionId,
	changeSetId = closedCursor.changeSetId,
	changeSetHash = closedCursor.changeSetHash,
	projectionId = closedCursor.projectionId,
	projectionHash = closedCursor.projectionHash,
	manifestHash = closedCursor.manifestHash,
	beforeRevisionHash = closedCursor.beforeRevisionHash,
	recordingId = closedCursor.recordingId,
	recoveryProjectionHash = closedCursor.beforeStateProjection.contentHash,
	recoveryEvidenceHash = closedCursor.recoveryEvidenceHash,
}
settings[settingKeys.active] = closedCursor
assert(not pcall(function() StudioAuthoring.acknowledgeClosedRecordingForTest(fakePlugin, closedAcknowledgement, "open") end), "an open recording must never be cleared by acknowledgement")
assert(settings[settingKeys.active] == closedCursor, "rejected open-recording acknowledgement must retain the cursor")
assert(not pcall(function() StudioAuthoring.acknowledgeClosedRecordingForTest(fakePlugin, closedAcknowledgement, "unknown") end), "an unknown recording must never be cleared by acknowledgement")
assert(settings[settingKeys.active] == closedCursor, "rejected unknown-recording acknowledgement must retain the cursor")
closedAcknowledgement.recoveryEvidenceHash = string.rep("9", 64)
assert(not pcall(function() StudioAuthoring.acknowledgeClosedRecordingForTest(fakePlugin, closedAcknowledgement, "not_open") end), "stale recovery evidence must not clear a cursor")
assert(settings[settingKeys.active] == closedCursor, "rejected stale acknowledgement must retain the cursor")
closedAcknowledgement.recoveryEvidenceHash = closedCursor.recoveryEvidenceHash
StudioAuthoring.acknowledgeClosedRecordingForTest(fakePlugin, closedAcknowledgement, "not_open")
assert(settings[settingKeys.active] == nil, "exact proved-closed acknowledgement must clear only the connector cursor")

-- Roblox setting writes may retain the last table identity and silently skip a
-- later write of that same mutated table. Every Forge transaction phase must
-- therefore cross the persistence boundary with a fresh immutable snapshot.
local identitySensitiveSettings = {}
local lastInput = nil
local identitySensitivePlugin = {}
function identitySensitivePlugin:GetSetting(key) return identitySensitiveSettings[key] end
function identitySensitivePlugin:SetSetting(key, value)
	if value ~= nil and value == lastInput then return end
	lastInput = value
	identitySensitiveSettings[key] = value
end
local openingCursor = {
	creatorSessionId = "creator_session_persistence",
	changeSetId = "creator_change_set_persistence",
	changeSetHash = string.rep("1", 64),
	projectionId = "studio_projection_persistence",
	projectionHash = string.rep("2", 64),
	manifestHash = Generated.manifestHash,
	preflightHash = string.rep("3", 64),
	beforeRevisionHash = string.rep("4", 64),
	recordingId = "pending_recording_persistence",
	opening = true,
	beforeStateProjection = { contentHash = string.rep("5", 64) },
}
local persistedOpening = StudioAuthoring.persistActiveForTest(identitySensitivePlugin, openingCursor)
local recordedCursor = table.clone(persistedOpening)
recordedCursor.recordingId = "recording_persistence"
recordedCursor.opening = nil
local persistedRecording = StudioAuthoring.persistActiveForTest(identitySensitivePlugin, recordedCursor)
assert(persistedRecording.recordingId == "recording_persistence" and persistedRecording.opening == nil, "the real recording id must replace opening intent before mutation")
assert(persistedOpening ~= openingCursor and persistedRecording ~= recordedCursor and persistedOpening ~= persistedRecording, "setting phases must use distinct immutable snapshots")

print("plugin module tests passed")
