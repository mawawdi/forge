import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import {
  AgentExecutionJournalStore,
  type ForgeNativeAgentRuntime,
} from "../../agent-runtime/src/index.js";

export type CompactConversation = ForgeNativeAgentRuntime["compact"];
export interface ConversationHistoryItem {
  id: string;
  hash: string;
  role: string;
  text: string;
}
interface Checkpoint {
  kind: "CreatorConversationCompaction";
  conversationId: string;
  coveredCount: number;
  prefixHash: string;
  summary: string;
  model: string;
  previous?: ArtifactReference;
  execution: ArtifactReference;
  journalId: string;
}

/** Full history stays immutable. Only the model input is replaced, after a successful handoff. */
export class CreatorConversationCompactor {
  private readonly artifacts: ImmutableJsonArtifactStore;
  constructor(
    private readonly directory: string,
    private readonly compact?: CompactConversation,
  ) {
    this.artifacts = new ImmutableJsonArtifactStore(directory);
  }
  async prepare(conversationId: string, model: string, items: readonly ConversationHistoryItem[]) {
    const directory = join(this.directory, "conversation-compactions");
    const path = join(directory, `${contentHash(conversationId)}.json`);
    let binding: ArtifactReference | undefined;
    try {
      binding = JSON.parse(await readFile(path, "utf8")) as ArtifactReference;
      assertArtifactReference(binding);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let checkpoint = binding ? await this.artifacts.read(binding, assertCheckpoint) : undefined;
    if (
      checkpoint &&
      (checkpoint.conversationId !== conversationId ||
        checkpoint.coveredCount > items.length ||
        checkpoint.prefixHash !== prefixHash(items, checkpoint.coveredCount))
    )
      throw new Error("Conversation compaction does not match its immutable history");
    let covered = checkpoint?.coveredCount ?? 0;
    const bytes = (value: unknown) => Buffer.byteLength(stableJson(value), "utf8");
    // A conservative input-size threshold, not a claim about provider tokenization.
    // Leave recent whole messages verbatim. No message is sliced or dropped.
    while (bytes({ summary: checkpoint?.summary, recent: items.slice(covered) }) > 96 * 1024) {
      let end = covered;
      let chunkBytes = 0;
      while (end < items.length - 2) {
        const nextBytes = bytes(items[end]);
        if (end > covered && chunkBytes + nextBytes > 64 * 1024) break;
        chunkBytes += nextBytes;
        end += 1;
      }
      if (end === covered) break; // At most two intact recent messages, even when unusually large.
      if (!this.compact)
        throw new Error(
          "Automatic conversation compaction is unavailable; history has been preserved.",
        );
      const journalId = `compaction_${randomUUID()}`;
      const prompt = stableJson({
        previousHandoff: checkpoint?.summary ?? null,
        newHistory: items.slice(covered, end),
      });
      const response = await this.compact({
        prompt,
        model,
        executionJournal: new AgentExecutionJournalStore(this.artifacts).sink(journalId),
      });
      const execution = await this.artifacts.write(response.result);
      if (!response.summary || response.result.status !== "completed")
        throw new Error(
          `Conversation compaction could not finish. History is unchanged. ${response.result.error ?? "No valid handoff was returned."}`,
        );
      const next: Checkpoint = {
        kind: "CreatorConversationCompaction",
        conversationId,
        coveredCount: end,
        prefixHash: prefixHash(items, end),
        summary: response.summary,
        model,
        execution,
        journalId,
        ...(binding ? { previous: binding } : {}),
      };
      assertCheckpoint(next);
      const nextBinding = await this.artifacts.write(next);
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(temporary, stableJson(nextBinding), { mode: 0o600 });
      await rename(temporary, path);
      checkpoint = next;
      binding = nextBinding;
      covered = end;
    }
    return {
      ...(checkpoint ? { handoff: checkpoint.summary, checkpoint: binding } : {}),
      recent: items.slice(covered),
      compactedItems: covered,
    };
  }
}
function prefixHash(items: readonly ConversationHistoryItem[], count: number): string {
  return contentHash(stableJson(items.slice(0, count)));
}
function assertCheckpoint(value: unknown): asserts value is Checkpoint {
  const item = value as Checkpoint;
  if (
    !item ||
    item.kind !== "CreatorConversationCompaction" ||
    typeof item.conversationId !== "string" ||
    !Number.isSafeInteger(item.coveredCount) ||
    item.coveredCount < 1 ||
    !/^[a-f0-9]{64}$/.test(item.prefixHash) ||
    typeof item.summary !== "string" ||
    item.summary.trim().length === 0 ||
    Buffer.byteLength(item.summary, "utf8") > 32 * 1024 ||
    typeof item.model !== "string" ||
    typeof item.journalId !== "string"
  )
    throw new Error("Invalid conversation compaction checkpoint");
  assertArtifactReference(item.execution);
  if (item.previous) assertArtifactReference(item.previous);
}
