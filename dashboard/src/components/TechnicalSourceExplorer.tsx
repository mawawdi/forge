import { useEffect, useRef, useState } from "react";
import { arrayValue, getTechnicalJson, isRecord, stringValue } from "./technical-api";
import type { CreatorArtifactBinding } from "../types";

interface TechnicalSourceExplorerProps {
  readonly anchor: TechnicalSourceEvidenceAnchor | undefined;
  readonly changeSets: readonly CreatorArtifactBinding[];
}

/** A source browser may inspect only the source index named by this event. */
export interface TechnicalSourceEvidenceAnchor {
  readonly conversationId: string;
  readonly eventId: string;
  readonly eventHash: string;
  readonly sourceIndexHash: string;
}

interface SourceDocument {
  readonly documentId: string;
  readonly path: string;
  readonly className: string;
  readonly executionContext: string;
}

interface SourceRead {
  readonly source: string;
  readonly nextCursor?: string;
}

interface SourceResult {
  readonly kind: "search" | "symbols" | "references" | "dependencies";
  readonly rows: readonly SourceResultRow[];
  readonly nextCursor?: string;
}

interface SourceResultRow {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly code?: string;
}

interface SourceEditOperation {
  readonly id: string;
  readonly changeSetId: string;
  readonly path: string;
}

type QueryKind = "search" | "symbols" | "references";
type DependencyDirection = "imports" | "importers" | "closure";
interface SourceRequestScope {
  readonly anchorKey: string | undefined;
  readonly generation: number;
}

/**
 * A deliberately compact, paged navigator for the immutable source index.
 * It is read-only static analysis: no source body here can authorize an edit.
 */
