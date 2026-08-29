--!nocheck
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local StudioTestService = game:GetService("StudioTestService")
local Workspace = game:GetService("Workspace")

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local ForgeTestControl = Remotes:WaitForChild("ForgeTestControl")
local ForgeTestReply = Remotes:WaitForChild("ForgeTestReply")
local Fruit42 = Workspace:WaitForChild("Fruit42")
local testArgs = StudioTestService:GetTestArgs()
local runId = typeof(testArgs) == "table" and testArgs.forgeRunId or ""
local testPlanId = typeof(testArgs) == "table" and testArgs.forgeTestPlanId or ""

local function emit(assertionId: string, passed: boolean, observed: boolean | number, statement: string, data: {[string]: string | number | boolean})
    print("FORGE_ASSERTION_RESULT:" .. HttpService:JSONEncode({
        kind = "StudioAssertionResult",
        schemaVersion = 1,
        id = "result_" .. assertionId,
        runId = runId,
        testPlanId = testPlanId,
        assertionId = assertionId,
        status = passed and "pass" or "fail",
        expected = true,
        observed = observed,
        evidence = {{ type = "state", statement = statement, data = data }},
        authoritative = true,
        durationMs = 150
    }))
end

local function reset(player: Player, nearFruit: boolean)
    player:SetAttribute("Inventory", 0)
    Fruit42:SetAttribute("Consumed", false)
    Fruit42.Transparency = 0
    Fruit42.CanTouch = true
    local character = player.Character or player.CharacterAdded:Wait()
    local root = character:WaitForChild("HumanoidRootPart")
    root.CFrame = nearFruit and CFrame.new(Fruit42.Position + Vector3.new(0, 0, 6)) or CFrame.new(1000, 3, 1000)
end

local function command(player: Player, id: string, fruitId: string, amount: number): boolean
    local received = false
    local connection = ForgeTestReply.OnServerEvent:Connect(function(sender: Player, replyId: string)
        if sender == player and replyId == id then
            received = true
        end
    end)
    ForgeTestControl:FireClient(player, { id = id, fruitId = fruitId, amount = amount })
    local deadline = os.clock() + 5
    while not received and os.clock() < deadline do
        task.wait()
    end
    connection:Disconnect()
    task.wait(0.15)
    return received
end

local function run(player: Player)
    if runId == "" or testPlanId == "" then
        warn("Forge assertion harness requires StudioTestService test arguments")
        return
    end
    reset(player, true)
    local validSent = command(player, "valid", "Fruit42", 1)
    emit("assert_collect_fruit_success", validSent and player:GetAttribute("Inventory") == 1, validSent and player:GetAttribute("Inventory") == 1, "valid collect increments server inventory", { inventory = player:GetAttribute("Inventory") or 0 })
    emit("assert_inventory_increases_once", player:GetAttribute("Inventory") == 1, player:GetAttribute("Inventory") or 0, "inventory is exactly one after one collect", { inventory = player:GetAttribute("Inventory") or 0 })
    emit("assert_fruit_consumed", Fruit42:GetAttribute("Consumed") == true, Fruit42:GetAttribute("Consumed") == true, "server marks the fruit unavailable", { consumed = Fruit42:GetAttribute("Consumed") == true })

    reset(player, true)
    command(player, "duplicate_first", "Fruit42", 1)
    command(player, "duplicate_second", "Fruit42", 1)
    emit("assert_duplicate_collection_rejected", player:GetAttribute("Inventory") == 1, player:GetAttribute("Inventory") or 0, "duplicate request cannot reward twice", { inventory = player:GetAttribute("Inventory") or 0 })

    reset(player, true)
    command(player, "spoofed_id", "DoesNotExist", 1)
    emit("assert_spoofed_id_rejected", player:GetAttribute("Inventory") == 0, player:GetAttribute("Inventory") == 0, "unknown fruit identity is rejected", { inventory = player:GetAttribute("Inventory") or 0 })

    reset(player, false)
    command(player, "impossible_distance", "Fruit42", 1)
    emit("assert_impossible_distance_rejected", player:GetAttribute("Inventory") == 0, player:GetAttribute("Inventory") == 0, "distance is checked on the server", { inventory = player:GetAttribute("Inventory") or 0 })

    reset(player, true)
    command(player, "server_authority", "Fruit42", 999999)
    emit("assert_server_authority", player:GetAttribute("Inventory") == 1, player:GetAttribute("Inventory") or 0, "client amount is not used as the reward", { inventory = player:GetAttribute("Inventory") or 0, claimedAmount = 999999 })
    print("FORGE_TEST_COMPLETE:collect-fruit-v1")
    StudioTestService:EndTest("Forge collect-fruit assertions complete")
end

Players.PlayerAdded:Connect(function(player)
    task.spawn(run, player)
end)

for _, player in Players:GetPlayers() do
    task.spawn(run, player)
end
