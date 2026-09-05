import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertGamePlan,
  gameInventoryOperation,
  type GamePlan,
} from "../../game-compiler/src/index.js";
import type {
  PinnedLuauAstDocument,
  PinnedLuauAstOutcome,
} from "../../source-intelligence/src/index.js";
import {
  ROBLOX_API_CATALOG_HASH,
  resolveRobloxClassMembers,
  studioObjectIdentityKey,
} from "../../studio-evidence/src/index.js";
import { compileCreatorTransactionTopology } from "./transaction-topology.js";

export interface GameSourceImportCheck {
  readonly status: "eligible" | "rejected" | "incomplete";
  readonly hash: string;
  readonly issues: readonly {
    ruleId: string;
    severity: "error";
    category: "source" | "tooling";
    message: string;
    path?: string;
    location?: string;
  }[];
  readonly imports: readonly { from: string; to: string }[];
  readonly limitations: readonly string[];
}

const LIMITATIONS = [
  "This checks syntactic require authority against the final editor topology, not runtime execution, type soundness or an OS sandbox.",
  "Runtime code may construct instances and use services. Changes to topology during execution can invalidate static paths and need native runtime evidence.",
  "The profile accepts direct global require calls with immutable local instance aliases; require values, dynamic targets and environment introspection cannot certify a complete declared graph.",
];
type Ast = Record<string, unknown>;
interface SourceBinding {
  key: string;
  path: string;
  className: string;
  documentId?: string;
  sourceHash?: string;
  utf8Bytes?: number;
  maximumUtf8Bytes?: number;
  context?: "server" | "client" | "shared";
  declared: Set<string>;
}

