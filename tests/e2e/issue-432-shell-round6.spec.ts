import { expect, test, type Page } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });

test("the upcoming ad remains visible below the recent timeout reservation", async ({ page }) => {
  const channelId = "issue-432-cockpit-reservation";
  await installLiveCockpitMocks(page, {
    channelId,
    role: "manager",
    modules: [{ id: "ads", enabled: true, settings: "{}" }],
    upcomingAd: true,
  });

  for (const viewport of [{ width: 1440, height: 800 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}`);
    const tile = page.locator('[data-slot="next-up"]');
    const upcoming = tile.getByRole("button", { name: "Verschieben" });
    await expect(upcoming).toBeVisible();
    const geometry = await tile.evaluate((element) => {
      const recent = element.querySelector<HTMLElement>(".live-cockpit-next-list--recent");
      const upcomingList = element.querySelectorAll<HTMLElement>(".live-cockpit-next-list").item(1);
      const button = upcomingList.querySelector<HTMLElement>("button");
      if (recent === null || button === null) throw new Error("The recent and upcoming cockpit lists must render.");
      const tileBox = element.getBoundingClientRect();
      const upcomingBox = upcomingList.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      return {
        recentHeight: recent.getBoundingClientRect().height,
        upcomingHeight: upcomingBox.height,
        buttonInsideTile: buttonBox.top >= tileBox.top && buttonBox.bottom <= tileBox.bottom,
      };
    });
    expect(geometry.recentHeight).toBeGreaterThan(0);
    expect(geometry.upcomingHeight).toBeGreaterThan(0);
    expect(geometry.buttonInsideTile).toBe(true);
  }
});

const overlayChannelId = "issue-432-overlay-focus";
const overlayId = "issue-432-overlay";
const installOverlayFixture = async (page: Page): Promise<void> => {
  const now = "2030-01-01T12:00:00.000Z";
  const channel = {
    channelId: overlayChannelId,
    login: "overlay-focus",
    displayName: "Overlay Fokus",
    language: "de",
    role: "manager",
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: now },
    botPermissions: { missingScopes: [] },
    broadcasterPermissions: { missingScopes: [] },
    moderator: { isModerator: true, checkedAt: now, reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "overlay-focus-sub", reason: null, updatedAt: now },
    tokens: { botExpiresAt: null, loginStatus: "connected", loginReason: null, loginExpiresAt: null },
    lastError: null,
  };
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [channel], bot: channel.bot }));
    if (pathname === `/api/channels/${overlayChannelId}/overlays/${overlayId}`) return route.fulfill(json({
      overlay: {
        id: overlayId,
        channelId: overlayChannelId,
        name: "Fokus Test",
        width: 1920,
        height: 1080,
        css: "",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        elements: Array.from({ length: 20 }, (_, index) => ({
          id: `element-${String(index)}`,
          kind: "variable",
          label: `Ebene ${String(index + 1)}`,
          variableName: `score${String(index)}`,
          text: "{value}",
          config: {},
          x: 0,
          y: 0,
          scalePercent: 100,
          z: index,
          inComposition: true,
        })),
      },
    }));
    if (pathname === `/api/channels/${overlayChannelId}/variables`) return route.fulfill(json({ variables: [], count: 0, maximum: 20 }));
    if (pathname === `/api/channels/${overlayChannelId}/modules`) return route.fulfill(json({ modules: [] }));
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
};

test("the narrow desktop overlay preview uses one shell offset and does not cover the focused layer field", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await installOverlayFixture(page);
  await page.goto(`/channels/${overlayChannelId}/overlays/${overlayId}`);
  const layerInput = page.locator("#overlay-editor-z");
  await layerInput.focus();
  await expect(layerInput).toBeFocused();
  const geometry = await page.evaluate(() => {
    const preview = document.querySelector<HTMLElement>(".overlay-editor__preview-panel");
    const input = document.querySelector<HTMLElement>("#overlay-editor-z");
    if (preview === null || input === null) throw new Error("The overlay preview and layer input must render.");
    const previewBox = preview.getBoundingClientRect();
    const inputBox = input.getBoundingClientRect();
    return {
      previewTop: previewBox.top,
      inputInViewport: inputBox.top >= 64 && inputBox.bottom <= window.innerHeight,
      overlaps: previewBox.left < inputBox.right && previewBox.right > inputBox.left && previewBox.top < inputBox.bottom && previewBox.bottom > inputBox.top,
    };
  });
  expect(geometry.previewTop).toBeGreaterThanOrEqual(75);
  expect(geometry.previewTop).toBeLessThanOrEqual(80);
  expect(geometry.inputInViewport).toBe(true);
  expect(geometry.overlaps).toBe(false);
});

test("the main shell scroller receives PageDown before the members page is clicked", async ({ page }) => {
  const channelId = "issue-432-members-scroll";
  const now = "2030-01-01T12:00:00.000Z";
  const channel = {
    channelId,
    login: "members-scroll",
    displayName: "Mitglieder Scrolltest",
    language: "de",
    role: "manager",
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: now },
    botPermissions: { missingScopes: [] },
    broadcasterPermissions: { missingScopes: [] },
    moderator: { isModerator: true, checkedAt: now, reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "members-scroll-sub", reason: null, updatedAt: now },
    tokens: { botExpiresAt: null, loginStatus: "connected", loginReason: null, loginExpiresAt: null },
    lastError: null,
  };
  const members = Array.from({ length: 100 }, (_, index) => ({
    userId: `member-${String(index + 1)}`,
    login: `member-${String(index + 1)}`,
    displayName: `Mitglied ${String(index + 1)}`,
    profileImageUrl: null,
    role: "operator",
    joinedAt: now,
  }));
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [channel], bot: channel.bot }));
    if (pathname === `/api/channels/${channelId}/overview`) return route.fulfill(json({ ...channel, activeModules: [] }));
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules: [] }));
    if (pathname === `/api/channels/${channelId}/members`) return route.fulfill(json({ members, broadcasterCount: 1, viewerUserId: "viewer", nextCursor: null }));
    if (pathname === `/api/channels/${channelId}/events`) return route.fulfill(json({ entries: [], nextCursor: null }));
    return route.fulfill(json({}));
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/channels/${channelId}/members`);
  await expect(page.locator(".members-table tbody tr")).toHaveCount(100);
  const main = page.locator(".dashboard-shell__main");
  await expect(main).toBeFocused();
  expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
  await page.keyboard.press("PageDown");
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  for (const key of ["Space", "ArrowDown"]) {
    await main.evaluate((element) => { element.scrollTop = 0; });
    await page.keyboard.press(key);
    await expect.poll(() => main.evaluate((element) => element.scrollTop), { message: `${key} scrolls the focused main region` }).toBeGreaterThan(0);
  }
  await page.getByRole("link", { name: "Ereignisse" }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${channelId}/events$`));
  await expect(page.getByRole("heading", { name: "Ereignisse", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Mitglieder" }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${channelId}/members$`));
  await expect(page.getByRole("heading", { name: "Mitglieder", level: 1 })).toBeVisible();
  await expect(page.locator(".members-table tbody tr")).toHaveCount(100);
  await expect(main).toBeFocused();
  await main.evaluate((element) => { element.scrollTop = 0; });
  await page.keyboard.press("PageDown");
  await expect.poll(() => main.evaluate((element) => element.scrollTop), { message: "PageDown scrolls after sidebar navigation without another click" }).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Seitenleiste öffnen" }).click();
  await expect(page.locator(".dashboard-shell__navbar")).toHaveAttribute("data-open", "true");
  await page.getByRole("link", { name: "Ereignisse" }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${channelId}/events$`));
  await expect(main).toBeFocused();
  await expect(page.locator(".dashboard-shell__navbar")).toHaveAttribute("data-open", "false");
  await page.getByRole("button", { name: "Seitenleiste öffnen" }).click();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/channels/${channelId}/members$`));
  await expect(page.locator(".dashboard-shell__navbar")).toHaveAttribute("data-open", "false");
  await expect(main).toBeFocused();
  await expect(page.locator(".dashboard-shell__header")).toHaveCSS("position", "relative");
  await expect(page.locator(".dashboard-shell__navbar")).toHaveCSS("position", "fixed");
});
