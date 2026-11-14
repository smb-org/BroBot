import { expect, test } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import {
  createE2ESessionCredentials,
  e2eChannelId,
  e2eOverlayToken,
  e2eWorkerEnvironment,
  e2eWorkerOrigin,
  seedE2EOverlay,
  seedE2EWordCounterOverlay,
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
    const overlayUrl = `${e2eWorkerOrigin}/overlay.html#token=e2e-token`;
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
  await page.routeWebSocket(/\/ws\/overlay(\?.*)?$/u, (socket) => {
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

  await page.goto(`${e2eWorkerOrigin}/__e2e/overlay-embed`);
  const frame = page.frameLocator("#overlay-frame");
  await expect.poll(async () => frame.locator("body").evaluate(() => globalThis.origin)).toBe("null");
  await expect.poll(() => bootstrapSeen).toBe(true);
  await expect.poll(() => realtimeSeen).toBe(true);
  await expect(frame.locator(".brobot-variable__value")).toHaveText("42");
  expect(overlayAssetCorsHeaders.length).toBeGreaterThan(0);
  expect(overlayAssetCorsHeaders).toContain("*");
});

test("a sandboxed embed bootstraps through Worker CORS and receives a real Worker variable update", async ({ page }) => {
  // This integration exercises real Worker storage and WebSocket startup.
  test.setTimeout(60_000);
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

  await page.goto(`/tests/e2e/fixtures/overlay-embed.html#token=${e2eOverlayToken}&origin=${encodeURIComponent(e2eWorkerOrigin)}`);
  const frame = page.frameLocator("#overlay-frame");
  await expect.poll(() => frame.locator("body").evaluate(() => globalThis.origin)).toBe("null");
  await expect(frame.locator(".brobot-variable__value")).toHaveText("7");
  await expect.poll(() => realtimeFrames.some((message) => message.includes('"system.hello"'))).toBe(true);
  await expect.poll(() => bootstrapResponseStatuses.includes(200)).toBe(true);
  await expect.poll(() => bootstrapCorsOrigins.includes("*")).toBe(true);
  expect(overlayAssetCorsHeaders).toContain("*");

  const response = await page.request.post(
    `${e2eWorkerOrigin}/api/channels/${e2eChannelId}/variables/score/value`,
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

test("a sandboxed overlay updates its word counter after a real chat message", async ({ page }) => {
  test.setTimeout(60_000);
  const channelId = `channel-e2e-counter-${randomUUID()}`;
  const overlay = seedE2EWordCounterOverlay(channelId);
  const connected = new Promise<void>((resolve) => {
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).pathname !== "/ws/overlay") return;
      socket.on("framereceived", ({ payload }) => {
        const frame = typeof payload === "string" ? payload : payload.toString("utf8");
        if (frame.includes('"system.hello"')) resolve();
      });
    });
  });
  await page.goto(`/tests/e2e/fixtures/overlay-embed.html#token=${encodeURIComponent(overlay.overlayToken)}&origin=${encodeURIComponent(e2eWorkerOrigin)}`);
  const frame = page.frameLocator("#overlay-frame");
  await expect(frame.locator(".statistics-word-counter")).toBeVisible();
  await expect(frame.locator(".statistics-word-counter__value").first()).toHaveText("0");
  await connected;

  const postNotification = async (type: "stream.online" | "channel.chat.message", event: Record<string, unknown>): Promise<void> => {
    const messageId = `eventsub-counter-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const payload = {
      subscription: {
        id: `subscription-${type.replaceAll(".", "-")}`,
        type,
        version: "1",
        status: "enabled",
        condition: type === "channel.chat.message"
          ? { broadcaster_user_id: channelId, user_id: "bot-counter-e2e" }
          : { broadcaster_user_id: channelId },
        transport: { method: "webhook", callback: `${e2eWorkerOrigin}/api/twitch/eventsub` },
        created_at: timestamp,
      },
      event,
    };
    const body = Buffer.from(JSON.stringify(payload));
    const secretRing = JSON.parse(e2eWorkerEnvironment.TWITCH_EVENTSUB_SECRET ?? "{}") as {
      active?: { key?: string };
    };
    const eventSubKey = secretRing.active?.key;
    if (eventSubKey === undefined) throw new Error("The E2E EventSub signing key is missing.");
    const signature = createHmac("sha256", eventSubKey)
      .update(messageId)
      .update(timestamp)
      .update(body)
      .digest("hex");
    const response = await page.request.post(`${e2eWorkerOrigin}/api/twitch/eventsub`, {
      headers: {
        "Content-Type": "application/json",
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": `sha256=${signature}`,
        "Twitch-Eventsub-Message-Type": "notification",
      },
      data: body,
    });
    expect(response.status()).toBe(204);
  };

  const startedAt = new Date().toISOString();
  const streamId = `stream-counter-${randomUUID()}`;
  await postNotification("stream.online", {
    id: streamId,
    broadcaster_user_id: channelId,
    broadcaster_user_login: overlay.channelLogin,
    broadcaster_user_name: "E2E Kanal",
    type: "live",
    started_at: startedAt,
  });
  await expect(frame.locator(".statistics-word-counter")).toHaveAttribute("data-stream-live", "true");

  const messageId = `chat-counter-${randomUUID()}`;
  const text = "Fak";
  await postNotification("channel.chat.message", {
    broadcaster_user_id: channelId,
    broadcaster_user_login: overlay.channelLogin,
    broadcaster_user_name: "E2E Kanal",
    chatter_user_id: "viewer-counter-e2e",
    chatter_user_login: "frostfern",
    chatter_user_name: "Frost Fern",
    message_id: messageId,
    message: { text, fragments: [{ type: "text", text }] },
    message_type: "text",
    badges: [],
  });

  await expect.poll(async () => frame.locator(".statistics-word-counter__value").allTextContents()).toEqual(["1", "1"]);
});
