import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import type { ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";

test.use({ locale: "en-US" });

const channelId = "shell-e2e";
const timestamp = "2030-01-01T12:00:00.000Z";
const template: ChatVoteTemplate = {
  id: "shell-template",
  channelId,
  shortcut: "shell",
  title: "Shell draft",
  labels: ["Yes", "No"],
  freeTextMode: null,
  durationSeconds: 60,
  revision: 1,
  legacyAlias: null,
  lastUsedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const fulfillJson = async (route: Route, value: unknown): Promise<void> => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
};

const installDashboardFixture = async (page: Page): Promise<void> => {
  const modules = [
    { id: "chat_voting", enabled: true, settings: "{}" },
    { id: "timers", enabled: false, settings: "{}" },
  ];
  const channel = {
    channelId,
    login: "shell-e2e",
    displayName: "Shell Channel",
    language: "en",
    role: "manager",
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot: { status: "connected", reason: null, updatedAt: timestamp },
    botPermissions: { missingScopes: [] },
    broadcasterPermissions: { missingScopes: [] },
    moderator: { isModerator: true, checkedAt: timestamp, reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "shell-subscription", reason: null, updatedAt: timestamp },
    chatSubscriptionNeeded: false,
    modules,
    tokens: { botExpiresAt: "2099-01-01T00:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-01-01T00:00:00.000Z" },
    lastError: null,
  };

  await page.route("**/api/channels**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await fulfillJson(route, { channels: [channel], viewerUserId: "shell-viewer", bot: channel.bot, platformAdmin: false, viewerIsBot: false });
    } else if (pathname === `/api/channels/${channelId}/overview`) {
      await fulfillJson(route, { ...channel, activeModules: [{ moduleId: "chat_voting", settings: "{}" }] });
    } else if (pathname === `/api/channels/${channelId}/modules`) {
      await fulfillJson(route, { modules });
    } else if (pathname === `/api/channels/${channelId}/modules/chat_voting/current`) {
      await fulfillJson(route, { vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60 });
    } else if (pathname === `/api/channels/${channelId}/modules/chat_voting/templates`) {
      await fulfillJson(route, { templates: [template], count: 1, maximum: 100 });
    } else {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
  });
};

const captureShell = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
};

test("Cmd/Ctrl+K opens navigation to inactive Timer; account palette selection survives reload", async ({ page }) => {
  await installDashboardFixture(page);
  await page.goto(`/channels/${channelId}`);
  await expect(page.getByRole("heading", { name: "Shell Channel", level: 1 })).toBeVisible();

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("Timer");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/channels/${channelId}/modules/timers`);

  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitemradio", { name: "Indigo night" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo-nacht");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo-nacht");
});

test("sidebar, command palette, and mode changes all guard a dirty module draft", async ({ page }) => {
  await installDashboardFixture(page);
  await page.goto(`/channels/${channelId}/modules/chat_voting`);
  const question = page.getByRole("textbox", { name: "Question" });
  await expect(question).toHaveValue("Shell draft");

  await question.fill("Draft before sidebar navigation");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Members" }).click();
  let dialog = page.getByRole("dialog", { name: "Discard changes?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Continue editing" }).click();
  await expect(page).toHaveURL(`/channels/${channelId}/modules/chat_voting`);
  await expect(question).toHaveValue("Draft before sidebar navigation");

  await question.fill("Draft before palette navigation");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog");
  await palette.getByRole("combobox").fill("Members");
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog", { name: "Discard changes?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Continue editing" }).click();
  await expect(page).toHaveURL(`/channels/${channelId}/modules/chat_voting`);
  await expect(question).toHaveValue("Draft before palette navigation");

  await question.fill("Draft before mode switch");
  await page.getByRole("button", { name: "Live" }).click();
  dialog = page.getByRole("dialog", { name: "Discard changes?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Continue editing" }).click();
  await expect(page).toHaveURL(`/channels/${channelId}/modules/chat_voting`);
  await expect(question).toHaveValue("Draft before mode switch");
});

test("shell captures the desktop and mobile layouts without horizontal overflow", async ({ page }, testInfo) => {
  await installDashboardFixture(page);
  await page.goto(`/channels/${channelId}/modules/chat_voting`);
  for (const [width, height] of [[1920, 1080], [1280, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    if (width === 390) await page.getByRole("button", { name: "Open sidebar" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await captureShell(page, testInfo, `dashboard-shell-${String(width)}px`);
    if (width === 390) await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeInViewport();
  }
});
