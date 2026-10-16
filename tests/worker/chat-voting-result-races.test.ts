import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BallotSnapshot, ModuleAlarmContext } from "../../src/modules/contract";
import type { ChatVoteDraft } from "../../src/modules/chat_voting/contracts";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { closeChatVoteFromAlarm } from "../../src/modules/chat_voting/service";
import { createTextBlockRepository } from "../../src/modules/text_library/adapters/d1";
import { createTextLibraryService } from "../../src/modules/text_library/service";
import { templateTextLength } from "../../src/contracts/template-text-length";

const migrationSources = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const migrationStatements = (source: string): string[] => {
  const segments = source
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*--.*$/u, ""))
    .join("\n")
    .split(";");
  const statements: string[] = [];
  let trigger: string[] | null = null;
  for (const segment of segments) {
    const statement = segment.trim();
    if (statement.length === 0) continue;
    if (trigger !== null) {
      if (statement.toUpperCase() === "END") {
        statements.push(`${trigger.join(";")};${statement}`);
        trigger = null;
      } else {
        trigger.push(statement);
      }
    } else if (/^CREATE\s+TRIGGER\b/iu.test(statement)) {
      trigger = [statement];
    } else {
      statements.push(statement);
    }
  }
  return statements;
};

const database = (env as unknown as { DB: D1Database }).DB;

const insertChannel = async (channelId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES (?, ?, ?, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z')`,
  ).bind(channelId, channelId, channelId).run();
};

const insertClosedPendingVote = async (channelId: string, pollId: string): Promise<void> => {
  await database.prepare(
    "INSERT OR IGNORE INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, '{}')",
  ).bind(channelId).run();
  const repository = createChatVotingRepository(database);
  await expect(repository.insertOpen({
    id: pollId,
    channelId,
    kind: "yes_no",
    optionCount: 2,
    labels: ["Yes", "No"],
    title: pollId,
    resultText: `Result for ${pollId}: {text.a}`,
    openedAt: "2026-10-16T09:00:00.000Z",
    closesAt: "2026-10-16T09:02:00.000Z",
    requestedDurationSeconds: 120,
    closeReason: "timer",
    status: "open",
  })).resolves.toBe(true);
  await expect(repository.finish(
    channelId,
    pollId,
    "timer",
    "2026-10-16T09:02:00.000Z",
    [1, 0],
    null,
    0,
    null,
    true,
  )).resolves.toBe(true);
  await database.prepare(
    "INSERT INTO chat_vote_result_delivery_reconciliation (channel_id, poll_id) VALUES (?, ?)",
  ).bind(channelId, pollId).run();
};

const channelObject = (channelId: string) => env.CHANNEL.get(env.CHANNEL.idFromName(channelId));

const pendingState = async (channelId: string): Promise<{
  candidates: string[];
  pending: Array<{ poll_id: string; result_delivery_pending: number }>;
}> => {
  const [candidateRows, voteRows] = await Promise.all([
    database.prepare(
      "SELECT poll_id FROM chat_vote_result_delivery_reconciliation WHERE channel_id = ? ORDER BY poll_id",
    ).bind(channelId).all<{ poll_id: string }>(),
    database.prepare(
      "SELECT poll_id, result_delivery_pending FROM chat_votes WHERE channel_id = ? ORDER BY poll_id",
    ).bind(channelId).all<{ poll_id: string; result_delivery_pending: number }>(),
  ]);
  return {
    candidates: candidateRows.results.map(({ poll_id }) => poll_id),
    pending: voteRows.results,
  };
};

beforeAll(async () => {
  for (const path of Object.keys(migrationSources).sort((left, right) => left.localeCompare(right))) {
    for (const statement of migrationStatements(migrationSources[path] ?? "")) {
      await database.prepare(statement).run();
    }
  }
});

