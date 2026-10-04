import { describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { votekickModule } from "../../src/modules/votekick";
import { votekickSettingsSchema, type Votekick } from "../../src/modules/votekick/contracts";
import { votekickThreshold } from "../../src/modules/votekick/domain";
import { closeExpiredVotekick, processVotekickMessage } from "../../src/modules/votekick/service";
import type { VotekickRepository } from "../../src/modules/votekick/repository";
import { moduleScopePurpose } from "../../src/dashboard/module-labels";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const settings = votekickSettingsSchema.parse(votekickModule.defaultSettings);
const now = (): string => new Date().toISOString();

const eventFor = (text: string, chatStatus: ModuleEvent["chatStatus"] = ["vip"], sender = "starter-user"): ModuleEvent<typeof settings> => ({
  channelId: "channel-a",
  subscriptionType: "channel.chat.message",
  triggerId: "chat-message-1",
  payload: { message: { text }, chatter_user_id: sender },
  settings,
  receivedAt: now(),
  actor: null,
  chatStatus,
});

const runningVotekick = (overrides: Partial<Votekick> = {}): Votekick => ({
  id: "ballot-1",
  targetUserId: "sampleviewer-id",
  targetLogin: "sampleviewer",
  initiatorUserId: "starter-user",
  status: "running",
  threshold: 3,
  yesVotes: 2,
  noVotes: 0,
  ballotRevision: 1,
  durationSeconds: null,
  startedAt: now(),
  endsAt: new Date(Date.now() + 30_000).toISOString(),
  endedAt: null,
  liftedAt: null,
  ...overrides,
});

const repositoryFor = (overrides: Partial<VotekickRepository> = {}): VotekickRepository => ({
  admit: vi.fn(() => Promise.resolve("admitted" as const)),
  expireOverdue: vi.fn(() => Promise.resolve([])),
  byId: vi.fn(() => Promise.resolve(null)),
  running: vi.fn(() => Promise.resolve(null)),
  listRecent: vi.fn(() => Promise.resolve([])),
  updateCounts: vi.fn(() => Promise.resolve()),
  finish: vi.fn(() => Promise.resolve(true)),
  cancel: vi.fn(() => Promise.resolve(null)),
  markLifted: vi.fn(() => Promise.resolve(true)),
  ...overrides,
});

const contextFor = (overrides: Record<string, unknown> = {}): ModuleExecutionContext => {
  const ballots = {
    open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
    cast: vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [1, 0], revision: 1 })),
    read: vi.fn(() => Promise.resolve(null)),
    close: vi.fn(() => Promise.resolve({ counts: [3, 0], revision: 2 })),
    closeIfNetAtLeast: vi.fn(() => Promise.resolve({ status: "closed" as const, counts: [3, 0], revision: 4 })),
  };
  const context = {
    DB: {},
    ballots,
    botUserId: vi.fn(() => Promise.resolve("bot-user-id")),
    lookupUserByLogin: vi.fn((login: string) => Promise.resolve({ userId: "sampleviewer-id", login, displayName: "sampleviewer" })),
    isChannelModerator: vi.fn(() => Promise.resolve(false)),
    streamState: vi.fn(() => Promise.resolve("online" as const)),
    activeChatters: {
      count: vi.fn(() => Promise.resolve(20)),
      seen: vi.fn((userId: string) => Promise.resolve(userId === "sampleviewer-id"
        ? { firstSeenAt: now(), lastSeenAt: now() }
        : { firstSeenAt: new Date(Date.now() - 5_000).toISOString(), lastSeenAt: now() })),
    },
    renderTemplate: vi.fn((template: string, values: Readonly<Record<string, string | number>>) => Promise.resolve({
      text: template.replace(/\{([^{}]+)\}/gu, (_token, name: string) => String(values[name] ?? "")),
      diagnostics: [],
    })),
    scheduleAlarm: vi.fn(() => Promise.resolve()),
    clearAlarm: vi.fn(() => Promise.resolve()),
    secureRandomInteger: vi.fn(() => 0),
    channelLanguage: vi.fn(() => Promise.resolve("en" as const)),
    ...overrides,
  };
  return context as unknown as ModuleExecutionContext;
};

