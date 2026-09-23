import { expect, test, type Page, type TestInfo } from "@playwright/test";

test.use({ locale: "de-DE" });

const channel = {
  channelId: "kanal-editor-stage2",
  login: "brotkrumen-kanal",
  displayName: "Brotkrumen-Kanal",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-20T08:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "abo-editor-stage2", reason: null, updatedAt: "2026-09-20T08:00:00.000Z" },
  tokens: {
    botExpiresAt: "2099-09-20T08:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-09-20T08:00:00.000Z",
  },
  lastError: null,
};

const modules = [
  { id: "ads", enabled: true, settings: "{}" },
  { id: "raid", enabled: true, settings: "{}" },
  { id: "text_commands", enabled: true, settings: "{}" },
  { id: "channel_events", enabled: true, settings: "{}" },
];

const member = {
  userId: "member-editor-stage2",
  login: "max",
  displayName: "Max",
  profileImageUrl: null,
  role: "operator",
  joinedAt: "2026-09-19T00:00:00.000Z",
};

const capture = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth, `${name} should not overflow horizontally at ${String(width)}px`).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: testInfo.outputPath(`${name}-${String(width)}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
};

/** `events` is a param (not baked into the route) so #190/#191's cause-icon
 *  test can serve one event with a diagnostic reason while every other test
 *  here keeps the empty feed its screenshots already expect. */
const installMocks = async (page: Page, events: readonly unknown[] = []): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ channels: [channel], bot: channel.bot, platformAdmin: true }),
      });
      return;
    }
    if (pathname === `/api/channels/${channel.channelId}/overview`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...channel, activeModules: modules.map(({ id, settings }) => ({ moduleId: id, settings })) }),
      });
      return;
    }
    if (pathname === `/api/channels/${channel.channelId}/modules`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ modules }) });
      return;
    }
    if (pathname === `/api/channels/${channel.channelId}/modules/text_commands/commands`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ commands: [{
          channelId: channel.channelId,
          name: "hallo",
          text: "Hallo {user}",
          kind: "text",
          enabled: true,
          minimumTier: "everyone",
          cooldownSeconds: 5,
          aliases: [],
          userCooldownSeconds: 0,
          streamCondition: "any",
          responseType: "say",
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }),
      });
      return;
    }
    if (pathname === `/api/channels/${channel.channelId}/events`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: events, nextCursor: null }) });
      return;
    }
    if (pathname === `/api/channels/${channel.channelId}/members`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ members: [member], broadcasterCount: 1, viewerUserId: "viewer-editor-stage2", nextCursor: null }),
      });
      return;
    }
    if (pathname === "/api/platform") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ channels: [{
          channelId: channel.channelId,
          login: channel.login,
          displayName: channel.displayName,
          fullConsent: true,
          memberCounts: { broadcaster: 1, manager: 1, operator: 0 },
          broadcasterConnected: true,
        }] }),
      });
      return;
    }
    if (pathname === "/api/platform/audit") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [], nextCursor: null }) });
      return;
    }
    if (pathname === `/api/platform/channels/${channel.channelId}/members`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ members: [member], broadcasterCount: 1, viewerUserId: "viewer-editor-stage2", nextCursor: null }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
};

test("editor stage 2 pages fit at 1280px and 390px and produce review screenshots", async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  await installMocks(page);

  await page.goto(`/channels/${channel.channelId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await capture(page, testInfo, "01-overview");

  await page.goto(`/channels/${channel.channelId}/modules/text_commands`);
  const commandRow = page.getByRole("row", { name: /!hallo/ });
  await expect(commandRow).toBeVisible();
  await capture(page, testInfo, "07-commands");
  await page.setViewportSize({ width: 1280, height: 900 });
  await commandRow.click();
  await expect(page.getByRole("region", { name: "Eigenschaften von !hallo" })).toBeVisible();
  await capture(page, testInfo, "08-command-inspector");

  await page.goto(`/channels/${channel.channelId}/events`);
  await expect(page.getByText("Noch keine Ereignisse protokolliert.")).toBeVisible();
  await capture(page, testInfo, "10-events");

  await page.goto(`/channels/${channel.channelId}/members`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Zugriff vergeben" }).click();
  await expect(page.getByRole("textbox", { name: "Twitch-Name" })).toBeVisible();
  await capture(page, testInfo, "11-members");

  await page.goto("/platform");
  const platformRow = page.getByRole("row", { name: /brotkrumen-kanal/ });
  await expect(platformRow).toBeVisible();
  await capture(page, testInfo, "12-platform");
  await page.setViewportSize({ width: 1280, height: 900 });
  await platformRow.click();
  await expect(page.getByRole("region", { name: "Kanal bearbeiten: Brotkrumen-Kanal" })).toBeVisible();
  await capture(page, testInfo, "13-platform-inspector");

  await page.goto(`/channels/${channel.channelId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.keyboard.press("Meta+K");
  await expect(page.getByRole("dialog")).toBeVisible();
  await capture(page, testInfo, "14-spotlight");
});

// #190/#191: the event row's cause icon, exercised in a real browser --
// jsdom's component tests can't prove real visibility (Mantine's popover
// never resolves its exit transition without a genuine `transitionend`).
test("events page cause icon: hover shows it, Escape hides it, tap opens it", async ({ page }) => {
  await installMocks(page, [{
    eventId: "evt-cause-1",
    createdAt: "2026-09-20T09:00:00.000Z",
    moduleId: "host",
    triggerId: "trigger-cause-1",
    code: "host.chat.failed",
    detail: JSON.stringify({ reason: "rate_limited" }),
    actorUserId: null,
    actorLogin: null,
    actorDisplayName: null,
  }]);

  await page.goto(`/channels/${channel.channelId}/events`);
  const trigger = page.getByRole("button", { name: /^Ursache anzeigen:/ });
  await expect(trigger).toBeVisible();

  await trigger.hover();
  await expect(page.getByText("Twitch-Abklingzeit aktiv")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByText("Twitch-Abklingzeit aktiv")).toBeHidden();

  // Move off the trigger first so the click below starts from a clean,
  // un-hovered state. This popover treats a click the same way it treats a
  // tap (see `ui/Popover.tsx`) -- there's no separate touch code path to
  // exercise, so a click stands in for it here.
  await page.mouse.move(0, 0);
  await trigger.click();
  await expect(page.getByText("Twitch-Abklingzeit aktiv")).toBeVisible();

  // The click on the icon must not have opened the inspector.
  await expect(page.getByText("Vorgang")).toHaveCount(0);
});
