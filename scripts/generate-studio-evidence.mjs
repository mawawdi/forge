#!/usr/bin/env node
/**
 * The tracked policy selects small proof-closed authoring groups. This
 * generator resolves every selected row through the pinned official catalog,
 * then derives both runtimes. A copied partial manifest table is not an input:
 * an upstream rename, inherited-member mismatch, or proof gap is fatal.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const generatorPath = fileURLToPath(import.meta.url);
const manifestPath = resolve(
  root,
  "packages/studio-evidence/manifest/studio-capability-manifest.json",
);
const policyPath = resolve(root, "packages/studio-evidence/manifest/studio-capability-policy.json");
const catalogPath = resolve(root, "packages/studio-evidence/catalog/roblox-api-catalog.json");
const coveragePath = resolve(
  root,
  "packages/studio-evidence/catalog/studio-capability-coverage-report.json",
);
const protocolPath = resolve(root, "packages/studio-protocol/src/index.ts");
const evidenceContractPath = resolve(root, "packages/studio-evidence/src/index.ts");
const projectIndexContractPath = resolve(root, "packages/studio-evidence/src/project-index.ts");
const projectAuthorityContractPath = resolve(
  root,
  "packages/studio-evidence/src/project-authority.ts",
);
const studioRuntimePath = resolve(root, "packages/studio-runtime/src/index.ts");
const studioBridgePath = resolve(root, "packages/studio-bridge/src/index.ts");
const creatorCoordinatorPath = resolve(root, "packages/creator-session/src/coordinator.ts");
const creatorSourceWritePath = resolve(root, "packages/creator-session/src/source-write.ts");
const pluginSourceRoot = resolve(root, "plugin/src");
const pluginProjectPath = resolve(root, "plugin/default.project.json");
const tsPath = resolve(root, "packages/studio-evidence/src/generated.ts");
const luauPath = resolve(root, "plugin/src/Forge/GeneratedStudioEvidence.luau");
const luauProjectAuthorityPath = resolve(root, "plugin/src/Forge/StudioProjectAuthority.luau");
const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === "--check";
if (args.length > 0 && !check)
  throw new Error("Usage: node scripts/generate-studio-evidence.mjs [--check]");

const REQUIRED_PROOF = [
  "canonicalize",
  "validate",
  "preflight",
  "write",
  "read",
  "project",
  "compare",
];
const SCRIPT_CLASSES = new Set(["LocalScript", "ModuleScript", "Script"]);
// Creator mutation evidence has a distinct, closed binding domain.  Keep this
// schema here so the backend and the Studio plugin derive precisely the same
// field set and value constraints.
const CREATOR_MUTATION_BINDING_SCHEMA = Object.freeze([
  Object.freeze({ name: "sessionId", kind: "non_empty" }),
  Object.freeze({ name: "changeSetHash", kind: "hash" }),
  Object.freeze({ name: "approvalHash", kind: "hash" }),
  Object.freeze({ name: "revisionHash", kind: "hash" }),
  Object.freeze({ name: "buildHash", kind: "hash" }),
  Object.freeze({ name: "dashboardReviewHash", kind: "hash" }),
]);
// This is the one project-identity authority recipe shared by the bridge,
// coordinator, and connector. The generated Luau helper and TypeScript export
// deliberately consume these exact spellings and vectors.
const PROJECT_IDENTITY_AUTHORITY_RECIPE = Object.freeze({
  version: 1,
  projectIdPrefix: "studio_project_",
  projectIdHashChars: 24,
  localUnlinkedPrefix: "local-unlinked:",
  pairingDelimiter: ":pairing:",
  linkedPrefix: "linked:",
  publishedPrefix: "published:",
  connectorEpochKind: "StudioConnectorEpoch",
});
// ReflectionService exposes independent engine-storage and Luau-script type
// domains. Both are generated obligations; neither is a fallback for the
// other. These spellings are part of the curated reflection contract.
const CODEC_REFLECTION_ENGINE_TYPES = Object.freeze({
  boolean: "bool",
  number_f32: "float",
  number_f64: "double",
  int32: "int",
  int64_decimal: "int64",
  string_utf8: "string",
  content: "Content",
  color3_rgb8: "Color3",
  vector2_f32: "Vector2",
  vector3_f32: "Vector3",
  cframe_f32x12: "CoordinateFrame",
  udim: "UDim",
  udim2: "UDim2",
  rect: "Rect2D",
  number_range: "NumberRange",
  number_sequence: "NumberSequence",
  color_sequence: "ColorSequence",
  brick_color: "BrickColor",
  font: "Font",
  physical_properties: "PhysicalProperties",
  axes: "Axes",
  faces: "Faces",
  ray: "Ray",
  instance_ref: "RefType",
});
const NUMERIC_PRIMITIVE_CATALOG_TYPES = new Set(["float", "double", "int", "int64"]);
const STRUCTURAL_PROPERTY_REASON = "structure_managed";

const generatorSource = await readFile(generatorPath, "utf8");
const evidenceContractSource = await readFile(evidenceContractPath, "utf8");
const projectIndexContractSource = await readFile(projectIndexContractPath, "utf8");
const projectAuthorityContractSource = await readFile(projectAuthorityContractPath, "utf8");
const evidenceContractHash = sha256(
  tagged(
    "studio-evidence-contract",
    tagged("generator-source", generatorSource) +
      tagged("typescript-evidence-source", evidenceContractSource) +
      tagged("typescript-project-index-source", projectIndexContractSource) +
      tagged("typescript-project-authority-source", projectAuthorityContractSource),
  ),
);
const policy = parseJsonWithoutDuplicateKeys(await readFile(policyPath, "utf8"), policyPath);
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const manifest = canonicalManifest(deriveManifest(policy, catalog, evidenceContractHash));
validateManifest(manifest);
const manifestHash = sha256(stableJson(manifest));
const policyHash = sha256(stableJson(policy));
const coverageReport = deriveCoverageReport(catalog, policy, policyHash, manifest, manifestHash);
const protocolSource = await readFile(protocolPath, "utf8");
const hostTransactionSources = await Promise.all(
  [studioRuntimePath, studioBridgePath, creatorCoordinatorPath, creatorSourceWritePath].map(
    async (path) => ({
      path: relative(root, path).split("\\").join("/"),
      source: await readFile(path, "utf8"),
    }),
  ),
);
const pluginBuildSources = await readPluginBuildSources(pluginSourceRoot);
const pluginProject = await readFile(pluginProjectPath, "utf8");
const connectorBuildHash = sha256(
  tagged(
    "studio-connector-build",
    tagged("manifest", manifestHash) +
      tagged("evidence-generator-source", generatorSource) +
      tagged("evidence-contract-source", evidenceContractSource) +
      tagged("project-index-contract-source", projectIndexContractSource) +
      tagged("project-authority-contract-source", projectAuthorityContractSource) +
      tagged("protocol-source", protocolSource) +
      tagged(
        "host-transaction-sources",
        hostTransactionSources
          .map(({ path, source }) =>
            tagged("host-transaction-source", tagged("path", path) + tagged("source", source)),
          )
          .join(""),
      ) +
      tagged("plugin-project", pluginProject) +
      tagged(
        "plugin-sources",
        pluginBuildSources
          .map(({ path, source }) =>
            tagged("plugin-source", tagged("path", path) + tagged("source", source)),
          )
          .join(""),
      ),
  ),
);
const outputs = new Map([
  [manifestPath, `${JSON.stringify(manifest, null, 2)}\n`],
  [coveragePath, `${JSON.stringify(coverageReport, null, 2)}\n`],
  [tsPath, renderTypeScript(manifest, manifestHash, connectorBuildHash, coverageReport)],
  [luauPath, renderLuau(manifest, manifestHash, connectorBuildHash)],
  [luauProjectAuthorityPath, renderLuauProjectAuthority()],
]);
for (const [path, output] of outputs) {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (check) {
    if (current !== output)
      throw new Error(
        `Stale generated Studio evidence output: ${path}. Run node scripts/generate-studio-evidence.mjs`,
      );
  } else if (current !== output) {
    await writeFile(path, output, "utf8");
  }
}

/** JSON.parse silently keeps the last duplicate key; policy ambiguity is fatal. */
function parseJsonWithoutDuplicateKeys(source, label) {
  let cursor = 0;
  const whitespace = () => {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
  };
  const parseString = () => {
    if (source[cursor] !== '"') throw new Error(`Invalid JSON string in ${label}`);
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      const character = source[cursor++];
      if (character === "\\") {
        cursor += 1;
        continue;
      }
      if (character === '"') return JSON.parse(source.slice(start, cursor));
      if (character && character < " ")
        throw new Error(`Control character in JSON string in ${label}`);
    }
    throw new Error(`Unterminated JSON string in ${label}`);
  };
  const parseValue = () => {
    whitespace();
    const character = source[cursor];
    if (character === "{") {
      cursor += 1;
      whitespace();
      const keys = new Set();
      if (source[cursor] === "}") {
        cursor += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) throw new Error(`Duplicate JSON key ${JSON.stringify(key)} in ${label}`);
        keys.add(key);
        whitespace();
        if (source[cursor++] !== ":") throw new Error(`Invalid JSON object in ${label}`);
        parseValue();
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === "}") return;
        if (delimiter !== ",") throw new Error(`Invalid JSON object delimiter in ${label}`);
      }
    }
    if (character === "[") {
      cursor += 1;
      whitespace();
      if (source[cursor] === "]") {
        cursor += 1;
        return;
      }
      while (true) {
        parseValue();
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === "]") return;
        if (delimiter !== ",") throw new Error(`Invalid JSON array delimiter in ${label}`);
      }
    }
    if (character === '"') {
      parseString();
      return;
    }
    const start = cursor;
    while (cursor < source.length && !/[\s,\]}]/u.test(source[cursor])) cursor += 1;
    try {
      JSON.parse(source.slice(start, cursor));
    } catch {
      throw new Error(`Invalid JSON primitive in ${label}`);
    }
  };
  parseValue();
  whitespace();
  if (cursor !== source.length) throw new Error(`Trailing JSON material in ${label}`);
  return JSON.parse(source);
}

async function readPluginBuildSources(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink())
      throw new Error(`Plugin build source must not be a symlink: ${join(directory, entry.name)}`);
    const absolute = join(directory, entry.name);
    const nested = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) sources.push(...(await readPluginBuildSources(absolute, nested)));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".luau") &&
      nested !== "Forge/GeneratedStudioEvidence.luau"
    ) {
      sources.push({
        path: relative(root, absolute).split("\\").join("/"),
        source: await readFile(absolute, "utf8"),
      });
    } else if (!entry.isFile())
      throw new Error(`Plugin build source must be a regular file: ${absolute}`);
  }
  return sources;
}

function deriveManifest(policy, catalog, evidenceContractHash) {
  if (policy?.kind !== "StudioCapabilityPolicy")
    throw new Error("Studio capability policy kind must be StudioCapabilityPolicy");
  if (catalog?.kind !== "RobloxApiCatalog" || typeof catalog?.contentHash !== "string")
    throw new Error("Pinned Roblox API catalog is invalid");
  if (policy.catalogCommit !== catalog.source?.commit)
    throw new Error("Studio capability policy catalog commit does not match the pinned catalog");
  const classesByName = new Map(catalog.classes.map((entry) => [entry.name, entry]));
  const datatypesByName = new Map(catalog.datatypes.map((entry) => [entry.name, entry]));
  const enumsByName = new Map(catalog.enums.map((entry) => [entry.name, entry]));
  const groups = Array.isArray(policy.authoringGroups) ? policy.authoringGroups : [];
  const seenClasses = new Set();
  const outputClasses = [];
  const overrides =
    policy.propertyOverrides && typeof policy.propertyOverrides === "object"
      ? policy.propertyOverrides
      : {};
  const exclusions =
    policy.propertyExclusions && typeof policy.propertyExclusions === "object"
      ? policy.propertyExclusions
      : {};
  const defaults = directPropertyDefaults(policy);
  const selectedOverrides = new Set();
  const selectedExclusions = new Set();
  if (!Array.isArray(policy.authoringContainers))
    throw new Error("Studio capability policy requires authoring containers");
  const authoringContainers = policy.authoringContainers.map((entry) => {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.className !== "string" ||
      !classesByName.has(entry.className)
    )
      throw new Error("Invalid Studio authoring container policy");
    return { path: entry.path, className: entry.className };
  });
  for (const group of groups) {
    if (
      !group ||
      typeof group.name !== "string" ||
      !Array.isArray(group.classes) ||
      !["structure_only", "proof_closed_supported_types"].includes(group.propertyMode)
    )
      throw new Error("Invalid Studio capability authoring group");
    for (const className of group.classes) {
      if (
        typeof className !== "string" ||
        seenClasses.has(className) ||
        !classesByName.has(className)
      )
        throw new Error(`Invalid or duplicate policy class: ${String(className)}`);
      seenClasses.add(className);
      assertDirectAuthoringClass(classesByName.get(className));
      const properties = [];
      if (group.propertyMode === "proof_closed_supported_types") {
        for (const member of resolveCatalogProperties(classesByName, className)) {
          const qualifiedName = `${member.declaringClass}.${member.name}`;
          const override = propertyPolicyEntry(overrides, qualifiedName, "property override");
          const exclusion = propertyPolicyEntry(exclusions, qualifiedName, "property exclusion");
          const blocked = directPropertyBlockReason(member);
          if (blocked) {
            if (override || exclusion)
              throw new Error(
                `Policy selects a non-authorable official property: ${qualifiedName} (${blocked})`,
              );
            continue;
          }
          const catalogType = deriveCatalogType(
            member.valueType,
            typeof override?.referenceClass === "string",
            classesByName,
            datatypesByName,
            enumsByName,
          );
          const enumDefinition =
            catalogType.category === "enum" ? enumsByName.get(catalogType.name) : undefined;
          const enumAvailability =
            enumDefinition === undefined ? undefined : sourceCapabilityDisposition(enumDefinition);
          if (enumAvailability?.disposition === "unsupported") {
            if (override || exclusion)
              throw new Error(
                `Policy selects a property with a restricted official enum: ${qualifiedName} (${enumAvailability.reason})`,
              );
            continue;
          }
          const codec = derivePropertyCodec(policy, member, catalogType);
          if (exclusion) {
            propertyExclusionReason(exclusion, qualifiedName);
            if (override)
              throw new Error(`Property cannot be both excluded and overridden: ${qualifiedName}`);
            if (!codec)
              throw new Error(
                `Policy excludes a property with no proof-closed codec: ${qualifiedName}`,
              );
            selectedExclusions.add(qualifiedName);
            continue;
          }
          if (!codec) {
            if (override)
              throw new Error(
                `Policy selects ${qualifiedName} without a proof-closed codec for ${member.valueType}`,
              );
            continue;
          }
          selectedOverrides.add(qualifiedName);
          if ((codec === "enum_name") !== (catalogType.category === "enum"))
            throw new Error(`Policy selects ${qualifiedName} with a codec/type category mismatch`);
          if (codec === "instance_ref" && catalogType.category !== "class")
            throw new Error(
              `Policy selects ${qualifiedName} with a non-class Instance reference type`,
            );
          const bounds = propertyBounds(override ?? {}, codec, defaults);
          const nullable = bounds.nullable === true;
          delete bounds.nullable;
          if (nullable && codec === "instance_ref")
            throw new Error(
              `Policy must use the typed instance-reference nil domain: ${qualifiedName}`,
            );
          if (
            (codec === "string_utf8" || codec === "content") &&
            !Number.isSafeInteger(bounds.maximumUtf8Bytes)
          )
            throw new Error(`Policy selects unbounded text/content property: ${qualifiedName}`);
          if (
            bounds.minimumUtf8Bytes !== undefined &&
            (!Number.isSafeInteger(bounds.minimumUtf8Bytes) || bounds.minimumUtf8Bytes < 0)
          )
            throw new Error(`Policy selects an invalid UTF-8 minimum: ${qualifiedName}`);
          if (bounds.minimumUtf8Bytes !== undefined && !["string_utf8", "content"].includes(codec))
            throw new Error(
              `Policy selects a UTF-8 minimum for non-text property: ${qualifiedName}`,
            );
          if (
            bounds.minimumUtf8Bytes !== undefined &&
            bounds.minimumUtf8Bytes > bounds.maximumUtf8Bytes
          )
            throw new Error(`Policy selects inverted UTF-8 bounds: ${qualifiedName}`);
          if (
            (codec === "number_sequence" || codec === "color_sequence") &&
            !Number.isSafeInteger(bounds.maximumEntries)
          )
            throw new Error(`Policy selects unbounded sequence property: ${qualifiedName}`);
          const referenceClass =
            codec === "instance_ref" ? (bounds.referenceClass ?? catalogType.name) : undefined;
          if (
            codec === "instance_ref" &&
            (typeof referenceClass !== "string" ||
              !isCatalogClassAssignableTo(classesByName, catalogType.name, referenceClass))
          )
            throw new Error(
              `Policy selects invalid or unconstrained Instance reference: ${qualifiedName}`,
            );
          const property = {
            name: member.name,
            codec,
            catalogType,
            reflection: deriveReflectionTypeExpectation(catalogType, codec),
            declaringClass: member.declaringClass,
            ...(catalogType.category === "enum"
              ? {
                  allowed: enumDefinition.items
                    .filter((item) => !item.deprecated)
                    .map((item) => item.name)
                    .sort(),
                }
              : {}),
            ...(member.serialization.canSave ? {} : { serialized: false }),
            nullable,
            ...bounds,
            ...(referenceClass ? { referenceClass } : {}),
            proof: REQUIRED_PROOF,
          };
          properties.push(property);
        }
      }
      outputClasses.push({
        name: className,
        creatable: true,
        source: SCRIPT_CLASSES.has(className) ? "required_on_create_and_writeable" : "forbidden",
        properties,
      });
    }
  }
  for (const name of Object.keys(overrides))
    if (!selectedOverrides.has(name))
      throw new Error(
        `Property policy is not reachable from any proof-closed authoring group: ${name}`,
      );
  for (const name of Object.keys(exclusions))
    if (!selectedExclusions.has(name))
      throw new Error(
        `Property exclusion is not reachable from any proof-closed authoring group: ${name}`,
      );
  return {
    kind: "StudioCapabilityManifest",
    evidenceContractHash,
    roots: [...policy.roots],
    authoringContainers,
    operationKinds: [...policy.operationKinds],
    classes: outputClasses,
    attributes: {
      codecs: ["boolean", "number_f32", "string_utf8"],
      maximumCount: 64,
      maximumNameUtf8Bytes: 100,
      maximumStringUtf8Bytes: 4096,
      reservedPrefix: "_forge",
    },
    // Source authoring and source evidence share the declared project-resource
    // ceiling. Large bodies travel as source-blob leaves, never inside an
    // evidence envelope or a monolithic mutation message.
    source: { maximumUtf8Bytes: 134217728, evidence: "sha256" },
    runtimeCapabilities: [...policy.runtimeCapabilities],
    limits: { ...policy.limits },
  };
}

function directPropertyDefaults(policy) {
  const value = policy.propertyDefaults;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Studio capability policy requires property defaults");
  const expected = ["maximumUtf8Bytes", "maximumEntries", "maximumAbsoluteTranslation"];
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Studio capability property defaults are not closed");
  for (const key of expected)
    if (!Number.isSafeInteger(value[key]) || value[key] < 1)
      throw new Error(`Invalid Studio capability property default: ${key}`);
  return value;
}

