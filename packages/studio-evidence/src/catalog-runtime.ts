import { contentHash } from "../../contracts/src/index.js";
import { ROBLOX_API_CATALOG, ROBLOX_API_CATALOG_HASH } from "./roblox-api-catalog.generated.js";
import type {
  RobloxApiCatalog,
  RobloxApiCatalogCounts,
  RobloxApiClass,
  RobloxApiDatatype,
  RobloxApiEnum,
  RobloxApiGlobalMember,
  RobloxApiLibrary,
  RobloxClassMember,
  RobloxClassMemberKind,
  RobloxDatatypeMemberKind,
} from "./catalog.js";

export { ROBLOX_API_CATALOG, ROBLOX_API_CATALOG_HASH };

const COUNT_KEYS = [
  "classes", "datatypes", "enums", "classProperties", "classMethods", "classEvents", "classCallbacks",
  "datatypeConstants", "datatypeConstructors", "datatypeFunctions", "datatypeMathOperations", "datatypeMethods",
  "datatypeProperties", "enumItems",
  "globalProperties", "globalFunctions", "libraries", "libraryProperties", "libraryFunctions",
] as const satisfies readonly (keyof RobloxApiCatalogCounts)[];
const CLASS_MEMBER_KINDS = ["property", "method", "event", "callback"] as const;
const DATATYPE_MEMBER_KINDS = ["constant", "constructor", "function", "math_operation", "method", "property"] as const;
const SOURCE_DIRECTORIES = ["classes", "datatypes", "enums", "globals", "libraries"] as const;

const classesByName = new Map(ROBLOX_API_CATALOG.classes.map((entry) => [entry.name, entry]));
const datatypesByName = new Map(ROBLOX_API_CATALOG.datatypes.map((entry) => [entry.name, entry]));
const enumsByName = new Map(ROBLOX_API_CATALOG.enums.map((entry) => [entry.name, entry]));
const librariesByName = new Map(ROBLOX_API_CATALOG.libraries.map((entry) => [entry.name, entry]));

/** Returns a class from the pinned catalog; it never consults the network. */
export function getRobloxApiClass(name: string): RobloxApiClass | undefined { return classesByName.get(name); }
/** Returns a datatype from the pinned catalog; it never consults the network. */
export function getRobloxApiDatatype(name: string): RobloxApiDatatype | undefined { return datatypesByName.get(name); }
/** Returns an enum from the pinned catalog; it never consults the network. */
export function getRobloxApiEnum(name: string): RobloxApiEnum | undefined { return enumsByName.get(name); }
/** Returns a standard Luau/Roblox library from the pinned catalog. */
export function getRobloxApiLibrary(name: string): RobloxApiLibrary | undefined { return librariesByName.get(name); }
/** Returns every same-named documented global occurrence across official global scopes. */
export function getRobloxApiGlobalMembers(name: string): readonly RobloxApiGlobalMember[] { return ROBLOX_API_CATALOG.globalMembers.filter((entry) => entry.name === name); }

/**
 * True precisely when `className` is the same class as `expectedClass` or a
 * documented descendant. Unknown or cyclic input is rejected as false.
 */
export function isRobloxClassAssignableTo(className: string, expectedClass: string): boolean {
  const visited = new Set<string>();
  let current = getRobloxApiClass(className);
  while (current !== undefined && !visited.has(current.name)) {
    if (current.name === expectedClass) return true;
    visited.add(current.name);
    current = current.superclass === undefined ? undefined : getRobloxApiClass(current.superclass);
  }
  return false;
}

/**
 * Resolves a documented member using normal class inheritance. The returned
 * member stays attached to its declaring class, preserving source provenance.
 */
export function resolveRobloxClassMember(className: string, kind: RobloxClassMemberKind, name: string): RobloxClassMember | undefined {
  const visited = new Set<string>();
  let current = getRobloxApiClass(className);
  while (current !== undefined && !visited.has(current.name)) {
    visited.add(current.name);
    const member = current.members.find((entry) => entry.kind === kind && entry.name === name);
    if (member !== undefined) return member;
    current = current.superclass === undefined ? undefined : getRobloxApiClass(current.superclass);
  }
  return undefined;
}

