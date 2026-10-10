import { expect, test, type Page } from "@playwright/test";

const channelId = "realtime-navigation";
const channel = {
  channelId,
  login: "realtime-navigation",
  displayName: "Realtime Navigation",
  language: "en",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-10-09T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-10-09T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "realtime-subscription", reason: null, updatedAt: "2026-10-09T08:00:00.000Z" },
  tokens: {
    botExpiresAt: "2099-10-09T08:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-10-09T08:00:00.000Z",
  },
  streamState: "offline",
  streamStartedAt: null,
  controls: {
    mute: { active: false, until: null, mode: null },
    pause: { active: false, until: null, mode: null },
  },
  lastError: null,
};

const installSocketCounter = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    type TrackedSocket = EventTarget & { url: string; readyState: number };
    const sockets: TrackedSocket[] = [];
    class MockWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        sockets.push(this);
      }

      close(): void {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
      }

      send(): void {}
    }
    Object.defineProperty(window, "__realtimePanelSockets", { value: sockets, configurable: true });
    Object.defineProperty(window, "WebSocket", { value: MockWebSocket, writable: true, configurable: true });
  });
};

const installApiMocks = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [channel], bot: channel.bot }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...channel, activeModules: [{ moduleId: "text_commands", settings: "{}" }] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/settings`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ timeZone: "UTC", revision: 1, location: null, locationRevision: 0 }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules: [{ id: "text_commands", enabled: true, settings: "{}" }] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/text_commands/commands`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commands: [], variables: [] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/template-variables`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ variables: [] }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/events`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [], nextCursor: null }) });
      return;
    }
    if (pathname === `/api/channels/${channelId}/variables`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ variables: [], count: 0, maximum: 25 }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
};

const panelSocketPaths = async (page: Page): Promise<string[]> => page.evaluate(() => {
  const sockets = (window as Window & { __realtimePanelSockets?: Array<{ url: string }> }).__realtimePanelSockets ?? [];
  return sockets
    .map(({ url }) => new URL(url, window.location.href).pathname)
    .filter((pathname) => pathname.startsWith("/ws/channels/"));
});

test("keeps one channel socket while navigating between dashboard views", async ({ page }) => {
  await installSocketCounter(page);
  await installApiMocks(page);
  await page.goto(`/channels/${channelId}`);
  await expect(page.getByRole("heading", { name: channel.displayName, level: 1 })).toBeVisible();
  await expect.poll(() => panelSocketPaths(page)).toEqual([`/ws/channels/${channelId}`]);

  await page.locator('a[data-nav-page-id="events"]').click();
  await expect(page).toHaveURL(`/channels/${channelId}/events`);
  await expect(page.getByRole("heading", { name: "Events", level: 1 })).toBeVisible();
  expect(await panelSocketPaths(page)).toEqual([`/ws/channels/${channelId}`]);

  await page.locator('a[data-nav-page-id="variables"]').click();
  await expect(page).toHaveURL(`/channels/${channelId}/variables`);
  await expect(page.getByRole("heading", { name: "Channel variables", level: 1 })).toBeVisible();
  expect(await panelSocketPaths(page)).toEqual([`/ws/channels/${channelId}`]);

  await page.locator(`a[href="/channels/${channelId}/modules/text_commands"]`).click();
  await expect(page).toHaveURL(`/channels/${channelId}/modules/text_commands`);
  await expect(page.locator("h1")).toBeVisible();
  expect(await panelSocketPaths(page)).toEqual([`/ws/channels/${channelId}`]);
});
