import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAppAccessToken, readCachedAppAccessToken, botAccessTokenFor, helixRequest } = vi.hoisted(() => ({
  getAppAccessToken: vi.fn(),
  readCachedAppAccessToken: vi.fn(),
  botAccessTokenFor: vi.fn(),
  helixRequest: vi.fn(),
}));

vi.mock("../../src/worker/app-token", () => ({ getAppAccessToken, readCachedAppAccessToken }));
vi.mock("../../src/worker/twitch/bot-access", () => ({ botAccessTokenFor }));
vi.mock("../../src/worker/twitch/helix", () => ({ helixRequest }));

import { fetchLiveChattersTotal, fetchLiveViewerCount } from "../../src/worker/twitch/aggregate-counts";

const environment = {
  DB: {} as D1Database,
  TWITCH_CLIENT_ID: "client-id",
} as Env;

describe("statistics Helix count lookups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAppAccessToken.mockResolvedValue("app-token");
    readCachedAppAccessToken.mockResolvedValue("app-token");
    botAccessTokenFor.mockResolvedValue({
      userId: "bot-user",
      accessToken: "bot-token",
      scopes: ["moderator:read:chatters"],
    });
    helixRequest.mockResolvedValue({ ok: true, status: 200, data: { data: [{ viewer_count: 18 }] } });
  });

  it("reads the live viewer count with Get Streams", async () => {
    await expect(fetchLiveViewerCount(environment, "broadcaster")).resolves.toBe(18);
    expect(helixRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.twitch.tv/helix/streams",
      query: { user_id: "broadcaster", type: "live" },
      accessToken: "app-token",
    }));
  });

  it("budgets an app-token request separately from the Helix lookup", async () => {
    readCachedAppAccessToken.mockResolvedValue(null);
    const budget = { claim: vi.fn(() => true) };

    await expect(fetchLiveViewerCount(environment, "broadcaster", budget)).resolves.toBe(18);

    expect(budget.claim).toHaveBeenCalledTimes(2);
    expect(getAppAccessToken).toHaveBeenCalledTimes(1);
  });

  it("reads Get Chatters total with the bot token and moderator scope", async () => {
    helixRequest.mockResolvedValue({ ok: true, status: 200, data: { total: 6 } });
    await expect(fetchLiveChattersTotal(environment, "broadcaster")).resolves.toBe(6);
    expect(helixRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.twitch.tv/helix/chat/chatters",
      query: { broadcaster_id: "broadcaster", moderator_id: "bot-user" },
      accessToken: "bot-token",
    }));
  });

  it("does not call Get Chatters when the bot lacks its required scope", async () => {
    botAccessTokenFor.mockResolvedValue({
      userId: "bot-user",
      accessToken: "bot-token",
      scopes: [],
    });
    await expect(fetchLiveChattersTotal(environment, "broadcaster")).resolves.toBeNull();
    expect(helixRequest).not.toHaveBeenCalled();
  });

  it("returns unknown when the external fetch budget is exhausted", async () => {
    const budget = { claim: vi.fn(() => false) };
    await expect(fetchLiveViewerCount(environment, "broadcaster", budget)).resolves.toBeNull();
    await expect(fetchLiveChattersTotal(environment, "broadcaster", budget)).resolves.toBeNull();
    expect(helixRequest).not.toHaveBeenCalled();
  });

  it("keeps malformed or unavailable counts unknown", async () => {
    helixRequest.mockResolvedValue({ ok: true, status: 200, data: { data: [{ viewer_count: -1 }] } });
    await expect(fetchLiveViewerCount(environment, "broadcaster")).resolves.toBeNull();
    helixRequest.mockResolvedValue({ ok: false, status: 403, reason: "http_403", body: {} });
    await expect(fetchLiveChattersTotal(environment, "broadcaster")).resolves.toBeNull();
  });
});
