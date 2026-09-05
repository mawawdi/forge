--!strict
-- Fixed, user-invoked native characterization. This fixture is not part of the
-- connector and does not expose a model tool, arbitrary call, or evaluation verdict.
local Generated = require(script.Forge.GeneratedStudioEvidence)
local Authoring = require(script.Forge.StudioAuthoring)
local Hash = require(script.Forge.Hash)
local Cases = require(script.Cases)
local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Runner = {}
local OUTPUT_NAME = "ForgeNativeConformanceOutput"
local ranInThisModuleSession = false

local function buildIdentity(): any
	local sources = { fixture = Hash.sha256(script.Source), cases = Hash.sha256(script.Cases.Source) }
	local names = {}
	for _, child in script.Forge:GetChildren() do
		assert(child:IsA("ModuleScript"), "unexpected fixture dependency")
		sources[child.Name] = Hash.sha256(child.Source)
	end
	for name in sources do table.insert(names, name) end
	table.sort(names)
	local material = {}
	for _, name in names do table.insert(material, name .. ":" .. sources[name]) end
	return { hash = Hash.sha256(table.concat(material, "\n")), sources = sources }
end

local function preflight(className, properties, attributes, removed, beforeProperties)
	local prepared, payload = Cases.prepare(Generated, Hash, className, properties, attributes, removed, beforeProperties)
	local authoring = Authoring.new(nil :: any, {}, {})
	authoring.prepared = prepared
	return authoring:preflight(payload)
end

local function observedProperties(instance: Instance, properties: any): any
	local values = {}
	local names = {}
	for name in properties do table.insert(names, name) end
	table.sort(names)
	for _, name in names do
		values[name] = Generated.read(instance, name)
	end
	return values
end

local function materials(values: any): any
	local result = {}
	for name, value in values do result[name] = Generated.canonicalValueMaterial(value) end
	return result
end

local function sameValues(before: any, after: any): boolean
	for name, value in before do if after[name] == nil or Generated.canonicalValueMaterial(value) ~= Generated.canonicalValueMaterial(after[name]) then return false end end
	for name in after do if before[name] == nil then return false end end
	return true
end

function Runner.run(): any
	assert(not game:GetService("RunService"):IsRunning(), "Run this fixture in Edit mode")
	assert(workspace:FindFirstChild(OUTPUT_NAME) == nil, "Open a fresh generated fixture before another run; existing evidence is preserved")
	ranInThisModuleSession = true
	local recording = assert(ChangeHistoryService:TryBeginRecording("ForgeNativeConformance"), "cannot open fixture recording")
	local output = Instance.new("Folder")
	output.Name = OUTPUT_NAME
	local checks = {}
	local report: any = {
		kind = "ForgeNativePreflightConformance", authority = "user_run_native_studio", manifestHash = Generated.manifestHash,
		fixtureBuild = buildIdentity(), engineVersion = version(), stage = "before_save", status = "passed",
		checks = checks, preflightEnvelopes = {}, persisted = {},
		note = "Fixed native preflight/codec characterization only; no complete creator transaction, game evaluation, or save/reopen result is implied.",
	}
	local function check(name: string, callback: () -> ())
		local ok, failure = pcall(callback)
		table.insert(checks, { name = name, passed = ok, detail = if ok then "observed" else tostring(failure) })
		if not ok then report.status = "failed" end
	end
	local executed, failure = pcall(function()
		output.Parent = workspace
		for _, className in Generated.writableClasses do
			check("native detached construction: " .. className, function()
				local metadata = Generated.classMetadata(className)
				assert(metadata.creatable and metadata.preflightStrategy == "detached_instance")
				local envelope = preflight(className, {}, {}, {})
				assert(envelope.completion == "complete", HttpService:JSONEncode(envelope))
			end)
		end
		report.admittedClassCount = #Generated.writableClasses
		check("engine-owned settings rejected", function()
			assert(not pcall(function() Cases.prepare(Generated, Hash, "Lighting", { Brightness = { kind = "number_f32", value = 2 } }, {}, {}) end))
		end)
		local properties = {
			Anchored = { kind = "boolean", value = true },
			CustomPhysicalProperties = Cases.physical(),
			Size = { kind = "vector3_f32", x = 4, y = 3, z = 2 },
			Transparency = { kind = "number_f32", value = 0.25 },
		}
		check("native production batch preflight", function()
			local envelope = preflight("Part", properties, { Confirmed = true }, { "Removed" })
			table.insert(report.preflightEnvelopes, envelope)
			assert(envelope.completion == "complete", HttpService:JSONEncode(envelope))
		end)
		check("six physical fields and whole-batch readback", function()
			local part = Instance.new("Part")
			part.Name = "PhysicalSample"
			part.Parent = output
			for _, name in Generated.sortedMutationPropertyNames("Part", properties) do Generated.write(part, name, properties[name]) end
			local observed = observedProperties(part, properties)
			assert(sameValues(properties, observed), "native batch changed an authored property")
			report.persisted.PhysicalSample = observed
			report.physicalMaterials = materials(observed)
		end)
		for _, case in {
			{ name = "ColorFamily", className = "Part", properties = { Color = { kind = "color3_rgb8", r = 255, g = 0, b = 0 } }, before = {} },
			{ name = "RotationFamily", className = "Part", properties = { Rotation = { kind = "vector3_f32", x = 0, y = 90, z = 0 } }, before = { CFrame = { kind = "cframe_f32x12", components = { 12, 3, 8, 1, 0, 0, 0, 1, 0, 0, 0, 1 } } } },
			{ name = "InsetsFamily", className = "ScreenGui", properties = { IgnoreGuiInset = { kind = "boolean", value = true } }, before = { ScreenInsets = { kind = "enum_name", value = "CoreUISafeInsets" } } },
		} do
			check("final native derived family: " .. case.name, function()
				local envelope = preflight(case.className, case.properties, {}, {}, case.before)
				table.insert(report.preflightEnvelopes, envelope)
				assert(envelope.completion == "complete", HttpService:JSONEncode(envelope))
				local instance = Instance.new(case.className)
				instance.Name = case.name; instance.Parent = output
				for name, value in case.before do Generated.write(instance, name, value) end
				for _, name in Generated.sortedMutationPropertyNames(case.className, case.properties) do Generated.write(instance, name, case.properties[name]) end
				local expected = {}
				for _, fact in envelope.facts do
					if fact.kind == "property" then assert(fact.result.status == "observed"); expected[fact.propertyName] = fact.result.value end
				end
				local observed = observedProperties(instance, expected)
				assert(sameValues(expected, observed), "native final family values differ from detached state")
				report.persisted[case.name] = observed
			end)
		end
		check("native coupled setter observation", function()
			local gui = Instance.new("ScreenGui")
			gui.Name = "ScreenSample"
			gui.Parent = output
			gui.IgnoreGuiInset = true
			local afterFirst = gui.IgnoreGuiInset
			gui.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets
			local afterBatch = gui.IgnoreGuiInset
			report.coupledSetter = { first = "IgnoreGuiInset", second = "ScreenInsets", afterFirst = afterFirst, afterBatch = afterBatch, screenInsets = gui.ScreenInsets.Name }
			assert(afterFirst == true and afterBatch == false, "native coupling differs from characterized behavior")
			local canonical = { ScreenInsets = { kind = "enum_name", value = "CoreUISafeInsets" } }
			report.persisted.ScreenSample = observedProperties(gui, canonical)
		end)
		local receipt = Instance.new("StringValue")
		receipt.Name = "BeforeSaveReport"
		receipt.Value = HttpService:JSONEncode(report)
		receipt.Parent = output
	end)
	if not executed then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
		error(failure)
	end
	ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	print("FORGE_NATIVE_CONFORMANCE " .. HttpService:JSONEncode(report))
	return report
