--!strict
-- Lemonade-style explicit Play Solo execution. ExecuteAssertionPlan only arms
-- a run; the user starts it from the plugin. One temporary server Script owns
-- a direct EndTest(JSON) value, and Output remains diagnostics-only.
local HttpService = game:GetService("HttpService")
local StudioTestService = game:GetService("StudioTestService")
local Workspace = game:GetService("Workspace")
local Constants = require(script.Parent.Constants)
local HarnessRegistry = require(script.Parent.HarnessRegistry)
local Hash = require(script.Parent.Hash)

local StudioProofExecutor = {}
StudioProofExecutor.__index = StudioProofExecutor

local SERVER_NAME = "__ForgeStudioProofServer__"
local CLIENT_NAME = "__ForgeStudioProofClient__"

local function destroyNamed(parent: Instance?, name: string)
	if not parent then return end
	local existing = parent:FindFirstChild(name)
	if existing then existing:Destroy() end
end

local function executeWithDeadline(callback, seconds: number)
	local done, ok, value = false, false, nil
	task.spawn(function()
		ok, value = pcall(callback)
		done = true
	end)
	local deadline = os.clock() + seconds
	while not done and os.clock() < deadline do task.wait(0.1) end
	if not done then
		return false,
			"Play session did not end before the deadline. Press Stop in Studio, then reload Forge before retrying.",
			true
	end
	return ok, value, false
end

local function tableKeys(value: any): string
	if typeof(value) ~= "table" then return typeof(value) end
	local keys = {}
	for key in pairs(value) do table.insert(keys, tostring(key)) end
	table.sort(keys)
	return table.concat(keys, ",")
end

function StudioProofExecutor.new(send, state)
	return setmetatable({ send = send, state = state, active = nil, blocked = false, lastOutcome = nil }, StudioProofExecutor)
end

function StudioProofExecutor:isIncomplete(): boolean
	return self.lastOutcome == "incomplete"
end

function StudioProofExecutor:supportsPlan(payload: any): boolean
	local entry = HarnessRegistry.resolve(payload.harnessId, payload.harnessVersion)
	return entry ~= nil and entry.harness.supportsAssertions(payload.assertions)
end

