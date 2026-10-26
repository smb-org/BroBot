import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ModuleEvent, ModuleExecutionContext, ModulePointsAccess } from "../../src/modules/contract";
import { DEFAULT_POINTS_SETTINGS } from "../../src/modules/points/contracts";
import { localizedMonth, processPointsMessage } from "../../src/modules/points/service";
import { appendPointWelcome } from "../../src/worker/point-welcome";
import {
  clearPointObjectAlarms,
  insertPointChannel,
  pointObject,
  runMigrations,
  testCard,
  type PointsWorkerObject,
} from "./points-test-helpers";

const moduleId = "points";

const makeEvent = (text: string, login = "nachtfalke", timestamp = "2026-10-19T12:00:00.000Z"): ModuleEvent<typeof DEFAULT_POINTS_SETTINGS> => ({
  channelId: "kanal_demo",
  subscriptionType: "channel.chat.message",
  triggerId: `message-${login}`,
  payload: {
    message_id: `message-${login}`,
    chatter_user_id: "viewer_demo",
    chatter_user_login: login,
    message: { text },
  },
  settings: DEFAULT_POINTS_SETTINGS,
  receivedAt: timestamp,
  eventSubTimestamp: timestamp,
  actor: null,
  chatStatus: ["viewer"],
});

const contextFor = (object: PointsWorkerObject, live: "online" | "offline" = "online"): ModuleExecutionContext => {
  const access: ModulePointsAccess = {
    apply: (operationId, kind, movements, result) => object.applyPointOperation(moduleId, operationId, kind, movements, result),
    settle: (operationId, kind, actor, stake, params, options) => object.settlePointOperation(moduleId, operationId, kind, actor, stake, params, options),
    touchAccount: (accountId, login, startBonus) => object.touchPointAccount(moduleId, accountId, login, startBonus),
    ackWelcome: (accountId, claimId) => object.acknowledgePointWelcome(moduleId, accountId, claimId),
    creditActivity: (accountId, login, messageAt, isLive, rules) => object.creditPointActivity(moduleId, accountId, login, messageAt, isLive, rules),
    balance: (accountId) => object.pointBalance(moduleId, accountId),
    getAccount: (accountId) => object.pointAccount(moduleId, accountId),
    listAccounts: (query) => object.listPointAccounts(moduleId, query),
    history: (accountId, cursor, limit) => object.pointHistory(moduleId, accountId, cursor, limit),
    summary: () => object.pointSummary(moduleId),
    ranking: (month, limit) => object.pointRanking(moduleId, month, limit),
    rankOf: (accountId, month) => object.pointRankOf(moduleId, accountId, month),
    markAuditWritten: (operationId) => object.markPointAuditWritten(moduleId, operationId),
    pendingAudits: () => object.pendingPointAudits(moduleId),
    claimCooldown: (key, seconds) => object.claimPointCooldown(moduleId, key, seconds),
    rounds: {} as ModulePointsAccess["rounds"],
  };
  return {
    DB: {} as D1Database,
    points: access,
    streamState: () => Promise.resolve(live),
    channelLanguage: () => Promise.resolve("de"),
    botUserId: () => Promise.resolve(null),
  } as unknown as ModuleExecutionContext;
};

beforeAll(runMigrations);
afterEach(clearPointObjectAlarms);

