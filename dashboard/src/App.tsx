import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { dashboardStore, useDashboardSnapshot } from "./api-store";
import { getDashboardSurface, makeActionRequest } from "./derived";
import { updateBrowserPreferences, useBrowserPreferences } from "./browser-preferences";
import { ChatComposer } from "./components/ChatComposer";
import { ConversationHeader } from "./components/ConversationHeader";
import { ConversationTimeline } from "./components/ConversationTimeline";
import { ProjectSettings } from "./components/ProjectSettings";
import { ProjectRail } from "./components/ProjectRail";
import { ConversationSearch } from "./components/ConversationSearch";
import { Icon } from "./components/Icon";
import { GameBuildWindow } from "./components/GameBuildWindow";
import type { CreatorConversationEvent } from "./types";

const TechnicalDetailsSheet = lazy(() => import("./components/TechnicalDetailsSheet"));
// A small nudge upward is usually just a reader checking the prior activity.
// Keep the affordance out of the way until they have moved meaningfully into history.
const LATEST_BUTTON_THRESHOLD_PX = 1024;

function isMeaningfullyAwayFromLatest(scroller: HTMLElement): boolean {
  return (
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= LATEST_BUTTON_THRESHOLD_PX
  );
}

export function App(): React.JSX.Element {
  const snapshot = useDashboardSnapshot();
  const state = snapshot.data;
  const surface = getDashboardSurface(state, snapshot.error);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [newUpdates, setNewUpdates] = useState(false);
  const [commandError, setCommandError] = useState<string>();
  const focusNewConversation = useRef(false);
  const preferences = useBrowserPreferences();
  const [detailsEvent, setDetailsEvent] = useState<CreatorConversationEvent | undefined>();
  const detailsReturnFocus = useRef<HTMLElement | undefined>(undefined);
  const projectReturnFocus = useRef<HTMLElement | undefined>(undefined);
  const contextReturnFocus = useRef<HTMLElement | undefined>(undefined);
  const graphReturnFocus = useRef<HTMLElement | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastConversation = useRef<string | undefined>(undefined);
  const followingLatest = useRef(true);
  const lastScrollTop = useRef(0);
  const touchY = useRef<number | undefined>(undefined);
  const scrollPositions = useRef(new Map<string, { top: number; following: boolean }>());
  const historyAnchor = useRef<{ conversationId: string; top: number; height: number } | undefined>(
    undefined,
  );
  const narrowLayout = useNarrowLayout();
  const projectsVisible = narrowLayout ? projectsOpen : !preferences.sidebarHidden;

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
    setGraphOpen(false);
    setCommandError(undefined);
    if (focusNewConversation.current) {
      document.getElementById("forge-message")?.focus({ preventScroll: true });
      focusNewConversation.current = false;
    }
  }, [state?.selectedConversationId]);

  useEffect(() => {
    const conversation = state?.conversations.find(
      (chat) => chat.id === state.selectedConversationId,
    );
    const prefix = snapshot.connectionLost
      ? "Updates paused"
      : state?.agentActivities?.some((activity) => activity.running)
        ? "Working"
        : conversation?.status === "awaiting_creator"
          ? "Needs your attention"
          : undefined;
    document.title = [prefix, "Forge"].filter(Boolean).join(" · ");
  }, [
    state?.conversations,
    state?.selectedConversationId,
    state?.agentActivities,
    snapshot.connectionLost,
  ]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const id = state?.selectedConversationId;
    const switched = lastConversation.current !== id;
    if (switched) {
      const position = id ? scrollPositions.current.get(id) : undefined;
      followingLatest.current = position?.following ?? true;
      scroller.scrollTop = followingLatest.current ? scroller.scrollHeight : (position?.top ?? 0);
      setAwayFromLatest(!followingLatest.current && isMeaningfullyAwayFromLatest(scroller));
      setNewUpdates(false);
      historyAnchor.current = undefined;
    } else if (
      historyAnchor.current &&
      historyAnchor.current.conversationId === id &&
      snapshot.loadingHistoryFor !== id
    ) {
      const anchor = historyAnchor.current;
      scroller.scrollTop = anchor.top + scroller.scrollHeight - anchor.height;
      historyAnchor.current = undefined;
    } else if (followingLatest.current) scroller.scrollTop = scroller.scrollHeight;
    else if (!historyAnchor.current) setNewUpdates(true);
    lastScrollTop.current = scroller.scrollTop;
    lastConversation.current = state?.selectedConversationId;
  }, [
    state?.selectedConversationId,
    state?.eventPage?.events.at(-1)?.id,
    state?.eventPage?.events[0]?.id,
    state?.agentActivities?.at(-1)?.updatedAt,
    snapshot.loadingHistoryFor,
  ]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingLatest.current) {
        scroller.scrollTop = scroller.scrollHeight;
        lastScrollTop.current = scroller.scrollTop;
      }
      setAwayFromLatest(!followingLatest.current && isMeaningfullyAwayFromLatest(scroller));
    });
    observer.observe(scroller);
    for (const child of scroller.children) observer.observe(child);
    return () => observer.disconnect();
  }, [state?.selectedConversationId]);

  function openDetails(event: CreatorConversationEvent | undefined, source: HTMLElement): void {
    detailsReturnFocus.current = source;
    setDetailsEvent(event);
    setDetailsOpen(true);
  }

  function closeDetails(): void {
    setDetailsOpen(false);
    setDetailsEvent(undefined);
  }

  function toggleProjects(source?: HTMLElement): void {
    if (source) projectReturnFocus.current = source;
    if (narrowLayout) setProjectsOpen(!projectsOpen);
    else updateBrowserPreferences({ sidebarHidden: !preferences.sidebarHidden });
  }

  function selectConversation(id: string): void {
    closeDetails();
    dashboardStore.selectConversation(id);
    setProjectsOpen(false);
    projectReturnFocus.current?.focus();
  }

  async function createConversation(): Promise<void> {
    const action = state?.controlView?.actions.find((item) => item.actionId === "new_conversation");
    if (!state || !action || snapshot.pendingRequest || snapshot.connectionLost) return;
    try {
      setCommandError(undefined);
      focusNewConversation.current = true;
      await dashboardStore.submitAction(makeActionRequest(state, action, ""));
      setProjectsOpen(false);
    } catch (error) {
      focusNewConversation.current = false;
      setCommandError(error instanceof Error ? error.message : "Couldn't create a conversation.");
    }
  }

  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") {
        if (graphOpen) return;
        event.preventDefault();
        setContextOpen(false);
        closeDetails();
        setSearchOpen(!searchOpen);
        return;
      }
      if (searchOpen || contextOpen || detailsOpen || graphOpen) return;
      if (event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void createConversation();
      } else if (event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        document.getElementById("forge-message")?.focus();
      } else if (
        event.key.toLowerCase() === "b" &&
        !(
          event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, [contenteditable=true]")
        )
      ) {
        event.preventDefault();
        toggleProjects();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  function jumpToLatest(): void {
    followingLatest.current = true;
    setAwayFromLatest(false);
    setNewUpdates(false);
    const node = scrollRef.current;
    if (node)
      node.scrollTo({
        top: node.scrollHeight,
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  }

  function pauseFollowing(): void {
    followingLatest.current = false;
    const node = scrollRef.current;
    setAwayFromLatest(Boolean(node && isMeaningfullyAwayFromLatest(node)));
  }

  return (
    <main
      id="conversation"
      className={`app-shell app-shell--${surface}${!narrowLayout && preferences.sidebarHidden ? " app-shell--sidebar-hidden" : ""}`}
    >
      <a className="skip-to-composer" href="#forge-message">
        Skip to message
      </a>
      <ConversationHeader
        state={state}
        connectionLost={snapshot.connectionLost}
        projectsVisible={projectsVisible}
        onOpenProjects={toggleProjects}
        onOpenDetails={(source) => openDetails(undefined, source)}
        onOpenGraph={(source) => {
          graphReturnFocus.current = source;
          setGraphOpen(true);
        }}
        onOpenContext={(source) => {
          contextReturnFocus.current = source;
          setContextOpen(true);
        }}
      />
      {snapshot.error || commandError ? (
        <section className="connection-notice" role="status" aria-live="polite">
          <strong>Forge needs attention</strong>
          <p>{snapshot.error ?? commandError}</p>
        </section>
      ) : snapshot.connectionLost ? (
        <section className="connection-notice" role="status" aria-live="polite">
          <strong>Reconnecting to Forge…</strong>
          <p>Your conversation is saved. Live updates will resume when the bridge reconnects.</p>
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
          onSearch={() => setSearchOpen(true)}
          onNewConversation={() => void createConversation()}
          onSelect={selectConversation}
          onClose={() => {
            setProjectsOpen(false);
            projectReturnFocus.current?.focus();
          }}
        />
        <section
          className="conversation-canvas"
          aria-label="Forge project conversation"
          aria-busy={state?.agentActivities?.some((activity) => activity.running) ?? false}
        >
          <div
            className="conversation-scroll"
            ref={scrollRef}
            onPointerDown={(event) => {
              // Dragging the scrollbar is reader navigation; layout clamping is not.
              if (event.target === event.currentTarget) pauseFollowing();
            }}
            onWheelCapture={(event) => {
              if (event.deltaY < 0) pauseFollowing();
            }}
            onTouchStart={(event) => {
              touchY.current = event.touches[0]?.clientY;
            }}
            onTouchMove={(event) => {
              const y = event.touches[0]?.clientY;
              if (y !== undefined && touchY.current !== undefined && y > touchY.current)
                pauseFollowing();
              touchY.current = y;
            }}
            onKeyDownCapture={(event) => {
              if (
                ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
                (event.key === " " && event.shiftKey)
              )
                pauseFollowing();
            }}
            onClickCapture={(event) => {
              // Reading an expanded plan or tool list is explicit navigation.
              // Its resize must preserve the disclosure, not jump to its end.
              if (event.target instanceof Element && event.target.closest("summary"))
                pauseFollowing();
            }}
            onScroll={(event) => {
              const node = event.currentTarget;
              const delta = node.scrollTop - lastScrollTop.current;
              if (delta > 0 && node.scrollHeight - node.scrollTop - node.clientHeight <= 2)
                followingLatest.current = true;
              lastScrollTop.current = node.scrollTop;
              setAwayFromLatest(!followingLatest.current && isMeaningfullyAwayFromLatest(node));
              if (followingLatest.current) setNewUpdates(false);
              if (state?.selectedConversationId)
                scrollPositions.current.set(state.selectedConversationId, {
                  top: node.scrollTop,
                  following: followingLatest.current,
                });
            }}
          >
            <ConversationTimeline
              state={state}
              snapshot={snapshot}
              onLoadEarlier={() => {
                const node = scrollRef.current;
                if (node && state?.selectedConversationId && !snapshot.loadingHistoryFor) {
                  historyAnchor.current = {
                    conversationId: state.selectedConversationId,
                    top: node.scrollTop,
                    height: node.scrollHeight,
                  };
                  followingLatest.current = false;
                }
                dashboardStore.loadPreviousEvents();
              }}
            />
          </div>
          {awayFromLatest ? (
            <div className="jump-to-latest">
              <button type="button" onClick={jumpToLatest}>
                <Icon name="arrowDown" size={16} /> {newUpdates ? "New updates" : "Jump to latest"}
              </button>
            </div>
          ) : null}
          <ChatComposer
            state={state}
            snapshot={snapshot}
            onSent={(conversationId) => {
              if (conversationId && conversationId !== lastConversation.current) return;
              followingLatest.current = true;
              setAwayFromLatest(false);
              setNewUpdates(false);
              const scroller = scrollRef.current;
              if (scroller) {
                scroller.scrollTop = scroller.scrollHeight;
                lastScrollTop.current = scroller.scrollTop;
              }
            }}
          />
        </section>
      </div>
      {searchOpen ? (
        <ConversationSearch
          conversations={state?.conversations ?? []}
          drafts={snapshot.drafts}
          onSelect={selectConversation}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      <ProjectSettings
        state={state}
        open={contextOpen}
        returnFocusTo={contextReturnFocus.current}
        onClose={() => {
          setContextOpen(false);
          contextReturnFocus.current?.focus();
        }}
      />
      {graphOpen ? (
        <GameBuildWindow
          view={state?.controlView?.gameBuild}
          returnFocusTo={graphReturnFocus.current}
          onClose={() => setGraphOpen(false)}
        />
      ) : null}
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
