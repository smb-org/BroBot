import { expect, test, type Page, type Route } from "@playwright/test";

import type { ChannelRole } from "../../src/contracts/values";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "kanal-438-regression";
const otherChannelId = "kanal-438-zweiter";
const moduleIds = ["host", "text_commands", "text_library", "timers", "faq", "chat_voting", "clips", "weather", "currency", "api_source", "channel_events", "votekick", "raid", "ads"] as const;
const initialModules = moduleIds.map((id) => ({ id, enabled: id !== "faq", settings: "{}" }));
const members = [
  { userId: "viewer-438", login: "mira_fox", displayName: "Mira Fox", profileImageUrl: null, role: "manager", joinedAt: "2025-08-13T10:00:00.000Z" },
  { userId: "operator-438", login: "otto_owl", displayName: "Otto Owl", profileImageUrl: null, role: "operator", joinedAt: "2026-03-04T09:30:00.000Z" },
  { userId: "owner-438", login: "demo-kanal", displayName: "Demo Kanal", profileImageUrl: null, role: "broadcaster", joinedAt: "2024-01-10T14:15:00.000Z" },
  { userId: "owner-two-438", login: "second_owner", displayName: "Second Broadcaster", profileImageUrl: null, role: "broadcaster", joinedAt: "2024-02-10T14:15:00.000Z" },
] as const;
const inviteUser = { userId: "invitee-438", login: "lena_luchs", displayName: "Lena Luchs", profileImageUrl: null };
const viewports = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;
type Issue438MockOptions = { settingsLoading?: boolean; role?: ChannelRole; systemError?: boolean; membersError?: boolean };
const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

interface MockControls {
  patchRequests: Array<{ channelId: string; moduleId: string; body: { enabled?: unknown; expectedRevision?: unknown } }>;
  failNextPatch: () => void;
  settingsStarted: Promise<void>;
  releaseSettings: () => void;
}

