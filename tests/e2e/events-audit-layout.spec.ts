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

const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });
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
const secondAuditEntry = audit[1];
if (secondAuditEntry === undefined) throw new Error("The audit fixture should contain a second entry.");
const manyAuditEntries = Array.from({ length: 48 }, (_, index) => ({
  auditId: `scroll-audit-${String(index)}`,
  actorUserId: "member-1",
  actorLogin: null,
  actorDisplayName: `Reader ${String(index)}`,
  actorKind: "member",
  createdAt: at(Math.floor(index / 12), index),
  moduleId: index % 2 === 0 ? "members" : "votekick",
  action: "member.role_changed",
  before: JSON.stringify({ role: "manager" }),
  after: JSON.stringify({ role: "operator" }),
  subjectUserId: `subject-${String(index)}`,
  subjectLogin: `person_${String(index)}`,
  subjectDisplayName: `Person ${String(index)}`,
}));
const firstAuditEntry = manyAuditEntries.at(0);
if (firstAuditEntry === undefined) throw new Error("The audit fixture should contain entries.");
const channelVariables = [
  { channelId, name: "score", value: 1234, description: "Punkte im aktuellen Spiel", resetOnStreamStart: true, createdAt: at(10), updatedAt: at(1), usages: [] },
  { channelId, name: "long_counter_name_123456789", value: -42, description: "Ein längerer Beschreibungstext für einen schmalen Bildschirm", resetOnStreamStart: false, createdAt: at(9), updatedAt: at(2), usages: [] },
  { channelId, name: "abcdefghijklmnopqrstuvwxyzabcdef", value: -999999999, description: "Ein weiterer Zähler", resetOnStreamStart: false, createdAt: at(8), updatedAt: at(3), usages: [] },
];

interface SettingsGate {
  wait: Promise<void>;
  started: () => void;
}

interface MockApiOptions {
  eventEntries?: readonly Record<string, unknown>[];
  auditEntries?: readonly Record<string, unknown>[];
  variableEntries?: readonly Record<string, unknown>[] | (() => readonly Record<string, unknown>[]);
  legacyTokens?: readonly Record<string, unknown>[];
  channelRole?: string;
  revisionVector?: () => Readonly<Record<string, number>>;
  settingsGate?: SettingsGate;
  settingsStatus?: number;
  eventStatus?: number;
  auditStatus?: number;
  auditNextCursor?: string | null;
  variableStatus?: number;
}

const mockApi = async (page: Page, options: MockApiOptions = {}): Promise<{ revisionReads: () => number }> => {
  let revisionReads = 0;
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [{ ...channel, role: options.channelRole ?? channel.role }], bot: channel.bot }));
    if (pathname === `/api/channels/${channelId}/overview`) return route.fulfill(json({ ...channel, activeModules: [] }));
    if (pathname === `/api/channels/${channelId}/settings`) {
      options.settingsGate?.started();
      if (options.settingsGate !== undefined) await options.settingsGate.wait;
      return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }, options.settingsStatus));
    }
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules: [{ id: "votekick", enabled: true, settings: "{}" }] }));
    if (pathname === `/api/channels/${channelId}/events`) return route.fulfill(json({ entries: options.eventEntries ?? events, nextCursor: null }, options.eventStatus));
    if (pathname === `/api/channels/${channelId}/audit-log` || pathname === `/api/channels/${channelId}/audit`) {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      const pageEntries = cursor === "cursor-older"
        ? [{ ...secondAuditEntry, auditId: "audit-next-page", createdAt: at(5, 20) }]
        : options.auditEntries ?? audit;
      return route.fulfill(json({ entries: pageEntries, nextCursor: cursor === "cursor-older" ? null : options.auditNextCursor ?? null }, options.auditStatus));
    }
    if (pathname === `/api/channels/${channelId}/variables`) {
      const variableEntries = typeof options.variableEntries === "function" ? options.variableEntries() : options.variableEntries ?? channelVariables;
      return route.fulfill(json({ variables: variableEntries, count: variableEntries.length, maximum: 25 }, options.variableStatus));
    }
    if (pathname === `/api/channels/${channelId}/overlay-tokens`) return route.fulfill(json({ tokens: options.legacyTokens ?? [], nextOffset: null }));
    if (pathname === `/api/channels/${channelId}/overlays`) return route.fulfill(json({ overlays: [], maximum: 20, elementMaximum: 20 }));
    if (pathname === `/api/channels/${channelId}/revisions`) {
      revisionReads += 1;
      return route.fulfill(json({ revisions: options.revisionVector?.() ?? {} }));
    }
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "layout-token" }));
    return route.fulfill(json({}));
  });
  return { revisionReads: () => revisionReads };
};