describe("points module worker events", () => {
  it(`books the first bonus once across parallel messages and clears welcome after a sent reply (${testCard("first contact remains atomic and its welcome is acknowledged after delivery", "parallel chat messages duplicate the bonus or clear welcome before reply delivery", "the module and welcome callback run against a real ChannelObject")})`, async () => {
    const channelId = `points-module-first-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const context = contextFor(object);

    const results = await Promise.all([
      processPointsMessage(makeEvent("!punkte"), context),
      processPointsMessage(makeEvent("!punkte"), context),
    ]);

    await expect(object.pointBalance(moduleId, "viewer_demo")).resolves.toBe(105);
    const history = await object.pointHistory(moduleId, "viewer_demo");
    expect(history.rows.filter((row) => row.kind === "bonus")).toHaveLength(1);
    const reply = results.flatMap((result) => result.actions).find((action) => action.kind === "chat");
    expect(reply?.kind).toBe("chat");
    if (reply?.kind !== "chat") throw new Error("The points command did not produce a chat reply.");
    expect(reply.replyToMessageId).toBe("message-nachtfalke");
    const claimId = "dispatch:points-module-first:points:0";
    await object.storePendingPointWelcome(moduleId, {
      accountId: "viewer_demo",
      messageId: "message-nachtfalke",
      text: "Startguthaben 100 Punkte",
    });
    expect(await object.claimPointWelcome(moduleId, "viewer_demo", claimId)).toBe(true);
    const pending = {
      accountId: "viewer_demo",
      messageId: "message-nachtfalke",
      text: "Startguthaben 100 Punkte",
      access: { ackWelcome: (accountId: string, currentClaimId?: string) => object.acknowledgePointWelcome(moduleId, accountId, currentClaimId) },
      deliveryClaimId: claimId,
      used: false,
    };
    const welcomedReply = appendPointWelcome(reply, { id: moduleId }, pending);
    if (welcomedReply.kind !== "chat") throw new Error("The welcome note did not remain a chat reply.");
    expect(welcomedReply.text).toContain("Startguthaben 100 Punkte");
    await welcomedReply.onDelivery?.("sent", claimId);
    await expect(object.touchPointAccount(moduleId, "viewer_demo", "nachtfalke", 100)).resolves.toEqual({ welcomePending: false, startBonus: 100 });
  });

  it(`keeps the first booked bonus on a pending welcome after settings change (${testCard("the pending welcome retains the amount recorded by the bonus operation", "changing startBonus before the next contact changes the reported booking", "the test reads the real persisted points ledger through a ChannelObject")})`, async () => {
    const channelId = `points-module-booked-bonus-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);

    const firstContact = await object.touchPointAccount(moduleId, "viewer_demo", "nachtfalke", 100);
    const nextContact = await object.touchPointAccount(moduleId, "viewer_demo", "nachtfalke", 200);

    expect(firstContact).toEqual({ welcomePending: true, startBonus: 100 });
    expect(nextContact).toEqual({ welcomePending: true, startBonus: 100 });
  });

  it(`credits one activity window and refreshes the account login (${testCard("module chat events update login and award at most one configured activity credit per window", "two messages within ten minutes earn twice or the account keeps a stale login", "chat events run through the module against a real ChannelObject")})`, async () => {
    const channelId = `points-module-activity-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const context = contextFor(object);

    await processPointsMessage(makeEvent("hello", "nachtfalke"), context);
    await processPointsMessage(makeEvent("another message", "nachtfalke_neu", "2026-10-19T12:05:00.000Z"), context);

    await expect(object.pointBalance(moduleId, "viewer_demo")).resolves.toBe(105);
    await expect(object.listPointAccounts(moduleId, { sort: "balance", limit: 50 })).resolves.toMatchObject({
      rows: [{ accountId: "viewer_demo", login: "nachtfalke_neu", balance: 105 }],
    });
  });

  it(`does not award activity for an offline message (${testCard("offline module chat cannot credit activity points", "an offline event increases balance through activity", "the module stream-state response is supplied directly")})`, async () => {
    const channelId = `points-module-offline-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);

    await processPointsMessage(makeEvent("hello"), contextFor(object, "offline"));

    await expect(object.pointBalance(moduleId, "viewer_demo")).resolves.toBe(100);
    const history = await object.pointHistory(moduleId, "viewer_demo");
    expect(history.rows.every((row) => row.kind !== "activity")).toBe(true);
  });

  it(`stops the 31st UTC activity window at the daily cap (${testCard("the points module credits no more than thirty 5-point windows under the 150-point cap", "a 31st window raises the daily activity credit over 150", "31 chat events run against a real ChannelObject with deterministic event timestamps")})`, async () => {
    const channelId = `points-module-cap-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const context = contextFor(object);
    const day = Date.UTC(2026, 9, 19, 0, 0);

    for (let index = 0; index < 31; index += 1) {
      const at = new Date(day + index * 10 * 60_000).toISOString();
      await processPointsMessage(makeEvent("hello", "nachtfalke", at), context);
      if (index === 29) await expect(object.pointBalance(moduleId, "viewer_demo")).resolves.toBe(250);
    }

    await expect(object.pointBalance(moduleId, "viewer_demo")).resolves.toBe(250);
  });

  it(`ranks only game results in !top (${testCard("!top uses the current UTC month game ledger while bonus, activity, and admin operations stay out", "a start bonus, activity credit, or correction appears in monthly game ranking", "module commands use a real ChannelObject seeded through its ledger API")})`, async () => {
    const channelId = `points-module-ranking-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const context = contextFor(object);
    await object.touchPointAccount(moduleId, "viewer_demo", "nachtfalke", 100);
    await object.touchPointAccount(moduleId, "viewer_other", "pixelpilz", 100);
    await object.creditPointActivity(moduleId, "viewer_demo", "nachtfalke", Date.parse("2026-10-19T12:00:00.000Z"), true, {
      amount: 5,
      windowMinutes: 10,
      dailyCap: 150,
    });
    await object.applyPointOperation(moduleId, "game:monthly", "game", [
      { accountId: "viewer_other", delta: 40, login: "pixelpilz" },
      { accountId: "__house", delta: -40 },
    ], { payout: 40 });
    await object.applyPointOperation(moduleId, "admin:correction", "admin", [
      { accountId: "viewer_demo", delta: 90 },
      { accountId: "__house", delta: -90 },
    ], { reason: "stream prize", actorId: "manager_demo", actorLogin: "kanal_demo" });

    const result = await processPointsMessage(makeEvent("!top"), context);

    const currentMonth = new Date().toISOString().slice(0, 7);
    expect(result.actions[0]).toMatchObject({ kind: "chat", text: `Top im ${localizedMonth(currentMonth, "de")}: 1. pixelpilz +40 Punkte` });
    await expect(object.pointRankOf(moduleId, "viewer_demo", currentMonth)).resolves.toEqual({ rank: null, net: 0 });
  });
});
