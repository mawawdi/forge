import { useEffect, useRef, useState } from "react";
import { dashboardStore, useDashboardSnapshot } from "../api-store";
import { byteLength, makeActionRequest } from "../derived";
import { EventActions } from "./ConversationTimeline";
import type {
  CreatorDashboardState,
  CreatorControlActionDescriptor,
  CreatorMemorySummary,
} from "../types";

const SETTINGS_TABS = ["Preferences", "Connection", "Advanced"] as const;

export function ProjectSettings({
  state,
  open,
  onClose,
  onOpenDetails,
  returnFocusTo,
}: {
  readonly state: CreatorDashboardState | undefined;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenDetails: (source: HTMLElement) => void;
  readonly returnFocusTo: HTMLElement | undefined;
}): React.JSX.Element | null {
  const snapshot = useDashboardSnapshot();
  const pending = Boolean(snapshot.pendingRequest);
  const dialog = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<(typeof SETTINGS_TABS)[number]>("Preferences");
  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => returnFocusTo?.focus();
  }, [open, returnFocusTo]);
  if (!open) return null;
  const preferenceState = state?.projectSettings
    ? {
        ...state,
        controlView: state.projectSettings.controlView,
        selectedConversationId: state.projectSettings.controlView.conversationId,
      }
    : undefined;
  const activeMemories = (state?.projectSettings?.memories ?? []).filter(
    (item) => item.state === "active",
  );
  const actions = preferenceState?.controlView?.actions ?? [];
  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="project-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (event.key !== "Tab") return;
          const controls = [
            ...(dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]',
            ) ?? []),
          ];
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="settings-heading">
          <div>
            <h2 id="project-settings-title">Project settings</h2>
            <p>
              {state?.conversations.find((item) => item.id === state.selectedConversationId)
                ?.projectName ?? state?.pairedStudio.projectName}
            </p>
          </div>
          <button type="button" aria-label="Close project settings" onClick={onClose}>
            ×
          </button>
        </header>
        <div
          className="settings-tabs"
          role="tablist"
          aria-label="Project settings sections"
          onKeyDown={(event) => {
            const index = SETTINGS_TABS.indexOf(tab);
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % SETTINGS_TABS.length
                : event.key === "ArrowLeft"
                  ? (index + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? SETTINGS_TABS.length - 1
                      : undefined;
            if (next === undefined) return;
            event.preventDefault();
            setTab(SETTINGS_TABS[next]!);
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
          }}
        >
          {SETTINGS_TABS.map((name) => (
            <button
              type="button"
              key={name}
              role="tab"
              tabIndex={tab === name ? 0 : -1}
              aria-selected={tab === name}
              aria-controls="settings-panel"
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="settings-content" id="settings-panel" role="tabpanel" aria-label={tab}>
          {tab === "Preferences" ? (
            <>
              <h3>Make Forge work your way</h3>
              <p className="settings-description">
                Save instructions for every conversation in this project.
              </p>
              {activeMemories.length ? (
                <ul className="memory-list">
                  {activeMemories.map((memory) => (
                    <MemoryItem
                      key={memory.itemId}
                      memory={memory}
                      state={preferenceState}
                      actions={actions}
                      pending={pending}
                    />
                  ))}
                </ul>
              ) : (
                <p className="context-empty">No preferences saved yet.</p>
              )}
              <RememberMemory state={preferenceState} actions={actions} pending={pending} />
            </>
          ) : tab === "Connection" ? (
            <>
              <h3>Roblox Studio</h3>
              <p>
                {state?.pairedStudio.status === "ready"
                  ? "Connected to your open place."
                  : state?.pairedStudio.status === "unpaired"
                    ? "Open the Forge connector in Studio and connect to this workspace."
                    : "Check the Forge connector in Studio."}
              </p>
              <p className="settings-description">
                Save your place with File → Save to File in Studio.
              </p>
              <button
                type="button"
                onClick={(event) => {
                  onOpenDetails(event.currentTarget);
                  onClose();
                }}
              >
                Connection details
              </button>
            </>
          ) : (
            <>
              <h3>Project identity and diagnostics</h3>
              <p className="settings-description">
                A new conversation keeps this project. A separate project identity is for a place
                you want to treat as a different project.
              </p>
              {state ? (
                <EventActions
                  state={state}
                  snapshot={snapshot}
                  actions={
                    state.controlView?.actions.filter((item) => item.actionId === "fork_project") ??
                    []
                  }
                />
              ) : null}
              <button
                type="button"
                onClick={(event) => {
                  onOpenDetails(event.currentTarget);
                  onClose();
                }}
              >
                Open technical details
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function RememberMemory({
  state,
  actions,
  pending,
}: {
  readonly state: CreatorDashboardState | undefined;
  readonly actions: readonly CreatorControlActionDescriptor[];
  readonly pending: boolean;
}): React.JSX.Element | null {
  const action = matchingAction(actions, "remember", "none");
  const memoryInput = action?.input;
  const [message, setMessage] = useState<string | undefined>();
  if (
    !state ||
    !action ||
    !memoryInput ||
    memoryInput.kind !== "text" ||
    memoryInput.field !== "memory"
  )
    return null;
  const activeState = state;
  const activeAction = action;
  const draftKey = memoryDraftKey(activeAction);
  const draft = dashboardStore.actionDraftFor(draftKey);
  const text = draft.text;
  const category = draft.memoryCategory ?? "preference";
  const valid = !pending && Boolean(text.trim()) && withinBounds(text, activeAction);
  async function remember(): Promise<void> {
    try {
      setMessage(undefined);
      await dashboardStore.submitAction(
        makeActionRequest(activeState, activeAction, text, { memoryCategory: category }),
      );
      dashboardStore.clearActionDraft(draftKey);
      setMessage("Saving your preference…");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Forge could not save this memory.");
    }
  }
  return (
    <form
      className="memory-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void remember();
      }}
    >
      <label htmlFor="project-memory">Add a preference</label>
      <textarea
        id="project-memory"
        value={text}
        onChange={(event) =>
          dashboardStore.updateActionDraft(draftKey, { ...draft, text: event.target.value })
        }
        placeholder="For example, keep gameplay logic on the server…"
        disabled={pending}
      />
      <div>
        <label>
          <span>Type</span>
          <select
            value={category}
            disabled={pending}
            onChange={(event) =>
              dashboardStore.updateActionDraft(draftKey, {
                ...draft,
                memoryCategory: event.target.value as CreatorMemorySummary["category"],
              })
            }
          >
            <option value="preference">Preference</option>
            <option value="convention">Convention</option>
            <option value="vocabulary">Vocabulary</option>
            <option value="goal">Goal</option>
            <option value="unresolved">Open question</option>
          </select>
        </label>
        <button type="submit" disabled={!valid}>
          {pending ? "Saving…" : "Save preference"}
        </button>
      </div>
      {byteLength(text) > memoryInput.maximumBytes * 0.9 ? (
        <small>
          {byteLength(text)}/{memoryInput.maximumBytes} bytes
        </small>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

function MemoryItem({
  memory,
  state,
  actions,
  pending,
}: {
  readonly memory: CreatorMemorySummary;
  readonly state: CreatorDashboardState | undefined;
  readonly actions: readonly CreatorControlActionDescriptor[];
  readonly pending: boolean;
}): React.JSX.Element {
  const [correcting, setCorrecting] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const target = {
    kind: "memory_head" as const,
    itemId: memory.itemId,
    revisionId: memory.revisionId,
    revisionHash: memory.revisionHash,
  };
  const correct = matchingAction(actions, "correct_memory", "memory_head");
  const pin = matchingAction(actions, memory.pinned ? "unpin_memory" : "pin_memory", "memory_head");
  const forget = matchingAction(actions, "forget_memory", "memory_head");
  const correctionDraftKey = correct ? memoryDraftKey(correct, memory) : undefined;
  const correctionDraft = correctionDraftKey
    ? dashboardStore.actionDraftFor(correctionDraftKey)
    : undefined;
  const correction =
    correctionDraftKey && dashboardStore.hasActionDraft(correctionDraftKey)
      ? (correctionDraft?.text ?? "")
      : memory.text;

  async function submit(action: CreatorControlActionDescriptor, text = ""): Promise<void> {
    if (!state) return;
    try {
      setMessage(undefined);
      await dashboardStore.submitAction(makeActionRequest(state, action, text, { target }));
      if (action.actionId === "correct_memory") {
        if (correctionDraftKey) dashboardStore.clearActionDraft(correctionDraftKey);
        setCorrecting(false);
      }
      setMessage("Saving your changes…");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Forge could not update this memory.");
    }
  }

  return (
    <li>
      <span>{memory.pinned ? "Pinned" : memory.category}</span>
      <p>{memory.text}</p>
      <div
        className="memory-item__actions"
        role="group"
        aria-label={`Actions for saved preference: ${memory.text}`}
      >
        {correct ? (
          <button
            type="button"
            aria-expanded={correcting}
            disabled={pending}
            onClick={() => setCorrecting((value) => !value)}
          >
            {correct.label}
          </button>
        ) : null}
        {pin ? (
          <button type="button" disabled={pending} onClick={() => void submit(pin)}>
            {pending ? "Working…" : pin.label}
          </button>
        ) : null}
        {forget ? (
          <button type="button" disabled={pending} onClick={() => void submit(forget)}>
            {pending ? "Working…" : forget.label}
          </button>
        ) : null}
      </div>
      {correcting && correct?.input.kind === "text" ? (
        <form
          className="memory-correction"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(correct, correction);
          }}
        >
          <label>
            <span>Correct saved memory</span>
            <textarea
              value={correction}
              disabled={pending}
              onChange={(event) => {
                if (!correctionDraftKey) return;
                dashboardStore.updateActionDraft(correctionDraftKey, { text: event.target.value });
              }}
            />
          </label>
          <button
            type="submit"
            disabled={pending || !Boolean(correction.trim()) || !withinBounds(correction, correct)}
          >
            {pending ? "Working…" : correct.label}
          </button>
        </form>
      ) : null}
      {message ? (
        <p className="memory-item__status" role="status">
          {message}
        </p>
      ) : null}
    </li>
  );
}

function memoryDraftKey(
  action: CreatorControlActionDescriptor,
  memory?: CreatorMemorySummary,
): string {
  return memory
    ? `memory:${action.actionInstanceId}:${memory.itemId}:${memory.revisionHash}`
    : `memory:${action.actionInstanceId}`;
}

function matchingAction(
  actions: readonly CreatorControlActionDescriptor[],
  actionId: CreatorControlActionDescriptor["actionId"],
  target: CreatorControlActionDescriptor["target"],
): CreatorControlActionDescriptor | undefined {
  return actions.find((action) => action.actionId === actionId && action.target === target);
}

function withinBounds(value: string, action: CreatorControlActionDescriptor): boolean {
  if (action.input.kind !== "text") return false;
  const bytes = byteLength(value);
  return bytes >= action.input.minimumBytes && bytes <= action.input.maximumBytes;
}
