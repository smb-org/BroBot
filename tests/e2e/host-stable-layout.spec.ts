import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "en-US" });

const channelId = "stable-host-layout";
let panelRevisions: Record<string, number> = {};
const channel = {
  channelId,
  login: "stable-channel",
  displayName: "Stable Channel",
  role: "manager",
  streamState: "online",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "stable-subscription", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: {
    botExpiresAt: "2099-09-20T08:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-09-20T08:00:00.000Z",
  },
  lastError: null,
};

const measureBox = async (page: Page, selector: string): Promise<[number, number, number, number]> => {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`Missing layout box for ${selector}.`);
  const round = (value: number): number => Math.round(value * 100) / 100;
  return [round(box.x), round(box.y), round(box.width), round(box.height)];
};

const measureDocumentBox = async (page: Page, selector: string): Promise<[number, number, number, number]> => {
  const box = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [rect.x + window.scrollX, rect.y + window.scrollY, rect.width, rect.height];
  });
  const round = (value: number): number => Math.round(value * 100) / 100;
  return [round(box[0] ?? 0), round(box[1] ?? 0), round(box[2] ?? 0), round(box[3] ?? 0)];
};

interface RequestGate {
  wait: Promise<void>;
  started: () => void;
}

type ChannelGates = Partial<Record<"settings" | "members" | "membersNext" | "audit" | "events" | "eventsNext" | "overlays" | "legacyTokens" | "variables" | "modules", RequestGate>>;

interface ChannelMockData {
  channelList?: readonly Record<string, unknown>[];
  settings?: Record<string, unknown>;
  members?: { members: readonly Record<string, unknown>[]; nextCursor: string | null };
  membersNext?: { members: readonly Record<string, unknown>[]; nextCursor: string | null };
  membersNextStatus?: number;
  audit?: { entries: readonly Record<string, unknown>[]; nextCursor: string | null };
  events?: { entries: readonly Record<string, unknown>[]; nextCursor: string | null };
  eventsNext?: { entries: readonly Record<string, unknown>[]; nextCursor: string | null };
  variables?: { variables: readonly Record<string, unknown>[]; count: number; maximum: number };
  overlays?: { overlays: readonly Record<string, unknown>[]; maximum: number; elementMaximum: number };
  legacyTokens?: { tokens: readonly Record<string, unknown>[]; nextOffset: number | null };
  modules?: readonly Record<string, unknown>[];
  moduleStatus?: number;
  moduleToggleStatus?: number;
  locationSearchStatus?: number;
  shoutoutStatus?: number;
}

