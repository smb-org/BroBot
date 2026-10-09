import { afterEach, describe, expect, it, vi } from "vitest";

import type { BallotCastResult, BallotFinalizeRule, BallotOpenResult } from "../../src/modules/contract";
import { votekickModule } from "../../src/modules/votekick";
import {
  closeStoredBallot,
  finalizeStoredBallot,
  forgetClosedStoredBallot,
  openStoredBallot,
  readStoredBallot,
  castStoredBallot,
} from "../../src/worker/durable/ballots";
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

type TestBallotTransaction = {
  get: <Value>(key: string) => Promise<Value | undefined>;
  list: (options?: { prefix?: string; startAfter?: string; limit?: number }) => Promise<Map<string, unknown>>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string | string[]) => Promise<boolean | number>;
  setAlarm: (scheduledTime: number | Date) => Promise<void>;
  deleteAlarm: () => Promise<void>;
};
type TestBallotStorage = Parameters<typeof openStoredBallot>[0];
type DispatchBallotObject = {
  openBallot: ReturnType<typeof vi.fn<(
    moduleId: string, ballotId: string, optionCount: number, expiresAt: number, passRule?: BallotFinalizeRule,
  ) => Promise<BallotOpenResult>>>;
  castBallot: ReturnType<typeof vi.fn<(
    moduleId: string, ballotId: string, userId: string, choice: number,
  ) => Promise<BallotCastResult>>>;
};

