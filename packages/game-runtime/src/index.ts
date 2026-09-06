import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { GamePlacementParent, GameSourcePackage } from "../../game-ir/src/index.js";
export { createForgeRuntimeRecipe } from "./recipe.js";

export const FORGE_RUNTIME_ABI = "forge-runtime@2";
export const FORGE_RUNTIME_MODULE_IDS = [
  "event",
  "network",
  "scope",
  "state-machine",
  "task",
] as const;
export type ForgeRuntimeModuleId = (typeof FORGE_RUNTIME_MODULE_IDS)[number];
const MODULE_NAMES: Record<ForgeRuntimeModuleId, string> = {
  event: "Event",
  network: "Network",
  scope: "Scope",
  "state-machine": "StateMachine",
  task: "Task",
};
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const lockSchema = z
  .object({
    kind: z.literal("ForgeRuntimeLock"),
    abi: z.literal(FORGE_RUNTIME_ABI),
    provenance: z
      .object({
        owner: z.literal("Forge"),
        license: z.literal("MIT"),
        licenseHash: hashSchema,
        thirdPartyDependencies: z.array(z.never()),
      })
      .strict(),
    modules: z
      .array(
        z
          .object({
            id: z.enum(FORGE_RUNTIME_MODULE_IDS),
            name: z.string(),
            relativePath: z.string(),
            sourceHash: hashSchema,
            utf8Bytes: z
              .number()
              .int()
              .positive()
              .max(256 * 1024),
          })
          .strict(),
      )
      .length(FORGE_RUNTIME_MODULE_IDS.length),
    bundleHash: hashSchema,
  })
  .strict();
type RuntimeLock = z.infer<typeof lockSchema>;

export interface ForgeRuntimeBundle {
  kind: "ForgeRuntimeBundle";
  abi: typeof FORGE_RUNTIME_ABI;
  hash: string;
  provenance: RuntimeLock["provenance"];
  modules: Array<{
    id: ForgeRuntimeModuleId;
    name: string;
    relativePath: string;
    path: string;
    source: string;
    sourceHash: string;
    utf8Bytes: number;
    imports: string[];
  }>;
}

/** Loads only checked-in regular files; there are no creator-time downloads. */
export async function loadForgeRuntimeBundle(
  options: { root?: string } = {},
): Promise<ForgeRuntimeBundle> {
  const root = resolve(
    options.root ?? resolve(import.meta.dirname, "../../../..", "packages/game-runtime"),
  );
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Runtime root must not be a symlink");
  const canonicalRoot = await realpath(root);
  const lock = lockSchema.parse(
    JSON.parse(await regularText(canonicalRoot, "runtime.lock.json", 64 * 1024)),
  );
  const license = await regularText(canonicalRoot, "LICENSE", 64 * 1024);
  if (contentHash(license) !== lock.provenance.licenseHash)
    throw new Error("ForgeRuntime license integrity mismatch");
  const { bundleHash, ...material } = lock;
  if (contentHash(stableJson(material)) !== bundleHash)
    throw new Error("ForgeRuntime lock identity mismatch");
  if (stableJson(lock.modules.map((module) => module.id)) !== stableJson(FORGE_RUNTIME_MODULE_IDS))
    throw new Error("ForgeRuntime module inventory mismatch");
  const modules: ForgeRuntimeBundle["modules"] = [];
  for (const module of lock.modules) {
    const name = MODULE_NAMES[module.id];
    if (module.name !== name || module.relativePath !== `${name}.luau`)
      throw new Error("ForgeRuntime module path mismatch");
    const source = await regularText(canonicalRoot, `luau/${module.relativePath}`, 256 * 1024);
    if (contentHash(source) !== module.sourceHash || Buffer.byteLength(source) !== module.utf8Bytes)
      throw new Error(`ForgeRuntime source integrity mismatch: ${module.id}`);
    modules.push({
      ...module,
      path: `ReplicatedStorage/Packages/ForgeRuntime/${name}`,
      source,
      imports: [],
    });
  }
  return {
    kind: "ForgeRuntimeBundle",
    abi: FORGE_RUNTIME_ABI,
    hash: bundleHash,
    provenance: lock.provenance,
    modules,
  };
}

