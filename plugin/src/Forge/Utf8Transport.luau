--!strict
-- One byte-bounded UTF-8 fragmenter for every Studio transport. Roblox HTTP
-- bodies carry JSON strings, so splitting a multi-byte code point would make
-- an otherwise valid, hash-bound stream impossible to decode or replay.
local Utf8Transport = {}

local function validateBounds(value: string, maximumBytes: number)
	if typeof(value) ~= "string" then error("transport document must be a string") end
	if typeof(maximumBytes) ~= "number" or maximumBytes < 4 or maximumBytes % 1 ~= 0 then
		error("transport fragment byte bound must be an integer of at least four")
	end
end

function Utf8Transport.boundaries(value: string, maximumBytes: number, cooperate: (() -> ())?): {number}
	validateBounds(value, maximumBytes)
	local ends = {}
	local startByte = 0
	while startByte < #value do
		local endByte = math.min(#value, startByte + maximumBytes)
		while endByte < #value and bit32.band(string.byte(value, endByte + 1), 0xC0) == 0x80 do
			endByte -= 1
		end
		if endByte <= startByte then error("transport document has no valid UTF-8 fragment boundary") end
		-- Validate one bounded fragment at a time. A single utf8.len(value) made a
		-- maximum-size source one uninterruptible scan; per-fragment validation
		-- preserves the same strictness with a cooperative boundary between calls.
		local valid, length = pcall(function() return utf8.len(string.sub(value, startByte + 1, endByte)) end)
		if not valid or length == nil then error("transport document is not valid UTF-8") end
		table.insert(ends, endByte)
		startByte = endByte
		if cooperate then cooperate() end
	end
	return ends
end

function Utf8Transport.each(value: string, maximumBytes: number, visitor: (string, number, number) -> (), cooperate: (() -> ())?)
	if typeof(visitor) ~= "function" then error("transport fragment visitor is required") end
	local ends = Utf8Transport.boundaries(value, maximumBytes, cooperate)
	local startByte = 0
	for ordinal, endByte in ipairs(ends) do
		visitor(string.sub(value, startByte + 1, endByte), ordinal - 1, #ends)
		startByte = endByte
		if cooperate then cooperate() end
	end
end

return Utf8Transport
