import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "en-US" });

const channelId = "stable-host-layout";
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

type ChannelGates = Partial<Record<"settings" | "members" | "audit" | "events" | "overlays" | "legacyTokens" | "variables" | "modules", RequestGate>>;

interface ChannelMockData {
  channelList?: readonly Record<string, unknown>[];
  settings?: Record<string, unknown>;
  members?: { members: readonly Record<string, unknown>[]; nextCursor: string | null };
  audit?: { entries: readonly Record<string, unknown>[]; nextCursor: string | null };
  events?: { entries: readonly Record<string, unknown>[]; nextCursor: string | null };
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
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
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
      const gate = gates.members;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...(data.members ?? { members: [], nextCursor: null }), broadcasterCount: 1, viewerUserId: "viewer" }) });
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
      const gate = gates.events;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data.events ?? { entries: [], nextCursor: null }) });
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

test("activity controls stay above growing lists as channel responses arrive", async ({ page }) => {
  for (const [section, gateName, controlSelector] of [
    ["members", "members", ".members-page__pagination-slot"],
    ["audit", "audit", ".audit-page__pagination-slot"],
    ["events", "events", ".events-page__pagination-slot"],
  ] as const) {
    let releaseResponse!: () => void;
    let markResponseStarted!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const responseStarted = new Promise<void>((resolve) => { markResponseStarted = resolve; });
    const responseData: ChannelMockData = section === "members"
      ? { members: { members: fullMemberPage, nextCursor: "members-next" } }
      : section === "audit" ? { audit: fullAuditPage } : { events: fullEventPage };
    await installChannelMocks(page, { [gateName]: { wait: responseGate, started: markResponseStarted } }, responseData);
    await page.goto(`/channels/${channelId}/${section}`);
    await responseStarted;
    const loadState = page.locator(".ui-load-state");
    await expect(loadState).toHaveAttribute("data-status", "loading");
    const beforeControl = await measureBox(page, controlSelector);
    releaseResponse();
    await expect(loadState).not.toHaveAttribute("data-status", "loading");
    const afterControl = await measureBox(page, controlSelector);
    expect(afterControl).toEqual(beforeControl);
    const listBox = await measureBox(page, ".ui-load-state");
    expect(beforeControl[1] + beforeControl[3]).toBeLessThanOrEqual(listBox[1]);
    await page.unrouteAll();
  }
});

test("platform audit and member controls stay above their growing lists", async ({ page }) => {
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
  const auditControlBefore = await measureBox(page, ".platform-audit__pagination-slot");
  releaseAudit();
  await expect(page.locator(".platform-audit__pagination-slot button")).toBeVisible();
  await expect(page.locator(".platform-audit__pagination-slot")).toHaveCount(1);
  const platformAuditList = page.locator(".platform-audit__pagination-slot + .ui-load-state");
  await expect(platformAuditList).toHaveAttribute("data-status", "success");
  expect(await measureBox(page, ".platform-audit__pagination-slot")).toEqual(auditControlBefore);
  expect(auditControlBefore[1] + auditControlBefore[3]).toBeLessThanOrEqual((await measureBox(page, ".platform-audit__pagination-slot + .ui-load-state"))[1]);

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
    await expect(page.locator(".platform-tabs__panel .platform-audit__pagination-slot")).toHaveCount(0);

    await auditTab.click();
    const auditControl = page.locator(".platform-audit__pagination-slot");
    const auditList = page.locator(".platform-audit__pagination-slot + .ui-load-state");
    await expect(auditTab).toHaveAttribute("aria-selected", "true");
    await expect(auditControl.getByRole("button", { name: "Load more" })).toBeVisible();
    await expect(auditList).toHaveAttribute("data-status", "success");
    await expect(auditList.locator(".table tbody tr")).toHaveCount(50);
    await expect(page.locator(".platform-tabs [role='tabpanel']:visible")).toHaveCount(1);
    await expect(page.locator(".platform-channel-table")).toHaveCount(0);
    const auditControls = await measureDocumentBox(page, ".platform-audit__pagination-slot");
    const auditRows = await measureDocumentBox(page, ".platform-audit__pagination-slot + .ui-load-state");
    expect(auditControls[1] + auditControls[3]).toBeLessThanOrEqual(auditRows[1]);
    await page.unrouteAll();
  }
});

test("a full member page keeps pagination above the growing list at desktop and 390px", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    let releaseMembers!: () => void;
    let markMembersStarted!: () => void;
    const membersGate = new Promise<void>((resolve) => { releaseMembers = resolve; });
    const membersStarted = new Promise<void>((resolve) => { markMembersStarted = resolve; });
    await installChannelMocks(page, { members: { wait: membersGate, started: markMembersStarted } }, {
      members: { members: fullMemberPage, nextCursor: "members-next" },
    });

    await page.goto(`/channels/${channelId}/members`);
    await membersStarted;
    const loadState = page.locator(".ui-load-state");
    await expect(loadState).toHaveAttribute("data-status", "loading");
    const beforeFooter = await measureBox(page, ".members-page__pagination-slot");
    releaseMembers();
    await expect(page.locator(".members-table tbody tr")).toHaveCount(100);
    await expect(loadState).toHaveAttribute("data-status", "success");
    expect(await measureBox(page, ".members-page__pagination-slot")).toEqual(beforeFooter);
    expect(beforeFooter[1] + beforeFooter[3]).toBeLessThanOrEqual((await measureBox(page, ".ui-load-state"))[1]);
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
  const limitSlotBefore = await measureBox(page, ".channel-variables-limit-slot");
  const createActionBefore = await measureBox(page, ".page-header__actions");
  releaseVariables();
  await expect(page.locator(".channel-variables-table tbody tr")).toHaveCount(25);
  expect(await measureBox(page, ".channel-variables-limit-slot")).toEqual(limitSlotBefore);
  expect(await measureBox(page, ".page-header__actions")).toEqual(createActionBefore);
  expect(limitSlotBefore[1] + limitSlotBefore[3]).toBeLessThanOrEqual((await measureBox(page, ".ui-load-state"))[1]);
});