function propertyPolicyEntry(entries, qualifiedName, label) {
  const value = entries[qualifiedName];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}: ${qualifiedName}`);
  return value;
}

function propertyExclusionReason(exclusion, qualifiedName) {
  if (
    Object.keys(exclusion).length !== 1 ||
    !Object.hasOwn(exclusion, "reason") ||
    ![
      STRUCTURAL_PROPERTY_REASON,
      "parent_policy_missing",
      "engine_or_external_authority",
      "nondeterministic_behavior",
    ].includes(exclusion.reason)
  )
    throw new Error(`Invalid property exclusion: ${qualifiedName}`);
  return exclusion.reason;
}

function assertDirectAuthoringClass(classDefinition) {
  if (
    !classDefinition ||
    classDefinition.deprecated ||
    classDefinition.tags.includes("Hidden") ||
    classDefinition.tags.includes("NotScriptable") ||
    classDefinition.tags.includes("NotCreatable") ||
    classDefinition.tags.includes("Service")
  )
    throw new Error(
      `Policy selects a class that cannot receive direct authoring: ${classDefinition?.name ?? "unknown"}`,
    );
}

function directPropertyBlockReason(member) {
  if (member.deprecated) return "deprecated";
  if (member.tags.includes("Hidden") || member.tags.includes("NotScriptable")) return "hidden";
  if (
    member.tags.includes("ReadOnly") ||
    member.security?.read !== "None" ||
    member.security?.write !== "None"
  )
    return member.security?.read !== "None" || member.security?.write !== "None"
      ? "security_gated"
      : "read_only";
  if (member.serialization?.canLoad !== true) return "not_serialized";
  return undefined;
}

function derivePropertyCodec(policy, member, catalogType) {
  if (catalogType.category === "enum") return "enum_name";
  if (catalogType.category === "class") return "instance_ref";
  const codec =
    policy.codecByApiType?.[member.valueType] ?? policy.codecByApiType?.[catalogType.name];
  return typeof codec === "string" &&
    (codec in CODEC_REFLECTION_ENGINE_TYPES || codec === "enum_name")
    ? codec
    : undefined;
}

function propertyBounds(override, codec, defaults) {
  const bounds = copyPropertyBounds(override);
  if ((codec === "string_utf8" || codec === "content") && bounds.maximumUtf8Bytes === undefined)
    bounds.maximumUtf8Bytes = defaults.maximumUtf8Bytes;
  if (
    (codec === "number_sequence" || codec === "color_sequence") &&
    bounds.maximumEntries === undefined
  )
    bounds.maximumEntries = defaults.maximumEntries;
  if (codec === "cframe_f32x12" && bounds.maximumAbsoluteTranslation === undefined)
    bounds.maximumAbsoluteTranslation = defaults.maximumAbsoluteTranslation;
  return bounds;
}

function copyPropertyBounds(override) {
  const allowed = [
    "minimum",
    "minimumExclusive",
    "maximum",
    "maximumAbsoluteTranslation",
    "minimumUtf8Bytes",
    "maximumUtf8Bytes",
    "maximumEntries",
    "nullable",
    "referenceClass",
  ];
  const output = {};
  for (const [key, value] of Object.entries(override)) {
    if (!allowed.includes(key)) throw new Error(`Unknown property policy field: ${key}`);
    if (key === "referenceClass") {
      output[key] = value;
      continue;
    }
    if (key === "nullable") {
      if (value !== true) throw new Error("Property nullability must be explicit true");
      output[key] = true;
      continue;
    }
    if (
      !Number.isFinite(value) ||
      ([
        "maximumAbsoluteTranslation",
        "minimumUtf8Bytes",
        "maximumUtf8Bytes",
        "maximumEntries",
      ].includes(key) &&
        value < 0) ||
      (["minimumUtf8Bytes", "maximumUtf8Bytes", "maximumEntries"].includes(key) &&
        !Number.isSafeInteger(value))
    )
      throw new Error(`Invalid property policy bound: ${key}`);
    output[key] = value;
  }
  return output;
}

function normalizeCatalogType(value) {
  return typeof value === "string" ? value.replace(/^Datatype\./, "").replace(/^Enum\./, "") : "";
}
function deriveCatalogType(
  valueType,
  instanceReference,
  classesByName,
  datatypesByName,
  enumsByName,
) {
  if (typeof valueType !== "string" || valueType.length === 0)
    throw new Error("Catalog property has no value type");
  const name = normalizeCatalogType(valueType);
  if (valueType.startsWith("Enum.")) {
    if (!enumsByName.has(name)) throw new Error(`Catalog enum type is absent: ${valueType}`);
    return { category: "enum", name };
  }
  if (valueType.startsWith("Datatype.")) {
    if (!datatypesByName.has(name)) throw new Error(`Catalog datatype is absent: ${valueType}`);
    return { category: "datatype", name };
  }
  // `Datatype.Instance` and class `Instance` deliberately coexist in the
  // official namespace. Only an explicit reference constraint may resolve
  // that collision as an object reference; all other names remain catalog
  // namespace lookups rather than handwritten class lists.
  if (instanceReference) {
    if (!classesByName.has(name)) throw new Error(`Catalog class type is absent: ${valueType}`);
    return { category: "class", name };
  }
  if (enumsByName.has(name) && !datatypesByName.has(name)) return { category: "enum", name };
  if (datatypesByName.has(name)) return { category: "datatype", name };
  if (classesByName.has(name)) return { category: "class", name };
  return { category: "primitive", name };
}
function deriveReflectionTypeExpectation(catalogType, codec) {
  if (catalogType.category === "class") {
    return {
      engineType: "RefType",
      scriptType: "Instance",
      instanceType: catalogType.name,
    };
  }
  if (catalogType.category === "enum") {
    return {
      engineType: "Enum",
      scriptType: "EnumItem",
      enumType: catalogType.name,
    };
  }
  const engineType = CODEC_REFLECTION_ENGINE_TYPES[codec];
  if (typeof engineType !== "string" || engineType.length === 0)
    throw new Error(`No ReflectionService EngineType contract for codec ${codec}`);
  const scriptType =
    catalogType.category === "datatype"
      ? catalogType.name
      : NUMERIC_PRIMITIVE_CATALOG_TYPES.has(catalogType.name)
        ? "number"
        : catalogType.name === "Content"
          ? "string"
          : catalogType.name;
  if (typeof scriptType !== "string" || scriptType.length === 0)
    throw new Error(
      `No ReflectionService ScriptType contract for ${catalogType.category} ${catalogType.name}`,
    );
  return { engineType, scriptType };
}
function resolveCatalogProperty(classesByName, className, propertyName) {
  const visited = new Set();
  for (
    let current = classesByName.get(className);
    current && !visited.has(current.name);
    current = current.superclass ? classesByName.get(current.superclass) : undefined
  ) {
    visited.add(current.name);
    const member = current.members.find(
      (entry) => entry.kind === "property" && entry.name === propertyName,
    );
    if (member) return member;
  }
  return undefined;
}
function resolveCatalogProperties(classesByName, className) {
  const resolved = new Map();
  const visited = new Set();
  for (
    let current = classesByName.get(className);
    current && !visited.has(current.name);
    current = current.superclass ? classesByName.get(current.superclass) : undefined
  ) {
    visited.add(current.name);
    for (const member of current.members)
      if (member.kind === "property" && !resolved.has(member.name))
        resolved.set(member.name, member);
  }
  return [...resolved.values()].sort((left, right) => left.id.localeCompare(right.id));
}
function isCatalogClassAssignableTo(classesByName, actualClass, expectedClass) {
  const visited = new Set();
  for (
    let current = classesByName.get(actualClass);
    current && !visited.has(current.name);
    current = current.superclass ? classesByName.get(current.superclass) : undefined
  ) {
    if (current.name === expectedClass) return true;
    visited.add(current.name);
  }
  return false;
}

function catalogMetadataById(catalog) {
  const entries = new Map();
  const add = (entry) => {
    if (entries.has(entry.id)) throw new Error(`Pinned catalog repeats entry ID: ${entry.id}`);
    entries.set(entry.id, entry);
  };
  for (const classDefinition of catalog.classes) {
    add(classDefinition);
    for (const member of classDefinition.members) add(member);
  }
  for (const datatype of catalog.datatypes) {
    add(datatype);
    for (const member of datatype.members) add(member);
  }
  for (const enumeration of catalog.enums) {
    add(enumeration);
    for (const item of enumeration.items) add(item);
  }
  for (const member of catalog.globalMembers) add(member);
  for (const library of catalog.libraries) {
    add(library);
    for (const member of library.members) add(member);
  }
  return entries;
}

function sourceCapabilityDisposition(entry, sourceReason = "script_api") {
  if (entry.deprecated) return { disposition: "unsupported", reason: "deprecated" };
  if (entry.tags.includes("Hidden") || entry.tags.includes("NotScriptable")) {
    return { disposition: "unsupported", reason: "hidden" };
  }
  const security = Object.values(entry.security ?? {});
  if (security.some((value) => value !== "None")) {
    return { disposition: "unsupported", reason: "security_gated" };
  }
  return { disposition: "source_only", reason: sourceReason };
}

function sourceClassDisposition(classDefinition) {
  const source = sourceCapabilityDisposition(classDefinition);
  if (source.disposition === "unsupported") return source;
  if (classDefinition.tags.includes("Service"))
    return { disposition: "source_only", reason: "service_root" };
  if (classDefinition.tags.includes("NotCreatable"))
    return { disposition: "source_only", reason: "class_not_creatable" };
  return { disposition: "source_only", reason: "script_api" };
}

function sourcePropertyDisposition(
  member,
  authoringGroup,
  policy,
  classesByName,
  datatypesByName,
  enumsByName,
) {
  const source = sourceCapabilityDisposition(member);
  if (source.disposition === "unsupported") return source;
  const directBlock = directPropertyBlockReason(member);
  if (directBlock) return { disposition: "source_only", reason: directBlock };
  if (!authoringGroup) return { disposition: "source_only", reason: "script_api" };
  const qualifiedName = `${member.declaringClass}.${member.name}`;
  const exclusion = propertyPolicyEntry(
    policy.propertyExclusions ?? {},
    qualifiedName,
    "property exclusion",
  );
  if (exclusion)
    return {
      disposition: "source_only",
      reason: propertyExclusionReason(exclusion, qualifiedName),
    };
  const catalogType = deriveCatalogType(
    member.valueType,
    false,
    classesByName,
    datatypesByName,
    enumsByName,
  );
  if (catalogType.category === "enum") {
    const enumAvailability = sourceCapabilityDisposition(enumsByName.get(catalogType.name));
    if (enumAvailability.disposition === "unsupported")
      return { disposition: "source_only", reason: enumAvailability.reason };
  }
  return derivePropertyCodec(policy, member, catalogType)
    ? { disposition: "source_only", reason: "script_api" }
    : { disposition: "source_only", reason: "unsupported_codec" };
}

function deriveCoverageReport(catalog, policy, policyHash, manifest, manifestHash) {
  const classesByName = new Map(catalog.classes.map((entry) => [entry.name, entry]));
  const datatypesByName = new Map(catalog.datatypes.map((entry) => [entry.name, entry]));
  const enumsByName = new Map(catalog.enums.map((entry) => [entry.name, entry]));
  const metadataById = catalogMetadataById(catalog);
  const groupByClass = new Map(
    policy.authoringGroups.flatMap((group) =>
      group.classes.map((className) => [className, group.name]),
    ),
  );
  const authoringGroupByMemberId = new Map();
  for (const group of policy.authoringGroups) {
    if (group.propertyMode !== "proof_closed_supported_types") continue;
    for (const className of group.classes)
      for (const member of resolveCatalogProperties(classesByName, className)) {
        const prior = authoringGroupByMemberId.get(member.id);
        // A base-class property can be applicable to selected classes in
        // several groups. Coverage has one row per official declaration, so
        // retain a stable representative group; the manifest's inheritedBy
        // field records every actual direct applicability.
        if (!prior || group.name.localeCompare(prior) < 0)
          authoringGroupByMemberId.set(member.id, group.name);
      }
  }
  const enabledByMemberId = new Map();
  for (const classDefinition of manifest.classes)
    for (const property of classDefinition.properties) {
      const member = resolveCatalogProperty(classesByName, classDefinition.name, property.name);
      if (!member)
        throw new Error(
          `Generated manifest property is absent from catalog: ${classDefinition.name}.${property.name}`,
        );
      const current = enabledByMemberId.get(member.id) ?? {
        property,
        classes: [],
      };
      current.classes.push(classDefinition.name);
      enabledByMemberId.set(member.id, current);
    }
  const enabledEnums = new Set(
    [...enabledByMemberId.values()]
      .filter((entry) => entry.property.catalogType.category === "enum")
      .map((entry) => entry.property.catalogType.name),
  );
  const entries = [];
  for (const classDefinition of catalog.classes) {
    const group = groupByClass.get(classDefinition.name);
    const classCoverage = group
      ? { disposition: "authorable", reason: "proof_closed" }
      : sourceClassDisposition(classDefinition);
    entries.push({
      catalogEntryId: classDefinition.id,
      entryKind: "class",
      name: classDefinition.name,
      ...classCoverage,
      ...(group ? { authoringGroup: group } : {}),
    });
    for (const member of classDefinition.members) {
      const kind = `class_${member.kind}`;
      if (member.kind === "property" && enabledByMemberId.has(member.id)) {
        const enabled = enabledByMemberId.get(member.id);
        entries.push({
          catalogEntryId: member.id,
          entryKind: kind,
          owner: member.declaringClass,
          name: member.name,
          disposition: "authorable",
          reason: "proof_closed",
          authoringGroup: authoringGroupByMemberId.get(member.id),
          codec: enabled.property.codec,
          inheritedBy: [...enabled.classes].sort(),
        });
      } else {
        const authoringGroup =
          member.kind === "property" ? authoringGroupByMemberId.get(member.id) : undefined;
        entries.push({
          catalogEntryId: member.id,
          entryKind: kind,
          owner: member.declaringClass,
          name: member.name,
          ...(member.kind === "property"
            ? sourcePropertyDisposition(
                member,
                authoringGroup,
                policy,
                classesByName,
                datatypesByName,
                enumsByName,
              )
            : sourceCapabilityDisposition(member)),
          ...(authoringGroup ? { authoringGroup } : {}),
        });
      }
    }
  }
  for (const datatype of catalog.datatypes) {
    const codec =
      policy.codecByApiType[datatype.name] ?? policy.codecByApiType[`Datatype.${datatype.name}`];
    entries.push({
      catalogEntryId: datatype.id,
      entryKind: "datatype",
      name: datatype.name,
      ...(codec
        ? { disposition: "observable_only", reason: "catalog_only", codec }
        : sourceCapabilityDisposition(datatype)),
    });
    for (const member of datatype.members)
      entries.push({
        catalogEntryId: member.id,
        entryKind: `datatype_${member.kind}`,
        owner: datatype.name,
        name: member.name,
        ...sourceCapabilityDisposition(member),
      });
  }
  for (const enumeration of catalog.enums) {
    const enumAvailability = sourceCapabilityDisposition(enumeration);
    const enabled =
      enabledEnums.has(enumeration.name) && enumAvailability.disposition !== "unsupported";
    entries.push({
      catalogEntryId: enumeration.id,
      entryKind: "enum",
      name: enumeration.name,
      ...(enabled
        ? {
            disposition: "authorable",
            reason: "proof_closed",
            codec: "enum_name",
          }
        : enumAvailability),
    });
    for (const item of enumeration.items)
      entries.push({
        catalogEntryId: item.id,
        entryKind: "enum_item",
        owner: enumeration.name,
        name: item.name,
        ...(enabled && !item.deprecated
          ? {
              disposition: "authorable",
              reason: "proof_closed",
              codec: "enum_name",
            }
          : sourceCapabilityDisposition(item)),
      });
  }
  for (const member of catalog.globalMembers) {
    entries.push({
      catalogEntryId: member.id,
      entryKind: `global_${member.kind}`,
      owner: member.declaringScope,
      name: member.name,
      ...sourceCapabilityDisposition(member),
    });
  }
  for (const library of catalog.libraries) {
    entries.push({
      catalogEntryId: library.id,
      entryKind: "library",
      name: library.name,
      ...sourceCapabilityDisposition(library),
    });
    for (const member of library.members)
      entries.push({
        catalogEntryId: member.id,
        entryKind: `library_${member.kind}`,
        owner: library.name,
        name: member.name,
        ...sourceCapabilityDisposition(member),
      });
  }
  entries.sort((left, right) => left.catalogEntryId.localeCompare(right.catalogEntryId));
  const catalogIds = new Set([
    ...catalog.classes.flatMap((entry) => [entry.id, ...entry.members.map((member) => member.id)]),
    ...catalog.datatypes.flatMap((entry) => [
      entry.id,
      ...entry.members.map((member) => member.id),
    ]),
    ...catalog.enums.flatMap((entry) => [entry.id, ...entry.items.map((item) => item.id)]),
    ...catalog.globalMembers.map((entry) => entry.id),
    ...catalog.libraries.flatMap((entry) => [
      entry.id,
      ...entry.members.map((member) => member.id),
    ]),
  ]);
  const coverageIds = new Set(entries.map((entry) => entry.catalogEntryId));
  if (
    coverageIds.size !== entries.length ||
    coverageIds.size !== catalogIds.size ||
    [...catalogIds].some((id) => !coverageIds.has(id)) ||
    [...coverageIds].some((id) => !catalogIds.has(id))
  )
    throw new Error(
      `Catalog coverage must classify the exact pinned catalog ID set; catalog=${catalogIds.size}, coverage=${entries.length}`,
    );
  const coverageById = new Map(entries.map((entry) => [entry.catalogEntryId, entry]));
  for (const classDefinition of manifest.classes)
    for (const property of classDefinition.properties) {
      const member = resolveCatalogProperty(classesByName, classDefinition.name, property.name);
      const coverage = member && coverageById.get(member.id);
      if (
        !coverage ||
        coverage.disposition !== "authorable" ||
        coverage.codec !== property.codec ||
        !coverage.inheritedBy?.includes(classDefinition.name)
      )
        throw new Error(
          `Proof-closed manifest property lacks matching catalog coverage: ${classDefinition.name}.${property.name}`,
        );
    }
  for (const entry of entries) {
    const metadata = metadataById.get(entry.catalogEntryId);
    if (!metadata)
      throw new Error(`Coverage row lacks pinned catalog metadata: ${entry.catalogEntryId}`);
    const platformValid = !["deprecated", "hidden", "security_gated"].includes(
      sourceCapabilityDisposition(metadata).reason,
    );
    if (platformValid && entry.disposition === "unsupported")
      throw new Error(
        `Platform-valid catalog row is not queryable to the planner/builder: ${entry.catalogEntryId}`,
      );
  }
  const byDisposition = {
    authorable: 0,
    observable_only: 0,
    source_only: 0,
    creator_reviewed: 0,
    unsupported: 0,
  };
  const byReason = {};
  for (const entry of entries) {
    byDisposition[entry.disposition] += 1;
    byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
  }
  const report = {
    kind: "StudioCapabilityCoverageReport",
    catalogHash: catalog.contentHash,
    policyHash,
    manifestHash,
    entries,
    summary: {
      total: entries.length,
      byDisposition,
      byReason,
      authorableClasses: manifest.classes.length,
      authorableProperties: [...enabledByMemberId.values()].reduce(
        (total, entry) => total + entry.classes.length,
        0,
      ),
    },
  };
  return { ...report, contentHash: sha256(stableJson(report)) };
}

function canonicalManifest(value) {
  const copy = structuredClone(value);
  copy.roots.sort();
  copy.authoringContainers.sort((left, right) => left.path.localeCompare(right.path));
  copy.operationKinds.sort();
  copy.classes.sort(byName);
  for (const entry of copy.classes) {
    entry.properties.sort(byName);
    for (const property of entry.properties) {
      property.proof.sort((left, right) => proofIndex(left) - proofIndex(right));
      if (property.allowed) property.allowed.sort();
    }
  }
  copy.attributes.codecs.sort();
  copy.runtimeCapabilities.sort(byName);
  return sortObject(copy);
}

function validateManifest(manifest) {
  const requiredProof = [
    "canonicalize",
    "validate",
    "preflight",
    "write",
    "read",
    "project",
    "compare",
  ];
  if (manifest.kind !== "StudioCapabilityManifest")
    throw new Error("Manifest kind must be StudioCapabilityManifest");
  if (!/^[a-f0-9]{64}$/.test(manifest.evidenceContractHash))
    throw new Error("Manifest evidence contract hash is invalid");
  for (const collection of [
    manifest.roots,
    manifest.operationKinds,
    manifest.classes.map((entry) => entry.name),
  ])
    validateSortedUnique(collection, "manifest declaration");
  validateSortedUnique(
    manifest.authoringContainers.map((entry) => entry.path),
    "manifest authoring containers",
  );
  const authoringContainerPaths = new Set();
  for (const entry of manifest.authoringContainers) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.className !== "string" ||
      entry.path.length === 0 ||
      entry.className.length === 0
    )
      throw new Error("Invalid manifest authoring container");
    const pieces = entry.path.split("/");
    if (
      pieces.some((piece) => piece.length === 0 || piece === "." || piece === "..") ||
      !manifest.roots.includes(pieces[0]) ||
      pieces.at(-1) !== entry.className
    )
      throw new Error(`Invalid manifest authoring container path or class: ${entry.path}`);
    if (pieces.length > 1 && !authoringContainerPaths.has(pieces.slice(0, -1).join("/")))
      throw new Error(`Manifest authoring container parent is undeclared: ${entry.path}`);
    authoringContainerPaths.add(entry.path);
  }
  if (manifest.roots.some((root) => !authoringContainerPaths.has(root)))
    throw new Error("Every authoring root must have an engine-owned container declaration");
  const classNames = new Set();
  for (const entry of manifest.classes) {
    if (
      !entry.creatable ||
      classNames.has(entry.name) ||
      !["forbidden", "required_on_create_and_writeable"].includes(entry.source)
    )
      throw new Error(`Invalid class capability: ${entry.name}`);
    classNames.add(entry.name);
    validateSortedUnique(
      entry.properties.map((property) => property.name),
      `properties for ${entry.name}`,
    );
    for (const property of entry.properties) {
      if (
        !property.name ||
        ![
          "boolean",
          "number_f32",
          "number_f64",
          "int32",
          "int64_decimal",
          "string_utf8",
          "content",
          "color3_rgb8",
          "vector2_f32",
          "vector3_f32",
          "cframe_f32x12",
          "udim",
          "udim2",
          "rect",
          "number_range",
          "number_sequence",
          "color_sequence",
          "brick_color",
          "font",
          "physical_properties",
          "axes",
          "faces",
          "ray",
          "instance_ref",
          "enum_name",
        ].includes(property.codec) ||
        !property.catalogType ||
        !["primitive", "datatype", "enum", "class"].includes(property.catalogType.category) ||
        typeof property.catalogType.name !== "string" ||
        property.catalogType.name.length === 0 ||
        typeof property.declaringClass !== "string" ||
        property.declaringClass.length === 0
      )
        throw new Error(`Invalid property declaration: ${entry.name}.${property.name}`);
      if ((property.codec === "enum_name") !== (property.catalogType.category === "enum"))
        throw new Error(`Invalid enum type declaration: ${entry.name}.${property.name}`);
      const derivedReflection = deriveReflectionTypeExpectation(
        property.catalogType,
        property.codec,
      );
      if (stableJson(property.reflection) !== stableJson(derivedReflection))
        throw new Error(`Invalid reflection type declaration: ${entry.name}.${property.name}`);
      if (property.serialized !== undefined && typeof property.serialized !== "boolean")
        throw new Error(`Invalid serialization expectation: ${entry.name}.${property.name}`);
      if (typeof property.nullable !== "boolean")
        throw new Error(`Invalid nullability expectation: ${entry.name}.${property.name}`);
      if (property.nullable === true && property.codec === "instance_ref")
        throw new Error(`Instance reference uses typed nil: ${entry.name}.${property.name}`);
      if (
        property.proof.length !== requiredProof.length ||
        requiredProof.some((stage, index) => property.proof[index] !== stage)
      )
        throw new Error(
          `Writable capability lacks closed proof route: ${entry.name}.${property.name}`,
        );
      if (
        property.codec === "enum_name" &&
        (!Array.isArray(property.allowed) || property.allowed.length === 0)
      )
        throw new Error(
          `Enum capability lacks a closed enum route: ${entry.name}.${property.name}`,
        );
      for (const key of [
        "minimum",
        "minimumExclusive",
        "maximum",
        "maximumAbsoluteTranslation",
        "minimumUtf8Bytes",
        "maximumUtf8Bytes",
        "maximumEntries",
      ])
        if (
          property[key] !== undefined &&
          (!Number.isFinite(property[key]) ||
            ([
              "maximumAbsoluteTranslation",
              "minimumUtf8Bytes",
              "maximumUtf8Bytes",
              "maximumEntries",
            ].includes(key) &&
              property[key] < 0) ||
            (["minimumUtf8Bytes", "maximumUtf8Bytes", "maximumEntries"].includes(key) &&
              !Number.isSafeInteger(property[key])))
        )
          throw new Error(`Invalid bound: ${entry.name}.${property.name}.${key}`);
      if (
        property.minimumUtf8Bytes !== undefined &&
        !["string_utf8", "content"].includes(property.codec)
      )
        throw new Error(`Invalid UTF-8 minimum codec: ${entry.name}.${property.name}`);
      if (
        property.minimumUtf8Bytes !== undefined &&
        property.maximumUtf8Bytes !== undefined &&
        property.minimumUtf8Bytes > property.maximumUtf8Bytes
      )
        throw new Error(`Inverted UTF-8 bounds: ${entry.name}.${property.name}`);
      if (
        property.codec === "instance_ref" &&
        (typeof property.referenceClass !== "string" || property.referenceClass.length === 0)
      )
        throw new Error(
          `Instance reference capability lacks its class constraint: ${entry.name}.${property.name}`,
        );
    }
  }
  validateSortedUnique(manifest.attributes.codecs, "attribute codecs");
  validateSortedUnique(
    manifest.runtimeCapabilities.map((capability) => capability.name),
    "runtime capabilities",
  );
  for (const capability of manifest.runtimeCapabilities) {
    if (
      !Object.hasOwn(
        {
          "instance.resolve": true,
          "base_part.position": true,
          "base_part.position_series": true,
          "instance.property": true,
          "instance.property_series": true,
        },
        capability.name,
      )
    )
      throw new Error(`Runtime capability has no generated dispatch: ${capability.name}`);
    if (
      (capability.name === "base_part.position_series" ||
        capability.name === "instance.property_series") &&
      (!Number.isSafeInteger(capability.maximumSamples) ||
        capability.maximumSamples < 1 ||
        !Number.isSafeInteger(capability.minimumIntervalMs) ||
        capability.minimumIntervalMs < 1 ||
        !Number.isSafeInteger(capability.maximumIntervalMs) ||
        capability.maximumIntervalMs < capability.minimumIntervalMs)
    )
      throw new Error("Invalid generated runtime series bounds");
  }
  for (const [name, value] of Object.entries(manifest.limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Invalid manifest limit: ${name}`);
}

