import { useEffect, useRef, useState } from "react";
import type { CreatorDashboardState } from "../types";
import { Icon } from "./Icon";
import { RichText } from "./RichText";
import { robloxPathsInText } from "../../../packages/studio-path/src/index.js";

export function AgentActivity({
  activity,
  connectionLost,
}: {
  readonly activity: NonNullable<CreatorDashboardState["agentActivities"]>[number];
  readonly connectionLost: boolean | undefined;
}): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now());
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      const element = disclosure.current;
      if (!element?.open) return;
      if (event.key !== "Escape" || !element.contains(document.activeElement)) return;
      element.open = false;
      element.querySelector("summary")?.focus();
    };
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("keydown", close);
    };
  }, []);
  useEffect(() => {
    if (!activity?.running || connectionLost) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activity?.running, connectionLost]);
  const seconds = Math.max(
    0,
    Math.floor(
      ((activity.running ? now : Date.parse(activity.updatedAt)) - Date.parse(activity.startedAt)) /
        1000,
    ),
  );
  const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const working = activity.running && !connectionLost;
  return (
    <section
      className={`agent-activity${activity.running ? " agent-activity--working" : ""}`}
      aria-label="Agent activity"
    >
      {activity.commentary.map((message) => (
        <div className="agent-commentary" key={message.sequence}>
          <RichText text={message.text} />
        </div>
      ))}
      <details ref={disclosure} className="agent-activity__disclosure">
        <summary className="agent-activity__heading">
          <Icon name="chevronRight" size={15} />
          <span
            className={working ? "agent-progress-text is-scanning" : "agent-progress-text"}
            aria-live="polite"
            aria-atomic="true"
          >
            {connectionLost && activity.running
              ? "Waiting for live updates"
              : activity.running
                ? robloxPathsInText(activity.currentStep)
                : activity.currentStep === "Work finished"
                  ? `Worked for ${duration}`
                  : robloxPathsInText(activity.currentStep)}
          </span>
          {activity.running ? <time>{duration}</time> : null}
        </summary>
        <div className="agent-activity__panel">
          {activity.agentRunId ? (
            <>
              <p className="agent-activity__metrics">
                {activity.steps.length} steps · {activity.modelTurns} model requests
              </p>
              <ol aria-label="Steps in chronological order">
                {activity.steps.map((step) => (
                  <li
                    key={step.sequence}
                    className={step.status === "failed" ? "is-failed" : undefined}
                  >
                    <details className="agent-step">
                      <summary>
                        <span role="img" aria-label={step.status}>
                          <Icon
                            name={step.status === "failed" ? "retry" : stepIcon(step.label)}
                            size={16}
                          />
                        </span>
                        <span>{robloxPathsInText(step.label)}</span>
                        <Icon name="chevronRight" size={13} />
                      </summary>
                      <div className="agent-step__detail">
                        {step.toolName ? <code>{step.toolName}</code> : null}
                        <p>
                          {robloxPathsInText(step.detail) ||
                            (step.status === "failed"
                              ? "This step needs a correction."
                              : "Completed successfully.")}
                        </p>
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p>Updating your project in Studio.</p>
          )}
          {activity.usage ? (
            <details className="agent-activity__usage">
              <summary>
                Usage
                {activity.usage.costUsd !== null ? ` · $${activity.usage.costUsd.toFixed(3)}` : ""}
              </summary>
              <dl>
                <div>
                  <dt>Input tokens</dt>
                  <dd>{activity.usage.inputTokens?.toLocaleString() ?? "Not reported"}</dd>
                </div>
                <div>
                  <dt>Output tokens</dt>
                  <dd>{activity.usage.outputTokens?.toLocaleString() ?? "Not reported"}</dd>
                </div>
                {activity.usage.reasoningTokens !== null ? (
                  <div>
                    <dt>Reasoning tokens</dt>
                    <dd>{activity.usage.reasoningTokens.toLocaleString()}</dd>
                  </div>
                ) : null}
                {activity.usage.cacheReadTokens !== null ? (
                  <div>
                    <dt>Cached input tokens</dt>
                    <dd>{activity.usage.cacheReadTokens.toLocaleString()}</dd>
                  </div>
                ) : null}
              </dl>
              <p>Reported by the provider. Usage adds up across all requests in this run.</p>
            </details>
          ) : null}
        </div>
      </details>
    </section>
  );
}

function stepIcon(label: string): "search" | "file" | "code" | "check" {
  if (/search|explor|inspect|found/i.test(label)) return "search";
  if (/read|consult/i.test(label)) return "file";
  if (/writ|edit|updat|stag|patch|creat/i.test(label)) return "code";
  return "check";
}