const installChannelMocks = async (page: Page, gates: ChannelGates = {}, data: ChannelMockData = {}): Promise<void> => {
  panelRevisions = {};
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === `/api/channels/${channelId}/revisions`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revisions: panelRevisions }) });
      return;
    }
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: data.channelList ?? [channel], bot: channel.bot }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...channel, activeModules: [] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/settings`) {
      const gate = gates.settings;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data.settings ?? { timeZone: "UTC", revision: 1, location: null, locationRevision: 1 }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/members`) {
      const isNextPage = new URL(route.request().url()).searchParams.has("cursor");
      const gate = isNextPage ? gates.membersNext : gates.members;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      const status = isNextPage ? data.membersNextStatus ?? 200 : 200;
      const response = isNextPage ? data.membersNext ?? data.members ?? { members: [], nextCursor: null } : data.members ?? { members: [], nextCursor: null };
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { ...response, broadcasterCount: 1, viewerUserId: "viewer" } : { error: "member_page_failed" }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/variables`) {
      const gate = gates.variables;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data.variables ?? { variables: [], count: 0, maximum: 25 }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/settings/location/geocode`) {
      await route.fulfill({ status: data.locationSearchStatus ?? 200, contentType: "application/json", body: JSON.stringify(data.locationSearchStatus === undefined ? { results: [] } : { error: "location_search_failed" }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overlays`) {
      const gate = gates.overlays;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data.overlays ?? { overlays: [], maximum: 20, elementMaximum: 20 }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overlay-tokens`) {
      const gate = gates.legacyTokens;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data.legacyTokens ?? { tokens: [], nextOffset: null }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/audit-log`) {
      const gate = gates.audit;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data.audit ?? { entries: [], nextCursor: null }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules` && route.request().method() === "GET") {
      const gate = gates.modules;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: data.moduleStatus ?? 200, contentType: "application/json", body: JSON.stringify(data.moduleStatus === undefined ? { modules: data.modules ?? [] } : { error: "module_load_failed" }) });
      return;
    }
    if (pathname.startsWith(`/api/channels/${channelId}/modules/`) && route.request().method() === "PATCH") {
      await route.fulfill({ status: data.moduleToggleStatus ?? 200, contentType: "application/json", body: JSON.stringify(data.moduleToggleStatus === undefined ? { module: { id: pathname.split("/").at(-1), enabled: true, settings: "{}" } } : { error: "module_update_failed" }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/events`) {
      const isNextPage = new URL(route.request().url()).searchParams.has("cursor");
      const gate = isNextPage ? gates.eventsNext : gates.events;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      const response = isNextPage ? data.eventsNext : data.events;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response ?? { entries: [], nextCursor: null }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/shoutout` && route.request().method() === "POST") {
      await route.fulfill({ status: data.shoutoutStatus ?? 500, contentType: "application/json", body: JSON.stringify({ error: "shoutout_send_failed", reason: "rate_limited" }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/controls/mute`) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "control_update_failed" }) });
      return;
    }
    if (pathname === "/api/csrf") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "layout-test-token" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
};

const fullMemberPage = Array.from({ length: 100 }, (_, index) => ({
  userId: `member-${String(index + 1)}`,
  login: `member-${String(index + 1)}`,
  displayName: `Member ${String(index + 1)}`,
  profileImageUrl: null,
  role: "operator",
  joinedAt: "2026-09-20T08:00:00.000Z",
}));
const nextMemberPage = Array.from({ length: 50 }, (_, index) => ({
  userId: `member-${String(index + 101)}`,
  login: `member-${String(index + 101)}`,
  displayName: `Member ${String(index + 101)}`,
  profileImageUrl: null,
  role: "operator",
  joinedAt: "2026-09-20T08:00:00.000Z",
}));

const fullAuditPage = {
  entries: Array.from({ length: 50 }, (_, index) => ({
    auditId: `audit-${String(index + 1)}`,
    actorUserId: "operator",
    actorLogin: "operator",
    actorDisplayName: "Operator",
    actorKind: "member",
    createdAt: `2026-09-${String(20 - Math.floor(index / 24)).padStart(2, "0")}T${String(23 - (index % 24)).padStart(2, "0")}:00:00.000Z`,
    moduleId: null,
    action: "channel.member_role_changed",
    before: "{}",
    after: "{}",
  })),
  nextCursor: "audit-next",
};

const fullEventPage = {
  entries: Array.from({ length: 50 }, (_, index) => ({
    eventId: `event-${String(index + 1)}`,
    createdAt: `2026-09-20T${String(23 - Math.floor(index / 2)).padStart(2, "0")}:${String(59 - index % 60).padStart(2, "0")}:00.000Z`,
    moduleId: "channel_events",
    triggerId: `trigger-${String(index + 1)}`,
    code: "channel_events.message_removed",
    detail: "{}",
    actorUserId: "operator",
    actorLogin: "operator",
    actorDisplayName: "Operator",
  })),
  nextCursor: "events-next",
};

const fullOverlays = {
  overlays: Array.from({ length: 20 }, (_, index) => ({
    id: `overlay-${String(index + 1)}`,
    name: `Overlay ${String(index + 1)}`,
    elementCount: index,
    accessCount: 1,
    lastUsedAt: null,
  })),
  maximum: 20,
  elementMaximum: 20,
};

const fullLegacyTokens = {
  tokens: Array.from({ length: 50 }, (_, index) => ({
    id: `legacy-token-${String(index + 1)}`,
    name: "Legacy overlay",
    channelId,
    overlayId: `overlay-${String(index + 1)}`,
    createdAt: "2026-09-20T08:00:00.000Z",
    createdBy: "operator",
    lastUsedAt: null,
    expiresAt: null,
  })),
  nextOffset: 50,
};

const fullVariablePage = {
  variables: Array.from({ length: 25 }, (_, index) => ({
    channelId,
    name: `variable_${String(index + 1)}`,
    value: index,
    description: `Variable ${String(index + 1)}`,
    resetOnStreamStart: false,
    createdAt: "2026-09-20T08:00:00.000Z",
    updatedAt: "2026-09-20T08:00:00.000Z",
    usages: [],
  })),
  count: 25,
  maximum: 25,
};

const platformChannelId = "stable-platform-channel";
const platformChannel = {
  channelId: platformChannelId,
  login: "stable-platform-channel",
  displayName: "Stable Platform Channel",
  fullConsent: true,
  memberCounts: { broadcaster: 1, manager: 1, operator: 100 },
  broadcasterConnected: true,
};
const fullPlatformChannels = [platformChannel, ...Array.from({ length: 29 }, (_, index) => ({
  ...platformChannel,
  channelId: `stable-platform-channel-${String(index + 2)}`,
  login: `stable-platform-channel-${String(index + 2)}`,
  displayName: `Stable Platform Channel ${String(index + 2)}`,
}))];
const fullPlatformAuditPage = {
  entries: Array.from({ length: 50 }, (_, index) => ({
    auditId: `platform-audit-${String(index + 1)}`,
    actorUserId: "admin",
    actorLogin: "admin",
    actorDisplayName: "Admin",
    actorKind: "platform_admin",
    createdAt: "2026-09-20T08:00:00.000Z",
    channelId: platformChannelId,
    moduleId: null,
    action: "channel.released",
    before: "{}",
    after: "{}",
  })),
  nextCursor: "platform-audit-next",
};
const fullPlatformMembers = {
  members: fullMemberPage,
  nextCursor: "platform-members-next",
  broadcasterCount: 1,
  viewerUserId: "viewer",
};

const installPlatformMocks = async (page: Page, gates: Partial<Record<"audit" | "members" | "overview", RequestGate>>, channels: readonly Record<string, unknown>[] = [platformChannel]): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [], bot: null, platformAdmin: true, viewerIsBot: false }) });
      return;
    }
    if (pathname === "/api/platform") {
      const gate = gates.overview;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels }) });
      return;
    }
    if (pathname === "/api/platform/audit") {
      const gate = gates.audit;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fullPlatformAuditPage) });
      return;
    }
    if (pathname === `/api/platform/channels/${platformChannelId}/members`) {
      const gate = gates.members;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fullPlatformMembers) });
      return;
    }
    if (pathname === "/api/csrf") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "layout-test-token" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
};

test("the overview location region is present and keeps its box while settings load", async ({ page }) => {
  let releaseSettings!: () => void;
  let markSettingsStarted!: () => void;
  const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve; });
  const settingsStarted = new Promise<void>((resolve) => { markSettingsStarted = resolve; });
  await installChannelMocks(page, { settings: { wait: settingsGate, started: markSettingsStarted } });

  await page.goto(`/channels/${channelId}/overview`);
  await settingsStarted;
  await expect(page.getByRole("heading", { name: "Stable Channel" })).toBeVisible();
  const location = page.locator(".channel-location-field");
  const presentBeforeSettings = await location.count();
  const before = presentBeforeSettings === 0 ? null : await measureBox(page, ".channel-location-field");
  releaseSettings();
  await expect(page.locator(".channel-location-field")).toBeVisible();
  const after = await measureBox(page, ".channel-location-field");

  expect(presentBeforeSettings).toBe(1);
  expect(before).toEqual(after);
});

test("event controls stay above growing lists as channel responses arrive", async ({ page }) => {
  for (const [section, gateName, controlSelector] of [
    ["events", "events", ".events-page__pagination-slot"],
  ] as const) {
    let releaseResponse!: () => void;
    let markResponseStarted!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const responseStarted = new Promise<void>((resolve) => { markResponseStarted = resolve; });
    const responseData: ChannelMockData = { events: fullEventPage };
    await installChannelMocks(page, { [gateName]: { wait: responseGate, started: markResponseStarted } }, responseData);
    await page.goto(`/channels/${channelId}/${section}`);
    await responseStarted;
    const loadState = page.locator(".ui-load-state--panel");
    await expect(loadState).toHaveAttribute("data-status", "loading");
    const beforeControl = await measureBox(page, controlSelector);
    releaseResponse();
    await expect(loadState).not.toHaveAttribute("data-status", "loading");
    const afterControl = await measureBox(page, controlSelector);
    expect(afterControl).toEqual(beforeControl);
    const listBox = await measureBox(page, ".ui-load-state--panel");
    expect(beforeControl[1] + beforeControl[3]).toBeLessThanOrEqual(listBox[1]);
    await page.unrouteAll();
  }
});

test("channel audit pagination stays in a sticky 44px footer and the list top fixed at desktop and 390px", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await installChannelMocks(page, {}, { audit: fullAuditPage });

    await page.goto(`/channels/${channelId}/audit`);
    const loadState = page.locator(".ui-load-state--panel");
    await expect(loadState).toHaveAttribute("data-status", "success");
    await expect(page.locator(".audit-page__pagination-slot")).toHaveCount(0);
    const listTop = await measureDocumentBox(page, ".ui-load-state--panel");
    const footer = page.locator(".list-pagination-footer");
    const more = footer.getByRole("button", { name: "Load older entries" });
    await expect(more).toBeVisible();
    await expect(footer).toContainText("50 loaded");
    await footer.scrollIntoViewIfNeeded();
    const footerBox = await measureBox(page, ".list-pagination-footer");
    expect(footerBox[3]).toBe(44);
    expect(Math.abs(footerBox[1] + footerBox[3] - (width === 390 ? 844 : 900))).toBeLessThanOrEqual(1);
    await more.click();
    await expect(more).toBeEnabled();
    expect((await measureDocumentBox(page, ".ui-load-state--panel")).slice(0, 2)).toEqual(listTop.slice(0, 2));
    expect((await measureBox(page, ".list-pagination-footer"))[3]).toBe(44);
    await page.unrouteAll();
  }
});

test("platform audit keeps its footer in place as rows arrive", async ({ page }) => {
  let releaseAudit!: () => void;
  let markAuditStarted!: () => void;
  let releaseMembers!: () => void;
  let markMembersStarted!: () => void;
  const auditGate = new Promise<void>((resolve) => { releaseAudit = resolve; });
  const auditStarted = new Promise<void>((resolve) => { markAuditStarted = resolve; });
  const membersGate = new Promise<void>((resolve) => { releaseMembers = resolve; });
  const membersStarted = new Promise<void>((resolve) => { markMembersStarted = resolve; });
  await installPlatformMocks(page, {
    audit: { wait: auditGate, started: markAuditStarted },
    members: { wait: membersGate, started: markMembersStarted },
  });

  await page.goto("/platform");
  await auditStarted;
  await page.getByRole("tab", { name: "Audit" }).click();
  const platformAuditList = page.locator(".platform-tabs__panel .ui-load-state");
  const auditListBefore = await measureBox(page, ".platform-tabs__panel .ui-load-state");
  releaseAudit();
  await expect(page.locator(".platform-tabs__panel .list-pagination-footer button")).toBeVisible();
  await expect(platformAuditList).toHaveAttribute("data-status", "success");
  expect((await measureBox(page, ".platform-tabs__panel .ui-load-state")).slice(0, 2)).toEqual(auditListBefore.slice(0, 2));
  expect((await measureBox(page, ".platform-tabs__panel .list-pagination-footer"))[3]).toBe(44);

  await page.getByRole("tab", { name: "Channels" }).click();
  await page.locator(".platform-channel-table tbody tr").click();
  await membersStarted;
  const grantEditor = page.locator('.platform-inspector-section[aria-label="Add member"]');
  await expect(grantEditor).toBeVisible();
  const grantBefore = await measureBox(page, '.platform-inspector-section[aria-label="Add member"]');
  expect(grantBefore[1] + grantBefore[3]).toBeLessThanOrEqual((await measureBox(page, ".platform-members-table"))[1]);
  releaseMembers();
  await expect(page.locator(".platform-members-table tbody tr")).toHaveCount(100);
  expect(await measureBox(page, '.platform-inspector-section[aria-label="Add member"]')).toEqual(grantBefore);
  expect(grantBefore[1] + grantBefore[3]).toBeLessThanOrEqual((await measureBox(page, ".platform-members-table"))[1]);
});

test("platform tabs isolate populated channel and audit lists at desktop and mobile widths", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await installPlatformMocks(page, {}, fullPlatformChannels);

    await page.goto("/platform");
    const channelTab = page.getByRole("tab", { name: "Channels" });
    const auditTab = page.getByRole("tab", { name: "Audit" });
    await expect(channelTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".platform-channel-table tbody tr")).toHaveCount(30);
    await expect(page.getByRole("button", { name: "Release channel" })).toBeVisible();
    await expect(page.locator(".platform-tabs [role='tabpanel']:visible")).toHaveCount(1);
    const channelControls = await measureDocumentBox(page, ".platform-tabs__list");
    const channelList = await measureDocumentBox(page, ".platform-channel-table");
    expect(channelControls[1] + channelControls[3]).toBeLessThanOrEqual(channelList[1]);
    await expect(page.locator(".platform-tabs__panel .list-pagination-footer")).toHaveCount(0);

    await auditTab.click();
    const auditControl = page.locator(".platform-tabs__panel .list-pagination-footer");
    const auditList = page.locator(".platform-tabs__panel .ui-load-state");
    await expect(auditTab).toHaveAttribute("aria-selected", "true");
    await expect(auditControl.getByRole("button", { name: "Load more" })).toBeVisible();
    await expect(auditList).toHaveAttribute("data-status", "success");
    await expect(auditList.locator(".table tbody tr")).toHaveCount(50);
    await expect(page.locator(".platform-tabs [role='tabpanel']:visible")).toHaveCount(1);
    await expect(page.locator(".platform-channel-table")).toHaveCount(0);
    const auditControls = await measureBox(page, ".platform-tabs__panel .list-pagination-footer");
    expect(auditControls[3]).toBe(44);
    expect(Math.abs(auditControls[1] + auditControls[3] - (width === 390 ? 844 : 900))).toBeLessThanOrEqual(1);
    await page.unrouteAll();
  }
});

test("member pagination stays in a sticky 44px footer as more rows load at desktop and 390px", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    let releaseNextPage!: () => void;
    let markNextPageStarted!: () => void;
    const nextPageGate = new Promise<void>((resolve) => { releaseNextPage = resolve; });
    const nextPageStarted = new Promise<void>((resolve) => { markNextPageStarted = resolve; });
    await installChannelMocks(page, { membersNext: { wait: nextPageGate, started: markNextPageStarted } }, {
      members: { members: fullMemberPage, nextCursor: "members-next" },
      membersNext: { members: nextMemberPage, nextCursor: null },
    });

    await page.goto(`/channels/${channelId}/members`);
    await expect(page.locator(".members-table tbody tr")).toHaveCount(100);
    await expect(page.getByText("Member 1", { exact: true })).toBeVisible();
    const listTop = await measureDocumentBox(page, ".members-table");
    const footer = page.locator(".members-page__list-column .list-pagination-footer");
    await expect(footer.getByRole("button", { name: "Load more members" })).toBeVisible();
    expect((await measureBox(page, ".list-pagination-footer"))[3]).toBe(44);
    await footer.getByRole("button", { name: "Load more members" }).click();
    await nextPageStarted;
    expect((await measureDocumentBox(page, ".members-table")).slice(0, 2)).toEqual(listTop.slice(0, 2));
    releaseNextPage();
    await expect(page.locator(".members-table tbody tr")).toHaveCount(150);
    expect((await measureDocumentBox(page, ".members-table")).slice(0, 2)).toEqual(listTop.slice(0, 2));
    await expect(footer).toContainText("150 loaded");
    await expect(footer.getByRole("button", { name: "Load more members" })).toHaveCount(0);
    await footer.scrollIntoViewIfNeeded();
    const footerBox = await measureBox(page, ".list-pagination-footer");
    expect(footerBox[3]).toBe(44);
    expect(Math.abs(footerBox[1] + footerBox[3] - (width === 390 ? 844 : 900))).toBeLessThanOrEqual(1);
    await page.unrouteAll();
  }
});

test("member list errors use a toast and keep the table top fixed at desktop and 390px", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await installChannelMocks(page, {}, {
      members: { members: fullMemberPage, nextCursor: "members-next" },
      membersNextStatus: 500,
    });

    await page.goto(`/channels/${channelId}/members`);
    await expect(page.locator(".members-table tbody tr")).toHaveCount(100);
    await expect(page.getByText("Member 1", { exact: true })).toBeVisible();
    const listTop = await measureDocumentBox(page, ".members-table");
    await page.getByRole("button", { name: "Load more members" }).click();
    await expect(page.locator(".ui-toast").filter({ hasText: "The data could not be loaded." })).toBeVisible();
    expect((await measureDocumentBox(page, ".members-table")).slice(0, 2)).toEqual(listTop.slice(0, 2));
    await expect(page.locator(".content-section .form-error")).toHaveCount(0);
    await page.unrouteAll();
  }
});

test("setting an event filter leaves the list top fixed at desktop and 390px", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await installChannelMocks(page, {}, { events: fullEventPage });

    await page.goto(`/channels/${channelId}/events`);
    await expect(page.locator(".event-table tbody tr")).toHaveCount(50);
    const listTop = await measureDocumentBox(page, ".ui-load-state--panel");
    await page.getByRole("textbox", { name: "Person" }).fill("Operator");
    await expect(page.locator(".event-filter .list-toolbar__active-filters")).toContainText("Operator");
    await expect(page.locator(".event-table tbody tr")).toHaveCount(50);
    expect(await measureDocumentBox(page, ".ui-load-state--panel")).toEqual(listTop);
    await page.unrouteAll();
  }
});

test("a saved location with a time-zone suggestion keeps the action strip fixed at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseSettings!: () => void;
  let markSettingsStarted!: () => void;
  const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve; });
  const settingsStarted = new Promise<void>((resolve) => { markSettingsStarted = resolve; });
  await installChannelMocks(page, { settings: { wait: settingsGate, started: markSettingsStarted } }, {
    settings: {
      timeZone: "UTC",
      revision: 1,
      location: { name: "Honolulu", latitude: 21.3069, longitude: -157.8583, timeZone: "Pacific/Honolulu" },
      locationRevision: 1,
    },
  });

  await page.goto(`/channels/${channelId}/overview`);
  await settingsStarted;
  const before = await measureBox(page, ".channel-location-field__actions");
  releaseSettings();
  await expect(page.getByText("Set channel time zone to Pacific/Honolulu?")).toBeVisible();
  expect(await measureBox(page, ".channel-location-field__actions")).toEqual(before);
  await page.unrouteAll();
});

test("the channel-variable limit and create controls stay above a full list", async ({ page }) => {
  let releaseVariables!: () => void;
  let markVariablesStarted!: () => void;
  const variablesGate = new Promise<void>((resolve) => { releaseVariables = resolve; });
  const variablesStarted = new Promise<void>((resolve) => { markVariablesStarted = resolve; });
  await installChannelMocks(page, { variables: { wait: variablesGate, started: markVariablesStarted } }, { variables: fullVariablePage });

  await page.goto(`/channels/${channelId}/variables`);
  await variablesStarted;
  const toolbarBefore = await measureBox(page, ".list-toolbar");
  const createActionBefore = await measureBox(page, ".list-toolbar__create");
  const usageBefore = await measureBox(page, ".list-toolbar__status");
  releaseVariables();
  await expect(page.locator(".channel-variables-table tbody tr")).toHaveCount(25);
  expect(await measureBox(page, ".list-toolbar")).toEqual(toolbarBefore);
  expect(await measureBox(page, ".list-toolbar__create")).toEqual(createActionBefore);
  expect(await measureBox(page, ".list-toolbar__status")).toEqual(usageBefore);
  await expect(page.locator(".list-toolbar__status")).toContainText("25 of 25 variables used");
  await expect(page.getByRole("button", { name: "Create variable" })).toBeDisabled();
  const statusBox = await measureBox(page, ".list-toolbar__status");
  expect(statusBox[1] + statusBox[3]).toBeLessThanOrEqual((await measureBox(page, ".ui-load-state--panel"))[1]);
});

test("a failed realtime variable refresh keeps rows visible and offers retry", async ({ page }) => {
  await page.addInitScript(() => {
    type LayoutSocket = EventTarget & { url: string; open: () => void; close: () => void; readyState: number };
    const sockets: LayoutSocket[] = [];
    class MockWebSocket extends EventTarget {
      readonly url: string;
      readyState = 0;
      constructor(url: string, protocols?: string | string[]) {
        super();
        this.url = url;
        void protocols;
        sockets.push(this);
      }
      open(): void { this.readyState = 1; this.dispatchEvent(new Event("open")); }
      close(): void { this.readyState = 3; this.dispatchEvent(new CloseEvent("close", { code: 1000 })); }
      send(data: string): void { void data; }
    }
    Object.defineProperty(window, "__layoutSockets", { value: sockets, configurable: true });
    Object.defineProperty(window, "WebSocket", { value: MockWebSocket, writable: true, configurable: true });
  });
  let variableRequestCount = 0;
  let failVariableRefresh = false;
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...channel, activeModules: [] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/variables`) {
      variableRequestCount++;
      if (failVariableRefresh) {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "variables_load_failed" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        variables: [{ channelId, name: "score", value: 42, description: "Current score", resetOnStreamStart: false,
          createdAt: "2026-09-20T08:00:00.000Z", updatedAt: "2026-09-20T08:00:00.000Z", usages: [] }],
        count: 1,
        maximum: 25,
      }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overlay-tokens`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tokens: [], nextOffset: null }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules: [] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto(`/channels/${channelId}/variables`);
  await expect(page.getByRole("rowheader", { name: "{var.score}" })).toBeVisible();
  const retrySlot = page.locator(".list-toolbar__status");
  const slotBeforeRefreshFailure = await retrySlot.boundingBox();
  const initialVariableRequestCount = variableRequestCount;
  await page.evaluate(() => {
    const sockets = (window as Window & { __layoutSockets?: Array<{ url: string; open: () => void; close: () => void }> }).__layoutSockets ?? [];
    const panelSockets = sockets.filter((socket) => new URL(socket.url, window.location.href).pathname.startsWith("/ws/channels/"));
    panelSockets[0]?.open();
    panelSockets[0]?.close();
  });
  await expect.poll(() => page.evaluate(() => {
    const sockets = (window as Window & { __layoutSockets?: Array<{ url: string }> }).__layoutSockets ?? [];
    return sockets.filter((socket) => new URL(socket.url, window.location.href).pathname.startsWith("/ws/channels/")).length;
  })).toBeGreaterThan(1);
  failVariableRefresh = true;
  await page.evaluate(() => {
    const sockets = (window as Window & { __layoutSockets?: Array<{ url: string; open: () => void }> }).__layoutSockets ?? [];
    const panelSockets = sockets.filter((socket) => new URL(socket.url, window.location.href).pathname.startsWith("/ws/channels/"));
    panelSockets.at(-1)?.open();
  });
  await expect.poll(() => variableRequestCount).toBeGreaterThan(initialVariableRequestCount);
  await expect(page.locator(".ui-toast--error")).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "{var.score}" })).toBeVisible();
  await expect(page.locator(".ui-load-state--panel")).toHaveAttribute("data-status", "success");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(await retrySlot.boundingBox()).toEqual(slotBeforeRefreshFailure);

  const failedVariableRequestCount = variableRequestCount;
  failVariableRefresh = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => variableRequestCount).toBeGreaterThan(failedVariableRequestCount);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByRole("rowheader", { name: "{var.score}" })).toBeVisible();
});

test("the new-events notice stays visible while reading older events", async ({ page }) => {
  await page.addInitScript(() => {
    type EventSocket = EventTarget & { open: () => void; close: () => void; receive: (data: string) => void; readyState: number };
    const sockets: EventSocket[] = [];
    class MockWebSocket extends EventTarget {
      readyState = 0;
      constructor(url: string, protocols?: string | string[]) { super(); void url; void protocols; sockets.push(this); }
      open(): void { this.readyState = 1; this.dispatchEvent(new Event("open")); }
      close(): void { this.readyState = 3; this.dispatchEvent(new CloseEvent("close", { code: 1000 })); }
      receive(data: string): void { this.dispatchEvent(new MessageEvent("message", { data })); }
    }
    Object.defineProperty(window, "__layoutEventSockets", { value: sockets, configurable: true });
    Object.defineProperty(window, "WebSocket", { value: MockWebSocket, writable: true, configurable: true });
  });
  const now = new Date().toISOString();
  const newEvent = {
    eventId: "new-event",
    createdAt: now,
    moduleId: "channel_events",
    triggerId: "new-event-trigger",
    code: "channel_events.message_removed",
    detail: "{}",
    actorUserId: "operator",
    actorLogin: "operator",
    actorDisplayName: "Operator",
  };
  const events = { entries: [...fullEventPage.entries], nextCursor: fullEventPage.nextCursor };
  await installChannelMocks(page, {}, { events });
  await page.goto(`/channels/${channelId}/events`);
  await expect(page.locator(".event-table tbody tr")).toHaveCount(50);
  await expect.poll(() => page.evaluate(() => (window as Window & { __layoutEventSockets?: Array<{ open: () => void }> }).__layoutEventSockets?.length ?? 0)).toBeGreaterThan(0);
  const displayedRows = await page.locator(".event-table tbody tr").allTextContents();
  await page.evaluate(async () => {
    window.scrollTo(0, 1200);
    await new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); }); });
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  events.entries.unshift(newEvent);
  panelRevisions["channel.events"] = 1;
  const refreshResponse = page.waitForResponse((response) => response.url().includes(`/api/channels/${channelId}/events`));
  await page.evaluate((timestamp) => {
    const sockets = (window as Window & { __layoutEventSockets?: Array<{ open: () => void; receive: (data: string) => void }> }).__layoutEventSockets ?? [];
    sockets.forEach((socket) => { socket.open(); });
    const envelope = JSON.stringify({ version: 1, id: "layout-new-event", createdAt: timestamp, channelId: "stable-host-layout", type: "event_log.new", payload: { entries: [{ eventId: "new-event", createdAt: timestamp, moduleId: "channel_events", code: "channel_events.message_removed", actorUserId: null }] } });
    sockets.forEach((socket) => { socket.receive(envelope); });
  }, now);
  await refreshResponse;
  const notice = page.locator(".realtime-feed__notice");
  await expect(notice).toBeVisible();
  await expect(notice).toBeInViewport();
  expect(await page.locator(".event-table tbody tr").allTextContents()).toEqual(displayedRows);
  const noticeBox = await notice.boundingBox();
  expect(noticeBox?.y).toBeGreaterThanOrEqual(0);
  expect(noticeBox?.y).toBeLessThan(120);
});

test("event rows keep their cell geometry after loading older events at desktop and mobile widths", async ({ page }) => {
  const widths = [1280, 390, 320];
  const longActor = "A Very Long Actor Display Name That Used To Expand Its Table Column";
  const firstPage = {
    entries: fullEventPage.entries.map((entry, index) => ({
      ...entry,
      createdAt: `2026-09-20T23:${String(59 - index).padStart(2, "0")}:00.000Z`,
    })),
    nextCursor: "events-next",
  };
  const olderPage = {
    entries: [{
      eventId: "event-older-page",
      triggerId: "event-older-page-trigger",
      createdAt: "2026-09-20T22:59:00.000Z",
      moduleId: "channel_events",
      code: "channel_events.message_removed",
      detail: "{}",
      actorUserId: "long-actor",
      actorLogin: "long-actor",
      actorDisplayName: longActor,
    }],
    nextCursor: null,
  };

  for (const width of widths) {
    await page.unrouteAll();
    await page.setViewportSize({ width, height: 900 });
    await installChannelMocks(page, {}, { events: firstPage, eventsNext: olderPage });
    await page.goto(`/channels/${channelId}/events`);
    await expect(page.locator(".event-table tbody tr")).toHaveCount(50);
    const existingRow = page.locator(".event-table tbody tr").first();
    const measureRow = async (): Promise<number[][]> => existingRow.evaluate((row) => [row, ...Array.from(row.children)].map((element) => {
      const rect = element.getBoundingClientRect();
      const round = (value: number): number => Math.round(value * 100) / 100;
      if (rect.width === 0 && rect.height === 0) return [0, 0, 0, 0];
      return [round(rect.x + window.scrollX), round(rect.y + window.scrollY), round(rect.width), round(rect.height)];
    }));
    const before = await measureRow();

    await page.getByRole("button", { name: "Load older events" }).click();
    await expect(page.locator(".event-table tbody tr")).toHaveCount(51);
    const after = await measureRow();
    expect(after).toEqual(before);
    const olderActorCell = page.locator(".event-table tbody tr").last().locator("td").nth(2);
    await expect(olderActorCell).toHaveAttribute("title", longActor);
    await expect(olderActorCell).toHaveCSS("text-overflow", "ellipsis");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("loading an older day does not move frozen rows across day sections", async ({ page }) => {
  const timestamps = await page.evaluate(() => {
    const local = (day: number, hour: number, minute: number): string => new Date(2026, 8, day, hour, minute).toISOString();
    return {
      previousDayError: local(21, 23, 55),
      todayInfo: local(22, 0, 5),
      todayOther: local(22, 0, 3),
      filler: local(22, 0, 1),
      older: local(21, 22, 0),
    };
  });
  const crossMidnightInfo = {
    eventId: "cross-midnight-info",
    triggerId: "cross-midnight-trigger",
    createdAt: timestamps.todayInfo,
    moduleId: "channel_events",
    code: "channel_events.chat.sub",
    detail: JSON.stringify({ person: "midnight-sub", tier: "1000" }),
    actorUserId: null,
  };
  const crossMidnightError = {
    ...crossMidnightInfo,
    eventId: "cross-midnight-error",
    createdAt: timestamps.previousDayError,
    moduleId: "host",
    code: "host.chat.failed",
    detail: "{}",
  };
  const todayEntry = {
    ...crossMidnightInfo,
    eventId: "today-entry",
    triggerId: "today-trigger",
    createdAt: timestamps.todayOther,
    detail: JSON.stringify({ person: "today-sub", tier: "1000" }),
  };
  const fillers = Array.from({ length: 48 }, (_, index) => ({
    ...crossMidnightInfo,
    eventId: `today-filler-${String(index).padStart(2, "0")}`,
    triggerId: `today-filler-trigger-${String(index).padStart(2, "0")}`,
    createdAt: timestamps.filler,
    detail: JSON.stringify({ person: `filler-${String(index).padStart(2, "0")}`, tier: "1000" }),
  }));
  const firstPage = { entries: [crossMidnightInfo, crossMidnightError, todayEntry, ...fillers], nextCursor: "older-midnight" };
  const olderPage = {
    entries: [{
      eventId: "older-day-entry",
      triggerId: "older-day-trigger",
      createdAt: timestamps.older,
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: JSON.stringify({ source: "olderday", viewers: 1 }),
      actorUserId: null,
    }],
    nextCursor: null,
  };
  let releaseOlderResponse!: () => void;
  let markOlderStarted!: () => void;
  const olderResponseGate: RequestGate = {
    wait: new Promise<void>((resolve) => { releaseOlderResponse = resolve; }),
    started: () => { markOlderStarted(); },
  };
  const olderRequestStarted = new Promise<void>((resolve) => { markOlderStarted = resolve; });
  await installChannelMocks(page, { eventsNext: olderResponseGate }, { events: firstPage, eventsNext: olderPage });
  await page.goto(`/channels/${channelId}/events`);
  await expect(page.locator(".event-table tbody tr")).toHaveCount(50);
  const todayRow = page.getByRole("row", { name: /today-sub/u });
  await expect(todayRow).toBeVisible();
  const feedStart = await page.locator(".event-feed").evaluate((feed) => feed.getBoundingClientRect().top + window.scrollY);
  await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); });
  await olderRequestStarted;
  await page.evaluate((start) => { window.scrollTo(0, start + 20); }, feedStart);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(feedStart + 8);
  await expect(todayRow).toBeInViewport();
  const before = await measureBox(page, ".event-table tbody tr:has-text('today-sub')");

  releaseOlderResponse();
  await expect(page.locator(".event-table tbody tr")).toHaveCount(51);
  expect(await measureBox(page, ".event-table tbody tr:has-text('today-sub')")).toEqual(before);
  expect(await page.locator(".event-table tbody tr").allTextContents()).toContainEqual(expect.stringContaining("olderday"));
});

test("a keyboard-focused immediate-action control scrolls fully into view at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installChannelMocks(page, {}, { modules: ["ads", "clips", "raid"].map((id) => ({ id, enabled: true, settings: "{}" })) });
  await page.goto(`/channels/${channelId}/overview`);
  const strip = page.locator(".stream-manager-actions");
  await expect(strip.locator(":scope > .stream-manager-action")).toHaveCount(3);
  const button = page.getByRole("button", { name: "Create clip" });
  await expect(button).toBeVisible();
  for (let i = 0; i < 80 && !(await button.evaluate((element) => element === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  await expect.poll(async () => {
    const [b, s] = await Promise.all([button.boundingBox(), strip.boundingBox()]);
    return b !== null && s !== null && b.x >= s.x - 0.5 && b.x + b.width <= s.x + s.width + 0.5;
  }).toBe(true);
});

test("immediate-action cards keep their reserved strip height after a shoutout failure", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await installChannelMocks(page, {}, {
      modules: ["ads", "clips", "raid"].map((id) => ({ id, enabled: true, settings: "{}" })),
      shoutoutStatus: 429,
    });
    await page.goto(`/channels/${channelId}/overview`);
    const strip = page.locator(".stream-manager-actions");
    await expect(strip.locator(":scope > .stream-manager-action")).toHaveCount(3);
    await expect(page.getByRole("textbox", { name: "Twitch login" })).toBeVisible();
    const before = await measureDocumentBox(page, ".stream-manager-actions");
    const cardsBefore = await Promise.all(Array.from({ length: 3 }, (_, index) => measureBox(page, `.stream-manager-action:nth-child(${String(index + 1)})`)));
    expect(cardsBefore.map((box) => box[3])).toEqual([192, 192, 192]);
    expect(cardsBefore.map((box) => box[2])).toEqual([300, 300, 300]);
    await expect(strip).toHaveAttribute("tabindex", "0");
    expect(await strip.evaluate((element) => getComputedStyle(element).scrollSnapType)).toMatch(/^x( proximity)?$/);
    if (width === 390) {
      expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      await strip.focus();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    }

    await page.getByRole("textbox", { name: "Twitch login" }).fill("someone");
    await page.getByRole("button", { name: "Send shoutout" }).click();
    await expect(page.locator(".ui-toast--error")).toBeVisible();
    expect(await measureDocumentBox(page, ".stream-manager-actions")).toEqual(before);
    await page.unrouteAll();
  }
});

test("stream manager waits for module data and keeps its immediate-action strip stable at desktop and mobile widths", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    let releaseModules!: () => void;
    let markModulesStarted!: () => void;
    const modulesGate = new Promise<void>((resolve) => { releaseModules = resolve; });
    const modulesStarted = new Promise<void>((resolve) => { markModulesStarted = resolve; });
    await installChannelMocks(page, { modules: { wait: modulesGate, started: markModulesStarted } }, {
      modules: [{ id: "raid", enabled: true, settings: "{}" }],
    });

    await page.goto(`/channels/${channelId}/overview`);
    await modulesStarted;
    const pageLoad = page.locator(".main-content > .ui-load-state");
    await expect(pageLoad).toHaveAttribute("data-status", "loading");
    await expect(page.getByRole("heading", { name: "Stable Channel", level: 1 })).toHaveCount(0);
    await expect(page.locator(".stream-manager-actions")).toHaveCount(0);

    releaseModules();
    await expect(page.getByRole("heading", { name: "Stable Channel", level: 1 })).toBeVisible();
    const strip = page.locator(".stream-manager-actions");
    await expect(page.getByRole("textbox", { name: "Twitch login" })).toBeVisible();
    await expect(strip.locator(":scope > .stream-manager-action--loading")).toHaveCount(0);
    await expect(strip.locator(":scope > .stream-manager-action")).toHaveCount(1);
    const before = await measureDocumentBox(page, ".stream-manager-actions");
    expect(before[3]).toBe(192);
    await page.waitForTimeout(100);
    expect(await measureDocumentBox(page, ".stream-manager-actions")).toEqual(before);
    const card = await measureBox(page, ".stream-manager-action");
    expect(card[2]).toBe(300);
    expect(card[3]).toBe(192);
    await page.unrouteAll();
  }
});

test("window visibility changes do not broadly refresh populated overview cards", async ({ page }) => {
  const secondChannel = {
    ...channel,
    channelId: "stable-host-layout-second",
    login: "stable-channel-second",
    displayName: "Stable Channel Second",
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await installChannelMocks(page, {}, { channelList: [channel, secondChannel] });
    let channelListRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/channels") channelListRequests += 1;
    });
    await page.goto("/");
    const grid = page.locator(".module-grid");
    await expect(grid.locator(":scope > .module-tile")).toHaveCount(2);
    const before = await measureDocumentBox(page, ".module-grid");
    const initialChannelListRequests = channelListRequests;
    await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForTimeout(300);
    await expect(page.locator(".ui-load-state")).toHaveAttribute("data-status", "success");
    await expect(grid.locator(":scope > .module-tile")).toHaveCount(2);
    expect(await measureDocumentBox(page, ".module-grid")).toEqual(before);
    expect(channelListRequests).toBe(initialChannelListRequests);
    await page.unrouteAll();
  }
});

test("module toggle and workspace failures use toasts without inserting error rows", async ({ page }) => {
  await installChannelMocks(page, {}, { modules: [{ id: "ads", enabled: false, settings: "{}" }], moduleToggleStatus: 500 });
  await page.goto(`/channels/${channelId}/modules`);
  const switches = page.locator(".module-workspace input[role='switch']");
  await expect(switches.first()).toBeVisible();
  const before = await measureBox(page, ".module-workspace .state-list");
  await switches.first().check();
  await expect(page.locator(".ui-toast--error")).toBeVisible();
  expect(await measureBox(page, ".module-workspace .state-list")).toEqual(before);
  await expect(page.locator(".module-workspace .form-error")).toHaveCount(0);
  await page.unrouteAll();

  await installChannelMocks(page, {}, { moduleStatus: 500 });
  await page.goto(`/channels/${channelId}/modules`);
  await expect(page.locator(".ui-toast--error")).toBeVisible();
  await expect(page.locator(".module-workspace .form-error")).toHaveCount(0);
});

test("the overlay style lock strip keeps its height as locked content is cleared", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(() => {
      class MockWebSocket extends EventTarget {
        readyState = 0;
        constructor(url: string, protocols?: string | string[]) { super(); void url; void protocols; }
        close(): void { this.readyState = 3; this.dispatchEvent(new CloseEvent("close", { code: 1000 })); }
        send(data: string): void { void data; }
      }
      Object.defineProperty(window, "WebSocket", { value: MockWebSocket, writable: true, configurable: true });
    });
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/channels") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot }) });
        return;
      }
      if (pathname === `/api/channels/${channelId}/overlays/layout-lock`) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ overlay: {
          id: "layout-lock", channelId, name: "Layout lock", width: 1920, height: 1080,
          css: "/* brobot:style:begin - managed by the style editor, changes here are overwritten */\ninvalid property\n/* brobot:style:end */",
          revision: 1, createdAt: "2026-09-20T08:00:00.000Z", updatedAt: "2026-09-20T08:00:00.000Z", elements: [],
        } }) });
        return;
      }
      if (pathname === `/api/channels/${channelId}/variables`) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ variables: [], count: 0, maximum: 25 }) });
        return;
      }
      if (pathname === `/api/channels/${channelId}/modules`) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules: [] }) });
        return;
      }
      if (pathname === `/api/channels/${channelId}/overview`) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...channel, activeModules: [] }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto(`/channels/${channelId}/overlays/layout-lock`);
    await expect(page.getByRole("heading", { name: "Layout lock" })).toBeVisible();
    await page.getByRole("tab", { name: "Style editor" }).click();
    const strip = page.locator(".overlay-editor__style-lock");
    await expect(strip).toHaveAttribute("data-locked", "true");
    const lockedStrip = await measureDocumentBox(page, ".overlay-editor__style-lock");
    const lockedFontSection = await measureDocumentBox(page, '.overlay-editor__style-section[data-style-section="font"]');
    await strip.getByRole("button").click();
    await expect(strip).toHaveAttribute("data-locked", "false");
    expect(await measureDocumentBox(page, ".overlay-editor__style-lock")).toEqual(lockedStrip);
    expect(await measureDocumentBox(page, '.overlay-editor__style-section[data-style-section="font"]')).toEqual(lockedFontSection);
    await page.unrouteAll();
  }
});

test("the collapsed legacy overlay list stays below primary content while loading and expanding at desktop and mobile widths", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    let releaseOverlays!: () => void;
    let markOverlaysStarted!: () => void;
    let releaseLegacyTokens!: () => void;
    let markLegacyTokensStarted!: () => void;
    const overlaysGate = new Promise<void>((resolve) => { releaseOverlays = resolve; });
    const overlaysStarted = new Promise<void>((resolve) => { markOverlaysStarted = resolve; });
    const legacyTokensGate = new Promise<void>((resolve) => { releaseLegacyTokens = resolve; });
    const legacyTokensStarted = new Promise<void>((resolve) => { markLegacyTokensStarted = resolve; });
    await installChannelMocks(page, {
      overlays: { wait: overlaysGate, started: markOverlaysStarted },
      legacyTokens: { wait: legacyTokensGate, started: markLegacyTokensStarted },
    }, { overlays: fullOverlays, legacyTokens: fullLegacyTokens });

    await page.goto(`/channels/${channelId}/overlays`);
    await Promise.all([overlaysStarted, legacyTokensStarted]);
    const overlayList = page.locator(".overlays-page > .ui-load-state");
    const details = page.locator(".overlay-legacy-links");
    await expect.poll(() => details.evaluate((element) => element.hasAttribute("open"))).toBe(false);
    releaseOverlays();
    await expect(overlayList).toHaveAttribute("data-status", "success");
    await expect(page.locator(".overlays-table tbody tr")).toHaveCount(20);
    const primaryListBefore = await measureDocumentBox(page, ".overlays-table");
    const createActionBefore = await measureDocumentBox(page, ".list-toolbar__create");

    releaseLegacyTokens();
    await expect(details.locator("summary")).toContainText("Legacy links (50)");
    await expect(details.locator(".ui-load-state")).toHaveAttribute("data-status", "success");
    expect(await measureDocumentBox(page, ".overlays-table")).toEqual(primaryListBefore);
    expect(await measureDocumentBox(page, ".list-toolbar__create")).toEqual(createActionBefore);
    expect(primaryListBefore[1] + primaryListBefore[3]).toBeLessThanOrEqual((await measureDocumentBox(page, ".overlay-legacy-links"))[1]);

    await details.locator("summary").click();
    await expect(details.locator(".overlay-access-list__item--legacy").first()).toBeVisible();
    await expect(details.locator(".overlay-access-list__item--legacy")).toHaveCount(50);
    expect(await measureDocumentBox(page, ".overlays-table")).toEqual(primaryListBefore);
    expect(await measureDocumentBox(page, ".list-toolbar__create")).toEqual(createActionBefore);
    await page.unrouteAll();
  }
});

test("a location-search error toast can be dismissed above its dialog backdrop", async ({ page }) => {
  await installChannelMocks(page, {}, { locationSearchStatus: 503 });
  await page.goto(`/channels/${channelId}/overview`);
  await page.getByRole("button", { name: "Change location" }).click();
  const dialog = page.getByRole("dialog", { name: "Change location" });
  await expect(dialog).toBeVisible();
  await page.getByRole("textbox", { name: "Search for a place" }).fill("Reykjavik");
  await page.getByRole("button", { name: "Search", exact: true }).click();

  const toast = page.locator(".ui-toast--error");
  await expect(toast).toBeVisible();
  const toastHost = page.locator(".ui-toast-host");
  const [toastZIndex, modalBaseZIndex] = await Promise.all([
    toastHost.evaluate((element) => Number.parseInt(getComputedStyle(element).zIndex, 10)),
    toastHost.evaluate((element) => Number.parseInt(getComputedStyle(element).getPropertyValue("--mantine-z-index-modal"), 10)),
  ]);
  expect(toastZIndex).toBeGreaterThan(modalBaseZIndex);
  await toast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toast).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

test("a channel control error appears as a toast without changing header boxes", async ({ page }) => {
  await installChannelMocks(page);
  await page.goto(`/channels/${channelId}/overview`);
  const controls = page.locator(".dashboard-header__controls");
  await expect(controls).toBeVisible();
  const before = await measureBox(page, ".dashboard-header__controls");
  await controls.getByRole("button", { name: "Mute channel" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Enable" }).click();
  await expect(page.locator(".ui-toast--error")).toBeVisible();
  const after = await measureBox(page, ".dashboard-header__controls");
  expect(after).toEqual(before);
});
