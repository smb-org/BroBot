import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import type { PanelChannelState, PanelModuleState } from "../../src/panel-contract";
import type { ModuleTempVipRow } from "../../src/modules/contract";
import { channelDateTimeToEpoch } from "../../src/modules/temp_vips/domain/time-zone";
import { waitForWebFonts } from "./web-fonts";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "channel-temp-vips-page";
const nowEpoch = Date.now();
const now = new Date(nowEpoch).toISOString();
const addTime = (durationMs: number): string => new Date(nowEpoch + durationMs).toISOString();
const DAY_MS = 24 * 60 * 60 * 1_000;
const settings = { defaultDurationDays: 7, maximumDurationDays: 90, announceExpiry: false };
const moduleSettings = JSON.stringify(settings);
const initialRows: ModuleTempVipRow[] = [
  {
    userId: "user_pixelpilz",
    login: "pixelpilz",
    displayName: "Pixelpilz",
    expiresAt: addTime(7 * DAY_MS),
    grantedAt: addTime(-2 * 60 * 60 * 1_000),
    grantedByUserId: "user_helper",
    grantedByLogin: "helferhase",
    source: "dashboard" as const,
    classification: "temporary" as const,
    confirmation: "confirmed" as const,
    expiryReminderAt: null,
    removalFailedAt: null,
    removalAttempts: 0,
    removalError: null,
    endReason: null,
  },
  {
    userId: "user_mondfuchs",
    login: "mondfuchs",
    displayName: "Mondfuchs",
    expiresAt: addTime(3 * DAY_MS),
    grantedAt: addTime(-4 * DAY_MS),
    grantedByUserId: "user_helper",
    grantedByLogin: "helferhase",
    source: "import" as const,
    classification: "temporary" as const,
    confirmation: "confirmed" as const,
    expiryReminderAt: null,
    removalFailedAt: addTime(-60 * 60 * 1_000),
    removalAttempts: 1,
    removalError: "network",
    endReason: null,
  },
];
const existingVips = [
  { userId: "user_chipknusper", login: "chipknusper", displayName: "Chipknusper" },
  { userId: "user_flocke", login: "flocke", displayName: "Flocke" },
  { userId: "user_wolkentanz", login: "wolkentanz", displayName: "Wolkentanz" },
];
const modules: PanelModuleState[] = [{ id: "temp_vips", enabled: true, settings: moduleSettings, mandatory: false }];
const timestamp = now;

const channelState = (): PanelChannelState => ({
  channelId,
  login: "beispielkanal",
  displayName: "Beispielkanal",
  language: "de",
  role: "manager",
  location: null,
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: timestamp },
  botPermissions: null,
  broadcasterPermissions: null,
  moderator: { isModerator: true, checkedAt: timestamp, reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "sub-temp-vips-page", reason: null, updatedAt: timestamp },
  streamState: "online",
  streamStartedAt: addTime(-60 * 60 * 1_000),
  modules,
  controls: {
    mute: { active: false, until: null, mode: null },
    pause: { active: false, until: null, mode: null },
  },
  tokens: {
    botExpiresAt: "2099-11-01T12:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-11-01T12:00:00.000Z",
  },
  lastError: null,
});

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

interface DashboardMock {
  grants: Array<Record<string, unknown>>;
  imports: Array<Record<string, unknown>>;
  setImportStatus: (status: string) => void;
  setGrantStatus: (status: string) => void;
  setReleaseStatus: (status: string) => void;
  settingsSaveCount: () => number;
  vipsLoadCount: () => number;
}