describe("chat voting result races in the worker runtime", () => {
  it("clears migrated historical results that have no retained close alarm", async () => {
    const channelId = `vote-reconcile-complete-${crypto.randomUUID()}`;
    await insertChannel(channelId);
    await insertClosedPendingVote(channelId, "completed");
    const object = channelObject(channelId);
    await object.scheduleModuleAlarm(
      "chat_voting",
      "announce_start",
      "completed",
      Date.now() + 60 * 60_000,
    );

    await object.reconcileLegacyChatVoteResultDeliveries();

    await expect(pendingState(channelId)).resolves.toEqual({
      candidates: [],
      pending: [{ poll_id: "completed", result_delivery_pending: 0 }],
    });
  });

  it("keeps each migrated result with a retained chat voting close alarm pending", async () => {
    const channelId = `vote-reconcile-retries-${crypto.randomUUID()}`;
    await insertChannel(channelId);
    await insertClosedPendingVote(channelId, "completed");
    await insertClosedPendingVote(channelId, "retry-one");
    await insertClosedPendingVote(channelId, "retry-two");
    const object = channelObject(channelId);
    const future = Date.now() + 60 * 60_000;
    await object.scheduleModuleAlarm("chat_voting", "close", "retry-one", future);
    await object.scheduleModuleAlarm("chat_voting", "close", "retry-two", future + 1);

    await object.reconcileLegacyChatVoteResultDeliveries();

    await expect(pendingState(channelId)).resolves.toEqual({
      candidates: ["retry-one", "retry-two"],
      pending: [
        { poll_id: "completed", result_delivery_pending: 0 },
        { poll_id: "retry-one", result_delivery_pending: 1 },
        { poll_id: "retry-two", result_delivery_pending: 1 },
      ],
    });
  });

  it("does not re-mark a completed delivery when its retained alarm is reconciled", async () => {
    const channelId = `vote-reconcile-race-${crypto.randomUUID()}`;
    await insertChannel(channelId);
    await insertClosedPendingVote(channelId, "retry");
    const object = channelObject(channelId);
    await object.scheduleModuleAlarm("chat_voting", "close", "retry", Date.now() + 60 * 60_000);
    const repository = createChatVotingRepository(database);

    await expect(repository.completeResultDelivery(channelId, "retry")).resolves.toBe(true);
    await object.reconcileLegacyChatVoteResultDeliveries();

    await expect(pendingState(channelId)).resolves.toEqual({
      candidates: [],
      pending: [{ poll_id: "retry", result_delivery_pending: 0 }],
    });
  });

  it("suppresses a renamed result snapshot at send time and retries with the current template", async () => {
    const channelId = `vote-result-${crypto.randomUUID()}`;
    await insertChannel(channelId);
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, ?)",
    ).bind(channelId, JSON.stringify({ announceResult: true, resultText: "Result: {text.old}" })).run();
    const repository = createChatVotingRepository(database);
    const vote: ChatVoteDraft = {
      id: "poll",
      channelId,
      kind: "yes_no",
      optionCount: 2,
      labels: ["Yes", "No"],
      title: "Dinner",
      resultText: "Result: {text.old}",
      openedAt: "2026-10-16T09:00:00.000Z",
      closesAt: "2026-10-16T09:02:00.000Z",
      requestedDurationSeconds: 120,
      closeReason: "timer",
      status: "open",
    };
    await expect(repository.insertOpen(vote)).resolves.toBe(true);
    const stored = new Map<string, unknown>();
    const finalSnapshot = { counts: [7, 3], revision: 4 } satisfies BallotSnapshot;
    const announcements: string[] = [];
    let overlayRenamed = false;
    let renderCount = 0;
    const context = {
      DB: database,
      channelId,
      ballots: {
        open: vi.fn(),
        cast: vi.fn(),
        read: vi.fn(() => Promise.resolve(finalSnapshot)),
        close: vi.fn(() => Promise.resolve(finalSnapshot)),
        acknowledgeClosed: vi.fn(() => Promise.resolve()),
      },
      storage: {
        get: (key: string) => Promise.resolve(stored.get(key)),
        put: (key: string, value: unknown) => { stored.set(key, value); return Promise.resolve(); },
        delete: (key: string) => Promise.resolve(stored.delete(key)),
      },
      schedule: vi.fn(),
      clear: vi.fn(),
      publishModuleOverlayMessage: async () => {
        if (overlayRenamed) return;
        overlayRenamed = true;
        await database.prepare(
          "UPDATE chat_votes SET result_text = 'Result: {text.middle}' WHERE channel_id = ? AND poll_id = 'poll'",
        ).bind(channelId).run();
      },
      channelLanguage: () => Promise.resolve("en" as const),
      renderTemplate: async (text: string) => {
        renderCount += 1;
        if (renderCount === 1) {
          await database.prepare(
            "UPDATE chat_votes SET result_text = 'Result: {text.new}' WHERE channel_id = ? AND poll_id = 'poll'",
          ).bind(channelId).run();
        }
        return { text };
      },
      sendChat: async (
        text: string,
        _idempotencyKey: string,
        _attributions: readonly string[] | undefined,
        stillValid: (() => Promise<boolean>) | undefined,
      ) => {
        if (stillValid !== undefined && !await stillValid()) {
          return { sent: false, reason: "stale_before_send", retryable: false };
        }
        announcements.push(text);
        return { sent: true, reason: null, retryable: false };
      },
      chatActivityCount: () => Promise.resolve(0),
      resolveEventTimes: () => Promise.resolve([]),
      streamState: () => Promise.resolve("unknown" as const),
      streamStartedAt: () => Promise.resolve({ streamId: null, startedAt: null }),
    } as unknown as ModuleAlarmContext;

    await expect(closeChatVoteFromAlarm(context, repository, "poll"))
      .rejects.toThrow("changed before it could be sent");
    await expect(repository.byId(channelId, "poll")).resolves.toMatchObject({
      resultText: "Result: {text.new}",
      resultDeliveryPending: true,
    });

    await closeChatVoteFromAlarm(context, repository, "poll");

    expect(announcements).toEqual(["Result: {text.new}"]);
    await expect(repository.byId(channelId, "poll")).resolves.toMatchObject({ resultDeliveryPending: false });
  });

  it("invalidates a block rename when a vote result write follows its length preflight", async () => {
    const channelId = `vote-library-${crypto.randomUUID()}`;
    await insertChannel(channelId);
    const authorize = () => ({ sql: "AND 1 = 1", values: [] as const });
    const baseRepository = createTextBlockRepository(database, authorize);
    const service = createTextLibraryService(baseRepository);
    const initial = await service.list(channelId);
    const created = await service.create({
      channelId,
      name: "a",
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: ["Hello"] }],
      expectedGraphRevision: initial.settings.graphRevision,
      now: "2026-10-16T10:00:00.000Z",
    }, { userId: "manager", sessionId: "session" }, initial);
    if (!created.ok) throw new Error("Could not create the worker race block.");
    const snapshot = await service.list(channelId);
    const resultText = `${"x".repeat(497)}{text.a}`;
    const renamedBlock = "b".repeat(32);
    expect(templateTextLength(resultText)).toBe(500);
    expect(templateTextLength(resultText.replaceAll("{text.a}", `{text.${renamedBlock}}`))).toBe(531);
    let inserted = false;
    const interleavedDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!inserted) {
          inserted = true;
          await database.prepare(
            `INSERT INTO chat_vote_templates
              (id, channel_id, shortcut, title, result_text, labels, free_text_mode, duration_seconds,
               revision, legacy_alias, last_used_at, created_at, updated_at)
             VALUES ('concurrent-result', ?, NULL, 'Concurrent result', ?, '["Yes","No"]', NULL, 120,
               1, NULL, NULL, '2026-10-16T10:00:01.000Z', '2026-10-16T10:00:01.000Z')`,
          ).bind(channelId, resultText).run();
        }
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const interleavedRepository = createTextBlockRepository(interleavedDatabase, authorize);

    const result = await interleavedRepository.rename({
      channelId,
      name: renamedBlock,
      categoryId: created.block.categoryId,
      games: [],
      variants: [{ id: "default", conditions: {}, texts: ["Hello"] }],
      expectedRevision: created.block.revision,
      expectedGraphRevision: snapshot.settings.graphRevision,
      now: "2026-10-16T10:00:02.000Z",
    }, "a", { userId: "manager", sessionId: "session" });

    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    await expect(baseRepository.find(channelId, "a")).resolves.toMatchObject({ name: "a" });
    await expect(baseRepository.find(channelId, renamedBlock)).resolves.toBeNull();
    await expect(database.prepare(
      "SELECT result_text FROM chat_vote_templates WHERE channel_id = ? AND id = 'concurrent-result'",
    ).bind(channelId).first()).resolves.toEqual({ result_text: resultText });
  });
});