function renderTypeScript(manifest, hash, connectorBuildHash, coverageReport) {
  const writable = manifest.classes.map((entry) => entry.name);
  const scripts = manifest.classes
    .filter((entry) => entry.source !== "forbidden")
    .map((entry) => entry.name);
  const resolvable = [
    ...new Set(["BasePart", ...manifest.classes.map((entry) => entry.name)]),
  ].sort();
  const vectors = canonicalVectors();
  const projectIndexVectors = projectIndexCanonicalVectors();
  const authorityVectors = projectIdentityAuthorityVectorTable();
  const projectIdentityAuthorityVectors = authorityVectors;
  const creatorMutationBindingSchema = JSON.stringify(CREATOR_MUTATION_BINDING_SCHEMA);
  return `/* This file is generated by scripts/generate-studio-evidence.mjs. Do not edit. */\nimport type { StudioCapabilityCoverageReport } from "./catalog.js";\n\nexport const STUDIO_CAPABILITY_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;\n\nexport const STUDIO_CAPABILITY_MANIFEST_HASH = ${JSON.stringify(hash)};\nexport const STUDIO_CONNECTOR_BUILD_HASH = ${JSON.stringify(connectorBuildHash)};\nexport const STUDIO_CAPABILITY_COVERAGE_REPORT: StudioCapabilityCoverageReport = JSON.parse(${JSON.stringify(JSON.stringify(coverageReport))}) as StudioCapabilityCoverageReport;\nexport const STUDIO_CAPABILITY_COVERAGE_REPORT_HASH = ${JSON.stringify(coverageReport.contentHash)};\nexport const STUDIO_AUTHORING_ROOTS = ${JSON.stringify(manifest.roots)} as const;\nexport const STUDIO_AUTHORING_CONTAINERS = ${JSON.stringify(manifest.authoringContainers)} as const;\nexport const STUDIO_WRITABLE_CLASSES = ${JSON.stringify(writable)} as const;\nexport const STUDIO_SCRIPT_CLASSES = ${JSON.stringify(scripts)} as const;\nexport const STUDIO_RESOLVABLE_CLASSES = ${JSON.stringify(resolvable)} as const;\n\n/** The closed binding carried by creator mutation projections and change-set evidence. */\nexport const STUDIO_CREATOR_MUTATION_BINDING_SCHEMA = ${creatorMutationBindingSchema} as const;\nexport type StudioCreatorMutationBinding = Readonly<{ [Field in typeof STUDIO_CREATOR_MUTATION_BINDING_SCHEMA[number]["name"]]: string }> ;\nexport function isStudioCreatorMutationBinding(value: unknown): value is StudioCreatorMutationBinding {\n  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;\n  const binding = value as Record<string, unknown>;\n  if (Object.keys(binding).length !== STUDIO_CREATOR_MUTATION_BINDING_SCHEMA.length) return false;\n  return STUDIO_CREATOR_MUTATION_BINDING_SCHEMA.every(({ name, kind }) =>\n    Object.hasOwn(binding, name) && typeof binding[name] === "string" && binding[name].length > 0 &&\n      (kind === "non_empty" || /^[0-9a-f]{64}$/.test(binding[name])),\n  );\n}\n/** Pure equality over two valid closed creator-mutation bindings. */\nexport function matchesStudioCreatorMutationBinding(binding: unknown, expected: unknown): boolean {\n  if (!isStudioCreatorMutationBinding(binding) || !isStudioCreatorMutationBinding(expected)) return false;\n  return STUDIO_CREATOR_MUTATION_BINDING_SCHEMA.every(({ name }) => binding[name] === expected[name]);\n}\n\n/** One generated recipe for local pairing, Link/Fork, and publication authority. */\nexport const PROJECT_IDENTITY_AUTHORITY_RECIPE = ${typescriptLiteral(PROJECT_IDENTITY_AUTHORITY_RECIPE)} as const;\nexport const PROJECT_IDENTITY_AUTHORITY_VECTORS = ${typescriptLiteral(projectIdentityAuthorityVectors)} as const;\n\nexport const STUDIO_EVIDENCE_VECTORS = ${typescriptLiteral(vectors)} as const;\nexport const STUDIO_PROJECT_INDEX_CANONICAL_VECTORS = ${typescriptLiteral(projectIndexVectors)} as const;\n`;
}

