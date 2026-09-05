--!strict
-- ForgeRuntime, MIT. ABI forge-runtime@1.
local StateMachine = {}
local methods = {}
methods.__index = methods

export type Transition = { from: string, event: string, to: string, guard: ((payload: any) -> boolean)? }
export type Graph = { initial: string, states: { string }, transitions: { Transition } }
export type Result = { accepted: boolean, state: string, sequence: number, reason: string?, message: string? }
export type Machine = {
	_state: string,
	_sequence: number,
	_closed: boolean,
	_busy: boolean,
	_transitions: { Transition },
	GetState: (self: Machine) -> string,
	Snapshot: (self: Machine) -> { state: string, sequence: number },
	Send: (self: Machine, event: string, payload: any?) -> Result,
	Destroy: (self: Machine) -> (),
}

function StateMachine.new(graph: Graph): Machine
	local states: { [string]: boolean } = {}
	for _, state in graph.states do
		assert(type(state) == "string" and #state > 0 and not states[state], "State IDs must be unique nonempty strings")
		states[state] = true
	end
	assert(states[graph.initial], "Initial state must exist in graph")
	local transitions = {}
	for _, transition in graph.transitions do
		assert(states[transition.from] and states[transition.to], "Transition states must exist in graph")
		assert(type(transition.event) == "string" and #transition.event > 0, "Transition event must be a nonempty string")
		assert(transition.guard == nil or type(transition.guard) == "function", "Transition guard must be a function")
		table.insert(transitions, table.freeze(table.clone(transition)))
	end
	return setmetatable({ _state = graph.initial, _sequence = 0, _closed = false, _busy = false, _transitions = transitions }, methods) :: any
end

function methods.GetState(self: Machine): string return self._state end

function methods.Snapshot(self: Machine): { state: string, sequence: number }
	return { state = self._state, sequence = self._sequence }
end

-- Ordered guards select the first matching edge. Guards must not yield.
-- This tracks logical state only; it does not roll back arbitrary guard effects.
function methods.Send(self: Machine, event: string, payload: any?): Result
	if self._closed or self._busy then
		return { accepted = false, state = self._state, sequence = self._sequence, reason = if self._closed then "closed" else "reentrant" }
	end
	self._busy = true
	for _, transition in self._transitions do
		if transition.from ~= self._state or transition.event ~= event then continue end
		local allowed = true
		if transition.guard then
			local worker = coroutine.create(transition.guard)
			local ok, value = coroutine.resume(worker, payload)
			local yielded = coroutine.status(worker) ~= "dead"
			if yielded then pcall(coroutine.close, worker) end
			if not ok or yielded or type(value) ~= "boolean" then
				self._busy = false
				return { accepted = false, state = self._state, sequence = self._sequence, reason = "guard_failed", message = if yielded then "StateMachine guard must not yield" else "StateMachine guard failed or did not return boolean" }
			end
			allowed = value
		end
		if self._closed then break end
		if allowed then
			self._state = transition.to
			self._sequence += 1
			self._busy = false
			return { accepted = true, state = self._state, sequence = self._sequence }
		end
	end
	self._busy = false
	return { accepted = false, state = self._state, sequence = self._sequence, reason = if self._closed then "closed" else "no_transition" }
end

function methods.Destroy(self: Machine)
	self._closed = true
	self._transitions = {}
end

return table.freeze(StateMachine)
