import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  episodeStatusForSession,
  transactionMilestoneEvents,
} from "../packages/creator-control/src/conversation-coordinator.js";
import { isEpisodeStatusTransition } from "../packages/creator-conversation/src/store.js";
import {
  CREATOR_SESSION_TRANSITIONS,
  type CreatorSessionStatus,
} from "../packages/creator-session/src/index.js";
import type {
  CreatorConversationEvent,
  CreatorWorkEpisode,
} from "../packages/creator-conversation/src/index.js";
import { creatorTerminalOutputKey } from "../packages/creator-conversation/src/contracts.js";
import type { CreatorSessionBundle } from "../packages/creator-session/src/index.js";
import type { ArtifactReference } from "../packages/artifact-store/src/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("rewriting a failure's display copy cannot republish the same immutable outcome", () => {
  const original = {
    episodeId: "episode_failed",
    binding: { sessionId: "session_failed", sessionHash: HASH_A },
    projectRevisionHash: HASH_B,
    data: {
      outcome: "incomplete" as const,
      message: "Could not finish.",
      studioHasAcceptedResult: false,
    },
  };
  const reworded = {
    ...original,
    data: { ...original.data, message: "The interrupted change is closed." },
  };
  assert.equal(creatorTerminalOutputKey(original), creatorTerminalOutputKey(reworded));
  assert.notEqual(
    creatorTerminalOutputKey(original),
    creatorTerminalOutputKey({
      ...reworded,
      binding: { ...original.binding, sessionHash: HASH_B },
    }),
  );
});

test("completed builds publish one model-authored Markdown result without inventing Play verification", async () => {
  const bundle = {
    session: {
      id: "creator_session_completed",
      hash: HASH_A,
      status: "completed",
      currentRevisionHash: HASH_B,
    },
    changeSets: [
      {
        id: "change_set_completed",
        hash: HASH_B,
        operations: [],
        summary: "Built **controls**.\\n\\nTry them in Studio.",
      },
    ],
    mutationAttempts: [],
    verifications: [],
  } as unknown as CreatorSessionBundle;
  const events = await transactionMilestoneEvents({
    bundle,
    episode,
    existingEvents: [],
    writeArtifact,
    readArtifact: async () => undefined,
  });
  const result = events.find((event) => event.eventType === "terminal_output");
  assert.equal(result?.authority, "agent");
  assert.equal(result?.data.outcome, "completed");
  assert.equal(result?.data.message, bundle.changeSets[0]!.summary);
  assert.equal(result?.data.studioHasAcceptedResult, false);
  assert.equal(
    events.some((event) => ["verification", "playtest", "final_review"].includes(event.eventType)),
    false,
  );
  const persisted = events.map((event, index) => conversationEvent(event, index + 1));
  const afterCleanup = {
    ...bundle,
    session: { ...bundle.session, hash: "c".repeat(64) },
  };
  assert.deepEqual(
    await transactionMilestoneEvents({
      bundle: afterCleanup,
      episode,
      existingEvents: persisted,
      writeArtifact,
      readArtifact: async () => undefined,
    }),
    [],
    "Finalization acknowledgements must not publish the same reply again",
  );
  const next = await transactionMilestoneEvents({
    bundle: afterCleanup,
    episode: { ...episode, id: "creator_episode_next" },
    existingEvents: persisted,
    writeArtifact,
    readArtifact: async () => undefined,
  });
  assert.equal(
    next.filter((event) => event.eventType === "terminal_output").length,
    1,
    "The same text in a different turn remains a separate reply",
  );
});

test("every authoritative transaction edge remains readable in its conversation", () => {
  for (const [from, destinations] of Object.entries(CREATOR_SESSION_TRANSITIONS)) {
    for (const to of destinations) {
      assert.ok(
        isEpisodeStatusTransition(
          episodeStatusForSession(from as CreatorSessionStatus),
          episodeStatusForSession(to),
        ),
        `${from} -> ${to}`,
      );
    }
  }
  assert.equal(episodeStatusForSession("refreshing"), "refreshing");
  assert.equal(isEpisodeStatusTransition("accepted", "building"), false);
  assert.equal(isEpisodeStatusTransition("observing_play", "applying"), false);
});

