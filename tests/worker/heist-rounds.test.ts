import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { heistSettingsForLanguage, type HeistSettings } from "../../src/modules/heist/contracts";
import { processHeistMessage } from "../../src/modules/heist/service";
import { modulePoints } from "../../src/worker/module-points";
import {
  clearPointObjectAlarms,
  deferPointAlarmWithin,
  forcePointAlarm,
  insertPointChannel,
  pointObject,
  runMigrations,
  runPointAlarm,
  runPointObject,
  scheduleAlarmKeyWithin,
  type PointsWorkerObject,
  stubPointRoundChat,
} from "./points-test-helpers";

const moduleId = "heist";

interface HeistRoundObject extends PointsWorkerObject {
  activeGameRound(moduleId: string): Promise<{ roundId: string; state: "announcing" | "open"; data: unknown; deadlineAt: number | null } | null>;
}

const heistObject = (channelId: string): HeistRoundObject => pointObject(channelId) as unknown as HeistRoundObject;

const openRound = async (object: HeistRoundObject, roundId: string): Promise<void> => {
  const data = {
    durationS: 60,
    announceText: "Heist open.",
    lockKeys: ["heist:active"],
    settlement: { kind: "heist", params: { baseChance: 100, maxChance: 100 } },
    baseChance: 100,
    maxChance: 100,
  };
  await object.openGameRoundWithStake(moduleId, roundId, data,
    `round:${roundId}:participant:viewer_anna`, "viewer_anna", "frostfern", 100,
    { key: "between-rounds", seconds: 90 });
  await object.markGameRoundAnnounced(moduleId, roundId, Date.now() + 60_000, `round:${roundId}`);
}

const createViewer = async (object: HeistRoundObject, accountId: string, login: string): Promise<void> => {
  await object.touchPointAccount(moduleId, accountId, login, 500);
};

beforeAll(runMigrations);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2100, 0, 1));
});
afterEach(async () => {
  try { await clearPointObjectAlarms(); } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});

