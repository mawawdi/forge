-- Fixture-local stub; Roblox provides the real global in Studio.
local game: any = nil
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local GrantCash = ReplicatedStorage.Remotes.GrantCash

local function collectCash()
    local amount = 999999
    GrantCash:FireServer(amount)
end

return collectCash
