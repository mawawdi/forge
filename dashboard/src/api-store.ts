import { useSyncExternalStore } from "react";
import {
  assertCreatorDashboardState,
  assertCreatorWorkAdmission,
  assertCreatorTurnRequest,
  assertCreatorActionRequest,
} from "../../packages/creator-conversation/src/contracts.js";
import type {
  ActionDraft,
  ConversationDraft,
  CreatorActionRequest,
  CreatorDashboardState,
  CreatorConversationEvent,
  CreatorConversationEventPage,
  CreatorTurnRequest,
  CreatorWorkAdmission,
  DashboardSnapshot,
} from "./types";
import { browserStorage } from "./browser-preferences";

const DRAFT_STORAGE_KEY = "forge.conversation-drafts.v1";

const EMPTY_DRAFT: ConversationDraft = { text: "" };
const EMPTY_ACTION_DRAFT: ActionDraft = { text: "" };
const INITIAL_SNAPSHOT: DashboardSnapshot = {
  phase: "loading",
  drafts: {},
};
const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };
const AMBIGUOUS_REQUEST_MESSAGE =
  "Delivery wasn't confirmed. Your request is saved; retrying it won't send it twice.";

let idempotencySequence = 0;

type AdmissionKind = "turn" | "action";
type AdmissionEndpoint = "/api/control/turn" | "/api/control/action";

interface RetainedAdmission<T extends CreatorTurnRequest | CreatorActionRequest> {
  readonly kind: AdmissionKind;
  readonly endpoint: AdmissionEndpoint;
  /** Stable identity of the request without its generated idempotency key. */
  readonly identity: string;
  /** The immutable request object sent on every retry. */
  readonly request: T;
  /** The exact JSON bytes sent on every retry. */
  readonly body: string;
}

/** The host checked its serialized ledger and proved this exact turn was not admitted. */
export class AdmissionRejectionError extends Error {
  constructor(
    message: string,
    readonly idempotencyKey: string,
  ) {
    super(message);
    this.name = "AdmissionRejectionError";
  }
}

export function isAdmissionRejection(error: unknown): error is AdmissionRejectionError {
  return error instanceof AdmissionRejectionError;
}

/**
 * The only browser state owner. One EventSource invalidates this one snapshot;
 * cards and sheets subscribe rather than opening their own streams.
 */
export class CreatorDashboardStore {
  private snapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private selectedConversationId: string | undefined;
  private eventSource: EventSource | undefined;
  private cursor = 0;
  private invalidations = 0;
  private refreshing = false;
  private refreshAgain = false;
  private started = false;
  private readonly loadedEvents = new Map<string, readonly CreatorConversationEvent[]>();
  private readonly historyCursors = new Map<string, string | undefined>();
  private readonly historyLoading = new Set<string>();
  /**
   * Requests whose admission has not been confirmed. The dashboard read model
   * intentionally does not expose idempotency keys or request hashes, so a
   * state refresh cannot prove that one of these exact requests was admitted.
   */
  private readonly retainedAdmissions = new Map<
    string,
    RetainedAdmission<CreatorTurnRequest | CreatorActionRequest>
  >();
  /** Local proof only: a reload requires another exact retry before releasing a request. */
  private readonly rejectedTurns = new Set<string>();

