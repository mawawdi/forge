-- Fixed test doubles only; never imported by production game source.
local env = {signals = {}, tweens = {}, appearanceWrites = {}, descendantChecks = {}, pendingPropertySignals = {}, deferPropertyChanges = false}
local function signal()
  local self = {listeners = {}}
  table.insert(env.signals, self)
  function self:Connect(callback)
    assert(not self.failConnect, "fixture connection failure")
    local connection = {Connected = true, callback = callback}
    function connection:Disconnect()
      self.Connected = false
      assert(not connection.owner.failDisconnect, "fixture disconnect failure")
    end
    connection.owner = self
    table.insert(self.listeners, connection)
    return connection
  end
  function self:Fire(...)
    for _, connection in table.clone(self.listeners) do
      if connection.Connected then connection.callback(...) end
    end
  end
  return self
end
-- Property writes emit change signals, including writes from inside the controller.
-- An empty proxy keeps __newindex active for subsequent assignments as on Instances.
local function observable(properties)
  local self = {}
  return setmetatable(self, {
    __index = properties,
    __newindex = function(_, name, value)
      local previous = properties[name]
      properties[name] = value
      if name == "BackgroundColor3" or name == "TextColor3" or name == "Enabled" then
        env.appearanceWrites[self] = (env.appearanceWrites[self] or 0) + 1
      end
      local event = properties.signals and properties.signals[name]
      if previous ~= value and event then
        if env.deferPropertyChanges then table.insert(env.pendingPropertySignals, event)
        else event:Fire() end
      end
    end,
  })
end
function env.flushPropertyChanges()
  while #env.pendingPropertySignals > 0 do
    local pending = env.pendingPropertySignals
    env.pendingPropertySignals = {}
    for _, event in pending do event:Fire() end
  end
end
env.gui = observable({SelectedObject = nil, ReducedMotionEnabled = false, PreferredTransparency = 1, PreferredTextSize = {Name = "Medium"}, signals = {}})
function env.gui:GetPropertyChangedSignal(name)
  if not self.signals[name] then self.signals[name] = signal() end
  return self.signals[name]
end
env.tweenService = {}
function env.tweenService:Create(node, info, target)
  assert(not self.failCreate, "fixture tween creation failure")
  local tween = {node = node, info = info, target = target, cancelled = false, played = false}
  function tween:Cancel() self.cancelled = true end
  function tween:Play() self.played = true end
  table.insert(env.tweens, tween)
  return tween
end
env.game = {}
function env.game:GetService(name)
  assert(name == "GuiService" or name == "TweenService", "Unexpected service")
  return if name == "GuiService" then env.gui else env.tweenService
end
env.TweenInfo = {new = function(duration) return {duration = duration} end}
env.Color3 = {fromRGB = function(r, g, b) return tostring(r) .. "," .. tostring(g) .. "," .. tostring(b) end}
env.Enum = {EasingStyle = {Quad = "Quad"}, EasingDirection = {Out = "Out"}, ElasticBehavior = {Never = "Never", WhenScrollable = "WhenScrollable"}, GuiState = {Idle = {Name = "Idle"}, Hover = {Name = "Hover"}, Press = {Name = "Press"}, NonInteractable = {Name = "NonInteractable"}}}
function env.reset()
  env.signals = {}
  env.tweens = {}
  env.appearanceWrites = {}
  env.descendantChecks = {}
  env.pendingPropertySignals = {}
  env.deferPropertyChanges = false
  env.tweenService.failCreate = false
  env.gui.signals = {}
  env.gui.SelectedObject = nil
  env.gui.ReducedMotionEnabled = false
  env.gui.PreferredTransparency = 1
  env.gui.PreferredTextSize = {Name = "Medium"}
end
function env.connected()
  local count = 0
  for _, event in env.signals do
    for _, connection in event.listeners do
      if connection.Connected then count += 1 end
    end
  end
  return count
end
function env.node(parent, id, class, attributes)
  local self = observable({Parent = parent, id = id, Name = id, class = class, ClassName = class, attributes = attributes or {}, children = {}, signals = {}, GuiState = env.Enum.GuiState.Idle,
    Visible = true, Interactable = true, Selectable = true, GroupTransparency = 0, BackgroundTransparency = 0,
    AbsolutePosition = {X = 10, Y = 20}, AbsoluteSize = {X = 100, Y = 48}, AbsoluteRotation = 0, ClipsDescendants = false,
    Text = "Initial", TextBounds = {X = 60, Y = 18}, TextFits = true, TextSize = 18, TextScaled = false, TextWrapped = true,
    LineHeight = 1, TextXAlignment = {Name = "Left"}, TextYAlignment = {Name = "Top"}, FontFace = {Family = "rbxasset://fonts/families/BuilderSans.json", Weight = {Name = "Regular"}, Style = {Name = "Normal"}},
    CanvasPosition = {X = 0, Y = 0}, AbsoluteCanvasSize = {X = 100, Y = 600}, AbsoluteWindowSize = {X = 88, Y = 200},
    ScrollingDirection = {Name = "Y"}, ScrollingEnabled = true, ElasticBehavior = "WhenScrollable", Activated = signal()})
  self.attributes.UiNodeId = id
  self.attributes.UiBackgroundTransparency = self.attributes.UiBackgroundTransparency or 0
  if self.attributes.UiRequireInsideParent == nil then self.attributes.UiRequireInsideParent = true end
  function self:GetAttribute(name) return self.attributes[name] end
  function self:IsA(name)
    return name == self.class or (name == "GuiObject" and self.class ~= "UIStroke") or (name == "GuiButton" and self.class == "TextButton")
  end
  function self:FindFirstChild(name)
    for _, child in self.children do if child.Name == name then return child end end
    return nil
  end
  function self:GetPropertyChangedSignal(name)
    if not self.signals[name] then self.signals[name] = signal() end
    return self.signals[name]
  end
  function self:IsDescendantOf(ancestor)
    env.descendantChecks[self] = (env.descendantChecks[self] or 0) + 1
    local current = self.Parent
    while current do
      if current == ancestor then return true end
      current = current.Parent
    end
    return false
  end
  table.insert(parent.children, self)
  return self
end
function env.root()
  local self = observable({Enabled = true, Parent = {}, children = {}, Destroying = signal(), DescendantRemoving = signal(),
    AbsolutePosition = {X = 0, Y = 30}, AbsoluteSize = {X = 390, Y = 794},
    ScreenInsets = {Name = "CoreUISafeInsets"}, ClipToDeviceSafeArea = true,
    attributes = {UiGraphAbi = "1", UiComponentId = "interface"}, signals = {}})
  function self:GetAttribute(name) return self.attributes[name] end
  function self:IsA(name) return name == "ScreenGui" or name == "LayerCollector" end
  function self:GetPropertyChangedSignal(name)
    if not self.signals[name] then self.signals[name] = signal() end
    return self.signals[name]
  end
  function self:GetDescendants()
    local result = {}
    local function collect(node)
      for _, child in node.children do
        table.insert(result, child)
        collect(child)
      end
    end
    collect(self)
    return result
  end
  return self
end
return env
