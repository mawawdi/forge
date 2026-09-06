-- Offline property-observation regression. Native defaults are characterized
-- separately by the Studio fixture; these are fixed datatype/contract inputs.
local Roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local fs = require("@lune/fs")
local process = require("@lune/process")
local Generated = require("../plugin/src/Forge/GeneratedStudioEvidence")
local Canonical = require("../plugin/src/Forge/StudioProjectIndexCanonical")

local cases = {
	{ id = "both", x = math.huge, y = math.huge, expected = { kind = "observed_vector2_f32", x = "positive_infinity", y = "positive_infinity" } },
	{ id = "x", x = math.huge, y = 480, expected = { kind = "observed_vector2_f32", x = "positive_infinity", y = 480 } },
	{ id = "y", x = 640, y = math.huge, expected = { kind = "observed_vector2_f32", x = 640, y = "positive_infinity" } },
	{ id = "zero", x = 0, y = math.huge, expected = { kind = "observed_vector2_f32", x = 0, y = "positive_infinity" } },
}
local materialById = {}
for _, case in cases do
	local instance = { ClassName = "UISizeConstraint", MaxSize = Roblox.Vector2.new(case.x, case.y) }
	local observed = Generated.readProjectProperty(instance, "MaxSize")
	local material = Canonical.material(observed)
	assert(material == Canonical.material(case.expected), case.id .. ": observation must preserve each axis")
	assert(Canonical.material(serde.decode("json", serde.encode("json", observed))) == material, case.id .. ": JSON transport must preserve observation material")
	assert(not pcall(function() Generated.read(instance, "MaxSize") end), "ordinary final readback must still reject unbounded values")
	assert(not pcall(function() Generated.validateValue("vector2_f32", observed) end), "observations must never become authored Studio values")
	assert(not pcall(function() Generated.canonicalProjectAttribute(instance.MaxSize) end), "attribute admission must remain unchanged")
	materialById[case.id] = material
end
assert(materialById.x ~= materialById.y and materialById.both ~= materialById.x, "different unbounded axes must never share material")
local finite = Generated.readProjectProperty({ ClassName = "UISizeConstraint", MaxSize = Roblox.Vector2.new(640, 480) }, "MaxSize")
assert(finite.kind == "vector2_f32" and finite.x == 640 and finite.y == 480, "finite properties must use their ordinary canonical kind")
for _, axes in { { math.huge, -math.huge }, { math.huge, 0 / 0 } } do
	assert(not pcall(function() Generated.readProjectProperty({ ClassName = "UISizeConstraint", MaxSize = Roblox.Vector2.new(axes[1], axes[2]) }, "MaxSize") end), "unsupported non-finite axes must fail closed")
end
assert(not pcall(function() Generated.readProjectProperty({ ClassName = "Frame", AnchorPoint = Roblox.Vector2.new(math.huge, math.huge) }, "AnchorPoint") end), "another Vector2 property must not inherit this observation contract")
assert(not pcall(function() Generated.readProjectProperty({ ClassName = "UISizeConstraint", MinSize = Roblox.Vector2.new(math.huge, math.huge) }, "MinSize") end), "the same class's other properties must stay finite-only")
if process.args[1] then
	local expected = serde.decode("json", fs.readFile(process.args[1]))
	for id, material in materialById do assert(expected[id] == material, id .. ": TypeScript/Luau observation hash material differs") end
end
print("Project unbounded property observation regressions passed: 4 canonical vectors; writer and final evidence remain finite-only (offline)")
return true
