import { expect, test, type Page } from "@playwright/test";

const channelId = "channel-a";
const timestamp = "2030-01-01T12:00:00.000Z";
const block = {
  channelId,
  name: "welcome",
  categoryId: "social",
  games: [],
  variants: [{ id: "default", conditions: {}, texts: ["Welcome back!"] }],
  revision: 3,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const timer = {
  id: "timer-welcome",
  name: "Welcome reminder",
  enabled: true,
  messageText: "{text.welcome}",
  chatTarget: "source_only",
  trigger: { type: "interval", live: { minutes: 30, minimumMessages: 5 } },
  revision: 4,
  nextRunAt: "2030-01-01T12:30:00.000Z",
  nextRunState: "live",
  lastRunAt: "2030-01-01T11:30:00.000Z",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const json = (value: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(value),
});

interface ApiOptions {
  failLibraryRefetch?: boolean;
  holdTimerSave?: boolean;
  holdBlockSave?: boolean;
}

const installApi = async (page: Page, options: ApiOptions = {}) => {
  let libraryReads = 0;
  let markSaveStarted: () => void = () => undefined;
  const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
  let releaseSave: () => void = () => undefined;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "csrf-431" }));
    if (pathname === `/api/channels/${channelId}/settings`) return route.fulfill(json({ timeZone: "Europe/Berlin", revision: 1 }));
    if (pathname === `/api/channels/${channelId}/template-variables`) return route.fulfill(json({ variables: [
      { name: "user", moduleId: "host", source: "system", group: "context", contexts: ["event"], description: "Viewer login", sample: "viewer" },
      { name: "text.welcome", moduleId: "text_library", isTextBlock: true, sample: "Welcome back!", contexts: ["event"] },
    ] }));
    if (pathname === `/api/channels/${channelId}/modules/text_library/library`) {
      libraryReads += 1;
      if (options.failLibraryRefetch && libraryReads > 1) return route.fulfill(json({ error: "offline" }, 503));
      return route.fulfill(json({
        blocks: [block],
        categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: timestamp, updatedAt: timestamp }],
        settings: { revision: 3, graphRevision: 4, updatedAt: timestamp },
        usages: { welcome: [] },
        reservedNames: [],
      }));
    }
    if (pathname === `/api/channels/${channelId}/modules/timers/timers` && method === "GET") {
      return route.fulfill(json({ timers: [timer] }));
    }
    if ((pathname === `/api/channels/${channelId}/modules/timers/timers` && method === "POST") ||
        (pathname === `/api/channels/${channelId}/modules/timers/timers/${timer.id}` && method === "PATCH")) {
        if (options.holdTimerSave) {
          markSaveStarted();
          await saveGate;
        }
        return route.fulfill(json({ timer: { ...timer, revision: 5, updatedAt: timestamp } }));
    }
    if (pathname === `/api/channels/${channelId}/modules/timers/event-time-sources`) return route.fulfill(json({ sources: [] }));
    if (pathname.endsWith("/template-preview")) return route.fulfill(json({ text: "Resolved welcome", diagnostics: [] }));
    if (pathname.endsWith("/games")) return route.fulfill(json({ games: [] }));
    if (pathname === `/api/channels/${channelId}/modules/text_library/blocks/welcome` && method === "DELETE") {
      return route.fulfill(json({
        error: "text_library_block_in_use",
        usages: [
          { kind: "command", label: "!welcome" },
          { kind: "timer", label: "Welcome reminder" },
        ],
      }, 409));
    }
    if (pathname === `/api/channels/${channelId}/modules/text_library/blocks/welcome` && method === "PATCH") {
      if (options.holdBlockSave) {
        markSaveStarted();
        await saveGate;
      }
      return route.fulfill(json({ block: { ...block, name: "welcome_updated", revision: 4, updatedAt: timestamp } }));
    }
    return route.fulfill(json({}));
  });
  return { saveStarted, releaseSave };
};

const gotoPanel = async (page: Page, panel: "text_library" | "timers", operator = false): Promise<void> => {
  await page.goto(`/tests/e2e/module-panels-stability-fixture.html?panel=${panel}&lang=en${operator ? "&operator=1" : ""}`);
  await expect(page.locator(".collection-page")).toBeVisible();
};

const openFirstRow = async (page: Page, panel: "text_library" | "timers"): Promise<void> => {
  const rowName = panel === "text_library" ? /\{text\.welcome\}/u : /Welcome reminder/u;
  await page.getByRole("button", { name: rowName }).click();
  await expect(page.locator(".collection-page")).toHaveAttribute("data-detail-open", "true");
};

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

