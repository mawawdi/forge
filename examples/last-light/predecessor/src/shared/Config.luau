--!strict
-- Forge-authored Last Light gameplay contract. The server is authoritative for every field.
local Config = {
	RoundSeconds = 120,
	CountdownSeconds = 3,
	MaximumIntegrity = 2,
	RequiredCells = 3,
	CarryCapacity = 1,
	DepositScore = 100,
	ExtractionSeconds = 3,
	HazardWarningSeconds = 1.5,
	HazardActiveSeconds = 2,
	HazardRestSeconds = 4.5,
	HazardTimePenalty = 8,
	InteractionDistance = 11,
	AnchorNames = {
		Spawn = "PlayerSpawn",
		Deposit = "ReactorDeposit",
		Extraction = "ShuttleExtraction",
		Cells = { "CellPickup1", "CellPickup2", "CellPickup3" },
		Hazards = { "ConduitHazard1", "ConduitHazard2", "ConduitHazard3" },
	},
}

export type Phase = "menu" | "countdown" | "running" | "extracting" | "won" | "lost"
export type Feedback =
	"none"
	| "carry"
	| "deposit"
	| "warning"
	| "impact"
	| "power_restored"
	| "extraction"
	| "failure"

export type PublicState = {
	phase: Phase,
	countdownSeconds: number,
	remainingSeconds: number,
	integrity: number,
	depositedCells: number,
	carryingCell: number?,
	score: number,
	activeHazard: number?,
	hazardPhase: "rest" | "warning" | "active",
	extractionProgress: number,
	feedback: Feedback,
	feedbackSerial: number,
	message: string,
}

return table.freeze(Config)
