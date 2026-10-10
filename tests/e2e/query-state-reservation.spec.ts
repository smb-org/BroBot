import { expect, test, type Locator, type Page } from "@playwright/test";

const box = async (locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error("The reserved query-state box is missing.");
  return Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.round(value * 100) / 100])) as {
    x: number; y: number; width: number; height: number;
  };
};

const size = async (locator: Locator): Promise<{ width: number; height: number }> => {
  const bounds = await box(locator);
  return { width: bounds.width, height: bounds.height };
};

const expectControlInsideSlot = async (control: Locator, slot: Locator): Promise<void> => {
  await control.scrollIntoViewIfNeeded();
  const controlBox = await box(control);
  const slotBox = await box(slot);
  expect(controlBox.x).toBeGreaterThanOrEqual(slotBox.x);
  expect(controlBox.y).toBeGreaterThanOrEqual(slotBox.y);
  expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(slotBox.x + slotBox.width);
  expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(slotBox.y + slotBox.height);
  const receivesPointer = await control.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return hit !== null && (hit === element || element.contains(hit));
  });
  expect(receivesPointer).toBe(true);
};

const channelId = "query-state-channel";
const channel = {
  channelId,
  login: "query-state-channel",
  displayName: "Query State Channel",
  language: "en",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-10-08T08:00:00.000Z" },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: "2026-10-08T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "subscription-query-state", reason: null, updatedAt: "2026-10-08T08:00:00.000Z" },
  chatSubscriptionNeeded: false,
  modules: [{ id: "ads", enabled: true, settings: "{}" }],
  tokens: {
    botExpiresAt: "2099-10-08T08:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-10-08T08:00:00.000Z",
  },
  streamState: "offline",
  streamStartedAt: null,
  controls: { mute: { active: false, until: null, mode: null }, pause: { active: false, until: null, mode: null } },
  lastError: null,
};

const loadedSettings = {
  automatic: "Ad break",
  automaticTarget: "everyone",
  manual: "Manual ad break",
  manualTarget: "everyone",
  prewarning: false,
  leadSeconds: 60,
  prewarningText: "Ad break in {ads.seconds} seconds.",
  prewarningTarget: "everyone",
};

const routeDashboardApi = async (page: Page, allowSettingsRecovery: () => boolean, onSettingsRequest: () => void): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot, platformAdmin: false, viewerIsBot: false }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...channel, activeModules: [{ moduleId: "ads", settings: "{}" }] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/settings`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ timeZone: "UTC", revision: 1, location: null, locationRevision: 1 }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/ads/settings`) {
      onSettingsRequest();
      if (!allowSettingsRecovery()) {
        await new Promise((resolve) => { setTimeout(resolve, 150); });
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "service_unavailable" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings: loadedSettings, revision: 1, variables: [] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/ads/schedule`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: 0, snoozeRefreshAt: null }, snoozeScopeAvailable: true, recentAdBreaks: [] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/template-variables`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ variables: [] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });
};

