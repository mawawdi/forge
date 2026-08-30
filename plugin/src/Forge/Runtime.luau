--!strict
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")
local Constants = require(script.Parent.Constants)
local Hash = require(script.Parent.Hash)
local IdentityRegistry = require(script.Parent.IdentityRegistry)
local SnapshotCollector = require(script.Parent.SnapshotCollector)
local TransactionManager = require(script.Parent.TransactionManager)
local PatchExecutor = require(script.Parent.PatchExecutor)
local StudioProofExecutor = require(script.Parent.StudioProofExecutor)

local Runtime = {}

local function iso(): string return os.date("!%Y-%m-%dT%H:%M:%SZ") end
local function messageId(prefix: string): string return prefix .. "_" .. HttpService:GenerateGUID(false) end
local function identity() return { name = game.Name, placeId = game.PlaceId, universeId = game.GameId } end
local function studioVersion(): string
	local ok, clientGitHash = pcall(function() return RunService.ClientGitHash end)
	return ok and typeof(clientGitHash) == "string" and clientGitHash ~= "" and clientGitHash or "unknown-studio-build"
end
local function capabilities()
	local result = { "snapshot", "snapshot_chunks", "stable_identity", "typed_patch", "transaction", "http_polling", "bounded_diagnostics" }
	if Hash.available() then table.insert(result, "sha256") end
	if typeof(StudioTestService.ExecutePlayModeAsync) == "function" then table.insert(result, "studio_play_mode") end
	return result
end

