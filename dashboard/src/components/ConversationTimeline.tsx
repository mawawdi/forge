import { useState } from "react";
import { dashboardStore } from "../api-store";
import { CopyButton } from "./CopyButton";
import { RichText } from "./RichText";
import { Icon, type IconName } from "./Icon";
import { AgentActivity } from "./AgentActivity";
import { ConversationVisualAttachment } from "./ConversationVisualAttachment";
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
  readonly onLoadEarlier?: () => void;
}

export function ConversationTimeline({
  state,
  snapshot,
  onLoadEarlier = dashboardStore.loadPreviousEvents,
}: ConversationTimelineProps): React.JSX.Element {
  const events = state?.eventPage?.events ?? [];
  const visibleEvents = foldActivityEvents(events);
  const last = visibleEvents.at(-1);
  if (!state) return <ConversationPlaceholder title="Loading the project conversation…" />;
  const unanchoredActions = actionsWithoutLoadedAuthorizer(state.controlView, visibleEvents);
  const latestPlan = [...visibleEvents]
    .reverse()
    .find((event) => event.eventType === "plan_revision");
  const planActions = latestPlan ? unanchoredActions.filter(isPlanAction) : [];
  const remainingActions = unanchoredActions.filter((action) => !planActions.includes(action));
  const entries = [
    ...visibleEvents.map((event) => ({ kind: "event" as const, order: event.sequence * 2, event })),
    ...(state.agentActivities ?? []).map((activity) => ({
      kind: "activity" as const,
      order: activity.afterEventSequence * 2 + 1,
      activity,
    })),
  ].sort((left, right) => left.order - right.order);
  const historyControl = state.eventPage?.nextBeforeCursor ? (
    <button
      type="button"
      className="load-history"
      disabled={snapshot.loadingHistoryFor === state.selectedConversationId}
      onClick={onLoadEarlier}
    >
      {snapshot.loadingHistoryFor === state.selectedConversationId
        ? "Loading earlier messages…"
        : "Earlier messages"}
    </button>
  ) : null;
  if (visibleEvents.length === 0)
    return (
      <section className="conversation-timeline" aria-label="Project conversation">
        {historyControl}
        <VisualWorkflowCards workflows={state.visualWorkflows ?? []} />
        {(state.controlView?.turnContract || !state.controlView) &&
        events.every(
          (event) => event.eventType === "project_identity" && event.data.state === "linked",
        ) ? (
          <EmptyConversation state={state} />
        ) : null}
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
      {historyControl}
      <VisualWorkflowCards workflows={state.visualWorkflows ?? []} />
      <ol aria-label="Messages">
        {entries.map((entry) => (
          <li key={entry.kind === "event" ? entry.event.id : entry.activity.jobId}>
            {entry.kind === "activity" ? (
              <AgentActivity activity={entry.activity} connectionLost={snapshot.connectionLost} />
            ) : (
              <EventCard
                event={entry.event}
                state={state}
                controlView={state.controlView}
                snapshot={snapshot}
                additionalActions={entry.event === latestPlan ? planActions : []}
              />
            )}
          </li>
        ))}
      </ol>
      {remainingActions.length ||
      state.controlView?.status === "recovery_required" ||
      state.controlView?.status === "blocked" ? (
        <CurrentControlCard
          state={state}
          controlView={state.controlView!}
          actions={remainingActions}
          snapshot={snapshot}
        />
      ) : null}
    </section>
  );
}

function VisualWorkflowCards({
  workflows,
}: {
  readonly workflows: NonNullable<CreatorDashboardState["visualWorkflows"]>;
}): React.JSX.Element | null {
  if (workflows.length === 0) return null;
  return (
    <ol className="visual-workflow-list" aria-label="Visual-world workflows">
      {workflows.map((workflow) => (
        <li className="visual-workflow-card" key={workflow.workflowId}>
          <div>
            <span className="visual-workflow-card__state">
              {workflow.state.replaceAll("_", " ")}
            </span>
            <h2>Visual world</h2>
            <p>{workflow.detail}</p>
          </div>
          <details>
            <summary>Details</summary>
            <dl>
              <dt>Workflow</dt>
              <dd>{workflow.workflowId}</dd>
              <dt>Current action</dt>
              <dd>{workflow.action}</dd>
              <dt>Event hash</dt>
              <dd>{workflow.eventHash}</dd>
              {Object.entries(workflow.artifactHashes).map(([name, hash]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{hash}</dd>
                </div>
              ))}
            </dl>
          </details>
        </li>
      ))}
    </ol>
  );
}

