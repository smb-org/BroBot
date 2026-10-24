import { expect, test, type Page } from "@playwright/test";

import type { PanelChannelState, PanelModuleState } from "../../src/panel-contract";

const channelId = "module-info-view";
const timestamp = "2026-10-01T12:00:00.000Z";
const modules: PanelModuleState[] = [{ id: "currency", enabled: true, settings: "{}", mandatory: true }];
const channelState = (language: "de" | "en"): PanelChannelState => ({
  channelId,
  login: "module-info-view",
  displayName: "Module info view",
  language,
  role: "manager",
  location: null,
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: timestamp },
  botPermissions: null,
  broadcasterPermissions: null,
  moderator: { isModerator: true, checkedAt: timestamp, reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "module-info-subscription", reason: null, updatedAt: timestamp },
  streamState: "offline",
  streamStartedAt: null,
  modules,
  controls: {
    mute: { active: false, until: null, mode: null },
    pause: { active: false, until: null, mode: null },
  },
  tokens: {
    botExpiresAt: "2099-10-19T09:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-10-19T09:00:00.000Z",
  },
  lastError: null,
});

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const installApiRoutes = async (page: Page, language: "de" | "en"): Promise<void> => {
  const currentChannel = channelState(language);
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/channels") {
      return route.fulfill(json({ channels: [currentChannel], bot: currentChannel.bot, platformAdmin: false, viewerIsBot: false }));
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      return route.fulfill(json({
        ...currentChannel,
        activeModules: modules.filter((module) => module.enabled).map(({ id, settings }) => ({ moduleId: id, settings })),
      }));
    }
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules }));
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "module-info-view-csrf" }));
    return route.fulfill(json({}));
  });
};

const verifyCurrencyInfoView = async (page: Page, language: "de" | "en"): Promise<void> => {
  await installApiRoutes(page, language);
  const labels = language === "de"
    ? { label: "Währungsumrechnung", description: "Wandelt den ersten Betrag des Befehls in die Zielwährung um. Beispiel: {currency.convert USD EUR}" }
    : { label: "Currency conversion", description: "Converts the first amount in the command to the target currency. Example: {currency.convert USD EUR}" };

  for (const width of [390, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/channels/${channelId}/modules/currency`);
    const entry = page.locator(".module-info-view__entry");
    await expect(entry).toHaveCount(1);
    await expect(entry.getByRole("heading", { name: labels.label, exact: true })).toBeVisible();
    await expect(entry.getByText("currency.convert", { exact: true })).toBeVisible();
    await expect(entry.getByText(labels.description, { exact: true })).toBeVisible();
    await expect(entry.getByText("{currency.convert USD EUR}", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await page.locator(".module-info-view").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
};

test.describe("German module info view", () => {
  test.use({ locale: "de-DE" });

  test("shows the currency catalog without horizontal overflow at mobile and desktop widths", async ({ page }) => {
    await verifyCurrencyInfoView(page, "de");
  });
});

test.describe("English module info view", () => {
  test.use({ locale: "en-US" });

  test("shows the currency catalog without horizontal overflow at mobile and desktop widths", async ({ page }) => {
    await verifyCurrencyInfoView(page, "en");
  });
});
