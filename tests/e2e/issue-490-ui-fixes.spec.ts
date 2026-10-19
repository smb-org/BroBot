import { expect, test, type Page } from "@playwright/test";
import { dashboardTexts } from "../../src/dashboard/locale";
import { moduleName, statusWord } from "../../src/dashboard/module-labels";
import { DEFAULT_CHAT_VOTING_SETTINGS } from "../../src/modules/chat_voting/contracts";
import { chatVotingSettingsEditorCatalog } from "../../src/modules/chat_voting/panel/locale";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "issue-490-ui";
// Relative to now: a fixed instant ages into the maintenance-overdue window and the channel tile stops being healthy.
const timestamp = new Date().toISOString();
const deDashboard = dashboardTexts("de");
const deChatVoting = chatVotingSettingsEditorCatalog("de");
const chatVotingMessagesTabLabel = deChatVoting.sections.messages;
const chatVotingStartTextLabel = deChatVoting.fields.startText?.label;
if (chatVotingMessagesTabLabel === undefined || chatVotingStartTextLabel === undefined) {
  throw new Error("The German chat voting labels are incomplete.");
}
const chatVotingSwitchName = (enabled: boolean): string => `${moduleName("chat_voting", "de")}: ${statusWord(enabled, "de")}`;
const json = (value: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(value),
});

const moduleState = (id: string, enabled: boolean, settings: unknown = DEFAULT_CHAT_VOTING_SETTINGS) => ({
  id,
  enabled,
  settings: JSON.stringify(settings),
  mandatory: false,
});

const channelState = (location: { name: string; latitude: number; longitude: number; timeZone: string } | null, enabled: boolean, belaboxWarning: boolean, fullNavigation: boolean) => ({
  channelId,
  login: "layout-channel",
  displayName: "Layout Channel",
  language: "de" as const,
  role: "manager" as const,
  location,
  broadcasterConnection: "connected" as const,
  channelBotConsent: "granted" as const,
  bot: { status: "connected" as const, reason: null, updatedAt: timestamp },
  botPermissions: null,
  broadcasterPermissions: null,
  moderator: { isModerator: true, checkedAt: timestamp, reason: null },
  chatSubscription: { status: "enabled" as const, subscriptionId: "layout-sub", reason: null, updatedAt: timestamp },
  streamState: "offline" as const,
  streamStartedAt: null,
  controls: {
    mute: { active: false, until: null, mode: null },
    pause: { active: false, until: null, mode: null },
  },
  modules: [
    moduleState("chat_voting", enabled),
    ...(fullNavigation ? [moduleState("text_commands", true, {}), moduleState("faq", true, {}), moduleState("votekick", true, {})] : []),
    ...(belaboxWarning ? [moduleState("belabox", true, { lowBitrateKbps: 1_000, recoverBitrateKbps: 1_200 })] : []),
  ],
  tokens: {
    botExpiresAt: "2099-10-19T09:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-10-19T09:00:00.000Z",
  },
  lastError: null,
});

