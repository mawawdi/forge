local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ApplyAction = ReplicatedStorage:WaitForChild("ApplyAction") :: RemoteEvent
local Score: {[Player]: number} = {}

ApplyAction.OnServerEvent:Connect(function(player: Player, claimedAmount: unknown)
    if typeof(claimedAmount) ~= "number" then return end
    Score[player] = (Score[player] or 0) + 1
end)
