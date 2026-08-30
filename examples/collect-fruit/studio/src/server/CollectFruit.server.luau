--!nocheck
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local CollectFruit = Remotes:WaitForChild("CollectFruit")
local Fruit42 = Workspace:WaitForChild("Fruit42")
local MAX_DISTANCE = 20

Fruit42:SetAttribute("FruitType", "Apple")
Fruit42:SetAttribute("Reward", 1)

local function resetFruit()
    Fruit42:SetAttribute("Consumed", false)
    Fruit42.Transparency = 0
    Fruit42.CanTouch = true
end

local function initializePlayer(player: Player)
    player:SetAttribute("Inventory", 0)
end

Players.PlayerAdded:Connect(initializePlayer)
for _, player in Players:GetPlayers() do
    initializePlayer(player)
end

CollectFruit.OnServerEvent:Connect(function(player: Player, fruitId: unknown, _claimedAmount: unknown)
    if typeof(fruitId) ~= "string" or fruitId ~= "Fruit42" then
        return
    end
    if typeof(_claimedAmount) ~= "number" or _claimedAmount <= 0 then
        return
    end
    if Fruit42:GetAttribute("Consumed") == true then
        return
    end
    local character = player.Character
    local root = character and character:FindFirstChild("HumanoidRootPart")
    if not root or not root:IsA("BasePart") then
        return
    end
    if (root.Position - Fruit42.Position).Magnitude > MAX_DISTANCE then
        return
    end

    Fruit42:SetAttribute("Consumed", true)
    Fruit42.Transparency = 1
    Fruit42.CanTouch = false
    player:SetAttribute("Inventory", (player:GetAttribute("Inventory") or 0) + Fruit42:GetAttribute("Reward"))
end)

resetFruit()
