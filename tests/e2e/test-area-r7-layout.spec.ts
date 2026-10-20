import { expect, test, type Page } from "@playwright/test";

import type { DryRunResponse } from "../../src/contracts/dry-run";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE" });

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

const responseWithRows = (count: number): DryRunResponse => {
  const module = response.modules[0];
  const entry = module?.entries[0];
  if (module === undefined || entry === undefined) throw new Error("The test-area response fixture is incomplete.");

  return {
    ...response,
    modules: [{
      ...module,
      entries: Array.from({ length: count }, (_, index) => ({
        ...entry,
        entry: { ...entry.entry, id: `discord-${String(index)}`, label: `!discord-${String(index)}` },
      })),
    }],
  };
};

const openTestArea = async (
  page: Page,
  width: number,
  height: number,
  dryRunResponse: DryRunResponse = response,
): Promise<{ dryRunRequests: () => number }> => {
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
      body: JSON.stringify(dryRunResponse),
    });
  });
  await page.setViewportSize({ width, height });
  await page.goto(`/channels/${CHANNEL_ID}/test-area`);
  await expect(page.getByRole("heading", { name: "Testbereich" })).toBeVisible();
  return { dryRunRequests: () => dryRunRequests };
};

const expectLongResultsStayContained = async (page: Page, width: number, height: number): Promise<void> => {
  const harness = await openTestArea(page, width, height, responseWithRows(40));
  const runButton = page.locator(".test-area__context-form .test-area__run-button");
  await expect(runButton).toBeInViewport({ ratio: 1 });
  const initialMainScrollTop = await page.locator(".dashboard-shell__main").evaluate((main) => main.scrollTop);

  await runButton.click();
  await expect.poll(harness.dryRunRequests).toBe(1);
  await expect(page.locator(".test-area__result-row")).toHaveCount(40);

  const layout = await page.evaluate(() => {
    const results = document.querySelector<HTMLElement>(".test-area__result-scroll");
    return {
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      resultScrollHeight: results?.scrollHeight ?? 0,
      resultClientHeight: results?.clientHeight ?? 0,
      mainScrollTop: document.querySelector<HTMLElement>(".dashboard-shell__main")?.scrollTop ?? -1,
      gapBelowWorkspace: (() => {
        const workspace = document.querySelector<HTMLElement>(".test-area");
        const content = document.querySelector<HTMLElement>(".main-content");
        if (workspace === null || content === null) return Number.POSITIVE_INFINITY;
        const innerBottom = content.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(content).paddingBottom);
        return innerBottom - workspace.getBoundingClientRect().bottom;
      })(),
    };
  });

  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.resultScrollHeight).toBeGreaterThan(layout.resultClientHeight);
  expect(layout.gapBelowWorkspace).toBeLessThanOrEqual(2);
  expect(layout.mainScrollTop).toBe(initialMainScrollTop);
  await expect(runButton).toBeInViewport({ ratio: 1 });
};

