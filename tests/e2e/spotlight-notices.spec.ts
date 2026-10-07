import { expect, test } from "@playwright/test";

test.use({ locale: "en-US" });

test("Spotlight trigger and channel notices work on desktop and mobile", async ({ page }) => {
  const modules = [
    { id: "ads", enabled: false, settings: "{}", missingBroadcasterScopes: ["channel:manage:ads"] },
  ];
  const channel = {
    channelId: "kanal-e2e",
    login: "brotkrumen-kanal",
    displayName: "Brotkrumen Channel",
    language: "en",
    role: "manager",
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: new Date().toISOString() },
    botPermissions: { missingScopes: ["moderator:manage:banned_users"] },
    broadcasterPermissions: { missingScopes: [] },
    moderator: { isModerator: false, checkedAt: new Date().toISOString(), reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "sub-e2e", reason: null, updatedAt: new Date().toISOString() },
    chatSubscriptionNeeded: false,
    modules,
    tokens: {
      botExpiresAt: "2099-09-20T08:00:00.000Z",
      loginStatus: "connected",
      loginReason: null,
      loginExpiresAt: "2099-09-20T08:00:00.000Z",
    },
    lastError: null,
  };

  await page.route("**/api/channels**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        channels: [channel],
        viewerUserId: "viewer-e2e",
        bot: channel.bot,
        platformAdmin: false,
        viewerIsBot: false,
      }) });
      return;
    }
    if (pathname === "/api/channels/kanal-e2e/overview") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...channel, activeModules: [] }) });
      return;
    }
    if (pathname === "/api/channels/kanal-e2e/modules") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules }) });
      return;
    }
    if (pathname === "/api/channels/kanal-e2e/settings") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 0 }) });
      return;
    }
    if (pathname === "/api/channels/kanal-e2e/events") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [], nextCursor: null }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto("/channels/kanal-e2e");
  await expect(page.getByRole("heading", { name: "Brotkrumen Channel", level: 1 })).toBeVisible();

  const notices = page.getByRole("region", { name: "Notices" });
  await expect(notices.getByRole("heading", { name: "Notices 3" })).toBeVisible();
  await expect(notices.locator(".state-row")).toHaveCount(2);
  await expect(notices).toHaveAttribute("data-status", "error");

  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  const spotlightTrigger = sidebar.getByRole("button", { name: "Search or run action …" });
  await expect(spotlightTrigger).toBeVisible();
  await expect(spotlightTrigger.locator(".sidebar__spotlight-shortcut")).toHaveText(/^(⌘K|Ctrl\+K)$/u);
  await spotlightTrigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(spotlightTrigger).toHaveCSS("width", "44px");
  await expect(spotlightTrigger.locator(".sidebar__spotlight-label")).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Expand sidebar" }).click();

  await page.getByRole("button", { name: "Show all 3 notices" }).click();
  await expect(notices.locator(".state-row")).toHaveCount(3);
  for (const row of await notices.locator(".state-row").all()) {
    await expect(row.locator(".state-row__detail")).not.toBeEmpty();
    await expect(row.locator(".state-row__action button, .state-row__action a")).toHaveCount(1);
  }
  const modulePermissionButton = notices.getByRole("button", { name: "Grant permission" });
  await expect(modulePermissionButton).toBeDisabled();
  await expect(page.locator(`#${await modulePermissionButton.getAttribute("aria-describedby") ?? ""}`)).toHaveText(/Only this channel’s broadcaster/u);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBurger = page.getByRole("button", { name: "Open sidebar" });
  await expect(mobileBurger).toBeVisible();
  await mobileBurger.click();
  await expect(spotlightTrigger).toBeVisible();
  await spotlightTrigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(notices.locator(".state-row")).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
