import { expect, test, type Page, type Route } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

type ModuleId = "ads" | "raid";
type State = "ready" | "operator" | "missing-scope" | "raid-message-off" | "refresh-429" | "refresh-and-snooze-429" | "refresh-scope-missing" | "snooze-429" | "save-error" | "toggle-and-save";
type Role = "broadcaster" | "manager" | "operator";

const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });
const adsSettings = {
  automatic: "Werbepause beginnt: {ads.duration} Sekunden.",
  manual: "Manuell gestartete Werbung",
  automaticTarget: "source_only",
  manualTarget: "source_only",
  leadSeconds: 60,
  prewarningText: "Werbung in {ads.seconds} Sekunden.",
  prewarningTarget: "source_only",
};
const raidSettings = {
  shoutoutEnabled: true,
  shoutoutThreshold: 3,
  textThreshold: 3,
  textLong: "Willkommen {channel}! Schön, dass ihr da seid.",
  textShort: "Willkommen {channel}!",
  textLongTarget: "channel_default",
  textShortTarget: "channel_default",
};

const installModule = async (page: Page, moduleId: ModuleId, state: State, width: number, height: number): Promise<{ scheduleRequests: () => number; submittedRevision: () => number | undefined; settingsReadRevisions: () => readonly number[]; toggleRequestStarted: () => Promise<void>; releaseToggleRequest: () => void }> => {
  const channelId = `issue-434-${moduleId}-${state}-${String(width)}`;
  const role: Role = state === "operator" ? "operator" : state === "missing-scope" ? "broadcaster" : "manager";
  const module = {
    id: moduleId,
    enabled: true,
    settings: "{}",
    ...(state === "missing-scope" ? { missingBroadcasterScopes: ["channel:read:ads"] } : {}),
  };
  let moduleEnabled = true;
  let settingsRevision = 1;
  let submittedRevision: number | undefined;
  let resolveToggleRequestStarted: (() => void) | undefined;
  let releaseToggleRequest: (() => void) | undefined;
  const toggleRequestStarted = new Promise<void>((resolve) => { resolveToggleRequestStarted = resolve; });
  const settingsReadRevisions: number[] = [];
  const currentModule = () => ({ ...module, enabled: moduleEnabled });
  const readySchedule = () => {
    const now = Date.now();
    return {
      schedule: { nextAdAt: new Date(now + 10 * 60_000).toISOString(), duration: 90, lastAdAt: new Date(now - 38 * 60_000).toISOString(), prerollFreeTime: 240, snoozeCount: 2, snoozeRefreshAt: new Date(now + 18 * 60 * 60_000).toISOString() },
      snoozeScopeAvailable: true,
      recentAdBreaks: [{ timestamp: new Date(now - 38 * 60_000).toISOString(), durationSeconds: 90 }],
    };
  };
  const channel = {
    channelId,
    login: "beispielkanal",
    displayName: "Beispielkanal",
    language: "de",
    role,
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: "2030-01-01T11:45:00.000Z" },
    botPermissions: { missingScopes: [] },
    broadcasterPermissions: { missingScopes: state === "missing-scope" ? ["channel:read:ads"] : [] },
    moderator: { isModerator: true, checkedAt: "2030-01-01T11:45:00.000Z", reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "issue-434", reason: null, updatedAt: "2030-01-01T11:45:00.000Z" },
    chatSubscriptionNeeded: false,
    modules: [currentModule()],
    tokens: { botExpiresAt: "2099-01-01T00:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-01-01T00:00:00.000Z" },
    lastError: null,
  };
  let scheduleRequests = 0;
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [{ ...channel, modules: [currentModule()] }], viewerUserId: "issue-434-viewer", bot: channel.bot, platformAdmin: false, viewerIsBot: false }));
    if (pathname === `/api/channels/${channelId}/overview`) return route.fulfill(json({ ...channel, modules: [currentModule()], activeModules: moduleEnabled ? [{ moduleId, settings: "{}" }] : [] }));
    if (pathname === `/api/channels/${channelId}/modules`) return route.fulfill(json({ modules: [currentModule()] }));
    if (pathname === `/api/channels/${channelId}/settings`) return route.fulfill(json({ defaultChatTarget: "source_only", defaultChatTargetRevision: 1, timeZone: "Europe/Berlin", revision: 1 }));
    if (pathname === `/api/channels/${channelId}/revisions`) return route.fulfill(json({ revisions: {} }));
    if (pathname === `/api/channels/${channelId}/modules/text_commands/commands`) return route.fulfill(json({ commands: [], variables: [] }));
    if (pathname === `/api/channels/${channelId}/variables`) return route.fulfill(json({ variables: [], count: 0, maximum: 100 }));
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "issue-434-csrf" }));
    if (pathname === `/api/channels/${channelId}/modules/${moduleId}/settings`) {
      const settings = moduleId === "ads" ? adsSettings : state === "raid-message-off" ? { ...raidSettings, textShort: "" } : raidSettings;
      if (request.method() === "PATCH" && state === "save-error") return route.fulfill(json({ error: "settings_write_failed" }, 500));
      if (request.method() === "PATCH" && state === "toggle-and-save") {
        const body = JSON.parse(request.postData() ?? "{}") as { revision: number; settings: Record<string, unknown> };
        submittedRevision = body.revision;
        settingsRevision += 1;
        return route.fulfill(json({ settings: body.settings, revision: settingsRevision, variables: [], warnings: [] }));
      }
      if (request.method() === "PATCH") return route.fulfill(json({ settings, revision: settingsRevision + 1, variables: [], warnings: [] }));
      settingsReadRevisions.push(settingsRevision);
      return route.fulfill(json({ settings, revision: settingsRevision, variables: [], warnings: [] }));
    }
    if (state === "toggle-and-save" && pathname === `/api/channels/${channelId}/modules/${moduleId}` && request.method() === "PATCH") {
      resolveToggleRequestStarted?.();
      await new Promise<void>((resolve) => { releaseToggleRequest = resolve; });
      const body = JSON.parse(request.postData() ?? "{}") as { enabled: boolean };
      moduleEnabled = body.enabled;
      settingsRevision += 1;
      return route.fulfill(json({ module: currentModule() }));
    }
    if (moduleId === "ads" && pathname === `/api/channels/${channelId}/modules/ads/schedule`) {
      scheduleRequests += 1;
      return route.fulfill(json({
        asOf: new Date(Date.now()).toISOString(),
        ...readySchedule(),
      }));
    }
    if (moduleId === "ads" && pathname === `/api/channels/${channelId}/modules/ads/schedule/refresh` && request.method() === "POST") {
      if (state === "refresh-429" || state === "refresh-and-snooze-429") return route.fulfill(json({ error: "ad_schedule_refresh_failed", reason: "rate_limited", detail: { retryAfter: Date.now() + 90_000 } }, 429));
      if (state === "refresh-scope-missing") return route.fulfill(json({ error: "ad_schedule_refresh_failed", reason: "scope_missing" }, 403));
      return route.fulfill(json(readySchedule()));
    }
    if (moduleId === "ads" && pathname === `/api/channels/${channelId}/modules/ads/snooze` && request.method() === "POST") {
      if (state === "snooze-429" || state === "refresh-and-snooze-429") return route.fulfill(json({ error: "ad_snooze_failed", reason: "rate_limited", detail: { retryAfter: Date.now() + 90_000 } }, 429));
      return route.fulfill(json({ schedule: {}, recentAdBreaks: [], snoozeScopeAvailable: true }));
    }
    return route.fulfill(json({}));
  });
  await page.setViewportSize({ width, height });
  await page.goto(`/channels/${channelId}/modules/${moduleId}`);
  return {
    scheduleRequests: () => scheduleRequests,
    submittedRevision: () => submittedRevision,
    settingsReadRevisions: () => settingsReadRevisions,
    toggleRequestStarted: () => toggleRequestStarted,
    releaseToggleRequest: () => { releaseToggleRequest?.(); },
  };
};

