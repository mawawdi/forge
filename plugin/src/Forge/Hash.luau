--!strict
local EncodingService = game:GetService("EncodingService")

local Hash = {}

function Hash.available(): boolean
	local ok, digest = pcall(function()
		return EncodingService:ComputeStringHash("forge-capability-probe", Enum.HashAlgorithm.Sha256)
	end)
	return ok and typeof(digest) == "string" and #digest == 32
end

function Hash.sha256(value: string): string
	local ok, digest = pcall(function()
		return EncodingService:ComputeStringHash(value, Enum.HashAlgorithm.Sha256)
	end)
	if not ok or typeof(digest) ~= "string" or #digest ~= 32 then
		error("Forge requires EncodingService SHA-256 support: " .. tostring(digest))
	end
	local hex = table.create(32)
	for index = 1, #digest do hex[index] = string.format("%02x", string.byte(digest, index)) end
	return table.concat(hex)
end

return Hash
