--!strict
local Hash = {}
local digestForTest: ((string) -> string)? = nil

local function encodingService()
	return game:GetService("EncodingService")
end

function Hash.available(): boolean
	local ok, digest = pcall(function()
		return encodingService():ComputeStringHash("forge-capability-probe", Enum.HashAlgorithm.Sha256)
	end)
	return ok and typeof(digest) == "string" and #digest == 32
end

-- Module tests run outside Studio, where EncodingService is unavailable. The
-- test harness must opt in explicitly and still supply Studio's raw 32-byte
-- SHA-256 result; production callers retain the engine-only code path below.
function Hash.setDigestForTest(digest: ((string) -> string)?)
	if digest ~= nil and typeof(digest) ~= "function" then error("test digest must be a function or nil") end
	digestForTest = digest
end

function Hash.sha256(value: string): string
	local ok, digest: any
	if digestForTest ~= nil then
		ok, digest = pcall(digestForTest, value)
	else
		ok, digest = pcall(function()
			return encodingService():ComputeStringHash(value, Enum.HashAlgorithm.Sha256)
		end)
	end
	if not ok or typeof(digest) ~= "string" or #digest ~= 32 then
		error("Forge requires EncodingService SHA-256 support: " .. tostring(digest))
	end
	local hex = table.create(32)
	for index = 1, #digest do hex[index] = string.format("%02x", string.byte(digest, index)) end
	return table.concat(hex)
end

return Hash
