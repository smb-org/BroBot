import { expect, test, type Page } from "@playwright/test";

import type { DryRunResponse } from "../../src/contracts/dry-run";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const CHANNEL_ID = "test-area-r7-layout";

const response: DryRunResponse = {
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls: { muted: false, paused: false },
  sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
  modules: [{
    moduleId: "text_commands",
    status: "reacts",
    entries: [{
      moduleId: "text_commands",
      entry: { kind: "text_command", id: "discord", label: "!discord" },
      outcome: "fires",
      match: { kind: "alias", token: "dc" },
      blocks: [],
      effects: [{
        kind: "chat", text: "Discord: discord.gg/beispiel", target: "source_only", postsTo: "this_chat",
        reply: true, suppressedBy: null, automated: true,
      }],
      templateNotes: [],
    }],
  }],
};

const openTestArea = async (page: Page, width: number, height: number): Promise<{ dryRunRequests: () => number }> => {
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    role: "manager",
    streamState: "online",
    modules: [
      { id: "text_commands", enabled: true, settings: "{}" },
      { id: "faq", enabled: true, settings: "{}" },
    ],
  });
  let dryRunRequests = 0;
  await page.route(`**/api/channels/${CHANNEL_ID}/dry-run`, async (route) => {
    dryRunRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
  await page.setViewportSize({ width, height });
  await page.goto(`/channels/${CHANNEL_ID}/test-area`);
  await expect(page.getByRole("heading", { name: "Testbereich" })).toBeVisible();
  return { dryRunRequests: () => dryRunRequests };
};

test("keeps the context submit visible and history reachable at 1280 by 600", async ({ page }) => {
  const harness = await openTestArea(page, 1280, 600);
  const button = page.locator(".test-area__context-form .test-area__run-button");

  await expect(button).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("heading", { name: "Verlauf" })).toBeVisible();

  const layout = await page.evaluate(() => {
    const fields = document.querySelector<HTMLElement>(".test-area__context-fields");
    return {
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      fieldsOverflowY: fields === null ? "missing" : getComputedStyle(fields).overflowY,
      fieldsScrolls: fields !== null && fields.scrollHeight > fields.clientHeight,
    };
  });

  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.fieldsOverflowY).toMatch(/auto|scroll/u);
  expect(layout.fieldsScrolls).toBe(true);

  await button.click();
  await expect.poll(harness.dryRunRequests).toBe(1);
  await expect(page.getByRole("button", { name: /!discord/u })).toBeVisible();
  await expect(page.locator(".test-area__history-list")).toContainText("!dc hallo");
});

test("keeps the context column usable at 1920 by 700", async ({ page }) => {
  const harness = await openTestArea(page, 1920, 700);
  const button = page.locator(".test-area__context-form .test-area__run-button");

  await expect(button).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("heading", { name: "Verlauf" })).toBeVisible();
  const layout = await page.evaluate(() => {
    const fields = document.querySelector<HTMLElement>(".test-area__context-fields");
    return {
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      fieldsOverflowY: fields === null ? "missing" : getComputedStyle(fields).overflowY,
    };
  });
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.fieldsOverflowY).toMatch(/auto|scroll/u);

  await button.click();
  await expect.poll(harness.dryRunRequests).toBe(1);
  await expect(page.getByRole("button", { name: /!discord/u })).toBeVisible();
});

test("submits the mobile context message with Enter and closes the dialog", async ({ page }) => {
  const harness = await openTestArea(page, 390, 844);
  await page.getByRole("button", { name: "Ändern" }).click();

  const dialog = page.getByRole("dialog", { name: "Kontext" });
  const message = dialog.getByRole("textbox", { name: "Nachricht" });
  await expect(dialog).toBeVisible();
  await message.fill("!dc hallo");
  await message.press("Enter");

  await expect.poll(harness.dryRunRequests).toBe(1);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: /!discord/u })).toBeVisible();
});
