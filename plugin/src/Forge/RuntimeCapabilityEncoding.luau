--!strict
-- The generic runner accepts the execution plan as exactly one JSON string
-- literal. This encoder deliberately does not interpolate any plan field into
-- Luau syntax, identifiers, or expressions.
local Encoding = {}

function Encoding.singleStringLiteral(value: string): string
	-- Lua/Luau %q emits one quoted literal and escapes quotes, backslashes,
	-- newlines and control characters. The caller places no untrusted values
	-- outside this literal.
	return string.format("%q", value)
end

return Encoding