const expectContextActionsReachable = async (page: Page): Promise<void> => {
  const runButton = page.getByRole("button", { name: "Prüfen" });
  const historyButton = page.getByRole("button", { name: /Verlauf/u });

  await runButton.scrollIntoViewIfNeeded();
  await expect(runButton).toBeInViewport({ ratio: 1 });
  await historyButton.scrollIntoViewIfNeeded();
  await expect(historyButton).toBeInViewport({ ratio: 1 });

  const layout = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".dashboard-shell__main");
    const workspace = document.querySelector<HTMLElement>(".test-area");
    const context = document.querySelector<HTMLElement>(".test-area__context");
    const form = document.querySelector<HTMLElement>(".test-area__context-form");
    const fields = document.querySelector<HTMLElement>(".test-area__context-fields");
    const footer = document.querySelector<HTMLElement>(".test-area__context-footer");
    if (main === null || workspace === null || context === null || form === null || fields === null || footer === null) return null;

    const bounds = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    };
    const workspaceBounds = bounds(workspace);
    const contextBounds = bounds(context);
    const formBounds = bounds(form);
    const fieldsBounds = bounds(fields);
    const footerBounds = bounds(footer);
    const clippedFields = Array.from(fields.children).filter((field) => {
      if (!(field instanceof HTMLElement) || field.getClientRects().length === 0) return false;
      const fieldBounds = bounds(field);
      return fieldBounds.top < fieldsBounds.top - 1 || fieldBounds.bottom > fieldsBounds.bottom + 1;
    }).length;
    const clippingAncestors: string[] = [];
    let ancestor: HTMLElement | null = form;
    while (ancestor !== null && ancestor !== main) {
      if (["hidden", "clip"].includes(getComputedStyle(ancestor).overflowY)) {
        clippingAncestors.push(ancestor.className);
      }
      ancestor = ancestor.parentElement;
    }

    return {
      formScrolls: form.scrollHeight > form.clientHeight + 1,
      fieldsScrolls: fields.scrollHeight > fields.clientHeight + 1,
      clippedFields,
      formFitsContext: formBounds.top >= contextBounds.top - 1 && formBounds.bottom <= contextBounds.bottom + 1,
      contextFitsWorkspace: contextBounds.top >= workspaceBounds.top - 1 && contextBounds.bottom <= workspaceBounds.bottom + 1,
      footerFitsForm: footerBounds.top >= formBounds.top - 1 && footerBounds.bottom <= formBounds.bottom + 1,
      clippingAncestors,
    };
  });

  if (layout === null) throw new Error("The test-area context layout is incomplete.");
  expect(layout.formScrolls).toBe(false);
  expect(layout.fieldsScrolls).toBe(false);
  expect(layout.clippedFields).toBe(0);
  expect(layout.formFitsContext).toBe(true);
  expect(layout.contextFitsWorkspace).toBe(true);
  expect(layout.footerFitsForm).toBe(true);
  expect(layout.clippingAncestors).toEqual([]);
};

test("keeps the context submit visible and history reachable at 1280 by 600", async ({ page }) => {
  const harness = await openTestArea(page, 1280, 600);
  const button = page.locator(".test-area__context-form .test-area__run-button");

  await expectContextActionsReachable(page);

  const layout = await page.evaluate(() => {
    const fields = document.querySelector<HTMLElement>(".test-area__context-fields");
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      fieldsOverflowY: fields === null ? "missing" : getComputedStyle(fields).overflowY,
      fieldsScrolls: fields !== null && fields.scrollHeight > fields.clientHeight,
    };
  });

  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.fieldsOverflowY).not.toMatch(/auto|scroll/u);
  expect(layout.fieldsScrolls).toBe(false);

  await button.click();
  await expect.poll(harness.dryRunRequests).toBe(1);
  await expect(page.getByRole("button", { name: /!discord/u })).toBeVisible();
  const historyButton = page.getByRole("button", { name: "Verlauf · 1" });
  await expect(historyButton).toBeVisible();
  await historyButton.click();
  const historyDialog = page.getByRole("dialog", { name: "Verlauf" });
  await expect(historyDialog.locator(".test-area__history-list")).toContainText("!dc hallo");
});

test("grows the desktop context form at 1440 by 900", async ({ page }) => {
  await openTestArea(page, 1440, 900);
  await expectContextActionsReachable(page);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
  test(`keeps long results inside the results column at ${String(viewport.width)} by ${String(viewport.height)}`, async ({ page }) => {
    await expectLongResultsStayContained(page, viewport.width, viewport.height);
  });
}

test.describe("coarse pointer context layout", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("keeps touch-sized context actions reachable at 900 by 700", async ({ page }) => {
    await openTestArea(page, 900, 700);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await expectContextActionsReachable(page);
  });
});

test("keeps the context column usable at 1920 by 700", async ({ page }) => {
  const harness = await openTestArea(page, 1920, 700);
  const button = page.locator(".test-area__context-form .test-area__run-button");

  await expect(button).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: "Verlauf · 0" })).toBeVisible();
  const layout = await page.evaluate(() => {
    const fields = document.querySelector<HTMLElement>(".test-area__context-fields");
    return {
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      fieldsOverflowY: fields === null ? "missing" : getComputedStyle(fields).overflowY,
      fieldsScrolls: fields !== null && fields.scrollHeight > fields.clientHeight,
    };
  });
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.fieldsOverflowY).not.toMatch(/auto|scroll/u);
  expect(layout.fieldsScrolls).toBe(false);

  await button.click();
  await expect.poll(harness.dryRunRequests).toBe(1);
  await expect(page.getByRole("button", { name: /!discord/u })).toBeVisible();
  await page.getByRole("button", { name: "Verlauf · 1" }).click();
  await expect(page.getByRole("dialog", { name: "Verlauf" }).locator(".test-area__history-list")).toContainText("!dc hallo");
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
