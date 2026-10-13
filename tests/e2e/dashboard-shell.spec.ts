import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import type { ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";

test.use({ locale: "en-US" });

const channelId = "shell-e2e";
const paletteShortcut = async (page: Page): Promise<string> => page.evaluate(() =>
  /Mac|iPhone|iPad|iPod/u.test(navigator.platform || navigator.userAgent) ? "Meta+k" : "Control+k",
);
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

test("a platform admin can enter Setup and reach Platform with no released channels", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/channels") {
      await fulfillJson(route, { channels: [], viewerUserId: "platform-admin", platformAdmin: true, viewerIsBot: false });
    } else if (pathname === "/api/platform") {
      await fulfillJson(route, { channels: [] });
    } else if (pathname === "/api/platform/audit") {
      await fulfillJson(route, { entries: [], nextCursor: null });
    } else {
      await fulfillJson(route, {});
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Setup" }).click();
  await expect(page).toHaveURL("/platform");
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Operator" })).toBeVisible();
});

const captureShell = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
};

test("Cmd/Ctrl+K opens navigation to inactive Timer; account palette selection survives reload", async ({ page }) => {
  await installDashboardFixture(page);
  await page.goto(`/channels/${channelId}`);
  await expect(page.getByRole("heading", { name: "Shell Channel", level: 1 })).toBeVisible();

  await page.keyboard.press(await paletteShortcut(page));
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
  await page.keyboard.press(await paletteShortcut(page));
  const palette = page.getByRole("dialog");
  await palette.getByRole("combobox").fill("Members");
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog", { name: "Discard changes?" });
  await expect(dialog).toBeVisible();
  const dialogGap = await page.evaluate(() => {
    const description = document.querySelector(".ui-dialog__description")?.getBoundingClientRect();
    const actions = document.querySelector(".ui-confirm-dialog__actions")?.getBoundingClientRect();
    return description === undefined || actions === undefined ? Number.POSITIVE_INFINITY : actions.top - description.bottom;
  });
  expect(dialogGap).toBeLessThanOrEqual(24);
  await dialog.getByRole("button", { name: "Continue editing" }).click();
  await expect(page).toHaveURL(`/channels/${channelId}/modules/chat_voting`);
  await expect(question).toHaveValue("Draft before palette navigation");
  await expect(question).toBeFocused();

  await question.fill("Draft before mode switch");
  await page.getByRole("button", { name: "Live" }).click();
  dialog = page.getByRole("dialog", { name: "Discard changes?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Continue editing" }).click();
  await expect(page).toHaveURL(`/channels/${channelId}/modules/chat_voting`);
  await expect(question).toHaveValue("Draft before mode switch");
});

test("the mobile drawer moves and traps focus, makes the page inert, and returns focus on Escape", async ({ page }) => {
  await installDashboardFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/channels/${channelId}/modules/chat_voting`);
  const burger = page.getByRole("button", { name: "Open sidebar" });
  await burger.click();

  const firstLink = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link").first();
  const searchButton = page.getByRole("button", { name: "Search everything" });
  await expect(firstLink).toBeFocused();
  await expect(page.locator(".dashboard-shell__main")).toHaveAttribute("inert", "");
  await expect(page.locator(".dashboard-shell__header-content")).toHaveAttribute("inert", "");
  await searchButton.focus();
  await page.keyboard.press("Tab");
  await expect(firstLink).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(searchButton).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(burger).toBeFocused();
});

test("the macOS shortcut preserves Ctrl+K in editable fields and opens with Cmd+K", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Object.getPrototypeOf(navigator), "platform", { configurable: true, get: () => "MacIntel" });
  });
  await installDashboardFixture(page);
  await page.goto(`/channels/${channelId}/modules/chat_voting`);
  const question = page.getByRole("textbox", { name: "Question" });
  await question.focus();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(question).toBeFocused();
});

test("the shell header fits narrow widths and keeps the live status at medium widths", async ({ page }) => {
  await installDashboardFixture(page);
  await page.goto(`/channels/${channelId}/modules/chat_voting`);
  for (const width of [320, 390, 421, 480, 768, 769, 900, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".dashboard-header__channel-avatar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Search or run action …" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
    const overflow = await page.evaluate(() => {
      const visible = [...document.querySelectorAll<HTMLElement>(
        ".dashboard-header__brand, .dashboard-header__channel, .dashboard-header__mode, .dashboard-header__palette-trigger, .dashboard-header__account-trigger",
      )].filter((element) => getComputedStyle(element).display !== "none");
      return visible.some((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left < 0 || bounds.right > innerWidth;
      });
    });
    expect(overflow, `header controls fit at ${String(width)}px`).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator(".dashboard-header__stream")).toBeVisible();
});

test("palette, sidebar, and theme match the shell contract", async ({ page }) => {
  await installDashboardFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/channels/${channelId}/modules/chat_voting`);
  const activeEntry = page.locator(".sidebar-nav-link[aria-current='page']");
  const dotBefore = await activeEntry.locator(".status-led__dot").boundingBox();
  await page.keyboard.press(await paletteShortcut(page));
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible();
  const input = palette.getByRole("combobox");
  await expect(input).toBeFocused();
  await expect.poll(() => input.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  expect(await palette.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(620);
  await expect(palette.getByText("Participation", { exact: true })).toBeVisible();
  await expect(palette.locator(".command-palette__category")).toHaveCount(0);
  const dotDuringPalette = await activeEntry.locator(".status-led__dot").boundingBox();
  expect(dotDuringPalette?.x).toBe(dotBefore?.x);

  const defaultColors = await page.evaluate(() => ({
    background: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
    brand: getComputedStyle(document.documentElement).getPropertyValue("--brand").trim(),
  }));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitemradio", { name: "Indigo night" }).click();
  const indigoColors = await page.evaluate(() => ({
    background: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
    brand: getComputedStyle(document.documentElement).getPropertyValue("--brand").trim(),
  }));
  expect(indigoColors.background).not.toBe(defaultColors.background);
  expect(indigoColors.brand).not.toBe(defaultColors.brand);
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
