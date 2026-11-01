import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withBroadcasterToken: vi.fn(),
  helixRequest: vi.fn(),
}));

vi.mock("../../src/worker/auth/broadcaster-token", () => ({
  withBroadcasterToken: mocks.withBroadcasterToken,
}));
vi.mock("../../src/worker/twitch/helix", () => ({
  helixRequest: mocks.helixRequest,
}));

import { listChannelVips } from "../../src/worker/twitch/vips";

const environment = { TWITCH_CLIENT_ID: "client-id" } as Env;

describe("listChannelVips", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.withBroadcasterToken.mockImplementation(async (
      _environment: Env,
      _broadcasterId: string,
      _scopes: string[],
      request: (accessToken: string) => Promise<unknown>,
    ) => {
      const response = await request("broadcaster-token") as { ok: boolean; data?: unknown };
      return response.ok
        ? { kind: "ok", value: response.data }
        : { kind: "http_error", result: response };
    });
  });

  it("uses the broadcaster VIP scope and follows pagination while mapping people", async () => {
    mocks.helixRequest
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [{ user_id: "user_first", user_login: "firstlogin", user_name: "First Person" }], pagination: { cursor: "cursor-next" } },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [{ user_id: "user_second", user_login: "secondlogin", user_name: "Second Person" }] },
      });

    const result = await listChannelVips(environment, "channel_demo", vi.fn<typeof fetch>());

    expect(result).toEqual({ ok: true, people: [
      { userId: "user_first", login: "firstlogin", displayName: "First Person" },
      { userId: "user_second", login: "secondlogin", displayName: "Second Person" },
    ] });
    expect(mocks.withBroadcasterToken.mock.calls[0]?.slice(0, 3)).toEqual([
      environment,
      "channel_demo",
      ["channel:manage:vips"],
    ]);
    expect(mocks.helixRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      url: "https://api.twitch.tv/helix/channels/vips",
      accessToken: "broadcaster-token",
      query: { broadcaster_id: "channel_demo", first: "100", after: undefined },
    }));
    expect(mocks.helixRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({
      query: { broadcaster_id: "channel_demo", first: "100", after: "cursor-next" },
    }));
  });

  it("rejects malformed VIP pages and repeated pagination cursors", async () => {
    mocks.helixRequest.mockResolvedValueOnce({ ok: true, status: 200, data: { data: [{ user_id: "missing-login" }] } });
    await expect(listChannelVips(environment, "channel_demo", vi.fn<typeof fetch>()))
      .resolves.toEqual({ ok: false, reason: "invalid_response" });

    mocks.helixRequest
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: [], pagination: { cursor: "same-cursor" } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: [], pagination: { cursor: "same-cursor" } } });
    await expect(listChannelVips(environment, "channel_demo", vi.fn<typeof fetch>()))
      .resolves.toEqual({ ok: false, reason: "invalid_response" });
  });
});
