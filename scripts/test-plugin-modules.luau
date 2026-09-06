local Generated = require("../plugin/src/Forge/GeneratedStudioEvidence")
local Hash = require("../plugin/src/Forge/Hash")
local StudioAuthoring = require("../plugin/src/Forge/StudioAuthoring")
local StudioEvidenceCollector = require("../plugin/src/Forge/StudioEvidenceCollector")
local StudioInstancePolicy = require("../plugin/src/Forge/StudioInstancePolicy")
local StudioProjectChangeMonitor = require("../plugin/src/Forge/StudioProjectChangeMonitor")
local StudioProjectIdentity = require("../plugin/src/Forge/StudioProjectIdentity")
local StudioProjectIndexCanonical = require("../plugin/src/Forge/StudioProjectIndexCanonical")
local StudioSemanticTransport = require("../plugin/src/Forge/StudioSemanticTransport")
local SerializedStudioWorker = require("../plugin/src/Forge/SerializedStudioWorker")
local Utf8Transport = require("../plugin/src/Forge/Utf8Transport")
local DirectRuntimeObserver = require("../plugin/src/Forge/DirectRuntimeObserver")
local Constants = require("../plugin/src/Forge/Constants")
local ConnectorPresentation = require("../plugin/src/Forge/ConnectorPresentation")
local fs = require("@lune/fs")
require("./test-runtime-recording-recovery")
require("./test-open-recording-cancellation")
require("./test-runtime-recovery-inventory")
require("./test-studio-project-unbounded")
require("./test-project-change-diagnostics")

do
	local Roblox = require("@lune/roblox")
	local constraint = { ClassName = "UISizeConstraint", MaxSize = Roblox.Vector2.new(math.huge, math.huge) }
	local expected = { kind = "vector2_f32", x = 640, y = 480 }
	local fact = StudioAuthoring.exactPropertyFactForTest(constraint, "MaxSize", expected)
	assert(fact.matchesBefore() and not fact.matchesAfter(), "native unbounded defaults must have exact before-state matchers")
	constraint.MaxSize = Roblox.Vector2.new(640, 480)
	assert(not fact.matchesBefore() and fact.matchesAfter(), "finite assignment must match only the approved after-state")
	constraint.MaxSize = Roblox.Vector2.new(math.huge, 480)
	assert(not fact.matchesBefore() and not fact.matchesAfter(), "an unrelated partial unbounded edit must not inherit an exemption")
	local mixed = StudioAuthoring.exactPropertyFactForTest(constraint, "MaxSize", expected)
	assert(mixed.matchesBefore(), "mixed finite/unbounded axes must retain their exact values")
	constraint.MaxSize = Roblox.Vector2.new(math.huge, 481)
	assert(not mixed.matchesBefore(), "finite axes must remain exact")
	constraint.MaxSize = Roblox.Vector2.new(math.huge, math.huge)
	assert(fact.matchesBefore(), "cancellation must recognize the captured engine default")
	assert(not pcall(function() Generated.read(constraint, "MaxSize") end), "private before-state support must not widen canonical final evidence")
	assert(not pcall(function() Generated.validateValue("vector2_f32", { kind = "vector2_f32", x = math.huge, y = 480 }) end), "authored infinity must remain rejected")
	constraint.MaxSize = Roblox.Vector2.new(math.huge, 0 / 0)
	assert(not pcall(function() StudioAuthoring.exactPropertyFactForTest(constraint, "MaxSize", expected) end), "NaN must never form an exact matcher")
	constraint.MaxSize = Roblox.Vector2.new(-math.huge, math.huge)
	assert(not pcall(function() StudioAuthoring.exactPropertyFactForTest(constraint, "MaxSize", expected) end), "unsupported negative infinity must remain rejected")
end

do
	local withinRoot = StudioInstancePolicy.isWithinEvidenceRoot
	StudioInstancePolicy.isWithinEvidenceRoot = function() return true end
	local function mockInstance(className: string)
		local handlers = {}
		local function signal(field: string)
			return { Connect = function(_, callback)
				handlers[field] = callback
				return { Disconnect = function() handlers[field] = nil end }
			end }
		end
		return {
			ClassName = className,
			Changed = signal("Changed"),
			AttributeChanged = signal("AttributeChanged"),
			IsA = function(_, name) return className == "StringValue" and name == "ValueBase" end,
			GetPropertyChangedSignal = function(_, field) return signal(field) end,
		}, handlers
	end
	local monitor = StudioProjectChangeMonitor.new(function() end, {})
	local camera, cameraEvents = mockInstance("Camera")
	local label, labelEvents = mockInstance("TextLabel")
	local value, valueEvents = mockInstance("StringValue")
	monitor:attachInstance(camera)
	monitor:attachInstance(label)
	monitor:attachInstance(value)
	assert(not monitor.monitoringFailed)
	cameraEvents.Changed("CFrame")
	labelEvents.Changed("AbsoluteSize")
	assert(monitor:detectorEpoch() == 0, "viewport motion and computed UI layout must not invalidate the project")
	labelEvents.Changed("FontFace")
	valueEvents.Changed("Camera")
	valueEvents.Name()
	valueEvents.Parent()
	assert(monitor:detectorEpoch() == 4, "authored fonts, value contents, renames, and reparenting must stay observable")
	monitor:destroy()
	assert(next(valueEvents) == nil, "all specialized ValueBase listeners must be released")
	StudioInstancePolicy.isWithinEvidenceRoot = withinRoot
end

do
	local connected = ConnectorPresentation.connection("connected")
	assert(not connected.showPrimary and connected.action == "Disconnect", "a healthy connector must keep disconnection in settings instead of making it the main action")
	for _, mode in { "reserved", "connecting" } do
		local control = ConnectorPresentation.connection(mode)
		assert(not control.enabled and not control.showPrimary, "connection UI must not offer a second action during pairing or a reserved Play session")
	end
	local invalid = ConnectorPresentation.connection("invalid_receipt")
	assert(invalid.enabled and invalid.showPrimary and invalid.action == "Discard invalid test data", "discarding invalid test data must remain an explicitly named creator action")
	assert(string.find(ConnectorPresentation.status("INVALID PLAY DATA").description, "does not undo", 1, true), "invalid-test recovery must explain that place changes are not undone")
	for _, code in { "PLAY EVIDENCE READY", "PLAY EVIDENCE RETURNED", "PLAY RECEIPT ACKNOWLEDGED", "RUNTIME COMPLETE" } do
		local status = ConnectorPresentation.status(code)
		assert(not status.working and string.find(status.description, "does not mean the test passed", 1, true), "collected runtime evidence must not be represented as a passed test")
	end
	for _, code in { "PLAY EVIDENCE INCOMPLETE", "RUNTIME INCOMPLETE", "RUNTIME REJECTED", "RECOVERY REQUIRED" } do
		local status = ConnectorPresentation.status(code)
		assert(status.tone == "attention" and not status.working, "incomplete or recovery state must not appear successful or still running")
	end
	local reading = assert(ConnectorPresentation.command("CollectStudioProjectIndex"))
	assert(ConnectorPresentation.status(reading.started).working and not ConnectorPresentation.status(reading.finished).working, "only an active Studio command should present a working indicator")
	assert(ConnectorPresentation.command("Heartbeat") == nil, "transport traffic must not fabricate agent work")
end

local runtimeExecutorSource = fs.readFile("plugin/src/Forge/RuntimeCapabilityExecutor.luau")
local generatedEvidenceSource = fs.readFile("plugin/src/Forge/GeneratedStudioEvidence.luau")
local directObserverSource = fs.readFile("plugin/src/Forge/DirectRuntimeObserver.luau")
local runtimeSource = fs.readFile("plugin/src/Forge/Runtime.luau")
local evidenceCollectorSource = fs.readFile("plugin/src/Forge/StudioEvidenceCollector.luau")
local scriptSource = fs.readFile("plugin/src/Forge/StudioScriptSource.luau")
local projectIndexSource = fs.readFile("plugin/src/Forge/StudioProjectIndexCollector.luau")
local projectChangeMonitorSource = fs.readFile("plugin/src/Forge/StudioProjectChangeMonitor.luau")
assert(not StudioInstancePolicy.isIndexedProperty("Camera", "CFrame"), "viewport navigation must not invalidate an authoring plan")
assert(not StudioInstancePolicy.isIndexedProperty("TextLabel", "AbsoluteSize"), "derived UI layout must not invalidate an authoring plan")
assert(StudioInstancePolicy.isIndexedProperty("TextLabel", "FontFace"), "font authoring must invalidate indexed UI facts")
assert(StudioInstancePolicy.isIndexedProperty("Part", "CFrame"), "moving an authored part must still invalidate its plan")
assert(StudioInstancePolicy.isIndexedProperty("Camera", "Name"), "unknown-class structural changes remain indexed")
assert(StudioInstancePolicy.isIndexedProperty("Script", "Source"), "script edits remain indexed")
assert(StudioInstancePolicy.isIndexedProperty("StringValue", "Value"), "ValueBase value changes remain indexed")
local projectIdentitySource = fs.readFile("plugin/src/Forge/StudioProjectIdentity.luau")
local identityRegistrySource = fs.readFile("plugin/src/Forge/IdentityRegistry.luau")
local authoringSource = fs.readFile("plugin/src/Forge/StudioAuthoring.luau")
local semanticTransportSource = fs.readFile("plugin/src/Forge/StudioSemanticTransport.luau")
local utf8TransportSource = fs.readFile("plugin/src/Forge/Utf8Transport.luau")

