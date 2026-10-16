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

const sampleTimestamp = new Date().toISOString();
const connectedStatus = {
  configured: true,
  updatedAt: sampleTimestamp,
  mode: "interval",
  sample: {
    at: sampleTimestamp,
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
  status?: Omit<typeof connectedStatus, "errorCode" | "sample"> & {
    errorCode: string | null;
    sample: typeof connectedStatus.sample | null;
  };
  settingsWriteError?: boolean;
}

const installMocks = async (page: Page, options: MockOptions = {}): Promise<{
  writes: () => number;
  lastWrite: () => Record<string, unknown> | null;
  testedConnections: () => number;
}> => {
  let writeCount = 0;
  let testedConnectionCount = 0;
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
        if (options.settingsWriteError) {
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "module_settings_save_failed" }) });
        } else {
          await route.fulfill(json({ settings: latestWrite.settings, revision: 2, warnings: [] }));
        }
      } else {
      await route.fulfill(json({ settings: savedSettings, revision: 1, variables: [] }));
      }
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/belabox/status`) {
      await route.fulfill(json(responseStatus));
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/belabox/test` && method === "POST") {
      testedConnectionCount += 1;
      await route.fulfill(json({ ok: true, connected: true, bitrateKbps: 4_200 }));
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
  return {
    writes: () => writeCount,
    lastWrite: () => latestWrite,
    testedConnections: () => testedConnectionCount,
  };
};

test("BELABOX settings scroll in main without inner scrollbars at supported widths", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installMocks(page);
  await page.goto(`/channels/${channelId}/modules/belabox`);
  await expect(page.locator(".module-detail--settings-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "BELABOX", exact: true })).toBeVisible();
  await expect(page.locator(".belabox-overview")).toBeVisible();

  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    const firstField = page.locator('.settings-page__column [data-section="polling"] .inspector-field-row').first();
    await firstField.scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".dashboard-shell__main");
      const pageHeader = document.querySelector<HTMLElement>(".settings-page > .page-header");
      const polling = document.querySelector<HTMLElement>('.settings-page__column [data-section="polling"]');
      const fields = Array.from(polling?.querySelectorAll<HTMLElement>(".inspector-field-row") ?? []);
      const firstLabel = fields[0]?.querySelector<HTMLElement>(".inspector-field-row__label");
      const firstControl = fields[0]?.querySelector<HTMLElement>(".inspector-field-row__control");
      const secondLabel = fields[1]?.querySelector<HTMLElement>(".inspector-field-row__label");
      const secondControl = fields[1]?.querySelector<HTMLElement>(".inspector-field-row__control");
      const connectionActions = document.querySelector<HTMLElement>(".belabox-connection-actions");
      const connectionSection = document.querySelector<HTMLElement>(".belabox-overview .ui-section--inspector");
      const streamsHeading = document.querySelector<HTMLElement>(".belabox-history-section h4");
      const emptyStreams = document.querySelector<HTMLElement>(".belabox-history-section > p[role='status']");
      const streamsText = (() => {
        if (emptyStreams === null) return null;
        const range = document.createRange();
        range.selectNodeContents(emptyStreams);
        const textBox = range.getBoundingClientRect();
        return { top: textBox.top };
      })();
      const rect = (element: HTMLElement | null | undefined) => element == null
        ? null
        : { top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom };
      const innerScrollbars = Array.from(document.querySelectorAll<HTMLElement>(".settings-page *"))
        .filter((element) => !element.matches("textarea, .belabox-stream-history-list, .ui-select__options, .ui-select__dropdown, .ui-template-text-field__suggestions"))
        .filter((element) => {
          const style = getComputedStyle(element);
          return ["auto", "scroll"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
        })
        .map((element) => element.className);
      const mainBox = main?.getBoundingClientRect();
      const headerBox = pageHeader?.getBoundingClientRect();
      return {
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        innerScrollbars,
        mainScrollTop: main?.scrollTop ?? 0,
        mainScrollHeight: main?.scrollHeight ?? 0,
        mainClientHeight: main?.clientHeight ?? 0,
        pageHeaderPosition: pageHeader === null ? "missing" : getComputedStyle(pageHeader).position,
        stickyHeaderOffset: mainBox === undefined || headerBox === undefined ? null : headerBox.top - mainBox.top,
        firstLabel: rect(firstLabel),
        firstControl: rect(firstControl),
        secondLabel: rect(secondLabel),
        secondControl: rect(secondControl),
        connectionActionGap: connectionActions === null || connectionSection === null
          ? null
          : connectionSection.getBoundingClientRect().bottom - connectionActions.getBoundingClientRect().bottom,
        streamTextGap: streamsHeading === null || streamsText === null
          ? null
          : streamsText.top - streamsHeading.getBoundingClientRect().bottom,
      };
    });
    expect(layout.horizontalOverflow, `no horizontal page scroll at ${String(viewport.width)}px`).toBe(false);
    expect(layout.innerScrollbars, `settings have no inner vertical scrollbars at ${String(viewport.width)}px`).toEqual([]);
    expect(layout.pageHeaderPosition).toBe("sticky");
    if (layout.mainScrollTop > 48) {
      expect(layout.stickyHeaderOffset).not.toBeNull();
      expect(Math.abs(layout.stickyHeaderOffset ?? 0), `page header sticks in main at ${String(viewport.width)}px`).toBeLessThanOrEqual(1);
    }
    expect(layout.firstLabel?.bottom).toBeLessThanOrEqual(layout.firstControl?.top ?? Number.NEGATIVE_INFINITY);
    expect((layout.firstControl?.top ?? 0) - (layout.firstLabel?.bottom ?? 0)).toBeLessThanOrEqual(8);
    expect(layout.secondLabel?.bottom).toBeLessThanOrEqual(layout.secondControl?.top ?? Number.NEGATIVE_INFINITY);
    expect(layout.connectionActionGap).not.toBeNull();
    expect(layout.connectionActionGap).toBeLessThanOrEqual(48);
    expect(layout.streamTextGap).not.toBeNull();
    expect(layout.streamTextGap).toBeLessThanOrEqual(16);
    if (viewport.width === 1280) {
      await expect(firstField).toBeInViewport();
      expect(layout.mainScrollHeight).toBeGreaterThan(layout.mainClientHeight);
      expect(layout.mainScrollTop).toBeGreaterThan(0);
      const message = page.locator('.settings-page__column [data-section="alerts"] .ui-settings-editor__message').first();
      await message.scrollIntoViewIfNeeded();
      const stickyOffset = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>(".dashboard-shell__main");
        const header = document.querySelector<HTMLElement>(".settings-page > .page-header");
        if (main === null || header === null) return null;
        return header.getBoundingClientRect().top - main.getBoundingClientRect().top;
      });
      expect(stickyOffset).not.toBeNull();
      expect(Math.abs(stickyOffset ?? 0)).toBeLessThanOrEqual(1);
    }
  }
});

