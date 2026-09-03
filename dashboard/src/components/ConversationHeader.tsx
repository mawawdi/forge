import type { CreatorDashboardState } from "../types";

export function ConversationHeader({
  state,
  onOpenProjects,
  onOpenContext,
  onOpenDetails,
}: {
  readonly state: CreatorDashboardState | undefined;
  readonly onOpenProjects: (source: HTMLElement) => void;
  readonly onOpenContext: (source: HTMLElement) => void;
  readonly onOpenDetails: (source: HTMLElement) => void;
}): React.JSX.Element {
  const conversation = state?.conversations.find(
    (item) => item.id === state.selectedConversationId,
  );
  const studio = state?.pairedStudio;
  return (
    <header className="conversation-header">
      <div className="conversation-header__brand">
        <a href="#conversation" className="forge-mark" aria-label="Forge conversation home">
          <span aria-hidden="true">F</span>
          <strong>Forge</strong>
        </a>
        <button
          type="button"
          className="header-rail-toggle"
          aria-label="Open projects"
          onClick={(event) => onOpenProjects(event.currentTarget)}
        >
          ☰
        </button>
      </div>
      <div className="conversation-header__title">
        <span>{conversation?.projectName ?? studio?.projectName ?? "Your workspace"}</span>
        <h1>{conversation?.title ?? "New conversation"}</h1>
      </div>
      <div className="conversation-header__studio">
        <span className={`studio-indicator studio-indicator--${studio?.status ?? "connecting"}`}>
          <span aria-hidden="true" />
          {studioLabel(studio?.status)}
        </span>
        <button
          type="button"
          onClick={(event) => onOpenDetails(event.currentTarget)}
          aria-label="Open details"
        >
          Details
        </button>
        <button
          type="button"
          className="header-settings"
          onClick={(event) => onOpenContext(event.currentTarget)}
          aria-label="Project settings"
          title="Project settings"
        >
          <svg
            viewBox="0 0 24 24"
            width="19"
            height="19"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>Settings</span>
        </button>
      </div>
    </header>
  );
}
function studioLabel(status: CreatorDashboardState["pairedStudio"]["status"] | undefined): string {
  if (status === "ready") return "Studio ready";
  if (status === "update_required") return "Update connector";
  if (status === "attention") return "Studio needs attention";
  if (status === "unpaired") return "Connect Studio";
  return "Connecting";
}
