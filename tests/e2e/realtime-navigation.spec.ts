import { expect, test } from "@playwright/test";

const channelId = "realtime-navigation-e2e";
const channel = {
  channelId,
  login: "realtime-navigation",
  displayName: "Realtime Navigation",
  language: "en",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-10-10T00:00:00.000Z" },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: "2026-10-10T00:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "realtime-sub", reason: null, updatedAt: "2026-10-10T00:00:00.000Z" },
  chatSubscriptionNeeded: false,
  modules: [],
  tokens: {
    botExpiresAt: "2099-09-20T08:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-09-20T08:00:00.000Z",
  },
  lastError: null,
};

test.use({ locale: "en-US" });

test("keeps one channel socket open while dashboard navigation changes pages", async ({ page }) => {
  let opened = 0;
  let closed = 0;
  page.on("websocket", (socket) => {
    opened += 1;
    socket.on("close", () => { closed += 1; });
  });
  await page.routeWebSocket(`**/ws/channels/${channelId}`, (socket) => {
    socket.onMessage(() => undefined);
  });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ channels: [channel], viewerUserId: "viewer-e2e", bot: channel.bot }),
      });
    } else if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...channel, activeModules: [] }) });
    } else if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules: [] }) });
    } else if (pathname === `/api/channels/${channelId}/settings`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ timeZone: "UTC", revision: 1, location: null, locationRevision: 0 }) });
    } else if (pathname === `/api/channels/${channelId}/events`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [], nextCursor: null }) });
    } else if (pathname === `/api/channels/${channelId}/members`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ members: [], broadcasterCount: 0, viewerUserId: "viewer-e2e", nextCursor: null }) });
    } else if (pathname === `/api/channels/${channelId}/revisions`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revisions: {} }) });
    } else {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
  });

  await page.goto(`/channels/${channelId}`);
  await expect(page.getByRole("heading", { name: channel.displayName, level: 1 })).toBeVisible();
  await expect.poll(() => opened).toBe(1);

  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  await sidebar.getByRole("button", { name: /Search or run action/u }).click();
  const spotlight = page.getByRole("dialog");
  await spotlight.getByRole("textbox").fill("Members");
  await spotlight.locator('[data-spotlight-item-id="page:members"]').click();
  await expect(page).toHaveURL(`/channels/${channelId}/members`);
  await expect(page.getByRole("heading", { name: "Members", level: 1 })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(`/channels/${channelId}`);
  await expect(page.getByRole("heading", { name: channel.displayName, level: 1 })).toBeVisible();
  await expect.poll(() => ({ opened, closed })).toEqual({ opened: 1, closed: 0 });
});
