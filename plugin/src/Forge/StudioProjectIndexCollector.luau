--!strict
-- A complete existing-project index is deliberately separate from exact
-- mutation/runtime evidence. It records every instance under the declared
-- roots (including unknown classes) and exports source as content-addressed
-- manifests/chunks rather than embedding one unbounded source body.
local CollectionService = game:GetService("CollectionService")
local Constants = require(script.Parent.Constants)
local Generated = require(script.Parent.GeneratedStudioEvidence)
local Hash = require(script.Parent.Hash)
local Canonical = require(script.Parent.StudioProjectIndexCanonical)
local StudioScriptSource = require(script.Parent.StudioScriptSource)
local Utf8Transport = require(script.Parent.Utf8Transport)

local StudioProjectIndexCollector = {}
StudioProjectIndexCollector.__index = StudioProjectIndexCollector

local function iso(): string return os.date("!%Y-%m-%dT%H:%M:%S.000Z") end
local function project() return { name = game.Name, placeId = game.PlaceId, universeId = game.GameId } end
local function hash(value: any, cooperate: (() -> ())?): string return Hash.sha256(Canonical.material(value, cooperate)) end
local function bytes(value: string): number return #value end

local function pathOf(instance: Instance): string
	local parts = {}; local cursor: Instance? = instance
	while cursor and cursor ~= game do table.insert(parts, 1, cursor.Name); cursor = cursor.Parent end
	return table.concat(parts, "/")
end

local function sameProject(left: any, right: any): boolean
	return typeof(left) == "table" and typeof(right) == "table" and left.name == right.name and left.placeId == right.placeId and left.universeId == right.universeId
end

local function policyMatches(policy: any): boolean
	return typeof(policy) == "table"
		and policy.kind == "CreatorResourcePolicy"
		and policy.maximumInstances == Constants.PROJECT_INDEX_MAXIMUM_INSTANCES
		and policy.maximumCanonicalIndexBytes == Constants.PROJECT_INDEX_MAXIMUM_CANONICAL_BYTES
		and policy.maximumSourceBlobBytes == Constants.PROJECT_INDEX_MAXIMUM_SOURCE_BLOB_BYTES
		and policy.maximumIndexingDurationMs == Constants.PROJECT_INDEX_MAXIMUM_DURATION_MS
		and policy.maximumNodesPerShard == Constants.PROJECT_INDEX_MAXIMUM_NODES_PER_SHARD
		and policy.maximumCanonicalShardBytes == Constants.PROJECT_INDEX_MAXIMUM_SHARD_BYTES
		and policy.transportChunkBytes == Constants.PROJECT_INDEX_TRANSPORT_CHUNK_BYTES
end

local function sortIdentity(left: any, right: any): boolean
	local function key(identity: any): string
		if identity.kind == "forge_attribute" then return "forge_attribute:" .. identity.stableId end
		if identity.kind == "studio_ephemeral" then return "studio_ephemeral:" .. identity.connectorEpoch .. ":" .. identity.opaqueHash end
		if identity.kind == "rojo_sourcemap" then return "rojo_sourcemap:" .. identity.authorityMapHash .. ":" .. identity.sourcemapHash .. ":" .. identity.mappingId end
		error("project index identity is malformed")
	end
	return key(left) < key(right)
end

-- table.sort cannot yield and its former comparator recomputed display paths
-- and opaque hashes O(n log n) times. This bottom-up merge sort compares
-- precomputed keys and cooperates between bounded assignments.
local function cooperativeSort(values: {any}, less: (any, any) -> boolean, cooperate: () -> ())
	local count = #values
	if count < 2 then return end
	local source = values
	local target = table.create(count)
	local width = 1
	while width < count do
		local block = 1
		while block <= count do
			local left = block
			local leftEnd = math.min(block + width - 1, count)
			local right = leftEnd + 1
			local rightEnd = math.min(block + width * 2 - 1, count)
			local output = block
			while left <= leftEnd or right <= rightEnd do
				if right > rightEnd or left <= leftEnd and not less(source[right], source[left]) then
					target[output] = source[left]
					left += 1
				else
					target[output] = source[right]
					right += 1
				end
				output += 1
				cooperate()
			end
			block += width * 2
		end
		source, target = target, source
		width *= 2
	end
	if source ~= values then
		for index = 1, count do values[index] = source[index]; cooperate() end
	end
