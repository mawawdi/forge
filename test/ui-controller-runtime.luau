-- Fixed offline contract fixture. Fake Instances/signals/tweens are not native evidence.
local env = require("./UiEnvironment")
local Controller = require("./Controller")
local gui = env.gui
local function equal(actual, expected)
  assert(actual == expected, tostring(actual) .. " ~= " .. tostring(expected))
end
local function fails(callback)
  assert(not pcall(callback), "Expected rejection")
end
local count = 0
local function test(name, callback)
  env.reset()
  callback()
  count += 1
  print("PASS " .. name)
end
local function scene()
  local root = env.root()
  local group = env.node(root, "group", "CanvasGroup", {UiTransparencyState = "fade", UiMotionSeconds = 0.2})
  local label = env.node(group, "label", "TextLabel", {UiTextState = "label"})
  local button = env.node(group, "button", "TextButton", {UiAction = "activate", UiEnabledState = "enabled", UiVisibleState = "shown"})
  return root, group, label, button
end
local function state(label, enabled, shown, fade)
  return {label = label or "Ready", enabled = enabled ~= false, shown = shown ~= false, fade = fade or 0}
end
local function styleButton(button)
  button.attributes.UiInteractionStyle = true
  for index, name in {"Base", "Hover", "Pressed", "Focused", "Disabled"} do
    button.attributes["Ui" .. name .. "Background"] = index * 65536
    button.attributes["Ui" .. name .. "Foreground"] = 16777215
  end
  local ring = env.node(button, "FocusRing", "UIStroke")
  ring.attributes.UiNodeId = nil
  ring.Enabled = false
  return ring
end
local function buttonsScene(amount)
  local root = env.root()
  local buttons, rings = {}, {}
  for index = 1, amount do
    local button = env.node(root, "button-" .. tostring(index), "TextButton", {UiEnabledState = "enabled"})
    table.insert(buttons, button)
    table.insert(rings, styleButton(button))
  end
  return root, buttons, rings
end
local function total(counters)
  local result = 0
  for _, amount in counters do result += amount end
  return result
end

