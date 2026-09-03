import {
  assertCreatorActionRequestBinding,
  assertCreatorTurnRequestBinding,
  type CreatorActionRequest,
  type CreatorDashboardState,
  type CreatorTurnRequest,
} from "../../creator-conversation/src/index.js";

const TURN_KINDS = ["new_work", "clarification", "plan_refinement", "follow_up"] as const;
const MEMORY_CATEGORIES = ["preference", "convention", "vocabulary", "goal", "unresolved"] as const;

type CreatorMemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface CreatorTurnCommandOptions {
  readonly valid: boolean;
  readonly conversationId?: string;
  readonly prompt?: string;
  readonly promptPath?: string;
  readonly model?: string;
  readonly turnKind?: CreatorTurnRequest["turnKind"];
}

export interface CreatorActionCommandOptions {
  readonly valid: boolean;
  readonly text?: string;
  readonly textPath?: string;
  readonly report?: string;
  readonly reportPath?: string;
  readonly memoryItemId?: string;
  readonly memoryRevisionId?: string;
  readonly memoryRevisionHash?: string;
  readonly memoryCategory?: CreatorMemoryCategory;
  readonly model?: string;
}

export type CreatorActionCommandInput =
  | { readonly field: "text"; readonly value: string }
  | { readonly field: "report"; readonly value: string };

export function parseCreatorTurnCommandOptions(
  values: readonly string[],
): CreatorTurnCommandOptions {
  const args = [...values];
  const conversationId = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
  let prompt: string | undefined;
  let promptPath: string | undefined;
  let model: string | undefined;
  let turnKind: CreatorTurnRequest["turnKind"] | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const next = args[index + 1];
    if (option === undefined || next === undefined) return { valid: false };
    if (option === "--prompt" && prompt === undefined) prompt = next;
    else if (option === "--prompt-file" && promptPath === undefined && next) promptPath = next;
    else if (option === "--model" && model === undefined && next) model = next;
    else if (
      option === "--kind" &&
      turnKind === undefined &&
      (TURN_KINDS as readonly string[]).includes(next)
    )
      turnKind = next as CreatorTurnRequest["turnKind"];
    else return { valid: false };
  }
  if ((prompt === undefined) === (promptPath === undefined)) return { valid: false };
  return {
    valid: true,
    ...(conversationId ? { conversationId } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(promptPath ? { promptPath } : {}),
    ...(model ? { model } : {}),
    ...(turnKind ? { turnKind } : {}),
  };
}

export function parseCreatorActionCommandOptions(
  values: readonly string[],
): CreatorActionCommandOptions {
  let text: string | undefined;
  let textPath: string | undefined;
  let report: string | undefined;
  let reportPath: string | undefined;
  let memoryItemId: string | undefined;
  let memoryRevisionId: string | undefined;
  let memoryRevisionHash: string | undefined;
  let memoryCategory: CreatorMemoryCategory | undefined;
  let model: string | undefined;

  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const next = values[index + 1];
    if (option === undefined || next === undefined) return { valid: false };
    if (option === "--text" && text === undefined) text = next;
    else if (option === "--text-file" && textPath === undefined && next) textPath = next;
    else if (option === "--report" && report === undefined) report = next;
    else if (option === "--report-file" && reportPath === undefined && next) reportPath = next;
    else if (option === "--memory-item-id" && memoryItemId === undefined && next)
      memoryItemId = next;
    else if (option === "--memory-revision-id" && memoryRevisionId === undefined && next)
      memoryRevisionId = next;
    else if (option === "--memory-revision-hash" && memoryRevisionHash === undefined && next)
      memoryRevisionHash = next;
    else if (
      option === "--memory-category" &&
      memoryCategory === undefined &&
      (MEMORY_CATEGORIES as readonly string[]).includes(next)
    )
      memoryCategory = next as CreatorMemoryCategory;
    else if (option === "--model" && model === undefined && next) model = next;
    else return { valid: false };
  }

  const inputCount = [text, textPath, report, reportPath].filter(
    (value) => value !== undefined,
  ).length;
  if (inputCount > 1) return { valid: false };
  const memoryTargetCount = [memoryItemId, memoryRevisionId, memoryRevisionHash].filter(
    (value) => value !== undefined,
  ).length;
  if (memoryTargetCount !== 0 && memoryTargetCount !== 3) return { valid: false };
  return {
    valid: true,
    ...(text !== undefined ? { text } : {}),
    ...(textPath ? { textPath } : {}),
    ...(report !== undefined ? { report } : {}),
    ...(reportPath ? { reportPath } : {}),
    ...(memoryItemId ? { memoryItemId } : {}),
    ...(memoryRevisionId ? { memoryRevisionId } : {}),
    ...(memoryRevisionHash ? { memoryRevisionHash } : {}),
    ...(memoryCategory ? { memoryCategory } : {}),
    ...(model ? { model } : {}),
  };
}

