-- Fixed repository-owned tests; no candidate source, native networking, or Studio operation.
local Network = require("../packages/game-runtime/luau/Network")
local Scope = require("../packages/game-runtime/luau/Scope")
local passed = 0
local function test(name, callback)
	local ok, failure = pcall(callback)
	assert(ok, name .. ": " .. tostring(failure))
	passed += 1
end
local function same(actual, expected)
	assert(actual == expected, "expected " .. tostring(expected) .. ", got " .. tostring(actual))
end
local function allow() return true end
local function policy()
	return {
		maximumActors = 2, maximumDepth = 8, maximumNodes = 64, maximumBytes = 256,
		intents = {
			use = { capacity = 4, refillPerSecond = 2, schema = { kind = "object", fields = {
				target = { kind = "string", maximumBytes = 16 },
				amount = { kind = "number", minimum = 0, maximum = 10, integer = true },
			}, optional = { "amount" } } },
			inspect = { capacity = 2, refillPerSecond = 1, schema = { kind = "boolean" } },
		},
	}
end
local function gate(config)
	local result = Network.new(config or policy())
	assert(result:Register("a"))
	return result
end

test("closed copied schemas and payloads resist caller mutation", function()
	local config = policy()
	local g = gate(config)
	config.intents.use.schema.fields.target.maximumBytes = 1
	config.intents.use.capacity = 0
	local input = { target = "door", amount = 2 }
	local result = g:Admit("a", "use", 1, input, 0, function(actor, intent, value, sequence)
		same(actor, "a") same(intent, "use") same(sequence, 1)
		assert(table.isfrozen(value))
		return value.target == "door"
	end)
	assert(result.accepted and result.payload ~= input)
	input.target = "changed"
	same(result.payload.target, "door")
	assert(not pcall(function() result.payload.target = "changed" end))
end)

test("malformed values are rejected before contextual callbacks", function()
	local calls = 0
	local metaCalls = 0
	local bad = {
		{ target = "door", actor = "b" },
		{ target = "door", amount = 0 / 0 },
		{ target = "door", amount = math.huge },
		{ target = "door", amount = 0.5 },
		{ target = string.rep("a", 17) },
		{ target = string.char(255) },
		{ amount = 1 },
		{ target = function() end },
		setmetatable({}, { __index = function() metaCalls += 1 return "door" end }),
	}
	for _, payload in bad do
		local result = gate():Admit("a", "use", 1, payload, 0, function() calls += 1 return true end)
		same(result.reason, "payload")
	end
	same(calls, 0) same(metaCalls, 0)
end)

test("sequences span intents and rejected contexts consume their envelope sequence", function()
	local g = gate()
	assert(g:Admit("a", "use", 3, { target = "door" }, 0, allow).accepted)
	same(g:Admit("a", "inspect", 3, true, 0, allow).reason, "sequence")
	same(g:Admit("a", "inspect", 2, true, 0, allow).reason, "sequence")
	same(g:Admit("a", "use", 4, { target = "door" }, 0, function() return false end).reason, "context")
	same(g:Admit("a", "use", 4, { target = "door" }, 0, allow).reason, "sequence")
	assert(g:Admit("a", "inspect", 5, true, 0, allow).accepted)
	for _, sequence in { 0, -1, 0.5, 0 / 0, math.huge, 9007199254740992, "6" } do
		same(g:Admit("a", "inspect", sequence, true, 0, allow).reason, "sequence")
	end
end)

test("rate limits isolate actors and intents and refill from finite monotonic clocks", function()
	local config = policy() config.intents.use.capacity = 1
	local g = gate(config) assert(g:Register("b"))
	assert(g:Admit("a", "use", 1, { target = "door" }, 1, allow).accepted)
	same(g:Admit("a", "use", 2, { target = "door" }, 1, allow).reason, "rate")
	assert(g:Admit("b", "use", 1, { target = "door" }, 1, allow).accepted)
	assert(g:Admit("a", "inspect", 3, true, 1, allow).accepted)
	assert(g:Admit("a", "use", 4, { target = "door" }, 1.5, allow).accepted)
	for _, now in { 1.4, -1, 0 / 0, math.huge, "2" } do
		same(g:Admit("a", "use", 5, { target = "door" }, now, allow).reason, "clock")
	end
end)

test("context rejection error yield and reentrancy cannot produce admission", function()
	local g = gate()
	local worker
	local priorEffect = 0
	local result = g:Admit("a", "use", 1, { target = "door" }, 0, function()
		priorEffect += 1
		worker = coroutine.running()
		coroutine.yield()
		return true
	end)
	same(result.reason, "context") same(coroutine.status(worker), "dead")
	same(priorEffect, 1) -- Enforcement does not undo effects before the yield.
	same(g:Admit("a", "use", 2, { target = "door" }, 0, function() error("context failed") end).reason, "context")
	same(g:Admit("a", "use", 3, { target = "door" }, 0, function() return "truthy" end).reason, "context")
	assert(g:Admit("a", "use", 4, { target = "door" }, 0, function()
		same(g:Admit("a", "inspect", 5, true, 0, allow).reason, "busy")
		return true
	end).accepted)
end)