const expectHeaderAndColumnsToAlign = async (page: Page): Promise<void> => {
  const sizes = await page.evaluate(() => {
    const header = document.querySelector(".settings-page > .page-header")?.getBoundingClientRect();
    const columns = document.querySelector(".settings-page__columns")?.getBoundingClientRect();
    return header === undefined || columns === undefined ? null : {
      headerLeft: header.left,
      headerRight: header.right,
      columnsLeft: columns.left,
      columnsRight: columns.right,
    };
  });
  expect(sizes).not.toBeNull();
  expect(Math.abs((sizes?.headerLeft ?? 0) - (sizes?.columnsLeft ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((sizes?.headerRight ?? 0) - (sizes?.columnsRight ?? 0))).toBeLessThanOrEqual(1);
};

const expectToastBelowPageHeader = async (page: Page): Promise<void> => {
  const layout = await page.evaluate(() => {
    const header = document.querySelector(".settings-page > .page-header")?.getBoundingClientRect();
    const actions = document.querySelector(".settings-page > .page-header .page-header__right")?.getBoundingClientRect();
    const toast = document.querySelector(".ui-toast")?.getBoundingClientRect();
    const host = document.querySelector<HTMLElement>(".ui-toast-host");
    if (header === undefined || actions === undefined || toast === undefined || host === null) return null;
    const overlaps = (first: DOMRect, second: DOMRect): boolean => first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
    const style = getComputedStyle(host);
    return { overlapsHeader: overlaps(toast, header), overlapsActions: overlaps(toast, actions), bottom: style.bottom, expectedBottom: window.innerWidth <= 768 ? "4px" : "16px", position: style.position };
  });
  expect(layout).not.toBeNull();
  expect(layout?.overlapsHeader).toBe(false);
  expect(layout?.overlapsActions).toBe(false);
  expect(layout?.bottom).toBe(layout?.expectedBottom);
  expect(layout?.position).toBe("fixed");
};

const expectMobileToastOverlay = async (page: Page): Promise<void> => {
  const position = await page.locator(".ui-toast-host").evaluate((host) => getComputedStyle(host).position);
  expect(position).toBe("fixed");
};

test("Ads settings keep the header aligned and columns scrolling inside the page", async ({ page }) => {
  await installModule(page, "ads", "ready", 1280, 800);
  await expect(page.getByRole("heading", { level: 1, name: "Werbung" })).toBeVisible();
  await expectHeaderAndColumnsToAlign(page);
  await expect(page.locator(".ads-schedule-summary")).toBeVisible();
  expect(await page.locator(".module-stack .ui-load-state__retry-slot").count()).toBe(0);
  expect(await page.locator(".settings-page__column").first().evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  const adsLayout = await page.evaluate(() => {
    const asOf = document.querySelector(".module-stack .config-section > p.muted");
    const scheduleHeader = document.querySelector(".module-stack > .section-heading");
    const snoozeSection = document.querySelector('.module-stack .config-section[aria-label="Werbung verschieben"]');
    const recentSection = document.querySelector('.module-stack .config-section[aria-label="Letzte Werbepausen"]');
    const refresh = document.querySelector(".ads-snooze-refresh");
    const recentSlot = document.querySelector(".ads-recent-list-slot");
    return asOf === null || scheduleHeader === null || snoozeSection === null || recentSection === null || refresh === null || recentSlot === null
      ? null
      : {
          standFont: getComputedStyle(asOf).fontFamily,
          standGap: asOf.getBoundingClientRect().top - scheduleHeader.getBoundingClientRect().bottom,
          snoozeSectionGap: getComputedStyle(snoozeSection).marginTop,
          recentSectionGap: getComputedStyle(recentSection).marginTop,
          refreshIndent: getComputedStyle(refresh).paddingLeft,
          recentSlotHeight: getComputedStyle(recentSlot).height,
        };
  });
  expect(adsLayout).not.toBeNull();
  expect(adsLayout?.standFont).not.toMatch(/mono/iu);
  expect(adsLayout?.standGap ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(48);
  expect(adsLayout?.snoozeSectionGap).toBe("20px");
  expect(adsLayout?.recentSectionGap).toBe("12px");
  expect(adsLayout?.refreshIndent).toBe("0px");
  expect(adsLayout?.recentSlotHeight).toBe("120px");
  const scrollColumn = page.locator(".settings-page__column").first();
  await scrollColumn.evaluate((element) => {
    element.insertAdjacentHTML("beforeend", '<div style="height:1000px"></div>');
  });
  const scrollMetrics = await scrollColumn.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  const routeBottom = await page.locator(".module-route-layout").evaluate((element) => element.getBoundingClientRect().bottom);
  expect(routeBottom).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
  const headerTop = await page.locator(".settings-page > .page-header").evaluate((element) => element.getBoundingClientRect().top);
  await scrollColumn.evaluate((element) => { element.scrollTop = 120; });
  expect(await scrollColumn.evaluate((element) => element.scrollTop)).toBe(120);
  expect(await page.locator(".settings-page > .page-header").evaluate((element) => element.getBoundingClientRect().top)).toBe(headerTop);
});

test("Ads update the due time while realtime is connected", async ({ page }) => {
  await page.addInitScript(() => {
    class MockWebSocket extends EventTarget {
      readyState = 0;
      constructor() {
        super();
        queueMicrotask(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
        });
      }
      send(): void {}
      close(code = 1000, reason = "closed"): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(new CloseEvent("close", { code, reason }));
      }
    }
    Object.defineProperty(window, "WebSocket", { value: MockWebSocket, configurable: true, writable: true });
  });
  await page.clock.install({ time: new Date() });
  await installModule(page, "ads", "ready", 1280, 800);
  const due = page.locator(".ads-schedule-summary dd").nth(2);
  await expect(due).toHaveText("in 10 Minuten");
  await page.clock.fastForward(60_000);
  await expect(due).toHaveText("in 9 Minuten");
});

test("Ads refresh explains Twitch rate limits and keeps the snooze result slot steady on mobile", async ({ page }) => {
  await installModule(page, "ads", "refresh-and-snooze-429", 390, 844);
  await expect(page.getByRole("button", { name: "Werbeplan aktualisieren" })).toBeEnabled();
  await page.getByRole("button", { name: "Werbeplan aktualisieren" }).click();
  await expect(page.locator(".ui-toast")).toContainText(/Versuche es in 90 Sekunden erneut/u);
  await expectToastBelowPageHeader(page);
  await expectMobileToastOverlay(page);

  const result = page.getByTestId("ads-snooze-result-slot");
  const recent = page.getByTestId("ads-recent-list-slot");
  const measure = (element: typeof result) => element.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top + window.scrollY, height: rect.height };
  });
  const before = await Promise.all([measure(result), measure(recent)]);
  await page.getByRole("button", { name: /Snooze · 2 verfügbar/u }).click();
  await expect(result).toContainText(/Versuche es in 90 Sekunden erneut/u);
  const after = await Promise.all([measure(result), measure(recent)]);
  expect(after[0].height).toBe(before[0].height);
  expect(after[0].height).toBe(48);
  expect(after[1].top).toBe(before[1].top);
  const resultChildren = await result.evaluate((element) => {
    const slot = element.getBoundingClientRect();
    return {
      slot: { top: slot.top, bottom: slot.bottom, height: slot.height },
      children: Array.from(element.querySelectorAll<HTMLElement>(".ads-snooze-result, .ads-snooze-refresh"))
        .map((child) => ({ text: child.textContent, top: child.getBoundingClientRect().top, bottom: child.getBoundingClientRect().bottom, height: child.getBoundingClientRect().height })),
    };
  });
  expect(resultChildren.children.every((child) => child.bottom <= resultChildren.slot.bottom + 1), JSON.stringify(resultChildren)).toBe(true);
  await expectMobileToastOverlay(page);
  const recentToSettingsGap = await page.evaluate(() => {
    const table = document.querySelector(".ads-recent-list-slot__table");
    const nextColumn = document.querySelectorAll(".settings-page__column")[1];
    if (table === null || nextColumn === undefined) return null;
    return nextColumn.getBoundingClientRect().top - table.getBoundingClientRect().bottom;
  });
  expect(recentToSettingsGap).not.toBeNull();
  expect(recentToSettingsGap ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(80);
});