/** Returns the effective member surface, with child declarations shadowing ancestors. */
export function resolveRobloxClassMembers(className: string, kind?: RobloxClassMemberKind): readonly RobloxClassMember[] {
  const resolved = new Map<string, RobloxClassMember>();
  const visited = new Set<string>();
  let current = getRobloxApiClass(className);
  while (current !== undefined && !visited.has(current.name)) {
    visited.add(current.name);
    for (const member of current.members) {
      if ((kind === undefined || member.kind === kind) && !resolved.has(`${member.kind}\u0000${member.name}`)) resolved.set(`${member.kind}\u0000${member.name}`, member);
    }
    current = current.superclass === undefined ? undefined : getRobloxApiClass(current.superclass);
  }
  return [...resolved.values()].sort((left, right) => compareText(left.id, right.id));
}

/** Validates untrusted catalog JSON before it is used by a tool or policy compiler. */
export function validateRobloxApiCatalog(value: unknown): asserts value is RobloxApiCatalog {
  const catalog = object(value, "RobloxApiCatalog");
  exactKeys(catalog, ["kind", "source", "classes", "datatypes", "enums", "globalMembers", "libraries", "counts", "contentHash"], "RobloxApiCatalog");
  if (catalog.kind !== "RobloxApiCatalog") fail("catalog kind");
  const source = object(catalog.source, "catalog source");
  validateSource(source);
  const classes = array(catalog.classes, "catalog classes");
  const datatypes = array(catalog.datatypes, "catalog datatypes");
  const enums = array(catalog.enums, "catalog enums");
  const globalMembers = array(catalog.globalMembers, "catalog global members");
  const libraries = array(catalog.libraries, "catalog libraries");
  const names = classes.map((entry) => string(object(entry, "catalog class").name, "catalog class name"));
  sortedUnique(names, "catalog classes");
  sortedUnique(datatypes.map((entry) => string(object(entry, "catalog datatype").name, "catalog datatype name")), "catalog datatypes");
  sortedUnique(enums.map((entry) => string(object(entry, "catalog enum").name, "catalog enum name")), "catalog enums");
  sortedUnique(globalMembers.map((entry) => string(object(entry, "catalog global member").id, "catalog global member id")), "catalog global members");
  sortedUnique(libraries.map((entry) => string(object(entry, "catalog library").name, "catalog library name")), "catalog libraries");
  const classNames = new Set(names);
  const ids = new Set<string>();
  for (const entry of classes) validateClass(object(entry, "catalog class"), classNames, ids);
  for (const entry of datatypes) validateDatatype(object(entry, "catalog datatype"), ids);
  for (const entry of enums) validateEnum(object(entry, "catalog enum"), ids);
  for (const entry of globalMembers) validateGlobalMember(object(entry, "catalog global member"), ids);
  for (const entry of libraries) validateLibrary(object(entry, "catalog library"), ids);
  assertAcyclicInheritance(classes, classNames);
  const counts = validateCounts(catalog.counts, "catalog counts");
  const actualCounts = countCatalog(classes, datatypes, enums, globalMembers, libraries);
  if (!sameCounts(counts, actualCounts) || !sameCounts(counts, validateCounts(source.counts, "source counts"))) fail("catalog counts");
  if (!isHash(catalog.contentHash)) fail("catalog content hash");
  const material = { kind: catalog.kind, source, classes, datatypes, enums, globalMembers, libraries, counts: catalog.counts };
  if (contentHash(stableJson(material)) !== catalog.contentHash) fail("catalog content hash");
}

/** Safe runtime boundary for JSON supplied by a local compiler or test fixture. */
export function loadRobloxApiCatalog(value: unknown): RobloxApiCatalog {
  validateRobloxApiCatalog(value);
  return value;
}

function validateSource(value: unknown): void {
  const source = object(value, "catalog source");
  exactKeys(source, ["kind", "repository", "commit", "engineReferencePath", "sourceTreeHash", "counts"], "catalog source");
  if (source.kind !== "RobloxApiCatalogSource" || source.repository !== "https://github.com/Roblox/creator-docs.git" || !isCommit(source.commit) || source.engineReferencePath !== "content/en-us/reference/engine" || !isHash(source.sourceTreeHash)) fail("catalog source");
  validateCounts(source.counts, "catalog source counts");
}

