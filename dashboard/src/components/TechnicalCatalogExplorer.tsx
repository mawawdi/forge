import { useState } from "react";
import { arrayValue, getTechnicalJson, isRecord, stringValue } from "./technical-api";

interface CoverageSummary {
  readonly total: number;
  readonly authorableClasses: number;
  readonly authorableProperties: number;
}

interface CoverageEntry {
  readonly id: string;
  readonly title: string;
  readonly disposition: string;
  readonly reason: string;
}

interface CoveragePage {
  readonly total: number;
  readonly entries: readonly CoverageEntry[];
  readonly nextCursor?: number;
}

/** Paged catalog context, not a substitute for manifest-granted authority. */
export function TechnicalCatalogExplorer(): React.JSX.Element {
  const [summary, setSummary] = useState<CoverageSummary | undefined>();
  const [query, setQuery] = useState("");
  const [className, setClassName] = useState("");
  const [page, setPage] = useState<CoveragePage | undefined>();
  const [pending, setPending] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  async function run(label: string, operation: () => Promise<void>): Promise<void> {
    if (pending) return;
    setPending(label);
    setStatus(undefined);
    try {
      await operation();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Forge could not load API coverage.");
    } finally {
      setPending(undefined);
    }
  }

  async function loadSummary(): Promise<void> {
    const response = await getTechnicalJson("/api/control/catalog");
    const coverage = isRecord(response.coverage) ? response.coverage : undefined;
    const data = isRecord(coverage?.summary) ? coverage.summary : undefined;
    const total = numberValue(data?.total);
    const authorableClasses = numberValue(data?.authorableClasses);
    const authorableProperties = numberValue(data?.authorableProperties);
    if (
      total === undefined ||
      authorableClasses === undefined ||
      authorableProperties === undefined
    )
      throw new Error("Forge returned an invalid API coverage summary.");
    setSummary({ total, authorableClasses, authorableProperties });
  }

  async function loadPage(cursor?: number): Promise<void> {
    const response = await getTechnicalJson("/api/control/capabilities", {
      limit: 20,
      cursor,
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(className.trim() ? { class: className.trim() } : {}),
    });
    const parsed = parseCoveragePage(response);
    setPage((current) =>
      cursor !== undefined && current
        ? { ...parsed, entries: mergeEntries(current.entries, parsed.entries) }
        : parsed,
    );
  }

  return (
    <section className="detail-section technical-catalog" aria-labelledby="coverage-title">
      <div className="technical-section-heading">
        <div>
          <h3 id="coverage-title">Roblox API coverage</h3>
          <p>Search Roblox APIs and see which properties Forge can edit directly.</p>
        </div>
        <button
          type="button"
          disabled={pending !== undefined}
          onClick={() => void run("summary", loadSummary)}
        >
          {pending === "summary" ? "Loading…" : "Load API coverage"}
        </button>
      </div>
      {summary ? (
        <dl className="technical-coverage-summary">
          <div>
            <dt>Catalog entries</dt>
            <dd>{new Intl.NumberFormat().format(summary.total)}</dd>
          </div>
          <div>
            <dt>Supported objects</dt>
            <dd>{new Intl.NumberFormat().format(summary.authorableClasses)}</dd>
          </div>
          <div>
            <dt>Editable properties</dt>
            <dd>{new Intl.NumberFormat().format(summary.authorableProperties)}</dd>
          </div>
        </dl>
      ) : null}
      <form
        className="technical-query technical-query--catalog"
        onSubmit={(event) => {
          event.preventDefault();
          void run("coverage", () => loadPage());
        }}
      >
        <label>
          <span>API search</span>
          <input
            value={query}
            maxLength={160}
            disabled={pending !== undefined}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ProximityPrompt or RequiresLineOfSight"
          />
        </label>
        <label>
          <span>Class filter</span>
          <input
            value={className}
            maxLength={128}
            disabled={pending !== undefined}
            onChange={(event) => setClassName(event.target.value)}
            placeholder="Part"
          />
        </label>
        <button type="submit" disabled={pending !== undefined}>
          {pending === "coverage" ? "Inspecting…" : "Inspect API coverage"}
        </button>
      </form>
      {page ? (
        <>
          <p className="technical-page-count">
            {new Intl.NumberFormat().format(page.total)} matching catalog entries
          </p>
          <ul className="technical-results" aria-label="Roblox API coverage entries">
            {page.entries.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.title}</strong>
                <span>{coverageDescription(entry)}</span>
              </li>
            ))}
          </ul>
          {page.nextCursor !== undefined ? (
            <button
              type="button"
              className="technical-more"
              disabled={pending !== undefined}
              onClick={() => void run("coverage", () => loadPage(page.nextCursor))}
            >
              Load more API entries
            </button>
          ) : null}
        </>
      ) : null}
      {status ? (
        <p className="technical-status" role="status" aria-live="polite">
          {status}
        </p>
      ) : null}
    </section>
  );
}

function coverageDescription(entry: CoverageEntry): string {
  if (entry.disposition === "authorable") return "Forge can edit this directly";
  const reasons: Record<string, string> = {
    deprecated: "Replaced by a newer Roblox API",
    hidden: "Not exposed by Roblox",
    read_only: "Read only",
    security_gated: "Requires Roblox permissions",
    not_serialized: "Runtime value; not stored in the place",
    unsupported_codec: "Direct editing is not supported yet",
    engine_or_external_authority: "Managed by Roblox",
    structure_managed: "Managed when creating or moving objects",
    parent_policy_missing: "Managed when creating or moving objects",
    service_root: "Built-in Roblox service",
    class_not_creatable: "Created by Roblox",
    script_api: "Available through Luau scripts",
    catalog_only: "Reference information",
  };
  return reasons[entry.reason] ?? "Direct editing is not supported";
}

function parseCoveragePage(value: Record<string, unknown>): CoveragePage {
  const page = isRecord(value.page) ? value.page : undefined;
  const total = numberValue(page?.total);
  if (total === undefined) throw new Error("Forge returned an invalid API coverage page.");
  const nextCursor = numberValue(page?.nextCursor);
  return {
    total,
    entries: arrayValue(value.entries).flatMap((entry, index) => parseCoverageEntry(entry, index)),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function parseCoverageEntry(value: unknown, index: number): CoverageEntry[] {
  if (!isRecord(value)) return [];
  const id = stringValue(value.catalogEntryId);
  const name = stringValue(value.name);
  const disposition = stringValue(value.disposition);
  const reason = stringValue(value.reason);
  if (!id || !name || !disposition || !reason) return [];
  const owner = stringValue(value.owner);
  const kind = stringValue(value.entryKind);
  return [
    {
      id: id || `entry-${index}`,
      title: [owner, name, kind].filter(Boolean).join(" · "),
      disposition,
      reason,
    },
  ];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function mergeEntries(
  current: readonly CoverageEntry[],
  incoming: readonly CoverageEntry[],
): readonly CoverageEntry[] {
  return [...new Map([...current, ...incoming].map((entry) => [entry.id, entry])).values()];
}
