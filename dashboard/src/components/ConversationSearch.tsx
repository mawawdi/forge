import { useEffect, useRef, useState } from "react";
import type { ConversationDraft, CreatorConversationSummary } from "../types";
import { useBrowserPreferences } from "../browser-preferences";
import { formatTimestamp } from "../derived";
import { Icon } from "./Icon";

function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

export function ConversationSearch({
  conversations,
  drafts,
  onSelect,
  onClose,
}: {
  readonly conversations: readonly CreatorConversationSummary[];
  readonly drafts: Readonly<Record<string, ConversationDraft>>;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { pinnedConversations } = useBrowserPreferences();
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  const matches = conversations
    .filter((chat) =>
      words.every((word) => normalize(`${chat.title} ${chat.projectName}`).includes(word)),
    )
    .sort(
      (a, b) =>
        Number(pinnedConversations.includes(b.id)) - Number(pinnedConversations.includes(a.id)),
    );
  const selected = Math.min(active, Math.max(0, matches.length - 1));
  useEffect(() => {
    const source = document.activeElement;
    dialog.current?.showModal();
    input.current?.focus();
    return () => {
      if (source instanceof HTMLElement && source.isConnected) source.focus();
    };
  }, []);
  useEffect(() => {
    document.getElementById(`search-result-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  function choose(id: string): void {
    onSelect(id);
    onClose();
  }
  return (
    <dialog
      ref={dialog}
      className="conversation-search"
      aria-labelledby="conversation-search-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="conversation-search__content">
        <h2 id="conversation-search-title" className="sr-only">
          Find a conversation
        </h2>
        <div className="conversation-search__field">
          <Icon name="search" />
          <input
            ref={input}
            role="combobox"
            aria-label="Search conversations"
            aria-autocomplete="list"
            aria-expanded={true}
            aria-controls="conversation-search-results"
            aria-activedescendant={matches.length ? `search-result-${selected}` : undefined}
            placeholder="Find a conversation or project…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive(
                  matches.length
                    ? (selected + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
                        matches.length
                    : 0,
                );
              } else if (event.key === "Enter" && matches[selected]) {
                event.preventDefault();
                choose(matches[selected]!.id);
              }
            }}
          />
          <button type="button" onClick={onClose} aria-label="Close search">
            <Icon name="close" />
          </button>
        </div>
        <ul
          id="conversation-search-results"
          role="listbox"
          aria-label="Conversations"
          className="conversation-search__results"
        >
          {matches.map((chat, index) => (
            <li role="presentation" key={chat.id}>
              <button
                id={`search-result-${index}`}
                type="button"
                role="option"
                aria-selected={selected === index}
                tabIndex={-1}
                onClick={() => choose(chat.id)}
              >
                <span
                  className={`project-status project-status--${chat.status}`}
                  aria-hidden="true"
                />
                <span>
                  <strong>{chat.title}</strong>
                  <small>
                    {chat.projectName}
                    {pinnedConversations.includes(chat.id) ? " · Pinned" : ""}
                    {drafts[chat.id]?.text.trim() ? " · Draft" : ""}
                  </small>
                </span>
                {chat.status === "working" ? (
                  <small>Working</small>
                ) : chat.status === "awaiting_creator" ? (
                  <small>Needs you</small>
                ) : (
                  <small>
                    <time
                      dateTime={chat.updatedAt}
                      title={new Date(chat.updatedAt).toLocaleString()}
                    >
                      {formatTimestamp(chat.updatedAt)}
                    </time>
                  </small>
                )}
              </button>
            </li>
          ))}
        </ul>
        {!matches.length ? (
          <p className="conversation-search__empty">
            {conversations.length
              ? "No conversations match. Try another word or project name."
              : "Your conversations will appear here once a project is linked."}
          </p>
        ) : null}
        <footer className="conversation-search__footer">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to browse <kbd>Enter</kbd> to open
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </footer>
      </div>
    </dialog>
  );
}
