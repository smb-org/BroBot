import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_EMOTE_SLOT_SETTINGS } from "../../src/modules/emote_slots/contracts";
import type { PanelChannelState, PanelModuleState } from "../../src/panel-contract";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "channel-issue-504";
const timestamp = new Date().toISOString();
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const moduleState = (id: string, enabled: boolean): PanelModuleState => ({ id, enabled, settings: "{}", mandatory: false });
const moduleStates = (pointsEnabled: boolean, slotEnabled: boolean, blitzEnabled = false): PanelModuleState[] => [
  moduleState("points", pointsEnabled),
  moduleState("emote_slots", slotEnabled),
  moduleState("blitz_round", blitzEnabled),
];

const channelState = (modules: PanelModuleState[]): PanelChannelState => ({
  channelId,
  login: "issue-channel",
  displayName: "Issue Channel",
  language: "de",
  role: "manager",
  location: null,
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: timestamp },
  botPermissions: null,
  broadcasterPermissions: null,
  moderator: { isModerator: true, checkedAt: timestamp, reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "issue-subscription", reason: null, updatedAt: timestamp },
  streamState: "offline",
  streamStartedAt: null,
  modules,
  controls: {
    mute: { active: false, until: null, mode: null },
    pause: { active: false, until: null, mode: null },
  },
  tokens: {
    botExpiresAt: "2099-10-19T09:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-10-19T09:00:00.000Z",
  },
  lastError: null,
});

const mockDashboard = async (page: Page, initialModules: PanelModuleState[], initialError: string | null = null) => {
  let modules = initialModules;
  let errorCode = initialError;
  const toggleRequests: string[] = [];
  const currentChannel = (): PanelChannelState => channelState(modules);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();

    if (pathname === "/api/channels") {
      return route.fulfill(json({ channels: [currentChannel()], bot: currentChannel().bot, platformAdmin: false, viewerIsBot: false }));
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      return route.fulfill(json({
        ...currentChannel(),
        activeModules: modules.filter((module) => module.enabled).map(({ id, settings }) => ({ moduleId: id, settings })),
      }));
    }
    if (pathname === `/api/channels/${channelId}/modules` && method === "GET") {
      return route.fulfill(json({ modules }));
    }
    if (pathname === `/api/channels/${channelId}/modules/points/summary`) {
      return route.fulfill(json({ jackpots: {} }));
    }
    if (pathname === `/api/channels/${channelId}/modules/emote_slots/settings` && method === "GET") {
      return route.fulfill(json({ settings: DEFAULT_EMOTE_SLOT_SETTINGS, revision: 1, variables: [] }));
    }
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "issue-504-csrf" }));

    const togglePath = pathname.match(new RegExp(`^/api/channels/${channelId}/modules/([^/]+)$`, "u"));
    if (togglePath !== null && method === "PATCH") {
      const moduleId = togglePath[1] ?? "";
      toggleRequests.push(moduleId);
      if (errorCode !== null) {
        return route.fulfill(json({
          error: errorCode,
          ...(errorCode === "module_required_by" ? { dependentModules: ["emote_slots"] } : {}),
        }, 409));
      }
      const body = request.postDataJSON() as { enabled?: unknown };
      if (typeof body.enabled === "boolean") {
        modules = modules.map((module) => module.id === moduleId ? { ...module, enabled: body.enabled as boolean } : module);
      }
      return route.fulfill(json({ module: modules.find(({ id }) => id === moduleId), revision: 2 }));
    }
    return route.fulfill(json({}));
  });

  return {
    toggleRequests,
    setModules: (pointsEnabled: boolean, slotEnabled: boolean, blitzEnabled = false) => { modules = moduleStates(pointsEnabled, slotEnabled, blitzEnabled); },
    setErrorCode: (value: string | null) => { errorCode = value; },
  };
};

