--!strict
-- A dirty signal is not a snapshot or a revision. It merely forces the
-- coordinator to obtain a new complete project-index projection before any
-- previously approved authority can advance.
local Constants = if script ~= nil then require(script.Parent.Constants) else require("./Constants")
local StudioInstancePolicy = if script ~= nil then require(script.Parent.StudioInstancePolicy) else require("./StudioInstancePolicy")

local StudioProjectChangeMonitor = {}
StudioProjectChangeMonitor.__index = StudioProjectChangeMonitor

local sourceOrder = { attribute = 1, change_history = 2, hierarchy = 3, monitoring_failure = 4, property = 5, script_editor = 6, undo_redo = 7 }
local attributableSources = { attribute = true, hierarchy = true, property = true, script_editor = true }
local MAXIMUM_EXACT_MUTATION_FACTS = 65536
local MAXIMUM_EXACT_MUTATION_EVENT_BUDGET = MAXIMUM_EXACT_MUTATION_FACTS * 2
-- A connector can have only one Forge ChangeHistory recording awaiting its
-- terminal event. Retaining arbitrary opaque identifiers would turn a missing
-- Studio callback into an unbounded suppression set.
local MAXIMUM_EXPECTED_RECORDING_FINISHES = 1
local MAXIMUM_MUTATION_DIAGNOSTICS = 8
local MAXIMUM_DIAGNOSTIC_COUNT = 1000000
local MAXIMUM_DIAGNOSTIC_BYTES = 4096

local function boundedDiagnosticText(value: any, maximum: number): string
	if typeof(value) ~= "string" then return "<unavailable>" end
	local result = string.sub(value, 1, maximum)
	while #result > 0 and utf8.len(result) == nil do result = string.sub(result, 1, #result - 1) end
	local sanitized = string.gsub(result, "[%z\1-\31\127]", "?")
	return sanitized
end

local function diagnosticLocation(instance: any): (string, string)
	local ok, className, path = pcall(function()
		if instance == nil then return "<none>", "<none>" end
		local names, cursor = {}, instance
		for _ = 1, 32 do
			if cursor == nil or cursor.ClassName == "DataModel" then break end
			table.insert(names, 1, boundedDiagnosticText(cursor.Name, 96))
			cursor = cursor.Parent
		end
		return boundedDiagnosticText(instance.ClassName, 48), boundedDiagnosticText(table.concat(names, "/"), 192)
	end)
	return if ok then className else "<unavailable>", if ok then path else "<unavailable>"
end

local function defaultDiagnosticSink(message: string)
	warn("FORGE_UNMATCHED_MUTATIONS " .. message)
end

local function iso(): string return os.date("!%Y-%m-%dT%H:%M:%S.000Z") end

function StudioProjectChangeMonitor.new(callback: (any) -> (), dependencies: any?)
	if typeof(callback) ~= "function" then error("project change monitor callback is required") end
	local services = dependencies or {
		changeHistory = game:GetService("ChangeHistoryService"),
		scriptEditor = game:GetService("ScriptEditorService"),
		root = game,
	}
	return setmetatable({
		callback = callback,
		services = services,
		connections = {} :: {RBXScriptConnection},
		instanceConnections = {} :: {[Instance]: {RBXScriptConnection}},
		monitoredInstances = 0,
		epoch = 0,
		started = false,
		starting = false,
		-- Forge never suppresses a broad "writer is active" interval. Engine
		-- callbacks can synchronously invoke other plugins, so such a window
		-- would hide a creator edit made as a side effect of a Forge write. Each
		-- fact below is an instance/field-bound postcondition supplied by the
		-- authoring layer immediately before it writes that field.
		exactForgeMutationFacts = {} :: {any},
		exactForgeMutationEventBudget = 0,
		exactForgeMutationPhase = "after",
		mutationDiagnostics = {} :: {any},
		omittedMutationDiagnostics = 0,
		diagnosticSink = if typeof(services.diagnosticSink) == "function" then services.diagnosticSink else defaultDiagnosticSink,
		expectedForgeRecordingFinishes = {} :: {[string]: boolean},
		expectedForgeRecordingFinishCount = 0,
		monitoringFailed = false,
	}, StudioProjectChangeMonitor)
