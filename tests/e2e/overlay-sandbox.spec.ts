import { expect, test } from "@playwright/test";
import {
  createE2ESessionCredentials,
  e2eChannelId,
  e2eOverlayToken,
  seedE2EOverlay,
} from "./worker-fixtures";

const bootstrap = {
  language: "en",
  overlay: {
    id: "overlay-demo",
    revision: 1,
    width: 1920,
    height: 1080,
    css: "",
    elements: [{
      id: "element-demo",
      kind: "variable",
      label: "Demo score",
      variableName: "score",
      text: "Score {value}",
      x: 0,
      y: 0,
      scalePercent: 100,
      z: 0,
      inComposition: true,
    }],
  },
  variables: { score: 7 },
};

test("a sandboxed opaque-origin embed loads bootstrap and applies a realtime update", async ({ page }) => {
  let bootstrapSeen = false;
  let realtimeSeen = false;
  const overlayAssetCorsHeaders: Array<string | undefined> = [];

  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/_app/")) {
      overlayAssetCorsHeaders.push(response.headers()["access-control-allow-origin"]);
    }
  });

  await page.route("**/__e2e/overlay-embed", async (route) => {
    const overlayUrl = "http://127.0.0.1:8787/overlay.html#token=e2e-token";
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <html lang="en"><body>
          <iframe id="overlay-frame" sandbox="allow-scripts"
            src="${overlayUrl}"></iframe>
        </body></html>`,
    });
  });
  await page.route("**/api/overlay/bootstrap", async (route) => {
    const request = route.request();
    expect(request.headers().origin).toBe("null");
    if (request.method() === "OPTIONS") {
      expect(request.headers()["access-control-request-headers"]).toContain("authorization");
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization",
        },
      });
      return;
    }

    bootstrapSeen = true;
    expect(request.method()).toBe("GET");
    expect(request.headers().authorization).toBe("Bearer e2e-token");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify(bootstrap),
    });
  });
  await page.routeWebSocket("**/ws/overlay", (socket) => {
    realtimeSeen = true;
    expect(socket.protocols()).toContain("brobot.v1");
    expect(socket.protocols()).toContain("brobot.token.e2e-token");
    const now = "2026-09-25T00:00:00.000Z";
    socket.send(JSON.stringify({
      version: 1,
      id: "message-demo-hello",
      createdAt: now,
      channelId: "channel-demo",
      type: "system.hello",
      payload: {},
    }));
    socket.send(JSON.stringify({
      version: 1,
      id: "message-demo-score",
      createdAt: now,
      channelId: "channel-demo",
      type: "variables.changed",
      payload: { set: [{ name: "score", value: 42 }], removed: [] },
    }));
  });

  await page.goto("http://127.0.0.1:8787/__e2e/overlay-embed");
  const frame = page.frameLocator("#overlay-frame");
  await expect.poll(async () => frame.locator("body").evaluate(() => globalThis.origin)).toBe("null");
  await expect.poll(() => bootstrapSeen).toBe(true);
  await expect.poll(() => realtimeSeen).toBe(true);
  await expect(frame.locator(".brobot-variable__value")).toHaveText("42");
  expect(overlayAssetCorsHeaders.length).toBeGreaterThan(0);
  expect(overlayAssetCorsHeaders).toContain("*");
});

test("a sandboxed embed bootstraps through Worker CORS and receives a real Worker variable update", async ({ page }) => {
  seedE2EOverlay();
  const credentials = createE2ESessionCredentials();
  const bootstrapResponseStatuses: number[] = [];
  const bootstrapCorsOrigins: string[] = [];
  const overlayAssetCorsHeaders: Array<string | undefined> = [];
  const realtimeFrames: string[] = [];

  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname === "/api/overlay/bootstrap") {
      bootstrapResponseStatuses.push(response.status());
      bootstrapCorsOrigins.push(response.headers()["access-control-allow-origin"] ?? "");
    }
    if (pathname.startsWith("/_app/")) {
      overlayAssetCorsHeaders.push(response.headers()["access-control-allow-origin"]);
    }
  });
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/ws/overlay") return;
    socket.on("framereceived", ({ payload }) => {
      realtimeFrames.push(typeof payload === "string" ? payload : payload.toString("utf8"));
    });
  });

  await page.goto(`/tests/e2e/fixtures/overlay-embed.html#token=${e2eOverlayToken}`);
  const frame = page.frameLocator("#overlay-frame");
  await expect.poll(() => frame.locator("body").evaluate(() => globalThis.origin)).toBe("null");
  await expect(frame.locator(".brobot-variable__value")).toHaveText("7");
  await expect.poll(() => realtimeFrames.some((message) => message.includes('"system.hello"'))).toBe(true);
  await expect.poll(() => bootstrapResponseStatuses.includes(200)).toBe(true);
  await expect.poll(() => bootstrapCorsOrigins.includes("*")).toBe(true);
  expect(overlayAssetCorsHeaders).toContain("*");

  const response = await page.request.post(
    `http://127.0.0.1:8787/api/channels/${e2eChannelId}/variables/score/value`,
    {
      headers: {
        Cookie: `__Host-brobot_session=${credentials.cookie}; __Host-brobot_csrf=${credentials.csrfToken}`,
        "X-CSRF-Token": credentials.csrfToken,
      },
      data: { operation: "set", amount: 42 },
    },
  );
  expect(response.status()).toBe(200);

  await expect.poll(() => realtimeFrames.some((frameText) => {
    try {
      const message: unknown = JSON.parse(frameText);
      if (typeof message !== "object" || message === null || !("type" in message) ||
          message.type !== "variables.changed" || !("payload" in message)) return false;
      const payload: unknown = message.payload;
      if (typeof payload !== "object" || payload === null || !("set" in payload) || !Array.isArray(payload.set)) return false;
      return payload.set.some((entry: unknown) => typeof entry === "object" && entry !== null &&
        "name" in entry && entry.name === "score" && "value" in entry && entry.value === 42);
    } catch {
      return false;
    }
  })).toBe(true);
  await expect(frame.locator(".brobot-variable__value")).toHaveText("42");
});
