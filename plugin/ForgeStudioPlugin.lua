--!nocheck
-- Forge Studio Plugin M3 candidate. Save this Script as a Local Plugin.
-- This is a runtime bridge, not an agent or planner.

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local StudioTestService = game:GetService("StudioTestService")
local LogService = game:GetService("LogService")

local VERSION = "forge-studio-plugin-0.1.1"
local DEFAULT_URL = "http://127.0.0.1:8787"
local configuredBridgeUrl = plugin:GetSetting("forge.bridge.url")
local configuredSessionId = plugin:GetSetting("forge.session.id")
local configuredSessionToken = plugin:GetSetting("forge.session.token")
local bridgeUrl = typeof(configuredBridgeUrl) == "string" and configuredBridgeUrl ~= "" and configuredBridgeUrl or DEFAULT_URL
local sessionId = typeof(configuredSessionId) == "string" and configuredSessionId ~= "" and configuredSessionId or nil
local sessionToken = typeof(configuredSessionToken) == "string" and configuredSessionToken ~= "" and configuredSessionToken or nil
local snapshotToken
local transaction
local assertionRunId
local assertionTestPlanId
local stopping = false
local connectionState = sessionId and "connected" or "disconnected"
local consecutiveFailures = 0
local status
local statusDot
local detail
local token

local function setConnectionState(state, message)
	connectionState = state
	if status then
		status.Text = state == "connected" and "Connected" or state == "pairing" and "Pairing" or state == "degraded" and "Bridge unavailable" or "Not paired"
	end
	if statusDot then
		statusDot.BackgroundColor3 = state == "connected" and Color3.fromRGB(74, 222, 128) or state == "pairing" and Color3.fromRGB(250, 204, 21) or state == "degraded" and Color3.fromRGB(248, 113, 113) or Color3.fromRGB(148, 163, 184)
	end
	if detail and message then detail.Text = message end
end

local function clearSession()
	sessionId, sessionToken, snapshotToken = nil, nil, nil
	plugin:SetSetting("forge.session.id", "")
	plugin:SetSetting("forge.session.token", "")
end

local function transportFailure(message, code, operation)
	consecutiveFailures = consecutiveFailures + 1
	if code == 401 and sessionId then
		clearSession()
		setConnectionState("disconnected", "Bridge session expired or was reset. Start the bridge again and pair with its new token.")
		return
	end
	setConnectionState("degraded", "Bridge " .. operation .. " failed (" .. tostring(message) .. "). Retrying automatically.")
end

local function transportSuccess()
	consecutiveFailures = 0
	if sessionId then
		if connectionState == "degraded" then setConnectionState("connected", "Bridge connection restored.") else setConnectionState("connected") end
	end
end

local function id(prefix)
	return prefix .. "_" .. HttpService:GenerateGUID(false)
end

local function identity()
	return { name = game.Name, placeId = game.PlaceId, universeId = game.GameId }
end

local function request(method, path, body)
	local options = { Url = bridgeUrl .. path, Method = method, Headers = { ["Content-Type"] = "application/json" } }
	if sessionToken then options.Headers["X-Forge-Session-Token"] = sessionToken end
	if body then options.Body = HttpService:JSONEncode(body) end
	local ok, response = pcall(function() return HttpService:RequestAsync(options) end)
	if not ok then return false, tostring(response), 0 end
	if typeof(response) ~= "table" then return false, "Studio returned an invalid HTTP response", 0 end
	if not response.Success then return false, tostring(response.StatusCode) .. ": " .. tostring(response.StatusMessage), response.StatusCode end
	if response.Body == "" then return true, nil, response.StatusCode end
	local decodeOk, decoded = pcall(function() return HttpService:JSONDecode(response.Body) end)
	if not decodeOk then return false, "Bridge returned invalid JSON", response.StatusCode end
	return true, decoded, response.StatusCode
end

local function send(kind, payload, requestId)
	local message = { kind = "StudioProtocolMessage", schemaVersion = 1, direction = "plugin_to_backend", type = kind, messageId = id("msg"), sentAt = os.date("!%Y-%m-%dT%H:%M:%SZ"), payload = payload }
	if sessionId then message.sessionId = sessionId end
	if requestId then message.requestId = requestId end
	local ok, result, code = request("POST", "/v1/message", message)
	if ok then transportSuccess() else transportFailure(result, code, "message") end
	return ok, result, code