do
Hash.setDigestForTest(function(value: string): string
	local bytes = table.create(32, 0)
	for index = 1, #value do
		local slot = ((index - 1) % 32) + 1
		bytes[slot] = (bytes[slot] + string.byte(value, index) + index) % 256
	end
	local result = table.create(32)
	for index = 1, 32 do result[index] = string.char(bytes[index]) end
	return table.concat(result)
end)
assert(StudioProjectIdentity.settingKeyForTest() == "ForgeStudioProjectIdentityTransactionV2", "project identity must have one clean-break durable setting")
assert(not string.find(projectIdentitySource, "GeneratedStudioEvidence", 1, true) and not string.find(projectIdentitySource, "Generated.", 1, true), "reserved project identity must stay outside generic manifest authoring")
assert(not pcall(function()
	Generated.validateAttributes({ [Constants.PROJECT_IDENTITY_ATTRIBUTE] = "forge_project_00000000000000000000000000000000" })
end), "generic authoring must reject the reserved project identity attribute")
local identityIntent = assert(string.find(projectIdentitySource, 'persist(self.plugin, { kind = "StudioProjectIdentityTransactionCursor", operation = operation, beforeIdentity = before, phase = "opening" })', 1, true), "identity transaction must persist an opening intent")
local identityBegin = assert(string.find(projectIdentitySource, "TryBeginRecording", identityIntent, true), "identity transaction must use ChangeHistoryService")
assert(identityIntent < identityBegin, "project identity intent must be durable before TryBeginRecording can affect Studio")
assert(string.find(projectIdentitySource, "SetAttribute(Constants.PROJECT_IDENTITY_ATTRIBUTE", 1, true) and string.find(projectIdentitySource, "local observed = self:observe()", 1, true), "project identity writes must use the reserved Workspace attribute and direct readback")
assert(string.find(projectIdentitySource, "IsRecordingInProgress(recordingId)", 1, true) and string.find(projectIdentitySource, "FinishRecording", 1, true), "project identity finalization must prove exact recording closure")
assert(string.find(runtimeSource, 'message.type == "LinkStudioProject"', 1, true) and string.find(runtimeSource, 'message.type == "ForkStudioProject"', 1, true) and string.find(runtimeSource, 'message.type == "AbandonOpeningStudioProjectIdentity"', 1, true) and string.find(runtimeSource, 'message.type == "CancelInterruptedStudioProjectIdentity"', 1, true) and string.find(runtimeSource, 'message.type == "SettleClosedStudioProjectIdentity"', 1, true), "Runtime must expose only the dedicated identity transaction and recovery commands")
assert(string.find(runtimeSource, 'postMessage(messageFor("UnpairProject", { reason = "plugin_unload" }', 1, true), "plugin unload must release only its bridge lease while retaining durable Studio recovery evidence")
assert(string.find(runtimeSource, 'if studioWorker:isBusy() then', 1, true) and string.find(runtimeSource, 'request("GET", "/poll?sessionId="', 1, true), "long cooperative Studio work must renew the exact bridge transport lease without consuming its retained command")
assert(string.find(projectIdentitySource, "function StudioProjectIdentity:settleClosed", 1, true) and string.find(projectIdentitySource, 'exactRecordingState(self.changeHistory, stored.recordingId) ~= "not_open"', 1, true), "closed identity settlement must be explicit and prove the exact recording is no longer open")
assert(string.find(runtimeSource, "adoptFinalizedProjectIdentity", 1, true) and string.find(runtimeSource, "registry:setConnectorEpoch", 1, true), "a successful Link/Fork must rotate project and opaque-handle authority together")
local boundedIdentityFailure = StudioProjectIdentity.boundedFailureDetailForTest(string.rep("🙂", Constants.MAX_DIAGNOSTIC_CHARS))
assert(#boundedIdentityFailure <= Constants.MAX_DIAGNOSTIC_CHARS and utf8.len(boundedIdentityFailure) ~= nil, "identity failure detail truncation must preserve UTF-8 and its protocol byte bound")

local function identityRoot(initial: any?)
	local root = { Name = "Identity Test", PlaceId = 0, GameId = 0, Workspace = { value = initial } }
	function root:GetService(name: string): any
		assert(name == "Workspace")
		return self.Workspace
	end
	function root.Workspace:GetAttribute(name: string): any
		assert(name == Constants.PROJECT_IDENTITY_ATTRIBUTE)
		return self.value
	end
	function root.Workspace:SetAttribute(name: string, value: any)
		assert(name == Constants.PROJECT_IDENTITY_ATTRIBUTE)
		self.value = value
	end
	return root
end

local function identityOperation(root: any, action: string, assigned: string): any
	local expected = StudioProjectIdentity.observeForTest(root)
	local semantic = {
		kind = "StudioProjectIdentityOperation",
		action = action,
		project = expected.project,
		connectorEpoch = string.rep("a", 64),
		expectedIdentity = expected,
		assignedForgeProjectId = assigned,
	}
	local hash = Hash.sha256(StudioProjectIndexCanonical.material(semantic))
	semantic.id = "studio_project_identity_operation_" .. string.sub(hash, 1, 24)
	semantic.hash = hash
	return StudioProjectIdentity.canonicalOperationForTest(semantic)
end

do
	local linked = identityRoot("forge_project_86958b1ba2524252a60821ae68713233")
	local PlaytestContext = require("../plugin/src/Forge/PlaytestContext")
	local first = PlaytestContext.projectKey(linked)
	assert(first == "ForgePlaytestContext" .. Hash.sha256("local:" .. linked.Workspace.value))
	linked.Name = "Renamed Place"
	assert(PlaytestContext.projectKey(linked) == first, "Play context must follow the saved Workspace project identity across reopen and rename")
	local unlinked = identityRoot(nil)
	assert(PlaytestContext.projectKey(unlinked) == nil)
	unlinked.PlaceId, unlinked.GameId = 41, 42
	assert(PlaytestContext.projectKey(unlinked) == "ForgePlaytestContext" .. Hash.sha256("published:42:41"))
end

local identityEvents, identitySettings = {}, {}
local linkedRoot = identityRoot(nil)
local identityPlugin = {
	GetSetting = function(_self: any, key: string): any return identitySettings[key] end,
	SetSetting = function(_self: any, key: string, value: any)
		identitySettings[key] = value
		table.insert(identityEvents, "setting:" .. (value and value.kind .. ":" .. (value.phase or value.status) or "cleared"))
	end,
}
local identityHistory = { open = false }
function identityHistory:IsRecordingInProgress(recordingId: any?): boolean
	if recordingId ~= nil then assert(recordingId == "identity-recording") end
	return self.open
end
function identityHistory:TryBeginRecording(_name: string): string
	table.insert(identityEvents, "begin")
	self.open = true
	return "identity-recording"
end
function identityHistory:FinishRecording(recordingId: string, operation: any)
	assert(recordingId == "identity-recording")
	table.insert(identityEvents, "finish:" .. operation)
	self.open = false
end
local identityManager = StudioProjectIdentity.new(identityPlugin, {
	root = linkedRoot,
	changeHistory = identityHistory,
	now = function() return "2026-09-03T00:00:00.000Z" end,
	finishRecordingOperation = { Commit = "commit", Cancel = "cancel" },
})
local linkOperation = identityOperation(linkedRoot, "link", "forge_project_11111111111111111111111111111111")
assert(not pcall(function() identityManager:execute(linkOperation, string.rep("b", 64), function() return true end) end), "an epoch mismatch must reject before recording")
local rejectedLinkEvidence = identityManager:rejectionEvidence(linkOperation)
assert(rejectedLinkEvidence.kind == "StudioProjectIdentityRejectionEvidence" and rejectedLinkEvidence.status == "observed" and rejectedLinkEvidence.operationHash == linkOperation.hash and rejectedLinkEvidence.identity.hash == linkOperation.expectedIdentity.hash and rejectedLinkEvidence.transaction.status == "none" and rejectedLinkEvidence.recordingState == "not_open", "a pre-recording rejection must capture exact bound no-effect evidence")
assert(#identityEvents == 0 and linkedRoot.Workspace.value == nil, "capturing rejection evidence must never write settings, open a recording or mutate identity")
local linkReceipt = identityManager:execute(linkOperation, string.rep("a", 64), function() return true end)
assert(linkReceipt.status == "linked" and linkedRoot.Workspace.value == linkOperation.assignedForgeProjectId, "Link must commit only the exact assigned local project id")
assert(identityEvents[1] == "setting:StudioProjectIdentityTransactionCursor:opening" and identityEvents[2] == "begin", "the durable identity intent must precede the recording effect")
assert(identityEvents[#identityEvents] == "setting:StudioProjectIdentityFinalizationReceipt:linked" and not identityHistory.open, "Link must retain a terminal receipt only after direct closure proof")
local finalizedRejectionEvidence = identityManager:rejectionEvidence(linkOperation)
assert(finalizedRejectionEvidence.status == "observed" and finalizedRejectionEvidence.transaction.status == "finalized" and finalizedRejectionEvidence.identity.hash ~= linkOperation.expectedIdentity.hash, "a rejected follow-up after effects must retain the actual receipt and changed identity rather than claim no effects")
identityManager:acknowledge({ requestId = "identity-ack-test", receiptId = linkReceipt.id, receiptHash = linkReceipt.hash })
assert(identitySettings.ForgeStudioProjectIdentityTransactionV2 == nil, "only an exact receipt acknowledgement may clear settled identity evidence")

local failedWriteSettings = {}
local failedWriteRoot = identityRoot(nil)
function failedWriteRoot.Workspace:SetAttribute(_name: string, _value: any) error("injected identity write failure") end
local failedWritePlugin = {
	GetSetting = function(_self: any, key: string): any return failedWriteSettings[key] end,
	SetSetting = function(_self: any, key: string, value: any) failedWriteSettings[key] = value end,
}
local failedWriteHistory = { open = false }
function failedWriteHistory:IsRecordingInProgress(_recordingId: any?): boolean return self.open end
function failedWriteHistory:TryBeginRecording(_name: string): string self.open = true; return "failed-write-recording" end
function failedWriteHistory:FinishRecording(_recordingId: string, operation: any)
	assert(operation == "cancel")
	self.open = false
end
local failedWriteManager = StudioProjectIdentity.new(failedWritePlugin, {
	root = failedWriteRoot,
	changeHistory = failedWriteHistory,
	now = function() return "2026-09-03T00:00:00.000Z" end,
	finishRecordingOperation = { Commit = "commit", Cancel = "cancel" },
})
local failedWriteOperation = identityOperation(failedWriteRoot, "link", "forge_project_33333333333333333333333333333333")
local failedWriteReceipt = failedWriteManager:execute(failedWriteOperation, string.rep("a", 64), function() return true end)
assert(failedWriteReceipt.status == "cancelled" and failedWriteReceipt.finalization == "ordinary" and failedWriteReceipt.afterIdentity.hash == failedWriteReceipt.beforeIdentity.hash and not failedWriteHistory.open, "a proven write failure must cancel the same recording and retain an exact ordinary-cancellation receipt")

local intentBeginCalls = 0
local intentFailureManager = StudioProjectIdentity.new({
	GetSetting = function(): any return nil end,
	SetSetting = function() error("injected identity intent persistence failure") end,
}, {
	root = identityRoot(nil),
	changeHistory = {
		IsRecordingInProgress = function(): boolean return false end,
		TryBeginRecording = function(): string intentBeginCalls += 1; return "must-not-open" end,
	},
	now = function() return "2026-09-03T00:00:00.000Z" end,
	finishRecordingOperation = { Commit = "commit", Cancel = "cancel" },
})
local intentFailureOperation = identityOperation(intentFailureManager.root, "link", "forge_project_44444444444444444444444444444444")
assert(not pcall(function() intentFailureManager:execute(intentFailureOperation, string.rep("a", 64), function() return true end) end) and intentBeginCalls == 0, "an identity recording must never open before its durable intent is readable")

local openingSettings = {}
local openingRoot = identityRoot(nil)
local openingWrites = 0
local openingSetAttribute = openingRoot.Workspace.SetAttribute
function openingRoot.Workspace:SetAttribute(name: string, value: any)
	openingWrites += 1
	openingSetAttribute(self, name, value)
end
local openingPlugin = {
	GetSetting = function(_self: any, key: string): any return openingSettings[key] end,
	SetSetting = function(_self: any, key: string, value: any) openingSettings[key] = value end,
}
local openingHistory = { globallyOpen = false, beginCalls = 0, finishCalls = 0 }
function openingHistory:IsRecordingInProgress(): boolean return self.globallyOpen end
function openingHistory:TryBeginRecording(_name: string): any
	self.beginCalls += 1
	return nil
end
function openingHistory:FinishRecording(_recordingId: string, _operation: any)
	self.finishCalls += 1
end
local openingManager = StudioProjectIdentity.new(openingPlugin, {
	root = openingRoot,
	changeHistory = openingHistory,
	now = function() return "2026-09-03T00:00:00.000Z" end,
	finishRecordingOperation = { Commit = "commit", Cancel = "cancel" },
})
local openingOperation = identityOperation(openingRoot, "link", "forge_project_66666666666666666666666666666666")
assert(not pcall(function() openingManager:execute(openingOperation, string.rep("a", 64), function() return true end) end), "a recording-open outcome without an exact recording id must remain recoverable")
local openingInventory = openingManager:inventory()
local pendingRejectionEvidence = openingManager:rejectionEvidence(openingOperation)
assert(pendingRejectionEvidence.status == "observed" and pendingRejectionEvidence.transaction.status == "pending", "a durable opening intent prevents no-effect reservation release even if the recording is not open")
assert(openingInventory.status == "pending" and openingInventory.phase == "opening" and openingInventory.recordingState == "not_open" and openingInventory.recordingId == nil, "an interrupted pre-recording identity intent must expose exact global no-recording evidence")
local openingReceipt = openingManager:abandonOpening({
	requestId = "identity-opening-abandon-test",
	operationId = openingOperation.id,
	operationHash = openingOperation.hash,
	transactionCursorHash = openingInventory.cursorHash,
	expectedIdentityStateHash = StudioProjectIdentity.observeForTest(openingRoot).hash,
}, function() return true end)
assert(openingReceipt.status == "cancelled" and openingReceipt.finalization == "recovery_abandon" and openingReceipt.recordingId == nil and openingWrites == 0 and openingHistory.beginCalls == 1 and openingHistory.finishCalls == 0, "creator-authorized opening abandonment must persist a no-effect receipt without writing identity or finalizing a recording")
assert(not pcall(function()
	openingManager:abandonOpening({
		requestId = "identity-opening-abandon-repeat",
		operationId = openingOperation.id,
		operationHash = openingOperation.hash,
		transactionCursorHash = openingInventory.cursorHash,
		expectedIdentityStateHash = openingReceipt.afterIdentity.hash,
	}, function() return true end)
end), "a settled opening abandonment must never execute twice")

local uncertainOpeningSettings = {}
local uncertainOpeningHistory = { open = false }
function uncertainOpeningHistory:IsRecordingInProgress(): boolean return self.open end
function uncertainOpeningHistory:TryBeginRecording(_name: string): any
	self.open = true
	return nil
end
local uncertainOpeningManager = StudioProjectIdentity.new({
	GetSetting = function(_self: any, key: string): any return uncertainOpeningSettings[key] end,
	SetSetting = function(_self: any, key: string, value: any) uncertainOpeningSettings[key] = value end,
}, {
	root = identityRoot(nil),
	changeHistory = uncertainOpeningHistory,
	now = function() return "2026-09-03T00:00:00.000Z" end,
	finishRecordingOperation = { Commit = "commit", Cancel = "cancel" },
})
local uncertainOpeningOperation = identityOperation(uncertainOpeningManager.root, "link", "forge_project_77777777777777777777777777777777")
assert(not pcall(function() uncertainOpeningManager:execute(uncertainOpeningOperation, string.rep("a", 64), function() return true end) end), "an unknown recording-open outcome must remain fail-closed")
local uncertainOpeningInventory = uncertainOpeningManager:inventory()
local uncertainRejectionEvidence = uncertainOpeningManager:rejectionEvidence(uncertainOpeningOperation)
assert(uncertainRejectionEvidence.status == "observed" and uncertainRejectionEvidence.recordingState == "unknown", "an unidentifiable open recording must remain unknown in rejected-command evidence")
assert(uncertainOpeningInventory.recordingState == "unknown", "a globally open recording must never be presented as safe opening abandonment")
assert(not pcall(function()
	uncertainOpeningManager:abandonOpening({
		requestId = "identity-opening-abandon-unsafe",
		operationId = uncertainOpeningOperation.id,
		operationHash = uncertainOpeningOperation.hash,
		transactionCursorHash = uncertainOpeningInventory.cursorHash,
		expectedIdentityStateHash = StudioProjectIdentity.observeForTest(uncertainOpeningManager.root).hash,
	}, function() return true end)
end), "opening abandonment must reject every state without exact no-recording proof")

local recoveryEvents, recoverySettings = {}, {}
local recoveryRoot = identityRoot(nil)
local recoveryPlugin = {
	GetSetting = function(_self: any, key: string): any return recoverySettings[key] end,
	SetSetting = function(_self: any, key: string, value: any) recoverySettings[key] = value; table.insert(recoveryEvents, value and value.kind or "cleared") end,
}
local recoveryHistory = { open = false, failFinish = true }
function recoveryHistory:IsRecordingInProgress(recordingId: any?): boolean
	if recordingId ~= nil then assert(recordingId == "identity-recording") end
	return self.open
end
function recoveryHistory:TryBeginRecording(_name: string): string self.open = true; return "identity-recording" end
function recoveryHistory:FinishRecording(_recordingId: string, operation: any)
	if self.failFinish then error("injected uncertain finish") end
	if operation == "cancel" then recoveryRoot.Workspace.value = nil end
	self.open = false
end
local recoveryManager = StudioProjectIdentity.new(recoveryPlugin, {
	root = recoveryRoot,
	changeHistory = recoveryHistory,
	now = function() return "2026-09-03T00:00:00.000Z" end,
	finishRecordingOperation = { Commit = "commit", Cancel = "cancel" },
})
local interruptedOperation = identityOperation(recoveryRoot, "link", "forge_project_22222222222222222222222222222222")
assert(not pcall(function() recoveryManager:execute(interruptedOperation, string.rep("a", 64), function() return true end) end), "an uncertain commit must remain recovery-required")
local interruptedInventory = recoveryManager:inventory()
assert(interruptedInventory.status == "pending" and interruptedInventory.phase == "finalizing" and interruptedInventory.finalization == "commit" and interruptedInventory.recordingState == "open", "restart inventory must report the exact open finalization cursor without mutating Studio")
recoveryHistory.failFinish = false
local recoveryReceipt = recoveryManager:cancelInterrupted({
	requestId = "identity-recovery-test",
	operationId = interruptedOperation.id,
	operationHash = interruptedOperation.hash,
	transactionCursorHash = interruptedInventory.cursorHash,
	recordingId = interruptedInventory.recordingId,
	expectedIdentityStateHash = StudioProjectIdentity.observeForTest(recoveryRoot).hash,
}, function() return true end)
assert(recoveryReceipt.status == "cancelled" and recoveryReceipt.finalization == "recovery_cancel" and recoveryRoot.Workspace.value == nil and not recoveryHistory.open, "creator-authorized recovery must cancel only the exact proven-open identity recording")
assert(not pcall(function()
	recoveryManager:cancelInterrupted({
		requestId = "identity-recovery-stale-test",
		operationId = interruptedOperation.id,
		operationHash = interruptedOperation.hash,
		transactionCursorHash = string.rep("0", 64),
		recordingId = interruptedInventory.recordingId,
		expectedIdentityStateHash = recoveryReceipt.afterIdentity.hash,
	}, function() return true end)
end), "a stale or forged recovery cursor must never repeat identity finalization")

local settleSettings = {}
local settleRoot = identityRoot(nil)
local settleWrites = 0
local settleSetAttribute = settleRoot.Workspace.SetAttribute
function settleRoot.Workspace:SetAttribute(name: string, value: any)
	settleWrites += 1
	settleSetAttribute(self, name, value)
end
local settlePlugin = {
	GetSetting = function(_self: any, key: string): any return settleSettings[key] end,
	SetSetting = function(_self: any, key: string, value: any) settleSettings[key] = value end,
}
local settleHistory = { open = false, finishCalls = 0 }
function settleHistory:IsRecordingInProgress(_recordingId: any?): boolean return self.open end
function settleHistory:TryBeginRecording(_name: string): string self.open = true; return "closed-identity-recording" end
function settleHistory:FinishRecording(_recordingId: string, _operation: any)
	self.finishCalls += 1
	self.open = false
	error("injected post-close receipt gap")
end
local settleManager = StudioProjectIdentity.new(settlePlugin, {
	root = settleRoot,
	changeHistory = settleHistory,
	now = function() return "2026-09-03T00:00:00.000Z" end,
	finishRecordingOperation = { Commit = "commit", Cancel = "cancel" },
})
local settleOperation = identityOperation(settleRoot, "link", "forge_project_55555555555555555555555555555555")
assert(not pcall(function() settleManager:execute(settleOperation, string.rep("a", 64), function() return true end) end), "a post-close receipt gap must remain explicit")
local closedInventory = settleManager:inventory()
assert(closedInventory.status == "pending" and closedInventory.phase == "finalizing" and closedInventory.finalization == "commit" and closedInventory.recordingState == "not_open", "restart inventory must distinguish an exactly closed finalization cursor")
local settlePayload = {
	requestId = "identity-closed-settle-test",
	operationId = settleOperation.id,
	operationHash = settleOperation.hash,
	transactionCursorHash = closedInventory.cursorHash,
	recordingId = closedInventory.recordingId,
	expectedIdentityStateHash = StudioProjectIdentity.observeForTest(settleRoot).hash,
	expectedFinalization = "commit",
}
local staleSettlePayload = table.clone(settlePayload)
staleSettlePayload.transactionCursorHash = string.rep("0", 64)
assert(not pcall(function() settleManager:settleClosed(staleSettlePayload, function() return true end) end), "closed settlement must reject a stale cursor")
local settledReceipt = settleManager:settleClosed(settlePayload, function() return true end)
assert(settledReceipt.status == "linked" and settledReceipt.finalization == "recovery_settle" and settleWrites == 1 and settleHistory.finishCalls == 1, "closed settlement must persist a terminal receipt without another Studio write or recording finalization")
assert(not pcall(function() settleManager:settleClosed(settlePayload, function() return true end) end), "closed settlement must reject duplicate terminalization")
local unreadableManager = StudioProjectIdentity.new({ GetSetting = function() error("durable settings unavailable") end }, {
	root = identityRoot(nil), changeHistory = { IsRecordingInProgress = function() return false end },
	finishRecordingOperation = { Commit = "commit", Cancel = "cancel" },
})
local unreadableProof = unreadableManager:rejectionEvidence(identityOperation(unreadableManager.root, "link", "forge_project_88888888888888888888888888888888"))
assert(unreadableProof.status == "unavailable" and string.find(unreadableProof.detail, "durable settings unavailable", 1, true), "failed reads must produce explicit unavailable rejection evidence, never an empty transaction")
assert(string.find(runtimeSource, "settlement.identityRejection = projectIdentity:rejectionEvidence(command.payload.operation)", 1, true), "Runtime must attach exact rejection evidence before caching/sending the terminal Link/Fork settlement")
Hash.setDigestForTest(nil)
end

assert(string.find(runtimeSource, 'message.type == "CollectStudioProjectIndex"', 1, true), "the connector must accept the bounded project-index request")
assert(not string.find(runtimeSource, "RequestStudioProjectIndex", 1, true), "the superseded project-index request must be absent")
assert(string.find(runtimeSource, '"StudioProjectIndexStarted"', 1, true) and string.find(runtimeSource, '"StudioProjectIndexCompleted"', 1, true), "the connector must delimit every project index stream")
assert(string.find(runtimeSource, 'local beforeCapture = requireCurrentProjectIndex("creator prepare")', 1, true), "Prepare must bind the complete pre-Apply capture without publishing an unclaimed transaction stream")
assert(string.find(runtimeSource, 'local beforeCapture = requireCurrentProjectIndex("creator preflight")', 1, true), "preflight must retain the same monitored pre-Apply capture without publishing an unclaimed transaction stream")
assert(string.find(runtimeSource, 'local beforeCapture = requireCurrentProjectIndex("creator apply")', 1, true), "Apply must recheck the monitored pre-Apply binding before its one receipt-bound post-state stream")
assert(not string.find(runtimeSource, 'publishProjectIndex("creator prepare"', 1, true) and not string.find(runtimeSource, 'publishProjectIndex("creator preflight"', 1, true) and not string.find(runtimeSource, 'publishProjectIndex("creator apply"', 1, true), "one transaction request ID must never carry discarded pre-phase project-index streams")
assert(string.find(runtimeSource, 'projectChangeMonitor:detectorEpoch() ~= currentProjectIndexDetectorEpoch', 1, true), "every preflight boundary must reject changes after the authoritative pre-Apply capture")
assert(string.find(runtimeSource, "local function requireFinalizationGate", 1, true) and string.find(runtimeSource, 'requireFinalizationGate(message.payload, active.binding, "creator finalization")', 1, true) and string.find(runtimeSource, 'requireFinalizationGate(message.payload, recovery.recording, "interrupted creator recording cancellation", true)', 1, true) and string.find(runtimeSource, 'original.action == payload.replacesAction', 1, true) and string.find(runtimeSource, 'manifestId = recovery.projectIndexManifestId', 1, true), "every FinishRecording path must bind its durable recording cursor to the exact current monitored project capture; recovery cancellation must use only its durable recovery gate and explicit original-action provenance")
assert(string.find(runtimeSource, "beforeProjectDetectorEpoch", 1, true) and string.find(runtimeSource, "expectedCurrentProjectDetectorEpoch", 1, true) and string.find(runtimeSource, "postApplyProjectDetectorEpoch", 1, true) and string.find(runtimeSource, "recoveryProjectDetectorEpoch", 1, true), "pre-Apply, provisional, recovery, and finalization receipts must retain their phase-appropriate monitor epochs")
assert(string.find(runtimeSource, "requireDurableFinalizationGate(intent", 1, true) and string.find(authoringSource, "local function requirePreFinishGate", 1, true) and string.find(authoringSource, "finalization gate rejected", 1, true), "every durable intent must recheck its exact project-index and monitor gate immediately before FinishRecording")
assert(string.find(runtimeSource, "provisional_cursor_persistence_failed", 1, true) and string.find(runtimeSource, "projectDetectorEpoch = post.detectorEpoch", 1, true), "a provisional persistence failure must bind its cancellation intent to the last complete post-Apply capture, not a later post-cancel capture")
assert(string.find(authoringSource, "beforeProjectDetectorEpoch = prepared.beforeProjectDetectorEpoch", 1, true) and string.find(authoringSource, "payload.beforeProjectDetectorEpoch ~= beforeCapture.detectorEpoch", 1, true), "Prepare, preflight, and Apply must echo and enforce the exact pre-Apply detector epoch")
assert(string.find(authoringSource, "finalizationKind = stored.finalization.finalizationKind", 1, true) and string.find(runtimeSource, "finalizationKind = receipt.finalizationKind", 1, true), "the durable intent, receipt, and protocol finalization gate must distinguish an ordinary action from recovery cancellation")
assert(string.find(runtimeSource, 'payload.cancellation = { kind = "replace_intent", action = replacesAction }', 1, true) and string.find(runtimeSource, "payload.replacesAction = receipt.replacesAction", 1, true) and string.find(runtimeSource, 'recording.finalization.finalizationKind == "ordinary"', 1, true) and string.find(runtimeSource, "recording.finalization.recovery ~= true", 1, true) and string.find(authoringSource, "payload.replacesAction == stored.finalization.action", 1, true), "only an original ordinary finalization intent exposes replacement provenance; an uncertain recovery cancellation cannot advertise another Finish")
assert(string.find(authoringSource, "or not sameRecordingBinding(payload, stored)", 1, true), "recovery cancellation must preserve the complete original recording binding while its expected-current gate uses the later recovery capture")
assert(string.find(runtimeSource, "clearFinalizationMonitorState", 1, true) and string.find(runtimeSource, "finalization_post_index_failed", 1, true), "a failed final project-index capture must clear exact monitor exemptions and leave recovery fail-closed")
assert(string.find(projectIndexSource, '"StudioProjectEvidenceShard"', 1, true) and string.find(projectIndexSource, '"StudioSourceBlobManifest"', 1, true) and string.find(projectIndexSource, '"StudioSourceBlobChunk"', 1, true), "the connector must stream typed project-index artifacts")
assert(string.find(projectIndexSource, "local capturePayload = { detectorEpoch = detectorEpoch", 1, true) and string.find(projectIndexSource, 'return { kind = "StudioProjectIndexCapture", detectorEpoch = detectorEpoch', 1, true), "the Luau producer must hash and emit the same detector-epoch-bound capture shape required by the TypeScript consumer")
assert(string.find(projectIndexSource, "PROJECT_INDEX_MAXIMUM_SHARD_BYTES", 1, true) and string.find(projectIndexSource, "project index node exceeds configured shard resource policy", 1, true), "project shards must respect both count and byte resource bounds")
assert(string.find(projectIndexSource, "local emptyShardPending = #records == 0", 1, true) and string.find(projectIndexSource, "emptyShardPending = false", 1, true), "an empty or missing root must emit exactly one shard and terminate")
assert(not string.find(projectIndexSource, "cursor == 1 and #records == 0", 1, true), "project indexing must not use a non-advancing empty-root loop condition")
assert(string.find(projectIndexSource, "Canonical.objectMaterialLength", 1, true) and string.find(projectIndexSource, "Canonical.arrayMaterialLength", 1, true), "shard admission must use incremental exact sizing rather than repeatedly materializing a growing shard")
assert(string.find(projectIndexSource, "task.wait()", 1, true) and string.find(projectIndexSource, "local function cooperate", 1, true), "large project collection and transport must yield cooperatively")
assert(string.find(projectIndexSource, "local function cooperativeSort", 1, true) and string.find(projectIndexSource, "local function rootRecords", 1, true) and not string.find(projectIndexSource, "root:GetDescendants()", 1, true), "project enumeration and canonical ordering must remain cooperatively schedulable")
assert(string.find(projectIndexSource, "Canonical.transportJson", 1, true) and not string.find(projectIndexSource, "Canonical.json", 1, true), "transport JSON must use the buffered encoder rather than recursive string concatenation")
assert(string.find(projectIndexSource, "Utf8Transport.boundaries", 1, true) and string.find(projectIndexSource, "PROJECT_INDEX_TRANSPORT_CHUNK_BYTES", 1, true), "index transport must use the shared UTF-8-safe fragmenter")
assert(string.find(utf8TransportSource, "utf8.len", 1, true) and string.find(utf8TransportSource, "0xC0", 1, true), "every transport must validate UTF-8 and split only at code-point boundaries")
assert(string.find(projectIndexSource, "emit = function", 1, true) and not string.find(projectIndexSource, "local pieces", 1, true) and not string.find(projectIndexSource, "artifact.fragments", 1, true), "index transport must emit one encoded leaf at a time without retaining a second full stream")
local projectIndexTransportStart = string.find(projectIndexSource, "function StudioProjectIndexCollector:transport(capture: any)", 1, true)
assert(projectIndexTransportStart ~= nil, "the project-index transport must accept one immutable capture")
local projectIndexTransportSource = string.sub(projectIndexSource, projectIndexTransportStart)
assert(not string.find(projectIndexTransportSource, "project index changed during transport", 1, true) and not string.find(projectIndexTransportSource, "currentDetectorEpoch", 1, true), "an immutable completed project capture must not be invalidated by callbacks which arrive while its bytes are transported")
assert(string.find(runtimeSource, 'mode ~= "current" and mode ~= "transaction_evidence"', 1, true) and string.find(runtimeSource, 'publishProjectIndex("creator post-apply", message.requestId, nil, "transaction_evidence")', 1, true) and string.find(runtimeSource, "projectChangeMonitor:detectorEpoch() == detectorEpoch", 1, true), "Runtime must separate historical transaction evidence from a still-current command-authority binding")
assert(string.find(runtimeSource, "while true do", 1, true) and string.find(runtimeSource, "Restart the complete capture under the same overall resource bound", 1, true), "a detector callback during project reading must restart the whole bounded capture rather than mixing epochs or failing a valid transaction immediately")
assert(string.find(runtimeSource, "end, deadline)", 1, true) and string.find(projectIndexSource, "collectionDeadline: number", 1, true) and string.find(projectIndexSource, "assertBeforeDeadline(collectionDeadline)", 1, true), "every whole-capture retry must consume one caller-owned absolute deadline rather than minting a fresh resource budget")
assert(string.find(runtimeSource, "automatic cancellation was not attempted because current project authority could not be proven", 1, true) and string.find(runtimeSource, 'mutationFailed(active, stage, failureCode, requestId, false, exactFailure)', 1, true), "an unsafe automatic-cancellation gate must emit bound recovery evidence before rejecting the command")
assert(string.find(scriptSource, "FindScriptDocument", 1, true) and string.find(scriptSource, "UpdateSourceAsync", 1, true) and string.find(scriptSource, "expectedBeforeHash", 1, true), "source reads and edits must bind the current ScriptEditorService document")
assert(string.find(scriptSource, "function StudioScriptSource.writeAndReadback", 1, true) and string.find(scriptSource, "StudioScriptSource.write(instance, expectedBeforeHash, source)", 1, true) and string.find(scriptSource, "StudioScriptSource.read(instance)", 1, true), "all source writes must share one exact ScriptEditorService-aware write/readback route")
assert(string.find(authoringSource, "StudioScriptSource.writeAndReadback", 1, true) and not string.find(authoringSource, "StudioScriptSource.write(", 1, true) and not string.find(authoringSource, "(scratch :: any).Source", 1, true), "detached source canaries and provisional source writes must not bypass the common source route")
assert(string.find(authoringSource, 'capture.state ~= "accepted"', 1, true) and string.find(authoringSource, "source-write blob is absent or incomplete before Prepare", 1, true), "a source-write body must be acknowledged before it can reach Prepare")
assert(string.find(authoringSource, "source-write binding is absent or duplicated", 1, true) and string.find(authoringSource, "payload.sequence ~= capture.nextSequence", 1, true) and string.find(authoringSource, "source-write fragment is duplicate or inconsistent", 1, true), "undeclared, missing, reordered, and duplicate source-write pieces must fail before mutation")
assert(string.find(authoringSource, "source-write blob chunk hash mismatch", 1, true) and string.find(authoringSource, "source-write blob final hash mismatch", 1, true), "source-write chunk and complete-body hashes must be reverified in Studio")
assert(string.find(authoringSource, "local function validatedSourceEdit", 1, true) and string.find(authoringSource, "validatedSourceEdit(operation, self.registry, function(binding) return resolvedSourceWrite(self, binding) end)", 1, true), "validation, detached preflight, and apply must share request-bound source-edit materialization")
assert(string.find(authoringSource, 'capture.state ~= "receiving"', 1, true) and string.find(authoringSource, 'capture.state = "accepted"', 1, true), "source-write acceptance must be an explicit one-way state transition")
assert(string.find(authoringSource, "capture.requestId ~= payload.requestId", 1, true) and string.find(authoringSource, "self.sourceWriteRequestId ~= payload.requestId", 1, true), "source-write leaves, acceptance, and Prepare must share one exact request")
assert(string.find(authoringSource, "Generated.matchesStudioCreatorMutationBinding", 1, true) and string.find(authoringSource, "revisionHash = revision", 1, true), "creator projections must use the generated closed revisionHash binding matcher")
assert(not string.find(authoringSource, "binding.projectRevisionHash", 1, true), "creator evidence bindings must not alias revisionHash as projectRevisionHash")
assert(not string.find(authoringSource, "for name, value in pairs(properties)", 1, true) and string.find(authoringSource, "Generated.sortedMutationPropertyNames", 1, true), "property mutation order must come from the generated canonical manifest helper rather than a Lua hash map")
assert(StudioAuthoring.validateStudioMutationAuthorityForTest({ mutationAuthority = "studio_document" }), "Studio authoring must accept its one exact writer domain")
assert(not pcall(function() StudioAuthoring.validateStudioMutationAuthorityForTest({ mutationAuthority = "rojo_source" }) end), "a Rojo-authority change set must never cross the Studio authoring trust boundary")
assert(not pcall(function() StudioAuthoring.validateStudioMutationAuthorityForTest({}) end), "a missing mutation authority must fail closed in Studio")
assert(StudioAuthoring.validateAuthoringContainerClassForTest("StarterPlayer/StarterPlayerScripts", "StarterPlayerScripts"), "a generated structural container must retain its exact engine class")
assert(not pcall(function() StudioAuthoring.validateAuthoringContainerClassForTest("Workspace/Undeclared", "Folder") end), "an arbitrary allowed-root path must not impersonate an engine-owned authoring container")
assert(not pcall(function() StudioAuthoring.validateAuthoringContainerClassForTest("StarterPlayer/StarterPlayerScripts", "Folder") end), "an engine-owned authoring container must reject a class mismatch")
assert(StudioAuthoring.requiresDetachedStructureCanaryForTest({ className = "Folder" }), "an authorable delete root must retain its detached create/destroy canary")
assert(not StudioAuthoring.requiresDetachedStructureCanaryForTest({ className = "Camera" }), "a consequential unsupported delete descendant must remain a structure-only postcondition and must not be instantiated during preflight")
local folderCreatable = Generated.classes.Folder.creatable
Generated.classes.Folder.creatable = false
assert(not StudioAuthoring.requiresDetachedStructureCanaryForTest({ className = "Folder" }), "a manifest-known but noncreatable class must never reach Instance.new during detached preflight")
Generated.classes.Folder.creatable = folderCreatable

-- ScriptEditorService can schedule TextDocumentDidChange after UpdateSourceAsync
-- returns. The project monitor must consume that event only when the exact
-- script and its current source state match Forge's approved result. This is
-- deliberately not a writer-active timer: an unrelated field or a different
-- current source still advances the detector epoch.
local observedNotices = {}
local attributionMonitor = StudioProjectChangeMonitor.new(function(notice: any) table.insert(observedNotices, notice) end, {})
local observedScript = {}
local observedSource = "before"
attributionMonitor:expectExactForgeMutationFact({
	source = "script_editor",
	instance = observedScript,
	matchesBefore = function() return observedSource == "before" end,
	matchesAfter = function() return observedSource == "after" end,
	beforeEventBudget = 1,
	afterEventBudget = 1,
})
attributionMonitor:expectExactForgeMutationFact({
	source = "property",
	instance = observedScript,
	field = "Source",
	matchesBefore = function() return observedSource == "before" end,
	matchesAfter = function() return observedSource == "after" end,
	beforeEventBudget = 1,
	afterEventBudget = 1,
})
observedSource = "after"
attributionMonitor:emit("script_editor", observedScript)
attributionMonitor:emit("property", observedScript, "Source")
assert(attributionMonitor:detectorEpoch() == 0 and #observedNotices == 0, "a delayed exact Forge editor/source notification must not dirty the approved transaction")
attributionMonitor:emit("script_editor", observedScript)
assert(attributionMonitor:detectorEpoch() == 1 and #observedNotices == 1, "an exact fact must be one-shot so a later editor event cannot inherit Forge authority")
attributionMonitor:emit("property", observedScript, "Name")
assert(attributionMonitor:detectorEpoch() == 2 and #observedNotices == 2, "an unrelated field on the same script must remain an external dirty event")
observedSource = "creator edit"
attributionMonitor:emit("script_editor", observedScript)
assert(attributionMonitor:detectorEpoch() == 3 and #observedNotices == 3, "a concurrent editor change with a different exact source must never be suppressed")
local otherScript = {}
attributionMonitor:emit("script_editor", otherScript)
assert(attributionMonitor:detectorEpoch() == 4 and #observedNotices == 4, "an identical-looking edit on another instance must remain dirty")
attributionMonitor:expectExactForgeRecordingFinish("opaque-recording-id")
	attributionMonitor:recordingFinished("Forge creator change friendly-name", "Creator change", "opaque-recording-id", nil, {})
	assert(attributionMonitor:detectorEpoch() == 4, "OnRecordingFinished must match the third opaque identifier, not its human-readable name")
	attributionMonitor:recordingFinished("opaque-recording-id", "Creator change", "different-opaque-recording-id", nil, {})
	assert(attributionMonitor:detectorEpoch() == 5, "a foreign recording with Forge's name must remain an external dirty event")
	-- A missing terminal callback must not accumulate opaque suppression ids. The
	-- finalization path explicitly clears this one bounded id when its receipt
	-- cannot be retained or once it is acknowledged.
	attributionMonitor:expectExactForgeRecordingFinish("missing-terminal-callback")
	attributionMonitor:expectExactForgeRecordingFinish("missing-terminal-callback")
	assert(not pcall(function()
		attributionMonitor:expectExactForgeRecordingFinish("second-missing-terminal-callback")
	end), "only one exact Forge recording finish may await its engine callback")
	attributionMonitor:clearExpectedForgeRecordingFinish("missing-terminal-callback")
	attributionMonitor:expectExactForgeRecordingFinish("replacement-terminal-callback")
	attributionMonitor:clearExpectedForgeRecordingFinish("replacement-terminal-callback")
	attributionMonitor:recordingFinished("Forge creator change", "Creator change", "replacement-terminal-callback")
	assert(attributionMonitor:detectorEpoch() == 6, "a delayed completion after its exact allowance is cleared must be dirty rather than remain indefinitely suppressed")

local cancellationNotices = {}
local cancellationMonitor = StudioProjectChangeMonitor.new(function(notice: any) table.insert(cancellationNotices, notice) end, {})
local restoredScript = {}
local restoredSource = "after"
cancellationMonitor:expectExactForgeMutationFact({
	source = "script_editor",
	instance = restoredScript,
	matchesBefore = function() return restoredSource == "before" end,
	matchesAfter = function() return restoredSource == "after" end,
	beforeEventBudget = 1,
	afterEventBudget = 1,
})
cancellationMonitor:setExactForgeMutationPhase("before")
restoredSource = "before"
cancellationMonitor:emit("script_editor", restoredScript)
assert(cancellationMonitor:detectorEpoch() == 0, "an exact cancellation restoration may consume only its recorded before-state event")
cancellationMonitor:emit("script_editor", restoredScript)
assert(cancellationMonitor:detectorEpoch() == 1 and #cancellationNotices == 1, "a cancellation matcher must not become a reusable exemption")

-- A real transaction applies first and may later cancel the same recording.
-- Source writes can report through both ScriptEditorService and Changed,
-- while reparenting can report through both Parent and hierarchy callbacks.
-- Each exact channel has one Apply and one cancellation allowance; consuming
-- the former must not erase the latter, and no third same-field/value event
-- may be hidden as Forge activity.
local phaseNotices = {}
local phaseMonitor = StudioProjectChangeMonitor.new(function(notice: any) table.insert(phaseNotices, notice) end, {})
local phaseScript = {}
local phaseSource = "before"
local phaseParent = "none"
local function phaseFact(source: string, instance: any, field: string?, beforeMatches: () -> boolean, afterMatches: () -> boolean): any
	return {
		source = source,
		instance = instance,
		field = field,
		matchesBefore = beforeMatches,
		matchesAfter = afterMatches,
		beforeEventBudget = 1,
		afterEventBudget = 1,
	}
end
phaseMonitor:expectExactForgeMutationFact(phaseFact("script_editor", phaseScript, nil, function() return phaseSource == "before" end, function() return phaseSource == "after" end))
phaseMonitor:expectExactForgeMutationFact(phaseFact("property", phaseScript, "Source", function() return phaseSource == "before" end, function() return phaseSource == "after" end))
phaseMonitor:expectExactForgeMutationFact(phaseFact("property", phaseScript, "Parent", function() return phaseParent == "none" end, function() return phaseParent == "approved" end))
phaseMonitor:expectExactForgeMutationFact(phaseFact("hierarchy", phaseScript, "added", function() return phaseParent == "none" end, function() return phaseParent == "approved" end))
phaseMonitor:expectExactForgeMutationFact(phaseFact("hierarchy", phaseScript, "removing", function() return phaseParent == "approved" end, function() return phaseParent == "none" end))

phaseSource = "after"
phaseParent = "approved"
phaseMonitor:emit("script_editor", phaseScript)
phaseMonitor:emit("property", phaseScript, "Source")
phaseMonitor:emit("property", phaseScript, "Parent")
phaseMonitor:emit("hierarchy", phaseScript, "added")
assert(phaseMonitor:detectorEpoch() == 0, "all exact Apply channels must be independently suppressible")

phaseMonitor:setExactForgeMutationPhase("before")
phaseSource = "before"
phaseMonitor:emit("script_editor", phaseScript)
phaseMonitor:emit("property", phaseScript, "Source")
-- DescendantRemoving is observed while the object still has its approved
-- parent; Changed("Parent") is observed after the rollback detached it.
phaseParent = "approved"
phaseMonitor:emit("hierarchy", phaseScript, "removing")
phaseParent = "none"
phaseMonitor:emit("property", phaseScript, "Parent")
assert(phaseMonitor:detectorEpoch() == 0, "Apply notifications must not consume the exact rollback allowance for source or Parent channels")
phaseMonitor:emit("property", phaseScript, "Source")
assert(phaseMonitor:detectorEpoch() == 1 and #phaseNotices == 1, "a later creator event on the same field and value must be dirty once its rollback allowance is consumed")
assert(string.find(authoringSource, 'ACTIVE_RECORDING_SETTING = "ForgeCreatorTransactionCursorV6"', 1, true) and string.find(authoringSource, 'FINALIZATION_RECEIPT_SETTING = "ForgeCreatorFinalizationReceiptV6"', 1, true) and string.find(authoringSource, 'LAST_COMMIT_SETTING = "ForgeCreatorLastCommitV6"', 1, true), "creator transaction state must use only the current clean-break keys")
assert(not string.find(authoringSource, '"ForgeCreatorTransactionCursorV5"', 1, true) and not string.find(authoringSource, '"ForgeCreatorFinalizationReceiptV5"', 1, true) and not string.find(authoringSource, '"ForgeCreatorLastCommitV5"', 1, true) and not string.find(authoringSource, '"ForgeCreatorTransactionCursorV4"', 1, true) and not string.find(authoringSource, '"ForgeCreatorFinalizationReceiptV4"', 1, true) and not string.find(authoringSource, '"ForgeCreatorLastCommitV4"', 1, true) and not string.find(authoringSource, '"ForgeCreatorTransactionCursorV3"', 1, true) and not string.find(authoringSource, '"ForgeCreatorFinalizationReceiptV3"', 1, true) and not string.find(authoringSource, '"ForgeCreatorLastCommitV3"', 1, true) and not string.find(authoringSource, '"ForgeCreatorActiveRecordingV3"', 1, true) and not string.find(authoringSource, '"ForgeCreatorActiveRecording"', 1, true) and not string.find(authoringSource, '"ForgeCreatorFinalizationReceiptV2"', 1, true) and not string.find(authoringSource, '"ForgeCreatorLastCommitV2"', 1, true) and not string.find(authoringSource, "discardIncompatibleSettledState", 1, true), "the constructor must never inspect, migrate, or delete predecessor transaction-state keys")
local creatorSettingKeys = StudioAuthoring.settingKeysForTest()
assert(creatorSettingKeys.active == "ForgeCreatorTransactionCursorV6" and creatorSettingKeys.finalization == "ForgeCreatorFinalizationReceiptV6" and creatorSettingKeys.lastCommit == "ForgeCreatorLastCommitV6", "active-recording recovery and settled receipts must share the clean-break key boundary")
assert(string.find(authoringSource, "local function beginFinalization", 1, true) and string.find(authoringSource, 'phase = "finalization_intent"', 1, true) and string.find(authoringSource, 'phase = "finalization_finished"', 1, true), "every creator finalization must persist a closed intent before it can become finished")
assert(string.find(authoringSource, "local finalizationIntent = beginFinalization", 1, true) and string.find(authoringSource, "closeRecordingAndPersistFinalization", 1, true) and string.find(authoringSource, "IsRecordingInProgress(recordingId)", 1, true), "Finalize must durably record intent, then prove the exact recording closed before finished persistence")
assert(string.find(authoringSource, "changeHistoryService():IsRecordingInProgress()", 1, true) and string.find(authoringSource, "return not checked or open == true", 1, true), "a clean-break connector must fail closed when Studio has any unbound recording")
assert(string.find(runtimeSource, 'recovery.recording.phase == "finalization_finished"', 1, true), "reconnect may mint a finalization receipt only from a durable finished state")
assert(string.find(runtimeSource, 'sendRequired("CreatorSourceWriteBlobAccepted"', 1, true), "Studio must acknowledge every complete source-write blob before Prepare")
assert(string.find(runtimeSource, 'message.type == "CreatorChangePrepareStarted"', 1, true) and string.find(runtimeSource, 'message.type == "CreatorChangePrepareChunk"', 1, true) and string.find(runtimeSource, 'message.type == "CreatorChangePrepareCompleted"', 1, true), "Prepare must arrive as a bounded start/chunk/complete command stream")
assert(not string.find(runtimeSource, 'message.type == "PrepareCreatorChangeSet"', 1, true), "the unbounded single-command Prepare transport must be absent")
assert(string.find(authoringSource, "payload.sequence ~= capture.nextSequence", 1, true) and string.find(authoringSource, "creator Prepare document hash mismatch", 1, true), "Prepare fragments must be ordered and bind the exact reassembled document")
assert(string.find(authoringSource, "prepared.prepareDocumentHash == payload.documentHash", 1, true), "an exact redelivered Prepare completion must reproduce its semantic receipt")
assert(string.find(projectChangeMonitorSource, "AttributeChanged", 1, true) and string.find(projectChangeMonitorSource, ".Changed:Connect", 1, true), "the project monitor must observe property and attribute changes")
assert(string.find(projectChangeMonitorSource, "PROJECT_CHANGE_MONITOR_MAXIMUM_INSTANCES", 1, true) and string.find(projectChangeMonitorSource, "monitoring_failure", 1, true), "monitor resource exhaustion must fail closed")
assert(string.find(projectChangeMonitorSource, "expectExactForgeMutationFact", 1, true) and string.find(projectChangeMonitorSource, "matchesExactForgeMutation", 1, true) and string.find(projectChangeMonitorSource, "document:GetScript()", 1, true), "monitor must bind delayed editor signals to exact instance/state facts")
assert(not string.find(projectChangeMonitorSource, "beginSynchronousForgeMutation", 1, true) and not string.find(projectChangeMonitorSource, "synchronousForgeMutationDepth", 1, true), "the monitor must not hide arbitrary concurrent edits behind a Forge-active interval")
assert(string.find(projectChangeMonitorSource, "beforeEventBudget", 1, true) and string.find(projectChangeMonitorSource, "afterEventBudget", 1, true) and string.find(projectChangeMonitorSource, "beforeEventsRemaining", 1, true) and string.find(projectChangeMonitorSource, "afterEventsRemaining", 1, true), "exact monitor facts must retain independent bounded notification budgets for Apply and cancellation")
assert(string.find(projectChangeMonitorSource, "function(name: any, displayName: any, identifier: any)", 1, true), "OnRecordingFinished must bind its third opaque identifier argument")
assert(Constants.PROJECT_CHANGE_MONITOR_MAXIMUM_INSTANCES == Constants.PROJECT_INDEX_MAXIMUM_INSTANCES, "a policy-valid project cannot hit a smaller hidden monitor ceiling")
assert(string.find(projectChangeMonitorSource, "self:attachInstance(instance); self:emit(\"hierarchy\", instance, \"added\")", 1, true) and string.find(projectChangeMonitorSource, "self:emit(\"hierarchy\", instance, \"removing\"); self:detachInstance(instance)", 1, true), "dynamic hierarchy callbacks must stay constant-time, identity-bound, and ignore out-of-scope changes")
assert(string.find(projectChangeMonitorSource, "expectExactForgeRecordingFinish", 1, true) and string.find(projectChangeMonitorSource, "OnRecordingFinished", 1, true), "only the exact Forge recording completion may be suppressed")
assert(string.find(runtimeSource, "setRecordingFinishObserver", 1, true) and string.find(runtimeSource, "clearExpectedForgeRecordingFinish", 1, true), "runtime must bind settled Forge recordings to the monitor")
assert(string.find(runtimeSource, "expectExactForgeMutationFact(fact)", 1, true) and string.find(runtimeSource, 'setExactForgeMutationPhase("before")', 1, true), "Runtime must register exact authoring effects before writes and select exact pre-state facts only for cancellation")
assert(string.find(authoringSource, "exactSourceFacts", 1, true) and string.find(authoringSource, "exactMutationFact", 1, true) and string.find(authoringSource, "onExpectedMutationFact", 1, true) and string.find(authoringSource, "onMutationPhase", 1, true) and string.find(authoringSource, "exactHierarchyFact", 1, true), "authoring must derive phase-scoped instance/field-bound facts instead of granting the monitor a broad writer exemption, including a failed batch's exact cancellation")
assert(string.find(authoringSource, "\treturn payload\nend\n\nlocal function referenceEncoder", 1, true), "exact mutation-fact construction must return its bounded matcher payload for monitor attribution")
assert(string.find(authoringSource, "compileMutationTransactionTopologyFromIndex", 1, true) and string.find(authoringSource, "canonicalOperations(changeSet, topology)", 1, true) and string.find(authoringSource, "detachedScratchGraph(prepared)", 1, true), "Prepare, detached preflight, and Apply must consume one generated transaction topology")
assert(string.find(authoringSource, "for _, operation in ipairs(prepared.operations) do", 1, true) and not string.find(authoringSource, "for _, operation in ipairs(prepared.changeSet.operations) do validateOperation", 1, true), "Apply must validate and materialize each operation only at its canonical execution point")
assert(string.find(authoringSource, "local function allocateCreatedHandles", 1, true) and string.find(authoringSource, "createdHandles:resolveReference(reference)", 1, true) and string.find(authoringSource, "registry:enrollInstance(instance, operation.target.identity.stableId)", 1, true) and string.find(authoringSource, "applyProperties(instance, operation.className, operation.properties, registry, onExpectedMutationFact, resolveReference, encodeReference, derivedValues)", 1, true), "Apply must allocate private detached create handles before recording and use their exact reference resolver while materializing created identities")
assert(string.find(authoringSource, "local function boundedFailureDetail", 1, true) and string.find(authoringSource, "failureDetail = boundedFailureDetail", 1, true) and string.find(authoringSource, "recordingAttempted = false", 1, true), "pre-recording and recording failures must retain bounded actionable detail without fabricating a mutation attempt")
local preRecordingFailure = assert(string.find(authoringSource, 'failureCode = "pre_recording_validation_failed"', 1, true), "Apply must classify a pre-recording validation failure distinctly")
local noCancellationAcknowledgement = string.find(authoringSource, "cancellationProven = false", preRecordingFailure - 512, true)
assert(noCancellationAcknowledgement ~= nil and noCancellationAcknowledgement < preRecordingFailure, "a pre-recording failure cannot claim a cancellation acknowledgement")
assert(string.find(runtimeSource, "local recordingAttempted = failed == nil or failed.recordingAttempted ~= false", 1, true) and string.find(runtimeSource, 'recordingState = "not_open"', 1, true) and string.find(runtimeSource, 'if recordingAttempted and recordingId == nil then return false end', 1, true), "Runtime must emit an unnamed failure only for a proven pre-TryBegin boundary and keep an indeterminate recording attempt on recovery/settlement")
assert(string.find(runtimeSource, 'string.sub(binding.recordingId, 1, #"pending_recording_") ~= "pending_recording_"', 1, true) and string.find(authoringSource, "recordingId = recording, cancellationProven = false, recordingState = \"unknown\"", 1, true), "an opening placeholder must never be a mutation receipt id; a returned exact recording id survives a cursor-persistence failure as unknown-state evidence")
assert(string.find(runtimeSource, 'recordingState = "not_open",\n\t\t}, requestId)', 1, true) and string.find(runtimeSource, 'if cancellationProven == true and (recordingId == nil or recordingState ~= "not_open") then cancellationProven = false end', 1, true), "detached preflight must report the protocol-valid no-recording state, and Runtime must not claim cancellation without a named closed recording")
assert(not string.find(runtimeSource, "mutationFailed(nil", 1, true) and string.find(runtimeSource, "mutationFailed({ binding = bindingOrFailure }", 1, true) and string.find(runtimeSource, "mutationFailed({ binding = stored }", 1, true), "every post-recording cancellation/finalization failure must retain the exact named recording binding")
assert(string.find(authoringSource, "prepared.beforeProjectIndexManifestId ~= beforeCapture.indexManifest.id", 1, true) and string.find(authoringSource, "prepared.beforeProjectDetectorEpoch ~= beforeCapture.detectorEpoch", 1, true) and string.find(authoringSource, "prepared.changeSet.expectedRevisionHash ~= beforeCapture.revision.hash", 1, true), "Apply must independently bind the entire prepared project-index tuple before opening a recording")
assert(string.find(authoringSource, 'instance.Parent == oldParent and instance.Name == operation.name end, function() return instance.Parent == parent and instance.Name == operation.name', 1, true), "a move-and-rename cancellation must match DescendantAdded after the parent is restored but before ChangeHistory reverses the rename")
assert(string.find(runtimeSource, "StudioProjectAuthority.derive", 1, true) and not string.find(runtimeSource, 'kind = "StudioConnectorEpoch"', 1, true), "pairing and identity adoption must use the generated authority derivation, never a second epoch recipe")
assert(not string.find(runtimeSource, 'sessionId .. ":" .. connectorBuildHash()', 1, true), "connector epochs must not use an ad hoc concatenation")
assert(string.find(evidenceCollectorSource, "StudioScriptSource.read", 1, true), "index/evidence source reads must observe current editor state")
assert(not string.find(evidenceCollectorSource, "project_state", 1, true), "the removed project-state envelope collector must be absent")
assert(string.find(runtimeExecutorSource, 'PASSIVE_RUNTIME_SETTING = "ForgePassiveRuntimeDirectV2"', 1, true), "runtime observation must use the current direct-observer durable setting")
assert(not string.find(runtimeExecutorSource, 'PASSIVE_RUNTIME_SETTING = "ForgePassiveRuntimeDirectV1"', 1, true), "the superseded passive-runtime setting must not have a current reader")
assert(string.find(runtimeExecutorSource, "function RuntimeCapabilityExecutor.discardInvalidPassive", 1, true) and string.find(runtimeExecutorSource, "refusing to discard valid durable passive runtime evidence", 1, true), "invalid passive evidence must have an explicit recovery boundary that rejects valid evidence")
local commandSettlementCache = string.find(runtimeSource, "handledCommands[command.messageId] = record", 1, true)
local commandSettlementSend = commandSettlementCache and string.find(runtimeSource, "sendCommandSettlement(record, command.requestId)", commandSettlementCache, true)
assert(commandSettlementCache and commandSettlementSend and commandSettlementCache < commandSettlementSend, "terminal command settlement must be cached before transport")
assert(string.find(runtimeSource, 'disposition = if executed then "executed" else "rejected"', 1, true), "command settlement must represent both executed and rejected handler outcomes")
assert(string.find(runtimeSource, "local function boundedCommandDiagnostic", 1, true) and string.find(runtimeSource, "utf8.len(candidate)", 1, true), "rejected command diagnostics must remain valid bounded UTF-8 on the wire")
assert(not string.find(runtimeSource, "StudioCommandAcknowledged", 1, true), "the success-only command acknowledgement protocol must not remain")
assert(string.find(runtimeSource, 'sendOrderedRequired("StudioProjectIndexStarted"', 1, true) and string.find(runtimeSource, 'sendOrderedRequired("StudioProjectIndexCompleted"', 1, true), "project-index boundaries must use exact ordered transport acknowledgements")
assert(string.find(runtimeSource, "sendOrderedRequired(pieceType, piecePayload, requestId)", 1, true), "a project-index fragment failure must stop emission before the next fragment")
assert(string.find(semanticTransportSource, "StudioEvidenceProduced = true", 1, true) and string.find(semanticTransportSource, "CreatorChangePreflighted = true", 1, true) and string.find(semanticTransportSource, "CreatorMutationProvisional = true", 1, true), "every potentially-large Studio evidence outcome must share one sealed semantic stream")
assert(not string.find(runtimeSource, 'send("StudioEvidenceProduced"', 1, true) and not string.find(runtimeSource, 'send("CreatorChangePreflighted"', 1, true) and not string.find(runtimeSource, 'send("CreatorMutationProvisional"', 1, true), "large semantic evidence must never use the direct wire path")
assert(not string.find(evidenceCollectorSource, "function StudioEvidenceCollector:chunks", 1, true), "the superseded evidence-only raw-byte chunker must be absent")
assert(string.find(runtimeSource, 'studioWorker:enqueue("command:"', 1, true) and string.find(runtimeSource, 'studioWorker:enqueue("pairing"', 1, true), "pairing and command handling must share one serialized Studio worker")
assert(string.find(runtimeSource, 'studioWorker:enqueue("project-change-notice"', 1, true), "engine change callbacks must defer and coalesce network transport")
assert(string.find(runtimeSource, 'outcomeMessageId("StudioProjectChangeDetected"', 1, true) and string.find(runtimeSource, "retainPending({ message = noticeMessage", 1, true), "a transient dirty-notice transport failure must retain and retry the exact notice identity")
assert(string.find(identityRegistrySource, "function IdentityRegistry:indexProject(cooperate", 1, true) and not string.find(identityRegistrySource, ":GetDescendants(", 1, true), "identity bootstrap must use one cooperative traversal with no mutation-time whole-project fallback")
assert(string.find(evidenceCollectorSource, "function StudioEvidenceCollector:attestation(projection: any, cooperate", 1, true), "capability reflection must yield cooperatively between bounded reads")
assert(string.find(runtimeSource, 'state("INVALID PLAY DATA"', 1, true) and string.find(runtimeSource, "RECOVERY PAIRING", 1, true), "the connector must expose explicit invalid-receipt recovery instead of deadlocking pairing")
assert(not string.find(runtimeExecutorSource, "Instance.new(\"Script\")", 1, true) and not string.find(runtimeExecutorSource, "checkpoint", 1, true), "runtime observation must not inject a runner Script or use log checkpoints")
assert(string.find(directObserverSource, "resolveTarget", 1, true) and string.find(directObserverSource, "_forgeStableId", 1, true), "Play targets must bind a Forge identity rather than a display path")
assert(string.find(directObserverSource, '"unavailable"', 1, true), "non-Forge Play identities must fail as unavailable rather than invented absence")

local unicodeTransport = "ab😀c✓def"
local unicodeFragments = {}
Utf8Transport.each(unicodeTransport, 4, function(fragment: string)
	assert(#fragment <= 4 and utf8.len(fragment) ~= nil, "transport fragments must be byte-bounded valid UTF-8")
	table.insert(unicodeFragments, fragment)
end)
assert(table.concat(unicodeFragments) == unicodeTransport, "UTF-8 transport fragmentation must be lossless")
assert(not pcall(function() Utf8Transport.boundaries("\255", 4) end), "invalid UTF-8 must fail before any transport frame is emitted")
local cooperativeUtf8Steps = 0
Utf8Transport.boundaries(string.rep("é", 32), 8, function() cooperativeUtf8Steps += 1 end)
assert(cooperativeUtf8Steps >= 8, "large UTF-8 validation must expose cooperative scheduling points")
local cancelledUtf8, cancellationFailure = pcall(function()
	Utf8Transport.boundaries("valid", 4, function() error("index collection cancelled") end)
end)
assert(not cancelledUtf8 and string.find(tostring(cancellationFailure), "index collection cancelled", 1, true), "cooperative cancellation must not be misclassified as invalid UTF-8")
local deliveredFrames = {}
local completed, failure = StudioSemanticTransport.deliver({ { id = 1 }, { id = 2 }, { id = 3 } }, function(frame: any): (boolean, any?, number?)
	table.insert(deliveredFrames, frame.id)
	if frame.id == 2 then return false, "injected loss", 0 end
	return true, nil, 202
end)
assert(not completed and failure == "injected loss" and #deliveredFrames == 2, "a failed semantic fragment must stop the stream before any later fragment")

local scheduledJobs = {}
local workerOrder = {}
local workerErrors = {}
local workerYields = 0
local serializedWorker: any = nil
serializedWorker = SerializedStudioWorker.new({
	spawn = function(callback: () -> ()) table.insert(scheduledJobs, callback) end,
	yieldBetween = function() workerYields += 1 end,
	onError = function(failure: any, key: string) table.insert(workerErrors, key .. ":" .. tostring(failure)) end,
})
assert(serializedWorker:enqueue("first", function()
	table.insert(workerOrder, "first")
	assert(not serializedWorker:enqueue("first", function() error("duplicate active job ran") end), "an active bridge head must remain de-duplicated")
end), "the first serialized job must be accepted")
assert(not serializedWorker:enqueue("first", function() error("duplicate queued job ran") end), "a queued bridge head must remain de-duplicated")
assert(serializedWorker:enqueue("failure", function() error("injected worker failure") end), "a distinct second job must be queued")
assert(serializedWorker:enqueue("third", function() table.insert(workerOrder, "third") end), "a distinct third job must be queued")
assert(serializedWorker:isBusy() and #scheduledJobs == 1, "one and only one drain coroutine may own queued Studio work")
scheduledJobs[1]()
assert(not serializedWorker:isBusy(), "the worker must become idle after draining")
assert(table.concat(workerOrder, ",") == "first,third", "a failed job must not reorder or strand later work")
assert(#workerErrors == 1 and string.sub(workerErrors[1], 1, 8) == "failure:" and string.find(workerErrors[1], "injected worker failure", 1, true), "worker failures must retain their exact job key")
assert(workerYields == 2, "the worker must yield between each ordered job")

local closedJobs = {}
local closeRan = false
local closedWorker = SerializedStudioWorker.new({ spawn = function(callback: () -> ()) table.insert(closedJobs, callback) end, yieldBetween = function() end })
closedWorker:enqueue("active", function() closeRan = true end)
closedWorker:enqueue("queued", function() closeRan = true end)
closedWorker:close()
closedJobs[1]()
assert(not closeRan and not closedWorker:isBusy(), "closing must discard work that has not begun")

for _, vector in ipairs(Generated.vectors) do
	assert(Generated.canonicalValueMaterial(vector.value) == vector.material, vector.name .. " must retain shared canonical value material")
end
for _, vector in ipairs(Generated.projectIndexVectors) do
	assert(StudioProjectIndexCanonical.material(vector.value) == vector.material, vector.name .. " must retain shared tagged project-index material")
end
local creatorMutationBinding = {
	sessionId = "creator_session_binding_fixture",
	changeSetHash = string.rep("a", 64),
	approvalHash = string.rep("b", 64),
	revisionHash = string.rep("c", 64),
	buildHash = string.rep("d", 64),
	dashboardReviewHash = string.rep("e", 64),
}
assert(Generated.matchesStudioCreatorMutationBinding(creatorMutationBinding, creatorMutationBinding), "the generated creator mutation binding matcher must accept the backend schema")
local rejectedRevisionAliasBinding = table.clone(creatorMutationBinding)
rejectedRevisionAliasBinding.revisionHash = nil
rejectedRevisionAliasBinding.projectRevisionHash = string.rep("c", 64)
assert(not Generated.matchesStudioCreatorMutationBinding(rejectedRevisionAliasBinding, creatorMutationBinding), "projectRevisionHash must not be accepted as a creator evidence binding alias")
assert(StudioProjectIndexCanonical.material(-0) ~= StudioProjectIndexCanonical.material(0), "project index material must retain binary64 negative zero")
local markedEmptyObject = StudioProjectIndexCanonical.object({})
assert(StudioProjectIndexCanonical.material(markedEmptyObject) ~= StudioProjectIndexCanonical.material({}), "empty objects must not collapse into empty arrays")
assert(StudioProjectIndexCanonical.objectMaterialLength({}) == #StudioProjectIndexCanonical.material(markedEmptyObject), "empty object material sizing must remain exact")
local shardNodes = { { id = "a" }, { id = "b", enabled = false } }
local taggedNodeBytes = 0
for _, node in ipairs(shardNodes) do taggedNodeBytes += StudioProjectIndexCanonical.taggedMaterialLength("item", #StudioProjectIndexCanonical.material(node)) end
local measuredShardBytes = StudioProjectIndexCanonical.objectMaterialLength({
	root = #StudioProjectIndexCanonical.material("Workspace"),
	ordinal = #StudioProjectIndexCanonical.material(0),
	nodes = StudioProjectIndexCanonical.arrayMaterialLength(#shardNodes, taggedNodeBytes),
})
assert(measuredShardBytes == #StudioProjectIndexCanonical.material({ root = "Workspace", ordinal = 0, nodes = shardNodes }), "incremental shard sizing must equal exact canonical material bytes")
assert(StudioProjectIndexCanonical.objectMaterialLength({ root = #StudioProjectIndexCanonical.material("Teams"), ordinal = #StudioProjectIndexCanonical.material(0), nodes = StudioProjectIndexCanonical.arrayMaterialLength(0, 0) }) == #StudioProjectIndexCanonical.material({ root = "Teams", ordinal = 0, nodes = {} }), "empty-root shard sizing must remain exact")
assert(Generated.canonicalValueMaterial({ kind = "boolean", value = false }) ~= Generated.canonicalValueMaterial({ kind = "boolean", value = true }), "false must not collapse into omitted evidence")
assert(Generated.canonicalValueMaterial({ kind = "number_f32", value = -0 }) ~= Generated.canonicalValueMaterial({ kind = "number_f32", value = 0 }), "negative zero must retain its float bit pattern")
assert(Generated.canonicalValueMaterial({ kind = "nil", expectedCodec = "physical_properties" }) ~= Generated.canonicalValueMaterial({ kind = "physical_properties", density = 0.7, friction = 0.3, elasticity = 0.5, frictionWeight = 1, elasticityWeight = 1, acousticAbsorption = 0.3 }), "explicit nil must not collapse into a present datatype value")
assert(Generated.canonicalValueMaterial({ kind = "nil", expectedCodec = "physical_properties" }) ~= Generated.canonicalValueMaterial({ kind = "nil", expectedCodec = "boolean" }), "generic nil material must bind the exact expected codec")
assert(not pcall(function() Generated.canonicalValue({ kind = "nil", expectedCodec = "instance_ref" }) end), "generic nil must reject the class-constrained instance-reference codec")
local nilPhysicalProperty = Generated.propertyMetadata("Part", "CustomPhysicalProperties")
assert(nilPhysicalProperty ~= nil and nilPhysicalProperty.declaringClass == "BasePart" and nilPhysicalProperty.codec == "physical_properties" and nilPhysicalProperty.nullable == true, "inherited nullable metadata must be generated on the exact physical-properties capability")
local nilPhysical = Generated.fromStudio(nilPhysicalProperty.codec, nil, nil, nilPhysicalProperty)
assert(nilPhysical.kind == "nil" and nilPhysical.expectedCodec == nilPhysicalProperty.codec, "nullable direct readback must bind engine nil to its exact manifest codec without datatype field access")
assert(Generated.validateValue(nilPhysicalProperty.codec, nilPhysical, nilPhysicalProperty).kind == "nil", "nullable direct readback must remain a valid property value")
assert(Generated.toStudio(nilPhysicalProperty.codec, nilPhysical, nilPhysicalProperty) == nil, "nullable direct write materialization must round-trip nil")
assert(not pcall(function() Generated.validateValue(nilPhysicalProperty.codec, { kind = "nil", expectedCodec = "boolean" }, nilPhysicalProperty) end), "a nullable property must reject a generic nil bound to another codec")
local collisionGroupProperty = Generated.propertyMetadata("Part", "CollisionGroup")
assert(collisionGroupProperty.minimumUtf8Bytes == 1 and collisionGroupProperty.maximumUtf8Bytes == 100, "CollisionGroup must retain its manifest-bound nonempty UTF-8 domain")
assert(Generated.validateValue(collisionGroupProperty.codec, { kind = "string_utf8", value = "Default" }, collisionGroupProperty).value == "Default", "a nonempty CollisionGroup must remain valid")
assert(not pcall(function() Generated.validateValue(collisionGroupProperty.codec, { kind = "string_utf8", value = "" }, collisionGroupProperty) end), "an empty CollisionGroup must fail the generated minimum UTF-8 bound")
local byteBoundStringProperty = { codec = "string_utf8", minimumUtf8Bytes = 3, maximumUtf8Bytes = 4 }
assert(not pcall(function() Generated.validateValue("string_utf8", { kind = "string_utf8", value = "é" }, byteBoundStringProperty) end), "generated text minima must count UTF-8 bytes rather than code points")
assert(Generated.validateValue("string_utf8", { kind = "string_utf8", value = "éx" }, byteBoundStringProperty).value == "éx", "generated text minima must accept an exact UTF-8 byte-bound value")
assert(not pcall(function() Generated.fromStudio("instance_ref", nil, nil, nil) end), "instance-reference readback without manifest metadata must reject before dereferencing the property")
for className, class in pairs(Generated.classes) do
	for _, property in ipairs(class.propertyList) do
		if property.codec == "instance_ref" then
			local referenceNil = Generated.fromStudio(property.codec, nil, nil, property)
			assert(referenceNil.kind == "instance_ref" and referenceNil.state == "nil", className .. "." .. property.name .. " must retain the typed instance-reference nil domain")
		elseif property.nullable == true then
			local observedNil = Generated.fromStudio(property.codec, nil, nil, property)
			assert(observedNil.kind == "nil", className .. "." .. property.name .. " must round-trip its declared nullable domain")
			assert(Generated.toStudio(property.codec, observedNil, property) == nil, className .. "." .. property.name .. " must materialize a declared nil without an engine codec")
		else
			local accepted, failure = pcall(function() return Generated.fromStudio(property.codec, nil, nil, property) end)
			assert(not accepted and string.find(tostring(failure), "nil Studio value is not declared for property", 1, true), className .. "." .. property.name .. " must reject nil before any codec field access")
		end
	end
end
local fromStudioStart = assert(string.find(generatedEvidenceSource, "function Generated.fromStudio", 1, true))
local nilGuard = string.find(generatedEvidenceSource, 'if value == nil then', fromStudioStart, true)
local physicalDereference = string.find(generatedEvidenceSource, "value.Density", 1, true)
assert(nilGuard ~= nil and physicalDereference ~= nil and nilGuard < physicalDereference, "generated nullable dispatch must guard nil before every datatype field dereference")
assert(string.find(projectIndexSource, "Generated.canonicalProjectAttribute", 1, true), "project indexing must use the complete compound-attribute observer rather than mutation-only primitive codecs")
assert(string.find(projectIndexSource, "Generated.projectPropertyMetadata(instance.ClassName)", 1, true) and not string.find(projectIndexSource, "ipairs(metadata.properties)", 1, true), "project indexing must consume the generated ordered property rows rather than treating the keyed mutation dispatch as a sequence")
local projectPartProperties = Generated.projectPropertyMetadata("Part")
local sawAnchoredProjectProperty = false
for index, property in ipairs(projectPartProperties) do
	assert(index == 1 or projectPartProperties[index - 1].name < property.name, "project property metadata must be canonical and strictly ordered")
	assert(Generated.propertyMetadata("Part", property.name) == property, "ordered project property rows and keyed mutation dispatch must share the exact manifest row")
	if property.name == "Anchored" then sawAnchoredProjectProperty = true end
end
assert(#projectPartProperties > 0 and sawAnchoredProjectProperty, "a manifest-supported Part must produce non-empty project-index property coverage")
local orderedMutationProperties = Generated.sortedMutationPropertyNames("Part", {
	Transparency = { kind = "number_f32", value = 0 },
	Anchored = { kind = "boolean", value = true },
})
assert(#orderedMutationProperties == 2 and orderedMutationProperties[1] == "Anchored" and orderedMutationProperties[2] == "Transparency", "generated mutation property ordering must be canonical regardless of input-map construction order")
assert(not pcall(function() Generated.sortedMutationPropertyNames("Part", { NotInManifest = { kind = "boolean", value = true } }) end), "the canonical mutation property orderer must reject an unmanifested field")
local function acceptsStudioObjectIdentity(value: any): boolean
	return pcall(function() Generated.studioObjectIdentity(value) end)
end
assert(acceptsStudioObjectIdentity({ kind = "forge_attribute", stableId = "stable-\226\156\147" }), "valid UTF-8 identity tokens must be accepted")
assert(acceptsStudioObjectIdentity({ kind = "studio_ephemeral", connectorEpoch = "epoch-\226\156\147", opaqueHash = string.rep("a", 64) }), "valid epoch-bound opaque identities must be accepted")
assert(not acceptsStudioObjectIdentity({ kind = "forge_attribute", stableId = "contains space" }), "identity whitespace must be rejected exactly at the generated boundary")
assert(not acceptsStudioObjectIdentity({ kind = "forge_attribute", stableId = string.rep("a", 513) }), "identity byte bounds must be enforced at the generated boundary")
assert(not acceptsStudioObjectIdentity({ kind = "forge_attribute", stableId = "\255" }), "invalid UTF-8 identity data must be rejected at the generated boundary")
assert(not acceptsStudioObjectIdentity({ kind = "rojo_sourcemap", authorityMapHash = string.rep("a", 64), sourcemapHash = string.rep("b", 64), mappingId = "\194\160" }), "Unicode whitespace in a Rojo mapping identity must be rejected")
assert(#Generated.projectPropertyMetadata("Folder") == 0 and #Generated.projectPropertyMetadata("Camera") == 0, "classes with no covered properties and unsupported classes must expose an explicit empty project-property sequence")
for _, class in ipairs(Generated.manifest.classes) do
	local indexedProperties = Generated.projectPropertyMetadata(class.name)
	assert(#indexedProperties == #class.properties, "every manifest property must have exactly one project-index row")
	for index, property in ipairs(indexedProperties) do
		assert(Generated.propertyMetadata(class.name, property.name) == property, "project-index rows must remain the exact keyed manifest rows")
		assert(index == 1 or indexedProperties[index - 1].name < property.name, "every manifest class must expose strictly ordered project-index rows")
	end
end

local scriptSourceHash = string.rep("f", 64)
local scriptRequirements = Generated.compileMutationRequirements({
	kind = "CreatorChangeSet",
	id = "creator_change_set_script_blob",
	operations = {
		{
			id = "create_script",
			kind = "create",
			target = { kind = "instance", identity = { kind = "forge_attribute", stableId = "created_script" }, path = "ServerScriptService/Created", className = "Script" },
			parent = { kind = "engine_container", path = "ServerScriptService", className = "ServerScriptService" },
			className = "Script",
			name = "Created",
			properties = {},
			attributes = {},
			sourceBlob = { manifestId = "creator_source_write_blob_manifest_fixture", manifestHash = string.rep("e", 64), sourceHash = scriptSourceHash, utf8Bytes = 13 },
		},
	},
}, nil, {
	create_script = { kind = "forge_attribute", stableId = "captured-server-script-service" },
})
local foundScriptSourceRequirement = false
local foundServerParentIdentity = false
for _, requirement in ipairs(scriptRequirements) do
	if requirement.kind == "source_hash" then
		assert(requirement.expected == scriptSourceHash, "created script source proof must use the immutable source blob hash")
		foundScriptSourceRequirement = true
	end
	if requirement.kind == "structure" and requirement.expected.parentIdentity and requirement.expected.parentIdentity.stableId == "captured-server-script-service" then
		foundServerParentIdentity = true
	end
end
assert(foundScriptSourceRequirement, "created script mutation projection must contain a source-hash obligation")
assert(foundServerParentIdentity, "a ServerScriptService create must retain the exact captured engine-parent identity")

-- The project index deliberately retains opaque engine objects. They must not
-- block an otherwise authorable change, nor acquire a writable-fact surface
-- merely because they sit below a deleted authorable parent.
local opaqueIndexCapture = {
	kind = "StudioProjectIndexCapture",
	indexManifest = { manifestHash = Generated.manifestHash, hash = string.rep("a", 64) },
	revision = { manifestHash = Generated.manifestHash, indexManifestHash = string.rep("a", 64), projectionHash = string.rep("b", 64) },
	projection = { hash = string.rep("b", 64) },
	shards = {
		{
			kind = "StudioProjectEvidenceShard",
				nodes = {
					{ identity = { kind = "forge_attribute", stableId = "authorable_folder" }, displayPath = "Workspace/Authorable", name = "Authorable", className = "Folder", attributes = {} },
					{ identity = { kind = "forge_attribute", stableId = "move_to_structural_parent" }, displayPath = "Workspace/MoveToStructuralParent", name = "MoveToStructuralParent", className = "Folder", attributes = {} },
					{ identity = { kind = "studio_ephemeral", connectorEpoch = "connector_epoch_plugin_fixture", opaqueHash = string.rep("c", 64) }, parentIdentity = { kind = "forge_attribute", stableId = "authorable_folder" }, displayPath = "Workspace/Authorable/Camera", name = "Camera", className = "Camera", attributes = {} },
					{ identity = { kind = "studio_ephemeral", connectorEpoch = "connector_epoch_plugin_fixture", opaqueHash = string.rep("d", 64) }, displayPath = "StarterPlayer/StarterPlayerScripts", name = "StarterPlayerScripts", className = "StarterPlayerScripts", engineContainer = { path = "StarterPlayer/StarterPlayerScripts", className = "StarterPlayerScripts" }, attributes = {} },
			},
		},
	},
}
local opaqueDeleteChangeSet = {
	kind = "CreatorChangeSet",
	id = "creator_change_set_opaque_index",
	operations = {
		{
			id = "delete_authorable_folder",
			kind = "delete",
			target = { kind = "instance", identity = { kind = "forge_attribute", stableId = "authorable_folder" }, path = "Workspace/Authorable", className = "Folder" },
		},
	},
}
local opaqueProjectionInputs = Generated.compileMutationProjectionInputsFromIndex(opaqueDeleteChangeSet, opaqueIndexCapture)
assert(#opaqueProjectionInputs.requirements == 2, "a delete must prove structural absence for every indexed descendant")
assert(opaqueProjectionInputs.requirements[1].kind == "structure" and opaqueProjectionInputs.requirements[1].expectedStatus == "absent", "delete descendants must remain structure-only proof obligations")
assert(opaqueProjectionInputs.requirements[2].kind == "structure" and opaqueProjectionInputs.requirements[2].expectedStatus == "absent", "delete roots must retain their structural proof obligation")
assert(opaqueProjectionInputs.allowedProjectDelta == nil, "mutation projections must not carry a second project-delta authority")

-- Existing project-index parents are containment authority, not writable
-- mutation targets. StarterPlayerScripts is intentionally outside the
-- writable manifest, but its exact opaque identity may anchor an approved
-- LocalScript create beneath it.
local indexedContainerProjectionInputs = Generated.compileMutationProjectionInputsFromIndex({
	kind = "CreatorChangeSet",
	id = "creator_change_set_indexed_engine_parent",
	operations = {
		{
			id = "create_client_under_observed_container",
			kind = "create",
			target = { kind = "instance", identity = { kind = "forge_attribute", stableId = "created_client" }, path = "StarterPlayer/StarterPlayerScripts/Client", className = "LocalScript" },
			parent = { kind = "engine_container", path = "StarterPlayer/StarterPlayerScripts", className = "StarterPlayerScripts" },
			className = "LocalScript",
			name = "Client",
			properties = {},
			attributes = {},
			sourceBlob = { manifestId = "creator_source_write_blob_manifest_fixture", manifestHash = string.rep("e", 64), sourceHash = scriptSourceHash, utf8Bytes = 13 },
		},
	},
}, opaqueIndexCapture)
assert(#indexedContainerProjectionInputs.requirements == 2, "an indexed unwriteable parent must permit only the authorable child structure and source obligations")
assert(indexedContainerProjectionInputs.requirements[1].kind == "source_hash" or indexedContainerProjectionInputs.requirements[2].kind == "source_hash", "the indexed-parent create must retain its exact source proof")
local indexedContainerStructure = indexedContainerProjectionInputs.requirements[1].kind == "structure" and indexedContainerProjectionInputs.requirements[1] or indexedContainerProjectionInputs.requirements[2]
assert(indexedContainerStructure.kind == "structure" and indexedContainerStructure.expected.parentIdentity and indexedContainerStructure.expected.parentIdentity.opaqueHash == string.rep("d", 64), "a StarterPlayerScripts engine parent must retain the exact captured identity")
local movedToIndexedContainer = Generated.compileMutationProjectionInputsFromIndex({
	kind = "CreatorChangeSet",
	id = "creator_change_set_move_to_indexed_engine_parent",
	operations = {
		{
			id = "move_folder_under_observed_container",
			kind = "move",
			target = { kind = "instance", identity = { kind = "forge_attribute", stableId = "move_to_structural_parent" }, path = "Workspace/MoveToStructuralParent", className = "Folder" },
			parent = { kind = "instance", identity = { kind = "studio_ephemeral", connectorEpoch = "connector_epoch_plugin_fixture", opaqueHash = string.rep("d", 64) }, path = "StarterPlayer/StarterPlayerScripts", className = "StarterPlayerScripts" },
			name = "MovedUnderStructuralParent",
			properties = {},
			attributes = {},
			removedAttributes = {},
		},
	},
}, opaqueIndexCapture)
assert(#movedToIndexedContainer.requirements == 1 and movedToIndexedContainer.requirements[1].kind == "structure", "an indexed non-authorable parent must remain valid containment authority for move")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({
		kind = "CreatorChangeSet",
		id = "creator_change_set_missing_structural_parent",
		operations = {
			{
				id = "create_under_missing_parent",
				kind = "create",
				target = { kind = "instance", identity = { kind = "forge_attribute", stableId = "missing_parent_child" }, path = "Workspace/Missing/Child", className = "Folder" },
				parent = { kind = "instance", identity = { kind = "studio_ephemeral", connectorEpoch = "connector_epoch_plugin_fixture", opaqueHash = string.rep("9", 64) }, path = "Workspace/Missing", className = "Camera" },
				className = "Folder",
				name = "Child",
				properties = {},
				attributes = {},
			},
		},
	}, opaqueIndexCapture)
end), "structural-parent authority must still require exact identity/path/class membership in the complete index")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({
		kind = "CreatorChangeSet",
		id = "creator_change_set_move_to_missing_structural_parent",
		operations = {
			{
				id = "move_to_missing_parent",
				kind = "move",
				target = { kind = "instance", identity = { kind = "forge_attribute", stableId = "move_to_structural_parent" }, path = "Workspace/MoveToStructuralParent", className = "Folder" },
				parent = { kind = "instance", identity = { kind = "studio_ephemeral", connectorEpoch = "connector_epoch_plugin_fixture", opaqueHash = string.rep("8", 64) }, path = "Workspace/Missing", className = "Camera" },
				name = "Moved",
				properties = {},
				attributes = {},
				removedAttributes = {},
			},
		},
	}, opaqueIndexCapture)
end), "moves must reject a structural parent that is absent from the complete index")
assert(not pcall(function()
	Generated.compileMutationRequirements({
		kind = "CreatorChangeSet",
		id = "creator_change_set_opaque_target",
		operations = {
			{ id = "update_opaque_camera", kind = "update", target = { kind = "instance", identity = { kind = "forge_attribute", stableId = "opaque_camera" }, path = "Workspace/Camera", className = "Camera" } },
		},
	})
end), "a planner-emitted mutation target outside the manifest must be rejected before approval")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({
		kind = "CreatorChangeSet",
		id = "creator_change_set_delete_opaque_root",
		operations = {
			{
				id = "delete_opaque_camera_root",
				kind = "delete",
				target = { kind = "instance", identity = { kind = "studio_ephemeral", connectorEpoch = "connector_epoch_plugin_fixture", opaqueHash = string.rep("c", 64) }, path = "Workspace/Authorable/Camera", className = "Camera" },
			},
		},
	}, opaqueIndexCapture)
end), "an unmanifest index node may be structural delete evidence but may not become the delete root")

-- Collision authority is the exact selected parent identity plus the captured
-- Instance.Name. Duplicate display paths are legal diagnostics, never lookup
-- keys: a child below the other duplicate parent must not block this create.
local collisionIndexCapture = {
	kind = "StudioProjectIndexCapture",
	indexManifest = { manifestHash = Generated.manifestHash, hash = string.rep("a", 64) },
	revision = { manifestHash = Generated.manifestHash, indexManifestHash = string.rep("a", 64), projectionHash = string.rep("b", 64) },
	projection = { hash = string.rep("b", 64) },
	shards = {
		{ kind = "StudioProjectEvidenceShard", nodes = {
			{ identity = { kind = "forge_attribute", stableId = "collision_workspace" }, displayPath = "Workspace", name = "Workspace", className = "Workspace", engineContainer = { path = "Workspace", className = "Workspace" }, attributes = {} },
			{ identity = { kind = "forge_attribute", stableId = "collision_parent_a" }, parentIdentity = { kind = "forge_attribute", stableId = "collision_workspace" }, displayPath = "Workspace/Duplicate", name = "Duplicate", className = "Folder", attributes = {} },
			{ identity = { kind = "forge_attribute", stableId = "collision_parent_b" }, parentIdentity = { kind = "forge_attribute", stableId = "collision_workspace" }, displayPath = "Workspace/Duplicate", name = "Duplicate", className = "Folder", attributes = {} },
			{ identity = { kind = "forge_attribute", stableId = "collision_other_parent_child" }, parentIdentity = { kind = "forge_attribute", stableId = "collision_parent_b" }, displayPath = "Workspace/Duplicate/Snap", name = "Snap", className = "Folder", attributes = {} },
			{ identity = { kind = "studio_ephemeral", connectorEpoch = "connector_epoch_plugin_fixture", opaqueHash = string.rep("7", 64) }, parentIdentity = { kind = "forge_attribute", stableId = "collision_workspace" }, displayPath = "Workspace/OpaqueParent", name = "OpaqueParent", className = "Camera", attributes = {} },
		} },
	},
}
local function collisionCreate(id: string, parent: any, name: string): any
	return {
		kind = "CreatorChangeSet", id = id, operations = {
			{
				id = id .. "_operation", kind = "create",
				target = { kind = "instance", identity = { kind = "forge_attribute", stableId = id .. "_target" }, path = parent.path .. "/" .. name, className = "Folder" },
				parent = parent, className = "Folder", name = name, properties = {}, attributes = {},
			},
		},
	}
end
local duplicateParentA = { kind = "instance", identity = { kind = "forge_attribute", stableId = "collision_parent_a" }, path = "Workspace/Duplicate", className = "Folder" }
assert(pcall(function()
	Generated.compileMutationProjectionInputsFromIndex(collisionCreate("collision_other_parent_accept", duplicateParentA, "Snap"), collisionIndexCapture)
end), "a child with the same display path under a different parent identity must not collide")
local opaqueStructuralParent = { kind = "instance", identity = { kind = "studio_ephemeral", connectorEpoch = "connector_epoch_plugin_fixture", opaqueHash = string.rep("7", 64) }, path = "Workspace/OpaqueParent", className = "Camera" }
assert(pcall(function()
	Generated.compileMutationProjectionInputsFromIndex(collisionCreate("collision_opaque_parent_accept", opaqueStructuralParent, "Snap"), collisionIndexCapture)
end), "an opaque indexed parent remains exact structural authority without becoming a writable target")
table.insert(collisionIndexCapture.shards[1].nodes, { identity = { kind = "forge_attribute", stableId = "collision_selected_parent_child" }, parentIdentity = { kind = "forge_attribute", stableId = "collision_parent_a" }, displayPath = "Workspace/Duplicate/Snap", name = "Snap", className = "Folder", attributes = {} })
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex(collisionCreate("collision_selected_parent_reject", duplicateParentA, "Snap"), collisionIndexCapture)
end), "a same-name child under the selected exact parent must collide")
local workspaceParent = { kind = "engine_container", path = "Workspace", className = "Workspace" }
assert(pcall(function()
	Generated.compileMutationProjectionInputsFromIndex(collisionCreate("collision_engine_parent_accept", workspaceParent, "EngineFree"), collisionIndexCapture)
end), "a declared engine container must resolve through its captured identity")
table.insert(collisionIndexCapture.shards[1].nodes, { identity = { kind = "forge_attribute", stableId = "collision_engine_child" }, parentIdentity = { kind = "forge_attribute", stableId = "collision_workspace" }, displayPath = "Workspace/EngineTaken", name = "EngineTaken", className = "Folder", attributes = {} })
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex(collisionCreate("collision_engine_parent_reject", workspaceParent, "EngineTaken"), collisionIndexCapture)
end), "an engine-container create must collide only with the captured child under that exact container")

-- The generated compiler validates hierarchy as one proposed transaction, not
-- as independent operations. These fixtures deliberately use initial opaque
-- identities, because enrollment must not rewrite the pre-Apply topology used
-- to reject cycles and deleted-subtree dependencies.
do
local topologyEpoch = "connector_epoch_virtual_topology"
local function topologyOpaque(seed: string): any
	return { kind = "studio_ephemeral", connectorEpoch = topologyEpoch, opaqueHash = string.rep(seed, 64) }
end
local topologyWorkspaceIdentity = { kind = "forge_attribute", stableId = "topology_workspace" }
local topologyA, topologyB, topologyC = topologyOpaque("1"), topologyOpaque("2"), topologyOpaque("3")
local function topologyTarget(identity: any, path: string, className: string): any
	return { kind = "instance", identity = identity, path = path, className = className }
end
local function topologyCapture(extraNodes: {any}?): any
	local nodes = {
		{ identity = topologyWorkspaceIdentity, displayPath = "Workspace", name = "Workspace", className = "Workspace", engineContainer = { path = "Workspace", className = "Workspace" }, attributes = {} },
		{ identity = topologyA, parentIdentity = topologyWorkspaceIdentity, displayPath = "Workspace/A", name = "A", className = "Folder", attributes = {} },
		{ identity = topologyB, parentIdentity = topologyWorkspaceIdentity, displayPath = "Workspace/B", name = "B", className = "Folder", attributes = {} },
		{ identity = topologyC, parentIdentity = topologyWorkspaceIdentity, displayPath = "Workspace/C", name = "C", className = "Folder", attributes = {} },
	}
	for _, node in ipairs(extraNodes or {}) do table.insert(nodes, node) end
	return {
		kind = "StudioProjectIndexCapture",
		indexManifest = { manifestHash = Generated.manifestHash, hash = string.rep("d", 64) },
		revision = { manifestHash = Generated.manifestHash, indexManifestHash = string.rep("d", 64), projectionHash = string.rep("e", 64) },
		projection = { hash = string.rep("e", 64) },
		shards = { { kind = "StudioProjectEvidenceShard", nodes = nodes } },
	}
end
local function moveTopologyOperation(id: string, target: any, parent: any, name: string): any
	return { id = id, kind = "move", target = target, parent = parent, name = name, properties = {}, attributes = {}, removedAttributes = {} }
end
local topologyAPath, topologyBPath, topologyCPath = topologyTarget(topologyA, "Workspace/A", "Folder"), topologyTarget(topologyB, "Workspace/B", "Folder"), topologyTarget(topologyC, "Workspace/C", "Folder")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_two_node_cycle", operations = {
		moveTopologyOperation("move_a_under_b", topologyAPath, topologyBPath, "A"),
		moveTopologyOperation("move_b_under_a", topologyBPath, topologyAPath, "B"),
	} }, topologyCapture())
end), "two-node virtual move cycles must fail before recording")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_three_node_cycle", operations = {
		moveTopologyOperation("move_a_under_b", topologyAPath, topologyBPath, "A"),
		moveTopologyOperation("move_b_under_c", topologyBPath, topologyCPath, "B"),
		moveTopologyOperation("move_c_under_a", topologyCPath, topologyAPath, "C"),
	} }, topologyCapture())
end), "three-node virtual move cycles must fail before recording")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_final_sibling_collision", operations = {
		{ id = "create_left", kind = "create", target = topologyTarget({ kind = "forge_attribute", stableId = "virtual_left" }, "Workspace/Shared", "Folder"), parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, className = "Folder", name = "Shared", properties = {}, attributes = {} },
		{ id = "create_right", kind = "create", target = topologyTarget({ kind = "forge_attribute", stableId = "virtual_right" }, "Workspace/Shared", "Folder"), parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, className = "Folder", name = "Shared", properties = {}, attributes = {} },
	} }, topologyCapture())
end), "two individually-free creates that collide in final sibling topology must fail before recording")
local topologyChild = topologyOpaque("4")
local topologyDeleteCapture = topologyCapture({ { identity = topologyChild, parentIdentity = topologyA, displayPath = "Workspace/A/Child", name = "Child", className = "Folder", attributes = {} } })
local topologyChildPath = topologyTarget(topologyChild, "Workspace/A/Child", "Folder")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_update_deleted_descendant", operations = {
		{ id = "delete_a", kind = "delete", target = topologyAPath },
		{ id = "update_child", kind = "update", target = topologyChildPath, properties = {}, attributes = {}, removedAttributes = {} },
	} }, topologyDeleteCapture)