end

-- Exact mutation facts have two state matchers and two independent, bounded
-- notification budgets. The authoring layer registers them before a write:
-- `after` recognizes the approved provisional result and `before` recognizes
-- the same fact only after exact ChangeHistory cancellation has restored it.
-- The monitor never receives a path-only or source-only exemption, and a
-- matcher must inspect the current engine state.
--
-- Apply and cancellation can both notify for the same property, attribute, or
-- hierarchy transition. Consuming one must not consume the other. Conversely,
-- each phase budget is finite (normally one event), so an old approved
-- postcondition cannot become a reusable exemption for a later creator edit.
function StudioProjectChangeMonitor:expectExactForgeMutationFact(fact: any)
	if typeof(fact) ~= "table"
		or attributableSources[fact.source] ~= true
		or fact.instance == nil
		or (fact.field ~= nil and typeof(fact.field) ~= "string")
		or typeof(fact.matchesBefore) ~= "function"
		or typeof(fact.matchesAfter) ~= "function"
		or typeof(fact.beforeEventBudget) ~= "number"
		or fact.beforeEventBudget % 1 ~= 0
		or fact.beforeEventBudget < 0
		or typeof(fact.afterEventBudget) ~= "number"
		or fact.afterEventBudget % 1 ~= 0
		or fact.afterEventBudget < 0
		or (fact.beforeEventBudget == 0 and fact.afterEventBudget == 0)
	then error("exact Forge mutation fact is malformed") end
	if #self.exactForgeMutationFacts >= MAXIMUM_EXACT_MUTATION_FACTS then error("exact Forge mutation fact resource policy exceeded") end
	local eventBudget = fact.beforeEventBudget + fact.afterEventBudget
	if self.exactForgeMutationEventBudget + eventBudget > MAXIMUM_EXACT_MUTATION_EVENT_BUDGET then error("exact Forge mutation event budget exceeded") end
	table.insert(self.exactForgeMutationFacts, {
		source = fact.source,
		instance = fact.instance,
		field = fact.field,
		matchesBefore = fact.matchesBefore,
		matchesAfter = fact.matchesAfter,
		beforeEventsRemaining = fact.beforeEventBudget,
		afterEventsRemaining = fact.afterEventBudget,
	})
	self.exactForgeMutationEventBudget += eventBudget
end

function StudioProjectChangeMonitor:setExactForgeMutationPhase(phase: string)
	if phase ~= "before" and phase ~= "after" then error("exact Forge mutation phase is invalid") end
	self.exactForgeMutationPhase = phase
end

function StudioProjectChangeMonitor:clearExactForgeMutationFacts()
	local diagnostics = self.mutationDiagnostics
	local omitted = self.omittedMutationDiagnostics
	self.mutationDiagnostics = {}
	self.omittedMutationDiagnostics = 0
	table.clear(self.exactForgeMutationFacts)
	self.exactForgeMutationEventBudget = 0
	self.exactForgeMutationPhase = "after"
	-- A window emits one bounded diagnostic batch after its facts are cleared.
	-- Logging has no authority and cannot prevent invalidation or finalization.
	if #diagnostics > 0 then
		pcall(function()
			local lines = {}
			for _, entry in diagnostics do
				table.insert(lines, string.format("source=%s class=%s path=%s field=%s phase=%s reason=%s count=%d epochs=%d-%d", entry.source, entry.className, entry.path, entry.field, entry.phase, entry.reason, entry.count, entry.firstEpoch, entry.lastEpoch))
			end
			if omitted > 0 then table.insert(lines, "additional unmatched events=" .. tostring(omitted)) end
			self.diagnosticSink(boundedDiagnosticText(table.concat(lines, " | "), MAXIMUM_DIAGNOSTIC_BYTES))
		end)
	end
end

