import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import type { ModuleEvent, ModuleExecutionContext, ModulePointsAccess } from "../../src/modules/contract";
import type { ModuleRouteEnvironment, ModuleTwitchEmoteList } from "../../src/modules/contract";
import { DEFAULT_EMOTE_SLOT_SETTINGS, emoteSlotDefaultSettingsForLanguage, type EmoteSlotSettings } from "../../src/modules/emote_slots/contracts";
import { clearEmoteSlotEmoteCache, emoteSlotsRoutes } from "../../src/modules/emote_slots/routes";
import { formatSlotReply } from "../../src/modules/emote_slots/domain/chat";
import { slotSettlementTable, type SlotSettlementResult } from "../../src/modules/emote_slots/domain/settlement";
import { processEmoteSlotMessage } from "../../src/modules/emote_slots/service";
import {
  capturePointError,
  clearPointObjectAlarms,
  insertPointChannel,
  pointObject,
  runMigrations,
  runPointObject,
  testCard,
} from "./points-test-helpers";

const slotModule = "emote_slots";
const pointsModule = "points";
const nowMonth = (): string => new Date().toISOString().slice(0, 7);

const paramsFor = (stake: number, symbols: [number, number, number], overrides: Partial<{
  seed: number;
  jackpotShareBp: number;
  maxStake: number;
}> = {}) => ({
  stake,
  symbols,
  table: { symbols: slotSettlementTable(DEFAULT_EMOTE_SLOT_SETTINGS).symbols },
  jackpotShareBp: overrides.jackpotShareBp ?? 700,
  maxStake: overrides.maxStake ?? 500,
  seed: overrides.seed ?? 500,
});

const identityFor = (accountId: string, stake: number) => ({ kind: "slot", moduleId: slotModule, accountId, stake });

const settle = (
  object: ReturnType<typeof pointObject>,
  accountId: string,
  login: string,
  operationId: string,
  stake: number,
  symbols: [number, number, number],
  options: { cooldown?: { key: string; seconds: number }; params?: unknown } = {},
) => object.settlePointOperation(slotModule, operationId, "slot", { accountId, login }, stake,
  options.params ?? paramsFor(stake, symbols), {
    payloadIdentity: identityFor(accountId, stake),
    ...(options.cooldown === undefined ? {} : { cooldown: options.cooldown }),
  });

const pointOperation = (object: ReturnType<typeof pointObject>, operationId: string): Promise<{
  kind: string;
  moduleId: string;
  result: unknown;
} | null> => runPointObject(object, (_target, state) => {
  const row = state.storage.sql.exec<{ kind: string; module_id: string; result_json: string }>(
    "SELECT kind, module_id, result_json FROM point_operations WHERE operation_id = ?",
    operationId,
  ).toArray()[0];
  return row === undefined ? null : { kind: row.kind, moduleId: row.module_id, result: JSON.parse(row.result_json) as unknown };
});

const slotGameOperationIds = (object: ReturnType<typeof pointObject>): Promise<string[]> => runPointObject(object, (_target, state) =>
  state.storage.sql.exec<{ operation_id: string }>(
    "SELECT operation_id FROM point_operations WHERE module_id = ? AND kind = 'game' AND operation_id LIKE 'msg:slot-%' ORDER BY operation_id",
    slotModule,
  ).toArray().map(({ operation_id }) => operation_id));

const slotEvent = (channelId: string, messageId: string, stake = 50): ModuleEvent<EmoteSlotSettings> => ({
  channelId,
  subscriptionType: "channel.chat.message",
  triggerId: messageId,
  payload: {
    message_id: messageId,
    chatter_user_id: "viewer_demo",
    chatter_user_login: "pixelpilz",
    message: { text: `!slot ${String(stake)}` },
  },
  settings: emoteSlotDefaultSettingsForLanguage("de"),
  receivedAt: new Date().toISOString(),
  actor: null,
  chatStatus: ["viewer"],
});

