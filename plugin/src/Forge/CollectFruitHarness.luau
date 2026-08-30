--!strict
-- Builds the temporary server/client scripts used by one CollectFruit
-- StudioProof. The nonce and complete run binding are embedded only in the
-- server script. The client can invoke only the fixture's real remote.
local CollectFruitHarness = {}

-- A mechanic runner is concrete, but its capability boundary is explicit.
-- Future mechanics provide another runner with the same plan/result checks;
-- Forge does not pretend one arbitrary action DSL is authoritative.
local EXPECTED_ASSERTION_IDS = table.freeze({
	"assert_collect_fruit_success",
	"assert_inventory_increases_once",
	"assert_fruit_consumed",
	"assert_duplicate_collection_rejected",
	"assert_spoofed_id_rejected",
	"assert_impossible_distance_rejected",
	"assert_server_authority",
})

local function hasExactIds(items: any, field: string): boolean
	if typeof(items) ~= "table" or #items ~= #EXPECTED_ASSERTION_IDS then return false end
	local expected = {}
	for _, id in ipairs(EXPECTED_ASSERTION_IDS) do expected[id] = true end
	local seen = {}
	for _, item in ipairs(items) do
		if typeof(item) ~= "table" then return false end
		local id = item[field]
		if typeof(id) ~= "string" or not expected[id] or seen[id] then return false end
		seen[id] = true
	end
	return true
end

function CollectFruitHarness.supportsAssertions(assertions: any): boolean
	return hasExactIds(assertions, "id")
end

function CollectFruitHarness.supportsResults(results: any): boolean
	return hasExactIds(results, "assertionId")
end

local function luaString(value: string): string
	return string.format("%q", value)
end