function validateClass(entry: Record<string, unknown>, classNames: ReadonlySet<string>, ids: Set<string>): void {
  const name = string(entry.name, "catalog class name");
  exactKeys(entry, ["id", "name", ...(entry.superclass === undefined ? [] : ["superclass"]), "tags", "deprecated", "members", "sourceFile", "sourceFileHash"], "catalog class");
  if (entry.id !== `class:${name}` || typeof entry.deprecated !== "boolean") fail("catalog class");
  if (entry.superclass !== undefined && (!isNonEmptyString(entry.superclass) || !classNames.has(entry.superclass))) fail("catalog superclass");
  sortedTags(entry.tags, `catalog class tags ${name}`); validateSourceFile(entry.sourceFile, entry.sourceFileHash, `catalog class ${name}`); if (entry.sourceFile !== `classes/${name}.yaml`) fail("catalog class source path"); addId(ids, entry.id);
  const members = array(entry.members, `catalog class members ${name}`);
  sortedUnique(members.map((member) => string(object(member, "catalog class member").id, "catalog class member id")), `catalog class members ${name}`);
  for (const member of members) validateClassMember(object(member, "catalog class member"), name, entry.sourceFile, entry.sourceFileHash, ids);
}

function validateClassMember(entry: Record<string, unknown>, className: string, sourceFile: unknown, sourceFileHash: unknown, ids: Set<string>): void {
  const optional = [entry.valueType === undefined ? [] : ["valueType"], entry.parameters === undefined ? [] : ["parameters"], entry.returns === undefined ? [] : ["returns"], entry.security === undefined ? [] : ["security"], entry.serialization === undefined ? [] : ["serialization"], entry.threadSafety === undefined ? [] : ["threadSafety"]].flat();
  exactKeys(entry, ["id", "kind", "name", "declaringClass", ...optional, "tags", "deprecated", "capabilities", "sourceFile", "sourceFileHash"], "catalog class member");
  const kind = classMemberKind(entry.kind); const name = string(entry.name, "catalog class member name");
  if (entry.declaringClass !== className || typeof entry.deprecated !== "boolean" || !matchesMemberId(entry.id, `class_member:${className}:${kind}:${name}`)) fail("catalog class member");
  if (kind === "property") {
    if (!isNonEmptyString(entry.valueType) || entry.serialization === undefined) fail("catalog property");
  } else if (entry.valueType !== undefined || entry.serialization !== undefined) fail("catalog non-property member");
  sortedTags(entry.tags, `catalog class member tags ${String(entry.id)}`); sortedTags(entry.capabilities, `catalog class member capabilities ${String(entry.id)}`);
  validateParameters(entry.parameters, `catalog class member parameters ${String(entry.id)}`); validateReturns(entry.returns, `catalog class member returns ${String(entry.id)}`); validateSecurity(entry.security, `catalog class member security ${String(entry.id)}`); validateSerialization(entry.serialization, `catalog class member serialization ${String(entry.id)}`);
  if (entry.threadSafety !== undefined) string(entry.threadSafety, "catalog class member thread safety");
  if (entry.sourceFile !== sourceFile || entry.sourceFileHash !== sourceFileHash) fail("catalog class member source provenance"); addId(ids, entry.id);
}

function validateDatatype(entry: Record<string, unknown>, ids: Set<string>): void {
  const name = string(entry.name, "catalog datatype name");
  exactKeys(entry, ["id", "name", "tags", "deprecated", "members", "sourceFile", "sourceFileHash"], "catalog datatype");
  if (entry.id !== `datatype:${name}` || typeof entry.deprecated !== "boolean") fail("catalog datatype");
  sortedTags(entry.tags, `catalog datatype tags ${name}`); validateSourceFile(entry.sourceFile, entry.sourceFileHash, `catalog datatype ${name}`); if (entry.sourceFile !== `datatypes/${name}.yaml`) fail("catalog datatype source path"); addId(ids, entry.id);
  const members = array(entry.members, `catalog datatype members ${name}`);
  sortedUnique(members.map((member) => string(object(member, "catalog datatype member").id, "catalog datatype member id")), `catalog datatype members ${name}`);
  for (const member of members) validateDatatypeMember(object(member, "catalog datatype member"), name, entry.sourceFile, entry.sourceFileHash, ids);
}

