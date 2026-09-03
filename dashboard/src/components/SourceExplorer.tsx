import { useEffect, useState, type FormEvent } from "react";
import type {
  CreatorControlView,
  SourceExplorerRequest,
  SourceExplorerResult,
  SourceExplorerSnapshot,
  StudioSourceDependency,
  StudioSourceDocumentLocator,
  StudioSourceLocation,
} from "../types";

interface SourceExplorerProps {
  source: SourceExplorerSnapshot;
  controlView: CreatorControlView | undefined;
  onExplore: (request: SourceExplorerRequest) => void;
}

/**
 * A deliberately small, lazy reader for server-authenticated source index
 * pages. It never derives source text, dependency edges, or an apparent diff
 * in the browser: every displayed fact comes from one GET response.
 */
export function SourceExplorer({
  source,
  controlView,
  onExplore,
}: SourceExplorerProps): React.JSX.Element {
  const [path, setPath] = useState("");
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const [query, setQuery] = useState("");
  const [diffOperationId, setDiffOperationId] = useState("");
  const [diffChangeSetId, setDiffChangeSetId] = useState("");
  const [direction, setDirection] = useState<"imports" | "importers" | "closure">("closure");
  const canExplore = source.sessionId !== undefined && source.phase !== "loading";
  const index = controlView?.projectIndex;

  useEffect(() => {
    setSelectedDocumentId(undefined);
  }, [source.sessionId]);

  function pathPrefix(): string | undefined {
    return path.trim() || undefined;
  }

  function search(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!query.trim()) return;
    onExplore({
      operation: "search",
      query: query.trim(),
      ...(pathPrefix() ? { pathPrefix: pathPrefix() } : {}),
    });
  }

  function readSource(document: StudioSourceDocumentLocator): void {
    setSelectedDocumentId(document.documentId);
    onExplore({ operation: "read", documentId: document.documentId });
  }

  function loadNextPage(): void {
    const cursor = source.result?.page.nextCursor;
    if (!cursor || !source.request) return;
    onExplore({ ...source.request, cursor });
  }

  return (
    <section className="source-explorer" aria-labelledby="source-explorer-title">
      <div className="panel-heading source-explorer__heading">
        <div>
          <h2 id="source-explorer-title">Studio source map</h2>
          <p className="source-explorer__session">
            {source.sessionId
              ? `Immutable index for ${shortId(source.sessionId)}`
              : "Select a creator session to inspect its immutable index."}
          </p>
        </div>
        <span className={`catalog-phase catalog-phase--${sourcePhase(source.phase)}`}>
          {source.phase === "idle"
            ? "Idle"
            : source.phase === "loading"
              ? "Reading"
              : source.phase === "error"
                ? "Unavailable"
                : "Index-bound"}
        </span>
      </div>
      <p className="source-explorer__intro">
        Read-only source navigation is paged and tied to the selected session’s static source index.
        It is not a live Studio mirror and cannot authorize a mutation.
      </p>
      {index ? (
        <div className={`source-index-status source-index-status--${index.status}`}>
          <strong>
            {index.status === "complete"
              ? "Project index complete"
              : `Project index ${index.status}`}
          </strong>
          <span>
            {index.sourceBlobs.toLocaleString()} source blobs ·{" "}
            {index.indexedBytes.toLocaleString()} indexed bytes ·{" "}
            {index.authorityMode.replaceAll("_", " ")}
          </span>
          {index.rootHash ? (
            <code title={index.rootHash}>root {shortHash(index.rootHash)}</code>
          ) : null}
        </div>
      ) : null}
      <form className="source-explorer__form" onSubmit={search}>
        <label>
          <span>Path / prefix</span>
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="ServerScriptService/Systems"
            maxLength={2_048}
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Text / symbol</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="require or InventoryService"
            maxLength={512}
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <div className="source-explorer__primary-actions">
          <button type="submit" disabled={!canExplore || !query.trim()}>
            Search source
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={!canExplore}
            onClick={() => onExplore({ operation: "documents" })}
          >
            List files
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={!canExplore || !selectedDocumentId}
            onClick={() =>
              selectedDocumentId && onExplore({ operation: "read", documentId: selectedDocumentId })
            }
          >
            Read selected
          </button>
        </div>
        <div className="source-explorer__analysis-actions">
          <button
            type="button"
            className="quiet-button"
            disabled={!canExplore || !query.trim()}
            onClick={() =>
              onExplore({
                operation: "symbols",
                query: query.trim(),
                ...(pathPrefix() ? { pathPrefix: pathPrefix() } : {}),
              })
            }
          >
            Find symbols
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={!canExplore || !query.trim()}
            onClick={() =>
              onExplore({
                operation: "references",
                symbol: query.trim(),
                ...(pathPrefix() ? { pathPrefix: pathPrefix() } : {}),
              })
            }
          >
            Find references
          </button>
          <label className="source-explorer__direction">
            <span>Graph</span>
            <select
              value={direction}
              onChange={(event) => setDirection(event.target.value as typeof direction)}
            >
              <option value="closure">Closure</option>
              <option value="imports">Imports</option>
              <option value="importers">Importers</option>
            </select>
          </label>
          <button
            type="button"
            className="quiet-button"
            disabled={!canExplore || !selectedDocumentId}
            onClick={() =>
              selectedDocumentId &&
              onExplore({
                operation: "dependencies",
                documentId: selectedDocumentId,
                direction,
              })
            }
          >
            Trace dependencies
          </button>
        </div>
      </form>
      {source.error ? (
        <p className="source-explorer__error" role="status">
          {source.error}
        </p>
      ) : null}
      {source.result ? (
        <SourceResult result={source.result} onReadSource={readSource} />
      ) : (
        <div className="source-explorer__placeholder">
          <strong>Nothing has been read.</strong>
          <span>
            List or search indexed scripts, then select the exact opaque document identity to read
            or trace it.
          </span>
        </div>
      )}
      {source.phase === "ready" && source.result?.page.nextCursor ? (
        <button type="button" className="source-explorer__more" onClick={loadNextPage}>
          Load next page
        </button>
      ) : null}
      <aside className="source-diff-placeholder" aria-label="Exact source diff">
        <strong>Exact source diff</strong>
        <p>
          Read one bounded hunk from a sealed source edit. Forge reads the immutable before blob and
          immutable replacement blob on the server; this panel never calculates a diff from browser
          state.
        </p>
        <label>
          <span>Source edit operation ID</span>
          <input
            value={diffOperationId}
            onChange={(event) => setDiffOperationId(event.target.value)}
            maxLength={256}
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Change set ID (if needed)</span>
          <input
            value={diffChangeSetId}
            onChange={(event) => setDiffChangeSetId(event.target.value)}
            maxLength={256}
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="quiet-button"
          disabled={!canExplore || !diffOperationId.trim()}
          onClick={() =>
            onExplore({
              operation: "diff",
              operationId: diffOperationId.trim(),
              ...(diffChangeSetId.trim() ? { changeSetId: diffChangeSetId.trim() } : {}),
            })
          }
        >
          Read sealed diff
        </button>
      </aside>
    </section>
  );
}

