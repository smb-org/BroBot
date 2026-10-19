import { expect, test, type Page } from "@playwright/test";
import { dashboardTexts } from "../../src/dashboard/locale";
import { moduleName, statusWord } from "../../src/dashboard/module-labels";
import { DEFAULT_CHAT_VOTING_SETTINGS } from "../../src/modules/chat_voting/contracts";
import { chatVotingSettingsEditorCatalog } from "../../src/modules/chat_voting/panel/locale";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "issue-490-ui";
const timestamp = "2026-10-19T09:00:00.000Z";
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

const moduleState = (enabled: boolean, settings = DEFAULT_CHAT_VOTING_SETTINGS) => ({
  id: "chat_voting",
  enabled,
  settings: JSON.stringify(settings),
  mandatory: false,
});

const channelState = (location: { name: string; latitude: number; longitude: number; timeZone: string } | null, enabled: boolean, belaboxWarning: boolean) => ({
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
  modules: [moduleState(enabled), ...(belaboxWarning ? [{
    id: "belabox",
    enabled: true,
    settings: JSON.stringify({ lowBitrateKbps: 1_000, recoverBitrateKbps: 1_200 }),
    mandatory: false,
  }] : [])],
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
  events?: readonly Record<string, unknown>[];
  chatVoting?: boolean;
  overview?: boolean;
  belaboxWarning?: boolean;
} = {}) => {
  let location = options.location === undefined
    ? { name: "Berlin, Germany", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" }
    : options.location;
  let chatVotingEnabled = options.chatVoting ?? false;
  let settings: typeof DEFAULT_CHAT_VOTING_SETTINGS = { ...DEFAULT_CHAT_VOTING_SETTINGS };
  let settingsRevision = 1;
  let moduleToggleRequests = 0;

  const state = () => channelState(location, chatVotingEnabled, options.belaboxWarning ?? false);
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
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules: [moduleState(chatVotingEnabled, settings)] }));
    if (pathname === `/api/channels/${channelId}/revisions`) return route.fulfill(json({ revisions: { chat_voting: settingsRevision } }));
    if (pathname === `/api/channels/${channelId}/settings`) return route.fulfill(json({
      timeZone: "Europe/Berlin", revision: 1, location, locationRevision: 1,
      defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
    }));
    if (pathname === `/api/channels/${channelId}/overlays`) return route.fulfill(json({ overlays: [], maximum: 20, elementMaximum: 20 }));
    if (pathname === `/api/channels/${channelId}/events`) return route.fulfill(json({ entries: options.events ?? [], nextCursor: null }));
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
      return route.fulfill(json({ module: moduleState(chatVotingEnabled, settings), revision: 2 }));
    }
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/current`) {
      return route.fulfill(json({ vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
    }
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/templates`) {
      return route.fulfill(json({ templates: [], count: 0, maximum: 100 }));
    }
    if (pathname === `/api/channels/${channelId}/template-variables`) return route.fulfill(json({ variables: [] }));
    if (pathname === `/api/channels/${channelId}/audit-log`) return route.fulfill(json({ entries: [], nextCursor: null }));
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

