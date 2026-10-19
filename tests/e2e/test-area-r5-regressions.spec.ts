import { expect, test, type Page } from "@playwright/test";

import type { DryRunResponse } from "../../src/contracts/dry-run";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE" });

const CHANNEL_ID = "test-area-r5-regressions";

const response = (muted = false): DryRunResponse => ({
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls: { muted, paused: false },
  sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
  modules: [{
    moduleId: "text_commands",
    status: "reacts",
    entries: muted ? [
      {
        moduleId: "text_commands",
        entry: { kind: "text_command", id: "discord", label: "!discord" },
        outcome: "fires",
        match: { kind: "alias", token: "dc" },
        blocks: [],
        effects: [{
          kind: "chat", text: "Discord: discord.gg/beispiel", target: "source_only", postsTo: "this_chat",
          reply: true, suppressedBy: "channel_muted", automated: true,
        }],
        templateNotes: [],
      },
      {
        moduleId: "text_commands",
        entry: { kind: "text_command", id: "timeout", label: "!timeout" },
        outcome: "fires",
        match: { kind: "alias", token: "timeout" },
        blocks: [],
        effects: [
          { kind: "timeout", minSeconds: 30, maxSeconds: 30, reason: "Spam", suppressedBy: "channel_muted" },
          {
            kind: "chat", text: "Timeout applied", target: "source_only", postsTo: "this_chat",
            reply: true, suppressedBy: "channel_muted", automated: true, when: "on_success",
          },
          {
            kind: "chat", text: "Timeout failed", target: "source_only", postsTo: "this_chat",
            reply: true, suppressedBy: "channel_muted", automated: true, when: "on_failure",
          },
        ],
        templateNotes: [],
      },
    ] : [{
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
});

const openTestArea = async (page: Page, width: number, height: number, muted = false): Promise<void> => {
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
    body: JSON.stringify(response(muted)),
  }));
  await page.setViewportSize({ width, height });
  await page.goto(`/channels/${CHANNEL_ID}/test-area`);
  await expect(page.getByRole("heading", { name: "Testbereich" })).toBeVisible();
};

const run = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Prüfen", exact: true }).first().click();
};

test("shows a muted row, neutral suppressed effects, an equal-bound timeout, and one dialog heading", async ({ page }) => {
  await openTestArea(page, 1024, 768, true);
  await run(page);

  const row = page.locator(".test-area__result-row").filter({ hasText: "!timeout" });
  await expect(row).toBeVisible();
  await expect(row.locator(".test-area__row-outcome")).toHaveText("Würde antworten (stumm)");
  await expect(row.locator(".status-led")).toHaveAttribute("data-status", "off");
  await row.click();

  const dialog = page.getByRole("dialog", { name: "!timeout" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "!timeout" })).toHaveCount(1);
  await expect(dialog.locator(".test-area__detail-heading h2")).toBeHidden();
  await expect(dialog.locator(".test-area__detail-meta")).toContainText("Textbefehl");
  await expect(dialog.locator(".test-area__detail-meta")).toContainText("Alias");
  await expect(dialog.locator(".test-area__effect-list")).toContainText("Timeout 30 s");
  await expect(dialog.locator(".test-area__effect-list")).not.toContainText("Timeout 30–30 s");
  await expect(dialog.locator(".test-area__effect-list")).toContainText("Nur bei Erfolg");
  await expect(dialog.locator(".test-area__effect-list")).toContainText("Nur bei Fehler");
  const suppressedEffects = dialog.locator(".test-area__effect-list li.is-suppressed");
  await expect(suppressedEffects).toHaveCount(3);
  await expect(suppressedEffects.first().locator(".test-area__effect-icon--suppressed")).toBeVisible();
  await expect(suppressedEffects.first()).toContainText("Unterdrückt: Kanal stummgeschaltet");
});

test("keeps a plain text-command answer unconditional and puts conditions on the timeout command", async ({ page }) => {
  await openTestArea(page, 1920, 1080, true);
  await run(page);

  const plainReplyRow = page.locator(".test-area__result-row").filter({ hasText: "!discord" });
  await plainReplyRow.click();
  const detail = page.locator(".test-area__detail");
  await expect(detail.locator(".test-area__answer-item")).toContainText("Discord: discord.gg/beispiel");
  await expect(detail.locator(".test-area__answer-item .test-area__effect-qualifier")).toHaveCount(0);
  await expect(detail.locator(".test-area__answer-item")).not.toContainText("Nur bei Erfolg");

  const timeoutRow = page.locator(".test-area__result-row").filter({ hasText: "!timeout" });
  await timeoutRow.click();
  const timeoutDetail = page.locator(".test-area__detail");
  await expect(timeoutDetail.locator(".test-area__answer-item .test-area__effect-qualifier")).toHaveText([
    "Nur bei Erfolg",
    "Nur bei Fehler",
  ]);
});

test("keeps the shared-chat to module label gap in the same rhythm at desktop and tablet widths", async ({ page }) => {
  await openTestArea(page, 1920, 1080);

  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    const label = "label gap at " + String(viewport.width) + " by " + String(viewport.height);
    const gap = await page.evaluate(() => {
      const form = document.querySelector<HTMLElement>(".test-area__context-form");
      const sharedChatLabel = form?.querySelector<HTMLElement>(".ui-switch-row__copy strong");
      const moduleLabel = form?.querySelector<HTMLElement>(".ui-select .ui-field__label");
      if (sharedChatLabel === null || sharedChatLabel === undefined || moduleLabel === null || moduleLabel === undefined) return null;
      return moduleLabel.getBoundingClientRect().top - sharedChatLabel.getBoundingClientRect().bottom;
    });
    expect(gap, label).not.toBeNull();
    expect(gap, label).toBeCloseTo(8, 0);
  }
});
