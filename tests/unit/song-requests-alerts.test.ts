import { afterEach, describe, expect, it, vi } from "vitest";

import { transitionRequest } from "../../src/modules/song_requests/adapters/d1";
import type { ModuleOverlayAlertQueueItem } from "../../src/modules/contract";
import { enqueueSongRequestAlert } from "../../src/modules/song_requests/service";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-request-alerts";
const TRACK = {
  id: "glassharbor01",
  uri: "spotify:track:glassharbor01",
  title: "Glass Harbor",
  artists: ["Mira Vale"],
  albumName: "Quiet Atlas",
  durationMs: 201_000,
  explicit: false,
  coverUrl: null,
  spotifyUrl: "https://open.spotify.com/track/glassharbor01",
};
const databases: TestD1Database[] = [];

const createDatabase = async (settings = { requestAlert: { enabled: true } }): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  await database.prepare("UPDATE channels SET language = 'en' WHERE channel_id = ?").bind(CHANNEL_ID).run();
  await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, ?)")
    .bind(CHANNEL_ID, JSON.stringify(settings)).run();
  return database;
};

const addApprovedRequest = async (
  database: TestD1Database,
  requestId: string,
  requestType: "vote" | "bot_points" | "free" | "channel_points",
): Promise<void> => {
  await transitionRequest(database as unknown as D1Database, {
    channelId: CHANNEL_ID,
    requestId,
    fromState: null,
    toState: "approved",
    now: "2026-11-17T19:00:00.000Z",
    newRequest: {
      source: requestType === "vote" ? "mod_vote" : requestType === "channel_points" ? "channel_points" : "points",
      requestType,
      track: TRACK,
      operationId: `operation-${requestId}`,
      streamId: "stream-alerts",
      roundId: "stream-alerts",
      requesterUserId: "viewer-alerts",
      requesterLogin: "viewer_alerts",
      requesterDisplayName: "Viewer One",
    },
  });
};

const queueMock = () => {
  const operationIds = new Set<string>();
  const enqueue = vi.fn<(operationId: string, alert: ModuleOverlayAlertQueueItem) => Promise<"duplicate" | "enqueued">>((operationId) => {
    if (operationIds.has(operationId)) return Promise.resolve("duplicate");
    operationIds.add(operationId);
    return Promise.resolve("enqueued");
  });
  return { enqueue };
};

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("song request approval alerts", () => {
  it.each([
    ["vote", "Song vote: Mira Vale – Glass Harbor (Quiet Atlas)"],
    ["bot_points", "Viewer One · Bot points: Mira Vale – Glass Harbor (Quiet Atlas)"],
    ["free", "Viewer One · Free request: Mira Vale – Glass Harbor (Quiet Atlas)"],
    ["channel_points", "Viewer One · Channel points: Mira Vale – Glass Harbor (Quiet Atlas)"],
  ] as const)("formats the %s approval payload with the shared track and message template", async (requestType, expectedText) => {
    const database = await createDatabase();
    const requestId = `request-${requestType}`;
    await addApprovedRequest(database, requestId, requestType);
    const overlayAlertQueue = queueMock();
    const resolveTwitchUserById = vi.fn((userId: string) => Promise.resolve({
      userId,
      login: "viewer_alerts",
      displayName: "Viewer One",
      profileImageUrl: "https://static-cdn.jtvnw.net/avatar.png",
    }));

    await enqueueSongRequestAlert({
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      overlayAlertQueue,
      resolveTwitchUserById,
    }, requestId);

    const expectedPayload = {
      text: expectedText,
      durationSeconds: 5,
      volumePercent: 0,
    };
    expect(overlayAlertQueue.enqueue).toHaveBeenCalledWith(`song-request-alert:${requestId}`, requestType === "vote"
      ? expectedPayload
      : { ...expectedPayload, avatarUrl: "https://static-cdn.jtvnw.net/avatar.png" });
    expect(resolveTwitchUserById).toHaveBeenCalledTimes(requestType === "vote" ? 0 : 1);
  });

  it("uses the channel language, keeps alerts idempotent, and delivers without an avatar", async () => {
    const database = await createDatabase();
    await database.prepare("UPDATE channels SET language = 'de' WHERE channel_id = ?").bind(CHANNEL_ID).run();
    await addApprovedRequest(database, "request-german", "free");
    const overlayAlertQueue = queueMock();
    const context = {
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      overlayAlertQueue,
      resolveTwitchUserById: () => Promise.resolve(null),
    };

    await enqueueSongRequestAlert(context, "request-german");
    await enqueueSongRequestAlert(context, "request-german");

    expect(overlayAlertQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(overlayAlertQueue.enqueue.mock.calls.map(([operationId]) => operationId))
      .toEqual(["song-request-alert:request-german", "song-request-alert:request-german"]);
    expect(overlayAlertQueue.enqueue.mock.calls[0]?.[1]).toEqual({
      text: "Viewer One · Kostenloser Wunsch: Mira Vale – Glass Harbor (Quiet Atlas)",
      durationSeconds: 5,
      volumePercent: 0,
    });
    await expect(overlayAlertQueue.enqueue.mock.results[1]?.value).resolves.toBe("duplicate");
  });

  it("does not enqueue when request alerts are disabled or the request has not been approved", async () => {
    const disabledDatabase = await createDatabase({ requestAlert: { enabled: false } });
    await addApprovedRequest(disabledDatabase, "request-disabled-alert", "free");
    const disabledQueue = queueMock();
    await enqueueSongRequestAlert({ DB: disabledDatabase as unknown as D1Database, channelId: CHANNEL_ID, overlayAlertQueue: disabledQueue }, "request-disabled-alert");
    expect(disabledQueue.enqueue).not.toHaveBeenCalled();

    const pendingDatabase = await createDatabase();
    await transitionRequest(pendingDatabase as unknown as D1Database, {
      channelId: CHANNEL_ID,
      requestId: "request-pending-alert",
      fromState: null,
      toState: "pending_review",
      now: "2026-11-17T19:00:00.000Z",
      newRequest: { source: "points", requestType: "free", track: TRACK, operationId: "pending-operation", streamId: "stream-alerts" },
    });
    const pendingQueue = queueMock();
    await enqueueSongRequestAlert({ DB: pendingDatabase as unknown as D1Database, channelId: CHANNEL_ID, overlayAlertQueue: pendingQueue }, "request-pending-alert");
    expect(pendingQueue.enqueue).not.toHaveBeenCalled();
  });
});
