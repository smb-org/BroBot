import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { expect, test } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eWorkerEnvironment,
  e2eWorkerOrigin,
  e2eWorkerPersist,
  seedE2ETestArea,
} from "./worker-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

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

test("counts a seeded open chat vote through the real Worker and shows its ballot effect", async ({ page }) => {
  const channelId = `channel-vote-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  seedE2ETestArea(channelId);
  seedChatVotingModule(channelId);
  const credentials = createE2ESessionCredentials();
  await page.context().addCookies([
    {
      name: "__Host-brobot_session",
      value: credentials.cookie,
      domain: localWorkerHost,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "__Host-brobot_csrf",
      value: credentials.csrfToken,
      domain: localWorkerHost,
      path: "/",
      secure: true,
      sameSite: "Lax",
    },
  ]);

  await page.goto(`${e2eWorkerOrigin}/channels/${channelId}/test-area`);
  await expect(page.locator(".test-area")).toBeVisible();
  const startResult = await page.evaluate(async (id) => {
    const csrfResponse = await fetch("/api/csrf");
    const csrf = await csrfResponse.json();
    if (typeof csrf !== "object" || csrf === null || !("token" in csrf) || typeof csrf.token !== "string") {
      throw new Error("CSRF token response was invalid");
    }
    const response = await fetch(`/api/channels/${id}/modules/chat_voting/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({
        kind: "options",
        optionCount: 2,
        durationSeconds: 14_400,
        title: "Lieblingsspiel",
        labels: ["Celeste", "Hades"],
      }),
    });
    const body = await response.json();
    const vote = typeof body === "object" && body !== null && "vote" in body ? body.vote : null;
    const voteStatus = typeof vote === "object" && vote !== null && "status" in vote && typeof vote.status === "string"
      ? vote.status
      : null;
    const voteId = typeof vote === "object" && vote !== null && "id" in vote && typeof vote.id === "string"
      ? vote.id
      : null;
    return { status: response.status, voteStatus, voteId };
  }, channelId);
  expect(startResult.status).toBe(200);
  expect(startResult.voteStatus).toBe("open");
  expect(startResult.voteId).not.toBeNull();

  // The real Worker and persisted D1 read can take longer than a mocked request under concurrent E2E load.
  await expect.poll(() => page.evaluate(async (id) => {
    const response = await fetch(`/api/channels/${id}/modules/chat_voting/current`);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("vote" in body)) return null;
    const vote = body.vote;
    if (typeof vote !== "object" || vote === null || !("id" in vote) || typeof vote.id !== "string" || !("status" in vote) || typeof vote.status !== "string") return null;
    return { id: vote.id, status: vote.status };
  }, channelId), { timeout: 15_000, intervals: [100, 250, 500] }).toEqual({ id: startResult.voteId, status: "open" });

  const messageField = page.getByRole("textbox", { name: "Nachricht" });
  await expect(messageField).toBeVisible();
  await messageField.fill("2");
  await page.locator(".test-area__context-form .test-area__run-button").click();
  const row = page.locator(".test-area__result-row");
  await expect(row).toContainText("Lieblingsspiel");
  await expect(row).toContainText("Option 2");
  await expect(row).toContainText("Würde Stimme 2 zählen");
  await row.click();
  await expect(page.locator(".test-area__detail")).toContainText("Die Nachricht „2“ wählt Option 2.");
  await expect(page.locator(".test-area__detail")).toContainText("Option 1: 0 · Option 2: 1");
});
