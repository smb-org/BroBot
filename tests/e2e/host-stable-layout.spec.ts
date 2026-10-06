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

const measureBox = async (page: Page, selector: string): Promise<number[]> => {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`Missing layout box for ${selector}.`);
  return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100);
};

interface RequestGate {
  wait: Promise<void>;
  started: () => void;
}

type ChannelGates = Partial<Record<"settings" | "members" | "audit" | "events" | "overlays" | "legacyTokens", RequestGate>>;

const installChannelMocks = async (page: Page, gates: ChannelGates = {}): Promise<void> => {
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ timeZone: "UTC", revision: 1, location: null, locationRevision: 1 }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/members`) {
      const gate = gates.members;
      gate?.started();
      if (gate !== undefined) await gate.wait;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ members: [], nextCursor: null, broadcasterCount: 1, viewerUserId: "viewer" }) });
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
    if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules: [] }) });
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
    expect(after).toEqual(before);
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
