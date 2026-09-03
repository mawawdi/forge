--!strict
-- Tagged evidence material is intentionally usable in headless Luau module
-- tests. JSON is transport-only: semantic hashes never depend on its key order.
local HttpService = if game ~= nil then game:GetService("HttpService") else nil

local Canonical = {}
local objectTables = setmetatable({}, { __mode = "k" })

-- Luau has one table type, so `{}` otherwise collapses to an empty array. The
-- marker is process-local metadata only; canonical material and JSON emit the
-- table as an object while never serializing a sentinel field.
function Canonical.object(value: {[string]: any}): {[string]: any}
	for key in pairs(value) do
		if typeof(key) ~= "string" then error("project index canonical object key is not a string") end
	end
	objectTables[value] = true
	return value
end

-- Evidence identities never hash their JSON transport. This tagged, byte
-- length-delimited tree mirrors projectIndexMaterial in TypeScript. In
-- particular, doubles use their IEEE-754 bytes so -0 cannot collapse into 0
-- through Lua/JavaScript number formatting.
local function tagged(tag: string, payload: string): string
	return tostring(#tag) .. ":" .. tag .. tostring(#payload) .. ":" .. payload
end

local function taggedLength(tag: string, payloadLength: number): number
	if payloadLength < 0 or payloadLength % 1 ~= 0 then error("project index canonical payload length is invalid") end
	return #tostring(#tag) + 1 + #tag + #tostring(payloadLength) + 1 + payloadLength
end

local function sequence(parts: {string}): string
	local taggedParts = table.create(#parts)
	for index, part in ipairs(parts) do taggedParts[index] = tagged("item", part) end
	return tagged("sequence", tagged("count", tostring(#parts)) .. table.concat(taggedParts))
end

local function validUtf8(value: string): boolean
	local ok, length = pcall(function() return utf8.len(value) end)
	return ok and length ~= nil
end

local function f64Bits(value: number): string
	if value ~= value or value == math.huge or value == -math.huge then
		error("project index canonical material received a non-finite number")
	end
	local packed = string.pack(">d", value)
	return (string.gsub(packed, ".", function(character: string): string return string.format("%02x", string.byte(character)) end))
end

local function isArray(value: any): boolean
	if typeof(value) ~= "table" then return false end
	if objectTables[value] then return false end
	local count = 0
	for key in pairs(value) do
		if typeof(key) ~= "number" or key < 1 or key % 1 ~= 0 then return false end
		count += 1
	end
	return #value == count
end

function Canonical.transportJson(value: any, cooperate: (() -> ())?): string
	if HttpService == nil then error("project index transport JSON requires HttpService") end
	local output = {}
	local visited = 0
	local function encode(item: any)
		visited += 1
		if cooperate and visited % 128 == 0 then cooperate() end
		local itemType = typeof(item)
		if item == nil then table.insert(output, "null"); return end
		if itemType == "boolean" or itemType == "number" or itemType == "string" then
			table.insert(output, HttpService:JSONEncode(item)); return
		end
		if itemType ~= "table" then error("project index transport JSON received an unsupported value: " .. itemType) end
		if isArray(item) then
			table.insert(output, "[")
			for index, child in ipairs(item) do
				if index > 1 then table.insert(output, ",") end
				encode(child)
			end
			table.insert(output, "]")
			return
		end
		local keys = {}
		for key in pairs(item) do
			if typeof(key) ~= "string" then error("project index transport JSON object key is not a string") end
			table.insert(keys, key)
		end
		table.sort(keys)
		table.insert(output, "{")
		for index, key in ipairs(keys) do
			if index > 1 then table.insert(output, ",") end
			table.insert(output, HttpService:JSONEncode(key))
			table.insert(output, ":")
			encode(item[key])
		end
		table.insert(output, "}")
	end
	encode(value)
	return table.concat(output)
end

-- Shard admission needs the exact material byte count, but rebuilding the
-- entire growing shard after each appended node is quadratic. These length
-- combinators mirror `tagged` and `sequence` without allocating the material.
function Canonical.taggedMaterialLength(tag: string, payloadLength: number): number
	if not validUtf8(tag) then error("project index canonical tag is invalid UTF-8") end
	return taggedLength(tag, payloadLength)
end

function Canonical.arrayMaterialLength(itemCount: number, taggedItemBytes: number): number
	if itemCount < 0 or itemCount % 1 ~= 0 or taggedItemBytes < 0 or taggedItemBytes % 1 ~= 0 then error("project index canonical array length is invalid") end
	local sequencePayloadLength = taggedLength("count", #tostring(itemCount)) + taggedItemBytes
	return taggedLength("array", taggedLength("sequence", sequencePayloadLength))
end

function Canonical.objectMaterialLength(valueMaterialLengths: {[string]: number}): number
	local keys = {}
	for key, valueLength in pairs(valueMaterialLengths) do
		if typeof(key) ~= "string" or not validUtf8(key) then error("project index canonical length object key is invalid") end
		if typeof(valueLength) ~= "number" or valueLength < 0 or valueLength % 1 ~= 0 then error("project index canonical object value length is invalid") end
		table.insert(keys, key)
	end
	table.sort(keys)
	local taggedItemBytes = 0
	for _, key in ipairs(keys) do
		local entryPayloadLength = taggedLength("key", #key) + taggedLength("value", valueMaterialLengths[key])
		taggedItemBytes += taggedLength("item", taggedLength("entry", entryPayloadLength))
	end
	local sequencePayloadLength = taggedLength("count", #tostring(#keys)) + taggedItemBytes
	return taggedLength("object", taggedLength("sequence", sequencePayloadLength))
end

local function material(value: any, cooperate: (() -> ())?, progress: {number}): string
	progress[1] += 1
	if cooperate and progress[1] % 128 == 0 then cooperate() end
	local valueType = typeof(value)
	if value == nil then return tagged("null", "") end
	if valueType == "boolean" then return tagged("boolean", if value then "1" else "0") end
	if valueType == "string" then
		if not validUtf8(value) then error("project index canonical material received invalid UTF-8") end
		return tagged("utf8", value)
	end
	if valueType == "number" then return tagged("float64", f64Bits(value)) end
	if valueType ~= "table" then error("project index canonical material received an unsupported value: " .. valueType) end
	if isArray(value) then
		local parts = table.create(#value)
		for index, item in ipairs(value) do parts[index] = material(item, cooperate, progress) end
		return tagged("array", sequence(parts))
	end
	local keys = {}
	for key in pairs(value) do
		if typeof(key) ~= "string" then error("project index canonical material object key is not a string") end
		table.insert(keys, key)
	end
	table.sort(keys)
	local entries = table.create(#keys)
	for index, key in ipairs(keys) do
		if not validUtf8(key) then error("project index canonical material object key is invalid UTF-8") end
		entries[index] = tagged("entry", tagged("key", key) .. tagged("value", material(value[key], cooperate, progress)))
	end
	return tagged("object", sequence(entries))
end

function Canonical.material(value: any, cooperate: (() -> ())?): string
	return material(value, cooperate, { 0 })
end

return Canonical
