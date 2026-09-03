import { useState } from "react";
import { dashboardStore } from "../api-store";
import {
  actionsForEvent,
  byteLength,
  eventLabel,
  formatTimestamp,
  makeActionRequest,
} from "../derived";
import type {
  CreatorControlActionDescriptor,
  CreatorControlView,
  CreatorConversationEvent,
  CreatorDashboardState,
  DashboardSnapshot,
} from "../types";

interface ConversationTimelineProps {
  readonly state: CreatorDashboardState | undefined;
  readonly snapshot: DashboardSnapshot;
  readonly onOpenDetails: (event: CreatorConversationEvent, source: HTMLElement) => void;
}

export function ConversationTimeline({
  state,
  snapshot,
  onOpenDetails,
}: ConversationTimelineProps): React.JSX.Element {
  const events = state?.eventPage?.events ?? [];
  const visibleEvents = foldActivityEvents(events, state?.controlView);
  const last = visibleEvents.at(-1);
  if (!state) return <ConversationPlaceholder title="Loading the project conversation…" />;
  const unanchoredActions = actionsWithoutLoadedAuthorizer(state.controlView, events);
  if (visibleEvents.length === 0)
    return (
      <section className="conversation-timeline" aria-label="Project conversation">
        <EmptyConversation state={state} />
        {state.controlView && (unanchoredActions.length > 0 || !state.controlView.turnContract) ? (
          <CurrentControlCard
            state={state}
            controlView={state.controlView!}
            actions={unanchoredActions}
            snapshot={snapshot}
          />
        ) : null}
      </section>
    );
  return (
    <section className="conversation-timeline" aria-label="Project conversation">
      <p className="sr-only" role="status" aria-live="polite">
        {last ? `${eventLabel(last)} added to the conversation.` : ""}
      </p>
      {state.eventPage?.nextBeforeCursor ? (
        <button type="button" className="load-history" onClick={dashboardStore.loadPreviousEvents}>
          Load earlier conversation
        </button>
      ) : null}
      <ol>
        {visibleEvents.map((event) => (
          <li key={event.id}>
            <EventCard
              event={event}
              state={state}
              controlView={state.controlView}
              snapshot={snapshot}
              onOpenDetails={onOpenDetails}
            />
          </li>
        ))}
      </ol>
      {unanchoredActions.length ||
      state.controlView?.status === "recovery_required" ||
      state.controlView?.status === "blocked" ? (
        <CurrentControlCard
          state={state}
          controlView={state.controlView!}
          actions={unanchoredActions}
          snapshot={snapshot}
        />
      ) : null}
    </section>
  );
}

/**
 * A foreground job may publish several immutable phase boundaries. The main
 * conversation presents the latest durable boundary for that job as one live
 * activity card; the complete sequence remains available in Technical details.
 */
function foldActivityEvents(
  events: readonly CreatorConversationEvent[],
  controlView: CreatorControlView | undefined,
): readonly CreatorConversationEvent[] {
  const latestActivityByJob = new Map<string, string>();
  const actionAuthorities = new Set(
    controlView?.actions
      .filter(isConversationAction)
      .map((action) => `${action.authorizingEventId}:${action.authorizingEventHash}`) ?? [],
  );
  for (const event of events) {
    if (event.eventType === "activity") latestActivityByJob.set(event.data.job.id, event.id);
  }
  return events.filter(
    (event) =>
      event.eventType !== "memory" &&
      !(event.eventType === "project_identity" && event.data.state === "linked") &&
      !(event.eventType === "decision" && isSettingsDecision(event.data.decision)) &&
      (event.eventType !== "activity" ||
        ((event.data.status === "failed" || event.data.status === "outcome_unknown") &&
          latestActivityByJob.get(event.data.job.id) === event.id) ||
        actionAuthorities.has(`${event.id}:${event.hash}`)),
  );
}

/**
 * Most actions live on the exact immutable event that authorizes them. Some
 * control-plane authorities intentionally precede a conversation event (for
 * example, linking an unpublished place) or are backed by a durable job that
 * is not itself a timeline event. Keep those actions usable without inventing
 * a transcript event, while never duplicating an action whose exact event is
 * already loaded.
 */
function actionsWithoutLoadedAuthorizer(
  controlView: CreatorControlView | undefined,
  events: readonly CreatorConversationEvent[],
): readonly CreatorControlActionDescriptor[] {
  if (!controlView) return [];
  const loadedAuthorities = new Set(events.map((event) => `${event.id}:${event.hash}`));
  return controlView.actions.filter(
    (action) =>
      isConversationAction(action) &&
      !loadedAuthorities.has(`${action.authorizingEventId}:${action.authorizingEventHash}`),
  );
}

