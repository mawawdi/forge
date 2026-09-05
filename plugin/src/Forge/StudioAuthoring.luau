--!strict
-- Applies a sealed CreatorChangeSet only as a provisional ChangeHistory
-- transaction. Capability dispatch, values and codecs all come from the
-- generated manifest; this module owns only the transaction boundary.
local StudioAuthoring = {}
StudioAuthoring.__index = StudioAuthoring

local Generated = if script ~= nil then require(script.Parent.GeneratedStudioEvidence) else require("./GeneratedStudioEvidence")
local StudioScriptSource = if script ~= nil then require(script.Parent.StudioScriptSource) else require("./StudioScriptSource")
local Canonical = if script ~= nil then require(script.Parent.StudioProjectIndexCanonical) else require("./StudioProjectIndexCanonical")
local Constants = if script ~= nil then require(script.Parent.Constants) else require("./Constants")

local function changeHistoryService() return game:GetService("ChangeHistoryService") end
local function httpService() return game:GetService("HttpService") end
local function sha256(value: string): string
	local Hash = if script ~= nil then require(script.Parent.Hash) else require("./Hash")
	return Hash.sha256(value)
end

local function boundedWhole(value: any, minimum: number, maximum: number): boolean
	return typeof(value) == "number" and value % 1 == 0 and value >= minimum and value <= maximum
end

-- Failure diagnostics are evidence metadata, not unbounded transport text.
-- Keep the original Studio/codec error actionable while guaranteeing valid
-- UTF-8 and a fixed maximum before Runtime seals it into a protocol message.
local function boundedFailureDetail(value: any): string
	local detail = tostring(value)
	if utf8.len(detail) == nil then return "non_utf8_studio_failure" end
	if #detail <= 512 then return detail end
	local candidate = string.sub(detail, 1, 512)
	while #candidate > 0 and utf8.len(candidate) == nil do candidate = string.sub(candidate, 1, #candidate - 1) end
	return candidate == "" and "studio_failure_detail_truncated" or candidate
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

local function validateAuthoringContainerClass(path: any, observedClass: any, label: string)
	local expectedClass = Generated.authoringContainerClass(path)
	if expectedClass == nil then
		error(label .. " parent is not a generated authoring container")
	end
	if observedClass ~= expectedClass then
		error(label .. " engine-owned parent class mismatch: expected " .. expectedClass .. ", observed " .. tostring(observedClass))
	end
	return true
end

local function resolveAuthoringContainer(path: any, label: string): Instance
	local parent = resolvePath(path)
	if not parent then error(label .. " parent is missing or outside the generated authoring roots") end
	validateAuthoringContainerClass(path, parent.ClassName, label)
	return parent
end

local function validName(value: any)
	if typeof(value) ~= "string" or value == "" or #value > 100 or string.find(value, "/", 1, true) or value == "." or value == ".." then error("invalid instance name") end
end

local function classForOperation(operation: any): string
	if operation.kind == "create" then return operation.className end
	return operation.target.className
end

local function identityKey(identity: any): string
	local canonical = Generated.studioObjectIdentity(identity)
	if canonical.kind == "forge_attribute" then return "forge_attribute:" .. canonical.stableId end
	if canonical.kind == "studio_ephemeral" then return "studio_ephemeral:" .. canonical.connectorEpoch .. ":" .. canonical.opaqueHash end
	return "rojo_sourcemap:" .. canonical.authorityMapHash .. ":" .. canonical.sourcemapHash .. ":" .. canonical.mappingId
end

local function resolveExactTarget(target: any, registry, label: string): Instance
	if typeof(target) ~= "table" or typeof(target.path) ~= "string" or typeof(target.className) ~= "string" then error(label .. " target is malformed") end
	local identity = Generated.studioObjectIdentity(target.identity)
	local instance: Instance? = nil
	if typeof(identity) == "table" and identity.kind == "forge_attribute" then instance = registry:find(identity.stableId) end
	if typeof(identity) == "table" and identity.kind == "studio_ephemeral" then instance = registry:findOpaque(identity) end
	if typeof(identity) == "table" and identity.kind == "rojo_sourcemap" then error(label .. " Rojo target requires its filesystem authority adapter") end
	if not instance or pathOf(instance) ~= target.path or instance.ClassName ~= target.className then error(label .. " target precondition mismatch") end
	return instance
end

local function resolveExactParent(parent: any, registry, label: string): Instance
	if typeof(parent) ~= "table" or typeof(parent.kind) ~= "string" or typeof(parent.path) ~= "string" or typeof(parent.className) ~= "string" then error(label .. " parent is malformed") end
	if parent.kind == "engine_container" then return resolveAuthoringContainer(parent.path, label) end
	if parent.kind ~= "instance" then error(label .. " parent kind is malformed") end
	return resolveExactTarget(parent, registry, label .. " parent")
end

local function referenceResolver(registry, reference: any): Instance
	if typeof(reference) ~= "table" then error("Instance reference is malformed") end
	local instance = resolveExactTarget({ identity = reference.identity, path = reference.path, className = reference.className }, registry, "Instance reference")
	if not instance or pathOf(instance) ~= reference.path or instance.ClassName ~= reference.className then error("Instance reference precondition mismatch") end
	return instance
end

local function validateProperties(className: string, properties: any, registry, requireStudioPreflight: boolean?, resolveReference: ((any) -> Instance)?)
	if typeof(properties) ~= "table" then error("properties must be a table") end
	for _, name in ipairs(Generated.sortedMutationPropertyNames(className, properties)) do
		local value = properties[name]
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
			Generated.toStudio(metadata.codec, value, metadata, function(reference)
				if resolveReference ~= nil then return resolveReference(reference) end
				return referenceResolver(registry, reference)
			end)
		end
	end
end

-- A project-change listener may run synchronously from an engine setter or
-- later from ScriptEditorService.  Authoring therefore registers one exact
-- current-state matcher *before* each mutation.  The monitor owns when it is
-- used; this module owns the generated codecs and exact object handles needed
-- to decide whether a signal is the approved write or a concurrent edit.
local function reportExpectedMutationFact(onExpectedMutationFact: ((any) -> ())?, fact: any)
	if onExpectedMutationFact ~= nil then onExpectedMutationFact(fact) end
end

-- One Forge setter can notify once for its provisional result and again when
-- the exact same ChangeHistory recording is cancelled. Keep those allowances
-- phase-scoped: consuming the Apply notification must never discard the
-- cancellation matcher, while a later creator signal cannot reuse either.
local function exactMutationFact(source: string, instance: Instance, field: string?, matchesBefore: () -> boolean, matchesAfter: () -> boolean): any
	local payload = {
		source = source,
		instance = instance,
		field = field,
		matchesBefore = matchesBefore,
		matchesAfter = matchesAfter,
		beforeEventBudget = 1,
		afterEventBudget = 1,
	}
	return payload
end

local function referenceEncoder(registry, reference: Instance, property: any): any
	return {
		kind = "instance_ref",
		state = "reference",
		identity = registry:identityFor(reference),
		path = pathOf(reference),
		className = reference.ClassName,
		expectedClass = property.referenceClass,
	}
end


local function propertyMaterial(instance: Instance, propertyName: string, registry, encodeReference: ((Instance, any) -> any)?): string
	return Generated.canonicalValueMaterial(Generated.read(instance, propertyName, function(reference: Instance, property: any)
		if encodeReference ~= nil then return encodeReference(reference, property) end
		return referenceEncoder(registry, reference, property)
	end))
end

local function exactPropertyFact(instance: Instance, className: string, propertyName: string, expected: any, registry, encodeReference: ((Instance, any) -> any)?): any
	local metadata = Generated.propertyMetadata(className, propertyName)
	if not metadata then error("property is not writable in the generated manifest: " .. propertyName) end
	local before = propertyMaterial(instance, propertyName, registry, encodeReference)
	local after = Generated.canonicalValueMaterial(Generated.validateValue(metadata.codec, expected, metadata))
	return exactMutationFact("property", instance, propertyName, function() return propertyMaterial(instance, propertyName, registry, encodeReference) == before end, function() return propertyMaterial(instance, propertyName, registry, encodeReference) == after end)
end

local function attributeStateMaterial(value: any): string
	if value == nil then return "absent" end
	return Canonical.material(Generated.canonicalProjectAttribute(value))
end

local function exactAttributeFact(instance: Instance, attributeName: string, expected: any): any
	local before = attributeStateMaterial(instance:GetAttribute(attributeName))
	local after = attributeStateMaterial(expected)
	return exactMutationFact("attribute", instance, attributeName, function() return attributeStateMaterial(instance:GetAttribute(attributeName)) == before end, function() return attributeStateMaterial(instance:GetAttribute(attributeName)) == after end)
end

local function exactPropertyStateFact(instance: Instance, propertyName: string, beforeMatches: () -> boolean, afterMatches: () -> boolean): any
	return exactMutationFact("property", instance, propertyName, beforeMatches, afterMatches)
end

local function exactHierarchyFact(instance: Instance, event: string, beforeMatches: () -> boolean, afterMatches: () -> boolean): any
	return exactMutationFact("hierarchy", instance, event, beforeMatches, afterMatches)
end

local function sourceHash(instance: Instance): string
	local source = StudioScriptSource.read(instance)
	return sha256(source)
end

local function exactSourceFacts(instance: Instance, beforeHash: string, afterHash: string): {any}
	local beforeMatches = function() return sourceHash(instance) == beforeHash end
	local afterMatches = function() return sourceHash(instance) == afterHash end
	return {
		exactMutationFact("script_editor", instance, nil, beforeMatches, afterMatches),
		-- Studio can surface an editor-buffer write as either the document event
		-- or a Source property notification. They bind the same exact source
		-- hash and neither grants a path-wide or script-wide exemption.
		exactMutationFact("property", instance, "Source", beforeMatches, afterMatches),
	}
end

local function applyProperties(instance: Instance, className: string, properties: any, registry, onExpectedMutationFact: ((any) -> ())?, resolveReference: ((any) -> Instance)?, encodeReference: ((Instance, any) -> any)?, derivedValues: any?)
	if onExpectedMutationFact ~= nil then
		for _, name in ipairs(Generated.derivedMutationPropertyNames(className, properties)) do
			if derivedValues == nil or derivedValues[name] == nil then error("derived mutation property lacks final detached evidence: " .. name) end
			reportExpectedMutationFact(onExpectedMutationFact, exactPropertyFact(instance, className, name, derivedValues[name], registry, encodeReference))
		end
	end
	for _, name in ipairs(Generated.sortedMutationPropertyNames(className, properties)) do
		local value = properties[name]
		local metadata = Generated.propertyMetadata(className, name)
		if not metadata then error("property is not writable in the generated manifest: " .. tostring(name)) end
		-- Detached canaries may resolve an approved reference to another scratch
		-- instance which deliberately has no project identity. Exact monitor facts
		-- are only meaningful for live mutations, so do not encode scratch values
		-- through the live identity registry when no monitor callback was supplied.
		if onExpectedMutationFact ~= nil then reportExpectedMutationFact(onExpectedMutationFact, exactPropertyFact(instance, className, name, value, registry, encodeReference)) end
		Generated.write(instance, name, value, function(reference)
			if resolveReference ~= nil then return resolveReference(reference) end
			return referenceResolver(registry, reference)
		end)
	end
end

local function sortedAttributeNames(attributes: any): {string}
	if typeof(attributes) ~= "table" then error("attributes must be a table") end
	local names = {} :: {string}
	for name in pairs(attributes) do
		if typeof(name) ~= "string" then error("attribute name must be a string") end
		table.insert(names, name)
	end
	table.sort(names)
	return names
end

local function sortedRemovedAttributeNames(removed: any, attributes: any): {string}
	if typeof(removed) ~= "table" or #removed > Generated.manifest.attributes.maximumCount then error("removed attributes must be a bounded sequence") end
	local names = {} :: {string}
	local seen = {}
	for index, name in ipairs(removed) do
		if typeof(name) ~= "string" or seen[name] or attributes[name] ~= nil then error("removed attribute is invalid, repeated, or also set") end
		seen[name] = true
		names[index] = name
	end
	table.sort(names)
	return names
end

local function applyAttributes(instance: Instance, attributes: any, removed: any?, onExpectedMutationFact: ((any) -> ())?)
	local canonical = Generated.validateAttributes(attributes)
	for _, name in ipairs(sortedAttributeNames(canonical)) do
		local value = canonical[name]
		reportExpectedMutationFact(onExpectedMutationFact, exactAttributeFact(instance, name, value))
		instance:SetAttribute(name, value)
	end
	for _, name in ipairs(sortedRemovedAttributeNames(removed or {}, attributes)) do
		reportExpectedMutationFact(onExpectedMutationFact, exactAttributeFact(instance, name, nil))
		instance:SetAttribute(name, nil)
	end
end

local function validateRemovedAttributes(removed: any, attributes: any)
	sortedRemovedAttributeNames(removed, attributes)
end

-- Source edits are UTF-8 byte ranges because this is the only range domain
-- that remains deterministic across the dashboard, model tools, filesystem,
-- and ScriptEditorService. No caller supplies a replacement full document.
local function utf8Boundary(source: string, offset: any): boolean
	if typeof(offset) ~= "number" or offset % 1 ~= 0 or offset < 0 or offset > #source then return false end
	if offset == 0 or offset == #source then return true end
	return bit32.band(string.byte(source, offset + 1), 0xC0) ~= 0x80
end

local function applySourceEdits(source: string, edits: any, resolveBlob: (any) -> string): string
	if typeof(edits) ~= "table" or #edits < 1 or #edits > 1024 then error("source edits must be a non-empty bounded sequence") end
	local pieces, cursor = {}, 0
	for _, edit in ipairs(edits) do
		if typeof(edit) ~= "table" or typeof(edit.startByte) ~= "number" or typeof(edit.endByte) ~= "number" or typeof(edit.replacementBlob) ~= "table"
			or edit.startByte % 1 ~= 0 or edit.endByte % 1 ~= 0 or edit.startByte < cursor or edit.endByte < edit.startByte
			or not utf8Boundary(source, edit.startByte) or not utf8Boundary(source, edit.endByte)
		then error("source edits must be sorted, non-overlapping, in bounds, and UTF-8 aligned") end
		table.insert(pieces, string.sub(source, cursor + 1, edit.startByte))
		table.insert(pieces, resolveBlob(edit.replacementBlob))
		cursor = edit.endByte
	end
	table.insert(pieces, string.sub(source, cursor + 1))
	return table.concat(pieces)
end

local function validateExisting(operation: any, registry): Instance
	local instance = resolveExactTarget(operation.target, registry, "existing operation")
	if not Generated.classMetadata(instance.ClassName) then error("existing target class is outside the generated manifest") end
	return instance
end

-- Source-edit materialization has one implementation for validation, detached
-- preflight, and provisional apply. In particular, every path must resolve the
-- approved replacement blobs through the request-bound source-write store;
-- callers cannot accidentally hash an edit whose blob resolver was omitted.
local function validatedSourceEditMaterial(currentSource: string, operation: any, resolveBlob: (any) -> string): string
	if typeof(operation.beforeSourceHash) ~= "string" or sha256(currentSource) ~= operation.beforeSourceHash then error("source precondition mismatch") end
	local finalSource = applySourceEdits(currentSource, operation.edits, resolveBlob)
	Generated.validateSource(finalSource, true)
	if typeof(operation.finalSourceHash) ~= "string" or sha256(finalSource) ~= operation.finalSourceHash or typeof(operation.finalByteCount) ~= "number" or operation.finalByteCount ~= #finalSource then error("source edit result binding mismatch") end
	return finalSource
end

local function validatedSourceEdit(operation: any, registry, resolveBlob: (any) -> string): (Instance, string)
	local instance = validateExisting(operation, registry)
	local metadata = Generated.classMetadata(instance.ClassName)
	if not metadata or metadata.source == "forbidden" or not instance:IsA("LuaSourceContainer") then error("source capability is not in the generated manifest") end
	local finalSource = validatedSourceEditMaterial(StudioScriptSource.read(instance), operation, resolveBlob)
	return instance, finalSource
end

local function validateEnrollment(operation: any)
	if operation.enrollment == nil then return end
	if typeof(operation.enrollment) ~= "table" or typeof(operation.enrollment.stableId) ~= "string" or operation.enrollment.stableId == "" then error("identity enrollment is malformed") end
	if typeof(operation.target) ~= "table" or typeof(operation.target.identity) ~= "table" or operation.target.identity.kind ~= "studio_ephemeral" or identityKey(operation.enrollment.identity) ~= identityKey(operation.target.identity) then error("identity enrollment must bind the exact ephemeral target") end
end

local function applyEnrollment(operation: any, registry, onExpectedMutationFact: ((any) -> ())?)
	if operation.enrollment ~= nil then
		local instance = resolveExactTarget(operation.target, registry, "identity enrollment")
		reportExpectedMutationFact(onExpectedMutationFact, exactAttributeFact(instance, Constants.IDENTITY_ATTRIBUTE, operation.enrollment.stableId))
		if not registry:enrollOpaque(operation.enrollment.identity, operation.enrollment.stableId) then error("approved opaque identity enrollment failed") end
	end
end

local function sameTarget(left: any, right: any): boolean
	return typeof(left) == "table" and typeof(right) == "table"
		and typeof(left.identity) == "table" and typeof(right.identity) == "table"
		and identityKey(left.identity) == identityKey(right.identity)
		and left.path == right.path and left.className == right.className
