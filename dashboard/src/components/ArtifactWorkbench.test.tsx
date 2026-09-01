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
                  summary: "Create ProximityPrompt at Workspace/DoorAssembly/ControlPanel/ToggleDoor.",
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
            },
          },
        }}
      />,
    );
    expect(screen.getByText("eligible")).toBeVisible();
    expect(screen.getAllByText("ServerScriptService/DoorController")).toHaveLength(2);
    expect(screen.getByText(/"Enabled": true/)).toBeVisible();
    expect(screen.getByText(/prompt\.Triggered:Connect/)).toBeVisible();
  });
});