end), "operations on a deleted subtree must fail before recording")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_create_under_deleted_parent", operations = {
		{ id = "delete_a", kind = "delete", target = topologyAPath },
		{ id = "create_child", kind = "create", target = topologyTarget({ kind = "forge_attribute", stableId = "virtual_deleted_child" }, "Workspace/A/NewChild", "Folder"), parent = topologyAPath, className = "Folder", name = "NewChild", properties = {}, attributes = {} },
	} }, topologyDeleteCapture)
end), "creates below a deleted parent must fail before recording")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_nested_delete", operations = {
		{ id = "delete_a", kind = "delete", target = topologyAPath },
		{ id = "delete_child", kind = "delete", target = topologyChildPath },
	} }, topologyDeleteCapture)
end), "nested delete dependencies must fail before recording")
assert(not pcall(function()
	Generated.compileMutationTransactionTopologyFromIndex({ kind = "CreatorChangeSet", id = "virtual_noncanonical_independent_order", operations = {
		{ id = "update_b", kind = "update", target = topologyBPath, properties = {}, attributes = {}, removedAttributes = {} },
		{ id = "update_a", kind = "update", target = topologyAPath, properties = {}, attributes = {}, removedAttributes = {} },
	} }, topologyCapture())
end), "a sealed operation list must reject a noncanonical transport order rather than silently reorder approved bytes")

