import type {
  CreatorActionRequest,
  CreatorControlActionDescriptor,
  CreatorControlView,
  CreatorConversationEvent,
  CreatorDashboardState,
  CreatorTurnRequest,
  CreatorTurnType,
} from "./types";

export type DashboardSurface =
  "loading" | "api-error" | "unpaired" | "empty" | "active" | "attention" | "terminal";

export function getDashboardSurface(
  state: CreatorDashboardState | undefined,
  error: string | undefined,
): DashboardSurface {
  if (error && !state) return "api-error";
  if (!state) return "loading";
  if (state.pairedStudio.status === "unpaired") return "unpaired";
  if (
    state.controlView?.status === "recovery_required" ||
    state.pairedStudio.status === "attention"
  )
    return "attention";
  if (!state.selectedConversationId && state.conversations.length === 0) return "empty";
  if (state.controlView?.status === "terminal") return "terminal";
  return "active";
}

/** Only actions whose exact authorizing event is in this card are renderable. */
export function actionsForEvent(
  controlView: CreatorControlView | undefined,
  event: CreatorConversationEvent,
): readonly CreatorControlActionDescriptor[] {
  if (!controlView) return [];
  return controlView.actions.filter(
    (action) =>
      action.authorizingEventId === event.id && action.authorizingEventHash === event.hash,
  );
}

export function makeTurnRequest(
  state: CreatorDashboardState,
  turnKind: CreatorTurnType,
  text: string,
  selectedModelId: string,
): Omit<CreatorTurnRequest, "kind" | "idempotencyKey"> {
  const contract = state.controlView?.turnContract;
  if (!contract) throw new Error("Forge has not issued a contract for another message yet.");
  if (!contract.allowedTurnTypes.includes(turnKind))
    throw new Error("That message type is not allowed by the current Forge contract.");
  if (!text.trim()) throw new Error("A Forge message must contain non-whitespace text.");
  const bytes = byteLength(text);
  if (bytes < contract.minimumBytes || bytes > contract.maximumBytes)
    throw new Error(
      `Keep this message between ${contract.minimumBytes} and ${contract.maximumBytes} bytes.`,
    );
  return {
    ...(state.selectedConversationId ? { conversationId: state.selectedConversationId } : {}),
    turnContractId: contract.id,
    turnContractHash: contract.hash,
    turnKind,
    // The creator's original bytes are the evidence. Validate a trimmed view
    // for an empty submission, but never rewrite the message before signing it.
    text,
    selectedModelId,
  };
}

export function makeActionRequest(
  state: CreatorDashboardState,
  action: CreatorControlActionDescriptor,
  value: string,
  options: {
    readonly target?: NonNullable<CreatorActionRequest["target"]>;
    readonly memoryCategory?: "preference" | "convention" | "vocabulary" | "goal" | "unresolved";
    readonly selectedModelId?: string;
  } = {},
): Omit<CreatorActionRequest, "kind" | "idempotencyKey"> {
  const view = state.controlView;
  if (!view || view.id !== action.controlViewId)
    throw new Error("This action is no longer in the current control view.");
  if (!view.actions.some((current) => current.actionInstanceId === action.actionInstanceId))
    throw new Error("This action is no longer legal for the current conversation.");
  const input = action.input;
  if (input.kind === "text" && !value.trim())
    throw new Error(`${input.label} must contain non-whitespace text.`);
  const text = value;
  if (input.kind === "text") {
    const bytes = byteLength(text);
    if (bytes < input.minimumBytes || bytes > input.maximumBytes)
      throw new Error(
        `${input.label} must be between ${input.minimumBytes} and ${input.maximumBytes} bytes.`,
      );
  }
  const request = {
    conversationId: view.conversationId,
    viewId: view.id,
    viewHash: view.hash,
    actionInstanceId: action.actionInstanceId,
  } satisfies Omit<CreatorActionRequest, "kind" | "idempotencyKey">;
  let target: NonNullable<CreatorActionRequest["target"]> | undefined;
  if (action.target === "memory_head") {
    if (!options.target || options.target.kind !== "memory_head")
      throw new Error("This memory action needs an exact current memory revision.");
    target = options.target;
  } else if (options.target) {
    throw new Error("This action does not accept a memory target.");
  }
  if (input.kind === "text") {
    const inputValue = input.field === "report" ? { report: text } : { text };
    let actionInput:
      | typeof inputValue
      | (typeof inputValue & {
          readonly memoryCategory: NonNullable<typeof options.memoryCategory>;
        })
      | (typeof inputValue & {
          readonly selectedModelId: string;
          readonly modelRegistryHash: string;
        }) =
      input.field === "memory" && options.memoryCategory
        ? { ...inputValue, memoryCategory: options.memoryCategory }
        : inputValue;
    if (action.actionId === "revise_plan") {
      const selectedModel = state.modelRegistry.models.find(
        (model) => model.id === options.selectedModelId,
      );
      if (!selectedModel || selectedModel.availability !== "available")
        throw new Error("Choose an available model for this plan revision.");
      actionInput = {
        ...inputValue,
        selectedModelId: selectedModel.id,
        modelRegistryHash: state.modelRegistry.hash,
      };
    } else if (options.selectedModelId !== undefined) {
      throw new Error("This action does not accept a model selection.");
    }
    return { ...request, ...(target ? { target } : {}), input: actionInput };
  }
  if (options.selectedModelId !== undefined)
    throw new Error("This action does not accept a model selection.");
  return { ...request, ...(target ? { target } : {}) };
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function shortHash(value: string | undefined): string {
  if (!value) return "not recorded";
  return value.length > 16 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

export function formatTimestamp(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(
    undefined,
    today
      ? { hour: "numeric", minute: "2-digit" }
      : {
          month: "short",
          day: "numeric",
          ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
        },
  ).format(date);
}

export function eventLabel(event: CreatorConversationEvent): string {
  const labels: Record<CreatorConversationEvent["eventType"], string> = {
    creator_turn: "Creator message",
    agent_turn: "Forge",
    activity: "Forge activity",
    plan_revision: "Plan",
    decision: "Creator decision",
    change_set: "Changes ready",
    project_change: "Project changed",
    mutation: "Studio change",
    playtest: "Play test",
    verification: "Forge checks",
    final_review: "Final review",
    recovery: "Recovery",
    source_sync: "Studio sync",
    memory: "Project memory",
    job: "Forge job",
    project_identity: "Project connection",
    terminal_output: "Project outcome",
  };
  return labels[event.eventType];
}
