import { createHash } from "node:crypto";
import { contentHash, stableJson } from "../../contracts/src/index.js";

/**
 * Pure, bounded navigation over a source snapshot.  This package deliberately
 * knows nothing about Studio transport, project ownership, model tools, or
 * filesystem paths: an authority adapter must first provide verified source
 * documents with their content hashes.
 */
export const SOURCE_INTELLIGENCE_LIMITS = Object.freeze({
  maximumDocumentPageSize: 200,
  maximumSearchResults: 100,
  maximumSearchContextUtf8Bytes: 512,
  maximumReadUtf8Bytes: 32 * 1024,
  maximumSymbolResults: 200,
  maximumReferenceResults: 200,
  maximumDependencyDepth: 16,
  maximumDependencyNodes: 1_024,
  maximumDependencyResults: 1_024,
});

export type SourceExecutionContext = "client" | "server" | "shared";
export type SourceSymbolKind = "local" | "function" | "type" | "export_type";
export type SourceDependencyResolution = "resolved" | "dynamic" | "unresolved";
export type SourceDependencyDirection = "imports" | "importers" | "closure";

export interface SourceDocumentInput {
  readonly documentId: string;
  readonly path: string;
  readonly className: string;
  readonly executionContext: SourceExecutionContext;
  readonly sourceHash: string;
  readonly source: string;
}

/** Immutable source metadata. Bodies are stored separately as blob chunks. */
export interface StudioSourceDocument extends Omit<SourceDocumentInput, "source"> {
  readonly utf8Bytes: number;
  readonly lineCount: number;
}

interface SourceDocumentForIndexing extends StudioSourceDocument {
  readonly source: string;
}

/**
 * Source metadata that can be carried without materializing a source body.
 * Production analysis accepts this descriptor plus a range resolver; fixture
 * parsing is the only API that accepts all bodies directly.
 */
export interface SourceDocumentDescriptor extends SourceDocumentLocator {
  readonly utf8Bytes: number;
}

export interface VerifiedSourceRange {
  readonly startByte: number;
  readonly endByte: number;
  readonly source: string;
}

/** A transport-neutral source chunk whose body is already separately hashed. */
export interface HashVerifiedSourceChunk {
  readonly sourceHash: string;
  readonly ordinal: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly utf8: string;
}

/**
 * A host-owned, revision-bound source-body reader. Its result is checked
 * against the immutable document hash before it becomes navigable. Reads are
 * byte ranges so normal source tools never concatenate the whole project.
 */
export interface VerifiedSourceResolver {
  readonly authority: "verified_source_blob" | "test_fixture_source";
  readRange(
    document: SourceDocumentLocator,
    range: { readonly startByte: number; readonly endByte: number },
  ): VerifiedSourceRange;
  /** Full materialization is reserved for an approved source replacement. */
  read(document: SourceDocumentLocator): string;
}

/**
 * Artifact-backed navigation authority. The asynchronous form is used when
 * source chunks live in separately persisted immutable artifacts, so a page
 * request never has to deserialize unrelated source bodies.
 */
export interface AsyncVerifiedSourceResolver {
  readonly authority: "verified_source_blob";
  readRange(
    document: SourceDocumentLocator,
    range: { readonly startByte: number; readonly endByte: number },
  ): Promise<VerifiedSourceRange>;
}

export interface SourceDocumentLocator {
  readonly documentId: string;
  readonly path: string;
  readonly className: string;
  readonly executionContext: SourceExecutionContext;
  readonly sourceHash: string;
}

