--!strict
-- ForgeRuntime, MIT. ABI forge-runtime@2.
local Scope = {}
local methods = {}
methods.__index = methods

export type CleanupError = { registration: number, message: string }
export type Scope = {
	_open: boolean,
	_generation: number,
	_nextId: number,
	_entries: { [number]: () -> () },
	_errors: { CleanupError },
	IsOpen: (self: Scope) -> boolean,
	Generation: (self: Scope) -> number,
	IsCurrent: (self: Scope, generation: number) -> boolean,
	Defer: (self: Scope, cleanup: () -> ()) -> (() -> ()),
	Guard: (self: Scope, callback: (...any) -> ...any) -> ((...any) -> ...any),
	Close: (self: Scope) -> { CleanupError },
}

local function describe(value: any): string
	local ok, message = pcall(tostring, value)
	return if ok then message else "Cleanup raised an unprintable error"
end

function Scope.new(): Scope
	return setmetatable({
		_open = true,
		_generation = 0,
		_nextId = 0,
		_entries = {},
		_errors = {},
	}, methods) :: any
end

function methods.IsOpen(self: Scope): boolean
	return self._open
end

function methods.Generation(self: Scope): number
	return self._generation
end

function methods.IsCurrent(self: Scope, generation: number): boolean
	return self._open and self._generation == generation
end

-- Returns an idempotent unregister function. Unregistering does not run cleanup.
function methods.Defer(self: Scope, cleanup: () -> ()): () -> ()
	assert(self._open, "Cannot add cleanup to a closed Scope")
	assert(type(cleanup) == "function", "Scope cleanup must be a function")
	self._nextId += 1
	local id = self._nextId
	self._entries[id] = cleanup
	return function()
		self._entries[id] = nil
	end
end

function methods.Guard(self: Scope, callback: (...any) -> ...any): (...any) -> ...any
	assert(self._open, "Cannot create a guard on a closed Scope")
	local generation = self._generation
	return function(...: any): ...any
		if self:IsCurrent(generation) then
			return callback(...)
		end
		return nil
	end
end

-- LIFO, synchronous, error-isolated disposal. A yielding cleanup is closed and
-- recorded as an error; arbitrary unregistered side effects are not controlled.
function methods.Close(self: Scope): { CleanupError }
	if not self._open then
		return table.clone(self._errors)
	end
	self._open = false
	self._generation += 1
	local entries = self._entries
	self._entries = {}
	local ids = {}
	for id in entries do
		table.insert(ids, id)
	end
	table.sort(ids, function(a, b) return a > b end)
	for _, id in ids do
		local worker = coroutine.create(entries[id])
		local ok, result = coroutine.resume(worker)
		local message: string? = nil
		if not ok then
			message = describe(result)
		elseif coroutine.status(worker) ~= "dead" then
			message = "Scope cleanup must not yield"
		end
		if coroutine.status(worker) ~= "dead" then
			pcall(coroutine.close, worker)
		end
		if message then
			table.insert(self._errors, { registration = id, message = message })
		end
	end
	return table.clone(self._errors)
end

return table.freeze(Scope)