-- One enrollment map must flow through every post-state location. The writer
-- still receives the original opaque identities, while the projection binds
-- the post-state target, parent, and instance reference to their durable IDs.
local topologyWeld, topologyReference, topologyParent = topologyOpaque("5"), topologyOpaque("6"), topologyOpaque("7")
local topologyEnrollmentCapture = topologyCapture({
	{ identity = topologyWeld, parentIdentity = topologyWorkspaceIdentity, displayPath = "Workspace/Weld", name = "Weld", className = "WeldConstraint", attributes = {} },
	{ identity = topologyReference, parentIdentity = topologyParent, displayPath = "Workspace/Parent/Reference", name = "Reference", className = "Part", attributes = {} },
	{ identity = topologyParent, parentIdentity = topologyWorkspaceIdentity, displayPath = "Workspace/Parent", name = "Parent", className = "Folder", attributes = {} },
})
local enrolledProjectionInputs = Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_enrollment_closure", operations = {
	-- This is the host's canonical safe order: every original-path operation
	-- completes before the parent move. The created child nevertheless carries
	-- its final display path, and the unchanged reference inherits that final
	-- path through the moved parent.
	{ id = "create_under_moved_parent", kind = "create", target = topologyTarget({ kind = "forge_attribute", stableId = "virtual_child" }, "Workspace/ParentMoved/Child", "Folder"), parent = topologyTarget(topologyParent, "Workspace/Parent", "Folder"), className = "Folder", name = "Child", properties = {}, attributes = {} },
	{ id = "enroll_reference", kind = "update", target = topologyTarget(topologyReference, "Workspace/Parent/Reference", "Part"), enrollment = { identity = topologyReference, stableId = "virtual_reference" }, properties = {}, attributes = {}, removedAttributes = {} },
	{ id = "enroll_weld", kind = "update", target = topologyTarget(topologyWeld, "Workspace/Weld", "WeldConstraint"), enrollment = { identity = topologyWeld, stableId = "virtual_weld" }, properties = { Part0 = { kind = "instance_ref", state = "reference", identity = topologyReference, path = "Workspace/Parent/Reference", className = "Part", expectedClass = "BasePart" } }, attributes = {}, removedAttributes = {} },
	{ id = "move_and_enroll_parent", kind = "move", target = topologyTarget(topologyParent, "Workspace/Parent", "Folder"), enrollment = { identity = topologyParent, stableId = "virtual_parent" }, parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, name = "ParentMoved", properties = {}, attributes = {}, removedAttributes = {} },
} }, topologyEnrollmentCapture)
local sawEnrolledTarget, sawEnrolledParent, sawEnrolledReference, sawFinalChild = false, false, false, false
for _, requirement in ipairs(enrolledProjectionInputs.requirements) do
	if requirement.target.identity.kind == "forge_attribute" and requirement.target.identity.stableId == "virtual_weld" then sawEnrolledTarget = true end
	if requirement.kind == "structure" and requirement.expected.parentIdentity and requirement.expected.parentIdentity.kind == "forge_attribute" and requirement.expected.parentIdentity.stableId == "virtual_parent" and requirement.expected.parentPath == "Workspace/ParentMoved" then sawEnrolledParent = true end
	if requirement.kind == "structure" and requirement.target.identity.kind == "forge_attribute" and requirement.target.identity.stableId == "virtual_child" and requirement.target.path == "Workspace/ParentMoved/Child" then sawFinalChild = true end
	if requirement.kind == "property" and requirement.propertyName == "Part0" and requirement.expected.identity and requirement.expected.identity.kind == "forge_attribute" and requirement.expected.identity.stableId == "virtual_reference" and requirement.expected.path == "Workspace/ParentMoved/Reference" then sawEnrolledReference = true end
