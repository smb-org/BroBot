import { describe, expect, it, vi } from "vitest";

import type { ModuleDryRunBallotSnapshot, ModuleDryRunContext, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { chatVotingModule } from "../../src/modules/chat_voting";
import { DEFAULT_CHAT_VOTING_SETTINGS, chatVotingSettingsSchema } from "../../src/modules/chat_voting/contracts";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { processChatVotingMessage } from "../../src/modules/chat_voting/service";
import { votekickModule } from "../../src/modules/votekick";
import { votekickSettingsSchema, type VotekickSettings } from "../../src/modules/votekick/contracts";
import { createVotekickRepository } from "../../src/modules/votekick/adapters/d1";
import { processVotekickMessage } from "../../src/modules/votekick/service";
import { createDryRunBallotAccess } from "../../src/modules/domain/dry-run-ballots";
import { dryRunVotekickMessage } from "../../src/modules/votekick/dry-run";
import { withOutputGate } from "../../src/worker/dry-run-output";
import { readOnlyD1 } from "../../src/worker/db/read-only";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const chatDryRunContext = (
  database: TestD1Database,
  ballotSnapshot: ModuleDryRunBallotSnapshot | null = null,
  hasOpenBallot = false,
): ModuleDryRunContext => ({
  DB: readOnlyD1(database as unknown as D1Database),
  defaultChatTarget: "everyone",
  botUserId: () => Promise.resolve("bot-user"),
  streamState: () => Promise.resolve("online"),
  channelInfo: () => Promise.resolve({ title: "", gameName: "", gameId: "", startedAt: null, viewerCount: 0 }),
  channelGameId: () => Promise.resolve(null),
  channelLanguage: () => Promise.resolve("en"),
  channelTimeZone: () => Promise.resolve("UTC"),
  readChannelVariables: () => Promise.resolve([]),
  renderTemplate: (text: string, values: Readonly<Record<string, string | number>> = {}) => Promise.resolve({
    text: text.replace(/\{([^{}]+)\}/gu, (_match, name: string) => String(values[name] ?? "")),
    diagnostics: [],
  }),
  followedAt: () => Promise.resolve("unavailable"),
  userCreatedAt: () => Promise.resolve(null),
  secureRandomInteger: () => 0,
  ballots: {
    hasOpenBallotSnapshot: () => Promise.resolve(hasOpenBallot),
    readSnapshot: () => Promise.resolve(ballotSnapshot),
  },
  activeChatters: {
    count: () => Promise.resolve(20),
    seen: () => Promise.resolve({
      firstSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      lastSeenAt: new Date().toISOString(),
    }),
  },
  lookupUserByLogin: (login: string) => Promise.resolve({ userId: "target-id", login, displayName: login }),
  isChannelModerator: () => Promise.resolve(false),
} as unknown as ModuleDryRunContext);

const votekickEvent = (
  text: string,
  chatStatus: readonly ("viewer" | "subscriber" | "vip" | "moderator" | "broadcaster")[] = ["vip"],
): ModuleEvent<VotekickSettings> => ({
  channelId: "fictional-channel",
  subscriptionType: "channel.chat.message",
  triggerId: `dry-run-${text}`,
  payload: { message: { text }, chatter_user_id: "fictional-starter" },
  settings: votekickSettingsSchema.parse(votekickModule.defaultSettings),
  receivedAt: new Date().toISOString(),
  eventSubTimestamp: new Date().toISOString(),
  actor: null,
  chatStatus,
});

const seedRunningVotekick = async (database: TestD1Database, channelId: string): Promise<void> => {
  await insertChannel(database, channelId);
  const repository = createVotekickRepository(database as unknown as D1Database);
  const now = Date.now();
  const admission = await repository.admit(channelId, {
    id: "running-votekick",
    targetUserId: "target-id",
    targetLogin: "protected_viewer",
    initiatorUserId: "fictional-starter",
    threshold: 3,
    yesVotes: 0,
    ballotRevision: 1,
    startedAt: new Date(now - 2 * 60_000).toISOString(),
    endsAt: new Date(now + 60_000).toISOString(),
  }, new Date(now).toISOString(), 0, 0);
  expect(admission).toBe("admitted");
};

const seedOpenChatVote = async (database: TestD1Database, channelId: string, closesAt: string): Promise<void> => {
  await insertChannel(database, channelId);
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, '{}')",
  ).bind(channelId).run();
  await createChatVotingRepository(database as unknown as D1Database).insertOpen({
    id: "open-chat-vote",
    channelId,
    kind: "yes_no",
    optionCount: 2,
    labels: ["Yes", "No"],
    title: null,
    resultText: "{vote.result}",
    textMode: null,
    termFilterReady: null,
    openedAt: new Date(Date.now() - 30_000).toISOString(),
    closesAt,
    requestedDurationSeconds: null,
    closeReason: "manual",
    textResults: null,
    moreTerms: null,
  });
};