end

local function topologyPostTarget(topology: any, target: any, label: string): any
	if typeof(topology) ~= "table" or typeof(topology.postTargets) ~= "table" or typeof(target) ~= "table" or typeof(target.identity) ~= "table" then error(label) end
	local post = topology.postTargets[identityKey(target.identity)]
	if post == nil or not sameTarget(post, target) then error(label) end
	return post
end

local function validatePreparedParent(parent: any, topology: any, registry, label: string)
	if typeof(parent) ~= "table" then error(label) end
	if parent.kind == "engine_container" then resolveExactParent(parent, registry, label); return end
	if parent.kind ~= "instance" then error(label) end
	local resolved = pcall(resolveExactParent, parent, registry, label)
	if resolved then return end
	if typeof(topology) ~= "table" or typeof(topology.createdTargetKeys) ~= "table" or typeof(parent.identity) ~= "table" then error(label) end
	local key = identityKey(parent.identity)
	if topology.createdTargetKeys[key] ~= true then error(label) end
	-- This verifies the exact final path/class of the virtual parent instead of
	-- merely accepting a matching identity. A stale display path cannot become
	-- authority just because its identity will be created later in the batch.
	topologyPostTarget(topology, { identity = parent.identity, path = parent.path, className = parent.className }, label)
end

-- Prepare validates a sealed transaction against the same virtual graph used
-- by the proof compiler. It intentionally does not resolve a just-created
-- parent or reference from the live registry: those identities become live
-- only after their canonical predecessor operation has run inside the one
-- recording. Existing targets and source buffers remain exact live checks.
local function validatePreparedOperation(operation: any, topology: any, registry, resolveBlob: (any) -> string)
	if typeof(operation) ~= "table" or typeof(operation.id) ~= "string" or operation.id == "" or typeof(operation.kind) ~= "string" then error("invalid creator operation") end
	if operation.kind == "create" then
		if typeof(operation.tempId) ~= "string" or operation.tempId == "" or typeof(operation.className) ~= "string" or typeof(operation.target) ~= "table" or typeof(operation.target.identity) ~= "table" or operation.target.identity.kind ~= "forge_attribute" then error("invalid create operation") end
		local metadata = Generated.classMetadata(operation.className)
		if not metadata or metadata.creatable ~= true then error("create class is not in the generated manifest") end
		validName(operation.name)
		topologyPostTarget(topology, operation.target, "create target is not the exact virtual post-state target")
		validatePreparedParent(operation.parent, topology, registry, "create parent precondition mismatch")
		validateProperties(operation.className, operation.properties, registry, false)
		Generated.validateAttributes(operation.attributes)
		if metadata.source ~= "forbidden" then Generated.validateSource(resolveBlob(operation.sourceBlob), true) elseif operation.sourceBlob ~= nil then error("non-script create cannot carry source blob") end
	elseif operation.kind == "update" then
		validateExisting(operation, registry)
		validateProperties(classForOperation(operation), operation.properties, registry, false); Generated.validateAttributes(operation.attributes); validateRemovedAttributes(operation.removedAttributes, operation.attributes); validateEnrollment(operation)
	elseif operation.kind == "move" then
		validateExisting(operation, registry); validName(operation.name)
		if typeof(topology) ~= "table" or typeof(topology.postTargets) ~= "table" or topology.postTargets[identityKey(operation.target.identity)] == nil then error("move target is absent from virtual post-state") end
		validatePreparedParent(operation.parent, topology, registry, "move parent precondition mismatch")
		validateProperties(classForOperation(operation), operation.properties, registry, false); Generated.validateAttributes(operation.attributes); validateRemovedAttributes(operation.removedAttributes, operation.attributes); validateEnrollment(operation)
	elseif operation.kind == "delete" then
		local instance = validateExisting(operation, registry)
		local descendants = instance:GetDescendants()
		if #descendants > Generated.manifest.limits.maximumProjectionFacts then error("delete subtree exceeds generated evidence bound") end
		validateEnrollment(operation)
	elseif operation.kind == "edit_source" then
		validatedSourceEdit(operation, registry, resolveBlob)
		validateEnrollment(operation)
	else
		error("operation kind is not in the generated manifest")
	end
end

-- At Apply, dependencies have already materialized in canonical order. Keep
-- the live precondition checks here: virtual topology proves what may exist;
-- it never weakens the freshly-read identity/path/class checks for objects
-- that already exist in Studio.
local function validateOperation(operation: any, registry, resolveBlob: (any) -> string, expectedPostTarget: any?, resolveReference: ((any) -> Instance)?)
	if typeof(operation) ~= "table" or typeof(operation.id) ~= "string" or operation.id == "" or typeof(operation.kind) ~= "string" then error("invalid creator operation") end
	if operation.kind == "create" then
		if typeof(operation.tempId) ~= "string" or operation.tempId == "" or typeof(operation.className) ~= "string" or typeof(operation.target) ~= "table" or typeof(operation.target.identity) ~= "table" or operation.target.identity.kind ~= "forge_attribute" then error("invalid create operation") end
		local metadata = Generated.classMetadata(operation.className)
		if not metadata or metadata.creatable ~= true then error("create class is not in the generated manifest") end
		validName(operation.name)
		local parent = resolveExactParent(operation.parent, registry, "create")
		if operation.target.className ~= operation.className then error("create target precondition mismatch") end
		if expectedPostTarget ~= nil then
			if not sameTarget(expectedPostTarget, operation.target) then error("create target does not match exact virtual post-state") end
		elseif operation.target.path ~= operation.parent.path .. "/" .. operation.name then
			error("create target precondition mismatch")
		end
		if parent:FindFirstChild(operation.name) then error("create target collides") end
		validateProperties(operation.className, operation.properties, registry, nil, resolveReference)
		Generated.validateAttributes(operation.attributes)
		if metadata.source ~= "forbidden" then Generated.validateSource(resolveBlob(operation.sourceBlob), true) elseif operation.sourceBlob ~= nil then error("non-script create cannot carry source blob") end
	elseif operation.kind == "update" then
		validateProperties(classForOperation(operation), operation.properties, registry, nil, resolveReference); Generated.validateAttributes(operation.attributes); validateRemovedAttributes(operation.removedAttributes, operation.attributes); validateExisting(operation, registry); validateEnrollment(operation)
	elseif operation.kind == "move" then
		local instance = validateExisting(operation, registry); validName(operation.name)
		local parent = resolveExactParent(operation.parent, registry, "move")
		local collision = parent:FindFirstChild(operation.name)
		if collision and collision ~= instance then error("move target collides") end
		validateProperties(classForOperation(operation), operation.properties, registry, nil, resolveReference); Generated.validateAttributes(operation.attributes); validateRemovedAttributes(operation.removedAttributes, operation.attributes); validateEnrollment(operation)
	elseif operation.kind == "delete" then
		local instance = validateExisting(operation, registry)
		local descendants = instance:GetDescendants()
		if #descendants > Generated.manifest.limits.maximumProjectionFacts then error("delete subtree exceeds generated evidence bound") end
		validateEnrollment(operation)
	elseif operation.kind == "edit_source" then
		validatedSourceEdit(operation, registry, resolveBlob)
		validateEnrollment(operation)
	else
		error("operation kind is not in the generated manifest")
	end
end

-- Create handles are private, detached instances allocated before a recording
-- begins. They never enter the DataModel until their canonical create
-- operation executes. This closes the mutual-reference case without allowing
-- an arbitrary object/path lookup or a partial place mutation before intent.
local function allocateCreatedHandles(operations: {any}, registry)
	local handles: any = { byOperationId = {}, byIdentity = {}, byInstance = {}, instances = {} }
	local function destroyDetached()
		for index = #handles.instances, 1, -1 do
			local instance = handles.instances[index]
			if instance.Parent == nil then instance:Destroy() end
		end
		handles.instances = {}
		handles.byOperationId = {}
		handles.byIdentity = {}
		handles.byInstance = {}
	end
	local created, failure = pcall(function()
		for _, operation in ipairs(operations) do
			if operation.kind == "create" then
				local key = identityKey(operation.target.identity)
				if handles.byIdentity[key] ~= nil then error("transaction create handles have duplicate identity") end
				local instance = Instance.new(operation.className)
				local handle = { instance = instance, target = operation.target }
				handles.byOperationId[operation.id] = handle
				handles.byIdentity[key] = handle
				handles.byInstance[instance] = handle
				table.insert(handles.instances, instance)
			end
		end
	end)
	if not created then destroyDetached(); error(failure) end
	function handles:instanceForOperation(operation: any): Instance
		local handle = self.byOperationId[operation.id]
		if handle == nil then error("transaction create handle is absent") end
		return handle.instance
	end
	function handles:resolveReference(reference: any): Instance
		if typeof(reference) ~= "table" or typeof(reference.identity) ~= "table" then error("transaction reference is malformed") end
		local handle = self.byIdentity[identityKey(reference.identity)]
		if handle ~= nil then
			if handle.target.path ~= reference.path or handle.target.className ~= reference.className or not handle.instance:IsA(reference.expectedClass) then error("transaction created reference precondition mismatch") end
			return handle.instance
		end
		return referenceResolver(registry, reference)
	end
	function handles:encodeReference(instance: Instance, property: any): any
		local handle = self.byInstance[instance]
		if handle ~= nil then
			return { kind = "instance_ref", state = "reference", identity = handle.target.identity, path = handle.target.path, className = handle.target.className, expectedClass = property.referenceClass }
		end
		return referenceEncoder(registry, instance, property)
	end
	function handles:destroyDetached()
		destroyDetached()
	end
	return handles
end

local function applyOperation(operation: any, registry, resolveBlob: (any) -> string, onExpectedMutationFact: ((any) -> ())?, createdHandles: any?, derivedValues: any?)
	local resolveReference = if createdHandles == nil then function(reference: any): Instance return referenceResolver(registry, reference) end else function(reference: any): Instance return createdHandles:resolveReference(reference) end
	local encodeReference = if createdHandles == nil then nil else function(reference: Instance, property: any): any return createdHandles:encodeReference(reference, property) end
	if operation.kind == "create" then
		if createdHandles == nil then error("creator create requires transaction-local handle allocation") end
		local instance = createdHandles:instanceForOperation(operation)
		local initialName = instance.Name
		reportExpectedMutationFact(onExpectedMutationFact, exactPropertyStateFact(instance, "Name", function() return instance.Name == initialName end, function() return instance.Name == operation.name end))
		instance.Name = operation.name
		local parentOk, parentOrFailure = pcall(resolveExactParent, operation.parent, registry, "create apply")
		if not parentOk then instance:Destroy(); error(parentOrFailure) end
		local parent = parentOrFailure :: Instance
		reportExpectedMutationFact(onExpectedMutationFact, exactPropertyStateFact(instance, "Parent", function() return instance.Parent == nil end, function() return instance.Parent == parent end))
		reportExpectedMutationFact(onExpectedMutationFact, exactHierarchyFact(instance, "added", function() return instance.Parent == nil end, function() return instance.Parent == parent and instance.Name == operation.name end))
		reportExpectedMutationFact(onExpectedMutationFact, exactHierarchyFact(instance, "removing", function() return instance.Parent == parent and instance.Name == operation.name end, function() return false end))
		instance.Parent = parent
		reportExpectedMutationFact(onExpectedMutationFact, exactAttributeFact(instance, Constants.IDENTITY_ATTRIBUTE, operation.target.identity.stableId))
		if not registry:enrollInstance(instance, operation.target.identity.stableId) then error("created instance is outside the generated identity scope") end
		-- A created object becomes an exact registry target before its approved
		-- properties are written. This is required for a self-reference and for
		-- later canonical operations to reference the created object; it remains
		-- inside the same visible recording and is cancelled with the create.
		applyProperties(instance, operation.className, operation.properties, registry, onExpectedMutationFact, resolveReference, encodeReference, derivedValues)
		applyAttributes(instance, operation.attributes, nil, onExpectedMutationFact)
		if Generated.classMetadata(operation.className).source ~= "forbidden" then
			local source = resolveBlob(operation.sourceBlob)
			for _, fact in ipairs(exactSourceFacts(instance, sha256(""), sha256(source))) do reportExpectedMutationFact(onExpectedMutationFact, fact) end
			local readback = StudioScriptSource.writeAndReadback(instance, sha256(""), sha256(source), source)
			if #readback ~= #source then error("created source write/readback byte count mismatch") end
		end
	elseif operation.kind == "update" then
		local instance = validateExisting(operation, registry)
		applyEnrollment(operation, registry, onExpectedMutationFact); applyProperties(instance, operation.target.className, operation.properties, registry, onExpectedMutationFact, resolveReference, encodeReference, derivedValues); applyAttributes(instance, operation.attributes, operation.removedAttributes, onExpectedMutationFact)
	elseif operation.kind == "move" then
		local instance = validateExisting(operation, registry)
		local parent = resolveExactParent(operation.parent, registry, "move apply")
		local oldParent, oldName = instance.Parent, instance.Name
		applyEnrollment(operation, registry, onExpectedMutationFact); applyProperties(instance, operation.target.className, operation.properties, registry, onExpectedMutationFact, resolveReference, encodeReference, derivedValues); applyAttributes(instance, operation.attributes, operation.removedAttributes, onExpectedMutationFact)
		reportExpectedMutationFact(onExpectedMutationFact, exactPropertyStateFact(instance, "Name", function() return instance.Name == oldName end, function() return instance.Name == operation.name end))
		instance.Name = operation.name
		reportExpectedMutationFact(onExpectedMutationFact, exactPropertyStateFact(instance, "Parent", function() return instance.Parent == oldParent end, function() return instance.Parent == parent end))
		-- The rename precedes the reparent. DescendantRemoving consequently sees
		-- the old parent with the approved new name, not the stale old name.
		reportExpectedMutationFact(onExpectedMutationFact, exactHierarchyFact(instance, "removing", function() return instance.Parent == parent and instance.Name == operation.name end, function() return instance.Parent == oldParent and instance.Name == operation.name end))
			-- ChangeHistory reverses the reparent before it reverses the rename.
			-- DescendantAdded during cancellation therefore sees the restored parent
			-- while the approved (new) name is still present.
			reportExpectedMutationFact(onExpectedMutationFact, exactHierarchyFact(instance, "added", function() return instance.Parent == oldParent and instance.Name == operation.name end, function() return instance.Parent == parent and instance.Name == operation.name end))
		instance.Parent = parent
	elseif operation.kind == "delete" then
		local instance = validateExisting(operation, registry)
		local oldParent, oldName = instance.Parent, instance.Name
		applyEnrollment(operation, registry, onExpectedMutationFact)
		reportExpectedMutationFact(onExpectedMutationFact, exactPropertyStateFact(instance, "Parent", function() return instance.Parent == oldParent end, function() return instance.Parent == nil end))
		reportExpectedMutationFact(onExpectedMutationFact, exactHierarchyFact(instance, "removing", function() return false end, function() return instance.Parent == oldParent and instance.Name == oldName end))
		reportExpectedMutationFact(onExpectedMutationFact, exactHierarchyFact(instance, "added", function() return instance.Parent == oldParent and instance.Name == oldName end, function() return false end))
		instance:Destroy()
	elseif operation.kind == "edit_source" then
		local instance, finalSource = validatedSourceEdit(operation, registry, resolveBlob)
		applyEnrollment(operation, registry, onExpectedMutationFact)
		for _, fact in ipairs(exactSourceFacts(instance, operation.beforeSourceHash, operation.finalSourceHash)) do reportExpectedMutationFact(onExpectedMutationFact, fact) end
		local readback = StudioScriptSource.writeAndReadback(instance, operation.beforeSourceHash, operation.finalSourceHash, finalSource)
		if sha256(readback) ~= operation.finalSourceHash or #readback ~= operation.finalByteCount then error("source edit readback mismatch") end
	end
end

local function canonicalOperations(changeSet: any, topology: any): {any}
	if typeof(changeSet) ~= "table" or typeof(changeSet.operations) ~= "table" or typeof(topology) ~= "table" or typeof(topology.canonicalOperationIds) ~= "table" then error("compiled transaction topology is malformed") end
	local byId, ordered = {}, {}
	for _, operation in ipairs(changeSet.operations) do
		if typeof(operation) ~= "table" or typeof(operation.id) ~= "string" or operation.id == "" or byId[operation.id] ~= nil then error("creator operation identities are malformed") end
		byId[operation.id] = operation
	end
	if #topology.canonicalOperationIds ~= #changeSet.operations then error("compiled transaction topology operation count mismatch") end
	for _, operationId in ipairs(topology.canonicalOperationIds) do
		local operation = byId[operationId]
		if operation == nil then error("compiled transaction topology references an unknown operation") end
		byId[operationId] = nil
		table.insert(ordered, operation)
	end
	if next(byId) ~= nil then error("compiled transaction topology omitted an operation") end
	return ordered
end

