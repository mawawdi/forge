import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { conversationState, createDashboardApi, installDashboardApi } from "./support";

test("expanding activity and scrolling slightly upward keeps the reader in place during updates", async ({
  page,
}) => {
  const base = conversationState();
  const api = createDashboardApi(
    conversationState({
      eventPage: {
        ...base.eventPage!,
        events: Array.from({ length: 12 }, (_, i) => ({
          ...base.eventPage!.events[0]!,
          id: `request_${i}`,
          sequence: i + 1,
          data: {
            ...base.eventPage!.events[0]!.data,
            text: `Request ${i}. ${"Keep the scenery intact. ".repeat(15)}`,
          },
        })),
      },
      agentActivities: [
        {
          commentary: [],
          usage: null,
          requestSizes: null,
          jobId: "job_scroll",
          afterEventSequence: 12,
          agentRunId: "agent_scroll",
          running: true,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          currentStep: "Improving the airlock controls",
          modelTurns: 2,
          steps: Array.from({ length: 18 }, (_, i) => ({
            sequence: i + 1,
            label: `Inspected control ${i}`,
            detail: "",
            status: "complete",
          })),
        },
      ],
    }),
  );
  await installDashboardApi(page, api);
  await page.goto("/");
  const scroller = page.locator(".conversation-scroll");
  const summary = page.locator(".agent-activity__heading");
  await expect(summary).toBeVisible();
  const before = (await summary.boundingBox())!;
  await summary.click();
  await expect(page.getByText("Inspected control 0", { exact: true })).toBeVisible();
  await expect
    .poll(async () => Math.abs((await summary.boundingBox())!.y - before.y))
    .toBeLessThan(3);
  await page.getByRole("button", { name: /Jump to latest|New updates/ }).click();
  await expect
    .poll(() => scroller.evaluate((n) => n.scrollHeight - n.clientHeight - n.scrollTop))
    .toBeLessThan(3);
  await scroller.hover();
  await page.mouse.wheel(0, -100);
  await expect(page.getByRole("button", { name: /Jump to latest|New updates/ })).toBeVisible();
  const top = await scroller.evaluate((n) => n.scrollTop);
  api.state = {
    ...api.state,
    agentActivities: api.state.agentActivities!.map((activity) => ({
      ...activity,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
      steps: [
        ...activity.steps,
        {
          sequence: 19,
          label: "Drafted responsive panel",
          detail: "",
          status: "complete" as const,
        },
      ],
    })),
  };
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-update")));
  await expect(page.getByText("19 steps · 2 model requests")).toBeVisible();
  expect(Math.abs((await scroller.evaluate((n) => n.scrollTop)) - top)).toBeLessThan(3);
  const viewport = await page.evaluate(() => ({
    top: window.scrollY,
    height: window.innerHeight,
    contentHeight: document.documentElement.scrollHeight,
  }));
  const overflow = await page.evaluate(() =>
    Array.from(document.querySelectorAll("*"))
      .filter(
        (n) =>
          ["absolute", "fixed"].includes(getComputedStyle(n).position) &&
          n.getBoundingClientRect().bottom > innerHeight,
      )
      .map((n) => ({
        tag: n.tagName,
        class: n.className,
        bottom: n.getBoundingClientRect().bottom,
      })),
  );
  expect(viewport, JSON.stringify(overflow)).toEqual({
    top: 0,
    height: viewport.height,
    contentHeight: viewport.height,
  });
});

test("finds chats with the keyboard, pins them, and restores separate drafts after reload", async ({
  page,
}, info) => {
  const base = conversationState();
  const conversations = [
    base.conversations[0]!,
    { ...base.conversations[0]!, id: "conversation_02", title: "Explore the HUD" },
  ];
  const api = createDashboardApi(conversationState({ conversations }));
  await installDashboardApi(page, api);
  await page.route("**/api/control/state**", async (route) => {
    const id =
      new URL(route.request().url()).searchParams.get("conversationId") ?? "conversation_01";
    const state =
      id === "conversation_01"
        ? api.state
        : conversationState({
            conversations,
            selectedConversationId: id,
            eventPage: { conversationId: id, events: [], complete: true },
            controlView: {
              ...base.controlView!,
              conversationId: id,
              actions: [],
              turnContract: { ...base.controlView!.turnContract!, conversationId: id },
            },
          });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(state) });
  });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message Forge" });
  await composer.fill("First conversation draft");
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "Open projects" }).click();
  await page.getByRole("button", { name: "Pin Explore the HUD", exact: true }).focus();
  await page.getByRole("button", { name: "Pin Explore the HUD", exact: true }).click();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog", { name: "Find a conversation" });
  await expect(search).toBeVisible();
  await search.getByRole("combobox").fill("hud");
  await expect(search.getByRole("option")).toHaveCount(1);
  await expect(search).toHaveScreenshot(`forge-search-${info.project.name}.png`);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Explore the HUD", exact: true })).toBeVisible();
  await composer.fill("Second conversation draft");
  await page.keyboard.press("Control+k");
  await search.getByRole("combobox").fill("guarded airlock");
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("First conversation draft");
  await page.reload();
  await expect(composer).toHaveValue("First conversation draft");
  await page.keyboard.press("Control+k");
  await search.getByRole("combobox").fill("hud");
  await expect(search.getByText(/Pinned.*Draft/)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("Second conversation draft");
  expect(api.turns).toHaveLength(0);
});

