import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  CreatorConversationCompactor,
  type CompactConversation,
  type ConversationHistoryItem,
} from "../packages/creator-conversation/src/compaction.js";
import { ConversationCompactionToolHost } from "../packages/agent-runtime/src/compaction.js";
import type { AgentRuntimeResult } from "../packages/agent-runtime/src/index.js";

const completed: AgentRuntimeResult = {
  status: "completed",
  trialStarted: true,
  turns: [],
  toolCalls: [],
  usage: {
    turns: 1,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
  },
  timing: {
    startedAt: "2026-09-04T10:00:00.000Z",
    endedAt: "2026-09-04T10:00:01.000Z",
    durationMs: 1000,
  },
};
function history(count: number, size = 8000): ConversationHistoryItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `event_${index}`,
    hash: contentHash(`event_${index}`),
    role: index % 2 ? "agent" : "creator",
    text: `Decision ${index}: ${"x".repeat(size)}`,
  }));
}

test("long conversations compact all older messages, reuse durable handoffs, and retain recent text intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-compaction-"));
  try {
    const received: ConversationHistoryItem[] = [];
    let calls = 0;
    const compact: CompactConversation = async ({ prompt, model }) => {
      assert.equal(model, "meta/muse-spark-1.3-contributor");
      calls += 1;
      const input = JSON.parse(prompt) as {
        previousHandoff: string | null;
        newHistory: ConversationHistoryItem[];
      };
      received.push(...input.newHistory);
      return {
        result: completed,
        summary: `${input.previousHandoff ?? "# Handoff"}\n${input.newHistory.map((item) => item.id).join(", ")}`,
      };
    };
    const items = history(32);
    const model = "meta/muse-spark-1.3-contributor";
    const prepared = await new CreatorConversationCompactor(root, compact).prepare(
      "conversation_one",
      model,
      items,
    );
    assert.ok(prepared.compactedItems > 0);
    assert.deepEqual(received, items.slice(0, prepared.compactedItems));
    assert.deepEqual(prepared.recent, items.slice(prepared.compactedItems));
    const count = calls;
    assert.deepEqual(
      await new CreatorConversationCompactor(root, compact).prepare(
        "conversation_one",
        model,
        items,
      ),
      prepared,
    );
    assert.equal(calls, count);
    await assert.rejects(
      new CreatorConversationCompactor(root, compact).prepare("conversation_one", model, [
        { ...items[0]!, text: "changed history" },
        ...items.slice(1),
      ]),
      /immutable history/,
    );
    const short = history(25, 10);
    const intact = await new CreatorConversationCompactor(root, compact).prepare(
      "conversation_two",
      model,
      short,
    );
    assert.deepEqual(intact.recent, short); // No twenty-message cutoff.
    assert.equal(calls, count);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed compaction never advances the retained prefix or silently truncates history", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-compaction-failure-"));
  try {
    const items = history(20);
    await assert.rejects(
      new CreatorConversationCompactor(root, async () => ({
        result: { ...completed, status: "failed", error: "provider unavailable" },
      })).prepare("conversation_one", "model", items),
      /History is unchanged/,
    );
    const received: ConversationHistoryItem[] = [];
    await new CreatorConversationCompactor(root, async ({ prompt }) => {
      received.push(
        ...(JSON.parse(prompt) as { newHistory: ConversationHistoryItem[] }).newHistory,
      );
      return { result: completed, summary: "The user's decisions and unfinished work." };
    }).prepare("conversation_one", "model", items);
    assert.deepEqual(received[0], items[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction can publish a handoff but cannot execute project tools or malformed batches", async () => {
  const host = new ConversationCompactionToolHost();
  const call = {
    id: "summary_1",
    name: "context.compact",
    arguments: { summary: "# Continue\nKeep the server authoritative." },
  };
  assert.equal(host.validateBatch([call], new Set()).valid, true);
  assert.equal(host.validateBatch([call, { ...call, id: "summary_2" }], new Set()).valid, false);
  assert.equal(host.validateBatch([{ ...call, name: "studio.stage" }], new Set()).valid, false);
  assert.equal(host.validateBatch([call], new Set([call.id])).valid, false);
  assert.equal(host.completionStatus().ready, false);
  await host.execute(call.name, call.arguments);
  assert.equal(host.completionStatus().ready, true);
  assert.equal(host.summary, call.arguments.summary);
});
