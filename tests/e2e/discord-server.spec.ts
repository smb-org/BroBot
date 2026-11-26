import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eDiscordMockPort,
  e2eWorkerOrigin,
  e2eWorkerEnvironment,
  seedE2EDiscordServer,
} from "./worker-fixtures";

test.use({ locale: "en-US" });

const localWorkerHost = new URL(e2eWorkerOrigin).hostname;

test("connects a Discord server, saves a VIP role mapping, reloads it, then disconnects", async ({ page }) => {
  test.setTimeout(90_000);
  const channelId = "discord-server-e2e-channel";
  seedE2EDiscordServer(channelId);
  const credentials = createE2ESessionCredentials();
  await page.context().addCookies([
    { name: "__Host-brobot_session", value: credentials.cookie, domain: localWorkerHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__Host-brobot_csrf", value: credentials.csrfToken, domain: localWorkerHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
  ]);

  await page.goto(`${e2eWorkerOrigin}/channels/${channelId}/modules/discord`);
  await page.getByRole("button", { name: "Connect Discord server" }).click();
  await expect(page.locator(".discord-server-panel__status")).toContainText("Discord server connected");
  await expect(page.getByText("Lantern Harbor")).toBeVisible();

  const vipPicker = page.getByRole("combobox", { name: "VIP role" });
  await vipPicker.click();
  await expect(page.getByRole("option", { name: "@everyone" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "BroBot" })).toHaveCount(0);
  await page.getByRole("option", { name: "⚠ Harbor Sentinel" }).click();
  await expect(page.getByText("BroBot's highest role must be above this role.")).toBeVisible();
  const apiHeaders = {
    Cookie: `__Host-brobot_session=${credentials.cookie}`,
  };
  await expect.poll(async (): Promise<unknown> => (await page.request.get(
    `${e2eWorkerOrigin}/api/channels/${channelId}/modules/discord/server`, { headers: apiHeaders },
  )).json()).toMatchObject({ mappings: { vip: null, moderator: null } });

  await vipPicker.click();
  await page.getByRole("option", { name: "VIP" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Role mappings saved.").first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "VIP role" })).toContainText("VIP");

  await page.getByRole("button", { name: "Disconnect server" }).click();
  const confirmation = page.getByRole("dialog", { name: "Disconnect Discord server?" });
  await confirmation.getByRole("button", { name: "Disconnect server", exact: true }).click();
  await expect(page.locator(".discord-server-panel__status")).toContainText("No Discord server connected");
  await expect(page.getByRole("button", { name: "Connect Discord server" })).toBeVisible();
});

test("links a ranked viewer, reconciles the role, and shows the channel status", async ({ page }) => {
  test.setTimeout(90_000);
  const channelId = "discord-reconcile-e2e-ranked";
  seedE2EDiscordServer(channelId);
  await page.request.post(`http://127.0.0.1:${e2eDiscordMockPort}/__test/reset`);
  const credentials = createE2ESessionCredentials();
  await page.context().addCookies([
    { name: "__Host-brobot_session", value: credentials.cookie, domain: localWorkerHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__Host-brobot_csrf", value: credentials.csrfToken, domain: localWorkerHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
  ]);

  await page.goto(`${e2eWorkerOrigin}/channels/${channelId}/modules/discord`);
  await page.getByRole("button", { name: "Connect Discord server" }).click();
  await expect(page.locator(".discord-server-panel__status")).toContainText("Discord server connected");
  const vipPicker = page.getByRole("combobox", { name: "VIP role" });
  await vipPicker.click();
  await page.getByRole("option", { name: "VIP" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Role mappings saved.").first()).toBeVisible();

  await page.goto(`${e2eWorkerOrigin}/discord/link?lang=en`);
  await page.getByRole("link", { name: "Continue with Discord" }).click();
  await expect(page.getByRole("heading", { name: "Accounts linked" })).toBeVisible();

  const messageId = `eventsub-discord-rank-${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const payload = {
    subscription: {
      id: `subscription-vip-add-${randomUUID()}`,
      type: "channel.vip.add",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: channelId },
      transport: { method: "webhook", callback: `${e2eWorkerOrigin}/api/twitch/eventsub` },
      created_at: timestamp,
    },
    event: {
      broadcaster_user_id: channelId,
      broadcaster_user_login: "e2e-discord-broadcaster",
      broadcaster_user_name: "E2E Discord Broadcaster",
      user_id: "990000000000000301",
      user_login: "pixelpilot_e2e",
      user_name: "Pixel Pilot",
    },
  };
  const body = Buffer.from(JSON.stringify(payload));
  const keyRing = JSON.parse(e2eWorkerEnvironment.TWITCH_EVENTSUB_SECRET ?? "{}") as { active?: { key?: string } };
  const signingKey = keyRing.active?.key;
  if (signingKey === undefined) throw new Error("The E2E EventSub signing key is missing.");
  const signature = createHmac("sha256", signingKey).update(messageId).update(timestamp).update(body).digest("hex");
  const notification = await page.request.post(`${e2eWorkerOrigin}/api/twitch/eventsub`, {
    headers: {
      "Content-Type": "application/json",
      "Twitch-Eventsub-Message-Id": messageId,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": `sha256=${signature}`,
      "Twitch-Eventsub-Message-Type": "notification",
    },
    data: body,
  });
  expect(notification.status()).toBe(204);

  // Secure cookies are only sent by the browser itself on this plain-HTTP origin, so these calls run in the page.
  const runJob = async (jobId: string): Promise<number> => await page.evaluate(async (jobPath: string): Promise<number> => {
    const csrfResponse = await fetch("/api/csrf", { credentials: "same-origin" });
    const csrf: { token?: string } = await csrfResponse.json();
    const response = await fetch(jobPath, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf.token ?? "" } });
    return response.status;
  }, `/api/channels/${channelId}/jobs/${jobId}/run`);
  expect(await runJob("host:twitch_ranks:reconcile")).toBe(200);
  expect(await runJob("module:discord:reconcile")).toBe(200);

  await expect.poll(async () => await page.evaluate(async (): Promise<string> => {
    const response = await fetch("/api/discord/link", { credentials: "same-origin" });
    const result: { channels?: Array<{ status: string }> } = await response.json();
    return result.channels?.find(({ status }) => status !== "unknown")?.status ?? "pending";
  }), { timeout: 20_000 }).toBe("has_role");

  await expect.poll(async () => {
    const response = await page.request.get(
      `http://127.0.0.1:${e2eDiscordMockPort}/api/v10/guilds/990000000000000101/members/990000000000000203`,
    );
    const member = (await response.json()) as { roles: string[] };
    return member.roles;
  }).toContain("990000000000000102");

  await page.goto(`${e2eWorkerOrigin}/discord/link?lang=en`);
  await expect(page.getByRole("heading", { name: "Accounts linked" })).toBeVisible();
  await expect(page.getByText("E2E Kanal")).toBeVisible();
  await expect(page.getByText("Role present", { exact: true })).toBeVisible({ timeout: 20_000 });
});
