import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext, ModulePointsAccess } from "../../src/modules/contract";
import { duelSettingsForLanguage, type DuelSettings } from "../../src/modules/duel/contracts";
import { processDuelMessage } from "../../src/modules/duel/service";
import { modulePoints } from "../../src/worker/module-points";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { fetchTwitchUserByLogin } from "../../src/worker/shoutout";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { pointsDefaultSettingsForLanguage } from "../../src/modules/points/contracts";
import {
  clearPointObjectAlarms,
  forcePointAlarm,
  insertPointChannel,
  pointObject,
  runMigrations,
  runPointObject,
  type PointsWorkerObject,
} from "./points-test-helpers";

const testDuelTokenEncryptionKeys = JSON.stringify({
  active: { id: "duel-test-token-encryption", key: Buffer.from(new Uint8Array(32).fill(19)).toString("base64url") },
  retired: [],
});
const testDuelSessionCookieKeys = JSON.stringify({
  active: { id: "duel-test-cookie-signing", key: Buffer.from(new Uint8Array(32).fill(23)).toString("base64url") },
  retired: [],
});

const testEnvironment = env as unknown as Env;
const duelSettings = (): DuelSettings => ({ ...duelSettingsForLanguage("en"), cooldownSeconds: 0 });

const insertDuelModule = async (channelId: string, settings = duelSettings()): Promise<void> => {
  await testEnvironment.DB.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'duel', 1, ?, 1)",
  ).bind(channelId, JSON.stringify(settings)).run();
};

const contextFor = (
  points: ModulePointsAccess,
  extras: Partial<ModuleExecutionContext> = {},
): ModuleExecutionContext => ({
  points,
  botUserId: () => Promise.resolve("fictional_brobot"),
  channelLanguage: () => Promise.resolve("en"),
  ...extras,
} as unknown as ModuleExecutionContext);

const eventFor = (
  channelId: string,
  text: string,
  userId: string,
  login: string,
  messageId: string,
  settings = duelSettings(),
): ModuleEvent<DuelSettings> => ({
  channelId,
  subscriptionType: "channel.chat.message",
  triggerId: messageId,
  receivedAt: new Date().toISOString(),
  actor: null,
  chatStatus: ["viewer"],
  settings,
  payload: {
    message_id: messageId,
    chatter_user_id: userId,
    chatter_user_login: login,
    message: { text },
  },
});

const setup = async (channelId: string): Promise<{ object: PointsWorkerObject; points: ModulePointsAccess }> => {
  await insertPointChannel(channelId);
  await insertDuelModule(channelId);
  const object = pointObject(channelId);
  const points = modulePoints((testEnvironment as unknown as { CHANNEL: Env["CHANNEL"] }).CHANNEL, channelId, "duel");
  return { object, points };
};

const addBalance = async (points: ModulePointsAccess, accountId: string, login: string, balance = 500): Promise<void> => {
  await points.touchAccount(accountId, login, balance);
};

const stubAlarmChat = async (object: PointsWorkerObject) => {
  const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(() => Promise.resolve({
    sent: true, retryable: false, reason: null, delivery: "delivered",
  }));
  await runPointObject(object, async (target) => {
    await target.getPanelResourceRevisions();
    const runtime = target as unknown as { moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext };
    const original = runtime.moduleAlarmContext.bind(runtime);
    vi.spyOn(runtime, "moduleAlarmContext").mockImplementation((...args) => ({ ...original(...args), sendChat }));
  });
  return sendChat;
};

const expireRound = async (object: PointsWorkerObject, roundId: string): Promise<void> => {
  await forcePointAlarm(object, roundId, (_target, state) => {
    state.storage.sql.exec("UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?", Date.now() - 1, roundId);
  });
};