function renderLuau(manifest, hash, connectorBuildHash) {
  const vectorLines = canonicalVectors()
    .map((vector) => `\t${luaTable(vector)},`)
    .join("\n");
  const projectIndexVectorLines = projectIndexCanonicalVectors()
    .map((vector) => `\t${luaTable(vector)},`)
    .join("\n");
  const creatorMutationBindingSchemaLines = CREATOR_MUTATION_BINDING_SCHEMA.map(
    ({ name, kind }) => `\t{ name = ${lua(name)}, kind = ${lua(kind)} },`,
  ).join("\n");
  return `--!strict
-- Generated from packages/studio-evidence/manifest/studio-capability-manifest.json.
-- This is Forge's sole Studio authoring/readback/reflection capability table.
-- Facts accepted by factMaterial are ordinary tables whose fields are limited to
-- strings, booleans, finite numbers, canonical Studio values, and sequences.
local Generated = {}
Generated.manifestHash = ${lua(hash)}
Generated.connectorBuildHash = ${lua(connectorBuildHash)}
Generated.manifest = ${luaTable(manifest)}
-- All dispatch maps below are derived from the one generated manifest table;
-- they are indexes, not a second handwritten or generated capability list.
Generated.authoringRoots = Generated.manifest.roots
Generated.authoringContainers = {}
for _, container in ipairs(Generated.manifest.authoringContainers) do Generated.authoringContainers[container.path] = container.className end
Generated.writableClasses = {}
Generated.scriptClasses = {}
Generated.resolvableClasses = { "BasePart" }
Generated.classes = {}
Generated.codecs = {}
for _, class in ipairs(Generated.manifest.classes) do
	local properties = {}
	local propertyList = {}
	for _, property in ipairs(class.properties) do
		properties[property.name] = property
		table.insert(propertyList, property)
		Generated.codecs[property.codec] = true
	end
	table.sort(propertyList, function(left, right) return left.name < right.name end)
	Generated.classes[class.name] = { creatable = class.creatable, source = class.source, properties = properties, propertyList = propertyList }
	table.insert(Generated.writableClasses, class.name)
	if class.source ~= "forbidden" then table.insert(Generated.scriptClasses, class.name) end
	table.insert(Generated.resolvableClasses, class.name)
end
table.sort(Generated.writableClasses)
table.sort(Generated.scriptClasses)
table.sort(Generated.resolvableClasses)
Generated.runtimeCapabilities = {}
for _, capability in ipairs(Generated.manifest.runtimeCapabilities) do Generated.runtimeCapabilities[capability.name] = capability end
Generated.vectors = {
${vectorLines}
}
Generated.projectIndexVectors = {
${projectIndexVectorLines}
}
Generated.creatorMutationBindingSchema = {
${creatorMutationBindingSchemaLines}
}

local function finite(value: any): boolean
	return typeof(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end
-- Keep value canonicalization usable in the Luau CLI module tests. Roblox's
-- script tree is touched only when a SHA-256 identity is actually needed.
local function sha256(value: string): string
	local Hash = if script ~= nil then require(script.Parent.Hash) else require("./Hash")
	return Hash.sha256(value)
end
local function validUtf8(value: any): boolean
	if typeof(value) ~= "string" then return false end
	local ok, length = pcall(function() return utf8.len(value) end)
	return ok and length ~= nil
end
local function exactKeys(value: any, expected: {string})
	if typeof(value) ~= "table" then error("expected table") end
	local count = 0
	for key in pairs(value) do
		if typeof(key) ~= "string" then error("unexpected non-string field") end
		count += 1
		local found = false
		for _, name in ipairs(expected) do if key == name then found = true; break end end
		if not found then error("unexpected field " .. key) end
	end
	if count ~= #expected then error("missing field") end
end
local function sequence(value: any, label: string)
	if typeof(value) ~= "table" then error(label .. " must be a sequence") end
	for key in pairs(value) do if typeof(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > #value then error(label .. " has an unexpected field") end end
end
local function f32(value: number): number
	if not finite(value) then error("non-finite float32") end
	local packed = string.pack(">f", value)
	local result: any = string.unpack(">f", packed)
	if not finite(result) then error("float32 overflow") end
	return result :: number
end
local function hex(bytes: string): string
	local result = {} :: {string}
	for index = 1, #bytes do table.insert(result, string.format("%02x", string.byte(bytes, index))) end
	return table.concat(result)
end
local function tagged(tag: string, payload: string): string
	return tostring(#tag) .. ":" .. tag .. tostring(#payload) .. ":" .. payload
end
local function taggedSequence(parts: {string}): string
	local payload = tagged("count", tostring(#parts))
	for _, part in ipairs(parts) do payload ..= part end
	return tagged("sequence", payload)
end
local function valueKind(value: any): string
	if typeof(value) ~= "table" or typeof(value.kind) ~= "string" then error("Studio value requires a kind") end
	return value.kind
end

function Generated.isAllowedRoot(path: any): boolean
	if typeof(path) ~= "string" then return false end
	for _, root in ipairs(Generated.authoringRoots) do if path == root or string.sub(path, 1, #root + 1) == root .. "/" then return true end end
	return false
end
function Generated.authoringContainerClass(path: any): string?
	if typeof(path) ~= "string" then return nil end
	return Generated.authoringContainers[path]
end
function Generated.classMetadata(className: any): any
	if typeof(className) ~= "string" then return nil end
	return Generated.classes[className]
end
function Generated.propertyMetadata(className: any, propertyName: any): any
	local class = Generated.classMetadata(className)
	if class == nil or typeof(propertyName) ~= "string" then return nil end
	return class.properties[propertyName]
end
-- Mutation writes must not inherit Luau hash-table iteration order. This
-- generated function validates the requested map against the manifest and
-- returns its names in the one canonical (UTF-8 byte) order used by
-- projection compilation and evidence materialization.
function Generated.sortedMutationPropertyNames(className: any, properties: any): {string}
	local class = Generated.classMetadata(className)
	if class == nil or typeof(properties) ~= "table" then error("invalid mutation properties") end
	local names = {} :: {string}
	for name in pairs(properties) do
		if typeof(name) ~= "string" or class.properties[name] == nil then error("mutation property outside manifest") end
		table.insert(names, name)
	end
	table.sort(names)
	return names
end
-- Project indexing needs the canonical ordered manifest rows, whereas
-- mutation validation needs name lookup. Keep those two generated interfaces
-- explicit so a keyed dispatch map can never be consumed as a sequence.
function Generated.projectPropertyMetadata(className: any): {any}
	local class = Generated.classMetadata(className)
	if class == nil then return {} end
	return class.propertyList
end
function Generated.runtimeCapabilityMetadata(name: any): any
	if typeof(name) ~= "string" then return nil end
	return Generated.runtimeCapabilities[name]
end
-- The trusted Play Server observer dispatches on a manifest result domain,
-- never on a second handwritten capability-name list. Handlers receive the
-- exact generated metadata and opaque observer context.
function Generated.runtimeDispatch(capability: any, handlers: any, context: any): any
	local metadata = Generated.runtimeCapabilityMetadata(capability)
	if metadata == nil or typeof(handlers) ~= "table" then error("runtime capability outside manifest") end
	local handler = handlers[metadata.result]
	if typeof(handler) ~= "function" then error("runtime result handler outside manifest") end
	return handler(metadata, context)
end
local function rgb(value: any, label: string): any
	if typeof(value) ~= "table" then error(label) end
	exactKeys(value, { "r", "g", "b" })
	for _, channel in ipairs({ value.r, value.g, value.b }) do if typeof(channel) ~= "number" or channel % 1 ~= 0 or channel < 0 or channel > 255 then error(label) end end
	return { r = value.r, g = value.g, b = value.b }
end
local function vector2(value: any, label: string): any
	if typeof(value) ~= "table" then error(label) end
	exactKeys(value, { "x", "y" }); return { x = f32(value.x), y = f32(value.y) }
end
local function vector3(value: any, label: string): any
	if typeof(value) ~= "table" then error(label) end
	exactKeys(value, { "x", "y", "z" }); return { x = f32(value.x), y = f32(value.y), z = f32(value.z) }
end
local function udim(value: any, label: string): any
	if typeof(value) ~= "table" then error(label) end
	exactKeys(value, { "scale", "offset" })
	if typeof(value.offset) ~= "number" or value.offset % 1 ~= 0 or value.offset < -2147483648 or value.offset > 2147483647 then error(label) end
	return { scale = f32(value.scale), offset = value.offset }
end
local function int64Decimal(value: any): string
	if typeof(value) ~= "string" or not string.match(value, "^-?%d+$") or value == "-0" or string.match(value, "^-?0%d") then error("invalid int64 decimal") end
	local negative = string.sub(value, 1, 1) == "-"; local digits = negative and string.sub(value, 2) or value
	if #digits > 16 or #digits == 16 and digits > "9007199254740991" then error("int64 decimal is not exactly representable by Luau") end
	return value
end
-- Identity strings are a cross-language wire domain, not arbitrary Lua
-- strings. Keep the byte limit, UTF-8 validity, and Unicode whitespace rule
-- identical to TypeScript's assertStudioObjectIdentity.
local function studioIdentityText(value: any): boolean
	if typeof(value) ~= "string" or #value == 0 or #value > 512 or not validUtf8(value) then return false end
	for _, codepoint in utf8.codes(value) do
		if codepoint == 0x0009 or (codepoint >= 0x000A and codepoint <= 0x000D) or codepoint == 0x0020
			or codepoint == 0x0085 or codepoint == 0x00A0 or codepoint == 0x1680
			or (codepoint >= 0x2000 and codepoint <= 0x200A) or codepoint == 0x2028 or codepoint == 0x2029
			or codepoint == 0x202F or codepoint == 0x205F or codepoint == 0x3000 or codepoint == 0xFEFF
		then return false end
	end
	return true
end
function Generated.studioObjectIdentity(value: any): any
	if typeof(value) ~= "table" or typeof(value.kind) ~= "string" then error("invalid Studio object identity") end
	if value.kind == "forge_attribute" then exactKeys(value, { "kind", "stableId" }); if not studioIdentityText(value.stableId) then error("invalid Forge object identity") end; return { kind = value.kind, stableId = value.stableId } end
	if value.kind == "studio_ephemeral" then exactKeys(value, { "kind", "connectorEpoch", "opaqueHash" }); if not studioIdentityText(value.connectorEpoch) or typeof(value.opaqueHash) ~= "string" or not string.match(value.opaqueHash, "^[a-f0-9]+$") or #value.opaqueHash ~= 64 then error("invalid ephemeral object identity") end; return { kind = value.kind, connectorEpoch = value.connectorEpoch, opaqueHash = value.opaqueHash } end
	if value.kind == "rojo_sourcemap" then exactKeys(value, { "kind", "authorityMapHash", "sourcemapHash", "mappingId" }); if typeof(value.authorityMapHash) ~= "string" or not string.match(value.authorityMapHash, "^[a-f0-9]+$") or #value.authorityMapHash ~= 64 or typeof(value.sourcemapHash) ~= "string" or not string.match(value.sourcemapHash, "^[a-f0-9]+$") or #value.sourcemapHash ~= 64 or not studioIdentityText(value.mappingId) then error("invalid Rojo object identity") end; return { kind = value.kind, authorityMapHash = value.authorityMapHash, sourcemapHash = value.sourcemapHash, mappingId = value.mappingId } end
	error("invalid Studio object identity")
end
local function studioObjectIdentityKey(value: any): string
	local identity = Generated.studioObjectIdentity(value)
	if identity.kind == "forge_attribute" then return "forge_attribute:" .. identity.stableId end
	if identity.kind == "studio_ephemeral" then return "studio_ephemeral:" .. identity.connectorEpoch .. ":" .. identity.opaqueHash end
	return "rojo_sourcemap:" .. identity.authorityMapHash .. ":" .. identity.sourcemapHash .. ":" .. identity.mappingId
end
local function valueNumbers(value: any): {number}
	if value.kind == "number_f32" or value.kind == "number_f64" or value.kind == "int32" then return { value.value } end
	if value.kind == "vector2_f32" then return { value.x, value.y } end
	if value.kind == "vector3_f32" then return { value.x, value.y, value.z } end
	if value.kind == "cframe_f32x12" then return value.components end
	if value.kind == "udim" then return { value.scale, value.offset } end
	if value.kind == "udim2" then return { value.x.scale, value.x.offset, value.y.scale, value.y.offset } end
	if value.kind == "rect" then return { value.minX, value.minY, value.maxX, value.maxY } end
	if value.kind == "number_range" then return { value.min, value.max } end
	if value.kind == "number_sequence" then local result = {}; for _, item in ipairs(value.keypoints) do table.insert(result, item.time); table.insert(result, item.value); table.insert(result, item.envelope) end; return result end
	if value.kind == "color_sequence" then local result = {}; for _, item in ipairs(value.keypoints) do table.insert(result, item.time); table.insert(result, item.color.r); table.insert(result, item.color.g); table.insert(result, item.color.b) end; return result end
	if value.kind == "physical_properties" then return { value.density, value.friction, value.elasticity, value.frictionWeight, value.elasticityWeight } end
	if value.kind == "ray" then return { value.origin.x, value.origin.y, value.origin.z, value.direction.x, value.direction.y, value.direction.z } end
	return {}
end
local function keypoints(value: any, kind: string, maximumEntries: any): any
	sequence(value, kind .. " keypoints"); if #value < 2 or maximumEntries ~= nil and #value > maximumEntries then error(kind .. " keypoint bound") end
	local previous = -1; local output = {}
	for index, raw in ipairs(value) do
		if typeof(raw) ~= "table" then error(kind .. " keypoint") end
		if kind == "number_sequence" then
			exactKeys(raw, { "time", "value", "envelope" }); local time, itemValue, envelope = f32(raw.time), f32(raw.value), f32(raw.envelope)
			if time < 0 or time > 1 or time <= previous or envelope < 0 then error(kind .. " keypoint") end
			output[index] = { time = time, value = itemValue, envelope = envelope }
		else
			exactKeys(raw, { "time", "color" }); local time = f32(raw.time); if time < 0 or time > 1 or time <= previous then error(kind .. " keypoint") end
			output[index] = { time = time, color = rgb(raw.color, kind .. " color") }
		end
		previous = output[index].time
	end
	if output[1].time ~= 0 or output[#output].time ~= 1 then error(kind .. " endpoints") end
	return output
end
function Generated.canonicalValue(value: any, property: any?): any
	local kind = valueKind(value)
	if kind == "nil" then
		exactKeys(value, { "kind", "expectedCodec" })
		if typeof(value.expectedCodec) ~= "string" or value.expectedCodec == "instance_ref" or Generated.codecs[value.expectedCodec] ~= true then error("invalid nil Studio value codec") end
		if property ~= nil and (property.nullable ~= true or value.expectedCodec ~= property.codec) then error("nil Studio value is not declared for property") end
		return { kind = kind, expectedCodec = value.expectedCodec }
	end
	if kind == "boolean" then exactKeys(value, { "kind", "value" }); if typeof(value.value) ~= "boolean" then error("invalid boolean") end; return { kind = kind, value = value.value } end
	if kind == "number_f32" then exactKeys(value, { "kind", "value" }); return { kind = kind, value = f32(value.value) } end
	if kind == "number_f64" then exactKeys(value, { "kind", "value" }); if not finite(value.value) then error("invalid float64") end; return { kind = kind, value = value.value } end
	if kind == "int32" then exactKeys(value, { "kind", "value" }); if typeof(value.value) ~= "number" or value.value % 1 ~= 0 or value.value < -2147483648 or value.value > 2147483647 then error("invalid int32") end; return { kind = kind, value = value.value } end
	if kind == "int64_decimal" then exactKeys(value, { "kind", "value" }); return { kind = kind, value = int64Decimal(value.value) } end
	if kind == "string_utf8" or kind == "content" then exactKeys(value, { "kind", "value" }); if not validUtf8(value.value) or kind == "content" and value.value == "" then error("invalid UTF-8") end; if property and ((property.minimumUtf8Bytes and #value.value < property.minimumUtf8Bytes) or (property.maximumUtf8Bytes and #value.value > property.maximumUtf8Bytes)) then error("string bound") end; return { kind = kind, value = value.value } end
	if kind == "color3_rgb8" then exactKeys(value, { "kind", "r", "g", "b" }); local color = rgb({ r = value.r, g = value.g, b = value.b }, "invalid RGB8"); return { kind = kind, r = color.r, g = color.g, b = color.b } end
	if kind == "vector2_f32" then exactKeys(value, { "kind", "x", "y" }); local vector = vector2({ x = value.x, y = value.y }, "invalid Vector2"); return { kind = kind, x = vector.x, y = vector.y } end
	if kind == "vector3_f32" then exactKeys(value, { "kind", "x", "y", "z" }); local vector = vector3({ x = value.x, y = value.y, z = value.z }, "invalid Vector3"); return { kind = kind, x = vector.x, y = vector.y, z = vector.z } end
	if kind == "cframe_f32x12" then exactKeys(value, { "kind", "components" }); sequence(value.components, "CFrame components"); if #value.components ~= 12 then error("CFrame requires 12 components") end; local components = {}; for index, component in ipairs(value.components) do components[index] = f32(component) end; if property and property.maximumAbsoluteTranslation then for index = 1, 3 do if math.abs(components[index]) > property.maximumAbsoluteTranslation then error("CFrame translation bound") end end end; return { kind = kind, components = components } end
	if kind == "udim" then exactKeys(value, { "kind", "scale", "offset" }); local item = udim({ scale = value.scale, offset = value.offset }, "invalid UDim"); return { kind = kind, scale = item.scale, offset = item.offset } end
	if kind == "udim2" then exactKeys(value, { "kind", "x", "y" }); return { kind = kind, x = udim(value.x, "invalid UDim2 x"), y = udim(value.y, "invalid UDim2 y") } end
	if kind == "rect" then exactKeys(value, { "kind", "minX", "minY", "maxX", "maxY" }); local minX, minY, maxX, maxY = f32(value.minX), f32(value.minY), f32(value.maxX), f32(value.maxY); if minX > maxX or minY > maxY then error("invalid Rect") end; return { kind = kind, minX = minX, minY = minY, maxX = maxX, maxY = maxY } end
	if kind == "number_range" then exactKeys(value, { "kind", "min", "max" }); local min, max = f32(value.min), f32(value.max); if min > max then error("invalid NumberRange") end; return { kind = kind, min = min, max = max } end
	if kind == "number_sequence" or kind == "color_sequence" then exactKeys(value, { "kind", "keypoints" }); return { kind = kind, keypoints = keypoints(value.keypoints, kind, property and property.maximumEntries) } end
	if kind == "brick_color" then exactKeys(value, { "kind", "name" }); if not validUtf8(value.name) or value.name == "" then error("invalid BrickColor") end; if property and property.allowed then local found = false; for _, name in ipairs(property.allowed) do if name == value.name then found = true end end; if not found then error("BrickColor not allowlisted") end end; return { kind = kind, name = value.name } end
	if kind == "font" then exactKeys(value, { "kind", "family", "weight", "style" }); for _, item in ipairs({ value.family, value.weight, value.style }) do if not validUtf8(item) or item == "" then error("invalid Font") end end; return { kind = kind, family = value.family, weight = value.weight, style = value.style } end
	if kind == "physical_properties" then exactKeys(value, { "kind", "density", "friction", "elasticity", "frictionWeight", "elasticityWeight" }); local density, friction, elasticity, frictionWeight, elasticityWeight = f32(value.density), f32(value.friction), f32(value.elasticity), f32(value.frictionWeight), f32(value.elasticityWeight); if density <= 0 or friction < 0 or friction > 1 or elasticity < 0 or elasticity > 1 or frictionWeight < 0 or frictionWeight > 1 or elasticityWeight < 0 or elasticityWeight > 1 then error("invalid PhysicalProperties") end; return { kind = kind, density = density, friction = friction, elasticity = elasticity, frictionWeight = frictionWeight, elasticityWeight = elasticityWeight } end
	if kind == "axes" then exactKeys(value, { "kind", "x", "y", "z" }); for _, item in ipairs({ value.x, value.y, value.z }) do if typeof(item) ~= "boolean" then error("invalid Axes") end end; return { kind = kind, x = value.x, y = value.y, z = value.z } end
	if kind == "faces" then exactKeys(value, { "kind", "top", "bottom", "left", "right", "front", "back" }); for _, item in ipairs({ value.top, value.bottom, value.left, value.right, value.front, value.back }) do if typeof(item) ~= "boolean" then error("invalid Faces") end end; return { kind = kind, top = value.top, bottom = value.bottom, left = value.left, right = value.right, front = value.front, back = value.back } end
	if kind == "ray" then exactKeys(value, { "kind", "origin", "direction" }); return { kind = kind, origin = vector3(value.origin, "invalid Ray origin"), direction = vector3(value.direction, "invalid Ray direction") } end
	if kind == "instance_ref" then
		if value.state == "nil" then exactKeys(value, { "kind", "state", "expectedClass" }); if not validUtf8(value.expectedClass) or value.expectedClass == "" or property and property.referenceClass ~= value.expectedClass then error("nil Instance reference class constraint") end; return { kind = kind, state = "nil", expectedClass = value.expectedClass } end
		exactKeys(value, { "kind", "state", "identity", "path", "className", "expectedClass" }); if value.state ~= "reference" then error("invalid Instance reference state") end; for _, item in ipairs({ value.path, value.className, value.expectedClass }) do if typeof(item) ~= "string" or item == "" or not validUtf8(item) then error("invalid Instance reference") end end; local identity = Generated.studioObjectIdentity(value.identity); if string.sub(value.path, 1, 1) == "/" or string.sub(value.path, -1) == "/" or string.find(value.path, "\\\\", 1, true) then error("invalid Instance reference path") end; for _, part in ipairs(string.split(value.path, "/")) do if part == "" or part == "." or part == ".." then error("invalid Instance reference path") end end; if property and property.referenceClass ~= value.expectedClass then error("Instance reference class constraint") end; return { kind = kind, state = "reference", identity = identity, path = value.path, className = value.className, expectedClass = value.expectedClass } end
	if kind == "enum_name" then exactKeys(value, { "kind", "value" }); if not validUtf8(value.value) or value.value == "" then error("invalid enum") end; if property and property.allowed then local allowed = false; for _, name in ipairs(property.allowed) do if name == value.value then allowed = true end end; if not allowed then error("enum not allowlisted") end end; return { kind = kind, value = value.value } end
	error("unknown Studio value codec")
end
function Generated.validateValue(codec: any, value: any, property: any?): any
	local canonical = Generated.canonicalValue(value, property)
	if canonical.kind == "nil" then
		if property == nil or property.nullable ~= true or canonical.expectedCodec ~= codec then error("nil Studio value is not declared for property") end
		return canonical
	end
	if canonical.kind ~= codec then error("Studio value codec mismatch") end
	if property then for _, number in ipairs(valueNumbers(canonical)) do if property.minimum ~= nil and number < property.minimum then error("number minimum") end; if property.minimumExclusive ~= nil and number <= property.minimumExclusive then error("number exclusive minimum") end; if property.maximum ~= nil and number > property.maximum then error("number maximum") end end end
	return canonical
end
function Generated.toStudio(codec: any, value: any, property: any?, referenceResolver: any?): any
	local canonical = Generated.validateValue(codec, value, property)
	if canonical.kind == "nil" then return nil end
	if codec == "boolean" or codec == "number_f32" or codec == "number_f64" or codec == "int32" or codec == "string_utf8" or codec == "content" then return canonical.value end
	if codec == "int64_decimal" then local number = tonumber(canonical.value); if number == nil or number % 1 ~= 0 or math.abs(number) > 9007199254740991 then error("int64 is not exactly representable by Luau") end; return number end
	if codec == "color3_rgb8" then return Color3.fromRGB(canonical.r, canonical.g, canonical.b) end
	if codec == "vector2_f32" then return Vector2.new(canonical.x, canonical.y) end
	if codec == "vector3_f32" then return Vector3.new(canonical.x, canonical.y, canonical.z) end
	if codec == "cframe_f32x12" then return CFrame.new(table.unpack(canonical.components)) end
	if codec == "udim" then return UDim.new(canonical.scale, canonical.offset) end
	if codec == "udim2" then return UDim2.new(canonical.x.scale, canonical.x.offset, canonical.y.scale, canonical.y.offset) end
	if codec == "rect" then return Rect.new(canonical.minX, canonical.minY, canonical.maxX, canonical.maxY) end
	if codec == "number_range" then return NumberRange.new(canonical.min, canonical.max) end
	if codec == "number_sequence" then local points = {}; for index, item in ipairs(canonical.keypoints) do points[index] = NumberSequenceKeypoint.new(item.time, item.value, item.envelope) end; return NumberSequence.new(points) end
	if codec == "color_sequence" then local points = {}; for index, item in ipairs(canonical.keypoints) do points[index] = ColorSequenceKeypoint.new(item.time, Color3.fromRGB(item.color.r, item.color.g, item.color.b)) end; return ColorSequence.new(points) end
	if codec == "brick_color" then return BrickColor.new(canonical.name) end
	if codec == "font" then local weight, style = (Enum.FontWeight :: any)[canonical.weight], (Enum.FontStyle :: any)[canonical.style]; if weight == nil or style == nil then error("Font enum unavailable") end; return Font.new(canonical.family, weight, style) end
	if codec == "physical_properties" then return PhysicalProperties.new(canonical.density, canonical.friction, canonical.elasticity, canonical.frictionWeight, canonical.elasticityWeight) end
	if codec == "axes" then local values = {}; if canonical.x then table.insert(values, Enum.Axis.X) end; if canonical.y then table.insert(values, Enum.Axis.Y) end; if canonical.z then table.insert(values, Enum.Axis.Z) end; return Axes.new(table.unpack(values)) end
	if codec == "faces" then local values = {}; if canonical.top then table.insert(values, Enum.NormalId.Top) end; if canonical.bottom then table.insert(values, Enum.NormalId.Bottom) end; if canonical.left then table.insert(values, Enum.NormalId.Left) end; if canonical.right then table.insert(values, Enum.NormalId.Right) end; if canonical.front then table.insert(values, Enum.NormalId.Front) end; if canonical.back then table.insert(values, Enum.NormalId.Back) end; return Faces.new(table.unpack(values)) end
	if codec == "ray" then return Ray.new(Vector3.new(canonical.origin.x, canonical.origin.y, canonical.origin.z), Vector3.new(canonical.direction.x, canonical.direction.y, canonical.direction.z)) end
	if codec == "instance_ref" then if canonical.state == "nil" then return nil end; if typeof(referenceResolver) ~= "function" then error("Instance reference resolver unavailable") end; local instance = referenceResolver(canonical); if typeof(instance) ~= "Instance" or not instance:IsA(canonical.expectedClass) or instance.ClassName ~= canonical.className then error("Instance reference precondition mismatch") end; return instance end
	if codec == "enum_name" then if property == nil or typeof(property.catalogType) ~= "table" or property.catalogType.category ~= "enum" or typeof(property.catalogType.name) ~= "string" then error("enum manifest metadata missing") end; local enumType = (Enum :: any)[property.catalogType.name]; local item = enumType and enumType[canonical.value]; if item == nil then error("enum unavailable") end; return item end
	error("unknown Studio value codec")
end
function Generated.fromStudio(codec: any, value: any, referenceEncoder: any?, property: any?): any
	-- Instance references use their own class-constrained nil form. All other
	-- nullable domains are explicit manifest properties and must never fall
	-- through to a datatype field dereference.
	if codec == "instance_ref" then
		if value == nil then
			if property == nil or typeof(property.referenceClass) ~= "string" or property.referenceClass == "" then error("Instance reference manifest metadata missing") end
			return Generated.canonicalValue({ kind = codec, state = "nil", expectedClass = property.referenceClass }, property)
		end
		if typeof(referenceEncoder) ~= "function" then error("Instance reference encoder unavailable") end
		return Generated.canonicalValue(referenceEncoder(value, property), property)
	end
	if value == nil then
		if property == nil or property.nullable ~= true then error("nil Studio value is not declared for property") end
		return Generated.canonicalValue({ kind = "nil", expectedCodec = codec }, property)
	end
	if codec == "boolean" or codec == "number_f32" or codec == "number_f64" or codec == "int32" or codec == "string_utf8" or codec == "content" then return Generated.canonicalValue({ kind = codec, value = value }) end
	if codec == "int64_decimal" then if typeof(value) ~= "number" or value % 1 ~= 0 or math.abs(value) > 9007199254740991 then error("int64 readback is not exactly representable by Luau") end; return Generated.canonicalValue({ kind = codec, value = string.format("%.0f", value) }) end
	if codec == "color3_rgb8" then return Generated.canonicalValue({ kind = codec, r = math.floor(value.R * 255 + 0.5), g = math.floor(value.G * 255 + 0.5), b = math.floor(value.B * 255 + 0.5) }) end
	if codec == "vector2_f32" then return Generated.canonicalValue({ kind = codec, x = value.X, y = value.Y }) end
	if codec == "vector3_f32" then return Generated.canonicalValue({ kind = codec, x = value.X, y = value.Y, z = value.Z }) end
	if codec == "cframe_f32x12" then return Generated.canonicalValue({ kind = codec, components = { value:GetComponents() } }) end
	if codec == "udim" then return Generated.canonicalValue({ kind = codec, scale = value.Scale, offset = value.Offset }) end
	if codec == "udim2" then return Generated.canonicalValue({ kind = codec, x = { scale = value.X.Scale, offset = value.X.Offset }, y = { scale = value.Y.Scale, offset = value.Y.Offset } }) end
	if codec == "rect" then return Generated.canonicalValue({ kind = codec, minX = value.Min.X, minY = value.Min.Y, maxX = value.Max.X, maxY = value.Max.Y }) end
	if codec == "number_range" then return Generated.canonicalValue({ kind = codec, min = value.Min, max = value.Max }) end
	if codec == "number_sequence" then local points = {}; for index, item in ipairs(value.Keypoints) do points[index] = { time = item.Time, value = item.Value, envelope = item.Envelope } end; return Generated.canonicalValue({ kind = codec, keypoints = points }) end
	if codec == "color_sequence" then local points = {}; for index, item in ipairs(value.Keypoints) do points[index] = { time = item.Time, color = { r = math.floor(item.Value.R * 255 + 0.5), g = math.floor(item.Value.G * 255 + 0.5), b = math.floor(item.Value.B * 255 + 0.5) } } end; return Generated.canonicalValue({ kind = codec, keypoints = points }) end
	if codec == "brick_color" then return Generated.canonicalValue({ kind = codec, name = value.Name }) end
	if codec == "font" then return Generated.canonicalValue({ kind = codec, family = value.Family, weight = value.Weight.Name, style = value.Style.Name }) end
	if codec == "physical_properties" then return Generated.canonicalValue({ kind = codec, density = value.Density, friction = value.Friction, elasticity = value.Elasticity, frictionWeight = value.FrictionWeight, elasticityWeight = value.ElasticityWeight }) end
	if codec == "axes" then return Generated.canonicalValue({ kind = codec, x = value.X, y = value.Y, z = value.Z }) end
	if codec == "faces" then return Generated.canonicalValue({ kind = codec, top = value.Top, bottom = value.Bottom, left = value.Left, right = value.Right, front = value.Front, back = value.Back }) end
	if codec == "ray" then return Generated.canonicalValue({ kind = codec, origin = { x = value.Origin.X, y = value.Origin.Y, z = value.Origin.Z }, direction = { x = value.Direction.X, y = value.Direction.Y, z = value.Direction.Z } }) end
	if codec == "enum_name" then return Generated.canonicalValue({ kind = codec, value = value.Name }) end
	error("unknown Studio value codec")
end
function Generated.write(instance: Instance, propertyName: string, value: any, referenceResolver: any?)
	local property = Generated.propertyMetadata(instance.ClassName, propertyName)
	if property == nil then error("property is not manifest writable") end
	(instance :: any)[propertyName] = Generated.toStudio(property.codec, value, property, referenceResolver)
end
function Generated.read(instance: Instance, propertyName: string, referenceEncoder: any?): any
	local property = Generated.propertyMetadata(instance.ClassName, propertyName)
	if property == nil then error("property is not manifest readable") end
	return Generated.validateValue(property.codec, Generated.fromStudio(property.codec, (instance :: any)[propertyName], referenceEncoder, property), property)
end
function Generated.canonicalAttribute(value: any): any
	if typeof(value) == "boolean" then return value end
	if typeof(value) == "number" then return f32(value) end
	if typeof(value) == "string" then
		if not validUtf8(value) or #value > Generated.manifest.attributes.maximumStringUtf8Bytes then error("attribute string outside manifest") end
		return value
	end
	error("attribute type outside manifest")
end
-- Universal project indexing observes Roblox's complete supported attribute
-- datatype domain. Mutation attributes stay deliberately narrower and use
-- canonicalAttribute/validateAttributes below.
function Generated.canonicalProjectAttribute(value: any): any
	local valueType = typeof(value)
	if valueType == "boolean" or valueType == "number" or valueType == "string" then return Generated.canonicalAttribute(value) end
	local codecs = {
		BrickColor = "brick_color",
		CFrame = "cframe_f32x12",
		Color3 = "color3_rgb8",
		ColorSequence = "color_sequence",
		NumberRange = "number_range",
		NumberSequence = "number_sequence",
		Rect = "rect",
		UDim = "udim",
		UDim2 = "udim2",
		Vector2 = "vector2_f32",
		Vector3 = "vector3_f32",
	}
	local codec = codecs[valueType]
	if codec == nil then error("project attribute type outside Roblox attribute domain") end
	return Generated.fromStudio(codec, value)
end
function Generated.validateAttributes(attributes: any)
	if typeof(attributes) ~= "table" then error("attributes must be a table") end
	local canonical = {}
	local count = 0
	for name, value in pairs(attributes) do
		count += 1
		if count > Generated.manifest.attributes.maximumCount or typeof(name) ~= "string" or #name == 0 or #name > Generated.manifest.attributes.maximumNameUtf8Bytes or string.sub(name, 1, #Generated.manifest.attributes.reservedPrefix) == Generated.manifest.attributes.reservedPrefix then error("attribute outside manifest") end
		canonical[name] = Generated.canonicalAttribute(value)
	end
	return canonical
end
function Generated.validateSource(source: any, required: boolean)
	if source == nil then if required then error("source required") end; return end
	if not validUtf8(source) or #source > Generated.manifest.source.maximumUtf8Bytes or required and not string.find(source, "%S") then error("source outside manifest") end
end
function Generated.canonicalValueMaterial(value: any): string
	local item = Generated.canonicalValue(value)
	if item.kind == "nil" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("expected-codec", item.expectedCodec)) end
	if item.kind == "boolean" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("value", item.value and "1" or "0")) end
	if item.kind == "number_f32" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("bits", hex(string.pack(">f", item.value)))) end
	if item.kind == "number_f64" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("bits", hex(string.pack(">d", item.value)))) end
	if item.kind == "int32" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("value", tostring(item.value))) end
	if item.kind == "int64_decimal" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("decimal", item.value)) end
	if item.kind == "string_utf8" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("utf8", item.value)) end
	if item.kind == "content" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("utf8", item.value)) end
	if item.kind == "color3_rgb8" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("r", tostring(item.r)) .. tagged("g", tostring(item.g)) .. tagged("b", tostring(item.b))) end
	if item.kind == "vector2_f32" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("x", hex(string.pack(">f", item.x))) .. tagged("y", hex(string.pack(">f", item.y)))) end
	if item.kind == "vector3_f32" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("x", hex(string.pack(">f", item.x))) .. tagged("y", hex(string.pack(">f", item.y))) .. tagged("z", hex(string.pack(">f", item.z)))) end
	if item.kind == "cframe_f32x12" then local values = {}; for index, component in ipairs(item.components) do values[index] = hex(string.pack(">f", component)) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("components", taggedSequence(values))) end
	if item.kind == "udim" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("udim", tagged("scale", hex(string.pack(">f", item.scale))) .. tagged("offset", tostring(item.offset)))) end
	if item.kind == "udim2" then local function material(part) return tagged("udim", tagged("scale", hex(string.pack(">f", part.scale))) .. tagged("offset", tostring(part.offset))) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("x", material(item.x)) .. tagged("y", material(item.y))) end
	if item.kind == "rect" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("min-x", hex(string.pack(">f", item.minX))) .. tagged("min-y", hex(string.pack(">f", item.minY))) .. tagged("max-x", hex(string.pack(">f", item.maxX))) .. tagged("max-y", hex(string.pack(">f", item.maxY)))) end
	if item.kind == "number_range" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("min", hex(string.pack(">f", item.min))) .. tagged("max", hex(string.pack(">f", item.max)))) end
	if item.kind == "number_sequence" then local values = {}; for index, point in ipairs(item.keypoints) do values[index] = tagged("keypoint", tagged("time", hex(string.pack(">f", point.time))) .. tagged("value", hex(string.pack(">f", point.value))) .. tagged("envelope", hex(string.pack(">f", point.envelope)))) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("keypoints", taggedSequence(values))) end
	if item.kind == "color_sequence" then local values = {}; for index, point in ipairs(item.keypoints) do values[index] = tagged("keypoint", tagged("time", hex(string.pack(">f", point.time))) .. tagged("color", tagged("color", tagged("r", tostring(point.color.r)) .. tagged("g", tostring(point.color.g)) .. tagged("b", tostring(point.color.b))))) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("keypoints", taggedSequence(values))) end
	if item.kind == "brick_color" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("name", item.name)) end
	if item.kind == "font" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("family", item.family) .. tagged("weight", item.weight) .. tagged("style", item.style)) end
	if item.kind == "physical_properties" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("density", hex(string.pack(">f", item.density))) .. tagged("friction", hex(string.pack(">f", item.friction))) .. tagged("elasticity", hex(string.pack(">f", item.elasticity))) .. tagged("friction-weight", hex(string.pack(">f", item.frictionWeight))) .. tagged("elasticity-weight", hex(string.pack(">f", item.elasticityWeight)))) end
	if item.kind == "axes" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("x", item.x and "1" or "0") .. tagged("y", item.y and "1" or "0") .. tagged("z", item.z and "1" or "0")) end
	if item.kind == "faces" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("top", item.top and "1" or "0") .. tagged("bottom", item.bottom and "1" or "0") .. tagged("left", item.left and "1" or "0") .. tagged("right", item.right and "1" or "0") .. tagged("front", item.front and "1" or "0") .. tagged("back", item.back and "1" or "0")) end
	if item.kind == "ray" then local function vector(part) return tagged("vector3", tagged("x", hex(string.pack(">f", part.x))) .. tagged("y", hex(string.pack(">f", part.y))) .. tagged("z", hex(string.pack(">f", part.z)))) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("origin", vector(item.origin)) .. tagged("direction", vector(item.direction))) end
	if item.kind == "instance_ref" then if item.state == "nil" then return tagged("studio-value", tagged("codec", item.kind) .. tagged("state", "nil") .. tagged("expected-class", item.expectedClass)) end; return tagged("studio-value", tagged("codec", item.kind) .. tagged("state", "reference") .. tagged("identity", studioObjectIdentityKey(item.identity)) .. tagged("path", item.path) .. tagged("class", item.className) .. tagged("expected-class", item.expectedClass)) end
	return tagged("studio-value", tagged("codec", item.kind) .. tagged("name", item.value))
end
local function dataMaterial(value: any): string
	if value == nil then return tagged("null", "") end
	if typeof(value) == "boolean" then return tagged("bool", value and "1" or "0") end
	if typeof(value) == "string" then if not validUtf8(value) then error("invalid UTF-8") end; return tagged("utf8", value) end
	if typeof(value) == "number" then if not finite(value) then error("non-finite number") end; return tagged("f64", hex(string.pack(">d", value))) end
	if typeof(value) ~= "table" then error("unsupported evidence value") end
	if typeof(value.kind) == "string" and (value.kind == "nil" or value.kind == "boolean" or value.kind == "number_f32" or value.kind == "number_f64" or value.kind == "int32" or value.kind == "int64_decimal" or value.kind == "string_utf8" or value.kind == "content" or value.kind == "color3_rgb8" or value.kind == "vector2_f32" or value.kind == "vector3_f32" or value.kind == "cframe_f32x12" or value.kind == "udim" or value.kind == "udim2" or value.kind == "rect" or value.kind == "number_range" or value.kind == "number_sequence" or value.kind == "color_sequence" or value.kind == "brick_color" or value.kind == "font" or value.kind == "physical_properties" or value.kind == "axes" or value.kind == "faces" or value.kind == "ray" or value.kind == "instance_ref" or value.kind == "enum_name") then return tagged("studio", Generated.canonicalValueMaterial(value)) end
	local length = #value
	-- HttpService encodes an empty evidence collection as a JSON array. Lua has
	-- no distinct empty-array type, so canonical evidence treats an empty table
	-- as that closed collection domain rather than the unused empty-object domain.
	local isSequence = length > 0 or next(value) == nil
	if isSequence then
		for key in pairs(value) do if typeof(key) ~= "number" or key < 1 or key > length or key % 1 ~= 0 then isSequence = false; break end end
	end
	if isSequence then local entries = {}; for index, entry in ipairs(value) do entries[index] = dataMaterial(entry) end; return tagged("array", taggedSequence(entries)) end
	local keys = {} :: {string}; for key in pairs(value) do if typeof(key) ~= "string" then error("evidence object key") end; table.insert(keys, key) end; table.sort(keys)
	local entries = {}; for index, key in ipairs(keys) do entries[index] = tagged("entry", tagged("key", key) .. tagged("value", dataMaterial(value[key]))) end
	return tagged("object", taggedSequence(entries))
end
local function targetMaterial(target: any): string
	if typeof(target) ~= "table" or typeof(target.kind) ~= "string" then error("invalid evidence target") end
	if target.kind == "project" then return tagged("target", "project") end
	if target.kind ~= "instance" or typeof(target.path) ~= "string" or typeof(target.className) ~= "string" then error("invalid instance target") end
	return tagged("target", tagged("identity", studioObjectIdentityKey(target.identity)) .. tagged("path", target.path) .. tagged("class", target.className))
end
local function factResultMaterial(result: any): string
	if typeof(result) ~= "table" or typeof(result.status) ~= "string" then error("invalid fact result") end
	if result.status == "observed" then return tagged("result", tagged("status", result.status) .. tagged("value", dataMaterial(result.value))) end
	if result.status == "absent" then return tagged("result", tagged("status", result.status)) end
	if (result.status == "unavailable" or result.status == "read_error") and typeof(result.code) == "string" then return tagged("result", tagged("status", result.status) .. tagged("code", result.code)) end
	error("invalid fact result")
end
function Generated.factMaterial(fact: any): string
	if typeof(fact) ~= "table" or typeof(fact.kind) ~= "string" or typeof(fact.key) ~= "string" then error("invalid evidence fact") end
	local named = ""
	if fact.kind == "property" then named = tagged("property", fact.propertyName) elseif fact.kind == "attribute" then named = tagged("attribute", fact.attributeName) elseif fact.kind == "runtime_resolution" or fact.kind == "position_series" then named = tagged("runtime", tagged("call", fact.callId) .. tagged("target", fact.runtimeTargetId) .. tagged("capability", fact.capability)) elseif fact.kind == "position" and fact.callId ~= nil then named = tagged("runtime", tagged("call", fact.callId) .. tagged("target", fact.runtimeTargetId or "") .. tagged("capability", fact.capability or "")) end
	return tagged("StudioEvidenceFact", tagged("kind", fact.kind) .. tagged("key", fact.key) .. targetMaterial(fact.target) .. named .. factResultMaterial(fact.result))
end
function Generated.sortFacts(facts: any): {any}
	sequence(facts, "facts")
	local copy = table.clone(facts)
	table.sort(copy, function(left, right) return Generated.factMaterial(left) < Generated.factMaterial(right) end)
	local seen = {}; for _, fact in ipairs(copy) do if typeof(fact.key) ~= "string" or seen[fact.key] then error("duplicate or invalid evidence fact key") end; seen[fact.key] = true end
	return copy
end
function Generated.factKey(kind: string, target: any, name: string?): string
	if typeof(target) ~= "table" or typeof(target.kind) ~= "string" then error("invalid evidence target") end
	local identity = target.kind == "project" and "project" or studioObjectIdentityKey(target.identity) .. "@" .. tostring(target.path) .. ":" .. tostring(target.className)
	if name == nil then return kind .. ":" .. identity end
	return kind .. ":" .. identity .. ":" .. name
end
local function bindingHash(binding: any): string
	if typeof(binding) ~= "table" then error("invalid evidence binding") end
	local names = {} :: {string}; for name, value in pairs(binding) do if typeof(name) ~= "string" or typeof(value) ~= "string" or value == "" then error("invalid evidence binding") end; table.insert(names, name) end; table.sort(names)
	local entries = {}; for index, name in ipairs(names) do entries[index] = tagged("entry", tagged("key", name) .. tagged("value", binding[name])) end
	return sha256(tagged("binding", taggedSequence(entries)))
end
local function isCreatorMutationBinding(binding: any): boolean
	if typeof(binding) ~= "table" then return false end
	local count = 0
	for name, value in pairs(binding) do
		if typeof(name) ~= "string" or typeof(value) ~= "string" or value == "" then return false end
		count += 1
	end
	if count ~= #Generated.creatorMutationBindingSchema then return false end
	for _, field in ipairs(Generated.creatorMutationBindingSchema) do
		local value = binding[field.name]
		if typeof(value) ~= "string" or value == "" then return false end
		if field.kind == "hash" and (#value ~= 64 or string.match(value, "^[0-9a-f]+$") == nil) then return false end
	end
	return true
end
function Generated.validateStudioCreatorMutationBinding(binding: any)
	if not isCreatorMutationBinding(binding) then error("invalid creator mutation binding") end
end
function Generated.matchesStudioCreatorMutationBinding(binding: any, expected: any): boolean
	if not isCreatorMutationBinding(binding) or not isCreatorMutationBinding(expected) then return false end
	for _, field in ipairs(Generated.creatorMutationBindingSchema) do
		if binding[field.name] ~= expected[field.name] then return false end
	end
	return true
end
local function projectMaterial(project: any): string
	if typeof(project) ~= "table" or typeof(project.name) ~= "string" or typeof(project.placeId) ~= "number" or typeof(project.universeId) ~= "number" then error("invalid project") end
	return tagged("project", tagged("name", project.name) .. tagged("place", tostring(project.placeId)) .. tagged("universe", tostring(project.universeId)))
end
local function requirementMaterial(requirement: any): string
	if typeof(requirement) ~= "table" or typeof(requirement.key) ~= "string" or typeof(requirement.kind) ~= "string" then error("invalid projection requirement") end
	return tagged("requirement", tagged("key", requirement.key) .. tagged("kind", requirement.kind) .. targetMaterial(requirement.target) .. tagged("property", requirement.propertyName or "") .. tagged("attribute", requirement.attributeName or "") .. tagged("call", requirement.callId or "") .. tagged("runtime-target", requirement.runtimeTargetId or "") .. tagged("capability", requirement.capability or "") .. tagged("expected-status", requirement.expectedStatus or "observed") .. tagged("expected", requirement.expected == nil and "" or dataMaterial(requirement.expected)))
end
local function scopeMaterial(scope: any): string
	if typeof(scope) ~= "table" then error("invalid evidence scope") end
	sequence(scope.roots, "scope roots"); local roots = {}; for index, root in ipairs(scope.roots) do if typeof(root) ~= "string" then error("invalid scope root") end; roots[index] = tagged("root", root) end
	return tagged("scope", tagged("roots", taggedSequence(roots)))
end
local function boundsMaterial(bounds: any): string
	if typeof(bounds) ~= "table" or typeof(bounds.maximumFacts) ~= "number" or typeof(bounds.maximumBytes) ~= "number" then error("invalid evidence bounds") end
	sequence(bounds.roots, "bounds roots"); local roots = {}; for index, root in ipairs(bounds.roots) do if typeof(root) ~= "string" then error("invalid bound root") end; roots[index] = tagged("root", root) end
	return tagged("bounds", tagged("facts", tostring(bounds.maximumFacts)) .. tagged("bytes", tostring(bounds.maximumBytes)) .. tagged("roots", taggedSequence(roots)))
end
function Generated.bindingHash(binding: any): string return bindingHash(binding) end
function Generated.projectionMaterial(projection: any): string
	if typeof(projection) ~= "table" then error("invalid evidence projection") end
	sequence(projection.requirements, "projection requirements")
	local requirements = {}; for index, requirement in ipairs(projection.requirements) do requirements[index] = requirementMaterial(requirement) end
	return tagged("StudioEvidenceProjection", tagged("id", projection.id) .. tagged("manifest", projection.manifestHash) .. tagged("purpose", projection.purpose) .. projectMaterial(projection.project) .. tagged("binding", bindingHash(projection.binding)) .. tagged("requirements", taggedSequence(requirements)) .. scopeMaterial(projection.scope) .. boundsMaterial(projection.bounds))
end
function Generated.projectionHash(projection: any): string return sha256(Generated.projectionMaterial(projection)) end
local function diagnosticMaterial(value: any): string
	if typeof(value) ~= "table" or typeof(value.code) ~= "string" or typeof(value.messageHash) ~= "string" then error("invalid diagnostic") end
	return tagged("diagnostic", tagged("code", value.code) .. tagged("hash", value.messageHash))
end
function Generated.envelopeMaterial(envelope: any): string
	if typeof(envelope) ~= "table" then error("invalid evidence envelope") end
	sequence(envelope.facts, "envelope facts"); local facts = {}; for index, fact in ipairs(envelope.facts) do facts[index] = Generated.factMaterial(fact) end
	local diagnostics = {}; if envelope.diagnostics ~= nil then sequence(envelope.diagnostics, "diagnostics"); for index, diagnostic in ipairs(envelope.diagnostics) do diagnostics[index] = diagnosticMaterial(diagnostic) end end
	return tagged("StudioEvidenceEnvelope", tagged("manifest", envelope.manifestHash) .. tagged("projection", envelope.projectionHash) .. tagged("projection-id", envelope.projectionId) .. tagged("binding", envelope.bindingHash) .. projectMaterial(envelope.project) .. tagged("authoritative", envelope.authoritative and "1" or "0") .. tagged("started", envelope.startedAt) .. tagged("ended", envelope.endedAt) .. tagged("completion", envelope.completion) .. tagged("facts", taggedSequence(facts)) .. tagged("diagnostics", taggedSequence(diagnostics)))
end
function Generated.envelopeHash(envelope: any): string return sha256(Generated.envelopeMaterial(envelope)) end
function Generated.projectionRequirements(projection: any): {any}
	Generated.validateProjection(projection)
	return table.clone(projection.requirements)
end
function Generated.validateProjection(projection: any)
	if typeof(projection) ~= "table" or projection.kind ~= "StudioEvidenceProjection" or projection.manifestHash ~= Generated.manifestHash or typeof(projection.requirements) ~= "table" or typeof(projection.bounds) ~= "table" or typeof(projection.scope) ~= "table" then error("invalid generated evidence projection") end
	sequence(projection.requirements, "projection requirements")
	for name in pairs(projection.scope) do if name ~= "roots" then error("invalid generated evidence projection scope") end end
	if typeof(projection.bounds.maximumFacts) ~= "number" or typeof(projection.bounds.maximumBytes) ~= "number" then error("invalid generated evidence bounds") end
	if #projection.requirements > Generated.manifest.limits.maximumProjectionFacts or projection.bounds.maximumFacts > Generated.manifest.limits.maximumProjectionFacts or projection.bounds.maximumBytes > Generated.manifest.limits.maximumProjectionBytes then error("projection exceeds manifest bounds") end
	local previous = ""; local requirements = projection.requirements :: {any}; for _, requirement: any in ipairs(requirements) do if typeof(requirement.key) ~= "string" or requirement.key <= previous then error("projection requirements must be canonical") end; previous = requirement.key end
	if projection.bindingHash ~= bindingHash(projection.binding) or projection.contentHash ~= Generated.projectionHash(projection) then error("projection hash mismatch") end
end
-- Recompile the exact direct-readback or preflight proof obligations from the
-- sealed CreatorChangeSet. This intentionally accepts no Studio objects and
-- no property policy: every admissible fact comes from Generated.manifest.
-- The template supplies only the approved identity/project/binding/delta fields;
-- requirements, scope, bounds, binding hash, and content hash are rebuilt.
local function nonEmpty(value: any, label: string): string
	if typeof(value) ~= "string" or value == "" then error(label) end
	return value
end
local function studioPath(value: any, label: string): string
	local path = nonEmpty(value, label)
	if string.sub(path, 1, 1) == "/" or string.sub(path, -1) == "/" or string.find(path, "\\\\", 1, true) then error(label) end
	for _, part in ipairs(string.split(path, "/")) do if part == "" or part == "." or part == ".." then error(label) end end
	return path
end
-- Keep project-index names and operation names on StudioAuthoring.validName's
-- exact UTF-8 byte contract. Names are captured separately from display paths
-- so hierarchy decisions never recover authority from a path string.
local function studioInstanceName(value: any, label: string): string
	local name = nonEmpty(value, label)
	if #name > 100 or string.find(name, "/", 1, true) or name == "." or name == ".." then error(label) end
	return name
end
local function childPath(parent: any, name: any): string
	if typeof(parent) ~= "table" or typeof(parent.path) ~= "string" then error("invalid mutation parent") end
	local parentPath = studioPath(parent.path, "invalid mutation parent path")
	local child = studioInstanceName(name, "invalid mutation name")
	return parentPath .. "/" .. child
end
local function sortedNames(value: any, label: string): {string}
	if typeof(value) ~= "table" then error(label) end
	local names = {} :: {string}
	for name in pairs(value) do if typeof(name) ~= "string" then error(label) end; table.insert(names, name) end
	table.sort(names)
	return names
end
local function sortedStrings(value: any, label: string): {string}
	sequence(value, label)
	local copy = {} :: {string}; local seen = {}
	for index, entry in ipairs(value) do
		if typeof(entry) ~= "string" or entry == "" or seen[entry] then error(label) end
		seen[entry] = true; copy[index] = entry
	end
	table.sort(copy)
	return copy
end
local function sourceBlobBinding(value: any, required: boolean): any
	if value == nil then
		if required then error("source blob binding required") end
		return nil
	end
	if typeof(value) ~= "table" then error("invalid source blob binding") end
	exactKeys(value, { "manifestId", "manifestHash", "sourceHash", "utf8Bytes" })
	if typeof(value.manifestId) ~= "string" or value.manifestId == "" or string.find(value.manifestId, "%s") then error("invalid source blob manifest identity") end
	for _, hash in ipairs({ value.manifestHash, value.sourceHash }) do
		if typeof(hash) ~= "string" or #hash ~= 64 or string.match(hash, "^[a-f0-9]+$") == nil then error("invalid source blob hash") end
	end
	if typeof(value.utf8Bytes) ~= "number" or value.utf8Bytes % 1 ~= 0 or value.utf8Bytes < 0 or value.utf8Bytes > Generated.manifest.source.maximumUtf8Bytes then error("invalid source blob byte count") end
	return { manifestId = value.manifestId, manifestHash = value.manifestHash, sourceHash = value.sourceHash, utf8Bytes = value.utf8Bytes }
end
-- Project-index rows describe every observed object under an approved root,
-- including engine objects that Forge cannot author or reflect. Keep this
-- structural validation separate from a mutation target: only the latter is
-- entitled to a manifest class and writable-fact surface.
local function indexedTarget(identity: any, path: any, className: any): any
	local target = { kind = "instance", identity = Generated.studioObjectIdentity(identity), path = studioPath(path, "invalid mutation path"), className = nonEmpty(className, "invalid mutation class") }
	if not Generated.isAllowedRoot(target.path) then error("project-index target outside authoring roots") end
	return target
end
local function mutationTarget(identity: any, path: any, className: any): any
	local target = indexedTarget(identity, path, className)
	if Generated.classMetadata(target.className) == nil then error("mutation target outside manifest") end
	return target
end
-- Enrollment changes a Studio object's durable post-state identity, but never
-- rewrites the immutable pre-state identity used to locate it before Apply.
-- Build this map once for the entire change set so an enrolled object is
-- represented consistently when it appears as a target, parent, or property
-- reference in another operation.
local function buildTransactionEnrollmentMap(changeSet: any): any
	local byIdentity, byStableId = {}, {}
	for _, operation in ipairs(changeSet.operations) do
		if operation.enrollment ~= nil then
			if typeof(operation.enrollment) ~= "table" or typeof(operation.target) ~= "table" or typeof(operation.target.identity) ~= "table" then error("invalid mutation enrollment") end
			local source = Generated.studioObjectIdentity(operation.enrollment.identity)
			local target = Generated.studioObjectIdentity(operation.target.identity)
			if source.kind ~= "studio_ephemeral" or studioObjectIdentityKey(source) ~= studioObjectIdentityKey(target) or typeof(operation.enrollment.stableId) ~= "string" or operation.enrollment.stableId == "" then error("invalid mutation enrollment") end
			local sourceKey = studioObjectIdentityKey(source)
			if byIdentity[sourceKey] ~= nil then error("duplicate mutation enrollment source identity") end
			if byStableId[operation.enrollment.stableId] ~= nil then error("duplicate mutation enrollment stable identity") end
			local enrolled = { kind = "forge_attribute", stableId = operation.enrollment.stableId }
			byIdentity[sourceKey] = enrolled
			byStableId[operation.enrollment.stableId] = sourceKey
		end
	end
	return { byIdentity = byIdentity, byStableId = byStableId }
end
local function postMutationIdentity(identity: any, enrollments: any): any
	local canonical = Generated.studioObjectIdentity(identity)
	local enrolled = enrollments.byIdentity[studioObjectIdentityKey(canonical)]
	return if enrolled == nil then canonical else { kind = "forge_attribute", stableId = enrolled.stableId }
end
local function postMutationTarget(operation: any, path: any, className: any, enrollments: any, topology: any?): any
	if typeof(operation.target) ~= "table" then error("mutation target is missing") end
	local original = Generated.studioObjectIdentity(operation.target.identity)
	if operation.enrollment ~= nil and enrollments.byIdentity[studioObjectIdentityKey(original)] == nil then error("mutation enrollment is not transaction-bound") end
	if topology ~= nil and operation.kind ~= "delete" then
		local target = topology.postTargets[studioObjectIdentityKey(original)]
		if target == nil then error("mutation target is absent from virtual post-state") end
		if target.className ~= className then error("mutation target class changes are not supported") end
		return target
	end
	return mutationTarget(postMutationIdentity(original, enrollments), path, className)
end
local function postParentTarget(operation: any, parentIdentity: any, enrollments: any, topology: any?): any
	local original = Generated.studioObjectIdentity(parentIdentity)
	if topology ~= nil then
		local target = topology.postTargets[studioObjectIdentityKey(original)]
		if target == nil then error("mutation parent is absent from virtual post-state") end
		return target
	end
	return indexedTarget(postMutationIdentity(original, enrollments), operation.parent.path, operation.parent.className)
end
local function postMutationValue(value: any, enrollments: any, topology: any?): any
	if value.kind ~= "instance_ref" or value.state ~= "reference" then return value end
	local original = Generated.studioObjectIdentity(value.identity)
	if topology ~= nil then
		local target = topology.postTargets[studioObjectIdentityKey(original)]
		if target == nil then error("post-state instance reference is absent from virtual topology") end
		return { kind = "instance_ref", state = "reference", identity = target.identity, path = target.path, className = target.className, expectedClass = value.expectedClass }
	end
	return { kind = "instance_ref", state = "reference", identity = postMutationIdentity(original, enrollments), path = value.path, className = value.className, expectedClass = value.expectedClass }
end
local function appendMutationRequirements(requirements: {any}, operation: any, target: any, structure: any?, structureStatus: any?, enrollments: any, topology: any?)
	local class = Generated.classMetadata(target.className)
	if class == nil then error("mutation class outside manifest") end
	if structureStatus ~= nil then
		local requirement: any = { key = Generated.factKey("structure", target), kind = "structure", target = target, expectedStatus = structureStatus }
		if structureStatus == "observed" then requirement.expected = structure end
		table.insert(requirements, requirement)
	end
	local properties = operation.properties
	if properties ~= nil then
		for _, name in ipairs(sortedNames(properties, "invalid mutation properties")) do
			local property = Generated.propertyMetadata(target.className, name)
			if property == nil then error("mutation property outside manifest") end
			local canonical = Generated.validateValue(property.codec, properties[name], property)
			table.insert(requirements, { key = Generated.factKey("property", target, name), kind = "property", target = target, propertyName = name, expected = postMutationValue(canonical, enrollments, topology) })
		end
	end
	local attributes = operation.attributes
	if attributes ~= nil then
		local canonicalAttributes = Generated.validateAttributes(attributes)
		for _, name in ipairs(sortedNames(canonicalAttributes, "invalid mutation attributes")) do
			table.insert(requirements, { key = Generated.factKey("attribute", target, name), kind = "attribute", target = target, attributeName = name, expected = canonicalAttributes[name] })
		end
	end
	if operation.removedAttributes ~= nil then
		for _, name in ipairs(sortedStrings(operation.removedAttributes, "invalid removed attributes")) do
			if attributes ~= nil and attributes[name] ~= nil then error("attribute cannot be set and removed") end
			-- Attribute names are validated through the same manifest attribute
			-- route; a harmless boolean checks the name without inventing a table.
			Generated.validateAttributes({ [name] = true })
			table.insert(requirements, { key = Generated.factKey("attribute", target, name), kind = "attribute", target = target, attributeName = name, expectedStatus = "absent" })
		end
	end
	if operation.kind == "edit_source" then
		if typeof(operation.finalSourceHash) ~= "string" or string.match(operation.finalSourceHash, "^[a-f0-9]+$") == nil then error("invalid edited source hash") end
		table.insert(requirements, { key = Generated.factKey("source_hash", target), kind = "source_hash", target = target, expected = operation.finalSourceHash })
	elseif operation.kind == "create" then
		local sourceBlob = sourceBlobBinding(operation.sourceBlob, class.source ~= "forbidden")
		if class.source == "forbidden" and sourceBlob ~= nil then error("non-script create cannot carry source blob") end
		if sourceBlob ~= nil then table.insert(requirements, { key = Generated.factKey("source_hash", target), kind = "source_hash", target = target, expected = sourceBlob.sourceHash }) end
	end
end
local function sameInstanceTarget(left: any, right: any): boolean
	return left.kind == "instance" and right.kind == "instance" and studioObjectIdentityKey(left.identity) == studioObjectIdentityKey(right.identity) and left.path == right.path and left.className == right.className
end
local function strictDescendant(path: string, ancestor: string): boolean
	return string.sub(path, 1, #ancestor + 1) == ancestor .. "/"
end
local function targetFromIndex(value: any): any
	if typeof(value) ~= "table" then error("invalid project-index target") end
	return indexedTarget(value.identity, value.path, value.className)
end
-- This lower-level compiler is hash-free for the provider-free Luau module
-- test. The bound recompiler below hashes its output.
function Generated.compileMutationRequirements(changeSet: any, deleteDescendants: any?, parentIdentities: any?, topology: any?): {any}
	if typeof(changeSet) ~= "table" or changeSet.kind ~= "CreatorChangeSet" then error("invalid sealed creator change set") end
	local changeSetId = nonEmpty(changeSet.id, "invalid creator change set id")
	sequence(changeSet.operations, "creator change set operations")
	if #changeSet.operations == 0 or #changeSet.operations > Generated.manifest.limits.maximumOperations then error("creator mutation operation bound") end
	local enrollments = if topology ~= nil then topology.enrollments else buildTransactionEnrollmentMap(changeSet)
	local requirements = {} :: {any}; local operationIds = {}
	for _, operation in ipairs(changeSet.operations) do
		if typeof(operation) ~= "table" then error("invalid creator operation") end
		local operationId = nonEmpty(operation.id, "invalid creator operation id")
		if operationIds[operationId] then error("duplicate creator operation id") end
		operationIds[operationId] = true
		local kind = operation.kind
		if kind == "create" then
			if typeof(operation.target) ~= "table" or typeof(operation.target.identity) ~= "table" or operation.target.identity.kind ~= "forge_attribute" then error("create target must have a Forge identity") end
			local target = postMutationTarget(operation, childPath(operation.parent, operation.name), operation.className, enrollments, topology)
			local metadata = Generated.classMetadata(target.className)
			if metadata == nil or metadata.creatable ~= true then error("create class outside manifest") end
			sourceBlobBinding(operation.sourceBlob, metadata.source ~= "forbidden")
			local originalParentIdentity = parentIdentities ~= nil and parentIdentities[operationId] or (operation.parent.kind == "instance" and operation.parent.identity or nil)
			if originalParentIdentity == nil then error("mutation create has no exact parent identity") end
			local parent = postParentTarget(operation, originalParentIdentity, enrollments, topology)
			appendMutationRequirements(requirements, operation, target, { identity = target.identity, path = target.path, className = target.className, parentIdentity = parent.identity, parentPath = parent.path }, "observed", enrollments, topology)
		elseif kind == "update" then
			appendMutationRequirements(requirements, operation, postMutationTarget(operation, operation.target.path, operation.target.className, enrollments, topology), nil, nil, enrollments, topology)
		elseif kind == "move" then
			local target = postMutationTarget(operation, childPath(operation.parent, operation.name), operation.target.className, enrollments, topology)
			local originalParentIdentity = parentIdentities ~= nil and parentIdentities[operationId] or (operation.parent.kind == "instance" and operation.parent.identity or nil)
			if originalParentIdentity == nil then error("mutation move has no exact parent identity") end
			local parent = postParentTarget(operation, originalParentIdentity, enrollments, topology)
			appendMutationRequirements(requirements, operation, target, { identity = target.identity, path = target.path, className = target.className, parentIdentity = parent.identity, parentPath = parent.path }, "observed", enrollments, topology)
		elseif kind == "delete" then
			local root = postMutationTarget(operation, operation.target.path, operation.target.className, enrollments, topology)
			appendMutationRequirements(requirements, operation, root, nil, "absent", enrollments, topology)
			if deleteDescendants ~= nil then
				local descendants = deleteDescendants[operationId]
				if descendants == nil then descendants = {} end
				sequence(descendants, "invalid deleted subtree")
				if #descendants > Generated.manifest.limits.maximumProjectionFacts then error("deleted subtree exceeds projection bound") end
				local seenDescendants = {}
				for _, value in ipairs(descendants) do
					local rawDescendant = targetFromIndex(value)
					local descendant = indexedTarget(postMutationIdentity(rawDescendant.identity, enrollments), rawDescendant.path, rawDescendant.className)
					local descendantId = studioObjectIdentityKey(descendant.identity)
					if descendantId == studioObjectIdentityKey(root.identity) or not strictDescendant(descendant.path, root.path) or seenDescendants[descendantId] then error("invalid deleted subtree target") end
					seenDescendants[descendantId] = true
					table.insert(requirements, { key = Generated.factKey("structure", descendant), kind = "structure", target = descendant, expectedStatus = "absent" })
				end
			end
		elseif kind == "edit_source" then
			local target = postMutationTarget(operation, operation.target.path, operation.target.className, enrollments, topology)
			local metadata = Generated.classMetadata(target.className)
			if metadata == nil or metadata.source == "forbidden" then error("source capability outside manifest") end
			if typeof(operation.beforeSourceHash) ~= "string" or typeof(operation.finalSourceHash) ~= "string" or typeof(operation.finalByteCount) ~= "number" then error("invalid source-edit proof binding") end
			appendMutationRequirements(requirements, operation, target, nil, nil, enrollments, topology)
		else
			error("creator operation outside manifest")
		end
	end
	table.sort(requirements, function(left, right) return left.key < right.key end)
	local previous = ""; for _, requirement in ipairs(requirements) do if requirement.key <= previous then error("duplicate mutation requirement") end; previous = requirement.key end
	return requirements
end
-- A creator change no longer recompiles against a snapshot envelope. The
-- complete immutable project index is the sole source of existing-object and
-- descendant identity. An opaque target may be enrolled only inside the same
-- approved recording; no string-id or display-path lookup becomes authority.
local function completeProjectIndex(capture: any): any
	if typeof(capture) ~= "table" or capture.kind ~= "StudioProjectIndexCapture" or typeof(capture.indexManifest) ~= "table" or typeof(capture.revision) ~= "table" or typeof(capture.projection) ~= "table" then error("complete project index capture required") end
	if capture.indexManifest.manifestHash ~= Generated.manifestHash or capture.revision.manifestHash ~= Generated.manifestHash or capture.revision.indexManifestHash ~= capture.indexManifest.hash or capture.revision.projectionHash ~= capture.projection.hash then error("project index capture binding mismatch") end
	sequence(capture.shards, "project-index shards")
	local nodes, byIdentity, byEngineContainer = {}, {}, {}
	for _, shard in ipairs(capture.shards) do
		if typeof(shard) ~= "table" or shard.kind ~= "StudioProjectEvidenceShard" then error("invalid project-index shard") end
		sequence(shard.nodes, "project-index nodes")
		for _, node in ipairs(shard.nodes) do
			if typeof(node) ~= "table" or typeof(node.identity) ~= "table" or typeof(node.displayPath) ~= "string" or typeof(node.name) ~= "string" or typeof(node.className) ~= "string" or typeof(node.attributes) ~= "table" then error("invalid project-index node") end
			local target = indexedTarget(node.identity, node.displayPath, node.className)
			local targetKey = studioObjectIdentityKey(target.identity)
			if byIdentity[targetKey] ~= nil then error("duplicate project-index identity") end
			local parentIdentity = nil
			if node.parentIdentity ~= nil then parentIdentity = Generated.studioObjectIdentity(node.parentIdentity) end
			local engineContainer = nil
			if node.engineContainer ~= nil then
				if typeof(node.engineContainer) ~= "table" or typeof(node.engineContainer.path) ~= "string" or typeof(node.engineContainer.className) ~= "string" or Generated.authoringContainerClass(node.engineContainer.path) ~= node.engineContainer.className or target.className ~= node.engineContainer.className then error("invalid project-index engine container") end
				engineContainer = { path = node.engineContainer.path, className = node.engineContainer.className }
				local engineKey = engineContainer.path .. "\\0" .. engineContainer.className
				if byEngineContainer[engineKey] ~= nil then error("duplicate project-index engine container") end
				byEngineContainer[engineKey] = targetKey
			end
			-- Covered property values are evidence, not optional display metadata.
			-- Preserve their generated canonical form so transaction topology can
			-- reject an inbound Instance reference before its target is deleted.
			-- Unsupported classes legitimately carry an empty coverage domain.
			local coveredProperties = {} :: {[string]: any}
			if node.coveredProperties ~= nil then
				if typeof(node.coveredProperties) ~= "table" then error("invalid project-index covered properties") end
				for _, propertyName in ipairs(sortedNames(node.coveredProperties, "invalid project-index covered properties")) do
					local metadata = Generated.propertyMetadata(target.className, propertyName)
					if metadata == nil then error("project-index covered property outside generated manifest") end
					coveredProperties[propertyName] = Generated.validateValue(metadata.codec, node.coveredProperties[propertyName], metadata)
				end
			end
			if node.coveredPropertyNames ~= nil then
				local names = sortedStrings(node.coveredPropertyNames, "invalid project-index covered property names")
				local canonicalNames = sortedNames(coveredProperties, "invalid project-index covered properties")
				if #names ~= #canonicalNames then error("project-index covered property names do not match values") end
				for ordinal, propertyName in ipairs(names) do if propertyName ~= canonicalNames[ordinal] then error("project-index covered property names do not match values") end end
			end
			local value = { target = target, name = studioInstanceName(node.name, "invalid project-index instance name"), attributes = node.attributes, parentIdentity = parentIdentity, engineContainer = engineContainer, coveredProperties = coveredProperties }
			byIdentity[targetKey] = value; table.insert(nodes, value)
		end
	end
	return { nodes = nodes, byIdentity = byIdentity, byEngineContainer = byEngineContainer }
end
local function assertIndexedInstance(index: any, target: any, label: string)
	local existing = index.byIdentity[studioObjectIdentityKey(target.identity)]
	if existing == nil or not sameInstanceTarget(existing.target, target) then error(label) end
end
local function mutationParentFromIndex(index: any, parent: any, label: string): any
	if typeof(parent) ~= "table" then error(label) end
	if parent.kind == "instance" then
		-- A parent is a structural anchor, not an authored target. Complete
		-- project indexes intentionally include engine-owned and unsupported
		-- classes (for example StarterPlayerScripts) so child creation can be
		-- identity-bound without granting the parent a writable capability.
		local target = indexedTarget(parent.identity, parent.path, parent.className)
		assertIndexedInstance(index, target, label)
		return index.byIdentity[studioObjectIdentityKey(target.identity)]
	end
	if parent.kind ~= "engine_container" or Generated.authoringContainerClass(parent.path) ~= parent.className then error(label) end
	local identityKey = index.byEngineContainer[parent.path .. "\\0" .. parent.className]
	local value = identityKey == nil and nil or index.byIdentity[identityKey]
	if value == nil then error(label) end
	return value
end
-- A sealed transaction may create a parent and a child in the same recording.
-- The parent is not yet in the project index, but it is still an exact target:
-- its identity, final path, and class must match the virtual create entry. This
-- helper deliberately admits only that closed virtual case. Existing parents
-- continue through mutationParentFromIndex, which verifies their pre-Apply
-- identity/path/class binding against the freshly captured project index.
local function mutationParentFromTopology(index: any, entries: any, parent: any, label: string): any
	if typeof(parent) ~= "table" or parent.kind ~= "instance" then return mutationParentFromIndex(index, parent, label) end
	local target = indexedTarget(parent.identity, parent.path, parent.className)
	local key = studioObjectIdentityKey(target.identity)
	local indexed = index.byIdentity[key]
	if indexed ~= nil then
		if not sameInstanceTarget(indexed.target, target) then error(label) end
		return entries[key]
	end
	local virtual = entries[key]
	if virtual == nil or virtual.initial or not sameInstanceTarget(virtual.target, target) then error(label) end
	return virtual
end
-- Validate the whole pending hierarchy as one transaction, before preflight
-- or ChangeHistory recording. Per-operation checks cannot see two creates
-- choosing one final sibling slot, moves forming a cycle, or an otherwise
-- valid operation that becomes meaningless because an ancestor is deleted.
-- All graph keys remain original identities; enrollment only changes the
-- canonical identities emitted into post-state evidence.
local function buildVirtualMutationTopology(changeSet: any, index: any, enrollments: any): any
	local entries, operationTargets, operationParents, parentIdentities, pendingParents, createdTargetKeys = {}, {}, {}, {}, {}, {}
	for key, value in pairs(index.byIdentity) do
		entries[key] = {
			target = value.target,
			path = value.target.path,
			className = value.target.className,
			name = value.name,
			initialName = value.name,
			parentKey = if value.parentIdentity == nil then nil else studioObjectIdentityKey(value.parentIdentity),
			initialParentKey = if value.parentIdentity == nil then nil else studioObjectIdentityKey(value.parentIdentity),
			initial = true,
			topologyChanged = false,
			properties = table.clone(value.coveredProperties),
			initialProperties = table.clone(value.coveredProperties),
		}
	end
	for _, sourceKey in ipairs(sortedNames(enrollments.byIdentity, "invalid mutation enrollment map")) do
		local enrolled = enrollments.byIdentity[sourceKey]
		local durableKey = studioObjectIdentityKey(enrolled)
		if durableKey ~= sourceKey and entries[durableKey] ~= nil then error("mutation enrollment durable identity already exists in project index") end
	end
	local operationIds, operationByTarget, operationReferenceKeys, movedTargets, deleteRoots, deleteRootKeys = {}, {}, {}, {}, {}, {}
	local function bindOperationTarget(operation: any, targetKey: any)
		if operationByTarget[targetKey] ~= nil then error("duplicate virtual operation target") end
		operationByTarget[targetKey] = operation
	end
	for _, operation in ipairs(changeSet.operations) do
		if typeof(operation) ~= "table" then error("invalid creator operation") end
		local operationId = nonEmpty(operation.id, "invalid creator operation id")
		if operationIds[operationId] then error("duplicate creator operation id") end
		operationIds[operationId] = true
		local kind = operation.kind
		if kind == "create" then
			if typeof(operation.target) ~= "table" or typeof(operation.target.identity) ~= "table" or operation.target.identity.kind ~= "forge_attribute" then error("create target must have a Forge identity") end
			-- A create below an independently moved parent carries its final path
			-- in the sealed change set, while its parent remains an exact
			-- pre-Apply handle. The final graph below verifies the path after all
			-- placements have been applied; never reconstruct it from the stale
			-- parent display path here.
			local target = mutationTarget(operation.target.identity, operation.target.path, operation.className)
			if Generated.classMetadata(target.className) == nil or Generated.classMetadata(target.className).creatable ~= true then error("create class outside manifest") end
			local targetKey = studioObjectIdentityKey(target.identity)
			if entries[targetKey] ~= nil then error("create target already exists in virtual project topology") end
			if enrollments.byStableId[target.identity.stableId] ~= nil then error("create target collides with mutation enrollment stable identity") end
			if target.path ~= operation.target.path or target.className ~= operation.target.className then error("create target structure mismatch") end
			entries[targetKey] = { target = target, path = target.path, className = target.className, name = studioInstanceName(operation.name, "invalid mutation name"), parentKey = nil, initialParentKey = nil, initial = false, topologyChanged = true }
			createdTargetKeys[targetKey] = true
			operationTargets[operationId] = targetKey
			bindOperationTarget(operation, targetKey)
			pendingParents[operationId] = operation.parent
		elseif kind == "update" or kind == "edit_source" or kind == "delete" or kind == "move" then
			local target = mutationTarget(operation.target.identity, operation.target.path, operation.target.className)
			assertIndexedInstance(index, target, "mutation target missing from project index")
			local targetKey = studioObjectIdentityKey(target.identity)
			local entry = entries[targetKey]
			if entry == nil or entry.initial ~= true then error("mutation target is not an initial project object") end
			operationTargets[operationId] = targetKey
			bindOperationTarget(operation, targetKey)
			if kind == "update" then
				for _, propertyName in ipairs(sortedNames(operation.properties, "invalid mutation properties")) do
					local metadata = Generated.propertyMetadata(entry.className, propertyName)
					if metadata == nil then error("mutation property outside manifest") end
					entry.properties[propertyName] = Generated.validateValue(metadata.codec, operation.properties[propertyName], metadata)
				end
			end
			if kind == "move" then
				if movedTargets[targetKey] then error("duplicate virtual move target") end
				movedTargets[targetKey] = operationId
				pendingParents[operationId] = operation.parent
				for _, propertyName in ipairs(sortedNames(operation.properties, "invalid mutation properties")) do
					local metadata = Generated.propertyMetadata(entry.className, propertyName)
					if metadata == nil then error("mutation property outside manifest") end
					entry.properties[propertyName] = Generated.validateValue(metadata.codec, operation.properties[propertyName], metadata)
				end
			elseif kind == "delete" then
				if deleteRoots[targetKey] ~= nil then error("duplicate virtual delete target") end
				deleteRoots[targetKey] = operationId
				table.insert(deleteRootKeys, targetKey)
			end
		else
			error("creator operation outside manifest")
		end
	end
	-- Resolve parent handles only after every create has an identity-bound
	-- virtual entry. This makes sibling creates, nested creates, and moves into
	-- a newly-created parent one transaction graph rather than three special
	-- cases, while retaining strict index checks for pre-existing parents.
	for _, operation in ipairs(changeSet.operations) do
		if operation.kind == "create" or operation.kind == "move" then
			local parent = mutationParentFromTopology(index, entries, pendingParents[operation.id], operation.kind .. " parent missing from project index or virtual topology")
			local targetKey = operationTargets[operation.id]
			local entry = entries[targetKey]
			if entry == nil then error("virtual mutation target disappeared") end
			entry.parentKey = studioObjectIdentityKey(parent.target.identity)
			if operation.kind == "move" then
				entry.name = studioInstanceName(operation.name, "invalid mutation name")
				entry.topologyChanged = true
			end
			operationParents[operation.id] = studioObjectIdentityKey(parent.target.identity)
			parentIdentities[operation.id] = parent.target.identity
		end
	end
	local function within(candidateKey: any, rootKey: any, initial: boolean): boolean
		local current, visited = candidateKey, {}
		while current ~= nil do
			if current == rootKey then return true end
			if visited[current] then error("project index has a cyclic hierarchy") end
			visited[current] = true
			local entry = entries[current]
			if entry == nil then return false end
			if initial and entry.initial ~= true then return false end
			current = if initial then entry.initialParentKey else entry.parentKey
		end
		return false
	end
	local function initiallyWithin(candidateKey: any, rootKey: any): boolean return within(candidateKey, rootKey, true) end
	local function finallyWithin(candidateKey: any, rootKey: any): boolean return within(candidateKey, rootKey, false) end
	local function assertReferenceSurvives(value: any)
		if value.kind ~= "instance_ref" or value.state ~= "reference" then return end
		local referenceKey = studioObjectIdentityKey(value.identity)
		local reference = indexedTarget(value.identity, value.path, value.className)
		local entry = entries[referenceKey]
		if entry == nil or not sameInstanceTarget(entry.target, reference) then error("post-state instance reference is absent from virtual topology") end
		for _, deleteKey in ipairs(deleteRootKeys) do
			-- A referenced object may be extracted from an initially deleted
			-- ancestor in the same transaction. Only final containment removes it
			-- from the post-state and makes a reference unprovable.
			if finallyWithin(referenceKey, deleteKey) then error("post-state instance reference targets a deleted subtree") end
		end
	end
	for _, operation in ipairs(changeSet.operations) do
		local operationId = operation.id
		local targetKey = operationTargets[operationId]
		for _, deleteKey in ipairs(deleteRootKeys) do
			if targetKey == deleteKey then
				if operation.kind ~= "delete" then error("mutation operation targets a deleted root") end
			elseif finallyWithin(targetKey, deleteKey) then
				error("mutation operation targets a deleted subtree")
			end
			local parentKey = operationParents[operationId]
			if parentKey ~= nil and finallyWithin(parentKey, deleteKey) then error("mutation operation parents under a deleted subtree") end
		end
		local references = {}
		if operation.properties ~= nil then
			for _, name in ipairs(sortedNames(operation.properties, "invalid mutation properties")) do
				local property = Generated.propertyMetadata(operation.target.className, name)
				if property == nil then error("mutation property outside manifest") end
				local value = Generated.validateValue(property.codec, operation.properties[name], property)
				assertReferenceSurvives(value)
				if value.kind == "instance_ref" and value.state == "reference" then table.insert(references, studioObjectIdentityKey(value.identity)) end
			end
		end
		operationReferenceKeys[operationId] = references
	end
	local deletedByIdentity = {}
	for _, key in ipairs(sortedNames(entries, "invalid virtual mutation topology")) do
		local entry = entries[key]
		for _, deleteKey in ipairs(deleteRootKeys) do
			-- Deletes remove their final identity closure. A child moved out before
			-- its former ancestor is deleted survives and must remain available to
			-- direct readback, state-delta proof, and later replay.
			if finallyWithin(key, deleteKey) then
				entry.deleted = true
				deletedByIdentity[key] = deleteRoots[deleteKey]
				break
			end
		end
	end
	-- Compile delete-descendant obligations from this same final graph rather
	-- than walking the initial index. An extracted child is not absent after
	-- the transaction and must never become an invented deletion requirement.
	local deleteDescendants = {}
	for _, operation in ipairs(changeSet.operations) do
		if operation.kind == "delete" then deleteDescendants[operation.id] = {} end
	end
	for _, key in ipairs(sortedNames(entries, "invalid virtual mutation topology")) do
		local deleteOperation = deletedByIdentity[key]
		if deleteOperation ~= nil and operationTargets[deleteOperation] ~= key then
			table.insert(deleteDescendants[deleteOperation], entries[key].target)
		end
	end
	for operationId, descendants in pairs(deleteDescendants) do
		table.sort(descendants, function(left, right) return studioObjectIdentityKey(left.identity) < studioObjectIdentityKey(right.identity) end)
		if #descendants > Generated.manifest.limits.maximumProjectionFacts then error("deleted subtree exceeds projection bound") end
		deleteDescendants[operationId] = descendants
	end
	for _, key in ipairs(sortedNames(entries, "invalid virtual mutation topology")) do
		local entry = entries[key]
		if not entry.deleted then
			local current, visited = key, {}
			while current ~= nil do
				if visited[current] then error("virtual mutation hierarchy cycle") end
				visited[current] = true
				local currentEntry = entries[current]
				if currentEntry == nil then break end
				if currentEntry.deleted then error("virtual mutation parent is deleted") end
				current = currentEntry.parentKey
			end
		end
	end
	-- Derive every surviving path from the complete final identity graph. This
	-- deliberately includes unchanged descendants of a moved parent: display
	-- paths are evidence preconditions, not an independent source of truth.
	local resolvedPaths = {}
	local function finalPath(key: any, visiting: any): string
		local entry = entries[key]
		if entry == nil then error("virtual mutation topology lost an identity") end
		if entry.deleted then error("virtual mutation parent is deleted") end
		if resolvedPaths[key] ~= nil then return resolvedPaths[key] end
		if visiting[key] then error("virtual mutation hierarchy cycle") end
		visiting[key] = true
		local path = entry.path
		if entry.parentKey ~= nil then path = finalPath(entry.parentKey, visiting) .. "/" .. entry.name end
		visiting[key] = nil
		resolvedPaths[key] = path
		entry.path = path
		return path
	end
	for _, key in ipairs(sortedNames(entries, "invalid virtual mutation topology")) do
		if not entries[key].deleted then finalPath(key, {}) end
	end
	-- Creates declare their final path, while all existing targets retain their
	-- exact pre-Apply path. This is the same split enforced by the host
	-- transaction compiler.
	for _, operation in ipairs(changeSet.operations) do
		if operation.kind == "create" then
			local entry = entries[operationTargets[operation.id]]
			if entry == nil or entry.deleted or operation.target.path ~= entry.path then error("create target structure mismatch") end
		end
	end
	-- Rebuild the host's deterministic dependency order. The sealed operation
	-- bytes are approval authority, so a valid graph is not sufficient: their
	-- submitted sequence must exactly equal the derived canonical safe order.
	-- StudioAuthoring may consume this returned order only after that equality
	-- is proven; it must never silently reorder an approved change set.
	local dependencies = {}
	for _, operation in ipairs(changeSet.operations) do dependencies[operation.id] = {} end
	local function addDependency(operationId: any, dependencyId: any)
		if operationId ~= dependencyId then dependencies[operationId][dependencyId] = true end
	end
	for _, operation in ipairs(changeSet.operations) do
		if operation.kind == "create" or operation.kind == "move" then
			local parentKey = operationParents[operation.id]
			local parentOperation = if parentKey == nil then nil else operationByTarget[parentKey]
			if parentOperation ~= nil and parentOperation.kind == "create" then addDependency(operation.id, parentOperation.id) end
		end
		for _, referenceKey in ipairs(operationReferenceKeys[operation.id] or {}) do
			local referencedOperation = operationByTarget[referenceKey]
			-- StudioAuthoring allocates every approved create as a detached,
			-- transaction-local handle before it begins canonical live mutation.
			-- Two creates may therefore reference each other (or themselves) without
			-- creating an artificial dependency cycle. Non-create operations still
			-- wait for the referenced create to become a live exact target.
			if referencedOperation ~= nil and referencedOperation.kind == "create" and operation.kind ~= "create" then addDependency(operation.id, referencedOperation.id) end
		end
	end
	-- A delete may follow a move that extracts an initially nested subtree. The
	-- move is the event that makes the final surviving graph real, so force the
	-- delete to wait for it. Ancestor-move dependencies below already make that
	-- extraction wait for path-sensitive work inside the extracted subtree.
	for _, deleteOperation in ipairs(changeSet.operations) do
		if deleteOperation.kind == "delete" then
			local deleteKey = operationTargets[deleteOperation.id]
			for _, candidate in ipairs(changeSet.operations) do
				if candidate.kind == "move" then
					local candidateKey = operationTargets[candidate.id]
					if initiallyWithin(candidateKey, deleteKey) and not finallyWithin(candidateKey, deleteKey) then addDependency(deleteOperation.id, candidate.id) end
				end
			end
		end
	end
	-- StudioAuthoring resolves every target, parent, and instance reference
	-- against the pre-Apply hierarchy. An ancestor move is therefore the last
	-- path-sensitive operation in its subtree.
	for _, mover in ipairs(changeSet.operations) do
		if mover.kind == "move" then
			local moverKey = operationTargets[mover.id]
			for _, candidate in ipairs(changeSet.operations) do
				if candidate.id ~= mover.id then
					local candidateKey = operationTargets[candidate.id]
					local candidateParent = operationParents[candidate.id]
					local pathSensitive = initiallyWithin(candidateKey, moverKey) or finallyWithin(candidateKey, moverKey)
					if candidateParent ~= nil then
						pathSensitive = pathSensitive or initiallyWithin(candidateParent, moverKey) or finallyWithin(candidateParent, moverKey)
					end
					for _, referenceKey in ipairs(operationReferenceKeys[candidate.id] or {}) do
						pathSensitive = pathSensitive or initiallyWithin(referenceKey, moverKey) or finallyWithin(referenceKey, moverKey)
					end
					if pathSensitive then addDependency(mover.id, candidate.id) end
				end
			end
		end
	end
	local function initialSibling(parentKey: any, name: any, exceptKey: any): any
		for _, key in ipairs(sortedNames(entries, "invalid virtual mutation topology")) do
			local entry = entries[key]
			if key ~= exceptKey and entry.initial and entry.initialParentKey == parentKey and entry.initialName == name then return key end
		end
		return nil
	end
	local function operationThatFrees(occupantKey: any): any
		if deletedByIdentity[occupantKey] ~= nil then return deletedByIdentity[occupantKey] end
		local operation = operationByTarget[occupantKey]
		if operation == nil or operation.kind ~= "move" then return nil end
		local entry = entries[occupantKey]
		if entry == nil or entry.initialParentKey == entry.parentKey and entry.initialName == entry.name then return nil end
		return operation.id
	end
	for _, operation in ipairs(changeSet.operations) do
		if operation.kind == "create" or operation.kind == "move" then
			local targetKey = operationTargets[operation.id]
			local occupantKey = initialSibling(operationParents[operation.id], operation.name, targetKey)
			if occupantKey ~= nil then
				local freeingOperation = operationThatFrees(occupantKey)
				if freeingOperation == nil then error("virtual mutation sibling collision") end
				addDependency(operation.id, freeingOperation)
			end
		end
	end
	for _, key in ipairs(sortedNames(entries, "invalid virtual mutation topology")) do
		local entry = entries[key]
		if entry.initial and not entry.deleted and entry.initialProperties ~= nil then
			for _, name in ipairs(sortedNames(entry.initialProperties, "invalid project-index covered properties")) do
				local value = entry.initialProperties[name]
				if typeof(value) == "table" and value.kind == "instance_ref" and value.state == "reference" then
					local referenceKey = studioObjectIdentityKey(value.identity)
					local deleteOperation = deletedByIdentity[referenceKey]
					if deleteOperation ~= nil then
						local updater = operationByTarget[key]
						if updater == nil or (updater.kind ~= "update" and updater.kind ~= "move") then error("virtual mutation leaves covered inbound instance_ref to deleted identity") end
						local finalValue = entry.properties[name]
						if typeof(finalValue) == "table" and finalValue.kind == "instance_ref" and finalValue.state == "reference" and studioObjectIdentityKey(finalValue.identity) == referenceKey then error("virtual mutation leaves covered inbound instance_ref to deleted identity") end
						addDependency(deleteOperation, updater.id)
					end
				end
			end
		end
	end
	local remaining, canonicalOrder = {}, {}
	for _, operation in ipairs(changeSet.operations) do
		local copy = {}
		for dependencyId in pairs(dependencies[operation.id]) do copy[dependencyId] = true end
		remaining[operation.id] = copy
	end
	while next(remaining) ~= nil do
		local available = {}
		for operationId, operationDependencies in pairs(remaining) do
			if next(operationDependencies) == nil then table.insert(available, operationId) end
		end
		table.sort(available)
		if #available == 0 then error("creator change set has no canonical safe topology order") end
		for _, operationId in ipairs(available) do remaining[operationId] = nil; table.insert(canonicalOrder, operationId) end
		for _, operationDependencies in pairs(remaining) do
			for _, operationId in ipairs(available) do operationDependencies[operationId] = nil end
		end
	end
	for ordinal, operation in ipairs(changeSet.operations) do
		if canonicalOrder[ordinal] ~= operation.id then error("creator change set violates canonical safe topology order") end
	end
	local siblingSlots = {}
	for _, key in ipairs(sortedNames(entries, "invalid virtual mutation topology")) do
		local entry = entries[key]
		if not entry.deleted and entry.parentKey ~= nil then
		local slot = entry.parentKey .. "\\0" .. entry.name
		local prior = siblingSlots[slot]
		-- An index can carry duplicate display paths as non-authoritative
		-- diagnostics. Only a proposed placement may create an ambiguity; exact
		-- identity remains the authority handle for pre-existing rows.
		if prior ~= nil and (prior.topologyChanged or entry.topologyChanged) then error("virtual mutation sibling collision") end
		siblingSlots[slot] = entry
		end
	end
	local postTargets = {}
	for _, key in ipairs(sortedNames(entries, "invalid virtual mutation topology")) do
		local entry = entries[key]
		if not entry.deleted then
			postTargets[key] = indexedTarget(postMutationIdentity(entry.target.identity, enrollments), entry.path, entry.className)
		end
	end
	return { parentIdentities = parentIdentities, postTargets = postTargets, enrollments = enrollments, canonicalOperationIds = canonicalOrder, operationTargets = operationTargets, createdTargetKeys = createdTargetKeys, deleteDescendants = deleteDescendants }
end
local function compiledMutationTopologyFromIndex(changeSet: any, beforeCapture: any): (any, any)
	local index = completeProjectIndex(beforeCapture)
	if typeof(changeSet) ~= "table" or changeSet.kind ~= "CreatorChangeSet" then error("invalid sealed creator change set") end
	sequence(changeSet.operations, "creator change set operations")
	if #changeSet.operations == 0 or #changeSet.operations > Generated.manifest.limits.maximumOperations then error("creator mutation operation bound") end
	return index, buildVirtualMutationTopology(changeSet, index, buildTransactionEnrollmentMap(changeSet))
end
-- StudioAuthoring consumes the exact same compiled transaction graph as the
-- proof compiler. It is intentionally a narrow read-only helper: callers get
-- ordering and exact post-target bindings, never a generic path resolver.
function Generated.compileMutationTransactionTopologyFromIndex(changeSet: any, beforeCapture: any): any
	local _, topology = compiledMutationTopologyFromIndex(changeSet, beforeCapture)
	return topology
end
-- Keep the index traversal independently executable: it is the shared
-- pre-hash boundary for production recompilation and provider-free tests.
function Generated.compileMutationProjectionInputsFromIndex(changeSet: any, beforeCapture: any): any
	local index, topology = compiledMutationTopologyFromIndex(changeSet, beforeCapture)
	return {
		requirements = Generated.compileMutationRequirements(changeSet, topology.deleteDescendants, topology.parentIdentities, topology),
	}
end
function Generated.recompileMutationProjectionFromIndex(changeSet: any, template: any, beforeCapture: any): any
	if typeof(template) ~= "table" or template.kind ~= "StudioEvidenceProjection" then error("invalid mutation projection template") end
	if template.manifestHash ~= Generated.manifestHash or (template.purpose ~= "mutation_direct_readback" and template.purpose ~= "mutation_preflight") then error("invalid mutation projection purpose") end
	local compiled = Generated.compileMutationProjectionInputsFromIndex(changeSet, beforeCapture)
	local roots = table.clone(Generated.authoringRoots)
	local candidate: any = { kind = "StudioEvidenceProjection", id = nonEmpty(template.id, "invalid mutation projection id"), manifestHash = Generated.manifestHash, purpose = template.purpose, project = template.project, binding = template.binding, bindingHash = "", requirements = compiled.requirements, scope = { roots = roots }, bounds = { maximumFacts = Generated.manifest.limits.maximumProjectionFacts, maximumBytes = Generated.manifest.limits.maximumProjectionBytes, roots = table.clone(roots) } }
	candidate.bindingHash = bindingHash(candidate.binding)
	candidate.contentHash = Generated.projectionHash(candidate)
	Generated.validateProjection(candidate)
	return candidate
end
function Generated.assertRecompiledMutationProjectionFromIndex(changeSet: any, declared: any, beforeCapture: any): any
	Generated.validateProjection(declared)
	local recompiled = Generated.recompileMutationProjectionFromIndex(changeSet, declared, beforeCapture)
	if recompiled.contentHash ~= declared.contentHash or Generated.projectionMaterial(recompiled) ~= Generated.projectionMaterial(declared) then error("mutation projection project-index recompilation mismatch") end
	return recompiled
end
return Generated
`;
}

