import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eSpotifyMockPort,
  e2eWorkerEnvironment,
  e2eWorkerOrigin,
  seedE2EChannelPointsSongRequests,
  seedE2ESongRequests,
} from "./worker-fixtures";

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

const localWorkerHost = new URL(e2eWorkerOrigin).hostname;

test("!sr supports moderated approval and rejection, then automatic submission", async ({ page }) => {
  test.setTimeout(90_000);
  const channelId = `channel-sr-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const overlay = seedE2ESongRequests(channelId, { mode: "moderated", paymentMode: "free", freeRoleThreshold: "everyone" });
  await page.request.post(`http://127.0.0.1:${e2eSpotifyMockPort}/__test/reset`);
  const credentials = createE2ESessionCredentials();
  await page.context().addCookies([
    { name: "__Host-brobot_session", value: credentials.cookie, domain: localWorkerHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__Host-brobot_csrf", value: credentials.csrfToken, domain: localWorkerHost, path: "/", secure: true, sameSite: "Lax" },
  ]);
  const apiHeaders = {
    Cookie: `__Host-brobot_session=${credentials.cookie}; __Host-brobot_csrf=${credentials.csrfToken}`,
    "X-CSRF-Token": credentials.csrfToken,
  };

  await page.goto(`${e2eWorkerOrigin}/channels/${channelId}/modules/song_requests`);
  await expect(page.getByRole("heading", { name: "Song requests" })).toBeVisible();
  await page.getByRole("button", { name: "Connect Spotify" }).click();
  await expect(page.getByText("Spotify is connected.")).toBeVisible();

  const postEventSub = async (type: "stream.online" | "channel.chat.message", event: Record<string, unknown>): Promise<void> => {
    const messageId = `eventsub-sr-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const body = Buffer.from(JSON.stringify({
      subscription: {
        id: `subscription-sr-${type.replaceAll(".", "-")}`,
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

  const startedAt = new Date().toISOString();
  await postEventSub("stream.online", {
    id: `stream-sr-${randomUUID()}`,
    broadcaster_user_id: channelId,
    broadcaster_user_login: overlay.channelLogin,
    broadcaster_user_name: "E2E Broadcaster",
    type: "live",
    started_at: startedAt,
  });

  const command = async (userId: string, login: string, value: string): Promise<void> => {
    await postEventSub("channel.chat.message", {
      broadcaster_user_id: channelId,
      broadcaster_user_login: overlay.channelLogin,
      broadcaster_user_name: "E2E Broadcaster",
      chatter_user_id: userId,
      chatter_user_login: login,
      chatter_user_name: "Fictional Viewer",
      message_id: `message-sr-${randomUUID()}`,
      message: { text: value, fragments: [{ type: "text", text: value }] },
      message_type: "text",
      badges: [],
    });
  };

  await command("viewer-sr-approve", "harbor_viewer", "!sr spotify:track:glassharbor01");
  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/queue`, { headers: apiHeaders });
    return response.ok() ? await response.json() as unknown : null;
  }).toMatchObject({ count: 1, items: [{ title: "Mira Vale – Glass Harbor (Quiet Atlas)", state: "pending_review" }] });
  const waiting = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/queue`, { headers: apiHeaders });
  const firstRequestId = ((await waiting.json()) as { items: Array<{ requestId: string }> }).items[0]?.requestId;
  if (firstRequestId === undefined) throw new Error("The moderated song request was not added to the queue.");
  const approve = await page.request.post(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/requests/${firstRequestId}/approve`, { headers: apiHeaders });
  expect(approve.status()).toBe(200);
  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/requests`, { headers: apiHeaders });
    const body = await response.json() as { requests: Array<{ requestId: string; state: string }> };
    return body.requests.find((row) => row.requestId === firstRequestId)?.state;
  }, { timeout: 25_000 }).toBe("submitted");
  await page.reload();
  await expect(page.getByRole("link", { name: "Glass Harbor" })).toBeVisible();

  await command("viewer-sr-reject", "quiet_viewer", "!sr spotify:track:quietatlas02");
  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/queue`, { headers: apiHeaders });
    return response.ok() ? await response.json() as unknown : null;
  }).toMatchObject({ count: 1, items: [{ title: "Mira Vale – Quiet Atlas (Glass Harbor)", state: "pending_review" }] });
  const secondQueue = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/queue`, { headers: apiHeaders });
  const secondRequestId = ((await secondQueue.json()) as { items: Array<{ requestId: string }> }).items[0]?.requestId;
  if (secondRequestId === undefined) throw new Error("The second moderated request was not added to the queue.");
  const reject = await page.request.post(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/requests/${secondRequestId}/reject`, { headers: apiHeaders });
  expect(reject.status()).toBe(200);
  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/requests`, { headers: apiHeaders });
    const body = await response.json() as { requests: Array<{ requestId: string; state: string }> };
    return body.requests.find((row) => row.requestId === secondRequestId)?.state;
  }).toBe("rejected");

  const settingsResponse = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/settings`, { headers: apiHeaders });
  const settings = await settingsResponse.json() as { settings: Record<string, unknown>; revision: number };
  const saved = await page.request.patch(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/settings`, {
    headers: { ...apiHeaders, "Content-Type": "application/json" },
    data: { revision: settings.revision, settings: { ...settings.settings, mode: "automatic" } },
  });
  expect(saved.status()).toBe(200);
  await command("viewer-sr-auto", "silver_viewer", "!sr spotify:track:silvercurrent03");
  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/requests`, { headers: apiHeaders });
    const body = await response.json() as { requests: Array<{ title: string; state: string }> };
    return body.requests.find((row) => row.title === "Silver Current")?.state;
  }, { timeout: 25_000 }).toBe("submitted");
});