describe("chat voting and votekick dry-run parity", () => {
  it("preserves a voter's previous numbered ballot choice for duplicate, changed, and only-if-new casts", async () => {
    const database = new TestD1Database();
    try {
      const context = chatDryRunContext(database, {
        counts: [1, 0],
        revision: 7,
        expiresAt: Date.now() + 60_000,
        previousChoice: 1,
      });
      const ballots = createDryRunBallotAccess(context, { voterId: "voter-a" });

      await expect(ballots.cast("poll-1", "voter-a", 1)).resolves.toMatchObject({
        status: "unchanged",
        counts: [1, 0],
        revision: 7,
      });
      await expect(ballots.cast("poll-1", "voter-a", 2)).resolves.toMatchObject({
        status: "changed",
        counts: [0, 1],
        revision: 8,
      });
      await expect(ballots.cast("poll-1", "voter-a", 1, { onlyIfNew: true })).resolves.toMatchObject({
        status: "unchanged",
        counts: [0, 1],
        revision: 8,
      });
    } finally {
      database.close();
    }
  });

  it("does not fabricate a new vote when the sender identity cannot be checked", async () => {
    const database = new TestD1Database();
    const markUnresolved = vi.fn();
    try {
      const context = {
        ...chatDryRunContext(database, {
          counts: [1, 0],
          revision: 7,
          expiresAt: Date.now() + 60_000,
          previousChoiceKnown: false,
        }),
        markBallotChoiceUnresolved: markUnresolved,
      } as ModuleDryRunContext;
      const ballots = createDryRunBallotAccess(context, { voterId: "dry-run:viewer" });

      await expect(ballots.cast("poll-1", "dry-run:viewer", 1)).resolves.toMatchObject({
        status: "not_open",
        counts: [1, 0],
        revision: 7,
      });
      expect(markUnresolved).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("expires a loaded ballot at its snapshot deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
    const database = new TestD1Database();
    try {
      const context = chatDryRunContext(database, {
        counts: [2, 0],
        revision: 2,
        expiresAt: Date.parse("2026-10-18T12:00:01.000Z"),
      });
      const ballots = createDryRunBallotAccess(context);
      vi.setSystemTime(new Date("2026-10-18T12:00:02.000Z"));

      await expect(ballots.finalize("poll-1")).resolves.toMatchObject({ outcome: "expired", counts: [2, 0] });
      await expect(ballots.cast("poll-1", "voter-b", 1)).resolves.toMatchObject({ status: "not_open" });
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it("shares one votekick snapshot between simulation and reporting", async () => {
    const database = new TestD1Database();
    try {
      const channelId = "snapshot-votekick-channel";
      await seedRunningVotekick(database, channelId);
      let reads = 0;
      const event = { ...votekickEvent("1"), channelId, payload: { message: { text: "1" }, chatter_user_id: "fictional-voter" } };
      const context = {
        ...chatDryRunContext(database),
        ballots: {
          hasOpenBallotSnapshot: () => Promise.resolve(true),
          readSnapshot: () => {
            reads += 1;
            return Promise.resolve(reads === 1
              ? { counts: [0, 0], revision: 1, expiresAt: Date.now() + 60_000 }
              : { counts: [1, 0], revision: 2, expiresAt: Date.now() - 1, outcome: "expired" as const });
          },
        },
      } as unknown as ModuleDryRunContext;

      await dryRunVotekickMessage(event, context);

      expect(reads).toBe(1);
    } finally {
      database.close();
    }
  });

  it("reports an expired votekick ballot as finalized without counting the late message", async () => {
    const database = new TestD1Database();
    const channelId = "expired-votekick-report-channel";
    try {
      await seedRunningVotekick(database, channelId);
      const baseEvent = votekickEvent("1");
      const event = { ...baseEvent, channelId };
      const report = await dryRunVotekickMessage(event, chatDryRunContext(database, {
        counts: [2, 0],
        revision: 7,
        expiresAt: Date.now() - 1,
        isActive: true,
      }));

      expect(report[0]?.effects).toEqual([{
        kind: "ballot",
        moduleId: "votekick",
        action: "finalize",
        label: "protected_viewer",
        counts: [2, 0],
      }]);
    } finally {
      database.close();
    }
  });

  it("repeats the production closing reply while a manual close is pending", async () => {
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    const channelId = "closing-vote-channel";
    const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
    const event: ModuleEvent<typeof settings> = {
      channelId,
      subscriptionType: "channel.chat.message",
      triggerId: "dry-run-repeated-end",
      payload: { message: { text: "!vote end" }, chatter_user_id: "fictional-mod" },
      settings,
      receivedAt: new Date().toISOString(),
      actor: null,
      chatStatus: ["moderator"],
    };
    const insertClosingVote = async (database: TestD1Database): Promise<void> => {
      await insertChannel(database, channelId);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, '{}')",
      ).bind(channelId).run();
      const repository = createChatVotingRepository(database as unknown as D1Database);
      await repository.insertOpen({
        id: "manual-close-poll",
        channelId,
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        title: null,
        resultText: "{vote.result}",
        textMode: null,
        termFilterReady: null,
        openedAt: new Date(Date.now() - 30_000).toISOString(),
        closesAt: new Date(Date.now() + 60_000).toISOString(),
        requestedDurationSeconds: null,
        closeReason: "manual",
        textResults: null,
        moreTerms: null,
      });
      await database.prepare(
        "UPDATE chat_votes SET closing_at = ? WHERE channel_id = ? AND poll_id = ?",
      ).bind(new Date().toISOString(), channelId, "manual-close-poll").run();
    };
    try {
      await Promise.all([insertClosingVote(productionDatabase), insertClosingVote(dryRunDatabase)]);
      const execution = {
        DB: productionDatabase as unknown as D1Database,
        botUserId: () => Promise.resolve("bot-user"),
        channelLanguage: () => Promise.resolve("en"),
        ballots: {},
        scheduleAlarm: () => Promise.resolve(),
      } as unknown as ModuleExecutionContext;
      const production = await processChatVotingMessage(event, createChatVotingRepository(execution.DB), execution);
      const report = await chatVotingModule.dryRunChatMessage?.(event, chatDryRunContext(dryRunDatabase));

      expect(report?.[0]?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "The vote is closing." }));
      expect(production.actions).toContainEqual(expect.objectContaining({ kind: "chat", text: "The vote is closing." }));
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
    }
  });

  it("respects the unique open-vote D1 admission constraint when starting a vote", async () => {
    const database = new TestD1Database();
    try {
      const channelId = "open-vote-admission-channel";
      await insertChannel(database, channelId);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, '{}')",
      ).bind(channelId).run();
      await createChatVotingRepository(database as unknown as D1Database).insertOpen({
        id: "already-open-poll",
        channelId,
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        title: null,
        resultText: "{vote.result}",
        textMode: null,
        termFilterReady: null,
        openedAt: new Date(Date.now() - 30_000).toISOString(),
        closesAt: new Date(Date.now() + 60_000).toISOString(),
        requestedDurationSeconds: null,
        closeReason: "manual",
        textResults: null,
        moreTerms: null,
      });
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId,
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-second-start",
        payload: { message: { text: "!vote yesno Another vote?" }, chatter_user_id: "fictional-mod" },
        settings,
        receivedAt: new Date().toISOString(),
        actor: null,
        chatStatus: ["moderator"],
      };
      const report = await chatVotingModule.dryRunChatMessage?.(event, chatDryRunContext(database));

      expect(report?.[0]?.effects.some((effect) => effect.kind === "ballot" && effect.action === "start")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("is silent for a numeric message when the production service returns no actions", async () => {
    const database = new TestD1Database();
    try {
      const event = votekickEvent("1");

      await expect(dryRunVotekickMessage(event, chatDryRunContext(database))).resolves.toEqual([]);
    } finally {
      database.close();
    }
  });

  it("is silent when the production service ignores a duplicate ballot choice", async () => {
    const database = new TestD1Database();
    const channelId = "duplicate-chat-vote-channel";
    try {
      await seedOpenChatVote(database, channelId, new Date(Date.now() + 60_000).toISOString());
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId,
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-duplicate-vote",
        payload: { message: { text: "1" }, chatter_user_id: "voter-a" },
        settings,
        receivedAt: new Date().toISOString(),
        actor: null,
        chatStatus: ["viewer"],
      };
      const context = chatDryRunContext(database, {
        counts: [1, 0],
        revision: 3,
        expiresAt: Date.now() + 60_000,
        previousChoice: 1,
        previousChoiceKnown: true,
      });

      await expect(chatVotingModule.dryRunChatMessage?.(event, context)).resolves.toEqual([]);
    } finally {
      database.close();
    }
  });

  it("is silent when the production service ignores a vote past its deadline", async () => {
    const database = new TestD1Database();
    const channelId = "expired-chat-vote-channel";
    try {
      await seedOpenChatVote(database, channelId, new Date(Date.now() - 1_000).toISOString());
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId,
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-expired-vote",
        payload: { message: { text: "1" }, chatter_user_id: "voter-a" },
        settings,
        receivedAt: new Date().toISOString(),
        actor: null,
        chatStatus: ["viewer"],
      };
      const context = chatDryRunContext(database, {
        counts: [0, 0],
        revision: 0,
        expiresAt: Date.now() - 1,
        previousChoiceKnown: true,
      });

      await expect(chatVotingModule.dryRunChatMessage?.(event, context)).resolves.toEqual([]);
    } finally {
      database.close();
    }
  });

  it("preserves timeout ranges and success or failure conditions", async () => {
    const database = new TestD1Database();
    try {
      const channelId = "votekick-follow-up-channel";
      await seedRunningVotekick(database, channelId);
      const baseEvent = votekickEvent("ordinary chat");
      const event = {
        ...baseEvent,
        channelId,
        settings: votekickSettingsSchema.parse({
          ...baseEvent.settings,
          duration: { minSeconds: 60, maxSeconds: 300 },
        }),
      };
      const report = await dryRunVotekickMessage(event, chatDryRunContext(database, {
        counts: [3, 0],
        revision: 2,
        expiresAt: Date.now() + 60_000,
      }));

      expect(report[0]?.effects).toContainEqual(expect.objectContaining({
        kind: "timeout",
        minSeconds: 60,
        maxSeconds: 300,
      }));
      expect(report[0]?.effects.filter((effect) => effect.kind === "chat").map((effect) =>
        effect.kind === "chat" ? effect.when : undefined)).toEqual(["on_success", "on_failure"]);
    } finally {
      database.close();
    }
  });

  it("passes module attributions through shared host output preparation", async () => {
    const database = new TestD1Database();
    try {
      const event = votekickEvent("!votekick @protected_viewer");
      const context = {
        ...chatDryRunContext(database),
        renderTemplate: () => Promise.resolve({
          text: "Votekick start text",
          diagnostics: [],
          attributions: ["MET Norway"],
        }),
      } as unknown as ModuleDryRunContext;
      const report = await dryRunVotekickMessage(event, context);
      const result = report[0];
      if (result === undefined) throw new Error("Expected votekick dry-run result");
      const prepared = withOutputGate(result, votekickModule, event, event.channelId, false, false);

      expect(prepared.effects).toContainEqual(expect.objectContaining({
        kind: "chat",
        text: "Votekick start text · MET Norway",
      }));
    } finally {
      database.close();
    }
  });

  it("marks a target lookup as resolved at send time when no cached lookup is available", async () => {
    const database = new TestD1Database();
    try {
      const event = votekickEvent("!votekick @protected_viewer");
      const context = {
        ...chatDryRunContext(database),
        lookupUserByLogin: () => Promise.resolve(null),
        isUserLookupDeferred: () => true,
      } as unknown as ModuleDryRunContext;
      const report = await dryRunVotekickMessage(event, context);

      expect(report[0]).toMatchObject({
        outcome: "fires",
        blocks: [],
        effects: [],
        templateNotes: [{ code: "template.deferred_live", detail: { name: "votekick.target" } }],
      });
    } finally {
      database.close();
    }
  });

  it("uses the production chat-voting help reply for a moderator command", async () => {
    const database = new TestD1Database();
    try {
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId: "fictional-channel",
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-vote-help",
        payload: { message: { text: "!vote help" }, chatter_user_id: "fictional-mod" },
        settings,
        receivedAt: "2026-10-18T12:00:00.000Z",
        actor: null,
        chatStatus: ["moderator"],
      };
      const execution = {
        DB: database as unknown as D1Database,
        botUserId: () => Promise.resolve("bot-user"),
        channelLanguage: () => Promise.resolve("en"),
        ballots: {},
      } as unknown as ModuleExecutionContext;
      const production = await processChatVotingMessage(event, createChatVotingRepository(execution.DB), execution);
      const dryRun = chatVotingModule.dryRunChatMessage;

      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, {
        ...execution,
        DB: readOnlyD1(database as unknown as D1Database),
        defaultChatTarget: "everyone",
        ballots: {
          hasOpenBallotSnapshot: () => Promise.resolve(false),
          readSnapshot: () => Promise.resolve(null),
        },
      } as unknown as ModuleDryRunContext);

      expect(report[0]?.effects.flatMap((effect) => effect.kind === "chat" ? [{ kind: effect.kind, text: effect.text }] : [])).toEqual(
        production.actions.filter((action) => action.kind === "chat").map(({ kind, text }) => ({ kind, text })),
      );
    } finally {
      database.close();
    }
  });

  it("uses the production usage reply for an invalid chat-voting command", async () => {
    const database = new TestD1Database();
    try {
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId: "fictional-channel",
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-vote-usage",
        payload: { message: { text: "!vote unknown" }, chatter_user_id: "fictional-mod" },
        settings,
        receivedAt: "2026-10-18T12:00:00.000Z",
        actor: null,
        chatStatus: ["moderator"],
      };
      const production = await processChatVotingMessage(
        event,
        createChatVotingRepository(database as unknown as D1Database),
        {
          DB: database as unknown as D1Database,
          botUserId: () => Promise.resolve("bot-user"),
          channelLanguage: () => Promise.resolve("en"),
          ballots: {},
        } as unknown as ModuleExecutionContext,
      );
      const dryRun = chatVotingModule.dryRunChatMessage;

      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, chatDryRunContext(database));
      const productionText = production.actions.flatMap((action) => action.kind === "chat" ? [action.text] : []);
      const dryRunText = report[0]?.effects.flatMap((effect) => effect.kind === "chat" ? [effect.text] : []);

      expect(productionText).toHaveLength(1);
      expect(dryRunText).toEqual(productionText);
    } finally {
      database.close();
    }
  });

  it("reports starting a vote when the production service opens one", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('fictional-channel', 'chat_voting', 1, '{}')",
      ).run();
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId: "fictional-channel",
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-vote-start",
        payload: { message: { text: "!vote yesno Should this pass?" }, chatter_user_id: "fictional-mod" },
        settings,
        receivedAt: "2026-10-18T12:00:00.000Z",
        actor: null,
        chatStatus: ["moderator"],
      };
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const productionRepository = {
        ...repository,
        insertOpen: () => Promise.resolve("inserted" as const),
      };
      const production = await processChatVotingMessage(event, productionRepository, {
        DB: database as unknown as D1Database,
        ballots: { open: () => Promise.resolve({ status: "opened" as const }) },
        botUserId: () => Promise.resolve("bot-user"),
        channelLanguage: () => Promise.resolve("en"),
        scheduleAlarm: () => Promise.resolve(),
      } as unknown as ModuleExecutionContext);
      const dryRun = chatVotingModule.dryRunChatMessage;

      expect(production.actions).toContainEqual(expect.objectContaining({ kind: "overlay", type: "opened" }));
      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, chatDryRunContext(database));

      expect(report[0]?.effects).toContainEqual(expect.objectContaining({
        kind: "ballot",
        action: "start",
        moduleId: "chat_voting",
      }));
    } finally {
      database.close();
    }
  });

  it("stays silent when a viewer command has no production result", async () => {
    const database = new TestD1Database();
    try {
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId: "fictional-channel",
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-vote-denied",
        payload: { message: { text: "!vote help" }, chatter_user_id: "fictional-viewer" },
        settings,
        receivedAt: new Date().toISOString(),
        actor: null,
        chatStatus: ["viewer"],
      };
      const dryRun = chatVotingModule.dryRunChatMessage;

      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, chatDryRunContext(database));

      expect(report).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("stays silent when a chat-voting snapshot is missing", async () => {
    const database = new TestD1Database();
    try {
      const channelId = "fictional-channel";
      await insertChannel(database, channelId);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, '{}')",
      ).bind(channelId).run();
      const voteRepository = createChatVotingRepository(database as unknown as D1Database);
      await voteRepository.insertOpen({
        id: "poll-missing-ballot",
        channelId,
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        title: null,
        resultText: "{vote.result}",
        textMode: null,
        termFilterReady: null,
        openedAt: new Date(Date.now() - 30_000).toISOString(),
        closesAt: new Date(Date.now() + 60_000).toISOString(),
        requestedDurationSeconds: null,
        closeReason: "limit",
        textResults: null,
        moreTerms: null,
      });
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId,
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-vote-missing-ballot",
        payload: { message: { text: "1" }, chatter_user_id: "fictional-voter" },
        settings,
        receivedAt: new Date().toISOString(),
        actor: null,
        chatStatus: ["viewer"],
      };
      const production = await processChatVotingMessage(event, voteRepository, {
        DB: database as unknown as D1Database,
        ballots: { cast: () => Promise.resolve({ status: "not_open" as const, counts: [], revision: 0 }) },
        botUserId: () => Promise.resolve("bot-user"),
      } as unknown as ModuleExecutionContext);
      const dryRun = chatVotingModule.dryRunChatMessage;

      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, chatDryRunContext(database));

      expect(production.actions).toEqual([]);
      expect(report).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("reports the production tally after a numeric ballot message", async () => {
    const database = new TestD1Database();
    try {
      const now = Date.now();
      const channelId = "fictional-channel";
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      await database.prepare(
        "INSERT INTO channels (channel_id, login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(channelId, channelId, channelId, new Date(now).toISOString(), new Date(now).toISOString()).run();
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, '{}')",
      ).bind(channelId).run();
      const repository = createChatVotingRepository(database as unknown as D1Database);
      await repository.insertOpen({
        id: "poll-1",
        channelId,
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        title: null,
        resultText: "{vote.result}",
        textMode: null,
        termFilterReady: null,
        openedAt: new Date(now - 30_000).toISOString(),
        closesAt: new Date(now + 60_000).toISOString(),
        requestedDurationSeconds: null,
        closeReason: "limit",
        textResults: null,
        moreTerms: null,
      });
      const event: ModuleEvent<typeof settings> = {
        channelId,
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-vote-ballot",
        payload: { message: { text: "1" }, chatter_user_id: "fictional-voter" },
        settings,
        receivedAt: new Date(now).toISOString(),
        actor: null,
        chatStatus: ["viewer"],
      };
      const production = await processChatVotingMessage(event, repository, {
        DB: database as unknown as D1Database,
        ballots: { cast: () => Promise.resolve({ status: "counted" as const, counts: [1, 0], revision: 1 }) },
        botUserId: () => Promise.resolve("bot-user"),
      } as unknown as ModuleExecutionContext);
      const dryRun = chatVotingModule.dryRunChatMessage;

      expect(production.actions[0]).toMatchObject({ kind: "overlay", type: "tally", payload: { counts: [1, 0] } });
      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, chatDryRunContext(database, { counts: [0, 0], revision: 0 }));

      expect(report[0]?.effects).toContainEqual(expect.objectContaining({
        kind: "ballot",
        action: "count",
        moduleId: "chat_voting",
        counts: [1, 0],
        choice: "1",
      }));
    } finally {
      database.close();
    }
  });

  it("reports the production target-protection block and reply for a protected votekick target", async () => {
    const database = new TestD1Database();
    try {
      const settings = votekickSettingsSchema.parse(votekickModule.defaultSettings);
      const event: ModuleEvent<typeof settings> = {
        channelId: "fictional-channel",
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-votekick-protected",
        payload: { message: { text: "!votekick @protected_viewer" }, chatter_user_id: "fictional-starter" },
        settings,
        receivedAt: "2026-10-18T12:00:00.000Z",
        eventSubTimestamp: "2026-10-18T12:00:00.000Z",
        actor: null,
        chatStatus: ["vip"],
      };
      const execution = {
        DB: database as unknown as D1Database,
        ballots: {},
        botUserId: () => Promise.resolve("bot-user"),
        lookupUserByLogin: (login: string) => Promise.resolve({ userId: "protected-id", login, displayName: login }),
        isChannelModerator: () => Promise.resolve(true),
        activeChatters: { count: () => Promise.resolve(20), seen: () => Promise.resolve(null) },
        channelLanguage: () => Promise.resolve("en"),
        secureRandomInteger: () => 0,
        scheduleAlarm: () => Promise.resolve(),
        clearAlarm: () => Promise.resolve(),
        renderTemplate: (text: string) => Promise.resolve({ text, diagnostics: [] }),
      } as unknown as ModuleExecutionContext;
      const production = await processVotekickMessage(event, createVotekickRepository(execution.DB), execution);
      const dryRun = votekickModule.dryRunChatMessage;

      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, {
        ...execution,
        DB: readOnlyD1(database as unknown as D1Database),
        defaultChatTarget: "everyone",
        ballots: {
          hasOpenBallotSnapshot: () => Promise.resolve(false),
          readSnapshot: () => Promise.resolve(null),
        },
      } as unknown as ModuleDryRunContext);

      expect(production.diagnostics).toContainEqual({
        code: "votekick.rejected",
        detail: { reason: "target_protected", target: "protected-id" },
      });
      expect(report[0]).toMatchObject({
        outcome: "blocked",
        blocks: [{ code: "votekick.target_protected", detail: { target: "protected-id" } }],
      });
      const chatEffect = report[0]?.effects.find(({ kind }) => kind === "chat");
      expect(chatEffect?.kind === "chat" && chatEffect.text.length > 0).toBe(true);
      expect(chatEffect?.kind === "chat" ? chatEffect.text : undefined).toBe(
        production.actions.find((action) => action.kind === "chat")?.text,
      );
    } finally {
      database.close();
    }
  });

  it("reports the production permission block for an unauthorized votekick starter", async () => {
    const database = new TestD1Database();
    try {
      const event = votekickEvent("!votekick @protected_viewer", ["viewer"]);
      const production = await processVotekickMessage(event, createVotekickRepository(database as unknown as D1Database), {
        DB: database as unknown as D1Database,
        botUserId: () => Promise.resolve("bot-user"),
      } as unknown as ModuleExecutionContext);
      const dryRun = votekickModule.dryRunChatMessage;

      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, chatDryRunContext(database));

      expect(production.diagnostics).toContainEqual({
        code: "votekick.rejected",
        detail: { reason: "starter_not_authorized", minimumRole: "vip" },
      });
      expect(report[0]).toMatchObject({ outcome: "blocked", blocks: [{ code: "votekick.permission_denied" }], effects: [] });
    } finally {
      database.close();
    }
  });

  it("reports the production inactivity block for an inactive votekick target", async () => {
    const database = new TestD1Database();
    try {
      const event = votekickEvent("!votekick @inactive_viewer");
      const context = {
        DB: database as unknown as D1Database,
        botUserId: () => Promise.resolve("bot-user"),
        lookupUserByLogin: (login: string) => Promise.resolve({ userId: "inactive-id", login, displayName: login }),
        isChannelModerator: () => Promise.resolve(false),
        activeChatters: { seen: () => Promise.resolve(null) },
        channelLanguage: () => Promise.resolve("en"),
      } as unknown as ModuleExecutionContext;
      const production = await processVotekickMessage(event, createVotekickRepository(context.DB), context);
      const dryRun = votekickModule.dryRunChatMessage;

      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, {
        ...chatDryRunContext(database),
        lookupUserByLogin: (login: string) => Promise.resolve({ userId: "inactive-id", login, displayName: login }),
        activeChatters: { count: () => Promise.resolve(0), seen: () => Promise.resolve(null) },
      });

      expect(production.diagnostics).toContainEqual({
        code: "votekick.rejected",
        detail: { reason: "target_not_active", target: "inactive-id" },
      });
      expect(report[0]).toMatchObject({ outcome: "blocked", blocks: [{ code: "votekick.target_inactive", detail: { target: "inactive-id" } }] });
    } finally {
      database.close();
    }
  });

  it("reports a votekick start when the production service admits the target", async () => {
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    try {
      const channelId = "fictional-channel";
      await Promise.all([insertChannel(productionDatabase, channelId), insertChannel(dryRunDatabase, channelId)]);
      const event = votekickEvent("!votekick @protected_viewer");
      const productionContext = {
        DB: productionDatabase as unknown as D1Database,
        ballots: {
          open: () => Promise.resolve({ status: "opened" as const }),
          cast: () => Promise.resolve({ status: "counted" as const, counts: [1, 0], revision: 1 }),
        },
        botUserId: () => Promise.resolve("bot-user"),
        lookupUserByLogin: (login: string) => Promise.resolve({ userId: "target-id", login, displayName: login }),
        isChannelModerator: () => Promise.resolve(false),
        activeChatters: {
          count: () => Promise.resolve(20),
          seen: () => Promise.resolve({
            firstSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            lastSeenAt: new Date().toISOString(),
          }),
        },
        channelLanguage: () => Promise.resolve("en"),
        secureRandomInteger: () => 0,
        scheduleAlarm: () => Promise.resolve(),
        clearAlarm: () => Promise.resolve(),
        renderTemplate: (text: string, values: Readonly<Record<string, string | number>>) => Promise.resolve({
          text: text.replace(/\{([^{}]+)\}/gu, (_match, name: string) => String(values[name] ?? "")),
          diagnostics: [],
        }),
      } as unknown as ModuleExecutionContext;
      const production = await processVotekickMessage(event, createVotekickRepository(productionContext.DB), productionContext);
      const dryRun = votekickModule.dryRunChatMessage;

      expect(production.actions).toContainEqual(expect.objectContaining({ kind: "overlay", type: "opened" }));
      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, {
        ...chatDryRunContext(dryRunDatabase),
        DB: readOnlyD1(dryRunDatabase as unknown as D1Database),
      });

      expect(report[0]?.effects).toContainEqual(expect.objectContaining({
        kind: "ballot",
        moduleId: "votekick",
        action: "start",
        label: "protected_viewer",
        counts: [1, 0],
      }));
      const productionStartText = production.actions.find((action) => action.kind === "chat");
      const reportedStartText = report[0]?.effects.find((effect) => effect.kind === "chat");
      expect(reportedStartText?.kind === "chat" ? reportedStartText.text : undefined).toBe(
        productionStartText?.kind === "chat" ? productionStartText.text : undefined,
      );
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
    }
  });

  it("reports the production busy reply when a votekick is already running", async () => {
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    try {
      const channelId = "fictional-channel";
      await Promise.all([seedRunningVotekick(productionDatabase, channelId), seedRunningVotekick(dryRunDatabase, channelId)]);
      const event = { ...votekickEvent("!votekick @protected_viewer"), channelId };
      const activity = {
        firstSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
      const productionContext = {
        DB: productionDatabase as unknown as D1Database,
        ballots: {
          finalize: () => Promise.resolve({ outcome: "open" as const, counts: [0, 0], revision: 1 }),
          open: () => Promise.resolve({ status: "busy" as const }),
        },
        botUserId: () => Promise.resolve("bot-user"),
        lookupUserByLogin: (login: string) => Promise.resolve({ userId: "target-id", login, displayName: login }),
        isChannelModerator: () => Promise.resolve(false),
        activeChatters: { count: () => Promise.resolve(20), seen: () => Promise.resolve(activity) },
        channelLanguage: () => Promise.resolve("en"),
        secureRandomInteger: () => 0,
        scheduleAlarm: () => Promise.resolve(),
        clearAlarm: () => Promise.resolve(),
        renderTemplate: (text: string) => Promise.resolve({ text, diagnostics: [] }),
      } as unknown as ModuleExecutionContext;
      const production = await processVotekickMessage(event, createVotekickRepository(productionContext.DB), productionContext);
      const dryRun = votekickModule.dryRunChatMessage;

      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, chatDryRunContext(dryRunDatabase, { counts: [0, 0], revision: 1 }));
      const productionText = production.actions.flatMap((action) => action.kind === "chat" ? [action.text] : []);
      const dryRunText = report[0]?.effects.flatMap((effect) => effect.kind === "chat" ? [effect.text] : []);

      const rejection = production.diagnostics.find(({ code }) => code === "votekick.rejected");
      expect(rejection?.detail).toMatchObject({ reason: "busy" });
      expect(report[0]).toMatchObject({ outcome: "blocked", blocks: [{ code: "votekick.ballot_busy" }] });
      expect(dryRunText).toEqual(productionText);
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
    }
  });

  it("reports the production yes tally from a running votekick", async () => {
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    try {
      const channelId = "fictional-channel";
      await Promise.all([seedRunningVotekick(productionDatabase, channelId), seedRunningVotekick(dryRunDatabase, channelId)]);
      const event = { ...votekickEvent("1"), channelId, payload: { message: { text: "1" }, chatter_user_id: "fictional-voter" } };
      let finalizeCalls = 0;
      const productionContext = {
        DB: productionDatabase as unknown as D1Database,
        ballots: {
          finalize: () => {
            finalizeCalls += 1;
            return Promise.resolve({ outcome: "open" as const, counts: finalizeCalls === 1 ? [0, 0] : [1, 0], revision: finalizeCalls });
          },
          cast: () => Promise.resolve({ status: "counted" as const, counts: [1, 0], revision: 2 }),
        },
        botUserId: () => Promise.resolve("bot-user"),
        activeChatters: {
          count: () => Promise.resolve(20),
          seen: () => Promise.resolve({
            firstSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            lastSeenAt: new Date().toISOString(),
          }),
        },
        channelLanguage: () => Promise.resolve("en"),
      } as unknown as ModuleExecutionContext;
      const production = await processVotekickMessage(event, createVotekickRepository(productionContext.DB), productionContext);
      const dryRun = votekickModule.dryRunChatMessage;

      expect(production.actions).toContainEqual(expect.objectContaining({ kind: "overlay", type: "tally" }));
      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, chatDryRunContext(dryRunDatabase, { counts: [0, 0], revision: 1 }));

      expect(report[0]?.effects).toContainEqual(expect.objectContaining({
        kind: "ballot",
        moduleId: "votekick",
        action: "count",
        choice: "yes",
        counts: [1, 0],
      }));
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
    }
  });

  it("reports the production finalization when a chat message reaches a pass tally", async () => {
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    try {
      const channelId = "fictional-channel";
      await Promise.all([seedRunningVotekick(productionDatabase, channelId), seedRunningVotekick(dryRunDatabase, channelId)]);
      const event = { ...votekickEvent("ordinary chat"), channelId };
      const productionContext = {
        DB: productionDatabase as unknown as D1Database,
        ballots: {
          finalize: () => Promise.resolve({ outcome: "passed" as const, counts: [3, 0], revision: 2 }),
        },
        botUserId: () => Promise.resolve("bot-user"),
        channelLanguage: () => Promise.resolve("en"),
        secureRandomInteger: () => 0,
        renderTemplate: (text: string, values: Readonly<Record<string, string | number>>) => Promise.resolve({
          text: text.replace(/\{([^{}]+)\}/gu, (_match, name: string) => String(values[name] ?? "")),
          diagnostics: [],
        }),
      } as unknown as ModuleExecutionContext;
      const production = await processVotekickMessage(event, createVotekickRepository(productionContext.DB), productionContext);
      const dryRun = votekickModule.dryRunChatMessage;

      expect(production.actions).toContainEqual(expect.objectContaining({ kind: "timeout" }));
      expect(dryRun).toBeTypeOf("function");
      if (dryRun === undefined) return;
      const report = await dryRun(event, chatDryRunContext(dryRunDatabase, { counts: [3, 0], revision: 2, outcome: "passed" }));

      expect(report[0]?.effects).toContainEqual(expect.objectContaining({
        kind: "ballot",
        moduleId: "votekick",
        action: "finalize",
        counts: [3, 0],
      }));
      expect(report[0]?.effects.some(({ kind }) => kind === "timeout")).toBe(true);
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
    }
  });
});
