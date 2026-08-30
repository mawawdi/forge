local fs = require("@lune/fs")
local roblox = require("@lune/roblox")
local process = require("@lune/process")

local path = process.args[1]
assert(path, "usage: lune run scripts/inspect-rbxm.luau <model>")

local roots = roblox.deserializeModel(fs.readFile(path))

local function property(instance, name)
	local ok, value = pcall(function()
		return instance[name]
	end)
	return if ok then tostring(value) else "<unavailable>"
end

local function visit(instance, depth)
	local indent = string.rep("  ", depth)
	local details = ""
	if instance:IsA("LuaSourceContainer") then
		details = string.format(
			" RunContext=%s Disabled=%s SourceBytes=%d",
			property(instance, "RunContext"),
			property(instance, "Disabled"),
			#instance.Source
		)
	end
	print(string.format("%s%s %s%s", indent, instance.ClassName, instance.Name, details))
	for _, child in instance:GetChildren() do
		visit(child, depth + 1)
	end
end

for _, root in roots do
	visit(root, 0)
end
