import { useEffect, useState } from "react";
import type { CreatorDashboardState } from "../types";

export function AgentActivity({
  state,
  onOpenDetails,
}: {
  readonly state: CreatorDashboardState | undefined;
  readonly onOpenDetails: (source: HTMLElement) => void;
}): React.JSX.Element | null {
  const activity = state?.agentActivity;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!activity?.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activity?.running]);
  if (!activity) return null;
  const seconds = Math.max(
    0,
    Math.floor(
      ((activity.running ? now : Date.parse(activity.updatedAt)) - Date.parse(activity.startedAt)) /
        1000,
    ),
  );
  return (
    <section className="agent-activity" aria-label="Agent activity">
      <div className="agent-activity__heading">
        <span
          className={`activity-indicator${activity.running ? " is-running" : ""}`}
          aria-hidden="true"
        />
        <strong>{activity.running ? activity.currentStep : "Agent activity"}</strong>
        <time>
          {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
        </time>
      </div>
      <details open={activity.running}>
        <summary>
          {activity.steps.length} steps{activity.running ? "" : ` · ${activity.currentStep}`}
        </summary>
        <ol>
          {activity.steps.map((step) => (
            <li key={step.sequence} className={step.status === "failed" ? "is-failed" : undefined}>
              <span aria-label={step.status}>{step.status === "complete" ? "✓" : "!"}</span>
              <span>
                {step.label}
                {step.detail ? <small>{step.detail}</small> : null}
              </span>
            </li>
          ))}
        </ol>
        <button type="button" onClick={(event) => onOpenDetails(event.currentTarget)}>
          View run details
        </button>
      </details>
    </section>
  );
}