const mockDashboard = async (page: Page, options: {
  location?: { name: string; latitude: number; longitude: number; timeZone: string } | null;
  auditEntries?: readonly Record<string, unknown>[];
  chatVoting?: boolean;
  overview?: boolean;
  belaboxWarning?: boolean;
  fullNavigation?: boolean;
} = {}) => {
  let location = options.location === undefined
    ? { name: "Berlin, Germany", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" }
    : options.location;
  let chatVotingEnabled = options.chatVoting ?? false;
  let settings: typeof DEFAULT_CHAT_VOTING_SETTINGS = { ...DEFAULT_CHAT_VOTING_SETTINGS };
  let settingsRevision = 1;
  let moduleToggleRequests = 0;

  const state = () => channelState(location, chatVotingEnabled, options.belaboxWarning ?? false, options.fullNavigation ?? false);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();

    if (pathname === "/api/channels") {
      const channels = options.overview
        ? [state(), { ...state(), channelId: `${channelId}-peer`, login: "layout-peer", displayName: "Second Channel" }]
        : [state()];
      return route.fulfill(json({ channels, bot: state().bot }));
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      const channel = state();
      return route.fulfill(json({ ...channel, activeModules: chatVotingEnabled ? [{ moduleId: "chat_voting", settings: channel.modules[0]?.settings ?? "{}" }] : [] }));
    }
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules: [moduleState("chat_voting", chatVotingEnabled, settings)] }));
    if (pathname === `/api/channels/${channelId}/revisions`) return route.fulfill(json({ revisions: { chat_voting: settingsRevision } }));
    if (pathname === `/api/channels/${channelId}/settings`) return route.fulfill(json({
      timeZone: "Europe/Berlin", revision: 1, location, locationRevision: 1,
      defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
    }));
    if (pathname === `/api/channels/${channelId}/broadcast`) return route.fulfill(json({
      title: "", game: null, manageScopeAvailable: false,
    }));
    if (pathname === `/api/channels/${channelId}/overlays`) return route.fulfill(json({ overlays: [], maximum: 20, elementMaximum: 20 }));
    if (pathname === `/api/channels/${channelId}/events`) return route.fulfill(json({ entries: [], nextCursor: null }));
    if (pathname === `/api/channels/${channelId}/modules/belabox/status`) return route.fulfill(json({
      configured: true, updatedAt: timestamp, mode: "relay",
      sample: {
        at: new Date().toISOString(), connected: true, bitrateKbps: 500,
        rttMs: 0, latencyMs: 0, network: 0, droppedPackets: 0, phase: "low",
      },
      errorCode: null, polling: true, pollingDesired: true, streamId: null, belaboxStreamId: null,
      alertNotice: null, fetchFailureNotice: false, intervalSeconds: 5,
    }));
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "issue-490-csrf" }));
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/settings` && method === "GET") {
      return route.fulfill(json({ settings, revision: settingsRevision, variables: [] }));
    }
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/settings` && method === "PATCH") {
      const body = request.postDataJSON() as { settings?: Partial<typeof DEFAULT_CHAT_VOTING_SETTINGS> };
      settings = { ...settings, ...body.settings };
      settingsRevision += 1;
      return route.fulfill(json({ settings, revision: settingsRevision, warnings: [] }));
    }
    if (pathname === `/api/channels/${channelId}/modules/chat_voting` && method === "PATCH") {
      const body = request.postDataJSON() as { enabled?: boolean };
      if (typeof body.enabled === "boolean") chatVotingEnabled = body.enabled;
      moduleToggleRequests += 1;
      return route.fulfill(json({ module: moduleState("chat_voting", chatVotingEnabled, settings), revision: 2 }));
    }
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/current`) {
      return route.fulfill(json({ vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
    }
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/templates`) {
      return route.fulfill(json({ templates: [], count: 0, maximum: 100 }));
    }
    if (pathname === `/api/channels/${channelId}/template-variables`) return route.fulfill(json({ variables: [] }));
    if (pathname === `/api/channels/${channelId}/audit-log`) return route.fulfill(json({ entries: options.auditEntries ?? [], nextCursor: null }));
    return route.fulfill(json({}));
  });

  return {
    setLocation: (value: typeof location) => { location = value; },
    savedSettings: () => settings,
    toggleRequests: () => moduleToggleRequests,
  };
};

