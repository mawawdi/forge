import type { CreatorConversationEvent, CreatorDashboardState } from "../types";

export const HASH = "a".repeat(64);
export const HASH_B = "b".repeat(64);

export function event(overrides: Partial<CreatorConversationEvent> = {}): CreatorConversationEvent {
  return {
    kind: "CreatorConversationEvent",
    id: "event_01",
    hash: HASH,
    conversationId: "conversation_01",
    sequence: 1,
    occurredAt: "2026-09-03T00:00:00.000Z",
    authority: "creator",
    attachments: [],
    eventType: "creator_turn",
    data: {
      turn: {
        id: "turn_01",
        hash: HASH,
        artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 24 },
      },
      turnType: "new_work",
      text: "Add a guarded airlock door.",
      selectedModelId: "openai/gpt-5.6-luna",
    },
    ...overrides,
  } as CreatorConversationEvent;
}

export function dashboardState(overrides: Record<string, unknown> = {}): CreatorDashboardState {
  const state = {
    kind: "CreatorDashboardState",
    conversations: [
      {
        id: "conversation_01",
        hash: HASH,
        title: "Add a guarded airlock door",
        projectName: "Orbital Freight Airlock",
        project: { kind: "published", universeId: "123", placeId: "456" },
        status: "awaiting_creator",
        currentProjectRevisionHash: HASH,
        latestEventSequence: 1,
        episodeCount: 1,
        updatedAt: "2026-09-03T00:00:00.000Z",
      },
    ],
    selectedConversationId: "conversation_01",
    eventPage: { conversationId: "conversation_01", events: [event()], complete: true },
    episodes: [],
    memories: [],
    modelRegistry: {
      kind: "CreatorModelRegistry",
      id: "model_registry_01",
      hash: HASH,
      generatedAt: "2026-09-03T00:00:00.000Z",
      defaultModelId: "openai/gpt-5.6-luna",
      models: [
        {
          id: "openai/gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          availability: "available",
          requiredCapabilities: ["tools"],
          providerFallback: "disabled",
        },
      ],
    },
    controlView: {
      kind: "CreatorControlView",
      id: "control_01",
      hash: HASH_B,
      conversationId: "conversation_01",
      conversationHash: HASH,
      eventSequence: 1,
      status: "awaiting_creator",
      title: "Review the plan",
      detail: "The exact plan is ready.",
      turnContract: {
        kind: "CreatorTurnContract",
        id: "turn_contract_01",
        hash: HASH_B,
        conversationId: "conversation_01",
        allowedTurnTypes: ["follow_up"],
        modelRegistryHash: HASH,
        minimumBytes: 1,
        maximumBytes: 4096,
        issuedAt: "2026-09-03T00:00:00.000Z",
      },
      actions: [],
      technicalAttachments: [],
    },
    pairedStudio: {
      status: "ready",
      message: "Studio ready",
      project: { kind: "published", universeId: "123", placeId: "456" },
      projectName: "Orbital Freight Airlock",
      projectRevisionHash: HASH,
      indexStatus: "complete",
      transactionStatus: "clear",
    },
    serverTime: "2026-09-03T00:00:00.000Z",
    ...overrides,
  } as CreatorDashboardState;
  return {
    ...state,
    ...(!Object.hasOwn(overrides, "projectSettings") && state.controlView
      ? { projectSettings: { controlView: state.controlView, memories: state.memories } }
      : {}),
  };
}
