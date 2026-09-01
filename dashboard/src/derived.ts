import type {
  CreatorActionId,
  CreatorControlAction,
  CreatorDashboardState,
  CreatorSessionStatus,
  DashboardActionRequest,
} from "./types";

export type DashboardSurface =
  | "loading"
  | "api-error"
  | "unpaired"
  | "empty"
  | "active"
  | "incomplete"
  | "recovery-required"
  | "terminal";

const terminalStatuses = new Set<CreatorSessionStatus>([
  "creator_accepted",
  "creator_rejected",
  "rolled_back",
]);

export function getDashboardSurface(
  state: CreatorDashboardState | undefined,
  error: string | undefined,
): DashboardSurface {
  if (error) return "api-error";
  if (!state) return "loading";
  if (state.pairedStudio.status === "unpaired") return "unpaired";
  if (!state.controlView && state.sessions.length === 0) return "empty";
  const status = state.controlView?.status;
  if (status === "incomplete") return "incomplete";
  if (status === "recovery_required") return "recovery-required";
  if (status && terminalStatuses.has(status)) return "terminal";
  return "active";
}

export function hasRequiredReport(
  action: CreatorControlAction,
  report: string,
): boolean {
  if (!requiresCreatorReport(action)) return true;
  const length = reportByteLength(report.trim());
  return length >= 1 && length <= 4096;
}

export function reportByteLength(report: string): number {
  return new TextEncoder().encode(report).byteLength;
}

export function makeActionRequest(
  state: CreatorDashboardState,
  actionId: CreatorActionId,
  report: string,
): DashboardActionRequest {
  const view = state.controlView;
  if (!view) throw new Error("There is no current creator control view.");
  const action = [view.primaryAction, view.secondaryAction].find(
    (candidate) => candidate?.id === actionId,
  );
  if (!action) throw new Error("That action is not available in the current control view.");
  if (!hasRequiredReport(action, report)) {
    throw new Error("Record a 1–4096 byte observation before finalizing this result.");
  }
  const creatorReport = requiresCreatorReport(action) ? report.trim() : undefined;
  return {
    action: "act",
    sessionId: view.creatorSessionId,
    viewId: view.id,
    viewHash: view.hash,
    actionId,
    ...(creatorReport ? { report: creatorReport } : {}),
  };
}

function requiresCreatorReport(action: CreatorControlAction): boolean {
  return action.requiresReport || action.id === "accept_result" || action.id === "reject_and_rollback";
}

export function formatStatus(status: CreatorSessionStatus): string {
  return status.replaceAll("_", " ");
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
