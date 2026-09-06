--!strict
-- Responsive presentation and bounded intent forwarding; gameplay state remains server-owned.
local ContextActionService = game:GetService("ContextActionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local player = Players.LocalPlayer
local shared = ReplicatedStorage:WaitForChild("LastLight")
local action = shared:WaitForChild("Action") :: RemoteEvent
local stateChanged = shared:WaitForChild("StateChanged") :: RemoteEvent

local screen = Instance.new("ScreenGui")
screen.Name = "LastLightHUD"
screen.ResetOnSpawn = false
screen.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets
screen.ClipToDeviceSafeArea = true
screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
screen.Parent = player:WaitForChild("PlayerGui")

local function corner(parent: Instance, radius: number)
	local value = Instance.new("UICorner")
	value.CornerRadius = UDim.new(0, radius)
	value.Parent = parent
end

local function stroke(parent: Instance, color: Color3, thickness: number)
	local value = Instance.new("UIStroke")
	value.Color = color
	value.Thickness = thickness
	value.Transparency = 0.18
	value.Parent = parent
end

local function label(name: string, parent: Instance, size: UDim2, position: UDim2, textSize: number): TextLabel
	local value = Instance.new("TextLabel")
	value.Name = name
	value.BackgroundTransparency = 1
	value.Size = size
	value.Position = position
	value.FontFace = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.SemiBold)
	value.TextColor3 = Color3.fromRGB(224, 238, 242)
	value.TextSize = textSize
	value.TextWrapped = true
	value.Parent = parent
	return value
end

local top = Instance.new("Frame")
top.Name = "MissionStatus"
top.AnchorPoint = Vector2.new(0.5, 0)
top.Position = UDim2.new(0.5, 0, 0, 16)
top.Size = UDim2.new(0.72, 0, 0, 82)
top.BackgroundColor3 = Color3.fromRGB(9, 17, 23)
top.BackgroundTransparency = 0.08
top.Parent = screen
corner(top, 14)
stroke(top, Color3.fromRGB(40, 214, 224), 2)
local topConstraint = Instance.new("UISizeConstraint")
topConstraint.MinSize = Vector2.new(280, 82)
topConstraint.MaxSize = Vector2.new(820, 82)
topConstraint.Parent = top

local timer = label("Timer", top, UDim2.new(0.28, 0, 0, 38), UDim2.new(0, 14, 0, 8), 28)
timer.TextXAlignment = Enum.TextXAlignment.Left
local mission = label("Mission", top, UDim2.new(0.66, -16, 0, 38), UDim2.new(0.34, 0, 0, 8), 18)
mission.TextXAlignment = Enum.TextXAlignment.Right
local integrity = label("Integrity", top, UDim2.new(0.45, 0, 0, 24), UDim2.new(0, 14, 0, 50), 15)
integrity.TextXAlignment = Enum.TextXAlignment.Left
local score = label("Score", top, UDim2.new(0.45, -14, 0, 24), UDim2.new(0.55, 0, 0, 50), 15)
score.TextXAlignment = Enum.TextXAlignment.Right

local feedback = label("Feedback", screen, UDim2.new(0.72, 0, 0, 54), UDim2.new(0.14, 0, 0.72, 0), 20)
feedback.BackgroundTransparency = 0.08
feedback.BackgroundColor3 = Color3.fromRGB(9, 17, 23)
feedback.AnchorPoint = Vector2.new(0, 0.5)
corner(feedback, 12)
stroke(feedback, Color3.fromRGB(40, 214, 224), 2)

local interact = Instance.new("TextButton")
interact.Name = "PrimaryAction"
interact.AnchorPoint = Vector2.new(1, 1)
interact.Position = UDim2.new(1, -20, 1, -20)
interact.Size = UDim2.fromOffset(172, 56)
interact.BackgroundColor3 = Color3.fromRGB(232, 155, 44)
interact.TextColor3 = Color3.fromRGB(15, 18, 20)
interact.Text = "INTERACT  [E / X]"
interact.TextSize = 17
interact.FontFace = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.Bold)
interact.Parent = screen
corner(interact, 14)
stroke(interact, Color3.fromRGB(255, 224, 165), 2)