const mockDashboard = async (page: Page, options: { missingBroadcasterScopes?: string[] } = {}): Promise<DashboardMock> => {
  let rows: ModuleTempVipRow[] = [...initialRows];
  let importStatus = "imported";
  let grantStatus = "granted";
  let releaseStatus = "released";
  let savedSettings = { ...settings };
  let settingsSaves = 0;
  let vipsLoads = 0;
  const grants: Array<Record<string, unknown>> = [];
  const imports: Array<Record<string, unknown>> = [];
  const channel = channelState();

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/channels") {
      return route.fulfill(json({ channels: [channel], bot: channel.bot, platformAdmin: false, viewerIsBot: false }));
    }
    if (url.pathname === `/api/channels/${channelId}/overview`) {
      return route.fulfill(json({
        ...channel,
        activeModules: [{ moduleId: "temp_vips", settings: moduleSettings }],
        viewerCount: 42,
      }));
    }
    if (url.pathname === `/api/channels/${channelId}/settings`) {
      return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 0, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
    }
    if (url.pathname === `/api/channels/${channelId}/template-variables`) {
      return route.fulfill(json({ variables: [] }));
    }
    if (url.pathname === `/api/channels/${channelId}/events`) {
      return route.fulfill(json({ entries: [], nextCursor: null }));
    }
    if (url.pathname === `/api/channels/${channelId}/overlays`) {
      return route.fulfill(json({ overlays: [], maximum: 20, elementMaximum: 20 }));
    }
    if (url.pathname === `/api/channels/${channelId}/system`) {
      return route.fulfill(json({
        broadcasterConnection: "connected", bot: channel.bot, botPermissions: channel.botPermissions,
        broadcasterPermissions: channel.broadcasterPermissions, chatSubscription: channel.chatSubscription,
        chatSubscriptionNeeded: false, subscriptions: [], tokens: channel.tokens,
      }));
    }
    if (url.pathname === `/api/channels/${channelId}/modules` && method === "GET") {
      return route.fulfill(json({ modules: [{ ...modules[0] as PanelModuleState, settings: JSON.stringify(savedSettings), requiredBroadcasterScopes: [], missingBroadcasterScopes: [], optionalBroadcasterScopes: ["channel:manage:vips"], missingOptionalBroadcasterScopes: options.missingBroadcasterScopes ?? [] }] }));
    }
    if (url.pathname === `/api/channels/${channelId}/modules/temp_vips/settings` && method === "GET") {
      return route.fulfill(json({ settings: savedSettings, revision: settingsSaves + 1, variables: [] }));
    }
    if (url.pathname === `/api/channels/${channelId}/modules/temp_vips/settings` && method === "PATCH") {
      const body = request.postDataJSON() as { settings?: typeof savedSettings };
      if (body.settings !== undefined) savedSettings = body.settings;
      settingsSaves += 1;
      return route.fulfill(json({ settings: savedSettings, revision: settingsSaves + 1, variables: [], warnings: [] }));
    }
    if (url.pathname === `/api/channels/${channelId}/modules/temp_vips` && method === "PATCH") {
      return route.fulfill(json({ error: "temp_vips_active" }, 409));
    }
    if (url.pathname === `/api/channels/${channelId}/modules/temp_vips/vips`) {
      vipsLoads += 1;
      return route.fulfill(json({ rows, settings: savedSettings, timeZone: "Europe/Berlin", mode: (options.missingBroadcasterScopes?.length ?? 0) > 0 ? "observe" : "managed", now }));
    }
    if (url.pathname === `/api/channels/${channelId}/modules/temp_vips/existing-vips`) {
      return route.fulfill(json({ people: existingVips }));
    }
    if (url.pathname === "/api/csrf") return route.fulfill(json({ token: "csrf-temp-vips-page" }));

    const grantPath = `/api/channels/${channelId}/modules/temp_vips/vips/grant`;
    if (url.pathname === grantPath && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      grants.push(body);
      if (grantStatus !== "granted" && grantStatus !== "extended") return route.fulfill(json({ status: grantStatus }));
      const row = {
        ...(initialRows[0] as ModuleTempVipRow),
        userId: `user_${String(body.login)}`,
        login: String(body.login),
        displayName: String(body.login),
        source: "dashboard" as const,
        expiresAt: new Date(Date.now() + Number(body.durationMs)).toISOString(),
        removalFailedAt: null,
        removalAttempts: 0,
        removalError: null,
      };
      rows = [...rows, row];
      if (grantStatus === "extended") row.expiresAt = "2026-11-02T12:00:00.000Z";
      return route.fulfill(json({ status: grantStatus, expiresAt: row.expiresAt, row }));
    }
    const importPath = `/api/channels/${channelId}/modules/temp_vips/vips/import`;
    if (url.pathname === importPath && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      imports.push(body);
      if (importStatus !== "imported") return route.fulfill(json({ status: importStatus }));
      const person = existingVips.find(({ userId }) => userId === body.userId);
      if (person === undefined) return route.fulfill(json({ status: "not_vip" }));
      const importedExpiry = typeof body.expiresAtLocal === "string"
        ? channelDateTimeToEpoch(body.expiresAtLocal, "Europe/Berlin")
        : null;
      const row = {
        ...(initialRows[0] as ModuleTempVipRow),
        ...person,
        expiresAt: importedExpiry === null ? new Date(Date.now() + Number(body.durationMs)).toISOString() : new Date(importedExpiry).toISOString(),
        source: "import" as const,
        removalFailedAt: null,
        removalAttempts: 0,
        removalError: null,
      };
      rows = [...rows, row];
      return route.fulfill(json({ status: "imported", row }));
    }
    if (url.pathname.startsWith(`/api/channels/${channelId}/modules/temp_vips/vips/`) && method === "POST") {
      const path = url.pathname.split("/").at(-1);
      const userId = url.pathname.split("/").at(-2) ?? "";
      if (path === "extend") {
        const row = rows.find((candidate) => candidate.userId === userId);
        return route.fulfill(json({ status: "extended", ...(row === undefined ? {} : { row }) }));
      }
      if (path === "retry") return route.fulfill(json({ status: "queued" }));
      if (path === "end") {
        rows = rows.filter((row) => row.userId !== userId);
        return route.fulfill(json({ status: "ended" }));
      }
      if (path === "release") {
        if (releaseStatus !== "released") return route.fulfill(json({ status: releaseStatus }));
        rows = rows.filter((row) => row.userId !== userId);
        return route.fulfill(json({ status: "released" }));
      }
    }
    return route.fulfill(json({}));
  });

  return {
    grants,
    imports,
    setImportStatus: (status) => { importStatus = status; },
    setGrantStatus: (status) => { grantStatus = status; },
    setReleaseStatus: (status) => { releaseStatus = status; },
    settingsSaveCount: () => settingsSaves,
    vipsLoadCount: () => vipsLoads,
  };
};

