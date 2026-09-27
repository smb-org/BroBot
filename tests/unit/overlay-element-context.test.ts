import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppAccessToken: vi.fn(),
  helixRequest: vi.fn(),
  getOverlayStreamDetails: vi.fn(),
}));

vi.mock("../../src/worker/app-token", () => ({ getAppAccessToken: mocks.getAppAccessToken }));
vi.mock("../../src/worker/twitch/helix", () => ({ helixRequest: mocks.helixRequest }));

import { createOverlayElementContext } from "../../src/worker/overlays/element-context";

const startedAt = "2026-09-27T12:00:00.000Z";
let streamStateRow: Record<string, unknown> | null;

const database = {
  prepare: (sql: string) => ({
    bind: () => ({
      first: () => Promise.resolve(sql.includes("FROM channels")
        ? { login: "streamer", language: "en", time_zone: "UTC" }
        : sql.includes("FROM channel_stream_state")
          ? streamStateRow
          : null),
      all: () => Promise.resolve({ results: [] }),
    }),
  }),
} as unknown as D1Database;

const environment = {
  DB: database,
  TWITCH_CLIENT_ID: "client-id",
  CHANNEL: {
    idFromName: (channelId: string) => channelId,
    get: () => ({ getOverlayStreamDetails: mocks.getOverlayStreamDetails }),
  },
} as unknown as Env;

describe("overlay element template context", () => {
  beforeEach(() => {
    streamStateRow = { state: "online", source: "eventsub", changed_at: startedAt, started_at: startedAt, stream_id: "stream-1", checked_at: startedAt };
    mocks.getAppAccessToken.mockResolvedValue("app-token");
    mocks.helixRequest.mockReset();
    mocks.getOverlayStreamDetails.mockReset();
  });

  it("renders viewer counts through the channel's shared stream-details cache", async () => {
    const now = Date.parse("2026-09-27T12:30:00.000Z");
    const expiresAt = now + 60_000;
    mocks.getOverlayStreamDetails.mockResolvedValue({ details: { startedAt, viewerCount: 42 }, expiresAt });
    const context = await createOverlayElementContext(environment, "channel-a", "en", now);

    await expect(context.renderTemplate("{viewers}")).resolves.toMatchObject({ text: "42" });
    expect(mocks.getOverlayStreamDetails).toHaveBeenCalledWith(startedAt, "stream-1", now);
    expect(context.streamDetailsCacheExpiresAt()).toBe(expiresAt);
    expect(mocks.helixRequest).not.toHaveBeenCalled();
  });

  it("uses the chat unavailable output when the stream viewer count cannot be read", async () => {
    mocks.getOverlayStreamDetails.mockResolvedValue(null);
    const context = await createOverlayElementContext(environment, "channel-a", "en", Date.parse("2026-09-27T12:30:00.000Z"));

    await expect(context.renderTemplate("{viewers}")).resolves.toMatchObject({ text: "?" });
    expect(context.hasLookupFailure()).toBe(true);
  });

  it("uses the shared stream lookup to correct a stale offline state", async () => {
    streamStateRow = { state: "offline", source: "helix", changed_at: startedAt, started_at: null, stream_id: null, checked_at: startedAt };
    mocks.getOverlayStreamDetails.mockResolvedValue({
      details: { startedAt: "2026-09-27T12:29:00.000Z", viewerCount: 17 },
      expiresAt: Date.parse("2026-09-27T12:31:00.000Z"),
    });
    const context = await createOverlayElementContext(environment, "channel-a", "en", Date.parse("2026-09-27T12:30:00.000Z"));

    await expect(context.renderTemplate("{viewers}")).resolves.toMatchObject({ text: "17" });
    expect(mocks.getOverlayStreamDetails).toHaveBeenCalledWith(null, null, Date.parse("2026-09-27T12:30:00.000Z"));
  });

  it("loads viewer counts when the channel has no stored stream state", async () => {
    streamStateRow = null;
    mocks.getOverlayStreamDetails.mockResolvedValue({
      details: { startedAt, viewerCount: 23 },
      expiresAt: Date.parse("2026-09-27T12:31:00.000Z"),
    });
    const now = Date.parse("2026-09-27T12:30:00.000Z");
    const context = await createOverlayElementContext(environment, "channel-a", "en", now);

    await expect(context.renderTemplate("{viewers}")).resolves.toMatchObject({ text: "23" });
    expect(mocks.getOverlayStreamDetails).toHaveBeenCalledWith(null, null, now);
  });

  it("resolves title and game when the independent stream lookup fails", async () => {
    streamStateRow = { state: "unknown", source: "helix", changed_at: startedAt, started_at: null, stream_id: null, checked_at: startedAt };
    mocks.getOverlayStreamDetails.mockResolvedValue(null);
    mocks.helixRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { data: [{ title: "Late night coding", game_name: "Software and Game Development", game_id: "509658" }] },
    });
    const context = await createOverlayElementContext(environment, "channel-a", "en", Date.parse("2026-09-27T12:30:00.000Z"));

    await context.renderTemplate("{uptime}");
    await expect(context.channelGameId()).resolves.toBe("509658");
    await expect(context.renderTemplate("{title} · {game}")).resolves.toMatchObject({
      text: "Late night coding · Software and Game Development",
    });
    expect(context.hasLookupFailure()).toBe(true);
  });

  it("renders uptime from the stored stream start without a Helix streams lookup", async () => {
    const context = await createOverlayElementContext(environment, "channel-a", "en", Date.parse("2026-09-27T12:30:00.000Z"));

    const rendered = await context.renderTemplate("{uptime}");
    expect(rendered.text).toContain("30 min");
    expect(mocks.getOverlayStreamDetails).not.toHaveBeenCalled();
    expect(mocks.helixRequest).not.toHaveBeenCalled();
  });
});
