--!strict
local HttpService = game:GetService("HttpService")
local StudioTestService = game:GetService("StudioTestService")
local Constants = require(script.Parent.Constants)
local Generated = require(script.Parent.GeneratedStudioEvidence)
local Hash = require(script.Parent.Hash)
local IdentityRegistry = require(script.Parent.IdentityRegistry)
local RuntimeCapabilityExecutor = require(script.Parent.RuntimeCapabilityExecutor)
local StudioAuthoring = require(script.Parent.StudioAuthoring)
local StudioEvidenceCollector = require(script.Parent.StudioEvidenceCollector)

local Runtime = {}

local function iso(): string return os.date("!%Y-%m-%dT%H:%M:%S.000Z") end
local function messageId(prefix: string): string return prefix .. "_" .. HttpService:GenerateGUID(false) end
local function capabilities()
	return { "studio_evidence", "evidence_chunks", "sha256", "stable_identity", "reflection_attestation", "detached_preflight", "transactional_authoring", "recording_recovery", "studio_play_mode", "bounded_diagnostics", "http_polling" }
end
local function connectorBuildHash(): string return Generated.connectorBuildHash end
local function substrateAvailable(): boolean return Hash.available() and typeof(StudioTestService.ExecutePlayModeAsync) == "function" end

function Runtime.start(plugin: Plugin)
	local bridgeUrl = plugin:GetSetting("ForgeBridgeUrlV2")
	if typeof(bridgeUrl) ~= "string" or bridgeUrl == "" then bridgeUrl = Constants.BRIDGE_URL end
	local sessionId: string? = nil
	local projectId: string? = nil
	local sessionToken: string? = nil
	local currentRevision: string? = nil
	local projectStateProjection: any? = nil
	local running, autoConnectEnabled, pairing = true, true, false
	local nextAutoPair, transportFailures = 0, 0
	local pending = {} :: {{kind: string, payload: any, requestId: string?, messageId: string}}
	local registry = IdentityRegistry.new()
	local collector = StudioEvidenceCollector.new(registry)
	local authoring = StudioAuthoring.new(plugin, registry, collector)
	local stopRegistry: (() -> ())? = nil
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
	local function send(kind: string, payload: any, requestId: string?, suppliedId: string?): (boolean, any?, number)
		local message: any = { kind = "StudioProtocolMessage", direction = "plugin_to_backend", type = kind, messageId = suppliedId or messageId("msg"), sentAt = iso(), payload = payload }
		if sessionId then message.sessionId = sessionId end
		if requestId then message.requestId = requestId end
		return request("POST", "/message", message)
	end
	local function sendRequired(kind: string, payload: any, requestId: string?)
		local sent, failure = send(kind, payload, requestId)
		if not sent then error(kind .. " transport failed: " .. tostring(failure)) end
	end
	local function pluginError(code: string, detail: any, retryable: boolean, requestId: string?)
		if sessionId then send("PluginError", { code = code, message = string.sub(tostring(detail), 1, Constants.MAX_DIAGNOSTIC_CHARS), retryable = retryable }, requestId) end
		state(code == "RECOVERY_REQUIRED" and "RECOVERY REQUIRED" or "EVIDENCE INCOMPLETE", string.sub(tostring(detail), 1, Constants.MAX_DIAGNOSTIC_CHARS))
	end
	local function decodeProjection(json: any, jsonHash: any, projectionHash: any)
		if typeof(json) ~= "string" or typeof(jsonHash) ~= "string" or Hash.sha256(json) ~= jsonHash then error("projection transport hash mismatch") end
		local ok, projection = pcall(function() return HttpService:JSONDecode(json) end)
		if not ok or typeof(projection) ~= "table" or typeof(projectionHash) ~= "string" or projection.contentHash ~= projectionHash then error("projection JSON/content binding mismatch") end
		Generated.validateProjection(projection)
		return projection
	end
	local function evidencePayload(reason: string, projection: any, envelope: any)
		local payload: any = { project = collector:identity(), reason = reason, projection = projection, envelope = envelope }
		-- A state revision is a statement about a closed observation.  Incomplete
		-- evidence remains useful as evidence of incompleteness, but it must never
		-- be promoted into a revision authority binding.
		if projection.scope.mode == "project_state" and envelope.completion == "complete" then payload.revision = collector:stateRevision(projection, envelope) end
		return payload
	end
	local function sendEvidence(reason: string, projection: any, requestId: string?): (boolean, any?, any?)
		local made, envelope = pcall(function()
			if projection.purpose == "capability_attestation" then return collector:attestation(projection) end
			if projection.scope.mode == "project_state" then return collector:produceProjectState(projection) end
			return collector:produce(projection)
		end)
		if not made then return false, envelope, nil end
		local payload = evidencePayload(reason, projection, envelope)
		-- A revision is usable as an authority binding only when its complete
		-- project-state envelope closed every required fact.  Do not carry a
		-- prior revision across an incomplete observation of a changed place.
		if payload.revision then currentRevision = envelope.completion == "complete" and payload.revision.stateHash or nil end
		local chunks = collector:chunks(payload)
		if chunks then
			for _, chunk in ipairs(chunks) do
				local sent, failure = send("StudioEvidenceChunk", chunk, requestId)
				if not sent then return false, failure, envelope end
			end
			return true, nil, envelope
		end
		local sent, failure = send("StudioEvidenceProduced", payload, requestId)
		return sent, failure, envelope
	end
	local function captureState(boundary: string, stateProjection: any?): any
		local selected = stateProjection or projectStateProjection
		if not selected then error(boundary .. " has no server-bound project-state projection") end
		Generated.validateProjection(selected)
		if selected.scope.mode ~= "project_state" then error(boundary .. " requires a project-state projection") end
		local envelope = collector:produceProjectState(selected)
		local revision = envelope.completion == "complete" and collector:stateRevision(selected, envelope) or nil
		currentRevision = revision and revision.stateHash or nil
		return { projection = selected, envelope = envelope, revision = revision }
	end
	local function publishState(reason: string, boundary: string, requestId: string?, stateProjection: any?): any
		local selected = stateProjection or projectStateProjection
		if not selected then error(boundary .. " has no server-bound project-state projection") end
		local sent, failure, envelope = sendEvidence(reason, selected, requestId)
		if not sent then error(boundary .. " state evidence transport failed: " .. tostring(failure)) end
		if not envelope or envelope.completion ~= "complete" then error(boundary .. " requires complete project-state evidence") end
		return { projection = selected, envelope = envelope, revision = collector:stateRevision(selected, envelope) }
	end
	local function finalizationPayload(receipt: any): any
		if typeof(receipt) ~= "table" or typeof(receipt.afterRevision) ~= "table" or typeof(receipt.postFinalizeStateProjection) ~= "table" or typeof(receipt.postFinalizeStateEvidence) ~= "table" then error("persisted finalization receipt is malformed") end
		return { creatorSessionId = receipt.creatorSessionId, changeSetId = receipt.changeSetId, changeSetHash = receipt.changeSetHash, projectionId = receipt.projectionId, projectionHash = receipt.projectionHash, manifestHash = receipt.manifestHash, beforeRevisionHash = receipt.beforeRevisionHash, recordingId = receipt.recordingId, action = receipt.action, status = receipt.status, afterRevision = receipt.afterRevision, postFinalizeStateProjection = receipt.postFinalizeStateProjection, postFinalizeStateEvidence = receipt.postFinalizeStateEvidence }
	end

	local runtimeCapabilities = RuntimeCapabilityExecutor.new(function(kind, payload, requestId)
		local item = { kind = kind, payload = payload, requestId = requestId, messageId = messageId("runtime") }
		local sent, failure, status = send(item.kind, item.payload, item.requestId, item.messageId)
		if sent then return true end
		if typeof(status) == "number" and status >= 400 and status < 500 then pluginError("STUDIO_FAILURE", failure, false, requestId); return nil end
		if #pending >= 16 then error("runtime outbox exceeds bound") end
		table.insert(pending, item); return false
	end, state)

	local function startArmedRuntime()
		if not runtimeCapabilities.active or runtimeCapabilities.active.phase ~= "armed" then state("NOT READY", "No exact runtime evidence projection is armed."); return end
		if runButton then runButton.Active = false; runButton.AutoButtonColor = false end
		local observed, failure = pcall(function() return publishState("pre_play", "runtime precondition", runtimeCapabilities.active and runtimeCapabilities.active.requestId or nil) end)
		if not observed or runtimeCapabilities.active.plan.binding.projectStateRevisionHash ~= currentRevision then
			local requestId = runtimeCapabilities.active and runtimeCapabilities.active.requestId or nil
			runtimeCapabilities:abort(); pluginError("STALE_EVIDENCE", failure or "runtime plan revision does not match complete project state", false, requestId); return
		end
		local requestId = runtimeCapabilities.active and runtimeCapabilities.active.requestId or nil
		local started, startFailure = pcall(function() runtimeCapabilities:start() end)
		if not started then pluginError("STUDIO_FAILURE", startFailure, false, requestId) end
	end

	local function unpair(notifyBridge: boolean?, reason: string?, disableAutoConnect: boolean?)
		if disableAutoConnect then autoConnectEnabled = false end
		runtimeCapabilities:abort()
		if authoring:hasPossibleRecording() then state("RECOVERY REQUIRED", "A Forge creator recording may still be open. Re-pair to inspect it; Forge will not change Studio automatically.") end
		if runButton then runButton.Visible = false; runButton.Active = false; runButton.AutoButtonColor = false end
		if notifyBridge and sessionId and sessionToken then send("UnpairProject", { reason = reason or "user" }) end
		sessionId, projectId, sessionToken, currentRevision, projectStateProjection = nil, nil, nil, nil, nil
		if stopRegistry then stopRegistry(); stopRegistry = nil end
		table.clear(pending)
		if pairButton then pairButton.Text = autoConnectEnabled and "Connecting…" or "Connect" end
		state(autoConnectEnabled and "CONNECTING" or "DISCONNECTED", autoConnectEnabled and "Waiting for the local Forge bridge." or "Automatic connection is paused.")
	end
	local function recoveryPayload(recording: any, recordingState: string, evidenceProjection: any?, evidence: any?): any
		if not recording then return { recordingState = "none" } end
		return {
			creatorSessionId = recording.creatorSessionId,
			changeSetId = recording.changeSetId,
			changeSetHash = recording.changeSetHash,
			projectionId = recording.projectionId,
			projectionHash = recording.projectionHash,
			manifestHash = recording.manifestHash,
			beforeRevisionHash = recording.beforeRevisionHash,
			recordingId = recording.recordingId,
			recordingState = recordingState,
			evidenceProjection = evidenceProjection,
			evidence = evidence,
		}
	end

	local function pairAutomatically(): boolean
		if pairing or sessionId or not autoConnectEnabled then return false end
		if not substrateAvailable() then state("UNSUPPORTED STUDIO", "Forge requires SHA-256 and ExecutePlayModeAsync."); return false end
		pairing = true; state("CONNECTING", "Discovering the local Forge bridge.")
		local discovered, discovery = request("GET", "/pairing")
		if not discovered or typeof(discovery) ~= "table" or typeof(discovery.pairing) ~= "table" or typeof(discovery.pairing.token) ~= "string" then pairing = false; state("WAITING FOR BRIDGE", "Start `forge studio bridge`; Forge will connect automatically."); return false end
		local ok, response, status = request("POST", "/message", { kind = "StudioProtocolMessage", direction = "plugin_to_backend", type = "PairProject", messageId = messageId("pair"), sentAt = iso(), payload = { pairingToken = discovery.pairing.token, project = collector:identity(), capabilities = capabilities(), connectorBuildHash = connectorBuildHash(), manifestHash = Generated.manifestHash } })
		pairing = false
		if not ok then
			if typeof(status) == "number" and status >= 400 and status < 500 then autoConnectEnabled = false end
			state(status == 0 and "WAITING FOR BRIDGE" or "CONNECTION REJECTED", tostring(response)); return false
		end
		if typeof(response) ~= "table" or typeof(response.sessionId) ~= "string" or typeof(response.projectId) ~= "string" or typeof(response.sessionToken) ~= "string" or response.manifestHash ~= Generated.manifestHash or response.connectorBuildHash ~= connectorBuildHash() then state("CONNECTION REJECTED", "Bridge returned incompatible build or manifest identity."); return false end
		sessionId, projectId, sessionToken = response.sessionId, response.projectId, response.sessionToken
		local accepted, setup = pcall(function()
			local attestation = decodeProjection(response.capabilityAttestationProjectionJson, response.capabilityAttestationProjectionJsonHash, response.capabilityAttestationProjectionHash)
			projectStateProjection = decodeProjection(response.projectStateProjectionJson, response.projectStateProjectionJsonHash, response.projectStateProjectionHash)
			local expectedProject = collector:identity()
			local expectedPairingHash = Hash.sha256(discovery.pairing.token)
			local function assertPairingProjection(projection: any, purpose: string)
				if projection.purpose ~= purpose or projection.project.name ~= expectedProject.name or projection.project.placeId ~= expectedProject.placeId or projection.project.universeId ~= expectedProject.universeId or typeof(projection.binding) ~= "table" or projection.binding.sessionId ~= sessionId or projection.binding.projectId ~= projectId or projection.binding.buildHash ~= connectorBuildHash() or projection.binding.pairingHash ~= expectedPairingHash then error("pairing projection binding mismatch") end
			end
			assertPairingProjection(attestation, "capability_attestation")
			assertPairingProjection(projectStateProjection, "project_state")
			stopRegistry = registry:start()
			local sent, failure = sendEvidence("capability_attestation", attestation)
			if not sent then error(failure) end
			sent, failure = sendEvidence("pairing", projectStateProjection)
			if not sent then error(failure) end
			-- A finalization receipt represents no open recording.  Re-emitting it
			-- after a reconnect is evidence delivery only: it never repeats a
			-- commit, cancel, Apply, or other Studio mutation.
			local receipt = authoring:finalizationReceipt()
			if receipt then
				sent, failure = send("CreatorChangeFinalized", finalizationPayload(receipt))
				if not sent then error(failure) end
			end
			local recovery = authoring:recovery()
			if recovery.recording then
				if typeof(recovery.recording.beforeStateProjection) ~= "table" then error("persisted recording has no exact state projection") end
				local recoveryEnvelope = collector:produceProjectState(recovery.recording.beforeStateProjection)
				local recoveryRevision = recoveryEnvelope.completion == "complete" and collector:stateRevision(recovery.recording.beforeStateProjection, recoveryEnvelope) or nil
				currentRevision = recoveryRevision and recoveryRevision.stateHash or nil
				if typeof(recovery.recording.finalization) == "table" and recoveryRevision then
					local finalReceipt = authoring:recordFinalizationEvidence(recovery.recording, { projection = recovery.recording.beforeStateProjection, envelope = recoveryEnvelope, revision = recoveryRevision })
					sent, failure = send("CreatorChangeFinalized", finalizationPayload(finalReceipt))
				else
					authoring:recordRecoveryEvidence(recoveryEnvelope.contentHash)
					sent, failure = send("CreatorRecordingRecovery", recoveryPayload(recovery.recording, recovery.recordingState, recovery.recording.beforeStateProjection, recoveryEnvelope))
				end
				if not sent then error(failure) end
			else
				sent, failure = send("CreatorRecordingRecovery", recoveryPayload(nil, "none"))
				if not sent then error(failure) end
			end
		end)
		if not accepted then unpair(false, "session_replaced", true); state("CONNECTION REJECTED", tostring(setup)); return false end
		if pairButton then pairButton.Text = "Disconnect" end
		state("CONNECTED", "Manifest attestation and complete project-state evidence sent.")
		return true
	end

	local function recordingBinding(active: any): any
		return { creatorSessionId = active.binding.creatorSessionId, changeSetId = active.binding.changeSetId, changeSetHash = active.binding.changeSetHash, projectionId = active.prepared.projection.id, projectionHash = active.binding.projectionHash, manifestHash = active.binding.manifestHash, beforeRevisionHash = active.binding.beforeRevisionHash, recordingId = active.binding.recordingId }
	end
	local function mutationFailed(active: any?, stage: string, failureCode: string, requestId: string?, cancellationProven: boolean?)
		local recovery = authoring:recovery()
		local binding = active and active.binding or nil
		local failed = authoring:failure()
		if not binding and failed then binding = failed.binding; cancellationProven = failed.cancellationProven end
		if binding then
			local payload: any = { creatorSessionId = binding.creatorSessionId, changeSetId = binding.changeSetId, changeSetHash = binding.changeSetHash, projectionHash = binding.projectionHash, stage = stage, failureCode = failureCode, recordingState = recovery.recordingState }
			if cancellationProven ~= nil then payload.cancellationProven = cancellationProven end
			sendRequired("CreatorMutationFailed", payload, requestId)
		end
	end
	local function cancelAfterEvidenceFailure(active: any, stage: string, failureCode: string, requestId: string?)
		local cancelled, bindingOrFailure = pcall(function() return authoring:cancelActiveForEvidenceFailure(active, failureCode) end)
		if not cancelled then
			mutationFailed(active, stage, failureCode, requestId, false)
			error(bindingOrFailure)
		end
		local captured, postOrFailure = pcall(function() return captureState("creator provisional-evidence cancellation", active.prepared.beforeStateProjection) end)
		if not captured or typeof(postOrFailure.revision) ~= "table" or postOrFailure.envelope.completion ~= "complete" then
			mutationFailed(nil, stage, failureCode, requestId, false)
			error(captured and "post-cancel state evidence was incomplete" or postOrFailure)
		end
		local retained, receiptOrFailure = pcall(function() return authoring:recordFinalizationEvidence(bindingOrFailure, postOrFailure) end)
		if not retained then
			mutationFailed(nil, stage, failureCode, requestId, false)
			error(receiptOrFailure)
		end
		mutationFailed(nil, stage, failureCode, requestId, true)
		sendRequired("CreatorChangeFinalized", finalizationPayload(receiptOrFailure), requestId)
	end
	local function handle(message: any)
		if typeof(message) ~= "table" or message.kind ~= "StudioProtocolMessage" or message.direction ~= "backend_to_plugin" or typeof(message.payload) ~= "table" or message.sessionId ~= sessionId then error("malformed backend message") end
		if message.type == "RequestStudioEvidence" then
			local projection = decodeProjection(message.payload.projectionJson, message.payload.projectionJsonHash, message.payload.projectionHash)
			local sent, failure = sendEvidence(message.payload.reason, projection, message.requestId)
			if not sent then error(failure) end
		elseif message.type == "ExecuteRuntimeEvalPlan" then
			if not currentRevision or message.payload.expectedRevision ~= currentRevision then error("runtime execution requires current complete evidence") end
			if not sessionId or not projectId then error("runtime execution requires pairing") end
			runtimeCapabilities:arm(message.payload, message.requestId, { sessionId = sessionId, projectId = projectId, revision = currentRevision, project = collector:identity() })
			if message.payload.startPolicy == "creator_action_already_authorized" then if runButton then runButton.Visible = false end; task.defer(startArmedRuntime) elseif runButton then runButton.Visible = true; runButton.Active = true; runButton.AutoButtonColor = true end
		elseif message.type == "PrepareCreatorChangeSet" then
			local beforeStateProjection = decodeProjection(message.payload.beforeStateProjectionJson, message.payload.beforeStateProjectionJsonHash, message.payload.beforeStateProjectionHash)
			if beforeStateProjection.purpose ~= "project_state" or beforeStateProjection.scope.mode ~= "project_state" or beforeStateProjection.binding.revisionHash ~= message.payload.expectedRevision then error("creator before-state projection binding mismatch") end
			local stateEvidence = publishState("pre_apply", "creator prepare", message.requestId, beforeStateProjection)
			if message.payload.expectedRevision ~= stateEvidence.revision.stateHash then error("creator prepare revision stale") end
			local prepared = authoring:prepare(message.payload, stateEvidence.revision.stateHash, stateEvidence.projection, stateEvidence.envelope)
			sendRequired("CreatorChangePrepared", prepared, message.requestId)
		elseif message.type == "PreflightCreatorChangeSet" then
			local prepared = authoring.prepared
			if not prepared then error("creator preflight has no exact prepared state projection") end
			local stateEvidence = publishState("pre_apply", "creator preflight", message.requestId, prepared.beforeStateProjection)
			if message.payload.expectedRevision ~= stateEvidence.revision.stateHash then error("creator preflight revision stale") end
			local envelope = authoring:preflight(message.payload)
			local preflightResult: any = { creatorSessionId = prepared.changeSet.sessionId, changeSetId = prepared.changeSet.id, changeSetHash = prepared.changeSet.hash, projectionId = prepared.projection.id, projectionHash = prepared.projection.contentHash, preflightProjectionId = prepared.preflightProjection.id, preflightProjectionHash = prepared.preflightProjection.contentHash, manifestHash = Generated.manifestHash, beforeRevisionHash = stateEvidence.revision.stateHash, preflightEvidence = envelope, status = envelope.completion == "complete" and "passed" or "incomplete" }
			if envelope.completion ~= "complete" then preflightResult.failureCode = "capability_preflight_failed" end
			sendRequired("CreatorChangePreflighted", preflightResult, message.requestId)
		elseif message.type == "ApplyCreatorChangeSet" then
			local prepared = authoring.prepared
			if not prepared then error("creator apply has no exact prepared state projection") end
			local stateEvidence = publishState("pre_apply", "creator apply", message.requestId, prepared.beforeStateProjection)
			if message.payload.expectedRevision ~= stateEvidence.revision.stateHash then error("creator apply revision stale") end
			local applied, activeOrFailure = pcall(function() return authoring:apply(message.payload, stateEvidence.revision.stateHash) end)
			if not applied then
				local failed = authoring:failure()
				local receipt = nil
				if failed and failed.cancellationProven then
					local postOk, post = pcall(function() return captureState("creator failed-apply cancellation", failed.binding.beforeStateProjection) end)
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
				local cancellationProven: boolean? = nil
				if failed ~= nil then cancellationProven = failed.cancellationProven end
				local applyFailureCode = failed and failed.failureCode or "mutation_apply_failed"
				mutationFailed(authoring.active, "apply", applyFailureCode, message.requestId, cancellationProven)
				if receipt then
					-- The failed batch and its cancellation are separate immutable
					-- phases.  Emit both: CreatorMutationFailed identifies the failed
					-- execution and CreatorChangeFinalized carries the complete
					-- post-cancel state/revision receipt for replay and acknowledgement.
					sendRequired("CreatorChangeFinalized", finalizationPayload(receipt), message.requestId)
				end
				error(activeOrFailure)
			end
			local active = activeOrFailure
			local readbackOk, direct = pcall(function() return collector:produce(active.prepared.projection) end)
			if not readbackOk then cancelAfterEvidenceFailure(active, "readback", "mutation_readback_failed", message.requestId); return end
			local postOk, post = pcall(function() return captureState("creator post-apply", active.prepared.beforeStateProjection) end)
			if not postOk then cancelAfterEvidenceFailure(active, "post_state", "post_state_evidence_failed", message.requestId); return end
			if post.envelope.completion ~= "complete" or typeof(post.revision) ~= "table" then
				cancelAfterEvidenceFailure(active, "post_state", "post_state_evidence_incomplete", message.requestId)
				return
			end
			local retained, _retentionFailure = pcall(function() authoring:recordProvisionalEvidence(active, direct, post) end)
			if not retained then
				cancelAfterEvidenceFailure(active, "post_state", "provisional_cursor_persistence_failed", message.requestId)
				return
			end
			local provisional = recordingBinding(active)
			provisional.directReadbackEvidence = direct
			provisional.postApplyStateProjection = post.projection
			provisional.postApplyStateEvidence = post.envelope
			provisional.postApplyRevision = post.revision
			provisional.status = "provisional"
			local sent, failure = send("CreatorMutationProvisional", provisional, message.requestId)
			if not sent then error("provisional evidence transport failed after local persistence: " .. tostring(failure)) end
		elseif message.type == "FinalizeCreatorChangeSet" then
			local active = authoring.active
			local finalized, result = pcall(function() return authoring:finalize(message.payload) end)
			if not finalized then mutationFailed(active, message.payload.action == "commit" and "commit" or "cancel", "finalization_failed", message.requestId); error(result) end
			local post = captureState(message.payload.action == "commit" and "post_commit" or "post_cancel", result.prepared.beforeStateProjection)
			local receipt = authoring:recordFinalizationEvidence(result.binding, post)
			local sent, failure = send("CreatorChangeFinalized", finalizationPayload(receipt), message.requestId)
			if not sent then error("finalization evidence transport failed after local persistence: " .. tostring(failure)) end
		elseif message.type == "RequestCreatorRecordingRecovery" then
			local recovery = authoring:recovery()
			if not recovery.recording or typeof(recovery.recording.beforeStateProjection) ~= "table" then error("recording recovery has no exact persisted state projection") end
			local expected = recoveryPayload(recovery.recording, recovery.recordingState, recovery.recording.beforeStateProjection, {})
			for _, key in ipairs({ "creatorSessionId", "changeSetId", "changeSetHash", "projectionId", "projectionHash", "manifestHash", "beforeRevisionHash", "recordingId" }) do
				if message.payload[key] ~= expected[key] then error("recording recovery binding mismatch") end
			end
			local post = captureState("recording_recovery", recovery.recording.beforeStateProjection)
			authoring:recordRecoveryEvidence(post.envelope.contentHash)
			sendRequired("CreatorRecordingRecovery", recoveryPayload(recovery.recording, recovery.recordingState, post.projection, post.envelope), message.requestId)
		elseif message.type == "AcknowledgeClosedCreatorRecording" then
			local cleared = authoring:acknowledgeClosedRecording(message.payload)
			local acknowledged = recoveryPayload(cleared, "not_open", {}, {})
			acknowledged.recordingState = nil
			acknowledged.evidenceProjection = nil
			acknowledged.evidence = nil
			acknowledged.recoveryProjectionHash = message.payload.recoveryProjectionHash
			acknowledged.recoveryEvidenceHash = message.payload.recoveryEvidenceHash
			acknowledged.status = "closed_cursor_cleared"
			sendRequired("CreatorClosedRecordingAcknowledged", acknowledged, message.requestId)
		elseif message.type == "CancelInterruptedRecording" then
			local stored = authoring:cancelInterrupted(message.payload)
			if typeof(stored.beforeStateProjection) ~= "table" then error("interrupted recording has no exact persisted state projection") end
			local post = captureState("post_cancel", stored.beforeStateProjection)
			local receipt = authoring:recordFinalizationEvidence(stored, post)
			sendRequired("CreatorChangeFinalized", finalizationPayload(receipt), message.requestId)
		elseif message.type == "AcknowledgeCreatorChangeFinalization" then
			authoring:acknowledgeFinalization(message.payload)
		elseif message.type == "RollbackCreatorCheckpoint" then
			if not currentRevision or message.payload.expectedRevision ~= currentRevision then error("checkpoint rollback requires exact revision") end
			local before = currentRevision; authoring:rollback(message.payload, currentRevision)
			local post = captureState("post_cancel")
			sendRequired("CreatorCheckpointRolledBack", { creatorSessionId = message.payload.creatorSessionId, checkpointId = message.payload.checkpointId, changeSetId = message.payload.changeSetId, changeSetHash = message.payload.changeSetHash, beforeRevisionHash = before, afterRevision = post.revision, evidenceProjection = post.projection, evidence = post.envelope, status = "rolled_back" }, message.requestId)
		else error("unsupported backend command") end
	end

	local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, true, false, 360, 220, 320, 180)
	local widget = plugin:CreateDockWidgetPluginGuiAsync("ForgeStudio", info); widget.Title = "Forge Connector"
	local frame = Instance.new("Frame"); frame.Size = UDim2.fromScale(1, 1); frame.BackgroundColor3 = Color3.fromRGB(17, 24, 39); frame.BorderSizePixel = 0; frame.Parent = widget
	widgetStatus = Instance.new("TextLabel"); widgetStatus.Size = UDim2.new(1, -24, 0, 28); widgetStatus.Position = UDim2.fromOffset(12, 12); widgetStatus.BackgroundTransparency = 1; widgetStatus.TextColor3 = Color3.fromRGB(229, 231, 235); widgetStatus.Font = Enum.Font.GothamBold; widgetStatus.TextSize = 16; widgetStatus.TextXAlignment = Enum.TextXAlignment.Left; widgetStatus.Parent = frame
	widgetDetail = Instance.new("TextLabel"); widgetDetail.Size = UDim2.new(1, -24, 0, 64); widgetDetail.Position = UDim2.fromOffset(12, 44); widgetDetail.BackgroundTransparency = 1; widgetDetail.TextColor3 = Color3.fromRGB(156, 163, 175); widgetDetail.Font = Enum.Font.Gotham; widgetDetail.TextSize = 12; widgetDetail.TextWrapped = true; widgetDetail.TextXAlignment = Enum.TextXAlignment.Left; widgetDetail.TextYAlignment = Enum.TextYAlignment.Top; widgetDetail.Parent = frame
	local evaluate = Instance.new("TextButton"); evaluate.Size = UDim2.new(1, -24, 0, 32); evaluate.Position = UDim2.fromOffset(12, 118); evaluate.Text = "Run Approved Play Solo Check"; evaluate.Visible = false; evaluate.Active = false; evaluate.AutoButtonColor = false; evaluate.Parent = frame; runButton = evaluate
	local pair = Instance.new("TextButton"); pair.Size = UDim2.new(1, -24, 0, 28); pair.Position = UDim2.fromOffset(12, 162); pair.Text = "Connecting…"; pair.Parent = frame; pairButton = pair
	state("CONNECTING", "Start the local Forge service. Evidence, approvals, and recovery live in the dashboard.")
	pair.MouseButton1Click:Connect(function() if sessionId then unpair(true, "user", true) else autoConnectEnabled = true; nextAutoPair = 0; pair.Text = "Connecting…" end end)
	evaluate.MouseButton1Click:Connect(startArmedRuntime)

	task.spawn(function()
		local idle, nextHeartbeat = 0.25, 0
		while running do
			if sessionId and sessionToken then
				local ok, response, statusCode = request("GET", "/poll?sessionId=" .. HttpService:UrlEncode(sessionId))
				if ok and typeof(response) == "table" and typeof(response.messages) == "table" then
					transportFailures = 0
					if os.clock() >= nextHeartbeat then
						local recovery = authoring:recovery()
						send("Heartbeat", { project = collector:identity(), manifestHash = Generated.manifestHash, currentRevisionHash = currentRevision, activeRecording = recovery.recording and recovery.recording or nil })
						nextHeartbeat = os.clock() + 15
					end
					idle = runtimeCapabilities.active and 0.1 or (#response.messages == 0 and math.min(3, idle * 1.5) or 0.1)
					for _, message in ipairs(response.messages) do local handled, failure = pcall(function() handle(message) end); if not handled then local text = tostring(failure); pluginError(string.find(text, "RECOVERY_REQUIRED", 1, true) and "RECOVERY_REQUIRED" or "SECURITY_REJECTION", text, false, message.requestId) end end
					while #pending > 0 do local item = pending[1]; local sent, failure, status = send(item.kind, item.payload, item.requestId, item.messageId); if sent then table.remove(pending, 1) elseif typeof(status) == "number" and status >= 400 and status < 500 then table.remove(pending, 1); pluginError("STUDIO_FAILURE", failure, false, item.requestId) else break end end
				else
					transportFailures += 1
					if statusCode == 401 then unpair(false, "session_replaced") elseif transportFailures >= 3 then state("BRIDGE UNREACHABLE", "Forge will keep retrying; no Studio recording will be changed automatically.") end
					idle = math.min(3, idle * 2)
				end
			elseif autoConnectEnabled then if os.clock() >= nextAutoPair then pairAutomatically(); nextAutoPair = os.clock() + 1 end; idle = 0.25 else idle = 0.5 end
			task.wait(idle)
		end
	end)
	plugin.Unloading:Connect(function() running = false; runtimeCapabilities:abort(); if stopRegistry then stopRegistry(); stopRegistry = nil end end)
end

return Runtime