local overlay = Instance.new("Frame")
overlay.Name = "MenuAndResult"
overlay.Size = UDim2.fromScale(1, 1)
overlay.BackgroundColor3 = Color3.fromRGB(3, 7, 11)
overlay.BackgroundTransparency = 0.18
overlay.Parent = screen
local card = Instance.new("Frame")
card.AnchorPoint = Vector2.new(0.5, 0.5)
card.Position = UDim2.fromScale(0.5, 0.5)
card.Size = UDim2.new(0.78, 0, 0, 330)
card.BackgroundColor3 = Color3.fromRGB(9, 17, 23)
card.Parent = overlay
corner(card, 20)
stroke(card, Color3.fromRGB(40, 214, 224), 2)
local cardConstraint = Instance.new("UISizeConstraint")
cardConstraint.MinSize = Vector2.new(288, 300)
cardConstraint.MaxSize = Vector2.new(620, 350)
cardConstraint.Parent = card
local title = label("Title", card, UDim2.new(1, -40, 0, 64), UDim2.new(0, 20, 0, 28), 36)
title.Text = "LAST LIGHT"
local result = label("Result", card, UDim2.new(1, -48, 0, 130), UDim2.new(0, 24, 0, 100), 19)
result.Text = "Restore three power cells. Survive the conduits. Reach the shuttle in 120 seconds."
local start = Instance.new("TextButton")
start.Name = "StartOrReplay"
start.AnchorPoint = Vector2.new(0.5, 1)
start.Position = UDim2.new(0.5, 0, 1, -28)
start.Size = UDim2.new(0.72, 0, 0, 56)
start.BackgroundColor3 = Color3.fromRGB(232, 155, 44)
start.TextColor3 = Color3.fromRGB(15, 18, 20)
start.Text = "BEGIN RUN"
start.TextSize = 19
start.FontFace = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.Bold)
start.Parent = card
corner(start, 14)
stroke(start, Color3.fromRGB(255, 224, 165), 2)

local latestPhase = "menu"
local lastFeedbackSerial = -1

local function fireIntent(intent: string)
	action:FireServer(intent)
end

interact.Activated:Connect(function()
	fireIntent("interact")
end)
start.Activated:Connect(function()
	fireIntent(if latestPhase == "menu" then "start" else "replay")
end)

ContextActionService:BindAction("LastLightInteract", function(_, inputState)
	if inputState == Enum.UserInputState.Begin then
		fireIntent("interact")
	end
	return Enum.ContextActionResult.Sink
end, false, Enum.KeyCode.E, Enum.KeyCode.ButtonX)

ContextActionService:BindAction("LastLightReplay", function(_, inputState)
	if inputState == Enum.UserInputState.Begin and (latestPhase == "won" or latestPhase == "lost") then
		fireIntent("replay")
	end
	return Enum.ContextActionResult.Sink
end, false, Enum.KeyCode.R, Enum.KeyCode.ButtonY)

local feedbackColors = {
	none = Color3.fromRGB(40, 214, 224),
	carry = Color3.fromRGB(232, 155, 44),
	deposit = Color3.fromRGB(58, 230, 158),
	warning = Color3.fromRGB(255, 179, 55),
	impact = Color3.fromRGB(255, 64, 58),
	power_restored = Color3.fromRGB(80, 236, 255),
	extraction = Color3.fromRGB(130, 163, 255),
	failure = Color3.fromRGB(255, 64, 58),
}

stateChanged.OnClientEvent:Connect(function(state)
	if typeof(state) ~= "table" or typeof(state.phase) ~= "string" then
		return
	end
	latestPhase = state.phase
	timer.Text = string.format("%03d SEC", math.max(0, state.remainingSeconds or 0))
	mission.Text = string.format("CELLS %d/3%s", state.depositedCells or 0, if state.carryingCell then "  •  CARRYING" else "")
	integrity.Text = string.format("INTEGRITY  %d/2", state.integrity or 0)
	score.Text = string.format("SCORE  %04d", state.score or 0)
	feedback.Text = tostring(state.message or "")
	interact.Visible = state.phase == "running"
	overlay.Visible = state.phase == "menu" or state.phase == "countdown" or state.phase == "won" or state.phase == "lost"
	if state.phase == "countdown" then
		title.Text = tostring(math.max(1, state.countdownSeconds or 1))
		result.Text = "Emergency sequence armed."
		start.Visible = false
	elseif state.phase == "won" then
		title.Text = "LIGHT RESTORED"
		result.Text = string.format("Extraction complete\nFinal score: %d", state.score or 0)
		start.Text = "RUN AGAIN  [R / Y]"
		start.Visible = true
	elseif state.phase == "lost" then
		title.Text = "STATION DARK"
		result.Text = tostring(state.message or "Run failed")
		start.Text = "TRY AGAIN  [R / Y]"
		start.Visible = true
	elseif state.phase == "menu" then
		title.Text = "LAST LIGHT"
		result.Text = "Restore three power cells. Survive the conduits. Reach the shuttle in 120 seconds."
		start.Text = "BEGIN RUN"
		start.Visible = true
	end
	if typeof(state.feedbackSerial) == "number" and state.feedbackSerial ~= lastFeedbackSerial then
		lastFeedbackSerial = state.feedbackSerial
		local color = feedbackColors[state.feedback] or feedbackColors.none
		feedback.BackgroundColor3 = color
		feedback.BackgroundTransparency = 0.12
		TweenService:Create(feedback, TweenInfo.new(0.45), {
			BackgroundColor3 = Color3.fromRGB(9, 17, 23),
			BackgroundTransparency = 0.08,
		}):Play()
	end
end)
