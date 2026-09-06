import { contentHash } from "../../contracts/src/index.js";
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

const DEFAULT_LOOKUP_LIMIT = 20;
const MAX_LOOKUP_LIMIT = 64;
const MAX_LOOKUP_QUERY_LENGTH = 160;
const MAX_OWNER_NAME_LENGTH = 128;
const LOOKUP_ORDER = "query-relevance-owner-distance";
export const ROBLOX_API_LOOKUP_MEMBER_KINDS = [
  "class",
  "datatype",
  "enum",
  "library",
  "property",
  "method",
  "event",
  "callback",
  "constructor",
  "function",
  "constant",
  "math_operation",
  "enum_item",
] as const;

export interface RobloxApiCatalogLookupRequest {
  readonly ownerName?: string;
  readonly memberKind?: (typeof ROBLOX_API_LOOKUP_MEMBER_KINDS)[number];
  readonly query?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RobloxApiCatalogLookupEntry extends StudioCapabilityCoverageEntry {
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
    readonly ownerName?: string;
    readonly memberKind?: (typeof ROBLOX_API_LOOKUP_MEMBER_KINDS)[number];
    readonly query?: string;
  };
  readonly total: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly nextCursor?: string;
  readonly entries: readonly RobloxApiCatalogLookupEntry[];
  readonly missContext?: RobloxApiLookupMissContext;
}

export interface RobloxApiLookupMissContext {
  readonly kind: "RobloxApiLookupMissContext";
  readonly reason: "unknown_owner" | "no_matches";
  readonly catalogHash: string;
  readonly coverageHash: string;
  readonly requested: RobloxApiCatalogLookupResult["selection"];
  readonly instruction: string;
  readonly suggestions: readonly {
    readonly relation:
      "same_owner_member" | "exact_api_owner" | "owner_name_alternative" | "member_of_other_owner";
    readonly entry: RobloxApiCatalogLookupEntry;
  }[];
  readonly truncated: boolean;
}

export class RobloxApiLookupError extends Error {
  constructor(
    message: string,
    readonly missContext: RobloxApiLookupMissContext,
  ) {
    super(message);
  }
}

type CatalogMetadata = Omit<RobloxApiCatalogLookupEntry, keyof StudioCapabilityCoverageEntry>;

const coverage = STUDIO_CAPABILITY_COVERAGE_REPORT as StudioCapabilityCoverageReport;
const coverageById = new Map(coverage.entries.map((entry) => [entry.catalogEntryId, entry]));
const metadataById = buildCatalogMetadata();

/** Returns one fully joined catalog/coverage row by its stable catalog ID. */
export function getRobloxApiCatalogLookupEntry(
  catalogEntryId: string,
): RobloxApiCatalogLookupEntry | undefined {
  const coverageEntry = coverageById.get(catalogEntryId);
  const metadata = metadataById.get(catalogEntryId);
  return coverageEntry && metadata ? { ...coverageEntry, ...metadata } : undefined;
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
  if (
    Object.keys(request).some(
      (key) => !["ownerName", "memberKind", "query", "limit", "cursor"].includes(key),
    )
  )
    throw new Error("Roblox API lookup contains an unknown field");
  const ownerName = request.ownerName?.trim();
  const query = request.query?.trim();
  const memberKind = request.memberKind;
  const limit = request.limit ?? DEFAULT_LOOKUP_LIMIT;
  assertLookupRequest({ ownerName, query, memberKind, limit });

  const ownerEntryDistances = ownerName ? effectiveOwnerEntryDistances(ownerName) : undefined;
  if (ownerName && ownerEntryDistances === undefined)
    throw new RobloxApiLookupError(
      `Unknown Roblox API owner: ${ownerName}. ownerName is an exact API class, datatype, enum or library name, not a project instance name. Omit ownerName and search query to discover API names.`,
      lookupMissContext(
        { ownerName, ...(query ? { query } : {}), ...(memberKind ? { memberKind } : {}) },
        "unknown_owner",
      ),
    );
  const normalizedQuery = query?.toLowerCase();
  const entries = coverage.entries
    .filter(
      (entry) => ownerEntryDistances === undefined || ownerEntryDistances.has(entry.catalogEntryId),
    )
    .filter(
      (entry) =>
        memberKind === undefined ||
        entry.entryKind.replace(/^(class|datatype|library|global)_/, "") === memberKind,
    )
    .map((entry) => ({ ...entry, ...requiredMetadata(entry.catalogEntryId) }))
    .filter((entry) => matchesLookupQuery(entry, normalizedQuery))
    .sort((left, right) => {
      const score = lookupScore(left, normalizedQuery) - lookupScore(right, normalizedQuery);
      return (
        score ||
        (ownerEntryDistances?.get(left.catalogEntryId) ?? 0) -
          (ownerEntryDistances?.get(right.catalogEntryId) ?? 0) ||
        Number(left.deprecated) - Number(right.deprecated) ||
        Number(!exactLookupCase(left, query)) - Number(!exactLookupCase(right, query)) ||
        compareText(left.catalogEntryId, right.catalogEntryId)
      );
    });
  const selection = {
    ...(ownerName ? { ownerName } : {}),
    ...(query ? { query } : {}),
    ...(memberKind ? { memberKind } : {}),
  };
  const cursorHash = contentHash(
    JSON.stringify({
      catalogHash: ROBLOX_API_CATALOG_HASH,
      coverageHash: STUDIO_CAPABILITY_COVERAGE_REPORT_HASH,
      order: LOOKUP_ORDER,
      selection,
      limit,
    }),
  );
  const offset = lookupOffset(request.cursor, cursorHash, entries.length, limit);
  const end = offset + limit;

  return {
    kind: "RobloxApiCatalogLookupResult",
    catalogHash: ROBLOX_API_CATALOG_HASH,
    coverageHash: STUDIO_CAPABILITY_COVERAGE_REPORT_HASH,
    source: {
      repository: ROBLOX_API_CATALOG.source.repository,
      commit: ROBLOX_API_CATALOG.source.commit,
      engineReferencePath: ROBLOX_API_CATALOG.source.engineReferencePath,
    },
    selection,
    total: entries.length,
    limit,
    truncated: entries.length > end,
    ...(entries.length > end ? { nextCursor: `${cursorHash}:${end}` } : {}),
    entries: entries.slice(offset, end),
    ...(entries.length === 0
      ? { missContext: lookupMissContext(selection, "no_matches", ownerEntryDistances) }
      : {}),
  };
}

