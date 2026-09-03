-- Generated vectors must agree with the Luau authority used by PairProject,
-- heartbeat, Link/Fork finalization, and publication observation.
local Hash = require("../plugin/src/Forge/Hash")
local StudioProjectAuthority = require("../plugin/src/Forge/StudioProjectAuthority")
local fs = require("@lune/fs")

-- Lune has no EncodingService. This test-only SHA-256 implementation supplies
-- the raw bytes that Studio's EncodingService returns to production Hash.
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
		0x19a4c116,
		0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee,
		0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	}
	local function add(...: number): number
		local sum = 0
		for _, value in ipairs({ ... }) do sum = (sum + value) % 4294967296 end
		return sum
	end
	local h0, h1, h2, h3 = 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a
	local h4, h5, h6, h7 = 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	for start = 1, #bytes, 64 do
		local words = {}
		for index = 0, 15 do
			local offset = start + index * 4
			words[index] = add(bit32.lshift(bytes[offset], 24), bit32.lshift(bytes[offset + 1], 16), bit32.lshift(bytes[offset + 2], 8), bytes[offset + 3])
		end
		for index = 16, 63 do
			local previous, prior = words[index - 15], words[index - 2]
			local s0 = bit32.bxor(bit32.rrotate(previous, 7), bit32.rrotate(previous, 18), bit32.rshift(previous, 3))
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

Hash.setDigestForTest(sha256Bytes)
assert(Hash.sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "test SHA-256 must match Studio EncodingService")
for _, vector in ipairs(StudioProjectAuthority.vectors) do
	local actual = StudioProjectAuthority.derive(vector.input)
	assert(actual.projectId == vector.expected.projectId, vector.name .. ": project ID")
	assert(actual.conversationProjectId == vector.expected.conversationProjectId, vector.name .. ": conversation project ID")
	assert(actual.connectorEpoch == vector.expected.connectorEpoch, vector.name .. ": connector epoch")
end

local incident = StudioProjectAuthority.vectors[1]
assert(incident.name == "incident_local_unlinked_pair_and_heartbeat")
local paired = StudioProjectAuthority.derive(incident.input)
local firstHeartbeatInput = table.clone(incident.input)
firstHeartbeatInput.currentProjectId = paired.projectId
local firstHeartbeat = StudioProjectAuthority.adopt(firstHeartbeatInput)
local secondHeartbeatInput = table.clone(incident.input)
secondHeartbeatInput.currentProjectId = firstHeartbeat.projectId
local secondHeartbeat = StudioProjectAuthority.adopt(secondHeartbeatInput)
assert(not firstHeartbeat.authorityChanged and not secondHeartbeat.authorityChanged, "heartbeats must preserve pairing authority")
local renamed = StudioProjectAuthority.vectors[3]
local renamedInput = table.clone(renamed.input)
renamedInput.currentProjectId = secondHeartbeat.projectId
local renamedAuthority = StudioProjectAuthority.adopt(renamedInput)
assert(renamedAuthority.authorityChanged, "rename must rotate exact local authority")
local linked = StudioProjectAuthority.vectors[4]
local linkedInput = table.clone(linked.input)
linkedInput.currentProjectId = renamedAuthority.projectId
local linkedAuthority = StudioProjectAuthority.adopt(linkedInput)
assert(linkedAuthority.authorityChanged and linkedAuthority.conversationProjectId == linked.expected.conversationProjectId, "Link must rotate to durable authority")
local forked = StudioProjectAuthority.vectors[5]
local forkedInput = table.clone(forked.input)
forkedInput.currentProjectId = linkedAuthority.projectId
assert(StudioProjectAuthority.adopt(forkedInput).authorityChanged, "Fork must rotate durable authority")
local unbound = table.clone(incident.input)
unbound.sessionId = ""
assert(not pcall(function() StudioProjectAuthority.derive(unbound) end), "unlinked identity must not fall back without a session")

local runtimeSource = fs.readFile("plugin/src/Forge/Runtime.luau")
assert(string.find(runtimeSource, "StudioProjectAuthority.adopt", 1, true), "Runtime must use the shared authority adoption module")
assert(not string.find(runtimeSource, "projectIdForIdentity", 1, true), "Runtime must not retain a hand-rolled authority path")

print("studio project identity authority vectors passed")
