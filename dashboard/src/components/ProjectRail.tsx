import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { dashboardStore, useDashboardSnapshot } from "../api-store";
import { toggleConversationPin, useBrowserPreferences } from "../browser-preferences";
import type { CreatorConversationSummary, CreatorDashboardState } from "../types";
import { Icon } from "./Icon";
import { robloxPathsInText } from "../../../packages/studio-path/src/index.js";

export function ProjectRail({
  conversations,
  state,
  selectedConversationId,
  open,
  drawer,
  onSelect,
  onClose,
  onSearch,
  onNewConversation,
}: {
  readonly conversations: readonly CreatorConversationSummary[];
  readonly state: CreatorDashboardState | undefined;
  readonly selectedConversationId: string | undefined;
  readonly open: boolean;
  readonly drawer: boolean;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  readonly onSearch: () => void;
  readonly onNewConversation: () => void;
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const focusAfterRename = useRef<string>(undefined);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<{
    scope: "project" | "conversation";
    id: string;
    name: string;
  }>();
  function finishRename(): void {
    focusAfterRename.current = editing ? `${editing.scope}:${editing.id}` : undefined;
    setEditing(undefined);
  }
  useLayoutEffect(() => {
    const key = focusAfterRename.current;
    if (editing || !key) return;
    railRef.current
      ?.querySelector<HTMLButtonElement>(`[data-rename-key="${CSS.escape(key)}"]`)
      ?.focus();
    focusAfterRename.current = undefined;
  }, [editing]);
  const snapshot = useDashboardSnapshot();
  const { pinnedConversations } = useBrowserPreferences();
  const pending = Boolean(snapshot.pendingRequest) || snapshot.connectionLost === true;
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
  return (
    <aside
      ref={railRef}
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
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled)",
          ),
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
          <Icon name="close" />
        </button>
      </div>
      <button
        className="new-conversation"
        type="button"
        disabled={!action || pending}
        onClick={onNewConversation}
        title="New conversation (⌘/Ctrl Shift O)"
      >
        <Icon name="plus" /> New conversation
      </button>
      <button type="button" className="rail-search" onClick={onSearch}>
        <Icon name="search" size={16} />
        <span>Find a conversation</span>
        <kbd>⌘ K</kbd>
      </button>
      <nav aria-label="Project conversations">
        {[...projects].map(([key, chats]) => (
          <section className="project-group" key={key}>
            {editing?.scope === "project" && editing.id === chats[0]!.id ? (
              <RenameName
                key={`project:${editing.id}`}
                scope="project"
                conversationId={editing.id}
                name={editing.name}
                onDone={finishRename}
              />
            ) : (
              <div className="project-group__row">
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
                  <Icon name={collapsed.has(key) ? "chevronRight" : "chevronDown"} size={14} />
                  <Icon name="folder" size={16} />
                  <strong>{chats[0]!.projectName}</strong>
                </button>
                <button
                  type="button"
                  className="rail-action project-rename"
                  aria-label={`Rename project ${chats[0]!.projectName}`}
                  title="Rename project"
                  data-rename-key={`project:${chats[0]!.id}`}
                  onClick={() =>
                    setEditing({ scope: "project", id: chats[0]!.id, name: chats[0]!.projectName })
                  }
                >
                  <Icon name="edit" size={14} />
                </button>
              </div>
            )}
            {!collapsed.has(key) ? (
              <ol className="project-list" aria-label={`Conversations in ${chats[0]!.projectName}`}>
                {[...chats]
                  .sort(
                    (a, b) =>
                      Number(pinnedConversations.includes(b.id)) -
                      Number(pinnedConversations.includes(a.id)),
                  )
                  .map((conversation) => (
                    <li
                      key={conversation.id}
                      className={`project-list__item${conversation.id === selectedConversationId ? " is-selected" : ""}`}
                    >
                      {editing?.scope === "conversation" && editing.id === conversation.id ? (
                        <RenameName
                          key={editing.id}
                          scope="conversation"
                          conversationId={editing.id}
                          name={editing.name}
                          onDone={finishRename}
                        />
                      ) : (
                        <>
                          <button
                            type="button"
                            className={`project-row${conversation.id === selectedConversationId ? " project-row--selected" : ""}`}
                            aria-current={
                              conversation.id === selectedConversationId ? "page" : undefined
                            }
                            onClick={() => onSelect(conversation.id)}
                          >
                            <span
                              className={`project-status project-status--${conversation.status}`}
                              aria-hidden="true"
                            />
                            {pinnedConversations.includes(conversation.id) ? (
                              <Icon name="pin" size={12} />
                            ) : null}
                            <span
                              className="project-row__title"
                              title={robloxPathsInText(conversation.title)}
                            >
                              {robloxPathsInText(conversation.title)}
                              <span className="sr-only">
                                {conversation.status === "working"
                                  ? ", working"
                                  : conversation.status === "awaiting_creator"
                                    ? ", needs your attention"
                                    : ""}
                              </span>
                            </span>
                            {snapshot.drafts[conversation.id]?.text.trim() ? (
                              <small className="draft-badge">Draft</small>
                            ) : null}
                          </button>
                          <div className="rail-row-actions">
                            <button
                              type="button"
                              className="rail-action"
                              aria-label={`Rename conversation ${conversation.title}`}
                              title="Rename conversation"
                              data-rename-key={`conversation:${conversation.id}`}
                              onClick={() =>
                                setEditing({
                                  scope: "conversation",
                                  id: conversation.id,
                                  name: conversation.title,
                                })
                              }
                            >
                              <Icon name="edit" size={14} />
                            </button>
                            <button
                              className={`rail-action conversation-pin${pinnedConversations.includes(conversation.id) ? " is-pinned" : ""}`}
                              type="button"
                              aria-label={`${pinnedConversations.includes(conversation.id) ? "Unpin" : "Pin"} ${conversation.title}`}
                              title={
                                pinnedConversations.includes(conversation.id)
                                  ? "Unpin conversation"
                                  : "Pin conversation"
                              }
                              aria-pressed={pinnedConversations.includes(conversation.id)}
                              onClick={() => toggleConversationPin(conversation.id)}
                            >
                              <Icon name="pin" size={15} />
                            </button>
                          </div>
                        </>
                      )}
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
    </aside>
  );
}

function RenameName({
  scope,
  conversationId,
  name,
  onDone,
}: {
  readonly scope: "project" | "conversation";
  readonly conversationId: string;
  readonly name: string;
  readonly onDone: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  async function save(): Promise<void> {
    if (saving || !value.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      await dashboardStore.renameWorkspace(scope, conversationId, value.trim());
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the name. Try again.");
      setSaving(false);
    }
  }
  return (
    <form
      className="rail-rename"
      aria-label={`Rename ${scope}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!saving) onDone();
        }
      }}
    >
      <div>
        <input
          ref={input}
          aria-label={`${scope === "project" ? "Project" : "Conversation"} name`}
          aria-describedby={error ? `rename-error-${conversationId}` : undefined}
          aria-invalid={Boolean(error)}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={80}
          disabled={saving}
        />
        <button
          className="rail-action"
          type="submit"
          aria-label="Save name"
          title="Save name (Enter)"
          disabled={saving || !value.trim()}
        >
          <Icon name="check" size={16} />
        </button>
        <button
          className="rail-action"
          type="button"
          aria-label="Cancel rename"
          title="Cancel (Escape)"
          onClick={onDone}
          disabled={saving}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      {error ? (
        <p id={`rename-error-${conversationId}`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