test("compact, panel, toolbar, and module settings retries keep their declared boxes at desktop and narrow widths", async ({ page }) => {
  test.setTimeout(60_000);

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/tests/e2e/query-state-fixture.html");

    const toolbar = page.locator(".list-toolbar__status");
    const compact = page.locator(".compact-load");
    const panel = page.locator(".panel-load");
    const toolbarControls = [
      [page.getByRole("textbox", { name: "Search variables" }), page.locator(".list-toolbar__search")],
      [page.getByRole("button", { name: "Role filter" }), page.locator(".list-toolbar__filters")],
      [page.getByRole("button", { name: "Create variable" }), page.locator(".list-toolbar__create")],
    ] as const;
    await expect(toolbar).toBeVisible();
    await expect(compact).toHaveAttribute("data-status", "loading");
    await expect(panel).toHaveAttribute("data-status", "loading");
    const loadingBoxes = { toolbar: await box(toolbar), compact: await box(compact), panel: await box(panel) };
    for (const [control, slot] of toolbarControls) await expectControlInsideSlot(control, slot);
    await expectControlInsideSlot(page.getByRole("button", { name: "Reset" }), toolbar);

    await page.getByRole("button", { name: "Fail initial request" }).click();
    await expect(toolbar.locator(".ui-load-state__inline-message")).toHaveAttribute("title", /request timed out/u);
    await expect(compact.locator(".ui-load-state__inline-error")).toBeVisible();
    await expect(panel.locator("[role=alert]")).toBeVisible();
    const initialErrorBoxes = { toolbar: await box(toolbar), compact: await box(compact), panel: await box(panel) };
    expect(initialErrorBoxes).toEqual(loadingBoxes);
    await expectControlInsideSlot(compact.getByRole("button", { name: "Retry" }), compact);
    await expectControlInsideSlot(panel.getByRole("button", { name: "Retry" }), panel);

    const toolbarError = toolbar.locator(".ui-load-state__inline-error");
    const toolbarMessage = toolbarError.locator(".ui-load-state__inline-message");
    const toolbarActions = toolbarError.locator(".ui-load-state__inline-actions");
    expect((await box(toolbarMessage)).width).toBeGreaterThan(0);
    expect((await box(toolbarActions)).width).toBeGreaterThan(0);
    await expect(toolbarMessage).toHaveAttribute("title", "The saved channel settings could not be refreshed because the request timed out while the service was unavailable.");
    for (const [control, slot] of toolbarControls) await expectControlInsideSlot(control, slot);
    await expectControlInsideSlot(page.getByRole("button", { name: "Reset" }), toolbar);
    await expectControlInsideSlot(toolbarError.getByRole("button", { name: "Retry" }), toolbar);

    await compact.getByRole("button", { name: "Retry" }).click();
    await expect(toolbar.locator(".ui-load-state__inline-error")).toHaveCount(0);
    await expect(panel).toHaveAttribute("data-status", "success");
    const recoveredBoxes = { toolbar: await box(toolbar), compact: await box(compact), panel: await box(panel) };
    expect(recoveredBoxes).toEqual(loadingBoxes);

    await page.getByRole("button", { name: "Fail background refresh" }).click();
    await expect(toolbar.locator(".ui-load-state__inline-error")).toBeVisible();
    await expect(panel.locator(".ui-load-state__retry-slot .ui-load-state__inline-error")).toBeVisible();
    await expect(panel).toContainText("Cached settings remain visible.");
    const backgroundErrorBoxes = { toolbar: await box(toolbar), compact: await box(compact), panel: await box(panel) };
    expect(backgroundErrorBoxes).toEqual(loadingBoxes);
    const backgroundToolbarError = toolbar.locator(".ui-load-state__inline-error");
    expect(await box(backgroundToolbarError.locator(".ui-load-state__inline-actions"))).toEqual(await box(toolbarActions));
    await expectControlInsideSlot(backgroundToolbarError.getByRole("button", { name: "Retry" }), toolbar);
    await expectControlInsideSlot(page.getByRole("button", { name: "Reset" }), toolbar);
    const panelRetrySlot = panel.locator(".ui-load-state__retry-slot");
    await expectControlInsideSlot(panelRetrySlot.getByRole("button", { name: "Retry" }), panelRetrySlot);
    await panelRetrySlot.getByRole("button", { name: "Retry" }).click();
    await expect(panel.locator(".ui-load-state__retry-slot .ui-load-state__inline-error")).toHaveCount(0);
    expect({ toolbar: await box(toolbar), compact: await box(compact), panel: await box(panel) }).toEqual(loadingBoxes);

    let signalTemplateRequest: () => void = () => undefined;
    const templateRequestStarted = new Promise<void>((resolve) => { signalTemplateRequest = resolve; });
    let releaseTemplateRequest: () => void = () => undefined;
    const templateRequestGate = new Promise<void>((resolve) => { releaseTemplateRequest = resolve; });
    let templateRequests = 0;
    let allowTemplateRecovery = false;
    await page.route("**/api/channels/channel-a/modules/text_commands/commands", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commands: [], variables: [] }) });
    });
    await page.route("**/api/channels/channel-a/template-variables", async (route) => {
      templateRequests += 1;
      if (templateRequests === 1) {
        signalTemplateRequest();
        await templateRequestGate;
      }
      await route.fulfill({
        status: allowTemplateRecovery ? 200 : 503,
        contentType: "application/json",
        body: JSON.stringify(allowTemplateRecovery ? { variables: [] } : { error: "service_unavailable" }),
      });
    });
    await page.goto("/tests/e2e/module-panels-stability-fixture.html?panel=text_commands");
    await page.getByRole("button", { name: "Add command" }).click();
    await templateRequestStarted;
    const templateState = page.locator(".command-editor-shell .ui-load-state--compact");
    await expect(templateState).toHaveAttribute("data-status", "loading");
    const templateLoadingSize = await size(templateState);
    expect(templateLoadingSize.height).toBe(64);
    releaseTemplateRequest();
    await expect(templateState).toHaveAttribute("data-status", "error");
    expect(await size(templateState)).toEqual(templateLoadingSize);
    await expectControlInsideSlot(templateState.getByRole("button", { name: "Retry" }), templateState);
    allowTemplateRecovery = true;
    await templateState.getByRole("button", { name: "Retry" }).click();
    await expect(templateState).toHaveAttribute("data-status", "success");
    expect(await size(templateState)).toEqual(templateLoadingSize);
    expect(templateRequests).toBeGreaterThanOrEqual(2);
    await page.unroute("**/api/channels/channel-a/modules/text_commands/commands");
    await page.unroute("**/api/channels/channel-a/template-variables");

    let settingsRequests = 0;
    let allowSettingsRecovery = false;
    await routeDashboardApi(page, () => allowSettingsRecovery, () => { settingsRequests += 1; });
    await page.goto(`/channels/${channelId}/modules/ads`);
    await expect(page.getByRole("heading", { name: "Ad breaks", level: 1 })).toBeVisible();
    const settingsState = page.locator(".module-view > .ui-load-state").last();
    await expect(settingsState).toHaveAttribute("data-status", "loading");
    const settingsLoadingSize = await size(settingsState);
    await expect(settingsState).toHaveAttribute("data-status", "error");
    expect(await size(settingsState)).toEqual(settingsLoadingSize);
    const settingsRetrySlot = settingsState.locator(".ui-load-state__retry-slot");
    const settingsRetrySlotSize = await size(settingsRetrySlot);
    await expectControlInsideSlot(settingsState.getByRole("button", { name: "Retry" }), settingsState);
    allowSettingsRecovery = true;
    await settingsState.getByRole("button", { name: "Retry" }).click();
    await expect(settingsState).toHaveAttribute("data-status", "success");
    expect(await size(settingsRetrySlot)).toEqual(settingsRetrySlotSize);
    expect((await size(settingsState)).height).toBeGreaterThanOrEqual(settingsLoadingSize.height);
    expect(settingsRequests).toBeGreaterThanOrEqual(2);
    await page.unroute("**/api/**");
  }
});

