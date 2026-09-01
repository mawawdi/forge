import { useState } from "react";
import { dashboardStore } from "../api-store";
import { hasRequiredReport, makeActionRequest, reportByteLength } from "../derived";
import type {
  CreatorControlAction,
  CreatorDashboardState,
} from "../types";

interface StudioConsentDockProps {
  state: CreatorDashboardState | undefined;
  pendingAction: string | undefined;
}

export function StudioConsentDock({ state, pendingAction }: StudioConsentDockProps): React.JSX.Element {
  const [report, setReport] = useState("");
  const [message, setMessage] = useState<string | undefined>();
  const pairedStudio = state?.pairedStudio;
  const actions = [
    state?.controlView?.primaryAction,
    state?.controlView?.secondaryAction,
  ].filter((action): action is CreatorControlAction => action !== undefined);
  const finalReviewOpen = actions.some(isFinalReviewAction);

  async function act(action: CreatorControlAction): Promise<void> {
    if (!state) return;
    try {
      setMessage(undefined);
      await dashboardStore.submit(makeActionRequest(state, action.id, report));
      if (isFinalReviewAction(action)) setReport("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The control action did not complete.");
    }
  }

  return (
    <aside className="consent-dock" aria-label="Studio and creator consent">
      <section className="panel control-dock">
        <div className="panel-heading">
          <h2 id="studio-title">Studio &amp; consent</h2>
          <span className={`connection-state connection-state--${pairedStudio?.status ?? "unpaired"}`}>
            {pairedStudio?.status ?? "unpaired"}
          </span>
        </div>
        <div className={`studio-connection studio-connection--${pairedStudio?.status ?? "unpaired"}`}>
          <span className="connection-orb" aria-hidden="true" />
          <div>
            <p>{pairedStudio?.message ?? "Waiting for a paired Studio project."}</p>
          </div>
        </div>
        {pairedStudio?.projectName || pairedStudio?.projectId ? (
          <dl className="studio-facts">
            <div><dt>Project</dt><dd>{pairedStudio.projectName ?? pairedStudio.projectId}</dd></div>
            {pairedStudio.revisionHash ? <div><dt>Revision</dt><dd><code>{shortHash(pairedStudio.revisionHash)}</code></dd></div> : null}
            {pairedStudio.manifestHash ? <div><dt>Manifest</dt><dd><code>{shortHash(pairedStudio.manifestHash)}</code></dd></div> : null}
            {pairedStudio.attestationStatus ? (
              <div>
                <dt>Attestation</dt>
                <dd>{attestationStatus(pairedStudio)}</dd>
              </div>
            ) : null}
            {pairedStudio.capabilities ? <div><dt>Capabilities</dt><dd>{pairedStudio.capabilities.length}</dd></div> : null}
          </dl>
        ) : null}
        <div className="consent-section" aria-labelledby="consent-title">
          <div className="consent-section__heading">
            <h3 id="consent-title">Current action</h3>
            {state?.controlView ? <code title={state.controlView.hash}>{shortHash(state.controlView.hash)}</code> : null}
          </div>
        {finalReviewOpen ? (
          <CreatorReport report={report} onChange={setReport} />
        ) : (
          <p className="consent-copy">Only exact, hash-bound actions from the current evidence view are available here.</p>
        )}
        <div className="action-list">
          {actions.length > 0 ? actions.map((action) => (
            <ControlActionButton
              key={action.id}
              action={action}
              report={report}
              pendingAction={pendingAction}
              onAct={act}
            />
          )) : <p className="empty-actions">No creator action is available for this session.</p>}
        </div>
        <p className="action-message" role="status" aria-live="polite">{message ?? ""}</p>
        </div>
        <ReplayControl state={state} />
      </section>
    </aside>
  );
}

interface CreatorReportProps {
  report: string;
  onChange: (value: string) => void;
}

function CreatorReport({ report, onChange }: CreatorReportProps): React.JSX.Element {
  const count = reportByteLength(report.trim());
  return (
    <div className="creator-report">
      <label htmlFor="creator-report">What you observed in Studio</label>
      <textarea
        id="creator-report"
        value={report}
        onChange={(event) => onChange(event.target.value)}
        maxLength={4096}
        placeholder="Record the interaction you observed, any limits, and your final judgment."
        aria-describedby="creator-report-rule"
      />
      <span id="creator-report-rule">{count}/4096 bytes · a non-whitespace report is required to accept or reject.</span>
    </div>
  );
}

interface ControlActionButtonProps {
  action: CreatorControlAction;
  report: string;
  pendingAction: string | undefined;
  onAct: (action: CreatorControlAction) => Promise<void>;
}

function ControlActionButton({ action, report, pendingAction, onAct }: ControlActionButtonProps): React.JSX.Element {
  const isPending = pendingAction === action.id;
  const disabled = Boolean(pendingAction) || !hasRequiredReport(action, report);
  return (
    <button
      type="button"
      className={`action-button action-button--${action.intent}`}
      disabled={disabled}
      onClick={() => void onAct(action)}
    >
      {isPending ? "Working…" : action.label}
    </button>
  );
}

interface ReplayControlProps {
  state: CreatorDashboardState | undefined;
}

function ReplayControl({ state }: ReplayControlProps): React.JSX.Element | null {
  const [result, setResult] = useState<string | undefined>();
  const verification = state?.controlView?.verification;
  const mutation = state?.controlView?.mutation;
  if (!verification?.replayable && !mutation?.replayable) return null;
  async function replay(path: string): Promise<void> {
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      });
      const value = await response.json() as { detail?: unknown };
      if (!response.ok) throw new Error(typeof value.detail === "string" ? value.detail : `Replay failed (${response.status}).`);
      setResult(typeof value.detail === "string" ? value.detail : "Replay completed.");
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Replay failed.");
    }
  }
  return (
    <section className="replay-card" aria-label="Evidence replay">
      <div>
        <strong>Replay evidence</strong>
        <span>Provider-free check</span>
      </div>
      {mutation?.replayable ? (
        <button type="button" className="quiet-button" onClick={() => void replay(`/api/mutations/${encodeURIComponent(mutation.attemptId)}/replay`)}>Replay mutation</button>
      ) : null}
      {verification?.replayable ? (
        <button type="button" className="quiet-button" onClick={() => void replay(`/api/verifications/${encodeURIComponent(verification.id)}/replay`)}>Replay verification</button>
      ) : null}
      {result ? <p role="status" aria-live="polite">{result}</p> : null}
    </section>
  );
}

function isFinalReviewAction(action: CreatorControlAction): boolean {
  return action.requiresReport || action.id === "accept_result" || action.id === "reject_and_rollback";
}

function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 9)}…${value.slice(-5)}` : value;
}

function attestationStatus(state: NonNullable<CreatorDashboardState["pairedStudio"]>): string {
  const summary = state.attestation;
  if (!summary) return state.attestationStatus ?? "pending";
  const findings = summary.mismatchedFacts + summary.missingFacts + summary.unavailableFacts + summary.readErrorFacts;
  return `${state.attestationStatus ?? "pending"} · ${summary.observedFacts}/${summary.totalFacts} observed · ${findings} finding${findings === 1 ? "" : "s"}`;
}
