import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  createE2ESessionCredentials,
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
  await page.request.post(`${e2eWorkerEnvironment.SPOTIFY_ACCOUNTS_BASE}/__test/reset`);
  const credentials = createE2ESessionCredentials();
  await page.context().addCookies([
    { name: "__Host-brobot_session", value: credentials.cookie, domain: localWorkerHost, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__Host-brobot_csrf", value: credentials.csrfToken, domain: localWorkerHost, path: "/", secure: true, sameSite: "Lax" },
  ]);

  await page.goto(`${e2eWorkerOrigin}/channels/${channelId}/modules/song_requests`);
  await expect(page.getByRole("heading", { name: "Spotify and song vote" })).toBeVisible();
  await expect(page.getByText("Spotify is not connected yet.")).toBeVisible();
  await page.getByRole("button", { name: "Connect Spotify" }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${channelId}/modules/song_requests\\?spotify=connected$`u));
  await expect(page.getByText("Spotify is connected.")).toBeVisible();

  const overlayPage = await page.context().newPage();
  await overlayPage.goto(`/tests/e2e/fixtures/overlay-embed.html#token=${encodeURIComponent(overlay.overlayToken)}&origin=${encodeURIComponent(e2eWorkerOrigin)}`);
  const frame = overlayPage.frameLocator("#overlay-frame");
  await expect(frame.locator(".song-requests-now-playing")).toBeVisible();

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
  await expect.poll(async () => (await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/connection`)).json())
    .toMatchObject({ state: "connected", streamId: expect.any(String) });

  await page.getByRole("textbox", { name: "Track, Spotify link, or URI" }).fill("Glass Harbor");
  await page.getByRole("button", { name: "Search" }).click();
  for (const title of ["Glass Harbor", "Quiet Atlas", "Silver Current"]) await expect(page.getByText(title).first()).toBeVisible();
  for (const title of ["Glass Harbor", "Quiet Atlas", "Silver Current"]) {
    const row = page.getByText(title).first().locator("xpath=ancestor::article");
    await row.getByRole("button", { name: "Add to vote" }).click();
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
    headers: { "X-CSRF-Token": credentials.csrfToken },
    data: { pollId: vote.ballotId },
  });
  expect(closeVote.status()).toBe(200);

  await expect.poll(async () => {
    const response = await page.request.get(`${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/requests`);
    if (!response.ok()) return null;
    const body = await response.json() as { requests: Array<{ title: string; state: string }> };
    return body.requests[0] ?? null;
  }, { timeout: 25_000 }).toMatchObject({ title: "Quiet Atlas", state: "submitted" });
  await expect(frame.locator(".song-requests-now-playing__copy h2")).toHaveText("Quiet Atlas", { timeout: 30_000 });
  await expect(frame.locator(".song-requests-now-playing__spotify")).toHaveText("Spotify");

  await overlayPage.close();
});
