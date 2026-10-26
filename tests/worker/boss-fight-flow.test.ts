import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { bossFightDefaultsForLanguage, type BossFightSettings } from "../../src/modules/boss_fight/contracts";
import { openBossFightRound, processBossFightMessage } from "../../src/modules/boss_fight/service";
import { modulePoints } from "../../src/worker/module-points";
import {
  clearPointObjectAlarms,
  forcePointAlarm,
  insertPointChannel,
  pointObject,
  runMigrations,
  runPointObject,
  type PointsWorkerObject,
} from "./points-test-helpers";

const testEnvironment = env as unknown as Env;

const attackEvent = (channelId: string, userId: string, login: string, messageId: string): ModuleEvent<BossFightSettings> => ({
  channelId,
  subscriptionType: "channel.chat.message",
  triggerId: messageId,
  receivedAt: new Date().toISOString(),
  actor: null,
  chatStatus: ["viewer"],
  settings: bossFightDefaultsForLanguage("en"),
  payload: { message_id: messageId, chatter_user_id: userId, chatter_user_login: login, message: { text: "!attack" } },
});

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

describe("boss fight worker flow", () => {
  it("plays a four-attacker round with one start line, one result line and a zero-sum payout [protects=attacks never reply and a defeated boss pays damage shares from the house once; fails_when=a chat line per attack, a second result line or a non-zero ledger sum; no_claim=uses the real ChannelObject and ledger with the alarm chat transport mocked]", async () => {
    const channelId = `boss-flow-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const settings = bossFightDefaultsForLanguage("en");
    await testEnvironment.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'boss_fight', 1, ?, 1)",
    ).bind(channelId, JSON.stringify(settings)).run();
    const object = pointObject(channelId);
    const points = modulePoints(testEnvironment.CHANNEL, channelId, "boss_fight");
    const context = { points, botUserId: () => Promise.resolve("fictional_brobot") } as unknown as ModuleExecutionContext;
    const sendChat = await stubAlarmChat(object);

    const roundId = await openBossFightRound({ settings, language: "en", points });
    await forcePointAlarm(object, roundId);

    // Damage rolls 40, 30, 20 and 30 for the four attackers (random 0.99, 0.5, 0, 0.5).
    const attackers = [
      { id: "viewer_a", login: "frostfern", roll: 0.99 },
      { id: "viewer_b", login: "moonmoss", roll: 0.5 },
      { id: "viewer_c", login: "pixelpilz", roll: 0 },
      { id: "viewer_d", login: "amberleaf", roll: 0.5 },
    ];
    for (let wave = 0; wave < 6; wave += 1) {
      for (const attacker of attackers) {
        await processBossFightMessage(
          attackEvent(channelId, attacker.id, attacker.login, `${attacker.id}-${String(wave)}`),
          context,
          () => attacker.roll,
        );
      }
      vi.setSystemTime(Date.now() + 10_000);
    }
    expect(sendChat).toHaveBeenCalledOnce();
    await forcePointAlarm(object, roundId);

    const ledger = await runPointObject(object, (_target, state) => ({
      round: state.storage.sql.exec<{ state: string }>("SELECT state FROM game_rounds WHERE round_id = ?", roundId).one().state,
      sum: state.storage.sql.exec<{ total: number }>("SELECT COALESCE(SUM(balance), 0) AS total FROM point_accounts").one().total,
      negative: state.storage.sql.exec<{ account_id: string }>("SELECT account_id FROM point_accounts WHERE balance < 0").toArray().map(({ account_id }) => account_id),
    }));
    expect(ledger).toEqual({ round: "resolved", sum: 0, negative: ["__house"] });
    const balances = await Promise.all(attackers.map(({ id }) => points.balance(id)));
    // 1000 loot split by damage 240/150/100/150 of 640, floored; the 1 point remainder stays with the house.
    expect(balances).toEqual([375, 234, 156, 234]);
    expect(sendChat.mock.calls.map((call) => call[0])).toEqual([
      "🐉 A boss appears! Type !attack to hit the boss. (90 s)",
      "🏆 The boss is defeated! Top damage: @frostfern 240 dmg · 375 pts, @moonmoss 150 dmg · 234 pts, @amberleaf 150 dmg · 234 pts, +1 more.",
    ]);
  });
});
