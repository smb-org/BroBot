import { expect, test, type Page } from "@playwright/test";

import type { DryRunEntryReport, DryRunModuleReport, DryRunResponse } from "../../src/contracts/dry-run";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE" });

const CHANNEL_ID = "test-area-pr3-r11";

const responseFor = (...modules: DryRunModuleReport[]): DryRunResponse => ({
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls: { muted: false, paused: false },
  sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
  modules,
});

const report = (
  moduleId: "chat_voting" | "votekick",
  entry: DryRunEntryReport["entry"],
  options: { effect?: DryRunEntryReport["effects"][number]; outcome?: DryRunEntryReport["outcome"]; templateNotes?: DryRunEntryReport["templateNotes"] } = {},
): DryRunModuleReport => ({
  moduleId,
  status: options.outcome === "indeterminate" ? "indeterminate" : "reacts",
  entries: [{
    moduleId,
    entry,
    outcome: options.outcome ?? "fires",
    match: { kind: "command_name", token: moduleId === "votekick" ? "!votekick" : "!vote" },
    blocks: [],
    effects: options.effect === undefined ? [] : [options.effect],
    templateNotes: options.templateNotes ?? [],
  }],
});

const voteCount = (choice = "2", choiceKind?: "option" | "term", label = "Lieblingsspiel"): DryRunResponse => {
  const effect = Object.assign({
    kind: "ballot" as const,
    moduleId: "chat_voting" as const,
    action: "count" as const,
    label,
    choice,
    counts: [1234, 2345],
  }, choiceKind === undefined ? {} : { choiceKind });
  return responseFor(report("chat_voting", { kind: "chat_vote", id: "chat-vote-message", label: "Stimme !vote 2" }, { effect }));
};

const voteFinalize = (): DryRunResponse => responseFor(report("chat_voting", {
  kind: "chat_vote", id: "chat-vote-message", label: "!vote end",
}, { effect: {
  kind: "ballot", moduleId: "chat_voting", action: "finalize", label: "Lieblingsspiel",
  counts: [1234, 2345], terms: [{ term: "Celeste", count: 2345, approved: true }], more: 2,
} }));

const votekickPending = (): DryRunResponse => responseFor(report("votekick", {
  kind: "votekick", id: "votekick-message", label: "!votekick spieler_demo",
}, { outcome: "indeterminate", templateNotes: [{ code: "template.deferred_live", detail: { name: "votekick.target" } }] }));

const moduleResult = (moduleId: "chat_voting" | "votekick"): DryRunResponse => responseFor(report(
  moduleId,
  moduleId === "chat_voting"
    ? { kind: "chat_vote", id: "chat-vote-message", label: "Stimme !vote 2" }
    : { kind: "votekick", id: "votekick-message", label: "!votekick spieler_demo" },
  { effect: moduleId === "chat_voting"
    ? { kind: "ballot", moduleId, action: "count", label: "Lieblingsspiel", choice: "2", counts: [1, 0] }
    : { kind: "ballot", moduleId, action: "start", label: "spieler_demo", counts: [1, 0] } },
));

const openTestArea = async (page: Page, response: DryRunResponse, width: number, height: number): Promise<void> => {
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
  await page.route(`**/api/channels/${CHANNEL_ID}/dry-run`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.route(`**/api/channels/${CHANNEL_ID}/modules/*/settings`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings: {}, revision: 1, variables: [] }) });
  });
  await page.route(`**/api/channels/${CHANNEL_ID}/template-variables`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ variables: [] }) });
  });
  await page.setViewportSize({ width, height });
  await page.goto(`/channels/${CHANNEL_ID}/test-area`);
  await expect(page.getByRole("heading", { name: "Testbereich" })).toBeVisible();
};

const runMessage = async (page: Page, message: string): Promise<void> => {
  const form = page.locator(".test-area__mobile-message:visible, .test-area__context-form:visible").first();
  await form.locator("input[type='text']").first().fill(message);
  await form.locator(".test-area__run-button").click();
  await expect(page.locator(".test-area__result-row")).toBeVisible();
};

test("keeps the deferred votekick target check under its own heading", async ({ page }) => {
  await openTestArea(page, votekickPending(), 1920, 1080);
  await runMessage(page, "!votekick spieler_demo");

  const detail = page.locator(".test-area__detail");
  const pendingSection = detail.locator(".test-area__detail-section").filter({ has: page.getByRole("heading", { name: "Noch offen" }) });
  await expect(pendingSection).toContainText("Das Ziel wird beim Senden geprüft.");
  await expect(detail.getByRole("heading", { name: "Vorlagenhinweise" })).toHaveCount(0);
});

test("keeps the vote finalization status on one line at 1280 by 800", async ({ page }) => {
  await openTestArea(page, voteFinalize(), 1280, 800);
  await runMessage(page, "!vote end");

  const row = page.locator(".test-area__result-row");
  await expect(row).toContainText("Würde Abstimmung beenden");
  const metrics = await row.evaluate((element) => {
    const status = element.querySelector<HTMLElement>(".test-area__row-outcome > span:last-child");
    if (status === null) throw new Error("The result status text is missing.");
    return {
      whiteSpace: getComputedStyle(status).whiteSpace,
      statusHeight: status.getBoundingClientRect().height,
      rowHeight: element.getBoundingClientRect().height,
    };
  });
  expect(metrics.whiteSpace).toBe("nowrap");
  expect(metrics.rowHeight).toBe(62);
  expect(metrics.statusHeight).toBeLessThanOrEqual(14);
});

test("describes a numeric free-text vote using its ballot choice metadata", async ({ page }) => {
  await openTestArea(page, voteCount("123", "term"), 1920, 1080);
  await runMessage(page, "123");

  await expect(page.locator(".test-area__row-main small")).toHaveText("Begriff „123“");
  await expect(page.locator(".test-area__detail")).toContainText("stimmt für den Begriff „123“");
});

for (const moduleId of ["chat_voting", "votekick"] as const) {
  for (const viewport of [
    { name: "desktop", width: 1920, height: 1080 },
    { name: "mobile dialog", width: 390, height: 844 },
  ]) {
    test(`opens ${moduleId} settings from the ${viewport.name} result detail`, async ({ page }) => {
      await openTestArea(page, moduleResult(moduleId), viewport.width, viewport.height);
      await runMessage(page, moduleId === "votekick" ? "!votekick spieler_demo" : "!vote 2");
      if (viewport.width <= 1279) {
        await page.locator(".test-area__result-row").click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Im Editor öffnen" }).click();
      } else {
        await page.locator(".test-area__detail").getByRole("button", { name: "Im Editor öffnen" }).click();
      }
      await expect(page).toHaveURL(new RegExp(`/channels/${CHANNEL_ID}/modules/${moduleId}$`, "u"));
    });
  }
}
