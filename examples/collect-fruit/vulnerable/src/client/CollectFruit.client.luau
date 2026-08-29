-- Fixture-local stubs; Roblox provides the real global/type in Studio.
local game: any = nil
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local CollectFruit = ReplicatedStorage.Remotes.CollectFruit

local function collectFruit()
    local amount = 999999
    CollectFruit:FireServer(amount)
end

return collectFruit
