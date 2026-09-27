import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppAccessToken: vi.fn(),
  helixRequest: vi.fn(),
}));

vi.mock("../../src/worker/app-token", () => ({ getAppAccessToken: mocks.getAppAccessToken }));
vi.mock("../../src/worker/twitch/helix", () => ({ helixRequest: mocks.helixRequest }));

import { createOverlayElementContext } from "../../src/worker/overlays/element-context";

const database = {
  prepare: (sql: string) => ({
    bind: () => ({
      first: () => Promise.resolve(sql.includes("FROM channels")
        ? { login: "streamer", language: "en", time_zone: "UTC" }
        : null),
      all: () => Promise.resolve({ results: [] }),
    }),
  }),
} as unknown as D1Database;

const environment = { DB: database, TWITCH_CLIENT_ID: "client-id" } as unknown as Env;

describe("overlay element template context", () => {
  beforeEach(() => {
    mocks.getAppAccessToken.mockResolvedValue("app-token");
    mocks.helixRequest.mockReset();
  });

  it("renders the live viewer count returned by the chat stream lookup", async () => {
    mocks.helixRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { data: [{ started_at: "2026-09-27T12:00:00.000Z", viewer_count: 42 }] },
    });
    const context = await createOverlayElementContext(environment, "channel-a", "en", Date.parse("2026-09-27T12:30:00.000Z"));

    await expect(context.renderTemplate("{viewers}")).resolves.toMatchObject({ text: "42" });
    expect(mocks.helixRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.twitch.tv/helix/streams",
      query: { user_id: "channel-a", type: "live" },
    }));
  });

  it("uses the chat unavailable output when the stream viewer count cannot be read", async () => {
    mocks.helixRequest.mockResolvedValue({
      ok: false,
      status: 503,
      reason: "http_error",
      message: "unavailable",
      body: {},
    });
    const context = await createOverlayElementContext(environment, "channel-a", "en", Date.parse("2026-09-27T12:30:00.000Z"));

    await expect(context.renderTemplate("{viewers}")).resolves.toMatchObject({ text: "?" });
  });
});
