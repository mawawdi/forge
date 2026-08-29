--!nocheck
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local CollectFruit = Remotes:WaitForChild("CollectFruit")
local ForgeTestControl = Remotes:WaitForChild("ForgeTestControl")
local ForgeTestReply = Remotes:WaitForChild("ForgeTestReply")

ForgeTestControl.OnClientEvent:Connect(function(command: { id: string, fruitId: string, amount: number })
    CollectFruit:FireServer(command.fruitId, command.amount)
    ForgeTestReply:FireServer(command.id)
end)
