--!strict
-- Optional server diagnostics. Never opens a recording, starts Play, or grades behavior.
local Constants = if script then require(script.Parent.Constants) else require("./Constants")
local Hash = if script then require(script.Parent.Hash) else require("./Hash")
local PlaytestContext = {}
local PREFIX = "ForgePlaytestContext"

function PlaytestContext.projectKey(root: any): string?
	local linked = root:GetService("Workspace"):GetAttribute(Constants.PROJECT_IDENTITY_ATTRIBUTE)
	if typeof(linked) == "string" and linked ~= "" then return PREFIX .. Hash.sha256("local:" .. linked) end
	if root.PlaceId > 0 then return PREFIX .. Hash.sha256("published:" .. tostring(root.GameId) .. ":" .. tostring(root.PlaceId)) end
	return nil
end

function PlaytestContext.configure(plugin: Plugin, projectId: string, revision: string, buildHash: string)
	local setting = PlaytestContext.projectKey(game)
	if not setting then return end
	local current = plugin:GetSetting(setting)
	if typeof(current) == "table" and current.projectId == projectId and current.baselineRevisionHash == revision and current.connectorBuildHash == buildHash then return end
	plugin:SetSetting(setting, { projectId = projectId, baselineRevisionHash = revision, connectorBuildHash = buildHash })
end

function PlaytestContext.pending(plugin: Plugin, projectId: string, buildHash: string): any?
	local setting = PlaytestContext.projectKey(game)
	if not setting then return nil end
	local value = plugin:GetSetting(setting .. "Receipt")
	if typeof(value) ~= "table" or value.projectId ~= projectId or value.connectorBuildHash ~= buildHash then return nil end
	return value
end

function PlaytestContext.acknowledge(plugin: Plugin, observationId: string)
	local setting = PlaytestContext.projectKey(game)
	if not setting then return end
	local value = plugin:GetSetting(setting .. "Receipt")
	if typeof(value) == "table" and value.observationId == observationId then plugin:SetSetting(setting .. "Receipt", nil) end
end

function PlaytestContext.start(plugin: Plugin, buildHash: string)
	local HttpService = game:GetService("HttpService")
	local LogService = game:GetService("LogService")
	local setting = PlaytestContext.projectKey(game)
	if not setting then return end
	local context = plugin:GetSetting(setting)
	if typeof(context) ~= "table" or context.connectorBuildHash ~= buildHash or typeof(context.projectId) ~= "string" or typeof(context.baselineRevisionHash) ~= "string" then return end
	local startedAt, startedClock = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), os.clock()
	local entries: {{severity: string, message: string}} = {}
	local truncated, closed = false, false
	local connection = LogService.MessageOut:Connect(function(message, messageType)
		if closed then return end
		local severity = if messageType == Enum.MessageType.MessageError then "error" elseif messageType == Enum.MessageType.MessageWarning then "warning" else nil
		if not severity then return end
		if #entries >= 32 then truncated = true; return end
		local text = tostring(message)
		if #text > 512 then truncated = true end
		-- UTF-8 safe truncation, including messages ending in multibyte characters.
		local last = math.min(#text, 512)
		while last > 0 and utf8.len(string.sub(text, 1, last)) == nil do last -= 1 end
		table.insert(entries, { severity = severity, message = string.sub(text, 1, last) })
	end)
	local function finish()
		if closed then return end
		closed = true
		connection:Disconnect()
		pcall(function() plugin:SetSetting(setting .. "Receipt", {
			observationId = "playtest_" .. HttpService:GenerateGUID(false), projectId = context.projectId,
			baselineRevisionHash = context.baselineRevisionHash, connectorBuildHash = context.connectorBuildHash,
			startedAt = startedAt, endedAt = os.date("!%Y-%m-%dT%H:%M:%S.000Z"),
			durationMs = math.min(86400000, math.max(0, math.floor((os.clock() - startedClock) * 1000))),
			diagnostics = entries, truncated = truncated,
		}) end)
	end
	plugin.Unloading:Connect(finish)
	pcall(function() game:BindToClose(finish) end)
end

return PlaytestContext
