import { useLayoutEffect, useRef } from "react";

/** Restore keyboard position after a graph detail or scope change removes its trigger. */
export function useGraphFocus() {
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<{ nodeId?: string } | undefined>(undefined);
  useLayoutEffect(() => {
    if (!pending.current || !root.current) return;
    const nodeId = pending.current.nodeId;
    pending.current = undefined;
    const node =
      nodeId === undefined
        ? undefined
        : [...root.current.querySelectorAll<HTMLButtonElement>("[data-graph-node]")].find(
            (element) => element.dataset.graphNode === nodeId,
          );
    const target =
      node ??
      root.current.querySelector<HTMLElement>(".build-space__canvas") ??
      root.current.querySelector<HTMLButtonElement>("[data-graph-node]");
    target?.focus({ preventScroll: true });
  });
  return {
    root,
    requestFocus: (nodeId?: string): void => {
      pending.current = nodeId === undefined ? {} : { nodeId };
    },
  };
}
