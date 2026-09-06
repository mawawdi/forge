-- Fixed offline export fixture. These reports are test data, not native conformance evidence.
local fs = require("@lune/fs")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local inputPath, outputPath, format = process.args[1], process.args[2], process.args[3]
assert(inputPath and outputPath and (format == "xml" or format == "binary"), "fixed fixture paths and format required")
local input = serde.decode("json", fs.readFile(inputPath))
local place = roblox.Instance.new("DataModel")
local output = roblox.Instance.new("Folder")
output.Name = "ForgeNativeConformanceOutput"
output.Parent = place:GetService("Workspace")
for name, value in { BeforeSaveReport = input.beforeSaveJson, ReopenReport = input.afterReopenJson } do
	local receipt = roblox.Instance.new("StringValue")
	receipt.Name = name
	receipt.Value = value
	receipt.Parent = output
end
fs.writeFile(outputPath, roblox.serializePlace(place, format == "xml"))
