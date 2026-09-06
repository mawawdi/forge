-- Execute the fixed command handler with bounded offline dependencies. The
-- durable intent/receipt helpers are exercised separately in test-plugin-modules.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local source = fs.readFile("plugin/src/Forge/StudioAuthoring.luau")
local start = assert(string.find(source, "function StudioAuthoring:cancelInterrupted", 1, true))
local finish = assert(string.find(source, "\nfunction StudioAuthoring:rollback", start, true))
local body = string.sub(source, start, finish - 1)
local factory = luau.load("return function(activeSetting, sameRecordingBinding, exactRecordingState, changeHistoryService, beginRecoveryCancellation)\nlocal StudioAuthoring = {}\nlocal Enum = { FinishRecordingOperation = { Cancel = 'cancel' } }\n" .. body .. "\nreturn StudioAuthoring.cancelInterrupted\nend", { debugName = "OpenRecordingCancellationRegression" })()

local function run(phase: string, original: any, patch: any?, open: any?): (boolean, any, {string})
	local events = {}
	local cursor = {
		phase = phase, finalization = original, recordingId = "exact-recording",
		recovery = { projectIndexManifestId = "fresh-index", projectRevisionHash = "fresh-revision", projectDetectorEpoch = 7 },
	}
	local payload = {
		recordingId = "exact-recording", action = "cancel", finalizationKind = "recovery_cancel",
		expectedCurrentProjectIndexManifestId = "fresh-index", expectedCurrentProjectRevisionHash = "fresh-revision", expectedCurrentProjectDetectorEpoch = 7,
		replacesAction = if original then original.action else nil,
	}
	for key, value in patch or {} do payload[key] = value end
	local execute = factory(function() return cursor end, function(a, b) return a.recordingId == b.recordingId end,
		function(_, read)
			local ok, value = pcall(read)
			return if not ok then "unknown" elseif value then "open" else "not_open"
		end,
		function() return { IsRecordingInProgress = function(_, id)
			table.insert(events, "read-open")
			assert(id == "exact-recording")
			if open == "error" then error("read failed") end
			return open ~= false
		end } end,
		function(_, stored, expected)
			table.insert(events, "persist-intent")
			assert(stored == cursor and expected.projectIndexManifestId == "fresh-index" and expected.projectRevisionHash == "fresh-revision" and expected.projectDetectorEpoch == 7)
			return { phase = "finalization_intent", finalization = { recovery = true } }
		end)
	local host = { closeRecordingAndPersistFinalization = function(_, intent, id, operation, gate)
		table.insert(events, "finish")
		assert(intent.finalization.recovery and id == "exact-recording" and operation == "cancel")
		gate(intent)
		return true, "closed-proof"
	end }
	local success, result = pcall(execute, host, payload, function() table.insert(events, "gate") end)
	return success, result, events
end

for _, prior in { false, { action = "commit", finalizationKind = "ordinary" }, { action = "cancel", finalizationKind = "ordinary" } } do
	local success, result, events = run(if prior then "finalization_intent" else "open", if prior then prior else nil)
	assert(success and result == "closed-proof", tostring(result))
	assert(table.concat(events, ",") == "read-open,persist-intent,finish,gate", "current command fields must admit an exact cursor and retain the new intent before Finish")
end
for _, wrong in {
	{ recordingId = "different" }, { action = "commit" }, { finalizationKind = "ordinary" }, { replacesAction = "commit" },
	{ expectedCurrentProjectIndexManifestId = "old-index" }, { expectedCurrentProjectRevisionHash = "old-revision" }, { expectedCurrentProjectDetectorEpoch = 6 },
} do
	local accepted, _, events = run("open", nil, wrong)
	assert(not accepted and #events == 0, "a stale or invented gate must reject before native observation or mutation")
end
for _, exactOpen in { false, "error" } do
	local accepted, _, events = run("open", nil, nil, exactOpen)
	assert(not accepted and table.concat(events, ",") == "read-open", "unknown or closed recordings cannot obtain a new cancellation intent")
end
local repeated, _, events = run("finalization_intent", { action = "cancel", finalizationKind = "recovery_cancel", recovery = true })
assert(not repeated and #events == 0, "an uncertain recovery attempt grants no repeat Finish")
print("Open recording cancellation passed: open/commit/cancel cursors, seven binding failures, unknown/closed readback, and no repeat recovery")
return true
