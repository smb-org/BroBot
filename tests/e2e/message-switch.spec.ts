import { expect, test, type Page, type Route } from "@playwright/test";

import { expectHeadingHeightStable, expectMessageHeadingsCentred, expectSwitchGeometry } from "./switch-geometry";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "message-switch-ads-channel";
const module = { id: "ads", enabled: true, settings: "{}" };
const channel = {
  channelId,
  login: "beispielkanal",
  displayName: "Beispielkanal",
  language: "de",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-10-24T10:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-10-24T10:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "message-switch", reason: null, updatedAt: "2026-10-24T10:00:00.000Z" },
  tokens: { botExpiresAt: "2099-10-24T10:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-10-24T10:00:00.000Z" },
  lastError: null,
};
const initialSettings: Record<string, unknown> = {
  automatic: "Werbepause beginnt: {ads.duration} Sekunden.",
  manual: "Manuell gestartete Werbung",
  automaticTarget: "source_only",
  manualTarget: "source_only",
  leadSeconds: 60,
  prewarningText: "Werbung in {ads.seconds} Sekunden.",
  prewarningTarget: "source_only",
};
const schedule = {
  schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: 0, snoozeRefreshAt: null },
  snoozeScopeAvailable: true,
  recentAdBreaks: [],
};

interface AdsApiState { settings: Record<string, unknown>; revision: number; patches: number }

/** Mocks the dashboard API for one ads channel; the returned state is updated by settings writes. */
const mockAdsApi = async (page: Page, settings: Record<string, unknown>): Promise<AdsApiState> => {
  const state: AdsApiState = { settings, revision: 1, patches: 0 };
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (pathname === "/api/channels") return json({ channels: [{ ...channel, modules: [module] }], bot: channel.bot, platformAdmin: false });
    if (pathname === `/api/channels/${channelId}/overview`) {
      return json({ ...channel, modules: [module], activeModules: [{ moduleId: "ads", settings: JSON.stringify(state.settings) }] });
    }
    if (pathname === `/api/channels/${channelId}/modules`) return json({ modules: [module] });
    if (pathname === `/api/channels/${channelId}/settings`) return json({ defaultChatTarget: "source_only", defaultChatTargetRevision: 1, timeZone: "Europe/Berlin", revision: 1 });
    if (pathname === `/api/channels/${channelId}/revisions`) return json({ revisions: {} });
    if (pathname === "/api/csrf") return json({ token: "message-switch-csrf" });
    if (pathname === `/api/channels/${channelId}/modules/ads/settings`) {
      if (request.method() === "PATCH") {
        state.settings = (request.postDataJSON() as { settings: Record<string, unknown> }).settings;
        state.revision += 1;
        state.patches += 1;
      }
      return json({ settings: state.settings, revision: state.revision, variables: [], warnings: [] });
    }
    if (pathname === `/api/channels/${channelId}/modules/ads/schedule`) return json(schedule);
    return json({});
  });
  return state;
};

test("saves an ad message switch independently from its text", async ({ page }) => {
  const state = await mockAdsApi(page, { ...initialSettings });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/channels/${channelId}/modules/ads`);

  const message = page.getByRole("textbox", { name: "Automatische Werbepause" });
  const messageSwitch = page.getByRole("switch", { name: "Automatische Werbepause: Nachricht senden" });
  await expect(message).toHaveValue(initialSettings.automatic as string);
  await expect(messageSwitch).toBeChecked();
  await messageSwitch.click();
  await expect(messageSwitch).not.toBeChecked();
  await page.getByRole("button", { name: "Speichern" }).first().click();
  await expect.poll(() => state.settings.automaticEnabled).toBe(false);

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Automatische Werbepause" })).toHaveValue(initialSettings.automatic as string);
  await expect(page.getByRole("switch", { name: "Automatische Werbepause: Nachricht senden" })).not.toBeChecked();
});

test("switching a message on with an empty text shows a field error and saves nothing", async ({ page }) => {
  const state = await mockAdsApi(page, { ...initialSettings, manual: "", manualEnabled: false });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/channels/${channelId}/modules/ads`);

  const messageSwitch = page.getByRole("switch", { name: "Manuell gestartete Werbepause: Nachricht senden" });
  await expect(messageSwitch).not.toBeChecked();
  await messageSwitch.click();
  await expect(messageSwitch).toBeChecked();
  await expect(page.getByText("Text fehlt").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Speichern" }).first()).toHaveAttribute("aria-disabled", "true");
  expect(state.patches).toBe(0);
});

test("switches keep their thumb inside the track on the ads page and the module list", async ({ page }) => {
  await mockAdsApi(page, { ...initialSettings, manual: "Manuell gestartete Werbung", manualEnabled: false });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/channels/${channelId}/modules/ads`);
  await expect(page.getByRole("switch", { name: "Manuell gestartete Werbepause: Nachricht senden" })).not.toBeChecked();
  await expectSwitchGeometry(page);
  await page.goto(`/channels/${channelId}/modules`);
  await expect(page.getByRole("switch").first()).toBeVisible();
  await expectSwitchGeometry(page);
});

for (const width of [390, 768, 1280, 1920, 2560]) {
  test(`message headings and switches share a centre line at ${String(width)} px`, async ({ page }) => {
    await mockAdsApi(page, { ...initialSettings });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/channels/${channelId}/modules/ads`);
    await expect(page.getByRole("switch", { name: "Automatische Werbepause: Nachricht senden" })).toBeVisible();
    await expectMessageHeadingsCentred(page);
    await expectHeadingHeightStable(page, "Automatische Werbepause: Nachricht senden");
    await expectMessageHeadingsCentred(page);
  });
}
