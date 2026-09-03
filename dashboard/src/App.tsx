import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { dashboardStore, useDashboardSnapshot } from "./api-store";
import { getDashboardSurface } from "./derived";
import { ChatComposer } from "./components/ChatComposer";
import { ConversationHeader } from "./components/ConversationHeader";
import { ConversationTimeline } from "./components/ConversationTimeline";
import { ProjectSettings } from "./components/ProjectSettings";
import { AgentActivity } from "./components/AgentActivity";
import { ProjectRail } from "./components/ProjectRail";
import type { CreatorConversationEvent } from "./types";

const TechnicalDetailsSheet = lazy(() => import("./components/TechnicalDetailsSheet"));

export function App(): React.JSX.Element {
  const snapshot = useDashboardSnapshot();
  const state = snapshot.data;
  const surface = getDashboardSurface(state, snapshot.error);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsEvent, setDetailsEvent] = useState<CreatorConversationEvent | undefined>();
  const detailsReturnFocus = useRef<HTMLElement | undefined>(undefined);
  const projectReturnFocus = useRef<HTMLElement | undefined>(undefined);
  const contextReturnFocus = useRef<HTMLElement | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastConversation = useRef<string | undefined>(undefined);
  const followingLatest = useRef(true);
  const narrowLayout = useNarrowLayout();

  useEffect(() => {
    dashboardStore.start();
  }, []);

  useEffect(() => {
    // Technical evidence is scoped to one immutable project conversation.
    // A project switch must never leave the prior project's event or raw
    // artifact visible beside the newly selected conversation.
    setDetailsOpen(false);
    setDetailsEvent(undefined);
    setContextOpen(false);
  }, [state?.selectedConversationId]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (lastConversation.current !== state?.selectedConversationId) followingLatest.current = true;
    if (followingLatest.current) scroller.scrollTop = scroller.scrollHeight;
    lastConversation.current = state?.selectedConversationId;
  }, [
    state?.selectedConversationId,
    state?.eventPage?.events.at(-1)?.id,
    state?.agentActivity?.updatedAt,
  ]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingLatest.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(scroller);
    for (const child of scroller.children) observer.observe(child);
    return () => observer.disconnect();
  }, [state?.selectedConversationId, Boolean(state?.agentActivity)]);

  function openDetails(event: CreatorConversationEvent | undefined, source: HTMLElement): void {
    detailsReturnFocus.current = source;
    setDetailsEvent(event);
    setDetailsOpen(true);
  }

  function closeDetails(): void {
    setDetailsOpen(false);
    setDetailsEvent(undefined);
  }

  return (
    <main id="conversation" className={`app-shell app-shell--${surface}`}>
      <ConversationHeader
        state={state}
        onOpenProjects={(source) => {
          projectReturnFocus.current = source;
          setProjectsOpen(true);
        }}
        onOpenDetails={(source) => openDetails(undefined, source)}
        onOpenContext={(source) => {
          contextReturnFocus.current = source;
          setContextOpen(true);
        }}
      />
      {snapshot.error ? (
        <section className="connection-notice" role="status" aria-live="polite">
          <strong>Forge needs attention</strong>
          <p>{snapshot.error}</p>
        </section>
      ) : null}
      <div className="conversation-layout">
        {narrowLayout && projectsOpen ? (
          <div
            className="project-drawer-backdrop"
            aria-hidden="true"
            onClick={() => {
              setProjectsOpen(false);
              projectReturnFocus.current?.focus();
            }}
          />
        ) : null}
        <ProjectRail
          conversations={state?.conversations ?? []}
          state={state}
          selectedConversationId={state?.selectedConversationId}
          open={projectsOpen}
          drawer={narrowLayout}
          onSelect={(conversationId) => {
            closeDetails();
            dashboardStore.selectConversation(conversationId);
            setProjectsOpen(false);
            projectReturnFocus.current?.focus();
          }}
          onClose={() => {
            setProjectsOpen(false);
            projectReturnFocus.current?.focus();
          }}
        />
        <section className="conversation-canvas" aria-label="Forge project conversation">
          <div
            className="conversation-scroll"
            ref={scrollRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              followingLatest.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 180;
            }}
          >
            <ConversationTimeline
              state={state}
              snapshot={snapshot}
              onOpenDetails={(event, source) => openDetails(event, source)}
            />
            <AgentActivity
              state={state}
              onOpenDetails={(source) => {
                const events = [...(state?.eventPage?.events ?? [])].reverse();
                const run = state?.agentActivity;
                const evidence = events.find((event) =>
                  event.attachments.some(
                    (attachment) =>
                      attachment.role === "agent_run" && attachment.binding.id === run?.agentRunId,
                  ),
                );
                const activity = events.find(
                  (event) => event.eventType === "activity" && event.data.job.id === run?.jobId,
                );
                openDetails(evidence ?? activity, source);
              }}
            />
          </div>
          <ChatComposer state={state} snapshot={snapshot} />
        </section>
      </div>
      <ProjectSettings
        state={state}
        open={contextOpen}
        returnFocusTo={contextReturnFocus.current}
        onClose={() => {
          setContextOpen(false);
          contextReturnFocus.current?.focus();
        }}
        onOpenDetails={() => openDetails(undefined, contextReturnFocus.current!)}
      />
      <Suspense
        fallback={
          detailsOpen ? <div className="technical-loading">Opening technical details…</div> : null
        }
      >
        <TechnicalDetailsSheet
          open={detailsOpen}
          event={detailsEvent}
          state={state}
          returnFocusTo={detailsReturnFocus.current}
          onClose={closeDetails}
        />
      </Suspense>
    </main>
  );
}

/**
 * Rails are always present on desktop, but turn into off-canvas drawers below
 * the layout breakpoint. Keep hidden drawers out of keyboard navigation rather
 * than relying on a visual translate alone.
 */
function useNarrowLayout(): boolean {
  const query = "(max-width: 900px)";
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = (): void => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return narrow;
}
