import { expect, test, type Page } from "@playwright/test";

const channelId = "channel-overlay-palette-a11y";
const overlayId = "overlay-palette-a11y";
const channel = {
  channelId,
  login: "overlay-palette-a11y",
  displayName: "Overlay palette",
  language: "en",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-27T20:15:00.000Z" },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: "2026-09-27T20:15:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "sub-overlay-palette-a11y", reason: null, updatedAt: "2026-09-27T20:15:00.000Z" },
  tokens: { botExpiresAt: null, loginStatus: "connected", loginReason: null, loginExpiresAt: null },
  lastError: null,
};


const routeApi = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const json = (body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/channels") return json({ channels: [channel], bot: channel.bot });
    if (pathname === `/api/channels/${channelId}/overlays/${overlayId}`) {
      return json({ overlay: { id: overlayId, channelId, name: "Palette test", width: 1920, height: 1080, css: "", revision: 1,
        createdAt: "2026-09-27T20:15:00.000Z", updatedAt: "2026-09-27T20:15:00.000Z", elements: [] } });
    }
    if (pathname === `/api/channels/${channelId}/variables`) return json({ variables: [], count: 0, maximum: 20 });
    if (pathname === `/api/channels/${channelId}/modules`) return json({ modules: [{ id: "chat_voting", enabled: true, settings: "{}" }, { id: "ads", enabled: true, settings: "{}" }] });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto(`/channels/${channelId}/overlays/${overlayId}`);
  await expect(page.getByRole("heading", { name: "Palette test" })).toBeVisible();
};

test("mobile palette focuses search, names its dialog and selects by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routeApi(page);
  await page.getByRole("button", { name: "Add element" }).click();
  const search = page.getByRole("combobox", { name: "Search elements" });
  await expect(search).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Add element" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay-editor__element-select")).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Search elements" })).toHaveCount(0);
});

test("resizing from desktop to mobile with the palette open does not crash", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeApi(page);
  await page.getByRole("button", { name: "Add element" }).click();
  await expect(page.getByRole("combobox", { name: "Search elements" })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog", { name: "Add element" })).toBeVisible();
  await page.getByRole("combobox", { name: "Search elements" }).press("Enter");
  await expect(page.locator(".overlay-editor__element-select")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("desktop palette closes with Escape after Tab and removal moves focus to the plus button", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeApi(page);
  const add = page.getByRole("button", { name: "Add element" });
  await add.click();
  await expect(page.getByRole("combobox", { name: "Search elements" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Search elements" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: "Search elements" })).toHaveCount(0);
  await expect(add).toBeFocused();

  await add.click();
  await expect(page.getByRole("combobox", { name: "Search elements" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const remove = page.locator(".overlay-editor__element-remove");
  await expect(remove).toHaveCount(1);
  await remove.focus();
  await page.keyboard.press("Enter");
  await expect(remove).toHaveCount(0);
  await expect(add).toBeFocused();
});