test.describe("ListToolbar status-row retry in German", () => {
  test.use({ locale: "de-DE" });

  test("keeps every toolbar control inside its slot at desktop and narrow widths", async ({ page }) => {
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/tests/e2e/query-state-fixture.html");
      const toolbar = page.locator(".list-toolbar__status");
      const controls = [
        [page.getByRole("textbox", { name: "Search variables" }), page.locator(".list-toolbar__search")],
        [page.getByRole("button", { name: "Role filter" }), page.locator(".list-toolbar__filters")],
        [page.getByRole("button", { name: "Create variable" }), page.locator(".list-toolbar__create")],
      ] as const;
      const originalSize = await size(toolbar);
      await page.getByRole("button", { name: "Fail initial request" }).click();
      const retry = toolbar.getByRole("button", { name: "Erneut versuchen" });
      await expect(retry).toBeVisible();
      expect(await size(toolbar)).toEqual(originalSize);
      for (const [control, slot] of controls) await expectControlInsideSlot(control, slot);
      await expectControlInsideSlot(page.getByRole("button", { name: "Reset" }), toolbar);
      await expectControlInsideSlot(retry, toolbar);
      await retry.click();
      await expect(toolbar.locator(".ui-load-state__inline-error")).toHaveCount(0);
      expect(await size(toolbar)).toEqual(originalSize);
    }
  });
});