end

-- FNV is only a local observation token. The backend must construct canonical
-- SHA-256 ProjectSnapshot hashes from the observation before accepting proof.
local function observationToken(value)
	local hash = 2166136261
	for index = 1, #value do
		hash = bit32.bxor(hash, string.byte(value, index))
		hash = (hash * 16777619) % 4294967296
	end
	return string.format("fnv1a-32:%08x", hash)
end

local function pathOf(instance)
	local parts, cursor = {}, instance
	while cursor and cursor ~= game do table.insert(parts, 1, cursor.Name); cursor = cursor.Parent end
	return table.concat(parts, "/")
end

local function find(path)
	local current = game
	for part in string.gmatch(path, "[^/]+") do
		current = current:FindFirstChild(part)
		if not current then return nil end
	end
	return current
end

local function primitiveProperties(instance)
	local result = {}
	for _, property in ipairs({ "CanTouch", "CanCollide", "Anchored", "Enabled", "Value" }) do
		local ok, value = pcall(function() return instance[property] end)
		if ok and (typeof(value) == "string" or typeof(value) == "number" or typeof(value) == "boolean") then result[property] = value end
	end
	return result
end

local function relevant(instance)
	return instance:IsA("BasePart") or instance:IsA("Folder") or instance:IsA("Model") or instance:IsA("RemoteEvent") or instance:IsA("RemoteFunction") or instance:IsA("LuaSourceContainer") or instance:IsA("GuiObject")
end