function CollectFruitHarness.serverSource(contextJson: string, channelName: string): string
	return [[--!nocheck
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")
local Workspace = game:GetService("Workspace")

if not RunService:IsServer() then
	return
end

local context = HttpService:JSONDecode(]] .. luaString(contextJson) .. [[)
local results = {}
local recorded = {}
local diagnostics = {}
local replies = {}
local player = nil
local relay = nil
	local clientReady = false
	local startedClock = os.clock()
	local testEnded = false

local function diagnostic(level, message, contextName)
	table.insert(diagnostics, { context = contextName or "server", level = level, message = string.sub(tostring(message), 1, 4000) })
end

local function record(assertionId, status, expected, observed, statement, data)
	if recorded[assertionId] then error("duplicate harness assertion " .. assertionId) end
	recorded[assertionId] = true
	table.insert(results, {
		kind = "StudioHarnessEvidence", schemaVersion = 1,
		projectId = context.projectId, sessionId = context.sessionId, project = context.project,
		runId = context.runId, testPlanId = context.testPlanId, correlationId = context.correlationId,
		projectSnapshotHash = context.projectSnapshotHash, mechanicContractHash = context.mechanicContractHash,
		nonceCommitment = context.nonceCommitment, nonce = context.nonce,
		id = context.runId .. "_" .. assertionId, assertionId = assertionId, status = status,
		expected = expected, observed = observed,
		evidence = {{ type = "state", statement = statement, data = data }}, authoritative = true,
		durationMs = math.max(0, (os.clock() - startedClock) * 1000), emittedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"),
	})
end

local function assertObserved(assertionId, passed, expected, observed, statement, data)
	record(assertionId, passed and "pass" or "fail", expected, observed, statement, data)
end

local function inventory()
	return player and (player:GetAttribute("Inventory") or 0) or -1
end

local function available(fruit)
	return fruit.Parent == Workspace and fruit:GetAttribute("Consumed") ~= true and fruit.Transparency < 1 and fruit.CanTouch == true
end

local function requestCollection(fruitId, claimedAmount)
	local token = HttpService:GenerateGUID(false)
	relay:FireClient(player, { kind = "collect", token = token, fruitId = fruitId, claimedAmount = claimedAmount })
	local deadline = os.clock() + 5
	while replies[token] ~= true and os.clock() < deadline do task.wait() end
	if replies[token] ~= true then error("client harness did not acknowledge collection request") end
	replies[token] = nil
	task.wait(0.1)
end

local function resetFruit(fruit)
	fruit:SetAttribute("Consumed", false)
	fruit.Transparency = 0
	fruit.CanTouch = true
end

	local function complete(status)
		if testEnded then
			return
		end
		testEnded = true
		if status ~= "completed" then
		for _, planned in ipairs(context.assertions) do
			if not recorded[planned.id] then record(planned.id, "not_run", true, false, "assertion was not reached because the Studio harness failed", {}) end
		end
	end
	local envelope = {
		kind = "StudioHarnessRunEnvelope", schemaVersion = 1,
		projectId = context.projectId, sessionId = context.sessionId, project = context.project,
		runId = context.runId, testPlanId = context.testPlanId, correlationId = context.correlationId,
		projectSnapshotHash = context.projectSnapshotHash, mechanicContractHash = context.mechanicContractHash,
		nonceCommitment = context.nonceCommitment, nonce = context.nonce,
		harnessId = context.harnessId, harnessVersion = context.harnessVersion, harnessHash = context.harnessHash,
		status = status, authoritative = true, startedAt = context.startedAt, endedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"),
		durationMs = math.max(0, (os.clock() - startedClock) * 1000), assertions = results, diagnostics = diagnostics,
	}
		-- Return the evidence value directly. This is the documented
		-- StudioTestService contract and the exact shape proven by the standalone
		-- Run and Play canaries on the target Studio build.
		StudioTestService:EndTest(HttpService:JSONEncode(envelope))
	end

	local ok, failure = pcall(function()
		relay = Instance.new("RemoteEvent")
	relay.Name = ]] .. string.format("%q", channelName) .. [[
	relay.Parent = ReplicatedStorage
	relay.OnServerEvent:Connect(function(sender, kind, token)
		if sender ~= player then return end
		if kind == "ready" then clientReady = true
		elseif kind == "reply" and typeof(token) == "string" then replies[token] = true end
	end)

	local playerDeadline = os.clock() + 10
	player = Players:GetPlayers()[1]
	while not player and os.clock() < playerDeadline do task.wait(0.05); player = Players:GetPlayers()[1] end
	if not player then error("Studio Play Solo client did not join") end
	local characterDeadline = os.clock() + 10
	local character = player.Character
	while not character and os.clock() < characterDeadline do task.wait(0.05); character = player.Character end
	if not character then error("Studio Play Solo client did not spawn a character") end
	local root = character:WaitForChild("HumanoidRootPart", 10)
	local fruit = Workspace:WaitForChild("Fruit42", 10)
	if not root or not root:IsA("BasePart") or not fruit or not fruit:IsA("BasePart") then error("CollectFruit fixture is missing its player root or Fruit42") end
	local readyDeadline = os.clock() + 10
	while not clientReady and os.clock() < readyDeadline do task.wait() end
	if not clientReady then error("client harness did not become ready") end

	root.CFrame = fruit.CFrame * CFrame.new(0, 3, 6)
	task.wait(0.1)
	resetFruit(fruit)
	local validDistance = (root.Position - fruit.Position).Magnitude
	local before = inventory()
	requestCollection("Fruit42", 1)
	local after = inventory()
	local validSucceeded = after == 1 and fruit:GetAttribute("Consumed") == true
	assertObserved("assert_collect_fruit_success", validSucceeded, true, validSucceeded, "real client collection request was evaluated by the server", { fruit = fruit.Name, playerId = player.UserId, distance = validDistance })
	assertObserved("assert_inventory_increases_once", after - before == 1, 1, after - before, "authoritative inventory changed by exactly one", { before = before, after = after })
	local isAvailable = available(fruit)
	assertObserved("assert_fruit_consumed", not isAvailable, false, isAvailable, "the collected fruit became unavailable in server state", { consumed = fruit:GetAttribute("Consumed") == true, transparency = fruit.Transparency })

	requestCollection("Fruit42", 1)
	local afterDuplicate = inventory()
	assertObserved("assert_duplicate_collection_rejected", afterDuplicate == 1, 1, afterDuplicate, "duplicate collection produced no second authoritative reward", { inventory = afterDuplicate })

	local beforeSpoofInventory = inventory()
	local beforeSpoofConsumed = fruit:GetAttribute("Consumed") == true
	requestCollection("DoesNotExist", 1)
	local spoofMutated = inventory() ~= beforeSpoofInventory or (fruit:GetAttribute("Consumed") == true) ~= beforeSpoofConsumed
	assertObserved("assert_spoofed_id_rejected", not spoofMutated, false, spoofMutated, "nonexistent fruit ID produced no authoritative fixture mutation", { inventoryBefore = beforeSpoofInventory, inventoryAfter = inventory() })

	resetFruit(fruit)
	root.CFrame = fruit.CFrame * CFrame.new(100, 0, 0)
	task.wait(0.1)
	local impossibleDistance = (root.Position - fruit.Position).Magnitude
	local beforeDistanceInventory = inventory()
	requestCollection("Fruit42", 1)
	local afterDistanceInventory = inventory()
	local distanceRewarded = afterDistanceInventory ~= beforeDistanceInventory or not available(fruit)
	assertObserved("assert_impossible_distance_rejected", impossibleDistance > 20 and not distanceRewarded, false, distanceRewarded, "real out-of-range client request was evaluated against runtime positions", { distance = impossibleDistance, inventoryBefore = beforeDistanceInventory, inventoryAfter = afterDistanceInventory, fruitAvailable = available(fruit) })

	root.CFrame = fruit.CFrame * CFrame.new(0, 3, 6)
	task.wait(0.1)
	resetFruit(fruit)
	local beforeSpoofedReward = inventory()
	requestCollection("Fruit42", 999999)
	local spoofedRewardInventory = inventory()
	local spoofedRewardDelta = spoofedRewardInventory - beforeSpoofedReward
	assertObserved("assert_server_authority", spoofedRewardDelta == 1, 1, spoofedRewardDelta, "client reward claim produced exactly the server-owned reward delta", { claimedAmount = 999999, inventoryBefore = beforeSpoofedReward, inventoryAfter = spoofedRewardInventory, authoritativeDelta = spoofedRewardDelta })
end)

if not ok then diagnostic("error", failure, "server") end
complete(ok and #results == #context.assertions and "completed" or "failed")
]]
end

function CollectFruitHarness.clientSource(channelName: string): string
	return [[--!nocheck
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local relay = ReplicatedStorage:WaitForChild(]] .. string.format("%q", channelName) .. [[, 15)
local remotes = ReplicatedStorage:WaitForChild("Remotes", 15)
local collectFruit = remotes and remotes:WaitForChild("CollectFruit", 15)
if not relay or not collectFruit or not collectFruit:IsA("RemoteEvent") then return end
relay:FireServer("ready", "ready")
relay.OnClientEvent:Connect(function(command)
	if typeof(command) ~= "table" or command.kind ~= "collect" then return end
	collectFruit:FireServer(command.fruitId, command.claimedAmount)
	task.wait(0.05)
	relay:FireServer("reply", command.token)
end)
]]
end

return CollectFruitHarness