test("mount/update validates complete state before rendering", function()
  local root, _, label, button = scene()
  local handle = Controller.Mount(root, state(), {activate = function() end})
  equal(label.Text, "Ready")
  handle:Update(state("Changed", false))
  equal(label.Text, "Changed")
  equal(button.Interactable, false)
  equal(button.Selectable, false)
  fails(function() handle:Update({label = "Partial", enabled = true, shown = true, fade = 3}) end)
  equal(label.Text, "Changed")
  fails(function() handle:Update({label = "Partial"}) end)
  fails(function() handle:Update({label = "Partial", enabled = true, shown = true, fade = 0, unknown = true}) end)
  fails(function() handle:Update(state(string.rep("x", 4097))) end)
  equal(#handle:Unmount(), 0)
end)

test("failed validation creates no connections or partial mount", function()
  local root = scene()
  root.attributes.UiGraphAbi = "0"
  fails(function() Controller.Mount(root, state(), {activate = function() end}) end)
  fails(function() Controller.Observe(root) end)
  equal(env.connected(), 0)
  root.attributes.UiGraphAbi = "1"
  fails(function() Controller.Mount(root, state(), {}) end)
  equal(env.connected(), 0)
  fails(function() Controller.Mount(root, {}, {activate = function() end}) end)
  equal(env.connected(), 0)
  local handle = Controller.Mount(root, state(), {activate = function() end})
  fails(function() Controller.Mount(root, state(), {activate = function() end}) end)
  handle:Unmount()
  equal(env.connected(), 0)
end)

test("actions check current root visibility and enabled state", function()
  local root, group, _, button = scene()
  local calls = 0
  local handle = Controller.Mount(root, state(), {activate = function(target) equal(target, button); calls += 1 end})
  button.Activated:Fire()
  equal(calls, 1)
  group.Visible = false
  button.Activated:Fire()
  group.Visible = true
  handle:Update(state("Ready", false))
  button.Activated:Fire()
  handle:Update(state())
  button.GuiState = env.Enum.GuiState.NonInteractable
  button.Activated:Fire()
  equal(handle:Focus("button"), false)
  button.GuiState = env.Enum.GuiState.Idle
  root.Enabled = false
  button.Activated:Fire()
  equal(calls, 1)
  handle:Unmount()
end)

test("unmount invalidates queued callbacks and permits independent remount", function()
  local root, _, _, button = scene()
  local calls = 0
  local handle = Controller.Mount(root, state(), {activate = function() calls += 1 end})
  local queued = button.Activated.listeners[1].callback
  equal(#handle:Unmount(), 0)
  equal(#handle:Unmount(), 0)
  queued()
  equal(calls, 0)
  equal(env.connected(), 0)
  fails(function() handle:Update(state()) end)
  local nextHandle = Controller.Mount(root, state(), {activate = function() calls += 2 end})
  queued()
  button.Activated:Fire()
  equal(calls, 2)
  nextHandle:Unmount()
end)

test("root destruction and removal of owned nodes close the controller", function()
  local root, _, _, button = scene()
  local handle = Controller.Mount(root, state(), {activate = function() error("stale") end})
  root.DescendantRemoving:Fire(button)
  button.Parent = nil
  equal(env.connected(), 0)
  fails(function() handle:Update(state()) end)
  local second = scene()
  local secondHandle = Controller.Mount(second, state(), {activate = function() end})
  second.Destroying:Fire()
  equal(env.connected(), 0)
  fails(function() secondHandle:Focus("button") end)
end)

test("rapid group updates cancel tweens and reduced motion snaps to latest target", function()
  local root, group = scene()
  local handle = Controller.Mount(root, state("Ready", true, true, 0.2), {activate = function() end})
  equal(group.GroupTransparency, 0.2)
  equal(#env.tweens, 0)
  handle:Update(state("Ready", true, true, 0.4))
  local first = env.tweens[1]
  handle:Update(state("Ready", true, true, 0.8))
  equal(first.cancelled, true)
  local second = env.tweens[2]
  handle:Update(state("Text change", true, true, 0.8))
  equal(#env.tweens, 2)
  gui.ReducedMotionEnabled = true
  gui:GetPropertyChangedSignal("ReducedMotionEnabled"):Fire()
  equal(second.cancelled, true)
  equal(group.GroupTransparency, 0.8)
  handle:Update(state("Ready", true, true, 0.4))
  equal(group.GroupTransparency, 0.4)
  equal(#env.tweens, 2)
  handle:Unmount()
end)

test("transparency preferences update declared bases and disconnect", function()
  local root, _, label = scene()
  label.attributes.UiBackgroundTransparency = 0.8
  gui.PreferredTransparency = 0.5
  local handle = Controller.Mount(root, state(), {activate = function() end})
  equal(label.BackgroundTransparency, 0.4)
  gui.PreferredTransparency = 0
  gui:GetPropertyChangedSignal("PreferredTransparency"):Fire()
  equal(label.BackgroundTransparency, 0)
  handle:Unmount()
  gui.PreferredTransparency = 1
  gui:GetPropertyChangedSignal("PreferredTransparency"):Fire()
  equal(label.BackgroundTransparency, 0)
end)

test("explicit focus restores previous selection without stealing external focus", function()
  local root, _, _, button = scene()
  local previous = env.node(env.root(), "outside", "TextButton")
  gui.SelectedObject = previous
  local handle = Controller.Mount(root, state(), {activate = function() end})
  equal(gui.SelectedObject, previous)
  equal(handle:Focus("button"), true)
  equal(gui.SelectedObject, button)
  handle:Update(state("Ready", false))
  equal(gui.SelectedObject, previous)
  handle:Update(state())
  handle:Focus("button")
  local external = env.node(env.root(), "another", "TextButton")
  gui.SelectedObject = external
  handle:Unmount()
  equal(gui.SelectedObject, external)
end)

test("cleanup errors do not prevent remaining disposal", function()
  local root, _, _, button = scene()
  local handle = Controller.Mount(root, state(), {activate = function() end})
  button.Activated.failDisconnect = true
  local errors = handle:Unmount()
  equal(#errors, 1)
  equal(env.connected(), 0)
  equal(#handle:Unmount(), 1)
end)

test("engine-selected controls lose focus when hidden or unmounted", function()
  local root, _, _, button = scene()
  local handle = Controller.Mount(root, state(), {activate = function() end})
  gui.SelectedObject = button
  handle:Update(state("Ready", true, false))
  equal(gui.SelectedObject, nil)
  handle:Update(state())
  gui.SelectedObject = button
  handle:Unmount()
  equal(gui.SelectedObject, nil)
end)

test("partial connection failure unwinds mount and allows retry", function()
  local root = scene()
  root.Destroying.failConnect = true
  fails(function() Controller.Mount(root, state(), {activate = function() end}) end)
  equal(env.connected(), 0)
  root.Destroying.failConnect = false
  Controller.Mount(root, state(), {activate = function() end}):Unmount()
end)

test("separate roots with the same local IDs retain independent state", function()
  local first, _, firstLabel = scene()
  local second, _, secondLabel = scene()
  local a = Controller.Mount(first, state("A"), {activate = function() end})
  local b = Controller.Mount(second, state("B"), {activate = function() end})
  a:Update(state("Changed"))
  equal(firstLabel.Text, "Changed")
  equal(secondLabel.Text, "B")
  a:Unmount()
  b:Update(state("Still mounted"))
  equal(secondLabel.Text, "Still mounted")
  b:Unmount()
end)

test("client observations report current native fields without mounting or writing layout", function()
  local root = env.root()
  local scroll = env.node(root, "list", "ScrollingFrame")
  local label = env.node(scroll, "description", "TextLabel")
  local button = env.node(scroll, "action", "TextButton")
  label.TextFits = false
  label.TextBounds = {X = 91, Y = 70}
  label.AbsoluteSize = {X = 88, Y = 48}
  gui.SelectedObject = button
  gui.PreferredTextSize = {Name = "Largest"}
  local observation = Controller.Observe(root)
  equal(observation.kind, "ForgeUiClientObservation")
  equal(observation.authority, "client_observation")
  equal(observation.sampling, "current_frame")
  equal(observation.componentId, "interface")
  equal(observation.abi, "5")
  equal(observation.root.position.y, 30)
  equal(observation.root.size.y, 794)
  equal(observation.preferences.textSize, "Largest")
  equal(observation.selectedNodeId, "action")
  equal(observation.nodes[1].id, "action")
  equal(observation.nodes[2].id, "description")
  equal(observation.nodes[2].parentId, "list")
  equal(observation.nodes[2].text.fits, false)
  equal(observation.nodes[2].text.bounds.y, 70)
  equal(observation.nodes[2].text.font.family, "rbxasset://fonts/families/BuilderSans.json")
  equal(observation.nodes[2].text.font.weight, "Regular")
  equal(observation.nodes[2].text.horizontal, "Left")
  equal(observation.nodes[1].button.focused, true)
  equal(observation.nodes[1].button.state, "Idle")
  equal(observation.nodes[3].scroll.canvasSize.y, 600)
  equal(observation.nodes[3].scroll.windowSize.x, 88)
  equal(observation.nodes[3].scroll.axis, "Y")
  equal(env.connected(), 0)
  equal(label.AbsoluteSize.Y, 48)
  equal(label.TextFits, false)
  equal(scroll.CanvasPosition.Y, 0)
  scroll.AbsoluteCanvasSize.Y = 1200
  scroll.CanvasPosition.Y = 320
  scroll.Visible = false
  local changed = Controller.Observe(root)
  equal(changed.nodes[3].scroll.canvasSize.y, 1200)
  equal(changed.nodes[3].scroll.canvasPosition.y, 320)
  equal(changed.nodes[2].ancestorsVisible, false)
  equal(observation.nodes[3].scroll.canvasSize.y, 600)
  equal(observation.nodes[2].ancestorsVisible, true)
end)

test("observations reject ambiguous or incomplete declarations instead of inventing facts", function()
  local root = env.root()
  local label = env.node(root, "label", "TextLabel")
  label.attributes.UiRequireInsideParent = nil
  fails(function() Controller.Observe(root) end)
  label.attributes.UiRequireInsideParent = false
  label.AbsoluteSize.X = 0 / 0
  fails(function() Controller.Observe(root) end)
  label.AbsoluteSize.X = 100
  label.Text = string.rep("x", 4097)
  fails(function() Controller.Observe(root) end)
  label.Text = "Ready"
  env.node(root, "label", "TextButton")
  fails(function() Controller.Observe(root) end)
  equal(env.connected(), 0)
end)

test("scroll elasticity follows reduced motion and stale callbacks cannot change an unmounted region", function()
  local root = env.root()
  local scroll = env.node(root, "list", "ScrollingFrame")
  local button = env.node(scroll, "action", "TextButton")
  gui.ReducedMotionEnabled = true
  local handle = Controller.Mount(root, {}, {})
  equal(scroll.ElasticBehavior, "Never")
  equal(handle:Focus("action"), true)
  equal(gui.SelectedObject, button)
  local motion = gui:GetPropertyChangedSignal("ReducedMotionEnabled")
  gui.ReducedMotionEnabled = false
  motion:Fire()
  equal(scroll.ElasticBehavior, "WhenScrollable")
  local queued = motion.listeners[1].callback
  handle:Unmount()
  gui.ReducedMotionEnabled = true
  queued()
  equal(scroll.ElasticBehavior, "WhenScrollable")
  equal(gui.SelectedObject, nil)
  equal(env.connected(), 0)
end)

test("native interaction states preserve geometry, visibly focus, and reset on unmount", function()
  local root, _, _, button = scene()
  local ring = styleButton(button)
  local handle = Controller.Mount(root, state(), {activate = function() end})
  equal(button.BackgroundColor3, "1,0,0")
  button.GuiState = env.Enum.GuiState.Hover
  button:GetPropertyChangedSignal("GuiState"):Fire()
  equal(button.BackgroundColor3, "2,0,0")
  handle:Focus("button")
  equal(button.BackgroundColor3, "4,0,0")
  equal(ring.Enabled, true)
  button.GuiState = env.Enum.GuiState.Press
  button:GetPropertyChangedSignal("GuiState"):Fire()
  equal(button.BackgroundColor3, "3,0,0")
  equal(ring.Enabled, true)
  handle:Update(state("Ready", false))
  equal(button.BackgroundColor3, "5,0,0")
  equal(ring.Enabled, false)
  equal(gui.SelectedObject, nil)
  equal(button.AbsoluteSize.X, 100)
  local queued = button:GetPropertyChangedSignal("GuiState").listeners[1].callback
  handle:Unmount()
  equal(button.BackgroundColor3, "1,0,0")
  equal(ring.Enabled, false)
  button.GuiState = env.Enum.GuiState.Hover
  queued()
  equal(button.BackgroundColor3, "1,0,0")
  equal(env.connected(), 0)
end)

test("shared button updates coalesce automatic property notifications into linear work", function()
  for _, amount in {10, 50, 100} do
    local root, buttons, rings = buttonsScene(amount)
    local handle = Controller.Mount(root, {enabled = true}, {})
    handle:Focus("button-1")
    env.appearanceWrites = {}
    env.descendantChecks = {}
    handle:Update({enabled = false})
    equal(total(env.appearanceWrites), amount + 1)
    assert(total(env.descendantChecks) <= amount * 3, "A shared update revisited unrelated controls")
    for index, button in buttons do
      equal(button.BackgroundColor3, "5,0,0")
      equal(button.Interactable, false)
      equal(button.Selectable, false)
      equal(rings[index].Enabled, false)
    end
    equal(gui.SelectedObject, nil)
    equal(#handle:Unmount(), 0)
    equal(env.connected(), 0)
  end
end)

test("deferred property notifications stay local and avoid duplicate appearance writes", function()
  local root, buttons = buttonsScene(100)
  local handle = Controller.Mount(root, {enabled = true}, {})
  env.deferPropertyChanges = true
  env.appearanceWrites = {}
  handle:Update({enabled = false})
  equal(total(env.appearanceWrites), 100)
  equal(#env.pendingPropertySignals, 200)
  env.appearanceWrites = {}
  env.descendantChecks = {}
  env.flushPropertyChanges()
  equal(total(env.appearanceWrites), 0)
  equal(total(env.descendantChecks), 200)
  for _, button in buttons do equal(button.BackgroundColor3, "5,0,0") end
  handle:Unmount()
  equal(env.connected(), 0)
end)

test("a button property change never inspects or rewrites unrelated buttons", function()
  local root, buttons, rings = buttonsScene(100)
  local handle = Controller.Mount(root, {enabled = true}, {})
  env.appearanceWrites = {}
  env.descendantChecks = {}
  buttons[51].GuiState = env.Enum.GuiState.Hover
  equal(buttons[51].BackgroundColor3, "2,0,0")
  equal(total(env.appearanceWrites), 1)
  equal(total(env.descendantChecks), 1)
  for index, button in buttons do
    if index == 51 then continue end
    equal(env.appearanceWrites[button], nil)
    equal(env.appearanceWrites[rings[index]], nil)
    equal(env.descendantChecks[button], nil)
  end
  local queued = buttons[51]:GetPropertyChangedSignal("GuiState").listeners[1].callback
  handle:Unmount()
  env.appearanceWrites = {}
  env.descendantChecks = {}
  queued()
  equal(total(env.appearanceWrites), 0)
  equal(total(env.descendantChecks), 0)
end)

test("a failed bulk update releases its batch and keeps interaction cleanup usable", function()
  local root, buttons = buttonsScene(3)
  env.node(root, "group", "CanvasGroup", {UiTransparencyState = "fade", UiMotionSeconds = 0.2})
  local handle = Controller.Mount(root, {enabled = true, fade = 0}, {})
  env.tweenService.failCreate = true
  fails(function() handle:Update({enabled = false, fade = 0.5}) end)
  for _, button in buttons do equal(button.BackgroundColor3, "5,0,0") end
  buttons[1].Interactable = true
  equal(buttons[1].BackgroundColor3, "1,0,0")
  env.tweenService.failCreate = false
  handle:Update({enabled = true, fade = 0.8})
  equal(#env.tweens, 1)
  equal(#handle:Unmount(), 0)
  equal(env.connected(), 0)
end)

test("invalid materialized appearance fails before any state writes", function()
  local root, _, label, button = scene()
  button.attributes.UiInteractionStyle = true
  fails(function() Controller.Mount(root, state("Changed"), {activate = function() end}) end)
  equal(label.Text, "Initial")
  equal(env.connected(), 0)
  local ring = env.node(button, "FocusRing", "UIStroke")
  ring.attributes.UiNodeId = nil
  button.attributes.UiBaseBackground = 16777216
  fails(function() Controller.Mount(root, state("Changed"), {activate = function() end}) end)
  equal(label.Text, "Initial")
  equal(env.connected(), 0)
end)

test("focus restoration rejects hidden, disabled and unselectable previous controls", function()
  for _, failure in {"hidden", "disabled", "unselectable", "root-disabled"} do
    local outside = env.root()
    local previous = env.node(outside, "outside", "TextButton")
    local root = scene()
    gui.SelectedObject = previous
    local handle = Controller.Mount(root, state(), {activate = function() end})
    handle:Focus("button")
    if failure == "hidden" then previous.Visible = false
    elseif failure == "disabled" then previous.Interactable = false
    elseif failure == "unselectable" then previous.Selectable = false
    else outside.Enabled = false end
    handle:Unmount()
    equal(gui.SelectedObject, nil)
  end
end)

print(tostring(count) .. " UI controller contract cases passed; fake engine, no native claims")