const eventContext = (object: ReturnType<typeof pointObject>): ModuleExecutionContext => {
  const points = {
    settle: (operationId: string, kind: string, actor: { accountId: string; login: string }, stake: number, params: unknown,
      options: Parameters<ModulePointsAccess["settle"]>[5]) => object.settlePointOperation(slotModule, operationId, kind, actor, stake, params, options),
    balance: (accountId: string) => object.pointBalance(slotModule, accountId),
    claimCooldown: (key: string, seconds: number) => object.claimPointCooldown(slotModule, key, seconds),
  } as unknown as ModulePointsAccess;
  return {
    points,
    botUserId: () => Promise.resolve(null),
    channelLanguage: () => Promise.resolve("de"),
  } as unknown as ModuleExecutionContext;
};

const helixOk = (data: Array<{ id: string; name: string; images?: { url_1x?: string } }>) => ({ ok: true as const, status: 200, data });
const helixFail = () => ({ ok: false as const, status: 503, reason: "http_503" as const, message: null, body: {} });
const responseBody = async <Result,>(response: Response): Promise<Result> => {
  const value: unknown = await response.json();
  return value as Result;
};

const emoteRoute = (args: {
  channelId: string;
  scopes: string[];
  global?: ModuleTwitchEmoteList;
  user?: ModuleTwitchEmoteList;
}) => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("botCredentials", () => Promise.resolve({ userId: "bot_demo", accessToken: "token_demo", scopes: args.scopes }));
    context.set("getAppAccessToken", () => Promise.resolve("app_token_demo"));
    context.set("getGlobalEmotes", args.global ?? (() => Promise.resolve(helixOk([{ id: "global-1", name: "globalwave" }]))));
    context.set("getUserEmotes", args.user ?? (() => Promise.resolve(helixOk([{ id: "channel-1", name: "channelwave" }]))));
    await next();
  });
  app.route("/api/channels/:channelId/modules/emote_slots", emoteSlotsRoutes);
  return app.request(`/api/channels/${encodeURIComponent(args.channelId)}/modules/emote_slots/emotes`, {}, { TWITCH_CLIENT_ID: "client_demo" });
};

beforeAll(runMigrations);
afterEach(async () => {
  await clearPointObjectAlarms();
  clearEmoteSlotEmoteCache();
  vi.unstubAllGlobals();
});

