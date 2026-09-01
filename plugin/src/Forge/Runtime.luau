--!strict
local HttpService = game:GetService("HttpService")
local StudioTestService = game:GetService("StudioTestService")
local Constants = require(script.Parent.Constants)
local Hash = require(script.Parent.Hash)
local IdentityRegistry = require(script.Parent.IdentityRegistry)
local SnapshotCollector = require(script.Parent.SnapshotCollector)
local RuntimeCapabilityExecutor = require(script.Parent.RuntimeCapabilityExecutor)
local StudioAuthoring = require(script.Parent.StudioAuthoring)

local Runtime = {}

local function iso(): string return os.date("!%Y-%m-%dT%H:%M:%SZ") end
local function messageId(prefix: string): string return prefix .. "_" .. HttpService:GenerateGUID(false) end
local function identity() return { name = game.Name, placeId = game.PlaceId, universeId = game.GameId } end
local function capabilities()
	return { "snapshot", "snapshot_chunks", "sha256", "stable_identity", "studio_play_mode", "http_polling", "bounded_diagnostics", "runtime_eval", "studio_authoring" }
end
local function substrateAvailable(): boolean
	return Hash.available() and typeof(StudioTestService.ExecutePlayModeAsync) == "function"
end

function Runtime.start(plugin: Plugin)
	StudioAuthoring.reconcile(plugin)
	local bridgeUrl = plugin:GetSetting("forge.bridge.url")
	if typeof(bridgeUrl) ~= "string" or bridgeUrl == "" then bridgeUrl = Constants.BRIDGE_URL end
	local sessionId: string? = nil
	local projectId: string? = nil
	local sessionToken: string? = nil
	local revision: string? = nil
	local running = true
	local autoConnectEnabled = true
	local pairing = false
	local nextAutoPair = 0
	local pending = {} :: {{kind: string, payload: any, requestId: string?, messageId: string}}
	local registry = IdentityRegistry.new()
	local stopRegistry: (() -> ())? = nil
	local collector = SnapshotCollector.new(registry)
	local authoring = StudioAuthoring.new(plugin, registry)
	local widgetStatus: TextLabel? = nil
	local widgetDetail: TextLabel? = nil
	local pairButton: TextButton? = nil
	local runButton: TextButton? = nil

	local function state(title: string, detail: string)
		if widgetStatus then widgetStatus.Text = title end
		if widgetDetail then widgetDetail.Text = detail end
	end
	local function request(method: string, path: string, body: any?)
		local headers = { ["Content-Type"] = "application/json" }
		if sessionToken then headers["X-Forge-Session-Token"] = sessionToken end
		local options = { Url = bridgeUrl .. path, Method = method, Headers = headers }
		if body then
			local encoded = HttpService:JSONEncode(body)
			if #encoded > Constants.MAX_MESSAGE_BYTES then return false, "request exceeds protocol limit", 413 end
			options.Body = encoded
		end
		local ok, response = pcall(function() return HttpService:RequestAsync(options) end)
		if not ok then return false, tostring(response), 0 end
		if not response.Success then
			local detail = tostring(response.StatusCode) .. ": " .. tostring(response.StatusMessage)
			if typeof(response.Body) == "string" and response.Body ~= "" then
				local decoded, errorBody = pcall(function() return HttpService:JSONDecode(response.Body) end)
				if decoded and typeof(errorBody) == "table" and typeof(errorBody.message) == "string" then detail ..= " — " .. errorBody.message
				else detail ..= " — " .. string.sub(response.Body, 1, Constants.MAX_DIAGNOSTIC_CHARS) end
			end
			return false, detail, response.StatusCode
		end
		if response.Body == "" then return true, nil, response.StatusCode end
		local decoded, value = pcall(function() return HttpService:JSONDecode(response.Body) end)
		return decoded, value, response.StatusCode
	end
	local function send(kind: string, payload: any, requestId: string?, suppliedId: string?): (boolean, any?, number)
		local message = { kind = "StudioProtocolMessage", direction = "plugin_to_backend", type = kind, messageId = suppliedId or messageId("msg"), sentAt = iso(), payload = payload }
		if sessionId then message.sessionId = sessionId end
		if requestId then message.requestId = requestId end
		return request("POST", "/message", message)
	end
	local function permanentBridgeRejection(status: any): boolean return typeof(status) == "number" and status >= 400 and status < 500 end
	local function pluginError(code: string, detail: string, retryable: boolean, requestId: string?)
		if sessionId then send("PluginError", { code = code, message = string.sub(detail, 1, Constants.MAX_DIAGNOSTIC_CHARS), retryable = retryable }, requestId) end
		state("RUNTIME INCOMPLETE", string.sub(detail, 1, Constants.MAX_DIAGNOSTIC_CHARS))
	end

	local runtimeCapabilities = RuntimeCapabilityExecutor.new(function(kind, payload, requestId)
		local item = { kind = kind, payload = payload, requestId = requestId, messageId = messageId("runtime") }
		if #pending == 0 then
			local sent, failure, status = send(item.kind, item.payload, item.requestId, item.messageId)
			if sent then return true end
			if permanentBridgeRejection(status) then pluginError("STUDIO_FAILURE", "Bridge rejected " .. item.kind .. ": " .. tostring(failure), false, item.requestId); return nil end
		end
		if #pending >= 16 then error("Runtime capability result outbox exceeded its bound") end
		table.insert(pending, item)
		return false
	end, state)

	local function sendSnapshot(reason: string): boolean
		if not sessionId then return false end
		local ok, snapshotOrError = pcall(function() return collector:collect() end)
		if not ok then pluginError("STUDIO_FAILURE", tostring(snapshotOrError), false); return false end
		local snapshot = snapshotOrError
		revision = snapshot.revision.observationHash
		if #snapshot.encoded <= Constants.MAX_SNAPSHOT_BYTES then
			local sent, failure = send("ProjectObservation", { project = snapshot.project, revision = snapshot.revision, observation = snapshot.observation, reason = reason })
			if not sent then state("OBSERVATION REJECTED", tostring(failure)) end
			return sent
		end
		for _, chunk in ipairs(collector:chunks(snapshot, reason)) do
			local sent, failure = send("SnapshotChunk", chunk)
			if not sent then state("OBSERVATION REJECTED", tostring(failure)); return false end
		end
		return true
	end
	local function requireFreshRevision(expectedRevision: string, boundary: string): string
		local ok, snapshotOrError = pcall(function() return collector:collect() end)
		if not ok then error(boundary .. " could not observe the current Studio state: " .. tostring(snapshotOrError)) end
		local snapshot = snapshotOrError
		revision = snapshot.revision.observationHash
		if revision ~= expectedRevision then error(boundary .. " rejected a stale Studio revision") end
		return revision :: string
	end
	local function startArmedRuntime()
		if not sessionId or not runtimeCapabilities.active or runtimeCapabilities.active.phase ~= "armed" then state("NOT READY", "No exact Studio execution is armed."); return end
		if runButton then runButton.Active = false; runButton.AutoButtonColor = false end
		if not sendSnapshot("pre_play") then local requestId = runtimeCapabilities.active.requestId; runtimeCapabilities:abort(); pluginError("STUDIO_FAILURE", "Could not confirm the live Studio revision before Play Solo.", true, requestId); return end
		if not runtimeCapabilities.active or runtimeCapabilities.active.plan.binding.projectSnapshotHash ~= revision then local requestId = runtimeCapabilities.active and runtimeCapabilities.active.requestId or nil; runtimeCapabilities:abort(); pluginError("STALE_SNAPSHOT", "Runtime plan snapshot no longer matches Studio.", false, requestId); return end
		local started, failure = pcall(function() runtimeCapabilities:start() end)
		if not started then pluginError("STUDIO_FAILURE", tostring(failure), false) end
	end

	local function unpair(notifyBridge: boolean?, reason: string?, disableAutoConnect: boolean?)
		if disableAutoConnect then autoConnectEnabled = false end
		runtimeCapabilities:abort()
		if not authoring:abort() then state("RECOVERY REQUIRED", "Studio could not cancel the active Forge creator recording.") end
		if runButton then runButton.Visible = false; runButton.Active = false; runButton.AutoButtonColor = false end
		if notifyBridge and sessionId and sessionToken then send("UnpairProject", { reason = reason or "user" }) end
		sessionId, projectId, sessionToken, revision = nil, nil, nil, nil
		if stopRegistry then stopRegistry(); stopRegistry = nil end
		table.clear(pending)
		if pairButton then pairButton.Text = autoConnectEnabled and "Connecting…" or "Connect" end
		state(autoConnectEnabled and "CONNECTING" or "DISCONNECTED", autoConnectEnabled and "Waiting for the local Forge bridge." or "Automatic connection is paused.")
	end

	local function pairAutomatically(): boolean
		if pairing or sessionId or not autoConnectEnabled then return false end
		if not substrateAvailable() then state("UNSUPPORTED STUDIO", "Forge requires SHA-256 and ExecutePlayModeAsync for bounded runtime evaluation."); return false end
		pairing = true
		state("CONNECTING", "Discovering the local Forge bridge and creating an authenticated session.")
		local discovered, discovery = request("GET", "/pairing")
		if not discovered or typeof(discovery) ~= "table" or typeof(discovery.pairing) ~= "table" or typeof(discovery.pairing.token) ~= "string" then pairing = false; state("WAITING FOR BRIDGE", "Start `forge studio bridge`; Forge will connect automatically."); return false end
		local ok, response, status = request("POST", "/message", { kind = "StudioProtocolMessage", direction = "plugin_to_backend", type = "PairProject", messageId = messageId("pair"), sentAt = iso(), payload = { pairingToken = discovery.pairing.token, project = identity(), capabilities = capabilities() } })
		pairing = false
		if not ok then state(status == 0 and "WAITING FOR BRIDGE" or "CONNECTION REJECTED", string.sub(tostring(response), 1, Constants.MAX_DIAGNOSTIC_CHARS)); return false end
		if typeof(response) ~= "table" or typeof(response.sessionId) ~= "string" or typeof(response.projectId) ~= "string" or typeof(response.sessionToken) ~= "string" then state("CONNECTION REJECTED", "Bridge returned an invalid pairing response."); return false end
		sessionId, projectId, sessionToken = response.sessionId, response.projectId, response.sessionToken
		stopRegistry = registry:start()
		if pairButton then pairButton.Text = "Disconnect" end
		state("CONNECTED", "Enrolling stable identities and sending a Studio snapshot.")
		return sendSnapshot("pairing")
	end

	local function handle(message)
		if typeof(message) ~= "table" or message.kind ~= "StudioProtocolMessage" or message.direction ~= "backend_to_plugin" or typeof(message.payload) ~= "table" or message.sessionId ~= sessionId then error("malformed or mismatched backend message") end
		if message.type == "RequestObservation" then
			if message.payload.reason ~= "pre_play" and message.payload.reason ~= "manual" then error("unsupported observation reason") end
			sendSnapshot(message.payload.reason)
		elseif message.type == "ExecuteRuntimeEvalPlan" then
			if message.payload.expectedRevision ~= revision then error("runtime execution requires the current observed Studio revision") end
			if not sessionId or not projectId or not revision then error("runtime execution requires an active Studio session") end
			runtimeCapabilities:arm(message.payload, message.requestId, { sessionId = sessionId, projectId = projectId, revision = revision, project = identity() })
			if message.payload.startPolicy == "creator_action_already_authorized" then
				if runButton then runButton.Visible = false end
				task.defer(startArmedRuntime)
			elseif runButton then runButton.Visible = true; runButton.Active = true; runButton.AutoButtonColor = true end
		elseif message.type == "PrepareCreatorChangeSet" then
			if not revision then error("creator change preparation requires a Studio revision") end
			local currentRevision = requireFreshRevision(message.payload.expectedRevision, "creator change preparation")
			local prepared = authoring:prepare(message.payload, currentRevision)
			send("CreatorChangePrepared", prepared, message.requestId)
		elseif message.type == "ApplyCreatorChangeSet" then
			if not revision then error("creator change application requires a Studio revision") end
			local beforeRevision = requireFreshRevision(message.payload.expectedRevision, "creator change application")
			local recording = authoring:apply(message.payload.changeSetId, message.payload.changeSetHash, beforeRevision)
			if not sendSnapshot("post_apply") then authoring:finalize(recording, "cancel"); error("could not publish the post-apply Studio snapshot") end
			send("CreatorChangeApplied", { creatorSessionId = message.payload.creatorSessionId, changeSetId = message.payload.changeSetId, changeSetHash = message.payload.changeSetHash, recordingId = recording, beforeRevisionHash = beforeRevision, afterRevisionHash = revision, inverseMaterialHash = Hash.sha256(message.payload.changeSetHash .. ":" .. tostring(beforeRevision)), status = "applied" }, message.requestId)
		elseif message.type == "FinalizeCreatorChangeSet" then
			local prepared = authoring:finalize(message.payload.recordingId, message.payload.action)
			if not sendSnapshot(message.payload.action == "commit" and "post_apply" or "post_rollback") then
				if message.payload.action == "commit" then error("RECOVERY_REQUIRED: committed Studio change could not be bound to its resulting revision") end
				error("could not publish cancelled Studio revision")
			end
			if message.payload.action == "commit" then authoring:bindCommittedRevision(message.payload.changeSetId, message.payload.changeSetHash, revision :: string) end
			send("CreatorChangeFinalized", { creatorSessionId = message.payload.creatorSessionId, changeSetId = message.payload.changeSetId, changeSetHash = message.payload.changeSetHash, recordingId = message.payload.recordingId, beforeRevisionHash = prepared.beforeRevision, afterRevisionHash = revision, inverseMaterialHash = Hash.sha256(message.payload.changeSetHash .. ":" .. prepared.beforeRevision), action = message.payload.action, status = message.payload.action == "commit" and "committed" or "cancelled" }, message.requestId)
		elseif message.type == "RollbackCreatorCheckpoint" then
			if not revision or message.payload.expectedRevision ~= revision then error("creator rollback requires the exact committed Studio revision") end
			local beforeRevision = revision
			authoring:rollback(message.payload, revision)
			if not sendSnapshot("post_rollback") then error("RECOVERY_REQUIRED: rolled-back Studio checkpoint could not be bound to its resulting revision") end
			send("CreatorCheckpointRolledBack", { creatorSessionId = message.payload.creatorSessionId, checkpointId = message.payload.checkpointId, changeSetId = message.payload.changeSetId, changeSetHash = message.payload.changeSetHash, beforeRevisionHash = beforeRevision, afterRevisionHash = revision, status = "rolled_back" }, message.requestId)
		else error("unsupported backend command") end
	end

	local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, true, false, 360, 220, 320, 180)
	local widget = plugin:CreateDockWidgetPluginGuiAsync("ForgeStudio", info); widget.Title = "Forge Connector"
	local frame = Instance.new("Frame"); frame.Size = UDim2.fromScale(1, 1); frame.BackgroundColor3 = Color3.fromRGB(17, 24, 39); frame.BorderSizePixel = 0; frame.Parent = widget
	widgetStatus = Instance.new("TextLabel"); widgetStatus.Size = UDim2.new(1, -24, 0, 28); widgetStatus.Position = UDim2.fromOffset(12, 12); widgetStatus.BackgroundTransparency = 1; widgetStatus.TextColor3 = Color3.fromRGB(229, 231, 235); widgetStatus.Font = Enum.Font.GothamBold; widgetStatus.TextSize = 16; widgetStatus.TextXAlignment = Enum.TextXAlignment.Left; widgetStatus.Parent = frame
	widgetDetail = Instance.new("TextLabel"); widgetDetail.Size = UDim2.new(1, -24, 0, 64); widgetDetail.Position = UDim2.fromOffset(12, 44); widgetDetail.BackgroundTransparency = 1; widgetDetail.TextColor3 = Color3.fromRGB(156, 163, 175); widgetDetail.Font = Enum.Font.Gotham; widgetDetail.TextSize = 12; widgetDetail.TextWrapped = true; widgetDetail.TextXAlignment = Enum.TextXAlignment.Left; widgetDetail.TextYAlignment = Enum.TextYAlignment.Top; widgetDetail.Parent = frame
	local evaluateButton = Instance.new("TextButton"); evaluateButton.Size = UDim2.new(1, -24, 0, 32); evaluateButton.Position = UDim2.fromOffset(12, 118); evaluateButton.Text = "Run Approved Play Solo Check"; evaluateButton.Visible = false; evaluateButton.Active = false; evaluateButton.AutoButtonColor = false; evaluateButton.Parent = frame; runButton = evaluateButton
	local pair = Instance.new("TextButton"); pair.Size = UDim2.new(1, -24, 0, 28); pair.Position = UDim2.fromOffset(12, 162); pair.Text = "Connecting…"; pair.Parent = frame; pairButton = pair
	state("CONNECTING", "Start the local Forge service. Prompts, evidence, approvals, and reports live in the dashboard.")
	pair.MouseButton1Click:Connect(function() if sessionId then unpair(true, "user", true) else autoConnectEnabled = true; nextAutoPair = 0; pair.Text = "Connecting…" end end)
	evaluateButton.MouseButton1Click:Connect(function()
		startArmedRuntime()
	end)

	task.spawn(function()
		local idle = 0.25; local transportFailures = 0; local nextHeartbeat = 0
		while running do
			if sessionId and sessionToken then
				local ok, response, statusCode = request("GET", "/poll?sessionId=" .. HttpService:UrlEncode(sessionId))
				if ok and typeof(response) == "table" and typeof(response.messages) == "table" then
					transportFailures = 0
					if os.clock() >= nextHeartbeat then send("Heartbeat", { project = identity(), currentSnapshotHash = revision }); nextHeartbeat = os.clock() + 15 end
					idle = runtimeCapabilities.active and 0.1 or (#response.messages == 0 and math.min(3, idle * 1.5) or 0.1)
					for _, message in ipairs(response.messages) do
						local handled, failure = pcall(function() handle(message) end)
						if not handled then
							local diagnostic = tostring(failure)
							pluginError(string.find(diagnostic, "RECOVERY_REQUIRED", 1, true) and "RECOVERY_REQUIRED" or "SECURITY_REJECTION", diagnostic, false, message.requestId)
						end
					end
					while #pending > 0 do local item = pending[1]; local sent, failure, status = send(item.kind, item.payload, item.requestId, item.messageId); if sent then table.remove(pending, 1) elseif permanentBridgeRejection(status) then table.remove(pending, 1); pluginError("STUDIO_FAILURE", "Bridge rejected queued " .. item.kind .. ": " .. tostring(failure), false, item.requestId) else break end end
				else
					transportFailures += 1
					if statusCode == 401 then unpair(false, "session_replaced") elseif transportFailures >= 3 then state("BRIDGE UNREACHABLE", runtimeCapabilities.active and "Runtime evidence is queued until the bridge reconnects." or "Forge will keep retrying this paired session.") end
					idle = math.min(3, idle * 2)
				end
			elseif autoConnectEnabled then if os.clock() >= nextAutoPair then pairAutomatically(); nextAutoPair = os.clock() + 1 end; idle = 0.25
			else idle = 0.5 end
			task.wait(idle)
		end
	end)
	plugin.Unloading:Connect(function() running = false; unpair(true, "plugin_unload", true) end)
end

return Runtime