function CurrentControlCard({
  state,
  controlView,
  actions,
  snapshot,
}: {
  readonly state: CreatorDashboardState;
  readonly controlView: CreatorControlView;
  readonly actions: readonly CreatorControlActionDescriptor[];
  readonly snapshot: DashboardSnapshot;
}): React.JSX.Element {
  return (
    <section
      className="conversation-current-action"
      aria-labelledby="current-action-title"
      aria-live="polite"
    >
      <span className="conversation-current-action__joint" aria-hidden="true" />
      <div>
        <h2 id="current-action-title">{controlView.title}</h2>
        <p>{controlView.detail}</p>
        <EventActions state={state} actions={actions} snapshot={snapshot} />
      </div>
    </section>
  );
}

function EmptyConversation({
  state,
}: {
  readonly state: CreatorDashboardState;
}): React.JSX.Element {
  const title =
    state.pairedStudio.status === "unpaired"
      ? "Connect to an open Studio place"
      : "What do you want to make?";
  const message =
    state.pairedStudio.status === "unpaired"
      ? "Open your place in Roblox Studio, then connect the Forge plugin to get started."
      : "Build something new, fix what’s broken, or get to know your project.";
  return (
    <section className="conversation-empty" aria-labelledby="empty-conversation-title">
      <div className="welcome-mark" aria-hidden="true">
        <svg width="29" height="29" viewBox="0 0 32 32" fill="none">
          <path d="M6 27V5h21v6H13v4h11v6H13v6H6Z" fill="currentColor" />
        </svg>
      </div>
      <h2 id="empty-conversation-title">{title}</h2>
      <p>{message}</p>
      {state.controlView?.turnContract ? (
        <div className="conversation-starters">
          {[
            {
              label: "Explore the project",
              text: "Explore this project and explain how it works.",
            },
            { label: "Build a feature", text: "I’d like to add " },
            { label: "Fix a bug", text: "Help me fix a bug: " },
          ].map((starter) => (
            <button
              type="button"
              key={starter.label}
              onClick={() => {
                const draft = dashboardStore.draftFor(state.selectedConversationId);
                dashboardStore.updateDraft(state.selectedConversationId, {
                  ...draft,
                  text: draft.text || starter.text,
                });
                document.getElementById("forge-message")?.focus();
              }}
            >
              {starter.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ConversationPlaceholder({ title }: { readonly title: string }): React.JSX.Element {
  return (
    <section className="conversation-empty" aria-live="polite">
      <span className="conversation-empty__joint" aria-hidden="true" />
      <p>{title}</p>
    </section>
  );
}

interface EventCardProps {
  readonly event: CreatorConversationEvent;
  readonly state: CreatorDashboardState;
  readonly controlView: CreatorControlView | undefined;
  readonly snapshot: DashboardSnapshot;
  readonly onOpenDetails: (event: CreatorConversationEvent, source: HTMLElement) => void;
}

function EventCard({
  event,
  state,
  controlView,
  snapshot,
  onOpenDetails,
}: EventCardProps): React.JSX.Element {
  const actions = actionsForEvent(controlView, event).filter(isConversationAction);
  const cardClass = cardClassFor(event);
  return (
    <article className={`conversation-event ${cardClass}`} aria-labelledby={`event-${event.id}`}>
      <header className="conversation-event__heading">
        <div>
          <h2 id={`event-${event.id}`}>{eventTitle(event)}</h2>
        </div>
        <time dateTime={event.occurredAt}>{formatTimestamp(event.occurredAt)}</time>
        <button
          type="button"
          className="event-details-toggle"
          aria-label="Details"
          title="Message details"
          onClick={(click) => onOpenDetails(event, click.currentTarget)}
        >
          ···
        </button>
      </header>
      <EventBody event={event} onOpenDetails={onOpenDetails} />
      {actions.length ? <EventActions state={state} actions={actions} snapshot={snapshot} /> : null}
    </article>
  );
}

function EventBody({
  event,
  onOpenDetails,
}: Pick<EventCardProps, "event" | "onOpenDetails">): React.JSX.Element {
  switch (event.eventType) {
    case "creator_turn":
      return (
        <div className="creator-message">
          <p>{event.data.text}</p>
        </div>
      );
    case "agent_turn":
      return (
        <div className="agent-message">
          <p>{event.data.text}</p>
          <div className="agent-message__meta">
            {event.data.citations.length ? (
              <button type="button" onClick={(click) => onOpenDetails(event, click.currentTarget)}>
                {event.data.citations.length} citation
                {event.data.citations.length === 1 ? "" : "s"}
              </button>
            ) : null}
          </div>
        </div>
      );
    case "activity":
      return <ActivityBody phase={event.data.phase} message={event.data.message} />;
    case "plan_revision":
      return (
        <BlueprintBody>
          <p>{event.data.summary}</p>
        </BlueprintBody>
      );
    case "change_set":
      return (
        <BlueprintBody>
          <p>{event.data.summary}</p>
          <ul className="change-counts" aria-label="Change summary">
            <li>{event.data.creates} added</li>
            <li>{event.data.updates} updated</li>
            <li>{event.data.moves} moved</li>
            <li>{event.data.deletes} removed</li>
            <li>{event.data.sourceEdits} source edits</li>
          </ul>
        </BlueprintBody>
      );
    case "playtest":
      return (
        <BlueprintBody>
          <p>{event.data.message}</p>
          <CheckList
            label={event.data.state === "complete" ? "Forge checked" : "Checks to run"}
            values={event.data.machineChecks}
          />
          <CheckList label="Check this yourself" values={event.data.creatorChecks} />
        </BlueprintBody>
      );
    case "recovery":
      return (
        <div className="recovery-body">
          <p>{event.data.message}</p>
          <strong>
            {event.data.studioMayContainOpenRecording
              ? "An unfinished change may still be open in Studio."
              : "Forge has not found an unfinished change in Studio."}
          </strong>
        </div>
      );
    case "decision":
      return event.data.report ? (
        <p className="creator-report-copy">{event.data.report}</p>
      ) : (
        <p>The creator recorded: {event.data.decision}.</p>
      );
    case "project_change":
    case "mutation":
    case "verification":
    case "final_review":
    case "source_sync":
    case "job":
    case "project_identity":
    case "terminal_output":
      return <p>{messageFor(event)}</p>;
    case "memory":
      return <p>The creator updated the project memory: {event.data.operation}.</p>;
  }
}

export function EventActions({
  state,
  actions,
  snapshot,
}: {
  readonly state: CreatorDashboardState;
  readonly actions: readonly CreatorControlActionDescriptor[];
  readonly snapshot: DashboardSnapshot;
}): React.JSX.Element {
  const sharedReportActions = actions.filter(isSharedReportAction);
  const firstSharedReportAction = sharedReportActions[0];
  return (
    <div className="event-actions" role="group" aria-label="Available actions">
      {actions.map((action) => {
        if (isSharedReportAction(action)) {
          if (action !== firstSharedReportAction) return null;
          return (
            <ReviewActions
              key={action.actionInstanceId}
              state={state}
              actions={sharedReportActions}
              snapshot={snapshot}
            />
          );
        }
        return (
          <EventAction
            key={action.actionInstanceId}
            state={state}
            action={action}
            snapshot={snapshot}
          />
        );
      })}
    </div>
  );
}

function EventAction({
  state,
  action,
  snapshot,
}: {
  readonly state: CreatorDashboardState;
  readonly action: CreatorControlActionDescriptor;
  readonly snapshot: DashboardSnapshot;
}): React.JSX.Element {
  const [message, setMessage] = useState<string | undefined>();
  const input = action.input;
  const pending = Boolean(snapshot.pendingRequest);
  const actionKey = actionDraftKey(action);
  const actionDraft = dashboardStore.actionDraftFor(actionKey);
  const value = actionDraft.text;
  const conversationDraft = dashboardStore.draftFor(state.selectedConversationId);
  const selectedModelId = conversationDraft.modelId ?? state.modelRegistry.defaultModelId;
  const selectedModel = state.modelRegistry.models.find((model) => model.id === selectedModelId);
  const refinementModelValid =
    action.actionId !== "revise_plan" || selectedModel?.availability === "available";
  const bytes = byteLength(value);
  const valid =
    refinementModelValid &&
    (input.kind === "none" ||
      (Boolean(value.trim()) && bytes >= input.minimumBytes && bytes <= input.maximumBytes));
  async function submit(): Promise<void> {
    try {
      setMessage(undefined);
      await dashboardStore.submitAction(
        makeActionRequest(state, action, value, {
          ...(action.actionId === "revise_plan" ? { selectedModelId } : {}),
        }),
      );
      dashboardStore.clearActionDraft(actionKey);
      setMessage("Forge accepted this decision and will record the outcome shortly.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Forge could not accept this decision.");
    }
  }
  const content = (
    <div className="event-action">
      {input.kind === "text" ? (
        <label>
          <span>{input.label}</span>
          {input.multiline ? (
            <textarea
              value={value}
              onChange={(event) =>
                dashboardStore.updateActionDraft(actionKey, { text: event.target.value })
              }
            />
          ) : (
            <input
              value={value}
              onChange={(event) =>
                dashboardStore.updateActionDraft(actionKey, { text: event.target.value })
              }
            />
          )}
          {bytes > input.maximumBytes * 0.9 ? (
            <small>
              {bytes}/{input.maximumBytes} bytes
            </small>
          ) : null}
        </label>
      ) : null}
      {action.actionId === "revise_plan" ? (
        <label>
          <span>Model</span>
          <select
            value={selectedModelId}
            disabled={pending}
            onChange={(event) =>
              dashboardStore.updateDraft(state.selectedConversationId, {
                ...conversationDraft,
                modelId: event.target.value,
              })
            }
          >
            {state.modelRegistry.models.map((model) => (
              <option key={model.id} value={model.id} disabled={model.availability !== "available"}>
                {model.displayName}
                {model.availability !== "available" ? " (unavailable)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button
        type="button"
        className={`control-action control-action--${action.intent}`}
        disabled={pending || !valid}
        onClick={() => void submit()}
      >
        {pending ? "Working…" : action.label}
      </button>
      {message ? (
        <p role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
  return action.actionId === "revise_plan" ? (
    <details className="refine-disclosure">
      <summary>{action.label}</summary>
      {content}
    </details>
  ) : (
    content
  );
}

/**
 * Final review has two mutually exclusive decisions but one creator report.
 * Keep the exact decision buttons distinct while avoiding two competing report
 * fields and retaining the authored text across a transient view refresh.
 */
function ReviewActions({
  state,
  actions,
  snapshot,
}: {
  readonly state: CreatorDashboardState;
  readonly actions: readonly CreatorControlActionDescriptor[];
  readonly snapshot: DashboardSnapshot;
}): React.JSX.Element {
  const [message, setMessage] = useState<string | undefined>();
  const input = actions[0]?.input;
  if (!input || input.kind !== "text") return <></>;
  const actionKey = reviewDraftKey(actions);
  const value = dashboardStore.actionDraftFor(actionKey).text;
  const bytes = byteLength(value);
  const pending = Boolean(snapshot.pendingRequest);
  const valid = Boolean(value.trim()) && bytes >= input.minimumBytes && bytes <= input.maximumBytes;
  const inputId = `review-report-${actions[0]?.actionInstanceId ?? "current"}`;

  async function submit(action: CreatorControlActionDescriptor): Promise<void> {
    try {
      setMessage(undefined);
      await dashboardStore.submitAction(makeActionRequest(state, action, value));
      dashboardStore.clearActionDraft(actionKey);
      setMessage("Forge accepted this decision and will record the outcome shortly.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Forge could not accept this decision.");
    }
  }

  return (
    <div className="event-action event-action--review">
      <label htmlFor={inputId}>
        <span>{input.label}</span>
        <textarea
          id={inputId}
          value={value}
          disabled={pending}
          onChange={(event) =>
            dashboardStore.updateActionDraft(actionKey, { text: event.target.value })
          }
        />
        {bytes > input.maximumBytes * 0.9 ? (
          <small>
            {bytes}/{input.maximumBytes} bytes
          </small>
        ) : null}
      </label>
      <div className="event-action__choices" role="group" aria-label="Final review decision">
        {actions.map((action) => (
          <button
            key={action.actionInstanceId}
            type="button"
            className={`control-action control-action--${action.intent}`}
            disabled={pending || !valid}
            onClick={() => void submit(action)}
          >
            {pending ? "Working…" : action.label}
          </button>
        ))}
      </div>
      {message ? (
        <p role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function isSharedReportAction(action: CreatorControlActionDescriptor): boolean {
  return (
    (action.actionId === "keep_changes" || action.actionId === "undo_changes") &&
    action.input.kind === "text" &&
    action.input.field === "report"
  );
}

function actionDraftKey(action: CreatorControlActionDescriptor): string {
  return `action:${action.actionInstanceId}`;
}

function reviewDraftKey(actions: readonly CreatorControlActionDescriptor[]): string {
  return `review:${actions
    .map((action) => action.actionInstanceId)
    .sort()
    .join(":")}`;
}

function BlueprintBody({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <div className="blueprint-body">{children}</div>;
}

function ActivityBody({
  phase,
  message,
}: {
  readonly phase: string;
  readonly message: string;
}): React.JSX.Element {
  return (
    <div className="activity-body">
      <span className="activity-body__pulse" aria-hidden="true" />
      <div>
        <strong>
          {phase === "stopped" ? "Couldn’t finish this request" : "Working on your request"}
        </strong>
        <p>{message}</p>
      </div>
    </div>
  );
}

function CheckList({
  label,
  values,
}: {
  readonly label: string;
  readonly values: readonly string[];
}): React.JSX.Element | null {
  if (!values.length) return null;
  return (
    <section className="check-list" aria-label={label}>
      <h3>{label}</h3>
      <ul>
        {values.map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ul>
    </section>
  );
}

function eventTitle(event: CreatorConversationEvent): string {
  switch (event.eventType) {
    case "creator_turn":
      return "You";
    case "agent_turn":
      return "Forge";
    case "activity":
      return event.data.status === "failed" ? "Work stopped" : "Forge";
    case "plan_revision":
      return "Suggested plan";
    case "change_set":
      return "Exact changes are ready";
    case "project_change":
      return event.data.state === "detected"
        ? "Forge noticed a project edit"
        : "Project revision update";
    case "mutation":
      return event.data.status.replaceAll("_", " ");
    case "playtest":
      return playtestTitle(event.data.state);
    case "verification":
      return event.data.status === "incomplete"
        ? "Forge couldn't confirm everything"
        : `Checks ${event.data.status}`;
    case "final_review":
      return event.data.state === "requested" ? "How did it feel?" : "Creator review";
    case "recovery":
      return "Reconnect Studio to safely finish this change";
    case "source_sync":
      return "Studio source sync";
    case "decision":
      return event.data.decision.replaceAll("_", " ");
    case "memory":
      return "Project memory updated";
    case "job":
      return "Forge job";
    case "project_identity":
      return "Project connection";
    case "terminal_output":
      return "Work result";
  }
}

function messageFor(
  event: Exclude<
    CreatorConversationEvent,
    {
      readonly eventType:
        | "creator_turn"
        | "agent_turn"
        | "activity"
        | "plan_revision"
        | "change_set"
        | "playtest"
        | "recovery"
        | "decision"
        | "memory";
    }
  >,
): string {
  switch (event.eventType) {
    case "project_change":
      return event.data.message;
    case "mutation":
      return event.data.message;
    case "verification":
      return event.data.status === "passed"
        ? "The automated checks passed."
        : event.data.failureFacts.map((fact) => fact.statement).join(" ") ||
            "Forge recorded the check result.";
    case "final_review":
      return event.data.message;
    case "source_sync":
      return event.data.message;
    case "job":
      return event.data.message;
    case "project_identity":
      return event.data.message;
    case "terminal_output":
      return event.data.message;
  }
}

function playtestTitle(
  state: "ready" | "waiting" | "observing" | "complete" | "incomplete",
): string {
  return {
    ready: "Ready to test",
    waiting: "Waiting for Play",
    observing: "Watching your test",
    complete: "Checks complete",
    incomplete: "Forge couldn't confirm everything",
  }[state];
}

function isSettingsDecision(decision: string): boolean {
  return [
    "new_conversation",
    "remember",
    "correct_memory",
    "pin_memory",
    "unpin_memory",
    "forget_memory",
  ].includes(decision);
}

function isConversationAction(action: CreatorControlActionDescriptor): boolean {
  return (
    !isSettingsDecision(action.actionId) &&
    !["fork_project", "new_conversation"].includes(action.actionId)
  );
}

function cardClassFor(event: CreatorConversationEvent): string {
  if (event.eventType === "verification" && event.data.status !== "passed")
    return "conversation-event--sheet conversation-event--attention";
  if (event.eventType === "playtest" && event.data.state === "incomplete")
    return "conversation-event--sheet conversation-event--attention";
  if (["plan_revision", "change_set", "playtest", "verification"].includes(event.eventType))
    return "conversation-event--sheet";
  if (event.eventType === "recovery") return "conversation-event--attention";
  if (event.eventType === "creator_turn") return "conversation-event--creator";
  if (event.eventType === "activity") return "conversation-event--activity";
  return "conversation-event--ordinary";
}
