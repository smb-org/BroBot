import { expect, test, type Page } from "@playwright/test";

import type { DryRunResponse } from "../../src/contracts/dry-run";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE" });

const CHANNEL_ID = "test-area-r4-layout";

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

const openTestArea = async (page: Page, width: number, height: number): Promise<void> => {
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    role: "manager",
    streamState: "online",
    modules: [
      { id: "text_commands", enabled: true, settings: "{}" },
      { id: "faq", enabled: true, settings: "{}" },
    ],
  });
  await page.route(`**/api/channels/${CHANNEL_ID}/dry-run`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(response),
  }));
  await page.setViewportSize({ width, height });
  await page.goto(`/channels/${CHANNEL_ID}/test-area`);
  await expect(page.getByRole("heading", { name: "Testbereich" })).toBeVisible();
};

const submitAndSelect = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Prüfen", exact: true }).first().click();
  const row = page.getByRole("button", { name: /!discord/u });
  await expect(row).toBeVisible();
  await row.click();
};

test("keeps the full three-column detail visible at 1280 by 800 and aligns the context rhythm", async ({ page }) => {
  await openTestArea(page, 1280, 800);
  await submitAndSelect(page);

  const geometry = await page.evaluate(() => {
    const area = document.querySelector<HTMLElement>(".test-area");
    const detail = document.querySelector<HTMLElement>(".test-area__detail");
    const contextForm = document.querySelector<HTMLElement>(".test-area__context-form");
    const sharedChat = contextForm?.querySelector<HTMLElement>(".ui-switch-row");
    const moduleSelect = contextForm?.querySelector<HTMLElement>(".ui-select");
    const box = (element: HTMLElement | null): { left: number; right: number } | null => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    };
    const rhythmGaps = contextForm === null ? [] : Array.from(contextForm.children).slice(1).map((child, index) => {
      const previous = contextForm.children[index];
      return previous === undefined ? 0 : child.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
    });
    return {
      area: box(area),
      detail: box(detail),
      detailDisplay: detail === null ? "none" : getComputedStyle(detail).display,
      switchToModuleGap: sharedChat === null || sharedChat === undefined || moduleSelect === null || moduleSelect === undefined
        ? null
        : moduleSelect.getBoundingClientRect().top - sharedChat.getBoundingClientRect().bottom,
      rhythmGaps,
      columns: area === null ? 0 : getComputedStyle(area).gridTemplateColumns.split(" ").length,
    };
  });

  expect(geometry.columns).toBe(3);
  expect(geometry.detailDisplay).not.toBe("none");
  expect(geometry.area).not.toBeNull();
  expect(geometry.detail).not.toBeNull();
  expect((geometry.detail?.right ?? Infinity)).toBeLessThanOrEqual((geometry.area?.right ?? -Infinity) + 1);
  expect(geometry.switchToModuleGap).not.toBeNull();
  for (const gap of geometry.rhythmGaps) expect(gap).toBeCloseTo(8, 0);
  expect(geometry.switchToModuleGap).toBeCloseTo(8, 0);
});

test("uses two columns and an in-bounds detail overlay at 1024 by 768", async ({ page }) => {
  await openTestArea(page, 1024, 768);
  await submitAndSelect(page);

  const geometry = await page.evaluate(() => {
    const area = document.querySelector<HTMLElement>(".test-area");
    const context = document.querySelector<HTMLElement>(".test-area__context");
    const results = document.querySelector<HTMLElement>(".test-area__results");
    return {
      columns: area === null ? 0 : getComputedStyle(area).gridTemplateColumns.split(" ").length,
      areaRight: area?.getBoundingClientRect().right ?? 0,
      contextRight: context?.getBoundingClientRect().right ?? Infinity,
      resultsRight: results?.getBoundingClientRect().right ?? Infinity,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });

  expect(geometry.columns).toBe(2);
  expect(geometry.contextRight).toBeLessThanOrEqual(geometry.areaRight + 1);
  expect(geometry.resultsRight).toBeLessThanOrEqual(geometry.areaRight + 1);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  const dialog = page.getByRole("dialog", { name: "!discord" });
  await expect(dialog).toBeVisible();
  const rect = await dialog.evaluate((element) => {
    const { x, y, right, bottom } = element.getBoundingClientRect();
    return { x, y, right, bottom };
  });
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(1024);
  expect(rect.bottom).toBeLessThanOrEqual(768);
  await expect(dialog).toContainText("Würde tun");
});