export interface SourceLocation {
  readonly startByte: number;
  readonly endByte: number;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface StudioSourceSymbol {
  readonly id: string;
  readonly document: SourceDocumentLocator;
  readonly name: string;
  readonly kind: SourceSymbolKind;
  readonly location: SourceLocation;
}

export interface StudioSourceDependency {
  readonly id: string;
  readonly source: SourceDocumentLocator;
  readonly expressionHash: string;
  readonly location: SourceLocation;
  readonly resolution: SourceDependencyResolution;
  readonly target?: SourceDocumentLocator;
  readonly reason?: string;
  readonly authority: "deterministic_static_require";
}

export interface StudioSourceIndex {
  readonly kind: "StudioSourceIndex";
  readonly id: string;
  readonly hash: string;
  /** `fixture_parser` is never promoted to an LSP-derived semantic index. */
  readonly analysisAuthority: "fixture_parser" | "pinned_luau_lsp";
  /** Exact tool/parser configuration binding, excluding host-local paths. */
  readonly analysisConfigHash: string;
  /** Required for LSP semantic metadata; absent for fixture-only indexes. */
  readonly pinnedToolchainProof?: {
    readonly hash: string;
    readonly lockHash: string;
    readonly platform: string;
  };
  /** Hash of the private Rojo sourcemap used for LSP workspace construction. */
  readonly sourcemapHash?: string;
  /**
   * The exact content-addressed source snapshot identity. For Studio-backed
   * work this is the complete project-index capture hash, not its semantic
   * project revision hash.
   */
  readonly snapshotHash: string;
  readonly documents: readonly StudioSourceDocument[];
  readonly symbols: readonly StudioSourceSymbol[];
  readonly references: readonly SourceReference[];
  readonly dependencies: readonly StudioSourceDependency[];
}

export interface StudioSourceIndexInput {
  readonly snapshotHash: string;
  readonly documents: readonly SourceDocumentInput[];
}

export interface PinnedSourceIndexProvenance {
  readonly analysisConfigHash: string;
  readonly pinnedToolchainProof: {
    readonly hash: string;
    readonly lockHash: string;
    readonly platform: string;
  };
  readonly sourcemapHash: string;
}

export interface SourceDocumentPage {
  readonly indexId: string;
  readonly indexHash: string;
  readonly documents: readonly SourceDocumentLocator[];
  readonly nextCursor?: string;
}

export interface SourceSearchMatch {
  readonly document: SourceDocumentLocator;
  readonly location: SourceLocation;
  /** The exact source range from which `snippet` was returned. */
  readonly snippetRange: {
    readonly startByte: number;
    readonly endByte: number;
  };
  readonly snippet: string;
}

export interface SourceSearchPage {
  readonly indexId: string;
  readonly indexHash: string;
  readonly query: string;
  readonly matches: readonly SourceSearchMatch[];
  /** More matching text existed than the hard result ceiling permits. */
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface SourceReadPage {
  readonly indexId: string;
  readonly indexHash: string;
  readonly document: SourceDocumentLocator;
  readonly totalUtf8Bytes: number;
  readonly range: { readonly startByte: number; readonly endByte: number };
  readonly source: string;
  readonly nextCursor?: string;
}

export interface SourceSymbolPage {
  readonly indexId: string;
  readonly indexHash: string;
  readonly query: string;
  readonly symbols: readonly StudioSourceSymbol[];
  readonly nextCursor?: string;
}

export interface SourceReference {
  readonly id: string;
  readonly document: SourceDocumentLocator;
  readonly name: string;
  readonly role: "declaration" | "reference";
  readonly location: SourceLocation;
}

export interface SourceReferencePage {
  readonly indexId: string;
  readonly indexHash: string;
  readonly symbol: string;
  readonly references: readonly SourceReference[];
  readonly nextCursor?: string;
}

export interface SourceDependencyPage {
  readonly indexId: string;
  readonly indexHash: string;
  readonly root: SourceDocumentLocator;
  readonly direction: SourceDependencyDirection;
  readonly maxDepth: number;
  readonly dependencies: readonly StudioSourceDependency[];
  readonly discoveredNodes: readonly SourceDocumentLocator[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface SourceConsultationOperation {
  readonly kind: "documents" | "search" | "read" | "symbols" | "references" | "dependencies";
  readonly queryHash: string;
  readonly resultHash: string;
  /** Exact source hashes and UTF-8 ranges returned by this one tool call. */
  readonly sources: readonly CreatorSourceConsultedSource[];
  /** Exact static dependency rows returned by this one tool call. */
  readonly dependencyIds: readonly string[];
  /**
   * The exact graph request when this operation is a dependency traversal.
   * This is separate from `sources`: a traversal can discover no edges, so
   * the root must remain explicit evidence rather than inferred from a
   * display path or a result row.
   */
  readonly dependencyRequest?: {
    readonly root: SourceDocumentLocator;
    readonly direction: SourceDependencyDirection;
    readonly maxDepth: number;
  };
}

/**
 * The host produces this from actual read-only calls.  It is intentionally a
 * record of exposed source and static graph facts, not a model-authored claim.
 */
export interface CreatorSourceConsultedSource {
  readonly document: SourceDocumentLocator;
  /** Exact UTF-8 source ranges exposed by a tool result, sorted and unique. */
  readonly ranges: readonly {
    readonly startByte: number;
    readonly endByte: number;
  }[];
}

export interface CreatorSourceConsultation {
  readonly kind: "CreatorSourceConsultation";
  readonly id: string;
  readonly hash: string;
  readonly authority: "static_analysis";
  readonly indexId: string;
  readonly indexHash: string;
  readonly analysisConfigHash: string;
  readonly sources: readonly CreatorSourceConsultedSource[];
  readonly dependencies: readonly StudioSourceDependency[];
  readonly operations: readonly SourceConsultationOperation[];
}

/** Test-fixture-only deterministic navigation metadata. */
export function createStudioSourceIndex(input: StudioSourceIndexInput): StudioSourceIndex {
  return createSourceIndex(input, {
    analysisAuthority: "fixture_parser",
    analysisConfigHash: contentHash(stableJson({ parser: "forge_fixture_luau_navigation_v1" })),
    semanticRows: undefined,
  });
}

/** Only the verified luau-lsp host may call this after bounded stdio collection. */
export function createPinnedLuauLspSourceIndex(
  input: StudioSourceIndexInput,
  semanticRows: {
    readonly symbols: readonly StudioSourceSymbol[];
    readonly references: readonly SourceReference[];
  },
  provenance: PinnedSourceIndexProvenance,
  limits: { readonly maximumStaticDependencyRows: number },
): StudioSourceIndex {
  assertPinnedSourceIndexProvenance(provenance);
  if (
    !Number.isSafeInteger(limits.maximumStaticDependencyRows) ||
    limits.maximumStaticDependencyRows < 1
  )
    fail("Pinned source index dependency bound is invalid");
  return createSourceIndex(input, {
    analysisAuthority: "pinned_luau_lsp",
    analysisConfigHash: provenance.analysisConfigHash,
    pinnedToolchainProof: provenance.pinnedToolchainProof,
    sourcemapHash: provenance.sourcemapHash,
    semanticRows,
    maximumStaticDependencyRows: limits.maximumStaticDependencyRows,
  });
}

function createSourceIndex(
  input: StudioSourceIndexInput,
  options: {
    readonly analysisAuthority: StudioSourceIndex["analysisAuthority"];
    readonly analysisConfigHash: string;
    readonly pinnedToolchainProof?: PinnedSourceIndexProvenance["pinnedToolchainProof"];
    readonly sourcemapHash?: string;
    readonly semanticRows:
      | {
          readonly symbols: readonly StudioSourceSymbol[];
          readonly references: readonly SourceReference[];
        }
      | undefined;
    readonly maximumStaticDependencyRows?: number;
  },
): StudioSourceIndex {
  assertHash(input.snapshotHash, "Source snapshot");
  if (!Array.isArray(input.documents)) fail("Source documents must be a sequence");
  const indexedDocuments = input.documents.map(normalizeDocument).sort(compareDocuments);
  if (
    new Set(indexedDocuments.map((document) => document.documentId)).size !==
    indexedDocuments.length
  )
    fail("Source index document identities must be unique");
  // Luau's static Instance expressions name display paths. This lookup is
  // only a resolver aid: duplicate display paths intentionally remain a
  // fail-closed ambiguity and are never accepted as document authority.
  const documentsByDisplayPath = groupDocumentsByDisplayPath(indexedDocuments);
  const documents = indexedDocuments.map(stripSource);
  const fixtureSymbols = indexedDocuments.flatMap(extractSymbols).sort(compareSymbols);
  const symbols =
    options.semanticRows === undefined
      ? fixtureSymbols
      : canonicalSemanticSymbols(options.semanticRows.symbols, documents);
  const references =
    options.semanticRows === undefined
      ? extractFixtureReferences(indexedDocuments, fixtureSymbols)
      : canonicalSemanticReferences(options.semanticRows.references, documents, symbols);
  const dependencies: StudioSourceDependency[] = [];
  for (const document of indexedDocuments) {
    const remaining =
      options.maximumStaticDependencyRows === undefined
        ? undefined
        : options.maximumStaticDependencyRows - dependencies.length;
    if (remaining !== undefined && remaining <= 0)
      fail("source_analysis_resource_exhausted: static_dependency_rows_exceeded");
    dependencies.push(...extractDependencies(document, documentsByDisplayPath, remaining));
  }
  dependencies.sort(compareDependencies);
  const payload = {
    analysisAuthority: options.analysisAuthority,
    analysisConfigHash: options.analysisConfigHash,
    ...(options.pinnedToolchainProof ? { pinnedToolchainProof: options.pinnedToolchainProof } : {}),
    ...(options.sourcemapHash ? { sourcemapHash: options.sourcemapHash } : {}),
    snapshotHash: input.snapshotHash,
    documents,
    symbols,
    references,
    dependencies,
  };
  const hash = contentHash(stableJson(payload));
  return {
    kind: "StudioSourceIndex",
    id: `studio_source_index_${hash.slice(0, 24)}`,
    hash,
    ...payload,
  };
}

export function assertStudioSourceIndex(value: unknown): asserts value is StudioSourceIndex {
  if (
    !isRecord(value) ||
    value.kind !== "StudioSourceIndex" ||
    (value.analysisAuthority !== "fixture_parser" &&
      value.analysisAuthority !== "pinned_luau_lsp") ||
    !isHash(value.hash) ||
    !isId(value.id) ||
    !isHash(value.snapshotHash) ||
    !isHash(value.analysisConfigHash) ||
    !Array.isArray(value.documents) ||
    !Array.isArray(value.symbols) ||
    !Array.isArray(value.references) ||
    !Array.isArray(value.dependencies)
  )
    fail("Invalid StudioSourceIndex");
  if (
    value.analysisAuthority === "fixture_parser" &&
    (value.pinnedToolchainProof !== undefined || value.sourcemapHash !== undefined)
  )
    fail("Fixture source index must not claim pinned toolchain provenance");
  if (value.analysisAuthority === "pinned_luau_lsp")
    assertPinnedSourceIndexProvenance({
      analysisConfigHash: value.analysisConfigHash,
      pinnedToolchainProof: value.pinnedToolchainProof,
      sourcemapHash: value.sourcemapHash,
    });
  const documents = (value.documents as unknown[]).map(assertIndexedDocument);
  if (
    new Set(documents.map((document) => document.documentId)).size !== documents.length ||
    !isSorted(documents, compareDocuments)
  )
    fail("Studio source index documents must be unique and sorted");
  const indexShell = { documents } as unknown as StudioSourceIndex;
  const symbols = (value.symbols as unknown[]).map((entry) => assertSymbol(entry, indexShell));
  const references = (value.references as unknown[]).map((entry) =>
    assertReference(entry, indexShell),
  );
  const dependencies = (value.dependencies as unknown[]).map((entry) =>
    assertIndexedDependency(entry, indexShell),
  );
  if (
    !isSorted(symbols, compareSymbols) ||
    !isSorted(references, compareReferences) ||
    !isSorted(dependencies, compareDependencies)
  )
    fail("Studio source index rows must be sorted");
  const payload = {
    analysisAuthority: value.analysisAuthority,
    analysisConfigHash: value.analysisConfigHash,
    ...(value.pinnedToolchainProof ? { pinnedToolchainProof: value.pinnedToolchainProof } : {}),
    ...(value.sourcemapHash ? { sourcemapHash: value.sourcemapHash } : {}),
    snapshotHash: value.snapshotHash,
    documents,
    symbols,
    references,
    dependencies,
  };
  const hash = contentHash(stableJson(payload));
  if (value.hash !== hash || value.id !== `studio_source_index_${hash.slice(0, 24)}`)
    fail("Invalid StudioSourceIndex identity");
}

/** Planner/build production boundary: fixture parser output is never eligible. */
export function assertProductionStudioSourceIndex(
  value: unknown,
): asserts value is StudioSourceIndex {
  assertStudioSourceIndex(value);
  if (value.analysisAuthority !== "pinned_luau_lsp")
    fail("Production source intelligence requires pinned Luau LSP semantic metadata");
}

export function listStudioSourceDocuments(
  index: StudioSourceIndex,
  input: { readonly limit?: number; readonly cursor?: string } = {},
): SourceDocumentPage {
  assertStudioSourceIndex(index);
  const limit = boundedLimit(
    input.limit,
    SOURCE_INTELLIGENCE_LIMITS.maximumDocumentPageSize,
    "source document page",
  );
  const queryHash = queryIdentity("documents", {});
  const page = paginate(
    index,
    "documents",
    queryHash,
    input.cursor,
    index.documents.map(locator),
    limit,
  );
  return {
    indexId: index.id,
    indexHash: index.hash,
    documents: page.items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export function searchStudioSource(
  index: StudioSourceIndex,
  resolver: VerifiedSourceResolver,
  input: {
    readonly query: string;
    readonly pathPrefix?: string;
    readonly contextUtf8Bytes?: number;
    readonly limit?: number;
    readonly cursor?: string;
  },
): SourceSearchPage {
  assertStudioSourceIndex(index);
  const query = boundedText(input.query, 512, "source search query");
  const pathPrefix = input.pathPrefix === undefined ? undefined : canonicalPath(input.pathPrefix);
  const contextUtf8Bytes = boundedLimit(
    input.contextUtf8Bytes,
    SOURCE_INTELLIGENCE_LIMITS.maximumSearchContextUtf8Bytes,
    "source search context",
  );
  const limit = boundedLimit(
    input.limit,
    SOURCE_INTELLIGENCE_LIMITS.maximumSearchResults,
    "source search result",
  );
  const queryHash = queryIdentity("search", {
    query,
    ...(pathPrefix ? { pathPrefix } : {}),
    contextUtf8Bytes,
  });
  const collected = collectBoundedSearchMatches(
    index,
    resolver,
    query,
    pathPrefix,
    contextUtf8Bytes,
  );
  const matches = collected.matches;
  const page = paginate(index, "search", queryHash, input.cursor, matches, limit);
  return {
    indexId: index.id,
    indexHash: index.hash,
    query,
    matches: page.items,
    truncated: collected.truncated,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/** Async bounded search for artifact-backed range resolvers. */
export async function searchStudioSourceAsync(
  index: StudioSourceIndex,
  resolver: AsyncVerifiedSourceResolver,
  input: {
    readonly query: string;
    readonly pathPrefix?: string;
    readonly contextUtf8Bytes?: number;
    readonly limit?: number;
    readonly cursor?: string;
  },
): Promise<SourceSearchPage> {
  assertStudioSourceIndex(index);
  const query = boundedText(input.query, 512, "source search query");
  const pathPrefix = input.pathPrefix === undefined ? undefined : canonicalPath(input.pathPrefix);
  const contextUtf8Bytes = boundedLimit(
    input.contextUtf8Bytes,
    SOURCE_INTELLIGENCE_LIMITS.maximumSearchContextUtf8Bytes,
    "source search context",
  );
  const limit = boundedLimit(
    input.limit,
    SOURCE_INTELLIGENCE_LIMITS.maximumSearchResults,
    "source search result",
  );
  const queryHash = queryIdentity("search", {
    query,
    ...(pathPrefix ? { pathPrefix } : {}),
    contextUtf8Bytes,
  });
  const collected = await collectBoundedSearchMatchesAsync(
    index,
    resolver,
    query,
    pathPrefix,
    contextUtf8Bytes,
  );
  const page = paginate(index, "search", queryHash, input.cursor, collected.matches, limit);
  return {
    indexId: index.id,
    indexHash: index.hash,
    query,
    matches: page.items,
    truncated: collected.truncated,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export function readStudioSource(
  index: StudioSourceIndex,
  resolver: VerifiedSourceResolver,
  input: {
    readonly documentId: string;
    readonly maximumUtf8Bytes?: number;
    readonly cursor?: string;
  },
): SourceReadPage {
  assertStudioSourceIndex(index);
  const documentId = boundedId(input.documentId, "source document identity");
  const document = requiredDocument(index, documentId);
  const maximumUtf8Bytes = boundedLimit(
    input.maximumUtf8Bytes,
    SOURCE_INTELLIGENCE_LIMITS.maximumReadUtf8Bytes,
    "source read",
  );
  const queryHash = queryIdentity("read", { documentId, maximumUtf8Bytes });
  const offset = cursorOffset(index, "read", queryHash, input.cursor, document.utf8Bytes);
  const range = readVerifiedSourceRange(resolver, document, {
    startByte: offset,
    endByte: Math.min(document.utf8Bytes, offset + maximumUtf8Bytes),
  });
  if (
    range.startByte !== offset ||
    range.endByte < offset ||
    (range.endByte === offset && document.utf8Bytes !== 0)
  )
    fail("Verified source resolver did not honor the cursor boundary");
  const source = range.source;
  const endByte = range.endByte;
  return {
    indexId: index.id,
    indexHash: index.hash,
    document: locator(document),
    totalUtf8Bytes: document.utf8Bytes,
    range: { startByte: offset, endByte },
    source,
    ...(endByte < document.utf8Bytes
      ? { nextCursor: encodeCursor(index, "read", queryHash, endByte) }
      : {}),
  };
}

/** Async equivalent for artifact-backed source chunks. */
export async function readStudioSourceAsync(
  index: StudioSourceIndex,
  resolver: AsyncVerifiedSourceResolver,
  input: {
    readonly documentId: string;
    readonly maximumUtf8Bytes?: number;
    readonly cursor?: string;
  },
): Promise<SourceReadPage> {
  assertStudioSourceIndex(index);
  const documentId = boundedId(input.documentId, "source document identity");
  const document = requiredDocument(index, documentId);
  const maximumUtf8Bytes = boundedLimit(
    input.maximumUtf8Bytes,
    SOURCE_INTELLIGENCE_LIMITS.maximumReadUtf8Bytes,
    "source read",
  );
  const queryHash = queryIdentity("read", { documentId, maximumUtf8Bytes });
  const offset = cursorOffset(index, "read", queryHash, input.cursor, document.utf8Bytes);
  const range = await readVerifiedSourceRangeAsync(resolver, document, {
    startByte: offset,
    endByte: Math.min(document.utf8Bytes, offset + maximumUtf8Bytes),
  });
  if (
    range.startByte !== offset ||
    range.endByte < offset ||
    (range.endByte === offset && document.utf8Bytes !== 0)
  )
    fail("Verified source resolver did not honor the cursor boundary");
  return {
    indexId: index.id,
    indexHash: index.hash,
    document: locator(document),
    totalUtf8Bytes: document.utf8Bytes,
    range: { startByte: offset, endByte: range.endByte },
    source: range.source,
    ...(range.endByte < document.utf8Bytes
      ? { nextCursor: encodeCursor(index, "read", queryHash, range.endByte) }
      : {}),
  };
}

export function findStudioSourceSymbols(
  index: StudioSourceIndex,
  input: {
    readonly query: string;
    readonly pathPrefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
  },
): SourceSymbolPage {
  assertStudioSourceIndex(index);
  const query = boundedText(input.query, 256, "symbol query");
  const pathPrefix = input.pathPrefix === undefined ? undefined : canonicalPath(input.pathPrefix);
  const limit = boundedLimit(
    input.limit,
    SOURCE_INTELLIGENCE_LIMITS.maximumSymbolResults,
    "symbol result",
  );
  const queryHash = queryIdentity("symbols", {
    query,
    ...(pathPrefix ? { pathPrefix } : {}),
  });
  const symbols = index.symbols.filter(
    (symbol) =>
      symbol.name.includes(query) &&
      (!pathPrefix || withinPrefix(symbol.document.path, pathPrefix)),
  );
  const page = paginate(index, "symbols", queryHash, input.cursor, symbols, limit);
  return {
    indexId: index.id,
    indexHash: index.hash,
    query,
    symbols: page.items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export function findStudioSourceReferences(
  index: StudioSourceIndex,
  input: {
    readonly symbol: string;
    readonly pathPrefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
  },
): SourceReferencePage {
  assertStudioSourceIndex(index);
  const symbol = identifier(input.symbol, "reference symbol");
  const pathPrefix = input.pathPrefix === undefined ? undefined : canonicalPath(input.pathPrefix);
  const limit = boundedLimit(
    input.limit,
    SOURCE_INTELLIGENCE_LIMITS.maximumReferenceResults,
    "reference result",
  );
  const queryHash = queryIdentity("references", {
    symbol,
    ...(pathPrefix ? { pathPrefix } : {}),
  });
  const references = index.references.filter(
    (entry) =>
      entry.name === symbol && (!pathPrefix || withinPrefix(entry.document.path, pathPrefix)),
  );
  const page = paginate(index, "references", queryHash, input.cursor, references, limit);
  return {
    indexId: index.id,
    indexHash: index.hash,
    symbol,
    references: page.items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export function inspectStudioSourceDependencies(
  index: StudioSourceIndex,
  input: {
    readonly documentId: string;
    readonly direction: SourceDependencyDirection;
    readonly maxDepth?: number;
    readonly limit?: number;
    readonly cursor?: string;
  },
): SourceDependencyPage {
  assertStudioSourceIndex(index);
  const documentId = boundedId(input.documentId, "source document identity");
  const root = requiredDocument(index, documentId);
  if (!["imports", "importers", "closure"].includes(input.direction))
    fail("Invalid source dependency direction");
  const maxDepth = boundedLimit(
    input.maxDepth,
    SOURCE_INTELLIGENCE_LIMITS.maximumDependencyDepth,
    "source dependency depth",
  );
  const limit = boundedLimit(
    input.limit,
    SOURCE_INTELLIGENCE_LIMITS.maximumDependencyResults,
    "source dependency result",
  );
  const queryHash = queryIdentity("dependencies", {
    documentId,
    direction: input.direction,
    maxDepth,
  });
  const graph = dependencySelection(index, root, input.direction, maxDepth);
  const page = paginate(index, "dependencies", queryHash, input.cursor, graph.dependencies, limit);
  return {
    indexId: index.id,
    indexHash: index.hash,
    root: locator(root),
    direction: input.direction,
    maxDepth,
    dependencies: page.items,
    discoveredNodes: graph.nodes,
    truncated: graph.truncated,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/** A host-owned recorder; it derives the sealed binding from actual queries. */
export class SourceConsultationRecorder {
  private readonly sources = new Map<
    string,
    {
      document: SourceDocumentLocator;
      ranges: Map<string, { startByte: number; endByte: number }>;
    }
  >();
  private readonly dependencies = new Map<string, StudioSourceDependency>();
  private readonly operations: SourceConsultationOperation[] = [];

  constructor(
    private readonly index: StudioSourceIndex,
    private readonly resolver: VerifiedSourceResolver,
  ) {
    assertStudioSourceIndex(index);
  }

  documentsPage(
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ): SourceDocumentPage {
    const result = listStudioSourceDocuments(this.index, input);
    this.record(
      "documents",
      queryIdentity("documents", {}),
      result.documents.map((document) => ({ document, ranges: [] })),
    );
    return result;
  }

  search(input: Parameters<typeof searchStudioSource>[2]): SourceSearchPage {
    const result = searchStudioSource(this.index, this.resolver, input);
    this.record(
      "search",
      queryIdentity("search", normalizedSearchQuery(input)),
      result.matches.map((entry) => ({
        document: entry.document,
        ranges: [entry.snippetRange],
      })),
    );
    return result;
  }

  read(input: Parameters<typeof readStudioSource>[2]): SourceReadPage {
    const result = readStudioSource(this.index, this.resolver, input);
    this.record("read", queryIdentity("read", normalizedReadQuery(input)), [
      { document: result.document, ranges: [result.range] },
    ]);
    return result;
  }

  symbols(input: Parameters<typeof findStudioSourceSymbols>[1]): SourceSymbolPage {
    const result = findStudioSourceSymbols(this.index, input);
    this.record(
      "symbols",
      queryIdentity("symbols", normalizedSymbolQuery(input)),
      result.symbols.map((entry) => ({
        document: entry.document,
        ranges: [rangeOf(entry.location)],
      })),
    );
    return result;
  }

  references(input: Parameters<typeof findStudioSourceReferences>[1]): SourceReferencePage {
    const result = findStudioSourceReferences(this.index, input);
    this.record(
      "references",
      queryIdentity("references", normalizedReferenceQuery(input)),
      result.references.map((entry) => ({
        document: entry.document,
        ranges: [rangeOf(entry.location)],
      })),
    );
    return result;
  }

  dependenciesPage(
    input: Parameters<typeof inspectStudioSourceDependencies>[1],
  ): SourceDependencyPage {
    const result = inspectStudioSourceDependencies(this.index, input);
    this.record(
      "dependencies",
      queryIdentity("dependencies", normalizedDependencyQuery(input)),
      [
        { document: result.root, ranges: [] },
        ...result.discoveredNodes.map((document) => ({ document, ranges: [] })),
        ...result.dependencies.map((entry) => ({
          document: entry.source,
          ranges: [rangeOf(entry.location)],
        })),
      ],
      result.dependencies,
      {
        root: result.root,
        direction: result.direction,
        maxDepth: result.maxDepth,
      },
    );
    for (const dependency of result.dependencies) this.dependencies.set(dependency.id, dependency);
    return result;
  }

  seal(): CreatorSourceConsultation {
    const payload = {
      authority: "static_analysis" as const,
      indexId: this.index.id,
      indexHash: this.index.hash,
      analysisConfigHash: this.index.analysisConfigHash,
      sources: this.sealedSources(),
      dependencies: [...this.dependencies.values()].sort(compareDependencies),
      operations: [...this.operations],
    };
    const hash = contentHash(stableJson(payload));
    return {
      kind: "CreatorSourceConsultation",
      id: `creator_source_consultation_${hash.slice(0, 24)}`,
      hash,
      ...payload,
    };
  }

  private record(
    kind: SourceConsultationOperation["kind"],
    queryHash: string,
    sources: readonly CreatorSourceConsultedSource[],
    dependencies: readonly StudioSourceDependency[] = [],
    dependencyRequest?: SourceConsultationOperation["dependencyRequest"],
  ): void {
    for (const source of sources) this.addSource(source);
    const resultSources = canonicalSources(sources);
    const dependencyIds = [...new Set(dependencies.map((dependency) => dependency.id))].sort(
      compareText,
    );
    const request =
      dependencyRequest === undefined
        ? undefined
        : {
            root: assertLocator(dependencyRequest.root, this.index),
            direction: dependencyRequest.direction,
            maxDepth: dependencyRequest.maxDepth,
          };
    if (kind === "dependencies" && request === undefined)
      fail("Dependency consultation operation lost its request binding");
    if (kind !== "dependencies" && request !== undefined)
      fail("Only dependency consultation operations may retain a graph request");
    const resultHash = contentHash(
      stableJson({
        kind,
        queryHash,
        sources: resultSources,
        dependencyIds,
        ...(request ? { dependencyRequest: request } : {}),
      }),
    );
    this.operations.push({
      kind,
      queryHash,
      resultHash,
      sources: resultSources,
      dependencyIds,
      ...(request ? { dependencyRequest: request } : {}),
    });
  }

  private addSource(source: CreatorSourceConsultedSource): void {
    const document = assertLocator(source.document, this.index);
    const ranges = source.ranges.map((range) =>
      assertSourceRange(range, requiredDocument(this.index, document.documentId)),
    );
    const existing = this.sources.get(document.documentId) ?? {
      document,
      ranges: new Map(),
    };
    for (const range of ranges) existing.ranges.set(`${range.startByte}:${range.endByte}`, range);
    this.sources.set(document.documentId, existing);
  }

  private sealedSources(): CreatorSourceConsultedSource[] {
    return [...this.sources.values()]
      .map(({ document, ranges }) => ({
        document,
        ranges: [...ranges.values()].sort(compareRanges),
      }))
      .sort(compareConsultedSources);
  }
}

export function assertCreatorSourceConsultation(
  value: unknown,
  index: StudioSourceIndex,
): asserts value is CreatorSourceConsultation {
  assertStudioSourceIndex(index);
  if (
    !isRecord(value) ||
    value.kind !== "CreatorSourceConsultation" ||
    value.authority !== "static_analysis" ||
    !isId(value.id) ||
    !isHash(value.hash) ||
    value.indexId !== index.id ||
    value.indexHash !== index.hash ||
    value.analysisConfigHash !== index.analysisConfigHash ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.dependencies) ||
    !Array.isArray(value.operations)
  )
    fail("Invalid CreatorSourceConsultation");
  const sources = (value.sources as unknown[]).map((entry) => assertConsultedSource(entry, index));
  if (
    new Set(sources.map((entry) => entry.document.documentId)).size !== sources.length ||
    !isSorted(sources, compareConsultedSources)
  )
    fail("Creator source consultation sources must be unique and sorted");
  const dependencies = (value.dependencies as unknown[]).map((entry) =>
    assertDependency(entry, index),
  );
  if (
    new Set(dependencies.map((entry) => entry.id)).size !== dependencies.length ||
    !isSorted(dependencies, compareDependencies)
  )
    fail("Creator source consultation dependencies must be unique and sorted");
  const operations = (value.operations as unknown[]).map((entry) =>
    assertConsultationOperation(entry, index),
  );
  const exposedSources = canonicalSources(operations.flatMap((operation) => operation.sources));
  if (stableJson(exposedSources) !== stableJson(sources))
    fail("Creator source consultation aggregate sources do not match its tool results");
  const exposedDependencyIds = [
    ...new Set(operations.flatMap((operation) => operation.dependencyIds)),
  ].sort(compareText);
  if (
    stableJson(exposedDependencyIds) !==
    stableJson(dependencies.map((dependency) => dependency.id).sort(compareText))
  )
    fail("Creator source consultation aggregate dependencies do not match its tool results");
  const payload = {
    authority: "static_analysis" as const,
    indexId: index.id,
    indexHash: index.hash,
    analysisConfigHash: index.analysisConfigHash,
    sources,
    dependencies,
    operations,
  };
  const hash = contentHash(stableJson(payload));
  if (value.hash !== hash || value.id !== `creator_source_consultation_${hash.slice(0, 24)}`)
    fail("Invalid CreatorSourceConsultation identity");
}

/** Pure replay surface for session/artifact validation; no source body is leaked. */
export function replayCreatorSourceConsultation(
  index: StudioSourceIndex,
  consultation: CreatorSourceConsultation,
): {
  readonly sources: readonly CreatorSourceConsultedSource[];
  readonly dependencies: readonly StudioSourceDependency[];
} {
  assertCreatorSourceConsultation(consultation, index);
  return {
    sources: consultation.sources.map(cloneConsultedSource),
    dependencies: consultation.dependencies.map((entry) => cloneDependency(entry)),
  };
}

function collectBoundedSearchMatches(
  index: StudioSourceIndex,
  resolver: VerifiedSourceResolver,
  query: string,
  pathPrefix: string | undefined,
  contextUtf8Bytes: number,
): {
  readonly matches: readonly SourceSearchMatch[];
  readonly truncated: boolean;
} {
  const matches: SourceSearchMatch[] = [];
  const queryBytes = utf8Bytes(query);
  for (const document of index.documents) {
    if (pathPrefix && !withinPrefix(document.path, pathPrefix)) continue;
    let offset = 0;
    let currentCoordinate: SourceCoordinate = { line: 1, column: 1 };
    let carry = "";
    let carryStartByte = 0;
    let carryCoordinate: SourceCoordinate = currentCoordinate;
    while (offset < document.utf8Bytes) {
      const page = readVerifiedSourceRange(resolver, document, {
        startByte: offset,
        endByte: Math.min(
          document.utf8Bytes,
          offset + SOURCE_INTELLIGENCE_LIMITS.maximumReadUtf8Bytes,
        ),
      });
      if (page.startByte !== offset || page.endByte <= offset)
        fail("Verified source resolver did not advance source search");
      const combined = `${carry}${page.source}`;
      const combinedStartByte = carryStartByte;
      const combinedCoordinate = carryCoordinate;
      let sourceOffset = 0;
      while (sourceOffset <= combined.length - query.length) {
        const found = combined.indexOf(query, sourceOffset);
        if (found < 0) break;
        const end = found + query.length;
        const startByte = combinedStartByte + utf8Bytes(combined.slice(0, found));
        const endByte = startByte + queryBytes;
        if (endByte > page.startByte) {
          if (matches.length >= SOURCE_INTELLIGENCE_LIMITS.maximumSearchResults)
            return { matches, truncated: true };
          const start = advanceSourceCoordinate(combinedCoordinate, combined.slice(0, found));
          const finish = advanceSourceCoordinate(start, combined.slice(found, end));
          const snippet = sourceSearchSnippet(
            resolver,
            document,
            startByte,
            endByte,
            contextUtf8Bytes,
          );
          matches.push({
            document: locator(document),
            location: {
              startByte,
              endByte,
              startLine: start.line,
              startColumn: start.column,
              endLine: finish.line,
              endColumn: finish.column,
            },
            snippetRange: {
              startByte: snippet.startByte,
              endByte: snippet.endByte,
            },
            snippet: snippet.source,
          });
        }
        sourceOffset = end;
      }
      const pageStartCoordinate = currentCoordinate;
      currentCoordinate = advanceSourceCoordinate(pageStartCoordinate, page.source);
      const retained = utf8Suffix(combined, Math.max(queryBytes - 1, 3));
      carry = retained;
      carryStartByte = page.endByte - utf8Bytes(retained);
      carryCoordinate = advanceSourceCoordinate(
        combinedCoordinate,
        combined.slice(0, combined.length - retained.length),
      );
      offset = page.endByte;
    }
  }
  return { matches, truncated: false };
}

async function collectBoundedSearchMatchesAsync(
  index: StudioSourceIndex,
  resolver: AsyncVerifiedSourceResolver,
  query: string,
  pathPrefix: string | undefined,
  contextUtf8Bytes: number,
): Promise<{
  readonly matches: readonly SourceSearchMatch[];
  readonly truncated: boolean;
}> {
  const matches: SourceSearchMatch[] = [];
  const queryBytes = utf8Bytes(query);
  for (const document of index.documents) {
    if (pathPrefix && !withinPrefix(document.path, pathPrefix)) continue;
    let offset = 0;
    let currentCoordinate: SourceCoordinate = { line: 1, column: 1 };
    let carry = "";
    let carryStartByte = 0;
    let carryCoordinate: SourceCoordinate = currentCoordinate;
    while (offset < document.utf8Bytes) {
      const page = await readVerifiedSourceRangeAsync(resolver, document, {
        startByte: offset,
        endByte: Math.min(
          document.utf8Bytes,
          offset + SOURCE_INTELLIGENCE_LIMITS.maximumReadUtf8Bytes,
        ),
      });
      if (page.startByte !== offset || page.endByte <= offset)
        fail("Verified source resolver did not advance source search");
      const combined = `${carry}${page.source}`;
      const combinedStartByte = carryStartByte;
      const combinedCoordinate = carryCoordinate;
      let sourceOffset = 0;
      while (sourceOffset <= combined.length - query.length) {
        const found = combined.indexOf(query, sourceOffset);
        if (found < 0) break;
        const end = found + query.length;
        const startByte = combinedStartByte + utf8Bytes(combined.slice(0, found));
        const endByte = startByte + queryBytes;
        if (endByte > page.startByte) {
          if (matches.length >= SOURCE_INTELLIGENCE_LIMITS.maximumSearchResults)
            return { matches, truncated: true };
          const start = advanceSourceCoordinate(combinedCoordinate, combined.slice(0, found));
          const finish = advanceSourceCoordinate(start, combined.slice(found, end));
          const snippet = await sourceSearchSnippetAsync(
            resolver,
            document,
            startByte,
            endByte,
            contextUtf8Bytes,
          );
          matches.push({
            document: locator(document),
            location: {
              startByte,
              endByte,
              startLine: start.line,
              startColumn: start.column,
              endLine: finish.line,
              endColumn: finish.column,
            },
            snippetRange: {
              startByte: snippet.startByte,
              endByte: snippet.endByte,
            },
            snippet: snippet.source,
          });
        }
        sourceOffset = end;
      }
      currentCoordinate = advanceSourceCoordinate(currentCoordinate, page.source);
      const retained = utf8Suffix(combined, Math.max(queryBytes - 1, 3));
      carry = retained;
      carryStartByte = page.endByte - utf8Bytes(retained);
      carryCoordinate = advanceSourceCoordinate(
        combinedCoordinate,
        combined.slice(0, combined.length - retained.length),
      );
      offset = page.endByte;
    }
  }
  return { matches, truncated: false };
}

interface SourceCoordinate {
  readonly line: number;
  readonly column: number;
}

function advanceSourceCoordinate(start: SourceCoordinate, source: string): SourceCoordinate {
  let line = start.line;
  let column = start.column;
  for (const character of source) {
    if (character === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function utf8Suffix(source: string, maximumBytes: number): string {
  let used = 0;
  let start = source.length;
  while (start > 0) {
    const previous = source.charCodeAt(start - 1);
    const codePointStart =
      previous >= 0xdc00 && previous <= 0xdfff && start >= 2 ? start - 2 : start - 1;
    const character = source.slice(codePointStart, start);
    const bytes = utf8Bytes(character);
    if (used + bytes > maximumBytes) break;
    used += bytes;
    start = codePointStart;
  }
  return source.slice(start);
}

function sourceSearchSnippet(
  resolver: VerifiedSourceResolver,
  document: StudioSourceDocument,
  startByte: number,
  endByte: number,
  maximumBytes: number,
): VerifiedSourceRange {
  const matchBytes = endByte - startByte;
  const before = matchBytes >= maximumBytes ? 0 : Math.floor((maximumBytes - matchBytes) / 2);
  const after = matchBytes >= maximumBytes ? maximumBytes : maximumBytes - matchBytes - before;
  return readVerifiedSourceRange(resolver, document, {
    startByte: Math.max(0, startByte - before),
    endByte: Math.min(document.utf8Bytes, endByte + after),
  });
}

async function sourceSearchSnippetAsync(
  resolver: AsyncVerifiedSourceResolver,
  document: StudioSourceDocument,
  startByte: number,
  endByte: number,
  maximumBytes: number,
): Promise<VerifiedSourceRange> {
  const matchBytes = endByte - startByte;
  const before = matchBytes >= maximumBytes ? 0 : Math.floor((maximumBytes - matchBytes) / 2);
  const after = matchBytes >= maximumBytes ? maximumBytes : maximumBytes - matchBytes - before;
  return readVerifiedSourceRangeAsync(resolver, document, {
    startByte: Math.max(0, startByte - before),
    endByte: Math.min(document.utf8Bytes, endByte + after),
  });
}

function normalizeDocument(input: SourceDocumentInput): SourceDocumentForIndexing {
  if (!isRecord(input)) fail("Invalid source document");
  const documentId = boundedId(input.documentId, "source document identity");
  const path = canonicalPath(input.path);
  const className = boundedText(input.className, 128, "source document class");
  if (!["client", "server", "shared"].includes(input.executionContext))
    fail("Invalid source execution context");
  if (typeof input.source !== "string" || !validUtf8(input.source))
    fail("Source document must contain valid UTF-8 source");
  const bytes = utf8Bytes(input.source);
  assertHash(input.sourceHash, "Source document hash");
  if (contentHash(input.source) !== input.sourceHash)
    fail(`Source document hash does not match its bytes at ${path}`);
  return {
    documentId,
    path,
    className,
    executionContext: input.executionContext,
    sourceHash: input.sourceHash,
    source: input.source,
    utf8Bytes: bytes,
    lineCount: lineCount(input.source),
  };
}

/** Test-only in-memory source authority. Production must bind blob chunks instead. */
export function createTestFixtureSourceResolver(
  inputs: readonly SourceDocumentInput[],
): VerifiedSourceResolver {
  const documents = inputs.map(normalizeDocument);
  const values = new Map(documents.map((document) => [document.documentId, document]));
  return {
    authority: "test_fixture_source",
    read(document): string {
      const source = values.get(document.documentId);
      if (!source || !sameSourceLocator(source, document))
        fail(`Fixture source resolver has no verified body for ${document.documentId}`);
      return source.source;
    },
    readRange(document, requested): VerifiedSourceRange {
      const source = values.get(document.documentId);
      if (!source || !sameSourceLocator(source, document))
        fail(`Fixture source resolver has no verified body for ${document.documentId}`);
      const range = normalizeSourceRange(requested, source.utf8Bytes);
      const selected = utf8Window(source.source, range.startByte, range.endByte - range.startByte);
      return {
        startByte: range.startByte,
        endByte: range.startByte + utf8Bytes(selected),
        source: selected,
      };
    },
  };
}

/**
 * Build a lazy source resolver from independently chunked source bodies.
 * Continuity and the source hash are verified on the first access to each
 * document, never during index admission. This keeps unrelated source bodies
 * out of the working set while still refusing a range from a tampered blob.
 */
export function createHashVerifiedChunkSourceResolver(input: {
  readonly documents: readonly SourceDocumentDescriptor[];
  readonly chunks: readonly HashVerifiedSourceChunk[];
}): VerifiedSourceResolver {
  if (!Array.isArray(input.documents) || !Array.isArray(input.chunks))
    fail("Chunk source resolver requires document descriptors and chunks");
  const documents = input.documents.map(normalizeDescriptor);
  if (new Set(documents.map((document) => document.documentId)).size !== documents.length)
    fail("Chunk source resolver document identities must be unique");
  const referencedHashes = new Map<string, number>();
  for (const document of documents) {
    const existing = referencedHashes.get(document.locator.sourceHash);
    if (existing !== undefined && existing !== document.utf8Bytes)
      fail("Equal source hashes must have equal source byte lengths");
    referencedHashes.set(document.locator.sourceHash, document.utf8Bytes);
  }
  const chunksByHash = new Map<string, HashVerifiedSourceChunk[]>();
  for (const raw of input.chunks) {
    const chunk = normalizeChunk(raw);
    if (!referencedHashes.has(chunk.sourceHash))
      fail("Chunk source resolver received a chunk outside its documents");
    const values = chunksByHash.get(chunk.sourceHash) ?? [];
    values.push(chunk);
    chunksByHash.set(chunk.sourceHash, values);
  }
  const verifiedByHash = new Map<string, readonly HashVerifiedSourceChunk[]>();
  const chunksFor = (sourceHash: string): readonly HashVerifiedSourceChunk[] => {
    const cached = verifiedByHash.get(sourceHash);
    if (cached) return cached;
    const expectedBytes = referencedHashes.get(sourceHash);
    if (expectedBytes === undefined) fail("Chunk source resolver lost its source descriptor");
    const chunks = [...(chunksByHash.get(sourceHash) ?? [])].sort(compareChunks);
    verifyChunkedSource(sourceHash, expectedBytes, chunks);
    verifiedByHash.set(sourceHash, chunks);
    return chunks;
  };
  const byId = new Map(documents.map((document) => [document.documentId, document]));
  return {
    authority: "verified_source_blob",
    read(document): string {
      const expected = byId.get(document.documentId);
      if (!expected || !sameSourceLocator(expected.locator, document))
        fail(`Chunk source resolver has no verified body for ${document.documentId}`);
      const chunks = chunksFor(expected.locator.sourceHash);
      return sourceFromChunks(chunks, 0, expected.utf8Bytes);
    },
    readRange(document, requested): VerifiedSourceRange {
      const expected = byId.get(document.documentId);
      if (!expected || !sameSourceLocator(expected.locator, document))
        fail(`Chunk source resolver has no verified body for ${document.documentId}`);
      const range = normalizeSourceRange(requested, expected.utf8Bytes);
      const chunks = chunksFor(expected.locator.sourceHash);
      const startByte = nextUtf8Boundary(chunks, range.startByte, expected.utf8Bytes);
      const endByte = previousUtf8Boundary(chunks, range.endByte, expected.utf8Bytes);
      if (endByte <= startByte && startByte < expected.utf8Bytes)
        fail("Source range cannot contain a complete UTF-8 code point");
      return {
        startByte,
        endByte,
        source: sourceFromChunks(chunks, startByte, endByte),
      };
    },
  };
}

function readVerifiedSourceRange(
  resolver: VerifiedSourceResolver,
  document: StudioSourceDocument,
  requested: { readonly startByte: number; readonly endByte: number },
): VerifiedSourceRange {
  if (
    !resolver ||
    (resolver.authority !== "verified_source_blob" &&
      resolver.authority !== "test_fixture_source") ||
    typeof resolver.readRange !== "function"
  )
    fail("Source navigation requires a verified source resolver");
  const range = normalizeSourceRange(requested, document.utf8Bytes);
  const result = resolver.readRange(locator(document), range);
  return assertVerifiedSourceRangeResult(result, range, document);
}

async function readVerifiedSourceRangeAsync(
  resolver: AsyncVerifiedSourceResolver,
  document: StudioSourceDocument,
  requested: { readonly startByte: number; readonly endByte: number },
): Promise<VerifiedSourceRange> {
  if (
    !resolver ||
    resolver.authority !== "verified_source_blob" ||
    typeof resolver.readRange !== "function"
  )
    fail("Source navigation requires an artifact-backed verified source resolver");
  const range = normalizeSourceRange(requested, document.utf8Bytes);
  const result = await resolver.readRange(locator(document), range);
  return assertVerifiedSourceRangeResult(result, range, document);
}

function assertVerifiedSourceRangeResult(
  result: unknown,
  range: { readonly startByte: number; readonly endByte: number },
  document: StudioSourceDocument,
): VerifiedSourceRange {
  if (!isRecord(result))
    fail(`Verified source resolver returned an invalid range for ${document.documentId}`);
  const source = result.source;
  const startByte = result.startByte;
  const endByte = result.endByte;
  if (
    typeof source !== "string" ||
    !validUtf8(source) ||
    typeof startByte !== "number" ||
    typeof endByte !== "number" ||
    !Number.isSafeInteger(startByte) ||
    !Number.isSafeInteger(endByte) ||
    startByte < range.startByte ||
    endByte > range.endByte ||
    endByte < startByte ||
    utf8Bytes(source) !== endByte - startByte
  )
    fail(`Verified source resolver returned an invalid range for ${document.documentId}`);
  return {
    startByte,
    endByte,
    source,
  };
}

function normalizeDescriptor(value: SourceDocumentDescriptor): {
  readonly documentId: string;
  readonly locator: SourceDocumentLocator;
  readonly utf8Bytes: number;
} {
  if (!isRecord(value) || !Number.isSafeInteger(value.utf8Bytes) || Number(value.utf8Bytes) < 0)
    fail("Invalid chunk source document descriptor");
  const locatorValue = {
    documentId: boundedId(value.documentId, "source document identity"),
    path: canonicalPath(value.path),
    className: boundedText(value.className, 128, "source document class"),
    executionContext: value.executionContext,
    sourceHash: value.sourceHash,
  };
  if (
    !["client", "server", "shared"].includes(String(locatorValue.executionContext)) ||
    !isHash(locatorValue.sourceHash)
  )
    fail("Invalid chunk source document descriptor");
  return {
    documentId: locatorValue.documentId,
    locator: locatorValue as SourceDocumentLocator,
    utf8Bytes: Number(value.utf8Bytes),
  };
}

function normalizeChunk(value: HashVerifiedSourceChunk): HashVerifiedSourceChunk {
  if (
    !isRecord(value) ||
    !isHash(value.sourceHash) ||
    !Number.isSafeInteger(value.ordinal) ||
    Number(value.ordinal) < 0 ||
    !Number.isSafeInteger(value.startByte) ||
    !Number.isSafeInteger(value.endByte) ||
    Number(value.startByte) < 0 ||
    Number(value.endByte) < Number(value.startByte) ||
    typeof value.utf8 !== "string" ||
    !validUtf8(value.utf8) ||
    utf8Bytes(value.utf8) !== Number(value.endByte) - Number(value.startByte)
  )
    fail("Invalid hash-verified source chunk");
  return {
    sourceHash: value.sourceHash,
    ordinal: Number(value.ordinal),
    startByte: Number(value.startByte),
    endByte: Number(value.endByte),
    utf8: value.utf8,
  };
}

function verifyChunkedSource(
  sourceHash: string,
  expectedBytes: number,
  chunks: readonly HashVerifiedSourceChunk[],
): void {
  if (chunks.length === 0) fail("Chunk source resolver is missing a source body");
  const digest = createHash("sha256");
  let nextStart = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    if (
      chunk.ordinal !== index ||
      chunk.startByte !== nextStart ||
      (chunk.endByte <= chunk.startByte && expectedBytes !== 0)
    )
      fail("Chunk source resolver chunks are not contiguous");
    digest.update(chunk.utf8, "utf8");
    nextStart = chunk.endByte;
  }
  if (nextStart !== expectedBytes || digest.digest("hex") !== sourceHash)
    fail("Chunk source resolver bytes do not match the declared source hash");
}

function normalizeSourceRange(
  value: { readonly startByte: number; readonly endByte: number },
  totalBytes: number,
): { readonly startByte: number; readonly endByte: number } {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.startByte) ||
    !Number.isSafeInteger(value.endByte) ||
    Number(value.startByte) < 0 ||
    Number(value.endByte) < Number(value.startByte) ||
    Number(value.endByte) > totalBytes
  )
    fail("Invalid source byte range");
  return { startByte: Number(value.startByte), endByte: Number(value.endByte) };
}

function compareChunks(left: HashVerifiedSourceChunk, right: HashVerifiedSourceChunk): number {
  return (
    left.ordinal - right.ordinal || left.startByte - right.startByte || left.endByte - right.endByte
  );
}

function sourceByteAt(
  chunks: readonly HashVerifiedSourceChunk[],
  offset: number,
  totalBytes: number,
): number | undefined {
  if (offset < 0 || offset >= totalBytes) return undefined;
  const chunk = chunks.find((entry) => offset >= entry.startByte && offset < entry.endByte);
  if (!chunk) fail("Chunk source resolver has a byte gap");
  return Buffer.from(chunk.utf8, "utf8")[offset - chunk.startByte];
}

function nextUtf8Boundary(
  chunks: readonly HashVerifiedSourceChunk[],
  requested: number,
  totalBytes: number,
): number {
  let offset = requested;
  while (offset < totalBytes) {
    const value = sourceByteAt(chunks, offset, totalBytes);
    if (value === undefined || (value & 0xc0) !== 0x80) return offset;
    offset += 1;
  }
  return totalBytes;
}

function previousUtf8Boundary(
  chunks: readonly HashVerifiedSourceChunk[],
  requested: number,
  totalBytes: number,
): number {
  let offset = requested;
  while (offset > 0) {
    const value = sourceByteAt(chunks, offset, totalBytes);
    if (value === undefined || (value & 0xc0) !== 0x80) return offset;
    offset -= 1;
  }
  return 0;
}

function sourceFromChunks(
  chunks: readonly HashVerifiedSourceChunk[],
  startByte: number,
  endByte: number,
): string {
  if (endByte === startByte) return "";
  const pieces: Buffer[] = [];
  for (const chunk of chunks) {
    if (chunk.endByte <= startByte || chunk.startByte >= endByte) continue;
    const bytes = Buffer.from(chunk.utf8, "utf8");
    pieces.push(
      bytes.subarray(
        Math.max(startByte, chunk.startByte) - chunk.startByte,
        Math.min(endByte, chunk.endByte) - chunk.startByte,
      ),
    );
  }
  const result = Buffer.concat(pieces).toString("utf8");
  if (!validUtf8(result) || utf8Bytes(result) !== endByte - startByte)
    fail("Chunk source resolver returned an invalid UTF-8 window");
  return result;
}

function assertPinnedSourceIndexProvenance(
  value: unknown,
): asserts value is PinnedSourceIndexProvenance {
  if (
    !isRecord(value) ||
    !isHash(value.analysisConfigHash) ||
    !isHash(value.sourcemapHash) ||
    !isRecord(value.pinnedToolchainProof) ||
    !isHash(value.pinnedToolchainProof.hash) ||
    !isHash(value.pinnedToolchainProof.lockHash) ||
    typeof value.pinnedToolchainProof.platform !== "string" ||
    value.pinnedToolchainProof.platform.length === 0
  )
    fail("Pinned source index provenance is invalid");
}

function assertIndexedDocument(value: unknown): StudioSourceDocument {
  if (
    !isRecord(value) ||
    !isId(value.documentId) ||
    typeof value.path !== "string" ||
    typeof value.className !== "string" ||
    !["client", "server", "shared"].includes(String(value.executionContext)) ||
    !isHash(value.sourceHash) ||
    !Number.isSafeInteger(value.utf8Bytes) ||
    Number(value.utf8Bytes) < 0 ||
    !Number.isSafeInteger(value.lineCount) ||
    Number(value.lineCount) < 1 ||
    "source" in value
  )
    fail("Invalid immutable source document metadata");
  return {
    documentId: boundedId(value.documentId, "source document identity"),
    path: canonicalPath(value.path),
    className: boundedText(value.className, 128, "source document class"),
    executionContext: value.executionContext as SourceExecutionContext,
    sourceHash: value.sourceHash,
    utf8Bytes: Number(value.utf8Bytes),
    lineCount: Number(value.lineCount),
  };
}

function assertSymbol(value: unknown, index: StudioSourceIndex): StudioSourceSymbol {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    typeof value.name !== "string" ||
    !["local", "function", "type", "export_type"].includes(String(value.kind))
  )
    fail("Invalid source symbol");
  const document = assertLocator(value.document, index);
  const sourceLocation = assertLocation(
    value.location,
    requiredDocument(index, document.documentId),
  );
  const payload = {
    document,
    name: value.name,
    kind: value.kind,
    startByte: sourceLocation.startByte,
    endByte: sourceLocation.endByte,
  };
  const expectedId = `source_symbol_${contentHash(stableJson(payload)).slice(0, 24)}`;
  if (value.id !== expectedId) fail("Invalid source symbol identity");
  return {
    id: value.id,
    document,
    name: value.name,
    kind: value.kind as SourceSymbolKind,
    location: sourceLocation,
  };
}

function assertReference(value: unknown, index: StudioSourceIndex): SourceReference {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    typeof value.name !== "string" ||
    (value.role !== "declaration" && value.role !== "reference")
  )
    fail("Invalid source reference");
  const document = assertLocator(value.document, index);
  const sourceLocation = assertLocation(
    value.location,
    requiredDocument(index, document.documentId),
  );
  const payload = {
    document,
    name: value.name,
    role: value.role,
    startByte: sourceLocation.startByte,
    endByte: sourceLocation.endByte,
  };
  const expectedId = `source_reference_${contentHash(stableJson(payload)).slice(0, 24)}`;
  if (value.id !== expectedId) fail("Invalid source reference identity");
  return {
    id: value.id,
    document,
    name: value.name,
    role: value.role,
    location: sourceLocation,
  };
}

function assertLocation(value: unknown, document: StudioSourceDocument): SourceLocation {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.startByte) ||
    !Number.isSafeInteger(value.endByte) ||
    Number(value.startByte) < 0 ||
    Number(value.endByte) <= Number(value.startByte) ||
    Number(value.endByte) > document.utf8Bytes ||
    !Number.isSafeInteger(value.startLine) ||
    !Number.isSafeInteger(value.startColumn) ||
    !Number.isSafeInteger(value.endLine) ||
    !Number.isSafeInteger(value.endColumn) ||
    Number(value.startLine) < 1 ||
    Number(value.startColumn) < 1 ||
    Number(value.endLine) < 1 ||
    Number(value.endColumn) < 1
  )
    fail(`Invalid source location at ${document.path}`);
  return {
    startByte: Number(value.startByte),
    endByte: Number(value.endByte),
    startLine: Number(value.startLine),
    startColumn: Number(value.startColumn),
    endLine: Number(value.endLine),
    endColumn: Number(value.endColumn),
  };
}

function assertIndexedDependency(value: unknown, index: StudioSourceIndex): StudioSourceDependency {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    value.authority !== "deterministic_static_require" ||
    !isHash(value.expressionHash) ||
    !["resolved", "dynamic", "unresolved"].includes(String(value.resolution))
  )
    fail("Invalid source dependency");
  const source = assertLocator(value.source, index);
  const sourceLocation = assertLocation(value.location, requiredDocument(index, source.documentId));
  const target = value.target === undefined ? undefined : assertLocator(value.target, index);
  const reason =
    value.reason === undefined
      ? undefined
      : boundedText(value.reason, 256, "source dependency reason");
  if (
    (value.resolution === "resolved") !== (target !== undefined) ||
    (value.resolution === "resolved" && reason !== undefined)
  )
    fail("Invalid source dependency resolution");
  const payload = {
    authority: "deterministic_static_require" as const,
    source,
    expressionHash: value.expressionHash,
    location: sourceLocation,
    resolution: value.resolution as SourceDependencyResolution,
    ...(target ? { target } : {}),
    ...(reason ? { reason } : {}),
  };
  const expectedId = `source_dependency_${contentHash(stableJson(payload)).slice(0, 24)}`;
  if (value.id !== expectedId) fail("Invalid source dependency identity");
  return { id: value.id, ...payload };
}

function canonicalSemanticSymbols(
  values: readonly StudioSourceSymbol[],
  documents: readonly StudioSourceDocument[],
): StudioSourceSymbol[] {
  const index = { documents } as StudioSourceIndex;
  const symbols = values.map((value) => assertSymbol(value, index)).sort(compareSymbols);
  if (new Set(symbols.map((value) => value.id)).size !== symbols.length)
    fail("Luau LSP produced duplicate source symbols");
  return symbols;
}

function canonicalSemanticReferences(
  values: readonly SourceReference[],
  documents: readonly StudioSourceDocument[],
  symbols: readonly StudioSourceSymbol[],
): SourceReference[] {
  const index = { documents, symbols } as StudioSourceIndex;
  const references = values.map((value) => assertReference(value, index)).sort(compareReferences);
  if (new Set(references.map((value) => value.id)).size !== references.length)
    fail("Luau LSP produced duplicate source references");
  return references;
}

function extractFixtureReferences(
  documents: readonly SourceDocumentForIndexing[],
  symbols: readonly StudioSourceSymbol[],
): SourceReference[] {
  const declarations = new Set(
    symbols.map((entry) => `${entry.document.documentId}:${entry.location.startByte}`),
  );
  return documents
    .flatMap((document) =>
      lex(document.source)
        .filter((token) => token.kind === "identifier" && !KEYWORDS.has(token.text))
        .map((token) => fixtureReference(document, token, declarations)),
    )
    .sort(compareReferences);
}

function fixtureReference(
  document: SourceDocumentForIndexing,
  token: Token,
  declarations: ReadonlySet<string>,
): SourceReference {
  const sourceLocation = location(document.source, token.start, token.end);
  const role = declarations.has(`${document.documentId}:${sourceLocation.startByte}`)
    ? ("declaration" as const)
    : ("reference" as const);
  const documentLocator = locator(document);
  const payload = {
    document: documentLocator,
    name: token.text,
    role,
    startByte: sourceLocation.startByte,
    endByte: sourceLocation.endByte,
  };
  return {
    id: `source_reference_${contentHash(stableJson(payload)).slice(0, 24)}`,
    document: documentLocator,
    name: token.text,
    role,
    location: sourceLocation,
  };
}

function stripSource(document: SourceDocumentForIndexing): StudioSourceDocument {
  const { source: _source, ...metadata } = document;
  return metadata;
}

function extractSymbols(document: SourceDocumentForIndexing): StudioSourceSymbol[] {
  const tokens = lex(document.source);
  const symbols: StudioSourceSymbol[] = [];
  const add = (token: Token | undefined, kind: SourceSymbolKind): void => {
    if (!token || token.kind !== "identifier" || KEYWORDS.has(token.text)) return;
    const sourceLocation = location(document.source, token.start, token.end);
    const id = `source_symbol_${contentHash(stableJson({ document: locator(document), name: token.text, kind, startByte: sourceLocation.startByte, endByte: sourceLocation.endByte })).slice(0, 24)}`;
    symbols.push({
      id,
      document: locator(document),
      name: token.text,
      kind,
      location: sourceLocation,
    });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "identifier") continue;
    if (token.text === "local") {
      if (tokens[index + 1]?.text === "function") add(tokens[index + 2], "function");
      else add(tokens[index + 1], "local");
    } else if (token.text === "function") {
      const name = tokens[index + 1];
      if (name?.kind === "identifier") add(name, "function");
    } else if (token.text === "export" && tokens[index + 1]?.text === "type")
      add(tokens[index + 2], "export_type");
    else if (token.text === "type") add(tokens[index + 1], "type");
    else if (tokens[index + 1]?.text === "=" && tokens[index + 2]?.text === "function")
      add(token, "function");
  }
  return dedupeSymbols(symbols);
}

function extractDependencies(
  document: SourceDocumentForIndexing,
  documentsByDisplayPath: ReadonlyMap<string, readonly SourceDocumentForIndexing[]>,
  maximumRows: number | undefined = undefined,
): StudioSourceDependency[] {
  const tokens = lex(document.source);
  const dependencies: StudioSourceDependency[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index]?.text !== "require" ||
      tokens[index]?.kind !== "identifier" ||
      tokens[index + 1]?.text !== "("
    )
      continue;
    const close = matchingParen(tokens, index + 1);
    if (close === undefined) {
      pushDependency(
        dependencies,
        dependency(
          document,
          document.source.slice(tokens[index]!.start),
          location(document.source, tokens[index]!.start, tokens[index]!.end),
          { resolution: "dynamic", reason: "unterminated_require" },
        ),
        maximumRows,
      );
      continue;
    }
    const expression = tokens.slice(index + 2, close);
    const start = expression[0]?.start ?? tokens[index + 1]!.end;
    const end = expression.at(-1)?.end ?? tokens[close]!.start;
    const raw = document.source.slice(start, end);
    const resolved = resolveRequire(document, expression, documentsByDisplayPath);
    pushDependency(
      dependencies,
      dependency(document, raw, location(document.source, start, end), resolved),
      maximumRows,
    );
    index = close;
  }
  return dependencies;
}

function pushDependency(
  values: StudioSourceDependency[],
  value: StudioSourceDependency,
  maximumRows: number | undefined,
): void {
  if (maximumRows !== undefined && values.length >= maximumRows)
    fail("source_analysis_resource_exhausted: static_dependency_rows_exceeded");
  values.push(value);
}

function resolveRequire(
  source: SourceDocumentForIndexing,
  expression: readonly Token[],
  documentsByDisplayPath: ReadonlyMap<string, readonly SourceDocumentForIndexing[]>,
): {
  resolution: SourceDependencyResolution;
  target?: SourceDocumentLocator;
  reason?: string;
} {
  if (expression.length === 0) return { resolution: "dynamic", reason: "empty_require" };
  let index = 0;
  let current: string;
  const first = expression[index];
  const serviceName = expression[index + 4]?.value;
  if (first?.kind === "identifier" && first.text === "script") {
    // Treat `script` as the script Instance itself so the first `.Parent`
    // segment has ordinary Roblox Instance semantics.
    current = source.path;
    index += 1;
  } else if (
    first?.kind === "identifier" &&
    first.text === "game" &&
    expression[index + 1]?.text === ":" &&
    expression[index + 2]?.text === "GetService" &&
    expression[index + 3]?.text === "(" &&
    expression[index + 4]?.kind === "string" &&
    typeof serviceName === "string" &&
    expression[index + 5]?.text === ")"
  ) {
    current = serviceName;
    index += 6;
  } else {
    return { resolution: "dynamic", reason: "non_static_require_expression" };
  }
  while (index < expression.length) {
    const separator = expression[index];
    if (separator?.text === "." && expression[index + 1]?.kind === "identifier") {
      const segment = expression[index + 1]!.text;
      current = segment === "Parent" ? parentPath(current) : joinPath(current, segment);
      index += 2;
      continue;
    }
    if (
      separator?.text === ":" &&
      ["WaitForChild", "FindFirstChild"].includes(expression[index + 1]?.text ?? "") &&
      expression[index + 2]?.text === "(" &&
      expression[index + 3]?.kind === "string" &&
      expression[index + 4]?.text === ")"
    ) {
      current = joinPath(current, expression[index + 3]!.value ?? "");
      index += 5;
      continue;
    }
    return { resolution: "dynamic", reason: "non_static_member_expression" };
  }
  const targets = current.length > 0 ? documentsByDisplayPath.get(current) : undefined;
  if (!targets || targets.length === 0)
    return { resolution: "unresolved", reason: "target_not_indexed" };
  if (targets.length !== 1) return { resolution: "unresolved", reason: "ambiguous_duplicate_path" };
  const target = targets[0]!;
  if (target.className !== "ModuleScript")
    return { resolution: "unresolved", reason: "target_not_module_script" };
  return { resolution: "resolved", target: locator(target) };
}

function dependency(
  source: StudioSourceDocument,
  expression: string,
  sourceLocation: SourceLocation,
  result: {
    resolution: SourceDependencyResolution;
    target?: SourceDocumentLocator;
    reason?: string;
  },
): StudioSourceDependency {
  const expressionHash = contentHash(expression);
  const payload = {
    authority: "deterministic_static_require" as const,
    source: locator(source),
    expressionHash,
    location: sourceLocation,
    resolution: result.resolution,
    ...(result.target ? { target: result.target } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
  const id = `source_dependency_${contentHash(stableJson(payload)).slice(0, 24)}`;
  return { id, ...payload };
}

function dependencySelection(
  index: StudioSourceIndex,
  root: StudioSourceDocument,
  direction: SourceDependencyDirection,
  maxDepth: number,
): {
  dependencies: StudioSourceDependency[];
  nodes: SourceDocumentLocator[];
  truncated: boolean;
} {
  if (direction === "imports") {
    const dependencies = index.dependencies
      .filter((entry) => sameLocator(entry.source, locator(root)))
      .sort(compareDependencies);
    return {
      dependencies,
      nodes: nodesFromDependencies(root, dependencies),
      truncated: false,
    };
  }
  if (direction === "importers") {
    const dependencies = index.dependencies
      .filter(
        (entry) =>
          entry.resolution === "resolved" &&
          entry.target !== undefined &&
          sameLocator(entry.target, locator(root)),
      )
      .sort(compareDependencies);
    return {
      dependencies,
      nodes: nodesFromDependencies(root, dependencies),
      truncated: false,
    };
  }
  const byId = new Map(index.documents.map((document) => [document.documentId, document]));
  const visited = new Set<string>([root.documentId]);
  const queue: Array<{ document: StudioSourceDocument; depth: number }> = [
    { document: root, depth: 0 },
  ];
  const dependencies: StudioSourceDependency[] = [];
  let truncated = false;
  while (queue.length > 0) {
    const next = queue.shift()!;
    const outgoing = index.dependencies
      .filter((entry) => sameLocator(entry.source, locator(next.document)))
      .sort(compareDependencies);
    dependencies.push(...outgoing);
    if (next.depth >= maxDepth) {
      if (outgoing.some((entry) => entry.resolution === "resolved")) truncated = true;
      continue;
    }
    for (const edge of outgoing) {
      if (edge.resolution !== "resolved" || !edge.target || visited.has(edge.target.documentId))
        continue;
      if (visited.size >= SOURCE_INTELLIGENCE_LIMITS.maximumDependencyNodes) {
        truncated = true;
        continue;
      }
      const target = byId.get(edge.target.documentId);
      if (!target) {
        truncated = true;
        continue;
      }
      visited.add(target.documentId);
      queue.push({ document: target, depth: next.depth + 1 });
    }
  }
  return {
    dependencies: dependencies.sort(compareDependencies),
    nodes: [...visited].map((documentId) => locator(byId.get(documentId)!)).sort(compareLocators),
    truncated,
  };
}

function nodesFromDependencies(
  root: StudioSourceDocument,
  dependencies: readonly StudioSourceDependency[],
): SourceDocumentLocator[] {
  const entries = new Map<string, SourceDocumentLocator>([[root.documentId, locator(root)]]);
  for (const dependency of dependencies) {
    entries.set(dependency.source.documentId, dependency.source);
    if (dependency.target) entries.set(dependency.target.documentId, dependency.target);
  }
  return [...entries.values()].sort(compareLocators);
}

function paginate<T>(
  index: StudioSourceIndex,
  kind: CursorKind,
  queryHash: string,
  cursor: string | undefined,
  items: readonly T[],
  limit: number,
): { items: readonly T[]; nextCursor?: string } {
  const offset = cursorOffset(index, kind, queryHash, cursor, items.length);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    ...(nextOffset < items.length
      ? { nextCursor: encodeCursor(index, kind, queryHash, nextOffset) }
      : {}),
  };
}

type CursorKind = "documents" | "search" | "read" | "symbols" | "references" | "dependencies";
interface CursorPayload {
  readonly kind: CursorKind;
  readonly indexHash: string;
  readonly queryHash: string;
  readonly offset: number;
  readonly integrity: string;
}

function encodeCursor(
  index: StudioSourceIndex,
  kind: CursorKind,
  queryHash: string,
  offset: number,
): string {
  const material = { kind, indexHash: index.hash, queryHash, offset };
  const payload: CursorPayload = {
    ...material,
    integrity: contentHash(stableJson(material)),
  };
  return Buffer.from(stableJson(payload), "utf8").toString("base64url");
}

function cursorOffset(
  index: StudioSourceIndex,
  kind: CursorKind,
  queryHash: string,
  cursor: string | undefined,
  total: number,
): number {
  if (cursor === undefined) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    fail(
      "Source cursor is malformed. Omit cursor for the first page; otherwise copy nextCursor from the same tool with unchanged query/document and options.",
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.kind !== kind ||
    parsed.indexHash !== index.hash ||
    parsed.queryHash !== queryHash ||
    !Number.isSafeInteger(parsed.offset) ||
    Number(parsed.offset) < 0 ||
    Number(parsed.offset) > total ||
    !isHash(parsed.integrity)
  )
    fail(
      "Source cursor is invalid for this query. Omit cursor to restart; otherwise copy nextCursor from the same tool with unchanged query/document and options.",
    );
  const material = {
    kind,
    indexHash: index.hash,
    queryHash,
    offset: Number(parsed.offset),
  };
  if (parsed.integrity !== contentHash(stableJson(material)))
    fail("Source cursor integrity check failed");
  return Number(parsed.offset);
}

function queryIdentity(kind: CursorKind, value: object): string {
  return contentHash(stableJson({ kind, ...value }));
}

function normalizedSearchQuery(input: Parameters<typeof searchStudioSource>[2]): object {
  const query = boundedText(input.query, 512, "source search query");
  const pathPrefix = input.pathPrefix === undefined ? undefined : canonicalPath(input.pathPrefix);
  const contextUtf8Bytes = boundedLimit(
    input.contextUtf8Bytes,
    SOURCE_INTELLIGENCE_LIMITS.maximumSearchContextUtf8Bytes,
    "source search context",
  );
  return { query, ...(pathPrefix ? { pathPrefix } : {}), contextUtf8Bytes };
}
function normalizedReadQuery(input: Parameters<typeof readStudioSource>[2]): object {
  return {
    documentId: boundedId(input.documentId, "source document identity"),
    maximumUtf8Bytes: boundedLimit(
      input.maximumUtf8Bytes,
      SOURCE_INTELLIGENCE_LIMITS.maximumReadUtf8Bytes,
      "source read",
    ),
  };
}
function normalizedSymbolQuery(input: Parameters<typeof findStudioSourceSymbols>[1]): object {
  const query = boundedText(input.query, 256, "symbol query");
  const pathPrefix = input.pathPrefix === undefined ? undefined : canonicalPath(input.pathPrefix);
  return { query, ...(pathPrefix ? { pathPrefix } : {}) };
}
function normalizedReferenceQuery(input: Parameters<typeof findStudioSourceReferences>[1]): object {
  const symbol = identifier(input.symbol, "reference symbol");
  const pathPrefix = input.pathPrefix === undefined ? undefined : canonicalPath(input.pathPrefix);
  return { symbol, ...(pathPrefix ? { pathPrefix } : {}) };
}
function normalizedDependencyQuery(
  input: Parameters<typeof inspectStudioSourceDependencies>[1],
): object {
  const documentId = boundedId(input.documentId, "source document identity");
  if (!["imports", "importers", "closure"].includes(input.direction))
    fail("Invalid source dependency direction");
  return {
    documentId,
    direction: input.direction,
    maxDepth: boundedLimit(
      input.maxDepth,
      SOURCE_INTELLIGENCE_LIMITS.maximumDependencyDepth,
      "source dependency depth",
    ),
  };
}

function assertLocator(value: unknown, index: StudioSourceIndex): SourceDocumentLocator {
  if (
    !isRecord(value) ||
    !isId(value.documentId) ||
    typeof value.path !== "string" ||
    typeof value.className !== "string" ||
    !["client", "server", "shared"].includes(String(value.executionContext)) ||
    !isHash(value.sourceHash)
  )
    fail("Invalid source document locator");
  const document = index.documents.find((entry) => entry.documentId === value.documentId);
  if (!document || stableJson(locator(document)) !== stableJson(value))
    fail("Source consultation references a document outside its index");
  return locator(document);
}

function assertConsultedSource(
  value: unknown,
  index: StudioSourceIndex,
): CreatorSourceConsultedSource {
  if (!isRecord(value) || !Array.isArray(value.ranges)) fail("Invalid consulted source");
  const document = assertLocator(value.document, index);
  const indexed = requiredDocument(index, document.documentId);
  const ranges = (value.ranges as unknown[]).map((range) => assertSourceRange(range, indexed));
  if (!isSorted(ranges, compareRanges)) fail("Consulted source ranges must be sorted and unique");
  return { document, ranges };
}

function assertSourceRange(
  value: unknown,
  document: StudioSourceDocument,
): { startByte: number; endByte: number } {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.startByte) ||
    !Number.isSafeInteger(value.endByte) ||
    Number(value.startByte) < 0 ||
    Number(value.endByte) <= Number(value.startByte) ||
    Number(value.endByte) > document.utf8Bytes
  )
    fail(`Invalid source range at ${document.path}`);
  return { startByte: Number(value.startByte), endByte: Number(value.endByte) };
}

function assertDependency(value: unknown, index: StudioSourceIndex): StudioSourceDependency {
  if (!isRecord(value) || !isId(value.id)) fail("Invalid source dependency");
  const dependency = index.dependencies.find((entry) => entry.id === value.id);
  if (!dependency || stableJson(dependency) !== stableJson(value))
    fail("Source consultation references a dependency outside its index");
  return cloneDependency(dependency);
}

function assertConsultationOperation(
  value: unknown,
  index: StudioSourceIndex,
): SourceConsultationOperation {
  if (
    !isRecord(value) ||
    !["documents", "search", "read", "symbols", "references", "dependencies"].includes(
      String(value.kind),
    ) ||
    !isHash(value.queryHash) ||
    !isHash(value.resultHash) ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.dependencyIds)
  )
    fail("Invalid source consultation operation");
  const sources = (value.sources as unknown[]).map((entry) => assertConsultedSource(entry, index));
  if (
    new Set(sources.map((entry) => entry.document.documentId)).size !== sources.length ||
    !isSorted(sources, compareConsultedSources)
  )
    fail("Source consultation operation sources must be unique and sorted");
  const dependencyIds = (value.dependencyIds as unknown[]).map((entry) => {
    if (!isId(entry) || !index.dependencies.some((dependency) => dependency.id === entry))
      fail("Source consultation operation dependency is outside its index");
    return entry;
  });
  if (new Set(dependencyIds).size !== dependencyIds.length || !isSorted(dependencyIds, compareText))
    fail("Source consultation operation dependencies must be unique and sorted");
  const kind = value.kind as SourceConsultationOperation["kind"];
  const dependencyRequest =
    value.dependencyRequest === undefined
      ? undefined
      : assertConsultationDependencyRequest(value.dependencyRequest, index);
  if (kind === "dependencies" && dependencyRequest === undefined)
    fail("Dependency consultation operation lacks its request binding");
  if (kind !== "dependencies" && dependencyRequest !== undefined)
    fail("Only dependency consultation operations may retain a graph request");
  const resultHash = contentHash(
    stableJson({
      kind,
      queryHash: value.queryHash,
      sources,
      dependencyIds,
      ...(dependencyRequest ? { dependencyRequest } : {}),
    }),
  );
  if (value.resultHash !== resultHash) fail("Source consultation operation result hash is invalid");
  return {
    kind,
    queryHash: value.queryHash,
    resultHash,
    sources,
    dependencyIds,
    ...(dependencyRequest ? { dependencyRequest } : {}),
  };
}

function assertConsultationDependencyRequest(
  value: unknown,
  index: StudioSourceIndex,
): NonNullable<SourceConsultationOperation["dependencyRequest"]> {
  if (
    !isRecord(value) ||
    !["imports", "importers", "closure"].includes(String(value.direction)) ||
    !Number.isSafeInteger(value.maxDepth) ||
    Number(value.maxDepth) < 1 ||
    Number(value.maxDepth) > SOURCE_INTELLIGENCE_LIMITS.maximumDependencyDepth
  )
    fail("Invalid dependency consultation request binding");
  return {
    root: assertLocator(value.root, index),
    direction: value.direction as SourceDependencyDirection,
    maxDepth: Number(value.maxDepth),
  };
}

interface Token {
  readonly kind: "identifier" | "string" | "symbol";
  readonly text: string;
  readonly value?: string;
  readonly start: number;
  readonly end: number;
}
const KEYWORDS = new Set([
  "and",
  "break",
  "continue",
  "do",
  "else",
  "elseif",
  "end",
  "export",
  "false",
  "for",
  "function",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "type",
  "until",
  "while",
]);

/** A deliberately small scanner: it never executes, type-checks, or evaluates Luau. */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && source[index + 1] === "-") {
      const long = longBracket(source, index + 2);
      if (long) {
        index = long.end;
        continue;
      }
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    const long = character === "[" ? longBracket(source, index) : undefined;
    if (long) {
      tokens.push({
        kind: "string",
        text: source.slice(index, long.end),
        value: long.value,
        start: index,
        end: long.end,
      });
      index = long.end;
      continue;
    }
    if (character === '"' || character === "'") {
      const token = shortString(source, index, character);
      tokens.push(token);
      index = token.end;
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_]/u.test(source[index]!)) index += 1;
      tokens.push({
        kind: "identifier",
        text: source.slice(start, index),
        start,
        end: index,
      });
      continue;
    }
    tokens.push({
      kind: "symbol",
      text: character,
      start: index,
      end: index + 1,
    });
    index += 1;
  }
  return tokens;
}

function longBracket(
  source: string,
  start: number,
): { readonly end: number; readonly value: string } | undefined {
  if (source[start] !== "[") return undefined;
  let equals = 0;
  while (source[start + 1 + equals] === "=") equals += 1;
  if (source[start + 1 + equals] !== "[") return undefined;
  const openingEnd = start + equals + 2;
  const close = `]${"=".repeat(equals)}]`;
  const endStart = source.indexOf(close, openingEnd);
  if (endStart < 0) return { end: source.length, value: source.slice(openingEnd) };
  return {
    end: endStart + close.length,
    value: source.slice(openingEnd, endStart),
  };
}

function shortString(source: string, start: number, quote: string): Token {
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const character = source[index]!;
    if (character === quote)
      return {
        kind: "string",
        text: source.slice(start, index + 1),
        value,
        start,
        end: index + 1,
      };
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) break;
      value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
      index += 2;
      continue;
    }
    value += character;
    index += 1;
  }
  return {
    kind: "string",
    text: source.slice(start),
    value,
    start,
    end: source.length,
  };
}

