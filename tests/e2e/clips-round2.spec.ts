import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const CHANNEL_ID = "kanal-433";
const STORED_SETTINGS = {
  commandMinimumRole: "vip",
  commandCooldownSeconds: 180,
  postClipLinkInChat: true,
  chatLinkTemplate: "Clip aus dem Stream: {clip.title} {clip.url}",
  automaticClipsEnabled: true,
  automaticThresholdMultiplier: 3.5,
  automaticCooldownSeconds: 1200,
};

interface DashboardOptions {
  role?: "manager" | "operator";
  moduleEnabled?: boolean;
  automaticClipsEnabled?: boolean;
  settingsLoading?: boolean;
  clipCount?: number;
}

const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

const mockDashboard = async (page: Page, options: DashboardOptions = {}) => {
  const role = options.role ?? "manager";
  const moduleEnabled = options.moduleEnabled ?? true;
  let failRefresh = false;
  let releaseSettings!: () => void;
  const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve; });
  const settings = { ...STORED_SETTINGS, automaticClipsEnabled: options.automaticClipsEnabled ?? STORED_SETTINGS.automaticClipsEnabled };
  const streamStartedAt = "2026-10-16T07:00:00.000Z";
  const channel = {
    channelId: CHANNEL_ID,
    login: "demo-kanal",
    displayName: "Demo Kanal",
    role,
    streamState: "online",
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: streamStartedAt },
    moderator: { isModerator: true, checkedAt: streamStartedAt, reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "abo-433", reason: null, updatedAt: streamStartedAt },
    tokens: { botExpiresAt: "2099-10-16T07:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-10-16T07:00:00.000Z" },
    lastError: null,
  };
  const clips = Array.from({ length: options.clipCount ?? 8 }, (_, index) => ({
    clipId: `ConfirmedSessionClip${String(index + 1).padStart(3, "0")}`,
    createdAt: `2026-10-16T07:${String(50 - index % 50).padStart(2, "0")}:00.000Z`,
  }));

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/channels") return route.fulfill(json({ channels: [channel], bot: channel.bot }));
    if (url.pathname === `/api/channels/${CHANNEL_ID}/overview`) {
      return route.fulfill(json({ ...channel, activeModules: moduleEnabled ? [{ moduleId: "clips", settings: JSON.stringify(settings) }] : [] }));
    }
    if (url.pathname === `/api/channels/${CHANNEL_ID}/settings`) {
      return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
    }
    if (url.pathname === `/api/channels/${CHANNEL_ID}/modules` && method === "GET") {
      return route.fulfill(json({ modules: [{ id: "clips", enabled: moduleEnabled, settings: JSON.stringify(settings) }] }));
    }
    if (url.pathname === `/api/channels/${CHANNEL_ID}/modules/clips/settings` && method === "GET") {
      if (options.settingsLoading) await settingsGate;
      return route.fulfill(json({ settings, revision: 3, variables: [] }));
    }
    if (url.pathname === `/api/channels/${CHANNEL_ID}/clips` && method === "GET") {
      if (failRefresh) return route.fulfill(json({ error: "clips_unavailable" }, 503));
      return route.fulfill(json({ streamStartedAt, clips }));
    }
    if (url.pathname === `/api/channels/${CHANNEL_ID}/revisions`) return route.fulfill(json({ revisions: {} }));
    if (url.pathname === "/api/csrf") return route.fulfill(json({ token: "csrf-433" }));
    return route.fulfill(json({}));
  });

  return {
    failRefresh: () => { failRefresh = true; },
    recoverRefresh: () => { failRefresh = false; },
    releaseSettings: () => { releaseSettings(); },
  };
};

const openClips = async (page: Page, options: DashboardOptions = {}) => {
  await mockDashboard(page, options);
  await page.goto(`/channels/${CHANNEL_ID}/modules/clips`);
  await expect(page.locator(".clips-panel")).toBeVisible();
};

