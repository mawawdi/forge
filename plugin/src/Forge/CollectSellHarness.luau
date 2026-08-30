--!strict
-- Versioned, bounded M3.5 runner. It owns one combined CollectFruit and
-- SellInventory proof; it is not a general test interpreter.
local CollectSellHarness = {}

local EXPECTED_ASSERTION_IDS = table.freeze({
	"assert_collect_fruit_success", "assert_inventory_increases_once", "assert_fruit_consumed",
	"assert_duplicate_collection_rejected", "assert_spoofed_id_rejected", "assert_impossible_distance_rejected", "assert_server_authority",
	"assert_sell_inventory_success", "assert_sell_inventory_clears", "assert_sell_inventory_coins", "assert_sell_inventory_distance", "assert_sell_inventory_spoof", "assert_sell_inventory_duplicate", "assert_collect_sell_composition",
})

local function exactIds(items: any, field: string): boolean
	if typeof(items) ~= "table" or #items ~= #EXPECTED_ASSERTION_IDS then return false end
	local expected, seen = {}, {}
	for _, id in ipairs(EXPECTED_ASSERTION_IDS) do expected[id] = true end
	for _, item in ipairs(items) do
		local id = typeof(item) == "table" and item[field] or nil
		if typeof(id) ~= "string" or not expected[id] or seen[id] then return false end
		seen[id] = true
	end
	return true
end

function CollectSellHarness.supportsAssertions(assertions: any): boolean return exactIds(assertions, "id") end
function CollectSellHarness.supportsResults(results: any): boolean return exactIds(results, "assertionId") end
local function quoted(value: string): string return string.format("%q", value) end

