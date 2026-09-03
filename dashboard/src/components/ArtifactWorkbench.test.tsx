import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactWorkbench } from "./ArtifactWorkbench";
import type { CreatorControlView } from "../types";

const BASE: CreatorControlView = {
  kind: "CreatorControlView",
  id: "creator_control_view_test",
  hash: "a".repeat(64),
  creatorSessionId: "creator_session_test",
  creatorSessionHash: "b".repeat(64),
  status: "awaiting_plan_approval",
  title: "Review Plan",
  detail: "Review the exact evidence.",
};

describe("ArtifactWorkbench review evidence", () => {
  it("renders the exact request, typed plan, machine checks, coverage, and creator prompts", () => {
    render(
      <ArtifactWorkbench
        controlView={{
          ...BASE,
          creatorReviewPrompts: ["Trigger the prompt twice and describe the interaction."],
          artifact: {
            kind: "plan",
            id: "creator_plan_test",
            hash: "c".repeat(64),
            presentationHash: "d".repeat(64),
            presentation: {
              creatorRequest: {
                text: "Add a Toggle Door prompt.",
                promptHash: "e".repeat(64),
              },
              plan: { goal: "Build a server-authoritative door." },
              changes: [
                {
                  id: "prompt",
                  summary:
                    "Create ProximityPrompt at Workspace/DoorAssembly/ControlPanel/ToggleDoor.",
                  initializationCommitments: ["Present exact properties before mutation."],
                },
              ],
              machineCheckClauses: [
                {
                  check: "instance_exists",
                  statement: "The prompt exists.",
                  path: "Workspace/DoorAssembly/ControlPanel/ToggleDoor",
                },
              ],
              outputCheckCoverage: [{ covered: true }],
            },
          },
        }}
      />,
    );
    expect(screen.getByText("Add a Toggle Door prompt.")).toBeVisible();
    expect(screen.getByText(/Create ProximityPrompt/)).toBeVisible();
    expect(screen.getByText("The prompt exists.")).toBeVisible();
    expect(screen.getByText(/1\/1 planned outputs/)).toBeVisible();
    expect(screen.getByText(/Trigger the prompt twice/)).toBeVisible();
  });

  it("renders exact operation hashes, canonical property data, and source diffs", () => {
    render(
      <ArtifactWorkbench
        controlView={{
          ...BASE,
          status: "awaiting_change_approval",
          artifact: {
            kind: "change_set",
            id: "creator_change_set_test",
            hash: "f".repeat(64),
            presentationHash: "0".repeat(64),
            presentation: {
              localGate: { status: "eligible" },
              operations: [
                {
                  kind: "create",
                  target: "ServerScriptService/DoorController",
                  className: "Script",
                  operationHash: "1".repeat(64),
                  properties: { Enabled: true },
                },
              ],
              sourceDiffs: [
                {
                  path: "ServerScriptService/DoorController",
                  unifiedDiff: "+prompt.Triggered:Connect(toggleDoor)",
                },
              ],
              proofObligations: [
                {
                  fact: "Script ServerScriptService/DoorController source hash",
                  expected: "2".repeat(64),
                },
              ],
            },
          },
        }}
      />,
    );
    expect(screen.getByText("eligible")).toBeVisible();
    expect(screen.getAllByText("ServerScriptService/DoorController")).toHaveLength(2);
    expect(screen.getByText(/"Enabled": true/)).toBeVisible();
    expect(screen.getByText(/prompt\.Triggered:Connect/)).toBeVisible();
    expect(screen.getByText("Direct readback obligations")).toBeVisible();
    expect(screen.getByText(/source hash/)).toBeVisible();
  });

  it("renders projection-bound mutation evidence and explicit failure facts", () => {
    render(
      <ArtifactWorkbench
        controlView={{
          ...BASE,
          status: "awaiting_verification",
          mutation: {
            attemptId: "creator_mutation_attempt_test",
            status: "matched",
            projectionFactCount: 7,
            replayable: true,
            failureFacts: [],
          },
          artifacts: {
            mutationProjection: {
              artifactHash: "2".repeat(64),
              bytes: 120,
              locator: "artifacts/projection.json",
            },
            mutationReadback: {
              artifactHash: "3".repeat(64),
              bytes: 240,
              locator: "artifacts/readback.json",
            },
          },
        }}
      />,
    );
    expect(screen.getByText("Transactional mutation proof")).toBeVisible();
    expect(screen.getByText(/7 projected facts/)).toBeVisible();
    expect(screen.getByText("Mutation evidence projection")).toBeVisible();
    expect(screen.getByText("Direct Studio readback")).toBeVisible();
  });

  it("makes retained project-refresh evidence inspectable", () => {
    render(
      <ArtifactWorkbench
        controlView={{
          ...BASE,
          artifacts: {
            projectIndex: {
              artifactHash: "5".repeat(64),
              bytes: 128,
              locator: "artifacts/index.json",
            },
            sourceConsultation: {
              artifactHash: "6".repeat(64),
              bytes: 256,
              locator: "artifacts/consultation.json",
            },
            projectChangeNotice: {
              artifactHash: "7".repeat(64),
              bytes: 512,
              locator: "artifacts/notice.json",
            },
            projectDelta: {
              artifactHash: "8".repeat(64),
              bytes: 512,
              locator: "artifacts/delta.json",
            },
          },
        }}
      />,
    );

    expect(screen.getByText("Project index metadata")).toBeVisible();
    expect(screen.getByText("Source consultation")).toBeVisible();
    expect(screen.getByText("Project change notice")).toBeVisible();
    expect(screen.getByText("Project refresh delta")).toBeVisible();
  });

  it("labels a source-transfer failure without calling it detached preflight", () => {
    render(
      <ArtifactWorkbench
        controlView={{
          ...BASE,
          status: "incomplete",
          mutation: {
            attemptId: "creator_mutation_attempt_test",
            status: "source_transfer_failed",
            projectionFactCount: 0,
            replayable: false,
            failureFacts: [
              {
                code: "creator_source_transfer_failed",
                statement: "The approved source blob was not acknowledged.",
                hash: "9".repeat(64),
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByText("source transfer failed")).toBeVisible();
    expect(screen.getByText("Source transfer:")).toBeVisible();
    expect(screen.queryByText("detached preflight failed")).not.toBeInTheDocument();
  });

  it("shows a completed but technically incomplete Play interval without implying Play was missed", () => {
    render(
      <ArtifactWorkbench
        controlView={{
          ...BASE,
          status: "awaiting_verification_retry",
          title: "Play Evidence Incomplete",
          detail: "The Play session ended and its evidence was sealed.",
          verification: {
            id: "creator_verification_incomplete",
            status: "incomplete",
            replayable: false,
            failureFacts: [],
            runtimeSummary: {
              startedAt: "2026-09-01T14:28:04.000Z",
              endedAt: "2026-09-01T14:28:17.000Z",
              observedFacts: 2,
              absentFacts: 1,
              unavailableFacts: 1,
              readErrorFacts: 2,
              diagnosticCount: 0,
              issues: [
                {
                  key: "runtime_resolution:door",
                  status: "read_error",
                  code: "engine_read_failed",
                },
              ],
            },
          },
          artifacts: {
            runtimeEvidence: {
              artifactHash: "4".repeat(64),
              bytes: 512,
              locator: "artifacts/runtime.json",
            },
          },
        }}
      />,
    );
    expect(screen.getByText("Play Evidence Incomplete")).toBeVisible();
    expect(screen.getByText(/Play interval 13\.0s/)).toBeVisible();
    expect(screen.getByText(/2 observed · 1 absent · 1 unavailable · 2 read errors/)).toBeVisible();
    expect(screen.getByText(/engine_read_failed/)).toBeVisible();
    expect(screen.getByText("Runtime evidence")).toBeVisible();
    expect(screen.queryByText("Waiting for Studio Play")).not.toBeInTheDocument();
  });
});