const memoryBallotStorage = (): TestBallotStorage => {
  const values = new Map<string, unknown>();
  const get = (key: string): Promise<unknown> => Promise.resolve(values.get(key));
  const list = (options: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, unknown>> => {
    let keys = [...values.keys()]
      .filter((key) => options.prefix === undefined || key.startsWith(options.prefix))
      .filter((key) => options.startAfter === undefined || key > options.startAfter)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (options.limit !== undefined) keys = keys.slice(0, options.limit);
    return Promise.resolve(new Map(keys.map((key) => [key, values.get(key)])));
  };
  const put = (key: string, value: unknown): Promise<void> => {
    values.set(key, value);
    return Promise.resolve();
  };
  const remove = (keys: string | string[]): Promise<boolean> => {
    let deleted = false;
    for (const key of Array.isArray(keys) ? keys : [keys]) deleted = values.delete(key) || deleted;
    return Promise.resolve(deleted);
  };
  const transaction: TestBallotTransaction = {
    get: async <Value>(key: string) => await get(key) as Value | undefined,
    list: async (options) => await list(options),
    put: async (key, value) => { await put(key, value); },
    delete: async (keys) => await remove(keys),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
  };
  return {
    get,
    list,
    put,
    delete: remove,
    transaction: <Value>(closure: (transaction: TestBallotTransaction) => Promise<Value>) => closure(transaction),
  } as unknown as TestBallotStorage;
};

const deferred = <Value = void>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const setup = async (
  control: "none" | "mute" | "pause" = "none",
  pauseOnClose = false,
  disableModuleOnPass = false,
  useStoredBallots = false,
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
  let passRule: { passIf: { yes: number; no: number; netAtLeast: number } } | undefined;
  const storage = memoryBallotStorage();
  const ballotObject = (useStoredBallots ? {
    openBallot: vi.fn(async (
      moduleId: string,
      ballotId: string,
      optionCount: number,
      expiresAt: number,
      rule?: { passIf: { yes: number; no: number; netAtLeast: number } },
    ) => {
      const result = await openStoredBallot(storage, moduleId, ballotId, optionCount, expiresAt, rule);
      return result.status === "opened" ? result : { status: "busy" as const, moduleId: result.moduleId };
    }),
    castBallot: vi.fn((moduleId: string, ballotId: string, userId: string, choice: number) =>
      castStoredBallot(storage, "channel-a", moduleId, ballotId, userId, choice)),
    readBallot: vi.fn((moduleId: string, ballotId: string) => readStoredBallot(storage, moduleId, ballotId)),
    closeBallot: vi.fn((moduleId: string, ballotId: string) => closeStoredBallot(storage, moduleId, ballotId)),
    finalizeBallot: vi.fn((moduleId: string, ballotId: string) => finalizeStoredBallot(storage, moduleId, ballotId)),
    acknowledgeClosedBallot: vi.fn((moduleId: string, ballotId: string) => forgetClosedStoredBallot(storage, moduleId, ballotId)),
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
  } : {
    openBallot: vi.fn((_moduleId: string, _ballotId: string, _optionCount: number, expiresAt: number,
      rule?: { passIf: { yes: number; no: number; netAtLeast: number } }) => {
      if (ballotOpen) return Promise.resolve({ status: "busy" as const, moduleId: "votekick" });
      ballotOpen = true;
      ballotOutcome = null;
      ballotExpiresAt = expiresAt;
      passRule = rule === undefined ? undefined : { passIf: { ...rule.passIf } };
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
    finalizeBallot: vi.fn(async () => {
      if (ballotOutcome !== null) return { outcome: ballotOutcome, counts: [...counts], revision };
      if (!ballotOpen) return { outcome: "not_open" as const, counts: [], revision: 0 };
      if (passRule !== undefined && (counts[passRule.passIf.yes] ?? 0) - (counts[passRule.passIf.no] ?? 0) >= passRule.passIf.netAtLeast) {
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
  }) as unknown as DispatchBallotObject;
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
  return { database, runtime, fetcher, ballotObject, storage };
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
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

describe("Votekick dispatch integration", () => {
  it("passes a committed final vote reclaimed after expiry and dispatches one timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T10:00:00.000Z"));
    const { database, runtime, fetcher, ballotObject, storage } = await setup("none", false, false, true);
    await database.prepare(
      "INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason) VALUES ('channel-a', 1, ?, NULL)",
    ).bind(new Date().toISOString()).run();
    await chat(runtime, fetcher, "!votekick sampleviewer", "starter-a", ["vip"]);
    await chat(runtime, fetcher, "1", "voter-a");

    const running = await database.prepare(
      "SELECT votekick_id, expires_at FROM votekicks WHERE channel_id = 'channel-a' AND status = 'running'",
    ).first<{ votekick_id: string; expires_at: string }>();
    expect(running).not.toBeNull();
    if (running === null) throw new Error("Expected a running votekick row.");
    const ballotId = running.votekick_id;
    const expiresAt = Date.parse(running.expires_at);
    expect(Date.now()).toBeLessThan(expiresAt);

    const committed = deferred();
    const responseGate = deferred();
    const castImplementation = ballotObject.castBallot.getMockImplementation();
    if (castImplementation === undefined) throw new Error("Expected a cast ballot implementation.");
    ballotObject.castBallot.mockImplementationOnce(async (moduleId, id, userId, choice) => {
      const result = await castImplementation(moduleId, id, userId, choice);
      committed.resolve();
      await responseGate.promise;
      return result;
    });
    const delayedVote = chat(runtime, fetcher, "1", "voter-b");

    try {
      await committed.promise;
      const beforeReclamation = await storage.get<{
        counts: number[]; revision: number; finalization?: unknown;
      }>(`ballot:votekick:${ballotId}`);
      expect(beforeReclamation).toMatchObject({ counts: [3, 0], revision: 3 });
      expect(beforeReclamation?.finalization).toBeUndefined();
      await expect(storage.get("ballot:active")).resolves.toEqual({ moduleId: "votekick", ballotId });
      vi.setSystemTime(expiresAt + 1);

      await expect(ballotObject.openBallot(
        "chat_voting", "poll-after-expiry", 2, Date.now() + 60_000,
      )).resolves.toEqual({ status: "opened" });
      await expect(readStoredBallot(storage, "votekick", ballotId)).resolves.toMatchObject({
        counts: [3, 0], revision: 3, outcome: "passed",
      });
    } finally {
      responseGate.resolve();
      await delayedVote;
    }

    await expect(database.prepare(
      "SELECT status, yes_votes, no_votes FROM votekicks WHERE channel_id = 'channel-a' AND votekick_id = ?",
    ).bind(ballotId).first()).resolves.toEqual({ status: "passed", yes_votes: 3, no_votes: 0 });
    expect(fetcher.mock.calls.filter(([input]) => requestUrl(input).includes("/helix/moderation/bans"))).toHaveLength(1);
  });

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
