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

test("every lazy module view and overlay editor keeps its reserved box and scroll position during import", async ({ page }) => {
  const lazyModuleIds = [
    "text_commands", "faq", "chat_voting", "text_library", "timers", "sun", "moon",
    "weather", "api_source", "belabox", "ads", "votekick",
  ];
  const overlayElements = [
    { kind: "chat_voting.tally", moduleId: "chat_voting" },
    { kind: "text_library.block", moduleId: "text_library" },
    { kind: "belabox.status", moduleId: "belabox" },
    { kind: "ads.countdown", moduleId: "ads" },
    { kind: "votekick.tally", moduleId: "votekick" },
  ];
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.route("**/api/**", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  for (const moduleId of lazyModuleIds) {
    let markRequestStarted: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
    let releaseRequest: () => void = () => undefined;
    const responseGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const pattern = `**/src/modules/${moduleId}/panel/**`;
    const intercept = async (route: Route): Promise<void> => {
      markRequestStarted();
      await responseGate;
      await route.continue();
    };
    await page.route(pattern, intercept);
    await page.goto(`/tests/e2e/module-lazy-layout-fixture.html?module=${moduleId}`);
    await requestStarted;
    await expect(page.locator(".module-view-fallback")).toBeVisible();
    const reservedPage = page.getByTestId("module-route-layout");
    const heightBefore = await reservedPage.evaluate((element) => element.getBoundingClientRect().height);
    const minHeightBefore = await reservedPage.evaluate((element) => getComputedStyle(element).minHeight);
    await page.evaluate(() => { window.scrollTo(0, 120); });
    const scrollBefore = await page.evaluate(() => window.scrollY);

    releaseRequest();
    await expect(page.locator(".module-view-fallback")).toHaveCount(0);
    expect(await reservedPage.evaluate((element) => getComputedStyle(element).minHeight), moduleId).toBe(minHeightBefore);
    expect(await reservedPage.evaluate((element) => element.getBoundingClientRect().height), moduleId).toBeGreaterThanOrEqual(heightBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await page.unroute(pattern, intercept);
  }

  for (const { kind, moduleId } of overlayElements) {
    let markRequestStarted: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
    let releaseRequest: () => void = () => undefined;
    const responseGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const editorChunk = kind === "ads.countdown" ? "countdown-editor" : "editor";
    const pattern = `**/src/modules/${moduleId}/overlay/${editorChunk}.tsx*`;
    const intercept = async (route: Route): Promise<void> => {
      markRequestStarted();
      await responseGate;
      await route.continue();
    };
    await page.route(pattern, intercept);
    await page.goto(`/tests/e2e/module-lazy-layout-fixture.html?element=${encodeURIComponent(kind)}`, { waitUntil: "commit" });
    await requestStarted;
    const editor = page.locator(`.module-overlay-element-editor[data-kind="${kind}"]`);
    await expect(editor).toBeVisible();
    const heightBefore = await editor.evaluate((element) => element.getBoundingClientRect().height);
    await page.evaluate(() => { window.scrollTo(0, 120); });
    const scrollBefore = await page.evaluate(() => window.scrollY);

    releaseRequest();
    await expect(editor.locator("[data-module-editor-fallback]")).toHaveCount(0);
    const editorLayout = await editor.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      minHeight: getComputedStyle(element).minHeight,
      spacingToken: getComputedStyle(element).getPropertyValue("--s10"),
    }));
    expect(editorLayout.height, `${kind}: ${JSON.stringify(editorLayout)}`).toBe(heightBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await page.unroute(pattern, intercept);
  }
});
