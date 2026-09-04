import type { CreatorDashboardState } from "../types";
import { Icon } from "./Icon";
import { robloxPathsInText } from "../../../packages/studio-path/src/index.js";

export function ConversationHeader({
  state,
  connectionLost,
  onOpenProjects,
  onOpenContext,
  onOpenDetails,
  projectsVisible,
}: {
  readonly state: CreatorDashboardState | undefined;
  readonly connectionLost: boolean | undefined;
  readonly onOpenProjects: (source: HTMLElement) => void;
  readonly onOpenContext: (source: HTMLElement) => void;
  readonly onOpenDetails: (source: HTMLElement) => void;
  readonly projectsVisible: boolean;
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
          aria-label={projectsVisible ? "Hide projects" : "Open projects"}
          title={projectsVisible ? "Hide projects (⌘/Ctrl B)" : "Show projects (⌘/Ctrl B)"}
          aria-expanded={projectsVisible}
          onClick={(event) => onOpenProjects(event.currentTarget)}
        >
          <Icon name="sidebar" size={19} />
        </button>
      </div>
      <div className="conversation-header__title">
        <span>{conversation?.projectName ?? studio?.projectName ?? "Your workspace"}</span>
        <h1 title={conversation ? robloxPathsInText(conversation.title) : undefined}>
          {robloxPathsInText(conversation?.title ?? "New conversation")}
        </h1>
      </div>
      <div className="conversation-header__studio">
        <span
          className={`studio-indicator studio-indicator--${connectionLost ? "connecting" : (studio?.status ?? "connecting")}`}
          role="status"
          aria-live="polite"
        >
          <span aria-hidden="true" />
          {connectionLost ? "Updates paused" : studioLabel(studio?.status)}
        </span>
        <button
          type="button"
          onClick={(event) => onOpenDetails(event.currentTarget)}
          aria-label="Open details"
          title="Conversation details"
          className="header-icon-button"
        >
          <Icon name="details" size={19} />
        </button>
        <button
          type="button"
          className="header-settings header-icon-button"
          onClick={(event) => onOpenContext(event.currentTarget)}
          aria-label="Project settings"
          title="Project settings"
        >
          <Icon name="settings" size={19} />
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
