import {
  STUDIO_CAPABILITY_COVERAGE_REPORT,
  STUDIO_CAPABILITY_COVERAGE_REPORT_HASH,
} from "./generated.js";
import {
  ROBLOX_API_CATALOG,
  ROBLOX_API_CATALOG_HASH,
  getRobloxApiClass,
  resolveRobloxClassMembers,
} from "./catalog-runtime.js";
import type {
  RobloxApiParameter,
  RobloxApiReturn,
  RobloxApiSecurity,
  RobloxApiSerialization,
  StudioCapabilityCoverageEntry,
  StudioCapabilityCoverageReport,
} from "./catalog.js";

const DEFAULT_LOOKUP_LIMIT = 12;
const MAX_LOOKUP_LIMIT = 20;
const MAX_LOOKUP_QUERY_LENGTH = 160;
const MAX_CLASS_NAME_LENGTH = 128;

export interface RobloxApiCatalogLookupRequest {
  readonly className?: string;
  readonly query?: string;
  readonly limit?: number;
}

export interface RobloxApiCatalogLookupEntry
  extends StudioCapabilityCoverageEntry {
  readonly deprecated: boolean;
  readonly tags: readonly string[];
  readonly sourceFile: string;
  readonly sourceFileHash: string;
  readonly superclass?: string;
  readonly valueType?: string;
  readonly parameters?: readonly RobloxApiParameter[];
  readonly returns?: readonly RobloxApiReturn[];
  readonly operandTypes?: readonly string[];
  readonly security?: RobloxApiSecurity;
  readonly serialization?: RobloxApiSerialization;
  readonly threadSafety?: string;
  readonly capabilities?: readonly string[];
  readonly enumValue?: number;
}

export interface RobloxApiCatalogLookupResult {
  readonly kind: "RobloxApiCatalogLookupResult";
  readonly catalogHash: string;
  readonly coverageHash: string;
  readonly source: {
    readonly repository: string;
    readonly commit: string;
    readonly engineReferencePath: string;
  };
  readonly selection: {
    readonly className?: string;
    readonly query?: string;
  };
  readonly total: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly entries: readonly RobloxApiCatalogLookupEntry[];
}

type CatalogMetadata = Omit<
  RobloxApiCatalogLookupEntry,
  keyof StudioCapabilityCoverageEntry
>;

const coverage =
  STUDIO_CAPABILITY_COVERAGE_REPORT as StudioCapabilityCoverageReport;
const coverageById = new Map(
  coverage.entries.map((entry) => [entry.catalogEntryId, entry]),
);
const metadataById = buildCatalogMetadata();

/** Returns one fully joined catalog/coverage row by its stable catalog ID. */
export function getRobloxApiCatalogLookupEntry(
  catalogEntryId: string,
): RobloxApiCatalogLookupEntry | undefined {
  const coverageEntry = coverageById.get(catalogEntryId);
  const metadata = metadataById.get(catalogEntryId);
  return coverageEntry && metadata
    ? { ...coverageEntry, ...metadata }
    : undefined;
}

/**
 * Searches the pinned official Engine API without network access. Results
 * carry both Roblox's source metadata and Forge's capability disposition.
 * Catalog presence is documentation context; only `authorable` entries grant
 * typed Studio mutation authority.
 */
