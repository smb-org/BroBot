import { describe, expect, it, vi } from "vitest";

import type { ModuleAction, ModuleExecutionContext, ModuleEvent } from "../../src/modules/contract";
import { DEFAULT_POINTS_SETTINGS, pointsDefaultSettingsForLanguage, pointsSettingsSchema, type PointsSettings } from "../../src/modules/points/contracts";
import { localizedMonth, pointsBalanceReply, pointsTopReply, processPointsMessage } from "../../src/modules/points/service";
import { truncateChatTextWithAttributions } from "../../src/worker/chat";
import { appendPointWelcome, type PendingPointWelcome } from "../../src/worker/point-welcome";

const pointsOwner = { id: "points" };

const emptyDatabase = {
  prepare: () => ({ bind: () => ({ all: () => Promise.resolve({ results: [] }) }) }),
} as unknown as D1Database;

const messageEvent = (text: string, settings: PointsSettings = DEFAULT_POINTS_SETTINGS): ModuleEvent<PointsSettings> => ({
  channelId: "kanal_demo",
  subscriptionType: "channel.chat.message",
  triggerId: "message_demo",
  payload: {
    message_id: "message_demo",
    chatter_user_id: "viewer_demo",
    chatter_user_login: "nachtfalke",
    message: { text },
  },
  settings,
  receivedAt: "2026-10-19T12:00:00.000Z",
  eventSubTimestamp: "2026-10-19T12:00:00.000Z",
  actor: null,
  chatStatus: ["viewer"],
});

const makeContext = (overrides: Record<string, unknown> = {}) => {
  const calls: { activity: unknown[][]; touched: number } = { activity: [], touched: 0 };
  const points = {
    apply: vi.fn(),
    touchAccount: vi.fn(() => { calls.touched += 1; return Promise.resolve({ welcomePending: false, startBonus: null }); }),
    ackWelcome: vi.fn(() => Promise.resolve()),
    creditActivity: vi.fn((...args: unknown[]) => { calls.activity.push(args); return Promise.resolve({ credited: 5 }); }),
    balance: vi.fn(() => Promise.resolve(240)),
    listAccounts: vi.fn(),
    history: vi.fn(),
    summary: vi.fn(),
    ranking: vi.fn(() => Promise.resolve([
      { accountId: "viewer_demo", login: "pixelpilz", net: 1_420 },
      { accountId: "viewer_two", login: "nachtfalke", net: 880 },
      { accountId: "viewer_three", login: "kanal_demo", net: 410 },
    ])),
    rankOf: vi.fn(() => Promise.resolve({ rank: 4, net: 40 })),
    markAuditWritten: vi.fn(),
    pendingAudits: vi.fn(),
    claimCooldown: vi.fn(),
    rounds: {},
  };
  const context = {
    DB: emptyDatabase,
    points,
    streamState: vi.fn(() => Promise.resolve("online")),
    channelLanguage: vi.fn(() => Promise.resolve("de")),
    botUserId: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  } as unknown as ModuleExecutionContext;
  return { context, points, calls };
};