local function snapshot(reason)
	if not sessionId or not sessionToken then return false, "Pair the plugin before requesting a snapshot", 401 end
	local captureOk, payload, localToken = pcall(function()
		local instances, scripts, remotes = {}, {}, {}
		for _, instance in ipairs(game:GetDescendants()) do
			if relevant(instance) then
				local path = pathOf(instance)
				table.insert(instances, { path = path, className = instance.ClassName, properties = primitiveProperties(instance), attributes = instance:GetAttributes(), tags = CollectionService:GetTags(instance) })
				if instance:IsA("LuaSourceContainer") then
					local source = ""
					local sourceOk, sourceValue = pcall(function() return instance.Source end)
					if sourceOk and typeof(sourceValue) == "string" then source = string.sub(sourceValue, 1, 262144) end
					local context = instance:IsA("Script") and "server" or instance:IsA("LocalScript") and "client" or "shared"
					table.insert(scripts, { path = path, executionContext = context, sourceHash = observationToken(source), source = source })
				end
				if instance:IsA("RemoteEvent") or instance:IsA("RemoteFunction") then table.insert(remotes, { path = path, name = instance.Name, className = instance.ClassName, direction = "client_to_server" }) end
			end
		end
		table.sort(instances, function(left, right) return left.path < right.path end)
		table.sort(scripts, function(left, right) return left.path < right.path end)
		table.sort(remotes, function(left, right) return left.path < right.path end)
		local observation = { kind = "StudioSnapshotObservation", schemaVersion = 1, project = identity(), capturedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"), instances = instances, scripts = scripts, remotes = remotes }
		local encoded = HttpService:JSONEncode(observation)
		if #encoded > 900 * 1024 then error("snapshot exceeds the 900 KiB bridge safety limit") end
		local localToken = observationToken(encoded)
		local projectSnapshot = { kind = "ProjectSnapshot", schemaVersion = 1, projectId = "studio_project_" .. tostring(game.PlaceId), sourceHash = localToken, structureHash = localToken, contractHash = "backend-required", projectSemanticHash = localToken, semanticMapHash = localToken }
		return { project = identity(), snapshot = projectSnapshot, observation = observation, reason = reason }, localToken
	end)
	if not captureOk then
		setConnectionState("connected", "Snapshot capture failed: " .. tostring(payload))
		return false, tostring(payload), 0
	end
	snapshotToken = localToken
	return send("ProjectSnapshot", payload)
end

local function acceptSession(payload)
	if typeof(payload) ~= "table" or typeof(payload.sessionId) ~= "string" or payload.sessionId == "" or typeof(payload.sessionToken) ~= "string" or payload.sessionToken == "" or typeof(payload.projectId) ~= "string" or typeof(payload.expiresAt) ~= "string" then
		return false, "Bridge returned an invalid pairing response"
	end
	local alreadyAccepted = sessionId == payload.sessionId and sessionToken == payload.sessionToken
	sessionId, sessionToken = payload.sessionId, payload.sessionToken
	plugin:SetSetting("forge.session.id", sessionId)
	plugin:SetSetting("forge.session.token", sessionToken)
	setConnectionState("connected", alreadyAccepted and "Connected to the Forge bridge." or "Connected. Capturing the initial Studio snapshot...")
	if alreadyAccepted then return true end
	local ok, result, code = snapshot("pairing")
	if ok then setConnectionState("connected", "Connected. Initial Studio snapshot sent to Forge.") end
	return ok, result, code
end

local function errorMessage(code, message, retryable)
	send("PluginError", { code = code, message = message, retryable = retryable == true })
end

local function setSource(scriptInstance, source)
	local ok, errorText = pcall(function() ScriptEditorService:UpdateSourceAsync(scriptInstance, function() return source end) end)
	if ok then return true end
	local fallbackOk, fallbackError = pcall(function() scriptInstance.Source = source end)
	return fallbackOk, fallbackError or errorText
end

local function apply(operation)
	local result = { opId = operation.opId or id("op"), target = operation.path, status = "rejected" }
	local target = find(operation.path)
	local ok, failure = pcall(function()
		if operation.type == "create_instance" then
			if target then error("target exists") end
			local parentPath = string.match(operation.path, "^(.*)/[^/]+$")
			local parent = parentPath and find(parentPath) or game
			if not parent then error("parent missing") end
			local created = Instance.new(operation.className)
			for key, value in pairs(operation.properties or {}) do created[key] = value end
			for key, value in pairs(operation.attributes or {}) do created:SetAttribute(key, value) end
			for _, tag in ipairs(operation.tags or {}) do CollectionService:AddTag(created, tag) end
			created.Parent = parent
		elseif operation.type == "delete_instance" then
			if not target or operation.expectedClassName and target.ClassName ~= operation.expectedClassName then error("target mismatch") end
			target:Destroy()
		elseif operation.type == "set_property" then
			if not target then error("target missing") end
			if operation.before ~= nil and target[operation.property] ~= operation.before then error("property precondition mismatch") end
			target[operation.property] = operation.value
		elseif operation.type == "set_attribute" then
			if not target then error("target missing") end
			if operation.before ~= nil and target:GetAttribute(operation.attribute) ~= operation.before then error("attribute precondition mismatch") end
			target:SetAttribute(operation.attribute, operation.value)
		elseif operation.type == "move_instance" then
			if not target or not find(operation.parentPath) then error("target or parent missing") end
			target.Parent = find(operation.parentPath)
		elseif operation.type == "create_script" then
			if target then error("target exists") end
			local parentPath = string.match(operation.path, "^(.*)/[^/]+$")
			local parent = parentPath and find(parentPath) or game
			local created = Instance.new(operation.executionContext == "client" and "LocalScript" or operation.executionContext == "shared" and "ModuleScript" or "Script")
			created.Name = string.match(operation.path, "([^/]+)$")
			created.Parent = parent
			local sourceOk, sourceError = setSource(created, operation.source)
			if not sourceOk then error(sourceError) end
		elseif operation.type == "replace_text" then
			if not target or not target:IsA("LuaSourceContainer") then error("script missing") end
			local currentSource = ""
			local sourceReadOk, sourceValue = pcall(function() return target.Source end)
			if sourceReadOk and typeof(sourceValue) == "string" then currentSource = sourceValue end
			if operation.before ~= currentSource then error("source precondition mismatch") end
			local sourceOk, sourceError = setSource(target, operation.after)
			if not sourceOk then error(sourceError) end
		else error("unsupported operation") end
		result.status = "applied"
	end)
	if not ok then result.error = tostring(failure) end
	return result
end

local backendMessageTypes = {
	PairAccepted = true,
	PairRejected = true,
	RequestSnapshot = true,
	ApplyPatchSet = true,
	BeginTransaction = true,
	CommitTransaction = true,
	RollbackTransaction = true,
	StartPlaytest = true,
	StopPlaytest = true,
	ExecuteAssertionPlan = true,
	RequestRuntimeState = true
}

local function handle(message)
	if typeof(message) ~= "table" or message.kind ~= "StudioProtocolMessage" or message.schemaVersion ~= 1 or message.direction ~= "backend_to_plugin" or typeof(message.type) ~= "string" or not backendMessageTypes[message.type] or typeof(message.payload) ~= "table" then
		error("Bridge sent a malformed backend message")
	end
	if message.type ~= "PairAccepted" and message.sessionId ~= sessionId then
		error("Bridge message belongs to a different Studio session")
	end
	if message.type == "PairAccepted" then
		local accepted, reason = acceptSession(message.payload)
		if not accepted then error(reason) end
	elseif message.type == "PairRejected" then
		setConnectionState("disconnected", "Bridge rejected the pairing: " .. tostring(message.payload.reason or "unknown reason"))
	elseif message.type == "RequestSnapshot" then snapshot(message.payload.reason)
	elseif message.type == "BeginTransaction" then
		if transaction then errorMessage("SECURITY_REJECTION", "transaction already active", false); return end
		if snapshotToken and message.payload.expectedSnapshotHash ~= snapshotToken then errorMessage("STALE_SNAPSHOT", "transaction snapshot does not match the live Studio observation", false); return end
		local recording = ChangeHistoryService:TryBeginRecording("Forge " .. message.payload.transactionId)
		if not recording then errorMessage("STUDIO_FAILURE", "Studio refused ChangeHistory recording", true); return end
		transaction = { id = message.payload.transactionId, recording = recording }
	elseif message.type == "ApplyPatchSet" then
		if not transaction or transaction.id ~= message.payload.transactionId then errorMessage("SECURITY_REJECTION", "transaction mismatch", false); return end
		if snapshotToken and message.payload.expectedSnapshotHash ~= snapshotToken then errorMessage("STALE_SNAPSHOT", "patch snapshot does not match the live Studio observation", false); return end
		local results = {}
		for _, operation in ipairs(message.payload.patchSet.operations) do
			local result = apply(operation); table.insert(results, result)
			if result.status ~= "applied" then
				pcall(function() ChangeHistoryService:FinishRecording(transaction.recording, Enum.FinishRecordingOperation.Cancel) end)
				transaction = nil
				send("PatchRejected", { patchSetId = message.payload.patchSet.id, transactionId = message.payload.transactionId, projectSnapshotBefore = snapshotToken or "unavailable", reason = result.error or "operation rejected", operationResults = results }, message.requestId)
				return
			end
		end
		snapshot("post_patch")
		send("PatchApplied", { patchSetId = message.payload.patchSet.id, transactionId = message.payload.transactionId, projectSnapshotBefore = message.payload.expectedSnapshotHash, projectSnapshotAfter = snapshotToken or "unavailable", operations = results }, message.requestId)
	elseif message.type == "CommitTransaction" then
		if not transaction or transaction.id ~= message.payload.transactionId then errorMessage("SECURITY_REJECTION", "transaction mismatch", false); return end
		ChangeHistoryService:FinishRecording(transaction.recording, Enum.FinishRecordingOperation.Commit); transaction = nil
	elseif message.type == "RollbackTransaction" then
		if transaction then pcall(function() ChangeHistoryService:FinishRecording(transaction.recording, Enum.FinishRecordingOperation.Cancel) end); transaction = nil end
		snapshot("rollback")
	elseif message.type == "StartPlaytest" then
		task.spawn(function()
			local ok, result = pcall(function()
				if message.payload.mode == "multiplayer" then return StudioTestService:ExecuteMultiplayerTestAsync(message.payload.playerCount, message.payload.args) end
				if message.payload.mode == "run" then return StudioTestService:ExecuteRunModeAsync(message.payload.args) end
				return StudioTestService:ExecutePlayModeAsync(message.payload.args)
			end)
			if ok then send("PlaytestStarted", { runId = message.payload.runId, mode = message.payload.mode, playerCount = message.payload.playerCount, studioTestResult = tostring(result) }, message.requestId) else errorMessage("STUDIO_FAILURE", tostring(result), true) end
		end)
	elseif message.type == "StopPlaytest" then
		if StudioTestService:CanLeaveTest() then StudioTestService:LeaveTest() end
		send("PlaytestStopped", { runId = message.payload.runId, mode = "play", playerCount = 0 }, message.requestId)
	elseif message.type == "RequestRuntimeState" then
		send("RuntimeEvidence", { runId = message.payload.runId, testPlanId = "runtime-state", projectSnapshotHash = snapshotToken or "unavailable", instances = {}, logs = {}, errors = {}, serverAuthorityObserved = false }, message.requestId)
	elseif message.type == "ExecuteAssertionPlan" then
		task.spawn(function()
			assertionRunId, assertionTestPlanId = message.payload.runId, message.payload.testPlanId
			send("PlaytestStarted", { runId = message.payload.runId, mode = "play", playerCount = 1 }, message.requestId)
			local ok, result = pcall(function()
				return StudioTestService:ExecutePlayModeAsync({ forgeRunId = message.payload.runId, forgeTestPlanId = message.payload.testPlanId, adversarial = message.payload.adversarial })
			end)
			assertionRunId, assertionTestPlanId = nil, nil
			if ok then send("PlaytestStopped", { runId = message.payload.runId, mode = "play", playerCount = 1, studioTestResult = tostring(result) }, message.requestId) else errorMessage("STUDIO_FAILURE", tostring(result), true) end
		end)
	end
end

local function safeHandle(message)
	local ok, errorText = pcall(function() handle(message) end)
	if not ok then
		setConnectionState(sessionId and "connected" or "disconnected", "Ignored invalid bridge message: " .. tostring(errorText))
		if sessionId then errorMessage("INVALID_MESSAGE", tostring(errorText), false) end
	end
end

local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, true, false, 390, 300, 340, 260)
local widget = plugin:CreateDockWidgetPluginGuiAsync("ForgeStudio", info)
widget.Title = "Forge Studio"

