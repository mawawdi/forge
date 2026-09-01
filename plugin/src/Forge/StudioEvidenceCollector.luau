--!strict
-- One closed reader for all Studio evidence.  It interprets only generated
-- projection requirements and generated manifest dispatch; no observation
-- kind silently treats omission as a value.
local Constants = if script ~= nil then require(script.Parent.Constants) else require("./Constants")
local Generated = if script ~= nil then require(script.Parent.GeneratedStudioEvidence) else require("./GeneratedStudioEvidence")
local Hash = if script ~= nil then require(script.Parent.Hash) else require("./Hash")

local StudioEvidenceCollector = {}
StudioEvidenceCollector.__index = StudioEvidenceCollector

local function collectionService() return game:GetService("CollectionService") end
local function httpService() return game:GetService("HttpService") end
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

local function resolvePath(path: any): Instance?
	if typeof(path) ~= "string" or not Generated.isAllowedRoot(path) then return nil end
	local pieces = string.split(path, "/"); local current: Instance? = game:FindFirstChild(pieces[1])
	for index = 2, #pieces do
		if not current or pieces[index] == "" or pieces[index] == "." or pieces[index] == ".." then return nil end
		current = current:FindFirstChild(pieces[index])
	end
	return current
end

local function targetInstance(target: any, registry): Instance?
	if typeof(target) ~= "table" then return nil end
	if target.kind == "instance" and typeof(target.stableId) == "string" then return registry:find(target.stableId) end
	if target.kind == "instance" then return resolvePath(target.path) end
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
	if requirement.kind == "inventory" then return fact(requirement, status("unavailable", "inventory requires project-state discovery")) end
	if requirement.target.kind == "project" then return fact(requirement, status("observed", project())) end
	local instance = targetInstance(requirement.target, registry)
	if not instance then return fact(requirement, status("absent")) end
	if requirement.kind == "structure" then
		local value: any = { stableId = instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE), path = pathOf(instance), className = instance.ClassName }
		local parent = parentPath(instance); if parent then value.parentPath = parent end
		return fact(requirement, status("observed", value))
	elseif requirement.kind == "property" then
		local metadata = Generated.propertyMetadata(instance.ClassName, requirement.propertyName)
		if not metadata then return fact(requirement, status("unavailable", "property is outside the manifest")) end
		local ok, value = pcall(function()
			return Generated.read(instance, requirement.propertyName, function(reference: Instance, property: any)
				local stableId = reference:GetAttribute(Constants.IDENTITY_ATTRIBUTE)
				if typeof(stableId) ~= "string" or registry:find(stableId) ~= reference then error("Instance reference lacks a stable Forge identity") end
				if typeof(property) ~= "table" or typeof(property.referenceClass) ~= "string" or not reference:IsA(property.referenceClass) then error("Instance reference violates its manifest class constraint") end
				return { kind = "instance_ref", state = "reference", stableId = stableId, path = pathOf(reference), className = reference.ClassName, expectedClass = property.referenceClass }
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
	elseif requirement.kind == "source_hash" or requirement.kind == "source_body" then
		if not instance:IsA("LuaSourceContainer") then return fact(requirement, status("unavailable", "source capability unavailable")) end
		local ok, source = pcall(function() return instance.Source end)
		if not ok or typeof(source) ~= "string" then return fact(requirement, status("read_error", source)) end
		local valid, reason = pcall(function() Generated.validateSource(source, false) end)
		if not valid then return fact(requirement, status("read_error", reason)) end
		return fact(requirement, status("observed", requirement.kind == "source_hash" and Hash.sha256(source) or source))
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
	if projection.scope.mode == "exact" and #facts ~= #requirements then return false end
	local seen, required = {}, {}
	for _, requirement in ipairs(requirements) do required[requirement.key] = requirement end
	for _, item in ipairs(facts) do
		if seen[item.key] then return false end
		seen[item.key] = item
		if item.result.status == "unavailable" or item.result.status == "read_error" then return false end
	end
	for _, requirement in ipairs(requirements) do
		local item = seen[requirement.key]
		if not item or item.result.status ~= (requirement.expectedStatus or "observed") then return false end
	end
	-- An explicit absent result is complete evidence only when that exact fact
	-- required absence.  Extra project-state facts must be observed; omission
	-- cannot silently mean false, empty, or absent.
	for _, item in ipairs(facts) do
		local requirement = required[item.key]
		if item.result.status == "absent" and (not requirement or requirement.expectedStatus ~= "absent") then return false end
		if item.result.status ~= "observed" and item.result.status ~= "absent" then return false end
	end
	return true
end

function StudioEvidenceCollector.new(registry)
	return setmetatable({ registry = registry }, StudioEvidenceCollector)
end

function StudioEvidenceCollector:identity() return project() end

function StudioEvidenceCollector:produce(projection: any, diagnostics: any?)
	Generated.validateProjection(projection)
	local startedAt = iso(); local facts = {}
	for _, requirement in ipairs(Generated.projectionRequirements(projection)) do table.insert(facts, readRequirement(requirement, self.registry)) end
	facts = Generated.sortFacts(facts)
	local envelope: any = {
		kind = "StudioEvidenceEnvelope", manifestHash = Generated.manifestHash, projectionId = projection.id, projectionHash = projection.contentHash,
		bindingHash = projection.bindingHash, project = project(), authoritative = true, startedAt = startedAt, endedAt = iso(),
		completion = complete(projection, facts) and "complete" or "incomplete", facts = facts, diagnostics = diagnostics,
	}
	envelope.contentHash = Generated.envelopeHash(envelope)
	return envelope
end

function StudioEvidenceCollector:stateRevision(projection: any, envelope: any)
	if envelope.completion ~= "complete" then error("a Studio state revision requires complete evidence") end
	if projection.contentHash ~= envelope.projectionHash then error("state revision projection binding mismatch") end
	local stateDomainHash = Generated.stateDomainHash(projection)
	return { kind = "StudioStateRevision", manifestHash = Generated.manifestHash, projectionHash = envelope.projectionHash, stateDomainHash = stateDomainHash, stateHash = Generated.stateRevisionHash(Generated.manifestHash, stateDomainHash, envelope.facts), capturedAt = envelope.endedAt }
end

-- A project-state observation can exceed a closed evidence bound only by
-- becoming incomplete.  Do not emit a truncated inventory or an over-bound
-- envelope (both would be invalid evidence); retain the required inventory
-- fact with an explicit read error and make every other required fact
-- unavailable.  This keeps absence distinct from collection failure.
local function incompleteProjectStateEnvelope(projection: any, diagnostics: any?, inventoryCode: string, otherCode: string)
	local facts = {}
	for _, requirement in ipairs(Generated.projectionRequirements(projection)) do
		if requirement.kind == "inventory" then
			table.insert(facts, fact(requirement, status("read_error", inventoryCode)))
		elseif requirement.target.kind == "project" then
			table.insert(facts, readRequirement(requirement, nil))
		else
			table.insert(facts, fact(requirement, status("unavailable", otherCode)))
		end
	end
	facts = Generated.sortFacts(facts)
	local envelope: any = {
		kind = "StudioEvidenceEnvelope", manifestHash = Generated.manifestHash, projectionId = projection.id, projectionHash = projection.contentHash,
		bindingHash = projection.bindingHash, project = project(), authoritative = true, startedAt = iso(), endedAt = iso(),
		completion = "incomplete", facts = facts, diagnostics = diagnostics,
	}
	envelope.contentHash = Generated.envelopeHash(envelope)
	return envelope
end

function StudioEvidenceCollector:produceProjectState(projection: any, diagnostics: any?)
	Generated.validateProjection(projection)
	if projection.scope.mode ~= "project_state" or projection.scope.requireCompleteInventory ~= true then error("project-state projection requires complete inventory") end
	local roots, inventory, facts = {}, {}, {}
	for _, root in ipairs(projection.scope.roots) do roots[root] = true end
	-- Count the whole applicable inventory before producing a single inventory
	-- fact.  A bounded projection must never masquerade as a complete but
	-- truncated state: an over-bound place yields an explicit read error with no
	-- fabricated partial inventory.
	local discovered = 0
	for _, rootName in ipairs(Generated.authoringRoots) do
		if roots[rootName] then
			local root = game:FindFirstChild(rootName)
			if root then
				local instances = root:GetDescendants(); table.insert(instances, 1, root)
				for _, instance in ipairs(instances) do
					if Generated.classMetadata(instance.ClassName) then
						discovered += 1
						-- Project-state closure requires a durable identity for every
						-- applicable instance.  Do not construct a partial inventory
						-- and do not introduce an unprojected diagnostic fact: the
						-- required inventory fact itself must say that collection was
						-- unavailable.
						if typeof(instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE)) ~= "string" then
							return incompleteProjectStateEnvelope(projection, diagnostics, "missing_stable_identity", "project_state_identity_incomplete")
						end
					end
				end
			end
		end
	end
	if discovered > (projection.bounds.maximumInstances or Generated.manifest.projectState.maximumInstances) then
		return incompleteProjectStateEnvelope(projection, diagnostics, "project_state_instance_bound", "project_state_inventory_over_bound")
	end
	for _, rootName in ipairs(Generated.authoringRoots) do
		if roots[rootName] then
			local root = game:FindFirstChild(rootName)
			if root then
				local instances = root:GetDescendants(); table.insert(instances, 1, root)
				for _, instance in ipairs(instances) do
					if Generated.classMetadata(instance.ClassName) then
						local stableId = instance:GetAttribute(Constants.IDENTITY_ATTRIBUTE)
						if typeof(stableId) == "string" then
							local target = { kind = "instance", stableId = stableId, path = pathOf(instance), className = instance.ClassName }
							local structure: any = { stableId = stableId, path = pathOf(instance), className = instance.ClassName }
							local parent = parentPath(instance); if parent then structure.parentPath = parent end
							table.insert(inventory, structure)
							table.insert(facts, { kind = "structure", key = Generated.factKey("structure", target), target = target, result = status("observed", structure) })
							for propertyName in pairs(Generated.classMetadata(instance.ClassName).properties) do
								local requirement = { kind = "property", key = Generated.factKey("property", target, propertyName), target = target, propertyName = propertyName }
								table.insert(facts, readRequirement(requirement, self.registry))
							end
							local attributesOk, attributes = pcall(function() return instance:GetAttributes() end)
							if attributesOk then
								local names = {}
								for name in pairs(attributes) do if name ~= Constants.IDENTITY_ATTRIBUTE then table.insert(names, name) end end
								table.sort(names)
								table.insert(facts, { kind = "attribute_inventory", key = Generated.factKey("attribute_inventory", target), target = target, result = status("observed", names) })
								for _, name in ipairs(names) do table.insert(facts, readRequirement({ kind = "attribute", key = Generated.factKey("attribute", target, name), target = target, attributeName = name }, self.registry)) end
							else
								table.insert(facts, { kind = "attribute_inventory", key = Generated.factKey("attribute_inventory", target), target = target, result = status("read_error", attributes) })
							end
							local tagsRequirement = { kind = "tags", key = Generated.factKey("tags", target), target = target }
							table.insert(facts, readRequirement(tagsRequirement, self.registry))
							if Generated.classMetadata(instance.ClassName).source ~= "forbidden" then
								table.insert(facts, readRequirement({ kind = "source_hash", key = Generated.factKey("source_hash", target), target = target }, self.registry))
								table.insert(facts, readRequirement({ kind = "source_body", key = Generated.factKey("source_body", target), target = target }, self.registry))
							end
							if instance:IsA("RemoteEvent") or instance:IsA("RemoteFunction") then table.insert(facts, readRequirement({ kind = "remote", key = Generated.factKey("remote", target), target = target }, self.registry)) end
						end
					end
				end
			end
		end
	end
	table.sort(inventory, function(left, right) return left.stableId < right.stableId end)
	for _, requirement in ipairs(Generated.projectionRequirements(projection)) do
		if requirement.kind == "inventory" then table.insert(facts, fact(requirement, status("observed", inventory)))
		elseif requirement.target.kind == "project" then table.insert(facts, readRequirement(requirement, self.registry))
		-- Instance requirements are already included in the closed dynamic inventory.
		end
	end
	facts = Generated.sortFacts(facts)
	if #facts > projection.bounds.maximumFacts then
		return incompleteProjectStateEnvelope(projection, diagnostics, "project_state_fact_bound", "project_state_fact_over_bound")
	end
	local envelope: any = {
		kind = "StudioEvidenceEnvelope", manifestHash = Generated.manifestHash, projectionId = projection.id, projectionHash = projection.contentHash,
		bindingHash = projection.bindingHash, project = project(), authoritative = true, startedAt = iso(), endedAt = iso(),
		completion = complete(projection, facts) and "complete" or "incomplete", facts = facts, diagnostics = diagnostics,
	}
	if #Generated.envelopeMaterial(envelope) > projection.bounds.maximumBytes then
		return incompleteProjectStateEnvelope(projection, diagnostics, "project_state_evidence_bound", "project_state_evidence_over_bound")
	end
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

function StudioEvidenceCollector:attestation(projection: any)
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
			for _, item in ipairs(descriptors) do if (item :: any).Name == propertyName then descriptor = item; break end end
			if descriptor == nil then table.insert(facts, fact(requirement, status("absent")))
			else
				local reflectedValue, readError = reflectedPropertyValue(descriptor, className, propertyName)
				table.insert(facts, fact(requirement, reflectedValue ~= nil and status("observed", reflectedValue) or status("read_error", readError)))
			end
		end
	end
	facts = Generated.sortFacts(facts)
	local envelope: any = { kind = "StudioEvidenceEnvelope", manifestHash = Generated.manifestHash, projectionId = projection.id, projectionHash = projection.contentHash, bindingHash = projection.bindingHash, project = project(), authoritative = true, startedAt = iso(), endedAt = iso(), completion = complete(projection, facts) and "complete" or "incomplete", facts = facts }
	envelope.contentHash = Generated.envelopeHash(envelope)
	return envelope
end

function StudioEvidenceCollector:chunks(payload: any): ({any}?, any?)
	local HttpService = httpService()
	local encoded = HttpService:JSONEncode(payload)
	if #encoded <= Constants.MAX_EVIDENCE_BYTES then return nil, payload end
	local total = math.ceil(#encoded / Constants.MAX_EVIDENCE_BYTES)
	if total > Constants.MAX_EVIDENCE_CHUNKS then error("evidence exceeds transport bounds") end
	local evidenceId = "evidence_" .. HttpService:GenerateGUID(false); local chunks = {}
	for index = 1, total do
		local part = string.sub(encoded, (index - 1) * Constants.MAX_EVIDENCE_BYTES + 1, index * Constants.MAX_EVIDENCE_BYTES)
		table.insert(chunks, { project = payload.project, reason = payload.reason, evidenceId = evidenceId, index = index - 1, total = total, encoding = "json", payload = part, payloadHash = Hash.sha256(part) })
	end
	return chunks, nil
end

return StudioEvidenceCollector