const installIssue438Mocks = async (page: Page, options: Issue438MockOptions = {}): Promise<MockControls> => {
  const role = options.role ?? "manager";
  const patchRequests: MockControls["patchRequests"] = [];
  const moduleState = new Map<string, Array<{ id: string; enabled: boolean; settings: string }>>([
    [channelId, initialModules.map((module) => ({ ...module }))],
    [otherChannelId, initialModules.map((module) => ({ ...module }))],
  ]);
  const moduleRevision = new Map<string, number>();
  for (const id of [channelId, otherChannelId]) for (const module of initialModules) moduleRevision.set(`${id}:${module.id}`, 1);
  let nextPatchFails = false;
  let releaseSettings = (): void => undefined;
  let markSettingsStarted = (): void => undefined;
  const settingsStarted = new Promise<void>((resolve) => { markSettingsStarted = resolve; });
  const settingsGate = options.settingsLoading ? new Promise<void>((resolve) => { releaseSettings = resolve; }) : Promise.resolve();

  await installLiveCockpitMocks(page, { channelId, role, modules: initialModules });
  await page.route("**/api/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const matchedChannelId = path.match(/^\/api\/channels\/([^/]+)/u)?.[1];
    const currentModules = matchedChannelId === undefined ? [] : moduleState.get(matchedChannelId) ?? [];
    const bot = { status: "connected", reason: null, updatedAt: "2026-10-16T08:00:00.000Z" };
    const channel = (id: string) => ({
      channelId: id,
      login: id === channelId ? "demo-kanal" : "zweiter-kanal",
      displayName: id === channelId ? "Demo Kanal" : "Zweiter Kanal",
      language: "de",
      role,
      streamState: "online",
      streamStartedAt: "2026-10-16T07:59:00.000Z",
      viewerCount: 42,
      location: null,
      broadcasterConnection: "connected",
      channelBotConsent: "granted",
      bot,
      botPermissions: { missingScopes: [] },
      broadcasterPermissions: { missingScopes: [] },
      moderator: { isModerator: true, checkedAt: "2026-10-16T08:00:00.000Z", reason: null },
      chatSubscription: { status: "enabled", subscriptionId: "sub-438", reason: null, updatedAt: "2026-10-16T08:00:00.000Z" },
      chatSubscriptionNeeded: false,
      modules: moduleState.get(id) ?? [],
      tokens: { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" },
      lastError: null,
    });

    if (path === "/api/channels" && method === "GET") return route.fulfill(json({ channels: [channel(channelId), channel(otherChannelId)], bot, viewerUserId: "viewer-438" }));
    if (path === "/api/csrf") return route.fulfill(json({ token: "csrf-438" }));
    if (matchedChannelId !== undefined && path === `/api/channels/${matchedChannelId}/overview`) {
      const state = channel(matchedChannelId);
      return route.fulfill(json({ ...state, activeModules: currentModules.filter((module) => module.enabled).map(({ id, settings }) => ({ moduleId: id, settings })) }));
    }
    if (matchedChannelId !== undefined && path === `/api/channels/${matchedChannelId}/modules` && method === "GET") return route.fulfill(json({ modules: currentModules }));
    if (matchedChannelId !== undefined && /^\/api\/channels\/[^/]+\/modules\/[^/]+\/settings$/u.test(path) && method === "GET") {
      return route.fulfill(json({ settings: {}, revision: 1, variables: [] }));
    }
    if (matchedChannelId !== undefined && path.startsWith(`/api/channels/${matchedChannelId}/modules/`) && method === "PATCH") {
      const moduleId = path.split("/").at(-1) ?? "";
      const body = route.request().postDataJSON() as { enabled?: unknown; expectedRevision?: unknown };
      patchRequests.push({ channelId: matchedChannelId, moduleId, body });
      if (nextPatchFails) {
        nextPatchFails = false;
        return route.fulfill(json({ error: "module_toggle_failed" }, 503));
      }
      const key = `${matchedChannelId}:${moduleId}`;
      const currentRevision = moduleRevision.get(key) ?? 0;
      if (typeof body.expectedRevision === "number" && body.expectedRevision !== currentRevision) {
        return route.fulfill(json({ error: "module_changed_concurrently" }, 409));
      }
      const revision = currentRevision + 1;
      moduleRevision.set(key, revision);
      const enabled = body.enabled === true;
      const nextState = currentModules.map((module) => module.id === moduleId ? { ...module, enabled } : module);
      moduleState.set(matchedChannelId, nextState);
      const module = nextState.find((candidate) => candidate.id === moduleId);
      if (module === undefined) return route.fulfill(json({ error: "module_missing" }, 404));
      return route.fulfill(json({ module: { ...module, revision }, revision }));
    }
    if (matchedChannelId !== undefined && path === `/api/channels/${matchedChannelId}/modules/text_commands/commands`) return route.fulfill(json({ commands: [] }));
    if (matchedChannelId !== undefined && path === `/api/channels/${matchedChannelId}/variables`) return route.fulfill(json({ variables: [] }));
    if (matchedChannelId !== undefined && path === `/api/channels/${matchedChannelId}/members/search`) return route.fulfill(json({ user: inviteUser }));
    if (matchedChannelId !== undefined && path === `/api/channels/${matchedChannelId}/members` && method === "GET") {
      if (options.membersError) return route.fulfill(json({ error: "member_list_failed" }, 503));
      return route.fulfill(json({ members, nextCursor: null, broadcasterCount: 2, viewerUserId: "viewer-438" }));
    }
    if (matchedChannelId !== undefined && path === `/api/channels/${matchedChannelId}/members` && method === "POST") {
      return route.fulfill(json({ member: { ...inviteUser, role: "operator", joinedAt: new Date().toISOString() } }));
    }
    if (matchedChannelId !== undefined && path === `/api/channels/${matchedChannelId}/template-variables`) return route.fulfill(json({ variables: [] }));
    if (matchedChannelId !== undefined && path === `/api/channels/${matchedChannelId}/settings` && method === "GET") {
      markSettingsStarted();
      await settingsGate;
      return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 0, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
    }
    if (matchedChannelId !== undefined && path === `/api/channels/${matchedChannelId}/system`) {
      if (options.systemError) return route.fulfill(json({ error: "system_load_failed" }, 503));
      return route.fulfill(json({
        broadcasterConnection: "connected",
        bot,
        botPermissions: { missingScopes: [] },
        broadcasterPermissions: { missingScopes: [] },
        chatSubscription: { status: "enabled", subscriptionId: "sub-438", reason: null, updatedAt: "2026-10-16T08:00:00.000Z" },
        chatSubscriptionNeeded: false,
        subscriptions: [],
        tokens: { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" },
      }));
    }
    return route.fallback();
  });

  return {
    patchRequests,
    failNextPatch: () => { nextPatchFails = true; },
    settingsStarted,
    releaseSettings: () => { releaseSettings(); },
  };
};

const freshRoute = async (page: Page, viewport: { width: number; height: number }, path: string, options: Issue438MockOptions = {}) => {
  await page.unrouteAll({ behavior: "wait" });
  await page.setViewportSize(viewport);
  const controls = await installIssue438Mocks(page, options);
  await page.goto(path);
  return controls;
};

const box = async (locator: ReturnType<Page["locator"]>) => {
  const result = await locator.boundingBox();
  if (result === null) throw new Error("Expected a visible element with a bounding box.");
  return result;
};

test("issue 438 member page layout stays aligned at the requested viewports", async ({ page }) => {
  test.setTimeout(300_000);

  for (const viewport of viewports) {
    await freshRoute(page, viewport, `/channels/${channelId}/members`);
    await expect(page.locator(".members-collection__rows .list-row")).toHaveCount(members.length);
    const header = page.locator(".collection-page__heading--page-header .page-header");
    await expect(header.locator(".page-header__icon")).toBeVisible();
    await expect(header).toContainText("Verwalte, wer auf diesen Kanal zugreifen darf.");
    const toolbarRow = page.locator(".members-list-toolbar .list-toolbar__row");
    const searchBox = await box(toolbarRow.locator(".list-toolbar__search"));
    const createBox = await box(toolbarRow.locator(".list-toolbar__create"));
    expect(Math.abs(searchBox.y - createBox.y)).toBeLessThanOrEqual(1);
    expect(await page.getByText(/\d+ geladen/u).count()).toBe(1);
    await expect(page.locator(".collection-page__list-content .list-pagination-footer")).toHaveCount(0);
    const statusBox = await box(page.locator(".members-list-toolbar .list-toolbar__status"));
    const firstRowBox = await box(page.locator(".members-collection__rows .list-row").first());
    expect(firstRowBox.y - (statusBox.y + statusBox.height)).toBeLessThanOrEqual(12);

    await freshRoute(page, viewport, `/channels/${channelId}/members`, { role: "operator" });
    const operatorMemberReason = page.locator(".members-list-toolbar .list-toolbar__reason");
    await expect(operatorMemberReason).toBeVisible();
    expect(await operatorMemberReason.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.display, style.overflow, style.textOverflow, style.whiteSpace, element.scrollWidth <= element.clientWidth];
    })).toEqual(["block", "visible", "clip", "normal", true]);
    await expect(operatorMemberReason).toContainText("Nur Broadcaster und Verwalter dürfen Mitglieder ändern.");
    await freshRoute(page, viewport, `/channels/${channelId}/members`);
    await expect(page.locator(".members-collection__rows .list-row")).toHaveCount(members.length);

    const rowBoxes = await page.locator(".members-collection__rows .list-row").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    expect(new Set(rowBoxes.map((height) => Math.round(height))).size).toBe(1);
    const rowText = page.locator(".members-collection__rows .list-row").first().locator(".list-row__title");
    expect(await rowText.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.whiteSpace, style.overflow, style.textOverflow];
    })).toEqual(["nowrap", "hidden", "ellipsis"]);

    const broadcasterRow = page.locator(".members-collection__rows .list-row").filter({ hasText: "Demo Kanal" });
    const roleInBadge = broadcasterRow.locator(".ui-badge .members-collection__role");
    await expect(roleInBadge).toHaveAttribute("title", /Broadcaster-Rolle/u);
    await broadcasterRow.getByRole("link").click();
    await expect(page.getByRole("button", { name: /Broadcaster/u }).first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "Entziehen", exact: true })).toBeDisabled();
    await expect(page.getByText(/Nur ein Broadcaster darf die Broadcaster-Rolle ändern/u)).toBeVisible();

    if (viewport.width >= 1280) {
      await freshRoute(page, viewport, `/channels/${channelId}/members`);
      const emptyDetail = page.locator(".members-collection__empty");
      await expect(emptyDetail).toBeVisible();
      expect(await emptyDetail.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth, style.borderRadius, style.backgroundColor];
      })).toEqual(["0px", "0px", "0px", "0px", "0px", "rgba(0, 0, 0, 0)"]);
    }

    await freshRoute(page, viewport, `/channels/${channelId}/members`);
    await page.getByRole("button", { name: "Zugriff vergeben" }).click();
    const dialog = page.locator(".ui-step-dialog");
    const personStepHeight = (await box(dialog)).height;
    await page.getByRole("textbox", { name: "Twitch-Name" }).fill("lena_luchs");
    await page.getByRole("button", { name: "Suchen" }).click();
    await expect(page.getByRole("heading", { name: "Rolle vergeben" })).toBeVisible();
    expect(Math.abs((await box(dialog)).height - personStepHeight)).toBeLessThanOrEqual(1);
    const roleCardsBox = await box(page.locator(".member-invite-dialog .ui-choice-cards-field"));
    const footerBox = await box(dialog.locator(".ui-step-dialog__footer"));
    expect(footerBox.y - (roleCardsBox.y + roleCardsBox.height)).toBeLessThanOrEqual(100);
    await page.getByRole("button", { name: "Weiter" }).click();
    await expect(page.getByRole("heading", { name: "Zugriff prüfen" })).toBeVisible();
    expect(Math.abs((await box(dialog)).height - personStepHeight)).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Abbrechen" }).click();
    await expect(page.getByText("Einladung verwerfen?")).toBeVisible();
  }
});