function SourceResult({
  result,
  onReadSource,
}: {
  result: SourceExplorerResult;
  onReadSource: (document: StudioSourceDocumentLocator) => void;
}): React.JSX.Element {
  switch (result.operation) {
    case "documents":
      return (
        <div className="source-results">
          <SourceResultMeta
            indexHash={result.page.indexHash}
            description={`${result.page.documents.length} indexed script${result.page.documents.length === 1 ? "" : "s"}`}
          />
          <ol className="source-result-list">
            {result.page.documents.map((document) => (
              <DocumentRow
                key={document.documentId}
                document={document}
                onReadSource={onReadSource}
              />
            ))}
          </ol>
        </div>
      );
    case "search":
      return (
        <div className="source-results">
          <SourceResultMeta
            indexHash={result.page.indexHash}
            description={`${result.page.matches.length} source match${result.page.matches.length === 1 ? "" : "es"} for “${result.page.query}”`}
          />
          <ol className="source-result-list">
            {result.page.matches.map((match, index) => (
              <li
                key={`${match.document.documentId}:${match.location.startByte}:${index}`}
                className="source-search-match"
              >
                <SourceLocator locator={match.document} />
                <span className="source-location">{formatLocation(match.location)}</span>
                <pre>{match.snippet}</pre>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => onReadSource(match.document)}
                >
                  Read exact page
                </button>
              </li>
            ))}
          </ol>
        </div>
      );
    case "read":
      return (
        <div className="source-results source-read-result">
          <SourceResultMeta
            indexHash={result.page.indexHash}
            description={`${result.page.range.startByte.toLocaleString()}–${result.page.range.endByte.toLocaleString()} of ${result.page.totalUtf8Bytes.toLocaleString()} UTF-8 bytes`}
          />
          <SourceLocator locator={result.page.document} />
          <pre className="source-read-result__body" tabIndex={0}>
            {result.page.source}
          </pre>
        </div>
      );
    case "symbols":
      return (
        <div className="source-results">
          <SourceResultMeta
            indexHash={result.page.indexHash}
            description={`${result.page.symbols.length} symbol${result.page.symbols.length === 1 ? "" : "s"} for “${result.page.query}”`}
          />
          <ol className="source-result-list">
            {result.page.symbols.map((symbol) => (
              <li key={symbol.id} className="source-fact-row">
                <strong>{symbol.name}</strong>
                <span>{symbol.kind.replaceAll("_", " ")}</span>
                <SourceLocator locator={symbol.document} />
                <span className="source-location">{formatLocation(symbol.location)}</span>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => onReadSource(symbol.document)}
                >
                  Read exact page
                </button>
              </li>
            ))}
          </ol>
        </div>
      );
    case "references":
      return (
        <div className="source-results">
          <SourceResultMeta
            indexHash={result.page.indexHash}
            description={`${result.page.references.length} reference${result.page.references.length === 1 ? "" : "s"} for “${result.page.symbol}”`}
          />
          <ol className="source-result-list">
            {result.page.references.map((reference) => (
              <li key={reference.id} className="source-fact-row">
                <strong>{reference.name}</strong>
                <span>{reference.role}</span>
                <SourceLocator locator={reference.document} />
                <span className="source-location">{formatLocation(reference.location)}</span>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => onReadSource(reference.document)}
                >
                  Read exact page
                </button>
              </li>
            ))}
          </ol>
        </div>
      );
    case "dependencies":
      return (
        <div className="source-results">
          <SourceResultMeta
            indexHash={result.page.indexHash}
            description={`${result.page.dependencies.length} ${result.page.direction} edge${result.page.dependencies.length === 1 ? "" : "s"} from ${result.page.root.path}`}
          />
          {result.page.truncated ? (
            <p className="source-results__truncated">
              The bounded graph traversal was truncated. Narrow the root or direction before relying
              on it.
            </p>
          ) : null}
          <ol className="source-result-list">
            {result.page.dependencies.map((dependency) => (
              <DependencyRow
                key={dependency.id}
                dependency={dependency}
                onReadSource={onReadSource}
              />
            ))}
          </ol>
        </div>
      );
    case "diff":
      return (
        <div className="source-results source-read-result">
          <SourceResultMeta
            indexHash={result.page.sourceIndex.hash}
            description={`Sealed edit ${result.page.edit.ordinal + 1} of ${result.page.edit.editCount} · ${result.page.operation.id}`}
          />
          <SourceLocator locator={result.page.operation.document} />
          <p className="source-results__meta">
            <span>
              before {shortHash(result.page.operation.beforeSourceHash)} → final{" "}
              {shortHash(result.page.operation.finalSourceHash)}
            </span>
            <code title={result.page.changeSet.hash}>
              change {shortHash(result.page.changeSet.hash)}
            </code>
          </p>
          <div className="source-diff-result">
            <section>
              <strong>
                Before · {result.page.edit.before.range.startByte.toLocaleString()}–
                {result.page.edit.before.range.endByte.toLocaleString()} of{" "}
                {result.page.edit.before.totalUtf8Bytes.toLocaleString()} bytes
              </strong>
              <pre className="source-read-result__body" tabIndex={0}>
                {result.page.edit.before.source}
              </pre>
            </section>
            <section>
              <strong>
                Replacement · {result.page.edit.replacement.range.startByte.toLocaleString()}–
                {result.page.edit.replacement.range.endByte.toLocaleString()} of{" "}
                {result.page.edit.replacement.totalUtf8Bytes.toLocaleString()} bytes
              </strong>
              <pre className="source-read-result__body" tabIndex={0}>
                {result.page.edit.replacement.source}
              </pre>
            </section>
          </div>
        </div>
      );
  }
}

