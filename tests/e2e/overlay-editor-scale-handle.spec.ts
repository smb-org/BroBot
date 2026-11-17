import { expect, test } from "@playwright/test";

const channelId = "channel-overlay-scale";
const overlayId = "overlay-scale";
const channel = {
  channelId,
  login: "overlay-scale",
  displayName: "Overlay scale",
  language: "en",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-11-01T20:15:00.000Z" },
  botPermissions: { missingScopes: [] },
  broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: "2026-11-01T20:15:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "sub-overlay-scale", reason: null, updatedAt: "2026-11-01T20:15:00.000Z" },
  tokens: { botExpiresAt: null, loginStatus: "connected", loginReason: null, loginExpiresAt: null },
  lastError: null,
};

test("scales from a canvas handle, saves, reloads, and syncs the scale field", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  let currentOverlay = {
    id: overlayId,
    channelId,
    name: "Scale test",
    width: 1920,
    height: 1080,
    css: "",
    revision: 1,
    createdAt: "2026-11-01T20:15:00.000Z",
    updatedAt: "2026-11-01T20:15:00.000Z",
    elements: [
      { id: "element-score", kind: "variable", label: "Score", variableName: "score", text: "Score: {value}", config: {}, x: 0, y: 400, scalePercent: 100, z: 0, inComposition: true },
    ],
  };

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const json = (body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/channels") return json({ channels: [channel], bot: channel.bot });
    if (pathname === "/api/csrf") return json({ token: "csrf-overlay-scale" });
    if (pathname === `/api/channels/${channelId}/overlays/${overlayId}` && method === "GET") return json({ overlay: currentOverlay });
    if (pathname === `/api/channels/${channelId}/overlays/${overlayId}` && method === "PUT") {
      const draft = route.request().postDataJSON() as Pick<typeof currentOverlay, "name" | "width" | "height" | "css" | "elements">;
      currentOverlay = {
        ...currentOverlay,
        name: draft.name,
        width: draft.width,
        height: draft.height,
        css: draft.css,
        elements: draft.elements,
        revision: currentOverlay.revision + 1,
      };
      return json({ overlay: currentOverlay });
    }
    if (pathname === `/api/channels/${channelId}/variables`) return json({ variables: [{ name: "score", value: 42, description: "Score" }], count: 1, maximum: 20 });
    if (pathname === `/api/channels/${channelId}/modules`) return json({ modules: [] });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`/channels/${channelId}/overlays/${overlayId}`);
  await expect(page.getByRole("heading", { name: "Scale test" })).toBeVisible();
  await expect(page.frameLocator('[data-testid="overlay-editor-renderer"]').locator('[data-element="element-score"]')).toBeVisible();
  const topLeftHandle = page.getByTestId("overlay-editor-scale-handle-top-left");
  await expect(topLeftHandle).toBeVisible();
  const topLeftBounds = await topLeftHandle.boundingBox();
  const canvasScale = await page.locator(".overlay-editor__canvas-frame")
    .evaluate((frame) => Number.parseFloat(getComputedStyle(frame).width) / 1920);
  const elementWidth = await page.frameLocator('[data-testid="overlay-editor-renderer"]')
    .locator('[data-element="element-score"]')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(topLeftBounds).not.toBeNull();
  if (topLeftBounds === null) return;
  const smallDragPx = 2;
  const expectedScale = Math.round(100 * (1 - smallDragPx / canvasScale / elementWidth));
  await page.mouse.move(topLeftBounds.x + topLeftBounds.width / 2, topLeftBounds.y + topLeftBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(topLeftBounds.x + topLeftBounds.width / 2 + smallDragPx, topLeftBounds.y + topLeftBounds.height / 2);
  await page.mouse.up();
  await expect(page.locator("#overlay-editor-scale")).toHaveValue(String(expectedScale));

  const handle = page.getByTestId("overlay-editor-scale-handle-bottom-right");
  await expect(handle).toBeVisible();
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds === null) return;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 48, bounds.y + bounds.height / 2 + 32, { steps: 4 });
  await page.mouse.up();

  const scaleField = page.locator("#overlay-editor-scale");
  await expect.poll(async () => Number(await scaleField.inputValue())).toBeGreaterThan(100);
  const savedScale = Number(await scaleField.inputValue());
  await page.locator(".ui-save-bar__save").click();
  await expect.poll(() => currentOverlay.elements[0]?.scalePercent).toBe(savedScale);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Scale test" })).toBeVisible();
  await expect(page.locator("#overlay-editor-scale")).toHaveValue(String(savedScale));
});

test("resizes width from a canvas edge, saves, reloads, and syncs the width field", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  type WidthOverlay = {
    id: string;
    channelId: string;
    name: string;
    width: number;
    height: number;
    css: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    elements: Array<{
      id: string; kind: string; label: string; variableName: string; text: string; config: Record<string, unknown>;
      x: number; y: number; scalePercent: number; widthPx: number | null; z: number; inComposition: boolean;
    }>;
  };
  let currentOverlay: WidthOverlay = {
    id: overlayId,
    channelId,
    name: "Width test",
    width: 1920,
    height: 1080,
    css: ".brobot-variable { font-size: 120px; line-height: 1; }",
    revision: 1,
    createdAt: "2026-11-01T20:15:00.000Z",
    updatedAt: "2026-11-01T20:15:00.000Z",
    elements: [
      { id: "element-score", kind: "variable", label: "Score", variableName: "score", text: "Score: {value}", config: {}, x: 80, y: 80, scalePercent: 100, widthPx: null, z: 0, inComposition: true },
    ],
  };

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const json = (body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/channels") return json({ channels: [channel], bot: channel.bot });
    if (pathname === "/api/csrf") return json({ token: "csrf-overlay-width" });
    if (pathname === `/api/channels/${channelId}/overlays/${overlayId}` && method === "GET") return json({ overlay: currentOverlay });
    if (pathname === `/api/channels/${channelId}/overlays/${overlayId}` && method === "PUT") {
      const draft = route.request().postDataJSON() as Pick<typeof currentOverlay, "name" | "width" | "height" | "css" | "elements">;
      currentOverlay = {
        ...currentOverlay,
        name: draft.name,
        width: draft.width,
        height: draft.height,
        css: draft.css,
        elements: draft.elements,
        revision: currentOverlay.revision + 1,
      };
      return json({ overlay: currentOverlay });
    }
    if (pathname === `/api/channels/${channelId}/variables`) return json({ variables: [{ name: "score", value: 42, description: "Score" }], count: 1, maximum: 20 });
    if (pathname === `/api/channels/${channelId}/modules`) return json({ modules: [] });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`/channels/${channelId}/overlays/${overlayId}`);
  await expect(page.getByRole("heading", { name: "Width test" })).toBeVisible();
  await expect(page.frameLocator('[data-testid="overlay-editor-renderer"]').locator('[data-element="element-score"]')).toBeVisible();
  const handle = page.getByTestId("overlay-editor-width-handle-right");
  await expect(handle).toBeVisible();
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds === null) return;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 64, bounds.y + bounds.height / 2, { steps: 4 });
  await page.mouse.up();

  const widthField = page.locator("#overlay-editor-width");
  await expect.poll(async () => Number(await widthField.inputValue())).toBeGreaterThan(0);
  const savedWidth = Number(await widthField.inputValue());
  await page.locator(".ui-save-bar__save").click();
  await expect.poll(() => currentOverlay.elements[0]?.widthPx).toBe(savedWidth);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Width test" })).toBeVisible();
  await expect(page.locator("#overlay-editor-width")).toHaveValue(String(savedWidth));
});
