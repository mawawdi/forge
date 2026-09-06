--!strict
-- Ordinary reviewed server source. It trusts only server time, characters, and native scene anchors.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local shared = ReplicatedStorage:WaitForChild("LastLight")
local Config = require(shared:WaitForChild("Config"))

local action = Instance.new("RemoteEvent")
action.Name = "Action"
action.Parent = shared
local stateChanged = Instance.new("RemoteEvent")
stateChanged.Name = "StateChanged"
stateChanged.Parent = shared

type Phase = "menu" | "countdown" | "running" | "extracting" | "won" | "lost"
type HazardPhase = "rest" | "warning" | "active"
type Feedback =
	"none"
	| "carry"
	| "deposit"
	| "warning"
	| "impact"
	| "power_restored"
	| "extraction"
	| "failure"

type RoundState = {
	phase: Phase,
	phaseStartedAt: number,
	runDeadline: number,
	integrity: number,
	depositedCells: number,
	carryingCell: number?,
	collectedCells: { [number]: boolean },
	score: number,
	activeHazard: number?,
	hazardPhase: HazardPhase,
	hazardCycle: number,
	hitCycle: number?,
	extractionStartedAt: number?,
	feedback: Feedback,
	feedbackSerial: number,
	message: string,
	lastSentSecond: number?,
}

local rounds: { [Player]: RoundState } = {}
local anchors: { [string]: BasePart } = {}

local function findAnchor(name: string): BasePart?
	local cached = anchors[name]
	if cached and cached:IsDescendantOf(Workspace) then
		return cached
	end
	local instance = Workspace:FindFirstChild(name, true)
	if instance and instance:IsA("BasePart") then
		anchors[name] = instance
		return instance
	end
	return nil
end

local function rootPart(player: Player): BasePart?
	local character = player.Character
	if not character then
		return nil
	end
	local root = character:FindFirstChild("HumanoidRootPart")
	return if root and root:IsA("BasePart") then root else nil
end

local function isNear(player: Player, anchorName: string): boolean
	local root = rootPart(player)
	local anchor = findAnchor(anchorName)
	return root ~= nil
		and anchor ~= nil
		and (root.Position - anchor.Position).Magnitude <= Config.InteractionDistance
end

local function setFeedback(state: RoundState, feedback: Feedback, message: string)
	state.feedback = feedback
	state.feedbackSerial += 1
	state.message = message
end

local function publicState(state: RoundState, now: number)
	local countdown = if state.phase == "countdown"
		then math.max(0, Config.CountdownSeconds - (now - state.phaseStartedAt))
		else 0
	local remaining = if state.phase == "running" or state.phase == "extracting"
		then math.max(0, state.runDeadline - now)
		else Config.RoundSeconds
	local extractionProgress = if state.extractionStartedAt
		then math.clamp((now - state.extractionStartedAt) / Config.ExtractionSeconds, 0, 1)
		else 0
	return {
		phase = state.phase,
		countdownSeconds = math.ceil(countdown),
		remainingSeconds = math.ceil(remaining),
		integrity = state.integrity,
		depositedCells = state.depositedCells,
		carryingCell = state.carryingCell,
		score = state.score,
		activeHazard = state.activeHazard,
		hazardPhase = state.hazardPhase,
		extractionProgress = extractionProgress,
		feedback = state.feedback,
		feedbackSerial = state.feedbackSerial,
		message = state.message,
	}
end

local function send(player: Player, state: RoundState, now: number)
	stateChanged:FireClient(player, publicState(state, now))
end

local function newRound(now: number): RoundState
	return {
		phase = "countdown",
		phaseStartedAt = now,
		runDeadline = now + Config.CountdownSeconds + Config.RoundSeconds,
		integrity = Config.MaximumIntegrity,
		depositedCells = 0,
		carryingCell = nil,
		collectedCells = {},
		score = 0,
		activeHazard = nil,
		hazardPhase = "rest",
		hazardCycle = -1,
		hitCycle = nil,
		extractionStartedAt = nil,
		feedback = "none",
		feedbackSerial = 0,
		message = "Emergency power is failing. Stand by.",
		lastSentSecond = nil,
	}
end

local function lose(player: Player, state: RoundState, reason: string, now: number)
	if state.phase == "won" or state.phase == "lost" then
		return
	end
	state.phase = "lost"
	state.extractionStartedAt = nil
	setFeedback(state, "failure", reason)
	send(player, state, now)
end

local function beginRound(player: Player, now: number)
	local state = newRound(now)
	rounds[player] = state
	local spawn = findAnchor(Config.AnchorNames.Spawn)
	local character = player.Character
	if spawn and character then
		character:PivotTo(spawn.CFrame * CFrame.new(0, 3, 0))
	end
	send(player, state, now)
end

local function interact(player: Player, state: RoundState, now: number)
	if state.phase ~= "running" then
		return
	end
	if state.depositedCells == Config.RequiredCells and isNear(player, Config.AnchorNames.Extraction) then
		state.phase = "extracting"
		state.extractionStartedAt = now
		setFeedback(state, "extraction", "Hold the apron until launch lock completes.")
		send(player, state, now)
		return
	end
	if state.carryingCell and isNear(player, Config.AnchorNames.Deposit) then
		state.carryingCell = nil
		state.depositedCells += 1
		state.score += Config.DepositScore
		if state.depositedCells == Config.RequiredCells then
			setFeedback(state, "power_restored", "Reactor restored. Reach the shuttle.")
		else
			setFeedback(state, "deposit", string.format("Cell locked: %d/%d", state.depositedCells, Config.RequiredCells))
		end
		send(player, state, now)
		return
	end
	if state.carryingCell ~= nil then
		return
	end
	for index, anchorName in Config.AnchorNames.Cells do
		if not state.collectedCells[index] and isNear(player, anchorName) then
			state.collectedCells[index] = true
			state.carryingCell = index
			setFeedback(state, "carry", string.format("Power cell %d secured.", index))
			send(player, state, now)
			return
		end
	end