export function lookupRobloxApiCatalog(
  request: RobloxApiCatalogLookupRequest,
): RobloxApiCatalogLookupResult {
  const className = request.className?.trim();
  const query = request.query?.trim();
  const limit = request.limit ?? DEFAULT_LOOKUP_LIMIT;
  assertLookupRequest({ className, query, limit });

  const classEntryIds = className ? effectiveClassEntryIds(className) : undefined;
  const normalizedQuery = query?.toLowerCase();
  const entries = coverage.entries
    .filter((entry) => classEntryIds === undefined || classEntryIds.has(entry.catalogEntryId))
    .map((entry) => ({ ...entry, ...requiredMetadata(entry.catalogEntryId) }))
    .filter((entry) => matchesLookupQuery(entry, normalizedQuery))
    .sort((left, right) => {
      const score = lookupScore(left, normalizedQuery) - lookupScore(right, normalizedQuery);
      return score || left.catalogEntryId.localeCompare(right.catalogEntryId);
    });

  return {
    kind: "RobloxApiCatalogLookupResult",
    catalogHash: ROBLOX_API_CATALOG_HASH,
    coverageHash: STUDIO_CAPABILITY_COVERAGE_REPORT_HASH,
    source: {
      repository: ROBLOX_API_CATALOG.source.repository,
      commit: ROBLOX_API_CATALOG.source.commit,
      engineReferencePath: ROBLOX_API_CATALOG.source.engineReferencePath,
    },
    selection: {
      ...(className ? { className } : {}),
      ...(query ? { query } : {}),
    },
    total: entries.length,
    limit,
    truncated: entries.length > limit,
    entries: entries.slice(0, limit),
  };
}

function effectiveClassEntryIds(className: string): ReadonlySet<string> {
  const classDefinition = getRobloxApiClass(className);
  if (!classDefinition)
    throw new Error(
      `Roblox API class is not present in the pinned catalog: ${className}`,
    );
  return new Set([
    classDefinition.id,
    ...resolveRobloxClassMembers(className).map((entry) => entry.id),
  ]);
}

function matchesLookupQuery(
  entry: RobloxApiCatalogLookupEntry,
  query: string | undefined,
): boolean {
  if (!query) return true;
  return lookupText(entry).some((candidate) =>
    candidate.toLowerCase().includes(query),
  );
}

function lookupScore(
  entry: RobloxApiCatalogLookupEntry,
  query: string | undefined,
): number {
  if (!query) return 3;
  const qualifiedName = entry.owner
    ? `${entry.owner}.${entry.name}`.toLowerCase()
    : entry.name.toLowerCase();
  const name = entry.name.toLowerCase();
  if (name === query || qualifiedName === query) return 0;
  if (name.startsWith(query) || qualifiedName.startsWith(query)) return 1;
  return 2;
}

function lookupText(entry: RobloxApiCatalogLookupEntry): string[] {
  return [
    entry.catalogEntryId,
    entry.entryKind,
    entry.owner ?? "",
    entry.owner ? `${entry.owner}.${entry.name}` : entry.name,
    entry.name,
    entry.disposition,
    entry.reason,
    entry.superclass ?? "",
    entry.valueType ?? "",
    entry.threadSafety ?? "",
    entry.sourceFile,
    ...(entry.tags ?? []),
    ...(entry.capabilities ?? []),
    ...(entry.operandTypes ?? []),
    ...(entry.parameters ?? []).flatMap((parameter) => [
      parameter.name,
      parameter.type,
    ]),
    ...(entry.returns ?? []).map((result) => result.type),
  ];
}

function requiredMetadata(id: string): CatalogMetadata {
  const metadata = metadataById.get(id);
  if (!metadata)
    throw new Error(`Pinned Roblox API catalog metadata is missing for ${id}`);
  return metadata;
}

