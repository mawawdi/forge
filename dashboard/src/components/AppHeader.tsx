interface AppHeaderProps {
  connection: "paired" | "unpaired" | "connecting" | "unknown";
  message: string;
}

export function AppHeader({ connection, message }: AppHeaderProps): React.JSX.Element {
  return (
    <header className="app-header">
      <a className="wordmark" href="#control" aria-label="Forge Creator Control home">
        <span className="wordmark-mark" aria-hidden="true">F</span>
        <span>Forge <em>Creator Control</em></span>
      </a>
      <div className="header-connection" aria-live="polite">
        <span className={`connection-dot connection-dot--${connection}`} aria-hidden="true" />
        <span>{message}</span>
      </div>
    </header>
  );
}