test("coordinate-shaped location names fall back to a place label in the header", async ({ page }) => {
  await mockDashboard(page, { location: { name: "52.52, 13.40", latitude: 52.52, longitude: 13.4, timeZone: "Europe/Berlin" } });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/channels/${channelId}?lang=de`);
  const location = page.locator(".dashboard-header__location-name");
  await expect(location).toBeVisible();
  await expect(location).toContainText(deDashboard.header.locationMenu.locationFallback);
  await expect(location).not.toContainText("52.52, 13.40");
  await location.click();
  await expect(page.getByText("52.52, 13.40")).toBeVisible();
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

test("the cockpit keeps a compact warning slot without shifting the action wall", async ({ page }) => {
  const api = await mockDashboard(page);
  for (const [width, height, maximumSlotHeight] of [[1920, 1080, 56], [1280, 800, 56], [390, 844, 56]] as const) {
    api.setLocation({ name: "Berlin, Germany", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" });
    await page.setViewportSize({ width, height });
    await page.goto(`/channels/${channelId}?lang=de`);
    const slot = page.locator(".live-cockpit__warning-slot");
    const wall = page.locator(".live-cockpit__wall");
    await expect(slot).toHaveAttribute("data-warning-count", "0");
    await expect(wall).toBeVisible();
    const emptyState = await page.evaluate(() => {
      const cockpit = document.querySelector<HTMLElement>(".live-cockpit");
      if (cockpit === null) throw new Error("The cockpit is missing.");
      return {
        slotHeight: document.querySelector(".live-cockpit__warning-slot")?.getBoundingClientRect().height ?? -1,
        warningTrackHeight: Number.parseFloat(getComputedStyle(cockpit).gridTemplateRows.split(/\s+/)[1] ?? "-1"),
        wallTop: document.querySelector(".live-cockpit__wall")?.getBoundingClientRect().top ?? -1,
      };
    });
    expect(emptyState.slotHeight).toBeLessThanOrEqual(maximumSlotHeight);
    expect(emptyState.warningTrackHeight).toBe(emptyState.slotHeight);
    if (width <= 767) await expect(slot.locator(".live-cockpit__warning-summary")).toBeHidden();

    api.setLocation(null);
    await page.reload();
    await expect(slot).toHaveAttribute("data-warning-count", "1");
    if (width <= 767) {
      await expect(slot.getByRole("button")).toHaveText(deDashboard.liveCockpit.locationMissing);
    }
    const warningState = await page.evaluate(() => {
      const cockpit = document.querySelector<HTMLElement>(".live-cockpit");
      if (cockpit === null) throw new Error("The cockpit is missing.");
      return {
        slotHeight: document.querySelector(".live-cockpit__warning-slot")?.getBoundingClientRect().height ?? -1,
        warningTrackHeight: Number.parseFloat(getComputedStyle(cockpit).gridTemplateRows.split(/\s+/)[1] ?? "-1"),
        wallTop: document.querySelector(".live-cockpit__wall")?.getBoundingClientRect().top ?? -1,
      };
    });
    expect(warningState.slotHeight).toBe(emptyState.slotHeight);
    expect(warningState.warningTrackHeight).toBe(emptyState.warningTrackHeight);
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
      warningTrackHeight: Number.parseFloat(getComputedStyle(cockpit).gridTemplateRows.split(/\s+/)[1] ?? "-1"),
      slotHeight: slot.getBoundingClientRect().height,
    };
  });
  expect(geometry.warningTrackHeight).toBe(56);
  expect(geometry.slotHeight).toBe(56);
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

test("mobile protocol table headers align with the full-width rows", async ({ page }) => {
  await mockDashboard(page, { events: [{
    eventId: "event-490", createdAt: timestamp, moduleId: "host", triggerId: "trigger-490",
    code: "host.chat.failed", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null,
  }] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}/events?lang=de`);
  const table = page.locator(".event-table .data-table__table");
  const headerRow = table.locator("thead tr");
  const eventRow = table.locator("tbody tr:not(.data-table__day-row)").first();
  await expect(eventRow).toBeVisible();
  const geometry = await page.evaluate(() => {
    const table = document.querySelector<HTMLElement>(".event-table .data-table__table");
    const header = document.querySelector<HTMLElement>(".event-table .data-table__table thead tr");
    const row = document.querySelector<HTMLElement>(".event-table .data-table__table tbody tr:not(.data-table__day-row):not(.data-table__empty-row)");
    if (table === null || header === null || row === null) throw new Error("The event table is incomplete.");
    const rect = (element: HTMLElement) => {
      const { x, right, width } = element.getBoundingClientRect();
      return { x, right, width };
    };
    return { table: rect(table), header: rect(header), row: rect(row), pageWidth: document.documentElement.clientWidth };
  });
  expect(Math.abs(geometry.header.x - geometry.row.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.header.right - geometry.row.right)).toBeLessThanOrEqual(1);
  expect(geometry.header.right).toBeLessThanOrEqual(geometry.pageWidth + 1);
  expect(await headerRow.locator("th").allTextContents()).toContain(deDashboard.events.time);
});

test("the sidebar search footer does not cover the selected navigation row", async ({ page }) => {
  await mockDashboard(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/channels/${channelId}/audit?lang=de`);
  const selected = page.locator(".sidebar-nav-link[aria-current='page']");
  const footer = page.locator(".sidebar__footer");
  await expect(selected).toBeVisible();
  await expect(footer).toBeVisible();
  await selected.scrollIntoViewIfNeeded();
  const geometry = await page.evaluate(() => {
    const selected = document.querySelector<HTMLElement>(".sidebar-nav-link[aria-current='page']");
    const footer = document.querySelector<HTMLElement>(".sidebar__footer");
    if (selected === null || footer === null) throw new Error("The sidebar navigation is incomplete.");
    return {
      selectedBottom: selected.getBoundingClientRect().bottom,
      footerTop: footer.getBoundingClientRect().top,
    };
  });
  expect(geometry.selectedBottom).toBeLessThanOrEqual(geometry.footerTop - 4);
});