test("renders the sorted VIP list and dialogs at the requested widths with review screenshots", async ({ page }, testInfo) => {
  const api = await mockDashboard(page);
  await page.clock.install({ time: new Date(now) });
  const screenshots = [1920, 1280, 390];

  for (const width of screenshots) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    await page.goto(`/channels/${channelId}/modules/temp_vips?lang=de`);
    const rows = page.locator(".temp-vips-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Mondfuchs");
    await expect(rows.nth(0)).toHaveAttribute("data-warning", "true");
    await expect(rows.nth(0).getByRole("button", { name: "Entzug erneut versuchen" })).toBeVisible();
    await expect(rows.nth(1)).toContainText("Pixelpilz");
    await expect(rows.nth(1)).toContainText("Vergeben von: @helferhase");
    await expect(rows.nth(1)).toContainText("Dashboard");
    await expect(rows.nth(1).locator("time")).toHaveAttribute("title", /\d{4}/u);
    await expect(page.getByRole("button", { name: "Chatbefehle", exact: false })).toBeVisible();
    await expect(rows.nth(0)).toContainText("Netzwerkfehler");
    await expect(rows.nth(0)).not.toContainText("network");
    const defaultDuration = page.getByRole("spinbutton", { name: "Standarddauer" });
    if (width === 390) {
      await expect(defaultDuration).toBeHidden();
    } else {
      await expect(defaultDuration).toBeVisible();
      await expect(page.getByText(/Hinweis: Verliert Twitch eine Meldung/u)).toBeVisible();
      const listBox = await page.locator(".temp-vips-page").boundingBox();
      const settingsBox = await defaultDuration.boundingBox();
      expect(listBox).not.toBeNull();
      expect(settingsBox).not.toBeNull();
      expect(settingsBox?.x).toBeGreaterThan((listBox?.x ?? 0) + (listBox?.width ?? 0));
    }
    await waitForWebFonts(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    const screenshot = testInfo.outputPath(`temp-vips-page-${String(width)}.png`);
    mkdirSync(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
  }

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}/modules/temp_vips?lang=de`);
  await page.getByRole("button", { name: "VIP vergeben", exact: true }).click();
  const grantDialog = page.getByRole("dialog", { name: "VIP vergeben" });
  await grantDialog.getByRole("textbox", { name: "Name" }).fill("sternchenwerk");
  await grantDialog.getByRole("spinbutton", { name: "Dauer" }).fill("11");
  expect(await grantDialog.locator(".temp-vips-dialog__error").boundingBox()).not.toBeNull();
  const grantScreenshot = testInfo.outputPath("temp-vips-grant-dialog.png");
  await page.screenshot({ path: grantScreenshot, fullPage: true });
  await grantDialog.getByRole("button", { name: "VIP vergeben", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "@sternchenwerk" })).toBeVisible();
  expect(api.grants).toHaveLength(1);
  expect(api.grants[0]).toMatchObject({ login: "sternchenwerk", durationMs: 11 * 24 * 60 * 60 * 1000 });

  const standardRow = page.locator(".temp-vips-row").filter({ hasText: "@pixelpilz" });
  await standardRow.getByRole("button", { name: "Verlängern" }).click();
  const extendDialog = page.getByRole("dialog", { name: "VIP für Pixelpilz verlängern" });
  await expect(extendDialog.getByRole("spinbutton", { name: "Dauer" })).toHaveValue("7");
  await extendDialog.getByRole("button", { name: "Verlängern", exact: true }).click();
  await expect(extendDialog).toBeHidden();

  await standardRow.getByRole("button", { name: "Jetzt beenden" }).click();
  const confirmation = page.getByRole("dialog", { name: "VIP für Pixelpilz jetzt beenden?" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Jetzt beenden", exact: true }).click();
  await expect(page.locator(".temp-vips-row").filter({ hasText: "@pixelpilz" })).toHaveCount(0);

  const warningRow = page.locator(".temp-vips-row").filter({ hasText: "@mondfuchs" });
  await warningRow.getByRole("button", { name: "Entzug erneut versuchen" }).click();
  await expect(page.locator(".temp-vips-page__feedback")).toContainText(/warteschlange/i);

  await page.getByRole("button", { name: "Vorhandenes VIP übernehmen" }).click();
  const takeoverDialog = page.getByRole("dialog", { name: "Vorhandenes VIP übernehmen" });
  const filter = takeoverDialog.getByRole("textbox", { name: "VIPs filtern" });
  await filter.fill("chip");
  await expect(takeoverDialog.getByRole("option")).toHaveCount(1);
  await expect(takeoverDialog.getByRole("option")).toContainText("@chipknusper");
  await takeoverDialog.getByRole("option", { name: /Chipknusper/u }).click();
  await takeoverDialog.getByRole("button", { name: "Ablaufzeit festlegen" }).click();
  const expiry = takeoverDialog.locator('input[type="datetime-local"]');
  const expiryInput = "2026-12-01T13:00";
  const expiryEpoch = channelDateTimeToEpoch(expiryInput, "Europe/Berlin");
  if (expiryEpoch === null) throw new Error("The generated channel-local expiry time was invalid.");
  await expiry.fill(expiryInput);
  await expect(takeoverDialog.getByText("Datum und Uhrzeit in der Kanalzeitzone Europe/Berlin.", { exact: true })).toBeVisible();
  const takeoverScreenshot = testInfo.outputPath("temp-vips-takeover-dialog.png");
  await page.screenshot({ path: takeoverScreenshot, fullPage: true });
  await takeoverDialog.getByRole("button", { name: "Übernehmen", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "@chipknusper" })).toBeVisible();
  expect(api.imports).toHaveLength(1);
  expect(api.imports[0]?.userId).toBe("user_chipknusper");
  expect(api.imports[0]).toMatchObject({ expiresAtLocal: expiryInput });
  expect(api.imports[0]?.durationMs).toBeUndefined();

  const releasableRow = page.locator(".temp-vips-row").filter({ hasText: "@sternchenwerk" });
  await releasableRow.getByRole("button", { name: "Verwaltung abgeben · VIP behalten" }).click();
  await expect(page.locator(".temp-vips-row").filter({ hasText: "@sternchenwerk" })).toHaveCount(0);
});

for (const tabWidth of [390, 800]) test(`shows VIPs and Settings tabs below 900px (${String(tabWidth)}) and keeps the settings draft`, async ({ page }) => {
  await mockDashboard(page);
  await page.setViewportSize({ width: tabWidth, height: 844 });
  await page.goto(`/channels/${channelId}/modules/temp_vips?lang=de`);
  const vipsTab = page.getByRole("tab", { name: "VIPs", exact: true });
  const settingsTab = page.getByRole("tab", { name: "Einstellungen", exact: true });
  await expect(vipsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".temp-vips-row")).toHaveCount(2);
  const defaultDuration = page.getByRole("spinbutton", { name: "Standarddauer" });
  await expect(defaultDuration).toBeHidden();

  await settingsTab.click();
  await expect(defaultDuration).toBeVisible();
  await expect(page.locator(".temp-vips-row").first()).toBeHidden();
  await defaultDuration.fill("12");
  await vipsTab.click();
  await expect(defaultDuration).toBeHidden();
  await expect(page.locator(".temp-vips-row")).toHaveCount(2);
  await settingsTab.click();
  await expect(defaultDuration).toHaveValue("12");
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeEnabled();

  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(defaultDuration).toBeVisible();
    await expect(page.locator(".temp-vips-row")).toHaveCount(2);
  }
});

test("keeps a fixed error area when Twitch no longer lists a selected VIP", async ({ page }) => {
  const api = await mockDashboard(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/channels/${channelId}/modules/temp_vips?lang=de`);
  api.setImportStatus("not_vip");
  await page.getByRole("button", { name: "Vorhandenes VIP übernehmen" }).click();
  const dialog = page.getByRole("dialog", { name: "Vorhandenes VIP übernehmen" });
  await dialog.getByRole("option", { name: /Flocke/u }).click();
  await dialog.getByRole("spinbutton", { name: "Dauer" }).fill("3");
  const errorSlot = dialog.locator(".temp-vips-dialog__error");
  const initialErrorSlot = await errorSlot.boundingBox();
  await dialog.getByRole("button", { name: "Übernehmen", exact: true }).click();
  await expect(errorSlot).toHaveText("Dieses Konto ist auf Twitch kein VIP mehr. Aktualisiere die Auswahl und wähle ein aktuelles VIP.");
  const populatedErrorSlot = await errorSlot.boundingBox();
  expect(initialErrorSlot?.height).toBe(populatedErrorSlot?.height);
  await expect(dialog).toBeVisible();
});