function renderLuauProjectAuthority() {
  const vectorLines = projectIdentityAuthorityVectorTable()
    .map((vector) => `\t${luaTable(vector)},`)
    .join("\n");
  return `--!strict
-- Generated by scripts/generate-studio-evidence.mjs from the dependency-floor
-- project-identity authority recipe. Do not hand-copy this into Runtime.
local Hash = if script ~= nil then require(script.Parent.Hash) else require("./Hash")
local Canonical = if script ~= nil then require(script.Parent.StudioProjectIndexCanonical) else require("./StudioProjectIndexCanonical")

local StudioProjectAuthority = {}
StudioProjectAuthority.recipe = ${luaTable(PROJECT_IDENTITY_AUTHORITY_RECIPE)}
StudioProjectAuthority.vectors = {
${vectorLines}
}

local recipe = StudioProjectAuthority.recipe

local function isHash(value: any): boolean
	return typeof(value) == "string" and #value == 64 and string.match(value, "^[0-9a-f]+$") ~= nil
end

local function isSession(value: any): boolean
	return typeof(value) == "string" and value ~= "" and string.find(value, "%s") == nil
end

local function isForgeProjectId(value: any): boolean
	return typeof(value) == "string" and #value == 46 and string.match(value, "^forge_project_[0-9a-f]+$") ~= nil
end

local function isStudioProjectId(value: any): boolean
	return typeof(value) == "string" and #value == 39 and string.match(value, "^studio_project_[0-9a-f]+$") ~= nil
end

local function authorityKey(identity: any, sessionId: string): (string, boolean, string?)
	if typeof(identity) ~= "table" or not isHash(identity.hash) or typeof(identity.project) ~= "table" or typeof(identity.reservedAttribute) ~= "table" then
		error("project identity authority is malformed")
	end
	local project = identity.project
	if typeof(project.name) ~= "string" or project.name == "" or typeof(project.placeId) ~= "number" or typeof(project.universeId) ~= "number"
		or project.placeId < 0 or project.universeId < 0 or project.placeId % 1 ~= 0 or project.universeId % 1 ~= 0
		or (project.placeId == 0) ~= (project.universeId == 0)
	then error("project identity authority project is malformed") end
	local attribute = identity.reservedAttribute
	if attribute.status == "observed" and not isForgeProjectId(attribute.forgeProjectId) then error("project identity authority attribute is malformed") end
	if attribute.status == "invalid" and (typeof(attribute.valueType) ~= "string" or attribute.valueType == "" or #attribute.valueType > 64) then error("project identity authority attribute is malformed") end
	if attribute.status ~= "absent" and attribute.status ~= "observed" and attribute.status ~= "invalid" then error("project identity authority attribute is malformed") end
	if project.placeId ~= 0 then return recipe.publishedPrefix .. tostring(project.universeId) .. ":" .. tostring(project.placeId), true, nil end
	if attribute.status == "observed" then return recipe.linkedPrefix .. attribute.forgeProjectId, true, attribute.forgeProjectId end
	if not isSession(sessionId) then error("project identity authority requires an exact session ID") end
	return recipe.localUnlinkedPrefix .. identity.hash .. recipe.pairingDelimiter .. sessionId, false, nil
end

function StudioProjectAuthority.derive(input: any): any
	if typeof(input) ~= "table" or not isSession(input.sessionId) or not isHash(input.connectorBuildHash) then
		error("project identity authority input is malformed")
	end
	local key, durable, linkedProjectId = authorityKey(input.identity, input.sessionId)
	local projectId = recipe.projectIdPrefix .. string.sub(Hash.sha256(key), 1, recipe.projectIdHashChars)
	return {
		projectId = projectId,
		conversationProjectId = if not durable then projectId else (linkedProjectId or projectId),
		connectorEpoch = Hash.sha256(Canonical.material({
			kind = recipe.connectorEpochKind,
			sessionId = input.sessionId,
			projectId = projectId,
			connectorBuildHash = input.connectorBuildHash,
		})),
	}
end

function StudioProjectAuthority.adopt(input: any): any
	if typeof(input) ~= "table" or not isStudioProjectId(input.currentProjectId) then
		error("project identity authority current project ID is malformed")
	end
	local authority = StudioProjectAuthority.derive(input)
	authority.authorityChanged = input.currentProjectId ~= authority.projectId
	return authority
end

return StudioProjectAuthority
`;
}