end
assert(sawEnrolledTarget and sawEnrolledParent and sawEnrolledReference and sawFinalChild, "transaction-wide enrollment must canonicalize final targets, parents, descendant paths, and instance references")
assert(not pcall(function()
	Generated.compileMutationTransactionTopologyFromIndex({ kind = "CreatorChangeSet", id = "virtual_moved_parent_wrong_order", operations = {
		{ id = "move_and_enroll_parent", kind = "move", target = topologyTarget(topologyParent, "Workspace/Parent", "Folder"), enrollment = { identity = topologyParent, stableId = "virtual_parent" }, parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, name = "ParentMoved", properties = {}, attributes = {}, removedAttributes = {} },
		{ id = "create_under_moved_parent", kind = "create", target = topologyTarget({ kind = "forge_attribute", stableId = "virtual_child" }, "Workspace/ParentMoved/Child", "Folder"), parent = topologyTarget(topologyParent, "Workspace/Parent", "Folder"), className = "Folder", name = "Child", properties = {}, attributes = {} },
	} }, topologyEnrollmentCapture)
end), "a create below a moved parent must precede the exact-parent move in the approved operation sequence")

-- The plugin consumes this generated graph directly, so cover the three
-- previously divergent virtual cases here rather than relying on an
-- operation-by-operation live-registry approximation.
local createdParentIdentity = { kind = "forge_attribute", stableId = "virtual_created_parent" }
local createdChildIdentity = { kind = "forge_attribute", stableId = "virtual_created_child" }
local createdParentTarget = topologyTarget(createdParentIdentity, "Workspace/CreatedParent", "Folder")
local createdChildTarget = topologyTarget(createdChildIdentity, "Workspace/CreatedParent/CreatedChild", "Folder")
local nestedCreateChangeSet = { kind = "CreatorChangeSet", id = "virtual_created_parent_child", operations = {
	{ id = "create_parent", kind = "create", target = createdParentTarget, parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, className = "Folder", name = "CreatedParent", properties = {}, attributes = {} },
	{ id = "create_child", kind = "create", target = createdChildTarget, parent = createdParentTarget, className = "Folder", name = "CreatedChild", properties = {}, attributes = {} },
} }
local nestedTopology = Generated.compileMutationTransactionTopologyFromIndex(nestedCreateChangeSet, topologyCapture())
assert(nestedTopology.canonicalOperationIds[1] == "create_parent" and nestedTopology.canonicalOperationIds[2] == "create_child", "compiled topology must materialize a created parent before its created child")
assert(nestedTopology.postTargets["forge_attribute:virtual_created_child"].path == "Workspace/CreatedParent/CreatedChild", "created-child final path must bind to its virtual parent")
assert(pcall(function() Generated.compileMutationProjectionInputsFromIndex(nestedCreateChangeSet, topologyCapture()) end), "proof compilation must accept the same nested-create topology exposed to StudioAuthoring")
local preparedNestedTopology = StudioAuthoring.prepareTransactionTopologyForTest(nestedCreateChangeSet, topologyCapture())
assert(preparedNestedTopology.operations[1].id == "create_parent" and preparedNestedTopology.operations[2].id == "create_child", "StudioAuthoring Prepare must retain the generated canonical graph order for nested creates")