test("text block and timer editors scroll inside the mobile collection detail", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);

  for (const panel of ["text_library", "timers"] as const) {
    await gotoPanel(page, panel);
    if (panel === "text_library") await openFirstRow(page, panel);
    else await page.locator(".collection-page__list-toolbar").getByRole("button", { name: /Create timer/u }).click();
    const detail = page.locator(".collection-page__detail");
    const scrollState = await detail.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(scrollState.overflowY).toBe("auto");
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
    await detail.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const headerBackground = await detail.locator(".page-header").evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(headerBackground).not.toBe("rgba(0, 0, 0, 0)");
    const lastContent = panel === "text_library" ? page.locator(".text-library__settings") : page.locator(".ui-chat-target-field");
    await expect(lastContent).toBeInViewport();
    await expect(page.locator(".page-header__save")).toBeVisible();
    await page.goto("about:blank");
  }
});

test("the single initial timer can open its mobile detail", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);
  await gotoPanel(page, "timers");
  await expect(page.getByRole("button", { name: /Welcome reminder/u })).toBeVisible();
  await expect(page.locator(".collection-page")).toHaveAttribute("data-detail-open", "false");
  await page.getByRole("button", { name: /Welcome reminder/u }).click();
  await expect(page.locator(".timer-editor")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome reminder" })).toBeVisible();
});

test("discarding a name-only timer edit keeps its resolved text preview", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installApi(page);
  await gotoPanel(page, "timers");
  await expect(page.getByText("Resolved welcome")).toBeVisible();
  await page.getByRole("textbox", { name: "Name" }).fill("Edited reminder");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByText("Resolved welcome")).toBeVisible();
});

test("a raced blocked block deletion shows the response usages when refetch fails", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installApi(page, { failLibraryRefetch: true });
  await gotoPanel(page, "text_library");
  await openFirstRow(page, "text_library");
  const overflowTrigger = page.locator(".page-header__overflow-trigger");
  if (await overflowTrigger.isVisible()) {
    await overflowTrigger.click();
    await page.locator(".page-header__overflow").getByRole("button", { name: /Delete/u }).click();
  } else {
    await page.getByRole("button", { name: "Delete text block", exact: true }).click();
  }
  await page.getByRole("button", { name: "Delete text block: welcome", exact: true }).click();
  const result = page.getByRole("dialog").filter({ hasText: "!welcome" });
  await expect(result).toContainText("Welcome reminder");
});

test("the mobile back control stays in place and disabled during a timer save", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page, { holdTimerSave: true });
  await gotoPanel(page, "timers");
  await page.locator(".collection-page__list-toolbar").getByRole("button", { name: /Create timer/u }).click();
  const back = page.locator(".collection-page__detail-back");
  const before = await back.boundingBox();
  await page.getByRole("textbox", { name: "Name" }).fill("New reminder");
  await page.getByRole("textbox", { name: "Message" }).fill("Hello, chat!");
  await page.locator(".ui-save-bar__save").click();
  await api.saveStarted;
  await expect(back).toBeVisible();
  await expect(back).toBeDisabled();
  expect(await back.boundingBox()).toEqual(before);
  api.releaseSave();
});

test("the mobile back control stays in place and disabled during a text block save", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installApi(page, { holdBlockSave: true });
  await gotoPanel(page, "text_library");
  await openFirstRow(page, "text_library");
  const back = page.locator(".collection-page__detail-back");
  const before = await back.boundingBox();
  await page.getByRole("textbox", { name: "Name" }).fill("welcome_updated");
  await page.locator(".ui-save-bar__save").click();
  await api.saveStarted;
  await expect(back).toBeVisible();
  await expect(back).toBeDisabled();
  expect(await back.boundingBox()).toEqual(before);
  api.releaseSave();
});

test("operators see disabled timer and text block delete actions with reasons", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installApi(page);

  for (const panel of ["text_library", "timers"] as const) {
    await gotoPanel(page, panel, true);
    await openFirstRow(page, panel);
    const overflowTrigger = page.locator(".page-header__overflow-trigger");
    const hasOverflow = await overflowTrigger.isVisible();
    if (hasOverflow) await overflowTrigger.click();
    const menu = page.locator(".page-header__overflow");
    const deleteAction = panel === "text_library"
      ? page.getByRole("button", { name: "Delete text block", exact: true })
      : menu.getByRole("button", { name: /Delete/u });
    await expect(deleteAction).toBeVisible();
    await expect(deleteAction).toBeDisabled();
    if (panel === "text_library") await expect(page.locator(".text-library__delete-actions .lock-reason")).toBeVisible();
    else await expect(menu.locator(".lock-reason")).toBeVisible();
    await page.goto("about:blank");
  }
});
