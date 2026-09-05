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
  it("removes a resolved recovery instruction without hiding another session's open recording", () => {
    const recovery = event({
      id: "recovery-closed",
      sequence: 2,
      eventType: "recovery",
      binding: { sessionId: "closed-session" },
      data: {
        state: "required",
        message: "Reconnect the interrupted change.",
        studioMayContainOpenRecording: true,
      },
    });
    const finished = event({
      id: "closed-result",
      sequence: 3,
      eventType: "terminal_output",
      binding: { sessionId: "closed-session" },
      data: {
        outcome: "incomplete",
        message: "The interrupted change is closed.",
        studioHasAcceptedResult: false,
      },
    });
    const stillOpen = event({
      ...recovery,
      eventType: "recovery",
      id: "recovery-open",
      sequence: 4,
      binding: { sessionId: "open-session" },
      data: {
        state: "required",
        message: "Reconnect this other change.",
        studioMayContainOpenRecording: true,
      },
    });
    render(
      <ConversationTimeline
        state={dashboardState({
          eventPage: {
            conversationId: "conversation_01",
            events: [recovery, finished, stillOpen],
            complete: true,
          },
        })}
        snapshot={SNAPSHOT}
      />,
    );
    expect(screen.queryByText("Reconnect the interrupted change.")).not.toBeInTheDocument();
    expect(screen.getByText("The interrupted change is closed.")).toBeVisible();
    expect(screen.getByText("Reconnect this other change.")).toBeVisible();
  });

  it("keeps refresh bookkeeping and internal runtime diagnostics out of the chat", () => {
    const events = [
      event({
        id: "refresh-complete",
        eventType: "project_change",
        data: { state: "superseded", message: "No action authority was inherited." },
      }),
      event({
        id: "superseded-output",
        eventType: "terminal_output",
        data: {
          outcome: "superseded",
          message: "This result was replaced.",
          studioHasAcceptedResult: false,
        },
      }),
      event({
        id: "internal-failure",
        episodeId: "failed-episode",
        eventType: "activity",
        data: {
          job: {
            id: "failed-job",
            hash: HASH,
            artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 1 },
          },
          status: "failed",
          phase: "stopped",
          message:
            "Lower creator runtime did not reach a terminal execution-journal boundary (never_dispatched)",
        },
      }),
    ];
    render(
      <ConversationTimeline
        state={dashboardState({
          eventPage: { conversationId: "conversation_01", events, complete: true },
        })}
        snapshot={SNAPSHOT}
      />,
    );
    expect(
      screen.queryByText(/action authority|result was replaced|execution-journal/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Forge couldn't finish this request. Open Details to inspect the saved error.",
      ),
    ).toBeVisible();
  });
  it("renders an outcome once across cleanup revisions and retains identical replies in later turns", () => {
    const result = event({
      id: "first-result",
      sequence: 2,
      episodeId: "episode-1",
      binding: { sessionId: "session-1", sessionHash: HASH },
      eventType: "terminal_output",
      authority: "agent",
      data: {
        outcome: "completed",
        message: "Built **controls**.",
        studioHasAcceptedResult: false,
      },
    });
    const state = dashboardState();
    render(
      <ConversationTimeline
        snapshot={SNAPSHOT}
        state={{
          ...state,
          eventPage: {
            ...state.eventPage!,
            events: [
              result,
              {
                ...result,
                id: "cleanup-result",
                sequence: 3,
                binding: { sessionId: "session-1", sessionHash: HASH_B },
              },
              { ...result, id: "next-result", sequence: 4, episodeId: "episode-2" },
            ],
          },
        }}
      />,
    );
    expect(screen.getAllByText("controls")).toHaveLength(2);
  });
  it("keeps planning and build activity inside the conversation beside their own results", () => {
    const user = event();
    const plan = event({
      id: "plan-inline",
      sequence: 2,
      occurredAt: "2026-09-03T00:00:05.000Z",
      eventType: "plan_revision",
      data: {
        revision: 1,
        summary: "1. Connect the airlock controls.",
        planRevision: {
          id: "plan_1",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 1 },
        },
      },
    });
    const activity = {
      jobId: "planner",
      afterEventSequence: user.sequence,
      agentRunId: "run_planner",
      running: false,
      startedAt: "2026-09-02T23:59:59.900Z",
      updatedAt: "2026-09-03T00:00:05.000Z",
      currentStep: "Work finished",
      modelTurns: 1,
      usage: null,
      requestSizes: null,
      commentary: [{ sequence: 1, text: "I’ll connect the **controls** to the server." }],
      steps: [
        {
          sequence: 2,
          label: "Inspected OuterDoor",
          detail: "Workspace/Airlock/OuterDoor",
          status: "complete" as const,
        },
      ],
    };
    render(
      <ConversationTimeline
        state={dashboardState({
          eventPage: { conversationId: "conversation_01", events: [user, plan], complete: true },
          agentActivities: [
            activity,
            {
              ...activity,
              jobId: "builder",
              afterEventSequence: plan.sequence,
              agentRunId: "run_builder",
              running: true,
              startedAt: "2026-09-03T00:00:06.000Z",
              currentStep: "Connecting the airlock controls",
              commentary: [],
            },
          ],
        })}
        snapshot={SNAPSHOT}
      />,
    );
    const messages = screen.getByRole("list", { name: "Messages" });
    expect(messages.children).toHaveLength(4);
    expect(messages.children[0]).toHaveTextContent("Add a guarded airlock door.");
    expect(messages.children[1]).toHaveTextContent("Worked for 5s");
    expect(messages.children[2]).toHaveTextContent("Connect the airlock controls.");
    expect(messages.children[3]).toHaveTextContent("Connecting the airlock controls");
    expect(screen.getByText("controls", { selector: "strong" })).toBeVisible();
    expect(document.querySelectorAll(".agent-progress-text.is-scanning")).toHaveLength(1);
    expect(screen.queryByText("Work finished")).not.toBeInTheDocument();
  });

  it("shows one plan and one project notice without action bookkeeping or duplicate details buttons", () => {
    const plan = event({
      id: "plan-event",
      episodeId: "episode-1",
      eventType: "plan_revision",
      data: {
        revision: 1,
        summary: "1. Add the prompt.\n\n2. Check the door.",
        planRevision: {
          id: "plan-1",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 1 },
        },
      },
    });
    const duplicate = event({
      id: "agent-plan",
      episodeId: "episode-1",
      eventType: "agent_turn",
      data: {
        outcome: "plan_proposed",
        text: "Repeated goal",
        citations: [],
        turn: {
          id: "agent-turn",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 1 },
        },
        modelId: "openai/gpt-5.6-luna",
        responseModelId: "openai/gpt-5.6-luna",
        providerId: "openrouter",
        agentRunId: "run-1",
        timing: {
          startedAt: "2026-09-03T00:00:00.000Z",
          endedAt: "2026-09-03T00:00:01.000Z",
          durationMs: 1000,
        },
        usage: {
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        },
      },
    } as Partial<CreatorConversationEvent>);
    const decision = event({
      id: "decision-build",
      eventType: "decision",
      data: { decision: "build", actionInstanceId: "build-1" },
    });
    const notices = [1, 2, 3].map((sequence) =>
      event({
        id: `notice-${sequence}`,
        episodeId: "episode-1",
        eventType: "project_change",
        data: { state: "detected", message: "Refresh your project." },
      }),
    );
    render(
      <ConversationTimeline
        state={dashboardState({
          eventPage: {
            conversationId: "conversation_01",
            events: [duplicate, plan, decision, ...notices],
            complete: true,
          },
        })}
        snapshot={SNAPSHOT}
      />,
    );
    expect(screen.getByText("Add the prompt.")).toBeVisible();
    expect(screen.getByText("Check the door.")).toBeVisible();
    expect(screen.queryByText("Repeated goal")).not.toBeInTheDocument();
    expect(screen.getAllByText("Refresh your project.")).toHaveLength(1);
    expect(screen.queryByText(/creator recorded/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /details|citation/i })).not.toBeInTheDocument();
  });

  it("expands long messages in place and preserves their full text", () => {
    const text = `Build an airlock.\n\n${"Keep this requirement. ".repeat(100)}`;
    const message = event({ data: { ...event().data, text } } as Partial<CreatorConversationEvent>);
    render(
      <ConversationTimeline
        state={dashboardState({
          eventPage: { conversationId: "conversation_01", events: [message], complete: true },
        })}
        snapshot={SNAPSHOT}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Read full message" }));
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(document.querySelector(".message-copy p")?.textContent).toBe(text);
  });
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
      />,
    );
    expect(screen.getByRole("heading", { name: "Forge" })).toBeVisible();
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
    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} />);
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
    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} />);
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

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} />);

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
            label: "Accept plan",
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

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} />);

    expect(screen.getAllByRole("button", { name: "Accept plan" })).toHaveLength(1);
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
        summary:
          "1. Update the airlock authority.\n\nChecks\n- Validate Luau syntax.\n\nYour review\n- Try the prompt in Studio.",
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
            label: "Accept plan",
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

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} />);

    expect(screen.getByRole("heading", { name: "Suggested plan" })).toBeVisible();
    expect(screen.queryByText("Validate Luau syntax.")).not.toBeInTheDocument();
    expect(screen.queryByText("Try the prompt in Studio.")).not.toBeInTheDocument();
    expect(screen.queryByText("Try it in Studio")).not.toBeInTheDocument();
    expect(screen.getByText(/update the airlock authority/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept plan" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Don't build this" })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Review the plan" })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Messages" })).toBeVisible();
  });

  it("preserves authored creator line breaks instead of flattening the request", () => {
    const creator = {
      ...event(),
      data: { ...event().data, text: "Add the door.\nKeep the existing alarm." },
    } as CreatorConversationEvent;
    const state = dashboardState({
      eventPage: { conversationId: "conversation_01", events: [creator], complete: true },
    });
    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} />);
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
        nextBeforeCursor: "earlier-conversation",
      },
    });

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} />);

    expect(screen.queryByText("Forge is reading the project index.")).not.toBeInTheDocument();
    expect(screen.queryByText("Forge is producing a bounded plan.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Earlier messages" })).toBeVisible();
  });

  it("shows a startup failure even before an episode exists", () => {
    const { episodeId: _episodeId, ...withoutEpisode } = event();
    const failed = {
      ...withoutEpisode,
      id: "failed_start",
      eventType: "activity",
      data: {
        job: {
          id: "job_failed",
          hash: HASH,
          artifact: { locator: `artifacts/${HASH}.json`, artifactHash: HASH, bytes: 90 },
        },
        status: "failed",
        phase: "stopped",
        message: "Studio disconnected before the request started.",
      },
    } as CreatorConversationEvent;
    const state = dashboardState({
      eventPage: { conversationId: "conversation_01", events: [failed], complete: true },
    });
    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} />);
    expect(screen.getByText("Studio disconnected before the request started.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Work stopped" })).toBeVisible();
  });

  it("keeps an action on hidden activity usable without showing internal bookkeeping", () => {
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

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} />);

    expect(
      screen.queryByText("Forge is waiting for explicit creator authority."),
    ).not.toBeInTheDocument();
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
    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} />);
    expect(
      screen.queryByText(/bounded conversation context|provider intent|lower runtime/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "new_conversation" })).not.toBeInTheDocument();
  });

  it("keeps machine verification evidence out of the conversation", () => {
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

    render(<ConversationTimeline state={state} snapshot={SNAPSHOT} />);

    expect(screen.queryByText("Studio did not return one required fact.")).not.toBeInTheDocument();
    expect(state.eventPage?.events[0]).toBe(verification);
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
  return <ConversationTimeline state={state} snapshot={useDashboardSnapshot()} />;
}
