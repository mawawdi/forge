--!strict
local RunService = game:GetService("RunService")
local Runtime = require(script.Forge.Runtime)

if RunService:IsRunning() then
	-- Roblox loads a plugin separately in Play Server and Play Client.  The
	-- passive creator observer is server-authoritative and obtains its entire
	-- identity from the readback-verified Plugin setting, so the client has no
	-- connector work at all.
	if RunService:IsServer() then Runtime.startPassive(plugin) end
	return
end

Runtime.start(plugin)
