-- The production-shaped client boundary. Forge's StudioProof client harness
-- is injected per run and is never part of the saved place.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local CollectFruit = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("CollectFruit")

local function requestCollection(fruitId: string, claimedAmount: number)
    CollectFruit:FireServer(fruitId, claimedAmount)
end

-- A real UI can call this boundary. The server remains authoritative over all
-- validation, consumed state, and reward computation.
if false then
    requestCollection("Fruit42", 1)
end
