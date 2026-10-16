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
  statsUrlError?: boolean;
  settingsWriteError?: boolean;
}

const installMocks = async (page: Page, options: MockOptions = {}): Promise<{
  writes: () => number;
  lastWrite: () => Record<string, unknown> | null;
  statsUrlWrites: () => number;
  testedConnections: () => number;
}> => {
  let writeCount = 0;
  let statsUrlWriteCount = 0;
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
    if (pathname === `/api/channels/${channelId}/modules/belabox/stats-url` && method === "PUT") {
      statsUrlWriteCount += 1;
      if (options.statsUrlError) {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "belabox_stats_url_invalid_host" }) });
      } else {
        await route.fulfill(json({ configured: true }));
      }
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
    statsUrlWrites: () => statsUrlWriteCount,
    testedConnections: () => testedConnectionCount,
  };
};

test("BELABOX settings page stays within the viewport at supported widths", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installMocks(page);
  await page.goto(`/channels/${channelId}/modules/belabox`);
  await expect(page.locator(".module-detail--settings-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "BELABOX", exact: true })).toBeVisible();
  await expect(page.getByText("Verbunden", { exact: true })).toBeVisible();
  await expect(page.locator(".ui-toast")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Alarme", exact: true })).toHaveCount(1);
  await expect(page.getByText("Alarme aktiv", { exact: true })).toHaveCount(1);

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
      const overview = document.querySelector(".settings-page__top");
      const chart = document.querySelector(".belabox-chart");
      if (header === null || columns === null || overview === null || chart === null) throw new Error("The BELABOX settings header, overview, chart, or columns are missing.");
      const headerBox = header.getBoundingClientRect();
      const columnsBox = columns.getBoundingClientRect();
      const overviewBox = overview.getBoundingClientRect();
      const chartBox = chart.getBoundingClientRect();
      const columnBoxes = Array.from(document.querySelectorAll(".settings-page__column"), (column) => column.getBoundingClientRect());
      const connectionRows = Array.from(document.querySelectorAll<HTMLElement>(".belabox-connection-properties > div"), (row) => row.getBoundingClientRect());
      const chartLabels = Array.from(document.querySelectorAll<HTMLElement>(".belabox-chart__axis-label"), (label) => Number.parseFloat(getComputedStyle(label).fontSize));
      const messageLayout = (() => {
        const message = document.querySelector<HTMLElement>(".settings-page__column .ui-settings-editor__message");
        if (message === null) return null;
        const field = message.querySelector<HTMLElement>(".template-text-field");
        const preview = message.querySelector<HTMLElement>(".ui-chat-preview");
        if (field === null || preview === null) return null;
        const fieldBox = field.getBoundingClientRect();
        const previewBox = preview.getBoundingClientRect();
        return { fieldLeft: fieldBox.left, fieldRight: fieldBox.right, fieldTop: fieldBox.top, fieldBottom: fieldBox.bottom,
          previewLeft: previewBox.left, previewTop: previewBox.top, previewBottom: previewBox.bottom,
          textareaFontSize: Number.parseFloat(getComputedStyle(message.querySelector("textarea") as HTMLElement).fontSize) };
      })();
      return {
        headerLeft: headerBox.left,
        columnsLeft: columnsBox.left,
        headerRight: headerBox.right,
        columnsRight: columnsBox.right,
        columnRight: Math.max(...columnBoxes.map((box) => box.right)),
        pageScrollWidth: document.documentElement.scrollWidth,
        settingsColumns: columnBoxes.length,
        overviewTop: overviewBox.top,
        connectionRowGaps: connectionRows.slice(1).map((row, index) => row.top - (connectionRows[index]?.bottom ?? row.top)),
        chartTop: chartBox.top,
        chartBottom: chartBox.bottom,
        chartLabels,
        messageLayout,
        actionPosition: getComputedStyle(document.querySelector(".belabox-connection-actions") as HTMLElement).position,
        statsUrlBottom: document.querySelector("#belabox-stats-url")?.getBoundingClientRect().bottom ?? null,
        urlLabelBottom: document.querySelector("#belabox-stats-url")?.closest(".ui-field")?.querySelector(".ui-field__label")?.getBoundingClientRect().bottom ?? null,
        removeActionTop: document.querySelector(".belabox-connection-actions")?.getBoundingClientRect().top ?? null,
      };
    });
    expect(Math.abs(layout.headerLeft - layout.columnsLeft), `header and columns align at ${String(viewport.width)}px`).toBeLessThanOrEqual(1);
    expect(layout.headerRight, `header stays inside ${String(viewport.width)}px`).toBeLessThanOrEqual(viewport.width + 1);
    expect(layout.columnsRight, `columns stay inside ${String(viewport.width)}px`).toBeLessThanOrEqual(viewport.width + 1);
    expect(layout.columnRight, `settings columns stay inside ${String(viewport.width)}px`).toBeLessThanOrEqual(viewport.width + 1);
    expect(layout.pageScrollWidth, `page has no horizontal scroll at ${String(viewport.width)}px`).toBeLessThanOrEqual(viewport.width);
    expect(layout.settingsColumns, "polling and alerts share two balanced columns").toBe(2);
    expect(layout.chartTop, "the chart follows the connection summary").toBeGreaterThanOrEqual(layout.overviewTop);
    expect(Math.max(0, ...layout.connectionRowGaps), `connection properties keep a compact rhythm at ${String(viewport.width)}px`).toBeLessThanOrEqual(12);
    expect(layout.chartLabels.length, "the chart renders axis labels at CSS pixel size").toBeGreaterThan(0);
    expect(Math.min(...layout.chartLabels), `chart labels stay at least 11 CSS pixels at ${String(viewport.width)}px`).toBeGreaterThanOrEqual(11);
    if (viewport.width >= 1280) expect(layout.chartBottom, `chart is visible without scrolling at ${String(viewport.width)}px`).toBeLessThanOrEqual(viewport.height);
    expect(layout.messageLayout, "BELABOX message editor includes a compact template and preview").not.toBeNull();
    expect(layout.messageLayout?.textareaFontSize).toBeGreaterThanOrEqual(13);
    if (viewport.width > 600) {
      expect(layout.messageLayout?.fieldRight).toBeLessThanOrEqual(layout.messageLayout?.previewLeft ?? Number.NEGATIVE_INFINITY);
      expect(Math.abs((layout.messageLayout?.fieldTop ?? 0) - (layout.messageLayout?.previewTop ?? 0))).toBeLessThanOrEqual(24);
    } else {
      expect(layout.messageLayout?.fieldBottom).toBeLessThanOrEqual(layout.messageLayout?.previewTop ?? Number.NEGATIVE_INFINITY);
    }
    expect(layout.actionPosition).toBe("static");
    expect(layout.statsUrlBottom).not.toBeNull();
    expect(layout.urlLabelBottom).not.toBeNull();
    expect(layout.urlLabelBottom).toBeLessThanOrEqual((layout.statsUrlBottom ?? 0) - 20);
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

test("BELABOX URL replacement is part of the page draft and saves with the page header", async ({ page }) => {
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

  await expect.poll(mocks.statsUrlWrites).toBe(1);
  await expect.poll(mocks.writes).toBe(1);
  await expect(save).toBeDisabled();
  expect(mocks.lastWrite()?.settings).toEqual(expect.objectContaining({ lowBitrateKbps: 1_200 }));
  expect(mocks.lastWrite()?.settings).not.toHaveProperty("belaboxStatsUrl");
});

test("BELABOX URL save failure keeps the page draft dirty", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const mocks = await installMocks(page, { statsUrlError: true });
  await page.goto(`/channels/${channelId}/modules/belabox`);
  const save = page.getByRole("button", { name: "Speichern", exact: true });
  await page.getByLabel("Statistik-URL", { exact: true }).fill("http://relay.belabox.net:8080/new-publisher-key");
  await save.click();

  await expect.poll(mocks.statsUrlWrites).toBe(1);
  await expect(save).toBeEnabled();
  await expect(page.getByText("Die Statistik-URL konnte nicht gespeichert werden.", { exact: true })).toBeVisible();
});

test("BELABOX reports a partial save when the URL succeeds but settings fail", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const mocks = await installMocks(page, { settingsWriteError: true });
  await page.goto(`/channels/${channelId}/modules/belabox`);
  const save = page.getByRole("button", { name: "Speichern", exact: true });
  await page.getByLabel("Statistik-URL", { exact: true }).fill("http://relay.belabox.net:8080/new-publisher-key");
  await page.getByLabel("Niedrige Bitrate", { exact: true }).fill("1300");
  await save.click();

  await expect.poll(mocks.statsUrlWrites).toBe(1);
  await expect.poll(mocks.writes).toBe(1);
  await expect(save).toBeEnabled();
  const partialSaveMessage = "Die Statistik-URL wurde gespeichert, aber die übrigen Einstellungen konnten nicht gespeichert werden.";
  await expect(page.locator(".ui-save-bar__message-copy")).toHaveAttribute("title", `× ${partialSaveMessage}`);
  await expect(page.locator(".ui-toast__message").filter({ hasText: partialSaveMessage })).toHaveCount(1);
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
