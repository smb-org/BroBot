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

const database = {
  prepare: (sql: string) => ({
    bind: () => ({
      first: () => Promise.resolve(sql.includes("FROM channels")
        ? { login: "streamer", language: "en", time_zone: "UTC" }
        : sql.includes("FROM channel_stream_state")
          ? { state: "online", source: "eventsub", changed_at: startedAt, started_at: startedAt, stream_id: "stream-1", checked_at: startedAt }
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
    mocks.getAppAccessToken.mockResolvedValue("app-token");
    mocks.helixRequest.mockReset();
    mocks.getOverlayStreamDetails.mockReset();
  });

  it("renders viewer counts through the channel's shared stream-details cache", async () => {
    const now = Date.parse("2026-09-27T12:30:00.000Z");
    mocks.getOverlayStreamDetails.mockResolvedValue({ startedAt, viewerCount: 42 });
    const context = await createOverlayElementContext(environment, "channel-a", "en", now);

    await expect(context.renderTemplate("{viewers}")).resolves.toMatchObject({ text: "42" });
    expect(mocks.getOverlayStreamDetails).toHaveBeenCalledWith(startedAt, "stream-1", now);
    expect(mocks.helixRequest).not.toHaveBeenCalled();
  });

  it("uses the chat unavailable output when the stream viewer count cannot be read", async () => {
    mocks.getOverlayStreamDetails.mockResolvedValue(null);
    const context = await createOverlayElementContext(environment, "channel-a", "en", Date.parse("2026-09-27T12:30:00.000Z"));

    await expect(context.renderTemplate("{viewers}")).resolves.toMatchObject({ text: "?" });
  });

  it("renders uptime from the stored stream start without a Helix streams lookup", async () => {
    const context = await createOverlayElementContext(environment, "channel-a", "en", Date.parse("2026-09-27T12:30:00.000Z"));

    const rendered = await context.renderTemplate("{uptime}");
    expect(rendered.text).toContain("30 min");
    expect(mocks.getOverlayStreamDetails).not.toHaveBeenCalled();
    expect(mocks.helixRequest).not.toHaveBeenCalled();
  });
});
