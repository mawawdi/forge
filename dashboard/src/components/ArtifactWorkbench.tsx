import { lazy, Suspense, useState } from "react";
import type { ArtifactReference, CreatorArtifactSet, CreatorControlView } from "../types";

const RawArtifactViewer = lazy(() => import("./RawArtifactViewer"));

interface ArtifactWorkbenchProps {
  controlView: CreatorControlView | undefined;
}

export function ArtifactWorkbench({ controlView }: ArtifactWorkbenchProps): React.JSX.Element {
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactReference | undefined>();
  const artifacts = artifactEntries(controlView);
  if (!controlView) return <AwaitingEvidence />;
  return (
    <section className="artifact-workbench" aria-labelledby="artifact-title">
      <div className="panel-heading artifact-workbench__heading">
        <div>
          <p className="eyebrow">Immutable record</p>
          <h2 id="artifact-title">Artifact workbench</h2>
        </div>
        <span className="view-hash" title={controlView.hash}>view {abbreviate(controlView.hash)}</span>
      </div>
      <p className="view-message" aria-live="polite">{controlView.detail}</p>
      <ReviewPresentation controlView={controlView} />
      <CreatorJudgmentPrompts prompts={controlView.creatorReviewPrompts} />
      <div className="artifact-grid">
        {artifacts.map(([label, artifact]) => (
          <ArtifactCard key={artifact.artifactHash} label={label} artifact={artifact} onOpen={setSelectedArtifact} />
        ))}
      </div>
      <MutationSummary controlView={controlView} />
      <VerificationSummary controlView={controlView} />
      {selectedArtifact ? (
        <Suspense fallback={<div className="raw-evidence-loading">Loading immutable evidence…</div>}>
          <RawArtifactViewer artifact={selectedArtifact} onClose={() => setSelectedArtifact(undefined)} />
        </Suspense>
      ) : null}
    </section>
  );
}

function MutationSummary({ controlView }: { controlView: CreatorControlView }): React.JSX.Element | null {
  const mutation = controlView.mutation;
  if (!mutation) return null;
  return (
    <section className={`verification-summary verification-summary--${mutation.status}`} aria-label="Mutation evidence summary">
      <div>
        <p className="eyebrow">Transactional mutation proof</p>
        <strong>{mutation.status.replaceAll("_", " ")}</strong>
        <span>{mutation.projectionFactCount} projected facts · {mutation.replayable ? "Provider-free replay available" : "Evidence is explicitly incomplete"}</span>
      </div>
      {mutation.failureFacts.length > 0 ? (
        <ul>{mutation.failureFacts.map((fact) => <li key={fact.hash}>{fact.statement}</li>)}</ul>
      ) : null}
    </section>
  );
}

function ReviewPresentation({ controlView }: { controlView: CreatorControlView }): React.JSX.Element | null {
  const artifact = controlView.artifact;
  if (!artifact || !isRecord(artifact.presentation)) return null;
  return artifact.kind === "plan"
    ? <PlanPresentation value={artifact.presentation} />
    : <ChangePresentation value={artifact.presentation} />;
}

function PlanPresentation({ value }: { value: Record<string, unknown> }): React.JSX.Element {
  const request = isRecord(value.creatorRequest) ? value.creatorRequest : {};
  const plan = isRecord(value.plan) ? value.plan : {};
  const changes = records(value.changes);
  const checks = records(value.machineCheckClauses);
  const coverage = records(value.outputCheckCoverage);
  return (
    <section className="review-presentation" aria-label="Plan review evidence">
      <div className="review-presentation__header">
        <div><p className="eyebrow">Exact request</p><h3>Plan &amp; charter</h3></div>
        {typeof request.promptHash === "string" ? <code>{abbreviate(request.promptHash)}</code> : null}
      </div>
      {typeof request.text === "string" ? <blockquote>{request.text}</blockquote> : null}
      {typeof plan.goal === "string" ? <p className="review-goal"><strong>Goal</strong>{plan.goal}</p> : null}
      <div className="review-columns">
        <ReviewList
          title="Typed changes"
          values={changes.map((change) => ({
            title: textValue(change.summary, textValue(change.id, "Change")),
            detail: stringArray(change.initializationCommitments).join(" "),
          }))}
        />
        <ReviewList
          title="Machine checks"
          values={checks.map((check) => ({
            title: textValue(check.statement, textValue(check.check, "Check")),
            detail: [check.check, check.path].filter((item): item is string => typeof item === "string").join(" · "),
          }))}
        />
      </div>
      {coverage.length > 0 ? (
        <p className="coverage-line">
          <strong>Output coverage</strong>
          {coverage.filter((item) => item.covered === true).length}/{coverage.length} planned outputs have exact checks
        </p>
      ) : null}
    </section>
  );
}

