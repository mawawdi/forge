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
local physical = { kind = "physical_properties", density = 0.7, friction = 1.5, elasticity = 0.5, frictionWeight = 50, elasticityWeight = 100, acousticAbsorption = 0.3 }
local incompletePhysical = table.clone(physical)
incompletePhysical.acousticAbsorption = nil
assert(not pcall(Generated.canonicalValue, incompletePhysical), "five-field PhysicalProperties must be rejected")
local differentPhysical = table.clone(physical)
differentPhysical.acousticAbsorption = 0.8
assert(Generated.canonicalValueMaterial(physical) ~= Generated.canonicalValueMaterial(differentPhysical), "acoustic absorption must participate in equality")
for _, bound in ipairs({ { "density", 0.0001, 100 }, { "friction", 0, 2 }, { "elasticity", 0, 1 }, { "frictionWeight", 0, 100 }, { "elasticityWeight", 0, 100 }, { "acousticAbsorption", 0, 1 } }) do
	for _, outside in ipairs({ bound[2] - 0.00001, bound[3] + 0.00001, math.huge, 0 / 0 }) do
		local invalid = table.clone(physical)
		invalid[bound[1]] = outside
		assert(not pcall(Generated.canonicalValue, invalid), "out-of-domain physical property must be rejected: " .. bound[1])
	end
end
for _, failure in failures do print(failure) end
for _, className in Generated.writableClasses do
	local color = Generated.propertyMetadata(className, "Color")
	if color ~= nil and color.declaringClass == "BasePart" then
		for _, family in ipairs({ { "BrickColor", "Color" }, { "CFrame", "Rotation" } }) do
			for left, name in ipairs(family) do
				assert(#Generated.sortedMutationPropertyNames(className, { [name] = true }) == 1, "single setter must remain admitted")
				for right = left + 1, #family do
					assert(not pcall(Generated.sortedMutationPropertyNames, className, { [name] = true, [family[right]] = true }), "coupled setter pair must be rejected: " .. className .. "." .. name .. "/" .. family[right])
				end
			end
		end
		assert(#Generated.sortedMutationPropertyNames(className, { CFrame = true, Color = true }) == 2, "independent families must remain admitted")
		for _, name in ipairs({ "Position", "Orientation" }) do
			assert(not pcall(Generated.sortedMutationPropertyNames, className, { CFrame = true, [name] = true }), "hidden transform aliases must remain rejected")
		end
	end
end
assert(#Generated.sortedMutationPropertyNames("Frame", { Position = true, Rotation = true }) == 2, "unrelated UI property names must not inherit BasePart families")
assert(#failures == 0, `{#failures} property codec failures`)
print(`Studio property codec round-trips passed: {count}`)
