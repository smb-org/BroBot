import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "issue-510-quick-actions";

const setupQuickActionCockpit = async (
  page: Page,
  onVariableAvailabilityChange: (available: boolean) => void,
  deferCounterLoad = false,
  includeStreamMarker = false,
  streamState = "online",
  viewerUserId = "viewer-510",
) => {
  const modules = [
    { id: "text_commands", enabled: true, settings: "{}" },
    ...(includeStreamMarker ? [{ id: "channel_events", enabled: true, settings: "{}" }] : []),
  ];
  const channel = {
    channelId,
    login: "demo-kanal",
    displayName: "Demo Kanal",
    language: "de",
    role: "manager",
    streamState,
    streamStartedAt: new Date(Date.now() - 60_000).toISOString(),
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: new Date().toISOString() },
    botPermissions: { missingScopes: [] },
    broadcasterPermissions: { missingScopes: [] },
    moderator: { isModerator: true, checkedAt: new Date().toISOString(), reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "sub-510", reason: null, updatedAt: new Date().toISOString() },
    chatSubscriptionNeeded: false,
    modules,
    tokens: {
      botExpiresAt: "2099-09-20T08:00:00.000Z",
      loginStatus: "connected",
      loginReason: null,
      loginExpiresAt: "2099-09-20T08:00:00.000Z",
    },
    lastError: null,
  };
  const variable = { channelId, name: "score", value: 4, description: "Score", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] };
  let score = 4;
  let valueRouteCalls = 0;
  let counterLoadPending = false;
  let releaseCounterLoad: (() => void) | undefined;
  let markerRouteCalls = 0;
  const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/csrf") {
      await route.fulfill(json({ token: "test-csrf" }));
      return;
    }
    if (pathname === "/api/channels") {
      await route.fulfill(json({ channels: [channel], bot: channel.bot, viewerUserId }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill(json({ ...channel, viewerCount: 42, activeModules: [{ moduleId: "text_commands", settings: "{}" }] }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules`) {
      await route.fulfill(json({ modules }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/settings`) {
      await route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 0, defaultChatTarget: "source_only", defaultChatTargetRevision: 1 }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/events`) {
      await route.fulfill(json({ entries: [], nextCursor: null }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/overlays`) {
      await route.fulfill(json({ overlays: [], maximum: 20, elementMaximum: 20 }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/system`) {
      await route.fulfill(json({ broadcasterConnection: "connected", bot: channel.bot, botPermissions: channel.botPermissions,
        broadcasterPermissions: channel.broadcasterPermissions, chatSubscription: channel.chatSubscription, chatSubscriptionNeeded: false,
        subscriptions: [], tokens: channel.tokens }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/variables`) {
      const available = await page.evaluate(() => document.documentElement.dataset.counterVariables !== "off");
      onVariableAvailabilityChange(available);
      await route.fulfill(json({ variables: available ? [{ ...variable, value: score }] : [], count: available ? 1 : 0, maximum: 50 }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/broadcast/markers/availability` && route.request().method() === "GET") {
      const scopeAvailable = await page.evaluate(() => document.documentElement.dataset.markerScope !== "missing");
      await route.fulfill(json({ manageScopeAvailable: scopeAvailable }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/broadcast/markers` && route.request().method() === "POST") {
      markerRouteCalls += 1;
      await route.fulfill(json({ result: "created", positionSeconds: 323 }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/text_commands/commands`) {
      if (deferCounterLoad) {
        counterLoadPending = true;
        await new Promise<void>((resolve) => {
          releaseCounterLoad = () => { counterLoadPending = false; resolve(); };
        });
      }
      const available = await page.evaluate(() => document.documentElement.dataset.counterVariables !== "off");
      await route.fulfill(json({ commands: [], variables: available ? [{ name: "score", value: score, description: "Score" }] : [] }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/variables/score/value` &&route.request().method() === "POST") {
      valueRouteCalls += 1;
      const body = route.request().postDataJSON() as { operation: string; amount: number };
      if (body.operation === "add") score += body.amount;
      await route.fulfill(json({ variable: { ...variable, value: score } }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/quick-actions/test-message` && route.request().method() === "POST") {
      await route.fulfill(json({ result: "sent" }));
      return;
    }
    await route.fulfill(json({}));
  });

  return {
    valueRouteCalls: () => valueRouteCalls,
    counterLoadIsPending: () => counterLoadPending,
    releaseCounterLoad: () => { releaseCounterLoad?.(); },
    markerRouteCalls: () => markerRouteCalls,
    hideVariables: async () => page.evaluate(() => { document.documentElement.dataset.counterVariables = "off"; }),
    showVariables: async () => page.evaluate(() => { delete document.documentElement.dataset.counterVariables; }),
    setMarkerScopeAvailable: async (available: boolean) => page.evaluate((value) => {
      if (value) delete document.documentElement.dataset.markerScope;
      else document.documentElement.dataset.markerScope = "missing";
    }, available),
  };
};

const actionGridBox = async (page: Page) => {
  const bounds = await page.locator(".live-cockpit-actions__grid").boundingBox();
  expect(bounds).not.toBeNull();
  return { x: bounds?.x, y: bounds?.y, width: bounds?.width, height: bounds?.height };
};

test("keeps command palette action rows fixed at desktop and mobile widths", async ({ page }) => {
  const actions = await setupQuickActionCockpit(page, () => {});
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}`);

  const openPalette = async () => {
    await page.keyboard.press(await page.evaluate(() => /Mac|iPhone|iPad|iPod/u.test(navigator.platform || navigator.userAgent) ? "Meta+k" : "Control+k"));
    const palette = page.locator(".command-palette");
    await expect(palette).toBeVisible();
    return palette;
  };
  const measureRows = async (palette: ReturnType<typeof page.locator>, expectedHeight: number) => {
    const rows = palette.locator('[data-command-palette-item-id^="action:"]');
    await expect(rows).toHaveCount(6);
    const heights = await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
    expect(heights.every((height) => height === expectedHeight)).toBe(true);
    return heights;
  };
  const expectLongTitlesToFit = async (palette: ReturnType<typeof page.locator>) => {
    for (const itemId of ["action:channel-mute", "action:channel-pause"]) {
      const title = palette.locator(`[data-command-palette-item-id="${itemId}"] .command-palette__item-main`);
      expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  };

  let palette = await openPalette();
  const desktopAvailableHeights = await measureRows(palette, 42);
  await page.keyboard.press("Escape");
  await actions.hideVariables();
  palette = await openPalette();
  const desktopDisabledCounter = palette.locator('[data-command-palette-item-id="action:counter-plus-one"]');
  await expect(desktopDisabledCounter).toHaveAttribute("aria-disabled", "true");
  const desktopReasonId = await desktopDisabledCounter.getAttribute("aria-describedby");
  expect(desktopReasonId).not.toBeNull();
  await expect(palette.locator(`[id="${desktopReasonId ?? "missing-description"}"]`)).toHaveText("Keine numerischen Kanalvariablen verfügbar.");
  expect(await measureRows(palette, 42)).toEqual(desktopAvailableHeights);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await actions.showVariables();
  palette = await openPalette();
  const mobileAvailableHeights = await measureRows(palette, 58);
  await expectLongTitlesToFit(palette);
  await page.keyboard.press("Escape");
  await actions.hideVariables();
  palette = await openPalette();
  const mobileDisabledCounter = palette.locator('[data-command-palette-item-id="action:counter-plus-one"]');
  await expect(mobileDisabledCounter).toHaveAttribute("aria-disabled", "true");
  const mobileReasonId = await mobileDisabledCounter.getAttribute("aria-describedby");
  expect(mobileReasonId).not.toBeNull();
  await expect(palette.locator(`[id="${mobileReasonId ?? "missing-description"}"]`)).toHaveText("Keine numerischen Kanalvariablen verfügbar.");
  expect(await measureRows(palette, 58)).toEqual(mobileAvailableHeights);
  await expectLongTitlesToFit(palette);
});

test("shows both quick actions at desktop and mobile widths and keeps the grid fixed", async ({ page }, testInfo) => {
  const availabilityChanges: boolean[] = [];
  const actions = await setupQuickActionCockpit(page, (available) => { availabilityChanges.push(available); });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}`);

  const counter = page.getByRole("button", { name: "Zähler +1" });
  const message = page.getByRole("button", { name: "Testnachricht senden" });
  await expect(counter).toBeVisible();
  await expect(message).toBeVisible();
  const desktopGrid = await actionGridBox(page);
  await page.screenshot({ path: testInfo.outputPath("cockpit-1920.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(counter).toBeVisible();
  await expect(message).toBeVisible();
  const mobileGrid = await actionGridBox(page);
  await page.screenshot({ path: testInfo.outputPath("cockpit-390.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await counter.click();
  const popover = page.getByRole("dialog", { name: "Zähler +1" });
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name: "Ausführen" }).click();
  await expect(page.getByText("Neuer Wert: 5").first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("brobot-dashboard-counter-variable-v1:issue-510-quick-actions"))).toBe("score");
  expect(actions.valueRouteCalls()).toBe(1);
  await expect.poll(() => actionGridBox(page)).toEqual(mobileGrid);

  await message.click();
  await expect(page.getByText("Testnachricht gesendet.").first()).toBeVisible();
  await expect.poll(() => actionGridBox(page)).toEqual(mobileGrid);

  await actions.hideVariables();
  await expect(counter).toBeDisabled({ timeout: 8_000 });
  await expect(page.getByText("Keine numerischen Kanalvariablen verfügbar.").first()).toBeVisible();
  await expect.poll(() => actionGridBox(page)).toEqual(mobileGrid);
  expect(availabilityChanges).toContain(false);
  expect(desktopGrid.width).toBeGreaterThan(0);
});

test("keeps Counter Run disabled and guarded while its variable request is pending", async ({ page }) => {
  const actions = await setupQuickActionCockpit(page, () => {}, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}`);

  const counter = page.getByRole("button", { name: "Zähler +1" });
  await expect(counter).toBeEnabled();
  await counter.click();
  const popover = page.getByRole("dialog", { name: "Zähler +1" });
  const runButton = popover.getByRole("button", { name: "Ausführen" });
  await expect(runButton).toBeDisabled();
  await expect.poll(() => actions.counterLoadIsPending()).toBe(true);
  await expect(runButton).toHaveAttribute("title", "Variablen werden geladen …");
  const loadingHeight = (await page.locator(".live-action-frame-popover").boundingBox())?.height;
  await expect(popover.getByText("Kanalvariable", { exact: true })).toBeVisible();
  await expect(popover.locator(".live-action-content--counter__select-skeleton")).toBeVisible();

  const readinessDescriptionId = await runButton.getAttribute("aria-describedby");
  expect(readinessDescriptionId).not.toBeNull();
  await expect(page.locator(`#${readinessDescriptionId ?? ""}`)).toHaveText("Variablen werden geladen …");
  await runButton.evaluate((button) => {
    button.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(actions.valueRouteCalls()).toBe(0);

  actions.releaseCounterLoad();
  await expect(runButton).toBeEnabled();
  await expect(popover.getByRole("combobox", { name: "Kanalvariable" })).toBeVisible();
  const loadedHeight = (await page.locator(".live-action-frame-popover").boundingBox())?.height;
  expect(loadingHeight).not.toBeUndefined();
  expect(loadedHeight).toBe(loadingHeight);
  await runButton.click();
  await expect(page.getByText("Neuer Wert: 5").first()).toBeVisible();
  expect(actions.valueRouteCalls()).toBe(1);
});

test("shows the stream marker at desktop and mobile widths and keeps the grid fixed after feedback and scope changes", async ({ page }, testInfo) => {
  const actions = await setupQuickActionCockpit(page, () => {}, false, true, "online", channelId);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/channels/${channelId}`);

  const marker = page.getByRole("button", { name: "Stream-Marker setzen" });
  await expect(marker).toBeVisible();
  await expect(marker).toBeEnabled();
  const desktopGrid = await actionGridBox(page);
  await page.screenshot({ path: testInfo.outputPath("cockpit-marker-1920.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(marker).toBeVisible();
  const mobileGrid = await actionGridBox(page);
  await page.screenshot({ path: testInfo.outputPath("cockpit-marker-390.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await marker.click();
  await expect(page.getByText("Stream-Marker bei 5:23 gesetzt.").first()).toBeVisible();
  expect(actions.markerRouteCalls()).toBe(1);
  await expect.poll(() => actionGridBox(page)).toEqual(mobileGrid);

  await actions.setMarkerScopeAvailable(false);
  await expect(marker).toBeDisabled({ timeout: 8_000 });
  await expect(page.getByText("Broadcaster-Berechtigung fehlt.").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Berechtigung erteilen/u })).toHaveAttribute(
    "href", "/auth/channels/issue-510-quick-actions/broadcaster-scopes/broadcast",
  );
  await expect.poll(() => actionGridBox(page)).toEqual(mobileGrid);
  expect(desktopGrid.width).toBeGreaterThan(0);
});