test("explains why active entries block deactivation and links to the list", async ({ page }) => {
  await mockDashboard(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/channels/${channelId}/modules?lang=de`);
  const toggle = page.getByRole("switch", { name: "Temporäre VIPs: Läuft" });
  await toggle.click();
  await expect(page.getByText("Erst temporäre VIPs beenden oder die Verwaltung abgeben, bevor du das Modul deaktivierst.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "VIP-Liste öffnen" }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${channelId}/modules/temp_vips(?:\\?lang=de)?$`, "u"));
  await expect(page.locator(".temp-vips-page")).toBeVisible();
});

test("offers the Grant VIP cockpit action with the channel default duration", async ({ page }) => {
  const api = await mockDashboard(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}?lang=de`);
  const action = page.locator(".live-cockpit-actions__grid").getByRole("button", { name: "VIP vergeben" });
  await expect(action).toBeVisible();
  await action.click();
  const dialog = page.getByRole("dialog", { name: "VIP vergeben" });
  await expect(dialog.getByRole("spinbutton", { name: "Dauer" })).toHaveValue("7");
  await dialog.getByRole("textbox", { name: "Twitch-Name" }).fill("wolkentanz");
  await dialog.getByRole("spinbutton", { name: "Dauer" }).fill("6");
  await dialog.getByRole("button", { name: "Ausführen", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(api.grants).toHaveLength(1);
  expect(api.grants[0]).toMatchObject({ login: "wolkentanz", durationMs: 6 * 24 * 60 * 60 * 1000 });
});

test("uses saved duration settings in the grant dialog", async ({ page }) => {
  const api = await mockDashboard(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/channels/${channelId}/modules/temp_vips?lang=de`);

  const defaultDuration = page.getByRole("spinbutton", { name: "Standarddauer" });
  await expect(defaultDuration).toHaveValue("7");
  await defaultDuration.fill("12");
  await page.getByRole("spinbutton", { name: "Höchstdauer" }).fill("60");
  await page.getByRole("switch", { name: "Ablauf im Chat melden" }).click();
  const save = page.getByRole("button", { name: "Speichern", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(api.settingsSaveCount).toBe(1);
  await expect.poll(api.vipsLoadCount).toBeGreaterThan(1);

  await page.getByRole("button", { name: "VIP vergeben", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "VIP vergeben" });
  await expect(dialog.getByRole("spinbutton", { name: "Dauer" })).toHaveValue("12");
});

test("reports a queued cockpit grant as pending", async ({ page }) => {
  const api = await mockDashboard(page);
  api.setGrantStatus("queued");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/channels/${channelId}?lang=de`);
  await page.locator(".live-cockpit-actions__grid").getByRole("button", { name: "VIP vergeben" }).click();
  const dialog = page.getByRole("dialog", { name: "VIP vergeben" });
  await dialog.getByRole("textbox", { name: "Twitch-Name" }).fill("wolkentanz");
  await dialog.getByRole("button", { name: "Ausführen", exact: true }).click();
  const action = page.locator(".live-cockpit-actions__grid .live-action").filter({
    has: page.getByRole("button", { name: "VIP vergeben" }),
  });
  await expect(action.locator(".live-action__reason")).toContainText("Die Aktion wartet in der Kanalwarteschlange.");
  expect(api.grants).toHaveLength(1);
});

test("reports a queued release as pending and keeps the VIP entry visible", async ({ page }) => {
  const api = await mockDashboard(page);
  api.setReleaseStatus("queued");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/channels/${channelId}/modules/temp_vips?lang=de`);
  const row = page.locator(".temp-vips-row").filter({ hasText: "@pixelpilz" });
  await row.getByRole("button", { name: "Verwaltung abgeben · VIP behalten" }).click();
  await expect(page.locator(".temp-vips-page__feedback")).toContainText("Die Aktion wartet in der Kanalwarteschlange.");
  await expect(row).toBeVisible();
});