function Runtime.start(plugin: Plugin)
	local bridgeUrl = plugin:GetSetting("forge.bridge.url.v7")
	if typeof(bridgeUrl) ~= "string" or bridgeUrl == "" then bridgeUrl = Constants.BRIDGE_URL end
	local sessionId: string? = nil
	local sessionToken: string? = nil
	local revision: string? = nil
	local latestSnapshot = nil
	local running = true
	local autoConnectEnabled = true
	local pairing = false
	local nextAutoPair = 0
	local pending = {} :: {{kind: string, payload: any, requestId: string?, messageId: string}}
	local registry = IdentityRegistry.new()
	local stopRegistry: (() -> ())? = nil
	local collector = SnapshotCollector.new(registry)
	local transactions = TransactionManager.new(function() return revision or "unavailable" end)
	local patches = PatchExecutor.new(registry, transactions)
	local widgetStatus: TextLabel? = nil
	local widgetDetail: TextLabel? = nil
	local pairButton: TextButton? = nil
	local runProofButton: TextButton? = nil

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
		local message = { kind = "StudioProtocolMessage", schemaVersion = Constants.PROTOCOL, direction = "plugin_to_backend", type = kind, messageId = suppliedId or messageId("msg"), sentAt = iso(), payload = payload }
		if sessionId then message.sessionId = sessionId end
		if requestId then message.requestId = requestId end
		local ok, reason, status = request("POST", "/v1/message", message)
		if not ok and status == 401 then state("DISCONNECTED", "Bridge session expired. Forge is cancelling local transaction state.") end
		return ok, reason, status
	end
	local function permanentBridgeRejection(status: any): boolean
		return typeof(status) == "number" and status >= 400 and status < 500
	end
	local function pluginError(code: string, detail: string, retryable: boolean, requestId: string?)
		if sessionId then send("PluginError", { code = code, message = string.sub(detail, 1, Constants.MAX_DIAGNOSTIC_CHARS), retryable = retryable }, requestId) end
		state("VERIFICATION REJECTED", string.sub(detail, 1, Constants.MAX_DIAGNOSTIC_CHARS))
	end
	local proof = StudioProofExecutor.new(function(kind, payload, requestId)
		local item = { kind = kind, payload = payload, requestId = requestId, messageId = messageId("proof") }
		-- Preserve lifecycle/result order across transient HTTP failures. Once one
		-- proof message enters the outbox, later messages queue behind it.
		if #pending > 0 then
			if #pending >= 16 then error("StudioProof result outbox exceeded its bound") end
			table.insert(pending, item)
			return false
		end
		local sent, failure, status = send(item.kind, item.payload, item.requestId, item.messageId)
		if sent then return true end
		if permanentBridgeRejection(status) then
			pluginError("STUDIO_FAILURE", "Bridge rejected " .. item.kind .. ": " .. string.sub(tostring(failure), 1, Constants.MAX_DIAGNOSTIC_CHARS), false, item.requestId)
			return nil
		end
		if #pending >= 16 then error("StudioProof result outbox exceeded its bound") end
		table.insert(pending, item)
		return false
	end, state)

	local function sendSnapshot(reason: string): boolean
		if not sessionId then return false end
		local ok, snapshotOrError = pcall(function() return collector:collect() end)
		if not ok then pluginError("STUDIO_FAILURE", tostring(snapshotOrError), false); return false end
		latestSnapshot = snapshotOrError; revision = latestSnapshot.revision.observationHash
		if #latestSnapshot.encoded <= Constants.MAX_SNAPSHOT_BYTES then
			local sent, failure = send("ProjectObservation", { project = latestSnapshot.project, revision = latestSnapshot.revision, observation = latestSnapshot.observation, reason = reason })
			if not sent then state("OBSERVATION REJECTED", tostring(failure)) end
			return sent
		end
		for _, chunk in ipairs(collector:chunks(latestSnapshot, reason)) do
			local sent, failure = send("SnapshotChunk", chunk)
			if not sent then state("OBSERVATION REJECTED", tostring(failure)); return false end
		end
		return true
	end
	local function unpair(notifyBridge: boolean?, reason: string?, disableAutoConnect: boolean?)
		if disableAutoConnect then autoConnectEnabled = false end
		proof:abort()
		if runProofButton then runProofButton.Active = false; runProofButton.AutoButtonColor = false end
		local rollbackFailure = nil
		if transactions.active then
			local success, outcome = transactions:rollback(transactions.active.id)
			if not success then rollbackFailure = outcome end
		end
		if notifyBridge and sessionId and sessionToken then
			send("UnpairProject", { reason = reason or "user" })
		end
		sessionId, sessionToken, revision, latestSnapshot = nil, nil, nil, nil
		if stopRegistry then stopRegistry(); stopRegistry = nil end
		table.clear(pending)
		if pairButton then pairButton.Text = autoConnectEnabled and "Connecting…" or "Connect" end
		if rollbackFailure then state("ROLLBACK FAILED", rollbackFailure)
		elseif autoConnectEnabled then state("CONNECTING", "Waiting for the local Forge bridge.")
		else state("DISCONNECTED", "Automatic connection is paused. Select Connect to resume.") end
	end
	local function pairAutomatically(): boolean
		if pairing or sessionId or not autoConnectEnabled then return false end
		pairing = true
		state("CONNECTING", "Discovering the local Forge bridge and creating an authenticated session.")
		local discovered, discovery = request("GET", "/v1/pairing")
		if not discovered or typeof(discovery) ~= "table" or typeof(discovery.pairing) ~= "table" or typeof(discovery.pairing.token) ~= "string" then
			pairing = false
			state("WAITING FOR BRIDGE", "Start `forge studio bridge`; Forge will connect automatically.")
			return false
		end
		local ok, response, status = request("POST", "/v1/message", { kind = "StudioProtocolMessage", schemaVersion = Constants.PROTOCOL, direction = "plugin_to_backend", type = "PairProject", messageId = messageId("pair"), sentAt = iso(), payload = { pairingToken = discovery.pairing.token, project = identity(), pluginVersion = Constants.VERSION, studioVersion = studioVersion(), protocolVersion = Constants.PROTOCOL, capabilities = capabilities() } })
		pairing = false
		if not ok then
			if status == 401 then
				state("CONNECTING", "The one-use pairing grant expired; Forge will request a fresh grant automatically.")
			elseif status == 0 then
				state("WAITING FOR BRIDGE", "The local bridge became unavailable; Forge will reconnect automatically.")
			else
				state("CONNECTION REJECTED", "Bridge rejected " .. Constants.VERSION .. ": " .. string.sub(tostring(response), 1, Constants.MAX_DIAGNOSTIC_CHARS) .. ". Restart the bridge after rebuilding Forge.")
			end
			return false
		end
		if typeof(response) ~= "table" or typeof(response.sessionId) ~= "string" or typeof(response.sessionToken) ~= "string" then
			state("CONNECTION REJECTED", "Bridge returned an invalid pairing response.")
			return false
		end
		sessionId, sessionToken = response.sessionId, response.sessionToken
		stopRegistry = registry:start()
		if pairButton then pairButton.Text = "Disconnect" end
		state("CONNECTED", "Enrolling stable identities and sending complete Studio snapshot.")
		return sendSnapshot("pairing")
	end
	local function validateCommand(message)
		if typeof(message) ~= "table" or message.kind ~= "StudioProtocolMessage" or message.schemaVersion ~= Constants.PROTOCOL or message.direction ~= "backend_to_plugin" or typeof(message.payload) ~= "table" then error("malformed backend message") end
		if message.sessionId ~= sessionId then error("message belongs to a different session") end
	end
	local function handle(message)
		validateCommand(message)
		local payload = message.payload
		if message.type == "RequestObservation" then sendSnapshot(payload.reason)
		elseif message.type == "BeginTransaction" then
			local active = transactions:begin(payload.transactionId, payload.expectedRevision)
			send("TransactionStarted", { transactionId = active.id, projectSnapshotHash = revision, status = "started" }, message.requestId)
		elseif message.type == "ApplyPatchSet" then
			transactions:requireActive(payload.transactionId, payload.expectedRevision)
			local results, failure = patches:apply(payload.patchPlan)
			if failure then
				send("PatchRejected", { patchSetId = payload.patchPlan.patchSet.id, patchSetHash = payload.patchSetHash, transactionId = payload.transactionId, projectSnapshotBefore = payload.expectedRevision, reason = failure, operationResults = results }, message.requestId)
				return
			end
			sendSnapshot("post_patch")
			send("PatchApplied", { patchSetId = payload.patchPlan.patchSet.id, patchSetHash = payload.patchSetHash, transactionId = payload.transactionId, projectSnapshotBefore = payload.expectedRevision, projectSnapshotAfter = revision, operations = results }, message.requestId)
		elseif message.type == "ExecuteAssertionPlan" then
			transactions:requireActive(payload.transactionId or "", payload.expectedRevision)
			if payload.project.placeId ~= game.PlaceId or payload.project.universeId ~= game.GameId then error("wrong Studio project") end
			if not proof:supportsPlan(payload) then error("unsupported CollectFruit assertion plan or assertion ID set") end
			proof:arm(payload, message.requestId)
			if runProofButton then runProofButton.Active = true; runProofButton.AutoButtonColor = true end
		elseif message.type == "CommitTransaction" then
			if proof.active then error("cannot commit while StudioProof is running") end
			transactions:commit(payload.transactionId, payload.expectedRevision)
			send("TransactionCommitted", { transactionId = payload.transactionId, projectSnapshotHash = revision, status = "committed" }, message.requestId); state("VERIFIED", "Studio verification completed; verified transaction committed.")
		elseif message.type == "RollbackTransaction" then
			local incomplete = proof:isIncomplete()
			proof:abort()
			local success, outcome, expectedRevision = transactions:rollback(payload.transactionId)
			local observed = sendSnapshot("rollback")
			if success and (not observed or revision ~= expectedRevision) then
				success = false
				outcome = "inverse applied but rollback revision mismatch"
			end
			send("TransactionRolledBack", { transactionId = payload.transactionId, projectSnapshotHash = revision, status = "rolled_back", rollback = outcome, success = success }, message.requestId)
			if success and incomplete then state("INCOMPLETE", "Playtest stopped before authoritative evidence; transaction rolled back: " .. outcome)
			elseif success then state("REJECTED", "Transaction rolled back: " .. outcome)
			else state("ROLLBACK FAILED", outcome) end
		end
	end

	local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, true, false, 360, 220, 320, 200)
	local widget = plugin:CreateDockWidgetPluginGuiAsync("ForgeStudioV7", info); widget.Title = "Forge Studio"
	local frame = Instance.new("Frame"); frame.Size = UDim2.fromScale(1, 1); frame.BackgroundColor3 = Color3.fromRGB(17, 24, 39); frame.BorderSizePixel = 0; frame.Parent = widget
	widgetStatus = Instance.new("TextLabel"); widgetStatus.Size = UDim2.new(1, -24, 0, 28); widgetStatus.Position = UDim2.fromOffset(12, 12); widgetStatus.BackgroundTransparency = 1; widgetStatus.TextColor3 = Color3.fromRGB(229, 231, 235); widgetStatus.Font = Enum.Font.GothamBold; widgetStatus.TextSize = 16; widgetStatus.TextXAlignment = Enum.TextXAlignment.Left; widgetStatus.Parent = frame
	widgetDetail = Instance.new("TextLabel"); widgetDetail.Size = UDim2.new(1, -24, 0, 50); widgetDetail.Position = UDim2.fromOffset(12, 44); widgetDetail.BackgroundTransparency = 1; widgetDetail.TextColor3 = Color3.fromRGB(156, 163, 175); widgetDetail.Font = Enum.Font.Gotham; widgetDetail.TextSize = 12; widgetDetail.TextWrapped = true; widgetDetail.TextXAlignment = Enum.TextXAlignment.Left; widgetDetail.TextYAlignment = Enum.TextYAlignment.Top; widgetDetail.Parent = frame
	local pair = Instance.new("TextButton"); pair.Size = UDim2.new(0.48, -12, 0, 32); pair.Position = UDim2.fromOffset(12, 105); pair.Text = "Connecting…"; pair.Parent = frame; pairButton = pair
	local snapshotButton = Instance.new("TextButton"); snapshotButton.Size = UDim2.new(0.48, -12, 0, 32); snapshotButton.Position = UDim2.new(0.52, 0, 0, 105); snapshotButton.Text = "Snapshot"; snapshotButton.Parent = frame
	local runButton = Instance.new("TextButton"); runButton.Size = UDim2.new(1, -24, 0, 36); runButton.Position = UDim2.fromOffset(12, 149); runButton.Text = "Verify in Studio"; runButton.Active = false; runButton.AutoButtonColor = false; runButton.Parent = frame; runProofButton = runButton
	state("CONNECTING", "Start the local Forge bridge; this place will connect automatically.")
	pair.MouseButton1Click:Connect(function()
		if sessionId then unpair(true, "user", true); return end
		autoConnectEnabled = true
		nextAutoPair = 0
		pair.Text = "Connecting…"
		state("CONNECTING", "Discovering the local Forge bridge.")
	end)
	snapshotButton.MouseButton1Click:Connect(function() if not sendSnapshot("manual") then state("SNAPSHOT FAILED", "Pair first or resolve the bridge error.") end end)
	runButton.MouseButton1Click:Connect(function()
		if not sessionId or not proof.active or proof.active.phase ~= "armed" then
			state("NOT READY", "Run forge studio verify first; it will arm one exact verification run.")
			return
		end
		runButton.Active = false
		runButton.AutoButtonColor = false
		if not sendSnapshot("pre_play") then
			local requestId = proof.active and proof.active.requestId or nil
			proof:abort()
			pluginError("STUDIO_FAILURE", "Could not confirm the live Studio revision before Play Solo.", true, requestId)
			return
		end
		local valid, failure = pcall(function()
			transactions:requireActive(proof.active.payload.transactionId, proof.active.payload.expectedRevision)
		end)
		if not valid then
			local requestId = proof.active and proof.active.requestId or nil
			proof:abort()
			pluginError("STALE_SNAPSHOT", tostring(failure), false, requestId)
			return
		end
		local started, startFailure = pcall(function() proof:start() end)
		if not started then pluginError("STUDIO_FAILURE", tostring(startFailure), false) end
	end)
	task.spawn(function()
		local idle = 0.25
		local transportFailures = 0
		local nextHeartbeat = 0
		while running do
			if sessionId and sessionToken then
				local ok, response, statusCode = request("GET", "/v1/poll?sessionId=" .. HttpService:UrlEncode(sessionId))
				if ok and typeof(response) == "table" and typeof(response.messages) == "table" then
					if transportFailures >= 3 and not proof.active then state("CONNECTED", "Bridge connection recovered.") end
					transportFailures = 0
					if os.clock() >= nextHeartbeat then
						send("Heartbeat", { pluginVersion = Constants.VERSION, studioVersion = studioVersion(), project = identity(), currentSnapshotHash = revision })
						nextHeartbeat = os.clock() + 15
					end
					idle = proof.active and 0.1 or (#response.messages == 0 and math.min(3, idle * 1.5) or 0.1)
					for _, message in ipairs(response.messages) do local handled, failure = pcall(function() handle(message) end); if not handled then pluginError("SECURITY_REJECTION", tostring(failure), false, message.requestId) end end
					while #pending > 0 do
						local item = pending[1]
						local sent, failure, status = send(item.kind, item.payload, item.requestId, item.messageId)
						if sent then
							table.remove(pending, 1)
						elseif permanentBridgeRejection(status) then
							table.remove(pending, 1)
							pluginError("STUDIO_FAILURE", "Bridge rejected queued " .. item.kind .. ": " .. string.sub(tostring(failure), 1, Constants.MAX_DIAGNOSTIC_CHARS), false, item.requestId)
						else break end
					end
				else
					transportFailures += 1
					if statusCode == 401 then unpair(false, "session_replaced")
					elseif transportFailures >= 3 then state("BRIDGE UNREACHABLE", proof.active and "Verification cannot finish until the bridge reconnects; completed evidence will retry." or "Forge will keep retrying this paired session.") end
					idle = math.min(3, idle * 2)
				end
			elseif autoConnectEnabled then
				if os.clock() >= nextAutoPair then
					pairAutomatically()
					nextAutoPair = os.clock() + 1
				end
				idle = 0.25
			else idle = 0.5 end
			task.wait(idle)
		end
	end)
	plugin.Unloading:Connect(function() running = false; unpair(true, "plugin_unload", true) end)
end

return Runtime