function effectiveOwnerEntryDistances(ownerName: string): ReadonlyMap<string, number> | undefined {
  const distances = new Map<string, number>();
  const classDefinition = getRobloxApiClass(ownerName);
  if (classDefinition) {
    distances.set(classDefinition.id, 0);
    const classDistances = new Map<string, number>();
    let current = classDefinition;
    while (!classDistances.has(current.name)) {
      classDistances.set(current.name, classDistances.size);
      const parent = current.superclass && getRobloxApiClass(current.superclass);
      if (!parent) break;
      current = parent;
    }
    // Keep the effective surface's shadowing rules, but surface the requested
    // class and its nearest ancestors before common Instance members.
    for (const member of resolveRobloxClassMembers(ownerName))
      distances.set(member.id, classDistances.get(member.declaringClass)!);
  }
  for (const owner of [...ROBLOX_API_CATALOG.datatypes, ...ROBLOX_API_CATALOG.libraries]) {
    if (owner.name !== ownerName) continue;
    distances.set(owner.id, 0);
    for (const member of owner.members) distances.set(member.id, 0);
  }
  for (const owner of ROBLOX_API_CATALOG.enums) {
    if (owner.name !== ownerName) continue;
    distances.set(owner.id, 0);
    for (const item of owner.items) distances.set(item.id, 0);
  }
  return distances.size === 0 ? undefined : distances;
}

/** Bounded navigation hints remain separate from the exact requested match set. */
function lookupMissContext(
  requested: RobloxApiCatalogLookupResult["selection"],
  reason: RobloxApiLookupMissContext["reason"],
  ownerDistances?: ReadonlyMap<string, number>,
): RobloxApiLookupMissContext {
  const ownerKinds = new Set(["class", "datatype", "enum", "library"]);
  const candidates: Array<{
    score: number;
    relation: RobloxApiLookupMissContext["suggestions"][number]["relation"];
    row: StudioCapabilityCoverageEntry;
  }> = [];
  const query = requested.query?.toLowerCase();
  for (const row of coverage.entries) {
    const isOwner = ownerKinds.has(row.entryKind);
    if (query && isOwner && row.name.toLowerCase() === query)
      candidates.push({ score: 0, relation: "exact_api_owner", row });
    if (query && !isOwner && ownerDistances?.has(row.catalogEntryId)) {
      const rank = nearbyApiName(row.name, requested.query!);
      if (rank !== undefined)
        candidates.push({ score: 10 + rank, relation: "same_owner_member", row });
    }
    if (reason === "unknown_owner") {
      // This establishes where an exact member is declared, never the class of a project variable.
      if (query && !isOwner && row.name.toLowerCase() === query)
        candidates.push({ score: 5, relation: "member_of_other_owner", row });
      if (isOwner && requested.ownerName) {
        const rank = nearbyApiName(row.name, requested.ownerName);
        if (rank !== undefined)
          candidates.push({ score: 20 + rank, relation: "owner_name_alternative", row });
      }
    }
  }
  candidates.sort(
    (a, b) =>
      a.score - b.score ||
      (ownerDistances?.get(a.row.catalogEntryId) ?? 0) -
        (ownerDistances?.get(b.row.catalogEntryId) ?? 0) ||
      Number(requiredMetadata(a.row.catalogEntryId).deprecated) -
        Number(requiredMetadata(b.row.catalogEntryId).deprecated) ||
      compareText(a.row.catalogEntryId, b.row.catalogEntryId),
  );
  const suggestions: RobloxApiLookupMissContext["suggestions"][number][] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let truncated = false;
  for (const candidate of candidates) {
    if (seen.has(candidate.row.catalogEntryId)) continue;
    seen.add(candidate.row.catalogEntryId);
    const suggestion = {
      relation: candidate.relation,
      entry: { ...candidate.row, ...requiredMetadata(candidate.row.catalogEntryId) },
    };
    const nextBytes = Buffer.byteLength(JSON.stringify(suggestion), "utf8");
    if (suggestions.length >= 6 || bytes + nextBytes > 16_384) {
      truncated = true;
      continue;
    }
    suggestions.push(suggestion);
    bytes += nextBytes;
  }
  return {
    kind: "RobloxApiLookupMissContext",
    reason,
    catalogHash: ROBLOX_API_CATALOG_HASH,
    coverageHash: STUDIO_CAPABILITY_COVERAGE_REPORT_HASH,
    requested: { ...requested },
    instruction:
      "These are separate pinned catalog declarations, not corrected matches, aliases, project instance types, or new mutation authority. Named children and source variables are not necessarily class members. Preserve each suggestion's exact declaring owner and security/disposition; reuse its supplied facts instead of repeating the same lookup.",
    suggestions,
    truncated,
  };
}

