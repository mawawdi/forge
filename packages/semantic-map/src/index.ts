import { join, relative, resolve, sep } from "node:path";
import { lstat, readFile, readdir } from "node:fs/promises";
import { assertFixtureManifest, contentHash, stableJson, type ForgeFixtureManifest, type RelativePath, type RemoteFlowDeclaration } from "../../contracts/src/index.js";
import type { StudioProjectState, StudioValue } from "../../studio-evidence/src/index.js";

export interface SourceFile { path: RelativePath; absolutePath: string; source: string; executionContext: "server" | "client" | "shared" | "unknown" }
export interface SemanticScript { id: string; path: RelativePath; executionContext: SourceFile["executionContext"]; sourceHash: string; dependencies: RelativePath[] }
export interface SemanticInstance { id: string; path: string; className: string; parentId?: string; position?: { x: number; y: number; z: number }; properties: Record<string, string | number | boolean>; attributes: Record<string, string | number | boolean>; tags: string[] }
export interface SemanticRemote { id: string; path: string; name: string; className: "RemoteEvent" | "RemoteFunction"; direction: RemoteFlowDeclaration["direction"]; clientScript: RelativePath; serverScript: RelativePath }
export interface SemanticRemoteFlow { declaration: RemoteFlowDeclaration; client: SourceFile; server: SourceFile }

export interface ProjectSemanticMap {
  kind: "ProjectSemanticMap";
    projectId: string;
  root: string;
  files: SourceFile[];
  scripts: SemanticScript[];
  instances: SemanticInstance[];
  remotes: SemanticRemote[];
  remoteFlows: SemanticRemoteFlow[];
  dependencies: Array<{ from: string; to: string; kind: "source" | "instance" | "remote" }>;
  hashes: { sourceHash: string; structureHash: string; semanticHash: string };
}

export interface ProjectSnapshot {
  kind: "ProjectSnapshot";
    projectId: string;
  sourceHash: string;
  structureHash: string;
  projectSemanticHash: string;
  semanticMapHash: string;
}

export interface ProjectSourceAdapter {
  load(input: { root: string; manifest: ForgeFixtureManifest }): Promise<ProjectSemanticMap>;
  snapshot(map: ProjectSemanticMap): ProjectSnapshot;
}

export class FilesystemProjectSourceAdapter implements ProjectSourceAdapter {
  load(input: { root: string; manifest: ForgeFixtureManifest }): Promise<ProjectSemanticMap> { return buildSemanticMap(input.root, input.manifest); }
  snapshot(map: ProjectSemanticMap): ProjectSnapshot { return createProjectSnapshot(map); }
}

