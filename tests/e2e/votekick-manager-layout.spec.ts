import { expect, test, type Page, type Route } from "@playwright/test";
import { DEFAULT_VOTEKICK_SETTINGS } from "../../src/modules/votekick/contracts";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "votekick-layout-channel";
const timestamp = new Date().toISOString();
const settings = { ...DEFAULT_VOTEKICK_SETTINGS, duration: { minSeconds: 90, maxSeconds: 600 } };
const viewports = [
  { width: 1920, height: 1080, columns: 2 },
  { width: 1280, height: 800, columns: 1 },
  { width: 390, height: 844, columns: 1 },
  { width: 2560, height: 1440, columns: 2 },
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
  modules: [{ id: "votekick", enabled: true, settings: JSON.stringify(settings) }],
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
      await fulfillJson(route, { ...channel, activeModules: [{ moduleId: "votekick", settings: JSON.stringify(settings) }], streamState: "online", streamStartedAt: timestamp, viewerCount: 18, location: null });
    } else if (pathname === `/api/channels/${channelId}/modules`) {
      await fulfillJson(route, { modules: channel.modules });
    } else if (pathname === `/api/channels/${channelId}/modules/votekick/settings`) {
      await fulfillJson(route, { settings, revision: 1, variables: [] });
    } else if (pathname === `/api/channels/${channelId}/template-variables`) {
      await fulfillJson(route, { variables: [] });
    } else if (pathname === `/api/channels/${channelId}/template-preview`) {
      await fulfillJson(route, { text: "" });
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
  test(`Votekick settings columns and timeout labels fit at ${String(viewport.width)}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installApi(page);
    await page.goto(`/channels/${channelId}/modules/votekick`, { waitUntil: "domcontentloaded" });

    const editor = page.locator(".ui-editor-shell.votekick-settings-editor");
    await expect(editor).toBeVisible();
    const columns = editor.locator(".ui-editor-shell__columns > .ui-editor-shell__column");
    await expect(columns).toHaveCount(2);
    const positions = await columns.evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width };
    }));
    expect(positions[0]?.width).toBeGreaterThan(0);
    if (viewport.columns === 2) {
      expect(positions[1]?.x).toBeGreaterThan((positions[0]?.x ?? 0) + (positions[0]?.width ?? 0));
      expect(positions[1]?.y).toBeCloseTo(positions[0]?.y ?? 0, 0);
    } else {
      expect(positions[1]?.y).toBeGreaterThan(positions[0]?.y ?? 0);
    }
    if (viewport.width >= 1920) expect(await editor.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(960);

    const range = editor.locator(".timeout-duration-range-fields--visible-labels");
    const minimumLabel = range.locator('label[for="settings-duration-minimum"]');
    const maximumLabel = range.locator('label[for="settings-duration-maximum"]');
    for (const [label, inputId] of [
      [minimumLabel, "settings-duration-minimum"],
      [maximumLabel, "settings-duration-maximum"],
    ] as const) {
      await expect(label).toBeVisible();
      const layout = await label.evaluate((element) => {
        if (!(element instanceof HTMLLabelElement)) throw new Error("The timeout label is not a label element.");
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        const input = document.getElementById(element.htmlFor);
        if (!(input instanceof HTMLElement)) throw new Error("The timeout range input is missing.");
        return {
          position: style.position,
          clipPath: style.clipPath,
          width: bounds.width,
          height: bounds.height,
          inputTop: input.getBoundingClientRect().top,
          labelTop: bounds.top,
        };
      });
      expect(layout.position).toBe("static");
      expect(layout.clipPath).toBe("none");
      expect(layout.width).toBeGreaterThan(50);
      expect(layout.height).toBeGreaterThan(10);
      expect(layout.labelTop).toBeLessThan(layout.inputTop);
      await expect(range.locator(`#${inputId}`)).toBeVisible();
    }

    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(viewport.width + 1);
  });
}
