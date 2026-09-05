-- Production preflight with test-owned setter behavior. This is offline
-- regression evidence; only the separate Studio fixture can produce native evidence.
local Roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local Generated = require("../plugin/src/Forge/GeneratedStudioEvidence")
local Hash = require("../plugin/src/Forge/Hash")
local Authoring = require("../plugin/src/Forge/StudioAuthoring")
local Cases = require("../test/fixtures/studio-native-conformance/Cases")

Hash.setDigestForTest(function(value)
	return (serde.hash("sha256", value):gsub("..", function(pair) return string.char(tonumber(pair, 16)) end))
end)
local generatedEnvironment = getfenv(Generated.toStudio)
for name, value in Roblox do generatedEnvironment[name] = value end
local authoringEnvironment = getfenv(Authoring.preflight)
local originalInstance = authoringEnvironment.Instance
local allocated, setters, destroyed, mode = {}, {}, 0, "normal"
local function newInstance(className)
	if mode == "allocation_failure" and #allocated == 1 then error("injected constructor failure") end
	local state = { ClassName = className, Name = className, Anchored = false, Transparency = 0, Color = Roblox.Color3.new(0, 0, 0), BrickColor = Roblox.BrickColor.new("Really black"), CFrame = Roblox.CFrame.identity, Rotation = Roblox.Vector3.zero }
	local attributes = { Removed = true }
	local instance = setmetatable({}, {
		__index = function(_, key)
			if key == "GetAttribute" then return function(_, name) return attributes[name] end end
			if key == "SetAttribute" then return function(_, name, value)
				setters["attribute:" .. name] = (setters["attribute:" .. name] or 0) + 1
				if mode ~= "broken_removal" or value ~= nil then attributes[name] = value end
				if mode == "attribute_side_effect" and name == "Z" then attributes.A = false end
			end end
			if key == "Destroy" then return function() destroyed += 1 end end
			if key == "IsA" then return function(_, expected) return expected == className or expected == "Instance" end end
			return state[key]
		end,
		__newindex = function(_, key, value)
			state[key] = value
			setters[key] = (setters[key] or 0) + 1
			-- Deliberately model a setter coupling. These are not claims about
			-- the native Anchored/Transparency implementation.
			if mode == "property_side_effect" and key == "Transparency" then state.Anchored = false end
			if mode == "color_family" and key == "Color" then state.BrickColor = Roblox.BrickColor.new("Really red") end
			if mode == "transform_family" and key == "Rotation" then state.CFrame = Roblox.CFrame.new(state.CFrame.Position) * Roblox.CFrame.Angles(math.rad(value.X), math.rad(value.Y), math.rad(value.Z)) end
		end,
	})
	table.insert(allocated, instance)
	return instance
end
authoringEnvironment.Instance = { new = newInstance }

local count = 0
local function run(name, selectedMode, properties, attributes, removed, expected)
	mode = selectedMode; allocated = {}; setters = {}; destroyed = 0
	local prepared, payload = Cases.prepare(Generated, Hash, "Part", properties, attributes, removed)
	local authoring = Authoring.new({}, {}, {})
	authoring.prepared = prepared
	local envelope = authoring:preflight(payload)
	assert(envelope.completion == expected, name .. ": " .. envelope.completion)
	assert(destroyed == #allocated, name .. ": every detached object must be destroyed")
	for _, writes in setters do assert(writes == 1, name .. ": final readback must not rewrite expectations") end
	count += 1
	return authoring, payload, envelope
end
run("ordinary property and attributes", "normal", { Anchored = { kind = "boolean", value = true }, Transparency = { kind = "number_f32", value = 0.5 } }, { A = true }, { "Removed" }, "complete")
local rejected, rejectedPayload, rejectedEnvelope = run("coupled setters", "property_side_effect", { Anchored = { kind = "boolean", value = true }, Transparency = { kind = "number_f32", value = 0.5 } }, {}, {}, "incomplete")
assert(rejectedEnvelope.facts[1] ~= nil)
assert(not pcall(function() rejected:apply(rejectedPayload, {}) end), "an incomplete preflight must not reach live Apply")
run("attribute side effect", "attribute_side_effect", {}, { A = true, Z = true }, {}, "incomplete")
run("broken attribute removal", "broken_removal", {}, {}, { "Removed" }, "incomplete")
local _, _, colorEnvelope = run("final derived color readback", "color_family", { Color = { kind = "color3_rgb8", r = 255, g = 0, b = 0 } }, {}, {}, "complete")
local observedAlias = false
for _, fact in colorEnvelope.facts do
	if fact.kind == "property" and fact.propertyName == "BrickColor" then observedAlias = fact.result.status == "observed" and fact.result.value.name == "Really red" end
end
assert(observedAlias and setters.BrickColor == nil, "derived values must be read without corrective alias writes")

mode = "transform_family"; allocated = {}; setters = {}; destroyed = 0
local transformPrepared, transformPayload = Cases.prepare(Generated, Hash, "Part", { Rotation = { kind = "vector3_f32", x = 0, y = 90, z = 0 } }, {}, {}, { CFrame = { kind = "cframe_f32x12", components = { 12, 3, 8, 1, 0, 0, 0, 1, 0, 0, 0, 1 } } })
local transformAuthoring = Authoring.new({}, {}, {}); transformAuthoring.prepared = transformPrepared
local transformEnvelope = transformAuthoring:preflight(transformPayload)
assert(transformEnvelope.completion == "complete", "seeded transform family preflight")
local observedTransform = false
for _, fact in transformEnvelope.facts do
	if fact.kind == "property" and fact.propertyName == "CFrame" then observedTransform = fact.result.status == "observed" and fact.result.value.components[1] == 12 and fact.result.value.components[2] == 3 and fact.result.value.components[3] == 8 end
end
assert(observedTransform and setters.CFrame == 1 and setters.Rotation == 1 and destroyed == 1, "rotation must preserve the before-capture translation with one seed and one setter")
count += 1

-- Reuse a valid sealed fixture, then corrupt only its strategy as an admission
-- regression. The graph must fail before the first constructor is called.
local partMetadata = Generated.classMetadata("Part")
local priorStrategy = partMetadata.preflightStrategy
partMetadata.preflightStrategy = "live_service"
run("unadmitted strategy", "normal", { Anchored = { kind = "boolean", value = true } }, {}, {}, "incomplete")
assert(#allocated == 0)
partMetadata.preflightStrategy = priorStrategy
local priorCreatable = partMetadata.creatable
partMetadata.creatable = false
run("update-only class", "normal", { Anchored = { kind = "boolean", value = true } }, {}, {}, "incomplete")
assert(#allocated == 0)
partMetadata.creatable = priorCreatable

mode = "allocation_failure"; allocated = {}; setters = {}; destroyed = 0
local prepared, payload = Cases.prepare(Generated, Hash, "Part", { Anchored = { kind = "boolean", value = true } }, {}, {})
local extra = table.clone(prepared.operations[1])
extra.target = { kind = "instance", identity = { kind = "forge_attribute", stableId = "second" }, path = "Workspace/Second", className = "Part" }
table.insert(prepared.operations, extra)
local authoring = Authoring.new({}, {}, {}); authoring.prepared = prepared
assert(authoring:preflight(payload).completion == "incomplete")
assert(#allocated == 1 and destroyed == 1, "partial allocation failure must clean earlier handles")
count += 1
authoringEnvironment.Instance = originalInstance
print(`Production detached preflight regressions passed: {count} (offline; no native Studio claim)`)
