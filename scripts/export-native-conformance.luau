-- Extract only fixed native evidence receipts from a user-saved place.
local fs = require("@lune/fs")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local placePath, outputPath = process.args[1], process.args[2]
assert(placePath and outputPath, "Usage: lune run scripts/export-native-conformance.luau <saved-place.rbxlx> <report.json>")
assert(not fs.isFile(outputPath) and not fs.isDir(outputPath), "output already exists; preserve existing evidence")
local placeBytes = fs.readFile(placePath)
local place = roblox.deserializePlace(placeBytes)
local output = assert(place:GetService("Workspace"):FindFirstChild("ForgeNativeConformanceOutput"), "native report folder missing")
local function receipt(name)
	local value = assert(output:FindFirstChild(name), name .. " missing")
	assert(value:IsA("StringValue"))
	return value.Value
end
local beforeSaveJson, afterReopenJson = receipt("BeforeSaveReport"), receipt("ReopenReport")
local before, reopened = serde.decode("json", beforeSaveJson), serde.decode("json", afterReopenJson)
assert(before.kind == "ForgeNativePreflightConformance" and reopened.kind == before.kind, "unexpected receipt kind")
assert(before.manifestHash == reopened.manifestHash and before.fixtureBuild.hash == reopened.fixtureBuild.hash, "receipt identity mismatch")
assert(reopened.beforeReportHash == serde.hash("sha256", beforeSaveJson), "reopen report does not bind saved before report")
fs.writeFile(outputPath, serde.encode("json", {
	kind = "ForgeNativeConformanceExport",
	sourcePlace = { sha256 = serde.hash("sha256", placeBytes), bytes = #placeBytes },
	beforeSaveJson = beforeSaveJson,
	afterReopenJson = afterReopenJson,
}, true))
print(`Exported native receipts to {outputPath}; before={before.status}, reopened={reopened.status}`)
