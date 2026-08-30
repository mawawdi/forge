local process = require("@lune/process")
local CollectFruitHarness = require("../plugin/src/Forge/CollectFruitHarness")

local mode = process.args[1]
if mode == "server" then
	print(CollectFruitHarness.serverSource([[{"assertions":[]}]], "__ForgeGeneratedHarnessParseTest__"))
elseif mode == "client" then
	print(CollectFruitHarness.clientSource("__ForgeGeneratedHarnessParseTest__"))
else
	error("usage: render-collect-fruit-harness <server|client>")
end
