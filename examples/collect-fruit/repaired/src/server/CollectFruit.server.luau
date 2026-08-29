-- Fixture-local stubs; Roblox provides the real global/type in Studio.
local game: any = nil
type Player = string
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local CollectFruit = ReplicatedStorage.Remotes.CollectFruit

local Inventory: {[Player]: number} = {}

CollectFruit.OnServerEvent:Connect(function(player: Player, amount: number)
    if typeof(amount) ~= "number" then return end
    if amount <= 0 then return end
    Inventory[player] = (Inventory[player] or 0) + 1
end)

return Inventory