test("channel-point song redemptions stay in the moderated queue and resolve on Twitch", async ({ page }) => {
  test.setTimeout(90_000);
  const channelId = `channel-cp-sr-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
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
    type: "stream.online" | "channel.channel_points_custom_reward_redemption.add",
    event: Record<string, unknown>,
  ): Promise<void> => {
    const messageId = `eventsub-cp-sr-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const body = Buffer.from(JSON.stringify({
      subscription: {
        id: `subscription-cp-sr-${type.replaceAll(".", "-")}`,
        type,
        version: "1",
        status: "enabled",
        condition: { broadcaster_user_id: channelId },
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
    id: `stream-cp-sr-${randomUUID()}`,
    broadcaster_user_id: channelId,
    broadcaster_user_login: overlay.channelLogin,
    broadcaster_user_name: "E2E Broadcaster",
    type: "live",
    started_at: new Date().toISOString(),
  });

  const submitRedemption = async (id: string, input: string): Promise<void> => {
    const redeemedAt = new Date().toISOString();
    await page.request.post(`${mockOrigin}/__test/redemptions`, {
      data: {
        id,
        broadcaster_id: channelId,
        broadcaster_login: overlay.channelLogin,
        broadcaster_name: "E2E Broadcaster",
        user_id: `viewer-${id}`,
        user_login: `viewer_${id}`,
        user_name: "Fictional Viewer",
        user_input: input,
        redeemed_at: redeemedAt,
        status: "UNFULFILLED",
        reward: { id: rewardId, title: "Request a song", prompt: "Enter a track", cost: 500 },
      },
    });
    await postEventSub("channel.channel_points_custom_reward_redemption.add", {
      id,
      broadcaster_user_id: channelId,
      broadcaster_user_login: overlay.channelLogin,
      broadcaster_user_name: "E2E Broadcaster",
      user_id: `viewer-${id}`,
      user_login: `viewer_${id}`,
      user_name: "Fictional Viewer",
      user_input: input,
      status: "unfulfilled",
      redeemed_at: redeemedAt,
      reward: { id: rewardId, title: "Request a song", prompt: "Enter a track", cost: 500, is_user_input_required: true },
    });
  };

  const approvedId = `redemption-approved-${randomUUID()}`;
  await submitRedemption(approvedId, "spotify:track:glassharbor01");
  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/queue`, { headers: apiHeaders });
    return response.ok() ? await response.json() as unknown : null;
  }).toMatchObject({ count: 1, items: [{ title: "Mira Vale – Glass Harbor (Quiet Atlas)", state: "pending_review" }] });
  const channelPointsQueue = await page.request.get(
    `${e2eWorkerOrigin}/api/channels/${channelId}/modules/channel_points/queue`, { headers: apiHeaders },
  );
  await expect(channelPointsQueue.json()).resolves.toMatchObject({ count: 0, items: [] });
  const pendingQueue = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/queue`, { headers: apiHeaders });
  const approvedRequestId = ((await pendingQueue.json()) as { items: Array<{ requestId: string }> }).items[0]?.requestId;
  if (approvedRequestId === undefined) throw new Error("The channel-points request was not added to moderation.");
  const approve = await page.request.post(
    `${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/requests/${approvedRequestId}/approve`,
    { headers: apiHeaders },
  );
  expect(approve.status()).toBe(200);
  await expect.poll(async () => {
    const response = await page.request.get(`${mockOrigin}/__test/redemptions`);
    const body = await response.json() as { items: Array<{ id: string; status: string }> };
    return body.items.find((item) => item.id === approvedId)?.status;
  }, { timeout: 25_000 }).toBe("FULFILLED");
  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/requests`, { headers: apiHeaders });
    const body = await response.json() as { requests: Array<{ requestId: string; state: string }> };
    return body.requests.find((request) => request.requestId === approvedRequestId)?.state;
  }, { timeout: 25_000 }).toBe("submitted");

  const rejectedId = `redemption-rejected-${randomUUID()}`;
  await submitRedemption(rejectedId, "spotify:track:quietatlas02");
  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/queue`, { headers: apiHeaders });
    return response.ok() ? await response.json() as unknown : null;
  }).toMatchObject({ count: 1, items: [{ title: "Mira Vale – Quiet Atlas (Glass Harbor)", state: "pending_review" }] });
  const rejectedQueue = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/queue`, { headers: apiHeaders });
  const rejectedRequestId = ((await rejectedQueue.json()) as { items: Array<{ requestId: string }> }).items[0]?.requestId;
  if (rejectedRequestId === undefined) throw new Error("The second channel-points request was not added to moderation.");
  const reject = await page.request.post(
    `${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/requests/${rejectedRequestId}/reject`,
    { headers: apiHeaders },
  );
  expect(reject.status()).toBe(200);
  await expect.poll(async () => {
    const response = await page.request.get(`${mockOrigin}/__test/redemptions`);
    const body = await response.json() as { items: Array<{ id: string; status: string }> };
    return body.items.find((item) => item.id === rejectedId)?.status;
  }, { timeout: 25_000 }).toBe("CANCELED");
});
