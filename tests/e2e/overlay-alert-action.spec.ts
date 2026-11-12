import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

import {
  e2eOverlayToken,
  e2eWorkerEnvironment,
  e2eWorkerOrigin,
  seedE2EOverlayAlert,
} from "./worker-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "channel-e2e";

test("a channel-points redemption shows its seeded alert in the connected overlay", async ({ page }) => {
  test.setTimeout(60_000);
  seedE2EOverlayAlert();

  let connected = false;
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/ws/overlay") return;
    socket.on("framereceived", ({ payload }) => {
      const frame = typeof payload === "string" ? payload : payload.toString("utf8");
      if (frame.includes('"system.hello"')) connected = true;
    });
  });
  await page.goto(`${e2eWorkerOrigin}/overlay.html#token=${encodeURIComponent(e2eOverlayToken)}`);
  await expect.poll(() => connected).toBe(true);

  const messageId = `eventsub-alert-${randomUUID()}`;
  const redemptionId = `redemption-alert-${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const payload = {
    subscription: {
      id: "subscription-alert-e2e",
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: channelId },
      transport: { method: "webhook", callback: `${e2eWorkerOrigin}/api/twitch/eventsub` },
      created_at: timestamp,
    },
    event: {
      id: redemptionId,
      broadcaster_user_id: channelId,
      broadcaster_user_login: "kanal-e2e",
      broadcaster_user_name: "E2E Kanal",
      user_id: "viewer-alert-e2e",
      user_login: "viewer_demo",
      user_name: "Viewer Demo",
      user_input: "Bitte grüße den Chat",
      status: "unfulfilled",
      redeemed_at: timestamp,
      reward: { id: "twitch-reward-alert-e2e", title: "Einblendung testen", prompt: "Schreibe einen Gruß", cost: 100 },
    },
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

  await expect(page.getByText("Viewer Demo: Bitte grüße den Chat", { exact: true })).toBeVisible();
  await expect(page.locator(".overlay-alert__image")).toBeVisible();
});