test("keeps the mobile VIP list in place when a row action fails", async ({ page }) => {
  const api = await mockDashboard(page);
  api.setReleaseStatus("rejected");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}/modules/temp_vips?lang=de`);
  const row = page.locator(".temp-vips-row").filter({ hasText: "@pixelpilz" });
  await expect(row).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Standarddauer" })).toBeHidden();
  await waitForWebFonts(page);
  // Offsets relative to the page header: the click may scroll the container, but nothing may move inside it.
  const offsets = async () => page.evaluate(() => {
    const top = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top ?? 0;
    const anchor = top(".temp-vips-page__actions");
    const rowElement = [...document.querySelectorAll(".temp-vips-row")].find((element) => element.textContent.includes("@pixelpilz"));
    return { list: top(".temp-vips-list__rows") - anchor, row: (rowElement?.getBoundingClientRect().top ?? 0) - anchor };
  });
  const before = await offsets();

  await row.getByRole("button", { name: "Verwaltung abgeben · VIP behalten" }).click();
  await expect(page.locator(".temp-vips-page__feedback")).toContainText("Twitch");

  const after = await offsets();
  const listBefore = before.list;
  const rowBefore = before.row;
  const listAfter = after.list;
  const rowAfter = after.row;
  expect(listAfter).toBe(listBefore);
  expect(rowAfter).toBe(rowBefore);
});

test("reports an extended cockpit grant with the new expiry", async ({ page }) => {
  const api = await mockDashboard(page);
  api.setGrantStatus("extended");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}?lang=de`);
  await page.locator(".live-cockpit-actions__grid").getByRole("button", { name: "VIP vergeben" }).click();
  const dialog = page.getByRole("dialog", { name: "VIP vergeben" });
  await dialog.getByRole("textbox", { name: "Twitch-Name" }).fill("pixelpilz");
  await dialog.getByRole("button", { name: "Ausführen", exact: true }).click();
  const action = page.locator(".live-cockpit-actions__grid .live-action").filter({
    has: page.getByRole("button", { name: "VIP vergeben" }),
  });
  await expect(dialog).toBeHidden();
  await expect(action.locator(".live-action__reason")).toContainText("verlängert");
  await expect(action.locator(".live-action__reason")).toContainText("02.11.2026");
  expect(api.grants).toHaveLength(1);
});

test("disables the cockpit grant action when broadcaster VIP permission is missing", async ({ page }) => {
  const api = await mockDashboard(page, { missingBroadcasterScopes: ["channel:manage:vips"] });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}?lang=de`);
  const action = page.locator(".live-cockpit-actions__grid").getByRole("button", { name: "VIP vergeben" });

  await expect(action).toBeDisabled();
  await expect(page.locator(".live-cockpit-actions__grid .live-action__reason")).toContainText("channel:manage:vips");
  expect(api.grants).toHaveLength(0);

  await page.goto(`/channels/${channelId}/modules/temp_vips?lang=de`);
  await expect(page.locator(".temp-vips-mode")).toContainText("Beobachtungsmodus");
  await expect(page.getByRole("button", { name: "VIP per Login ergänzen" })).toBeVisible();
});