/** The caller supplies the exact existing/generated parent from its accepted inventory. */
export function forgeRuntimeSourcePackage(
  bundle: ForgeRuntimeBundle,
  options: {
    parent: GamePlacementParent;
    rootPath: string;
    componentId?: string;
    operationPrefix?: string;
  },
): {
  component: GameSourcePackage;
  sources: Array<{ componentId: string; fileId: string; source: string; sourceHash: string }>;
  studioPaths: Record<string, string>;
} {
  assertForgeRuntimeBundle(bundle);
  assertStudioPath(options.rootPath);
  if (
    options.parent.kind !== "generated" &&
    options.parent.kind !== "component_output" &&
    options.parent.path !== options.rootPath
  )
    throw new Error("Runtime import path must match its exact installation parent");
  const componentId = options.componentId ?? "forge-runtime";
  const prefix = options.operationPrefix ?? componentId;
  for (const id of [componentId, prefix])
    if (!/^[a-z][a-z0-9-]*$/.test(id))
      throw new Error("Runtime installation IDs must be lowercase kebab-case");
  if (componentId.length > 64 || prefix.length > 50)
    throw new Error("Runtime installation IDs exceed source declaration bounds");
  return {
    component: {
      kind: "source_package",
      id: componentId,
      ports: [],
      obligations: [],
      files: bundle.modules.map((module) => ({
        id: module.id,
        path: module.relativePath,
        context: "shared",
        role: "module",
        imports: [],
        content: {
          kind: "locked",
          sourceHash: module.sourceHash,
          utf8Bytes: Buffer.byteLength(module.source),
        },
        placement: {
          operationId: `${prefix}-${module.id}`,
          kind: "create",
          parent: options.parent,
          name: module.name,
          className: "ModuleScript",
        },
      })),
    },
    sources: bundle.modules.map((module) => ({
      componentId,
      fileId: module.id,
      source: module.source,
      sourceHash: module.sourceHash,
    })),
    studioPaths: Object.fromEntries(
      bundle.modules.map((module) => [module.id, `${options.rootPath}/${module.name}`]),
    ),
  };
}

export function emitStaticModuleImport(input: { localName: string; studioPath: string }): string {
  assertIdentifier(input.localName);
  const [service, ...children] = assertStudioPath(input.studioPath);
  const expression = `game:GetService(${JSON.stringify(service)})${children.map((child) => `:WaitForChild(${JSON.stringify(child)})`).join("")}`;
  return `local ${input.localName} = require(${expression})`;
}

export function assertForgeRuntimeBundle(bundle: ForgeRuntimeBundle): void {
  if (bundle.kind !== "ForgeRuntimeBundle" || bundle.abi !== FORGE_RUNTIME_ABI)
    throw new Error("Invalid ForgeRuntime bundle ABI");
  const modules = bundle.modules.map((module) => {
    if (
      module.name !== MODULE_NAMES[module.id] ||
      module.relativePath !== `${module.name}.luau` ||
      module.path !== `ReplicatedStorage/Packages/ForgeRuntime/${module.name}` ||
      module.imports.length !== 0 ||
      contentHash(module.source) !== module.sourceHash ||
      Buffer.byteLength(module.source) !== module.utf8Bytes
    )
      throw new Error("Invalid ForgeRuntime module material");
    return {
      id: module.id,
      name: module.name,
      relativePath: module.relativePath,
      sourceHash: module.sourceHash,
      utf8Bytes: Buffer.byteLength(module.source),
    };
  });
  const lock = lockSchema.parse({
    kind: "ForgeRuntimeLock",
    abi: bundle.abi,
    provenance: bundle.provenance,
    modules,
    bundleHash: bundle.hash,
  });
  const { bundleHash, ...material } = lock;
  if (
    contentHash(stableJson(material)) !== bundleHash ||
    stableJson(modules.map((module) => module.id)) !== stableJson(FORGE_RUNTIME_MODULE_IDS)
  )
    throw new Error("ForgeRuntime bundle identity mismatch");
}

async function regularText(
  root: string,
  relativePath: string,
  maximumBytes: number,
): Promise<string> {
  let path = root;
  for (const segment of relativePath.split("/")) {
    path = join(path, segment);
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("ForgeRuntime source must not traverse symlinks");
  }
  const status = await lstat(path);
  if (!status.isFile() || status.size > maximumBytes)
    throw new Error("ForgeRuntime artifact must be a bounded regular file");
  const bytes = await readFile(path);
  const source = bytes.toString("utf8");
  if (bytes.byteLength > maximumBytes || !Buffer.from(source).equals(bytes))
    throw new Error("ForgeRuntime artifact must be bounded UTF-8");
  return source;
}

function assertStudioPath(path: string): string[] {
  if (
    path.length > 2048 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    /[\x00-\x1f\\]/.test(path)
  )
    throw new Error("Invalid static Studio import path");
  const segments = path.split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw new Error("Invalid static Studio import path");
  return segments;
}

function assertIdentifier(name: string): void {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
    new Set([
      "and",
      "break",
      "continue",
      "do",
      "else",
      "elseif",
      "end",
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
      "until",
      "while",
      "type",
      "export",
    ]).has(name)
  )
    throw new Error("Invalid generated Luau identifier");
}
