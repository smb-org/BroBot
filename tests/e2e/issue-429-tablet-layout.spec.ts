import { expect, test, type Page, type Route } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "kanal-429-tablet";
const channel = {
  channelId,
  login: "demo-kanal",
  displayName: "Demo Kanal",
  role: "manager",
  streamState: "online",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "abo-429-tablet", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" },
  lastError: null,
};
const modules = [
  { id: "text_commands", enabled: true, settings: "{}" },
  { id: "faq", enabled: true, settings: "{}" },
];
const viewportCases = [
  { width: 820, height: 1180 },
  { width: 1024, height: 768 },
] as const;
const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

const commandRecord = (name: string, text: string) => ({
  channelId,
  name,
  text,
  kind: "text",
  enabled: true,
  minimumTier: "everyone",
  cooldownSeconds: 5,
  aliases: [],
  userCooldownSeconds: 0,
  streamCondition: "any",
  games: [],
  responseType: "say",
  chatTarget: null,
  variableAction: null,
  timeoutAction: null,
  useCount: 0,
  lastUsedAt: null,
  createdAt: "2026-09-19T12:00:00.000Z",
  updatedAt: "2026-09-19T12:00:00.000Z",
  revision: 1,
});

const faqEntries = [
  {
    id: "faq-429-welcome",
    name: "Begrüßung",
    enabled: true,
    matcher: { type: "keywords", patterns: ["hallo", "moin"] },
    answerText: "Hallo, schön dass du da bist!",
    minimumTier: "everyone",
    cooldownSeconds: 30,
    userCooldownSeconds: 0,
    games: [{ id: "minecraft", name: "Minecraft" }],
    chatTarget: "channel_default",
    order: 0,
    revision: 1,
    lastUsedAt: "2026-10-14T06:45:00.000Z",
    createdAt: "2026-09-19T12:00:00.000Z",
    updatedAt: "2026-10-14T06:45:00.000Z",
  },
  {
    id: "faq-429-goodbye",
    name: "Verabschiedung",
    enabled: true,
    matcher: { type: "keywords", patterns: ["tschüss"] },
    answerText: "Bis bald!",
    minimumTier: "everyone",
    cooldownSeconds: 30,
    userCooldownSeconds: 0,
    games: [],
    chatTarget: "channel_default",
    order: 1,
    revision: 1,
    lastUsedAt: null,
    createdAt: "2026-09-19T12:00:00.000Z",
    updatedAt: "2026-09-19T12:00:00.000Z",
  },
];

const mockDashboard = async (page: Page): Promise<void> => {
  await page.routeWebSocket(`**/ws/channels/${channelId}`, (socket) => {
    socket.onMessage(() => undefined);
  });
  await page.route("**/api/**", async (route: Route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [channel], bot: channel.bot }));
    if (pathname === `/api/channels/${channelId}/overview`) {
      return route.fulfill(json({ ...channel, activeModules: modules.map(({ id, settings }) => ({ moduleId: id, settings })) }));
    }
    if (pathname === `/api/channels/${channelId}/settings`) {
      return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
    }
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules }));
    if (pathname === `/api/channels/${channelId}/modules/text_commands/commands`) {
      return route.fulfill(json({ commands: [
        commandRecord("hallo", "Hallo {user}! Willkommen im Kanal."),
        commandRecord("tschüss", "Bis bald, {user}!"),
      ], variables: [] }));
    }
    if (pathname === `/api/channels/${channelId}/modules/faq/entries`) return route.fulfill(json({ orderRevision: 1, entries: faqEntries }));
    if (pathname === `/api/channels/${channelId}/games`) return route.fulfill(json({ games: [{ id: "minecraft", name: "Minecraft" }] }));
    if (pathname === `/api/channels/${channelId}/template-variables`) return route.fulfill(json({ variables: [] }));
    if (pathname === `/api/channels/${channelId}/revisions`) return route.fulfill(json({ revisions: {} }));
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "csrf-429-tablet" }));
    return route.fulfill(json({}));
  });
};

for (const viewport of viewportCases) {
  const viewportLabel = `${String(viewport.width)}x${String(viewport.height)}`;

  test(`commands show Back and return to the list at ${viewportLabel}`, async ({ page }, testInfo) => {
    await mockDashboard(page);
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/modules/text_commands`);

    const collection = page.locator(".collection-page");
    const count = page.locator(".text-command-filter-count");
    await expect(collection).toHaveAttribute("data-single-column", "true");
    await expect(count).toHaveText("2 Einträge");
    const search = page.locator(".text-command-list-toolbar__search input");
    await search.fill("hallo");
    await expect(count).toHaveText("1 Eintrag");

    const command = page.locator(".text-command-row").filter({ hasText: "!hallo" });
    await command.click();
    const back = page.locator(".collection-page__detail-back");
    await expect(back).toBeVisible();
    await back.click();
    await expect(command).toBeVisible();
    await expect(command).toBeFocused();
    await expect(collection).toHaveAttribute("data-detail-open", "false");
    await page.screenshot({ path: testInfo.outputPath(`tablet-${String(viewport.width)}-commands-after-back.png`) });
  });

  test(`FAQ shows Back and keeps its last editor field reachable at ${viewportLabel}`, async ({ page }, testInfo) => {
    await mockDashboard(page);
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/modules/faq`);

    const collection = page.locator(".collection-page");
    const count = page.locator(".faq-panel__entry-count");
    await expect(collection).toHaveAttribute("data-single-column", "true");
    await expect(count).toHaveText("2 Einträge");
    await page.locator(".faq-panel__toolbar-top input").fill("Begrüßung");
    await expect(count).toHaveText("1 Eintrag");

    const entry = page.locator(".faq-panel__entry").filter({ hasText: "Begrüßung" });
    await entry.click();
    const back = page.locator(".collection-page__detail-back");
    await expect(back).toBeVisible();
    await back.click();
    await expect(entry).toBeVisible();
    await expect(entry).toBeFocused();
    await expect(collection).toHaveAttribute("data-detail-open", "false");
    await page.screenshot({ path: testInfo.outputPath(`tablet-${String(viewport.width)}-faq-after-back.png`) });

    await entry.click();
    const games = page.getByRole("switch", { name: "Spiele" });
    if (await games.getAttribute("aria-checked") !== "true") await games.click();
    const editor = page.locator(".faq-panel__editor");
    const lastField = editor.locator(".ui-game-multi-select").last();
    await expect(lastField).toBeVisible();
    await editor.evaluate((element) => { element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 96); });
    const geometry = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".faq-panel__editor");
      const target = [...(scroller?.querySelectorAll<HTMLElement>(".ui-game-multi-select") ?? [])].at(-1);
      if (scroller === null || target === undefined) throw new Error("The final FAQ editor field is missing.");
      const scrollBox = scroller.getBoundingClientRect();
      const targetBox = target.getBoundingClientRect();
      return {
        overflowY: getComputedStyle(scroller).overflowY,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        scrollTop: scroller.scrollTop,
        targetTop: targetBox.top,
        targetBottom: targetBox.bottom,
        scrollTopEdge: scrollBox.top,
        scrollBottomEdge: scrollBox.bottom,
      };
    });
    expect(geometry.overflowY).toBe("auto");
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(geometry.scrollTop).toBeGreaterThan(0);
    expect(geometry.targetTop).toBeGreaterThanOrEqual(geometry.scrollTopEdge - 1);
    expect(geometry.targetBottom).toBeLessThanOrEqual(geometry.scrollBottomEdge + 1);
    await page.screenshot({ path: testInfo.outputPath(`tablet-${String(viewport.width)}-faq-editor-bottom.png`) });
  });
}
