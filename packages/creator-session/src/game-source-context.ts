import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertGamePlan,
  gameInventoryOperation,
  type GamePlan,
} from "../../game-compiler/src/index.js";
import { studioObjectIdentityKey } from "../../studio-evidence/src/index.js";
import { compareGameStrings } from "../../game-ir/src/primitives.js";
import { compileCreatorTransactionTopology } from "./transaction-topology.js";

interface SourceContext {
  componentId: string;
  fileId: string;
  operationId?: string;
  path: string;
  className: string;
  context?: "client" | "server" | "shared";
  content: { kind: string; sourceHash?: string; utf8Bytes?: number; maximumUtf8Bytes?: number };
  imports: { componentId: string; fileId: string }[];
}
export interface SourceImportContext {
  componentId: string;
  fileId: string;
  path: string;
  className: string;
  context?: SourceContext["context"];
  operationId?: string;
  content: SourceContext["content"];
  requireExpression?: string;
  unresolved?: string;
}

/** Derived navigation for accepted source only. Neither loads nor evaluates candidate code. */
export function createGameSourceContextReader(plan: GamePlan) {
  assertGamePlan(plan);
  const planHash = plan.hash;
  const topology = compileCreatorTransactionTopology({
    initial: plan.initialTopology,
    operations: plan.inventory.map((item) => gameInventoryOperation(plan, item)),
  });
  const identities = new Map(
    topology.finalNodes.map((node) => [studioObjectIdentityKey(node.identity), node]),
  );
  const paths = new Map<string, number>();
  const classes = new Map(topology.finalNodes.map((node) => [node.path, node.className]));
  for (const node of topology.finalNodes) paths.set(node.path, (paths.get(node.path) ?? 0) + 1);
  const sources = new Map<string, SourceContext>();
  const byOperation = new Map<string, SourceContext>();
  const operationSources = new Map(
    plan.inventory.flatMap((item) =>
      item.source
        ? [[item.id, { componentId: item.componentId, fileId: item.source.fileId }] as const]
        : [],
    ),
  );
  for (const item of plan.inventory) {
    if (!item.source) continue;
    const operation = gameInventoryOperation(plan, item);
    const node = identities.get(studioObjectIdentityKey(operation.target.identity));
    if (!node) throw new Error("Accepted source is missing from final topology");
    const component = plan.design.components.find(
      (component) => component.id === item.componentId,
    )!;
    const file =
      component.kind === "source_package"
        ? component.files.find((file) => file.id === item.source!.fileId)
        : undefined;
    const source: SourceContext = {
      componentId: item.componentId,
      fileId: item.source.fileId,
      operationId: item.id,
      path: node.path,
      className: node.className,
      ...(file ? { context: file.context } : {}),
      content: structuredClone(item.source.content),
      imports: file
        ? structuredClone(file.imports)
        : item.dependencies.flatMap((id) =>
            operationSources.has(id) ? [operationSources.get(id)!] : [],
          ),
    };
    sources.set(source.componentId + "/" + source.fileId, source);
    byOperation.set(item.id, source);
  }
  for (const source of plan.observedSources)
    sources.set(source.componentId + "/" + source.fileId, {
      componentId: source.componentId,
      fileId: source.fileId,
      path: source.target.path,
      className: source.target.className,
      content: { kind: "observed", sourceHash: source.sourceHash, utf8Bytes: source.utf8Bytes },
      imports: structuredClone([...source.imports]),
    });
  const roots = new Set(
    plan.initialTopology.flatMap((node) =>
      node.engineContainer && !node.engineContainer.path.includes("/")
        ? [node.engineContainer.path]
        : [],
    ),
  );
  const expression = (from: string, to: string) => {
    const origin = from.split("/"),
      target = to.split("/");
    const copyRoot = (path: string) => {
      const segments = path.split("/");
      // Tools can move from Workspace or Backpack into a Character on pickup/equip.
      for (let i = segments.length - 1; i >= 2; i--) {
        const ancestor = segments.slice(0, i).join("/");
        if (classes.get(ancestor) === "Tool") return ancestor;
      }
      if (path.startsWith("StarterPack/")) return "StarterPack";
      return [
        "StarterPlayer/StarterPlayerScripts",
        "StarterPlayer/StarterCharacterScripts",
        "StarterGui",
      ].find((root) => path.startsWith(root + "/"));
    };
    const originCopy = copyRoot(from),
      targetCopy = copyRoot(to);
    if (targetCopy && originCopy !== targetCopy) return undefined;
    for (const segments of [origin, target])
      for (let i = 1; i <= segments.length; i++) {
        if (paths.get(segments.slice(0, i).join("/")) !== 1) return undefined;
      }
    let common = 0;
    while (common < origin.length && common < target.length && origin[common] === target[common])
      common++;
    // Relative lookup follows a script's actual copy in Starter containers.
    let base: string;
    let suffix: string[];
    if (common > 0 && originCopy === targetCopy) {
      base = "script" + ".Parent".repeat(origin.length - common);
      suffix = target.slice(common);
    } else {
      if (!roots.has(target[0]!)) return undefined;
      base = "game:GetService(" + luauString(target[0]!) + ")";
      suffix = target.slice(1);
    }
    return (
      "require(" +
      base +
      suffix.map((name) => ":WaitForChild(" + luauString(name) + ")").join("") +
      ")"
    );
  };
  return (request: { planHash: string; operationId: string; offset: number }) => {
    if (request.planHash !== planHash)
      throw new Error("Source context belongs to a different accepted plan");
    const source = byOperation.get(request.operationId);
    if (!source) throw new Error("Source context requires an accepted source operation");
    if (
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      request.offset > source.imports.length
    )
      throw new Error("Invalid source import offset");
    const ordered = [...source.imports].sort((a, b) =>
      compareGameStrings(a.componentId + "/" + a.fileId, b.componentId + "/" + b.fileId),
    );
    const { imports: _imports, ...descriptor } = source;
    const base = {
      planHash,
      source: descriptor,
      totalImports: ordered.length,
      limitations: [
        "Expressions resolve the accepted editor topology. Runtime reparenting, streaming and replication readiness require application handling and native evidence.",
        "Import navigation supplies no callable API, source edit authority or gameplay verification. Read accepted module source before using unfamiliar exports.",
      ],
    };
    const imports: SourceImportContext[] = [];
    // Reserve the entire envelope, including the largest cursor and final hash.
    let bytes = Buffer.byteLength(
      stableJson({ ...base, imports: [], nextOffset: ordered.length, hash: "0".repeat(64) }),
    );
    if (bytes > 16 * 1024) throw new Error("Source descriptor exceeds the bounded context page");
    for (const imported of ordered.slice(request.offset, request.offset + 32)) {
      const target = sources.get(imported.componentId + "/" + imported.fileId);
      if (!target) throw new Error("Declared source import has no accepted target");
      const privateImport =
        source.context !== "server" &&
        ["ServerScriptService", "ServerStorage"].some((root) => target.path.startsWith(root + "/"));
      const requireExpression =
        target.className === "ModuleScript" && !privateImport
          ? expression(source.path, target.path)
          : undefined;
      const row: SourceImportContext = {
        ...imported,
        path: target.path,
        className: target.className,
        ...(target.context ? { context: target.context } : {}),
        ...(target.operationId ? { operationId: target.operationId } : {}),
        content: target.content,
        ...(requireExpression
          ? { requireExpression }
          : {
              unresolved:
                "No unambiguous ModuleScript lookup within the same runtime copy or a stable service root. Inspect the declared target before wiring this import.",
            }),
      };
      const size = Buffer.byteLength(stableJson(row)) + 1;
      if (bytes + size > 16 * 1024) {
        if (imports.length === 0) throw new Error("Source import exceeds the bounded context page");
        break;
      }
      imports.push(row);
      bytes += size;
    }
    const payload = {
      ...base,
      imports,
      ...(request.offset + imports.length < ordered.length
        ? { nextOffset: request.offset + imports.length }
        : {}),
    };
    return structuredClone({ ...payload, hash: contentHash(stableJson(payload)) });
  };
}

function luauString(value: string): string {
  return (
    '"' +
    value.replace(/[\\"\x00-\x1f\x7f]/g, (character) =>
      character === '"'
        ? '\\"'
        : character === "\\"
          ? "\\\\"
          : "\\" + character.charCodeAt(0).toString().padStart(3, "0"),
    ) +
    '"'
  );
}