describe("points module", () => {
  it("validates localized defaults and bounded activity settings (protects=channel settings have stable bilingual defaults; fails_when=a language default or bounded value is malformed; no_claim=storage migration state is outside this schema test)", () => {
    expect(pointsSettingsSchema.parse(pointsDefaultSettingsForLanguage("de"))).toEqual({ ...DEFAULT_POINTS_SETTINGS, currencyName: "Punkte" });
    expect(pointsDefaultSettingsForLanguage("en").currencyName).toBe("Points");
    expect(pointsSettingsSchema.safeParse({ ...DEFAULT_POINTS_SETTINGS, windowMinutes: 0 }).success).toBe(false);
  });

  it("formats balance replies from current balance, monthly game net, and rank (protects=the balance command uses current account balance and monthly game placement; fails_when=the response reports an incorrect balance or rank; no_claim=DO ranking persistence is covered by worker ledger tests)", () => {
    expect(pointsBalanceReply({ balance: 240, currency: "Punkte", monthNet: 40, rank: 4, language: "de" }))
      .toBe("240 Punkte · diesen Monat +40 · Platz 4");
    expect(pointsBalanceReply({ balance: 240, currency: "Punkte", monthNet: 0, rank: null, language: "de" }))
      .toBe("240 Punkte · diesen Monat noch kein Spiel");
  });

  it("formats top replies from the current month's ranked entries (protects=!top uses point_monthly ranking and localized month labels; fails_when=entries are not rendered in rank order with signed net values; no_claim=the fake ranking result stands in for the DO response)", () => {
    expect(pointsTopReply({
      month: "2026-10",
      currency: "Punkte",
      language: "de",
      entries: [{ login: "pixelpilz", net: 1_420 }, { login: "nachtfalke", net: 880 }],
    })).toBe("Top im Oktober: 1. pixelpilz +1.420 · 2. nachtfalke +880 Punkte");
  });

  it("answers balance, leaderboard, and games commands through the point access contract (protects=chat commands use the #485 account, rank, and ranking APIs; fails_when=a command calls a different account or emits the wrong reply; no_claim=point access is mocked)", async () => {
    const { context, points } = makeContext();
    const currentMonth = new Date().toISOString().slice(0, 7);
    const balance = await processPointsMessage(messageEvent("!punkte"), context);
    const top = await processPointsMessage(messageEvent("!top"), context);
    const games = await processPointsMessage(messageEvent("!spiele"), context);

    expect(balance.actions[0]).toMatchObject({ kind: "chat", text: "240 Punkte · diesen Monat +40 · Platz 4", automated: false });
    expect(balance.actions[0]).toMatchObject({ replyToMessageId: "message_demo" });
    expect(top.actions[0]).toMatchObject({ kind: "chat", text: `Top im ${localizedMonth(currentMonth, "de")}: 1. pixelpilz +1.420 · 2. nachtfalke +880 · 3. kanal_demo +410 Punkte` });
    expect(games.actions[0]).toMatchObject({ kind: "chat", text: "Noch sind keine Spiele aktiv. · Startguthaben 100 Punkte · !punkte" });
    expect(points.balance).toHaveBeenCalledWith("viewer_demo");
    expect(points.ranking).toHaveBeenCalledWith(currentMonth, 3);
    expect(points.rankOf).toHaveBeenCalledWith("viewer_demo", currentMonth);
  });

  it("credits activity with the message timestamp, live state, and configured window rules (protects=the module passes event-time and UTC activity settings to the ledger; fails_when=an offline or differently-windowed event is credited incorrectly; no_claim=ledger atomicity is covered by worker tests)", async () => {
    const { context, calls } = makeContext();
    await processPointsMessage(messageEvent("hello"), context);
    expect(calls.touched).toBe(1);
    expect(calls.activity).toEqual([[
      "viewer_demo",
      "nachtfalke",
      Date.parse("2026-10-19T12:00:00.000Z"),
      true,
      { amount: 5, windowMinutes: 10, dailyCap: 150 },
    ]]);
  });

  it("appends the first-contact bonus to the next matching reply and acknowledges successful delivery (protects=welcome text is delivered once on the viewer's next bot reply; fails_when=another message gets the bonus or a failed send clears pending state; no_claim=the host send transport is represented by delivery callbacks)", async () => {
    const ackWelcome = vi.fn(() => Promise.resolve());
    const pending = {
      accountId: "viewer_demo",
      messageId: "message_demo",
      text: "Startguthaben 100 Punkte",
      access: { ackWelcome },
      deliveryClaimId: "claim_demo",
      used: false,
    };
    const unrelated: ModuleAction = { kind: "chat", text: "Other reply", replyToMessageId: "another_message" };
    const action: ModuleAction = { kind: "chat", text: "Command reply", replyToMessageId: "message_demo" };

    expect(appendPointWelcome(unrelated, pointsOwner, pending)).toBe(unrelated);
    const first = appendPointWelcome(action, pointsOwner, pending);
    expect(first).toMatchObject({ kind: "chat", text: "Command reply · Startguthaben 100 Punkte" });
    if (first.kind !== "chat") throw new Error("The expected welcome action was not a chat reply.");
    await first.onDelivery?.("rejected");
    expect(pending.used).toBe(false);
    expect(ackWelcome).not.toHaveBeenCalled();

    const retry = appendPointWelcome(action, pointsOwner, pending);
    if (retry.kind !== "chat") throw new Error("The retry welcome action was not a chat reply.");
    await retry.onDelivery?.("sent", "claim_demo");
    expect(ackWelcome).toHaveBeenCalledOnce();
    expect(ackWelcome).toHaveBeenCalledWith("viewer_demo", "claim_demo");
  });

  it("keeps the complete welcome note in a 500-character reply with its mention prefix and transport attribution (protects=welcome suffix, mention prefix and attribution survive chat truncation; fails_when=transport truncation removes part of the welcome or attribution; no_claim=the transport formatter is exercised directly without a chat send)", async () => {
    const ackWelcome = vi.fn(() => Promise.resolve());
    const pending: PendingPointWelcome = {
      accountId: "viewer_demo",
      messageId: "message_demo",
      text: "Initial balance 100 points",
      access: { ackWelcome },
      deliveryClaimId: "claim_demo",
      used: false,
    };
    const prefix = "@nachtfalke ";
    const action: ModuleAction = {
      kind: "chat",
      text: `${prefix}${"x".repeat(500 - prefix.length)}`,
      replyToMessageId: "message_demo",
    };
    const attributions = ["Source label"];
    const decorated = appendPointWelcome(action, pointsOwner, pending, attributions);
    if (decorated.kind !== "chat") throw new Error("The expected welcome action was not a chat reply.");
    const transported = truncateChatTextWithAttributions(decorated.text, attributions);

    expect(transported.text).toHaveLength(500);
    expect(transported.text.startsWith(prefix)).toBe(true);
    expect(transported.text.endsWith(" · Initial balance 100 points · Source label")).toBe(true);
    await decorated.onDelivery?.("sent", "claim_demo");
    expect(ackWelcome).toHaveBeenCalledOnce();
  });

  it("leaves an oversized welcome note pending when it cannot fit in the transport limit (protects=an unrenderable welcome remains eligible for a later reply; fails_when=the welcome is marked used despite not being appended; no_claim=delivery is not simulated because no action is emitted)", () => {
    const pending: PendingPointWelcome = {
      accountId: "viewer_demo",
      messageId: "message_demo",
      text: "x".repeat(500),
      access: { ackWelcome: vi.fn(() => Promise.resolve()) },
      used: false,
    };
    const action: ModuleAction = { kind: "chat", text: "Command reply", replyToMessageId: "message_demo" };
    expect(appendPointWelcome(action, pointsOwner, pending, ["Source label"])).toBe(action);
    expect(pending.used).toBe(false);
  });

  it("carries the welcome note only on points and game replies and keeps it pending after any other reply (protects=!befehle, text command and FAQ replies never show the start bonus; fails_when=a module without a points dependency gets the note or consumes the pending welcome; no_claim=chat delivery is not simulated)", async () => {
    const ackWelcome = vi.fn(() => Promise.resolve());
    const pending: PendingPointWelcome = {
      accountId: "viewer_demo",
      messageId: "message_demo",
      text: "Startguthaben 100 Punkte",
      access: { ackWelcome },
      deliveryClaimId: "claim_demo",
      used: false,
    };
    const reply: ModuleAction = { kind: "chat", text: "Befehle: !befehle, !hallo, !up", replyToMessageId: "message_demo" };

    for (const id of ["commands", "text_commands", "faq"]) {
      expect(appendPointWelcome(reply, { id }, pending)).toBe(reply);
      expect(pending.used).toBe(false);
    }

    const game = appendPointWelcome(reply, { id: "slot", requiresModules: ["points"] }, pending);
    expect(game).toMatchObject({ kind: "chat", text: "Befehle: !befehle, !hallo, !up · Startguthaben 100 Punkte" });
    expect(pending.used).toBe(true);
    // Once claimed, a second points reply must not repeat the note.
    expect(appendPointWelcome(reply, pointsOwner, pending)).toBe(reply);
    if (game.kind !== "chat") throw new Error("The expected game reply was not a chat reply.");
    await game.onDelivery?.("sent", "claim_demo");
    expect(ackWelcome).toHaveBeenCalledOnce();
  });
});
