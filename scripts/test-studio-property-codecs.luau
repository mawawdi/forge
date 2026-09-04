-- Exercise the actual generated conversion functions with Lune's Roblox
-- datatypes. This is an offline contract test, not native Studio evidence.
local Roblox = require("@lune/roblox")
local Generated = require("../plugin/src/Forge/GeneratedStudioEvidence")
local environment = setmetatable({}, { __index = getfenv(Generated.toStudio) })
for name, value in Roblox do environment[name] = value end
setfenv(Generated.toStudio, environment)
setfenv(Generated.fromStudio, environment)

local failures = {}
local count = 0
local function check(name, value, property)
	local ok, failure = pcall(function()
		local codec = if value.kind == "nil" then value.expectedCodec else value.kind
		local reference = Roblox.Instance.new("Part")
		local native = Generated.toStudio(codec, value, property, function() return reference end)
		local observed = Generated.fromStudio(codec, native, function() return value end, property)
		assert(Generated.canonicalValueMaterial(value) == Generated.canonicalValueMaterial(observed), "round-trip value changed")
		reference:Destroy()
	end)
	count += 1
	if not ok then table.insert(failures, name .. ": " .. tostring(failure)) end
end
for _, vector in Generated.vectors do
	local property = nil
	if vector.value.kind == "enum_name" then property = Generated.propertyMetadata("Part", "Material")
	elseif vector.value.kind == "instance_ref" then property = Generated.propertyMetadata("WeldConstraint", "Part0")
	elseif vector.value.kind == "nil" then property = Generated.propertyMetadata("Part", "CustomPhysicalProperties") end
	check(vector.name, vector.value, property)
end
for _, className in Generated.writableClasses do
	for _, property in Generated.projectPropertyMetadata(className) do
		if property.codec == "content" then
			check(className .. "." .. property.name .. " empty", { kind = "content", value = "" }, property)
			check(className .. "." .. property.name .. " URI", { kind = "content", value = "rbxassetid://12345" }, property)
		end
	end
end
local imageContent = Generated.propertyMetadata("ImageLabel", "ImageContent")
assert(not pcall(function()
	Generated.fromStudio("content", { SourceType = Roblox.Enum.ContentSourceType.Object }, nil, imageContent)
end), "object-backed content must not be silently serialized as a URI")
for _, failure in failures do print(failure) end
assert(#failures == 0, `{#failures} property codec failures`)
print(`Studio property codec round-trips passed: {count}`)