local background = Instance.new("Frame")
background.Size = UDim2.fromScale(1, 1)
background.BackgroundColor3 = Color3.fromRGB(15, 23, 42)
background.BorderSizePixel = 0
background.Parent = widget

local header = Instance.new("TextLabel")
header.Size = UDim2.new(1, -32, 0, 26)
header.Position = UDim2.fromOffset(16, 14)
header.BackgroundTransparency = 1
header.Font = Enum.Font.GothamBold
header.Text = "Forge Studio"
header.TextColor3 = Color3.fromRGB(248, 250, 252)
header.TextSize = 18
header.TextXAlignment = Enum.TextXAlignment.Left
header.Parent = background

local subtitle = Instance.new("TextLabel")
subtitle.Size = UDim2.new(1, -32, 0, 18)
subtitle.Position = UDim2.fromOffset(16, 39)
subtitle.BackgroundTransparency = 1
subtitle.Font = Enum.Font.Gotham
subtitle.Text = "Verified project bridge"
subtitle.TextColor3 = Color3.fromRGB(148, 163, 184)
subtitle.TextSize = 12
subtitle.TextXAlignment = Enum.TextXAlignment.Left
subtitle.Parent = background

local statusCard = Instance.new("Frame")
statusCard.Size = UDim2.new(1, -32, 0, 50)
statusCard.Position = UDim2.fromOffset(16, 68)
statusCard.BackgroundColor3 = Color3.fromRGB(30, 41, 59)
statusCard.BorderSizePixel = 0
statusCard.Parent = background
local statusCorner = Instance.new("UICorner"); statusCorner.CornerRadius = UDim.new(0, 8); statusCorner.Parent = statusCard
statusDot = Instance.new("Frame"); statusDot.Size = UDim2.fromOffset(10, 10); statusDot.Position = UDim2.fromOffset(15, 20); statusDot.BorderSizePixel = 0; statusDot.Parent = statusCard
local dotCorner = Instance.new("UICorner"); dotCorner.CornerRadius = UDim.new(1, 0); dotCorner.Parent = statusDot
status = Instance.new("TextLabel"); status.Size = UDim2.new(1, -48, 0, 22); status.Position = UDim2.fromOffset(36, 14); status.BackgroundTransparency = 1; status.Font = Enum.Font.GothamSemibold; status.Text = sessionId and "Connected" or "Not paired"; status.TextColor3 = Color3.fromRGB(226, 232, 240); status.TextSize = 14; status.TextXAlignment = Enum.TextXAlignment.Left; status.Parent = statusCard