test("preparation failure remains the displayed cause after restoring a transaction", async () => {
  const failure = {
    stage: "preparation" as const,
    code: "BUILD_PREPARATION_FAILED",
    detail: "The approved change could not be prepared.",
  };
  const bundle = {
    session: {
      id: "creator_session_preparation",
      hash: HASH_A,
      status: "incomplete",
      currentRevisionHash: HASH_B,
    },
    preparationFailure: {
      failure,
      execution: { agentRunId: "agent_run_never_dispatched" },
      diagnostic: artifactReference(HASH_B),
    },
    agentRuns: [{ outcome: { status: "sealed" }, phase: "creator_planner" }],
    changeSets: [],
    mutationAttempts: [],
    verifications: [],
  } as unknown as CreatorSessionBundle;
  const options = {
    bundle,
    episode,
    existingEvents: [],
    writeArtifact,
    readArtifact: async () => {
      throw new Error("A preparation failure has no AgentRun");
    },
  };
  const events = await transactionMilestoneEvents(options);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.eventType, "terminal_output");
  if (events[0]!.eventType !== "terminal_output") return;
  assert.equal(events[0]!.data.message, `Build could not start: ${failure.detail}`);
  assert.equal(events[0]!.attachments[0]!.binding.artifact.artifactHash, HASH_B);
  assert.deepEqual(
    await transactionMilestoneEvents({ ...options, bundle: structuredClone(bundle) }),
    events,
  );
});

const episode: CreatorWorkEpisode = {
  kind: "CreatorWorkEpisode",
  id: "creator_episode_transaction_events",
  hash: HASH_A,
  conversationId: "creator_conversation_transaction_events",
  ordinal: 1,
  status: "awaiting_review",
  selectedModelId: "openai/gpt-5.6-luna",
  initialProjectRevisionHash: HASH_A,
  currentProjectRevisionHash: HASH_B,
  sessionBundle: artifactBinding("creator_session_transaction_events", HASH_A),
  creatorTurnId: "creator_turn_transaction_events",
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:01:00.000Z",
};

test("coalesced transaction snapshots retain every immutable evidence milestone in order", async () => {
  const changeSet = {
    kind: "CreatorChangeSet",
    id: "creator_change_set_transaction_events",
    hash: HASH_A,
    operations: [{ kind: "create" }, { kind: "update" }, { kind: "edit_source" }],
  };
  const mutation = {
    kind: "CreatorMutationAttempt",
    id: "creator_mutation_attempt_transaction_events",
    hash: HASH_B,
    completion: "incomplete" as const,
    phase: "preflight" as const,
  };
  const verification = {
    kind: "CreatorVerificationRecord",
    id: "creator_verification_transaction_events",
    hash: "c".repeat(64),
    status: "failed" as const,
    failureFacts: [{ statement: "Door movement was not observed.", hash: "d".repeat(64) }],
  };
  const report = {
    kind: "CreatorReviewReport",
    id: "creator_review_report_transaction_events",
    hash: "e".repeat(64),
    decision: "accepted" as const,
  };
  const bundle = {
    session: {
      id: "creator_session_transaction_events",
      hash: "f".repeat(64),
      status: "creator_accepted",
      currentRevisionHash: HASH_B,
    },
    changeSets: [changeSet],
    mutationAttempts: [mutation],
    verifications: [verification],
    review: { report, artifact: artifactReference(report.hash) },
  } as unknown as CreatorSessionBundle;

  const events = await transactionMilestoneEvents({
    bundle,
    episode,
    existingEvents: [],
    writeArtifact,
    readArtifact: async () => {
      throw new Error("Incomplete mutation evidence must not be read as settled evidence");
    },
  });

  assert.deepEqual(
    events.map((event) => event.eventType),
    ["change_set", "mutation", "verification", "final_review", "terminal_output"],
  );
  assert.equal(events[1]?.eventType, "mutation");
  if (events[1]?.eventType !== "mutation") throw new Error("Expected mutation card");
  assert.equal(events[1].data.status, "incomplete");
  assert.equal(events[1].attachments[0]?.role, "mutation");
  assert.equal(events[2]?.eventType, "verification");
  if (events[2]?.eventType !== "verification") throw new Error("Expected verification card");
  assert.equal(events[2].data.status, "failed");
  assert.deepEqual(events[2].data.failureFacts, verification.failureFacts);
  assert.equal(events[3]?.eventType, "final_review");
  if (events[3]?.eventType !== "final_review") throw new Error("Expected review card");
  assert.equal(events[3].data.state, "accepted");
  assert.equal(events[4]?.eventType, "terminal_output");

  const duplicateEvents = events.map((event, index) => conversationEvent(event, index + 1));
  const repeated = await transactionMilestoneEvents({
    bundle,
    episode,
    existingEvents: duplicateEvents,
    writeArtifact,
    readArtifact: async () => undefined,
  });
  assert.deepEqual(repeated, []);
});

