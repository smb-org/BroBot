import { expect, test, type Page, type Route } from "@playwright/test";
import { DEFAULT_TEMP_VIPS_SETTINGS } from "../../src/modules/temp_vips/contracts";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "temp-vips-layout-channel";
const timestamp = new Date().toISOString();
const settings = DEFAULT_TEMP_VIPS_SETTINGS;
const viewports = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;

const channel = {
  channelId,
  login: "musterkanal",
  displayName: "Musterkanal",
  language: "de",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: timestamp },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: timestamp, reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "fixture-subscription", reason: null, updatedAt: timestamp },
  chatSubscriptionNeeded: false,
  modules: [{ id: "temp_vips", enabled: true, settings: JSON.stringify(settings) }],
  tokens: { botExpiresAt: "2099-01-01T00:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-01-01T00:00:00.000Z" },
  lastError: null,
};

const fulfillJson = async (route: Route, value: unknown): Promise<void> => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
};

const installApi = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await fulfillJson(route, { channels: [channel], viewerUserId: "fixture-viewer", bot: channel.bot, platformAdmin: false, viewerIsBot: false });
    } else if (pathname === `/api/channels/${channelId}/overview`) {
      await fulfillJson(route, { ...channel, activeModules: [{ moduleId: "temp_vips", settings: JSON.stringify(settings) }], streamState: "online", streamStartedAt: timestamp, viewerCount: 18, location: null });
    } else if (pathname === `/api/channels/${channelId}/modules`) {
      await fulfillJson(route, { modules: channel.modules });
    } else if (pathname === `/api/channels/${channelId}/modules/temp_vips/settings`) {
      await fulfillJson(route, { settings, revision: 1, variables: [] });
    } else if (pathname === `/api/channels/${channelId}/template-variables`) {
      await fulfillJson(route, { variables: [] });
    } else if (pathname === `/api/channels/${channelId}/settings`) {
      await fulfillJson(route, { timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 });
    } else if (pathname === `/api/channels/${channelId}/overlays`) {
      await fulfillJson(route, { overlays: [], maximum: 20, elementMaximum: 20 });
    } else if (pathname === `/api/channels/${channelId}/events`) {
      await fulfillJson(route, { entries: [], nextCursor: null });
    } else if (pathname === `/api/channels/${channelId}/revisions`) {
      await fulfillJson(route, { revisions: {} });
    } else if (pathname === "/api/csrf") {
      await fulfillJson(route, { token: "fixture-csrf" });
    } else {
      await fulfillJson(route, {});
    }
  });
};

for (const viewport of viewports) {
  test(`Temporary VIP settings follow the module page layout at ${String(viewport.width)}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installApi(page);
    await page.goto(`/channels/${channelId}/modules/temp_vips`, { waitUntil: "domcontentloaded" });

    const editor = page.locator(".ui-editor-shell").first();
    await expect(editor).toBeVisible();
    const header = page.locator(".module-detail-heading");
    await expect(header.getByRole("button", { name: "Speichern" })).toBeVisible();
    await expect(editor.getByRole("button", { name: "Speichern" })).toHaveCount(0);
    await expect(editor.getByRole("heading", { name: "Einstellungen für temporäre VIPs" })).toHaveCount(0);
    await expect(editor.getByText("Verwaltung abgeben")).toBeVisible();

    const layout = await header.evaluate((element) => {
      const icon = element.querySelector(".page-header__icon");
      const title = element.querySelector("h1, h2, h3");
      if (!(icon instanceof HTMLElement) || !(title instanceof HTMLElement)) throw new Error("The module header is incomplete.");
      return { iconBottom: icon.getBoundingClientRect().bottom, titleTop: title.getBoundingClientRect().top };
    });
    expect(layout.titleTop).toBeLessThan(layout.iconBottom);

    const columns = await editor.locator(".ui-editor-shell__column").evaluateAll((nodes) =>
      new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().left))).size);
    expect(columns).toBe(viewport.width >= 900 ? 2 : 1);

    const documentWidth =await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(viewport.width + 1);
  });
}
