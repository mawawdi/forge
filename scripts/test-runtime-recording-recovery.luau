-- Offline regression: execute the fixed Runtime handler with read-only host
-- dependencies. No Studio, transport, model, or recording operation is run.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local source = fs.readFile("plugin/src/Forge/Runtime.luau")

local function section(first: string, last: string): string
	local start = assert(string.find(source, first, 1, true), "Runtime section start missing")
	local finish = assert(string.find(source, last, start + #first, true), "Runtime section end missing")
	return string.sub(source, start + #first, finish - 1)
end

local payloadFunction = "local function recoveryPayload" .. section("local function recoveryPayload", "\n\tlocal function pairAutomatically")
local handler = section('elseif message.type == "RequestCreatorRecordingRecovery" then', '\n\t\telseif message.type == "AcknowledgeClosedCreatorRecording" then')
local execute = luau.load("return function(authoring, recoveryProjectIndexProjection, publishProjectIndex, sendRequired, message)\n" .. payloadFunction .. "\n" .. handler .. "\nend", { debugName = "RuntimeRecordingRecoveryRegression" })()

local binding = {
	creatorSessionId = "creator_session_recovery",
	changeSetId = "change_set_recovery",
	changeSetHash = string.rep("a", 64),
	projectionId = "projection_recovery",
	projectionHash = string.rep("b", 64),
	manifestHash = string.rep("c", 64),
	beforeProjectIndexManifestId = "index_before",
	beforeProjectRevisionHash = string.rep("d", 64),
	beforeProjectDetectorEpoch = 0,
	recordingId = "recording_recovery",
}
local fresh = {
	indexManifest = { id = "index_recovery_fresh" },
	revision = { hash = string.rep("e", 64) },
	detectorEpoch = 4,
}

local function run(payload: any, options: any?): (boolean, any, any)
	options = options or {}
	local cursor = table.clone(binding)
	cursor.phase = if options.open then "open" else "finalization_intent"
	cursor.finalization = if options.open then nil else { action = "cancel", finalizationKind = if options.attempted then "recovery_cancel" else "ordinary", recovery = if options.attempted then true else nil }
	cursor.recovery = options.retained
	local events = {}
	local sent = nil
	local authoring = {
		recovery = function() return { recording = if options.missing then nil else cursor, recordingState = "open" } end,
		recordRecoveryEvidence = function(_self, manifestId, revisionHash, epoch)
			table.insert(events, "retain")
			assert(manifestId == fresh.indexManifest.id and revisionHash == fresh.revision.hash and epoch == fresh.detectorEpoch)
			if options.failRetain then error("injected retention failure") end
		end,
	}
	local success, failure = pcall(execute, authoring, function(recording)
		assert(recording == cursor)
	end, function(boundary, requestId)
		table.insert(events, "capture")
		assert(boundary == "recording_recovery" and requestId == "recovery_request")
		if options.failCapture then error("injected capture failure") end
		return fresh
	end, function(kind, result, requestId)
		table.insert(events, "send")
		assert(kind == "CreatorRecordingRecovery" and requestId == "recovery_request")
		sent = result
	end, { payload = payload, requestId = "recovery_request" })
	return success, failure, { events = events, sent = sent }
end

local passed, failure, observed = run(table.clone(binding))
assert(passed, tostring(failure))
assert(table.concat(observed.events, ",") == "capture,retain,send", "first recovery must collect and retain before publishing")
assert(observed.sent.recoveryProjectIndexManifestId == fresh.indexManifest.id and observed.sent.recoveryProjectRevisionHash == fresh.revision.hash and observed.sent.recoveryProjectDetectorEpoch == 4, "the receipt must bind its fresh capture")
assert(observed.sent.cancellation.kind == "replace_intent" and observed.sent.cancellation.action == "cancel" and observed.sent.recordingState == "open", "recovery must preserve exact ordinary-action provenance and direct open-state")
local openPassed, openFailure, open = run(binding, { open = true })
assert(openPassed, tostring(openFailure))
assert(open.sent.cancellation.kind == "open" and open.sent.cancellation.action == nil and open.sent.replacesAction == nil, "an open cursor grants cancellation without inventing a prior action")
local attemptedPassed, attemptedFailure, attempted = run(binding, { attempted = true })
assert(attemptedPassed, tostring(attemptedFailure))
assert(attempted.sent.cancellation == nil, "an uncertain recovery cancellation must never grant another Finish")

local mismatches = 0
for key, value in binding do
	local wrong = table.clone(binding)
	wrong[key] = if typeof(value) == "number" then value + 1 else "different_" .. value
	local accepted, _, result = run(wrong)
	assert(not accepted and #result.events == 0, "mismatched " .. key .. " must reject before any capture or receipt")
	mismatches += 1
end

local missingPassed, _, missing = run(binding, { missing = true })
assert(not missingPassed and #missing.events == 0, "missing durable cursor must reject before any recovery work")
local capturePassed, _, captureFailure = run(binding, { failCapture = true })
assert(not capturePassed and table.concat(captureFailure.events, ",") == "capture" and captureFailure.sent == nil, "failed capture must not retain or publish invented recovery evidence")
local retainPassed, _, retainFailure = run(binding, { failRetain = true })
assert(not retainPassed and table.concat(retainFailure.events, ",") == "capture,retain" and retainFailure.sent == nil, "failed durable retention must not publish recovery authority")
local repeated, repeatedFailure, newer = run(binding, { retained = { projectIndexManifestId = "stale", projectRevisionHash = string.rep("f", 64), projectDetectorEpoch = 1 } })
assert(repeated, tostring(repeatedFailure))
assert(newer.sent.recoveryProjectIndexManifestId == fresh.indexManifest.id and newer.sent.recoveryProjectDetectorEpoch == 4, "a later recovery request must use the fresh observation, never its stale retained capture")
print("Runtime recording recovery passed: first capture, " .. mismatches .. " binding mismatches, missing cursor, capture/retention failures, and refreshed evidence")