test("renames projects and conversations in place without starting work or losing drafts", async ({
  page,
}, info) => {
  const api = createDashboardApi();
  await installDashboardApi(page, api);
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message Forge" });
  await composer.fill("Keep this unsent message");
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "Open projects", exact: true }).click();
  const rail = page.locator(".project-rail");
  await rail.locator(".project-group__row").hover();
  await rail.getByRole("button", { name: /^Rename project / }).click();
  await rail.getByRole("textbox", { name: "Project name" }).fill("Orbital Lab");
  await rail.getByRole("textbox", { name: "Project name" }).press("Enter");
  await expect(rail.getByRole("button", { name: "Rename project Orbital Lab" })).toBeFocused();
  await rail.locator(".project-list__item").hover();
  await rail.getByRole("button", { name: /^Rename conversation / }).click();
  const name = rail.getByRole("textbox", { name: "Conversation name" });
  await name.fill("Discard this edit");
  await name.press("Escape");
  expect(api.renames).toHaveLength(1);
  await rail.getByRole("button", { name: /^Rename conversation / }).click();
  await name.fill("Airlock controls");
  await rail.getByRole("button", { name: "Save name" }).click();
  await expect(
    rail.getByRole("button", { name: "Rename conversation Airlock controls" }),
  ).toBeFocused();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Airlock controls", exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Keep this unsent message");
  expect(api.renames).toHaveLength(2);
  expect(api.turns).toHaveLength(0);
  expect(api.actions).toHaveLength(0);
});

test("grows the compact composer to a cap, shrinks again, and keeps shortcut settings", async ({
  page,
}) => {
  const api = createDashboardApi();
  await installDashboardApi(page, api);
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message Forge" });
  await expect(page.getByLabel("Message options", { exact: true })).toHaveCount(0);
  const empty = (await composer.boundingBox())!.height;
  expect(empty).toBeLessThan(45);
  await composer.fill("A long prompt line\n".repeat(30));
  const grown = (await composer.boundingBox())!.height;
  expect(grown).toBeGreaterThan(empty);
  expect(grown).toBeLessThanOrEqual(181);
  await composer.fill("Keep this paragraph");
  expect((await composer.boundingBox())!.height).toBe(empty);
  await page.getByRole("button", { name: "Project settings", exact: true }).click();
  await page.getByRole("checkbox", { name: /Enter to send/ }).uncheck();
  await page.keyboard.press("Escape");
  await composer.focus();
  await composer.press("End");
  await composer.press("Enter");
  await composer.pressSequentially("Second paragraph");
  expect(api.turns).toHaveLength(0);
  await expect(composer).toHaveValue("Keep this paragraph\nSecond paragraph");
  await page.reload();
  await expect(composer).toHaveValue("Keep this paragraph\nSecond paragraph");
  await composer.press("Control+Enter");
  await expect.poll(() => api.turns.length).toBe(1);
  await expect(composer).toHaveValue("");
});

test("keeps older messages in place and provides a way back to the latest update", async ({
  page,
}, info) => {
  const base = conversationState();
  const api = createDashboardApi(
    conversationState({
      eventPage: {
        ...base.eventPage!,
        events: [
          ...Array.from({ length: 12 }, (_, index) => ({
            ...base.eventPage!.events[0]!,
            id: `older_${index}`,
            sequence: index + 1,
            data: {
              ...base.eventPage!.events[0]!.data,
              text: `Earlier request ${index}. ${"Keep the scenery intact. ".repeat(12)}`,
            },
          })),
          { ...base.eventPage!.events[2]!, sequence: 13 },
        ] as typeof base.eventPage.events,
      },
    }),
  );
  await installDashboardApi(page, api);
  await page.goto("/");
  const scroll = page.locator(".conversation-scroll");
  await expect(page.getByRole("heading", { name: "Suggested plan" })).toBeVisible();
  await scroll.hover();
  await page.mouse.wheel(0, -20000);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  await expect(page.getByText(/Earlier request 0\./)).toBeVisible();
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect(page.getByRole("button", { name: /Jump to latest|New updates/ })).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "Message Forge" });
  await composer.fill("Long draft line\n".repeat(12));
  await composer.fill("Short draft");
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(3);
  await scroll.hover();
  await page.mouse.wheel(0, -400);
  await expect(page.getByRole("button", { name: /Jump to latest|New updates/ })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => api.turns.length).toBe(1);
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(3);
  await expect(page.getByRole("button", { name: /Jump to latest|New updates/ })).toHaveCount(0);
  if (info.project.name !== "mobile") {
    await page.getByRole("button", { name: "Hide projects", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Projects" })).toBeHidden();
    await page.reload();
    await expect(page.getByRole("complementary", { name: "Projects" })).toBeHidden();
    await page.getByRole("button", { name: "Open projects", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Projects" })).toBeVisible();
  }
});