local createdPartIdentity = { kind = "forge_attribute", stableId = "virtual_created_part" }
local createdPartTarget = topologyTarget(createdPartIdentity, "Workspace/CreatedPart", "Part")
local createdReferenceChangeSet = { kind = "CreatorChangeSet", id = "virtual_created_reference", operations = {
	{ id = "create_part", kind = "create", target = createdPartTarget, parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, className = "Part", name = "CreatedPart", properties = {}, attributes = {} },
	{ id = "update_weld_reference", kind = "update", target = topologyTarget(topologyWeld, "Workspace/Weld", "WeldConstraint"), properties = { Part0 = { kind = "instance_ref", state = "reference", identity = createdPartIdentity, path = "Workspace/CreatedPart", className = "Part", expectedClass = "BasePart" } }, attributes = {}, removedAttributes = {} },
} }
local createdReferenceTopology = Generated.compileMutationTransactionTopologyFromIndex(createdReferenceChangeSet, topologyEnrollmentCapture)
assert(createdReferenceTopology.canonicalOperationIds[1] == "create_part" and createdReferenceTopology.canonicalOperationIds[2] == "update_weld_reference", "created instance references must depend on their creating operation")
assert(pcall(function() Generated.compileMutationProjectionInputsFromIndex(createdReferenceChangeSet, topologyEnrollmentCapture) end), "proof compilation must accept a property reference to a created instance")

local selfValueIdentity = { kind = "forge_attribute", stableId = "virtual_self_value" }
local selfValueTarget = topologyTarget(selfValueIdentity, "Workspace/SelfValue", "ObjectValue")
local selfReferenceChangeSet = { kind = "CreatorChangeSet", id = "virtual_self_reference", operations = {
	{ id = "create_self_value", kind = "create", target = selfValueTarget, parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, className = "ObjectValue", name = "SelfValue", properties = { Value = { kind = "instance_ref", state = "reference", identity = selfValueIdentity, path = "Workspace/SelfValue", className = "ObjectValue", expectedClass = "Instance" } }, attributes = {} },
} }
assert(pcall(function() Generated.compileMutationProjectionInputsFromIndex(selfReferenceChangeSet, topologyCapture()) end), "a created object may carry an exact self reference inside the same transaction")

-- Every create is allocated as a detached transaction-local handle before
-- recording. Mutual references are therefore a closed graph, not an
-- artificial topological cycle that would force weaker identity binding.
local mutualAIdentity = { kind = "forge_attribute", stableId = "virtual_mutual_a" }
local mutualBIdentity = { kind = "forge_attribute", stableId = "virtual_mutual_b" }
local mutualATarget = topologyTarget(mutualAIdentity, "Workspace/MutualA", "ObjectValue")
local mutualBTarget = topologyTarget(mutualBIdentity, "Workspace/MutualB", "ObjectValue")
local mutualReferenceChangeSet = { kind = "CreatorChangeSet", id = "virtual_mutual_created_references", operations = {
	{ id = "create_mutual_a", kind = "create", target = mutualATarget, parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, className = "ObjectValue", name = "MutualA", properties = { Value = { kind = "instance_ref", state = "reference", identity = mutualBIdentity, path = "Workspace/MutualB", className = "ObjectValue", expectedClass = "Instance" } }, attributes = {} },
	{ id = "create_mutual_b", kind = "create", target = mutualBTarget, parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, className = "ObjectValue", name = "MutualB", properties = { Value = { kind = "instance_ref", state = "reference", identity = mutualAIdentity, path = "Workspace/MutualA", className = "ObjectValue", expectedClass = "Instance" } }, attributes = {} },
} }
local mutualReferenceTopology = Generated.compileMutationTransactionTopologyFromIndex(mutualReferenceChangeSet, topologyCapture())
assert(mutualReferenceTopology.canonicalOperationIds[1] == "create_mutual_a" and mutualReferenceTopology.canonicalOperationIds[2] == "create_mutual_b", "mutual created references must retain their sealed canonical order without a fabricated dependency cycle")
assert(pcall(function() Generated.compileMutationProjectionInputsFromIndex(mutualReferenceChangeSet, topologyCapture()) end), "projection compilation must accept mutually referencing approved creates")
local preparedMutualTopology = StudioAuthoring.prepareTransactionTopologyForTest(mutualReferenceChangeSet, topologyCapture())
assert(preparedMutualTopology.operations[1].id == "create_mutual_a" and preparedMutualTopology.operations[2].id == "create_mutual_b", "StudioAuthoring Prepare must consume the same mutual-created-reference topology as the projection compiler")

-- Delete closure is final-state based. An existing child may be extracted
-- before its former parent is deleted, and new work may be placed below that
-- extracted child. The sealed order must make the create complete first, the
-- extraction second, and the delete last; placing anything final-under the
-- deleted root remains prohibited.
local topologyDeleteRoot, topologyExtracted = topologyOpaque("a"), topologyOpaque("b")
local topologyExtractionCapture = topologyCapture({
	{ identity = topologyDeleteRoot, parentIdentity = topologyWorkspaceIdentity, displayPath = "Workspace/DeleteRoot", name = "DeleteRoot", className = "Folder", attributes = {} },
	{ identity = topologyExtracted, parentIdentity = topologyDeleteRoot, displayPath = "Workspace/DeleteRoot/Extracted", name = "Extracted", className = "Folder", attributes = {} },
})
local topologyDeleteRootTarget = topologyTarget(topologyDeleteRoot, "Workspace/DeleteRoot", "Folder")
local topologyExtractedTarget = topologyTarget(topologyExtracted, "Workspace/DeleteRoot/Extracted", "Folder")
local topologyExtractedChildTarget = topologyTarget({ kind = "forge_attribute", stableId = "virtual_extracted_child" }, "Workspace/Extracted/Child", "Folder")
local extractedBeforeDeleteChangeSet = { kind = "CreatorChangeSet", id = "virtual_extract_before_delete", operations = {
	{ id = "create_extracted_child", kind = "create", target = topologyExtractedChildTarget, parent = topologyExtractedTarget, className = "Folder", name = "Child", properties = {}, attributes = {} },
	{ id = "move_extracted_out", kind = "move", target = topologyExtractedTarget, parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, name = "Extracted", properties = {}, attributes = {}, removedAttributes = {} },
	{ id = "delete_root", kind = "delete", target = topologyDeleteRootTarget },
} }
local extractedTopology = Generated.compileMutationTransactionTopologyFromIndex(extractedBeforeDeleteChangeSet, topologyExtractionCapture)
assert(extractedTopology.canonicalOperationIds[1] == "create_extracted_child" and extractedTopology.canonicalOperationIds[2] == "move_extracted_out" and extractedTopology.canonicalOperationIds[3] == "delete_root", "extraction, descendant work, and delete must have one deterministic safe order")
assert(extractedTopology.postTargets["studio_ephemeral:" .. topologyEpoch .. ":" .. string.rep("b", 64)].path == "Workspace/Extracted" and extractedTopology.postTargets["forge_attribute:virtual_extracted_child"].path == "Workspace/Extracted/Child" and extractedTopology.postTargets["studio_ephemeral:" .. topologyEpoch .. ":" .. string.rep("a", 64)] == nil, "only the final delete closure may disappear from the generated post-state")
local extractedRequirements = Generated.compileMutationProjectionInputsFromIndex(extractedBeforeDeleteChangeSet, topologyExtractionCapture).requirements
local sawDeletedRoot, inventedExtractedAbsence = false, false
for _, requirement in ipairs(extractedRequirements) do
	if requirement.kind == "structure" and requirement.expectedStatus == "absent" then
		if requirement.target.identity.kind == "studio_ephemeral" and requirement.target.identity.opaqueHash == string.rep("a", 64) then sawDeletedRoot = true end
		if requirement.target.identity.kind == "forge_attribute" and requirement.target.identity.stableId == "virtual_extracted_child" then inventedExtractedAbsence = true end
	end
end
assert(sawDeletedRoot and not inventedExtractedAbsence, "mutation proof must require the root deletion but never invent absence for an extracted child")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_move_into_deleted_root", operations = {
		{ id = "move_b_into_deleted_root", kind = "move", target = topologyBPath, parent = topologyDeleteRootTarget, name = "B", properties = {}, attributes = {}, removedAttributes = {} },
		{ id = "delete_root", kind = "delete", target = topologyDeleteRootTarget },
	} }, topologyExtractionCapture)
end), "an operation whose final placement remains under a deleted root must fail before recording")

-- A complete project index also carries generated covered-property values.
-- An inbound reference to a deleted object must be cleared before the delete;
-- accepting it would prove a post-state whose surviving instance still points
-- at an absent identity.
local topologyVictim, topologyInbound = topologyOpaque("8"), topologyOpaque("9")
local topologyInboundCapture = topologyCapture({
	{ identity = topologyVictim, parentIdentity = topologyWorkspaceIdentity, displayPath = "Workspace/Victim", name = "Victim", className = "Part", attributes = {}, coveredProperties = {}, coveredPropertyNames = {} },
	{ identity = topologyInbound, parentIdentity = topologyWorkspaceIdentity, displayPath = "Workspace/InboundWeld", name = "InboundWeld", className = "WeldConstraint", attributes = {}, coveredProperties = { Part0 = { kind = "instance_ref", state = "reference", identity = topologyVictim, path = "Workspace/Victim", className = "Part", expectedClass = "BasePart" } }, coveredPropertyNames = { "Part0" } },
})
local topologyVictimTarget = topologyTarget(topologyVictim, "Workspace/Victim", "Part")
local topologyInboundTarget = topologyTarget(topologyInbound, "Workspace/InboundWeld", "WeldConstraint")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_reject_inbound_delete", operations = {
		{ id = "delete_victim", kind = "delete", target = topologyVictimTarget },
	} }, topologyInboundCapture)
end), "a delete must reject a surviving covered Instance reference to its target")
assert(pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_clear_inbound_then_delete", operations = {
		{ id = "clear_inbound_ref", kind = "update", target = topologyInboundTarget, properties = { Part0 = { kind = "instance_ref", state = "nil", expectedClass = "BasePart" } }, attributes = {}, removedAttributes = {} },
		{ id = "delete_victim", kind = "delete", target = topologyVictimTarget },
	} }, topologyInboundCapture)
end), "a covered inbound reference may be cleared before the referenced object is deleted")
assert(not pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_retain_inbound_then_delete", operations = {
		{ id = "retain_inbound_ref", kind = "update", target = topologyInboundTarget, properties = { Part0 = { kind = "instance_ref", state = "reference", identity = topologyVictim, path = "Workspace/Victim", className = "Part", expectedClass = "BasePart" } }, attributes = {}, removedAttributes = {} },
		{ id = "delete_victim", kind = "delete", target = topologyVictimTarget },
	} }, topologyInboundCapture)
end), "an update that retains a deleted covered Instance reference must still fail")

-- A replacement sibling can use a slot only after the exact prior occupant is
-- deleted or moved. This is a graph dependency, not a path-string exception.
local replacementTarget = topologyTarget({ kind = "forge_attribute", stableId = "virtual_replacement" }, "Workspace/A", "Folder")
assert(pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_delete_frees_slot", operations = {
		{ id = "delete_a", kind = "delete", target = topologyAPath },
		{ id = "create_replacement", kind = "create", target = replacementTarget, parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, className = "Folder", name = "A", properties = {}, attributes = {} },
	} }, topologyCapture())
end), "a delete may free an exact sibling slot for a later canonical create")
assert(pcall(function()
	Generated.compileMutationProjectionInputsFromIndex({ kind = "CreatorChangeSet", id = "virtual_move_frees_slot", operations = {
		{ id = "move_a_out", kind = "move", target = topologyAPath, parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, name = "AOld", properties = {}, attributes = {}, removedAttributes = {} },
		{ id = "create_replacement", kind = "create", target = replacementTarget, parent = { kind = "engine_container", path = "Workspace", className = "Workspace" }, className = "Folder", name = "A", properties = {}, attributes = {} },
	} }, topologyCapture())
end), "a move may free an exact sibling slot for a later canonical create")

