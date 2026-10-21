import { expect, test, type Page, type Route } from "@playwright/test";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

const channelId = "fictional_gutter_channel";
const channelPrefix = `/api/channels/${channelId}`;
const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });

const installPageRoutes = async (page: Page): Promise<void> => {
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [
      { id: "faq", enabled: true, settings: "{}" },
      { id: "points", enabled: true, settings: JSON.stringify({ currencyName: "Stars", startBonus: 100, activityAmount: 5, windowMinutes: 10, dailyCap: 150 }) },
    ],
  });
  await page.route(`**${channelPrefix}/modules/faq/entries`, async (route: Route) => route.fulfill(json({ orderRevision: 1, entries: [] })));
  await page.route(`**${channelPrefix}/template-variables`, async (route: Route) => route.fulfill(json({ variables: [] })));
  await page.route(`**${channelPrefix}/games**`, async (route: Route) => route.fulfill(json({ games: [] })));
  await page.route(`**${channelPrefix}/modules/points/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname.slice(`${channelPrefix}/modules/points`.length);
    if (path === "/settings") return route.fulfill(json({ settings: { currencyName: "Stars", startBonus: 100, activityAmount: 5, windowMinutes: 10, dailyCap: 150 }, revision: 1, variables: [] }));
    if (path === "/summary") return route.fulfill(json({ circulation: 0, jackpots: { quiz: 0 }, inRounds: 0, accounts: 0, month: "2030-01" }));
    if (path === "/accounts" || path.startsWith("/accounts?")) return route.fulfill(json({ rows: [], cursor: null }));
    return route.fulfill(json({ rows: [] }));
  });
};

const contentWidthWithScrollbar = async (page: Page, path: string, overflowing: boolean): Promise<number> => {
  await page.goto(path);
  const main = page.locator(".dashboard-shell__main");
  const content = page.locator(".main-content");
  await expect(content).toBeVisible();
  await content.evaluate((element, hasOverflow) => {
    (element as HTMLElement).style.minHeight = hasOverflow ? "1400px" : "0px";
  }, overflowing);
  await expect.poll(() => main.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(overflowing);
  return content.evaluate((element) => element.getBoundingClientRect().width);
};

test("FAQ and Punkte keep the same content width with and without a vertical scrollbar [protects=FAQ and Punkte page content widths remain stable when the dashboard scroll owner gains vertical overflow; fails_when=the page content changes width between overflow and no-overflow states; no_claim=does not compare platform overlay-scrollbar preferences or every dashboard route]", async ({ page }) => {
  await installPageRoutes(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const moduleId of ["faq", "points"]) {
    const path = `/channels/${channelId}/modules/${moduleId}?lang=en`;
    const widthWithoutScrollbar = await contentWidthWithScrollbar(page, path, false);
    const widthWithScrollbar = await contentWidthWithScrollbar(page, path, true);
    expect(widthWithScrollbar).toBe(widthWithoutScrollbar);
  }
});