local bridgeLabel = Instance.new("TextLabel")
bridgeLabel.Size = UDim2.new(1, -32, 0, 18)
bridgeLabel.Position = UDim2.fromOffset(16, 129)
bridgeLabel.BackgroundTransparency = 1
bridgeLabel.Font = Enum.Font.Gotham
bridgeLabel.Text = "Bridge  " .. bridgeUrl
bridgeLabel.TextColor3 = Color3.fromRGB(148, 163, 184)
bridgeLabel.TextSize = 11
bridgeLabel.TextXAlignment = Enum.TextXAlignment.Left
bridgeLabel.TextTruncate = Enum.TextTruncate.AtEnd
bridgeLabel.Parent = background

token = Instance.new("TextBox")
token.Size = UDim2.new(1, -32, 0, 34)
token.Position = UDim2.fromOffset(16, 153)
token.BackgroundColor3 = Color3.fromRGB(30, 41, 59)
token.BorderSizePixel = 0
token.ClearTextOnFocus = false
token.Font = Enum.Font.Code
token.PlaceholderText = "Paste one-use pairing token"
token.PlaceholderColor3 = Color3.fromRGB(100, 116, 139)
token.Text = ""
token.TextColor3 = Color3.fromRGB(226, 232, 240)
token.TextSize = 12
token.TextXAlignment = Enum.TextXAlignment.Left
token.Parent = background
local tokenCorner = Instance.new("UICorner"); tokenCorner.CornerRadius = UDim.new(0, 6); tokenCorner.Parent = token
local tokenPadding = Instance.new("UIPadding"); tokenPadding.PaddingLeft = UDim.new(0, 10); tokenPadding.PaddingRight = UDim.new(0, 10); tokenPadding.Parent = token