test("issue 438 module page layout stays aligned at the requested viewports", async ({ page }) => {
  test.setTimeout(300_000);

  for (const viewport of viewports) {
    await freshRoute(page, viewport, `/channels/${channelId}/modules`);
    const groups = page.locator(".module-workspace__groups");
    const moduleGroups = groups.locator(":scope > .module-workspace__group");
    await expect.poll(() => moduleGroups.count()).toBeGreaterThan(1);
    const groupCount = await moduleGroups.count();
    expect(groupCount).toBeGreaterThan(1);
    expect(await groups.evaluate((element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u).length)).toBe(1);
    const groupBoxes = await groups.locator(":scope > .module-workspace__group").evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    }));
    expect(new Set(groupBoxes.map(({ x }) => Math.round(x))).size).toBe(1);
    for (const row of await page.locator(".module-workspace__group .list-row:has([role='switch'])").all()) {
      const rowBox = await box(row);
      const switchBox = await box(row.getByRole("switch"));
      expect(Math.abs((rowBox.y + rowBox.height / 2) - (switchBox.y + switchBox.height / 2))).toBeLessThanOrEqual(2);
    }
    if (viewport.width <= 640) {
      const description = page.locator(".module-workspace .list-row").filter({ hasText: "Textbefehle" }).first().locator(".list-row__description");
      expect((await box(description)).width).toBeGreaterThan(140);
      expect(await description.evaluate((element) => getComputedStyle(element).overflowWrap)).toBe("break-word");
    }

    await freshRoute(page, viewport, `/channels/${channelId}/modules`, { role: "operator" });
    const operatorModuleRow = page.locator(".module-workspace .list-row").filter({ hasText: "Textbefehle" }).first();
    const operatorModuleSwitch = operatorModuleRow.getByRole("switch");
    await expect(operatorModuleSwitch).toBeDisabled();
    const moduleLockReason = operatorModuleRow.locator(".module-workspace__lock-reason .ui-locked-reason");
    await expect(moduleLockReason).toBeVisible();
    if (viewport.width <= 640) expect((await box(moduleLockReason)).width).toBeGreaterThan(140);
    const mandatoryModuleRow = page.locator(".module-workspace .list-row").filter({ hasText: "Die Textbibliothek ist immer verfügbar." }).first();
    // The mandatory reason sits in the description slot; the status column only carries the lock and the status word.
    const mandatoryDescription = mandatoryModuleRow.locator(".list-row__description");
    await expect(mandatoryDescription.locator(".module-workspace__lock-reason").getByText("Die Textbibliothek ist immer verfügbar.")).toBeVisible();
    await expect(mandatoryModuleRow.locator(".module-locked-status")).toHaveText("Läuft · immer aktiv");
    const lockedStatuses = page.locator(".module-workspace__group .list-row .module-locked-status");
    expect(await lockedStatuses.count()).toBeGreaterThan(2);
    const statusLefts = await lockedStatuses.evaluateAll((nodes) => nodes.map((node) => Math.round(node.querySelector(".module-locked-status__icon")?.getBoundingClientRect().x ?? Number.NaN)));
    expect(new Set(statusLefts).size).toBe(1);
    // Wide: the status column sits right of the description. Narrow: it drops below the description.
    expect(await lockedStatuses.evaluateAll((nodes, narrow) => nodes.every((node) => {
      const row = node.closest(".list-row");
      const description = row?.querySelector(".list-row__description")?.getBoundingClientRect();
      const status = node.getBoundingClientRect();
      if (row === null || description === undefined || row.scrollWidth > row.clientWidth) return false;
      return narrow ? status.y >= description.bottom - 1 && Math.abs(status.x - description.x) <= 1 : status.x >= description.right - 1;
    }), viewport.width <= 640)).toBe(true);
    if (viewport.width > 640) {
      const ledBox = await box(page.locator(".module-workspace__group .list-row .status-led").first());
      const ledRight = ledBox.x + ledBox.width;
      const statusBox = await box(lockedStatuses.first());
      expect(Math.abs(statusBox.x + statusBox.width - ledRight)).toBeLessThanOrEqual(1);
    }
    expect((await box(mandatoryDescription)).width).toBeGreaterThan(viewport.width <= 640 ? 100 : 200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const operatorRowBox = await box(operatorModuleRow);
    const operatorSwitchBox = await box(operatorModuleSwitch);
    expect(Math.abs((operatorRowBox.y + operatorRowBox.height / 2) - (operatorSwitchBox.y + operatorSwitchBox.height / 2))).toBeLessThanOrEqual(2);
  }
});