function canonicalVectors() {
  return [
    vector("nullable_physical_properties_nil", {
      kind: "nil",
      expectedCodec: "physical_properties",
    }),
    vector("boolean_false", { kind: "boolean", value: false }),
    vector("number_f32_negative_zero", { kind: "number_f32", value: -0 }),
    vector("number_f32_rounding", {
      kind: "number_f32",
      value: Math.fround(1 / 3),
    }),
    vector("number_f64_negative_zero", { kind: "number_f64", value: -0 }),
    vector("int32_minimum", { kind: "int32", value: -2_147_483_648 }),
    vector("int64_decimal_maximum_exact", {
      kind: "int64_decimal",
      value: "9007199254740991",
    }),
    vector("content", { kind: "content", value: "rbxassetid://12345" }),
    vector("rgb8", { kind: "color3_rgb8", r: 12, g: 128, b: 255 }),
    vector("vector2", {
      kind: "vector2_f32",
      x: Math.fround(-1.25),
      y: Math.fround(99.5),
    }),
    vector("vector3", {
      kind: "vector3_f32",
      x: Math.fround(-1.25),
      y: Math.fround(0),
      z: Math.fround(99.5),
    }),
    vector("cframe", {
      kind: "cframe_f32x12",
      components: [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1].map(Math.fround),
    }),
    vector("udim", { kind: "udim", scale: Math.fround(0.25), offset: -12 }),
    vector("udim2", {
      kind: "udim2",
      x: { scale: Math.fround(0.25), offset: -12 },
      y: { scale: Math.fround(0.75), offset: 48 },
    }),
    vector("rect", {
      kind: "rect",
      minX: Math.fround(-2),
      minY: Math.fround(-1),
      maxX: Math.fround(3),
      maxY: Math.fround(4),
    }),
    vector("number_range", {
      kind: "number_range",
      min: Math.fround(-1.5),
      max: Math.fround(2.5),
    }),
    vector("number_sequence", {
      kind: "number_sequence",
      keypoints: [
        { time: 0, value: 0, envelope: 0 },
        {
          time: Math.fround(0.5),
          value: Math.fround(0.75),
          envelope: Math.fround(0.125),
        },
        { time: 1, value: 1, envelope: 0 },
      ],
    }),
    vector("color_sequence", {
      kind: "color_sequence",
      keypoints: [
        { time: 0, color: { r: 0, g: 12, b: 255 } },
        { time: 1, color: { r: 255, g: 128, b: 0 } },
      ],
    }),
    vector("brick_color", { kind: "brick_color", name: "Really red" }),
    vector("font", {
      kind: "font",
      family: "rbxasset://fonts/families/Arial.json",
      weight: "Regular",
      style: "Normal",
    }),
    vector("physical_properties", {
      kind: "physical_properties",
      density: Math.fround(0.7),
      friction: Math.fround(0.25),
      elasticity: Math.fround(0.5),
      frictionWeight: Math.fround(0.75),
      elasticityWeight: 1,
    }),
    vector("axes", { kind: "axes", x: true, y: false, z: true }),
    vector("faces", {
      kind: "faces",
      top: true,
      bottom: false,
      left: true,
      right: false,
      front: true,
      back: false,
    }),
    vector("ray", {
      kind: "ray",
      origin: { x: Math.fround(-1), y: Math.fround(2), z: Math.fround(-3) },
      direction: { x: Math.fround(4), y: Math.fround(5), z: Math.fround(6) },
    }),
    vector("instance_ref_nil", {
      kind: "instance_ref",
      state: "nil",
      expectedClass: "BasePart",
    }),
    vector("instance_ref", {
      kind: "instance_ref",
      state: "reference",
      identity: { kind: "forge_attribute", stableId: "reference-1" },
      path: "Workspace/Reference",
      className: "Part",
      expectedClass: "BasePart",
    }),
    vector("instance_ref_ephemeral", {
      kind: "instance_ref",
      state: "reference",
      identity: {
        kind: "studio_ephemeral",
        connectorEpoch: "connector_epoch_vector",
        opaqueHash: "a".repeat(64),
      },
      path: "Workspace/Reference",
      className: "Part",
      expectedClass: "BasePart",
    }),
    vector("instance_ref_rojo", {
      kind: "instance_ref",
      state: "reference",
      identity: {
        kind: "rojo_sourcemap",
        authorityMapHash: "b".repeat(64),
        sourcemapHash: "c".repeat(64),
        mappingId: "workspace-reference",
      },
      path: "Workspace/Reference",
      className: "Part",
      expectedClass: "BasePart",
    }),
    vector("enum", { kind: "enum_name", value: "SmoothPlastic" }),
    vector("utf8", { kind: "string_utf8", value: "forge-✓" }),
  ];
}
function vector(name, value) {
  return { name, value, material: valueMaterial(value) };
}