/** Host-only consumer of official parser output. It never evaluates candidate code. */
export function checkGameSourceImports(input: {
  plan: GamePlan;
  analysis: PinnedLuauAstOutcome;
}): GameSourceImportCheck {
  const issues: GameSourceImportCheck["issues"][number][] = [];
  const imports: { from: string; to: string }[] = [];
  let incomplete = false;
  const issue = (
    code: string,
    message: string,
    document?: PinnedLuauAstDocument,
    node?: Ast,
    tooling = false,
  ) => {
    if (tooling) incomplete = true;
    issues.push({
      ruleId: code,
      severity: "error",
      category: tooling ? "tooling" : "source",
      message,
      ...(document ? { path: document.path } : {}),
      ...(typeof node?.location === "string" ? { location: node.location } : {}),
    });
  };
  try {
    assertGamePlan(input.plan);
    const analysis = input.analysis;
    if (analysis.status !== "complete") {
      issue(analysis.code, analysis.reason, undefined, undefined, true);
    } else {
      const { hash, ...payload } = analysis;
      if (
        hash !== contentHash(stableJson(payload)) ||
        analysis.snapshotHash !== input.plan.observedRevisionHash
      )
        throw new Error(
          "AST evidence is not bound to the approved revision and exact parser output",
        );
      const topology = compileCreatorTransactionTopology({
        initial: input.plan.initialTopology,
        operations: input.plan.inventory.map((item) => gameInventoryOperation(input.plan, item)),
      });
      const paths = new Map<string, (typeof topology.finalNodes)[number][]>();
      const identities = new Map(
        topology.finalNodes.map((node) => [studioObjectIdentityKey(node.identity), node]),
      );
      for (const node of topology.finalNodes)
        paths.set(node.path, [...(paths.get(node.path) ?? []), node]);
      const sources = new Map<string, SourceBinding>();
      const sourceByOperation = new Map(
        input.plan.inventory.flatMap((item) =>
          item.source ? [[item.id, item.componentId + "/" + item.source.fileId] as const] : [],
        ),
      );
      for (const item of input.plan.inventory) {
        if (!item.source) continue;
        const operation = gameInventoryOperation(input.plan, item);
        const node = identities.get(studioObjectIdentityKey(operation.target.identity));
        if (!node) throw new Error("Source inventory is absent from final topology");
        const component = input.plan.design.components.find(
          (component) => component.id === item.componentId,
        )!;
        const file =
          component.kind === "source_package"
            ? component.files.find((file) => file.id === item.source!.fileId)
            : undefined;
        const content = item.source.content;
        const binding: SourceBinding = {
          key: item.componentId + "/" + item.source.fileId,
          path: node.path,
          className: node.className,
          documentId: item.id,
          ...(content.kind === "locked"
            ? { sourceHash: content.sourceHash, utf8Bytes: content.utf8Bytes }
            : { maximumUtf8Bytes: content.maximumUtf8Bytes }),
          ...(file ? { context: file.context } : {}),
          declared: new Set(
            file
              ? file.imports.map((entry) => entry.componentId + "/" + entry.fileId)
              : item.dependencies.flatMap((id) =>
                  sourceByOperation.has(id) ? [sourceByOperation.get(id)!] : [],
                ),
          ),
        };
        sources.set(binding.key, binding);
      }
      for (const source of input.plan.observedSources)
        sources.set(source.componentId + "/" + source.fileId, {
          key: source.componentId + "/" + source.fileId,
          path: source.target.path,
          className: source.target.className,
          sourceHash: source.sourceHash,
          utf8Bytes: source.utf8Bytes,
          declared: new Set(source.imports.map((entry) => entry.componentId + "/" + entry.fileId)),
        });
      const byPath = new Map<string, SourceBinding[]>();
      for (const source of sources.values())
        byPath.set(source.path, [...(byPath.get(source.path) ?? []), source]);
      const used = new Set<PinnedLuauAstDocument>();
      for (const source of sources.values()) {
        const matches = analysis.documents.filter(
          (document) =>
            document.path === source.path &&
            (source.documentId === undefined || document.documentId === source.documentId),
        );
        if (matches.length !== 1) {
          issue(
            "game_import_source_missing",
            `Expected exactly one AST document for ${source.key}`,
            undefined,
            undefined,
            true,
          );
          continue;
        }
        const document = matches[0]!;
        used.add(document);
        if (document.typeMode === "nocheck" || document.typeMode === "nonstrict")
          issue(
            "game_source_strictness_directive",
            "Candidate source cannot weaken the host strict type-analysis policy with --!nocheck or --!nonstrict",
            document,
          );
        if (
          document.className !== source.className ||
          (source.sourceHash !== undefined && document.sourceHash !== source.sourceHash) ||
          (source.utf8Bytes !== undefined && document.utf8Bytes !== source.utf8Bytes) ||
          (source.maximumUtf8Bytes !== undefined && document.utf8Bytes > source.maximumUtf8Bytes) ||
          (source.context !== undefined && document.executionContext !== source.context)
        ) {
          issue(
            "game_import_source_binding",
            `AST source does not match ${source.key}`,
            document,
            undefined,
            true,
          );
          continue;
        }
        if (
          !record(document.ast) ||
          !record(document.ast.root) ||
          document.ast.root.type !== "AstStatBlock"
        )
          throw new Error("Unsupported AST envelope");
        const rows = astRows(document.ast.root);
        const declarations = new Map<string, Ast>();
        const writes = new Set<string>();
        const rootWrites = new Set<string>();
        const recordWrite = (node: unknown) => {
          if (!record(node)) return;
          if (node.type === "AstExprLocal") writes.add(localKey(node.local));
          if (node.type === "AstExprGlobal" && typeof node.global === "string")
            rootWrites.add(node.global);
        };
        for (const { node } of rows) {
          if (
            node.type === "AstStatLocal" &&
            Array.isArray(node.vars) &&
            Array.isArray(node.values)
          )
            for (let i = 0; i < node.vars.length; i++)
              if (record(node.values[i]))
                declarations.set(localKey(node.vars[i]), node.values[i] as Ast);
          if (node.type === "AstStatAssign" && Array.isArray(node.vars))
            for (const variable of node.vars) recordWrite(variable);
          if (node.type === "AstStatCompoundAssign") recordWrite(node.var);
          if (node.type === "AstStatFunction") recordWrite(node.name);
        }
        const uniquePath = (path: string): string | undefined =>
          paths.get(path)?.length === 1 ? path : undefined;
        const child = (parent: string, name: string): string | undefined => {
          if (!name || name.includes("/")) return undefined;
          return uniquePath(parent ? parent + "/" + name : name);
        };
        const resolvePath = (
          expression: unknown,
          seen = new Set<string>(),
          depth = 0,
        ): string | undefined => {
          if (!record(expression) || depth > 64) return undefined;
          const nested = (value: unknown) => resolvePath(value, seen, depth + 1);
          if (expression.type === "AstExprGroup" || expression.type === "AstExprTypeAssertion")
            return nested(expression.expr);
          if (expression.type === "AstExprGlobal") {
            if (rootWrites.has(String(expression.global))) return undefined;
            if (expression.global === "game") return "";
            if (expression.global === "script") return uniquePath(source.path);
            if (expression.global === "workspace") return uniquePath("Workspace");
          }
          if (expression.type === "AstExprLocal") {
            const key = localKey(expression.local);
            if (writes.has(key) || seen.has(key)) return undefined;
            return resolvePath(declarations.get(key), new Set([...seen, key]), depth + 1);
          }
          if (expression.type === "AstExprIndexName" || expression.type === "AstExprIndexExpr") {
            const parent = nested(expression.expr);
            const name =
              expression.type === "AstExprIndexName"
                ? expression.index
                : constantString(expression.index);
            if (parent === undefined || typeof name !== "string") return undefined;
            const parentNode = paths.get(parent)?.[0];
            if (name === "Parent")
              return parentNode?.parentIdentity
                ? identities.get(studioObjectIdentityKey(parentNode.parentIdentity))?.path
                : undefined;
            // Roblox property/method lookup precedes child lookup. A child named Name
            // is only addressable through an explicit child lookup in this profile.
            const className = parentNode?.className ?? "DataModel";
            if (resolveRobloxClassMembers(className).some((member) => member.name === name))
              return undefined;
            return child(parent, name);
          }
          if (
            expression.type === "AstExprCall" &&
            expression.self === true &&
            record(expression.func) &&
            expression.func.type === "AstExprIndexName" &&
            Array.isArray(expression.args)
          ) {
            const parent = nested(expression.func.expr);
            const name = constantString(expression.args[0]);
            if (parent === undefined || name === undefined) return undefined;
            if (
              expression.func.index === "GetService" &&
              parent === "" &&
              expression.args.length === 1
            ) {
              const node = paths.get(name)?.[0];
              return node?.className === name &&
                input.plan.initialTopology.some((entry) => entry.engineContainer?.path === name)
                ? uniquePath(name)
                : undefined;
            }
            if (
              ["WaitForChild", "FindFirstChild"].includes(String(expression.func.index)) &&
              expression.args.length === 1
            )
              return child(parent, name);
          }
          return undefined;
        };
        const actual = new Set<string>();
        let rejectedDocument = false;
        for (const { node, parent, field } of rows) {
          if (node.type !== "AstExprGlobal") continue;
          const traceback =
            node.global === "debug" &&
            field === "expr" &&
            ((parent?.type === "AstExprIndexName" && parent.index === "traceback") ||
              (parent?.type === "AstExprIndexExpr" &&
                constantString(parent.index) === "traceback"));
          if (
            !traceback &&
            [
              "getfenv",
              "setfenv",
              "_G",
              "shared",
              "loadstring",
              "load",
              "dofile",
              "debug",
            ].includes(String(node.global))
          ) {
            issue(
              "game_import_environment_unresolved",
              "Environment or code introspection prevents complete static import authority",
              document,
              node,
              true,
            );
            rejectedDocument = true;
          }
          if (node.global !== "require") continue;
          if (parent?.type !== "AstExprCall" || field !== "func") {
            issue(
              "game_import_require_alias",
              "Global require must be called directly; passing or aliasing it does not declare an exact dependency",
              document,
              node,
            );
            rejectedDocument = true;
            continue;
          }
          const args = parent.args;
          const path = Array.isArray(args) && args.length === 1 ? resolvePath(args[0]) : undefined;
          if (path === undefined) {
            issue(
              "game_import_dynamic_target",
              "require target is not a statically resolved immutable instance path",
              document,
              parent,
            );
            rejectedDocument = true;
            continue;
          }
          const target = byPath.get(path);
          if (
            target?.length !== 1 ||
            target[0]!.className !== "ModuleScript" ||
            paths.get(path)?.length !== 1
          ) {
            issue(
              "game_import_undeclared_target",
              `require target ${path} is not one exact declared module`,
              document,
              parent,
            );
            rejectedDocument = true;
            continue;
          }
          const key = target[0]!.key;
          actual.add(key);
          if (!source.declared.has(key)) {
            issue(
              "game_import_undeclared_edge",
              `${source.key} does not declare its import of ${key}`,
              document,
              parent,
            );
            rejectedDocument = true;
          }
        }
        for (const to of [...actual].sort()) imports.push({ from: source.key, to });
        if (!rejectedDocument)
          for (const expected of source.declared)
            if (!actual.has(expected))
              issue(
                "game_import_unused_declaration",
                `${source.key} declares ${expected} but its source has no matching require`,
                document,
              );
      }
      if (used.size !== analysis.documents.length)
        issue(
          "game_import_extra_document",
          "AST input includes source outside the approved package/dependency inventory",
          undefined,
          undefined,
          true,
        );
    }
  } catch (error) {
    issue(
      "game_import_evidence_incomplete",
      error instanceof Error ? error.message : String(error),
      undefined,
      undefined,
      true,
    );
  }
  const result = {
    status: (incomplete
      ? "incomplete"
      : issues.length
        ? "rejected"
        : "eligible") as GameSourceImportCheck["status"],
    issues,
    imports: imports.sort((a, b) => (a.from + "/" + a.to).localeCompare(b.from + "/" + b.to)),
    limitations: LIMITATIONS,
  };
  return {
    ...result,
    hash: contentHash(
      stableJson({
        ...result,
        planHash: input.plan.hash,
        analysis: input.analysis.status === "complete" ? input.analysis.hash : input.analysis,
        catalogHash: ROBLOX_API_CATALOG_HASH,
        profile: "declared-static-imports@1",
      }),
    ),
  };
}