test("a mobile Ads success toast leaves the textarea fixed until the toast disappears", async ({ page }) => {
  await page.clock.install();
  await installModule(page, "ads", "ready", 390, 844);
  const message = page.getByRole("textbox", { name: "Vorwarnung" });
  const columns = page.locator(".settings-page__columns");
  const measure = async () => ({ textarea: await message.boundingBox(), columns: await columns.boundingBox() });
  await message.scrollIntoViewIfNeeded();
  await expect(message).toBeInViewport();
  const before = await measure();

  await page.getByRole("button", { name: "Werbeplan aktualisieren" }).evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  const toast = page.locator(".ui-toast--success");
  await expect(toast).toBeVisible();
  expect(await measure()).toEqual(before);

  await page.clock.fastForward(4_001);
  await expect(toast).toHaveCount(0);
  expect(await measure()).toEqual(before);
});

test("a module toggle refreshes the shared settings revision without discarding its draft", async ({ page }) => {
  const fixture = await installModule(page, "ads", "toggle-and-save", 1920, 1080);
  const message = page.getByRole("textbox", { name: "Automatische Werbepause" });
  await message.fill("Entwurf bleibt nach dem Umschalten erhalten.");

  const enabled = page.getByRole("switch", { name: /Werbung/u });
  await enabled.click();
  await fixture.toggleRequestStarted();
  await expect(enabled).toBeDisabled();
  const save = page.getByRole("button", { name: "Speichern" });
  try {
    await expect(save).toBeDisabled();
  } finally {
    fixture.releaseToggleRequest();
  }
  await expect(enabled).toBeChecked();
  await expect.poll(() => fixture.settingsReadRevisions().at(-1)).toBe(2);
  await expect(enabled).not.toBeChecked();
  await expect(message).toHaveValue("Entwurf bleibt nach dem Umschalten erhalten.");

  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(fixture.submittedRevision).toBe(2);
  await expect(message).toHaveValue("Entwurf bleibt nach dem Umschalten erhalten.");
});