export async function buildSemanticMap(root: string, manifest: ForgeFixtureManifest): Promise<ProjectSemanticMap> {
  assertFixtureManifest(manifest);
  const canonicalRoot = resolve(root);
  const files: SourceFile[] = [];
  for (const sourceRoot of [...manifest.luauRoots].sort()) await collectLuauFiles(canonicalRoot, sourceRoot, files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const remoteFlows = manifest.remoteFlows.map((declaration) => ({
    declaration,
    client: byPath.get(normalize(declaration.clientScript)) ?? missingSource(canonicalRoot, declaration.clientScript, "client"),
    server: byPath.get(normalize(declaration.serverScript)) ?? missingSource(canonicalRoot, declaration.serverScript, "server")
  }));
  const scripts = files.map((file) => ({ id: stableId("script", file.path), path: file.path, executionContext: file.executionContext, sourceHash: contentHash(file.source), dependencies: findDependencies(file.source) }));
  const instances = buildInstances(files, manifest);
  const remotes = manifest.remoteFlows.map((flow) => ({ id: flow.remote.stableId, path: flow.remote.path, name: flow.name, className: flow.remote.className, direction: flow.direction, clientScript: normalize(flow.clientScript), serverScript: normalize(flow.serverScript) })).sort((left, right) => left.path.localeCompare(right.path));
  const dependencies = [
    ...scripts.flatMap((script) => script.dependencies.map((dependency) => ({ from: script.path, to: dependency, kind: "source" as const }))),
    ...remotes.flatMap((remote) => [{ from: remote.clientScript, to: remote.id, kind: "remote" as const }, { from: remote.serverScript, to: remote.id, kind: "remote" as const }])
  ].sort((left, right) => `${left.from}|${left.to}`.localeCompare(`${right.from}|${right.to}`));
  const partial: Omit<ProjectSemanticMap, "hashes"> = { kind: "ProjectSemanticMap", projectId: stableId("project", manifest.name), root: canonicalRoot, files, scripts, instances, remotes, remoteFlows, dependencies };
  return { ...partial, hashes: projectHashes(partial) };
}

export function createProjectSnapshot(map: ProjectSemanticMap): ProjectSnapshot {
  assertProjectSemanticMap(map);
  const semanticMapHash = contentHash(stableJson(canonicalProjectSemanticMap(map)));
  const projectSemanticHash = contentHash(stableJson({ sourceHash: map.hashes.sourceHash, structureHash: map.hashes.structureHash, semanticHash: map.hashes.semanticHash }));
  return { kind: "ProjectSnapshot", projectId: map.projectId, sourceHash: map.hashes.sourceHash, structureHash: map.hashes.structureHash, projectSemanticHash, semanticMapHash };
}

export function mergeStudioEvidenceState(map: ProjectSemanticMap, observation: StudioProjectState): ProjectSemanticMap {
  assertStudioProjectState(observation);
  const observedScripts = new Map(observation.scripts.map((script) => [normalize(script.path), script]));
  const files = map.files.map((file) => {
    const observed = observedScripts.get(file.path);
    return observed?.source !== undefined ? { ...file, source: observed.source, executionContext: observed.executionContext } : file;
  });
  const scripts = files.map((file) => ({ id: stableId("script", file.path), path: file.path, executionContext: file.executionContext, sourceHash: observedScripts.get(file.path)?.sourceHash ?? contentHash(file.source), dependencies: findDependencies(file.source) }));
  const instances = observation.instances.map((instance) => ({ id: stableId("instance", `${instance.path}|${instance.className}`), path: instance.path, className: instance.className, ...(instance.position ? { position: instance.position } : {}), properties: studioProperties(instance.properties), attributes: withoutForgeMetadata({ ...instance.attributes }), tags: [...instance.tags].sort() })).sort((left, right) => left.path.localeCompare(right.path));
  const remotes = observation.remotes.map((remote) => {
    const existing = map.remotes.find((candidate) => candidate.path === remote.path);
    return { id: existing?.id ?? stableId("remote", remote.path), path: remote.path, name: remote.name, className: remote.className, direction: remote.direction, clientScript: existing?.clientScript ?? "", serverScript: existing?.serverScript ?? "" };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const partial: Omit<ProjectSemanticMap, "hashes"> = { ...map, files, scripts, instances, remotes };
  return { ...partial, hashes: projectHashes(partial) };
}

export function canonicalProjectSemanticMap(map: ProjectSemanticMap): Record<string, unknown> {
  return {
    kind: map.kind,
        projectId: map.projectId,
    files: map.files.map((file) => ({ path: file.path, executionContext: file.executionContext, sourceHash: contentHash(file.source) })).sort(byPath),
    scripts: map.scripts.map((script) => ({ ...script, dependencies: [...script.dependencies].sort() })).sort(byPath),
    instances: map.instances.map((instance) => ({ ...instance, properties: sorted(instance.properties), attributes: sorted(instance.attributes), tags: [...instance.tags].sort() })).sort(byPath),
    remotes: [...map.remotes].sort(byPath),
    remoteFlows: map.remoteFlows.map((flow) => ({ declaration: flow.declaration, clientHash: contentHash(flow.client.source), serverHash: contentHash(flow.server.source) })).sort((left, right) => left.declaration.name.localeCompare(right.declaration.name)),
    dependencies: [...map.dependencies],
    hashes: map.hashes
  };
}

export function assertStudioProjectState(value: unknown): asserts value is StudioProjectState {
  if (!isRecord(value) || !isRecord(value.project) || !Array.isArray(value.instances) || !Array.isArray(value.scripts) || !Array.isArray(value.remotes)) throw new Error("Invalid StudioProjectState");
  if (!value.instances.every((entry) => isRecord(entry) && typeof entry.stableId === "string" && typeof entry.path === "string" && typeof entry.className === "string" && isRecord(entry.properties) && isRecord(entry.attributes) && Array.isArray(entry.tags) && (entry.position === undefined || isVector3(entry.position)))) throw new Error("Invalid Studio project-state instance");
}

export function assertProjectSemanticMap(value: unknown): asserts value is ProjectSemanticMap { if (!isRecord(value) || value.kind !== "ProjectSemanticMap" || typeof value.projectId !== "string" || !Array.isArray(value.files) || !Array.isArray(value.instances) || !Array.isArray(value.remoteFlows) || !isRecord(value.hashes)) throw new Error("Invalid ProjectSemanticMap"); }
export function assertProjectSnapshot(value: unknown): asserts value is ProjectSnapshot { if (!isRecord(value) || value.kind !== "ProjectSnapshot" || typeof value.projectId !== "string" || !isHash(value.sourceHash) || !isHash(value.structureHash) || !isHash(value.projectSemanticHash) || !isHash(value.semanticMapHash)) throw new Error("Invalid ProjectSnapshot"); }

async function collectLuauFiles(root: string, relativeRoot: string, output: SourceFile[]): Promise<void> {
  const absoluteRoot = inside(root, relativeRoot);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(absoluteRoot, entry.name);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error(`Source root contains a symbolic link: ${normalize(relative(root, absolutePath))}`);
    if (metadata.isDirectory()) await collectLuauFiles(root, normalize(relative(root, absolutePath)), output);
    else if (metadata.isFile() && /\.(?:lua|luau)$/.test(entry.name)) {
      const path = normalize(relative(root, absolutePath));
      output.push({ path, absolutePath, source: await readFile(absolutePath, "utf8"), executionContext: inferContext(path) });
    }
  }
}

function buildInstances(files: SourceFile[], manifest: ForgeFixtureManifest): SemanticInstance[] {
  const declared = (manifest.instances ?? []).map((instance) => ({ id: stableId("instance", `${instance.path}|${instance.className}`), path: instance.path, className: instance.className, ...(instance.position ? { position: instance.position } : {}), properties: sorted(instance.properties ?? {}), attributes: sorted(instance.attributes ?? {}), tags: [...(instance.tags ?? [])].sort() }));
  for (const file of files) {
    const path = `Source/${file.path}`;
    if (!declared.some((instance) => instance.path === path)) declared.push({ id: stableId("instance", `${path}|${scriptClass(file)}`), path, className: scriptClass(file), properties: {}, attributes: {}, tags: [] });
  }
  return declared.sort(byPath);
}

function projectHashes(map: Omit<ProjectSemanticMap, "hashes">): ProjectSemanticMap["hashes"] {
  const sourceHash = contentHash(stableJson(map.files.map((file) => ({ path: file.path, source: file.source }))));
  const structureHash = contentHash(stableJson({ instances: map.instances, remotes: map.remotes }));
  const semanticHash = contentHash(stableJson({ scripts: map.scripts, remoteFlows: map.remoteFlows.map((flow) => flow.declaration), dependencies: map.dependencies }));
  return { sourceHash, structureHash, semanticHash };
}

function inside(root: string, path: string): string { const target = resolve(root, path); if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`Project path escapes root: ${path}`); return target; }
function missingSource(root: string, path: string, context: SourceFile["executionContext"]): SourceFile { return { path: normalize(path), absolutePath: inside(root, path), source: "", executionContext: context }; }
function findDependencies(source: string): string[] { return [...source.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => normalize(match[1]!)).sort(); }
function inferContext(path: string): SourceFile["executionContext"] { if (/\.server\.(?:lua|luau)$/.test(path) || path.includes("/server/")) return "server"; if (/\.client\.(?:lua|luau)$/.test(path) || path.includes("/client/")) return "client"; if (path.includes("/shared/") || path.includes("/ReplicatedStorage/")) return "shared"; return "unknown"; }
function scriptClass(file: SourceFile): string { return file.executionContext === "server" ? "Script" : file.executionContext === "client" ? "LocalScript" : "ModuleScript"; }
function stableId(kind: string, value: string): string { return `${kind}_${contentHash(value).slice(0, 24)}`; }
function normalize(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\//, ""); }
function withoutForgeMetadata(values: Record<string, string | number | boolean>): Record<string, string | number | boolean> { const { _forgeStableId: _ignored, ...rest } = values; return rest; }
function studioProperties(values: Readonly<Record<string, StudioValue>>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).flatMap(([name, value]) => {
    if (value.kind === "boolean" || value.kind === "number_f32" || value.kind === "string_utf8" || value.kind === "enum_name") return [[name, value.value]];
    return [];
  }));
}
function sorted<T extends string | number | boolean>(values: Record<string, T>): Record<string, T> { return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right))); }
function byPath<T extends { path: string }>(left: T, right: T): number { return left.path.localeCompare(right.path); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isVector3(value: unknown): boolean { return isRecord(value) && [value.x, value.y, value.z].every((part) => typeof part === "number" && Number.isFinite(part)); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
