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

type CapabilityLabel = {
  readonly label: string;
  readonly reasonLabel: string;
};

export function CapabilityExplorer({
  catalog,
  pairedStudio,
  onExplore,
}: CapabilityExplorerProps): React.JSX.Element {
  const [className, setClassName] = useState("");
  const [query, setQuery] = useState("");
  const [selectedAttestationArtifact, setSelectedAttestationArtifact] = useState<
    ArtifactReference | undefined
  >();
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
          <h2 id="capability-explorer-title">Roblox API ledger</h2>
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
        Every pinned Roblox API entry is cataloged here. Direct authoring is transactionally bounded
        and proof-closed; Source API is usable in Luau source without a transactional proof route;
        Observe is read-only; Restricted is outside Forge’s current boundary.
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
          <button type="submit" disabled={catalog.phase === "loading"}>
            Search coverage
          </button>
          <button
            type="button"
            className="quiet-button"
            onClick={clear}
            disabled={catalog.phase === "loading"}
          >
            Clear
          </button>
        </div>
      </form>
      {catalog.error ? (
        <p className="capability-explorer__error" role="status">
          {catalog.error}
        </p>
      ) : null}
      {page ? (
        <CapabilityResults
          page={page}
          onExplore={onExplore}
          proofRoutesAvailable={coverage.proofRoutesAvailable}
        />
      ) : (
        <ExplorerPlaceholder loading={catalog.phase === "loading"} />
      )}
      {selectedAttestationArtifact ? (
        <Suspense
          fallback={<div className="raw-evidence-loading">Loading immutable evidence…</div>}
        >
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
  const directAuthoring = disposition.authorable ?? 0;
  const sourceApi = disposition.source_only ?? 0;
  const observe = (disposition.observable_only ?? 0) + (disposition.creator_reviewed ?? 0);
  const restricted = Math.max(
    0,
    summary.coverage.summary.total - directAuthoring - sourceApi - observe,
  );
  const attestation = getAttestationHealth(pairedStudio, coverage);
  const attestationArtifact = pairedStudio?.attestationArtifact;
  return (
    <div className="catalog-status">
      <div className="catalog-status__pin">
        <strong>{summary.coverage.summary.total.toLocaleString()} cataloged API entries</strong>
        <span>
          creator-docs @ {shortHash(summary.catalog.source.commit)} · source{" "}
          {shortHash(summary.catalog.source.sourceTreeHash)}
        </span>
        <code title={summary.catalog.hash}>catalog {shortHash(summary.catalog.hash)}</code>
      </div>
      <dl className="catalog-status__coverage">
        <div>
          <dt>Direct authoring</dt>
          <dd>{formatCount(directAuthoring)}</dd>
        </div>
        <div>
          <dt>Source API</dt>
          <dd>{formatCount(sourceApi)}</dd>
        </div>
        <div>
          <dt>Observe</dt>
          <dd>{formatCount(observe)}</dd>
        </div>
        <div>
          <dt>Restricted</dt>
          <dd>{formatCount(restricted)}</dd>
        </div>
      </dl>
      <div className={`catalog-attestation catalog-attestation--${attestation.tone}`}>
        <strong>{attestation.title}</strong>
        {!pairedStudio?.attestation ? <span>{attestation.detail}</span> : null}
        <code title={summary.manifest.hash}>
          manifest {shortHash(summary.manifest.hash)} · connector{" "}
          {shortHash(summary.manifest.connectorBuildHash)}
        </code>
        {pairedStudio?.attestation ? (
          <AttestationEvidence attestation={pairedStudio.attestation} />
        ) : null}
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

function AttestationEvidence({
  attestation,
}: {
  attestation: StudioAttestationSummary;
}): React.JSX.Element {
  const findings =
    attestation.mismatchedFacts +
    attestation.missingFacts +
    attestation.unavailableFacts +
    attestation.readErrorFacts;
  return (
    <section className="attestation-evidence" aria-label="Verifier attestation evidence">
      <p className="attestation-evidence__detail">{attestation.detail}</p>
      <dl className="attestation-evidence__counts">
        <div>
          <dt>Observed</dt>
          <dd>
            {formatCount(attestation.observedFacts)}/{formatCount(attestation.totalFacts)}
          </dd>
        </div>
        <div>
          <dt>Findings</dt>
          <dd>{formatCount(findings)}</dd>
        </div>
        <div>
          <dt>Unavailable</dt>
          <dd>{formatCount(attestation.unavailableFacts)}</dd>
        </div>
        <div>
          <dt>Read errors</dt>
          <dd>{formatCount(attestation.readErrorFacts)}</dd>
        </div>
      </dl>
      {attestation.findings.length > 0 ? (
        <>
          <p className="attestation-evidence__heading">Verifier findings</p>
          <ol className="attestation-evidence__findings">
            {attestation.findings.map((finding) => (
              <AttestationFinding key={`${finding.key}:${finding.code}`} finding={finding} />
            ))}
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
      <dd>
        {entries.map(([dimension, type]) => (
          <span key={dimension}>
            <b>{dimension}</b> <code>{type}</code>
          </span>
        ))}
      </dd>
    </dl>
  );
}

function flattenEvidence(
  value: StudioAttestationEvidenceValue,
  path = "",
): Array<[string, string]> {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
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
          onClick={() =>
            onExplore({
              ...selection,
              cursor: page.page.nextCursor,
            })
          }
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
  const label = capabilityLabel(entry.disposition);
  const signature = capabilitySignature(entry);
  const security = capabilitySecurity(entry);
  return (
    <li className={`capability-entry capability-entry--${entry.disposition}`}>
      <div className="capability-entry__heading">
        <div>
          <span className="capability-entry__kind">{entry.entryKind.replaceAll("_", " ")}</span>
          <h3>{qualifiedName}</h3>
        </div>
        <span className="capability-entry__disposition">{label.label}</span>
      </div>
      <p className="capability-entry__reason">
        <strong>{label.reasonLabel}</strong> {entry.reason.replaceAll("_", " ")}
      </p>
      {signature ? <code className="capability-entry__signature">{signature}</code> : null}
      <dl className="capability-entry__facts">
        {entry.authoringGroup ? (
          <div>
            <dt>Authoring group</dt>
            <dd>{entry.authoringGroup}</dd>
          </div>
        ) : null}
        {entry.codec ? (
          <div>
            <dt>Codec</dt>
            <dd>
              <code>{entry.codec}</code>
            </dd>
          </div>
        ) : null}
        {entry.inheritedBy && entry.inheritedBy.length > 0 ? (
          <div>
            <dt>Inherited by</dt>
            <dd title={entry.inheritedBy.join(", ")}>{entry.inheritedBy.join(", ")}</dd>
          </div>
        ) : null}
        {entry.superclass ? (
          <div>
            <dt>Extends</dt>
            <dd>{entry.superclass}</dd>
          </div>
        ) : null}
        {security ? (
          <div>
            <dt>Security</dt>
            <dd>
              <code>{security}</code>
            </dd>
          </div>
        ) : null}
        {entry.capabilities && entry.capabilities.length > 0 ? (
          <div>
            <dt>Capabilities</dt>
            <dd title={entry.capabilities.join(", ")}>{entry.capabilities.join(", ")}</dd>
          </div>
        ) : null}
        {entry.threadSafety ? (
          <div>
            <dt>Thread</dt>
            <dd>{entry.threadSafety}</dd>
          </div>
        ) : null}
        <div>
          <dt>Official source</dt>
          <dd title={entry.sourceFile}>
            <code>
              {entry.sourceFile} · {shortHash(entry.sourceFileHash)}
            </code>
          </dd>
        </div>
      </dl>
      {proofRoutesAvailable && entry.proofObligations && entry.proofObligations.length > 0 ? (
        <div className="capability-proof" aria-label={`Proof obligations for ${qualifiedName}`}>
          <span>Proof route</span>
          <ol>
            {entry.proofObligations.map((stage) => (
              <li key={stage}>{stage}</li>
            ))}
          </ol>
        </div>
      ) : null}
      <code className="capability-entry__id">{entry.catalogEntryId}</code>
    </li>
  );
}

function capabilitySignature(entry: StudioCapabilityExplorerEntry): string | undefined {
  if (entry.parameters || entry.returns) {
    const parameters = (entry.parameters ?? [])
      .map((parameter) => `${parameter.name}: ${parameter.type}`)
      .join(", ");
    const returns = (entry.returns ?? []).map((result) => result.type).join(", ");
    return `${entry.name}(${parameters})${returns ? ` → ${returns}` : ""}`;
  }
  if (entry.valueType) return `${entry.name}: ${entry.valueType}`;
  if (entry.enumValue !== undefined) return `${entry.name} = ${entry.enumValue}`;
  return undefined;
}

function capabilitySecurity(entry: StudioCapabilityExplorerEntry): string | undefined {
  if (!entry.security) return undefined;
  return [
    entry.security.read ? `read ${entry.security.read}` : undefined,
    entry.security.write ? `write ${entry.security.write}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
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
): {
  tone: "healthy" | "pending" | "rejected" | "incomplete" | "neutral";
  title: string;
  detail: string;
} {
  if (coverage.phase === "unbound") {
    return {
      tone: "rejected",
      title: "Coverage report is not bound",
      detail:
        coverage.detail ??
        "Proof routes are withheld until coverage matches the pinned catalog and manifest.",
    };
  }
  if (!pairedStudio || pairedStudio.status !== "paired") {
    return {
      tone: "neutral",
      title: "No live connector attestation",
      detail:
        "The pinned manifest is available offline. Pair Studio to compare its manifest and connector build.",
    };
  }
  if (pairedStudio.attestationStatus === "rejected") {
    return {
      tone: "rejected",
      title: "Connector attestation rejected",
      detail:
        pairedStudio.attestation?.detail ??
        "The backend verifier rejected the connector attestation.",
    };
  }
  if (pairedStudio.attestationStatus === "incomplete") {
    return {
      tone: "incomplete",
      title: "Connector attestation incomplete",
      detail:
        pairedStudio.attestation?.detail ??
        "The backend verifier recorded incomplete connector evidence.",
    };
  }
  if (!pairedStudio.manifestHash || !pairedStudio.connectorBuildHash) {
    return {
      tone: "pending",
      title: "Connector identity incomplete",
      detail:
        "Studio must report both its manifest and connector build before Forge can treat an attestation as current.",
    };
  }
  if (pairedStudio.attestationStatus === "verified") {
    return {
      tone: "healthy",
      title: "Curated manifest attested",
      detail:
        pairedStudio.attestation?.detail ??
        "Studio reflection attested the currently paired curated manifest; this is availability evidence, not a broader authoring grant.",
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
      detail:
        "Proof routes are withheld because this coverage report does not match both the pinned catalog and curated manifest.",
    };
  }
  if (
    page &&
    (page.catalogHash !== summary.catalog.hash || page.coverageHash !== summary.coverage.hash)
  ) {
    return {
      phase: "unbound",
      proofRoutesAvailable: false,
      detail:
        "Proof routes are withheld because this capability page does not match the pinned catalog and coverage report.",
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

function capabilityLabel(disposition: string): CapabilityLabel {
  switch (disposition) {
    case "authorable":
      return { label: "direct authoring", reasonLabel: "Proof" };
    case "observable_only":
      return { label: "observe", reasonLabel: "Boundary" };
    case "creator_reviewed":
      return { label: "observe", reasonLabel: "Creator boundary" };
    case "source_only":
      return { label: "source API", reasonLabel: "Boundary" };
    default:
      return { label: "restricted", reasonLabel: "Blocker" };
  }
}

function shortHash(value: string): string {
  return `${value.slice(0, 12)}…`;
}

function formatCount(value: number | undefined): string {
  return (value ?? 0).toLocaleString();
}
