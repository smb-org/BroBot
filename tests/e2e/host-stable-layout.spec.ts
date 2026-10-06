import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "en-US" });

const channelId = "stable-host-layout";
const channel = {
  channelId,
  login: "stable-channel",
  displayName: "Stable Channel",
  role: "manager",
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

type ChannelGates = Partial<Record<"settings" | "members" | "audit" | "events" | "overlays" | "legacyTokens", RequestGate>>;

interface ChannelMockData {
  settings?: Record<string, unknown>;
  members?: { members: readonly Record<string, unknown>[]; nextCursor: string | null };
  modules?: readonly Record<string, unknown>[];
  moduleStatus?: number;
  moduleToggleStatus?: number;
}

const installChannelMocks = async (page: Page, gates: ChannelGates = {}, data: ChannelMockData = {}): Promise<void> => {
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
    if (pathname === `/api/channels/${channelId}/overlays`) {
      const gate = gates.overlays;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ overlays: [], maximum: 20, elementMaximum: 20 }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overlay-tokens`) {
      const gate = gates.legacyTokens;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tokens: [], nextOffset: null }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/audit-log`) {
      const gate = gates.audit;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [], nextCursor: null }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules` && route.request().method() === "GET") {
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [], nextCursor: null }) });
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

test("activity page load states keep their boxes as channel responses arrive", async ({ page }) => {
  for (const [section, gateName] of [["members", "members"], ["audit", "audit"], ["events", "events"]] as const) {
    let releaseResponse!: () => void;
    let markResponseStarted!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const responseStarted = new Promise<void>((resolve) => { markResponseStarted = resolve; });
    await installChannelMocks(page, { [gateName]: { wait: responseGate, started: markResponseStarted } });
    await page.goto(`/channels/${channelId}/${section}`);
    await responseStarted;
    const loadState = page.locator(".ui-load-state");
    await expect(loadState).toHaveAttribute("data-status", "loading");
    const before = await measureBox(page, ".ui-load-state");
    releaseResponse();
    await expect(loadState).not.toHaveAttribute("data-status", "loading");
    const after = await measureBox(page, ".ui-load-state");
    expect(after[2]).toBe(before[2]);
    expect(after[3]).toBeLessThanOrEqual(before[3]);
    await page.unrouteAll();
  }
});

test("a full member page keeps its loading and pagination positions at desktop and 390px", async ({ page }) => {
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
    const beforeList = await measureBox(page, ".ui-load-state");
    const beforeFooter = await measureBox(page, ".members-page__pagination-slot");
    releaseMembers();
    await expect(page.locator(".members-table tbody tr")).toHaveCount(100);
    await expect(loadState).toHaveAttribute("data-status", "success");
    expect(await measureBox(page, ".ui-load-state")).toEqual(beforeList);
    expect(await measureBox(page, ".members-page__pagination-slot")).toEqual(beforeFooter);
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
  await page.evaluate(() => {
    const sockets = (window as Window & { __layoutSockets?: Array<{ open: () => void }> }).__layoutSockets ?? [];
    sockets.forEach((socket) => { socket.open(); });
  });
  await expect.poll(() => variableRequestCount).toBe(3);
  await expect(page.locator(".ui-toast--error")).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "{var.score}" })).toBeVisible();
  await expect(page.locator(".ui-load-state")).toHaveAttribute("data-status", "success");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => variableRequestCount).toBe(4);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByRole("rowheader", { name: "{var.score}" })).toBeVisible();
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

test("overlay list and legacy-link regions keep their boxes while data loads", async ({ page }) => {
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
  });

  await page.goto(`/channels/${channelId}/overlays`);
  await Promise.all([overlaysStarted, legacyTokensStarted]);
  const overlayList = page.locator(".overlays-page > .ui-load-state");
  const legacyList = page.locator(".overlay-legacy-links .ui-load-state");
  const beforeOverlayList = await measureBox(page, ".overlays-page > .ui-load-state");
  const beforeLegacyList = await measureBox(page, ".overlay-legacy-links .ui-load-state");
  releaseOverlays();
  releaseLegacyTokens();
  await expect(overlayList).toHaveAttribute("data-status", "empty");
  await expect(legacyList).toHaveAttribute("data-status", "empty");
  expect(await measureBox(page, ".overlays-page > .ui-load-state")).toEqual(beforeOverlayList);
  expect(await measureBox(page, ".overlay-legacy-links .ui-load-state")).toEqual(beforeLegacyList);
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
