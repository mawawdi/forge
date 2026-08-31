local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ApplyAction = ReplicatedStorage:WaitForChild("ApplyAction") :: RemoteEvent

ApplyAction:FireServer(99)
