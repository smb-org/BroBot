import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eSpotifyMockPort,
  e2eWorkerEnvironment,
  e2eWorkerOrigin,
  seedE2EChannelPointsSongRequests,
} from "./worker-fixtures";

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

const localWorkerHost = new URL(e2eWorkerOrigin).hostname;

test("!wrongsong withdraws a viewer's channel-point request and cancels its redemption", async ({ page }) => {
  test.setTimeout(90_000);
  const channelId = `channel-wrongsong-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const rewardId = `reward-twitch-${channelId}`;
  const overlay = seedE2EChannelPointsSongRequests(channelId, {
    mode: "moderated", paymentMode: "free", freeRoleThreshold: "everyone",
  });
  const mockOrigin = `http://127.0.0.1:${e2eSpotifyMockPort}`;
  await page.request.post(`${mockOrigin}/__test/reset`);
  const credentials = createE2ESessionCredentials();
  await page.context().addCookies([
    { name: "__Host-brobot_session", value: credentials.cookie, domain: localWorkerHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__Host-brobot_csrf", value: credentials.csrfToken, domain: localWorkerHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
  ]);
  const apiHeaders = {
    Cookie: `__Host-brobot_session=${credentials.cookie}; __Host-brobot_csrf=${credentials.csrfToken}`,
    "X-CSRF-Token": credentials.csrfToken,
  };
  const postEventSub = async (
    type: "stream.online" | "channel.chat.message" | "channel.channel_points_custom_reward_redemption.add",
    event: Record<string, unknown>,
  ): Promise<void> => {
    const messageId = `eventsub-wrongsong-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const body = Buffer.from(JSON.stringify({
      subscription: {
        id: `subscription-wrongsong-${type.replaceAll(".", "-")}`,
        type,
        version: "1",
        status: "enabled",
        condition: type === "channel.chat.message"
          ? { broadcaster_user_id: channelId, user_id: "bot-e2e" }
          : { broadcaster_user_id: channelId },
        transport: { method: "webhook", callback: `${e2eWorkerOrigin}/api/twitch/eventsub` },
        created_at: timestamp,
      },
      event,
    }));
    const secret = JSON.parse(e2eWorkerEnvironment.TWITCH_EVENTSUB_SECRET ?? "{}") as { active?: { key?: string } };
    const signingKey = secret.active?.key;
    if (signingKey === undefined) throw new Error("The E2E EventSub signing key is missing.");
    const signature = createHmac("sha256", signingKey).update(messageId).update(timestamp).update(body).digest("hex");
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

  await page.goto(`${e2eWorkerOrigin}/channels/${channelId}/modules/song_requests`);
  await page.getByRole("button", { name: "Connect Spotify" }).click();
  await expect(page.getByText("Spotify is connected.")).toBeVisible();
  await postEventSub("stream.online", {
    id: `stream-wrongsong-${randomUUID()}`,
    broadcaster_user_id: channelId,
    broadcaster_user_login: overlay.channelLogin,
    broadcaster_user_name: "E2E Broadcaster",
    type: "live",
    started_at: new Date().toISOString(),
  });

  const redemptionId = `redemption-wrongsong-${randomUUID()}`;
  const viewerId = `viewer-${redemptionId}`;
  const viewerLogin = `viewer_${randomUUID().slice(0, 8)}`;
  const redeemedAt = new Date().toISOString();
  await page.request.post(`${mockOrigin}/__test/redemptions`, {
    data: {
      id: redemptionId,
      broadcaster_id: channelId,
      broadcaster_login: overlay.channelLogin,
      broadcaster_name: "E2E Broadcaster",
      user_id: viewerId,
      user_login: viewerLogin,
      user_name: "Fictional Viewer",
      user_input: "spotify:track:glassharbor01",
      redeemed_at: redeemedAt,
      status: "UNFULFILLED",
      reward: { id: rewardId, title: "Request a song", prompt: "Enter a track", cost: 500 },
    },
  });
  await postEventSub("channel.channel_points_custom_reward_redemption.add", {
    id: redemptionId,
    broadcaster_user_id: channelId,
    broadcaster_user_login: overlay.channelLogin,
    broadcaster_user_name: "E2E Broadcaster",
    user_id: viewerId,
    user_login: viewerLogin,
    user_name: "Fictional Viewer",
    user_input: "spotify:track:glassharbor01",
    status: "unfulfilled",
    redeemed_at: redeemedAt,
    reward: { id: rewardId, title: "Request a song", prompt: "Enter a track", cost: 500, is_user_input_required: true },
  });
  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/queue`, { headers: apiHeaders });
    return response.ok() ? await response.json() as unknown : null;
  }).toMatchObject({ count: 1, items: [{ state: "pending_review" }] });
  const queued = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/queue`, { headers: apiHeaders });
  const requestId = ((await queued.json()) as { items: Array<{ requestId: string }> }).items[0]?.requestId;
  if (requestId === undefined) throw new Error("The channel-points request was not added to moderation.");

  await postEventSub("channel.chat.message", {
    broadcaster_user_id: channelId,
    broadcaster_user_login: overlay.channelLogin,
    broadcaster_user_name: "E2E Broadcaster",
    chatter_user_id: viewerId,
    chatter_user_login: viewerLogin,
    chatter_user_name: "Fictional Viewer",
    message_id: `message-wrongsong-${randomUUID()}`,
    message: { text: "!wrongsong", fragments: [{ type: "text", text: "!wrongsong" }] },
    message_type: "text",
    badges: [],
  });

  await expect.poll(async () => {
    const response = await page.request.get(`${mockOrigin}/__test/redemptions`);
    const body = await response.json() as { items: Array<{ id: string; status: string }> };
    return body.items.find((item) => item.id === redemptionId)?.status;
  }, { timeout: 25_000 }).toBe("CANCELED");
  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/requests?filter=all`, { headers: apiHeaders });
    const body = await response.json() as { requests: Array<{ requestId: string; state: string }> };
    return body.requests.find((request) => request.requestId === requestId)?.state;
  }).toBe("rejected");
});
