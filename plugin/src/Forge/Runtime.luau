--!strict
local HttpService = game:GetService("HttpService")
local StudioTestService = game:GetService("StudioTestService")
local Constants = require(script.Parent.Constants)
local ConnectorView = require(script.Parent.ConnectorView)
local ConnectorPresentation = require(script.Parent.ConnectorPresentation)
local Generated = require(script.Parent.GeneratedStudioEvidence)
local Hash = require(script.Parent.Hash)
local IdentityRegistry = require(script.Parent.IdentityRegistry)
local RuntimeCapabilityExecutor = require(script.Parent.RuntimeCapabilityExecutor)
local SerializedStudioWorker = require(script.Parent.SerializedStudioWorker)
local StudioAuthoring = require(script.Parent.StudioAuthoring)
local StudioEvidenceCollector = require(script.Parent.StudioEvidenceCollector)
local StudioProjectIndexCollector = require(script.Parent.StudioProjectIndexCollector)
local StudioProjectIndexCanonical = require(script.Parent.StudioProjectIndexCanonical)
local StudioProjectChangeMonitor = require(script.Parent.StudioProjectChangeMonitor)
local StudioProjectAuthority = require(script.Parent.StudioProjectAuthority)
local StudioProjectIdentity = require(script.Parent.StudioProjectIdentity)
local StudioSemanticTransport = require(script.Parent.StudioSemanticTransport)

local Runtime = {}

local function iso(): string return os.date("!%Y-%m-%dT%H:%M:%S.000Z") end
local function messageId(prefix: string): string return prefix .. "_" .. HttpService:GenerateGUID(false) end
local function capabilities()
	return { "studio_evidence", "studio_project_index", "opaque_identity", "project_change_monitor", "semantic_message_stream", "sha256", "stable_identity", "reflection_attestation", "detached_preflight", "transactional_authoring", "recording_recovery", "studio_play_mode", "bounded_diagnostics", "project_identity", "http_polling" }
end
local function connectorBuildHash(): string return Generated.connectorBuildHash end
local function substrateAvailable(): boolean return Hash.available() end
local function retryableOrderedTransportFailure(status: number, failure: any): boolean
	if status == 0 or status == 408 or status == 429 or status >= 500 then return true end
	-- A response can be lost after the host admitted an exact frame. If the
	-- replay overlaps the first handler, the bridge reports this one bounded
	-- transient conflict; all semantic binding/order conflicts remain terminal.
	return status == 409 and string.find(tostring(failure), "Studio message is still processing", 1, true) ~= nil
end

-- Plugins are reloaded into distinct Edit, Play Server, and Play Client data
-- models.  The only cross-data-model input is the readback-verified passive
-- arm; this path deliberately does not pair, create a widget, or touch a
-- place object.  Play Client is excluded by Main.server.luau.
function Runtime.startPassive(plugin: Plugin)
	local contextOk, arm = pcall(function() return RuntimeCapabilityExecutor.passiveContext(plugin) end)
	if not contextOk then return end
	if not arm then
		-- Registered programmatic evaluations carry their sealed plan through
		-- StudioTestService test args. Ordinary creator Play has no such argument
		-- and therefore remains inert unless an exact durable creator arm exists.
		pcall(function() RuntimeCapabilityExecutor.runProgrammaticTest() end)
		return
	end
	local function messageFor(kind: string, payload: any, requestId: string?, suppliedId: string?, sentAt: string?): any
		return {
			kind = "StudioProtocolMessage", direction = "plugin_to_backend", type = kind,
			messageId = suppliedId or ("passive_runtime_" .. string.sub(Hash.sha256(arm.armHash .. ":" .. kind), 1, 24)),
			sentAt = sentAt or iso(), sessionId = arm.sessionId, requestId = requestId, payload = payload,
		}
	end
	local function postExact(message: any): (boolean, any?)
		local encodedOk, encoded = pcall(function() return StudioProjectIndexCanonical.transportJson(message) end)
		if not encodedOk or #encoded > Constants.MAX_MESSAGE_BYTES then return false, encodedOk and "request exceeds protocol limit" or encoded end
		local lastFailure: any = "transport failed"
		for attempt = 1, 3 do
			local requestOk, response = pcall(function()
				return HttpService:RequestAsync({ Url = arm.bridgeUrl .. "/message", Method = "POST", Headers = { ["Content-Type"] = "application/json", ["X-Forge-Session-Token"] = arm.sessionToken }, Body = encoded })
			end)
			if requestOk and typeof(response) == "table" and response.Success == true then return true, nil end
			local status = requestOk and typeof(response) == "table" and typeof(response.StatusCode) == "number" and response.StatusCode or 0
			lastFailure = requestOk and typeof(response) == "table" and (tostring(status) .. ": " .. tostring(response.StatusMessage)) or response
			if requestOk and typeof(response) == "table" and typeof(response.Body) == "string" and response.Body ~= "" then
				local decoded, body = pcall(function() return HttpService:JSONDecode(response.Body) end)
				lastFailure = tostring(lastFailure) .. " — " .. (decoded and typeof(body) == "table" and typeof(body.message) == "string" and body.message or string.sub(response.Body, 1, Constants.MAX_DIAGNOSTIC_CHARS))
			end
			if not retryableOrderedTransportFailure(status, lastFailure) then break end
			if attempt < 3 then task.wait(0.05 * attempt) end
		end
		return false, lastFailure
	end
	local function send(kind: string, payload: any, requestId: string?, suppliedId: string?): boolean
		local evidenceEndedAt = StudioSemanticTransport.isStreamedType(kind) and typeof(payload) == "table" and typeof(payload.envelope) == "table" and payload.envelope.endedAt or nil
		local logical = messageFor(kind, payload, requestId, suppliedId, evidenceEndedAt)
		if not StudioSemanticTransport.isStreamedType(kind) then
			local sent = postExact(logical)
			return sent
		end
		local framed, frames = pcall(function() return StudioSemanticTransport.frames(logical) end)
		if not framed then return false end
		local sent = StudioSemanticTransport.deliver(frames, function(frame: any): (boolean, any?, number?)
			local delivered, failure = postExact(messageFor(frame.type, frame.payload, frame.requestId, frame.messageId, logical.sentAt))
			return delivered, failure, nil
		end)
		return sent
	end
	local executor = RuntimeCapabilityExecutor.new(plugin, send, function() end)
	local resumed, resumeResult = pcall(function() return executor:resumePassive() end)
	if not resumed then
		send("PluginError", { code = "STUDIO_FAILURE", message = string.sub("Passive Play-server runtime could not start: " .. tostring(resumeResult), 1, Constants.MAX_DIAGNOSTIC_CHARS), retryable = false }, arm.requestId, "passive_runtime_" .. string.sub(Hash.sha256(arm.armHash .. ":resume_error"), 1, 24))
		return
	end
	if resumeResult ~= true then return end
	local finalized = false
	local function finalize()
		if finalized then return end
		finalized = true
		executor:sealPassive()
	end
	plugin.Unloading:Connect(finalize)
	pcall(function() game:BindToClose(finalize) end)
end