function StudioProofExecutor:cleanup(run)
	if run then
		for _, instance in ipairs(run.injected) do pcall(function() instance:Destroy() end) end
	end
	destroyNamed(Workspace, SERVER_NAME)
	destroyNamed(game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts"), CLIENT_NAME)
end

function StudioProofExecutor:abort()
	if not self.active then return end
	local wasRunning = self.active.phase == "running"
	self.active.closed = true
	self:cleanup(self.active)
	self.active = nil
	if wasRunning then
		self.lastOutcome = "incomplete"
		self.blocked = true
		self.state("PLUGIN RELOAD REQUIRED", "The active Play Solo request was interrupted. Press Stop, then reload Forge.")
	end
end

function StudioProofExecutor:arm(payload, requestId)
	if self.active then error("a StudioProof run is already armed or running") end
	if self.blocked then error("StudioProof is blocked after an interrupted Play Solo request; reload the Forge plugin") end
	if typeof(StudioTestService.ExecutePlayModeAsync) ~= "function" then
		error("this Roblox Studio version does not provide ExecutePlayModeAsync")
	end
	self.lastOutcome = nil

	local nonce = HttpService:GenerateGUID(false) .. HttpService:GenerateGUID(false)
	local commitment = Hash.sha256(nonce)
	local harness = HarnessRegistry.resolve(payload.harnessId, payload.harnessVersion)
	if not harness then error("StudioProof harness is not allowlisted") end
	local context = {}
	for key, value in pairs(payload) do context[key] = value end
	context.nonce = nonce
	context.nonceCommitment = commitment
	context.harnessId = harness.id
	context.harnessVersion = harness.version
	context.harnessHash = harness.hash
	context.startedAt = os.date("!%Y-%m-%dT%H:%M:%SZ")

	local binding = {
		projectId = payload.projectId, sessionId = payload.sessionId, project = payload.project,
		runId = payload.runId, testPlanId = payload.testPlanId, correlationId = payload.correlationId,
		projectSnapshotHash = payload.projectSnapshotHash, mechanicContractHash = payload.mechanicContractHash,
		nonceCommitment = commitment,
	}
	self.active = {
		payload = payload,
		requestId = requestId,
		nonce = nonce,
		commitment = commitment,
		context = context,
		binding = binding,
		injected = {},
		closed = false,
		phase = "armed",
		harness = harness,
	}

	self.send("AssertionPlanAccepted", {
		projectId = binding.projectId, sessionId = binding.sessionId, project = binding.project,
		runId = binding.runId, testPlanId = binding.testPlanId, correlationId = binding.correlationId,
		projectSnapshotHash = binding.projectSnapshotHash, mechanicContractHash = binding.mechanicContractHash,
		nonceCommitment = binding.nonceCommitment, assertionCount = #payload.assertions,
		harnessId = harness.id, harnessVersion = harness.version,
		instruction = "Studio verification is armed. Click Verify in Studio in the Forge plugin.",
	}, requestId)
	self.state("READY TO VERIFY", "Click Verify in Studio. Forge will start one Play Solo session in this Studio window.")
end

function StudioProofExecutor:start()
	local run = self.active
	if not run then error("no StudioProof run is armed") end
	if run.phase ~= "armed" then error("StudioProof is already running") end

	local starterPlayerScripts = game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts")
	if not starterPlayerScripts then error("StarterPlayerScripts is unavailable") end

	local prepared, prepareError = pcall(function()
		local permissionProbe = Instance.new("Script")
		permissionProbe.Name = "__ForgePermissionProbe__"
		local allowed, permissionError = pcall(function()
			permissionProbe.Source = "-- Forge script-injection permission probe"
			permissionProbe.Parent = Workspace
		end)
		permissionProbe:Destroy()
		if not allowed then error("Studio script-injection permission was not granted: " .. tostring(permissionError)) end

		self:cleanup(run)
		local channelName = "__ForgeStudioProofChannel_" .. string.gsub(HttpService:GenerateGUID(false), "-", "")
		local server = Instance.new("Script")
		server.Name = SERVER_NAME
		server.Source = run.harness.harness.serverSource(HttpService:JSONEncode(run.context), channelName)
		server.Parent = Workspace
		local client = Instance.new("LocalScript")
		client.Name = CLIENT_NAME
		client.Source = run.harness.harness.clientSource(channelName)
		client.Parent = starterPlayerScripts
		table.insert(run.injected, server)
		table.insert(run.injected, client)
	end)
	if not prepared then
		self:cleanup(run)
		self.active = nil
		error(tostring(prepareError))
	end

	run.phase = "running"
	local binding = run.binding
	local requestId = run.requestId
	self.send("PlaytestStarted", {
		projectId = binding.projectId, sessionId = binding.sessionId, project = binding.project,
		runId = binding.runId, testPlanId = binding.testPlanId, correlationId = binding.correlationId,
		projectSnapshotHash = binding.projectSnapshotHash, mechanicContractHash = binding.mechanicContractHash,
		nonceCommitment = binding.nonceCommitment, mode = "play_solo", playerCount = 1, control = "plugin_action",
	}, requestId)
	self.state("VERIFICATION RUNNING", "Play Solo is running in this Studio window.")

	task.spawn(function()
		local ok, returned, timedOut = executeWithDeadline(function()
			-- ExecutePlayModeAsync accepts test arguments, not execution options.
			-- Passing a `timeoutSeconds` key activated Studio's internal test-runner
			-- path on the target build and returned gameOutput/jestOutput before the
			-- Forge server harness could own EndTest. The outer deadline above owns
			-- timeout behavior; this argument is only a non-secret correlation hint.
			return StudioTestService:ExecutePlayModeAsync({
				forgeStudioProofRunId = binding.runId,
			})
		end, Constants.EXECUTION_DEADLINE_SECONDS + 15)
		if run.closed then return end

		self:cleanup(run)
		if not ok or typeof(returned) ~= "string" then
			local interrupted = not timedOut and typeof(returned) == "nil"
			local detail = if not ok
				then tostring(returned)
				else "ExecutePlayModeAsync returned " .. typeof(returned)
					.. (typeof(returned) == "table" and " (keys=" .. tableKeys(returned) .. ")" or "")
					.. " instead of the server evidence string"
			self.send("PluginError", {
				code = interrupted and "PLAYTEST_INTERRUPTED" or "STUDIO_FAILURE",
				message = string.sub(detail, 1, Constants.MAX_DIAGNOSTIC_CHARS),
				retryable = interrupted or timedOut,
			}, requestId)
			self.active = nil
			self.lastOutcome = (interrupted or timedOut) and "incomplete" or "rejected"
			if timedOut then
				self.blocked = true
				self.state("PLUGIN RELOAD REQUIRED", "Press Stop in Studio, then reload Forge before retrying.")
			elseif interrupted then
				self.state("VERIFICATION INCOMPLETE", "Play Solo stopped before the server returned authoritative evidence.")
			else
				self.state("VERIFICATION REJECTED", string.sub(detail, 1, Constants.MAX_DIAGNOSTIC_CHARS))
			end
			return
		end

		local decodedOk, envelope = pcall(function() return HttpService:JSONDecode(returned) end)
		if not decodedOk
			or typeof(envelope) ~= "table"
			or envelope.runId ~= run.payload.runId
			or envelope.testPlanId ~= run.payload.testPlanId
			or envelope.sessionId ~= run.payload.sessionId
			or envelope.projectSnapshotHash ~= run.payload.projectSnapshotHash
			or envelope.mechanicContractHash ~= run.payload.mechanicContractHash
			or envelope.nonce ~= run.nonce
			or envelope.nonceCommitment ~= run.commitment
			or Hash.sha256(envelope.nonce) ~= run.commitment
			or envelope.harnessId ~= run.harness.id
			or envelope.harnessVersion ~= run.harness.version
			or envelope.harnessHash ~= run.harness.hash
			or typeof(envelope.assertions) ~= "table"
			or not run.harness.harness.supportsResults(envelope.assertions)
		then
			self.send("PluginError", {
				code = "SECURITY_REJECTION",
				message = "Studio returned invalid or uncorrelated server evidence",
				retryable = false,
			}, requestId)
			self.active = nil
			self.lastOutcome = "rejected"
			self.state("VERIFICATION REJECTED", "Studio returned invalid or uncorrelated server evidence.")
			return
		end

		local resultDelivery = self.send("StudioTestResult", envelope, requestId)
		local stopDelivery = self.send("PlaytestStopped", {
			projectId = binding.projectId, sessionId = binding.sessionId, project = binding.project,
			runId = binding.runId, testPlanId = binding.testPlanId, correlationId = binding.correlationId,
			projectSnapshotHash = binding.projectSnapshotHash, mechanicContractHash = binding.mechanicContractHash,
			nonceCommitment = binding.nonceCommitment, mode = "play_solo", playerCount = 0, control = "plugin_action",
		}, requestId)
		self.active = nil
		self.lastOutcome = envelope.status == "completed" and "completed" or "rejected"
		if resultDelivery == nil or stopDelivery == nil then
			self.state("VERIFICATION REJECTED", "The bridge rejected authoritative evidence; Forge reported the exact rejection and will not commit.")
		elseif resultDelivery == false or stopDelivery == false then
			self.state("RESULT DELIVERY PENDING", "Authoritative evidence is queued for a transient bridge retry; Forge cannot commit until delivery succeeds.")
		else
			self.state(
				envelope.status == "completed" and "VERIFICATION RESULT RECEIVED" or "VERIFICATION REJECTED",
				envelope.status == "completed" and "Forge is finalizing the transaction." or "The authoritative server harness did not complete."
			)
		end
	end)
end

return StudioProofExecutor
