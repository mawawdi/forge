--!strict
-- Replays the generated-Luau half of an exact persisted creator Prepare
-- attempt. It intentionally reads the artifact references retained by the
-- creator session rather than constructing a stand-in change set or index.
--
-- Usage:
--   lune run scripts/replay-creator-prepare.luau \
--     .forge/creator/creator_session_<id>.json \
--     creator_mutation_attempt_<change-set-prefix>_<attempt>
--
-- The optional --expect-mismatch mode documents a known historical failure
-- before a fix is applied. Normal mode requires both declared projections to
-- pass the exact production generated recompile gate.

local fs = require("@lune/fs")
local process = require("@lune/process")
local serde = require("@lune/serde")

-- Lune deliberately has no Roblox EncodingService. The replay keeps the
-- production Hash module and supplies only that engine service with a local
-- SHA-256 implementation, returning the same raw 32-byte digest that Studio
-- returns. No production code takes a non-Studio hashing path.
local function sha256Bytes(input: string): string
	local bytes = table.create(#input + 72)
	for index = 1, #input do bytes[index] = string.byte(input, index) end
	local bitLength = #input * 8
	table.insert(bytes, 0x80)
	while #bytes % 64 ~= 56 do table.insert(bytes, 0) end
	local high = math.floor(bitLength / 4294967296)
	local low = bitLength % 4294967296
	for _, value in ipairs({ high, low }) do
		for shift = 24, 0, -8 do table.insert(bytes, bit32.band(bit32.rshift(value, shift), 0xff)) end
	end
	local constants = {
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	}
	local h0, h1, h2, h3 = 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a
	local h4, h5, h6, h7 = 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	local function add(...: number): number
		local sum = 0
		for _, value in ipairs({ ... }) do sum = (sum + value) % 4294967296 end
		return sum
	end
	for start = 1, #bytes, 64 do
		local words = {}
		for index = 0, 15 do
			local offset = start + index * 4
			words[index] = add(bit32.lshift(bytes[offset], 24), bit32.lshift(bytes[offset + 1], 16), bit32.lshift(bytes[offset + 2], 8), bytes[offset + 3])
		end
		for index = 16, 63 do
			local previous = words[index - 15]
			local s0 = bit32.bxor(bit32.rrotate(previous, 7), bit32.rrotate(previous, 18), bit32.rshift(previous, 3))
			local prior = words[index - 2]
			local s1 = bit32.bxor(bit32.rrotate(prior, 17), bit32.rrotate(prior, 19), bit32.rshift(prior, 10))
			words[index] = add(words[index - 16], s0, words[index - 7], s1)
		end
		local a, b, c, d = h0, h1, h2, h3
		local e, f, g, h = h4, h5, h6, h7
		for index = 0, 63 do
			local sigma1 = bit32.bxor(bit32.rrotate(e, 6), bit32.rrotate(e, 11), bit32.rrotate(e, 25))
			local choice = bit32.bxor(bit32.band(e, f), bit32.band(bit32.bnot(e), g))
			local temp1 = add(h, sigma1, choice, constants[index + 1], words[index])
			local sigma0 = bit32.bxor(bit32.rrotate(a, 2), bit32.rrotate(a, 13), bit32.rrotate(a, 22))
			local majority = bit32.bxor(bit32.band(a, b), bit32.band(a, c), bit32.band(b, c))
			local temp2 = add(sigma0, majority)
			h, g, f, e, d, c, b, a = g, f, e, add(d, temp1), c, b, a, add(temp1, temp2)
		end
		h0, h1, h2, h3 = add(h0, a), add(h1, b), add(h2, c), add(h3, d)
		h4, h5, h6, h7 = add(h4, e), add(h5, f), add(h6, g), add(h7, h)
	end
	local output = {}
	for _, value in ipairs({ h0, h1, h2, h3, h4, h5, h6, h7 }) do
		for shift = 24, 0, -8 do table.insert(output, string.char(bit32.band(bit32.rshift(value, shift), 0xff))) end
	end
	return table.concat(output)
end

local Hash = require("../plugin/src/Forge/Hash")
Hash.setDigestForTest(sha256Bytes)
assert(Hash.sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "offline EncodingService digest must be SHA-256 compatible")
local Generated = require("../plugin/src/Forge/GeneratedStudioEvidence")

local inputPath = process.args[1]
local inputId = process.args[2]
local mode = process.args[3]
local payloadMode = inputPath == "--payload"

if payloadMode then
	inputPath = inputId
	inputId = nil
	mode = process.args[3]
end
if typeof(inputPath) ~= "string" or inputPath == "" then
	error("usage: lune run scripts/replay-creator-prepare.luau <creator-session.json> [mutation-attempt-id] [--expect-mismatch]\n       lune run scripts/replay-creator-prepare.luau --payload <prepare-replay.json>")
end
if mode ~= nil and mode ~= "--expect-mismatch" then error("unsupported replay mode: " .. tostring(mode)) end
if not fs.isFile(inputPath) then error("replay input is not a regular file: " .. inputPath) end

local function decodeJson(path: string): any
	local decoded = serde.decode("json", fs.readFile(path))
	if typeof(decoded) ~= "table" then error("persisted JSON must be an object: " .. path) end
	return decoded
end

local function parentDirectory(path: string): string
	local parent = string.match(path, "^(.*)/[^/]+$")
	if typeof(parent) ~= "string" or parent == "" then error("creator session must have a parent directory: " .. path) end
	return parent
end

local changeSet: any
local directProjection: any
local preflightProjection: any
local beforeCapture: any
local replayLabel: string

if payloadMode then
	local payload = decodeJson(inputPath)
	if payload.kind ~= "CreatorPrepareReplayFixture" then error("replay payload has an invalid kind") end
	changeSet = payload.changeSet
	directProjection = payload.directProjection
	preflightProjection = payload.preflightProjection
	beforeCapture = payload.beforeCapture
	replayLabel = payload.id or inputPath
	if typeof(changeSet) ~= "table" or typeof(directProjection) ~= "table" or typeof(preflightProjection) ~= "table" or typeof(beforeCapture) ~= "table" then error("replay payload is incomplete") end
else
	local session = decodeJson(inputPath)
	if typeof(session.mutationAttempts) ~= "table" then error("creator session has no mutation attempts") end
	local attempt: any = nil
	for _, candidate in ipairs(session.mutationAttempts) do
		if typeof(candidate) == "table" and (inputId == nil or candidate.id == inputId) then
			if attempt ~= nil then error("mutation attempt selection is ambiguous; pass its exact id") end
			attempt = candidate
		end
	end
	if typeof(attempt) ~= "table" then error("mutation attempt was not found: " .. tostring(inputId)) end
	if attempt.kind ~= "CreatorMutationAttempt" then error("selected mutation attempt has an invalid kind") end
	local artifactDirectory = parentDirectory(inputPath)
	local function readArtifact(binding: any, label: string): any
		if typeof(binding) ~= "table" or typeof(binding.artifact) ~= "table" then error(label .. " artifact binding is missing") end
		local artifact = binding.artifact
		if typeof(artifact.locator) ~= "string" or string.sub(artifact.locator, 1, 10) ~= "artifacts/" then error(label .. " artifact locator is outside the creator artifact store") end
		if string.find(artifact.locator, "..", 1, true) then error(label .. " artifact locator is malformed") end
		local path = artifactDirectory .. "/" .. artifact.locator
		if not fs.isFile(path) then error(label .. " artifact is absent: " .. path) end
		local value = decodeJson(path)
		local observedHash = value.hash or value.contentHash
		if typeof(binding.hash) ~= "string" or observedHash ~= binding.hash then error(label .. " artifact hash binding mismatch") end
		return value
	end
	if typeof(session.changeSets) ~= "table" then error("creator session has no sealed change sets") end
	for _, candidate in ipairs(session.changeSets) do
		if typeof(candidate) == "table" and candidate.hash == attempt.changeSet.hash then
			if changeSet ~= nil then error("creator session has duplicate sealed change-set hashes") end
			changeSet = candidate
		end
	end
	if typeof(changeSet) ~= "table" or changeSet.kind ~= "CreatorChangeSet" then error("exact sealed change set is absent from creator session") end
	local preparedChangeSetEvidence = readArtifact(attempt.changeSet, "prepared change-set evidence")
	directProjection = readArtifact(attempt.projection, "declared direct-readback projection")
	preflightProjection = readArtifact(attempt.preflightProjection, "declared preflight projection")
	local binding = attempt.beforeIndexCapture
	if typeof(binding) ~= "table" then error("mutation attempt has no before-index capture") end
	local shards = {}
	if typeof(binding.shards) ~= "table" then error("before-index capture has no shards") end
	for _, shardBinding in ipairs(binding.shards) do table.insert(shards, readArtifact(shardBinding, "before-index shard")) end
	beforeCapture = { kind = "StudioProjectIndexCapture", indexManifest = readArtifact(binding.manifest, "before-index manifest"), revision = readArtifact(binding.revision, "before-index revision"), projection = readArtifact(binding.projection, "before-index projection"), shards = shards }
	if changeSet.hash ~= attempt.changeSet.hash or typeof(changeSet.id) ~= "string" or changeSet.id == "" then error("sealed change-set identity is malformed") end
	if preparedChangeSetEvidence.kind ~= "CreatorChangeSet" or preparedChangeSetEvidence.id ~= changeSet.id or preparedChangeSetEvidence.hash ~= changeSet.hash then error("prepared change-set artifact does not bind the exact sealed command payload") end
	if typeof(preparedChangeSetEvidence.operations) ~= "table" or #preparedChangeSetEvidence.operations ~= #changeSet.operations then error("prepared change-set artifact operation coverage mismatch") end
	for index, operation in ipairs(changeSet.operations) do if preparedChangeSetEvidence.operations[index].id ~= operation.id then error("prepared change-set artifact operation identity mismatch") end end
	replayLabel = attempt.id
end

if changeSet.expectedRevisionHash ~= beforeCapture.revision.hash then error("sealed change set is not bound to the reconstructed pre-Apply revision") end
if directProjection.purpose ~= "mutation_direct_readback" or preflightProjection.purpose ~= "mutation_preflight" then error("declared projections have invalid creator purposes") end
if directProjection.manifestHash ~= Generated.manifestHash or preflightProjection.manifestHash ~= Generated.manifestHash then error("persisted projections target a different generated manifest") end

-- This is the production gate invoked by StudioAuthoring:prepare after the
-- sealed JSON and binding checks. It compiles from the actual index shards,
-- then requires semantic material and hash equality with the declared payload.
local function assertRecompile(projection: any, label: string)
	local ok, result = pcall(function()
		return Generated.assertRecompiledMutationProjectionFromIndex(changeSet, projection, beforeCapture)
	end)
	if mode == "--expect-mismatch" then
		if ok then error(label .. " unexpectedly passed a replay that was expected to reproduce the historical mismatch") end
		if not string.find(tostring(result), "mutation projection project-index recompilation mismatch", 1, true) then error(label .. " failed outside the expected production recompile boundary: " .. tostring(result)) end
		return
	end
	if not ok then
		-- Keep malformed declared projections actionable when replaying a large
		-- persisted attempt. The production gate remains the authority; this
		-- only identifies the exact serialized requirement that it rejected.
		local materialOk = pcall(function()
			Generated.projectionMaterial(projection)
		end)
		if not materialOk and typeof(projection.requirements) == "table" then
			for ordinal, requirement in ipairs(projection.requirements) do
				local candidate = table.clone(projection)
				candidate.requirements = { requirement }
				local requirementOk, requirementFailure = pcall(function()
					Generated.projectionMaterial(candidate)
				end)
				if not requirementOk then
					error(label .. " has an invalid declared requirement at ordinal " .. tostring(ordinal) .. " (" .. tostring(requirement.key) .. "): " .. tostring(requirementFailure))
				end
			end
		end
		-- Never split a failed transaction into individual operations here.
		-- Parent creation, reference creation, sibling freeing, and ancestor
		-- movement are intentionally batch semantics; a one-operation replay can
		-- reject a dependency that is valid only in the sealed transaction.
		error(label .. " failed production generated recompile validation: " .. tostring(result))
	end
	if result.contentHash ~= projection.contentHash then error(label .. " recompile returned a different content hash") end
end

assertRecompile(directProjection, "direct-readback projection")
assertRecompile(preflightProjection, "preflight projection")

print("creator prepare artifact replay passed: " .. replayLabel)