-- A detached graph mirrors only approved authoring targets. Its instances are
-- never parented into the DataModel, but a child may be parented to an
-- unparented scratch parent so that nested creates and reference-valued
-- properties exercise the same capability surface as the live batch.
local function detachedScratchGraph(prepared: any)
	local graph: any = { byIdentity = {}, instances = {} }
	local function register(target: any, instance: Instance)
		local key = identityKey(target.identity)
		local prior = graph.byIdentity[key]
		if prior ~= nil and prior ~= instance then error("detached graph has duplicate operation target") end
		graph.byIdentity[key] = instance
		local post = prepared.topology.postTargets[key]
		if post ~= nil then graph.byIdentity[identityKey(post.identity)] = instance end
	end
	function graph:instanceForTarget(target: any): Instance
		if typeof(target) ~= "table" or typeof(target.identity) ~= "table" then error("detached graph target is malformed") end
		local instance = self.byIdentity[identityKey(target.identity)]
		if instance == nil then error("detached graph has no approved target counterpart") end
		if instance.ClassName ~= target.className then error("detached graph target class mismatch") end
		return instance
	end
	function graph:resolveReference(reference: any): Instance
		if typeof(reference) ~= "table" or typeof(reference.identity) ~= "table" then error("detached graph reference is malformed") end
		local instance = self.byIdentity[identityKey(reference.identity)]
		if instance ~= nil then
			if instance.ClassName ~= reference.className or not instance:IsA(reference.expectedClass) then error("detached graph reference class mismatch") end
			return instance
		end
		return referenceResolver(prepared.registry, reference)
	end
	function graph:destroy()
		local failures = {}
		for index = #self.instances, 1, -1 do
			local destroyed, failure = pcall(function() self.instances[index]:Destroy() end)
			if not destroyed then table.insert(failures, boundedFailureDetail(failure)) end
		end
		self.instances = {}
		self.byIdentity = {}
		if #failures > 0 then error("detached graph cleanup failed: " .. table.concat(failures, "; ")) end
	end
	-- Allocate every authored non-delete target before applying its values. This
	-- is the detached analogue of the canonical live execution graph: all
	-- references resolve to their approved scratch counterpart, never to an
	-- unrelated live object or a generic path lookup.
	-- Check the complete batch before allocating anything. Engine-owned services
	-- cannot be tested by constructing another class or by writing the live service.
	for _, operation in ipairs(prepared.operations) do
		if operation.kind ~= "delete" then
			local metadata = Generated.classMetadata(classForOperation(operation))
			if metadata == nil or metadata.creatable ~= true or metadata.preflightStrategy ~= "detached_instance" then
				error("no admitted detached preflight strategy for " .. classForOperation(operation))
			end
		end
	end
	local allocated, allocationFailure = pcall(function()
		for _, operation in ipairs(prepared.operations) do
			if operation.kind ~= "delete" then
				local target = operation.target
				local instance = Instance.new(classForOperation(operation))
				-- Retain the handle before any operation that can fail so partial
				-- allocation cannot leak a scratch instance.
				table.insert(graph.instances, instance)
				instance.Name = if operation.kind == "create" then operation.name else target.path:match("([^/]+)$") or instance.Name
				register(target, instance)
				if operation.kind ~= "create" then
					local seeded = {}
					for _, name in ipairs(Generated.sortedMutationPropertyNames(classForOperation(operation), operation.properties or {})) do
						local seed = Generated.propertyMetadata(classForOperation(operation), name).setterFamilySeed
						if seed ~= nil and seed ~= name and not seeded[seed] then
							local value = nil
							for _, shard in ipairs(prepared.beforeProjectIndexCapture.shards) do
								for _, node in ipairs(shard.nodes) do
									if identityKey(node.identity) == identityKey(target.identity) then value = node.coveredProperties[seed] end
								end
							end
							if value == nil then error("detached family seed missing from bound before capture: " .. seed) end
							Generated.write(instance, seed, value)
							seeded[seed] = true
						end
					end
				end
			end
		end
		for _, operation in ipairs(prepared.operations) do
			if (operation.kind == "create" or operation.kind == "move") and typeof(operation.parent) == "table" and operation.parent.kind == "instance" then
				local child = graph:instanceForTarget(operation.target)
				local parent = graph.byIdentity[identityKey(operation.parent.identity)]
				if parent ~= nil then child.Parent = parent end
			end
		end
	end)
	if not allocated then
		local cleaned, cleanupFailure = pcall(function() graph:destroy() end)
		if not cleaned then error(boundedFailureDetail(allocationFailure) .. "; " .. boundedFailureDetail(cleanupFailure)) end
		error(allocationFailure)
	end
	return graph
end

-- Plugin settings are a JSON persistence boundary, not an in-memory table
-- store. Roblox documents both restricted setting keys and silent write
-- failure, so transaction keys contain no punctuation and every phase change
-- is written as a fresh immutable snapshot and read back before Studio may
-- cross the next mutation boundary.
-- These three keys are one schema boundary.  Never reuse a key when any
-- member's sealed shape changes: Studio settings outlive both `.forge` and an
-- installed connector, so reusing a predecessor key would make a clean host
-- reset ingest incompatible durable state.
local ACTIVE_RECORDING_SETTING = "ForgeCreatorTransactionCursorV6"
local FINALIZATION_RECEIPT_SETTING = "ForgeCreatorFinalizationReceiptV6"
local LAST_COMMIT_SETTING = "ForgeCreatorLastCommitV6"
local MAXIMUM_TRANSACTION_SETTING_MATERIAL_BYTES = 64 * 1024

local function nonEmptyBoundedString(value: any, maximum: number): boolean
	return typeof(value) == "string" and value ~= "" and #value <= maximum
end

local function exactHash(value: any): boolean
	return typeof(value) == "string" and #value == 64 and string.match(value, "^[0-9a-f]+$") ~= nil
end

local function exactKeys(value: any, required: {string}, optional: {string}?): boolean
	if typeof(value) ~= "table" then return false end
	local allowed, requiredSet = {}, {}
	for _, key in ipairs(required) do allowed[key] = true; requiredSet[key] = true end
	for _, key in ipairs(optional or {}) do allowed[key] = true end
	for key in pairs(value) do if typeof(key) ~= "string" or not allowed[key] then return false end end
	for key in pairs(requiredSet) do if value[key] == nil then return false end end
	return true
end

local function sameProject(left: any, right: any): boolean
	return typeof(left) == "table" and typeof(right) == "table"
		and left.name == right.name and left.placeId == right.placeId and left.universeId == right.universeId
end