function SourceResultMeta({
  indexHash,
  description,
}: {
  indexHash: string;
  description: string;
}): React.JSX.Element {
  return (
    <p className="source-results__meta">
      <span>{description}</span>
      <code title={indexHash}>index {shortHash(indexHash)}</code>
    </p>
  );
}

function DocumentRow({
  document,
  onReadSource,
}: {
  document: StudioSourceDocumentLocator;
  onReadSource: (document: StudioSourceDocumentLocator) => void;
}): React.JSX.Element {
  return (
    <li className="source-document-row">
      <SourceLocator locator={document} />
      <button type="button" className="quiet-button" onClick={() => onReadSource(document)}>
        Read exact page
      </button>
    </li>
  );
}

function DependencyRow({
  dependency,
  onReadSource,
}: {
  dependency: StudioSourceDependency;
  onReadSource: (document: StudioSourceDocumentLocator) => void;
}): React.JSX.Element {
  return (
    <li className={`source-dependency source-dependency--${dependency.resolution}`}>
      <div className="source-dependency__heading">
        <strong>{dependency.resolution}</strong>
        <span>{formatLocation(dependency.location)}</span>
      </div>
      <SourceLocator locator={dependency.source} />
      {dependency.target ? (
        <>
          <span className="source-dependency__arrow">requires →</span>
          <SourceLocator locator={dependency.target} />
        </>
      ) : null}
      {dependency.reason ? (
        <span className="source-dependency__reason">{dependency.reason}</span>
      ) : null}
      <button
        type="button"
        className="quiet-button"
        onClick={() => onReadSource(dependency.source)}
      >
        Read exact page
      </button>
    </li>
  );
}

function SourceLocator({ locator }: { locator: StudioSourceDocumentLocator }): React.JSX.Element {
  return (
    <span className="source-locator">
      <code title={locator.path}>{locator.path}</code>
      <small>
        {locator.className} · {locator.executionContext} · {shortHash(locator.sourceHash)}
      </small>
    </span>
  );
}

function formatLocation(location: StudioSourceLocation): string {
  return `L${location.startLine}:${location.startColumn}–${location.endLine}:${location.endColumn}`;
}

function sourcePhase(phase: SourceExplorerSnapshot["phase"]): "pinned" | "unbound" | "unverified" {
  return phase === "ready" ? "pinned" : phase === "error" ? "unverified" : "unbound";
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function shortId(id: string): string {
  return id.length > 30 ? `${id.slice(0, 27)}…` : id;
}