function matchingParen(tokens: readonly Token[], open: number): number | undefined {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index]?.text === "(") depth += 1;
    else if (tokens[index]?.text === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function location(source: string, start: number, end: number): SourceLocation {
  const startByte = byteOffset(source, start);
  const endByte = byteOffset(source, end);
  const startPosition = lineColumn(source, start);
  const endPosition = lineColumn(source, end);
  return {
    startByte,
    endByte,
    startLine: startPosition.line,
    startColumn: startPosition.column,
    endLine: endPosition.line,
    endColumn: endPosition.column,
  };
}

function lineColumn(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, offset);
  const line = (prefix.match(/\n/gu) ?? []).length + 1;
  const previousNewline = prefix.lastIndexOf("\n");
  return {
    line,
    column: Array.from(prefix.slice(previousNewline + 1)).length + 1,
  };
}

function byteOffset(source: string, codeUnitOffset: number): number {
  return utf8Bytes(source.slice(0, codeUnitOffset));
}
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
function lineCount(value: string): number {
  return value.length === 0 ? 1 : (value.match(/\n/gu) ?? []).length + 1;
}

function utf8Window(source: string, startByte: number, maximumBytes: number): string {
  if (startByte < 0 || maximumBytes <= 0) fail("Invalid UTF-8 source window");
  let skipped = 0;
  let start = 0;
  while (start < source.length && skipped < startByte) {
    const codePoint = source.codePointAt(start);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const bytes = utf8Bytes(character);
    if (skipped + bytes > startByte) fail("Source cursor is not aligned to a UTF-8 boundary");
    skipped += bytes;
    start += character.length;
  }
  if (skipped !== startByte) fail("Source cursor is outside the source body");
  let end = start;
  let used = 0;
  while (end < source.length) {
    const codePoint = source.codePointAt(end);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const bytes = utf8Bytes(character);
    if (used + bytes > maximumBytes) break;
    used += bytes;
    end += character.length;
  }
  return source.slice(start, end);
}

