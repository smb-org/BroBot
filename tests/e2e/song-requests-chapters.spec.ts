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

test("creates a soundtrack chapter and starts a vote from its pool in the cockpit", async ({ page }) => {
  test.setTimeout(90_000);
  const channelId = `channel-chapter-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const overlay = seedE2ESongRequests(channelId);
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

  const postEventSub = async (type: "stream.online", event: Record<string, unknown>): Promise<void> => {
    const messageId = `eventsub-chapter-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const payload = {
      subscription: {
        id: "subscription-chapter-stream-online",
        type,
        version: "1",
        status: "enabled",
        condition: { broadcaster_user_id: channelId },
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

  await postEventSub("stream.online", {
    id: `stream-chapter-${randomUUID()}`,
    broadcaster_user_id: channelId,
    broadcaster_user_login: overlay.channelLogin,
    broadcaster_user_name: "E2E Kanal",
    type: "live",
    started_at: new Date().toISOString(),
  });
  const apiHeaders = {
    Cookie: `__Host-brobot_session=${credentials.cookie}; __Host-brobot_csrf=${credentials.csrfToken}`,
    "X-CSRF-Token": credentials.csrfToken,
  };
  await expect.poll(async (): Promise<unknown> => (await page.request.get(
    `${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/connection`, { headers: apiHeaders },
  )).json()).toMatchObject({ state: "connected", streamId: expect.any(String) });

  await page.goto(`${e2eWorkerOrigin}/channels/${channelId}/modules/song_requests?page=chapters`);
  await page.getByRole("button", { name: "Create chapter" }).click();
  await page.getByRole("textbox", { name: "Chapter name" }).fill("Night Drive");
  await page.getByRole("switch", { name: "Offer in cockpit" }).click();
  await page.getByRole("textbox", { name: "Search Spotify" }).fill("Glass Harbor");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  for (const title of ["Glass Harbor", "Quiet Atlas", "Silver Current"]) {
    await page.getByRole("button", { name: "Add", exact: true }).first().click();
    await expect(page.getByText(title).first()).toBeVisible();
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Night Drive" })).toBeVisible();
  await expect.poll(async (): Promise<unknown> => (await page.request.get(
    `${e2eWorkerOrigin}/api/channels/${channelId}/modules/song_requests/chapters/offered`, { headers: apiHeaders },
  )).json()).toMatchObject({ chapters: [expect.objectContaining({ name: "Night Drive", offerInCockpit: true })] });

  await page.goto(`${e2eWorkerOrigin}/channels/${channelId}`);
  const action = page.getByRole("button", { name: "Start chapter vote" });
  await expect(action).toBeEnabled();
  await action.click();
  const dialog = page.getByRole("dialog", { name: "Start chapter vote" });
  const startedVoteResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/channels/${channelId}/modules/song_requests/vote`,
  );
  await dialog.getByRole("button", { name: "Start chapter", exact: true }).click();
  const response = await startedVoteResponse;
  expect(response.status()).toBe(201);
  const vote = await response.json() as { ballotId: string; tracks: Array<{ id: string }> };
  expect(vote.ballotId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(vote.tracks).toHaveLength(3);
  const byText = (left: string, right: string): number => left.localeCompare(right);
  expect(vote.tracks.map(({ id }) => id).sort(byText)).toEqual(["glassharbor01", "quietatlas02", "silvercurrent03"].sort(byText));
});
