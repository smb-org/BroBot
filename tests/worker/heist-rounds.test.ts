import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPointObjectAlarms,
  deferPointAlarmWithin,
  forcePointAlarm,
  insertPointChannel,
  pointObject,
  runMigrations,
  runPointObject,
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
      negativeViewers: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM point_accounts WHERE account_id NOT LIKE '__%' AND balance < 0").one().count,
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