/** Lexical navigation only. No alias resolution or mutation admission uses this score. */
function nearbyApiName(candidate: string, requested: string): number | undefined {
  const left = candidate.toLowerCase();
  const right = requested.toLowerCase();
  if (left === right) return 0;
  if (
    Math.min(left.length, right.length) >= 4 &&
    (left.startsWith(right) ||
      right.startsWith(left) ||
      left.endsWith(right) ||
      right.endsWith(left))
  )
    return 1;
  const words = (name: string) =>
    new Set(
      (name.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g) ?? []).map((word) => word.toLowerCase()),
    );
  const a = words(candidate),
    b = words(requested);
  const shared = [...a].filter((word) => b.has(word)).length;
  if (shared >= 2 && shared / Math.max(a.size, b.size) >= 0.5) return 2;
  const maximum = Math.min(3, Math.floor(Math.max(left.length, right.length) / 3));
  if (maximum === 0 || Math.abs(left.length - right.length) > maximum) return undefined;
  let prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const next = [row];
    let minimum = row;
    for (let column = 1; column <= right.length; column++) {
      const distance = Math.min(
        next[column - 1]! + 1,
        prior[column]! + 1,
        prior[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      next.push(distance);
      minimum = Math.min(minimum, distance);
    }
    if (minimum > maximum) return undefined;
    prior = next;
  }
  const distance = prior[right.length]!;
  return distance <= maximum ? 3 + distance : undefined;
}

function lookupOffset(
  cursor: string | undefined,
  hash: string,
  total: number,
  limit: number,
): number {
  if (cursor === undefined) return 0;
  const match = typeof cursor === "string" && /^([a-f0-9]{64}):([1-9][0-9]{0,8})$/.exec(cursor);
  const offset = match ? Number(match[2]) : -1;
  if (!match || match[1] !== hash || offset >= total || offset % limit !== 0)
    throw new Error(
      "Invalid Roblox API lookup cursor; copy nextCursor with unchanged lookup filters and limit",
    );
  return offset;
}

function exactLookupCase(entry: RobloxApiCatalogLookupEntry, query: string | undefined): boolean {
  return query !== undefined && (entry.name === query || `${entry.owner}.${entry.name}` === query);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function matchesLookupQuery(
  entry: RobloxApiCatalogLookupEntry,
  query: string | undefined,
): boolean {
  if (!query) return true;
  return lookupText(entry).some((candidate) => candidate.toLowerCase().includes(query));
}

function lookupScore(entry: RobloxApiCatalogLookupEntry, query: string | undefined): number {
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
    ...(entry.parameters ?? []).flatMap((parameter) => [parameter.name, parameter.type]),
    ...(entry.returns ?? []).map((result) => result.type),
  ];
}

function requiredMetadata(id: string): CatalogMetadata {
  const metadata = metadataById.get(id);
  if (!metadata) throw new Error(`Pinned Roblox API catalog metadata is missing for ${id}`);
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
      ...(classDefinition.superclass ? { superclass: classDefinition.superclass } : {}),
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
        ...(member.capabilities.length > 0 ? { capabilities: member.capabilities } : {}),
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
  ownerName: string | undefined;
  query: string | undefined;
  memberKind: (typeof ROBLOX_API_LOOKUP_MEMBER_KINDS)[number] | undefined;
  limit: number;
}): void {
  if (!input.ownerName && !input.query)
    throw new Error("Roblox API lookup requires ownerName or query");
  if (
    input.ownerName !== undefined &&
    (input.ownerName.length > MAX_OWNER_NAME_LENGTH ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(input.ownerName))
  )
    throw new Error("Roblox API lookup owner name is invalid");
  if (input.memberKind !== undefined && !ROBLOX_API_LOOKUP_MEMBER_KINDS.includes(input.memberKind))
    throw new Error("Roblox API lookup member kind is invalid");
  if (
    input.query !== undefined &&
    (input.query.length > MAX_LOOKUP_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(input.query))
  )
    throw new Error("Roblox API lookup query is invalid");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_LOOKUP_LIMIT)
    throw new Error("Roblox API lookup limit is invalid");
}
