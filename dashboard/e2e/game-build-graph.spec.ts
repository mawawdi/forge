import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { MAP_SHOWCASE } from "../src/test/game-build-fixture";
import { conversationState, createDashboardApi, installDashboardApi } from "./support";

test("game map is a clean concept canvas with expandable orbits and an accessible separate window", async ({
  page,
}, testInfo) => {
  const state = conversationState();
  const api = createDashboardApi({
    ...state,
    controlView: { ...state.controlView!, gameBuild: MAP_SHOWCASE },
  });
  await installDashboardApi(page, api);
  await page.goto("/");
  await expect(page.locator(".conversation-timeline .build-graph")).toHaveCount(0);
  const opener = page.getByRole("button", { name: "Open game map" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "The Wilds" });
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("game-map-overview.png"),
    fullPage: true,
    animations: "disabled",
  });
  await expect(dialog.getByRole("button", { name: "Close game map" })).toBeFocused();
  await expect(
    dialog.getByText(/Technical details|Live build view|checkpoint|Applied|Stopped|Source slot/),
  ).toHaveCount(0);
  if (page.viewportSize()!.width > 600) {
    await expect(
      dialog.getByRole("button", { name: "Select system Wolf", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Select system Rewards", exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Expand Levels" }).click();
    await expect(
      dialog.getByRole("button", { name: "Select system Bronze", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Select system Wolf", exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Collapse Levels" }).click();
  } else {
    await expect(dialog.getByRole("button", { name: "Expand Morph" })).toBeVisible();
  }
  await dialog.getByRole("button", { name: "Select system Morph", exact: true }).click();
  const details = dialog.getByRole("region", { name: "Selected system details" });
  await expect(details.getByText("Take on different forms to explore and play.")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("game-map-details.png"),
    fullPage: true,
    animations: "disabled",
  });
  await details.getByRole("button", { name: "Close system details" }).click();
  await expect(
    dialog.getByRole("button", { name: "Select system Morph", exact: true }),
  ).toBeFocused();
  const canvas = dialog.getByRole("region", { name: "Game system map" });
  const game = dialog.getByRole("button", { name: "Game map overview" });
  const before = await game.boundingBox();
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  expect((await game.boundingBox())!.x).toBeLessThan(before!.x - 50);
  await page.keyboard.press("Home");
  await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
  await dialog.getByRole("button", { name: "Fit graph to canvas" }).click();
  const search = dialog.getByRole("searchbox", { name: "Find a system" });
  await search.fill("Morph");
  await dialog.getByRole("button", { name: "Select system Morph", exact: true }).click();
  await expect(search).toHaveValue("Morph");
  await expect(
    dialog.getByRole("button", { name: "Select system Leaderboard", exact: true }),
  ).toHaveCount(0);
  const searchDetails = dialog.getByRole("region", { name: "Selected system details" });
  const selectedBounds = (await dialog
    .getByRole("button", { name: "Select system Morph", exact: true })
    .boundingBox())!;
  const inspectorBounds = (await searchDetails.boundingBox())!;
  expect(
    selectedBounds.x + selectedBounds.width <= inspectorBounds.x ||
      selectedBounds.y + selectedBounds.height <= inspectorBounds.y,
  ).toBe(true);
  await searchDetails.getByRole("button", { name: "To Rating, Earns progress" }).click();
  await expect(search).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: "Select system Rating", exact: true }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "Close system details" }).click();
  await dialog.getByRole("button", { name: "Fit graph to canvas" }).click();
  await dialog.locator("button:visible").first().focus();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  const expand = dialog.getByRole("button", { name: "Expand graph window" });
  if (await expand.isVisible()) {
    await expand.click();
    await expect(dialog).toHaveClass(/game-build-window--expanded/);
    await dialog.getByRole("button", { name: "Restore graph window" }).click();
  } else {
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.width).toEqual(page.viewportSize()!.width);
    expect(bounds.height).toEqual(page.viewportSize()!.height);
  }
  const accessibility = await new AxeBuilder({ page })
    .include(".game-build-window")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByRole("button", { name: "Show system list" }).click();
  await expect(dialog.getByRole("list", { name: "Game systems" })).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    await page.locator("body").evaluate((body) => body.clientWidth),
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(api.actions).toEqual([]);
  expect(api.turns).toEqual([]);
});
