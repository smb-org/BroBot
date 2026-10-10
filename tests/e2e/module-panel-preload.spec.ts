import { expect, test, type Page } from "@playwright/test";

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

const installApiRoutes = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot, platformAdmin: false }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ...channel,
        activeModules: modules.filter((module) => module.enabled).map(({ id, settings }) => ({ moduleId: id, settings })),
      }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules }) });
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
