-- Fixed repository regression cases, never candidate source execution.
local Scope = require("../packages/game-runtime/luau/Scope")
local Task = require("../packages/game-runtime/luau/Task")
local passed = 0
local function test(name, callback)
	local ok, failure = pcall(callback)
	assert(ok, name .. ": " .. tostring(failure))
	passed += 1
end

-- Roblox task.spawn resumes immediately before returning the scheduled thread.
-- A queued-only scheduler cannot expose acquisition after scope cancellation.
local function immediateScheduler()
	local threads = {}
	local cancelled = {}
	local api = {}
	api.now = function() return 0 end
	api.spawn = function(callback)
		local worker = coroutine.create(callback)
		table.insert(threads, worker)
		local ok, failure = coroutine.resume(worker)
		assert(ok, tostring(failure))
		return worker
	end
	api.delay = function(_seconds, callback)
		local timer = coroutine.create(callback)
		table.insert(threads, timer)
		return timer
	end
	api.cancel = function(worker)
		assert(worker ~= coroutine.running(), "must not cancel the executing cleanup")
		table.insert(cancelled, worker)
		coroutine.close(worker)
	end
	return { api = api, threads = threads, cancelled = cancelled }
end

test("first-resume scope closure cancels a worker acquired after settlement", function()
	local scheduler = immediateScheduler()
	local scope = Scope.new()
	local resumed = false
	local completions = 0
	local handle = Task.start(scope, function()
		assert(#scope:Close() == 0)
		coroutine.yield()
		resumed = true
	end, { scheduler = scheduler.api, onComplete = function() completions += 1 end })
	assert(handle:Outcome().status == "cancelled")
	assert(#handle:Outcome().cleanupErrors == 0)
	assert(#scheduler.cancelled == 1)
	assert(coroutine.status(scheduler.threads[1]) == "dead")
	assert(not coroutine.resume(scheduler.threads[1]))
	assert(not resumed and completions == 0)
end)

test("first-resume cancellation releases both a deadline and the late worker exactly once", function()
	local scheduler = immediateScheduler()
	local scope = Scope.new()
	local handle = Task.start(scope, function()
		scope:Close()
		coroutine.yield()
	end, { scheduler = scheduler.api, deadlineSeconds = 10 })
	assert(handle:Outcome().status == "cancelled")
	assert(#scheduler.cancelled == 2)
	for _, worker in scheduler.threads do assert(coroutine.status(worker) == "dead") end
	handle:Cancel()
	scope:Close()
	assert(#scheduler.cancelled == 2)
end)

test("immediate successful work does not cancel its own executing thread", function()
	local scheduler = immediateScheduler()
	local scope = Scope.new()
	local completions = 0
	local handle = Task.start(scope, function() return "ready" end, {
		scheduler = scheduler.api,
		deadlineSeconds = 10,
		onComplete = function() completions += 1 end,
	})
	assert(handle:Outcome().status == "completed" and handle:Outcome().value == "ready")
	assert(#handle:Outcome().cleanupErrors == 0)
	assert(#scheduler.cancelled == 1 and completions == 1)
	scope:Close()
	assert(#scheduler.cancelled == 1 and completions == 1)
end)

test("completion after resumption never cancels the currently executing worker", function()
	local scheduler = immediateScheduler()
	local scope = Scope.new()
	local handle = Task.start(scope, function()
		coroutine.yield()
		return "resumed"
	end, { scheduler = scheduler.api })
	assert(handle:Outcome() == nil)
	assert(coroutine.resume(scheduler.threads[1]))
	assert(handle:Outcome().status == "completed" and handle:Outcome().value == "resumed")
	assert(#scheduler.cancelled == 0 and #handle:Outcome().cleanupErrors == 0)
	scope:Close()
end)

test("scope cleanup cannot close an executing ancestor and retains the cancellation failure", function()
	local scheduler = immediateScheduler()
	local scope = Scope.new()
	local handle = Task.start(scope, function(token)
		coroutine.yield()
		-- Scope runs each disposer in a separate coroutine. This work thread is
		-- its active ancestor, which cancellation cannot synchronously close.
		assert(#scope:Close() == 1)
		assert(not token:IsCurrent())
	end, { scheduler = scheduler.api })
	assert(coroutine.resume(scheduler.threads[1]))
	assert(handle:Outcome().status == "cancelled")
	assert(#handle:Outcome().cleanupErrors == 1)
	assert(coroutine.status(scheduler.threads[1]) == "dead")
end)

test("deadline settlement during timer acquisition prevents work dispatch", function()
	local scheduler = immediateScheduler()
	local scope = Scope.new()
	local spawns = 0
	local completions = 0
	scheduler.api.delay = function(_seconds, callback)
		local timer = coroutine.create(function()
			callback()
			coroutine.yield()
		end)
		table.insert(scheduler.threads, timer)
		assert(coroutine.resume(timer))
		return timer
	end
	scheduler.api.spawn = function() spawns += 1; error("work must not dispatch") end
	local handle = Task.start(scope, function() error("work must not run") end, {
		scheduler = scheduler.api, deadlineSeconds = 0,
		onComplete = function() completions += 1 end,
	})
	assert(handle:Outcome().status == "timed_out")
	assert(spawns == 0 and completions == 1)
	assert(#scheduler.cancelled == 1)
	assert(coroutine.status(scheduler.threads[1]) == "dead")
	scope:Close()
end)

test("late cancellation failures remain visible and the token stays invalid", function()
	local scheduler = immediateScheduler()
	local scope = Scope.new()
	local guardedCalls = 0
	scheduler.api.cancel = function() error("late scheduler cancellation failed") end
	local handle = Task.start(scope, function(token)
		local guarded = token:Guard(function() guardedCalls += 1 end)
		scope:Close()
		coroutine.yield()
		guarded()
	end, { scheduler = scheduler.api })
	assert(handle:Outcome().status == "cancelled")
	assert(#handle:Outcome().cleanupErrors == 1)
	assert(string.find(handle:Outcome().cleanupErrors[1], "late scheduler cancellation failed", 1, true))
	-- A failed native cancellation is not confinement of arbitrary task effects.
	assert(coroutine.resume(scheduler.threads[1]))
	assert(guardedCalls == 0)
end)

print("ForgeRuntime immediate Task tests passed: " .. tostring(passed))