const manyEvents = Array.from({ length: 60 }, (_, index) => ({
  eventId: `scroll-event-${String(index)}`,
  createdAt: at(Math.floor(index / 20), index % 20),
  moduleId: "host",
  triggerId: `scroll-trigger-${String(index)}`,
  code: "host.chat.failed",
  detail: "{}",
  actorUserId: null,
  actorLogin: null,
  actorDisplayName: null,
}));

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
  await mockApi(page, { auditEntries: manyAuditEntries, auditNextCursor: "cursor-older" });
  for (const [width, height] of [[1920, 1080], [1280, 800], [390, 844], [2560, 1440]] as const) {
    await page.setViewportSize({ width, height });

    await page.goto(`/channels/${channelId}/events`);
    const eventTable = page.locator(".event-table");
    await expect(eventTable.locator("tbody tr:not(.data-table__day-row)")).toHaveCount(events.length);
    const eventToolbar = page.locator(".list-toolbar.event-filter");
    const eventFilterControls = page.locator(".list-toolbar.event-filter .list-toolbar__filters");
    const eventHeader = await box(eventTable.locator("thead th").first());
    const eventFilter = await box(eventToolbar);
    const eventGap = eventHeader.y - eventFilter.bottom;
    expect(eventGap).toBeGreaterThanOrEqual(0);
    expect(eventGap).toBeLessThanOrEqual(32);
    const eventPageHeader = await box(page.locator(".module-detail-heading"));
    expect(Math.abs(eventFilter.x - eventPageHeader.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(eventFilter.right - eventPageHeader.right)).toBeLessThanOrEqual(1);
    const eventTableBox = await box(eventTable);
    expect(Math.abs(eventTableBox.x - eventFilter.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(eventTableBox.right - eventFilter.right)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("heading", { name: "Ereignisprotokoll" })).toHaveCount(0);
    await expect(page.locator(".event-filter__group-label")).toHaveText(["Art", "Stufe"]);
    const typeLabel = await box(page.locator(".event-filter__group-label").nth(0));
    const severityLabel = await box(page.locator(".event-filter__group-label").nth(1));
    const typeControl = await box(eventFilterControls.locator(".event-filter__chips").nth(0));
    const severityControl = await box(eventFilterControls.locator(".event-filter__chips").nth(1));
    const moduleControl = await box(eventFilterControls.locator(".ui-select__trigger"));
    if (width > 639) {
      expect(Math.abs(typeLabel.y - severityLabel.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(typeControl.bottom - severityControl.bottom)).toBeLessThanOrEqual(1);
      expect(Math.abs(typeControl.bottom - moduleControl.bottom)).toBeLessThanOrEqual(1);
    } else {
      expect(typeLabel.bottom).toBeLessThanOrEqual(typeControl.y);
      expect(severityLabel.bottom).toBeLessThanOrEqual(severityControl.y);
      expect(typeLabel.y).toBeLessThan(severityLabel.y);
    }
    expect(await eventTable.locator("time").evaluateAll((times) => times.every((time) => time.scrollWidth <= time.clientWidth))).toBe(true);
    await expectChipGroupsFit(page.locator(".list-toolbar.event-filter .event-filter__chips"));

    const eventRows = eventTable.locator("tbody tr:not(.data-table__day-row)");
    if (width > 639) {
      expect(await eventRows.evaluateAll((rows) => rows.every((row) => Math.abs(row.getBoundingClientRect().height - 40) <= 1))).toBe(true);
    } else {
      const filters = page.locator(".list-toolbar.event-filter .list-toolbar__filters");
      await expectStableHeight(page, filters, 190);
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
    const feedEndLocator = page.locator(".events-page__pagination-slot .events-page__feed-end");
    const feedEnd = await box(feedEndLocator);
    expect(feedEnd.y).toBeGreaterThanOrEqual(lastEventRow.y + lastEventRow.height - 1);
    expect(Math.abs(feedEnd.x - eventTableBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(feedEnd.right - eventTableBox.right)).toBeLessThanOrEqual(1);
    expect(await feedEndLocator.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("none");
    expect(await feedEndLocator.evaluate((element) => getComputedStyle(element).paddingTop)).toBe("0px");

    await page.goto(`/channels/${channelId}/audit`);
    const auditTable = page.locator(".audit-sentence-list");
    await expect(auditTable.locator("tbody tr:not(.data-table__day-row)")).toHaveCount(manyAuditEntries.length);
    const auditToolbar = page.locator(".dashboard-filter-bar.audit-filter");
    const auditHeader = await box(auditTable.locator("thead th").first());
    const auditFilter = await box(auditToolbar);
    const auditGap = auditHeader.y - auditFilter.bottom;
    expect(auditGap).toBeGreaterThanOrEqual(0);
    expect(auditGap).toBeLessThanOrEqual(52);
    const auditPageHeader = await box(page.locator(".module-detail-heading"));
    expect(Math.abs(auditFilter.x - auditPageHeader.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(auditFilter.right - auditPageHeader.right)).toBeLessThanOrEqual(1);
    const auditTableBox = await box(auditTable);
    expect(Math.abs(auditTableBox.x - auditFilter.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(auditTableBox.right - auditFilter.right)).toBeLessThanOrEqual(1);
    const loadedCount = page.locator(".audit-filter__count");
    await expect(loadedCount).toContainText("geladen");
    const loadedCountBox = await box(loadedCount);
    expect(loadedCountBox.x).toBeGreaterThan(auditFilter.x + auditFilter.width / 2);
    expect(loadedCountBox.y).toBeGreaterThanOrEqual(auditFilter.y);
    expect(loadedCountBox.bottom).toBeLessThanOrEqual(auditFilter.bottom + 1);
    const auditPagination = await box(page.locator(".audit-pagination"));
    expect(auditPagination.y).toBeGreaterThanOrEqual(auditFilter.bottom);
    expect(auditPagination.bottom).toBeLessThanOrEqual(auditHeader.y + 1);
    const olderEntriesButton = page.getByRole("button", { name: "Ältere Einträge laden" });
    await expect(olderEntriesButton).toBeVisible();
    const olderButtonBox = await box(olderEntriesButton);
    expect(await olderEntriesButton.evaluate((element) => getComputedStyle(element).marginTop)).toBe("0px");
    expect(olderButtonBox.y).toBeGreaterThanOrEqual(auditPagination.y);
    expect(olderButtonBox.bottom).toBeLessThanOrEqual(auditPagination.bottom + 1);
    expect(Math.abs((olderButtonBox.y + olderButtonBox.height / 2) - (auditPagination.y + auditPagination.height / 2))).toBeLessThanOrEqual(2);
    expect(await auditTable.locator("time").evaluateAll((times) => times.every((time) => time.scrollWidth <= time.clientWidth))).toBe(true);
    await expectChipGroupsFit(page.locator(".dashboard-filter-bar.audit-filter .event-filter__chips"));

    await olderEntriesButton.click();
    await expect(auditTable.locator("tbody tr:not(.data-table__day-row)")).toHaveCount(manyAuditEntries.length + 1);

    const auditRows = auditTable.locator("tbody tr:not(.data-table__day-row)");
    expect(await auditRows.locator(".audit-sentence-row__sentence").evaluateAll((sentences) => sentences.every((sentence) => sentence.scrollHeight <= sentence.clientHeight))).toBe(true);
    if (width > 639) {
      expect(await auditRows.evaluateAll((rows) => rows.every((row) => row.getBoundingClientRect().height >= 40))).toBe(true);
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

test("variables collection keeps the editor in its column without horizontal overflow", async ({ page }) => {
  await mockApi(page, { variableEntries: channelVariables });
  for (const [width, height] of [[1920, 1080], [1280, 800], [390, 844], [2560, 1440]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`/channels/${channelId}/variables`);
    const collection = page.locator(".channel-variables-page .collection-page");
    await expect(collection).toHaveAttribute("data-single-column", width <= 935 ? "true" : "false");
    const channelEventsLink = page.locator(".sidebar__group[data-category='admin'] .sidebar-nav-link[data-nav-page-id='events']");
    await expect(channelEventsLink.locator("xpath=following-sibling::a[1]")).toHaveAttribute("data-nav-page-id", "audit");
    const table = page.locator(".channel-variables-table");
    await expect(table.locator("tbody tr")).toHaveCount(channelVariables.length);
    if (width > 640) expect(await table.evaluate((element) => getComputedStyle(element).tableLayout)).toBe("fixed");
    const pageHeader = page.locator(".channel-variables-page .collection-page__heading .page-header");
    await expect(pageHeader.locator(".page-header__icon")).toBeVisible();
    await expect(pageHeader.locator(".page-header__copy > p")).toBeVisible();
    const toolbarSearch = await box(page.locator(".channel-variables-page .list-toolbar__search"));
    const toolbarCreate = await box(page.locator(".channel-variables-page .list-toolbar__create"));
    expect(Math.abs(toolbarSearch.y - toolbarCreate.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(toolbarSearch.height - toolbarCreate.height)).toBeLessThanOrEqual(1);
    const selectedRow = table.locator("tbody tr").first();
    const longNameCell = table.locator("tbody tr").filter({ hasText: "long_counter_name_123456789" }).locator("th[scope='row']");
    await expect(longNameCell).toHaveAttribute("title", "{var.long_counter_name_123456789}");
    await expect(longNameCell).toHaveAttribute("aria-label", "{var.long_counter_name_123456789}");
    expect(await longNameCell.evaluate((cell) => getComputedStyle(cell).overflowWrap)).toBe("normal");
    expect(await longNameCell.evaluate((cell) => getComputedStyle(cell).wordBreak)).toBe("normal");
    const descriptionCells = table.locator(".channel-variables-table__description");
    const descriptionText = table.locator(".channel-variables-table__description-text");
    expect(await descriptionText.evaluateAll((elements) => elements.every((element) => getComputedStyle(element).webkitLineClamp === "2"))).toBe(true);
    const descriptionGeometry = await descriptionText.evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const bounds = element.getBoundingClientRect();
      return { height: bounds.height, lineHeight };
    }));
    expect(descriptionGeometry.every(({ height, lineHeight }) => height <= lineHeight * 2 + 1)).toBe(true);
    const rowBounds = await table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => {
      const bounds = row.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom };
    }));
    for (let index = 1; index < rowBounds.length; index += 1) {
      const previousRow = rowBounds[index - 1];
      const currentRow = rowBounds[index];
      if (previousRow === undefined || currentRow === undefined) throw new Error("A variable row should have measurable bounds");
      expect(currentRow.top).toBeGreaterThanOrEqual(previousRow.bottom - 1);
    }
    expect((await box(descriptionCells.first())).width).toBeGreaterThan((await box(table.locator(".channel-variables-table__value").first())).width);
    if (width <= 639) {
      const descriptionBox = await box(selectedRow.locator(".channel-variables-table__description"));
      const resetBox = await box(selectedRow.locator(".channel-variables-table__reset"));
      expect(descriptionBox.right).toBeLessThanOrEqual(resetBox.x + 1);
      const variableName = await box(selectedRow.locator("th[scope='row']"));
      expect(variableName.width).toBeGreaterThanOrEqual(descriptionBox.width - 1);
    }
    await selectedRow.click();
    const editor = page.locator(".channel-variable-editor");
    await expect(editor).toBeVisible();
    const editorBox = await box(editor);
    const headerBox = await box(editor.locator(".channel-variable-editor__header .page-header"));
    expect(headerBox.x).toBeGreaterThanOrEqual(editorBox.x - 1);
    expect(headerBox.right).toBeLessThanOrEqual(editorBox.right + 1);
    const saveCluster = await box(editor.locator(".page-header__save"));
    const closeAction = await box(editor.getByRole("button", { name: "Schließen" }));
    const overflowAction = await box(editor.getByRole("button", { name: "Weitere Aktionen" }));
    expect(Math.abs(saveCluster.y - closeAction.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(saveCluster.y - overflowAction.y)).toBeLessThanOrEqual(2);
    const overlayButton = editor.getByRole("button", { name: "In Overlay verwenden" });
    await expect(overlayButton).toBeVisible();
    await expect(editor.getByRole("heading", { name: "In Overlay verwenden" })).toHaveCount(0);
    expect((await box(overlayButton)).width).toBeLessThan((await box(editor)).width);
    const nameRow = editor.locator(".inspector-field-row:has(#channel-variable-name)");
    const nameLabel = await box(nameRow.locator(".inspector-field-row__label"));
    const nameField = await box(nameRow.locator(".inspector-field-row__control"));
    expect(nameField.y).toBeGreaterThanOrEqual(nameLabel.bottom);
    const generalHeading = await box(editor.locator(".ui-section--inspector").first().locator(".ui-section__heading"));
    expect(generalHeading.y - headerBox.bottom).toBeGreaterThanOrEqual(0);
    expect(generalHeading.y - headerBox.bottom).toBeLessThanOrEqual(48);
    const nameCount = await box(nameRow.locator(".ui-field__description"));
    const descriptionLabel = await box(editor.locator(".inspector-field-row:has(#channel-variable-description) .inspector-field-row__label"));
    expect(descriptionLabel.y - nameCount.bottom).toBeGreaterThanOrEqual(0);
    expect(descriptionLabel.y - nameCount.bottom).toBeLessThanOrEqual(20);
    const resetRow = editor.locator(".ui-switch-row");
    const resetLabel = await box(resetRow.locator(".ui-switch-row__copy strong"));
    const resetSwitch = await box(resetRow.getByRole("switch", { name: "Bei Streamstart auf null setzen" }));
    expect(Math.abs((resetLabel.y + resetLabel.height / 2) - (resetSwitch.y + resetSwitch.height / 2))).toBeLessThanOrEqual(3);
    const editorTitle = editor.locator(".channel-variable-editor__header .page-header__title-row .mono");
    await expect(editorTitle.locator("wbr")).toHaveCount(1);
    expect(await editorTitle.evaluate((element) => getComputedStyle(element).wordBreak)).toBe("normal");
    if (width <= 640) {
      const titleHeading = editor.locator(".channel-variable-editor__header .page-header__title-row h2");
      const titleActions = editor.locator(".channel-variable-editor__header .page-header__right");
      await expect(editorTitle).toHaveAttribute("title", "{var.score}");
      expect(await titleHeading.evaluate((element) => getComputedStyle(element).textOverflow)).toBe("ellipsis");
      expect(await titleHeading.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("nowrap");
      const titleHeadingBox = await box(titleHeading);
      const titleActionsBox = await box(titleActions);
      expect(titleActionsBox.y).toBeGreaterThanOrEqual(titleHeadingBox.bottom);
      expect(titleActionsBox.right).toBeLessThanOrEqual(headerBox.right + 1);
      for (const action of await titleActions.getByRole("button").all()) {
        const actionBox = await box(action);
        expect(actionBox.x).toBeGreaterThanOrEqual(headerBox.x - 1);
        expect(actionBox.right).toBeLessThanOrEqual(headerBox.right + 1);
      }
    }
    const editorTitleBox = await box(editorTitle);
    expect(editorTitleBox.x).toBeGreaterThanOrEqual(headerBox.x - 1);
    expect(editorTitleBox.right).toBeLessThanOrEqual(headerBox.right + 1);
    expect(await selectedRow.evaluate((row) => getComputedStyle(row).outlineWidth)).toBe("1px");
    expect(await selectedRow.evaluate((row) => getComputedStyle(row).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator(".dashboard-shell__main").evaluate((main) => main.scrollWidth <= main.clientWidth)).toBe(true);
    if (width <= 935) await page.getByRole("button", { name: "Zurück zur Liste" }).click();
    await longNameCell.click();
    const longEditorTitle = editor.locator(".channel-variable-editor__header .page-header__title-row .mono");
    const longTitleBox = await box(longEditorTitle);
    expect(longTitleBox.x).toBeGreaterThanOrEqual(headerBox.x - 1);
    expect(longTitleBox.right).toBeLessThanOrEqual(headerBox.right + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width === 1280) {
      const unbrokenRow = table.locator("tbody tr").filter({ hasText: "abcdefghijklmnopqrstuvwxyzabcdef" });
      const unbrokenNameCell = unbrokenRow.locator("th[scope='row']");
      const unbrokenName = unbrokenNameCell.locator(".channel-variables-table__name");
      const valueCell = unbrokenRow.locator(".channel-variables-table__value");
      await expect(unbrokenNameCell).toHaveAttribute("title", "{var.abcdefghijklmnopqrstuvwxyzabcdef}");
      await expect(unbrokenNameCell).toHaveAttribute("aria-label", "{var.abcdefghijklmnopqrstuvwxyzabcdef}");
      expect(await unbrokenName.evaluate((element) => getComputedStyle(element).textOverflow)).toBe("ellipsis");
      await expect(valueCell).toHaveText("-999.999.999");
      expect(await page.locator(".channel-variables-table-wrap").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await table.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await box(unbrokenNameCell)).right).toBeLessThanOrEqual((await box(table)).right + 1);
      expect((await box(valueCell)).right).toBeLessThanOrEqual((await box(table)).right + 1);
    }
  }
});

test("initial collection and feed errors stay inline without covering the page", async ({ page }) => {
  await mockApi(page, { eventStatus: 500, auditStatus: 500, variableStatus: 500 });
  await page.setViewportSize({ width: 390, height: 844 });

  for (const path of ["variables", "events", "audit"] as const) {
    await page.goto(`/channels/${channelId}/${path}`);
    const errorState = page.locator(".ui-load-state[data-status='error']");
    await expect(errorState).toBeVisible();
    await expect(errorState.locator("[role='alert']").first()).toBeVisible();
    await expect(page.locator(".ui-toast-host .ui-toast")).toHaveCount(0);

    const header = await box(page.locator(".dashboard-shell__header"));
    const error = await box(errorState);
    expect(error.y).toBeGreaterThanOrEqual(header.bottom);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("operators see one definition permission reason while live value controls stay enabled", async ({ page }) => {
  await mockApi(page, { channelRole: "operator", variableEntries: channelVariables });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}/variables`);
  await page.locator(".channel-variables-table tbody tr").first().click();
  const editor = page.locator(".channel-variable-editor");
  await expect(editor).toBeVisible();
  const permissionNote = editor.locator(".channel-variable-management-note");
  await expect(permissionNote).toContainText(/Nur Broadcaster und Verwalter dürfen Variablen/u);
  await expect(editor.getByText(/Nur Broadcaster und Verwalter dürfen Variablen/u)).toHaveCount(1);
  const properties = editor.locator(".channel-variable-definition-properties");
  await expect(properties).toContainText("score");
  await expect(properties).toContainText("Punkte im aktuellen Spiel");
  const propertiesBox = await box(properties);
  const permissionNoteBox = await box(permissionNote);
  expect(permissionNoteBox.x).toBeGreaterThanOrEqual(propertiesBox.x);
  expect(permissionNoteBox.right).toBeLessThanOrEqual(propertiesBox.right + 1);
  expect(permissionNoteBox.y).toBeGreaterThanOrEqual(propertiesBox.bottom);
  expect(await permissionNote.evaluate((element) => getComputedStyle(element).lineHeight)).toBe("16.8px");
  await expect(editor.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  await expect(editor.getByRole("switch", { name: "Bei Streamstart auf null setzen" })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Speichern" })).toBeDisabled();
  await expect(editor.getByRole("button", { name: "+1" })).toBeEnabled();
});

test("legacy-link rename warning uses an overlay without moving editor fields", async ({ page }) => {
  await mockApi(page, {
    variableEntries: channelVariables,
    legacyTokens: [{ id: "legacy-a", name: null, createdAt: at(1), createdBy: "Mira", lastUsedAt: null, expiresAt: null }],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}/variables`);
  await page.locator(".channel-variables-table tbody tr").first().click();
  const editor = page.locator(".channel-variable-editor");
  const descriptionRow = editor.locator(".inspector-field-row:has(#channel-variable-description)");
  const before = await box(descriptionRow);
  await editor.getByRole("textbox", { name: "Name" }).fill("points");
  await expect(editor.getByRole("note")).toContainText("Alte Links mit #var=…");
  await expect(page.locator(".ui-toast-host .ui-toast")).toContainText("Alte Links mit #var=…");
  const after = await box(descriptionRow);
  expect(after).toEqual(before);
  const toast = await box(page.locator(".ui-toast-host .ui-toast"));
  expect(toast.x).toBeGreaterThanOrEqual(0);
  expect(toast.right).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a remote variable conflict uses an overlay without moving editor fields", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let currentVariables = [...channelVariables];
  let variableRevision = 1;
  const revisions = await mockApi(page, {
    variableEntries: () => currentVariables,
    revisionVector: () => ({ "channel.variables": variableRevision }),
  });
  let announceSocketReady: (() => void) | undefined;
  let socketSender: ((message: string) => void) | undefined;
  const socketReady = new Promise<void>((resolve) => { announceSocketReady = resolve; });
  await page.routeWebSocket(`**/ws/channels/${channelId}`, (socket) => {
    socketSender = (message) => { socket.send(message); };
    announceSocketReady?.();
    socket.onMessage(() => undefined);
  });

  await page.goto(`/channels/${channelId}/variables`);
  await expect(page.locator(".channel-variables-table tbody tr")).toHaveCount(channelVariables.length);
  await socketReady;
  await expect.poll(() => revisions.revisionReads()).toBeGreaterThan(0);
  const scoreRow = page.locator(".channel-variables-table tbody tr").filter({ hasText: "score" });
  await scoreRow.click();
  const editor = page.locator(".channel-variable-editor");
  const generalSection = editor.locator(".ui-section--inspector").first();
  const sectionBefore = await box(generalSection);

  currentVariables = currentVariables.filter((variable) => variable.name !== "score");
  variableRevision = 2;
  socketSender?.(JSON.stringify({
    version: 1,
    id: "remote-variable-deleted",
    createdAt: at(0),
    channelId,
    type: "panel.resources.changed",
    payload: { resources: ["channel.variables"], revisions: { "channel.variables": variableRevision } },
  }));

  await expect(editor.getByRole("status")).toContainText("umbenannt oder gelöscht");
  await expect(page.locator(".ui-toast-host .ui-toast")).toContainText("umbenannt oder gelöscht");
  expect(await box(generalSection)).toEqual(sectionBefore);
});

test("new realtime audit entries do not shift the first row while the reader is at the top", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const mutableAudit = [...manyAuditEntries];
  let revision = 1;
  const revisions = await mockApi(page, {
    auditEntries: mutableAudit,
    revisionVector: () => ({ "channel.audit": revision }),
  });
  let announceSocketReady: (() => void) | undefined;
  let socketSender: ((message: string) => void) | undefined;
  const socketReady = new Promise<void>((resolve) => { announceSocketReady = resolve; });
  await page.routeWebSocket(`**/ws/channels/${channelId}`, (socket) => {
    socketSender = (message) => { socket.send(message); };
    announceSocketReady?.();
    socket.onMessage(() => undefined);
  });

  await page.goto(`/channels/${channelId}/audit`);
  await expect(page.locator(".audit-sentence-list tbody tr:not(.data-table__day-row)")).toHaveCount(mutableAudit.length);
  await socketReady;
  await expect.poll(() => revisions.revisionReads()).toBeGreaterThan(0);

  const main = page.locator(".dashboard-shell__main");
  const table = page.locator(".audit-sentence-list");
  const firstRow = table.locator("tbody tr:not(.data-table__day-row)").first();
  await expect(firstRow).toBeInViewport();
  const readingRowBefore = await box(firstRow);

  const newEntry = {
    ...firstAuditEntry,
    auditId: "realtime-audit-new-at-top",
    actorDisplayName: "Tessa Reimann",
    createdAt: at(0, 1),
  };
  mutableAudit.unshift(newEntry);
  revision = 2;
  socketSender?.(JSON.stringify({
    version: 1,
    id: "realtime-audit-hint-at-top",
    createdAt: newEntry.createdAt,
    channelId,
    type: "event_log.new",
    payload: { entries: [{ eventId: newEntry.auditId, createdAt: newEntry.createdAt, moduleId: "members", code: "member.role_changed", actorUserId: newEntry.actorUserId }] },
  }));

  await expect(page.getByRole("button", { name: /^1 neuer Eintrag/u })).toBeVisible();
  expect(await box(firstRow)).toEqual(readingRowBefore);
  expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(firstRow).not.toContainText("Tessa Reimann");
});

test("new realtime audit entries do not move the row being read", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const mutableAudit = [...manyAuditEntries];
  let revision = 1;
  const revisions = await mockApi(page, {
    auditEntries: mutableAudit,
    revisionVector: () => ({ "channel.audit": revision }),
  });
  let announceSocketReady: (() => void) | undefined;
  let socketSender: ((message: string) => void) | undefined;
  const socketReady = new Promise<void>((resolve) => { announceSocketReady = resolve; });
  await page.routeWebSocket(`**/ws/channels/${channelId}`, (socket) => {
    socketSender = (message) => { socket.send(message); };
    announceSocketReady?.();
    socket.onMessage(() => undefined);
  });

  await page.goto(`/channels/${channelId}/audit`);
  await expect(page.locator(".audit-sentence-list tbody tr:not(.data-table__day-row)")).toHaveCount(mutableAudit.length);
  await socketReady;
  await expect.poll(() => revisions.revisionReads()).toBeGreaterThan(0);

  const main = page.locator(".dashboard-shell__main");
  const table = page.locator(".audit-sentence-list");
  const readingRow = table.locator("tbody tr:not(.data-table__day-row)").nth(24);
  await readingRow.scrollIntoViewIfNeeded();
  await expect(readingRow).toBeInViewport();
  const readingRowBefore = await box(readingRow);
  const scrollTopBefore = await main.evaluate((element) => element.scrollTop);
  expect(scrollTopBefore).toBeGreaterThan(0);

  const newEntry = {
    ...firstAuditEntry,
    auditId: "realtime-audit-new",
    actorDisplayName: "Mira Fox",
    createdAt: at(0, 1),
  };
  mutableAudit.unshift(newEntry);
  revision = 2;
  socketSender?.(JSON.stringify({
    version: 1,
    id: "realtime-audit-hint",
    createdAt: newEntry.createdAt,
    channelId,
    type: "event_log.new",
    payload: { entries: [{ eventId: newEntry.auditId, createdAt: newEntry.createdAt, moduleId: "members", code: "member.role_changed", actorUserId: newEntry.actorUserId }] },
  }));

  const latestEntriesButton = page.getByRole("button", { name: /^1 neuer Eintrag/u });
  await expect(latestEntriesButton).toBeVisible();
  const readingRowAfter = await box(readingRow);
  expect(readingRowAfter.y).toBe(readingRowBefore.y);
  expect(await main.evaluate((element) => element.scrollTop)).toBe(scrollTopBefore);

  await latestEntriesButton.click();
  await expect(table.locator("tbody tr:not(.data-table__day-row)").first()).toContainText("Mira Fox");
});

test("event rows switch to the two-line layout when the inspector leaves a narrow list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApi(page, { eventEntries: manyEvents.slice(0, 1) });
  await page.goto(`/channels/${channelId}/events`);
  const table = page.locator(".event-table");
  const row = table.locator("tbody tr:not(.data-table__day-row)").first();
  await row.click();
  await expect(page.locator(".list-detail--open")).toBeVisible();

  const tableWidth = await table.evaluate((element) => element.getBoundingClientRect().width);
  expect(tableWidth).toBeLessThanOrEqual(640);
  await expect(row).toHaveCSS("display", "grid");
  const eventText = row.locator(".event-table__primary .event-table__text");
  await expect(eventText).toBeVisible();
  expect(await eventText.evaluate((element) => element.clientWidth)).toBeGreaterThanOrEqual(100);
  const primary = await box(row.locator(".event-table__primary"));
  const metadata = await box(row.locator(".event-table__mobile-meta"));
  expect(metadata.y).toBeGreaterThanOrEqual(primary.bottom - 1);
});

test("day headers stay below the dashboard header on desktop and mobile", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
    await mockApi(page, { eventEntries: manyEvents });
    await page.goto(`/channels/${channelId}/events`);
    const dayHeader = page.locator(".event-table .data-table__day-row th").nth(1);
    await expect(dayHeader).toBeVisible();
    await dayHeader.scrollIntoViewIfNeeded();
    const scrollDistance = await dayHeader.evaluate((day) => {
      const header = document.querySelector<HTMLElement>(".dashboard-shell__header");
      if (header === null) throw new Error("The dashboard header should render.");
      return day.getBoundingClientRect().top - header.getBoundingClientRect().bottom + 40;
    });
    await page.locator(".dashboard-shell__main").evaluate((main, distance) => { main.scrollBy(0, distance); }, scrollDistance);

    const geometry = await dayHeader.evaluate((day) => {
      const header = document.querySelector<HTMLElement>(".dashboard-shell__header");
      const main = document.querySelector<HTMLElement>(".dashboard-shell__main");
      if (header === null) throw new Error("The dashboard header should render.");
      if (main === null) throw new Error("The dashboard content scroller should render.");
      return { dayTop: day.getBoundingClientRect().top, headerBottom: header.getBoundingClientRect().bottom };
    });
    expect(geometry.dayTop).toBeGreaterThanOrEqual(geometry.headerBottom - 1);
    expect(geometry.dayTop).toBeLessThanOrEqual(geometry.headerBottom + 12);
  }
});

test("relative-time and day-label clock ticks keep event and audit row geometry stable", async ({ page }) => {
  const start = new Date("2026-10-13T21:59:45.000Z");
  // Install slightly earlier and pause at `start`, so the real runner speed cannot advance the page clock.
  await page.clock.install({ time: new Date(start.getTime() - 1000) });
  await page.clock.pauseAt(start);
  await mockApi(page, {
    eventEntries: [{ ...events[0], createdAt: start.toISOString() }],
    auditEntries: [{ ...audit[0], createdAt: start.toISOString() }],
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/channels/${channelId}/events`);

  const table = page.locator(".event-table");
  const row = table.locator("tbody tr:not(.data-table__day-row)").first();
  const time = row.locator("time");
  // The paused clock also holds app timers; nudge it with tiny steps until the row renders.
  await expect(async () => {
    await page.clock.runFor(10);
    await expect(row).toBeVisible({ timeout: 200 });
  }).toPass();
  await expect(time).toHaveText("jetzt");
  await expect(table.locator(".data-table__day-row")).toHaveText("Heute");
  const initial = await box(row);

  await page.clock.fastForward(30_000);

  await expect(time).toHaveText("vor 30 Sek.");
  await expect(table.locator(".data-table__day-row")).toHaveText("Gestern");
  expect(await box(row)).toEqual(initial);

  await page.goto(`/channels/${channelId}/audit`);
  const auditTable = page.locator(".audit-sentence-list");
  const auditRow = auditTable.locator("tbody tr:not(.data-table__day-row)").first();
  const auditTime = auditRow.locator("time");
  await expect(async () => {
    await page.clock.runFor(10);
    await expect(auditRow).toBeVisible({ timeout: 200 });
  }).toPass();
  await expect(auditTime).toHaveText("vor 30 Sek.");
  await expect(auditTable.locator(".data-table__day-row")).toHaveText("Gestern");
  const auditInitial = await box(auditRow);
  await page.clock.fastForward(30_000);
  await expect(auditTime).toHaveText("vor 1 Min.");
  expect(await box(auditRow)).toEqual(auditInitial);
});

test("event and audit tables reserve their date rows until channel settings resolve", async ({ page }) => {
  for (const path of ["events", "audit"] as const) {
    let releaseSettings: (() => void) | undefined;
    let markSettingsStarted: (() => void) | undefined;
    const settingsStarted = new Promise<void>((resolve) => { markSettingsStarted = resolve; });
    const settingsGate: SettingsGate = {
      wait: new Promise<void>((resolve) => { releaseSettings = resolve; }),
      started: () => { markSettingsStarted?.(); },
    };
    await mockApi(page, { settingsGate });
    await page.goto(`/channels/${channelId}/${path}`);
    await settingsStarted;

    const table = page.locator(path === "events" ? ".event-table" : ".audit-sentence-list");
    const placeholder = page.locator(".data-table__timezone-placeholder");
    await expect(placeholder).toHaveCount(1);
    const reservedGeometry = await box(placeholder);
    await expect(table.locator(".data-table__day-row")).toHaveCount(0);
    releaseSettings?.();
    await expect(table.locator(".data-table__day-row").first()).toBeVisible();
    const resolvedGeometry = await box(table);
    expect(resolvedGeometry.y).toBe(reservedGeometry.y);
    expect(resolvedGeometry.height).toBe(reservedGeometry.height);
  }
});

test.describe("browser time zone fallback", () => {
  test.use({ locale: "en-US", timezoneId: "America/New_York" });

  test("labels the browser time zone in exact event and audit tooltips after settings fail", async ({ page }) => {
    await mockApi(page, { settingsStatus: 500 });
    for (const path of ["events", "audit"] as const) {
      await page.goto(`/channels/${channelId}/${path}`);
      const time = page.locator("time").first();
      await expect.poll(() => time.getAttribute("title"), { timeout: 10_000 }).toMatch(/Using browser time zone/u);
      const timestamp = path === "events" ? events[0]?.createdAt : audit[0]?.createdAt;
      if (timestamp === undefined) throw new Error("The test entry timestamp should exist.");
      const browserExact = await page.evaluate((at) => new Intl.DateTimeFormat("en-US", {
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset",
      }).format(new Date(at)), timestamp);
      await expect(time).toHaveAttribute("title", `${browserExact} · Using browser time zone`);
    }
  });
});
