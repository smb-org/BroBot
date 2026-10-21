import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "issue-510-quick-actions";

const setupQuickActionCockpit = async (page: Page, onVariableAvailabilityChange: (available: boolean) => void) => {
  const modules = [{ id: "text_commands", enabled: true, settings: "{}" }];
  const channel = {
    channelId,
    login: "demo-kanal",
    displayName: "Demo Kanal",
    language: "de",
    role: "manager",
    streamState: "online",
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
  const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/csrf") {
      await route.fulfill(json({ token: "test-csrf" }));
      return;
    }
    if (pathname === "/api/channels") {
      await route.fulfill(json({ channels: [channel], bot: channel.bot, viewerUserId: "viewer-510" }));
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
    if (pathname === `/api/channels/${channelId}/modules/text_commands/commands`) {
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
    hideVariables: async () => page.evaluate(() => { document.documentElement.dataset.counterVariables = "off"; }),
  };
};

const actionGridBox = async (page: Page) => {
  const bounds = await page.locator(".live-cockpit-actions__grid").boundingBox();
  expect(bounds).not.toBeNull();
  return { x: bounds?.x, y: bounds?.y, width: bounds?.width, height: bounds?.height };
};

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