/**
 * These are executable cross-language authority fixtures. The first records
 * the exact session, identity, host project id, and connector epoch from the
 * initial-Link incident; subsequent rows force pair/heartbeat, rename, Link,
 * Fork, publication, and duplicate-name/session separation through one recipe.
 */
function projectIdentityAuthorityVectorTable() {
  const buildHash = "5caa65f497adbc98a70bf168ff94bea69292b96fa05ede2e74d949d8b22c27ea";
  const incidentSessionId = "studio_9df118b2-8676-4017-b67c-d82b8d4fbade";
  const absent = (name, hash) => ({
    hash,
    project: { name, placeId: 0, universeId: 0 },
    reservedAttribute: { status: "absent" },
  });
  const linked = (forgeProjectId) => ({
    hash: "f".repeat(64),
    project: { name: "game.rbxlx", placeId: 0, universeId: 0 },
    reservedAttribute: { status: "observed", forgeProjectId },
  });
  const incident = {
    sessionId: incidentSessionId,
    connectorBuildHash: buildHash,
    identity: absent(
      "game.rbxlx",
      "970536638f6054490813fa1dc84371f1b2a39c2c9ebf9119684b84c64406b195",
    ),
  };
  const incidentExpected = deriveProjectIdentityAuthorityVector(incident);
  if (
    incidentExpected.projectId !== "studio_project_386d33ca55e9c808989e39c1" ||
    incidentExpected.connectorEpoch !==
      "27ae667038a4a2dc82d04fc7102b5d18e54983d979d8ba2b8d26bca4058aec24"
  )
    throw new Error("Project authority incident vector drifted");
  const duplicateSession = {
    ...incident,
    sessionId: "studio_6f587eea-c279-4875-a2b7-8d9ac2ab6bd0",
  };
  const renamed = {
    ...incident,
    identity: absent("renamed-game.rbxlx", "a".repeat(64)),
  };
  const linkedIdentity = {
    sessionId: incidentSessionId,
    connectorBuildHash: buildHash,
    identity: linked("forge_project_4dc98cbbee964b2d84c57c440ff92e8b"),
  };
  const forkedIdentity = {
    sessionId: incidentSessionId,
    connectorBuildHash: buildHash,
    identity: linked("forge_project_1234567890abcdef1234567890abcdef"),
  };
  const invalidIdentity = {
    sessionId: incidentSessionId,
    connectorBuildHash: buildHash,
    identity: {
      hash: "d".repeat(64),
      project: { name: "invalid-identity-game.rbxlx", placeId: 0, universeId: 0 },
      reservedAttribute: { status: "invalid", valueType: "number" },
    },
  };
  const published = {
    sessionId: incidentSessionId,
    connectorBuildHash: buildHash,
    identity: {
      hash: "e".repeat(64),
      project: { name: "game.rbxlx", placeId: 2468, universeId: 1357 },
      reservedAttribute: {
        status: "observed",
        forgeProjectId: "forge_project_4dc98cbbee964b2d84c57c440ff92e8b",
      },
    },
  };
  return [
    {
      name: "incident_local_unlinked_pair_and_heartbeat",
      input: incident,
      expected: incidentExpected,
    },
    {
      name: "duplicate_local_name_different_session",
      input: duplicateSession,
      expected: deriveProjectIdentityAuthorityVector(duplicateSession),
    },
    {
      name: "local_unlinked_rename",
      input: renamed,
      expected: deriveProjectIdentityAuthorityVector(renamed),
    },
    {
      name: "local_linked",
      input: linkedIdentity,
      expected: deriveProjectIdentityAuthorityVector(linkedIdentity),
    },
    {
      name: "local_forked",
      input: forkedIdentity,
      expected: deriveProjectIdentityAuthorityVector(forkedIdentity),
    },
    {
      name: "local_invalid_reserved_attribute",
      input: invalidIdentity,
      expected: deriveProjectIdentityAuthorityVector(invalidIdentity),
    },
    {
      name: "published_continuity",
      input: published,
      expected: deriveProjectIdentityAuthorityVector(published),
    },
  ];
}