function validateDatatypeMember(entry: Record<string, unknown>, datatypeName: string, sourceFile: unknown, sourceFileHash: unknown, ids: Set<string>): void {
  const optional = [entry.valueType === undefined ? [] : ["valueType"], entry.operandTypes === undefined ? [] : ["operandTypes"], entry.parameters === undefined ? [] : ["parameters"], entry.returns === undefined ? [] : ["returns"]].flat();
  exactKeys(entry, ["id", "kind", "name", "declaringDatatype", ...optional, "tags", "deprecated", "sourceFile", "sourceFileHash"], "catalog datatype member");
  const kind = datatypeMemberKind(entry.kind); const name = string(entry.name, "catalog datatype member name");
  if (entry.declaringDatatype !== datatypeName || typeof entry.deprecated !== "boolean" || !matchesMemberId(entry.id, `datatype_member:${datatypeName}:${kind}:${name}`)) fail("catalog datatype member");
  const needsValueType = kind === "constant" || kind === "property" || kind === "math_operation";
  if (needsValueType !== isNonEmptyString(entry.valueType)) fail("catalog datatype member value type");
  if (kind === "math_operation") {
    const operands = array(entry.operandTypes, "catalog math operands"); if (operands.length !== 2 || operands.some((value) => !isNonEmptyString(value))) fail("catalog math operands");
  } else if (entry.operandTypes !== undefined) fail("catalog non-math operands");
  sortedTags(entry.tags, `catalog datatype member tags ${String(entry.id)}`); validateParameters(entry.parameters, `catalog datatype member parameters ${String(entry.id)}`); validateReturns(entry.returns, `catalog datatype member returns ${String(entry.id)}`);
  if (entry.sourceFile !== sourceFile || entry.sourceFileHash !== sourceFileHash) fail("catalog datatype member source provenance"); addId(ids, entry.id);
}

function validateEnum(entry: Record<string, unknown>, ids: Set<string>): void {
  const name = string(entry.name, "catalog enum name");
  exactKeys(entry, ["id", "name", "tags", "deprecated", "items", "sourceFile", "sourceFileHash"], "catalog enum");
  if (entry.id !== `enum:${name}` || typeof entry.deprecated !== "boolean") fail("catalog enum");
  sortedTags(entry.tags, `catalog enum tags ${name}`); validateSourceFile(entry.sourceFile, entry.sourceFileHash, `catalog enum ${name}`); if (entry.sourceFile !== `enums/${name}.yaml`) fail("catalog enum source path"); addId(ids, entry.id);
  const items = array(entry.items, `catalog enum items ${name}`);
  sortedUnique(items.map((item) => string(object(item, "catalog enum item").name, "catalog enum item name")), `catalog enum items ${name}`);
  for (const item of items) validateEnumItem(object(item, "catalog enum item"), name, ids);
}

function validateEnumItem(entry: Record<string, unknown>, enumName: string, ids: Set<string>): void {
  const name = string(entry.name, "catalog enum item name"); exactKeys(entry, ["id", "name", "value", "tags", "deprecated"], "catalog enum item");
  if (entry.id !== `enum_item:${enumName}:${name}` || !Number.isSafeInteger(entry.value) || typeof entry.deprecated !== "boolean") fail("catalog enum item");
  sortedTags(entry.tags, `catalog enum item tags ${String(entry.id)}`); addId(ids, entry.id);
}

function validateGlobalMember(entry: Record<string, unknown>, ids: Set<string>): void {
  const optional = [entry.valueType === undefined ? [] : ["valueType"], entry.parameters === undefined ? [] : ["parameters"], entry.returns === undefined ? [] : ["returns"]].flat();
  exactKeys(entry, ["id", "kind", "name", "declaringScope", ...optional, "tags", "deprecated", "sourceFile", "sourceFileHash"], "catalog global member");
  const kind = sourceMemberKind(entry.kind, "catalog global member kind"); const name = string(entry.name, "catalog global member name"); const scope = string(entry.declaringScope, "catalog global member scope");
  if (typeof entry.deprecated !== "boolean" || !matchesMemberId(entry.id, `global_member:${scope}:${kind}:${name}`)) fail("catalog global member");
  if ((kind === "property") !== isNonEmptyString(entry.valueType)) fail("catalog global member value type");
  sortedTags(entry.tags, `catalog global member tags ${String(entry.id)}`); validateParameters(entry.parameters, `catalog global member parameters ${String(entry.id)}`); validateReturns(entry.returns, `catalog global member returns ${String(entry.id)}`); validateSourceFile(entry.sourceFile, entry.sourceFileHash, `catalog global member ${String(entry.id)}`); addId(ids, entry.id);
}

function validateLibrary(entry: Record<string, unknown>, ids: Set<string>): void {
  const name = string(entry.name, "catalog library name");
  exactKeys(entry, ["id", "name", "tags", "deprecated", "members", "sourceFile", "sourceFileHash"], "catalog library");
  if (entry.id !== `library:${name}` || typeof entry.deprecated !== "boolean" || entry.sourceFile !== `libraries/${name}.yaml`) fail("catalog library");
  sortedTags(entry.tags, `catalog library tags ${name}`); validateSourceFile(entry.sourceFile, entry.sourceFileHash, `catalog library ${name}`); addId(ids, entry.id);
  const members = array(entry.members, `catalog library members ${name}`);
  sortedUnique(members.map((member) => string(object(member, "catalog library member").id, "catalog library member id")), `catalog library members ${name}`);
  for (const member of members) validateLibraryMember(object(member, "catalog library member"), name, entry.sourceFile, entry.sourceFileHash, ids);
}

