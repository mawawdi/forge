--!strict
-- ForgeRuntime, MIT. ABI forge-runtime@2.
-- Server admission is not a transaction, authority over arbitrary source, or wire-size proof.
-- Game callbacks own permission/phase/target/range checks and consequential commits.
local Network = {}

export type Schema = {
	kind: string,
	minimum: number?, maximum: number?, integer: boolean?,
	maximumBytes: number?, enum: { string }?,
	maximumItems: number?, items: Schema?,
	fields: { [string]: Schema }?, optional: { string }?,
}
export type Intent = { schema: Schema, capacity: number, refillPerSecond: number }
export type Policy = {
	intents: { [string]: Intent },
	maximumActors: number, maximumDepth: number, maximumNodes: number, maximumBytes: number,
}
export type Result = { accepted: boolean, reason: string?, payload: any? }
export type ContextCheck = (actor: any, intent: string, payload: any, sequence: number) -> boolean
export type Gate = {
	Register: (self: Gate, actor: any) -> boolean,
	Remove: (self: Gate, actor: any) -> (),
	Admit: (self: Gate, actor: any, intent: any, sequence: any, payload: any, now: any, validateContext: ContextCheck) -> Result,
	Close: (self: Gate) -> (),
	IsOpen: (self: Gate) -> boolean,
}
type ActorState = { sequence: number, lastNow: number, busy: boolean, buckets: { [string]: { tokens: number, at: number } } }
type Budget = { nodes: number, bytes: number, maximumDepth: number, maximumNodes: number, maximumBytes: number, seen: { [any]: boolean } }
local SAFE_INTEGER = 9007199254740991

local function finite(value: any): boolean
	return type(value) == "number" and value == value and value > -math.huge and value < math.huge
end
local function integer(value: any, minimum: number, maximum: number): boolean
	return finite(value) and value % 1 == 0 and value >= minimum and value <= maximum
end
local function plain(value: any): boolean
	return type(value) == "table" and getmetatable(value) == nil
end
local function validActor(value: any): boolean
	return type(value) == "string" or type(value) == "table" or typeof(value) == "Instance"
end
local function exact(value: any, allowed: { [string]: boolean })
	assert(plain(value), "Policy/schema must be plain tables")
	for key in value do assert(type(key) == "string" and allowed[key], "Unknown policy/schema field") end
end
local function boundedArray(value: any, maximum: number): number
	assert(plain(value), "Schema arrays must be plain tables")
	local count = 0
	for key in value do
		count += 1
		assert(integer(key, 1, maximum) and count <= maximum, "Invalid schema array")
	end
	for index = 1, count do assert(rawget(value, index) ~= nil, "Schema arrays must be dense") end
	return count
end

