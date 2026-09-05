-- Fixed fixture support; never imported by the production connector.
local Cases = {}

function Cases.prepare(Generated, Hash, className, properties, attributes, removedAttributes, beforeProperties)
	local identity = { kind = "forge_attribute", stableId = "native_conformance_target" }
	local target = { kind = "instance", identity = identity, path = "Workspace/ConformanceTarget", className = className }
	local workspaceIdentity = { kind = "forge_attribute", stableId = "native_conformance_workspace" }
	local operation = { id = "conformance_update", kind = "update", target = target, properties = properties or {}, attributes = attributes or {}, removedAttributes = removedAttributes or {} }
	local changeSet = { kind = "CreatorChangeSet", id = "native_conformance_change", sessionId = "native_conformance_session", hash = Hash.sha256(className), operations = { operation } }
	local capture = {
		kind = "StudioProjectIndexCapture",
		indexManifest = { manifestHash = Generated.manifestHash, hash = Hash.sha256("index") },
		revision = { manifestHash = Generated.manifestHash, indexManifestHash = Hash.sha256("index"), projectionHash = Hash.sha256("index_projection") },
		projection = { hash = Hash.sha256("index_projection") },
		shards = { { kind = "StudioProjectEvidenceShard", nodes = {
			{ identity = workspaceIdentity, displayPath = "Workspace", name = "Workspace", className = "Workspace", engineContainer = { path = "Workspace", className = "Workspace" }, attributes = {} },
			{ identity = identity, parentIdentity = workspaceIdentity, displayPath = target.path, name = "ConformanceTarget", className = className, attributes = {}, coveredProperties = beforeProperties or {} },
		} } },
	}
	local projection = Generated.recompileMutationProjectionFromIndex(changeSet, {
		kind = "StudioEvidenceProjection", id = "native_conformance_preflight", manifestHash = Generated.manifestHash,
		purpose = "mutation_preflight", project = { name = "Forge native conformance", placeId = 0, universeId = 0 },
		binding = { sessionId = changeSet.sessionId, changeSetHash = changeSet.hash, approvalHash = Hash.sha256("fixed_fixture"), revisionHash = Hash.sha256("revision"), buildHash = Hash.sha256("fixture"), dashboardReviewHash = Hash.sha256("fixed_fixture") },
	}, capture)
	local prepared = {
		requestId = "native_conformance_request", changeSet = changeSet, operations = { operation },
		topology = Generated.compileMutationTransactionTopologyFromIndex(changeSet, capture), registry = {},
		projection = projection, preflightProjection = projection,
		beforeProjectIndexCapture = capture,
		beforeProjectRevisionHash = Hash.sha256("revision"), beforeProjectIndexManifestId = "native_conformance_index", beforeProjectDetectorEpoch = 0,
	}
	local payload = {
		requestId = prepared.requestId, creatorSessionId = changeSet.sessionId, changeSetId = changeSet.id, changeSetHash = changeSet.hash,
		projectionId = projection.id, projectionHash = projection.contentHash, preflightProjectionId = projection.id, preflightProjectionHash = projection.contentHash,
		manifestHash = Generated.manifestHash, expectedProjectRevisionHash = prepared.beforeProjectRevisionHash,
		beforeProjectIndexManifestId = prepared.beforeProjectIndexManifestId, beforeProjectDetectorEpoch = 0,
	}
	return prepared, payload
end

function Cases.physical()
	return { kind = "physical_properties", density = 2, friction = 0.4, elasticity = 0.25, frictionWeight = 30, elasticityWeight = 40, acousticAbsorption = 0.3 }
end

return Cases