beforeAll(runMigrations);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2100, 0, 1));
});
afterEach(async () => {
  try {
    await clearPointObjectAlarms();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("duel module worker flow", () => {
  it("escrows, accepts, settles and sends one line per round phase [protects=an open challenge charges the challenger and one accept creates one result; fails_when=money moves twice or more than announcement plus result is delivered; no_claim=uses the real ChannelObject and ledger with the alarm chat transport mocked]", async () => {
    const channelId = `duel-flow-${crypto.randomUUID()}`;
    const { object, points } = await setup(channelId);
    const sendChat = await stubAlarmChat(object);
    await addBalance(points, "viewer_anna", "frostfern");
    await addBalance(points, "viewer_ben", "moonmoss");

    await processDuelMessage(eventFor(channelId, "!duel @moonmoss 100", "viewer_anna", "frostfern", "fictional-challenge"), contextFor(points, {
      lookupUserByLoginWithBotToken: () => Promise.resolve({ userId: "viewer_ben", login: "moonmoss", displayName: "Moonmoss" }),
    }));
    const challenged = await points.rounds.listOpen();
    expect(challenged).toHaveLength(1);
    const challenge = challenged[0];
    if (challenge === undefined) throw new Error("challenge_not_open");
    expect(challenge).toMatchObject({ state: "announcing", data: { challengerId: "viewer_anna", targetId: "viewer_ben", stake: 100 } });
    await expect(points.balance("viewer_anna")).resolves.toBe(400);
    await forcePointAlarm(object, challenge.roundId);
    expect(sendChat).toHaveBeenCalledOnce();
    expect(sendChat.mock.calls[0]?.[0]).toContain("challenges @moonmoss to a 100 point duel");
    expect(sendChat.mock.calls[0]?.[5]).toMatchObject({ replyToMessageId: "fictional-challenge", automated: false });

    await processDuelMessage(eventFor(channelId, "!yes", "viewer_ben", "moonmoss", "fictional-accept"), contextFor(points));
    await forcePointAlarm(object, challenge.roundId);
    const state = await runPointObject(object, (_target, durableState) => ({
      round: durableState.storage.sql.exec<{ state: string }>("SELECT state FROM game_rounds WHERE round_id = ?", challenge.roundId).one().state,
      resolveCount: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${challenge.roundId}:resolve`).one().count,
      locks: durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM game_round_locks WHERE round_id = ?", challenge.roundId).one().count,
    }));
    expect(state).toEqual({ round: "resolved", resolveCount: 1, locks: 0 });
    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(sendChat.mock.calls[1]?.[0]).toContain("wins +100 points;");
    expect(sendChat.mock.calls[1]?.[0]).toContain("loses −100 points");
    expect(sendChat.mock.calls[1]?.[5]).toMatchObject({ replyToMessageId: "fictional-accept", automated: false });
  });

  it.each(["", "Saved {challenger} challenge template"])("opens a silent challenge when its saved announcement is disabled, even when the template is %j [protects=a disabled duel announcement still opens its escrowed round and deadline without exposing raw template text; fails_when=the round is rejected or any chat delivery is attempted; no_claim=uses the real ChannelObject point-round alarm and stubs only the transport]", async (challengeText) => {
    const channelId = `duel-silent-announcement-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const settings = duelSettings();
    settings.texts.challengeOpen = challengeText;
    settings.texts.challengeOpenEnabled = false;
    await insertDuelModule(channelId, settings);
    const object = pointObject(channelId);
    const points = modulePoints((testEnvironment as unknown as { CHANNEL: Env["CHANNEL"] }).CHANNEL, channelId, "duel");
    const sendChat = await stubAlarmChat(object);
    await addBalance(points, "viewer_anna", "frostfern");

    await processDuelMessage(eventFor(channelId, "!duel 100", "viewer_anna", "frostfern", "fictional-silent-challenge", settings), contextFor(points));
    const opening = (await points.rounds.listOpen())[0];
    expect(opening).toMatchObject({ state: "announcing", data: { silentAnnouncement: true } });
    if (opening === undefined) throw new Error("challenge_not_open");
    await forcePointAlarm(object, opening.roundId);

    const activated = (await points.rounds.listOpen())[0];
    expect(activated?.state).toBe("open");
    expect(typeof activated?.deadlineAt).toBe("number");
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("keeps a house result pending through repeated limiter rejections until delivery", async () => {
    const channelId = `duel-house-result-limiter-${crypto.randomUUID()}`;
    const { object, points } = await setup(channelId);
    await addBalance(points, "viewer_anna", "frostfern");
    let resultAttempts = 0;
    const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>()
      .mockImplementation((_text, _key, _attributions, _valid, _target, options) => {
        if (options?.automated !== false && resultAttempts < 7) {
          resultAttempts += 1;
          return Promise.resolve({ sent: false, retryable: true, reason: "rate_limited", delivery: "rate_limited" });
        }
        if (options?.automated !== false) resultAttempts += 1;
        return Promise.resolve({ sent: true, retryable: false, reason: null, delivery: "delivered" });
      });
    await runPointObject(object, (target) => {
      const runtime = target as unknown as { moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext };
      const original = runtime.moduleAlarmContext.bind(target);
      vi.spyOn(runtime, "moduleAlarmContext").mockImplementation((...args) => ({ ...original(...args), sendChat }));
    });

    await processDuelMessage(eventFor(channelId, "!duel 100", "viewer_anna", "frostfern", "fictional-house-limiter"), contextFor(points));
    const round = (await points.rounds.listOpen())[0];
    if (round === undefined) throw new Error("challenge_not_open");
    await forcePointAlarm(object, round.roundId);
    await expireRound(object, round.roundId);

    for (let attempt = 1; attempt < 8; attempt += 1) {
      await forcePointAlarm(object, round.roundId);
    }

    const state = await runPointObject(object, (_target, durableState) => ({
      round: durableState.storage.sql.exec<{ state: string; resolve_delivery_state: string; resolve_delivery_attempts: number }>(
        "SELECT state, resolve_delivery_state, resolve_delivery_attempts FROM game_rounds WHERE round_id = ?", round.roundId,
      ).one(),
      resolutionCount: durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", `round:${round.roundId}:resolve`,
      ).one().count,
    }));

    expect(state.round.state).toBe("resolved");
    expect(state.round.resolve_delivery_state).toBe("delivered");
    expect(state.round.resolve_delivery_attempts).toBe(1);
    expect(state.resolutionCount).toBe(1);
    expect(resultAttempts).toBe(8);
    expect(sendChat).toHaveBeenCalledTimes(9);
    expect(sendChat.mock.calls.at(-1)?.[5]).not.toHaveProperty("automated", false);
  });

  it("refunds an expired targeted challenge without a result line [protects=targeted expiry restores the exact challenger balance silently; fails_when=the targeted expiry creates a result line or leaves escrow funded; no_claim=the challenge line is the only chat send and alarm transport is mocked]", async () => {
    const channelId = `duel-target-expire-${crypto.randomUUID()}`;
    const { object, points } = await setup(channelId);
    const sendChat = await stubAlarmChat(object);
    await addBalance(points, "viewer_anna", "frostfern");
    await addBalance(points, "viewer_ben", "moonmoss");
    await processDuelMessage(eventFor(channelId, "!duel @moonmoss 100", "viewer_anna", "frostfern", "fictional-targeted-expiry"), contextFor(points, {
      lookupUserByLoginWithBotToken: () => Promise.resolve({ userId: "viewer_ben", login: "moonmoss", displayName: "Moonmoss" }),
    }));
    const round = (await points.rounds.listOpen())[0];
    if (round === undefined) throw new Error("challenge_not_open");
    await forcePointAlarm(object, round.roundId);
    await expireRound(object, round.roundId);
    await expect(points.balance("viewer_anna")).resolves.toBe(500);
    expect(sendChat).toHaveBeenCalledOnce();
  });

  it("settles an open expiry against the house with a zero-sum channel [protects=the snapshotted bot path balances human net against house net; fails_when=house plus humans do not sum to zero or the house is ranked; no_claim=the 50/50 draw is covered by the settlement unit test and chat transport is mocked]", async () => {
    const channelId = `duel-house-${crypto.randomUUID()}`;
    const { object, points } = await setup(channelId);
    const sendChat = await stubAlarmChat(object);
    await addBalance(points, "viewer_anna", "frostfern");
    const openingHouseBalance = await points.balance("__house");
    const openingHumanBalance = await points.balance("viewer_anna");
    await processDuelMessage(eventFor(channelId, "!duel 100", "viewer_anna", "frostfern", "fictional-house-duel"), contextFor(points));
    const round = (await points.rounds.listOpen())[0];
    if (round === undefined) throw new Error("challenge_not_open");
    await forcePointAlarm(object, round.roundId);
    await expireRound(object, round.roundId);

    const house = await points.balance("__house");
    const human = await points.balance("viewer_anna");
    const monthly = await points.ranking(new Date().toISOString().slice(0, 7), 100);
    const total = await runPointObject(object, (_target, durableState) => durableState.storage.sql.exec<{ total: number }>(
      "SELECT COALESCE(SUM(balance), 0) AS total FROM point_accounts",
    ).one().total);
    expect(house - openingHouseBalance).toBe(-(human - openingHumanBalance));
    expect(total).toBe(0);
    expect(monthly.some(({ accountId }) => accountId === "__house")).toBe(false);
    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(sendChat.mock.calls[1]?.[0]).toContain("BroBot");
    expect(sendChat.mock.calls[1]?.[0]).toContain("wins +100 points;");
    expect(sendChat.mock.calls[1]?.[0]).toContain("loses −100 points");
  });

  it("refunds every open stake silently when duel is disabled [protects=module cancellation refunds each escrow, releases every challenger lock, and queues no chat notice; fails_when=any balance changes, lock survives, or cancellation notice is sent; no_claim=the settings PATCH route is outside this DO refund test]", async () => {
    const channelId = `duel-disable-${crypto.randomUUID()}`;
    const { object, points } = await setup(channelId);
    await addBalance(points, "viewer_anna", "frostfern");
    await addBalance(points, "viewer_ben", "moonmoss");
    await processDuelMessage(eventFor(channelId, "!duel 100", "viewer_anna", "frostfern", "fictional-disable-a"), contextFor(points));
    await processDuelMessage(eventFor(channelId, "!duel 100", "viewer_ben", "moonmoss", "fictional-disable-b"), contextFor(points));
    await points.rounds.setGate(true, 2, 1);
    await expect(points.rounds.cancelOpenRounds(2)).resolves.toBe(2);
    await expect(points.balance("viewer_anna")).resolves.toBe(500);
    await expect(points.balance("viewer_ben")).resolves.toBe(500);
    const locks = await runPointObject(pointObject(channelId), (_target, durableState) => durableState.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_round_locks WHERE module_id = 'duel'",
    ).one().count);
    expect(locks).toBe(0);
    const notices = await runPointObject(object, (_target, durableState) => durableState.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_round_cancellation_notices WHERE module_id = 'duel'",
    ).one().count);
    expect(notices).toBe(0);
  });

  it("keeps Blitz cancellation refund notices enabled [protects=funded Blitz round cancellation still refunds and sends its cancellation notice; fails_when=the refund or the existing cancellation notice is lost; no_claim=the Durable Object chat sender is stubbed with fixed point-worker keys]", async () => {
    const channelId = `blitz-cancel-notice-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await testEnvironment.DB.prepare("UPDATE channels SET language = 'en' WHERE channel_id = ?").bind(channelId).run();
    await testEnvironment.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'blitz_round', 1, ?, 1)",
    ).bind(channelId, JSON.stringify({ prize: 50, answerTimeSeconds: 60, chatTarget: null, startText: "Open", solvedText: "Solved", timeoutText: "Timeout" })).run();
    const object = pointObject(channelId);
    await object.touchPointAccount("blitz_round", "viewer_anna", "frostfern", 500);
    await expect(object.pointBalance("blitz_round", "viewer_anna")).resolves.toBe(500);
    await object.openGameRoundWithStake("blitz_round", "blitz-funded-cancel", {
      durationS: 60,
      announceText: "Open",
      answer: "CLOUD",
      settlement: { kind: "blitz", params: { prize: 50 } },
    }, "msg:blitz-funded-cancel", "viewer_anna", "frostfern", 100);
    await expect(object.pointBalance("blitz_round", "viewer_anna")).resolves.toBe(400);

    await object.setGameModuleGate("blitz_round", true, 2, 1);
    await expect(object.cancelOpenGameRounds("blitz_round", 2)).resolves.toBe(1);

    await expect(object.pointBalance("blitz_round", "viewer_anna")).resolves.toBe(500);
    const notices = await runPointObject(object, (_target, durableState) => durableState.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_round_cancellation_notices WHERE module_id = 'blitz_round' AND revision = 2",
    ).one().count);
    expect(notices).toBe(1);
  });

  it("keeps open-round locks isolated by channel [protects=one channel's challenger lock cannot block an identical account in another channel; fails_when=the second channel receives round_locked or sees the first round; no_claim=the test uses separate channel Durable Objects and a shared fake sender]", async () => {
    const firstChannel = `duel-isolation-a-${crypto.randomUUID()}`;
    const secondChannel = `duel-isolation-b-${crypto.randomUUID()}`;
    const first = await setup(firstChannel);
    const second = await setup(secondChannel);
    await addBalance(first.points, "viewer_anna", "frostfern");
    await addBalance(second.points, "viewer_anna", "frostfern");
    await processDuelMessage(eventFor(firstChannel, "!duel 100", "viewer_anna", "frostfern", "fictional-isolation-a"), contextFor(first.points));
    await processDuelMessage(eventFor(secondChannel, "!duel 100", "viewer_anna", "frostfern", "fictional-isolation-b"), contextFor(second.points));
    await expect(first.points.rounds.listOpen()).resolves.toHaveLength(1);
    await expect(second.points.rounds.listOpen()).resolves.toHaveLength(1);
  });

  it("uses fixed token and cookie key rings for the bot-token Twitch lookup [protects=@login resolves through the bot credential and fixed encryption key; fails_when=an app/default token is used or a CI key mismatch makes the lookup fail; no_claim=the session cookie ring is supplied for adapter parity but no authenticated router is exercised]", async () => {
    const channelId = `duel-bot-token-${crypto.randomUUID()}`;
    const { points } = await setup(channelId);
    await addBalance(points, "viewer_anna", "frostfern");
    const now = new Date().toISOString();
    const ciphertext = await encryptJson({ token: "fictional_bot_access_token" }, parseKeyRing(testDuelTokenEncryptionKeys));
    await upsertBotIdentity(testEnvironment.DB, {
      id: 1,
      userId: "fictional_brobot",
      login: "brobot",
      scopesJson: "[]",
      accessTokenCiphertext: ciphertext,
      refreshTokenCiphertext: "fictional_refresh_ciphertext",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: now,
      updatedAt: now,
    });
    const adapterEnvironment = {
      ...testEnvironment,
      TOKEN_ENCRYPTION_KEYS: testDuelTokenEncryptionKeys,
      SESSION_COOKIE_KEYS: testDuelSessionCookieKeys,
    } as Env;
    const twitchFetch = vi.fn<typeof fetch>((input, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fictional_bot_access_token");
      const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      expect(new URL(requestUrl).searchParams.get("login")).toBe("moonmoss");
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "viewer_ben", login: "moonmoss", display_name: "Moonmoss" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });
    const lookedUp = await fetchTwitchUserByLogin(twitchFetch, adapterEnvironment, "moonmoss", "bot");
    expect(lookedUp?.userId).toBe("viewer_ben");
    expect(twitchFetch).toHaveBeenCalledOnce();
  });

  it("rejects enabling duel when its stored command collides with an enabled module [protects=module activation checks configured duel commands against enabled module commands; fails_when=duel enables beside Points using the same !punkte command; no_claim=the authenticated panel router receives fixed cookie and token key rings, while settings-save collision is handled by the same guard]", async () => {
    const channelId = `duel-command-collision-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const pointSettings = pointsDefaultSettingsForLanguage("en");
    const conflictingDuelSettings = { ...duelSettingsForLanguage("en"), challengeCommand: "!punkte" };
    await testEnvironment.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, ?, 1)",
    ).bind(channelId, JSON.stringify(pointSettings)).run();
    await testEnvironment.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'duel', 0, ?, 1)",
    ).bind(channelId, JSON.stringify(conflictingDuelSettings)).run();

    const sessionId = `fictional_session_${crypto.randomUUID()}`;
    const userId = `fictional_manager_${crypto.randomUUID()}`;
    const login = `fictional_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    await testEnvironment.DB.prepare(
      `INSERT INTO twitch_login_identity (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
        expires_at, status, created_at, updated_at) VALUES (?, ?, '[]', 'fictional_access', 'fictional_refresh', ?, 'connected', ?, ?)`,
    ).bind(userId, login, "2100-01-02T00:00:00.000Z", now, now).run();
    await testEnvironment.DB.prepare(
      "INSERT INTO auth_sessions (session_id, user_id, login, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(sessionId, userId, login, "2100-01-02T00:00:00.000Z", now, now).run();
    await testEnvironment.DB.prepare(
      "INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'broadcaster', ?, ?)",
    ).bind(channelId, userId, now, now).run();
    const cookie = await createSessionCookie({ sessionId }, testDuelSessionCookieKeys, testDuelTokenEncryptionKeys);
    const csrf = await createCsrfToken(sessionId, testDuelSessionCookieKeys, now);
    const request = new Request(`https://brobot.example/api/channels/${channelId}/modules/duel`, {
      method: "PATCH",
      headers: {
        Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ enabled: true, expectedRevision: 1 }),
    });
    const routerEnvironment = {
      ...testEnvironment,
      SESSION_COOKIE_KEYS: testDuelSessionCookieKeys,
      TOKEN_ENCRYPTION_KEYS: testDuelTokenEncryptionKeys,
    } as Env;
    const response = await panelRouter.fetch(request, routerEnvironment);
    const body = await response.json<{ error?: string; command?: string }>();
    const stored = await testEnvironment.DB.prepare(
      "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'duel'",
    ).bind(channelId).first<{ enabled: number }>();

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: "module_command_collision", command: "!punkte" });
    expect(stored).toEqual({ enabled: 0 });
  });

  it("selects a speaker's targeted open duel before an older untargeted duel [protects=targeted invitations take precedence for their target; fails_when=!yes accepts the older public challenge; no_claim=round order and target eligibility are supplied as an in-memory points adapter fixture]", async () => {
    const points = {
      rounds: {
        listOpen: () => Promise.resolve([
          { roundId: "fictional-open-old", state: "open" as const, deadlineAt: Date.now() + 60_000, data: { challengerId: "viewer_anna", targetId: null } },
          { roundId: "fictional-targeted-new", state: "open" as const, deadlineAt: Date.now() + 60_000, data: { challengerId: "viewer_cara", targetId: "viewer_ben" } },
        ]),
        accept: vi.fn(() => Promise.resolve({ replayed: false, result: {}, balances: {} })),
      },
    } as unknown as ModulePointsAccess;
    await processDuelMessage(eventFor("fictional_channel", "!yes", "viewer_ben", "moonmoss", "fictional-targeted-accept"), contextFor(points));
    expect(points.rounds.accept).toHaveBeenCalledWith(
      "fictional-targeted-new", "msg:fictional-targeted-accept", "viewer_ben", "moonmoss", "fictional-targeted-accept",
    );
  });

  it("skips other viewers' targeted rounds and accepts the oldest eligible open duel [protects=targeted invitations for others are skipped while public challenges retain oldest-first selection; fails_when=the speaker steals another target's invitation or accepts a newer public round; no_claim=listOpen ordering comes from the worker fixture, not SQLite collation]", async () => {
    const points = {
      rounds: {
        listOpen: () => Promise.resolve([
          { roundId: "fictional-other-target", state: "open" as const, deadlineAt: Date.now() + 60_000, data: { challengerId: "viewer_anna", targetId: "viewer_cara" } },
          { roundId: "fictional-public-old", state: "open" as const, deadlineAt: Date.now() + 60_000, data: { challengerId: "viewer_anna", targetId: null } },
          { roundId: "fictional-public-new", state: "open" as const, deadlineAt: Date.now() + 60_000, data: { challengerId: "viewer_cara", targetId: null } },
        ]),
        accept: vi.fn(() => Promise.resolve({ replayed: false, result: {}, balances: {} })),
      },
    } as unknown as ModulePointsAccess;
    await processDuelMessage(eventFor("fictional_channel", "!yes", "viewer_ben", "moonmoss", "fictional-public-accept"), contextFor(points));
    expect(points.rounds.accept).toHaveBeenCalledWith(
      "fictional-public-old", "msg:fictional-public-accept", "viewer_ben", "moonmoss", "fictional-public-accept",
    );
  });

  it("throttles errors and claims challenge cooldown only after successful escrow [protects=failed challenges leave no challenge cooldown and a viewer gets at most one error reply per minute; fails_when=a failed stake consumes cooldown or a second throttled error emits; no_claim=the 60-second interval uses the real points Durable Object game_cooldowns table]", async () => {
    const channelId = `duel-cooldown-${crypto.randomUUID()}`;
    const { object, points } = await setup(channelId);
    await addBalance(points, "viewer_poor", "fablebird", 0);
    const first = await processDuelMessage(eventFor(channelId, "!duel 100", "viewer_poor", "fablebird", "fictional-poor-1"), contextFor(points));
    const second = await processDuelMessage(eventFor(channelId, "!duel 100", "viewer_poor", "fablebird", "fictional-poor-2"), contextFor(points));
    const cooldownBeforeSuccess = await runPointObject(object, (_target, durableState) => durableState.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_cooldowns WHERE key = 'duel:challenge:viewer_poor'",
    ).one().count);
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0]).toMatchObject({ kind: "chat", replyToMessageId: "fictional-poor-1", automated: false });
    expect(second.actions).toHaveLength(0);
    expect(cooldownBeforeSuccess).toBe(0);

    await addBalance(points, "viewer_anna", "frostfern");
    await processDuelMessage(eventFor(channelId, "!duel 100", "viewer_anna", "frostfern", "fictional-success"), contextFor(points));
    const cooldownAfterSuccess = await runPointObject(object, (_target, durableState) => durableState.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_cooldowns WHERE key = 'duel:challenge:viewer_anna'",
    ).one().count);
    expect(cooldownAfterSuccess).toBe(1);
  });
});
