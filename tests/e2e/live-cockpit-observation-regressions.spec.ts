import { expect, test } from "@playwright/test";

import type { PanelChannelControls } from "../../src/panel-contract";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

const controls = (muted: boolean): PanelChannelControls => ({
  mute: { active: muted, until: null, mode: muted ? "unlimited" : null },
  pause: { active: false, until: null, mode: null },
});

test("delayed viewer poll cannot replace a newer overview refresh", async ({ page }) => {
  const channelId = "kanal-viewer-poll-stale-overview";
  const now = Date.now();
  const location = { name: "Berlin, Deutschland", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" };
  await page.clock.install({ time: new Date(now) });
  const mocks = await installLiveCockpitMocks(page, {
    channelId,
    viewerCount: 42,
    nextViewerCount: 91,
    nextViewerCountAfter: 2,
    controls: controls(false),
    location,
  });

  let holdNextOverview = false;
  let pollHeld = false;
  let resolvePollStarted!: () => void;
  let releasePoll!: () => void;
  const pollStarted = new Promise<void>((resolve) => { resolvePollStarted = resolve; });
  const heldPoll = new Promise<void>((resolve) => { releasePoll = resolve; });
  await page.route(`**/api/channels/${channelId}/overview`, async (route) => {
    if (holdNextOverview && !pollHeld) {
      pollHeld = true;
      resolvePollStarted();
      await heldPoll;
      const checkedAt = new Date(now).toISOString();
      return route.fulfill(json({
        channelId,
        login: "demo-kanal",
        displayName: "Demo Kanal",
        language: "de",
        role: "manager",
        streamState: "online",
        streamStartedAt: new Date(now - 60_000).toISOString(),
        viewerCount: 42,
        location: null,
        broadcasterConnection: "connected",
        channelBotConsent: "granted",
        bot: { status: "connected", reason: null, updatedAt: checkedAt },
        botPermissions: { missingScopes: [] },
        broadcasterPermissions: { missingScopes: [] },
        moderator: { isModerator: true, checkedAt, reason: null },
        chatSubscription: { status: "enabled", subscriptionId: "sub-live-regression", reason: null, updatedAt: checkedAt },
        chatSubscriptionNeeded: false,
        modules: [],
        tokens: { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" },
        lastError: null,
        controls: controls(false),
        activeModules: [],
      }));
    }
    return route.fallback();
  });
  await page.route(`**/api/channels/${channelId}/controls/mute`, async (route) => {
    const next = controls(true);
    mocks.setControls(next);
    return route.fulfill(json({ controls: next }));
  });

  await page.goto(`/channels/${channelId}`);
  await expect(page.locator(".live-cockpit")).toBeVisible();
  holdNextOverview = true;
  await page.clock.fastForward(30_000);
  await pollStarted;

  await page.getByRole("button", { name: "Kanal stummschalten" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Aktivieren" }).click();
  const muteButton = page.getByRole("button", { name: "Stummschaltung aufheben" });
  await expect(muteButton).toBeVisible();
  await expect(page.locator(".live-cockpit-header__metric").nth(1)).toContainText("91");
  await expect(page.locator(".live-cockpit__warning-slot")).toHaveAttribute("data-warning-count", "0");

  releasePoll();

  await expect(page.getByRole("button", { name: "Stummschaltung aufheben" })).toBeVisible();
  await expect(page.locator(".live-cockpit-header__metric").nth(1)).toContainText("91");
  await expect(page.locator(".live-cockpit__warning-slot")).toHaveAttribute("data-warning-count", "0");
});

test("a BELABOX polling failure overrides the latest manual success", async ({ page }) => {
  const channelId = "kanal-belabox-latest-failure";
  await page.clock.install({ time: new Date() });
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "belabox", enabled: true, settings: "{}" }],
  });

  let statusFails = false;
  await page.route(`**/api/channels/${channelId}/modules/belabox/status`, async (route) => {
    if (statusFails) return route.fulfill(json({ error: "temporarily_unavailable" }, 503));
    return route.fallback();
  });
  await page.route(`**/api/channels/${channelId}/modules/belabox/test`, async (route) =>
    route.fulfill(json({ ok: true, connected: true, bitrateKbps: 4_200 })));

  await page.goto(`/channels/${channelId}`);
  const belaboxLed = page.locator(".live-cockpit-header__indicators .status-led").nth(1);
  await expect(belaboxLed).toContainText("verbunden");
  await page.getByRole("button", { name: "BELABOX prüfen" }).click();
  await expect(page.locator(".live-cockpit__status-message")).toContainText("Verbunden · 4200 kbit/s");

  statusFails = true;
  await page.clock.fastForward(5_000);

  await expect(belaboxLed).toHaveAttribute("data-status", "warn");
  await expect(belaboxLed).toContainText("nicht erreichbar");
});