-- Both initial identities occupy the replacement slot. The second move waits
-- for a newly created destination, so depending only on the first move would
-- incorrectly schedule the replacement before that second occupant leaves.
local duplicateSlotCapture = topologyCapture()
for index = 2, 3 do
	duplicateSlotCapture.shards[1].nodes[index].name = "Shared"
	duplicateSlotCapture.shards[1].nodes[index].displayPath = "Workspace/Shared"
end
local duplicateDestination = topologyTarget({ kind = "forge_attribute", stableId = "duplicate_destination" }, "Workspace/Destination", "Folder")
local duplicateFirst = moveTopologyOperation("a_free_first", topologyTarget(topologyA, "Workspace/Shared", "Folder"), workspaceParent, "First")
local duplicateSecond = moveTopologyOperation("z_free_second", topologyTarget(topologyB, "Workspace/Shared", "Folder"), duplicateDestination, "Second")
local duplicateCreateDestination = { id = "c_create_destination", kind = "create", target = duplicateDestination, parent = workspaceParent, className = "Folder", name = "Destination", properties = {}, attributes = {} }
local duplicateReplacement = { id = "b_create_replacement", kind = "create", target = topologyTarget({ kind = "forge_attribute", stableId = "duplicate_replacement" }, "Workspace/Shared", "Folder"), parent = workspaceParent, className = "Folder", name = "Shared", properties = {}, attributes = {} }
assert(not pcall(function()
	Generated.compileMutationTransactionTopologyFromIndex({ kind = "CreatorChangeSet", id = "duplicate_slot_unsafe_order", operations = { duplicateFirst, duplicateCreateDestination, duplicateReplacement, duplicateSecond } }, duplicateSlotCapture)
end), "a replacement must not precede any prior occupant's freeing operation")
local duplicateTopology = Generated.compileMutationTransactionTopologyFromIndex({ kind = "CreatorChangeSet", id = "duplicate_slot_safe_order", operations = { duplicateFirst, duplicateCreateDestination, duplicateSecond, duplicateReplacement } }, duplicateSlotCapture)
assert(table.concat(duplicateTopology.canonicalOperationIds, ",") == "a_free_first,c_create_destination,z_free_second,b_create_replacement", "all duplicate occupants must leave before replacement, including a move with its own parent-create dependency")
end

local identity = { kind = "forge_attribute", stableId = "prompt_1" }
local target = { kind = "instance", identity = identity, path = "Workspace/Door/Prompt", className = "ProximityPrompt" }
local targetMaterial = Generated.factKey("structure", target)
assert(string.find(targetMaterial, "forge_attribute", 1, true), "evidence fact keys must materialize closed object identities")
assert(not pcall(function()
	Generated.factKey("structure", { kind = "instance", path = "Workspace/Door/Prompt", className = "ProximityPrompt" })
end), "display paths cannot stand in for object identity")

local function fakePart(x: number): any
	return {
		Position = { X = x, Y = 0, Z = 0 },
		IsA = function(_self: any, className: string): boolean return className == "BasePart" or className == "Part" end,
	}
end