-- A closed, copied schema prevents later caller mutations changing admitted payload meaning.
local function compileSchema(schema: any, depth: number, budget: { count: number, active: { [any]: boolean } }): any
	assert(plain(schema) and depth <= 16 and not budget.active[schema], "Invalid/deep/cyclic schema")
	budget.count += 1
	assert(budget.count <= 256, "Schema declaration budget exceeded")
	budget.active[schema] = true
	local compiled: any = { kind = schema.kind }
	if schema.kind == "boolean" then
		exact(schema, { kind = true })
	elseif schema.kind == "number" then
		exact(schema, { kind = true, minimum = true, maximum = true, integer = true })
		assert(finite(schema.minimum) and finite(schema.maximum) and schema.minimum <= schema.maximum, "Finite number bounds required")
		assert(schema.integer == nil or type(schema.integer) == "boolean", "Invalid integer requirement")
		compiled.minimum, compiled.maximum, compiled.integer = schema.minimum, schema.maximum, schema.integer == true
	elseif schema.kind == "string" then
		exact(schema, { kind = true, maximumBytes = true, enum = true })
		assert(integer(schema.maximumBytes, 0, 65536), "String byte bound required")
		compiled.maximumBytes = schema.maximumBytes
		if schema.enum ~= nil then
			local count = boundedArray(schema.enum, 64)
			assert(count > 0, "String enum must not be empty")
			local choices: { [string]: boolean } = {}
			for _, choice in schema.enum do
				assert(type(choice) == "string" and #choice <= schema.maximumBytes and utf8.len(choice) ~= nil and not choices[choice], "Invalid string enum")
				choices[choice] = true
			end
			compiled.choices = table.freeze(choices)
		end
	elseif schema.kind == "array" then
		exact(schema, { kind = true, maximumItems = true, items = true })
		assert(integer(schema.maximumItems, 0, 4096), "Array item bound required")
		compiled.maximumItems = schema.maximumItems
		compiled.items = compileSchema(schema.items, depth + 1, budget)
	elseif schema.kind == "object" then
		exact(schema, { kind = true, fields = true, optional = true })
		assert(plain(schema.fields), "Closed object fields required")
		local fields: { [string]: any } = {}
		local count = 0
		for name, child in schema.fields do
			count += 1
			assert(count <= 64 and type(name) == "string" and #name > 0 and #name <= 128 and utf8.len(name) ~= nil, "Invalid object field")
			fields[name] = compileSchema(child, depth + 1, budget)
		end
		local optional: { [string]: boolean } = {}
		if schema.optional ~= nil then
			boundedArray(schema.optional, 64)
			for _, name in schema.optional do
				assert(type(name) == "string" and fields[name] and not optional[name], "Invalid optional field")
				optional[name] = true
			end
		end
		compiled.fields, compiled.optional = table.freeze(fields), table.freeze(optional)
	else error("Unknown closed payload schema kind") end
	budget.active[schema] = nil
	return table.freeze(compiled)
end

-- Byte cost is a conservative local validation budget, not Roblox network serialization size.
local function copyPayload(schema: any, value: any, depth: number, budget: Budget): (boolean, any)
	budget.nodes += 1
	budget.bytes += 1
	if depth > budget.maximumDepth or budget.nodes > budget.maximumNodes or budget.bytes > budget.maximumBytes then return false, nil end
	if schema.kind == "boolean" then return type(value) == "boolean", value end
	if schema.kind == "number" then
		budget.bytes += 8
		return finite(value) and value >= schema.minimum and value <= schema.maximum and (not schema.integer or value % 1 == 0) and budget.bytes <= budget.maximumBytes, value
	end
	if schema.kind == "string" then
		if type(value) ~= "string" then return false, nil end
		budget.bytes += #value
		return #value <= schema.maximumBytes and budget.bytes <= budget.maximumBytes and utf8.len(value) ~= nil and (schema.choices == nil or schema.choices[value] == true), value
	end
	if not plain(value) or budget.seen[value] then return false, nil end
	budget.seen[value] = true
	local result: any = {}
	local count = 0
	for key, child in value do
		count += 1
		local childSchema: any
		if schema.kind == "array" then
			if not integer(key, 1, schema.maximumItems) or count > schema.maximumItems then return false, nil end
			childSchema = schema.items
		else
			if type(key) ~= "string" or schema.fields[key] == nil then return false, nil end
			budget.bytes += #key
			if budget.bytes > budget.maximumBytes then return false, nil end
			childSchema = schema.fields[key]
		end
		local ok, copied = copyPayload(childSchema, child, depth + 1, budget)
		if not ok then return false, nil end
		result[key] = copied
	end
	if schema.kind == "array" then
		for index = 1, count do if rawget(value, index) == nil then return false, nil end end
	else
		for name in schema.fields do if not schema.optional[name] and rawget(value, name) == nil then return false, nil end end
	end
	return true, table.freeze(result)
end

function Network.new(policy: Policy): Gate
	exact(policy, { intents = true, maximumActors = true, maximumDepth = true, maximumNodes = true, maximumBytes = true })
	assert(integer(policy.maximumActors, 1, 4096) and integer(policy.maximumDepth, 1, 16) and integer(policy.maximumNodes, 1, 4096) and integer(policy.maximumBytes, 1, 65536), "Explicit bounded admission policy required")
	assert(plain(policy.intents), "Intent declarations must be a plain table")
	local intents: { [string]: any } = {}
	local intentCount = 0
	for name, intent in policy.intents do
		intentCount += 1
		assert(intentCount <= 64 and type(name) == "string" and #name > 0 and #name <= 64 and utf8.len(name) ~= nil, "Invalid intent ID")
		exact(intent, { schema = true, capacity = true, refillPerSecond = true })
		assert(integer(intent.capacity, 1, 10000) and finite(intent.refillPerSecond) and intent.refillPerSecond > 0 and intent.refillPerSecond <= 10000, "Finite bounded rate policy required")
		intents[name] = table.freeze({ schema = compileSchema(intent.schema, 1, { count = 0, active = {} }), capacity = intent.capacity, refillPerSecond = intent.refillPerSecond })
	end
	assert(intentCount > 0, "At least one intent is required")
	local maximumActors, maximumDepth, maximumNodes, maximumBytes = policy.maximumActors, policy.maximumDepth, policy.maximumNodes, policy.maximumBytes
	local actors: { [any]: ActorState } = {}
	local actorCount = 0
	local open = true
	local gate: any = {}
	function gate:IsOpen(): boolean return open end
	function gate:Register(actor: any): boolean
		if not open or not validActor(actor) then return false end
		if actors[actor] then return true end
		if actorCount >= maximumActors then return false end
		actors[actor] = { sequence = 0, lastNow = 0, busy = false, buckets = {} }
		actorCount += 1
		return true
	end
	function gate:Remove(actor: any)
		if validActor(actor) and actors[actor] then
			actors[actor] = nil
			actorCount -= 1
		end
	end
	function gate:Close()
		open = false
		table.clear(actors)
		actorCount = 0
	end
	function gate:Admit(actor: any, intentId: any, sequence: any, payload: any, now: any, validateContext: ContextCheck): Result
		if not open then return { accepted = false, reason = "closed" } end
		if not validActor(actor) then return { accepted = false, reason = "unknown_actor" } end
		local state = actors[actor]
		if not state then return { accepted = false, reason = "unknown_actor" } end
		if state.busy then return { accepted = false, reason = "busy" } end
		if not finite(now) or now < state.lastNow then return { accepted = false, reason = "clock" } end
		if not integer(sequence, 1, SAFE_INTEGER) or sequence <= state.sequence then return { accepted = false, reason = "sequence" } end
		if type(intentId) ~= "string" or intents[intentId] == nil then return { accepted = false, reason = "intent" } end
		local intent = intents[intentId]
		-- Consume an admitted envelope's sequence even if its payload/context/rate fails.
		state.sequence, state.lastNow = sequence, now
		local bucket = state.buckets[intentId]
		if not bucket then
			bucket = { tokens = intent.capacity, at = now }
			state.buckets[intentId] = bucket
		end
		local elapsed = now - bucket.at
		bucket.tokens = if elapsed >= intent.capacity / intent.refillPerSecond then intent.capacity else math.min(intent.capacity, bucket.tokens + elapsed * intent.refillPerSecond)
		bucket.at = now
		if bucket.tokens < 1 then return { accepted = false, reason = "rate" } end
		bucket.tokens -= 1
		local valid, copied = copyPayload(intent.schema, payload, 1, { nodes = 0, bytes = 0, maximumDepth = maximumDepth, maximumNodes = maximumNodes, maximumBytes = maximumBytes, seen = {} })
		if not valid then return { accepted = false, reason = "payload" } end
		if type(validateContext) ~= "function" then return { accepted = false, reason = "context" } end
		state.busy = true
		-- One resume enforces a non-yielding check. Effects already performed by the
		-- callback are not rolled back or confined; it must not perform the commit.
		local worker = coroutine.create(validateContext)
		local ok, allowed = coroutine.resume(worker, actor, intentId, copied, sequence)
		local yielded = coroutine.status(worker) ~= "dead"
		if yielded then pcall(coroutine.close, worker) end
		state.busy = false
		if not open or actors[actor] ~= state then return { accepted = false, reason = "stale" } end
		if not ok or yielded or allowed ~= true then return { accepted = false, reason = "context" } end
		return { accepted = true, payload = copied }
	end
	return table.freeze(gate) :: Gate
end

type Scope = { IsOpen: (self: any) -> boolean, Defer: (self: any, cleanup: () -> ()) -> (() -> ()) }
-- Explicit native services make the server guard mandatory and the fixed adapter testable offline.
function Network.bindRemoteEvent(scope: Scope, runService: RunService, players: Players, remote: RemoteEvent, gate: Gate, validateContext: ContextCheck, onAdmitted: (Player, string, any, number) -> (), clock: (() -> number)?): { Disconnect: (self: any) -> () }
	assert(runService:IsServer() == true, "Remote request binding requires server context")
	assert(players:IsA("Players") and remote:IsA("RemoteEvent"), "Expected native Players and RemoteEvent")
	assert(scope:IsOpen() and gate:IsOpen(), "Cannot bind a closed scope/gate")
	assert(type(validateContext) == "function" and type(onAdmitted) == "function", "Explicit game-owned context and commit handlers required")
	assert(clock == nil or type(clock) == "function", "Clock must be an explicit function or absent")
	local now = clock or os.clock
	local closed = false
	local removed: { [Player]: boolean } = {}
	setmetatable(removed, { __mode = "k" })
	local requestConnection: RBXScriptConnection? = nil
	local removingConnection: RBXScriptConnection? = nil
	local unregister: (() -> ())? = nil
	local function disconnect()
		if closed then return end
		closed = true
		gate:Close()
		for player in pairs(removed) do removed[player] = nil end
		local failures = 0
		if requestConnection then
			local disconnected = pcall(function() requestConnection:Disconnect() end)
			if not disconnected then failures += 1 end
		end
		if removingConnection then
			local disconnected = pcall(function() removingConnection:Disconnect() end)
			if not disconnected then failures += 1 end
		end
		if unregister then
			local unregistered = pcall(unregister)
			if not unregistered then failures += 1 end
		end
		if failures > 0 then error("Network disposal failed for " .. tostring(failures) .. " registered connections") end
	end
	local ok, failure = pcall(function()
		removingConnection = players.PlayerRemoving:Connect(function(player)
			if closed then return end
			removed[player] = true
			gate:Remove(player)
		end)
		requestConnection = remote.OnServerEvent:Connect(function(player, intentId, sequence, payload, ...)
			if closed or not scope:IsOpen() or select("#", ...) ~= 0 then return end
			-- The actor is only the Player supplied by OnServerEvent, never a payload field.
			if removed[player] or player.Parent ~= players or players:GetPlayerByUserId(player.UserId) ~= player then return end
			if not gate:Register(player) then return end
			local clockOk, currentTime = pcall(now)
			if not clockOk then return end
			local result = gate:Admit(player, intentId, sequence, payload, currentTime, validateContext)
			if result.accepted and not closed and not removed[player] and scope:IsOpen() and player.Parent == players and players:GetPlayerByUserId(player.UserId) == player then
				onAdmitted(player, intentId, result.payload, sequence)
			end
		end)
		unregister = scope:Defer(disconnect)
	end)
	if not ok then
		pcall(disconnect)
		error(failure)
	end
	return table.freeze({ Disconnect = function(_self: any) disconnect() end })
end

return table.freeze(Network)
