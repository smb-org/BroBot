import { describe, expect, it, vi } from "vitest";

import { MODERATION_TIMEOUT_MAX_SECONDS, formatTimeoutDuration, rollTimeoutSeconds, timeoutDurationRangeSchema } from "../../src/modules/contracts/moderation";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { upsertLoginIdentity } from "../../src/worker/db/login-identity";
import { isTwitchChannelModerator, liftModerationBan, sendModerationBan } from "../../src/worker/moderation";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "1000001";
const BOT_USER_ID = "2000002";
const TARGET_USER_ID = "3000003";
const NOW = "2026-10-03T10:00:00.000Z";
const KEY_RING = JSON.stringify({
  active: { id: "active-key", key: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url") },
  retired: [],
});

const environmentFor = (database: TestD1Database, pausedUntil: number | null = null) => {
  let retryAfter = pausedUntil;
  const channelObject = {
    getTwitchRateLimitRetryAfter: vi.fn(() => Promise.resolve(retryAfter !== null && retryAfter > Date.now() ? retryAfter : null)),
    setTwitchRateLimitRetryAfter: vi.fn((value: number) => {
      retryAfter = value;
      return Promise.resolve();
    }),
  };
  return {
    environment: {
      DB: database as unknown as D1Database,
      TWITCH_CLIENT_ID: "test-client-id",
      TWITCH_CLIENT_SECRET: "test-client-secret",
      TOKEN_ENCRYPTION_KEYS: KEY_RING,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => channelObject,
      } as unknown as Env["CHANNEL"],
    },
    channelObject,
  };
};

