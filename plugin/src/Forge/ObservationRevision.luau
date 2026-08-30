--!strict
-- Produces an unambiguous canonical byte string for live Studio revision
-- checks. Capture timestamps are metadata and deliberately excluded.
local ObservationRevision = {}

type Primitive = string | number | boolean
type PrimitiveEntry = { name: string, value: Primitive }
type InstanceObservation = { stableId: string, path: string, className: string, properties: {PrimitiveEntry}, attributes: {PrimitiveEntry}, tags: {string} }
type ScriptObservation = { stableId: string, path: string, executionContext: string, sourceHash: string }
type RemoteObservation = { path: string, name: string, className: string, direction: string }
type Observation = {
	kind: string,
	schemaVersion: number,
	project: { name: string, placeId: number, universeId: number },
	instances: {InstanceObservation},
	scripts: {ScriptObservation},
	remotes: {RemoteObservation},
}

local function append(parts, value)
	local encoded = tostring(value)
	table.insert(parts, tostring(#encoded))
	table.insert(parts, ":")
	table.insert(parts, encoded)
	table.insert(parts, "|")
end

local function appendEntries(parts, entries: {PrimitiveEntry})
	append(parts, #entries)
	for _, entry in ipairs(entries) do
		append(parts, entry.name)
		append(parts, entry.value)
	end
end

function ObservationRevision.material(observation: Observation): string
	local parts = {}
	append(parts, observation.kind)
	append(parts, observation.schemaVersion)
	append(parts, observation.project.name)
	append(parts, observation.project.placeId)
	append(parts, observation.project.universeId)

	append(parts, #observation.instances)
	for _, instance in ipairs(observation.instances) do
		append(parts, instance.stableId)
		append(parts, instance.path)
		append(parts, instance.className)
		appendEntries(parts, instance.properties)
		appendEntries(parts, instance.attributes)
		append(parts, #instance.tags)
		for _, tag in ipairs(instance.tags) do append(parts, tag) end
	end

	append(parts, #observation.scripts)
	for _, scriptEntry in ipairs(observation.scripts) do
		append(parts, scriptEntry.stableId)
		append(parts, scriptEntry.path)
		append(parts, scriptEntry.executionContext)
		append(parts, scriptEntry.sourceHash)
	end

	append(parts, #observation.remotes)
	for _, remote in ipairs(observation.remotes) do
		append(parts, remote.path)
		append(parts, remote.name)
		append(parts, remote.className)
		append(parts, remote.direction)
	end
	return table.concat(parts)
end

function ObservationRevision.identityMaterial(observation: Observation): string
	local parts = {}
	for _, instance in ipairs(observation.instances) do
		append(parts, instance.stableId)
		append(parts, instance.path)
		append(parts, instance.className)
	end
	return table.concat(parts)
end

return ObservationRevision
