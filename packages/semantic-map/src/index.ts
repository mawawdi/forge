import { readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { contentHash, stableJson, type ForgeFixtureManifest, type RelativePath, type RemoteFlowDeclaration } from "../../contracts/src/index.js";

export interface SourceFile {
  path: RelativePath;
  absolutePath: string;
  source: string;
  executionContext: "server" | "client" | "shared" | "unknown";
}

export interface SemanticScript {
  id: string;
  path: RelativePath;
  executionContext: SourceFile["executionContext"];
  sourceHash: string;
  dependencies: RelativePath[];
}

export interface SemanticInstance {
  id: string;
  path: string;
  className: string;
  parentId?: string;
  properties: Record<string, string | number | boolean>;
  attributes: Record<string, string | number | boolean>;
  tags: string[];
}

export interface SemanticRemote {
  id: string;
  path: string;
  name: string;
  className: "RemoteEvent" | "RemoteFunction";
  direction: RemoteFlowDeclaration["direction"];
  clientScript: RelativePath;
  serverScript: RelativePath;
  mechanicContractId?: string;
}

export interface SemanticRemoteFlow {
  declaration: RemoteFlowDeclaration;
  client: SourceFile;
  server: SourceFile;
  clientEvidence: { remoteCall: string; inputExpression: string } | null;
  serverEvidence: { handler: string; mutation: string; mutationExpression: string } | null;
}

export interface ProjectSemanticMap {
  kind: "ProjectSemanticMap";
  schemaVersion: 1;
  projectId: string;
  root: string;
  files: SourceFile[];
  scripts: SemanticScript[];
  modules: Array<{ id: string; path: RelativePath; sourceHash: string; dependencies: RelativePath[] }>;
  instances: SemanticInstance[];
  remotes: SemanticRemote[];
  persistentState: NonNullable<ForgeFixtureManifest["persistentState"]>;
  uiBindings: NonNullable<ForgeFixtureManifest["uiBindings"]>;
  mechanicContracts: string[];
  remoteFlows: SemanticRemoteFlow[];
  dependencies: Array<{ from: string; to: string; kind: "script" | "remote" | "state" | "contract" }>;
  hashes: { sourceHash: string; structureHash: string; semanticHash: string };
}

export interface ProjectSnapshot {
  kind: "ProjectSnapshot";
  schemaVersion: 1;
  projectId: string;
  sourceHash: string;
  structureHash: string;
  contractHash: string;
  projectSemanticHash: string;
  semanticMapHash: string;
}

export interface StudioSnapshotObservation {
  kind: "StudioSnapshotObservation";
  schemaVersion: 1;
  project: { name: string; placeId: number; universeId: number };
  capturedAt: string;
  instances: Array<{ path: string; className: string; parentPath?: string; properties: Record<string, string | number | boolean>; attributes: Record<string, string | number | boolean>; tags: string[] }>;
  scripts: Array<{ path: RelativePath; executionContext: SourceFile["executionContext"]; sourceHash: string; source?: string }>;
  remotes: Array<{ path: string; name: string; className: SemanticRemote["className"]; direction: SemanticRemote["direction"] }>;
}

export interface AffectedVerificationCone {
  changedPaths: RelativePath[];
  affectedScriptPaths: RelativePath[];
  affectedRemoteIds: string[];
  affectedMechanicContractIds: string[];
  checks: Array<"official_luau_analysis" | "replication_and_authority_contracts" | "economy" | "structure" | "studio_assertions">;
}

export interface ProjectLoadRequest {
  root: string;
  manifest: ForgeFixtureManifest;
}

export interface ProjectSourceAdapter {
  load(input: ProjectLoadRequest): Promise<ProjectSemanticMap>;
  snapshot(map: ProjectSemanticMap): ProjectSnapshot;
}

export class FilesystemProjectSourceAdapter implements ProjectSourceAdapter {
  load(input: ProjectLoadRequest): Promise<ProjectSemanticMap> { return buildSemanticMap(input.root, input.manifest); }
  snapshot(map: ProjectSemanticMap): ProjectSnapshot { return createProjectSnapshot(map); }
}

export async function buildSemanticMap(root: string, manifest: ForgeFixtureManifest): Promise<ProjectSemanticMap> {
  const canonicalRoot = resolve(root);
  for (const instance of manifest.instances ?? []) {
    assertProjectRelative(instance.path);
    if (instance.parentPath) assertProjectRelative(instance.parentPath);
  }
  const files: SourceFile[] = [];
  for (const rootPath of manifest.luauRoots) {
    assertProjectRelative(rootPath);
    await collectLuauFiles(canonicalRoot, rootPath, files);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const remoteFlows: SemanticRemoteFlow[] = [];
  for (const declaration of manifest.remoteFlows) {
    assertProjectRelative(declaration.clientScript);
    assertProjectRelative(declaration.serverScript);
    const client = byPath.get(normalizeRelative(declaration.clientScript));
    const server = byPath.get(normalizeRelative(declaration.serverScript));
    if (!client || !server) remoteFlows.push({ declaration, client: client ?? missingSource(canonicalRoot, declaration.clientScript, "client"), server: server ?? missingSource(canonicalRoot, declaration.serverScript, "server"), clientEvidence: null, serverEvidence: null });
    else remoteFlows.push({ declaration, client, server, clientEvidence: findClientEvidence(client.source, declaration), serverEvidence: findServerEvidence(server.source, declaration) });
  }

  const scripts = files.map((file) => ({ id: stableId("script", file.path), path: file.path, executionContext: file.executionContext, sourceHash: contentHash(file.source), dependencies: findDependencies(file.source) }));
  const modules = scripts.filter((script) => !script.path.endsWith(".client.luau") && !script.path.endsWith(".server.luau")).map((script) => ({ id: script.id, path: script.path, sourceHash: script.sourceHash, dependencies: script.dependencies }));
  const instances = buildInstances(files, manifest);
  const remotes = remoteFlows.map((flow) => ({ id: stableId("remote", `${flow.declaration.name}|${flow.declaration.clientScript}|${flow.declaration.serverScript}`), path: `ReplicatedStorage/Remotes/${flow.declaration.name}`, name: flow.declaration.name, className: flow.declaration.direction === "client_to_server" ? "RemoteEvent" as const : "RemoteFunction" as const, direction: flow.declaration.direction, clientScript: normalizeRelative(flow.declaration.clientScript), serverScript: normalizeRelative(flow.declaration.serverScript), mechanicContractId: `contract_${toSnakeCase(flow.declaration.name)}` })).sort((left, right) => left.path.localeCompare(right.path));
  const mechanicContracts = remotes.map((remote) => `contract_${toSnakeCase(remote.name)}`).sort();
  const dependencies = buildDependencies(scripts, remotes, manifest, mechanicContracts);
  const partial: Omit<ProjectSemanticMap, "hashes"> = { kind: "ProjectSemanticMap", schemaVersion: 1, projectId: stableId("project", canonicalRoot), root: canonicalRoot, files, scripts, modules, instances, remotes, persistentState: manifest.persistentState ?? [], uiBindings: manifest.uiBindings ?? [], mechanicContracts, remoteFlows, dependencies };
  return { ...partial, hashes: projectHashes(partial) };
}

export function createProjectSnapshot(map: ProjectSemanticMap): ProjectSnapshot {
  const canonical = canonicalProjectSemanticMap(map);
  const sourceHash = map.hashes.sourceHash;
  const structureHash = map.hashes.structureHash;
  const contractHash = contentHash(stableJson({ mechanicContracts: map.mechanicContracts, persistentState: map.persistentState, uiBindings: map.uiBindings }));
  const projectSemanticHash = contentHash(stableJson({ sourceHash, structureHash, semanticHash: map.hashes.semanticHash, contractHash }));
  return { kind: "ProjectSnapshot", schemaVersion: 1, projectId: map.projectId, sourceHash, structureHash, contractHash, projectSemanticHash, semanticMapHash: contentHash(stableJson(canonical)) };
}

export function mergeStudioObservation(map: ProjectSemanticMap, observation: StudioSnapshotObservation): ProjectSemanticMap {
  const observedScripts = new Map(observation.scripts.map((script) => [normalizeRelative(script.path), script]));
  const matchedObservedPaths = new Set<string>();
  const files = map.files.map((file) => {
    const observed = observedScripts.get(file.path) ?? uniqueObservedScript(observation.scripts, file.path, file.executionContext);
    if (observed) matchedObservedPaths.add(normalizeRelative(observed.path));
    return observed?.source !== undefined ? { ...file, source: observed.source } : file;
  });
  for (const observed of observation.scripts) {
    const path = normalizeRelative(observed.path);
    if (!matchedObservedPaths.has(path) && !files.some((file) => file.path === path)) files.push({ path, absolutePath: resolve(map.root, path), source: observed.source ?? "", executionContext: observed.executionContext });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const scripts = files.map((file) => {
    const observed = observedScripts.get(file.path) ?? uniqueObservedScript(observation.scripts, file.path, file.executionContext);
    return { id: stableId("script", file.path), path: file.path, executionContext: observed?.executionContext ?? file.executionContext, sourceHash: observed?.source !== undefined ? contentHash(observed.source) : observed?.sourceHash ?? contentHash(file.source), dependencies: findDependencies(file.source) };
  });
  const instances = observation.instances.map((instance) => ({ id: stableId("instance", `${instance.path}|${instance.className}`), path: instance.path, className: instance.className, properties: sortedRecord(instance.properties), attributes: sortedRecord(instance.attributes), tags: [...instance.tags].sort() })).sort((left, right) => left.path.localeCompare(right.path));
  const remotes = observation.remotes.map((observed) => {
    const existing = map.remotes.find((remote) => remote.path === observed.path || remote.name === observed.name);
    return { id: existing?.id ?? stableId("remote", observed.path), path: observed.path, name: observed.name, className: observed.className, direction: observed.direction, clientScript: existing?.clientScript ?? "", serverScript: existing?.serverScript ?? "", ...(existing?.mechanicContractId ? { mechanicContractId: existing.mechanicContractId } : {}) };
  });
  const partial: Omit<ProjectSemanticMap, "hashes"> = { ...map, files, scripts, modules: scripts.filter((script) => !script.path.endsWith(".client.luau") && !script.path.endsWith(".server.luau")).map((script) => ({ id: script.id, path: script.path, sourceHash: script.sourceHash, dependencies: script.dependencies })), instances, remotes };
  return { ...partial, hashes: projectHashes(partial) };
}

function uniqueObservedScript(scripts: StudioSnapshotObservation["scripts"], projectPath: string, executionContext: SourceFile["executionContext"]): StudioSnapshotObservation["scripts"][number] | undefined {
  const fileName = basename(projectPath);
  const matches = scripts.filter((script) => basename(normalizeRelative(script.path)) === fileName && script.executionContext === executionContext);
  return matches.length === 1 ? matches[0] : undefined;
}

export function canonicalProjectSemanticMap(map: ProjectSemanticMap): Record<string, unknown> {
  return {
    kind: map.kind,
    schemaVersion: map.schemaVersion,
    projectId: map.projectId,
    files: map.files.map(({ path, executionContext, source }) => ({ path, executionContext, sourceHash: contentHash(source) })).sort((a, b) => a.path.localeCompare(b.path)),
    scripts: map.scripts.map((script) => ({ ...script, dependencies: [...script.dependencies].sort() })).sort((a, b) => a.path.localeCompare(b.path)),
    modules: map.modules.map((module) => ({ ...module, dependencies: [...module.dependencies].sort() })).sort((a, b) => a.path.localeCompare(b.path)),
    instances: map.instances.map((instance) => ({ ...instance, properties: sortedRecord(instance.properties), attributes: sortedRecord(instance.attributes), tags: [...instance.tags].sort() })).sort((a, b) => a.path.localeCompare(b.path) || a.className.localeCompare(b.className)),
    remotes: [...map.remotes].sort((a, b) => a.path.localeCompare(b.path)),
    persistentState: [...map.persistentState].sort((a, b) => a.field.localeCompare(b.field)),
    uiBindings: [...map.uiBindings].sort((a, b) => a.path.localeCompare(b.path)),
    mechanicContracts: [...map.mechanicContracts].sort(),
    remoteFlows: map.remoteFlows.map((flow) => ({ name: flow.declaration.name, direction: flow.declaration.direction, clientScript: normalizeRelative(flow.declaration.clientScript), serverScript: normalizeRelative(flow.declaration.serverScript), clientEvidence: flow.clientEvidence, serverEvidence: flow.serverEvidence ? { handler: flow.serverEvidence.handler, mutation: flow.serverEvidence.mutation, mutationExpression: flow.serverEvidence.mutationExpression } : null })).sort((a, b) => a.name.localeCompare(b.name)),
    dependencies: [...map.dependencies].sort((a, b) => `${a.from}|${a.to}|${a.kind}`.localeCompare(`${b.from}|${b.to}|${b.kind}`)),
    hashes: map.hashes
  };
}

export function affectedVerificationCone(map: ProjectSemanticMap, changedPaths: RelativePath[]): AffectedVerificationCone {
  const normalized = [...new Set(changedPaths.map(normalizeRelative))].sort();
  const changed = new Set(normalized);
  const affectedScripts = map.scripts.filter((script) => changed.has(script.path) || script.dependencies.some((dependency) => changed.has(dependency))).map((script) => script.path);
  const affectedRemotes = map.remotes.filter((remote) => affectedScripts.includes(remote.clientScript) || affectedScripts.includes(remote.serverScript)).map((remote) => remote.id).sort();
  const affectedMechanicContractIds = map.remotes.filter((remote) => affectedRemotes.includes(remote.id)).map((remote) => remote.mechanicContractId ?? `contract_${toSnakeCase(remote.name)}`).sort();
  const checks: AffectedVerificationCone["checks"] = ["official_luau_analysis"];
  if (affectedRemotes.length > 0) checks.push("replication_and_authority_contracts", "studio_assertions");
  if (map.persistentState.some((state) => affectedScripts.some((path) => path.toLowerCase().includes(state.field.toLowerCase())))) checks.push("economy");
  if (map.instances.length > 0) checks.push("structure");
  return { changedPaths: normalized, affectedScriptPaths: [...new Set(affectedScripts)].sort(), affectedRemoteIds: affectedRemotes, affectedMechanicContractIds: [...new Set(affectedMechanicContractIds)].sort(), checks: [...new Set(checks)] };
}

export function assertProjectSnapshot(value: unknown): asserts value is ProjectSnapshot {
  if (!isRecord(value) || value.kind !== "ProjectSnapshot" || value.schemaVersion !== 1 || !isString(value.projectId) || !isString(value.sourceHash) || !isString(value.structureHash) || !isString(value.contractHash) || !isString(value.projectSemanticHash) || !isString(value.semanticMapHash)) throw new Error("Invalid ProjectSnapshot: expected schemaVersion 1");
}

export function assertProjectSemanticMap(value: unknown): asserts value is ProjectSemanticMap {
  if (!isRecord(value) || value.kind !== "ProjectSemanticMap" || value.schemaVersion !== 1 || !isString(value.projectId) || !Array.isArray(value.instances) || !Array.isArray(value.scripts) || !Array.isArray(value.remotes) || !Array.isArray(value.dependencies) || !isRecord(value.hashes)) throw new Error("Invalid ProjectSemanticMap: expected schemaVersion 1");
}

async function collectLuauFiles(root: string, relativeRoot: string, output: SourceFile[]): Promise<void> {
  const { readdir, stat } = await import("node:fs/promises");
  const absoluteRoot = resolve(root, relativeRoot);
  let entries;
  try { entries = await readdir(absoluteRoot, { withFileTypes: true }); }
  catch (error) { throw new Error(`Unable to read Luau root ${relativeRoot}: ${error instanceof Error ? error.message : String(error)}`); }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = join(absoluteRoot, entry.name);
    if (entry.isDirectory()) await collectLuauFiles(root, relative(root, absolutePath), output);
    else if (entry.isFile() && (entry.name.endsWith(".luau") || entry.name.endsWith(".lua"))) {
      const source = await readFile(absolutePath, "utf8");
      const path = normalizeRelative(relative(root, absolutePath));
      output.push({ path, absolutePath, source, executionContext: inferExecutionContext(path) });
    } else await stat(absolutePath).catch(() => undefined);
  }
}

function buildInstances(files: SourceFile[], manifest: ForgeFixtureManifest): SemanticInstance[] {
  const declarations = manifest.instances ?? [];
  const parentPaths = new Map(declarations.map((instance) => [instance.path, instance.parentPath]));
  const instances = declarations.map((instance) => ({ id: stableId("instance", `${instance.path}|${instance.className}`), path: instance.path, className: instance.className, properties: sortedRecord(instance.properties ?? {}), attributes: sortedRecord(instance.attributes ?? {}), tags: [...(instance.tags ?? [])].sort() }));
  for (const file of files) {
    const path = scriptInstancePath(file);
    if (!instances.some((instance) => instance.path === path)) instances.push({ id: stableId("instance", `${path}|${scriptClass(file)}`), path, className: scriptClass(file), properties: {}, attributes: {}, tags: [] });
  }
  const idsByPath = new Map(instances.map((instance) => [instance.path, instance.id]));
  return instances.map((instance) => {
    const parentPath = parentPaths.get(instance.path);
    const parentId = parentPath ? idsByPath.get(parentPath) : undefined;
    return parentId ? { ...instance, parentId } : instance;
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function buildDependencies(scripts: SemanticScript[], remotes: SemanticRemote[], manifest: ForgeFixtureManifest, mechanicContracts: string[]): ProjectSemanticMap["dependencies"] {
  const dependencies: ProjectSemanticMap["dependencies"] = [];
  for (const script of scripts) for (const dependency of script.dependencies) dependencies.push({ from: script.id, to: stableId("script", dependency), kind: "script" });
  for (const remote of remotes) {
    dependencies.push({ from: stableId("script", remote.clientScript), to: remote.id, kind: "remote" });
    dependencies.push({ from: stableId("script", remote.serverScript), to: remote.id, kind: "remote" });
    const contractId = mechanicContracts.find((id) => id === `contract_${toSnakeCase(remote.name)}`);
    if (contractId) dependencies.push({ from: remote.id, to: contractId, kind: "contract" });
  }
  for (const state of manifest.persistentState ?? []) for (const script of scripts.filter((candidate) => candidate.path.toLowerCase().includes(state.field.toLowerCase()))) dependencies.push({ from: script.id, to: stableId("state", state.field), kind: "state" });
  return dependencies.sort((a, b) => `${a.from}|${a.to}|${a.kind}`.localeCompare(`${b.from}|${b.to}|${b.kind}`));
}

function projectHashes(map: Omit<ProjectSemanticMap, "hashes">): ProjectSemanticMap["hashes"] {
  const sourceHash = contentHash(map.files.map((file) => `${file.path}\n${file.source}`).join("\n"));
  const structureHash = contentHash(stableJson({ instances: [...map.instances].sort((left, right) => left.path.localeCompare(right.path)), scripts: map.scripts.map(({ path, executionContext, sourceHash, dependencies }) => ({ path, executionContext, sourceHash, dependencies: [...dependencies].sort() })).sort((left, right) => left.path.localeCompare(right.path)), remotes: [...map.remotes].sort((left, right) => left.path.localeCompare(right.path)), modules: map.modules.map((module) => ({ ...module, dependencies: [...module.dependencies].sort() })).sort((left, right) => left.path.localeCompare(right.path)) }));
  const semanticHash = contentHash(stableJson({ structureHash, remoteFlows: map.remoteFlows.map((flow) => ({ declaration: flow.declaration, clientEvidence: flow.clientEvidence, serverEvidence: flow.serverEvidence })).sort((left, right) => left.declaration.name.localeCompare(right.declaration.name)), dependencies: [...map.dependencies].sort((left, right) => `${left.from}|${left.to}|${left.kind}`.localeCompare(`${right.from}|${right.to}|${right.kind}`)), persistentState: [...map.persistentState].sort((left, right) => left.field.localeCompare(right.field)), uiBindings: [...map.uiBindings].sort((left, right) => left.path.localeCompare(right.path)), mechanicContracts: [...map.mechanicContracts].sort() }));
  return { sourceHash, structureHash, semanticHash };
}

function findClientEvidence(source: string, declaration: RemoteFlowDeclaration): SemanticRemoteFlow["clientEvidence"] {
  const remotePattern = /(?:FireServer|InvokeServer)\s*\(([^)]*)\)/m;
  const match = source.match(remotePattern);
  if (!match?.[1] || !source.includes(declaration.name)) return null;
  const argumentsList = match[1].split(",").map((argument) => argument.trim()).filter(Boolean);
  const inputExpression = argumentsList.length === 1 ? argumentsList[0] : argumentsList[argumentsList.length - 1];
  return inputExpression ? { remoteCall: match[0], inputExpression } : null;
}

function findServerEvidence(source: string, declaration: RemoteFlowDeclaration): SemanticRemoteFlow["serverEvidence"] {
  const handlerPattern = /OnServerEvent:Connect\s*\(\s*function\s*\(([^)]*)\)/m;
  const mutationPattern = new RegExp(`^\\s*(?:[A-Za-z0-9_.]+\\.)?${escapeRegExp(declaration.mutation.field)}(?:\\[[^\\n]+\\])?\\s*=\\s*([^\\n;]+)$`, "m");
  const handler = source.match(handlerPattern);
  const mutation = source.match(mutationPattern);
  if (!handler || !mutation?.[0]) return null;
  return { handler: handler[0], mutation: mutation[0], mutationExpression: mutation[1]?.trim() ?? "" };
}

function findDependencies(source: string): RelativePath[] {
  return [...source.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]).filter((dependency): dependency is string => Boolean(dependency)).sort();
}

function inferExecutionContext(path: string): SourceFile["executionContext"] {
  if (path.endsWith(".server.luau") || path.endsWith(".server.lua") || path.includes("ServerScriptService")) return "server";
  if (path.endsWith(".client.luau") || path.endsWith(".client.lua") || path.includes("StarterPlayerScripts")) return "client";
  if (path.includes("ReplicatedStorage")) return "shared";
  return "unknown";
}

function scriptInstancePath(file: SourceFile): string {
  const name = basename(file.path).replace(/\.(server|client)\.(lua|luau)$/, "").replace(/\.(lua|luau)$/, "");
  if (file.executionContext === "server") return `ServerScriptService/${name}`;
  if (file.executionContext === "client") return `StarterPlayer/StarterPlayerScripts/${name}`;
  if (file.executionContext === "shared") return `ReplicatedStorage/${name}`;
  return `Workspace/${name}`;
}

function scriptClass(file: SourceFile): string {
  if (file.executionContext === "server") return "Script";
  if (file.executionContext === "client") return "LocalScript";
  return "ModuleScript";
}

function stableId(kind: string, value: string): string { return `${kind}_${contentHash(value.replaceAll("\\", "/")).slice(0, 24)}`; }
function toSnakeCase(value: string): string { return value.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase(); }
function sortedRecord(value: Record<string, string | number | boolean> | undefined): Record<string, string | number | boolean> { return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right))); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function normalizeRelative(path: string): string { return path.split(sep).join("/").replace(/^\.\//, ""); }
function assertProjectRelative(path: string): void { if (path.startsWith("/") || path.split(/[\\/]+/).includes("..")) throw new Error(`Fixture path must stay inside the project root: ${path}`); }
function missingSource(root: string, path: string, executionContext: SourceFile["executionContext"]): SourceFile { return { path: normalizeRelative(path), absolutePath: resolve(root, path), source: "", executionContext }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