local function canonicalRecoveryProjection(value: any, reboundConnectorEpoch: string?): any
	if not exactKeys(value, { "kind", "id", "hash", "manifestHash", "project", "connectorEpoch", "purpose", "roots", "bounds", "contentIdentity" })
		or value.kind ~= "StudioProjectIndexProjection"
		or value.manifestHash ~= Generated.manifestHash
		or value.purpose ~= "creator_project_index"
		or not exactHash(value.hash)
		or not exactHash(value.contentIdentity)
		or not nonEmptyBoundedString(value.id, 256)
		or not nonEmptyBoundedString(value.connectorEpoch, 256)
		or not exactKeys(value.project, { "name", "placeId", "universeId" })
		or not nonEmptyBoundedString(value.project.name, 1024)
		or not boundedWhole(value.project.placeId, 0, 9007199254740991)
		or not boundedWhole(value.project.universeId, 0, 9007199254740991)
		or typeof(value.roots) ~= "table"
		or #value.roots ~= #Generated.authoringRoots
		or not exactKeys(value.bounds, { "kind", "maximumInstances", "maximumCanonicalIndexBytes", "maximumSourceBlobBytes", "maximumIndexingDurationMs", "maximumNodesPerShard", "maximumCanonicalShardBytes", "transportChunkBytes" })
		or value.bounds.kind ~= "CreatorResourcePolicy"
		or value.bounds.maximumInstances ~= Constants.PROJECT_INDEX_MAXIMUM_INSTANCES
		or value.bounds.maximumCanonicalIndexBytes ~= Constants.PROJECT_INDEX_MAXIMUM_CANONICAL_BYTES
		or value.bounds.maximumSourceBlobBytes ~= Constants.PROJECT_INDEX_MAXIMUM_SOURCE_BLOB_BYTES
		or value.bounds.maximumIndexingDurationMs ~= Constants.PROJECT_INDEX_MAXIMUM_DURATION_MS
		or value.bounds.maximumNodesPerShard ~= Constants.PROJECT_INDEX_MAXIMUM_NODES_PER_SHARD
		or value.bounds.maximumCanonicalShardBytes ~= Constants.PROJECT_INDEX_MAXIMUM_SHARD_BYTES
		or value.bounds.transportChunkBytes ~= Constants.PROJECT_INDEX_TRANSPORT_CHUNK_BYTES
	then error("creator transaction recovery projection is malformed") end
	local roots = table.create(#Generated.authoringRoots)
	for index, root in ipairs(Generated.authoringRoots) do
		if value.roots[index] ~= root then error("creator transaction recovery projection root coverage mismatch") end
		roots[index] = root
	end
	local project = { name = value.project.name, placeId = value.project.placeId, universeId = value.project.universeId }
	local bounds = {
		kind = "CreatorResourcePolicy",
		maximumInstances = Constants.PROJECT_INDEX_MAXIMUM_INSTANCES,
		maximumCanonicalIndexBytes = Constants.PROJECT_INDEX_MAXIMUM_CANONICAL_BYTES,
		maximumSourceBlobBytes = Constants.PROJECT_INDEX_MAXIMUM_SOURCE_BLOB_BYTES,
		maximumIndexingDurationMs = Constants.PROJECT_INDEX_MAXIMUM_DURATION_MS,
		maximumNodesPerShard = Constants.PROJECT_INDEX_MAXIMUM_NODES_PER_SHARD,
		maximumCanonicalShardBytes = Constants.PROJECT_INDEX_MAXIMUM_SHARD_BYTES,
		transportChunkBytes = Constants.PROJECT_INDEX_TRANSPORT_CHUNK_BYTES,
	}
	local connectorEpoch = reboundConnectorEpoch or value.connectorEpoch
	if not nonEmptyBoundedString(connectorEpoch, 256) then error("creator transaction recovery connector epoch is malformed") end
	local semantic = {
		manifestHash = Generated.manifestHash,
		project = project,
		connectorEpoch = connectorEpoch,
		purpose = "creator_project_index",
		roots = roots,
		bounds = bounds,
	}
	local contentIdentity = sha256(Canonical.material(semantic))
	local projectionHash = sha256(Canonical.material({
		manifestHash = semantic.manifestHash,
		project = semantic.project,
		connectorEpoch = semantic.connectorEpoch,
		purpose = semantic.purpose,
		roots = semantic.roots,
		bounds = semantic.bounds,
		contentIdentity = contentIdentity,
	}))
	local canonical = {
		kind = "StudioProjectIndexProjection",
		id = "studio_project_index_projection_" .. string.sub(projectionHash, 1, 24),
		hash = projectionHash,
		manifestHash = semantic.manifestHash,
		project = semantic.project,
		connectorEpoch = semantic.connectorEpoch,
		purpose = semantic.purpose,
		roots = semantic.roots,
		bounds = semantic.bounds,
		contentIdentity = contentIdentity,
	}
	if reboundConnectorEpoch == nil and (
		value.id ~= canonical.id
		or value.hash ~= canonical.hash
		or value.contentIdentity ~= canonical.contentIdentity
		or not sameProject(value.project, canonical.project)
	) then error("creator transaction recovery projection identity mismatch") end
	return canonical
end

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

local function sameRecordingBinding(left: any, right: any): boolean
	return typeof(left) == "table" and typeof(right) == "table"
		and left.creatorSessionId == right.creatorSessionId
		and left.changeSetId == right.changeSetId
		and left.changeSetHash == right.changeSetHash
		and left.projectionId == right.projectionId
		and left.projectionHash == right.projectionHash
		and left.manifestHash == right.manifestHash
		and left.beforeProjectIndexManifestId == right.beforeProjectIndexManifestId
		and left.beforeProjectRevisionHash == right.beforeProjectRevisionHash
		and left.beforeProjectDetectorEpoch == right.beforeProjectDetectorEpoch
		and left.recordingId == right.recordingId
end

local function transactionCursorPayload(value: any): any
	if not exactKeys(value, {
		"kind", "creatorSessionId", "changeSetId", "changeSetHash", "manifestHash", "projectionId", "projectionHash",
		"preflightProjectionId", "preflightProjectionHash", "preflightHash", "beforeProjectIndexManifestId",
		"beforeProjectRevisionHash", "beforeProjectDetectorEpoch", "recordingId", "phase", "recoveryProjection",
	}, { "cursorHash", "finalization", "provisional", "recovery" })
		or value.kind ~= "ForgeCreatorTransactionCursor"
		or not nonEmptyBoundedString(value.creatorSessionId, 256)
		or not nonEmptyBoundedString(value.changeSetId, 256)
		or not exactHash(value.changeSetHash)
		or value.manifestHash ~= Generated.manifestHash
		or not nonEmptyBoundedString(value.projectionId, 256)
		or not exactHash(value.projectionHash)
		or not nonEmptyBoundedString(value.preflightProjectionId, 256)
		or not exactHash(value.preflightProjectionHash)
		or not exactHash(value.preflightHash)
		or not nonEmptyBoundedString(value.beforeProjectIndexManifestId, 256)
		or not exactHash(value.beforeProjectRevisionHash)
		or not boundedWhole(value.beforeProjectDetectorEpoch, 0, 9007199254740991)
		or not nonEmptyBoundedString(value.recordingId, 512)
		or (value.phase ~= "opening" and value.phase ~= "open" and value.phase ~= "finalization_intent" and value.phase ~= "finalization_finished")
	then error("creator transaction cursor is malformed") end
	local projection = canonicalRecoveryProjection(value.recoveryProjection)
	local payload: any = {
		kind = "ForgeCreatorTransactionCursor",
		creatorSessionId = value.creatorSessionId,
		changeSetId = value.changeSetId,
		changeSetHash = value.changeSetHash,
		manifestHash = value.manifestHash,
		projectionId = value.projectionId,
		projectionHash = value.projectionHash,
		preflightProjectionId = value.preflightProjectionId,
		preflightProjectionHash = value.preflightProjectionHash,
		preflightHash = value.preflightHash,
		beforeProjectIndexManifestId = value.beforeProjectIndexManifestId,
		beforeProjectRevisionHash = value.beforeProjectRevisionHash,
		beforeProjectDetectorEpoch = value.beforeProjectDetectorEpoch,
		recordingId = value.recordingId,
		phase = value.phase,
		recoveryProjection = projection,
	}
	if value.phase == "finalization_intent" or value.phase == "finalization_finished" then
		if not exactKeys(value.finalization, { "action", "finalizationKind" }, { "failedApply", "recovery", "replacesAction", "failureCode", "expectedCurrentProjectIndexManifestId", "expectedCurrentProjectRevisionHash", "expectedCurrentProjectDetectorEpoch" })
			or (value.finalization.action ~= "commit" and value.finalization.action ~= "cancel")
			or (value.finalization.finalizationKind ~= "ordinary" and value.finalization.finalizationKind ~= "recovery_cancel")
			or (value.finalization.failedApply ~= nil and value.finalization.failedApply ~= true)
			or (value.finalization.recovery ~= nil and value.finalization.recovery ~= true)
			or (value.finalization.replacesAction ~= nil and value.finalization.replacesAction ~= "commit" and value.finalization.replacesAction ~= "cancel")
			or (value.finalization.failureCode ~= nil and not nonEmptyBoundedString(value.finalization.failureCode, 512))
		then error("creator transaction finalization state is malformed") end
		local hasExpectedCurrent = value.finalization.expectedCurrentProjectIndexManifestId ~= nil
			or value.finalization.expectedCurrentProjectRevisionHash ~= nil
			or value.finalization.expectedCurrentProjectDetectorEpoch ~= nil
		if hasExpectedCurrent and (
			not nonEmptyBoundedString(value.finalization.expectedCurrentProjectIndexManifestId, 256)
			or not exactHash(value.finalization.expectedCurrentProjectRevisionHash)
			or not boundedWhole(value.finalization.expectedCurrentProjectDetectorEpoch, 0, 9007199254740991)
		) then error("creator transaction finalization expected-current binding is malformed") end
		if value.finalization.finalizationKind == "recovery_cancel" and (value.finalization.action ~= "cancel" or value.finalization.recovery ~= true or value.finalization.replacesAction == nil) then
			error("creator transaction recovery cancellation provenance is malformed")
		end
		if value.finalization.finalizationKind == "ordinary" and (value.finalization.recovery ~= nil or value.finalization.replacesAction ~= nil) then
			error("creator transaction ordinary finalization provenance is malformed")
		end
		payload.finalization = { action = value.finalization.action, finalizationKind = value.finalization.finalizationKind }
		if value.finalization.failedApply == true then payload.finalization.failedApply = true end
		if value.finalization.recovery == true then payload.finalization.recovery = true end
		if value.finalization.replacesAction ~= nil then payload.finalization.replacesAction = value.finalization.replacesAction end
		if value.finalization.failureCode ~= nil then payload.finalization.failureCode = value.finalization.failureCode end
		if hasExpectedCurrent then
			payload.finalization.expectedCurrentProjectIndexManifestId = value.finalization.expectedCurrentProjectIndexManifestId
			payload.finalization.expectedCurrentProjectRevisionHash = value.finalization.expectedCurrentProjectRevisionHash
			payload.finalization.expectedCurrentProjectDetectorEpoch = value.finalization.expectedCurrentProjectDetectorEpoch
		end
	elseif value.finalization ~= nil then error("creator transaction cursor has finalization metadata outside finalization") end
	if value.provisional ~= nil then
		if not exactKeys(value.provisional, { "directReadbackEvidenceHash", "postApplyProjectIndexManifestId", "postApplyProjectRevisionHash", "postApplyProjectDetectorEpoch" })
			or not exactHash(value.provisional.directReadbackEvidenceHash)
			or not nonEmptyBoundedString(value.provisional.postApplyProjectIndexManifestId, 256)
			or not exactHash(value.provisional.postApplyProjectRevisionHash)
			or not boundedWhole(value.provisional.postApplyProjectDetectorEpoch, 0, 9007199254740991)
		then error("creator transaction provisional binding is malformed") end
		payload.provisional = {
			directReadbackEvidenceHash = value.provisional.directReadbackEvidenceHash,
			postApplyProjectIndexManifestId = value.provisional.postApplyProjectIndexManifestId,
			postApplyProjectRevisionHash = value.provisional.postApplyProjectRevisionHash,
			postApplyProjectDetectorEpoch = value.provisional.postApplyProjectDetectorEpoch,
		}
	end
	if value.recovery ~= nil then
		if not exactKeys(value.recovery, { "projectIndexManifestId", "projectRevisionHash", "projectDetectorEpoch" })
			or not nonEmptyBoundedString(value.recovery.projectIndexManifestId, 256)
			or not exactHash(value.recovery.projectRevisionHash)
			or not boundedWhole(value.recovery.projectDetectorEpoch, 0, 9007199254740991)
		then error("creator transaction recovery binding is malformed") end
		payload.recovery = {
			projectIndexManifestId = value.recovery.projectIndexManifestId,
			projectRevisionHash = value.recovery.projectRevisionHash,
			projectDetectorEpoch = value.recovery.projectDetectorEpoch,
		}
	end
	return payload
end

local function sealTransactionCursor(value: any): any
	local payload = transactionCursorPayload(value)
	local sealed = table.clone(payload)
	sealed.cursorHash = sha256(Canonical.material(payload))
	if #Canonical.material(sealed) > MAXIMUM_TRANSACTION_SETTING_MATERIAL_BYTES then error("creator transaction cursor exceeds its durable bound") end
	return sealed
end

local function assertTransactionCursor(value: any): any
	local sealed = sealTransactionCursor(value)
	if value.cursorHash ~= sealed.cursorHash then error("creator transaction cursor hash mismatch") end
	return sealed
end

local function sameActiveCursor(left: any, right: any): boolean
	local leftOk, leftCursor = pcall(function() return assertTransactionCursor(left) end)
	local rightOk, rightCursor = pcall(function() return assertTransactionCursor(right) end)
	return leftOk and rightOk and Canonical.material(leftCursor) == Canonical.material(rightCursor)
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

local function activeSetting(plugin: Plugin): any
	local stored = plugin:GetSetting(ACTIVE_RECORDING_SETTING)
	if stored == nil then return nil end
	return assertTransactionCursor(stored)
end
local function setActive(plugin: Plugin, active: any?): any
	local sealed = nil
	if active ~= nil then sealed = sealTransactionCursor(active) end
	return persistSetting(plugin, ACTIVE_RECORDING_SETTING, sealed, sameActiveCursor, "active recording")
end

-- Crossing into ChangeHistory is permitted only after the exact opening
-- intent survived a Plugin settings JSON round trip. Keeping this boundary in
-- one function makes it impossible for a caller (or a future refactor) to
-- invoke TryBeginRecording on the failed-persistence branch.
local function beginRecordingAfterDurableIntent(plugin: Plugin, binding: any, beginRecording: () -> any): (boolean, any, any, boolean)
	local opening = sealTransactionCursor(binding)
	if opening.phase ~= "opening" then error("creator recording opening intent is malformed") end
	local intentPersisted, intentOrFailure = pcall(function() return setActive(plugin, opening) end)
	if not intentPersisted then return false, opening, intentOrFailure, false end
	local persisted = intentOrFailure
	local opened, recordingOrFailure = pcall(beginRecording)
	if not opened or typeof(recordingOrFailure) ~= "string" or recordingOrFailure == "" then
		return false, persisted, recordingOrFailure, true
	end
	return true, persisted, recordingOrFailure, true
end

local function finalizationReceiptPayload(value: any): any
	if not exactKeys(value, {
		"kind", "creatorSessionId", "changeSetId", "changeSetHash", "projectionId", "projectionHash", "manifestHash",
		"beforeProjectIndexManifestId", "beforeProjectRevisionHash", "beforeProjectDetectorEpoch", "recordingId", "action", "status",
		"afterProjectIndexManifestId", "afterProjectRevisionHash", "afterProjectDetectorEpoch", "expectedCurrentProjectIndexManifestId",
		"expectedCurrentProjectRevisionHash", "expectedCurrentProjectDetectorEpoch", "finalizationKind",
	}, { "replacesAction", "receiptHash" })
		or value.kind ~= "CreatorChangeFinalizationReceipt"
		or not nonEmptyBoundedString(value.creatorSessionId, 256)
		or not nonEmptyBoundedString(value.changeSetId, 256)
		or not exactHash(value.changeSetHash)
		or not nonEmptyBoundedString(value.projectionId, 256)
		or not exactHash(value.projectionHash)
		or value.manifestHash ~= Generated.manifestHash
		or not nonEmptyBoundedString(value.beforeProjectIndexManifestId, 256)
		or not exactHash(value.beforeProjectRevisionHash)
		or not boundedWhole(value.beforeProjectDetectorEpoch, 0, 9007199254740991)
		or not nonEmptyBoundedString(value.recordingId, 512)
		or (value.action ~= "commit" and value.action ~= "cancel")
		or value.status ~= (value.action == "commit" and "committed" or "cancelled")
		or not nonEmptyBoundedString(value.afterProjectIndexManifestId, 256)
		or not exactHash(value.afterProjectRevisionHash)
		or not boundedWhole(value.afterProjectDetectorEpoch, 0, 9007199254740991)
		or not nonEmptyBoundedString(value.expectedCurrentProjectIndexManifestId, 256)
		or not exactHash(value.expectedCurrentProjectRevisionHash)
		or not boundedWhole(value.expectedCurrentProjectDetectorEpoch, 0, 9007199254740991)
		or (value.finalizationKind ~= "ordinary" and value.finalizationKind ~= "recovery_cancel")
		or (value.replacesAction ~= nil and value.replacesAction ~= "commit" and value.replacesAction ~= "cancel")
		or (value.finalizationKind == "recovery_cancel" and value.replacesAction == nil)
		or (value.finalizationKind == "ordinary" and value.replacesAction ~= nil)
	then error("creator finalization receipt is malformed") end
	local payload = {
		kind = "CreatorChangeFinalizationReceipt",
		creatorSessionId = value.creatorSessionId,
		changeSetId = value.changeSetId,
		changeSetHash = value.changeSetHash,
		projectionId = value.projectionId,
		projectionHash = value.projectionHash,
		manifestHash = value.manifestHash,
		beforeProjectIndexManifestId = value.beforeProjectIndexManifestId,
		beforeProjectRevisionHash = value.beforeProjectRevisionHash,
		beforeProjectDetectorEpoch = value.beforeProjectDetectorEpoch,
		recordingId = value.recordingId,
		action = value.action,
		status = value.status,
		afterProjectIndexManifestId = value.afterProjectIndexManifestId,
		afterProjectRevisionHash = value.afterProjectRevisionHash,
		afterProjectDetectorEpoch = value.afterProjectDetectorEpoch,
		expectedCurrentProjectIndexManifestId = value.expectedCurrentProjectIndexManifestId,
		expectedCurrentProjectRevisionHash = value.expectedCurrentProjectRevisionHash,
		expectedCurrentProjectDetectorEpoch = value.expectedCurrentProjectDetectorEpoch,
		finalizationKind = value.finalizationKind,
	}
	if value.replacesAction ~= nil then payload.replacesAction = value.replacesAction end
	return payload
end

local function sealFinalizationReceipt(value: any): any
	local payload = finalizationReceiptPayload(value)
	local sealed = table.clone(payload)
	sealed.receiptHash = sha256(Canonical.material(payload))
	if #Canonical.material(sealed) > MAXIMUM_TRANSACTION_SETTING_MATERIAL_BYTES then error("creator finalization receipt exceeds its durable bound") end
	return sealed
end

local function assertFinalizationReceipt(value: any): any
	local sealed = sealFinalizationReceipt(value)
	if value.receiptHash ~= sealed.receiptHash then error("creator finalization receipt hash mismatch") end
	return sealed
end

local function finalizationReceipt(plugin: Plugin): any
	local stored = plugin:GetSetting(FINALIZATION_RECEIPT_SETTING)
	if stored == nil then return nil end
	return assertFinalizationReceipt(stored)
end

-- A finalization action is a two-step durable state machine. The intent is
-- synchronously read back before Studio receives FinishRecording. A successful
-- Finish return is not completion: only a subsequent exact readback proving
-- that the recording is closed may advance the durable cursor to finished. A
-- restart seeing intent cannot know whether the engine call began, so it
-- remains recovery-required and is never allowed to retry a Studio mutation.
local function beginFinalization(plugin: Plugin, binding: any, action: string, metadata: any?): any
	local current = assertTransactionCursor(binding)
	if current.phase ~= "open" or (action ~= "commit" and action ~= "cancel") then error("finalization intent is malformed") end
	local intent = table.clone(current)
	intent.cursorHash = nil
	intent.phase = "finalization_intent"
	local finalization: any = { action = action, finalizationKind = "ordinary" }
	if typeof(metadata) == "table" then
		if metadata.failedApply == true then finalization.failedApply = true end
		if metadata.recovery == true then finalization.recovery = true end
		if metadata.finalizationKind ~= nil then
			if metadata.finalizationKind ~= "ordinary" and metadata.finalizationKind ~= "recovery_cancel" then error("finalization kind is malformed") end
			finalization.finalizationKind = metadata.finalizationKind
		end
		if metadata.replacesAction ~= nil then
			if metadata.replacesAction ~= "commit" and metadata.replacesAction ~= "cancel" then error("finalization replacement action is malformed") end
			finalization.replacesAction = metadata.replacesAction
		end
		if typeof(metadata.failureCode) == "string" and metadata.failureCode ~= "" then finalization.failureCode = metadata.failureCode end
		local hasExpectedCurrent = metadata.expectedCurrentProjectIndexManifestId ~= nil
			or metadata.expectedCurrentProjectRevisionHash ~= nil
			or metadata.expectedCurrentProjectDetectorEpoch ~= nil
		if hasExpectedCurrent then
			if not nonEmptyBoundedString(metadata.expectedCurrentProjectIndexManifestId, 256)
				or not exactHash(metadata.expectedCurrentProjectRevisionHash)
				or not boundedWhole(metadata.expectedCurrentProjectDetectorEpoch, 0, 9007199254740991)
			then error("finalization expected-current binding is malformed") end
			finalization.expectedCurrentProjectIndexManifestId = metadata.expectedCurrentProjectIndexManifestId
			finalization.expectedCurrentProjectRevisionHash = metadata.expectedCurrentProjectRevisionHash
			finalization.expectedCurrentProjectDetectorEpoch = metadata.expectedCurrentProjectDetectorEpoch
		end
	end
	-- Evidence-failure cancellation follows a durably persisted provisional
	-- capture, so preserve that capture as its pre-Finish authority rather than
	-- deriving a new expectation from the later post-cancel collection.
	if finalization.expectedCurrentProjectIndexManifestId == nil and typeof(current.provisional) == "table" then
		finalization.expectedCurrentProjectIndexManifestId = current.provisional.postApplyProjectIndexManifestId
		finalization.expectedCurrentProjectRevisionHash = current.provisional.postApplyProjectRevisionHash
		finalization.expectedCurrentProjectDetectorEpoch = current.provisional.postApplyProjectDetectorEpoch
	end
	-- A failed Apply can be cancelled before a post-Apply capture exists. Its
	-- only valid pre-Finish authority is the complete pre-Apply capture bound to
	-- the cursor before TryBeginRecording, never a later post-cancel inventory.
	if finalization.expectedCurrentProjectIndexManifestId == nil then
		finalization.expectedCurrentProjectIndexManifestId = current.beforeProjectIndexManifestId
		finalization.expectedCurrentProjectRevisionHash = current.beforeProjectRevisionHash
		finalization.expectedCurrentProjectDetectorEpoch = current.beforeProjectDetectorEpoch
	end
	intent.finalization = finalization
	return setActive(plugin, intent)
end

-- A closure failure after the original Finish is not permission to replay that
-- action. If Studio later proves the exact recording is still open, a creator
-- may authorize one distinct recovery cancellation. Its durable intent retains
-- the replaced action and the recovery gate, so it cannot be confused with a
-- retry of the original commit/cancel.
local function beginRecoveryCancellation(plugin: Plugin, binding: any, expected: any): any
	local current = assertTransactionCursor(binding)
	if current.phase ~= "finalization_intent"
		or typeof(current.finalization) ~= "table"
		or current.finalization.recovery == true
		or (current.finalization.action ~= "commit" and current.finalization.action ~= "cancel")
		or typeof(current.recovery) ~= "table"
	then error("recovery cancellation intent is malformed") end
	if typeof(expected) ~= "table"
		or expected.projectIndexManifestId ~= current.recovery.projectIndexManifestId
		or expected.projectRevisionHash ~= current.recovery.projectRevisionHash
		or expected.projectDetectorEpoch ~= current.recovery.projectDetectorEpoch
	then error("recovery cancellation expected-current binding mismatch") end
	local replacement = table.clone(current)
	replacement.cursorHash = nil
	replacement.finalization = {
		action = "cancel",
		recovery = true,
		finalizationKind = "recovery_cancel",
		replacesAction = current.finalization.action,
		expectedCurrentProjectIndexManifestId = current.recovery.projectIndexManifestId,
		expectedCurrentProjectRevisionHash = current.recovery.projectRevisionHash,
		expectedCurrentProjectDetectorEpoch = current.recovery.projectDetectorEpoch,
	}
	return setActive(plugin, replacement)
end

-- This proof is deliberately created only by closeAndPersistFinalization after
-- ChangeHistoryService has answered that this exact recording is closed. It
-- prevents a future direct caller from treating a nonthrowing FinishRecording
-- call as durable finalization.
local function closedRecordingProof(intent: any, recordingId: string): any
	local current = assertTransactionCursor(intent)
	if current.phase ~= "finalization_intent"
		or typeof(current.recordingId) ~= "string"
		or current.recordingId ~= recordingId
		or typeof(current.cursorHash) ~= "string"
	then error("closed recording proof is malformed") end
	return {
		intentCursorHash = current.cursorHash,
		recordingId = recordingId,
	}
end

local function finishFinalization(plugin: Plugin, intent: any, proof: any): any
	local current = assertTransactionCursor(intent)
	if current.phase ~= "finalization_intent"
		or typeof(current.finalization) ~= "table"
		or typeof(proof) ~= "table"
		or proof.intentCursorHash ~= current.cursorHash
		or proof.recordingId ~= current.recordingId
	then error("finalization completion is malformed") end
	local finished = table.clone(current)
	finished.cursorHash = nil
	finished.phase = "finalization_finished"
	return setActive(plugin, finished)
end

local function sameFinalizationReceipt(left: any, right: any): boolean
	local leftOk, leftReceipt = pcall(function() return assertFinalizationReceipt(left) end)
	local rightOk, rightReceipt = pcall(function() return assertFinalizationReceipt(right) end)
	return leftOk and rightOk and Canonical.material(leftReceipt) == Canonical.material(rightReceipt)
end

local function setFinalizationReceipt(plugin: Plugin, receipt: any?): any
	local sealed = nil
	if receipt ~= nil then sealed = sealFinalizationReceipt(receipt) end
	return persistSetting(plugin, FINALIZATION_RECEIPT_SETTING, sealed, sameFinalizationReceipt, "finalization receipt")
end

local function setLastCommit(plugin: Plugin, receipt: any?): any
	local sealed = nil
	if receipt ~= nil then sealed = sealFinalizationReceipt(receipt) end
	return persistSetting(plugin, LAST_COMMIT_SETTING, sealed, sameFinalizationReceipt, "last commit")
end

local function decodedSealed(payload: any, field: string, hashField: string, expectedKind: string): any
	if typeof(payload[field]) ~= "string" or typeof(payload[hashField]) ~= "string" or sha256(payload[field]) ~= payload[hashField] then error(field .. " transport binding mismatch") end
	local ok, value = pcall(function() return httpService():JSONDecode(payload[field]) end)
	if not ok or typeof(value) ~= "table" or value.kind ~= expectedKind then error(field .. " is malformed") end
	return value
end

local function validateStudioMutationAuthority(changeSet: any): boolean
	if typeof(changeSet) ~= "table" or changeSet.mutationAuthority ~= "studio_document" then
		error("Studio authoring accepts only studio_document mutation authority")
	end
	return true
end

-- Consequential delete descendants are project-index structure obligations,
-- not authored targets. They may use platform classes outside Forge's closed
-- writable manifest, so detached preflight must never try to construct them.
-- The generated recompiler proves that every such target is an exact indexed
-- descendant; only an authorable delete root needs the create/destroy canary.
local function requiresDetachedStructureCanary(target: any): boolean
	if typeof(target) ~= "table" or typeof(target.className) ~= "string" or target.className == "" then
		error("detached structure canary target is malformed")
	end
	local metadata = Generated.classMetadata(target.className)
	return metadata ~= nil and metadata.creatable == true and metadata.preflightStrategy == "detached_instance"
end

local function exactProjectionBinding(projection: any, payload: any, changeSet: any, revision: string, collector): boolean
	if typeof(projection) ~= "table" or typeof(projection.binding) ~= "table" or typeof(projection.project) ~= "table" then return false end
	local project = collector:identity()
	local expectedBinding = {
		sessionId = payload.creatorSessionId,
		changeSetHash = changeSet.hash,
		approvalHash = payload.approvalHash,
		revisionHash = revision,
		buildHash = changeSet.buildContractHash,
		dashboardReviewHash = payload.dashboardReviewHash,
	}
	return projection.manifestHash == Generated.manifestHash
		and projection.project.name == project.name and projection.project.placeId == project.placeId and projection.project.universeId == project.universeId
		and changeSet.hash == payload.changeSetHash
		and revision == payload.expectedProjectRevisionHash
		and Generated.matchesStudioCreatorMutationBinding(projection.binding, expectedBinding)
end

function StudioAuthoring.new(plugin: Plugin, registry, collector)
	return setmetatable({ plugin = plugin, registry = registry, collector = collector, prepared = nil, prepareTransfer = nil, active = nil, lastFailure = nil, recordingFinishObserver = nil, sourceWriteRequestId = nil, sourceWrites = {} }, StudioAuthoring)
end

local function blobHash(value: any): string
	return sha256(Canonical.material(value))
end

local function sameSourceBinding(left: any, right: any): boolean
	return typeof(left) == "table" and typeof(right) == "table"
		and left.manifestId == right.manifestId and left.manifestHash == right.manifestHash
		and left.sourceHash == right.sourceHash and left.utf8Bytes == right.utf8Bytes
end

local function materializeSourceWriteCapture(capture: any, binding: any): string
	if typeof(capture) ~= "table" or not sameSourceBinding(capture.binding, binding) then error("source-write blob binding is absent or inconsistent") end
	local pieces = {}
	local bytes = 0
	for ordinal, chunk in ipairs(capture.chunks) do
		if chunk.ordinal ~= ordinal - 1 or chunk.sourceHash ~= binding.sourceHash or chunk.startByte ~= bytes or chunk.endByte < chunk.startByte or typeof(chunk.utf8) ~= "string" or #chunk.utf8 ~= chunk.endByte - chunk.startByte then error("source-write blob chunks are incomplete or unordered") end
		if blobHash({ sourceHash = chunk.sourceHash, ordinal = chunk.ordinal, startByte = chunk.startByte, endByte = chunk.endByte, utf8 = chunk.utf8 }) ~= chunk.hash then error("source-write blob chunk hash mismatch") end
		table.insert(pieces, chunk.utf8); bytes = chunk.endByte
	end
	local source = table.concat(pieces)
	if bytes ~= binding.utf8Bytes or #source ~= binding.utf8Bytes or sha256(source) ~= binding.sourceHash then error("source-write blob final hash mismatch") end
	return source
end

local function resolvedSourceWrite(self, binding: any): string
	if typeof(binding) ~= "table" or typeof(binding.manifestId) ~= "string" or typeof(binding.manifestHash) ~= "string" or typeof(binding.sourceHash) ~= "string" or typeof(binding.utf8Bytes) ~= "number" then error("source-write blob binding is malformed") end
	local capture = self.sourceWrites[binding.manifestHash]
	if typeof(capture) ~= "table" or capture.state ~= "accepted" then error("source-write blob is absent or incomplete before Prepare") end
	return materializeSourceWriteCapture(capture, binding)
end

local function clearSourceWriteTransaction(self)
	self.sourceWriteRequestId = nil
	self.sourceWrites = {}
end

local function prepareTransferId(documentHash: string): string
	return "creator_prepare_transfer_" .. string.sub(documentHash, 1, 24)
end

local function validPrepareBoundary(payload: any): boolean
	return typeof(payload) == "table"
		and typeof(payload.requestId) == "string" and payload.requestId ~= ""
		and typeof(payload.documentHash) == "string" and string.match(payload.documentHash, "^[0-9a-f]+$") ~= nil and #payload.documentHash == 64
		and payload.transferId == prepareTransferId(payload.documentHash)
		and boundedWhole(payload.utf8Bytes, 1, Constants.PROJECT_INDEX_MAXIMUM_CANONICAL_BYTES)
		and boundedWhole(payload.pieceCount, 1, Constants.MAX_PROJECT_INDEX_PIECES)
		and payload.pieceCount >= math.ceil(payload.utf8Bytes / Constants.BACKEND_COMMAND_TRANSPORT_CHUNK_BYTES)
		and payload.pieceCount <= math.ceil(payload.utf8Bytes / (Constants.BACKEND_COMMAND_TRANSPORT_CHUNK_BYTES - 3))
end

local function newPrepareTransferCapture(payload: any): any
	if not validPrepareBoundary(payload) then error("creator Prepare transfer start is malformed") end
	return {
		requestId = payload.requestId,
		transferId = payload.transferId,
		documentHash = payload.documentHash,
		utf8Bytes = payload.utf8Bytes,
		pieceCount = payload.pieceCount,
		parts = {},
		nextSequence = 0,
		receivedBytes = 0,
	}
end

local function appendPrepareTransferFragment(capture: any, payload: any)
	if typeof(capture) ~= "table" or typeof(payload) ~= "table"
		or payload.requestId ~= capture.requestId or payload.transferId ~= capture.transferId or payload.documentHash ~= capture.documentHash
		or payload.encoding ~= "json" or not boundedWhole(payload.sequence, 0, capture.pieceCount - 1) or payload.sequence ~= capture.nextSequence
		or typeof(payload.payload) ~= "string" or #payload.payload < 1 or #payload.payload > Constants.BACKEND_COMMAND_TRANSPORT_CHUNK_BYTES
		or typeof(payload.payloadHash) ~= "string" or sha256(payload.payload) ~= payload.payloadHash
		or capture.receivedBytes + #payload.payload > capture.utf8Bytes
	then error("creator Prepare fragment request, ordering, size, or hash mismatch") end
	table.insert(capture.parts, payload.payload)
	capture.nextSequence += 1
	capture.receivedBytes += #payload.payload
end

local function completePrepareTransferMaterial(capture: any, payload: any): string
	if typeof(capture) ~= "table" or not validPrepareBoundary(payload)
		or payload.requestId ~= capture.requestId or payload.transferId ~= capture.transferId or payload.documentHash ~= capture.documentHash
		or payload.utf8Bytes ~= capture.utf8Bytes or payload.pieceCount ~= capture.pieceCount
		or capture.nextSequence ~= capture.pieceCount or capture.receivedBytes ~= capture.utf8Bytes or #capture.parts ~= capture.pieceCount
	then error("creator Prepare completion binding is incomplete or inconsistent") end
	local serialized = table.concat(capture.parts)
	if #serialized ~= capture.utf8Bytes or sha256(serialized) ~= capture.documentHash then error("creator Prepare document hash mismatch") end
	return serialized
end

local function preparedPayload(prepared: any): any
	return { creatorSessionId = prepared.changeSet.sessionId, changeSetId = prepared.changeSet.id, changeSetHash = prepared.changeSet.hash, manifestHash = Generated.manifestHash, projectionId = prepared.projection.id, projectionHash = prepared.projection.contentHash, preflightProjectionId = prepared.preflightProjection.id, preflightProjectionHash = prepared.preflightProjection.contentHash, beforeProjectIndexManifestId = prepared.beforeProjectIndexManifestId, beforeProjectRevisionHash = prepared.beforeProjectRevisionHash, beforeProjectDetectorEpoch = prepared.beforeProjectDetectorEpoch, status = "prepared" }
end

local function acceptSourceWriteCapture(capture: any, binding: any, materialize: (any, any) -> string): string
	if typeof(capture) ~= "table" or capture.state ~= "receiving" then error("source-write capture cannot cross the acceptance boundary") end
	local source = materialize(capture, binding)
	capture.state = "accepted"
	return source
end

local function sourceWriteAcceptedPayload(capture: any, requestId: string): any
	return { requestId = requestId, manifestId = capture.binding.manifestId, manifestHash = capture.binding.manifestHash, sourceHash = capture.binding.sourceHash, utf8Bytes = capture.binding.utf8Bytes, status = "accepted" }
end

function StudioAuthoring:beginPrepareTransfer(payload: any)
	if self:hasPossibleRecording() then error("creator Prepare transfer is not allowed while a creator recording may be active") end
	local nextTransfer = newPrepareTransferCapture(payload)
	if self.prepared ~= nil then
		if self.prepared.requestId == nextTransfer.requestId then error("creator Prepare transfer cannot restart after Prepare") end
		self.prepared = nil
		clearSourceWriteTransaction(self)
	elseif self.sourceWriteRequestId ~= nil and self.sourceWriteRequestId ~= nextTransfer.requestId then
		clearSourceWriteTransaction(self)
	end
	if self.prepareTransfer ~= nil then
		if self.prepareTransfer.requestId == nextTransfer.requestId then error("creator Prepare transfer is duplicated") end
		self.prepareTransfer = nil
	end
	self.prepareTransfer = nextTransfer
end

function StudioAuthoring:appendPrepareTransferChunk(payload: any)
	if not self.prepareTransfer then error("creator Prepare fragment has no started transfer") end
	appendPrepareTransferFragment(self.prepareTransfer, payload)
end

function StudioAuthoring:completePrepareTransfer(payload: any, beforeCapture: any): any
	if typeof(payload) ~= "table" then error("creator Prepare completion is malformed") end
	-- CreatorChangePrepared is a semantic receipt sent before the enclosing
	-- command settlement. If that POST fails, redelivery of the exact
	-- completion command must reproduce the receipt without parsing or mutating
	-- Studio a second time.
	if self.prepareTransfer == nil and self.prepared ~= nil then
		if validPrepareBoundary(payload)
			and self.prepared.requestId == payload.requestId
			and self.prepared.prepareTransferId == payload.transferId
			and self.prepared.prepareDocumentHash == payload.documentHash
			and self.prepared.prepareDocumentBytes == payload.utf8Bytes
			and self.prepared.preparePieceCount == payload.pieceCount
		then
			return preparedPayload(self.prepared)
		end
		error("creator Prepare completion has no matching transfer")
	end
	local serialized = completePrepareTransferMaterial(self.prepareTransfer, payload)
	local decoded, document = pcall(function() return httpService():JSONDecode(serialized) end)
	if not decoded or typeof(document) ~= "table" or document.requestId ~= payload.requestId then error("creator Prepare document is malformed") end
	local result = self:prepare(document, beforeCapture)
	self.prepared.prepareTransferId = payload.transferId
	self.prepared.prepareDocumentHash = payload.documentHash
	self.prepared.prepareDocumentBytes = payload.utf8Bytes
	self.prepared.preparePieceCount = payload.pieceCount
	self.prepareTransfer = nil
	return result
end

function StudioAuthoring:beginSourceWrite(payload: any)
	if self:hasPossibleRecording() then error("source-write stream is not allowed while a creator recording may be active") end
	if typeof(payload) ~= "table" or typeof(payload.requestId) ~= "string" or typeof(payload.manifest) ~= "table" or not boundedWhole(payload.pieceCount, 1, Constants.MAX_PROJECT_INDEX_PIECES) then error("source-write stream start is malformed") end
	-- Prepared state is mutation-free and process-local. A later exact request may
	-- abandon it safely, but messages from two request IDs must never share a
	-- source graph or smuggle an acknowledgement across transactions.
	if self.prepared ~= nil then
		if self.prepared.requestId == payload.requestId then error("source-write stream cannot restart after Prepare") end
		self.prepared = nil
		clearSourceWriteTransaction(self)
	elseif self.sourceWriteRequestId ~= nil and self.sourceWriteRequestId ~= payload.requestId then
		clearSourceWriteTransaction(self)
	end
	if self.prepareTransfer ~= nil then
		if self.prepareTransfer.requestId == payload.requestId then error("source-write stream cannot begin after creator Prepare transfer") end
		self.prepareTransfer = nil
	end
	local manifest = payload.manifest
	-- pieceCount counts JSON transport fragments, not source bytes. JSON escaping
	-- can expand a source body and even an empty source has one canonical chunk;
	-- therefore no sound upper bound can be derived from manifest.utf8Bytes.
	-- Exact fragment, artifact, sequence, byte-count, and body hashes are checked
	-- by appendSourceWriteChunk/completeSourceWrite below.
	if manifest.kind ~= "CreatorSourceWriteBlobManifest" or typeof(manifest.id) ~= "string" or typeof(manifest.hash) ~= "string" or typeof(manifest.sourceHash) ~= "string" or not boundedWhole(manifest.utf8Bytes, 0, Generated.manifest.source.maximumUtf8Bytes) or typeof(manifest.chunkHashes) ~= "table" or #manifest.chunkHashes < 1 or #manifest.chunkHashes > Constants.MAX_PROJECT_INDEX_PIECES or payload.pieceCount < #manifest.chunkHashes then error("source-write manifest is malformed") end
	if manifest.utf8Bytes > Generated.manifest.source.maximumUtf8Bytes then error("source-write manifest exceeds declared source bound") end
	if blobHash({ sourceHash = manifest.sourceHash, utf8Bytes = manifest.utf8Bytes, chunkHashes = manifest.chunkHashes }) ~= manifest.hash then error("source-write manifest hash mismatch") end
	if self.sourceWrites[manifest.hash] ~= nil then error("source-write manifest is duplicated within one request") end
	self.sourceWriteRequestId = payload.requestId
	self.sourceWrites[manifest.hash] = { requestId = payload.requestId, binding = { manifestId = manifest.id, manifestHash = manifest.hash, sourceHash = manifest.sourceHash, utf8Bytes = manifest.utf8Bytes }, manifest = manifest, chunks = {}, fragments = {}, nextSequence = 0, pieceCount = payload.pieceCount, state = "receiving" }
end

function StudioAuthoring:appendSourceWriteChunk(payload: any)
	if typeof(payload) ~= "table" or typeof(payload.requestId) ~= "string" or typeof(payload.manifestId) ~= "string" or not boundedWhole(payload.sequence, 0, Constants.MAX_PROJECT_INDEX_PIECES - 1) or typeof(payload.artifact) ~= "table" or payload.artifact.kind ~= "CreatorSourceWriteBlobChunk" or not boundedWhole(payload.fragmentOrdinal, 0, 255) or not boundedWhole(payload.fragmentCount, 1, 256) or payload.fragmentOrdinal >= payload.fragmentCount or payload.encoding ~= "json" or typeof(payload.payload) ~= "string" or #payload.payload < 1 or #payload.payload > Constants.BACKEND_COMMAND_TRANSPORT_CHUNK_BYTES or typeof(payload.payloadHash) ~= "string" then error("source-write fragment is malformed") end
	local capture: any = nil
	for _, candidate in pairs(self.sourceWrites) do if candidate.manifest.id == payload.manifestId then capture = candidate break end end
	if not capture or capture.requestId ~= payload.requestId or capture.state ~= "receiving" or payload.sequence ~= capture.nextSequence or sha256(payload.payload) ~= payload.payloadHash then error("source-write fragment request, ordering, or hash mismatch") end
	local artifactHash = payload.artifact.hash
	local assembly = capture.fragments[artifactHash]
	if assembly == nil then assembly = { id = payload.artifact.id, count = payload.fragmentCount, parts = {}, received = 0 }; capture.fragments[artifactHash] = assembly end
	if assembly.id ~= payload.artifact.id or assembly.count ~= payload.fragmentCount or assembly.parts[payload.fragmentOrdinal + 1] ~= nil then error("source-write fragment is duplicate or inconsistent") end
	assembly.parts[payload.fragmentOrdinal + 1] = payload.payload; assembly.received += 1; capture.nextSequence += 1
	if assembly.received == assembly.count then
		local serialized = table.concat(assembly.parts)
		local decodedOk, chunk = pcall(function() return httpService():JSONDecode(serialized) end)
		if not decodedOk or typeof(chunk) ~= "table" or chunk.kind ~= "CreatorSourceWriteBlobChunk" or chunk.id ~= payload.artifact.id or chunk.hash ~= artifactHash then error("source-write chunk decode mismatch") end
		if #capture.chunks ~= chunk.ordinal or capture.manifest.chunkHashes[chunk.ordinal + 1] ~= chunk.hash then error("source-write chunk ordinal mismatch") end
		table.insert(capture.chunks, chunk)
	end
end

function StudioAuthoring:completeSourceWrite(payload: any): any
	if typeof(payload) ~= "table" or typeof(payload.requestId) ~= "string" or typeof(payload.manifestHash) ~= "string" or typeof(payload.manifestId) ~= "string" or typeof(payload.sourceHash) ~= "string" or not boundedWhole(payload.utf8Bytes, 0, Generated.manifest.source.maximumUtf8Bytes) or not boundedWhole(payload.pieceCount, 1, Constants.MAX_PROJECT_INDEX_PIECES) then error("source-write completion is malformed") end
	local capture = self.sourceWrites[payload.manifestHash]
	if not capture or capture.requestId ~= payload.requestId or capture.state ~= "receiving" or capture.manifest.id ~= payload.manifestId or capture.binding.sourceHash ~= payload.sourceHash or capture.binding.utf8Bytes ~= payload.utf8Bytes or capture.pieceCount ~= payload.pieceCount or capture.nextSequence ~= capture.pieceCount or #capture.chunks ~= #capture.manifest.chunkHashes then error("source-write completion binding mismatch") end
	for _, assembly in pairs(capture.fragments) do if assembly.received ~= assembly.count then error("source-write completion has incomplete fragments") end end
	-- Validate the assembled body while the capture is still receiving. Only a
	-- successfully materialized body may cross the one-way acceptance boundary.
	-- resolvedSourceWrite deliberately accepts only the resulting state.
	acceptSourceWriteCapture(capture, capture.binding, materializeSourceWriteCapture)
	return sourceWriteAcceptedPayload(capture, payload.requestId)
end

-- Runtime installs this observer only after the project-change monitor is
-- live. It receives an opaque ChangeHistory recording id immediately before a
-- Forge-owned settle and again with `false` if that API call fails. The
-- monitor can therefore suppress exactly one matching OnRecordingFinished
-- signal without hiding unrelated edits.
function StudioAuthoring:setRecordingFinishObserver(observer: ((string, boolean) -> ())?)
	if observer ~= nil and typeof(observer) ~= "function" then error("recording finish observer is malformed") end
	self.recordingFinishObserver = observer
end

-- A finalization authority read is intentionally part of the one closure
-- primitive, rather than an obligation imposed on each commit/cancel caller.
-- The intent has already been persisted when this runs; a failure therefore
-- leaves it recoverable and, crucially, cannot race into FinishRecording.
local function requirePreFinishGate(beforeFinish: ((any) -> ())?, intent: any): (boolean, any?)
	if beforeFinish == nil then return false, "finalization gate is required" end
	local passed, failure = pcall(function() beforeFinish(intent) end)
	return passed, failure
end

-- Finishing a recording is not proof that Studio closed it. This primitive
-- calls FinishRecording exactly once and then requires a nonthrowing boolean
-- IsRecordingInProgress readback of false. Any other result leaves the durable
-- finalization intent in place for explicit recovery; it must never retry.
local function finishAndProveRecordingClosed(
	recordingId: string,
	callFinish: () -> any,
	readOpen: () -> any,
	notify: ((boolean) -> ())?
): (boolean, any)
	if typeof(recordingId) ~= "string" or recordingId == "" then error("recording closure id is malformed") end
	if notify ~= nil then notify(true) end
	local finished, finishResult = pcall(callFinish)
	if not finished then
		if notify ~= nil then notify(false) end
		return false, "FinishRecording failed: " .. tostring(finishResult)
	end
	local read, stillOpen = pcall(readOpen)
	if not read then
		if notify ~= nil then notify(false) end
		return false, "recording closure readback failed: " .. tostring(stillOpen)
	end
	if typeof(stillOpen) ~= "boolean" then
		if notify ~= nil then notify(false) end
		return false, "recording closure readback was not boolean"
	end
	if stillOpen then
		if notify ~= nil then notify(false) end
		return false, "recording remains open after FinishRecording"
	end
	-- The expected-finish allowance is only for the synchronous engine callback
	-- surrounding this exact call. Once the readback has completed, retain no
	-- suppression entry: a delayed or unrelated future finish must be observed
	-- as an external change rather than hidden indefinitely.
	if notify ~= nil then notify(false) end
	return true, finishResult
end

-- A finalization_finished cursor can be written only by this shared closure.
-- It is used by normal commit/cancel, failed application/evidence cancellation,
-- and explicit recovery cancellation so those paths cannot diverge.
local function closeAndPersistFinalization(
	plugin: Plugin,
	intent: any,
	recordingId: string,
	callFinish: () -> any,
	readOpen: () -> any,
	notify: ((boolean) -> ())?,
	beforeFinish: ((any) -> ())?
): (boolean, any)
	local gatePassed, gateFailure = requirePreFinishGate(beforeFinish, intent)
	if not gatePassed then
		return false, "finalization gate rejected before FinishRecording: " .. tostring(gateFailure)
	end
	local closed, closeResult = finishAndProveRecordingClosed(recordingId, callFinish, readOpen, notify)
	if not closed then return false, closeResult end
	local proof = closedRecordingProof(intent, recordingId)
	local persisted, persistedOrFailure = pcall(function()
		return finishFinalization(plugin, intent, proof)
	end)
	if not persisted then
		return false, "finalization finished persistence failed: " .. tostring(persistedOrFailure)
	end
	return true, persistedOrFailure
end

function StudioAuthoring:closeRecordingAndPersistFinalization(intent: any, recordingId: string, operation: any, beforeFinish: ((any) -> ())?): (boolean, any)
	return closeAndPersistFinalization(
		self.plugin,
		intent,
		recordingId,
		function() return changeHistoryService():FinishRecording(recordingId, operation) end,
		function() return changeHistoryService():IsRecordingInProgress(recordingId) end,
		if self.recordingFinishObserver == nil then nil else function(settling: boolean)
			self.recordingFinishObserver(recordingId, settling)
		end,
		beforeFinish
	)
end

local function possibleRecording(active: any, stored: any, observeAnyRecording: () -> boolean): boolean
	if active ~= nil or typeof(stored) == "table" then return true end
	-- The durable cursor is the only recording Forge can identify and recover,
	-- but it is not the only way an engine recording can exist. In particular,
	-- a clean-break connector deliberately does not read predecessor setting
	-- schemas. Refuse to prepare while ChangeHistoryService reports any unbound
	-- recording (or cannot answer), so a connector upgrade can never overlap an
	-- older open transaction even though it cannot reinterpret that old cursor.
	local checked, open = pcall(observeAnyRecording)
	return not checked or open == true
end

function StudioAuthoring:hasPossibleRecording(): boolean
	return possibleRecording(self.active, activeSetting(self.plugin), function()
		return changeHistoryService():IsRecordingInProgress()
	end)
end

local function exactRecordingState(recordingId: any, readOpen: () -> any): string
	if typeof(recordingId) ~= "string" or recordingId == "" then return "unknown" end
	local read, open = pcall(readOpen)
	if not read or typeof(open) ~= "boolean" then return "unknown" end
	return if open then "open" else "not_open"
end

function StudioAuthoring:recovery()
	local active = activeSetting(self.plugin)
	if typeof(active) ~= "table" then return { recordingState = "not_open" } end
	-- An intent survives every uncertain Finish boundary. Read the exact opaque
	-- id on re-pair, but never replay its original action: an open result may
	-- enable one separately authorized recovery cancellation; a closed result
	-- may only clear this stale cursor; an unavailable read stays fail-closed.
	if active.phase == "finalization_intent" then
		local recordingState = exactRecordingState(active.recordingId, function()
			return changeHistoryService():IsRecordingInProgress(active.recordingId)
		end)
		return {
			recordingState = recordingState,
			recording = active,
			recoveryCancellationAvailable = recordingState == "open" and active.finalization.recovery ~= true,
		}
	end
	if active.phase == "finalization_finished" then return { recordingState = "not_open", recording = active } end
	-- A process may stop after the durable opening intent but before
	-- TryBeginRecording returns its opaque recording id.  Forge cannot prove
	-- that no recording opened, so this is deliberately recovery-required and
	-- never triggers an automatic Studio operation.
	if active.phase == "opening" then return { recordingState = "unknown", recording = active } end
	if active.phase ~= "open" then return { recordingState = "unknown", recording = active } end
	return {
		recordingState = exactRecordingState(active.recordingId, function()
			return changeHistoryService():IsRecordingInProgress(active.recordingId)
		end),
		recording = active,
	}
end

-- A recovery collection must use the exact persisted read contract, rebound to
-- the newly paired connector epoch. The cursor never stores project shards or
-- source bodies, and display paths are never reconstructed into authority.
function StudioAuthoring:recoveryProjectIndexProjection(recording: any, connectorEpoch: string): any
	local cursor = assertTransactionCursor(recording)
	local project = self.collector:identity()
	if not sameProject(cursor.recoveryProjection.project, project) then
		error("RECOVERY_REQUIRED: persisted creator transaction belongs to another Studio project")
	end
	return canonicalRecoveryProjection(cursor.recoveryProjection, connectorEpoch)
end

function StudioAuthoring:recordRecoveryEvidence(indexManifestId: string, projectRevisionHash: string, projectDetectorEpoch: number)
	local active = activeSetting(self.plugin)
	if typeof(active) ~= "table" or typeof(indexManifestId) ~= "string" or typeof(projectRevisionHash) ~= "string" or not boundedWhole(projectDetectorEpoch, 0, 9007199254740991) then error("recording recovery index binding rejected") end
	local updated = table.clone(active)
	updated.cursorHash = nil
	updated.recovery = { projectIndexManifestId = indexManifestId, projectRevisionHash = projectRevisionHash, projectDetectorEpoch = projectDetectorEpoch }
	local persisted = setActive(self.plugin, updated)
	if self.active then self.active.binding = persisted end
end

local function acknowledgeClosedRecording(plugin: Plugin, payload: any, recordingState: string): any
	local stored = activeSetting(plugin)
	if recordingState ~= "not_open"
		or typeof(payload) ~= "table"
		or typeof(stored) ~= "table"
		or not sameRecordingBinding(payload, stored)
	or typeof(stored.recovery) ~= "table"
	or payload.recoveryProjectIndexManifestId ~= stored.recovery.projectIndexManifestId
	or payload.recoveryProjectRevisionHash ~= stored.recovery.projectRevisionHash
		or payload.recoveryProjectDetectorEpoch ~= stored.recovery.projectDetectorEpoch
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
	return finalizationReceipt(self.plugin)
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
	if typeof(post.indexManifest) ~= "table" or typeof(post.indexManifest.id) ~= "string" then error("post-apply project index has no manifest id") end
	if typeof(post.revision) ~= "table" or typeof(post.revision.hash) ~= "string" then error("post-apply project index has no complete revision") end
	if not boundedWhole(post.detectorEpoch, 0, 9007199254740991) then error("post-apply project index has no detector epoch") end
	local updated = table.clone(stored)
	updated.cursorHash = nil
	updated.provisional = {
		directReadbackEvidenceHash = direct.contentHash,
		postApplyProjectIndexManifestId = post.indexManifest.id,
		postApplyProjectRevisionHash = post.revision.hash,
		postApplyProjectDetectorEpoch = post.detectorEpoch,
	}
	active.binding = setActive(self.plugin, updated)
end

-- Prepare is pure with respect to Studio: it checks exact payload/projection
-- bindings and reconstructs the mutation projection before consent proceeds.
function StudioAuthoring:prepare(payload: any, beforeCapture: any)
	if self:hasPossibleRecording() then error("RECOVERY_REQUIRED: a recording may already be open") end
	-- A settled receipt does not make Studio recording state ambiguous, so it is
	-- deliberately excluded from hasPossibleRecording.  It still prevents a new
	-- transaction until the coordinator has durably recorded and acknowledged
	-- the exact prior finalization; otherwise two finalizations could contend for
	-- the single receipt slot after a transport interruption.
	if self:hasPendingFinalizationReceipt() then error("creator prepare requires acknowledgement of the prior finalization receipt") end
	if typeof(payload) ~= "table" or typeof(payload.requestId) ~= "string" or typeof(beforeCapture) ~= "table" or typeof(beforeCapture.indexManifest) ~= "table" or typeof(beforeCapture.revision) ~= "table" or not boundedWhole(beforeCapture.detectorEpoch, 0, 9007199254740991) or payload.expectedProjectRevisionHash ~= beforeCapture.revision.hash or payload.beforeProjectRevisionHash ~= beforeCapture.revision.hash or payload.beforeProjectIndexManifestId ~= beforeCapture.indexManifest.id or payload.beforeProjectDetectorEpoch ~= beforeCapture.detectorEpoch or payload.manifestHash ~= Generated.manifestHash then error("creator prepare binding mismatch") end
	-- A failed preflight never opens a recording, so a later request may replace
	-- its transient prepared/source state. This also covers a source-free next
	-- request, which has no blob-start message on which to perform the reset.
	if self.prepared ~= nil then
		if self.prepared.requestId == payload.requestId then error("creator Prepare is duplicated") end
		self.prepared = nil
		clearSourceWriteTransaction(self)
	elseif self.sourceWriteRequestId ~= nil and self.sourceWriteRequestId ~= payload.requestId then
		clearSourceWriteTransaction(self)
	end
	local changeSet = decodedSealed(payload, "changeSetJson", "changeSetJsonHash", "CreatorChangeSet")
	validateStudioMutationAuthority(changeSet)
	local projection = decodedSealed(payload, "projectionJson", "projectionJsonHash", "StudioEvidenceProjection")
	local preflightProjection = decodedSealed(payload, "preflightProjectionJson", "preflightProjectionJsonHash", "StudioEvidenceProjection")
	Generated.validateProjection(projection)
	Generated.validateProjection(preflightProjection)
	if projection.contentHash ~= payload.projectionHash or preflightProjection.contentHash ~= payload.preflightProjectionHash then error("creator projection semantic hash mismatch") end
	if projection.manifestHash ~= Generated.manifestHash or projection.purpose ~= "mutation_direct_readback" or preflightProjection.purpose ~= "mutation_preflight" then error("mutation projection manifest or purpose mismatch") end
	if changeSet.id ~= payload.changeSetId or changeSet.hash ~= payload.changeSetHash or changeSet.sessionId ~= payload.creatorSessionId or changeSet.expectedRevisionHash ~= beforeCapture.revision.hash or changeSet.localGate.status ~= "eligible" or typeof(changeSet.operations) ~= "table" or #changeSet.operations < 1 or #changeSet.operations > Generated.manifest.limits.maximumOperations then error("creator change set rejected") end
	if typeof(changeSet.sourceWriteBlobs) ~= "table" then error("creator change set has no source-write evidence bindings") end
	if #changeSet.sourceWriteBlobs > 0 and self.sourceWriteRequestId ~= payload.requestId then error("creator change set source-write request binding is absent") end
	if #changeSet.sourceWriteBlobs == 0 and next(self.sourceWrites) ~= nil then error("source-free creator change set has unexpected source-write evidence") end
	local declaredWrites = {}
	for _, binding in ipairs(changeSet.sourceWriteBlobs) do
		if typeof(binding) ~= "table" or declaredWrites[binding.manifestHash] or not self.sourceWrites[binding.manifestHash] or self.sourceWrites[binding.manifestHash].requestId ~= payload.requestId or not sameSourceBinding(self.sourceWrites[binding.manifestHash].binding, binding) then error("creator change set source-write binding is absent or duplicated") end
		resolvedSourceWrite(self, binding); declaredWrites[binding.manifestHash] = true
	end
	for _, operation in ipairs(changeSet.operations) do
		if operation.kind == "create" and operation.sourceBlob ~= nil and not declaredWrites[operation.sourceBlob.manifestHash] then error("creator create source blob is not declared") end
		if operation.kind == "edit_source" then for _, edit in ipairs(operation.edits) do if not declaredWrites[edit.replacementBlob.manifestHash] then error("creator edit source blob is not declared") end end end
	end
	if not exactProjectionBinding(projection, payload, changeSet, beforeCapture.revision.hash, self.collector) or not exactProjectionBinding(preflightProjection, payload, changeSet, beforeCapture.revision.hash, self.collector) then error("creator projection binding mismatch") end
	-- Recompile from the sealed change set using generated manifest dispatch and
	-- require exact material/hash equality.  Validation alone is insufficient:
	-- a syntactically valid projection must not omit, add, or retarget proof
	-- obligations before Apply.
	local topology = Generated.compileMutationTransactionTopologyFromIndex(changeSet, beforeCapture)
	Generated.assertRecompiledMutationProjectionFromIndex(changeSet, projection, beforeCapture)
	Generated.assertRecompiledMutationProjectionFromIndex(changeSet, preflightProjection, beforeCapture)
	local operationIds, planChangeIds, targetIds, createPaths = {}, {}, {}, {}
	for _, operation in ipairs(changeSet.operations) do
		if operationIds[operation.id] or typeof(operation.planChangeId) ~= "string" or planChangeIds[operation.planChangeId] then error("operation identity binding is not unique") end
		operationIds[operation.id] = true; planChangeIds[operation.planChangeId] = true
		if operation.kind == "create" then
			local key = tostring(operation.tempId) .. ":" .. tostring(operation.parent.path) .. "/" .. tostring(operation.name)
			if createPaths[key] then error("create identity is not unique") end
			createPaths[key] = true
		else
			local targetId = identityKey(operation.target.identity)
			if targetIds[targetId] then error("multiple operations target the same instance") end
			targetIds[targetId] = true
		end
		validatePreparedOperation(operation, topology, self.registry, function(binding) return resolvedSourceWrite(self, binding) end)
	end
	self.prepared = { requestId = payload.requestId, changeSet = changeSet, operations = canonicalOperations(changeSet, topology), topology = topology, registry = self.registry, projection = projection, preflightProjection = preflightProjection, beforeProjectIndexCapture = beforeCapture, beforeProjectIndexManifestId = beforeCapture.indexManifest.id, beforeProjectRevisionHash = beforeCapture.revision.hash, beforeProjectDetectorEpoch = beforeCapture.detectorEpoch, transportHash = payload.changeSetJsonHash, projectionTransportHash = payload.projectionJsonHash }
	return preparedPayload(self.prepared)
end

-- Detached preflight exercises only manifest-scoped conversion and readback.
-- Scratch instances stay unparented and are always destroyed before return.
function StudioAuthoring:preflight(payload: any)
	local prepared = self.prepared
	if not prepared or payload.requestId ~= prepared.requestId or payload.creatorSessionId ~= prepared.changeSet.sessionId or payload.changeSetId ~= prepared.changeSet.id or payload.changeSetHash ~= prepared.changeSet.hash or payload.projectionId ~= prepared.projection.id or payload.projectionHash ~= prepared.projection.contentHash or payload.preflightProjectionId ~= prepared.preflightProjection.id or payload.preflightProjectionHash ~= prepared.preflightProjection.contentHash or payload.manifestHash ~= Generated.manifestHash or payload.expectedProjectRevisionHash ~= prepared.beforeProjectRevisionHash or payload.beforeProjectIndexManifestId ~= prepared.beforeProjectIndexManifestId or payload.beforeProjectDetectorEpoch ~= prepared.beforeProjectDetectorEpoch then error("creator preflight binding mismatch") end
	local facts, complete = {}, true
	local graph: any = nil
	local graphBuilt, graphFailure = pcall(function() graph = detachedScratchGraph(prepared) end)
	if not graphBuilt then complete = false end
	if graph ~= nil then
		for _, operation in ipairs(prepared.operations) do
			if operation.kind ~= "delete" then
				local ok, _failure = pcall(function()
					local scratch = graph:instanceForTarget(operation.target)
					local className = classForOperation(operation)
					applyProperties(scratch, className, operation.properties or {}, self.registry, nil, function(reference) return graph:resolveReference(reference) end)
					applyAttributes(scratch, operation.attributes or {}, operation.removedAttributes)
					if operation.kind == "create" and Generated.classMetadata(className).source ~= "forbidden" and operation.sourceBlob ~= nil then
						local source = resolvedSourceWrite(self, operation.sourceBlob)
						local beforeSource = StudioScriptSource.read(scratch)
						local readback = StudioScriptSource.writeAndReadback(scratch, sha256(beforeSource), sha256(source), source)
						if sha256(readback) ~= sha256(source) then error("detached created-source readback mismatch") end
					elseif operation.kind == "edit_source" then
						local _, finalSource = validatedSourceEdit(operation, self.registry, function(binding) return resolvedSourceWrite(self, binding) end)
						local beforeSource = StudioScriptSource.read(scratch)
						local readback = StudioScriptSource.writeAndReadback(scratch, sha256(beforeSource), operation.finalSourceHash, finalSource)
						if sha256(readback) ~= operation.finalSourceHash or #readback ~= operation.finalByteCount then error("detached edited-source readback mismatch") end
					end
				end)
				if not ok then complete = false end
			end
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
					if graph == nil then error("detached graph construction failed: " .. tostring(graphFailure)) end
					local scratch = graph:instanceForTarget(requirement.target)
					if scratch:GetAttribute(requirement.attributeName) ~= nil then error("attribute removal did not round-trip") end
				elseif requirement.kind == "structure" then
					if requiresDetachedStructureCanary(requirement.target) then
						local scratch = Instance.new(requirement.target.className)
						scratch:Destroy()
					end
				else
					error("absent canary kind is outside the generated mutation projection")
				end
			end)
			if checked then output.result = { status = "absent" } else output.result = { status = "read_error", code = string.sub(tostring(failure), 1, 512) }; complete = false end
		else
			local checked, value = pcall(function()
				if graph == nil then error("detached graph construction failed: " .. tostring(graphFailure)) end
				if requirement.kind == "property" then
					local scratch = graph:instanceForTarget(requirement.target)
					local metadata = Generated.propertyMetadata(requirement.target.className, requirement.propertyName)
					if not metadata then error("canary property outside generated manifest") end
					-- Observe the final batch state. Reapplying this expectation here
					-- would conceal a later setter changing an earlier property.
					local result = Generated.read(scratch, requirement.propertyName, function(reference: Instance, property: any)
						local expected = requirement.expected
						if typeof(expected) ~= "table" or expected.state ~= "reference" or graph:resolveReference(expected) ~= reference or property.referenceClass ~= expected.expectedClass then error("canary Instance reference readback mismatch") end
						return expected
					end); return result
				elseif requirement.kind == "attribute" then
					local scratch = graph:instanceForTarget(requirement.target); return Generated.canonicalAttribute(scratch:GetAttribute(requirement.attributeName))
				elseif requirement.kind == "source_hash" then
					local source = StudioScriptSource.read(graph:instanceForTarget(requirement.target))
					if sha256(source) ~= requirement.expected then error("canary source does not bind the approved source hash") end
					return sha256(source)
				elseif requirement.kind == "structure" then
					local scratch = graph:instanceForTarget(requirement.target); return { identity = requirement.expected.identity, path = requirement.expected.path, className = scratch.ClassName, parentIdentity = requirement.expected.parentIdentity, parentPath = requirement.expected.parentPath }
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
	if graph ~= nil then graph:destroy() end
	facts = Generated.sortFacts(facts)
	local envelope: any = { kind = "StudioEvidenceEnvelope", manifestHash = Generated.manifestHash, projectionId = prepared.preflightProjection.id, projectionHash = prepared.preflightProjection.contentHash, bindingHash = prepared.preflightProjection.bindingHash, project = prepared.preflightProjection.project, authoritative = true, startedAt = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), endedAt = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), completion = complete and "complete" or "incomplete", facts = facts }
	envelope.contentHash = Generated.envelopeHash(envelope)
	prepared.preflight = envelope
	return envelope
