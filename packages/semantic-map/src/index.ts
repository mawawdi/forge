import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ForgeFixtureManifest, RelativePath, RemoteFlowDeclaration } from "../../contracts/src/index.js";

export interface SourceFile {
  path: RelativePath;
  absolutePath: string;
  source: string;
  executionContext: "server" | "client" | "shared" | "unknown";
}

export interface SemanticRemoteFlow {
  declaration: RemoteFlowDeclaration;
  client: SourceFile;
  server: SourceFile;
  clientEvidence: { remoteCall: string; inputExpression: string } | null;
  serverEvidence: { handler: string; mutation: string } | null;
}

export interface ProjectSemanticMap {
  root: string;
  files: SourceFile[];
  remoteFlows: SemanticRemoteFlow[];
}

export async function buildSemanticMap(root: string, manifest: ForgeFixtureManifest): Promise<ProjectSemanticMap> {
  const canonicalRoot = resolve(root);
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
    if (!client || !server) {
      remoteFlows.push({ declaration, client: client ?? missingSource(canonicalRoot, declaration.clientScript, "client"), server: server ?? missingSource(canonicalRoot, declaration.serverScript, "server"), clientEvidence: null, serverEvidence: null });
      continue;
    }
    remoteFlows.push({ declaration, client, server, clientEvidence: findClientEvidence(client.source, declaration), serverEvidence: findServerEvidence(server.source, declaration) });
  }
  return { root: canonicalRoot, files, remoteFlows };
}

async function collectLuauFiles(root: string, relativeRoot: string, output: SourceFile[]): Promise<void> {
  const { readdir, stat } = await import("node:fs/promises");
  const absoluteRoot = resolve(root, relativeRoot);
  let entries;
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Unable to read Luau root ${relativeRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = join(absoluteRoot, entry.name);
    if (entry.isDirectory()) {
      await collectLuauFiles(root, relative(root, absolutePath), output);
    } else if (entry.isFile() && (entry.name.endsWith(".luau") || entry.name.endsWith(".lua"))) {
      const source = await readFile(absolutePath, "utf8");
      const path = normalizeRelative(relative(root, absolutePath));
      output.push({ path, absolutePath, source, executionContext: inferExecutionContext(path) });
    } else {
      await stat(absolutePath).catch(() => undefined);
    }
  }
}

function inferExecutionContext(path: string): SourceFile["executionContext"] {
  if (path.endsWith(".server.luau") || path.endsWith(".server.lua") || path.includes("ServerScriptService")) return "server";
  if (path.endsWith(".client.luau") || path.endsWith(".client.lua") || path.includes("StarterPlayerScripts")) return "client";
  if (path.includes("ReplicatedStorage")) return "shared";
  return "unknown";
}

function findClientEvidence(source: string, declaration: RemoteFlowDeclaration): SemanticRemoteFlow["clientEvidence"] {
  const remotePattern = new RegExp(`(?:FireServer|InvokeServer)\\s*\\(([^)]*)\\)`, "m");
  const match = source.match(remotePattern);
  if (!match?.[1]) return null;
  if (!source.includes(declaration.name)) return null;
  const argumentsList = match[1].split(",").map((argument) => argument.trim()).filter(Boolean);
  const inputExpression = argumentsList.length === 1 ? argumentsList[0] : argumentsList[argumentsList.length - 1];
  if (!inputExpression) return null;
  return { remoteCall: match[0], inputExpression };
}

function findServerEvidence(source: string, declaration: RemoteFlowDeclaration): SemanticRemoteFlow["serverEvidence"] {
  const handlerPattern = /OnServerEvent:Connect\s*\(\s*function\s*\(([^)]*)\)/m;
  const mutationPattern = new RegExp(`^\\s*(?:[A-Za-z0-9_.]+\\.)?${escapeRegExp(declaration.mutation.field)}(?:\\[[^\\n]+\\])?\\s*=\\s*([^\\n;]+)$`, "m");
  const handler = source.match(handlerPattern);
  const mutation = source.match(mutationPattern);
  if (!handler || !mutation?.[0]) return null;
  return { handler: handler[0], mutation: mutation[0] };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRelative(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

function assertProjectRelative(path: string): void {
  if (path.startsWith("/") || path.split(/[\\/]+/).includes("..")) {
    throw new Error(`Fixture path must stay inside the project root: ${path}`);
  }
}

function missingSource(root: string, path: string, executionContext: SourceFile["executionContext"]): SourceFile {
  return { path: normalizeRelative(path), absolutePath: resolve(root, path), source: "", executionContext };
}