test("actor removal and closure invalidate in-flight admission and release bounded slots", function()
	local g = gate() assert(g:Register("b")) assert(not g:Register("c"))
	assert(not g:Register(0 / 0))
	same(g:Admit("a", "use", 1, { target = "door" }, 0, function() g:Remove("a") return true end).reason, "stale")
	same(g:Admit("a", "use", 2, { target = "door" }, 0, allow).reason, "unknown_actor")
	assert(g:Register("c"))
	same(g:Admit("b", "use", 1, { target = "door" }, 0, function() g:Close() return true end).reason, "stale")
	assert(not g:Register("a"))
	same(g:Admit("c", "inspect", 1, true, 0, allow).reason, "closed")
	g:Close()
end)

test("schema and payload depth node byte and array bounds fail closed", function()
	local config = policy()
	config.intents.use.schema = { kind = "array", maximumItems = 2, items = { kind = "string", maximumBytes = 20 } }
	for _, payload in { { [2] = "sparse" }, { "a", "b", "c" }, { extra = "key" } } do
		same(gate(config):Admit("a", "use", 1, payload, 0, allow).reason, "payload")
	end
	config.maximumNodes = 2
	same(gate(config):Admit("a", "use", 1, { "a", "b" }, 0, allow).reason, "payload")
	config.maximumNodes = 64 config.maximumBytes = 3
	same(gate(config):Admit("a", "use", 1, { "aaaa" }, 0, allow).reason, "payload")
	config.maximumBytes = 256 config.maximumDepth = 1
	same(gate(config):Admit("a", "use", 1, { "a" }, 0, allow).reason, "payload")
	local cycle = { kind = "array", maximumItems = 1 } cycle.items = cycle
	config.intents.use.schema = cycle
	assert(not pcall(Network.new, config))
	config = policy() config.intents.use.schema.optional = false
	assert(not pcall(Network.new, config))
	config = policy() config.intents.use.schema.fields.target.enum = false
	assert(not pcall(Network.new, config))
	config = policy() config.intents.use.refillPerSecond = math.huge
	assert(not pcall(Network.new, config))
end)

local function signal()
	local callbacks = {}
	local disconnected = 0
	local failDisconnect = false
	local value = {}
	function value:Connect(callback)
		table.insert(callbacks, callback)
		local live = true
		return { Disconnect = function()
			if not live then return end
			live = false disconnected += 1
			if failDisconnect then error("injected disconnect failure") end
		end }
	end
	function value:Fire(...) for _, callback in callbacks do callback(...) end end -- Also exercises queued callbacks after disconnect.
	function value:Count() return disconnected end
	function value:FailDisconnect() failDisconnect = true end
	return value
end
local function ports()
	local requests, removing = signal(), signal()
	local players = { PlayerRemoving = removing }
	function players:IsA(name) return name == "Players" end
	local actor = { Parent = players, UserId = 1 }
	function players:GetPlayerByUserId(id) return if id == 1 then actor else nil end
	local remote = { OnServerEvent = requests, IsA = function(_, name) return name == "RemoteEvent" end }
	local server = { IsServer = function() return true end }
	return requests, removing, players, actor, remote, server
end

test("server adapter preserves OnServerEvent actor and removal rejects queued requests", function()
	local requests, removing, players, actor, remote, server = ports()
	local scope, g = Scope.new(), Network.new(policy())
	local deliveries = {}
	Network.bindRemoteEvent(scope, server, players, remote, g, function(player, _intent, payload)
		return player == actor and payload.target == "door"
	end, function(player, intent, payload, sequence) table.insert(deliveries, { player, intent, payload, sequence }) end, function() return 0 end)
	requests:Fire(actor, "use", 1, { target = "wrong-context" })
	requests:Fire(actor, "use", 2, { target = "door", actor = "forged" })
	requests:Fire(actor, "use", 3, { target = "door" }, "extra")
	requests:Fire(actor, "use", 3, { target = "door" })
	same(#deliveries, 1) same(deliveries[1][1], actor)
	removing:Fire(actor) -- Parent can remain set while PlayerRemoving dispatches.
	requests:Fire(actor, "use", 4, { target = "door" })
	same(#deliveries, 1)
	same(#scope:Close(), 0)
	same(requests:Count(), 1) same(removing:Count(), 1)
	requests:Fire(actor, "use", 5, { target = "door" })
	same(#deliveries, 1)
end)

test("server adapter rejects client context before connecting and isolates cleanup failures", function()
	local requests, removing, players, _actor, remote, server = ports()
	local scope = Scope.new()
	assert(not pcall(Network.bindRemoteEvent, scope, { IsServer = function() return false end }, players, remote, Network.new(policy()), allow, function() end))
	local g = Network.new(policy())
	Network.bindRemoteEvent(scope, server, players, remote, g, allow, function() end)
	requests:FailDisconnect()
	same(#scope:Close(), 1)
	same(requests:Count(), 1) same(removing:Count(), 1)
	assert(not g:IsOpen())
end)

test("server adapter setup failures disconnect earlier registrations", function()
	local _requests, removing, players, _actor, remote, server = ports()
	remote.OnServerEvent = { Connect = function() error("injected connect failure") end }
	local g = Network.new(policy())
	assert(not pcall(Network.bindRemoteEvent, Scope.new(), server, players, remote, g, allow, function() end))
	same(removing:Count(), 1)
	assert(not g:IsOpen())
end)

print("Network runtime tests passed: " .. tostring(passed))