test("manager and operator see the same locked settings without save or restore actions", async ({ page }) => {
  for (const role of ["manager", "operator"] as const) {
    await openClips(page, { role });

    await expect(page.getByRole("heading", { name: "Chatbefehl !clip", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Clip-Link im Chat posten", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Automatische Clip-Einstellungen", exact: true })).toBeVisible();
    await expect(page.getByText("Kommt in einer späteren Version.", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Automatische Clips kommen in einer späteren Version.", { exact: true })).toBeVisible();
    await expect(page.locator("#clips-command-cooldown")).toBeDisabled();
    await expect(page.locator("#clips-chat-message")).toBeDisabled();
    await expect(page.locator("#clips-auto-threshold")).toBeDisabled();
    await expect(page.locator("#clips-auto-cooldown")).toBeDisabled();
    await expect(page.getByRole("switch", { name: "Aktiviert" })).toBeDisabled();
    await expect(page.getByRole("switch", { name: "Automatische Clips" })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Mindestrolle" })).toBeDisabled();
    await expect(page.locator("#clips-command-cooldown")).toHaveValue("180");
    await expect(page.locator("#clips-chat-message")).toHaveValue(STORED_SETTINGS.chatLinkTemplate);
    await expect(page.locator("#clips-auto-threshold")).toHaveValue("3.5");
    await expect(page.locator("#clips-auto-cooldown")).toHaveValue("1200");
    await expect(page.getByRole("button", { name: "Speichern", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Weitere Aktionen", exact: true })).toHaveCount(0);
    await expect(page.locator(".ui-save-bar")).toHaveCount(0);
    await expect(page.locator(".page-header__badges")).toHaveCount(0);
    await expect(page.getByText("nicht implementiert", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Helix", { exact: false })).toHaveCount(0);

    await expect(page.getByText("Nur Broadcaster und Verwalter dürfen Clip-Einstellungen ändern.", { exact: true })).toHaveCount(0);
    await page.goto("about:blank");
  }
});

test("automatic clips stay locked when the stored setting is off", async ({ page }) => {
  await openClips(page, { automaticClipsEnabled: false });

  await expect(page.getByRole("switch", { name: "Automatische Clips" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Automatische Clips" })).not.toBeChecked();
  await expect(page.locator("#clips-auto-threshold")).toHaveValue("3.5");
  await expect(page.locator("#clips-auto-cooldown")).toHaveValue("1200");
});

test("disabled module switch keeps the operator permission reason visible", async ({ page }) => {
  await mockDashboard(page, { role: "operator", moduleEnabled: false });
  await page.goto(`/channels/${CHANNEL_ID}/modules/clips`);

  await expect(page.locator(".module-detail-heading .page-header__lock")).toContainText("Nur Broadcaster und Verwalter dürfen Module ändern.");
  await expect(page.getByRole("switch").first()).toBeDisabled();
});

for (const width of [1920, 1280, 390, 2560]) {
  test(`clips layout shares widths and keeps field and section rhythm at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openClips(page);

    const header = await page.locator(".module-detail > .module-detail-heading").boundingBox();
    const content = await page.locator(".module-detail__content").boundingBox();
    expect(header).not.toBeNull();
    expect(content).not.toBeNull();
    expect(Math.abs((header?.width ?? 0) - (content?.width ?? 0))).toBeLessThanOrEqual(1);
    await expect(page.locator(".clips-panel .page-header__save .ui-save-bar--persistent")).toHaveCount(0);

    const settings = page.locator(".clips-panel__settings");
    expect(await page.locator(".clips-panel").evaluate((element) => getComputedStyle(element).alignContent)).toBe("start");
    expect(await page.locator(".clips-panel").evaluate((element) => getComputedStyle(element).rowGap)).toBe("0px");
    expect(await page.locator(".clips-panel__settings-load-state").evaluate((element) => getComputedStyle(element).alignSelf)).toBe("start");
    expect(await page.locator(".clips-panel__settings-refresh-message").evaluate((element) => getComputedStyle(element).minHeight)).toBe("18px");
    expect(await settings.evaluate((element) => getComputedStyle(element).rowGap)).toBe("0px");
    const minimumWidthRatio = width < 600 ? 0.95 : 0.45;
    const commandPair = page.locator(".clips-panel__command-fields");
    const commandPairBox = await commandPair.boundingBox();
    const commandRoleBox = await page.locator("#clips-command-role").boundingBox();
    const commandCooldownBox = await page.locator("#clips-command-cooldown").locator("xpath=..").boundingBox();
    expect(commandPairBox).not.toBeNull();
    expect(commandRoleBox).not.toBeNull();
    expect(commandCooldownBox).not.toBeNull();
    expect((commandRoleBox?.width ?? 0) / (commandPairBox?.width ?? 1)).toBeGreaterThan(minimumWidthRatio);
    expect((commandCooldownBox?.width ?? 0) / (commandPairBox?.width ?? 1)).toBeGreaterThan(minimumWidthRatio);
    const pair = page.locator(".clips-panel__automatic-fields");
    const pairBox = await pair.boundingBox();
    const fieldBox = await page.locator("#clips-auto-threshold").locator("xpath=..").boundingBox();
    expect(pairBox).not.toBeNull();
    expect(fieldBox).not.toBeNull();
    expect((fieldBox?.width ?? 0) / (pairBox?.width ?? 1)).toBeGreaterThan(minimumWidthRatio);
    const thresholdLabel = await page.locator('label[for="clips-auto-threshold"]').boundingBox();
    expect(thresholdLabel).not.toBeNull();
    expect(thresholdLabel?.height ?? 0).toBeLessThanOrEqual(20);
    const chipRowCounts = await page.locator(".clips-panel__automatic-fields .unit-input__suggestions").evaluateAll((groups) => groups.map((group) => {
      const rows = Array.from(group.querySelectorAll("button")).map((element) => Math.round(element.getBoundingClientRect().top));
      return new Set(rows).size;
    }));
    expect(chipRowCounts).toEqual([1, 1]);

    const firstSection = await settings.locator(":scope > .ui-section").nth(0).boundingBox();
    const secondSection = await settings.locator(":scope > .ui-section").nth(1).boundingBox();
    expect(firstSection).not.toBeNull();
    expect(secondSection).not.toBeNull();
    const sectionGap = (secondSection?.y ?? 0) - ((firstSection?.y ?? 0) + (firstSection?.height ?? 0));
    expect(sectionGap).toBeGreaterThanOrEqual(20);
    expect(sectionGap).toBeLessThanOrEqual(28);

    const settingsHeader = await page.locator(".clips-panel__settings-load-state .page-header").boundingBox();
    const listSection = await page.locator(".clips-panel__clips-section").boundingBox();
    const settingsSectionLast = await settings.locator(":scope > .ui-section").last().boundingBox();
    expect(settingsHeader).not.toBeNull();
    expect(listSection).not.toBeNull();
    expect(settingsSectionLast).not.toBeNull();
    expect((firstSection?.y ?? 0) - ((settingsHeader?.y ?? 0) + (settingsHeader?.height ?? 0))).toBeGreaterThanOrEqual(20);
    expect((firstSection?.y ?? 0) - ((settingsHeader?.y ?? 0) + (settingsHeader?.height ?? 0))).toBeLessThanOrEqual(28);
    const settingsListGap = (listSection?.y ?? 0) - ((settingsSectionLast?.y ?? 0) + (settingsSectionLast?.height ?? 0));
    expect(settingsListGap).toBeGreaterThanOrEqual(20);
    expect(settingsListGap).toBeLessThanOrEqual(28);

    const automaticSection = page.locator(".ui-section").filter({ has: page.getByRole("heading", { name: "Automatische Clip-Einstellungen", exact: true }) });
    const automaticHeading = await automaticSection.locator(".ui-section__heading").boundingBox();
    const notice = await automaticSection.getByText("Automatische Clips kommen in einer späteren Version.", { exact: true }).boundingBox();
    expect(automaticHeading).not.toBeNull();
    expect(notice).not.toBeNull();
    expect((notice?.y ?? 0) - ((automaticHeading?.y ?? 0) + (automaticHeading?.height ?? 0))).toBeLessThanOrEqual(20);

    expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(width);
  });
}

for (const width of [1920, 1280, 390, 2560]) {
  test(`settings loading reserves the final block without moving the session list at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1080 });
    const mock = await mockDashboard(page, { settingsLoading: true });
    await page.goto(`/channels/${CHANNEL_ID}/modules/clips`);
    await expect(page.locator(".clips-panel__settings-load-state[data-status='loading']")).toBeVisible();

    const loadStateBefore = await page.locator(".clips-panel__settings-load-state").boundingBox();
    const listBefore = await page.locator(".clips-panel__clips-section").boundingBox();
    await expect(page.getByRole("heading", { name: "Clip-Einstellungen", exact: true })).toBeVisible();
    const reservedHeight = width < 600 ? 1080 : 800;
    expect(await page.locator(".clips-panel__settings-load-state").evaluate((element) => getComputedStyle(element).minHeight)).toBe(`${String(reservedHeight)}px`);
    expect(await page.locator(".clips-panel__settings-load-state .ui-load-state__reserved-lines > span").nth(14).evaluate((element) => getComputedStyle(element).display)).toBe(width < 600 ? "block" : "none");
    expect(await page.locator(".clips-panel__settings-load-state .ui-load-state__reserved-lines > span").nth(18).evaluate((element) => getComputedStyle(element).display)).toBe(width < 600 ? "block" : "none");
    expect(loadStateBefore?.height).toBe(reservedHeight);
    mock.releaseSettings();
    await expect(page.locator("#clips-auto-threshold")).toBeVisible();

    const loadStateAfter = await page.locator(".clips-panel__settings-load-state").boundingBox();
    const listAfter = await page.locator(".clips-panel__clips-section").boundingBox();
    const measured = { width, loading: loadStateBefore?.height, loaded: loadStateAfter?.height };
    expect(loadStateAfter?.height).toBe(reservedHeight);
    expect(Math.abs((loadStateAfter?.height ?? 0) - (loadStateBefore?.height ?? 0)), JSON.stringify(measured)).toBeLessThanOrEqual(1);
    expect(Math.abs((listAfter?.y ?? 0) - (listBefore?.y ?? 0)), JSON.stringify(measured)).toBeLessThanOrEqual(1);
  });
}

for (const width of [1920, 1280, 390, 2560]) {
  test(`refresh errors stay in the list header beside refresh with a growing clip list at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1080 });
    const mock = await mockDashboard(page, { clipCount: 100 });
    await page.goto(`/channels/${CHANNEL_ID}/modules/clips`);
    await expect(page.getByText("Clip ConfirmedSessionClip001", { exact: true })).toBeVisible();
    await expect(page.getByText("Clip ConfirmedSessionClip100", { exact: true })).toBeVisible();

    mock.failRefresh();
    await page.getByRole("button", { name: "Clips aktualisieren" }).click();

    const alert = page.getByRole("alert");
    const heading = page.locator(".clips-panel__clips-section .ui-section__heading");
    await expect(alert).toContainText("Die Clips dieser Sitzung konnten nicht geladen werden.");
    await expect(alert).toContainText("Erneut versuchen");
    await expect(heading).toContainText("Clips dieser Stream-Sitzung");
    await expect(heading).toContainText("Die Clips dieser Sitzung konnten nicht geladen werden.");
    expect(await alert.evaluate((element) => element.parentElement?.closest(".ui-section__heading") !== null)).toBe(true);
    await expect(page.getByText("Clip ConfirmedSessionClip100", { exact: true })).toBeVisible();

    const alertBox = await alert.boundingBox();
    const refreshBox = await page.getByRole("button", { name: "Clips aktualisieren" }).boundingBox();
    expect(alertBox).not.toBeNull();
    expect(refreshBox).not.toBeNull();
    expect(Math.abs((alertBox?.y ?? 0) - (refreshBox?.y ?? 0))).toBeLessThanOrEqual(width < 600 ? 90 : 44);
    expect(await heading.evaluate((element) => getComputedStyle(element).minWidth)).toBe("0px");
    expect(await page.locator(".clips-panel__refresh-actions").evaluate((element) => getComputedStyle(element).display)).toBe("flex");
    expect(await alert.evaluate((element) => getComputedStyle(element).fontSize)).toBe("12px");
    expect(await alert.locator(".ui-button").evaluate((element) => getComputedStyle(element).flex)).toBe("0 0 auto");
    if (width < 600) {
      expect(await heading.evaluate((element) => getComputedStyle(element).flexWrap)).toBe("wrap");
      expect(await page.locator(".clips-panel__refresh-error").evaluate((element) => getComputedStyle(element).flexBasis)).toBe("100%");
    }

    mock.recoverRefresh();
    await page.getByRole("button", { name: "Erneut versuchen" }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByText("Clip ConfirmedSessionClip100", { exact: true })).toBeVisible();
  });
}