const moduleRowGeometry = async (page: Page): Promise<Array<{ href: string; top: number; height: number }>> => page
  .locator(".module-workspace__group .list-row")
  .evaluateAll((rows) => rows.map((row) => {
    const link = row.querySelector("a[href]");
    const rect = row.getBoundingClientRect();
    let ancestor = row.parentElement;
    let nestedScrollTop = 0;
    while (ancestor !== null && ancestor !== document.body && ancestor !== document.documentElement) {
      nestedScrollTop += ancestor.scrollTop;
      ancestor = ancestor.parentElement;
    }
    return {
      href: link?.getAttribute("href") ?? "",
      top: Math.round((rect.top + window.scrollY + nestedScrollTop) * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  }));

const moduleWorkspaceRow = (page: Page, moduleId: string) => page
  .locator(".module-workspace__group .list-row")
  .filter({ has: page.locator(`a[href$="/modules/${moduleId}"]`) });

const pointsHeaderGeometry = async (page: Page): Promise<{ top: number; height: number; contentTop: number }> => page
  .locator(".module-detail--points")
  .evaluate((section) => {
    const header = section.querySelector(":scope > .module-detail-heading");
    const content = header?.nextElementSibling;
    if (header === null || content === null || content === undefined) throw new Error("Points module header or content is missing.");
    const headerRect = header.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      top: Math.round((headerRect.top + window.scrollY) * 100) / 100,
      height: Math.round(headerRect.height * 100) / 100,
      contentTop: Math.round((contentRect.top + window.scrollY) * 100) / 100,
    };
  });

const slotHeaderGeometry = async (page: Page): Promise<{ top: number; height: number; contentTop: number }> => {
  const [header, content] = await Promise.all([
    page.locator(".settings-page--slot > .page-header").boundingBox(),
    page.locator(".settings-page--slot > .settings-page__columns").boundingBox(),
  ]);
  if (header === null || content === null) throw new Error("Slot settings header or content is missing.");
  return {
    top: Math.round(header.y * 100) / 100,
    height: Math.round(header.height * 100) / 100,
    contentTop: Math.round(content.y * 100) / 100,
  };
};

test("locks dependency switches in the reserved reasons and captures both required views (protects=managers see why Slot cannot activate without points and the combined Points lock while Slot and Blitz are active, without a layout shift or request; fails_when=either switch is enabled, the reserved reason is absent, a disabled switch sends a request, or any requested screenshot has the wrong viewport; no_claim=behavior for dependency changes committed by another manager)", async ({ page }, testInfo) => {
  const api = await mockDashboard(page, moduleStates(false, false));
  mkdirSync("test-results/issue-504-ui", { recursive: true });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/modules?lang=de`);
    const slotSwitch = page.getByRole("switch", { name: "Slot: Aus" });
    await expect(slotSwitch).toBeDisabled();
    await expect(moduleWorkspaceRow(page, "emote_slots").getByText("Benötigt: Punkte", { exact: true })).toBeVisible();
    await slotSwitch.click({ force: true });
    expect(api.toggleRequests).toEqual([]);
    await page.screenshot({
      path: `test-results/issue-504-ui/module-manage-${String(viewport.width)}x${String(viewport.height)}-repeat-${String(testInfo.repeatEachIndex)}.png`,
      fullPage: true,
    });
  }

  api.setModules(true, true, true);
  await page.goto(`/channels/${channelId}/modules?lang=de`);
  const pointsSwitch = page.getByRole("switch", { name: "Punkte: Läuft" });
  await expect(pointsSwitch).toBeDisabled();
  await expect(moduleWorkspaceRow(page, "points").getByText("Erst ausschalten: Slot, Blitzrunde", { exact: true })).toBeVisible();
  expect(api.toggleRequests).toEqual([]);

  api.setModules(false, false);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/modules/emote_slots?lang=de`);
    const slotSwitch = page.getByRole("switch", { name: "Slot" });
    await expect(slotSwitch).toBeDisabled();
    await expect(page.locator(".settings-page--slot > .page-header").getByText("Benötigt: Punkte", { exact: true })).toBeVisible();
    await page.screenshot({
      path: `test-results/issue-504-ui/slot-header-${String(viewport.width)}x${String(viewport.height)}-repeat-${String(testInfo.repeatEachIndex)}.png`,
      fullPage: true,
    });
  }
  expect(api.toggleRequests).toEqual([]);
});

