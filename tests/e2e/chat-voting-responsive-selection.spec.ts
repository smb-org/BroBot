import { expect, test, type Page } from "@playwright/test";

import type { ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";

const routeJson = async (page: Page, path: string, value: unknown): Promise<void> => {
  await page.route(`**${path}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
};

test("the automatically opened desktop vote keeps its guarded draft across responsive changes", async ({ page }) => {
  const timestamp = "2030-01-01T12:00:00.000Z";
  const templates: ChatVoteTemplate[] = [
    { id: "template-auto", channelId: "channel-a", shortcut: "auto", title: "Automatically opened", resultText: "{vote.result}", labels: ["Yes", "No"], freeTextMode: null, durationSeconds: 60, revision: 1, legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp },
    { id: "template-next", channelId: "channel-a", shortcut: "next", title: "Next vote", resultText: "{vote.result}", labels: ["Up", "Down"], freeTextMode: null, durationSeconds: 120, revision: 1, legacyAlias: null, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp },
  ];
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/current", {
    vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60,
  });
  await routeJson(page, "/api/channels/channel-a/modules/chat_voting/templates", { templates, count: templates.length, maximum: 100 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/e2e/module-panels-stability-fixture.html?panel=chat_voting&lang=en");

  const inspector = page.locator(".chat-voting-template-inspector");
  const question = page.getByRole("textbox", { name: "Question" });
  await expect(question).toHaveValue("Automatically opened");
  await question.fill("Draft from the implicit selection");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inspector).toBeVisible();
  await expect(question).toHaveValue("Draft from the implicit selection");
  await expect(page.getByRole("dialog", { name: "Discard changes?" })).toHaveCount(0);

  await page.locator(".collection-page__detail-back").click();
  const mobileDialog = page.getByRole("dialog", { name: "Discard changes?" });
  await expect(mobileDialog).toBeVisible();
  await mobileDialog.getByRole("button", { name: "Continue editing" }).click();
  await expect(inspector).toBeVisible();
  await expect(question).toHaveValue("Draft from the implicit selection");

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(question).toHaveValue("Draft from the implicit selection");
  await page.locator(".chat-voting-template-list .list-row__link").nth(1).click();
  const dialog = page.getByRole("dialog", { name: "Discard changes?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Continue editing" }).click();
  await expect(question).toHaveValue("Draft from the implicit selection");
});