-- ChangeHistory's finished signal carries the opaque recording identifier.
-- Suppress exactly the identifier Forge is about to settle, never a broad
-- "Forge is busy" interval. Any other finish while a recording exists is an
-- external edit and must dirty the coordinator's authority view.
function StudioProjectChangeMonitor:expectExactForgeRecordingFinish(recordingId: string)
	if typeof(recordingId) ~= "string" or recordingId == "" then error("expected Forge recording id is required") end
	if self.expectedForgeRecordingFinishes[recordingId] then return end
	if self.expectedForgeRecordingFinishCount >= MAXIMUM_EXPECTED_RECORDING_FINISHES then
		error("expected Forge recording-finish resource policy exceeded")
	end
	self.expectedForgeRecordingFinishes[recordingId] = true
	self.expectedForgeRecordingFinishCount += 1
end

function StudioProjectChangeMonitor:clearExpectedForgeRecordingFinish(recordingId: string)
	if self.expectedForgeRecordingFinishes[recordingId] then
		self.expectedForgeRecordingFinishes[recordingId] = nil
		self.expectedForgeRecordingFinishCount -= 1
	end
end

function StudioProjectChangeMonitor:recordingFinished(_name: any, _displayName: any, identifier: any)
	-- Roblox exposes the opaque TryBeginRecording identifier as the third
	-- parameter. The first value is a human-readable recording name and is not
	-- an authority binding; comparing it would turn every Forge commit or
	-- cancellation into a false external change.
	if typeof(identifier) == "string" and self.expectedForgeRecordingFinishes[identifier] then
		self.expectedForgeRecordingFinishes[identifier] = nil
		self.expectedForgeRecordingFinishCount -= 1
		return
	end
	self:emit("change_history")
end

function StudioProjectChangeMonitor:matchesExactForgeMutation(source: string, instance: any?, field: any?): (boolean, string?)
	if attributableSources[source] ~= true or instance == nil then return false, "no_registered_fact" end
	local found, available, matcherError = false, false, false
	for index = #self.exactForgeMutationFacts, 1, -1 do
		local fact = self.exactForgeMutationFacts[index]
		if fact.source == source and fact.instance == instance and fact.field == field then
			found = true
			local isBefore = self.exactForgeMutationPhase == "before"
			local remaining = if isBefore then fact.beforeEventsRemaining else fact.afterEventsRemaining
			if remaining <= 0 then continue end
			available = true
			local matcher = if isBefore then fact.matchesBefore else fact.matchesAfter
			local callable, matched = pcall(matcher)
			if not callable then matcherError = true end
			if callable and matched == true then
				-- Consume only the active phase's exact event allowance. A
				-- provisional Apply signal cannot exhaust the exact rollback
				-- allowance required if that same recording is later cancelled.
				if isBefore then fact.beforeEventsRemaining -= 1 else fact.afterEventsRemaining -= 1 end
				self.exactForgeMutationEventBudget -= 1
				return true
			end
		end
	end
	return false, if not found then "no_registered_fact" elseif not available then "phase_budget_exhausted" elseif matcherError then "matcher_error" else "state_mismatch"
end

function StudioProjectChangeMonitor:recordUnmatchedDiagnostic(source: string, instance: any?, field: any?, reason: string)
	if #self.exactForgeMutationFacts == 0 then return end
	local className, path = diagnosticLocation(instance)
	local name = if field == nil then "<none>" else boundedDiagnosticText(field, 48)
	for _, entry in self.mutationDiagnostics do
		if entry.source == source and entry.className == className and entry.path == path and entry.field == name and entry.phase == self.exactForgeMutationPhase and entry.reason == reason then
			entry.count = math.min(entry.count + 1, MAXIMUM_DIAGNOSTIC_COUNT)
			entry.lastEpoch = self.epoch
			return
		end
	end
	if #self.mutationDiagnostics >= MAXIMUM_MUTATION_DIAGNOSTICS then
		self.omittedMutationDiagnostics = math.min(self.omittedMutationDiagnostics + 1, MAXIMUM_DIAGNOSTIC_COUNT)
		return
	end
	table.insert(self.mutationDiagnostics, { source = source, className = className, path = path, field = name, phase = self.exactForgeMutationPhase, reason = reason, count = 1, firstEpoch = self.epoch, lastEpoch = self.epoch })
