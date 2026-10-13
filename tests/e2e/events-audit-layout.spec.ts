import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "events-audit-layout-418";
const channel = {
  channelId,
  login: "layout-kanal",
  displayName: "Layout Kanal",
  role: "manager",
  streamState: "online",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "layout-sub", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" },
  lastError: null,
};

const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
const at = (daysAgo: number, minutesAgo = 0): string => new Date(Date.now() - daysAgo * 86_400_000 - minutesAgo * 60_000).toISOString();
const events = [
  { eventId: "event-recent", createdAt: at(0, 2), moduleId: "host", triggerId: "trigger-recent", code: "host.chat.failed", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null },
  { eventId: "event-actor", createdAt: at(0, 45), moduleId: "host", triggerId: "trigger-actor", code: "host.action.failed", detail: "{}", actorUserId: "member-1", actorLogin: "mira_fox", actorDisplayName: "Mira Fox" },
  { eventId: "event-older", createdAt: at(3, 10), moduleId: "votekick", triggerId: "trigger-older", code: "host.chat.failed", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null },
];
const audit = [
  { auditId: "audit-recent", actorUserId: "member-1", actorLogin: null, actorDisplayName: "Mira Fox", actorKind: "member", createdAt: at(0, 5), moduleId: null, action: "member.role_changed", before: JSON.stringify({ role: "manager" }), after: JSON.stringify({ role: "operator" }), subjectUserId: "member-2", subjectLogin: "otto_owl", subjectDisplayName: "Otto Owl" },
  { auditId: "audit-older", actorUserId: "member-2", actorLogin: null, actorDisplayName: "Mira Fox", actorKind: "member", createdAt: at(3, 10), moduleId: null, action: "member.role_changed", before: JSON.stringify({ role: "manager" }), after: JSON.stringify({ role: "operator" }), subjectUserId: "member-3", subjectLogin: "pixel_panda", subjectDisplayName: "Pixel Panda" },
];

const mockApi = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [channel], bot: channel.bot }));
    if (pathname === `/api/channels/${channelId}/overview`) return route.fulfill(json({ ...channel, activeModules: [] }));
    if (pathname === `/api/channels/${channelId}/settings`) return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules: [{ id: "votekick", enabled: true, settings: "{}" }] }));
    if (pathname === `/api/channels/${channelId}/events`) return route.fulfill(json({ entries: events, nextCursor: null }));
    if (pathname === `/api/channels/${channelId}/audit-log` || pathname === `/api/channels/${channelId}/audit`) return route.fulfill(json({ entries: audit, nextCursor: null }));
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "layout-token" }));
    return route.fulfill(json({}));
  });
};

const box = async (locator: Locator) => {
  const value = await locator.boundingBox();
  if (value === null) throw new Error("The layout element should have a bounding box.");
  return { ...value, right: value.x + value.width, bottom: value.y + value.height };
};

const expectStableHeight = async (page: Page, locator: Locator, expectedHeight: number): Promise<void> => {
  const first = await box(locator);
  expect(first.height).toBe(expectedHeight);
  await page.waitForTimeout(200);
  const settled = await box(locator);
  expect(settled.y).toBe(first.y);
  expect(settled.height).toBe(first.height);
};

const expectChipGroupsFit = async (groups: Locator): Promise<void> => {
  for (const group of await groups.all()) {
    const groupBox = await box(group);
    for (const option of await group.locator(".ui-chip-group__option").all()) {
      expect((await box(option)).right).toBeLessThanOrEqual(groupBox.right + 1);
    }
  }
};

