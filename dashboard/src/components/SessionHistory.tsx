import { formatStatus, formatTimestamp } from "../derived";
import { dashboardStore } from "../api-store";
import type { CreatorSessionSummary } from "../types";

interface SessionHistoryProps {
  sessions: CreatorSessionSummary[];
  selectedSessionId: string | undefined;
}

export function SessionHistory({
  sessions,
  selectedSessionId,
}: SessionHistoryProps): React.JSX.Element {
  const isEmpty = sessions.length === 0;
  return (
    <section className="panel session-history" aria-labelledby="history-title">
      <div className="panel-heading">
        <h2 id="history-title">Sessions</h2>
        {!isEmpty ? <span className="panel-count">{sessions.length}</span> : null}
      </div>
      {isEmpty ? (
        <EmptyHistory />
      ) : (
        <SessionList sessions={sessions} selectedSessionId={selectedSessionId} />
      )}
    </section>
  );
}

function EmptyHistory(): React.JSX.Element {
  return (
    <div className="empty-state empty-state--compact">
      <p>No requests yet.</p>
      <span>Start a bounded change request to open an evidence record.</span>
    </div>
  );
}

interface SessionListProps {
  sessions: CreatorSessionSummary[];
  selectedSessionId: string | undefined;
}

function SessionList({ sessions, selectedSessionId }: SessionListProps): React.JSX.Element {
  return (
    <ol className="session-list">
      {sessions.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            className={`session-row${session.id === selectedSessionId ? " session-row--selected" : ""}`}
            aria-pressed={session.id === selectedSessionId}
            onClick={() => dashboardStore.selectSession(session.id)}
          >
            <span className={`status-pip status-pip--${session.status}`} aria-hidden="true" />
            <span className="session-row__body">
              <strong>{session.prompt}</strong>
              <small>
                {session.projectName ?? session.projectId} · {formatTimestamp(session.updatedAt)}
              </small>
              {session.failure ? <small>Reason: {formatStatus(session.failure.code)}</small> : null}
            </span>
            <span className="session-row__status">{formatStatus(session.status)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
