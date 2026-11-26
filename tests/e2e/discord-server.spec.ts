import { expect, test } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eWorkerOrigin,
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
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Role mappings saved.").first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "VIP role" })).toContainText("VIP");

  await page.getByRole("button", { name: "Disconnect server" }).click();
  const confirmation = page.getByRole("dialog", { name: "Disconnect Discord server?" });
  await confirmation.getByRole("button", { name: "Disconnect server", exact: true }).click();
  await expect(page.locator(".discord-server-panel__status")).toContainText("No Discord server connected");
  await expect(page.getByRole("button", { name: "Connect Discord server" })).toBeVisible();
});