end

function StudioProjectChangeMonitor:emit(source: string, instance: any?, field: any?)
	if sourceOrder[source] == nil then error("unknown project change source") end
	local matched, reason = self:matchesExactForgeMutation(source, instance, field)
	if matched then return end
	self.epoch += 1
	-- Never re-run a matcher or read the property's value for diagnostics.
	if #self.exactForgeMutationFacts > 0 then
		pcall(function() self:recordUnmatchedDiagnostic(source, instance, field, reason or "state_mismatch") end)
	end
	self.callback({ epoch = self.epoch, observedAt = iso(), sources = { source } })
end

function StudioProjectChangeMonitor:detectorEpoch(): number
	return self.epoch
end

function StudioProjectChangeMonitor:isUsable(): boolean
	return self.started and not self.monitoringFailed
end

function StudioProjectChangeMonitor:markMonitoringFailed()
	if self.monitoringFailed then return end
	self.monitoringFailed = true
	-- A listener installation failure or resource ceiling means this connector
	-- cannot truthfully promise immediate external-change detection. Dirty the
	-- current authority view once and let the coordinator fail closed.
	self:emit("monitoring_failure")
end

function StudioProjectChangeMonitor:detachInstance(instance: Instance)
	local connections = self.instanceConnections[instance]
	if connections == nil then return end
	for _, connection in ipairs(connections) do connection:Disconnect() end
	self.instanceConnections[instance] = nil
	self.monitoredInstances -= 1
end

function StudioProjectChangeMonitor:attachInstance(instance: Instance)
	if self.instanceConnections[instance] ~= nil or self.monitoringFailed or not StudioInstancePolicy.isWithinEvidenceRoot(instance) then return end
	if self.monitoredInstances >= Constants.PROJECT_CHANGE_MONITOR_MAXIMUM_INSTANCES then
		self:markMonitoringFailed()
		return
	end
	local connected, result = pcall(function()
		local connections = {} :: {RBXScriptConnection}
		local isValue = instance:IsA("ValueBase")
		table.insert(connections, instance.Changed:Connect(function(propertyName: any)
			-- ValueBase.Changed carries the new value rather than a property name.
			local field = if isValue then "Value" else propertyName
			if StudioInstancePolicy.isWithinEvidenceRoot(instance) and StudioInstancePolicy.isIndexedProperty(instance.ClassName, field) then self:emit("property", instance, field) end
		end))
		-- ValueBase.Changed also omits ordinary property changes. Keep identity
		-- and placement observable independently of its specialized value signal.
		if isValue then
			for _, field in { "Name", "Parent" } do
				table.insert(connections, instance:GetPropertyChangedSignal(field):Connect(function()
					if StudioInstancePolicy.isWithinEvidenceRoot(instance) then self:emit("property", instance, field) end
				end))
			end
		end
		table.insert(connections, instance.AttributeChanged:Connect(function(attributeName: any)
			if StudioInstancePolicy.isWithinEvidenceRoot(instance) then self:emit("attribute", instance, attributeName) end
		end))
		return connections
	end)
	if not connected or typeof(result) ~= "table" then
		self:markMonitoringFailed()
		return
	end
	self.instanceConnections[instance] = result
	self.monitoredInstances += 1
end

function StudioProjectChangeMonitor:attachTree(instance: Instance, cooperate: (() -> ())?): boolean
	if not StudioInstancePolicy.isWithinEvidenceRoot(instance) then return false end
	local stack = { instance }
	while #stack > 0 and not self.monitoringFailed do
		local current = table.remove(stack)
		self:attachInstance(current)
		local children = current:GetChildren()
		for index = #children, 1, -1 do table.insert(stack, children[index]); if cooperate then cooperate() end end
		if cooperate then cooperate() end
	end
	return true
end

