-- Replays the full host-created CreatorChangePrepareDocument transport through
-- StudioAuthoring's production fragment assembly, JSON decoding, and pure
-- Prepare boundary. The tiny game surface is read-only: no Instance is ever
-- created or parented.

local fs = require("@lune/fs")
local process = require("@lune/process")
local serde = require("@lune/serde")

local inputPath = process.args[1]
if typeof(inputPath) ~= "string" or inputPath == "" or not fs.isFile(inputPath) then
	error("usage: lune run scripts/replay-creator-prepare-transfer.luau <payload.json>")
end
local payload = serde.decode("json", fs.readFile(inputPath))
if typeof(payload) ~= "table" or payload.kind ~= "CreatorPrepareTransferReplayFixture" then
	error("Prepare transfer replay payload is malformed")
end

-- Lune has no EncodingService. This test-only implementation supplies the
-- same raw SHA-256 bytes that Studio's EncodingService returns, so the real
-- plugin hash checks remain enabled throughout the replay.
local function sha256Bytes(input: string): string
	local bytes = table.create(#input + 72)
	for index = 1, #input do bytes[index] = string.byte(input, index) end
	local bitLength = #input * 8
	table.insert(bytes, 0x80)
	while #bytes % 64 ~= 56 do table.insert(bytes, 0) end
	local high, low = math.floor(bitLength / 4294967296), bitLength % 4294967296
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
		local a, b, c, d, e, f, g, h = h0, h1, h2, h3, h4, h5, h6, h7
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

local settings = {}
local gameChildren: {[string]: any} = {}
game = {
	FindFirstChild = function(_self: any, name: string): any return gameChildren[name] end,
	GetService = function(_self: any, name: string): any
		if name == "HttpService" then return { JSONDecode = function(_service: any, value: string): any return serde.decode("json", value) end } end
		if name == "ChangeHistoryService" then return { IsRecordingInProgress = function(): boolean return false end } end
		error("unexpected read-only service: " .. name)
	end,
}

local Hash = require("../plugin/src/Forge/Hash")
Hash.setDigestForTest(sha256Bytes)
assert(
	Hash.sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	"offline EncodingService digest must be SHA-256 compatible"
)
local StudioAuthoring = require("../plugin/src/Forge/StudioAuthoring")
local plugin = {
	GetSetting = function(_self: any, key: string): any return settings[key] end,
	SetSetting = function(_self: any, key: string, value: any) settings[key] = value end,
}

local function identityKey(identity: any): string
	if typeof(identity) ~= "table" or typeof(identity.kind) ~= "string" then error("Prepare replay index identity is malformed") end
	if identity.kind == "forge_attribute" and typeof(identity.stableId) == "string" then return "forge_attribute:" .. identity.stableId end
	if identity.kind == "studio_ephemeral" and typeof(identity.connectorEpoch) == "string" and typeof(identity.opaqueHash) == "string" then return "studio_ephemeral:" .. identity.connectorEpoch .. ":" .. identity.opaqueHash end
	if identity.kind == "rojo_sourcemap" and typeof(identity.authorityMapHash) == "string" and typeof(identity.sourcemapHash) == "string" and typeof(identity.mappingId) == "string" then return "rojo_sourcemap:" .. identity.authorityMapHash .. ":" .. identity.sourcemapHash .. ":" .. identity.mappingId end
	error("Prepare replay index identity is malformed")
end

-- Build a read-only fake Studio hierarchy from the exact index capture. This
-- exercises real parent resolution in StudioAuthoring:prepare while keeping
-- the replay incapable of creating, parenting, or mutating a Studio object.
local function indexRegistry(capture: any): any
	if typeof(capture) ~= "table" or typeof(capture.shards) ~= "table" then error("Prepare replay has no project-index shards") end
	local nodes, objectsByIdentity, nodeByIdentity = {}, {}, {}
	for _, shard in ipairs(capture.shards) do
		if typeof(shard) ~= "table" or typeof(shard.nodes) ~= "table" then error("Prepare replay project-index shard is malformed") end
		for _, node in ipairs(shard.nodes) do
			if typeof(node) ~= "table" or typeof(node.identity) ~= "table" or typeof(node.displayPath) ~= "string" or typeof(node.name) ~= "string" or typeof(node.className) ~= "string" then error("Prepare replay project-index node is malformed") end
			local key = identityKey(node.identity)
			if nodeByIdentity[key] ~= nil then error("Prepare replay project index has duplicate identity") end
			local children: {[string]: any} = {}
			local object = {
				Name = node.name,
				ClassName = node.className,
				Parent = nil,
				FindFirstChild = function(_self: any, name: string): any return children[name] end,
				-- Prepare's delete-bound check counts the exact pre-indexed
				-- descendant closure before a recording may open. Keep this
				-- read-only replay faithful to that Studio surface without
				-- permitting any mutation operation in the harness.
				GetDescendants = function(self: any): {any}
					local descendants = {}
					local function visit(parent: any)
						for _, child in pairs(parent._children) do
							table.insert(descendants, child)
							visit(child)
						end
					end
					visit(self)
					return descendants
				end,
				_children = children,
			}
			nodeByIdentity[key] = node
			objectsByIdentity[key] = object
			table.insert(nodes, node)
		end
	end
	for _, node in ipairs(nodes) do
		local object = objectsByIdentity[identityKey(node.identity)]
		local parent: any = game
		if node.parentIdentity ~= nil then
			local parentNode = nodeByIdentity[identityKey(node.parentIdentity)]
			if parentNode == nil then error("Prepare replay index parent is absent") end
			parent = objectsByIdentity[identityKey(parentNode.identity)]
		end
		object.Parent = parent
		if parent == game then
			-- Duplicate sibling names are legal index diagnostics. Parent lookups
			-- in this prepare-only replay need only preserve the selected target,
			-- so retain the first child exactly as Instance:FindFirstChild does.
			if gameChildren[object.Name] == nil then gameChildren[object.Name] = object end
		else
			if parent._children[object.Name] == nil then parent._children[object.Name] = object end
		end
	end
	return {
		find = function(_self: any, stableId: string): any return objectsByIdentity["forge_attribute:" .. stableId] end,
		findOpaque = function(_self: any, identity: any): any return objectsByIdentity[identityKey(identity)] end,
	}
end

local collector = { identity = function(): any return payload.project end }
local authoring = StudioAuthoring.new(plugin, indexRegistry(payload.beforeCapture), collector)

assert(typeof(payload.boundary) == "table" and typeof(payload.fragments) == "table" and typeof(payload.beforeCapture) == "table", "Prepare transfer fixture is incomplete")

-- A source-bearing Prepare is legal only after every immutable source blob
-- has crossed the same request-bound acceptance boundary as production. Keep
-- this in the transfer replay rather than using a test-only source resolver so
-- parent-role matrices exercise StudioAuthoring:prepare exactly as Runtime
-- does. The fixture deliberately supplies captures, never raw replacement
-- bodies on the change set itself.
if payload.sourceWriteCaptures ~= nil then
	assert(typeof(payload.sourceWriteCaptures) == "table", "Prepare source-write captures are malformed")
	for _, capture in ipairs(payload.sourceWriteCaptures) do
		assert(typeof(capture) == "table" and typeof(capture.manifest) == "table" and typeof(capture.chunks) == "table", "Prepare source-write capture is malformed")
		authoring:beginSourceWrite({
			requestId = payload.boundary.requestId,
			manifest = capture.manifest,
			pieceCount = #capture.chunks,
		})
		for sequence, chunk in ipairs(capture.chunks) do
			local encoded = serde.encode("json", chunk)
			authoring:appendSourceWriteChunk({
				requestId = payload.boundary.requestId,
				manifestId = capture.manifest.id,
				sequence = sequence - 1,
				artifact = { kind = "CreatorSourceWriteBlobChunk", id = chunk.id, hash = chunk.hash },
				fragmentOrdinal = 0,
				fragmentCount = 1,
				encoding = "json",
				payload = encoded,
				payloadHash = Hash.sha256(encoded),
			})
		end
		local accepted = authoring:completeSourceWrite({
			requestId = payload.boundary.requestId,
			manifestId = capture.manifest.id,
			manifestHash = capture.manifest.hash,
			sourceHash = capture.manifest.sourceHash,
			utf8Bytes = capture.manifest.utf8Bytes,
			pieceCount = #capture.chunks,
		})
		assert(accepted.status == "accepted" and accepted.manifestHash == capture.manifest.hash, "Prepare source-write capture was not accepted")
	end
end

authoring:beginPrepareTransfer(payload.boundary)
for _, fragment in ipairs(payload.fragments) do authoring:appendPrepareTransferChunk(fragment) end
local receipt = authoring:completePrepareTransfer(payload.boundary, payload.beforeCapture)
assert(receipt.status == "prepared", "full Prepare transfer did not reach the pure prepared receipt")
assert(authoring.prepared ~= nil and authoring.prepared.prepareDocumentHash == payload.boundary.documentHash, "Prepare transfer did not retain its exact reassembled receipt")
assert(authoring.active == nil, "pure Prepare transfer must not open a mutation recording")
Hash.setDigestForTest(nil)
print("creator Prepare transfer replay passed")
