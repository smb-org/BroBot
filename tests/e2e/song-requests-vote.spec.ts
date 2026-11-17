import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  createE2ESessionCredentials,
  e2eSpotifyMockPort,
  e2eWorkerEnvironment,
  e2eWorkerOrigin,
  seedE2ESongRequests,
} from "./worker-fixtures";

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

const localWorkerHost = new URL(e2eWorkerOrigin).hostname;

test("connects mocked Spotify, votes on three tracks, and shows the winner as now playing", async ({ page }) => {
  test.setTimeout(90_000);
  const channelId = `channel-song-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const overlay = seedE2ESongRequests(channelId);
  await page.request.post(`http://127.0.0.1:${e2eSpotifyMockPort}/__test/reset`);
  const credentials = createE2ESessionCredentials();
  await page.context().addCookies([
    { name: "__Host-brobot_session", value: credentials.cookie, domain: localWorkerHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__Host-brobot_csrf", value: credentials.csrfToken, domain: localWorkerHost, path: "/", secure: true, sameSite: "Lax" },
  ]);

  await page.goto(`${e2eWorkerOrigin}/channels/${channelId}/modules/song_requests`);
  await expect(page.getByRole("heading", { name: "Song requests" })).toBeVisible();
  await expect(page.getByText("Spotify is not connected yet.")).toBeVisible();
  await page.getByRole("button", { name: "Connect Spotify" }).click();
  await expect(page.getByText("Spotify is connected.")).toBeVisible();

  const overlayPage = await page.context().newPage();
  await overlayPage.goto(`/tests/e2e/fixtures/overlay-embed.html#token=${encodeURIComponent(overlay.overlayToken)}&origin=${encodeURIComponent(e2eWorkerOrigin)}`);
  const frame = overlayPage.frameLocator("#overlay-frame");
  await expect(frame.locator(".song-requests-now-playing")).toBeAttached();
  await expect(frame.locator(".song-requests-now-playing")).toHaveCSS("visibility", "hidden");

  const postEventSub = async (type: "stream.online" | "channel.chat.message", event: Record<string, unknown>): Promise<void> => {
    const messageId = `eventsub-song-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const payload = {
      subscription: {
        id: `subscription-song-${type.replaceAll(".", "-")}`,
        type,
        version: "1",
        status: "enabled",
        condition: type === "channel.chat.message"
          ? { broadcaster_user_id: channelId, user_id: "bot-song-e2e" }
          : { broadcaster_user_id: channelId },
        transport: { method: "webhook", callback: `${e2eWorkerOrigin}/api/twitch/eventsub` },
        created_at: timestamp,
      },
      event,
    };
    const body = Buffer.from(JSON.stringify(payload));
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
    id: `stream-song-${randomUUID()}`,
    broadcaster_user_id: channelId,
    broadcaster_user_login: overlay.channelLogin,
    broadcaster_user_name: "E2E Kanal",
    type: "live",
    started_at: startedAt,
  });
  // Secure host-prefixed cookies are not replayed by the Node-side request jar over http, so API calls send them explicitly.
  const apiHeaders = { Cookie: `__Host-brobot_session=${credentials.cookie}; __Host-brobot_csrf=${credentials.csrfToken}`, "X-CSRF-Token": credentials.csrfToken };
  await expect.poll(async (): Promise<unknown> => (await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/connection`, { headers: apiHeaders })).json())
    .toMatchObject({ state: "connected", streamId: expect.any(String) });

  await page.getByRole("textbox", { name: "Track, Spotify link, or URI" }).fill("Glass Harbor");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  for (const title of ["Glass Harbor", "Quiet Atlas", "Silver Current"]) await expect(page.getByText(title).first()).toBeVisible();
  for (const title of ["Glass Harbor", "Quiet Atlas", "Silver Current"]) {
    await page.getByRole("button", { name: `Add ${title} to vote` }).click();
  }
  const startedVoteResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/channels/${channelId}/modules/song_requests/vote`,
  );
  await page.getByRole("button", { name: "Start vote" }).click();
  const voteResponse = await startedVoteResponse;
  expect(voteResponse.status()).toBe(201);
  const vote = await voteResponse.json() as { ballotId: string };

  const castVote = async (index: number, userId: string): Promise<void> => {
    const login = `frostfern${String(index)}`;
    const text = String(index);
    await postEventSub("channel.chat.message", {
      broadcaster_user_id: channelId,
      broadcaster_user_login: overlay.channelLogin,
      broadcaster_user_name: "E2E Kanal",
      chatter_user_id: userId,
      chatter_user_login: login,
      chatter_user_name: "Frost Fern",
      message_id: `message-song-${userId}`,
      message: { text, fragments: [{ type: "text", text }] },
      message_type: "text",
      badges: [],
    });
  };
  await castVote(1, "viewer-song-one");
  await castVote(2, "viewer-song-two");
  await castVote(2, "viewer-song-three");

  const closeVote = await page.request.post(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/chat_voting/close`, {
    headers: apiHeaders,
    data: { pollId: vote.ballotId },
  });
  expect(closeVote.status()).toBe(200);

  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/requests`, { headers: apiHeaders });
    if (!response.ok()) return null;
    const body = await response.json() as { requests: Array<{ title: string; state: string }> };
    return body.requests[0] ?? null;
  }, { timeout: 25_000 }).toMatchObject({ title: "Quiet Atlas", state: "submitted" });
  await expect(frame.getByRole("link", { name: "Quiet Atlas" })).toBeVisible({ timeout: 30_000 });
  await expect(frame.getByRole("region", { name: "Now playing" })).toBeVisible();
  await expect(frame.getByText("Spotify", { exact: true })).toBeVisible();

  await overlayPage.close();
});

test("starts a skip vote with !skip, counts yes votes, and advances mocked Spotify", async ({ page }) => {
  test.setTimeout(90_000);
  const channelId = `channel-skip-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const overlay = seedE2ESongRequests(channelId, {
    paymentMode: "free",
    freeRoleThreshold: "everyone",
    skipVote: { enabled: true, threshold: 2, cooldownSeconds: 120 },
  });
  const spotifyMockOrigin = `http://127.0.0.1:${e2eSpotifyMockPort}`;
  await page.request.post(`${spotifyMockOrigin}/__test/reset`);
  const credentials = createE2ESessionCredentials();
  await page.context().addCookies([
    { name: "__Host-brobot_session", value: credentials.cookie, domain: localWorkerHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__Host-brobot_csrf", value: credentials.csrfToken, domain: localWorkerHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
  ]);

  await page.goto(`${e2eWorkerOrigin}/channels/${channelId}/modules/song_requests`);
  await page.getByRole("button", { name: "Connect Spotify" }).click();
  await expect(page.getByText("Spotify is connected.")).toBeVisible();
  const overlayPage = await page.context().newPage();
  await overlayPage.goto(`/tests/e2e/fixtures/overlay-embed.html#token=${encodeURIComponent(overlay.overlayToken)}&origin=${encodeURIComponent(e2eWorkerOrigin)}`);
  const frame = overlayPage.frameLocator("#overlay-frame");

  const postEventSub = async (type: "stream.online" | "channel.chat.message", event: Record<string, unknown>): Promise<void> => {
    const messageId = `eventsub-skip-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const payload = {
      subscription: {
        id: `subscription-skip-${type.replaceAll(".", "-")}`,
        type,
        version: "1",
        status: "enabled",
        condition: type === "channel.chat.message"
          ? { broadcaster_user_id: channelId, user_id: "bot-skip-e2e" }
          : { broadcaster_user_id: channelId },
        transport: { method: "webhook", callback: `${e2eWorkerOrigin}/api/twitch/eventsub` },
        created_at: timestamp,
      },
      event,
    };
    const body = Buffer.from(JSON.stringify(payload));
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

  const timestamp = new Date().toISOString();
  await postEventSub("stream.online", {
    id: `stream-skip-${randomUUID()}`,
    broadcaster_user_id: channelId,
    broadcaster_user_login: overlay.channelLogin,
    broadcaster_user_name: "E2E Kanal",
    type: "live",
    started_at: timestamp,
  });
  const chat = (userId: string, text: string): Promise<void> => postEventSub("channel.chat.message", {
    broadcaster_user_id: channelId,
    broadcaster_user_login: overlay.channelLogin,
    broadcaster_user_name: "E2E Kanal",
    chatter_user_id: userId,
    chatter_user_login: `viewer_${userId}`,
    chatter_user_name: "Fictional Viewer",
    message_id: `message-skip-${userId}-${randomUUID()}`,
    message: { text, fragments: [{ type: "text", text }] },
    message_type: "text",
    badges: [],
  });

  await chat("viewer-skip-requester", "!sr spotify:track:glassharbor01");
  await expect(frame.getByRole("link", { name: "Glass Harbor" })).toBeVisible({ timeout: 30_000 });
  await chat("viewer-skip-starter", "!skip");
  await chat("viewer-skip-yes", "!skip");

  // Both yes votes are counted in the shared chat_voting ballot; closing it by hand skips the 30 s wait.
  const apiHeaders = { Cookie: `__Host-brobot_session=${credentials.cookie}; __Host-brobot_csrf=${credentials.csrfToken}`, "X-CSRF-Token": credentials.csrfToken };
  let ballotId = "";
  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/chat_voting/current`, { headers: apiHeaders });
    const body = await response.json() as { vote: { id: string; status: string } | null; counts: number[] | null };
    ballotId = body.vote?.id ?? "";
    return body.vote?.status === "open" ? body.counts : null;
  }, { timeout: 15_000 }).toEqual([2, 0]);
  const closeVote = await page.request.post(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/chat_voting/close`, {
    headers: apiHeaders,
    data: { pollId: ballotId },
  });
  expect(closeVote.status()).toBe(200);

  await expect.poll(async (): Promise<unknown> => (await page.request.get(`${spotifyMockOrigin}/__test/state`)).json(), { timeout: 45_000 })
    .toMatchObject({ currentTrackId: null, nextRequests: 1 });
  await overlayPage.close();
});
