import { expect, test, type Page } from "@playwright/test";

import { BELABOX_DEFAULT_SETTINGS } from "../../src/modules/belabox/contracts";

test.use({ locale: "de-DE" });

const channelId = "kanal-belabox-page";
const channel = {
  channelId,
  login: "brotkrumen-kanal",
  displayName: "Brotkrumen-Kanal",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-10-15T18:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-10-15T18:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "abo-belabox-page", reason: null, updatedAt: "2026-10-15T18:00:00.000Z" },
  tokens: {
    botExpiresAt: "2099-10-15T18:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-10-15T18:00:00.000Z",
  },
  lastError: null,
};

const moduleSettings = {
  ...BELABOX_DEFAULT_SETTINGS,
  alertsEnabled: true,
  lowBitrateKbps: 1_000,
  recoverBitrateKbps: 2_000,
  chatEnabled: true,
  lowText: "Eigener Bitratentext {belabox.bitrate}",
  disconnectText: "Eigener Verbindungstext",
  recoveryText: "Eigener Entwarnungstext",
};

const connectedStatus = {
  configured: true,
  updatedAt: "2026-10-15T18:00:00.000Z",
  mode: "interval",
  sample: {
    at: "2026-10-15T18:00:00.000Z",
    connected: true,
    bitrateKbps: 4_200,
    rttMs: 42,
    latencyMs: 108,
    network: 2,
    droppedPackets: 0,
  },
  errorCode: null,
  polling: true,
  pollingDesired: true,
  intervalSeconds: 15,
  streamId: "stream-belabox-page",
  belaboxStreamId: "stream-belabox-page",
  alertNotice: null,
  fetchFailureNotice: false,
};

interface MockOptions {
  role?: "manager" | "operator";
  settings?: Partial<typeof moduleSettings>;
  status?: typeof connectedStatus;
}