test("BELABOX settings page scrolls its overview and messages together on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page);
  await page.goto(`/channels/${channelId}/modules/belabox`);
  const message = page.locator('.settings-page__column [data-section="alerts"] .ui-settings-editor__message').first();
  await expect(page.locator(".belabox-overview")).toBeVisible();
  await message.scrollIntoViewIfNeeded();
  await expect(message).toBeInViewport({ ratio: 1 });
  const layout = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".dashboard-shell__main");
    const header = document.querySelector<HTMLElement>(".settings-page > .page-header");
    const columns = document.querySelector<HTMLElement>(".settings-page__columns");
    const message = document.querySelector<HTMLElement>('.settings-page__column [data-section="alerts"] .ui-settings-editor__message');
    if (main === null || header === null || columns === null || message === null) throw new Error("The BELABOX narrow settings layout is incomplete.");
    const headerBox = header.getBoundingClientRect();
    const mainBox = main.getBoundingClientRect();
    const columnsBox = columns.getBoundingClientRect();
    const messageBox = message.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(main).overflowY,
      scrollTop: main.scrollTop,
      columnsHeight: columnsBox.height,
      headerTop: headerBox.top,
      mainTop: mainBox.top,
      mainBottom: mainBox.bottom,
      messageTop: messageBox.top,
      messageBottom: messageBox.bottom,
    };
  });
  expect(layout.overflowY).toBe("auto");
  expect(layout.scrollTop).toBeGreaterThan(0);
  expect(layout.columnsHeight).toBeGreaterThan(300);
  expect(Math.abs(layout.headerTop - layout.mainTop)).toBeLessThanOrEqual(1);
  expect(layout.messageBottom).toBeLessThanOrEqual(layout.mainBottom + 1);
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

  const alerts = page.locator(".settings-page__column").nth(1);
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
  await expect(page.getByLabel("Statistik-URL", { exact: true })).toHaveCount(0);
  await expect(page.locator(".belabox-connection-properties")).toContainText("Statistik-URL");
  await expect(page.locator(".belabox-connection-properties")).toContainText("Hinterlegt");
  await expect(page.getByRole("button", { name: "Verbindung testen" })).toBeEnabled();
  await expect(page.getByText("Nur Broadcaster und Verwalter dürfen Module ändern.", { exact: true })).toHaveCount(1);
});