end

function StudioAuthoring:apply(
	payload: any,
	beforeCapture: any,
	onExpectedMutationFact: ((any) -> ())?,
	onMutationPhase: ((string) -> ())?,
	beforeFinish: ((any) -> ())?
)
	local prepared = self.prepared
	self.lastFailure = nil
	if not prepared or not prepared.preflight or prepared.preflight.completion ~= "complete" then error("creator apply requires a complete preflight envelope") end
	if typeof(beforeCapture) ~= "table" or typeof(beforeCapture.indexManifest) ~= "table" or typeof(beforeCapture.revision) ~= "table" or not boundedWhole(beforeCapture.detectorEpoch, 0, 9007199254740991) or payload.requestId ~= prepared.requestId or payload.creatorSessionId ~= prepared.changeSet.sessionId or payload.changeSetId ~= prepared.changeSet.id or payload.changeSetHash ~= prepared.changeSet.hash or payload.projectionId ~= prepared.projection.id or payload.projectionHash ~= prepared.projection.contentHash or payload.manifestHash ~= Generated.manifestHash or payload.expectedProjectRevisionHash ~= beforeCapture.revision.hash or payload.beforeProjectIndexManifestId ~= beforeCapture.indexManifest.id or payload.beforeProjectDetectorEpoch ~= beforeCapture.detectorEpoch or prepared.beforeProjectIndexManifestId ~= beforeCapture.indexManifest.id or prepared.beforeProjectRevisionHash ~= beforeCapture.revision.hash or prepared.beforeProjectDetectorEpoch ~= beforeCapture.detectorEpoch or prepared.changeSet.expectedRevisionHash ~= beforeCapture.revision.hash then error("creator apply revision/projection mismatch") end
	-- Recheck all live, pre-existing bindings at the pre-recording boundary, but
	-- keep created parents/references virtual until their canonical predecessor
	-- operation materializes them inside the recording below.
	local rechecked, recheckFailure = pcall(function()
		for _, operation in ipairs(prepared.operations) do
			validatePreparedOperation(operation, prepared.topology, self.registry, function(sourceBinding) return resolvedSourceWrite(self, sourceBinding) end)
		end
	end)
	if not rechecked then
		-- No recording has been requested at this boundary. Retain the precise
		-- prepared authority plus bounded diagnostic so Runtime can report an
		-- incomplete pre-recording attempt without inventing mutation evidence.
		self.lastFailure = {
			binding = {
				creatorSessionId = prepared.changeSet.sessionId,
				changeSetId = prepared.changeSet.id,
				changeSetHash = prepared.changeSet.hash,
				projectionId = prepared.projection.id,
				projectionHash = prepared.projection.contentHash,
				preflightProjectionId = prepared.preflightProjection.id,
				preflightProjectionHash = prepared.preflightProjection.contentHash,
				manifestHash = Generated.manifestHash,
				beforeProjectIndexManifestId = prepared.beforeProjectIndexManifestId,
				beforeProjectRevisionHash = prepared.beforeProjectRevisionHash,
				beforeProjectDetectorEpoch = prepared.beforeProjectDetectorEpoch,
			},
			-- No recording has been opened, so this is deliberately not a
			-- cancellation acknowledgement. Runtime reports `not_open` solely from
			-- recordingAttempted=false and must omit a placeholder recording cursor.
			cancellationProven = false,
			recordingAttempted = false,
			failureCode = "pre_recording_validation_failed",
			failureDetail = boundedFailureDetail(recheckFailure),
		}
		error("PRE_RECORDING_FAILURE: exact transaction validation failed: " .. boundedFailureDetail(recheckFailure))
	end
	-- Allocate all creates as private, detached handles before any durable
	-- recording intent.  A complete sealed graph may contain A.Value = B and
	-- B.Value = A; requiring one create to become live before the other would
	-- turn that ordinary closed graph into an artificial dependency cycle.
	-- Allocation is not a place mutation: the handles have no Parent and are
	-- destroyed on every path that proves no provisional mutation survives.
	local handlesCreated, handlesOrFailure = pcall(function()
		return allocateCreatedHandles(prepared.operations, self.registry)
	end)
	if not handlesCreated then
		self.lastFailure = {
			binding = {
				creatorSessionId = prepared.changeSet.sessionId,
				changeSetId = prepared.changeSet.id,
				changeSetHash = prepared.changeSet.hash,
				projectionId = prepared.projection.id,
				projectionHash = prepared.projection.contentHash,
				preflightProjectionId = prepared.preflightProjection.id,
				preflightProjectionHash = prepared.preflightProjection.contentHash,
				manifestHash = Generated.manifestHash,
				beforeProjectIndexManifestId = prepared.beforeProjectIndexManifestId,
				beforeProjectRevisionHash = prepared.beforeProjectRevisionHash,
				beforeProjectDetectorEpoch = prepared.beforeProjectDetectorEpoch,
			},
			cancellationProven = false,
			recordingAttempted = false,
			failureCode = "create_handle_allocation_failed",
			failureDetail = boundedFailureDetail(handlesOrFailure),
		}
		error("PRE_RECORDING_FAILURE: detached create-handle allocation failed: " .. boundedFailureDetail(handlesOrFailure))
	end
	local createHandles = handlesOrFailure
	local binding = {
		-- This is an opaque placeholder, used only to retain a conservative
		-- recovery record until Studio returns the actual recording id.  An
		-- opening record is always reported as unknown and can never be
		-- cancellation-authorized.
		recordingId = "pending_recording_" .. prepared.changeSet.id,
		kind = "ForgeCreatorTransactionCursor",
		phase = "opening",
		creatorSessionId = prepared.changeSet.sessionId,
		changeSetId = prepared.changeSet.id,
		changeSetHash = prepared.changeSet.hash,
		manifestHash = Generated.manifestHash,
		projectionId = prepared.projection.id,
		projectionHash = prepared.projection.contentHash,
		preflightProjectionId = prepared.preflightProjection.id,
		preflightProjectionHash = prepared.preflightProjection.contentHash,
		preflightHash = prepared.preflight.contentHash,
		beforeProjectIndexManifestId = beforeCapture.indexManifest.id,
		beforeProjectRevisionHash = beforeCapture.revision.hash,
		beforeProjectDetectorEpoch = beforeCapture.detectorEpoch,
		-- The full project index, source bodies, change set, and mutation evidence
		-- remain in memory and in the coordinator's immutable artifact store. A
		-- Studio setting retains only the bounded read contract needed to observe
		-- recovery plus content hashes for every transaction authority binding.
		recoveryProjection = beforeCapture.projection,
	}
	local opened, intentBinding, recordingOrFailure, recordingAttempted = beginRecordingAfterDurableIntent(self.plugin, binding, function()
		return changeHistoryService():TryBeginRecording("Forge creator change " .. prepared.changeSet.id)
	end)
	if not opened and not recordingAttempted then
		-- This boundary is strictly before TryBeginRecording. A failed durable
		-- intent therefore proves that Forge did not ask Studio to open a recording.
		createHandles:destroyDetached()
		self.lastFailure = { binding = intentBinding, cancellationProven = false, failureCode = "recording_intent_persistence_failed", failureDetail = boundedFailureDetail(recordingOrFailure), recordingAttempted = false }
		error("PRE_RECORDING_FAILURE: durable creator recording intent was not persisted: " .. tostring(recordingOrFailure))
	end
	binding = intentBinding
	if not opened then
		-- The opening intent remains durable.  We cannot infer whether Studio
		-- opened a recording when its API call faults or returns no opaque id.
		-- Retain the exact binding for recovery, but do not manufacture a mutation
		-- receipt from its opening placeholder. Runtime preserves this diagnostic
		-- through command settlement and recovery rather than inventing an id.
		-- No apply operation has begun, so all transaction-local handles remain
		-- detached even though the recording API outcome is conservatively
		-- unknown. Destroying them cannot change the place or finalization state.
		createHandles:destroyDetached()
		self.lastFailure = { binding = binding, cancellationProven = false, recordingAttempted = true, recordingState = "unknown", failureCode = "recording_open_failed", failureDetail = "Studio did not return an exact recording id" }
		error("RECOVERY_REQUIRED: Studio did not return an exact recording id after opening intent persisted")
	end
	local recording = recordingOrFailure
	local recordingBinding = table.clone(binding)
	recordingBinding.cursorHash = nil
	recordingBinding.recordingId = recording
	recordingBinding.phase = "open"
	local persisted, persistedOrFailure = pcall(function() return setActive(self.plugin, recordingBinding) end)
	if not persisted then
		-- TryBeginRecording returned an opaque id, but Forge could not durably bind
		-- it. Never call FinishRecording without a readback-verified intent: a crash
		-- on either side would make that retry ambiguous. The retained opening cursor
		-- remains conservatively recovery-required and no place operation is run.
		-- The cursor was not durable, but this invocation did receive Studio's
		-- exact opaque id. Preserve it only as failure-receipt identity; recovery
		-- still relies on the retained opening cursor and remains fail-closed.
		createHandles:destroyDetached()
		self.lastFailure = { binding = binding, recordingId = recording, cancellationProven = false, recordingState = "unknown", failureCode = "recording_cursor_persistence_failed", failureDetail = boundedFailureDetail(persistedOrFailure), recordingAttempted = true }
		error("RECOVERY_REQUIRED: Studio opened a recording but its exact cursor was not persisted before place mutation: " .. tostring(persistedOrFailure))
	end
	binding = persistedOrFailure
	local applied, failure = pcall(function()
		for _, operation in ipairs(prepared.operations) do
			local derivedValues = {}
			local postTarget = prepared.topology.postTargets[identityKey(operation.target.identity)] or operation.target
			for _, fact in ipairs(prepared.preflight.facts) do
				if fact.kind == "property" and identityKey(fact.target.identity) == identityKey(postTarget.identity) and fact.result.status == "observed" then derivedValues[fact.propertyName] = fact.result.value end
			end
			local expectedPostTarget = prepared.topology.postTargets[identityKey(operation.target.identity)]
			validateOperation(operation, self.registry, function(sourceBinding) return resolvedSourceWrite(self, sourceBinding) end, expectedPostTarget, function(reference) return createHandles:resolveReference(reference) end)
			applyOperation(operation, self.registry, function(sourceBinding) return resolvedSourceWrite(self, sourceBinding) end, onExpectedMutationFact, createHandles, derivedValues)
		end
	end)
	if not applied then
		-- A failed canonical operation can leave later transaction-local creates
		-- unparented. They were never Studio objects, so dispose of those handles
		-- immediately even if finalization later becomes recovery-required. The
		-- helper deliberately leaves any already-parented provisional creates for
		-- ChangeHistory cancellation/recovery; it never performs an implicit
		-- rollback outside that exact recording.
		createHandles:destroyDetached()
		-- This is the one call which opened the recording. Its cancellation is
		-- still preceded by a durable action intent, so a crash cannot cause a
		-- later recovery to finish the same recording twice.
		local cancellationIntent = beginFinalization(self.plugin, binding, "cancel", { failedApply = true, failureCode = "mutation_apply_failed" })
		-- The preceding operation may have registered exact after-state facts.
		-- ChangeHistory cancellation restores their captured before-states, so
		-- select those exact matchers immediately before Studio can notify the
		-- monitor. This is deliberately a fact phase, never a broad "Forge is
		-- writing" suppression interval.
		if onMutationPhase ~= nil then onMutationPhase("before") end
		local cancelled, cancelledOrFailure = self:closeRecordingAndPersistFinalization(cancellationIntent, recording, Enum.FinishRecordingOperation.Cancel, beforeFinish)
		if cancelled then
			-- Cancellation restores every create to its detached/original state;
			-- dispose of our private handles only after that exact acknowledgement.
			createHandles:destroyDetached()
			self.lastFailure = { binding = cancelledOrFailure, cancellationProven = true, failureCode = "mutation_apply_failed", failureDetail = boundedFailureDetail(failure) }
			self.prepared = nil
			error("MUTATION_FAILED: " .. tostring(failure))
		end
		self.lastFailure = { binding = cancellationIntent, cancellationProven = false, failureCode = "mutation_apply_failed", failureDetail = boundedFailureDetail(failure) }
		error("RECOVERY_REQUIRED: mutation failed and this call could not prove cancellation: " .. tostring(failure) .. "; " .. tostring(cancelledOrFailure))
	end
	self.active = { recording = recording, prepared = prepared, binding = binding }
	self.prepared = nil
	clearSourceWriteTransaction(self)
	return self.active
