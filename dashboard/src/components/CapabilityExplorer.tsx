import { lazy, Suspense, useState, type FormEvent } from "react";
import type {
  ArtifactReference,
  CapabilityExplorerSnapshot,
  PairedStudioState,
  StudioAttestationEvidence,
  StudioAttestationEvidenceValue,
  StudioAttestationFinding,
  StudioAttestationSummary,
  StudioCapabilityExplorerEntry,
} from "../types";

const RawArtifactViewer = lazy(() => import("./RawArtifactViewer"));

interface CapabilityExplorerProps {
  catalog: CapabilityExplorerSnapshot;
  pairedStudio: PairedStudioState | undefined;
  onExplore: (input: { className?: string; query?: string; cursor?: number }) => void;
}

type CoveragePresentation = {
  readonly phase: "pinned" | "unbound" | "unverified";
  readonly proofRoutesAvailable: boolean;
  readonly detail?: string;
};

export function CapabilityExplorer({
  catalog,
  pairedStudio,
  onExplore,
}: CapabilityExplorerProps): React.JSX.Element {
  const [className, setClassName] = useState("");
  const [query, setQuery] = useState("");
  const [selectedAttestationArtifact, setSelectedAttestationArtifact] = useState<ArtifactReference | undefined>();
  const summary = catalog.summary;
  const page = catalog.page;
  const coverage = coveragePresentation(summary, page);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onExplore({
      ...(className.trim() ? { className: className.trim() } : {}),
      ...(query.trim() ? { query: query.trim() } : {}),
    });
  }

  function clear(): void {
    setClassName("");
    setQuery("");
    onExplore({});
  }

  return (
    <section className="capability-explorer" aria-labelledby="capability-explorer-title">
      <div className="panel-heading capability-explorer__heading">
        <div>
          <p className="eyebrow">Pinned capability policy</p>
          <h2 id="capability-explorer-title">API coverage explorer</h2>
        </div>
        <span className={`catalog-phase catalog-phase--${catalogPhase(catalog.phase, coverage)}`}>
          {catalog.phase === "loading"
            ? "Loading"
            : catalog.phase === "error"
              ? "Unavailable"
              : coverage.phase === "pinned"
                ? "Pinned"
                : coverage.phase === "unbound"
                  ? "Unbound"
                  : "Unverified"}
        </span>
      </div>
      <p className="capability-explorer__intro">
        This is an accountability map, not a mutation menu. Authoring remains available only through the current Creator Control view.
      </p>
      {summary ? (
        <CatalogStatus
          summary={summary}
          pairedStudio={pairedStudio}
          coverage={coverage}
          onInspectAttestation={setSelectedAttestationArtifact}
        />
      ) : null}
      <form className="capability-search" onSubmit={submit}>
        <label>
          <span>Class</span>
          <input
            value={className}
            onChange={(event) => setClassName(event.target.value)}
            placeholder="Part"
            maxLength={128}
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Find a capability</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Property, codec, reason…"
            maxLength={160}
          />
        </label>
        <div className="capability-search__actions">
          <button type="submit" disabled={catalog.phase === "loading"}>Search coverage</button>
          <button type="button" className="quiet-button" onClick={clear} disabled={catalog.phase === "loading"}>Clear</button>
        </div>
      </form>
      {catalog.error ? <p className="capability-explorer__error" role="status">{catalog.error}</p> : null}
      {page ? (
        <CapabilityResults
          page={page}
          onExplore={onExplore}
          proofRoutesAvailable={coverage.proofRoutesAvailable}
        />
      ) : <ExplorerPlaceholder loading={catalog.phase === "loading"} />}
      {selectedAttestationArtifact ? (
        <Suspense fallback={<div className="raw-evidence-loading">Loading immutable evidence…</div>}>
          <RawArtifactViewer
            artifact={selectedAttestationArtifact}
            onClose={() => setSelectedAttestationArtifact(undefined)}
          />
        </Suspense>
      ) : null}
    </section>
  );
}

