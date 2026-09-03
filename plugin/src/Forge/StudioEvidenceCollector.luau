--!strict
-- One closed reader for all Studio evidence.  It interprets only generated
-- projection requirements and generated manifest dispatch; no observation
-- kind silently treats omission as a value.
local Constants = if script ~= nil then require(script.Parent.Constants) else require("./Constants")
local Generated = if script ~= nil then require(script.Parent.GeneratedStudioEvidence) else require("./GeneratedStudioEvidence")
local Hash = if script ~= nil then require(script.Parent.Hash) else require("./Hash")
local StudioScriptSource = if script ~= nil then require(script.Parent.StudioScriptSource) else require("./StudioScriptSource")

local StudioEvidenceCollector = {}
StudioEvidenceCollector.__index = StudioEvidenceCollector

local function collectionService() return game:GetService("CollectionService") end
local function iso(): string return os.date("!%Y-%m-%dT%H:%M:%S.000Z") end
local function project() return { name = game.Name, placeId = game.PlaceId, universeId = game.GameId } end

local function pathOf(instance: Instance): string
	local parts = {}; local cursor: Instance? = instance
	while cursor and cursor ~= game do table.insert(parts, 1, cursor.Name); cursor = cursor.Parent end
	return table.concat(parts, "/")
end

local function parentPath(instance: Instance): string?
	if not instance.Parent or instance.Parent == game then return nil end
	return pathOf(instance.Parent)
end

local function targetInstance(target: any, registry): Instance?
	if typeof(target) ~= "table" then return nil end
	if target.kind ~= "instance" or typeof(target.identity) ~= "table" then return nil end
	local instance: Instance? = nil
	if target.identity.kind == "forge_attribute" then instance = registry:find(target.identity.stableId) end
	if target.identity.kind == "studio_ephemeral" then instance = registry:findOpaque(target.identity) end
	if instance and pathOf(instance) == target.path and instance.ClassName == target.className then return instance end
	return nil
end

local function status(statusName: string, value: any?)
	if statusName == "observed" then return { status = "observed", value = value } end
	if statusName == "absent" then return { status = "absent" } end
	return { status = statusName, code = string.sub(tostring(value or statusName), 1, Constants.MAX_DIAGNOSTIC_CHARS) }
end

local function fact(requirement: any, result: any)
	local output: any = { kind = requirement.kind, key = requirement.key, target = requirement.target, result = result }
	if requirement.kind == "property" then output.propertyName = requirement.propertyName
	elseif requirement.kind == "attribute" then output.attributeName = requirement.attributeName
	elseif requirement.kind == "runtime_resolution" or requirement.kind == "position_series" or requirement.kind == "position" and requirement.callId ~= nil then
		output.callId = requirement.callId; output.runtimeTargetId = requirement.runtimeTargetId; output.capability = requirement.capability
	end
	return output
end

