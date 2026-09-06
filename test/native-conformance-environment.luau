-- Fixed lifecycle doubles only. These are not native Roblox codecs, JSON, or property evidence.
local Hash = require("./Hash")
local env = { instances = {}, publications = {}, encoded = {}, serial = 0, chsAccesses = 0 }
local methods = {}
local metadata = {}
local function clone(value)
	if type(value) ~= "table" then return value end
	local result = {}
	for key, item in value do result[key] = clone(item) end
	return result
end
local function material(value)
	if type(value) ~= "table" then return type(value) .. ":" .. tostring(value) end
	local keys, parts = {}, {}
	for key in value do table.insert(keys, key) end
	table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
	for _, key in keys do table.insert(parts, tostring(key) .. "=" .. material(value[key])) end
	return "{" .. table.concat(parts, ",") .. "}"
end
local function detach(node)
	local data = metadata[node]
	if data.Parent then
		local siblings = metadata[data.Parent].children
		for index, sibling in siblings do
			if sibling == node then table.remove(siblings, index) break end
		end
	end
	data.Parent = nil
end
function methods:IsA(className) return metadata[self].className == className end
function methods:GetChildren() return table.clone(metadata[self].children) end
function methods:FindFirstChild(name)
	for _, child in metadata[self].children do if child.Name == name then return child end end
	return nil
end
function methods:Destroy()
	local data = metadata[self]
	if data.destroyed then return end
	for _, child in table.clone(data.children) do child:Destroy() end
	detach(self)
	data.destroyed = true
end
local function newNode(className)
	local node = {}
	local data = { className = className, Name = className, children = {}, properties = {}, destroyed = false }
	if className == "StringValue" then data.Value = "" end
	if className == "UISizeConstraint" then data.MaxSize = { X = math.huge, Y = math.huge } end
	metadata[node] = data
	setmetatable(node, {
		__index = function(_, key) return methods[key] or data[key] end,
		__newindex = function(_, key, value)
			assert(not data.destroyed, "write after destruction")
			if key == "Parent" then
				if value ~= nil and env.failParentName == data.Name then
					env.failParentName = nil
					error("injected receipt publication failure")
				end
				detach(node)
				data.Parent = value
				if value then
					table.insert(metadata[value].children, node)
					local children = {}
					for _, child in data.children do children[child.Name] = child.Value or true end
					table.insert(env.publications, { name = data.Name, parent = value.Name, children = children, value = data.Value })
					if value == env.workspace and env.mutateOnPublish then
						env.mutateOnPublish = false
						local sample = assert(node:FindFirstChild("PhysicalSample"))
						metadata[sample].properties.Transparency = { kind = "number_f32", value = 0.75 }
					end
				end
			elseif key == "Value" and env.failValueName == data.Name then
				env.failValueName = nil
				error("injected report value failure")
			elseif key == "ScreenInsets" then
				-- One deterministic double behavior allows the Runner's lifecycle to finish.
				data[key] = value
				data.IgnoreGuiInset = false
			else data[key] = value end
		end,
	})
	table.insert(env.instances, node)
	return node
end
env.workspace = newNode("Workspace")
env.Instance = { new = newNode }
env.Enum = { ScreenInsets = { CoreUISafeInsets = { Name = "CoreUISafeInsets" } } }
local Generated = { manifestHash = "fixture-manifest", writableClasses = { "Part", "ScreenGui" } }
function Generated.classMetadata() return { creatable = true, preflightStrategy = "detached_instance" } end
function Generated.sortedMutationPropertyNames(_, properties)
	local names = {}
	for name in properties do table.insert(names, name) end
	table.sort(names)
	return names
end
function Generated.write(node, name, value)
	metadata[node].properties[name] = clone(value)
	-- Lifecycle fixture doubles only; native corner evidence comes from Runner.
	if node:IsA("UICorner") then
		if name == "CornerRadius" then
			for _, corner in { "BottomLeftRadius", "BottomRightRadius", "TopLeftRadius", "TopRightRadius" } do metadata[node].properties[corner] = clone(value) end
		elseif name == "TopLeftRadius" then metadata[node].properties.CornerRadius = clone(value) end
	end
	if name == "MaxSize" then metadata[node].MaxSize = { X = value.x, Y = value.y } end
