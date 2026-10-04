import { afterEach, describe, expect, it, vi } from "vitest";

import { votekickModule } from "../../src/modules/votekick";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

const keyRing = JSON.stringify({
  active: { id: "votekick-dispatch", key: Buffer.from(new Uint8Array(32).fill(8)).toString("base64url") },
  retired: [],
});
const databases: TestD1Database[] = [];

const setup = async (
  control: "none" | "mute" | "pause" = "none",
  pauseOnClose = false,
  disableModuleOnPass = false,
) => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, "channel-a");
  const now = new Date().toISOString();
  const encrypted = (value: string) => encryptJson({ token: value }, parseKeyRing(keyRing));
  await upsertBotIdentity(database as unknown as D1Database, {
    id: 1,
    userId: "bot-a",
    login: "brobot",
    scopesJson: "[]",
    accessTokenCiphertext: await encrypted("bot-token"),
    refreshTokenCiphertext: await encrypted("refresh-token"),
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: now,
    updatedAt: now,
  });
  await insertAppAccessToken(database, await encrypted("app-token"), "2099-01-01T00:00:00.000Z", now, now);
  await insertLoginIdentityAndSession(database, "channel-a", ["moderation:read"]);
  await database.prepare(
    "UPDATE twitch_login_identity SET access_token_ciphertext = ?, refresh_token_ciphertext = ? WHERE user_id = 'channel-a'",
  ).bind(await encrypted("broadcaster-token"), await encrypted("broadcaster-refresh")).run();
  await database.prepare(
    `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at, checked_at)
     VALUES ('channel-a', 'online', ?, 'eventsub', ?, ?)`,
  ).bind(now, now, now).run();
  const settings = {
    ...votekickModule.defaultSettings,
    minNetVotes: 3,
    percent: 5,
    duration: { minSeconds: 120, maxSeconds: 120 },
  };
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('channel-a', 'votekick', 1, ?)",
  ).bind(JSON.stringify(settings)).run();
  if (control !== "none") {
    await database.prepare(
      `INSERT INTO channel_controls (channel_id, muted, paused, updated_at)
       VALUES ('channel-a', ?, ?, ?)`,
    ).bind(control === "mute" ? 1 : 0, control === "pause" ? 1 : 0, now).run();
  }

  let counts = [0, 0];
  let revision = 0;
  let ballotOpen = false;
  let ballotOutcome: "passed" | "expired" | null = null;
  let ballotExpiresAt = 0;
  const ballotObject = {
    openBallot: vi.fn((_moduleId: string, _ballotId: string, _optionCount: number, expiresAt: number) => {
      if (ballotOpen) return Promise.resolve({ status: "busy" as const, moduleId: "votekick" });
      ballotOpen = true;
      ballotOutcome = null;
      ballotExpiresAt = expiresAt;
      counts = [0, 0];
      revision = 0;
      return Promise.resolve({ status: "opened" as const });
    }),
    castBallot: vi.fn((_moduleId: string, _ballotId: string, _userId: string, choice: number) => {
      if (!ballotOpen || ballotOutcome !== null) return Promise.resolve({ status: "not_open" as const, counts: [], revision: 0 });
      counts[choice - 1] = (counts[choice - 1] ?? 0) + 1;
      revision += 1;
      return Promise.resolve({ status: "counted" as const, counts: [...counts], revision });
    }),
    readBallot: vi.fn(() => Promise.resolve(ballotOpen ? { counts: [...counts], revision } : null)),
    closeBallot: vi.fn(async () => {
      if (!ballotOpen && ballotOutcome === null) return Promise.resolve(null);
      ballotOpen = false;
      ballotOutcome = null;
      return { counts: [...counts], revision };
    }),
    finalizeBallot: vi.fn(async (_moduleId: string, _ballotId: string, rule: { passIf: { yes: number; no: number; netAtLeast: number } } | null) => {
      if (ballotOutcome !== null) return { outcome: ballotOutcome, counts: [...counts], revision };
      if (!ballotOpen) return { outcome: "not_open" as const, counts: [], revision: 0 };
      if (rule !== null && (counts[rule.passIf.yes] ?? 0) - (counts[rule.passIf.no] ?? 0) >= rule.passIf.netAtLeast) {
        ballotOutcome = "passed";
      } else if (Date.now() >= ballotExpiresAt) {
        ballotOutcome = "expired";
      } else {
        return { outcome: "open" as const, counts: [...counts], revision };
      }
      ballotOpen = false;
      if (ballotOutcome === "passed" && pauseOnClose) {
        await database.prepare("INSERT INTO channel_controls (channel_id, paused, updated_at) VALUES ('channel-a', 1, ?)")
          .bind(new Date().toISOString()).run();
      }
      if (ballotOutcome === "passed" && disableModuleOnPass) {
        await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = 'channel-a' AND module_id = 'votekick'").run();
      }
      return { outcome: ballotOutcome, counts: [...counts], revision };
    }),
    acknowledgeClosedBallot: vi.fn(() => Promise.resolve()),
    scheduleModuleAlarm: vi.fn(() => Promise.resolve()),
    clearModuleAlarm: vi.fn(() => Promise.resolve()),
    getActiveChatterCount: vi.fn(() => Promise.resolve(20)),
    getActiveChatter: vi.fn(() => Promise.resolve({
      firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
      lastSeenAt: new Date(Date.now() - 1_000).toISOString(),
    })),
    recordChatActivity: vi.fn(() => Promise.resolve(0)),
    clearActiveChatters: vi.fn(() => Promise.resolve()),
    getChatActivityCount: vi.fn(() => Promise.resolve(0)),
    claimAutomatedChatOutput: vi.fn(() => Promise.resolve(true)),
    recordBotChatMessage: vi.fn(() => Promise.resolve()),
    isRecentBotChatMessage: vi.fn(() => Promise.resolve(false)),
    getTwitchRateLimitRetryAfter: vi.fn(() => Promise.resolve(null)),
    setTwitchRateLimitRetryAfter: vi.fn(() => Promise.resolve()),
    publish: vi.fn(() => Promise.resolve()),
  };
  const runtime = {
    DB: database as unknown as D1Database,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEYS: keyRing,
    CHANNEL: {
      idFromName: (channelId: string) => channelId,
      get: () => ballotObject,
    },
  } as unknown as Env;
  const fetcher = vi.fn<typeof fetch>((input) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const body = url.includes("/helix/users?")
      ? { data: [{ id: "target-id", login: "sampleviewer", display_name: "sampleviewer" }] }
      : { data: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  });
  return { database, runtime, fetcher, ballotObject };
};