function ChangePresentation({ value }: { value: Record<string, unknown> }): React.JSX.Element {
  const gate = isRecord(value.localGate) ? value.localGate : {};
  const operations = records(value.operations);
  const sourceDiffs = records(value.sourceDiffs);
  const proofObligations = records(value.proofObligations);
  return (
    <section className="review-presentation" aria-label="Change review evidence">
      <div className="review-presentation__header">
        <div><p className="eyebrow">Exact mutation</p><h3>Change set &amp; source diff</h3></div>
        <span className={`gate-chip gate-chip--${textValue(gate.status, "unknown")}`}>{textValue(gate.status, "not run")}</span>
      </div>
      <div className="operation-list">
        {operations.map((operation, index) => (
          <article className="operation-row" key={textValue(operation.operationHash, String(index))}>
            <div><strong>{textValue(operation.kind, "operation")}</strong><span>{textValue(operation.target, textValue(operation.path, "Bound target"))}</span></div>
            {typeof operation.className === "string" ? <span>{operation.className}</span> : null}
            {typeof operation.operationHash === "string" ? <code>{abbreviate(operation.operationHash)}</code> : null}
            {isRecord(operation.properties) && Object.keys(operation.properties).length > 0 ? (
              <pre>{JSON.stringify(operation.properties, null, 2)}</pre>
            ) : null}
          </article>
        ))}
      </div>
      {proofObligations.length > 0 ? (
        <section className="proof-obligations" aria-label="Projected mutation proof obligations">
          <h4>Direct readback obligations</h4>
          <p>These exact expected facts are bound into this review before Studio may open a recording.</p>
          <ul>{proofObligations.map((obligation, index) => (
            <li key={`${textValue(obligation.fact, "fact")}-${index}`}>
              <strong>{textValue(obligation.fact, "Mutation fact")}</strong>
              <code>{textValue(obligation.expected, "observed")}</code>
            </li>
          ))}</ul>
        </section>
      ) : null}
      {sourceDiffs.map((diff, index) => (
        <div className="source-diff" key={textValue(diff.path, String(index))}>
          <strong>{textValue(diff.path, "Source diff")}</strong>
          <pre>{textValue(diff.unifiedDiff, "No source diff body")}</pre>
        </div>
      ))}
    </section>
  );
}

function CreatorJudgmentPrompts({ prompts }: { prompts: string[] | undefined }): React.JSX.Element | null {
  if (!prompts || prompts.length === 0) return null;
  return (
    <section className="creator-prompts" aria-label="Creator review prompts">
      <p className="eyebrow">Creator judgment</p>
      <ul>{prompts.map((prompt) => <li key={prompt}>{prompt}</li>)}</ul>
    </section>
  );
}

function ReviewList({ title, values }: { title: string; values: Array<{ title: string; detail: string }> }): React.JSX.Element {
  return (
    <div className="review-list">
      <h4>{title}</h4>
      {values.length > 0 ? <ul>{values.map((value, index) => (
        <li key={`${value.title}-${index}`}><strong>{value.title}</strong>{value.detail ? <span>{value.detail}</span> : null}</li>
      ))}</ul> : <p>No items recorded.</p>}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function AwaitingEvidence(): React.JSX.Element {
  return (
    <section className="artifact-workbench artifact-workbench--empty" aria-labelledby="artifact-title">
      <div>
        <p className="eyebrow">Immutable record</p>
        <h2 id="artifact-title">Artifact workbench</h2>
      </div>
      <div className="empty-state">
        <p>Select a creator session to inspect its exact evidence.</p>
        <span>Forge never makes a result actionable from a status label alone.</span>
      </div>
    </section>
  );
}

interface ArtifactCardProps {
  label: string;
  artifact: ArtifactReference;
  onOpen: (artifact: ArtifactReference) => void;
}

function ArtifactCard({ label, artifact, onOpen }: ArtifactCardProps): React.JSX.Element {
  return (
    <article className="artifact-card">
      <div>
        <p>{label}</p>
        <code title={artifact.artifactHash}>{abbreviate(artifact.artifactHash)}</code>
      </div>
      <span>{formatBytes(artifact.bytes)}</span>
      <button type="button" className="quiet-button" onClick={() => onOpen(artifact)}>Inspect JSON</button>
    </article>
  );
}

interface VerificationSummaryProps {
  controlView: CreatorControlView;
}

function VerificationSummary({ controlView }: VerificationSummaryProps): React.JSX.Element | null {
  const verification = controlView.verification;
  if (!verification) return null;
  return (
    <section className={`verification-summary verification-summary--${verification.status}`} aria-label="Verification summary">
      <div>
        <p className="eyebrow">Verification</p>
        <strong>{verification.status}</strong>
        <span>{verification.replayable ? "Provider-free replay available" : "Evidence is explicitly incomplete"}</span>
      </div>
      {verification.failureFacts.length > 0 ? (
        <ul>
          {verification.failureFacts.map((fact) => <li key={fact.hash}>{fact.statement}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

function artifactEntries(controlView: CreatorControlView | undefined): Array<[string, ArtifactReference]> {
  if (!controlView) return [];
  const labels: Array<[keyof CreatorArtifactSet, string]> = [
    ["prompt", "Creator request"],
    ["plan", "Plan & charter"],
    ["changeSet", "Exact change set"],
    ["capabilityManifest", "Studio capability manifest"],
    ["capabilityAttestation", "Studio capability attestation"],
    ["mutationProjection", "Mutation evidence projection"],
    ["mutationPreflight", "Detached mutation preflight"],
    ["mutationReadback", "Direct Studio readback"],
    ["projectState", "Projected Studio state"],
    ["mutationReconciliation", "Mutation reconciliation"],
    ["mutationFinalization", "Mutation finalization"],
    ["studioExecutionPlan", "Studio execution plan"],
    ["runtimeEvidence", "Runtime evidence"],
    ["verification", "Verification result"],
    ["reviewReport", "Creator review report"],
    ["agentRun", "Agent run"],
    ["trace", "Build trace"],
  ];
  return labels.flatMap(([key, label]) => {
    const artifact = controlView.artifacts?.[key];
    return artifact ? [[label, artifact] as [string, ArtifactReference]] : [];
  });
}

function abbreviate(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
