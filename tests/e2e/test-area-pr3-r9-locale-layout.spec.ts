import { expect, test, type Browser, type Page } from "@playwright/test";

import type { DryRunResponse } from "../../src/contracts/dry-run";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const CHANNEL_ID = "test-area-pr3-r9";
const TIMESTAMP = "2030-01-01T12:00:00.000Z";

const response: DryRunResponse = {
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
        }],
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
};

const openTestArea = async (page: Page): Promise<void> => {
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    role: "manager",
    streamState: "online",
    modules: [
      { id: "text_commands", enabled: true, settings: "{}" },
      { id: "faq", enabled: true, settings: "{}" },
    ],
  });
  await page.route(`**/api/channels/${CHANNEL_ID}/dry-run`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${CHANNEL_ID}/test-area`);
};

const openTestAreaWithLanguage = async (browser: Browser, locale: "en-US" | "de-DE"): Promise<{ page: Page; close: () => Promise<void> }> => {
  const context = await browser.newContext({ locale });
  const page = await context.newPage();
  await openTestArea(page);
  return { page, close: () => context.close() };
};

test("test area follows the browser language when switching from English back to German", async ({ browser }) => {
  const english = await openTestAreaWithLanguage(browser, "en-US");
  await expect(english.page.getByRole("heading", { name: "Test area" })).toBeVisible();
  await expect(english.page.getByText("Dry-run a sample message. Nothing is sent or saved. History stays in this session.")).toBeVisible();
  await expect(english.page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(english.page.getByText("Fictional test sender for per-person cooldowns")).toBeVisible();
  await expect(english.page.getByRole("button", { name: "Check", exact: true })).toBeVisible();
  await english.page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(english.page.getByRole("heading", { name: "Result" })).toBeVisible();
  await expect(english.page.locator(".test-area__results-title")).toContainText("1 reaction · 1 blocked");
  await expect(english.page.getByRole("button", { name: /!discord/u })).toContainText("Text commands");
  await expect(english.page.getByRole("button", { name: /!discord/u })).toContainText("Would reply");
  await english.page.getByRole("button", { name: /Begrüßung/u }).click();
  await expect(english.page.locator(".test-area__detail")).toContainText("Why");
  await expect(english.page.locator(".test-area__detail")).toContainText("Per-person cooldown: 42 s left.");
  await expect(english.page.getByRole("button", { name: "Open in editor" })).toBeVisible();
  await english.close();

  const german = await openTestAreaWithLanguage(browser, "de-DE");
  await expect(german.page.getByRole("heading", { name: "Testbereich" })).toBeVisible();
  await expect(german.page.getByText("Probenachricht im Trockenlauf – nichts wird gesendet oder gespeichert. Verlauf nur in dieser Sitzung.")).toBeVisible();
  await expect(german.page.getByRole("textbox", { name: "Nachricht" })).toBeVisible();
  await expect(german.page.getByText("Fiktiver Testabsender für persönliche Abklingzeiten")).toBeVisible();
  await german.page.getByRole("button", { name: "Prüfen", exact: true }).click();
  await expect(german.page.getByRole("heading", { name: "Ergebnis" })).toBeVisible();
  await expect(german.page.locator(".test-area__results-title")).toContainText("1 reagiert · 1 blockiert");
  await german.page.getByRole("button", { name: /Begrüßung/u }).click();
  await expect(german.page.locator(".test-area__detail")).toContainText("Warum");
  await expect(german.page.locator(".test-area__detail")).toContainText("Abklingzeit pro Person: noch 42 s.");
  await expect(german.page.getByRole("button", { name: "Im Editor öffnen" })).toBeVisible();
  await german.close();
});

test("FAQ and text command editor entry points follow their selected language", async ({ page }) => {
  await page.route("**/api/channels/channel-a/modules/faq/entries", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      orderRevision: 1,
      entries: [{
        id: "faq-a", name: "Greeting", enabled: true, matcher: { type: "keywords", patterns: ["hello"] }, answerText: "Hello!",
        minimumTier: "everyone", cooldownSeconds: 30, userCooldownSeconds: 0, games: [], chatTarget: "source_only", order: 0, revision: 1,
        lastUsedAt: null, createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
      }],
    }) });
  });
  await page.route("**/api/channels/channel-a/modules/text_commands/commands", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      commands: [{
        channelId: "channel-a", name: "hello", text: "Hello {user}", kind: "text", enabled: true, minimumTier: "everyone",
        cooldownSeconds: 30, aliases: [], userCooldownSeconds: 0, streamCondition: "any", responseType: "say", variableAction: null,
        useCount: 0, lastUsedAt: null, createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
      }],
      variables: [],
    }) });
  });
  await page.route("**/api/channels/channel-a/settings", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
      defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
    }) });
  });
  await page.route("**/api/channels/channel-a/template-variables", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ variables: [] }) });
  });

  for (const language of ["en", "de"] as const) {
    const expectedAction = language === "en" ? "Check in test area" : "Im Testbereich prüfen";
    for (const panel of ["faq", "text_commands"] as const) {
      await page.goto(`/tests/e2e/module-panels-stability-fixture.html?panel=${panel}&lang=${language}`);
      await expect(page.getByRole("button", { name: expectedAction, exact: true })).toBeEnabled();
    }
  }
});

test("keeps the first result row fixed when an input makes the result stale", async ({ browser }) => {
  const { page, close } = await openTestAreaWithLanguage(browser, "de-DE");
  await page.getByRole("button", { name: "Prüfen", exact: true }).click();
  const firstRow = page.locator(".test-area__result-row").first();
  await expect(firstRow).toBeVisible();
  const beforeY = await firstRow.evaluate((row) => row.getBoundingClientRect().y);

  await page.getByRole("textbox", { name: "Nachricht" }).fill("!dc geaendert");
  const afterY = await firstRow.evaluate((row) => row.getBoundingClientRect().y);
  expect(afterY).toBe(beforeY);
  await expect(page.locator(".test-area__results-head").getByTestId("test-area-stale-result-hint"))
    .toHaveText("Eingaben geändert – Prüfen aktualisiert das Ergebnis");
  await expect(page.getByTestId("test-area-results-slot").getByTestId("test-area-stale-result-hint")).toHaveCount(0);
  await close();
});