test("keeps module rows and following row tops stable while Points and Slot toggle (protects=dependency participants reserve their reason line while unrelated module rows keep their existing height at 1440 and 1920; fails_when=any module row top or height changes as Points or Slot toggles, or a dependency-disabled switch sends a request; no_claim=layout at viewport widths other than 1440 and 1920)", async ({ page }) => {
  const api = await mockDashboard(page, moduleStates(false, false));

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    api.setModules(false, false);
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/modules?lang=de`);
    const slotSwitch = page.getByRole("switch", { name: "Slot: Aus" });
    await expect(slotSwitch).toBeDisabled();
    const initialGeometry = await moduleRowGeometry(page);
    expect(initialGeometry.some(({ href }) => href.endsWith("/text_commands"))).toBe(true);

    const requestsBeforeBlockedAttempt = [...api.toggleRequests];
    await slotSwitch.click({ force: true });
    expect(api.toggleRequests).toEqual(requestsBeforeBlockedAttempt);
    expect(await moduleRowGeometry(page)).toEqual(initialGeometry);

    await page.getByRole("switch", { name: "Punkte: Aus" }).click();
    await expect(page.getByRole("switch", { name: "Punkte: Läuft" })).toBeChecked();
    await expect(slotSwitch).toBeEnabled();
    expect(await moduleRowGeometry(page)).toEqual(initialGeometry);

    await slotSwitch.click();
    await expect(page.getByRole("switch", { name: "Slot: Läuft" })).toBeChecked();
    await expect(page.getByText("Erst ausschalten: Slot", { exact: true })).toBeVisible();
    expect(await moduleRowGeometry(page)).toEqual(initialGeometry);

    await page.getByRole("switch", { name: "Slot: Läuft" }).click();
    await expect(page.getByRole("switch", { name: "Slot: Aus" })).not.toBeChecked();
    expect(await moduleRowGeometry(page)).toEqual(initialGeometry);

    await page.getByRole("switch", { name: "Punkte: Läuft" }).click();
    await expect(page.getByRole("switch", { name: "Punkte: Aus" })).not.toBeChecked();
    expect(await moduleRowGeometry(page)).toEqual(initialGeometry);
  }

  await expect.poll(() => api.toggleRequests).toEqual([
    "points", "emote_slots", "emote_slots", "points",
    "points", "emote_slots", "emote_slots", "points",
  ]);
});

test("keeps the Points page header and following content in place across Slot state changes (protects=the dependency header reason keeps its line at 1440 and 1920 while Slot is enabled or disabled; fails_when=the module header height or following content top changes between locked and unlocked states; no_claim=other module headers or viewport sizes)", async ({ page }) => {
  const api = await mockDashboard(page, moduleStates(true, true));

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    api.setModules(true, true);
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/modules/points?lang=de`);
    await expect(page.getByText("Erst ausschalten: Slot", { exact: true })).toBeVisible();
    const dependentGeometry = await pointsHeaderGeometry(page);

    api.setModules(true, false);
    await page.goto(`/channels/${channelId}/modules/points?lang=de`);
    await expect(page.getByText("Erst ausschalten: Slot", { exact: true })).toHaveCount(0);
    expect(await pointsHeaderGeometry(page)).toEqual(dependentGeometry);
  }
});