const chat = async (runtime: Env, fetcher: typeof fetch, text: string, chatterId: string, badges: readonly string[] = []): Promise<void> => {
  await dispatchEventSubNotification(runtime, {
    channelId: "channel-a",
    subscriptionType: "channel.chat.message",
    triggerId: `trigger-${chatterId}-${text}`,
    receivedAt: new Date().toISOString(),
    eventSubTimestamp: new Date().toISOString(),
    payload: {
      message: { text },
      chatter_user_id: chatterId,
      chatter_user_login: chatterId,
      badges: badges.map((set_id) => ({ set_id })),
    },
  }, fetcher, [votekickModule]);
};

const log = async (database: TestD1Database): Promise<readonly { module_id: string; code: string; detail_json: string }[]> =>
  (await database.prepare("SELECT module_id, code, detail_json FROM event_log ORDER BY rowid")
    .all<{ module_id: string; code: string; detail_json: string }>()).results;

const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : input;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Votekick dispatch integration", () => {
  it("does not start a ballot while the channel is paused", async () => {
    const { database, runtime, fetcher, ballotObject } = await setup("pause");
    await chat(runtime, fetcher, "!votekick sampleviewer", "starter-a", ["vip"]);

    expect(ballotObject.openBallot).not.toHaveBeenCalled();
    await expect(database.prepare("SELECT COUNT(*) AS count FROM votekicks WHERE channel_id = 'channel-a'")
      .first<{ count: number }>()).resolves.toEqual({ count: 0 });
  });

  it("runs while muted but suppresses a passed Votekick timeout", async () => {
    const { database, runtime, fetcher } = await setup("mute");
    await chat(runtime, fetcher, "!votekick sampleviewer", "starter-a", ["vip"]);
    await chat(runtime, fetcher, "1", "voter-a");
    await chat(runtime, fetcher, "1", "voter-b");

    await expect(database.prepare("SELECT status, yes_votes FROM votekicks WHERE channel_id = 'channel-a'")
      .first()).resolves.toEqual({ status: "passed", yes_votes: 3 });
    expect(fetcher.mock.calls.some(([input]) => requestUrl(input).includes("/helix/moderation/bans"))).toBe(false);
    expect(await log(database)).toContainEqual(expect.objectContaining({
      module_id: "votekick",
      code: "host.action.suppressed",
      detail_json: '{"action":"timeout","reason":"channel_muted"}',
    }));
  });

  it("rechecks pause after a ballot passes and suppresses the timeout action", async () => {
    const { database, runtime, fetcher } = await setup("none", true);
    await chat(runtime, fetcher, "!votekick sampleviewer", "starter-a", ["vip"]);
    await chat(runtime, fetcher, "1", "voter-a");
    await chat(runtime, fetcher, "1", "voter-b");

    await expect(database.prepare("SELECT status, yes_votes FROM votekicks WHERE channel_id = 'channel-a'")
      .first()).resolves.toEqual({ status: "passed", yes_votes: 3 });
    expect(fetcher.mock.calls.some(([input]) => requestUrl(input).includes("/helix/moderation/bans"))).toBe(false);
    expect(await log(database)).toContainEqual(expect.objectContaining({
      module_id: "votekick",
      code: "host.action.suppressed",
      detail_json: '{"action":"timeout","reason":"channel_paused"}',
    }));
  });

  it("rechecks module activation after a pass is prepared and suppresses its timeout", async () => {
    const { database, runtime, fetcher } = await setup("none", false, true);
    await chat(runtime, fetcher, "!votekick sampleviewer", "starter-a", ["vip"]);
    await chat(runtime, fetcher, "1", "voter-a");
    await chat(runtime, fetcher, "1", "voter-b");

    await expect(database.prepare("SELECT status FROM votekicks WHERE channel_id = 'channel-a'")
      .first()).resolves.toEqual({ status: "passed" });
    expect(fetcher.mock.calls.some(([input]) => requestUrl(input).includes("/helix/moderation/bans"))).toBe(false);
    expect(await log(database)).toContainEqual(expect.objectContaining({
      module_id: "votekick",
      code: "host.action.suppressed",
      detail_json: '{"action":"timeout","reason":"module_disabled"}',
    }));
  });
});
