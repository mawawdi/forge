/** Fixed ordinary client ModuleScript. Declarations are materialized attributes, never code. */
export const UI_CONTROLLER_SOURCE = String.raw`--!strict
-- Forge responsive-ui controller, ABI 5. Caller owns application state and actions.
local Controller = {}
local mounted: {[Instance]: boolean} = setmetatable({}, {__mode = "k"}) :: any
type State = {[string]: string | boolean | number}
type Handler = (GuiButton) -> ()
type Binding = {node: any, field: string, property: string, valueType: string}
type Rendered = {node: any, target: number, tween: any?}
export type Handle = {
  Update: (self: Handle, state: State) -> (),
  Focus: (self: Handle, nodeId: string) -> boolean,
  Unmount: (self: Handle) -> {string},
}

type PixelVector = {x: number, y: number}
export type NodeObservation = {
  id: string, parentId: string?, className: string,
  position: PixelVector, size: PixelVector, rotation: number,
  visible: boolean, ancestorsVisible: boolean, clipsDescendants: boolean,
  requireInsideParent: boolean,
  text: {value: string, bounds: PixelVector, fits: boolean, size: number, scaled: boolean, wrapped: boolean, lineHeight: number, horizontal: string, vertical: string, font: {family: string, weight: string, style: string}}?,
  button: {interactable: boolean, selectable: boolean, state: string, focused: boolean, focusRingEnabled: boolean?}?,
  scroll: {canvasPosition: PixelVector, canvasSize: PixelVector, windowSize: PixelVector, axis: string, enabled: boolean}?,
}
export type Observation = {
  kind: "ForgeUiClientObservation", authority: "client_observation", sampling: "current_frame",
  componentId: string, abi: string,
  root: {position: PixelVector, size: PixelVector, enabled: boolean, screenInsets: string, clipToDeviceSafeArea: boolean},
  preferences: {reducedMotion: boolean, transparency: number, textSize: string},
  selectedNodeId: string?, nodes: {NodeObservation},
}
local function pixels(value: Vector2): PixelVector
  assert(value.X == value.X and value.Y == value.Y and math.abs(value.X) < math.huge and math.abs(value.Y) < math.huge, "UI measurement is not finite")
  return {x = value.X, y = value.Y}
end
local function ancestorVisibility(root: ScreenGui, node: GuiObject): boolean
  if not root.Enabled or not node:IsDescendantOf(root) then return false end
  local current: Instance? = node
  while current and current ~= root do
    if current:IsA("GuiObject") and not current.Visible then return false end
    current = current.Parent
  end
  return true
end

-- Read-only, immediate client facts. No waits, callbacks, layout writes, readiness verdict,
-- host attestation, or assumption that fonts/layout/tweens have finished settling.
function Controller.Observe(root: ScreenGui): Observation
  assert(root:IsA("ScreenGui") and root:GetAttribute("UiRecipeAbi") == "5", "UI observation requires the materialized ABI 5 ScreenGui")
  local componentId = root:GetAttribute("UiComponentId")
  assert(typeof(componentId) == "string" and #componentId > 0 and #componentId <= 128, "UI observation requires its component identity")
  local gui = game:GetService("GuiService")
  local observed: {NodeObservation} = {}
  local ids: {[string]: boolean} = {}
  local selectedNodeId: string? = nil
  for _, instance in root:GetDescendants() do
    local id = instance:GetAttribute("UiNodeId")
    if id == nil then continue end
    assert(typeof(id) == "string" and #id > 0 and #id <= 128 and not ids[id] and instance:IsA("GuiObject"), "Invalid or duplicate observed UI node")
    assert(#observed < 512, "UI observation exceeds its node allowance")
    ids[id] = true
    local node = instance :: GuiObject
    local requirement = node:GetAttribute("UiRequireInsideParent")
    assert(typeof(requirement) == "boolean", "UI observation lacks the declared containment requirement")
    local parentId: string? = nil
    if node.Parent ~= root then
      local parent = node.Parent
      assert(parent and parent:IsA("GuiObject"), "Observed UI node has an undeclared parent")
      local identity = parent:GetAttribute("UiNodeId")
      assert(typeof(identity) == "string", "Observed UI parent lacks its identity")
      parentId = identity
    end
    local entry: NodeObservation = {
      id = id, parentId = parentId, className = node.ClassName,
      position = pixels(node.AbsolutePosition), size = pixels(node.AbsoluteSize), rotation = node.AbsoluteRotation,
      visible = node.Visible, ancestorsVisible = ancestorVisibility(root, node), clipsDescendants = node.ClipsDescendants,
      requireInsideParent = requirement,
    }
    if node:IsA("TextLabel") or node:IsA("TextButton") then
      assert(#node.Text <= 4096, "Observed UI text exceeds its byte allowance")
      entry.text = {value = node.Text, bounds = pixels(node.TextBounds), fits = node.TextFits, size = node.TextSize, scaled = node.TextScaled, wrapped = node.TextWrapped,
        lineHeight = node.LineHeight, horizontal = node.TextXAlignment.Name, vertical = node.TextYAlignment.Name,
        font = {family = node.FontFace.Family, weight = node.FontFace.Weight.Name, style = node.FontFace.Style.Name}}
    elseif node:IsA("ScrollingFrame") then
      entry.scroll = {canvasPosition = pixels(node.CanvasPosition), canvasSize = pixels(node.AbsoluteCanvasSize), windowSize = pixels(node.AbsoluteWindowSize), axis = node.ScrollingDirection.Name, enabled = node.ScrollingEnabled}
    end
    if node:IsA("GuiButton") then
      local ring = if node:GetAttribute("UiInteractionStyle") then node:FindFirstChild("FocusRing") else nil
      entry.button = {interactable = node.Interactable, selectable = node.Selectable, state = node.GuiState.Name, focused = gui.SelectedObject == node,
        focusRingEnabled = if ring and ring:IsA("UIStroke") then ring.Enabled else nil}
    end
    if gui.SelectedObject == node then selectedNodeId = id end
    table.insert(observed, entry)
  end
  table.sort(observed, function(a, b) return a.id < b.id end)
  for _, node in observed do assert(node.parentId == nil or ids[node.parentId], "Observed parent is outside the declared UI") end
  return {
    kind = "ForgeUiClientObservation", authority = "client_observation", sampling = "current_frame",
    componentId = componentId, abi = "5",
    root = {position = pixels(root.AbsolutePosition), size = pixels(root.AbsoluteSize), enabled = root.Enabled, screenInsets = root.ScreenInsets.Name, clipToDeviceSafeArea = root.ClipToDeviceSafeArea},
    preferences = {reducedMotion = gui.ReducedMotionEnabled, transparency = gui.PreferredTransparency, textSize = gui.PreferredTextSize.Name},
    selectedNodeId = selectedNodeId, nodes = observed,
  }
end

function Controller.Mount(root: ScreenGui, initialState: State, handlers: {[string]: Handler}): Handle
  assert(root:IsA("ScreenGui") and root:GetAttribute("UiRecipeAbi") == "5", "UI mount requires the materialized ABI 5 ScreenGui")
  assert(not mounted[root], "UI root is already mounted")
  local gui = game:GetService("GuiService")
  local tweens = game:GetService("TweenService")
  local nodes: {[string]: any} = {}
  local ownedNodes: {[Instance]: boolean} = {}
  local actionHandlers = table.clone(handlers)
  local bindings: {Binding} = {}
  local fields: {[string]: string} = {}
  local actions: {[string]: boolean} = {}
  local backgrounds: {{node: any, transparency: number}} = {}
  type Surface = {background: Color3, foreground: Color3}
  type Interaction = {node: TextButton, ring: UIStroke, surfaces: {[string]: Surface}}
  local interactions: {Interaction} = {}
  local function packedColor(node: Instance, key: string): Color3
    local value = node:GetAttribute(key)
    assert(typeof(value) == "number" and value >= 0 and value <= 16777215 and value % 1 == 0, "Invalid declared UI state color: " .. key)
    local number = value :: number
    return Color3.fromRGB(math.floor(number / 65536), math.floor(number / 256) % 256, number % 256)
  end
  local scrollRegions: {ScrollingFrame} = {}
  local rendered: {[Instance]: Rendered} = {}
  local connections: {RBXScriptConnection} = {}
  local open = false
  local interactionBatchDepth = 0
  local initialized = false
  local errors: {string} = {}
  local previousFocus: GuiObject? = nil
  local focusOwned = false
  local handle: Handle = {} :: any
  local declarations = {
    {attribute = "UiTextState", property = "Text", valueType = "string"},
    {attribute = "UiVisibleState", property = "Visible", valueType = "boolean"},
    {attribute = "UiEnabledState", property = "Interactable", valueType = "boolean"},
    {attribute = "UiTransparencyState", property = "GroupTransparency", valueType = "number"},
  }
  -- Resolve the whole materialized declaration before any connection or property write.
  for _, instance in root:GetDescendants() do
    local id = instance:GetAttribute("UiNodeId")
    if id ~= nil then
      assert(typeof(id) == "string" and nodes[id] == nil and instance:IsA("GuiObject"), "Invalid or duplicate UI node")
      local node = instance :: any
      nodes[id] = node
      ownedNodes[node] = true
      if node:GetAttribute("UiInteractionStyle") ~= nil then
        assert(node:GetAttribute("UiInteractionStyle") == true and node:IsA("TextButton"), "UI appearance states require a declared button")
        local ring = node:FindFirstChild("FocusRing")
        assert(ring and ring:IsA("UIStroke"), "Missing materialized UI focus ring")
        ownedNodes[ring] = true
        local surfaces: {[string]: Surface} = {}
        for _, state in {"Base", "Hover", "Pressed", "Focused", "Disabled"} do
          surfaces[state] = {background = packedColor(node, "Ui" .. state .. "Background"), foreground = packedColor(node, "Ui" .. state .. "Foreground")}
        end
        table.insert(interactions, {node = node, ring = ring, surfaces = surfaces})
      end
      for _, declaration in declarations do
        local field = node:GetAttribute(declaration.attribute)
        if field ~= nil then
          assert(typeof(field) == "string", "UI field must be a string")
          if declaration.property == "Text" then assert(node:IsA("TextLabel") or node:IsA("TextButton"), "Text binding requires text") end
          if declaration.property == "Interactable" then assert(node:IsA("GuiButton"), "Enabled binding requires button") end
          if declaration.property == "GroupTransparency" then assert(node:IsA("CanvasGroup"), "Transparency binding requires group") end
          assert(fields[field] == nil or fields[field] == declaration.valueType, "UI field types conflict")
          fields[field] = declaration.valueType
          table.insert(bindings, {node = node, field = field, property = declaration.property, valueType = declaration.valueType})
        end
      end
      local action = node:GetAttribute("UiAction")
      if action ~= nil then
        assert(typeof(action) == "string" and node:IsA("GuiButton"), "Invalid UI action declaration")
        assert(type(handlers[action]) == "function", "Missing UI action handler: " .. action)
        actions[action] = true
      end
      local transparency = node:GetAttribute("UiBackgroundTransparency")
      assert(typeof(transparency) == "number" and transparency >= 0 and transparency <= 1, "Invalid UI background declaration")
      table.insert(backgrounds, {node = node, transparency = transparency})
      if node:IsA("ScrollingFrame") then table.insert(scrollRegions, node) end
    end
  end
  for id in handlers do assert(actions[id], "Undeclared UI action handler: " .. id) end
  local function validate(state: State)
    assert(type(state) == "table", "UI state must be a complete table")
    for field, valueType in fields do
      local value = state[field]
      assert(typeof(value) == valueType, "Invalid or missing UI field: " .. field)
      if valueType == "number" then
        local number = value :: number
        assert(number == number and number >= 0 and number <= 1, "UI transparency must be within [0, 1]")
      elseif valueType == "string" then
        assert(#(value :: string) <= 4096, "UI text exceeds 4096 UTF-8 bytes")
      end
    end
    for field in state do assert(fields[field], "Undeclared UI state field: " .. field) end
  end
  validate(initialState)
  local function attempt(callback: () -> ())
    local ok, failure = pcall(function(): any callback(); return nil end)
    if not ok then table.insert(errors, tostring(failure)) end
  end
  local function cancel(record: Rendered)
    if record.tween then
      local tween = record.tween
      record.tween = nil
      attempt(function() tween:Cancel() end)
    end
  end
  local function visible(node: GuiObject): boolean
    return ancestorVisibility(root, node)
  end
  local function refreshInteraction(interaction: Interaction)
    if not open or interactionBatchDepth > 0 then return end
    local node = interaction.node
    if not node:IsDescendantOf(root) then return end
    local selected = gui.SelectedObject == node and node.Selectable and visible(node) and node.Interactable and node.GuiState ~= Enum.GuiState.NonInteractable
    local state = if not node.Interactable or node.GuiState == Enum.GuiState.NonInteractable then "Disabled"
      elseif node.GuiState == Enum.GuiState.Press then "Pressed"
      elseif selected then "Focused"
      elseif node.GuiState == Enum.GuiState.Hover then "Hover" else "Base"
    local surface = interaction.surfaces[state]
    -- Deferred property notifications may arrive after the final batch refresh.
    if node.BackgroundColor3 ~= surface.background then node.BackgroundColor3 = surface.background end
    if node.TextColor3 ~= surface.foreground then node.TextColor3 = surface.foreground end
    if interaction.ring.Enabled ~= selected then interaction.ring.Enabled = selected end
  end
  local function refreshInteractions()
    if not open or interactionBatchDepth > 0 then return end
    for _, interaction in interactions do refreshInteraction(interaction) end
  end
  local function restorableFocus(node: GuiObject): boolean
    if not node.Parent or not node.Selectable or not node.Interactable or node.GuiState == Enum.GuiState.NonInteractable then return false end
    local current: Instance? = node
    while current do
      if current:IsA("GuiObject") and not current.Visible then return false end
      if current:IsA("LayerCollector") then return current.Enabled end
      current = current.Parent
    end
    return false
  end
  local function releaseFocus()
    local selected = gui.SelectedObject
    if selected and selected:IsDescendantOf(root) then
      gui.SelectedObject = if focusOwned and previousFocus and restorableFocus(previousFocus) then previousFocus else nil
    end
    focusOwned = false
    previousFocus = nil
  end
  function handle.Unmount(_self: Handle): {string}
    if not open then return table.clone(errors) end
    -- Invalidate before cancellation/disconnection; queued callbacks become inert.
    open = false
    mounted[root] = nil
    for _, record in rendered do
      cancel(record)
      attempt(function() record.node.GroupTransparency = record.target end)
    end
    table.clear(rendered)
    for index = #connections, 1, -1 do
      local connection = connections[index]
      attempt(function() connection:Disconnect() end)
    end
    table.clear(connections)
    attempt(releaseFocus)
    for _, interaction in interactions do
      attempt(function()
        interaction.ring.Enabled = false
        interaction.node.BackgroundColor3 = interaction.surfaces.Base.background
        interaction.node.TextColor3 = interaction.surfaces.Base.foreground
      end)
    end
    return table.clone(errors)
  end
  function handle.Focus(_self: Handle, id: string): boolean
    assert(open, "Cannot focus an unmounted UI")
    local node = nodes[id]
    assert(node, "Unknown UI focus node: " .. id)
    if not node:IsA("GuiButton") or not node.Selectable or not node.Interactable or node.GuiState == Enum.GuiState.NonInteractable or not visible(node) then return false end
    if not focusOwned then
      local selected = gui.SelectedObject
      previousFocus = if selected and not selected:IsDescendantOf(root) then selected else nil
      focusOwned = true
    end
    gui.SelectedObject = node
    refreshInteractions()
    return true
  end
  function handle.Update(_self: Handle, state: State)
    assert(open, "Cannot update an unmounted UI")
    validate(state)
    for _, binding in bindings do
      assert(binding.node:IsDescendantOf(root), "Bound UI node left its mounted root")
    end
    -- Immediate signals observe the completed state once; deferred signals remain local.
    interactionBatchDepth += 1
    local applied, failure = pcall(function()
      for _, binding in bindings do
        local node = binding.node
        local value = state[binding.field]
        if binding.property == "Text" then node.Text = value
        elseif binding.property == "Visible" then node.Visible = value
        elseif binding.property == "Interactable" then node.Interactable = value; node.Selectable = value
        else
          local previous = rendered[node]
          if previous and previous.target == value then continue end
          local record: Rendered = previous or {node = node, target = value :: number}
          rendered[node] = record
          cancel(record)
          record.target = value :: number
          local duration = node:GetAttribute("UiMotionSeconds") or 0
          if initialized and duration > 0 and not gui.ReducedMotionEnabled then
            local tween = tweens:Create(node, TweenInfo.new(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {GroupTransparency = value})
            record.tween = tween
            tween:Play()
          else node.GroupTransparency = value end
        end
      end
      local selected = gui.SelectedObject
      if selected and selected:IsDescendantOf(root) and (not visible(selected) or not selected.Interactable or selected.GuiState == Enum.GuiState.NonInteractable) then releaseFocus() end
    end)
    interactionBatchDepth -= 1
    if not applied then
      attempt(refreshInteractions)
      error(failure)
    end
    refreshInteractions()
  end
  local function updateTransparency()
    if not open then return end
    for _, background in backgrounds do
      if background.node:IsDescendantOf(root) then
        background.node.BackgroundTransparency = background.transparency * gui.PreferredTransparency
      end
    end
  end
  local function updateMotion()
    if not open then return end
    for _, node in scrollRegions do
      node.ElasticBehavior = if gui.ReducedMotionEnabled then Enum.ElasticBehavior.Never else Enum.ElasticBehavior.WhenScrollable
    end
    if gui.ReducedMotionEnabled then
      for _, record in rendered do cancel(record); record.node.GroupTransparency = record.target end
    end
  end
  open = true
  mounted[root] = true
  local ok, failure = pcall(function()
    handle:Update(initialState)
    initialized = true
    updateTransparency()
    updateMotion()
    if #interactions > 0 then
      table.insert(connections, gui:GetPropertyChangedSignal("SelectedObject"):Connect(refreshInteractions))
      table.insert(connections, root:GetPropertyChangedSignal("Enabled"):Connect(refreshInteractions))
      for _, interaction in interactions do
        for _, property in {"GuiState", "Interactable", "Selectable", "Visible"} do
          table.insert(connections, interaction.node:GetPropertyChangedSignal(property):Connect(function()
            refreshInteraction(interaction)
          end))
        end
      end
    end
    for _, node in nodes do
      local action = node:GetAttribute("UiAction")
      if action then
        table.insert(connections, node.Activated:Connect(function()
          if not open or not visible(node) or not node.Interactable or node.GuiState == Enum.GuiState.NonInteractable then return end
          local callback = coroutine.create(actionHandlers[action])
          local success, message = coroutine.resume(callback, node)
          if not success then warn(message) end
          if coroutine.status(callback) ~= "dead" then
            coroutine.close(callback)
            warn("UI action handlers must not yield; schedule owned asynchronous work explicitly")
          end
        end))
      end
    end
    table.insert(connections, gui:GetPropertyChangedSignal("PreferredTransparency"):Connect(updateTransparency))
    table.insert(connections, gui:GetPropertyChangedSignal("ReducedMotionEnabled"):Connect(updateMotion))
    table.insert(connections, root.Destroying:Connect(function() handle:Unmount() end))
    table.insert(connections, root.DescendantRemoving:Connect(function(instance)
      if open and ownedNodes[instance] then handle:Unmount() end
    end))
  end)
  if not ok then handle:Unmount(); error(failure) end
  return handle
end
return table.freeze(Controller)
`;