export function creatorActionCommandInput(
  options: CreatorActionCommandOptions,
  fileText?: string,
): CreatorActionCommandInput | undefined {
  if (options.text !== undefined) return { field: "text", value: options.text };
  if (options.report !== undefined) return { field: "report", value: options.report };
  if (options.textPath !== undefined) {
    if (fileText === undefined) throw new Error("Creator action text file was not read");
    return { field: "text", value: fileText };
  }
  if (options.reportPath !== undefined) {
    if (fileText === undefined) throw new Error("Creator action report file was not read");
    return { field: "report", value: fileText };
  }
  return undefined;
}

export function createCreatorTurnCommandRequest(input: {
  readonly state: CreatorDashboardState;
  readonly conversationId?: string;
  readonly turnKind?: CreatorTurnRequest["turnKind"];
  readonly text: string;
  readonly selectedModelId?: string;
  readonly idempotencyKey: string;
}): CreatorTurnRequest {
  const view = input.state.controlView;
  const contract = view?.turnContract;
  if (!view || !contract) throw new Error("The current conversation view accepts no turn");
  if (input.conversationId !== undefined && input.conversationId !== view.conversationId)
    throw new Error("Requested conversation is not the current control view");
  if (!input.text.trim()) throw new Error("Creator turn text must contain non-whitespace text");
  const turnKind = input.turnKind ?? contract.allowedTurnTypes[0];
  if (!turnKind || !contract.allowedTurnTypes.includes(turnKind))
    throw new Error("Requested turn kind is unavailable in the current conversation view");
  const request: CreatorTurnRequest = {
    kind: "CreatorTurnRequest",
    conversationId: view.conversationId,
    turnContractId: contract.id,
    turnContractHash: contract.hash,
    turnKind,
    // The creator's original bytes are the durable evidence. The whitespace
    // check above is intentionally non-mutating.
    text: input.text,
    selectedModelId: input.selectedModelId ?? input.state.modelRegistry.defaultModelId,
    idempotencyKey: input.idempotencyKey,
  };
  assertCreatorTurnRequestBinding(contract, input.state.modelRegistry, request);
  return request;
}

