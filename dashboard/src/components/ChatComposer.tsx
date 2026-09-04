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
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const { enterToSend } = useBrowserPreferences();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
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
    setModelPickerOpen(false);
  }, [conversationId]);
  useEffect(() => {
    if (!modelPickerOpen) return;
    modelPickerRef.current
      ?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')
      ?.focus();
    const close = (event: PointerEvent): void => {
      if (!modelPickerRef.current?.contains(event.target as Node)) setModelPickerOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [modelPickerOpen]);
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
        <div
          className="composer-model-picker"
          ref={modelPickerRef}
          onKeyDown={(event) => {
            if (event.key === "Escape" && modelPickerOpen) {
              event.preventDefault();
              setModelPickerOpen(false);
              modelTriggerRef.current?.focus();
              return;
            }
            if (!modelPickerOpen || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            const options = [
              ...modelPickerRef.current!.querySelectorAll<HTMLButtonElement>(
                '[role="option"]:not(:disabled)',
              ),
            ];
            if (!options.length) return;
            event.preventDefault();
            const current = options.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : event.key === "ArrowDown"
                    ? (current + 1) % options.length
                    : (current + options.length - 1) % options.length;
            options[next]?.focus();
          }}
        >
          <button
            ref={modelTriggerRef}
            type="button"
            className="composer-model-trigger"
            role="combobox"
            aria-label="Model"
            aria-haspopup="listbox"
            aria-expanded={modelPickerOpen}
            aria-controls="composer-model-options"
            disabled={!registry || Boolean(snapshot.pendingRequest)}
            onClick={() => setModelPickerOpen((open) => !open)}
            onKeyDown={(event) => {
              if (["ArrowDown", "ArrowUp"].includes(event.key) && !modelPickerOpen) {
                event.preventDefault();
                setModelPickerOpen(true);
              }
            }}
          >
            <Icon name={modelPickerOpen ? "chevronDown" : "chevronRight"} size={13} />
            <span>{selectedModel?.displayName ?? "Choose model"}</span>
          </button>
          {modelPickerOpen ? (
            <div className="composer-model-popover">
              <div className="composer-model-options__heading">
                <span>Models</span>
                <small>Choose for your next message</small>
              </div>
              <div
                id="composer-model-options"
                className="composer-model-options"
                role="listbox"
                aria-label="Choose a model"
              >
                {registry?.models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={model.id === selectedModelId}
                    disabled={model.availability !== "available"}
                    onClick={() => {
                      changeDraft({ modelId: model.id });
                      setModelPickerOpen(false);
                      modelTriggerRef.current?.focus();
                    }}
                  >
                    <span className="composer-model-options__icon">
                      <Icon name="model" size={15} />
                    </span>
                    <span>
                      <strong>{model.displayName}</strong>
                      <small>
                        {model.availability === "available"
                          ? model.id === registry.defaultModelId
                            ? `${modelProvider(model.id)} · Default`
                            : modelProvider(model.id)
                          : (model.detail ?? "Unavailable")}
                      </small>
                    </span>
                    {model.id === selectedModelId ? <Icon name="check" size={16} /> : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
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

function modelProvider(modelId: string): string {
  const provider = modelId.split("/", 1)[0];
  if (provider === "openai") return "OpenAI";
  if (provider === "google") return "Google";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "meta") return "Meta";
  if (provider === "z-ai") return "Z.ai";
  return provider || "Model provider";
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
