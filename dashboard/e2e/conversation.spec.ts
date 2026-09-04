import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { conversationState, createDashboardApi, installDashboardApi } from "./support";
import type {
  CreatorControlActionDescriptor,
  CreatorControlInputRequirement,
  CreatorConversationEvent,
  CreatorDashboardState,
} from "../src/types";

const HASHES = ["d", "e", "f", "1", "2", "3", "4", "5", "6", "7"] as const;

function conversationEvent(
  sequence: number,
  eventType: CreatorConversationEvent["eventType"],
  authority: CreatorConversationEvent["authority"],
  data: CreatorConversationEvent["data"],
): CreatorConversationEvent {
  const base = conversationState().eventPage!.events[0];
  const hash = HASHES[(sequence - 4) % HASHES.length]!.repeat(64);
  return {
    ...base,
    id: `event_${eventType}_${sequence}`,
    hash,
    sequence,
    occurredAt: `2026-09-03T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    authority,
    eventType,
    data,
  } as CreatorConversationEvent;
}

function actionFor(
  event: CreatorConversationEvent,
  actionId: CreatorControlActionDescriptor["actionId"],
  label: string,
  intent: CreatorControlActionDescriptor["intent"] = "primary",
  input: CreatorControlInputRequirement = { kind: "none" },
): CreatorControlActionDescriptor {
  return {
    actionInstanceId: `action_${actionId}`,
    actionId,
    label,
    intent,
    controlViewId: "control_01",
    authorizingEventId: event.id,
    authorizingEventHash: event.hash,
    target: "none",
    input,
  };
}

function stateWithEvents(
  additions: readonly CreatorConversationEvent[],
  actions: readonly CreatorControlActionDescriptor[],
  title: string,
  status: NonNullable<CreatorDashboardState["controlView"]>["status"] = "awaiting_creator",
): CreatorDashboardState {
  const base = conversationState();
  const events = [...base.eventPage!.events, ...additions];
  return conversationState({
    conversations: base.conversations.map((conversation) => ({
      ...conversation,
      status,
      latestEventSequence: events.at(-1)!.sequence,
    })),
    eventPage: {
      conversationId: "conversation_01",
      events,
      complete: true,
    },
    controlView: {
      ...base.controlView!,
      eventSequence: events.at(-1)!.sequence,
      status,
      title,
      detail: `Current creator authority: ${title}.`,
      actions,
    },
  });
}

test.describe("Forge workspace project conversation", () => {
  test("preserves the conversation and draft while reconnecting live updates", async ({ page }) => {
    const api = createDashboardApi();
    await installDashboardApi(page, api);
    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Message Forge" });
    await composer.fill("Keep this draft.");
    await page.evaluate(() => window.dispatchEvent(new Event("fixture-disconnect")));
    await expect(page.getByText("Reconnecting to Forge…", { exact: true })).toBeVisible();
    await expect(page.getByText("Studio ready", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await expect(page.getByRole("heading", { name: "Suggested plan" })).toBeVisible();
    await expect(composer).toHaveValue("Keep this draft.");
    await page.evaluate(() => window.dispatchEvent(new Event("fixture-reconnect")));
    await expect(page.getByText("Reconnecting to Forge…", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Studio ready", { exact: true })).toHaveCount(1);
    await expect(composer).toHaveValue("Keep this draft.");
  });

  test("opens project preferences on demand and keeps separate chats under their project", async ({
    page,
  }, testInfo) => {
    const base = conversationState();
    const api = createDashboardApi(
      conversationState({
        conversations: [
          ...base.conversations,
          {
            ...base.conversations[0]!,
            id: "conversation_02",
            title: "Explore the HUD",
            episodeCount: 0,
          },
        ],
        projectSettings: {
          controlView: {
            ...base.controlView!,
            actions: [
              actionFor(base.eventPage!.events[0]!, "remember", "Save preference", "primary", {
                kind: "text",
                field: "memory",
                label: "Add a preference",
                minimumBytes: 1,
                maximumBytes: 16384,
                multiline: true,
              }),
            ],
          },
          memories: [
            {
              itemId: "memory_01",
              revisionId: "memory_revision_01",
              revisionHash: "f".repeat(64),
              category: "preference",
              text: "Keep gameplay logic on the server.",
              pinned: false,
              state: "active",
            },
          ],
        },
      }),
    );
    await installDashboardApi(page, api);
    await page.goto("/");
    await expect(page.getByRole("dialog", { name: "Project settings" })).toHaveCount(0);
    await expect(page.getByText("Keep gameplay logic on the server.")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Message type" })).toHaveCount(0);
    const settings = page.getByRole("button", { name: "Project settings", exact: true });
    await settings.click();
    const dialog = page.getByRole("dialog", { name: "Project settings" });
    await expect(dialog.getByText("Keep gameplay logic on the server.")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Add a preference" })).toBeVisible();
    await expect(dialog).toHaveScreenshot(`forge-settings-${testInfo.project.name}.png`);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
    if (testInfo.project.name === "mobile")
      await page.getByRole("button", { name: "Open projects" }).click();
    await expect(
      page
        .getByRole("list", { name: "Conversations in Orbital Freight Airlock" })
        .locator(".project-row"),
    ).toHaveCount(2);

    await page.route("**/api/control/action", async (route) => {
      const request = route.request().postDataJSON();
      expect(request.actionInstanceId).toBe("action_new_conversation");
      api.state = conversationState({
        ...api.state,
        conversations: [
          ...api.state.conversations,
          {
            ...base.conversations[0]!,
            id: "conversation_new",
            title: "New conversation",
            latestEventSequence: 0,
            episodeCount: 0,
          },
        ],
        selectedConversationId: "conversation_new",
        eventPage: { conversationId: "conversation_new", events: [], complete: true },
        controlView: {
          ...base.controlView!,
          conversationId: "conversation_new",
          actions: [],
          turnContract: { ...base.controlView!.turnContract!, conversationId: "conversation_new" },
        },
      });
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          kind: "CreatorWorkAdmission",
          jobId: "job_new_conversation",
          conversationId: "conversation_new",
          acceptedAt: "2026-09-03T00:00:01.000Z",
        }),
      });
    });
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What do you want to make?" })).toBeVisible();
    await expect(page.getByText("Add a guarded airlock door.", { exact: true })).toHaveCount(0);
    expect(api.turns).toHaveLength(0);
    await expect(page.locator("main")).toHaveScreenshot(
      `forge-new-conversation-${testInfo.project.name}.png`,
    );
  });

  test("shows recorded agent steps while keeping the next message editable", async ({
    page,
  }, testInfo) => {
    await page.clock.setFixedTime(new Date("2026-09-03T00:00:38.000Z"));
    const base = conversationState();
    const api = createDashboardApi(
      conversationState({
        eventPage: {
          conversationId: "conversation_01",
          events: [
            base.eventPage!.events[0]!,
            conversationEvent(4, "activity", "forge", {
              job: {
                id: "job_01",
                hash: "e".repeat(64),
                artifact: {
                  locator: `artifacts/${"e".repeat(64)}.json`,
                  artifactHash: "e".repeat(64),
                  bytes: 90,
                },
              },
              status: "running",
              phase: "context_persisted",
              message: "Reading the saved project context.",
            }),
          ],
          complete: true,
        },
        controlView: {
          ...base.controlView!,
          status: "working",
          actions: [],
          turnContract: undefined,
        },
        agentActivities: [
          {
            commentary: [],
            usage: null,
            requestSizes: null,
            jobId: "job_01",
            afterEventSequence: 1,
            agentRunId: "agent_run_01",
            running: true,
            startedAt: "2026-09-03T00:00:00.000Z",
            updatedAt: "2026-09-03T00:00:37.000Z",
            currentStep: "Checking that reset cancels the door animation",
            modelTurns: 2,
            steps: [
              {
                sequence: 1,
                label: "Explored Workspace",
                detail: "Workspace",
                status: "complete",
              },
              {
                sequence: 2,
                label: "Searched for AirlockController",
                detail: "AirlockController",
                status: "complete",
              },
              {
                sequence: 3,
                label: "Read AirlockController",
                detail: "ServerScriptService/AirlockController",
                status: "complete",
              },
            ],
          },
        ],
      }),
    );
    await installDashboardApi(page, api);
    await page.goto("/");
    const activity = page.getByRole("region", { name: "Agent activity" });
    await expect(
      activity.getByText("Checking that reset cancels the door animation"),
    ).toBeVisible();
    await expect(activity.locator(".agent-progress-text")).toHaveCSS(
      "animation-name",
      "progress-scan",
    );
    await expect(
      page.getByRole("list", { name: "Messages" }).getByRole("region", { name: "Agent activity" }),
    ).toHaveCount(1);
    await expect(activity.getByText("ServerScriptService.AirlockController")).toBeHidden();
    await activity.locator(".agent-activity__heading").click();
    await expect(activity.getByText("ServerScriptService.AirlockController")).toBeHidden();
    await activity.locator(".agent-step > summary").last().click();
    await expect(
      activity.locator(".agent-activity__panel").getByText("ServerScriptService.AirlockController"),
    ).toBeVisible();
    await expect(activity.getByRole("listitem").first()).toContainText("Explored Workspace");
    await expect(activity.getByRole("listitem").last()).toContainText("Read AirlockController");
    await expect(page.locator("main")).toHaveScreenshot(
      `forge-activity-expanded-${testInfo.project.name}.png`,
    );
    await page.keyboard.press("Escape");
    await expect(activity.getByText("ServerScriptService.AirlockController")).toBeHidden();
    await page
      .getByRole("textbox", { name: "Message Forge" })
      .fill("Keep the original warning light.");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await expect(page.locator("main")).toHaveScreenshot(
      `forge-working-${testInfo.project.name}.png`,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(api.turns).toHaveLength(0);
    await expect(page.getByRole("button", { name: "Open details", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Open details", exact: true }).click();
    const details = page.getByRole("dialog", { name: /Technical details/ });
    await details
      .getByRole("combobox", { name: "Inspect", exact: true })
      .selectOption("event_activity_4");
    await expect(details.getByText("Work record", { exact: true })).toBeVisible();
    await expect(details.getByText("Reading the saved project context.")).toBeVisible();
  });

  test("presents a complete, keyboard-accessible conversation at each supported layout", async ({
    page,
  }, testInfo) => {
    const api = createDashboardApi();
    await installDashboardApi(page, api);
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Suggested plan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept plan", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Forge" })).toBeVisible();
    await expect(page.locator("main")).toHaveScreenshot(
      `forge-workspace-${testInfo.project.name}.png`,
      { fullPage: true },
    );

    const scan = await new AxeBuilder({ page }).analyze();
    expect(scan.violations).toEqual([]);

    const undersizedTargets = await page
      .locator("button:visible, a[href]:visible, input:visible, select:visible, textarea:visible")
      .evaluateAll((elements) =>
        elements.flatMap((element) => {
          const rectangle = element.getBoundingClientRect();
          // Dense pointer controls; larger touch targets on coarse-pointer devices.
          const minimum = matchMedia("(pointer: coarse)").matches ? 44 : 24;
          return rectangle.width < minimum || rectangle.height < minimum
            ? [
                {
                  label:
                    element.getAttribute("aria-label") ??
                    element.textContent?.trim() ??
                    element.tagName,
                  width: rectangle.width,
                  height: rectangle.height,
                },
              ]
            : [];
        }),
      );
    expect(undersizedTargets).toEqual([]);
    if (testInfo.project.name !== "mobile")
      await expect(page.locator(".studio-indicator", { hasText: "Studio ready" })).toBeVisible();
  });

  test("keeps first-run identity authority usable before any transcript event exists", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "One first-run proof is sufficient.");
    const base = conversationState();
    const api = createDashboardApi(
      conversationState({
        eventPage: { conversationId: "conversation_01", events: [], complete: true },
        controlView: {
          ...base.controlView!,
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
              authorizingEventId: "project_identity_pending",
              authorizingEventHash: "d".repeat(64),
              target: "none",
              input: { kind: "none" },
            },
          ],
        },
      }),
    );
    await installDashboardApi(page, api);
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Link this project" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What do you want to make?" })).toHaveCount(0);
    await page.getByRole("button", { name: "Link project" }).click();
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ actionInstanceId: "action_link" });
  });

  test("accepts a plan once, completes with model Markdown, and continues the same conversation", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "One end-to-end authority proof is sufficient.");
    const api = createDashboardApi();
    await installDashboardApi(page, api);
    await page.goto("/");

    await page.getByRole("button", { name: "Change plan", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Accept plan", exact: true }).locator("svg"),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Reject plan", exact: true }).locator("svg"),
    ).toHaveCount(1);
    await page.getByLabel("What should change?").fill("Keep the warning light amber.");
    await page.getByRole("button", { name: "Update plan" }).click();
    expect(api.actions.at(-1)).toMatchObject({
      actionInstanceId: "action_revise",
      input: { text: "Keep the warning light amber." },
    });

    await page.reload();
    await page.getByRole("button", { name: "Accept plan", exact: true }).click();
    expect(api.actions.at(-1)).toMatchObject({ actionInstanceId: "action_build" });
    const mutation = conversationEvent(4, "mutation", "studio", {
      attemptId: "mutation_attempt_01",
      attemptHash: "e".repeat(64),
      status: "committed",
      message: "Studio readback matched the exact approved change.",
    });
    const terminal = conversationEvent(5, "terminal_output", "agent", {
      outcome: "completed",
      message:
        "Built the **airlock controls**.\n\n- Server validates each request.\n- Try the controls whenever you are ready.",
      studioHasAcceptedResult: false,
    });
    api.state = stateWithEvents([mutation, terminal], [], "Finished", "terminal");
    await page.reload();
    await expect(page.locator("strong").filter({ hasText: "airlock controls" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Apply changes|Keep changes|Try the test again/ }),
    ).toHaveCount(0);
    await expect(page.getByText("Studio readback matched the exact approved change.")).toHaveCount(
      0,
    );
    await expect(
      page.getByText(/Waiting for Play|Watching your test|What did you observe/),
    ).toHaveCount(0);
    await page.getByRole("textbox", { name: "Message Forge" }).fill("Now explain the alarm path.");
    await page.getByRole("button", { name: "Send" }).click();
    expect(api.turns.at(-1)).toMatchObject({ text: "Now explain the alarm path." });
  });

  test("presents project refresh, recovery, and source-sync authority", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "One blocked-state proof is sufficient.");
    const api = createDashboardApi();
    await installDashboardApi(page, api);

    const changed = conversationEvent(4, "project_change", "studio", {
      state: "detected",
      message: "Studio changed after this plan was produced.",
    });
    api.state = stateWithEvents(
      [changed],
      [actionFor(changed, "refresh_project", "Refresh project")],
      "Project changed",
      "blocked",
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Forge noticed a project edit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh project" })).toBeVisible();

    const recovery = conversationEvent(4, "recovery", "forge", {
      state: "available",
      message: "Studio proves the exact provisional recording is still open.",
      studioMayContainOpenRecording: true,
    });
    api.state = stateWithEvents(
      [recovery],
      [actionFor(recovery, "cancel_recovery", "Cancel interrupted recording", "danger")],
      "Recovery required",
      "recovery_required",
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: /Reconnect Studio/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel interrupted recording" })).toBeVisible();

    const sync = conversationEvent(4, "source_sync", "forge", {
      status: "awaiting",
      message: "Filesystem source changed; Forge is waiting for exact Studio synchronization.",
    });
    api.state = stateWithEvents(
      [sync],
      [
        actionFor(sync, "check_source_sync", "Check Studio sync"),
        actionFor(sync, "revert_source_changes", "Revert source changes", "danger"),
      ],
      "Awaiting source sync",
      "blocked",
    );
    await page.reload();
    await expect(page.getByText(/waiting for exact Studio synchronization/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Check Studio sync" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Revert source changes" })).toBeVisible();
  });

  test("keeps hidden tablet drawers out of the tab order and restores the invoking focus", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "The sidebar becomes a drawer on mobile.");
    await installDashboardApi(page, createDashboardApi());
    await page.goto("/");

    const projectDrawer = page.locator(".project-rail");
    await expect(projectDrawer).toHaveAttribute("aria-hidden", "true");
    await expect(projectDrawer).toHaveAttribute("inert", "");
    const projects = page.getByRole("button", { name: "Open projects" });
    await expect(projects).toBeVisible();
    await projects.click();
    await expect(projectDrawer).not.toHaveAttribute("inert", "");
    const closeProjects = page.getByRole("button", { name: "Close projects" });
    await expect(closeProjects).toBeFocused();
    await closeProjects.click();
    await expect(projects).toBeFocused();

    const context = page.getByRole("button", { name: "Project settings" });
    await context.click();
    const closeContext = page.getByRole("button", { name: "Close project settings" });
    await expect(closeContext).toBeFocused();
    await closeContext.click();
    await expect(context).toBeFocused();
  });

  test("returns focus from technical evidence and traps keyboard navigation inside the sheet", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "One desktop interaction proof is sufficient.");
    await installDashboardApi(page, createDashboardApi());
    await page.goto("/");

    const trigger = page.getByRole("button", { name: "Open details", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: /technical details/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    const close = dialog.getByRole("button", { name: "Close details" });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Inspect API coverage" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });

  test("keeps source, catalog, and replay inspection inside the lazy technical sheet", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "One desktop technical-inspection proof is sufficient.",
    );
    const api = createDashboardApi();
    await installDashboardApi(page, api);
    await page.goto("/");

    await page.getByRole("button", { name: "Open details", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /technical details/i });
    await dialog
      .getByRole("combobox", { name: "Inspect", exact: true })
      .selectOption("event_answer");
    await dialog.getByRole("button", { name: "Replay verification" }).click();
    await expect(dialog.getByText(/"status": "exact"/)).toBeVisible();
    await dialog.getByRole("button", { name: "List project source" }).click();
    await dialog.getByRole("button", { name: /ServerScriptService\/Airlock\.server\.lua/ }).click();
    await expect(dialog.getByText("local Airlock = {}\nreturn Airlock")).toBeVisible();
    const dependencyButton = dialog.getByRole("button", { name: "Inspect dependencies" });
    await dependencyButton.click();
    await expect(
      dialog.getByText(/Airlock\.server\.lua → ReplicatedStorage\/AirlockConfig/),
    ).toBeVisible();

    const coverageButton = dialog.getByRole("button", { name: "Load API coverage" });
    await dialog
      .locator(".technical-details-sheet__body")
      .evaluate((body) => body.scrollTo({ top: body.scrollHeight }));
    await coverageButton.click();
    await expect(dialog.getByText("9,685")).toBeVisible();
    expect(api.replays).toEqual([{ kind: "verification", id: "verification_01" }]);
  });

  test("does not lose a typed draft or loaded conversation when history is unavailable", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "One outage proof is sufficient.");
    const api = createDashboardApi();
    api.historyFailure = {
      status: 503,
      detail: "The local history reader is temporarily unavailable.",
    };
    await installDashboardApi(page, api);
    await page.goto("/");

    const composer = page.getByRole("textbox", { name: "Message Forge" });
    await composer.fill("Keep this unsent design note while Forge reconnects.");
    await page.getByRole("button", { name: "Earlier messages" }).click();

    await expect(
      page.getByRole("status").filter({ hasText: "Forge needs attention" }),
    ).toBeVisible();
    await expect(composer).toHaveValue("Keep this unsent design note while Forge reconnects.");
    await expect(page.getByRole("heading", { name: "Suggested plan" })).toBeVisible();
  });

  test("posts only the current hash-bound action and visibly waits for its 202 admission", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "One admission proof is sufficient.");
    let release!: () => void;
    const api = createDashboardApi();
    api.actionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await installDashboardApi(page, api);
    await page.goto("/");

    const action = page.getByRole("button", { name: "Accept plan", exact: true });
    await action.click();
    await expect(page.locator(".event-actions button").first()).toBeDisabled();
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({
      viewId: "control_01",
      actionInstanceId: "action_build",
    });
    release();
    await expect(action).toBeEnabled();
  });

  test("uses the reduced-motion contract and reflows at an effective 200% zoom", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Zoom proof uses the desktop baseline.");
    await page.clock.setFixedTime(new Date("2026-09-03T00:00:38.000Z"));
    const state = conversationState({
      agentActivities: [
        {
          commentary: [],
          usage: null,
          requestSizes: null,
          jobId: "job_01",
          afterEventSequence: 1,
          agentRunId: "agent_run_01",
          running: true,
          startedAt: "2026-09-03T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:01.000Z",
          currentStep: "Reading the project",
          modelTurns: 1,
          steps: [
            {
              sequence: 1,
              label: "Inspected Airlock",
              detail: "Workspace/Airlock",
              status: "complete",
            },
          ],
        },
      ],
      eventPage: {
        ...conversationState().eventPage,
        events: [
          ...conversationState().eventPage!.events,
          {
            ...conversationState().eventPage!.events.at(-1)!,
            id: "event_activity",
            hash: "d".repeat(64),
            sequence: 4,
            authority: "forge",
            eventType: "activity",
            data: {
              job: {
                id: "job_01",
                hash: "e".repeat(64),
                artifact: {
                  locator: `artifacts/${"e".repeat(64)}.json`,
                  artifactHash: "e".repeat(64),
                  bytes: 90,
                },
              },
              status: "running",
              phase: "Reading project",
              message: "Forge is reading the bounded project index.",
            },
          },
        ],
      },
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installDashboardApi(page, createDashboardApi(state));
    await page.goto("/");
    await expect(page.locator(".agent-progress-text")).toHaveCSS("animation-name", "none");

    // A 720px CSS viewport is the effective viewport of a 1440px desktop at
    // 200% browser zoom. It verifies actual reflow rather than device pixels.
    await page.setViewportSize({ width: 720, height: 1000 });
    expect(
      await page
        .locator(".chat-composer__controls")
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
    ).toBe(1);
    expect(
      await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect(page.locator("main")).toHaveScreenshot("forge-workspace-zoom-200.png", {
      fullPage: true,
    });
  });
});
