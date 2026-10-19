import { expect, test, type Page } from "@playwright/test";

import type { DryRunEntryReport, DryRunModuleReport, DryRunResponse } from "../../src/contracts/dry-run";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE" });

const CHANNEL_ID = "test-area-voting-votekick";

const responseFor = (...modules: DryRunModuleReport[]): DryRunResponse => ({
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls: { muted: false, paused: false },
  sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
  modules,
});

const report = (moduleId: "chat_voting" | "votekick", value: Omit<DryRunEntryReport, "moduleId">): DryRunEntryReport => ({
  moduleId,
  ...value,
});

const voteCountResponse = (): DryRunResponse => responseFor({
  moduleId: "chat_voting",
  status: "reacts",
  entries: [report("chat_voting", {
    entry: { kind: "chat_vote", id: "chat-vote-message", label: "Stimme 2" },
    outcome: "fires",
    match: { kind: "command_name", token: "!vote" },
    blocks: [],
    effects: [{ kind: "ballot", moduleId: "chat_voting", action: "count", label: "Lieblingsspiel", choice: "2", counts: [1234, 2345] }],
    templateNotes: [],
  })],
});

const voteOverflowResponse = (): DryRunResponse => responseFor({
  moduleId: "chat_voting",
  status: "reacts",
  entries: [report("chat_voting", {
    entry: { kind: "chat_vote", id: "chat-vote-message", label: "Lieblingsspiel" },
    outcome: "fires",
    match: { kind: "command_name", token: "!vote" },
    blocks: [],
    effects: [{
      kind: "ballot", moduleId: "chat_voting", action: "overflow", label: "Lieblingsspiel",
      counts: [3, 2], terms: [{ term: "Celeste", count: 2, approved: true }], more: 4,
    }],
    templateNotes: [],
  })],
});

const voteFinalizeResponse = (): DryRunResponse => responseFor({
  moduleId: "chat_voting",
  status: "reacts",
  entries: [report("chat_voting", {
    entry: { kind: "chat_vote", id: "chat-vote-message", label: "!vote end" },
    outcome: "fires",
    match: { kind: "command_name", token: "!vote" },
    blocks: [],
    effects: [{
      kind: "ballot", moduleId: "chat_voting", action: "finalize", label: "Lieblingsspiel",
      counts: [1234, 2345], terms: [{ term: "Celeste", count: 2345, approved: true }], more: 2,
    }],
    templateNotes: [],
  })],
});

const votekickStartResponse = (): DryRunResponse => responseFor({
  moduleId: "votekick",
  status: "reacts",
  entries: [report("votekick", {
    entry: { kind: "votekick", id: "votekick-message", label: "!votekick spieler_demo" },
    outcome: "fires",
    match: { kind: "command_name", token: "!votekick" },
    blocks: [],
    effects: [{ kind: "ballot", moduleId: "votekick", action: "start", label: "spieler_demo", counts: [1, 0] }],
    templateNotes: [],
  })],
});

const indeterminateVotekickResponse = (): DryRunResponse => responseFor({
  moduleId: "votekick",
  status: "indeterminate",
  entries: [report("votekick", {
    entry: { kind: "votekick", id: "votekick-message", label: "!votekick spieler_demo" },
    outcome: "indeterminate",
    match: { kind: "command_name", token: "!votekick" },
    blocks: [],
    effects: [],
    templateNotes: [{ code: "template.deferred_live", detail: { name: "votekick.target" } }],
  })],
});

const blockedVotekickResponse = (): DryRunResponse => responseFor({
  moduleId: "votekick",
  status: "blocked",
  entries: [report("votekick", {
    entry: { kind: "votekick", id: "votekick-message", label: "!votekick geschuetzter_spieler" },
    outcome: "blocked",
    match: { kind: "command_name", token: "!votekick" },
    blocks: [{ code: "votekick.target_protected", detail: { target: "protected-user-id" } }],
    effects: [{
      kind: "chat", text: "A votekick cannot be started for this user.", target: "source_only", postsTo: "this_chat",
      reply: true, suppressedBy: null, automated: false,
    }],
    templateNotes: [],
  })],
});

const blockedVoteCommandResponse = (): DryRunResponse => responseFor({
  moduleId: "chat_voting",
  status: "blocked",
  entries: [report("chat_voting", {
    entry: { kind: "chat_vote", id: "chat-vote-message", label: "!vote 2" },
    outcome: "blocked",
    match: { kind: "command_name", token: "!vote" },
    blocks: [{ code: "chat_voting.permission_denied" }],
    effects: [],
    templateNotes: [],
  })],
});

