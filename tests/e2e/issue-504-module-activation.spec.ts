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
const moduleStates = (pointsEnabled: boolean, slotEnabled: boolean): PanelModuleState[] => [
  moduleState("points", pointsEnabled),
  moduleState("emote_slots", slotEnabled),
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
    setModules: (pointsEnabled: boolean, slotEnabled: boolean) => { modules = moduleStates(pointsEnabled, slotEnabled); },
    setErrorCode: (value: string | null) => { errorCode = value; },
  };
};

test("locks dependency switches in the reserved reasons and captures both required views (protects=managers see why Slot cannot activate without points and why points cannot deactivate while Slot is active, without a layout shift or request; fails_when=either switch is enabled, the reserved reason is absent, a disabled switch sends a request, or any requested screenshot has the wrong viewport; no_claim=behavior for dependency changes committed by another manager)", async ({ page }, testInfo) => {
  const api = await mockDashboard(page, moduleStates(false, false));
  mkdirSync("test-results/issue-504-ui", { recursive: true });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/modules?lang=de`);
    const slotSwitch = page.getByRole("switch", { name: "Slot: Aus" });
    await expect(slotSwitch).toBeDisabled();
    await expect(page.getByText("Benötigt: Punkte")).toBeVisible();
    await slotSwitch.click({ force: true });
    expect(api.toggleRequests).toEqual([]);
    await page.screenshot({
      path: `test-results/issue-504-ui/module-manage-${String(viewport.width)}x${String(viewport.height)}-repeat-${String(testInfo.repeatEachIndex)}.png`,
      fullPage: true,
    });
  }

  api.setModules(true, true);
  await page.goto(`/channels/${channelId}/modules?lang=de`);
  const pointsSwitch = page.getByRole("switch", { name: "Punkte: Läuft" });
  await expect(pointsSwitch).toBeDisabled();
  await expect(page.getByText("Erst ausschalten: Slot")).toBeVisible();
  expect(api.toggleRequests).toEqual([]);

  api.setModules(false, false);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/channels/${channelId}/modules/emote_slots?lang=de`);
    const slotSwitch = page.getByRole("switch", { name: "Slot" });
    await expect(slotSwitch).toBeDisabled();
    await expect(page.getByText("Benötigt: Punkte")).toBeVisible();
    await page.screenshot({
      path: `test-results/issue-504-ui/slot-header-${String(viewport.width)}x${String(viewport.height)}-repeat-${String(testInfo.repeatEachIndex)}.png`,
      fullPage: true,
    });
  }
  expect(api.toggleRequests).toEqual([]);
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