function validateLibraryMember(entry: Record<string, unknown>, libraryName: string, sourceFile: unknown, sourceFileHash: unknown, ids: Set<string>): void {
  const optional = [entry.valueType === undefined ? [] : ["valueType"], entry.parameters === undefined ? [] : ["parameters"], entry.returns === undefined ? [] : ["returns"]].flat();
  exactKeys(entry, ["id", "kind", "name", "declaringLibrary", ...optional, "tags", "deprecated", "sourceFile", "sourceFileHash"], "catalog library member");
  const kind = sourceMemberKind(entry.kind, "catalog library member kind"); const name = string(entry.name, "catalog library member name");
  if (entry.declaringLibrary !== libraryName || typeof entry.deprecated !== "boolean" || !matchesMemberId(entry.id, `library_member:${libraryName}:${kind}:${name}`)) fail("catalog library member");
  if ((kind === "property") !== isNonEmptyString(entry.valueType) || entry.sourceFile !== sourceFile || entry.sourceFileHash !== sourceFileHash) fail("catalog library member payload");
  sortedTags(entry.tags, `catalog library member tags ${String(entry.id)}`); validateParameters(entry.parameters, `catalog library member parameters ${String(entry.id)}`); validateReturns(entry.returns, `catalog library member returns ${String(entry.id)}`); addId(ids, entry.id);
}

function validateParameters(value: unknown, label: string): void {
  if (value === undefined) return;
  for (const entry of array(value, label)) { const parameter = object(entry, label); exactKeys(parameter, ["name", "type", ...(parameter.default === undefined ? [] : ["default"])], label); if (!isNonEmptyString(parameter.name) || !isNonEmptyString(parameter.type) || (parameter.default !== undefined && !["string", "number", "boolean"].includes(typeof parameter.default))) fail(label); }
}
function validateReturns(value: unknown, label: string): void { if (value === undefined) return; for (const entry of array(value, label)) { const result = object(entry, label); exactKeys(result, ["type"], label); if (!isNonEmptyString(result.type)) fail(label); } }
function validateSecurity(value: unknown, label: string): void { if (value === undefined) return; const security = object(value, label); exactKeys(security, [...(security.read === undefined ? [] : ["read"]), ...(security.write === undefined ? [] : ["write"])], label); if (!isNonEmptyString(security.read) && !isNonEmptyString(security.write)) fail(label); }
function validateSerialization(value: unknown, label: string): void { if (value === undefined) return; const serialization = object(value, label); exactKeys(serialization, ["canLoad", "canSave"], label); if (typeof serialization.canLoad !== "boolean" || typeof serialization.canSave !== "boolean") fail(label); }

function assertAcyclicInheritance(classes: readonly unknown[], classNames: ReadonlySet<string>): void {
  const parents = new Map(classes.map((entry) => { const value = object(entry, "catalog class"); return [string(value.name, "catalog class name"), value.superclass === undefined ? undefined : string(value.superclass, "catalog superclass")]; }));
  for (const name of classNames) { const visited = new Set<string>(); let current: string | undefined = name; while (current !== undefined) { if (visited.has(current)) fail(`catalog inheritance cycle ${name}`); visited.add(current); current = parents.get(current); } }
}