function record(value: unknown): value is Ast {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function constantString(value: unknown): string | undefined {
  return record(value) && value.type === "AstExprConstantString" && typeof value.value === "string"
    ? value.value
    : undefined;
}
function localKey(value: unknown): string {
  if (
    !record(value) ||
    value.type !== "AstLocal" ||
    typeof value.name !== "string" ||
    typeof value.location !== "string"
  )
    throw new Error("Unsupported official AST local identity");
  return value.name + "@" + value.location;
}
function astRows(root: Ast): { node: Ast; parent?: Ast; field?: string }[] {
  const rows: { node: Ast; parent?: Ast; field?: string }[] = [];
  const pending: { value: unknown; parent?: Ast; field?: string; depth: number }[] = [
    { value: root, depth: 0 },
  ];
  while (pending.length) {
    const entry = pending.pop()!;
    if (rows.length > 250_000 || entry.depth > 256)
      throw new Error("AST traversal resource bound exceeded");
    if (Array.isArray(entry.value)) {
      for (const value of entry.value) pending.push({ ...entry, value, depth: entry.depth + 1 });
      continue;
    }
    if (!record(entry.value)) continue;
    const node = entry.value;
    rows.push({
      node,
      ...(entry.parent ? { parent: entry.parent } : {}),
      ...(entry.field ? { field: entry.field } : {}),
    });
    for (const [field, value] of Object.entries(node))
      pending.push({ value, parent: node, field, depth: entry.depth + 1 });
  }
  return rows;
}
