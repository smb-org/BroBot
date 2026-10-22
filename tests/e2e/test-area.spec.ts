import { expect, test, type Page } from "@playwright/test";

import type { DryRunRequest, DryRunResponse } from "../../src/contracts/dry-run";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE" });

const CHANNEL_ID = "test-area-playwright";

const firingResponse = (): DryRunResponse => ({
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls: { muted: false, paused: false },
  sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
  modules: [
    {
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
        }, { kind: "cooldown", scope: "global", seconds: 30 }],
        templateNotes: [],
      }],
    },
    {
      moduleId: "faq",
      status: "blocked",
      entries: [{
        moduleId: "faq",
        entry: { kind: "faq_entry", id: "faq-greeting", label: "Begrüßung" },
        outcome: "blocked",
        match: { kind: "keyword", pattern: "hallo" },
        blocks: [{ code: "faq.person_cooldown", detail: { remainingSeconds: 42 } }],
        effects: [],
        templateNotes: [],
      }],
    },
    { moduleId: "chat_voting", status: "silent", entries: [] },
    { moduleId: "votekick", status: "silent", entries: [] },
  ],
});

const moduleReport = (response: DryRunResponse, moduleId: string): DryRunResponse["modules"][number] => {
  const report = response.modules.find((candidate) => candidate.moduleId === moduleId);
  if (report === undefined) throw new Error(`The ${moduleId} module fixture is missing.`);
  return report;
};

const partialFailureResponse = (): DryRunResponse => {
  const response = firingResponse();
  return {
    ...response,
    modules: [moduleReport(response, "text_commands"), { moduleId: "faq", status: "error", error: "module_error", entries: [] }],
  };
};

interface TestAreaHarness {
  requestBody: () => DryRunRequest | null;
}

const openTestArea = async (page: Page, options: {
  width: number;
  height: number;
  response?: DryRunResponse;
}): Promise<TestAreaHarness> => {
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    role: "manager",
    streamState: "online",
    modules: [
      { id: "text_commands", enabled: true, settings: "{}" },
      { id: "faq", enabled: true, settings: "{}" },
    ],
  });
  const response = options.response ?? firingResponse();
  let lastRequest: DryRunRequest | null = null;
  await page.route(`**/api/channels/${CHANNEL_ID}/dry-run`, async (route) => {
    lastRequest = route.request().postDataJSON() as DryRunRequest;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.goto(`/channels/${CHANNEL_ID}/test-area`);
  await expect(page.getByRole("heading", { name: "Testbereich" })).toBeVisible();
  return {
    requestBody: () => lastRequest,
  };
};

const submitMessage = async (page: Page, message = "!dc hallo"): Promise<void> => {
  await page.getByRole("textbox", { name: "Nachricht" }).fill(message);
  await page.getByRole("button", { name: "Prüfen", exact: true }).click();
};

const expectNoWholePageScroll = async (page: Page): Promise<void> => {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.pageWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.pageHeight, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewportHeight);
};

const expectIncompleteResultsLayout = async (page: Page): Promise<void> => {
  const warning = page.getByTestId("test-area-incomplete-result-hint");
  await expect(warning).toHaveAccessibleName(/Ergebnis unvollständig.*Mindestens ein Modul konnte die Nachricht nicht vollständig prüfen/u);
  await expect(page.getByRole("button", { name: /!discord/u })).toBeVisible();
  const layout = await page.evaluate(() => {
    const slot = document.querySelector<HTMLElement>(".test-area__results-slot");
    const header = document.querySelector<HTMLElement>(".test-area__results-head");
    if (slot === null || header === null) return null;
    const warningElement = header.querySelector<HTMLElement>("[data-testid='test-area-incomplete-result-hint']");
    const listElement = slot.querySelector<HTMLElement>(".test-area__result-scroll");
    if (warningElement === null || listElement === null) return null;
    const slotRect = slot.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const warningRect = warningElement.getBoundingClientRect();
    const listRect = listElement.getBoundingClientRect();
    return {
      headingTop: header.querySelector("h2")?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
      headerTop: headerRect.top,
      listTop: listRect.top,
      slotWidth: slotRect.width,
      warningWidth: warningRect.width,
      listWidth: listRect.width,
    };
  });
  expect(layout).not.toBeNull();
  expect((layout?.headingTop ?? Infinity) - (layout?.headerTop ?? 0)).toBeLessThanOrEqual(12);
  expect(layout?.warningWidth).toBeLessThan(48);
  expect(layout?.listWidth).toBeCloseTo(layout?.slotWidth ?? 0, 0);
};

test("submits one synthetic chat message and shows the selected firing row without page scroll", async ({ page }) => {
  const harness = await openTestArea(page, { width: 1920, height: 1080 });
  await submitMessage(page);
  const firingRow = page.getByRole("button", { name: /!discord/u });
  await expect(firingRow).toBeVisible();
  await expect(firingRow).toHaveAttribute("aria-current", "true");
  expect(harness.requestBody()).toMatchObject({
    text: "!dc hallo",
    sender: { login: "viewer_42", statuses: ["subscriber"] },
    streamState: "online",
    game: { id: "509658", name: "Just Chatting" },
    sharedChat: false,
  });
  await expectNoWholePageScroll(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoWholePageScroll(page);
});

test("keeps the incomplete result icon in the title row above the full-width result list at 1280 by 800", async ({ page }) => {
  await openTestArea(page, { width: 1280, height: 800, response: partialFailureResponse() });
  await submitMessage(page);
  await expectIncompleteResultsLayout(page);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`anchors the incomplete result hint popover to its icon and keeps it narrow at ${String(viewport.width)} by ${String(viewport.height)}`, async ({ page }) => {
    await openTestArea(page, { ...viewport, response: partialFailureResponse() });
    await submitMessage(page);
    const trigger = page.getByTestId("test-area-incomplete-result-hint");
    await trigger.hover();
    const content = page.locator(".ui-popover__content");
    await expect(content).toBeVisible();
    const box = await content.boundingBox();
    const triggerBox = await trigger.boundingBox();
    expect(box).not.toBeNull();
    expect(triggerBox).not.toBeNull();
    expect(box?.width ?? Infinity).toBeLessThanOrEqual(361);
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    if (viewport.width === 1440) {
      expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) - ((triggerBox?.x ?? 0) + (triggerBox?.width ?? 0)))).toBeLessThanOrEqual(24);
    }
  });
}