/**
 * A foreground job may publish several immutable phase boundaries. The main
 * conversation uses AgentActivity for progress. Job bookkeeping stays in
 * Details; actions on hidden records are rendered by CurrentControlCard with
 * their original authority bindings intact.
 */
function foldActivityEvents(
  events: readonly CreatorConversationEvent[],
): readonly CreatorConversationEvent[] {
  const plannedEpisodes = new Set(
    events.filter((event) => event.eventType === "plan_revision").map((event) => event.episodeId),
  );
  const latestProjectChange = new Map<string | undefined, string>();
  const latestActivity = new Map<string, string>();
  const latestPlaytest = new Map<string | undefined, string>();
  const terminalMessages = new Map<string, string>();
  const terminalSequences = new Map<string, number>();
  const completedEpisodes = new Set(
    events
      .filter((event) => event.eventType === "terminal_output" || event.eventType === "recovery")
      .map((event) => event.episodeId),
  );
  for (const event of events) {
    if (event.eventType === "terminal_output") {
      const key = creatorTerminalOutputKey(event);
      if (!terminalMessages.has(key)) terminalMessages.set(key, event.id);
      if (event.binding?.sessionId) terminalSequences.set(event.binding.sessionId, event.sequence);
    }
    if (event.eventType === "project_change") latestProjectChange.set(event.episodeId, event.id);
    if (event.eventType === "activity") latestActivity.set(event.data.job.id, event.id);
    if (event.eventType === "playtest") latestPlaytest.set(event.episodeId, event.id);
    if (event.eventType === "final_review" || event.eventType === "terminal_output")
      latestPlaytest.set(event.episodeId, "settled");
  }
  return events.filter(
    (event) =>
      (event.eventType !== "terminal_output" ||
        (event.data.outcome !== "superseded" &&
          terminalMessages.get(creatorTerminalOutputKey(event)) === event.id)) &&
      (event.eventType !== "project_change" || event.data.state === "detected") &&
      !(
        event.eventType === "recovery" &&
        event.binding?.sessionId &&
        (terminalSequences.get(event.binding.sessionId) ?? -1) > event.sequence
      ) &&
      event.eventType !== "memory" &&
      !["change_set", "mutation", "verification", "playtest", "final_review"].includes(
        event.eventType,
      ) &&
      (event.eventType !== "playtest" || latestPlaytest.get(event.episodeId) === event.id) &&
      (event.eventType !== "activity" ||
        (latestActivity.get(event.data.job.id) === event.id &&
          ["failed", "outcome_unknown"].includes(event.data.status) &&
          (!event.episodeId || !completedEpisodes.has(event.episodeId)))) &&
      !(
        event.eventType === "project_identity" &&
        event.data.state === "linked" &&
        !isExplicitProjectLinkReceipt(event)
      ) &&
      !(
        event.eventType === "decision" &&
        (!event.data.report || isSettingsDecision(event.data.decision))
      ) &&
      !(
        event.eventType === "agent_turn" &&
        event.data.outcome === "plan_proposed" &&
        plannedEpisodes.has(event.episodeId)
      ) &&
      !(
        event.eventType === "project_change" &&
        latestProjectChange.get(event.episodeId) !== event.id
      ),
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
function isExplicitProjectLinkReceipt(event: CreatorConversationEvent): boolean {
  return (
    event.eventType === "project_identity" &&
    event.authority === "studio" &&
    event.data.project.kind === "local_linked" &&
    ["linked", "forked"].includes(event.data.state) &&
    event.attachments.some((attachment) => attachment.role === "project_identity")
  );
}

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
  const readyToBuild = actions.some((action) => action.actionId === "build_plan");
  return (
    <section
      className="conversation-current-action"
      aria-labelledby="current-action-title"
      aria-live="polite"
    >
      <span className="conversation-current-action__joint" aria-hidden="true" />
      <div>
        <h2 id="current-action-title">
          {readyToBuild ? "Ready to make this?" : controlView.title}
        </h2>
        <p>
          {readyToBuild
            ? "Accept to build and apply this plan in Studio, or tell Forge what to change."
            : controlView.detail}
        </p>
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
  readonly additionalActions?: readonly CreatorControlActionDescriptor[];
}

function EventCard({
  event,
  state,
  controlView,
  snapshot,
  additionalActions = [],
}: EventCardProps): React.JSX.Element {
  const actions = [
    ...actionsForEvent(controlView, event).filter(isConversationAction),
    ...additionalActions,
  ];
  const cardClass = cardClassFor(event);
  const copyText =
    event.eventType === "creator_turn" || event.eventType === "agent_turn"
      ? event.data.text
      : event.eventType === "plan_revision"
        ? event.data.summary
        : event.eventType === "terminal_output"
          ? event.data.message
          : undefined;
  return (
    <article
      className={`conversation-event ${cardClass}`}
      data-event-id={event.id}
      aria-labelledby={`event-${event.id}`}
    >
      <header className="conversation-event__heading">
        <div>
          <h2
            id={`event-${event.id}`}
            className={event.eventType === "creator_turn" ? "sr-only" : undefined}
          >
            {eventTitle(event)}
          </h2>
        </div>
        <time dateTime={event.occurredAt} title={new Date(event.occurredAt).toLocaleString()}>
          {formatTimestamp(event.occurredAt)}
        </time>
        {copyText ? (
          <span className="message-tools">
            <CopyButton
              text={copyText}
              label={event.eventType === "plan_revision" ? "Copy plan" : "Copy message"}
            />
          </span>
        ) : null}
      </header>
      <EventBody event={event} />
      {event.eventType === "creator_turn" &&
      event.conversationId === state.selectedConversationId &&
      event.attachments.some((item) => item.role === "visual_observation") ? (
        <div className="conversation-visuals" aria-label="Submitted images">
          {event.attachments
            .filter((item) => item.role === "visual_observation")
            .slice(0, 4)
            .map((attachment, index) => (
              <ConversationVisualAttachment
                key={`${event.conversationId}:${attachment.binding.artifact.artifactHash}:${index}`}
                attachment={attachment}
                conversationId={event.conversationId}
              />
            ))}
        </div>
      ) : null}
      {actions.length ? <EventActions state={state} actions={actions} snapshot={snapshot} /> : null}
    </article>
  );
}

function MessageText({
  text,
  markdown = false,
}: {
  readonly text: string;
  readonly markdown?: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const long = !markdown && text.length > 1400;
  const firstParagraph = text.indexOf("\n\n");
  const cut = firstParagraph > 0 && firstParagraph < 700 ? firstParagraph : 700;
  return (
    <div className="message-copy">
      {markdown && (!long || expanded) ? (
        <RichText text={text} />
      ) : (
        <p>{long && !expanded ? `${text.slice(0, cut).trimEnd()}…` : text}</p>
      )}
      {long ? (
        <button
          className="message-expand"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Read full message"}
        </button>
      ) : null}
    </div>
  );
}

function PlanText({ text }: { readonly text: string }): React.JSX.Element {
  const paragraphs = text.split("\n\n");
  const steps = paragraphs.filter((paragraph) => /^\d+\. /.test(paragraph));
  const [expanded, setExpanded] = useState(false);
  const long = steps.join("\n\n").length > 2200 && steps.length > 2;
  if (steps.length === 0) return <MessageText text="Plan steps unavailable." />;
  return (
    <>
      <div className={`plan-outline${long && !expanded ? " plan-outline--collapsed" : ""}`}>
        <ol className="plan-steps">
          {(long && !expanded ? steps.slice(0, 2) : steps).map((step, index) => (
            <li key={index}>
              <RichText text={step.replace(/^\d+\. /, "")} />
            </li>
          ))}
        </ol>
      </div>
      {long ? (
        <button
          type="button"
          className="plan-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Collapse plan" : "Read complete plan"}
          <Icon name={expanded ? "arrowUp" : "arrowDown"} size={16} />
        </button>
      ) : null}
    </>
  );
}

function EventBody({ event }: Pick<EventCardProps, "event">): React.JSX.Element {
  switch (event.eventType) {
    case "creator_turn":
      return (
        <div className="creator-message">
          <MessageText text={event.data.text} />
        </div>
      );
    case "agent_turn":
      return (
        <div className="agent-message">
          <MessageText text={event.data.text} markdown />
        </div>
      );
    case "activity":
      return (
        <p>
          {/[Ee]xecution-journal|never_dispatched|[Ll]ower creator runtime/.test(event.data.message)
            ? "Forge couldn't finish this request. Open Details to inspect the saved error."
            : event.data.message}
        </p>
      );
    case "plan_revision":
      return (
        <BlueprintBody>
          <PlanText text={event.data.summary} />
        </BlueprintBody>
      );
    case "change_set":
      return (
        <BlueprintBody>
          <p>{event.data.summary}</p>
          <ul className="change-counts" aria-label="Change summary">
            {event.data.creates > 0 ? <li>{event.data.creates} added</li> : null}
            {event.data.updates > 0 ? <li>{event.data.updates} updated</li> : null}
            {event.data.moves > 0 ? <li>{event.data.moves} moved</li> : null}
            {event.data.deletes > 0 ? <li>{event.data.deletes} removed</li> : null}
            {event.data.sourceEdits > 0 ? <li>{event.data.sourceEdits} scripts edited</li> : null}
          </ul>
        </BlueprintBody>
      );
    case "playtest":
      return (
        <BlueprintBody>
          <p>{event.data.message}</p>
          <details className="playtest-guide">
            <summary>
              <Icon name="chevronRight" size={14} />
              <span>What to try</span>
            </summary>
            <CheckList label="Try it in Studio" values={event.data.creatorChecks} />
          </details>
        </BlueprintBody>
      );
    case "recovery":
      return (
        <div className="recovery-body">
          <p>{event.data.message}</p>
        </div>
      );
    case "decision":
      return event.data.report ? <p className="creator-report-copy">{event.data.report}</p> : <></>;
    case "project_change":
    case "mutation":
    case "verification":
    case "final_review":
    case "source_sync":
    case "job":
      return <p>{messageFor(event)}</p>;
    case "project_identity":
      return isExplicitProjectLinkReceipt(event) ? (
        <div className="project-link-save">
          <p>Save your place in Studio to keep this link when you reopen it.</p>
          <p className="project-link-save__hint">In Studio, choose File → Save to File.</p>
        </div>
      ) : (
        <p>{messageFor(event)}</p>
      );
    case "terminal_output":
      return <RichText text={event.data.message} />;
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
  if (actions.some((action) => action.actionId === "build_plan"))
    return <PlanActions state={state} actions={actions} snapshot={snapshot} />;
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

function isPlanAction(action: CreatorControlActionDescriptor): boolean {
  return ["build_plan", "revise_plan", "reject_plan"].includes(action.actionId);
}

function PlanActions({
  state,
  actions,
  snapshot,
}: {
  readonly state: CreatorDashboardState;
  readonly actions: readonly CreatorControlActionDescriptor[];
  readonly snapshot: DashboardSnapshot;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const revision = actions.find((action) => action.actionId === "revise_plan");
  return (
    <div className="plan-decision">
      <p>Accepting this plan builds and applies the changes in Studio.</p>
      <div className="event-actions plan-decision__choices" role="group" aria-label="Plan decision">
        {actions.map((action) =>
          action.actionId === "revise_plan" ? (
            <button
              key={action.actionInstanceId}
              type="button"
              className="control-action control-action--secondary"
              aria-expanded={editing}
              aria-controls={`plan-edit-${action.actionInstanceId}`}
              disabled={Boolean(snapshot.pendingRequest) || snapshot.connectionLost}
              onClick={() => setEditing(!editing)}
            >
              <Icon name="edit" size={16} />
              Change plan
            </button>
          ) : (
            <EventAction
              key={action.actionInstanceId}
              state={state}
              action={action}
              snapshot={snapshot}
            />
          ),
        )}
      </div>
      {editing && revision ? (
        <div className="plan-decision__editor" id={`plan-edit-${revision.actionInstanceId}`}>
          <EventAction state={state} action={revision} snapshot={snapshot} inline />
        </div>
      ) : null}
    </div>
  );
}

function EventAction({
  state,
  action,
  snapshot,
  inline = false,
}: {
  readonly state: CreatorDashboardState;
  readonly action: CreatorControlActionDescriptor;
  readonly snapshot: DashboardSnapshot;
  readonly inline?: boolean;
}): React.JSX.Element {
  const [message, setMessage] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
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
      setSubmitting(true);
      setMessage(undefined);
      await dashboardStore.submitAction(
        makeActionRequest(state, action, value, {
          ...(action.actionId === "revise_plan" ? { selectedModelId } : {}),
        }),
      );
      dashboardStore.clearActionDraft(actionKey);
      setMessage("Done. Updating your conversation…");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Forge could not accept this decision.");
    } finally {
      setSubmitting(false);
    }
  }
  const content = (
    <div className="event-action">
      {input.kind === "text" ? (
        <label>
          <span>{input.label}</span>
          {input.multiline ? (
            <textarea
              autoFocus={inline}
              placeholder={
                action.actionId === "revise_plan" ? "Tell Forge what to change…" : undefined
              }
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
      {action.actionId === "revise_plan" && !inline ? (
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
        disabled={pending || snapshot.connectionLost === true || !valid}
        onClick={() => void submit()}
      >
        <Icon name={submitting ? "more" : actionIcon(action)} size={16} />
        {submitting
          ? "Working…"
          : inline && action.actionId === "revise_plan"
            ? "Update plan"
            : action.label}
      </button>
      {message ? (
        <p role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
  return action.actionId === "revise_plan" && !inline ? (
    <details className="refine-disclosure">
      <summary>
        <Icon name="edit" size={16} />
        {action.label}
      </summary>
      {content}
    </details>
  ) : (
    content
  );
}

function actionIcon(action: CreatorControlActionDescriptor): IconName {
  if (/reject|cancel/.test(action.actionId)) return "close";
  if (/undo|revert/.test(action.actionId)) return "retry";
  if (/retry|refresh|resume|sync/.test(action.actionId)) return "retry";
  if (action.actionId === "revise_plan") return "edit";
  if (action.actionId === "link_project") return "link";
  if (/new|fork|start/.test(action.actionId)) return "plus";
  return "check";
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
      setMessage("Done. Updating your conversation…");
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
            disabled={pending || snapshot.connectionLost === true || !valid}
            onClick={() => void submit(action)}
          >
            <Icon name={actionIcon(action)} size={16} />
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
          <li key={value}>
            <RichText text={value.replace(/^Creator review:\s*/i, "")} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function eventTitle(event: CreatorConversationEvent): string {
  switch (event.eventType) {
    case "creator_turn":
      return "Your message";
    case "agent_turn":
      return "Forge";
    case "activity":
      return event.data.status === "failed" ? "Work stopped" : "Forge";
    case "plan_revision":
      return "Suggested plan";
    case "change_set":
      return "Changes ready";
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
      return isExplicitProjectLinkReceipt(event)
        ? event.data.state === "forked"
          ? "New project linked"
          : "Project linked"
        : "Project connection";
    case "terminal_output":
      return "Forge";
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
import { creatorTerminalOutputKey } from "../../../packages/creator-conversation/src/contracts";