local pair = Instance.new("TextButton")
pair.Size = UDim2.new(0.5, -20, 0, 36)
pair.Position = UDim2.fromOffset(16, 199)
pair.BackgroundColor3 = Color3.fromRGB(99, 102, 241)
pair.BorderSizePixel = 0
pair.Font = Enum.Font.GothamSemibold
pair.Text = "Pair bridge"
pair.TextColor3 = Color3.fromRGB(255, 255, 255)
pair.TextSize = 13
pair.AutoButtonColor = true
pair.Parent = background
local pairCorner = Instance.new("UICorner"); pairCorner.CornerRadius = UDim.new(0, 6); pairCorner.Parent = pair

local snap = Instance.new("TextButton")
snap.Size = UDim2.new(0.5, -20, 0, 36)
snap.Position = UDim2.new(0.5, 4, 0, 199)
snap.BackgroundColor3 = Color3.fromRGB(51, 65, 85)
snap.BorderSizePixel = 0
snap.Font = Enum.Font.GothamSemibold
snap.Text = "Send snapshot"
snap.TextColor3 = Color3.fromRGB(226, 232, 240)
snap.TextSize = 13
snap.AutoButtonColor = true
snap.Parent = background
local snapCorner = Instance.new("UICorner"); snapCorner.CornerRadius = UDim.new(0, 6); snapCorner.Parent = snap

detail = Instance.new("TextLabel")
detail.Size = UDim2.new(1, -32, 0, 42)
detail.Position = UDim2.fromOffset(16, 248)
detail.BackgroundTransparency = 1
detail.Font = Enum.Font.Gotham
detail.Text = "Start the local bridge, then pair this Studio place."
detail.TextColor3 = Color3.fromRGB(148, 163, 184)
detail.TextSize = 11
detail.TextWrapped = true
detail.TextXAlignment = Enum.TextXAlignment.Left
detail.TextYAlignment = Enum.TextYAlignment.Top
detail.Parent = background

