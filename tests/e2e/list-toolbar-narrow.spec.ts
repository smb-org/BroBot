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

for (const width of [390, 1280]) test(`compact game chips keep readable names and contained controls at ${String(width)}px`, async ({ page }) => {
  await mock(page);
  await page.route("**/api/channels/channel-a/games*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ games: [
      { id: "long-1", name: "A Game Name That Is Much Longer Than the Compact Filter Can Display" },
      { id: "long-2", name: "Another Game Name That Needs a Readable Chip" },
      { id: "long-3", name: "Third Game Name with a Longer Label" },
    ] }) });
  });
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/tests/e2e/module-panels-stability-fixture.html?panel=text_library&lang=en");

  const search = page.getByRole("searchbox", { name: "Game" });
  const games = [
    "A Game Name That Is Much Longer Than the Compact Filter Can Display",
    "Another Game Name That Needs a Readable Chip",
    "Third Game Name with a Longer Label",
  ];
  await expect(search).toBeEnabled();
  for (const name of games) {
    await search.fill("game");
    await page.getByRole("option", { name }).click();
  }
  await search.press("Escape");
  await expect(page.locator(".ui-game-multi-select__popup")).toBeHidden();

  const chips = page.locator(".text-library__list-toolbar .ui-game-multi-select__chip");
  await expect(chips).toHaveCount(3);
  const geometry = await chips.evaluateAll((elements, viewport) => {
    const firstName = elements[0]?.querySelector<HTMLElement>(".ui-game-multi-select__chip-name");
    if (firstName === null || firstName === undefined) throw new Error("Compact game chip names are missing.");
    const probe = document.createElement("span");
    probe.textContent = "0";
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    probe.style.font = getComputedStyle(firstName).font;
    document.body.appendChild(probe);
    const sixChWidth = probe.getBoundingClientRect().width * 6;
    probe.remove();
    return elements.map((element) => {
      const selected = element.parentElement;
      const name = element.querySelector<HTMLElement>(".ui-game-multi-select__chip-name");
      const remove = element.querySelector<HTMLElement>("button");
      const cover = element.querySelector<HTMLElement>(".ui-game-multi-select__cover, .ui-game-multi-select__cover-placeholder");
      if (selected === null || name === null || remove === null || cover === null) throw new Error("Compact game chip parts are missing.");
      const selectedBounds = selected.getBoundingClientRect();
      const chipBounds = element.getBoundingClientRect();
      const removeBounds = remove.getBoundingClientRect();
      const coverBounds = cover.getBoundingClientRect();
      return {
        // Above 640px the selected area scrolls instead of wrapping, so chips may extend past it.
        chipWithinSelected: viewport > 640 || (chipBounds.left >= selectedBounds.left - 1 && chipBounds.right <= selectedBounds.right + 1),
        removeWithinChip: removeBounds.left >= chipBounds.left - 1 && removeBounds.right <= chipBounds.right + 1,
        coverVisibleWithinChip: coverBounds.width > 0 && coverBounds.height > 0 && coverBounds.left >= chipBounds.left - 1 && coverBounds.right <= chipBounds.right + 1,
        nameHasSixChMinimum: name.clientWidth + 1 >= sixChWidth,
        nameUsesEllipsis: getComputedStyle(name).textOverflow === "ellipsis",
      };
    });
  }, width);
  expect(geometry).toEqual(games.map(() => ({
    chipWithinSelected: true,
    removeWithinChip: true,
    coverVisibleWithinChip: true,
    nameHasSixChMinimum: true,
    nameUsesEllipsis: true,
  })));
  if (process.env.TOOLBAR_SCREENSHOT_PATH !== undefined) {
    await page.screenshot({ path: process.env.TOOLBAR_SCREENSHOT_PATH, fullPage: false });
  }
  for (const name of games) await page.getByRole("button", { name: `Remove ${name}` }).click();
  await expect(chips).toHaveCount(0);
});
