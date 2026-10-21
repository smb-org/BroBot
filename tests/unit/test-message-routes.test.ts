import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { sendChatMessage as SendChatMessage } from "../../src/worker/chat";

const mocks = vi.hoisted(() => ({ sendChatMessage: vi.fn<typeof SendChatMessage>() }));
vi.mock("../../src/worker/chat", () => ({ sendChatMessage: mocks.sendChatMessage }));

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database } from "./test-d1";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

let database: TestD1Database;
let lastAttemptByChannel: Map<string, number>;
let identityPrepared: boolean;

const environmentFor = (): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  CHANNEL: {
    idFromName: (channelId: string) => channelId,
    get: (channelId: string) => ({
      claimTestMessageSend: (now: number): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> => {
        const previous = lastAttemptByChannel.get(channelId);
        if (previous !== undefined && now - previous < 30_000) {
          return Promise.resolve({ allowed: false, retryAfter: Math.max(1, Math.ceil((previous + 30_000 - now) / 1_000)) });
        }
        lastAttemptByChannel.set(channelId, now);
        return Promise.resolve({ allowed: true });
      },
    }),
  },
  ...environmentKeys,
} as unknown as Env);

const requestFor = async (userId: string, channelId: string): Promise<Request> => {
  const cookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  const csrf = await createCsrfToken(`session-${userId}`, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example/api/channels/${channelId}/quick-actions/test-message`, {
    method: "POST",
    headers: new Headers({
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    }),
  });
};

const send = async (userId: string, channelId: string): Promise<Response> => panelRouter.fetch(
  await requestFor(userId, channelId),
  environmentFor(),
);

const chatResult = (overrides: Partial<{
  sent: boolean;
  truncated: boolean;
  delivery: "sent" | "rejected" | "ambiguous" | "not_attempted";
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
}> = {}) => ({
  sent: true,
  truncated: false,
  delivery: "sent" as const,
  reason: null,
  detail: {},
  ...overrides,
});

beforeEach(() => {
  database = new TestD1Database();
  lastAttemptByChannel = new Map();
  identityPrepared = false;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T10:00:00.000Z"));
  vi.mocked(mocks.sendChatMessage).mockReset();
  vi.mocked(mocks.sendChatMessage).mockImplementation(async (...args) => {
    const claim = await args[6]?.();
    if (claim === "rate_limited") return chatResult({
      sent: false,
      delivery: "not_attempted",
      reason: "rate_limited",
    });
    return chatResult();
  });
});

afterEach(() => {
  vi.useRealTimers();
  database.close();
});

const prepareChannel = async (channelId: string, language: "de" | "en" = "en"): Promise<void> => {
  await insertChannel(database, channelId);
  await database.prepare("UPDATE channels SET language = ? WHERE channel_id = ?").bind(language, channelId).run();
  if (!identityPrepared) {
    await insertLoginIdentityAndSession(database, "operator-a");
    identityPrepared = true;
  }
  await insertMember(database, channelId, "operator-a", "operator");
};

describe("quick action test-message route", () => {
  it("returns sent when Twitch accepts the message", async () => {
    await prepareChannel("channel-a", "en");

    const response = await send("operator-a", "channel-a");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: "sent" });
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      "channel-a",
      "This is a test message from BroBot.",
      undefined,
      expect.any(Function),
      undefined,
      expect.any(Function),
    );
  });

  it("returns dropped when Twitch does not send the message", async () => {
    await prepareChannel("channel-a");
    vi.mocked(mocks.sendChatMessage).mockResolvedValue(chatResult({
      sent: false,
      delivery: "rejected",
      reason: "automod_held",
    }));

    const response = await send("operator-a", "channel-a");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: "dropped", reason: "automod_held" });
  });

  it("returns identity_missing when no bot identity is configured", async () => {
    await prepareChannel("channel-a");
    vi.mocked(mocks.sendChatMessage).mockResolvedValue(chatResult({
      sent: false,
      delivery: "not_attempted",
      reason: "bot_identity_missing",
    }));

    const response = await send("operator-a", "channel-a");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: "identity_missing" });
  });

  it("rate limits a second send for the same channel within 30 seconds", async () => {
    await prepareChannel("channel-a");

    const first = await send("operator-a", "channel-a");
    const second = await send("operator-a", "channel-a");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ result: "rate_limited", retryAfter: 30 });
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(2);
  });

  it("rejects a caller who does not have the minimum channel role", async () => {
    await prepareChannel("channel-a");
    await insertLoginIdentityAndSession(database, "outsider");

    const response = await send("outsider", "channel-a");

    expect(response.status).toBe(403);
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });

  it("keeps the rate limit isolated between channels", async () => {
    await prepareChannel("channel-a", "de");
    await prepareChannel("channel-b", "en");

    const first = await send("operator-a", "channel-a");
    const second = await send("operator-a", "channel-b");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ result: "sent" });
    await expect(second.json()).resolves.toEqual({ result: "sent" });
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(2);
  });
});