const checkWarningsFeedReservation = async (page: Page, language: "de" | "en"): Promise<void> => {
  const channelId = "feed-error-channel";
  const channel = {
    channelId,
    login: channelId,
    displayName: "Feed error channel",
    language,
    role: "manager",
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: "2026-10-08T08:00:00.000Z" },
    botPermissions: { missingScopes: [] },
    broadcasterPermissions: { missingScopes: [] },
    moderator: { isModerator: true, checkedAt: "2026-10-08T08:00:00.000Z", reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "subscription-feed-error", reason: null, updatedAt: "2026-10-08T08:00:00.000Z" },
    chatSubscriptionNeeded: false,
    modules: [],
    tokens: {
      botExpiresAt: "2099-10-08T08:00:00.000Z",
      loginStatus: "connected",
      loginReason: null,
      loginExpiresAt: "2099-10-08T08:00:00.000Z",
    },
    streamState: "offline",
    streamStartedAt: null,
    controls: { mute: { active: false, until: null, mode: null }, pause: { active: false, until: null, mode: null } },
    lastError: null,
  };
  let failEvents = true;
  let signalEventRequest: () => void = () => undefined;
  let eventRequestStarted: Promise<void>;
  await page.route("**/api/channels**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot, platformAdmin: false, viewerIsBot: false }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...channel, activeModules: [] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules: [] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/settings`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ timeZone: "UTC", revision: 1, location: null, locationRevision: 1 }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/events`) {
      signalEventRequest();
      if (failEvents) {
        await new Promise((resolve) => { setTimeout(resolve, 180); });
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "service_unavailable" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [], nextCursor: null }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    failEvents = true;
    eventRequestStarted = new Promise<void>((resolve) => { signalEventRequest = resolve; });
    await page.goto(`/channels/${channelId}`);
    await eventRequestStarted;

    const feedSection = page.locator("section.content-section").filter({ has: page.locator(".stream-manager-feed__all") });
    const feedState = feedSection.locator(".ui-load-state");
    await expect(feedState).toHaveAttribute("data-status", "loading");
    await feedState.scrollIntoViewIfNeeded();
    const loadingBox = await box(feedState);
    await expect(feedState).toHaveAttribute("data-status", "error");
    const errorBox = await box(feedState);
    expect(errorBox).toEqual(loadingBox);
    const retry = feedState.getByRole("button", { name: language === "de" ? "Erneut versuchen" : "Retry" });
    await expectControlInsideSlot(retry, feedState);

    failEvents = false;
    eventRequestStarted = new Promise<void>((resolve) => { signalEventRequest = resolve; });
    await retry.click();
    await eventRequestStarted;
    await expect(feedState).toHaveAttribute("data-status", "empty");
    expect(await box(feedState)).toEqual(loadingBox);
  }
};

test.describe("warnings feed retry reservation in English", () => {
  test.use({ locale: "en-US" });

  test("initial failure fits its reserved box and leaves Retry hittable", async ({ page }) => {
    await checkWarningsFeedReservation(page, "en");
  });
});

test.describe("warnings feed retry reservation in German", () => {
  test.use({ locale: "de-DE" });

  test("initial failure fits its reserved box and leaves retry hittable", async ({ page }) => {
    await checkWarningsFeedReservation(page, "de");
  });
});
