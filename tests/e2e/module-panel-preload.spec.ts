import { expect, test, type Page, type Route } from "@playwright/test";

test.use({ locale: "en-US" });

const channelId = "module-preload";
const modules = [
  { id: "text_commands", enabled: true, settings: "{}" },
  { id: "api_source", enabled: true, settings: "{}" },
  { id: "ads", enabled: true, settings: "{}" },
  { id: "faq", enabled: false, settings: "{}" },
];
const channel = {
  channelId,
  login: "module-preload",
  displayName: "Module preload",
  language: "en",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-10-01T12:00:00.000Z" },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: "2026-10-01T12:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "module-preload-subscription", reason: null, updatedAt: "2026-10-01T12:00:00.000Z" },
  tokens: { botExpiresAt: null, loginStatus: "connected", loginReason: null, loginExpiresAt: null },
  lastError: null,
  modules,
};

const installApiRoutes = async (page: Page, channelState: typeof channel = channel): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channelState], bot: channelState.bot, platformAdmin: false }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ...channelState,
        activeModules: channelState.modules.filter((module) => module.enabled).map(({ id, settings }) => ({ moduleId: id, settings })),
      }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules: channelState.modules }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/revisions`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revisions: {} }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/text_commands/commands`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commands: [], variables: [] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/api_source/sources`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sources: [] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/ads/settings`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        settings: { automatic: "Ad break", manual: "Manual ad break", prewarning: false, leadSeconds: 60, prewarningText: "Ad break in {ads.seconds} seconds." },
        revision: 1,
        variables: [],
      }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/ads/schedule`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: 0, snoozeRefreshAt: null },
        snoozeScopeAvailable: true,
        recentAdBreaks: [],
      }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
};

const suppressIdlePreload = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: () => 1 });
    Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: () => undefined });
  });
};

test("hover preloads a module and navigation keeps the current view until its panel chunk is ready", async ({ page }) => {
  await suppressIdlePreload(page);
  await installApiRoutes(page);

  let markRequestStarted: () => void = () => undefined;
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
  let releaseRequest: () => void = () => undefined;
  const responseGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/src/modules/api_source/panel/index.tsx*", async (route) => {
    markRequestStarted();
    await responseGate;
    await route.continue();
  });

  await page.goto(`/channels/${channelId}/modules/text_commands`);
  await expect(page.locator(".module-detail h1")).toHaveText("Text commands");
  const target = page.locator(`a[href="/channels/${channelId}/modules/api_source"]`);
  await expect(target).toBeVisible();
  await target.hover();
  await requestStarted;

  await target.click();
  await expect(page).toHaveURL(`/channels/${channelId}/modules/api_source`);
  await expect(page.locator(".module-detail h1")).toHaveText("Text commands");
  await expect(page.getByText("Loading module views …", { exact: true })).toHaveCount(0);

  releaseRequest();
  await expect(page.locator(".module-detail h1")).not.toHaveText("Text commands");
  await expect(page.getByText("Loading module views …", { exact: true })).toHaveCount(0);
});

test("idle preload warms every registered chunk for enabled modules only", async ({ page }) => {
  await page.addInitScript(() => {
    type IdleTestWindow = Window & { __idleCallbacks?: Array<() => void> };
    const idleWindow = window as IdleTestWindow;
    const pendingCallbacks = new Map<number, () => void>();
    let nextHandle = 0;
    idleWindow.__idleCallbacks = [];
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: (callback: () => void) => {
        nextHandle += 1;
        pendingCallbacks.set(nextHandle, callback);
        idleWindow.__idleCallbacks = [...pendingCallbacks.values()];
        return nextHandle;
      },
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      value: (handle: number) => {
        pendingCallbacks.delete(handle);
        idleWindow.__idleCallbacks = [...pendingCallbacks.values()];
      },
    });
  });
  await installApiRoutes(page);

  const requestedPaths: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes("/src/modules/")) requestedPaths.push(pathname);
  });
  await page.goto(`/channels/${channelId}/modules`);
  await expect(page.locator(".module-workspace .state-list")).toBeVisible();
  await expect(page.locator(`.sidebar a[href="/channels/${channelId}/modules/ads"]`)).toBeVisible();

  const chunkRequests = Promise.all([
    page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/src/modules/ads/panel/index.tsx")),
    page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/src/modules/ads/panel/settings-editor.ts")),
    page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/src/modules/ads/panel/immediate-actions.tsx")),
  ]);
  await page.evaluate(() => {
    type IdleTestWindow = Window & { __idleCallbacks?: Array<() => void> };
    const idleWindow = window as IdleTestWindow;
    idleWindow.__idleCallbacks?.splice(0).forEach((callback) => { callback(); });
  });
  await chunkRequests;

  expect(requestedPaths.some((path) => path.includes("/src/modules/faq/panel/"))).toBe(false);
  expect(requestedPaths).toContain("/src/modules/ads/panel/index.tsx");
  expect(requestedPaths).toContain("/src/modules/ads/panel/settings-editor.ts");
  expect(requestedPaths).toContain("/src/modules/ads/panel/immediate-actions.tsx");
});

test("idle preload skips an enabled module hidden by missing broadcaster scopes", async ({ page }) => {
  await page.addInitScript(() => {
    type IdleTestWindow = Window & { __idleCallbacks?: Array<() => void> };
    const idleWindow = window as IdleTestWindow;
    idleWindow.__idleCallbacks = [];
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: (callback: () => void) => {
        idleWindow.__idleCallbacks?.push(callback);
        return idleWindow.__idleCallbacks?.length ?? 0;
      },
    });
    Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: () => undefined });
  });
  const hiddenChannel = {
    ...channel,
    modules: modules.map((module) => module.id === "ads"
      ? { ...module, missingBroadcasterScopes: ["channel:read:ads"] }
      : module),
  };
  await installApiRoutes(page, hiddenChannel);

  const requestedPaths: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes("/src/modules/")) requestedPaths.push(pathname);
  });
  await page.goto(`/channels/${channelId}/modules`);
  await expect(page.locator(".module-workspace .state-list")).toBeVisible();
  await expect(page.locator(`.sidebar a[href="/channels/${channelId}/modules/ads"]`)).toHaveCount(0);

  const visibleChunkRequests = Promise.all([
    page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/src/modules/text_commands/panel/index.tsx")),
    page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/src/modules/api_source/panel/index.tsx")),
  ]);
  await page.evaluate(() => {
    type IdleTestWindow = Window & { __idleCallbacks?: Array<() => void> };
    const idleWindow = window as IdleTestWindow;
    idleWindow.__idleCallbacks?.splice(0).forEach((callback) => { callback(); });
  });
  await visibleChunkRequests;

  expect(requestedPaths.some((path) => path.includes("/src/modules/ads/panel/")), requestedPaths.join("\n")).toBe(false);
});

test("cold module navigation keeps the reserved page height and scroll position while its chunk resolves", async ({ page }) => {
  await suppressIdlePreload(page);
  await installApiRoutes(page);

  let markRequestStarted: () => void = () => undefined;
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
  let releaseRequest: () => void = () => undefined;
  const responseGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/src/modules/api_source/panel/index.tsx*", async (route) => {
    markRequestStarted();
    await responseGate;
    await route.continue();
  });

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`/channels/${channelId}/modules/api_source`);
  await requestStarted;
  await expect(page.locator(".module-view-fallback")).toBeVisible();
  const reservedPage = page.locator(".module-route-layout");
  const heightBefore = await reservedPage.evaluate((element) => element.getBoundingClientRect().height);
  await page.evaluate(() => { window.scrollTo(0, 120); });
  const scrollBefore = await page.evaluate(() => window.scrollY);

  releaseRequest();
  await expect(page.locator(".module-view-fallback")).toHaveCount(0);
  await expect(page.locator(".module-detail h1")).toHaveText("API sources");

  expect(await reservedPage.evaluate((element) => element.getBoundingClientRect().height)).toBe(heightBefore);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
});

test("a failed idle settings preload can recover through the module Retry action", async ({ page }) => {
  await page.addInitScript(() => {
    type IdleTestWindow = Window & { __idleCallbacks?: Array<() => void> };
    const idleWindow = window as IdleTestWindow;
    const pendingCallbacks = new Map<number, () => void>();
    let nextHandle = 0;
    idleWindow.__idleCallbacks = [];
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: (callback: () => void) => {
        nextHandle += 1;
        pendingCallbacks.set(nextHandle, callback);
        idleWindow.__idleCallbacks = [...pendingCallbacks.values()];
        return nextHandle;
      },
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      value: (handle: number) => {
        pendingCallbacks.delete(handle);
        idleWindow.__idleCallbacks = [...pendingCallbacks.values()];
      },
    });
  });
  await installApiRoutes(page);

  let settingsChunkRequests = 0;
  await page.route("**/src/modules/ads/panel/settings-editor.ts*", async (route) => {
    settingsChunkRequests += 1;
    if (settingsChunkRequests === 1) {
      await route.fulfill({ status: 503, contentType: "text/plain", body: "temporary chunk failure" });
      return;
    }
    await route.continue();
  });

  await page.goto(`/channels/${channelId}/modules`);
  await expect(page.locator(".module-workspace .state-list")).toBeVisible();
  await page.evaluate(() => {
    type IdleTestWindow = Window & { __idleCallbacks?: Array<() => void> };
    const idleWindow = window as IdleTestWindow;
    idleWindow.__idleCallbacks?.splice(0).forEach((callback) => { callback(); });
  });
  await expect.poll(() => settingsChunkRequests).toBe(1);

  await page.locator(`.sidebar a[href="/channels/${channelId}/modules/ads"]`).evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await expect(page).toHaveURL(`/channels/${channelId}/modules/ads`);
  const settings = page.locator(".module-view");
  const retryButton = settings.getByRole("button", { name: "Retry" });
  await expect(retryButton).toBeVisible();
  await expect.poll(() => settingsChunkRequests).toBe(1);

  await retryButton.click();

  await expect(settings.locator(".ui-settings-editor")).toBeVisible();
  await expect.poll(() => settingsChunkRequests).toBe(2);
  await expect(retryButton).toHaveCount(0);
});

const lazyModuleViews = [
  "text_commands", "faq", "chat_voting", "text_library", "timers", "sun", "moon",
  "weather", "api_source", "belabox", "ads", "votekick",
] as const;
const lazyOverlayEditors = [
  { kind: "chat_voting.tally", moduleId: "chat_voting", chunk: "editor" },
  { kind: "text_library.block", moduleId: "text_library", chunk: "editor" },
  { kind: "belabox.status", moduleId: "belabox", chunk: "editor" },
  { kind: "ads.countdown", moduleId: "ads", chunk: "countdown-editor" },
  { kind: "votekick.tally", moduleId: "votekick", chunk: "editor" },
] as const;

const lazyLayoutCases = [
  ...lazyModuleViews.map((moduleId) => ({ type: "module" as const, moduleId, label: `${moduleId} panel` })),
  ...lazyOverlayEditors.map((editor) => ({ type: "editor" as const, ...editor, label: `${editor.kind} editor` })),
];

for (const lazyCase of lazyLayoutCases) {
  test(`${lazyCase.label} keeps its reserved box and scroll position during delayed import`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.route("**/api/**", async (route) => {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    const pattern = lazyCase.type === "module"
      ? `**/src/modules/${lazyCase.moduleId}/panel/**`
      : `**/src/modules/${lazyCase.moduleId}/overlay/${lazyCase.chunk}.tsx*`;
    let markRequestStarted: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
    let releaseRequest: () => void = () => undefined;
    const responseGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const intercept = async (route: Route): Promise<void> => {
      markRequestStarted();
      await responseGate;
      await route.continue();
    };
    await page.route(pattern, intercept);
    const fixtureUrl = lazyCase.type === "module"
      ? `/tests/e2e/module-lazy-layout-fixture.html?module=${lazyCase.moduleId}`
      : `/tests/e2e/module-lazy-layout-fixture.html?element=${encodeURIComponent(lazyCase.kind)}`;
    await page.goto(fixtureUrl, { waitUntil: "commit" });
    await requestStarted;

    const reservedBox = page.getByTestId("module-route-layout");
    const sentinel = page.getByTestId("layout-sentinel");
    if (lazyCase.type === "module") await expect(page.locator(".module-view-fallback")).toBeVisible();
    else await expect(page.locator("[data-module-editor-fallback]")).toBeVisible();
    const boxHeightBefore = await reservedBox.evaluate((element) => element.getBoundingClientRect().height);
    const minHeightBefore = await reservedBox.evaluate((element) => getComputedStyle(element).minHeight);
    await page.evaluate(() => { window.scrollTo(0, 120); });
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const sentinelTopBefore = await sentinel.evaluate((element) => element.getBoundingClientRect().top);

    releaseRequest();
    if (lazyCase.type === "module") await expect(page.locator(".module-view-fallback")).toHaveCount(0);
    else await expect(page.locator("[data-module-editor-fallback]")).toHaveCount(0);

    expect(await reservedBox.evaluate((element) => getComputedStyle(element).minHeight), lazyCase.label).toBe(minHeightBefore);
    expect(await reservedBox.evaluate((element) => element.getBoundingClientRect().height), lazyCase.label).toBe(boxHeightBefore);
    if (lazyCase.type === "editor") {
      expect(await sentinel.evaluate((element) => element.getBoundingClientRect().top), lazyCase.label).toBe(sentinelTopBefore);
    }
    expect(await page.evaluate(() => window.scrollY), lazyCase.label).toBe(scrollBefore);
  });
}
