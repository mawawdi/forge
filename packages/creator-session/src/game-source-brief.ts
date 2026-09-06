import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { GamePlan } from "../../game-compiler/src/index.js";
import { PinnedSourceAnalysisHost } from "../../source-intelligence/src/index.js";
import { createLuauDeclarationOutline } from "../../source-intelligence/src/declaration-outline.js";
import { createGameSourceContextReader } from "./game-source-context.js";

type SourcePage = ReturnType<ReturnType<typeof createGameSourceContextReader>>;
type ImportedModule = SourcePage["imports"][number];

/** Derived initial navigation and exact pinned-source excerpts, never new import authority. */
export async function createGameSourceBrief(
  plan: GamePlan,
  lockedSources: ReadonlyMap<string, string>,
) {
  const readContext = createGameSourceContextReader(plan);
  const modules: Array<Omit<ImportedModule, "requireExpression" | "unresolved">> = [];
  const moduleIndex = new Map<string, number>();
  const slots: Array<{
    operationId: string;
    imports: Array<{ module: number; requireExpression?: string; unresolved?: string }>;
    nextOffset?: number;
  }> = [];
  const customSources = plan.inventory.filter((item) => item.source?.content.kind === "slot");
  for (const item of customSources) {
    const page = readContext({ planHash: plan.hash, operationId: item.id, offset: 0 });
    const additions: typeof modules = [];
    const indices = new Map(moduleIndex);
    const imports = page.imports.map(({ requireExpression, unresolved, ...descriptor }) => {
      const key = descriptor.componentId + "/" + descriptor.fileId;
      let index = indices.get(key);
      if (index === undefined) {
        index = modules.length + additions.length;
        indices.set(key, index);
        additions.push(descriptor);
      }
      return {
        module: index,
        ...(requireExpression ? { requireExpression } : {}),
        ...(unresolved ? { unresolved } : {}),
      };
    });
    const slot = {
      operationId: item.id,
      imports,
      ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
    };
    const size = Buffer.byteLength(
      stableJson({ slots: [...slots, slot], modules: [...modules, ...additions] }),
    );
    if (size > 32 * 1024) break;
    slots.push(slot);
    modules.push(...additions);
    for (const [key, value] of indices) moduleIndex.set(key, value);
  }
  const documents = [];
  const deferredDeclarations: Array<{ sourceHash: string; reason: string }> = [];
  const sourceBytes = new Map<string, string>();
  let aggregateBytes = 0;
  for (const module of modules) {
    if (
      module.content.kind !== "locked" ||
      !module.content.sourceHash ||
      sourceBytes.has(module.content.sourceHash)
    )
      continue;
    const source = lockedSources.get(module.content.sourceHash);
    if (
      source === undefined ||
      contentHash(source) !== module.content.sourceHash ||
      Buffer.byteLength(source) !== module.content.utf8Bytes
    )
      throw new Error(
        "Accepted locked source is unavailable or changed during source reference preparation",
      );
    if (documents.length >= 32 || aggregateBytes + Buffer.byteLength(source) > 2 * 1024 * 1024) {
      deferredDeclarations.push({
        sourceHash: module.content.sourceHash,
        reason: "parser_input_budget",
      });
      continue;
    }
    aggregateBytes += Buffer.byteLength(source);
    sourceBytes.set(module.content.sourceHash, source);
    documents.push({
      documentId: module.content.sourceHash,
      path: module.path,
      className: module.className,
      executionContext:
        module.context ??
        (module.className === "Script"
          ? ("server" as const)
          : module.className === "LocalScript"
            ? ("client" as const)
            : ("shared" as const)),
      sourceHash: module.content.sourceHash,
      utf8Bytes: Buffer.byteLength(source),
    });
  }
  const declarations: ReturnType<typeof createLuauDeclarationOutline>[] = [];
  let parsing: { status: "complete" | "incomplete"; reason?: string; toolchainHash?: string } = {
    status: "complete",
  };
  if (documents.length > 0) {
    const host = await PinnedSourceAnalysisHost.create({ root: process.cwd() });
    const read = (document: { documentId: string; sourceHash: string }) => {
      const source = sourceBytes.get(document.documentId);
      if (source === undefined || contentHash(source) !== document.sourceHash)
        throw new Error("Source reference parser input differs from accepted bytes");
      return source;
    };
    const analysis = await host.analyzeAst({
      snapshotHash: plan.observedRevisionHash,
      documents,
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
    if (analysis.status !== "complete") {
      parsing = { status: "incomplete", reason: analysis.code };
      for (const document of documents)
        deferredDeclarations.push({ sourceHash: document.sourceHash, reason: analysis.code });
    } else {
      parsing = { status: "complete", toolchainHash: analysis.toolchain.hash };
      for (const document of analysis.documents) {
        const outline = createLuauDeclarationOutline(document, read(document));
        const size = Buffer.byteLength(stableJson([...declarations, outline]));
        if (size > 48 * 1024) {
          deferredDeclarations.push({
            sourceHash: document.sourceHash,
            reason: "declaration_output_budget",
          });
          continue;
        }
        if (!outline.complete)
          deferredDeclarations.push({
            sourceHash: document.sourceHash,
            reason: "partial_declaration_outline",
          });
        declarations.push(outline);
      }
    }
  }
  const payload = {
    kind: "GameSourceReference" as const,
    planHash: plan.hash,
    slots,
    modules,
    deferredSourceSlots: customSources.length - slots.length,
    declarations,
    deferredDeclarations,
    parsing,
    guidance: [
      "Use these exact accepted import expressions and hash-bound declaration excerpts directly. Do not reread supplied information merely to confirm it.",
      "Module class/context descriptors come from accepted topology and declared source metadata. Parser context defaults only by script class when undeclared; this does not prove runtime placement or behavior. Module indexes refer to this reference's modules array. Declaration excerpts bind modules by sourceHash; they are source declarations, not inferred API or native behavior guarantees.",
      "For a deferred slot or further import page, use game.source_context. For missing behavior in a generated locked module, use game.read_locked_source with its accepted operationId. For an observed module without an operationId, use the approved source.read path. Parser completion does not imply complete API coverage; omitted declarations are listed separately.",
    ],
  };
  return { ...payload, hash: contentHash(stableJson(payload)) };
}