function deriveProjectIdentityAuthorityVector(input) {
  const { identity } = input;
  const project = identity.project;
  const published = project.placeId !== 0;
  const authorityKey = published
    ? `${PROJECT_IDENTITY_AUTHORITY_RECIPE.publishedPrefix}${project.universeId}:${project.placeId}`
    : identity.reservedAttribute.status === "observed"
      ? `${PROJECT_IDENTITY_AUTHORITY_RECIPE.linkedPrefix}${identity.reservedAttribute.forgeProjectId}`
      : `${PROJECT_IDENTITY_AUTHORITY_RECIPE.localUnlinkedPrefix}${identity.hash}${PROJECT_IDENTITY_AUTHORITY_RECIPE.pairingDelimiter}${input.sessionId}`;
  const projectId = `${PROJECT_IDENTITY_AUTHORITY_RECIPE.projectIdPrefix}${sha256(authorityKey).slice(0, PROJECT_IDENTITY_AUTHORITY_RECIPE.projectIdHashChars)}`;
  return {
    projectId,
    conversationProjectId:
      !published && identity.reservedAttribute.status === "observed"
        ? identity.reservedAttribute.forgeProjectId
        : projectId,
    connectorEpoch: sha256(
      projectIndexMaterial({
        kind: PROJECT_IDENTITY_AUTHORITY_RECIPE.connectorEpochKind,
        sessionId: input.sessionId,
        projectId,
        connectorBuildHash: input.connectorBuildHash,
      }),
    ),
  };
}

/**
 * These vectors are shared with StudioProjectIndexCanonical.luau. They cover
 * the generic evidence tree rather than a Studio codec: tagged fields,
 * byte-length-delimited UTF-8, IEEE binary64 numbers, deterministic object
 * ordering, and all three closed object-identity variants.
 */
function projectIndexCanonicalVectors() {
  const values = [
    ["boolean_false", false],
    ["float64_negative_zero", -0],
    ["float64_fraction", 1 / 3],
    ["utf8_and_sorted_keys", { é: "forge-✓", a: [true, 7] }],
    [
      "identity_forge",
      {
        identity: { kind: "forge_attribute", stableId: "object-1" },
        displayPath: "Workspace/Part",
        name: "Part",
      },
    ],
    [
      "identity_ephemeral",
      {
        identity: {
          kind: "studio_ephemeral",
          connectorEpoch: "epoch-vector",
          opaqueHash: "a".repeat(64),
        },
        displayPath: "Workspace/Part",
        name: "Part",
      },
    ],
    [
      "identity_rojo",
      {
        identity: {
          kind: "rojo_sourcemap",
          authorityMapHash: "b".repeat(64),
          sourcemapHash: "c".repeat(64),
          mappingId: "workspace-part",
        },
        displayPath: "Workspace/Part",
        name: "Part",
      },
    ],
    [
      "connector_epoch",
      {
        kind: "StudioConnectorEpoch",
        sessionId: "studio_session_vector",
        projectId: "studio_project_vector",
        connectorBuildHash: "d".repeat(64),
      },
    ],
  ];
  return values.map(([name, value]) => ({
    name,
    value,
    material: projectIndexMaterial(value),
  }));
}

function projectIndexMaterial(value) {
  if (value === null) return tagged("null", "");
  if (typeof value === "boolean") return tagged("boolean", value ? "1" : "0");
  if (typeof value === "string") return tagged("utf8", checkedUtf8(value));
  if (typeof value === "number") return tagged("float64", f64Bits(value));
  if (Array.isArray(value))
    return tagged("array", projectIndexSequence(value.map(projectIndexMaterial)));
  if (!value || typeof value !== "object")
    throw new Error("Unsupported project-index material value");
  const keys = Object.keys(value).sort(compareUtf8);
  return tagged(
    "object",
    projectIndexSequence(
      keys.map((key) =>
        tagged(
          "entry",
          tagged("key", checkedUtf8(key)) + tagged("value", projectIndexMaterial(value[key])),
        ),
      ),
    ),
  );
}

function projectIndexSequence(parts) {
  return tagged(
    "sequence",
    tagged("count", String(parts.length)) + parts.map((part) => tagged("item", part)).join(""),
  );
}

function checkedUtf8(value) {
  if (Buffer.from(value, "utf8").toString("utf8") !== value)
    throw new Error("Project-index material contains invalid UTF-8");
  return value;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function studioObjectIdentityKey(identity) {
  if (!identity || typeof identity !== "object")
    throw new Error("invalid Studio object identity vector");
  if (identity.kind === "forge_attribute" && typeof identity.stableId === "string")
    return `forge_attribute:${identity.stableId}`;
  if (
    identity.kind === "studio_ephemeral" &&
    typeof identity.connectorEpoch === "string" &&
    typeof identity.opaqueHash === "string"
  )
    return `studio_ephemeral:${identity.connectorEpoch}:${identity.opaqueHash}`;
  if (
    identity.kind === "rojo_sourcemap" &&
    typeof identity.authorityMapHash === "string" &&
    typeof identity.sourcemapHash === "string" &&
    typeof identity.mappingId === "string"
  )
    return `rojo_sourcemap:${identity.authorityMapHash}:${identity.sourcemapHash}:${identity.mappingId}`;
  throw new Error("invalid Studio object identity vector");
}
function typescriptLiteral(value) {
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (typeof value === "string" || typeof value === "boolean" || value === null)
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(typescriptLiteral).join(", ")}]`;
  if (value && typeof value === "object")
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}: ${typescriptLiteral(entry)}`)
      .join(", ")} }`;
  throw new Error("Unsupported TypeScript literal");
}
function valueMaterial(value) {
  switch (value.kind) {
    case "nil":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) + tagged("expected-codec", value.expectedCodec),
      );
    case "boolean":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) + tagged("value", value.value ? "1" : "0"),
      );
    case "number_f32":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) + tagged("bits", f32Bits(value.value)),
      );
    case "number_f64":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) + tagged("bits", f64Bits(value.value)),
      );
    case "int32":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) + tagged("value", String(value.value)),
      );
    case "int64_decimal":
      return tagged("studio-value", tagged("codec", value.kind) + tagged("decimal", value.value));
    case "string_utf8":
      return tagged("studio-value", tagged("codec", value.kind) + tagged("utf8", value.value));
    case "content":
      return tagged("studio-value", tagged("codec", value.kind) + tagged("utf8", value.value));
    case "color3_rgb8":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) +
          tagged("r", String(value.r)) +
          tagged("g", String(value.g)) +
          tagged("b", String(value.b)),
      );
    case "vector2_f32":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) + tagged("x", f32Bits(value.x)) + tagged("y", f32Bits(value.y)),
      );
    case "vector3_f32":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) +
          tagged("x", f32Bits(value.x)) +
          tagged("y", f32Bits(value.y)) +
          tagged("z", f32Bits(value.z)),
      );
    case "cframe_f32x12":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) +
          tagged("components", taggedSequence(value.components.map(f32Bits))),
      );
    case "udim":
      return tagged("studio-value", tagged("codec", value.kind) + udimMaterial(value));
    case "udim2":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) +
          tagged("x", udimMaterial(value.x)) +
          tagged("y", udimMaterial(value.y)),
      );
    case "rect":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) +
          tagged("min-x", f32Bits(value.minX)) +
          tagged("min-y", f32Bits(value.minY)) +
          tagged("max-x", f32Bits(value.maxX)) +
          tagged("max-y", f32Bits(value.maxY)),
      );
    case "number_range":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) +
          tagged("min", f32Bits(value.min)) +
          tagged("max", f32Bits(value.max)),
      );
    case "number_sequence": {
      const keypoints = value.keypoints.map((keypoint) =>
        tagged(
          "keypoint",
          tagged("time", f32Bits(keypoint.time)) +
            tagged("value", f32Bits(keypoint.value)) +
            tagged("envelope", f32Bits(keypoint.envelope)),
        ),
      );
      return tagged(
        "studio-value",
        tagged("codec", value.kind) + tagged("keypoints", taggedSequence(keypoints)),
      );
    }
    case "color_sequence": {
      const keypoints = value.keypoints.map((keypoint) =>
        tagged(
          "keypoint",
          tagged("time", f32Bits(keypoint.time)) + tagged("color", colorMaterial(keypoint.color)),
        ),
      );
      return tagged(
        "studio-value",
        tagged("codec", value.kind) + tagged("keypoints", taggedSequence(keypoints)),
      );
    }
    case "brick_color":
      return tagged("studio-value", tagged("codec", value.kind) + tagged("name", value.name));
    case "font":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) +
          tagged("family", value.family) +
          tagged("weight", value.weight) +
          tagged("style", value.style),
      );
    case "physical_properties":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) +
          tagged("density", f32Bits(value.density)) +
          tagged("friction", f32Bits(value.friction)) +
          tagged("elasticity", f32Bits(value.elasticity)) +
          tagged("friction-weight", f32Bits(value.frictionWeight)) +
          tagged("elasticity-weight", f32Bits(value.elasticityWeight)),
      );
    case "axes":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) +
          tagged("x", value.x ? "1" : "0") +
          tagged("y", value.y ? "1" : "0") +
          tagged("z", value.z ? "1" : "0"),
      );
    case "faces":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) +
          tagged("top", value.top ? "1" : "0") +
          tagged("bottom", value.bottom ? "1" : "0") +
          tagged("left", value.left ? "1" : "0") +
          tagged("right", value.right ? "1" : "0") +
          tagged("front", value.front ? "1" : "0") +
          tagged("back", value.back ? "1" : "0"),
      );
    case "ray":
      return tagged(
        "studio-value",
        tagged("codec", value.kind) +
          tagged("origin", vector3Material(value.origin)) +
          tagged("direction", vector3Material(value.direction)),
      );
    case "instance_ref":
      return value.state === "nil"
        ? tagged(
            "studio-value",
            tagged("codec", value.kind) +
              tagged("state", "nil") +
              tagged("expected-class", value.expectedClass),
          )
        : tagged(
            "studio-value",
            tagged("codec", value.kind) +
              tagged("state", "reference") +
              tagged("identity", studioObjectIdentityKey(value.identity)) +
              tagged("path", value.path) +
              tagged("class", value.className) +
              tagged("expected-class", value.expectedClass),
          );
    case "enum_name":
      return tagged("studio-value", tagged("codec", value.kind) + tagged("name", value.value));
  }
}
function f32Bits(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, false);
  return view.getUint32(0, false).toString(16).padStart(8, "0");
}
function f64Bits(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return `${view.getUint32(0, false).toString(16).padStart(8, "0")}${view.getUint32(4, false).toString(16).padStart(8, "0")}`;
}
function udimMaterial(value) {
  return tagged(
    "udim",
    tagged("scale", f32Bits(value.scale)) + tagged("offset", String(value.offset)),
  );
}
function colorMaterial(value) {
  return tagged(
    "color",
    tagged("r", String(value.r)) + tagged("g", String(value.g)) + tagged("b", String(value.b)),
  );
}
function vector3Material(value) {
  return tagged(
    "vector3",
    tagged("x", f32Bits(value.x)) + tagged("y", f32Bits(value.y)) + tagged("z", f32Bits(value.z)),
  );
}
function tagged(tag, payload) {
  return `${Buffer.byteLength(tag, "utf8")}:${tag}${Buffer.byteLength(payload, "utf8")}:${payload}`;
}
function taggedSequence(parts) {
  return tagged("sequence", tagged("count", String(parts.length)) + parts.join(""));
}
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortObject(value[key])]),
    );
  return value;
}
function stableJson(value) {
  return JSON.stringify(sortObject(value));
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function validateSortedUnique(entries, label) {
  for (let index = 0; index < entries.length; index += 1)
    if (typeof entries[index] !== "string" || (index > 0 && entries[index - 1] >= entries[index]))
      throw new Error(`Invalid canonical ${label}`);
}
function proofIndex(value) {
  const index = [
    "canonicalize",
    "validate",
    "preflight",
    "write",
    "read",
    "project",
    "compare",
  ].indexOf(value);
  if (index === -1) throw new Error(`Unknown proof stage: ${value}`);
  return index;
}
function byName(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}
function lua(value) {
  return JSON.stringify(value);
}
function luaArray(values) {
  return `{ ${values.map(luaTable).join(", ")} }`;
}
function luaTable(value) {
  if (Array.isArray(value)) return luaArray(value);
  if (value && typeof value === "object")
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `[${lua(key)}] = ${luaTable(entry)}`)
      .join(", ")} }`;
  if (typeof value === "string") return lua(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  throw new Error("Unsupported Luau literal");
}
