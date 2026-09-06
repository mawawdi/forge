-- Execute the production recovery read/guard/heartbeat fragments offline.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local Authoring = require("../plugin/src/Forge/StudioAuthoring")
local source = fs.readFile("plugin/src/Forge/Runtime.luau")
local function section(first: string, last: string): string
	local start = assert(string.find(source, first, 1, true))
	local finish = assert(string.find(source, last, start + #first, true))
	return string.sub(source, start + #first, finish - 1)
end
local helpers = "local CREATOR_RECOVERY_READ_FAILURE" .. section("local CREATOR_RECOVERY_READ_FAILURE", "local function capabilities()")
local reader = "local function readCreatorInventory" .. section("local function readCreatorInventory", "\n\tlocal pendingProjectChangeNotice")
local guard = section("local function handle(message: any)", "\n\t\tlocal activity = ConnectorPresentation.command(message.type)")
local heartbeat = "if not passiveResume and os.clock() >= nextHeartbeat then" .. section("if not passiveResume and os.clock() >= nextHeartbeat then", "\n\t\t\t\t\tidle = runtimeCapabilities.active")
local make = luau.load(helpers .. [[
return function(authoring, state, pluginError, send)
 local creatorRecoveryFailure = nil
 local sessionId = "inventory_test"
 local creatorRecordingCommands = {}
 local identityReads = 0
 local projectIdentity = { observe = function() identityReads += 1; return { project = {} } end }
 local passiveResume, nextHeartbeat = false, 0
 local projectId, currentProjectRevision = nil, nil
 local Generated = { manifestHash = "current_manifest" }
 local function adoptProjectIdentity() end
]] .. reader .. [[
 return {
  read = readCreatorInventory,
  guard = function(message) ]] .. guard .. [[ end,
  heartbeat = function() nextHeartbeat = 0; ]] .. heartbeat .. [[ return "poll_continues" end,
  identityReads = function() return identityReads end,
  failure = function() return creatorRecoveryFailure end,
  possible = function(owner) return possibleRecordingSafely(owner) end,
 }
end
]], { debugName = "RuntimeProtectedRecoveryInventoryRegression" })()

local keys = Authoring.settingKeysForTest()
local readFailures = 0
for _, problem in { "malformed_cursor", "different_contract", "malformed_receipt", "settings_read_failure" } do
	local writes, reads, errors, states, sends = 0, 0, 0, 0, 0
	local bad = if problem == "different_contract" then { kind = "ForgeCreatorTransactionCursor", manifestHash = string.rep("0", 64), phase = "finalization_intent" } else { unknown = "retained_private_value" }
	local values = if problem == "malformed_receipt" then { [keys.finalization] = bad } else { [keys.active] = bad }
	local plugin = {
		GetSetting = function(_, key)
			reads += 1
			if problem == "settings_read_failure" then error("private storage read failure") end
			return values[key]
		end,
		SetSetting = function() writes += 1; error("must not rewrite retained settings") end,
	}
	local authoring = Authoring.new(plugin, {}, {})
	local harness = make(authoring, function(title, detail)
		assert(title == "RECOVERY REQUIRED" and string.find(detail, "Preserve the plugin settings", 1, true))
		states += 1
	end, function(code, detail)
		assert(code == "RECOVERY_REQUIRED" and not string.find(detail, "retained_private_value", 1, true))
		errors += 1
		error("injected reporting failure")
	end, function() sends += 1 end)
	local recovery, receipt = harness.read()
	assert(recovery == nil and receipt == nil and harness.failure() ~= nil, problem .. " must remain unavailable, never become a clean inventory")
	local firstReads = reads
	assert(harness.heartbeat() == "poll_continues" and harness.heartbeat() == "poll_continues", "invalid settings must not terminate the poll loop")
	assert(reads == firstReads and errors == 1 and states == 1, "one failed pairing must retain its block without repeated reads or warning spam")
	assert(sends == 0 and harness.identityReads() == 0 and writes == 0, "failure must not emit empty heartbeat inventory, write settings, or reach downstream work")
	for _, command in { "LinkStudioProject", "ApplyCreatorChangeSet", "FinalizeCreatorChangeSet", "CancelInterruptedRecording" } do
		assert(not pcall(harness.guard, { kind = "StudioProtocolMessage", direction = "backend_to_plugin", payload = {}, sessionId = "inventory_test", type = command }), "invalid inventory must reject " .. command)
	end
	assert(harness.possible({ hasPossibleRecording = function() error("unreadable cursor") end }), "unpair must conservatively survive a recording read failure")
	assert(harness.possible({ hasPossibleRecording = function() return true end }))
	assert(not harness.possible({ hasPossibleRecording = function() return false end }))
	assert(values[if problem == "malformed_receipt" then keys.finalization else keys.active] == bad, "original recovery evidence must remain untouched")
	readFailures += 1
end

local sends = 0
local healthy = make(Authoring.new({ GetSetting = function() return nil end, SetSetting = function() error("read-only inventory") end }, {}, {}), function() error("healthy inventory must not show recovery failure") end, function() error("healthy inventory must not report a failure") end, function(kind)
	assert(kind == "Heartbeat")
	sends += 1
	return true
end)
local recovery, receipt = healthy.read()
assert(recovery.recordingState == "not_open" and receipt == nil and healthy.failure() == nil, "only successful strict reads may establish empty recording state")
assert(healthy.heartbeat() == "poll_continues" and sends == 1, "healthy heartbeat behavior must remain intact")
assert(pcall(healthy.guard, { kind = "StudioProtocolMessage", direction = "backend_to_plugin", payload = {}, sessionId = "inventory_test", type = "CollectStudioProjectIndex" }), "healthy inventory must not create a new command block")
print("Protected recovery inventory passed: " .. readFailures .. " invalid read cases, mutation guards, retained bytes, reporting failure isolation, and continued heartbeat polling")