test("a completed mutation card and a Play-state card coexist without polling chatter", async () => {
  const mutation = {
    kind: "CreatorMutationAttempt",
    id: "creator_mutation_attempt_waiting_events",
    hash: HASH_B,
    completion: "incomplete" as const,
    phase: "apply" as const,
  };
  const bundle = {
    session: {
      id: "creator_session_transaction_events",
      hash: "1".repeat(64),
      status: "awaiting_verification_retry",
      currentRevisionHash: HASH_B,
    },
    changeSets: [],
    mutationAttempts: [mutation],
    verifications: [],
    plan: {
      charter: {
        clauses: [
          { kind: "machine", statement: "Observe the bound door position." },
          { kind: "creator_review", statement: "Review presentation quality." },
        ],
      },
    },
  } as unknown as CreatorSessionBundle;
  const first = await transactionMilestoneEvents({
    bundle,
    episode,
    existingEvents: [],
    writeArtifact,
    readArtifact: async () => undefined,
  });
  assert.deepEqual(
    first.map((event) => event.eventType),
    ["mutation", "playtest"],
  );
  const stable = await transactionMilestoneEvents({
    bundle,
    episode,
    existingEvents: first.map((event, index) => conversationEvent(event, index + 1)),
    writeArtifact,
    readArtifact: async () => undefined,
  });
  assert.deepEqual(stable, []);
  const history = first.map((event, index) => conversationEvent(event, index + 1));
  history.push({
    ...history.at(-1)!,
    id: "creator_event_intervening_host_progress",
    sequence: history.length + 1,
    eventType: "source_sync",
    data: { status: "awaiting", message: "Host progress between Play snapshots" },
  });
  assert.deepEqual(
    await transactionMilestoneEvents({
      bundle,
      episode,
      existingEvents: history,
      writeArtifact,
      readArtifact: async () => undefined,
    }),
    [],
  );
});

async function writeArtifact(value: unknown): Promise<ArtifactReference> {
  const text = `${stableJson(value)}\n`;
  const artifactHash = contentHash(text);
  return {
    artifactHash,
    locator: `artifacts/${artifactHash}.json`,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

test("activity between project notifications does not republish the same refresh warning", async () => {
  const bundle = {
    session: {
      id: episode.sessionBundle.id,
      hash: HASH_A,
      status: "refresh_required",
      currentRevisionHash: HASH_B,
    },
    changeSets: [],
    mutationAttempts: [],
    verifications: [],
  } as unknown as CreatorSessionBundle;
  const first = await transactionMilestoneEvents({
    bundle,
    episode,
    existingEvents: [],
    writeArtifact,
    readArtifact: async () => undefined,
  });
  assert.equal(first.filter((event) => event.eventType === "project_change").length, 1);
  const events = first.map((event, index) => conversationEvent(event, index + 1));
  events.push(
    conversationEvent(
      {
        authority: "forge",
        episodeId: episode.id,
        eventType: "activity",
        data: {
          phase: "building",
          status: "running",
          message: "Working",
          job: artifactBinding("job-1", HASH_A),
        },
        attachments: [],
      },
      events.length + 1,
    ),
  );
  const repeated = await transactionMilestoneEvents({
    bundle,
    episode,
    existingEvents: events,
    writeArtifact,
    readArtifact: async () => undefined,
  });
  assert.equal(repeated.filter((event) => event.eventType === "project_change").length, 0);
});

function artifactBinding(id: string, hash: string) {
  return { id, hash, artifact: artifactReference(hash) };
}

function artifactReference(hash: string): ArtifactReference {
  return { artifactHash: hash, locator: `artifacts/${hash}.json`, bytes: 2 };
}

function conversationEvent(
  event: Omit<
    CreatorConversationEvent,
    "kind" | "id" | "hash" | "conversationId" | "sequence" | "occurredAt"
  >,
  sequence: number,
): CreatorConversationEvent {
  return {
    ...event,
    kind: "CreatorConversationEvent",
    id: `creator_event_transaction_${sequence}`,
    hash: contentHash(stableJson({ sequence, eventType: event.eventType, data: event.data })),
    conversationId: episode.conversationId,
    sequence,
    occurredAt: `2026-09-03T00:0${sequence}:00.000Z`,
  } as CreatorConversationEvent;
}