local function readRequirement(requirement: any, registry)
	if requirement.target.kind == "project" then return fact(requirement, status("observed", project())) end
	local instance = targetInstance(requirement.target, registry)
	if not instance then return fact(requirement, status("absent")) end
	if requirement.kind == "structure" then
		local value: any = { identity = registry:identityFor(instance), path = pathOf(instance), className = instance.ClassName }
		local parent = parentPath(instance); if parent then value.parentPath = parent; if instance.Parent and instance.Parent ~= game then value.parentIdentity = registry:identityFor(instance.Parent) end end
		return fact(requirement, status("observed", value))
	elseif requirement.kind == "property" then
		local metadata = Generated.propertyMetadata(instance.ClassName, requirement.propertyName)
		if not metadata then return fact(requirement, status("unavailable", "property is outside the manifest")) end
		local ok, value = pcall(function()
			return Generated.read(instance, requirement.propertyName, function(reference: Instance, property: any)
				if typeof(property) ~= "table" or typeof(property.referenceClass) ~= "string" or not reference:IsA(property.referenceClass) then error("Instance reference violates its manifest class constraint") end
				return { kind = "instance_ref", state = "reference", identity = registry:identityFor(reference), path = pathOf(reference), className = reference.ClassName, expectedClass = property.referenceClass }
			end)
		end)
		return fact(requirement, ok and status("observed", value) or status("read_error", value))
	elseif requirement.kind == "attribute_inventory" then
		local ok, attributes = pcall(function() return instance:GetAttributes() end)
		if not ok then return fact(requirement, status("read_error", attributes)) end
		local names = {}
		for name in pairs(attributes) do if name ~= Constants.IDENTITY_ATTRIBUTE then table.insert(names, name) end end
		table.sort(names); return fact(requirement, status("observed", names))
	elseif requirement.kind == "attribute" then
		local ok, value = pcall(function() return instance:GetAttribute(requirement.attributeName) end)
		if not ok then return fact(requirement, status("read_error", value)) end
		if value == nil then return fact(requirement, status("absent")) end
		local valid, canonical = pcall(function() return Generated.canonicalAttribute(value) end)
		return fact(requirement, valid and status("observed", canonical) or status("read_error", canonical))
	elseif requirement.kind == "source_hash" then
		if not instance:IsA("LuaSourceContainer") then return fact(requirement, status("unavailable", "source capability unavailable")) end
		local ok, source = pcall(function() return StudioScriptSource.read(instance) end)
		if not ok or typeof(source) ~= "string" then return fact(requirement, status("read_error", source)) end
		local valid, reason = pcall(function() Generated.validateSource(source, false) end)
		if not valid then return fact(requirement, status("read_error", reason)) end
		return fact(requirement, status("observed", Hash.sha256(source)))
	elseif requirement.kind == "tags" then
		local ok, tags = pcall(function() return collectionService():GetTags(instance) end)
		if not ok then return fact(requirement, status("read_error", tags)) end
		table.sort(tags); return fact(requirement, status("observed", tags))
	elseif requirement.kind == "remote" then
		if not instance:IsA("RemoteEvent") and not instance:IsA("RemoteFunction") then return fact(requirement, status("unavailable", "remote capability unavailable")) end
		return fact(requirement, status("observed", { name = instance.Name, className = instance.ClassName, direction = "client_to_server" }))
	elseif requirement.kind == "position" then
		local metadata = Generated.runtimeCapabilityMetadata("base_part.position")
		if not metadata then return fact(requirement, status("unavailable", "position capability unavailable")) end
		local ok, position = pcall(function() return (instance :: any).Position end)
		if not ok then return fact(requirement, status("unavailable", "position unavailable")) end
		local converted, value = pcall(function() return Generated.fromStudio(metadata.result, position) end)
		return fact(requirement, converted and status("observed", value) or status("read_error", value))
	end
	return fact(requirement, status("unavailable", "fact requires a runtime runner or reflection"))
end

local function complete(projection: any, facts: {any}): boolean
	local requirements = Generated.projectionRequirements(projection)
	if #facts ~= #requirements then return false end
	local seen, required = {}, {}
	for _, requirement in ipairs(requirements) do required[requirement.key] = requirement end
	for _, item in ipairs(facts) do
		if seen[item.key] then return false end
		seen[item.key] = item
		if item.result.status == "unavailable" or item.result.status == "read_error" then return false end
	end
	for _, requirement in ipairs(requirements) do
		local item = seen[requirement.key]
		if not item then return false end
	end
	-- Completeness is availability/coverage rather than expectation matching:
	-- observed and authoritative absent facts are both complete, while failed
	-- reads remain explicitly incomplete evidence.
	for _, item in ipairs(facts) do
		local requirement = required[item.key]
		if not requirement then return false end
		if item.result.status ~= "observed" and item.result.status ~= "absent" then return false end
	end
	return true
end

function StudioEvidenceCollector.new(registry)
	return setmetatable({ registry = registry }, StudioEvidenceCollector)
end

function StudioEvidenceCollector:identity() return project() end

function StudioEvidenceCollector:produce(projection: any, diagnostics: any?, cooperate: (() -> ())?)
	Generated.validateProjection(projection)
	local startedAt = iso(); local facts = {}
	for _, requirement in ipairs(Generated.projectionRequirements(projection)) do
		table.insert(facts, readRequirement(requirement, self.registry))
		if cooperate then cooperate() end
	end
	facts = Generated.sortFacts(facts)
	local envelope: any = {
		kind = "StudioEvidenceEnvelope", manifestHash = Generated.manifestHash, projectionId = projection.id, projectionHash = projection.contentHash,
		bindingHash = projection.bindingHash, project = project(), authoritative = true, startedAt = startedAt, endedAt = iso(),
		completion = complete(projection, facts) and "complete" or "incomplete", facts = facts, diagnostics = diagnostics,
	}
	envelope.contentHash = Generated.envelopeHash(envelope)
	return envelope
end