  constructor(private readonly storage?: Storage) {
    if (!storage) return;
    try {
      const saved: unknown = JSON.parse(storage.getItem(DRAFT_STORAGE_KEY) ?? "null");
      if (saved === null) return;
      if (
        !isRecord(saved) ||
        !isRecord(saved.drafts) ||
        !isRecord(saved.actionDrafts) ||
        !Array.isArray(saved.requests)
      )
        throw new Error("Invalid saved drafts");
      const drafts = Object.fromEntries(
        Object.entries(saved.drafts).map(([id, value]) => {
          if (
            !isRecord(value) ||
            typeof value.text !== "string" ||
            (value.modelId !== undefined && typeof value.modelId !== "string")
          )
            throw new Error("Invalid saved draft");
          return [
            id,
            {
              text: value.text,
              ...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
            },
          ];
        }),
      );
      const actionDrafts = Object.fromEntries(
        Object.entries(saved.actionDrafts).map(([id, value]) => {
          if (
            !isRecord(value) ||
            typeof value.text !== "string" ||
            (value.memoryCategory !== undefined &&
              !["preference", "convention", "vocabulary", "goal", "unresolved"].includes(
                String(value.memoryCategory),
              ))
          )
            throw new Error("Invalid saved action draft");
          return [id, value as unknown as ActionDraft];
        }),
      );
      const admissions = saved.requests.map(
        (body: unknown): RetainedAdmission<CreatorTurnRequest | CreatorActionRequest> => {
          if (typeof body !== "string") throw new Error("Invalid saved request");
          const request: unknown = JSON.parse(body);
          if (!isRecord(request)) throw new Error("Invalid saved request");
          if (request.kind === "CreatorTurnRequest") assertCreatorTurnRequest(request);
          else assertCreatorActionRequest(request);
          const { kind: _kind, idempotencyKey: _key, ...input } = request;
          const kind = request.kind === "CreatorTurnRequest" ? "turn" : "action";
          return {
            kind,
            endpoint: kind === "turn" ? "/api/control/turn" : "/api/control/action",
            identity: admissionIdentity(kind, input),
            request,
            body,
          };
        },
      );
      for (const admission of admissions)
        this.retainedAdmissions.set(admission.identity, admission);
      this.snapshot = {
        ...INITIAL_SNAPSHOT,
        drafts,
        actionDrafts,
        unconfirmedTurns: admissions.flatMap((entry) =>
          entry.request.kind === "CreatorTurnRequest" ? [entry.request] : [],
        ),
      };
    } catch {
      this.snapshot = {
        ...INITIAL_SNAPSHOT,
        draftStorageError: "Saved drafts couldn't be restored in this tab.",
      };
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DashboardSnapshot => this.snapshot;

  start = (): void => {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    void this.refresh();
    this.connectEvents();
  };

  selectConversation = (conversationId: string): void => {
    if (this.selectedConversationId === conversationId) return;
    this.selectedConversationId = conversationId;
    void this.refresh();
  };

  draftFor = (conversationId: string | undefined): ConversationDraft =>
    this.snapshot.drafts[draftKey(conversationId)] ?? EMPTY_DRAFT;

  unconfirmedTurnFor = (
    conversationId: string | undefined,
    text: string,
    modelId: string,
    visualObservations?: CreatorTurnRequest["visualObservations"],
  ): CreatorTurnRequest | undefined =>
    this.snapshot.unconfirmedTurns?.find(
      (request) =>
        request.conversationId === conversationId &&
        request.text === text &&
        request.selectedModelId === modelId &&
        sameVisualObservations(request.visualObservations, visualObservations),
    );

  actionDraftFor = (actionKey: string): ActionDraft =>
    this.snapshot.actionDrafts?.[actionKey] ?? EMPTY_ACTION_DRAFT;

  hasActionDraft = (actionKey: string): boolean =>
    this.snapshot.actionDrafts?.[actionKey] !== undefined;

  updateDraft = (conversationId: string | undefined, draft: ConversationDraft): void => {
    const key = draftKey(conversationId);
    this.setSnapshot({
      ...this.snapshot,
      drafts: { ...this.snapshot.drafts, [key]: draft },
    });
  };

  updateActionDraft = (actionKey: string, draft: ActionDraft): void => {
    this.setSnapshot({
      ...this.snapshot,
      actionDrafts: { ...this.snapshot.actionDrafts, [actionKey]: draft },
    });
  };

  clearActionDraft = (actionKey: string): void => {
    if (!this.snapshot.actionDrafts?.[actionKey]) return;
    const { [actionKey]: _cleared, ...actionDrafts } = this.snapshot.actionDrafts;
    this.setSnapshot({ ...this.snapshot, actionDrafts });
  };

  loadPreviousEvents = (): void => {
    const page = this.snapshot.data?.eventPage;
    if (!page?.nextBeforeCursor || this.historyLoading.has(page.conversationId)) return;
    this.historyLoading.add(page.conversationId);
    this.setSnapshot({ ...this.snapshot, loadingHistoryFor: page.conversationId });
    void this.fetchPreviousEvents(page.conversationId, page.nextBeforeCursor);
  };

  submitTurn = async (
    input: Omit<CreatorTurnRequest, "kind" | "idempotencyKey">,
  ): Promise<void> => {
    const unconfirmed = this.unconfirmedTurnFor(
      input.conversationId,
      input.text,
      input.selectedModelId,
      input.visualObservations,
    );
    if (unconfirmed) return this.retryTurn(unconfirmed.idempotencyKey);
    const admission = this.retainAdmission(
      "turn",
      "/api/control/turn",
      admissionIdentity("turn", input),
      (): CreatorTurnRequest => ({
        kind: "CreatorTurnRequest",
        ...input,
        idempotencyKey: makeIdempotencyKey(),
      }),
    );
    await this.admit(admission);
    this.clearSubmittedTurnDraft(admission.request);
  };

  retryTurn = async (
    idempotencyKey: string,
    options: { readonly preserveDraft?: boolean; readonly retainOnRejection?: boolean } = {},
  ): Promise<void> => {
    const admission = [...this.retainedAdmissions.values()].find(
      (entry) => entry.request.idempotencyKey === idempotencyKey,
    );
    if (!admission || admission.request.kind !== "CreatorTurnRequest")
      throw new Error("The original message is no longer available to retry.");
    await this.admit(admission, options.preserveDraft, options.retainOnRejection);
    if (!options.preserveDraft) this.clearSubmittedTurnDraft(admission.request);
  };

  discardRejectedTurn = (idempotencyKey: string): CreatorTurnRequest => {
    const admission = [...this.retainedAdmissions.values()].find(
      (entry) => entry.request.idempotencyKey === idempotencyKey,
    );
    if (
      !this.rejectedTurns.has(idempotencyKey) ||
      this.snapshot.pendingRequest?.id === idempotencyKey ||
      admission?.request.kind !== "CreatorTurnRequest"
    )
      throw new Error("Confirm that this saved message was not admitted before editing it.");
    this.retainedAdmissions.delete(admission.identity);
    this.rejectedTurns.delete(idempotencyKey);
    this.persistDrafts();
    this.setSnapshot({
      ...withoutError(this.snapshot),
      unconfirmedTurns: (this.snapshot.unconfirmedTurns ?? []).filter(
        (request) => request.idempotencyKey !== idempotencyKey,
      ),
    });
    return admission.request;
  };

  submitAction = async (
    input: Omit<CreatorActionRequest, "kind" | "idempotencyKey">,
  ): Promise<void> => {
    await this.admit(
      this.retainAdmission(
        "action",
        "/api/control/action",
        admissionIdentity("action", input),
        (): CreatorActionRequest => ({
          kind: "CreatorActionRequest",
          ...input,
          idempotencyKey: makeIdempotencyKey(),
        }),
      ),
    );
  };

  renameWorkspace = async (
    scope: "project" | "conversation",
    conversationId: string,
    name: string,
  ): Promise<void> => {
    const response = await fetch("/api/control/rename", {
      method: "POST",
      credentials: "same-origin",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope, conversationId, name }),
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(readError(payload, response.status));
    await this.refresh();
  };

  private retainAdmission<T extends CreatorTurnRequest | CreatorActionRequest>(
    kind: AdmissionKind,
    endpoint: AdmissionEndpoint,
    identity: string,
    createRequest: () => T,
  ): RetainedAdmission<T> {
    const retained = this.retainedAdmissions.get(identity);
    if (retained) {
      if (retained.kind !== kind || retained.endpoint !== endpoint)
        throw new Error("Forge retained a request for another control endpoint.");
      return retained as RetainedAdmission<T>;
    }
    const request = createRequest();
    const admission: RetainedAdmission<T> = {
      kind,
      endpoint,
      identity,
      request,
      body: serializeRequest(request),
    };
    this.retainedAdmissions.set(identity, admission);
    this.persistDrafts();
    return admission;
  }

  private async admit(
    admission: RetainedAdmission<CreatorTurnRequest | CreatorActionRequest>,
    preserveTurnDraft = false,
    retainOnRejection = false,
  ): Promise<void> {
    const selectionAtSubmission = this.selectedConversationId;
    this.rejectedTurns.delete(admission.request.idempotencyKey);
    this.setSnapshot({
      ...withoutError(this.snapshot),
      pendingRequest: { kind: admission.kind, id: admission.request.idempotencyKey },
    });
    let responseReceived = false;
    let rejectionReceived = false;
    try {
      const response = await fetch(admission.endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: JSON_HEADERS,
        body: admission.body,
      });
      responseReceived = true;
      const payload = await readJson(response);
      if (!response.ok) {
        rejectionReceived =
          admission.kind === "action" || (await provesTurnNotAdmitted(payload, admission.request));
        const message = readError(payload, response.status);
        if (rejectionReceived && admission.kind === "turn")
          throw new AdmissionRejectionError(message, admission.request.idempotencyKey);
        throw new Error(message);
      }
      if (response.status !== 202)
        throw new Error(
          `Forge couldn't confirm this request (response ${response.status}). Your draft is saved.`,
        );
      if (!isWorkAdmission(payload))
        throw new Error("Forge returned an incomplete confirmation. Your draft is saved.");
      if (
        this.selectedConversationId === selectionAtSubmission &&
        (admission.request.kind === "CreatorTurnRequest" ||
          payload.conversationId !== admission.request.conversationId)
      )
        this.selectedConversationId = payload.conversationId;
      this.retainedAdmissions.delete(admission.identity);
      if (admission.request.kind === "CreatorTurnRequest" && !preserveTurnDraft)
        this.clearSubmittedTurnDraft(admission.request);
      this.persistDrafts();
      this.setSnapshot({
        ...this.snapshot,
        phase: "ready",
        unconfirmedTurns: (this.snapshot.unconfirmedTurns ?? []).filter(
          (request) => request.idempotencyKey !== admission.request.idempotencyKey,
        ),
      });
      // The 202 proves only admission. The SSE remains the one source for the
      // durable event outcome, while this read catches a fast local transition.
      // Keep action buttons pending until the first authoritative read so a
      // second click cannot reuse the view from before admission.
      await this.refresh();
      this.setSnapshot(withoutPendingRequest(this.snapshot));
    } catch (error) {
      const message = responseReceived ? errorMessage(error) : AMBIGUOUS_REQUEST_MESSAGE;
      const discard = rejectionReceived && !retainOnRejection;
      const unconfirmedTurns = (this.snapshot.unconfirmedTurns ?? []).filter(
        (request) => !discard || request.idempotencyKey !== admission.request.idempotencyKey,
      );
      if (discard) {
        this.retainedAdmissions.delete(admission.identity);
        this.persistDrafts();
      } else if (rejectionReceived) {
        this.rejectedTurns.add(admission.request.idempotencyKey);
      }
      if (
        !discard &&
        admission.request.kind === "CreatorTurnRequest" &&
        !unconfirmedTurns.some(
          (request) => request.idempotencyKey === admission.request.idempotencyKey,
        )
      )
        unconfirmedTurns.push(admission.request);
      // Rejections can mean the view changed during admission. Refresh the
      // available actions without replaying a request against new authority.
      if (rejectionReceived) await this.refresh();
      this.setSnapshot({
        ...withoutPendingRequest(this.snapshot),
        phase: "error",
        error: message,
        unconfirmedTurns,
      });
      if (!responseReceived) void this.refresh();
      throw isAdmissionRejection(error) ? error : new Error(message);
    }
  }

  private clearSubmittedTurnDraft(request: CreatorTurnRequest): void {
    const key = draftKey(request.conversationId);
    const draft = this.snapshot.drafts[key];
    if (!draftMatchesTurnRequest(draft, request)) return;
    this.updateDraft(request.conversationId, { text: "", modelId: request.selectedModelId });
  }

  private connectEvents(): void {
    this.eventSource = new EventSource(`/api/control/events?after=${this.cursor}`);
    this.eventSource.onmessage = (event) => {
      this.cursor = readCursor(event.data, event.lastEventId, this.cursor);
      this.invalidations += 1;
      void this.consumeInvalidations();
    };
    this.eventSource.addEventListener("reset", (event) => {
      const message = event as MessageEvent<string>;
      this.cursor = readCursor(message.data, message.lastEventId, this.cursor);
      this.invalidations = 0;
      void this.refresh();
    });
    // Retain the conversation while native EventSource reconnects, but mark
    // its activity as stale until a fresh snapshot has arrived.
    this.eventSource.onerror = () => {
      this.setSnapshot({
        ...this.snapshot,
        connectionLost: true,
        ...(this.eventSource?.readyState === 2
          ? {
              phase: "error" as const,
              error:
                "The connection was closed. Open the latest dashboard link from your Forge terminal to reconnect.",
            }
          : {}),
      });
    };
    this.eventSource.onopen = () => {
      if (this.snapshot.connectionLost) void this.refresh();
    };
  }

  private async consumeInvalidations(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    while (this.invalidations > 0) {
      this.invalidations -= 1;
      await this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    const previous = this.snapshot.data;
    this.setSnapshot({
      ...withoutError(this.snapshot),
      phase: "loading",
      ...(previous ? { data: previous } : {}),
    });
    try {
      const requestedConversationId = this.selectedConversationId;
      const query = requestedConversationId
        ? `?conversationId=${encodeURIComponent(requestedConversationId)}`
        : "";
      const response = await fetch(`/api/control/state${query}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(readError(payload, response.status));
      if (!isDashboardState(payload))
        throw new Error("Forge couldn't load the latest conversation update.");
      // A project selection may change while this request is in flight. An
      // older response may remain visible until its queued successor lands,
      // but it must not overwrite the newer selection used by that refresh.
      if (this.selectedConversationId === requestedConversationId)
        this.selectedConversationId = payload.selectedConversationId ?? requestedConversationId;
      this.setSnapshot({
        ...withoutError(this.snapshot),
        phase: "ready",
        connectionLost: this.eventSource !== undefined && this.eventSource.readyState !== 1,
        data: this.mergeReadModel(payload, false),
      });
    } catch (error) {
      this.setSnapshot({
        ...this.snapshot,
        phase: "error",
        ...(previous ? { data: previous } : {}),
        error: errorMessage(error),
      });
    } finally {
      this.refreshing = false;
      const refreshAgain = this.refreshAgain;
      this.refreshAgain = false;
      if (this.invalidations > 0) {
        void this.consumeInvalidations();
      } else if (refreshAgain) {
        // An explicit selection/admission refresh can arrive without an SSE
        // invalidation. Run it after the in-flight request instead of dropping
        // the creator's newly selected conversation.
        void this.refresh();
      }
    }
  }

  private async fetchPreviousEvents(conversationId: string, before: string): Promise<void> {
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/events?before=${encodeURIComponent(before)}&limit=100`,
        { credentials: "same-origin", headers: { Accept: "application/json" } },
      );
      const payload = await readJson(response);
      if (!response.ok) throw new Error(readError(payload, response.status));
      const current = this.snapshot.data;
      if (!current || current.selectedConversationId !== conversationId) return;
      if (!isEventPageForDashboard(current, payload))
        throw new Error(
          "Forge couldn't load the earlier messages. Your current conversation is still here.",
        );
      this.setSnapshot({
        ...withoutError(this.snapshot),
        phase: "ready",
        data: this.mergeReadModel({ ...current, eventPage: payload }, true),
      });
    } catch (error) {
      this.setSnapshot({ ...this.snapshot, phase: "error", error: errorMessage(error) });
    } finally {
      this.historyLoading.delete(conversationId);
      if (this.snapshot.loadingHistoryFor === conversationId)
        this.setSnapshot({ ...this.snapshot, loadingHistoryFor: undefined });
    }
  }

  private mergeReadModel(
    state: CreatorDashboardState,
    fromHistoryPage: boolean,
  ): CreatorDashboardState {
    const page = state.eventPage;
    if (!page) return state;
    const existing = this.loadedEvents.get(page.conversationId) ?? [];
    const indexed = new Map(existing.map((event) => [event.id, event]));
    for (const event of page.events) indexed.set(event.id, event);
    const events = [...indexed.values()].sort((left, right) => left.sequence - right.sequence);
    this.loadedEvents.set(page.conversationId, events);
    if (fromHistoryPage || !this.historyCursors.has(page.conversationId))
      this.historyCursors.set(page.conversationId, page.nextBeforeCursor);
    const nextBeforeCursor = this.historyCursors.get(page.conversationId);
    return {
      ...state,
      eventPage: {
        conversationId: page.conversationId,
        events,
        ...(page.beforeCursor ? { beforeCursor: page.beforeCursor } : {}),
        ...(nextBeforeCursor ? { nextBeforeCursor } : {}),
        complete: page.complete && !nextBeforeCursor,
      },
    };
  }

  private setSnapshot(value: DashboardSnapshot): void {
    const draftsChanged =
      value.drafts !== this.snapshot.drafts || value.actionDrafts !== this.snapshot.actionDrafts;
    this.snapshot = value;
    if (draftsChanged) this.persistDrafts();
    for (const listener of this.listeners) listener();
  }

  private persistDrafts(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(
        DRAFT_STORAGE_KEY,
        JSON.stringify({
          drafts: this.snapshot.drafts,
          actionDrafts: this.snapshot.actionDrafts ?? {},
          requests: [...this.retainedAdmissions.values()].map((entry) => entry.body),
        }),
      );
      const { draftStorageError: _storageError, ...savedSnapshot } = this.snapshot;
      this.snapshot = savedSnapshot;
    } catch {
      this.snapshot = {
        ...this.snapshot,
        draftStorageError:
          "This browser couldn't save your message and images. Keep this tab open until delivery is confirmed; copying the text alone won't preserve the images.",
      };
    }
  }
}

export function isDashboardState(value: unknown): value is CreatorDashboardState {
  try {
    assertCreatorDashboardState(value);
    return true;
  } catch {
    return false;
  }
}

function isEventPageForDashboard(
  state: CreatorDashboardState,
  value: unknown,
): value is CreatorConversationEventPage {
  return isDashboardState({ ...state, eventPage: value });
}

function isWorkAdmission(value: unknown): value is CreatorWorkAdmission {
  try {
    assertCreatorWorkAdmission(value);
    return true;
  } catch {
    return false;
  }
}

function draftKey(conversationId: string | undefined): string {
  return conversationId ?? "new-conversation";
}

async function provesTurnNotAdmitted(
  value: unknown,
  request: CreatorTurnRequest | CreatorActionRequest,
): Promise<boolean> {
  if (
    request.kind !== "CreatorTurnRequest" ||
    !isRecord(value) ||
    value.kind !== "CreatorControlError" ||
    value.admission !== "not_admitted" ||
    value.idempotencyKey !== request.idempotencyKey ||
    typeof value.requestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.requestHash) ||
    !globalThis.crypto?.subtle
  )
    return false;
  const bytes = new TextEncoder().encode(`${canonicalJson(request)}\n`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return value.requestHash === hash;
}

/** Compare retained image bytes directly instead of reserializing megabytes on every keystroke. */
function sameVisualObservations(
  first: CreatorTurnRequest["visualObservations"],
  second: CreatorTurnRequest["visualObservations"],
): boolean {
  if ((first?.length ?? 0) !== (second?.length ?? 0)) return false;
  return (first ?? []).every((item, index) => {
    const other = second?.[index];
    return (
      other !== undefined &&
      item.kind === other.kind &&
      item.caption === other.caption &&
      item.image.mimeType === other.image.mimeType &&
      item.image.base64 === other.image.base64 &&
      (item.kind !== "rendered_view" ||
        (other.kind === "rendered_view" &&
          item.viewId === other.viewId &&
          item.state === other.state &&
          item.graphicsSettings === other.graphicsSettings))
    );
  });
}

function draftMatchesTurnRequest(
  draft: ConversationDraft | undefined,
  request: CreatorTurnRequest,
): boolean {
  if (!draft || draft.text !== request.text) return false;
  if (draft.modelId !== undefined && draft.modelId !== request.selectedModelId) return false;
  return true;
}

function admissionIdentity(
  kind: AdmissionKind,
  input:
    | Omit<CreatorTurnRequest, "kind" | "idempotencyKey">
    | Omit<CreatorActionRequest, "kind" | "idempotencyKey">,
): string {
  return `${kind}:${canonicalJson(input)}`;
}

function serializeRequest(request: CreatorTurnRequest | CreatorActionRequest): string {
  const serialized = JSON.stringify(request);
  if (serialized === undefined) throw new Error("Forge could not serialize the control request.");
  return serialized;
}

/**
 * Retry matching ignores caller property order while preserving the original
 * JSON body separately. Undefined object fields follow JSON.stringify and are
 * omitted, so two callers that would send the same request share one key.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Forge control request contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value
      .map((entry) => (entry === undefined ? "null" : canonicalJson(entry)))
      .join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Forge control request contains a non-JSON value.");
}

function withoutError(snapshot: DashboardSnapshot): Omit<DashboardSnapshot, "error"> {
  const { error: _error, ...without } = snapshot;
  return without;
}

function withoutPendingRequest(
  snapshot: DashboardSnapshot,
): Omit<DashboardSnapshot, "pendingRequest"> {
  const { pendingRequest: _pendingRequest, ...without } = snapshot;
  return without;
}

function makeIdempotencyKey(): string {
  idempotencySequence += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `dashboard-${Date.now()}-${idempotencySequence}`;
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function readError(value: unknown, status: number): string {
  if (isRecord(value) && typeof value.message === "string") {
    if (/became stale before durable (?:admission|action admission)/i.test(value.message))
      return "This conversation changed while your request was being sent. Please try again.";
    return value.message;
  }
  if (typeof value === "string" && value.trim()) return value;
  return `Forge couldn't accept this request (${status}).`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Forge couldn't complete the request.";
}

function readCursor(data: string, lastEventId: string, fallback: number): number {
  const candidates = [lastEventId, data];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    try {
      const parsedJson = JSON.parse(candidate) as { cursor?: unknown };
      if (typeof parsedJson.cursor === "number" && Number.isSafeInteger(parsedJson.cursor))
        return parsedJson.cursor;
    } catch {
      // Event data may be an opaque invalidation marker.
    }
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const dashboardStore = new CreatorDashboardStore(browserStorage("sessionStorage"));

export function useDashboardSnapshot(): DashboardSnapshot {
  return useSyncExternalStore(
    dashboardStore.subscribe,
    dashboardStore.getSnapshot,
    dashboardStore.getSnapshot,
  );
}