end

-- Evidence collection/persistence runs after provisional place mutation. If it
-- cannot produce a protocol-valid provisional record, the same plugin call
-- cancels only the recording it opened and proves that cancellation before the
-- coordinator may classify the attempt as incomplete.
function StudioAuthoring:cancelActiveForEvidenceFailure(active: any, failureCode: string, beforeFinish: ((any) -> ())?, expectedCurrent: any?)
	if self.active ~= active or typeof(failureCode) ~= "string" or failureCode == "" then error("provisional cancellation binding rejected") end
	local metadata: any = { failureCode = failureCode }
	if expectedCurrent ~= nil then
		if typeof(expectedCurrent) ~= "table" then error("evidence-failure expected-current binding is malformed") end
		metadata.expectedCurrentProjectIndexManifestId = expectedCurrent.projectIndexManifestId
		metadata.expectedCurrentProjectRevisionHash = expectedCurrent.projectRevisionHash
		metadata.expectedCurrentProjectDetectorEpoch = expectedCurrent.projectDetectorEpoch
	end
	local cancellationIntent = beginFinalization(self.plugin, active.binding, "cancel", metadata)
	active.binding = cancellationIntent
	local cancelled, cancelledOrFailure = self:closeRecordingAndPersistFinalization(cancellationIntent, active.recording, Enum.FinishRecordingOperation.Cancel, beforeFinish)
	if not cancelled then
		self.lastFailure = { binding = cancellationIntent, cancellationProven = false, failureCode = failureCode }
		error("RECOVERY_REQUIRED: provisional evidence failed and exact cancellation was not proven: " .. tostring(cancelledOrFailure))
	end
	self.active = nil
	self.lastFailure = { binding = cancelledOrFailure, cancellationProven = true, failureCode = failureCode }
	return cancelledOrFailure
