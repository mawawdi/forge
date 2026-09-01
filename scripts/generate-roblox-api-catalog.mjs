#!/usr/bin/env node
/**
 * Compile the pinned public Roblox engine reference into Forge's compact,
 * deterministic catalog. Normal CI only validates the checked-in artifacts;
 * refreshing is an explicit operation which accepts a local creator-docs
 * checkout or fetches the pinned commit into a temporary directory.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parseDocument } from "yaml";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const sourceContractPath = resolve(root, "packages/studio-evidence/catalog/roblox-api-source.json");
const catalogPath = resolve(root, "packages/studio-evidence/catalog/roblox-api-catalog.json");
const generatedPath = resolve(root, "packages/studio-evidence/src/roblox-api-catalog.generated.ts");
const sourceDirectories = ["classes", "datatypes", "enums"];
const countKeys = [
  "classes", "datatypes", "enums", "classProperties", "classMethods", "classEvents", "classCallbacks",
  "datatypeConstants", "datatypeConstructors", "datatypeFunctions", "datatypeMathOperations", "datatypeMethods",
  "datatypeProperties", "enumItems",
];

const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === "--check";
const refresh = args[0] === "--refresh";
const clone = args.includes("--clone");
const sourceRootIndex = args.indexOf("--source-root");
const sourceRootArgument = sourceRootIndex === -1 ? undefined : args[sourceRootIndex + 1];
const validRefreshArguments = refresh &&
  args.every((argument, index) => argument === "--refresh" || argument === "--clone" || argument === "--source-root" || (index > 0 && args[index - 1] === "--source-root")) &&
  (!clone || sourceRootArgument === undefined) &&
  (clone || typeof sourceRootArgument === "string");
if (!check && !validRefreshArguments) {
  throw new Error("Usage: node scripts/generate-roblox-api-catalog.mjs --check | --refresh --source-root <creator-docs-checkout> | --refresh --clone");
}

const sourceContract = await readJson(sourceContractPath, "Roblox API source contract");
validateSourceContract(sourceContract);

if (check) {
  const catalog = await readJson(catalogPath, "Roblox API catalog");
  validateCatalog(catalog, sourceContract);
  await assertExactOutput(catalogPath, `${stableJson(catalog)}\n`);
  await assertExactOutput(generatedPath, renderTypeScript(catalog));
} else {
  const temporaryDirectory = clone ? await mkdtemp(join(tmpdir(), "forge-roblox-api-")) : undefined;
  try {
    const checkoutRoot = clone
      ? await clonePinnedSource(temporaryDirectory, sourceContract)
      : await checkedSourceRoot(sourceRootArgument);
    const catalog = await compileCatalog(checkoutRoot, sourceContract);
    validateCatalog(catalog, sourceContract);
    await writeFile(catalogPath, `${stableJson(catalog)}\n`, "utf8");
    await writeFile(generatedPath, renderTypeScript(catalog), "utf8");
  } finally {
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function clonePinnedSource(directory, source) {
  await execFileAsync("git", ["clone", "--filter=blob:none", "--no-checkout", source.repository, directory]);
  await execFileAsync("git", ["-C", directory, "fetch", "--depth", "1", "origin", source.commit]);
  await execFileAsync("git", ["-C", directory, "checkout", "--detach", source.commit]);
  const { stdout } = await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"]);
  if (stdout.trim() !== source.commit) throw new Error(`Pinned source commit unavailable from shallow clone: expected ${source.commit}, received ${stdout.trim()}`);
  return checkedSourceRoot(directory);
}

async function checkedSourceRoot(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("A source root is required");
  const rootPath = await realpath(resolve(value));
  const rootStats = await stat(rootPath);
  if (!rootStats.isDirectory()) throw new Error(`Source root is not a directory: ${rootPath}`);
  return rootPath;
}

async function compileCatalog(sourceRoot, source) {
  const engineRoot = resolve(sourceRoot, source.engineReferencePath);
  if (!engineRoot.startsWith(`${sourceRoot}/`)) throw new Error("Engine reference path escapes source root");
  const documentsByDirectory = new Map();
  const sourceFiles = [];
  for (const directory of sourceDirectories) {
    const directoryPath = join(engineRoot, directory);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Official API source must not contain a symlink: ${join(directoryPath, entry.name)}`);
      if (!entry.isFile()) {
        if (entry.isDirectory()) throw new Error(`Official API source must be flat in ${directory}: ${join(directoryPath, entry.name)}`);
        continue;
      }
      if (!entry.name.endsWith(".yaml")) continue;
      const path = join(directoryPath, entry.name);
      const bytes = await readFile(path);
      const yaml = parseYaml(bytes, path);
      const sourceFile = `${directory}/${entry.name}`;
      files.push({ sourceFile, sourceFileHash: sha256(bytes), yaml });
      sourceFiles.push({ sourceFile, bytes });
    }
    documentsByDirectory.set(directory, files.sort((left, right) => compareText(left.sourceFile, right.sourceFile)));
  }
  const sourceTreeHash = sourceTreeDigest(sourceFiles);
  if (sourceTreeHash !== source.sourceTreeHash) throw new Error(`Official API source tree hash drift: expected ${source.sourceTreeHash}, received ${sourceTreeHash}`);

  const classes = (documentsByDirectory.get("classes") ?? []).map(({ sourceFile, sourceFileHash, yaml }) => normalizeClass(yaml, sourceFile, sourceFileHash)).sort(byName);
  const datatypes = (documentsByDirectory.get("datatypes") ?? []).map(({ sourceFile, sourceFileHash, yaml }) => normalizeDatatype(yaml, sourceFile, sourceFileHash)).sort(byName);
  const enums = (documentsByDirectory.get("enums") ?? []).map(({ sourceFile, sourceFileHash, yaml }) => normalizeEnum(yaml, sourceFile, sourceFileHash)).sort(byName);
  const counts = countCatalog({ classes, datatypes, enums });
  const withoutHash = { kind: "RobloxApiCatalog", source, classes, datatypes, enums, counts };
  return { ...withoutHash, contentHash: sha256(stableJson(withoutHash)) };
}

function normalizeClass(value, sourceFile, sourceFileHash) {
  const document = object(value, `class ${sourceFile}`);
  const name = requiredString(document.name, `class name in ${sourceFile}`);
  if (document.type !== "class") throw new Error(`Expected class document: ${sourceFile}`);
  const inherits = stringArray(document.inherits, `inherits for ${name}`);
  if (inherits.length > 1) throw new Error(`Class has multiple superclasses: ${name}`);
  const members = [
    ...normalizeClassMembers(document.properties, "property", name, sourceFile, sourceFileHash),
    ...normalizeClassMembers(document.methods, "method", name, sourceFile, sourceFileHash),
    ...normalizeClassMembers(document.events, "event", name, sourceFile, sourceFileHash),
    ...normalizeClassMembers(document.callbacks, "callback", name, sourceFile, sourceFileHash),
  ].sort(byMember);
  return compact({
    id: `class:${name}`,
    name,
    superclass: inherits[0],
    tags: normalizedTags(document.tags, `tags for ${name}`),
    deprecated: deprecated(document),
    members,
    sourceFile,
    sourceFileHash,
  });
}

function normalizeClassMembers(value, kind, className, sourceFile, sourceFileHash) {
  const entries = array(value, `${kind} members for ${className}`);
  const normalized = entries.map((entry, index) => {
    const member = object(entry, `${kind} member ${className}[${index}]`);
    const sourceName = requiredString(member.name, `${kind} member name for ${className}`);
    const name = classMemberName(sourceName, className, kind);
    const security = normalizeSecurity(member.security, `${className}.${name}`);
    const serialization = kind === "property" ? normalizeSerialization(member.serialization, `${className}.${name}`) : undefined;
    return compact({
      id: "",
      kind,
      name,
      declaringClass: className,
      valueType: kind === "property" ? requiredString(member.type, `property type for ${className}.${name}`) : undefined,
      parameters: member.parameters === undefined ? undefined : normalizeParameters(member.parameters, `${className}.${name}`),
      returns: member.returns === undefined ? undefined : normalizeReturns(member.returns, `${className}.${name}`),
      tags: normalizedTags(member.tags, `tags for ${className}.${name}`),
      deprecated: deprecated(member),
      security,
      serialization,
      threadSafety: optionalString(member.thread_safety, `thread safety for ${className}.${name}`),
      capabilities: normalizedTags(member.capabilities, `capabilities for ${className}.${name}`),
      sourceFile,
      sourceFileHash,
    });
  });
  return withOrdinals(normalized, (entry) => `class_member:${className}:${kind}:${entry.name}`);
}

function normalizeDatatype(value, sourceFile, sourceFileHash) {
  const document = object(value, `datatype ${sourceFile}`);
  const name = requiredString(document.name, `datatype name in ${sourceFile}`);
  if (document.type !== "datatype") throw new Error(`Expected datatype document: ${sourceFile}`);
  const members = [
    ...normalizeDatatypeMembers(document.constants, "constant", name, sourceFile, sourceFileHash),
    ...normalizeDatatypeMembers(document.constructors, "constructor", name, sourceFile, sourceFileHash),
    ...normalizeDatatypeMembers(document.functions, "function", name, sourceFile, sourceFileHash),
    ...normalizeDatatypeMembers(document.math_operations, "math_operation", name, sourceFile, sourceFileHash),
    ...normalizeDatatypeMembers(document.methods, "method", name, sourceFile, sourceFileHash),
    ...normalizeDatatypeMembers(document.properties, "property", name, sourceFile, sourceFileHash),
  ].sort(byMember);
  return {
    id: `datatype:${name}`,
    name,
    tags: normalizedTags(document.tags, `tags for ${name}`),
    deprecated: deprecated(document),
    members,
    sourceFile,
    sourceFileHash,
  };
}

function normalizeDatatypeMembers(value, kind, datatypeName, sourceFile, sourceFileHash) {
  const entries = array(value, `${kind} members for ${datatypeName}`);
  const normalized = entries.map((entry, index) => {
    const member = object(entry, `${kind} member ${datatypeName}[${index}]`);
    const sourceName = requiredString(member.name, `${kind} member name for ${datatypeName}`);
    const name = datatypeMemberName(sourceName, datatypeName, kind);
    return compact({
      id: "",
      kind,
      name,
      declaringDatatype: datatypeName,
      valueType: ["constant", "property"].includes(kind) ? requiredString(member.type, `${kind} type for ${datatypeName}.${name}`) : kind === "math_operation" ? requiredString(member.return_type, `math return type for ${datatypeName}.${name}`) : undefined,
      operandTypes: kind === "math_operation" ? [requiredString(member.type_a, `math left operand for ${datatypeName}.${name}`), requiredString(member.type_b, `math right operand for ${datatypeName}.${name}`)] : undefined,
      parameters: member.parameters === undefined ? undefined : normalizeParameters(member.parameters, `${datatypeName}.${name}`),
      returns: member.returns === undefined ? undefined : normalizeReturns(member.returns, `${datatypeName}.${name}`),
      tags: normalizedTags(member.tags, `tags for ${datatypeName}.${name}`),
      deprecated: deprecated(member),
      sourceFile,
      sourceFileHash,
    });
  });
  return withOrdinals(normalized, (entry) => `datatype_member:${datatypeName}:${kind}:${entry.name}`);
}

function normalizeEnum(value, sourceFile, sourceFileHash) {
  const document = object(value, `enum ${sourceFile}`);
  const name = requiredString(document.name, `enum name in ${sourceFile}`);
  if (document.type !== "enum") throw new Error(`Expected enum document: ${sourceFile}`);
  const items = array(document.items, `enum items for ${name}`).map((entry, index) => {
    const item = object(entry, `enum item ${name}[${index}]`);
    const itemName = requiredString(item.name, `enum item name for ${name}`);
    const enumValue = item.value;
    if (!Number.isSafeInteger(enumValue)) throw new Error(`Enum value must be a safe integer: ${name}.${itemName}`);
    return {
      id: `enum_item:${name}:${itemName}`,
      name: itemName,
      value: enumValue,
      tags: normalizedTags(item.tags, `tags for ${name}.${itemName}`),
      deprecated: deprecated(item),
    };
  }).sort(byName);
  return {
    id: `enum:${name}`,
    name,
    tags: normalizedTags(document.tags, `tags for ${name}`),
    deprecated: deprecated(document),
    items,
    sourceFile,
    sourceFileHash,
  };
}

function withOrdinals(entries, baseId) {
  const byBaseId = new Map();
  for (const entry of entries) {
    const id = baseId(entry);
    const group = byBaseId.get(id);
    if (group === undefined) byBaseId.set(id, [entry]); else group.push(entry);
  }
  const result = [];
  for (const [id, group] of byBaseId) {
    group.sort((left, right) => compareText(memberSignature(left), memberSignature(right)));
    for (let index = 0; index < group.length; index += 1) result.push({ ...group[index], id: group.length === 1 ? id : `${id}:${index + 1}` });
  }
  return result;
}

function normalizeParameters(value, label) {
  return array(value, `parameters for ${label}`).map((entry, index) => {
    const parameter = object(entry, `parameter ${index} for ${label}`);
    const defaultValue = parameter.default;
    if (defaultValue !== null && defaultValue !== undefined && typeof defaultValue !== "string" && typeof defaultValue !== "number" && typeof defaultValue !== "boolean") throw new Error(`Invalid parameter default for ${label}`);
    return compact({
      name: requiredString(parameter.name, `parameter name for ${label}`),
      type: requiredString(parameter.type, `parameter type for ${label}`),
      default: defaultValue === null ? undefined : defaultValue,
    });
  });
}

function normalizeReturns(value, label) {
  return array(value, `returns for ${label}`).map((entry, index) => {
    const result = object(entry, `return ${index} for ${label}`);
    return { type: requiredString(result.type, `return type for ${label}`) };
  });
}

function normalizeSecurity(value, label) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return { read: value };
  const security = object(value, `security for ${label}`);
  return compact({ read: optionalString(security.read, `security read for ${label}`), write: optionalString(security.write, `security write for ${label}`) });
}

function normalizeSerialization(value, label) {
  const serialization = object(value, `serialization for ${label}`);
  if (typeof serialization.can_load !== "boolean" || typeof serialization.can_save !== "boolean") throw new Error(`Invalid serialization for ${label}`);
  return { canLoad: serialization.can_load, canSave: serialization.can_save };
}

function classMemberName(value, className, kind) {
  const delimiter = kind === "method" ? ":" : ".";
  const prefix = `${className}${delimiter}`;
  if (!value.startsWith(prefix) || value.length === prefix.length) throw new Error(`Invalid ${kind} member name: ${value}`);
  return value.slice(prefix.length);
}

function datatypeMemberName(value, datatypeName, kind) {
  if (kind === "math_operation") return value;
  const delimiter = kind === "method" ? ":" : ".";
  const prefix = `${datatypeName}${delimiter}`;
  if (!value.startsWith(prefix) || value.length === prefix.length) throw new Error(`Invalid ${kind} member name: ${value}`);
  return value.slice(prefix.length);
}

function countCatalog({ classes, datatypes, enums }) {
  const counts = Object.fromEntries(countKeys.map((key) => [key, 0]));
  counts.classes = classes.length;
  counts.datatypes = datatypes.length;
  counts.enums = enums.length;
  for (const entry of classes) for (const member of entry.members) {
    if (member.kind === "property") counts.classProperties += 1;
    else if (member.kind === "method") counts.classMethods += 1;
    else if (member.kind === "event") counts.classEvents += 1;
    else counts.classCallbacks += 1;
  }
  for (const entry of datatypes) for (const member of entry.members) {
    if (member.kind === "constant") counts.datatypeConstants += 1;
    else if (member.kind === "constructor") counts.datatypeConstructors += 1;
    else if (member.kind === "function") counts.datatypeFunctions += 1;
    else if (member.kind === "math_operation") counts.datatypeMathOperations += 1;
    else if (member.kind === "method") counts.datatypeMethods += 1;
    else counts.datatypeProperties += 1;
  }
  for (const entry of enums) counts.enumItems += entry.items.length;
  return counts;
}

function validateSourceContract(value) {
  const source = object(value, "Roblox API source contract");
  exactKeys(source, ["kind", "repository", "commit", "engineReferencePath", "sourceTreeHash", "counts"], "Roblox API source contract");
  if (source.kind !== "RobloxApiCatalogSource" || source.repository !== "https://github.com/Roblox/creator-docs.git" || !isCommit(source.commit) || source.engineReferencePath !== "content/en-us/reference/engine" || !isHash(source.sourceTreeHash)) throw new Error("Malformed Roblox API source contract");
  validateCounts(source.counts, "Roblox API source contract");
}

function validateCatalog(value, sourceContract) {
  const catalog = object(value, "Roblox API catalog");
  exactKeys(catalog, ["kind", "source", "classes", "datatypes", "enums", "counts", "contentHash"], "Roblox API catalog");
  if (catalog.kind !== "RobloxApiCatalog") throw new Error("Catalog kind must be RobloxApiCatalog");
  if (stableJson(catalog.source) !== stableJson(sourceContract)) throw new Error("Catalog source pin/count/hash drift from roblox-api-source.json");
  validateCounts(catalog.counts, "Roblox API catalog");
  const classes = array(catalog.classes, "catalog classes");
  const datatypes = array(catalog.datatypes, "catalog datatypes");
  const enums = array(catalog.enums, "catalog enums");
  validateSortedUnique(classes.map((entry) => requiredString(object(entry, "catalog class").name, "catalog class name")), "catalog classes");
  validateSortedUnique(datatypes.map((entry) => requiredString(object(entry, "catalog datatype").name, "catalog datatype name")), "catalog datatypes");
  validateSortedUnique(enums.map((entry) => requiredString(object(entry, "catalog enum").name, "catalog enum name")), "catalog enums");
  const classNames = new Set(classes.map((entry) => entry.name));
  const ids = new Set();
  for (const entry of classes) validateCatalogClass(object(entry, "catalog class"), classNames, ids);
  for (const entry of datatypes) validateCatalogDatatype(object(entry, "catalog datatype"), ids);
  for (const entry of enums) validateCatalogEnum(object(entry, "catalog enum"), ids);
  const actualCounts = countCatalog({ classes, datatypes, enums });
  if (stableJson(actualCounts) !== stableJson(catalog.counts) || stableJson(actualCounts) !== stableJson(sourceContract.counts)) throw new Error("Catalog member counts drift from source contract");
  assertNoInheritanceCycles(classes, classNames);
  const material = { kind: catalog.kind, source: catalog.source, classes, datatypes, enums, counts: catalog.counts };
  if (!isHash(catalog.contentHash) || sha256(stableJson(material)) !== catalog.contentHash) throw new Error("Catalog content hash does not match its normalized content");
}

function validateCatalogClass(entry, classNames, ids) {
  exactKeys(entry, ["id", "name", ...(entry.superclass === undefined ? [] : ["superclass"]), "tags", "deprecated", "members", "sourceFile", "sourceFileHash"], "catalog class");
  if (entry.id !== `class:${entry.name}` || (entry.superclass !== undefined && (!isNonEmptyString(entry.superclass) || !classNames.has(entry.superclass))) || typeof entry.deprecated !== "boolean") throw new Error(`Malformed catalog class: ${String(entry.name)}`);
  validateTags(entry.tags, `catalog class tags for ${entry.name}`); validateSourceFile(entry.sourceFile, entry.sourceFileHash, `catalog class ${entry.name}`); if (entry.sourceFile !== `classes/${entry.name}.yaml`) throw new Error(`Catalog class source path mismatch: ${entry.name}`); addId(ids, entry.id);
  const members = array(entry.members, `members for ${entry.name}`);
  validateSortedUnique(members.map((member) => requiredString(object(member, "catalog class member").id, "catalog class member id")), `members for ${entry.name}`);
  for (const member of members) validateCatalogClassMember(object(member, "catalog class member"), entry.name, ids);
}

function validateCatalogClassMember(entry, className, ids) {
  const optional = [entry.valueType === undefined ? [] : ["valueType"], entry.parameters === undefined ? [] : ["parameters"], entry.returns === undefined ? [] : ["returns"], entry.security === undefined ? [] : ["security"], entry.serialization === undefined ? [] : ["serialization"], entry.threadSafety === undefined ? [] : ["threadSafety"]].flat();
  exactKeys(entry, ["id", "kind", "name", "declaringClass", ...optional, "tags", "deprecated", "capabilities", "sourceFile", "sourceFileHash"], "catalog class member");
  if (!isClassMemberKind(entry.kind) || !isNonEmptyString(entry.name) || entry.declaringClass !== className || typeof entry.deprecated !== "boolean") throw new Error(`Malformed class member for ${className}`);
  const base = `class_member:${className}:${entry.kind}:${entry.name}`;
  if (!matchesMemberId(entry.id, base)) throw new Error(`Malformed class member id: ${entry.id}`);
  if (entry.kind === "property" ? !isNonEmptyString(entry.valueType) || entry.serialization === undefined : entry.valueType !== undefined || entry.serialization !== undefined) throw new Error(`Malformed class member payload: ${entry.id}`);
  validateTags(entry.tags, `catalog class member tags for ${entry.id}`); validateTags(entry.capabilities, `catalog class member capabilities for ${entry.id}`); validateOptionalMembers(entry, `catalog class member ${entry.id}`); validateSourceFile(entry.sourceFile, entry.sourceFileHash, `catalog class member ${entry.id}`); addId(ids, entry.id);
}

function validateCatalogDatatype(entry, ids) {
  exactKeys(entry, ["id", "name", "tags", "deprecated", "members", "sourceFile", "sourceFileHash"], "catalog datatype");
  if (entry.id !== `datatype:${entry.name}` || !isNonEmptyString(entry.name) || typeof entry.deprecated !== "boolean") throw new Error(`Malformed catalog datatype: ${String(entry.name)}`);
  validateTags(entry.tags, `catalog datatype tags for ${entry.name}`); validateSourceFile(entry.sourceFile, entry.sourceFileHash, `catalog datatype ${entry.name}`); if (entry.sourceFile !== `datatypes/${entry.name}.yaml`) throw new Error(`Catalog datatype source path mismatch: ${entry.name}`); addId(ids, entry.id);
  const members = array(entry.members, `members for ${entry.name}`);
  validateSortedUnique(members.map((member) => requiredString(object(member, "catalog datatype member").id, "catalog datatype member id")), `members for ${entry.name}`);
  for (const member of members) validateCatalogDatatypeMember(object(member, "catalog datatype member"), entry.name, ids);
}

function validateCatalogDatatypeMember(entry, datatypeName, ids) {
  const optional = [entry.valueType === undefined ? [] : ["valueType"], entry.operandTypes === undefined ? [] : ["operandTypes"], entry.parameters === undefined ? [] : ["parameters"], entry.returns === undefined ? [] : ["returns"]].flat();
  exactKeys(entry, ["id", "kind", "name", "declaringDatatype", ...optional, "tags", "deprecated", "sourceFile", "sourceFileHash"], "catalog datatype member");
  if (!isDatatypeMemberKind(entry.kind) || !isNonEmptyString(entry.name) || entry.declaringDatatype !== datatypeName || typeof entry.deprecated !== "boolean") throw new Error(`Malformed datatype member for ${datatypeName}`);
  const base = `datatype_member:${datatypeName}:${entry.kind}:${entry.name}`;
  if (!matchesMemberId(entry.id, base)) throw new Error(`Malformed datatype member id: ${entry.id}`);
  const needsValueType = entry.kind === "constant" || entry.kind === "property" || entry.kind === "math_operation";
  if (needsValueType !== isNonEmptyString(entry.valueType) || (entry.kind === "math_operation") !== Array.isArray(entry.operandTypes)) throw new Error(`Malformed datatype member payload: ${entry.id}`);
  if (entry.operandTypes !== undefined && (entry.operandTypes.length !== 2 || entry.operandTypes.some((type) => !isNonEmptyString(type)))) throw new Error(`Malformed datatype operands: ${entry.id}`);
  validateTags(entry.tags, `catalog datatype member tags for ${entry.id}`); validateOptionalMembers(entry, `catalog datatype member ${entry.id}`); validateSourceFile(entry.sourceFile, entry.sourceFileHash, `catalog datatype member ${entry.id}`); addId(ids, entry.id);
}

function validateCatalogEnum(entry, ids) {
  exactKeys(entry, ["id", "name", "tags", "deprecated", "items", "sourceFile", "sourceFileHash"], "catalog enum");
  if (entry.id !== `enum:${entry.name}` || !isNonEmptyString(entry.name) || typeof entry.deprecated !== "boolean") throw new Error(`Malformed catalog enum: ${String(entry.name)}`);
  validateTags(entry.tags, `catalog enum tags for ${entry.name}`); validateSourceFile(entry.sourceFile, entry.sourceFileHash, `catalog enum ${entry.name}`); if (entry.sourceFile !== `enums/${entry.name}.yaml`) throw new Error(`Catalog enum source path mismatch: ${entry.name}`); addId(ids, entry.id);
  const items = array(entry.items, `items for ${entry.name}`);
  validateSortedUnique(items.map((item) => requiredString(object(item, "catalog enum item").name, "catalog enum item name")), `items for ${entry.name}`);
  for (const item of items) {
    const parsed = object(item, "catalog enum item");
    exactKeys(parsed, ["id", "name", "value", "tags", "deprecated"], "catalog enum item");
    if (parsed.id !== `enum_item:${entry.name}:${parsed.name}` || !isNonEmptyString(parsed.name) || !Number.isSafeInteger(parsed.value) || typeof parsed.deprecated !== "boolean") throw new Error(`Malformed catalog enum item: ${entry.name}`);
    validateTags(parsed.tags, `catalog enum item tags for ${parsed.id}`); addId(ids, parsed.id);
  }
}

function validateOptionalMembers(entry, label) {
  if (entry.parameters !== undefined) for (const parameter of array(entry.parameters, `${label} parameters`)) {
    const parsed = object(parameter, `${label} parameter`); exactKeys(parsed, ["name", "type", ...(parsed.default === undefined ? [] : ["default"])], `${label} parameter`);
    if (!isNonEmptyString(parsed.name) || !isNonEmptyString(parsed.type) || (parsed.default !== undefined && !["string", "number", "boolean"].includes(typeof parsed.default))) throw new Error(`Malformed ${label} parameter`);
  }
  if (entry.returns !== undefined) for (const result of array(entry.returns, `${label} returns`)) { const parsed = object(result, `${label} return`); exactKeys(parsed, ["type"], `${label} return`); if (!isNonEmptyString(parsed.type)) throw new Error(`Malformed ${label} return`); }
  if (entry.security !== undefined) { const security = object(entry.security, `${label} security`); exactKeys(security, [ ...(security.read === undefined ? [] : ["read"]), ...(security.write === undefined ? [] : ["write"]) ], `${label} security`); if (!isNonEmptyString(security.read) && !isNonEmptyString(security.write)) throw new Error(`Malformed ${label} security`); }
  if (entry.serialization !== undefined) { const serialization = object(entry.serialization, `${label} serialization`); exactKeys(serialization, ["canLoad", "canSave"], `${label} serialization`); if (typeof serialization.canLoad !== "boolean" || typeof serialization.canSave !== "boolean") throw new Error(`Malformed ${label} serialization`); }
  if (entry.threadSafety !== undefined && !isNonEmptyString(entry.threadSafety)) throw new Error(`Malformed ${label} thread safety`);
}

function assertNoInheritanceCycles(classes, classNames) {
  const parents = new Map(classes.map((entry) => [entry.name, entry.superclass]));
  for (const name of classNames) {
    const visited = new Set();
    let current = name;
    while (current !== undefined) {
      if (visited.has(current)) throw new Error(`Class inheritance cycle: ${name}`);
      visited.add(current); current = parents.get(current);
    }
  }
}

function validateCounts(value, label) {
  const counts = object(value, `${label} counts`); exactKeys(counts, countKeys, `${label} counts`);
  for (const key of countKeys) if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) throw new Error(`Invalid ${label} count: ${key}`);
}

function sourceTreeDigest(files) {
  const hash = createHash("sha256");
  for (const { sourceFile, bytes } of [...files].sort((left, right) => compareText(left.sourceFile, right.sourceFile))) {
    hash.update(tagged("path", sourceFile));
    hash.update(taggedPrefix("bytes", bytes.length));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function renderTypeScript(catalog) {
  return `/* This file is generated by scripts/generate-roblox-api-catalog.mjs. Do not edit. */\nimport type { RobloxApiCatalog } from "./catalog.js";\n\nexport const ROBLOX_API_CATALOG: RobloxApiCatalog = ${stableJson(catalog)};\nexport const ROBLOX_API_CATALOG_HASH = ${JSON.stringify(catalog.contentHash)};\n`;
}

async function assertExactOutput(path, expected) {
  let actual;
  try { actual = await readFile(path, "utf8"); } catch (error) { if (error?.code === "ENOENT") throw new Error(`Missing generated Roblox API catalog output: ${path}`); throw error; }
  if (actual !== expected) throw new Error(`Stale generated Roblox API catalog output: ${path}. Run npm run roblox-api-catalog:refresh`);
}

async function readJson(path, label) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { throw new Error(`Unable to parse ${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

function parseYaml(bytes, path) {
  const document = parseDocument(bytes.toString("utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`Malformed YAML ${path}: ${document.errors.map((error) => error.message).join("; ")}`);
  return document.toJS({ maxAliasCount: 0 });
}

function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)); }
function normalizedTags(value, label) { const tags = stringArray(value, label).sort(compareText); validateSortedUnique(tags, label); return tags; }
function deprecated(value) { const document = object(value, "deprecated source"); return normalizedTags(document.tags, "deprecated tags").includes("Deprecated") || (typeof document.deprecation_message === "string" && document.deprecation_message.trim().length > 0); }
function object(value, label) { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function array(value, label) { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value; }
function stringArray(value, label) { return array(value, label).map((entry) => requiredString(entry, label)); }
function requiredString(value, label) { if (!isNonEmptyString(value)) throw new Error(`${label} must be a non-empty string`); return value; }
function optionalString(value, label) { if (value === undefined) return undefined; return requiredString(value, label); }
function validateTags(value, label) { validateSortedUnique(stringArray(value, label), label); }
function validateSourceFile(sourceFile, sourceFileHash, label) { if (!isNonEmptyString(sourceFile) || !sourceDirectories.some((directory) => sourceFile.startsWith(`${directory}/`)) || sourceFile.includes("..") || !isHash(sourceFileHash)) throw new Error(`Malformed source provenance for ${label}`); }
function validateSortedUnique(values, label) { for (let index = 0; index < values.length; index += 1) if (!isNonEmptyString(values[index]) || (index > 0 && compareText(values[index - 1], values[index]) >= 0)) throw new Error(`${label} must be sorted and unique`); }
function exactKeys(value, expected, label) { const actual = Object.keys(value).sort(compareText); const sortedExpected = [...expected].sort(compareText); if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) throw new Error(`${label} has unexpected fields`); }
function addId(ids, id) { if (!isNonEmptyString(id) || ids.has(id)) throw new Error(`Duplicate or malformed catalog id: ${String(id)}`); ids.add(id); }
function matchesMemberId(value, base) { return value === base || new RegExp(`^${escapeRegExp(base)}:[1-9][0-9]*$`).test(value); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isClassMemberKind(value) { return value === "property" || value === "method" || value === "event" || value === "callback"; }
function isDatatypeMemberKind(value) { return value === "constant" || value === "constructor" || value === "function" || value === "math_operation" || value === "method" || value === "property"; }
function isHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isCommit(value) { return typeof value === "string" && /^[a-f0-9]{40}$/.test(value); }
function isNonEmptyString(value) { return typeof value === "string" && value.length > 0; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function tagged(tag, value) { return `${Buffer.byteLength(tag, "utf8")}:${tag}${Buffer.byteLength(value, "utf8")}:${value}`; }
function taggedPrefix(tag, payloadLength) { return `${Buffer.byteLength(tag, "utf8")}:${tag}${payloadLength}:`; }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function byName(left, right) { return compareText(left.name, right.name); }
function byMember(left, right) { return compareText(left.id, right.id); }
function memberSignature(value) { return stableJson({ name: value.name, valueType: value.valueType, operandTypes: value.operandTypes, parameters: value.parameters, returns: value.returns }); }
function stableJson(value) { return JSON.stringify(sortObject(value), null, 2); }
function sortObject(value) { if (Array.isArray(value)) return value.map(sortObject); if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, sortObject(value[key])])); return value; }
