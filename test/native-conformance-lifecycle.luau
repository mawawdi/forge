-- Actual Runner control flow with fixed dependencies. No native/property-equality claim.
local env = require("./Environment")
local passed, moduleNumber = 0, 0
local function runner()
	moduleNumber += 1
	return require("./Runner" .. tostring(moduleNumber))
end
local function test(name, callback)
	env.reset()
	local ok, failure = pcall(callback)
	assert(ok, name .. ": " .. tostring(failure))
	assert(env.chsAccesses == 0, "Command Bar fixture accessed ChangeHistoryService")
	passed += 1
end
local function rejects(callback, expected)
	local ok, failure = pcall(callback)
	assert(not ok and string.find(tostring(failure), expected, 1, true), "expected " .. expected .. ", got " .. tostring(failure))
end

test("run assembles detached output and reports without ChangeHistoryService", function()
	local report = runner().run()
	assert(report.status == "passed")
	local output = assert(env.output())
	assert(output:FindFirstChild("BeforeSaveReport"))
	local count = 0
	for _, event in env.publications do
		if event.parent == "Workspace" then
			count += 1
			assert(event.name == output.Name and event.children.BeforeSaveReport and event.children.PhysicalSample, "published before assembly completed")
			assert(event.children.BeforeSaveReport == "", "report completed before published readback")
		end
	end
	assert(count == 1, "output published more than once")
end)

test("fatal identity construction cleans owned nodes and allows same-module retry", function()
	local module = runner()
	env.failBuildIdentity = true
	rejects(module.run, "injected identity build failure")
	assert(env.output() == nil and env.liveCount() == 0, "fatal failure leaked output or detached instances")
	rejects(module.verifyReopen, "No completed fixture output exists")
	assert(module.run().status == "passed", "failed attempt poisoned same-module retry")
end)

test("fatal report encoding cleans all staged samples and permits retry", function()
	local module = runner()
	env.failEncode = true
	rejects(module.run, "injected report encoding failure")
	assert(env.output() == nil and env.liveCount() == 0, "report failure leaked detached objects")
	rejects(module.verifyReopen, "No completed fixture output exists")
	assert(module.run().status == "passed")
end)

test("final report value failure removes the published owned subtree and permits retry", function()
	local module = runner()
	env.failValueName = "BeforeSaveReport"
	rejects(module.run, "injected report value failure")
	assert(env.output() == nil and env.liveCount() == 0, "final receipt failure left partial published evidence")
	rejects(module.verifyReopen, "No completed fixture output exists")
	assert(module.run().status == "passed")
end)

test("parentage side effects are reported without corrective writes", function()
	env.mutateOnPublish = true
	local report = runner().run()
	assert(report.status == "failed")
	assert(report.persisted.PhysicalSample.Transparency.value == 0.25)
	assert(report.publishedObservations.PhysicalSample.Transparency.value == 0.75)
	local matched = false
	for _, check in report.checks do
		if check.name == "published native properties: PhysicalSample" then
			matched = true
			assert(check.passed == false and string.find(check.detail, "changed after parenting", 1, true))
		end
	end
	assert(matched)
	assert(env.script.Forge.GeneratedStudioEvidence.value.read(env.output():FindFirstChild("PhysicalSample"), "Transparency").value == 0.75)
end)

test("successful publication requires a new module session for reopen", function()
	local module = runner()
	module.run()
	local output = env.output()
	local before = output:FindFirstChild("BeforeSaveReport").Value
	rejects(module.verifyReopen, "Close and reopen")
	assert(output:FindFirstChild("BeforeSaveReport").Value == before)
	assert(output:FindFirstChild("ReopenReport") == nil)
	-- Missing saved evidence takes precedence over the same-session guard.
	output:FindFirstChild("BeforeSaveReport"):Destroy()
	rejects(module.verifyReopen, "missing saved native report")
end)

test("fresh module reads saved output and preserves the before report", function()
	runner().run()
	local output = env.output()
	local before = output:FindFirstChild("BeforeSaveReport").Value
	local module = runner()
	local report = module.verifyReopen()
	assert(report.status == "passed" and report.stage == "after_reopen")
	assert(output:FindFirstChild("BeforeSaveReport").Value == before)
	local receipt = assert(output:FindFirstChild("ReopenReport"))
	assert(env.encoded[receipt.Value].beforeReportHash ~= nil)
	rejects(module.verifyReopen, "existing reopen evidence is preserved")
end)

test("failed reopen receipt publication preserves prior output and is retryable", function()
	runner().run()
	local output = env.output()
	local before = output:FindFirstChild("BeforeSaveReport").Value
	local live = env.liveCount()
	local module = runner()
	env.failParentName = "ReopenReport"
	rejects(module.verifyReopen, "injected receipt publication failure")
	assert(env.output() == output and output:FindFirstChild("BeforeSaveReport").Value == before)
	assert(output:FindFirstChild("ReopenReport") == nil and env.liveCount() == live, "failed reopen leaked or replaced evidence")
	assert(module.verifyReopen().status == "passed")
end)

test("source identity mismatch publishes an explicit failed reopen report", function()
	runner().run()
	local before = env.output():FindFirstChild("BeforeSaveReport").Value
	env.script.Cases.Source ..= " changed"
	local report = runner().verifyReopen()
	assert(report.status == "failed")
	assert(report.checks[1].name == "same manifest and fixture sources" and report.checks[1].passed == false)
	assert(env.output():FindFirstChild("BeforeSaveReport").Value == before)
end)

print("Native conformance lifecycle cases passed: " .. tostring(passed))