test("keeps the Slot header stable while Points toggles at narrow and desktop widths (protects=Slot jackpot metadata and dependency reason keep the metadata, header, and following content at the same height at 390, 768, 1440, and 1920 pixels; fails_when=any of those positions shifts as Points toggles; no_claim=Slot header behavior at untested widths or when the Slot module itself toggles)", async ({ page }) => {
  const api = await mockDashboard(page, moduleStates(false, false));

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    api.setModules(false, false);
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/modules/emote_slots?lang=de`);
    await expect(page.locator(".settings-page--slot > .page-header").getByText("Benötigt: Punkte", { exact: true })).toBeVisible();
    await expect(page.locator(".slot-jackpot-meta")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Walzen", exact: true })).toBeVisible();
    const lockedGeometry = await slotHeaderGeometry(page);

    await page.goto(`/channels/${channelId}/modules?lang=de`);
    await page.getByRole("switch", { name: "Punkte: Aus" }).click();
    await expect(page.getByRole("switch", { name: "Punkte: Läuft" })).toBeChecked();
    await page.goto(`/channels/${channelId}/modules/emote_slots?lang=de`);
    await expect(page.getByText("Benötigt: Punkte", { exact: true })).toHaveCount(0);
    await expect(page.locator(".slot-jackpot-meta")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Walzen", exact: true })).toBeVisible();
    expect(await slotHeaderGeometry(page)).toEqual(lockedGeometry);
  }

  expect(api.toggleRequests).toEqual(["points", "points", "points", "points"]);
});

test("keeps the Emote Slots title on one line at 1100px without growing its header", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await mockDashboard(page, moduleStates(true, true));
  const readHeader = async () => page.locator(".settings-page--slot > .page-header").evaluate((header) => {
    const title = header.querySelector<HTMLElement>(".page-header__title-row :is(h1, h2, h3)");
    const switchControl = header.querySelector<HTMLElement>(".page-header__module-switch");
    if (title === null || switchControl === null) throw new Error("Emote Slots settings header is incomplete.");
    const titleBox = title.getBoundingClientRect();
    const switchBox = switchControl.getBoundingClientRect();
    return {
      height: Math.round(header.getBoundingClientRect().height),
      titleText: title.textContent.trim(),
      titleHeight: Math.round(titleBox.height),
      titleLineHeight: Number.parseFloat(getComputedStyle(title).lineHeight),
      switchCenter: Math.round(switchBox.y + switchBox.height / 2),
      titleCenter: Math.round(titleBox.y + titleBox.height / 2),
    };
  });

  await page.goto(`/channels/${channelId}/modules/emote_slots?lang=en`);
  await expect(page.locator(".settings-page--slot > .page-header")).toBeVisible();
  await expect.poll(async () => {
    const header = await readHeader();
    return header.height > 0 && Number.isFinite(header.titleLineHeight);
  }).toBe(true);
  const compact = await readHeader();

  expect(compact.titleText).toBe("Slot");
  expect(compact.titleHeight).toBeLessThanOrEqual(compact.titleLineHeight * 1.25);
  expect(compact.height).toBe(123);
  expect(Math.abs(compact.switchCenter - compact.titleCenter)).toBeLessThanOrEqual(4);
});

test("shows the missing requirement when another manager disables points first (protects=the module_requires race response gives a localized dependency toast instead of a generic API failure; fails_when=the toast shows the generic change failure or no requirement name; no_claim=the other manager's current module state)", async ({ page }) => {
  const api = await mockDashboard(page, moduleStates(true, false), "module_requires");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${channelId}/modules?lang=de`);

  await page.getByRole("switch", { name: "Slot: Aus" }).click();
  await expect(page.getByText("Benötigt: Punkte", { exact: true })).toBeVisible();
  await expect(page.getByText("Die Änderung ist fehlgeschlagen.")).toHaveCount(0);
  expect(api.toggleRequests).toEqual(["emote_slots"]);
});

test("shows active dependents when another manager enables Slot first (protects=the module_required_by race response identifies the active dependent in a localized toast; fails_when=the toast is generic or does not name Slot; no_claim=the concurrent database commit order)", async ({ page }) => {
  const api = await mockDashboard(page, moduleStates(true, false), "module_required_by");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/channels/${channelId}/modules?lang=de`);

  await page.getByRole("switch", { name: "Punkte: Läuft" }).click();
  await expect(page.getByText("Erst ausschalten: Slot", { exact: true })).toBeVisible();
  await expect(page.getByText("Die Änderung ist fehlgeschlagen.")).toHaveCount(0);
  expect(api.toggleRequests).toEqual(["points"]);
});

test.describe("English dashboard locale", () => {
  test.use({ locale: "en-US" });

  test("localizes the module dependency race message (protects=English dashboard users receive the requirement name for module_requires; fails_when=the toast is missing, German, or generic; no_claim=the concurrent manager's committed state)", async ({ page }) => {
    const api = await mockDashboard(page, moduleStates(true, false), "module_requires");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/channels/${channelId}/modules`);

    await page.getByRole("switch", { name: "Slot: Off" }).click();
    await expect(page.getByText("Requires: Points", { exact: true })).toBeVisible();
    await expect(page.getByText("The change failed.")).toHaveCount(0);
    expect(api.toggleRequests).toEqual(["emote_slots"]);
  });
});
