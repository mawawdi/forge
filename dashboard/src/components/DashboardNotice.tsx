import type { DashboardSurface } from "../derived";

interface DashboardNoticeProps {
  surface: DashboardSurface;
  error: string | undefined;
  detail?: string;
}

const NOTICE_CONTENT: Record<Exclude<DashboardSurface, "active">, { title: string; body: string }> = {
  loading: {
    title: "Opening the evidence record",
    body: "Forge is retrieving the current session state from the local control plane.",
  },
  "api-error": {
    title: "Control plane unavailable",
    body: "The previous evidence remains visible when available. Check that creator serve is still running, then retry.",
  },
  unpaired: {
    title: "Pair a Studio project to begin",
    body: "Open the Forge connector in Studio, pair this local control plane, then submit a bounded request.",
  },
  empty: {
    title: "Start with a creator request",
    body: "Forge will capture a fresh Studio snapshot before it asks an agent for a visible plan.",
  },
  incomplete: {
    title: "Evidence is incomplete",
    body: "This session is preserved as incomplete. It cannot receive an invented verification verdict.",
  },
  "recovery-required": {
    title: "Studio recovery required",
    body: "Forge cannot assume the outcome of an interrupted Studio recording. Inspect Studio and recover explicitly.",
  },
  terminal: {
    title: "Creator decision recorded",
    body: "The completed session remains retrievable with its exact evidence and creator report.",
  },
};

export function DashboardNotice({ surface, error, detail }: DashboardNoticeProps): React.JSX.Element | null {
  if (surface === "active") return null;
  const notice = NOTICE_CONTENT[surface];
  const body = surface === "api-error" && error
    ? error
    : detail && ["incomplete", "recovery-required", "terminal"].includes(surface)
      ? detail
      : notice.body;
  return (
    <section className={`dashboard-notice dashboard-notice--${surface}`} aria-live="polite">
      <p className="eyebrow">State: {surface}</p>
      <h1>{notice.title}</h1>
      <p>{body}</p>
    </section>
  );
}
