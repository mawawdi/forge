import { describe, expect, it } from "vitest";
import { getDashboardSurface, hasRequiredReport, makeActionRequest } from "./derived";
import type { CreatorControlAction, CreatorDashboardState } from "./types";

const ACCEPT_ACTION: CreatorControlAction = {
  id: "accept_result",
  label: "Accept result",
  intent: "primary",
};

const STATE: CreatorDashboardState = {
  kind: "CreatorDashboardState",
  sessions: [],
  pairedStudio: {
    status: "paired",
    projectId: "studio_project_test",
    projectName: "Test",
    capabilities: [],
    manifestHash: "a".repeat(64),
    connectorBuildHash: "b".repeat(64),
    attestationStatus: "verified",
    transactionInventoryStatus: "clear",
    message: "Connected",
  },
  stages: [],
  serverTime: "2026-09-01T00:00:00.000Z",
  controlView: {
    kind: "CreatorControlView",
    id: "view_1",
    hash: "abc123",
    creatorSessionId: "session_1",
    creatorSessionHash: "session_hash",
    status: "awaiting_review",
    title: "Review",
    detail: "Review the run.",
    primaryAction: ACCEPT_ACTION,
    artifacts: {},
  },
};

describe("dashboard derived state", () => {
  it("makes final review require a non-whitespace creator report", () => {
    expect(hasRequiredReport(ACCEPT_ACTION, "   ")).toBe(false);
    expect(hasRequiredReport(ACCEPT_ACTION, "Observed the prompt twice.")).toBe(true);
    expect(hasRequiredReport(ACCEPT_ACTION, "😀".repeat(1025))).toBe(false);
  });

  it("keeps the report bound to the exact visible view", () => {
    expect(makeActionRequest(STATE, "accept_result", "Observed the prompt twice.")).toEqual({
      action: "act",
      sessionId: "session_1",
      viewId: "view_1",
      viewHash: "abc123",
      actionId: "accept_result",
      report: "Observed the prompt twice.",
    });
  });

  it("surfaces recovery required ahead of ordinary active work", () => {
    const state: CreatorDashboardState = {
      ...STATE,
      controlView: { ...STATE.controlView!, status: "recovery_required" },
    };
    expect(getDashboardSurface(state, undefined)).toBe("recovery-required");
  });

  it("binds an explicit Play retry to the exact incomplete control view", () => {
    const state: CreatorDashboardState = {
      ...STATE,
      controlView: {
        ...STATE.controlView!,
        status: "awaiting_verification_retry",
        primaryAction: {
          id: "retry_play_verification",
          label: "Retry Play Verification",
          intent: "primary",
        },
      },
    };
    expect(makeActionRequest(state, "retry_play_verification", "")).toEqual({
      action: "act",
      sessionId: "session_1",
      viewId: "view_1",
      viewHash: "abc123",
      actionId: "retry_play_verification",
    });
  });
});