const installMocks = async (page: Page, options: MockOptions = {}): Promise<{ writes: () => number; lastWrite: () => Record<string, unknown> | null }> => {
  let writeCount = 0;
  let latestWrite: Record<string, unknown> | null = null;
  const channelState = { ...channel, role: options.role ?? channel.role };
  const savedSettings = { ...moduleSettings, ...options.settings };
  const responseStatus = options.status ?? connectedStatus;
  const modules = [{ id: "belabox", enabled: true, settings: JSON.stringify(savedSettings) }];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const json = (value: unknown): Parameters<typeof route.fulfill>[0] => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
    if (pathname === "/api/channels") {
      await route.fulfill(json({ channels: [channelState], bot: channelState.bot, platformAdmin: false }));
      return;
    }
    if (pathname === "/api/csrf") {
      await route.fulfill(json({ token: "test-csrf-token" }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill(json({ ...channelState, activeModules: [{ moduleId: "belabox", settings: JSON.stringify(savedSettings) }] }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/settings`) {
      await route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill(json({ modules }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/belabox/settings`) {
      if (method === "PATCH") {
        writeCount += 1;
        latestWrite = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill(json({ settings: latestWrite.settings, revision: 2, warnings: [] }));
      } else {
      await route.fulfill(json({ settings: savedSettings, revision: 1, variables: [] }));
      }
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/belabox/status`) {
      await route.fulfill(json(responseStatus));
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/belabox/history`) {
      await route.fulfill(json([]));
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/belabox/streams`) {
      await route.fulfill(json([]));
      return;
    }
    if (pathname === `/api/channels/${channelId}/template-variables`) {
      await route.fulfill(json({ variables: [] }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/revisions`) {
      await route.fulfill(json({ revisions: {} }));
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  return { writes: () => writeCount, lastWrite: () => latestWrite };
};

test("BELABOX settings page stays within the viewport at supported widths", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installMocks(page);
  await page.goto(`/channels/${channelId}/modules/belabox`);
  await expect(page.locator(".module-detail--settings-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "BELABOX", exact: true })).toBeVisible();
  await expect(page.getByText("Verbunden", { exact: true })).toBeVisible();
  await expect(page.locator(".ui-toast")).toHaveCount(0);

  for (const viewport of [
    { width: 1_920, height: 1_080 },
    { width: 1_280, height: 800 },
    { width: 390, height: 844 },
    { width: 2_560, height: 1_440 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const header = document.querySelector(".settings-page > .page-header");
      const columns = document.querySelector(".settings-page__columns");
      if (header === null || columns === null) throw new Error("The BELABOX settings header or columns are missing.");
      const headerBox = header.getBoundingClientRect();
      const columnsBox = columns.getBoundingClientRect();
      const columnBoxes = Array.from(document.querySelectorAll(".settings-page__column"), (column) => column.getBoundingClientRect());
      return {
        headerLeft: headerBox.left,
        columnsLeft: columnsBox.left,
        headerRight: headerBox.right,
        columnsRight: columnsBox.right,
        columnRight: Math.max(...columnBoxes.map((box) => box.right)),
        pageScrollWidth: document.documentElement.scrollWidth,
        actionPosition: getComputedStyle(document.querySelector(".belabox-panel .inspector-actions") as HTMLElement).position,
        statsUrlBottom: document.querySelector("#belabox-stats-url")?.getBoundingClientRect().bottom ?? null,
        removeActionTop: document.querySelector(".belabox-panel .inspector-actions")?.getBoundingClientRect().top ?? null,
      };
    });
    expect(Math.abs(layout.headerLeft - layout.columnsLeft), `header and columns align at ${String(viewport.width)}px`).toBeLessThanOrEqual(1);
    expect(layout.headerRight, `header stays inside ${String(viewport.width)}px`).toBeLessThanOrEqual(viewport.width + 1);
    expect(layout.columnsRight, `columns stay inside ${String(viewport.width)}px`).toBeLessThanOrEqual(viewport.width + 1);
    expect(layout.columnRight, `settings columns stay inside ${String(viewport.width)}px`).toBeLessThanOrEqual(viewport.width + 1);
    expect(layout.pageScrollWidth, `page has no horizontal scroll at ${String(viewport.width)}px`).toBeLessThanOrEqual(viewport.width);
    expect(layout.actionPosition).toBe("static");
    expect(layout.statsUrlBottom).not.toBeNull();
    expect(layout.removeActionTop).not.toBeNull();
    expect(layout.removeActionTop).toBeGreaterThanOrEqual(layout.statsUrlBottom ?? Number.POSITIVE_INFINITY);
  }
});

test("BELABOX reports a disconnected encoder in the connection state", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await installMocks(page, { status: { ...connectedStatus, sample: { ...connectedStatus.sample, connected: false } } });
  await page.goto(`/channels/${channelId}/modules/belabox`);
  await expect(page.locator(".belabox-connection-state")).toContainText("Getrennt");
});

test("BELABOX operator view shows all nested alert and chat settings as read-only", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await installMocks(page, { role: "operator", settings: { chatEnabled: true } });
  await page.goto(`/channels/${channelId}/modules/belabox`);

  const alerts = page.locator(".settings-page__column").nth(2);
  await expect(alerts).toContainText("Chat-Abkühlzeit");
  await expect(alerts).toContainText("300 s");
  await expect(alerts).toContainText("Bitratentext");
  await expect(alerts).toContainText("Eigener Bitratentext");
  await expect(alerts).toContainText("Ziel der Bitratemeldung");
  await expect(alerts).toContainText("Nur unser Chat");
  await expect(alerts).toContainText("Verbindungstext");
  await expect(alerts).toContainText("Eigener Verbindungstext");
  await expect(alerts).toContainText("Ziel der Verbindungsmeldung");
  await expect(alerts).toContainText("Entwarnungstext");
  await expect(alerts).toContainText("Eigener Entwarnungstext");
  await expect(alerts).toContainText("Ziel der Entwarnung");
  await expect(alerts.locator("input, textarea, button")).toHaveCount(0);
  await expect(page.getByText("Nur Broadcaster und Verwalter dürfen Module ändern.", { exact: true })).toHaveCount(1);
});

test("BELABOX keeps blank chat templates visible as off", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await installMocks(page, { settings: { chatEnabled: true, lowText: "", disconnectText: "", recoveryText: "" } });
  await page.goto(`/channels/${channelId}/modules/belabox`);

  const alerts = page.locator(".settings-page__column").nth(2);
  const messages = alerts.locator(".ui-settings-editor__message");
  await expect(messages).toHaveCount(3);
  expect(await messages.evaluateAll((nodes) => nodes.every((node) => node.getAttribute("data-enabled") === "false"))).toBe(true);
  await expect(messages.nth(0)).toContainText("Aus");
  await expect(alerts).toContainText("Chat-Abkühlzeit");
});

test("BELABOX chart follows the unsaved threshold draft and saves only on request", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  const writes = await installMocks(page);
  await page.goto(`/channels/${channelId}/modules/belabox`);
  const history = page.getByRole("region", { name: "Bitrate-Verlauf" });
  await expect(history).toContainText("Niedrige Schwelle: 1.000 kbps");

  await page.getByRole("spinbutton", { name: "Niedrige Bitrate" }).fill("650");
  await expect(history).toContainText("Niedrige Schwelle: 650 kbps");
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeEnabled();
  await page.waitForTimeout(300);
  expect(writes.writes()).toBe(0);

  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect.poll(writes.writes).toBe(1);
  expect(writes.lastWrite()?.settings).toMatchObject({ lowBitrateKbps: 650 });
});
