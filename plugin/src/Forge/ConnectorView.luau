--!strict
local Presentation = require(script.Parent.ConnectorPresentation)

local ConnectorView = {}
export type View = {
	setStatus: (string, string) -> (),
	setConnection: (Presentation.ConnectionMode) -> (),
	setTestReady: (boolean) -> (),
	destroy: () -> (),
}

function ConnectorView.new(plugin: Plugin, options: {
	bridgeUrl: string, buildHash: string,
	onConnection: () -> (), onRunTest: () -> (),
}): View
	local TweenService = game:GetService("TweenService")
	local GuiService = game:GetService("GuiService")
	local UserInputService = game:GetService("UserInputService")
	local colors: {[string]: Color3} = {}
	for key, rgb in (Presentation.colors :: {[string]: {number}}) do colors[key] = Color3.fromRGB(rgb[1], rgb[2], rgb[3]) end
	local connections: {RBXScriptConnection} = {}
	local tweens: {[Instance]: Tween} = {}
	local reduceMotion = plugin:GetSetting("ForgeConnectorReducedMotion") == true
	local destroyed, focused, settingsOpen = false, false, false
	local currentCode, currentDetail = "CONNECTING", "Waiting for the local Forge service."
	local connectionMode: Presentation.ConnectionMode = "connecting"
	local testReady = false
	local pulse: Tween? = nil
	local pulseKey = ""
	local refreshMotion: (() -> ())? = nil
	local history: {string} = {}
	local selectedBeforeSettings: GuiObject? = nil

	local function connect(signal: any, callback: any)
		table.insert(connections, signal:Connect(callback))
	end
	local function create(className: string, properties: {[string]: any}, parent: Instance): any
		local node: any = Instance.new(className)
		for key, value in properties do node[key] = value end
		node.Parent = parent
		return node
	end
	local function corner(parent: Instance, radius: number)
		create("UICorner", { CornerRadius = UDim.new(0, radius) }, parent)
	end
	local function padding(parent: Instance, amount: number)
		create("UIPadding", { PaddingLeft = UDim.new(0, amount), PaddingRight = UDim.new(0, amount), PaddingTop = UDim.new(0, amount), PaddingBottom = UDim.new(0, amount) }, parent)
	end
	local function stack(parent: Instance, gap: number)
		create("UIListLayout", { Padding = UDim.new(0, gap), SortOrder = Enum.SortOrder.LayoutOrder }, parent)
	end
	local function frame(parent: Instance, name: string, order: number): any
		return create("Frame", { Name = name, LayoutOrder = order, BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.Y }, parent)
	end
	local function label(parent: Instance, name: string, text: string, size: number, color: Color3, order: number): any
		return create("TextLabel", { Name = name, LayoutOrder = order, BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, Font = Enum.Font.BuilderSans, TextSize = size, TextColor3 = color, Text = text, TextWrapped = true, TextXAlignment = Enum.TextXAlignment.Left, TextYAlignment = Enum.TextYAlignment.Top }, parent)
	end
	local function animate(node: any, properties: {[string]: any})
		if tweens[node] then tweens[node]:Cancel(); tweens[node] = nil end
		if destroyed or reduceMotion or GuiService.ReducedMotionEnabled then
			for key, value in properties do node[key] = value end
			return
		end
		local tween = TweenService:Create(node, TweenInfo.new(0.16, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), properties)
		tweens[node] = tween
		tween:Play()
	end
	local function button(parent: Instance, name: string, text: string, order: number, primary: boolean, action: () -> ()): any
		local base = primary and colors.accent or colors.surface
		local node = create("TextButton", { Name = name, LayoutOrder = order, Size = UDim2.new(1, 0, 0, 44), BackgroundColor3 = base, BorderSizePixel = 0, AutoButtonColor = false, Text = text, TextSize = 14, Font = Enum.Font.BuilderSansMedium, TextColor3 = primary and colors.accentInk or colors.text, TextWrapped = true, Selectable = true, SelectionOrder = order }, parent)
		corner(node, 10)
		local outline = create("UIStroke", { Color = primary and colors.accent or colors.line, Transparency = primary and 1 or 0, Thickness = 1, ApplyStrokeMode = Enum.ApplyStrokeMode.Border }, node)
		connect(node.MouseEnter, function() if node.Active then animate(node, { BackgroundColor3 = base:Lerp(colors.text, 0.07) }) end end)
		connect(node.MouseLeave, function() animate(node, { BackgroundColor3 = base }) end)
		connect(node.SelectionGained, function() outline.Color = colors.accent; outline.Transparency = 0; outline.Thickness = 2 end)
		connect(node.SelectionLost, function() outline.Color = primary and colors.accent or colors.line; outline.Transparency = primary and 1 or 0; outline.Thickness = 1 end)
		connect(node.Activated, function() if node.Active and not destroyed then action() end end)
		return node
	end
	local function enabled(node: any, active: boolean)
		node.Active = active
		node.Selectable = active
		node.TextTransparency = active and 0 or 0.45
	end
	local function readOnly(parent: Instance, name: string, text: string, order: number, height: number): any
		local node = create("TextBox", { Name = name, LayoutOrder = order, Size = UDim2.new(1, 0, 0, height), BackgroundColor3 = colors.inset, BorderSizePixel = 0, Font = Enum.Font.Code, TextSize = 12, TextColor3 = colors.muted, Text = text, TextEditable = false, ClearTextOnFocus = false, MultiLine = true, TextWrapped = true, TextXAlignment = Enum.TextXAlignment.Left, TextYAlignment = Enum.TextYAlignment.Top }, parent)
		corner(node, 8); padding(node, 12)
		connect(node.Focused, function()
			task.defer(function() if not destroyed then node.CursorPosition = #node.Text + 1; node.SelectionStart = 1 end end)
		end)
		return node
	end

	local widget = plugin:CreateDockWidgetPluginGuiAsync("ForgeStudio", DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, true, false, 380, 510, 280, 300))
	widget.Title = "Forge"
	widget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	local toolbar = plugin:CreateToolbar("Forge")
	local toolbarButton = toolbar:CreateButton("ForgeWorkspace", "Show or hide Forge", "", "Forge")
	toolbarButton.ClickableWhenViewportHidden = true
	connect(toolbarButton.Click, function() widget.Enabled = not widget.Enabled end)
	connect(widget:GetPropertyChangedSignal("Enabled"), function() toolbarButton:SetActive(widget.Enabled) end)
	toolbarButton:SetActive(widget.Enabled)
	widget:BindToClose(function() widget.Enabled = false end)
	connect(widget.WindowFocused, function() focused = true end)
	connect(widget.WindowFocusReleased, function() focused = false end)

	local root = create("Frame", { Name = "ForgeWorkspace", Size = UDim2.fromScale(1, 1), BackgroundColor3 = colors.canvas, BorderSizePixel = 0 }, widget)
	local header = create("Frame", { Name = "Header", Size = UDim2.new(1, 0, 0, 64), BackgroundTransparency = 1 }, root)
	local mark = create("TextLabel", { Name = "ForgeMark", Position = UDim2.fromOffset(20, 18), Size = UDim2.fromOffset(29, 29), BackgroundColor3 = colors.surface, BorderSizePixel = 0, Text = "F", Font = Enum.Font.BuilderSansBold, TextSize = 19, TextColor3 = colors.accent }, header)
	corner(mark, 9)
	create("TextLabel", { Position = UDim2.fromOffset(60, 14), Size = UDim2.new(1, -158, 0, 23), BackgroundTransparency = 1, Text = "Forge", TextSize = 18, Font = Enum.Font.BuilderSansBold, TextColor3 = colors.text, TextXAlignment = Enum.TextXAlignment.Left }, header)
	create("TextLabel", { Position = UDim2.fromOffset(60, 37), Size = UDim2.new(1, -158, 0, 16), BackgroundTransparency = 1, Text = "Studio", TextSize = 11, Font = Enum.Font.BuilderSans, TextColor3 = colors.muted, TextXAlignment = Enum.TextXAlignment.Left }, header)
	local scroll = create("ScrollingFrame", { Name = "WorkspaceContent", Position = UDim2.fromOffset(0, 64), Size = UDim2.new(1, 0, 1, -64), BackgroundTransparency = 1, BorderSizePixel = 0, ScrollBarThickness = 3, ScrollBarImageColor3 = colors.line, CanvasSize = UDim2.new(), AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollingDirection = Enum.ScrollingDirection.Y }, root)
	padding(scroll, 20)
	local content = frame(scroll, "Content", 1); stack(content, 18)
	local project = frame(content, "Project", 1); stack(project, 7)
	local projectName = label(project, "ProjectName", game.Name, 15, colors.text, 1)
	projectName.Font = Enum.Font.BuilderSansMedium
	connect(game:GetPropertyChangedSignal("Name"), function() projectName.Text = game.Name end)
	local connectionRow = create("Frame", { Name = "Connection", LayoutOrder = 2, Size = UDim2.new(1, 0, 0, 20), BackgroundTransparency = 1 }, project)
	local dot = create("Frame", { Position = UDim2.fromOffset(0, 7), Size = UDim2.fromOffset(6, 6), BackgroundColor3 = colors.muted, BorderSizePixel = 0 }, connectionRow); corner(dot, 3)
	local connectionLabel = label(connectionRow, "ConnectionLabel", "Connecting", 12, colors.muted, 1)
	connectionLabel.Position = UDim2.fromOffset(14, 1); connectionLabel.Size = UDim2.new(1, -14, 0, 18); connectionLabel.AutomaticSize = Enum.AutomaticSize.None
	local statusCard = frame(content, "CurrentActivity", 2)
	statusCard.BackgroundColor3 = colors.surface; statusCard.BackgroundTransparency = 0; statusCard.BorderSizePixel = 0
	corner(statusCard, 14); padding(statusCard, 18); stack(statusCard, 10)
	local statusTitle = label(statusCard, "StatusTitle", "", 23, colors.text, 1); statusTitle.Font = Enum.Font.BuilderSansMedium
	local statusDescription = label(statusCard, "StatusDescription", "", 14, colors.muted, 2)
	local primary = button(content, "Connect", "Connect", 3, true, options.onConnection)
	local run = button(content, "RunApprovedTest", "Run approved test", 4, true, options.onRunTest); run.Visible = false
	local setup = frame(content, "SetupHelp", 5); stack(setup, 9)
	label(setup, "SetupTitle", "In your Forge project folder, run:", 12, colors.muted, 1)
	readOnly(setup, "StartCommand", "node bin/forge.js creator serve", 2, 58)
	label(setup, "DashboardHelp", "Open the dashboard link printed in that terminal. Your projects and conversations live there.", 12, colors.muted, 3)
	local activity = frame(content, "RecentActivity", 6); stack(activity, 9)
	label(activity, "ActivityLabel", "Recent activity", 12, colors.muted, 1)
	local activityRows = {}
	for index = 1, 3 do activityRows[index] = label(activity, "Step" .. index, "", 13, colors.muted, index + 1) end

	local overlay = create("TextButton", { Name = "SettingsBackdrop", Visible = false, Size = UDim2.fromScale(1, 1), ZIndex = 20, BackgroundColor3 = colors.inset, BackgroundTransparency = 0.15, BorderSizePixel = 0, Text = "", AutoButtonColor = false, Selectable = false }, root)
	local dialog = create("Frame", { Name = "Settings", Position = UDim2.fromOffset(10, 10), Size = UDim2.new(1, -20, 1, -20), BackgroundColor3 = colors.canvas, BorderSizePixel = 0, Active = true }, overlay)
	corner(dialog, 16)
	create("UIStroke", { Color = colors.line, Thickness = 1 }, dialog)
	local scale = create("UIScale", { Scale = 1 }, dialog)
	local dialogHeader = create("Frame", { Name = "SettingsHeader", Size = UDim2.new(1, 0, 0, 58), BackgroundTransparency = 1 }, dialog)
	local settingsTitle = label(dialogHeader, "SettingsTitle", "Settings", 19, colors.text, 1)
	settingsTitle.Position = UDim2.fromOffset(18, 20); settingsTitle.Size = UDim2.new(1, -80, 0, 26)
	local tabs = create("Frame", { Name = "SettingsTabs", Position = UDim2.fromOffset(14, 60), Size = UDim2.new(1, -28, 0, 44), BackgroundTransparency = 1 }, dialog)
	local body = create("ScrollingFrame", { Name = "SettingsContent", Position = UDim2.fromOffset(0, 116), Size = UDim2.new(1, 0, 1, -116), BackgroundTransparency = 1, BorderSizePixel = 0, ScrollBarThickness = 3, ScrollBarImageColor3 = colors.line, CanvasSize = UDim2.new(), AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollingDirection = Enum.ScrollingDirection.Y }, dialog)
	padding(body, 18)
	local connectionPanel = frame(body, "ConnectionPanel", 1); stack(connectionPanel, 14)
	label(connectionPanel, "ConnectionHeading", "Studio connection", 15, colors.text, 1)
	label(connectionPanel, "ConnectionHelp", "Forge connects to a service on this computer.", 13, colors.muted, 2)
	readOnly(connectionPanel, "BridgeAddress", options.bridgeUrl, 3, 52)
	local connectionButton = button(connectionPanel, "ConnectionAction", "Connect", 4, false, options.onConnection)
	label(connectionPanel, "MotionHeading", "Appearance", 15, colors.text, 5)
	local motionButton: any
	motionButton = button(connectionPanel, "Motion", "", 6, false, function()
		reduceMotion = not reduceMotion
		plugin:SetSetting("ForgeConnectorReducedMotion", reduceMotion)
		motionButton.Text = reduceMotion and "Motion: reduced" or "Motion: system"
		if reduceMotion then
			for _, tween in tweens do tween:Cancel() end
			table.clear(tweens); scale.Scale = 1
		end
		if refreshMotion then refreshMotion() end
	end)
	motionButton.Text = reduceMotion and "Motion: reduced" or "Motion: system"
	label(connectionPanel, "MotionHelp", "System mode follows your accessibility preference.", 12, colors.muted, 7)
	local detailPanel = frame(body, "DetailsPanel", 1); stack(detailPanel, 12); detailPanel.Visible = false
	label(detailPanel, "DetailsHeading", "Connection details", 15, colors.text, 1)
	label(detailPanel, "DetailsHelp", "Select the text to copy it when reporting a problem.", 12, colors.muted, 2)
	local diagnostics = readOnly(detailPanel, "Diagnostics", "", 3, 290)
	diagnostics.AutomaticSize = Enum.AutomaticSize.Y
	create("UISizeConstraint", { MinSize = Vector2.new(0, 290) }, diagnostics)
	local connectionTab: any
	local detailsTab: any
	local function selectTab(name: string)
		local isConnection = name == "Connection"
		connectionPanel.Visible = isConnection; detailPanel.Visible = not isConnection
		connectionTab.TextColor3 = isConnection and colors.accent or colors.muted
		detailsTab.TextColor3 = isConnection and colors.muted or colors.accent
		body.CanvasPosition = Vector2.zero
	end
	connectionTab = button(tabs, "ConnectionTab", "Connection", 1, false, function() selectTab("Connection") end)
	connectionTab.Size = UDim2.new(0.5, -4, 1, 0)
	detailsTab = button(tabs, "DetailsTab", "Details", 2, false, function() selectTab("Details") end)
	detailsTab.Position = UDim2.new(0.5, 4, 0, 0); detailsTab.Size = UDim2.new(0.5, -4, 1, 0)
	local closeButton: any
	local function closeSettings()
		settingsOpen = false; overlay.Visible = false; scroll.Visible = true; header.Visible = true
		if selectedBeforeSettings and selectedBeforeSettings.Parent then GuiService.SelectedObject = selectedBeforeSettings end
	end
	closeButton = button(dialogHeader, "CloseSettings", "×", 9, false, closeSettings)
	closeButton.Position = UDim2.new(1, -54, 0, 8); closeButton.Size = UDim2.fromOffset(44, 44)
	local function openSettings(tab: string)
		selectedBeforeSettings = GuiService.SelectedObject
		settingsOpen = true; overlay.Visible = true; scroll.Visible = false; header.Visible = false
		selectTab(tab)
		GuiService.SelectedObject = closeButton
		scale.Scale = (reduceMotion or GuiService.ReducedMotionEnabled) and 1 or 0.985
		animate(scale, { Scale = 1 })
	end
	connect(overlay.Activated, closeSettings)
	connect(UserInputService.InputBegan, function(input: InputObject)
		if focused and settingsOpen and input.KeyCode == Enum.KeyCode.Escape then closeSettings() end
	end)
	local settingsButton = button(header, "OpenSettings", "Settings", 1, false, function() openSettings("Connection") end)
	settingsButton.Position = UDim2.new(1, -100, 0, 10); settingsButton.Size = UDim2.fromOffset(82, 44)
	button(content, "OpenDetails", "Details", 7, false, function() openSettings("Details") end)
	label(content, "Footer", "Keep Forge running while you work.", 12, colors.muted, 8)
	refreshMotion = function()
		local shouldPulse = widget.Enabled and not settingsOpen and Presentation.status(currentCode).working and not reduceMotion and not GuiService.ReducedMotionEnabled
		local key = tostring(shouldPulse)
		if key == pulseKey then return end
		pulseKey = key
		if pulse then pulse:Cancel(); pulse = nil end
		dot.BackgroundTransparency = 0
		if shouldPulse then
			pulse = TweenService:Create(dot, TweenInfo.new(0.9, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { BackgroundTransparency = 0.65 })
			if pulse then pulse:Play() end
		end
	end
	connect(widget:GetPropertyChangedSignal("Enabled"), refreshMotion)
	connect(GuiService:GetPropertyChangedSignal("ReducedMotionEnabled"), refreshMotion)
	connect(overlay:GetPropertyChangedSignal("Visible"), refreshMotion)

	local function render()
		if destroyed then return end
		local status = Presentation.status(currentCode)
		local connection = Presentation.connection(connectionMode)
		statusTitle.Text = status.title; statusDescription.Text = status.description
		local connectionText = connection.label
		if currentCode == "BRIDGE UNREACHABLE" then connectionText = "Reconnecting"
		elseif currentCode == "WAITING FOR BRIDGE" then connectionText = "Waiting for Forge"
		elseif currentCode == "CONNECTION REJECTED" then connectionText = "Connection needs attention" end
		connectionLabel.Text = connectionText
		animate(dot, { BackgroundColor3 = colors[status.tone] })
		primary.Text = connection.action; primary.Visible = connection.showPrimary; enabled(primary, connection.enabled)
		connectionButton.Text = connection.action; enabled(connectionButton, connection.enabled)
		run.Visible = testReady; enabled(run, testReady)
		setup.Visible = connectionMode == "disconnected" or currentCode == "WAITING FOR BRIDGE"
		activity.Visible = #history > 0
		for index, row in activityRows do row.Visible = history[index] ~= nil; row.Text = history[index] and "·  " .. history[index] or "" end
		diagnostics.Text = "Status: " .. currentCode .. "\n\n" .. currentDetail .. "\n\nService: " .. options.bridgeUrl .. "\n\nConnector: " .. options.buildHash
		if refreshMotion then refreshMotion() end
	end
	selectTab("Connection"); render()
	return {
		setStatus = function(code: string, detail: string)
			if destroyed then return end
			local status = Presentation.status(code)
			if code ~= currentCode and status.record and history[1] ~= status.title then
				table.insert(history, 1, status.title)
				while #history > 3 do table.remove(history) end
			end
			currentCode, currentDetail = code, string.sub(detail, 1, 4096)
			render()
		end,
		setConnection = function(mode: Presentation.ConnectionMode) connectionMode = mode; render() end,
		setTestReady = function(ready: boolean) testReady = ready; render() end,
		destroy = function()
			if destroyed then return end
			destroyed = true
			if pulse then pulse:Cancel(); pulse = nil end
			for _, connection in connections do connection:Disconnect() end
			for _, tween in tweens do tween:Cancel() end
			table.clear(connections); table.clear(tweens)
			widget:Destroy(); toolbar:Destroy()
		end,
	}
end

return ConnectorView
