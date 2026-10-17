import { expect, test, type Page } from "@playwright/test";

const channelId = "channel-overlay-redesign";
const overlayId = "overlay-redesign";
const channel = {
  channelId,
  login: "overlay-redesign",
  displayName: "Overlay redesign",
  language: "de",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-10-10T20:15:00.000Z" },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: "2026-10-10T20:15:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "sub-overlay-redesign", reason: null, updatedAt: "2026-10-10T20:15:00.000Z" },
  tokens: { botExpiresAt: null, loginStatus: "connected", loginReason: null, loginExpiresAt: null },
  lastError: null,
};

const overlay = {
  id: overlayId,
  channelId,
  name: "Stream-Overlay",
  width: 1920,
  height: 1080,
  css: "",
  revision: 1,
  createdAt: "2026-10-10T20:15:00.000Z",
  updatedAt: "2026-10-10T20:15:00.000Z",
  elements: [
    { id: "element-score", kind: "variable", label: "Punktestand", variableName: "score", text: "Punkte: {value}", config: {}, x: 80, y: 80, scalePercent: 100, z: 0, inComposition: true },
    { id: "element-streak", kind: "variable", label: "Serie", variableName: "streak", text: "Serie: {value}", config: {}, x: 80, y: 180, scalePercent: 100, z: 1, inComposition: true },
  ],
};

const routeApi = async (page: Page, overlayUnavailable = false): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const json = (body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/channels") return json({ channels: [channel], bot: channel.bot });
    if (pathname === `/api/channels/${channelId}/overlays/${overlayId}`) {
      return overlayUnavailable
        ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "overlay_not_found" }) })
        : json({ overlay });
    }
    if (pathname === `/api/channels/${channelId}/variables`) return json({
      variables: [
        { name: "score", value: 42, description: "Punktestand" },
        { name: "streak", value: 8, description: "Serie" },
      ], count: 2, maximum: 20,
    });
    if (pathname === `/api/channels/${channelId}/modules`) return json({ modules: [] });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
};

test("overlay workspace fills desktop viewport without page scrolling and adapts at all target widths", async ({ page }) => {
  await routeApi(page);
  await page.goto(`/channels/${channelId}/overlays/${overlayId}`);
  await expect(page.getByRole("heading", { name: "Stream-Overlay" })).toBeVisible();

  for (const width of [1920, 1280, 1024, 769, 390, 2560]) {
    const height = width === 390 ? 844 : width === 2560 ? 1440 : width === 1920 ? 1080 : 800;
    await page.setViewportSize({ width, height });
    if (width < 769 && await page.locator(".dashboard-shell__burger").getAttribute("aria-expanded") === "true") {
      await page.locator(".dashboard-shell__burger").click();
    }
    const geometry = await page.locator(".overlay-editor__workspace").evaluate((workspace) => {
      const editor = workspace.closest(".overlay-editor") as HTMLElement;
      const shellMain = document.querySelector<HTMLElement>(".dashboard-shell__main");
      const columns = Array.from(workspace.children, (child) => {
        const rect = child.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
      });
      const computed = getComputedStyle(workspace);
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        titleHeight: document.querySelector<HTMLElement>(".page-header h1")?.getBoundingClientRect().height ?? 0,
        gridTemplateColumns: computed.gridTemplateColumns,
        workspaceOverflowY: computed.overflowY,
        columnOverflowY: Array.from(workspace.children, (child) => getComputedStyle(child).overflowY),
        shellMain: shellMain === null ? null : {
          scrollHeight: shellMain.scrollHeight,
          clientHeight: shellMain.clientHeight,
        },
        editorHeight: editor.getBoundingClientRect().height,
        columns,
      };
    });

    expect(geometry.documentWidth).toBeLessThanOrEqual(width);
    expect(geometry.titleHeight).toBeLessThanOrEqual(32);
    if (width >= 1280) {
      expect(geometry.documentHeight).toBeLessThanOrEqual(height);
      expect(geometry.gridTemplateColumns.split(" ")).toHaveLength(3);
      expect(geometry.columns[0]?.width).toBeGreaterThanOrEqual(width === 1280 ? 190 : 230);
      expect(geometry.columns[1]?.width).toBeGreaterThanOrEqual(width === 1280 ? 260 : 500);
      expect(geometry.columns[2]?.width).toBeGreaterThanOrEqual(width === 1280 ? 340 : 540);
    } else if (width >= 761) {
      expect(geometry.documentHeight).toBeLessThanOrEqual(height);
      expect(geometry.gridTemplateColumns.split(" ")).toHaveLength(2);
      expect(geometry.columns[0]?.width).toBeGreaterThanOrEqual(180);
      expect(geometry.columns[1]?.width).toBeGreaterThan(240);
      expect(geometry.columns[0]?.right).toBeLessThanOrEqual(geometry.columns[1]?.left ?? 0);
    } else {
      expect(geometry.shellMain?.scrollHeight).toBeGreaterThan(geometry.shellMain?.clientHeight ?? height);
      expect(geometry.gridTemplateColumns.split(" ")).toHaveLength(1);
      expect(geometry.columns[0]?.width).toBeLessThanOrEqual(width);
    }
  }
});

test("canvas and element list select the same element", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await routeApi(page);
  await page.goto(`/channels/${channelId}/overlays/${overlayId}`);

  const scoreRow = page.locator('[data-element-row="element-score"] .overlay-editor__element-select');
  const streakRow = page.locator('[data-element-row="element-streak"] .overlay-editor__element-select');
  await expect(scoreRow).toHaveAttribute("aria-pressed", "true");
  await streakRow.click();
  await expect(streakRow).toHaveAttribute("aria-pressed", "true");

  await page.frameLocator('[data-testid="overlay-editor-renderer"]').locator('[data-element="element-score"]').click();
  await expect(scoreRow).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-element-row="element-streak"] .overlay-editor__element-select')).toHaveAttribute("aria-pressed", "false");
  const selectedCanvasElement = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('[data-testid="overlay-editor-renderer"]');
    const host = frame?.contentDocument?.querySelector<HTMLElement>("[data-brobot-editor-bounds-layer]");
    return host?.shadowRoot?.querySelector<HTMLElement>('[data-brobot-editor-bound][data-selected="true"]')?.dataset.brobotEditorBound;
  });
  expect(selectedCanvasElement).toBe("element-score");
});

test("creation wizard keeps its desktop dialog sized to the current step", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeApi(page);
  await page.goto(`/channels/${channelId}/overlays/new`);

  const dialog = page.locator(".ui-step-dialog");
  await expect(dialog).toBeVisible();
  const detailsHeight = await dialog.evaluate((element) => element.getBoundingClientRect().height);
  expect(detailsHeight).toBeLessThan(500);

  await dialog.getByRole("textbox", { name: "Name" }).fill("Test overlay");
  await dialog.locator(".ui-step-dialog__footer button").last().click();
  const elementsHeight = await dialog.evaluate((element) => element.getBoundingClientRect().height);
  expect(elementsHeight).toBeLessThan(500);
});

test("overlay load errors stay inline without a duplicate toast", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routeApi(page, true);
  await page.goto(`/channels/${channelId}/overlays/${overlayId}`);

  await expect(page.locator(".overlay-editor--message [role=alert]")).toBeVisible();
  await expect(page.locator(".ui-toast")).toHaveCount(0);
});
