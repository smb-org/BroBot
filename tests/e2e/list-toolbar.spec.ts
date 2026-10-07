import { expect, test } from "@playwright/test";

test.use({ locale: "en-US" });

const channelId = "list-toolbar-e2e";
const channel = {
  channelId,
  login: "toolbar-channel",
  displayName: "Toolbar Channel",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "toolbar-subscription", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: {
    botExpiresAt: "2099-09-20T08:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-09-20T08:00:00.000Z",
  },
  lastError: null,
};

test("list toolbar keeps its 44px control row and 20px status at desktop and 390px", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...channel, activeModules: [] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/members`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          members: [
            { userId: "alice-id", login: "alice", displayName: "Alice Example", profileImageUrl: null, role: "broadcaster", joinedAt: "2026-09-18T00:00:00.000Z" },
            { userId: "bob-id", login: "bob", displayName: "Bob Example", profileImageUrl: null, role: "operator", joinedAt: "2026-09-18T00:00:00.000Z" },
          ],
          broadcasterCount: 1,
          viewerUserId: "viewer-id",
          nextCursor: null,
        }),
      });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules: [] }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`/channels/${channelId}/members`);
  const toolbar = page.locator(".members-page__list-column .list-toolbar");
  const search = toolbar.getByRole("textbox", { name: "Search members" });
  const create = toolbar.getByRole("button", { name: "Grant access" });
  const status = toolbar.locator(".list-toolbar__status");
  await expect(search).toBeVisible();
  await expect(create).toBeVisible();
  await expect(status).toContainText("2 loaded");

  const desktopRow = await toolbar.locator(".list-toolbar__row").boundingBox();
  const desktopStatus = await status.boundingBox();
  expect(desktopRow?.height).toBe(44);
  expect(desktopStatus?.height).toBe(20);

  await search.fill("alice");
  await expect(page.getByText("Alice Example")).toBeVisible();
  await expect(page.getByText("Bob Example")).toHaveCount(0);
  await expect(status).toContainText("1 of 2 members");

  await page.setViewportSize({ width: 390, height: 844 });
  const searchBox = await toolbar.locator(".list-toolbar__search").boundingBox();
  const createBox = await create.boundingBox();
  const mobileRow = await toolbar.locator(".list-toolbar__row").boundingBox();
  const mobileStatus = await status.boundingBox();
  expect(mobileRow?.height).toBeGreaterThan(44);
  expect(searchBox).not.toBeNull();
  expect(createBox).not.toBeNull();
  expect(createBox?.y ?? 0).toBeGreaterThan(searchBox?.y ?? 0);
  expect(mobileStatus?.height).toBe(20);
  await expect(status).toContainText("1 of 2 members");
});