describe("heist point rounds", () => {
  it("persists the join window across DO re-entry and settles all stakes once when its alarm ends", async () => {
    const channelId = `heist-lifecycle-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = heistObject(channelId);
    await createViewer(object, "viewer_anna", "frostfern");
    await createViewer(object, "viewer_ben", "moonmoss");
    await createViewer(object, "viewer_cara", "starling");

    await openRound(object, "heist-lifecycle");
    await runPointObject(object, async (_target, state) => deferPointAlarmWithin(state));
    const reopened = heistObject(channelId);
    const active = await reopened.activeGameRound(moduleId);
    expect(active).toMatchObject({ roundId: "heist-lifecycle", state: "open", deadlineAt: Date.now() + 60_000 });

    const joined = await reopened.joinGameRound(moduleId, "heist-lifecycle", "round:heist-lifecycle:participant:viewer_ben",
      "viewer_ben", "moonmoss", 150, {});
    const replay = await reopened.joinGameRound(moduleId, "heist-lifecycle", "round:heist-lifecycle:participant:viewer_ben",
      "viewer_ben", "moonmoss", 150, {});
    expect(joined).toMatchObject({ status: "joined", replayed: false });
    expect(replay).toMatchObject({ status: "joined", replayed: true });
    // A second message from the same viewer never adds a second stake.
    await expect(reopened.joinGameRound(moduleId, "heist-lifecycle", "round:heist-lifecycle:participant:viewer_ben:again",
      "viewer_ben", "moonmoss", 50, {})).resolves.toMatchObject({ status: "already_joined" });

    stubPointRoundChat(object, () => Promise.resolve({ sent: true, delivery: "delivered" }));
    await forcePointAlarm(object, "heist-lifecycle", (_target, state) => {
      state.storage.sql.exec("UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?", Date.now() - 1, "heist-lifecycle");
    });
    const balances = await runPointObject(object, (_target, state) => ({
      anna: state.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "viewer_anna").one().balance,
      ben: state.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "viewer_ben").one().balance,
      house: state.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "__house").one().balance,
      resolutionDelta: state.storage.sql.exec<{ total: number }>("SELECT COALESCE(SUM(delta), 0) AS total FROM point_ledger WHERE operation_id = ?", "round:heist-lifecycle:resolve").one().total,
      resolutionCount: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", "round:heist-lifecycle:resolve").one().count,
      negativeViewers: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_accounts WHERE substr(account_id, 1, 2) <> '__' AND balance < 0").one().count,
    }));
    const replayedResolution = await object.resolveGameRound(moduleId, "heist-lifecycle", {
      kind: "heist", params: { baseChance: 100, maxChance: 100 },
    });

    // House: three 500-point start bonuses, plus 250 net paid out (both winners, chance 100 %).
    expect(balances).toEqual({ anna: 600, ben: 650, house: -1750, resolutionDelta: 0, resolutionCount: 1, negativeViewers: 0 });
    expect(replayedResolution.replayed).toBe(true);
    await expect(object.joinGameRound(moduleId, "heist-lifecycle", "round:heist-lifecycle:participant:viewer_cara",
      "viewer_cara", "starling", 50, {})).resolves.toMatchObject({ status: "round_closed" });
  });

  it("refunds every funded participant if the module is disabled before the join window ends", async () => {
    const channelId = `heist-disable-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = heistObject(channelId);
    await createViewer(object, "viewer_anna", "frostfern");
    await createViewer(object, "viewer_ben", "moonmoss");
    await openRound(object, "heist-disabled");
    await object.joinGameRound(moduleId, "heist-disabled", "round:heist-disabled:participant:viewer_ben", "viewer_ben", "moonmoss", 100, {});

    await object.setGameModuleGate(moduleId, true, 1, 1);
    await object.cancelOpenGameRounds(moduleId, 1);
    const state = await runPointObject(object, (_target, durableState) => ({
      anna: durableState.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "viewer_anna").one().balance,
      ben: durableState.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "viewer_ben").one().balance,
      escrow: durableState.storage.sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", "__escrow:heist-disabled").one().balance,
      status: durableState.storage.sql.exec<{ state: string }>("SELECT state FROM game_rounds WHERE round_id = ?", "heist-disabled").one().state,
    }));

    expect(state).toEqual({ anna: 500, ben: 500, escrow: 0, status: "cancelled" });
  });
});

