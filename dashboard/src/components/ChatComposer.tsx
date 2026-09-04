import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { dashboardStore } from "../api-store";
import { byteLength, makeTurnRequest } from "../derived";
import { useBrowserPreferences } from "../browser-preferences";
import type { ConversationDraft, CreatorDashboardState, DashboardSnapshot } from "../types";
import { Icon } from "./Icon";

interface ChatComposerProps {
  readonly state: CreatorDashboardState | undefined;
  readonly snapshot: DashboardSnapshot;
  readonly onSent?: (conversationId: string | undefined) => void;
}

export function ChatComposer({ state, snapshot, onSent }: ChatComposerProps): React.JSX.Element {
  const [message, setMessage] = useState<string | undefined>();
  const { enterToSend } = useBrowserPreferences();
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
  useLayoutEffect(() => {
    function resize(): void {
      const input = inputRef.current;
      if (!input) return;
      input.style.height = "auto";
      input.style.height = `${Math.min(180, window.innerHeight * 0.3, Math.max(28, input.scrollHeight))}px`;
    }
    resize();
    window.addEventListener("resize", resize);
    let width = inputRef.current?.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = inputRef.current?.clientWidth;
      if (nextWidth !== width) {
        width = nextWidth;
        resize();
      }
    });
    if (inputRef.current) observer.observe(inputRef.current);
    return () => {
      window.removeEventListener("resize", resize);
      observer.disconnect();
    };
  }, [draft.text, conversationId]);
  useEffect(() => {
    setMessage(undefined);
  }, [conversationId]);
  const messageWithinBounds = Boolean(
    contract && bytes >= contract.minimumBytes && bytes <= contract.maximumBytes,
  );
  const canSend = Boolean(
    !snapshot.connectionLost &&
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
      onSent?.(conversationId);
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
        aria-describedby="composer-status"
        title="Focus message with ⌘/Ctrl Shift L"
        rows={1}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            (enterToSend || event.metaKey || event.ctrlKey) &&
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
        {canSend ? (
          <span className="composer-keyboard-hint">
            {enterToSend ? "Enter to send" : "⌘/Ctrl Enter"}
          </span>
        ) : null}
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
          className={`chat-composer__send${unconfirmed ? " chat-composer__retry" : ""}`}
          disabled={!canSend || bytes === 0}
        >
          {snapshot.pendingRequest?.kind === "turn" ? (
            <span className="sending-spinner" aria-hidden="true" />
          ) : unconfirmed ? (
            <Icon name="retry" />
          ) : (
            <Icon name="arrowUp" />
          )}
        </button>
      </div>
      {snapshot.draftStorageError ? (
        <p className="draft-storage-error" role="status">
          {snapshot.draftStorageError}
        </p>
      ) : null}
      <p id="composer-status" className="chat-composer__status" role="status" aria-live="polite">
        {message ??
          (unconfirmed
            ? "Delivery wasn't confirmed. Retry checks the original message without sending it twice."
            : composerMessage(
                contract,
                selectedModel,
                bytes,
                hasText,
                state?.agentActivities?.some((activity) => activity.running) === true,
              ))}
      </p>
    </form>
  );
}

function placeholder(state: CreatorDashboardState | undefined): string {
  if (state?.pairedStudio.status === "unpaired") return "Connect Studio to start chatting.";
  if (state?.agentActivities?.some((activity) => activity.running))
    return "Write your next message while Forge works…";
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
  if (running) return "";
  if (!contract) return "Complete the current step above to continue this conversation.";
  if (!model || model.availability !== "available")
    return model?.detail ?? "Choose an available model. Your message is preserved.";
  if (!hasText) return "";
  if (bytes > 0 && bytes < contract.minimumBytes)
    return `Add ${contract.minimumBytes - bytes} more byte${contract.minimumBytes - bytes === 1 ? "" : "s"}.`;
  if (bytes > contract.maximumBytes) return "This message is too long. Shorten it before sending.";
  return "";
}
