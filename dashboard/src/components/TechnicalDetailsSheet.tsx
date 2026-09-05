import { useEffect, useRef, useState } from "react";
import { eventLabel, formatTimestamp, shortHash } from "../derived";
import { TechnicalCatalogExplorer } from "./TechnicalCatalogExplorer";
import { TechnicalReplay } from "./TechnicalReplay";
import { Icon } from "./Icon";
import { GameBuildWindow } from "./GameBuildWindow";
import { GameBuildGraph } from "./GameBuildGraph";
import {
  assertGameBuildControlView,
  type GameBuildControlView,
} from "../../../packages/creator-conversation/src/game-build-contract";
import {
  TechnicalSourceExplorer,
  type TechnicalSourceEvidenceAnchor,
} from "./TechnicalSourceExplorer";
import type {
  CreatorArtifactBinding,
  CreatorCitationTarget,
  CreatorConversationAttachment,
  CreatorConversationEvent,
  CreatorDashboardState,
} from "../types";

interface TechnicalDetailsSheetProps {
  readonly open: boolean;
  readonly event: CreatorConversationEvent | undefined;
  readonly state: CreatorDashboardState | undefined;
  readonly returnFocusTo: HTMLElement | undefined;
  readonly onClose: () => void;
}

export default function TechnicalDetailsSheet({
  open,
  event,
  state,
  returnFocusTo,
  onClose,
}: TechnicalDetailsSheetProps): React.JSX.Element | null {
  const sheetRef = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<CreatorConversationAttachment | undefined>();
  const [raw, setRaw] = useState<string | undefined>();
  const [rawBindingHash, setRawBindingHash] = useState<string | undefined>();
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [graphWindow, setGraphWindow] = useState<{
    view: GameBuildControlView;
    source: HTMLElement;
  }>();
  const savedGraph = selected?.binding.hash === rawBindingHash ? graphFromArtifact(raw) : undefined;
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>();
  const selectedConversationId = state?.selectedConversationId;
  const initialEvent =
    event && (!selectedConversationId || event.conversationId === selectedConversationId)
      ? event
      : undefined;
  const detailEvent =
    selectedEventId === undefined
      ? initialEvent
      : state?.eventPage?.events.find((candidate) => candidate.id === selectedEventId);
  const attachments = uniqueAttachments([
    ...(detailEvent?.attachments ?? state?.controlView?.technicalAttachments ?? []),
    ...(detailEvent?.eventType === "activity"
      ? [{ role: "technical_detail" as const, label: "Work record", binding: detailEvent.data.job }]
      : []),
    ...(detailEvent?.eventType === "memory"
      ? [
          {
            role: "technical_detail" as const,
            label: "Sealed memory revision",
            binding: detailEvent.data.memoryRevision,
          },
        ]
      : []),
  ]);
  const sourceAnchor = sourceEvidenceAnchor(detailEvent);
  // Source navigation is deliberately narrower than the sheet's raw-evidence
  // list: it may only inspect source edits attached to the exact selected event.
  const changeSets = [
    ...(detailEvent?.eventType === "change_set" ? [detailEvent.data.changeSet] : []),
    ...(detailEvent?.attachments ?? [])
      .filter((attachment) => attachment.role === "change_set")
      .map((attachment) => attachment.binding),
  ];
  const activityHistory =
    detailEvent?.eventType === "activity"
      ? (state?.eventPage?.events.flatMap((candidate) =>
          candidate.eventType === "activity" && candidate.data.job.id === detailEvent.data.job.id
            ? [candidate]
            : [],
        ) ?? [])
      : [];

  useEffect(() => {
    setSelectedEventId(undefined);
    setGraphWindow(undefined);
  }, [open, selectedConversationId, event?.id]);

  useEffect(() => {
    if (!open) return;
    // Put focus on an actionable control at open. Focusing only the dialog
    // container leaves Shift+Tab free to escape before the trap can intervene.
    focusableElements(sheetRef.current)[0]?.focus();
    return () => returnFocusTo?.focus();
  }, [open, returnFocusTo]);

  useEffect(() => {
    setSelected(undefined);
    setRaw(undefined);
  }, [open, detailEvent?.id, sourceAnchor?.sourceIndexHash]);

  useEffect(() => {
    if (!selected) {
      setRaw(undefined);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setRawBindingHash(undefined);
    setRaw(undefined);
    setLoadStatus("loading");
    void loadArtifact(selected.binding, controller.signal).then((value) => {
      if (active) {
        setRaw(value.content);
        setLoadStatus(value.error ? "error" : "ready");
        setRawBindingHash(selected.binding.hash);
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [selected]);

  if (!open) return null;
  function onKeyDown(eventKey: React.KeyboardEvent<HTMLElement>): void {
    if (eventKey.key === "Escape") {
      eventKey.preventDefault();
      onClose();
      return;
    }
    if (eventKey.key !== "Tab" || !sheetRef.current) return;
    const focusable = focusableElements(sheetRef.current);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (
      eventKey.shiftKey &&
      (document.activeElement === first || document.activeElement === sheetRef.current)
    ) {
      eventKey.preventDefault();
      last.focus();
    } else if (!eventKey.shiftKey && document.activeElement === last) {
      eventKey.preventDefault();
      first.focus();
    }
  }
  return (
    <div className="technical-backdrop" onMouseDown={onClose}>
      <section
        ref={sheetRef}
        className="technical-details-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="technical-details-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(click) => click.stopPropagation()}
      >
        <header className="technical-details-sheet__heading">
          <div>
            <span>Details</span>
            <h2 id="technical-details-title">
              <span className="sr-only">Technical details: </span>
              {detailEvent ? eventLabel(detailEvent) : "Project context"}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close details" title="Close details">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="technical-details-sheet__body">
          <label className="detail-event-picker">
            Inspect
            <select
              value={detailEvent?.id ?? ""}
              onChange={(change) => setSelectedEventId(change.target.value)}
            >
              <option value="">Project overview</option>
              {state?.eventPage?.events.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.sequence}. {eventLabel(candidate)} —{" "}
                  {formatTimestamp(candidate.occurredAt)}
                </option>
              ))}
            </select>
          </label>
          {!detailEvent && state?.controlView?.gameBuild ? (
            <details className="detail-build-disclosure" open>
              <summary>Current build implementation</summary>
              <GameBuildGraph view={state.controlView.gameBuild} />
            </details>
          ) : null}
          <section className="detail-section" aria-labelledby="evidence-chain-title">
            <h3 id="evidence-chain-title">Event details</h3>
            {detailEvent ? (
              <dl className="detail-facts">
                <div>
                  <dt>Event</dt>
                  <dd>
                    <code>{detailEvent.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>Event hash</dt>
                  <dd>
                    <code title={detailEvent.hash}>{shortHash(detailEvent.hash)}</code>
                  </dd>
                </div>
                <div>
                  <dt>Sequence</dt>
                  <dd>{detailEvent.sequence}</dd>
                </div>
                <div>
                  <dt>Authority</dt>
                  <dd>{detailEvent.authority}</dd>
                </div>
                {detailEvent.projectRevisionHash ? (
                  <div>
                    <dt>Project revision</dt>
                    <dd>
                      <code title={detailEvent.projectRevisionHash}>
                        {shortHash(detailEvent.projectRevisionHash)}
                      </code>
                    </dd>
                  </div>
                ) : null}
                {detailEvent.binding?.controlViewHash ? (
                  <div>
                    <dt>Control view</dt>
                    <dd>
                      <code title={detailEvent.binding.controlViewHash}>
                        {shortHash(detailEvent.binding.controlViewHash)}
                      </code>
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <p>Choose an event above, or browse the saved project details below.</p>
            )}
          </section>
          {detailEvent?.eventType === "activity" && activityHistory.length > 0 ? (
            <section className="detail-section" aria-labelledby="activity-history-title">
              <h3 id="activity-history-title">Run history</h3>
              <p>
                The conversation groups this run into its latest phase. Every saved step remains
                available here in order.
              </p>
              <ol className="activity-history">
                {activityHistory.map((activity) => (
                  <li key={activity.id}>
                    <strong>{activity.data.phase}</strong>
                    <span>{activity.data.message}</span>
                    <time dateTime={activity.occurredAt}>{activity.occurredAt}</time>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {detailEvent?.eventType === "agent_turn" && detailEvent.data.citations.length ? (
            <section className="detail-section" aria-labelledby="citations-title">
              <h3 id="citations-title">Evidence Forge used</h3>
              <ul className="citation-list">
                {detailEvent.data.citations.map((citation) => (
                  <li key={citation.id}>
                    <strong>{citation.label}</strong>
                    <span>
                      {citationAuthority(citation.target)} · {citationTarget(citation.target)}
                    </span>
                    <code title={citation.hash}>{shortHash(citation.hash)}</code>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {detailEvent?.eventType === "agent_turn" ? (
            <section className="detail-section" aria-labelledby="model-attribution-title">
              <h3 id="model-attribution-title">Model attribution</h3>
              <dl className="detail-facts">
                <div>
                  <dt>Requested model</dt>
                  <dd>
                    <code>{detailEvent.data.modelId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Response model</dt>
                  <dd>
                    <code>{detailEvent.data.responseModelId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Provider</dt>
                  <dd>{detailEvent.data.providerId}</dd>
                </div>
                <div>
                  <dt>Agent run</dt>
                  <dd>
                    <code>{detailEvent.data.agentRunId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Provider interval</dt>
                  <dd>
                    {formatDuration(detailEvent.data.timing.durationMs)} ·{" "}
                    {detailEvent.data.timing.startedAt}
                  </dd>
                </div>
                <div>
                  <dt>Usage</dt>
                  <dd>
                    {formatUsage(detailEvent.data.usage.inputTokens, "input")} ·{" "}
                    {formatUsage(detailEvent.data.usage.outputTokens, "output")} ·{" "}
                    {formatCost(detailEvent.data.usage.costUsd)}
                    {detailEvent.data.usage.reasoningTokens !== null
                      ? ` · ${formatUsage(detailEvent.data.usage.reasoningTokens, "reasoning")}`
                      : ""}
                    {detailEvent.data.usage.cacheReadTokens !== null
                      ? ` · ${formatUsage(detailEvent.data.usage.cacheReadTokens, "cached input")}`
                      : ""}
                  </dd>
                </div>
              </dl>
            </section>
          ) : null}
          <section className="detail-section" aria-labelledby="attachments-title">
            <h3 id="attachments-title">Saved details</h3>
            {attachments.length ? (
              <ul className="attachment-list">
                {attachments.map((attachment) => (
                  <li key={`${attachment.role}-${attachment.binding.hash}`}>
                    <div>
                      <strong>{attachment.label}</strong>
                      <span>{attachment.role.replaceAll("_", " ")}</span>
                    </div>
                    <button
                      type="button"
                      aria-pressed={selected?.binding.hash === attachment.binding.hash}
                      onClick={() => setSelected(attachment)}
                    >
                      Inspect
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No additional details are attached to this event.</p>
            )}
            {selected ? (
              <div className="saved-detail-card">
                <div className="saved-detail-card__heading">
                  <Icon name="file" size={18} />
                  <strong>{selected.label}</strong>
                </div>
                <p className={loadStatus === "ready" ? "sr-only" : undefined} role="status">
                  {loadStatus === "loading"
                    ? "Loading saved details…"
                    : loadStatus === "error"
                      ? `Could not load saved details: ${raw}`
                      : "Saved details loaded."}
                </p>
                {loadStatus === "error" ? (
                  <button type="button" onClick={() => setSelected({ ...selected })}>
                    <Icon name="retry" size={16} /> Try again
                  </button>
                ) : null}
                {savedGraph ? (
                  <>
                    <button
                      type="button"
                      className="saved-detail-card__map"
                      aria-label="Open saved game map"
                      aria-haspopup="dialog"
                      onClick={(event) =>
                        setGraphWindow({ view: savedGraph, source: event.currentTarget })
                      }
                    >
                      <Icon name="graph" size={24} />
                      <span>
                        <strong>{savedGraph.architecture?.name ?? "Saved game map"}</strong>
                        <small>Explore systems and connections in this saved plan</small>
                      </span>
                      <Icon name="chevronRight" size={18} />
                    </button>
                    <details className="detail-build-disclosure">
                      <summary>Saved build implementation</summary>
                      <GameBuildGraph view={savedGraph} historical />
                    </details>
                    {graphWindow ? (
                      <GameBuildWindow
                        view={graphWindow.view}
                        historical
                        returnFocusTo={graphWindow.source}
                        onClose={() => setGraphWindow(undefined)}
                      />
                    ) : null}
                  </>
                ) : null}
                {loadStatus === "ready" ? (
                  <details className="saved-detail-card__json">
                    <summary>Raw JSON</summary>
                    <code title={selected.binding.hash}>{shortHash(selected.binding.hash)}</code>
                    <pre tabIndex={0}>{raw}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}
          </section>
          <TechnicalReplay event={detailEvent} attachments={attachments} />
          <TechnicalSourceExplorer
            key={
              sourceAnchor
                ? `${sourceAnchor.eventId}:${sourceAnchor.sourceIndexHash}`
                : (detailEvent?.id ?? "no-source-evidence")
            }
            anchor={sourceAnchor}
            changeSets={uniqueBindings(changeSets)}
          />
          <TechnicalCatalogExplorer />
        </div>
      </section>
    </div>
  );
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex="0"]',
    ),
  ).filter((element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
        const summary = ancestor.querySelector(":scope > summary");
        if (!summary?.contains(element)) return false;
      }
      if (ancestor === container) break;
    }
    return true;
  });
}

/** Historical graph state is read only from the exact selected immutable artifact. */
function graphFromArtifact(raw: string | undefined): GameBuildControlView | undefined {
  if (!raw) return undefined;
  try {
    const artifact = JSON.parse(raw) as { gameBuild?: unknown };
    assertGameBuildControlView(artifact.gameBuild);
    return artifact.gameBuild;
  } catch {
    return undefined;
  }
}

function uniqueBindings(
  bindings: readonly CreatorArtifactBinding[],
): readonly CreatorArtifactBinding[] {
  return [...new Map(bindings.map((binding) => [binding.hash, binding])).values()];
}

function formatDuration(durationMs: number): string {
  return `${new Intl.NumberFormat().format(durationMs)} ms`;
}

function formatUsage(
  tokens: number | null,
  kind: "input" | "output" | "reasoning" | "cached input",
): string {
  return tokens === null ? `${kind} tokens not reported` : `${tokens} ${kind} tokens`;
}

function formatCost(costUsd: number | null): string {
  return costUsd === null ? "cost not reported" : `$${costUsd.toFixed(6)}`;
}

function uniqueAttachments(
  attachments: readonly CreatorConversationAttachment[],
): readonly CreatorConversationAttachment[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = `${attachment.role}:${attachment.binding.hash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function citationTarget(target: CreatorCitationTarget): string {
  switch (target.kind) {
    case "source_range":
      return `${target.displayPath} · bytes ${target.startByte}–${target.endByte}`;
    case "project_fact":
      return target.factKey;
    case "prior_evidence":
      return `Evidence event ${target.eventId}`;
    case "memory":
      return `Remembered item ${target.memoryItemId}`;
  }
}

function citationAuthority(target: CreatorCitationTarget): string {
  switch (target.kind) {
    case "source_range":
      return "Static source analysis";
    case "project_fact":
      return "Studio project evidence";
    case "prior_evidence":
      return "Prior sealed evidence";
    case "memory":
      return "Creator-approved memory";
  }
}

function sourceEvidenceAnchor(
  event: CreatorConversationEvent | undefined,
): TechnicalSourceEvidenceAnchor | undefined {
  if (event?.eventType !== "agent_turn" || !event.episodeId) return undefined;
  const sourceIndexHashes = [
    ...new Set(
      event.data.citations.flatMap((citation) =>
        citation.target.kind === "source_range" ? [citation.target.sourceIndexHash] : [],
      ),
    ),
  ];
  if (sourceIndexHashes.length !== 1) return undefined;
  return {
    conversationId: event.conversationId,
    eventId: event.id,
    eventHash: event.hash,
    sourceIndexHash: sourceIndexHashes[0]!,
  };
}

async function loadArtifact(
  binding: CreatorArtifactBinding,
  signal: AbortSignal,
): Promise<{ content: string; error: boolean }> {
  try {
    const response = await fetch(
      `/api/artifacts/${encodeURIComponent(binding.artifact.artifactHash)}`,
      {
        credentials: "same-origin",
        signal,
      },
    );
    const body = await response.text();
    if (!response.ok)
      return { content: `Artifact request failed (${response.status}).`, error: true };
    try {
      return { content: JSON.stringify(JSON.parse(body) as unknown, null, 2), error: false };
    } catch {
      return { content: body, error: false };
    }
  } catch (error) {
    return {
      content: signal.aborted
        ? ""
        : error instanceof Error
          ? error.message
          : "The artifact could not be loaded.",
      error: true,
    };
  }
}