function CatalogStatus({
  summary,
  pairedStudio,
  coverage,
  onInspectAttestation,
}: {
  summary: NonNullable<CapabilityExplorerSnapshot["summary"]>;
  pairedStudio: PairedStudioState | undefined;
  coverage: CoveragePresentation;
  onInspectAttestation: (artifact: ArtifactReference) => void;
}): React.JSX.Element {
  const disposition = summary.coverage.summary.byDisposition;
  const attestation = getAttestationHealth(pairedStudio, coverage);
  const attestationArtifact = pairedStudio?.attestationArtifact;
  return (
    <div className="catalog-status">
      <div className="catalog-status__pin">
        <p className="eyebrow">Catalog pin</p>
        <strong>{summary.coverage.summary.total.toLocaleString()} accountable API entries</strong>
        <span>creator-docs {shortHash(summary.catalog.source.commit)} · source {shortHash(summary.catalog.source.sourceTreeHash)}</span>
        <code title={summary.catalog.hash}>catalog {shortHash(summary.catalog.hash)}</code>
      </div>
      <dl className="catalog-status__coverage">
        <div><dt>Authorable</dt><dd>{formatCount(disposition.authorable)}</dd></div>
        <div><dt>Observable</dt><dd>{formatCount(disposition.observable_only)}</dd></div>
        <div><dt>Reviewed</dt><dd>{formatCount(disposition.creator_reviewed)}</dd></div>
        <div><dt>Unsupported</dt><dd>{formatCount(disposition.unsupported)}</dd></div>
      </dl>
      <div className={`catalog-attestation catalog-attestation--${attestation.tone}`}>
        <p className="eyebrow">Coverage &amp; connector</p>
        <strong>{attestation.title}</strong>
        {!pairedStudio?.attestation ? <span>{attestation.detail}</span> : null}
        <code title={summary.manifest.hash}>manifest {shortHash(summary.manifest.hash)} · connector {shortHash(summary.manifest.connectorBuildHash)}</code>
        {pairedStudio?.attestation ? <AttestationEvidence attestation={pairedStudio.attestation} /> : null}
        {attestationArtifact ? (
          <button
            type="button"
            className="quiet-button attestation-evidence__inspect"
            onClick={() => onInspectAttestation(attestationArtifact)}
          >
            Inspect raw attestation
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AttestationEvidence({ attestation }: { attestation: StudioAttestationSummary }): React.JSX.Element {
  return (
    <section className="attestation-evidence" aria-label="Verifier attestation evidence">
      <p className="attestation-evidence__detail">{attestation.detail}</p>
      <dl className="attestation-evidence__counts">
        <div><dt>Reported</dt><dd>{formatCount(attestation.totalFacts)}</dd></div>
        <div><dt>Observed</dt><dd>{formatCount(attestation.observedFacts)}</dd></div>
        <div><dt>Mismatched</dt><dd>{formatCount(attestation.mismatchedFacts)}</dd></div>
        <div><dt>Missing</dt><dd>{formatCount(attestation.missingFacts)}</dd></div>
        <div><dt>Unavailable</dt><dd>{formatCount(attestation.unavailableFacts)}</dd></div>
        <div><dt>Read errors</dt><dd>{formatCount(attestation.readErrorFacts)}</dd></div>
      </dl>
      {attestation.findings.length > 0 ? (
        <>
          <p className="attestation-evidence__heading">Verifier findings</p>
          <ol className="attestation-evidence__findings">
            {attestation.findings.map((finding) => <AttestationFinding key={`${finding.key}:${finding.code}`} finding={finding} />)}
          </ol>
          {attestation.findingsTruncated ? (
            <p className="attestation-evidence__truncated" role="status">
              Additional findings are retained in the immutable attestation artifact.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function AttestationFinding({ finding }: { finding: StudioAttestationFinding }): React.JSX.Element {
  return (
    <li className="attestation-finding">
      <div className="attestation-finding__heading">
        <code>{finding.key}</code>
        <strong>{finding.code}</strong>
      </div>
      {finding.expected ? <EvidenceDimensions label="Expected" value={finding.expected} /> : null}
      {finding.received ? <EvidenceDimensions label="Received" value={finding.received} /> : null}
    </li>
  );
}

function EvidenceDimensions({
  label,
  value,
}: {
  label: string;
  value: StudioAttestationEvidence;
}): React.JSX.Element {
  const entries = flattenEvidence(value);
  return (
    <dl className="attestation-finding__dimensions">
      <dt>{label}</dt>
      <dd>{entries.map(([dimension, type]) => (
        <span key={dimension}><b>{dimension}</b> <code>{type}</code></span>
      ))}</dd>
    </dl>
  );
}

function flattenEvidence(
  value: StudioAttestationEvidenceValue,
  path = "",
): Array<[string, string]> {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [[path || "value", String(value)]];
  if (Array.isArray(value))
    return value.flatMap((entry, index) => flattenEvidence(entry, `${path}[${index}]`));
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, entry]) => flattenEvidence(entry, path ? `${path}.${key}` : key));
}

function CapabilityResults({
  page,
  onExplore,
  proofRoutesAvailable,
}: {
  page: NonNullable<CapabilityExplorerSnapshot["page"]>;
  onExplore: CapabilityExplorerProps["onExplore"];
  proofRoutesAvailable: boolean;
}): React.JSX.Element {
  const selection = page.selection;
  const pageEnd = Math.min(page.page.cursor + page.entries.length, page.page.total);
  return (
    <div className="capability-results">
      <p className="capability-results__count" aria-live="polite">
        {page.page.total === 0
          ? "No catalog entries match this search."
          : `Showing ${page.page.cursor + 1}–${pageEnd} of ${page.page.total.toLocaleString()} entries.`}
      </p>
      <ol className="capability-results__list">
        {page.entries.map((entry) => (
          <CapabilityEntry
            key={entry.catalogEntryId}
            entry={entry}
            proofRoutesAvailable={proofRoutesAvailable}
          />
        ))}
      </ol>
      {page.page.nextCursor !== undefined ? (
        <button
          type="button"
          className="capability-more"
          onClick={() => onExplore({
            ...selection,
            cursor: page.page.nextCursor,
          })}
        >
          Load next {page.page.limit} entries
        </button>
      ) : null}
    </div>
  );
}

function CapabilityEntry({
  entry,
  proofRoutesAvailable,
}: {
  entry: StudioCapabilityExplorerEntry;
  proofRoutesAvailable: boolean;
}): React.JSX.Element {
  const qualifiedName = entry.owner ? `${entry.owner}.${entry.name}` : entry.name;
  return (
    <li className={`capability-entry capability-entry--${entry.disposition}`}>
      <div className="capability-entry__heading">
        <div>
          <span className="capability-entry__kind">{entry.entryKind.replaceAll("_", " ")}</span>
          <h3>{qualifiedName}</h3>
        </div>
        <span className="capability-entry__disposition">{entry.disposition.replaceAll("_", " ")}</span>
      </div>
      <p className="capability-entry__reason"><strong>Reason</strong> {entry.reason.replaceAll("_", " ")}</p>
      <dl className="capability-entry__facts">
        {entry.authoringGroup ? <div><dt>Authoring group</dt><dd>{entry.authoringGroup}</dd></div> : null}
        {entry.codec ? <div><dt>Codec</dt><dd><code>{entry.codec}</code></dd></div> : null}
        {entry.inheritedBy && entry.inheritedBy.length > 0 ? (
          <div><dt>Inherited by</dt><dd title={entry.inheritedBy.join(", ")}>{entry.inheritedBy.join(", ")}</dd></div>
        ) : null}
      </dl>
      {proofRoutesAvailable && entry.proofObligations && entry.proofObligations.length > 0 ? (
        <div className="capability-proof" aria-label={`Proof obligations for ${qualifiedName}`}>
          <span>Proof route</span>
          <ol>{entry.proofObligations.map((stage) => <li key={stage}>{stage}</li>)}</ol>
        </div>
      ) : null}
      <code className="capability-entry__id">{entry.catalogEntryId}</code>
    </li>
  );
}

function ExplorerPlaceholder({ loading }: { loading: boolean }): React.JSX.Element {
  return (
    <p className="capability-results__count" aria-live="polite">
      {loading ? "Loading the pinned catalog index…" : "The capability index is not available yet."}
    </p>
  );
}

function getAttestationHealth(
  pairedStudio: PairedStudioState | undefined,
  coverage: CoveragePresentation,
): { tone: "healthy" | "pending" | "rejected" | "incomplete" | "neutral"; title: string; detail: string } {
  if (coverage.phase === "unbound") {
    return {
      tone: "rejected",
      title: "Coverage report is not bound",
      detail: coverage.detail ?? "Proof routes are withheld until coverage matches the pinned catalog and manifest.",
    };
  }
  if (!pairedStudio || pairedStudio.status !== "paired") {
    return {
      tone: "neutral",
      title: "No live connector attestation",
      detail: "The pinned manifest is available offline. Pair Studio to compare its manifest and connector build.",
    };
  }
  if (pairedStudio.attestationStatus === "rejected") {
    return {
      tone: "rejected",
      title: "Connector attestation rejected",
      detail: pairedStudio.attestation?.detail ?? "The backend verifier rejected the connector attestation.",
    };
  }
  if (pairedStudio.attestationStatus === "incomplete") {
    return {
      tone: "incomplete",
      title: "Connector attestation incomplete",
      detail: pairedStudio.attestation?.detail ?? "The backend verifier recorded incomplete connector evidence.",
    };
  }
  if (!pairedStudio.manifestHash || !pairedStudio.connectorBuildHash) {
    return {
      tone: "pending",
      title: "Connector identity incomplete",
      detail: "Studio must report both its manifest and connector build before Forge can treat an attestation as current.",
    };
  }
  if (pairedStudio.attestationStatus === "verified") {
    return {
      tone: "healthy",
      title: "Curated manifest attested",
      detail: pairedStudio.attestation?.detail ?? "Studio reflection attested the currently paired curated manifest; this is availability evidence, not a broader authoring grant.",
    };
  }
  return {
    tone: "pending",
    title: "Connector attestation pending",
    detail: "Forge is waiting for a complete reflection attestation of the curated manifest.",
  };
}

function coveragePresentation(
  summary: CapabilityExplorerSnapshot["summary"],
  page: CapabilityExplorerSnapshot["page"],
): CoveragePresentation {
  if (!summary) return { phase: "unverified", proofRoutesAvailable: false };
  if (
    summary.coverage.catalogBinding !== "matched" ||
    summary.coverage.manifestBinding !== "matched"
  ) {
    return {
      phase: "unbound",
      proofRoutesAvailable: false,
      detail: "Proof routes are withheld because this coverage report does not match both the pinned catalog and curated manifest.",
    };
  }
  if (
    page &&
    (page.catalogHash !== summary.catalog.hash || page.coverageHash !== summary.coverage.hash)
  ) {
    return {
      phase: "unbound",
      proofRoutesAvailable: false,
      detail: "Proof routes are withheld because this capability page does not match the pinned catalog and coverage report.",
    };
  }
  return { phase: "pinned", proofRoutesAvailable: true };
}

function catalogPhase(
  phase: CapabilityExplorerSnapshot["phase"],
  coverage: CoveragePresentation,
): "ready" | "loading" | "error" {
  if (phase === "loading" || phase === "error") return phase;
  return coverage.phase === "pinned" ? "ready" : "error";
}

function shortHash(value: string): string {
  return `${value.slice(0, 12)}…`;
}

function formatCount(value: number | undefined): string {
  return (value ?? 0).toLocaleString();
}