setConnectionState(connectionState)
pair.MouseButton1Click:Connect(function()
	local pairingToken = string.gsub(token.Text or "", "^%s*(.-)%s*$", "%1")
	if pairingToken == "" then setConnectionState("disconnected", "Paste the one-use token printed by the Forge bridge."); return end
	setConnectionState("pairing", "Pairing with the local Forge bridge...")
	local ok, result, code = request("POST", "/v1/message", { kind = "StudioProtocolMessage", schemaVersion = 1, direction = "plugin_to_backend", type = "PairProject", messageId = id("msg"), sentAt = os.date("!%Y-%m-%dT%H:%M:%SZ"), payload = { pairingToken = pairingToken, project = identity(), pluginVersion = VERSION, studioVersion = "unknown" } })
	if not ok then
		if code == 401 then setConnectionState("disconnected", "Pairing token rejected (401). Restart the bridge for a fresh one-use token.") else setConnectionState("degraded", "Pairing failed: " .. tostring(result) .. ". Check that the bridge is running.") end
		return
	end
	local accepted, acceptanceResult = acceptSession(result)
	if not accepted then setConnectionState("disconnected", tostring(acceptanceResult)); return end
	transportSuccess()
end)
snap.MouseButton1Click:Connect(function()
	if not sessionId then setConnectionState("disconnected", "Pair the plugin first."); return end
	local ok, result = snapshot("manual")
	if ok then setConnectionState("connected", "Snapshot sent to Forge.") else detail.Text = tostring(result) end
end)
local toolbar = plugin:CreateToolbar("Forge"); local button = toolbar:CreateButton("Forge", "Open Forge", ""); button.ClickableWhenViewportHidden = true; button.Click:Connect(function() widget.Enabled = not widget.Enabled end)
send("PluginHello", { pluginVersion = VERSION, studioVersion = "unknown", supportedProtocolVersions = { 1 }, capabilities = { "snapshot", "patch", "transaction", "playtest", "assertions", "runtime_state", "http_polling" } })
LogService.MessageOut:Connect(function(message, messageType)
	local prefix = "FORGE_ASSERTION_RESULT:"
	if string.sub(message, 1, #prefix) == prefix then
		local ok, result = pcall(function() return HttpService:JSONDecode(string.sub(message, #prefix + 1)) end)
		if ok and result and result.runId == assertionRunId and result.testPlanId == assertionTestPlanId then send("AssertionResult", result) end
	end
	local completePrefix = "FORGE_TEST_COMPLETE:"
	if string.sub(message, 1, #completePrefix) == completePrefix then
		pcall(function() StudioTestService:EndTest("Forge test complete") end)
	end
	local stream = messageType == Enum.MessageType.MessageError and "error" or messageType == Enum.MessageType.MessageWarning and "warning" or "output"
	send("StudioOutput", { stream = stream, text = message, occurredAt = os.date("!%Y-%m-%dT%H:%M:%SZ") })
end)
task.spawn(function()
	local pollDelay = 0.5
	while not stopping do
		if sessionId and sessionToken then
			local ok, result, code = request("GET", "/v1/poll?sessionId=" .. HttpService:UrlEncode(sessionId) .. "&sessionToken=" .. HttpService:UrlEncode(sessionToken))
			if ok then
				if typeof(result) ~= "table" or typeof(result.messages) ~= "table" then
					transportFailure("invalid poll response", 0, "polling")
					pollDelay = math.min(8, pollDelay * 2)
				else
					transportSuccess()
					pollDelay = 0.5
					for _, message in ipairs(result.messages) do safeHandle(message) end
				end
			else
				transportFailure(result, code, "polling")
				pollDelay = math.min(8, pollDelay * 2)
			end
		else
			pollDelay = 0.5
		end
		task.wait(pollDelay)
	end
end)
plugin.Unloading:Connect(function()
	stopping = true
	if transaction then
		pcall(function() ChangeHistoryService:FinishRecording(transaction.recording, Enum.FinishRecordingOperation.Cancel) end)
		transaction = nil
	end
end)