-- Reflection is a source of facts, not a capability grader.  In particular,
-- an EngineType is an implementation-domain spelling, whereas ScriptType,
-- EnumType, and InstanceType identify distinct public API domains.  Preserve
-- every available dimension so the provider-free verifier can make that
-- comparison against the catalog without the plugin guessing an equivalence.
local function reflectedPropertyValue(descriptor: any, className: string, propertyName: string): (any?, string?)
	if typeof(descriptor) ~= "table" then return nil, "reflection_descriptor_unavailable" end
	local rawType: any = (descriptor :: any).Type
	if typeof(rawType) ~= "table" then return nil, "reflection_type_unavailable" end
	local engineType = rawType.EngineType
	if typeof(engineType) ~= "string" or engineType == "" then return nil, "reflection_engine_type_unavailable" end
	local owner = (descriptor :: any).Owner
	if typeof(owner) ~= "string" or owner == "" then return nil, "reflection_owner_unavailable" end
	local serialized = (descriptor :: any).Serialized
	if typeof(serialized) ~= "boolean" then return nil, "reflection_serialization_unavailable" end
	local reflectedPermits = (descriptor :: any).Permits
	if typeof(reflectedPermits) ~= "table" then return nil, "reflection_permits_unavailable" end

	local reflectionType: any = { engineType = engineType }
	for _, dimension in ipairs({ { source = "ScriptType", target = "scriptType" }, { source = "EnumType", target = "enumType" }, { source = "InstanceType", target = "instanceType" } }) do
		local value = rawType[dimension.source]
		if typeof(value) == "string" and value ~= "" then reflectionType[dimension.target] = value end
	end
	local permits = {}
	-- `Permits` records required security capabilities.  Read/write are the
	-- bounded authority surface Forge attests today; their present/non-present
	-- state is evidence for the backend, not a client-side pass/fail decision.
	if (reflectedPermits :: any).Read ~= nil then table.insert(permits, "read") end
	if (reflectedPermits :: any).Write ~= nil then table.insert(permits, "write") end
	table.sort(permits)
	return {
		className = className,
		propertyName = propertyName,
		owner = owner,
		type = reflectionType,
		inherited = owner ~= className,
		serialized = serialized,
		permits = permits,
	}, nil
end

-- This narrow pure seam lets the plugin module tests exercise the exact raw
-- ReflectionService serialization without fabricating a Studio service.
function StudioEvidenceCollector.reflectedPropertyValueForTest(descriptor: any, className: string, propertyName: string): (any?, string?)
	return reflectedPropertyValue(descriptor, className, propertyName)
end

function StudioEvidenceCollector:attestation(projection: any, cooperate: (() -> ())?)
	Generated.validateProjection(projection)
	local ReflectionService = game:GetService("ReflectionService")
	local reflected = {}
	for _, className in ipairs(Generated.writableClasses) do
		-- Omit `Security` deliberately: Roblox defaults it to the plugin's
		-- current security context.  Inherited rows are explicitly retained;
		-- their owner is part of the emitted evidence rather than a new
		-- capability source.
		local ok, descriptors = pcall(function() return ReflectionService:GetPropertiesOfClass(className, { ExcludeInherited = false, ExcludeDisplay = true }) end)
		reflected[className] = ok and descriptors or nil
		if cooperate then cooperate() end
	end
	local facts = {}
	for _, requirement in ipairs(Generated.projectionRequirements(projection)) do
		if requirement.kind ~= "reflection" then error("attestation projection contains a non-reflection fact") end
		local identifier = string.match(requirement.key, "^reflection:project:(.+)$")
		local className, propertyName = identifier and string.match(identifier, "^(.-)%.([^%.]+)$") or nil, nil
		if identifier then className, propertyName = string.match(identifier, "^(.-)%.([^%.]+)$") end
		if typeof(className) ~= "string" or typeof(propertyName) ~= "string" then error("invalid reflection requirement") end
		local descriptors = reflected[className]
		if descriptors == nil then table.insert(facts, fact(requirement, status("unavailable", "ReflectionService unavailable")))
			else
				local descriptor: any = nil
				for _, item in ipairs(descriptors) do
					if (item :: any).Name == propertyName then descriptor = item; break end
					if cooperate then cooperate() end
				end
			if descriptor == nil then table.insert(facts, fact(requirement, status("absent")))
			else
				local reflectedValue, readError = reflectedPropertyValue(descriptor, className, propertyName)
				table.insert(facts, fact(requirement, reflectedValue ~= nil and status("observed", reflectedValue) or status("read_error", readError)))
			end
		if cooperate then cooperate() end
	end
	end
	facts = Generated.sortFacts(facts)
	local envelope: any = { kind = "StudioEvidenceEnvelope", manifestHash = Generated.manifestHash, projectionId = projection.id, projectionHash = projection.contentHash, bindingHash = projection.bindingHash, project = project(), authoritative = true, startedAt = iso(), endedAt = iso(), completion = complete(projection, facts) and "complete" or "incomplete", facts = facts }
	envelope.contentHash = Generated.envelopeHash(envelope)
	return envelope
end

return StudioEvidenceCollector
