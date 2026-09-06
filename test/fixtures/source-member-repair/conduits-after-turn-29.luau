local Task = require(game:GetService("ReplicatedStorage"):WaitForChild("Packages"):WaitForChild("ForgeRuntime"):WaitForChild("Task"))
local Config = require(game:GetService("ReplicatedStorage"):WaitForChild("LastLightConfig"))

local ConduitService = {}

type Gate = { glow: any, strip: any, warns: { any } }
type Pos = { x: number, y: number, z: number }
type Deps = {
	isActive: () -> boolean,
	players: () -> { Player },
	positionOf: (Player) -> Pos?,
	hurt: (Player) -> (),
	phase: (string) -> (),
}

local function sleep(token: any, seconds: number): boolean
	task.wait(seconds)
	return token:IsCurrent()
end

local function resolveGate(workspace: Instance, folder: string, member: string): Gate
	local gate = workspace:WaitForChild("PowerConduits"):WaitForChild(folder)
	local branch = gate:WaitForChild(member)
	return {
		glow = branch:WaitForChild("HazardGlowCore"),
		strip = branch:WaitForChild("HazardFloorStrip"),
		warns = {
			branch:WaitForChild("HazardWarnLightA"),
			branch:WaitForChild("HazardWarnLightB"),
			branch:WaitForChild("HazardWarnLightC"),
		},
	}
end

function ConduitService.resolveGates(): { Gate }
	local workspace = game:GetService("Workspace")
	return {
		resolveGate(workspace, "NorthConduit", "cN"),
		resolveGate(workspace, "EastConduit", "cE"),
		resolveGate(workspace, "WestConduit", "cW"),
	}
end

local function setVisible(instance: any, visible: boolean)
	instance.Visible = visible
end

local function applyVisual(gates: { Gate }, phase: string, blink: boolean)
	for _, gate in gates do
		setVisible(gate.strip, true)
		setVisible(gate.glow, phase ~= Config.PHASE_REST)
		for _, warn in gate.warns do
			if phase == Config.PHASE_WARN then
				setVisible(warn, blink)
			else
				setVisible(warn, true)
			end
		end
	end
end

function ConduitService.setRest(gates: { Gate })
	applyVisual(gates, Config.PHASE_REST, false)
end

local function insideAny(pos: Pos): boolean
	for _, box in Config.CONDUITS do
		if math.abs(pos.x - box.x) <= box.hx and math.abs(pos.z - box.z) <= box.hz then
			return true
		end
	end
	return false
end

function ConduitService.start(scope: any, deps: Deps, gates: { Gate })
	return Task.start(scope, function(token: any)
		while token:IsCurrent() do
			if not deps.isActive() then
				applyVisual(gates, Config.PHASE_REST, false)
				deps.phase(Config.PHASE_REST)
				if not sleep(token, 0.25) then return end
			else
				applyVisual(gates, Config.PHASE_REST, false)
				deps.phase(Config.PHASE_REST)
				if not sleep(token, Config.CONDUIT_REST_SECONDS) then return end
				if not token:IsCurrent() then return end
				applyVisual(gates, Config.PHASE_WARN, true)
				deps.phase(Config.PHASE_WARN)
				local warnEnd = os.clock() + Config.CONDUIT_WARN_SECONDS
				local blink = true
				while os.clock() < warnEnd and token:IsCurrent() do
					applyVisual(gates, Config.PHASE_WARN, blink)
					if not sleep(token, 0.15) then return end
					blink = not blink
				end
				if not token:IsCurrent() then return end
				applyVisual(gates, Config.PHASE_ACTIVE, false)
				deps.phase(Config.PHASE_ACTIVE)
				local hit: { [Player]: boolean } = {}
				local function samplePlayers()
					for _, player in deps.players() do
						if not hit[player] then
							local pos = deps.positionOf(player)
							if pos and insideAny(pos) then
								hit[player] = true
								deps.hurt(player)
							end
						end
					end
				end
				samplePlayers()
				if not sleep(token, 1) then return end
				if token:IsCurrent() then samplePlayers() end
				if not sleep(token, 1) then return end
			end
		end
		return nil
	end)
end

return ConduitService
