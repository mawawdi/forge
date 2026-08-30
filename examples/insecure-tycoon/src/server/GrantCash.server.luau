-- Fixture-local stubs; Roblox provides the real global/type in Studio.
local game: any = nil
type Player = string
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local GrantCash = ReplicatedStorage.Remotes.GrantCash

local Cash: {[Player]: number} = {}

GrantCash.OnServerEvent:Connect(function(player: Player, amount: number)
    Cash[player] = (Cash[player] or 0) + amount
end)

local broken: number = "not a number"

return Cash, broken
