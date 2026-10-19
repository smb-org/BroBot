import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eWorkerEnvironment,
  e2eWorkerOrigin,
  e2eWorkerPersist,
  seedE2ETestArea,
} from "./worker-fixtures";

const localWorkerHost = new URL(e2eWorkerOrigin).hostname;

const seedChatVotingModule = (channelId: string): void => {
  const sql = `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
    VALUES ('${channelId}', 'chat_voting', 1, '{"startText":""}');`;
  const result = spawnSync("./node_modules/.bin/wrangler", [
    "--cwd", "dist/brobot_local", "--config", "wrangler.json", "d1", "execute", "DB", "--local", "--yes",
    "--persist-to", e2eWorkerPersist, "--command", sql,
  ], {
    encoding: "utf8",
    env: { ...process.env, CI: "1", ...e2eWorkerEnvironment },
  });
  if (result.status !== 0) throw new Error(`Could not seed chat voting for the local Worker.\n${result.stdout}\n${result.stderr}`);
};

const createTestArea = async (browser: Browser, channelId: string): Promise<{ page: Page; close: () => Promise<void> }> => {
  seedE2ETestArea(channelId);
  seedChatVotingModule(channelId);
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  const credentials = createE2ESessionCredentials();
  await context.addCookies([
    {
      name: "__Host-brobot_session", value: credentials.cookie, domain: localWorkerHost, path: "/",
      secure: true, httpOnly: true, sameSite: "Lax",
    },
    {
      name: "__Host-brobot_csrf", value: credentials.csrfToken, domain: localWorkerHost, path: "/",
      secure: true, httpOnly: true, sameSite: "Lax",
    },
  ]);
  await page.goto(`${e2eWorkerOrigin}/channels/${channelId}/test-area`);
  await expect(page.getByRole("heading", { name: "Test area" })).toBeVisible();
  return { page, close: () => context.close() };
};

const startVote = async (page: Page, channelId: string, kind: "options" | "free_text"): Promise<void> => {
  const result = await page.evaluate(async ({ id, voteKind }) => {
    const csrfResponse = await fetch("/api/csrf");
    const csrf: unknown = await csrfResponse.json();
    if (typeof csrf !== "object" || csrf === null || !("token" in csrf) || typeof csrf.token !== "string") {
      throw new Error("CSRF token response was invalid");
    }
    const response = await fetch(`/api/channels/${id}/modules/chat_voting/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({
        kind: voteKind,
        optionCount: voteKind === "options" ? 2 : undefined,
        durationSeconds: 14_400,
        title: "",
        ...(voteKind === "options" ? { labels: ["Option 1", "Option 2"] } : { textMode: "whole_message" }),
      }),
    });
    return { status: response.status, body: await response.json() };
  }, { id: channelId, voteKind: kind });
  expect(result.status).toBe(200);
  expect(result.body).toHaveProperty("vote.status", "open");
};

const runMessage = async (page: Page, message: string): Promise<void> => {
  const form = page.locator(".test-area__mobile-message:visible, .test-area__context-form:visible").first();
  await form.locator("input[type='text']").first().fill(message);
  await form.locator(".test-area__run-button").click();
  await expect(page.locator(".test-area__result-row")).toBeVisible();
};

test("localizes an untitled ballot in English through the real Worker", async ({ browser }) => {
  const channelId = `channel-r11-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const { page, close } = await createTestArea(browser, channelId);
  try {
    await startVote(page, channelId, "options");
    await runMessage(page, "1");

    const row = page.locator(".test-area__result-row");
    await expect(row).toContainText("Untitled vote");
    await expect(row.locator(".test-area__row-main > small")).toHaveText("Option 1");
    await row.click();
    await expect(page.locator(".test-area__detail h2")).toHaveText("Untitled vote");
  } finally {
    await close();
  }
});

test("treats a numeric free-text vote as a term through the real Worker", async ({ browser }) => {
  const channelId = `channel-r11-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const { page, close } = await createTestArea(browser, channelId);
  try {
    await startVote(page, channelId, "free_text");
    await runMessage(page, "123");

    const row = page.locator(".test-area__result-row");
    await expect(row).toContainText("Untitled vote");
    await expect(row.locator(".test-area__row-main > small")).toHaveText("Term “123”");
    await row.click();
    await expect(page.locator(".test-area__detail")).toContainText("The message “123” votes for the term “123”.");
  } finally {
    await close();
  }
});
