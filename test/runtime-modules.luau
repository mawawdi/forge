-- Fixed, repository-owned tests. This runner does not accept candidate code.
local Scope = require("../packages/game-runtime/luau/Scope")
local Event = require("../packages/game-runtime/luau/Event")
local Task = require("../packages/game-runtime/luau/Task")
local StateMachine = require("../packages/game-runtime/luau/StateMachine")
local passed = 0
local function test(name, callback)
	local ok, failure = pcall(callback)
	assert(ok, name .. ": " .. tostring(failure))
	passed += 1
end
local function same(actual, expected)
	assert(actual == expected, "expected " .. tostring(expected) .. ", got " .. tostring(actual))
end

local function scheduler()
	local time = 0
	local queue = {}
	local nextId = 0
	local cancelled = {}
	local threads = {}
	local api = {}
	local function enqueue(delaySeconds, callback)
		nextId += 1
		local worker = coroutine.create(callback)
		table.insert(threads, worker)
		table.insert(queue, { time = time + delaySeconds, id = nextId, worker = worker })
		return worker
	end
	api.now = function() return time end
	api.spawn = function(callback) return enqueue(0, callback) end
	api.delay = enqueue
	api.cancel = function(worker)
		cancelled[worker] = true
		if coroutine.status(worker) ~= "dead" then coroutine.close(worker) end
	end
	local function advance(seconds)
		time += seconds
		local steps = 0
		while #queue > 0 do
			table.sort(queue, function(a, b) return a.time < b.time or (a.time == b.time and a.id < b.id) end)
			if queue[1].time > time then break end
			local item = table.remove(queue, 1)
			if not cancelled[item.worker] then
				local ok, failure = coroutine.resume(item.worker)
				assert(ok, tostring(failure))
			end
			steps += 1
			assert(steps < 1000, "fixed test scheduler exhausted")
		end
	end
	return { api = api, advance = advance, threads = threads }
end

