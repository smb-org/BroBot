import { expect, test, type Page, type TestInfo } from "@playwright/test";

import type { DryRunRequest, DryRunResponse } from "../../src/contracts/dry-run";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const CHANNEL_ID = "test-area-playwright";

const firingResponse = (muted = false): DryRunResponse => ({
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls: { muted, paused: false },
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
          reply: true, suppressedBy: muted ? "channel_muted" : null, automated: true,
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
    { moduleId: "votekick", status: "not_testable", entries: [] },
  ],
});

const moduleReport = (response: DryRunResponse, moduleId: string): DryRunResponse["modules"][number] => {
  const report = response.modules.find((candidate) => candidate.moduleId === moduleId);
  if (report === undefined) throw new Error(`The ${moduleId} module fixture is missing.`);
  return report;
};

const blockedResponse = (): DryRunResponse => {
  const response = firingResponse();
  return {
    ...response,
    modules: [moduleReport(response, "faq")],
  };
};

const emptyResponse = (): DryRunResponse => {
  const response = firingResponse();
  return {
    ...response,
    modules: [moduleReport(response, "chat_voting"), moduleReport(response, "votekick")],
  };
};

interface TestAreaHarness {
  setResponse: (response: DryRunResponse) => void;
  failNextRequest: () => void;
  holdNextRequest: () => void;
  releaseHeldRequest: () => void;
  requestBody: () => DryRunRequest | null;
}

const openTestArea = async (page: Page, options: {
  width: number;
  height: number;
  role?: "manager" | "operator";
  response?: DryRunResponse;
}): Promise<TestAreaHarness> => {
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    role: options.role ?? "manager",
    streamState: "online",
    modules: [
      { id: "text_commands", enabled: true, settings: "{}" },
      { id: "faq", enabled: true, settings: "{}" },
    ],
  });
  let response = options.response ?? firingResponse();
  let fail = false;
  let hold = false;
  let heldRequest: Promise<void> | null = null;
  let release: (() => void) | null = null;
  let lastRequest: DryRunRequest | null = null;
  await page.route(`**/api/channels/${CHANNEL_ID}/dry-run`, async (route) => {
    lastRequest = route.request().postDataJSON() as DryRunRequest;
    if (hold && heldRequest !== null) await heldRequest;
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporarily_unavailable" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.goto(`/channels/${CHANNEL_ID}/test-area`);
  await expect(page.getByRole("heading", { name: "Testbereich" })).toBeVisible();
  return {
    setResponse: (next) => { response = next; },
    failNextRequest: () => { fail = true; },
    holdNextRequest: () => {
      hold = true;
      heldRequest = new Promise<void>((resolve) => { release = resolve; });
    },
    releaseHeldRequest: () => { hold = false; release?.(); release = null; heldRequest = null; },
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

const expectMobileDialogBounds = async (page: Page, name: string): Promise<void> => {
  const rect = await page.getByRole("dialog", { name }).evaluate((dialog) => {
    const { x, y, width, height } = dialog.getBoundingClientRect();
    return { x, y, width, height };
  });
  expect(rect).toEqual({ x: 0, y: 0, width: 390, height: 844 });
};

const saveScreenshot = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  await expectNoWholePageScroll(page);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false, animations: "disabled" });
};