function CollectSellHarness.serverSource(contextJson: string, channelName: string): string
	return [[--!nocheck
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")
local Workspace = game:GetService("Workspace")
if not RunService:IsServer() then return end

local context = HttpService:JSONDecode(]] .. quoted(contextJson) .. [[)
local results, recorded, diagnostics, replies = {}, {}, {}, {}
local player, relay = nil, nil
local clientReady, ended = false, false
local readyPlayers = {}
local started = os.clock()
local function record(id, pass, expected, observed, statement, data)
	if recorded[id] then error("duplicate assertion " .. id) end
	recorded[id] = true
	-- An empty Lua table is encoded as a JSON array by Studio. Evidence data is
	-- intentionally an object when present, so omit it rather than serializing
	-- an ambiguous [] for assertions with no additional state to report.
	local evidence = { type = "state", statement = statement }
	if typeof(data) == "table" and next(data) ~= nil then evidence.data = data end
	table.insert(results, {kind="StudioHarnessEvidence",schemaVersion=1,projectId=context.projectId,sessionId=context.sessionId,project=context.project,runId=context.runId,testPlanId=context.testPlanId,correlationId=context.correlationId,projectSnapshotHash=context.projectSnapshotHash,mechanicContractHash=context.mechanicContractHash,nonceCommitment=context.nonceCommitment,nonce=context.nonce,id=context.runId .. "_" .. id,assertionId=id,status=pass and "pass" or "fail",expected=expected,observed=observed,evidence={evidence},authoritative=true,durationMs=math.max(0,(os.clock()-started)*1000),emittedAt=os.date("!%Y-%m-%dT%H:%M:%SZ")})
end
local function inventory() return player and (player:GetAttribute("Inventory") or 0) or -1 end
local function coins() return player and (player:GetAttribute("Coins") or 0) or -1 end
local function available(fruit) return fruit.Parent == Workspace and fruit:GetAttribute("Consumed") ~= true and fruit.Transparency < 1 and fruit.CanTouch == true end
local function resetFruit(fruit) fruit:SetAttribute("Consumed", false); fruit.Transparency = 0; fruit.CanTouch = true end
local function request(kind, arguments)
	local token = HttpService:GenerateGUID(false)
	relay:FireClient(player, {kind=kind, token=token, arguments=arguments})
	local deadline = os.clock() + 5
	while replies[token] ~= true and os.clock() < deadline do task.wait() end
	if replies[token] ~= true then error("client did not acknowledge " .. kind) end
	replies[token] = nil
	task.wait(0.1)
end
local function complete(status)
	if ended then return end
	ended = true
	if status ~= "completed" then
		for _, assertion in ipairs(context.assertions) do if not recorded[assertion.id] then record(assertion.id, false, true, false, "assertion was not reached", {}) end end
	end
	StudioTestService:EndTest(HttpService:JSONEncode({kind="StudioHarnessRunEnvelope",schemaVersion=1,projectId=context.projectId,sessionId=context.sessionId,project=context.project,runId=context.runId,testPlanId=context.testPlanId,correlationId=context.correlationId,projectSnapshotHash=context.projectSnapshotHash,mechanicContractHash=context.mechanicContractHash,nonceCommitment=context.nonceCommitment,nonce=context.nonce,harnessId=context.harnessId,harnessVersion=context.harnessVersion,harnessHash=context.harnessHash,status=status,authoritative=true,startedAt=context.startedAt,endedAt=os.date("!%Y-%m-%dT%H:%M:%SZ"),durationMs=math.max(0,(os.clock()-started)*1000),assertions=results,diagnostics=diagnostics}))
end

local ok, failure = pcall(function()
	relay = Instance.new("RemoteEvent")
	relay.Name = ]] .. quoted(channelName) .. [[
	relay.Parent = ReplicatedStorage
	relay.OnServerEvent:Connect(function(sender, kind, token)
		-- A LocalScript can reach this unique relay before this server coroutine
		-- has selected Players:GetPlayers()[1]. Retain that one readiness signal,
		-- then bind it only to the selected Play Solo player below. This removes a
		-- startup race without accepting actions from another player.
		if kind == "ready" then
			readyPlayers[sender] = true
			if sender == player then clientReady = true end
			return
		end
		if sender ~= player then return end
		if kind == "reply" and typeof(token) == "string" then replies[token] = true end
	end)
	local deadline = os.clock()+10
	player = Players:GetPlayers()[1]
	while not player and os.clock() < deadline do task.wait(0.05); player = Players:GetPlayers()[1] end
	if not player then error("Play Solo player did not join") end
	local character = player.Character or player.CharacterAdded:Wait()
	local root = character:WaitForChild("HumanoidRootPart", 10)
	local humanoid = character:FindFirstChildOfClass("Humanoid") or character:WaitForChild("Humanoid", 10)
	local fruit = Workspace:WaitForChild("Fruit42", 10)
	local zone = Workspace:WaitForChild("SellZone", 10)
	local prompt = zone and zone:FindFirstChild("SellPrompt")
	if not root or not root:IsA("BasePart") or not humanoid or not humanoid:IsA("Humanoid") or humanoid.Health <= 0 or not fruit or not fruit:IsA("BasePart") or not zone or not zone:IsA("BasePart") or not prompt or not prompt:IsA("ProximityPrompt") then error("Collect/Sell declared player or world preconditions are missing") end
	if prompt.MaxActivationDistance ~= 12 then error("SellPrompt MaxActivationDistance must be 12") end
	clientReady = readyPlayers[player] == true
	while not clientReady and os.clock() < deadline do task.wait() end
	if not clientReady then error("client harness did not become ready") end
	-- Candidate PlayerAdded handlers and production LocalScripts must finish
	-- initialization before the first action. A temporary driver becoming ready
	-- is not evidence that production code is ready.
	while (player:GetAttribute("Inventory") == nil or player:GetAttribute("Coins") == nil) and os.clock() < deadline do task.wait(0.05) end
	if player:GetAttribute("Inventory") == nil or player:GetAttribute("Coins") == nil then error("candidate did not initialize declared player state") end
	task.wait(0.5)
	player:SetAttribute("Inventory", 0); player:SetAttribute("Coins", 0)

	-- Happy-path assertions enter through the same model-authored client action
	-- modules used by the production input handlers. Static verification proves
	-- the declared Button1Down/Triggered event wiring; this real client executes
	-- the exact production request function without privileged synthetic input.
	root.CFrame = fruit.CFrame * CFrame.new(0,3,6); task.wait(0.1); resetFruit(fruit)
	local before = inventory(); request("collect_production", {}); local after = inventory()
	local collected = after - before == 1 and fruit:GetAttribute("Consumed") == true
	record("assert_collect_fruit_success", collected, true, collected, "production CollectFruit client action changed authoritative state", {inventory=after,productionClient=true})
	record("assert_inventory_increases_once", after-before == 1, 1, after-before, "Inventory changed by exactly one", {before=before,after=after})
	record("assert_fruit_consumed", not available(fruit), false, available(fruit), "Fruit42 became unavailable", {consumed=fruit:GetAttribute("Consumed") == true})
	request("collect_direct", {fruitId="Fruit42", claimedAmount=1}); record("assert_duplicate_collection_rejected", inventory()==after, after, inventory(), "duplicate collect attack did not reward", {})
	local beforeInvalid = inventory(); request("collect_direct", {fruitId="DoesNotExist", claimedAmount=1}); record("assert_spoofed_id_rejected", inventory()==beforeInvalid, false, inventory()~=beforeInvalid, "nonexistent fruit attack caused no authoritative mutation", {})
	resetFruit(fruit); root.CFrame = fruit.CFrame * CFrame.new(100,0,0); task.wait(0.1); local beforeFar=inventory(); request("collect_direct", {fruitId="Fruit42",claimedAmount=1}); record("assert_impossible_distance_rejected", inventory()==beforeFar and available(fruit), false, inventory()~=beforeFar or not available(fruit), "out-of-range direct request caused no mutation", {})
	root.CFrame = fruit.CFrame * CFrame.new(0,3,6); task.wait(0.1); resetFruit(fruit); local beforeClaim=inventory(); request("collect_direct", {fruitId="Fruit42",claimedAmount=999999}); record("assert_server_authority", inventory()-beforeClaim==1, 1, inventory()-beforeClaim, "claimed collection reward did not control server reward", {claimedAmount=999999})

	-- SellInventory uses the actual zero-argument RemoteEvent ABI. The server's
	-- Player callback derives quantity and unit price from authoritative state.
	root.CFrame = zone.CFrame * CFrame.new(0,3,6); task.wait(0.1)
	player:SetAttribute("Inventory",3); player:SetAttribute("Coins",10); local price=zone:GetAttribute("UnitPrice")
	request("sell_production", {}); local afterSellInventory, afterSellCoins = inventory(), coins()
	record("assert_sell_inventory_success", afterSellInventory==0 and afterSellCoins==10+3*price, true, afterSellInventory==0 and afterSellCoins==10+3*price, "production SellPrompt interaction converted inventory", {unitPrice=price,coins=afterSellCoins,productionClient=true})
	record("assert_sell_inventory_clears", afterSellInventory==0, 0, afterSellInventory, "Inventory clears exactly to zero", {})
	record("assert_sell_inventory_coins", afterSellCoins==10+3*price, 10+3*price, afterSellCoins, "Coins are server-calculated from Inventory times UnitPrice", {})
	player:SetAttribute("Inventory",2); local beforeOutsideCoins, beforeOutsideInventory=coins(),inventory(); root.CFrame=zone.CFrame*CFrame.new(100,0,0); task.wait(0.1); request("sell_direct", {}); record("assert_sell_inventory_distance", coins()==beforeOutsideCoins and inventory()==beforeOutsideInventory, false, coins()~=beforeOutsideCoins or inventory()~=beforeOutsideInventory, "outside-zone direct request changed nothing", {})
	root.CFrame=zone.CFrame*CFrame.new(0,3,6); task.wait(0.1); player:SetAttribute("Inventory",2); player:SetAttribute("Coins",10); request("sell_direct", {claimedPayout=999999}); record("assert_sell_inventory_spoof", coins()==10+2*price, 10+2*price, coins(), "extra client payout argument cannot control coins", {claimedPayout=999999})
	player:SetAttribute("Inventory",2); player:SetAttribute("Coins",10); request("sell_direct", {}); local once=coins(); request("sell_direct", {}); record("assert_sell_inventory_duplicate", coins()==once and inventory()==0, once, coins(), "duplicate direct sell rewards exactly once", {})
	player:SetAttribute("Inventory",0); player:SetAttribute("Coins",10); resetFruit(fruit); root.CFrame=fruit.CFrame*CFrame.new(0,3,6); task.wait(0.1); request("collect_production", {}); root.CFrame=zone.CFrame*CFrame.new(0,3,6); task.wait(0.1); request("sell_production", {}); record("assert_collect_sell_composition", inventory()==0 and coins()==10+price, 10+price, coins(), "production CollectFruit then SellInventory produced 0 to 1 to 0 and exact coins", {inventory=inventory(),coins=coins,productionClient=true})
end)
if not ok then table.insert(diagnostics,{context="server",level="error",message=string.sub(tostring(failure),1,4000)}) end
complete(ok and #results == #context.assertions and "completed" or "failed")
]]
end

function CollectSellHarness.clientSource(channelName: string): string
	return [[--!nocheck
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")
local relay = ReplicatedStorage:WaitForChild(]] .. quoted(channelName) .. [[, 15)
local remotes = ReplicatedStorage:WaitForChild("Remotes", 15)
local collectFruit = remotes and remotes:WaitForChild("CollectFruit", 15)
local sellInventory = remotes and remotes:WaitForChild("SellInventory", 15)
local clientActions = ReplicatedStorage:WaitForChild("ClientActions", 15)
local collectActionModule = clientActions and clientActions:WaitForChild("CollectFruitAction", 15)
local sellActionModule = clientActions and clientActions:WaitForChild("SellInventoryAction", 15)
local fruit = Workspace:WaitForChild("Fruit42", 15)
local sellZone = Workspace:WaitForChild("SellZone", 15)
local sellPrompt = sellZone and sellZone:WaitForChild("SellPrompt", 15)
if not relay or not collectFruit or not sellInventory or not collectFruit:IsA("RemoteEvent") or not sellInventory:IsA("RemoteEvent") or not collectActionModule or not collectActionModule:IsA("ModuleScript") or not sellActionModule or not sellActionModule:IsA("ModuleScript") or not fruit or not fruit:IsA("BasePart") or not sellPrompt or not sellPrompt:IsA("ProximityPrompt") then return end
local collectAction = require(collectActionModule)
local sellAction = require(sellActionModule)
if typeof(collectAction) ~= "table" or typeof(collectAction.request) ~= "function" or typeof(sellAction) ~= "table" or typeof(sellAction.request) ~= "function" then return end
relay:FireServer("ready", "ready")
relay.OnClientEvent:Connect(function(command)
	if typeof(command) ~= "table" or typeof(command.token) ~= "string" or typeof(command.kind) ~= "string" then return end
	local arguments = command.arguments or {}
	if command.kind == "collect_production" then
		collectAction.request(fruit)
	elseif command.kind == "sell_production" then
		sellAction.request()
	elseif command.kind == "collect_direct" then collectFruit:FireServer(arguments.fruitId, arguments.claimedAmount)
	elseif command.kind == "sell_direct" then
		if arguments.claimedPayout ~= nil then sellInventory:FireServer(arguments.claimedPayout) else sellInventory:FireServer() end
	else return end
	task.wait(0.15)
	relay:FireServer("reply", command.token)
end)
]]
end

return CollectSellHarness