test("a failed realtime variable refresh keeps rows visible and offers retry", async ({ page }) => {
  await page.addInitScript(() => {
    type LayoutSocket = EventTarget & { open: () => void; close: () => void; readyState: number };
    const sockets: LayoutSocket[] = [];
    class MockWebSocket extends EventTarget {
      readyState = 0;
      constructor(url: string, protocols?: string | string[]) {
        super();
        void url;
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
      if (variableRequestCount === 3) {
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
  const retrySlot = page.locator(".channel-variables-limit-slot");
  const slotBeforeRefreshFailure = await retrySlot.boundingBox();
  await page.evaluate(() => {
    const sockets = (window as Window & { __layoutSockets?: Array<{ open: () => void }> }).__layoutSockets ?? [];
    sockets.forEach((socket) => { socket.open(); });
  });
  await expect.poll(() => variableRequestCount).toBe(3);
  await expect(page.locator(".ui-toast--error")).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "{var.score}" })).toBeVisible();
  await expect(page.locator(".ui-load-state")).toHaveAttribute("data-status", "success");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(await retrySlot.boundingBox()).toEqual(slotBeforeRefreshFailure);

  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => variableRequestCount).toBe(4);
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
  await installChannelMocks(page, {}, { events: fullEventPage });
  await page.goto(`/channels/${channelId}/events`);
  await expect(page.locator(".event-table tbody tr")).toHaveCount(50);
  await expect.poll(() => page.evaluate(() => (window as Window & { __layoutEventSockets?: Array<{ open: () => void }> }).__layoutEventSockets?.length ?? 0)).toBeGreaterThan(0);
  await page.evaluate(() => { window.scrollTo(0, 1200); });
  await page.evaluate(() => {
    const sockets = (window as Window & { __layoutEventSockets?: Array<{ open: () => void; receive: (data: string) => void }> }).__layoutEventSockets ?? [];
    sockets.forEach((socket) => { socket.open(); });
    const now = new Date().toISOString();
    const envelope = JSON.stringify({ version: 1, id: "layout-new-event", createdAt: now, channelId: "stable-host-layout", type: "event_log.new", payload: { entries: [{ eventId: "new-event", createdAt: now, moduleId: "channel_events", code: "channel_events.message_removed", actorUserId: null }] } });
    sockets.forEach((socket) => { socket.receive(envelope); });
  });
  const notice = page.locator(".realtime-feed__notice");
  await expect(notice).toBeVisible();
  await expect(notice).toBeInViewport();
  const noticeBox = await notice.boundingBox();
  expect(noticeBox?.y).toBeGreaterThanOrEqual(0);
  expect(noticeBox?.y).toBeLessThan(120);
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

test("background channel refresh keeps populated overview cards through loading and failure", async ({ page }) => {
  const secondChannel = {
    ...channel,
    channelId: "stable-host-layout-second",
    login: "stable-channel-second",
    displayName: "Stable Channel Second",
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await installChannelMocks(page, {}, { channelList: [channel, secondChannel] });
    await page.goto("/");
    const grid = page.locator(".module-grid");
    await expect(grid.locator(":scope > .module-tile")).toHaveCount(2);
    const before = await measureDocumentBox(page, ".module-grid");

    let releaseRefresh!: () => void;
    let markRefreshStarted!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    await page.route("**/api/channels", async (route) => {
      markRefreshStarted();
      await refreshGate;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "channels_unavailable" }) });
    });

    await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await refreshStarted;
    await expect(page.locator(".ui-load-state")).toHaveAttribute("data-status", "success");
    await expect(grid.locator(":scope > .module-tile")).toHaveCount(2);
    expect(await measureDocumentBox(page, ".module-grid")).toEqual(before);

    releaseRefresh();
    await expect(page.locator(".ui-toast--error")).toBeVisible();
    await expect(page.locator(".ui-load-state")).toHaveAttribute("data-status", "success");
    await expect(grid.locator(":scope > .module-tile")).toHaveCount(2);
    expect(await measureDocumentBox(page, ".module-grid")).toEqual(before);
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
    const createActionBefore = await measureDocumentBox(page, ".overlays-page__create-action");

    releaseLegacyTokens();
    await expect(details.locator("summary")).toContainText("Legacy links (50)");
    await expect(details.locator(".ui-load-state")).toHaveAttribute("data-status", "success");
    expect(await measureDocumentBox(page, ".overlays-table")).toEqual(primaryListBefore);
    expect(await measureDocumentBox(page, ".overlays-page__create-action")).toEqual(createActionBefore);
    expect(primaryListBefore[1] + primaryListBefore[3]).toBeLessThanOrEqual((await measureDocumentBox(page, ".overlay-legacy-links"))[1]);

    await details.locator("summary").click();
    await expect(details.locator(".overlay-access-list__item--legacy").first()).toBeVisible();
    await expect(details.locator(".overlay-access-list__item--legacy")).toHaveCount(50);
    expect(await measureDocumentBox(page, ".overlays-table")).toEqual(primaryListBefore);
    expect(await measureDocumentBox(page, ".overlays-page__create-action")).toEqual(createActionBefore);
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
