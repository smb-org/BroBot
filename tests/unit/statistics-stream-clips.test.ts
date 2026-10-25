import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAppAccessToken, readCachedAppAccessToken, helixRequest } = vi.hoisted(() => ({
  getAppAccessToken: vi.fn(),
  readCachedAppAccessToken: vi.fn(),
  helixRequest: vi.fn(),
}));

vi.mock("../../src/worker/app-token", () => ({ getAppAccessToken, readCachedAppAccessToken }));
vi.mock("../../src/worker/twitch/helix", () => ({ helixRequest }));

import { fetchStreamClips } from "../../src/worker/twitch/stream-clips";

const environment = {
  DB: {} as D1Database,
  TWITCH_CLIENT_ID: "client-id",
} as Env;

const rawClip = (index: number): Record<string, unknown> => ({
  id: `clip-${String(index)}`,
  title: `Clip ${String(index)}`,
  created_at: "2026-10-25T12:04:00.000Z",
  view_count: index,
  duration: 29.5,
  creator_id: "private-creator-id",
  creator_name: "Private Creator",
  broadcaster_id: "private-broadcaster-id",
  broadcaster_name: "Private Broadcaster",
  game_id: "private-game-id",
});

describe("stream clip lookup", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-25T12:20:00.000Z"));
    vi.clearAllMocks();
    readCachedAppAccessToken.mockResolvedValue("app-token");
    getAppAccessToken.mockResolvedValue("app-token");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows at most two pages and returns privacy-safe clip details", async () => {
    for (let page = 0; page < 2; page += 1) {
      helixRequest.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          data: Array.from({ length: 100 }, (_, item) => rawClip(page * 100 + item)),
          pagination: { cursor: `cursor-${String(page + 1)}` },
        },
      });
    }

    const clips = await fetchStreamClips(
      environment,
      "broadcaster-1",
      "2026-10-25T08:00:00.000Z",
      "2026-10-25T12:05:00.000Z",
    );

    expect(clips).toHaveLength(200);
    expect(helixRequest).toHaveBeenCalledTimes(2);
    expect(helixRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      url: "https://api.twitch.tv/helix/clips",
      clientId: "client-id",
      accessToken: "app-token",
      query: {
        broadcaster_id: "broadcaster-1",
        started_at: "2026-10-25T08:00:00.000Z",
        ended_at: "2026-10-25T12:05:00.000Z",
        first: "100",
        after: undefined,
      },
    }));
    const secondRequest: unknown = helixRequest.mock.calls[1]?.[0];
    expect(secondRequest).toMatchObject({ query: { after: "cursor-1" } });
    expect(clips?.[0]).toEqual({
      clipId: "clip-0",
      title: "Clip 0",
      createdAt: "2026-10-25T12:04:00.000Z",
      viewCount: 0,
      durationSeconds: 29.5,
    });
    expect(JSON.stringify(clips)).not.toMatch(/creator|broadcaster|game_id/iu);
  });

  it("keeps the lookup pending when any page fails", async () => {
    helixRequest
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [rawClip(1)], pagination: { cursor: "next" } },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        reason: "http_503",
        message: "Unavailable",
        body: {},
      });

    await expect(fetchStreamClips(
      environment,
      "broadcaster-1",
      "2026-10-25T08:00:00.000Z",
      "2026-10-25T12:05:00.000Z",
    )).resolves.toBeNull();
    expect(helixRequest).toHaveBeenCalledTimes(2);
  });

  it("keeps the fetched page when the next page is outside the external fetch budget", async () => {
    helixRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { data: [rawClip(1)], pagination: { cursor: "next" } },
    });
    const budget = { claim: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false) };

    const clips = await fetchStreamClips(
      environment,
      "broadcaster-1",
      "2026-10-25T08:00:00.000Z",
      "2026-10-25T12:05:00.000Z",
      budget,
    );

    expect(clips).toHaveLength(1);
    expect(clips?.[0]?.clipId).toBe("clip-1");
    expect(helixRequest).toHaveBeenCalledOnce();
  });

  it("fits two pages and the token request in the three-request budget", async () => {
    readCachedAppAccessToken.mockResolvedValue(null);
    helixRequest
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: Array.from({ length: 100 }, (_, item) => rawClip(item)), pagination: { cursor: "next" } },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: Array.from({ length: 100 }, (_, item) => rawClip(100 + item)), pagination: {} },
      });
    const budget = { claim: vi.fn(() => true) };

    const clips = await fetchStreamClips(
      environment,
      "broadcaster-1",
      "2026-10-25T08:00:00.000Z",
      "2026-10-25T12:05:00.000Z",
      budget,
    );

    expect(clips).toHaveLength(200);
    expect(budget.claim).toHaveBeenCalledTimes(3);
    expect(getAppAccessToken).toHaveBeenCalledOnce();
  });

  it("refreshes a cached app token once after a Helix 401", async () => {
    helixRequest
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        reason: "http_401",
        message: "Unauthorized",
        body: {},
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [rawClip(7)], pagination: {} },
      });
    const budget = { claim: vi.fn(() => true) };
    const fetcher = vi.fn<typeof fetch>();

    const clips = await fetchStreamClips(
      environment,
      "broadcaster-1",
      "2026-10-25T08:00:00.000Z",
      "2026-10-25T12:05:00.000Z",
      budget,
      fetcher,
    );

    expect(clips?.map(({ clipId }) => clipId)).toEqual(["clip-7"]);
    expect(getAppAccessToken).toHaveBeenCalledWith(environment, "2026-10-25T12:20:00.000Z", fetcher, true);
    expect(budget.claim).toHaveBeenCalledTimes(3);
  });
});