test("BELABOX URL replacement and settings use one revision-checked save", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const mocks = await installMocks(page);
  await page.goto(`/channels/${channelId}/modules/belabox`);

  const urlField = page.getByLabel("Statistik-URL", { exact: true });
  const save = page.getByRole("button", { name: "Speichern", exact: true });
  await expect(save).toBeDisabled();
  await urlField.fill("http://relay.belabox.net:8080/new-publisher-key");
  await page.getByLabel("Niedrige Bitrate", { exact: true }).fill("1200");
  await expect(save).toBeEnabled();
  await expect(page.getByRole("button", { name: "Ersetzen", exact: true })).toHaveCount(0);
  await save.click();

  await expect.poll(mocks.writes).toBe(1);
  await expect(save).toBeDisabled();
  expect(mocks.lastWrite()?.settings).toEqual(expect.objectContaining({ lowBitrateKbps: 1_200 }));
  expect(mocks.lastWrite()?.settings).not.toHaveProperty("belaboxStatsUrl");
  expect(mocks.lastWrite()).toEqual(expect.objectContaining({ statsUrl: "http://relay.belabox.net:8080/new-publisher-key" }));
});

test("BELABOX URL and settings remain dirty when their shared save fails", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const mocks = await installMocks(page, { settingsWriteError: true });
  await page.goto(`/channels/${channelId}/modules/belabox`);
  const save = page.getByRole("button", { name: "Speichern", exact: true });
  const url = "http://relay.belabox.net:8080/new-publisher-key";
  await page.getByLabel("Statistik-URL", { exact: true }).fill(url);
  await save.click();

  await expect.poll(mocks.writes).toBe(1);
  await expect(save).toBeEnabled();
  await expect(page.getByLabel("Statistik-URL", { exact: true })).toHaveValue(url);
  await expect(page.getByText("Die Statistik-URL konnte nicht gespeichert werden.", { exact: true })).toBeVisible();
});

test("BELABOX operator can test the stored connection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const mocks = await installMocks(page, { role: "operator" });
  await page.goto(`/channels/${channelId}/modules/belabox`);
  await page.getByRole("button", { name: "Verbindung testen" }).click();
  await expect.poll(mocks.testedConnections).toBe(1);
  await expect(page.locator(".belabox-test-result")).toContainText("Verbunden");
});

test("BELABOX stale samples are shown as stale when the relay reports an error", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installMocks(page, { status: { ...connectedStatus, sample: null, errorCode: "network" } });
  await page.goto(`/channels/${channelId}/modules/belabox`);
  await expect(page.locator(".belabox-connection-state")).toContainText("Veraltet");
});

test("BELABOX stale samples are shown as stale after their polling window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installMocks(page, { status: { ...connectedStatus, updatedAt: "2026-10-14T18:00:00.000Z", sample: { ...connectedStatus.sample, at: "2026-10-14T18:00:00.000Z" } } });
  await page.goto(`/channels/${channelId}/modules/belabox`);
  await expect(page.locator(".belabox-connection-state")).toContainText("Veraltet");
});

test("BELABOX keeps blank chat templates visible as off", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await installMocks(page, { settings: { chatEnabled: true, lowText: "", disconnectText: "", recoveryText: "" } });
  await page.goto(`/channels/${channelId}/modules/belabox`);

  const alerts = page.locator(".settings-page__column").nth(1);
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
