import { expect, test, type Route } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

test("a mobile settings conflict is announced without moving the editor", async ({ page }) => {
  const channelId = "issue-434-r5-conflict";
  const module = { id: "ads", enabled: true, settings: "{}" };
  const settings = {
    automatic: "Werbepause beginnt: {ads.duration} Sekunden.",
    manual: "Manuell gestartete Werbung",
    automaticTarget: "source_only",
    manualTarget: "source_only",
    leadSeconds: 60,
    prewarningText: "Werbung in {ads.seconds} Sekunden.",
    prewarningTarget: "source_only",
  };
  const now = new Date().toISOString();
  const channel = {
    channelId,
    login: "beispielkanal",
    displayName: "Beispielkanal",
    language: "de",
    role: "manager",
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: now },
    botPermissions: { missingScopes: [] },
    broadcasterPermissions: { missingScopes: [] },
    moderator: { isModerator: true, checkedAt: now, reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "issue-434", reason: null, updatedAt: now },
    chatSubscriptionNeeded: false,
    modules: [module],
    tokens: { botExpiresAt: "2099-01-01T00:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-01-01T00:00:00.000Z" },
    lastError: null,
  };

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [channel], viewerUserId: "issue-434-viewer", bot: channel.bot, platformAdmin: false, viewerIsBot: false }));
    if (pathname === `/api/channels/${channelId}/overview`) return route.fulfill(json({ ...channel, activeModules: [{ moduleId: "ads", settings: "{}" }] }));
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules: [module] }));
    if (pathname === `/api/channels/${channelId}/settings`) return route.fulfill(json({ defaultChatTarget: "source_only", defaultChatTargetRevision: 1, timeZone: "Europe/Berlin", revision: 1 }));
    if (pathname === `/api/channels/${channelId}/revisions`) return route.fulfill(json({ revisions: {} }));
    if (pathname === `/api/channels/${channelId}/variables`) return route.fulfill(json({ variables: [], count: 0, maximum: 100 }));
    if (pathname === `/api/channels/${channelId}/modules/text_commands/commands`) return route.fulfill(json({ commands: [], variables: [] }));
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "issue-434-csrf" }));
    if (pathname === `/api/channels/${channelId}/modules/ads/settings`) {
      if (request.method() === "PATCH") return route.fulfill(json({ error: "module_settings_changed_concurrently" }, 409));
      return route.fulfill(json({ settings, revision: 1, variables: [] }));
    }
    if (pathname === `/api/channels/${channelId}/modules/ads/schedule`) {
      return route.fulfill(json({
        schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: 0, snoozeRefreshAt: null },
        recentAdBreaks: [],
        snoozeScopeAvailable: true,
      }));
    }
    return route.fulfill(json({}));
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}/modules/ads`);

  const message = page.getByRole("textbox", { name: "Vorwarnung" });
  await expect(message).toBeVisible();
  const columns = page.locator(".settings-page__columns");
  const before = await columns.boundingBox();
  expect(before).not.toBeNull();

  await message.fill("Mein Entwurf {ads.seconds}");
  await page.getByRole("button", { name: "Speichern" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Ansagen-Einstellungen wurden inzwischen geändert.");
  await expect(alert).toHaveAttribute("aria-live", "assertive");
  const after = await columns.boundingBox();
  expect(after).not.toBeNull();
  expect(after?.x).toBe(before?.x);
  expect(after?.y).toBe(before?.y);
  expect(after?.width).toBe(before?.width);
  expect(after?.height).toBe(before?.height);
  expect(await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))).toEqual({ width: 390, height: 844 });
});
