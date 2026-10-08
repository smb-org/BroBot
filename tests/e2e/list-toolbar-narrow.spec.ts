import { expect, test, type Page } from "@playwright/test";

const channelId = "channel-a";
const channel = {
  channelId, login: "toolbar-channel", displayName: "Toolbar Channel", role: "manager", streamState: "online",
  broadcasterConnection: "connected", channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "s", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" },
  lastError: null,
};
const bodies: Record<string, unknown> = {
  "/api/channels": { channels: [channel], bot: channel.bot },
  [`/api/channels/${channelId}/overview`]: { ...channel, activeModules: [] },
  [`/api/channels/${channelId}/members`]: { members: [], nextCursor: null, broadcasterCount: 1, viewerUserId: "viewer" },
  [`/api/channels/${channelId}/variables`]: { variables: [], count: 0, maximum: 25 },
  [`/api/channels/${channelId}/overlays`]: { overlays: [], maximum: 20, elementMaximum: 20 },
  [`/api/channels/${channelId}/overlay-tokens`]: { tokens: [], nextOffset: null },
  [`/api/channels/${channelId}/events`]: { entries: [], nextCursor: null },
  [`/api/channels/${channelId}/modules`]: { modules: [] },
  [`/api/channels/${channelId}/settings`]: { timeZone: "UTC", revision: 1, location: null, locationRevision: 1 },
  [`/api/channels/${channelId}/template-variables`]: { variables: [] },
  [`/api/channels/${channelId}/games`]: { games: [{ id: "1", name: "Just Chatting" }] },
  [`/api/channels/${channelId}/modules/text_commands/commands`]: { commands: [], variables: [] },
  [`/api/channels/${channelId}/modules/text_library/library`]: {
    blocks: [], categories: [], settings: { revision: 1, graphRevision: 1, updatedAt: "2026-09-20T08:00:00.000Z" }, usages: {},
  },
};

const mock = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const body = bodies[new URL(route.request().url()).pathname] ?? {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
};

// Dashboard pages (host) versus module panels rendered by the fixture page.
const lists = [
  { name: "members", url: `/channels/${channelId}/members` },
  { name: "text commands", url: "/tests/e2e/module-panels-stability-fixture.html?panel=text_commands" },
  { name: "text library", url: "/tests/e2e/module-panels-stability-fixture.html?panel=text_library" },
  { name: "channel variables", url: `/channels/${channelId}/variables` },
  { name: "overlays", url: `/channels/${channelId}/overlays` },
  { name: "events", url: `/channels/${channelId}/events` },
];

for (const lang of ["de", "en"] as const) {
  test.describe(`list toolbars narrow (${lang})`, () => {
    test.use({ locale: lang === "de" ? "de-DE" : "en-US" });
    for (const list of lists) {
      for (const width of [320, 390, 640]) {
        test(`${list.name} toolbar fits at ${String(width)}px`, async ({ page }) => {
          await mock(page);
          await page.setViewportSize({ width, height: 844 });
          const url = list.url.includes("fixture") ? `${list.url}&lang=${lang}` : list.url;
          await page.goto(url);
          const toolbar = page.locator(".list-toolbar").first();
          await expect(toolbar.locator(".list-toolbar__row")).toBeVisible();
          const result = await toolbar.evaluate((el) => {
            const row = el.querySelector<HTMLElement>(".list-toolbar__row");
            const filters = el.querySelector<HTMLElement>(".list-toolbar__filters");
            const column = el.parentElement;
            const createWrap = el.querySelector<HTMLElement>(".list-toolbar__create");
            // The events toolbar has no create button; nothing can overlap then.
            const create = createWrap?.querySelector("button")?.getBoundingClientRect();
            if (row === null || column === null) throw new Error("toolbar parts missing");
            const overflow = (e: HTMLElement | null): number => (e === null ? 0 : e.scrollWidth - e.clientWidth);
            // A filter area that scrolls horizontally by design (chips) clips its own overflow.
            const filterOverflow = filters === null || ["auto", "scroll"].includes(getComputedStyle(filters).overflowX) ? 0 : overflow(filters);
            const visible = (r: DOMRect): boolean => r.width > 0 && r.height > 0;
            const controls = [...row.querySelectorAll<HTMLElement>("input, button, [role=combobox], .mantine-Select-input")]
              .filter((e) => !createWrap?.contains(e))
              .map((e) => e.getBoundingClientRect())
              .filter(visible);
            const hits = create === undefined ? 0 : controls.filter((r) => r.left < create.right - 0.5 && r.right > create.left + 0.5 && r.top < create.bottom - 0.5 && r.bottom > create.top + 0.5).length;
            return { row: overflow(row), filters: filterOverflow, column: overflow(column), hits };
          });
          expect(result).toEqual({ row: 0, filters: 0, column: 0, hits: 0 });
        });
      }
    }
  });
}