test("events and audit keep their table geometry across desktop and mobile widths", async ({ page }) => {
  await mockApi(page);
  for (const width of [1920, 1280, 390]) {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : width === 1280 ? 800 : 844 });

    await page.goto(`/channels/${channelId}/events`);
    const eventTable = page.locator(".event-table");
    await expect(eventTable.locator("tbody tr:not(.data-table__day-row)")).toHaveCount(events.length);
    const eventToolbar = page.locator(".list-toolbar.event-filter");
    const eventHeader = await box(eventTable.locator("thead th").first());
    const eventFilter = await box(eventToolbar);
    const eventGap = eventHeader.y - eventFilter.bottom;
    expect(eventGap).toBeGreaterThanOrEqual(0);
    expect(eventGap).toBeLessThanOrEqual(32);
    expect(await eventTable.locator("time").evaluateAll((times) => times.every((time) => time.scrollWidth <= time.clientWidth))).toBe(true);
    await expectChipGroupsFit(page.locator(".list-toolbar.event-filter .event-filter__chips"));

    const eventRows = eventTable.locator("tbody tr:not(.data-table__day-row)");
    if (width > 639) {
      expect(await eventRows.evaluateAll((rows) => rows.every((row) => Math.abs(row.getBoundingClientRect().height - 40) <= 1))).toBe(true);
    } else {
      const filters = page.locator(".list-toolbar.event-filter .list-toolbar__filters");
      await expectStableHeight(page, filters, 132);
      const firstRow = eventRows.first();
      const time = await box(firstRow.locator("time"));
      const primary = await box(firstRow.locator(".event-table__primary"));
      const metadata = await box(firstRow.locator(".event-table__mobile-meta"));
      expect(primary.y).toBeLessThan(time.bottom);
      expect(primary.bottom).toBeGreaterThan(time.y);
      expect(metadata.y).toBeGreaterThanOrEqual(primary.y + primary.height - 1);
      expect(metadata.height).toBeGreaterThan(0);
      await expect(firstRow.locator(".event-table__mobile-meta > .data-table__module-group")).toBeVisible();
      expect((await box(firstRow)).height).toBeGreaterThan(40);
    }

    const lastEventRow = await box(eventRows.last());
    const feedEnd = await box(page.locator(".events-page__pagination-slot .empty-state"));
    expect(feedEnd.y).toBeGreaterThanOrEqual(lastEventRow.y + lastEventRow.height - 1);

    await page.goto(`/channels/${channelId}/audit`);
    const auditTable = page.locator(".audit-sentence-list");
    await expect(auditTable.locator("tbody tr:not(.data-table__day-row)")).toHaveCount(audit.length);
    const auditToolbar = page.locator(".dashboard-filter-bar.audit-filter");
    const auditHeader = await box(auditTable.locator("thead th").first());
    const auditFilter = await box(auditToolbar);
    const auditGap = auditHeader.y - auditFilter.bottom;
    expect(auditGap).toBeGreaterThanOrEqual(0);
    expect(auditGap).toBeLessThanOrEqual(24);
    expect(await auditTable.locator("time").evaluateAll((times) => times.every((time) => time.scrollWidth <= time.clientWidth))).toBe(true);
    await expectChipGroupsFit(page.locator(".dashboard-filter-bar.audit-filter .event-filter__chips"));

    const auditRows = auditTable.locator("tbody tr:not(.data-table__day-row)");
    if (width > 639) {
      expect(await auditRows.evaluateAll((rows) => rows.every((row) => Math.abs(row.getBoundingClientRect().height - 40) <= 1))).toBe(true);
    } else {
      const controls = page.locator(".dashboard-filter-bar.audit-filter .dashboard-filter-bar__controls");
      await expectStableHeight(page, controls, 132);
      const firstRow = auditRows.first();
      const sentence = firstRow.locator(".audit-sentence-row__sentence");
      const area = firstRow.locator(".data-table__column--area .ui-badge");
      const time = await box(firstRow.locator("time"));
      const areaBox = await box(area);
      const sentenceBox = await box(firstRow.locator(".data-table__column--change"));
      expect(areaBox.y).toBeLessThan(time.bottom);
      expect(areaBox.bottom).toBeGreaterThan(time.y);
      expect(sentenceBox.y).toBeGreaterThan(time.bottom);
      expect(await area.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await sentence.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("normal");
      expect(await sentence.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    }
  }
});
