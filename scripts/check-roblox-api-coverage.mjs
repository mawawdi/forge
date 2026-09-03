#!/usr/bin/env node
/**
 * Independently verify the generated API-accountability report against the
 * pinned catalog. This stays separate from the Studio mutation manifest: it
 * proves every documented row is accounted for without treating an entry as a
 * write grant.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = resolve(root, "packages/studio-evidence/catalog/roblox-api-catalog.json");
const coveragePath = resolve(
  root,
  "packages/studio-evidence/catalog/studio-capability-coverage-report.json",
);
const dispositions = new Set([
  "authorable",
  "observable_only",
  "source_only",
  "creator_reviewed",
  "unsupported",
]);
const reasons = new Set([
  "proof_closed",
  "catalog_only",
  "class_not_enabled",
  "class_not_creatable",
  "service_root",
  "deprecated",
  "hidden",
  "read_only",
  "security_gated",
  "not_serialized",
  "unsupported_codec",
  "reference_policy_missing",
  "content_policy_missing",
  "parent_policy_missing",
  "structure_managed",
  "detached_preflight_required",
  "runtime_observation_supported",
  "runtime_observation_missing",
  "script_api",
  "engine_or_external_authority",
  "nondeterministic_behavior",
  "creator_judgment",
]);

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const report = JSON.parse(await readFile(coveragePath, "utf8"));
assertCatalogShape(catalog);
assertReport(catalog, report);

function assertCatalogShape(value) {
  if (value?.kind !== "RobloxApiCatalog" || typeof value.contentHash !== "string")
    fail("catalog is not a generated RobloxApiCatalog");
}

function assertReport(catalog, report) {
  exactKeys(
    report,
    ["catalogHash", "contentHash", "entries", "kind", "manifestHash", "policyHash", "summary"],
    "coverage report",
  );
  if (report.kind !== "StudioCapabilityCoverageReport") fail("coverage report kind");
  if (report.catalogHash !== catalog.contentHash) fail("coverage catalog hash");
  if (!isHash(report.policyHash) || !isHash(report.manifestHash) || !isHash(report.contentHash))
    fail("coverage identity hash");
  if (!Array.isArray(report.entries)) fail("coverage entries");

  const metadataById = catalogMetadataById(catalog);
  const classesByName = new Map(catalog.classes.map((entry) => [entry.name, entry]));
  const seen = new Set();
  let priorId;
  for (const entry of report.entries) {
    assertCoverageEntry(entry, metadataById, classesByName);
    if (seen.has(entry.catalogEntryId)) fail(`duplicate coverage entry ${entry.catalogEntryId}`);
    if (priorId !== undefined && priorId.localeCompare(entry.catalogEntryId) >= 0)
      fail("coverage entries are not strictly sorted");
    seen.add(entry.catalogEntryId);
    priorId = entry.catalogEntryId;
  }
  if (seen.size !== metadataById.size) fail("coverage entry count does not match catalog");
  for (const id of metadataById.keys())
    if (!seen.has(id)) fail(`catalog entry is unclassified: ${id}`);

  assertSummary(report.summary, report.entries);
  const material = { ...report };
  delete material.contentHash;
  if (sha256(stableJson(material)) !== report.contentHash) fail("coverage content hash");
}

function assertCoverageEntry(entry, metadataById, classesByName) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("coverage entry shape");
  const metadata = metadataById.get(entry.catalogEntryId);
  if (!metadata) fail(`coverage entry does not identify catalog metadata: ${entry.catalogEntryId}`);
  const optional = [
    entry.owner === undefined ? [] : ["owner"],
    entry.authoringGroup === undefined ? [] : ["authoringGroup"],
    entry.codec === undefined ? [] : ["codec"],
    entry.inheritedBy === undefined ? [] : ["inheritedBy"],
  ].flat();
  exactKeys(
    entry,
    ["catalogEntryId", "disposition", "entryKind", "name", "reason", ...optional],
    `coverage entry ${metadata.id}`,
  );
  if (
    entry.catalogEntryId !== metadata.id ||
    entry.entryKind !== metadata.entryKind ||
    entry.name !== metadata.name ||
    entry.owner !== metadata.owner
  )
    fail(`coverage metadata mismatch: ${metadata.id}`);
  if (!dispositions.has(entry.disposition) || !reasons.has(entry.reason))
    fail(`coverage disposition or reason: ${metadata.id}`);
  if (entry.authoringGroup !== undefined && !isNonEmptyString(entry.authoringGroup))
    fail(`coverage authoring group: ${metadata.id}`);

  const platformRestriction = sourceRestriction(metadata);
  if (platformRestriction !== undefined) {
    if (entry.disposition !== "unsupported" || entry.reason !== platformRestriction)
      fail(`platform-restricted coverage row: ${metadata.id}`);
  } else if (entry.disposition === "unsupported") {
    fail(`public catalog row is unsupported: ${metadata.id}`);
  }

  if (entry.disposition === "authorable") {
    if (entry.reason !== "proof_closed") fail(`authorable reason: ${metadata.id}`);
    if (metadata.entryKind === "class") {
      if (entry.codec !== undefined || entry.inheritedBy !== undefined)
        fail(`authorable class: ${metadata.id}`);
      return;
    }
    if (metadata.entryKind === "class_property") {
      if (!isNonEmptyString(entry.codec)) fail(`authorable property codec: ${metadata.id}`);
      assertInheritedApplicability(entry, metadata, classesByName);
      return;
    }
    if (metadata.entryKind === "enum" || metadata.entryKind === "enum_item") {
      if (entry.codec !== "enum_name" || entry.inheritedBy !== undefined)
        fail(`authorable enum: ${metadata.id}`);
      return;
    }
    fail(`unexpected authorable kind: ${metadata.id}`);
  }

  if (entry.disposition === "observable_only") {
    if (entry.reason !== "catalog_only" || entry.inheritedBy !== undefined)
      fail(`observable-only reason: ${metadata.id}`);
    if (metadata.entryKind === "datatype") {
      if (!isNonEmptyString(entry.codec)) fail(`observable datatype codec: ${metadata.id}`);
    } else if (entry.codec !== undefined) {
      fail(`observable non-datatype codec: ${metadata.id}`);
    }
    return;
  }
  if (entry.codec !== undefined || entry.inheritedBy !== undefined)
    fail(`non-authorable row carries mutation metadata: ${metadata.id}`);
  if (entry.disposition === "creator_reviewed" && entry.reason !== "creator_judgment")
    fail(`creator-reviewed reason: ${metadata.id}`);
  assertReasonApplies(entry, metadata);
}

function assertInheritedApplicability(entry, metadata, classesByName) {
  if (!Array.isArray(entry.inheritedBy) || entry.inheritedBy.length === 0)
    fail(`authorable property has no applicability: ${metadata.id}`);
  let prior;
  const seen = new Set();
  for (const className of entry.inheritedBy) {
    if (!isNonEmptyString(className) || seen.has(className))
      fail(`authorable property applicability: ${metadata.id}`);
    if (prior !== undefined && prior.localeCompare(className) >= 0)
      fail(`authorable property applicability ordering: ${metadata.id}`);
    if (!resolvesMember(classesByName, className, metadata.id))
      fail(`authorable property is not inherited by ${className}: ${metadata.id}`);
    seen.add(className);
    prior = className;
  }
}

function assertReasonApplies(entry, metadata) {
  if (entry.reason === "read_only") {
    if (metadata.entryKind !== "class_property" || !metadata.tags.includes("ReadOnly"))
      fail(`read-only reason is not documented: ${metadata.id}`);
  }
  if (entry.reason === "not_serialized") {
    if (metadata.entryKind !== "class_property" || metadata.serialization?.canLoad !== false)
      fail(`not-serialized reason is not documented: ${metadata.id}`);
  }
  if (["structure_managed", "parent_policy_missing"].includes(entry.reason)) {
    if (metadata.entryKind !== "class_property")
      fail(`property policy reason applied to non-property: ${metadata.id}`);
  }
  if (entry.reason === "class_not_creatable" && !metadata.tags.includes("NotCreatable"))
    fail(`not-creatable reason is not documented: ${metadata.id}`);
  if (entry.reason === "service_root" && !metadata.tags.includes("Service"))
    fail(`service-root reason is not documented: ${metadata.id}`);
}

function assertSummary(summary, entries) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) fail("coverage summary");
  exactKeys(
    summary,
    ["authorableClasses", "authorableProperties", "byDisposition", "byReason", "total"],
    "coverage summary",
  );
  if (summary.total !== entries.length) fail("coverage summary total");
  const byDisposition = Object.fromEntries([...dispositions].map((name) => [name, 0]));
  const byReason = {};
  let authorableClasses = 0;
  let authorableProperties = 0;
  for (const entry of entries) {
    byDisposition[entry.disposition] += 1;
    byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
    if (entry.disposition === "authorable" && entry.entryKind === "class") authorableClasses += 1;
    if (entry.disposition === "authorable" && entry.entryKind === "class_property")
      authorableProperties += entry.inheritedBy.length;
  }
  if (stableJson(summary.byDisposition) !== stableJson(byDisposition))
    fail("coverage summary dispositions");
  if (stableJson(summary.byReason) !== stableJson(byReason)) fail("coverage summary reasons");
  if (
    summary.authorableClasses !== authorableClasses ||
    summary.authorableProperties !== authorableProperties
  )
    fail("coverage summary authorable totals");
}

function catalogMetadataById(catalog) {
  const entries = new Map();
  const add = (entry) => {
    if (entries.has(entry.id)) fail(`repeated catalog ID: ${entry.id}`);
    entries.set(entry.id, entry);
  };
  for (const classDefinition of catalog.classes) {
    add({
      id: classDefinition.id,
      entryKind: "class",
      name: classDefinition.name,
      tags: classDefinition.tags,
      deprecated: classDefinition.deprecated,
    });
    for (const member of classDefinition.members)
      add({
        ...member,
        entryKind: `class_${member.kind}`,
        owner: member.declaringClass,
      });
  }
  for (const datatype of catalog.datatypes) {
    add({
      id: datatype.id,
      entryKind: "datatype",
      name: datatype.name,
      tags: datatype.tags,
      deprecated: datatype.deprecated,
    });
    for (const member of datatype.members)
      add({
        ...member,
        entryKind: `datatype_${member.kind}`,
        owner: member.declaringDatatype,
      });
  }
  for (const enumeration of catalog.enums) {
    add({
      id: enumeration.id,
      entryKind: "enum",
      name: enumeration.name,
      tags: enumeration.tags,
      deprecated: enumeration.deprecated,
    });
    for (const item of enumeration.items)
      add({
        ...item,
        entryKind: "enum_item",
        owner: enumeration.name,
      });
  }
  for (const member of catalog.globalMembers)
    add({
      ...member,
      entryKind: `global_${member.kind}`,
      owner: member.declaringScope,
    });
  for (const library of catalog.libraries) {
    add({
      id: library.id,
      entryKind: "library",
      name: library.name,
      tags: library.tags,
      deprecated: library.deprecated,
    });
    for (const member of library.members)
      add({
        ...member,
        entryKind: `library_${member.kind}`,
        owner: member.declaringLibrary,
      });
  }
  return entries;
}

function resolvesMember(classesByName, className, memberId) {
  const visited = new Set();
  for (
    let current = classesByName.get(className);
    current && !visited.has(current.name);
    current = current.superclass ? classesByName.get(current.superclass) : undefined
  ) {
    if (current.members.some((member) => member.id === memberId)) return true;
    visited.add(current.name);
  }
  return false;
}

function sourceRestriction(metadata) {
  if (metadata.deprecated) return "deprecated";
  if (metadata.tags.includes("Hidden") || metadata.tags.includes("NotScriptable")) return "hidden";
  if (Object.values(metadata.security ?? {}).some((value) => value !== "None"))
    return "security_gated";
  return undefined;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label);
  const actual = Object.keys(value).sort();
  const expectedSorted = [...expected].sort();
  if (
    actual.length !== expectedSorted.length ||
    actual.some((key, index) => key !== expectedSorted[index])
  )
    fail(`${label} has unexpected fields`);
}

function isHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortObject(value[key])]),
    );
  return value;
}

function fail(message) {
  throw new Error(`Invalid Roblox API coverage report: ${message}`);
}
