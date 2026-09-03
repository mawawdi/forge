import { useEffect, useRef, useState } from "react";
import { dashboardStore, useDashboardSnapshot } from "../api-store";
import { makeActionRequest } from "../derived";
import type { CreatorConversationSummary, CreatorDashboardState } from "../types";

export function ProjectRail({
  conversations,
  state,
  selectedConversationId,
  open,
  drawer,
  onSelect,
  onClose,
}: {
  readonly conversations: readonly CreatorConversationSummary[];
  readonly state: CreatorDashboardState | undefined;
  readonly selectedConversationId: string | undefined;
  readonly open: boolean;
  readonly drawer: boolean;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const pending = Boolean(useDashboardSnapshot().pendingRequest);
  const action = state?.controlView?.actions.find((item) => item.actionId === "new_conversation");
  useEffect(() => {
    if (drawer && open) closeRef.current?.focus();
  }, [drawer, open]);
  const projects = new Map<string, CreatorConversationSummary[]>();
  for (const conversation of conversations) {
    const project = conversation.project;
    const key =
      project.kind === "local_linked"
        ? project.forgeProjectId
        : `${project.universeId}:${project.placeId}`;
    projects.set(key, [...(projects.get(key) ?? []), conversation]);
  }
  async function createConversation(): Promise<void> {
    if (!state || !action) return;
    try {
      setError(undefined);
      await dashboardStore.submitAction(makeActionRequest(state, action, ""));
      onClose();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not create the conversation.");
    }
  }
  return (
    <aside
      className={`project-rail${open ? " project-rail--open" : ""}`}
      role={drawer && open ? "dialog" : undefined}
      aria-modal={drawer && open ? true : undefined}
      aria-label="Projects"
      aria-hidden={drawer && !open ? true : undefined}
      inert={drawer && !open ? true : undefined}
      onKeyDown={(event) => {
        if (!drawer) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        if (event.key !== "Tab") return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        ];
        if (event.shiftKey && document.activeElement === buttons[0]) {
          event.preventDefault();
          buttons.at(-1)?.focus();
        }
        if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
          event.preventDefault();
          buttons[0]?.focus();
        }
      }}
    >
      <div className="rail-heading">
        <h2>Projects</h2>
        <button
          ref={closeRef}
          type="button"
          className="rail-close"
          onClick={onClose}
          aria-label="Close projects"
        >
          ×
        </button>
      </div>
      <button
        className="new-conversation"
        type="button"
        disabled={!action || pending}
        onClick={() => void createConversation()}
      >
        <span aria-hidden="true">＋</span> New conversation
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <nav aria-label="Project conversations">
        {[...projects].map(([key, chats]) => (
          <section className="project-group" key={key}>
            <button
              className="project-group__heading"
              type="button"
              aria-expanded={!collapsed.has(key)}
              onClick={() =>
                setCollapsed((prior) => {
                  const next = new Set(prior);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            >
              <span aria-hidden="true">{collapsed.has(key) ? "›" : "⌄"}</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="M3 6h7l2 3h9v11H3z" />
              </svg>
              <strong>{chats[0]!.projectName}</strong>
              <small>{chats.length}</small>
            </button>
            {!collapsed.has(key) ? (
              <ol className="project-list" aria-label={`Conversations in ${chats[0]!.projectName}`}>
                {chats.map((conversation) => (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={`project-row${conversation.id === selectedConversationId ? " project-row--selected" : ""}`}
                      aria-current={conversation.id === selectedConversationId ? "page" : undefined}
                      onClick={() => onSelect(conversation.id)}
                    >
                      <span
                        className={`project-status project-status--${conversation.status}`}
                        aria-hidden="true"
                      />
                      <span title={conversation.title}>{conversation.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
        ))}
      </nav>
      {!conversations.length ? (
        <p className="rail-empty">Connect a Studio place to start your first conversation.</p>
      ) : null}
      <div className="sidebar-footnote">Each conversation has its own context.</div>
    </aside>
  );
}