local now = 0
local heartbeat: any = nil
local disconnected = false
local first, second = fakePart(0), fakePart(10)
local observer = DirectRuntimeObserver.new({
	observationWindowMs = 1000,
	targets = {
		{ id = "first", identity = { kind = "forge_attribute", stableId = "first" }, path = "Workspace/First", expectedClass = "BasePart" },
		{ id = "second", identity = { kind = "forge_attribute", stableId = "second" }, path = "Workspace/Second", expectedClass = "BasePart" },
	},
	calls = {
		{ id = "resolve-first", capability = "instance.resolve", targetId = "first" },
		{ id = "resolve-second", capability = "instance.resolve", targetId = "second" },
		{ id = "series-first", capability = "base_part.position_series", targetId = "first", sampleCount = 2, intervalMs = 100 },
		{ id = "series-second", capability = "base_part.position_series", targetId = "second", sampleCount = 2, intervalMs = 100 },
	},
}, {
	generated = Generated,
	clock = function(): number return now end,
	resolveTarget = function(item: any): any return item.path == "Workspace/First" and first or item.path == "Workspace/Second" and second or nil end,
	connectHeartbeat = function(callback: any): any heartbeat = callback; return { Disconnect = function() disconnected = true end } end,
})
assert(observer:start(), "observer must install after direct target resolution")
assert(#observer.results["series-first"].samples == 1 and #observer.results["series-second"].samples == 1, "series targets must receive an immediate sample")
now = 0.05; heartbeat()
assert(#observer.results["series-first"].samples == 1, "short clock ticks must not fabricate samples")
first.Position = { X = 4, Y = 0, Z = 0 }; second.Position = { X = 14, Y = 0, Z = 0 }
now = 0.1; heartbeat()
local results, failure = observer:seal()
assert(failure == nil and disconnected and #results == 4, "early Stop must seal the captured prefix and disconnect")
assert(#results[3].samples == 2 and #results[4].samples == 2, "concurrent series must preserve their actual prefixes")

local missingObserver = DirectRuntimeObserver.new({
	observationWindowMs = 0,
	targets = { { id = "missing", identity = { kind = "forge_attribute", stableId = "missing" }, path = "Workspace/Missing", expectedClass = "BasePart" } },
	calls = {
		{ id = "resolve", capability = "instance.resolve", targetId = "missing" },
		{ id = "series", capability = "base_part.position_series", targetId = "missing", sampleCount = 1, intervalMs = 100 },
	},
}, {
	generated = Generated,
	clock = function(): number return 0 end,
	resolveTarget = function(_item: any): any return nil end,
	connectHeartbeat = function(_callback: any): any return { Disconnect = function() end } end,
})
assert(missingObserver:start(), "authoritative target absence must not be an observer exception")
local missing, missingFailure = missingObserver:seal()
assert(missingFailure == nil and missing[1].status == "missing" and missing[2].status == "missing", "absent targets must remain complete absence evidence candidates")

local opaqueObserver = DirectRuntimeObserver.new({
	observationWindowMs = 0,
	targets = { { id = "opaque", identity = { kind = "studio_ephemeral", connectorEpoch = "epoch", opaqueHash = string.rep("a", 64) }, path = "Workspace/Opaque", expectedClass = "BasePart" } },
	calls = { { id = "resolve", capability = "instance.resolve", targetId = "opaque" } },
}, {
	generated = Generated,
	clock = function(): number return 0 end,
	-- An edit-mode opaque identity cannot identify a Play clone. This remains a
	-- technical observation gap, never a false absence verdict.
	resolveTarget = function(_item: any): (any, any) return nil, "unavailable" end,
	connectHeartbeat = function(_callback: any): any return { Disconnect = function() end } end,
})
assert(opaqueObserver:start(), "closed opaque runtime identities must not be rejected as malformed")
local opaqueResults, opaqueFailure = opaqueObserver:seal()
assert(opaqueFailure == nil and opaqueResults[1].status == "unavailable", "an unresolved Play clone must produce unavailable evidence rather than absence")

local edit = StudioAuthoring.applySourceEditsForTest("local answer = 1\n", { { startByte = 15, endByte = 16, replacementBlob = { manifestHash = "test" } } }, function(_blob: any): string return "2" end)
assert(edit == "local answer = 2\n", "source edits must be applied as bounded UTF-8 byte edits")
assert(not pcall(function() StudioAuthoring.applySourceEditsForTest("😀", { { startByte = 1, endByte = 1, replacementBlob = { manifestHash = "test" } } }, function(_blob: any): string return "x" end) end), "source edit byte boundaries must not split UTF-8")

-- Exercise the same hash-bound source materialization used by validation,
-- detached preflight, and provisional apply. A missing resolver used to make
-- edit_source fail only after the creator approved the exact change.
local beforeEditSource = "local answer = 1\n"
local afterEditSource = "local answer = 2\n"
local beforeDigest = string.rep("A", 32)
local afterDigest = string.rep("B", 32)
Hash.setDigestForTest(function(value: string): string
	if value == beforeEditSource then return beforeDigest end
	if value == afterEditSource then return afterDigest end
	error("unexpected source material")
end)
local resolverCalls = 0
local validatedEdit = StudioAuthoring.validatedSourceEditMaterialForTest(beforeEditSource, {
	beforeSourceHash = string.rep("41", 32),
	edits = { { startByte = 15, endByte = 16, replacementBlob = { manifestHash = "replacement" } } },
	finalSourceHash = string.rep("42", 32),
	finalByteCount = #afterEditSource,
}, function(binding: any): string
	resolverCalls += 1
	assert(binding.manifestHash == "replacement", "source edit must resolve its exact approved replacement binding")
	return "2"
end)
assert(validatedEdit == afterEditSource and resolverCalls == 1, "source edit materialization must resolve and verify each replacement exactly once")
assert(not pcall(function()
	StudioAuthoring.validatedSourceEditMaterialForTest(beforeEditSource, {
		beforeSourceHash = string.rep("41", 32),
		edits = { { startByte = 15, endByte = 16, replacementBlob = { manifestHash = "replacement" } } },
		finalSourceHash = string.rep("43", 32),
		finalByteCount = #afterEditSource,
	}, function(_binding: any): string return "2" end)
end), "source edit materialization must reject a final-source binding mismatch")
Hash.setDigestForTest(nil)

-- Exercise the actual receiving -> accepted transition. This specifically
-- prevents the completion handler from trying to resolve through its own
-- accepted-only guard before it has crossed the acceptance boundary.
local sourceWriteCapture = { state = "receiving" }
local sourceWriteBinding = { manifestHash = "manifest" }
local sourceAccepted = StudioAuthoring.acceptSourceWriteCaptureForTest(sourceWriteCapture, sourceWriteBinding, function(capture: any, binding: any): string
	assert(capture.state == "receiving" and binding == sourceWriteBinding, "source validation must run before acceptance")
	return "return 1\n"
end)
assert(sourceAccepted == "return 1\n" and sourceWriteCapture.state == "accepted", "a fully verified source-write body must cross exactly once from receiving to accepted")
sourceWriteCapture.binding = { manifestId = "manifest-id", manifestHash = "manifest-hash", sourceHash = "source-hash", utf8Bytes = 9 }
local sourceAcceptancePayload = StudioAuthoring.sourceWriteAcceptedPayloadForTest(sourceWriteCapture, "request-a")
assert(sourceAcceptancePayload.requestId == "request-a" and sourceAcceptancePayload.status == "accepted" and sourceAcceptancePayload.manifestHash == "manifest-hash", "the accepted payload must retain the exact request and immutable source binding required by the wire contract")
assert(not pcall(function()
	StudioAuthoring.acceptSourceWriteCaptureForTest(sourceWriteCapture, sourceWriteBinding, function(): string return "return 1\n" end)
end), "an accepted source-write completion must not be acknowledged twice")

-- Source stream pieceCount describes canonical JSON fragments, not source
-- bytes. Empty replacement text still has one immutable chunk, and escape-heavy
-- text may expand substantially in JSON; both must be legal at the boundary.
Hash.setDigestForTest(function(_value: string): string return string.rep("a", 32) end)
local function sourceWriteManifestForBoundary(utf8Bytes: number, chunkCount: number): any
	local chunkHashes = {}
	for index = 1, chunkCount do table.insert(chunkHashes, Hash.sha256("source-boundary-chunk-" .. tostring(index))) end
	local semantic = { sourceHash = Hash.sha256(string.rep("s", utf8Bytes)), utf8Bytes = utf8Bytes, chunkHashes = chunkHashes }
	local hash = Hash.sha256(StudioProjectIndexCanonical.material(semantic))
	return {
		kind = "CreatorSourceWriteBlobManifest",
		id = "creator_source_write_blob_manifest_" .. string.sub(hash, 1, 24),
		hash = hash,
		sourceHash = semantic.sourceHash,
		utf8Bytes = utf8Bytes,
		chunkHashes = chunkHashes,
	}
end
local function sourceWriteReceiver(): any
	return {
		hasPossibleRecording = function(): boolean return false end,
		prepared = nil,
		prepareTransfer = nil,
		sourceWriteRequestId = nil,
		sourceWrites = {},
	}
end
local emptySourceReceiver = sourceWriteReceiver()
local emptySourceManifest = sourceWriteManifestForBoundary(0, 1)
StudioAuthoring.beginSourceWriteForTest(emptySourceReceiver, {
	requestId = "empty-source-request",
	manifest = emptySourceManifest,
	pieceCount = 1,
})
assert(emptySourceReceiver.sourceWrites[emptySourceManifest.hash] ~= nil, "an empty source replacement must retain its one canonical transport leaf")
local escapedSourceReceiver = sourceWriteReceiver()
local escapedSourceManifest = sourceWriteManifestForBoundary(Constants.BACKEND_COMMAND_TRANSPORT_CHUNK_BYTES, 1)
StudioAuthoring.beginSourceWriteForTest(escapedSourceReceiver, {
	requestId = "escaped-source-request",
	manifest = escapedSourceManifest,
	pieceCount = 3,
})
assert(escapedSourceReceiver.sourceWrites[escapedSourceManifest.hash].pieceCount == 3, "source transport must accept JSON expansion independently of raw source bytes")
local impossibleSourceReceiver = sourceWriteReceiver()
local impossibleSourceManifest = sourceWriteManifestForBoundary(1, 2)
assert(not pcall(function()
	StudioAuthoring.beginSourceWriteForTest(impossibleSourceReceiver, {
		requestId = "impossible-source-request",
		manifest = impossibleSourceManifest,
		pieceCount = 1,
	})
end), "source transport cannot declare fewer fragments than immutable chunks")
Hash.setDigestForTest(nil)

-- A maximum-sized poll response must never be needed to carry Prepare. The
-- plugin accepts only an ordered, leaf-hashed stream and then rechecks the
-- complete document hash before the pure authoring parser sees any payload.
local prepareFirst = string.rep("a", Constants.BACKEND_COMMAND_TRANSPORT_CHUNK_BYTES)
local prepareSecond = "tail"
local prepareDocument = prepareFirst .. prepareSecond
Hash.setDigestForTest(function(value: string): string
	if value == prepareFirst then return string.rep("A", 32) end
	if value == prepareSecond then return string.rep("B", 32) end
	if value == prepareDocument then return string.rep("C", 32) end
	error("unexpected Prepare transfer material")
end)
local prepareBoundary = {
	requestId = "prepare-request",
	transferId = "creator_prepare_transfer_" .. string.rep("43", 12),
	documentHash = string.rep("43", 32),
	utf8Bytes = #prepareDocument,
	pieceCount = 2,
}
local prepareCapture = StudioAuthoring.newPrepareTransferCaptureForTest(prepareBoundary)
StudioAuthoring.appendPrepareTransferFragmentForTest(prepareCapture, {
	requestId = prepareBoundary.requestId,
	transferId = prepareBoundary.transferId,
	documentHash = prepareBoundary.documentHash,
	sequence = 0,
	encoding = "json",
	payload = prepareFirst,
	payloadHash = string.rep("41", 32),
})
StudioAuthoring.appendPrepareTransferFragmentForTest(prepareCapture, {
	requestId = prepareBoundary.requestId,
	transferId = prepareBoundary.transferId,
	documentHash = prepareBoundary.documentHash,
	sequence = 1,
	encoding = "json",
	payload = prepareSecond,
	payloadHash = string.rep("42", 32),
})
assert(StudioAuthoring.completePrepareTransferMaterialForTest(prepareCapture, prepareBoundary) == prepareDocument, "Prepare completion must reconstruct exactly one fully bound document")
local reorderedCapture = StudioAuthoring.newPrepareTransferCaptureForTest(prepareBoundary)
assert(not pcall(function()
	StudioAuthoring.appendPrepareTransferFragmentForTest(reorderedCapture, {
		requestId = prepareBoundary.requestId,
		transferId = prepareBoundary.transferId,
		documentHash = prepareBoundary.documentHash,
		sequence = 1,
		encoding = "json",
		payload = prepareSecond,
		payloadHash = string.rep("42", 32),
	})
end), "Prepare must reject reordered fragments before parsing")
local incompleteCapture = StudioAuthoring.newPrepareTransferCaptureForTest(prepareBoundary)
assert(not pcall(function()
	StudioAuthoring.completePrepareTransferMaterialForTest(incompleteCapture, prepareBoundary)
end), "Prepare must reject an incomplete transfer before parsing")
local replayPrepared = {
	requestId = prepareBoundary.requestId,
	prepareTransferId = prepareBoundary.transferId,
	prepareDocumentHash = prepareBoundary.documentHash,
	prepareDocumentBytes = prepareBoundary.utf8Bytes,
	preparePieceCount = prepareBoundary.pieceCount,
	changeSet = { sessionId = "creator-session", id = "change-set", hash = string.rep("d", 64) },
	projection = { id = "readback", contentHash = string.rep("e", 64) },
	preflightProjection = { id = "preflight", contentHash = string.rep("f", 64) },
	beforeProjectIndexManifestId = "before-index",
	beforeProjectRevisionHash = string.rep("1", 64),
	beforeProjectDetectorEpoch = 0,
}
local replayReceipt = StudioAuthoring.completePrepareTransfer({ prepareTransfer = nil, prepared = replayPrepared }, prepareBoundary, nil)
assert(replayReceipt.status == "prepared" and replayReceipt.changeSetHash == replayPrepared.changeSet.hash and replayReceipt.beforeProjectRevisionHash == replayPrepared.beforeProjectRevisionHash and replayReceipt.beforeProjectDetectorEpoch == replayPrepared.beforeProjectDetectorEpoch, "an exact redelivered completion must reproduce the same Prepare receipt without reparsing")
local conflictingCompletion = table.clone(prepareBoundary)
conflictingCompletion.documentHash = string.rep("44", 32)
conflictingCompletion.transferId = "creator_prepare_transfer_" .. string.rep("44", 12)
assert(not pcall(function()
	StudioAuthoring.completePrepareTransfer({ prepareTransfer = nil, prepared = replayPrepared }, conflictingCompletion, nil)
end), "a conflicting completion must not reuse a prepared receipt")
Hash.setDigestForTest(nil)

local finalizationSettings = {}
local finalizationPlugin = {
	GetSetting = function(_self: any, key: string): any return finalizationSettings[key] end,
	SetSetting = function(_self: any, key: string, value: any) finalizationSettings[key] = value end,
}
Hash.setDigestForTest(function(value: string): string
	local digest = 0
	for index = 1, #value do digest = (digest + string.byte(value, index) * index) % 268435455 end
	local bytes = string.char(
		digest % 256,
		math.floor(digest / 256) % 256,
		math.floor(digest / 65536) % 256,
		math.floor(digest / 16777216) % 256
	)
	return string.rep(bytes, 8)
end)
assert(not StudioAuthoring.possibleRecordingForTest(nil, nil, function(): boolean return false end), "Prepare may proceed only after Studio proves there is no unbound recording")
assert(StudioAuthoring.possibleRecordingForTest(nil, nil, function(): boolean return true end), "an unbound engine recording must block Prepare across clean-break setting changes")
assert(StudioAuthoring.possibleRecordingForTest(nil, nil, function(): boolean error("unavailable") end), "an unreadable engine recording state must fail closed")
assert(StudioAuthoring.possibleRecordingForTest(nil, { recordingId = "retained" }, function(): boolean return false end), "a durable current recording cursor must block Prepare independently of engine observation")
local recoveryProject = { name = "RecoveryFixture", placeId = 17, universeId = 23 }
local recoveryBounds = {
	kind = "CreatorResourcePolicy",
	maximumInstances = Constants.PROJECT_INDEX_MAXIMUM_INSTANCES,
	maximumCanonicalIndexBytes = Constants.PROJECT_INDEX_MAXIMUM_CANONICAL_BYTES,
	maximumSourceBlobBytes = Constants.PROJECT_INDEX_MAXIMUM_SOURCE_BLOB_BYTES,
	maximumIndexingDurationMs = Constants.PROJECT_INDEX_MAXIMUM_DURATION_MS,
	maximumNodesPerShard = Constants.PROJECT_INDEX_MAXIMUM_NODES_PER_SHARD,
	maximumCanonicalShardBytes = Constants.PROJECT_INDEX_MAXIMUM_SHARD_BYTES,
	transportChunkBytes = Constants.PROJECT_INDEX_TRANSPORT_CHUNK_BYTES,
}
local recoverySemantic = {
	manifestHash = Generated.manifestHash,
	project = recoveryProject,
	connectorEpoch = "connector_epoch_before_restart",
	purpose = "creator_project_index",
	roots = Generated.authoringRoots,
	bounds = recoveryBounds,
}
local recoveryContentIdentity = Hash.sha256(StudioProjectIndexCanonical.material(recoverySemantic))
local recoveryProjectionPayload = {
	manifestHash = recoverySemantic.manifestHash,
	project = recoverySemantic.project,
	connectorEpoch = recoverySemantic.connectorEpoch,
	purpose = recoverySemantic.purpose,
	roots = recoverySemantic.roots,
	bounds = recoverySemantic.bounds,
	contentIdentity = recoveryContentIdentity,
}
local recoveryProjectionHash = Hash.sha256(StudioProjectIndexCanonical.material(recoveryProjectionPayload))
local recoveryProjection = {
	kind = "StudioProjectIndexProjection",
	id = "studio_project_index_projection_" .. string.sub(recoveryProjectionHash, 1, 24),
	hash = recoveryProjectionHash,
	manifestHash = recoverySemantic.manifestHash,
	project = recoverySemantic.project,
	connectorEpoch = recoverySemantic.connectorEpoch,
	purpose = recoverySemantic.purpose,
	roots = recoverySemantic.roots,
	bounds = recoverySemantic.bounds,
	contentIdentity = recoveryContentIdentity,
}
local finalizationBinding = StudioAuthoring.sealTransactionCursorForTest({
	kind = "ForgeCreatorTransactionCursor",
	phase = "open",
	creatorSessionId = "creator_finalization_fixture",
	changeSetId = "change_set_finalization_fixture",
	changeSetHash = string.rep("a", 64),
	projectionId = "projection_finalization_fixture",
	projectionHash = string.rep("b", 64),
	manifestHash = Generated.manifestHash,
	preflightProjectionId = "preflight_projection_finalization_fixture",
	preflightProjectionHash = string.rep("e", 64),
	beforeProjectIndexManifestId = "index_finalization_fixture",
	beforeProjectRevisionHash = string.rep("c", 64),
	beforeProjectDetectorEpoch = 0,
	recordingId = "recording_finalization_fixture",
	preflightHash = string.rep("d", 64),
	recoveryProjection = recoveryProjection,
})
assert(#StudioProjectIndexCanonical.material(finalizationBinding) <= StudioAuthoring.transactionSettingMaterialLimitForTest(), "the durable transaction cursor must remain strictly bounded")
assert(finalizationBinding.beforeProjectIndexCapture == nil and finalizationBinding.changeSet == nil and finalizationBinding.projection == nil and finalizationBinding.preflightEvidence == nil, "the durable cursor must never retain project shards, source bodies, or cloned mutation documents")
local openingBinding = table.clone(finalizationBinding)
openingBinding.cursorHash = nil
openingBinding.phase = "opening"
openingBinding = StudioAuthoring.sealTransactionCursorForTest(openingBinding)
assert(StudioAuthoring.finalizationRecoveryStateForTest(finalizationBinding) == "open" and StudioAuthoring.finalizationRecoveryStateForTest(openingBinding) == "unknown", "restart must report the exact durable transaction phase without mutating Studio")
local recordingBeginCalls = 0
local refusedOpening = StudioAuthoring.beginRecordingAfterDurableIntentForTest({
	GetSetting = function(): any return nil end,
	SetSetting = function() error("settings unavailable") end,
}, openingBinding, function(): string
	recordingBeginCalls += 1
	return "must_not_open"
end)
assert(not refusedOpening.opened and refusedOpening.recordingAttempted == false and recordingBeginCalls == 0, "a failed durable-intent write must prove TryBeginRecording was never invoked")
local reboundRecoveryProjection = StudioAuthoring.rebindRecoveryProjectionForTest(recoveryProjection, "connector_epoch_after_restart")
assert(reboundRecoveryProjection.connectorEpoch == "connector_epoch_after_restart" and reboundRecoveryProjection.hash ~= recoveryProjection.hash and reboundRecoveryProjection.project.name == recoveryProjection.project.name and reboundRecoveryProjection.project.placeId == recoveryProjection.project.placeId and reboundRecoveryProjection.project.universeId == recoveryProjection.project.universeId, "recovery must bind the compact read contract to the new connector epoch without changing project authority")
local tamperedFinalizationBinding = table.clone(finalizationBinding)
tamperedFinalizationBinding.changeSetHash = string.rep("f", 64)
assert(not pcall(function() StudioAuthoring.beginFinalizationForTest(finalizationPlugin, tamperedFinalizationBinding, "commit") end), "a tampered durable transaction cursor must fail closed")
local finalizationIntent = StudioAuthoring.beginFinalizationForTest(finalizationPlugin, finalizationBinding, "commit")
assert(finalizationIntent.phase == "finalization_intent" and finalizationSettings.ForgeCreatorTransactionCursorV6.phase == "finalization_intent", "finalization intent must be durably read back before FinishRecording")
assert(StudioAuthoring.finalizationRecoveryStateForTest(finalizationIntent) == "finalizing", "an interrupted finalization intent must remain recovery-required without retrying FinishRecording")
assert(StudioAuthoring.exactRecordingStateForTest(finalizationBinding.recordingId, function(): boolean return true end) == "open", "a finalization intent must expose an exact still-open recording for creator-authorized recovery")
assert(StudioAuthoring.exactRecordingStateForTest(finalizationBinding.recordingId, function(): boolean return false end) == "not_open", "a finalization intent must expose an exact closed recording for stale-cursor acknowledgement only")
assert(StudioAuthoring.exactRecordingStateForTest(finalizationBinding.recordingId, function() error("unavailable") end) == "unknown", "a finalization readback fault must remain fail-closed")
local normalFinishCalls, normalReadCalls, normalFinishEvents = 0, 0, {}
local finishedNormally, finalizationFinished = StudioAuthoring.closeAndPersistFinalizationForTest(finalizationPlugin, finalizationIntent, finalizationBinding.recordingId, function()
	normalFinishCalls += 1
end, function(): boolean
	normalReadCalls += 1
	return false
end, function(settling: boolean)
	table.insert(normalFinishEvents, settling)
end, function() end)
assert(finishedNormally and normalFinishCalls == 1 and normalReadCalls == 1 and #normalFinishEvents == 2 and normalFinishEvents[1] == true and normalFinishEvents[2] == false, "normal finalization must finish once, read back closed, and clear its exact finish allowance")
assert(finalizationFinished.phase == "finalization_finished" and finalizationSettings.ForgeCreatorTransactionCursorV6.phase == "finalization_finished", "only an exact closed-recording readback may persist finished state")
assert(StudioAuthoring.finalizationRecoveryStateForTest(finalizationFinished) == "not_open", "a durable finished state is not an open recording")
local gateRejectedIntent = StudioAuthoring.beginFinalizationForTest(finalizationPlugin, finalizationBinding, "cancel")
local gateRejectedFinishCalls, gateRejectedReadCalls = 0, 0
local gateRejected, gateRejectedFailure = StudioAuthoring.closeAndPersistFinalizationForTest(finalizationPlugin, gateRejectedIntent, finalizationBinding.recordingId, function()
	gateRejectedFinishCalls += 1
end, function(): boolean
	gateRejectedReadCalls += 1
	return false
end, nil, function()
	error("stale authority")
end)
assert(not gateRejected and string.find(tostring(gateRejectedFailure), "finalization gate rejected", 1, true) and gateRejectedFinishCalls == 0 and gateRejectedReadCalls == 0, "a centralized pre-Finish gate failure must retain intent without calling FinishRecording or its closure readback")
assert(finalizationSettings.ForgeCreatorTransactionCursorV6.phase == "finalization_intent", "a failed centralized gate leaves the durable finalization intent recoverable")
local stillOpenIntent = StudioAuthoring.beginFinalizationForTest(finalizationPlugin, finalizationBinding, "cancel")
local stillOpenFinishCalls, stillOpenReadCalls, stillOpenEvents = 0, 0, {}
local closedWhileOpen, openFailure = StudioAuthoring.closeAndPersistFinalizationForTest(finalizationPlugin, stillOpenIntent, finalizationBinding.recordingId, function()
	stillOpenFinishCalls += 1
end, function(): boolean
	stillOpenReadCalls += 1
	return true
end, function(settling: boolean)
	table.insert(stillOpenEvents, settling)
end, function() end)
assert(not closedWhileOpen and string.find(tostring(openFailure), "remains open", 1, true) and stillOpenFinishCalls == 1 and stillOpenReadCalls == 1 and #stillOpenEvents == 2 and stillOpenEvents[1] == true and stillOpenEvents[2] == false, "a nonthrowing finalization that remains open must retain intent and never be persisted finished")
assert(finalizationSettings.ForgeCreatorTransactionCursorV6.phase == "finalization_intent" and StudioAuthoring.finalizationRecoveryStateForTest(stillOpenIntent) == "finalizing", "an unclosed finalization must remain explicitly recoverable")
local readErrorIntent = StudioAuthoring.beginFinalizationForTest(finalizationPlugin, finalizationBinding, "cancel")
local readErrorFinishCalls, readErrorEvents = 0, {}
local closedOnReadError, readErrorFailure = StudioAuthoring.closeAndPersistFinalizationForTest(finalizationPlugin, readErrorIntent, finalizationBinding.recordingId, function()
	readErrorFinishCalls += 1
end, function()
	error("readback unavailable")
end, function(settling: boolean)
	table.insert(readErrorEvents, settling)
end, function() end)
assert(not closedOnReadError and string.find(tostring(readErrorFailure), "readback failed", 1, true) and readErrorFinishCalls == 1 and #readErrorEvents == 2 and readErrorEvents[1] == true and readErrorEvents[2] == false, "a finalization readback error must retain finalization intent and clear the finish allowance")
assert(finalizationSettings.ForgeCreatorTransactionCursorV6.phase == "finalization_intent", "a readback error must not create a durable finished receipt")
local recoveryBoundCursor = table.clone(finalizationBinding)
recoveryBoundCursor.cursorHash = nil
recoveryBoundCursor.provisional = {
	directReadbackEvidenceHash = string.rep("5", 64),
	postApplyProjectIndexManifestId = "post_apply_index_finalization_fixture",
	postApplyProjectRevisionHash = string.rep("6", 64),
	postApplyProjectDetectorEpoch = 2,
}
recoveryBoundCursor.recovery = {
	projectIndexManifestId = "recovery_index_finalization_fixture",
	projectRevisionHash = string.rep("7", 64),
	projectDetectorEpoch = 3,
}
recoveryBoundCursor = StudioAuthoring.sealTransactionCursorForTest(recoveryBoundCursor)
do
	local expected = recoveryBoundCursor.recovery
	local intent = StudioAuthoring.beginRecoveryCancellationForTest(finalizationPlugin, recoveryBoundCursor, expected)
	assert(intent.finalization.finalizationKind == "recovery_cancel" and intent.finalization.replacesAction == nil and intent.finalization.recovery == true, "an open cursor must create a recovery intent without fabricated replacement provenance")
	assert(not pcall(function() StudioAuthoring.beginRecoveryCancellationForTest(finalizationPlugin, intent, expected) end), "an open-cursor cancellation intent cannot grant a second Finish")
	local finishCalls = 0
	local closed, finished = StudioAuthoring.closeAndPersistFinalizationForTest(finalizationPlugin, intent, recoveryBoundCursor.recordingId, function() finishCalls += 1 end, function() return false end, nil, function(actual)
		assert(actual.finalization.expectedCurrentProjectIndexManifestId == expected.projectIndexManifestId and actual.finalization.expectedCurrentProjectRevisionHash == expected.projectRevisionHash and actual.finalization.expectedCurrentProjectDetectorEpoch == expected.projectDetectorEpoch, "open-cursor recovery must retain its fresh capture immediately before Finish")
	end)
	assert(closed and finishCalls == 1, "open-cursor cancellation must prove exact closure")
	local authoring = StudioAuthoring.new(finalizationPlugin, {}, {})
	local receipt = authoring:recordFinalizationEvidence(finished, { indexManifest = { id = "after_open_cancel" }, revision = { hash = string.rep("8", 64) }, detectorEpoch = 4 })
	assert(receipt.finalizationKind == "recovery_cancel" and receipt.replacesAction == nil, "durable receipts must distinguish an open cursor from a displaced intent")
	authoring:acknowledgeFinalization(receipt)
	assert(not pcall(function() StudioAuthoring.beginRecoveryCancellationForTest(finalizationPlugin, recoveryBoundCursor, { projectIndexManifestId = expected.projectIndexManifestId, projectRevisionHash = expected.projectRevisionHash, projectDetectorEpoch = expected.projectDetectorEpoch + 1 }) end), "a stale recovery epoch must reject before writing intent")
end
local interruptedCommitIntent = StudioAuthoring.beginFinalizationForTest(finalizationPlugin, recoveryBoundCursor, "commit")
assert(interruptedCommitIntent.finalization.expectedCurrentProjectRevisionHash == recoveryBoundCursor.provisional.postApplyProjectRevisionHash and interruptedCommitIntent.finalization.expectedCurrentProjectRevisionHash ~= recoveryBoundCursor.recovery.projectRevisionHash, "the interrupted ordinary intent must retain its original post-Apply gate, distinct from later recovery evidence")
local recoveryCancelIntent = StudioAuthoring.beginRecoveryCancellationForTest(finalizationPlugin, interruptedCommitIntent, {
	projectIndexManifestId = recoveryBoundCursor.recovery.projectIndexManifestId,
	projectRevisionHash = recoveryBoundCursor.recovery.projectRevisionHash,
	projectDetectorEpoch = recoveryBoundCursor.recovery.projectDetectorEpoch,
})
assert(recoveryCancelIntent.phase == "finalization_intent" and recoveryCancelIntent.finalization.action == "cancel" and recoveryCancelIntent.finalization.recovery == true and recoveryCancelIntent.finalization.replacesAction == "commit" and recoveryCancelIntent.finalization.expectedCurrentProjectRevisionHash == recoveryBoundCursor.recovery.projectRevisionHash, "an explicit recovery cancellation must replace, not retry, the original finalization action")
local mixedRecoveryBinding = table.clone(recoveryCancelIntent)
mixedRecoveryBinding.beforeProjectIndexManifestId = recoveryBoundCursor.recovery.projectIndexManifestId
assert(not StudioAuthoring.sameRecordingBindingForTest(mixedRecoveryBinding, recoveryCancelIntent), "a recovery capture must never replace one field of the original recording binding")
assert(not pcall(function()
	StudioAuthoring.beginRecoveryCancellationForTest(finalizationPlugin, recoveryCancelIntent, {
		projectIndexManifestId = recoveryBoundCursor.recovery.projectIndexManifestId,
		projectRevisionHash = recoveryBoundCursor.recovery.projectRevisionHash,
	projectDetectorEpoch = recoveryBoundCursor.recovery.projectDetectorEpoch,
})
end), "a failed recovery cancellation must never receive an automatic or repeated Finish")
local recoveredClosed, recoveredFinished = StudioAuthoring.closeAndPersistFinalizationForTest(finalizationPlugin, recoveryCancelIntent, recoveryBoundCursor.recordingId, function() end, function(): boolean return false end, nil, function(intent: any)
	assert(intent.finalization.finalizationKind == "recovery_cancel" and intent.finalization.replacesAction == "commit" and intent.finalization.expectedCurrentProjectIndexManifestId == recoveryBoundCursor.recovery.projectIndexManifestId and intent.finalization.expectedCurrentProjectRevisionHash == recoveryBoundCursor.recovery.projectRevisionHash and intent.finalization.expectedCurrentProjectDetectorEpoch == recoveryBoundCursor.recovery.projectDetectorEpoch, "the immediately pre-Finish callback must see the replacement recovery-cancel intent and its recovery gate, never the original post-Apply gate")
end)
assert(recoveredClosed, "a creator-authorized recovery cancellation must still prove exact closure")
local recoveryAuthoring = StudioAuthoring.new(finalizationPlugin, {}, {})
local recoveryReceipt = recoveryAuthoring:recordFinalizationEvidence(recoveredFinished, {
	indexManifest = { id = "post_recovery_cancel_index" },
	revision = { hash = string.rep("c", 64) },
	detectorEpoch = 4,
})
assert(recoveryReceipt.finalizationKind == "recovery_cancel" and recoveryReceipt.replacesAction == "commit" and recoveryReceipt.afterProjectDetectorEpoch == 4, "a recovery cancellation receipt must retain immutable provenance and the exact final project-capture epoch")
recoveryAuthoring:acknowledgeFinalization(recoveryReceipt)
StudioAuthoring.persistActiveForTest(finalizationPlugin, finalizationFinished)
local finalizationAuthoring = StudioAuthoring.new(finalizationPlugin, {}, {})
local finalizationReceipt = finalizationAuthoring:recordFinalizationEvidence(finalizationFinished, {
	indexManifest = { id = "post_commit_index" },
	revision = { hash = string.rep("6", 64) },
	detectorEpoch = 0,
})
assert(finalizationReceipt.afterProjectDetectorEpoch == 0, "a commit receipt must bind the exact post-finalization project-capture epoch")
StudioAuthoring.persistActiveForTest(finalizationPlugin, finalizationFinished)
finalizationAuthoring:acknowledgeFinalization(finalizationReceipt)
assert(finalizationSettings.ForgeCreatorTransactionCursorV6 == nil and finalizationSettings.ForgeCreatorFinalizationReceiptV6 == nil, "acknowledging an exact receipt must clear a matching finished cursor left by an interrupted cleanup")
assert(finalizationSettings.ForgeCreatorLastCommitV6 ~= nil, "an acknowledged commit receipt must remain available for guarded rollback")
local failedApplyIntent = StudioAuthoring.beginFinalizationForTest(finalizationPlugin, finalizationBinding, "cancel", { failedApply = true, failureCode = "mutation_apply_failed" })
local failedApplyClosed, failedApplyFinished = StudioAuthoring.closeAndPersistFinalizationForTest(finalizationPlugin, failedApplyIntent, finalizationBinding.recordingId, function() end, function(): boolean return false end, nil, function() end)
assert(failedApplyClosed, "an apply-failure cancellation must prove closure before finalization evidence")
local failedApplyReceipt = finalizationAuthoring:recordFinalizationEvidence(failedApplyFinished, {
	indexManifest = { id = "post_failed_apply_index" },
	revision = { hash = string.rep("8", 64) },
	detectorEpoch = 1,
})
assert(failedApplyReceipt.expectedCurrentProjectIndexManifestId == finalizationBinding.beforeProjectIndexManifestId and failedApplyReceipt.expectedCurrentProjectRevisionHash == finalizationBinding.beforeProjectRevisionHash and failedApplyReceipt.expectedCurrentProjectDetectorEpoch == finalizationBinding.beforeProjectDetectorEpoch, "apply-failure cancellation receipts must bind the pre-Apply capture, never a post-cancel collection")
finalizationAuthoring:acknowledgeFinalization(failedApplyReceipt)
local provisionalCursor = table.clone(finalizationBinding)
provisionalCursor.cursorHash = nil
provisionalCursor.provisional = {
	directReadbackEvidenceHash = string.rep("9", 64),
	postApplyProjectIndexManifestId = "post_apply_authority_index",
	postApplyProjectRevisionHash = string.rep("a", 64),
	postApplyProjectDetectorEpoch = 2,
}
provisionalCursor = StudioAuthoring.sealTransactionCursorForTest(provisionalCursor)
local evidenceFailureIntent = StudioAuthoring.beginFinalizationForTest(finalizationPlugin, provisionalCursor, "cancel", { failureCode = "mutation_readback_failed" })
local evidenceFailureClosed, evidenceFailureFinished = StudioAuthoring.closeAndPersistFinalizationForTest(finalizationPlugin, evidenceFailureIntent, provisionalCursor.recordingId, function() end, function(): boolean return false end, nil, function() end)
assert(evidenceFailureClosed, "an evidence-failure cancellation must prove closure before finalization evidence")
local evidenceFailureReceipt = finalizationAuthoring:recordFinalizationEvidence(evidenceFailureFinished, {
	indexManifest = { id = "post_evidence_failure_index" },
	revision = { hash = string.rep("b", 64) },
	detectorEpoch = 3,
})
assert(evidenceFailureReceipt.expectedCurrentProjectIndexManifestId == provisionalCursor.provisional.postApplyProjectIndexManifestId and evidenceFailureReceipt.expectedCurrentProjectRevisionHash == provisionalCursor.provisional.postApplyProjectRevisionHash and evidenceFailureReceipt.expectedCurrentProjectDetectorEpoch == provisionalCursor.provisional.postApplyProjectDetectorEpoch, "evidence-failure cancellation receipts must bind the durable provisional capture, never a post-cancel collection")
finalizationAuthoring:acknowledgeFinalization(evidenceFailureReceipt)
Hash.setDigestForTest(nil)

for className in pairs(Generated.classes) do
	assert(StudioInstancePolicy.isEvidenceRelevant({ ClassName = className }), className .. " must use generated evidence eligibility")
end
assert(not StudioInstancePolicy.isEvidenceRelevant({ ClassName = "Camera" }), "unmanifested classes must not gain implicit evidence authority")

local reflected, reflectionFailure = StudioEvidenceCollector.reflectedPropertyValueForTest({
	Name = "Attachment0", Owner = "Beam", Serialized = true,
	Type = { EngineType = "Object", ScriptType = "Instance", InstanceType = "Attachment" },
	Permits = { Read = {}, Write = {} },
}, "Beam", "Attachment0")
assert(reflectionFailure == nil and reflected ~= nil and reflected.type.instanceType == "Attachment", "reflection must preserve raw class-reference information without claiming a verdict")

assert(require("./test-directed-setter-effects"))
print("plugin module tests passed")