end

function StudioAuthoring:finalize(payload: any, beforeFinish: ((any) -> ())?)
	local active = self.active
	if not active or not sameRecordingBinding(payload, active.binding) or payload.recordingId ~= active.recording or active.binding.phase ~= "open" or (payload.action ~= "commit" and payload.action ~= "cancel") or payload.finalizationKind ~= "ordinary" then error("creator finalization binding mismatch") end
	local provisional = active.binding.provisional
	if typeof(provisional) ~= "table"
		or payload.expectedCurrentProjectIndexManifestId ~= provisional.postApplyProjectIndexManifestId
		or payload.expectedCurrentProjectRevisionHash ~= provisional.postApplyProjectRevisionHash
		or payload.expectedCurrentProjectDetectorEpoch ~= provisional.postApplyProjectDetectorEpoch
	then error("creator finalization expected-current binding mismatch") end
	local finalizationIntent = beginFinalization(self.plugin, active.binding, payload.action, {
		expectedCurrentProjectIndexManifestId = provisional.postApplyProjectIndexManifestId,
		expectedCurrentProjectRevisionHash = provisional.postApplyProjectRevisionHash,
		expectedCurrentProjectDetectorEpoch = provisional.postApplyProjectDetectorEpoch,
	})
	active.binding = finalizationIntent
	local operation = payload.action == "commit" and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
	local closed, closedOrFailure = self:closeRecordingAndPersistFinalization(finalizationIntent, active.recording, operation, beforeFinish)
	if not closed then error("RECOVERY_REQUIRED: " .. tostring(closedOrFailure)) end
	-- Do not discard the exact commit/cancel acknowledgement until its required
	-- post-finalize state evidence has been durably sent. The persisted finished
	-- state proves that the exact recording was read back closed; Runtime adds
	-- the finalization receipt only after collecting a fresh project index.
	active.binding = closedOrFailure
	self.active = nil
	return active
