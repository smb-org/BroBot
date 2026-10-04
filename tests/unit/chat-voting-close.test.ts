import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext } from "../../src/modules/contract";
import type { ChatVoteDraft } from "../../src/modules/chat_voting/contracts";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { closeChatVoteFromAlarm } from "../../src/modules/chat_voting/service";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const snapshot = { counts: [7, 3], revision: 4 } as const;

describe("chat voting close service", () => {
  let database: TestD1Database;

  beforeEach(() => { database = new TestD1Database(); });
  afterEach(() => { database.close(); });

  const seedOpenVote = async (announceResult: boolean): Promise<ReturnType<typeof createChatVotingRepository>> => {
    await insertChannel(database, "fictional-channel");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, ?)",
    ).bind("fictional-channel", JSON.stringify({ announceResult })).run();
    const repository = createChatVotingRepository(database as unknown as D1Database);
    const vote: ChatVoteDraft = {
      id: "fictional-poll",
      channelId: "fictional-channel",
      preset: "yes_no",
      optionCount: 2,
      labels: ["Yes", "No"],
      openedAt: "2026-10-04T10:00:00.000Z",
      closesAt: "2026-10-04T14:00:00.000Z",
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
    const publishModuleOverlayMessage = vi.fn(() => { order.push("overlay"); return Promise.resolve(); });
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
    } as unknown as ModuleAlarmContext;
    return { context, values, close, read, publishModuleOverlayMessage, sendChat, storagePut };
  };

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
    expect(publishModuleOverlayMessage).toHaveBeenCalledWith("tally", "chat_voting.tally", expect.objectContaining({ status: "closed" }));

    await closeChatVoteFromAlarm(context, repository, "fictional-poll");

    expect(publishModuleOverlayMessage).toHaveBeenCalledTimes(2);
    expect(sendChat).toHaveBeenCalledTimes(2);
    await expect(repository.byId("fictional-channel", "fictional-poll"))
      .resolves.toMatchObject({ status: "closed", counts: [7, 3] });
  });
});