test("issue 438 system page layout stays aligned at the requested viewports", async ({ page }) => {
  test.setTimeout(300_000);

  for (const viewport of viewports) {
    await freshRoute(page, viewport, `/channels/${channelId}/system`);
    await expect(page.locator(".system-page__status-list .state-row").first()).toBeVisible();
    const systemHeader = await box(page.locator(".system-page > .page-header"));
    const settingsSection = await box(page.locator(".channel-defaults-editor .ui-section__heading"));
    expect(settingsSection.y - (systemHeader.y + systemHeader.height)).toBeLessThanOrEqual(24);
    await expect(page.locator(".system-page .settings-page__columns > .settings-page__column")).toHaveCount(1);
    const defaultsSection = await box(page.locator(".channel-defaults-editor"));
    const statusList = await box(page.locator(".system-page__status-list"));
    expect(statusList.y).toBeGreaterThan(defaultsSection.y + defaultsSection.height - 2);
    const defaultsHint = await box(page.locator(".channel-defaults-editor__hint"));
    expect(statusList.y - (defaultsHint.y + defaultsHint.height)).toBeLessThanOrEqual(32);
    const systemRow = page.locator(".system-page__status-list .state-row").first();
    expect(await systemRow.evaluate((element) => [getComputedStyle(element).borderLeftStyle, getComputedStyle(element).backgroundColor])).toEqual(["none", "rgba(0, 0, 0, 0)"]);
    const moderatorButton = page.getByRole("button", { name: "Moderatorstatus prüfen" });
    const moderatorBox = await box(moderatorButton);
    const moderatorRowBox = await box(page.locator(".system-page__status-list .state-row").filter({ has: moderatorButton }));
    expect(moderatorBox.height).toBeLessThanOrEqual(36);
    expect(Math.abs(statusList.width - systemHeader.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(defaultsSection.width - systemHeader.width)).toBeLessThanOrEqual(1);
    for (const section of await page.locator(".system-page .content-section").all()) {
      const sectionBox = await box(section);
      expect(Math.abs(sectionBox.x + sectionBox.width - (systemHeader.x + systemHeader.width))).toBeLessThanOrEqual(2);
    }
    expect(await page.locator(".system-page .content-section > .empty-state").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).borderTopStyle))).not.toContain("dashed");
    expect(statusList.y - (defaultsSection.y + defaultsSection.height)).toBeLessThanOrEqual(56);
    if (viewport.width > 640) {
      expect(moderatorBox.width).toBeLessThanOrEqual(200);
      expect(moderatorRowBox.height).toBeLessThanOrEqual(52);
      expect((await box(systemRow)).height).toBeLessThanOrEqual(52);
      const statusRowHeights = await page.locator(".system-page__status-list .state-row").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
      expect(statusRowHeights.every((height) => height >= 40 && height <= 48)).toBe(true);
    }
    expect(await moderatorButton.getAttribute("class")).toContain("ui-button--neutral");
    if (viewport.width > 640) expect(Math.abs((moderatorBox.y + moderatorBox.height / 2) - (moderatorRowBox.y + moderatorRowBox.height / 2))).toBeLessThanOrEqual(2);

    await freshRoute(page, viewport, `/channels/${channelId}/system`, { role: "operator" });
    const operatorModeratorRow = page.locator(".system-page__status-list .state-row").filter({ has: page.getByRole("button", { name: "Moderatorstatus prüfen" }) });
    const operatorModeratorReason = operatorModeratorRow.locator(".header-action__reason-slot .lock-reason");
    await expect(operatorModeratorReason).toBeVisible();
    expect(await operatorModeratorReason.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.overflow, style.maxHeight, element.scrollHeight <= element.clientHeight];
    })).toEqual(["visible", "none", true]);
    const operatorModeratorRowBox = await box(operatorModeratorRow);
    const operatorReasonBox = await box(operatorModeratorReason);
    expect(operatorReasonBox.y + operatorReasonBox.height).toBeLessThanOrEqual(operatorModeratorRowBox.y + operatorModeratorRowBox.height + 1);
  }
});