describe("emote slot settlements in the worker Durable Object", () => {
  it(`serializes twenty jackpot spins and pays the live pot once per turn (${testCard("20 maximum stakes pay jackpot balances 1,035 then 535 nineteen times with a final 500 pot and zero account sum", "a payout uses a stale jackpot snapshot, duplicates the pot, or changes the house by anything other than -700", "20 forced jackpot settlements run concurrently against one real ChannelObject")})`, async () => {
    const channelId = `slot-parallel-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.applyPointOperation(pointsModule, "fund-slot-pot", "bonus", [
      { accountId: "__jackpot:emote_slots", delta: 1_000 }, { accountId: "__house", delta: -1_000 },
    ], { funded: true });
    const players = Array.from({ length: 20 }, (_, index) => ({
      accountId: `viewer-${String(index).padStart(2, "0")}`,
      login: `player${String(index).padStart(2, "0")}`,
    }));
    await Promise.all(players.map(({ accountId, login }) => object.touchPointAccount(pointsModule, accountId, login, 1_000)));
    const houseBefore = await runPointObject(object, (_target, state) => state.storage.sql.exec<{ balance: number }>(
      "SELECT balance FROM point_accounts WHERE account_id = '__house'",
    ).one().balance);

    const results = await Promise.all(players.map(({ accountId, login }, index) => settle(
      object, accountId, login, `msg:slot-${String(index)}`, 500, [5, 5, 5],
    )));
    const jackpots = results.map(({ result }) => (result as SlotSettlementResult).jackpotWin).sort((left, right) => left - right);
    const summary = await object.pointSummary(slotModule);
    const houseAfter = await runPointObject(object, (_target, state) => state.storage.sql.exec<{ balance: number }>(
      "SELECT balance FROM point_accounts WHERE account_id = '__house'",
    ).one().balance);
    const accountSum = await runPointObject(object, (_target, state) => state.storage.sql.exec<{ balance_sum: number }>(
      "SELECT COALESCE(SUM(balance), 0) AS balance_sum FROM point_accounts",
    ).one().balance_sum);
    const historyCounts = await Promise.all(players.map(({ accountId }) => object.pointHistory(slotModule, accountId)));

    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(20);
    expect(jackpots).toEqual([1_035, ...Array.from({ length: 19 }, () => 535)].sort((left, right) => left - right));
    expect(jackpots.reduce((sum, value) => sum + value, 0)).toBe(11_200);
    expect(summary.jackpots).toEqual({ emote_slots: 500 });
    expect(houseAfter - houseBefore).toBe(-700);
    expect(accountSum).toBe(0);
    expect(historyCounts.every(({ rows }) => rows.filter((row) => row.operationId.startsWith("msg:slot-")).length === 1)).toBe(true);
    await expect(object.pointRanking(slotModule, nowMonth(), 50)).resolves.toHaveLength(20);
  });

  it(`replays the first draw before reading a new draw and rejects changed actor or stake (${testCard("same operation identity returns the stored outcome with replayed true and changed payload conflicts", "a retry books a second spin or a changed actor or stake is accepted", "the test invokes the settlement RPC directly without Twitch delivery")})`, async () => {
    const channelId = `slot-replay-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointsModule, "viewer_demo", "pixelpilz", 1_000);
    const first = await settle(object, "viewer_demo", "pixelpilz", "msg:slot-replay", 50, [0, 1, 2]);
    const replay = await settle(object, "viewer_demo", "pixelpilz", "msg:slot-replay", 50, [5, 5, 5]);
    const actorConflict = await capturePointError(object, (target) => target.settlePointOperation(
      slotModule, "msg:slot-replay", "slot", { accountId: "viewer_other", login: "pixelstern" }, 50,
      paramsFor(50, [0, 1, 2]), { payloadIdentity: identityFor("viewer_other", 50) },
    ));
    const stakeConflict = await capturePointError(object, (target) => target.settlePointOperation(
      slotModule, "msg:slot-replay", "slot", { accountId: "viewer_demo", login: "pixelpilz" }, 25,
      paramsFor(25, [0, 1, 2]), { payloadIdentity: identityFor("viewer_demo", 25) },
    ));

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, result: first.result });
    expect(actorConflict).toBe("operation_conflict");
    expect(stakeConflict).toBe("operation_conflict");
    await expect(pointOperation(object, "msg:slot-replay")).resolves.toMatchObject({ kind: "game", moduleId: slotModule, result: first.result });
  });

  it(`does not consume a spin cooldown after malformed params and rejects a later cooldown (${testCard("only a booked spin sets the per-player cooldown", "invalid params consume cooldown or a second booked spin bypasses it", "cooldown timestamps are exercised through the DO RPC")})`, async () => {
    const channelId = `slot-cooldown-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointsModule, "viewer_demo", "pixelpilz", 500);
    const cooldown = { key: "spin:viewer_demo", seconds: 3_600 };
    const invalid = await capturePointError(object, (target) => settle(target, "viewer_demo", "pixelpilz", "msg:slot-invalid", 50,
      [0, 0, 0], { cooldown, params: { ...paramsFor(50, [0, 0, 0]), symbols: [8, 8, 8] } }));
    const booked = await settle(object, "viewer_demo", "pixelpilz", "msg:slot-booked", 50, [0, 1, 2], { cooldown });
    const blocked = await capturePointError(object, (target) => settle(target, "viewer_demo", "pixelpilz", "msg:slot-blocked", 50, [0, 1, 2], { cooldown }));

    expect(invalid).toBe("invalid_settlement_params");
    expect(booked.replayed).toBe(false);
    expect(blocked).toBe("cooldown");
    await expect(slotGameOperationIds(object)).resolves.toEqual(["msg:slot-booked"]);
  });

  it(`rejects a forced jackpot before handler execution when the gross stake is unaffordable (${testCard("pre-spin balance must cover full gross stake regardless of jackpot payout", "a sub-stake account receives a jackpot or creates an operation", "the forced jackpot outcome is present in valid handler params")})`, async () => {
    const channelId = `slot-insufficient-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointsModule, "viewer_demo", "pixelpilz", 100);
    const result = await capturePointError(object, (target) => settle(target, "viewer_demo", "pixelpilz", "msg:slot-too-expensive", 500, [5, 5, 5]));

    expect(result).toBe("insufficient_balance");
    await expect(object.pointBalance(slotModule, "viewer_demo")).resolves.toBe(100);
    await expect(object.pointHistory(slotModule, "viewer_demo")).resolves.toMatchObject({ rows: [expect.objectContaining({ kind: "bonus" })] });
  });

  it(`rejects a spin while the module game gate is closed (${testCard("instant settlements honor the existing points module gate", "a disabled slot books a game movement", "the real DO gate state and settlement RPC share storage")})`, async () => {
    const channelId = `slot-gate-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointsModule, "viewer_demo", "pixelpilz", 500);
    await object.setGameModuleGate(slotModule, true, 1, 1);
    const result = await capturePointError(object, (target) => settle(target, "viewer_demo", "pixelpilz", "msg:slot-closed", 50, [0, 1, 2]));

    expect(result).toBe("module_closed");
    await expect(object.pointHistory(slotModule, "viewer_demo")).resolves.toMatchObject({ rows: [expect.objectContaining({ kind: "bonus" })] });
  });

  it(`delivers the stored result once and sends nothing on EventSub replay (${testCard("the booked spin emits matching chat and overlay results once, and a replay emits nothing", "chat or overlay values differ from the committed settlement, or a replay adds actions", "action descriptions are inspected before Twitch delivery")})`, async () => {
    const channelId = `slot-chat-replay-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointsModule, "viewer_demo", "pixelpilz", 500);
    const event = slotEvent(channelId, "message-slot-delivery");
    const context = eventContext(object);

    const first = await processEmoteSlotMessage(event, context);
    const storedOperation = await pointOperation(object, "msg:message-slot-delivery");
    const stored = storedOperation?.result as SlotSettlementResult;
    const isJackpot = stored.symbols.every((index) => index === 5);
    const kind = isJackpot ? "jackpot" : stored.pair ? "pair" : stored.net > 0 ? "win" : "loss";
    const second = await processEmoteSlotMessage(event, context);

    expect(first.actions).toHaveLength(2);
    expect(first.actions[0]).toMatchObject({
      kind: "chat",
      text: formatSlotReply(stored, DEFAULT_EMOTE_SLOT_SETTINGS.symbols, "de", "pixelpilz", kind),
    });
    expect(first.actions[1]).toMatchObject({
      kind: "overlay",
      type: "spin",
      elementKind: "emote_slots.slot",
      payload: {
        spinId: event.triggerId,
        symbols: stored.symbols.map((index) => ({
          source: "emoji",
          code: DEFAULT_EMOTE_SLOT_SETTINGS.symbols[index]?.code,
        })),
        net: stored.net,
        jackpot: stored.jackpotAfter,
        jackpotHit: stored.jackpotWin > 0,
      },
    });
    expect(second.actions).toEqual([]);
    await expect(pointOperation(object, "msg:message-slot-delivery")).resolves.toMatchObject({ kind: "game", result: stored });
  });

  it(`keeps chat and overlay on the saved code after a 7TV alias rename (${testCard("a saved oldwave code remains in chat and the overlay marks its same-id newwave alias missing", "the overlay treats the reused id as active or changes the configured chat or overlay code to newwave", "the active provider response contains one renamed alias for the saved id")})`, async () => {
    const channelId = `slot-alias-rename-${crypto.randomUUID()}`;
    clearEmoteSlotEmoteCache(channelId);
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointsModule, "viewer_demo", "pixelpilz", 500);
    const baseEvent = slotEvent(channelId, "message-slot-alias-rename");
    const settings: EmoteSlotSettings = {
      ...baseEvent.settings,
      symbols: baseEvent.settings.symbols.map((symbol) => ({
        ...symbol,
        source: "seven_tv" as const,
        code: "oldwave",
        sevenTvId: "emote-shared",
        name: "oldwave",
      })),
    };
    const event = { ...baseEvent, settings };
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({
      emote_set: { name: "Night Shift", emotes: [{ id: "emote-shared", name: "newwave" }] },
    })));
    vi.stubGlobal("fetch", fetcher);

    const result = await processEmoteSlotMessage(event, eventContext(object));
    const chatAction = result.actions.find((action) => action.kind === "chat");
    const overlayAction = result.actions.find((action) => action.kind === "overlay");

    expect(chatAction?.kind).toBe("chat");
    if (chatAction?.kind === "chat") expect(chatAction.text).toContain("oldwave");
    expect(overlayAction?.kind).toBe("overlay");
    if (overlayAction?.kind === "overlay") {
      expect(overlayAction.payload.symbols).toEqual(Array.from({ length: 3 }, () => ({
        source: "seven_tv",
        code: "oldwave",
        sevenTvId: "emote-shared",
        missing: true,
      })));
    }
    expect(fetcher).toHaveBeenCalledOnce();
    clearEmoteSlotEmoteCache(channelId);
  });
});

