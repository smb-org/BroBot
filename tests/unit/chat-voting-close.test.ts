import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleEvent } from "../../src/modules/contract";
import { chatVotingModule } from "../../src/modules/chat_voting";
import { createTemplateRenderer } from "../../src/worker/template-resolver";
import type { ChatVoteDraft } from "../../src/modules/chat_voting/contracts";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { announceChatVoteStartFromAlarm, closeChatVoteFromAlarm, requestChatVoteClose } from "../../src/modules/chat_voting/service";
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
    };
    await repository.insertOpen(vote);
    return repository;
  };

  const createAlarmContext = (
    order: string[],
    overrides: {
      put?: (key: string, value: unknown) => Promise<void>;
      sendChat?: () => Promise<{ sent: boolean; reason: string | null; retryable: boolean }>;
    } = {},
  ) => {
    const values = new Map<string, unknown>();
    const put = overrides.put ?? ((key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    });
    const read = vi.fn(() => { order.push("read"); return Promise.resolve(snapshot); });
    const close = vi.fn(() => { order.push("close"); return Promise.resolve(snapshot); });
    const publishModuleOverlayMessage = vi.fn<ModuleAlarmContext["publishModuleOverlayMessage"]>(
      () => { order.push("overlay"); return Promise.resolve(); },
    );
    const sendChat = vi.fn(overrides.sendChat ?? (() => Promise.resolve({ sent: true, reason: null, retryable: false })));
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
      schedule: vi.fn(),
      clear: vi.fn(),
      renderTemplate: vi.fn(() => Promise.resolve({ text: "Yes: 7 (70%) · No: 3 (30%)" })),
      publishModuleOverlayMessage,
      sendChat: vi.fn((...args: Parameters<ModuleAlarmContext["sendChat"]>) => {
        void args;
        order.push("chat");
        return sendChat();
      }),
      chatActivityCount: vi.fn(() => Promise.resolve(0)),
      resolveEventTimes: vi.fn(() => Promise.resolve([])),
      streamState: vi.fn(() => Promise.resolve("unknown" as const)),
      streamStartedAt: vi.fn(() => Promise.resolve({ streamId: null, startedAt: null })),
      channelLanguage: vi.fn(() => Promise.resolve("en" as const)),
    } as unknown as ModuleAlarmContext;
    return { context, values, close, read, publishModuleOverlayMessage, sendChat, storagePut };
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
      expect(revision).toBe(1);
    }
    await expect(repository.open("fictional-channel")).resolves.toMatchObject({
      id: "fictional-poll",
      status: "open",
      closeReason: "manual",
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
      status: "open",
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
    await expect(repository.byId("fictional-channel", "fictional-poll")).resolves.toMatchObject({ status: "open" });

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
