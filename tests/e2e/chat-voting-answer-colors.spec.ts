import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";

import type { ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";

const channelId = "channel-a";
const timestamp = "2030-01-01T12:00:00.000Z";
const template: ChatVoteTemplate = {
  id: "template-colors",
  channelId,
  shortcut: "dinner",
  title: "Dinner choice",
  resultText: "{vote.result}",
  labels: ["Pizza", "Burger", "Pasta"],
  answerColors: ["#5b8cff", "#ff9f43", "#2ed3a3"],
  offerInCockpit: true,
  freeTextMode: null,
  durationSeconds: 120,
  revision: 1,
  legacyAlias: null,
  lastUsedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const fulfillJson = async (route: Route, value: unknown): Promise<void> => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
};

const installMockedApi = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/templates`) {
      await fulfillJson(route, { templates: [template], count: 1, maximum: 100 });
    } else if (pathname === `/api/channels/${channelId}/template-variables`) {
      await fulfillJson(route, { variables: [] });
    } else if (pathname === "/api/csrf") {
      await fulfillJson(route, { token: "vote-color-csrf" });
    } else {
      await fulfillJson(route, {});
    }
  });
};

const box = async (page: Page): Promise<{ x: number; y: number; width: number; height: number }> =>
  await page.locator(".chat-voting-editor__duration-control").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });

for (const width of [1920, 390]) {
  test(`answer colors and preview fit at ${String(width)}px with stable content below`, async ({ page }, testInfo: TestInfo) => {
    // The first saved vote opens automatically on a wide viewport; narrowing afterwards keeps it open.
    await page.setViewportSize({ width: 1440, height: 900 });
    await installMockedApi(page);
    await page.goto("/tests/e2e/module-panels-stability-fixture.html?panel=chat_voting&lang=en");
    await expect(page.getByRole("button", { name: "Color for answer 1" })).toBeVisible();
    await page.setViewportSize({ width, height: 1080 });

    await expect(page.getByRole("button", { name: "Color for answer 1" })).toBeVisible();
    await expect(page.getByTestId("chat-vote-color-preview")).toContainText("Colours · preview");
    await expect.poll(() => page.locator(".chat-voting-editor__color-preview-rows").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(100);
    await expect(page.locator(".chat-voting-template-list__offer")).toContainText("In cockpit");
    await page.screenshot({ path: testInfo.outputPath(`vote-colors-${String(width)}.png`), fullPage: true });

    const before = await box(page);
    const trigger = page.getByRole("button", { name: "Color for answer 1" });
    await trigger.click();
    const popover = page.getByRole("dialog", { name: "Color for answer 1" });
    const usedPaletteColor = popover.getByRole("button", { name: "#ff9f43" });
    await expect(usedPaletteColor).toHaveCSS("background-color", "rgb(255, 159, 67)");
    await expect(usedPaletteColor).toHaveCSS("opacity", "1");
    await expect(popover.locator(".chat-voting-editor__color-feedback")).toHaveCSS("height", "16px");
    await popover.getByRole("button", { name: "#ff6fae" }).click();
    expect(await box(page)).toEqual(before);

    await popover.getByRole("textbox", { name: "Custom hex color" }).fill("#ff9f43");
    await expect(popover).toContainText("Each answer needs a different color.");
    await expect(page.locator(".ui-save-bar__status")).toContainText("Check the highlighted fields.");
    expect(await box(page)).toEqual(before);

    await popover.getByRole("textbox", { name: "Custom hex color" }).fill("#1c222b");
    await expect(popover).toContainText("This color needs at least 3:1 contrast");
    expect(await box(page)).toEqual(before);

    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await page.getByRole("button", { name: "Restore defaults" }).click();
    expect(await box(page)).toEqual(before);
    await expect(page.getByTestId("chat-vote-color-preview").locator(".chat-voting-editor__color-preview-track > span").first())
      .toHaveCSS("background-color", "rgb(91, 140, 255)");
  });
}