function buildCatalogMetadata(): ReadonlyMap<string, CatalogMetadata> {
  const entries = new Map<string, CatalogMetadata>();
  for (const classDefinition of ROBLOX_API_CATALOG.classes) {
    entries.set(classDefinition.id, {
      deprecated: classDefinition.deprecated,
      tags: classDefinition.tags,
      sourceFile: classDefinition.sourceFile,
      sourceFileHash: classDefinition.sourceFileHash,
      ...(classDefinition.superclass
        ? { superclass: classDefinition.superclass }
        : {}),
    });
    for (const member of classDefinition.members) {
      entries.set(member.id, {
        deprecated: member.deprecated,
        tags: member.tags,
        sourceFile: member.sourceFile,
        sourceFileHash: member.sourceFileHash,
        ...(member.valueType ? { valueType: member.valueType } : {}),
        ...(member.parameters ? { parameters: member.parameters } : {}),
        ...(member.returns ? { returns: member.returns } : {}),
        ...(member.security ? { security: member.security } : {}),
        ...(member.serialization ? { serialization: member.serialization } : {}),
        ...(member.threadSafety ? { threadSafety: member.threadSafety } : {}),
        ...(member.capabilities.length > 0
          ? { capabilities: member.capabilities }
          : {}),
      });
    }
  }
  for (const datatype of ROBLOX_API_CATALOG.datatypes) {
    entries.set(datatype.id, {
      deprecated: datatype.deprecated,
      tags: datatype.tags,
      sourceFile: datatype.sourceFile,
      sourceFileHash: datatype.sourceFileHash,
    });
    for (const member of datatype.members) {
      entries.set(member.id, {
        deprecated: member.deprecated,
        tags: member.tags,
        sourceFile: member.sourceFile,
        sourceFileHash: member.sourceFileHash,
        ...(member.valueType ? { valueType: member.valueType } : {}),
        ...(member.parameters ? { parameters: member.parameters } : {}),
        ...(member.returns ? { returns: member.returns } : {}),
        ...(member.operandTypes ? { operandTypes: member.operandTypes } : {}),
      });
    }
  }
  for (const enumeration of ROBLOX_API_CATALOG.enums) {
    entries.set(enumeration.id, {
      deprecated: enumeration.deprecated,
      tags: enumeration.tags,
      sourceFile: enumeration.sourceFile,
      sourceFileHash: enumeration.sourceFileHash,
    });
    for (const item of enumeration.items) {
      entries.set(item.id, {
        deprecated: item.deprecated,
        tags: item.tags,
        sourceFile: enumeration.sourceFile,
        sourceFileHash: enumeration.sourceFileHash,
        enumValue: item.value,
      });
    }
  }
  for (const member of ROBLOX_API_CATALOG.globalMembers) {
    entries.set(member.id, {
      deprecated: member.deprecated,
      tags: member.tags,
      sourceFile: member.sourceFile,
      sourceFileHash: member.sourceFileHash,
      ...(member.valueType ? { valueType: member.valueType } : {}),
      ...(member.parameters ? { parameters: member.parameters } : {}),
      ...(member.returns ? { returns: member.returns } : {}),
    });
  }
  for (const library of ROBLOX_API_CATALOG.libraries) {
    entries.set(library.id, {
      deprecated: library.deprecated,
      tags: library.tags,
      sourceFile: library.sourceFile,
      sourceFileHash: library.sourceFileHash,
    });
    for (const member of library.members) {
      entries.set(member.id, {
        deprecated: member.deprecated,
        tags: member.tags,
        sourceFile: member.sourceFile,
        sourceFileHash: member.sourceFileHash,
        ...(member.valueType ? { valueType: member.valueType } : {}),
        ...(member.parameters ? { parameters: member.parameters } : {}),
        ...(member.returns ? { returns: member.returns } : {}),
      });
    }
  }
  return entries;
}

function assertLookupRequest(input: {
  className: string | undefined;
  query: string | undefined;
  limit: number;
}): void {
  if (!input.className && !input.query)
    throw new Error("Roblox API lookup requires className or query");
  if (
    input.className !== undefined &&
    (input.className.length > MAX_CLASS_NAME_LENGTH ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(input.className))
  )
    throw new Error("Roblox API lookup class name is invalid");
  if (
    input.query !== undefined &&
    (input.query.length > MAX_LOOKUP_QUERY_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(input.query))
  )
    throw new Error("Roblox API lookup query is invalid");
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_LOOKUP_LIMIT
  )
    throw new Error("Roblox API lookup limit is invalid");
}