function locator(document: StudioSourceDocument): SourceDocumentLocator {
  return {
    documentId: document.documentId,
    path: document.path,
    className: document.className,
    executionContext: document.executionContext,
    sourceHash: document.sourceHash,
  };
}

/** Structural callers may carry byte/line metadata in addition to a locator. */
function sameSourceLocator(
  document: SourceDocumentLocator,
  candidate: SourceDocumentLocator,
): boolean {
  return (
    document.documentId === candidate.documentId &&
    document.path === candidate.path &&
    document.className === candidate.className &&
    document.executionContext === candidate.executionContext &&
    document.sourceHash === candidate.sourceHash
  );
}
function cloneDependency(value: StudioSourceDependency): StudioSourceDependency {
  return {
    ...value,
    source: { ...value.source },
    location: { ...value.location },
    ...(value.target ? { target: { ...value.target } } : {}),
  };
}
function cloneConsultedSource(value: CreatorSourceConsultedSource): CreatorSourceConsultedSource {
  return {
    document: { ...value.document },
    ranges: value.ranges.map((range) => ({ ...range })),
  };
}
function rangeOf(value: SourceLocation): {
  startByte: number;
  endByte: number;
} {
  return { startByte: value.startByte, endByte: value.endByte };
}
function canonicalSources(
  values: readonly CreatorSourceConsultedSource[],
): CreatorSourceConsultedSource[] {
  const merged = new Map<
    string,
    {
      document: SourceDocumentLocator;
      ranges: Map<string, { startByte: number; endByte: number }>;
    }
  >();
  for (const value of values) {
    const existing = merged.get(value.document.documentId) ?? {
      document: value.document,
      ranges: new Map(),
    };
    for (const range of value.ranges)
      existing.ranges.set(`${range.startByte}:${range.endByte}`, {
        startByte: range.startByte,
        endByte: range.endByte,
      });
    merged.set(value.document.documentId, existing);
  }
  return [...merged.values()]
    .map(({ document, ranges }) => ({
      document,
      ranges: [...ranges.values()].sort(compareRanges),
    }))
    .sort(compareConsultedSources);
}
function groupDocumentsByDisplayPath(
  documents: readonly SourceDocumentForIndexing[],
): ReadonlyMap<string, readonly SourceDocumentForIndexing[]> {
  const grouped = new Map<string, SourceDocumentForIndexing[]>();
  for (const document of documents) {
    const values = grouped.get(document.path) ?? [];
    values.push(document);
    grouped.set(document.path, values);
  }
  return grouped;
}
function requiredDocument(index: StudioSourceIndex, documentId: string): StudioSourceDocument {
  const document = index.documents.find((entry) => entry.documentId === documentId);
  if (!document) fail(`Source document is absent: ${documentId}`);
  return document;
}
function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}
function joinPath(parent: string, child: string): string {
  return parent.length === 0 ? child : `${parent}/${child}`;
}
function withinPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}
function sameLocator(left: SourceDocumentLocator, right: SourceDocumentLocator): boolean {
  return (
    left.path === right.path &&
    left.documentId === right.documentId &&
    left.sourceHash === right.sourceHash &&
    left.className === right.className &&
    left.executionContext === right.executionContext
  );
}
function compareDocuments(left: StudioSourceDocument, right: StudioSourceDocument): number {
  return compareText(left.path, right.path) || compareText(left.documentId, right.documentId);
}
function compareLocators(left: SourceDocumentLocator, right: SourceDocumentLocator): number {
  return compareText(left.path, right.path) || compareText(left.documentId, right.documentId);
}
function compareRanges(
  left: { readonly startByte: number; readonly endByte: number },
  right: { readonly startByte: number; readonly endByte: number },
): number {
  return left.startByte - right.startByte || left.endByte - right.endByte;
}
function compareConsultedSources(
  left: CreatorSourceConsultedSource,
  right: CreatorSourceConsultedSource,
): number {
  return compareLocators(left.document, right.document);
}
function compareSymbols(left: StudioSourceSymbol, right: StudioSourceSymbol): number {
  return (
    compareLocators(left.document, right.document) ||
    left.location.startByte - right.location.startByte ||
    compareText(left.name, right.name) ||
    compareText(left.kind, right.kind)
  );
}
function compareDependencies(left: StudioSourceDependency, right: StudioSourceDependency): number {
  return (
    compareLocators(left.source, right.source) ||
    left.location.startByte - right.location.startByte ||
    compareText(left.id, right.id)
  );
}
function compareReferences(left: SourceReference, right: SourceReference): number {
  return (
    compareLocators(left.document, right.document) ||
    left.location.startByte - right.location.startByte ||
    compareText(left.name, right.name)
  );
}
function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function isSorted<T>(values: readonly T[], compare: (left: T, right: T) => number): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0);
}
function dedupeSymbols(values: readonly StudioSourceSymbol[]): StudioSourceSymbol[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.document.documentId}:${value.location.startByte}:${value.name}:${value.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonicalPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === ".." || !validUtf8(part))
  )
    fail("Invalid canonical source path");
  return value;
}
function boundedId(value: unknown, label: string): string {
  if (!isId(value) || !validUtf8(value) || Buffer.byteLength(value, "utf8") > 256)
    fail(`Invalid ${label}`);
  return value;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    fail(`Invalid ${label}`);
  return value;
}
function boundedText(value: unknown, maximumBytes: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !validUtf8(value) ||
    utf8Bytes(value) > maximumBytes
  )
    fail(`Invalid ${label}`);
  return value;
}
function boundedLimit(value: number | undefined, maximum: number, label: string): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    fail(`Invalid ${label} bound`);
  return result;
}
function validUtf8(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function assertHash(value: unknown, label: string): asserts value is string {
  if (!isHash(value)) fail(`Invalid ${label} hash`);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/u.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(message: string): never {
  throw new Error(message);
}

export * from "./toolchain.js";
