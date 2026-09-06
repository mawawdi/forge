local Monitor = require("../plugin/src/Forge/StudioProjectChangeMonitor")
local Policy = require("../plugin/src/Forge/StudioInstancePolicy")

local function instance(name: string): any
	return { Name = name, ClassName = "TextLabel", Parent = { Name = "StarterGui", ClassName = "StarterGui" } }
end
local function fact(target: any, before: () -> boolean, after: () -> boolean, field: string?): any
	return { source = "property", instance = target, field = field or "Text", matchesBefore = before, matchesAfter = after, beforeEventBudget = 1, afterEventBudget = 1 }
end
local notices, logs = {}, {}
local monitor = Monitor.new(function(notice) table.insert(notices, notice) end, { diagnosticSink = function(message) table.insert(logs, message) end })
local label = instance("Caption")
local diagnosticReads = 0
local recordDiagnostic = monitor.recordUnmatchedDiagnostic
monitor.recordUnmatchedDiagnostic = function(self, ...)
	diagnosticReads += 1
	return recordDiagnostic(self, ...)
end
monitor:emit("property", label, "Text")
monitor:clearExactForgeMutationFacts()
assert(#logs == 0 and #notices == 1 and diagnosticReads == 0, "ordinary edits outside exact mutation windows must not collect diagnostics")

local calls = 0
monitor:expectExactForgeMutationFact(fact(label, function() calls += 1; return true end, function() calls += 1; return true end))
monitor:emit("property", label, "Text")
assert(monitor:detectorEpoch() == 1 and calls == 1 and monitor.exactForgeMutationEventBudget == 1, "accepted facts must consume only their normal after budget")
monitor:emit("property", label, "Text")
monitor:emit("property", label, "Text")
assert(monitor:detectorEpoch() == 3 and calls == 1 and monitor.exactForgeMutationEventBudget == 1, "exhausted facts must remain dirty without calling matchers again")
assert(#logs == 0 and #monitor.mutationDiagnostics == 1 and monitor.mutationDiagnostics[1].count == 2, "repeated unmatched events must be batched and deduplicated")
monitor:setExactForgeMutationPhase("before")
monitor:emit("property", label, "Text")
assert(monitor:detectorEpoch() == 3 and calls == 2 and monitor.exactForgeMutationEventBudget == 0, "diagnostics must not consume cancellation's independent before budget")
monitor:clearExactForgeMutationFacts()
assert(#logs == 1 and string.find(logs[1], "phase_budget_exhausted", 1, true) and string.find(logs[1], "count=2", 1, true), "each window emits one diagnostic batch with reason and repeat count")
assert(string.find(logs[1], "path=StarterGui/Caption", 1, true) and string.find(logs[1], "field=Text", 1, true) and string.find(logs[1], "class=TextLabel", 1, true), "diagnostics must identify source location and field")
monitor:clearExactForgeMutationFacts()
assert(#logs == 1, "empty clear must not repeat a prior window's diagnostics")

monitor:expectExactForgeMutationFact(fact(label, function() return false end, function() return false end))
monitor:emit("property", label, "Text")
monitor:emit("property", label, "TextSize")
monitor:expectExactForgeMutationFact(fact(label, function() return false end, function() error("PRIVATE_PROPERTY_VALUE_MUST_NOT_LEAK") end, "FontFace"))
monitor:emit("property", label, "FontFace")
monitor:clearExactForgeMutationFacts()
assert(string.find(logs[2], "state_mismatch", 1, true) and string.find(logs[2], "no_registered_fact", 1, true) and string.find(logs[2], "matcher_error", 1, true), "all rejection reasons must be distinguished without swallowing the dirty notice")
assert(not string.find(logs[2], "PRIVATE_PROPERTY_VALUE_MUST_NOT_LEAK", 1, true), "raw matcher errors and property values must never be logged")

monitor:expectExactForgeMutationFact(fact(label, function() return false end, function() return false end))
for index = 1, 20 do
	local target = instance("Label" .. index .. "\n" .. string.rep("🙂", 300))
	monitor:emit("property", target, "TextTransparency")
end
assert(#monitor.mutationDiagnostics == 8 and monitor.omittedMutationDiagnostics == 12, "diagnostic entries must be bounded independently of event count")
monitor:clearExactForgeMutationFacts()
assert(#logs == 3 and #logs[3] <= 4096 and utf8.len(logs[3]) ~= nil and not string.find(logs[3], "\n", 1, true), "batched output must be byte-bounded, valid UTF-8, and single-line")
assert(#monitor.mutationDiagnostics == 0 and monitor.omittedMutationDiagnostics == 0, "clearing the window releases all diagnostic state")

local sinkCalls = 0
local protected = Monitor.new(function() end, { diagnosticSink = function() sinkCalls += 1; error("diagnostic sink failure") end })
protected:expectExactForgeMutationFact(fact(label, function() return false end, function() return false end))
protected:emit("property", label, "Text")
assert(pcall(function() protected:clearExactForgeMutationFacts() end) and sinkCalls == 1 and protected:detectorEpoch() == 1, "sink failure must never change invalidation or block clearing authority")
local noReads = setmetatable({ Name = "Private", ClassName = "TextLabel" }, { __index = function(_, key)
	if key == "Parent" then return nil end
	error("must not read property value: " .. key)
end })
protected:expectExactForgeMutationFact(fact(label, function() return false end, function() return false end))
protected:emit("property", noReads, "Text")
assert(#protected.mutationDiagnostics == 1 and protected.mutationDiagnostics[1].path == "Private", "diagnostic collection must never read the unmatched property")

local previous = Policy.isWithinEvidenceRoot
Policy.isWithinEvidenceRoot = function() return true end
local handlers = {}
local gui = instance("Computed")
local function signal(name)
	return { Connect = function(_, callback) handlers[name] = callback; return { Disconnect = function() handlers[name] = nil end } end }
end
gui.Changed = signal("Changed")
gui.AttributeChanged = signal("AttributeChanged")
function gui:IsA() return false end
local computed = Monitor.new(function() error("computed geometry must not invalidate") end, { diagnosticSink = function() error("computed geometry must not log") end })
computed:attachInstance(gui)
computed:expectExactForgeMutationFact(fact(gui, function() return false end, function() return false end))
handlers.Changed("AbsoluteSize")
handlers.Changed("AbsolutePosition")
assert(computed:detectorEpoch() == 0 and #computed.mutationDiagnostics == 0, "computed UI notifications must remain excluded before diagnostics")
computed:destroy()
Policy.isWithinEvidenceRoot = previous
print("Project-change diagnostics passed: unchanged authority and phase budgets, bounded deduplication, reason/location detail, and protected value-free logging")
