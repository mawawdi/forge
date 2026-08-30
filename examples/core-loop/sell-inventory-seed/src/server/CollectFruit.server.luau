local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local CollectionService = game:GetService("CollectionService")
local Workspace = game:GetService("Workspace")

local remotes = ReplicatedStorage:WaitForChild("Remotes")
local collectFruit = remotes:WaitForChild("CollectFruit")
local inventories: {[Player]: number} = {}
local collecting: {[Instance]: boolean} = {}
local MAX_DISTANCE = 20

local function finiteNumber(value: any): boolean
	return typeof(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

local function initializePlayer(player: Player)
	inventories[player] = 0
	player:SetAttribute("Inventory", 0)
end

Players.PlayerAdded:Connect(initializePlayer)
for _, player in Players:GetPlayers() do
	initializePlayer(player)
end

Players.PlayerRemoving:Connect(function(player)
	inventories[player] = nil
end)

collectFruit.OnServerEvent:Connect(function(player: Player, fruitId: any, claimedReward: any)
	if typeof(fruitId) ~= "string" or fruitId == "" or #fruitId > 100 then
		return
	end
	if not finiteNumber(claimedReward) or claimedReward < 0 then
		return
	end
	if player.Parent ~= Players then
		return
	end

	local fruit = Workspace:FindFirstChild(fruitId, true)
	if not fruit or not fruit:IsA("BasePart") then
		return
	end
	if not fruit:IsDescendantOf(Workspace) or not CollectionService:HasTag(fruit, "collectible") then
		return
	end
	if fruit:GetAttribute("Consumed") == true or collecting[fruit] then
		return
	end

	local reward = fruit:GetAttribute("Reward")
	if not finiteNumber(reward) or reward < 0 then
		return
	end

	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	if not root or not root:IsA("BasePart") or not humanoid or humanoid.Health <= 0 then
		return
	end
	if (root.Position - fruit.Position).Magnitude > MAX_DISTANCE then
		return
	end

	collecting[fruit] = true
	fruit:SetAttribute("Consumed", true)
	local inventory = inventories[player] or 0
	inventory += reward
	inventories[player] = inventory
	player:SetAttribute("Inventory", inventory)
	print(("fruit.collected fruit_id=%s reward=%s"):format(fruit.Name, tostring(reward)))
	collecting[fruit] = nil
end)