end

function Runner.verifyReopen(): any
	assert(not game:GetService("RunService"):IsRunning(), "Reopen the saved fixture in Edit mode")
	assert(not ranInThisModuleSession, "Close and reopen the saved place before collecting reopen evidence")
	local output = assert(workspace:FindFirstChild(OUTPUT_NAME), "missing saved fixture output")
	assert(output:FindFirstChild("ReopenReport") == nil, "existing reopen evidence is preserved")
	local beforeValue = output:FindFirstChild("BeforeSaveReport")
	assert(beforeValue and beforeValue:IsA("StringValue"), "missing saved native report")
	local before = HttpService:JSONDecode(beforeValue.Value)
	local report: any = { kind = "ForgeNativePreflightConformance", authority = "user_run_native_studio", stage = "after_reopen", manifestHash = Generated.manifestHash, fixtureBuild = buildIdentity(), engineVersion = version(), beforeReportHash = Hash.sha256(beforeValue.Value), observations = {}, status = "passed", checks = {} }
	local function verify(name, callback)
		local ok, failure = pcall(callback)
		table.insert(report.checks, { name = name, passed = ok, detail = if ok then "observed" else tostring(failure) })
		if not ok then report.status = "failed" end
	end
	verify("same manifest and fixture sources", function()
		assert(before.manifestHash == report.manifestHash and before.fixtureBuild.hash == report.fixtureBuild.hash)
		assert(before.status == "passed", "before-save conformance did not pass")
	end)
	for name, expected in before.persisted do
		verify("saved native properties: " .. name, function()
			local instance = assert(output:FindFirstChild(name), "saved instance is missing")
			local observed = observedProperties(instance, expected)
			report.observations[name] = observed
			assert(sameValues(expected, observed), "saved property readback changed")
		end)
	end
	local recording = assert(ChangeHistoryService:TryBeginRecording("ForgeNativeConformanceReopen"))
	local receipt = Instance.new("StringValue")
	receipt.Name = "ReopenReport"
	receipt.Value = HttpService:JSONEncode(report)
	receipt.Parent = output
	ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	print("FORGE_NATIVE_CONFORMANCE_REOPEN " .. receipt.Value)
	return report
end

return Runner
