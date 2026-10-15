import { expect, test } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

test("viewer poll merges renewed token data before advancing overview freshness", async ({ page }) => {
  const channelId = "kanal-token-poll-merge";
  const now = Date.now();
  const staleTokens = {
    botExpiresAt: new Date(now + 10_000).toISOString(),
    loginStatus: "connected" as const,
    loginReason: null,
    loginExpiresAt: new Date(now + 10_000).toISOString(),
  };
  const renewedTokens = {
    botExpiresAt: "2099-09-20T08:00:00.000Z",
    loginStatus: "connected" as const,
    loginReason: null,
    loginExpiresAt: "2099-09-20T08:00:00.000Z",
  };
  const freshOverview = {
    channelId,
    login: "demo-kanal",
    displayName: "Demo Kanal",
    language: "de",
    role: "manager",
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: new Date(now).toISOString() },
    botPermissions: { missingScopes: [] },
    broadcasterPermissions: { missingScopes: [] },
    moderator: { isModerator: true, checkedAt: new Date(now).toISOString(), reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "sub-live-regression", reason: null, updatedAt: new Date(now).toISOString() },
    chatSubscriptionNeeded: false,
    streamState: "online",
    streamStartedAt: new Date(now - 60_000).toISOString(),
    viewerCount: 42,
    location: null,
    modules: [],
    tokens: renewedTokens,
    lastError: null,
    activeModules: [],
  };
  await page.clock.install({ time: new Date(now) });
  await installLiveCockpitMocks(page, { channelId, tokens: staleTokens });

  let overviewRequests = 0;
  let failOverviewRefresh = false;
  let allowFreshOverview = false;
  await page.route(`**/api/channels/${channelId}/overview`, async (route) => {
    overviewRequests += 1;
    if (!failOverviewRefresh) return route.fallback();
    if (!allowFreshOverview) return route.fulfill(json({ error: "temporarily_unavailable" }, 503));
    return route.fulfill(json(freshOverview));
  });

  await page.goto(`/channels/${channelId}`);
  const connection = page.locator(".dashboard-header__status .status-led");
  await expect(connection).toBeVisible();
  await expect(page.locator(".live-cockpit")).toBeVisible();
  const initialOverviewRequests = overviewRequests;
  failOverviewRefresh = true;

  await page.clock.fastForward(10_000);
  await expect.poll(() => overviewRequests).toBeGreaterThan(initialOverviewRequests);
  await page.clock.fastForward(2_000);
  allowFreshOverview = true;
  await page.clock.runFor(22_000);

  await expect.poll(() => overviewRequests).toBeGreaterThan(initialOverviewRequests + 1);
  await expect(connection).toHaveAttribute("data-status", "ok");
  await expect(connection).toContainText("Läuft");
});

test("clip editor link stays in its tile after footer health recovers", async ({ page }) => {
  const channelId = "kanal-clip-result-persistent";
  const mocks = await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "clips", enabled: true, settings: "{}" }],
    eventsError: true,
  });

  await page.goto(`/channels/${channelId}`);
  await expect(page.locator(".live-cockpit-event-feed__error")).toBeVisible({ timeout: 10_000 });
  const clipTile = page.locator(".live-action").filter({ has: page.getByRole("button", { name: "Clip erstellen" }) });
  await clipTile.getByRole("button", { name: "Clip erstellen" }).click();
  const tileLink = clipTile.getByRole("link", { name: "Clip erstellt. Öffnen" });
  await expect(tileLink).toHaveAttribute("href", "https://clips.twitch.tv/edit/clip-regression");

  const footer = page.locator(".live-cockpit__status");
  await expect(footer).toContainText("Live-Daten sind gerade nicht verfügbar.");
  mocks.setEventsError(false);
  await page.locator(".live-cockpit-event-feed__error").getByRole("button", { name: "Erneut versuchen" }).click();
  await expect(footer).toContainText("Alles bereit · Live-Daten aktuell");
  await expect(footer).not.toContainText("Clip erstellt.");
  await expect(tileLink).toBeVisible();
});

test("cockpit action count uses the German singular", async ({ page }) => {
  const channelId = "kanal-one-action-count";
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "clips", enabled: true, settings: "{}" }],
  });

  await page.goto(`/channels/${channelId}`);
  await expect(page.locator(".live-cockpit-actions__count")).toHaveText("1 Aktion");
});

test.describe("English action count", () => {
  test.use({ locale: "en-US" });

  test("uses the English singular", async ({ page }) => {
    const channelId = "channel-one-action-count";
    await installLiveCockpitMocks(page, {
      channelId,
      modules: [{ id: "clips", enabled: true, settings: "{}" }],
    });

    await page.goto(`/channels/${channelId}`);
    await expect(page.locator(".live-cockpit-actions__count")).toHaveText("1 action");
  });
});

test("event feed shows loading then a retryable error at desktop size", async ({ page }, testInfo) => {
  const channelId = "kanal-event-error-feedback";
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "chat_voting", enabled: true, settings: "{}" },
      { id: "clips", enabled: true, settings: "{}" },
    ],
    eventsError: true,
    currentStateError: true,
  });

  let startEventsResponse!: () => void;
  let releaseEventsResponse!: () => void;
  let holdFirstEventResponse = true;
  const eventsRequestStarted = new Promise<void>((resolve) => { startEventsResponse = resolve; });
  const heldEventsResponse = new Promise<void>((resolve) => { releaseEventsResponse = resolve; });
  await page.route(`**/api/channels/${channelId}/events`, async (route) => {
    if (holdFirstEventResponse) {
      holdFirstEventResponse = false;
      startEventsResponse();
      await heldEventsResponse;
    }
    return route.fulfill(json({ error: "temporarily_unavailable" }, 503));
  });

  await page.goto(`/channels/${channelId}`);
  await eventsRequestStarted;
  await expect(page.locator(".live-cockpit-event-feed__loading")).toBeVisible();
  releaseEventsResponse();

  const eventError = page.locator(".live-cockpit-event-feed__error");
  await expect(eventError).toContainText("Ereignisse konnten nicht geladen werden.", { timeout: 20_000 });
  await expect(eventError.getByRole("button", { name: "Erneut versuchen" })).toHaveAttribute("data-variant", "secondary");
  const availabilityRetry = page.locator(".live-cockpit-actions__retry");
  await expect(availabilityRetry).toHaveAttribute("data-variant", "secondary");
  await expect(availabilityRetry).toHaveCSS("font-size", "11px");
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: testInfo.outputPath("owner-live-de-error-1920x1080.png"), fullPage: false });
});