const seedChannel = async (database: TestD1Database, isModerator = true): Promise<void> => {
  await insertChannel(database, CHANNEL_ID);
  const ciphertext = await encryptJson({ token: "fictional-bot-user-token" }, parseKeyRing(KEY_RING));
  await upsertBotIdentity(database as unknown as D1Database, {
    id: 1,
    userId: BOT_USER_ID,
    login: "fictional_bot",
    scopesJson: "[\"moderator:manage:banned_users\"]",
    accessTokenCiphertext: ciphertext,
    refreshTokenCiphertext: ciphertext,
    expiresAt: "2099-10-03T10:00:00.000Z",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await database.prepare(
    `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
     VALUES (?, ?, ?, NULL)`,
  ).bind(CHANNEL_ID, isModerator ? 1 : 0, NOW).run();
};

const seedBroadcasterIdentity = async (database: TestD1Database): Promise<void> => {
  const ciphertext = await encryptJson({ token: "fictional-broadcaster-token" }, parseKeyRing(KEY_RING));
  await upsertLoginIdentity(database as unknown as D1Database, {
    userId: CHANNEL_ID,
    login: "fictional_channel",
    scopesJson: '["moderation:read"]',
    tokenScopesJson: '["moderation:read"]',
    accessTokenCiphertext: ciphertext,
    refreshTokenCiphertext: ciphertext,
    expiresAt: "2099-10-03T10:00:00.000Z",
    status: "connected",
    reason: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
};

const responseFor = (status: number, message?: string): Response => new Response(
  JSON.stringify(message === undefined ? { data: [] } : { message }),
  { status, headers: { "content-type": "application/json" } },
);

const jsonRequestBody = (body: BodyInit | null | undefined): Record<string, unknown> | null => {
  if (typeof body !== "string") return null;
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
};

describe("moderation actions", () => {
  it("checks moderator targets with the connected broadcaster token and moderation scope", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      const broadcasterToken = await encryptJson({ token: "fictional-broadcaster-token" }, parseKeyRing(KEY_RING));
      await upsertLoginIdentity(database as unknown as D1Database, {
        userId: CHANNEL_ID,
        login: "fictional_channel",
        scopesJson: '["moderation:read"]',
        tokenScopesJson: '["moderation:read"]',
        accessTokenCiphertext: broadcasterToken,
        refreshTokenCiphertext: broadcasterToken,
        expiresAt: "2099-10-03T10:00:00.000Z",
        status: "connected",
        reason: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const { environment } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        data: [{ user_id: TARGET_USER_ID }],
      }), { status: 200, headers: { "content-type": "application/json" } }));

      await expect(isTwitchChannelModerator(environment, CHANNEL_ID, TARGET_USER_ID, fetcher)).resolves.toBe(true);

      const [input, init] = fetcher.mock.calls[0] ?? [];
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "");
      expect(url.origin + url.pathname).toBe("https://api.twitch.tv/helix/moderation/moderators");
      expect(url.searchParams.get("broadcaster_id")).toBe(CHANNEL_ID);
      expect(url.searchParams.get("user_id")).toBe(TARGET_USER_ID);
      expect(init?.headers).toMatchObject({ Authorization: "Bearer fictional-broadcaster-token" });
    } finally {
      database.close();
    }
  });

  it("fails moderator protection closed when the broadcaster token lacks moderation:read", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      const token = await encryptJson({ token: "fictional-broadcaster-token" }, parseKeyRing(KEY_RING));
      await upsertLoginIdentity(database as unknown as D1Database, {
        userId: CHANNEL_ID,
        login: "fictional_channel",
        scopesJson: "[]",
        tokenScopesJson: "[]",
        accessTokenCiphertext: token,
        refreshTokenCiphertext: token,
        expiresAt: "2099-10-03T10:00:00.000Z",
        status: "connected",
        reason: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const { environment } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>();

      await expect(isTwitchChannelModerator(environment, CHANNEL_ID, TARGET_USER_ID, fetcher)).resolves.toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("posts a timeout with the bot user token and truncates its reason to 500 characters", async () => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      const { environment } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(responseFor(200));
      const reason = "r".repeat(510);

      await expect(sendModerationBan(environment, CHANNEL_ID, {
        userId: TARGET_USER_ID,
        durationSeconds: 90,
        reason,
      }, fetcher)).resolves.toMatchObject({ outcome: "applied", reason: null, detail: { status: 200 } });

      expect(fetcher).toHaveBeenCalledTimes(1);
      const [input, init] = fetcher.mock.calls[0] ?? [];
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "");
      expect(url.origin + url.pathname).toBe("https://api.twitch.tv/helix/moderation/bans");
      expect(url.searchParams.get("broadcaster_id")).toBe(CHANNEL_ID);
      expect(url.searchParams.get("moderator_id")).toBe(BOT_USER_ID);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer fictional-bot-user-token", "Client-ID": "test-client-id" });
      expect(jsonRequestBody(init?.body)).toEqual({ data: { user_id: TARGET_USER_ID, duration: 90, reason: "r".repeat(500) } });
    } finally {
      database.close();
    }
  });

  it("suppresses a moderation POST when the channel pauses during bot token lookup", async () => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      const { environment } = environmentFor(database);
      const originalPrepare = database.prepare.bind(database);
      let pausedDuringTokenLookup = false;
      environment.DB = {
        prepare: (sql: string) => {
          const statement = originalPrepare(sql);
          if (!sql.includes("FROM bot_identity") || !sql.includes("access_token_ciphertext")) return statement;
          const wrapped = {
            bind: (...values: Parameters<typeof statement.bind>) => {
              statement.bind(...values);
              return wrapped;
            },
            first: async <T>() => {
              const identity = await statement.first<T>();
              if (!pausedDuringTokenLookup) {
                pausedDuringTokenLookup = true;
                await originalPrepare(
                  `INSERT INTO channel_controls (channel_id, paused, updated_at) VALUES (?, 1, ?)
                   ON CONFLICT(channel_id) DO UPDATE SET paused = 1, updated_at = excluded.updated_at`,
                ).bind(CHANNEL_ID, NOW).run();
              }
              return identity;
            },
            all: <T>(...typeHint: readonly T[]) => statement.all<T>(...typeHint),
            run: () => statement.run(),
          };
          return wrapped as unknown as D1PreparedStatement;
        },
        batch: database.batch.bind(database),
      } as unknown as D1Database;
      const fetcher = vi.fn<typeof fetch>();

      await expect(sendModerationBan(environment, CHANNEL_ID, {
        userId: TARGET_USER_ID,
        durationSeconds: 90,
        reason: "test",
      }, fetcher)).resolves.toMatchObject({ outcome: "suppressed", reason: "channel_paused" });

      expect(pausedDuringTokenLookup).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it.each([
    { status: 400, message: "This user may not be banned.", reason: "protected_target" },
    { status: 400, message: "The user is already banned.", reason: "already_banned" },
    { status: 400, message: "The request is invalid.", reason: "invalid_request" },
    { status: 401, message: "Invalid OAuth token", reason: "token_invalid" },
    { status: 403, message: "The user is not a moderator", reason: "not_moderator" },
    { status: 409, message: "Concurrent moderation change", reason: "conflict" },
  ] as const)("maps Helix $status responses to $reason", async ({ status, message, reason }) => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      const { environment } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(responseFor(status, message));

      await expect(sendModerationBan(environment, CHANNEL_ID, {
        userId: TARGET_USER_ID,
        durationSeconds: null,
        reason: "manual test",
      }, fetcher)).resolves.toMatchObject({
        outcome: "rejected",
        reason,
        detail: { status, twitchMessage: message },
      });
    } finally {
      database.close();
    }
  });

  it("maps a cannot-be-timed-out response to protected_target", async () => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      const { environment } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(responseFor(400, "This user cannot be timed out."));

      await expect(sendModerationBan(environment, CHANNEL_ID, {
        userId: TARGET_USER_ID,
        durationSeconds: 90,
        reason: "test",
      }, fetcher)).resolves.toMatchObject({ outcome: "rejected", reason: "protected_target" });
    } finally {
      database.close();
    }
  });

  it("maps a may-not-be-put-in-a-timeout response to protected_target", async () => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      const { environment } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(responseFor(400, "This user may not be put in a timeout."));

      await expect(sendModerationBan(environment, CHANNEL_ID, {
        userId: TARGET_USER_ID,
        durationSeconds: 90,
        reason: "test",
      }, fetcher)).resolves.toMatchObject({ outcome: "rejected", reason: "protected_target" });
    } finally {
      database.close();
    }
  });

  it("sets the channel retry pause after Helix returns 429", async () => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      const { environment, channelObject } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(responseFor(429, "slow down"));

      await expect(sendModerationBan(environment, CHANNEL_ID, {
        userId: TARGET_USER_ID,
        durationSeconds: null,
        reason: "test",
      }, fetcher)).resolves.toMatchObject({ outcome: "rejected", reason: "rate_limited" });
      expect(channelObject.setTwitchRateLimitRetryAfter).toHaveBeenCalledWith(expect.any(Number));
    } finally {
      database.close();
    }
  });

  it.each([
    { name: "timeout", error: Object.assign(new Error("request timed out"), { name: "TimeoutError" }) },
    { name: "network failure", error: new TypeError("network unavailable") },
  ])("reports an ambiguous outcome after one $name attempt", async ({ error }) => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      const { environment } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);

      await expect(sendModerationBan(environment, CHANNEL_ID, {
        userId: TARGET_USER_ID,
        durationSeconds: 90,
        reason: "test",
      }, fetcher)).resolves.toMatchObject({ outcome: "ambiguous", reason: error.name === "TimeoutError" ? "timeout" : "network_error" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it.each([CHANNEL_ID, BOT_USER_ID])("rejects protected target %s without calling Helix", async (userId) => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      const { environment } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>();

      await expect(sendModerationBan(environment, CHANNEL_ID, {
        userId,
        durationSeconds: null,
        reason: "test",
      }, fetcher)).resolves.toMatchObject({ outcome: "rejected", reason: "protected_target" });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("rejects a missing moderator status without calling Helix", async () => {
    const database = new TestD1Database();
    try {
      await seedChannel(database, false);
      const { environment } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>();

      await expect(sendModerationBan(environment, CHANNEL_ID, {
        userId: TARGET_USER_ID,
        durationSeconds: null,
        reason: "test",
      }, fetcher)).resolves.toMatchObject({ outcome: "rejected", reason: "not_moderator" });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("rejects a channel in the Twitch retry pause without calling Helix", async () => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      const { environment } = environmentFor(database, Date.now() + 60_000);
      const fetcher = vi.fn<typeof fetch>();

      await expect(sendModerationBan(environment, CHANNEL_ID, {
        userId: TARGET_USER_ID,
        durationSeconds: null,
        reason: "test",
      }, fetcher)).resolves.toMatchObject({ outcome: "rejected", reason: "rate_limited" });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it.each([0, MODERATION_TIMEOUT_MAX_SECONDS + 1])("rejects timeout duration %s before calling Helix", async (durationSeconds) => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      const { environment } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>();

      await expect(sendModerationBan(environment, CHANNEL_ID, {
        userId: TARGET_USER_ID,
        durationSeconds,
        reason: "test",
      }, fetcher)).resolves.toMatchObject({ outcome: "rejected", reason: "invalid_request" });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("lifts the matching active Votekick timeout with DELETE", async () => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      await seedBroadcasterIdentity(database);
      const { environment } = environmentFor(database);
      const startedAt = new Date(Date.now() - 5_000).toISOString();
      const expiresAt = new Date(Date.parse(startedAt) + 120_000).toISOString();
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{
          user_id: TARGET_USER_ID,
          moderator_id: BOT_USER_ID,
          reason: "Votekick (3:0) · ballot-1",
          created_at: startedAt,
          expires_at: expiresAt,
        }] }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(responseFor(403, "Moderator privileges required"));

      await expect(liftModerationBan(environment, CHANNEL_ID, TARGET_USER_ID, {
        reason: "Votekick (3:0) · ballot-1", durationSeconds: 120, startedAt,
      }, fetcher))
        .resolves.toMatchObject({ outcome: "rejected", reason: "not_moderator" });
      expect(fetcher).toHaveBeenCalledTimes(2);
      const [readInput, readInit] = fetcher.mock.calls[0] ?? [];
      const readUrl = new URL(typeof readInput === "string" ? readInput : readInput instanceof URL ? readInput.href : readInput?.url ?? "");
      expect(readUrl.origin + readUrl.pathname).toBe("https://api.twitch.tv/helix/moderation/banned");
      expect(readUrl.searchParams.get("broadcaster_id")).toBe(CHANNEL_ID);
      expect(readUrl.searchParams.get("user_id")).toBe(TARGET_USER_ID);
      expect(readInit?.headers).toMatchObject({ Authorization: "Bearer fictional-broadcaster-token" });
      const [deleteInput, deleteInit] = fetcher.mock.calls[1] ?? [];
      const deleteUrl = new URL(typeof deleteInput === "string" ? deleteInput : deleteInput instanceof URL ? deleteInput.href : deleteInput?.url ?? "");
      expect(deleteUrl.searchParams.get("broadcaster_id")).toBe(CHANNEL_ID);
      expect(deleteUrl.searchParams.get("moderator_id")).toBe(BOT_USER_ID);
      expect(deleteUrl.searchParams.get("user_id")).toBe(TARGET_USER_ID);
      expect(deleteInit?.method).toBe("DELETE");
      expect(deleteInit?.body).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it.each([
    ["timeout not applied", null],
    ["natural expiry", "expired"],
    ["replacement by a different moderator", "different_moderator"],
    ["replacement by a different sanction", "different_reason"],
  ] as const)("does not lift after %s", async (_caseName, variant) => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      await seedBroadcasterIdentity(database);
      const { environment } = environmentFor(database);
      const startedAt = new Date(Date.now() - 5_000).toISOString();
      const currentBan = variant === null ? [] : [{
        user_id: TARGET_USER_ID,
        moderator_id: variant === "different_moderator" ? "4000004" : BOT_USER_ID,
        reason: variant === "different_reason" ? "Different sanction" : "Votekick (3:0) · ballot-1",
        created_at: startedAt,
        expires_at: variant === "expired"
          ? new Date(Date.now() - 1_000).toISOString()
          : new Date(Date.parse(startedAt) + 120_000).toISOString(),
      }];
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: currentBan }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

      await expect(liftModerationBan(environment, CHANNEL_ID, TARGET_USER_ID, {
        reason: "Votekick (3:0) · ballot-1", durationSeconds: 120, startedAt,
      }, fetcher)).resolves.toMatchObject({ outcome: "rejected", reason: "conflict" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("fails closed on a malformed current-ban response", async () => {
    const database = new TestD1Database();
    try {
      await seedChannel(database);
      await seedBroadcasterIdentity(database);
      const { environment } = environmentFor(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [null] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

      await expect(liftModerationBan(environment, CHANNEL_ID, TARGET_USER_ID, {
        reason: "Votekick (3:0) · ballot-1",
        durationSeconds: 120,
        startedAt: new Date(Date.now() - 5_000).toISOString(),
      }, fetcher)).resolves.toMatchObject({ outcome: "rejected", reason: "twitch_error" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });
});

describe("timeout duration helpers", () => {
  it("validates inclusive timeout ranges and an optional lower maximum", () => {
    expect(timeoutDurationRangeSchema().safeParse({ minSeconds: 1, maxSeconds: 1 }).success).toBe(true);
    expect(timeoutDurationRangeSchema().safeParse({ minSeconds: 1, maxSeconds: 1_209_600 }).success).toBe(true);
    expect(timeoutDurationRangeSchema(3600).safeParse({ minSeconds: 30, maxSeconds: 3600 }).success).toBe(true);
    expect(timeoutDurationRangeSchema().safeParse({ minSeconds: 0, maxSeconds: 10 }).success).toBe(false);
    expect(timeoutDurationRangeSchema().safeParse({ minSeconds: 11, maxSeconds: 10 }).success).toBe(false);
    expect(timeoutDurationRangeSchema().safeParse({ minSeconds: 1, maxSeconds: 1_209_601 }).success).toBe(false);
    expect(timeoutDurationRangeSchema(3600).safeParse({ minSeconds: 1, maxSeconds: 3601 }).success).toBe(false);
  });

  it("rolls an inclusive range through an exclusive random upper bound and leaves fixed ranges alone", () => {
    const random = vi.fn((maximumExclusive: number) => maximumExclusive - 1);
    expect(rollTimeoutSeconds({ minSeconds: 10, maxSeconds: 12 }, random)).toBe(12);
    expect(random).toHaveBeenCalledWith(3);
    const unusedRandom = vi.fn(() => 0);
    expect(rollTimeoutSeconds({ minSeconds: 42, maxSeconds: 42 }, unusedRandom)).toBe(42);
    expect(unusedRandom).not.toHaveBeenCalled();
  });

  it("formats durations in the channel language", () => {
    expect(formatTimeoutDuration(150, "de")).toBe("2 Min. 30 s");
    expect(formatTimeoutDuration(150, "en")).toBe("2 min 30 s");
    expect(formatTimeoutDuration(86_400, "en")).toBe("1 d");
  });
});
