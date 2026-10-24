import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_CHAT_VOTING_SETTINGS } from "../../src/modules/chat_voting/contracts";
import { DEFAULT_POINTS_SETTINGS } from "../../src/modules/points/contracts";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";
import { waitForWebFonts } from "./web-fonts";

const channelId = "kanal-544-layout";
const widths = [1920, 2560, 3840] as const;
const moduleIds = ["text_commands", "timers", "chat_voting", "points"] as const;
const modules = moduleIds.map((id) => ({ id, enabled: true, settings: "{}" }));
const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });

const collectionPages = [
  { name: "text commands", path: `/channels/${channelId}/modules/text_commands` },
  { name: "timers", path: `/channels/${channelId}/modules/timers` },
  { name: "points", path: `/channels/${channelId}/modules/points` },
  { name: "members", path: `/channels/${channelId}/members` },
  { name: "channel variables", path: `/channels/${channelId}/variables` },
] as const;

const install = async (page: Page): Promise<void> => {
  await installLiveCockpitMocks(page, { channelId, role: "manager", streamState: "online", modules });
  // Registered last, so these win over the generic empty answer of the cockpit mocks.
  await page.route(`**/api/channels/${channelId}/modules/text_commands/commands`, (route) => route.fulfill(json({ commands: [], variables: [] })));
  await page.route(`**/api/channels/${channelId}/members*`, (route) => route.fulfill(json({ members: [], nextCursor: null, broadcasterCount: 1, viewerUserId: "viewer" })));
  await page.route(`**/api/channels/${channelId}/variables`, (route) => route.fulfill(json({ variables: [], count: 0, maximum: 25 })));
  await page.route(`**/api/channels/${channelId}/template-variables`, (route) => route.fulfill(json({ variables: [] })));
  await page.route(`**/api/channels/${channelId}/modules/points/summary`, (route) => route.fulfill(json({ circulation: 0, jackpots: {}, inRounds: 0, accounts: 0, month: "2030-01" })));
  await page.route(`**/api/channels/${channelId}/modules/points/accounts*`, (route) => route.fulfill(json({ rows: [] })));
  await page.route(`**/api/channels/${channelId}/modules/points/settings`, (route) => route.fulfill(json({ settings: DEFAULT_POINTS_SETTINGS, revision: 1 })));
  await page.route(`**/api/channels/${channelId}/modules/chat_voting/templates`, (route) => route.fulfill(json({ templates: [], count: 0, maximum: 100 })));
  await page.route(`**/api/channels/${channelId}/modules/chat_voting/settings`, (route) => route.fulfill(json({ settings: DEFAULT_CHAT_VOTING_SETTINGS, revision: 1, variables: [] })));
};

/** Left edge of the page content minus the right edge of the navigation; 0 means the content starts next to it. */
const gapToNavigation = async (page: Page): Promise<number> => {
  await waitForWebFonts(page);
  const gap = await page.evaluate(() => {
    const nav = document.querySelector(".dashboard-shell__navbar")?.getBoundingClientRect();
    const main = document.querySelector(".main-content")?.getBoundingClientRect();
    return nav === undefined || main === undefined ? Number.NaN : main.left - nav.right;
  });
  expect(Number.isNaN(gap), "navigation and .main-content are both rendered").toBe(false);
  return gap;
};

for (const width of widths) {
  test.describe(`${String(width)}px`, () => {
    test.use({ viewport: { width, height: 1080 } });

    for (const { name, path } of collectionPages) {
      test(`${name} starts next to the navigation`, async ({ page }) => {
        await install(page);
        await page.goto(path);
        await expect(page.locator(".collection-page")).toBeVisible();
        expect(Math.abs(await gapToNavigation(page))).toBeLessThanOrEqual(1);
      });
    }

    test("a non-collection page starts next to the navigation", async ({ page }) => {
      await install(page);
      await page.goto(`/channels/${channelId}/modules`);
      await expect(page.locator(".module-workspace")).toBeVisible();
      await expect(page.locator(".collection-page")).toHaveCount(0);
      expect(Math.abs(await gapToNavigation(page))).toBeLessThanOrEqual(1);
    });

    test("chat voting keeps its alignment while the lazy panel loads and after it mounts", async ({ page }) => {
      await install(page);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route("**/src/modules/chat_voting/panel/index.tsx*", async (route) => {
        await gate;
        await route.continue();
      });
      await page.goto(`/channels/${channelId}/modules/chat_voting`);
      // The page suspends until the panel chunk is ready, so only the loading fallback is mounted.
      await expect(page.locator(".module-view-fallback")).toBeVisible();
      await expect(page.locator(".collection-page")).toHaveCount(0);
      const loading = await gapToNavigation(page);
      expect(Math.abs(loading)).toBeLessThanOrEqual(1);

      release();
      await expect(page.locator(".module-detail--chat_voting .collection-page")).toBeVisible();
      expect(await gapToNavigation(page)).toBe(loading);
    });
  });
}
