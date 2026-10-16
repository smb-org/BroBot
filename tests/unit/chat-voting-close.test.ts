import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BallotSnapshot, ModuleAlarmContext, ModuleEvent, ModuleOverlayElementContext } from "../../src/modules/contract";
import { chatVotingModule } from "../../src/modules/chat_voting";
import { createTemplateRenderer } from "../../src/worker/template-resolver";
import { prepareModuleOverlayRealtimeMessage } from "../../src/worker/module-overlay-realtime";
import type { ChatVoteDraft } from "../../src/modules/chat_voting/contracts";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { announceChatVoteStartFromAlarm, closeChatVoteFromAlarm, requestChatVoteClose, requestChatVoteExtension } from "../../src/modules/chat_voting/service";
import { findChatVoteResultTextReferences } from "../../src/modules/contracts/chat-vote-result-text-references";
import { insertChannel } from "./fixtures";
import { createReadBarrierDatabase, TestD1Database } from "./test-d1";

const snapshot = { counts: [7, 3], revision: 4 } as const;

describe("chat voting close service", () => {
  let database: TestD1Database;

  beforeEach(() => { database = new TestD1Database(); });
  afterEach(() => { database.close(); });

  const seedOpenVote = async (announceResult: boolean, title: string | null = null, resultText?: string, startText?: string): Promise<ReturnType<typeof createChatVotingRepository>> => {
    await insertChannel(database, "fictional-channel");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, ?)",
    ).bind("fictional-channel", JSON.stringify({ announceResult, ...(resultText === undefined ? {} : { resultText }), ...(startText === undefined ? {} : { startText }) })).run();
    const repository = createChatVotingRepository(database as unknown as D1Database);
    const vote: ChatVoteDraft = {
      id: "fictional-poll",
      channelId: "fictional-channel",
      kind: "yes_no",
      optionCount: 2,
      labels: ["Yes", "No"],
      title,
      openedAt: "2026-10-04T10:00:00.000Z",
      closesAt: "2026-10-04T14:00:00.000Z",
      requestedDurationSeconds: null,
      closeReason: "limit",
      status: "open",
      ...(resultText === undefined ? {} : { resultText }),
    };
    await repository.insertOpen(vote);
    return repository;
  };

  const createAlarmContext = (
    order: string[],
    overrides: {
      put?: (key: string, value: unknown) => Promise<void>;
      schedule?: ModuleAlarmContext["schedule"];
      sendChat?: (...args: Parameters<ModuleAlarmContext["sendChat"]>) => Promise<{ sent: boolean; reason: string | null; retryable: boolean }>;
      renderTemplate?: ModuleAlarmContext["renderTemplate"];
    } = {},
  ) => {
    const values = new Map<string, unknown>();
    const put = overrides.put ?? ((key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    });
    const read = vi.fn<() => Promise<BallotSnapshot | null>>(() => { order.push("read"); return Promise.resolve(snapshot); });
    const close = vi.fn<() => Promise<BallotSnapshot | null>>(() => { order.push("close"); return Promise.resolve(snapshot); });
    const publishModuleOverlayMessage = vi.fn<ModuleAlarmContext["publishModuleOverlayMessage"]>(
      () => { order.push("overlay"); return Promise.resolve(); },
    );
    const sendChat = vi.fn(overrides.sendChat ?? (() => Promise.resolve({ sent: true, reason: null, retryable: false })));
    const writeDiagnostics = vi.fn<NonNullable<ModuleAlarmContext["writeDiagnostics"]>>(() => Promise.resolve());
    const storagePut = vi.fn((key: string, value: unknown) => {
      order.push("put");
      return put(key, value);
    });
    const context = {
      DB: database as unknown as D1Database,
      channelId: "fictional-channel",
      ballots: {
        open: vi.fn(),
        cast: vi.fn(),
        read,
        close,
      },
      storage: {
        get: vi.fn((key: string) => Promise.resolve(values.get(key))),
        put: storagePut,
        delete: vi.fn((key: string) => Promise.resolve(values.delete(key))),
      },
      schedule: overrides.schedule ?? vi.fn(),
      clear: vi.fn(),
      renderTemplate: overrides.renderTemplate ?? vi.fn(() => Promise.resolve({ text: "Yes: 7 (70%) · No: 3 (30%)" })),
      publishModuleOverlayMessage,
      sendChat: vi.fn((...args: Parameters<ModuleAlarmContext["sendChat"]>) => {
        order.push("chat");
        return sendChat(...args);
      }),
      chatActivityCount: vi.fn(() => Promise.resolve(0)),
      resolveEventTimes: vi.fn(() => Promise.resolve([])),
      streamState: vi.fn(() => Promise.resolve("unknown" as const)),
      streamStartedAt: vi.fn(() => Promise.resolve({ streamId: null, startedAt: null })),
      channelLanguage: vi.fn(() => Promise.resolve("en" as const)),
      writeDiagnostics,
    } as unknown as ModuleAlarmContext;
    return { context, values, close, read, publishModuleOverlayMessage, sendChat, storagePut, writeDiagnostics };
  };

  it("coalesces concurrent manual-close requests onto the same alarm key", async () => {
    await seedOpenVote(false);
    const traced = createReadBarrierDatabase(
      database,
      (sql, operation) => operation === "first" && sql.includes("status = 'open'") ? "open-vote" : null,
      2,
    );
    const repository = createChatVotingRepository(traced.database);
    const scheduleClose = vi.fn<(pollId: string, deadline: number, revision: number) => Promise<void>>(() => Promise.resolve());

    const [first, second] = await Promise.all([
      requestChatVoteClose(repository, "fictional-channel", scheduleClose),
      requestChatVoteClose(repository, "fictional-channel", scheduleClose),
    ]);

    expect(traced.started).toEqual(["open-vote", "open-vote"]);
    expect([first, second].filter((result) => result !== null)).toHaveLength(2);
    expect(scheduleClose).toHaveBeenCalledTimes(2);
    for (const [pollId, deadline, revision] of scheduleClose.mock.calls) {
      expect(pollId).toBe("fictional-poll");
      expect(deadline).toEqual(expect.any(Number));
      expect(revision).toBeGreaterThanOrEqual(1);
    }
    await expect(repository.open("fictional-channel")).resolves.toMatchObject({
      id: "fictional-poll",
      status: "closing",
      closeReason: "manual",
    });
  });

  it("rearms an early alarm from the persisted deadline and deadline revision", async () => {
    const repository = await seedOpenVote(false);
    const closesAt = new Date(Date.now() + 60_000).toISOString();
    await database.prepare("UPDATE chat_votes SET closes_at = ?, deadline_revision = 4 WHERE channel_id = ? AND poll_id = ?")
      .bind(closesAt, "fictional-channel", "fictional-poll").run();
    const order: string[] = [];
    const { context, close } = createAlarmContext(order);

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(context.schedule).toHaveBeenCalledWith("fictional-poll", Date.parse(closesAt), 4);
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps a closed vote in result references while its alarm retries delivery beside a newer open vote", async () => {
    const repository = await seedOpenVote(true, "First dinner", "First result: {var.score}");
    const firstOrder: string[] = [];
    const failedDelivery = createAlarmContext(firstOrder, {
      sendChat: () => Promise.resolve({ sent: false, reason: "output_limit", retryable: true }),
    });

    await expect(closeChatVoteFromAlarm(failedDelivery.context, repository, "fictional-poll"))
      .rejects.toThrow("waiting for the automated output limit");
    await expect(repository.byId("fictional-channel", "fictional-poll")).resolves.toMatchObject({
      status: "closed",
      resultDeliveryPending: true,
    });

    await repository.insertOpen({
      id: "later-poll",
      channelId: "fictional-channel",
      kind: "yes_no",
      optionCount: 2,
      labels: ["Yes", "No"],
      title: "Later dinner",
      resultText: "Later result: {var.points}",
      openedAt: "2026-10-16T10:00:00.000Z",
      closesAt: "2026-10-16T10:02:00.000Z",
      requestedDurationSeconds: 120,
      closeReason: "timer",
      status: "open",
    });

    const references = await findChatVoteResultTextReferences(database as unknown as D1Database, "fictional-channel");
    expect(references.map(({ source_id }) => source_id)).toEqual(["later-poll", "fictional-poll"]);
    expect(references.find(({ source_id }) => source_id === "fictional-poll")).toMatchObject({
      source_kind: "pending_vote",
      result_text: "First result: {var.score}",
    });

    const successfulRetry = createAlarmContext([], {
      sendChat: () => Promise.resolve({ sent: true, reason: null, retryable: false }),
    });
    await closeChatVoteFromAlarm(successfulRetry.context, repository, "fictional-poll");
    await expect(repository.byId("fictional-channel", "fictional-poll")).resolves.toMatchObject({
      status: "closed",
      resultDeliveryPending: false,
    });
    await expect(findChatVoteResultTextReferences(database as unknown as D1Database, "fictional-channel"))
      .resolves.toHaveLength(1);
  });

  it("throws when a lost alarm claim cannot reread a concurrent manual close", async () => {
    const repository = await seedOpenVote(false);
    const closesAt = new Date(Date.now() - 1_000).toISOString();
    await database.prepare("UPDATE chat_votes SET closes_at = ? WHERE channel_id = ? AND poll_id = ?")
      .bind(closesAt, "fictional-channel", "fictional-poll").run();
    const originalById = repository.byId.bind(repository);
    vi.spyOn(repository, "byId")
      .mockImplementationOnce((channelId, pollId) => originalById(channelId, pollId))
      .mockRejectedValueOnce(new Error("concurrent close read unavailable"));
    vi.spyOn(repository, "claimAlarmClose").mockImplementationOnce(async () => {
      await repository.requestManualClose("fictional-channel", "fictional-poll", closesAt);
      return false;
    });
    const order: string[] = [];
    const { context, close } = createAlarmContext(order);

    await expect(closeChatVoteFromAlarm(context, repository, "fictional-poll"))
      .rejects.toThrow("concurrent close read unavailable");

    await expect(repository.open("fictional-channel")).resolves.toMatchObject({ status: "closing", closeReason: "manual" });
    expect(context.schedule).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("finishes a concurrent manual close after losing its alarm claim", async () => {
    const repository = await seedOpenVote(false);
    const closesAt = new Date(Date.now() - 1_000).toISOString();
    await database.prepare("UPDATE chat_votes SET closes_at = ? WHERE channel_id = ? AND poll_id = ?")
      .bind(closesAt, "fictional-channel", "fictional-poll").run();
    vi.spyOn(repository, "claimAlarmClose").mockImplementationOnce(async () => {
      await repository.requestManualClose("fictional-channel", "fictional-poll", closesAt);
      return false;
    });
    const order: string[] = [];
    const { context, close } = createAlarmContext(order);

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    await expect(repository.byId("fictional-channel", "fictional-poll"))
      .resolves.toMatchObject({ status: "closed", closeReason: "manual", counts: [7, 3] });
    expect(close).toHaveBeenCalledOnce();
    expect(context.schedule).not.toHaveBeenCalled();
  });

  it("rearms the rolled-back deadline after an extension schedule fails during a lost alarm claim", async () => {
    const repository = await seedOpenVote(false);
    const now = Date.now();
    const openedAt = new Date(now - 60_000).toISOString();
    const originalDeadline = new Date(now - 1_000).toISOString();
    await database.prepare("UPDATE chat_votes SET opened_at = ?, closes_at = ?, deadline_revision = 0 WHERE channel_id = ? AND poll_id = ?")
      .bind(openedAt, originalDeadline, "fictional-channel", "fictional-poll").run();
    const failedExtensionSchedule = vi.fn(() => Promise.reject(new Error("extension alarm unavailable")));
    vi.spyOn(repository, "claimAlarmClose").mockImplementationOnce(async () => {
      await requestChatVoteExtension(repository, "fictional-channel", failedExtensionSchedule).catch(() => null);
      return false;
    });
    const order: string[] = [];
    const { context, close } = createAlarmContext(order);

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(failedExtensionSchedule).toHaveBeenCalledTimes(4);
    await expect(repository.byId("fictional-channel", "fictional-poll"))
      .resolves.toMatchObject({ status: "open", closesAt: originalDeadline, deadlineRevision: 2 });
    expect(context.schedule).toHaveBeenCalledWith("fictional-poll", Date.parse(originalDeadline), 2);
    expect(close).not.toHaveBeenCalled();
  });

  it("retries a lost alarm claim when the persisted deadline cannot be rearmed", async () => {
    const repository = await seedOpenVote(false);
    const closesAt = new Date(Date.now() - 1_000).toISOString();
    await database.prepare("UPDATE chat_votes SET closes_at = ? WHERE channel_id = ? AND poll_id = ?")
      .bind(closesAt, "fictional-channel", "fictional-poll").run();
    const claim = vi.spyOn(repository, "claimAlarmClose").mockResolvedValueOnce(false);
    const schedule = vi.fn<ModuleAlarmContext["schedule"]>().mockRejectedValueOnce(new Error("alarm storage unavailable"));
    const order: string[] = [];
    const { context } = createAlarmContext(order, { schedule });

    await expect(closeChatVoteFromAlarm(context, repository, "fictional-poll"))
      .rejects.toThrow("alarm storage unavailable");
    await expect(repository.byId("fictional-channel", "fictional-poll")).resolves.toMatchObject({ status: "open" });

    claim.mockRestore();
    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    await expect(repository.byId("fictional-channel", "fictional-poll"))
      .resolves.toMatchObject({ status: "closed", counts: [7, 3], voterCount: 10 });
  });

  it("includes the persisted deadline revision in overlay bootstrap state", async () => {
    await seedOpenVote(false);
    const closesAt = new Date(Date.now() + 120_000).toISOString();
    await database.prepare("UPDATE chat_votes SET closes_at = ?, deadline_revision = 3 WHERE channel_id = ? AND poll_id = ?")
      .bind(closesAt, "fictional-channel", "fictional-poll").run();
    const element = chatVotingModule.overlayElements?.[0];
    if (element?.initialState === undefined) throw new Error("The chat voting overlay needs an initial state loader.");

    const bootstrap = await element.initialState(database as unknown as D1Database, "fictional-channel", {}, {
      readBallot: vi.fn(() => Promise.resolve(snapshot)),
    } as unknown as ModuleOverlayElementContext);

    expect(bootstrap).toMatchObject({
      pollId: "fictional-poll",
      closesAt,
      deadlineRevision: 3,
    });
  });

  it("closes after scheduling fails once and the manual request is retried", async () => {
    const repository = await seedOpenVote(false);
    const scheduleClose = vi.fn()
      .mockRejectedValueOnce(new Error("alarm unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(requestChatVoteClose(repository, "fictional-channel", scheduleClose))
      .rejects.toThrow("alarm unavailable");
    await expect(repository.open("fictional-channel")).resolves.toMatchObject({
      status: "closing",
      closeReason: "manual",
    });

    await requestChatVoteClose(repository, "fictional-channel", scheduleClose);
    expect(scheduleClose).toHaveBeenCalledTimes(2);

    const order: string[] = [];
    const { context } = createAlarmContext(order);
    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    await expect(repository.byId("fictional-channel", "fictional-poll"))
      .resolves.toMatchObject({ status: "closed", closeReason: "manual", counts: [7, 3] });
  });

  it("persists the observed aggregate before closing and finishes the vote with its snapshot", async () => {
    const repository = await seedOpenVote(false);
    const order: string[] = [];
    const { context, close, read } = createAlarmContext(order);

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(order.indexOf("put")).toBeLessThan(order.indexOf("close"));
    expect(read).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(repository.byId("fictional-channel", "fictional-poll"))
      .resolves.toMatchObject({ status: "closed", counts: [7, 3], voterCount: 10 });
  });

  it("does not close a ballot when a claimed alarm fires before the persisted deadline", async () => {
    const repository = await seedOpenVote(false);
    await database.prepare(
      "UPDATE chat_votes SET closes_at = ? WHERE channel_id = ? AND poll_id = ?",
    ).bind("2099-10-04T14:00:00.000Z", "fictional-channel", "fictional-poll").run();
    const order: string[] = [];
    const { context, close, read } = createAlarmContext(order);

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(read).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await expect(repository.byId("fictional-channel", "fictional-poll")).resolves.toMatchObject({ status: "open" });
  });

  it("recovers the final snapshot when persistence fails after the ballot closes", async () => {
    const repository = await seedOpenVote(false);
    const order: string[] = [];
    const { context, close, values, storagePut } = createAlarmContext(order);
    let putCount = 0;
    storagePut.mockImplementation((key, value) => {
      order.push("put");
      putCount += 1;
      if (putCount === 2) return Promise.reject(new Error("storage interrupted after close"));
      values.set(key, value);
      return Promise.resolve();
    });

    await expect(closeChatVoteFromAlarm(context, repository, "fictional-poll"))
      .rejects.toThrow("storage interrupted after close");
    expect(close).toHaveBeenCalledOnce();
    await expect(repository.byId("fictional-channel", "fictional-poll")).resolves.toMatchObject({ status: "closing" });

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(close).toHaveBeenCalledTimes(2);
    await expect(repository.byId("fictional-channel", "fictional-poll"))
      .resolves.toMatchObject({ status: "closed", counts: [7, 3], voterCount: 10 });
  });

  it("publishes the closed tally before a retryable chat announcement", async () => {
    const repository = await seedOpenVote(true);
    const order: string[] = [];
    let sendCount = 0;
    const { context, publishModuleOverlayMessage, sendChat } = createAlarmContext(order, {
      sendChat: () => {
        sendCount += 1;
        return Promise.resolve(sendCount === 1
          ? { sent: false, reason: "automated_output_limit", retryable: true }
          : { sent: true, reason: null, retryable: false });
      },
    });

    await expect(closeChatVoteFromAlarm(context, repository, "fictional-poll"))
      .rejects.toThrow("waiting for the automated output limit");
    expect(order.indexOf("overlay")).toBeLessThan(order.indexOf("chat"));
    expect(publishModuleOverlayMessage).toHaveBeenCalledOnce();
    const publishedPayload = publishModuleOverlayMessage.mock.calls[0]?.[2];
    expect(publishedPayload).toMatchObject({
      status: "closed",
      requestedDurationSeconds: null,
    });
    expect(typeof publishedPayload?.closesAt).toBe("string");

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(publishModuleOverlayMessage).toHaveBeenCalledTimes(2);
    expect(sendChat).toHaveBeenCalledTimes(2);
    await expect(repository.byId("fictional-channel", "fictional-poll"))
      .resolves.toMatchObject({ status: "closed", counts: [7, 3] });
  });

  it("sends the rendered remainder when a text-block rename crosses alarm awaits", async () => {
    const repository = await seedOpenVote(true, "Dinner", "Result: {text.old}");
    const announcements: string[] = [];
    const order: string[] = [];
    const { context, publishModuleOverlayMessage } = createAlarmContext(order, {
      sendChat: async (text, _idempotencyKey, _attributions, stillValid) => {
        if (stillValid !== undefined && !await stillValid()) {
          return { sent: false, reason: "stale_before_send", retryable: false };
        }
        announcements.push(text);
        return { sent: true, reason: null, retryable: false };
      },
    });
    let overlayRenamed = false;
    publishModuleOverlayMessage.mockImplementation(async () => {
      order.push("overlay");
      if (overlayRenamed) return;
      overlayRenamed = true;
      await database.prepare(
        "UPDATE chat_votes SET result_text = 'Result: {text.middle}' WHERE channel_id = ? AND poll_id = ?",
      ).bind("fictional-channel", "fictional-poll").run();
    });
    let renderCount = 0;
    (context as { renderTemplate: ModuleAlarmContext["renderTemplate"] }).renderTemplate = vi.fn(async (text: string) => {
      renderCount += 1;
      if (renderCount === 1) {
        await database.prepare(
          "UPDATE chat_votes SET result_text = 'Result: {text.new}' WHERE channel_id = ? AND poll_id = ?",
        ).bind("fictional-channel", "fictional-poll").run();
      }
      return { text };
    });

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(context.renderTemplate).toHaveBeenNthCalledWith(
      1,
      "Result: {text.middle}",
      expect.any(Number),
      expect.any(Object),
    );
    expect(context.renderTemplate).toHaveBeenCalledTimes(1);
    expect(announcements).toEqual(["Result: "]);
    expect(announcements.join(" ")).not.toContain("{text.");
    expect(context.writeDiagnostics).toHaveBeenCalledWith(
      "chat-voting:fictional-poll:result",
      [{ code: "template.chat_reference_dropped", detail: { name: "text.middle" } }],
      expect.any(String),
    );
    await expect(repository.byId("fictional-channel", "fictional-poll")).resolves.toMatchObject({
      resultDeliveryPending: false,
    });
  });

  it("publishes a bounded panel hint when a large closed tally exceeds the overlay limit", async () => {
    const repository = await seedOpenVote(false);
    await database.prepare(
      `UPDATE chat_votes
          SET kind = 'free_text', option_count = 0, labels_json = '[]', text_mode = 'whole_message',
              term_filter_ready = 1
        WHERE channel_id = 'fictional-channel' AND poll_id = 'fictional-poll'`,
    ).run();
    const terms = Array.from({ length: 200 }, (_, index) => ({
      term: `answer-${String(index).padStart(18, "0")}`,
      count: 1,
      approved: false,
    }));
    const finalSnapshot = { counts: [], revision: 201, terms, more: 0, termFilterReady: true };
    const order: string[] = [];
    const { context, read, close, publishModuleOverlayMessage } = createAlarmContext(order);
    read.mockResolvedValue(finalSnapshot);
    close.mockResolvedValue(finalSnapshot);
    const overlayOutcomes: string[] = [];
    publishModuleOverlayMessage.mockImplementation(async (type, elementKind, payload) => {
      order.push("overlay");
      const result = await prepareModuleOverlayRealtimeMessage(
        database as unknown as D1Database,
        "fictional-channel",
        "chat_voting",
        { kind: "overlay", type, elementKind, payload },
      );
      overlayOutcomes.push(result.outcome);
    });

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(overlayOutcomes).toEqual(["rejected"]);
  });

  it("includes a vote question in the default result announcement and closed overlay state", async () => {
    const repository = await seedOpenVote(true, "Pizza today?");
    const order: string[] = [];
    const { context, publishModuleOverlayMessage } = createAlarmContext(order);

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(publishModuleOverlayMessage).toHaveBeenCalledWith(
      "tally",
      "chat_voting.tally",
      expect.objectContaining({ title: "Pizza today?", status: "closed" }),
    );
    expect(context.sendChat).toHaveBeenCalledWith(
      "Results for “Pizza today?”: Yes: 7 (70%) · No: 3 (30%)",
      "chat-voting:fictional-poll:result",
      undefined,
      expect.any(Function),
      "source_only",
    );
  });

  it("sends the start announcement once through automated output with a vote-scoped idempotency key", async () => {
    const repository = await seedOpenVote(false, "Pizza today?");
    let attempts = 0;
    const { context } = createAlarmContext([], {
      sendChat: () => {
        attempts += 1;
        return Promise.resolve(attempts === 1
          ? { sent: false, reason: "automated_output_limit", retryable: true }
          : { sent: true, reason: null, retryable: false });
      },
    });
    (context as { renderTemplate: unknown }).renderTemplate = (text: string, _now: number, values: Record<string, string>) =>
      Promise.resolve({ text: text.replaceAll("{vote.title}", values["vote.title"] ?? "").replaceAll("{vote.options}", values["vote.options"] ?? "") });

    await expect(announceChatVoteStartFromAlarm(context, repository, "fictional-poll"))
      .rejects.toThrow("waiting for the automated output limit");
    await announceChatVoteStartFromAlarm(context, repository, "fictional-poll");

    expect(context.sendChat).toHaveBeenCalledTimes(2);
    expect(context.sendChat).toHaveBeenNthCalledWith(
      1,
      "Vote started: Pizza today? – 1 = Yes, 2 = No",
      "chat-voting:fictional-poll:start",
      undefined,
      expect.any(Function),
      "source_only",
    );
  });

  it("sends nothing when the optional start template is empty", async () => {
    const repository = await seedOpenVote(false, null, undefined, "");
    const { context } = createAlarmContext([]);

    await announceChatVoteStartFromAlarm(context, repository, "fictional-poll");

    expect(context.renderTemplate).not.toHaveBeenCalled();
    expect(context.sendChat).not.toHaveBeenCalled();
  });

  it.each([
    ["de", "yes_no", 2, ["Ja", "Nein"], null, null, "1 = Ja, 2 = Nein"],
    ["en", "yes_no", 2, ["Yes", "No"], null, "Lunch?", "1 = Yes, 2 = No"],
    ["de", "scale_5", 5, ["Sehr schlecht", "Schlecht", "Okay", "Gut", "Sehr gut"], null, null, "1 = Sehr schlecht, 2 = Schlecht, 3 = Okay, 4 = Gut, 5 = Sehr gut"],
    ["en", "scale_5", 5, ["Very bad", "Bad", "Okay", "Good", "Great"], null, "Rate this", "1 = Very bad, 2 = Bad, 3 = Okay, 4 = Good, 5 = Great"],
    ["de", "options_n", 3, ["Pizza", "Burger", "Döner"], null, null, "1 = Pizza, 2 = Burger, 3 = Döner"],
    ["en", "options_n", 3, ["Pizza", "Burger", "Kebab"], null, "Dinner?", "1 = Pizza, 2 = Burger, 3 = Kebab"],
    ["en", "digit_01", 2, ["No", "Yes"], null, null, "1 = No, 2 = Yes"],
    ["de", "digit_01", 2, ["Nein", "Ja"], null, "Heute?", "1 = Nein, 2 = Ja"],
    ["de", "digit_12", 2, ["eins", "zwei"], null, null, "1 = eins, 2 = zwei"],
    ["en", "digit_12", 2, ["one", "two"], null, "Pick one", "1 = one, 2 = two"],
    ["de", "free_text", 0, [], "first_word", null, "schreib ein Wort"],
    ["en", "free_text", 0, [], "first_word", "Favorite food?", "type one word"],
    ["en", "free_text", 0, [], "whole_message", null, "type your answer"],
    ["de", "free_text", 0, [], "whole_message", "Was essen wir?", "schreib deine Antwort"],
  ] as const)("renders localized options with the host template renderer (%s, %s, title %s)", async (language, preset, optionCount, labels, textMode, title, options) => {
    await insertChannel(database, "fictional-channel");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, ?)",
    ).bind("fictional-channel", JSON.stringify({ announceResult: false })).run();
    const repository = createChatVotingRepository(database as unknown as D1Database);
    const vote: ChatVoteDraft = {
      id: "fictional-poll",
      channelId: "fictional-channel",
      kind: preset === "free_text" ? "free_text" : preset === "yes_no" ? "yes_no" : "options",
      optionCount,
      labels,
      title,
      ...(textMode === null ? {} : { textMode }),
      ...(preset === "free_text" ? { termFilterReady: true } : {}),
      openedAt: "2026-10-04T10:00:00.000Z",
      closesAt: "2026-10-04T14:00:00.000Z",
      requestedDurationSeconds: null,
      closeReason: "limit",
      status: "open",
    };
    await repository.insertOpen(vote);
    const { context } = createAlarmContext([]);
    const event: ModuleEvent = {
      channelId: "fictional-channel", subscriptionType: "channel.chat.message", triggerId: "start-template", payload: {},
      settings: {}, receivedAt: "2026-10-04T10:00:00.000Z", actor: null, chatStatus: null,
    };
    const variables = [
      ...(chatVotingModule.templateFields?.startText ?? []),
      ...(chatVotingModule.templateFields?.resultText ?? []),
    ];
    const renderer = createTemplateRenderer(event, "event", variables, {
      DB: {} as D1Database,
      channelInfo: () => Promise.resolve(null),
      channelTimeZone: () => Promise.resolve("UTC"),
      channelLocation: () => Promise.resolve(null),
      streamState: () => Promise.resolve("unknown"),
      channelDetails: () => Promise.resolve(null),
      streamDetails: () => Promise.resolve(null),
      channelLanguage: () => Promise.resolve(language),
      readChannelVariables: () => Promise.resolve({}),
      followedAt: () => Promise.resolve(null),
      followerTotal: () => Promise.resolve(null),
      chattersTotal: () => Promise.resolve(null),
      userCreatedAt: () => Promise.resolve(null),
    });
    (context as { channelLanguage: unknown }).channelLanguage = () => Promise.resolve(language);
    (context as { renderTemplate: unknown }).renderTemplate = (text: string, _now: number, values: Record<string, string>) => renderer(text, values);

    await announceChatVoteStartFromAlarm(context, repository, "fictional-poll");

    const titlePart = title === null ? "" : `${title} – `;
    const prefix = language === "de" ? "Abstimmung gestartet: " : "Vote started: ";
    expect(context.sendChat).toHaveBeenCalledWith(
      `${prefix}${titlePart}${options}`,
      "chat-voting:fictional-poll:start",
      undefined,
      expect.any(Function),
      "source_only",
    );
  });

  it("provides the question variable to custom result templates", async () => {
    const repository = await seedOpenVote(true, "Pizza today?", "{vote.title}: {vote.result}");
    const order: string[] = [];
    const { context } = createAlarmContext(order);

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(context.renderTemplate).toHaveBeenCalledWith(
      "{vote.title}: {vote.result}",
      expect.any(Number),
      {
        "vote.result": "Yes: 7 (70%) · No: 3 (30%)",
        "vote.title": "Pizza today?",
        "vote.options": "1 = Yes, 2 = No",
        "vote.duration": "",
      },
    );
  });

  it.each([
    ["a renamed text block", "{text.old_greeting}", "text.old_greeting"],
    ["a deleted text block", "{text.deleted_greeting}", "text.deleted_greeting"],
    ["a renamed channel variable", "{var.old_score}", "var.old_score"],
    ["a deleted channel variable", "{var.deleted_score}", "var.deleted_score"],
    ["a renamed API source", "{api.old_source}", "api.old_source"],
    ["a deleted API source", "{api.deleted_source}", "api.deleted_source"],
  ])("omits %s references from a vote result and records the dropped token", async (_case, token, name) => {
    const repository = await seedOpenVote(true, null, `Result: ${token}`);
    const renderTemplate = vi.fn<ModuleAlarmContext["renderTemplate"]>((text) => Promise.resolve({ text }));
    const { context, sendChat, writeDiagnostics } = createAlarmContext([], { renderTemplate });

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(sendChat).toHaveBeenCalledWith(
      "Result: ",
      "chat-voting:fictional-poll:result",
      undefined,
      expect.any(Function),
      "source_only",
    );
    expect(writeDiagnostics).toHaveBeenCalledWith(
      "chat-voting:fictional-poll:result",
      [{ code: "template.chat_reference_dropped", detail: { name } }],
      expect.any(String),
    );
  });

  it("omits unresolved references from the default result title", async () => {
    const repository = await seedOpenVote(true, "Dinner {text.old_greeting}");
    const { context, sendChat, writeDiagnostics } = createAlarmContext([]);

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    const announcement = sendChat.mock.calls[0]?.[0] ?? "";
    expect(announcement).not.toContain("{text.old_greeting}");
    expect(announcement).toContain("Dinner ");
    expect(writeDiagnostics).toHaveBeenCalledWith(
      "chat-voting:fictional-poll:result",
      [{ code: "template.chat_reference_dropped", detail: { name: "text.old_greeting" } }],
      expect.any(String),
    );
  });

  it("omits unresolved references from a vote start message and records the dropped token", async () => {
    const repository = await seedOpenVote(true, null, undefined, "Start: {text.old_greeting}");
    const renderTemplate = vi.fn<ModuleAlarmContext["renderTemplate"]>((text) => Promise.resolve({ text }));
    const { context, sendChat, writeDiagnostics } = createAlarmContext([], { renderTemplate });

    await announceChatVoteStartFromAlarm(context, repository, "fictional-poll");

    expect(sendChat).toHaveBeenCalledWith(
      "Start: ",
      "chat-voting:fictional-poll:start",
      undefined,
      expect.any(Function),
      "source_only",
    );
    expect(writeDiagnostics).toHaveBeenCalledWith(
      "chat-voting:fictional-poll:start",
      [{ code: "template.chat_reference_dropped", detail: { name: "text.old_greeting" } }],
      expect.any(String),
    );
  });

  it("renders vote.title as the question while the system title stays the stream title", async () => {
    const text = "{title} | {vote.title}: {vote.result} | {vote.options}";
    const repository = await seedOpenVote(true, "Pizza today?", text);
    const { context } = createAlarmContext([]);
    const event: ModuleEvent = {
      channelId: "fictional-channel", subscriptionType: "channel.chat.message", triggerId: "t", payload: {},
      settings: {}, receivedAt: "2026-10-04T14:00:00.000Z", actor: null, chatStatus: null,
    };
    const renderer = createTemplateRenderer(event, "chat_command", chatVotingModule.templateFields?.resultText ?? [], {
      DB: {} as D1Database,
      channelInfo: () => Promise.resolve(null),
      channelTimeZone: () => Promise.resolve("UTC"),
      channelLocation: () => Promise.resolve(null),
      streamState: () => Promise.resolve("unknown"),
      channelDetails: () => Promise.resolve({ title: "Fictional stream title", gameName: "g", gameId: "1" }),
      streamDetails: () => Promise.resolve(null),
      followedAt: () => Promise.resolve(null),
      followerTotal: () => Promise.resolve(null),
      chattersTotal: () => Promise.resolve(null),
      userCreatedAt: () => Promise.resolve(null),
      channelLanguage: () => Promise.resolve("en"),
      readChannelVariables: () => Promise.resolve({}),
    });
    (context as { renderTemplate: unknown }).renderTemplate = (t: string, _now: number, values: Record<string, string>) => renderer(t, values);

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(context.sendChat).toHaveBeenCalledWith(
      "Fictional stream title | Pizza today?: Yes: 7 (70%) · No: 3 (30%) | 1 = Yes, 2 = No",
      "chat-voting:fictional-poll:result",
      undefined,
      expect.any(Function),
      "source_only",
    );
  });
});
