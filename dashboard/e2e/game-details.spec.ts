import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { GRAPH_VIEW } from "../src/test/game-build-fixture";
import { conversationState, createDashboardApi, installDashboardApi } from "./support";

const ARTIFACT_HASH = "e".repeat(64);
const LONG_LABEL = `Saved world design — ${"InterconnectedSystems".repeat(10)}`;

test("saved game maps open directly from inspected details, preserve nested keyboard focus, and wrap long labels", async ({
  page,
}, testInfo) => {
  const state = conversationState();
  const api = createDashboardApi({
    ...state,
    controlView: {
      ...state.controlView!,
      gameBuild: GRAPH_VIEW,
      technicalAttachments: [
        {
          role: "technical_detail",
          label: LONG_LABEL,
          binding: {
            id: "saved_game_map_fixture",
            hash: ARTIFACT_HASH,
            artifact: {
              locator: `artifacts/${ARTIFACT_HASH}.json`,
              artifactHash: ARTIFACT_HASH,
              bytes: 100,
            },
          },
        },
      ],
    },
  });
  await installDashboardApi(page, api);
  let artifactReads = 0;
  await page.route(`**/api/artifacts/${ARTIFACT_HASH}`, async (route) => {
    artifactReads++;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ gameBuild: GRAPH_VIEW }),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("New conversation");
  const detailsOpener = page.getByRole("button", { name: "Open details", exact: true });
  await detailsOpener.focus();
  await page.keyboard.press("Enter");
  const details = page.getByRole("dialog", { name: /Technical details/i });
  const closeDetails = details.getByRole("button", { name: "Close details", exact: true });
  await expect(closeDetails).toBeFocused();
  const currentImplementation = details
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Current build implementation" }) });
  await currentImplementation.locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await expect(currentImplementation).toHaveJSProperty("open", false);
  await expect(
    currentImplementation.getByRole("region", { name: "Current build implementation" }),
  ).toBeHidden();

  const attachment = details.locator(".attachment-list li").filter({ hasText: LONG_LABEL });
  await expect(attachment.getByText(LONG_LABEL, { exact: true })).toBeVisible();
  const inspect = attachment.getByRole("button", { name: "Inspect", exact: true });
  await inspect.focus();
  await page.keyboard.press("Enter");
  const card = details.locator(".saved-detail-card");
  const mapOpener = card.getByRole("button", { name: "Open saved game map" });
  await expect(mapOpener).toBeVisible();
  await expect(mapOpener.getByText("Shared workshop", { exact: true })).toBeVisible();
  const rawJson = card
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Raw JSON" }) });
  const savedImplementation = card
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Saved build implementation" }) });
  await expect(rawJson).toHaveJSProperty("open", false);
  await expect(rawJson.locator("pre")).toBeHidden();
  await expect(savedImplementation).toHaveJSProperty("open", false);
  await expect(card.getByRole("status")).toHaveText("Saved details loaded.");
  expect(artifactReads).toBe(1);

  // Both the list and the opened card must reflow unbroken creator-authored labels.
  for (const container of [attachment, card, details.locator(".technical-details-sheet__body")]) {
    expect(
      await container.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  }
  expect(
    await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth + 1),
  ).toBe(true);
  await mapOpener.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("saved-map-card.png"),
    animations: "disabled",
    fullPage: true,
  });

  // Native nested modal Escape dismisses only the map and restores its exact opener.
  await mapOpener.focus();
  await page.keyboard.press("Enter");
  const map = page.getByRole("dialog", { name: "Shared workshop", exact: true });
  await expect(map).toBeVisible();
  await expect(map.getByText("Saved map", { exact: true })).toBeVisible();
  await expect(map.getByRole("button", { name: "Close game map" })).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("nested-saved-map.png"),
    animations: "disabled",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(map).toHaveCount(0);
  await expect(details).toBeVisible();
  await expect(mapOpener).toBeFocused();

  // Summaries are actual tab stops; collapsed graph controls and JSON must not steal focus.
  const rawSummary = rawJson.locator(":scope > summary");
  await rawSummary.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(savedImplementation.locator(":scope > summary")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(rawSummary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rawJson).toHaveJSProperty("open", true);
  await expect(rawJson.locator("pre")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(rawJson).toHaveJSProperty("open", false);
  await closeDetails.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(details.getByRole("button", { name: "Inspect API coverage" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeDetails).toBeFocused();
  const accessibility = await new AxeBuilder({ page })
    .include(".technical-details-sheet")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(detailsOpener).toBeFocused();
  expect(api.actions).toEqual([]);
  expect(api.turns).toEqual([]);
  expect(api.replays).toEqual([]);
});