test("system save actions remain reserved and disabled while settings load", async ({ page }) => {
  const controls = await freshRoute(page, { width: 390, height: 844 }, `/channels/${channelId}/system`, { settingsLoading: true });
  await controls.settingsStarted;
  const saveButton = page.locator(".system-page .page-header__save .ui-save-bar__save");
  await expect(saveButton).toBeVisible();
  await expect(saveButton).toBeDisabled();
  const headerBefore = await box(page.locator(".system-page > .page-header"));
  const saveClusterBefore = await box(page.locator(".system-page .page-header__save"));
  await expect(page.locator(".system-page__status-list .state-row").first()).toBeVisible();
  const statusListBefore = await box(page.locator(".system-page__status-list"));
  controls.releaseSettings();
    await expect(page.getByRole("button", { name: "Standard-Chat-Ziel", exact: true })).toBeVisible();
  const headerAfter = await box(page.locator(".system-page > .page-header"));
  const saveClusterAfter = await box(page.locator(".system-page .page-header__save"));
  const statusListAfter = await box(page.locator(".system-page__status-list"));
  expect(Math.abs(headerAfter.height - headerBefore.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(saveClusterAfter.y - saveClusterBefore.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(statusListAfter.y - statusListBefore.y)).toBeLessThanOrEqual(1);
});

test("initial system and member load errors stay inline without duplicate toasts", async ({ page }) => {
  const viewport = { width: 1280, height: 800 };
  await freshRoute(page, viewport, `/channels/${channelId}/system`, { systemError: true });
  await expect(page.locator(".system-page [role='alert']")).toBeVisible();
  await expect(page.locator(".ui-toast--error")).toHaveCount(0);

  await freshRoute(page, viewport, `/channels/${channelId}/members`, { membersError: true });
  await expect(page.locator(".collection-page__list [role='alert']")).toBeVisible();
  await expect(page.locator(".ui-toast--error")).toHaveCount(0);
});

test("the module list, module header, and command palette share revision-owned Undo", async ({ page }) => {
  const controls = await freshRoute(page, { width: 1280, height: 800 }, `/channels/${channelId}/modules`);
  const textCommandSwitch = page.getByRole("switch", { name: /Textbefehle/u });
  await textCommandSwitch.click();
  await expect(page.getByRole("button", { name: "Rückgängig" })).toBeVisible();
  controls.failNextPatch();
  await page.getByRole("switch", { name: /Textbefehle/u }).click();
  await expect(page.getByRole("alert")).toContainText("Die Änderung ist fehlgeschlagen.");
  await page.getByRole("button", { name: "Rückgängig" }).click();
  await expect.poll(() => controls.patchRequests.length).toBe(3);
  expect(controls.patchRequests[2]?.body).toEqual({ enabled: true, expectedRevision: 2 });
  await expect(page.getByRole("switch", { name: /Textbefehle/u })).toBeChecked();

  await page.goto(`/channels/${channelId}/modules/ads`);
  await expect(page.locator(".page-header__module-switch [role='switch']")).toBeVisible();
  await page.locator(".page-header__module-switch [role='switch']").click();
  await expect(page.getByRole("button", { name: "Rückgängig" })).toBeVisible();
  const headerToggle = controls.patchRequests.at(-1);
  expect(headerToggle?.moduleId).toBe("ads");
  await page.getByRole("button", { name: "Rückgängig" }).click();
  await expect.poll(() => controls.patchRequests.at(-1)?.body.expectedRevision).toBe(2);
  await expect(page.locator(".page-header__module-switch [role='switch']")).toBeChecked();

  await page.getByRole("button", { name: "Alles durchsuchen" }).click();
  const palette = page.getByRole("dialog", { name: "Seite suchen" });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder("Suchen oder Aktion ausführen …").fill("Werbung aus");
  await palette.getByRole("option", { name: "Werbung aus" }).click();
  await expect(page.getByRole("button", { name: "Rückgängig" })).toBeVisible();
  const paletteToggle = controls.patchRequests.at(-1);
  expect(paletteToggle?.moduleId).toBe("ads");
  expect(paletteToggle?.body.enabled).toBe(false);

  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/channels/${otherChannelId}/modules`);
  await expect(page.getByRole("heading", { name: "Module", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rückgängig" })).toHaveCount(0);
});

test("member role edits and invite dismissal use the dashboard draft guard", async ({ page }) => {
  await freshRoute(page, { width: 1920, height: 1080 }, `/channels/${channelId}/members`);
  await page.getByRole("link", { name: /Otto Owl/u }).click();
  await page.getByRole("button", { name: /Verwalter/u }).click();
  await page.getByRole("link", { name: "Module" }).click();
  await expect(page.getByText("Ungespeicherte Rollenänderung")).toBeVisible();
  await page.getByRole("button", { name: "Weiter bearbeiten" }).click();
  await expect(page.getByRole("heading", { name: "Mitglieder", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Verwerfen", exact: true }).click();

  await page.getByRole("button", { name: "Zugriff vergeben" }).click();
  await page.getByRole("textbox", { name: "Twitch-Name" }).fill("lena_luchs");
  await page.getByRole("button", { name: "Suchen" }).click();
  await expect(page.getByRole("heading", { name: "Rolle vergeben" })).toBeVisible();
  await page.getByRole("button", { name: "Abbrechen" }).click();
  await expect(page.getByText("Einladung verwerfen?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Weiter bearbeiten" })).toBeVisible();
});

test("member detail is a plain full-width column and closing returns focus to its row", async ({ page }) => {
  await freshRoute(page, { width: 1920, height: 1080 }, `/channels/${channelId}/members`);
  const row = page.locator(".members-collection__rows .list-row__link").first();
  await row.click();
  const detail = page.locator(".collection-page__detail");
  const editor = detail.locator(".ui-editor-shell");
  await expect(editor).toBeVisible();
  const detailBox = await box(detail);
  const editorBox = await box(editor);
  const detailPadding = await detail.evaluate((element) => {
    const style = getComputedStyle(element);
    return { left: Number.parseFloat(style.paddingLeft), right: Number.parseFloat(style.paddingRight) };
  });
  expect(Math.abs(editorBox.x - detailBox.x - detailPadding.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(editorBox.width - (detailBox.width - detailPadding.left - detailPadding.right))).toBeLessThanOrEqual(2);
  expect(await editor.evaluate((element) => [getComputedStyle(element).borderTopWidth, getComputedStyle(element).paddingLeft, getComputedStyle(element).backgroundColor])).toEqual(["0px", "0px", "rgba(0, 0, 0, 0)"]);
  expect(await editor.locator(".ui-save-bar").first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  const selected = await page.locator(".members-collection__rows .list-row--selected").evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--color-selection-border)";
    element.appendChild(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    return { token, shadow: getComputedStyle(element).boxShadow };
  });
  expect(selected.shadow).toContain(selected.token);
  expect(selected.shadow).toMatch(/ 0px 0px 0px 1px inset$/u);
  const title = await box(editor.locator(".inspector-section__heading h3"));
  const close = editor.getByRole("button", { name: "Schließen" });
  const closeBox = await box(close);
  expect(title.x + title.width).toBeLessThanOrEqual(closeBox.x + 1);
  expect(Math.abs((title.y + title.height / 2) - (closeBox.y + closeBox.height / 2))).toBeLessThanOrEqual(2);
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect(row).toBeFocused();
});
