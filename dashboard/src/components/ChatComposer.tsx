import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { dashboardStore, isAdmissionRejection } from "../api-store";
import { byteLength, makeTurnRequest } from "../derived";
import { useBrowserPreferences } from "../browser-preferences";
import type {
  ConversationDraft,
  CreatorDashboardState,
  CreatorTurnRequest,
  DashboardSnapshot,
} from "../types";
import { Icon } from "./Icon";
import { ComposerVisualAttachments } from "./ComposerVisualAttachments";
import { UnconfirmedMessages } from "./UnconfirmedMessages";
import {
  attachmentBatchError,
  readVisualAttachment,
  VISUAL_ATTACHMENT_LIMITS,
  type ComposerVisualAttachment,
} from "../visual-attachments";

interface ChatComposerProps {
  readonly state: CreatorDashboardState | undefined;
  readonly snapshot: DashboardSnapshot;
  readonly onSent?: (conversationId: string | undefined) => void;
}

export function ChatComposer({ state, snapshot, onSent }: ChatComposerProps): React.JSX.Element {
  const [message, setMessage] = useState<string | undefined>();
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [attachmentDrafts, setAttachmentDrafts] = useState<
    Readonly<Record<string, readonly ComposerVisualAttachment[]>>
  >({});
  const [attachmentError, setAttachmentError] = useState<string | undefined>();
  const [readingAttachments, setReadingAttachments] = useState(false);
  const [sending, setSending] = useState(false);
  const [rejectedSavedMessages, setRejectedSavedMessages] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [draggingImages, setDraggingImages] = useState(false);
  const imageDragDepth = useRef(0);
  const attachmentGeneration = useRef(0);
  const readingAttachmentsRef = useRef(false);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const { enterToSend } = useBrowserPreferences();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const conversationId = state?.selectedConversationId;
  const attachmentKey = conversationId ?? "new-conversation";
  const attachments = attachmentDrafts[attachmentKey] ?? [];
  const draft = dashboardStore.draftFor(conversationId);
  const contract = state?.controlView?.turnContract;
  const registry = state?.modelRegistry;
  const selectedModelId = draft.modelId ?? registry?.defaultModelId ?? "";
  const visualObservations = attachments.map((item) => item.observation);
  const unconfirmed = dashboardStore.unconfirmedTurnFor(
    conversationId,
    draft.text,
    selectedModelId,
    visualObservations,
  );
  const savedMessages = (snapshot.unconfirmedTurns ?? []).filter(
    (request) =>
      request.conversationId === conversationId &&
      request.idempotencyKey !== unconfirmed?.idempotencyKey,
  );
  const canRestoreSavedMessage = (request: CreatorTurnRequest): boolean =>
    attachments.length === 0 &&
    (!draft.text.trim() ||
      (draft.text === request.text && selectedModelId === request.selectedModelId));
  const turnKind = contract?.allowedTurnTypes[0];
  const selectedModel = registry?.models.find((model) => model.id === selectedModelId);
  const needsImageModel =
    !unconfirmed && attachments.length > 0 && selectedModel?.imageInput !== "supported";
  const hasAvailableImageModel = registry?.models.some(
    (model) => model.availability === "available" && model.imageInput === "supported",
  );
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
    setAttachmentError(undefined);
    setReadingAttachments(false);
    readingAttachmentsRef.current = false;
    setSending(false);
    setDraggingImages(false);
    imageDragDepth.current = 0;
    attachmentGeneration.current++;
    return () => {
      attachmentGeneration.current++;
    };
  }, [conversationId]);
  useEffect(() => {
    if (!modelPickerOpen) return;
    const picker = modelPickerRef.current;
    (
      picker?.querySelector<HTMLButtonElement>(
        '[role="option"][aria-selected="true"]:not(:disabled)',
      ) ??
      picker?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)') ??
      modelTriggerRef.current
    )?.focus();
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
    !readingAttachments &&
    !sending &&
    attachments.every((item) => item.observation.caption.trim().length > 0) &&
    (unconfirmed ||
      (contract &&
        !needsImageModel &&
        !savedMessages.some(
          (request) =>
            !rejectedSavedMessages.has(request.idempotencyKey) || canRestoreSavedMessage(request),
        ) &&
        turnKind &&
        selectedModel?.availability === "available" &&
        hasText &&
        messageWithinBounds)),
  );
  const canChooseImageModel = Boolean(
    needsImageModel &&
    registry &&
    !snapshot.connectionLost &&
    !snapshot.pendingRequest &&
    !readingAttachments &&
    !sending,
  );

  function changeDraft(change: Partial<ConversationDraft>): void {
    dashboardStore.updateDraft(conversationId, { ...draft, ...change });
  }

  function setAttachments(
    change:
      | readonly ComposerVisualAttachment[]
      | ((current: readonly ComposerVisualAttachment[]) => readonly ComposerVisualAttachment[]),
  ): void {
    setAttachmentDrafts((current) => ({
      ...current,
      [attachmentKey]: typeof change === "function" ? change(current[attachmentKey] ?? []) : change,
    }));
  }

  async function addAttachments(files: readonly File[]): Promise<void> {
    if (!files.length || readingAttachmentsRef.current || sending || snapshot.pendingRequest)
      return;
    const error = attachmentBatchError(attachments, files);
    if (error) {
      setAttachmentError(error);
      return;
    }
    const generation = attachmentGeneration.current;
    readingAttachmentsRef.current = true;
    setReadingAttachments(true);
    setAttachmentError(undefined);
    try {
      const loaded = await Promise.all(files.map(readVisualAttachment));
      if (attachmentGeneration.current === generation) {
        if (
          [...attachments, ...loaded].reduce((total, item) => total + item.bytes, 0) >
          VISUAL_ATTACHMENT_LIMITS.totalBytes
        )
          throw new Error("These images are too large together. Try fewer or smaller images.");
        setAttachments((current) => [...current, ...loaded]);
      }
    } catch (error) {
      if (attachmentGeneration.current === generation)
        setAttachmentError(
          error instanceof Error
            ? error.message
            : "These images could not be added. Choose images and try again.",
        );
    } finally {
      if (attachmentGeneration.current === generation) {
        readingAttachmentsRef.current = false;
        setReadingAttachments(false);
      }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSend) return;
    if (unconfirmed)
      setRejectedSavedMessages((current) => {
        const next = new Set(current);
        next.delete(unconfirmed.idempotencyKey);
        return next;
      });
    const generation = attachmentGeneration.current;
    setSending(true);
    try {
      setMessage(undefined);
      if (unconfirmed) await dashboardStore.retryTurn(unconfirmed.idempotencyKey);
      else if (state && contract && turnKind)
        await dashboardStore.submitTurn({
          ...makeTurnRequest(state, turnKind, draft.text, selectedModelId),
          ...(visualObservations.length ? { visualObservations } : {}),
        });
      onSent?.(conversationId);
      setAttachmentDrafts((current) =>
        current[attachmentKey] === attachments ? { ...current, [attachmentKey]: [] } : current,
      );
      if (attachmentGeneration.current === generation) {
        setAttachmentError(undefined);
        setMessage(undefined);
      }
    } catch (error) {
      if (attachmentGeneration.current === generation)
        setMessage(error instanceof Error ? error.message : "Forge could not accept this message.");
    } finally {
      if (attachmentGeneration.current === generation) setSending(false);
    }
  }

  async function retrySavedMessage(request: CreatorTurnRequest): Promise<void> {
    if (snapshot.connectionLost || snapshot.pendingRequest || readingAttachments || sending) return;
    setRejectedSavedMessages((current) => {
      const next = new Set(current);
      next.delete(request.idempotencyKey);
      return next;
    });
    const generation = attachmentGeneration.current;
    setSending(true);
    setMessage(undefined);
    try {
      await dashboardStore.retryTurn(request.idempotencyKey, {
        retainOnRejection: true,
        preserveDraft:
          attachments.length > 0 ||
          draft.text !== request.text ||
          selectedModelId !== request.selectedModelId,
      });
      onSent?.(conversationId);
    } catch (error) {
      if (isAdmissionRejection(error) && error.idempotencyKey === request.idempotencyKey)
        setRejectedSavedMessages((current) => new Set([...current, request.idempotencyKey]));
      if (attachmentGeneration.current === generation)
        setMessage(
          error instanceof Error ? error.message : "Forge could not confirm this message.",
        );
    } finally {
      if (attachmentGeneration.current === generation) setSending(false);
    }
  }

  async function restoreSavedMessage(request: CreatorTurnRequest): Promise<void> {
    if (
      !rejectedSavedMessages.has(request.idempotencyKey) ||
      !canRestoreSavedMessage(request) ||
      snapshot.pendingRequest ||
      sending ||
      readingAttachmentsRef.current
    )
      return;
    const generation = attachmentGeneration.current;
    const draftBeforeRestore = dashboardStore.draftFor(conversationId);
    readingAttachmentsRef.current = true;
    setReadingAttachments(true);
    try {
      const restored = await Promise.all(
        (request.visualObservations ?? []).map(async (observation, index) => {
          const bytes = Uint8Array.from(atob(observation.image.base64), (char) =>
            char.charCodeAt(0),
          );
          const image = await readVisualAttachment(
            new File([bytes], observation.caption || `Image ${index + 1}`, { type: "image/png" }),
          );
          return { ...image, observation };
        }),
      );
      if (attachmentGeneration.current !== generation) return;
      const liveDraft = dashboardStore.draftFor(conversationId);
      if (
        liveDraft.text !== draftBeforeRestore.text ||
        liveDraft.modelId !== draftBeforeRestore.modelId
      ) {
        setMessage("Your current draft is kept. Send or clear it to edit the saved message.");
        return;
      }
      // Release the immutable retry only after decoding succeeded and the host proved non-admission.
      dashboardStore.discardRejectedTurn(request.idempotencyKey);
      dashboardStore.updateDraft(conversationId, {
        text: request.text,
        modelId: request.selectedModelId,
      });
      setAttachments(restored);
      setRejectedSavedMessages((current) => {
        const next = new Set(current);
        next.delete(request.idempotencyKey);
        return next;
      });
      setMessage(undefined);
      inputRef.current?.focus();
    } catch (error) {
      if (attachmentGeneration.current === generation)
        setMessage(
          error instanceof Error ? error.message : "The saved images could not be restored.",
        );
    } finally {
      if (attachmentGeneration.current === generation) {
        readingAttachmentsRef.current = false;
        setReadingAttachments(false);
      }
    }
  }

  return (
    <form
      className={`chat-composer${draggingImages ? " chat-composer--drop" : ""}`}
      onSubmit={(event) => void submit(event)}
      aria-label="Message Forge"
      onPaste={(event) => {
        const files = [...event.clipboardData.items]
          .filter((item) => item.kind === "file")
          .flatMap((item) => {
            const file = item.getAsFile();
            return file ? [file] : [];
          });
        if (!files.length) return;
        if (!event.clipboardData.getData("text/plain")) event.preventDefault();
        void addAttachments(files);
      }}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        imageDragDepth.current++;
        setDraggingImages(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = sending || readingAttachments ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        imageDragDepth.current = Math.max(0, imageDragDepth.current - 1);
        if (!imageDragDepth.current) setDraggingImages(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        imageDragDepth.current = 0;
        setDraggingImages(false);
        void addAttachments([...event.dataTransfer.files]);
      }}
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
      <UnconfirmedMessages
        requests={savedMessages}
        rejectedKeys={rejectedSavedMessages}
        canRestore={canRestoreSavedMessage}
        disabled={
          Boolean(snapshot.connectionLost || snapshot.pendingRequest) ||
          sending ||
          readingAttachments
        }
        onRetry={(request) => void retrySavedMessage(request)}
        onRestore={(request) => void restoreSavedMessage(request)}
      />
      <ComposerVisualAttachments
        attachments={attachments}
        disabled={sending || readingAttachments || Boolean(snapshot.pendingRequest)}
        error={attachmentError}
        onChange={(value) => {
          setAttachments(value);
          setAttachmentError(undefined);
        }}
      />
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
        <div className="composer-attach-control">
          <input
            ref={attachmentInput}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            tabIndex={-1}
            aria-label="Choose images"
            disabled={sending || readingAttachments || Boolean(snapshot.pendingRequest)}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              void addAttachments(files);
            }}
          />
          <button
            type="button"
            aria-label={readingAttachments ? "Preparing images" : "Attach images"}
            title="Attach, paste or drop images · PNG, JPG, WebP"
            disabled={sending || readingAttachments || Boolean(snapshot.pendingRequest)}
            onClick={() => attachmentInput.current?.click()}
          >
            {readingAttachments ? (
              <span className="sending-spinner" aria-hidden="true" />
            ) : (
              <Icon name="image" size={18} />
            )}
          </button>
        </div>
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
                <small>
                  {attachments.length
                    ? hasAvailableImageModel
                      ? "Choose a model for your images"
                      : "No image models available"
                    : "Choose for your next message"}
                </small>
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
                    disabled={
                      model.availability !== "available" ||
                      (attachments.length > 0 && model.imageInput !== "supported")
                    }
                    onClick={() => {
                      changeDraft({ modelId: model.id });
                      setMessage(undefined);
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
                        {attachments.length
                          ? ` · ${
                              model.imageInput === "supported"
                                ? "Images supported"
                                : model.imageInput === "unsupported"
                                  ? "Text only"
                                  : "Image support unconfirmed"
                            }`
                          : ""}
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
          type={needsImageModel ? "button" : "submit"}
          aria-label={
            sending || snapshot.pendingRequest?.kind === "turn"
              ? "Sending"
              : unconfirmed
                ? "Retry message"
                : needsImageModel
                  ? "Choose image model"
                  : "Send"
          }
          title={
            unconfirmed
              ? "Retry the original message"
              : needsImageModel
                ? "Choose a model that supports images"
                : "Send message"
          }
          className={`chat-composer__send${unconfirmed ? " chat-composer__retry" : ""}`}
          disabled={needsImageModel ? !canChooseImageModel : !canSend || bytes === 0}
          onClick={needsImageModel ? () => setModelPickerOpen(true) : undefined}
        >
          {sending || snapshot.pendingRequest?.kind === "turn" ? (
            <span className="sending-spinner" aria-hidden="true" />
          ) : unconfirmed ? (
            <Icon name="retry" />
          ) : needsImageModel ? (
            <Icon name="model" />
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
        {readingAttachments
          ? "Preparing images…"
          : (message ??
            (unconfirmed
              ? "Delivery wasn't confirmed. Retry checks the original message without sending it twice."
              : needsImageModel
                ? hasAvailableImageModel
                  ? "Choose a model that supports your images."
                  : "No image models are available. Your images are kept."
                : composerMessage(
                    contract,
                    selectedModel,
                    bytes,
                    hasText,
                    state?.agentActivities?.some((activity) => activity.running) === true,
                  )))}
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
