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
import { eventText } from "../../src/dashboard/locale";
import { withOutputGate } from "../../src/worker/dry-run-output";
import { readOnlyD1 } from "../../src/worker/db/read-only";
import { insertChannel } from "./fixtures";
import { createReadInterleavingDatabase, TestD1Database } from "./test-d1";

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

const callReadOnlyExport = async <Result>(module: object, name: string, args: readonly unknown[]): Promise<Result> => {
  const method: unknown = Reflect.get(module, name);
  expect(method).toBeTypeOf("function");
  if (typeof method !== "function") throw new Error(`Expected ${name} to be available.`);
  return await Reflect.apply(method, undefined, args) as Result;
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

const insertOpenOptionsVote = async (
  database: TestD1Database,
  channelId: string,
  input: { id: string; title: string; labels: readonly string[] },
): Promise<void> => {
  await createChatVotingRepository(database as unknown as D1Database).insertOpen({
    id: input.id,
    channelId,
    kind: "options",
    optionCount: input.labels.length,
    labels: input.labels,
    title: input.title,
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
};

describe("chat voting and votekick dry-run parity", () => {
  it("requires the host ballot snapshot predicates instead of guessing their answers", async () => {
    const ballots = createDryRunBallotAccess({} as ModuleDryRunContext);

    await expect(ballots.readSnapshot?.("missing-provider")).rejects.toThrow("Dry-run ballot snapshots are unavailable.");
    await expect(ballots.hasOpenBallotSnapshot?.()).rejects.toThrow("Dry-run ballot snapshots are unavailable.");
  });

  it("does not treat an inactive pinned ballot snapshot as the channel lock", async () => {
    const ballots = createDryRunBallotAccess({
      ballots: {
        hasOpenBallotSnapshot: () => Promise.resolve(false),
        readSnapshot: () => Promise.resolve({
          counts: [0, 0],
          revision: 1,
          expiresAt: Date.now() + 60_000,
          isActive: false,
        }),
      },
    } as unknown as ModuleDryRunContext);
    await ballots.readSnapshot?.("inactive-ballot");

    await expect(ballots.hasOpenBallotSnapshot?.()).resolves.toBe(false);
  });

  it("checks the requested ballot id before simulating an open", async () => {
    const readSnapshot = vi.fn(() => Promise.resolve({
      counts: [0, 0],
      revision: 1,
      outcome: "expired" as const,
      isActive: false,
    }));
    const ballots = createDryRunBallotAccess({
      ballots: {
        hasOpenBallotSnapshot: () => Promise.resolve(false),
        readSnapshot,
      },
    } as unknown as ModuleDryRunContext);

    await expect(ballots.open("retained-ballot-id", 2, Date.now() + 60_000)).resolves.toEqual({
      status: "busy",
      moduleId: "active",
    });
    expect(readSnapshot).toHaveBeenCalledWith("retained-ballot-id", undefined);
  });

  it("does not accept a free-text cast on a numbered ballot snapshot", async () => {
    const ballots = createDryRunBallotAccess({
      ballots: {
        hasOpenBallotSnapshot: () => Promise.resolve(true),
        readSnapshot: () => Promise.resolve({
          counts: [0, 0],
          revision: 1,
          expiresAt: Date.now() + 60_000,
          isActive: true,
        }),
      },
    } as unknown as ModuleDryRunContext, { isBlockedFreeTextVote: () => false });

    await expect(ballots.castTerm?.("numbered-ballot", "voter", "cat"))
      .resolves.toMatchObject({ status: "not_open" });
  });

  it("filters blocked terms from the pinned free-text state", async () => {
    const ballots = createDryRunBallotAccess({
      ballots: {
        hasOpenBallotSnapshot: () => Promise.resolve(true),
        readSnapshot: () => Promise.resolve({
          counts: [],
          revision: 4,
          terms: [
            { term: "cat", count: 1, approved: true },
            { term: "dog", count: 2, approved: false },
          ],
          approvedTerms: ["cat"],
          blockedTerms: [],
          termFilterReady: true,
          expiresAt: Date.now() + 60_000,
          isActive: true,
        }),
      },
    } as unknown as ModuleDryRunContext, { isBlockedFreeTextVote: (term, blocked) => blocked.includes(term) });

    await expect(ballots.setBlockedTerms?.("free-text-poll", ["cat"])).resolves.toMatchObject({
      revision: 5,
      terms: [{ term: "dog", count: 2, approved: false }],
      blockedTerms: ["cat"],
      termFilterReady: true,
    });
  });

  it("does not refresh blocked terms for an inactive free-text ballot", async () => {
    const ballots = createDryRunBallotAccess({
      ballots: {
        hasOpenBallotSnapshot: () => Promise.resolve(false),
        readSnapshot: () => Promise.resolve({
          counts: [],
          revision: 1,
          terms: [{ term: "cat", count: 1, approved: false }],
          blockedTerms: [],
          termFilterReady: true,
          expiresAt: Date.now() + 60_000,
          isActive: false,
        }),
      },
    } as unknown as ModuleDryRunContext, { isBlockedFreeTextVote: (term, blocked) => blocked.includes(term) });

    await expect(ballots.setBlockedTerms?.("free-text-poll", ["cat"])).resolves.toBeNull();
  });

  it("simulates term approval from the pinned ballot and filter state", async () => {
    const ballots = createDryRunBallotAccess({
      ballots: {
        hasOpenBallotSnapshot: () => Promise.resolve(true),
        readSnapshot: () => Promise.resolve({
          counts: [],
          revision: 2,
          terms: [{ term: "cat", count: 2, approved: false }],
          approvedTerms: [],
          blockedTerms: [],
          termFilterReady: true,
          expiresAt: Date.now() + 60_000,
          isActive: true,
        }),
      },
    } as unknown as ModuleDryRunContext, { isBlockedFreeTextVote: (term, blocked) => blocked.includes(term) });

    await expect(ballots.approveTerm?.("free-text-poll", "cat")).resolves.toMatchObject({
      status: "approved",
      snapshot: {
        revision: 3,
        terms: [{ term: "cat", count: 2, approved: true }],
        approvedTerms: ["cat"],
      },
    });
  });

  it("allows term approval when the production filter exists but the display readiness flag is false", async () => {
    const ballots = createDryRunBallotAccess({
      ballots: {
        hasOpenBallotSnapshot: () => Promise.resolve(true),
        readSnapshot: () => Promise.resolve({
          counts: [],
          revision: 2,
          terms: [{ term: "cat", count: 2, approved: false }],
          approvedTerms: [],
          blockedTerms: [],
          termFilterReady: false,
          expiresAt: Date.now() + 60_000,
          isActive: true,
        }),
      },
    } as unknown as ModuleDryRunContext, { isBlockedFreeTextVote: (term, blocked) => blocked.includes(term) });

    await expect(ballots.approveTerm?.("free-text-poll", "cat")).resolves.toMatchObject({
      status: "approved",
      snapshot: { terms: [{ term: "cat", count: 2, approved: true }] },
    });
  });

  it("requires the production free-text blocking predicate when simulating a term cast", async () => {
    const ballots = createDryRunBallotAccess({
      ballots: {
        hasOpenBallotSnapshot: () => Promise.resolve(true),
        readSnapshot: () => Promise.resolve({
          counts: [],
          revision: 1,
          terms: [],
          blockedTerms: [],
          termFilterReady: true,
          expiresAt: Date.now() + 60_000,
          isActive: true,
        }),
      },
    } as unknown as ModuleDryRunContext);

    await expect(ballots.castTerm?.("free-text-poll", "voter", "cat"))
      .rejects.toThrow("Dry-run free-text vote predicate is unavailable.");
  });

  it("checks the production chat-vote alarm-close claim predicate", async () => {
    const database = new TestD1Database();
    const channelId = "dry-run-alarm-claim-channel";
    let closesAt = new Date(Date.now() + 60_000).toISOString();
    try {
      await seedOpenChatVote(database, channelId, closesAt);
      const peek = async (): Promise<boolean> => await callReadOnlyExport<boolean>(
        await import("../../src/modules/chat_voting/repository"),
        "peekChatVoteAlarmClose",
        [readOnlyD1(database as unknown as D1Database), channelId, "open-chat-vote", closesAt, new Date().toISOString()],
      );

      expect(await peek()).toBe(true);
      await database.prepare(
        "UPDATE chat_votes SET close_reason = 'timer' WHERE channel_id = ? AND poll_id = ?",
      ).bind(channelId, "open-chat-vote").run();
      expect(await peek()).toBe(false);
      closesAt = new Date(Date.now() - 1).toISOString();
      await database.prepare(
        "UPDATE chat_votes SET closes_at = ? WHERE channel_id = ? AND poll_id = ?",
      ).bind(closesAt, channelId, "open-chat-vote").run();
      expect(await peek()).toBe(true);
      await database.prepare(
        "UPDATE chat_votes SET closing_at = ? WHERE channel_id = ? AND poll_id = ?",
      ).bind(new Date().toISOString(), channelId, "open-chat-vote").run();
      expect(await peek()).toBe(false);
    } finally {
      database.close();
    }
  });

  it("checks the production chat-vote extension guard and module authorization", async () => {
    const database = new TestD1Database();
    const channelId = "dry-run-extension-claim-channel";
    const closesAt = new Date(Date.now() + 60_000).toISOString();
    try {
      await seedOpenChatVote(database, channelId, closesAt);
      await database.prepare(
        "UPDATE chat_votes SET close_reason = 'timer' WHERE channel_id = ? AND poll_id = ?",
      ).bind(channelId, "open-chat-vote").run();
      const check = async (authorization: { sql: string; values: readonly unknown[] }): Promise<boolean> =>
        await callReadOnlyExport<boolean>(
          await import("../../src/modules/chat_voting/repository"),
          "peekChatVoteExtension",
          [readOnlyD1(database as unknown as D1Database), channelId, "open-chat-vote", closesAt, authorization],
        );

      expect(await check({ sql: "AND 1 = 1", values: [] })).toBe(true);
      expect(await check({ sql: "AND 1 = 0", values: [] })).toBe(false);
      await database.prepare(
        "UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'chat_voting'",
      ).bind(channelId).run();
      expect(await check({ sql: "AND 1 = 1", values: [] })).toBe(false);
    } finally {
      database.close();
    }
  });

  it("checks the production chat-vote extension rollback revision predicate", async () => {
    const database = new TestD1Database();
    const channelId = "dry-run-extension-rollback-channel";
    const originalDeadline = new Date(Date.now() + 60_000).toISOString();
    const extendedDeadline = new Date(Date.now() + 90_000).toISOString();
    try {
      await seedOpenChatVote(database, channelId, originalDeadline);
      await database.prepare(
        "UPDATE chat_votes SET close_reason = 'timer', closes_at = ?, deadline_revision = 1 WHERE channel_id = ? AND poll_id = ?",
      ).bind(extendedDeadline, channelId, "open-chat-vote").run();
      const rollback = async (revision: number): Promise<boolean> => await callReadOnlyExport<boolean>(
        await import("../../src/modules/chat_voting/repository"),
        "peekChatVoteExtensionRollback",
        [readOnlyD1(database as unknown as D1Database), channelId, "open-chat-vote", extendedDeadline, revision, originalDeadline],
      );

      expect(await rollback(1)).toBe(true);
      expect(await rollback(0)).toBe(false);
      await database.prepare(
        "UPDATE chat_votes SET close_reason = 'manual' WHERE channel_id = ? AND poll_id = ?",
      ).bind(channelId, "open-chat-vote").run();
      expect(await rollback(1)).toBe(false);
    } finally {
      database.close();
    }
  });

  it("checks the production chat-vote open-row finish predicate", async () => {
    const database = new TestD1Database();
    const channelId = "dry-run-finish-vote-channel";
    try {
      await seedOpenChatVote(database, channelId, new Date(Date.now() + 60_000).toISOString());
      const finish = async (): Promise<boolean> => await callReadOnlyExport<boolean>(
        await import("../../src/modules/chat_voting/repository"),
        "peekChatVoteFinish",
        [readOnlyD1(database as unknown as D1Database), channelId, "open-chat-vote"],
      );

      expect(await finish()).toBe(true);
      await expect(createChatVotingRepository(database as unknown as D1Database).finish(
        channelId, "open-chat-vote", "manual", new Date().toISOString(), [0, 0], null, 0, null, false,
      )).resolves.toBe(true);
      expect(await finish()).toBe(false);
    } finally {
      database.close();
    }
  });

  it("checks the production result-delivery completion predicate", async () => {
    const database = new TestD1Database();
    const channelId = "dry-run-result-delivery-channel";
    try {
      await seedOpenChatVote(database, channelId, new Date(Date.now() + 60_000).toISOString());
      await expect(createChatVotingRepository(database as unknown as D1Database).finish(
        channelId, "open-chat-vote", "manual", new Date().toISOString(), [0, 0], null, 0, null, true,
      )).resolves.toBe(true);
      const complete = async (): Promise<boolean> => await callReadOnlyExport<boolean>(
        await import("../../src/modules/chat_voting/repository"),
        "peekChatVoteResultDelivery",
        [readOnlyD1(database as unknown as D1Database), channelId, "open-chat-vote"],
      );

      expect(await complete()).toBe(true);
      await database.prepare(
        "UPDATE chat_votes SET result_delivery_pending = 0 WHERE channel_id = ? AND poll_id = ?",
      ).bind(channelId, "open-chat-vote").run();
      expect(await complete()).toBe(false);
    } finally {
      database.close();
    }
  });

  it("checks the production running-row predicate before a dry-run finalization claim", async () => {
    const database = new TestD1Database();
    const channelId = "dry-run-finalize-predicate-channel";
    try {
      await seedRunningVotekick(database, channelId);
      const allowed = await callReadOnlyExport<boolean>(
        await import("../../src/modules/votekick/adapters/d1"),
        "peekVotekickFinalize",
        [readOnlyD1(database as unknown as D1Database), channelId, "running-votekick"],
      );
      await database.prepare(
        "UPDATE votekicks SET status = 'cancelled' WHERE channel_id = ? AND votekick_id = ?",
      ).bind(channelId, "running-votekick").run();
      const denied = await callReadOnlyExport<boolean>(
        await import("../../src/modules/votekick/adapters/d1"),
        "peekVotekickFinalize",
        [readOnlyD1(database as unknown as D1Database), channelId, "running-votekick"],
      );

      expect(allowed).toBe(true);
      expect(denied).toBe(false);
    } finally {
      database.close();
    }
  });

  it("checks the production finish predicate including the passed ballot revision guard", async () => {
    const database = new TestD1Database();
    const channelId = "dry-run-finish-predicate-channel";
    try {
      await seedRunningVotekick(database, channelId);
      const finish = async (status: string, revision: number | null): Promise<boolean> =>
        await callReadOnlyExport<boolean>(
          await import("../../src/modules/votekick/adapters/d1"),
          "peekVotekickFinish",
          [readOnlyD1(database as unknown as D1Database), channelId, "running-votekick", status, revision],
        );

      expect(await finish("passed", 1)).toBe(true);
      expect(await finish("passed", 0)).toBe(false);
      expect(await finish("failed", 0)).toBe(true);
      await database.prepare(
        "UPDATE votekicks SET status = 'cancelled' WHERE channel_id = ? AND votekick_id = ?",
      ).bind(channelId, "running-votekick").run();
      expect(await finish("failed", 1)).toBe(false);
    } finally {
      database.close();
    }
  });

  it("reads the production cancel predicate and cancelled row projection", async () => {
    const database = new TestD1Database();
    const channelId = "dry-run-cancel-predicate-channel";
    const endedAt = "2026-10-18T12:00:00.000Z";
    try {
      await seedRunningVotekick(database, channelId);
      const adapter = await import("../../src/modules/votekick/adapters/d1");
      const cancel = async (): Promise<{ status: string; endedAt: string } | null> =>
        await callReadOnlyExport(adapter, "peekVotekickCancel", [
          readOnlyD1(database as unknown as D1Database), channelId, "running-votekick", endedAt,
        ]);

      expect(await cancel()).toMatchObject({ status: "cancelled", endedAt });
      await database.prepare(
        "UPDATE votekicks SET status = 'cancelled' WHERE channel_id = ? AND votekick_id = ?",
      ).bind(channelId, "running-votekick").run();
      expect(await cancel()).toBeNull();
    } finally {
      database.close();
    }
  });

  it("checks the production mark-lifted predicate without changing the row", async () => {
    const database = new TestD1Database();
    const channelId = "dry-run-mark-lifted-channel";
    try {
      await seedRunningVotekick(database, channelId);
      await database.prepare(
        "UPDATE votekicks SET status = 'passed' WHERE channel_id = ? AND votekick_id = ?",
      ).bind(channelId, "running-votekick").run();
      const check = async (): Promise<boolean> => await callReadOnlyExport<boolean>(
        await import("../../src/modules/votekick/adapters/d1"),
        "peekVotekickMarkLifted",
        [readOnlyD1(database as unknown as D1Database), channelId, "running-votekick"],
      );

      expect(await check()).toBe(true);
      await database.prepare(
        "UPDATE votekicks SET lifted_at = ? WHERE channel_id = ? AND votekick_id = ?",
      ).bind(new Date().toISOString(), channelId, "running-votekick").run();
      expect(await check()).toBe(false);
      await database.prepare(
        "UPDATE votekicks SET lifted_at = NULL, target_user_id = NULL WHERE channel_id = ? AND votekick_id = ?",
      ).bind(channelId, "running-votekick").run();
      expect(await check()).toBe(false);
    } finally {
      database.close();
    }
  });

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

  it("does not finalize a pinned votekick row after it was replaced", async () => {
    const database = new TestD1Database();
    const channelId = "pinned-votekick-channel";
    try {
      await seedRunningVotekick(database, channelId);
      const prepare = vi.spyOn(database, "prepare");
      const interleavedDatabase = createReadInterleavingDatabase(
        database,
        (sql) => sql.includes("FROM votekicks WHERE channel_id = ? AND status = 'running' LIMIT 1"),
        async () => {
          await database.prepare(
            "UPDATE votekicks SET status = 'expired', ended_at = ? WHERE channel_id = ? AND votekick_id = ?",
          ).bind(new Date(Date.now() - 60 * 60_000).toISOString(), channelId, "running-votekick").run();
          const replacementRepository = createVotekickRepository(database as unknown as D1Database);
          const now = Date.now();
          expect(await replacementRepository.admit(channelId, {
            id: "replacement-votekick",
            targetUserId: "replacement-target-id",
            targetLogin: "replacement_viewer",
            initiatorUserId: "replacement-starter",
            threshold: 10,
            yesVotes: 0,
            ballotRevision: 1,
            startedAt: new Date(now - 30_000).toISOString(),
            endsAt: new Date(now + 60_000).toISOString(),
          }, new Date(now).toISOString(), 0, 0)).toBe("admitted");
        },
      );
      const event = { ...votekickEvent("1"), channelId };
      const context = {
        ...chatDryRunContext(database, {
          counts: [2, 0],
          revision: 1,
          expiresAt: Date.now() + 60_000,
          previousChoiceKnown: true,
        }),
        DB: readOnlyD1(interleavedDatabase),
      } as unknown as ModuleDryRunContext;

      const report = await dryRunVotekickMessage(event, context);
      const runningReads = prepare.mock.calls.filter(([sql]) =>
        sql.includes("FROM votekicks WHERE channel_id = ? AND status = 'running' LIMIT 1"));

      expect(runningReads).toHaveLength(1);
      expect(report[0]?.effects.some((effect) => effect.kind === "timeout")).toBe(false);
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

  it("restores a returning free-text term with its retained approval", async () => {
    const ballots = createDryRunBallotAccess({
      ballots: {
        hasOpenBallotSnapshot: () => Promise.resolve(false),
        readSnapshot: () => Promise.resolve({
          counts: [],
          revision: 3,
          terms: [{ term: "dog", count: 1, approved: false }],
          approvedTerms: ["cat"],
          expiresAt: Date.now() + 60_000,
          isActive: true,
        }),
      },
    } as unknown as ModuleDryRunContext, {
      voterId: "returning-voter",
      isBlockedFreeTextVote: (term, blockedTerms) => blockedTerms.includes(term),
    });

    const cast = await ballots.castTerm?.("free-text-poll", "returning-voter", "cat");
    expect(cast?.status).toBe("counted");
    expect(cast?.terms?.find(({ term }) => term === "cat")).toEqual({ term: "cat", count: 1, approved: true });
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

  it("marks a deferred votekick target as indeterminate until it is checked at send time", async () => {
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
        outcome: "indeterminate",
        blocks: [],
        effects: [],
        templateNotes: [{ code: "template.deferred_live", detail: { name: "votekick.target" } }],
      });
      const note = report[0]?.templateNotes[0];
      expect(note === undefined ? "" : eventText(note.code, note.detail ?? {}, "en"))
        .toBe("The target will be checked when the command is sent.");
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

  it("uses one pinned chat-vote row for evaluation and reporting during replacement", async () => {
    const database = new TestD1Database();
    const channelId = "pinned-chat-vote-channel";
    try {
      await insertChannel(database, channelId);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, '{}')",
      ).bind(channelId).run();
      await insertOpenOptionsVote(database, channelId, {
        id: "vote-a",
        title: "Vote A",
        labels: ["left", "right"],
      });
      const prepare = vi.spyOn(database, "prepare");
      const interleavedDatabase = createReadInterleavingDatabase(
        database,
        (sql) => sql.includes("FROM chat_votes WHERE channel_id = ? AND status = 'open' LIMIT 1"),
        async () => {
          await database.prepare("DELETE FROM chat_votes WHERE channel_id = ? AND poll_id = ?")
            .bind(channelId, "vote-a").run();
          await insertOpenOptionsVote(database, channelId, {
            id: "vote-b",
            title: "Vote B",
            labels: ["right", "left"],
          });
        },
      );
      const snapshot: ModuleDryRunBallotSnapshot = {
        counts: [0, 0],
        revision: 1,
        expiresAt: Date.now() + 60_000,
        previousChoiceKnown: true,
      };
      const readSnapshot = vi.fn((ballotId: string) => Promise.resolve(ballotId === "vote-a" ? snapshot : null));
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId,
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-pinned-chat-vote",
        payload: { message: { text: "left" }, chatter_user_id: "fictional-voter" },
        settings,
        receivedAt: new Date().toISOString(),
        actor: null,
        chatStatus: ["viewer"],
      };
      const report = await chatVotingModule.dryRunChatMessage?.(event, {
        ...chatDryRunContext(database),
        DB: readOnlyD1(interleavedDatabase),
        ballots: { readSnapshot, hasOpenBallotSnapshot: () => Promise.resolve(true) },
      });
      const openReads = prepare.mock.calls.filter(([sql]) =>
        sql.includes("FROM chat_votes WHERE channel_id = ? AND status = 'open' LIMIT 1"));
      const tally = report?.[0]?.effects.find((effect) => effect.kind === "ballot");

      expect(openReads).toHaveLength(1);
      expect(readSnapshot).toHaveBeenCalledExactlyOnceWith("vote-a", "fictional-voter");
      expect(tally).toMatchObject({ label: "Vote A", choice: "1", counts: [1, 0] });
    } finally {
      database.close();
    }
  });

  it("uses the production template revision guard when a selected template is deleted", async () => {
    const database = new TestD1Database();
    const channelId = "pinned-chat-vote-template-channel";
    try {
      await insertChannel(database, channelId);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, '{}')",
      ).bind(channelId).run();
      const now = new Date().toISOString();
      await database.prepare(
        `INSERT INTO chat_vote_templates
          (id, channel_id, shortcut, title, result_text, labels, free_text_mode, duration_seconds, revision,
           legacy_alias, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 3, NULL, NULL, ?, ?)`,
      ).bind("next-template", channelId, "next", "Next", "Result: {vote.result}", '["yes","no"]', now, now).run();
      const prepare = vi.spyOn(database, "prepare");
      const interleavedDatabase = createReadInterleavingDatabase(
        database,
        (sql) => sql.includes("FROM chat_vote_templates WHERE channel_id = ? AND shortcut = ? LIMIT 1"),
        async () => {
          await database.prepare("DELETE FROM chat_vote_templates WHERE channel_id = ? AND id = ?")
            .bind(channelId, "next-template").run();
        },
      );
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId,
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-deleted-chat-vote-template",
        payload: { message: { text: "!vote next" }, chatter_user_id: "fictional-mod" },
        settings,
        receivedAt: new Date().toISOString(),
        actor: null,
        chatStatus: ["moderator"],
      };
      const report = await chatVotingModule.dryRunChatMessage?.(event, {
        ...chatDryRunContext(database),
        DB: readOnlyD1(interleavedDatabase),
      });
      const templateLookups = prepare.mock.calls.filter(([sql]) =>
        sql.includes("FROM chat_vote_templates WHERE channel_id = ? AND shortcut = ? LIMIT 1"));

      expect(templateLookups).toHaveLength(1);
      expect(report?.[0]?.effects).not.toContainEqual(expect.objectContaining({ kind: "ballot", action: "start" }));
      expect(report?.[0]?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "A vote is already in progress." }));
    } finally {
      database.close();
    }
  });

  it("reports free-text overflow with stored terms and the incremented more tally", async () => {
    const database = new TestD1Database();
    const channelId = "free-text-overflow-channel";
    try {
      await insertChannel(database, channelId);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, '{}')",
      ).bind(channelId).run();
      await createChatVotingRepository(database as unknown as D1Database).insertOpen({
        id: "full-text-vote",
        channelId,
        kind: "free_text",
        optionCount: 0,
        labels: [],
        title: "Favorite word",
        resultText: "{vote.result}",
        textMode: "first_word",
        termFilterReady: true,
        openedAt: new Date(Date.now() - 30_000).toISOString(),
        closesAt: new Date(Date.now() + 60_000).toISOString(),
        requestedDurationSeconds: null,
        closeReason: "manual",
        textResults: null,
        moreTerms: null,
      });
      const terms = Array.from({ length: 200 }, (_value, index) => ({
        term: `term${String(index)}`,
        count: 1,
        approved: false,
      }));
      const readSnapshot = vi.fn((ballotId: string) => Promise.resolve(ballotId === "full-text-vote" ? {
        counts: [],
        revision: 4,
        terms,
        more: 7,
        expiresAt: Date.now() + 60_000,
        termFilterReady: true,
        blockedTerms: [],
        previousChoiceKnown: true,
      } : null));
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId,
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-free-text-overflow",
        payload: { message: { text: "newword" }, chatter_user_id: "fictional-voter" },
        settings,
        receivedAt: new Date().toISOString(),
        actor: null,
        chatStatus: ["viewer"],
      };
      const report = await chatVotingModule.dryRunChatMessage?.(event, {
        ...chatDryRunContext(database),
        ballots: { readSnapshot, hasOpenBallotSnapshot: () => Promise.resolve(true) },
      });
      const tally = report?.[0]?.effects.find((effect) => effect.kind === "ballot");

      expect(readSnapshot).toHaveBeenCalledExactlyOnceWith("full-text-vote", "fictional-voter");
      expect(tally).toMatchObject({ action: "overflow", terms, more: 8 });
      expect(tally).not.toHaveProperty("choice");
    } finally {
      database.close();
    }
  });

  it("uses the production close predicate when the module is disabled after the open-row read", async () => {
    const database = new TestD1Database();
    const channelId = "disabled-close-module-channel";
    try {
      await seedOpenChatVote(database, channelId, new Date(Date.now() + 60_000).toISOString());
      const interleavedDatabase = createReadInterleavingDatabase(
        database,
        (sql) => sql.includes("FROM chat_votes WHERE channel_id = ? AND status = 'open' LIMIT 1"),
        async () => {
          await database.prepare(
            "UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'chat_voting'",
          ).bind(channelId).run();
        },
      );
      const settings = chatVotingSettingsSchema.parse(DEFAULT_CHAT_VOTING_SETTINGS);
      const event: ModuleEvent<typeof settings> = {
        channelId,
        subscriptionType: "channel.chat.message",
        triggerId: "dry-run-disabled-chat-vote-close",
        payload: { message: { text: "!vote end" }, chatter_user_id: "fictional-mod" },
        settings,
        receivedAt: new Date().toISOString(),
        actor: null,
        chatStatus: ["moderator"],
      };
      const report = await chatVotingModule.dryRunChatMessage?.(event, {
        ...chatDryRunContext(database),
        DB: readOnlyD1(interleavedDatabase),
      });

      expect(report?.[0]?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "There is no vote in progress." }));
    } finally {
      database.close();
    }
  });
});
