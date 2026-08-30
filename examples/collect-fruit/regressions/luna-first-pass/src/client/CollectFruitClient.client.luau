local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local CollectionService = game:GetService("CollectionService")
local Workspace = game:GetService("Workspace")

local player = Players.LocalPlayer
local mouse = player:GetMouse()
local collectFruit = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("CollectFruit")

local function findCollectible(target: Instance?): Instance?
	local current = target
	while current and current ~= Workspace do
		if CollectionService:HasTag(current, "collectible") then
			return current
		end
		current = current.Parent
	end
	return nil
end

mouse.Button1Down:Connect(function()
	local fruit = findCollectible(mouse.Target)
	if fruit and fruit:IsDescendantOf(Workspace) then
		collectFruit:FireServer(fruit.Name, 0)
	end
end)