describe("heist batched join line alarm", () => {
  const confirmAlarmEntry = (object: HeistRoundObject, alarmKey: string) => runPointObject(object, (_target, state) =>
    state.storage.kv.get<Record<string, { deadline: number; handler: string; failures?: number }>>("channel:alarm_schedule")?.[alarmKey]);

  const eventFor = (settings: HeistSettings, userId: string, login: string, text: string, messageId: string): ModuleEvent<HeistSettings> => ({
    channelId: "fictional_channel",
    subscriptionType: "channel.chat.message",
    triggerId: messageId,
    receivedAt: new Date().toISOString(),
    actor: null,
    chatStatus: ["viewer"],
    settings,
    payload: { message_id: messageId, chatter_user_id: userId, chatter_user_login: login, message: { text } },
  });

  /** Starts a round through the real command handler, then lets two more viewers join. */
  const startRound = async (channelId: string, startLineDelayMs = 0) => {
    await insertPointChannel(channelId);
    const object = heistObject(channelId);
    await createViewer(object, "viewer_anna", "frostfern");
    await createViewer(object, "viewer_ben", "moonmoss");
    await createViewer(object, "viewer_cara", "starling");
    const points = modulePoints((env as unknown as { CHANNEL: Env["CHANNEL"] }).CHANNEL, channelId, moduleId);
    const settings = heistSettingsForLanguage("en");
    const context = {
      points,
      botUserId: () => Promise.resolve("fictional_brobot"),
      channelLanguage: () => Promise.resolve("en"),
      scheduleAlarm: (handlerKey: string, alarmKey: string, deadline: number) =>
        object.scheduleModuleAlarm(moduleId, handlerKey, alarmKey, deadline),
    } as unknown as ModuleExecutionContext;
    await processHeistMessage(eventFor(settings, "viewer_anna", "frostfern", "!heist 100", "fictional-start"), context);
    const started = await points.rounds.active();
    if (started === null) throw new Error("The heist round did not open.");
    // The join window only starts once the start line is delivered, which can be later than the start message.
    vi.setSystemTime(Date.now() + startLineDelayMs);
    await object.markGameRoundAnnounced(moduleId, started.roundId, Date.now() + 60_000, `round:${started.roundId}`);
    await processHeistMessage(eventFor(settings, "viewer_ben", "moonmoss", "!heist 50", "fictional-join-1"), context);
    await processHeistMessage(eventFor(settings, "viewer_cara", "starling", "!heist 75", "fictional-join-2"), context);
    return { object, points, context, settings, roundId: started.roundId, alarmKey: `module:${moduleId}:confirm:${started.roundId}` };
  };

  const stubAlarmChat = async (object: HeistRoundObject, sendChat: ModuleAlarmContext["sendChat"]): Promise<void> =>
    runPointObject(object, (target) => {
      const runtime = target as unknown as { moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext };
      const original = runtime.moduleAlarmContext.bind(runtime);
      vi.spyOn(runtime, "moduleAlarmContext").mockImplementation((...args) => ({ ...original(...args), sendChat }));
    });

  const runDueAlarm = async (object: HeistRoundObject, alarmKey: string): Promise<void> => {
    await runPointObject(object, async (_target, state) => {
      await state.storage.deleteAlarm();
      await scheduleAlarmKeyWithin(state, alarmKey);
    });
    await runPointAlarm(object);
    await runPointObject(object, async (_target, state) => deferPointAlarmWithin(state));
  };

  it("is planned by the start, survives a DO re-entry and goes out once although its first attempt is retried", async () => {
    const channelId = `heist-confirm-${crypto.randomUUID()}`;
    const { object, roundId, alarmKey } = await startRound(channelId);

    expect(await object.gameRoundParticipants(moduleId, roundId, 5)).toEqual({
      count: 3, totalStake: 225, logins: ["frostfern", "moonmoss", "starling"],
    });
    expect(await confirmAlarmEntry(object, alarmKey)).toMatchObject({ handler: "module:heist:confirm", deadline: Date.now() + 30_000 });

    await runPointObject(object, async (_target, state) => deferPointAlarmWithin(state));
    const reopened = heistObject(channelId);
    const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>()
      .mockResolvedValueOnce({ sent: false, reason: "rate_limited", retryable: true, delivery: "rate_limited" })
      .mockResolvedValue({ sent: true, reason: null, retryable: false, delivery: "delivered" });
    await stubAlarmChat(reopened, sendChat);
    vi.setSystemTime(Date.now() + 30_000);

    await runDueAlarm(reopened, alarmKey);
    expect(sendChat).toHaveBeenCalledOnce();
    expect(await confirmAlarmEntry(reopened, alarmKey)).toMatchObject({ failures: 1 });

    await runDueAlarm(reopened, alarmKey);
    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(await confirmAlarmEntry(reopened, alarmKey)).toBeUndefined();
    for (const call of sendChat.mock.calls) {
      expect(call[0]).toBe("3 in: frostfern, moonmoss, starling · pot 225");
      expect(call[1]).toBe(`round:${roundId}:confirm`);
      expect(call[5]).toEqual({ replyToMessageId: "fictional-start", automated: false });
    }
    expect(await reopened.activeGameRound(moduleId)).toMatchObject({ roundId, state: "open" });
  });

  it("sends nothing when the module is disabled and its round cancelled before the alarm is due", async () => {
    const { object, alarmKey } = await startRound(`heist-confirm-off-${crypto.randomUUID()}`);
    const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(() => Promise.resolve({ sent: true, reason: null, retryable: false, delivery: "delivered" }));
    await stubAlarmChat(object, sendChat);

    await object.setGameModuleGate(moduleId, true, 1, 1);
    await object.cancelOpenGameRounds(moduleId, 1);
    vi.setSystemTime(Date.now() + 30_000);
    await runDueAlarm(object, alarmKey);

    expect(sendChat).not.toHaveBeenCalled();
    expect(await confirmAlarmEntry(object, alarmKey)).toBeUndefined();
  });

  it("does not debit a viewer twice when an already joined message is redelivered during a later round", async () => {
    const { object, points, context, settings, roundId } = await startRound(`heist-redelivery-${crypto.randomUUID()}`);
    expect(await points.balance("viewer_ben")).toBe(450);
    await object.resolveGameRound(moduleId, roundId, { kind: "heist", params: { baseChance: 0, maxChance: 0 } });
    expect(await points.balance("viewer_ben")).toBe(450);

    await object.openGameRoundWithStake(moduleId, "heist-later", {
      durationS: 60, announceText: "Heist open.", lockKeys: ["heist:active"],
      settlement: { kind: "heist", params: { baseChance: 50, maxChance: 65 } },
    }, "msg:fictional-later-start", "viewer_anna", "frostfern", 10);
    await object.markGameRoundAnnounced(moduleId, "heist-later", Date.now() + 60_000, "round:heist-later");

    await processHeistMessage(eventFor(settings, "viewer_ben", "moonmoss", "!heist 50", "fictional-join-1"), context);
    expect(await points.balance("viewer_ben")).toBe(450);
    expect((await object.gameRoundParticipants(moduleId, "heist-later", 5)).count).toBe(1);

    await processHeistMessage(eventFor(settings, "viewer_ben", "moonmoss", "!heist 50", "fictional-join-fresh"), context);
    expect(await points.balance("viewer_ben")).toBe(400);
    expect((await object.gameRoundParticipants(moduleId, "heist-later", 5)).count).toBe(2);
  });

  it("starts the pause when the round settles, so a late start line does not eat into it", async () => {
    const { object, context, settings, roundId } = await startRound(`heist-pause-${crypto.randomUUID()}`, 20_000);
    vi.setSystemTime(Date.now() + 60_000);
    await object.resolveGameRound(moduleId, roundId, { kind: "heist", params: { baseChance: 0, maxChance: 0 } });

    // Twenty seconds after settlement the 30 s pause still runs; counted from the start message it would be over.
    vi.setSystemTime(Date.now() + 20_000);
    const blocked = await processHeistMessage(eventFor(settings, "viewer_anna", "frostfern", "!heist 10", "fictional-next-1"), context);
    expect(blocked.actions).toEqual([expect.objectContaining({ text: "A new heist is not ready yet." })]);
    expect(await object.activeGameRound(moduleId)).toBeNull();

    vi.setSystemTime(Date.now() + 11_000);
    const allowed = await processHeistMessage(eventFor(settings, "viewer_anna", "frostfern", "!heist 10", "fictional-next-2"), context);
    expect(allowed.actions).toEqual([]);
    expect(await object.activeGameRound(moduleId)).toMatchObject({ state: "announcing" });
  });

  it("answers a join without enough points with the intended reply", async () => {
    const { object, context, settings, roundId } = await startRound(`heist-poor-${crypto.randomUUID()}`);
    await object.touchPointAccount(moduleId, "viewer_dan", "poorfern", 5);

    const reply = await processHeistMessage(eventFor(settings, "viewer_dan", "poorfern", "!heist 50", "fictional-poor-join"), context);

    expect(reply.actions).toEqual([expect.objectContaining({ text: "You do not have enough points for that stake." })]);
    expect((await object.gameRoundParticipants(moduleId, roundId, 5)).count).toBe(3);
  });
});