describe("emote slot Twitch emote route", () => {
  it(`returns deduplicated global and bot-usable emotes with the granted scope (${testCard("emoji, global emotes, and user emotes reach the picker once by Twitch ID", "channel emotes disappear, duplicate ids remain, or the route returns another status", "Helix responses are stubbed at the host capability boundary")})`, async () => {
    const channelId = `slot-emotes-scope-${crypto.randomUUID()}`;
    clearEmoteSlotEmoteCache(channelId);
    const response = await emoteRoute({
      channelId,
      scopes: ["user:read:emotes"],
      global: () => Promise.resolve(helixOk([{ id: "global-1", name: "globalwave" }])),
      user: () => Promise.resolve(helixOk([{ id: "global-1", name: "renamedglobal" }, { id: "channel-1", name: "channelwave" }])),
    });
    const body = await responseBody<{ emoji: { items: unknown[] }; twitch: { status: string; items: Array<{ twitchId?: string; code: string }> } }>(response);

    expect(response.status).toBe(200);
    expect(body.emoji.items.length).toBeGreaterThan(0);
    expect(body.twitch.status).toBe("ok");
    expect(body.twitch.items.map(({ twitchId }) => twitchId)).toEqual(["global-1", "channel-1"]);
    expect(body.twitch.items.map(({ code }) => code)).toEqual(["renamedglobal", "channelwave"]);
  });

  it(`shows reconnect when the scope is missing and retries the list after reconnection (${testCard("missing user:read:emotes keeps emoji and global options and is not cached", "a reconnect-required state hides emoji or remains cached after a later granted scope", "the route receives mutable test credentials with a stable channel key")})`, async () => {
    const channelId = `slot-emotes-reconnect-${crypto.randomUUID()}`;
    clearEmoteSlotEmoteCache(channelId);
    let scopes: string[] = [];
    let userCalls = 0;
    const request = async () => {
      const app = new Hono<ModuleRouteEnvironment>();
      app.use("*", async (context, next) => {
        context.set("botCredentials", () => Promise.resolve({ userId: "bot_demo", accessToken: "token_demo", scopes }));
        context.set("getAppAccessToken", () => Promise.resolve("app_token_demo"));
        context.set("getGlobalEmotes", () => Promise.resolve(helixOk([{ id: "global-1", name: "globalwave" }])));
        context.set("getUserEmotes", () => { userCalls += 1; return Promise.resolve(helixOk([{ id: "channel-1", name: "channelwave" }])); });
        await next();
      });
      app.route("/api/channels/:channelId/modules/emote_slots", emoteSlotsRoutes);
      return app.request(`/api/channels/${encodeURIComponent(channelId)}/modules/emote_slots/emotes`, {}, { TWITCH_CLIENT_ID: "client_demo" });
    };
    const first = await request();
    const firstBody = await responseBody<{ emoji: { items: unknown[] }; twitch: { status: string; items: unknown[] } }>(first);
    scopes = ["user:read:emotes"];
    const second = await request();
    const secondBody = await responseBody<{ twitch: { status: string; items: unknown[] } }>(second);

    expect(first.status).toBe(200);
    expect(firstBody.emoji.items.length).toBeGreaterThan(0);
    expect(firstBody.twitch).toMatchObject({ status: "reconnect_required", items: [expect.objectContaining({ twitchId: "global-1" })] });
    expect(secondBody.twitch.status).toBe("ok");
    expect(secondBody.twitch.items).toHaveLength(2);
    expect(userCalls).toBe(1);
  });

  it(`keeps reconnect required separate from Helix failure and fetches user emotes after grant (${testCard("a missing user:read:emotes scope with failing global Helix stays reconnect_required and the next granted request fetches user emotes", "the first response says unavailable or its result is cached so the later request skips user emotes", "mutable credentials and Helix availability reproduce reconnect across two requests on the same channel")})`, async () => {
    const channelId = `slot-emotes-reconnect-helix-${crypto.randomUUID()}`;
    clearEmoteSlotEmoteCache(channelId);
    const scopes: string[] = [];
    let globalHelixAvailable = false;
    let userCalls = 0;
    const global = () => Promise.resolve(globalHelixAvailable
      ? helixOk([{ id: "global-1", name: "globalwave" }])
      : helixFail());
    const user = () => {
      userCalls += 1;
      return Promise.resolve(helixOk([{ id: "channel-1", name: "channelwave" }]));
    };

    const first = await emoteRoute({ channelId, scopes, global, user });
    const firstBody = await responseBody<{ twitch: { status: string; items: unknown[] } }>(first);
    scopes.push("user:read:emotes");
    globalHelixAvailable = true;
    const second = await emoteRoute({ channelId, scopes, global, user });
    const secondBody = await responseBody<{ twitch: { status: string; items: Array<{ twitchId?: string }> } }>(second);

    expect(firstBody.twitch.status).toBe("reconnect_required");
    expect(secondBody.twitch.status).toBe("ok");
    expect(secondBody.twitch.items.map(({ twitchId }) => twitchId)).toEqual(["global-1", "channel-1"]);
    expect(userCalls).toBe(1);
  });

  it(`does not cache an unavailable Helix response (${testCard("the same channel recovers to ok on its next request after Helix recovers", "a transient unavailable response remains cached and prevents the recovered Helix calls", "the route receives stable granted credentials while the Helix test capability changes outcome")})`, async () => {
    const channelId = `slot-emotes-unavailable-retry-${crypto.randomUUID()}`;
    clearEmoteSlotEmoteCache(channelId);
    let helixAvailable = false;
    let globalCalls = 0;
    let userCalls = 0;
    const global = () => {
      globalCalls += 1;
      return Promise.resolve(helixAvailable ? helixOk([{ id: "global-1", name: "globalwave" }]) : helixFail());
    };
    const user = () => {
      userCalls += 1;
      return Promise.resolve(helixAvailable ? helixOk([{ id: "channel-1", name: "channelwave" }]) : helixFail());
    };
    const first = await emoteRoute({ channelId, scopes: ["user:read:emotes"], global, user });
    const firstBody = await responseBody<{ twitch: { status: string } }>(first);
    helixAvailable = true;
    const second = await emoteRoute({ channelId, scopes: ["user:read:emotes"], global, user });
    const secondBody = await responseBody<{ twitch: { status: string; items: unknown[] } }>(second);

    expect(firstBody.twitch.status).toBe("unavailable");
    expect(secondBody.twitch.status).toBe("ok");
    expect(secondBody.twitch.items).toHaveLength(2);
    expect(globalCalls).toBe(2);
    expect(userCalls).toBe(2);
  });

  it(`returns emoji with unavailable Twitch status on Helix errors (${testCard("a Helix failure is represented as a 200 unavailable result with emoji still usable", "Helix failure escapes as a 5xx or removes the emoji group", "both Helix endpoints fail through mocked host capabilities")})`, async () => {
    const channelId = `slot-emotes-unavailable-${crypto.randomUUID()}`;
    clearEmoteSlotEmoteCache(channelId);
    const response = await emoteRoute({ channelId, scopes: ["user:read:emotes"], global: () => Promise.resolve(helixFail()), user: () => Promise.resolve(helixFail()) });
    const body = await responseBody<{ emoji: { items: unknown[] }; twitch: { status: string } }>(response);

    expect(response.status).toBe(200);
    expect(body.emoji.items.length).toBeGreaterThan(0);
    expect(body.twitch.status).toBe("unavailable");
  });
});
