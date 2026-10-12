import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const channelId = "stable-host-layout";
const channel = {
  channelId,
  login: "stable-channel",
  displayName: "Stable Channel",
  role: "manager",
  streamState: "online",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "stable-subscription", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: {
    botExpiresAt: "2099-09-20T08:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-09-20T08:00:00.000Z",
  },
  lastError: null,
};

const routes = [
  ["overview-root", "/"],
  ["overview", `/channels/${channelId}/overview`],
  ["events", `/channels/${channelId}/events`],
  ["audit", `/channels/${channelId}/audit`],
  ["members", `/channels/${channelId}/members`],
  ["variables", `/channels/${channelId}/variables`],
  ["modules", `/channels/${channelId}/modules`],
  ["system", `/channels/${channelId}/system`],
  ["overlays", `/channels/${channelId}/overlays`],
  ["overlay-editor", `/channels/${channelId}/overlays/layout-lock`],
  ["platform", "/platform"],
] as const;

const viewports = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "390x844", width: 390, height: 844 },
] as const;

const installApiMocks = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let body: unknown = {};

    if (pathname === "/api/channels") {
      body = { channels: [channel], bot: channel.bot, platformAdmin: true, viewerIsBot: false };
    } else if (pathname === "/api/platform") {
      body = { channels: [] };
    } else if (pathname === "/api/platform/audit") {
      body = { entries: [], nextCursor: null };
    } else if (pathname === `/api/channels/${channelId}/revisions`) {
      body = { revisions: {} };
    } else if (pathname === `/api/channels/${channelId}/overview`) {
      body = { ...channel, activeModules: [] };
    } else if (pathname === `/api/channels/${channelId}/settings`) {
      body = { timeZone: "UTC", revision: 1, location: null, locationRevision: 1 };
    } else if (pathname === `/api/channels/${channelId}/members`) {
      body = { members: [], nextCursor: null, broadcasterCount: 1, viewerUserId: "viewer" };
    } else if (pathname === `/api/channels/${channelId}/variables`) {
      body = { variables: [], count: 0, maximum: 25 };
    } else if (pathname === `/api/channels/${channelId}/overlays`) {
      body = { overlays: [], maximum: 20, elementMaximum: 20 };
    } else if (pathname === `/api/channels/${channelId}/overlay-tokens`) {
      body = { tokens: [], nextOffset: null };
    } else if (pathname === `/api/channels/${channelId}/audit-log`) {
      body = { entries: [], nextCursor: null };
    } else if (pathname === `/api/channels/${channelId}/modules`) {
      body = { modules: [] };
    } else if (pathname === `/api/channels/${channelId}/system`) {
      body = {
        broadcasterConnection: channel.broadcasterConnection,
        bot: channel.bot,
        botPermissions: null,
        broadcasterPermissions: null,
        chatSubscription: channel.chatSubscription,
        tokens: channel.tokens,
      };
    } else if (pathname === `/api/channels/${channelId}/events`) {
      body = { entries: [], nextCursor: null };
    } else if (pathname === "/api/csrf") {
      body = { token: "visual-test-token" };
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
};

test("captures the stable dashboard routes at desktop and mobile widths", async ({ page }) => {
  test.setTimeout(180_000);
  await installApiMocks(page);

  const outputDirectory = process.env.FOUNDATION_SCREENSHOT_DIR ?? join(tmpdir(), "brobot-foundation-visual");
  await mkdir(outputDirectory, { recursive: true });

  for (const [routeName, routePath] of routes) {
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(routePath);
      await expect(page.locator("#root")).toBeVisible();
      await page.waitForTimeout(500);
      if (routeName === "overview" && viewport.width >= 1280) {
        const locationReason = page.locator("#channel-location-remove-reason");
        const immediateActions = page.getByRole("group", { name: "Immediate actions" });
        const actionsSection = immediateActions.locator("..");
        await expect(locationReason).toBeVisible();
        await expect(immediateActions).toBeVisible();
        await expect.poll(async () => (await actionsSection.boundingBox())?.y).toBe(626.5);
        await expect(locationReason).toHaveCSS("margin-bottom", "11px");
      }
      await page.screenshot({
        path: join(outputDirectory, `${routeName}-${viewport.name}.png`),
        animations: "disabled",
      });
    }
  }
});

test("uses the default palette when browser storage throws", async ({ page }) => {
  await page.addInitScript(() => {
    const storage = window.localStorage;
    const originalGetItem = storage.getItem.bind(storage);
    const originalSetItem = storage.setItem.bind(storage);
    Storage.prototype.getItem = function (key: string): string | null {
      if (key === "brobot.palette") throw new Error("Storage is unavailable.");
      return originalGetItem(key);
    };
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === "brobot.palette") throw new Error("Storage is unavailable.");
      originalSetItem(key, value);
    };
  });
  await installApiMocks(page);
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-palette", "nachtschicht");
});