const openTestArea = async (page: Page, response: DryRunResponse, width = 1920, height = 1080): Promise<void> => {
  await installLiveCockpitMocks(page, {
    channelId: CHANNEL_ID,
    role: "manager",
    streamState: "online",
    modules: [
      { id: "text_commands", enabled: true, settings: "{}" },
      { id: "faq", enabled: true, settings: "{}" },
      { id: "chat_voting", enabled: true, settings: "{}" },
      { id: "votekick", enabled: true, settings: "{}" },
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

const runMessage = async (page: Page, message: string): Promise<void> => {
  const field = page.locator(".test-area__context-form input:visible, .test-area__mobile-message input:visible").first();
  await field.fill(message);
  await page.getByRole("button", { name: "Prüfen", exact: true }).first().click();
};

test("shows a counted chat vote with localized counts and the vote-specific explanation", async ({ page }) => {
  await openTestArea(page, voteCountResponse());
  await runMessage(page, "!vote 2");

  const row = page.locator(".test-area__result-row");
  await expect(row).toContainText("Lieblingsspiel");
  await expect(row).toContainText("Option 2");
  await expect(row).toContainText("Würde Stimme 2 zählen");
  await row.click();

  const detail = page.locator(".test-area__detail");
  await expect(detail).toContainText("Die Nachricht „!vote 2“ wählt Option 2.");
  await expect(detail).toContainText("Stimme würde der laufenden Abstimmung zugeordnet");
  await expect(detail).toContainText("Option 1: 1.234 · Option 2: 2.345");
  await expect(detail.getByRole("button", { name: "Im Editor öffnen" })).toHaveCount(0);

  await page.getByLabel("Module").click();
  await expect(page.getByRole("option", { name: "Abstimmung" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Votekick" })).toBeVisible();
});

test("shows overflow and finalization ballot details", async ({ page }) => {
  await openTestArea(page, voteOverflowResponse());
  await runMessage(page, "Celeste");
  const overflowRow = page.locator(".test-area__result-row");
  await expect(overflowRow).toContainText("Würde unter „weitere“ zählen");
  await overflowRow.click();
  await expect(page.locator(".test-area__detail")).toContainText("Stimme würde unter „weitere“ zählen");
  await expect(page.locator(".test-area__detail")).toContainText("4 weitere");
  await expect(page.locator(".test-area__detail")).toContainText("Celeste · 2");

  await openTestArea(page, voteFinalizeResponse());
  await runMessage(page, "!vote end");
  const finalizeRow = page.locator(".test-area__result-row");
  await expect(finalizeRow).toContainText("Würde Abstimmung beenden");
  await finalizeRow.click();
  await expect(page.locator(".test-area__detail")).toContainText("Option 1: 1.234 · Option 2: 2.345");
  await expect(page.locator(".test-area__detail")).toContainText("Celeste · 2.345");
});

test("shows a votekick target row and target-specific explanation without a dead editor link", async ({ page }) => {
  await openTestArea(page, votekickStartResponse());
  await runMessage(page, "!votekick spieler_demo");

  const row = page.locator(".test-area__result-row");
  await expect(row).toContainText("Ziel „spieler_demo“");
  await expect(row).toContainText("Würde Votekick starten");
  await row.click();
  const detail = page.locator(".test-area__detail");
  await expect(detail).toContainText("Die Nachricht „!votekick spieler_demo“ nennt das Ziel „spieler_demo“.");
  await expect(detail).toContainText("Ja: 1 · Nein: 0");
  await expect(detail.getByRole("button", { name: "Im Editor öffnen" })).toHaveCount(0);
});

test("marks a deferred votekick target as neutral and shows its send-time note", async ({ page }) => {
  await openTestArea(page, indeterminateVotekickResponse());
  await runMessage(page, "!votekick spieler_demo");

  const row = page.locator(".test-area__result-row");
  await expect(row).toContainText("Noch offen");
  await expect(row).not.toContainText("Würde antworten");
  await row.click();
  await expect(page.locator(".test-area__detail")).toContainText("Das Ziel wird beim Senden geprüft.");
});

test("shows the target-protection reason for a blocked votekick", async ({ page }) => {
  await openTestArea(page, blockedVotekickResponse());
  await runMessage(page, "!votekick geschuetzter_spieler");

  const row = page.locator(".test-area__result-row");
  await expect(row).toContainText("Ziel „geschuetzter_spieler“");
  await expect(row).toContainText("Blockiert");
  await row.click();
  await expect(page.locator(".test-area__detail")).toContainText("Das Ziel ist geschützt.");
  await expect(page.locator(".test-area__detail")).toContainText("Die Nachricht „!votekick geschuetzter_spieler“ nennt das Ziel „geschuetzter_spieler“.");
});

test("shows the permission reason for a blocked voting command", async ({ page }) => {
  await openTestArea(page, blockedVoteCommandResponse());
  await runMessage(page, "!vote 2");

  const row = page.locator(".test-area__result-row");
  await expect(row).toContainText("Abstimmungsbefehl");
  await expect(row).toContainText("Blockiert");
  await row.click();
  const detail = page.locator(".test-area__detail");
  await expect(detail).toContainText("Der Absender erfüllt die Mindestrolle nicht.");
  await expect(detail).toContainText("Die Nachricht „!vote 2“ startet oder verwaltet eine Abstimmung.");
});

test("opens a bounded mobile vote detail with the ballot title", async ({ page }) => {
  await openTestArea(page, voteCountResponse(), 390, 844);
  await runMessage(page, "!vote 2");
  await page.locator(".test-area__result-row").click();

  const dialog = page.getByRole("dialog", { name: "Lieblingsspiel" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Option 1: 1.234 · Option 2: 2.345");
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? Infinity)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
