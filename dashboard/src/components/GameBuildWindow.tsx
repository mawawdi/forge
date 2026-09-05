import { useEffect, useId, useRef, useState } from "react";
import type { GameBuildControlView } from "../../../packages/creator-conversation/src/game-build-contract";
import { GameSystemExplorer } from "./GameSystemExplorer";
import { Icon } from "./Icon";

/** Native modal owns focus, Escape, and background inertness; its data remains read-only. */
export function GameBuildWindow({
  view,
  historical = false,
  returnFocusTo,
  onClose,
}: {
  readonly view: GameBuildControlView | undefined;
  readonly historical?: boolean;
  readonly returnFocusTo: HTMLElement | undefined;
  readonly onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const element = ref.current;
    const source = returnFocusTo ?? document.activeElement;
    element?.showModal();
    close.current?.focus();
    return () => {
      element?.close();
      if (source instanceof HTMLElement && source.isConnected) source.focus();
    };
  }, [returnFocusTo]);
  return (
    <dialog
      ref={ref}
      className={`game-build-window${expanded ? " game-build-window--expanded" : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Tab") return;
        const focusable = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input, select, textarea, a[href], [tabindex='0']",
          ),
        ].filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <header className="game-build-window__header">
        <span className="game-build-window__title">
          <Icon name="graph" size={22} />
          <span>
            <h2 id={titleId} title={view?.architecture?.name ?? "Game map"}>
              {view?.architecture?.name ?? "Game map"}
            </h2>
            {historical ? <span className="game-build-window__saved">Saved map</span> : null}
          </span>
        </span>
        <span className="game-build-window__actions">
          <button
            type="button"
            className="header-icon-button game-build-window__expand"
            aria-label={expanded ? "Restore graph window" : "Expand graph window"}
            aria-pressed={expanded}
            title={expanded ? "Restore window size" : "Expand window"}
            onClick={() => setExpanded(!expanded)}
          >
            <Icon name={expanded ? "restore" : "expand"} />
          </button>
          <button
            ref={close}
            type="button"
            className="header-icon-button"
            aria-label="Close game map"
            title="Close map · Esc"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </span>
      </header>
      <div className="game-build-window__content">
        {view ? (
          <GameSystemExplorer key={view.planHash} view={view} historical={historical} />
        ) : (
          <div className="game-map__empty">
            <span className="game-map__empty-art">
              <Icon name="graph" size={44} />
            </span>
            <h3>No game plan yet</h3>
            <p>
              Your game’s systems and connections will take shape here when Forge prepares a game
              plan.
            </p>
            <button type="button" onClick={onClose}>
              Back to conversation <Icon name="chevronRight" size={16} />
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}
