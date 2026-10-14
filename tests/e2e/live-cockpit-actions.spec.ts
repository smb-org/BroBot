import { expect, test } from "@playwright/test";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

test("vote action keeps its draft while templates load and guards every close path", async ({ page }) => {
  const channelId = "kanal-live-actions";
  const modules = [{ id: "chat_voting", enabled: true, settings: "{}" }];
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
    chatSubscription: { status: "enabled", subscriptionId: "sub-live-actions", reason: null, updatedAt: new Date().toISOString() },
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
  const json = (value: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  let releaseTemplates: (() => void) | undefined;
  const templatesGate = new Promise<void>((resolve) => { releaseTemplates = resolve; });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/channels") {
      await route.fulfill(json({ channels: [channel], bot: channel.bot, viewerUserId: "operator-live-actions" }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/overview`) {
      await route.fulfill(json({ ...channel, viewerCount: 42, activeModules: [{ moduleId: "chat_voting", settings: "{}" }] }));
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
    if (pathname === `/api/channels/${channelId}/system`) {
      await route.fulfill(json({
        broadcasterConnection: "connected", bot: channel.bot, botPermissions: channel.botPermissions,
        broadcasterPermissions: channel.broadcasterPermissions, chatSubscription: channel.chatSubscription,
        chatSubscriptionNeeded: false, subscriptions: [], tokens: channel.tokens,
      }));
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
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/current`) {
      await route.fulfill(json({ vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
      return;
    }
    if (pathname === `/api/channels/${channelId}/modules/chat_voting/templates`) {
      await templatesGate;
      await route.fulfill(json({
        templates: [{ id: "saved-vote", title: "Gespeicherte Frage", labels: ["Ja", "Nein"], durationSeconds: 120 }],
        count: 1,
        maximum: 100,
      }));
      return;
    }
    await route.fulfill(json({}));
  });

  await page.goto(`/channels/${channelId}`);
  await page.getByRole("button", { name: "Abstimmung starten" }).click();
  const dialog = page.getByRole("dialog", { name: "Abstimmung starten" });
  const question = dialog.getByRole("textbox", { name: "Frage" });
  await question.fill("Welche Karte spielen wir?");

  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(page.getByRole("dialog", { name: "Eingaben verwerfen?" })).toBeVisible();
  await page.getByRole("button", { name: "Weiter bearbeiten" }).click();
  await expect(question).toHaveValue("Welche Karte spielen wir?");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Eingaben verwerfen?" })).toBeVisible();
  await page.getByRole("button", { name: "Weiter bearbeiten" }).click();
  await page.locator('[data-slot="dialog-backdrop"]').last().click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole("dialog", { name: "Eingaben verwerfen?" })).toBeVisible();
  await page.getByRole("button", { name: "Weiter bearbeiten" }).click();

  releaseTemplates?.();
  await expect(dialog.getByRole("button", { name: "Gespeichert" })).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.getByRole("button", { name: "Direkt erstellen" })).toHaveAttribute("aria-pressed", "true");
  await expect(question).toHaveValue("Welche Karte spielen wir?");

  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await page.getByRole("button", { name: "Eingaben verwerfen" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("group", { name: "Einrichten" }).getByRole("button", { name: "Einrichten" }).click();
  await expect(page).toHaveURL(`/channels/${channelId}/system`);
  await page.getByRole("button", { name: "Live" }).click();
  await expect(page).toHaveURL(`/channels/${channelId}`);
  await page.getByRole("button", { name: "Abstimmung starten" }).click();
  const guardedDialog = page.getByRole("dialog", { name: "Abstimmung starten" });
  const guardedQuestion = guardedDialog.getByRole("textbox", { name: "Frage" });
  await guardedQuestion.fill("Bleibt der Entwurf beim Wechsel erhalten?");
  const unloadWasPrevented = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(unloadWasPrevented).toBe(true);

  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Eingaben verwerfen?" })).toBeVisible();
  await page.getByRole("button", { name: "Weiter bearbeiten" }).click();
  await expect(guardedQuestion).toHaveValue("Bleibt der Entwurf beim Wechsel erhalten?");
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Eingaben verwerfen?" })).toBeVisible();
  await page.getByRole("button", { name: "Eingaben verwerfen" }).click();
  await expect(page).toHaveURL(`/channels/${channelId}/system`);
  await expect(page.getByRole("heading", { name: "System" })).toBeVisible();
});