export function TechnicalSourceExplorer({
  anchor,
  changeSets,
}: TechnicalSourceExplorerProps): React.JSX.Element {
  const [documents, setDocuments] = useState<readonly SourceDocument[]>([]);
  const [documentCursor, setDocumentCursor] = useState<string | undefined>();
  const [selectedDocument, setSelectedDocument] = useState<SourceDocument | undefined>();
  const [read, setRead] = useState<SourceRead | undefined>();
  const [query, setQuery] = useState("");
  const [queryKind, setQueryKind] = useState<QueryKind>("search");
  const [queryResult, setQueryResult] = useState<SourceResult | undefined>();
  const [queryCursor, setQueryCursor] = useState<string | undefined>();
  const [dependencies, setDependencies] = useState<SourceResult | undefined>();
  const [dependencyDirection, setDependencyDirection] = useState<DependencyDirection>("imports");
  const [editOperations, setEditOperations] = useState<readonly SourceEditOperation[]>([]);
  const [selectedEdit, setSelectedEdit] = useState<SourceEditOperation | undefined>();
  const [diff, setDiff] = useState<SourceRead | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [pending, setPending] = useState<string | undefined>();
  const anchorKey = anchor ? sourceAnchorKey(anchor) : undefined;
  const requestScopeRef = useRef<SourceRequestScope>({ anchorKey, generation: 0 });
  if (requestScopeRef.current.anchorKey !== anchorKey) {
    requestScopeRef.current = {
      anchorKey,
      generation: requestScopeRef.current.generation + 1,
    };
  }

  useEffect(() => {
    setDocuments([]);
    setDocumentCursor(undefined);
    setSelectedDocument(undefined);
    setRead(undefined);
    setQueryResult(undefined);
    setQueryCursor(undefined);
    setDependencies(undefined);
    setEditOperations([]);
    setSelectedEdit(undefined);
    setDiff(undefined);
    setStatus(undefined);
    setPending(undefined);
  }, [anchorKey]);

  const available = anchor !== undefined;

  async function run(label: string, operation: () => Promise<void>): Promise<void> {
    if (!available || pending) return;
    const scope = requestScopeRef.current;
    setPending(label);
    setStatus(undefined);
    try {
      await operation();
    } catch (error) {
      if (isCurrentScope(scope))
        setStatus(error instanceof Error ? error.message : "Forge could not load source evidence.");
    } finally {
      if (isCurrentScope(scope)) setPending(undefined);
    }
  }

  function isCurrentScope(scope: SourceRequestScope): boolean {
    return requestScopeRef.current === scope;
  }

  async function loadDocuments(cursor?: string): Promise<void> {
    if (!anchor) return;
    const scope = requestScopeRef.current;
    const requestedAnchor = anchor;
    const page = await getTechnicalJson("/api/sources/documents", {
      ...sourceAnchorParameters(requestedAnchor),
      limit: 40,
      cursor,
    });
    if (!isCurrentScope(scope)) return;
    const next = stringValue(page.nextCursor);
    const incoming = arrayValue(page.documents).flatMap(parseDocument);
    setDocuments((current) =>
      cursor ? mergeByKey(current, incoming, (document) => document.documentId) : incoming,
    );
    setDocumentCursor(next);
  }

  async function readDocument(document: SourceDocument, cursor?: string): Promise<void> {
    if (!anchor) return;
    const scope = requestScopeRef.current;
    const requestedAnchor = anchor;
    const page = await getTechnicalJson("/api/sources/read", {
      ...sourceAnchorParameters(requestedAnchor),
      documentId: document.documentId,
      limit: 32 * 1024,
      cursor,
    });
    if (!isCurrentScope(scope)) return;
    const source = stringValue(page.source);
    if (source === undefined) throw new Error("Forge returned an invalid source read page.");
    setSelectedDocument(document);
    const nextCursor = stringValue(page.nextCursor);
    setRead((current) => ({
      source: cursor && current ? `${current.source}${source}` : source,
      ...(nextCursor ? { nextCursor } : {}),
    }));
  }

  async function runQuery(cursor?: string): Promise<void> {
    if (!anchor || !query.trim()) return;
    const scope = requestScopeRef.current;
    const requestedAnchor = anchor;
    const requestedQuery = query;
    const requestedKind = queryKind;
    const parameters = { ...sourceAnchorParameters(requestedAnchor), limit: 50, cursor };
    const endpoint =
      requestedKind === "search"
        ? "/api/sources/search"
        : requestedKind === "symbols"
          ? "/api/sources/symbols"
          : "/api/sources/references";
    const page = await getTechnicalJson(endpoint, {
      ...parameters,
      ...(requestedKind === "references" ? { symbol: requestedQuery } : { query: requestedQuery }),
    });
    if (!isCurrentScope(scope)) return;
    const result = parseQueryResult(page, requestedKind);
    setQueryResult((current) =>
      cursor && current ? { ...result, rows: mergeById(current.rows, result.rows) } : result,
    );
    setQueryCursor(result.nextCursor);
  }

  async function loadDependencies(cursor?: string): Promise<void> {
    if (!anchor || !selectedDocument) return;
    const scope = requestScopeRef.current;
    const requestedAnchor = anchor;
    const requestedDocument = selectedDocument;
    const requestedDirection = dependencyDirection;
    const page = await getTechnicalJson("/api/sources/dependencies", {
      ...sourceAnchorParameters(requestedAnchor),
      documentId: requestedDocument.documentId,
      direction: requestedDirection,
      maxDepth: 16,
      limit: 100,
      cursor,
    });
    if (!isCurrentScope(scope)) return;
    const result = parseDependencyResult(page);
    setDependencies((current) =>
      cursor && current ? { ...result, rows: mergeById(current.rows, result.rows) } : result,
    );
  }

  async function findSealedSourceEdits(): Promise<void> {
    const scope = requestScopeRef.current;
    const operations: SourceEditOperation[] = [];
    for (const changeSet of changeSets) {
      const value = await getTechnicalJson(
        `/api/artifacts/${encodeURIComponent(changeSet.artifact.artifactHash)}`,
      );
      if (!isCurrentScope(scope)) return;
      for (const operation of arrayValue(value.operations)) {
        if (!isRecord(operation) || operation.kind !== "edit_source") continue;
        const id = stringValue(operation.id);
        if (!id) continue;
        const target = isRecord(operation.target) ? operation.target : undefined;
        operations.push({
          id,
          changeSetId: changeSet.id,
          path: stringValue(target?.path) ?? "sealed source edit",
        });
      }
    }
    setEditOperations(mergeById([], operations));
    if (operations.length === 0)
      setStatus("No sealed source edits are attached to this conversation evidence.");
  }

  async function loadDiff(operation: SourceEditOperation, cursor?: string): Promise<void> {
    if (!anchor) return;
    const scope = requestScopeRef.current;
    const requestedAnchor = anchor;
    const page = await getTechnicalJson("/api/sources/diff", {
      ...sourceAnchorParameters(requestedAnchor),
      operationId: operation.id,
      changeSetId: operation.changeSetId,
      limit: 32 * 1024,
      cursor,
    });
    if (!isCurrentScope(scope)) return;
    const edit = isRecord(page.edit) ? page.edit : undefined;
    const before = isRecord(edit?.before) ? edit.before : undefined;
    const replacement = isRecord(edit?.replacement) ? edit.replacement : undefined;
    const source = [
      "— before",
      stringValue(before?.source) ?? "",
      "— replacement",
      stringValue(replacement?.source) ?? "",
    ].join("\n");
    setSelectedEdit(operation);
    const nextCursor = stringValue(page.nextCursor);
    setDiff((current) => ({
      source: cursor && current ? `${current.source}\n${source}` : source,
      ...(nextCursor ? { nextCursor } : {}),
    }));
  }

  return (
    <section className="detail-section technical-source" aria-labelledby="source-explorer-title">
      <div className="technical-section-heading">
        <div>
          <h3 id="source-explorer-title">Project source</h3>
          <p>
            {available
              ? "Read-only source and static dependency analysis from this event’s immutable index."
              : "This event has no exact immutable source-index citation to inspect."}
          </p>
        </div>
        <button
          type="button"
          disabled={!available || pending !== undefined}
          onClick={() => void run("documents", () => loadDocuments())}
        >
          {pending === "documents" ? "Loading…" : "List project source"}
        </button>
      </div>
      {documents.length ? (
        <ul className="technical-document-list" aria-label="Project source documents">
          {documents.map((document) => (
            <li key={document.documentId}>
              <button
                type="button"
                className={
                  selectedDocument?.documentId === document.documentId ? "is-selected" : ""
                }
                disabled={pending !== undefined}
                onClick={() => void run("read", () => readDocument(document))}
              >
                <strong>{document.path}</strong>
                <span>
                  {document.className} · {document.executionContext}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {documentCursor ? (
        <button
          type="button"
          className="technical-more"
          disabled={pending !== undefined}
          onClick={() => void run("documents", () => loadDocuments(documentCursor))}
        >
          Load more source files
        </button>
      ) : null}
      {selectedDocument ? (
        <div className="technical-source__selected">
          <div className="technical-inline-heading">
            <strong>{selectedDocument.path}</strong>
            <span>Static analysis never executes project source.</span>
          </div>
          {read ? (
            <>
              <pre className="technical-response" tabIndex={0}>
                {read.source}
              </pre>
              {read.nextCursor ? (
                <button
                  type="button"
                  className="technical-more"
                  disabled={pending !== undefined}
                  onClick={() =>
                    void run("read", () => readDocument(selectedDocument, read.nextCursor))
                  }
                >
                  Read next source page
                </button>
              ) : null}
            </>
          ) : null}
          <div className="technical-actions">
            <label>
              <span>Dependency view</span>
              <select
                value={dependencyDirection}
                disabled={pending !== undefined}
                onChange={(event) => {
                  setDependencyDirection(event.target.value as DependencyDirection);
                  setDependencies(undefined);
                }}
              >
                <option value="imports">Imports</option>
                <option value="importers">Importers</option>
                <option value="closure">Dependency closure</option>
              </select>
            </label>
            <button
              type="button"
              disabled={pending !== undefined}
              onClick={() => void run("dependencies", () => loadDependencies())}
            >
              Inspect dependencies
            </button>
          </div>
        </div>
      ) : null}
      {dependencies ? <SourceResults result={dependencies} /> : null}
      {dependencies?.nextCursor ? (
        <button
          type="button"
          className="technical-more"
          disabled={pending !== undefined}
          onClick={() => void run("dependencies", () => loadDependencies(dependencies.nextCursor))}
        >
          Load more dependencies
        </button>
      ) : null}
      <form
        className="technical-query"
        onSubmit={(event) => {
          event.preventDefault();
          void run("query", () => runQuery());
        }}
      >
        <label>
          <span>Find in source</span>
          <input
            value={query}
            maxLength={160}
            disabled={!available || pending !== undefined}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="require, InventoryService, or a symbol"
          />
        </label>
        <label>
          <span>Source analysis</span>
          <select
            value={queryKind}
            disabled={!available || pending !== undefined}
            onChange={(event) => setQueryKind(event.target.value as QueryKind)}
          >
            <option value="search">Text search</option>
            <option value="symbols">Symbols</option>
            <option value="references">References</option>
          </select>
        </label>
        <button type="submit" disabled={!available || pending !== undefined || !query.trim()}>
          {pending === "query" ? "Searching…" : "Search source"}
        </button>
      </form>
      {queryResult ? <SourceResults result={queryResult} /> : null}
      {queryCursor ? (
        <button
          type="button"
          className="technical-more"
          disabled={pending !== undefined}
          onClick={() => void run("query", () => runQuery(queryCursor))}
        >
          Load more results
        </button>
      ) : null}
      {changeSets.length && available ? (
        <div className="technical-diff">
          <div className="technical-section-heading">
            <div>
              <h4>Exact source diffs</h4>
              <p>Both sides come from a sealed change set; this browser never computes a diff.</p>
            </div>
            <button
              type="button"
              disabled={pending !== undefined}
              onClick={() => void run("diff-list", findSealedSourceEdits)}
            >
              Find sealed source edits
            </button>
          </div>
          {editOperations.length ? (
            <ul className="technical-document-list" aria-label="Sealed source edits">
              {editOperations.map((operation) => (
                <li key={operation.id}>
                  <button
                    type="button"
                    className={selectedEdit?.id === operation.id ? "is-selected" : ""}
                    disabled={pending !== undefined}
                    onClick={() => void run("diff", () => loadDiff(operation))}
                  >
                    <strong>{operation.path}</strong>
                    <span>{operation.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {diff ? (
            <>
              <pre className="technical-response" tabIndex={0}>
                {diff.source}
              </pre>
              {diff.nextCursor && selectedEdit ? (
                <button
                  type="button"
                  className="technical-more"
                  disabled={pending !== undefined}
                  onClick={() => void run("diff", () => loadDiff(selectedEdit, diff.nextCursor))}
                >
                  Read next diff page
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {status ? (
        <p className="technical-status" role="status" aria-live="polite">
          {status}
        </p>
      ) : null}
    </section>
  );
}

function SourceResults({ result }: { readonly result: SourceResult }): React.JSX.Element {
  return (
    <ul className="technical-results" aria-label={`${result.kind} results`}>
      {result.rows.length ? (
        result.rows.map((row) => (
          <li key={row.id}>
            <strong>{row.title}</strong>
            {row.detail ? <span>{row.detail}</span> : null}
            {row.code ? <code>{row.code}</code> : null}
          </li>
        ))
      ) : (
        <li>No matching static-analysis evidence was returned.</li>
      )}
    </ul>
  );
}

function parseDocument(value: unknown): SourceDocument[] {
  if (!isRecord(value)) return [];
  const documentId = stringValue(value.documentId);
  const path = stringValue(value.path);
  const className = stringValue(value.className);
  const executionContext = stringValue(value.executionContext);
  return documentId && path && className && executionContext
    ? [{ documentId, path, className, executionContext }]
    : [];
}

function parseQueryResult(value: Record<string, unknown>, kind: QueryKind): SourceResult {
  const values =
    kind === "search"
      ? arrayValue(value.matches)
      : kind === "symbols"
        ? arrayValue(value.symbols)
        : arrayValue(value.references);
  const nextCursor = stringValue(value.nextCursor);
  return {
    kind,
    rows: values.flatMap((row, index) => parseQueryRow(row, kind, index)),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function parseQueryRow(value: unknown, kind: QueryKind, index: number): SourceResultRow[] {
  if (!isRecord(value)) return [];
  const document = isRecord(value.document) ? value.document : undefined;
  const path = stringValue(document?.path) ?? "unknown source";
  const location = isRecord(value.location) ? value.location : undefined;
  const line = typeof location?.startLine === "number" ? `line ${location.startLine}` : undefined;
  const name = stringValue(value.name);
  const snippet = stringValue(value.snippet);
  const kindText = stringValue(value.kind) ?? stringValue(value.role);
  return [
    {
      id: stringValue(value.id) ?? `${kind}-${path}-${line ?? index}`,
      title: name ? `${name} · ${path}` : path,
      ...(line || kindText ? { detail: [kindText, line].filter(Boolean).join(" · ") } : {}),
      ...(snippet ? { code: snippet } : {}),
    },
  ];
}

function parseDependencyResult(value: Record<string, unknown>): SourceResult {
  const nextCursor = stringValue(value.nextCursor);
  return {
    kind: "dependencies",
    rows: arrayValue(value.dependencies).flatMap((dependency, index) => {
      if (!isRecord(dependency)) return [];
      const source = isRecord(dependency.source) ? dependency.source : undefined;
      const target = isRecord(dependency.target) ? dependency.target : undefined;
      const sourcePath = stringValue(source?.path) ?? "unknown source";
      const targetPath = stringValue(target?.path);
      const resolution = stringValue(dependency.resolution) ?? "unknown";
      return [
        {
          id: stringValue(dependency.id) ?? `dependency-${sourcePath}-${index}`,
          title: targetPath ? `${sourcePath} → ${targetPath}` : sourcePath,
          detail: [resolution, stringValue(dependency.reason)].filter(Boolean).join(" · "),
        },
      ];
    }),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function mergeById<T extends { readonly id: string }>(
  current: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  return [...new Map([...current, ...incoming].map((value) => [value.id, value])).values()];
}

function mergeByKey<T>(
  current: readonly T[],
  incoming: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  return [...new Map([...current, ...incoming].map((value) => [key(value), value])).values()];
}

function sourceAnchorKey(anchor: TechnicalSourceEvidenceAnchor): string {
  return [anchor.conversationId, anchor.eventId, anchor.eventHash, anchor.sourceIndexHash].join(
    ":",
  );
}

function sourceAnchorParameters(
  anchor: TechnicalSourceEvidenceAnchor,
): Readonly<Record<string, string>> {
  return {
    conversationId: anchor.conversationId,
    eventId: anchor.eventId,
    eventHash: anchor.eventHash,
    sourceIndexHash: anchor.sourceIndexHash,
  };
}