end

local function rootRecords(root: Instance?, registry, cooperate: () -> (), maximumCount: number): {any}
	if root == nil then return {} end
	local records = {}
	local stack = { root }
	while #stack > 0 do
		local instance = table.remove(stack)
		table.insert(records, {
			instance = instance,
			displayPath = pathOf(instance),
			identity = registry:identityFor(instance),
		})
		if #records > maximumCount then error("project index instance resource policy exceeded") end
		local children = instance:GetChildren()
		for index = #children, 1, -1 do table.insert(stack, children[index]); cooperate() end
		cooperate()
	end
	cooperativeSort(records, function(left: any, right: any): boolean
		if left.displayPath == right.displayPath then return sortIdentity(left.identity, right.identity) end
		return left.displayPath < right.displayPath
	end, cooperate)
	return records
end

local function sortedStringKeys(value: any): {string}
	local keys = {}
	for key in pairs(value) do if typeof(key) == "string" then table.insert(keys, key) else error("project index object key is not a string") end end
	table.sort(keys)
	return keys
end

local function assertBeforeDeadline(deadline: number)
	if os.clock() > deadline then error("project index duration resource policy exceeded") end
end

local function sourceChunks(identity: any, source: string, editorSource: boolean, deadline: number, cooperate: () -> ()): (any, {any})
	assertBeforeDeadline(deadline)
	local sourceHash = Hash.sha256(source)
	local chunks = {}
	local ends = Utf8Transport.boundaries(source, Constants.PROJECT_INDEX_TRANSPORT_CHUNK_BYTES, cooperate)
	if #ends == 0 then ends = { 0 } end
	local startByte = 0
	for ordinal, endByte in ipairs(ends) do
		assertBeforeDeadline(deadline)
		local utf8 = string.sub(source, startByte + 1, endByte)
		local zeroBasedOrdinal = ordinal - 1
		local payload = { sourceHash = sourceHash, ordinal = zeroBasedOrdinal, startByte = startByte, endByte = endByte, utf8 = utf8 }
		local chunkHash = hash(payload, cooperate)
		table.insert(chunks, { kind = "StudioSourceBlobChunk", id = "studio_source_blob_chunk_" .. string.sub(chunkHash, 1, 24), hash = chunkHash, sourceHash = sourceHash, ordinal = zeroBasedOrdinal, startByte = startByte, endByte = endByte, utf8 = utf8 })
		startByte = endByte
		cooperate()
	end
	local chunkHashes = {}
	for index, chunk in ipairs(chunks) do chunkHashes[index] = chunk.hash end
	local manifestPayload = { identity = identity, sourceHash = sourceHash, utf8Bytes = #source, chunkHashes = chunkHashes, editorSource = editorSource }
	local manifestHash = hash(manifestPayload, cooperate)
	return { kind = "StudioSourceBlobManifest", id = "studio_source_blob_manifest_" .. string.sub(manifestHash, 1, 24), hash = manifestHash, identity = identity, sourceHash = sourceHash, utf8Bytes = #source, chunkHashes = chunkHashes, editorSource = editorSource }, chunks
end

local function canonicalAttributes(instance: Instance): any
	local attributes = Canonical.object({})
	for _, name in ipairs(sortedStringKeys(instance:GetAttributes())) do
		if name ~= Constants.IDENTITY_ATTRIBUTE then attributes[name] = Generated.canonicalProjectAttribute(instance:GetAttribute(name)) end
	end
	return attributes
end

local function canonicalProperties(instance: Instance, registry): (any, {string})
	local properties, names = Canonical.object({}), {}
	for _, property in ipairs(Generated.projectPropertyMetadata(instance.ClassName)) do
		local value = Generated.readProjectProperty(instance, property.name, function(reference: Instance, referenceProperty: any)
			-- Reference values use the same closed identity algebra as mutation
			-- targets. The display path/class are preconditions for human review,
			-- never an authority fallback.
			return {
				kind = "instance_ref",
				state = "reference",
				identity = registry:identityFor(reference),
				path = pathOf(reference),
				className = reference.ClassName,
				expectedClass = referenceProperty.referenceClass,
			}
		end)
		properties[property.name] = value; table.insert(names, property.name)
	end
	table.sort(names)
	return properties, names
end

local function nodeFor(instance: Instance, registry, sourceManifests: {any}, sourceChunksOut: {any}, deadline: number, cooperate: () -> ()): any
	assertBeforeDeadline(deadline)
	local identity = registry:identityFor(instance)
	local parentIdentity = nil
	if instance.Parent and instance.Parent ~= game then parentIdentity = registry:identityFor(instance.Parent) end
	local displayPath = pathOf(instance)
	local properties, propertyNames = canonicalProperties(instance, registry)
	local tags = CollectionService:GetTags(instance); table.sort(tags)
	local node: any = {
		identity = identity,
		displayPath = displayPath,
		name = instance.Name,
		className = instance.ClassName,
		attributes = canonicalAttributes(instance),
		tags = tags,
		coveredProperties = properties,
		coveredPropertyNames = propertyNames,
	}
	if parentIdentity then node.parentIdentity = parentIdentity end
	local engineContainerClass = Generated.authoringContainerClass(displayPath)
	if engineContainerClass == instance.ClassName then
		node.engineContainer = { path = displayPath, className = engineContainerClass }
	end
	if instance:IsA("LuaSourceContainer") then
		local source, editorSource = StudioScriptSource.read(instance)
		assertBeforeDeadline(deadline)
		if #source > Constants.PROJECT_INDEX_MAXIMUM_SOURCE_BLOB_BYTES then error("project index source exceeds configured resource policy") end
		local sourceManifest, chunks = sourceChunks(identity, source, editorSource, deadline, cooperate)
		node.sourceManifestHash = sourceManifest.hash
		table.insert(sourceManifests, sourceManifest)
		for _, chunk in ipairs(chunks) do table.insert(sourceChunksOut, chunk) end
	end
	return node
end

function StudioProjectIndexCollector.new(registry)
	return setmetatable({ registry = registry }, StudioProjectIndexCollector)
end

function StudioProjectIndexCollector:identity() return project() end

function StudioProjectIndexCollector:produce(projection: any, detectorEpoch: number, currentDetectorEpoch: () -> number, collectionDeadline: number): any
	if typeof(projection) ~= "table" or projection.kind ~= "StudioProjectIndexProjection" then error("project index projection is malformed") end
	if projection.manifestHash ~= Generated.manifestHash or projection.purpose ~= "creator_project_index" or not sameProject(projection.project, project()) then error("project index projection binding mismatch") end
	if projection.connectorEpoch ~= self.registry.connectorEpoch or not policyMatches(projection.bounds) then error("project index projection connector or resource binding mismatch") end
	if typeof(projection.roots) ~= "table" then error("project index roots are malformed") end
	local expectedRoots = Generated.authoringRoots
	if #projection.roots ~= #expectedRoots then error("project index root coverage mismatch") end
	for index, rootName in ipairs(expectedRoots) do if projection.roots[index] ~= rootName then error("project index root coverage mismatch") end end
	local started = os.clock()
	if typeof(detectorEpoch) ~= "number"
		or detectorEpoch % 1 ~= 0
		or detectorEpoch < 0
		or typeof(currentDetectorEpoch) ~= "function"
		or typeof(collectionDeadline) ~= "number"
		or collectionDeadline <= started
		or collectionDeadline > started + Constants.PROJECT_INDEX_MAXIMUM_DURATION_MS / 1000
	then error("project index detector epoch or collection deadline is malformed") end
	local function assertStableEpoch()
		assertBeforeDeadline(collectionDeadline)
		if currentDetectorEpoch() ~= detectorEpoch then error("project index changed during collection") end
	end
	local nextYieldAt = os.clock() + 0.01
	local function cooperate()
		assertStableEpoch()
		if os.clock() < nextYieldAt then return end
		task.wait()
		nextYieldAt = os.clock() + 0.01
		assertStableEpoch()
	end
	assertStableEpoch()
	local sourceManifests, sourceChunksOut, shards = {}, {}, {}
	-- Source chunks are content-addressed by body hash and byte range. Multiple
	-- scripts may legitimately have identical source; transport that leaf once
	-- rather than manufacturing duplicate evidence for the same immutable blob.
	local seenSourceChunkHashes = {}
	local instanceCount = 0
	for _, rootName in ipairs(projection.roots) do
		assertStableEpoch()
		local root = game:FindFirstChild(rootName)
		local records = rootRecords(root, self.registry, cooperate, Constants.PROJECT_INDEX_MAXIMUM_INSTANCES - instanceCount)
		local ordinal = 0
		local cursor = 1
		local emptyShardPending = #records == 0
		local pendingNode: any = nil
		local pendingNodeMaterial: any = nil
		local pendingManifests: any = nil
		local pendingChunks: any = nil
		-- A missing root still produces an empty ordinal-zero shard, making
		-- complete root enumeration distinguishable from an omitted root. The
		-- explicit one-shot flag is essential: cursor cannot advance when the
		-- root has zero instances.
		while cursor <= #records or emptyShardPending do
			cooperate()
			local nodes = {}
			local taggedNodeBytes = 0
			while cursor <= #records and #nodes < Constants.PROJECT_INDEX_MAXIMUM_NODES_PER_SHARD do
				local candidate, candidateMaterial, candidateManifests, candidateChunks = pendingNode, pendingNodeMaterial, pendingManifests, pendingChunks
				if candidate == nil then
					candidateManifests, candidateChunks = {}, {}
					candidate = nodeFor(records[cursor].instance, self.registry, candidateManifests, candidateChunks, collectionDeadline, cooperate)
					candidateMaterial = Canonical.material(candidate, cooperate)
				end
				if typeof(candidateMaterial) ~= "string" or typeof(candidateManifests) ~= "table" or typeof(candidateChunks) ~= "table" then error("project index pending node state is malformed") end
				local trialTaggedNodeBytes = taggedNodeBytes + Canonical.taggedMaterialLength("item", #candidateMaterial)
				local trialBytes = Canonical.objectMaterialLength({
					root = #Canonical.material(rootName),
					ordinal = #Canonical.material(ordinal),
					nodes = Canonical.arrayMaterialLength(#nodes + 1, trialTaggedNodeBytes),
				})
				if trialBytes > Constants.PROJECT_INDEX_MAXIMUM_SHARD_BYTES then
					-- The index always makes progress when a valid node can fit in a
					-- fresh shard. A node which cannot fit by itself is inherently
					-- outside the declared resource policy; do not produce a partial
					-- index or keep re-reading it in a retry loop.
					if #nodes == 0 then error("project index node exceeds configured shard resource policy") end
					pendingNode, pendingNodeMaterial, pendingManifests, pendingChunks = candidate, candidateMaterial, candidateManifests, candidateChunks
					break
				end
				table.insert(nodes, candidate)
				taggedNodeBytes = trialTaggedNodeBytes
				for _, sourceManifest in ipairs(candidateManifests) do table.insert(sourceManifests, sourceManifest) end
				for _, sourceChunk in ipairs(candidateChunks) do
					if not seenSourceChunkHashes[sourceChunk.hash] then
						seenSourceChunkHashes[sourceChunk.hash] = true
						table.insert(sourceChunksOut, sourceChunk)
					end
				end
				pendingNode, pendingNodeMaterial, pendingManifests, pendingChunks = nil, nil, nil, nil
				cursor += 1; instanceCount += 1
				if instanceCount > Constants.PROJECT_INDEX_MAXIMUM_INSTANCES then error("project index instance resource policy exceeded") end
				cooperate()
			end
			-- rootRecords is globally canonical. Each shard is a contiguous slice,
			-- so sorting again is redundant and would create a non-yielding Studio
			-- callback proportional to the maximum shard size.
			local shardPayload = { root = rootName, ordinal = ordinal, nodes = nodes }
			local canonicalBytes = bytes(Canonical.material(shardPayload, cooperate))
			local measuredBytes = Canonical.objectMaterialLength({
				root = #Canonical.material(rootName),
				ordinal = #Canonical.material(ordinal),
				nodes = Canonical.arrayMaterialLength(#nodes, taggedNodeBytes),
			})
			if canonicalBytes ~= measuredBytes then error("project index shard canonical length mismatch") end
			if canonicalBytes > Constants.PROJECT_INDEX_MAXIMUM_SHARD_BYTES then error("project index shard resource policy exceeded") end
			local shardHash = hash({ root = rootName, ordinal = ordinal, nodes = nodes, canonicalBytes = canonicalBytes }, cooperate)
			table.insert(shards, { kind = "StudioProjectEvidenceShard", id = "studio_project_evidence_shard_" .. string.sub(shardHash, 1, 24), hash = shardHash, root = rootName, ordinal = ordinal, nodes = nodes, canonicalBytes = canonicalBytes })
			ordinal += 1
			emptyShardPending = false
			cooperate()
		end
	end
	assertStableEpoch()
	cooperativeSort(sourceManifests, function(left: any, right: any) return sortIdentity(left.identity, right.identity) end, cooperate)
	cooperativeSort(sourceChunksOut, function(left: any, right: any) return left.sourceHash == right.sourceHash and left.ordinal < right.ordinal or left.sourceHash < right.sourceHash end, cooperate)
	local rootShardHashes, allShardHashes = {}, {}
	for _, rootName in ipairs(projection.roots) do
		local hashes = {}
		for _, shard in ipairs(shards) do if shard.root == rootName then table.insert(hashes, shard.hash) end end
		table.insert(rootShardHashes, { root = rootName, hash = hash(hashes) })
	end
	for index, shard in ipairs(shards) do allShardHashes[index] = shard.hash end
	local sourceManifestHashes = {}
	for _, sourceManifest in ipairs(sourceManifests) do table.insert(sourceManifestHashes, sourceManifest.hash) end
	cooperativeSort(sourceManifestHashes, function(left: any, right: any): boolean return left < right end, cooperate)
	local canonicalBytes = 0
	for _, shard in ipairs(shards) do canonicalBytes += shard.canonicalBytes end
	for _, sourceManifest in ipairs(sourceManifests) do canonicalBytes += bytes(Canonical.material(sourceManifest, cooperate)); cooperate() end
	for _, sourceChunk in ipairs(sourceChunksOut) do canonicalBytes += bytes(Canonical.material(sourceChunk, cooperate)); cooperate() end
	if canonicalBytes > Constants.PROJECT_INDEX_MAXIMUM_CANONICAL_BYTES then error("project index canonical resource policy exceeded") end
	local semanticManifest = { manifestHash = projection.manifestHash, projectionHash = projection.hash, project = projection.project, connectorEpoch = projection.connectorEpoch, rootShardHashes = rootShardHashes, allShardHashes = allShardHashes, sourceManifestHashes = sourceManifestHashes, instanceCount = instanceCount, canonicalBytes = canonicalBytes }
	local indexHash = hash(semanticManifest, cooperate)
	local completedAt = iso()
	local indexManifest = { kind = "StudioProjectIndexManifest", id = "studio_project_index_manifest_" .. string.sub(indexHash, 1, 24), hash = indexHash, manifestHash = projection.manifestHash, projectionHash = projection.hash, project = projection.project, connectorEpoch = projection.connectorEpoch, rootShardHashes = rootShardHashes, allShardHashes = allShardHashes, sourceManifestHashes = sourceManifestHashes, instanceCount = instanceCount, canonicalBytes = canonicalBytes, completedAt = completedAt }
	local merkleInputs = { projection.manifestHash, projection.hash }
	for _, rootShardHash in ipairs(rootShardHashes) do table.insert(merkleInputs, rootShardHash.hash) end
	for _, shardHash in ipairs(allShardHashes) do table.insert(merkleInputs, shardHash) end
	for _, sourceManifestHash in ipairs(sourceManifestHashes) do table.insert(merkleInputs, sourceManifestHash) end
	local merkleRoot = hash(merkleInputs, cooperate)
	local revisionPayload = { manifestHash = projection.manifestHash, projectionHash = projection.hash, indexManifestHash = indexManifest.hash, merkleRoot = merkleRoot, project = projection.project, connectorEpoch = projection.connectorEpoch }
	local revisionHash = hash(revisionPayload, cooperate)
	local revision = { kind = "StudioProjectRevision", id = "studio_project_index_revision_" .. string.sub(revisionHash, 1, 24), hash = revisionHash, manifestHash = projection.manifestHash, projectionHash = projection.hash, indexManifestHash = indexManifest.hash, merkleRoot = merkleRoot, project = projection.project, connectorEpoch = projection.connectorEpoch, capturedAt = completedAt }
	local capturePayload = { detectorEpoch = detectorEpoch, projection = projection, indexManifest = indexManifest, revision = revision, shards = shards, sourceManifests = sourceManifests, sourceChunks = sourceChunksOut }
	return { kind = "StudioProjectIndexCapture", detectorEpoch = detectorEpoch, projection = projection, indexManifest = indexManifest, revision = revision, shards = shards, sourceManifests = sourceManifests, sourceChunks = sourceChunksOut, hash = hash(capturePayload, cooperate) }
end

-- Indexing is streamed as independently validated, typed leaves. Each leaf
-- may be UTF-8-fragmented for transport, but the backend reassembles and
-- hashes the exact leaf before the completed header can become a revision.
--
-- A completed capture is immutable historical evidence. Engine callbacks
-- which arrive after collection may make it ineligible as the connector's
-- *current* authority, but cannot retroactively invalidate its bytes while
-- they are encoded or transported. Runtime owns that separate currentness
-- decision after the complete stream has been accepted.
function StudioProjectIndexCollector:transport(capture: any): any
	if typeof(capture) ~= "table"
		or capture.kind ~= "StudioProjectIndexCapture"
		or typeof(capture.detectorEpoch) ~= "number"
		or capture.detectorEpoch % 1 ~= 0
		or capture.detectorEpoch < 0
		or typeof(capture.projection) ~= "table"
		or typeof(capture.indexManifest) ~= "table"
		or typeof(capture.revision) ~= "table"
		or typeof(capture.shards) ~= "table"
		or typeof(capture.sourceManifests) ~= "table"
		or typeof(capture.sourceChunks) ~= "table"
	then error("project index transport capture is malformed") end
	local deadline = os.clock() + Constants.PROJECT_INDEX_MAXIMUM_DURATION_MS / 1000
	local expectedEpoch = capture.detectorEpoch
	local function assertTransportBudget()
		assertBeforeDeadline(deadline)
	end
	local nextYieldAt = os.clock() + 0.01
	local function cooperate()
		assertTransportBudget()
		if os.clock() < nextYieldAt then return end
		task.wait()
		nextYieldAt = os.clock() + 0.01
		assertTransportBudget()
	end
	assertTransportBudget()
	-- Encode at most one logical leaf at a time. The first pass counts exact
	-- UTF-8 fragments; the emitter re-encodes one leaf and releases it before
	-- moving to the next. This keeps transport memory bounded by one shard.
	local function encodedFragmentEnds(artifact: any): (string, {number})
		cooperate()
		local encoded = Canonical.transportJson(artifact, cooperate)
		cooperate()
		local ends = Utf8Transport.boundaries(encoded, Constants.PROJECT_INDEX_TRANSPORT_CHUNK_BYTES, cooperate)
		cooperate()
		return encoded, ends
	end
	local function forEachArtifact(visitor: (string, any) -> ())
		for _, shard in ipairs(capture.shards) do visitor("StudioProjectEvidenceShard", shard) end
		for _, sourceManifest in ipairs(capture.sourceManifests) do visitor("StudioSourceBlobManifest", sourceManifest) end
		for _, sourceChunk in ipairs(capture.sourceChunks) do visitor("StudioSourceBlobChunk", sourceChunk) end
	end
	local pieceCount = 0
	forEachArtifact(function(_artifactType: string, artifact: any)
		local _encoded, ends = encodedFragmentEnds(artifact)
		pieceCount += #ends
		cooperate()
	end)
	assertTransportBudget()
	if pieceCount < 1 or pieceCount > Constants.MAX_PROJECT_INDEX_PIECES then error("project index transport piece bound exceeded") end
	local captureId = capture.indexManifest.id
	local started = {
		project = capture.projection.project,
		captureId = captureId,
		projection = capture.projection,
		pieceCount = pieceCount,
		expectedShardCount = #capture.shards,
		expectedSourceManifestCount = #capture.sourceManifests,
		expectedSourceChunkCount = #capture.sourceChunks,
		expectedCanonicalBytes = capture.indexManifest.canonicalBytes,
		detectorEpoch = expectedEpoch,
	}
	local indexManifest = {
		kind = capture.indexManifest.kind,
		id = capture.indexManifest.id,
		hash = capture.indexManifest.hash,
		manifestHash = capture.indexManifest.manifestHash,
		projectionHash = capture.indexManifest.projectionHash,
		project = capture.indexManifest.project,
		connectorEpoch = capture.indexManifest.connectorEpoch,
		rootShardHashes = capture.indexManifest.rootShardHashes,
		allShardHashes = capture.indexManifest.allShardHashes,
		instanceCount = capture.indexManifest.instanceCount,
		canonicalBytes = capture.indexManifest.canonicalBytes,
		completedAt = capture.indexManifest.completedAt,
		sourceManifestCount = #capture.sourceManifests,
	}
	assertTransportBudget()
	return {
		started = started,
		emit = function(emitPiece: (string, any) -> ())
			if typeof(emitPiece) ~= "function" then error("project index transport emitter is required") end
			local sequence = 0
			forEachArtifact(function(artifactType: string, artifact: any)
				local encoded, ends = encodedFragmentEnds(artifact)
				local startByte = 0
				for ordinal, endByte in ipairs(ends) do
					local fragmentPayload = string.sub(encoded, startByte + 1, endByte)
					emitPiece(artifactType, {
						project = capture.projection.project,
						captureId = captureId,
						sequence = sequence,
						artifact = { kind = artifactType, id = artifact.id, hash = artifact.hash },
						fragmentOrdinal = ordinal - 1,
						fragmentCount = #ends,
						encoding = "json",
						payload = fragmentPayload,
						payloadHash = Hash.sha256(fragmentPayload),
					})
					sequence += 1
					startByte = endByte
					cooperate()
				end
			end)
			if sequence ~= pieceCount then error("project index transport count changed during emission") end
			assertTransportBudget()
		end,
		completed = { project = capture.projection.project, captureId = captureId, pieceCount = pieceCount, indexManifest = indexManifest, revision = capture.revision, captureHash = capture.hash, detectorEpoch = expectedEpoch },
	}
end

return StudioProjectIndexCollector