test("a command palette module toggle keeps Save disabled until settings refresh", async ({ page }) => {
  const fixture = await installModule(page, "ads", "toggle-and-save", 1920, 1080);
  const message = page.getByRole("textbox", { name: "Automatische Werbepause" });
  await message.fill("Entwurf bleibt nach dem Paletten-Umschalten erhalten.");

  await page.locator(".dashboard-header__palette-trigger").click();
  const palette = page.getByRole("dialog");
  await palette.getByRole("combobox").fill("Werbung aus");
  await palette.locator('[data-command-palette-item-id="action:ads-off"]').click();
  await expect(palette).toBeHidden();
  await fixture.toggleRequestStarted();

  const save = page.getByRole("button", { name: "Speichern" });
  try {
    await expect(save).toBeDisabled();
  } finally {
    fixture.releaseToggleRequest();
  }
  await expect.poll(() => fixture.settingsReadRevisions().at(-1)).toBe(2);
  await expect(message).toHaveValue("Entwurf bleibt nach dem Paletten-Umschalten erhalten.");
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(fixture.submittedRevision).toBe(2);
});

test("Ads refresh explains when its read permission is missing", async ({ page }) => {
  await installModule(page, "ads", "refresh-scope-missing", 1280, 800);
  await page.getByRole("button", { name: "Werbeplan aktualisieren" }).click();
  await expect(page.locator(".ui-toast")).toContainText("channel:read:ads");
  await expect(page.locator(".ui-toast")).toContainText("Autorisiere Ads für diesen Kanal erneut");
  await expectToastBelowPageHeader(page);
});