describe("Votekick module", () => {
  it("registers active chatter tracking, chat messages, and no overlay", () => {
    expect(votekickModule.broadcasterScopes).toEqual(["moderation:read"]);
    expect(votekickModule.needsActiveChatters).toBe(true);
    expect(votekickModule.eventSubTypes).toEqual(["channel.chat.message"]);
    expect(votekickModule.overlayElements).toBeUndefined();
  });

  it("localizes the moderator lookup scope", () => {
    expect(moduleScopePurpose("votekick", "moderation:read", "de")).toBe("Moderatoren vor Votekicks schützen");
    expect(moduleScopePurpose("votekick", "moderation:read", "en")).toBe("Protect moderators from votekicks");
  });

  it("registers Votekick templates as channel-variable usages and template-library sources", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'votekick', 1, ?)",
      ).bind("channel-a", JSON.stringify({ ...settings, startText: "Started {var.oldscore}", expiredText: "Expired {var.oldscore}" })).run();
      await database.prepare(
        "INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at) VALUES ('channel-a', 'oldscore', 2, ?, ?)",
      ).bind(now(), now()).run();

      const usages = await votekickModule.variableReferences?.usages(database as unknown as D1Database, "channel-a", "oldscore");
      const sources = await votekickModule.templateUsageSources?.(database as unknown as D1Database, "channel-a");
      expect(usages).toEqual([
        { moduleId: "votekick", itemName: "startText", kind: "template" },
        { moduleId: "votekick", itemName: "expiredText", kind: "template" },
      ]);
      expect(sources).toContainEqual(expect.objectContaining({ text: "Started {var.oldscore}", kind: "event", label: "votekick.startText" }));

      await database.prepare("UPDATE channel_variables SET name = 'newscore' WHERE channel_id = 'channel-a' AND name = 'oldscore'").run();
      const statements = votekickModule.variableReferences?.rename(database as unknown as D1Database, "channel-a", "oldscore", "newscore");
      if (statements === undefined) throw new Error("Votekick variable reference registration is missing.");
      await Promise.all(statements.map((statement) => statement.run()));
      const saved = await database.prepare("SELECT settings FROM channel_modules WHERE channel_id = 'channel-a' AND module_id = 'votekick'")
        .first<{ settings: string }>();
      expect(saved?.settings).toContain("{var.newscore}");
    } finally {
      database.close();
    }
  });

  it("uses the larger of the fixed net minimum and the rounded-up active-chat percentage", () => {
    expect(votekickThreshold(5, 20, 20)).toBe(5);
    expect(votekickThreshold(5, 20, 40)).toBe(8);
  });

  it("limits ballot starters to VIPs, moderators, and broadcasters", async () => {
    const context = contextFor();
    const result = await processVotekickMessage(eventFor("!votekick sampleviewer", ["subscriber"]), repositoryFor(), context);

    expect(result.diagnostics).toEqual([{ code: "votekick.rejected", detail: { reason: "starter_not_authorized" } }]);
    expect(context.lookupUserByLogin).not.toHaveBeenCalled();
  });

  it("protects moderators and fails closed when moderator lookup is unavailable", async () => {
    const context = contextFor({ isChannelModerator: vi.fn(() => Promise.resolve(true)) });
    const result = await processVotekickMessage(eventFor("!votekick sampleviewer"), repositoryFor(), context);

    expect(result.actions).toEqual([{ kind: "chat", text: "A votekick cannot be started for sampleviewer.", target: "source_only", automated: false }]);
    expect(result.diagnostics).toEqual([{ code: "votekick.rejected", detail: { reason: "target_protected", target: "sampleviewer-id" } }]);

    const failedLookup = contextFor({ isChannelModerator: vi.fn(() => Promise.resolve(null)) });
    const failed = await processVotekickMessage(eventFor("!votekick sampleviewer"), repositoryFor(), failedLookup);
    expect(failed.actions).toEqual([]);
    expect(failed.diagnostics[0]).toMatchObject({ code: "votekick.rejected", detail: { reason: "lookup_failure" } });
  });

  it("counts the starter's yes vote and uses the active chatter threshold", async () => {
    const admit = vi.fn(() => Promise.resolve("admitted" as const));
    const repository = repositoryFor({ admit });
    const context = contextFor({ activeChatters: {
      count: vi.fn(() => Promise.resolve(40)),
      seen: vi.fn((userId: string) => Promise.resolve(userId === "sampleviewer-id"
        ? { firstSeenAt: now(), lastSeenAt: now() }
        : { firstSeenAt: new Date(Date.now() - 5_000).toISOString(), lastSeenAt: now() })),
    } });
    const result = await processVotekickMessage(eventFor("!votekick sampleviewer"), repository, context);

    expect(context.ballots.open).toHaveBeenCalledWith(expect.any(String), 2, expect.any(Number));
    expect(context.ballots.cast).toHaveBeenCalledWith(expect.any(String), "starter-user", 1);
    expect(admit).toHaveBeenCalledWith("channel-a", expect.objectContaining({ threshold: 8, targetLogin: "sampleviewer", initiatorUserId: "starter-user", ballotRevision: 1 }), expect.any(String), settings.channelCooldownSeconds, settings.targetCooldownSeconds);
    expect(context.scheduleAlarm).toHaveBeenCalledWith("close", expect.stringMatching(/^close:/u), expect.any(Number));
    expect(result.actions).toEqual([{
      kind: "chat",
      text: "Votekick for sampleviewer is open. 1 = yes, 2 = no. Needed: 8 net yes votes.",
      target: "source_only",
      automated: false,
    }]);
  });

  it("runs a passing ballot through the host timeout action", async () => {
    const running = runningVotekick();
    const finish = vi.fn(() => Promise.resolve(true));
    const repository = repositoryFor({ running: vi.fn(() => Promise.resolve(running)), finish });
    const context = contextFor({
      clearAlarm: vi.fn(() => Promise.reject(new Error("alarm cleanup unavailable"))),
      ballots: {
        open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
        cast: vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [3, 0], revision: 3 })),
        read: vi.fn(() => Promise.resolve(null)),
        close: vi.fn(() => Promise.resolve({ counts: [3, 0], revision: 3 })),
        closeIfNetAtLeast: vi.fn(() => Promise.resolve({ status: "closed" as const, counts: [3, 0], revision: 4 })),
      },
    });
    const result = await processVotekickMessage(eventFor("1", ["viewer"], "voter-user"), repository, context);

    expect(finish).toHaveBeenCalledWith("channel-a", "ballot-1", "passed", 3, 0, 4, 120, expect.any(String));
    expect(context.clearAlarm).toHaveBeenCalledWith("close:ballot-1");
    expect(result.actions).toEqual([{
      kind: "timeout",
      userId: "sampleviewer-id",
      durationSeconds: 120,
      reason: "Votekick (3:0) · ballot-1",
      onSuccess: { kind: "chat", text: "Votekick passed: sampleviewer receives a 2 min timeout.", target: "source_only", automated: false },
      onFailure: { kind: "chat", text: "The timeout for sampleviewer could not be applied.", target: "source_only", automated: false },
    }]);
  });

  it("keeps voting open when the atomic close snapshot is below threshold", async () => {
    const running = runningVotekick();
    const finish = vi.fn(() => Promise.resolve(true));
    const updateCounts = vi.fn(() => Promise.resolve());
    const repository = repositoryFor({ running: vi.fn(() => Promise.resolve(running)), finish, updateCounts });
    const context = contextFor({
      ballots: {
        open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
        cast: vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [3, 0], revision: 3 })),
        read: vi.fn(() => Promise.resolve(null)),
        close: vi.fn(() => Promise.resolve({ counts: [1, 2], revision: 4 })),
        closeIfNetAtLeast: vi.fn(() => Promise.resolve({ status: "open" as const, counts: [1, 2], revision: 4 })),
      },
    });

    const result = await processVotekickMessage(eventFor("1", ["viewer"], "voter-user"), repository, context);

    expect(finish).not.toHaveBeenCalled();
    expect(updateCounts).toHaveBeenLastCalledWith("channel-a", "ballot-1", 1, 2, 4);
    expect(result.actions).toEqual([]);
    expect(context.clearAlarm).not.toHaveBeenCalled();
  });

  it("rejects voters who first appeared after the ballot started", async () => {
    const running = runningVotekick();
    const repository = repositoryFor({ running: vi.fn(() => Promise.resolve(running)) });
    const context = contextFor({ activeChatters: {
      count: vi.fn(() => Promise.resolve(20)),
      seen: vi.fn(() => Promise.resolve({ firstSeenAt: new Date(Date.parse(running.startedAt) + 1).toISOString(), lastSeenAt: now() })),
    } });

    await processVotekickMessage(eventFor("1", ["viewer"], "fresh-voter"), repository, context);

    expect(context.ballots.cast).not.toHaveBeenCalled();
  });

  it("prepares timeout language and templates before persisting a passed ballot", async () => {
    const finish = vi.fn(() => Promise.resolve(true));
    const repository = repositoryFor({ running: vi.fn(() => Promise.resolve(runningVotekick())), finish });
    const context = contextFor({
      ballots: {
        open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
        cast: vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [3, 0], revision: 3 })),
        read: vi.fn(() => Promise.resolve(null)),
        close: vi.fn(() => Promise.resolve(null)),
        closeIfNetAtLeast: vi.fn(() => Promise.resolve({ status: "closed" as const, counts: [3, 0], revision: 4 })),
      },
      channelLanguage: vi.fn(() => Promise.reject(new Error("language unavailable"))),
    });

    await expect(processVotekickMessage(eventFor("1", ["viewer"], "voter-user"), repository, context)).rejects.toThrow("language unavailable");

    expect(finish).not.toHaveBeenCalled();
    expect(context.clearAlarm).not.toHaveBeenCalled();
  });

  it("does not persist passed when timeout template rendering fails", async () => {
    const finish = vi.fn(() => Promise.resolve(true));
    const repository = repositoryFor({ running: vi.fn(() => Promise.resolve(runningVotekick())), finish });
    const renderTemplate = vi.fn(() => Promise.reject(new Error("template unavailable")));
    const context = contextFor({
      ballots: {
        open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
        cast: vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [3, 0], revision: 3 })),
        read: vi.fn(() => Promise.resolve(null)),
        close: vi.fn(() => Promise.resolve(null)),
        closeIfNetAtLeast: vi.fn(() => Promise.resolve({ status: "closed" as const, counts: [3, 0], revision: 4 })),
      },
      renderTemplate,
    });

    await expect(processVotekickMessage(eventFor("1", ["viewer"], "voter-user"), repository, context)).rejects.toThrow("template unavailable");

    expect(renderTemplate).toHaveBeenCalledTimes(2);
    expect(finish).not.toHaveBeenCalled();
  });

  it("does not admit a row when alarm setup fails, even if ballot cleanup is unavailable", async () => {
    const admit = vi.fn(() => Promise.resolve("admitted" as const));
    const repository = repositoryFor({ admit });
    const context = contextFor({ scheduleAlarm: vi.fn(() => Promise.reject(new Error("alarm unavailable"))) });

    const result = await processVotekickMessage(eventFor("!votekick sampleviewer"), repository, context);

    expect(admit).not.toHaveBeenCalled();
    expect(context.ballots.open).not.toHaveBeenCalled();
    expect(result.diagnostics).toContainEqual({ code: "votekick.rejected", detail: { reason: "lookup_failure" } });
  });

  it("rolls back an ambiguous admission before attempting failed ballot cleanup", async () => {
    const order: string[] = [];
    const repository = repositoryFor({
      admit: vi.fn(() => { order.push("admit"); return Promise.reject(new Error("D1 response lost")); }),
      finish: vi.fn(() => { order.push("finish"); return Promise.resolve(false); }),
    });
    const context = contextFor({ ballots: {
      open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
      cast: vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [1, 0], revision: 1 })),
      read: vi.fn(() => Promise.resolve(null)),
      close: vi.fn(() => { order.push("close"); return Promise.reject(new Error("DO unavailable")); }),
      closeIfNetAtLeast: vi.fn(() => Promise.resolve({ status: "not_open" as const, counts: [], revision: 0 })),
    } });

    const result = await processVotekickMessage(eventFor("!votekick sampleviewer"), repository, context);

    expect(order).toEqual(["admit", "finish", "close"]);
    expect(context.scheduleAlarm).toHaveBeenCalledWith("close", expect.stringMatching(/^close:/u), expect.any(Number));
    expect(context.clearAlarm).not.toHaveBeenCalled();
    expect(result.diagnostics).toContainEqual({ code: "votekick.rejected", detail: { reason: "lookup_failure" } });
  });

  it("finalizes overdue rows before processing a start attempt even when ballot cleanup fails", async () => {
    const overdue = runningVotekick({ endsAt: new Date(Date.now() - 1_000).toISOString() });
    const expireOverdue = vi.fn(() => Promise.resolve([overdue]));
    const context = contextFor({ ballots: {
      open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
      cast: vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [1, 0], revision: 1 })),
      read: vi.fn(() => Promise.resolve(null)),
      close: vi.fn(() => Promise.reject(new Error("DO unavailable"))),
      closeIfNetAtLeast: vi.fn(() => Promise.resolve({ status: "closed" as const, counts: [3, 0], revision: 4 })),
    } });
    const repository = repositoryFor({ expireOverdue });

    await processVotekickMessage(eventFor("!votekick sampleviewer", ["subscriber"]), repository, context);

    expect(expireOverdue).toHaveBeenCalledWith("channel-a", expect.any(String));
    expect(context.ballots.close).toHaveBeenCalledWith(overdue.id);
  });

  it("finalizes overdue rows before a numeric chat vote and never casts into an expired ballot", async () => {
    const order: string[] = [];
    const overdue = runningVotekick({ endsAt: new Date(Date.now() - 1_000).toISOString() });
    const expireOverdue = vi.fn(() => { order.push("expire"); return Promise.resolve([overdue]); });
    const running = vi.fn(() => { order.push("running"); return Promise.resolve(null); });
    const repository = repositoryFor({ expireOverdue, running });
    const context = contextFor({ ballots: {
      open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
      cast: vi.fn(() => Promise.resolve({ status: "not_open" as const, counts: [], revision: 0 })),
      read: vi.fn(() => Promise.resolve(null)),
      close: vi.fn(() => { order.push("close"); return Promise.reject(new Error("DO unavailable")); }),
      closeIfNetAtLeast: vi.fn(() => Promise.resolve({ status: "not_open" as const, counts: [], revision: 0 })),
    } });

    await processVotekickMessage(eventFor("1", ["viewer"], "voter-user"), repository, context);

    expect(order).toEqual(["expire", "close", "running"]);
    expect(context.ballots.cast).not.toHaveBeenCalled();
  });

  it("retries expiry delivery from the expired row with the same idempotency key", async () => {
    const expired = runningVotekick({ status: "expired", endedAt: new Date().toISOString() });
    const byId = vi.fn(() => Promise.resolve(expired));
    const repository = repositoryFor({
      byId,
    });
    const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>()
      .mockResolvedValueOnce({ sent: false, reason: "rate_limited", retryable: true })
      .mockResolvedValueOnce({ sent: true, reason: null, retryable: false });
    const db = { prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn(() => Promise.resolve({ settings: JSON.stringify(settings) })),
    })) };
    const context = {
      channelId: "channel-a",
      DB: db,
      ballots: { close: vi.fn(() => Promise.resolve(null)) },
      schedule: vi.fn(() => Promise.resolve()),
      clear: vi.fn(() => Promise.resolve()),
      renderTemplate: vi.fn((text: string) => Promise.resolve({ text, attributions: [] })),
      sendChat,
    } as unknown as ModuleAlarmContext;

    await expect(closeExpiredVotekick(context, "close:ballot-1", repository)).rejects.toThrow("rate_limited");
    await closeExpiredVotekick(context, "close:ballot-1", repository);

    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(sendChat.mock.calls.map(([text, key]) => [text, key])).toEqual([
      [settings.expiredText, "votekick:ballot-1:expired"],
      [settings.expiredText, "votekick:ballot-1:expired"],
    ]);
    expect(byId).toHaveBeenCalledTimes(2);
  });

  it("sends expiry from the committed row when alarm-time ballot cleanup fails", async () => {
    const expired = runningVotekick({ status: "expired", endedAt: new Date(Date.now() - 1_000).toISOString() });
    const byId = vi.fn(() => Promise.resolve(expired));
    const expireOverdue = vi.fn(() => Promise.resolve([expired]));
    const repository = repositoryFor({
      expireOverdue,
      byId,
    });
    const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(() => Promise.resolve({ sent: true, reason: null, retryable: false }));
    const closeBallot = vi.fn(() => Promise.reject(new Error("DO unavailable")));
    const db = { prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn(() => Promise.resolve({ settings: JSON.stringify(settings) })),
    })) };
    const context = {
      channelId: "channel-a",
      DB: db,
      ballots: { close: closeBallot },
      schedule: vi.fn(() => Promise.resolve()),
      clear: vi.fn(() => Promise.resolve()),
      renderTemplate: vi.fn((text: string) => Promise.resolve({ text })),
      sendChat,
    } as unknown as ModuleAlarmContext;

    await expect(closeExpiredVotekick(context, "close:ballot-1", repository)).resolves.toBeUndefined();

    expect(expireOverdue).toHaveBeenCalledOnce();
    expect(closeBallot).toHaveBeenCalledOnce();
    expect(sendChat).toHaveBeenCalledWith(settings.expiredText, "votekick:ballot-1:expired", undefined, expect.any(Function), settings.chatTarget);
  });
});