test("enabled module tiles use the success surface token", async ({ page }) => {
  await mockDashboard(page, { chatVoting: true, overview: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?lang=de");
  const icon = page.locator(".module-tile[data-enabled='true'] .module-tile__icon").first();
  await expect(icon).toBeVisible();
  const colors = await icon.evaluate((element) => {
    const tokenProbe = document.createElement("span");
    tokenProbe.style.backgroundColor = "var(--green-surface)";
    document.body.appendChild(tokenProbe);
    const expected = getComputedStyle(tokenProbe).backgroundColor;
    tokenProbe.remove();
    const style = getComputedStyle(element);
    return { actual: style.backgroundColor, expected };
  });
  expect(colors.actual).toBe(colors.expected);
});

test("coordinate-only locations keep an icon chip without moving the desktop header", async ({ page }) => {
  const api = await mockDashboard(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}?lang=de`);
  const initialLocation = page.locator(".dashboard-header__location");
  const initialName = initialLocation.locator(".dashboard-header__location-name");
  await expect(initialName).toHaveText("Berlin");
  expect(await initialName.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const initialGeometry = await page.evaluate(() => ({
    locationWidth: document.querySelector(".dashboard-header__location")?.getBoundingClientRect().width ?? -1,
    modeLeft: document.querySelector(".dashboard-header__mode")?.getBoundingClientRect().left ?? -1,
  }));

  api.setLocation({ name: "52.52, 13.40", latitude: 52.52, longitude: 13.4, timeZone: "Europe/Berlin" });
  await page.reload();
  const location = page.locator(".dashboard-header__location");
  await expect(location).toHaveClass(/dashboard-header__location--icon-only/u);
  await expect(location).toHaveAttribute("aria-label", `${deDashboard.header.locationMenu.locationFallback}, 52.52, 13.40`);
  await expect(location).toHaveAttribute("title", "52.52, 13.40");
  await expect(location).not.toContainText(deDashboard.header.locationMenu.locationFallback);
  await expect(location).not.toContainText("52.52, 13.40");
  const coordinateGeometry = await page.evaluate(() => ({
    locationWidth: document.querySelector(".dashboard-header__location")?.getBoundingClientRect().width ?? -1,
    modeLeft: document.querySelector(".dashboard-header__mode")?.getBoundingClientRect().left ?? -1,
  }));
  expect(coordinateGeometry.locationWidth).toBe(initialGeometry.locationWidth);
  expect(coordinateGeometry.modeLeft).toBe(initialGeometry.modeLeft);
  await location.click();
  await expect(page.locator(".dashboard-header__location-menu-label--title")).toHaveText(deDashboard.header.locationMenu.locationFallback);
  await expect(page.locator(".dashboard-header__location-menu-label--coordinates")).toHaveText("52.52, 13.40");
});

test("disabling chat voting confirms before leaving its unsaved settings draft", async ({ page }) => {
  const api = await mockDashboard(page, { chatVoting: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/channels/${channelId}/modules/chat_voting?lang=de`);
  await page.getByRole("tab").nth(1).click();
  await page.getByRole("tab", { name: chatVotingMessagesTabLabel }).click();
  const startText = page.getByRole("textbox", { name: chatVotingStartTextLabel });
  await expect(startText).toBeVisible();
  await startText.fill("Draft stays unchanged");

  const moduleSwitch = page.getByRole("switch", { name: chatVotingSwitchName(true) });
  await moduleSwitch.click();
  const confirmation = page.getByRole("dialog", { name: deDashboard.module.unsavedChangesTitle });
  await expect(confirmation).toBeVisible();
  expect(api.toggleRequests()).toBe(0);
  await page.getByRole("button", { name: deDashboard.module.continueEditing }).click();
  await expect(startText).toHaveValue("Draft stays unchanged");
  await expect(confirmation).toBeHidden();
});

test("chat voting keeps saved settings after it is disabled and re-enabled", async ({ page }) => {
  const api = await mockDashboard(page, { chatVoting: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/channels/${channelId}/modules/chat_voting?lang=de`);
  await page.getByRole("tab").nth(1).click();
  await page.getByRole("tab", { name: chatVotingMessagesTabLabel }).click();
  const startText = page.getByRole("textbox", { name: chatVotingStartTextLabel });
  await expect(startText).toBeVisible();
  await startText.fill("Save draft before activation");

  await page.getByRole("switch", { name: chatVotingSwitchName(true) }).click();
  const confirmation = page.getByRole("dialog", { name: deDashboard.module.unsavedChangesTitle });
  await expect(confirmation).toBeVisible();
  await page.getByRole("button", { name: deDashboard.module.saveAndSwitch }).click();
  await expect.poll(() => api.toggleRequests()).toBe(1);
  expect(api.savedSettings().startText).toBe("Save draft before activation");
  await page.getByRole("switch", { name: chatVotingSwitchName(false) }).click();
  await expect.poll(() => api.toggleRequests()).toBe(2);
  await expect(page.getByRole("switch", { name: chatVotingSwitchName(true) })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("tab").nth(1).click();
  await page.getByRole("tab", { name: chatVotingMessagesTabLabel }).click();
  await expect(page.getByRole("textbox", { name: chatVotingStartTextLabel })).toHaveValue("Save draft before activation");
});

test("cockpit warnings use the header row without leaving a band or shifting the tiles", async ({ page }) => {
  const api = await mockDashboard(page);
  for (const [width, height] of [[1920, 1080], [1280, 800], [390, 844]] as const) {
    api.setLocation({ name: "Berlin, Germany", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" });
    await page.setViewportSize({ width, height });
    await page.goto(`/channels/${channelId}?lang=de`);
    const slot = page.locator(".live-cockpit__warning-slot");
    const wall = page.locator(".live-cockpit__wall");
    await expect(slot).toHaveAttribute("data-warning-count", "0");
    await expect(wall).toBeVisible();
    const headerHeight = () => page.locator(".live-cockpit-header").evaluate((element) => element.getBoundingClientRect().height);
    // Indicators, title and category must have rendered and the header height must hold across two reads.
    const waitForSettledHeader = async (): Promise<void> => {
      await expect(page.getByText("Overlays · Nicht eingerichtet")).toBeVisible();
      await expect(page.locator(".live-cockpit-broadcast__title-row > strong")).not.toHaveText("");
      let previous = -1;
      await expect.poll(async () => {
        const current = await headerHeight();
        const stable = current === previous;
        previous = current;
        return stable;
      }).toBe(true);
    };
    const readLayout = () => page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".live-cockpit-header");
      const slot = document.querySelector<HTMLElement>(".live-cockpit__warning-slot");
      const wall = document.querySelector<HTMLElement>(".live-cockpit__wall");
      if (header === null || slot === null || wall === null) throw new Error("The cockpit layout is incomplete.");
      const slotStyle = getComputedStyle(slot);
      return {
        headerBottom: header.getBoundingClientRect().bottom,
        wallTop: wall.getBoundingClientRect().top,
        slotHeight: slot.getBoundingClientRect().height,
        slotDisplay: slotStyle.display,
        slotVisibility: slotStyle.visibility,
        slotBackground: slotStyle.backgroundColor,
        slotInHeader: slot.closest(".live-cockpit-header") === header,
      };
    });
    await waitForSettledHeader();
    const emptyState = await readLayout();
    expect(emptyState.slotInHeader).toBe(true);
    expect(emptyState.slotDisplay).toBe("flex");
    expect(emptyState.slotVisibility).toBe("hidden");
    expect(emptyState.slotBackground).toBe("rgba(0, 0, 0, 0)");
    expect(emptyState.slotHeight).toBe(width <= 767 ? 44 : 36);
    expect(Math.abs(emptyState.wallTop - emptyState.headerBottom - (width <= 767 ? 8 : 12))).toBeLessThanOrEqual(1);

    api.setLocation(null);
    await page.reload();
    await expect(slot).toHaveAttribute("data-warning-count", "1");
    await expect(slot.locator(".live-cockpit__warning-summary > .ui-button:first-child")).toContainText(deDashboard.liveCockpit.locationMissing);
    await expect(slot.getByRole("button", { name: deDashboard.liveCockpit.configureLocation })).toBeVisible();
    await waitForSettledHeader();
    const warningState = await readLayout();
    expect(warningState.slotInHeader).toBe(true);
    expect(warningState.slotVisibility).toBe("visible");
    expect(warningState.slotHeight).toBe(width <= 767 ? 44 : 36);
    expect(warningState.headerBottom).toBe(emptyState.headerBottom);
    expect(warningState.wallTop).toBe(emptyState.wallTop);
  }
});

test("mobile cockpit warnings stay compact and offer full details", async ({ page }) => {
  await mockDashboard(page, { location: null, belaboxWarning: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}?lang=de`);

  const slot = page.locator(".live-cockpit__warning-slot");
  await expect(slot).toHaveAttribute("data-warning-count", "2");
  const geometry = await page.evaluate(() => {
    const cockpit = document.querySelector<HTMLElement>(".live-cockpit");
    const slot = document.querySelector<HTMLElement>(".live-cockpit__warning-slot");
    if (cockpit === null || slot === null) throw new Error("The cockpit warning slot is missing.");
    return {
      slotHeight: slot.getBoundingClientRect().height,
      slotInHeader: slot.closest(".live-cockpit-header") === document.querySelector(".live-cockpit-header"),
    };
  });
  expect(geometry.slotHeight).toBe(44);
  expect(geometry.slotInHeader).toBe(true);
  const summary = slot.getByRole("button", { name: deDashboard.liveCockpit.warningSummary("2") });
  await expect(summary).toBeVisible();
  await summary.click();
  const details = page.getByRole("dialog", { name: deDashboard.liveCockpit.warningDetailsTitle });
  await expect(details).toBeVisible();
  await expect(details.getByText(deDashboard.liveCockpit.locationMissing)).toBeVisible();
  await expect(details.getByText(deDashboard.liveCockpit.locationMissingDescription)).toBeVisible();
  await expect(details.getByText(deDashboard.liveCockpit.belaboxWeak)).toBeVisible();
  await expect(details.getByText(deDashboard.liveCockpit.belaboxWeakDescription("500"))).toBeVisible();
  await expect(details.getByRole("button", { name: deDashboard.liveCockpit.configureLocation })).toBeVisible();
  await expect(details.getByRole("button", { name: deDashboard.liveCockpit.openBelabox })).toBeVisible();
});

test("mobile audit log headers span the same width as audit rows", async ({ page }) => {
  await mockDashboard(page, { auditEntries: [{
    auditId: "audit-490", actorUserId: "member-490", actorLogin: "mira_fox", actorDisplayName: "Mira Fox",
    actorKind: "member", createdAt: timestamp, moduleId: null, action: "member.role_changed",
    before: JSON.stringify({ role: "manager" }), after: JSON.stringify({ role: "operator" }),
    subjectUserId: "member-491", subjectLogin: "pixelpilz", subjectDisplayName: "Pixelpilz",
  }] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}/audit?lang=de`);
  await expect(page.getByRole("heading", { name: deDashboard.audit.title })).toBeVisible();
  const table = page.locator(".audit-sentence-list .data-table__table");
  const headerRow = table.locator("thead tr");
  const auditRow = table.locator("tbody tr:not(.data-table__day-row):not(.data-table__empty-row)").first();
  await expect(auditRow).toBeVisible();
  const geometry = await page.evaluate(() => {
    const table = document.querySelector<HTMLElement>(".audit-sentence-list .data-table__table");
    const header = document.querySelector<HTMLElement>(".audit-sentence-list .data-table__table thead tr");
    const row = document.querySelector<HTMLElement>(".audit-sentence-list .data-table__table tbody tr:not(.data-table__day-row):not(.data-table__empty-row)");
    if (table === null || header === null || row === null) throw new Error("The audit table is incomplete.");
    const rect = (element: HTMLElement) => {
      const { x, right, width } = element.getBoundingClientRect();
      return { x, right, width };
    };
    return { table: rect(table), header: rect(header), row: rect(row), pageWidth: document.documentElement.clientWidth };
  });
  expect(Math.abs(geometry.header.x - geometry.row.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.header.right - geometry.row.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.header.width - geometry.table.width)).toBeLessThanOrEqual(1);
  expect(geometry.header.right).toBeLessThanOrEqual(geometry.pageWidth + 1);
  expect(await headerRow.locator("th:visible").allTextContents()).toEqual([deDashboard.events.time, deDashboard.audit.area]);
});

for (const height of [800, 600]) {
test(`the test area navigation row stays clear of the fixed sidebar footer at 1280x${String(height)}`, async ({ page }) => {
  await mockDashboard(page, { fullNavigation: true });
  await page.setViewportSize({ width: 1280, height });
  await page.goto(`/channels/${channelId}/test-area?lang=de`);
  await expect(page.getByRole("heading", { name: deDashboard.navigation.testArea })).toBeVisible();
  for (const category of ["chat", "participation", "data", "stream", "admin"]) {
    await expect(page.locator(`.sidebar__group[data-category='${category}']`)).toHaveCount(1);
  }
  const selected = page.locator(".sidebar-nav-link[aria-current='page']");
  const footer = page.locator(".sidebar__footer");
  await expect(selected).toBeVisible();
  await expect(footer).toBeVisible();
  const geometry = await page.evaluate(() => {
    const selected = document.querySelector<HTMLElement>(".sidebar-nav-link[aria-current='page']");
    const scrollArea = document.querySelector<HTMLElement>(".sidebar__scroll");
    const footer = document.querySelector<HTMLElement>(".sidebar__footer");
    if (selected === null || scrollArea === null || footer === null) throw new Error("The sidebar navigation is incomplete.");
    return {
      selectedTop: selected.getBoundingClientRect().top,
      selectedBottom: selected.getBoundingClientRect().bottom,
      scrollTop: scrollArea.getBoundingClientRect().top,
      scrollBottom: scrollArea.getBoundingClientRect().bottom,
      scrollOffset: scrollArea.scrollTop,
      overflows: scrollArea.scrollHeight > scrollArea.clientHeight,
      footerTop: footer.getBoundingClientRect().top,
    };
  });
  if (height === 600) {
    // The list cannot fit here, so the active link must have been scrolled into view.
    expect(geometry.overflows).toBe(true);
    expect(geometry.scrollOffset).toBeGreaterThan(0);
  }
  expect(geometry.scrollBottom).toBeLessThanOrEqual(geometry.footerTop + 1);
  expect(geometry.selectedTop).toBeGreaterThanOrEqual(geometry.scrollTop + 4);
  expect(geometry.selectedBottom).toBeLessThanOrEqual(Math.min(geometry.scrollBottom, geometry.footerTop) - 4);
});
}
