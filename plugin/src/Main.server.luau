--!strict
local RunService = game:GetService("RunService")
if RunService:IsRunning() then
	return
end

local Runtime = require(script.Forge.Runtime)
Runtime.start(plugin)