function Runtime.start(plugin: Plugin)
	local passiveContextOk, passiveArmOrFailure = pcall(function() return RuntimeCapabilityExecutor.passiveContext(plugin) end)
	local passiveArm = passiveContextOk and passiveArmOrFailure or nil
	local bridgeUrl = passiveArm and passiveArm.bridgeUrl or plugin:GetSetting("ForgeBridgeUrlV2")
	if typeof(bridgeUrl) ~= "string" or bridgeUrl == "" then bridgeUrl = Constants.BRIDGE_URL end
	local sessionId: string? = passiveArm and passiveArm.sessionId or nil
	local projectId: string? = passiveArm and passiveArm.projectId or nil
	local sessionToken: string? = passiveArm and passiveArm.sessionToken or nil
	local pairedProject: any? = passiveArm and passiveArm.project or nil
	local currentProjectRevision: string? = passiveArm and passiveArm.expectedProjectRevisionHash or nil
	local currentProjectIndexManifestId: string? = nil
	local currentProjectIndexCapture: any? = nil
	local currentProjectIndexDetectorEpoch: number? = nil
	local projectIndexProjection: any? = nil
	local running, autoConnectEnabled, pairing = true, passiveContextOk and passiveArm == nil, false
	local passiveResume = passiveArm ~= nil
	local invalidPassiveState = not passiveContextOk
	local currentCreatorSessionId: string? = passiveArm and passiveArm.creatorSessionId or nil
	local nextAutoPair, transportFailures = 0, 0
	local pending = {} :: {{message: any, requestId: string?}}
	-- Commands are retained by the bridge until this process settles the exact
	-- body. Keep only a bounded in-process receipt log so an accepted
	-- POST with a lost response can be replayed with its original message id.
	local handledCommands = {} :: {[string]: {commandHash: string, settlement: any, settlementMessageId: string}}
	local handledCommandOrder = {} :: {string}
	local registry = IdentityRegistry.new()
	local collector = StudioEvidenceCollector.new(registry)
	local projectIndexCollector = StudioProjectIndexCollector.new(registry)
	local authoring = StudioAuthoring.new(plugin, registry, collector)
	local projectIdentity = StudioProjectIdentity.new(plugin)
	local stopRegistry: (() -> ())? = nil
	local projectChangeMonitor: any? = nil
	local connectorView: ConnectorView.View? = nil
	local latestStatus = "CONNECTING"
	local function updateConnectionView()
		if not connectorView then return end
		connectorView.setConnection(if invalidPassiveState then "invalid_receipt" elseif passiveResume then "reserved" elseif sessionId then "connected" elseif autoConnectEnabled then "connecting" else "disconnected")
	end

	local function state(title: string, detail: string)
		latestStatus = title
		if connectorView then connectorView.setStatus(title, detail); updateConnectionView() end
	end
	local studioWorker = SerializedStudioWorker.new({
		onError = function(failure: any)
			state("EVIDENCE INCOMPLETE", "Serialized Studio work failed: " .. string.sub(tostring(failure), 1, Constants.MAX_DIAGNOSTIC_CHARS))
		end,
	})
	local function cooperativeBudget(): () -> ()
		local nextYieldAt = os.clock() + 0.008
		return function()
			if not running then error("serialized Studio work was stopped") end
			if os.clock() < nextYieldAt then return end
			task.wait()
			nextYieldAt = os.clock() + 0.008
		end
	end
	local function request(method: string, path: string, body: any?)
		local headers = { ["Content-Type"] = "application/json" }
		if sessionToken then headers["X-Forge-Session-Token"] = sessionToken end
		local options: any = { Url = bridgeUrl .. path, Method = method, Headers = headers }
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
				detail ..= decoded and typeof(errorBody) == "table" and typeof(errorBody.message) == "string" and " — " .. errorBody.message or " — " .. string.sub(response.Body, 1, Constants.MAX_DIAGNOSTIC_CHARS)
			end
			return false, detail, response.StatusCode
		end
		if response.Body == "" then return true, nil, response.StatusCode end
		local decoded, value = pcall(function() return HttpService:JSONDecode(response.Body) end)
		return decoded, value, response.StatusCode
	end
	local function messageFor(kind: string, payload: any, requestId: string?, suppliedId: string?, sentAt: string?): any
		local message: any = { kind = "StudioProtocolMessage", direction = "plugin_to_backend", type = kind, messageId = suppliedId or messageId("msg"), sentAt = sentAt or iso(), payload = payload }
		if sessionId then message.sessionId = sessionId end
		if requestId then message.requestId = requestId end
		return message
	end
	local function postMessage(message: any): (boolean, any?, number)
		return request("POST", "/message", message)
	end
	local function send(kind: string, payload: any, requestId: string?, suppliedId: string?): (boolean, any?, number)
		return postMessage(messageFor(kind, payload, requestId, suppliedId))
	end
	local function outcomeMessageId(kind: string, payload: any, requestId: string?): string
		local encoded = HttpService:JSONEncode(payload)
		return "outcome_" .. string.sub(Hash.sha256(kind .. ":" .. (requestId or "") .. ":" .. encoded), 1, 32)
	end
	local function retainPending(item: {message: any, requestId: string?})
		for _, existing in ipairs(pending) do
			if existing.message.messageId == item.message.messageId then return end
		end
		if #pending >= 16 then error("runtime outbox exceeds bound") end
		table.insert(pending, item)
	end
	local function postOrdered(message: any): (boolean, any?, number)
		local lastFailure: any, lastStatus: number = "transport failed", 0
		for attempt = 1, 3 do
			local sent, failure, status = postMessage(message)
			if sent then return true, nil, status end
			lastFailure, lastStatus = failure, status
			if not retryableOrderedTransportFailure(status, failure) then break end
			if attempt < 3 then task.wait(0.05 * attempt) end
		end
		return false, lastFailure, lastStatus
	end
	local function semanticEvidenceEndedAt(kind: string, payload: any): string?
		if typeof(payload) ~= "table" then return nil end
		if kind == "StudioEvidenceProduced" and typeof(payload.envelope) == "table" then return payload.envelope.endedAt end
		if kind == "CreatorChangePreflighted" and typeof(payload.preflightEvidence) == "table" then return payload.preflightEvidence.endedAt end
		if kind == "CreatorMutationProvisional" and typeof(payload.directReadbackEvidence) == "table" then return payload.directReadbackEvidence.endedAt end
		return nil
	end
	local function sendSemantic(kind: string, payload: any, requestId: string?, suppliedId: string?): (boolean, any?, number)
		local logical = messageFor(kind, payload, requestId, suppliedId or outcomeMessageId(kind, payload, requestId), semanticEvidenceEndedAt(kind, payload))
		local framed, frames = pcall(function() return StudioSemanticTransport.frames(logical, cooperativeBudget()) end)
		if not framed then return false, frames, 0 end
		return StudioSemanticTransport.deliver(frames, function(frame: any): (boolean, any?, number?)
			local physical = messageFor(frame.type, frame.payload, frame.requestId, frame.messageId, logical.sentAt)
			return postOrdered(physical)
		end)
	end
	local function sendRequired(kind: string, payload: any, requestId: string?, suppliedId: string?)
		if StudioSemanticTransport.isStreamedType(kind) then
			local sent, failure = sendSemantic(kind, payload, requestId, suppliedId)
			if not sent then error(kind .. " ordered semantic transport failed: " .. tostring(failure)) end
			return
		end
		local message = messageFor(kind, payload, requestId, suppliedId or outcomeMessageId(kind, payload, requestId))
		local item = { message = message, requestId = requestId }
		local sent, failure, status = postMessage(message)
		if sent then return end
		if typeof(status) == "number" and status >= 400 and status < 500 then error(kind .. " was rejected: " .. tostring(failure)) end
		retainPending(item)
	end
	local function sendOrderedRequired(kind: string, payload: any, requestId: string?)
		local message = messageFor(kind, payload, requestId, outcomeMessageId(kind, payload, requestId))
		local sent, failure = postOrdered(message)
		if not sent then error(kind .. " ordered transport failed: " .. tostring(failure)) end
	end
	local function pluginError(code: string, detail: any, retryable: boolean, requestId: string?)
		if sessionId then send("PluginError", { code = code, message = string.sub(tostring(detail), 1, Constants.MAX_DIAGNOSTIC_CHARS), retryable = retryable }, requestId) end
		state(code == "RECOVERY_REQUIRED" and "RECOVERY REQUIRED" or "EVIDENCE INCOMPLETE", string.sub(tostring(detail), 1, Constants.MAX_DIAGNOSTIC_CHARS))
	end
	local pendingProjectChangeNotice: any? = nil
	local function queueProjectChangeNotice(notice: any)
		-- Dirty notifications are advisory invalidations. Coalesce a burst to its
		-- newest detector epoch and never perform RequestAsync from an engine signal
		-- callback. The serialized worker delivers it after the current transaction
		-- boundary. The epoch fences live reads and current authority; it never
		-- invalidates an immutable capture which completed before the callback.
		pendingProjectChangeNotice = notice
		studioWorker:enqueue("project-change-notice", function()
			while pendingProjectChangeNotice ~= nil do
				local current = pendingProjectChangeNotice
				pendingProjectChangeNotice = nil
				if sessionId and sessionToken then
					local payload = { project = collector:identity(), connectorEpoch = registry.connectorEpoch, epoch = current.epoch, observedAt = current.observedAt, sources = current.sources }
					local noticeMessage = messageFor("StudioProjectChangeDetected", payload, nil, outcomeMessageId("StudioProjectChangeDetected", payload, nil))
					local sent, failure, status = postMessage(noticeMessage)
					if not sent then
						if typeof(status) == "number" and status >= 400 and status < 500 then
							state("PROJECT CHANGED", "Forge detected a Studio change but the control plane rejected its exact notice: " .. string.sub(tostring(failure), 1, Constants.MAX_DIAGNOSTIC_CHARS))
						else
							-- Keep the exact notice identity in the bounded outbox. A lost
							-- response cannot silently erase the barrier or mint a new epoch.
							retainPending({ message = noticeMessage, requestId = nil })
							state("PROJECT CHANGED", "Forge detected a Studio change and will retry its exact notice when the local bridge is reachable.")
						end
					end
				end
			end
		end)
	end
	local function decodeProjection(json: any, jsonHash: any, projectionHash: any)
		if typeof(json) ~= "string" or typeof(jsonHash) ~= "string" or Hash.sha256(json) ~= jsonHash then error("projection transport hash mismatch") end
		local ok, projection = pcall(function() return HttpService:JSONDecode(json) end)
		if not ok or typeof(projection) ~= "table" or typeof(projectionHash) ~= "string" or projection.contentHash ~= projectionHash then error("projection JSON/content binding mismatch") end
		Generated.validateProjection(projection)
		return projection
	end
	local function evidencePayload(reason: string, projection: any, envelope: any)
		return { project = collector:identity(), reason = reason, projection = projection, envelope = envelope }
	end
	local function sendEvidence(reason: string, projection: any, requestId: string?): (boolean, any?, any?)
		local cooperate = cooperativeBudget()
		local made, envelope = pcall(function()
			if projection.purpose == "capability_attestation" then return collector:attestation(projection, cooperate) end
			return collector:produce(projection, nil, cooperate)
		end)
		if not made then return false, envelope, nil end
		local payload = evidencePayload(reason, projection, envelope)
		local sent, failure = sendSemantic("StudioEvidenceProduced", payload, requestId)
		return sent, failure, envelope
	end
	-- Project revision authority comes only from a complete immutable index
	-- capture. Transaction guards may collect without transport; only captures
	-- named by a protocol receipt are published. This keeps one and only one
	-- project-index stream on each request ID.
		local function collectProjectIndex(boundary: string, suppliedProjection: any?): any
			local selected = suppliedProjection or projectIndexProjection
			if typeof(selected) ~= "table" then error(boundary .. " has no exact project-index projection") end
			if projectChangeMonitor == nil or not projectChangeMonitor:isUsable() then error(boundary .. " cannot collect a project index without complete external-change monitoring") end
			local maximumDurationMs = selected.bounds and selected.bounds.maximumIndexingDurationMs
			if typeof(maximumDurationMs) ~= "number" or maximumDurationMs <= 0 then error(boundary .. " project-index duration bound is malformed") end
			local deadline = os.clock() + maximumDurationMs / 1000
			while true do
				if projectChangeMonitor == nil or not projectChangeMonitor:isUsable() then error(boundary .. " lost complete external-change monitoring") end
				if os.clock() >= deadline then error(boundary .. " project-index duration resource policy exceeded") end
				local detectorEpoch = projectChangeMonitor:detectorEpoch()
				local produced, captureOrFailure = pcall(function()
					return projectIndexCollector:produce(selected, detectorEpoch, function(): number
						if projectChangeMonitor == nil then error("project change monitor is unavailable") end
						return projectChangeMonitor:detectorEpoch()
					end, deadline)
				end)
				local currentEpoch = projectChangeMonitor:detectorEpoch()
				if produced and currentEpoch == detectorEpoch then return captureOrFailure, detectorEpoch end
				-- A callback during a read invalidates that attempt, not the operation.
				-- Restart the complete capture under the same overall resource bound;
				-- never splice shards from different epochs or call a provider.
				if currentEpoch == detectorEpoch or os.clock() >= deadline then
					if produced then error(boundary .. " project changed during index collection") end
					error(captureOrFailure)
				end
				task.wait()
			end
		end
		local function requireCurrentProjectIndex(boundary: string): any
			local capture = currentProjectIndexCapture
			if typeof(capture) ~= "table" or typeof(capture.indexManifest) ~= "table" or typeof(capture.revision) ~= "table" then error(boundary .. " has no complete current project index") end
			if projectChangeMonitor == nil or not projectChangeMonitor:isUsable() then error(boundary .. " cannot trust the current project index without complete external-change monitoring") end
			if typeof(currentProjectIndexDetectorEpoch) ~= "number" or projectChangeMonitor:detectorEpoch() ~= currentProjectIndexDetectorEpoch then error(boundary .. " project changed after the current project index") end
			if currentProjectIndexManifestId ~= capture.indexManifest.id or currentProjectRevision ~= capture.revision.hash then error(boundary .. " current project-index binding is inconsistent") end
			return capture
		end
		-- Finishing a ChangeHistory recording is a Studio mutation. The recording
		-- binding alone is insufficient: the connector must hold a complete current
		-- capture with the same semantic manifest/revision and no later dirty hint.
		-- A newer detector epoch is legal only after a fresh capture proves that all
		-- intervening hints left the approved state unchanged. The transaction's
		-- original detector epoch remains a monotonic lower-bound, not a demand that
		-- delayed engine callbacks never existed.
		local function requireExpectedCurrentProjectIndex(boundary: string, manifestId: any, revisionHash: any, detectorEpoch: any): any
			if typeof(manifestId) ~= "string"
				or typeof(revisionHash) ~= "string"
				or typeof(detectorEpoch) ~= "number"
				or detectorEpoch % 1 ~= 0
				or detectorEpoch < 0
			then error("RECOVERY_REQUIRED: finalization gate is malformed") end
			local capture = requireCurrentProjectIndex(boundary)
			if capture.indexManifest.id ~= manifestId
				or capture.revision.hash ~= revisionHash
				or currentProjectIndexDetectorEpoch < detectorEpoch
			then error("RECOVERY_REQUIRED: finalization gate no longer matches the current Studio project") end
			return capture
		end
		local function durableFinalizationGate(binding: any): (any, any, any, any, any)
			if typeof(binding) ~= "table" then error("RECOVERY_REQUIRED: finalization has no durable recording cursor") end
			-- Once the intent has crossed durable storage, it becomes the sole
			-- authority for the immediately-before-Finish recheck. This proves the
			-- eventual receipt will echo the same gate, rather than a later capture.
			if typeof(binding.finalization) == "table" then
				return binding.finalization.expectedCurrentProjectIndexManifestId,
					binding.finalization.expectedCurrentProjectRevisionHash,
					binding.finalization.expectedCurrentProjectDetectorEpoch,
					binding.finalization.finalizationKind,
					binding.finalization.replacesAction
			end
			local expected = binding.provisional or binding.recovery
			if typeof(expected) ~= "table" then error("RECOVERY_REQUIRED: finalization cursor has no durable current-project gate") end
			return expected.postApplyProjectIndexManifestId or expected.projectIndexManifestId,
				expected.postApplyProjectRevisionHash or expected.projectRevisionHash,
				expected.postApplyProjectDetectorEpoch or expected.projectDetectorEpoch,
				nil,
				nil
		end
		local function requireDurableFinalizationGate(binding: any, boundary: string): any
			local manifestId, revisionHash, detectorEpoch = durableFinalizationGate(binding)
			return requireExpectedCurrentProjectIndex(boundary, manifestId, revisionHash, detectorEpoch)
		end
		local function requireFinalizationGate(payload: any, binding: any, boundary: string, initialRecoveryCancellation: boolean?): any
			if typeof(payload) ~= "table"
				or (payload.action ~= "commit" and payload.action ~= "cancel")
				or (payload.finalizationKind ~= "ordinary" and payload.finalizationKind ~= "recovery_cancel")
				or (payload.finalizationKind == "ordinary" and payload.replacesAction ~= nil)
				or (payload.finalizationKind == "recovery_cancel" and (payload.action ~= "cancel" or (payload.replacesAction ~= "commit" and payload.replacesAction ~= "cancel")))
			then error("RECOVERY_REQUIRED: finalization gate is malformed") end
			local capture = requireExpectedCurrentProjectIndex(boundary, payload.expectedCurrentProjectIndexManifestId, payload.expectedCurrentProjectRevisionHash, payload.expectedCurrentProjectDetectorEpoch)
			local manifestId, revisionHash, detectorEpoch, finalizationKind, replacesAction: any
			if initialRecoveryCancellation == true then
				-- A recovery cancellation deliberately replaces a *prior ordinary*
				-- finalization intent. Its expected-current gate must be the fresh,
				-- durably retained recovery capture, not the original action's
				-- post-Apply gate. Keep the original action solely as explicit
				-- replacement provenance; never derive it from the ambient phase.
				local original = binding.finalization
				local recovery = binding.recovery
				if typeof(original) ~= "table"
					or original.finalizationKind ~= "ordinary"
					or original.recovery == true
					or original.action ~= payload.replacesAction
					or typeof(recovery) ~= "table"
				then error("RECOVERY_REQUIRED: recovery cancellation lacks an ordinary finalization intent and durable replacement provenance") end
				manifestId = recovery.projectIndexManifestId
				revisionHash = recovery.projectRevisionHash
				detectorEpoch = recovery.projectDetectorEpoch
			else
				manifestId, revisionHash, detectorEpoch, finalizationKind, replacesAction = durableFinalizationGate(binding)
			end
			if manifestId ~= payload.expectedCurrentProjectIndexManifestId
				or revisionHash ~= payload.expectedCurrentProjectRevisionHash
				or detectorEpoch ~= payload.expectedCurrentProjectDetectorEpoch
				or (finalizationKind ~= nil and finalizationKind ~= payload.finalizationKind)
				or (finalizationKind == "recovery_cancel" and replacesAction ~= payload.replacesAction)
			then error("RECOVERY_REQUIRED: finalization gate does not match its durable cursor") end
			return capture
		end
		local function clearFinalizationMonitorState(recordingId: any)
			if projectChangeMonitor == nil then return end
			projectChangeMonitor:clearExactForgeMutationFacts()
			if typeof(recordingId) == "string" then
				-- Once final evidence cannot be retained, an old completion callback
				-- must become an ordinary dirty signal rather than survive as an
				-- unbounded exact-state exemption.
				projectChangeMonitor:clearExpectedForgeRecordingFinish(recordingId)
			end
		end
		local function publishProjectIndex(boundary: string, requestId: string?, suppliedProjection: any?, publicationMode: string?): any
			local mode = publicationMode or "current"
			if mode ~= "current" and mode ~= "transaction_evidence" then error("project index publication mode is invalid") end
			local capture, detectorEpoch = collectProjectIndex(boundary, suppliedProjection)
			local stream = projectIndexCollector:transport(capture)
			sendOrderedRequired("StudioProjectIndexStarted", stream.started, requestId)
			stream.emit(function(pieceType: string, piecePayload: any)
				sendOrderedRequired(pieceType, piecePayload, requestId)
			end)
			sendOrderedRequired("StudioProjectIndexCompleted", stream.completed, requestId)
			-- Current authority and historical transaction evidence are different
			-- claims. A callback after collection leaves the immutable stream valid,
			-- but only a still-current capture may replace the connector's command
			-- gate. Transaction evidence is retained by the host and a queued dirty
			-- notice forces a fresh comparison before Play or finalization.
			local remainsCurrent = projectChangeMonitor ~= nil
				and projectChangeMonitor:isUsable()
				and projectChangeMonitor:detectorEpoch() == detectorEpoch
			if remainsCurrent then
				currentProjectIndexManifestId = capture.indexManifest.id
				currentProjectRevision = capture.revision.hash
				currentProjectIndexCapture = capture
				currentProjectIndexDetectorEpoch = detectorEpoch
			elseif mode == "current" then
				error(boundary .. " project changed after stable index collection")
			end
			return capture
		end
	local function recoveryProjectIndexProjection(recording: any): any
		if typeof(recording) ~= "table" or recording.manifestHash ~= Generated.manifestHash then error("persisted recording cursor is malformed or does not match the current manifest") end
		if typeof(projectIndexProjection) == "table" then return projectIndexProjection end
		if typeof(registry.connectorEpoch) ~= "string" or registry.connectorEpoch == "" then error("RECOVERY_REQUIRED: recovery has no current connector epoch") end
		projectIndexProjection = authoring:recoveryProjectIndexProjection(recording, registry.connectorEpoch)
		return projectIndexProjection
	end
	local function finalizationPayload(receipt: any): any
			if typeof(receipt) ~= "table"
				or typeof(receipt.beforeProjectDetectorEpoch) ~= "number"
				or typeof(receipt.afterProjectIndexManifestId) ~= "string"
				or typeof(receipt.afterProjectRevisionHash) ~= "string"
				or typeof(receipt.afterProjectDetectorEpoch) ~= "number"
				or typeof(receipt.expectedCurrentProjectIndexManifestId) ~= "string"
				or typeof(receipt.expectedCurrentProjectRevisionHash) ~= "string"
				or typeof(receipt.expectedCurrentProjectDetectorEpoch) ~= "number"
				or (receipt.finalizationKind ~= "ordinary" and receipt.finalizationKind ~= "recovery_cancel")
				or (receipt.finalizationKind == "recovery_cancel" and receipt.replacesAction ~= "commit" and receipt.replacesAction ~= "cancel")
				or (receipt.finalizationKind == "ordinary" and receipt.replacesAction ~= nil)
			then error("persisted finalization receipt is malformed") end
			local payload: any = { creatorSessionId = receipt.creatorSessionId, changeSetId = receipt.changeSetId, changeSetHash = receipt.changeSetHash, projectionId = receipt.projectionId, projectionHash = receipt.projectionHash, manifestHash = receipt.manifestHash, beforeProjectIndexManifestId = receipt.beforeProjectIndexManifestId, beforeProjectRevisionHash = receipt.beforeProjectRevisionHash, beforeProjectDetectorEpoch = receipt.beforeProjectDetectorEpoch, recordingId = receipt.recordingId, action = receipt.action, finalizationKind = receipt.finalizationKind, status = receipt.status, expectedCurrentProjectIndexManifestId = receipt.expectedCurrentProjectIndexManifestId, expectedCurrentProjectRevisionHash = receipt.expectedCurrentProjectRevisionHash, expectedCurrentProjectDetectorEpoch = receipt.expectedCurrentProjectDetectorEpoch, afterProjectIndexManifestId = receipt.afterProjectIndexManifestId, afterProjectRevisionHash = receipt.afterProjectRevisionHash, afterProjectDetectorEpoch = receipt.afterProjectDetectorEpoch }
			if receipt.finalizationKind == "recovery_cancel" then payload.replacesAction = receipt.replacesAction end
			return payload
		end

	local runtimeCapabilities = RuntimeCapabilityExecutor.new(plugin, function(kind, payload, requestId, suppliedMessageId)
		if StudioSemanticTransport.isStreamedType(kind) then
			local sent, failure, status = sendSemantic(kind, payload, requestId, suppliedMessageId)
			if sent then return true end
			if typeof(status) == "number" and status >= 400 and status < 500 then pluginError("STUDIO_FAILURE", failure, false, requestId); return nil end
			return false
		end
		local message = messageFor(kind, payload, requestId, suppliedMessageId or messageId("runtime"))
		local item = { message = message, requestId = requestId }
		local sent, failure, status = postMessage(message)
		if sent then return true end
		if typeof(status) == "number" and status >= 400 and status < 500 then pluginError("STUDIO_FAILURE", failure, false, requestId); return nil end
		retainPending(item); return false
	end, state)

	local function startArmedRuntime()
		if not runtimeCapabilities.active or runtimeCapabilities.active.phase ~= "armed" then state("NOT READY", "No exact runtime evidence projection is armed."); return end
		if connectorView then connectorView.setTestReady(false) end
		if not currentProjectRevision or runtimeCapabilities.active.plan.binding.projectRevisionHash ~= currentProjectRevision then
			local requestId = runtimeCapabilities.active and runtimeCapabilities.active.requestId or nil
			runtimeCapabilities:abort(); pluginError("STALE_EVIDENCE", "runtime plan revision does not match the current project index", false, requestId); return
		end
		local requestId = runtimeCapabilities.active and runtimeCapabilities.active.requestId or nil
		local started, startFailure = pcall(function() runtimeCapabilities:start() end)
		if not started then pluginError("STUDIO_FAILURE", startFailure, false, requestId) end
	end

	local function unpair(notifyBridge: boolean?, reason: string?, disableAutoConnect: boolean?)
		if disableAutoConnect then autoConnectEnabled = false end
		runtimeCapabilities:abort()
		local needsRecovery = projectIdentity:hasPossibleRecording() or authoring:hasPossibleRecording()
		if projectIdentity:hasPossibleRecording() then
			state("RECOVERY REQUIRED", "A Forge project-identity recording may still be open. Re-pair to inspect it; Forge will not change Studio automatically.")
		elseif authoring:hasPossibleRecording() then
			state("RECOVERY REQUIRED", "A Forge creator recording may still be open. Re-pair to inspect it; Forge will not change Studio automatically.")
		end
		if connectorView then connectorView.setTestReady(false) end
		if notifyBridge and sessionId and sessionToken then send("UnpairProject", { reason = reason or "user" }) end
		sessionId, projectId, sessionToken, pairedProject, currentProjectRevision, currentProjectIndexManifestId, currentProjectIndexCapture, currentProjectIndexDetectorEpoch, projectIndexProjection = nil, nil, nil, nil, nil, nil, nil, nil, nil
		projectIdentity:setChangeMonitor(nil)
		if projectChangeMonitor then projectChangeMonitor:destroy(cooperativeBudget()); projectChangeMonitor = nil end
		if stopRegistry then stopRegistry(); stopRegistry = nil end
		table.clear(pending)
		if needsRecovery then
			state("RECOVERY REQUIRED", "A Forge recording may still be open. Reconnect and review recovery in the dashboard.")
		else
			state(autoConnectEnabled and "CONNECTING" or "DISCONNECTED", autoConnectEnabled and "Waiting for the local Forge bridge." or "Automatic connection is paused.")
		end
	end
	local function recoveryPayload(recording: any, recordingState: string, recoveryCapture: any?, finalizationRequestId: string?): any
		if not recording then
			local empty: any = { recordingState = "none" }
			if finalizationRequestId then empty.finalizationRequestId = finalizationRequestId end
			return empty
		end
		local retainedRecovery = recording.recovery
		local recoveryManifestId = recoveryCapture and recoveryCapture.indexManifest.id or (retainedRecovery and retainedRecovery.projectIndexManifestId)
		local recoveryRevisionHash = recoveryCapture and recoveryCapture.revision.hash or (retainedRecovery and retainedRecovery.projectRevisionHash)
		local recoveryDetectorEpoch = recoveryCapture and recoveryCapture.detectorEpoch or (retainedRecovery and retainedRecovery.projectDetectorEpoch)
		if typeof(recoveryManifestId) ~= "string" or typeof(recoveryRevisionHash) ~= "string" or typeof(recoveryDetectorEpoch) ~= "number" then error("RECOVERY_REQUIRED: persisted recording has no exact recovery index binding") end
		local payload: any = {
			creatorSessionId = recording.creatorSessionId,
			changeSetId = recording.changeSetId,
			changeSetHash = recording.changeSetHash,
			projectionId = recording.projectionId,
			projectionHash = recording.projectionHash,
			manifestHash = recording.manifestHash,
				beforeProjectIndexManifestId = recording.beforeProjectIndexManifestId,
				beforeProjectRevisionHash = recording.beforeProjectRevisionHash,
				beforeProjectDetectorEpoch = recording.beforeProjectDetectorEpoch,
			recordingId = recording.recordingId,
			recordingState = recordingState,
			recoveryProjectIndexManifestId = recoveryManifestId,
			recoveryProjectRevisionHash = recoveryRevisionHash,
				recoveryProjectDetectorEpoch = recoveryDetectorEpoch,
			}
			-- A recovery cancellation is permitted only for the first, ordinary
			-- finalization intent. An uncertain recovery-cancel intent has already
			-- consumed its one explicit cancellation authority: exposing its retained
			-- provenance would make the host offer a command that Authoring must
			-- reject rather than safely retrying FinishRecording.
			if recording.phase == "finalization_intent"
				and typeof(recording.finalization) == "table"
				and recording.finalization.finalizationKind == "ordinary"
				and recording.finalization.recovery ~= true
			then
				local replacesAction = recording.finalization.action
				if replacesAction ~= "commit" and replacesAction ~= "cancel" then error("RECOVERY_REQUIRED: finalization intent has no replacement-action provenance") end
				payload.replacesAction = replacesAction
			end
			if finalizationRequestId then payload.finalizationRequestId = finalizationRequestId end
		return payload
	end

	local function pairAutomatically(): boolean
		if pairing or sessionId or not autoConnectEnabled then return false end
		if not substrateAvailable() then state("UNSUPPORTED STUDIO", "Forge requires SHA-256."); return false end
		pairing = true; state("CONNECTING", "Discovering the local Forge bridge.")
		local discovered, discovery = request("GET", "/pairing")
		if not discovered or typeof(discovery) ~= "table" or typeof(discovery.pairing) ~= "table" or typeof(discovery.pairing.token) ~= "string" then pairing = false; state("WAITING FOR BRIDGE", "Start `forge studio bridge`; Forge will connect automatically."); return false end
		local identityOk, identityOrFailure, inventory = pcall(function()
			return projectIdentity:observe(), projectIdentity:inventory()
		end)
		if not identityOk then pairing = false; autoConnectEnabled = false; state("RECOVERY REQUIRED", "Project identity state is invalid: " .. tostring(identityOrFailure)); return false end
		local pairIdentity = identityOrFailure
		local pairProject = collector:identity()
		local ok, response, status = request("POST", "/message", { kind = "StudioProtocolMessage", direction = "plugin_to_backend", type = "PairProject", messageId = messageId("pair"), sentAt = iso(), payload = { pairingToken = discovery.pairing.token, project = pairProject, projectIdentity = pairIdentity, projectIdentityTransaction = inventory, capabilities = capabilities(), connectorBuildHash = connectorBuildHash(), manifestHash = Generated.manifestHash } })
		pairing = false
		if not ok then
			if typeof(status) == "number" and status >= 400 and status < 500 then autoConnectEnabled = false end
			state(status == 0 and "WAITING FOR BRIDGE" or "CONNECTION REJECTED", tostring(response)); return false
		end
		if typeof(response) ~= "table" or typeof(response.sessionId) ~= "string" or typeof(response.projectId) ~= "string" or typeof(response.conversationProjectId) ~= "string" or typeof(response.sessionToken) ~= "string" or typeof(response.projectIdentity) ~= "table" or response.projectIdentity.hash ~= pairIdentity.hash or response.manifestHash ~= Generated.manifestHash or response.connectorBuildHash ~= connectorBuildHash() then state("CONNECTION REJECTED", "Bridge build, manifest, or project identity does not match the current plugin."); return false end
		local authorityOk, pairAuthority = pcall(function()
			return StudioProjectAuthority.derive({
				sessionId = response.sessionId,
				connectorBuildHash = connectorBuildHash(),
				identity = pairIdentity,
			})
		end)
		if not authorityOk or response.projectId ~= pairAuthority.projectId or response.conversationProjectId ~= pairAuthority.conversationProjectId then
			state("CONNECTION REJECTED", "Bridge project authority does not match the exact Studio identity."); return false
		end
		sessionId, projectId, sessionToken, pairedProject = response.sessionId, pairAuthority.projectId, response.sessionToken, pairProject
		local accepted, setup = pcall(function()
			local attestation = decodeProjection(response.capabilityAttestationProjectionJson, response.capabilityAttestationProjectionJsonHash, response.capabilityAttestationProjectionHash)
			local expectedProject = collector:identity()
			local expectedPairingHash = Hash.sha256(discovery.pairing.token)
			local function assertPairingProjection(projection: any, purpose: string)
				if projection.purpose ~= purpose or projection.project.name ~= expectedProject.name or projection.project.placeId ~= expectedProject.placeId or projection.project.universeId ~= expectedProject.universeId or typeof(projection.binding) ~= "table" or projection.binding.sessionId ~= sessionId or projection.binding.projectId ~= projectId or projection.binding.buildHash ~= connectorBuildHash() or projection.binding.pairingHash ~= expectedPairingHash then error("pairing projection binding mismatch") end
			end
			assertPairingProjection(attestation, "capability_attestation")
			-- This epoch scopes opaque read identities to exactly this connector
			-- pairing. Re-pairing can never turn a stale opaque digest into a
			-- write-capable object reference.
			registry:setConnectorEpoch(pairAuthority.connectorEpoch)
			local cooperate = cooperativeBudget()
			stopRegistry = registry:start(cooperate)
			projectChangeMonitor = StudioProjectChangeMonitor.new(function(notice: any)
				queueProjectChangeNotice(notice)
			end)
			projectChangeMonitor:start(cooperate)
			if not projectChangeMonitor:isUsable() then error("project change monitor bootstrap is incomplete") end
			authoring:setRecordingFinishObserver(function(recordingId: string, expected: boolean)
				if projectChangeMonitor == nil then return end
				if expected then projectChangeMonitor:expectExactForgeRecordingFinish(recordingId)
				else projectChangeMonitor:clearExpectedForgeRecordingFinish(recordingId) end
			end)
			projectIdentity:setChangeMonitor(projectChangeMonitor)
			local sent, failure = sendEvidence("capability_attestation", attestation)
			if not sent then error(failure) end
			-- A finalization receipt proves that its named recording was settled,
			-- but it is still a separate durable transaction obligation. Re-emitting
			-- it after reconnect is evidence delivery only: it never repeats a
			-- commit, cancel, Apply, or other Studio mutation.
			local receipt = authoring:finalizationReceipt()
			if receipt then
				sendRequired("CreatorChangeFinalized", finalizationPayload(receipt))
			end
			local identityReceipt = projectIdentity:finalizationReceipt()
			if identityReceipt then
				sendRequired("StudioProjectIdentityFinalized", { requestId = identityReceipt.operation.id, receipt = identityReceipt }, identityReceipt.operation.id)
			end
			-- A retained finalization receipt and an active-recording cursor are
			-- separate transaction phases.  The receipt must be acknowledged first;
			-- a later correlated inventory report proves what remains after the
			-- receipt was actually consumed.  Never let an unrelated `none` report
			-- clear that pending obligation.
			local recovery = authoring:recovery()
			if receipt then
				-- CreatorChangeFinalized above is the complete pairing inventory for
				-- now.  Its acknowledgement triggers a fresh recording scan.
			elseif recovery.recording then
				recoveryProjectIndexProjection(recovery.recording)
				local recoveryCapture = publishProjectIndex("recording recovery", nil)
				if recovery.recording.manifestHash == Generated.manifestHash and recovery.recording.phase == "finalization_finished" and typeof(recovery.recording.finalization) == "table" then
					local finalReceipt = authoring:recordFinalizationEvidence(recovery.recording, recoveryCapture)
					sendRequired("CreatorChangeFinalized", finalizationPayload(finalReceipt))
				else
					authoring:recordRecoveryEvidence(recoveryCapture.indexManifest.id, recoveryCapture.revision.hash, recoveryCapture.detectorEpoch)
					sendRequired("CreatorRecordingRecovery", recoveryPayload(recovery.recording, recovery.recordingState, recoveryCapture))
				end
			else
				sendRequired("CreatorRecordingRecovery", recoveryPayload(nil, "none"))
			end
		end)
		if not accepted then unpair(false, "session_replaced", true); state("CONNECTION REJECTED", tostring(setup)); return false end
		if projectIdentity:hasPossibleRecording() or authoring:hasPossibleRecording() then
			state("RECOVERY REQUIRED", "Connected. A Forge recording may still be open; review recovery in the dashboard.")
		else
			state("CONNECTED", "Manifest attestation sent. Forge will request a complete project index before any creator work.")
		end
		return true
	end

	local function recordingBinding(active: any): any
		return { creatorSessionId = active.binding.creatorSessionId, changeSetId = active.binding.changeSetId, changeSetHash = active.binding.changeSetHash, projectionId = active.binding.projectionId, projectionHash = active.binding.projectionHash, manifestHash = active.binding.manifestHash, beforeProjectIndexManifestId = active.binding.beforeProjectIndexManifestId, beforeProjectRevisionHash = active.binding.beforeProjectRevisionHash, beforeProjectDetectorEpoch = active.binding.beforeProjectDetectorEpoch, recordingId = active.binding.recordingId }
	end
	local function boundedMutationFailureDetail(value: any): string
		local text = tostring(value)
		if text == "" then text = "Studio mutation command failed" end
		local last = math.min(#text, 4096)
		while last > 0 do
			local candidate = string.sub(text, 1, last)
			local valid, length = pcall(function() return utf8.len(candidate) end)
			if valid and length ~= nil then return candidate end
			last -= 1
		end
		return "Studio mutation command failed"
	end
	local function mutationFailed(active: any?, stage: string, failureCode: string, requestId: string?, cancellationProven: boolean?, failureDetail: any?)
		local binding = active and active.binding or nil
		local failed = authoring:failure()
		if not binding and failed then binding = failed.binding; cancellationProven = failed.cancellationProven end
		if binding then
			-- A failed intent write is known to precede TryBeginRecording. Do not
			-- consult the rejected setting again merely to report that boundary: it
			-- may be unreadable for the same reason the write failed. An opening
			-- placeholder is durable recovery state only, never a protocol recording
			-- id. Post-attempt receipts need the exact id returned by Studio.
			local recordingAttempted = failed == nil or failed.recordingAttempted ~= false
			local recordingState
			if not recordingAttempted then recordingState = "not_open"
			elseif failed and typeof(failed.recordingState) == "string" then recordingState = failed.recordingState
			else recordingState = authoring:recovery().recordingState end
			local recordingId = if failed and typeof(failed.recordingId) == "string" and failed.recordingId ~= "" then failed.recordingId else nil
			if recordingId == nil and typeof(binding.recordingId) == "string" and binding.recordingId ~= "" and string.sub(binding.recordingId, 1, #"pending_recording_") ~= "pending_recording_" then
				recordingId = binding.recordingId
			end
			-- A failed TryBeginRecording can leave Studio's state indeterminate while
			-- returning no exact id. It has no protocol-valid mutation receipt: the
			-- command settlement and recovery scan retain its exact diagnostic rather
			-- than fabricating an identity for a possibly-open recording.
			if recordingAttempted and recordingId == nil then return false end
			local exactDetail = boundedMutationFailureDetail(failureDetail or (failed and failed.failureDetail) or failureCode)
			local payload: any = { creatorSessionId = binding.creatorSessionId, changeSetId = binding.changeSetId, changeSetHash = binding.changeSetHash, projectionId = binding.projectionId, projectionHash = binding.projectionHash, preflightProjectionId = binding.preflightProjectionId, preflightProjectionHash = binding.preflightProjectionHash, manifestHash = binding.manifestHash, beforeProjectIndexManifestId = binding.beforeProjectIndexManifestId, beforeProjectRevisionHash = binding.beforeProjectRevisionHash, beforeProjectDetectorEpoch = binding.beforeProjectDetectorEpoch, stage = stage, failureCode = failureCode, failureDetail = exactDetail, failureDetailHash = Hash.sha256(exactDetail), recordingState = recordingState }
			if recordingId ~= nil then payload.recordingId = recordingId end
			-- A cancellation claim requires a named recording and a direct closed
			-- state observation. Do not turn a failed/indeterminate close into a
			-- semantic cancellation acknowledgement.
			if cancellationProven == true and (recordingId == nil or recordingState ~= "not_open") then cancellationProven = false end
			if cancellationProven ~= nil then payload.cancellationProven = cancellationProven end
			sendRequired("CreatorMutationFailed", payload, requestId)
			return true
		end
		return false
	end
	local function mutationFailedFromPrepared(stage: string, failureCode: string, requestId: string?, failureDetail: any?): boolean
		local prepared = authoring.prepared
		if typeof(prepared) ~= "table" or typeof(prepared.changeSet) ~= "table" or typeof(prepared.projection) ~= "table" then return false end
		local exactDetail = boundedMutationFailureDetail(failureDetail or failureCode)
		sendRequired("CreatorMutationFailed", {
			creatorSessionId = prepared.changeSet.sessionId,
			changeSetId = prepared.changeSet.id,
			changeSetHash = prepared.changeSet.hash,
			projectionId = prepared.projection.id,
			projectionHash = prepared.projection.contentHash,
			preflightProjectionId = prepared.preflightProjection.id,
			preflightProjectionHash = prepared.preflightProjection.contentHash,
			manifestHash = Generated.manifestHash,
			beforeProjectIndexManifestId = prepared.beforeProjectIndexManifestId,
			beforeProjectRevisionHash = prepared.beforeProjectRevisionHash,
			beforeProjectDetectorEpoch = prepared.beforeProjectDetectorEpoch,
			stage = stage,
			failureCode = failureCode,
			failureDetail = exactDetail,
			failureDetailHash = Hash.sha256(exactDetail),
			-- Detached preflight never calls TryBeginRecording. Its failure receipt
			-- is independent of unrelated recovery inventory and must be the one
			-- protocol-valid no-recording state.
			recordingState = "not_open",
		}, requestId)
		return true
	end
	local function cancelAfterEvidenceFailure(active: any, stage: string, failureCode: string, requestId: string?, expectedCurrent: any?, failureDetail: any?)
		-- An automatic evidence-failure cancellation is safe only while the
		-- last complete authority is still the monitor's exact current binding.
		-- When provisional cursor persistence failed after a complete post-Apply
		-- capture, preserve that post-Apply triplet in the durable cancellation
		-- intent; otherwise its existing provisional or pre-Apply triplet is the
		-- only legal gate. An unattributed notification rejects before Finish.
		local gatePassed, gateFailure = pcall(function()
			if expectedCurrent ~= nil then
				requireExpectedCurrentProjectIndex("creator provisional-evidence cancellation", expectedCurrent.projectIndexManifestId, expectedCurrent.projectRevisionHash, expectedCurrent.projectDetectorEpoch)
			else
				requireCurrentProjectIndex("creator provisional-evidence cancellation")
			end
		end)
		if not gatePassed then
			-- The recording may be open, so the safe action is no action. Emit the
			-- exact transaction binding before rejecting the command; otherwise the
			-- host would retain only a generic plugin error and could not present or
			-- replay the recovery boundary.
			if projectChangeMonitor then projectChangeMonitor:clearExactForgeMutationFacts() end
			local exactFailure = "automatic cancellation was not attempted because current project authority could not be proven: " .. boundedMutationFailureDetail(gateFailure)
			mutationFailed(active, stage, failureCode, requestId, false, exactFailure)
			error("RECOVERY_REQUIRED: " .. exactFailure)
		end
		-- Cancellation restores the exact pre-Apply state. Switch the monitor to
		-- the already registered before-matchers before ChangeHistory can emit an
		-- undo notification; this is not a timed suppression window.
		if projectChangeMonitor then projectChangeMonitor:setExactForgeMutationPhase("before") end
		local cancelled, bindingOrFailure = pcall(function()
			return authoring:cancelActiveForEvidenceFailure(active, failureCode, function(intent: any)
				requireDurableFinalizationGate(intent, "creator provisional-evidence cancellation")
			end, expectedCurrent)
		end)
		if not cancelled then
			if projectChangeMonitor then projectChangeMonitor:clearExactForgeMutationFacts() end
			mutationFailed(active, stage, failureCode, requestId, false, bindingOrFailure)
			error(bindingOrFailure)
		end
		local captured, postOrFailure = pcall(function() return publishProjectIndex("creator provisional-evidence cancellation", requestId, nil, "transaction_evidence") end)
		if not captured or typeof(postOrFailure.indexManifest) ~= "table" or typeof(postOrFailure.revision) ~= "table" then
			clearFinalizationMonitorState(bindingOrFailure and bindingOrFailure.recordingId)
			mutationFailed({ binding = bindingOrFailure }, stage, failureCode, requestId, false, captured and "post-cancel project index was incomplete" or postOrFailure)
			error(captured and "post-cancel project index was incomplete" or postOrFailure)
		end
		local retained, receiptOrFailure = pcall(function() return authoring:recordFinalizationEvidence(bindingOrFailure, postOrFailure) end)
		if not retained then
			clearFinalizationMonitorState(bindingOrFailure and bindingOrFailure.recordingId)
			mutationFailed({ binding = bindingOrFailure }, stage, failureCode, requestId, false, receiptOrFailure)
			error(receiptOrFailure)
		end
		mutationFailed({ binding = bindingOrFailure }, stage, failureCode, requestId, true, failureDetail)
		sendRequired("CreatorChangeFinalized", finalizationPayload(receiptOrFailure), requestId)
		if projectChangeMonitor then projectChangeMonitor:clearExactForgeMutationFacts() end
	end
	-- Edit and Play Server are separate plugin data models.  Returning from
	-- ordinary Play therefore loses the in-memory authoring handle even though
	-- its exact ChangeHistory cursor remains in Plugin settings.  Rebuild only
	-- the minimal in-memory handle needed for an already-authorized
	-- FinalizeCreatorChangeSet command, after directly proving that the exact
	-- cursor is still open.  This performs no Studio operation itself.
	local function restoreOpenAuthoringForFinalization(payload: any)
		if authoring.active then return end
		if not RuntimeCapabilityExecutor.hasFinalizedPassiveForCreatorSession(plugin, payload.creatorSessionId) then error("RECOVERY_REQUIRED: creator finalization requires an exact finalized passive Play receipt") end
		local recovery = authoring:recovery()
		local stored = recovery.recording
		if recovery.recordingState ~= "open" or typeof(stored) ~= "table" then error("RECOVERY_REQUIRED: exact creator recording is not proven open after Play") end
			if stored.phase ~= "open" or stored.manifestHash ~= Generated.manifestHash or stored.creatorSessionId ~= payload.creatorSessionId or stored.changeSetId ~= payload.changeSetId or stored.changeSetHash ~= payload.changeSetHash or stored.projectionId ~= payload.projectionId or stored.projectionHash ~= payload.projectionHash or stored.recordingId ~= payload.recordingId or stored.beforeProjectIndexManifestId ~= payload.beforeProjectIndexManifestId or stored.beforeProjectRevisionHash ~= payload.beforeProjectRevisionHash or stored.beforeProjectDetectorEpoch ~= payload.beforeProjectDetectorEpoch then error("RECOVERY_REQUIRED: persisted creator recording does not bind the requested finalization") end
		authoring.active = {
			recording = stored.recordingId,
			binding = stored,
		}
	end
	local creatorRecordingCommands = {
		CreatorSourceWriteBlobStarted = true,
		CreatorSourceWriteBlobChunk = true,
		CreatorSourceWriteBlobCompleted = true,
		CreatorChangePrepareStarted = true,
		CreatorChangePrepareChunk = true,
		CreatorChangePrepareCompleted = true,
		PreflightCreatorChangeSet = true,
		ApplyCreatorChangeSet = true,
		FinalizeCreatorChangeSet = true,
		RequestCreatorRecordingRecovery = true,
		CancelInterruptedRecording = true,
		RollbackCreatorCheckpoint = true,
		ExecuteRuntimeEvalPlan = true,
	}
	local function adoptProjectIdentity(identity: any)
		if not sessionId then error("project identity finalization requires an active Studio session") end
		if not projectId then error("project identity finalization requires a paired project authority") end
		local authority = StudioProjectAuthority.adopt({
			currentProjectId = projectId,
			sessionId = sessionId,
			connectorBuildHash = connectorBuildHash(),
			identity = identity,
		})
		local nextProjectId = authority.projectId
		local projectChanged = pairedProject == nil
			or pairedProject.name ~= identity.project.name
			or pairedProject.placeId ~= identity.project.placeId
			or pairedProject.universeId ~= identity.project.universeId
		local authorityChanged = authority.authorityChanged
		projectId = nextProjectId
		pairedProject = identity.project
		if authorityChanged then registry:setConnectorEpoch(authority.connectorEpoch) end
		-- Every complete index and opaque object handle was scoped to the prior
		-- authority or exact project metadata. Linking, forking, Save As, and
		-- publication invalidate it outright; the host must request a fresh index.
		if authorityChanged or projectChanged then
			currentProjectRevision = nil
			currentProjectIndexManifestId = nil
			currentProjectIndexCapture = nil
			currentProjectIndexDetectorEpoch = nil
			projectIndexProjection = nil
			currentCreatorSessionId = nil
		end
	end
	local function adoptFinalizedProjectIdentity(receipt: any)
		if receipt.status ~= "linked" and receipt.status ~= "forked" then return end
		adoptProjectIdentity(receipt.afterIdentity)
	end
	local function handle(message: any)
		if typeof(message) ~= "table" or message.kind ~= "StudioProtocolMessage" or message.direction ~= "backend_to_plugin" or typeof(message.payload) ~= "table" or message.sessionId ~= sessionId then error("malformed backend message") end
		if creatorRecordingCommands[message.type] and projectIdentity:hasPossibleRecording() then
			error("RECOVERY_REQUIRED: a project identity recording may still be active")
		end
		local activity = ConnectorPresentation.command(message.type)
		if activity then state(activity.started, "Studio command: " .. message.type) end
		if message.type == "LinkStudioProject" or message.type == "ForkStudioProject" then
			if message.payload.operationHash ~= message.payload.operation.hash
				or message.payload.operation.action ~= (if message.type == "LinkStudioProject" then "link" else "fork")
			then error("project identity command binding mismatch") end
			if projectChangeMonitor == nil or not projectChangeMonitor:isUsable() then error("project identity mutation requires complete project-change monitoring") end
			local receipt = projectIdentity:execute(message.payload.operation, registry.connectorEpoch, function()
				return authoring:recovery().recording == nil
			end)
			adoptFinalizedProjectIdentity(receipt)
			sendRequired("StudioProjectIdentityFinalized", { requestId = message.payload.requestId, receipt = receipt }, message.requestId)
		elseif message.type == "CancelInterruptedStudioProjectIdentity" then
			if projectChangeMonitor == nil or not projectChangeMonitor:isUsable() then error("project identity recovery requires complete project-change monitoring") end
			local receipt = projectIdentity:cancelInterrupted(message.payload, function()
				return authoring:recovery().recording == nil
			end)
			sendRequired("StudioProjectIdentityFinalized", { requestId = message.payload.requestId, receipt = receipt }, message.requestId)
		elseif message.type == "AbandonOpeningStudioProjectIdentity" then
			local receipt = projectIdentity:abandonOpening(message.payload, function()
				return authoring:recovery().recording == nil
			end)
			sendRequired("StudioProjectIdentityFinalized", { requestId = message.payload.requestId, receipt = receipt }, message.requestId)
		elseif message.type == "SettleClosedStudioProjectIdentity" then
			local receipt = projectIdentity:settleClosed(message.payload, function()
				return authoring:recovery().recording == nil
			end)
			adoptFinalizedProjectIdentity(receipt)
			sendRequired("StudioProjectIdentityFinalized", { requestId = message.payload.requestId, receipt = receipt }, message.requestId)
		elseif message.type == "AcknowledgeStudioProjectIdentityFinalization" then
			projectIdentity:acknowledge(message.payload)
		elseif message.type == "FinalizePassiveRuntimeEval" then
			local finalizationMessageId = RuntimeCapabilityExecutor.passiveFinalizationMessageId(plugin)
			local acknowledged = runtimeCapabilities:finalizePassive(message.payload)
			local sent, failure = send("PassiveRuntimeEvalFinalized", acknowledged, message.requestId, finalizationMessageId)
			if not sent then error("passive runtime finalization acknowledgement transport failed: " .. tostring(failure)) end
			state("PLAY RECEIPT ACKNOWLEDGED", "Forge retained an inert replayable acknowledgement until the creator transaction is durably finalized.")
		elseif message.type == "CollectStudioProjectIndex" then
			projectIndexProjection = message.payload.projection
			publishProjectIndex("requested project index", message.requestId)
		elseif message.type == "CreatorSourceWriteBlobStarted" then
			authoring:beginSourceWrite(message.payload)
		elseif message.type == "CreatorSourceWriteBlobChunk" then
			authoring:appendSourceWriteChunk(message.payload)
		elseif message.type == "CreatorSourceWriteBlobCompleted" then
			local accepted = authoring:completeSourceWrite(message.payload)
			sendRequired("CreatorSourceWriteBlobAccepted", accepted, message.requestId)
		elseif message.type == "RequestStudioEvidence" then
			local projection = decodeProjection(message.payload.projectionJson, message.payload.projectionJsonHash, message.payload.projectionHash)
			local sent, failure = sendEvidence(message.payload.reason, projection, message.requestId)
			if not sent then error(failure) end
		elseif message.type == "ExecuteRuntimeEvalPlan" then
			if not currentProjectRevision or message.payload.expectedProjectRevisionHash ~= currentProjectRevision then error("runtime execution requires current project-index revision") end
			if not sessionId or not projectId then error("runtime execution requires pairing") end
			if message.payload.startPolicy == "observe_next_creator_play" and not currentCreatorSessionId then error("creator runtime execution has no exact creator-session binding") end
			runtimeCapabilities:arm(message.payload, message.requestId, { sessionId = sessionId, projectId = projectId, sessionToken = sessionToken, bridgeUrl = bridgeUrl, projectRevisionHash = currentProjectRevision, project = collector:identity(), creatorSessionId = currentCreatorSessionId })
			if connectorView then connectorView.setTestReady(message.payload.startPolicy ~= "observe_next_creator_play") end
		elseif message.type == "CreatorChangePrepareStarted" then
			authoring:beginPrepareTransfer(message.payload)
		elseif message.type == "CreatorChangePrepareChunk" then
			authoring:appendPrepareTransferChunk(message.payload)
		elseif message.type == "CreatorChangePrepareCompleted" then
			local beforeCapture = requireCurrentProjectIndex("creator prepare")
			local prepared = authoring:completePrepareTransfer(message.payload, beforeCapture)
			currentCreatorSessionId = prepared.creatorSessionId
			sendRequired("CreatorChangePrepared", prepared, message.requestId)
		elseif message.type == "PreflightCreatorChangeSet" then
			local prepared = authoring.prepared
			if not prepared then error("creator preflight has no exact prepared project index") end
			local beforeCapture = requireCurrentProjectIndex("creator preflight")
				if message.payload.expectedProjectRevisionHash ~= beforeCapture.revision.hash
					or message.payload.beforeProjectIndexManifestId ~= beforeCapture.indexManifest.id
					or message.payload.beforeProjectDetectorEpoch ~= beforeCapture.detectorEpoch
					or prepared.beforeProjectIndexManifestId ~= beforeCapture.indexManifest.id
					or prepared.beforeProjectRevisionHash ~= beforeCapture.revision.hash
					or prepared.beforeProjectDetectorEpoch ~= beforeCapture.detectorEpoch
				then error("creator preflight project revision or detector epoch is stale") end
				local envelope = authoring:preflight(message.payload)
				local preflightResult: any = { creatorSessionId = prepared.changeSet.sessionId, changeSetId = prepared.changeSet.id, changeSetHash = prepared.changeSet.hash, projectionId = prepared.projection.id, projectionHash = prepared.projection.contentHash, preflightProjectionId = prepared.preflightProjection.id, preflightProjectionHash = prepared.preflightProjection.contentHash, manifestHash = Generated.manifestHash, beforeProjectIndexManifestId = beforeCapture.indexManifest.id, beforeProjectRevisionHash = beforeCapture.revision.hash, beforeProjectDetectorEpoch = beforeCapture.detectorEpoch, preflightEvidence = envelope, status = envelope.completion == "complete" and "passed" or "incomplete" }
			if envelope.completion ~= "complete" then preflightResult.failureCode = "capability_preflight_failed" end
			sendRequired("CreatorChangePreflighted", preflightResult, message.requestId)
		elseif message.type == "ApplyCreatorChangeSet" then
			local prepared = authoring.prepared
			if not prepared then error("creator apply has no exact prepared project index") end
			local beforeCapture = requireCurrentProjectIndex("creator apply")
				if message.payload.expectedProjectRevisionHash ~= beforeCapture.revision.hash
					or message.payload.beforeProjectIndexManifestId ~= beforeCapture.indexManifest.id
					or message.payload.beforeProjectDetectorEpoch ~= beforeCapture.detectorEpoch
					or prepared.beforeProjectIndexManifestId ~= beforeCapture.indexManifest.id
					or prepared.beforeProjectRevisionHash ~= beforeCapture.revision.hash
					or prepared.beforeProjectDetectorEpoch ~= beforeCapture.detectorEpoch
				then error("creator apply project revision or detector epoch is stale") end
			if projectChangeMonitor then projectChangeMonitor:clearExactForgeMutationFacts() end
			local applied, activeOrFailure = pcall(function()
				return authoring:apply(message.payload, beforeCapture, function(fact: any)
					if projectChangeMonitor then projectChangeMonitor:expectExactForgeMutationFact(fact) end
				end, function(phase: string)
					if projectChangeMonitor then projectChangeMonitor:setExactForgeMutationPhase(phase) end
				end, function(intent: any)
					requireDurableFinalizationGate(intent, "creator failed-apply cancellation")
				end)
			end)
			if not applied then
				local failed = authoring:failure()
				local receipt = nil
				if failed and failed.cancellationProven then
					local postOk, post = pcall(function() return publishProjectIndex("creator failed-apply cancellation", message.requestId, nil, "transaction_evidence") end)
					if postOk then
						-- A locally proven same-call cancellation is still a transaction
						-- finalization.  Persist its complete state evidence before any
						-- transport attempt so a reconnect can replay the exact receipt.
						local persisted, saved = pcall(function()
							return authoring:recordFinalizationEvidence(failed.binding, post)
						end)
						if persisted then
							receipt = saved
						end
					end
				end
				-- An uncertain failure must not retain any future exact-state
				-- exemption. A proven same-call cancellation keeps the before-state
				-- facts only long enough to collect and persist post-cancel evidence.
				if projectChangeMonitor and (not failed or not failed.cancellationProven) then projectChangeMonitor:clearExactForgeMutationFacts() end
				local cancellationProven: boolean? = nil
				if failed ~= nil then cancellationProven = failed.cancellationProven end
				local applyFailureCode = failed and failed.failureCode or "mutation_apply_failed"
					mutationFailed(authoring.active, "apply", applyFailureCode, message.requestId, cancellationProven, activeOrFailure)
					if receipt then
					-- The failed batch and its cancellation are separate immutable
					-- phases.  Emit both: CreatorMutationFailed identifies the failed
					-- execution and CreatorChangeFinalized carries the complete
					-- post-cancel state/revision receipt for replay and acknowledgement.
						sendRequired("CreatorChangeFinalized", finalizationPayload(receipt), message.requestId)
					end
				if projectChangeMonitor then projectChangeMonitor:clearExactForgeMutationFacts() end
				error(activeOrFailure)
			end
			local active = activeOrFailure
			local readbackOk, direct = pcall(function() return collector:produce(active.prepared.projection, nil, cooperativeBudget()) end)
				if not readbackOk then cancelAfterEvidenceFailure(active, "readback", "mutation_readback_failed", message.requestId, nil, direct); return end
				local postOk, post = pcall(function() return publishProjectIndex("creator post-apply", message.requestId, nil, "transaction_evidence") end)
				if not postOk then cancelAfterEvidenceFailure(active, "post_state", "post_state_evidence_failed", message.requestId, nil, post); return end
				if typeof(post.indexManifest) ~= "table" or typeof(post.revision) ~= "table" then cancelAfterEvidenceFailure(active, "post_state", "post_state_evidence_incomplete", message.requestId, nil, "post-Apply project index was incomplete"); return end
				local retained, retentionFailure = pcall(function() authoring:recordProvisionalEvidence(active, direct, post) end)
				if not retained then
					cancelAfterEvidenceFailure(active, "post_state", "provisional_cursor_persistence_failed", message.requestId, {
						projectIndexManifestId = post.indexManifest.id,
						projectRevisionHash = post.revision.hash,
						projectDetectorEpoch = post.detectorEpoch,
						}, retentionFailure)
				return
			end
			local provisional = recordingBinding(active)
				provisional.directReadbackEvidence = direct
				provisional.postApplyProjectIndexManifestId = post.indexManifest.id
				provisional.postApplyProjectRevisionHash = post.revision.hash
				provisional.postApplyProjectDetectorEpoch = post.detectorEpoch
			provisional.status = "provisional"
			sendRequired("CreatorMutationProvisional", provisional, message.requestId)
			elseif message.type == "FinalizeCreatorChangeSet" then
				if message.payload.finalizationKind ~= "ordinary" then error("RECOVERY_REQUIRED: normal finalization has an invalid kind") end
				restoreOpenAuthoringForFinalization(message.payload)
				local active = authoring.active
				if not active then error("RECOVERY_REQUIRED: finalization has no active recording") end
				requireFinalizationGate(message.payload, active.binding, "creator finalization")
				if projectChangeMonitor and message.payload.action == "cancel" then projectChangeMonitor:setExactForgeMutationPhase("before") end
					local finalized, result = pcall(function()
						return authoring:finalize(message.payload, function(intent: any)
							requireFinalizationGate(message.payload, intent, "creator finalization")
						end)
					end)
				if not finalized then
					clearFinalizationMonitorState(active.recording)
					mutationFailed(active, message.payload.action == "commit" and "commit" or "cancel", "finalization_failed", message.requestId, nil, result); error(result)
				end
				local captured, postOrFailure = pcall(function()
					return publishProjectIndex(message.payload.action == "commit" and "post_commit" or "post_cancel", message.requestId, nil, "transaction_evidence")
				end)
				if not captured then
					clearFinalizationMonitorState(result.binding.recordingId)
					mutationFailed(result, message.payload.action == "commit" and "commit" or "cancel", "finalization_post_index_failed", message.requestId, nil, postOrFailure)
					error(postOrFailure)
				end
				local retained, receiptOrFailure = pcall(function()
					return authoring:recordFinalizationEvidence(result.binding, postOrFailure)
				end)
				if not retained then
					clearFinalizationMonitorState(result.binding.recordingId)
					mutationFailed(result, message.payload.action == "commit" and "commit" or "cancel", "finalization_receipt_failed", message.requestId, nil, receiptOrFailure)
					error(receiptOrFailure)
				end
				local receipt = receiptOrFailure
				sendRequired("CreatorChangeFinalized", finalizationPayload(receipt), message.requestId)
				if projectChangeMonitor then projectChangeMonitor:clearExactForgeMutationFacts() end
		elseif message.type == "RequestCreatorRecordingRecovery" then
			local recovery = authoring:recovery()
			if not recovery.recording then error("recording recovery has no exact persisted cursor") end
			recoveryProjectIndexProjection(recovery.recording)
			local expected = recoveryPayload(recovery.recording, recovery.recordingState, nil)
			for _, key in ipairs({ "creatorSessionId", "changeSetId", "changeSetHash", "projectionId", "projectionHash", "manifestHash", "beforeProjectIndexManifestId", "beforeProjectRevisionHash", "beforeProjectDetectorEpoch", "recordingId" }) do
				if message.payload[key] ~= expected[key] then error("recording recovery binding mismatch") end
			end
			local post = publishProjectIndex("recording_recovery", message.requestId)
			authoring:recordRecoveryEvidence(post.indexManifest.id, post.revision.hash, post.detectorEpoch)
			sendRequired("CreatorRecordingRecovery", recoveryPayload(recovery.recording, recovery.recordingState, post), message.requestId)
		elseif message.type == "AcknowledgeClosedCreatorRecording" then
			local cleared = authoring:acknowledgeClosedRecording(message.payload)
			local acknowledged = recoveryPayload(cleared, "not_open", nil)
				acknowledged.recordingState = nil
				acknowledged.recoveryProjectIndexManifestId = message.payload.recoveryProjectIndexManifestId
				acknowledged.recoveryProjectRevisionHash = message.payload.recoveryProjectRevisionHash
				acknowledged.recoveryProjectDetectorEpoch = message.payload.recoveryProjectDetectorEpoch
				acknowledged.status = "closed_cursor_cleared"
			sendRequired("CreatorClosedRecordingAcknowledged", acknowledged, message.requestId)
			-- The backend's exact closed-recording acknowledgement is the recovery
			-- equivalent of a creator transaction finalization acknowledgement.
			-- Only now may the same-session abandoned passive evidence be removed.
			if RuntimeCapabilityExecutor.discardPassiveForCreatorSession(plugin, cleared.creatorSessionId) then
				passiveResume = false
				autoConnectEnabled = true
				currentCreatorSessionId = nil
			end
			elseif message.type == "CancelInterruptedRecording" then
				if message.payload.finalizationKind ~= "recovery_cancel" then error("RECOVERY_REQUIRED: interrupted cancellation has an invalid kind") end
				local recovery = authoring:recovery()
				if not recovery.recording then error("RECOVERY_REQUIRED: interrupted cancellation has no durable recording cursor") end
				requireFinalizationGate(message.payload, recovery.recording, "interrupted creator recording cancellation", true)
					local stored = authoring:cancelInterrupted(message.payload, function(intent: any)
						requireFinalizationGate(message.payload, intent, "interrupted creator recording cancellation")
					end)
				recoveryProjectIndexProjection(stored)
				local captured, postOrFailure = pcall(function()
					return publishProjectIndex("post_cancel", message.requestId, nil, "transaction_evidence")
				end)
				if not captured then
					clearFinalizationMonitorState(stored.recordingId)
					mutationFailed({ binding = stored }, "cancel", "finalization_post_index_failed", message.requestId, nil, postOrFailure)
					error(postOrFailure)
				end
				local retained, receiptOrFailure = pcall(function()
					return authoring:recordFinalizationEvidence(stored, postOrFailure)
				end)
				if not retained then
					clearFinalizationMonitorState(stored.recordingId)
					mutationFailed({ binding = stored }, "cancel", "finalization_receipt_failed", message.requestId, nil, receiptOrFailure)
					error(receiptOrFailure)
				end
				local receipt = receiptOrFailure
				sendRequired("CreatorChangeFinalized", finalizationPayload(receipt), message.requestId)
			elseif message.type == "AcknowledgeCreatorChangeFinalization" then
				local receipt = authoring:acknowledgeFinalization(message.payload)
				-- The durable receipt has been consumed. Do not retain a missing or
				-- delayed OnRecordingFinished id as an exemption for later work.
				if projectChangeMonitor then projectChangeMonitor:clearExpectedForgeRecordingFinish(receipt.recordingId) end
			-- The server persisted the exact mutation attempt before issuing this
			-- acknowledgement.  This is the one authority that may garbage-collect
			-- a terminal passive receipt, for commits, cancellations, and recovered
			-- cancellations alike.
			if RuntimeCapabilityExecutor.discardPassiveForCreatorSession(plugin, receipt.creatorSessionId) then
				passiveResume = false
				autoConnectEnabled = true
				currentCreatorSessionId = nil
				state("CONNECTED", "Creator transaction and passive Play receipt are durably finalized.")
			end
			-- Confirm consumption with a fresh, acknowledgement-correlated scan.
			-- This is the only message that may release the backend's finalization
			-- gate for this Studio session.  A transient transport failure is queued;
			-- a reconnect will independently report the now-current inventory.
			local recovery = authoring:recovery()
			local inventoryPayload: any
			if recovery.recording then
				recoveryProjectIndexProjection(recovery.recording)
				local post = publishProjectIndex("post_finalization_acknowledgement_inventory", message.requestId)
				authoring:recordRecoveryEvidence(post.indexManifest.id, post.revision.hash, post.detectorEpoch)
				inventoryPayload = recoveryPayload(recovery.recording, recovery.recordingState, post, message.requestId)
			else
				inventoryPayload = recoveryPayload(nil, "none", nil, message.requestId)
			end
			local inventoryMessageId = messageId("finalization_inventory")
			local inventoryMessage = messageFor("CreatorRecordingRecovery", inventoryPayload, message.requestId, inventoryMessageId)
			local sent, failure, status = postMessage(inventoryMessage)
			if not sent then
				if typeof(status) == "number" and status >= 400 and status < 500 then error("finalization inventory acknowledgement rejected: " .. tostring(failure)) end
				retainPending({ message = inventoryMessage, requestId = message.requestId })
			end
		elseif message.type == "RollbackCreatorCheckpoint" then
			if not currentProjectRevision or message.payload.expectedProjectRevisionHash ~= currentProjectRevision then error("checkpoint rollback requires exact project revision") end
			local before = currentProjectRevision; authoring:rollback(message.payload, currentProjectRevision)
			local post = publishProjectIndex("post_rollback", message.requestId, nil, "transaction_evidence")
			sendRequired("CreatorCheckpointRolledBack", { creatorSessionId = message.payload.creatorSessionId, checkpointId = message.payload.checkpointId, changeSetId = message.payload.changeSetId, changeSetHash = message.payload.changeSetHash, beforeProjectRevisionHash = before, afterProjectIndexManifestId = post.indexManifest.id, afterProjectRevisionHash = post.revision.hash, afterProjectDetectorEpoch = post.detectorEpoch, status = "rolled_back" }, message.requestId)
		else error("unsupported backend command") end
		if activity and latestStatus == activity.started then state(activity.finished, "Studio command returned: " .. message.type .. ". Review its exact result in the dashboard.") end
	end

	local function classifyCommandFailure(message: any, failure: any): string
		local detail = tostring(failure)
		if string.sub(detail, 1, #"RECOVERY_REQUIRED:") == "RECOVERY_REQUIRED:" then return "RECOVERY_REQUIRED" end
		-- These are Forge envelope, binding, and authorization failures. They
		-- are intentionally distinct from Studio capability/runtime failures.
		if string.sub(detail, 1, #"malformed backend message") == "malformed backend message"
			or string.sub(detail, 1, #"malformed hash-bound command delivery") == "malformed hash-bound command delivery"
			or string.sub(detail, 1, #"malformed hash-bound command body") == "malformed hash-bound command body"
			or string.sub(detail, 1, #"hash-bound command body mismatch") == "hash-bound command body mismatch"
			or string.sub(detail, 1, #"unsupported backend command") == "unsupported backend command"
			or string.sub(detail, 1, #"backend command messageId conflicts") == "backend command messageId conflicts"
			or string.find(detail, "projection transport hash mismatch", 1, true)
			or string.find(detail, "projection JSON/content binding mismatch", 1, true)
			or string.find(detail, "binding mismatch", 1, true)
			or string.find(detail, "project revision stale", 1, true)
			or string.find(detail, "project revision or detector epoch is stale", 1, true)
			or string.find(detail, "requires exact project revision", 1, true)
			or string.find(detail, "has no exact prepared", 1, true)
			or string.find(detail, "has no complete pre-Apply project index", 1, true)
			or string.find(detail, "cannot trust the pre-Apply project index", 1, true)
			or string.find(detail, "current project-index binding is inconsistent", 1, true)
			or string.find(detail, "creator Prepare transfer", 1, true)
			or string.find(detail, "creator Prepare fragment", 1, true)
			or string.find(detail, "creator Prepare completion", 1, true)
			or string.find(detail, "creator Prepare document", 1, true)
			or string.find(detail, "runtime execution requires pairing", 1, true)
			or string.find(detail, "beforeProject", 1, true)
		then
			return "SECURITY_REJECTION"
		end
		-- Studio APIs, unsupported capabilities, collector failures, and command
		-- execution faults all land here. Never label those as security failures.
		return "STUDIO_FAILURE"
	end

	local function reportBoundMutationFailure(message: any, classification: string, failureDetail: any)
		if message.type == "PreflightCreatorChangeSet" then
			mutationFailedFromPrepared("preflight", classification == "SECURITY_REJECTION" and "preflight_binding_rejected" or "capability_preflight_failed", message.requestId, failureDetail)
		elseif message.type == "ApplyCreatorChangeSet" and authoring.active == nil and authoring:failure() == nil then
			-- authoring:apply emits its own fully-bound failure when it reaches a
			-- mutation. This covers only pre-apply binding/capability failures.
			mutationFailedFromPrepared("apply", classification == "SECURITY_REJECTION" and "apply_binding_rejected" or "mutation_apply_failed", message.requestId, failureDetail)
		end
	end

	local function commandSettlementId(commandMessageId: string, commandHash: string): string
		return "command_settlement_" .. string.sub(Hash.sha256(commandMessageId .. ":" .. commandHash), 1, 24)
	end
	local function boundedCommandDiagnostic(value: any): string
		local text = tostring(value)
		local last = math.min(#text, Constants.MAX_DIAGNOSTIC_CHARS)
		while last > 0 do
			local candidate = string.sub(text, 1, last)
			local valid, length = pcall(function() return utf8.len(candidate) end)
			if valid and length ~= nil then return candidate end
			last -= 1
		end
		return "Studio command rejected"
	end
	local function sendCommandSettlement(record: {commandHash: string, settlement: any, settlementMessageId: string}, requestId: string?)
		local sent, failure, status = send("StudioCommandSettled", record.settlement, requestId, record.settlementMessageId)
		if sent then return end
		if typeof(status) == "number" and status >= 400 and status < 500 then error("command settlement was rejected: " .. tostring(failure)) end
		-- The bridge still retains the command when this request did not arrive.
		-- Its next delivery replays the cached terminal settlement without
		-- executing the handler again. If the request arrived but its response was
		-- lost, the bridge has already removed the exact command.
	end
	local function dispatchCommand(delivery: any)
		if typeof(delivery) ~= "table" or typeof(delivery.commandHash) ~= "string" or not string.match(delivery.commandHash, "^[0-9a-f]+$") or #delivery.commandHash ~= 64 or typeof(delivery.commandJson) ~= "string" then
			error("malformed hash-bound command delivery")
		end
		if Hash.sha256(delivery.commandJson) ~= delivery.commandHash then error("hash-bound command body mismatch") end
		local decoded, command = pcall(function() return HttpService:JSONDecode(delivery.commandJson) end)
		if not decoded or typeof(command) ~= "table" or typeof(command.messageId) ~= "string" then error("malformed hash-bound command body") end
		local previous = handledCommands[command.messageId]
		if previous then
			if previous.commandHash ~= delivery.commandHash then error("backend command messageId conflicts with a different hash") end
			sendCommandSettlement(previous, command.requestId)
			return
		end
		local executed, failure = pcall(function() handle(command) end)
		local classification = if executed then nil else classifyCommandFailure(command, failure)
		local settlement: any = {
			commandMessageId = command.messageId,
			commandHash = delivery.commandHash,
			disposition = if executed then "executed" else "rejected",
		}
		if not executed then
			settlement.classification = classification
			settlement.detail = boundedCommandDiagnostic(failure)
			if command.type == "LinkStudioProject" or command.type == "ForkStudioProject" then
				settlement.identityRejection = projectIdentity:rejectionEvidence(command.payload.operation)
			end
		end
		local record = {
			commandHash = delivery.commandHash,
			settlement = settlement,
			settlementMessageId = commandSettlementId(command.messageId, delivery.commandHash),
		}
		-- Cache both terminal outcomes before transport. A deterministic rejection
		-- is never re-executed merely because its settlement response was lost.
		handledCommands[command.messageId] = record
		table.insert(handledCommandOrder, command.messageId)
		while #handledCommandOrder > 128 do
			local expired = table.remove(handledCommandOrder, 1)
			if expired then handledCommands[expired] = nil end
		end
		sendCommandSettlement(record, command.requestId)
		if not executed then
			return { rejected = true, command = command, classification = classification, failure = failure }
		end
	end
	local function processCommandDelivery(delivery: any)
		local handled, outcome = pcall(function() return dispatchCommand(delivery) end)
		if not handled then
			local command = nil
			if typeof(delivery) == "table" and typeof(delivery.commandJson) == "string" then
				local decoded, value = pcall(function() return HttpService:JSONDecode(delivery.commandJson) end)
				if decoded and typeof(value) == "table" then command = value end
			end
			local classification = classifyCommandFailure(command, outcome)
			local reported, reportFailure = pcall(function()
				if typeof(command) == "table" then reportBoundMutationFailure(command, classification, outcome) end
			end)
			pluginError(classification, reported and outcome or reportFailure, false, typeof(command) == "table" and command.requestId or nil)
		elseif typeof(outcome) == "table" and outcome.rejected == true then
			local reported, reportFailure = pcall(function()
				reportBoundMutationFailure(outcome.command, outcome.classification, outcome.failure)
			end)
			pluginError(outcome.classification, reported and outcome.failure or reportFailure, false, outcome.command.requestId)
		end
	end

	local function onConnection()
		if invalidPassiveState then
			local discarded, discardResult = pcall(function() return RuntimeCapabilityExecutor.discardInvalidPassive(plugin) end)
			if discarded and discardResult == true then
				invalidPassiveState = false
				passiveResume = false
				autoConnectEnabled = true
				currentCreatorSessionId = nil
				nextAutoPair = 0
				state("RECOVERY PAIRING", "Invalid Play evidence was discarded by creator authority. Forge is pairing read-only to inspect durable creator-transaction state.")
			else
				state("EVIDENCE INCOMPLETE", "Invalid Play evidence could not be cleared safely: " .. string.sub(tostring(discardResult), 1, Constants.MAX_DIAGNOSTIC_CHARS))
			end
		elseif passiveResume then
			state("WAITING FOR PLAY", "This paired session is reserved for the exact persisted Play-server observer.")
		elseif sessionId then studioWorker:enqueue("user-unpair", function() unpair(true, "user", true) end)
		else autoConnectEnabled = true; nextAutoPair = 0; state("CONNECTING", "Waiting for the local Forge service.") end
	end
	connectorView = ConnectorView.new(plugin, {
		bridgeUrl = bridgeUrl,
		buildHash = connectorBuildHash(),
		onConnection = onConnection,
		onRunTest = function() studioWorker:enqueue("manual-runtime-start", startArmedRuntime) end,
	})
	state("CONNECTING", "Start the local Forge service. Conversations, approvals, and recovery are in the dashboard.")
	if invalidPassiveState then
		state("INVALID PLAY DATA", "Forge retained an invalid durable Play receipt. Discard it explicitly to pair for creator-transaction recovery; no Play claim will be preserved.")
	elseif passiveResume then
		local replayed, replayFailure = pcall(function() return runtimeCapabilities:replayPassiveReceipt() end)
		if replayed and replayFailure then
			state("PLAY EVIDENCE RETURNED", "Forge re-sent the readback-verified Play-server receipt and is awaiting exact cleanup.")
		else
			state("WAITING FOR PLAY", "Forge has an exact persisted Play-server observer. Press Play normally; Forge will not re-pair or alter Studio.")
		end
	end

	task.spawn(function()
		local idle, nextHeartbeat, nextLeasePoll = 0.25, 0, 0
		while running do
			if studioWorker:isBusy() then
				-- Long, cooperative Studio jobs deliberately do not accept another
				-- command, but the bridge transport lease must still know this exact
				-- connector is alive. Poll is non-destructive; any delivered command
				-- remains queued until the worker becomes idle and settles it.
				if sessionId and sessionToken and os.clock() >= nextLeasePoll then
					request("GET", "/poll?sessionId=" .. HttpService:UrlEncode(sessionId))
					nextLeasePoll = os.clock() + 5
				end
				idle = 0.05
			elseif sessionId and sessionToken then
				local ok, response, statusCode = request("GET", "/poll?sessionId=" .. HttpService:UrlEncode(sessionId))
				if ok and typeof(response) == "table" and response.kind == "ForgeStudioCommandDelivery" and response.sessionId == sessionId and typeof(response.commands) == "table" then
					transportFailures = 0
					nextLeasePoll = os.clock() + 5
					if not passiveResume and os.clock() >= nextHeartbeat then
						local recovery = authoring:recovery()
						local observedIdentity = projectIdentity:observe()
						local sent = send("Heartbeat", { project = observedIdentity.project, projectIdentity = observedIdentity, manifestHash = Generated.manifestHash, currentProjectIndexManifestId = currentProjectIndexManifestId, currentProjectRevisionHash = currentProjectRevision, activeRecording = recovery.recording and recovery.recording or nil })
						if sent then adoptProjectIdentity(observedIdentity) end
						nextHeartbeat = os.clock() + 15
					end
					idle = runtimeCapabilities.active and 0.1 or (#response.commands == 0 and math.min(3, idle * 1.5) or 0.1)
					local queuedCommand = false
					for _, delivery in ipairs(response.commands) do
						local key = if typeof(delivery) == "table" and typeof(delivery.commandHash) == "string" then delivery.commandHash else "malformed-command-head"
						local queuedDelivery = delivery
						if studioWorker:enqueue("command:" .. key, function() processCommandDelivery(queuedDelivery) end) then queuedCommand = true end
					end
					if not queuedCommand then
						while #pending > 0 do local item = pending[1]; local sent, failure, status = postMessage(item.message); if sent then table.remove(pending, 1) elseif typeof(status) == "number" and status >= 400 and status < 500 then table.remove(pending, 1); pluginError("STUDIO_FAILURE", failure, false, item.requestId) else break end end
					end
				else
					transportFailures += 1
					if statusCode == 401 then
						studioWorker:enqueue("rejected-session-unpair", function()
							if passiveResume then
								-- The bridge no longer recognizes the original durable session.
								-- Retain its arm/receipt exactly, but never replay it into a new
								-- session. A fresh pair reports only persisted recovery state.
								local abandoned, abandonmentFailure = pcall(function() return RuntimeCapabilityExecutor.abandonPassiveTransport(plugin) end)
								if not abandoned or abandonmentFailure ~= true then
									autoConnectEnabled = false
									unpair(false, "session_replaced", true)
									state("EVIDENCE INCOMPLETE", "Forge could not preserve the stale Play transport state for recovery: " .. string.sub(tostring(abandonmentFailure), 1, Constants.MAX_DIAGNOSTIC_CHARS))
								else
									passiveResume = false
									autoConnectEnabled = true
									currentCreatorSessionId = nil
								end
							end
							unpair(false, "session_replaced", false)
						end)
					elseif transportFailures >= 3 then state("BRIDGE UNREACHABLE", "Forge will keep retrying; no Studio recording will be changed automatically.") end
					idle = math.min(3, idle * 2)
				end
			elseif autoConnectEnabled then
				if os.clock() >= nextAutoPair then
					nextAutoPair = os.clock() + 1
					studioWorker:enqueue("pairing", function() pairAutomatically() end)
				end
				idle = 0.25
			else idle = 0.5 end
			task.wait(idle)
		end
	end)
	plugin.Unloading:Connect(function()
		-- Transport release is best-effort and has no Studio side effect. Durable
		-- identity/creator cursors remain in plugin settings for exact re-pair
		-- recovery if this one local POST cannot complete during shutdown.
		if sessionId and sessionToken then
			pcall(function()
				postMessage(messageFor("UnpairProject", { reason = "plugin_unload" }, nil, messageId("plugin_unload")))
			end)
		end
		running = false; studioWorker:close(); runtimeCapabilities:abort()
		if connectorView then connectorView.destroy(); connectorView = nil end
		if projectChangeMonitor then projectChangeMonitor:destroy(); projectChangeMonitor = nil end
		if stopRegistry then stopRegistry(); stopRegistry = nil end
	end)
end

return Runtime
