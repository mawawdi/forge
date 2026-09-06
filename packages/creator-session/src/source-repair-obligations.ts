import { z } from "zod";
import { contentHash, stableJson, type VerificationIssue } from "../../contracts/src/index.js";
import {
  type PinnedLuauAstDocument,
  type PinnedLuauAstOutcome,
  type PinnedSourceAnalysisHost,
} from "../../source-intelligence/src/index.js";
import {
  isRobloxClassAssignableTo,
  resolveRobloxClassMembers,
} from "../../studio-evidence/src/index.js";

export interface CreatorSourceMemberDiagnostic {
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}
export interface CreatorSourceMemberDiagnosticFrame {
  slotId: string;
  source: string;
  sourceHash: string;
  diagnostics: CreatorSourceMemberDiagnostic[];
}
const memberDiagnostic = /^Key '([^']+)' not found in external type '([^']+)'$/;
const locationShape = {
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  endColumn: z.number().int().positive().optional(),
};
const diagnosticSchema = z
  .object({ message: z.string().regex(memberDiagnostic), ...locationShape })
  .strict();
const frameSchema = z
  .object({
    slotId: z.string().min(1),
    source: z.string(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    diagnostics: z.array(diagnosticSchema).min(1).max(16_384),
  })
  .strict();

export function creatorSourceMemberDiagnostic(
  message: string,
  location: {
    line: number;
    column: number;
    endLine?: number | undefined;
    endColumn?: number | undefined;
  },
): CreatorSourceMemberDiagnostic | undefined {
  if (!memberDiagnostic.test(message)) return undefined;
  const parsed = diagnosticSchema.parse({ message, ...location });
  return {
    message: parsed.message,
    line: parsed.line,
    column: parsed.column,
    ...(parsed.endLine === undefined ? {} : { endLine: parsed.endLine }),
    ...(parsed.endColumn === undefined ? {} : { endColumn: parsed.endColumn }),
  };
}

export function assertCreatorSourceMemberDiagnosticFrame(
  value: unknown,
): asserts value is CreatorSourceMemberDiagnosticFrame {
  const frame = frameSchema.parse(value);
  if (
    Buffer.byteLength(frame.source) > 512 * 1024 ||
    contentHash(frame.source) !== frame.sourceHash
  )
    throw new Error("Member diagnostic history source does not match its bounded hash");
  const lines = frame.source.split("\n");
  for (const diagnostic of frame.diagnostics) {
    const lastLine = diagnostic.endLine ?? diagnostic.line;
    if (
      diagnostic.line > lines.length ||
      lastLine > lines.length ||
      lastLine < diagnostic.line ||
      diagnostic.column > Buffer.byteLength(lines[diagnostic.line - 1]!) + 1 ||
      (diagnostic.endColumn !== undefined &&
        diagnostic.endColumn > Buffer.byteLength(lines[lastLine - 1]!) + 1)
    )
      throw new Error("Member diagnostic location is outside its exact source");
  }
}

type Ast = Record<string, unknown>;
interface Scope {
  name?: string;
  parent?: Scope;
  locals: Map<string, string>;
  aliases: Set<string>;
  writes: Set<string>;
}
interface Access {
  node: Ast;
  receiver: Ast;
  member: string;
  statement: Ast;
  scope: Scope;
  ancestors: Ast[];
  receiverKey: string;
  statementKey: string;
}
interface Witness {
  frame: CreatorSourceMemberDiagnosticFrame;
  diagnostic: CreatorSourceMemberDiagnostic;
  access?: Access;
}
export interface CreatorSourceRepairCheck {
  status: "eligible" | "rejected" | "incomplete";
  hash: string;
  issues: VerificationIssue[];
  witnessedDiagnostics: number;
  limitations: readonly string[];
}
interface CandidateSource {
  slotId: string;
  source: string;
}
const limitations = [
  "Retains previously observed pinned unknown-member diagnostics across repairs; it is not a complete type system or runtime safety proof.",
  "Matches member access, lexical receiver, and statement structure while ignoring spelling changes, annotations, casts and grouping. Unresolved matching or receiver evidence keeps the local gate incomplete.",
  "Concrete receiver evidence uses strict declarations and direct dominating IsA guards with the pinned API catalog; arbitrary casts alone do not establish a lawful receiver.",
];

/** Host-owned diagnostic memory. Candidate code is parsed, never executed. */
export class CreatorSourceRepairGuard {
  private readonly frames = new Map<string, CreatorSourceMemberDiagnosticFrame>();
  private readonly witnesses = new Map<string, Witness>();

  seed(history: readonly CreatorSourceMemberDiagnosticFrame[]): void {
    const frames = new Map(this.frames);
    for (const frame of history) {
      assertCreatorSourceMemberDiagnosticFrame(frame);
      const key = contentHash(stableJson(frame));
      frames.set(key, structuredClone(frame));
    }
    if (Buffer.byteLength(stableJson([...frames.values()])) > 32 * 1024 * 1024)
      throw new Error("Member diagnostic history exceeds the bounded source-analysis budget");
    for (const [key, frame] of frames) this.frames.set(key, frame);
  }

  async check(input: {
    snapshotHash: string;
    analysis: PinnedLuauAstOutcome;
    sources: readonly CandidateSource[];
    diagnostics: readonly VerificationIssue[];
    host: PinnedSourceAnalysisHost;
  }): Promise<CreatorSourceRepairCheck> {
    const issues: VerificationIssue[] = [];
    let incomplete = false;
    const fail = (
      message: string,
      document?: PinnedLuauAstDocument,
      diagnostic?: CreatorSourceMemberDiagnostic,
      unavailable = false,
    ) => {
      incomplete ||= unavailable;
      const row = {
        ruleId: unavailable
          ? "CREATOR_MEMBER_REPAIR_UNPROVEN"
          : "CREATOR_MEMBER_DIAGNOSTIC_RETAINED",
        severity: "error" as const,
        category: unavailable ? ("tooling" as const) : ("language" as const),
        message,
        ...(document ? { path: document.path } : {}),
        ...(diagnostic ? { location: { line: diagnostic.line, column: diagnostic.column } } : {}),
      };
      issues.push({
        ...row,
        kind: "VerificationIssue",
        id: contentHash(stableJson(row)),
        authoritativeTier: "static",
        evidence: [{ type: "pinned_luau_ast", statement: message }],
      });
    };
    try {
      const analysis = input.analysis;
      if (analysis.status !== "complete") {
        if (this.frames.size)
          fail(
            "Previously diagnosed member accesses require complete pinned AST evidence",
            undefined,
            undefined,
            true,
          );
      } else {
        assertAnalysis(analysis, input.snapshotHash);
        const sources = new Map(input.sources.map((source) => [source.slotId, source.source]));
        if (sources.size !== input.sources.length)
          throw new Error("Member repair source slots are duplicated");
        const documents = new Map<string, PinnedLuauAstDocument>();
        for (const [slotId, source] of sources) {
          const matches = analysis.documents.filter((document) => document.documentId === slotId);
          if (
            matches.length !== 1 ||
            matches[0]!.sourceHash !== contentHash(source) ||
            matches[0]!.utf8Bytes !== Buffer.byteLength(source)
          )
            throw new Error("Member repair AST differs from the exact candidate source");
          documents.set(slotId, matches[0]!);
        }
        for (const document of documents.values()) {
          const diagnostics = input.diagnostics.flatMap((issue) => {
            if (
              issue.ruleId !== "LUAU_TYPE_ERROR" ||
              issue.severity !== "error" ||
              issue.path !== document.path ||
              !issue.location
            )
              return [];
            const value = creatorSourceMemberDiagnostic(issue.message, issue.location);
            return value ? [value] : [];
          });
          if (diagnostics.length)
            this.seed([
              {
                slotId: document.documentId,
                source: sources.get(document.documentId)!,
                sourceHash: document.sourceHash,
                diagnostics,
              },
            ]);
        }
        const pending = [...this.frames.entries()].filter(
          ([key]) => !this.witnesses.has(key + ":0"),
        );
        const historical = pending.filter(
          ([, frame]) => documents.get(frame.slotId)?.sourceHash !== frame.sourceHash,
        );
        let historicalDocuments: readonly PinnedLuauAstDocument[] = [];
        if (historical.length) {
          const entries = historical.map(([key, frame]) => {
            const current = documents.get(frame.slotId);
            if (!current)
              throw new Error("Retained member diagnostic is outside the approved source slots");
            return {
              ...current,
              documentId: key,
              path: current.path + "/DiagnosticHistory_" + key,
              sourceHash: frame.sourceHash,
              utf8Bytes: Buffer.byteLength(frame.source),
            };
          });
          const bodies = new Map(historical.map(([key, frame]) => [key, frame.source]));
          const read = (document: { documentId: string; sourceHash: string }) => {
            const source = bodies.get(document.documentId);
            if (source === undefined || contentHash(source) !== document.sourceHash)
              throw new Error("Retained diagnostic source hash differs");
            return source;
          };
          const parsed = await input.host.analyzeAst({
            snapshotHash: input.snapshotHash,
            documents: entries.map(({ ast: _ast, typeMode: _typeMode, ...entry }) => entry),
            resolver: {
              authority: "verified_source_blob",
              read,
              readRange: (document, range) => ({
                ...range,
                source: Buffer.from(read(document))
                  .subarray(range.startByte, range.endByte)
                  .toString("utf8"),
              }),
            },
          });
          if (parsed.status !== "complete")
            throw new Error(
              "Retained member diagnostic source could not be parsed: " + parsed.reason,
            );
          assertAnalysis(parsed, input.snapshotHash);
          if (parsed.toolchain.hash !== analysis.toolchain.hash)
            throw new Error("Historical and current member evidence use different parser pins");
          historicalDocuments = parsed.documents;
        }
        for (const [key, frame] of pending) {
          const document =
            documents.get(frame.slotId)?.sourceHash === frame.sourceHash
              ? documents.get(frame.slotId)!
              : historicalDocuments.find((entry) => entry.documentId === key);
          if (!document) throw new Error("Retained diagnostic parser output is missing");
          const accesses = memberAccesses(document.ast);
          frame.diagnostics.forEach((diagnostic, index) => {
            const member = memberDiagnostic.exec(diagnostic.message)![1]!;
            const matches = accesses.filter(
              (access) => access.member === member && contains(access.node, diagnostic),
            );
            this.witnesses.set(key + ":" + index, {
              frame,
              diagnostic,
              ...(matches.length === 1 ? { access: matches[0]! } : {}),
            });
          });
        }
        const witnessedSlots = new Set(
          [...this.witnesses.values()].map((witness) => witness.frame.slotId),
        );
        const accessBySlot = new Map(
          [...documents]
            .filter(([slotId]) => witnessedSlots.has(slotId))
            .map(([slotId, document]) => [slotId, memberAccesses(document.ast)]),
        );
        for (const witness of this.witnesses.values()) {
          const document = documents.get(witness.frame.slotId);
          if (!document) throw new Error("Retained member obligation lost its approved source");
          const old = witness.access;
          if (!old) {
            fail(
              "The exact diagnosed member could not be bound to one AST access; change the access or provide unambiguous receiver evidence",
              document,
              undefined,
              true,
            );
            continue;
          }
          const accesses = accessBySlot.get(witness.frame.slotId)!;
          const matches = accesses.filter(
            (access) =>
              access.member === old.member &&
              access.receiverKey === old.receiverKey &&
              (access.statementKey === old.statementKey ||
                (scopeName(access.scope) !== undefined &&
                  scopeName(access.scope) === scopeName(old.scope))),
          );
          if (!matches.length) {
            if (
              accesses.some(
                (access) =>
                  access.member === old.member && access.statementKey === old.statementKey,
              )
            )
              fail(
                "The previously diagnosed " +
                  old.member +
                  " access moved to an ambiguous receiver; the repair requires concrete receiver evidence",
                document,
                undefined,
                true,
              );
            continue;
          }
          for (const access of matches) {
            const proof = receiverClass(access);
            if (
              proof &&
              resolveRobloxClassMembers(proof).some((member) => member.name === access.member)
            )
              continue;
            // The current analyzer already publishes a more precise error for an unchanged diagnosed source.
            if (
              input.diagnostics.some(
                (issue) =>
                  issue.ruleId === "LUAU_TYPE_ERROR" &&
                  issue.severity === "error" &&
                  issue.path === document.path &&
                  issue.message === witness.diagnostic.message &&
                  issue.location &&
                  contains(access.node, issue.location),
              )
            )
              continue;
            const erased = receiverIsAny(access.receiver);
            const location = astLocation(access.node);
            fail(
              "Previously diagnosed " +
                witness.diagnostic.message +
                " remains at this access (source " +
                witness.frame.sourceHash.slice(0, 12) +
                "). " +
                (erased
                  ? "Changing its receiver to any or casting it does not resolve the invalid member. "
                  : "A lawful receiver has not been established. ") +
                "Change the member access, use a concrete supported receiver declaration, or narrow the receiver with IsA before this access.",
              document,
              location
                ? {
                    message: witness.diagnostic.message,
                    line: location[0] + 1,
                    column: location[1] + 1,
                  }
                : undefined,
              !erased,
            );
          }
        }
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), undefined, undefined, true);
    }
    const payload = {
      status: incomplete
        ? ("incomplete" as const)
        : issues.length
          ? ("rejected" as const)
          : ("eligible" as const),
      issues,
      witnessedDiagnostics: this.witnesses.size,
      limitations,
    };
    return { ...payload, hash: contentHash(stableJson(payload)) };
  }
}

function assertAnalysis(
  analysis: Extract<PinnedLuauAstOutcome, { status: "complete" }>,
  snapshotHash: string,
): void {
  const { hash, ...payload } = analysis;
  if (
    hash !== contentHash(stableJson(payload)) ||
    analysis.snapshotHash !== snapshotHash ||
    analysis.executions.length + analysis.reusedParses.length !== analysis.documents.length ||
    new Set(analysis.documents.map((document) => document.documentId)).size !==
      analysis.documents.length
  )
    throw new Error(
      "Member repair evidence is not bound to the exact pinned parser output and revision",
    );
}
function object(value: unknown): Ast | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Ast)
    : undefined;
}
function localKey(value: unknown): string | undefined {
  const local = object(value);
  return local?.type === "AstLocal" &&
    typeof local.name === "string" &&
    typeof local.location === "string"
    ? local.name + "@" + local.location
    : undefined;
}
function unwrap(value: Ast): Ast {
  let current = value;
  for (let depth = 0; depth < 64; depth++) {
    if (current.type !== "AstExprGroup" && current.type !== "AstExprTypeAssertion") return current;
    const next = object(current.expr);
    if (!next) break;
    current = next;
  }
  return current;
}
function scopeName(scope: Scope): string | undefined {
  return scope.name ?? (scope.parent ? scopeName(scope.parent) : undefined);
}
function role(scope: Scope, local: unknown): string {
  const key = localKey(local);
  let current: Scope | undefined = scope;
  while (current) {
    if (key && current.locals.has(key)) return current.locals.get(key)!;
    current = current.parent;
  }
  return "unresolved-local";
}
function canonical(
  node: unknown,
  scope: Scope,
  alpha = false,
  names = new Map<string, number>(),
  depth = 0,
): unknown {
  if (depth > 128) throw new Error("Member repair AST exceeds the bounded expression depth");
  if (Array.isArray(node))
    return node.map((value) => canonical(value, scope, alpha, names, depth + 1));
  const ast = object(node);
  if (!ast) return node;
  if (ast.type === "AstExprGroup" || ast.type === "AstExprTypeAssertion")
    return canonical(ast.expr, scope, alpha, names, depth + 1);
  const member =
    ast.type === "AstExprIndexName"
      ? ast.index
      : ast.type === "AstExprIndexExpr" && object(ast.index)?.type === "AstExprConstantString"
        ? object(ast.index)?.value
        : undefined;
  if (typeof member === "string")
    return {
      type: "member",
      receiver: canonical(ast.expr, scope, alpha, names, depth + 1),
      member,
    };
  if (ast.type === "AstExprLocal" || ast.type === "AstLocal") {
    const local = ast.type === "AstLocal" ? ast : ast.local;
    const key = localKey(local) ?? "unknown";
    if (!names.has(key)) names.set(key, names.size);
    return { type: "local", identity: alpha ? names.get(key) : role(scope, local) };
  }
  return Object.fromEntries(
    Object.entries(ast)
      .filter(
        ([key]) =>
          key !== "luauType" &&
          key !== "annotation" &&
          key !== "debugname" &&
          key !== "functionDepth" &&
          !key.toLowerCase().includes("location"),
      )
      .map(([key, value]) => [key, canonical(value, scope, alpha, names, depth + 1)]),
  );
}
function memberAccesses(root: unknown): Access[] {
  const accesses: Access[] = [];
  let visited = 0;
  const walk = (value: unknown, scope: Scope, ancestors: Ast[], statement?: Ast): void => {
    if (++visited > 250_000 || ancestors.length > 256)
      throw new Error("Member repair AST exceeds its bounded traversal");
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, scope, ancestors, statement);
      return;
    }
    const node = object(value);
    if (!node || typeof node.type !== "string") return;
    if (node.type === "AstExprLocal" || node.type === "AstLocal" || node.type.startsWith("AstType"))
      return;
    if (node.type === "AstExprFunction") {
      scope = {
        ...(typeof node.debugname === "string" && node.debugname ? { name: node.debugname } : {}),
        parent: scope,
        locals: new Map(),
        aliases: new Set(),
        writes: scope.writes,
      };
      if (Array.isArray(node.args))
        node.args.forEach((argument, index) => {
          const key = localKey(argument);
          if (key) scope.locals.set(key, "parameter:" + index);
        });
      if (Array.isArray(node.generics))
        node.generics.forEach((generic) => {
          const name = object(generic)?.name;
          if (typeof name === "string") scope.aliases.add(name);
        });
    }
    if (node.type === "AstStatTypeAlias" && typeof node.name === "string")
      scope.aliases.add(node.name);
    if (node.type === "AstStatAssign" && Array.isArray(node.vars))
      node.vars.forEach((variable) => {
        const expr = object(variable);
        const key = expr?.type === "AstExprLocal" ? localKey(expr.local) : undefined;
        if (key) scope.writes.add(key);
      });
    if (node.type === "AstStatLocal" && Array.isArray(node.vars))
      node.vars.forEach((local) => {
        const key = localKey(local);
        if (key && !scope.locals.has(key)) scope.locals.set(key, "local:" + scope.locals.size);
      });
    if (node.type.startsWith("AstStat") && node.type !== "AstStatBlock") statement = node;
    const receiver = object(node.expr);
    const index =
      node.type === "AstExprIndexName"
        ? node.index
        : node.type === "AstExprIndexExpr" && object(node.index)?.type === "AstExprConstantString"
          ? object(node.index)?.value
          : undefined;
    if (typeof index === "string" && receiver && statement)
      accesses.push({
        node,
        receiver,
        member: index,
        scope,
        statement,
        ancestors,
        receiverKey: stableJson(canonical(receiver, scope)),
        statementKey: stableJson(canonical(statement, scope, true)),
      });
    for (const [key, child] of Object.entries(node)) {
      if (
        key === "local" ||
        key === "luauType" ||
        (key === "args" && node.type === "AstExprFunction") ||
        (key === "vars" && node.type === "AstStatLocal")
      )
        continue;
      walk(child, scope, [...ancestors, node], statement);
    }
  };
  const parsed = object(object(root)?.root);
  if (parsed?.type !== "AstStatBlock")
    throw new Error("Member repair document has no official AST root");
  walk(parsed, { locals: new Map(), aliases: new Set(), writes: new Set() }, []);
  return accesses;
}
function astLocation(node: Ast): [number, number, number, number] | undefined {
  const match =
    typeof node.location === "string" ? /^(\d+),(\d+) - (\d+),(\d+)$/.exec(node.location) : null;
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
    : undefined;
}
function contains(node: Ast, diagnostic: { line: number; column: number }): boolean {
  const bounds = astLocation(node);
  if (!bounds) return false;
  const point = [diagnostic.line - 1, diagnostic.column - 1];
  return (
    (point[0]! > bounds[0] || (point[0] === bounds[0] && point[1]! >= bounds[1])) &&
    (point[0]! < bounds[2] || (point[0] === bounds[2] && point[1]! <= bounds[3]))
  );
}
function declaredType(receiver: Ast): string | undefined {
  const plain = unwrap(receiver);
  const annotation =
    plain.type === "AstExprLocal" ? object(object(plain.local)?.luauType) : undefined;
  return annotation?.type === "AstTypeReference" &&
    typeof annotation.name === "string" &&
    !annotation.prefix &&
    Array.isArray(annotation.parameters) &&
    annotation.parameters.length === 0
    ? annotation.name
    : undefined;
}
function receiverIsAny(receiver: Ast): boolean {
  if (declaredType(receiver) === "any") return true;
  let current = receiver;
  for (let depth = 0; depth < 64; depth++) {
    if (current.type === "AstExprTypeAssertion") return true;
    if (current.type !== "AstExprGroup") break;
    const next = object(current.expr);
    if (!next) break;
    current = next;
  }
  return false;
}
function receiverClass(access: Access): string | undefined {
  const receiver = unwrap(access.receiver);
  const key = receiver.type === "AstExprLocal" ? localKey(receiver.local) : undefined;
  const declared = declaredType(access.receiver);
  let scope: Scope | undefined = access.scope;
  while (scope) {
    if (declared && scope.aliases.has(declared)) return undefined;
    scope = scope.parent;
  }
  // Accept only a direct dominating positive IsA branch for the same lexical receiver.
  for (let index = access.ancestors.length - 1; index >= 0; index--) {
    const ancestor = access.ancestors[index]!;
    if (ancestor.type !== "AstStatIf") continue;
    const thenbody = object(ancestor.thenbody);
    if (!thenbody || !access.ancestors.slice(index + 1).includes(thenbody)) continue;
    const condition = object(ancestor.condition);
    const func = object(condition?.func);
    const arguments_ = condition?.args;
    if (
      condition?.type !== "AstExprCall" ||
      condition.self !== true ||
      func?.type !== "AstExprIndexName" ||
      func.index !== "IsA" ||
      !Array.isArray(arguments_) ||
      arguments_.length !== 1
    )
      continue;
    const target = object(arguments_[0]);
    if (
      key &&
      declared &&
      isRobloxClassAssignableTo(declared, "Instance") &&
      !access.scope.writes.has(key) &&
      target?.type === "AstExprConstantString" &&
      typeof target.value === "string" &&
      stableJson(canonical(func.expr, access.scope)) === access.receiverKey
    )
      return target.value;
  }
  return declared === "any" || declared === "unknown" || declared === "never"
    ? undefined
    : declared;
}