function validateCounts(value: unknown, label: string): RobloxApiCatalogCounts {
  const counts = object(value, label); exactKeys(counts, COUNT_KEYS, label);
  for (const key of COUNT_KEYS) if (!Number.isSafeInteger(counts[key]) || Number(counts[key]) < 0) fail(label);
  return counts as unknown as RobloxApiCatalogCounts;
}
function countCatalog(classes: readonly unknown[], datatypes: readonly unknown[], enums: readonly unknown[], globalMembers: readonly unknown[], libraries: readonly unknown[]): RobloxApiCatalogCounts {
  const counts: { -readonly [Key in keyof RobloxApiCatalogCounts]: number } = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as { -readonly [Key in keyof RobloxApiCatalogCounts]: number };
  counts.classes = classes.length; counts.datatypes = datatypes.length; counts.enums = enums.length;
  for (const item of classes) for (const member of array(object(item, "catalog class").members, "catalog class members")) {
    const kind = classMemberKind(object(member, "catalog class member").kind);
    if (kind === "property") counts.classProperties += 1; else if (kind === "method") counts.classMethods += 1; else if (kind === "event") counts.classEvents += 1; else counts.classCallbacks += 1;
  }
  for (const item of datatypes) for (const member of array(object(item, "catalog datatype").members, "catalog datatype members")) {
    const kind = datatypeMemberKind(object(member, "catalog datatype member").kind);
    if (kind === "constant") counts.datatypeConstants += 1; else if (kind === "constructor") counts.datatypeConstructors += 1; else if (kind === "function") counts.datatypeFunctions += 1; else if (kind === "math_operation") counts.datatypeMathOperations += 1; else if (kind === "method") counts.datatypeMethods += 1; else counts.datatypeProperties += 1;
  }
  for (const item of enums) counts.enumItems += array(object(item, "catalog enum").items, "catalog enum items").length;
  for (const item of globalMembers) {
    const kind = sourceMemberKind(object(item, "catalog global member").kind, "catalog global member kind");
    if (kind === "property") counts.globalProperties += 1; else counts.globalFunctions += 1;
  }
  counts.libraries = libraries.length;
  for (const item of libraries) for (const member of array(object(item, "catalog library").members, "catalog library members")) {
    const kind = sourceMemberKind(object(member, "catalog library member").kind, "catalog library member kind");
    if (kind === "property") counts.libraryProperties += 1; else counts.libraryFunctions += 1;
  }
  return counts;
}
function sameCounts(left: RobloxApiCatalogCounts, right: RobloxApiCatalogCounts): boolean { return COUNT_KEYS.every((key) => left[key] === right[key]); }

function classMemberKind(value: unknown): RobloxClassMemberKind { if ((CLASS_MEMBER_KINDS as readonly unknown[]).includes(value)) return value as RobloxClassMemberKind; fail("catalog class member kind"); }
function datatypeMemberKind(value: unknown): RobloxDatatypeMemberKind { if ((DATATYPE_MEMBER_KINDS as readonly unknown[]).includes(value)) return value as RobloxDatatypeMemberKind; fail("catalog datatype member kind"); }
function sourceMemberKind(value: unknown, label: string): "property" | "function" { if (value === "property" || value === "function") return value; fail(label); }
function validateSourceFile(sourceFile: unknown, sourceFileHash: unknown, label: string): void { if (!isNonEmptyString(sourceFile) || !SOURCE_DIRECTORIES.some((directory) => sourceFile.startsWith(`${directory}/`)) || sourceFile.includes("..") || !isHash(sourceFileHash)) fail(label); }
function sortedTags(value: unknown, label: string): void { sortedUnique(array(value, label).map((entry) => string(entry, label)), label); }
function sortedUnique(values: readonly string[], label: string): void { for (let index = 0; index < values.length; index += 1) if (index > 0 && compareText(values[index - 1]!, values[index]!) >= 0) fail(`${label} must be sorted and unique`); }
function addId(ids: Set<string>, value: unknown): void { const id = string(value, "catalog id"); if (ids.has(id)) fail("duplicate catalog id"); ids.add(id); }
function matchesMemberId(value: unknown, base: string): boolean { return value === base || (typeof value === "string" && new RegExp(`^${escapeRegExp(base)}:[1-9][0-9]*$`).test(value)); }
function object(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label); return value as Record<string, unknown>; }
function array(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) fail(label); return value; }
function string(value: unknown, label: string): string { if (!isNonEmptyString(value)) fail(label); return value; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void { const actual = Object.keys(value).sort(compareText); const expectedSorted = [...expected].sort(compareText); if (actual.length !== expectedSorted.length || actual.some((key, index) => key !== expectedSorted[index])) fail(label); }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isCommit(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{40}$/.test(value); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function stableJson(value: unknown): string { return JSON.stringify(sortObject(value), null, 2); }
function sortObject(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortObject); if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, sortObject((value as Record<string, unknown>)[key])])); return value; }
function fail(label: string): never { throw new Error(`Invalid Roblox API catalog: ${label}`); }

// The generated artifact is validated during CI. Keeping this assertion at
// module initialization protects direct library users from a bad manual edit.
validateRobloxApiCatalog(ROBLOX_API_CATALOG);
if (ROBLOX_API_CATALOG.contentHash !== ROBLOX_API_CATALOG_HASH) throw new Error("Generated Roblox API catalog hash export drift");