test("submits one synthetic chat message and shows the selected firing row without page scroll", async ({ page }) => {
  const harness = await openTestArea(page, { width: 1920, height: 1080 });
  await submitMessage(page);
  const firingRow = page.getByRole("button", { name: /!discord/u });
  await expect(firingRow).toBeVisible();
  await expect(firingRow).toHaveAttribute("aria-current", "true");
  await expect(page.getByText("Noch ohne Trockenlauf: Votekick")).toBeVisible();
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

test.describe("test area screenshot captures", () => {
  test.use({ locale: "de-DE" });
  test.skip(process.env.TEST_AREA_CAPTURE !== "1", "Run explicitly to capture reviewed test area screenshots.");

  test("1920 by 1080 result with the firing row selected", async ({ page }, info) => {
    await openTestArea(page, { width: 1920, height: 1080 });
    await submitMessage(page);
    await expect(page.getByRole("button", { name: /!discord/u })).toHaveAttribute("aria-current", "true");
    await saveScreenshot(page, info, "result-selected-firing-1920x1080");
  });

  test("1280 by 800 blocked detail", async ({ page }, info) => {
    await openTestArea(page, { width: 1280, height: 800, response: blockedResponse() });
    await submitMessage(page);
    await expect(page.locator(".test-area__context-form > .ui-field").first()).toBeInViewport({ ratio: 1 });
    expect(await page.locator(".test-area__context").evaluate((context) => context.scrollTop)).toBe(0);
    const gameName = page.locator(".test-area__context-form .ui-game-multi-select__single-value-name");
    await expect(gameName).toHaveText("Just Chatting");
    expect(await gameName.evaluate((name) => name.scrollWidth <= name.clientWidth)).toBe(true);
    await expect(page.locator(".test-area__detail")).toBeVisible();
    await expect(page.locator(".test-area__detail")).toContainText("Blockiert");
    await saveScreenshot(page, info, "blocked-detail-1280x800");
  });

  test("1920 by 1080 loading state", async ({ page }, info) => {
    const harness = await openTestArea(page, { width: 1920, height: 1080 });
    harness.holdNextRequest();
    await submitMessage(page);
    await expect(page.getByTestId("test-area-results-slot")).toHaveAttribute("data-state", "loading");
    await saveScreenshot(page, info, "loading-1920x1080");
    harness.releaseHeldRequest();
  });

  test("1280 by 800 empty state", async ({ page }, info) => {
    await openTestArea(page, { width: 1280, height: 800, response: emptyResponse() });
    await submitMessage(page);
    await expect(page.getByText("Keine Reaktion gefunden")).toBeVisible();
    await saveScreenshot(page, info, "empty-1280x800");
  });

  test("1280 by 800 error state", async ({ page }, info) => {
    const harness = await openTestArea(page, { width: 1280, height: 800 });
    harness.failNextRequest();
    await submitMessage(page);
    await expect(page.getByRole("alert")).toContainText("Trockenlauf fehlgeschlagen");
    await saveScreenshot(page, info, "error-1280x800");
  });

  test("1920 by 1080 muted result", async ({ page }, info) => {
    await openTestArea(page, { width: 1920, height: 1080, response: firingResponse(true) });
    await submitMessage(page);
    await expect(page.getByText("Stumm", { exact: true })).toBeVisible();
    await expect(page.locator(".test-area__detail")).toContainText("Würde nicht gesendet");
    await saveScreenshot(page, info, "muted-1920x1080");
  });

  test("390 by 844 mobile context dialog", async ({ page }, info) => {
    await openTestArea(page, { width: 390, height: 844 });
    await page.getByRole("button", { name: "Ändern" }).click();
    await expect(page.getByRole("dialog", { name: "Kontext" })).toBeVisible();
    await expectMobileDialogBounds(page, "Kontext");
    const gameName = page.locator(".test-area__context-dialog .ui-game-multi-select__single-value-name");
    await expect(gameName).toHaveText("Just Chatting");
    expect(await gameName.evaluate((name) => name.scrollWidth <= name.clientWidth)).toBe(true);
    await saveScreenshot(page, info, "mobile-context-dialog-390x844");
  });

  test("390 by 844 mobile detail overlay", async ({ page }, info) => {
    await openTestArea(page, { width: 390, height: 844, response: blockedResponse() });
    await submitMessage(page);
    await page.getByRole("button", { name: /Begrüßung/u }).click();
    await expect(page.getByRole("dialog", { name: "Begrüßung" })).toBeVisible();
    await expectMobileDialogBounds(page, "Begrüßung");
    await saveScreenshot(page, info, "mobile-detail-overlay-390x844");
  });

  test("390 by 844 mobile history dialog", async ({ page }, info) => {
    await openTestArea(page, { width: 390, height: 844 });
    await submitMessage(page);
    await page.getByRole("button", { name: "Verlauf" }).click();
    await expect(page.getByRole("dialog", { name: "Verlauf" })).toBeVisible();
    await expectMobileDialogBounds(page, "Verlauf");
    await saveScreenshot(page, info, "mobile-history-dialog-390x844");
  });

  test("1280 by 800 operator can run a read-only test", async ({ page }, info) => {
    await openTestArea(page, { width: 1280, height: 800, role: "operator" });
    await submitMessage(page);
    await expect(page.getByRole("button", { name: /!discord/u })).toBeVisible();
    await saveScreenshot(page, info, "operator-result-1280x800");
  });
});
