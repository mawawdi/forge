-- Fixed offline datatype probe. This does not run Studio or generated game source.
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local CFrame = roblox.CFrame
local cases = {
	{ 0, 0, 0 },
	{ 0, 90, 0 },
	{ 90, 0, 0 },
	{ 30, 45, 60 },
	{ -37, 121, -83 },
	{ 360, -180, 270 },
}
local result = {}
for _, angles in cases do
	local rotation = CFrame.fromEulerAnglesXYZ(math.rad(angles[1]), math.rad(angles[2]), math.rad(angles[3]))
	table.insert(result, { angles = angles, components = { rotation:GetComponents() } })
end
print(serde.encode("json", result))