end

local function updateHazard(player: Player, state: RoundState, now: number)
	local elapsed = now - (state.phaseStartedAt + Config.CountdownSeconds)
	local cycleLength = Config.HazardRestSeconds + Config.HazardWarningSeconds + Config.HazardActiveSeconds
	local cycle = math.floor(math.max(0, elapsed) / cycleLength)
	local within = math.max(0, elapsed) % cycleLength
	local hazardIndex = cycle % #Config.AnchorNames.Hazards + 1
	local phase: HazardPhase = "rest"
	if within >= Config.HazardRestSeconds + Config.HazardWarningSeconds then
		phase = "active"
	elseif within >= Config.HazardRestSeconds then
		phase = "warning"
	end
	if cycle ~= state.hazardCycle or phase ~= state.hazardPhase then
		state.hazardCycle = cycle
		state.hazardPhase = phase
		state.activeHazard = if phase == "rest" then nil else hazardIndex
		if phase == "warning" then
			setFeedback(state, "warning", string.format("Conduit %d is surging.", hazardIndex))
		end
		send(player, state, now)
	end
	if phase == "active" and state.hitCycle ~= cycle and isNear(player, Config.AnchorNames.Hazards[hazardIndex]) then
		state.hitCycle = cycle
		state.integrity -= 1
		state.runDeadline -= Config.HazardTimePenalty
		setFeedback(state, "impact", string.format("Suit breach. -%ds", Config.HazardTimePenalty))
		if state.integrity <= 0 then
			lose(player, state, "Integrity lost in the conduit surge.", now)
		else
			send(player, state, now)
		end
	end
end

action.OnServerEvent:Connect(function(player: Player, intent: unknown)
	if typeof(intent) ~= "string" or #intent > 16 then
		return
	end
	local now = Workspace:GetServerTimeNow()
	local state = rounds[player]
	if intent == "start" or intent == "replay" then
		if not state or state.phase == "menu" or state.phase == "won" or state.phase == "lost" then
			beginRound(player, now)
		end
	elseif intent == "interact" and state then
		interact(player, state, now)
	end
end)

Players.PlayerAdded:Connect(function(player: Player)
	local state: RoundState = {
		phase = "menu",
		phaseStartedAt = 0,
		runDeadline = 0,
		integrity = Config.MaximumIntegrity,
		depositedCells = 0,
		carryingCell = nil,
		collectedCells = {},
		score = 0,
		activeHazard = nil,
		hazardPhase = "rest",
		hazardCycle = -1,
		hitCycle = nil,
		extractionStartedAt = nil,
		feedback = "none",
		feedbackSerial = 0,
		message = "Restore three cells and reach the shuttle before the light dies.",
		lastSentSecond = nil,
	}
	rounds[player] = state
	local function bindCharacter(character: Model)
		local humanoid = character:WaitForChild("Humanoid")
		if humanoid:IsA("Humanoid") then
			humanoid.Died:Connect(function()
				local current = rounds[player]
				if current then
					lose(player, current, "Your runner was lost before extraction.", Workspace:GetServerTimeNow())
				end
			end)
		end
	end
	player.CharacterAdded:Connect(bindCharacter)
	if player.Character then
		task.defer(bindCharacter, player.Character)
	end
	task.defer(function()
		send(player, state, Workspace:GetServerTimeNow())
	end)
end)

Players.PlayerRemoving:Connect(function(player: Player)
	rounds[player] = nil
end)

RunService.Heartbeat:Connect(function()
	local now = Workspace:GetServerTimeNow()
	for player, state in rounds do
		if state.phase == "countdown" and now - state.phaseStartedAt >= Config.CountdownSeconds then
			state.phase = "running"
			state.phaseStartedAt = now - Config.CountdownSeconds
			setFeedback(state, "none", "Recover a power cell.")
			send(player, state, now)
		elseif state.phase == "running" then
			if now >= state.runDeadline then
				lose(player, state, "Emergency power expired.", now)
			else
				updateHazard(player, state, now)
			end
		elseif state.phase == "extracting" then
			if now >= state.runDeadline then
				lose(player, state, "Emergency power expired during launch.", now)
			elseif not isNear(player, Config.AnchorNames.Extraction) then
				state.phase = "running"
				state.extractionStartedAt = nil
				setFeedback(state, "warning", "Launch lock interrupted.")
				send(player, state, now)
			elseif state.extractionStartedAt and now - state.extractionStartedAt >= Config.ExtractionSeconds then
				state.phase = "won"
				state.score += math.ceil(math.max(0, state.runDeadline - now)) * 5 + state.integrity * 250
				setFeedback(state, "extraction", "Shuttle clear. Last Light restored.")
				send(player, state, now)
			end
		end
		if state.phase == "countdown" or state.phase == "running" or state.phase == "extracting" then
			local second = if state.phase == "countdown"
				then math.ceil(math.max(0, Config.CountdownSeconds - (now - state.phaseStartedAt)))
				else math.ceil(math.max(0, state.runDeadline - now))
			if state.lastSentSecond ~= second then
				state.lastSentSecond = second
				send(player, state, now)
			end
		end
	end
end)