function StudioProjectChangeMonitor:start(cooperate: (() -> ())?)
	if self.started or self.starting then return end
	self.starting = true
	local changeHistory = self.services.changeHistory
	if not changeHistory then
		self:markMonitoringFailed()
	else
		-- These events are required monitor obligations. Silently skipping one
		-- would make a user edit invisible while presenting a fresh authority
		-- view. Only the exact recorded Forge finalization is suppressed.
		local function connectChangeHistory(signalName: string, callback: (...any) -> ())
			local ok, connection = pcall(function() return (changeHistory :: any)[signalName]:Connect(callback) end)
			if not ok or typeof(connection) ~= "RBXScriptConnection" then self:markMonitoringFailed(); return end
			table.insert(self.connections, connection)
		end
		connectChangeHistory("OnRecordingFinished", function(name: any, displayName: any, identifier: any)
			self:recordingFinished(name, displayName, identifier)
		end)
		connectChangeHistory("OnUndo", function() self:emit("undo_redo") end)
		connectChangeHistory("OnRedo", function() self:emit("undo_redo") end)
	end
	local scriptEditor = self.services.scriptEditor
	if not scriptEditor then
		self:markMonitoringFailed()
	else
		local ok, connection = pcall(function()
			return scriptEditor.TextDocumentDidChange:Connect(function(document: any, _changes: any)
				local scriptOk, source = pcall(function() return document:GetScript() end)
				-- Command-bar and plugin documents are outside the opened place and
				-- cannot invalidate this project's authority. A document which cannot
				-- be resolved is conservatively dirty rather than silently ignored.
				if not scriptOk or not source or not source:IsA("LuaSourceContainer") then self:emit("script_editor")
				elseif StudioInstancePolicy.isWithinEvidenceRoot(source) then self:emit("script_editor", source) end
			end)
		end)
		if not ok or typeof(connection) ~= "RBXScriptConnection" then self:markMonitoringFailed() else table.insert(self.connections, connection) end
	end
	local root = self.services.root
	if root then
		local hierarchyConnected = pcall(function()
			-- The DataModel itself is outside the indexed authoring roots, but its
			-- reserved project identity is a conversation-authority boundary. An
			-- undo, manual removal, or external rewrite must invalidate the host's
			-- current identity view just like any other attributed project edit.
			table.insert(self.connections, root.AttributeChanged:Connect(function(attributeName: any)
				if attributeName == Constants.PROJECT_IDENTITY_ATTRIBUTE then
					self:emit("attribute", root, Constants.PROJECT_IDENTITY_ATTRIBUTE)
				end
			end))
			table.insert(self.connections, root.DescendantAdded:Connect(function(instance)
				-- DescendantAdded/Removing fires for each affected descendant. Keep
				-- the engine callback O(1); startup owns the only cooperative tree walk.
				if StudioInstancePolicy.isWithinEvidenceRoot(instance) then self:attachInstance(instance); self:emit("hierarchy", instance, "added") end
			end))
			table.insert(self.connections, root.DescendantRemoving:Connect(function(instance)
				if StudioInstancePolicy.isWithinEvidenceRoot(instance) then self:emit("hierarchy", instance, "removing"); self:detachInstance(instance) end
			end))
		end)
		if not hierarchyConnected then self:markMonitoringFailed() end
		for _, rootName in ipairs(StudioInstancePolicy.rootNames()) do
			if self.monitoringFailed then break end
			local indexedRoot = root:FindFirstChild(rootName)
			if indexedRoot then self:attachTree(indexedRoot, cooperate) end
		end
	else
		self:markMonitoringFailed()
	end
	self.starting = false
	self.started = true
end

function StudioProjectChangeMonitor:destroy(cooperate: (() -> ())?)
	for _, connection in ipairs(self.connections) do connection:Disconnect() end
	for instance in pairs(self.instanceConnections) do
		self:detachInstance(instance)
		if cooperate then cooperate() end
	end
	table.clear(self.connections); table.clear(self.expectedForgeRecordingFinishes); self.expectedForgeRecordingFinishCount = 0; self:clearExactForgeMutationFacts(); self.started = false; self.starting = false; self.monitoredInstances = 0
end

return StudioProjectChangeMonitor
