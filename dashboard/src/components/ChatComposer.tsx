import { type FormEvent, useEffect, useRef, useState } from "react";
import { dashboardStore } from "../api-store";
import { byteLength, makeTurnRequest } from "../derived";
import type { ConversationDraft, CreatorDashboardState, DashboardSnapshot } from "../types";

interface ChatComposerProps {
  readonly state: CreatorDashboardState | undefined;
  readonly snapshot: DashboardSnapshot;
}

export function ChatComposer({ state, snapshot }: ChatComposerProps): React.JSX.Element {
  const [message, setMessage] = useState<string | undefined>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const conversationId = state?.selectedConversationId;
  const draft = dashboardStore.draftFor(conversationId);
  const contract = state?.controlView?.turnContract;
  const registry = state?.modelRegistry;
  const selectedModelId = draft.modelId ?? registry?.defaultModelId ?? "";
  const unconfirmed = dashboardStore.unconfirmedTurnFor(
    conversationId,
    draft.text,
    selectedModelId,
  );
  const turnKind = contract?.allowedTurnTypes[0];
  const selectedModel = registry?.models.find((model) => model.id === selectedModelId);
  const hasText = Boolean(draft.text.trim());
  const bytes = byteLength(draft.text);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(220, Math.max(64, input.scrollHeight))}px`;
  }, [draft.text]);
  useEffect(() => {
    setMessage(undefined);
  }, [conversationId]);
  const messageWithinBounds = Boolean(
    contract && bytes >= contract.minimumBytes && bytes <= contract.maximumBytes,
  );
  const canSend = Boolean(
    !snapshot.pendingRequest &&
    (unconfirmed ||
      (contract &&
        turnKind &&
        selectedModel?.availability === "available" &&
        hasText &&
        messageWithinBounds)),
  );

  function changeDraft(change: Partial<ConversationDraft>): void {
    dashboardStore.updateDraft(conversationId, { ...draft, ...change });
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSend) return;
    try {
      setMessage(undefined);
      if (unconfirmed) await dashboardStore.retryTurn(unconfirmed.idempotencyKey);
      else if (state && contract && turnKind)
        await dashboardStore.submitTurn(
          makeTurnRequest(state, turnKind, draft.text, selectedModelId),
        );
      setMessage(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Forge could not accept this message.");
    }
  }

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => void submit(event)}
      aria-label="Message Forge"
    >
      <div className="chat-composer__topline">
        <label htmlFor="forge-message" className="sr-only">
          Message Forge
        </label>
        {contract && bytes > contract.maximumBytes * 0.9 ? (
          <span>
            {bytes}/{contract.maximumBytes} bytes
          </span>
        ) : null}
      </div>
      <textarea
        ref={inputRef}
        id="forge-message"
        value={draft.text}
        onChange={(event) => changeDraft({ text: event.target.value })}
        placeholder={placeholder(state)}
        disabled={Boolean(snapshot.pendingRequest)}
        aria-describedby="composer-status"
        rows={2}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            canSend
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="chat-composer__controls">
        <label>
          <span className="sr-only">Model</span>
          <select
            value={selectedModelId}
            disabled={!registry || Boolean(snapshot.pendingRequest)}
            onChange={(event) => changeDraft({ modelId: event.target.value })}
          >
            {registry?.models.map((model) => (
              <option key={model.id} value={model.id} disabled={model.availability !== "available"}>
                {model.displayName}
                {model.availability !== "available" ? " (unavailable)" : ""}
              </option>
            ))}
          </select>
        </label>
        <span className="composer-keyboard-hint">Enter to send</span>
        <button
          type="submit"
          aria-label={
            snapshot.pendingRequest?.kind === "turn"
              ? "Sending"
              : unconfirmed
                ? "Retry message"
                : "Send"
          }
          title={unconfirmed ? "Retry the original message" : "Send message"}
          className={unconfirmed ? "chat-composer__retry" : undefined}
          disabled={!canSend || bytes === 0}
        >
          {snapshot.pendingRequest?.kind === "turn" ? (
            <span className="sending-spinner" aria-hidden="true" />
          ) : unconfirmed ? (
            "Retry"
          ) : (
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M12 19V5m-6 6 6-6 6 6" />
            </svg>
          )}
        </button>
      </div>
      <p id="composer-status" className="chat-composer__status" role="status" aria-live="polite">
        {message ??
          (unconfirmed
            ? "Delivery wasn't confirmed. Retry checks the original message without sending it twice."
            : composerMessage(
                contract,
                selectedModel,
                bytes,
                hasText,
                state?.agentActivity?.running === true,
              ))}
      </p>
    </form>
  );
}

function placeholder(state: CreatorDashboardState | undefined): string {
  if (state?.pairedStudio.status === "unpaired") return "Connect Studio to start chatting.";
  if (state?.agentActivity?.running) return "Write your next message while Forge works…";
  if (!state?.controlView?.turnContract) return "Write a message…";
  return "Ask Forge to build, fix, or explore your project…";
}

function composerMessage(
  contract: NonNullable<CreatorDashboardState["controlView"]>["turnContract"] | undefined,
  model: CreatorDashboardState["modelRegistry"]["models"][number] | undefined,
  bytes: number,
  hasText: boolean,
  running: boolean,
): string {
  if (running) return "Forge is working. You can draft your next message here.";
  if (!contract) return "Complete the current step above to continue this conversation.";
  if (!model || model.availability !== "available")
    return model?.detail ?? "Choose an available model. Your message is preserved.";
  if (!hasText) return "";
  if (bytes > 0 && bytes < contract.minimumBytes)
    return `Add ${contract.minimumBytes - bytes} more byte${contract.minimumBytes - bytes === 1 ? "" : "s"}.`;
  if (bytes > contract.maximumBytes) return "This message is too long. Shorten it before sending.";
  return "";
}
