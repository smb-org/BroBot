import { expect, test, type Page } from "@playwright/test";

const channelId = "channel-overlay-palette-a11y";
const overlayId = "overlay-palette-a11y";
const channel = {
  channelId,
  login: "overlay-palette-a11y",
  displayName: "Overlay palette",
  language: "en",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-27T20:15:00.000Z" },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: "2026-09-27T20:15:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "sub-overlay-palette-a11y", reason: null, updatedAt: "2026-09-27T20:15:00.000Z" },
  tokens: { botExpiresAt: null, loginStatus: "connected", loginReason: null, loginExpiresAt: null },
  lastError: null,
};


const routeApi = async (page: Page, elementCount = 0): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const json = (body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/channels") return json({ channels: [channel], bot: channel.bot });
    if (pathname === `/api/channels/${channelId}/overlays/${overlayId}`) {
      return json({ overlay: { id: overlayId, channelId, name: "Palette test", width: 1920, height: 1080, css: "", revision: 1,
        createdAt: "2026-09-27T20:15:00.000Z", updatedAt: "2026-09-27T20:15:00.000Z",
        elements: Array.from({ length: elementCount }, (_, i) => ({ id: `element-${String(i)}`, kind: "variable", label: `Score ${String(i)}`, variableName: `score${String(i)}`, text: "{value}", config: {}, x: 0, y: 0, scalePercent: 100, z: i, inComposition: true })) } });
    }
    if (pathname === `/api/channels/${channelId}/variables`) return json({ variables: [], count: 0, maximum: 20 });
    if (pathname === `/api/channels/${channelId}/modules`) return json({ modules: [{ id: "chat_voting", enabled: true, settings: "{}" }, { id: "ads", enabled: true, settings: "{}" }] });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto(`/channels/${channelId}/overlays/${overlayId}`);
  await expect(page.getByRole("heading", { name: "Palette test" })).toBeVisible();
};

test("mobile palette focuses search, names its dialog and selects by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routeApi(page);
  await page.getByRole("button", { name: "Add element" }).click();
  const search = page.getByRole("combobox", { name: "Search elements" });
  await expect(search).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Add element" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay-editor__element-select")).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Search elements" })).toHaveCount(0);
});

test("resizing from desktop to mobile with the palette open does not crash", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeApi(page);
  await page.getByRole("button", { name: "Add element" }).click();
  await expect(page.getByRole("combobox", { name: "Search elements" })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog", { name: "Add element" })).toBeVisible();
  await page.getByRole("combobox", { name: "Search elements" }).press("Enter");
  await expect(page.locator(".overlay-editor__element-select")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("desktop palette closes with Escape after Tab and removal moves focus to the plus button", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeApi(page);
  const add = page.getByRole("button", { name: "Add element" });
  await add.click();
  await expect(page.getByRole("combobox", { name: "Search elements" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Search elements" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: "Search elements" })).toHaveCount(0);
  await expect(add).toBeFocused();

  await add.click();
  await expect(page.getByRole("combobox", { name: "Search elements" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const remove = page.locator(".overlay-editor__element-remove");
  await expect(remove).toHaveCount(1);
  await remove.focus();
  await page.keyboard.press("Enter");
  await expect(remove).toHaveCount(0);
  await expect(add).toBeFocused();
});

test("desktop palette returns focus to the plus button when focus-trap timers fire after the restoration frame", async ({ page }) => {
  // Controlled ordering instead of a timing guess: while `hold` is on, 0 ms timeouts (Mantine's
  // focus-trap refocus callbacks) are queued and only run when the test releases them.
  // Order enforced: Escape -> restoration frame -> delayed focus-trap callbacks -> exit completion.
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const held: (() => void)[] = [];
    const control = { hold: false, held, release: () => { control.hold = false; for (const run of held.splice(0)) run(); } };
    (window as unknown as { __timers: typeof control }).__timers = control;
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (control.hold && (delay ?? 0) <= 0 && typeof handler === "function") {
        held.push(() => { (handler as (...rest: unknown[]) => void)(...args); });
        return 0;
      }
      return nativeSetTimeout(handler, delay, ...args);
    }) as typeof window.setTimeout;
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeApi(page);
  const add = page.getByRole("button", { name: "Add element" });
  const search = page.getByRole("combobox", { name: "Search elements" });
  // Hold from before opening: the focus trap schedules its refocus callbacks (0 ms) while mounting.
  await page.evaluate(() => { (window as unknown as { __timers: { hold: boolean } }).__timers.hold = true; });
  await add.click();
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  // Two animation frames: the frame in which a restoration scheduled by Escape would have run.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); })));
  await expect(search).toHaveCount(1); // exit has not completed yet
  const held = await page.evaluate(() => (window as unknown as { __timers: { held: unknown[] } }).__timers.held.length);
  expect(held).toBeGreaterThan(0); // the focus-trap callbacks are really delayed
  await page.evaluate(() => { (window as unknown as { __timers: { release: () => void } }).__timers.release(); });

  await expect(search).toHaveCount(0);
  await expect(add).toBeFocused();
});

for (const width of [1280, 390]) {
  test(`the usage count stays visible inside the panel at the element limit (${String(width)}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await routeApi(page, 20);
    const usage = page.locator(".overlay-editor__element-usage");
    await expect(usage).toContainText("20 of 20");
    const fits = await usage.evaluate((el) => {
      const panel = (el.closest(".overlay-editor__elements") as HTMLElement).getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const count = el.firstElementChild as HTMLElement;
      return { countFits: count.scrollWidth <= count.clientWidth, usageFits: el.scrollWidth <= el.clientWidth,
        inside: box.left >= panel.left && box.right <= panel.right };
    });
    expect(fits).toEqual({ countFits: true, usageFits: true, inside: true });
  });
}