test("mobile Ads save failures stay visible without moving the header", async ({ page }) => {
  await installModule(page, "ads", "save-error", 390, 844);
  const header = page.locator(".settings-page > .page-header");
  const message = page.getByRole("textbox", { name: "Automatische Werbepause" });
  await expect(header).toBeVisible();
  await expect(message).toBeVisible();
  const headerAndColumns = await page.evaluate(() => {
    const headerBox = document.querySelector(".settings-page > .page-header")?.getBoundingClientRect();
    const columnsBox = document.querySelector(".settings-page__columns")?.getBoundingClientRect();
    const actionsBox = document.querySelector(".settings-page > .page-header .page-header__right")?.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>(".settings-page > .page-header");
    return headerBox === undefined || columnsBox === undefined || actionsBox === undefined || header === null
      ? null
      : { headerBottom: headerBox.bottom, actionsBottom: actionsBox.bottom, columnsTop: columnsBox.top, headerHeight: headerBox.height, columnsHeight: columnsBox.height, display: getComputedStyle(header).display, rows: getComputedStyle(header).gridTemplateRows };
  });
  expect(headerAndColumns, JSON.stringify(headerAndColumns)).not.toBeNull();
  expect(headerAndColumns?.actionsBottom ?? 0, JSON.stringify(headerAndColumns)).toBeLessThanOrEqual(headerAndColumns?.headerBottom ?? Number.NEGATIVE_INFINITY);
  expect(headerAndColumns?.columnsTop ?? 0, JSON.stringify(headerAndColumns)).toBeGreaterThanOrEqual(headerAndColumns?.headerBottom ?? Number.POSITIVE_INFINITY);
  const before = await header.evaluate((element) => element.getBoundingClientRect().height);
  await message.fill("Neue Ansage");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.locator(".ui-toast")).toContainText("Die Ansagen-Einstellungen konnten nicht gespeichert werden.");
  await expectToastBelowPageHeader(page);
  await expectMobileToastOverlay(page);
  const after = await header.evaluate((element) => element.getBoundingClientRect().height);
  expect(after).toBe(before);
});