export function createCreatorActionCommandRequest(input: {
  readonly state: CreatorDashboardState;
  readonly conversationId: string;
  readonly actionInstanceId: string;
  readonly commandInput?: CreatorActionCommandInput;
  readonly memoryTarget?: {
    readonly itemId: string;
    readonly revisionId: string;
    readonly revisionHash: string;
  };
  readonly memoryCategory?: CreatorMemoryCategory;
  readonly selectedModelId?: string;
  readonly idempotencyKey: string;
}): CreatorActionRequest {
  const view = input.state.controlView;
  if (!view || view.conversationId !== input.conversationId)
    throw new Error("Conversation has no current control view");
  const descriptor = view.actions.find(
    (candidate) => candidate.actionInstanceId === input.actionInstanceId,
  );
  if (!descriptor) throw new Error("Action instance is stale or unavailable");

  const target = memoryTargetForAction(input.state, descriptor.target, input.memoryTarget);
  const commandInput = input.commandInput;
  if (descriptor.input.kind === "none") {
    if (commandInput !== undefined) throw new Error("This creator action accepts no input");
    if (input.memoryCategory !== undefined)
      throw new Error("This creator action accepts no memory category");
    if (input.selectedModelId !== undefined)
      throw new Error("This creator action accepts no model selection");
    const request: CreatorActionRequest = {
      kind: "CreatorActionRequest",
      conversationId: input.conversationId,
      viewId: view.id,
      viewHash: view.hash,
      actionInstanceId: input.actionInstanceId,
      idempotencyKey: input.idempotencyKey,
      ...(target ? { target } : {}),
    };
    assertCreatorActionRequestBinding(view, request);
    return request;
  }

  if (!commandInput) throw new Error(`${descriptor.input.label} is required`);
  const expectedField = descriptor.input.field === "report" ? "report" : "text";
  if (commandInput.field !== expectedField)
    throw new Error(
      expectedField === "report"
        ? `${descriptor.input.label} must be supplied with --report or --report-file`
        : `${descriptor.input.label} must be supplied with --text or --text-file`,
    );
  if (!commandInput.value.trim())
    throw new Error(`${descriptor.input.label} must contain non-whitespace text`);
  const bytes = Buffer.byteLength(commandInput.value, "utf8");
  if (bytes < descriptor.input.minimumBytes || bytes > descriptor.input.maximumBytes)
    throw new Error(
      `${descriptor.input.label} must be between ${descriptor.input.minimumBytes} and ${descriptor.input.maximumBytes} bytes`,
    );
  if (input.memoryCategory !== undefined && descriptor.input.field !== "memory")
    throw new Error("Only project-memory actions accept a memory category");
  if (descriptor.actionId === "remember" && input.memoryCategory === undefined)
    throw new Error("New project memory requires an explicit category");
  if (descriptor.actionId !== "revise_plan" && input.selectedModelId !== undefined)
    throw new Error("Only plan refinement accepts a model selection");
  const selectedModelId =
    descriptor.actionId === "revise_plan"
      ? (input.selectedModelId ?? input.state.modelRegistry.defaultModelId)
      : undefined;

  const request: CreatorActionRequest = {
    kind: "CreatorActionRequest",
    conversationId: input.conversationId,
    viewId: view.id,
    viewHash: view.hash,
    actionInstanceId: input.actionInstanceId,
    idempotencyKey: input.idempotencyKey,
    ...(target ? { target } : {}),
    input:
      commandInput.field === "report"
        ? { report: commandInput.value }
        : {
            text: commandInput.value,
            ...(input.memoryCategory ? { memoryCategory: input.memoryCategory } : {}),
            ...(selectedModelId
              ? {
                  selectedModelId,
                  modelRegistryHash: input.state.modelRegistry.hash,
                }
              : {}),
          },
  };
  assertCreatorActionRequestBinding(view, request);
  return request;
}

function memoryTargetForAction(
  state: CreatorDashboardState,
  requirement: "none" | "memory_head",
  value:
    | {
        readonly itemId: string;
        readonly revisionId: string;
        readonly revisionHash: string;
      }
    | undefined,
): CreatorActionRequest["target"] | undefined {
  if (requirement === "none") {
    if (value !== undefined) throw new Error("This creator action accepts no memory target");
    return undefined;
  }
  if (value === undefined)
    throw new Error("This memory action requires an exact current memory target");
  const current = state.memories.find(
    (memory) =>
      memory.itemId === value.itemId &&
      memory.revisionId === value.revisionId &&
      memory.revisionHash === value.revisionHash,
  );
  if (!current) throw new Error("Memory target is not an exact current memory head");
  return { kind: "memory_head", ...value };
}