end
function Generated.read(node, name)
	if name == "ScreenInsets" and node.ScreenInsets then return { kind = "enum_name", value = node.ScreenInsets.Name } end
	return clone(metadata[node].properties[name])
end
function Generated.readProjectProperty(node, name)
	if node:IsA("UISizeConstraint") and name == "MaxSize" and node.MaxSize.X == math.huge and node.MaxSize.Y == math.huge then
		return { kind = "observed_vector2_f32", x = "positive_infinity", y = "positive_infinity" }
	end
	return Generated.read(node, name)
end
Generated.canonicalValueMaterial = material
local Cases = {}
function Cases.prepare(_, _, className, properties, _, _, before)
	assert(className ~= "Lighting", "fixed engine-owned rejection")
	local values = clone(before or {})
	for name, value in properties do values[name] = clone(value) end
	if className == "UICorner" then
		if properties.CornerRadius then
			for _, corner in { "BottomLeftRadius", "BottomRightRadius", "TopLeftRadius", "TopRightRadius" } do values[corner] = clone(properties.CornerRadius) end
		end
		values.CornerRadius = clone(values.TopLeftRadius)
	end
	return {}, { values = values }
end
function Cases.physical()
	return { kind = "physical_properties", density = 2, friction = 0.4, elasticity = 0.25, frictionWeight = 30, elasticityWeight = 40, acousticAbsorption = 0.3 }
end
local Authoring = {}
function Authoring.exactPropertyFactForTest(node, name, expected)
	-- Fixed lifecycle behavior only; production matching is tested separately.
	local before = clone(node[name])
	return {
		matchesBefore = function() return material(node[name]) == material(before) end,
		matchesAfter = function() return material(node[name]) == material({ X = expected.x, Y = expected.y }) end,
	}
end
function Authoring.new()
	return { preflight = function(_, payload)
		local facts = {}
		for name, value in payload.values do
			table.insert(facts, { kind = "property", propertyName = name, result = { status = "observed", value = clone(value) } })
		end
		return { completion = "complete", facts = facts }
	end }
end
local function dependency(name, value)
	return { Name = name, Source = "fixed lifecycle dependency " .. name, value = value, IsA = function(_, className) return className == "ModuleScript" end }
end
env.script = { Source = "runner source supplied by Node test", Cases = dependency("Cases", Cases), Forge = {} }
for name, value in { GeneratedStudioEvidence = Generated, StudioAuthoring = Authoring, Hash = Hash } do
	env.script.Forge[name] = dependency(name, value)
end
function env.script.Forge:GetChildren()
	if env.failBuildIdentity then env.failBuildIdentity = false error("injected identity build failure") end
	return { self.GeneratedStudioEvidence, self.StudioAuthoring, self.Hash }
end
env.require = function(node) assert(node.value ~= nil, "unknown fixed dependency") return node.value end
local HttpService = {}
function HttpService:JSONEncode(value)
	if env.failEncode and value.kind == "ForgeNativePreflightConformance" then env.failEncode = false error("injected report encoding failure") end
	env.serial += 1
	local key = "fixed report snapshot " .. tostring(env.serial)
	env.encoded[key] = clone(value)
	return key
end
function HttpService:JSONDecode(value) return clone(assert(env.encoded[value], "missing fixed report snapshot")) end
env.game = {}
function env.game:GetService(name)
	if name == "ChangeHistoryService" then env.chsAccesses += 1 error("Command Bar fixture cannot access ChangeHistoryService") end
	if name == "HttpService" then return HttpService end
	if name == "RunService" then return { IsRunning = function() return false end } end
	error("unexpected fixture service: " .. name)
end
env.version = function() return "fixed offline lifecycle environment" end
env.print = function(...) end
function env.reset()
	for _, node in table.clone(env.instances) do if node ~= env.workspace then node:Destroy() end end
	env.instances, env.publications, env.encoded = { env.workspace }, {}, {}
	env.serial, env.chsAccesses = 0, 0
	env.failEncode, env.failBuildIdentity, env.failParentName = false, false, nil
	env.failValueName, env.mutateOnPublish = nil, false
	env.script.Cases.Source = "fixed lifecycle dependency Cases"
end
function env.liveCount()
	local count = 0
	for _, node in env.instances do if node ~= env.workspace and not metadata[node].destroyed then count += 1 end end
	return count
end
function env.output() return env.workspace:FindFirstChild("ForgeNativeConformanceOutput") end
return env
