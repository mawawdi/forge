--!strict
-- Exact allow-list: StudioProof accepts only versioned harnesses reviewed by
-- Forge. There is deliberately no generic script or assertion interpreter.
local Constants = require(script.Parent.Constants)
local CollectFruitHarness = require(script.Parent.CollectFruitHarness)
local CollectSellHarness = require(script.Parent.CollectSellHarness)

local HarnessRegistry = {}

local entries = {
	[Constants.COLLECT_HARNESS_ID] = { id = Constants.COLLECT_HARNESS_ID, version = Constants.COLLECT_HARNESS_VERSION, hash = Constants.COLLECT_HARNESS_HASH, harness = CollectFruitHarness },
	[Constants.COLLECT_SELL_HARNESS_ID] = { id = Constants.COLLECT_SELL_HARNESS_ID, version = Constants.COLLECT_SELL_HARNESS_VERSION, hash = Constants.COLLECT_SELL_HARNESS_HASH, harness = CollectSellHarness },
}

function HarnessRegistry.resolve(id: any, version: any)
	local entry = entries[id]
	if not entry or entry.version ~= version then return nil end
	return entry
end

return HarnessRegistry