test("missing Ads read scope shows the authorization action without stale schedule state", async ({ page }) => {
  const { scheduleRequests } = await installModule(page, "ads", "missing-scope", 1280, 800);
  await expect(page.getByRole("heading", { name: "Benötigte Broadcaster-Berechtigungen" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Broadcaster-Berechtigungen erteilen" })).toHaveAttribute("href", /broadcaster-scopes\/ads/u);
  await expect(page.locator(".ads-schedule-summary")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: /Werbung/u })).not.toBeChecked();
  expect(scheduleRequests()).toBe(0);
});

test("Raid settings use compact unframed message fields, stacked unit inputs, and selected target styling", async ({ page }) => {
  await installModule(page, "raid", "ready", 1920, 1080);
  await expect(page.getByRole("heading", { level: 1, name: "Raid-Ankündigungen & Shoutout" })).toBeVisible();
  await expectHeaderAndColumnsToAlign(page);
  await expect(page.getByRole("button", { name: "Speichern" })).toBeVisible();
  await expect(page.getByText(/Helix/iu)).toHaveCount(0);
  await expect(page.locator(".settings-page__column").nth(1).locator(".ui-settings-editor__message")).toBeVisible();

  const message = page.locator(".ui-settings-editor__message").first();
  expect(await page.locator(".ui-settings-editor__message").count()).toBe(2);
  const messageStyles = await message.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderWidth: style.borderWidth, backgroundColor: style.backgroundColor };
  });
  expect(messageStyles.borderWidth).toBe("0px");
  expect(messageStyles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  await expect(message.locator(".ui-settings-editor__message-heading strong")).toHaveCount(1);
  await expect(message.locator(".ui-settings-editor__message-heading span")).toHaveCount(1);
  const labelBox = await message.locator(".mantine-InputWrapper-label").boundingBox();
  expect(labelBox?.width).toBeLessThanOrEqual(1);
  const textareaBox = await message.getByRole("textbox").boundingBox();
  expect(textareaBox?.height).toBeLessThanOrEqual(80);

  const threshold = page.getByRole("spinbutton", { name: "Text-Schwelle" });
  const unitInput = page.locator(".unit-input").filter({ has: threshold });
  const unitGeometry = await unitInput.evaluate((element) => {
    const label = element.querySelector(".ui-field__label")?.getBoundingClientRect();
    const input = element.querySelector("input")?.getBoundingClientRect();
    return label === undefined || input === undefined
      ? null
      : { labelBottom: label.bottom, inputTop: input.top, width: element.getBoundingClientRect().width };
  });
  expect(unitGeometry).not.toBeNull();
  expect(unitGeometry?.labelBottom).toBeLessThanOrEqual(unitGeometry?.inputTop ?? Number.POSITIVE_INFINITY);
  expect(unitGeometry?.width).toBeLessThanOrEqual(230);

  await page.getByRole("button", { name: "Ziel für vollen Raid-Text", exact: true }).click();
  const selected = page.locator(".ui-chat-target-field__option.is-selected");
  const selectedColors = await selected.evaluate((element) => {
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    const resolveColor = (value: string): string => {
      document.body.insertAdjacentHTML("beforeend", '<span data-color-probe></span>');
      const probe = document.querySelector<HTMLElement>("[data-color-probe]");
      if (probe === null) return "";
      probe.style.color = value;
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    return {
      border: style.borderTopColor,
      selectionBorder: resolveColor(root.getPropertyValue("--color-selection-border").trim()),
      background: style.backgroundColor,
      selectionSurface: resolveColor(root.getPropertyValue("--color-selection-surface").trim()),
    };
  });
  expect(selectedColors.border).toBe(selectedColors.selectionBorder);
  expect(selectedColors.background).toBe(selectedColors.selectionSurface);
});

