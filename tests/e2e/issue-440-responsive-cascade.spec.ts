import { expect, test, type Page, type Route } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "kanal-440-responsive-cascade";
const channel = {
  channelId,
  login: "cascade-kanal",
  displayName: "Cascade Kanal",
  role: "manager",
  streamState: "online",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "cascade-sub", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" },
  lastError: null,
};

const longEntry = {
  auditId: "audit-long-sentence",
  actorUserId: "member-1",
  actorLogin: "mira_fox",
  actorDisplayName: "Mira mit einem außergewöhnlich langen Namen für schmale Tabellen",
  actorKind: "member",
  createdAt: "2026-09-26T10:00:00.000Z",
  moduleId: null,
  action: "member.role_changed",
  before: JSON.stringify({ role: "manager" }),
  after: JSON.stringify({ role: "operator" }),
  subjectUserId: "member-2",
  subjectLogin: "otto_owl",
  subjectDisplayName: "Otto mit einem ebenfalls sehr langen Namen, der in der Audit-Tabelle umbrechen muss",
};

const shortEntry = {
  ...longEntry,
  auditId: "audit-short-sentence",
  actorDisplayName: "Mira",
  createdAt: "2026-09-26T09:00:00.000Z",
  subjectDisplayName: "Otto",
};

const json = (value: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(value),
});

const installDashboardMocks = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route: Route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [channel], bot: channel.bot }));
    if (pathname === `/api/channels/${channelId}/overview`) return route.fulfill(json({ ...channel, activeModules: [] }));
    if (pathname === `/api/channels/${channelId}/settings`) return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
    if (pathname === `/api/channels/${channelId}/variables`) return route.fulfill(json({
      variables: [{ channelId, name: "score", value: 42, description: "Punkte im aktuellen Spiel", resetOnStreamStart: false, createdAt: "2026-09-20T08:00:00.000Z", updatedAt: "2026-09-20T08:00:00.000Z", usages: [] }],
      count: 1,
      maximum: 25,
    }));
    if (pathname === `/api/channels/${channelId}/audit-log` || pathname === `/api/channels/${channelId}/audit`) return route.fulfill(json({ entries: [longEntry, shortEntry], nextCursor: null }));
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules: [] }));
    if (pathname === `/api/channels/${channelId}/revisions`) return route.fulfill(json({ revisions: {} }));
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "cascade-token" }));
    return route.fulfill(json({}));
  });
};

test("Variables keeps the closed detail pane hidden and unfocusable at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installDashboardMocks(page);
  await page.goto(`/channels/${channelId}/variables`);

  const collection = page.locator(".collection-page");
  const detail = collection.locator(".collection-page__detail");
  const backButton = collection.locator(".collection-page__detail-back");
  await expect(collection).toHaveAttribute("data-single-column", "true");
  await expect(collection).toHaveAttribute("data-detail-open", "false");
  await expect(detail).toBeHidden();
  await expect(backButton).toHaveCount(1);
  await expect(backButton).toBeHidden();

  const layout = await detail.evaluate((element) => ({
    display: getComputedStyle(element).display,
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  expect(layout).toEqual({ display: "none", width: 0, height: 0 });
  const focused = await backButton.evaluate((element) => {
    (element as HTMLElement).focus();
    return document.activeElement === element;
  });
  expect(focused).toBe(false);
});

test("Variables keeps a short name fully visible in the desktop list at 1280px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installDashboardMocks(page);
  await page.goto(`/channels/${channelId}/variables`);

  const name = page.locator(".channel-variables-table__name");
  await expect(name).toHaveText("{var.score}");
  const width = await name.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
});

test("Audit grows a wrapped sentence row without overlapping the following row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installDashboardMocks(page);
  await page.goto(`/channels/${channelId}/audit`);

  const rows = page.locator(".audit-sentence-list tbody tr:not(.data-table__day-row)");
  await expect(rows).toHaveCount(2);
  const firstRow = rows.nth(0);
  const secondRow = rows.nth(1);
  const sentence = firstRow.locator(".audit-sentence-row__sentence");
  const sentenceCell = firstRow.locator(".data-table__column--change");
  const geometry = await Promise.all([
    firstRow.boundingBox(),
    secondRow.boundingBox(),
    sentence.boundingBox(),
    sentenceCell.boundingBox(),
    sentence.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, whiteSpace: getComputedStyle(element).whiteSpace })),
  ]);
  const [firstBox, secondBox, sentenceBox, cellBox, sentenceLayout] = geometry;
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(sentenceBox).not.toBeNull();
  expect(cellBox).not.toBeNull();
  expect(sentenceLayout.whiteSpace).toBe("normal");
  expect(sentenceLayout.scrollHeight).toBeLessThanOrEqual(sentenceLayout.height);
  expect(firstBox?.height).toBeGreaterThan(secondBox?.height ?? 0);
  expect((sentenceBox?.y ?? 0) + (sentenceBox?.height ?? 0)).toBeLessThanOrEqual((cellBox?.y ?? 0) + (cellBox?.height ?? 0));
  expect((sentenceBox?.y ?? 0) + (sentenceBox?.height ?? 0)).toBeLessThanOrEqual(secondBox?.y ?? 0);
});
