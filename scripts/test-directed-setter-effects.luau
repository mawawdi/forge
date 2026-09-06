local Generated = require("../plugin/src/Forge/GeneratedStudioEvidence")
local radius = { kind = "udim", scale = 0, offset = 12 }
local radii = { "BottomLeftRadius", "BottomRightRadius", "TopLeftRadius", "TopRightRadius" }
local independent = {}
for _, name in ipairs(radii) do
    independent[name] = radius
    assert(not pcall(function() Generated.sortedMutationPropertyNames("UICorner", { CornerRadius = radius, [name] = radius }) end))
end
assert(#Generated.sortedMutationPropertyNames("UICorner", independent) == 4)
assert(table.concat(Generated.derivedMutationPropertyNames("UICorner", { CornerRadius = radius }), ",") == table.concat(radii, ","))
assert(table.concat(Generated.derivedMutationPropertyNames("UICorner", { TopLeftRadius = radius }), ",") == "CornerRadius")
assert(#Generated.derivedMutationPropertyNames("UICorner", { TopRightRadius = radius }) == 0)
assert(table.concat(Generated.derivedMutationPropertyNames("UICorner", independent), ",") == "CornerRadius")
print("PASS directed native setter effects and independent corner admission")
return true