test("Raid message-off state keeps one title and its status", async ({ page }) => {
  await installModule(page, "raid", "raid-message-off", 1280, 800);
  const shortMessage = page.locator(".ui-settings-editor__message").filter({ has: page.getByRole("textbox", { name: "Kurzer Dankestext" }) });
  await expect(shortMessage.locator(".ui-settings-editor__message-heading strong")).toHaveText("Kurzer Dankestext");
  await expect(shortMessage.locator(".ui-settings-editor__message-heading span")).toHaveText("Aus");
  await expect(shortMessage.locator(".ui-settings-editor__message-heading")).toHaveCount(1);
  const duplicateLabelWidth = await shortMessage.locator(".mantine-InputWrapper-label").evaluate((element) => getComputedStyle(element).width);
  expect(duplicateLabelWidth).toBe("1px");
});

test("Raid navigation is short and operator read-only fields remain in both sections", async ({ page }) => {
  await installModule(page, "raid", "operator", 1280, 800);
  await expect(page.getByRole("link", { name: "Raid & Shoutout" })).toBeVisible();
  await expect(page.getByText("Nur Broadcaster und Verwalter dürfen Module ändern.")).toBeVisible();
  await expect(page.locator("dl.ui-settings-editor__properties")).toHaveCount(2);
  const properties = page.locator("dl.ui-settings-editor__properties");
  await expect(properties.nth(0)).toContainText("Text-Schwelle");
  await expect(properties.nth(1)).toContainText("Shoutout-Schwelle");
  await expect(properties.nth(1)).toContainText("Kurzer Dankestext");
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("operator Ads permissions stay on the header and locked controls", async ({ page }) => {
  await installModule(page, "ads", "operator", 1280, 800);
  await expect(page.locator(".page-header__lock")).toHaveCount(1);
  await expect(page.locator("#ads-schedule-refresh-reason")).not.toBeVisible();
  const refresh = page.getByRole("button", { name: "Werbeplan aktualisieren" });
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute("title", /dürfen den Werbeplan aktualisieren/u);
  const snooze = page.getByRole("button", { name: /Snooze · 2 verfügbar/u });
  await expect(snooze).toBeDisabled();
  await expect(snooze).toHaveAttribute("title", /dürfen Werbepausen verschieben/u);
  await expect(page.getByTestId("ads-snooze-result-slot")).not.toContainText("dürfen");
});
