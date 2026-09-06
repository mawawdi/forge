--!strict
-- ForgeRuntime, MIT. ABI forge-runtime@2. No Promise dependency.
local Task = {}

type Scope = {
	IsOpen: (self: any) -> boolean,
	Generation: (self: any) -> number,
	IsCurrent: (self: any, generation: number) -> boolean,
	Defer: (self: any, cleanup: () -> ()) -> (() -> ()),
}
export type Scheduler = {
	spawn: (callback: () -> ()) -> thread,
	delay: (seconds: number, callback: () -> ()) -> thread,
	cancel: (worker: thread) -> (),
	now: () -> number,
}
export type Status = "completed" | "failed" | "cancelled" | "timed_out"
export type Outcome = { status: Status, value: any?, message: string?, cleanupErrors: { string } }
export type Token = { IsCurrent: (self: Token) -> boolean, Guard: (self: Token, callback: (...any) -> ...any) -> ((...any) -> ...any) }
export type Handle = { Cancel: (self: Handle) -> Outcome?, Outcome: (self: Handle) -> Outcome? }
export type Options = { deadlineSeconds: number?, scheduler: Scheduler?, onComplete: ((outcome: Outcome) -> ())? }

local function describe(value: any): string
	local ok, message = pcall(tostring, value)
	return if ok then message else "Task raised an unprintable error"
end

function Task.start(scope: Scope, work: (token: Token) -> any, options: Options?): Handle
	assert(scope:IsOpen(), "Cannot start a Task in a closed Scope")
	assert(type(work) == "function", "Task work must be a function")
	local settings: Options = options or {}
	local scheduler: Scheduler = settings.scheduler or {
		spawn = function(callback: () -> ()): thread return task.spawn(callback) end,
		delay = function(delaySeconds: number, callback: () -> ()): thread return task.delay(delaySeconds, callback) end,
		cancel = function(pending: thread) task.cancel(pending) end,
		now = os.clock,
	}
	local seconds = settings.deadlineSeconds
	if seconds ~= nil then assert(seconds >= 0 and seconds < math.huge, "Task deadline must be finite and nonnegative") end
	local generation = scope:Generation()
	local deadline = if seconds ~= nil then scheduler.now() + seconds else nil
	local active = true
	local outcome: Outcome? = nil
	local worker: thread? = nil
	local timer: thread? = nil
	local release: (() -> ())? = nil
	local token: Token = { IsCurrent = function() return false end, Guard = function() return function() end end }
	local handle: Handle = { Cancel = function() return nil end, Outcome = function() return outcome end }
	local function current(): boolean
		return active and scope:IsCurrent(generation) and (deadline == nil or scheduler.now() < deadline)
	end
	local function cancel(pending: thread?, result: Outcome)
		if pending and pending ~= coroutine.running() and coroutine.status(pending) ~= "dead" then
			local ok, failure = pcall(function(): any
				scheduler.cancel(pending)
				return nil
			end)
			if not ok then table.insert(result.cleanupErrors, describe(failure)) end
		end
	end
	local function settle(status: Status, value: any?, message: string?)
		if not active then return end
		active = false
		local result: Outcome = { status = status, value = value, message = message, cleanupErrors = {} }
		outcome = result
		if release then
			release()
			release = nil
		end
		cancel(timer, result)
		cancel(worker, result)
		if settings.onComplete and scope:IsCurrent(generation) then
			local callback = coroutine.create(settings.onComplete)
			local ok, failure = coroutine.resume(callback, result)
			if not ok then table.insert(result.cleanupErrors, describe(failure))
			elseif coroutine.status(callback) ~= "dead" then table.insert(result.cleanupErrors, "Task completion callback must not yield") end
			if coroutine.status(callback) ~= "dead" then pcall(coroutine.close, callback) end
		end
	end
	function token.IsCurrent(_self: Token): boolean return current() end
	function token.Guard(_self: Token, callback: (...any) -> ...any): (...any) -> ...any
		return function(...: any): ...any
			if current() then return callback(...) end
			return nil
		end
	end
	function handle.Cancel(_self: Handle): Outcome?
		settle("cancelled", nil, nil)
		return outcome
	end
	release = scope:Defer(function()
		handle:Cancel()
		if outcome and #outcome.cleanupErrors > 0 then error(table.concat(outcome.cleanupErrors, "; ")) end
	end)
	if seconds ~= nil then
		local ok, result = pcall(scheduler.delay, seconds, function() settle("timed_out", nil, "Task deadline expired") end)
		if not ok then
			settle("failed", nil, describe(result))
			return handle
		end
		timer = result
		if outcome then
			-- A scheduler may invoke its callback before returning the handle.
			cancel(timer, outcome)
			return handle
		end
	end
	local ok, result = pcall(scheduler.spawn, function()
		if not current() then
			if active then settle("timed_out", nil, "Task deadline expired before work started") end
			return
		end
		local completed, value = pcall(work, token)
		if not active or not scope:IsCurrent(generation) then return end
		if not current() then settle("timed_out", nil, "Task deadline expired")
		elseif completed then settle("completed", value, nil)
		else settle("failed", nil, describe(value)) end
	end)
	if not ok then
		settle("failed", nil, describe(result))
	else
		worker = result
		-- task.spawn resumes immediately. Work can close its Scope and yield
		-- before this assignment, so settlement must also release late handles.
		if outcome then cancel(worker, outcome) end
	end
	return handle
end

return table.freeze(Task)