test("Scope invalidates before LIFO error-isolated cleanup", function()
	local scope = Scope.new()
	local generation = scope:Generation()
	local calls = {}
	local guarded = scope:Guard(function() table.insert(calls, "stale") end)
	scope:Defer(function() table.insert(calls, "first") end)
	scope:Defer(function()
		assert(not scope:IsCurrent(generation))
		guarded()
		table.insert(calls, "second")
		error("second failure")
	end)
	scope:Defer(function() table.insert(calls, "third") error("third failure") end)
	local errors = scope:Close()
	same(table.concat(calls, ","), "third,second,first")
	same(#errors, 2)
	same(errors[1].registration, 3)
	same(errors[2].registration, 2)
	same(scope:Generation(), generation + 1)
	same(#scope:Close(), 2)
	same(#calls, 3)
	assert(not pcall(function() scope:Defer(function() end) end))
end)

test("Scope unregister releases cleanup and rejects yielding/add-during-close callbacks", function()
	local scope = Scope.new()
	local removedRan = false
	local release = scope:Defer(function() removedRan = true end)
	release()
	release()
	scope:Defer(function() coroutine.yield() error("resumed unexpectedly") end)
	scope:Defer(function() scope:Defer(function() end) end)
	local errors = scope:Close()
	same(#errors, 2)
	assert(not removedRan)
	assert(string.find(errors[2].message, "must not yield", 1, true))
end)

test("Event FIFO snapshots exclude later connections and recheck disconnections", function()
	local event = Event.new()
	local calls = {}
	local second
	event:Connect(function(value)
		table.insert(calls, "a" .. value)
		if value == "1" then
			second:Disconnect()
			event:Connect(function(nextValue) table.insert(calls, "d" .. nextValue) end)
			event:Fire("2")
			event:Connect(function(nextValue) table.insert(calls, "e" .. nextValue) end)
		end
	end)
	second = event:Connect(function(value) table.insert(calls, "b" .. value) end)
	event:Connect(function(value) table.insert(calls, "c" .. value) end)
	same(#event:Fire("1"), 0)
	same(table.concat(calls, ","), "a1,c1,a2,c2,d2")
end)

test("Event scope closure suppresses pending callbacks and isolates failure/yield", function()
	local scope = Scope.new()
	local event = Event.new()
	local calls = 0
	event:Connect(function() scope:Close() end)
	event:Connect(function() error("stale callback") end, scope)
	event:Connect(function() error("listener failure") end)
	event:Connect(function() coroutine.yield() end)
	event:Connect(function() calls += 1 end)
	same(#event:Fire(), 2)
	same(calls, 1)
	assert(not pcall(function() event:Connect(function() end, scope) end))
end)

test("Event destruction cancels remaining snapshots and nested emissions", function()
	local event = Event.new()
	local calls = 0
	event:Connect(function() event:Fire() event:Destroy() end)
	event:Connect(function() calls += 1 end)
	same(#event:Fire(), 0)
	same(calls, 0)
	assert(not pcall(function() event:Fire() end))
end)

test("Task cancellation before scheduling suppresses work and completion", function()
	local clock = scheduler()
	local scope = Scope.new()
	local calls = 0
	local handle = Task.start(scope, function() calls += 1 end, {
		scheduler = clock.api, deadlineSeconds = 5, onComplete = function() calls += 100 end,
	})
	same(#scope:Close(), 0)
	clock.advance(10)
	same(calls, 0)
	same(handle:Outcome().status, "cancelled")
end)

test("Task completion settles once and removes its deadline/cleanup registration", function()
	local clock = scheduler()
	local scope = Scope.new()
	local completions = 0
	local handle = Task.start(scope, function(token) assert(token:IsCurrent()) return 42 end, {
		scheduler = clock.api, deadlineSeconds = 5, onComplete = function(result) same(result.value, 42) completions += 1 end,
	})
	clock.advance(0)
	same(handle:Outcome().status, "completed")
	same(handle:Outcome().value, 42)
	clock.advance(10)
	handle:Cancel()
	scope:Close()
	same(completions, 1)
end)

test("Task deadline invalidates token even if scheduler cancellation fails to stop work", function()
	local clock = scheduler()
	clock.api.cancel = function() end
	local scope = Scope.new()
	local guarded
	local stale = 0
	local completions = 0
	local handle = Task.start(scope, function(token)
		guarded = token:Guard(function() stale += 1 end)
		coroutine.yield()
		guarded()
		return "late"
	end, { scheduler = clock.api, deadlineSeconds = 5, onComplete = function() completions += 1 end })
	clock.advance(0)
	clock.advance(5)
	same(handle:Outcome().status, "timed_out")
	guarded()
	local work = clock.threads[2]
	assert(coroutine.resume(work))
	same(stale, 0)
	same(completions, 1)
	same(handle:Outcome().status, "timed_out")
end)

test("Task cleanup errors aggregate through Scope while remaining cleanup runs", function()
	local clock = scheduler()
	clock.api.cancel = function() error("cancel failed") end
	local scope = Scope.new()
	local after = false
	scope:Defer(function() after = true end)
	local handle = Task.start(scope, function() coroutine.yield() end, { scheduler = clock.api, deadlineSeconds = 5 })
	clock.advance(0)
	local errors = scope:Close()
	same(#errors, 1)
	same(#handle:Outcome().cleanupErrors, 2)
	assert(after)
	for _, worker in clock.threads do if coroutine.status(worker) ~= "dead" then coroutine.close(worker) end end
end)

test("Task catches work failures and zero deadline prevents work", function()
	local clock = scheduler()
	local scope = Scope.new()
	local failed = Task.start(scope, function() error("work failed") end, { scheduler = clock.api })
	local zero = Task.start(scope, function() error("must not start") end, { scheduler = clock.api, deadlineSeconds = 0 })
	clock.advance(0)
	same(failed:Outcome().status, "failed")
	assert(string.find(failed:Outcome().message, "work failed", 1, true))
	same(zero:Outcome().status, "timed_out")
	scope:Close()
end)

test("StateMachine accepts arbitrary cyclic graphs with deterministic ordered replay", function()
	local graph = { initial = "amber", states = { "amber", "violet", "silver" }, transitions = {
		{ from = "amber", event = "rotate", to = "violet" },
		{ from = "violet", event = "rotate", to = "silver" },
		{ from = "silver", event = "rotate", to = "amber" },
	} }
	local first = StateMachine.new(graph)
	local second = StateMachine.new(graph)
	graph.transitions[1].to = "silver"
	for _ = 1, 100 do
		local a, b = first:Send("rotate"), second:Send("rotate")
		assert(a.accepted and b.accepted)
		same(a.state, b.state)
		same(a.sequence, b.sequence)
	end
	same(first:GetState(), "violet")
	same(first:Snapshot().sequence, 100)
	same(first:Send("unmapped").reason, "no_transition")
	first:Destroy()
	same(first:Send("rotate").reason, "closed")
end)

test("StateMachine ordered guards fail without committing and cannot reenter", function()
	local machine
	machine = StateMachine.new({ initial = "x", states = { "x", "y", "z" }, transitions = {
		{ from = "x", event = "select", to = "y", guard = function(payload)
			same(machine:Send("select").reason, "reentrant")
			return payload == "y"
		end },
		{ from = "x", event = "select", to = "z" },
		{ from = "z", event = "invalid", to = "x", guard = function() coroutine.yield() return true end },
	} })
	same(machine:Send("select", "z").state, "z")
	same(machine:Send("invalid").reason, "guard_failed")
	same(machine:Snapshot().sequence, 1)
	assert(not pcall(function() StateMachine.new({ initial = "missing", states = { "x" }, transitions = {} }) end))
end)

print("ForgeRuntime real Luau tests passed: " .. tostring(passed))
