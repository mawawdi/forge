--!strict
-- ForgeRuntime, MIT. ABI forge-runtime@2.
local Event = {}
local methods = {}
methods.__index = methods

type Scope = {
	IsOpen: (self: any) -> boolean,
	Generation: (self: any) -> number,
	IsCurrent: (self: any, generation: number) -> boolean,
	Defer: (self: any, cleanup: () -> ()) -> (() -> ()),
}
export type Connection = { Connected: boolean, Disconnect: (self: Connection) -> () }
export type DeliveryError = { listener: number, message: string }
type Listener = { id: number, callback: (...any) -> (), connection: Connection, scope: Scope?, generation: number?, release: (() -> ())? }
type Emission = { arguments: { [any]: any }, listeners: { Listener } }
export type Event = {
	_closed: boolean,
	_firing: boolean,
	_nextId: number,
	_listeners: { [number]: Listener },
	_queue: { Emission },
	Connect: (self: Event, callback: (...any) -> (), scope: Scope?) -> Connection,
	Fire: (self: Event, ...any) -> { DeliveryError },
	Destroy: (self: Event) -> (),
}

function Event.new(): Event
	return setmetatable({ _closed = false, _firing = false, _nextId = 0, _listeners = {}, _queue = {} }, methods) :: any
end

function methods.Connect(self: Event, callback: (...any) -> (), scope: Scope?): Connection
	assert(not self._closed, "Cannot connect to a destroyed Event")
	assert(type(callback) == "function", "Event listener must be a function")
	if scope then assert(scope:IsOpen(), "Cannot connect with a closed Scope") end
	self._nextId += 1
	local id = self._nextId
	local connection: Connection = { Connected = true, Disconnect = function() end }
	local listener: Listener = {
		id = id, callback = callback, connection = connection,
		scope = scope, generation = if scope then scope:Generation() else nil,
	}
	function connection.Disconnect(_connection: Connection)
		if not connection.Connected then return end
		connection.Connected = false
		self._listeners[id] = nil
		if listener.release then
			listener.release()
			listener.release = nil
		end
	end
	self._listeners[id] = listener
	if scope then listener.release = scope:Defer(function() connection:Disconnect() end) end
	return connection
end

-- Reentrant emissions queue FIFO. Each emission captures its listener set at
-- Fire time, then rechecks connection/scope liveness before every callback.
-- Listeners are synchronous; failures and yields do not stop later listeners.
function methods.Fire(self: Event, ...: any): { DeliveryError }
	assert(not self._closed, "Cannot fire a destroyed Event")
	local snapshot = {}
	for _, listener in self._listeners do table.insert(snapshot, listener) end
	table.sort(snapshot, function(a, b) return a.id < b.id end)
	table.insert(self._queue, { arguments = table.pack(...), listeners = snapshot })
	if self._firing then return {} end
	self._firing = true
	local errors: { DeliveryError } = {}
	local index = 1
	while index <= #self._queue and not self._closed do
		local emission = self._queue[index]
		index += 1
		for _, listener in emission.listeners do
			if self._closed then break end
			if not listener.connection.Connected then continue end
			if listener.scope and not listener.scope:IsCurrent(listener.generation :: number) then continue end
			local worker = coroutine.create(listener.callback)
			local ok, result = coroutine.resume(worker, table.unpack(emission.arguments, 1, emission.arguments.n))
			local message: string? = nil
			if not ok then
				local printable, text = pcall(tostring, result)
				message = if printable then text else "Event listener raised an unprintable error"
			elseif coroutine.status(worker) ~= "dead" then
				message = "Event listener must not yield"
			end
			if coroutine.status(worker) ~= "dead" then pcall(coroutine.close, worker) end
			if message then table.insert(errors, { listener = listener.id, message = message }) end
		end
	end
	self._queue = {}
	self._firing = false
	return errors
end

function methods.Destroy(self: Event)
	if self._closed then return end
	self._closed = true
	local listeners = self._listeners
	self._listeners = {}
	self._queue = {}
	for _, listener in listeners do listener.connection:Disconnect() end
end

return table.freeze(Event)
