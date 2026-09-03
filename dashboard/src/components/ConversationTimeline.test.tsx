import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardStore, useDashboardSnapshot } from "../api-store";
import { ConversationTimeline } from "./ConversationTimeline";
import type { CreatorConversationEvent, CreatorDashboardState, DashboardSnapshot } from "../types";
import { HASH, HASH_B, dashboardState, event } from "../test/fixtures";

const SNAPSHOT: DashboardSnapshot = { phase: "ready", drafts: {} };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConversationTimeline", () => {
  it("labels a failed planning result without claiming it came from Studio", () => {
    const failure = event({
      eventType: "terminal_output",
      authority: "forge",
      data: {
        outcome: "incomplete",
        message: "The agent repeated a step without making progress, so work stopped.",
        studioHasAcceptedResult: false,
      },
    });
    render(
      <ConversationTimeline
        state={dashboardState({
          eventPage: { conversationId: "conversation_01", events: [failure], complete: true },
        })}
        snapshot={SNAPSHOT}
        onOpenDetails={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Work result" })).toBeVisible();
    expect(screen.getByText(/repeated a step without making progress/)).toBeVisible();
    expect(screen.queryByText("Studio result")).not.toBeInTheDocument();
  });

  it("shows an identity failure without inventing a retry when no action is authorized", () => {
    const state = dashboardState({
      selectedConversation: undefined,
      eventPage: undefined,
      controlView: {
        ...dashboardState().controlView,
        status: "recovery_required",
        title: "Project identity needs attention",
        detail: "Connection lost after dispatch. Re-pair for fresh transaction inventory.",
        actions: [],
        turnContract: undefined,
      },
    });
    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} onOpenDetails={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Project identity needs attention" })).toBeVisible();
    expect(screen.getByText(/Connection lost after dispatch/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /retry|resume/i })).not.toBeInTheDocument();
  });

  it("shows the exact rejection detail and only the coordinator-issued retry", () => {
    const state = dashboardState({
      selectedConversation: undefined,
      eventPage: undefined,
      controlView: {
        ...dashboardState().controlView,
        status: "awaiting_creator",
        title: "Studio rejected project linking",
        detail:
          "Studio command rejected: capability precondition failed. No identity effects were observed.",
        turnContract: undefined,
        actions: [
          {
            actionInstanceId: "retry_identity_1",
            actionId: "resume_work",
            label: "Retry linking",
            intent: "primary",
            controlViewId: "control_01",
            authorizingEventId: "identity_job_1",
            authorizingEventHash: HASH,
            target: "none",
            input: { kind: "none" },
          },
        ],
      },
    });
    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} onOpenDetails={vi.fn()} />);
    expect(screen.getByText(/capability precondition failed/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry linking" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Link project" })).not.toBeInTheDocument();
  });

  it("renders a coordinator-issued Link action before the conversation has an event", () => {
    const state = dashboardState({
      selectedConversationId: undefined,
      selectedConversation: undefined,
      eventPage: undefined,
      controlView: {
        ...dashboardState().controlView,
        conversationId: "pairing_project_01",
        conversationHash: HASH,
        eventSequence: 0,
        title: "Link this project",
        detail: "Linking records a visible Studio identity change before work begins.",
        turnContract: undefined,
        actions: [
          {
            actionInstanceId: "action_link",
            actionId: "link_project",
            label: "Link project",
            intent: "primary",
            controlViewId: "control_01",
            authorizingEventId: "project_identity_01",
            authorizingEventHash: HASH_B,
            target: "none",
            input: { kind: "none" },
          },
        ],
      },
    }) as CreatorDashboardState;

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} onOpenDetails={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Link this project" })).toBeVisible();
    expect(screen.getByText(/visible Studio identity change/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Link project" })).toBeVisible();
  });

  it("does not duplicate an action whose exact authorizing event is loaded", () => {
    const creator = event();
    const state = dashboardState({
      eventPage: { conversationId: "conversation_01", events: [creator], complete: true },
      controlView: {
        ...dashboardState().controlView,
        title: "Current work",
        detail: "Only the event-bound control should render.",
        actions: [
          {
            actionInstanceId: "action_current",
            actionId: "build_plan",
            label: "Build this",
            intent: "primary",
            controlViewId: "control_01",
            authorizingEventId: creator.id,
            authorizingEventHash: creator.hash,
            target: "none",
            input: { kind: "none" },
          },
        ],
      },
    }) as CreatorDashboardState;

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} onOpenDetails={vi.fn()} />);

    expect(screen.getAllByRole("button", { name: "Build this" })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Current work" })).not.toBeInTheDocument();
  });

  it("keeps event-bound actions on their event and surfaces another current authority once", () => {
    const plan = {
      ...event(),
      id: "event_plan",
      hash: HASH_B,
      authority: "agent",
      eventType: "plan_revision",
      data: {
        planRevision: {
          id: "plan_01",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
        },
        revision: 2,
        summary: "Forge will update the airlock authority and check the prompt in Studio.",
      },
    } as CreatorConversationEvent;
    const state = dashboardState({
      eventPage: { conversationId: "conversation_01", events: [plan], complete: true },
      controlView: {
        ...dashboardState().controlView,
        actions: [
          {
            actionInstanceId: "action_build",
            actionId: "build_plan",
            label: "Build this",
            intent: "primary",
            controlViewId: "control_01",
            authorizingEventId: "event_plan",
            authorizingEventHash: HASH_B,
            target: "none",
            input: { kind: "none" },
          },
          {
            actionInstanceId: "action_not_here",
            actionId: "reject_plan",
            label: "Don't build this",
            intent: "danger",
            controlViewId: "control_01",
            authorizingEventId: "some_other_event",
            authorizingEventHash: HASH,
            target: "none",
            input: { kind: "none" },
          },
        ],
      },
    }) as CreatorDashboardState;

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} onOpenDetails={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Suggested plan" })).toBeVisible();
    expect(screen.getByText(/update the airlock authority/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Build this" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Don't build this" })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Review the plan" })).toBeVisible();
    expect(screen.getByRole("list")).toBeVisible();
  });

  it("preserves authored creator line breaks instead of flattening the request", () => {
    const creator = {
      ...event(),
      data: { ...event().data, text: "Add the door.\nKeep the existing alarm." },
    } as CreatorConversationEvent;
    const state = dashboardState({
      eventPage: { conversationId: "conversation_01", events: [creator], complete: true },
    });
    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} onOpenDetails={vi.fn()} />);
    expect(
      screen.getByText(
        (_content, node) =>
          node?.tagName === "P" && node.textContent === "Add the door.\nKeep the existing alarm.",
      ),
    ).toBeVisible();
  });

  it("folds durable activity boundaries into the latest card for each job", () => {
    const job = {
      id: "job_01",
      hash: HASH,
      artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
    };
    const reading = {
      ...event(),
      id: "activity_reading",
      eventType: "activity",
      authority: "forge",
      data: {
        job,
        status: "running",
        phase: "Reading project",
        message: "Forge is reading the project index.",
      },
    } as CreatorConversationEvent;
    const planning = {
      ...reading,
      id: "activity_planning",
      hash: HASH_B,
      sequence: 2,
      data: {
        ...reading.data,
        phase: "Planning",
        message: "Forge is producing a bounded plan.",
      },
    } as CreatorConversationEvent;
    const state = dashboardState({
      eventPage: {
        conversationId: "conversation_01",
        events: [reading, planning],
        complete: true,
      },
    });

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} onOpenDetails={vi.fn()} />);

    expect(screen.queryByText("Forge is reading the project index.")).not.toBeInTheDocument();
    expect(screen.queryByText("Forge is producing a bounded plan.")).not.toBeInTheDocument();
  });

  it("never folds away the exact activity event that authorizes a current action", () => {
    const job = {
      id: "job_01",
      hash: HASH,
      artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
    };
    const resumable = {
      ...event(),
      id: "activity_resumable",
      eventType: "activity",
      authority: "forge",
      data: {
        job,
        status: "awaiting_external",
        phase: "Paused",
        message: "Forge is waiting for explicit creator authority.",
      },
    } as CreatorConversationEvent;
    const later = {
      ...resumable,
      id: "activity_later",
      hash: HASH_B,
      sequence: 2,
      data: {
        ...resumable.data,
        phase: "Recovered",
        message: "Forge reconstructed the durable job state.",
      },
    } as CreatorConversationEvent;
    const state = dashboardState({
      eventPage: {
        conversationId: "conversation_01",
        events: [resumable, later],
        complete: true,
      },
      controlView: {
        ...dashboardState().controlView!,
        actions: [
          {
            actionInstanceId: "action_resume",
            actionId: "resume_work",
            label: "Resume work",
            intent: "primary",
            controlViewId: "control_01",
            authorizingEventId: resumable.id,
            authorizingEventHash: resumable.hash,
            target: "none",
            input: { kind: "none" },
          },
        ],
      },
    });

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} onOpenDetails={vi.fn()} />);

    expect(screen.getByText("Forge is waiting for explicit creator authority.")).toBeVisible();
    expect(
      screen.queryByText("Forge reconstructed the durable job state."),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Resume work" })).toHaveLength(1);
  });

  it("keeps project settings and navigation authorities from exposing internal running events", () => {
    const internal = event({
      id: "activity_context",
      eventType: "activity",
      authority: "forge",
      data: {
        job: {
          id: "job_context",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 100 },
        },
        status: "running",
        phase: "context_persisted",
        message:
          "The bounded conversation context is durable; provider intent is journaled only by the lower runtime.",
      },
    });
    const state = dashboardState({
      eventPage: { conversationId: "conversation_01", events: [event(), internal], complete: true },
      controlView: {
        ...dashboardState().controlView!,
        status: "working",
        actions: ["remember", "fork_project", "new_conversation"].map((actionId) => ({
          actionId: actionId as "remember" | "fork_project" | "new_conversation",
          actionInstanceId: `action_${actionId}`,
          label: actionId,
          intent: "secondary" as const,
          controlViewId: "control_01",
          authorizingEventId: internal.id,
          authorizingEventHash: internal.hash,
          target: "none" as const,
          input: { kind: "none" as const },
        })),
      },
    });
    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} onOpenDetails={vi.fn()} />);
    expect(
      screen.queryByText(/bounded conversation context|provider intent|lower runtime/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "new_conversation" })).not.toBeInTheDocument();
  });

  it("visually marks incomplete verification as evidence requiring attention", () => {
    const verification = {
      ...event(),
      authority: "forge",
      eventType: "verification",
      data: {
        verification: {
          id: "verification_01",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
        },
        status: "incomplete",
        failureFacts: [{ statement: "Studio did not return one required fact.", hash: HASH_B }],
      },
    } as CreatorConversationEvent;
    const state = dashboardState({
      eventPage: {
        conversationId: "conversation_01",
        events: [verification],
        complete: true,
      },
    });

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} onOpenDetails={vi.fn()} />);

    const card = screen
      .getByRole("heading", { name: "Forge couldn't confirm everything" })
      .closest("article");
    expect(card).toHaveClass("conversation-event--sheet", "conversation-event--attention");
    expect(screen.getByText("Studio did not return one required fact.")).toBeVisible();
  });

  it("shares one report across keep and undo and retains it until admission resolves", async () => {
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const submit = vi.spyOn(dashboardStore, "submitAction").mockReturnValue(admitted);
    const review = {
      ...event(),
      id: "event_review",
      hash: HASH_B,
      authority: "forge",
      eventType: "final_review",
      data: { state: "requested", message: "Tell Forge what you observed." },
    } as CreatorConversationEvent;
    const report = {
      kind: "text" as const,
      field: "report" as const,
      label: "What did you observe?",
      minimumBytes: 1,
      maximumBytes: 4096,
      multiline: true,
    };
    const state = dashboardState({
      eventPage: { conversationId: "conversation_01", events: [review], complete: true },
      controlView: {
        ...dashboardState().controlView,
        actions: [
          {
            actionInstanceId: "action_keep",
            actionId: "keep_changes",
            label: "Keep changes",
            intent: "primary",
            controlViewId: "control_01",
            authorizingEventId: review.id,
            authorizingEventHash: review.hash,
            target: "none",
            input: report,
          },
          {
            actionInstanceId: "action_undo",
            actionId: "undo_changes",
            label: "Undo changes",
            intent: "danger",
            controlViewId: "control_01",
            authorizingEventId: review.id,
            authorizingEventHash: review.hash,
            target: "none",
            input: report,
          },
        ],
      },
    }) as CreatorDashboardState;

    render(<StoredTimeline state={state} />);

    const field = screen.getByLabelText(/What did you observe/);
    fireEvent.change(field, {
      target: { value: "The warning felt clear and the door stayed safe." },
    });
    expect(screen.getAllByLabelText(/What did you observe/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep changes" }));

    expect(field).toHaveValue("The warning felt clear and the door stayed safe.");
    admit();
    await waitFor(() => expect(field).toHaveValue(""));
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ actionInstanceId: "action_keep" });
  });
});

function StoredTimeline({ state }: { readonly state: CreatorDashboardState }): React.JSX.Element {
  return (
    <ConversationTimeline state={state} snapshot={useDashboardSnapshot()} onOpenDetails={vi.fn()} />
  );
}