end

function StudioAuthoring:recordFinalizationEvidence(binding: any, post: any)
	if typeof(binding) ~= "table" or typeof(post) ~= "table" or typeof(post.indexManifest) ~= "table" or typeof(post.indexManifest.id) ~= "string" or typeof(post.revision) ~= "table" or typeof(post.revision.hash) ~= "string" or not boundedWhole(post.detectorEpoch, 0, 9007199254740991) then error("finalization index evidence is malformed") end
	local stored = activeSetting(self.plugin)
	if typeof(stored) ~= "table" or not sameRecordingBinding(stored, binding) then error("finalization evidence binding rejected") end
	if finalizationReceipt(self.plugin) ~= nil then error("a prior finalization receipt is awaiting backend acknowledgement") end
	if stored.phase ~= "finalization_finished" or typeof(stored.finalization) ~= "table" then error("finalization evidence binding rejected") end
	if not nonEmptyBoundedString(stored.finalization.expectedCurrentProjectIndexManifestId, 256)
		or not exactHash(stored.finalization.expectedCurrentProjectRevisionHash)
		or not boundedWhole(stored.finalization.expectedCurrentProjectDetectorEpoch, 0, 9007199254740991)
	then error("finalization evidence has no durable pre-Finish expected-current binding") end
	local action = stored.finalization.action
	local receipt: any = {
		kind = "CreatorChangeFinalizationReceipt",
		creatorSessionId = stored.creatorSessionId,
		changeSetId = stored.changeSetId,
		changeSetHash = stored.changeSetHash,
		projectionId = stored.projectionId,
		projectionHash = stored.projectionHash,
		manifestHash = stored.manifestHash,
		beforeProjectIndexManifestId = stored.beforeProjectIndexManifestId,
		beforeProjectRevisionHash = stored.beforeProjectRevisionHash,
		beforeProjectDetectorEpoch = stored.beforeProjectDetectorEpoch,
		recordingId = stored.recordingId,
		action = action,
	}
	receipt.status = action == "commit" and "committed" or "cancelled"
	receipt.afterProjectIndexManifestId = post.indexManifest.id
	receipt.afterProjectRevisionHash = post.revision.hash
	receipt.afterProjectDetectorEpoch = post.detectorEpoch
	receipt.expectedCurrentProjectIndexManifestId = stored.finalization.expectedCurrentProjectIndexManifestId
	receipt.expectedCurrentProjectRevisionHash = stored.finalization.expectedCurrentProjectRevisionHash
	receipt.expectedCurrentProjectDetectorEpoch = stored.finalization.expectedCurrentProjectDetectorEpoch
	receipt.finalizationKind = stored.finalization.finalizationKind
	if stored.finalization.replacesAction ~= nil then receipt.replacesAction = stored.finalization.replacesAction end
	receipt = setFinalizationReceipt(self.plugin, receipt)
	-- The state is settled locally.  Keep only the receipt, which is explicitly
	-- outside hasPossibleRecording and can be replayed without touching Studio.
	setActive(self.plugin, nil)
	self.active = nil
	return receipt
end

function StudioAuthoring:acknowledgeFinalization(payload: any)
	local receipt = finalizationReceipt(self.plugin)
	if typeof(payload) ~= "table" or typeof(receipt) ~= "table" or payload.action ~= receipt.action or payload.status ~= receipt.status or payload.afterProjectIndexManifestId ~= receipt.afterProjectIndexManifestId or payload.afterProjectRevisionHash ~= receipt.afterProjectRevisionHash or payload.afterProjectDetectorEpoch ~= receipt.afterProjectDetectorEpoch or payload.expectedCurrentProjectIndexManifestId ~= receipt.expectedCurrentProjectIndexManifestId or payload.expectedCurrentProjectRevisionHash ~= receipt.expectedCurrentProjectRevisionHash or payload.expectedCurrentProjectDetectorEpoch ~= receipt.expectedCurrentProjectDetectorEpoch or payload.finalizationKind ~= receipt.finalizationKind or payload.replacesAction ~= receipt.replacesAction or not sameRecordingBinding(payload, receipt) then error("finalization acknowledgement does not match the retained receipt") end
	if receipt.action == "commit" then
		setLastCommit(self.plugin, receipt)
	end
	-- Receipt persistence precedes active-cursor cleanup. If Studio accepted the
	-- receipt setting but the subsequent cursor clear failed, a restart can
	-- legitimately retain both. Consume that exact finished cursor here before
	-- clearing the receipt; a nonmatching or nonterminal cursor remains blocked.
	local stored = activeSetting(self.plugin)
	if stored ~= nil then
		if stored.phase ~= "finalization_finished"
			or typeof(stored.finalization) ~= "table"
			or stored.finalization.action ~= receipt.action
			or not sameRecordingBinding(stored, receipt)
		then error("finalization acknowledgement conflicts with retained creator transaction") end
		setActive(self.plugin, nil)
	end
	setFinalizationReceipt(self.plugin, nil)
	return receipt
end

function StudioAuthoring:cancelInterrupted(payload: any, beforeFinish: ((any) -> ())?)
	local stored = activeSetting(self.plugin)
	if typeof(stored) ~= "table"
		or stored.phase ~= "finalization_intent"
		or typeof(stored.finalization) ~= "table"
		or stored.finalization.recovery == true
		or typeof(stored.recovery) ~= "table"
		or not sameRecordingBinding(payload, stored)
		or payload.recoveryProjectIndexManifestId ~= stored.recovery.projectIndexManifestId
		or payload.recoveryProjectRevisionHash ~= stored.recovery.projectRevisionHash
		or payload.recoveryProjectDetectorEpoch ~= stored.recovery.projectDetectorEpoch
		or payload.expectedCurrentProjectIndexManifestId ~= stored.recovery.projectIndexManifestId
		or payload.expectedCurrentProjectRevisionHash ~= stored.recovery.projectRevisionHash
		or payload.expectedCurrentProjectDetectorEpoch ~= stored.recovery.projectDetectorEpoch
		or payload.finalizationKind ~= "recovery_cancel"
		or payload.replacesAction ~= stored.finalization.action
	then error("interrupted-recording cancellation binding mismatch") end
	if exactRecordingState(stored.recordingId, function()
		return changeHistoryService():IsRecordingInProgress(stored.recordingId)
	end) ~= "open" then error("RECOVERY_REQUIRED: exact interrupted recording is not proven open") end
	local expected = {
		projectIndexManifestId = stored.recovery.projectIndexManifestId,
		projectRevisionHash = stored.recovery.projectRevisionHash,
		projectDetectorEpoch = stored.recovery.projectDetectorEpoch,
	}
	-- This writes a different recovery-cancel intent and retains the original
	-- action in `replacesAction`; it is never a retry of that original Finish.
	local cancellationIntent = beginRecoveryCancellation(self.plugin, stored, expected)
	local cancelled, cancelledOrFailure = self:closeRecordingAndPersistFinalization(cancellationIntent, stored.recordingId, Enum.FinishRecordingOperation.Cancel, beforeFinish)
	if not cancelled then error("RECOVERY_REQUIRED: " .. tostring(cancelledOrFailure)) end
	-- The cancellation is complete in Studio, but its post-cancel evidence and
	-- durable backend acknowledgement are still outstanding.  Retain the exact
	-- binding until Runtime records a finalization receipt.
	self.active = nil
	return cancelledOrFailure
end

function StudioAuthoring:rollback(payload: any, currentProjectRevisionHash: string)
	if self:hasPossibleRecording() then error("cannot roll back while a creator recording may be active") end
	local rawCommitted = self.plugin:GetSetting(LAST_COMMIT_SETTING)
	local committed = if rawCommitted == nil then nil else assertFinalizationReceipt(rawCommitted)
	if typeof(committed) ~= "table" or committed.changeSetId ~= payload.changeSetId or committed.changeSetHash ~= payload.changeSetHash or committed.afterProjectRevisionHash ~= currentProjectRevisionHash or payload.expectedProjectRevisionHash ~= currentProjectRevisionHash then error("guarded checkpoint rollback precondition mismatch") end
	local ok, failure = pcall(function() changeHistoryService():Undo() end)
	if not ok then error("RECOVERY_REQUIRED: " .. tostring(failure)) end
	setLastCommit(self.plugin, nil)
	return committed
end

function StudioAuthoring.applySourceEditsForTest(source: string, edits: any, resolveBlob: (any) -> string): string
	return applySourceEdits(source, edits, resolveBlob)
end

function StudioAuthoring.validatedSourceEditMaterialForTest(source: string, operation: any, resolveBlob: (any) -> string): string
	return validatedSourceEditMaterial(source, operation, resolveBlob)
end

function StudioAuthoring.acceptSourceWriteCaptureForTest(capture: any, binding: any, materialize: (any, any) -> string): string
	return acceptSourceWriteCapture(capture, binding, materialize)
end

function StudioAuthoring.sourceWriteAcceptedPayloadForTest(capture: any, requestId: string): any
	return sourceWriteAcceptedPayload(capture, requestId)
end

function StudioAuthoring.beginSourceWriteForTest(self: any, payload: any)
	return StudioAuthoring.beginSourceWrite(self, payload)
end

function StudioAuthoring.newPrepareTransferCaptureForTest(payload: any): any
	return newPrepareTransferCapture(payload)
end

function StudioAuthoring.appendPrepareTransferFragmentForTest(capture: any, payload: any)
	appendPrepareTransferFragment(capture, payload)
end

function StudioAuthoring.completePrepareTransferMaterialForTest(capture: any, payload: any): string
	return completePrepareTransferMaterial(capture, payload)
end

function StudioAuthoring.validateAuthoringContainerClassForTest(path: any, observedClass: any): boolean
	return validateAuthoringContainerClass(path, observedClass, "test")
end

function StudioAuthoring.validateStudioMutationAuthorityForTest(changeSet: any): boolean
	return validateStudioMutationAuthority(changeSet)
end

function StudioAuthoring.requiresDetachedStructureCanaryForTest(target: any): boolean
	return requiresDetachedStructureCanary(target)
end

function StudioAuthoring.prepareTransactionTopologyForTest(changeSet: any, beforeCapture: any): any
	local topology = Generated.compileMutationTransactionTopologyFromIndex(changeSet, beforeCapture)
	return { topology = topology, operations = canonicalOperations(changeSet, topology) }
end

function StudioAuthoring.persistActiveForTest(plugin: any, value: any): any
	return setActive(plugin, value)
end

function StudioAuthoring.beginRecordingAfterDurableIntentForTest(plugin: any, value: any, beginRecording: () -> any): any
	local opened, binding, recordingOrFailure, recordingAttempted = beginRecordingAfterDurableIntent(plugin, value, beginRecording)
	return {
		opened = opened,
		binding = binding,
		recordingOrFailure = recordingOrFailure,
		recordingAttempted = recordingAttempted,
	}
end

function StudioAuthoring.sealTransactionCursorForTest(value: any): any
	return sealTransactionCursor(value)
end

function StudioAuthoring.sameRecordingBindingForTest(left: any, right: any): boolean
	return sameRecordingBinding(left, right)
end

function StudioAuthoring.rebindRecoveryProjectionForTest(value: any, connectorEpoch: string): any
	return canonicalRecoveryProjection(value, connectorEpoch)
end

function StudioAuthoring.transactionSettingMaterialLimitForTest(): number
	return MAXIMUM_TRANSACTION_SETTING_MATERIAL_BYTES
end

function StudioAuthoring.beginFinalizationForTest(plugin: any, binding: any, action: string, metadata: any?): any
	return beginFinalization(plugin, binding, action, metadata)
end

function StudioAuthoring.beginRecoveryCancellationForTest(plugin: any, binding: any, expected: any): any
	return beginRecoveryCancellation(plugin, binding, expected)
end

function StudioAuthoring.exactRecordingStateForTest(recordingId: any, readOpen: () -> any): string
	return exactRecordingState(recordingId, readOpen)
end

function StudioAuthoring.closeAndPersistFinalizationForTest(
	plugin: any,
	intent: any,
	recordingId: string,
	callFinish: () -> any,
	readOpen: () -> any,
	notify: ((boolean) -> ())?,
	beforeFinish: ((any) -> ())?
): (boolean, any)
	return closeAndPersistFinalization(plugin, intent, recordingId, callFinish, readOpen, notify, beforeFinish)
end

function StudioAuthoring.finalizationRecoveryStateForTest(binding: any): string
	local cursor = assertTransactionCursor(binding)
	if cursor.phase == "finalization_intent" then return "finalizing" end
	if cursor.phase == "finalization_finished" then return "not_open" end
	return cursor.phase == "open" and "open" or "unknown"
end

function StudioAuthoring.settingKeysForTest()
	return { active = ACTIVE_RECORDING_SETTING, finalization = FINALIZATION_RECEIPT_SETTING, lastCommit = LAST_COMMIT_SETTING }
end

function StudioAuthoring.possibleRecordingForTest(active: any, stored: any, observeAnyRecording: () -> boolean): boolean
	return possibleRecording(active, stored, observeAnyRecording)
end

return StudioAuthoring
